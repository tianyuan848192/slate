import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const ROOT = path.resolve(__dirname, '..', '..');
let built: string | undefined;

/** 打包后端代码（新版 boto3、cryptography + 校验用的 Schema + 把关用的平台资料），一次合成只打一次包 */
function build(): string {
  if (built) return built;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-backend-'));
  // CDK 合成时已经把它复制进 cdk.out，进程结束就删掉，免得每次部署都在 /tmp 留一份
  process.on('exit', () => fs.rmSync(out, { recursive: true, force: true }));
  const sh = (cmd: string) => execSync(cmd, { stdio: 'inherit', cwd: ROOT });
  sh(`python3.12 -m pip install --quiet --disable-pip-version-check --target ${out} --platform manylinux2014_aarch64 --platform manylinux_2_28_aarch64 --platform manylinux_2_34_aarch64 --only-binary=:all: --python-version 3.12 boto3 fastjsonschema cryptography`);
  sh(`cp backend/*.py ${out}/ && cp -r backend/lib ${out}/`);
  sh(`mkdir -p ${out}/lib/schemas ${out}/lib/protected && cp agent/image/slate/schemas/*.json ${out}/lib/schemas/`);
  sh(`cp agent/image/slate/printfile.py ${out}/lib/printfile.py`);  // 3D 打印导出：会话和 api Lambda 共用一份
  sh(`(test -f agent/skills/catalog.json && cp agent/skills/catalog.json ${out}/lib/catalog.json) || echo '[]' > ${out}/lib/catalog.json`);
  sh(`cp agent/skills/genres.json ${out}/lib/genres.json`);
  sh(`cp agent/voices.json ${out}/lib/voices.json`);
  // 已下架的旧风格也算平台资料，一起交给外发检查
  sh(`cp -r agent/prompts agent/skills $(ls -d agent/legacy-skills 2>/dev/null) ${out}/lib/protected/`);
  // 示范片源码不参与外发检查，不打进 Lambda
  sh(`find ${out}/lib/protected -type d \\( -name demo -o -name example \\) -prune -exec rm -rf {} + ; find ${out} -name __pycache__ -prune -exec rm -rf {} +`);
  return (built = out);
}

/** 后端 Lambda 代码。CDK 的资产不能跨栈共用，所以每个栈各要一份（指向同一个打包目录，哈希相同） */
export function backendCode(): lambda.Code {
  return lambda.Code.fromAsset(build());
}
