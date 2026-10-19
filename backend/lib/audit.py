"""操作日志：管理员的修改，以及系统自动做的切换（比如 API Key 失效后退回 IAM 角色）。
都写在任务表的 AUDIT 分区里，按时间排序；只读不删，保留 3 年（TTL）。"""
import secrets

from . import common as c

RETAIN_DAYS = 3 * 366


def write(who, act, obj, detail=""):
    ts = c.now_ms()
    c.table().put_item(Item={"pk": "AUDIT", "sk": f"{ts}#{secrets.token_hex(3)}", "at": ts, "who": who, "act": act,
                             "obj": str(obj)[:200], "detail": str(detail)[:500], "ttl": ts // 1000 + RETAIN_DAYS * 86400})


def recent(limit=200, before=None):
    from boto3.dynamodb.conditions import Key
    cond = Key("pk").eq("AUDIT") & (Key("sk").lt(str(before)) if before else Key("sk").gt("0"))
    r = c.table().query(KeyConditionExpression=cond, ScanIndexForward=False, Limit=limit)
    return [c.plain(x) for x in r.get("Items", [])]
