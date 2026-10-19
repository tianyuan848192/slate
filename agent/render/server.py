"""渲染机：AgentCore Runtime（Instance 模式，GPU 实例）上的渲染服务。设计见 docs/gpu-render-design.md。

实现 AgentCore Runtime 的 HTTP 约定：8080 端口 GET /ping、POST /invocations（请求可能是分块传输）。
会话里的 slate-render、slate-qa 把要渲染的镜头打包放进本任务的 S3 目录，再带着本任务范围的临时凭证调用这里：
- 先用这份凭证问 STS"我是谁"：必须是平台的任务数据角色，会话名是 t-<任务号>，场景包也必须在这个任务的目录下，
  否则拒绝。之后所有 S3 读写都用这份凭证，渲染机自己的角色没有数据桶权限，碰不到别的任务；
- 每个请求单独起一个工作进程（worker.py），在自己的目录里渲染；
- 做完往这个任务的 events/ 写一条渲染用量（忙碌秒数和机型），由 events Lambda 计费。

操作：warm（预热，确认显卡可用）、render、qa。
"""
import json, os, re, secrets, subprocess, sys, threading, time, traceback, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
TASK_ROLE = os.environ.get("TASK_DATA_ROLE_NAME", "")
ACCOUNT = os.environ.get("ACCOUNT_ID", "")       # 只认本账号的任务凭证：别的账号可以建同名的角色
DATA_BUCKET = os.environ.get("DATA_BUCKET", "")  # 场景包和回执只在平台的数据桶里，不用请求里给的桶名
WORK = os.environ.get("RENDER_WORK_DIR", "/tmp/work")
HERE = os.path.dirname(os.path.abspath(__file__))
SLOTS = threading.BoundedSemaphore(int(os.environ.get("RENDER_SLOTS", "2")))  # 同时跑几个请求（4 核的机器 2 个）
BUSY = [0]
_info = {}


def _imds():
    """这台机器的机型和实例编号（实例编号记进渲染用量的日志，用来确认每个任务各占一台机器）"""
    if "type" not in _info:
        try:
            tok = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT",
                                         headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}), timeout=2).read().decode()
            get = lambda k: urllib.request.urlopen(urllib.request.Request(f"http://169.254.169.254/latest/meta-data/{k}",  # noqa: E731
                                                   headers={"X-aws-ec2-metadata-token": tok}), timeout=2).read().decode()
            _info["type"], _info["host"] = get("instance-type"), get("instance-id")
        except Exception:
            _info.setdefault("type", "unknown")
            _info.setdefault("host", "unknown")
    return _info


def instance_type():
    return _imds()["type"]


def instance_id():
    return _imds()["host"]


def op_warm(req):
    """预热：开一次 Chrome，确认 WebGL 用的是显卡（顺带把字体、库读进系统缓存）"""
    if "gpu" not in _info:
        code = ("import asyncio,sys; sys.path.insert(0,'%s'); import localbrowser as lb\n"
                "from playwright.async_api import async_playwright\n"
                "async def m():\n b=lb.LocalBrowser(); b.start()\n try:\n  async with async_playwright() as p:\n"
                "   br=await p.chromium.connect_over_cdp(b.ws); pg=await br.contexts[0].new_page()\n"
                "   print(await pg.evaluate(\"()=>{const g=document.createElement('canvas').getContext('webgl2');"
                "if(!g)return 'none';const e=g.getExtension('WEBGL_debug_renderer_info');return g.getParameter(e.UNMASKED_RENDERER_WEBGL)}\"))\n"
                " finally:\n  b.stop()\nasyncio.run(m())\n") % HERE
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
        _info["gpu"] = (r.stdout.strip().splitlines() or [r.stderr[-300:]])[-1]
    return {"ready": True, "instance": instance_type(), "host": instance_id(), "gpu": _info["gpu"], "uptime_s": round(time.time() - STARTED, 1)}


def task_of(creds):
    """用会话交来的临时凭证问 STS：必须是任务数据角色，会话名 t-<任务号>"""
    sts = boto3.client("sts", region_name=REGION, aws_access_key_id=creds["key"], aws_secret_access_key=creds["secret"],
                       aws_session_token=creds["token"])
    arn = sts.get_caller_identity()["Arn"]
    m = re.fullmatch(r"arn:aws:sts::(\d+):assumed-role/([^/]+)/t-([0-9a-f-]{36})", arn)
    if not m or not ACCOUNT or m.group(1) != ACCOUNT or (TASK_ROLE and m.group(2) != TASK_ROLE):
        raise PermissionError("凭证不是本平台的任务数据角色")
    return m.group(3)


def op_job(req):
    creds = req["creds"]
    task_id = task_of(creds)
    m = re.fullmatch(r"(u/[^/]+/t/([0-9a-f-]{36}))/render/[0-9a-f]{16,64}\.tgz", req.get("bundle") or "")
    if not m or m.group(2) != task_id:
        raise PermissionError("场景包不在这个任务的目录下")
    prefix = m.group(1)
    run = f"{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    if not DATA_BUCKET:
        raise PermissionError("渲染机没有配置数据桶")
    job = {"op": req["op"], "bucket": DATA_BUCKET, "bundle": req["bundle"], "prefix": prefix, "run": run,
           "scenes": [s for s in req.get("scenes") or [] if re.fullmatch(r"[0-9]{2}", s)][:60],
           # 3D 图片（slate-model）：渲染 scenes/M3D/ 的多角度图、转台视频或 GLB
           **({"model": {k: req["model"].get(k) for k in ("job", "size", "glb", "extract")}} if req.get("op") == "model" and isinstance(req.get("model"), dict) else {}),
           "concurrency": max(1, min(4, int(req.get("concurrency", 2)))), "max_shards": max(1, min(8, int(req.get("max_shards", 4))))}
    env = {**os.environ, "SLATE_TASK_DIR": os.path.join(WORK, run), "SLATE_STATE_DIR": os.path.join(WORK, run, ".state"),
           "AWS_ACCESS_KEY_ID": creds["key"], "AWS_SECRET_ACCESS_KEY": creds["secret"], "AWS_SESSION_TOKEN": creds["token"]}
    wait0 = time.time()
    with SLOTS:
        queued = time.time() - wait0
        t0 = time.time()
        try:
            r = subprocess.run([sys.executable, os.path.join(HERE, "worker.py")], input=json.dumps(job), capture_output=True, text=True,
                               env=env, timeout=840)
        finally:
            subprocess.run(["rm", "-rf", env["SLATE_TASK_DIR"]])
            busy = time.time() - t0
            _receipt(creds, job, req, run, busy)  # 超时也记账：机器确实忙了这么久
    lines = [x for x in r.stdout.strip().splitlines() if x.startswith("{")]
    out = json.loads(lines[-1]) if lines else {"error": (r.stderr or "工作进程没有输出")[-1500:]}
    out.update(busy_s=round(busy, 2), queued_s=round(queued, 2), instance=instance_type(), host=instance_id(), run=run)
    return out


def _receipt(creds, job, req, run, busy):
    """渲染用量：写进这个任务的事件目录，由 events Lambda 计费"""
    prefix = job["prefix"]
    try:
        s3 = boto3.client("s3", region_name=REGION, aws_access_key_id=creds["key"], aws_secret_access_key=creds["secret"],
                          aws_session_token=creds["token"])
        ev = {"type": "render_usage", "at": int(time.time() * 1000), "run": run, "op": req["op"], "seconds": round(busy, 2),
              "instance": instance_type(), "host": instance_id(), "scenes": len(job["scenes"]), **({"chapter": req["chapter"]} if req.get("chapter") else {})}
        s3.put_object(Bucket=job["bucket"], Key=f"{prefix}/events/{ev['at']}-{secrets.token_hex(3)}.json", Body=json.dumps(ev).encode())
    except Exception:
        traceback.print_exc()


OPS = {"warm": op_warm, "render": op_job, "qa": op_job, "model": op_job}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            data = b""
            while True:
                size = int(self.rfile.readline().strip().split(b";")[0] or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return data
                data += self.rfile.read(size)
                self.rfile.readline()
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        if self.path.startswith("/ping"):
            self._json(200, {"status": "HealthyBusy" if BUSY[0] else "Healthy", "time_of_last_update": int(time.time())})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/invocations"):
            return self._json(404, {"error": "not found"})
        try:
            req = json.loads(self._body() or b"{}")
            fn = OPS.get(req.get("op"))
            if not fn:
                return self._json(200, {"error": f"不认识的操作：{req.get('op')}"})
            BUSY[0] += 1
            try:
                res = fn(req)
            finally:
                BUSY[0] -= 1
            self._json(200, res)
        except PermissionError as e:
            self._json(200, {"error": f"拒绝：{e}"})
        except Exception:
            self._json(200, {"error": traceback.format_exc()[-1500:]})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


STARTED = time.time()
if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True)
    print(json.dumps({"ready": True, "started": STARTED, "host": instance_id(), "instance": instance_type()}), flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
