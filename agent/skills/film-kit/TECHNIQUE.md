# Technique: how the films are built

Every film here is made from code: no video generation, no stock footage. This page explains the pipeline, to reproduce with our tools in `core/` or in your own stack. Pair it with [`DIRECTOR.md`](DIRECTOR.md) and one `styles/<slug>/STYLE.md`. Every command and flag is in [`core/README.md`](core/README.md).

```
timeline (single source of truth)
   ├─► picture:  web page with render(t) ──► headless Chrome, frame by frame ──► video.mp4
   ├─► voice:    TTS per line ──► speech-to-text check ──► word timings
   ├─► music:    score from the same timeline (samples + synthesis) ──► stems
   ├─► sound:    procedural foley at event times
   └─► subtitles: .srt + burned-in captions
mix (duck, compress, balance) ──► mux with ffmpeg, two-pass loudnorm −14 LUFS ──► film.mp4
```

## 2. The picture is a function of time

Each film is a folder with an `index.html` (`<demo>` in the commands) that exposes:

```js
window.DUR = 54.2;                 // seconds
window.render = (t) => { ... };    // draw the frame at time t, deterministic
window.READY = true;               // set once fonts and images are loaded
window.EV = [{t, type, ...}];      // optional: sound / cue events for the mixer
window.TEXTS = (t) => [{id, text, x0, y0, x1, y1}];   // optional: every text visible at t, for readcheck
```

**Paths:** pages reach library files with absolute URLs (`/core/lib.js`, `/node_modules/three/build/three.module.js`); scripts and `build.sh` use `$LIB`. Never `../..`.

A `build.sh` that works in both modes (in skill mode, put `LIB=<path setup.sh printed>` at the top):

```sh
#!/bin/sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${LIB:-$(cd "$HERE/../.." && pwd)}          # clone mode: <repo>/films/<name>/
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 24 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"                               # score, foley, voice → out/mix.wav
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/<name>.mp4" 24
```

Rules that keep it reliable:

- **Deterministic.** No `Date.now()`, no `Math.random()` without a seed (`core/lib.js` has `mulberry` and `hash`), no state carried from the previous frame. Any frame can be rendered alone, in any order, by any worker.
- **Canvas 2D** for most 2D styles; **three.js** for 3D (§9); **WebGL2** shaders for post passes (film damage, CRT, ink redraw).
- **Animate on twos where the style wants it** (12 fps stepping for stop-motion, pixel or cel looks), but keep the camera and light smooth every frame. A stepped camera reads as lag.
- **One world → screen function.** Any effect that follows a subject (iris, zoom, spotlight) goes through it. Never hand-type screen coordinates.
- **Draw for the frame you render.** The default is 1920×1080; for another size pass `--size WxH` (e.g. `1080x1920`) to every render tool and lay the page out from `innerWidth` × `innerHeight`.

Capture (`core/render/`):

```sh
node core/render/still.mjs <demo> 1.5 12 --range 0:50:2   # review stills; exits on page errors
node core/render/video.mjs <demo> --fps 24 --workers 3     # all frames → <demo>/out/video.mp4
node core/render/events.mjs <demo>                         # export DUR + EV → events.json
node core/render/readcheck.mjs <demo>                      # every on-screen text stays long enough to read
```

To render a second version with other content, pass it to the page and give it its own output: `--q 'content=content_alt.json' --out …/alt.mp4` (the same for `events.mjs`).

Capture is fast because of **JPEG screenshots**, **one browser per worker** and **grain added in ffmpeg**: grain drawn in the page makes every frame incompressible and slow.

## 3. One timeline drives everything

Keep sections, tempo, beats and hit points in one file (`timeline.js`). Export it to JSON and let the score, the mixer, the subtitles and the checks read the same numbers:

```js
export const SECS = [{ id: 'chase', t: 12.0, bpm: 144, beats: 12 }, ...];
export const HIT  = { pratfall: ['chase', 6], ... };   // section + beat
```

A small script (`cuecheck.py`, in `styles/<slug>/demo/tools/` of several demos) compares every visual hit with the music cue it should land on. Aim for 0 ms.

## 8. Review loop

1. Contact sheets: a frame every 1–2 s with `still.mjs --range`, tiled with `core/render/sheet.py`. At least two full passes.
2. Frame strips at 0.2 s for every key action: hand-overs, falls, hits.
3. On the final file: `ffmpeg -af ebur128` (loudness), `blackdetect` (blank frames), whisper again on the final mix if it has voice.
4. Watch it once, at full speed, with sound.

## 9. 3D notes

- three.js r170 rendered headless through WebGL2 on the GPU; physical depth of field and GTAO from `core/three/post.js`, rendered at 2× and downsampled.
- Lighting: soft area lights plus a Poly Haven HDRI at low intensity reads more "real" than bright ambient light.
- `core/three/post.js` is written for a perspective camera. For an orthographic camera swap `perspectiveDepthToViewZ` for `orthographicDepthToViewZ` in its depth pass, or the depth of field silently breaks.

## 10. Characters drawn in code

- A 2.5D rig (torso, head, limbs solved per frame) is enough for pantomime.
- Order the shoulder rotation as abduction, then flexion; the reverse order crosses raised arms into an X.
- Let the shoulder girdle rise and move forward as the arm lifts, and don't outline the part of the arm that overlaps the torso: that line is what makes a joint look like a puppet seam.

## 11. Assets, credits and fonts

Only CC0, CC BY or OFL material, each listed in the film's `CREDITS` with its source and licence; `core/audio/sampler.py credits(names)` writes the lines for the instruments you used.

Fonts: Google Fonts (OFL), self-hosted in the project. The typefaces a `STYLE.md` names are not in the library; download them (`https://github.com/google/fonts/tree/main/ofl/<family>`) into the project's `fonts/`. `core/fonts/` holds a few Latin display fonts and a Chinese display font with only about 200 glyphs, not enough for running Chinese text. For Chinese, subset a CJK font to the characters you use: the Google Fonts CSS API with `&text=` returns just those glyphs (`https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@700&text=<URL-encoded characters>`). Download the font file it points to into the project's `fonts/` and load it with `@font-face`; don't link Google Fonts at render time.

## 12. Where to look in our demos

| If you need… | Look at |
|---|---|
| 2D character animation and lip sync | `styles/scifi-toon/`, `styles/cel-anime-80s/` |
| a timeline-driven score with cue checking | `styles/microgame/`, `styles/silent-film/` |
| an image-to-ink redraw and film-damage post pass | `styles/silent-film/demo/engine/` |
| a brush or stroke engine | `styles/watercolor/`, `styles/ink-wash/`, `styles/impasto/` |
| 3D with depth of field and real materials | `styles/brick-toy/`, `styles/paper-popup/` |
| a CRT or VHS look | `core/post/crt.js`, `styles/ascii-crt/`, `styles/backrooms/` |

Each style's `DEMO.md` says how its demo was built. Open it and the code only after your treatment exists, to learn a technique, never to rebuild our film. In skill mode, get the source with `sh <skill folder>/scripts/setup.sh demo <slug>`. Copied demo code often reaches the library with `../..`: replace that with `$LIB` or absolute URLs.
