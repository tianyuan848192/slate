/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 马克笔强调：文字上浮入场，到点后手绘笔画画在重点词上，词轻弹一下。参数：at, dur(3.5), word, style(highlight|circle|underline|scribble), color, drawAt(0.9), exit(none|fade|up), rise */
(function () {
  const SHAPES = {
    highlight: { vb: "0 0 100 40", d: "M 3 24 C 22 20.5, 47 25.5, 68 22.5 C 79 21, 90 23, 97 21.5", sw: 26, op: 0.5 },
    circle: { vb: "0 0 100 40", d: "M 22 7 C 58 1, 95 8, 97 20 C 99 31, 74 38, 44 37 C 16 36, 2 29, 3 19 C 4 10, 22 4, 52 4.5", sw: 2.8, op: 1 },
    underline: { vb: "0 0 100 12", d: "M 2 7 C 20 4.5, 46 8.5, 66 6 C 80 4.5, 92 7.5, 98 5.5", sw: 4.5, op: 1 },
    scribble: { vb: "0 0 100 40", d: "M 6 13 C 34 9.5, 66 11, 94 9 C 60 15, 26 16, 7 20 C 36 18, 68 21, 93 18 C 62 25, 28 27, 8 29", sw: 5, op: 0.65 }
  };
  const COLORS = { green: "#71f5a7", blue: "#61a8ff", violet: "#c5a3ff" };

  function css() {
    KIT.css("kit-marker-highlight", `
      .kit-mh-em{position:relative;display:inline-block;white-space:nowrap;}
      .kit-mh-em-text{position:relative;z-index:1;}
      .kit-mh-mark{position:absolute;z-index:0;overflow:visible;pointer-events:none;}
      .kit-mh-em[data-mh="highlight"] .kit-mh-mark{left:-3%;top:14%;width:106%;height:76%;}
      .kit-mh-em[data-mh="underline"] .kit-mh-mark{left:-2%;bottom:-14%;width:105%;height:22%;z-index:2;}
      .kit-mh-em[data-mh="circle"] .kit-mh-mark{left:-13%;top:-26%;width:126%;height:152%;z-index:2;}
      .kit-mh-em[data-mh="scribble"] .kit-mh-mark{left:-2%;top:12%;width:104%;height:76%;z-index:2;}
    `);
  }

  function wrapEmphasis(el, word) {
    const em = document.createElement("span");
    em.className = "kit-mh-em";
    const txt = document.createElement("span");
    txt.className = "kit-mh-em-text";
    if (!word) {
      while (el.firstChild) txt.appendChild(el.firstChild);
      em.appendChild(txt);
      el.appendChild(em);
      return em;
    }
    const lw = word.toLowerCase();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.toLowerCase().indexOf(lw);
      if (idx < 0) continue;
      const mid = idx > 0 ? node.splitText(idx) : node;
      mid.splitText(word.length);
      mid.parentNode.insertBefore(em, mid);
      txt.appendChild(mid);
      em.appendChild(txt);
      return em;
    }
    return null;
  }

  function build(el, word, styleName, color) {
    if (el._kitMarker && el._kitMarker.key === word + "|" + styleName) return el._kitMarker;
    if (el._kitMarker) return el._kitMarker;
    css();
    const em = wrapEmphasis(el, word);
    let path = null, shape = SHAPES[styleName];
    if (em) {
      em.dataset.mh = styleName;
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "kit-mh-mark");
      svg.setAttribute("viewBox", shape.vb);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("data-qa", "ignore");
      path = document.createElementNS(NS, "path");
      path.setAttribute("d", shape.d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", String(shape.sw));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.style.stroke = color;
      svg.appendChild(path);
      em.insertBefore(svg, em.firstChild);
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      path.style.opacity = "0";
      path._len = len;
    }
    el.dataset.kitMarker = "1";
    el._kitMarker = { key: word + "|" + styleName, em, path, shape };
    return el._kitMarker;
  }

  KIT.motions = KIT.motions || {};
  KIT.motions.markerHighlight = function (tl, target, o = {}) {
    const els = KIT.els(target);
    const at = o.at ?? 0, dur = o.dur ?? 3.5;
    const k = dur / 3.5;
    const styleName = SHAPES[o.style] ? o.style : "highlight";
    const color = COLORS[o.color] || o.color || COLORS.green;
    const word = o.word == null ? "" : String(o.word).trim();
    const exit = o.exit === "fade" || o.exit === "up" ? o.exit : "none";
    const u = SLATE.u;
    const IN = 0.55 * k, DRAW = 0.6 * k, POP = 0.32 * k;
    const OUT = exit === "none" ? 0 : 0.45 * k;
    const outStart = at + dur - OUT;
    let drawAt = at + Math.max(0, o.drawAt ?? 0.9) * k;
    drawAt = Math.min(drawAt, Math.max(at, outStart - (DRAW + POP)));

    els.forEach((el) => {
      const m = build(el, word, styleName, color);
      if (o.rise !== false) {
        tl.tween(el, { opacity: [0, 1], y: [3.5 * u, 0] }, { at, dur: IN, ease: "outQuart" });
      }
      if (m.path) {
        tl.set(m.path, { opacity: m.shape.op }, drawAt);
        tl.tween(m.path, { strokeDashoffset: [m.path._len, 0] }, { at: drawAt, dur: DRAW, ease: "inOutCubic" });
        tl.tween(m.em, { scale: [1, 1.045] }, { at: drawAt + DRAW * 0.7, dur: POP / 2, ease: "outQuad", yoyo: true, repeat: 1 });
      }
      if (exit === "fade") {
        tl.tween(el, { opacity: 0 }, { at: outStart, dur: OUT, ease: "inCubic" });
      } else if (exit === "up") {
        tl.tween(el, { opacity: 0, y: -4 * u }, { at: outStart, dur: OUT, ease: "inCubic" });
      }
    });
    return tl;
  };
})();
