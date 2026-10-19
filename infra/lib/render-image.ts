import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
let staged: string | undefined;

/** 渲染机镜像的构建上下文：agent/image 下的渲染代码和资源、风格库、agent/render，以及第三方组件的许可证原文。
 *  部署时作为资产上传，由 CodeBuild 构建 x86 镜像（GPU 实例都是 x86，部署机可能是 arm64）。一次合成只组装一次 */
export function renderContext(): string {
  if (staged) return staged;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-render-'));
  const skip = (src: string) => !/__pycache__|\.pyc$/.test(src);
  for (const rel of ['image/slate', 'image/runtime', 'image/assets', 'image/film-core', 'image/vendor/three', 'skills', 'legacy-skills', 'voices.json', 'render', 'licenses']) {
    fs.cpSync(path.join(ROOT, 'agent', rel), path.join(out, rel), { recursive: true, filter: skip });
  }
  return (staged = out);
}
