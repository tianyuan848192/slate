"""生成音色试听：每个音色读同一句话，存成 web/voices/<id>.mp3，随前端一起部署（用户试听时不实时调用 MiniMax）。

API Key 取自环境变量 MINIMAX_API_KEY；没有的话读栈里的 Secrets Manager（./deploy.sh secret minimax 写入的那个）。
用法：python scripts/build_voice_previews.py [--force]   已经生成过的音色默认跳过
"""
import json, os, sys, time, urllib.request

import boto3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "voices")
SAMPLE = "大家好，今天由我来给你讲一个有趣的小知识。"
API = "https://api.minimax.cn/v1/t2a_v2"


def api_key():
    if os.environ.get("MINIMAX_API_KEY"):
        return os.environ["MINIMAX_API_KEY"]
    stack = os.environ.get("STACK", "Slate")
    arn = json.load(open(os.path.join(ROOT, ".slate", f"outputs-{stack}.json")))[stack]["MinimaxSecretArn"]
    return boto3.client("secretsmanager", region_name="us-east-1").get_secret_value(SecretId=arn)["SecretString"].strip()


def main():
    force = "--force" in sys.argv
    key = api_key()
    os.makedirs(OUT, exist_ok=True)
    voices = json.load(open(os.path.join(ROOT, "agent", "voices.json"), encoding="utf-8"))
    total = 0
    for v in voices:
        dst = os.path.join(OUT, f"{v['id']}.mp3")
        if os.path.isfile(dst) and not force:
            continue
        body = {"model": "speech-2.8-hd", "text": SAMPLE, "stream": False, "output_format": "hex",
                "voice_setting": {"voice_id": v["voice_id"], "speed": 1.0},
                "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1}}
        if v.get("language_boost"):
            body["language_boost"] = v["language_boost"]
        req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as r:
            d = json.loads(r.read())
        br = d.get("base_resp") or {}
        if br.get("status_code") != 0:
            print(f"{v['id']:18s} 失败：{br}")
            continue
        open(dst, "wb").write(bytes.fromhex(d["data"]["audio"]))
        ex = d.get("extra_info") or {}
        total += ex.get("usage_characters", 0)
        print(f"{v['id']:18s} {v['name']:8s} {ex.get('audio_length', 0) / 1000:.1f} 秒  {os.path.getsize(dst) // 1024} KB", flush=True)
        time.sleep(0.5)
    print(f"计费字符合计 {total}")


if __name__ == "__main__":
    main()
