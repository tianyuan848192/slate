"""slate-look <图片…> --q "<问题>"：把图片交给视觉模型，返回文字结论。

Harness 的内置工具只返回文字，看不到图片；需要"看画面"时用这个命令。
通过 llm Lambda 调用，按管理端设的优先级挑来源（OpenAI 兼容接口、Bedrock API Key、IAM 角色），Key 不进会话；
Lambda 不可用或图片太大时，退回在会话里用 IAM 角色直接调 Bedrock。
常见用法：slate-look qa/03.png --q "这一镜的文字是否清楚、有没有挡住、配色是否符合白板风格？"
"""
import argparse, base64, io, json, os, sys

import boto3
from botocore.config import Config
from PIL import Image

from .common import REGION, ctx, die

MODEL = os.environ.get("SLATE_VISION_MODEL", "global.anthropic.claude-sonnet-5-5")
FALLBACK = os.environ.get("SLATE_VISION_FALLBACK", "global.anthropic.claude-opus-4-8")
SYSTEM = ("你在帮一个讲解视频和广告视频的制作团队看画面。只根据图片里实际看到的内容回答，"
          "用简体中文，具体到位置和元素；看不清就直说。")
# 看图模型会先思考再回答；上限太小时，问题一复杂就全用在思考上，返回空文字
MAX_TOKENS = 8000
EMPTY = f"（看图模型没有返回文字：输出上限 {MAX_TOKENS} 用完了。把问题拆小一点再问）"


def _image_block(p):
    im = Image.open(p).convert("RGB")
    if max(im.size) > 1600:
        im.thumbnail((1600, 1600))
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=88)
    return {"image": {"format": "jpeg", "source": {"bytes": buf.getvalue()}}}


def via_lambda(images, question):
    """交给 llm Lambda（它认本轮的计费令牌、查额度、记账）。线上一定走这条路：拒绝、出错、图片太大都直接报错，
    不退回用会话的角色直接调 Bedrock，否则就绕开了计费（安全扫描增量 #2）。只有本机调试、没有 Lambda 时返回 None"""
    fn = os.environ.get("SLATE_LLM_FN")
    if not fn:
        return None
    blocks = [{"b64": base64.b64encode(_image_block(p)["image"]["source"]["bytes"]).decode(), "format": "jpeg"} for p in images]
    names = "、".join(os.path.basename(p) for p in images)
    payload = json.dumps({"images": blocks, "question": f"图片依次是：{names}。\n{question}", "system": SYSTEM, "maxTokens": MAX_TOKENS,
                          "billing": {"taskId": ctx().get("taskId"), "chapter": ctx().get("chapter"), "token": ctx().get("billToken")}})  # 看图的 token 记在这个任务上
    if len(payload) > 5_500_000:  # 同步调用的请求体上限 6 MB
        die("图片太多或太大，一次看不了：分几次看，或者先缩小")
    try:
        # llm Lambda 最长跑 180 秒；默认 60 秒的读取超时会在模型还在想的时候断开
        r = boto3.client("lambda", region_name=REGION, config=Config(read_timeout=200, retries={"max_attempts": 1})).invoke(
            FunctionName=fn, Payload=payload.encode())
        res = json.loads(r["Payload"].read())
    except Exception as e:
        die(f"看图服务调不通：{repr(e)[:200]}。稍后再试")
    if not res.get("ok"):
        die(f"看图失败：{str(res.get('error') or '')[:200]}")
    return res.get("text") or EMPTY


def look(images, question):
    content = []
    for p in images:
        if not os.path.isfile(p):
            die(f"找不到图片 {p}")
        content += [{"text": f"图片 {os.path.basename(p)}："}, _image_block(p)]
    text = via_lambda(images, question)
    if text is not None:
        return text
    content.append({"text": question})
    br = boto3.client("bedrock-runtime", region_name=REGION, config=Config(read_timeout=300))
    for model in (MODEL, FALLBACK):
        r = br.converse(modelId=model, messages=[{"role": "user", "content": content}], system=[{"text": SYSTEM}],
                        inferenceConfig={"maxTokens": MAX_TOKENS})
        if r.get("stopReason") != "content_filtered":
            return "".join(b.get("text", "") for b in r["output"]["message"]["content"]) or EMPTY
    return "（看图模型没有返回结论，请换个问法再试）"


def main():
    ap = argparse.ArgumentParser(prog="slate-look", description="看图并回答问题")
    ap.add_argument("images", nargs="+")
    ap.add_argument("--q", required=True, help="要问的问题")
    a = ap.parse_args()
    print(look(a.images, a.q))


if __name__ == "__main__":
    main()
