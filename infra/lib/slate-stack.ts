import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as crypto from 'crypto';
import { backendCode } from './backend-code';
import { renderContext } from './render-image';

const ROOT = path.resolve(__dirname, '..', '..');

export interface SlateStackProps extends cdk.StackProps {
  /** true 时删除栈会连同数据桶和任务表一起删掉 */
  purge: boolean;
  /** 主模型和备用模型，按顺序使用 */
  models: string[];
  /** public：Harness 会话可以访问公网；vpc：会话在私有子网里，没有公网出口，只能经终端节点访问 AWS 服务 */
  network: 'public' | 'vpc';
  /** 不打进镜像的风格目录（开发中） */
  excludeSkills: string[];
}

export class SlateStack extends cdk.Stack {
  /** 管理端栈要用的共享资源 */
  readonly userPool: cognito.UserPool;
  readonly table: ddb.TableV2;
  readonly minimaxKey: secrets.Secret;
  readonly models: string[];
  readonly dataBucket: s3.Bucket;
  readonly turnFnName: string;
  readonly webUrl: string;

  constructor(scope: Construct, id: string, props: SlateStackProps) {
    super(scope, id, props);
    const keep = props.purge ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // ---------- 存储 ----------
    const data = new s3.Bucket(this, 'Data', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: keep,
      autoDeleteObjects: props.purge,
      cors: [{ allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3000 }],
      lifecycleRules: [
        { id: 'uploads', prefix: 'u/', abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) },
      ],
    });

    const table = new ddb.TableV2(this, 'Tasks', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billing: ddb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',  // 操作日志 3 年后自动过期
      removalPolicy: keep,
      globalSecondaryIndexes: [{
        indexName: 'byUser',
        partitionKey: { name: 'gsi1pk', type: ddb.AttributeType.STRING },
        sortKey: { name: 'gsi1sk', type: ddb.AttributeType.NUMBER },
      }],
    });

    // ---------- 登录 ----------
    const pool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 8, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: keep,
    });
    // 角色：admin 组里的人是管理员，其他都是普通用户。第一个管理员由 ./deploy.sh user add <邮箱> --admin 创建
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', { userPoolId: pool.userPoolId, groupName: 'admin', description: 'Slate administrators', precedence: 0 });
    const client = pool.addClient('Web', {
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ---------- 会话镜像 ----------
    const image = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(ROOT, 'agent'),
      file: 'image/Dockerfile',
      platform: ecrAssets.Platform.LINUX_ARM64,
      // excludeSkills：还在开发中的风格不打进镜像（-c excludeSkills=a,b）
      exclude: ['**/__pycache__', '**/*.pyc', ...props.excludeSkills.map(s => `skills/${s}`)],
    });

    // ---------- Lambda 代码（主栈和管理端栈各打一份，内容相同） ----------
    const code = backendCode();

    // ---------- 网络（vpc 模式：没有 NAT，会话和渲染浏览器都不能访问公网） ----------
    let harnessNetwork: agentcore.CfnHarness.NetworkConfigurationProperty = { networkMode: 'PUBLIC' };
    let browserNetwork: agentcore.CfnBrowserCustom.BrowserNetworkConfigurationProperty = { networkMode: 'PUBLIC' };
    if (props.network === 'vpc') {
      const vpc = new ec2.Vpc(this, 'Vpc', {
        maxAzs: 2, natGateways: 0,
        subnetConfiguration: [{ name: 'agent', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 }],
      });
      const agentSg = new ec2.SecurityGroup(this, 'AgentSg', { vpc, allowAllOutbound: true, description: 'Slate agent sessions and render browsers' });
      const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', { vpc, allowAllOutbound: false, description: 'Slate VPC endpoints' });
      endpointSg.addIngressRule(agentSg, ec2.Port.tcp(443));
      vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });
      const services: [string, string][] = [
        ['BedrockRuntime', 'bedrock-runtime'], ['AgentCore', 'bedrock-agentcore'], ['AgentCoreGateway', 'bedrock-agentcore.gateway'],
        ['Polly', 'polly'], ['Logs', 'logs'], ['EcrApi', 'ecr.api'], ['EcrDkr', 'ecr.dkr'], ['Sts', 'sts'], ['XRay', 'xray'], ['Monitoring', 'monitoring'],
      ];
      for (const [id, svc] of services) {
        vpc.addInterfaceEndpoint(id, {
          service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.${svc}`, 443),
          privateDnsEnabled: true, securityGroups: [endpointSg], subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        });
      }
      const subnets = vpc.isolatedSubnets.map(sn => sn.subnetId);
      harnessNetwork = { networkMode: 'VPC', networkModeConfig: { securityGroups: [agentSg.securityGroupId], subnets } };
      browserNetwork = { networkMode: 'VPC', vpcConfig: { securityGroups: [agentSg.securityGroupId], subnets } };
    }

    // ---------- 渲染浏览器 ----------
    // 自定义浏览器挂一份 Chrome 企业策略：没有 GPU 时用 CPU 软件渲染（SwiftShader）提供 WebGL。
    // 默认的 aws.browser.v1 没有 WebGL，用 three.js 或着色器的风格画不出来
    const browserPolicy = new s3assets.Asset(this, 'RenderBrowserPolicy', { path: path.join(ROOT, 'infra/browser/render-policy.json') });
    const renderBrowser = new agentcore.CfnBrowserCustom(this, 'RenderBrowser', {
      name: `${this.stackName.replace(/[^A-Za-z0-9]/g, '_')}_render`,
      description: 'Slate render browser with software WebGL',
      networkConfiguration: browserNetwork,
      enterprisePolicies: [{ type: 'MANAGED', location: { bucket: browserPolicy.s3BucketName, prefix: browserPolicy.s3ObjectKey } }],
    });

    // ---------- IAM ----------
    const execRole = new iam.Role(this, 'HarnessRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'Slate Harness execution role. The agent sandbox runs with these permissions, so it has no data access.',
    });
    // Agent 角色的权限分成两份托管策略（docs/model-keys-design.md）：
    // - <栈名>-agent-services：调用其他 AWS 服务（渲染浏览器、渲染机、工具网关、配音和 llm Lambda、hook、日志、镜像）；
    // - <栈名>-models：调用模型，单独一份，随时可以换。主 Agent（Harness 用执行角色调用）和 llm Lambda（看图、核对、看视频）共用它。
    // 平台不存模型的 Key，执行角色也读不到任何 Key
    const agentServices = new iam.ManagedPolicy(this, 'AgentServicesPolicy', {
      managedPolicyName: `${this.stackName}-agent-services`,
      description: 'Slate agent: AWS services other than model invocation',
    });
    const modelPolicy = new iam.ManagedPolicy(this, 'ModelPolicy', {
      managedPolicyName: `${this.stackName}-models`,
      description: 'Slate model invocation (Amazon Bedrock). Attached to the agent role and the llm Lambda; swap this one to change model access',
      statements: [new iam.PolicyStatement({ sid: 'InvokeModels', actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: ['*'] })],
    });
    execRole.addManagedPolicy(agentServices);
    execRole.addManagedPolicy(modelPolicy);
    agentServices.addStatements(new iam.PolicyStatement({
      sid: 'RenderBrowsers',
      actions: ['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession', 'bedrock-agentcore:GetBrowserSession',
        'bedrock-agentcore:UpdateBrowserStream', 'bedrock-agentcore:ConnectBrowserAutomationStream'],
      // 只给本栈的渲染浏览器：访问公网网页的 slate-browse 用的是 turn Lambda 临时发的另一个角色（prefetchRole）
      resources: [renderBrowser.attrBrowserArn],
    }));
    agentServices.addStatements(new iam.PolicyStatement({
      sid: 'Runtime',
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        'bedrock-agentcore:GetWorkloadAccessTokenForUserId', 'polly:SynthesizeSpeech',
        'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups', 'logs:PutLogEvents',
        'xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    agentServices.addStatements(new iam.PolicyStatement({
      sid: 'Metrics', actions: ['cloudwatch:PutMetricData'], resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }));
    agentServices.addStatements(new iam.PolicyStatement({  // 拉会话镜像（ecr:GetAuthorizationToken 在 Runtime 里）
      sid: 'Image', actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], resources: [image.repository.repositoryArn],
    }));

    // 每轮签发给会话的数据角色：再加会话策略收窄到 u/<sub>/t/<taskId>/
    const lambdaRole = (id: string) => new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    const apiRole = lambdaRole('ApiFnRole');
    const turnRole = lambdaRole('TurnFnRole');
    const finishRole = lambdaRole('FinishFnRole');
    const eventsRole = lambdaRole('EventsFnRole');
    const taskDataRole = new iam.Role(this, 'TaskDataRole', {
      assumedBy: new iam.CompositePrincipal(new iam.ArnPrincipal(turnRole.roleArn), new iam.ArnPrincipal(finishRole.roleArn)),
      maxSessionDuration: cdk.Duration.hours(1),
      description: 'Slate per-task data role. Assumed each turn with a session policy scoped to one task prefix.',
    });
    taskDataRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [data.arnForObjects('u/*/t/*')] }));
    taskDataRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [data.bucketArn] }));
    for (const r of [turnRole, finishRole]) {
      r.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [taskDataRole.roleArn] }));
    }
    // 开工前抓取参考网站：临时凭证只在那一条命令里使用，15 分钟过期
    const prefetchRole = new iam.Role(this, 'PrefetchRole', {
      assumedBy: new iam.ArnPrincipal(turnRole.roleArn),
      description: 'Slate reference-site prefetch. Public browser access, used only for one command before a turn starts.',
    });
    prefetchRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession', 'bedrock-agentcore:GetBrowserSession',
        'bedrock-agentcore:UpdateBrowserStream', 'bedrock-agentcore:ConnectBrowserAutomationStream'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:aws:browser/aws.browser.v1`],
    }));
    turnRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [prefetchRole.roleArn] }));

    // ---------- Gateway + Web Search ----------
    const gwRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    gwRole.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:InvokeGateway', 'bedrock-agentcore:InvokeWebSearch'], resources: ['*'] }));
    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: `${this.stackName.toLowerCase()}-tools`,
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      roleArn: gwRole.roleArn,
      description: 'Slate agent tools: web search',
    });
    const search = new agentcore.CfnGatewayTarget(this, 'WebSearch', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: 'web-search',
      targetConfiguration: { mcp: { connector: { source: { connectorId: 'web-search' }, configurations: [{ name: 'WebSearch', parameterValues: {} }] } } },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    agentServices.addStatements(new iam.PolicyStatement({ sid: 'Gateway', actions: ['bedrock-agentcore:InvokeGateway'], resources: [gateway.attrGatewayArn] }));

    // ---------- 第三方服务的密钥：模板里只有占位值，真实的值由 deploy.sh 写入 ----------
    const minimaxKey = new secrets.Secret(this, 'MinimaxApiKey', {
      secretName: `${this.stackName}/minimax-api-key`,
      description: 'MiniMax China API key for text-to-speech. Set with ./deploy.sh secret minimax',
      secretStringValue: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
      removalPolicy: keep,
    });

    // ---------- Lambda ----------
    const common = {
      runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64, code,
      logRetention: logs.RetentionDays.ONE_MONTH,
    };
    // 函数名固定，互相引用时用字符串拼 ARN：Harness 的 hook 指向 finish，finish 又要调用 turn 和 Harness，
    // 用 token 引用会形成循环依赖
    const fnName = (s: string) => `${this.stackName}-${s}`;
    const fnArn = (s: string) => `arn:aws:lambda:${this.region}:${this.account}:function:${fnName(s)}`;
    const harnessName = `${this.stackName.replace(/[^A-Za-z0-9]/g, '_')}_agent`;
    const env: Record<string, string> = {
      STACK_NAME: this.stackName,
      TABLE: table.tableName, DATA_BUCKET: data.bucketName, TASK_DATA_ROLE_ARN: taskDataRole.roleArn,
      MODELS: JSON.stringify(props.models), GATEWAY_ARN: gateway.attrGatewayArn, TURN_FN: fnName('turn'), HARNESS_NAME: harnessName,
      PREFETCH_ROLE_ARN: prefetchRole.roleArn,
    };
    const turnFn = new lambda.Function(this, 'TurnFn', { ...common, functionName: fnName('turn'), role: turnRole, handler: 'turn.handler', timeout: cdk.Duration.minutes(15), memorySize: 512, environment: env });
    const finishFn = new lambda.Function(this, 'FinishFn', { ...common, functionName: fnName('finish'), role: finishRole, handler: 'finish.handler', timeout: cdk.Duration.minutes(5), memorySize: 512, environment: env });
    const eventsFn = new lambda.Function(this, 'EventsFn', { ...common, functionName: fnName('events'), role: eventsRole, handler: 'events.handler', timeout: cdk.Duration.seconds(60), memorySize: 1024, environment: env });
    const apiFn = new lambda.Function(this, 'ApiFn', { ...common, functionName: fnName('api'), role: apiRole, handler: 'api.handler', timeout: cdk.Duration.seconds(29), memorySize: 1024, environment: env });
    // 每个请求确认账号还可用（停用、重置密码以后旧令牌立即失效，见 api._still_active）
    apiFn.addEnvironment('USER_POOL_ID', pool.userPoolId);
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [pool.userPoolArn] }));

    // 配音：替会话调用 MiniMax，只有它能读 API Key
    const voiceFn = new lambda.Function(this, 'VoiceFn', { ...common, functionName: fnName('voice'), handler: 'voice.handler',
      timeout: cdk.Duration.seconds(120), memorySize: 256,
      environment: { MINIMAX_SECRET_ARN: minimaxKey.secretArn, TABLE: table.tableName, STACK_NAME: this.stackName } });
    minimaxKey.grantRead(voiceFn);
    table.grantReadWriteData(voiceFn); // 配音按字数记账
    agentServices.addStatements(new iam.PolicyStatement({ sid: 'Voice', actions: ['lambda:InvokeFunction'], resources: [fnArn('voice'), fnArn('llm')] }));

    // 看图、核对文字、看视频：替会话用 IAM 角色调用模型，调用模型的权限和主 Agent 是同一份策略（<栈名>-models）
    const llmFn = new lambda.Function(this, 'LlmFn', { ...common, functionName: fnName('llm'), handler: 'llm.handler',
      timeout: cdk.Duration.seconds(180), memorySize: 512, environment: { TABLE: table.tableName, STACK_NAME: this.stackName, DATA_BUCKET: data.bucketName } });
    table.grantReadWriteData(llmFn); // 看图按 token 记账
    // 看视频（风格创建听旁白）：Pegasus 按调用者的权限读数据桶里的参考视频，只给任务目录下的 input/ref/
    data.grantRead(llmFn, 'u/*/t/*/input/ref/*');
    llmFn.role!.addManagedPolicy(modelPolicy);

    // 计费：每分钟把 Harness 运行日志里的模型用量记进账本（只读我们自己的运行日志组）
    const meterFn = new lambda.Function(this, 'MeterFn', { ...common, functionName: fnName('meter'), handler: 'meter.handler',
      timeout: cdk.Duration.minutes(2), memorySize: 512, environment: env });
    meterFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: ['*'] }));
    meterFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:FilterLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/harness_${harnessName}-*`] }));
    new events.Rule(this, 'MeterSchedule', { schedule: events.Schedule.rate(cdk.Duration.minutes(1)), targets: [new targets.LambdaFunction(meterFn, { retryAttempts: 0 })] });

    for (const f of [apiFn, turnFn, finishFn, eventsFn, meterFn]) table.grantReadWriteData(f);
    data.grantReadWrite(apiFn); // 上传签名、复制上传文件、生成播放链接
    data.grantRead(eventsFn);
    data.grantPut(eventsFn, 'styles/*'); // 风格创建的一版：从生成任务目录复制到 styles/<id>/v<n>/
    data.grantRead(turnFn); data.grantRead(finishFn);
    turnFn.grantInvoke(apiFn);
    finishRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fnArn('turn'), fnArn('finish')] }));
    agentServices.addStatements(new iam.PolicyStatement({ sid: 'Hook', actions: ['lambda:InvokeFunction'], resources: [finishFn.functionArn] })); // Harness 用执行角色调用 hook
    data.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(eventsFn), { prefix: 'u/', suffix: '.json' });

    // ---------- 渲染机（docs/gpu-render-design.md）----------
    // AgentCore Runtime 的 Instance 模式：每个任务一台 GPU 实例（长片每 3 章一台），本机 Chrome 走 EGL 用显卡画，ffmpeg 编码。
    // Harness 自己不能用 Instance 模式，所以单独建一个 Runtime；会话里的 slate-render / slate-qa 调用它，调不通时退回远程浏览器。
    // 机型：-c renderInstanceTypes=a,b（默认 T4 和 A10G 两种最小的）；网络用账号的默认 VPC 的公有子网，安全组不开任何入站。
    const renderBase = this.stackName.replace(/[^A-Za-z0-9]/g, '_');
    const renderTypes: string[] = String(this.node.tryGetContext('renderInstanceTypes') || 'g4dn.xlarge,g5.xlarge').split(',');
    const renderAzs: string[] = String(this.node.tryGetContext('renderAzs') || 'us-east-1a,us-east-1b,us-east-1c,us-east-1d,us-east-1f').split(',');
    // 镜像：x86，部署时由 CodeBuild 构建（构建上下文变了才重新构建，标签就是上下文的指纹）
    const renderRepo = new ecr.Repository(this, 'RenderRepo', { removalPolicy: cdk.RemovalPolicy.DESTROY, emptyOnDelete: true });
    const renderSrc = new s3assets.Asset(this, 'RenderContext', { path: renderContext() });
    const renderBuild = new codebuild.Project(this, 'RenderBuild', {
      description: `${this.stackName} render-machine image (x86)`,
      source: codebuild.Source.s3({ bucket: renderSrc.bucket, path: renderSrc.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.LARGE, privileged: true },
      environmentVariables: { REPO_URI: { value: renderRepo.repositoryUri }, IMAGE_TAG: { value: 'latest' } },
      buildSpec: codebuild.BuildSpec.fromObject({ version: '0.2', phases: {
        pre_build: { commands: ['aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${REPO_URI%%/*}'] },
        build: { commands: ['docker build -t $REPO_URI:$IMAGE_TAG -f render/Dockerfile .', 'docker push $REPO_URI:$IMAGE_TAG'] },
      } }),
      timeout: cdk.Duration.minutes(40),
    });
    renderRepo.grantPullPush(renderBuild);
    renderSrc.grantRead(renderBuild);
    const renderBuildFns = ['build_event', 'build_complete'].map((h, i) => new lambda.Function(this, `RenderBuild${i}Fn`, {
      ...common, functionName: fnName(i ? 'render-build-done' : 'render-build'), handler: `renderbuild.${h}`, timeout: cdk.Duration.seconds(60) }));
    for (const f of renderBuildFns) f.addToRolePolicy(new iam.PolicyStatement({ actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'], resources: [renderBuild.projectArn] }));
    const renderImage = new cdk.CustomResource(this, 'RenderImage', {
      serviceToken: new cr.Provider(this, 'RenderImageProvider', { onEventHandler: renderBuildFns[0], isCompleteHandler: renderBuildFns[1],
        queryInterval: cdk.Duration.seconds(20), totalTimeout: cdk.Duration.minutes(45) }).serviceToken,
      properties: { project: renderBuild.projectName, repo: renderRepo.repositoryUri, tag: renderSrc.assetHash.slice(0, 24) },
    });
    // 网络：默认 VPC 的公有子网（实例自动拿到公网 IP，直接访问 ECR、S3，不需要 NAT）；安全组不开入站
    const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });
    const renderSubnets = defaultVpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC, availabilityZones: renderAzs }).subnetIds;
    const renderSg = new ec2.SecurityGroup(this, 'RenderSg', { vpc: defaultVpc, allowAllOutbound: true, description: `${this.stackName} render machines: no inbound` });
    // 删栈时：容量提供方删掉以后，等渲染机的网卡都释放（实例终止约 10 分钟）再删安全组
    const enisFns = ['enis_event', 'enis_complete'].map((h, i) => new lambda.Function(this, `RenderEnis${i}Fn`, {
      ...common, functionName: fnName(i ? 'render-enis-done' : 'render-enis'), handler: `renderbuild.${h}`, timeout: cdk.Duration.seconds(60) }));
    enisFns[1].addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeNetworkInterfaces'], resources: ['*'] }));
    const renderEnis = new cdk.CustomResource(this, 'RenderEnisReleased', {
      serviceToken: new cr.Provider(this, 'RenderEnisProvider', { onEventHandler: enisFns[0], isCompleteHandler: enisFns[1],
        queryInterval: cdk.Duration.seconds(20), totalTimeout: cdk.Duration.minutes(40) }).serviceToken,
      properties: { securityGroup: renderSg.securityGroupId },
    });
    renderEnis.node.addDependency(renderSg);
    // 角色：AgentCore 代管实例用的、实例自身的（只能写系统日志，没有远程登录工具的权限）、渲染服务用的（只拉镜像、写日志，不碰数据桶）
    const agentcorePrincipal = new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } });
    const renderOperator = new iam.Role(this, 'RenderOperatorRole', { assumedBy: agentcorePrincipal,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('BedrockAgentCoreRuntimeInstancesOperatorRolePolicy')] });
    // 操作角色的托管策略只允许传这个前缀的实例角色；名字最长 64 个字符
    const instName = `AmazonBedrockAgentCoreCapacityProviderDefaultInstanceRole-${crypto.createHash('sha256').update(this.stackName).digest('hex').slice(0, 6)}`;
    const renderInstanceRole = new iam.Role(this, 'RenderInstanceRole', { roleName: instName, assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('BedrockAgentCoreRuntimeInstancesInstanceRolePolicy')] });
    const renderProfile = new iam.CfnInstanceProfile(this, 'RenderInstanceProfile', { instanceProfileName: instName, roles: [renderInstanceRole.roleName] });
    const renderExec = new iam.Role(this, 'RenderExecRole', { assumedBy: agentcorePrincipal });
    renderRepo.grantPull(renderExec);
    renderExec.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`] }));
    renderExec.addToPolicy(new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'cloudwatch:PutMetricData'], resources: ['*'] }));
    // 容量提供方建好后只能改描述：配置变了就换个名字新建一个（名字里带配置的指纹）
    const capHash = crypto.createHash('sha256').update(JSON.stringify([renderTypes, renderAzs])).digest('hex').slice(0, 6);
    const renderCapacity = new agentcore.CfnCapacityProvider(this, 'RenderCapacity', {
      name: `${renderBase}_render_${capHash}`, description: `${this.stackName} render machines (GPU, EGL)`,
      permissionsConfiguration: { capacityProviderOperatorRoleArn: renderOperator.roleArn },
      computeConfiguration: { ec2Configuration: {
        launchTemplateSource: { launchParameters: { operatingSystem: 'LINUX_X86_64', instanceProfileArn: renderProfile.attrArn,
          instanceRequirements: { allowedInstanceTypes: renderTypes } } },
        vpcConfiguration: { subnets: renderSubnets, securityGroups: [renderSg.securityGroupId] },
        lifecycleConfiguration: { idleInstanceTimeout: 600, maxLifetime: 28800 },
        rootVolume: { freeSpaceGiB: 20 },
      } },
    });
    renderCapacity.node.addDependency(renderEnis, renderOperator, renderProfile);
    const renderRuntime = new agentcore.CfnRuntime(this, 'RenderRuntime', {
      agentRuntimeName: `${renderBase}_render`, description: `${this.stackName} render machine`, roleArn: renderExec.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: renderImage.getAttString('ImageUri') } },
      capacityProviderConfiguration: { capacityProviderArn: renderCapacity.attrArn },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 600, maxLifetime: 28800 },
      environmentVariables: { TASK_DATA_ROLE_NAME: taskDataRole.roleName, RENDER_SLOTS: '2', ACCOUNT_ID: this.account, DATA_BUCKET: data.bucketName },
    });
    renderRuntime.node.addDependency(renderExec);
    const renderArns = [renderRuntime.attrAgentRuntimeArn, `${renderRuntime.attrAgentRuntimeArn}/*`];
    // 预热：每轮开工时 turn Lambda 异步调用，先把渲染机开起来
    const renderWarmFn = new lambda.Function(this, 'RenderWarmFn', { ...common, functionName: fnName('render-warm'), handler: 'renderwarm.handler',
      timeout: cdk.Duration.minutes(10), memorySize: 256, environment: { ...env, RENDER_RUNTIME_ARN: renderRuntime.attrAgentRuntimeArn } });
    renderWarmFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: renderArns }));
    renderWarmFn.grantInvoke(turnFn);
    turnFn.addEnvironment('RENDER_WARM_FN', renderWarmFn.functionName);
    // 停机：任务停下来（完成、失败、等确认）时 finish / turn 删除渲染机的容量提供方会话，机器几秒内开始关机
    for (const f of [turnFn, finishFn]) {
      f.addEnvironment('RENDER_CAPACITY_ID', renderCapacity.attrCapacityProviderId);
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:DeleteCapacityProviderSession'],
        resources: [renderCapacity.attrArn, `${renderCapacity.attrArn}/*`] }));
    }
    // 会话里的 slate-render 用 Harness 的执行角色调用渲染机
    agentServices.addStatements(new iam.PolicyStatement({ sid: 'RenderMachine', actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: renderArns }));
    new cdk.CfnOutput(this, 'RenderRuntimeArn', { value: renderRuntime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, 'RenderCapacityProviderId', { value: renderCapacity.attrCapacityProviderId });

    // ---------- Harness（唯一的 Agent） ----------
    const systemPrompt = fs.readFileSync(path.join(ROOT, 'agent', 'prompts', 'system.md'), 'utf-8');
    const harness = new agentcore.CfnHarness(this, 'Harness', {
      harnessName,
      executionRoleArn: execRole.roleArn,
      environment: {
        agentCoreRuntimeEnvironment: {
          networkConfiguration: harnessNetwork,
          lifecycleConfiguration: { idleRuntimeSessionTimeout: 1800, maxLifetime: 28800 },
        },
      },
      environmentArtifact: { containerConfiguration: { containerUri: image.imageUri } },
      // 始终显式设置：CloudFormation 删掉这个属性时不会清除 Harness 上的旧值
      environmentVariables: { SLATE_BROWSER_ID: renderBrowser.attrBrowserId, SLATE_VOICE_FN: fnName('voice'), SLATE_LLM_FN: fnName('llm'),
        SLATE_RENDER_RUNTIME_ARN: renderRuntime.attrAgentRuntimeArn },
      // 提示缓存：通过 additionalModelRequestFields 传顶层 cache_control（Bedrock 上 Claude 的自动缓存）
      model: { bedrockModelConfig: { modelId: props.models[0], maxTokens: 32000,
        additionalParams: props.models[0].includes('anthropic.') ? { additionalModelRequestFields: { cache_control: { type: 'ephemeral' } } } : undefined } },
      systemPrompt: [{ text: systemPrompt }],
      tools: [{ type: 'agentcore_gateway', name: 'search', config: { agentCoreGateway: { gatewayArn: gateway.attrGatewayArn, outboundAuth: { awsIam: {} } } } }],
      allowedTools: ['*'],
      hooks: [{ afterInvocation: { name: 'finish', target: { lambda: { arn: finishFn.functionArn, timeoutSeconds: 30, failureMode: 'allow' } } } }],
      memory: { disabled: {} },
      truncation: { strategy: 'summarization', config: { summarization: { summaryRatio: 0.3, preserveRecentMessages: 40 } } },
      maxIterations: 400,
      timeoutSeconds: 3300,
    });
    harness.node.addDependency(execRole, agentServices, modelPolicy, search);
    // finish 不引用 harness.attrArn（避免循环依赖）：它从 hook 负载里取 harnessArn，按名字前缀校验
    apiFn.addEnvironment('HARNESS_ARN', harness.attrArn);
    turnFn.addEnvironment('HARNESS_ARN', harness.attrArn);
    const harnessResources = [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:harness/${harnessName}-*`,
      `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/harness_${harnessName}-*`];
    for (const r of [turnRole, finishRole]) {
      r.addToPolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntimeCommand', 'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:StopRuntimeSession'],
        resources: [...harnessResources, ...harnessResources.map(a => `${a}/*`)],
      }));
    }
    // meter 超额兜底时停掉正在跑的会话
    meterFn.addEnvironment('HARNESS_ARN', harness.attrArn);
    meterFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:StopRuntimeSession'],
      resources: [...harnessResources, ...harnessResources.map(a => `${a}/*`)] }));

    // ---------- API ----------
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `${this.stackName}-api`,
      // 不用 API Gateway 的执行日志，也就不建 CloudWatch 角色：CDK 默认会把它设成整个账号的 API Gateway 共用设置，覆盖别人的
      cloudWatchRole: false,
      deployOptions: { stageName: 'prod', throttlingRateLimit: 50, throttlingBurstLimit: 100 },
      defaultCorsPreflightOptions: { allowOrigins: apigw.Cors.ALL_ORIGINS, allowHeaders: ['Authorization', 'Content-Type'] },
    });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Auth', { cognitoUserPools: [pool] });
    const proxy = api.root.addResource('api').addResource('{proxy+}');
    proxy.addMethod('ANY', new apigw.LambdaIntegration(apiFn), { authorizer, authorizationType: apigw.AuthorizationType.COGNITO });

    // ---------- 前端 ----------
    const web = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    // 内容安全策略：页面只能连本站接口、Cognito、上传用的数据桶和视频 CDN。3D 预览会在页面里执行 Agent 写的模型代码，
    // 万一代码里混进了恶意写法，也拿不到外面去（后端和会话导出时另有代码检查）。导入映射是唯一的内联脚本，按内容算哈希
    const indexHtml = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf-8');
    const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(indexHtml);
    const scriptHash = importMap ? ` 'sha256-${crypto.createHash('sha256').update(importMap[1]).digest('base64')}'` : '';
    const mediaHost = cdk.Lazy.string({ produce: () => `https://${media.distributionDomainName}` });
    const csp = new cloudfront.ResponseHeadersPolicy(this, 'WebCsp', {
      comment: `${this.stackName} web CSP`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { override: true, contentSecurityPolicy: [
          "default-src 'self'", `script-src 'self' blob:${scriptHash}`, "style-src 'self' 'unsafe-inline'",
          `img-src 'self' data: blob: ${mediaHost}`, `media-src 'self' blob: ${mediaHost}`, "font-src 'self' data:",
          `connect-src 'self' https://cognito-idp.${this.region}.amazonaws.com https://${data.bucketDomainName} https://${data.bucketRegionalDomainName} ${mediaHost}`,
          "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
        ].join('; ') },
        contentTypeOptions: { override: true },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN },
      },
    });
    const dist = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(web), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                         responseHeadersPolicy: csp },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.RestApiOrigin(api),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      comment: 'Slate',
    });
    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      destinationBucket: web, distribution: dist, distributionPaths: ['/*'],
      sources: [
        s3deploy.Source.asset(path.join(ROOT, 'web'), { exclude: ['dev', 'dev/**'] }),
        s3deploy.Source.jsonData('config.json', { apiBase: '/api', region: this.region, userPoolId: pool.userPoolId, clientId: client.userPoolClientId }),
      ],
      memoryLimit: 512,
      // 浏览器每次打开都向服务器确认文件有没有变（没变返回 304，几乎不多花时间），发布后立刻生效
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    // ---------- 视频 CDN：每镜预览、成片播放和下载走 CloudFront，回源数据桶（桶不公开，只给这个分发读）----------
    // 链接是 CloudFront 签名链接（有效期 1～2 小时），只有 api Lambda 能签。签名用的密钥对在部署时由自定义资源生成：
    // 私钥写进 Secrets Manager，公钥交给 CloudFront；重复部署不会换密钥，私钥不出现在模板里
    const mediaKeySecret = new secrets.Secret(this, 'MediaSigningKey', { description: `${this.stackName} media CDN signing key (generated at deploy)` });
    const mediaKeyFn = new lambda.Function(this, 'MediaKeyFn', { ...common, functionName: fnName('media-key'), handler: 'mediakey.handler',
      timeout: cdk.Duration.seconds(60), memorySize: 256 });
    mediaKeySecret.grantRead(mediaKeyFn); mediaKeySecret.grantWrite(mediaKeyFn);
    const mediaKeyPair = new cdk.CustomResource(this, 'MediaKeyPair', {
      serviceToken: new cr.Provider(this, 'MediaKeyProvider', { onEventHandler: mediaKeyFn }).serviceToken,
      properties: { secretArn: mediaKeySecret.secretArn },
    });
    const mediaPublicKey = new cloudfront.PublicKey(this, 'MediaPublicKey', { encodedKey: mediaKeyPair.getAttString('PublicKey'), comment: `${this.stackName} media` });
    const mediaKeyGroup = new cloudfront.KeyGroup(this, 'MediaKeyGroup', { items: [mediaPublicKey] });
    // 下载链接带 dl=<文件名>：在返回给浏览器时加上 Content-Disposition（缓存里还是同一个文件，播放和下载共用）
    const mediaDownloadName = new cloudfront.Function(this, 'MediaDownloadName', {
      runtime: cloudfront.FunctionRuntime.JS_2_0, comment: 'Add Content-Disposition when dl= is present',
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var res = event.response, q = event.request.querystring;
  if (q.dl && q.dl.value) {
    var name;
    try { name = encodeURIComponent(decodeURIComponent(q.dl.value)); } catch (e) { name = 'video.mp4'; }
    res.headers['content-disposition'] = { value: "attachment; filename*=UTF-8''" + name };
  }
  return res;
}`),
    });
    // 片段按内容指纹命名，成片每次合成一个新文件，路径不会被覆盖，可以放心长时间缓存；缓存键不含查询参数，签名不同也共用缓存
    const mediaCache = new cloudfront.CachePolicy(this, 'MediaCache', {
      comment: `${this.stackName} media`, defaultTtl: cdk.Duration.days(7), maxTtl: cdk.Duration.days(365), minTtl: cdk.Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(), headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });
    // 媒体文件只给页面里的 <video>、<img> 用和下载：就算有人把网页冒充图片上传，直接打开也不会执行脚本
    const mediaHeaders = new cloudfront.ResponseHeadersPolicy(this, 'MediaHeaders', {
      comment: `${this.stackName} media headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { override: true, contentSecurityPolicy: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" },
        contentTypeOptions: { override: true },
      },
    });
    const media = new cloudfront.Distribution(this, 'MediaCdn', {
      comment: `${this.stackName} media`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, // 用到亚太的边缘节点（香港、东京、新加坡）
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(data),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: mediaCache, compress: false, trustedKeyGroups: [mediaKeyGroup], responseHeadersPolicy: mediaHeaders,
        functionAssociations: [{ function: mediaDownloadName, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE }],
      },
    });
    apiFn.addEnvironment('MEDIA_DOMAIN', media.distributionDomainName);
    apiFn.addEnvironment('MEDIA_KEY_ID', mediaPublicKey.publicKeyId);
    apiFn.addEnvironment('MEDIA_KEY_SECRET', mediaKeySecret.secretArn);
    mediaKeySecret.grantRead(apiFn);
    new cdk.CfnOutput(this, 'MediaUrl', { value: `https://${media.distributionDomainName}` });

    new cdk.CfnOutput(this, 'Url', { value: `https://${dist.distributionDomainName}` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'HarnessArn', { value: harness.attrArn });
    new cdk.CfnOutput(this, 'DataBucket', { value: data.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'WebBucket', { value: web.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: dist.distributionId });
    new cdk.CfnOutput(this, 'MinimaxSecretArn', { value: minimaxKey.secretArn });
    this.userPool = pool; this.table = table; this.minimaxKey = minimaxKey; this.models = props.models;
    this.dataBucket = data; this.turnFnName = turnFn.functionName; this.webUrl = `https://${dist.distributionDomainName}`;
  }
}
