"""把开源的等轴测机械图解 Skill（MIT，来源和版本见 THIRD_PARTY_NOTICES.md）的工具库、参考文档和示例源码更新进 agent/skills/anatomy/。

只复制上游文件、不改内容；Slate 自己写的部分（SKILL.md、slate.mjs、demo/）不动。
用法：python scripts/import_anatomy.py <上游仓库目录>
上游更新后：重新运行本脚本，再用 demo/ 里的示范页跑一遍渲染检查（scripts/import_hyperframes.py 的 check_page）。
"""
import os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, "agent", "skills", "anatomy")
KIT = ["iso-kit.mjs", "lathe.mjs", "tube.mjs", "audit.mjs", "gl.mjs", "gl-shared.mjs", "canvas-painter.mjs", "iso.css"]
REFS = ["craft.md", "kit.md", "webgl.md"]
# 只要几何写法：构建脚本、页面里的动画脚本、模型和样式；生成的 HTML（内联了整个工具库）不要
EXAMPLES = ["dial-indicator", "desk-computer", "arcade-cabinet", "raptor-engine", "ripple-tank"]
KEEP = (".mjs", ".css")


def main():
    src = sys.argv[1]
    for f in KIT:
        shutil.copy(os.path.join(src, "kit", f), os.path.join(DST, "kit", f))
    for f in REFS:
        shutil.copy(os.path.join(src, "references", f), os.path.join(DST, "references", f))
    shutil.copy(os.path.join(src, "LICENSE"), os.path.join(DST, "LICENSE"))
    shutil.copy(os.path.join(src, "LICENSE"), os.path.join(ROOT, "agent", "licenses", "anatomy", "LICENSE"))
    shutil.rmtree(os.path.join(DST, "examples"), ignore_errors=True)
    for ex in EXAMPLES:
        d = os.path.join(src, "examples", ex)
        out = os.path.join(DST, "examples", ex)
        os.makedirs(out)
        for f in sorted(os.listdir(d)):
            if f.endswith(KEEP) or (f.startswith("live") and f.endswith(".js")):
                shutil.copy(os.path.join(d, f), os.path.join(out, f))
    print("updated", DST)


if __name__ == "__main__":
    main()
