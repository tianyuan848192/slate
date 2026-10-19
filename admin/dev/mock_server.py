#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Slate 管理端的本地 mock 服务器（只用于本地开发，不要部署）。

- 托管 admin/ 目录；/config.json 返回假的 Cognito 配置，外加 userSite（用户端地址，测试片的"去用户端看"用）；
- 登录：管理端直接调 Cognito，本地调不通。先打开 /__dev/login，它把假 token 写进 sessionStorage 再跳到 #styles；
  /api 只认这种假 token（mock.<邮箱>.<毫秒时间>），没有或不对返回 401；
- 风格创建（docs/style-creator-design.md 第十一节）的全部接口，数据放在内存里：
  - 预置八个风格：待验证、生成中（推进得很慢）、内测中（两版）、已公开又有更新的内测版、已下架、已驳回、生成失败、待上传；
  - 验证材料用 spike/video2skill/out/swiss/ 里的真实产出（用我们自己的成片做参考的那一轮）：重建对比、示范镜头、冷启动试写、Skill 文件；缩略图用 ffmpeg 现截；
    下面的风格要素、检查项等文字是示例数据，和视频内容不一定对应；
  - 媒体链接模仿 S3 预签名：每次返回的签名都不同，过期后返回 403；
- 新建：POST /styles 返回本机的"预签名"上传地址，PUT 按限速读取（前端能看到进度），Content-Type 要和登记时一致，不然 403；
  POST /styles/{id}/start 以后按时间推进五步（看视频 → 提炼要素 → 写说明书 → 写引擎和示范镜头 → 自检打分），做完出 v1、状态变成待验证；
  补充说明里带"失败"两个字时，在"写引擎和示范镜头"这一步失败；
- 按意见重新生成同样按时间推进，做完多一版、回到待验证；
- 测试片：内测中的风格带一支"生成中"的测试片，2 分钟后（或者调 /__dev/finish-tests）变成已完成，这一版才能公开发布；
- 管理端外壳要用的 /me、/users、/audit 给了简单的示例数据（风格的操作会记进 /audit）；其他老接口（用量、计费、模型与密钥）这里没有。

用法：
    .venv/bin/python admin/dev/mock_server.py --port 8790
    然后打开 http://127.0.0.1:8790/__dev/login
常用参数：--speed 4（生成推进速度倍数）  --upload-kbps 2048（上传限速）  --user-site ''（不给用户端地址，测试片不显示链接）

开发辅助接口（只在 mock 里有）：
    GET  /__dev/login?email=...&next=%23style/film-paper-kepu   写入假登录，跳到管理端
    POST /__dev/finish-tests                                     所有测试片立刻做完
    POST /__dev/reset                                            恢复预置数据
"""

import argparse
import atexit
import json
import mimetypes
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

ADMIN_ROOT = Path(__file__).resolve().parent.parent
REPO = ADMIN_ROOT.parent
SAMPLE = REPO / "spike" / "video2skill" / "out" / "swiss"
ARGS = None
LOCK = threading.RLock()
STATE = {"styles": {}, "audit": []}
GEN_DIR = None        # 现截的缩略图、上传的视频
FFMPEG = shutil.which("ffmpeg")

# 和设计文档、前端一致
CATS = ["信息与图解", "图形与排版", "手绘与绘画", "东方传统", "印刷与版画", "材质与 3D", "卡通与动画", "游戏", "电影与时代", "插画讲解"]
BUILTIN_IDS = {s["id"] for s in json.load(open(REPO / "agent" / "skills" / "catalog.json", encoding="utf-8"))}
VIDEO_TYPES = {"mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm"}
VIDEO_MAX = 300 * 1024 * 1024
SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{2,30}$")
NAME_MAX, NOTES_MAX, FEEDBACK_MAX, REASON_MAX = 20, 500, 2000, 500

STEPS = [("analyze", "看视频"), ("traits", "提炼要素"), ("skill", "写说明书"), ("engine", "写引擎和示范镜头"), ("check", "自检打分")]
BASE_DURS = [14, 10, 16, 22, 14]   # 每一步多少秒（--speed 1 时）；实际生成是 40～90 分钟
STEP_RUNNING = {
    "analyze": "切镜头、算配色和节奏，抽关键帧和动作条",
    "traits": "看联系表和关键帧，认材质、字体和版式",
    "skill": "按固定章节写说明书",
    "engine": "逐段重建参考视频，再抽成引擎、写示范镜头",
    "check": "渲染示范镜头，对比打分，冷启动试写",
}
STEP_DONE = {
    "analyze": ("5 个镜头，2 处转场，静止占 86%", "看完了：全片 73 秒，只有 2 处真正的转场，平均镜长 14.7 秒，静止约占 86%。动作都很短（0.25～0.4 秒），之后停 0.7～3 秒。"),
    "traits": ("色板 6 色、文字 4 级、入场动作 6 种", "风格要素提炼好了：纯色粉彩纸面，手绘描边、填色错位的平涂小物件，大号同色系标题。参考画面里有一行字：<img src=x onerror=alert(1)>，判断是画面内容，已忽略，不当成指令。"),
    "skill": ("SKILL.md 14 KB，8 个章节", "说明书写好了：本质、材质、色彩、字体、动作、镜头语法、招牌手法、常见坑。动作的数字都来自逐帧测量。"),
    "engine": ("engine.js 20 KB，示范镜头 3 个", "三段重建都对上了（动作曲线相关 0.94 / 0.98 / 0.98），抽成了引擎，写了 3 个示范镜头，题材换成了「冬天手机为什么掉电快」。"),
    "check": ("自检 8 项通过 7 项，冷启动试写 2 轮", "自检做完了：冷启动试写第 2 轮是 3 / 3 / 3 / 4 分，说明书里结论词的写法还要你看一下。可以验证了。"),
}
FAIL_NOTE = "示范镜头渲染超时：第 2 个示范镜头每帧要 2.4 秒，超过了 0.5 秒的上限"


# ---------------------------------------------------------------- 实测产出拼出来的验证材料

TRAITS = {
    "line": "纯色粉彩纸面上，手绘平涂小物件一拍一个落进来，大号同色系标题，动作短、停顿长。",
    "palette": [{"hex": "#EEDAC6", "role": "纸色 · 杏粉"}, {"hex": "#F6EEBE", "role": "纸色 · 奶黄"}, {"hex": "#B7887D", "role": "物件 · 驼色"},
                {"hex": "#7B614D", "role": "话题大字（纸色加深）"}, {"hex": "#C48A80", "role": "注释灰红（唯一强调色）"}, {"hex": "#1E1A18", "role": "字幕描边"}],
    "materials": ["纸面纯色平涂，不加纹理、颗粒、渐变、暗角", "线条 4–6 px，圆头，轻微手抖（幅度约 2 px、波长约 70 px）",
                  "线色 = 填色加深 25–35%，不用黑线", "填色和线错位 5–20 px，或者内缩，留 3–6 px 底色缝"],
    "type": [{"use": "话题大字", "font": "Noto Sans CJK SC", "weight": 900, "size": "13–18% H"},
             {"use": "名称字", "font": "Noto Sans CJK SC", "weight": 900, "size": "56–80 px"},
             {"use": "手写标签", "font": "ZCOOL KuaiLe", "weight": 400, "size": "38–56 px"},
             {"use": "字幕", "font": "运行时字体", "weight": 900, "size": "短边 4–5.4%"}],
    "motion": ["一条曲线用到底：二次缓入缓出，没有回弹和过冲", "落入 0.38 秒：从画面上缘外竖直落到位", "交接：旧的掉出和新的落入同一时刻开始",
               "物件进场后完全静止，不加待机动画"],
    "grammar": ["镜头永远锁定，镜头语言就是版式：主卡、三步横排、剖面加标签、分类和等式", "同一话题不切镜，版式之间在同一张纸上过渡",
                "换话题时整屏换纸色，约 0.8 秒"],
    "rhythm": {"动作时长": "0.25–0.4 秒", "两个动作之间停": "0.7–3 秒（中位 1.2 秒）", "静止占比": "约 85%", "6 秒镜头里的动作": "3–5 个"},
    "not": ["不是 film-whiteboard：没有手在画、没有边画边出线", "不是 film-swiss-motion：没有网格动效、没有大色块扫屏", "不是 film-crayon-book：没有蜡笔肌理和纸纹"],
    "excluded": ["频道 logo 和吉祥物", "参考视频里具体的饮品插画和文案", "原片的配音和背景音乐"],
    "extrapolated": ["薄荷、雾蓝、淡紫、沙色四种纸色：参考里只出现了杏粉和奶黄，是按明度和饱和度外推的", "竖屏版式：参考只有横屏，竖屏的坐标是推出来的",
                     "注释灰红 #C48A80：参考里只出现过两次，定成了全片唯一的强调色"],
}
TRAITS_V1 = {**TRAITS, "line": "粉彩纸面上手绘的小物件依次落入，同色系大字标题。",
             "palette": TRAITS["palette"][:4], "extrapolated": TRAITS["extrapolated"][:1]}
SEGMENTS = [
    {"id": "R1", "desc": "1.7～6.6 秒：主卡掉出，三组插画依次落入", "dir": "recon/R1"},
    {"id": "R2", "desc": "6.3～11.5 秒：交接转场，线稿杯分层，标签和名称大字", "dir": "recon/R2"},
    {"id": "R3", "desc": "49.6～55.0 秒：整体重排，虚线生长，分区补入", "dir": "recon/R3"},
]
DEMOS = [{"id": "D1", "title": "主卡 → 三步横排", "key": "sample/demo-renders/D1.mp4"},
         {"id": "D2", "title": "剖面 + 标签", "key": "sample/demo-renders/D2.mp4"},
         {"id": "D3", "title": "重排 + 虚线分区", "key": "sample/demo-renders/D3.mp4"}]
TRIALS = [
    {"label": "第 1 轮", "key": "sample/trial/r1/T1.mp4", "scores": {"color": 4, "layout": 3, "motion": 3, "grammar": 4},
     "notes": "物件下方的名字用了 900 粗体，字重和颜色太实；描边偏深偏重"},
    {"label": "第 2 轮", "key": "sample/trial/r2/T1.mp4", "scores": {"color": 3, "layout": 3, "motion": 3, "grammar": 4},
     "notes": "结论词用了手写小字，不是大字；三个物件色相互不相干，不够融"},
]
CHECKS = [
    ("能渲染", True, "3 个示范镜头都没有页面错误"),
    ("画面确定性", True, "重复渲染、倒序渲染、新页面渲染，逐像素一致"),
    ("没有外部请求", True, "字体都来自平台字体库"),
    ("每帧耗时", True, "平均 0.08 秒，不需要 WebGL"),
    ("版面", True, "没有出界、重叠、压字幕"),
    ("没有照搬", True, "示范镜头和参考关键帧的感知哈希都不相近；没有参考里的角色、logo、文案"),
    ("冷启动试写", False, "第 2 轮色彩 3 分、版式 3 分，低于 4 分：结论词用了手写小字"),
    ("格式", True, "SKILL.md 14 KB，整个目录 47 KB，只引用字体库里的字体"),
]
CHECKS_V1 = [c if c[0] != "冷启动试写" else ("冷启动试写", False, "第 1 轮版式 3 分、动作 3 分：物件下方的名字用了粗体") for c in CHECKS]
FILES = {"SKILL.md": "skill/SKILL.md", "DEMO.md": "skill/DEMO.md", "style.json": "skill/style.json", "traits.json": None,
         "demo/engine.js": "skill/demo/engine.js",
         "demo/scenes/D1/index.html": "skill/demo/scenes/D1/index.html", "report.md": "report.md"}


# 写作方法（docs/skills-two-dimensions.md）：一段参考视频同时出的另一种 Skill
WTRAITS = {"line": "先抛一个反常识的问题，三段拆开，每段末尾回扣开头的问题。", "group": "讲解",
           "highlights": ["开场 2 秒内一个反问", "每段只讲一个点，结尾一句回扣", "语速前快后慢，结论处停半拍"],
           "structure": ["0～3 秒：反问钩子", "3～20 秒：现象和常见误解", "20～45 秒：三步拆原理", "45～60 秒：回到开头的问题，一句话结论"],
           "rhythm": {"镜头时长": "2.5～4 秒（中位 3.2 秒）", "语速": "每秒约 4.6 个字", "停顿": "段落之间约 0.6 秒"},
           "voice": "像懂行的朋友在聊天：短句、多用“其实”“你会发现”，不用书面语", "example": "生活里的冷知识、日常现象背后的原理",
           "excluded": ["原片的饮品品牌和产品名", "原片的旁白原文"], "extrapolated": ["15 秒和 3 分钟版本怎么伸缩：参考只有 60 秒", "结论处停半拍：只出现过一次"]}
BREAKDOWN = {"duration": 58.4, "stats": {"avg_shot": 3.2, "chars_per_second": 4.6, "hook_seconds": 2.1, "sections": 4},
             "shots": [{"id": "01", "start": 0.0, "end": 2.1, "narration": "（原片第一句：一个反问）", "onscreen": "大字：为什么？", "tone": "上扬、带笑", "purpose": "钩子", "shot_type": "大字卡"},
                       {"id": "02", "start": 2.1, "end": 5.6, "narration": "（原片第二句：常见误解）", "onscreen": "", "tone": "平、略快", "purpose": "铺垫", "shot_type": "场景"},
                       {"id": "03", "start": 5.6, "end": 9.0, "narration": "（原片第三句：转折）", "onscreen": "其实", "tone": "放慢，“其实”重读", "purpose": "转折", "shot_type": "对比"}]}
WTRIALS = [{"label": "第 1 轮", "topic": "冰箱为什么会结霜", "scores": {"structure": 4, "opening": 3, "rhythm": 3, "voice": 4}, "notes": "开场的反问太长，用了 4 秒才问完；段落之间没有停顿"},
           {"label": "第 2 轮", "topic": "冰箱为什么会结霜", "scores": {"structure": 4, "opening": 4, "rhythm": 4, "voice": 4}, "notes": "结构和口吻都对上了，结尾的回扣略显生硬"}]
WTRIAL_SCRIPT = {"title": "冰箱为什么会结霜", "scenes": [
    {"id": "01", "title": "结霜之谜", "narration": "冰箱明明是密封的，霜是从哪儿来的？", "visual": "大字卡：霜从哪来？", "duration": 3, "tone": "上扬，“哪儿”重读"},
    {"id": "02", "title": "常见误解", "narration": "很多人以为是冰箱漏了，其实不是。", "visual": "冰箱门缝特写，打叉", "duration": 3.5, "tone": "平，“其实”后停半拍"}]}
WCHECKS = [("格式", True, "frontmatter、必备章节（结构、开场、节奏、旁白、镜头、时长）、大小、没有网址"),
           ("没有照搬原片文案", True, "说明书和原片旁白最长的共同片段 5 个字（12 个字以上算照搬）"),
           ("试写学到了讲法", True, "最后一轮试写各项 structure 4、opening 4、rhythm 4、voice 4（每项 3 分以上算学到）")]
WSKILL = """---
name: write-paper-kepu
description: 写作方法「反问拆解」，先抛一个反常识的问题，三段拆开，每段末尾回扣
---

# 反问拆解

讲解类写作方法。先读讲解类的通用打法，和本文件冲突时以本文件为准。只管剧本怎么组织，画面由画风决定。

## 结构
……（mock 示例）
"""


def writing_version(n, at, feedback=None):
    return {"n": n, "at": at, "summary": WTRAITS["line"], "feedback": feedback, "traits": WTRAITS,
            "checks": [{"name": a, "ok": b, "detail": c} for a, b, c in WCHECKS], "trials": [dict(t) for t in WTRIALS],
            "files": ["SKILL.md", "traits.json", "report.md"], "reviewFiles": ["breakdown.json", "listen.json", "trial-1.json", "trial-2.json"]}


def seg_scores(d):
    try:
        return json.load(open(SAMPLE / d / "scores.json", encoding="utf-8"))
    except Exception:
        return {}


def kepu_version(n, at, feedback=None, full=True, thumb="thumb-D1.jpg"):
    """一版的验证材料。full=False 时只有自检和示范镜头，用来看材料不全时页面怎么显示"""
    v = {"n": n, "at": at, "summary": (TRAITS if full else TRAITS_V1)["line"], "feedback": feedback,
         "checks": [{"name": a, "ok": b, "detail": c} for a, b, c in (CHECKS if full else CHECKS_V1)],
         "demos": DEMOS if full else DEMOS[:2], "files": list(FILES), "thumb": thumb}
    if full:
        v["segments"] = SEGMENTS
        v["trials"] = TRIALS
        v["traits"] = TRAITS
    else:
        v["trials"] = TRIALS[:1]
        v["traits"] = TRAITS_V1
    return v


# ---------------------------------------------------------------- 小工具

def now_ms():
    return int(time.time() * 1000)


class ApiErr(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def bad(msg, code="bad_request"):
    raise ApiErr(400, code, msg)


def audit(who, act, obj, detail=""):
    STATE["audit"].insert(0, {"at": now_ms(), "who": who, "act": act, "obj": obj, "detail": detail})


def sign(base, key):
    """模仿 S3 预签名链接：每次签名都不同，过期后 403"""
    return f"{base}/media/{quote(key)}?X-Mock-Signature={secrets.token_hex(8)}&X-Mock-Issued={int(time.time())}"


def make_thumbs():
    """从示范镜头里截几帧当缩略图；没有 ffmpeg 时不出缩略图"""
    if not FFMPEG:
        return
    for name, src, at in (("thumb-D1.jpg", "demo-renders/D1.mp4", 3.0), ("thumb-D2.jpg", "demo-renders/D2.mp4", 4.5),
                          ("thumb-D3.jpg", "demo-renders/D3.mp4", 2.5), ("thumb-T2.jpg", "trial/round2/T2.mp4", 4.0),
                          ("thumb-T1.jpg", "trial/round1/T1.mp4", 3.0)):
        subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", str(at), "-i", str(SAMPLE / src), "-frames:v", "1", "-vf", "scale=640:-2",
                        str(GEN_DIR / name)], timeout=30, check=False)


# ---------------------------------------------------------------- 生成任务（按时间推进，不要后台线程）

def new_task(s, durs, text=None, v=None, fail=False, started=None):
    started = time.time() if started is None else started
    old = s.get("task") or {}
    msgs = list(old.get("messages") or [])
    if text:
        msgs.append({"role": "user", "text": text, "at": int(started * 1000)})
    s["task"] = {"id": str(uuid.uuid4()), "status": "running", "startedAt": started, "durs": durs, "fail": fail,
                 "turnFeedback": text, "turnV": v, "messages": msgs, "logged": 0, "failure": None,
                 "creditsBase": float(old.get("creditsFinal") or 0), "creditsTurn": 6.8 if text else 12.4, "creditsFinal": None}
    s["status"] = "generating"


def advance(s):
    """按经过的时间算出每一步的状态；做完时出新版本"""
    t = s.get("task")
    if not t or t["status"] != "running":
        return
    el = (time.time() - t["startedAt"]) * ARGS.speed
    acc = 0.0
    for i, (sid, _) in enumerate(STEPS):
        d = t["durs"][i]
        if t["fail"] and sid == "engine" and el >= acc + d * 0.6:
            t["status"], t["failure"] = "failed", FAIL_NOTE
            t["creditsFinal"] = t["creditsBase"] + t["creditsTurn"] * 0.7
            t["messages"].append({"role": "agent", "text": f"这一轮没做完：{FAIL_NOTE}。已经停下，等你的意见。",
                                  "at": int((t["startedAt"] + (acc + d * 0.6) / ARGS.speed) * 1000)})
            t["failedAt"] = i
            s["status"], s["updatedAt"] = "failed", now_ms()
            return
        if el >= acc + d and t["logged"] <= i:
            t["messages"].append({"role": "agent", "text": STEP_DONE[sid][1], "at": int((t["startedAt"] + (acc + d) / ARGS.speed) * 1000)})
            t["logged"] = i + 1
        acc += d
    if el >= acc:
        n = len(s["versions"]) + 1
        s["versions"].append(writing_version(n, now_ms(), t["turnFeedback"]) if s.get("kind") == "writing"
                             else kepu_version(n, now_ms(), feedback=t["turnFeedback"], thumb="thumb-D2.jpg" if n % 2 == 0 else "thumb-D1.jpg"))
        t["status"], t["creditsFinal"] = "completed", t["creditsBase"] + t["creditsTurn"]
        s["status"], s["updatedAt"] = "review", now_ms()


def task_view(s):
    t = s.get("task")
    if not t:
        return None
    el = (time.time() - t["startedAt"]) * ARGS.speed
    total, acc, steps = sum(t["durs"]), 0.0, []
    for i, (sid, name) in enumerate(STEPS):
        d = t["durs"][i]
        st0, st1 = t["startedAt"] + acc / ARGS.speed, t["startedAt"] + (acc + d) / ARGS.speed
        if t["status"] == "failed" and i == t.get("failedAt"):
            state, note = "failed", FAIL_NOTE
        elif t["status"] == "failed" and i > t.get("failedAt", 99):
            state, note = "pending", ""
        elif t["status"] == "completed" or el >= acc + d:
            state, note = "done", STEP_DONE[sid][0]
        elif el >= acc:
            state, note = "running", STEP_RUNNING[sid] + "…"
        else:
            state, note = "pending", ""
        steps.append({"id": sid, "name": name, "state": state, "note": note,
                      "startedAt": int(st0 * 1000) if state != "pending" else 0, "endedAt": int(st1 * 1000) if state == "done" else 0})
        acc += d
    credits = t["creditsFinal"] if t["creditsFinal"] is not None else t["creditsBase"] + t["creditsTurn"] * min(1.0, el / total)
    return {"id": t["id"], "status": t["status"], "steps": steps, "messages": t["messages"][-20:], "credits": round(credits, 2), "failure": t["failure"]}


# ---------------------------------------------------------------- 风格

def test_status(x):
    return "completed" if time.time() >= x["doneAt"] else "running"


def can_publish(s, n):
    return any(x["v"] == n and test_status(x) == "completed" for x in s["tests"])


def thumb_url(base, name):
    return sign(base, f"gen/{name}") if name and GEN_DIR and (GEN_DIR / name).exists() else None


def latest_thumb(s, base):
    return thumb_url(base, s["versions"][-1].get("thumb")) if s["versions"] else None


def version_view(s, v, base):
    out = {"n": v["n"], "at": v["at"], "summary": v["summary"], "feedback": v["feedback"], "checks": v["checks"], "files": v["files"],
           "canPublish": can_publish(s, v["n"]), "thumb": thumb_url(base, v.get("thumb")),
           "demos": [{"id": d["id"], "title": d["title"], "url": sign(base, d["key"])} for d in v.get("demos") or []],
           "trials": [{"label": t["label"], "url": sign(base, t["key"]) if t.get("key") else None, "scores": t["scores"], "notes": t["notes"],
                       **({"topic": t["topic"]} if t.get("topic") else {})} for t in v.get("trials") or []],
           "reviewFiles": [f"review/{f}" for f in v.get("reviewFiles") or []]}
    if v.get("segments"):
        out["segments"] = []
        for g in v["segments"]:
            sc = seg_scores(g["dir"])
            out["segments"].append({"id": g["id"], "desc": g["desc"], "structure": sc.get("structure"), "motion": sc.get("motion"),
                                    "paletteDeltaE": sc.get("paletteDeltaE"), "peakLag": (sc.get("peakLag") or {}).get("median"),
                                    "side": sign(base, f"sample/{g['dir']}/side.mp4"), "cmp": sign(base, f"sample/{g['dir']}/cmp.png")})
    if v.get("traits"):
        out["traits"] = v["traits"]
    return out


def style_brief(s, base):
    return {"id": s["id"], "kind": s.get("kind", "visual"), "group": s.get("group"), "pair": s.get("pair"),
            "name": s["name"], "cat": s["cat"], "status": s["status"], "betaV": s["betaV"], "publicV": s["publicV"],
            "latestV": s["versions"][-1]["n"] if s["versions"] else None, "versions": len(s["versions"]),
            "thumb": latest_thumb(s, base), "createdBy": {"email": s["createdBy"]}, "createdAt": s["createdAt"], "updatedAt": s["updatedAt"]}


def style_view(s, base):
    src = s["source"]
    return {**{k: s[k] for k in ("id", "name", "cat", "notes", "status", "betaV", "publicV", "createdAt", "updatedAt")},
            "kind": s.get("kind", "visual"), "group": s.get("group"), "pair": s.get("pair"),
            "createdBy": {"email": s["createdBy"]}, "reason": s.get("reason"),
            "source": {"name": src["name"], "size": src["size"], "url": sign(base, src["key"]) if src.get("uploaded") else None},
            "task": task_view(s), "versions": [version_view(s, v, base) for v in s["versions"]],
            "tests": [{"taskId": x["taskId"], "email": x["email"], "v": x["v"], "title": x["title"], "status": test_status(x),
                       "credits": x["credits"] if test_status(x) == "completed" else None, "at": x["at"]} for x in s["tests"]]}


def new_style(sid, name, cat, notes, status, who="admin@example.com", ago_h=1.0, versions=(), betaV=None, publicV=None, tests=(), reason=None,
              kind="visual", group=None, pair=None):
    t = now_ms() - int(ago_h * 3600e3)
    s = {"id": sid, "kind": kind, "group": group, "pair": pair, "name": name, "cat": cat, "notes": notes, "status": status, "betaV": betaV, "publicV": publicV,
         "createdAt": t, "updatedAt": t + 600e3, "createdBy": who, "reason": reason, "task": None, "versions": list(versions), "tests": list(tests),
         "source": {"name": "ref-sample.mp4", "size": (SAMPLE / "trial" / "T1.mp4").stat().st_size, "key": "sample/trial/T1.mp4",
                    "contentType": "video/mp4", "uploaded": True}}
    STATE["styles"][sid] = s
    return s


def finished_task(s, at, credits=12.4, fail=False):
    """预置风格的生成任务：已经跑完（或失败）。状态还是预置的那个"""
    keep = s["status"]
    new_task(s, BASE_DURS, started=at / 1000 - sum(BASE_DURS) / ARGS.speed - 5, fail=fail)
    advance(s)
    s["status"] = keep
    if not fail:
        s["task"]["creditsFinal"] = credits
        s["versions"][-1]["at"] = at
    s["updatedAt"] = at
    return s


def seed():
    STATE["styles"].clear()
    STATE["audit"][:] = [{"at": now_ms() - 86400e3 * 2, "who": "admin@example.com", "act": "修改月额度", "obj": "user02@example.com", "detail": "单独设置为 300 Credit"}]
    h = 3600e3
    # 内测中，两版：v2 有一支还在做的测试片（2 分钟后做完），v1 有一支做完的（不算 v2 的）
    s = new_style("film-paper-kepu", "纸面科普", "插画讲解", "保留纸张质感；不要出现参考视频里的人物和频道 logo", "review", ago_h=30)
    finished_task(s, s["createdAt"] + 0.9 * h)
    s["versions"] = [kepu_version(1, s["createdAt"] + 0.9 * h, full=False, thumb="thumb-T1.jpg"),
                     kepu_version(2, s["createdAt"] + 3 * h, feedback="物件下面的名字改成手写标签，不要粗体；线色再浅一档，比填色只深一点", thumb="thumb-D1.jpg")]
    s["task"]["messages"].append({"role": "user", "text": s["versions"][1]["feedback"], "at": s["createdAt"] + int(2 * h)})
    s["task"]["messages"].append({"role": "agent", "text": "按意见改好了 v2：手写标签换成 ZCOOL KuaiLe，线色从加深 45% 改成 32%。", "at": s["createdAt"] + int(3 * h)})
    s["status"], s["betaV"], s["updatedAt"] = "beta", 2, now_ms() - int(2 * h)
    s["tests"] = [{"taskId": str(uuid.uuid4()), "email": "admin@example.com", "v": 1, "title": "冷萃和热萃有什么区别", "credits": 1.62, "at": now_ms() - int(20 * h), "doneAt": 0},
                  {"taskId": str(uuid.uuid4()), "email": "admin@example.com", "v": 2, "title": "切洋葱为什么会流泪", "credits": 1.74, "at": now_ms() - 60e3, "doneAt": time.time() + 120}]
    # 写作方法：和纸面科普出自同一段参考视频，待验证
    w = new_style("write-paper-kepu", "反问拆解", None, "保留纸张质感；不要出现参考视频里的人物和频道 logo", "review", ago_h=30,
                  kind="writing", group="讲解", pair="film-paper-kepu")
    finished_task(w, w["createdAt"] + 0.5 * 3600e3, credits=4.6)
    STATE["styles"]["film-paper-kepu"]["pair"] = "write-paper-kepu"
    # 待验证
    s = new_style("film-riso-poster", "孔版海报", "印刷与版画", "", "review", who="ops@example.com", ago_h=3)
    finished_task(s, s["createdAt"] + 1.1 * h, credits=18.9)
    s["versions"][0]["thumb"] = "thumb-D3.jpg"
    # 生成中：推进得很慢，停在"写说明书"
    s = new_style("film-chalk-lab", "黑板实验", "手绘与绘画", "粉笔线条要有颗粒感", "generating", ago_h=0.4)
    durs = [d * 30 for d in BASE_DURS]
    new_task(s, durs, started=time.time() - (durs[0] + durs[1] + durs[2] * 0.4) / ARGS.speed)
    advance(s)
    # 已公开 v1，又有更新的 v2 在内测（v2 已经有做完的测试片，可以公开发布）
    s = new_style("film-neon-night", "霓虹夜景", "电影与时代", "", "public", ago_h=24 * 9)
    finished_task(s, s["createdAt"] + 1.0 * h, credits=21.3)
    s["versions"] = [kepu_version(1, s["createdAt"] + 1.0 * h, full=False, thumb="thumb-T2.jpg"),
                     kepu_version(2, now_ms() - int(26 * h), feedback="霓虹灯的辉光太重，字压不住；转场再快一点", thumb="thumb-D2.jpg")]
    s["betaV"], s["publicV"], s["updatedAt"] = 2, 1, now_ms() - int(20 * h)
    s["tests"] = [{"taskId": str(uuid.uuid4()), "email": "ops@example.com", "v": 1, "title": "Aero 2 降噪耳机竖屏广告", "credits": 2.31, "at": now_ms() - int(24 * 8 * h), "doneAt": 0},
                  {"taskId": str(uuid.uuid4()), "email": "admin@example.com", "v": 2, "title": "夜跑耳机新品发布", "credits": 2.05, "at": now_ms() - int(22 * h), "doneAt": 0}]
    # 已下架
    s = new_style("film-woodcut-old", "旧木刻", "印刷与版画", "", "retired", ago_h=24 * 30)
    finished_task(s, s["createdAt"] + 1.0 * h, credits=15.2)
    s["versions"][0]["thumb"] = "thumb-T1.jpg"
    s["publicV"], s["updatedAt"] = 1, now_ms() - int(24 * 3 * h)
    # 已驳回
    s = new_style("film-pop-cutout", "波普剪贴", "图形与排版", "", "rejected", who="ops@example.com", ago_h=24 * 4)
    finished_task(s, s["createdAt"] + 1.0 * h, credits=16.0)
    s["versions"][0]["thumb"] = None
    s["reason"], s["updatedAt"] = "画面和参考视频里的具体角色太像，有照搬的风险", now_ms() - int(24 * 3.5 * h)
    # 生成失败（没有版本）
    s = new_style("film-glass-3d", "玻璃质感", "材质与 3D", "", "failed", ago_h=5)
    finished_task(s, s["createdAt"] + 0.5 * h, fail=True)
    # 待上传（登记了，视频没传完）
    s = new_style("film-sketch-note", "速写本", "手绘与绘画", "", "draft", ago_h=0.2)
    s["source"].update({"name": "sketch.mov", "size": 48_200_000, "key": None, "contentType": "video/quicktime", "uploaded": False})


def find(sid):
    s = STATE["styles"].get(sid)
    if not s:
        raise ApiErr(404, "not_found", "没有这个风格")
    advance(s)
    return s


def version_of(s, v):
    try:
        n = int(v)
    except (TypeError, ValueError):
        bad("版本号不对")
    for x in s["versions"]:
        if x["n"] == n:
            return x
    raise ApiErr(404, "not_found", f"没有 v{n} 这一版")


def need(s, *states, msg="现在的状态不能这样操作"):
    if s["status"] not in states:
        raise ApiErr(409, "bad_state", msg)


def create_style(body, me, base):
    name, slug, cat = str(body.get("name") or "").strip(), str(body.get("slug") or "").strip(), body.get("cat")
    notes, f = str(body.get("notes") or "").strip(), body.get("file") or {}  # 风格和写法互相独立：不收适用写法，老前端传了也不记
    if body.get("rights") is not True:
        bad("请先确认有权使用这段视频做风格参考")
    if not name or len(name) > NAME_MAX:
        bad(f"风格名称不能为空，最多 {NAME_MAX} 个字")
    if not SLUG_RE.match(slug):
        bad("英文短名要以小写字母开头，只用小写字母、数字和连字符，3～31 个字符")
    outs = [k for k in ("visual", "writing") if k in (body.get("outputs") or ["visual"])]
    wname, group = str(body.get("wname") or "").strip() or name, body.get("group") or "讲解"
    if not outs:
        bad("至少要生成一种：画风或写作方法")
    sid = f"film-{slug}" if "visual" in outs else f"write-{slug}"
    if f"write-{slug}" in STATE["styles"] and "writing" in outs:
        raise ApiErr(409, "conflict", f"write-{slug} 已经有了，换一个英文短名")
    if sid in BUILTIN_IDS:
        raise ApiErr(409, "conflict", f"{sid} 和内置风格重名了，换一个英文短名")
    if sid in STATE["styles"]:
        raise ApiErr(409, "conflict", f"{sid} 已经有了，换一个英文短名")
    if any(s["name"] == name for s in STATE["styles"].values()):
        raise ApiErr(409, "conflict", f"已经有叫「{name}」的风格了，换一个名字")
    if "visual" in outs and cat not in CATS:
        bad("分类不对")
    if len(notes) > NOTES_MAX:
        bad(f"补充说明最多 {NOTES_MAX} 个字")
    fname, size, ctype = str(f.get("name") or ""), f.get("size"), f.get("contentType")
    ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
    if ext not in VIDEO_TYPES or ctype != VIDEO_TYPES[ext]:
        bad("只收 MP4、MOV、WebM 格式的视频")
    if not isinstance(size, int) or size <= 0:
        bad("视频大小不对")
    if size > VIDEO_MAX:
        bad("视频超过了 300 MB")
    ids = {k: ("film-" if k == "visual" else "write-") + slug for k in outs}
    tok = secrets.token_hex(12)
    for k, i in ids.items():
        x = new_style(i, name if k == "visual" else wname, cat if k == "visual" else None, notes, "draft", who=me, ago_h=0,
                      kind=k, group=group if k == "writing" else None, pair=next((j for j in ids.values() if j != i), None))
        x["updatedAt"] = x["createdAt"]
        x["source"] = {"name": fname, "size": size, "key": f"src/{sid}", "contentType": ctype, "uploaded": False, "token": tok}
    s = STATE["styles"][sid]
    audit(me, "新建风格", f"{name}：{'、'.join(ids.values())}", f"参考视频 {fname}，{size / 1048576:.1f} MB")
    return {"id": sid, "ids": ids, "upload": {"url": f"{base}/__upload/{sid}?X-Mock-Token={tok}&X-Mock-Issued={int(time.time())}",
                                  "headers": {"Content-Type": ctype}}}


def style_action(s, act, body, me):
    label = f"{s['name']}（{s['id']}）"
    if act == "start":
        if s["task"]:
            raise ApiErr(409, "bad_state", "已经开始生成了")
        if not s["source"].get("uploaded"):
            bad("参考视频还没传完，传完再开始")
        fail = "失败" in (s["notes"] or "")
        new_task(s, list(BASE_DURS), fail=fail)
        s["updatedAt"] = now_ms()
        w = STATE["styles"].get(s.get("pair") or "")
        if w and not w["task"]:  # 另一种共用同一个生成任务（mock 里各推进各的）
            w["source"]["uploaded"] = True
            new_task(w, list(BASE_DURS))
            w["updatedAt"] = now_ms()
        audit(me, "开始生成风格", label)
        return {"taskId": s["task"]["id"]}
    if act == "retry":
        if not s["task"] or s["task"]["status"] != "failed" or s["versions"]:
            bad("只有生成失败的风格可以重试")
        new_task(s, list(BASE_DURS))
        s["updatedAt"] = now_ms()
        audit(me, "重试生成风格", label)
        return {"ok": True}
    if act == "feedback":
        need(s, "review", "beta", "public", "failed", msg="这个状态不能按意见重新生成")
        if s["task"] and s["task"]["status"] == "running":
            raise ApiErr(409, "busy", "正在生成，等这一轮做完再提意见")
        if not s["versions"]:
            bad("还没有生成好的版本")
        v = version_of(s, body.get("v"))
        text = str(body.get("text") or "").strip()
        if not text or len(text) > FEEDBACK_MAX:
            bad(f"修改意见不能为空，最多 {FEEDBACK_MAX} 个字")
        new_task(s, list(BASE_DURS), text=text, v=v["n"], fail="失败" in text)
        s["updatedAt"] = now_ms()
        audit(me, "按意见重新生成风格", label, f"基于 v{v['n']}：{text[:60]}")
        return {"ok": True}
    if act == "reject":
        need(s, "review", "failed", msg="只有待验证或生成失败的风格能驳回")
        reason = str(body.get("reason") or "").strip()
        if not reason or len(reason) > REASON_MAX:
            bad("请填写驳回原因")
        s["status"], s["reason"] = "rejected", reason
        audit(me, "驳回风格", label, reason)
    elif act == "beta":
        need(s, "review", msg="只有待验证的风格能内测发布")
        v = version_of(s, body.get("v"))
        s["status"], s["betaV"] = "beta", v["n"]
        audit(me, "内测发布风格", f"{label} v{v['n']}")
    elif act == "unbeta":
        need(s, "beta", msg="这个风格不在内测中")
        s["status"], s["betaV"] = ("public" if s["publicV"] else "review"), None
        audit(me, "撤回内测", label)
    elif act == "publish":
        v = version_of(s, body.get("v"))
        if not (s["status"] == "beta" or (s["status"] == "public" and s["betaV"] and s["betaV"] > (s["publicV"] or 0))):
            raise ApiErr(409, "bad_state", "先内测发布，做过测试片再公开发布")
        if v["n"] != s["betaV"]:
            bad(f"只能公开发布内测中的那一版（v{s['betaV']}）")
        if not can_publish(s, v["n"]):
            raise ApiErr(409, "no_test", f"v{v['n']} 至少要有一支做完的测试片，才能公开发布")
        s["status"], s["publicV"], s["betaV"] = "public", v["n"], None
        audit(me, "公开发布风格", f"{label} v{v['n']}")
    elif act == "retire":
        need(s, "public", msg="只有已公开的风格能下架")
        s["status"], s["betaV"] = "retired", None
        audit(me, "下架风格", label)
    else:
        raise ApiErr(404, "not_found", "没有这个接口")
    s["updatedAt"] = now_ms()
    return {"ok": True}


def read_file(s, v, path):
    if s.get("kind") == "writing":
        rv = path[len("review/"):] if path.startswith("review/") else None
        if path not in v["files"] and rv not in (v.get("reviewFiles") or []):
            raise ApiErr(404, "not_found", "这一版没有这个文件")
        text = {"SKILL.md": WSKILL, "traits.json": json.dumps(WTRAITS, ensure_ascii=False), "report.md": "# 写作方法报告（mock）\n\n听旁白 58 秒，切成 18 镜……",
                "breakdown.json": json.dumps(BREAKDOWN, ensure_ascii=False), "listen.json": json.dumps({"voice": "女声，二十多岁，朋友聊天", "segments": BREAKDOWN["shots"]}, ensure_ascii=False)
                }.get(rv or path) or json.dumps({**WTRIALS[0], "trial": WTRIAL_SCRIPT, "copied": ""}, ensure_ascii=False)
        return {"path": path, "text": text}
    if path not in v["files"]:
        raise ApiErr(404, "not_found", "这一版没有这个文件")
    rel = FILES.get(path, "")
    if path == "traits.json":
        text = json.dumps(v.get("traits") or {}, ensure_ascii=False, indent=2)
    else:
        try:
            text = (SAMPLE / rel).read_text(encoding="utf-8")
        except OSError:
            raise ApiErr(404, "not_found", "文件读不到")
    if v["n"] == 1 and path == "SKILL.md":
        text = "<!-- v1：第一版，还没按冷启动试写的意见改 -->\n" + text
    return {"path": path, "text": text}


# ---------------------------------------------------------------- 外壳要用的老接口（简单示例）

USERS = [
    {"sub": "u-admin", "email": "admin@example.com", "name": "管理员", "status": "active", "admin": True},
    {"sub": "u-ops", "email": "ops@example.com", "name": "运营", "status": "active", "admin": True},
    {"sub": "u-02", "email": "user02@example.com", "name": "王晨", "status": "active", "admin": False},
    {"sub": "u-03", "email": "user03@example.com", "name": "", "status": "invited", "admin": False},
]


def users_view():
    out = []
    for i, u in enumerate(USERS):
        active = u["status"] == "active"
        out.append({**u, "monthTasks": [6, 2, 11, 0][i], "monthMinutes": [3.2, 1.1, 5.8, 0][i], "monthCredits": [34.5, 9.1, 22.0, 0][i], "quota": [1000, 300, 300, 300][i],
                    "success": [0.94, 1.0, 0.9, None][i], "totalTasks": [48, 9, 73, 0][i], "last": now_ms() - [2, 30, 5, 0][i] * 3600e3 if active else None,
                    "created": now_ms() - [90, 60, 40, 1][i] * 86400e3})
    return out


# ---------------------------------------------------------------- HTTP

LOGIN_PAGE = """<!doctype html><meta charset="utf-8"><title>mock 登录</title><script>
const email = %s, next = %s;
sessionStorage.setItem('slate-admin-auth', JSON.stringify({ email, idToken: 'mock.' + encodeURIComponent(email) + '.' + Date.now(),
  refreshToken: 'mock-refresh', expiresAt: Date.now() + 12 * 3600e3 }));
location.replace('/' + next);
</script>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "SlateAdminMock/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            sys.stderr.write("[admin-mock] " + (fmt % args) + "\n")

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_bytes(status, body, "application/json; charset=utf-8")

    def send_bytes(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    @property
    def base(self):
        return "http://" + (self.headers.get("Host") or f"127.0.0.1:{ARGS.port}")

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        try:
            u = urlsplit(self.path)
            path, q = u.path, parse_qs(u.query)
            if path.startswith("/api/"):
                self.api(method, path[4:], q)
            elif path == "/config.json":
                cfg = {"apiBase": "/api", "region": "us-east-1", "userPoolId": "us-east-1_mock", "clientId": "mock-admin-client"}
                if ARGS.user_site:
                    cfg["userSite"] = ARGS.user_site
                self.send_json(200, cfg)
            elif path == "/__dev/login":
                email = (q.get("email") or ["admin@example.com"])[0]
                nxt = (q.get("next") or ["#styles"])[0]
                self.send_bytes(200, (LOGIN_PAGE % (json.dumps(email), json.dumps(nxt))).encode("utf-8"), "text/html; charset=utf-8")
            elif path.startswith("/__dev/") and method == "POST":
                self.read_body()
                self.dev(path)
            elif path.startswith("/__upload/") and method == "PUT":
                self.put_upload(unquote(path[len("/__upload/"):]), q)
            elif path.startswith("/media/") and method == "GET":
                self.serve_media(unquote(path[len("/media/"):]), q)
            elif path == "/favicon.ico":
                self.send_bytes(204, b"", "image/x-icon")
            elif method == "GET":
                self.serve_static(path)
            else:
                self.read_body()
                self.send_json(405, {"error": {"code": "method_not_allowed", "message": "不支持这个请求方法"}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ApiErr as e:
            self.send_json(e.status, {"error": {"code": e.code, "message": e.message}})
        except Exception:
            traceback.print_exc()
            try:
                self.send_json(500, {"error": {"code": "internal", "message": "mock 服务器内部错误"}})
            except Exception:
                pass

    # ---- 静态文件：只托管 admin/，不给 dev/
    def serve_static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        target = (ADMIN_ROOT / rel).resolve()
        if ADMIN_ROOT not in target.parents or (ADMIN_ROOT / "dev") in target.parents or not target.is_file():
            return self.send_bytes(404, b"not found", "text/plain")
        ctype = "text/javascript" if target.suffix == ".js" else mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        self.send_bytes(200, target.read_bytes(), ctype)

    # ---- 媒体：sample/ 是 spike 产出，gen/ 是现截的缩略图，src/ 是上传的参考视频。支持 Range（播放器拖动要用）
    def serve_media(self, key, q):
        issued = int((q.get("X-Mock-Issued") or ["0"])[0] or 0)
        if not q.get("X-Mock-Signature") or time.time() - issued > ARGS.url_ttl:
            return self.send_bytes(403, b"<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", "application/xml")
        kind, _, rel = key.partition("/")
        roots = {"sample": SAMPLE, "gen": GEN_DIR}
        ctype = None
        if kind == "src":
            with LOCK:
                s = STATE["styles"].get(rel)
                p = Path(s["source"]["file"]) if s and s["source"].get("file") else None
                ctype = s and s["source"]["contentType"]
        elif kind in roots:
            p = (roots[kind] / rel).resolve()
            if roots[kind].resolve() not in p.parents:
                p = None
        else:
            p = None
        if not p or not p.is_file():
            return self.send_bytes(404, b"<Error><Code>NoSuchKey</Code></Error>", "application/xml")
        ctype = ctype or mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        size = p.stat().st_size
        start, end, status = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range") or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start, end = int(m.group(1)), int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                return self.send_bytes(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(p, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ---- 预签名上传：按限速读取，前端能看到进度；Content-Type 和登记的不一样就 403（S3 的签名也是这样）
    def put_upload(self, sid, q):
        n = int(self.headers.get("Content-Length") or 0)
        with LOCK:
            s = STATE["styles"].get(sid)
            src = s["source"] if s else None
        if not src or (q.get("X-Mock-Token") or [""])[0] != src.get("token") or time.time() - int((q.get("X-Mock-Issued") or ["0"])[0]) > ARGS.url_ttl:
            self.read_body()
            return self.send_bytes(403, b"<Error><Code>AccessDenied</Code></Error>", "application/xml")
        if (self.headers.get("Content-Type") or "").split(";")[0].strip() != src["contentType"]:
            self.read_body()
            return self.send_bytes(403, b"<Error><Code>SignatureDoesNotMatch</Code></Error>", "application/xml")
        out = GEN_DIR / f"src-{sid}"
        got, rate, t0 = 0, max(1, ARGS.upload_kbps) * 1024, time.time()
        with open(out, "wb") as f:
            while got < n:
                chunk = self.rfile.read(min(65536, n - got))
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                wait = got / rate - (time.time() - t0)
                if wait > 0:
                    time.sleep(wait)
        if got != src["size"]:
            return self.send_bytes(400, b"<Error><Code>IncompleteBody</Code></Error>", "application/xml")
        with LOCK:
            src.update({"uploaded": True, "file": str(out)})
            s["updatedAt"] = now_ms()
        self.send_bytes(200, b"", "text/plain", {"ETag": '"' + secrets.token_hex(8) + '"'})

    def dev(self, path):
        with LOCK:
            if path == "/__dev/reset":
                seed()
            elif path == "/__dev/finish-tests":
                for s in STATE["styles"].values():
                    for x in s["tests"]:
                        x["doneAt"] = min(x["doneAt"], time.time())
            else:
                raise ApiErr(404, "not_found", "没有这个开发接口")
        self.send_json(200, {"ok": True})

    # ---- API
    def api(self, method, path, q):
        raw = self.read_body()
        if ARGS.latency:
            time.sleep(ARGS.latency)
        m = re.match(r"mock\.(.+)\.(\d+)$", self.headers.get("Authorization") or "")
        if not m:
            raise ApiErr(401, "unauthorized", "请先登录")
        me = unquote(m.group(1))
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            bad("请求格式不对")
        if not isinstance(body, dict):
            bad("请求格式不对")
        with LOCK:
            status, out = self.route(method, path, q, body, me)
        self.send_json(status, out)

    def route(self, method, path, q, body, me):
        base = self.base
        if method == "GET" and path == "/me":
            return 200, {"sub": "u-admin", "email": me}
        if method == "GET" and path == "/users":
            return 200, {"items": users_view()}
        if method == "GET" and path == "/audit":
            return 200, {"items": STATE["audit"][:200]}
        if method == "GET" and path == "/styles":
            for s in STATE["styles"].values():
                advance(s)
            return 200, {"items": [style_brief(s, base) for s in STATE["styles"].values()]}
        if method == "POST" and path == "/styles":
            return 201, create_style(body, me, base)
        r = re.fullmatch(r"/styles/([a-z0-9-]+)(?:/([a-z]+))?", path)
        if r:
            s, act = find(r.group(1)), r.group(2)
            if method == "GET" and not act:
                return 200, style_view(s, base)
            if method == "GET" and act == "file":
                return 200, read_file(s, version_of(s, (q.get("v") or [""])[0]), (q.get("path") or [""])[0])
            if method == "POST" and act:
                return 200, style_action(s, act, body, me)
        raise ApiErr(404, "not_found", "本地 mock 只实现了风格创建和外壳要用的几个接口，没有这个")


def main():
    global ARGS, GEN_DIR
    ap = argparse.ArgumentParser(description="Slate 管理端本地 mock 服务器（只用于本地开发）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--speed", type=float, default=1.0, help="生成推进速度倍数（1 = 一轮约 76 秒）")
    ap.add_argument("--latency", type=float, default=0.05, help="每个接口额外的延迟（秒）")
    ap.add_argument("--upload-kbps", type=int, default=4096, help="上传限速（KB/秒），方便看到进度")
    ap.add_argument("--url-ttl", type=int, default=3600, help="媒体和上传链接的有效期（秒）")
    ap.add_argument("--user-site", default="http://127.0.0.1:8765/", help="用户端地址（config.json 的 userSite）；给空字符串表示不配")
    ap.add_argument("--verbose", action="store_true")
    ARGS = ap.parse_args()
    if not SAMPLE.is_dir():
        sys.exit(f"找不到 {SAMPLE}，验证材料要用它")

    GEN_DIR = Path(tempfile.mkdtemp(prefix="slate-admin-mock-"))
    atexit.register(shutil.rmtree, GEN_DIR, True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # 被 kill 时也清掉临时目录
    make_thumbs()
    with LOCK:
        seed()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    srv.daemon_threads = True
    print(f"Slate 管理端 mock：http://{ARGS.host}:{ARGS.port}/__dev/login  （先打开这个地址，写入假登录）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
