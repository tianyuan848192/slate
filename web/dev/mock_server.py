#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Slate 前端的本地 mock 服务器（只用于本地开发，不要部署）。

- 托管 web/ 目录，按 docs/api.md 实现全部 /api 接口，数据都放在内存里；
- 新建的任务会在几十秒内从 queued 一步步走到 completed：推进步骤、发布分镜、逐个出现镜头片段、最后出现成片版本；
- 支持 awaiting_confirmation（高级模式勾选"生成前确认分镜"）和 failed（描述里带"失败"两个字，渲染到后面的镜头时失败）；
- 资料（docs/references-design.md）：上传接受 purpose（ref 只收 pdf、docx、md、txt、csv、xlsx，不超过 1 MB）；建任务接受 refs；
  第一步是"资料整理"，任务详情返回 request.refs、notes（资料摘要）和 scriptCheck（剧本核对）。
  链接里带 fail 或 404 的当作抓取失败；描述里带"核对"两个字时，剧本核对留下没解决的问题；
- /config.json 返回 "mock": true，前端跳过 Cognito，直接用假 token 登录；
- Credit 计费（docs/credit-design.md 第 9 节）：步骤推进时现编每次模型调用的用量，/me、任务列表、任务详情都带 Credit，
  另有 /tasks/{id}/usage（可加 ?format=csv）和 /usage；--credit-quota 调小月额度可以看 80% / 100% 提示和 402；
- 视频用本机 ffmpeg 现场生成小 MP4（找不到 ffmpeg 时链接留空）；链接模仿 S3 预签名：每次返回的签名都不同，过期后返回 403；
- 3D 图片和素材库（docs/library-3d-design.md 第五节）：上传多一种 purpose "image"；建任务接受 product "model3d"（描述里带"失败"
  时比对修正失败）和视频的 models、refs.items 里的 {"kind": "library"}；/tasks/{id}/module 返回一个用基本几何体拼的 three.js 模块，
  多角度图和对比图是现画的 SVG，GLB 是一个最小的方盒；/library 的 GET、PATCH、DELETE，
  预置三个 3D 任务和三个素材库文件。3D 图片只出图片和文件，没有视频（转台视频已去掉）；
- 拆解和 3D 打印（docs/library-3d-design.md 第六节）：建 3D 任务接受 "explode"；做拆解时模型代码多出内部零件和
  sculptRuntime.explode（3 步），素材卡带 explode.steps，版本带 explode（带标注的拆解图 SVG、现编的 GIF 动图）；
  每个新版本 printable 为 true（预置的闹钟第 1 版是 false，用来看按钮隐藏）；POST /tasks/{id}/print 停 2.5 秒后返回
  一个能下载的 3MF（zip）、STL 或 zip 和报告，机型、高度、热床放不下时 400 并给中文说明；
- 生成的风格（docs/style-creator-design.md 第十一节）：/skills 在内置风格后面多两个 generated 的风格，一个内测（beta，
  mock 里的用户都当作管理员）、一个已公开，带 uses 和 thumb（现签的缩略图链接），建任务时和内置风格一样能选。

用法：
    python3 web/dev/mock_server.py --port 8765
常用参数：--speed 2（推进速度加倍）  --no-seed（不预置示例任务）  --latency 0.1（接口延迟秒数）
          --credit-quota 20（每月 Credit 额度，默认 1000）  --credit-used 900（本月已用额外加上这么多）

开发辅助接口（只在 mock 里有）：
    POST /__dev/reset          清空所有内存数据（下次访问时重新预置示例任务）
    POST /__dev/expire-tokens  让已经签发的假 token 全部过期（用来测 401 → 刷新 → 重试）
"""

import argparse
import atexit
import hashlib
import json
import math
import mimetypes
import os
import random
import re
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

WEB_ROOT = Path(__file__).resolve().parent.parent
ARGS = None
LOCK = threading.RLock()
STATE = {"users": {}, "tasks": {}, "uploads": {}, "library": {}, "flows": {}, "revoked_before": 0}
MEDIA = {}            # 文件名 -> 生成参数
BLOBS = {}            # 文件名 -> {ctype, data, download}：上传的照片和参考资料、现画的多角度图和对比图、GLB
MEDIA_LOCKS = {}
MEDIA_DIR = None
FFMPEG = shutil.which("ffmpeg")
FAKE_NOW = None       # 预置示例任务时用的"假时间"，让步骤时间看起来是过去发生的

RATIOS = ("16:9", "9:16", "1:1", "4:5")
DURATIONS = (15, 30, 60, 90, 180)
RUNNING_LIMIT = 3
DAILY_LIMIT = 30

STEP_DEFS = [
    ("research", "资料整理"), ("analyze", "分析需求"), ("script", "写剧本"), ("storyboard", "写分镜"),
    ("code", "写动画代码"), ("render", "渲染画面"), ("compose", "合成配音和字幕"),
]
# 改版前的老任务：步骤的顺序和名字照旧（前端按返回的顺序显示，不写死）
LEGACY_STEP_DEFS = [
    ("analyze", "分析需求"), ("research", "联网搜索"), ("script", "写讲解稿"), ("storyboard", "写分镜"),
    ("code", "写动画代码"), ("render", "渲染画面"), ("compose", "合成配音和字幕"),
]

# 参考资料的限制（和设计文档一致）
REF_EXT = ("pdf", "docx", "md", "txt", "csv", "xlsx")
REF_MAX_BYTES = 1024 * 1024
REF_MAX_CHARS = 20000
REF_MAX_LINKS = 5
REF_MAX = 10
NOTE_MAX = 200

# 3D 图片和素材库的限制（和设计文档一致）
MODEL_STEP_DEFS = [("analyze", "看图分析"), ("spec", "建模规格"), ("model", "建模"), ("review", "比对修正"), ("export", "导出")]
IMAGE_EXT = ("png", "jpg", "jpeg", "webp")
IMAGE_MAX_BYTES = 10 * 1024 * 1024
MODEL_MAX_IMAGES = 4
VIDEO_MAX_MODELS = 3
LIB_MAX_FILES = 200
LIB_NAME_MAX, LIB_TAG_MAX, LIB_TAGS_MAX = 60, 20, 10
VIEW_ANGLES = (0, 90, 180, 270, 35)
MODEL_FACTORY = "createMockGadgetModel"

# 3D 打印（第六节）：机型来自 Bambu Studio 的机型配置，热床宽、深和最大高度（毫米）
PRINTERS = {"a1mini": ("A1 mini", (180, 180, 180)), "a1": ("A1 · P1 · X1 · P2S", (256, 256, 256)),
            "h2d": ("H2D", (350, 320, 325)), "h2s": ("H2S", (340, 320, 340))}
PRINT_COLORS = (1, 4, 8, 16)
PRINT_MIN_H = 10
PRINT_DELAY = 2.5        # 模仿生成要花的时间（秒），不占着锁
PRINT_THIN_MM = 0.8      # 缩放后比这还细的零件报警告

# 风格目录和线上一致，直接读 agent/skills/catalog.json
SKILLS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "agent", "skills", "catalog.json"), encoding="utf-8"))
# 示例任务里还有已下架的旧风格，名字照常显示
LEGACY_SKILL_NAMES = {"whiteboard": "白板手绘讲解", "iso": "等距架构图", "keynote": "发布会大字",
                      "datastory": "数据叙事", "vertical": "竖屏快剪", "line": "极简线条"}
# 管理员生成的风格（docs/style-creator-design.md 第十一节）：一个内测、一个已公开，分类都是内置目录里没有的。
# mock 里的用户都当作管理员，内测的也返回；内测的故意排在前面，看前端是否把它排到同一分类的后面。
# 缩略图借用内置风格的示范帧（thumbFrom），接口返回时换成现签的链接
GEN_SKILLS = [
    {"id": "film-paper-kepu", "name": "纸面科普", "cat": "插画讲解", "ver": "2",
     "summary": "纯色粉彩纸面上，手绘平涂小物件一拍一个落进来，旁边一行手写注解。适合给大众讲清楚一个知识点。",
     "highlights": ["粉彩纯色底，一屏只讲一件事", "物件按旁白节拍一个个落下", "手写体注解，箭头指到细节"],
     "ratio": None, "uses": ["science", "principle"], "generated": True, "beta": True, "thumbFrom": "film-crayon-book.jpg"},
    {"id": "film-cutout-list", "name": "剪纸清单", "cat": "插画讲解", "ver": "1",
     "summary": "彩色卡纸剪出的大号数字和图标，一条一条翻上来，边缘带一点纸张阴影。适合盘点和清单类内容。",
     "highlights": ["大号数字撑满半屏", "每一条像卡片一样翻进来", "纸边阴影做出层次"],
     "ratio": None, "uses": ["listicle", "promo"], "generated": True, "thumbFrom": "film-paper-popup.jpg"},
]
SKILL_NAMES = {**LEGACY_SKILL_NAMES, **{s["id"]: s["name"] for s in SKILLS + GEN_SKILLS}}
# 写法目录（剧本怎么组织，和风格互相独立）和线上一致，直接读 agent/skills/genres.json
GENRES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "agent", "skills", "genres.json"), encoding="utf-8"))
# 管理员生成的写作方法（docs/skills-two-dimensions.md）：和内置的放在一起，一个公开、一个内测（标 beta，线上只返回给管理员）
GEN_GENRES = [{"id": "write-paper-kepu", "name": "反问拆解", "group": "讲解", "summary": "先抛一个反常识的问题，三段拆开，每段末尾回扣开头的问题。",
               "example": "生活里的冷知识、日常现象背后的原理", "styles": [], "generated": True, "beta": False},
              {"id": "write-hook-ad", "name": "三秒反转", "group": "宣传", "summary": "开场先给一个反差画面，第二镜马上翻转，卖点压在 15 秒以内。",
               "example": "新品短视频、促销预告", "styles": [], "generated": True, "beta": True}]
GENRE_BY_ID = {g["id"]: g for g in GENRES + GEN_GENRES}
GENRE_BY_NAME = {g["name"]: g for g in GENRES}
# 配音音色和线上一致；试听文件在 web/voices/
VOICES = [{"id": v["id"], "name": v["name"], "cat": v["cat"], "desc": v["desc"], "preview": f"voices/{v['id']}.mp3"}
          for v in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "agent", "voices.json"), encoding="utf-8"))]

# 示例任务的分镜（标题、旁白、画面、秒数）
SCENES_RAG = [
    ("开场提问", "你问 AI：公司的报销额度是多少？它答得头头是道，可惜是编的。", "手绘对话气泡，AI 的回答被红笔打叉。", 8),
    ("为什么会编", "大模型只记得训练时见过的东西，你们公司的制度它从没读过。", "脑袋里装着书，公司文件夹被一道红线挡在外面。", 10),
    ("先检索", "先去资料库找到相关段落，再让模型带着它作答。", "问题沿箭头进入知识库，命中的段落被红圈标出。", 12),
    ("怎么找到", "资料先切成小段、变成向量。问题也变成向量，离得近的就是相关的。", "文字块变成坐标点，问题点周围亮起最近的三个点。", 10),
    ("带着资料回答", "模型读着找到的段落回答，还能告诉你出处。", "模型框里出现回答，下面挂着来源角标。", 12),
    ("记住这一句", "微调是让它背书，RAG 是让它开卷考试。", "左右分屏：背书的学生和翻书的学生，大字收尾。", 8),
]
SCENES_AERO = [
    ("钩子", "地铁一进站，世界就吵翻了？", "竖屏特写：拥挤车厢，噪音波形炸开，贴纸大字「吵」。", 4),
    ("一键安静", "按一下 Aero 2，噪音瞬间消失，只剩你喜欢的歌。", "手指轻点耳机，波形被拉平，画面一下子变干净。", 6),
    ("行动号召", "Aero 2，通勤路上的一键安静。现在下单，首发立减 200。", "产品居中慢慢转动，底部贴纸大字和购买按钮。", 5),
]
SCENES_AGENTCORE = [
    ("一个 Agent 要什么", "想让 Agent 真正上线干活，光有模型不够，还要运行环境、记忆和工具。", "中间一个 Agent 图标，四周空着四个插槽。", 8),
    ("Runtime", "Runtime 负责把 Agent 跑起来，每个会话互相隔离，按需扩缩。", "第一个等距模块亮起，里面并排跑着多个会话。", 10),
    ("Memory", "Memory 记住对话和偏好，下次来还认识你。", "第二个模块亮起，数据流从会话流进记忆库。", 10),
    ("Gateway", "Gateway 把现有的 API 变成 Agent 能调用的工具，统一鉴权。", "第三个模块亮起，左侧多个 API 汇入网关。", 10),
    ("Code Interpreter", "Code Interpreter 给 Agent 一个安全的沙箱，可以写代码、跑代码。", "第四个模块亮起，沙箱里滚动着代码行。", 10),
    ("串起来", "四块拼在一起，就是一个能上线的 Agent。", "镜头拉远，四个模块用管线连成一个整体。", 12),
]
SCENES_Q3 = [
    ("开场数字", "第三季度，活跃用户增长了 38%。", "大号数字 +38% 从柱状图顶端弹出。", 8),
    ("原因一：新渠道", "第一个原因：短视频渠道带来了四成新用户。", "渠道占比的环形图，短视频那一块放大。", 12),
    ("原因二：留存", "第二个原因：新手引导改版后，七日留存提高了 9 个点。", "两条留存曲线对比，新曲线明显更高。", 12),
    ("原因三：口碑", "第三个原因：老用户邀请带来的增长翻了一倍。", "邀请关系网逐层展开，节点越来越多。", 10),
    ("风险", "同时也要注意，获客成本在上升。", "成本折线缓慢上扬，用红色标出。", 9),
    ("下季度", "下个季度，我们把重点放在留存上。", "三个原因收成一句话，大字收尾。", 9),
]
SCENES_LATTE = [
    ("秋天到了", "第一口，就是秋天。", "暗场里一杯拿铁被光扫亮，大字「秋」。", 6),
    ("新品", "桂花燕麦拿铁，限时上新。", "一屏一句：桂花、燕麦、拿铁，跟着节拍切换。", 8),
    ("数字", "第二杯半价，只到 10 月底。", "大号数字「半价」占满画面。", 8),
    ("门店", "全国门店都能喝到。", "门店地图点亮，品牌标志收尾。", 8),
]
TEMPLATES = {
    "原理讲解": [
        ("开场提问", "先抛一个问题：{t}，到底是怎么回事？", "大标题出现，一个问号被画出来。"),
        ("为什么重要", "先说清楚，为什么值得花一分钟了解它。", "生活化的场景，痛点被红笔圈出来。"),
        ("核心原理", "核心就一句话：把复杂的过程拆成几个简单的步骤。", "流程图分三步依次画出。"),
        ("关键一步", "其中最关键的一步，决定了最终效果。", "放大第二步，其余变淡。"),
        ("举个例子", "举个例子，你马上就能明白。", "具体例子一步步演示。"),
        ("记住这一句", "最后，记住这一句话。", "大字收尾，留出大片空白。"),
    ],
    "广告宣传": [
        ("钩子", "你是不是也遇到过这种情况？", "开场 3 秒的反差画面，大字幕弹出。"),
        ("痛点", "麻烦、费时，还总出错。", "痛点用贴纸式大字一条条甩出来。"),
        ("卖点", "现在，一下就搞定。", "产品特写，卖点数字放大。"),
        ("行动号召", "现在就试试吧。", "品牌标志和行动按钮收尾。"),
    ],
    "数据故事": [
        ("开场数字", "先看一个数字。", "关键数字从图表顶端弹出。"),
        ("原因一", "第一个原因。", "第一张图表长出来。"),
        ("原因二", "第二个原因。", "第二张图表和上一张对比。"),
        ("原因三", "第三个原因。", "第三张图表，重点用黄色标出。"),
        ("总结", "三个原因，收成一句话。", "三张图收拢成一句大字。"),
    ],
}
TEMPLATES["产品演示"] = TEMPLATES["原理讲解"]

SOURCES_RAG = {
    "queries": ["RAG 检索增强生成 原理", "RAG original paper Lewis 2020", "Bedrock 知识库 向量检索", "RAG 和微调的区别 类比"],
    "sources": [
        {"title": "什么是 RAG？", "url": "https://aws.amazon.com/what-is/retrieval-augmented-generation/", "note": "用来核对基本概念", "used": True},
        {"title": "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", "url": "https://arxiv.org/abs/2005.11401", "note": "原始论文", "used": True},
        {"title": "Amazon Bedrock Knowledge Bases", "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html", "note": "向量检索的做法", "used": True},
        {"title": "RAG 和微调有什么区别", "url": "https://example.com/rag-vs-finetune", "note": "和你给的资料重复", "used": False},
    ],
}

COLORS = ["0x1F3A93", "0x2C7A57", "0x8E3B2E", "0x6B4E00", "0x47506A", "0x16213E", "0x3E6CB8", "0x7A3F8F"]
SIZES = {"16:9": (640, 360), "9:16": (360, 640), "1:1": (480, 480), "4:5": (432, 540)}


# ---------------------------------------------------------------- 小工具

def now():
    return FAKE_NOW if FAKE_NOW is not None else time.time()


def now_ms():
    return int(now() * 1000)


def dur_label(sec):
    sec = int(round(sec))
    if sec <= 90:
        return f"{sec} 秒"
    m, s = divmod(sec, 60)
    return f"{m} 分 {s} 秒" if s else f"{m} 分钟"


def find_font():
    """mock 视频里只画英文和数字，找一个拉丁字体即可"""
    for p in ("/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf",
              "/usr/share/fonts/dejavu/DejaVuSans.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
              "/System/Library/Fonts/Helvetica.ttc"):
        if os.path.exists(p):
            return p
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}", "sans"], capture_output=True, text=True, timeout=5).stdout.strip()
        return out if out and os.path.exists(out) else None
    except Exception:
        return None


FONT = None


class ApiErr(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# ---------------------------------------------------------------- 媒体文件（ffmpeg 现场生成）

def register_clip(task, sid, rev):
    """登记一个镜头片段，返回文件名；真正生成在第一次被请求时进行"""
    sb = task["storyboard"]
    idx = next(i for i, s in enumerate(sb["scenes"]) if s["id"] == sid)
    scene = sb["scenes"][idx]
    w, h = SIZES.get(sb["ratio"], (640, 360))
    name = f"{task['id'][:8]}-s{sid}-r{rev}.mp4"
    MEDIA[name] = {
        "kind": "clip", "w": w, "h": h, "dur": float(scene["duration"]), "color": COLORS[idx % len(COLORS)],
        "title": f"SCENE {idx + 1:02d} / {len(sb['scenes']):02d}",
        "sub": f"mock clip, render {rev}",
        "download": f"{task['title']}_第{idx + 1}镜.mp4",
    }
    return name


def register_final(task, n):
    parts = [task["clips"][s["id"]]["name"] for s in task["storyboard"]["scenes"]]
    name = f"{task['id'][:8]}-v{n}.mp4"
    MEDIA[name] = {"kind": "final", "parts": parts, "download": f"{task['title']}_第{n}版.mp4"}
    return name


def _textfile_path(path):
    return str(path).replace("\\", "/").replace("'", r"\'").replace(":", r"\:")


def _textfile(path, text):
    path.write_text(text, encoding="utf-8")
    return _textfile_path(path)


def ensure_media(name):
    spec = MEDIA.get(name)
    if not spec or not FFMPEG:
        return None
    out = MEDIA_DIR / name
    if out.exists():
        return out
    lock = MEDIA_LOCKS.setdefault(name, threading.Lock())
    with lock:
        if out.exists():
            return out
        tmp = MEDIA_DIR / (name + ".tmp.mp4")
        if spec["kind"] == "clip":
            w, h, d = spec["w"], spec["h"], spec["dur"]
            vf = []
            if FONT:
                ff = _textfile_path(FONT)
                t1 = _textfile(MEDIA_DIR / (name + ".1.txt"), spec["title"])
                t2 = _textfile(MEDIA_DIR / (name + ".2.txt"), spec["sub"])
                t3 = _textfile(MEDIA_DIR / (name + ".3.txt"), "%{pts:hms}")
                vf += [
                    f"drawtext=fontfile='{ff}':textfile='{t1}':fontcolor=white:fontsize=h/11:x=(w-tw)/2:y=h*0.36",
                    f"drawtext=fontfile='{ff}':textfile='{t2}':fontcolor=white@0.8:fontsize=h/24:x=(w-tw)/2:y=h*0.52",
                    f"drawtext=fontfile='{ff}':textfile='{t3}':fontcolor=white@0.6:fontsize=h/28:x=(w-tw)/2:y=h*0.64",
                ]
            vf.append(f"drawbox=x=0:y=ih-8:w=iw*t/{d}:h=8:color=0xF4B400@0.9:t=fill")
            cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                   "-i", f"color=c={spec['color']}:s={w}x{h}:d={d}:r=24", "-vf", ",".join(vf),
                   "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(tmp)]
        else:
            parts = [ensure_media(p) for p in spec["parts"]]
            if not all(parts):
                return None
            lst = MEDIA_DIR / (name + ".txt")
            lst.write_text("".join(f"file '{p}'\n" for p in parts), encoding="utf-8")
            cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                   "-c", "copy", "-movflags", "+faststart", str(tmp)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            print("ffmpeg 失败：", r.stderr[-800:], file=sys.stderr)
            return None
        tmp.rename(out)
    return out


def media_url(base, name, download=False):
    """模仿 S3 预签名链接：每次签名都不同，带签发时间，过期后访问返回 403"""
    if not FFMPEG or not name:
        return None
    q = f"X-Mock-Issued={int(time.time())}&X-Mock-Signature={secrets.token_hex(8)}"
    if download:
        q += "&download=1"
    return f"{base}/media/{name}?{q}"


def put_blob(name, ctype, data, download=None):
    BLOBS[name] = {"ctype": ctype, "data": data, "download": download}
    return name


def blob_url(base, name, download=False):
    """和 media_url 一样模仿预签名链接，指向内存里的文件"""
    if not name:
        return None
    q = f"X-Mock-Issued={int(time.time())}&X-Mock-Signature={secrets.token_hex(8)}"
    if download:
        q += "&download=1"
    return f"{base}/blob/{quote(name)}?{q}"


def gen_skill(base, s):
    """生成风格的目录条目：缩略图放进内存，thumb 是现签的链接（线上是媒体 CDN 的签名链接）"""
    name = f"style-thumb-{s['id']}.jpg"
    if name not in BLOBS:
        put_blob(name, "image/jpeg", (WEB_ROOT / "thumbs" / s["thumbFrom"]).read_bytes())
    return {**{k: v for k, v in s.items() if k != "thumbFrom"}, "thumb": blob_url(base, name)}


# ---------------------------------------------------------------- 3D 图片的产出（假的）：模型代码、多角度图、对比图、GLB

MODEL_JS = r"""import * as THREE from 'three';

const P = __PARAMS__;

/** mock 模型：用基本几何体拼成，可以单独动的零件放进 userData.sculptRuntime.nodes；
    做拆解时多建内部零件，拆解数据放进 userData.sculptRuntime.explode（docs/library-3d-design.md 第六节） */
export function createMockGadgetModel() {
  const root = new THREE.Group();
  root.name = 'mock-gadget';
  const nodes = {};
  const meshes = {};
  const mat = (color, roughness = 0.5, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const node = (id, parent, pos = [0, 0, 0]) => {
    const g = new THREE.Group();
    g.name = id;
    g.position.set(...pos);
    parent.add(g);
    nodes[id] = g;
    return g;
  };
  const mesh = (id, geo, m, parent, pos = [0, 0, 0]) => {
    const x = new THREE.Mesh(geo, m);
    x.name = id;
    x.position.set(...pos);
    parent.add(x);
    meshes[id] = x;
    return x;
  };
  const chrome = mat('#c9cbce', 0.18, 1);
  const handleMat = mat(P.handle, P.handleRough, P.handleMetal);

  if (P.shape === 'radio') {
    const body = node('body', root, [0, 0.4, 0]);
    mesh('body', new THREE.BoxGeometry(0.9, 0.5, 0.3), mat(P.body, 0.55), body);
    mesh('front', new THREE.BoxGeometry(0.84, 0.44, 0.01), mat('#efe7d6', 0.8), body, [0, 0, 0.152]);
    const grille = node('grille', body, [-0.2, -0.02, 0.16]);
    mesh('grille', new THREE.CircleGeometry(0.15, 48), mat('#3a3530', 0.95), grille);
    mesh('grille-ring', new THREE.TorusGeometry(0.15, 0.012, 12, 48), chrome, grille);
    mesh('band', new THREE.BoxGeometry(0.32, 0.1, 0.01), mat('#f6f1e4', 0.6), body, [0.2, 0.1, 0.16]);
    mesh('needle', new THREE.BoxGeometry(0.006, 0.09, 0.012), mat('#c8102e', 0.5), body, [0.16, 0.1, 0.166]);
    for (const [id, x] of [['knob-left', 0.12], ['knob-right', 0.28]]) {
      const k = node(id, body, [x, -0.12, 0.17]);
      mesh(id, new THREE.CylinderGeometry(0.045, 0.05, 0.05, 32), chrome, k).rotation.x = Math.PI / 2;
    }
    const antenna = node('antenna', body, [0.36, 0.25, -0.08]);
    antenna.rotation.z = -0.35;
    mesh('antenna', new THREE.CylinderGeometry(0.006, 0.01, 0.6, 12), chrome, antenna, [0, 0.3, 0]);
    const handle = node('handle', body, [0, 0.25, 0]);
    mesh('handle', new THREE.TorusGeometry(0.2, 0.02, 12, 48, Math.PI), handleMat, handle);
    for (const x of [-0.36, 0.36]) mesh('foot', new THREE.BoxGeometry(0.08, 0.15, 0.24), mat('#2a2a2e', 0.7), root, [x, 0.075, 0]);
    if (P.explode) {
      // 内部零件：机芯电路板和两只电子管，装在机身里，从后面抽出来
      const chassis = node('chassis', body, [0, 0, -0.02]);
      mesh('chassis', new THREE.BoxGeometry(0.74, 0.38, 0.03), mat('#2f6b3a', 0.6), chassis);
      for (const x of [-0.12, 0.12]) mesh('tube', new THREE.CylinderGeometry(0.035, 0.035, 0.14, 20), mat('#d9c9a0', 0.25, 0.3), chassis, [x, 0.04, -0.06]).rotation.x = Math.PI / 2;
    }
  } else {
    const caseNode = node('case', root, [0, 0.62, 0]);
    mesh('case', new THREE.CylinderGeometry(0.5, 0.5, 0.42, 64), mat(P.body, 0.55, 0.05), caseNode).rotation.x = Math.PI / 2;
    mesh('bezel', new THREE.TorusGeometry(0.47, 0.035, 16, 64), chrome, caseNode, [0, 0, 0.21]);
    mesh('dial', new THREE.CircleGeometry(0.45, 64), mat('#f1ece0', 0.8), caseNode, [0, 0, 0.212]);
    const ink = mat('#1d1d1f', 0.6);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      mesh('tick', new THREE.BoxGeometry(0.02, i % 3 ? 0.05 : 0.09, 0.006), ink, caseNode, [Math.sin(a) * 0.37, Math.cos(a) * 0.37, 0.215]).rotation.z = -a;
    }
    const hand = (id, len, w, angle, color = ink) => {
      const h = node(id, caseNode, [0, 0, 0.222]);
      mesh(id, new THREE.BoxGeometry(w, len, 0.008), color, h, [0, len / 2 - 0.04, 0]);
      h.rotation.z = -angle;
    };
    hand('hand-hour', 0.24, 0.035, 2.75);
    hand('hand-minute', 0.36, 0.024, 5.24);
    hand('hand-second', 0.38, 0.01, 0.52, mat('#e8573c', 0.5));
    for (const [id, side] of [['bell-left', 1], ['bell-right', -1]]) {
      mesh('bell-stem', new THREE.CylinderGeometry(0.015, 0.015, 0.14, 10), chrome, caseNode, [side * 0.26, 0.45, 0]);
      const b = node(id, caseNode, [side * 0.28, 0.5, 0]);
      b.rotation.z = -side * 0.5;
      mesh(id, new THREE.SphereGeometry(0.2, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), chrome, b);
    }
    const handle = node('handle', caseNode, [0, 0.5, 0]);
    mesh('handle', new THREE.TorusGeometry(0.2, 0.018, 12, 48, Math.PI), handleMat, handle);
    for (const side of [1, -1]) {
      mesh('leg', new THREE.CylinderGeometry(0.02, 0.025, 0.16, 12), chrome, root, [side * 0.3, 0.12, 0.05]);
      mesh('foot', new THREE.SphereGeometry(0.045, 20, 14), chrome, root, [side * 0.3, 0.045, 0.05]);
    }
    if (P.explode) {
      // 内部零件：后盖和机芯（黄铜齿轮组），装在表壳里
      const back = node('back-cover', caseNode, [0, 0, -0.215]);
      mesh('back-cover', new THREE.CylinderGeometry(0.46, 0.46, 0.02, 64), mat(P.body, 0.5, 0.1), back).rotation.x = Math.PI / 2;
      const brass = mat('#b8892e', 0.35, 0.85);
      const mv = node('movement', caseNode, [0, 0, -0.05]);
      mesh('movement', new THREE.CylinderGeometry(0.3, 0.3, 0.14, 40), brass, mv).rotation.x = Math.PI / 2;
      for (const [x, y, r] of [[0.1, 0.08, 0.12], [-0.12, -0.04, 0.09], [0.04, -0.15, 0.07]]) {
        mesh('gear', new THREE.CylinderGeometry(r, r, 0.03, 18), brass, mv, [x, y, -0.09]).rotation.x = Math.PI / 2;
      }
    }
  }
  const runtime = { nodes, meshes };
  if (P.explode) runtime.explode = { steps: P.explode };
  Object.defineProperty(root.userData, 'sculptRuntime', { value: runtime, enumerable: false, writable: true, configurable: true });
  return root;
}
"""

COLOR_WORDS = [("薄荷绿", "#6A9488"), ("木纹", "#8A5A34"), ("棕", "#7A4A2A"), ("红", "#B83D1B"), ("黑", "#2A2C33"),
               ("白", "#E8E6E1"), ("蓝", "#3E6CB8"), ("黄", "#E2A500"), ("绿", "#4F7A5A"), ("灰", "#8E94A0")]
CHROME = "#C9CBCE"


def color_in(text):
    return next(((k, v) for k, v in COLOR_WORDS if k in text), (None, None))


# 做拆解时的步骤：offset 在零件父节点的坐标系里，单位和模型一致；一个零件只出现在一步里
EXPLODE_STEPS = {
    "clock": [
        {"label": "取下提手", "parts": [{"id": "handle", "offset": [0, 0.34, 0]}]},
        {"label": "拆下两只铃铛", "parts": [{"id": "bell-left", "offset": [0.3, 0.24, 0]}, {"id": "bell-right", "offset": [-0.3, 0.24, 0]}]},
        {"label": "拆下后盖，取出机芯", "parts": [{"id": "back-cover", "offset": [0, 0, -0.42]}, {"id": "movement", "offset": [0, 0, -0.8]}]},
    ],
    "radio": [
        {"label": "取下提手和天线", "parts": [{"id": "handle", "offset": [0, 0.3, 0]}, {"id": "antenna", "offset": [0.22, 0.26, 0]}]},
        {"label": "拔下旋钮，取下喇叭网罩", "parts": [{"id": "knob-left", "offset": [0, 0, 0.26]}, {"id": "knob-right", "offset": [0, 0, 0.34]},
                                              {"id": "grille", "offset": [0, 0, 0.3]}]},
        {"label": "从后面抽出机芯", "parts": [{"id": "chassis", "offset": [0, 0, -0.62]}]},
    ],
}
INNER_PARTS = {  # 只有做拆解时才建的内部零件
    "clock": [("back-cover", "后盖", "拆解时向后取下"), ("movement", "机芯", "内部零件，黄铜齿轮组，拆解时从后面取出")],
    "radio": [("chassis", "机芯电路板", "内部零件，带两只电子管，拆解时从后面抽出")],
}


def model_params(desc, explode=False):
    shape = "radio" if re.search(r"收音机|录音机|音箱|radio", desc, re.I) else "clock"
    body = color_in(desc)[1] or ("#8A5A34" if shape == "radio" else "#6A9488")
    return {"shape": shape, "body": body, "handle": CHROME, "handleMetal": 1, "handleRough": 0.2,
            "explode": EXPLODE_STEPS[shape] if explode else None}


def revise_params(p, text):
    """按修改意见换颜色：说到提手就改提手，否则改机身；说到皮革就换成不反光的材质"""
    p = dict(p)
    c = color_in(text)[1]
    if "提手" in text:
        p["handle"] = c or "#7A4A2A"
        if "皮" in text or c:
            p["handleMetal"], p["handleRough"] = 0, 0.75
    elif c:
        p["body"] = c
    return p


def model_js(p):
    return MODEL_JS.replace("__PARAMS__", json.dumps(p))


def _shade(hex_color, k):
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02X%02X%02X" % tuple(max(0, min(255, int(v * k))) for v in (r, g, b))


def _view_body(p, angle, ref=False):
    """一个角度的示意图（640×480 的 SVG 内容）：机身按角度压扁，看得到正面时画表盘或喇叭"""
    a = math.radians(angle)
    s, c = math.sin(a), math.cos(a)
    body, dark = p["body"], _shade(p["body"], 0.72)
    out = [f'<rect width="640" height="480" fill="{"#E9E2D6" if ref else "#ECEEF1"}"/>',
           '<ellipse cx="320" cy="414" rx="200" ry="18" fill="#000" opacity=".13"/>']
    if p["shape"] == "radio":
        w, h, d = 340.0, 190.0, 115.0
        fw, sw = w * abs(c), d * abs(s)
        x0, top = 320 - (fw + sw) / 2, 395 - h
        fx = x0 + (sw if s > 0 else 0)
        sx = x0 if s > 0 else x0 + fw
        out.append(f'<path d="M{fx + fw / 2 - 80} {top} Q{fx + fw / 2} {top - 90} {fx + fw / 2 + 80} {top}" fill="none" stroke="{p["handle"]}" stroke-width="12"/>')
        out.append(f'<line x1="{fx + fw * .85}" y1="{top}" x2="{fx + fw * .85 + 150 * c}" y2="{top - 190}" stroke="#B9BCC2" stroke-width="5"/>')
        out.append(f'<rect x="{sx}" y="{top}" width="{sw}" height="{h}" fill="{dark}"/>')
        out.append(f'<rect x="{fx}" y="{top}" width="{fw}" height="{h}" rx="{14 * abs(c)}" fill="{body if c >= 0 else dark}"/>')
        if c > 0.08:
            out.append(f'<ellipse cx="{fx + fw * .3}" cy="{top + h * .55}" rx="{58 * c}" ry="58" fill="#3A3530" stroke="{CHROME}" stroke-width="5"/>')
            out.append(f'<rect x="{fx + fw * .55}" y="{top + 30}" width="{fw * .34}" height="38" fill="#F6F1E4"/>')
            for k in (.62, .8):
                out.append(f'<ellipse cx="{fx + fw * k}" cy="{top + h * .74}" rx="{17 * c}" ry="17" fill="{CHROME}"/>')
    else:
        cx, cy, r, d = 320.0, 228.0, 135.0, 115.0
        dx = d * s / 2
        rx = max(r * abs(c), 3)
        near, far = (cx + dx, cx - dx) if c >= 0 else (cx - dx, cx + dx)
        for side in (1, -1):
            out.append(f'<line x1="{cx + side * 82 * c}" y1="{cy + 110}" x2="{cx + side * 82 * c}" y2="{395}" stroke="{CHROME}" stroke-width="7"/>')
            out.append(f'<circle cx="{cx + side * 82 * c}" cy="396" r="13" fill="{CHROME}"/>')
            bx = cx + side * 78 * c
            out.append(f'<path d="M{bx - 55} {cy - r + 10} A55 46 0 0 1 {bx + 55} {cy - r + 10} Z" fill="{CHROME}" stroke="#9EA1A6" stroke-width="2"/>')
        out.append(f'<path d="M{cx - 58} {cy - r - 14} Q{cx} {cy - r - 92} {cx + 58} {cy - r - 14}" fill="none" stroke="{p["handle"]}" stroke-width="10"/>')
        out.append(f'<ellipse cx="{far}" cy="{cy}" rx="{rx}" ry="{r}" fill="{dark}"/>')
        out.append(f'<rect x="{min(near, far)}" y="{cy - r}" width="{abs(near - far)}" height="{2 * r}" fill="{body}"/>')
        if c >= 0:
            out.append(f'<ellipse cx="{near}" cy="{cy}" rx="{rx}" ry="{r}" fill="{CHROME}"/>')
            out.append(f'<ellipse cx="{near}" cy="{cy}" rx="{rx * .9}" ry="{r * .9}" fill="#F1ECE0"/>')
            out.append(f'<line x1="{near}" y1="{cy}" x2="{near + 40 * c}" y2="{cy + 50}" stroke="#1D1D1F" stroke-width="8" stroke-linecap="round"/>')
            out.append(f'<line x1="{near}" y1="{cy}" x2="{near - 70 * c}" y2="{cy - 70}" stroke="#1D1D1F" stroke-width="5" stroke-linecap="round"/>')
        else:
            out.append(f'<ellipse cx="{near}" cy="{cy}" rx="{rx}" ry="{r}" fill="{dark}" stroke="#1A1A1A" stroke-width="3"/>')
    out.append(f'<text x="24" y="42" font-family="sans-serif" font-size="22" fill="#47506A">{"参考照片 · " if ref else ""}{angle}°</text>')
    return "".join(out)


def view_svg(p, angle, ref=False):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">'
            + _view_body(p, angle, ref) + "</svg>").encode("utf-8")


def compare_svg(p, n):
    """对比图：左边参考照片，右边渲染"""
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="480" viewBox="0 0 1280 480">'
            + _view_body(p, 35, True) + f'<g transform="translate(640 0)">{_view_body(p, 35)}</g>'
            + f'<text x="1256" y="42" font-family="sans-serif" font-size="22" fill="#47506A" text-anchor="end">渲染 · 第 {n} 版</text>'
            + '<line x1="640" y1="0" x2="640" y2="480" stroke="#fff" stroke-width="4"/></svg>').encode("utf-8")


def glb_box(color, size):
    """最小的 GLB：一个方盒，尺寸取素材卡的 size"""
    x, y, z = size[0] / 2, size[1], size[2] / 2
    pos = [(-x, 0, -z), (x, 0, -z), (x, y, -z), (-x, y, -z), (-x, 0, z), (x, 0, z), (x, y, z), (-x, y, z)]
    idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]
    binary = struct.pack("<24f", *[v for p in pos for v in p]) + struct.pack("<36H", *idx)
    rgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    doc = {
        "asset": {"version": "2.0", "generator": "Slate mock"}, "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "mock-gadget"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": rgb + [1], "roughnessFactor": 0.6, "metallicFactor": 0}}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 96, "target": 34962},
                        {"buffer": 0, "byteOffset": 96, "byteLength": 72, "target": 34963}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3", "min": [-x, 0, -z], "max": [x, y, z]},
                      {"bufferView": 1, "componentType": 5123, "count": 36, "type": "SCALAR"}],
    }
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(js), b"JSON") + js
            + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


def _hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gif_anim(w, h, palette, frames, delay_cs=14):
    """最小的动图 GIF（循环播放）：每帧是调色板下标的列表。LZW 每 250 个像素插一个清表码，码长固定 9 位（不压缩，但合法）"""
    pal = [_hex_rgb(c) for c in palette] + [(0, 0, 0)] * (256 - len(palette))
    out = bytearray(b"GIF89a" + struct.pack("<HHBBB", w, h, 0xF7, 0, 0))
    out += bytes(c for rgb in pal for c in rgb)
    out += b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"
    for px in frames:
        out += b"\x21\xF9\x04\x04" + struct.pack("<H", delay_cs) + b"\x00\x00"
        out += b"\x2C" + struct.pack("<HHHHB", 0, 0, w, h, 0) + b"\x08"
        codes = []
        for i in range(0, len(px), 250):
            codes.append(256)
            codes.extend(px[i:i + 250])
        codes.append(257)
        data, acc, nbits = bytearray(), 0, 0
        for c in codes:
            acc |= c << nbits
            nbits += 9
            while nbits >= 8:
                data.append(acc & 0xFF)
                acc >>= 8
                nbits -= 8
        if nbits:
            data.append(acc & 0xFF)
        for i in range(0, len(data), 255):
            out += bytes([len(data[i:i + 255])]) + data[i:i + 255]
        out += b"\x00"
    return bytes(out + b"\x3B")


def explode_gif(p):
    """拆解动图：组装好 → 逐步拆开 → 停留 → 合上。三块色块代表机身、顶上的零件和内部零件"""
    w, h = 120, 90
    pal = ["#ECEEF1", p["body"], p["handle"], "#B8892E", "#16213E"]
    seq = [0, 0, .2, .45, .7, .9, 1, 1, 1, .8, .55, .3, .1, 0]
    frames = []
    for k in seq:
        px = [0] * (w * h)

        def rect(x0, y0, x1, y1, ci):
            for y in range(max(0, int(y0)), min(h, int(y1))):
                for x in range(max(0, int(x0)), min(w, int(x1))):
                    px[y * w + x] = ci
        rect(20, 80, 100, 82, 4)                      # 地面线
        rect(36, 34, 84, 78, 1)                       # 机身
        if k > 0:
            rect(44 - 30 * k, 40, 76 - 30 * k, 64, 3)  # 内部零件拉出来（往左）
        rect(46, 24 - 18 * k, 74, 30 - 18 * k, 2)     # 顶上的零件往上拿开
        frames.append(px)
    return gif_anim(w, h, pal, frames)


def explode_svg(p, steps, names):
    """带标注的拆解图（640×480 SVG）：35 度斜侧图，右边按步骤列出拆下来的零件，每个零件一条引线"""
    out = [_view_body(p, 35)]
    parts = [(i + 1, x["id"]) for i, st in enumerate(steps) for x in st["parts"]]
    for k, (n, pid) in enumerate(parts):
        y = 92 + k * (300 / max(1, len(parts) - 1) if len(parts) > 1 else 0)
        ax, ay = 300 + (k % 3) * 24, 150 + (k * 47) % 200
        out.append(f'<polyline points="{ax},{ay} {ax + 60},{y} 452,{y}" fill="none" stroke="#16213E" stroke-width="1.6"/>')
        out.append(f'<circle cx="{ax}" cy="{ay}" r="4" fill="#F4B400" stroke="#16213E" stroke-width="1.6"/>')
        out.append(f'<text x="460" y="{y + 6}" font-family="sans-serif" font-size="17" fill="#16213E">{n}. {names.get(pid, pid)}</text>')
    out.append('<text x="616" y="460" font-family="sans-serif" font-size="15" fill="#687086" text-anchor="end">拆解图 · mock</text>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">' + "".join(out) + "</svg>").encode("utf-8")


def _box(w, d, h, ox=0.0, oy=0.0):
    """方盒的 8 个顶点和 12 个三角形（Z 轴朝上，单位毫米，法线朝外）"""
    v = [(ox + x, oy + y, z) for z in (0, h) for y in (0, d) for x in (0, w)]
    t = [(0, 2, 1), (1, 2, 3), (4, 5, 6), (5, 7, 6), (0, 1, 4), (1, 5, 4), (2, 6, 3), (3, 6, 7), (0, 4, 2), (2, 4, 6), (1, 3, 5), (3, 7, 5)]
    return v, t


def stl_box(w, d, h, name="slate"):
    """二进制 STL：一个方盒"""
    v, tris = _box(w, d, h)
    out = bytearray(name.encode("utf-8")[:80].ljust(80, b" ")) + struct.pack("<I", len(tris))
    for a, b, c in tris:
        out += struct.pack("<3f", 0, 0, 0) + b"".join(struct.pack("<3f", *v[i]) for i in (a, b, c)) + b"\0\0"
    return bytes(out)


def zip_bytes(files):
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(name, data)
    return buf.getvalue()


def make_3mf(objects, colors):
    """最小的 3MF：单位毫米、Z 轴朝上，颜色写成 basematerials；objects = [(名称, 颜色下标, 宽, 深, 高, x, y)]"""
    mats = "".join(f'<base name="颜色 {i + 1}" displaycolor="{c.upper()}FF"/>' for i, c in enumerate(colors))
    objs, items = [], []
    for k, (name, ci, w, d, h, x, y) in enumerate(objects):
        v, t = _box(w, d, h, x, y)
        vs = "".join(f'<vertex x="{a:.3f}" y="{b:.3f}" z="{c:.3f}"/>' for a, b, c in v)
        ts = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in t)
        name = name.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
        objs.append(f'<object id="{k + 2}" name="{name}" type="model" pid="1" pindex="{ci}"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>')
        items.append(f'<item objectid="{k + 2}"/>')
    model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="zh-CN" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">Slate mock</metadata>'
             f'<resources><basematerials id="1">{mats}</basematerials>{"".join(objs)}</resources><build>{"".join(items)}</build></model>')
    return zip_bytes([
        ("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                                '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
        ("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
        ("3D/3dmodel.model", model),
    ])


# ---------------------------------------------------------------- 任务状态

def new_steps(legacy=False, model3d=False):
    defs = MODEL_STEP_DEFS if model3d else LEGACY_STEP_DEFS if legacy else STEP_DEFS
    return [{"name": n, "label": l, "state": "pending", "note": "", "startedAt": 0, "endedAt": 0} for n, l in defs]


def get_step(t, name):
    return next(s for s in t["steps"] if s["name"] == name)


def step(t, name, state, note=None):
    s = get_step(t, name)
    s["state"] = state
    if note is not None:
        s["note"] = note
    if state == "running":
        s["startedAt"], s["endedAt"] = now_ms(), 0
    elif state in ("done", "skipped", "failed"):
        s["endedAt"] = now_ms()
        if not s["startedAt"]:
            s["startedAt"] = s["endedAt"]
        if state != "skipped":
            bill_step(t, name, state)
    elif state == "pending":
        s["startedAt"] = s["endedAt"] = 0
    t["updatedAt"] = now_ms()


def set_status(t, status, text=None):
    active = status in ("queued", "running")
    if active and t["run_since"] is None:
        t["run_since"] = now()
    if not active and t["run_since"] is not None:
        t["elapsed_base"] += now() - t["run_since"]
        t["run_since"] = None
    t["status"] = status
    if text is not None:
        t["statusText"] = text
    t["updatedAt"] = now_ms()


def set_text(t, text):
    t["statusText"] = text
    t["updatedAt"] = now_ms()


def elapsed(t):
    e = t["elapsed_base"]
    if t["run_since"] is not None:
        e += now() - t["run_since"]
    return int(e)


def say(t, role, kind, text, scope=None, node=None):
    m = {"id": "m-" + uuid.uuid4().hex[:12], "role": role, "kind": kind, "text": text, "at": now_ms()}
    if scope is not None:
        m["scope"] = scope
    if node is None and t["request"].get("flow") and t["product"] == "video":  # 工作流：消息记在这一轮所属的节点下
        node = t.get("flowNode", "text")
    if node:
        m["node"] = node
    t["messages"].append(m)
    t["updatedAt"] = now_ms()


class Turn:
    """一轮 Agent 工作：一串按时间推进的动作"""

    def __init__(self):
        self.t0 = self.t = time.time()
        self.actions = []

    def after(self, sec, fn):
        self.t += sec / ARGS.speed
        self.actions.append((self.t, fn))
        return self


def start_turn(t, turn):
    t["timeline"] = list(turn.actions)


def run_instant(t, turn, base):
    """预置示例任务：把一轮动作立刻执行完，时间戳按 base 往后推"""
    global FAKE_NOW
    for at, fn in turn.actions:
        FAKE_NOW = base + (at - turn.t0) * ARGS.speed * 6  # 拉长一些，看起来更像真实耗时
        fn(t)
    end = FAKE_NOW
    FAKE_NOW = None
    return end


def ticker():
    while True:
        time.sleep(0.2)
        with LOCK:
            cur = time.time()
            for t in list(STATE["tasks"].values()):
                tl = t["timeline"]
                while tl and tl[0][0] <= cur:
                    _, fn = tl.pop(0)
                    try:
                        fn(t)
                    except Exception:
                        traceback.print_exc()


# ---------------------------------------------------------------- Agent 的"决定"（假的）

def guess_kind(desc):
    """用户没选写法时，假装 Agent 按描述判断写法（返回写法的中文名）"""
    if re.search(r"促销|满减|优惠|半价|限时", desc):
        return "促销活动"
    if re.search(r"广告|宣传|新品|下单|信息流|发布", desc):
        return "新品发布"
    if re.search(r"数据|季度|增长|复盘|报告", desc):
        return "数据故事"
    if re.search(r"演示|上手|走查|功能介绍", desc):
        return "产品介绍"
    return "原理讲解"


def is_promo(kind):
    """宣传类写法（老任务里的"广告宣传"也算）"""
    return kind == "广告宣传" or (GENRE_BY_NAME.get(kind) or {}).get("group") == "宣传"


def guess_duration(desc, kind):
    m = re.search(r"(\d+)\s*秒", desc)
    if m:
        v = int(m.group(1))
        return min(DURATIONS, key=lambda d: abs(d - v))
    if re.search(r"(一|1)\s*分钟", desc):
        return 60
    if re.search(r"(三|3)\s*分钟", desc):
        return 180
    if re.search(r"(一分半|90)", desc):
        return 90
    return 30 if is_promo(kind) else 60


def guess_title(desc):
    for kw, title in (("RAG", "RAG 是怎么工作的"), ("Aero", "Aero 2：一键安静"), ("AgentCore", "AgentCore 是什么"),
                      ("季度", "第三季度用户增长"), ("拿铁", "秋季拿铁新品")):
        if kw in desc:
            return title
    first = re.split(r"[，。：！？,.:\n]", desc.strip())[0]
    return first[:16] + ("…" if len(first) > 16 else "") or "新视频"


def guess_audience(desc, kind):
    m = re.search(r"(?:给|面向|讲给)([^，。,：:]{2,24}?)(?:讲|看|听|的|，|。)", desc)
    if m:
        return m.group(1).strip()
    if is_promo(kind):
        return "目标消费者"
    return {"数据故事": "公司内部同事"}.get(kind, "普通观众")


def default_skill(kind, ratio):
    """没选风格时用写法的第一个常搭配风格"""
    g = GENRE_BY_NAME.get(kind)
    return g["styles"][0] if g and g.get("styles") else "editorial"


def make_brief(t):
    req = t["request"]
    desc = req["description"]
    opts = req.get("options") or {}
    adv = req["mode"] == "advanced"
    spec = opts.get("spec") if adv and (opts.get("spec") or {}).get("enabled") else None
    sk = opts.get("skills") if adv and (opts.get("skills") or {}).get("enabled") else None
    g = GENRE_BY_ID.get(req.get("genre") or "")
    kind = g["name"] if g else guess_kind(desc)
    decided = ["audience"] if g else ["kind", "audience"]  # 用户指定了写法：不算 Agent 决定的
    if spec:
        ratio, duration, res, fps = spec["ratio"], spec["duration"], spec["resolution"], spec["fps"]
        voice = "温和女声（Zhiyu）" if spec.get("voice", True) else ""
        subtitles = bool(spec.get("subtitles", True))
        bgm = ("upbeat" if is_promo(kind) else "calm") if spec.get("bgm") else None
    else:
        ratio = "9:16" if "竖屏" in desc else ("1:1" if "方形" in desc else "16:9")
        duration, res, fps = guess_duration(desc, kind), "1080p", 30
        voice, subtitles = "温和女声（Zhiyu）", True
        bgm = "upbeat" if is_promo(kind) else "calm"
        decided += ["ratio", "duration", "resolution", "fps", "voice", "subtitles", "bgm"]
    if sk:
        ids = list(sk["ids"])
    else:
        ids = [default_skill(kind, ratio)]
        decided.append("skills")
    return {
        "title": t["title"], "kind": kind, "audience": guess_audience(desc, kind),
        "ratio": ratio, "duration": duration, "resolution": res, "fps": fps,
        "skills": [{"id": i, "name": SKILL_NAMES.get(i, i)} for i in ids],
        "voice": voice, "subtitles": subtitles, "bgm": bgm, "decided": decided,
    }


def make_storyboard(t, brief):
    desc = t["request"]["description"]
    fixed = None
    for kw, sc in (("RAG", SCENES_RAG), ("Aero", SCENES_AERO), ("AgentCore", SCENES_AGENTCORE),
                   ("季度", SCENES_Q3), ("拿铁", SCENES_LATTE)):
        if kw in desc:
            fixed = sc
            break
    total = brief["duration"]
    if fixed:
        rows = [(a, b, c) for a, b, c, _ in fixed]
        weights = [d for *_, d in fixed]
    else:
        tpl = TEMPLATES["广告宣传"] if is_promo(brief["kind"]) else TEMPLATES.get(brief["kind"], TEMPLATES["原理讲解"])
        k = {15: 3, 30: 4}.get(total, len(tpl))
        rows = [(a, b.replace("{t}", t["title"]), c) for a, b, c in tpl[:k]]
        weights = [1] * len(rows)
    # 按总时长分配每镜秒数
    s = sum(weights)
    durs = [max(2, round(total * w / s)) for w in weights]
    durs[-1] = max(2, total - sum(durs[:-1]))
    scenes = [{"id": f"{i + 1:02d}", "title": a, "narration": b, "visual": c, "duration": d}
              for i, ((a, b, c), d) in enumerate(zip(rows, durs))]
    for i, im in enumerate(t["request"].get("images") or []):  # 用户的图片：按顺序分到各镜（线上由 Agent 按描述安排）
        scenes[min(len(scenes) - 1, i + 1)].setdefault("images", []).append(im["id"])
    return {"title": t["title"], "ratio": brief["ratio"], "resolution": brief["resolution"], "fps": brief["fps"],
            "bgm": brief["bgm"], "scenes": scenes}


def make_sources(t):
    if "RAG" in t["request"]["description"]:
        return json.loads(json.dumps(SOURCES_RAG))
    topic = t["title"].rstrip("…")
    return {
        "queries": [f"{topic} 是什么", f"{topic} 案例", f"{topic} 最新数据"],
        "sources": [
            {"title": f"{topic} - 维基百科", "url": "https://zh.wikipedia.org/wiki/" + quote(topic), "note": "用来核对基本概念", "used": True},
            {"title": f"{topic}：一份入门指南", "url": "https://example.com/guide", "note": "举例参考", "used": True},
            {"title": f"关于{topic}的旧新闻", "url": "https://example.com/old-news", "note": "信息过时", "used": False},
        ],
    }


# 资料摘要（notes）的示例：按描述里的关键词挑一套，挑不到就按资料类型现编
NOTES_AGENTCORE = {
    "angle": "资料把 AgentCore 讲成四块积木：Runtime 管运行，Memory 管记忆，Gateway 管工具，Code Interpreter 管沙箱。片子按这四块依次展开，最后串起来。",
    "file": {"summary": "官方白皮书。第三节讲了四个组件各自管什么、怎么计费。",
             "facts": ["Runtime 给每个会话单独分配隔离的运行环境，一个会话最长 8 小时",
                       "Memory 分短期记忆和长期记忆两层",
                       "Gateway 能把现有的 REST API 和 Lambda 函数变成 Agent 能调用的工具"],
             "terms": [{"term": "会话隔离", "meaning": "每个会话跑在独立的 microVM 里，互相看不到数据"},
                       {"term": "MCP", "meaning": "Model Context Protocol，Agent 调用工具的统一协议"}]},
    "text": {"summary": "团队内部的用词约定：统一说「Agent」，不说「智能体」；说「工具」，不说「插件」。",
             "facts": [],
             "terms": [{"term": "Agent", "meaning": "统一用英文，不翻译成智能体"},
                       {"term": "工具", "meaning": "Agent 能调用的外部能力，不叫插件"}]},
    "link": {"summary": "发布博客，用一个客服 Agent 的例子演示四个组件怎么串起来。",
             "facts": ["示例里的客服 Agent 通过 Gateway 调用订单查询接口"], "terms": []},
}
NOTES_RAG = {
    "angle": "资料的重点是「先查再答」：公司制度只在知识库里，模型自己不知道。片子用报销额度这个例子贯穿全片。",
    "file": {"summary": "知识库的说明文档，讲了制度文件怎么切段、怎么建索引，报销制度那一节有具体额度。",
             "facts": ["制度文件按 500 字左右切成一段", "差旅报销的住宿标准是一线城市每晚 600 元"],
             "terms": [{"term": "切段", "meaning": "把长文档切成小段，方便检索"}]},
    "text": {"summary": "员工最常问的十个问题，第一个就是报销额度。",
             "facts": ["报销额度是员工问得最多的问题"], "terms": []},
    "link": {"summary": "一篇科普文章，用开卷考试比喻 RAG。",
             "facts": ["RAG 像开卷考试，微调像考前背书"], "terms": [{"term": "RAG", "meaning": "检索增强生成：先检索资料，再带着资料生成回答"}]},
}


def has_refs(t):
    return bool((t["request"].get("refs") or {}).get("items"))


def make_notes(t):
    desc = t["request"]["description"]
    canned = NOTES_AGENTCORE if "AgentCore" in desc else NOTES_RAG if "RAG" in desc else None
    topic = t["title"].rstrip("…")
    items, links = [], 0
    for r in t["request"]["refs"]["items"]:
        name = r.get("name") or r.get("title") or r.get("url")
        if r.get("error"):
            items.append({"id": r["id"], "summary": "链接没有抓到正文。", "used": False, "facts": [], "terms": [],
                          "reason": "网页打不开，没有可用的内容"})
            continue
        kind = "file" if r["kind"] == "library" else r["kind"]  # 素材库里的文件和上传的文件一样整理
        if kind == "link":
            links += 1
            if links > 1:
                items.append({"id": r["id"], "summary": "一篇转载文章，内容和前面的资料基本一样。", "used": False,
                              "facts": [], "terms": [], "reason": "和前面的资料重复，没有新信息"})
                continue
        if canned:
            x = canned[kind]
        elif kind == "file":
            x = {"summary": f"{name}：讲了{topic}的背景、关键数字和三个主要结论。",
                 "facts": [f"{topic}的核心可以拆成三个步骤", "资料第三节给出了对比数据：效率提升 37%"],
                 "terms": [{"term": "关键指标", "meaning": "资料里用来衡量效果的数字"}]}
        elif kind == "text":
            x = {"summary": f"「{name}」：写稿时要照着用的说法和术语。", "facts": [],
                 "terms": [{"term": topic[:8] or "主题", "meaning": "按资料里的定义来讲，不要自己发挥"}]}
        else:
            x = {"summary": f"这篇网页从使用者的角度讲了{topic}，举了两个实际例子。", "facts": ["网页里的第一个例子适合放在开场"], "terms": []}
        items.append({"id": r["id"], "summary": x["summary"], "used": True, "facts": list(x["facts"]),
                      "terms": [dict(y) for y in x["terms"]], "reason": ""})
    angle = canned["angle"] if canned else f"资料主要讲{topic}的来龙去脉，片子以资料里的几个关键数字为骨架。"
    return {"angle": angle, "items": items}


def make_check(t):
    """剧本核对的示例：有资料或开了联网才核对；描述里带"核对"（或示例任务指定）时留下没解决的问题"""
    if t.get("legacy"):
        return None
    refs = t["request"].get("refs") or {}
    items = refs.get("items") or []
    if not items and not t["request"].get("web_search", True):
        return None
    strict = bool(refs.get("strict"))
    scenes = (t.get("storyboard_draft") or {}).get("scenes") or []
    if "核对" in t["request"]["description"] or t.get("check_fail"):
        quote = scenes[min(1, len(scenes) - 1)]["narration"] if scenes else "这款产品让效率提升了一倍。"
        issues = [{"kind": "unsupported", "text": quote, "ref": None,
                   "suggestion": "资料里没有这个说法。删掉，或者换成资料里有的数字。"}]
        if strict:
            first = next((r["id"] for r in items if not r.get("error")), None)
            issues.append({"kind": "term", "text": "降噪深度达到 50 分贝", "ref": first,
                           "suggestion": "资料里的说法是「最高 45 分贝」，按资料改。"})
        return {"rounds": 2, "ok": False, "strict": strict, "issues": issues}
    return {"rounds": 2 if strict else 1, "ok": True, "strict": strict, "issues": []}


# ---------------------------------------------------------------- 每一轮的剧本

def skill_names(t):
    return "」「".join(s["name"] for s in (t["brief"] or {}).get("skills", [])) or "官方风格"


def act_analyze_start(t):
    set_status(t, "running", "分析需求中")
    step(t, "analyze", "running")


def act_analyze_done(t):
    t["brief"] = make_brief(t)
    t["title"] = t["brief"]["title"]
    step(t, "analyze", "done", "")
    if "skills" in t["brief"]["decided"]:
        say(t, "agent", "info", f"描述里没指定风格，我从仓库选了「{skill_names(t)}」。想换风格，生成完成后直接告诉我。")
    names = [m["name"] for m in t["request"].get("models") or []]
    if names:
        say(t, "agent", "info", f"引用了 3D 素材「{'」「'.join(names)}」。我读了素材卡，会挑合适的镜头用它：转台、推近或者做零件动画，不另外重画。")


def needs_research(t):
    """有资料或者开着联网搜索时才整理资料，否则这一步跳过"""
    return has_refs(t) or t["request"].get("web_search", True)


def act_research_start(t):
    if needs_research(t):
        set_status(t, "running", "联网搜索中" if t.get("legacy") else "整理资料中")
        step(t, "research", "running")
    else:
        step(t, "research", "skipped", "")


def act_research_done(t):
    parts = []
    if has_refs(t):
        t["notes"] = make_notes(t)
        items = t["notes"]["items"]
        parts.append(f"读了 {len(items)} 份资料，用到 {sum(1 for x in items if x['used'])} 份")
    if t["request"].get("web_search", True):
        t["sources"] = make_sources(t)
        used = sum(1 for s in t["sources"]["sources"] if s.get("used"))
        parts.append(f"搜索 {len(t['sources']['queries'])} 次，引用了 {used} 个来源")
    step(t, "research", "done", "；".join(parts) + "。")


def act_script_start(t):
    set_text(t, "写讲解稿中" if t.get("legacy") else "写剧本中")
    step(t, "script", "running")


def act_script_done(t):
    t["storyboard_draft"] = make_storyboard(t, t["brief"])
    opts = t["request"].get("options") or {}
    sc = opts.get("script") or {}
    mode = ("verbatim" if sc.get("verbatim") else "outline") if (t["request"]["mode"] == "advanced" and sc.get("enabled")) else "agent"
    t["script"] = {"mode": mode, "paragraphs": [s["narration"] for s in t["storyboard_draft"]["scenes"]]}
    t["scriptCheck"] = make_check(t)
    step(t, "script", "done", "")


def act_storyboard_start(t):
    set_text(t, "写分镜中")
    step(t, "storyboard", "running")


def act_storyboard_done(t):
    t["storyboard"] = t.pop("storyboard_draft")
    step(t, "storyboard", "done", "")
    if t["confirm"]:
        set_status(t, "awaiting_confirmation", "等你确认分镜")
        say(t, "agent", "info", "分镜写好了，先停在这里。看一下「分镜脚本」，没问题就点确认，我再开始写动画和渲染。")


def add_production(turn, t, targets, with_code=True, revise=False):
    """写动画代码 → 逐镜渲染 → 合成；targets 是要渲染的镜头 id"""
    if with_code:
        turn.after(0.5, lambda t: (set_status(t, "running", "写动画代码中"), step(t, "code", "running")))
        turn.after(2.5, lambda t: step(t, "code", "done", f"按「{skill_names(t)}」写了 {len(t['storyboard']['scenes'])} 个场景。"))

    def render_start(t):
        set_status(t, "running")
        first = targets[0] if targets else None
        n = len(t["storyboard"]["scenes"])
        idx = next((i for i, s in enumerate(t["storyboard"]["scenes"]) if s["id"] == first), 0)
        step(t, "render", "running", f"第 {idx + 1} 镜渲染中")
        step(t, "compose", "pending", "")
        set_text(t, f"重新渲染第 {idx + 1} 镜" if revise else f"渲染中 {len(t['clips'])}/{n} 镜")

    turn.after(0.3, render_start)
    for k, sid in enumerate(targets):
        if t.get("fail_at") == sid and not t.get("failed_once"):
            turn.after(2.5, lambda t, sid=sid: act_fail(t, sid))
            return turn
        nxt = targets[k + 1] if k + 1 < len(targets) else None
        turn.after(2.6, lambda t, sid=sid, nxt=nxt: act_clip(t, sid, nxt, revise))

    turn.after(0.4, lambda t: step(t, "render", "done", f"{len(t['storyboard']['scenes'])} 个镜头全部渲染完成。" if not revise else "改动的镜头已重新渲染，其他镜头直接复用。"))
    turn.after(0.3, lambda t: (set_text(t, "合成中"), step(t, "compose", "running", "正在合成配音和字幕")))
    turn.after(2.4, lambda t: act_version(t, revise))
    return turn


def act_clip(t, sid, nxt, revise):
    rev = t["clip_rev"].get(sid, 0) + 1
    t["clip_rev"][sid] = rev
    sc = next(s for s in t["storyboard"]["scenes"] if s["id"] == sid)
    t["clips"][sid] = {"name": register_clip(t, sid, rev), "dur": float(sc["duration"])}
    bill_call(t, "vision", "global.anthropic.claude-sonnet-5-5")
    n = len(t["storyboard"]["scenes"])
    scenes = t["storyboard"]["scenes"]
    if nxt:
        idx = next(i for i, s in enumerate(scenes) if s["id"] == nxt)
        step(t, "render", "running", f"第 {idx + 1} 镜渲染中")
    if not revise:
        set_text(t, f"渲染中 {len(t['clips'])}/{n} 镜")
    t["updatedAt"] = now_ms()


def act_version(t, revise):
    n = len(t["versions"]) + 1
    total = sum(float(s["duration"]) for s in t["storyboard"]["scenes"])
    t["versions"].append({"n": n, "name": register_final(t, n), "dur": round(total + 0.2, 1), "createdAt": now_ms(), "sb": sb_sig(t["storyboard"])})
    voice = (t["brief"] or {}).get("voice")
    if voice:
        bill_call(t, "voice", "minimax.speech-2.8-hd", chars=len("".join((t["script"] or {}).get("paragraphs") or [])) or 300)
    step(t, "compose", "done", f"{voice}配音，中文字幕已烧录。" if voice else "中文字幕已烧录。")
    set_status(t, "completed", f"已完成，第 {n} 版")
    if revise:
        say(t, "agent", "text", f"第 {n} 版好了。只重新渲染了改动的镜头，其他镜头直接复用。还想改哪里，继续告诉我。")


def sb_sig(sb):
    """每镜的指纹（旁白、画面、风格），工作流里判断出片以后分镜改了哪几镜"""
    import hashlib
    return {x["id"]: hashlib.sha1("\n".join(str(x.get(k) or "") for k in ("narration", "visual", "skill")).encode()).hexdigest()[:10]
            for x in (sb or {}).get("scenes") or []}


def sb_changed(t):
    old = t["versions"][-1].get("sb") if t["versions"] else None
    if not old:
        return [], []
    now = sb_sig(t["storyboard"])
    return [k for k, v in now.items() if old.get(k) != v], [k for k in old if k not in now]


def plan_text_revise(t, text, sb):
    """工作流的文字节点：只改剧本和分镜，不配音、不渲染；改完回到原来的状态（没出片时等确认，出片了是已完成）"""
    t["flowNode"] = "text"
    bill_turn(t, "文字节点修改")
    turn = Turn()
    turn.after(0.8, lambda t: (set_status(t, "running", "改分镜中"), step(t, "storyboard", "running")))

    def done(t):
        scenes = t["storyboard"]["scenes"]
        for x in (sb or {}).get("scenes") or []:  # 分镜表里直接改过的旁白
            for s in scenes:
                if s["id"] == x.get("id") and x.get("narration"):
                    s["narration"] = x["narration"].strip()
        m = re.search(r"第\s*(\d+)\s*镜", text)
        k = min(max(int(m.group(1)) if m else 1, 1), len(scenes))
        s = scenes[k - 1]
        s["narration"] = s["narration"].rstrip("。") + "，这一点最关键。"
        t["script"]["paragraphs"] = [x["narration"] for x in scenes]
        step(t, "storyboard", "done", f"按意见改了第 {k} 镜")
        say(t, "agent", "text", f"改好了：第 {k} 镜的旁白重写了，画面描述跟着调整。只改了剧本和分镜，没有配音和渲染。")
        if t["versions"]:
            set_status(t, "completed", f"已完成，第 {len(t['versions'])} 版")
        else:
            set_status(t, "awaiting_confirmation", "等你确认分镜")
    turn.after(2.0, done)
    return turn


def plan_rerun(t, targets, changes):
    """工作流的音画节点点了"重跑"：先发改动计划，只重做受影响的镜头"""
    t["flowNode"] = "av"
    bill_turn(t, revise_label(t))
    turn = Turn()
    turn.after(0.8, lambda t: set_status(t, "running", "理解改动中"))
    turn.after(1.0, lambda t: say(t, "agent", "plan", "\n".join(changes + [f"重做第 {'、'.join(str(int(x)) for x in targets)} 镜，其余镜头直接复用"])))
    add_production(turn, t, targets, with_code=True, revise=True)
    return turn


def apply_flow_settings(t, body):
    """音画节点的设置和任务记录比：改了就写进任务，返回改动清单"""
    o = t["request"].setdefault("options", {})
    changes, redraw = [], False
    ids = [i for i in ((body.get("skills") or {}).get("ids") or []) if i in SKILL_NAMES][:2]
    k = o.get("skills") or {}
    if ids != (k.get("ids") if k.get("enabled") else []):
        changes.append("视觉风格：" + (" + ".join(SKILL_NAMES[i] for i in ids) or "交给 Agent"))
        o["skills"] = {"enabled": bool(ids), "ids": ids}
        redraw = True
    sp, cur = body.get("spec") or {}, o.setdefault("spec", {})
    for key, name in (("ratio", "画幅"), ("resolution", "清晰度"), ("fps", "帧率"), ("voice_id", "音色"), ("subtitles", "字幕"), ("bgm", "背景音乐")):
        if key in sp and sp[key] != cur.get(key):
            changes.append(f"{name}：{cur.get(key)} → {sp[key]}")
            cur[key] = sp[key]
            redraw = redraw or key in ("ratio", "resolution", "fps", "voice_id", "subtitles")
    want = list(dict.fromkeys(body.get("models") or []))
    have = {m["taskId"]: m for m in t["request"].get("models") or []}
    refs = []
    for i, tid in enumerate(want):
        x = STATE["tasks"].get(tid)
        if not x or x["product"] != "model3d" or not x["model"]["versions"]:
            bad("连着的 3D 图片还没做好", "model_missing")
        v = x["model"]["versions"][-1]["n"]
        if tid not in have:
            changes.append(f"新加了 3D 图片（{lib_name(x)}）")
        elif have[tid].get("version") != v:
            changes.append(f"3D 图片（{lib_name(x)}）更新到第 {v} 版")
        refs.append({"id": f"m{i + 1:02d}", "taskId": tid, "name": lib_name(x), "version": v})
    for tid, m in have.items():
        if tid not in want:
            changes.append(f"去掉了 3D 图片（{m['name']}）")
    t["request"]["models"] = refs or None
    return changes, redraw


def act_fail(t, sid):
    idx = next(i for i, s in enumerate(t["storyboard"]["scenes"]) if s["id"] == sid)
    msg = f"第 {idx + 1} 镜渲染超时：粒子数量太多"
    step(t, "render", "failed", msg + "。")
    t["failure"] = {"message": msg, "at": now_ms()}
    set_status(t, "failed", "失败")


def plan_start(t):
    bill_turn(t, "首版")
    turn = Turn()
    research = needs_research(t)
    if t.get("legacy"):  # 老任务：先分析需求，再联网搜索
        turn.after(1.5, act_analyze_start)
        turn.after(2.0, act_analyze_done)
        turn.after(0.4, act_research_start)
        if research:
            turn.after(2.8, act_research_done)
    else:  # 新顺序：资料整理在需求分析前面
        turn.after(1.5, act_research_start)
        if research:
            turn.after(3.2, act_research_done)
        turn.after(0.4, act_analyze_start)
        turn.after(2.0, act_analyze_done)
    turn.after(0.4, act_script_start)
    turn.after(2.0, act_script_done)
    turn.after(0.4, act_storyboard_start)
    turn.after(2.0, act_storyboard_done)
    if not t["confirm"]:
        # 分镜要在剧本执行时才生成，这里先按描述推出镜头 id
        ids = [s["id"] for s in make_storyboard(t, make_brief(t))["scenes"]]
        add_production(turn, t, ids)
    return turn


def plan_confirm(t, edits):
    bill_turn(t, "确认分镜后制作")
    turn = Turn()
    ids = [s["id"] for s in t["storyboard"]["scenes"]]
    text = f"收到，按你改过的分镜继续（改了 {edits} 处），开始写动画和渲染。" if edits else "收到，按确认后的分镜开始写动画和渲染。"
    turn.after(0.8, lambda t: say(t, "agent", "info", text))
    add_production(turn, t, ids)
    return turn


def plan_revise(t, text, scope):
    bill_turn(t, revise_label(t))
    turn = Turn()
    scenes = t["storyboard"]["scenes"]
    if scope == "all":
        targets = [s["id"] for s in scenes]
        plan = f"全片：{text[:30]}\n所有镜头重新渲染\n预计 {max(1, len(targets) // 2)} 分钟"
    else:
        idx = next(i for i, s in enumerate(scenes) if s["id"] == scope)
        targets = [scope]
        plan = f"第 {idx + 1} 镜：{text[:30]}\n只重新渲染第 {idx + 1} 镜，其他镜头直接复用\n预计 1 分钟"
    turn.after(1.0, lambda t: set_status(t, "running", "理解修改中"))
    turn.after(1.4, lambda t: say(t, "agent", "plan", plan))
    add_production(turn, t, targets, with_code=False, revise=True)
    return turn


def plan_retry(t):
    bill_turn(t, "重试")
    turn = Turn()
    sid = t.get("fail_at")
    t["failed_once"] = True
    scenes = t["storyboard"]["scenes"] if t["storyboard"] else []
    idx = next((i for i, s in enumerate(scenes) if s["id"] == sid), 0)
    turn.after(1.0, lambda t: set_status(t, "running", "修复中"))
    turn.after(1.2, lambda t: say(t, "agent", "plan", f"第 {idx + 1} 镜：粒子数量降到一半\n重新渲染第 {idx + 1} 镜和后面的镜头\n已经渲染好的镜头直接复用"))
    targets = [s["id"] for s in scenes[idx:] if s["id"] not in t["clips"] or s["id"] == sid]
    add_production(turn, t, targets, with_code=False)
    return turn


def revise_label(t):
    return f"第 {sum(1 for x in t.get('bill_turns') or [] if x['label'].endswith('次修改')) + 1} 次修改"


# ---------------------------------------------------------------- 3D 图片的剧本：看图分析 → 建模规格 → 建模 → 比对修正 → 导出

MODEL_PARTS = {
    "clock": [("hand-hour", "时针", "以表盘中心为轴，绕 Z 轴转"), ("hand-minute", "分针", "绕 Z 轴转，适合拍时间快进"),
              ("bell-left", "左铃铛", "响铃时绕自身 Z 轴小幅高频抖动"), ("bell-right", "右铃铛", "和左铃反相抖动"),
              ("handle", "提手", "可以绕 X 轴向前或向后放倒")],
    "radio": [("antenna", "拉杆天线", "绕 Z 轴转可以改仰角"), ("grille", "喇叭网罩", "随节拍沿 Z 轴缩放，做低音脉动"),
              ("knob-left", "音量旋钮", "绕 Z 轴转"), ("knob-right", "调台旋钮", "绕 Z 轴转"),
              ("handle", "提手", "可以绕 X 轴放倒")],
}


def make_asset(t):
    p = t["model_params"]
    n = len(t["request"]["images"])
    if p["shape"] == "radio":
        tags, size = ["收音机", "复古", "桌面摆件"], [0.9, 0.75, 0.3]
        summary = "长方体机身，正面左边是布面喇叭，右边是调频刻度盘和两个旋钮，顶上有提手和一根斜伸的拉杆天线。"
        shots = ["35° 斜侧慢速转台，整体最像", "正面推近刻度盘，转调台旋钮表现找台", "天线抬起再放下，配合开机的音效"]
    else:
        tags, size = ["闹钟", "双铃闹钟", "复古", "桌面摆件"], [1.0, 1.42, 0.5]
        summary = "鼓形表壳、镀铬表圈、米白表盘和两只外撇铃铛的复古双铃闹钟，指针、铃铛和提手都可以单独动。"
        shots = ["35° 斜侧慢速转台，整体最像", "正面推近表盘，转秒针表现时间流逝", "两只铃铛小幅高频抖动，表现响铃"]
    word = color_in(t["request"]["description"])[0]
    if word:
        tags.insert(1, word)
    first = ("没有参考照片：外形按描述和 Agent 画的示意图推测" if not n
             else "只有一张照片：背面和底面是推测的" if n == 1 else "底面在照片里看不到，是推测的")
    parts = MODEL_PARTS[p["shape"]] + (INNER_PARTS[p["shape"]] if p.get("explode") else [])
    if p.get("explode"):
        shots.append("用拆解滑杆一步步拆开，每步停一下，配上零件名标注")
    return {"name": t["title"], "tags": tags, "summary": summary, "factory": MODEL_FACTORY, "size": size,
            "parts": [{"id": i, "name": nm, "note": note} for i, nm, note in parts],
            "explode": {"steps": [{"label": st["label"], "parts": [x["id"] for x in st["parts"]]} for st in p["explode"]]}
            if p.get("explode") else None,
            "recommendedShots": shots, "limits": [first, "尺寸是相对值，不是真实厘米", "GLB 里没有零件索引，按节点名字找零件"]}


def model_running(name, text, note=""):
    return lambda t: (set_status(t, "running", text), step(t, name, "running", note))


def model_analyze_note(t):
    n = len(t["request"]["images"])
    what = "鼓形表壳、两只铃铛和顶上的提手" if t["model_params"]["shape"] == "clock" else "长方体机身、正面的喇叭和刻度盘"
    if not n:
        return f"没有照片，先按描述画了一张正面示意图，再当参考图用：{what}。"
    return f"{n} 张照片一起看：{what}。" + ("只有一张，看不到的面要靠推测。" if n == 1 else "")


def act_export_start(t):
    set_status(t, "running", "导出中")
    step(t, "export", "running", "导出多角度图、GLB、打印源数据和素材卡" + ("，再做拆解图和 GIF 动图" if t["model_params"].get("explode") else ""))
    if not t["model"]["asset"]:
        t["model"]["asset"] = make_asset(t)


def act_model_version(t, revise):
    m = t["model"]
    n = len(m["versions"]) + 1
    p = dict(t["model_params"])
    key = f"{t['id'][:8]}-m{n}"
    views = {a: put_blob(f"{key}-{a:03d}.svg", "image/svg+xml", view_svg(p, a)) for a in VIEW_ANGLES}
    cmp = put_blob(f"{key}-cmp.svg", "image/svg+xml", compare_svg(p, n)) if t["request"]["images"] else None
    glb = put_blob(f"{key}.glb", "model/gltf-binary", glb_box(p["body"], m["asset"]["size"]), download=f"{lib_name(t)}_第{n}版.glb")
    ex = None
    if p.get("explode"):  # 拆解产出：带标注的拆解图和 GIF 动图（没有视频）
        names = {x["id"]: x["name"] for x in m["asset"]["parts"]}
        ex = {"image": put_blob(f"{key}-explode.svg", "image/svg+xml", explode_svg(p, p["explode"], names)),
              "gif": put_blob(f"{key}-explode.gif", "image/gif", explode_gif(p), download=f"{lib_name(t)}_第{n}版_拆解.gif")}
    m["versions"].append({"n": n, "params": p, "views": views, "comparison": cmp, "glb": glb, "explode": ex, "printable": True, "at": now_ms()})
    step(t, "export", "done", "5 张多角度图、GLB 和打印源数据都导出了" + ("，拆解图和 GIF 动图也做好了" if ex else "") + "，素材卡已发布。")
    set_status(t, "completed", f"已完成，第 {n} 版")
    if revise:
        say(t, "agent", "text", f"第 {n} 版好了，素材库里的这一项也换成了新版本。还想改哪里，继续告诉我。")


def act_model_fail(t):
    msg = "比对修正超时：渲染机没有响应"
    step(t, "review", "failed", msg + "。")
    t["failure"] = {"message": msg, "at": now_ms()}
    set_status(t, "failed", "失败")


def add_model_review(turn, t, revise=False):
    """比对修正（两轮）→ 导出；描述里带"失败"时第一次比对就失败"""
    turn.after(0.4, model_running("review", "比对修正中", "第 1 轮：渲染多角度图，和参考图并排比对"))
    if t.get("fail_at") == "review" and not t.get("failed_once"):
        turn.after(2.0, act_model_fail)
        return turn
    turn.after(1.8, lambda t: (bill_call(t, "vision", "global.anthropic.claude-sonnet-5-5"),
                               step(t, "review", "running", "第 2 轮：修正比例和颜色")))
    turn.after(1.8, lambda t: step(t, "review", "done", "比对了 2 轮，轮廓、颜色和零件位置都对上了。"))
    turn.after(0.4, act_export_start)
    turn.after(2.2, lambda t: act_model_version(t, revise))
    return turn


def plan_model(t):
    bill_turn(t, "首版")
    turn = Turn()
    n = len(t["request"]["images"])
    parts = MODEL_PARTS[t["model_params"]["shape"]]
    turn.after(1.2, model_running("analyze", "看图分析中", f"正在看 {n} 张照片" if n else "没有照片，先按描述画一张示意图"))
    turn.after(2.4, lambda t: (t.__setitem__("sources", MODEL_SOURCES) if t["request"].get("web_search") else None,
                               step(t, "analyze", "done", model_analyze_note(t))))
    turn.after(0.4, model_running("spec", "写建模规格中"))
    ex = t["model_params"].get("explode")
    inner = len(INNER_PARTS[t["model_params"]["shape"]]) if ex else 0
    turn.after(2.0, lambda t: step(t, "spec", "done", f"拆成 {len(parts) + inner + 4} 个部件，其中 {len(parts) + inner} 个可以单独动"
                                   + (f"（含 {inner} 个内部零件），拆解分 {len(ex)} 步。" if ex else "。")))
    turn.after(0.4, model_running("model", "建模中", "手写 three.js 工厂函数"))
    turn.after(2.4, lambda t: step(t, "model", "done", f"工厂函数 {MODEL_FACTORY} 写好了，只依赖 three。"))
    return add_model_review(turn, t)


def plan_model_revise(t, text):
    bill_turn(t, revise_label(t))
    turn = Turn()

    def restart(t):
        for name in ("model", "review", "export"):
            step(t, name, "pending", "")
        model_running("model", "建模中", "按修改意见调整零件")(t)

    def remodel(t):
        t["model_params"] = revise_params(t["model_params"], text)
        step(t, "model", "done", "改好了，其他零件没动。")

    turn.after(1.0, lambda t: set_status(t, "running", "理解修改中"))
    turn.after(1.2, lambda t: say(t, "agent", "plan", f"{text[:30]}\n只改相关的零件，其余保持不变\n改完重新比对、导出，出一个新版本"))
    turn.after(0.4, restart)
    turn.after(2.0, remodel)
    return add_model_review(turn, t, revise=True)


def plan_model_retry(t):
    bill_turn(t, "重试")
    t["failed_once"] = True
    turn = Turn()
    turn.after(1.0, lambda t: set_status(t, "running", "修复中"))
    turn.after(1.0, lambda t: say(t, "agent", "plan", "换一台渲染机重新连接\n从比对修正接着做，模型不用重写"))
    return add_model_review(turn, t)


# ---------------------------------------------------------------- Credit 计费（假的：跟着步骤推进现编每次模型调用的用量）

CN = timezone(timedelta(hours=8))  # 和后端一样按北京时间分日、分月
PRICES = {  # 美元 / 百万 token：输入、缓存读、缓存写、输出（和后端默认价格表一致）
    "global.anthropic.claude-opus-5-5": (4, 0.2, 5, 20),
    "global.anthropic.claude-opus-4-8": (4, 0.2, 5, 20),
    "global.anthropic.claude-sonnet-5-5": (2, 0.2, 2.5, 10),
}
CREDIT_RATIO = 1.5
VOICE_CNY_PER_10K, USD_CNY = 3.5, 7.2
STEP_CALLS = {"analyze": 2, "research": 3, "script": 2, "storyboard": 3, "code": 4, "render": 1,
              "spec": 2, "model": 4, "review": 3, "export": 1}


def cn_day(ms):
    return datetime.fromtimestamp(ms / 1000, CN).strftime("%Y-%m-%d")


def bill_turn(t, label):
    """新的一轮开始：之后的调用都记在这一轮下"""
    turns = t.setdefault("bill_turns", [])
    turns.append({"turnId": f"turn-{len(turns) + 1}", "label": label})


def bill_call(t, kind="model", model="global.anthropic.claude-opus-5-5", billable=True, note="", chars=None):
    turns = t.get("bill_turns")
    if not turns:
        return
    calls = t.setdefault("calls", [])
    rnd = random.Random(f"{t['id']}:{len(calls)}")
    if kind == "voice":
        usage = {"chars": int(chars or 300)}
        usd = usage["chars"] / 10000 * VOICE_CNY_PER_10K / USD_CNY
    else:
        if kind == "vision":
            usage = {"input": rnd.randint(1500, 4200), "cacheRead": 0, "cacheWrite": 0, "output": rnd.randint(60, 380)}
        else:
            usage = {"input": rnd.randint(2, 40), "cacheRead": rnd.randint(40000, 160000),
                     "cacheWrite": rnd.randint(300, 6000), "output": rnd.randint(200, 2400)}
        price = PRICES.get(model, PRICES["global.anthropic.claude-opus-5-5"])
        usd = sum(usage[k] * v for k, v in zip(("input", "cacheRead", "cacheWrite", "output"), price)) / 1e6
    turn = turns[-1]
    calls.append({"at": now_ms(), "turnId": turn["turnId"], "label": turn["label"], "kind": kind, "model": model,
                  **usage, "credits": round(usd * CREDIT_RATIO, 4), "billable": billable, "note": note})


def bill_step(t, name, state):
    for _ in range(STEP_CALLS.get(name, 0) if state == "done" else 1):
        bill_call(t)
    if name == "research" and state == "done" and t["bill_turns"] and t["bill_turns"][-1]["label"] == "首版":
        bill_call(t, model="global.anthropic.claude-opus-4-8", billable=False, note="安全策略误拦后自动换模型重做，不计费")


def task_credits(t, d0=None, d1=None):
    return round(sum(c["credits"] for c in t.get("calls") or []
                     if c["billable"] and (d0 is None or d0 <= cn_day(c["at"]) <= d1)), 2)


def billing_view(t):
    calls = t.get("calls") or []
    turns = []
    for x in t.get("bill_turns") or []:
        mine = [c for c in calls if c["turnId"] == x["turnId"]]
        if mine:
            turns.append({**x, "credits": round(sum(c["credits"] for c in mine if c["billable"]), 2), "calls": len(mine)})
    last = max((c["at"] for c in calls), default=0)
    pending = t["status"] in ("queued", "running", "awaiting_confirmation") or now_ms() - max(last, t["updatedAt"]) < 180_000
    return {"credits": task_credits(t), "pending": pending, "turns": turns}


def credit_summary(u):
    month = cn_day(now_ms())[:7]
    used = sum(c["credits"] for t in STATE["tasks"].values() if t["sub"] == u["sub"]
               for c in t.get("calls") or [] if c["billable"] and cn_day(c["at"])[:7] == month)
    used = round(used + ARGS.credit_used, 2)
    quota = float(ARGS.credit_quota)
    share = used / quota if quota else 1
    return {"month": month, "used": used, "quota": quota, "remaining": round(max(0.0, quota - used), 2),
            "warn": "100" if share >= 1 else "80" if share >= 0.8 else None}


def check_credit(u):
    s = credit_summary(u)
    if s["used"] >= s["quota"]:
        raise ApiErr(402, "quota_exceeded", "本月额度已用完，下月 1 日恢复")


USAGE_CSV_HEAD = ["时间", "轮次", "类型", "模型", "输入", "缓存读", "缓存写", "输出", "字数", "Credit", "计费", "说明"]


def usage_csv(t):
    import csv
    import io
    kinds = {"model": "主 Agent", "vision": "看图", "voice": "配音", "adjust": "调整"}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(USAGE_CSV_HEAD)
    for c in t.get("calls") or []:
        w.writerow([datetime.fromtimestamp(c["at"] / 1000, CN).strftime("%Y-%m-%d %H:%M:%S"), c["label"], kinds.get(c["kind"], c["kind"]),
                    c.get("model") or "", c.get("input", ""), c.get("cacheRead", ""), c.get("cacheWrite", ""), c.get("output", ""),
                    c.get("chars", ""), f"{c['credits']:.4f}", "是" if c["billable"] else "否", c["note"]])
    w.writerow(["合计", "", "", "", "", "", "", "", "", f"{task_credits(t):.2f}", "", ""])
    return "\ufeff" + buf.getvalue()


def usage_range(query):
    today = cn_day(now_ms())
    d0 = (query.get("from") or [today[:8] + "01"])[0]
    d1 = (query.get("to") or [today])[0]
    for d in (d0, d1):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            raise ApiErr(400, "bad_date", "日期格式是 YYYY-MM-DD")
    if d0 > d1:
        d0, d1 = d1, d0
    a, b = datetime.strptime(d0, "%Y-%m-%d"), datetime.strptime(d1, "%Y-%m-%d")
    if (b - a).days > 366:
        raise ApiErr(400, "bad_range", "日期范围最长一年")
    return d0, d1, a, b


class CsvBody(str):
    """api() 返回它时按 CSV 文件发出去"""


# ---------------------------------------------------------------- 用户、任务

def user_for(email):
    u = STATE["users"].get(email)
    if not u:
        u = {"email": email, "sub": str(uuid.uuid5(uuid.NAMESPACE_URL, "slate:" + email)), "seeded": False}
        STATE["users"][email] = u
    if not u["seeded"] and ARGS.seed:
        u["seeded"] = True
        seed(u)
    return u


def create_task(u, req, title=None, created=None, legacy=False):
    tid = str(uuid.uuid4())
    opts = req.get("options") or {}
    adv = req["mode"] == "advanced"
    desc = req["description"]
    m3d = req.get("product") == "model3d"
    t = {
        "id": tid, "sub": u["sub"], "product": "model3d" if m3d else "video", "title": title or guess_title(desc), "mode": req["mode"],
        "status": "queued", "statusText": "排队中",
        "createdAt": int((created or now()) * 1000), "updatedAt": int((created or now()) * 1000),
        "request": req, "steps": new_steps(legacy, m3d), "legacy": legacy, "brief": None, "sources": None, "notes": None,
        "scriptCheck": None, "script": None, "storyboard": None,
        "clips": {}, "clip_rev": {}, "versions": [], "messages": [], "failure": None,
        "timeline": [], "run_since": None, "elapsed_base": 0.0,
        "confirm": bool(adv and opts.get("confirm_storyboard")),
        "fail_at": None, "failed_once": False,
    }
    if m3d:
        t["model"] = {"asset": None, "versions": []}
        t["model_params"] = model_params(desc, req.get("explode"))
        if "失败" in desc:
            t["fail_at"] = "review"
    elif "失败" in desc:
        n = len(make_storyboard(t, make_brief(t))["scenes"])
        t["fail_at"] = f"{max(1, min(n, round(n * 0.75))):02d}"
    if req.get("flow") and not m3d:  # 工作流的文字节点：一定停在分镜等确认
        t["confirm"] = True
        t["flowNode"] = "text"
    STATE["tasks"][tid] = t
    set_status(t, "queued", "排队中")
    return t


def plan_first(t):
    return plan_model(t) if t["product"] == "model3d" else plan_start(t)


# ---------------------------------------------------------------- 素材库：视频和 3D 图片的记录指向任务，文件单独存

def lib_files(u):
    return STATE["library"].setdefault(u["sub"], {})


def lib_name(t):
    """素材库里显示的名称：改过名用改过的；3D 用素材卡的名称"""
    lib = t.get("lib") or {}
    if lib.get("name"):
        return lib["name"]
    asset = (t.get("model") or {}).get("asset")
    return asset["name"] if asset else t["title"]


def lib_tags(t):
    lib = t.get("lib") or {}
    if "tags" in lib:
        return list(lib["tags"])
    if t["product"] == "model3d":
        return list(((t.get("model") or {}).get("asset") or {}).get("tags") or [])
    kind = (t.get("brief") or {}).get("kind")
    return [kind] if kind else []


def in_library(t):
    """进库规则：有成品的任务（修改中的 3D 任务还留着上一版），没有被移除"""
    if (t.get("lib") or {}).get("removed"):
        return False
    return bool(t["model"]["versions"]) if t["product"] == "model3d" else t["status"] == "completed" and bool(t["versions"])


def lib_add_file(u, name, ctype, data, created=None, desc=None):
    """作为参考资料用过的文件、视频里用过的图片（带描述）自动进库：按文件名加内容去重，最多 LIB_MAX_FILES 个"""
    files = lib_files(u)
    sha = hashlib.sha256(data).hexdigest()
    for f in files.values():
        if f["name"] == name and f["sha"] == sha and (f.get("type") == "image") == (desc is not None):
            if desc:
                f["desc"] = desc
            return f
    if len(files) >= LIB_MAX_FILES:
        return None
    fid = "f-" + str(uuid.uuid4())
    ms = int((created or now()) * 1000)
    ext = name.rsplit(".", 1)[-1].lower()
    f = {"id": fid, "name": name, "tags": [], "size": len(data), "sha": sha, "createdAt": ms, "updatedAt": ms,
         "blob": put_blob(f"{fid}.{ext}", ctype, data, download=name),
         "chars": max(200, len(data) // (4 if ext in ("pdf", "docx", "xlsx") else 2))}
    if desc is not None:
        f.update(type="image", desc=desc)
    files[fid] = f
    return f


def model_version_view(base, v):
    ex = v.get("explode")
    return {"n": v["n"], "views": [{"angle": a, "url": blob_url(base, v["views"][a])} for a in VIEW_ANGLES],
            "comparison": blob_url(base, v["comparison"]), "glb": blob_url(base, v["glb"], True),
            "explode": {"gif": blob_url(base, ex["gif"], True), "image": blob_url(base, ex["image"])} if ex else None,
            "printable": bool(v.get("printable")), "at": v["at"]}


def lib_item(t, base):
    lib = t.get("lib") or {}
    common = {"id": t["id"], "kind": t["product"], "name": lib_name(t), "tags": lib_tags(t), "createdAt": t["createdAt"],
              "updatedAt": max(t["updatedAt"], lib.get("updatedAt", 0))}
    if t["product"] == "video":
        skills = (t["brief"] or {}).get("skills") or []
        return {**common, "thumb": skills[0]["id"] if skills else None,
                "versions": [{"n": v["n"], "url": media_url(base, v["name"]), "download": media_url(base, v["name"], True), "dur": v["dur"]}
                             for v in t["versions"]]}
    asset = t["model"]["asset"] or {}
    v = model_version_view(base, t["model"]["versions"][-1])
    return {**common, "summary": asset.get("summary", ""), "version": v["n"], "views": v["views"],
            "glb": v["glb"], "parts": asset.get("parts") or [], "explode": bool(v["explode"]), "printable": v["printable"]}


def lib_file_item(f, base):
    return {"id": f["id"], "kind": "file", "name": f["name"], "tags": list(f["tags"]), "size": f["size"],
            "createdAt": f["createdAt"], "updatedAt": f["updatedAt"], "download": blob_url(base, f["blob"], True)}


def lib_image_item(f, base):
    return {**lib_file_item(f, base), "kind": "image", "desc": f.get("desc", ""), "url": blob_url(base, f["blob"])}


def library_items(u, kind, q, base):
    if kind == "file":
        items = [lib_file_item(f, base) for f in lib_files(u).values() if f.get("type") != "image"]
    elif kind == "image":
        items = [lib_image_item(f, base) for f in lib_files(u).values() if f.get("type") == "image"]
    elif kind in ("video", "model3d"):
        items = [lib_item(t, base) for t in STATE["tasks"].values() if t["sub"] == u["sub"] and t["product"] == kind and in_library(t)]
    else:
        bad("素材类别只能是 video、model3d 或 file", "bad_kind")
    q = q.strip().lower()
    if q:
        items = [x for x in items if q in " ".join([x["name"], *x["tags"], x.get("summary", ""), x.get("desc", "")]).lower()]
    items.sort(key=lambda x: x["updatedAt"], reverse=True)
    return items


def lib_target(u, kind, item_id):
    """PATCH / DELETE 的对象：视频和 3D 图片是任务，文件是素材库记录"""
    if kind in ("file", "image"):
        f = lib_files(u).get(item_id)
        if f and (f.get("type") == "image") == (kind == "image"):
            return f
    elif kind in ("video", "model3d"):
        t = STATE["tasks"].get(item_id)
        if t and t["sub"] == u["sub"] and t["product"] == kind and in_library(t):
            return t
    else:
        bad("素材类别只能是 video、model3d 或 file", "bad_kind")
    raise ApiErr(404, "not_found", "素材库里没有这一项，可能已经移除了")


def validate_lib_patch(body):
    if not isinstance(body, dict):
        bad("请求格式不对")
    out = {}
    if "name" in body:
        name = body["name"].strip() if isinstance(body["name"], str) else ""
        if not name:
            bad("名称不能为空")
        if len(name) > LIB_NAME_MAX:
            bad(f"名称最多 {LIB_NAME_MAX} 字")
        out["name"] = name
    if "tags" in body:
        tags = body["tags"]
        if not isinstance(tags, list) or not all(isinstance(x, str) for x in tags):
            bad("标签的格式不对")
        tags = list(dict.fromkeys(x.strip() for x in tags if x.strip()))
        if len(tags) > LIB_TAGS_MAX:
            bad(f"标签最多 {LIB_TAGS_MAX} 个")
        if any(len(x) > LIB_TAG_MAX for x in tags):
            bad(f"每个标签最多 {LIB_TAG_MAX} 字")
        out["tags"] = tags
    if not out and "desc" not in body:  # 图片的描述在调用的地方单独处理
        bad("没有要改的内容")
    return out


def seed(u):
    """给新用户预置几条示例任务：完成（两版）、等确认、失败、已完成（方形），再加一条正在跑的"""
    global FAKE_NOW
    base = time.time()

    def mk(desc, created, mode="quick", options=None, web=True, genre=None, refs=None, legacy=False):
        global FAKE_NOW
        FAKE_NOW = created
        req = {"mode": mode, "web_search": web, "description": desc, "genre": genre}
        if refs is not None:  # 新任务都带 refs；老任务没有
            req["refs"] = {"web": web, "strict": False, **refs}
            req["refs"]["items"] = [{"id": f"r{i + 1}", "note": "", **x} for i, x in enumerate(refs.get("items") or [])]
        if options:
            req["options"] = options
        t = create_task(u, req, created=created, legacy=legacy)
        FAKE_NOW = None
        return t

    def opts(**kw):
        o = {"script": {"enabled": False, "outline": "", "verbatim": False, "uploads": []},
             "assets": {"enabled": False, "force": False, "uploads": [], "sites": []},
             "skills": {"enabled": False, "ids": []},
             "spec": {"enabled": False, "ratio": "16:9", "duration": 60, "resolution": "1080p", "fps": 30,
                      "voice": True, "voice_id": "Zhiyu", "subtitles": True, "bgm": False},
             "confirm_storyboard": False}
        for k, v in kw.items():
            if isinstance(v, dict):
                o[k].update(v)
            else:
                o[k] = v
        return o

    # 1. 已完成，两个版本，带修改对话；四份资料（一个链接没抓到），强制引用，核对全部通过
    t = mk("面向开发者讲清楚 Amazon Bedrock AgentCore 的组成：Runtime、Memory、Gateway、Code Interpreter 各管什么，怎么串起来跑一个 Agent。",
           base - 26 * 3600, "advanced", opts(skills={"enabled": True, "ids": ["iso"]}), genre="principle",
           refs={"strict": True, "items": [
               {"kind": "file", "name": "AgentCore 白皮书.pdf", "note": "重点看第三节", "chars": 18420},
               {"kind": "text", "title": "术语表", "note": "", "chars": 1200},
               {"kind": "link", "url": "https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-agentcore/", "note": "发布博客", "chars": 6310},
               {"kind": "link", "url": "https://example.com/agentcore-404", "note": "", "chars": 0, "error": "网页打不开（404）"}]})
    end = run_instant(t, plan_start(t), base - 26 * 3600)
    FAKE_NOW = end + 1800
    say(t, "user", "text", "第 1 镜的标题字太小了，放大一点，再加一个问号被画出来的动画。", scope="01")
    set_status(t, "queued", "排队中")
    turn = plan_revise(t, "标题放大到 44px，新增问号描边动画", "01")
    turn.actions.insert(2, (turn.actions[1][0] + 0.1, lambda t: say(t, "agent", "system", "已切换备用线路继续")))
    FAKE_NOW = None
    run_instant(t, turn, end + 1800)

    # 2. 等你确认分镜（竖屏 15 秒广告）；两份资料，强制引用，剧本核对还有没解决的问题
    t = mk("Aero 2 降噪耳机的 15 秒竖屏信息流广告，主打通勤地铁里一键安静，前 3 秒要抓住人。",
           base - 20 * 60, "advanced",
           opts(spec={"enabled": True, "ratio": "9:16", "duration": 15}, confirm_storyboard=True),
           refs={"strict": True, "items": [
               {"kind": "file", "name": "Aero 2 产品规格.xlsx", "note": "只用降噪那几行", "chars": 2860},
               {"kind": "text", "title": "卖点清单", "note": "市场部定稿", "chars": 640}]})
    t["check_fail"] = True
    run_instant(t, plan_start(t), base - 20 * 60)

    # 3. 失败（渲染超时）；没有资料，联网也关了：资料整理跳过
    t = mk("季度复盘会的开场片，用数据讲第三季度用户增长的三个关键原因，节奏要稳。", base - 4 * 86400, web=False, refs={"items": []})
    t["fail_at"] = "05"
    run_instant(t, plan_start(t), base - 4 * 86400)

    # 4. 已完成，方形 30 秒。改版前的老任务：没有 refs，有讲解稿，步骤还是老顺序
    t = mk("秋季桂花燕麦拿铁新品的门店屏幕广告，30 秒，方形画面，要有节奏感。", base - 3 * 86400 - 3600, "advanced",
           opts(spec={"enabled": True, "ratio": "1:1", "duration": 30, "bgm": True}, skills={"enabled": True, "ids": ["keynote"]},
                script={"enabled": True, "outline": "第一口，就是秋天。\n桂花燕麦拿铁，限时上新。\n第二杯半价，只到 10 月底。\n全国门店都能喝到。",
                        "verbatim": True, "uploads": [], "files": ["input/秋季新品口播稿.docx"]}),
           legacy=True)
    run_instant(t, plan_start(t), base - 3 * 86400 - 3600)
    t["brief"]["kind"] = "广告宣传"  # 老任务：类型还是改版前的旧值，前端照常显示

    # 5. 正在跑：从现在开始实时推进；两份资料，参考（不强制）
    t = mk("给第一次接触大模型应用的产品经理讲清楚检索增强生成（RAG）：为什么需要它、检索和生成各做什么、和微调有什么不同。语气轻松，结尾给一句好记的话。", base,
           refs={"items": [
               {"kind": "file", "name": "公司知识库说明.docx", "note": "报销制度那一节", "chars": 9640},
               {"kind": "text", "title": "员工常见问题", "chars": 2310}]})
    start_turn(t, plan_start(t))

    # 6. 3D 图片：4 张不同角度的照片，两个版本（第 2 版把提手改成棕色皮革）
    def mk3d(desc, created, angles=(), explode=False):
        global FAKE_NOW
        p = model_params(desc)
        files = [{"name": f"{name}.png", "blob": put_blob(f"seed-{uuid.uuid4().hex[:8]}-{a:03d}.svg", "image/svg+xml", view_svg(p, a, ref=True))}
                 for name, a in zip(("正面", "侧面", "背面", "斜侧"), angles)]
        FAKE_NOW = created
        t = create_task(u, {"product": "model3d", "mode": "quick", "web_search": False, "explode": explode, "description": desc,
                            "images": [f"u-seed-{i}" for i in range(len(files))], "imageFiles": files}, created=created)
        FAKE_NOW = None
        return t, run_instant(t, plan_model(t), created)

    t, end = mk3d("薄荷绿双铃闹钟，复古金属质感，表盘是罗马数字，顶上有提手和两只铃铛。", base - 2 * 86400, (0, 90, 180, 35))
    t["model"]["versions"][0]["printable"] = False  # 第 1 版做于打印导出上线之前：没有打印源数据
    FAKE_NOW = end + 3600
    say(t, "user", "text", "提手改成棕色皮革")
    set_status(t, "queued", "排队中")
    FAKE_NOW = None
    run_instant(t, plan_model_revise(t, "提手改成棕色皮革"), end + 3600)

    # 7. 3D 图片：只有一段文字，Agent 先画示意图
    mk3d("80 年代木纹台式收音机，正面左边是布面喇叭，右边是调频刻度盘和两个旋钮，顶上有提手和一根拉杆天线。", base - 5 * 3600)

    # 8. 3D 图片：做拆解（第六节），内部零件、拆解图和 GIF 动图
    mk3d("黄铜机械闹钟，做拆解：提手、两只铃铛、后盖和里面的机芯都能拆下来。", base - 3 * 3600, (35,), explode=True)

    # 素材库里的文件：示例任务用过的参考资料
    lib_add_file(u, "AgentCore 白皮书.pdf", "application/pdf", b"%PDF-1.4\n% Slate mock\n" + b"0" * 180000, created=base - 26 * 3600)
    lib_add_file(u, "Aero 2 产品规格.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                 b"PK\x03\x04 Slate mock\n" + b"0" * 24000, created=base - 20 * 60)
    lib_add_file(u, "品牌用词规范.md", "text/markdown", "# 品牌用词规范\n\n- 统一说「Agent」，不说「智能体」\n- 说「工具」，不说「插件」\n".encode("utf-8"),
                 created=base - 6 * 86400)


def list_item(t, base):
    if t["product"] == "model3d":
        vs = t["model"]["versions"]
        return {
            "id": t["id"], "product": "model3d", "title": lib_name(t), "description": t["request"]["description"][:60],
            "kind": None, "spec": None, "status": t["status"], "statusText": t["statusText"], "thumb": None,
            "thumbUrl": blob_url(base, vs[-1]["views"][35]) if vs else None, "versions": len(vs),
            "failure": t["failure"], "updatedAt": t["updatedAt"], "credits": task_credits(t),
        }
    b = t["brief"] or {}
    spec = None
    if b:
        spec = f"{b['ratio']}，{dur_label(b['duration'])}"
    else:
        sp = (t["request"].get("options") or {}).get("spec") or {}
        if t["mode"] == "advanced" and sp.get("enabled"):
            spec = f"{sp['ratio']}，{dur_label(sp['duration'])}"
    skills = b.get("skills") or []
    return {
        "id": t["id"], "product": "video", "title": t["title"], "description": t["request"]["description"][:60],
        "kind": b.get("kind"), "spec": spec, "status": t["status"], "statusText": t["statusText"],
        "thumb": skills[0]["id"] if skills else None, "versions": len(t["versions"]),
        "failure": t["failure"], "updatedAt": t["updatedAt"], "credits": task_credits(t),
    }


def genre_view(gid):
    g = GENRE_BY_ID.get(gid or "")
    return {"id": g["id"], "name": g["name"]} if g else None


# mock：联网开着的 3D 任务在看图分析时"查到"的来源
MODEL_SOURCES = {"queries": ["复古双铃闹钟 尺寸 材质"],
                 "sources": [{"title": "双铃闹钟的常见结构和尺寸", "url": "https://example.com/twin-bell-clock", "note": "表壳直径、铃铛位置", "used": True}]}


def model_task_view(t, base):
    """3D 任务的详情：brief、script、storyboard 都是 null，versions 是空的，成品在 model 里"""
    st, m = t["status"], t["model"]
    asset = {**m["asset"], "name": lib_name(t), "tags": lib_tags(t)} if m["asset"] else None
    return {
        "id": t["id"], "product": "model3d", "title": lib_name(t), "status": st, "statusText": t["statusText"], "mode": "quick",
        "createdAt": t["createdAt"], "updatedAt": t["updatedAt"], "elapsed": elapsed(t),
        "request": {"description": t["request"]["description"], "web_search": bool(t["request"].get("web_search")),
                    "explode": bool(t["request"].get("explode")),
                    "images": [{"name": x["name"], "url": blob_url(base, x["blob"])} for x in t["request"]["imageFiles"]]},
        "steps": [dict(s) for s in t["steps"]],
        "brief": None, "sources": t.get("sources"), "notes": None, "scriptCheck": None, "script": None, "storyboard": None, "versions": [],
        "model": {"asset": asset, "versions": [model_version_view(base, v) for v in m["versions"]]},
        "messages": t["messages"],
        "canMessage": st == "completed", "canConfirm": False, "canRetry": st == "failed",
        "failure": t["failure"], "billing": billing_view(t),
        "flow": {"id": t["request"]["flow"]} if t["request"].get("flow") else None,
    }


def task_view(t, base):
    if t["product"] == "model3d":
        return model_task_view(t, base)
    sb = t["storyboard"]
    storyboard = None
    if sb:
        start, scenes = 0.0, []
        for s in sb["scenes"]:
            c = t["clips"].get(s["id"])
            scenes.append({**s, "start": start,
                           "clip": {"url": media_url(base, c["name"]), "dur": c["dur"]} if c else None})
            start += float(s["duration"])
        storyboard = {**{k: v for k, v in sb.items() if k != "scenes"}, "scenes": scenes}
    st = t["status"]
    return {
        "id": t["id"], "product": "video", "title": t["title"], "status": st, "statusText": t["statusText"], "mode": t["mode"],
        "createdAt": t["createdAt"], "updatedAt": t["updatedAt"], "elapsed": elapsed(t),
        "request": {**t["request"], "genre": genre_view(t["request"].get("genre")),
                    "images": [{"id": x["id"], "name": x["name"], "desc": x["desc"], "fileId": x.get("fileId"), "url": blob_url(base, x["blob"])}
                               for x in t["request"].get("images") or []] or None},
        "steps": [dict(s) for s in t["steps"]],
        "brief": t["brief"], "sources": t["sources"], "notes": t.get("notes"), "scriptCheck": t.get("scriptCheck"),
        "script": t["script"], "storyboard": storyboard,
        "versions": [{"n": v["n"], "url": media_url(base, v["name"]), "download": media_url(base, v["name"], True),
                      "dur": v["dur"], "createdAt": v["createdAt"]} for v in t["versions"]],
        "messages": t["messages"],
        "canMessage": st == "completed", "canConfirm": st == "awaiting_confirmation", "canRetry": st == "failed",
        "failure": t["failure"], "billing": billing_view(t),
        "flow": ({"id": t["request"]["flow"], "node": t.get("flowNode", "text"), "changed": sb_changed(t)[0], "removed": sb_changed(t)[1]}
                 if t["request"].get("flow") else None),
    }


def quota(u):
    mine = [t for t in STATE["tasks"].values() if t["sub"] == u["sub"]]
    day = time.strftime("%Y-%m-%d", time.localtime())
    return {
        "running": sum(1 for t in mine if t["status"] in ("queued", "running")), "runningLimit": RUNNING_LIMIT,
        "today": sum(1 for t in mine if time.strftime("%Y-%m-%d", time.localtime(t["createdAt"] / 1000)) == day and not t.get("seeded_old")),
        "dailyLimit": DAILY_LIMIT,
    }


# ---------------------------------------------------------------- 参数校验

def bad(msg, code="bad_request"):
    raise ApiErr(400, code, msg)


def fake_chars(up):
    """mock：按文件大小估一个抽出来的字数"""
    ext = up["filename"].rsplit(".", 1)[-1].lower()
    return max(200, up["size"] // (4 if ext in ("pdf", "docx", "xlsx") else 2))


def validate_refs(u, body):
    """refs = {web, strict, items}；返回 (给任务记录的 refs, 联网开关)。老前端不传 refs，用顶层的 web_search"""
    ws = body.get("web_search", True)
    if not isinstance(ws, bool):
        bad("联网搜索开关的格式不对")
    raw = body.get("refs")
    if raw is None:
        return None, ws
    if not isinstance(raw, dict):
        bad("参考资料的格式不对")
    web, strict = raw.get("web", ws), raw.get("strict", False)
    if not isinstance(web, bool) or not isinstance(strict, bool):
        bad("联网搜索和强制引用的开关格式不对")
    items = raw.get("items") or []
    if not isinstance(items, list):
        bad("参考资料的格式不对")
    if len(items) > REF_MAX:
        bad(f"参考资料最多 {REF_MAX} 份，先删掉一些")
    out, links, uploads = [], 0, []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            bad("参考资料的格式不对")
        note = str(it.get("note") or "").strip()
        if len(note) > NOTE_MAX:
            bad(f"备注太长了，每条最多 {NOTE_MAX} 字")
        rid, kind = f"r{i + 1}", it.get("kind")
        if kind == "file":
            uid = it.get("uploadId")
            up = STATE["uploads"].get(uid) if isinstance(uid, str) else None
            if not up or up["sub"] != u["sub"]:
                bad("参考资料里有文件找不到了，请重新上传")
            if not up["uploaded"]:
                bad("参考资料里有文件没有上传成功，请重新上传")
            if up.get("purpose") != "ref":
                bad("参考资料里有文件不是按参考资料上传的，请重新上传")
            out.append({"id": rid, "kind": "file", "name": str(it.get("name") or up["filename"])[:200], "note": note,
                        "chars": fake_chars(up)})
            uploads.append(up)
        elif kind == "library":
            f = lib_files(u).get(it.get("fileId")) if isinstance(it.get("fileId"), str) else None
            if not f:
                bad("素材库里有文件找不到了，可能已经删除，请重新选择", "bad_library_file")
            out.append({"id": rid, "kind": "library", "source": "素材库", "fileId": f["id"], "title": f["name"], "note": note,
                        "chars": f["chars"]})
        elif kind == "text":
            text = str(it.get("text") or "").strip()
            if not text:
                bad("粘贴的文字是空的")
            if len(text) > REF_MAX_CHARS:
                bad("粘贴的文字每段不超过 2 万字，删减一些或者分成几段")
            out.append({"id": rid, "kind": "text", "title": str(it.get("title") or "").strip()[:60] or "粘贴的文字",
                        "note": note, "chars": len(text)})
        elif kind == "link":
            url = str(it.get("url") or "").strip()
            if not re.match(r"^https?://[^\s/]+\.[^\s]+$", url) or len(url) > 2000:
                bad("链接的网址不对，请检查后再试")
            links += 1
            if links > REF_MAX_LINKS:
                bad(f"链接最多 {REF_MAX_LINKS} 个")
            x = {"id": rid, "kind": "link", "url": url, "note": note, "chars": 0}
            if re.search(r"fail|404", url):  # mock：开工前抓取失败
                x["error"] = "网页打不开（404）"
            else:
                x["chars"] = 2000 + sum(map(ord, url)) % 6000
            out.append(x)
        else:
            bad("参考资料只能是文件、粘贴的文字、链接或素材库里的文件")
    return {"web": web, "strict": strict, "items": out}, web, uploads


def validate_models(u, body):
    """视频引用的 3D 图片：最多 3 个，必须是自己已经做好的 3D 任务。返回 [{id, taskId, name}]，没有时是 None"""
    ids = body.get("models") or []
    if not isinstance(ids, list):
        bad("引用的 3D 图片格式不对", "bad_models")
    ids = list(dict.fromkeys(ids))
    if len(ids) > VIDEO_MAX_MODELS:
        bad(f"从素材库引用的 3D 图片最多 {VIDEO_MAX_MODELS} 个", "bad_models")
    for m in ids:
        t = STATE["tasks"].get(m) if isinstance(m, str) else None
        if not t or t["sub"] != u["sub"] or t["product"] != "model3d" or not t["model"]["versions"]:
            bad("引用的 3D 图片找不到了，或者还没做好，请重新选择", "bad_models")
    return [{"id": f"m{i + 1:02d}", "taskId": m, "name": lib_name(STATE["tasks"][m]), "version": STATE["tasks"][m]["model"]["versions"][-1]["n"]}
            for i, m in enumerate(ids)] or None


def validate_model(u, body):
    """3D 图片：一段描述，加 0～4 张同一物体不同角度的照片"""
    desc = body.get("description")
    if not isinstance(desc, str) or not desc.strip():
        bad("先写一段描述，说清楚要做一个什么样的物体", "empty_description")
    if len(desc) > 2000:
        bad("描述太长了，最多 2000 字")
    ids = body.get("images") or []
    if not isinstance(ids, list):
        bad("照片的格式不对")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MODEL_MAX_IMAGES:
        bad(f"照片最多 {MODEL_MAX_IMAGES} 张", "too_many_images")
    files = []
    for uid in ids:
        up = STATE["uploads"].get(uid) if isinstance(uid, str) else None
        if not up or up["sub"] != u["sub"]:
            bad("有照片找不到了，请重新上传", "bad_upload")
        if not up["uploaded"]:
            bad("有照片没有上传成功，请重新上传", "bad_upload")
        if up["purpose"] != "image":
            bad("有照片不是按参考照片上传的，请重新上传", "bad_upload")
        files.append({"name": up["filename"], "blob": put_blob(f"{uid}-{up['filename']}", up["contentType"], up["data"])})
    ws = body.get("web_search", True)
    if not isinstance(ws, bool):
        bad("联网搜索的开关格式不对")
    ex = body.get("explode", False)
    if not isinstance(ex, bool):
        bad("做拆解的开关格式不对", "bad_explode")
    return {"product": "model3d", "mode": "quick", "web_search": ws, "explode": ex, "description": desc.strip(), "images": ids, "imageFiles": files}


# ---------------------------------------------------------------- 3D 打印导出（假的，第六节）：按机型、高度缩放，报告尺寸、颜色和警告

PRINT_PARTS = {  # 能打印的零件和颜色；"body" / "handle" 换成模型参数里的颜色
    "clock": [("表壳", "body"), ("表圈", CHROME), ("表盘", "#F1ECE0"), ("刻度", "#1D1D1F"), ("时针", "#1D1D1F"), ("分针", "#1D1D1F"),
              ("秒针", "#E8573C"), ("左铃铛", CHROME), ("右铃铛", CHROME), ("铃铛支杆", CHROME), ("提手", "handle"), ("支脚", CHROME)],
    "radio": [("机身", "body"), ("面板", "#EFE7D6"), ("喇叭网罩", "#3A3530"), ("网罩圈", CHROME), ("刻度盘", "#F6F1E4"), ("调台指针", "#C8102E"),
              ("音量旋钮", CHROME), ("调台旋钮", CHROME), ("拉杆天线", CHROME), ("提手", "handle"), ("支脚", "#2A2A2E")],
}
PRINT_INNER = {"clock": [("后盖", "body"), ("机芯", "#B8892E")], "radio": [("机芯电路板", "#2F6B3A"), ("电子管", "#D9C9A0")]}
PRINT_THIN = {"clock": [("秒针", 0.01)], "radio": [("调台指针", 0.006), ("拉杆天线", 0.012)]}  # 最细处，模型单位
PRINT_OPEN = {"clock": "左铃铛、右铃铛的网格没有封闭（半球面没封口）。Bambu Studio 会尝试自动修复，切片前看一下预览"}


def merge_colors(parts, n):
    """按相近程度把颜色归并成 n 种：用得最多的颜色先当中心，再挑离已有中心最远的；其余并到 RGB 最近的中心"""
    groups = {}
    for name, c in parts:
        groups.setdefault(c.lower(), []).append(name)
    dist = lambda a, b: sum((x - y) ** 2 for x, y in zip(_hex_rgb(a), _hex_rgb(b)))
    order = sorted(groups, key=lambda c: -len(groups[c]))
    centers = order[:1]
    while len(centers) < min(n, len(order)):
        centers.append(max((c for c in order if c not in centers), key=lambda c: (min(dist(c, k) for k in centers), len(groups[c]))))
    out = {c: list(groups[c]) for c in centers}
    for c in order:
        if c not in out:
            out[min(centers, key=lambda k: dist(k, c))].extend(groups[c])
    return [{"hex": c, "parts": out[c]} for c in centers]


def make_print(t, body, base):
    """POST /tasks/{id}/print：校验 → 生成文件放进内存 → 返回下载链接和报告（_delay 是让接口停一会儿再返回）"""
    if t["product"] != "model3d":
        bad("只有 3D 图片可以导出打印文件", "bad_product")
    if not isinstance(body, dict):
        bad("请求格式不对")
    n = body.get("v")
    v = next((x for x in t["model"]["versions"] if x["n"] == n), None) if isinstance(n, int) and not isinstance(n, bool) else None
    if not v:
        raise ApiErr(404, "not_found", "没有这个版本的 3D 模型")
    if not v.get("printable"):
        raise ApiErr(409, "not_printable", "这个版本没有打印源数据。用对话改一次，出一个新版本后再导出")
    printer = body.get("printer")
    if printer not in PRINTERS:
        bad("机型只能是 A1 mini、A1 / P1 / X1 / P2S、H2D 或 H2S", "bad_printer")
    pname, (bx, by, bz) = PRINTERS[printer]
    h = body.get("height")
    if isinstance(h, bool) or not isinstance(h, (int, float)) or not math.isfinite(h):
        bad("高度要填数字，单位是毫米", "bad_height")
    if h < PRINT_MIN_H:
        bad(f"高度最少 {PRINT_MIN_H} 毫米", "bad_height")
    if h > bz:
        bad(f"{pname} 最高打 {bz} 毫米，把高度调低一些，或者换一台机型", "bad_height")
    mode, colors, fmt = body.get("mode"), body.get("colors"), body.get("format")
    if mode not in ("whole", "parts"):
        bad("出法只能是整体或零件分开", "bad_mode")
    if isinstance(colors, bool) or colors not in PRINT_COLORS:
        bad("颜色数只能是 1、4、8 或 16", "bad_colors")
    if fmt not in ("3mf", "stl"):
        bad("格式只能是 3MF 或 STL", "bad_format")
    p = v["params"]
    sx, sy, sz = t["model"]["asset"]["size"]
    k = h / sy  # 每个模型单位多少毫米
    w, d = sx * k, sz * k
    if w > bx or d > by:
        fit = math.floor(min(bx / sx, by / sz) * sy)
        bad(f"按 {h:g} 毫米高，模型宽 {w:.0f} 毫米、深 {d:.0f} 毫米，放不下 {pname} 的热床（{bx}×{by} 毫米）。把高度调到 {fit} 毫米以内再试", "too_large")
    shape = p["shape"]
    color_of = lambda c: p["body"] if c == "body" else p["handle"] if c == "handle" else c
    parts = [(nm, color_of(c)) for nm, c in PRINT_PARTS[shape] + (PRINT_INNER[shape] if p.get("explode") else [])]
    groups = merge_colors(parts, 1 if fmt == "stl" else colors)  # STL 只有单色
    warns = [f"{nm}缩放后只有 {u * k:.1f} 毫米粗，不到 {PRINT_THIN_MM} 毫米，可能打不出来。把高度调高一些，或者打完不装它"
             for nm, u in PRINT_THIN[shape] if u * k < PRINT_THIN_MM]
    if shape in PRINT_OPEN:
        warns.append(PRINT_OPEN[shape])
    # 文件：整体是一个物体；零件分开时每个零件一个小方盒，在热床上按行排开
    stem = re.sub(r'[\\/:*?"<>|\s]+', "", f"{lib_name(t)}_第{v['n']}版_{h:g}mm" + ("_零件分开" if mode == "parts" else ""))
    ci = {nm: i for i, g in enumerate(groups) for nm in g["parts"]}
    cell = max(6.0, min(w, d, h) / 3)
    laid = [(nm, ci[nm], cell, cell, cell * 0.8, 5 + (i % 6) * (cell + 5), 5 + (i // 6) * (cell + 5)) for i, (nm, _) in enumerate(parts)]
    if fmt == "3mf":
        objs = [(lib_name(t), 0, w, d, h, 0, 0)] if mode == "whole" else laid
        file, ctype, data = stem + ".3mf", "model/3mf", make_3mf(objs, [g["hex"] for g in groups])
    elif mode == "whole":
        file, ctype, data = stem + ".stl", "model/stl", stl_box(w, d, h, lib_name(t))
    else:
        file, ctype = stem + ".zip", "application/zip"
        data = zip_bytes([(f"{i + 1:02d}_{nm}.stl", stl_box(cw, cd, ch, nm)) for i, (nm, _c, cw, cd, ch, _x, _y) in enumerate(laid)])
    name = put_blob(f"{t['id'][:8]}-print-{secrets.token_hex(4)}.{file.rsplit('.', 1)[-1]}", ctype, data, download=file)
    report = {"sizeMm": [round(w, 1), round(d, 1), round(float(h), 1)], "parts": len(parts), "objects": 1 if mode == "whole" else len(parts),
              "colors": groups, "warnings": warns}
    return {"download": blob_url(base, name, True), "file": file, "report": report, "_delay": PRINT_DELAY}


def check_quota(u):
    check_credit(u)
    q = quota(u)
    if q["running"] >= RUNNING_LIMIT:
        raise ApiErr(429, "quota_running", f"同时最多 {RUNNING_LIMIT} 个生成中的任务，等其中一个完成后再新建")
    if q["today"] >= DAILY_LIMIT:
        raise ApiErr(429, "quota_daily", f"今天的 {DAILY_LIMIT} 支额度已经用完，明天再来")


def validate_images(u, body):
    """视频里用的普通图片（docs/image-refs-design.md）：每张都要写描述，最多 8 张；上传的带着描述进素材库"""
    raw = body.get("images") or []
    if not isinstance(raw, list) or len(raw) > 8:
        raise ApiErr(400, "too_many_images", "图片最多 8 张")
    out = []
    for it in raw:
        desc = re.sub(r"\s+", " ", str((it or {}).get("desc") or "")).strip()
        if not desc:
            raise ApiErr(400, "empty_image_desc", "每张图片都要写一句描述：这是什么、想在片子里怎么用")
        if len(desc) > 200:
            raise ApiErr(400, "image_desc_too_long", "图片的描述每张不超过 200 个字")
        if it.get("kind") == "file":
            up = STATE["uploads"].get(it.get("uploadId"))
            if not up or up["sub"] != u["sub"] or not up["uploaded"] or up.get("purpose") != "image":
                bad("有图片没有上传成功，请重新上传")
            f = lib_add_file(u, up["filename"], up["contentType"], up.get("data") or b"", desc=desc)
        else:
            f = lib_files(u).get(it.get("fileId"))
            if not f or f.get("type") != "image":
                raise ApiErr(400, "library_file_missing", "引用的素材库图片已经删除了，请重新选择")
            f["desc"] = desc
        out.append({"id": f"i{len(out) + 1:02d}", "name": f["name"], "desc": desc, "blob": f["blob"], "fileId": f["id"]})
    return out


def validate_create(u, body):
    """返回 (任务请求, 要放进素材库的参考资料上传)"""
    if not isinstance(body, dict):
        bad("请求格式不对")
    if body.get("product") == "model3d":
        req = validate_model(u, body)
        if body.get("flow"):
            req["flow"] = body["flow"]
        check_quota(u)
        return req, []
    if body.get("product", "video") != "video":
        bad("只能做视频或 3D 图片")
    mode = body.get("mode")
    if mode not in ("quick", "advanced"):
        bad("创建方式不对，只能是快速模式或高级模式")
    desc = body.get("description")
    if not isinstance(desc, str) or not desc.strip():
        bad("描述不能为空，先写一段描述再开始生成")
    if len(desc) > 4000:
        bad("描述太长了，最多 4000 字")
    genre = body.get("genre") or None
    if genre is not None and genre not in GENRE_BY_ID:
        raise ApiErr(400, "bad_genre", "没有这种写法，请重新选择")
    refs, ws, uploads = validate_refs(u, body)  # 顶层 web_search 留给老前端，以 refs.web 为准
    req = {"product": "video", "mode": mode, "web_search": ws, "description": desc.strip(), "genre": genre,
           "models": validate_models(u, body), "images": validate_images(u, body)}
    if refs is not None:
        req["refs"] = refs
    if mode == "advanced" and body.get("options") is not None:
        o = body["options"]
        if not isinstance(o, dict):
            bad("高级选项的格式不对")
        o = {k: v for k, v in o.items() if k not in ("script", "assets")}  # 讲解稿和素材都已下线，老前端传了也忽略
        k = o.get("skills") or {}
        if k.get("enabled"):
            ids = k.get("ids") or []
            if not ids:
                bad("风格 Skills 已勾选，但没有选择 Skill。从仓库添加一个，或者取消勾选")
            for i in ids:
                if i not in SKILL_NAMES:
                    bad(f"选择的 Skill 不存在：{i}")
        p = o.get("spec") or {}
        if p.get("enabled"):
            if p.get("ratio") not in RATIOS:
                bad("画幅只能是 16:9、9:16、1:1 或 4:5")
            if p.get("duration") not in DURATIONS:
                bad("时长只能是 15、30、60、90 秒或 3 分钟")
            if p.get("resolution") not in ("720p", "1080p"):
                bad("清晰度只能是 720p 或 1080p")
            if p.get("fps") not in (30, 60):
                bad("帧率只能是 30 或 60")
            if p.get("voice") and p.get("voice_id", "auto") not in {"auto", "Zhiyu", *(v["id"] for v in VOICES)}:
                bad("没有这个音色")
        req["options"] = o
    if body.get("flow"):  # 工作流模式：画板编号；一定停在分镜，长片不支持
        if mode != "advanced" or not ((req.get("options") or {}).get("spec") or {}).get("enabled"):
            bad("工作流模式的任务要带上规格设置", "bad_flow")
        if req["options"]["spec"]["duration"] > 180:
            bad("工作流模式暂时只支持 3 分钟以内的片子，更长的片子请用自由模式", "flow_long")
        req["flow"] = body["flow"]
        req["options"]["confirm_storyboard"] = True
    check_quota(u)
    return req, uploads


def validate_storyboard_edit(t, sb):
    if not isinstance(sb, dict) or not isinstance(sb.get("scenes"), list):
        bad("分镜格式不对")
    old = {s["id"]: s for s in t["storyboard"]["scenes"]}
    if [s.get("id") for s in sb["scenes"]] != [s["id"] for s in t["storyboard"]["scenes"]]:
        bad("分镜的镜头和原来对不上，请刷新页面后再确认")
    edits = 0
    new = []
    for s in sb["scenes"]:
        o = old[s["id"]]
        narration, visual = s.get("narration"), s.get("visual")
        if not isinstance(narration, str) or not narration.strip() or len(narration) > 600:
            bad("旁白不能为空，最多 600 字")
        if not isinstance(visual, str) or not visual.strip() or len(visual) > 400:
            bad("画面描述不能为空，最多 400 字")
        extra = set(s) - {"id", "title", "narration", "visual", "duration", "skill"}
        if extra:
            bad("分镜里有不认识的字段：" + "、".join(sorted(extra)))
        edits += (narration.strip() != o["narration"]) + (visual.strip() != o["visual"])
        new.append({**o, "narration": narration.strip(), "visual": visual.strip()})
    return new, edits


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "SlateMock/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            sys.stderr.write("[mock] " + (fmt % args) + "\n")

    # ---- 响应
    def send_json(self, status, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_text(self, status, text, ctype="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    def read_json(self):
        raw = self.read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiErr(400, "bad_json", "请求格式不对")

    @property
    def base(self):
        return "http://" + (self.headers.get("Host") or f"127.0.0.1:{ARGS.port}")

    # ---- 分发
    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        try:
            u = urlsplit(self.path)
            path = u.path
            if path.startswith("/api/"):
                self.read_and_api(method, path, parse_qs(u.query))
            elif path == "/config.json":
                self.send_json(200, {"apiBase": "/api", "region": "us-east-1", "userPoolId": "us-east-1_mock",
                                     "clientId": "mock-client", "mock": True})
            elif path.startswith("/media/") and method == "GET":
                self.serve_media(path[len("/media/"):], parse_qs(u.query))
            elif path.startswith("/blob/") and method == "GET":
                self.serve_blob(unquote(path[len("/blob/"):]), parse_qs(u.query))
            elif path.startswith("/__upload/") and method == "PUT":
                self.put_upload(path[len("/__upload/"):])
            elif path.startswith("/__dev/") and method == "POST":
                self.read_body()
                self.dev(path)
            elif method == "GET":
                self.serve_static(path)
            else:
                self.read_body()
                self.send_json(405, {"error": "method_not_allowed", "message": "不支持这个请求方法"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ApiErr as e:
            self.send_json(e.status, {"error": e.code, "message": e.message})
        except Exception:
            traceback.print_exc()
            try:
                self.send_json(500, {"error": "internal", "message": "mock 服务器内部错误"})
            except Exception:
                pass

    # ---- 静态文件
    def serve_static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        target = (WEB_ROOT / rel).resolve()
        if WEB_ROOT not in target.parents and target != WEB_ROOT or (WEB_ROOT / "dev") in target.parents:
            return self.send_text(404, "not found")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return self.send_text(404, "not found")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            ctype = "text/javascript"
        if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---- 媒体（支持 Range，播放器拖动需要）
    def serve_media(self, name, q):
        name = os.path.basename(unquote(name))
        issued = int((q.get("X-Mock-Issued") or ["0"])[0] or 0)
        if not q.get("X-Mock-Signature") or time.time() - issued > ARGS.url_ttl:
            return self.send_text(403, "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", "application/xml")
        with LOCK:
            spec = MEDIA.get(name)
        if not spec:
            return self.send_text(404, "<Error><Code>NoSuchKey</Code></Error>", "application/xml")
        path = ensure_media(name)
        if not path:
            return self.send_text(500, "media generation failed")
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if q.get("download"):
            fn = spec.get("download") or name
            self.send_header("Content-Disposition", f"attachment; filename=\"slate.mp4\"; filename*=UTF-8''{quote(fn)}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ---- 内存里的文件（照片、多角度图、GLB、素材库文件），链接和媒体一样会过期
    def serve_blob(self, name, q):
        issued = int((q.get("X-Mock-Issued") or ["0"])[0] or 0)
        if not q.get("X-Mock-Signature") or time.time() - issued > ARGS.url_ttl:
            return self.send_text(403, "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", "application/xml")
        with LOCK:
            b = BLOBS.get(name)
        if not b:
            return self.send_text(404, "<Error><Code>NoSuchKey</Code></Error>", "application/xml")
        self.send_response(200)
        self.send_header("Content-Type", b["ctype"])
        self.send_header("Content-Length", str(len(b["data"])))
        if q.get("download"):
            fn = b.get("download") or name
            self.send_header("Content-Disposition", f"attachment; filename=\"slate\"; filename*=UTF-8''{quote(fn)}")
        self.end_headers()
        self.wfile.write(b["data"])

    # ---- 预签名上传（PUT 文件本体，按限速读取，前端能看到进度）
    def put_upload(self, uid):
        uid = unquote(uid)
        n = int(self.headers.get("Content-Length") or 0)
        with LOCK:
            up = STATE["uploads"].get(uid)
        if not up:
            self.read_body()
            return self.send_text(403, "<Error><Code>AccessDenied</Code></Error>", "application/xml")
        if (self.headers.get("Content-Type") or "").split(";")[0].strip() != up["contentType"]:
            self.read_body()
            return self.send_text(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>", "application/xml")
        got, rate, chunks = 0, max(1, ARGS.upload_kbps) * 1024, []
        t0 = time.time()
        while got < n:
            chunk = self.rfile.read(min(65536, n - got))
            if not chunk:
                break
            got += len(chunk)
            chunks.append(chunk)
            wait = got / rate - (time.time() - t0)
            if wait > 0:
                time.sleep(wait)
        with LOCK:
            up["uploaded"] = got == up["size"]
            up["received"] = got
            up["data"] = b"".join(chunks)  # 照片要在生成页显示，参考资料要进素材库
        if got != up["size"]:
            return self.send_text(400, "<Error><Code>IncompleteBody</Code></Error>", "application/xml")
        self.send_response(200)
        self.send_header("ETag", '"' + secrets.token_hex(8) + '"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- 开发辅助
    def dev(self, path):
        with LOCK:
            if path == "/__dev/reset":
                STATE["users"].clear()
                STATE["tasks"].clear()
                STATE["uploads"].clear()
                STATE["library"].clear()
                return self.send_json(200, {"ok": True})
            if path == "/__dev/expire-tokens":
                STATE["revoked_before"] = int(time.time() * 1000) + 1
                return self.send_json(200, {"ok": True})
        self.send_json(404, {"error": "not_found", "message": "没有这个开发接口"})

    # ---- API
    def auth(self):
        h = (self.headers.get("Authorization") or "").strip()
        if h.lower().startswith("bearer "):
            h = h[7:].strip()
        if not h:
            return None
        if h.startswith("mock."):
            # 格式：mock.<URL 编码的邮箱>.<签发毫秒>；邮箱里本身有点，从右边切
            enc, _, issued = h[len("mock."):].rpartition(".")
            if not enc or not issued.isdigit():
                return None
            if int(issued) < STATE["revoked_before"]:
                return None
            email = unquote(enc) or "dev@slate.local"
        else:
            # 非 mock token（比如浏览器测试里拦截 Cognito 后返回的假 token）：带 expired 字样就当过期
            if "expired" in h:
                return None
            email = "dev@slate.local"
        return user_for(email)

    def flows_api(self, method, rest, body, u):
        """工作流和画板（内存里存着，重启就没了）"""
        mine = STATE["flows"].setdefault(u["sub"], {})
        if not rest and method == "GET":
            items = sorted(mine.values(), key=lambda x: -x["updatedAt"])
            return 200, {"items": items}
        if not rest and method == "POST":
            if body.get("kind") not in ("template", "canvas"):
                bad("工作流的类型不对", "bad_flow")
            doc = body.get("doc") or {"nodes": [], "edges": []}
            if body["kind"] == "template":
                doc = {**doc, "nodes": [{k: v for k, v in n.items() if k != "task"} for n in doc.get("nodes") or []]}
            fid = str(uuid.uuid4())
            mine[fid] = {"id": fid, "kind": body["kind"], "name": str(body.get("name") or "未命名工作流")[:40], "doc": doc,
                         "createdAt": now_ms(), "updatedAt": now_ms()}
            return 201, {"id": fid, "updatedAt": mine[fid]["updatedAt"]}
        w = mine.get(rest[0]) if rest else None
        if not w:
            raise ApiErr(404, "not_found", "这个工作流不存在，可能已经删除了")
        if method == "GET":
            return 200, w
        if method == "PATCH":
            if "name" in body:
                w["name"] = str(body["name"] or "未命名工作流")[:40]
            if "doc" in body:
                w["doc"] = body["doc"] if w["kind"] == "canvas" else {**body["doc"], "nodes": [{k: v for k, v in n.items() if k != "task"} for n in body["doc"].get("nodes") or []]}
            w["updatedAt"] = now_ms()
            return 200, {"ok": True, "updatedAt": w["updatedAt"]}
        if method == "DELETE":
            del mine[rest[0]]
            return 200, {"ok": True}
        raise ApiErr(404, "not_found", "接口不存在")

    def read_and_api(self, method, path, query):
        body = self.read_json() if method in ("POST", "PUT", "PATCH") else None
        if ARGS.latency:
            time.sleep(ARGS.latency)
        with LOCK:
            u = self.auth()
            if not u:
                # 模仿 API Gateway Cognito 授权器的默认响应
                return self.send_json(401, {"message": "Unauthorized"})
            status, obj = self.api(method, path, query, body, u)
        if isinstance(obj, dict) and "_delay" in obj:  # 要花时间的接口（导出打印文件）：在锁外面等，不挡别的请求
            time.sleep(obj.pop("_delay"))
        if isinstance(obj, CsvBody):
            data = obj.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=\"usage.csv\"")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_json(status, obj)

    def api(self, method, path, query, body, u):
        parts = [p for p in path.split("/") if p][1:]  # 去掉 "api"
        if parts == ["me"] and method == "GET":
            return 200, {"email": u["email"], "sub": u["sub"], "quota": quota(u), "credits": credit_summary(u)}
        if parts == ["usage"] and method == "GET":
            d0, d1, a, b = usage_range(query)
            mine = [t for t in STATE["tasks"].values() if t["sub"] == u["sub"]]
            per_day = {}
            for t in mine:
                for c in t.get("calls") or []:
                    d = cn_day(c["at"])
                    if c["billable"] and d0 <= d <= d1:
                        per_day[d] = per_day.get(d, 0) + c["credits"]
            days = [{"date": (a + timedelta(days=i)).strftime("%Y-%m-%d"),
                     "credits": round(per_day.get((a + timedelta(days=i)).strftime("%Y-%m-%d"), 0), 2)} for i in range((b - a).days + 1)]
            tasks = [{"id": t["id"], "title": t["title"], "credits": task_credits(t, d0, d1), "createdAt": t["createdAt"], "status": t["status"]}
                     for t in mine if task_credits(t, d0, d1) > 0]
            tasks.sort(key=lambda x: -x["credits"])
            return 200, {"from": d0, "to": d1, "total": round(sum(per_day.values()), 2), "days": days, "tasks": tasks,
                         "month": credit_summary(u)}
        if parts == ["voices"] and method == "GET":
            return 200, {"items": VOICES}
        if parts == ["skills"] and method == "GET":
            return 200, {"items": SKILLS + [gen_skill(self.base, s) for s in GEN_SKILLS], "genres": GENRES + GEN_GENRES}
        if parts == ["uploads"] and method == "POST":
            if not isinstance(body, dict):
                bad("请求格式不对")
            fn, ct, size = body.get("filename"), body.get("contentType"), body.get("size")
            if not isinstance(fn, str) or not fn.strip() or len(fn) > 200:
                bad("文件名不对")
            if not isinstance(ct, str) or not ct:
                bad("文件类型不对")
            if not isinstance(size, int) or size <= 0:
                bad("文件是空的")
            # 两种用途：ref 参考资料，image 3D 任务的参考照片；传别的值按参考资料检查
            purpose = "image" if body.get("purpose") == "image" else "ref"
            ext = fn.rsplit(".", 1)[-1].lower() if "." in fn else ""
            if purpose == "image":
                if ext not in IMAGE_EXT:
                    raise ApiErr(400, "bad_type", "参考照片只支持 png、jpg、jpeg、webp 格式")
                if size > IMAGE_MAX_BYTES:
                    raise ApiErr(400, "too_large", "参考照片每张不能超过 10 MB")
            elif ext not in REF_EXT:
                raise ApiErr(400, "bad_type", "参考资料只支持 pdf、docx、md、txt、csv、xlsx 文件")
            elif size > REF_MAX_BYTES:
                raise ApiErr(400, "too_large", "参考资料每个文件不能超过 1 MB")
            uid = "u-" + uuid.uuid4().hex[:16]
            STATE["uploads"][uid] = {"sub": u["sub"], "filename": fn, "contentType": ct, "size": size, "uploaded": False,
                                     "purpose": purpose}
            return 200, {"uploadId": uid, "url": f"{self.base}/__upload/{uid}?X-Mock-Signature={secrets.token_hex(8)}",
                         "headers": {"Content-Type": ct}}
        if parts == ["tasks"] and method == "POST":
            req, uploads = validate_create(u, body)
            t = create_task(u, req)
            for up in uploads:  # 用过的参考资料文件自动进素材库
                lib_add_file(u, up["filename"], up["contentType"], up.get("data") or b"")
            start_turn(t, plan_first(t))
            return 201, {"id": t["id"]}
        if parts and parts[0] == "flows":
            return self.flows_api(method, parts[1:], body, u)
        if parts == ["library"] and method == "GET":
            kind = (query.get("kind") or [""])[0]
            return 200, {"items": library_items(u, kind, (query.get("q") or [""])[0], self.base)}
        if len(parts) == 3 and parts[0] == "library" and method in ("PATCH", "DELETE"):
            kind, item_id = parts[1], parts[2]
            x = lib_target(u, kind, item_id)
            if method == "DELETE":
                if kind in ("file", "image"):  # 文件和图片真正删除；用过它的任务各有一份副本
                    BLOBS.pop(x["blob"], None)
                    del lib_files(u)[item_id]
                else:  # 视频和 3D 图片只是从素材库移除，任务还在
                    x.setdefault("lib", {})["removed"] = True
                return 200, {"ok": True}
            patch = validate_lib_patch(body)
            if kind in ("file", "image"):
                if kind == "image" and "desc" in (body or {}):
                    d = re.sub(r"\s+", " ", str(body.get("desc") or "")).strip()
                    if not d:
                        bad("图片的描述不能为空：这是什么、想在片子里怎么用")
                    patch["desc"] = d[:200]
                x.update(patch, updatedAt=now_ms())
                return 200, (lib_image_item if kind == "image" else lib_file_item)(x, self.base)
            x.setdefault("lib", {}).update(patch, updatedAt=now_ms())
            return 200, lib_item(x, self.base)
        if parts == ["tasks"] and method == "GET":
            f = (query.get("status") or ["all"])[0]
            groups = {"all": None, "active": ("queued", "running", "awaiting_confirmation"), "done": ("completed",), "failed": ("failed",)}
            if f not in groups:
                bad("筛选条件不对，只能是 all、active、done 或 failed")
            mine = [t for t in STATE["tasks"].values() if t["sub"] == u["sub"] and (groups[f] is None or t["status"] in groups[f])]
            mine.sort(key=lambda t: t["updatedAt"], reverse=True)
            return 200, {"items": [list_item(t, self.base) for t in mine]}
        if len(parts) >= 2 and parts[0] == "tasks":
            t = STATE["tasks"].get(parts[1])
            if not t or t["sub"] != u["sub"]:
                raise ApiErr(404, "not_found", "没有找到这个任务，可能已被删除，或者不属于当前账号")
            if len(parts) == 2 and method == "GET":
                return 200, task_view(t, self.base)
            action = parts[2] if len(parts) == 3 else None
            m3d = t["product"] == "model3d"
            if action == "module" and method == "GET":
                vs = t["model"]["versions"] if m3d else []
                want = (query.get("v") or [""])[0]
                v = next((x for x in vs if str(x["n"]) == want), None) if want else (vs[-1] if vs else None)
                if not v:
                    raise ApiErr(404, "not_found", "没有这个版本的 3D 模型")
                return 200, {"code": model_js(v["params"]), "factory": MODEL_FACTORY}
            if action == "print" and method == "POST":
                return 200, make_print(t, body, self.base)
            if action == "usage" and method == "GET":
                if (query.get("format") or [""])[0] == "csv":
                    return 200, CsvBody(usage_csv(t))
                return 200, {"items": t.get("calls") or [], "total": task_credits(t)}
            if action in ("confirm", "messages", "retry", "av") and method == "POST":
                check_credit(u)
            if action == "av" and method == "POST":  # 工作流的音画节点：没出片时是确认分镜，出片以后是重跑
                if not t["request"].get("flow"):
                    raise ApiErr(400, "not_flow", "这个任务不是工作流模式建的")
                if t["status"] in ("queued", "running"):
                    raise ApiErr(409, "busy", "Agent 正在工作，等这一轮完成后再运行")
                if not t["versions"] and t["status"] != "awaiting_confirmation":
                    raise ApiErr(409, "bad_state", "文字节点还没写完分镜")
                edits = 0
                if body.get("storyboard") is not None:
                    scenes, edits = validate_storyboard_edit(t, body["storyboard"])
                    t["storyboard"]["scenes"] = scenes
                    t["script"]["paragraphs"] = [s["narration"] for s in scenes]
                changes, redraw = apply_flow_settings(t, body)
                note = str(body.get("note") or "").strip()
                if not t["versions"]:
                    say(t, "user", "text", "确认分镜，开始生成" + (f"：{note}" if note else ""), node="av")
                    t["flowNode"] = "av"
                    set_status(t, "queued", "排队中")
                    start_turn(t, plan_confirm(t, edits))
                    return 200, {"ok": True, "changes": changes}
                ch, rm = sb_changed(t)
                if ch or rm:
                    changes.insert(0, f"文字节点改了第 {'、'.join(str(int(x)) for x in ch + rm)} 镜")
                if not changes and not note:
                    raise ApiErr(400, "nothing_to_do", "成片已经是最新的，没有要重跑的改动")
                scenes = [s["id"] for s in t["storyboard"]["scenes"]]
                targets = scenes if redraw else [x for x in scenes if x in ch] or scenes[:1]
                say(t, "user", "text", "重跑音画" + (f"：{note}" if note else ""), node="av")
                set_status(t, "queued", "排队中")
                start_turn(t, plan_rerun(t, targets, changes))
                return 200, {"ok": True, "changes": changes}
            if action == "confirm" and method == "POST":
                if t["status"] != "awaiting_confirmation":
                    raise ApiErr(409, "bad_state", "只有在等待确认分镜时才能确认")
                edits = 0
                if isinstance(body, dict) and body.get("storyboard") is not None:
                    scenes, edits = validate_storyboard_edit(t, body["storyboard"])
                    t["storyboard"]["scenes"] = scenes
                    t["script"]["paragraphs"] = [s["narration"] for s in scenes]
                if t["request"].get("flow"):  # 工作流任务在生成页确认：算音画节点的
                    t["flowNode"] = "av"
                set_status(t, "queued", "排队中")
                start_turn(t, plan_confirm(t, edits))
                return 200, {"ok": True}
            if action == "messages" and method == "POST":
                if not isinstance(body, dict):
                    bad("请求格式不对")
                text, scope = str(body.get("text") or "").strip(), body.get("scope", "all")
                if not text:
                    bad("修改意见不能为空")
                if len(text) > 2000:
                    bad("修改意见太长了，最多 2000 字")
                if t["status"] in ("queued", "running"):
                    raise ApiErr(409, "busy", "Agent 正在工作，等这一轮完成后再发")
                node = body.get("node") or (("av" if t["versions"] else "text") if t["request"].get("flow") and not m3d else None)
                if node == "text":  # 工作流的文字节点：只改剧本和分镜
                    if not t["storyboard"]:
                        raise ApiErr(409, "bad_state", "文字节点还没写完分镜")
                    say(t, "user", "text", text, node="text")
                    set_status(t, "queued", "排队中")
                    start_turn(t, plan_text_revise(t, text, body.get("storyboard")))
                    return 200, {"ok": True}
                if node == "av":
                    if not t["versions"]:
                        raise ApiErr(409, "bad_state", "音画节点出片以后才能在这里修改")
                    t["flowNode"] = "av"
                if t["status"] == "awaiting_confirmation":
                    raise ApiErr(409, "bad_state", "先确认分镜，生成完成后再提修改")
                if t["status"] == "failed":
                    raise ApiErr(409, "bad_state", "任务失败了，先让 Agent 修复后重试")
                if scope != "all" and (m3d or scope not in {s["id"] for s in t["storyboard"]["scenes"]}):
                    bad("修改范围不对，请重新选择镜头")
                say(t, "user", "text", text, scope=scope)
                set_status(t, "queued", "排队中")
                start_turn(t, plan_model_revise(t, text) if m3d else plan_revise(t, text, scope))
                return 200, {"ok": True}
            if action == "retry" and method == "POST":
                if t["status"] != "failed":
                    raise ApiErr(409, "bad_state", "只有失败的任务可以重试")
                t["failure"] = None
                step(t, "review" if m3d else "render", "pending", "")
                set_status(t, "queued", "排队中")
                start_turn(t, plan_model_retry(t) if m3d else plan_retry(t))
                return 200, {"ok": True}
        raise ApiErr(404, "not_found", "接口不存在")


def main():
    global ARGS, MEDIA_DIR, FONT
    ap = argparse.ArgumentParser(description="Slate 前端本地 mock 服务器（只用于本地开发）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--speed", type=float, default=1.0, help="任务推进速度倍数")
    ap.add_argument("--latency", type=float, default=0.05, help="每个接口额外的延迟（秒）")
    ap.add_argument("--upload-kbps", type=int, default=3072, help="上传限速（KB/秒），方便看到进度")
    ap.add_argument("--url-ttl", type=int, default=3600, help="媒体链接有效期（秒）")
    ap.add_argument("--no-seed", dest="seed", action="store_false", help="不预置示例任务")
    ap.add_argument("--credit-quota", type=float, default=1000, help="每月 Credit 额度")
    ap.add_argument("--credit-used", type=float, default=0, help="本月已用额外加上这么多 Credit（测 80%% / 100%% 提示）")
    ap.add_argument("--verbose", action="store_true")
    ARGS = ap.parse_args()

    MEDIA_DIR = Path(tempfile.mkdtemp(prefix="slate-mock-media-"))
    atexit.register(shutil.rmtree, MEDIA_DIR, True)
    font = find_font()
    if font:
        # 复制到临时目录，避免字体路径里的方括号等字符在 ffmpeg 滤镜参数里出问题
        FONT = str(MEDIA_DIR / ("font" + Path(font).suffix))
        shutil.copyfile(font, FONT)
    mimetypes.add_type("text/javascript", ".js")

    threading.Thread(target=ticker, daemon=True).start()
    httpd = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    httpd.daemon_threads = True
    print(f"Slate mock 服务器：http://{ARGS.host}:{ARGS.port}/  （静态文件目录 {WEB_ROOT}）", flush=True)
    if not FFMPEG:
        print("提示：没有找到 ffmpeg，视频链接会留空", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
