# 第三方组件说明（内部文档，不随产品展示）

| 组件 | 来源与版本 | 许可 | 放在哪里 | 改动 |
|---|---|---|---|---|
| 43 个影片风格（风格说明、示范片说明和源码、公共函数库、导演和技法文档） | github.com/lemomo-ai/lemo-opuscar，提交 `227e00adfbbec1ef4b7065a4189c2e1c8be2fef4`（2026-10-12） | MIT | `agent/skills/film-*`、`agent/skills/film-kit/`、`agent/image/film-core/`；许可证原文在 `agent/licenses/film-styles/LICENSE`，镜像里在 `/opt/slate/licenses/` | 改名为 film-*；去掉片尾署名、项目名和链接；去掉配音、配乐、混音工具和渲染产物；导演和技法文档删掉了安装、声音、字幕章节。用 `scripts/import_film_styles.py` 重新生成 |
| HDR 环境贴图、木纹、台灯和茶具模型 | Poly Haven（经上面项目的 assets 发布包） | CC0 | `agent/image/film-core/assets/polyhaven/` | 无 |
| three.js | npm `three@0.170.0` | MIT | `agent/image/vendor/three/`（镜像里 `/opt/slate/node_modules/three/`）；许可证在 `agent/licenses/three/LICENSE` | 去掉了 draco、basis、rhino3dm、ammo 等大体积的 libs |
| 素材库：镜头模板（kit-shots）和动作（kit-motion）、导演手册里的三份打法参考 | github.com/heygen-com/hyperframes，提交 `d9edffa3a4e766cb97e7beb09efb2682b6ace5fc`（2026-10-14） | Apache-2.0 | `agent/skills/kit-shots/`、`agent/skills/kit-motion/`、`agent/skills/core-director/{explainer,ad}-playbook.md`、`motion-rules.md`；许可证原文在 `agent/licenses/kit/LICENSE`，镜像里在 `/opt/slate/licenses/` | 动画全部从 GSAP 改写成 Slate 运行时的时间线（不含任何 GSAP 代码）；改成可挂载的模板和动作函数；示例文字换成中文，字体换成本地字体库；去掉项目名、作者和外部链接；打法参考是对原 Skill 的提炼改写。用 `scripts/import_hyperframes.py` 重新生成，第一批清单在 `scripts/data/kit-selection.json` |
| 机械图解风格（anatomy）的工具库、参考文档和示例源码 | github.com/wheresryan22/anatomy，提交 `e6600ffc4e8e6620eeb45bf49bcdbd5e4b84163f`（2026-10-13） | MIT | `agent/skills/anatomy/kit/`、`references/`、`examples/`；许可证原文在 `agent/skills/anatomy/LICENSE` 和 `agent/licenses/anatomy/LICENSE` | 上游文件原样复制，不改内容；没带发布到画廊、本机 Chrome 截图检查、React 版组件和测试。SKILL.md、`slate.mjs`、`demo/` 是 Slate 写的适配。用 `scripts/import_anatomy.py` 更新 |
| 字体库（76 个家族） | Google Fonts | SIL OFL 1.1 | `agent/image/assets/fonts/lib/`，说明见同目录 `LICENSE.md` | 按字符范围切片，未改字形。用 `scripts/build_film_fonts.py` 重新生成 |

MIT 许可只要求在软件副本中保留版权声明和许可文本，不要求在产品界面署名。Apache-2.0 另外要求改过的文件注明有改动（这一行的"改动"一栏），来源仓库没有 NOTICE 文件。产品界面、Skill 文本和 Agent 生成的内容里都不出现来源项目名，后端外发检查也会拦截这些名字。
