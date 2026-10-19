"""slate-style：风格创建（手册 core-stylegen，docs/style-creator-design.md）用的命令。

slate-style probe <视频> --out <目录>                      拆帧：镜头表、切点、动作强度、配色、关键帧、联系表、动作条
slate-style frames <场景号> --times 0,0.5 | --range 起:止:每秒帧数 (--out <目录> | --mp4 <文件>) [--size 960x540]
slate-style compare --seg 起:止 --scene <场景号> --out <目录> [--fps 10] [--mp4]   重建场景和参考同一段逐帧对比
slate-style trial --scene T1 --dur 6 --brief "<内容>"      冷启动试写：另开一次干净的模型调用，只给 Skill，写一个新题材的镜头
slate-style export                                         检查 Skill 和验证材料，发布新的一版（管理员在管理端看）
写作方法（docs/skills-two-dimensions.md，任务说明的 outputs 里有 writing 时）：
slate-style listen [--out work/listen.json]                听旁白：用看视频的模型听参考视频，逐句旁白、时间、语气语调、语速、配乐和段落
slate-style trial-writing --topic "<新题材>" [--dur 60]     冷启动试写：另开一次干净的模型调用，只给写作方法，写剧本和分镜，再对照原片结构打分
slate-style export-writing                                 检查写作方法和验证材料，发布新的一版

场景都在 /root/task/scenes/<场景号>/，页面里用 /skills/<风格 id>/… 引用正在写的 Skill（/root/task/style/<id>/）。
渲染用和正式做片同一种浏览器（AgentCore Browser），外部请求一律拦截。
"""
import argparse, asyncio, glob, io, json, os, re, shutil, subprocess, sys, time

import numpy as np
from PIL import Image, ImageDraw

from . import vframes as vf
from .common import ctx, die, emit, load_json, path, upload

SKILL_LIMIT = 20 << 10          # SKILL.md
DIR_LIMIT = 2 << 20             # 整个 Skill 目录
EXTS = {".md", ".json", ".js", ".mjs", ".css", ".html", ".png", ".jpg", ".webp", ".svg"}
URL_RE = re.compile(r"https?://(?!www\.w3\.org/)[\w.-]+", re.I)   # SVG 的命名空间不算外部请求
# 和参考的哪一帧轮廓相关系数到这个数算"照搬了参考的画面"。刻意逐帧重建也只有 0.47～0.86（实测），换了题材和构图的一般在 0.3 以下；
# 不用感知哈希：大片纯色背景的画面哈希都差不多
SIMILAR = 0.6


def style_id():
    """正在做的风格：style/ 下唯一的目录"""
    ds = [d for d in sorted(os.listdir(path("style"))) if os.path.isdir(path("style", d))] if os.path.isdir(path("style")) else []
    if len(ds) != 1:
        die(f"/root/task/style/ 下应该正好有一个风格目录（按任务说明的 skill_dir），现在有：{', '.join(ds) or '（没有）'}")
    return ds[0]


def writing_id():
    """正在做的写作方法：writing/ 下唯一的目录"""
    ds = [d for d in sorted(os.listdir(path("writing"))) if os.path.isdir(path("writing", d))] if os.path.isdir(path("writing")) else []
    if len(ds) != 1:
        die(f"/root/task/writing/ 下应该正好有一个写作方法目录（按任务说明的 writing_dir），现在有：{', '.join(ds) or '（没有）'}")
    return ds[0]


def reference():
    vids = sorted(glob.glob(path("input", "ref", "*")))
    if not vids:
        die("找不到参考视频（/root/task/input/ref/）：先运行 slate-sync pull")
    return vids[0]


# ---------------------------------------------------------------- 渲染

async def capture(scene_id, times, w, h, png_dir=None, mp4=None, fps=30, arrays=False):
    """返回 (图片路径或数组列表, 页面错误)"""
    from playwright.async_api import async_playwright
    from . import page as pg
    cfg = {"width": w, "height": h, "fps": fps, "duration": max(times) + 0.5, "scene": scene_id, "ratio": "16:9",
           "subtitles": False, "captions": []}
    out, errors, ff = [], [], None
    if mp4:
        ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
                               "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", mp4], stdin=subprocess.PIPE)
    async with async_playwright() as pw:
        async with pg.ScenePage(pw, scene_id, cfg, name=f"style_{os.getpid()}") as sp:
            for t in times:
                await sp.frame(t)
                if ff:
                    ff.stdin.write(await sp.jpeg(92))
                    continue
                data = await sp.png()
                if arrays:
                    out.append(np.asarray(Image.open(io.BytesIO(data)).convert("RGB")))
                else:
                    p = os.path.join(png_dir, f"{scene_id}-{t:07.3f}.png")
                    open(p, "wb").write(data)
                    out.append(p)
            errors = sp.errors[:8] + [f"被拦截：{u}" for u in sp.blocked[:4]]
    if ff:
        ff.stdin.close(); ff.wait()
        out = [mp4]
    return out, errors


def times_of(a):
    if a.times:
        return [float(x) for x in a.times.split(",") if x.strip()]
    s, e, f = (float(x) for x in a.range.split(":"))
    return [round(s + k / f, 4) for k in range(int(round((e - s) * f)))]


def size_of(s):
    w, h = (int(x) for x in s.split("x"))
    return w, h


# ---------------------------------------------------------------- 对比

def compare(seg, scene, out, fps=10, size="960x540", mp4=False):
    s, e = (float(x) for x in seg.split(":"))
    w, h = size_of(size)
    ref = vf.decode(reference(), fps, w, h, start=s, dur=e - s)
    times = [round(k / fps, 4) for k in range(len(ref))]
    rec, errors = asyncio.run(capture(scene, times, w, h, arrays=True))
    rec = np.stack(rec)
    n = min(len(ref), len(rec)); ref, rec = ref[:n], rec[:n]
    pix = 1 - np.abs(ref.astype(np.int16) - rec.astype(np.int16)).mean(axis=(1, 2, 3)) / 255
    sw = lambda x: np.asarray(Image.fromarray(x).resize((240, 135), Image.BILINEAR))  # noqa: E731
    struct = np.array([vf.corr(vf.edges(sw(ref[i])), vf.edges(sw(rec[i]))) for i in range(n)])
    er, ec = vf.energy_curve(np.stack([sw(x) for x in ref])), vf.energy_curve(np.stack([sw(x) for x in rec]))
    pr, pc = vf.peak_times(er, fps), vf.peak_times(ec, fps)
    lags = [round(min(abs(p - q) for q in pc), 2) for p in pr if pc]
    de, pdetail = vf.palette_delta(ref, rec)
    score = {"segment": [s, e], "frames": n, "pixel": round(float(pix.mean()), 3), "structure": round(float(struct.mean()), 3),
             "paletteDeltaE": round(de, 1), "motion": round(vf.corr(er, ec), 3),
             "peakLag": {"refPeaks": len(pr), "recPeaks": len(pc), "median": round(float(np.median(lags)), 2) if lags else None,
                         "max": max(lags) if lags else None},
             "palette": pdetail[:8],
             "worst": [{"t": round(s + times[i], 2), "pixel": round(float(pix[i]), 3), "structure": round(float(struct[i]), 3)}
                       for i in np.argsort(struct + pix)[:5]],
             "page_errors": errors}
    idx = sorted(set(np.linspace(0, n - 1, 6).astype(int).tolist() + np.argsort(struct)[:2].tolist()))
    cell = 360; ch = int(cell * h / w)
    img = Image.new("RGB", (len(idx) * cell, 2 * (ch + 24)), "white"); d = ImageDraw.Draw(img); f = vf.font(16)
    for k, i in enumerate(idx):
        img.paste(Image.fromarray(ref[i]).resize((cell - 4, ch)), (k * cell + 2, 24))
        img.paste(Image.fromarray(rec[i]).resize((cell - 4, ch)), (k * cell + 2, ch + 48))
        d.text((k * cell + 6, 3), f"参考 {vf.tc(s + times[i])}", fill=(200, 30, 30), font=f)
        d.text((k * cell + 6, ch + 27), f"重建 {times[i]:.2f}s  轮廓 {struct[i]:.2f}", fill=(30, 60, 200), font=f)
    os.makedirs(out, exist_ok=True)
    img.save(os.path.join(out, "cmp.png"))
    vf.plot_pair(er, ec, fps, os.path.join(out, "motion.png"))
    if mp4:
        rec_mp4 = os.path.join(out, "rec.mp4")
        asyncio.run(capture(scene, [round(k / 30, 4) for k in range(int((e - s) * 30))], 960, 540, mp4=rec_mp4, fps=30))
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", reference(), "-i", rec_mp4, "-filter_complex",
                        "[0:v]scale=960:540,fps=30,setsar=1[l];[1:v]scale=960:540,setsar=1[r];[l][r]hstack=inputs=2[v]", "-map", "[v]", "-an",
                        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", os.path.join(out, "side.mp4")], check=True)
        os.remove(rec_mp4)
        score["side"] = os.path.join(out, "side.mp4")
    json.dump(score, open(os.path.join(out, "scores.json"), "w"), ensure_ascii=False, indent=1)
    return score


# ---------------------------------------------------------------- 冷启动试写

def trial(scene, dur, text):
    """只给平台的页面约定（film-kit）、Skill 的说明书、示范片说明和引擎源码，让一次干净的模型调用写一个新题材的镜头"""
    sid = style_id()
    sdir = path("style", sid)

    def read(p, limit=None):
        s = open(p, encoding="utf-8").read()
        return s if not limit or len(s) <= limit else s[:limit] + "\n…（后面省略）"
    parts = [("平台的影片风格用法（film-kit，页面写法看第 2 节）", read("/.agents/skills/film-kit/SKILL.md")),
             ("风格说明书 SKILL.md", read(os.path.join(sdir, "SKILL.md")))]
    if os.path.exists(os.path.join(sdir, "DEMO.md")):
        parts.append(("示范片说明 DEMO.md", read(os.path.join(sdir, "DEMO.md"), 30000)))
    for root, _, files in os.walk(os.path.join(sdir, "demo")):
        if os.sep + "scenes" in root:
            continue
        for f in sorted(files):
            if f.endswith((".js", ".mjs")):
                rel = os.path.relpath(os.path.join(root, f), sdir)
                parts.append((f"引擎源码 /skills/{sid}/{rel}", read(os.path.join(root, f), 60000)))
    task = (f"用上面这个风格写一个镜头：1920×1080，时长 {dur:g} 秒。\n这一镜的内容：{text}\n\n要求：\n"
            "- 只输出一个完整的 index.html（放在 ```html 代码块里），不要别的解释。\n"
            "- 页面约定照 film-kit 第 2 节：定义全局 render(t)，画面只由 t 决定。\n"
            f"- 风格的引擎用 `import … from '/skills/{sid}/…'` 引用，不要整段复制；字体只用说明书里写的字体。\n"
            "- 画面要一眼看得出是这个风格：照说明书的配色、字体、版式、动作和镜头语法写。")
    question = "\n\n".join(f"## {t}\n\n{s}" for t, s in parts) + "\n\n" + task
    system = "你是一个做讲解和广告视频的前端动画工程师，按给定的风格说明写逐帧渲染的 HTML 镜头。"
    out = _llm_text(question, system)
    m = re.search(r"```html\s*(.*?)```", out, re.S) or re.search(r"(<!doctype html.*</html>)", out, re.S | re.I)
    if not m:
        die("试写没有拿到 HTML：" + out[:300])
    d = path("scenes", scene)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(m.group(1).strip())
    return os.path.join(d, "index.html")


def _llm_text(question, system):
    """经 llm Lambda 调用（它认本轮的计费令牌、查额度、记账）。线上调不通、被拒绝都直接报错，
    不退回用会话的角色直接调 Bedrock（安全扫描增量 #2）。只有本机调试、没有 Lambda 时才直接调"""
    import boto3
    from botocore.config import Config
    from .common import REGION
    fn = os.environ.get("SLATE_LLM_FN")
    if fn:
        payload = {"op": "text", "images": [], "question": question, "system": system, "maxTokens": 16000,
                   "billing": {"taskId": ctx().get("taskId"), "chapter": ctx().get("chapter"), "token": ctx().get("billToken")}}
        try:
            r = boto3.client("lambda", region_name=REGION, config=Config(read_timeout=200, retries={"max_attempts": 1})).invoke(
                FunctionName=fn, Payload=json.dumps(payload).encode())
            res = json.loads(r["Payload"].read())
        except Exception as e:
            die(f"模型服务调不通：{repr(e)[:200]}。稍后再试")
        if not res.get("ok"):
            die(f"模型调用失败：{str(res.get('error') or '')[:200]}")
        return res.get("text") or ""
    br = boto3.client("bedrock-runtime", region_name=REGION, config=Config(read_timeout=600))
    r = br.converse(modelId="global.anthropic.claude-sonnet-5-5", messages=[{"role": "user", "content": [{"text": question}]}],
                    system=[{"text": system}], inferenceConfig={"maxTokens": 16000})
    return "".join(b.get("text", "") for b in r["output"]["message"]["content"])


# ---------------------------------------------------------------- 写作方法：听旁白、试写、发布

LISTEN_Q = """这是一段中文短视频，我要学它的"讲法"（不是画面）：怎么开场、分几段、每段做什么、旁白怎么说、语气节奏怎么起伏。
请只看 {span}，按时间顺序输出 JSON（只输出 JSON，不要别的文字）：
{{"segments": [{{"start": 秒, "end": 秒, "text": "这一句旁白原文（听不清的写[听不清]）", "tone": "语气语调：情绪、轻重、哪个词重读、有没有停顿或拖音",
  "speed": "语速：快/中/慢，或者每秒大约几个字", "onscreen": "这一句时画面上的大字或字幕（没有就空）"}}],
 "voice": "说话人：性别、年龄感、人设（主播、朋友、专家……）",
 "overall": "整体口吻、节奏和情绪起伏",
 "music": "配乐和音效：风格、什么时候进出、和旁白怎么配合",
 "structure": [{{"start": 秒, "end": 秒, "purpose": "这一段在讲什么、起什么作用（钩子、铺垫、转折、卖点、号召……）"}}],
 "hook": "前 3 秒用什么抓人", "ending": "怎么收尾"}}
没有旁白时 segments 的 text 写画面上的字，并在 overall 里说明没有旁白。"""


def _llm_video(question, seconds, key):
    """经 llm Lambda 调用看视频的模型（TwelveLabs Pegasus，用量记在这个任务上）。视频要在任务自己的数据桶目录里"""
    import boto3
    from botocore.config import Config
    from .common import REGION
    fn = os.environ.get("SLATE_LLM_FN")
    if not fn:
        die("没有配置 llm Lambda，听不了旁白")
    payload = {"op": "video", "key": key, "question": question, "seconds": seconds,
               "billing": {"taskId": ctx().get("taskId"), "chapter": ctx().get("chapter"), "token": ctx().get("billToken")}}
    r = boto3.client("lambda", region_name=REGION, config=Config(read_timeout=200, retries={"max_attempts": 1})).invoke(
        FunctionName=fn, Payload=json.dumps(payload).encode())
    res = json.loads(r["Payload"].read())
    if not res.get("ok"):
        die("听旁白没有成功：" + str(res.get("error") or res)[:300])
    return res.get("text") or ""


def _json_of(text):
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    raw = m.group(1) if m else text[text.find("{"):text.rfind("}") + 1]
    try:
        return json.loads(raw)
    except Exception:
        return None


WINDOW = 150  # 一次听多长：输出太长会被截断，长视频分段听


def listen(out):
    """听参考视频：逐句旁白（带时间、语气语调、语速）、说话人、配乐、段落结构。结果写进 work/listen.json"""
    ref = reference()
    meta = vf.info(ref)
    dur = float(meta["duration"])
    key = "/".join([ctx()["prefix"].rstrip("/"), "input", "ref", os.path.basename(ref)])
    spans = [(0.0, dur)] if dur <= WINDOW + 30 else [(t, min(dur, t + WINDOW)) for t in np.arange(0, dur, WINDOW)]
    merged, raws = None, []
    for a, b in spans:
        span = "整段视频" if len(spans) == 1 else f"第 {a:.0f} 秒到第 {b:.0f} 秒这一段（时间仍按整段视频算）"
        text = _llm_video(LISTEN_Q.format(span=span), round(dur, 1), key)
        raws.append(text)
        got = _json_of(text)
        if not isinstance(got, dict):
            die("看视频的模型没有返回 JSON：" + text[:300])
        if merged is None:
            merged = got
        else:
            for k in ("segments", "structure"):
                merged[k] = (merged.get(k) or []) + (got.get(k) or [])
    merged["duration"] = round(dur, 2)
    merged["audio"] = bool(meta.get("audio"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(merged, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    open(os.path.splitext(out)[0] + ".raw.txt", "w", encoding="utf-8").write("\n\n".join(raws))
    segs = merged.get("segments") or []
    chars = sum(len(str(x.get("text") or "")) for x in segs)
    return {"file": out, "duration": round(dur, 1), "audio": merged["audio"], "sentences": len(segs), "chars": chars,
            "chars_per_second": round(chars / dur, 2) if dur else None, "voice": merged.get("voice"), "overall": merged.get("overall")}


def _norm(t):
    return re.sub(r"[\s，。！？、；：,.!?;:\"'“”‘’（）()「」《》\-—…·]", "", str(t or ""))


def longest_common(a, b):
    """两段文字最长的共同片段（去掉空白和标点后比），用来查有没有照搬原片的文案"""
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return ""
    best, prev = (0, 0), [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        ai = a[i - 1]
        for j in range(1, len(b) + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best[0]:
                    best = (cur[j], i)
        prev = cur
    return a[best[1] - best[0]:best[1]]


COPY_LIMIT = 12  # 和原片旁白连续这么多个字相同，算照搬了原片的文案


def _transcript():
    lst = load_json(path("work", "listen.json")) or {}
    return "".join(str(x.get("text") or "") + str(x.get("onscreen") or "") for x in lst.get("segments") or [])


def _playbook(group):
    return "/.agents/skills/core-director/" + ("ad-playbook.md" if group == "宣传" else "explainer-playbook.md")


def trial_writing(topic, dur):
    """冷启动试写：只给通用打法和这份写作方法，写一个新题材的剧本和分镜；再请评审对照原片分镜表打分"""
    wid = writing_id()
    wdir = path("writing", wid)
    md = open(os.path.join(wdir, "SKILL.md"), encoding="utf-8").read()
    traits = load_json(os.path.join(wdir, "traits.json")) or {}
    group = traits.get("group") or "讲解"
    book = open(_playbook(group), encoding="utf-8").read()
    q = (f"## {group}类通用打法\n\n{book}\n\n## 写作方法：{traits.get('name') or wid}\n\n{md}\n\n"
         f"按上面这份写作方法（和它冲突时以写作方法为准），给下面这个题材写一支约 {dur:g} 秒的片子的剧本和分镜。\n题材：{topic}\n\n"
         "只输出 JSON：{\"title\": \"片名\", \"scenes\": [{\"id\": \"01\", \"title\": \"不超过 10 个字\", \"narration\": \"旁白\", "
         "\"visual\": \"画面描述\", \"duration\": 秒, \"tone\": \"这一句怎么读：语气、轻重、停顿\"}]}。中文旁白每秒约 4.5 个字。")
    out = _llm_text(q, "你是讲解片和广告片的编剧，严格按给定的写作方法组织剧本和分镜。")
    trial = _json_of(out)
    if not isinstance(trial, dict) or not trial.get("scenes"):
        die("试写没有拿到剧本 JSON：" + out[:300])
    bd = load_json(path("review-writing", "breakdown.json")) or {}
    judge_q = ("下面是一段参考视频的分镜表（它的讲法），和另一个题材按同一份写作方法写出来的剧本。"
               "请判断后者有没有学到前者的讲法（不看题材和具体文字）：结构（分几段、每段的作用）、开场方式、节奏（镜头长短和起伏）、旁白口吻和语气，"
               "各给 1～5 分，再写一句哪里像、哪里不像。只输出 JSON：{\"scores\": {\"structure\": 分, \"opening\": 分, \"rhythm\": 分, \"voice\": 分}, \"notes\": \"…\"}"
               f"\n\n## 参考视频的分镜表\n\n```json\n{json.dumps(bd, ensure_ascii=False)[:30000]}\n```"
               f"\n\n## 新题材的剧本\n\n```json\n{json.dumps(trial, ensure_ascii=False)}\n```")
    judged = _json_of(_llm_text(judge_q, "你是讲解片和广告片的剧本编辑，评判两支片子的讲法是否一致。")) or {}
    narr = "".join(str(x.get("narration") or "") for x in trial["scenes"])
    common = longest_common(narr, _transcript())
    d = path("review-writing")
    os.makedirs(d, exist_ok=True)
    n = len(glob.glob(os.path.join(d, "trial-*.json"))) + 1
    rec = {"topic": topic, "duration": dur, "trial": trial, "scores": judged.get("scores") or {}, "notes": judged.get("notes") or "",
           "copied": common if len(common) >= COPY_LIMIT else ""}
    f = os.path.join(d, f"trial-{n}.json")
    json.dump(rec, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return {"file": f, "scenes": len(trial["scenes"]), "scores": rec["scores"], "notes": rec["notes"], "copied": rec["copied"]}


TRIAL_NAMES = {"structure": "结构", "opening": "开场", "rhythm": "节奏", "voice": "口吻"}
# 写作方法说明书必须有的几节（和内置写作方法的格式一致）
WRITING_SECTIONS = ("结构", "开场", "节奏", "旁白", "镜头", "时长")


def export_writing():
    wid = writing_id()
    wdir = path("writing", wid)
    problems = []
    md = open(os.path.join(wdir, "SKILL.md"), encoding="utf-8").read() if os.path.exists(os.path.join(wdir, "SKILL.md")) else ""
    fm = re.match(r"^---\n(.*?)\n---\n", md, re.S)
    if not fm:
        problems.append("SKILL.md 开头要有 frontmatter（name、description）")
    else:
        name = re.search(r"^name:\s*(\S+)", fm.group(1), re.M)
        desc = re.search(r"^description:\s*(.+)$", fm.group(1), re.M)
        if not name or name.group(1) != wid:
            problems.append(f"frontmatter 的 name 要写 {wid}")
        if not desc or len(desc.group(1)) > 1024:
            problems.append("frontmatter 的 description 要写，最多 1024 个字符")
    if len(md.encode()) > SKILL_LIMIT:
        problems.append(f"SKILL.md 超过 {SKILL_LIMIT >> 10} KB，删掉重复的说明")
    heads = " ".join(re.findall(r"^#{2,3}\s*(.+)$", md, re.M))
    miss = [x for x in WRITING_SECTIONS if x not in heads]
    if miss:
        problems.append(f"SKILL.md 缺这几节（标题里要有这些词）：{'、'.join(miss)}")
    if URL_RE.search(md):
        problems.append("SKILL.md 里不要有网址")
    traits = load_json(os.path.join(wdir, "traits.json")) or {}
    if not traits.get("line") or traits.get("group") not in ("讲解", "宣传"):
        problems.append("traits.json 至少要有 line（一句话定位）和 group（讲解或宣传）")
    extra = [f for f in os.listdir(wdir) if f not in ("SKILL.md", "traits.json")] if os.path.isdir(wdir) else []
    if extra:
        problems.append(f"写作方法目录里只放 SKILL.md 和 traits.json，其他的放进 review-writing/：{', '.join(extra[:6])}")
    rv_dir = path("review-writing")
    if not (load_json(os.path.join(rv_dir, "breakdown.json")) or {}).get("shots"):
        problems.append("review-writing/breakdown.json 里要有原片分镜表（shots）")
    trials = sorted(glob.glob(os.path.join(rv_dir, "trial-*.json")))
    if not trials:
        problems.append("还没有冷启动试写（slate-style trial-writing）")
    copied = longest_common(md, _transcript())
    if len(copied) >= COPY_LIMIT:
        problems.append(f"说明书里有一段和原片旁白一模一样（「{copied[:30]}」）：只写讲法和规则，原片的文案不能带进 Skill")
    if problems:
        die("这一版写作方法还不能导出：\n- " + "\n- ".join(problems))
    trs = [load_json(f) or {} for f in trials]
    last = trs[-1]
    sc = [v for v in (last.get("scores") or {}).values() if isinstance(v, (int, float))]
    checks = [{"name": "格式", "ok": True, "detail": f"frontmatter、必备章节（{'、'.join(WRITING_SECTIONS)}）、大小、没有网址"},
              {"name": "没有照搬原片文案", "ok": True, "detail": f"说明书和原片旁白最长的共同片段 {len(copied)} 个字（{COPY_LIMIT} 个字以上算照搬）"},
              {"name": "试写学到了讲法", "ok": bool(sc) and min(sc) >= 3,
               "detail": f"最后一轮试写：{'、'.join(f'{TRIAL_NAMES.get(k, k)} {v}' for k, v in (last.get('scores') or {}).items())}（每项 3 分以上算学到）"}]
    vers = load_json(path("work", "writing-versions.json"), []) or []
    n = len(vers) + 1
    base = ("writing", f"v{n}")
    for f in ("SKILL.md", "traits.json"):
        upload(os.path.join(wdir, f), *base, "skill", f, content_type=_ctype(f))
    upload(os.path.join(rv_dir, "breakdown.json"), *base, "review", "breakdown.json", content_type="application/json")
    ev_trials = []
    for i, (f, t) in enumerate(zip(trials, trs), 1):
        upload(f, *base, "review", f"trial-{i}.json", content_type="application/json")
        ev_trials.append({"label": f"第 {i} 轮", "url": f"review/trial-{i}.json", "topic": str(t.get("topic") or "")[:80],
                          "scores": {k: (t.get("scores") or {}).get(k) for k in ("structure", "opening", "rhythm", "voice")},
                          "notes": str(t.get("notes") or "")[:400]})
    if os.path.exists(path("work", "listen.json")):
        upload(path("work", "listen.json"), *base, "review", "listen.json", content_type="application/json")
    if os.path.exists(os.path.join(rv_dir, "report.md")):
        upload(os.path.join(rv_dir, "report.md"), *base, "review", "report.md", content_type="text/markdown; charset=utf-8")
    emit("writing", n=n, trials=ev_trials, checks=checks)
    vers.append({"n": n, "at": int(time.time() * 1000)})
    os.makedirs(path("work"), exist_ok=True)
    json.dump(vers, open(path("work", "writing-versions.json"), "w"), ensure_ascii=False, indent=1)
    return {"version": n, "checks": checks, "line": traits.get("line")}


# ---------------------------------------------------------------- 发布一版

def _skill_checks(sid, sdir):
    """格式检查：不过关直接报错（Agent 修完再导出）"""
    problems = []
    md = open(os.path.join(sdir, "SKILL.md"), encoding="utf-8").read() if os.path.exists(os.path.join(sdir, "SKILL.md")) else ""
    fm = re.match(r"^---\n(.*?)\n---\n", md, re.S)
    if not fm:
        problems.append("SKILL.md 开头要有 frontmatter（name、description）")
    else:
        name = re.search(r"^name:\s*(\S+)", fm.group(1), re.M)
        desc = re.search(r"^description:\s*(.+)$", fm.group(1), re.M)
        if not name or name.group(1) != sid:
            problems.append(f"frontmatter 的 name 要写 {sid}")
        if not desc or len(desc.group(1)) > 1024:
            problems.append("frontmatter 的 description 要写，最多 1024 个字符")
    if len(md.encode()) > SKILL_LIMIT:
        problems.append(f"SKILL.md 超过 {SKILL_LIMIT >> 10} KB，删掉重复的说明")
    if "film-kit" not in md:
        problems.append("SKILL.md 开头要和其他影片风格一样，说明先读 /.agents/skills/film-kit/SKILL.md")
    for f in ("DEMO.md", "style.json", "traits.json"):
        if not os.path.exists(os.path.join(sdir, f)):
            problems.append(f"缺少 {f}")
    traits = load_json(os.path.join(sdir, "traits.json")) or {}
    if not traits.get("line") or not traits.get("palette"):
        problems.append("traits.json 至少要有 line（一句话定位）和 palette（色板）")
    total, bad, urls = 0, [], []
    for root, _, files in os.walk(sdir):
        for f in files:
            p = os.path.join(root, f)
            total += os.path.getsize(p)
            if os.path.splitext(f)[1].lower() not in EXTS:
                bad.append(os.path.relpath(p, sdir))
            elif f.endswith((".js", ".mjs", ".html", ".css")):
                urls += [f"{os.path.relpath(p, sdir)}：{u}" for u in URL_RE.findall(open(p, encoding="utf-8", errors="ignore").read())[:2]]
    if total > DIR_LIMIT:
        problems.append(f"Skill 目录 {total >> 10} KB，超过 {DIR_LIMIT >> 20} MB")
    if bad:
        problems.append(f"这些文件类型不能放进 Skill（字体用平台字体库，不要自带）：{', '.join(bad[:6])}")
    if urls:
        problems.append(f"代码里有外部地址（渲染时会被拦截，也不允许）：{'；'.join(urls[:4])}")
    demos = sorted(d for d in os.listdir(os.path.join(sdir, "demo", "scenes")) if re.fullmatch(r"D\d+", d)) \
        if os.path.isdir(os.path.join(sdir, "demo", "scenes")) else []
    if not demos:
        problems.append("demo/scenes/ 下要有示范镜头（D1、D2…）")
    return problems, traits, demos


def export():
    sid = style_id()
    sdir = path("style", sid)
    problems, traits, demos = _skill_checks(sid, sdir)
    review = path("review")
    rv = load_json(os.path.join(review, "review.json")) or {}
    segs = [s for s in rv.get("segments") or [] if isinstance(s, dict)]
    for s in segs:
        if not os.path.exists(os.path.join(review, "recon", s.get("id", ""), "side.mp4")):
            problems.append(f"review/recon/{s.get('id')}/ 下没有 side.mp4：最后一轮对比加 --mp4")
    if not segs:
        problems.append("review/review.json 里要列出重建的段（segments），每段在 review/recon/<段>/ 下有 compare 的结果")
    trials = [t for t in rv.get("trials") or [] if isinstance(t, dict)]
    if not trials:
        problems.append("review/review.json 里要有冷启动试写的结果（trials）")
    for t in trials:
        if not os.path.exists(os.path.join(review, t.get("file") or "-")):
            problems.append(f"找不到试写的视频 review/{t.get('file')}")
    if problems:
        die("这一版还不能导出：\n- " + "\n- ".join(problems))
    # 示范镜头：能渲染、没有页面错误、同一时刻渲染两次一样，并且和参考的画面不雷同
    checks, frames = [], []
    for d in demos:
        dst = path("scenes", d)
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(os.path.join(sdir, "demo", "scenes", d), dst)
        arr, errors = asyncio.run(capture(d, [0.5, 2.0, 4.0, 2.0], 960, 540, arrays=True))
        if errors:
            die(f"示范镜头 {d} 有页面错误：{'；'.join(errors[:3])}")
        if not np.array_equal(arr[1], arr[3]):
            die(f"示范镜头 {d} 同一时刻渲染两次结果不一样：画面只能由 t 决定（不要用 Math.random、Date.now、累加的状态）")
        if all(float(a.std()) < 2 for a in arr[:3]):
            die(f"示范镜头 {d} 画面是空的")
        frames += arr[:3]
        mp4 = os.path.join(review, "demo", f"{d}.mp4")
        if not os.path.exists(mp4):
            die(f"缺少示范镜头的视频 review/demo/{d}.mp4（用 slate-style frames {d} --range 0:<时长>:30 --mp4 渲染）")
    checks.append({"name": "示范镜头能渲染", "ok": True, "detail": f"{len(demos)} 个示范镜头都没有页面错误，同一时刻渲染两次结果一致"})
    small = lambda a: np.asarray(Image.fromarray(a).resize((vf.SW, vf.SH), Image.BILINEAR))  # noqa: E731
    re_ = [vf.edges(r) for r in vf.decode(reference(), 1, vf.SW, vf.SH)]
    near = max(((vf.corr(vf.edges(small(f)), e), i) for f in frames for i, e in enumerate(re_)), default=(0.0, 0))
    if near[0] >= SIMILAR:
        die(f"示范镜头和参考视频第 {near[1]} 秒的画面太像（轮廓相关系数 {near[0]:.2f}）：示范镜头要换成新的题材和构图，不要照搬参考的画面")
    checks.append({"name": "没有照搬参考画面", "ok": True,
                   "detail": f"示范镜头和参考视频最接近的一帧轮廓相关系数 {near[0]:.2f}（{SIMILAR} 以上算照搬）"})
    checks.append({"name": "格式", "ok": True, "detail": "frontmatter、文件大小、文件类型、没有外部地址"})
    seg_ok = [s for s in segs if (load_json(os.path.join(review, "recon", s["id"], "scores.json")) or {}).get("motion", 0) >= 0.8]
    checks.append({"name": "动作节奏对得上", "ok": len(seg_ok) == len(segs), "detail": f"{len(seg_ok)} / {len(segs)} 段重建的动作曲线相关系数在 0.8 以上"})
    # 缩略图：第一个示范镜头 40% 处
    thumb = os.path.join(review, "thumb.jpg")
    Image.fromarray(frames[1] if len(frames) > 1 else frames[0]).save(thumb, quality=88)
    vers = load_json(path("work", "versions.json"), []) or []
    n = len(vers) + 1
    base = ("style", f"v{n}")
    for root, _, files in os.walk(sdir):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), sdir)
            upload(os.path.join(root, f), *base, "skill", *rel.split(os.sep), content_type=_ctype(f))
    ev_segs = []
    for s in segs:
        sc = load_json(os.path.join(review, "recon", s["id"], "scores.json")) or {}
        rel = ("review", "recon", s["id"])
        for f in ("side.mp4", "cmp.png", "motion.png", "scores.json"):
            if os.path.exists(os.path.join(review, "recon", s["id"], f)):
                upload(os.path.join(review, "recon", s["id"], f), *base, *rel, f, content_type=_ctype(f))
        ev_segs.append({"id": s["id"], "desc": str(s.get("desc") or "")[:120], "structure": sc.get("structure"), "motion": sc.get("motion"),
                        "paletteDeltaE": sc.get("paletteDeltaE"), "peakLag": (sc.get("peakLag") or {}).get("median"),
                        "side": "/".join(rel + ("side.mp4",)), "cmp": "/".join(rel + ("cmp.png",))})
    ev_demos = []
    titles = {x.get("id"): x.get("title") for x in rv.get("demos") or [] if isinstance(x, dict)}
    for d in demos:
        upload(os.path.join(review, "demo", f"{d}.mp4"), *base, "review", "demo", f"{d}.mp4", content_type="video/mp4")
        ev_demos.append({"id": d, "title": str(titles.get(d) or "")[:60], "url": f"review/demo/{d}.mp4"})
    ev_trials = []
    for i, t in enumerate(trials, 1):
        upload(os.path.join(review, t["file"]), *base, "review", "trial", f"T{i}.mp4", content_type="video/mp4")
        ev_trials.append({"label": str(t.get("label") or f"第 {i} 轮")[:40], "url": f"review/trial/T{i}.mp4",
                          "scores": {k: (t.get("scores") or {}).get(k) for k in ("color", "layout", "motion", "grammar")}, "notes": str(t.get("notes") or "")[:400]})
    upload(thumb, *base, "review", "thumb.jpg", content_type="image/jpeg")
    if os.path.exists(os.path.join(review, "report.md")):
        upload(os.path.join(review, "report.md"), *base, "review", "report.md", content_type="text/markdown; charset=utf-8")
    emit("style", n=n, segments=ev_segs, demos=ev_demos, trials=ev_trials, checks=checks, thumb="review/thumb.jpg")
    vers.append({"n": n, "at": int(time.time() * 1000)})
    os.makedirs(path("work"), exist_ok=True)
    json.dump(vers, open(path("work", "versions.json"), "w"), ensure_ascii=False, indent=1)
    return {"version": n, "checks": checks, "line": traits.get("line")}


def _ctype(f):
    return {".md": "text/markdown; charset=utf-8", ".json": "application/json", ".js": "application/javascript", ".mjs": "application/javascript",
            ".css": "text/css", ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
            ".svg": "image/svg+xml", ".mp4": "video/mp4"}.get(os.path.splitext(f)[1].lower(), "application/octet-stream")


# ---------------------------------------------------------------- 命令行

def main():
    ap = argparse.ArgumentParser(prog="slate-style", description="风格创建：拆帧、渲染、对比、冷启动试写、发布")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe"); p.add_argument("video", nargs="?"); p.add_argument("--out", default=path("work", "probe"))
    p.add_argument("--max-strips", type=int, default=16)
    f = sub.add_parser("frames"); f.add_argument("scene"); f.add_argument("--times"); f.add_argument("--range")
    f.add_argument("--out"); f.add_argument("--mp4"); f.add_argument("--size", default="960x540")
    c = sub.add_parser("compare"); c.add_argument("--seg", required=True); c.add_argument("--scene", required=True)
    c.add_argument("--out", required=True); c.add_argument("--fps", type=float, default=10); c.add_argument("--size", default="960x540")
    c.add_argument("--mp4", action="store_true")
    t = sub.add_parser("trial"); t.add_argument("--scene", default="T1"); t.add_argument("--dur", type=float, default=6)
    t.add_argument("--brief", required=True)
    sub.add_parser("export")
    ls = sub.add_parser("listen"); ls.add_argument("--out", default=path("work", "listen.json"))
    tw = sub.add_parser("trial-writing"); tw.add_argument("--topic", required=True); tw.add_argument("--dur", type=float, default=60)
    sub.add_parser("export-writing")
    a = ap.parse_args()
    t0 = time.time()
    if a.cmd == "probe":
        try:
            res = vf.probe(a.video or reference(), a.out, a.max_strips)
        except RuntimeError as e:
            die(str(e))
        print(json.dumps({k: res[k] for k in ("duration", "width", "height", "fps", "stats", "palette")}, ensure_ascii=False))
        print(f"镜头 {len(res['shots'])} 个，关键帧 {len(res['keys'])} 张，联系表 {len(res['sheets'])} 张，动作条 {len(res['strips'])} 条 → {a.out}")
    elif a.cmd == "frames":
        if not (a.times or a.range) or not (a.out or a.mp4):
            die("要给 --times 或 --range，以及 --out 或 --mp4")
        w, h = size_of(a.size)
        fps = int(round(float(a.range.split(":")[2]))) if a.range else 30
        if a.out:
            os.makedirs(a.out, exist_ok=True)
        files, errors = asyncio.run(capture(a.scene, times_of(a), w, h, png_dir=a.out, mp4=a.mp4, fps=fps))
        print(json.dumps({"files": files if len(files) <= 40 else files[:3] + ["…"] + files[-3:], "count": len(files),
                          "page_errors": errors, "seconds": round(time.time() - t0, 1)}, ensure_ascii=False))
    elif a.cmd == "compare":
        sc = compare(a.seg, a.scene, a.out, a.fps, a.size, a.mp4)
        print(json.dumps({k: v for k, v in sc.items() if k != "palette"} | {"seconds": round(time.time() - t0, 1)}, ensure_ascii=False))
    elif a.cmd == "trial":
        print(json.dumps({"file": trial(a.scene, a.dur, a.brief), "seconds": round(time.time() - t0, 1)}, ensure_ascii=False))
    elif a.cmd == "listen":
        print(json.dumps(listen(a.out) | {"seconds": round(time.time() - t0, 1)}, ensure_ascii=False))
    elif a.cmd == "trial-writing":
        print(json.dumps(trial_writing(a.topic, a.dur) | {"seconds": round(time.time() - t0, 1)}, ensure_ascii=False))
    elif a.cmd == "export-writing":
        print(json.dumps(export_writing(), ensure_ascii=False))
    else:
        print(json.dumps(export(), ensure_ascii=False))


if __name__ == "__main__":
    main()
