"""验证 Harness 上的提示缓存：同一条消息分别用"不加参数"和"加 additionalParams"跑一轮，比较每次模型调用的缓存读写 token。

用法：python scripts/test_cache.py '<additionalParams 的 JSON>'
例如：python scripts/test_cache.py '{"cache_control": {"type": "ephemeral"}}'
"""
import json, os, sys, uuid

import boto3
from botocore.config import Config

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = json.load(open(os.path.join(ROOT, ".slate", "outputs-Slate.json")))["Slate"]
dp = boto3.client("bedrock-agentcore", region_name="us-east-1", config=Config(read_timeout=600))
FILLER = "以下是一段背景资料，只用于凑足长度，不需要处理。" + "数据可视化的核心是把数字变成人能一眼看懂的图形，好的图表只突出一个结论。" * 220
PROMPT = FILLER + "\n\n这是一次连通性检查，不需要做视频。请依次用 shell 执行 `echo 1`、`echo 2`、`echo 3`（每条单独调用一次），然后只回复“完成”。"


def run(params):
    sid = f"slate-cache-check-{uuid.uuid4()}"
    model = {"bedrockModelConfig": {"modelId": "global.anthropic.claude-opus-5-5", "maxTokens": 4000}}
    if params:
        model["bedrockModelConfig"]["additionalParams"] = params
    r = dp.invoke_harness(harnessArn=out["HarnessArn"], runtimeSessionId=sid, runtimeUserId="cache-check",
                          messages=[{"role": "user", "content": [{"text": PROMPT}]}], model=model, allowedTools=["@builtin"])
    calls = []
    for ev in r["stream"]:
        if "metadata" in ev:
            u = ev["metadata"]["usage"]
            calls.append((u.get("inputTokens"), u.get("cacheReadInputTokens", 0), u.get("cacheWriteInputTokens", 0), u.get("outputTokens")))
        for k in ("validationException", "internalServerException", "runtimeClientError"):
            if k in ev:
                print("ERROR", k, ev[k]); return
    for i, c in enumerate(calls, 1):
        print(f"  第 {i} 次模型调用：输入 {c[0]:>6}  缓存读取 {c[1]:>6}  缓存写入 {c[2]:>6}  输出 {c[3]}")
    # 结束会话，不留空闲实例
    try:
        dp.stop_runtime_session(agentRuntimeArn=out["HarnessArn"], runtimeSessionId=sid)
    except Exception:
        pass


if __name__ == "__main__":
    p = json.loads(sys.argv[1]) if len(sys.argv) > 1 else None
    print("additionalParams =", p)
    run(p)
