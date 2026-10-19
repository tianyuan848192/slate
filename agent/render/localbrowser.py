"""渲染机上的本机浏览器：顶替 AgentCore Browser 的客户端，渲染代码（slate.page）照旧通过 CDP 连上来。

显卡通道固定用 EGL（ANGLE 走 OpenGL ES）。实测 Vulkan 通道在多个 Chrome 同时用一块显卡时会画出空白帧，
EGL 画面和 CPU 软件绘制逐帧一致（docs/gpu-render-spike-results.md）。
每镜可以单独切到 CPU 软件绘制（显卡出错时的兜底）：用 MODE 这个 ContextVar，同时渲染的几镜互不影响。
"""
import contextvars, glob, os, shutil, subprocess, sys, tempfile, threading, types

CHROME = (glob.glob("/ms-playwright/chromium-*/chrome-linux*/chrome") or ["chromium"])[0]
ARGS = {
    "egl": ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
    "cpu": ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
}
MODE = contextvars.ContextVar("slate_gpu_mode", default=os.environ.get("SLATE_GPU_MODE", "egl"))
# 实例上的 NVIDIA 驱动库挂在 /usr/lib64（Amazon Linux 的路径），Ubuntu 默认不搜这里；不加的话 Chrome 会悄悄退回 CPU 软件绘制
ENV = {**os.environ, "LD_LIBRARY_PATH": "/usr/lib64:" + os.environ.get("LD_LIBRARY_PATH", "")}


class LocalBrowser:
    def __init__(self, *a, **k):
        self.proc, self.dir, self.ws = None, None, None

    def start(self, name=None, session_timeout_seconds=None, viewport=None, identifier=None):
        vp = viewport or {"width": 1920, "height": 1080}
        self.dir = tempfile.mkdtemp(prefix="chrome-")
        # 以普通用户运行；容器里没有用户命名空间，Chrome 的沙箱起不来，靠"一个任务一台实例"和页面请求拦截来隔离
        args = [CHROME, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={self.dir}",
                f"--window-size={vp['width']},{vp['height']}", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
                "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio", *ARGS[MODE.get()], "about:blank"]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=ENV)
        for line in self.proc.stderr:
            if "DevTools listening on" in line:
                self.ws = line.split("on ", 1)[1].strip()
                break
        if not self.ws:
            raise RuntimeError("本机 Chrome 没有启动起来")
        threading.Thread(target=lambda: [None for _ in self.proc.stderr], daemon=True).start()

    def generate_ws_headers(self):
        return self.ws, None

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except Exception:
                self.proc.kill()
        shutil.rmtree(self.dir or "", ignore_errors=True)


def install():
    """渲染镜像里不装 AgentCore 的 SDK：slate.page 导入浏览器客户端时给它本机版本"""
    for name in ("bedrock_agentcore", "bedrock_agentcore.tools"):
        sys.modules.setdefault(name, types.ModuleType(name))
    mod = types.ModuleType("bedrock_agentcore.tools.browser_client")
    mod.BrowserClient = LocalBrowser
    sys.modules["bedrock_agentcore.tools.browser_client"] = mod
