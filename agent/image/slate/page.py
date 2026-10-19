"""打开 AgentCore Browser 会话并加载场景页（slate-render 和 slate-qa 共用）。

场景页以虚构地址 https://slate.render/ 供给浏览器，所有请求都由本进程拦截并从本地文件返回：
  /scene/NN/...   → /root/task/scenes/NN/...
  /skills/<id>/.. → /.agents/skills/<id>/...（已下架的旧风格在 /opt/slate/legacy-skills/<id>/；
                    管理员生成的风格在 /root/task/input/styles/<id>/，风格创建任务里正在写的在 /root/task/style/<id>/）
  /input/...      → /root/task/input/...（用户上传的素材）
  /assets/...     → /opt/slate/assets/...
  /core/...       → /opt/slate/film-core/...（影片风格的公共库、字体和贴图）
  /node_modules/three/... → /opt/slate/node_modules/three/...（three.js 0.170，影片风格的 3D 场景用）
其他任何地址一律中止，渲染过程不访问外网。
"""
import asyncio, json, mimetypes, os

from bedrock_agentcore.tools.browser_client import BrowserClient

from .common import OPT, REGION, TASK, load_json, path

ORIGIN = "https://slate.render"
SKILLS = os.environ.get("SLATE_SKILLS_DIR", "/.agents/skills")
# 已下架的旧风格：不再登记为 Skill，但老任务的场景还引用 /skills/<id>/，修改和重渲染时从这里取
LEGACY_SKILLS = os.path.join(OPT, "legacy-skills")
RUNTIME = os.path.join(OPT, "runtime", "slate-runtime.js")
ROOTS = {"scene": os.path.join(TASK, "scenes"), "skills": SKILLS, "input": os.path.join(TASK, "input"),
         "assets": os.path.join(OPT, "assets"), "core": os.path.join(OPT, "film-core"),
         "node_modules": os.path.join(OPT, "node_modules")}
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("font/woff2", ".woff2")


def skill_dir(skill_id):
    """风格目录：先找在架的，再找已下架的，再找任务里的生成风格（docs/style-creator-design.md）"""
    for root in (SKILLS, LEGACY_SKILLS, os.path.join(TASK, "input", "styles"), os.path.join(TASK, "style")):
        if os.path.isdir(os.path.join(root, skill_id)):
            return os.path.join(root, skill_id)
    return os.path.join(SKILLS, skill_id)


def local_file(url):
    if not url.startswith(ORIGIN + "/"):
        return None
    rel = url[len(ORIGIN) + 1:].split("?", 1)[0].split("#", 1)[0]
    head, _, rest = rel.partition("/")
    root = ROOTS.get(head)
    if not root:
        return None
    from urllib.parse import unquote
    rest = unquote(rest)
    if head == "skills":
        sid, _, sub = rest.partition("/")
        if sid and sid not in (".", ".."):
            root, rest = skill_dir(sid), sub
    p = os.path.realpath(os.path.join(root, rest))
    if not p.startswith(os.path.realpath(root) + os.sep) or not os.path.isfile(p):
        return None
    return p


def captions_for(scene_id, duration, narration=""):
    """优先用配音的逐字时间轴；没有配音时按字数把旁白平均铺满整镜。"""
    v = load_json(path("voice", f"{scene_id}.json"))
    if v and v.get("captions"):
        return v["captions"]
    from .voice import split_captions
    return split_captions(narration, duration) if narration else []


def scene_config(scene, spec, subtitles=True):
    dur = float(scene["duration"])
    cfg = {"width": spec["w"], "height": spec["h"], "fps": spec["fps"], "duration": dur, "scene": scene["id"],
           "ratio": spec["ratio"], "subtitles": subtitles,
           "captions": captions_for(scene["id"], dur, scene.get("narration", "")) if subtitles else []}
    # 全片统一的字幕样式（分镜里的 caption_style）：所有镜头都按它显示，盖过场景自己设置的
    cs = (load_json(path("storyboard.json"), {}) or {}).get("caption_style")
    if cs:
        cfg["captionStyle"] = cs
    return cfg


class ScenePage:
    """一个浏览器会话里打开一镜。用法：async with ScenePage(pw, scene_id, cfg) as sp: await sp.frame(t)"""

    def __init__(self, pw, scene_id, cfg, name="slate", browser_id=None):
        self.pw, self.scene_id, self.cfg, self.name = pw, scene_id, cfg, name
        self.browser_id = browser_id or os.environ.get("SLATE_BROWSER_ID")
        self.blocked, self.errors = [], []
        self._fulfill_lock = asyncio.Lock()

    async def __aenter__(self):
        self.bc = BrowserClient(REGION)
        kw = {"name": self.name, "session_timeout_seconds": 900, "viewport": {"width": self.cfg["width"], "height": self.cfg["height"]}}
        if self.browser_id:
            kw["identifier"] = self.browser_id
        await asyncio.to_thread(self.bc.start, **kw)
        try:
            ws, headers = self.bc.generate_ws_headers()
            self.browser = await self.pw.chromium.connect_over_cdp(ws, headers=headers)
            ctx = self.browser.contexts[0] if self.browser.contexts else await self.browser.new_context()
            self.page = await ctx.new_page()
            await self.page.set_viewport_size({"width": self.cfg["width"], "height": self.cfg["height"]})
            # 忽略 AgentCore Browser 自带录屏扩展的提示，只记录场景本身的错误
            self.page.on("pageerror", lambda e: self.errors.append(str(e)) if "Extension context" not in str(e) else None)
            self.page.on("console", lambda m: self.errors.append(m.text) if m.type == "error" and "Extension context" not in m.text else None)
            await self.page.route("**/*", self._route)
            # 只等场景自己的资源。AgentCore Browser 录屏扩展的请求偶尔一直挂着，load 事件就迟迟不来，所以不等 load
            pending = set()
            self.page.on("request", lambda r: pending.add(r) if r.url.startswith(ORIGIN + "/") else None)
            self.page.on("requestfinished", lambda r: pending.discard(r))
            self.page.on("requestfailed", lambda r: pending.discard(r))
            runtime = open(RUNTIME, encoding="utf-8").read()
            await self.page.add_init_script(f"window.__SLATE_CONFIG = {json.dumps(self.cfg, ensure_ascii=False)};\n{runtime}")
            await self.page.goto(f"{ORIGIN}/scene/{self.scene_id}/index.html", wait_until="domcontentloaded", timeout=60000)
            for _ in range(600):
                if not pending:
                    break
                await asyncio.sleep(0.05)
            info = await self.page.evaluate("window.__slateReady()")
            if not info.get("hasRender"):
                raise RuntimeError("场景没有定义全局函数 render(t)")
            self.cdp = await ctx.new_cdp_session(self.page)
        except BaseException:
            await self.close()
            raise
        return self

    async def _route(self, route):
        url = route.request.url
        p = local_file(url)
        if p:
            ctype = mimetypes.guess_type(p)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype == "application/javascript":
                ctype += "; charset=utf-8"
            # 同一页面一次只回一个文件：几 MB 的字体同时回给 AgentCore Browser 时，偶尔会一起卡住
            async with self._fulfill_lock:
                await route.fulfill(status=200, content_type=ctype, body=open(p, "rb").read())
        elif url.startswith(("data:", "blob:", "chrome-extension:")):  # 扩展是 AgentCore Browser 自带的录屏组件
            await route.continue_()
        else:
            self.blocked.append(url)
            await route.abort()

    async def frame(self, t):
        await self.page.evaluate(f"window.__slateFrame({t})")

    async def jpeg(self, quality=90):
        import base64
        shot = await self.cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": quality, "optimizeForSpeed": True})
        return base64.b64decode(shot["data"])

    async def png(self):
        import base64
        shot = await self.cdp.send("Page.captureScreenshot", {"format": "png"})
        return base64.b64decode(shot["data"])

    async def close(self):
        try:
            if getattr(self, "browser", None):
                await self.browser.close()
        except Exception:
            pass
        try:
            await asyncio.to_thread(self.bc.stop)
        except Exception:
            pass

    async def __aexit__(self, *exc):
        await self.close()
