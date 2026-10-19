"""模型调用（docs/model-keys-design.md）：整个平台只有一个模型来源，现在是部署账号的 IAM 角色（Amazon Bedrock）。

- 主 Agent 经 Harness 调用，用 Harness 执行角色上的权限；看图、核对文字、看视频经 llm Lambda 调用，用它自己的角色。
  两个角色上调用模型的权限是同一个托管策略（<栈名>-models），改它就同时管住所有模型调用，和调用其他 AWS 服务的策略分开；
- 每个用途有主模型和备用模型：被内容安全策略拦下时换下一个模型（next_model）；调不通就报错，没有别的来源可换。
- 跨账号使用模型时改用 OpenAI 兼容接口，经模型网关（还没做，见设计文档），平台里不再存模型的 Key。

任务表的 CONFIG#models 条目现在只记 MiniMax 配音 Key 的掩码和测试结果（Key 本身在 Secrets Manager，只有配音 Lambda 读得到）。
"""
import os, time

from . import common as c

KEY = {"pk": "CONFIG#models", "sk": "META"}
PURPOSES = {"agent": "主 Agent（写稿、分镜、动画代码）", "vision": "看图自检、核对文字", "video": "看视频（风格创建听旁白）"}
VISION_MODELS = (os.environ.get("SLATE_VISION_MODEL", "global.anthropic.claude-sonnet-5-5"),
                 os.environ.get("SLATE_VISION_FALLBACK", "global.anthropic.claude-opus-4-8"))
VIDEO_MODEL = "us.twelvelabs.pegasus-1-5-v1:0"
NAMES = {"global.anthropic.claude-opus-5-5": "Claude Opus 5.5", "global.anthropic.claude-opus-4-8": "Claude Opus 4.8",
         "global.anthropic.claude-sonnet-5-5": "Claude Sonnet 5.5", "global.openai.gpt-6-astra": "GPT-6 Astra",
         VIDEO_MODEL: "TwelveLabs Pegasus 1.5"}
IAM = "本账号 IAM 角色"
_cache = [0.0, None]


def load(fresh=False):
    """读配置；Lambda 内缓存 30 秒"""
    if not fresh and _cache[1] is not None and time.time() - _cache[0] < 30:
        return _cache[1]
    item = c.plain(c.table().get_item(Key=KEY).get("Item") or {})
    cfg = {"minimax": item.get("minimax"), "updatedAt": item.get("updatedAt"), "updatedBy": item.get("updatedBy")}
    _cache[:] = [time.time(), cfg]
    return cfg


def save(cfg, who):
    item = {**KEY, "minimax": cfg.get("minimax"), "updatedAt": c.now_ms(), "updatedBy": who}
    c.table().put_item(Item=c.ddb_safe(item))
    _cache[:] = [0.0, None]


def model_list(purpose):
    """这个用途的主模型和备用模型（Bedrock 上的推理配置 ID）"""
    return {"agent": list(c.MODELS), "vision": list(VISION_MODELS), "video": [VIDEO_MODEL]}[purpose]


def label(model):
    return NAMES.get(model, model)


def chain(purpose, cfg=None):
    """这个用途按顺序尝试的模型：主模型在前，备用模型在后。turn 里的 modelIndex 指向主 Agent 的这个列表"""
    return [{"kind": "bedrock", "src": "iam", "name": IAM, "model": m} for m in model_list(purpose)]


def agent_chain(cfg=None):
    return chain("agent", cfg)


def next_model(ch, i, filtered=()):
    """第 i 项被内容安全策略拦下：往后找第一个还没被拦过的模型。没有了返回 None"""
    bad = {*filtered, ch[i]["model"]}
    return next((j for j in range(i + 1, len(ch)) if ch[j]["model"] not in bad), None)


def mask(key):
    key = (key or "").strip()
    if len(key) <= 10:
        return "•" * len(key)
    head = key[:6] if key.startswith("sk-") else key[:4]
    return f"{head}{'•' * 12}{key[-4:]}"
