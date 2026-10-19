import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { SlateStack } from './slate-stack';
import { backendCode } from './backend-code';

const ROOT = path.resolve(__dirname, '..', '..');

export interface AdminStackProps extends cdk.StackProps {
  main: SlateStack;
}

/** 管理端：独立的前端（S3 + CloudFront）、API 入口（API Gateway）和 Lambda，和用户端只共用用户池、任务表和密钥 */
export class AdminStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { userPool, table, minimaxKey, dataBucket } = props.main;
    const mainName = props.main.stackName;

    // 管理端自己的应用客户端：管理端 API 只认它签发的令牌，管理员在用户端登录拿到的令牌调不了管理端
    const client = new cognito.UserPoolClient(this, 'AdminWeb', {
      userPool, authFlows: { userPassword: true, userSrp: true }, preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1), accessTokenValidity: cdk.Duration.hours(1), refreshTokenValidity: cdk.Duration.days(7),
    });

    const fn = new lambda.Function(this, 'AdminFn', {
      functionName: `${mainName}-admin`, runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64,
      code: backendCode(), handler: 'admin.handler', timeout: cdk.Duration.seconds(29), memorySize: 512,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        STACK_NAME: mainName, TABLE: table.tableName, USER_POOL_ID: userPool.userPoolId,
        ADMIN_CLIENT_ID: client.userPoolClientId, MINIMAX_SECRET_ARN: minimaxKey.secretArn, MODELS: JSON.stringify(props.main.models),
        DATA_BUCKET: dataBucket.bucketName, TURN_FN: props.main.turnFnName,
        MODEL_POLICY: `${mainName}-models`,  // 调用模型的托管策略名，"模型与密钥"页显示
      },
    });
    // 只给管理需要的权限：用户和组、任务表（读任务、写配置和操作日志）、MiniMax 配音的 Key。
    // 数据桶只能碰风格创建用的 styles/，以及把参考视频放进生成任务的 input/ref/，所以管理员看不到用户的成片和素材
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminUserGlobalSignOut',
        'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminListGroupsForUser'],
      resources: [userPool.userPoolArn],
    }));
    table.grantReadWriteData(fn);
    dataBucket.grantRead(fn, 'styles/*');
    dataBucket.grantPut(fn, 'styles/*');
    dataBucket.grantPut(fn, 'u/*/t/*/input/ref/*');
    lambda.Function.fromFunctionName(this, 'TurnFn', props.main.turnFnName).grantInvoke(fn); // 开始生成、按意见重新生成
    minimaxKey.grantRead(fn);
    minimaxKey.grantWrite(fn);
    // 模型都用 IAM 角色调用，管理端不管模型的 Key（docs/model-keys-design.md），只管 MiniMax 配音的 Key

    // API：独立的入口，Cognito 授权器验签；Lambda 再检查令牌来自管理端客户端、用户在 admin 组
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `${mainName}-admin-api`,
      cloudWatchRole: false,  // 同主栈：不改账号级的 API Gateway 设置
      deployOptions: { stageName: 'prod', throttlingRateLimit: 20, throttlingBurstLimit: 40 },
    });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Auth', { cognitoUserPools: [userPool] });
    api.root.addResource('api').addResource('{proxy+}')
      .addMethod('ANY', new apigw.LambdaIntegration(fn), { authorizer, authorizationType: apigw.AuthorizationType.COGNITO });

    // 前端：独立的桶和 CloudFront（独立的访问地址）
    const web = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    // 内容安全策略（同用户端）：只运行本站脚本，只连本站接口、Cognito 和数据桶（预览图、视频和上传参考视频用的是 S3 预签名链接）
    const s3Hosts = `https://${dataBucket.bucketDomainName} https://${dataBucket.bucketRegionalDomainName}`;
    const csp = new cloudfront.ResponseHeadersPolicy(this, 'WebCsp', {
      comment: `${mainName} admin CSP`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { override: true, contentSecurityPolicy: [
          "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", `img-src 'self' data: blob: ${s3Hosts}`,
          `media-src 'self' blob: ${s3Hosts}`, "font-src 'self' data:", `connect-src 'self' https://cognito-idp.${this.region}.amazonaws.com ${s3Hosts}`,
          "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
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
          origin: new origins.RestApiOrigin(api), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      comment: 'Slate admin',
    });
    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      destinationBucket: web, distribution: dist, distributionPaths: ['/*'],
      sources: [
        s3deploy.Source.asset(path.join(ROOT, 'admin'), { exclude: ['dev', 'dev/**'] }), // dev/ 是本地调试用的 mock 服务器，不发布
        s3deploy.Source.jsonData('config.json', { apiBase: '/api', region: this.region, userPoolId: userPool.userPoolId, clientId: client.userPoolClientId,
          userSite: props.main.webUrl }),
      ],
      memoryLimit: 256,
      // 浏览器每次打开都向服务器确认文件有没有变（没变返回 304，几乎不多花时间），发布后立刻生效
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    new cdk.CfnOutput(this, 'AdminUrl', { value: `https://${dist.distributionDomainName}` });
    new cdk.CfnOutput(this, 'AdminClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'AdminDistributionId', { value: dist.distributionId });
    new cdk.CfnOutput(this, 'AdminWebBucket', { value: web.bucketName });
  }
}
