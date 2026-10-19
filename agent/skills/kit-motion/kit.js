/* 素材库公共函数：镜头模板（/skills/kit-shots/）和动作（/skills/kit-motion/）都先加载这个文件。
 * 依赖运行时注入的 SLATE（SLATE.timeline、SLATE.rng 等）。
 *
 *   KIT.shots[id](root, {content, theme, dur}) → 时间线：把一个镜头模板挂到 root 里，返回它的时间线（从 0 秒开始）
 *   KIT.motions[name](tl, 目标, {at, dur, ...})：把一个动作排进时间线 tl
 *
 * 场景里这样用：
 *   const tl = SLATE.timeline();
 *   tl.add(KIT.shots["bar-chart-race"](document.getElementById("main"), {content: {...}}), 0);
 *   KIT.motions.softBlurIn(tl, "#title", {at: 0.3});
 *   window.render = t => tl.at(t);
 */
(function () {
  const KIT = (window.KIT = window.KIT || {});
  KIT.shots = KIT.shots || {};
  KIT.motions = KIT.motions || {};

  /** 注入一段样式（同一个 id 只注入一次） */
  KIT.css = (id, text) => {
    if (document.getElementById("kit-css-" + id)) return;
    const s = document.createElement("style");
    s.id = "kit-css-" + id;
    s.textContent = text;
    (document.head || document.documentElement).appendChild(s);
  };

  /** 解析目标：元素、元素数组、选择器（可以限定在 scope 里找） */
  KIT.els = (target, scope) => {
    if (typeof target === "string") return Array.from((scope || document).querySelectorAll(target));
    if (target == null) return [];
    if (target.nodeType || !(Symbol.iterator in Object(target))) return [target];
    return Array.from(target);
  };
  KIT.el = (target, scope) => KIT.els(target, scope)[0] || null;

  /** 设计尺寸舞台：模板按 w×h（默认 1920×1080）的像素设计，挂进 root 后按比例缩放到 root 的大小，居中放置。
   *  返回舞台元素，模板的内容都放在它里面 */
  KIT.stage = (root, w = 1920, h = 1080) => {
    const rw = root.clientWidth || SLATE.width, rh = root.clientHeight || SLATE.height;
    const k = Math.min(rw / w, rh / h);
    const box = document.createElement("div");
    box.className = "kit-stage";
    Object.assign(box.style, {
      position: "absolute", left: `${(rw - w * k) / 2}px`, top: `${(rh - h * k) / 2}px`, width: `${w}px`, height: `${h}px`,
      transform: `scale(${k})`, transformOrigin: "0 0", overflow: "hidden",
    });
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
    root.appendChild(box);
    box.kitScale = k;
    return box;
  };

  /** 把主题（CSS 变量表）写到元素上：{"--kit-accent": "#ff5a36"} */
  KIT.theme = (el, theme) => {
    for (const [k, v] of Object.entries(theme || {})) el.style.setProperty(k.startsWith("--") ? k : `--kit-${k}`, String(v));
    return el;
  };

  /** 把元素里的文字拆成一个个字（或词），各包一层 span，返回这些 span。只在初始化时调用一次。
   *  中文没有空格，"词"按浏览器的中文分词切（Intl.Segmenter），切不了就按字 */
  const split = (el, mode, cls) => {
    const text = el.textContent;
    let parts;
    if (mode === "chars") parts = Array.from(text);
    else if (typeof Intl !== "undefined" && Intl.Segmenter) parts = Array.from(new Intl.Segmenter("zh", { granularity: "word" }).segment(text), s => s.segment);
    else parts = text.split(/(\s+)/);
    el.textContent = "";
    const spans = [];
    for (const p of parts) {
      if (/^\s+$/.test(p)) { el.appendChild(document.createTextNode(p)); continue; }
      const s = document.createElement("span");
      s.className = cls;
      s.style.display = "inline-block";
      s.textContent = p;
      el.appendChild(s);
      spans.push(s);
    }
    return spans;
  };
  KIT.splitChars = (target, cls = "kit-char") => KIT.els(target).flatMap(el => split(el, "chars", cls));
  KIT.splitWords = (target, cls = "kit-word") => KIT.els(target).flatMap(el => split(el, "words", cls));

  /** 一个模板或动作的时长要适配这一镜：native 是原设计时长，dur 是实际给的时长。
   *  返回 {k, exitAt}：入场动作的时间都乘以 k（给的时间比原设计短时等比压缩），退场动作从 exitAt(退场时长) 开始 */
  KIT.fit = (native, dur) => {
    const d = dur || native;
    const k = Math.min(1, d / native);
    return { k, d, exitAt: len => d - len * k };
  };
})();
