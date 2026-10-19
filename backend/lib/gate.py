"""输出把关（在沙箱外执行）：Agent 发给用户的文字，不能包含平台内部资料。

- 标识串：系统提示词和每个 Skill 里各有一个版本标识，出现即拦截；
- 内容重合：和系统提示词、Skill 文件（SKILL.md、组件代码等）存在连续 16 个字符以上的相同片段即拦截。
平台资料在部署时打包进 lib/protected/（由 CDK 从 agent/prompts 和 agent/skills 复制）。
管理员生成的风格内测发布时写进数据桶的 styles/protected/（docs/style-creator-design.md），这里每 5 分钟重新读一次。
"""
import json, os, re, time

HERE = os.path.dirname(os.path.abspath(__file__))
PROTECTED = os.path.join(HERE, "protected")
WINDOW = 16
CANARY = os.environ.get("CANARY", "")
_corpus = None
_styles = (0.0, frozenset())  # (读取时间, 生成风格的片段)
STYLES_TTL = 300
# 影片风格和素材库的来源项目名：不出现在给用户的文字里
THIRD_PARTY = re.compile(r"(?<!guil)lemo(?!n)|opuscar|lemomo|hyper-?frames|heygen", re.I)


def _norm(s):
    return re.sub(r"\s+", "", s or "")


def _load():
    global _corpus
    if _corpus is not None:
        return _corpus
    grams = set()
    for root, _, files in os.walk(PROTECTED):
        if os.sep + "example" in root or os.sep + "demo" in root:  # 示例场景、示范片源码是通用内容，也太大
            continue
        if os.sep + "kit-" in root:  # 素材库（镜头模板、动作）来自开源素材，Agent 写分镜时会引用里面的名称和说明，不算内部资料
            continue
        for f in files:
            if not f.endswith((".md", ".js", ".css", ".html", ".txt")) or f == "formats.md":
                continue
            text = _norm(open(os.path.join(root, f), encoding="utf-8", errors="ignore").read())
            # frontmatter 的 description 会出现在前端 Skills 目录里，不算内部资料
            for i in range(0, max(0, len(text) - WINDOW + 1)):
                grams.add(text[i:i + WINDOW])
    allowed = set()
    for p in ("catalog.json", "genres.json"):  # 前端公开展示的目录，不算内部资料
        cp = os.path.join(HERE, p)
        if os.path.exists(cp):
            t = _norm(open(cp, encoding="utf-8").read())
            allowed.update(t[i:i + WINDOW] for i in range(0, max(0, len(t) - WINDOW + 1)))
    _corpus = grams - allowed
    return _corpus


def _grams(t):
    return {t[i:i + WINDOW] for i in range(0, max(0, len(t) - WINDOW + 1))}


def _style_corpus():
    """生成风格的说明书片段（一句话定位会出现在风格库里，不算）。读不到时沿用上次的"""
    global _styles
    if time.time() - _styles[0] < STYLES_TTL:
        return _styles[1]
    from . import common as c
    grams = set()
    if not c.DATA_BUCKET:
        return _styles[1]
    try:
        for page in c.s3.get_paginator("list_objects_v2").paginate(Bucket=c.DATA_BUCKET, Prefix="styles/protected/"):
            for o in page.get("Contents", []):
                d = json.loads(c.s3.get_object(Bucket=c.DATA_BUCKET, Key=o["Key"])["Body"].read())
                grams |= _grams(_norm(d.get("text"))) - _grams(_norm(d.get("allow")))
        _styles = (time.time(), frozenset(grams))
    except Exception as e:
        print("gate: 读不到生成风格的资料", repr(e)[:200])
        _styles = (time.time(), _styles[1])  # 过 5 分钟再试，不是每次检查都去读
    return _styles[1]


def check(text):
    """返回 None 表示通过；否则返回拦截原因。"""
    if not text:
        return None
    if CANARY and CANARY.lower() in text.lower():
        return "包含内部版本标识"
    if re.search(r"slate-(core|skill)-[0-9a-z]{6,}", text, re.I):
        return "包含内部版本标识"
    if THIRD_PARTY.search(text):
        return "包含第三方来源名称"
    t = _norm(text)
    corpus, generated = _load(), _style_corpus()
    for i in range(0, max(0, len(t) - WINDOW + 1)):
        if t[i:i + WINDOW] in corpus or t[i:i + WINDOW] in generated:
            return "包含平台内部资料片段"
    return None


def texts_of(obj):
    """把 JSON 里的所有字符串取出来拼成一段，用于把关。"""
    out = []

    def walk(o):
        if isinstance(o, str):
            out.append(o)
        elif isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(obj)
    return "\n".join(out)
