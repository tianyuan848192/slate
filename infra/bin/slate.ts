#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SlateStack } from '../lib/slate-stack';
import { AdminStack } from '../lib/admin-stack';

const app = new cdk.App();
const stackName = app.node.tryGetContext('stackName') || 'Slate';
const main = new SlateStack(app, stackName, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  purge: app.node.tryGetContext('purge') === 'true',
  // 主模型 + 备用模型（遇到内容安全策略误拦时按顺序切换）；只在后台配置，前端不展示
  models: (app.node.tryGetContext('models') || 'global.anthropic.claude-opus-5-5,global.anthropic.claude-opus-4-8,global.openai.gpt-6-astra').split(','),
  // public | vpc：vpc 模式下 Agent 会话没有公网出口（需要约 10 个 VPC 终端节点，按小时计费）
  network: app.node.tryGetContext('network') === 'vpc' ? 'vpc' : 'public',
  excludeSkills: (app.node.tryGetContext('excludeSkills') || '').split(',').filter(Boolean),
  description: 'Slate：讲解片和广告片生成平台',
});
// 管理端：独立的前端、API 入口和 Lambda，依赖主栈的用户池、任务表和密钥
new AdminStack(app, `${stackName}-admin`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  main,
  description: 'Slate 管理端：用户、模型与密钥、操作日志',
});
cdk.Tags.of(app).add('project', 'slate');
