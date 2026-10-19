"""slate-voice NN "<旁白>" [--voice 音色] [--emotion 情绪] [--speed 语速]：生成一镜的配音和逐字时间轴。

音色在 /opt/slate/voices.json 里（MiniMax 中国区），通过 voice Lambda 合成，API Key 不在会话里。
MiniMax 失败时自动退回 Amazon Polly 的 Zhiyu。
输出 voice/NN.mp3 和 voice/NN.json（duration、words、captions），并打印建议的镜头时长。
"""
import argparse, base64, json, os, re

import boto3

from .common import OPT, REGION, ctx, die, load_json, media_duration, path, spec

PUNCT = "，。！？；：、,.!?;:…"
VOICES = {"Zhiyu": ("cmn-CN", "neural")}
CATALOG = os.path.join(OPT, "voices.json")
DEFAULT_VOICE = "warm-bestie"
# 旁白里给 MiniMax 的控制标记：语气词 (laughs)、停顿 <#0.5#>。字幕里要去掉
TAG = re.compile(r"\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)|<#[0-9.]+#>")


def split_captions(text, duration, max_chars=None):
    """没有逐字时间轴时：按标点和字数把旁白切成若干行，按字数比例平均铺满 duration。"""
    lines = _break_lines([(ch, None) for ch in text], max_chars or _max_chars())
    total = sum(len(l) for l in lines) or 1
    out, t = [], 0.0
    for l in lines:
        d = duration * len(l) / total
        out.append({"start": round(t, 3), "end": round(t + d, 3), "text": l})
        t += d
    return out


def _max_chars():
    s = spec()
    return 16 if s["w"] >= s["h"] else 12


def _break_lines(units, max_chars):
    """units: [(文字, 起始秒或 None)]；返回切好的行（去掉行尾标点）。"""
    lines, cur = [], ""
    for txt, _ in units:
        for ch in txt:
            if ch in PUNCT:
                if cur.strip():
                    lines.append(cur.strip())
                cur = ""
            else:
                cur += ch
                if len(cur) >= max_chars:
                    lines.append(cur.strip()); cur = ""
    if cur.strip():
        lines.append(cur.strip())
    return [l for l in lines if l]


def captions_from_marks(text, marks, duration, max_chars):
    """用 Polly 的 word 时间轴切字幕：在标点处或超过 max_chars 时换行，每行从第一个字的时间开始。"""
    raw = text.encode("utf-8")
    lines, cur, cur_start = [], "", None
    for i, m in enumerate(marks):
        word = m["value"]
        if cur_start is None:
            cur_start = m["time"] / 1000
        cur += word
        after = raw[m["end"]:m["end"] + 4].decode("utf-8", "ignore")[:1]
        if (after and after in PUNCT) or len(cur) >= max_chars or i == len(marks) - 1:
            lines.append([cur_start, cur.strip()]); cur, cur_start = "", None
    out = []
    for i, (st, tx) in enumerate(lines):
        end = lines[i + 1][0] if i + 1 < len(lines) else duration
        out.append({"start": round(st, 3), "end": round(end, 3), "text": tx})
    return out


def catalog():
    return load_json(CATALOG, []) or []


def find(voice):
    """音色可以写目录里的 id、中文名或 MiniMax 的 voice_id；找不到返回 None"""
    for v in catalog():
        if voice and voice.strip() in (v["id"], v["name"], v["voice_id"]):
            return v
    return None


def captions_from_words(text, words, duration, max_chars):
    """用 MiniMax 的逐字时间切字幕：在标点处或超过 max_chars 时换行，每行从第一个字的时间开始。语气词标记不进字幕"""
    words = [w for w in words if not TAG.fullmatch(w["w"].strip())]
    lines, cur, cur_start = [], "", None
    for i, w in enumerate(words):
        if cur_start is None:
            cur_start = w["t0"] / 1000
        cur += w["w"]
        rest = text[w["e"]:]
        while (m := TAG.match(rest)):  # 跳过紧跟着的语气词、停顿标记，再看是不是标点
            rest = rest[m.end():]
        after = rest[:1]
        if (after and after in PUNCT) or len(cur) >= max_chars or i == len(words) - 1:
            line = TAG.sub("", cur).strip().strip(PUNCT).strip()
            if line:
                lines.append([cur_start, line])
            cur, cur_start = "", None
    out = []
    for i, (st, tx) in enumerate(lines):
        end = lines[i + 1][0] if i + 1 < len(lines) else duration
        out.append({"start": round(st, 3), "end": round(end, 3), "text": tx})
    return out


def synth_minimax(scene_id, text, v, emotion=None, speed=None):
    fn = os.environ.get("SLATE_VOICE_FN")
    if not fn:
        raise RuntimeError("没有配置 voice Lambda")
    payload = {"text": text, "voice_id": v["voice_id"], "emotion": emotion, "speed": speed, "language_boost": v.get("language_boost"),
               "billing": {"taskId": ctx().get("taskId"), "chapter": ctx().get("chapter"), "token": ctx().get("billToken")}}  # 配音按字数计费，记在这个任务上
    r = boto3.client("lambda", region_name=REGION).invoke(FunctionName=fn, Payload=json.dumps(payload).encode())
    res = json.loads(r["Payload"].read())
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or "voice Lambda 调用失败")
    os.makedirs(path("voice"), exist_ok=True)
    mp3 = path("voice", f"{scene_id}.mp3")
    open(mp3, "wb").write(base64.b64decode(res["audio_b64"]))
    dur = media_duration(mp3)
    caps = captions_from_words(text, res["words"], dur, _max_chars())
    info = {"scene": scene_id, "voice": v["id"], "provider": "minimax", "emotion": emotion, "text": text,
            "duration": round(dur, 3), "words": [{"t": w["t0"] / 1000, "v": w["w"]} for w in res["words"]], "captions": caps}
    json.dump(info, open(path("voice", f"{scene_id}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return info


def synth(scene_id, text, voice="Zhiyu", rate=None):
    lang, engine = VOICES.get(voice, VOICES["Zhiyu"])
    polly = boto3.client("polly", region_name=REGION)
    ssml = None
    if rate:
        from xml.sax.saxutils import escape
        ssml = f'<speak><prosody rate="{rate}">{escape(text)}</prosody></speak>'
    kw = dict(VoiceId=voice, Engine=engine, LanguageCode=lang, Text=ssml or text, TextType="ssml" if ssml else "text")
    audio = polly.synthesize_speech(OutputFormat="mp3", SampleRate="24000", **kw)["AudioStream"].read()
    marks_raw = polly.synthesize_speech(OutputFormat="json", SpeechMarkTypes=["word"], **kw)["AudioStream"].read().decode()
    marks = [json.loads(l) for l in marks_raw.splitlines() if l.strip()]
    if ssml:  # SSML 模式下偏移量对应 SSML 文本；减去前缀换算回原文
        off = len(f'<speak><prosody rate="{rate}">'.encode())
        for m in marks:
            m["start"] -= off; m["end"] -= off
    os.makedirs(path("voice"), exist_ok=True)
    mp3 = path("voice", f"{scene_id}.mp3")
    open(mp3, "wb").write(audio)
    dur = media_duration(mp3)
    caps = captions_from_marks(text, marks, dur, _max_chars())
    info = {"scene": scene_id, "voice": voice, "text": text, "duration": round(dur, 3),
            "words": [{"t": m["time"] / 1000, "v": m["value"]} for m in marks], "captions": caps}
    json.dump(info, open(path("voice", f"{scene_id}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return info


def main():
    ap = argparse.ArgumentParser(prog="slate-voice", description="生成一镜的配音和逐字时间轴")
    ap.add_argument("scene", help="镜头编号，如 01")
    ap.add_argument("text", help="这一镜的旁白")
    ap.add_argument("--voice", help=f"音色 id 或中文名（见 {CATALOG}），默认用 brief.json 里的 voice，再没有就用 {DEFAULT_VOICE}")
    ap.add_argument("--emotion", choices=["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent"],
                    help="情绪；不填时模型按文字自己判断")
    ap.add_argument("--speed", type=float, help="语速倍数，0.5～2，默认 1")
    ap.add_argument("--rate", help="（只对备用的 Polly 音色有效）语速，如 90%% 或 110%%")
    a = ap.parse_args()
    text = a.text.strip()
    if not TAG.sub("", text).strip():
        die("旁白为空")
    if a.voice:
        voice = a.voice
        v = find(voice)
        if v is None and voice not in VOICES:
            die(f"没有这个音色：{voice}。可用音色见 {CATALOG}")
    else:  # 没指定时用 brief.json 里的 voice；那里写的不是音色名，就用默认音色
        voice = (load_json(path("brief.json"), {}) or {}).get("voice") or DEFAULT_VOICE
        v = find(voice) or (None if voice in VOICES else find(DEFAULT_VOICE))
    note = None
    if v:
        try:
            info = synth_minimax(a.scene, text, v, a.emotion, a.speed)
        except Exception as e:
            note = f"MiniMax 配音失败（{str(e)[:120]}），已改用备用音色 Zhiyu"
            info = synth(a.scene, TAG.sub("", text).strip(), "Zhiyu", a.rate)
    else:
        info = synth(a.scene, TAG.sub("", text).strip(), voice, a.rate)
    suggest = round(max(info["duration"] + 0.8, 2.5), 1)
    out = {"scene": a.scene, "voice": info["voice"], "voice_seconds": info["duration"], "suggested_duration": suggest,
           "captions": len(info["captions"]), "file": f"voice/{a.scene}.mp3"}
    if note:
        out["note"] = note
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
