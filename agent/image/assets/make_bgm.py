"""构建镜像时现场合成几段可循环的背景音乐（纯程序生成，没有版权问题）。

用法：python make_bgm.py <输出目录>
生成 calm.mp3（舒缓铺底）、bright.mp3（轻快拨弦）、tech.mp3（科技脉冲），每段 32 秒，首尾可无缝循环。
"""
import json, os, subprocess, sys, wave

import numpy as np

SR = 44100
OUT = sys.argv[1]


def note(n):  # MIDI 音高 → 频率
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n, a, r):
    e = np.ones(n)
    ai, ri = int(a * SR), int(r * SR)
    e[:ai] = np.linspace(0, 1, ai) if ai else 1
    if ri:
        e[-ri:] *= np.linspace(1, 0, ri)
    return e


def tone(freq, dur, shape="sine", a=0.01, r=0.3, detune=0.0):
    t = np.arange(int(dur * SR)) / SR
    ph = 2 * np.pi * freq * t
    if shape == "sine":
        w = np.sin(ph)
    elif shape == "tri":
        w = 2 / np.pi * np.arcsin(np.sin(ph))
    elif shape == "saw":
        w = sum(np.sin(k * ph) / k for k in range(1, 8)) * 0.6
    if detune:
        w = 0.5 * w + 0.5 * np.sin(2 * np.pi * freq * (1 + detune) * t)
    return w * env(len(t), a, r)


def place(buf, sig, at):
    i = int(at * SR) % len(buf)
    end = min(len(buf), i + len(sig))
    buf[i:end] += sig[:end - i]
    if i + len(sig) > len(buf):  # 循环回绕，保证首尾无缝
        buf[:i + len(sig) - len(buf)] += sig[end - i:]


def lowpass(x, k=8):
    return np.convolve(x, np.ones(k) / k, mode="same")


def calm():
    bpm, bars = 64, 8
    beat = 60 / bpm; total = bars * 4 * beat
    buf = np.zeros(int(total * SR))
    chords = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]]
    for b in range(bars):
        for n in chords[b % 4]:
            place(buf, 0.10 * tone(note(n), 4 * beat + 1.2, "tri", a=1.2, r=1.4, detune=0.003), b * 4 * beat)
        place(buf, 0.12 * tone(note(chords[b % 4][0] - 24), 4 * beat, "sine", a=0.4, r=1.0), b * 4 * beat)
    return lowpass(buf, 12), total


def bright():
    bpm, bars = 108, 16
    beat = 60 / bpm; total = bars * 4 * beat
    buf = np.zeros(int(total * SR))
    scale = [72, 74, 76, 79, 81]
    prog = [60, 57, 65, 67]
    for b in range(bars):
        root = prog[(b // 2) % 4]
        for i in range(8):
            n = scale[(i * 2 + b) % 5] if i % 2 else root + 12
            place(buf, 0.09 * tone(note(n), 0.5, "tri", a=0.005, r=0.4), b * 4 * beat + i * beat / 2)
        place(buf, 0.10 * tone(note(root - 12), 4 * beat, "sine", a=0.05, r=0.6), b * 4 * beat)
        for i in range(4):  # 轻柔的底鼓
            t = np.arange(int(0.18 * SR)) / SR
            kick = np.sin(2 * np.pi * (90 * np.exp(-t * 18)) * t) * np.exp(-t * 22)
            place(buf, 0.18 * kick, b * 4 * beat + i * beat)
    return buf, total


def tech():
    bpm, bars = 120, 16
    beat = 60 / bpm; total = bars * 4 * beat
    buf = np.zeros(int(total * SR))
    prog = [57, 57, 53, 55]
    rng = np.random.default_rng(7)
    for b in range(bars):
        root = prog[(b // 2) % 4]
        for i in range(16):
            n = root - 12 + (12 if i % 4 == 2 else 0)
            place(buf, 0.07 * lowpass(tone(note(n), beat / 4 * 0.9, "saw", a=0.003, r=0.08), 6), b * 4 * beat + i * beat / 4)
            if i % 2 == 1:
                hat = rng.standard_normal(int(0.03 * SR)) * np.exp(-np.arange(int(0.03 * SR)) / SR * 160)
                place(buf, 0.025 * hat, b * 4 * beat + i * beat / 4)
        for n in (root + 12, root + 15, root + 19):
            place(buf, 0.035 * tone(note(n), 4 * beat, "tri", a=0.8, r=0.8, detune=0.004), b * 4 * beat)
    return buf, total


def write(name, sig):
    sig = sig / (np.max(np.abs(sig)) + 1e-9) * 0.8
    stereo = np.stack([sig, np.roll(sig, int(0.012 * SR))], axis=1)
    wav = os.path.join(OUT, f"{name}.wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((stereo * 32767).astype(np.int16).tobytes())
    import imageio_ffmpeg
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", wav, "-b:a", "128k",
                    os.path.join(OUT, f"{name}.mp3")], check=True)
    os.remove(wav)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    meta = {"calm": "舒缓铺底，适合原理讲解", "bright": "轻快拨弦，适合产品介绍和消费品广告", "tech": "科技感脉冲，适合发布会和技术产品"}
    for name, fn in (("calm", calm), ("bright", bright), ("tech", tech)):
        sig, _ = fn()
        write(name, sig)
    json.dump(meta, open(os.path.join(OUT, "catalog.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("bgm:", sorted(os.listdir(OUT)))
