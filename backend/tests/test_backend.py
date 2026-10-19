"""后端纯逻辑的单元测试（不访问 AWS）。运行：cd backend && python -m pytest tests -q"""
import json, os, shutil, sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
ROOT = os.path.dirname(BACKEND)
sys.path.insert(0, BACKEND)
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

LIB = os.path.join(BACKEND, "lib")


@pytest.fixture(autouse=True, scope="session")
def staged_files():
    """模拟 CDK 打包：把 Schema、Skill 目录和受保护资料放进 lib/。"""
    made = []
    pf = os.path.join(LIB, "printfile.py")  # 3D 打印导出：部署时从会话代码复制过来
    if not os.path.exists(pf):
        shutil.copy(os.path.join(ROOT, "agent/image/slate/printfile.py"), pf); made.append(pf)
    sch = os.path.join(LIB, "schemas")
    if not os.path.exists(sch):
        shutil.copytree(os.path.join(ROOT, "agent/image/slate/schemas"), sch); made.append(sch)
    cat = os.path.join(LIB, "catalog.json")
    if not os.path.exists(cat):
        src = os.path.join(ROOT, "agent/skills/catalog.json")
        if os.path.exists(src):
            shutil.copy(src, cat)
        else:
            json.dump([{"id": "editorial", "name": "编辑图解"}], open(cat, "w"))
        made.append(cat)
    ge = os.path.join(LIB, "genres.json")
    if not os.path.exists(ge):
        shutil.copy(os.path.join(ROOT, "agent/skills/genres.json"), ge); made.append(ge)
    vo = os.path.join(LIB, "voices.json")
    if not os.path.exists(vo):
        shutil.copy(os.path.join(ROOT, "agent/voices.json"), vo); made.append(vo)
    pro = os.path.join(LIB, "protected")
    if not os.path.exists(pro):
        os.makedirs(pro)
        shutil.copytree(os.path.join(ROOT, "agent/skills"), os.path.join(pro, "skills"))
        shutil.copytree(os.path.join(ROOT, "agent/prompts"), os.path.join(pro, "prompts"))
        made.append(pro)
    yield
    for p in made:
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)


def test_quick_request_ignores_options():
    from lib.validate import task_request
    r = task_request({"mode": "quick", "description": " 讲 RAG ", "options": {"skills": {"enabled": True, "ids": ["x"]}}})
    assert r["description"] == "讲 RAG"
    assert r["options"]["skills"] == {"enabled": False, "ids": []}
    assert r["web_search"] is True


def test_advanced_validation_messages():
    from lib.common import ApiError
    from lib.validate import task_request
    r = task_request({"mode": "advanced", "description": "x", "options": {"script": {"enabled": True, "outline": "要点"}}})
    assert r["options"]["script"]["enabled"] is False          # 讲解稿已由参考资料取代，老前端传了也忽略
    with pytest.raises(ApiError):
        task_request({"mode": "advanced", "description": "", "options": {}})
    r = task_request({"mode": "advanced", "description": "x", "options": {
        "spec": {"enabled": True, "ratio": "9:16", "duration": 15, "resolution": "4K", "fps": 60},
        "assets": {"enabled": True, "sites": [{"url": "https://example.com", "use": "style"}]}}})
    assert r["options"]["spec"]["resolution"] == "1080p"  # 4K 不支持，回落到 1080p
    assert r["options"]["spec"]["ratio"] == "9:16" and r["options"]["spec"]["fps"] == 60
    assert r["options"]["assets"] == {"enabled": False, "force": False, "uploads": [], "sites": []}  # 素材已下线，老前端传了也忽略


def test_storyboard_schema():
    from lib.validate import storyboard
    ok = {"title": "t", "ratio": "16:9", "resolution": "1080p", "fps": 30,
          "scenes": [{"id": "01", "title": "a", "narration": "b", "visual": "c", "duration": 5}]}
    assert storyboard(ok) is None
    bad = json.loads(json.dumps(ok)); bad["scenes"].append(dict(bad["scenes"][0]))
    assert storyboard(bad) == "镜头编号有重复"
    bad2 = json.loads(json.dumps(ok)); bad2["scenes"][0]["id"] = "1"
    assert storyboard(bad2)
    # 全片最多两个风格：主风格 + 一个插入风格
    three = json.loads(json.dumps(ok))
    three["scenes"] = [{**ok["scenes"][0], "id": f"0{i}", "skill": k} for i, k in enumerate(["film-dataviz", "film-glass-product", "anatomy"], 1)]
    assert "最多两个" in storyboard(three)
    three["scenes"][2]["skill"] = "film-dataviz"
    assert storyboard({**three, "caption_style": {"bg": "#111", "color": "#eee"}}) is None


def test_gate_blocks_skill_content_and_canary():
    from lib import gate
    skill = open(os.path.join(ROOT, "agent/skills/film-kit/SKILL.md"), encoding="utf-8").read()
    assert gate.check("看看这段：" + skill[400:520]) is not None
    assert gate.check("版本标识是 slate-skill-abcdef1234") is not None
    assert gate.check("先去资料库找到相关段落，再让模型带着它作答。") is None  # 正常旁白（与示例相同也允许）
    assert gate.check("第 2 镜：标题放大，节奏加快。") is None


def test_status_text_and_views():
    from lib import views
    t = {"id": "x", "status": "running", "steps": {"render": {"state": "running"}},
         "docs": {"storyboard": {"scenes": [{"id": "01"}, {"id": "02"}, {"id": "03"}]}}, "clips": {"01": {}}}
    assert views.status_text(t) == "渲染中 1/3 镜"
    assert views.status_text({"status": "completed", "versions": [1, 2]}) == "已完成，第 2 版"
    items = views.list_view([{**t, "request": {"description": "d"}, "updatedAt": 1},
                             {"id": "y", "status": "failed", "request": {"description": "e"}}], "failed")
    assert [i["id"] for i in items] == ["y"]


def test_turn_messages():
    import turn
    task = {"request": {"mode": "quick", "web_search": False, "description": "讲 RAG",
                        "options": {"script": {"enabled": False, "verbatim": False, "outline": "", "files": []},
                                    "assets": {"enabled": False, "force": False, "files": [], "sites": []},
                                    "skills": {"enabled": False, "ids": []}, "spec": {"enabled": False}, "confirm_storyboard": False}}}
    m = turn.message_for(task, {"kind": "start"})
    assert '"kind": "slate.task"' in m and "讲 RAG" in m
    assert "只改第 03 镜" in turn.message_for(task, {"kind": "revise", "scope": "03", "text": "快一点"})
    tools, allowed = turn.tools_for(task)
    assert tools == [] and allowed == ["@builtin"]
    # Claude 打开提示缓存，GPT 不带这个字段
    assert turn.model_config("global.anthropic.claude-opus-5-5")["bedrockModelConfig"]["additionalParams"]["additionalModelRequestFields"]["cache_control"] == {"type": "ephemeral"}
    assert "additionalParams" not in turn.model_config("global.openai.gpt-6-astra")["bedrockModelConfig"]


def test_gate_blocks_third_party_source_name():
    from lib import gate
    assert gate.check("这个风格参考了 Lemo-Opuscar 的做法") is not None
    assert gate.check("OPUSCAR 风格库") is not None
    assert gate.check("片头用法式引号 guillemotleft") is None
    assert gate.check("柠檬 lemon 味的广告") is None


def test_voice_options():
    from lib.validate import task_request
    from lib import common
    ids = [v["id"] for v in common.voices()]
    assert "humorous-elder" in ids and all(v["preview"].startswith("voices/") for v in common.voices())
    base = {"mode": "advanced", "description": "x", "options": {"spec": {"enabled": True, "voice_id": "humorous-elder"}}}
    assert task_request(base)["options"]["spec"]["voice_id"] == "humorous-elder"
    base["options"]["spec"]["voice_id"] = "不存在的音色"
    assert task_request(base)["options"]["spec"]["voice_id"] == "auto"


def test_captions_from_minimax_words():
    sys.path.insert(0, os.path.join(ROOT, "agent/image"))
    from slate import voice
    text = "哎呦喂(laughs)，飞机咋就能飞上天呢？来，大爷给你唠唠。"
    words = []
    for i, ch in enumerate(["哎", "呦", "喂", "(laughs)", "，", "飞", "机", "咋", "就", "能", "飞", "上", "天", "呢", "？", "来", "，",
                            "大", "爷", "给", "你", "唠", "唠", "。"]):
        b = text.index(ch, words[-1]["e"] if words else 0)
        words.append({"w": ch, "b": b, "e": b + len(ch), "t0": i * 200, "t1": i * 200 + 180})
    caps = voice.captions_from_words(text, [w for w in words if w["w"] not in "，？。"], 5.0, 16)
    assert [c["text"] for c in caps] == ["哎呦喂", "飞机咋就能飞上天呢", "来", "大爷给你唠唠"]
    assert caps[0]["start"] == 0 and caps[1]["start"] == 1.0 and caps[-1]["end"] == 5.0


def test_admin_requires_admin_group_and_admin_client(monkeypatch):
    monkeypatch.setenv("ADMIN_CLIENT_ID", "admin-client")
    import importlib, admin
    importlib.reload(admin)
    ev = lambda aud, groups: {"requestContext": {"authorizer": {"claims": {"sub": "s1", "email": "a@b.c", "aud": aud, "cognito:groups": groups}}},
                              "httpMethod": "GET", "path": "/api/me"}
    monkeypatch.setattr(admin, "_still_admin", lambda claims: True)
    assert admin.handler(ev("admin-client", "[admin]"), None)["statusCode"] == 200
    assert admin.handler(ev("web-client", "[admin]"), None)["statusCode"] == 403      # 用户端的令牌
    assert admin.handler(ev("admin-client", ""), None)["statusCode"] == 403          # 不是管理员
    assert admin.handler({"requestContext": {}}, None)["statusCode"] == 401


OPUS5, OPUS48, ASTRA, SONNET = ("global.anthropic.claude-opus-5-5", "global.anthropic.claude-opus-4-8",
                                 "global.openai.gpt-6-astra", "global.anthropic.claude-sonnet-5-5")


def test_model_chain_iam_only(monkeypatch):
    """整个平台只有一个模型来源：部署账号的 IAM 角色（docs/model-keys-design.md）。每个用途主模型在前、备用在后"""
    from lib import models, common
    monkeypatch.setattr(common, "MODELS", [OPUS5, OPUS48, ASTRA])
    pairs = lambda ch: [(x["src"], x["model"]) for x in ch]  # noqa: E731
    assert pairs(models.agent_chain()) == [("iam", OPUS5), ("iam", OPUS48), ("iam", ASTRA)]
    assert pairs(models.chain("vision")) == [("iam", SONNET), ("iam", OPUS48)]
    assert pairs(models.chain("video")) == [("iam", models.VIDEO_MODEL)]
    import turn
    assert turn.config_for({"kind": "bedrock", "model": OPUS5})["bedrockModelConfig"]["additionalParams"] == {
        "additionalModelRequestFields": {"cache_control": {"type": "ephemeral"}}}
    assert models.mask("sk-cp-abcdefghijklmnopW3U").startswith("sk-cp-") and models.mask("sk-cp-abcdefghijklmnopW3U").endswith("pW3U")
    # 被内容安全策略拦下：换下一个没被拦过的模型；都拦过了就没有了
    ch = models.agent_chain()
    assert models.next_model(ch, 0, [OPUS5]) == 1 and models.next_model(ch, 1, [OPUS5, OPUS48]) == 2
    assert models.next_model(ch, 2, [OPUS5, OPUS48, ASTRA]) is None


def test_llm_vision_iam(monkeypatch):
    """看图：主模型被拦换备用模型；调不通就报错（没有别的来源可换）"""
    import llm
    monkeypatch.setattr(llm.c, "billed_task", lambda b: {"id": "t", "sub": "s1"})  # 计费令牌另有测试
    monkeypatch.setattr(llm.billing, "check_quota", lambda sub: None)
    from lib import models
    monkeypatch.setattr(models, "chain", lambda purpose, cfg=None: [{"kind": "bedrock", "src": "iam", "name": models.IAM, "model": m} for m in (SONNET, OPUS48)])
    calls = []

    def fake(result):
        def f(r, ev):
            calls.append(r["model"])
            if isinstance(result, Exception):
                raise result
            return result(r) if callable(result) else result
        return f
    ev = {"images": [{"b64": "x"}], "question": "q"}
    monkeypatch.setattr(llm, "CALL", {"bedrock": fake(lambda r: None if r["model"] == SONNET else "好")})
    r = llm.handler(dict(ev), None)
    assert (r["source"], r["model"], r["text"]) == (models.IAM, "Claude Opus 4.8", "好") and calls == [SONNET, OPUS48]
    calls.clear()
    monkeypatch.setattr(llm, "CALL", {"bedrock": fake(RuntimeError("AccessDenied"))})
    r = llm.handler(dict(ev), None)
    assert r["ok"] is False and "AccessDenied" in r["error"] and calls == [SONNET]


def test_admin_models_view(monkeypatch):
    """模型与密钥页：模型来源是 IAM 角色（显示调用模型的策略名），只有 MiniMax 有 Key"""
    import admin
    from lib import common, models
    monkeypatch.setattr(common, "MODELS", [OPUS5, OPUS48, ASTRA])
    monkeypatch.setattr(models, "load", lambda fresh=False: {"minimax": None})
    monkeypatch.setattr(admin, "_minimax_key", lambda: "sk-api-0123456789abcd")
    monkeypatch.setattr(admin, "MODEL_POLICY", "Slate-models")
    v = admin.models_view()
    assert v["source"] == {"kind": "iam", "name": models.IAM, "policy": "Slate-models"}
    agent, vision, video, voice = v["routes"]
    assert (agent["model"], agent["alt"], agent["source"]) == ("Claude Opus 5.5", ["Claude Opus 4.8", "GPT-6 Astra"], models.IAM)
    assert (vision["model"], vision["alt"]) == ("Claude Sonnet 5.5", ["Claude Opus 4.8"]) and video["model"] == "TwelveLabs Pegasus 1.5"
    assert voice["source"] == "MiniMax 中国区" and v["minimax"]["configured"] and "bedrock_key" not in v and "openai" not in v
    from lib.common import ApiError
    with pytest.raises(ApiError):
        admin.test_source({"source": "bedrock_key"}, {"email": "a"})


def test_admin_month_keys_are_consecutive(monkeypatch):
    import admin
    from datetime import datetime
    class Fixed(datetime):
        @classmethod
        def now(cls, tz=None): return datetime(2026, 10, 13, 12, 0, tzinfo=tz)
    monkeypatch.setattr(admin, "datetime", Fixed)
    monkeypatch.setattr(admin, "_get_user", lambda sub: {"Username": "u", "Attributes": [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": "a@b.c"}], "Enabled": True})
    monkeypatch.setattr(admin, "_admins", lambda: set())
    monkeypatch.setattr(admin, "_tasks_of", lambda sub: [])
    monkeypatch.setattr(admin.billing, "months_of", lambda sub, keys: {"2026-10": 12.5})
    monkeypatch.setattr(admin.billing, "summary", lambda sub: {"month": "2026-10", "used": 12.5, "quota": 1000.0, "custom": False})
    d = admin.user_detail("s1")
    assert d["months"][-1]["credits"] == 12.5 and d["credits"]["quota"] == 1000.0
    months = [m["month"] for m in d["months"]]
    assert months[0] == "2025-11" and months[-1] == "2026-10" and len(set(months)) == 12 and "2026-09" in months


def test_finish_fallback_iam(monkeypatch):
    """主 Agent 被内容安全策略拦下：换备用模型重跑；都拦过了报失败。没有产出时不再换来源，照常报失败"""
    import finish
    monkeypatch.setattr(finish, "_verified", lambda ev, turn: True)  # 口令另有测试
    from lib import models, common
    monkeypatch.setattr(common, "MODELS", [OPUS5, OPUS48])
    got = {}
    monkeypatch.setattr(finish, "restart", lambda task, turn, **kw: got.update(restart=kw))
    monkeypatch.setattr(finish, "fail", lambda task, msg: got.update(fail=msg))
    monkeypatch.setattr(finish, "push", lambda task, turn: None)
    monkeypatch.setattr(finish.c, "add_message", lambda *a, **k: None)

    def run(stop, idx, filtered=()):
        got.clear()
        task = {"id": "t1", "status": "running", "turn": {"id": "u1", "kind": "start", "modelIndex": idx, "filtered": list(filtered)}}
        monkeypatch.setattr(finish.c, "session_parts", lambda s: ("t1", None))
        monkeypatch.setattr(finish.c, "get_task", lambda tid: task)
        finish.process({"sessionId": "s", "context": {"stopReason": stop}})
        return got
    assert run("content_filtered", 0) == {"restart": {"modelIndex": 1, "filtered": [OPUS5], "restartReason": "filtered"}}
    assert run("content_filtered", 1, [OPUS5]) == {"fail": "这条需求触发了模型的内容安全策略，没能完成。可以调整描述或参考资料后重试。"}
    assert "fail" in run("end_turn", 0)


def test_session_ids_and_custom_duration():
    from lib import common as c, validate
    from lib.common import ApiError
    tid = "5e55f00d-0000-4000-8000-00000000a001"
    assert c.session_parts(c.session_id(tid)) == (tid, None)
    assert c.session_parts(c.session_id(tid, "07")) == (tid, "07") and len(c.session_id(tid, "07")) <= 100
    assert c.session_parts("other-session") == (None, None)
    body = lambda d: {"mode": "advanced", "description": "讲讲大模型", "options": {"spec": {"enabled": True, "duration": d}}}  # noqa: E731
    assert validate.task_request(body(2400))["options"]["spec"]["duration"] == 2400       # 自定义 40 分钟
    assert validate.task_request(body("75.4"))["options"]["spec"]["duration"] == 75
    for bad in (5, 40000, "abc"):
        with pytest.raises(ApiError):
            validate.task_request(body(bad))
    task = {"request": validate.task_request(body(2400)), "docs": {}}
    assert c.is_long(task) and validate.agent_brief(task)["long_video"] is True
    assert not validate.agent_brief({"request": validate.task_request(body(180))})["long_video"]


def _fake_chapters(monkeypatch, recs, task):
    from lib import chapters as chs
    store = {r["id"]: r for r in recs}
    calls = {"invoke": [], "task": dict(task)}
    monkeypatch.setattr(chs, "all_of", lambda tid: [store[k] for k in sorted(store)])
    monkeypatch.setattr(chs, "get", lambda tid, ch: store.get(ch))
    monkeypatch.setattr(chs, "set_fields", lambda tid, ch, **kw: store[ch].update(kw))
    monkeypatch.setattr(chs.c, "get_task", lambda tid: calls["task"])
    monkeypatch.setattr(chs.c, "set_fields", lambda tid, **kw: calls["task"].update(kw))
    monkeypatch.setattr(chs.c, "update_task", lambda *a, **k: calls["task"].update(stitching=True))
    monkeypatch.setattr(chs.c.lam, "invoke", lambda **kw: calls["invoke"].append(json.loads(kw["Payload"])))
    return store, calls


def test_chapters_finish_then_stitch(monkeypatch):
    from lib import chapters as chs
    task = {"id": "t1", "turn": {"id": "x", "kind": "chapters"}, "docs": {"outline": {"chapters": [{"id": "01"}, {"id": "02"}]}}}
    store, calls = _fake_chapters(monkeypatch, [{"id": "01", "status": "done"}, {"id": "02", "status": "running"}], task)
    chs.after_chapter("t1"); assert calls["invoke"] == []                      # 还有一章在做
    store["02"]["status"] = "done"
    chs.after_chapter("t1"); assert calls["invoke"][0]["stitch"] is True       # 全部完成：拼接
    store["02"].update(status="failed", failure={"message": "渲染超时"})
    calls["task"]["turn"] = {"id": "y", "kind": "chapters"}
    chs.after_chapter("t1")
    assert calls["task"]["status"] == "failed" and calls["task"]["failure"]["chapters"] == ["02"] and "第 2 章" in calls["task"]["failure"]["message"]


def test_finish_chapter_turns(monkeypatch):
    import finish
    monkeypatch.setattr(finish, "_verified", lambda ev, turn: True)  # 口令另有测试
    from lib import chapters as chs, models
    monkeypatch.setattr(models, "agent_chain", lambda cfg=None: [{"kind": "bedrock", "src": "iam", "name": "IAM", "model": OPUS5},
                                                                  {"kind": "bedrock", "src": "iam", "name": "IAM", "model": OPUS48}])
    rec = {"id": "03", "status": "running", "turn": {"id": "u1", "kind": "start", "modelIndex": 0}, "flags": {}}
    store, calls = _fake_chapters(monkeypatch, [rec], {"id": "t1", "sub": "s", "turn": {"id": "x", "kind": "chapters"}})
    monkeypatch.setattr(finish, "push", lambda *a, **k: None)
    monkeypatch.setattr(finish.chs, "after_chapter", lambda tid: calls.setdefault("after", []).append(tid))
    task = {"id": "t1", "sub": "s"}
    finish.process_chapter(task, "03", {"context": {"stopReason": "content_filtered"}})
    assert store["03"]["status"] == "queued" and store["03"]["turn"]["modelIndex"] == 1 and calls["invoke"][-1]["chapter"] == "03"
    store["03"].update(status="running", flags={"final": True})
    finish.process_chapter(task, "03", {"context": {"stopReason": "end_turn"}})
    assert store["03"]["status"] == "done" and calls["after"] == ["t1"]


def test_views_merge_chapters(monkeypatch):
    from lib import views, chapters as chs
    outline = {"title": "大模型简史", "chapters": [{"id": "01", "title": "起源", "duration": 120, "summary": "从图灵说起", "narration": "很久以前……"},
                                                   {"id": "02", "title": "爆发", "duration": 150, "summary": "转折点", "narration": "直到……"}]}
    recs = [{"id": "01", "status": "done", "steps": {"code": {"state": "done"}, "render": {"state": "done"}},
             "storyboard": {"ratio": "16:9", "scenes": [{"id": "01", "title": "开场", "narration": "a", "visual": "v", "duration": 5}]},
             "clips": {"01": {"key": "k1", "dur": 5}}},
            {"id": "02", "status": "running", "steps": {"code": {"state": "running"}}}]
    monkeypatch.setattr(chs, "all_of", lambda tid: recs)
    monkeypatch.setattr(views.c, "presign_get", lambda k, **kw: "https://x/" + k)
    monkeypatch.setattr(views.c, "catalog", lambda: [])
    monkeypatch.setattr(views.billing, "turns_of", lambda tid: [{"turnId": "u1", "label": "首版", "credits": 1.5, "calls": 3}])
    task = {"id": "t1", "status": "running", "turn": {"kind": "chapters"}, "createdAt": 1, "updatedAt": 2, "request": {"description": "d", "web_search": True, "options": {}},
            "docs": {"outline": outline}, "steps": {}}
    v = views.detail_view(task, [])
    ids = [s["id"] for s in v["storyboard"]["scenes"]]
    assert ids == ["01-01", "02"] and v["storyboard"]["scenes"][0]["clip"]["url"] == "https://x/k1"
    assert v["storyboard"]["scenes"][1]["pending"] and v["statusText"] == "各章制作中，1/2 章完成"
    st = {x["name"]: x for x in v["steps"]}
    assert st["code"]["state"] == "running" and st["render"]["note"] == "1/2 章完成"
    monkeypatch.setattr(chs, "all_of", lambda tid: [])
    v = views.detail_view({**task, "status": "awaiting_confirmation", "turn": None}, [])
    assert [s["id"] for s in v["storyboard"]["scenes"]] == ["01", "02"] and v["statusText"] == "等你确认总纲"


def test_outline_look_skips_overlap_check(monkeypatch):
    import events
    from lib import validate
    calls = {}
    outline = {"title": "大模型应用", "look": {"skill": "editorial", "palette": "p", "fonts": "标题用 Noto Serif SC SemiBold", "recurring": "r", "transitions": "x"},
               "chapters": [{"id": "01", "title": "开场", "duration": 60, "summary": "s", "narration": "你有没有想过，一个大模型应用是怎么做出来的？"},
                            {"id": "02", "title": "检索", "duration": 60, "summary": "s", "narration": "n"}]}
    monkeypatch.setattr(events.c, "get_task", lambda tid: {"id": tid, "sub": "u"})
    monkeypatch.setattr(events.c, "read_json", lambda k: outline)
    monkeypatch.setattr(events.c, "update_task", lambda *a, **k: calls.setdefault("saved", True))
    monkeypatch.setattr(events, "blocked", lambda *a: calls.setdefault("blocked", a))
    seen = []
    monkeypatch.setattr(events.gate, "check", lambda text: seen.append(text) or None)
    events.process("u", "t1", {"type": "publish", "doc": "outline", "key": "u/u/t/t1/pub/outline.json"})
    assert calls.get("saved") and "blocked" not in calls
    assert all("SemiBold" not in t for t in seen)              # look 不参与检查
    assert any(outline["chapters"][0]["narration"][:20] in t for t in seen)   # 讲稿照常检查


# DynamoDB 保留字里容易被当成字段名的那些（完整清单见 AWS 文档 ReservedWords）
DDB_RESERVED = {w.lower() for w in """ABORT ACTION ADD ALL AND ANY AS ASC BY CASE CHECK COMMENT COUNT DATA DATE DAY DELETE DESC DOMAIN
END EXISTS FINAL FIRST FORMAT FROM GROUP HOUR IN INDEX KEY KEYS LAST LEVEL LIMIT LOCATION MINUTE MODE MONTH NAME NEXT NUMBER OPEN
ORDER OUTPUT OWNER PATH PERCENT POSITION PUBLIC RANGE READ REPLACE RESULT RETURN ROLE ROWS SECOND SECTION SIZE SOURCE START STATE
STATUS STORAGE STRING SYSTEM TABLE TEXT TIME TIMESTAMP TO TOTAL TYPE UPDATE USER USERS VALUE VALUES VIEW WHERE WITH WORK YEAR ZONE""".split()}


def test_update_expressions_escape_reserved_words():
    """更新语句里的字段名（包括路径里的每一段）不能直接写保留字，要用 #占位符"""
    import glob, re
    bad = []
    for p in glob.glob(os.path.join(BACKEND, "*.py")) + glob.glob(os.path.join(LIB, "*.py")):
        for expr in re.findall(r"[\"']((?:SET|REMOVE|ADD) [^\"']+)[\"']", open(p, encoding="utf-8").read()):
            for target in re.findall(r"(?:^|,)\s*(?:SET |REMOVE |ADD )?([A-Za-z_#][\w.#]*)\s*(?:=|$|,| :)", expr):
                for seg in target.split("."):
                    if not seg.startswith("#") and seg.lower() in DDB_RESERVED:
                        bad.append(f"{os.path.basename(p)}：{expr}（{seg}）")
    assert not bad, bad


def test_billing_prices_and_ratio(monkeypatch):
    from lib import billing
    cfg = {**billing.DEFAULTS, "models": dict(billing.DEFAULTS["models"])}
    monkeypatch.setattr(billing, "config", lambda fresh=False: cfg)
    usd = billing.model_cost(OPUS5, {"input": 1_000_000, "cacheRead": 1_000_000, "cacheWrite": 0, "output": 100_000}, cfg)
    assert abs(usd - (4 + 0.2 + 2)) < 1e-9
    assert billing.credits_of(usd, cfg) == round((4 + 0.2 + 2) * 1.3, 6)            # 1 美元 = 1.3 Credit
    assert abs(billing.voice_cost(10000, cfg) - 3.5 / 7.2) < 1e-9                       # 每万字符 3.5 元，按汇率折美元
    p, known = billing.price_of("some.new-model", cfg)
    assert not known and p["output"] == max(m["output"] for m in cfg["models"].values())  # 没登记的模型按最贵的记
    assert billing.turn_label({"kind": "start"}) == "首版" and billing.turn_label({"kind": "continue", "origin": "retry"}, "03") == "第 3 章 · 重试"
    assert billing.month_of(1791993600000) == "2026-10" and billing.day_of(1791993600000) == "2026-10-15"  # 北京时间


def test_meter_reads_runtime_telemetry(monkeypatch):
    import meter
    from lib import billing
    inst, sid = "1257a7ce-0000-4000-8000-00000000b001", "slate-task-7a5c0000-0000-4000-8000-00000000c001"
    start_rec = {"resource": {"attributes": {"service.instance.id": inst}}, "attributes": {"sessionId": sid}, "body": "Returning streaming response"}
    emf = {"otel.resource.service.instance.id": inst, "_aws": {"Timestamp": 1791993660000},
           "strands.event_loop.input.tokens": {"Sum": 18, "Count": 8}, "strands.event_loop.output.tokens": {"Sum": 1118, "Count": 8},
           "strands.event_loop.cache_read.input.tokens": {"Sum": 24060}, "strands.event_loop.cache_write.input.tokens": {"Sum": 13770}}
    monkeypatch.setattr(meter, "log_groups", lambda: ["/aws/bedrock-agentcore/runtimes/harness_Slate_agent-x-DEFAULT"])
    monkeypatch.setattr(meter, "events", lambda g, pat, a, b: [{"message": json.dumps(start_rec if "Returning" in pat else emf), "timestamp": 1791993660000}])
    mapped, recorded = {}, []
    monkeypatch.setattr(billing, "map_instance", lambda i, s: mapped.update({i: s}))
    monkeypatch.setattr(billing, "session_of_instance", lambda i, cache=None: mapped.get(i))
    monkeypatch.setattr(billing, "find_session", lambda s, at, cache=None: ({"id": "7a5c0000", "sub": "u1", "email": "a@b.c"},
                                                                           {"turnId": "t1", "chapter": None, "free": False, "label": "首版", "model": OPUS5}))
    monkeypatch.setattr(billing, "record", lambda *a, **k: recorded.append((a, k)) or 1.0)
    touched, stats = meter.process(0, 1)
    assert mapped == {inst: sid} and stats["recorded"] == 1 and "u1" in touched
    (task, at, idem, kind, turn, usage), kw = recorded[0]
    assert usage == {"input": 18, "cacheRead": 24060, "cacheWrite": 13770, "output": 1118} and kind == "model" and at == 1791993660000
    assert kw["model"] == OPUS5 and kw["billable"] is True and idem == f"m-{inst[:8]}-{at}" and "8 次模型调用" in kw["note"]


def test_genre_is_independent_of_style(monkeypatch):
    from lib import validate
    from lib.common import ApiError
    r = validate.task_request({"mode": "quick", "description": "讲讲猫为什么怕黄瓜", "genre": "science"})
    assert r["genre"] == "science" and r["options"]["skills"]["ids"] == []        # 快速模式也能选写法，不带风格
    b = validate.agent_brief({"request": r})
    assert b["genre"] == {"id": "science", "name": "知识科普", "guide": "/.agents/skills/core-director/genres/science.md"}
    assert validate.agent_brief({"request": validate.task_request({"mode": "quick", "description": "x"})})["genre"] is None
    adv = validate.task_request({"mode": "advanced", "description": "x", "genre": "promo",
                                 "options": {"skills": {"enabled": True, "ids": ["film-ink-wash"]}}})
    assert adv["genre"] == "promo" and adv["options"]["skills"]["ids"] == ["film-ink-wash"]   # 任意写法配任意风格
    with pytest.raises(ApiError):
        validate.task_request({"mode": "quick", "description": "x", "genre": "nope"})
    # 写法目录里的风格都存在，每个风格至少有一种常搭配的写法
    from lib.common import catalog, genres
    ids = {s["id"] for s in catalog()}
    used = {s for g in genres() for s in g["styles"]}
    assert used <= ids and ids <= used
    assert all(os.path.exists(os.path.join(ROOT, "agent/skills/core-director/genres", f"{g['id']}.md")) for g in genres())
    # brief 的 kind 能写所有写法名
    names = {g["name"] for g in genres()}
    enum = set(json.load(open(os.path.join(ROOT, "agent/image/slate/schemas/brief.json")))["properties"]["kind"]["enum"])
    assert names <= enum


def test_brief_kind_follows_user_genre(monkeypatch):
    import events
    saved = {}
    brief = {"title": "猫和黄瓜", "kind": "原理讲解", "audience": "大众", "ratio": "16:9", "duration": 30, "resolution": "1080p", "fps": 30,
             "skills": ["film-crayon-book"], "voice": "warm-bestie", "subtitles": True, "decided": ["kind", "skills"]}
    monkeypatch.setattr(events.c, "get_task", lambda tid: {"id": tid, "sub": "u", "request": {"genre": "science"}})
    monkeypatch.setattr(events.c, "read_json", lambda k: dict(brief))
    monkeypatch.setattr(events.c, "update_task", lambda tid, expr, names, values: saved.update(values))
    monkeypatch.setattr(events.gate, "check", lambda text: None)
    events.process("u", "t1", {"type": "publish", "doc": "brief", "key": "u/u/t/t1/pub/brief.json"})
    assert saved[":v"]["kind"] == "知识科普" and saved[":v"]["decided"] == ["skills"]


def test_genre_guides_name_their_default_style():
    """写法文件"风格"一节写的默认风格，和写法目录里的第一个风格一致（前端按目录显示常搭配）"""
    from lib.common import genres
    for g in genres():
        text = open(os.path.join(ROOT, "agent/skills/core-director/genres", f"{g['id']}.md"), encoding="utf-8").read()
        section = next(x for x in text.split("\n## ") if x.split("\n", 1)[0].endswith("风格"))
        assert f"`{g['styles'][0]}`" in section, g["id"]


def test_caption_style_skips_overlap_check(monkeypatch):
    import events
    calls, seen = {}, []
    sb = {"title": "猫和纸箱", "ratio": "16:9", "resolution": "1080p", "fps": 30,
          "caption_style": {"bg": "rgba(20, 20, 20, .86)", "color": "#F5F0E8", "font": "\"Noto Sans CJK SC\", sans-serif"},
          "scenes": [{"id": "01", "title": "开场", "narration": "买的猫窝不睡，偏偏钻快递纸箱？", "visual": "v", "duration": 5, "skill": "film-pixel-rpg"}]}
    monkeypatch.setattr(events.c, "get_task", lambda tid: {"id": tid, "sub": "u", "request": {}})
    monkeypatch.setattr(events.c, "read_json", lambda k: sb)
    monkeypatch.setattr(events.c, "update_task", lambda *a, **k: calls.setdefault("saved", True))
    monkeypatch.setattr(events, "blocked", lambda *a: calls.setdefault("blocked", a))
    monkeypatch.setattr(events.gate, "check", lambda text: seen.append(text) or None)
    events.process("u", "t1", {"type": "publish", "doc": "storyboard", "key": "u/u/t/t1/pub/storyboard.json"})
    assert calls.get("saved") and "blocked" not in calls
    assert all("Noto" not in t for t in seen) and any("纸箱" in t for t in seen)


def test_media_url_signed_by_cdn(monkeypatch):
    """视频链接走 CDN 签名：有效期取到整点（同一小时链接不变），下载带文件名参数；没配 CDN 时退回 S3 预签名"""
    import base64, time
    from urllib.parse import parse_qs, urlparse
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from lib import common as c
    monkeypatch.setattr(c, "presign_get", lambda key, expires=3600, download_name=None: f"https://s3/{key}")
    monkeypatch.setattr(c, "MEDIA_DOMAIN", "")
    assert c.media_url("u/x/t/y/final/a.mp4") == "https://s3/u/x/t/y/final/a.mp4"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()

    class SM:
        def get_secret_value(self, SecretId):
            return {"SecretString": pem}
    monkeypatch.setattr(c.boto3, "client", lambda *a, **k: SM())
    monkeypatch.setattr(c, "_media_signer", None)
    monkeypatch.setattr(c, "MEDIA_DOMAIN", "d123.cloudfront.net")
    monkeypatch.setattr(c, "MEDIA_KEY_ID", "K2ABC")
    monkeypatch.setattr(c, "MEDIA_KEY_SECRET", "arn:secret")
    a = c.media_url("u/x/t/y/clips/abc.mp4")
    b = c.media_url("u/x/t/y/clips/abc.mp4")
    assert a == b                                              # 同一小时里链接不变
    u = urlparse(a)
    q = parse_qs(u.query)
    assert u.netloc == "d123.cloudfront.net" and u.path == "/u/x/t/y/clips/abc.mp4" and q["Key-Pair-Id"] == ["K2ABC"]
    exp = int(q["Expires"][0])
    assert exp % 3600 == 0 and 3600 < exp - time.time() <= 7200
    # 签名能用公钥验证（canned policy）
    policy = '{"Statement":[{"Resource":"%s","Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}' % (a.split("?")[0], exp)
    sig = base64.b64decode(q["Signature"][0].replace("-", "+").replace("_", "=").replace("~", "/"))
    key.public_key().verify(sig, policy.encode(), padding.PKCS1v15(), hashes.SHA1())
    d = c.media_url("u/x/t/y/final/a-1.mp4", download_name="猫和纸箱-第1版.mp4")
    assert parse_qs(urlparse(d).query)["dl"] == ["猫和纸箱-第1版.mp4"]


def test_render_billing_and_sessions(monkeypatch):
    """渲染计费：忙碌秒数 × 机型单价（含管理费）× 比例 1.3；渲染机写来的用量由 events Lambda 记账；会话号按 3 章一组"""
    from lib import billing
    from lib import common as c
    import events
    cfg = {**billing.DEFAULTS, "models": billing.DEFAULTS["models"], "render": billing.DEFAULTS["render"]}
    assert billing.DEFAULTS["ratio"] == 1.3
    usd = billing.render_cost("g4dn.xlarge", 3600, cfg)
    assert abs(usd - 0.526 * 1.078) < 1e-3
    assert billing.render_cost("p5.48xlarge", 3600, cfg) == billing.render_cost("g5.xlarge", 3600, cfg)  # 没登记的机型按最贵的
    assert c.render_session("t1") == "slate-render-t1" == c.render_session("t1", "03")
    assert c.render_session("t1", "04") == "slate-render-t1-g1" and c.render_session("t1", "07") == "slate-render-t1-g2"
    got = {}
    monkeypatch.setattr(events.c, "get_task", lambda tid: {"id": tid, "sub": "u", "email": "a@b.c", "turn": {"id": "turn-1"}})
    monkeypatch.setattr(events.billing, "find_session", lambda sid, at: ({"id": "t1"}, {"turnId": "turn-1", "label": "首版", "chapter": None, "free": False}))
    monkeypatch.setattr(events.billing, "record", lambda task, at, idem, kind, turn, usage, model=None, billable=True, note="": got.update(
        kind=kind, usage=usage, model=model, billable=billable, idem=idem, note=note))
    events.process("u", "t1", {"type": "render_usage", "at": 1, "run": "r-1", "op": "render", "seconds": 42.5, "instance": "g5.xlarge", "scenes": 3})
    assert got["kind"] == "render" and got["usage"] == {"seconds": 42.5} and got["model"] == "g5.xlarge" and got["billable"]
    assert "3 镜" in got["note"]


def test_references_request():
    """参考资料：两种模式都能带；文件只收文字类；粘贴文字、链接有上限；编号从 r01 起"""
    from lib.common import ApiError
    from lib.validate import task_request, agent_brief
    uid = "u-" + "0" * 8 + "-0000-0000-0000-" + "0" * 12
    r = task_request({"mode": "quick", "description": "x", "refs": {"web": False, "strict": True, "items": [
        {"kind": "file", "uploadId": uid, "name": "白皮书.pdf", "note": "看第三节"},
        {"kind": "text", "title": "术语表", "text": "RAG：先检索再生成"},
        {"kind": "link", "url": "https://blog.example.com/a"}]}})
    assert r["web_search"] is False and r["refs"]["strict"] is True
    assert [x["id"] for x in r["refs"]["items"]] == ["r01", "r02", "r03"]
    b = agent_brief({"request": r})
    assert b["references"] == {"strict": True, "web": False, "count": 3, "index": "input/refs/index.json"}
    for bad in ({"kind": "file", "uploadId": uid, "name": "a.exe"}, {"kind": "text", "text": "字" * 20001}, {"kind": "link", "url": "ftp://x"}):
        with pytest.raises(ApiError):
            task_request({"mode": "quick", "description": "x", "refs": {"items": [bad]}})
    with pytest.raises(ApiError):
        task_request({"mode": "quick", "description": "x", "refs": {"items": [{"kind": "link", "url": f"https://a.com/{i}"} for i in range(6)]}})
    r = task_request({"mode": "advanced", "description": "x"})
    assert r["refs"]["items"] == [] and r["web_search"] is True   # 默认开联网


def test_notes_must_cover_every_reference(monkeypatch):
    import events
    saved, errors = {}, {}
    task = {"id": "t1", "sub": "u", "request": {"refs": {"items": [{"id": "r01"}, {"id": "r02"}]}}}
    monkeypatch.setattr(events.c, "get_task", lambda tid: task)
    monkeypatch.setattr(events.c, "update_task", lambda *a, **k: saved.setdefault("ok", True))
    monkeypatch.setattr(events.c, "set_fields", lambda tid, **kw: errors.update(kw))
    monkeypatch.setattr(events.gate, "check", lambda text: None)
    notes = {"angle": "a", "items": [{"id": "r01", "summary": "s", "used": True}]}
    monkeypatch.setattr(events.c, "read_json", lambda k: notes)
    events.process("u", "t1", {"type": "publish", "doc": "notes", "key": "u/u/t/t1/pub/notes.json"})
    assert "ok" not in saved and "r02" in errors.get("lastError", "")
    notes["items"].append({"id": "r02", "summary": "s", "used": False, "reason": "不相关"})
    events.process("u", "t1", {"type": "publish", "doc": "notes", "key": "u/u/t/t1/pub/notes.json"})
    assert saved.get("ok")


def test_upload_checked_before_daily_count(monkeypatch):
    """参考资料还没上传完、格式或大小不对时直接报错，不占当天的次数"""
    import api
    from lib.common import ApiError
    uid = "u-" + "0" * 8 + "-0000-0000-0000-" + "0" * 12
    objs = {}

    class S3:
        def list_objects_v2(self, Bucket, Prefix):
            return {"Contents": objs.get(Prefix, [])}

    taken = []
    monkeypatch.setattr(api.c, "s3", S3())
    monkeypatch.setattr(api.billing, "check_quota", lambda sub: None)
    monkeypatch.setattr(api, "quota", lambda sub: {"running": 0})
    monkeypatch.setattr(api, "take_daily", lambda sub: taken.append(sub))
    body = {"mode": "quick", "description": "x", "refs": {"items": [{"kind": "file", "uploadId": uid, "name": "a.pdf"}]}}
    with pytest.raises(ApiError) as e:
        api.create_task({"sub": "s", "email": "e"}, body)
    assert e.value.code == "upload_missing" and not taken
    pre = f"u/s/uploads/{uid}/"
    objs[pre] = [{"Key": pre + "a.pdf", "Size": 2 * 1024 * 1024}]
    with pytest.raises(ApiError) as e:
        api.create_task({"sub": "s", "email": "e"}, body)
    assert e.value.code == "ref_too_large" and not taken


UID = "u-" + "0" * 8 + "-0000-0000-0000-" + "0" * 12
TID = "1" * 8 + "-1111-1111-1111-" + "1" * 12


def test_model3d_request_and_brief():
    """3D 图片任务：描述必填，照片 0～4 张；任务说明换成 slate.model3d"""
    from lib.common import ApiError, steps_of
    from lib.validate import task_request, agent_brief
    r = task_request({"product": "model3d", "description": "薄荷绿双铃闹钟", "images": [UID], "explode": True})
    assert r["explode"] is True and task_request({"product": "model3d", "description": "x"})["explode"] is False
    assert r["product"] == "model3d" and r["images"] == [UID] and r["web_search"] is True  # 联网默认开
    assert task_request({"product": "model3d", "description": "x", "web_search": False})["web_search"] is False
    assert [n for n, _ in steps_of({"request": r})] == ["analyze", "spec", "model", "review", "export"]
    r["imageFiles"] = [{"file": "input/images/01.jpg", "name": "a.jpg", "size": 1}]
    b = agent_brief({"request": r})
    assert b["kind"] == "slate.model3d" and b["images"] == ["input/images/01.jpg"] and b["web_search"] is True and b["explode"] is True
    for bad in ({"product": "model3d", "description": ""}, {"product": "model3d", "description": "x", "images": [UID] * 5 + ["u-x"]},
                {"product": "model3d", "description": "x", "images": ["../etc"]}):
        with pytest.raises(ApiError):
            task_request(bad)


def test_video_references_library():
    """视频任务可以引用素材库的 3D 图片（最多 3 个）和文件"""
    from lib.common import ApiError
    from lib.validate import task_request, agent_brief
    fid = "f-" + "2" * 8 + "-2222-2222-2222-" + "2" * 12
    r = task_request({"mode": "quick", "description": "x", "models": [TID, TID], "refs": {"items": [{"kind": "library", "fileId": fid}]}})
    assert r["models"] == [TID] and r["refs"]["items"][0] == {"kind": "library", "fileId": fid, "note": "", "id": "r01"}
    with pytest.raises(ApiError):
        task_request({"mode": "quick", "description": "x", "models": [TID[:-1] + str(i) for i in range(4)]})
    with pytest.raises(ApiError):
        task_request({"mode": "quick", "description": "x", "refs": {"items": [{"kind": "library", "fileId": "f-bad"}]}})
    r["modelRefs"] = [{"id": "m01", "taskId": TID, "version": 1, "name": "闹钟", "factory": "createClockModel"}]
    m = agent_brief({"request": r})["models"][0]
    assert m["module"] == "input/models/m01/model.js" and m["factory"] == "createClockModel"


def test_model_version_event(monkeypatch):
    """3D 新版本：文件必须都在本任务的 model/v<n>/ 下；记进 models，并标记这一轮有产出"""
    import events
    task = {"id": "t1", "sub": "u", "request": {"product": "model3d"}, "models": []}
    calls = []
    monkeypatch.setattr(events.c, "get_task", lambda tid: task)
    monkeypatch.setattr(events.c, "update_task", lambda tid, expr, names=None, values=None, cond=None: calls.append((expr, values)))
    monkeypatch.setattr(events.c, "s3", type("S3", (), {"head_object": lambda self, **kw: {"ContentLength": 100}})())  # 模型代码的大小
    pre = "u/u/t/t1"
    good = {"module": f"{pre}/model/v1/model.js", "glb": f"{pre}/model/v1/model.glb", "views": {"0": f"{pre}/model/v1/views/000.png"}}
    events.process("u", "t1", {"type": "model", "n": 1, "files": {**good, "glb": "u/other/t/x/model.glb"}})
    assert not calls
    events.process("u", "t1", {"type": "model", "n": 1, "files": good})
    expr, values = calls[0]
    assert "turnFlags.version" in expr and values[":v"][0]["n"] == 1 and values[":v"][0]["files"]["views"]["0"].endswith("000.png")


def _model_task():
    pre = "u/u/t/" + TID
    files = {"module": f"{pre}/model/v1/model.js", "glb": f"{pre}/model/v1/model.glb", "turntable": f"{pre}/model/v1/turntable.mp4",
             "views": {a: f"{pre}/model/v1/views/{int(a):03d}.png" for a in ("0", "90", "180", "270", "35")}}
    return {"id": TID, "sub": "u", "title": "闹钟", "status": "completed", "createdAt": 1, "updatedAt": 2,
            "request": {"product": "model3d", "description": "闹钟", "imageFiles": [{"file": "input/images/01.jpg", "name": "a.jpg"}]},
            "docs": {"asset": {"name": "薄荷绿闹钟", "tags": ["闹钟"], "summary": "s", "factory": "createClockModel", "size": [1, 1, 1],
                               "parts": [{"id": "handle", "name": "提手"}]}},
            "steps": {}, "models": [{"n": 1, "files": files, "at": 3}]}


def test_model_detail_and_list_view(monkeypatch):
    from lib import views
    monkeypatch.setattr(views.c, "media_url", lambda k, download_name=None: "https://cdn/" + k)
    monkeypatch.setattr(views.billing, "turns_of", lambda tid: [])
    t = _model_task()
    d = views.detail_view(t, [])
    assert d["product"] == "model3d" and [s["name"] for s in d["steps"]] == ["analyze", "spec", "model", "review", "export"]
    v = d["model"]["versions"][0]
    assert [x["angle"] for x in v["views"]] == [0, 90, 180, 270, 35] and v["glb"].endswith("model.glb") and v["comparison"] is None
    assert d["request"]["images"][0]["url"].endswith("input/images/01.jpg") and d["title"] == "薄荷绿闹钟"
    item = views.list_view([t])[0]
    assert item["product"] == "model3d" and item["kind"] == "3D 图片" and item["thumbUrl"].endswith("035.png")


def test_library_items(monkeypatch):
    """素材库：视频和 3D 图片从任务里来，移除只是隐藏；按名称和标签搜索"""
    from lib import library
    t = _model_task()
    video = {"id": "2" * 8 + "-2222-2222-2222-" + "2" * 12, "sub": "u", "status": "completed", "title": "录音机广告", "createdAt": 1, "updatedAt": 5,
             "request": {"product": "video"}, "docs": {}, "versions": [{"n": 1, "key": "k.mp4", "dur": 15}]}
    store = {t["id"]: t, video["id"]: video}
    monkeypatch.setattr(library.c, "media_url", lambda k, download_name=None: "https://cdn/" + k)
    monkeypatch.setattr(library.c, "tasks_of", lambda sub, limit=100: list(store.values()))
    monkeypatch.setattr(library.c, "get_task", lambda tid: store.get(tid))
    monkeypatch.setattr(library.c, "set_fields", lambda tid, **kw: store[tid].update(kw))
    assert [x["name"] for x in library.list_items("u", "model3d")] == ["薄荷绿闹钟"]
    assert [x["id"] for x in library.list_items("u", "video")] == [video["id"]]
    assert library.list_items("u", "model3d", "闹") and not library.list_items("u", "model3d", "汽车")
    item = library.update("u", "model3d", t["id"], {"name": " 绿闹钟 ", "tags": ["复古", "复古", ""]})
    assert item["name"] == "绿闹钟" and item["tags"] == ["复古"]
    library.remove("u", "video", video["id"])
    assert library.list_items("u", "video") == []


def test_create_task_model3d_and_video_with_model(monkeypatch):
    """建 3D 任务：照片复制进 input/images/；建视频任务引用 3D 图片：模型、素材卡和两张渲染图放进 input/models/m01/"""
    import api
    from lib.common import ApiError
    objs, copies, puts, saved = {}, [], {}, {}

    class S3:
        def list_objects_v2(self, Bucket, Prefix):
            return {"Contents": objs.get(Prefix, [])}

        def copy_object(self, Bucket, Key, CopySource):
            copies.append((CopySource["Key"], Key))

        def put_object(self, Bucket, Key, Body, ContentType=None):
            puts[Key] = Body

    monkeypatch.setattr(api.c, "s3", S3())
    monkeypatch.setattr(api.billing, "check_quota", lambda sub: None)
    monkeypatch.setattr(api, "quota", lambda sub: {"running": 0})
    monkeypatch.setattr(api, "take_daily", lambda sub: None)
    monkeypatch.setattr(api.c, "put_task", lambda item: saved.update(task=item))
    monkeypatch.setattr(api.c, "add_message", lambda *a, **k: None)
    monkeypatch.setattr(api, "start_turn", lambda *a, **k: None)
    user = {"sub": "s", "email": "e"}
    pre = f"u/s/uploads/{UID}/"
    objs[pre] = [{"Key": pre + "front.HEIC", "Size": 100, "ETag": '"x"'}]
    with pytest.raises(ApiError) as e:
        api.create_task(user, {"product": "model3d", "description": "闹钟", "images": [UID]})
    assert e.value.code == "bad_image_type"
    objs[pre] = [{"Key": pre + "front.JPG", "Size": 100, "ETag": '"x"'}]
    api.create_task(user, {"product": "model3d", "description": "闹钟", "images": [UID]})
    t = saved["task"]
    assert t["request"]["imageFiles"] == [{"file": "input/images/01.jpg", "name": "front.JPG", "size": 100}] and "images" not in t["request"]
    assert set(t["steps"]) == {"analyze", "spec", "model", "review", "export"} and copies[-1][1].endswith("/input/images/01.jpg")
    model = _model_task(); model["sub"] = "s"
    monkeypatch.setattr(api.c, "get_task", lambda tid: model if tid == TID else None)
    api.create_task(user, {"mode": "quick", "description": "做一支闹钟广告", "models": [TID]})
    t = saved["task"]
    assert t["request"]["modelRefs"] == [{"id": "m01", "taskId": TID, "version": 1, "name": "薄荷绿闹钟", "factory": "createClockModel"}]
    dst = {k for _, k in copies}
    assert any(k.endswith("/input/models/m01/model.js") for k in dst) and any(k.endswith("/input/models/m01/view-35.png") for k in dst)
    assert any(k.endswith("/input/models/m01/asset.json") for k in puts)
    with pytest.raises(ApiError) as e:
        api.create_task(user, {"mode": "quick", "description": "x", "models": ["9" * 8 + "-9999-9999-9999-" + "9" * 12]})
    assert e.value.code == "model_missing"


def test_model_code_safety():
    """3D 预览会在用户浏览器里执行模型代码：网络、存储、页面和全局对象一律不许碰。
    直接查原文，字符串和注释里出现也算（增量安全扫描）；连字符、下划线连着的名字不算"""
    from lib.library import unsafe
    for bad in ("fetch('https://x')", "localStorage.token", "new Image().src = u", "x.constructor('alert(1)')()", "import('https://x')",
                "document.body.appendChild(s)", "c.ownerDocument.defaultView", "`${fetch(u)}`", "window['fe' + 'tch']",
                "n.name = \"VU meter window L\"", "// 不要用 window"):
        assert unsafe(bad), bad
    for ok in ("const c = document.createElement('canvas')", "if (typeof document === 'undefined') return null",
               "node('dial-window'); n.name = 'window_left'", "const top = mesh.parent"):
        assert unsafe(ok) is None, ok


def test_completed_task_shows_running_steps_done(monkeypatch):
    """任务完成了，Agent 漏报"完成"的步骤按完成显示"""
    from lib import views
    monkeypatch.setattr(views.c, "media_url", lambda k, download_name=None: "https://cdn/" + k)
    monkeypatch.setattr(views.billing, "turns_of", lambda tid: [])
    t = _model_task(); t["steps"] = {"analyze": {"state": "running", "note": "看图"}, "export": {"state": "done", "note": ""}}
    st = {s["name"]: s["state"] for s in views.detail_view(t, [])["steps"]}
    assert st["analyze"] == "done" and st["spec"] == "pending"
    t["status"] = "running"
    assert {s["name"]: s["state"] for s in views.detail_view(t, [])["steps"]}["analyze"] == "running"


def _cube(x0, y0, z0, s):
    """非索引的立方体（像 three.js 的 BoxGeometry，每个面有自己的顶点）"""
    c = [(x0 + dx * s, y0 + dy * s, z0 + dz * s) for dx in (0, 1) for dy in (0, 1) for dz in (0, 1)]
    pos = []
    for a, b, cc, d in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        for t in ((a, b, cc), (a, cc, d)):
            for k in t:
                pos += list(c[k])
    return pos


def test_printfile_basics():
    """打印源数据：焊接后的方块是封闭的、面片不是；几乎一样的颜色并成一种；3MF 两种出法、STL 打包"""
    import io, zipfile
    from lib import printfile as pf
    src = pf.prepare({"meshes": [{"part": "base", "color": "#202020", "pos": _cube(0, 0, 0, 1)},
                                 {"part": "lid", "color": "#c0392b", "pos": _cube(0, 1, 0, 1)},
                                 {"part": "lid", "color": "#c83a2e", "name": "贴片", "pos": [0, 2, 0, 1, 2, 0, 1, 2, 1]}]})
    vols = {(p["id"], v["color"]): v for p in src["parts"] for v in p["volumes"]}
    assert vols[("base", "#202020")]["closed"] and len(vols[("base", "#202020")]["verts"]) == 24 and not vols[("lid", "#c83a2e")]["closed"]
    assert any("不封闭" in w for w in pf.check(src))
    data, fname, rep = pf.build(src, "a1", 60, "whole", 4, "3mf", {"base": "底座", "lid": "盖子"})
    model = zipfile.ZipFile(io.BytesIO(data)).read("3D/3dmodel.model").decode()
    assert fname == "model.3mf" and model.count("<item ") == 1 and 'unit="millimeter"' in model and len(rep["colors"]) == 2
    assert rep["sizeMm"][2] == 60.0
    data, fname, rep = pf.build(src, "a1", 60, "parts", 4, "stl", {"base": "底座", "lid": "盖子"})
    assert fname == "parts-stl.zip" and len(zipfile.ZipFile(io.BytesIO(data)).namelist()) == 2 and rep["objects"] == 2
    with pytest.raises(ValueError):
        pf.build(src, "a1mini", 200)


def test_model_version_with_explode_and_print(monkeypatch):
    """新版本带拆解 GIF、拆解图、打印源数据和拆解步骤；详情给出 explode 和 printable，素材卡带上步骤"""
    import events
    from lib import views
    task = _model_task()
    pre = "u/u/t/" + TID
    calls = []
    monkeypatch.setattr(events.c, "get_task", lambda tid: task)
    monkeypatch.setattr(events.c, "update_task", lambda tid, expr, names=None, values=None, cond=None: calls.append(values))
    monkeypatch.setattr(events.c, "s3", type("S3", (), {"head_object": lambda self, **kw: {"ContentLength": 100}})())  # 模型代码的大小
    files = {**task["models"][0]["files"], "explodeGif": f"{pre}/model/v2/explode.gif", "exploded": f"{pre}/model/v2/exploded.png",
             "printSrc": f"{pre}/model/v2/print-src.json.gz", "module": f"{pre}/model/v2/model.js", "glb": f"{pre}/model/v2/model.glb",
             "views": {"0": f"{pre}/model/v2/views/000.png"}}
    files.pop("turntable")
    events.process("u", TID, {"type": "model", "n": 2, "files": files, "steps": [{"label": "拆下提手", "parts": ["handle"]}]})
    v2 = calls[0][":v"][0]
    assert v2["steps"] == [{"label": "拆下提手", "parts": ["handle"]}] and "printSrc" in v2["files"]
    task["models"].append(v2)
    monkeypatch.setattr(views.c, "media_url", lambda k, download_name=None: "https://cdn/" + k)
    monkeypatch.setattr(views.billing, "turns_of", lambda tid: [])
    d = views.detail_view(task, [])
    last = d["model"]["versions"][-1]
    assert last["explode"]["gif"].endswith("explode.gif") and last["printable"] and "turntable" not in last
    assert d["model"]["versions"][0]["explode"] is None and not d["model"]["versions"][0]["printable"]
    assert d["model"]["asset"]["explode"] == {"steps": [{"label": "拆下提手", "parts": ["handle"]}]}


def test_print_endpoint(monkeypatch):
    """打印接口：读打印源数据、生成 3MF、传到任务的 print/ 下；放不下热床时给中文提示"""
    import api
    from lib import printfile as pf
    from lib.common import ApiError
    t = _model_task()
    t["models"][0]["files"]["printSrc"] = "u/u/t/x/model/v1/print-src.json.gz"
    src = pf.dumps(pf.prepare({"meshes": [{"part": "handle", "color": "#888888", "pos": _cube(0, 0, 0, 1)}]}))
    puts = {}

    class S3:
        def get_object(self, Bucket, Key):
            return {"Body": io.BytesIO(src), "ContentLength": len(src)}

        def put_object(self, Bucket, Key, Body, ContentType=None):
            puts[Key] = (len(Body), ContentType)

    import io
    monkeypatch.setattr(api.c, "s3", S3())
    monkeypatch.setattr(api.c, "media_url", lambda k, download_name=None: f"https://cdn/{k}?dl={download_name}")
    r = api.print_file(t, {"printer": "a1mini", "height": 50, "mode": "parts", "colors": 4, "format": "3mf"})
    assert r["file"].endswith(".3mf") and r["report"]["parts"] == 1 and r["report"]["colors"][0]["parts"] == ["提手"]
    assert list(puts.values())[0][1].startswith("application/vnd.ms-package.3dmanufacturing")
    with pytest.raises(ApiError) as e:
        api.print_file(t, {"printer": "a1mini", "height": 500})
    assert e.value.code == "print_failed" and "180" in e.value.message
    del t["models"][0]["files"]["printSrc"]
    with pytest.raises(ApiError):
        api.print_file(t, {})


# ---------------------------------------------------------------- 风格创建（docs/style-creator-design.md 第十一节）

def _style(**kw):
    st = {"pk": "STYLES", "sk": "film-paper", "name": "纸面科普", "cat": "插画讲解", "uses": ["science"], "taskId": "t1",
          "versions": [{"n": 1, "summary": "纸面上一拍一个落进来", "thumb": "styles/film-paper/v1/review/thumb.jpg", "traits": {"highlights": ["a"]}},
                       {"n": 2, "summary": "第二版", "traits": {}}], "tests": []}
    st.update(kw)
    return st


def test_style_status_and_visibility(monkeypatch):
    """公开发布以前只有管理员看得到：普通用户只看到公开版，管理员优先看到内测版"""
    from lib import styles
    assert styles.status_of({"taskId": "t"}, {"status": "running"}) == "generating"
    assert styles.status_of({"taskId": "t", "versions": [{"n": 1}]}, {"status": "completed"}) == "review"
    assert styles.status_of({"taskId": "t"}, {"status": "failed"}) == "failed"
    assert styles.status_of({}) == "draft"
    assert styles.status_of({"betaV": 1, "versions": [{"n": 1}]}) == "beta"
    assert styles.status_of({"betaV": 2, "publicV": 1}) == "public"
    assert styles.status_of({"publicV": 1, "retired": {"at": 1}}) == "retired"
    rows = [_style(sk="film-a", betaV=2), _style(sk="film-b", publicV=1), _style(sk="film-c", betaV=2, publicV=1),
            _style(sk="film-d", publicV=1, retired={"at": 1}), _style(sk="film-e")]
    monkeypatch.setattr(styles, "all_styles", lambda: rows)
    monkeypatch.setattr(styles.c, "media_url", lambda k, download_name=None: f"https://cdn/{k}")
    assert sorted(styles.visible(False)) == ["film-b", "film-c"]
    vis = styles.visible(True)
    assert sorted(vis) == ["film-a", "film-b", "film-c"] and vis["film-c"][1:] == (2, True) and vis["film-b"][1:] == (1, False)
    items = {x["id"]: x for x in styles.catalog_items(False)}
    assert items["film-b"]["ver"] == "1" and items["film-b"]["thumb"] == "https://cdn/styles/film-paper/v1/review/thumb.jpg"
    assert items["film-b"]["beta"] is False and items["film-b"]["generated"] is True and items["film-b"]["summary"] == "纸面上一拍一个落进来"


def test_generated_style_in_task_request_and_brief():
    """生成的风格和内置风格一样能选；看不到的风格被忽略；任务说明里给出说明书路径"""
    from lib.common import ApiError
    from lib.validate import agent_brief, task_request
    body = {"mode": "advanced", "description": "讲面包发霉", "options": {"skills": {"enabled": True, "ids": ["film-paper"]}}}
    with pytest.raises(ApiError):
        task_request(body)  # 普通用户看不到这个内测风格：等于没选
    r = task_request(body, {"film-paper": None})
    assert r["options"]["skills"]["ids"] == ["film-paper"]
    r["styleRefs"] = [{"id": "film-paper", "name": "纸面科普", "v": 2, "beta": True}]
    b = agent_brief({"request": r})
    assert b["options"]["skills"]["generated"] == [{"id": "film-paper", "name": "纸面科普", "guide": "input/styles/film-paper/SKILL.md"}]
    st = agent_brief({"request": {"product": "style", "style": {"id": "film-paper", "name": "纸面科普", "notes": "保留纸纹"},
                                  "source": "ref.mp4"}})
    assert st["kind"] == "slate.style" and st["reference"] == "input/ref/ref.mp4" and st["skill_dir"] == "style/film-paper/"


class _Pages:
    def __init__(self, keys):
        self.keys = keys

    def paginate(self, Bucket, Prefix):
        yield {"Contents": [{"Key": k} for k in self.keys if k.startswith(Prefix)]}


def test_copy_style_into_task_and_new_version(monkeypatch):
    from lib import styles
    copies = []

    class S3:
        def __init__(self, keys, body=b"{}"):
            self.keys, self.body = keys, body

        def get_paginator(self, name):
            return _Pages(self.keys)

        def copy_object(self, Bucket, Key, CopySource):
            copies.append((CopySource["Key"], Key))

        def get_object(self, Bucket, Key):
            import io
            return {"Body": io.BytesIO(self.body)}

    st = _style(betaV=2)
    monkeypatch.setattr(styles.c, "s3", S3(["styles/film-paper/v2/skill/SKILL.md", "styles/film-paper/v2/skill/demo/engine.js",
                                             "styles/film-paper/v2/review/thumb.jpg"]))
    refs = styles.copy_into_task("u1", "t9", ["film-paper", "film-x"], {"film-paper": (st, 2, True)})
    assert refs == [{"id": "film-paper", "name": "纸面科普", "v": 2, "beta": True}]
    assert sorted(k for _, k in copies) == ["u/u1/t/t9/input/styles/film-paper/SKILL.md", "u/u1/t/t9/input/styles/film-paper/demo/engine.js"]
    # 生成任务发出第 3 版：文件复制到 styles/<id>/v3/，路径换成数据桶里的
    copies.clear()
    pre = "u/a/t/g1"
    keys = [f"{pre}/style/v3/skill/SKILL.md", f"{pre}/style/v3/skill/demo/engine.js", f"{pre}/style/v3/review/recon/R1/side.mp4",
            f"{pre}/style/v3/review/thumb.jpg"]
    monkeypatch.setattr(styles.c, "s3", S3(keys, json.dumps({"line": "一句话"}).encode()))
    monkeypatch.setattr(styles, "get", lambda sid: _style(feedback=[{"forV": 3, "text": "纸色再暖一点"}]))
    saved = {}

    class T:
        def update_item(self, **kw):
            saved.update(kw)
    monkeypatch.setattr(styles.c, "table", lambda: T())
    task = {"id": "g1", "request": {"product": "style", "style": {"id": "film-paper"}}}
    ev = {"n": 3, "segments": [{"id": "R1", "desc": "d", "motion": 0.94, "side": "review/recon/R1/side.mp4", "cmp": "review/recon/R1/cmp.png"}],
          "demos": [{"id": "D1", "url": "review/demo/D1.mp4"}], "thumb": "review/thumb.jpg", "checks": [{"name": "格式", "ok": True}]}
    val = styles.new_version(task, ev, pre)
    assert val["n"] == 3 and val["summary"] == "一句话" and val["feedback"] == "纸色再暖一点"
    assert val["segments"][0]["side"] == "styles/film-paper/v3/review/recon/R1/side.mp4" and val["thumb"] == "styles/film-paper/v3/review/thumb.jpg"
    assert val["segments"][0]["cmp"] is None  # 事件里引用了、但没复制过来的文件不认（第二次扫描 #12）
    assert styles.public_traits({"line": "一句话", "highlights": ["a" * 99], "example": "例"}) == {"line": "一句话", "highlights": ["a" * 60], "example": "例"}
    assert val["files"] == ["SKILL.md", "demo/engine.js"]
    assert ("u/a/t/g1/style/v3/skill/SKILL.md", "styles/film-paper/v3/skill/SKILL.md") in copies
    assert styles.new_version(task, {**ev, "n": 2}, pre) is None  # 第 2 版已经有了


def test_gate_blocks_generated_style_text(monkeypatch):
    """内测发布后，生成风格的说明书片段不能出现在给用户的文字里；一句话定位可以"""
    from lib import gate

    class S3:
        def get_paginator(self, name):
            return _Pages(["styles/protected/film-paper-v1.json"])

        def get_object(self, Bucket, Key):
            import io
            return {"Body": io.BytesIO(json.dumps({"text": "纸面上的物件一拍一个落进来，落入用时零点三八秒，起点在画面上缘外", "allow": "纸面上的物件一拍一个落进来"}).encode())}
    monkeypatch.setattr(gate, "_styles", (0.0, frozenset()))
    import lib.common as c
    monkeypatch.setattr(c, "DATA_BUCKET", "b")
    monkeypatch.setattr(c, "s3", S3())
    assert gate.check("落入用时零点三八秒，起点在画面上缘外九个百分点") == "包含平台内部资料片段"
    assert gate.check("这个风格：纸面上的物件一拍一个落进来") is None


def test_admin_style_create_validation(monkeypatch):
    import admin_styles as a
    from lib.common import ApiError
    monkeypatch.setattr(a, "_taken", lambda sid: sid == "film-taken")
    monkeypatch.setattr(a.styles, "get", lambda sid: None)
    puts = {}

    class T:
        def put_item(self, Item, **kw):
            puts[Item["sk"]] = Item

    class S3:
        def generate_presigned_url(self, op, Params, ExpiresIn):
            return f"https://s3/{Params['Key']}"
    monkeypatch.setattr(a.c, "table", lambda: T())
    monkeypatch.setattr(a.c, "s3", S3())
    monkeypatch.setattr(a.audit, "write", lambda *x: None)
    me = {"sub": "s", "email": "admin@example.com"}
    ok = {"name": "纸面科普", "slug": "paper", "cat": "插画讲解", "rights": True,
          "file": {"name": "ref.mp4", "size": 3 << 20, "contentType": "video/mp4"}}
    r = a.create(ok, me)
    assert r["id"] == "film-paper" and r["upload"]["url"].endswith("styles/film-paper/source/ref.mp4")
    assert "uses" not in puts["film-paper"]  # 风格和写法互相独立，不记适用写法
    # 自己的草稿（上次上传断了）可以用同一个短名再要一个上传链接；别人的、或已经开始生成的不行
    monkeypatch.setattr(a, "_taken", lambda sid: True)
    monkeypatch.setattr(a.styles, "get", lambda sid: {"sk": sid, "createdBy": {"sub": "s"}})
    assert a.create(ok, me)["id"] == "film-paper"
    monkeypatch.setattr(a.styles, "get", lambda sid: {"sk": sid, "createdBy": {"sub": "s"}, "taskId": "t"})
    with pytest.raises(ApiError) as e:
        a.create(ok, me)
    assert e.value.code == "taken"
    monkeypatch.setattr(a, "_taken", lambda sid: sid == "film-taken")
    monkeypatch.setattr(a.styles, "get", lambda sid: None)
    for bad, code in (({"slug": "1paper"}, "bad_slug"), ({"rights": False}, "no_rights"), ({"slug": "taken"}, "taken"),
                      ({"file": {"name": "ref.gif", "size": 10}}, "bad_file"), ({"file": {"name": "ref.mp4", "size": 400 << 20}}, "bad_size")):
        with pytest.raises(ApiError) as e:
            a.create({**ok, **bad}, me)
        assert e.value.code == code


def test_style_tasks_hidden_from_user_api(monkeypatch):
    """生成任务归在管理员名下，但用户端接口一律 404"""
    import api
    from lib.common import ApiError
    monkeypatch.setattr(api.c, "get_task", lambda tid: {"id": tid, "sub": "s", "request": {"product": "style"}})
    with pytest.raises(ApiError) as e:
        api.owned("t", {"sub": "s"})
    assert e.value.status == 404


def test_strict_needs_references():
    """强制引用只针对用户给的资料：没有资料时不生效，只开联网也不算"""
    from lib.validate import task_request
    r = task_request({"mode": "quick", "description": "讲 RAG", "refs": {"web": True, "strict": True, "items": []}})
    assert r["refs"]["strict"] is False
    r = task_request({"mode": "quick", "description": "讲 RAG", "refs": {"web": False, "strict": True,
                                                                       "items": [{"kind": "link", "url": "https://example.com/a"}]}})
    assert r["refs"]["strict"] is True


# ---------- 工作流模式（docs/workflow-mode-design.md） ----------

FLOW = "11111111-2222-3333-4444-555555555555"
TASK_A = "aaaaaaaa-2222-3333-4444-555555555555"


def _flow_doc(**over):
    nodes = [{"k": "t", "type": "text", "x": 10.4, "y": 20, "cfg": {"desc": "讲 RAG"}, "task": TASK_A},
             {"k": "i", "type": "image", "x": 0, "y": 300, "cfg": {"mode": "new"}},
             {"k": "a", "type": "av", "x": 400, "y": 50, "cfg": {"main": "film-watercolor"}}]
    return {"nodes": over.get("nodes", nodes), "edges": over.get("edges", [["t", "a", "text"], ["i", "a", "img"]])}


def test_flow_doc_rules():
    """画板：文字、音画各 1 个，图片最多 3 个；连线只能连到音画节点的对应入口；我的工作流不带任务编号"""
    from lib import flows
    from lib.common import ApiError
    d = json.loads(flows.clean_doc(_flow_doc()))
    assert d["nodes"][0]["x"] == 10 and d["nodes"][0]["task"] == TASK_A
    assert d["edges"] == [["t", "a", "text"], ["i", "a", "img"]]
    t = json.loads(flows.clean_doc(_flow_doc(), template=True))
    assert all("task" not in n for n in t["nodes"])
    # 连错的线直接丢掉：文字连到图片入口、图片连到文字节点、重复的线
    d = json.loads(flows.clean_doc(_flow_doc(edges=[["t", "a", "img"], ["i", "t", "img"], ["i", "a", "img"], ["i", "a", "img"]])))
    assert d["edges"] == [["i", "a", "img"]]
    with pytest.raises(ApiError):
        flows.clean_doc(_flow_doc(nodes=[{"k": "t", "type": "text", "cfg": {}}, {"k": "u", "type": "text", "cfg": {}}]))
    with pytest.raises(ApiError):
        flows.clean_doc(_flow_doc(nodes=[{"k": "t", "type": "video", "cfg": {}}]))
    with pytest.raises(ApiError) as e:
        flows.clean_doc(_flow_doc(nodes=[{"k": "t", "type": "text", "cfg": {"desc": "长" * 30000}}]))
    assert e.value.status == 413


def test_flow_task_request():
    """工作流建的视频任务：一定停在分镜等确认；要带规格；长片第一版不支持"""
    from lib.common import ApiError
    from lib.validate import task_request, agent_brief
    spec = {"enabled": True, "ratio": "9:16", "duration": 60, "resolution": "1080p", "fps": 30, "voice_id": "auto"}
    r = task_request({"mode": "advanced", "description": "讲 RAG", "flow": FLOW, "options": {"spec": spec, "confirm_storyboard": False}})
    assert r["flow"] == FLOW and r["options"]["confirm_storyboard"] is True
    assert agent_brief({"request": r})["flow"] is True
    assert "flow" not in agent_brief({"request": task_request({"mode": "quick", "description": "讲 RAG"})})
    for body, code in [({"mode": "quick"}, "bad_flow"), ({"mode": "advanced", "options": {}}, "bad_flow"),
                       ({"mode": "advanced", "options": {"spec": {**spec, "duration": 600}}}, "flow_long"),
                       ({"mode": "advanced", "flow": "x", "options": {"spec": spec}}, "bad_flow")]:
        with pytest.raises(ApiError) as e:
            task_request({"description": "讲 RAG", "flow": FLOW, **body})
        assert e.value.code == code
    m = task_request({"product": "model3d", "description": "闹钟", "flow": FLOW})
    assert m["flow"] == FLOW


def test_flow_changed_scenes():
    """成片版本里记着每镜的指纹；之后文字节点改了旁白、加了镜头、去掉了镜头都能比出来，只改时长不算"""
    from lib import flows
    sb = {"scenes": [{"id": "01", "narration": "甲", "visual": "a", "duration": 5}, {"id": "02", "narration": "乙", "visual": "b"}]}
    task = {"docs": {"storyboard": sb}, "versions": [{"n": 1, "sb": flows.scene_sig(sb)}]}
    assert flows.changed_scenes(task) == ([], [])
    task["docs"]["storyboard"] = {"scenes": [{"id": "01", "narration": "甲", "visual": "a", "duration": 7},
                                             {"id": "03", "narration": "丙", "visual": "c"}]}
    assert flows.changed_scenes(task) == (["03"], ["02"])
    assert flows.changed_scenes({"docs": {"storyboard": sb}, "versions": [{"n": 1}]}) == ([], [])  # 老版本没记指纹


def _flow_task(**over):
    req = {"product": "video", "flow": FLOW, "description": "讲 RAG", "models": [], "modelRefs": [],
           "options": {"skills": {"enabled": False, "ids": []},
                       "spec": {"enabled": True, "ratio": "16:9", "duration": 60, "resolution": "1080p", "fps": 30,
                                "voice": True, "voice_id": "auto", "subtitles": True, "bgm": False}}}
    return {"id": TASK_A, "sub": "s", "status": "awaiting_confirmation", "request": req, "docs": {"storyboard": {"scenes": []}},
            "versions": [], **over}


def test_flow_av_confirm_and_rerun(monkeypatch):
    """音画节点：没出片时是确认分镜（带上设置的改动）；出片以后是重跑，没有改动时不让跑"""
    import api
    from lib.common import ApiError
    turns, msgs, saved = [], [], {}
    monkeypatch.setattr(api.billing, "check_quota", lambda sub: None)
    monkeypatch.setattr(api.c, "add_message", lambda *a, **k: msgs.append((a, k)))
    monkeypatch.setattr(api.c, "set_fields", lambda tid, **f: saved.update(f))
    monkeypatch.setattr(api, "start_turn", lambda task, kind, text=None, extra=None, check=True: turns.append((kind, text, extra)))
    model = {"id": "bbbbbbbb-2222-3333-4444-555555555555", "sub": "s", "request": {"product": "model3d"}, "models": [{"n": 2, "files": {}}]}
    monkeypatch.setattr(api.c, "get_task", lambda tid: model if tid == model["id"] else None)
    monkeypatch.setattr(api, "_copy_model", lambda sub, tid, t, mid: {"id": mid, "taskId": t["id"], "version": 2, "name": "闹钟", "factory": "f"})
    task = _flow_task()
    body = {"skills": {"ids": ["film-watercolor"]}, "spec": {"ratio": "9:16", "voice_id": "warm-bestie", "bgm": True},
            "models": [model["id"]], "note": "节奏快一点"}
    api.flow_av(task, body, {"sub": "s"})
    kind, text, extra = turns[-1]
    assert kind == "confirm" and text == "节奏快一点" and extra["node"] == "av"
    ch = "\n".join(extra["changes"])
    assert "视觉风格" in ch and "水彩" in ch and "画幅：16:9 → 9:16" in ch and "音色：按内容挑选 → 温暖闺蜜" in ch
    assert "背景音乐：关 → 开" in ch and "新加了 3D 图片 m01" in ch
    assert saved["request"]["options"]["skills"] == {"enabled": True, "ids": ["film-watercolor"]}
    assert saved["request"]["modelRefs"][0]["id"] == "m01" and msgs[-1][1]["extra"] == {"node": "av"}
    # 出片以后：设置都没变、分镜也没改，不让重跑
    from lib import flows
    sb = {"scenes": [{"id": "01", "narration": "甲", "visual": "a"}]}
    done = _flow_task(status="completed", docs={"storyboard": sb}, versions=[{"n": 1, "sb": flows.scene_sig(sb)}])
    done["request"] = saved["request"]
    with pytest.raises(ApiError) as e:
        api.flow_av(done, {**body, "note": ""}, {"sub": "s"})
    assert e.value.code == "nothing_to_do"
    # 文字节点改了第 01 镜：重跑，改动清单里先说分镜改了哪几镜
    done["docs"]["storyboard"] = {"scenes": [{"id": "01", "narration": "甲改", "visual": "a"}]}
    api.flow_av(done, {**body, "note": ""}, {"sub": "s"})
    kind, text, extra = turns[-1]
    assert kind == "revise" and extra["rerun"] and extra["changes"][0].startswith("文字节点改过分镜：第 01 镜")
    # 断开 3D 图片也是改动
    api.flow_av(done, {**body, "models": [], "note": ""}, {"sub": "s"})
    assert any("去掉了 3D 图片 m01" in x for x in turns[-1][2]["changes"])
    with pytest.raises(ApiError):
        api.flow_av({**done, "status": "running"}, body, {"sub": "s"})
    with pytest.raises(ApiError) as e:
        api.flow_av({**_flow_task(), "request": {"product": "video"}}, body, {"sub": "s"})
    assert e.value.code == "not_flow"


def test_flow_messages_by_node(monkeypatch):
    """工作流任务的消息：文字节点的修改只改剧本和分镜（提示里写明不配音、不渲染，修改轮不重置后三步），音画节点的是平常的修改"""
    import api, turn
    from lib.common import ApiError
    turns, msgs = [], []
    monkeypatch.setattr(api.billing, "check_quota", lambda sub: None)
    monkeypatch.setattr(api.c, "add_message", lambda *a, **k: msgs.append(k))
    monkeypatch.setattr(api, "start_turn", lambda task, kind, text=None, extra=None, check=True: turns.append((kind, text, extra)))
    t = _flow_task(docs={"storyboard": {"scenes": [{"id": "01"}]}})
    api.send_message(t, {"text": "第 1 镜开场换个问题", "node": "text"})
    assert turns[-1][2]["node"] == "text" and msgs[-1]["extra"] == {"node": "text"}
    prompt = turn._body(t, {"kind": "revise", "node": "text", "text": "第 1 镜开场换个问题"})
    assert "不要配音" in prompt and "slate.revise" in prompt
    with pytest.raises(ApiError):  # 没出片时不能在音画节点里改
        api.send_message(t, {"text": "画面太空", "node": "av"})
    done = _flow_task(status="completed", versions=[{"n": 1}], docs={"storyboard": {"scenes": [{"id": "01"}]}})
    api.send_message(done, {"text": "画面太空"})  # 生成页发的：出片后算音画节点
    assert turns[-1][2]["node"] == "av"
    with pytest.raises(ApiError) as e:
        api.send_message({**_flow_task(), "request": {"product": "video"}}, {"text": "改", "node": "text"})
    assert e.value.code == "bad_node"
    rerun = turn._body(done, {"kind": "revise", "rerun": True, "node": "av", "changes": ["音色：A → B"]})
    assert "slate.rerun" in rerun and "音色：A → B" in rerun
    conf = turn._body(done, {"kind": "confirm", "node": "av", "changes": ["画幅：16:9 → 9:16"], "text": "快一点"})
    assert "画幅：16:9 → 9:16" in conf and "快一点" in conf


# ---------- 写作方法和画风两个维度（docs/skills-two-dimensions.md） ----------

def test_writing_skills_visible_by_kind_and_owner(monkeypatch):
    """生成的 Skill 按类别分开：写作方法不出现在画风库里，反过来也一样；以后用户自己的只有本人看得到"""
    from lib import styles
    rows = [_style(sk="film-a", publicV=1), _style(sk="write-a", kind="writing", group="宣传", publicV=1),
            _style(sk="write-b", kind="writing", betaV=1), _style(sk="write-mine", kind="writing", owner="user:u1", publicV=1)]
    monkeypatch.setattr(styles, "all_styles", lambda: rows)
    monkeypatch.setattr(styles.c, "media_url", lambda k, download_name=None: f"https://cdn/{k}")
    assert sorted(styles.visible(False)) == ["film-a"]
    assert sorted(styles.visible(False, "writing")) == ["write-a"]
    assert sorted(styles.visible(True, "writing")) == ["write-a", "write-b"]
    assert sorted(styles.visible(False, "writing", "u1")) == ["write-a", "write-mine"]
    items = {x["id"]: x for x in styles.writing_items(True)}
    assert items["write-a"]["group"] == "宣传" and items["write-b"]["beta"] is True and items["write-a"]["generated"] is True
    assert [x["id"] for x in styles.catalog_items(True)] == ["film-a"]


def test_generated_writing_in_task_request_and_brief():
    """生成的写作方法和内置的一样能选；任务说明指向任务目录里的说明书，并带上所属的一类；内置的路径不变"""
    from lib.common import ApiError
    from lib.validate import agent_brief, genre_name, task_request
    body = {"mode": "quick", "description": "讲面包发霉", "genre": "write-hook"}
    with pytest.raises(ApiError):
        task_request(body)  # 看不到这个写作方法
    r = task_request(body, (), {"write-hook": None})
    r["writingRef"] = {"id": "write-hook", "name": "悬念开场", "v": 1, "beta": True, "group": "宣传"}
    g = agent_brief({"request": r})["genre"]
    assert g == {"id": "write-hook", "name": "悬念开场", "guide": "input/writing/write-hook/SKILL.md", "group": "宣传", "generated": True}
    assert genre_name(r) == "悬念开场"
    built = agent_brief({"request": task_request({"mode": "quick", "description": "讲猫", "genre": "science"})})["genre"]
    assert built == {"id": "science", "name": "知识科普", "guide": "/.agents/skills/core-director/genres/science.md"}
    st = agent_brief({"request": {"product": "style", "outputs": ["visual", "writing"], "source": "ref.mp4",
                                  "style": {"id": "film-hook", "name": "悬念"}, "writing": {"id": "write-hook", "name": "悬念开场", "group": "宣传"}}})
    assert st["outputs"] == ["visual", "writing"] and st["skill_dir"] == "style/film-hook/" and st["writing_dir"] == "writing/write-hook/"
    only = agent_brief({"request": {"product": "style", "outputs": ["writing"], "source": "ref.mp4", "writing": {"id": "write-hook", "name": "x"}}})
    assert "style" not in only and only["writing"]["id"] == "write-hook"


def test_copy_writing_into_task(monkeypatch):
    from lib import styles
    copies = []

    class S3:
        def get_paginator(self, name):
            return _Pages(["styles/write-hook/v1/skill/SKILL.md", "styles/write-hook/v1/skill/traits.json", "styles/write-hook/v1/review/breakdown.json"])

        def copy_object(self, Bucket, Key, CopySource):
            copies.append(Key)
    monkeypatch.setattr(styles.c, "s3", S3())
    st = _style(sk="write-hook", kind="writing", name="悬念开场", group="宣传")
    refs = styles.copy_into_task("u1", "t9", ["write-hook"], {"write-hook": (st, 1, False)}, "writing")
    assert refs == [{"id": "write-hook", "name": "悬念开场", "v": 1, "beta": False, "group": "宣传"}]
    assert sorted(copies) == ["u/u1/t/t9/input/writing/write-hook/SKILL.md", "u/u1/t/t9/input/writing/write-hook/traits.json"]  # 原片分镜表不进任务


def test_video_model_billing_and_key_check(monkeypatch):
    """看视频按秒数和输出 token 计费；只能看本任务自己的参考视频"""
    from lib import billing
    usd = billing.video_cost(billing.PEGASUS, {"output": 1000, "seconds": 100}, billing.DEFAULTS)
    assert abs(usd - (100 * 0.00049 + 1000 * 7.5 / 1e6)) < 1e-9
    import llm
    monkeypatch.setattr(llm.c, "get_task", lambda tid: {"id": tid, "sub": "s1"})
    monkeypatch.setattr(llm.c, "billed_task", lambda b: {"id": TID, "sub": "s1"})  # 计费令牌另有测试
    monkeypatch.setattr(llm.billing, "check_quota", lambda sub: None)
    bad = llm.handler({"op": "video", "question": "听", "key": f"u/s2/t/{TID}/input/ref/a.mp4", "billing": {"taskId": TID}}, None)
    assert bad["ok"] is False and "只能看" in bad["error"]
    calls = []

    class BR:
        def invoke_model(self, modelId, body):
            import io
            calls.append((modelId, json.loads(body)))
            return {"body": io.BytesIO(json.dumps({"message": "{}", "output_tokens": 50}).encode())}
    monkeypatch.setattr(llm, "BEDROCK", BR())
    monkeypatch.setattr(llm, "account", lambda: "123")
    monkeypatch.setattr(llm.billing, "find_session", lambda sid, at: None)
    ok = llm.handler({"op": "video", "question": "听", "key": f"u/s1/t/{TID}/input/ref/a.mp4", "seconds": 34, "billing": {"taskId": TID}}, None)
    assert ok["ok"] and calls[0][0] == billing.PEGASUS
    assert calls[0][1]["mediaSource"]["s3Location"]["uri"].endswith(f"u/s1/t/{TID}/input/ref/a.mp4")


def test_admin_create_both_kinds(monkeypatch):
    """一段参考视频建两条记录：画风 film-<短名> 和写作方法 write-<短名>，互相指向，共用参考视频"""
    import admin_styles as a
    from lib.common import ApiError
    monkeypatch.setattr(a, "_taken", lambda sid: False)
    monkeypatch.setattr(a.styles, "get", lambda sid: None)
    puts, ups = {}, {}

    class T:
        def put_item(self, Item, **kw):
            puts[Item["sk"]] = Item

    class S3:
        def generate_presigned_url(self, op, Params, ExpiresIn):
            return f"https://s3/{Params['Key']}"
    monkeypatch.setattr(a.c, "table", lambda: T())
    monkeypatch.setattr(a.c, "s3", S3())
    monkeypatch.setattr(a.audit, "write", lambda *x: None)
    monkeypatch.setattr(a.styles, "update", lambda sid, **f: ups.setdefault(sid, {}).update(f))
    me = {"sub": "s", "email": "admin@example.com"}
    ok = {"name": "悬念", "wname": "悬念开场", "slug": "hook", "group": "宣传", "rights": True, "outputs": ["visual", "writing"],
          "file": {"name": "ref.mp4", "size": 3 << 20}}
    r = a.create(ok, me)
    assert r["id"] == "film-hook" and r["ids"] == {"visual": "film-hook", "writing": "write-hook"}
    assert puts["write-hook"]["kind"] == "writing" and puts["write-hook"]["group"] == "宣传" and puts["write-hook"]["pair"] == "film-hook"
    assert puts["write-hook"]["source"]["key"] == "styles/film-hook/source/ref.mp4" and puts["film-hook"]["owner"] == "platform"
    assert ups["film-hook"]["pair"] == "write-hook"
    r = a.create({**ok, "outputs": ["writing"]}, me)
    assert r["id"] == "write-hook" and r["ids"] == {"writing": "write-hook"}
    for bad, code in (({"outputs": []}, "bad_outputs"), ({"group": "其他"}, "bad_group")):
        with pytest.raises(ApiError) as e:
            a.create({**ok, **bad}, me)
        assert e.value.code == code


def test_new_writing_version(monkeypatch):
    """写作方法发出一版：从任务的 writing/v<n>/ 复制，验证材料里的文字文件列出来给管理员看；画风的事件不会写到写作方法的记录上"""
    from lib import styles
    pre = "u/a/t/g1"
    keys = [f"{pre}/writing/v1/skill/SKILL.md", f"{pre}/writing/v1/skill/traits.json", f"{pre}/writing/v1/review/breakdown.json",
            f"{pre}/writing/v1/review/trial-1.json", f"{pre}/writing/v1/review/report.md"]

    class S3:
        def get_paginator(self, name):
            return _Pages(keys)

        def copy_object(self, Bucket, Key, CopySource):
            pass

        def get_object(self, Bucket, Key):
            import io
            return {"Body": io.BytesIO(json.dumps({"line": "先抛悬念再拆解"}).encode())}
    monkeypatch.setattr(styles.c, "s3", S3())
    monkeypatch.setattr(styles, "get", lambda sid: _style(sk=sid, kind="writing", versions=[]) if sid.startswith("write-") else _style(versions=[]))
    monkeypatch.setattr(styles.c, "table", lambda: type("T", (), {"update_item": lambda self, **kw: None})())
    task = {"id": "g1", "request": {"product": "style", "style": {"id": "film-paper"}, "writing": {"id": "write-hook"}}}
    ev = {"n": 1, "trials": [{"label": "第 1 轮", "topic": "面包发霉", "scores": {"structure": 4}}]}
    val = styles.new_version(task, ev, pre, "writing")
    assert val["summary"] == "先抛悬念再拆解" and val["files"] == ["SKILL.md", "traits.json"]
    assert val["reviewFiles"] == ["breakdown.json", "trial-1.json"] and val["trials"][0]["topic"] == "面包发霉"
    assert styles.new_version(task, ev, pre, "visual") is None  # 画风的导出目录里没有 SKILL.md


# ---------- 视频里用的普通图片（docs/image-refs-design.md） ----------

FID = "f-" + "3" * 8 + "-3333-3333-3333-" + "3" * 12


def test_video_images_request_and_brief():
    """每张图都要写描述；按顺序编号 i01、i02，重复的去掉；任务说明里指向目录"""
    from lib.common import ApiError
    from lib.validate import agent_brief, task_request
    body = {"mode": "quick", "description": "做一支保温杯广告",
            "images": [{"kind": "file", "uploadId": UID, "name": "cup.JPG", "desc": " 新款保温杯\n正面图，讲外观时用 "},
                       {"kind": "library", "fileId": FID, "desc": "公司 Logo，片尾用"},
                       {"kind": "library", "fileId": FID, "desc": "重复的"}]}
    r = task_request(body)
    assert [x["id"] for x in r["images"]] == ["i01", "i02"] and r["images"][0]["desc"] == "新款保温杯 正面图，讲外观时用"
    assert agent_brief({"request": r})["images"] == {"count": 2, "index": "input/images/index.json"}
    assert agent_brief({"request": task_request({"mode": "quick", "description": "x"})})["images"] is None
    for bad, code in ((dict(desc=""), "empty_image_desc"), (dict(desc="字" * 201), "image_desc_too_long"),
                      (dict(name="a.gif"), "bad_image_type"), (dict(kind="link"), "bad_image")):
        with pytest.raises(ApiError) as e:
            task_request({**body, "images": [{**body["images"][0], **bad}]})
        assert e.value.code == code
    with pytest.raises(ApiError) as e:
        task_request({**body, "images": [{"kind": "library", "fileId": FID[:-1] + str(i), "desc": "x"} for i in range(9)]})
    assert e.value.code == "too_many_images"


def test_create_task_with_images(monkeypatch):
    """原图复制进 input/images/orig/，写清单；上传的图片带着描述进素材库，素材库的图片选用时改了描述也同步回去"""
    import api
    objs, copies, puts, saved, added, updated = {}, [], {}, {}, [], []

    class S3:
        def list_objects_v2(self, Bucket, Prefix):
            return {"Contents": objs.get(Prefix, [])}

        def copy_object(self, Bucket, Key, CopySource):
            copies.append((CopySource["Key"], Key))

        def put_object(self, Bucket, Key, Body, ContentType=None):
            puts[Key] = Body

    monkeypatch.setattr(api.c, "s3", S3())
    for name, fn in (("check_quota", None),):
        monkeypatch.setattr(api.billing, name, lambda sub: None)
    monkeypatch.setattr(api, "quota", lambda sub: {"running": 0})
    monkeypatch.setattr(api, "take_daily", lambda sub: None)
    monkeypatch.setattr(api.c, "put_task", lambda item: saved.update(task=item))
    monkeypatch.setattr(api.c, "add_message", lambda *a, **k: None)
    monkeypatch.setattr(api, "start_turn", lambda *a, **k: None)
    lib = {"id": FID, "type": "image", "name": "logo.png", "key": "u/s/lib/x/logo.png", "size": 5, "desc": "旧描述"}
    monkeypatch.setattr(api.library, "get_file", lambda sub, fid: lib if fid == FID else None)
    monkeypatch.setattr(api.library, "add_file", lambda *a, **k: added.append((a, k)) or "f-new")
    monkeypatch.setattr(api.library, "update", lambda sub, kind, fid, body: updated.append((kind, fid, body)))
    pre = f"u/s/uploads/{UID}/"
    objs[pre] = [{"Key": pre + "cup.JPG", "Size": 100, "ETag": '"e"'}]
    api.create_task({"sub": "s", "email": "e"}, {"mode": "quick", "description": "保温杯广告", "images": [
        {"kind": "file", "uploadId": UID, "name": "cup.JPG", "desc": "保温杯正面"}, {"kind": "library", "fileId": FID, "desc": "Logo，片尾用"}]})
    t = saved["task"]
    assert [(x["id"], x["orig"], x.get("fileId")) for x in t["request"]["images"]] == [
        ("i01", "input/images/orig/i01.jpg", "f-new"), ("i02", "input/images/orig/i02.png", FID)]
    assert "uploadId" not in t["request"]["images"][0]
    assert {k for _, k in copies} >= {f"u/s/t/{t['id']}/input/images/orig/i01.jpg", f"u/s/t/{t['id']}/input/images/orig/i02.png"}
    man = json.loads(puts[f"u/s/t/{t['id']}/input/images/manifest.json"])
    assert man["items"][1] == {"id": "i02", "name": "logo.png", "desc": "Logo，片尾用", "orig": "input/images/orig/i02.png"}
    assert added[0][1] == {"kind": "image", "desc": "保温杯正面"} and updated == [("image", FID, {"desc": "Logo，片尾用"})]
    lib["type"] = None  # 素材库里的是文件不是图片
    with pytest.raises(api.ApiError) as e:
        api.create_task({"sub": "s", "email": "e"}, {"mode": "quick", "description": "x", "images": [{"kind": "library", "fileId": FID, "desc": "x"}]})
    assert e.value.code == "library_file_missing"


def test_library_images(monkeypatch):
    """素材库的图片和文件存在一起、分开列；同一张图再上传只换描述；描述能改，不能改空"""
    from lib import library
    from lib.common import ApiError
    rows = {"f-1": {"id": "f-1", "name": "a.pdf", "key": "k1", "etag": "e1", "updatedAt": 1},
            "f-2": {"id": "f-2", "name": "cup.jpg", "key": "k2", "etag": "e2", "type": "image", "desc": "杯子", "updatedAt": 2}}
    ups = []

    class T:
        def update_item(self, **kw):
            ups.append(kw)

        def put_item(self, Item, **kw):
            rows[Item["id"]] = Item
    monkeypatch.setattr(library, "_files", lambda sub: list(rows.values()))
    monkeypatch.setattr(library, "get_file", lambda sub, fid: rows.get(fid))
    monkeypatch.setattr(library.c, "table", lambda: T())
    monkeypatch.setattr(library.c, "media_url", lambda k, download_name=None: "https://cdn/" + k)
    assert [x["id"] for x in library.list_items("u", "file")] == ["f-1"]
    imgs = library.list_items("u", "image")
    assert imgs[0]["kind"] == "image" and imgs[0]["desc"] == "杯子" and imgs[0]["url"] == "https://cdn/k2"
    assert library.list_items("u", "image", "杯") and not library.list_items("u", "image", "汽车")
    assert library.add_file("u", "src", "cup.jpg", 3, "e2", kind="image", desc="保温杯正面") == "f-2"
    assert ups[0]["ExpressionAttributeValues"][":d"] == "保温杯正面"
    assert library.update("u", "image", "f-2", {"desc": "  新描述 "})["desc"] == "新描述"
    with pytest.raises(ApiError):
        library.update("u", "image", "f-2", {"desc": " "})
    with pytest.raises(ApiError):
        library.update("u", "image", "f-1", {"name": "x"})  # 文件不能当图片改


def test_scene_sig_with_images_and_view(monkeypatch):
    """每镜指纹带上用到的图片；没有图片的镜头指纹和以前一样（老版本记的指纹照样对得上）"""
    import hashlib
    from lib import flows, views
    from lib.validate import schema_check
    s1 = {"id": "01", "narration": "a", "visual": "b", "skill": "c"}
    old = hashlib.sha1("a\nb\nc".encode()).hexdigest()[:10]
    assert flows.scene_sig({"scenes": [s1]})["01"] == old
    assert flows.scene_sig({"scenes": [{**s1, "images": ["i01"]}]})["01"] != old
    sb = {"title": "t", "ratio": "16:9", "resolution": "1080p", "fps": 30, "unused_images": [{"id": "i02", "reason": "太糊"}],
          "scenes": [{"id": "01", "title": "t", "narration": "n", "visual": "v", "duration": 5, "images": ["i01"]}]}
    assert schema_check("storyboard", sb) is None
    assert schema_check("storyboard", {**sb, "scenes": [{**sb["scenes"][0], "images": ["cup"]}]})
    monkeypatch.setattr(views.c, "media_url", lambda k, download_name=None: "https://cdn/" + k)
    t = {"id": "t1", "sub": "s", "request": {"images": [{"id": "i01", "name": "a.jpg", "desc": "d", "orig": "input/images/orig/i01.jpg"},
                                                        {"id": "i02", "name": "b.png", "desc": "e", "orig": "input/images/orig/i02.png", "thumb": "input/images/thumbs/i02.jpg"}]}}
    v = views._images_view(t)
    assert v[0]["url"].endswith("orig/i01.jpg") and v[1]["url"].endswith("thumbs/i02.jpg")


# ---------------------------------------------------------------- v1.0.0 安全扫描发现的问题的修复

def test_safe_names_and_library_rename(monkeypatch):
    """文件名只留最后一段；素材库改名不能带路径分隔符（文件名会拼进任务里的文件路径）"""
    from lib import common as c, library
    from lib.common import ApiError
    assert c.safe_name("../../../../opt/slate/slate/refs.py") == "refs.py"
    assert c.safe_name("a\\..\\b.txt") == "b.txt" and c.safe_name("..") == "" and c.safe_name(".bashrc") == "bashrc"
    assert c.safe_name("x\x00y.md") == "xy.md" and c.safe_name("正常 文件.md") == "正常 文件.md"
    rows = {"f-1": {"id": "f-1", "name": "a.pdf", "key": "k1", "etag": "e1", "updatedAt": 1}}

    class T:
        def update_item(self, **kw): pass
        def put_item(self, Item, **kw): rows[Item["id"]] = Item
    monkeypatch.setattr(library, "get_file", lambda sub, fid: rows.get(fid))
    monkeypatch.setattr(library.c, "table", lambda: T())
    monkeypatch.setattr(library.c, "media_url", lambda k, download_name=None: "https://cdn/" + k)
    for bad in ("/../../../../opt/slate/slate/refs.py", "a/b.pdf", "a\\b.pdf", "..", "..."):
        with pytest.raises(ApiError):
            library.update("u", "file", "f-1", {"name": bad})
    assert library.update("u", "file", "f-1", {"name": "新名字.pdf"})["name"] == "新名字.pdf"


def test_sync_pull_stays_inside_input(tmp_path, monkeypatch):
    """S3 键里带 ../ 的文件不能落到 input/ 外面"""
    import importlib
    monkeypatch.setenv("SLATE_TASK_DIR", str(tmp_path / "task"))
    monkeypatch.setenv("SLATE_STATE_DIR", str(tmp_path / "state"))
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "task.json").write_text(json.dumps({"bucket": "b", "prefix": "u/s/t/1"}))
    sys.path.insert(0, os.path.join(ROOT, "agent", "image"))
    try:
        import slate.common, slate.sync
        importlib.reload(slate.common); sync = importlib.reload(slate.sync)
    finally:
        sys.path.remove(os.path.join(ROOT, "agent", "image"))

    class NoSuchKey(Exception):
        pass

    class Cli:
        exceptions = type("E", (), {"NoSuchKey": NoSuchKey})
        def get_paginator(self, name): return self
        def paginate(self, Bucket, Prefix):
            return [{"Contents": [{"Key": Prefix + "refs/files/a.md", "Size": 1}, {"Key": Prefix + "../../evil.py", "Size": 1},
                                  {"Key": Prefix + "refs/../../../evil2.py", "Size": 1}]}]
        def download_file(self, b, k, dst): open(dst, "w").write("x")
        def get_object(self, **kw): raise NoSuchKey()
    monkeypatch.setattr(sync, "s3", lambda: Cli())
    sync.pull()
    assert (tmp_path / "task" / "input" / "refs" / "files" / "a.md").exists()
    assert not (tmp_path / "evil.py").exists() and not (tmp_path / "evil2.py").exists() and not (tmp_path / "task" / "evil2.py").exists()


def test_finish_hook_needs_turn_nonce(monkeypatch):
    """hook 只认带着这一轮口令的：会话伪造的"被误拦"不会触发免费重做"""
    import finish
    tid = "00000000-0000-4000-8000-000000000001"
    turn = {"id": "t1", "kind": "start", "nonce": "abc123"}
    hook = lambda bag, stop="content_filtered": {"sessionId": f"slate-task-{tid}", "context": {"stopReason": stop}, "headers": {"baggage": bag}}
    assert finish._verified(hook("harness.id=x,slate.nonce=abc123"), turn)
    assert not finish._verified(hook("harness.id=x,slate.nonce=zzz"), turn)
    assert not finish._verified({"context": {"stopReason": "content_filtered"}}, turn)
    assert not finish._verified({}, {"id": "old"})  # 没有口令的一律不认（第二次扫描 #2）
    from lib import chapters as chs
    assert len(chs.new_turn("start")["nonce"]) == 32 and chs.new_turn("start")["nonce"] != chs.new_turn("start")["nonce"]
    calls = []
    monkeypatch.setattr(finish.c, "get_task", lambda t: {"id": t, "status": "running", "turn": turn, "request": {}})
    monkeypatch.setattr(finish, "restart", lambda *a, **k: calls.append("restart"))
    monkeypatch.setattr(finish, "push", lambda *a, **k: calls.append("push"))
    monkeypatch.setattr(finish, "fail", lambda *a, **k: calls.append("fail"))
    monkeypatch.setattr(finish.c, "add_message", lambda *a, **k: None)
    monkeypatch.setattr(finish.models, "agent_chain", lambda: [{"model": "m1"}, {"model": "m2"}])  # 有备用模型可换
    finish.process_turn(hook("slate.nonce=forged"))
    assert calls == []
    finish.process_turn(hook("slate.nonce=abc123"))
    assert calls == ["restart"]


def test_turn_sets_nonce_only_on_same_turn(monkeypatch):
    """口令只写进这一轮（条件写）；期间轮次换了就不开工"""
    import turn as turn_mod
    from botocore.exceptions import ClientError
    got = []
    monkeypatch.setattr(turn_mod.c, "update_task", lambda tid, expr, names, values, cond: got.append((expr, values, cond)))
    assert turn_mod.set_nonce("t", None, "turn-1", "n1")
    assert got[0][0] == "SET #t.nonce = :n" and got[0][1] == {":n": "n1", ":id": "turn-1"} and got[0][2] == "#t.id = :id"

    def stale(*a, **k):
        raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
    monkeypatch.setattr(turn_mod.c, "update_task", stale)
    assert not turn_mod.set_nonce("t", None, "turn-1", "n1")


def test_admin_rechecks_live_group(monkeypatch):
    """取消管理员、停用以后，旧 token 也用不了：每个请求都向用户池确认"""
    monkeypatch.setenv("ADMIN_CLIENT_ID", "admin-client")
    import importlib, admin
    importlib.reload(admin)
    state = {"enabled": True, "groups": ["admin"], "sub": "s1"}

    class Cog:
        class exceptions:
            UserNotFoundException = type("UserNotFound", (Exception,), {})
        def admin_get_user(self, **kw): return {"Enabled": state["enabled"], "UserAttributes": [{"Name": "sub", "Value": state["sub"]}]}
        def admin_list_groups_for_user(self, **kw): return {"Groups": [{"GroupName": g} for g in state["groups"]]}
    monkeypatch.setattr(admin, "cog", Cog())
    ev = {"requestContext": {"authorizer": {"claims": {"sub": "s1", "cognito:username": "s1", "email": "a@b.c", "aud": "admin-client",
                                                       "cognito:groups": "[admin]"}}}, "httpMethod": "GET", "path": "/api/me"}
    assert admin.handler(ev, None)["statusCode"] == 200
    for change in ({"groups": []}, {"enabled": False}, {"sub": "other"}):
        state.update({"enabled": True, "groups": ["admin"], "sub": "s1"}, **change)
        admin._live.clear()
        assert admin.handler(ev, None)["statusCode"] == 403, change


def test_chapter_scope_must_exist():
    """修改范围里的章号必须在总纲里"""
    from lib import chapters as chs
    from lib.common import ApiError
    with pytest.raises(ApiError):
        chs.start({"id": "t", "docs": {"outline": {"chapters": [{"id": "01"}, {"id": "02"}]}}}, ["99"], "revise")


def test_render_usage_bounds(monkeypatch):
    """渲染用量是会话写的：秒数超出范围不记，时间太离谱按现在算"""
    import events
    got = []
    monkeypatch.setattr(events.c, "get_task", lambda tid: {"id": tid, "sub": "u", "email": "a@b.c", "turn": {"id": "turn-1"}})
    monkeypatch.setattr(events.billing, "find_session", lambda sid, at: None)
    monkeypatch.setattr(events.billing, "record", lambda task, at, idem, kind, turn, usage, **k: got.append((at, usage)))
    for secs in (1e9, -5, 0, 901):
        events.process("u", "t1", {"type": "render_usage", "op": "render", "seconds": secs, "instance": "g5.xlarge"})
    assert got == []
    events.process("u", "t1", {"type": "render_usage", "at": 1, "op": "render", "seconds": 30, "instance": "g5.xlarge"})
    assert got[0][1] == {"seconds": 30.0} and got[0][0] > 1_700_000_000_000


def test_upload_content_type_by_extension(monkeypatch):
    """上传的 Content-Type 按扩展名定，不用浏览器报的"""
    import api
    seen = {}

    class S3:
        def generate_presigned_url(self, op, Params, ExpiresIn):
            seen.update(Params); return "https://upload"
    monkeypatch.setattr(api.c, "s3", S3())
    r = api.create_upload({"sub": "u"}, {"filename": "x.md", "size": 10, "contentType": "text/html"})
    assert r["headers"]["Content-Type"] == seen["ContentType"] == "text/markdown; charset=utf-8"
    r = api.create_upload({"sub": "u"}, {"filename": "../../a.png", "size": 10, "contentType": "text/html", "purpose": "image"})
    assert seen["ContentType"] == "image/png" and seen["Key"].endswith("/a.png")


def test_billed_task_needs_turn_token(monkeypatch):
    """看图、配音的 Lambda 只认带着本轮计费令牌的调用：不带、带错、带别人的都不认，也不去调模型"""
    from lib import common as c
    tid = "00000000-0000-4000-8000-000000000002"
    task = {"id": tid, "sub": "s1", "turn": {"id": "t1", "billToken": "tok1"}}
    monkeypatch.setattr(c, "get_task", lambda t: task if t == tid else None)
    assert c.billed_task({"taskId": tid, "token": "tok1"}) is task
    assert c.billed_task({"taskId": tid, "token": "tok2"}) is None
    assert c.billed_task({"taskId": tid}) is None and c.billed_task({}) is None and c.billed_task(None) is None
    assert set(c.turn_secrets()) == {"nonce", "billToken"}
    import llm
    called = []
    monkeypatch.setattr(llm.models, "chain", lambda purpose, cfg=None: called.append(purpose) or [])
    r = llm.handler({"question": "看", "images": ["x"], "billing": {"taskId": tid, "token": "bad"}}, None)
    assert not r["ok"] and not called


def test_instance_mapping_is_not_overwritten(monkeypatch):
    """计量的实例归属：8 小时内不许改记到别的会话（会话能往运行日志里写，见 billing.map_instance）"""
    from botocore.exceptions import ClientError
    from lib import billing
    store = {}

    class T:
        def put_item(self, Item, ConditionExpression=None, ExpressionAttributeValues=None):
            old = store.get(Item["pk"])
            v = ExpressionAttributeValues or {}
            if old and old["sessionId"] != v.get(":s") and old.get("mappedAt", 0) >= v.get(":old", 0):
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
            store[Item["pk"]] = Item
    monkeypatch.setattr(billing.c, "table", lambda: T())
    billing.map_instance("i-1", "slate-task-a")
    billing.map_instance("i-1", "slate-task-a")
    billing.map_instance("i-1", "slate-task-victim")
    assert store["BILLINST#i-1"]["sessionId"] == "slate-task-a"
