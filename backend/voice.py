"""voice Lambda：替会话调用 MiniMax 中国区语音合成（由 slate-voice 同步调用）。

API Key 存在 Secrets Manager，只有这个函数能读，不进 Agent 的沙箱，也不进模型上下文。
请求：{"text", "voice_id", "model"?, "emotion"?, "speed"?, "language_boost"?}
返回：{"ok": true, "audio_b64", "duration_ms", "chars", "words": [{"w", "b", "e", "t0", "t1"}]}
     words 是逐字时间：b/e 是这个字在 text 里的字符位置，t0/t1 是毫秒。失败时 {"ok": false, "error"}。
"""
import base64, json, os, time, urllib.error, urllib.request

import boto3

API = os.environ.get("MINIMAX_API", "https://api.minimax.cn") + "/v1/t2a_v2"
MODEL = os.environ.get("MINIMAX_TTS_MODEL", "speech-2.8-hd")
EMOTIONS = {"happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent"}
MAX_CHARS = 3000
_key = [0.0, None]


def api_key():
    """Key 缓存 5 分钟：管理端换了 Key，几分钟内生效"""
    if _key[1] is None or time.time() - _key[0] > 300:
        s = boto3.client("secretsmanager").get_secret_value(SecretId=os.environ["MINIMAX_SECRET_ARN"])["SecretString"].strip()
        if not s or s.startswith("PLACEHOLDER"):
            raise RuntimeError("MiniMax API Key 还没配置（在管理端或用 ./deploy.sh secret minimax 填写）")
        _key[:] = [time.time(), s]
    return _key[1]


def post(url, body, timeout=90):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def synth(ev):
    text = str(ev.get("text") or "").strip()
    if not text or len(text) > MAX_CHARS:
        return {"ok": False, "error": f"旁白为空或超过 {MAX_CHARS} 字"}
    voice = {"voice_id": str(ev.get("voice_id") or ""), "speed": float(ev.get("speed") or 1.0)}
    if not voice["voice_id"]:
        return {"ok": False, "error": "缺少 voice_id"}
    voice["speed"] = min(2.0, max(0.5, voice["speed"]))
    if ev.get("emotion") in EMOTIONS:
        voice["emotion"] = ev["emotion"]
    body = {"model": ev.get("model") or MODEL, "text": text, "stream": False, "voice_setting": voice,
            "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1},
            "subtitle_enable": True, "subtitle_type": "word", "output_format": "hex"}
    if ev.get("language_boost"):
        body["language_boost"] = ev["language_boost"]
    for attempt in range(3):  # 限流和偶发超时重试两次
        try:
            d = post(API, body)
        except (urllib.error.URLError, TimeoutError) as e:
            err = f"网络错误：{e}"
        else:
            br = d.get("base_resp") or {}
            if br.get("status_code") == 0 and (d.get("data") or {}).get("audio"):
                break
            err = f"MiniMax 返回 {br.get('status_code')}：{br.get('status_msg')}"
            if br.get("status_code") not in (1000, 1001, 1002, 1039):
                return {"ok": False, "error": err}
        time.sleep(2 * (attempt + 1))
    else:
        return {"ok": False, "error": err}
    data, extra = d["data"], d.get("extra_info") or {}
    words = []
    if data.get("subtitle_file"):
        with urllib.request.urlopen(data["subtitle_file"], timeout=30) as r:
            for seg in json.loads(r.read()):
                for w in seg.get("timestamped_words") or []:
                    words.append({"w": w["word"], "b": w["word_begin"], "e": w["word_end"],
                                  "t0": round(w["time_begin"]), "t1": round(w["time_end"])})
    return {"ok": True, "audio_b64": base64.b64encode(bytes.fromhex(data["audio"])).decode(),
            "duration_ms": extra.get("audio_length"), "chars": extra.get("usage_characters"), "words": words}


def bill(ev, chars):
    """配音按 MiniMax 返回的计费字数记在发起调用的任务上。记账失败不影响配音结果"""
    import re
    from lib import billing
    from lib import common as c
    b = (ev or {}).get("billing") or {}
    tid = str(b.get("taskId") or "")
    if not chars or not re.fullmatch(r"[0-9a-f-]{36}", tid):
        return
    try:
        found = billing.find_session(c.session_id(tid, b.get("chapter")), c.now_ms())
        if found:
            task, turn = found
            billing.record(task, c.now_ms(), f"t-{c.new_id()}", "voice", turn, {"chars": int(chars)}, model=f"MiniMax {MODEL}",
                           billable=not turn["free"], note="安全策略误拦后自动重做，不计费" if turn["free"] else "")
    except Exception as e:
        print("voice billing failed", repr(e)[:300])


def handler(event, context):
    try:
        from lib import billing
        from lib import common as c
        task = c.billed_task((event or {}).get("billing"))  # 先认任务、查额度，再调 MiniMax（第二次扫描 #1、#14）
        if not task:
            return {"ok": False, "error": "这次调用没有带上本轮的计费凭证"}
        billing.check_quota(task["sub"])
        res = synth(event or {})
        if res.get("ok"):
            bill(event, res.get("chars"))
        return res
    except Exception as e:  # 让调用方退回 Polly，而不是整轮失败
        print("voice error", repr(e))
        return {"ok": False, "error": str(e)[:300]}
