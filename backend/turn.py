"""turn Lambda：开始一轮 Harness 调用（由 api Lambda 或 finish Lambda 异步调用）。

1. 签发本任务范围的临时凭证，连同任务上下文写进会话；执行 slate-sync pull 恢复工作区；
2. 调用 InvokeHarness，读到这一轮真正开始（或很快结束）就断开。Harness 会继续跑完这一轮，
   结束后由 afterInvocation hook 触发 finish Lambda 收尾。
"""
import json, os, secrets, shlex, time, traceback

from botocore.exceptions import ClientError

from lib import common as c
from lib import billing, models
from lib import chapters as chs
from lib.validate import agent_brief, chapter_brief

READ_SECONDS = 50  # 只读这么久：用来发现启动阶段就出现的错误


def chapter_message(task, ch, turn):
    """章节会话的消息：说明这是长片的第几章，附上这一章的讲稿和全片的视觉规范"""
    brief = json.dumps(chapter_brief(task, ch), ensure_ascii=False, indent=1)
    kind = turn["kind"]
    head = (f"这是一支长片的第 {ch} 章，由你单独负责（做片手册第 10 节）。先加载 core-director，然后按第 10 节「各章会话」的要求，"
            "从这一章的分镜开始，一直做到 slate-compose 合成本章。工作区 /root/task 里有主会话留下的 brief.json、outline.json、script.json 和 shared/。"
            "讲稿以下面这份为准（用户确认时可能改过）。\n\n```json\n" + brief + "\n```")
    if kind == "revise":
        scope = turn.get("scope") or "all"
        hint = f"只改本章第 {scope} 镜" if scope != "all" else "范围是本章全部"
        return (f"这是长片第 {ch} 章的修改（{hint}）。用户原话或修改要求：{turn.get('text') or ''}\n"
                "按做片手册第 6 节处理：先发改动计划，再修改，最后重新运行 slate-compose 合成本章（不要发布整片版本，整片由系统拼接）。\n\n"
                "本章背景：\n```json\n" + brief + "\n```")
    if kind == "retry":
        return (f"长片第 {ch} 章上一轮没有完成，原因：{turn.get('text') or '未知'}。先用 slate-sync pull 确认工作区完整，找到原因并修复，"
                "然后继续做完这一章。\n\n" + head)
    if kind == "continue":
        return "请继续完成这一章（如果工作区文件缺失，先运行 slate-sync pull --force）。\n\n" + head
    return head


def message_for(task, turn):
    body = _body(task, turn)
    if turn["kind"] == "start":
        return body
    # 会话可能已被回收（对话历史随之丢失），后续每一轮都带上原始任务说明，让 Agent 能接着做
    if c.product_of(task) == "model3d":
        where = "先加载 core-model3d；工作区 /root/task 已从存档恢复，先看 model/ 下的规格、代码和已导出的版本了解当前进度。"
    elif c.product_of(task) == "style":
        where = "先加载 core-stylegen；工作区 /root/task 已从存档恢复，先看 style/、work/、review/ 和已导出的版本了解当前进度。"
    else:
        where = "先加载 core-director；工作区 /root/task 已从存档恢复，先看 brief.json、script.json、storyboard.json、scenes/、clips/ 了解当前进度。"
    ctx = ("（背景：这是同一个任务的后续一轮。如果你不记得之前的对话：" + where +
           "原始任务说明如下。）\n```json\n" + json.dumps(agent_brief(task), ensure_ascii=False) + "\n```\n\n")
    return ctx + body


def _body(task, turn):
    kind = turn["kind"]
    product = c.product_of(task)
    three = product == "model3d"
    if kind == "start":
        lead = {"model3d": "这是新的 3D 图片任务的任务说明（JSON）。请先加载 core-model3d，然后按建模手册开始工作。",
                "style": "这是新的风格创建任务的任务说明（JSON），由平台管理员发起。请先加载 core-stylegen，然后按风格手册开始工作。"}.get(
                    product, "这是新任务的任务说明（JSON）。请先加载 core-director，然后按做片手册开始工作。")
        return lead + "\n\n```json\n" + json.dumps(agent_brief(task), ensure_ascii=False, indent=1) + "\n```"
    if kind == "confirm":
        sb = turn.get("storyboard")
        extra = _flow_extra(turn)
        if sb:
            return ("用户已确认分镜，并做了修改。以下面这份为准：先把它写入 /root/task/storyboard.json 并用 slate-publish 发布，"
                    "然后从配音和写动画代码继续，直到合成出片。" + extra + "\n\n```json\n" + json.dumps(sb, ensure_ascii=False, indent=1) + "\n```")
        return "用户已确认分镜，请从配音和写动画代码继续，直到合成出片。" + extra
    if kind == "revise" and turn.get("node") == "text":  # 工作流的文字节点：只改剧本和分镜
        payload = {"kind": "slate.revise", "node": "text", "user_content": turn.get("text") or ""}
        if turn.get("storyboard"):
            payload["storyboard"] = turn["storyboard"]
        return ("这是工作流模式里文字节点的修改（做片手册第 11 节）：只改剧本和分镜，改完重新发布，然后结束这一轮。"
                "不要配音、写场景代码、渲染或合成。" + ("用户先在分镜表里直接改了字，以 storyboard 为准，先写入并发布，再按 user_content 修改。" if turn.get("storyboard") else "")
                + "如果这条消息不是修改意见，而是别的请求，按做片手册第 8 节处理。\n\n```json\n" + json.dumps(payload, ensure_ascii=False, indent=1) + "\n```")
    if kind == "revise" and turn.get("rerun"):  # 工作流的音画节点点了"重跑"
        payload = {"kind": "slate.rerun", "changes": turn.get("changes") or [], "user_content": turn.get("text") or ""}
        if turn.get("storyboard"):
            payload["storyboard"] = turn["storyboard"]
        return ("这是工作流模式里音画节点的重跑（做片手册第 11 节）：按最新的分镜和设置更新成片，出一个新版本。changes 是这次的改动"
                + ("，storyboard 是用户在分镜表里直接改过的分镜，以它为准，先写入并发布" if turn.get("storyboard") else "")
                + ("，user_content 是用户补充的要求" if turn.get("text") else "") + "。\n\n```json\n" + json.dumps(payload, ensure_ascii=False, indent=1) + "\n```")
    if kind == "revise":
        scope = turn.get("scope") or "all"
        payload = {"kind": "slate.revise", "scope": scope, "user_content": turn.get("text") or ""}
        if product == "style":
            # skill：改的是画风（visual，slate-style export）还是写作方法（writing，slate-style export-writing）
            skill = turn.get("skillKind") or "visual"
            return ("管理员看了验证材料，提出了修改意见（JSON，user_content 是管理员原话，v 是看的那一版，skill 是改哪一种：visual 画风、writing 写作方法）。"
                    "按风格手册的「按意见修改」一节处理：先发改动计划，再修改并导出这一种的新一版，另一种不动。\n\n```json\n"
                    + json.dumps({"kind": "slate.revise", "skill": skill, "v": turn.get("v"), "user_content": turn.get("text") or ""}, ensure_ascii=False) + "\n```")
        if three:
            return ("用户对 3D 图片提出了修改意见（JSON，user_content 是用户原话）。按建模手册的「修改」一节处理：先发改动计划，再修改并导出新版本。"
                    "如果这条消息不是修改意见，而是别的请求，按建模手册的说明回复。\n\n```json\n"
                    + json.dumps({"kind": "slate.revise", "user_content": turn.get("text") or ""}, ensure_ascii=False) + "\n```")
        hint = "只改第 " + scope + " 镜" if scope != "all" else "范围是全片"
        return ("用户提出了修改意见（JSON，user_content 是用户原话）。" + hint + "。按做片手册第 6 节处理：先发改动计划，再修改并出新版本。"
                "如果这条消息不是修改意见，而是别的请求，按做片手册第 8 节处理。\n\n```json\n"
                + json.dumps(payload, ensure_ascii=False) + "\n```")
    if kind == "retry":
        return f"上一轮没有完成，原因：{turn.get('text') or '未知'}。请先用 slate-sync pull 确认工作区完整，找到原因并修复，然后继续完成。"
    return "请继续完成上一条请求（如果工作区文件缺失，先运行 slate-sync pull --force）。"


def _flow_extra(turn):
    """工作流模式确认分镜时带来的改动（音画节点改了设置、写完分镜之后才做好的 3D 图片）和用户的补充要求"""
    out = ""
    if turn.get("changes"):
        out += ("\n用户在音画节点里还有这些改动，先按做片手册第 11 节处理好再配音：\n" + "\n".join(f"- {x}" for x in turn["changes"]))
    if turn.get("text"):
        out += "\n用户补充的要求（用户原话）：" + json.dumps(turn["text"], ensure_ascii=False)
    return out


CACHE = {"cache_control": {"type": "ephemeral"}}


def model_config(model_id):
    """IAM 角色调 Bedrock 的模型配置。Claude 模型打开提示缓存（Bedrock 的自动缓存：顶层 cache_control，
    断点随对话增长自动后移）；GPT 等其他模型不认这个字段，它们有各自的自动缓存。"""
    cfg = {"modelId": model_id, "maxTokens": 32000}
    if "anthropic." in model_id:
        cfg["additionalParams"] = {"additionalModelRequestFields": CACHE}
    return {"bedrockModelConfig": cfg}


def config_for(entry):
    """模型链里的一项 → InvokeHarness 的 model 参数：Bedrock 模型，Harness 用执行角色调用（docs/model-keys-design.md）"""
    return model_config(entry["model"])


def model_name(entry):
    return entry["model"] if entry["kind"] == "bedrock" else f"{entry['name']}:{entry['model']}"


def tools_for(task):
    if task["request"].get("web_search") and c.GATEWAY_ARN:
        return ([{"type": "agentcore_gateway", "name": "search",
                  "config": {"agentCoreGateway": {"gatewayArn": c.GATEWAY_ARN, "outboundAuth": {"awsIam": {}}}}}],
                ["@builtin", "@search/*"])
    return [], ["@builtin"]


def prefetch_sites(task):
    """开工前抓取用户给的参考网站（正文 + 截图），放进 input/web/ 并存到 S3。

    Agent 自己不能访问公网浏览器（避免把平台资料带出去）；这里用一张只有浏览器权限、15 分钟过期、
    只在这一条命令里使用的临时凭证，在会话里执行 slate-browse。
    """
    sites = ((task["request"].get("options") or {}).get("assets") or {}).get("sites") or []
    if not sites or task.get("prefetched") or not os.environ.get("PREFETCH_ROLE_ARN"):
        return
    cred = c.sts.assume_role(RoleArn=os.environ["PREFETCH_ROLE_ARN"], RoleSessionName=f"p-{task['id'][:50]}",
                             DurationSeconds=900)["Credentials"]
    env = (f"export AWS_ACCESS_KEY_ID={cred['AccessKeyId']} AWS_SECRET_ACCESS_KEY={cred['SecretAccessKey']} "
           f"AWS_SESSION_TOKEN={cred['SessionToken']}; ")
    for i, site in enumerate(sites, 1):
        n = f"{i:02d}"
        cmd = (env + f"slate-browse {shlex.quote(site['url'])} --shot /root/task/input/web/{n}.png "
               f"--text /root/task/input/web/{n}.txt --upload > /dev/null")
        try:
            code, _, err = c.session_command(task["id"], cmd, timeout=120)
        except Exception as e:
            code, err = -1, str(e)
        site["fetched"] = {"text": f"input/web/{n}.txt", "shot": f"input/web/{n}.png"} if code == 0 else {"error": "网页打不开"}
        print("prefetch", site["url"], code, err[-200:] if code else "")
    c.set_fields(task["id"], request=task["request"], prefetched=True)


def prepare_refs(task, ch=None):
    """参考资料（docs/references-design.md）：第一次先抓取链接的正文；每一轮都在会话里重建目录 input/refs/index.json
    （推送存档时不带 input/，会话被回收后要重建）。每份资料的字数和失败原因记回任务，生成页显示"""
    refs = (task.get("request") or {}).get("refs") or {}
    if not refs.get("items"):
        return
    links = [x for x in refs["items"] if x["kind"] == "link" and "fetched" not in x]
    if links and not ch and os.environ.get("PREFETCH_ROLE_ARN"):
        cred = c.sts.assume_role(RoleArn=os.environ["PREFETCH_ROLE_ARN"], RoleSessionName=f"p-{task['id'][:50]}",
                                 DurationSeconds=900)["Credentials"]
        env = (f"export AWS_ACCESS_KEY_ID={cred['AccessKeyId']} AWS_SECRET_ACCESS_KEY={cred['SecretAccessKey']} "
               f"AWS_SESSION_TOKEN={cred['SessionToken']}; ")
        for x in links:
            d = "/root/task/input/refs/web"
            cmd = env + f"mkdir -p {d} && slate-browse {shlex.quote(x['url'])} --shot {d}/{x['id']}.png --text {d}/{x['id']}.txt --upload > /dev/null"
            try:
                code, _, err = c.session_command(task["id"], cmd, timeout=120)
            except Exception as e:
                code, err = -1, str(e)
            x["fetched"] = code == 0
            print("ref link", x["url"], code, err[-200:] if code else "")
    try:
        code, out, err = c.session_command(task["id"], "slate-refs build", timeout=180, chapter=ch)
        res = json.loads(out.strip().splitlines()[-1]) if code == 0 and out.strip() else {}
    except Exception as e:
        print("slate-refs build failed", repr(e)[:300]); res = {}
    if ch:
        return
    got = {x["id"]: x for x in res.get("items", [])}
    for x in refs["items"]:
        r = got.get(x["id"]) or {}
        x["chars"] = r.get("chars", x.get("chars"))
        if r.get("error"):
            x["error"] = r["error"]
        else:
            x.pop("error", None)
        if r.get("truncated"):
            x["truncated"] = True
    c.set_fields(task["id"], request=task["request"])


def prepare_images(task, ch=None):
    """用户给的普通图片（docs/image-refs-design.md）：每一轮都在会话里整理图片、重建目录 input/images/index.json
    （推送存档时不带 input/；整理后的图第一次就传回了数据桶，之后同步下来就有，不用再做）。打不开的图记回任务，生成页显示"""
    images = (task.get("request") or {}).get("images") or []
    if not images:
        return
    try:
        code, out, err = c.session_command(task["id"], "slate-image index", timeout=180, chapter=ch)
        res = json.loads(out.strip().splitlines()[-1]) if code == 0 and out.strip() else {}
    except Exception as e:
        print("slate-image index failed", repr(e)[:300]); return
    if ch or code != 0:
        print("slate-image index:", code, err[-300:])
        return
    bad, thumbs = set(res.get("errors") or []), res.get("thumbs") or {}
    if any(bool(x.get("error")) != (x["id"] in bad) or x.get("thumb") != thumbs.get(x["id"]) for x in images):
        for x in images:
            x["error"] = "图片打不开" if x["id"] in bad else None
            x["thumb"] = thumbs.get(x["id"])  # 生成页的缩略图
        c.set_fields(task["id"], request=task["request"])


def fail(task_id, message):
    c.set_fields(task_id, status="failed", failure={"message": message, "at": c.now_ms()})


def set_nonce(task_id, ch, turn_id, nonce):
    """只给这一轮记上口令（不整个改写 turn）：期间轮次换了，比如用户取消了，就返回 False"""
    args = ("SET #t.nonce = :n", {"#t": "turn"}, {":n": nonce, ":id": turn_id}, "#t.id = :id")
    try:
        chs.update(task_id, ch, *args) if ch else c.update_task(task_id, *args)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def start(args):
    """发起这一轮，只读开头一小段：确认真正开始了（或很快出错）就断开，Harness 会自己跑完"""
    r = c.agent.invoke_harness(**args)
    t0, seen = time.time(), []
    try:
        for ev in r["stream"]:
            k = next(iter(ev))
            seen.append(k)
            if k in ("validationException", "internalServerException", "runtimeClientError", "modelStreamErrorException"):
                raise RuntimeError(f"{k}: {json.dumps(ev[k], ensure_ascii=False)[:300]}")
            if k == "messageStop" or k == "contentBlockStart" or time.time() - t0 > READ_SECONDS:
                break
    finally:
        r["stream"].close()
    return seen


def stitch(task, turn_id):
    """长片各章都完成了：在主会话里把各章成片拼成整片（不经过模型）。成片版本由 events 记入任务，这里等它出现后标记完成"""
    tid = task["id"]
    try:
        code, out, err = c.write_session_context(task, turn_id)
        if code != 0:
            raise RuntimeError(f"写入会话上下文失败：{err[-300:]}")
        c.session_command(tid, "slate-sync pull", timeout=300)
        before = len(task.get("versions") or [])
        code, out, err = c.session_command(tid, "slate-compose --chapters", timeout=840)
        print("stitch:", code, out[-500:], err[-500:])
        if code != 0:
            raise RuntimeError((err or out).strip().splitlines()[-1][:200] if (err or out).strip() else f"退出码 {code}")
        for _ in range(30):
            t = c.get_task(tid)
            if len(t.get("versions") or []) > before:
                break
            time.sleep(2)
        c.set_fields(tid, status="completed", turn=None, turnFlags={}, stitching=False)
        c.stop_render(tid, len(chs.all_of(tid)))
        c.session_command(tid, "slate-sync push", timeout=180)
    except Exception as e:
        traceback.print_exc()
        c.set_fields(tid, status="failed", turn=None, stitching=False,
                     failure={"message": f"各章都做好了，但拼成整片时出错：{str(e)[:200]}。可以点重试。", "at": c.now_ms(), "stitch": True})


def handler(event, context):
    task_id, turn_id, ch = event["taskId"], event["turnId"], event.get("chapter")
    task = c.get_task(task_id)
    if event.get("stitch"):
        if task and (task.get("turn") or {}).get("id") == turn_id:
            stitch(task, turn_id)
        return
    if ch:  # 长片的一章：轮次记在章节记录里，会话是这一章自己的
        rec = chs.get(task_id, ch) if task else None
        turn = (rec or {}).get("turn")
        if not turn or turn["id"] != turn_id:
            print("stale chapter turn, skip", task_id, ch, turn_id)
            return
        save = lambda **kw: chs.set_fields(task_id, ch, **kw)  # noqa: E731
        fail_it = lambda msg: (chs.set_fields(task_id, ch, status="failed", turn=None, failure={"message": msg, "at": c.now_ms()}),  # noqa: E731
                               chs.after_chapter(task_id))
    else:
        if not task or not task.get("turn") or task["turn"]["id"] != turn_id:
            print("stale turn, skip", task_id, turn_id)
            return
        turn = task["turn"]
        save = lambda **kw: c.set_fields(task_id, **kw)  # noqa: E731
        fail_it = lambda msg: fail(task_id, msg)  # noqa: E731
    chain = models.agent_chain()
    idx = min(turn.get("modelIndex", 0), len(chain) - 1)
    entry = chain[idx]
    save(status="running", model=model_name(entry))
    if c.product_of(task) != "style":  # 风格创建的渲染都在会话的浏览器里做，不用渲染机
        c.warm_render(task_id, ch)  # 渲染机开机约 2 分钟，趁 Agent 读资料、写稿的时间先开起来
    try:
        code, out, err = c.write_session_context(task, turn_id, chapter=ch)
        if code != 0:
            raise RuntimeError(f"写入会话上下文失败：{err[-300:]}")
        code, out, err = c.session_command(task_id, "slate-sync pull", timeout=300, chapter=ch)
        print("sync pull:", code, out[-300:], err[-300:])
        if turn["kind"] == "start" and not ch:
            prefetch_sites(task)
        prepare_refs(task, ch)
        prepare_images(task, ch)
        tools, allowed = tools_for(task)
        text = chapter_message(task, ch, turn) if ch else message_for(task, turn)
        args = dict(harnessArn=c.HARNESS_ARN, runtimeSessionId=c.session_id(task_id, ch), runtimeUserId=task["sub"],
                    actorId=task["sub"], messages=[{"role": "user", "content": [{"text": text}]}],
                    model=config_for(entry), allowedTools=allowed)
        if tools:
            args["tools"] = tools
        # 这一次调用的口令：经 baggage 交给 Harness，Harness 原样带进 finish hook 的请求头。
        # 会话里看不到它，所以会话伪造的 hook 对不上口令（finish.py 的 _verified）
        nonce = secrets.token_hex(16)
        if not set_nonce(task_id, ch, turn_id, nonce):
            print("turn changed before start, skip", task_id, ch or "main", turn_id)
            return
        args["baggage"] = f"slate.nonce={nonce}"
        # 计费：这个会话从现在起的用量算在这一轮、按这个模型定价；被安全策略误拦后自动重做的那一轮不收费
        billing.open_span(args["runtimeSessionId"], task, turn, chapter=ch, label=billing.turn_label(turn, ch),
                          free=turn.get("restartReason") in ("filtered", "source"), model=entry["model"])
        seen = start(args)
        print("turn started", task_id, ch or "main", turn_id, model_name(entry), seen[:6])
    except Exception as e:
        traceback.print_exc()
        fail_it(f"启动失败：{str(e)[:200]}")
