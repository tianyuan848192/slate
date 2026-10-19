"""模型代码的安全检查（lib/library.py 的 unsafe）：直接查原始代码，注释和字符串里出现也算（增量安全扫描 #1、#2）。
运行：cd backend && python -m pytest tests -q"""
import os, sys, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from lib import library as L  # noqa: E402


def test_nothing_can_hide_banned_words():
    """用注释、字符串、模板、正则和除号的歧义都藏不住"""
    for code in ("const s = `/*`; fetch('https://x');", "const a = `/*`; fetch(1); const b = `*/`;", "const r = /\\/*/; fetch(1);",
                 "const s = `${fetch('x')}`;", "const s = `a${ {k: `x${window}`}.k }`;", "let i = 0; i++ /fetch(1)/ 2;",
                 "const o = {} / fetch(1) / 1;", "x = 'a'+window.y", "const s = \"*/\"; /* ok */ localStorage.x = 1",
                 "const a = 1; /* fetch(1)", "// window is not used here"):
        assert L.unsafe(code), code


def test_normal_model_code_passes():
    ok = ("import * as THREE from 'three';\nexport function createLampModel() { const g = new THREE.Group(); return g; }",
          "const c = document.createElement('canvas'); const ctx = c.getContext('2d'); const t = new THREE.CanvasTexture(c);",
          "const r = /ab+c/gi; const q = x / 2 / y; const o = {'label': `第${i + 1}步`};", "if (typeof document !== 'undefined') {}")
    for code in ok:
        assert L.unsafe(code) is None, code


def test_linear_time():
    for s in ("/* " * 350000, "`" + "a" * 1_000_000, "a/" * 500_000, "'" + "x" * 1_000_000):
        t = time.time()
        L.unsafe(s)
        assert time.time() - t < 3, len(s)
