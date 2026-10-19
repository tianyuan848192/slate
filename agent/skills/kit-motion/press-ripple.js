/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
/** 光标减速飞入、按下目标（同步压缩回弹）、两圈点击波纹、文字换成对勾+完成文字，光标加速飞出。参数：at, dur(2.4), done, accent, cursor('light'|'dark'), enter(true), exit('none'|'fade'|'up') */
KIT.motions = KIT.motions || {};
KIT.motions.pressRipple = function (tl, target, o = {}) {
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? 2.4;
  const k = dur / 2.4;
  const u = SLATE.u;
  const accent = o.accent || '#22c55e';
  const dark = o.cursor === 'dark';
  const ez = (name) => { const f = SLATE.easing(name); return typeof f === 'function' ? f : (p) => p; };
  const eOut3 = ez('outQuart'), eInQ = ez('inQuad'), eBack = ez('outBack(1.8)');
  const eOut2 = ez('outCubic'), eIn2 = ez('inCubic');
  const cl = (v) => Math.min(1, Math.max(0, v));

  KIT.css('kit-press-ripple', `
    .kit-pr-cursor{position:absolute;left:0;top:0;pointer-events:none;z-index:20;filter:drop-shadow(0 ${0.28*u}px ${0.37*u}px rgba(0,0,0,.3));}
    .kit-pr-cursor svg{display:block;width:100%;height:100%;}
    .kit-pr-rings{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:19;}
    .kit-pr-label{display:inline-block;}
    .kit-pr-done{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:.3em;opacity:0;white-space:nowrap;}
    .kit-pr-check{width:.9em;height:.9em;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;}
  `);

  const P = at + 0.9 * k;            // 按下时刻
  const arriveStart = P - 0.6 * k, arriveDur = 0.45 * k;
  const exitStart = P + 0.4 * k, exitDur = 0.4 * k;

  els.forEach((el) => {
    const parent = el.parentElement;
    el.dataset.state = 'idle';

    // 入场：淡入 + 轻微上浮
    if (o.enter !== false) {
      tl.tween(el, { opacity: [0, 1], y: [2.6 * u, 0] }, { at, dur: 0.5 * k, ease: 'outQuart' });
    }
    // 按压：与光标同步压缩，再弹回
    tl.tween(el, { scale: [1, 0.93] }, { at: P, dur: 0.12 * k, ease: 'inQuad' });
    tl.tween(el, { scale: 1 }, { at: P + 0.14 * k, dur: 0.42 * k, ease: 'outBack(1.8)' });
    tl.call((p, t) => {
      const now = at + p * dur;
      el.dataset.state = now >= P + 0.12 * k ? 'pressed' : 'idle';
    }, { at, dur, ease: 'linear' });

    // 文字换成对勾
    if (o.done != null) {
      let label, done;
      if (!el.dataset.kitPrSwap) {
        el.dataset.kitPrSwap = '1';
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        label = document.createElement('span');
        label.className = 'kit-pr-label';
        while (el.firstChild) label.appendChild(el.firstChild);
        el.appendChild(label);
        done = document.createElement('span');
        done.className = 'kit-pr-done';
        done.innerHTML = `<svg class="kit-pr-check" viewBox="0 0 24 24" aria-hidden="true" style="stroke:${accent}"><path d="M5 12.5 L9.5 17 L19 7.5"></path></svg><span class="kit-pr-done-text"></span>`;
        done.querySelector('.kit-pr-done-text').textContent = String(o.done);
        el.appendChild(done);
      } else {
        label = el.querySelector('.kit-pr-label');
        done = el.querySelector('.kit-pr-done');
      }
      const b = 0.28 * u;
      tl.tween(label, { scale: [1, 0.3], opacity: [1, 0], filter: ['blur(0px)', `blur(${b}px)`] }, { at: P + 0.12 * k, dur: 0.3 * k, ease: 'outQuart' });
      tl.tween(done, { scale: [0.3, 1], opacity: [0, 1], filter: [`blur(${b}px)`, 'blur(0px)'] }, { at: P + 0.12 * k, dur: 0.3 * k, ease: 'outQuart' });
    }

    // 辅助元素：光标与波纹
    const A = 5.93 * u; // 原 64px@1080 高
    const cursor = document.createElement('div');
    cursor.className = 'kit-pr-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.width = cursor.style.height = A + 'px';
    cursor.style.left = (-5 / 24) * A + 'px';
    cursor.style.top = (-3 / 24) * A + 'px';
    cursor.style.transformOrigin = `${(5 / 24) * A}px ${(3 / 24) * A}px`;
    cursor.style.visibility = 'hidden';
    cursor.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 3 L5 19 L9 15 L12 22 L15 20.5 L11.5 14 L18 14 Z" fill="${dark ? '#141414' : '#ffffff'}" stroke="${dark ? '#ffffff' : '#141414'}" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'kit-pr-rings');
    svg.setAttribute('aria-hidden', 'true');
    const rings = [0, 1].map(() => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', accent);
      c.setAttribute('stroke-width', Math.max(1.5, 0.185 * u));
      c.setAttribute('opacity', '0');
      svg.appendChild(c);
      return c;
    });
    parent.appendChild(svg);
    parent.appendChild(cursor);

    let g = null;
    const geo = () => {
      if (g) return g;
      const pr = parent.getBoundingClientRect();
      const sc = pr.width / (parent.offsetWidth || pr.width || 1) || 1;
      const W = parent.clientWidth, H = parent.clientHeight;
      // 中心不受 transform 缩放影响（缩放绕中心），但入场 y 会影响，按 offset 估算
      const r = el.getBoundingClientRect();
      const ty = (el.style.transform.match(/translate[^(]*\([^,]*,\s*(-?[\d.]+)px/) || [])[1];
      const cx = (r.left + r.width / 2 - pr.left) / sc - parent.clientLeft;
      const cy = (r.top + r.height / 2 - pr.top) / sc - parent.clientTop - (ty ? parseFloat(ty) : 0);
      g = { lx: cx + 0.0055 * W, ly: cy + 0.0085 * H, sx: 1.14 * W, sy: 1.12 * H, ex: 1.12 * W, ey: 1.10 * H };
      rings.forEach((c) => { c.setAttribute('cx', g.lx); c.setAttribute('cy', g.ly); });
      return g;
    };

    const r0 = 1.48 * u, r1 = 6.67 * u;
    tl.call((p) => {
      const now = at + p * dur;
      const G = geo();
      // 光标位置
      let x, y;
      if (now < exitStart) {
        const q = eOut3(cl((now - arriveStart) / arriveDur));
        x = SLATE.lerp(G.sx, G.lx, q); y = SLATE.lerp(G.sy, G.ly, q);
      } else {
        const q = eIn2(cl((now - exitStart) / exitDur));
        x = SLATE.lerp(G.lx, G.ex, q); y = SLATE.lerp(G.ly, G.ey, q);
      }
      // 光标缩放（绕尖端）
      let s = 1;
      if (now >= P && now < P + 0.14 * k) s = 1 - 0.07 * eInQ(cl((now - P) / (0.12 * k)));
      else if (now >= P + 0.14 * k) s = 0.93 + 0.07 * eBack(cl((now - P - 0.14 * k) / (0.42 * k)));
      cursor.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      cursor.style.visibility = (now >= arriveStart && now <= exitStart + exitDur) ? 'visible' : 'hidden';
      // 波纹
      [1, 0.6].forEach((peak, i) => {
        const rs = P + 0.12 * k + i * 0.06 * k, rd = 0.32 * k;
        const c = rings[i];
        if (now < rs || now > rs + rd) { c.setAttribute('opacity', '0'); c.setAttribute('r', r0); return; }
        const q = cl((now - rs) / rd);
        c.setAttribute('r', SLATE.lerp(r0, r1, eOut2(q)));
        c.setAttribute('opacity', peak * (1 - eInQ(q)));
      });
    }, { at, dur, ease: 'linear' });

    // 退场（可选）
    if (o.exit === 'fade' || o.exit === 'up') {
      const out = 0.45 * k;
      const outAt = Math.max(P + 0.8 * k, at + dur - out);
      const props = { opacity: 0 };
      if (o.exit === 'up') props.y = -4 * u;
      tl.tween(el, props, { at: outAt, dur: out, ease: 'inCubic' });
    }
  });
  return tl;
};
