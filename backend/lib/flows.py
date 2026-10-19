"""工作流模式（docs/workflow-mode-design.md）：画板和"我的工作流"的存取。

记录是 pk=FLOW#<用户>、sk=F#<编号>，和任务在同一张表里：
- kind=template：我的工作流。只有节点、连线和每个节点的设置，不带任务；
- kind=canvas：画板。第一次运行节点时创建，之后前端改动就自动保存；节点上带着它建的任务编号（文字和音画共用一个视频任务）。

节点的设置（cfg）由前端解释，这里只检查结构和大小。画板只是界面状态：任务本身照常在任务列表里，删掉画板不影响任务。
"""
import hashlib, json, re

from boto3.dynamodb.conditions import Key

from . import common as c
from .common import ApiError

NODE_MAX = {"text": 1, "image": 3, "av": 1}
NODE_NAME = {"text": "文字", "image": "图片", "av": "音画"}
PORTS = ("text", "img")
KINDS = ("template", "canvas")
DOC_MAX_BYTES = 60000
CANVAS_KEEP = 100   # 画板最多留这么多个，超出时删掉最久没动的（任务不受影响）
TEMPLATE_MAX = 100
ID_RE = r"[0-9a-f-]{36}"
KEY_RE = r"[A-Za-z0-9_-]{1,40}"


def _key(sub, fid):
    return {"pk": f"FLOW#{sub}", "sk": f"F#{fid}"}


def clean_doc(doc, template=False):
    """检查画板内容：节点个数（文字、音画各 1 个，图片最多 3 个）、连线只能连到音画节点、整体不超过 60 KB。
    template=True 时去掉节点上的任务编号（我的工作流不带产出）。返回 JSON 字符串"""
    if not isinstance(doc, dict):
        raise ApiError(400, "bad_flow", "工作流的格式不对")
    nodes, edges = doc.get("nodes") or [], doc.get("edges") or []
    if not isinstance(nodes, list) or not isinstance(edges, list) or len(nodes) > sum(NODE_MAX.values()):
        raise ApiError(400, "bad_flow", "工作流的节点太多了")
    out, count = [], {}
    for n in nodes:
        if not isinstance(n, dict) or n.get("type") not in NODE_MAX or not re.fullmatch(KEY_RE, str(n.get("k") or "")):
            raise ApiError(400, "bad_flow", "工作流里有不认识的节点")
        t = n["type"]
        count[t] = count.get(t, 0) + 1
        if count[t] > NODE_MAX[t]:
            raise ApiError(400, "bad_flow", f"{NODE_NAME[t]}节点最多 {NODE_MAX[t]} 个")
        try:
            x, y = (max(-1e5, min(1e5, round(float(n.get(a) or 0)))) for a in ("x", "y"))
        except (TypeError, ValueError):
            raise ApiError(400, "bad_flow", "节点位置不对")
        cfg = n.get("cfg") or {}
        if not isinstance(cfg, dict):
            raise ApiError(400, "bad_flow", "节点设置的格式不对")
        item = {"k": n["k"], "type": t, "x": x, "y": y, "cfg": cfg}
        if not template and n.get("task"):
            if not re.fullmatch(ID_RE, str(n["task"])):
                raise ApiError(400, "bad_flow", "节点关联的任务编号不对")
            item["task"] = str(n["task"])
        out.append(item)
    keys = {n["k"]: n["type"] for n in out}
    links = []
    for e in edges:
        if not (isinstance(e, list) and len(e) == 3 and e[0] in keys and e[1] in keys and e[2] in PORTS):
            continue
        a, b, p = e
        if keys[b] != "av" or keys[a] != ("text" if p == "text" else "image") or [a, b, p] in links:
            continue
        links.append([a, b, p])
    s = json.dumps({"nodes": out, "edges": links}, ensure_ascii=False, separators=(",", ":"))
    if len(s.encode()) > DOC_MAX_BYTES:
        raise ApiError(413, "flow_too_big", "工作流的内容太多了，减少一些资料或描述再保存")
    return s


def _name(v):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:40] or "未命名工作流"


def _brief(doc):
    """列表里用的精简内容：节点类型、位置和几个主要设置（画缩略图和一行摘要用）"""
    keep = ("genre", "dur", "main", "voice", "ratio", "mode")
    return {"nodes": [{**{k: n[k] for k in ("k", "type", "x", "y")}, "task": n.get("task"),
                       "cfg": {k: n["cfg"].get(k) for k in keep if k in n["cfg"]}} for n in doc["nodes"]],
            "edges": doc["edges"]}


def _view(it, full=True):
    doc = json.loads(it.get("doc") or '{"nodes":[],"edges":[]}')
    return {"id": it["id"], "kind": it["kind"], "name": it["name"], "createdAt": it.get("createdAt"), "updatedAt": it.get("updatedAt"),
            "doc": doc if full else _brief(doc)}


def _all(sub):
    out, kw = [], dict(KeyConditionExpression=Key("pk").eq(f"FLOW#{sub}") & Key("sk").begins_with("F#"))
    while True:
        r = c.table().query(**kw)
        out += [c.plain(i) for i in r.get("Items", [])]
        if "LastEvaluatedKey" not in r:
            return out
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def list_of(sub):
    items = sorted(_all(sub), key=lambda x: -int(x.get("updatedAt") or 0))
    return [_view(i, full=False) for i in items]


def get(sub, fid):
    it = c.table().get_item(Key=_key(sub, fid)).get("Item")
    if not it:
        raise ApiError(404, "not_found", "这个工作流不存在，可能已经删除了")
    return c.plain(it)


def view(sub, fid):
    return _view(get(sub, fid))


def create(sub, body):
    kind = body.get("kind")
    if kind not in KINDS:
        raise ApiError(400, "bad_flow", "工作流的类型不对")
    doc = clean_doc(body.get("doc") or {}, template=kind == "template")
    items = _all(sub)
    same = sorted((x for x in items if x.get("kind") == kind), key=lambda x: int(x.get("updatedAt") or 0))
    if kind == "template" and len(same) >= TEMPLATE_MAX:
        raise ApiError(400, "too_many_flows", f"我的工作流最多 {TEMPLATE_MAX} 个，先删掉一些再保存")
    for old in same[:max(0, len(same) - CANVAS_KEEP + 1)] if kind == "canvas" else []:
        c.table().delete_item(Key=_key(sub, old["id"]))
    fid, now = c.new_id(), c.now_ms()
    c.table().put_item(Item={**_key(sub, fid), "id": fid, "kind": kind, "name": _name(body.get("name")), "doc": doc,
                             "createdAt": now, "updatedAt": now})
    return {"id": fid, "updatedAt": now}


def update(sub, fid, body):
    it = get(sub, fid)
    sets, names, values = ["updatedAt = :now"], {}, {":now": c.now_ms()}
    if "name" in body:
        sets.append("#n = :n"); names["#n"] = "name"; values[":n"] = _name(body["name"])
    if "doc" in body:
        sets.append("#d = :d"); names["#d"] = "doc"; values[":d"] = clean_doc(body["doc"] or {}, template=it["kind"] == "template")
    kw = dict(Key=_key(sub, fid), UpdateExpression="SET " + ", ".join(sets), ExpressionAttributeValues=values)
    if names:
        kw["ExpressionAttributeNames"] = names
    c.table().update_item(**kw)
    return {"ok": True, "updatedAt": values[":now"]}


def remove(sub, fid):
    get(sub, fid)
    c.table().delete_item(Key=_key(sub, fid))
    return {"ok": True}


# ---------- 成片和分镜的对应（音画节点"需要重跑"） ----------

def scene_sig(sb):
    """每镜的指纹：旁白、画面描述、风格和用到的图片。出成片时记在版本里，之后分镜改了哪几镜和它一比就知道"""
    out = {}
    for x in (sb or {}).get("scenes") or []:
        raw = "\n".join(str(x.get(k) or "") for k in ("narration", "visual", "skill")) + ("\n" + ",".join(x["images"]) if x.get("images") else "")
        out[str(x.get("id"))] = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    return out


def changed_scenes(task):
    """最新的分镜和最新一版成片相比改了哪几镜：(改过或新加的镜头, 去掉的镜头)。还没有成片、或者老版本没记指纹时都是空的"""
    vs = task.get("versions") or []
    old = vs[-1].get("sb") if vs else None
    if not old:
        return [], []
    now = scene_sig((task.get("docs") or {}).get("storyboard"))
    return [k for k, v in now.items() if old.get(k) != v], [k for k in old if k not in now]


def node_of(task):
    """工作流任务里这一轮（或最近一轮）属于哪个节点：text / av；不是工作流任务时是 None"""
    if not (task.get("request") or {}).get("flow"):
        return None
    return task.get("flowNode") or "text"
