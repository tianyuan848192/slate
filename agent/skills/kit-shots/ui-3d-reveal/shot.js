/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */
KIT.shots["ui-3d-reveal"] = function (root, o = {}) {
  const content = Object.assign({
    fileName: "应用改版",            // 工具栏文件名
    pageName: "设计规范",            // 工具栏页面名
    frameName: "视频平台 — 首页",     // 画框名称
    heroTitle: "把你的创意变成\n可直接发布的视频", // 画板主标题
    prompt: "做一支 30 秒的新品发布短片", // 输入框里打出的文字
    placeholder: "描述你的视频创意…",  // 输入框占位文字
    selLabel: "创建卡片 · W 322 H 110", // 选中框标签
    tagline: "伟大的作品，从不独自完成。", // 结尾标语
    url: "design.example.com"        // 结尾网址
  }, o.content);
  const theme = Object.assign({
    "--kit-accent": "#18A0FB",
    "--kit-bg": "#111111",
    "--kit-font": "\"Inter\", \"Noto Sans CJK SC\", sans-serif"
  }, o.theme);
  const { k, exitAt } = KIT.fit(13, o.dur);
  const K = (s) => s * k;

  if (!document.querySelector('link[data-kit-font="inter"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/fonts/lib/inter.css"; l.dataset.kitFont = "inter";
    document.head.appendChild(l);
  }
  SLATE.waits = SLATE.waits || [];
  SLATE.waits.push(document.fonts.load('400 16px "Inter"'), document.fonts.load('600 44px "Inter"'), document.fonts.load('700 17px "Inter"'));

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const P = ".kit-ui-3d-reveal";
  KIT.css("ui-3d-reveal", `
${P}{position:absolute;inset:0;overflow:hidden;background:var(--kit-bg);font-family:var(--kit-font);color:#e8e8e8}
${P} *{box-sizing:border-box;margin:0;padding:0}
${P} .bg-base{position:absolute;inset:0;background:var(--kit-bg)}
${P} .bg-glow{position:absolute;inset:0;background:radial-gradient(ellipse 900px 600px at 50% 48%,rgba(24,160,251,.06) 0%,transparent 65%),radial-gradient(ellipse 500px 300px at 20% 70%,rgba(162,89,255,.04) 0%,transparent 60%)}
${P} .intro-layer,${P} .outro-layer{position:absolute;inset:0}
${P} svg.full{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
${P} .scene{position:absolute;left:0;top:0;width:1920px;height:960px;display:flex;align-items:center;justify-content:center;perspective:2800px;perspective-origin:50% 50%;opacity:0}
${P} .card-glow{position:absolute;left:360px;top:90px;width:1200px;height:780px;border-radius:24px;background:radial-gradient(ellipse at 50% 50%,rgba(24,160,251,.18) 0%,transparent 65%);filter:blur(50px);opacity:0}
${P} .card-fit{transform:scale(0.92);transform-style:preserve-3d}
${P} .card-wrapper{position:relative;transform-style:preserve-3d}
${P} .ui-card{width:1100px;height:680px;background:#1e1e1e;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1);position:relative;display:flex;flex-direction:column;box-shadow:inset -1px 0 0 rgba(24,160,251,.2),0 40px 120px rgba(0,0,0,.7)}
${P} .depth-right{position:absolute;top:12px;left:1100px;width:10px;height:656px;transform-origin:0% 50%;transform:rotateY(90deg);background:linear-gradient(to right,rgba(80,160,255,.4) 0%,rgba(40,100,200,.2) 40%,rgba(10,20,50,.9) 100%);border-radius:3px 2px 2px 3px}
${P} .fig-toolbar{height:48px;background:#2c2c2c;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;padding:0 12px;flex-shrink:0;position:relative;z-index:2}
${P} .tb-left{display:flex;align-items:center;gap:8px}
${P} .fig-logo{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:6px}
${P} .tool-divider{width:1px;height:20px;background:rgba(255,255,255,.12)}
${P} .tool-group{display:flex;align-items:center;gap:2px}
${P} .tool-btn{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#868686}
${P} .tool-btn.active{background:rgba(24,160,251,.18);color:var(--kit-accent)}
${P} .tb-center{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;color:#e8e8e8}
${P} .file-name{font-weight:500}${P} .file-chevron{color:#555}${P} .file-page,${P} .file-arrow{color:#868686}
${P} .tb-right{display:flex;align-items:center;gap:8px}
${P} .mode-tabs{display:flex;background:rgba(255,255,255,.06);border-radius:6px;padding:2px;gap:2px}
${P} .mode-tab{font-size:11px;font-weight:500;color:#868686;padding:4px 10px;border-radius:4px}
${P} .mode-tab.active{background:#3c3c3c;color:#e8e8e8}
${P} .share-btn{display:flex;align-items:center;gap:5px;background:var(--kit-accent);color:#fff;font-size:11px;font-weight:600;padding:6px 12px;border-radius:6px;white-space:nowrap}
${P} .avatar-cluster{display:flex;align-items:center;gap:2px}
${P} .fig-avatar{width:26px;height:26px;border-radius:50%;font-size:9px;font-weight:700;color:#fff;display:flex;align-items:center;justify-content:center;border:2px solid #2c2c2c;position:relative}
${P} .present-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:5px;background:rgba(255,255,255,.06);font-size:10px;color:#e8e8e8}
${P} .fig-body{flex:1;display:flex;min-height:0}
${P} .fig-layers{width:220px;background:#2c2c2c;border-right:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column}
${P} .panel-tabs{height:40px;display:flex;gap:14px;padding:0 14px;align-items:center;border-bottom:1px solid rgba(255,255,255,.06)}
${P} .ptab{font-size:11px;font-weight:600;color:#868686}${P} .ptab.active{color:#e8e8e8}
${P} .layer-search{margin:8px 10px;height:28px;background:rgba(255,255,255,.05);border-radius:5px;display:flex;align-items:center;gap:6px;padding:0 8px;color:#868686;font-size:11px}
${P} .layer-list{flex:1;padding:4px 0}
${P} .layer-item{height:28px;display:flex;align-items:center;gap:6px;padding-left:14px;font-size:11px;color:#c8c8c8;white-space:nowrap}
${P} .layer-item .li-icon,${P} .layer-item .li-collapse{color:#868686;flex-shrink:0}
${P} .layer-item.indent-1{padding-left:26px}${P} .layer-item.indent-2{padding-left:46px}
${P} .layer-item.frame-item{font-weight:600;color:#e8e8e8}
${P} .layer-item.selected-layer{color:#fff;background:rgba(24,160,251,0)}
${P} .page-bar{height:36px;border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:6px;padding:0 10px}
${P} .pbar-tab{font-size:10px;padding:4px 8px;border-radius:4px;color:#868686}${P} .pbar-tab.active{background:rgba(255,255,255,.08);color:#e8e8e8}
${P} .pbar-add{color:#868686;font-size:13px;margin-left:auto}
${P} .fig-canvas{flex:1;position:relative;background:#1e1e1e radial-gradient(rgba(255,255,255,.05) 1px,transparent 1px) 0 0/16px 16px}
${P} .canvas-frame-label{position:absolute;left:65px;top:74px;font-size:10px;color:#868686}
${P} .artboard{position:absolute;left:65px;top:92px;width:520px;height:440px;background:#fff;border-radius:4px;display:flex;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.45)}
${P} .hg-icnav{width:56px;background:#f7f7f8;border-right:1px solid #ececef;display:flex;flex-direction:column;align-items:center;padding:10px 0;gap:10px}
${P} .hg-iclogo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#3b82f6 60%,#22d3ee)}
${P} .hg-icitem{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:6.5px;color:#6b7280;white-space:nowrap}
${P} .hg-icbg{width:26px;height:26px;border-radius:8px;background:#3b82f6;display:flex;align-items:center;justify-content:center}
${P} .hg-icactive{color:#1d4ed8;font-weight:600}
${P} .hg-icuser{margin-top:auto;width:22px;height:22px;border-radius:50%;background:#f59e0b;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center}
${P} .hg-histpanel{width:105px;background:#fafafa;border-right:1px solid #ececef;padding:10px 8px;color:#374151;overflow:hidden}
${P} .hg-histhead{display:flex;justify-content:space-between;align-items:center;font-size:8px;font-weight:600;margin-bottom:8px;color:#6b7280}
${P} .hg-newitem{display:flex;align-items:center;gap:4px;background:#eef2ff;border-radius:5px;padding:5px 6px;font-size:7px;color:#1d4ed8;font-weight:500;margin-bottom:6px}
${P} .hg-histcat{font-size:5.5px;color:#9ca3af;letter-spacing:.06em;margin:7px 0 3px;font-weight:600}
${P} .hg-histrow{font-size:6.5px;padding:3px 4px;color:#4b5563;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
${P} .hg-maincnt{flex:1;position:relative;padding:44px 18px 0;display:flex;flex-direction:column;align-items:center}
${P} .hg-toprighticons{position:absolute;top:10px;right:12px;display:flex;gap:6px}
${P} .hg-ticon{width:20px;height:20px;border-radius:6px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#6b7280;position:relative}
${P} .hg-notifbadge{position:absolute;top:-4px;right:-7px;background:#ef4444;color:#fff;font-size:5px;font-weight:700;border-radius:6px;padding:1px 3px}
${P} .hg-herotitle{font-size:17px;font-weight:700;color:#111827;text-align:center;line-height:1.3;margin-bottom:14px;white-space:pre-line}
${P} .hg-createcard{width:322px;height:110px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.06);padding:10px;display:flex;flex-direction:column;position:relative}
${P} .hg-selrow{display:flex;align-items:center;gap:8px}
${P} .hg-sel{display:flex;align-items:center;gap:4px}
${P} .hg-sellbl{font-size:6px;color:#9ca3af}
${P} .hg-selbox{display:flex;align-items:center;gap:3px;background:#f3f4f6;border-radius:6px;padding:3px 5px;color:#6b7280}
${P} .hg-avphoto{width:12px;height:12px;border-radius:50%;background:linear-gradient(135deg,#fbbf77,#b45309)}
${P} .hg-seltxt{font-size:7px;font-weight:600;color:#374151}
${P} .hg-voicebars{display:flex;align-items:center;gap:1px}
${P} .hg-vbar{width:2px;background:#6366f1;border-radius:1px}
${P} .hg-seldiv{width:1px;height:12px;background:#e5e7eb}
${P} .hg-settico{margin-left:auto;color:#9ca3af;display:flex}
${P} .hg-cinput{flex:1;font-size:9px;color:#9ca3af;padding:10px 2px;white-space:nowrap;overflow:hidden}
${P} .hg-cinput.typing{color:#111827}
${P} .hg-cbottom{display:flex;justify-content:space-between;align-items:center}
${P} .hg-cbleft{display:flex;gap:4px}
${P} .hg-cbtn{width:20px;height:20px;border-radius:6px;border:1px solid #e5e7eb;display:flex;align-items:center;justify-content:center;color:#6b7280}
${P} .hg-cbright{display:flex;gap:6px;align-items:center}
${P} .hg-genbtn{display:flex;align-items:center;gap:3px;font-size:7px;font-weight:600;color:#6b7280;background:#f3f4f6;border-radius:6px;padding:4px 7px}
${P} .hg-submitbtn{width:22px;height:22px;border-radius:50%;background:#111827;display:flex;align-items:center;justify-content:center}
${P} .hg-stylessec{width:322px;margin-top:32px}
${P} .hg-stitle{font-size:9px;font-weight:700;color:#111827;margin-bottom:7px}
${P} .hg-spills{display:flex;gap:4px}
${P} .hg-spill{font-size:6px;padding:3px 7px;border-radius:10px;border:1px solid #e5e7eb;color:#4b5563;white-space:nowrap}
${P} .hg-spactive{background:#111827;color:#fff;border-color:#111827}
${P} .hg-scards{display:flex;gap:6px;margin-top:8px}
${P} .hg-sc{flex:1;height:54px;border-radius:6px;position:relative;overflow:hidden}
${P} .hg-sclbl{position:absolute;left:5px;bottom:5px;font-size:5px;font-weight:700;color:#fff;letter-spacing:.04em;line-height:1.25}
${P} .selection-ring{position:absolute;inset:-3px;border:1.5px solid var(--kit-accent);border-radius:13px;opacity:0}
${P} .sel-handle{position:absolute;width:7px;height:7px;background:#fff;border:1.5px solid var(--kit-accent)}
${P} .sel-handle.tl{left:-4px;top:-4px}${P} .sel-handle.tr{right:-4px;top:-4px}${P} .sel-handle.bl{left:-4px;bottom:-4px}${P} .sel-handle.br{right:-4px;bottom:-4px}
${P} .sel-label{position:absolute;left:0;right:0;margin:auto;width:max-content;bottom:-20px;background:var(--kit-accent);color:#fff;font-size:8px;font-weight:600;padding:2px 6px;border-radius:3px;white-space:nowrap;opacity:0}
${P} .fig-props{width:230px;background:#2c2c2c;border-left:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column}
${P} .prop-align{display:flex;align-items:center;gap:2px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06)}
${P} .align-btn{width:26px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#868686;border-radius:4px}
${P} .active-align{background:rgba(255,255,255,.08);color:#e8e8e8}
${P} .align-divider{width:1px;height:16px;background:rgba(255,255,255,.12);margin:0 4px}
${P} .prop-section{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;gap:6px}
${P} .prop-section-head{display:flex;justify-content:space-between;font-size:11px;font-weight:600;color:#e8e8e8}
${P} .prop-section-icon{color:#868686}
${P} .prop-row-2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
${P} .prop-field{display:flex;gap:8px;height:26px;align-items:center;background:rgba(255,255,255,.04);border-radius:4px;padding:0 8px;font-size:11px}
${P} .prop-pre{color:#868686;width:10px}${P} .prop-val{color:#e8e8e8}
${P} .fill-row{display:flex;gap:8px;align-items:center;font-size:11px}
${P} .fill-preview{width:14px;height:14px;border-radius:3px;border:1px solid rgba(255,255,255,.2)}
${P} .fill-hex{flex:1}${P} .fill-pct{color:#868686}${P} .prop-empty{color:#555}
${P} .effect-row{display:flex;gap:8px;align-items:center;font-size:11px}
${P} .effect-dot{width:10px;height:10px;border-radius:2px;background:rgba(255,255,255,.2)}
${P} .outro-tagline{position:absolute;left:0;right:0;top:600px;text-align:center;font-size:44px;font-weight:600;color:#e8e8e8;letter-spacing:-.01em;line-height:60px;white-space:nowrap}
${P} .outro-tagline span{display:inline-block;opacity:0}
${P} .outro-fade{position:absolute;inset:0;background:#000;opacity:0}
`);

  const stage = KIT.stage(root, 1920, 1080);
  stage.classList.add("kit-ui-3d-reveal");
  KIT.theme(stage, theme);

  const SHAPES = [
    ["path", 'd="M95 0H47.5C21.27 0 0 21.27 0 47.5S21.27 95 47.5 95H95V0Z"', "#F24E1E"],
    ["path", 'd="M95 0V95H142.5C168.73 95 190 73.73 190 47.5S168.73 0 142.5 0H95Z"', "#FF7262"],
    ["path", 'd="M95 95H47.5C21.27 95 0 116.27 0 142.5S21.27 190 47.5 190H95V95Z"', "#A259FF"],
    ["circle", 'cx="142.5" cy="142.5" r="47.5"', "#1ABCFE"],
    ["path", 'd="M47.5 190C21.27 190 0 211.27 0 237.5S21.27 285 47.5 285 95 263.73 95 237.5V190H47.5Z"', "#0ACF83"]
  ];
  const logo = (sw) =>
    SHAPES.map(([tag, a, c]) => `<${tag} class="lg-fill" ${a} fill="${c}" opacity="0"/>`).join("") +
    SHAPES.map(([tag, a, c]) => `<${tag} class="lg-stroke" ${a} fill="none" stroke="${c}" stroke-width="${sw}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/>`).join("");

  const ico = (d, w = 14) => `<svg viewBox="0 0 16 16" fill="none" width="${w}" height="${w}"><path d="${d}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const box = `<svg class="li-icon" viewBox="0 0 12 12" fill="none" width="12" height="12"><rect x="1" y="1" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>`;
  const chev = (r) => `<svg class="li-collapse" viewBox="0 0 8 8" width="8" height="8" fill="none" ${r ? 'style="transform:rotate(-90deg)"' : ""}><path d="M2 3l2 2 2-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  const comp = `<svg class="li-icon" viewBox="0 0 12 12" fill="none" width="12" height="12"><path d="M6 1L11 6 6 11 1 6z" stroke="#A259FF" stroke-width="1.2"/></svg>`;
  const txtI = `<svg class="li-icon" viewBox="0 0 12 12" fill="none" width="12" height="12"><path d="M2 3h8M6 3v7M3 10h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  const field = (a, b, c, e) => `<div class="prop-row-2"><div class="prop-field"><span class="prop-pre">${a}</span><span class="prop-val">${b}</span></div><div class="prop-field"><span class="prop-pre">${c}</span><span class="prop-val">${e}</span></div></div>`;
  const urlW = Math.max(150, String(content.url).length * 9 + 48);

  stage.innerHTML = `
<div class="bg-base"></div><div class="bg-glow"></div>
<div class="intro-layer"><svg class="full" viewBox="0 0 1920 1080"><g transform="translate(865,397.5)">${logo(2)}</g></svg></div>
<div class="scene"><div class="card-glow"></div>
 <div class="card-fit"><div class="card-wrapper"><div class="ui-card">
  <div class="fig-toolbar">
   <div class="tb-left"><div class="fig-logo"><svg width="18" height="26" viewBox="0 0 18 26"><rect width="9" height="9" rx="4.5" fill="#F24E1E"/><rect x="9" width="9" height="9" rx="4.5" fill="#FF7262"/><rect y="8.5" width="9" height="9" rx="4.5" fill="#A259FF"/><circle cx="13.5" cy="13" r="4.5" fill="#1ABCFE"/><rect y="17" width="9" height="9" rx="4.5" fill="#0ACF83"/></svg></div>
    <div class="tool-divider"></div>
    <div class="tool-group">
     <div class="tool-btn active"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 2l5 12 2-4 4-2L2 2z" fill="currentColor"/></svg></div>
     <div class="tool-btn">${ico("M3 3l10 10M10 3h3v3M3 10H6")}</div>
     <div class="tool-divider"></div>
     <div class="tool-btn">${ico("M2 5h12v9H2zM5 5V3M11 5V3")}</div>
     <div class="tool-btn">${ico("M2 4h12v9H2z")}</div>
     <div class="tool-btn">${ico("M2 4h12M8 4v9M5 13h6")}</div>
     <div class="tool-btn">${ico("M3 13L8 3l5 10M5.5 8.5h5")}</div>
    </div></div>
   <div class="tb-center"><span class="file-name">${esc(content.fileName)}</span><span class="file-chevron">›</span><span class="file-page">${esc(content.pageName)}</span><svg class="file-arrow" viewBox="0 0 10 6" width="10" height="6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></div>
   <div class="tb-right"><div class="mode-tabs"><span class="mode-tab">设计</span><span class="mode-tab active">开发</span></div>
    <div class="share-btn"><svg viewBox="0 0 16 16" fill="none" width="12" height="12"><path d="M4 8H12M9 5l3 3-3 3" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>分享</div>
    <div class="avatar-cluster"><div class="fig-avatar" style="background:#a259ff">林</div><div class="fig-avatar" style="background:#f24e1e">王</div><div class="fig-avatar" style="background:#1abcfe">陈</div></div>
    <div class="present-btn">▶</div></div>
  </div>
  <div class="fig-body">
   <div class="fig-layers">
    <div class="panel-tabs"><span class="ptab active">图层</span><span class="ptab">资源</span></div>
    <div class="layer-search"><svg viewBox="0 0 14 14" fill="none" width="12" height="12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 9.5l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>搜索图层</span></div>
    <div class="layer-list">
     <div class="layer-item">${box}<span>页面 1</span></div>
     <div class="layer-item frame-item">${chev()}${box}<span>${esc(content.frameName)}</span></div>
     <div class="layer-item indent-1">${chev()}${box}<span>导航栏</span></div>
     <div class="layer-item indent-2">${comp}<span>品牌标识</span></div>
     <div class="layer-item indent-2">${txtI}<span>导航链接</span></div>
     <div class="layer-item indent-2 selected-layer">${comp}<span>创建卡片</span></div>
     <div class="layer-item indent-1">${chev(1)}${box}<span>首屏</span></div>
     <div class="layer-item indent-1">${chev(1)}${box}<span>功能网格</span></div>
     <div class="layer-item indent-1">${chev(1)}${box}<span>页脚</span></div>
    </div>
    <div class="page-bar"><div class="pbar-tab active">${esc(content.pageName)}</div><div class="pbar-tab">落地页</div><div class="pbar-add">+</div></div>
   </div>
   <div class="fig-canvas">
    <div class="canvas-frame-label">${esc(content.frameName)}</div>
    <div class="artboard">
     <div class="hg-icnav"><div class="hg-iclogo"></div>
      <div class="hg-icitem">${ico("M8 3a2.8 2.8 0 100 5.6A2.8 2.8 0 008 3zM2 14.5c0-3.3 2.7-6 6-6s6 2.7 6 6", 16)}<span>数字人</span></div>
      <div class="hg-icitem hg-icactive"><div class="hg-icbg"><svg viewBox="0 0 16 16" fill="none" width="15" height="15"><circle cx="8" cy="5.5" r="2.5" stroke="white" stroke-width="1.3"/><path d="M2.5 14c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" stroke="white" stroke-width="1.3" stroke-linecap="round"/></svg></div><span>视频助手</span></div>
      <div class="hg-icitem">${ico("M3 4l3 8M10 4l3 8M6 10h4", 16)}<span>动效剪辑</span></div>
      <div class="hg-icitem">${ico("M2 4h12M8 4v9M5 13h6", 16)}<span>翻译</span></div>
      <div class="hg-icitem">${ico("M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z", 16)}<span>应用</span></div>
      <div class="hg-icitem">${ico("M2 6a2 2 0 012-2h2l2 2h4a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z", 16)}<span>项目</span></div>
      <div class="hg-icuser">林</div></div>
     <div class="hg-histpanel">
      <div class="hg-histhead"><span>视频助手</span>${ico("M1 1h5v14H1zM10 1h5v14h-5z", 11)}</div>
      <div class="hg-newitem">＋ 新建视频</div>
      <div class="hg-histcat">昨天</div><div class="hg-histrow">AI 技能缺口：外星人</div>
      <div class="hg-histcat">最近 3 天</div><div class="hg-histrow">AI 技能缺口：外星人</div><div class="hg-histrow">产品策略：一个 AI 的…</div><div class="hg-histrow">第 9 场</div><div class="hg-histrow">第 7 场</div><div class="hg-histrow">第 5 场</div><div class="hg-histrow">第 3 场</div>
      <div class="hg-histcat">最近 7 天</div><div class="hg-histrow">第 8 场 定稿</div><div class="hg-histrow">第 4 场</div><div class="hg-histrow">第 2 场</div><div class="hg-histrow">氛围短片 v2</div>
     </div>
     <div class="hg-maincnt">
      <div class="hg-toprighticons"><div class="hg-ticon">${ico("M7 2a5 5 0 100 10A5 5 0 007 2zM11 11l3 3", 11)}</div><div class="hg-ticon">${ico("M8 2a4 4 0 00-4 4v3l-1 2h10l-1-2V6a4 4 0 00-4-4z", 11)}<div class="hg-notifbadge">99+</div></div><div class="hg-ticon">${ico("M8 2l1.5 4H14l-3.5 2.5L12 13 8 10.5 4 13l1.5-4.5L2 6h4.5z", 11)}</div></div>
      <div class="hg-herotitle art-piece">${esc(content.heroTitle)}</div>
      <div class="hg-createcard art-piece">
       <div class="hg-selrow">
        <div class="hg-sel"><span class="hg-sellbl">形象</span><div class="hg-selbox"><div class="hg-avphoto"></div><span class="hg-seltxt">小林</span></div></div>
        <div class="hg-seldiv"></div>
        <div class="hg-sel"><span class="hg-sellbl">声音</span><div class="hg-selbox"><div class="hg-voicebars"><div class="hg-vbar" style="height:5px"></div><div class="hg-vbar" style="height:9px"></div><div class="hg-vbar" style="height:7px"></div><div class="hg-vbar" style="height:11px"></div><div class="hg-vbar" style="height:5px"></div></div><span class="hg-seltxt">自动</span></div></div>
        <div class="hg-seldiv"></div>
        <div class="hg-sel"><span class="hg-sellbl">风格</span><div class="hg-selbox">${ico("M2 2h12v12H2zM5 8l2 2 4-4", 12)}<span class="hg-seltxt">自动</span></div></div>
        <div class="hg-settico">${ico("M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5", 13)}</div>
       </div>
       <div class="hg-cinput">${esc(content.placeholder)}</div>
       <div class="hg-cbottom"><div class="hg-cbleft"><div class="hg-cbtn">${ico("M8 3v10M3 8h10", 11)}</div><div class="hg-cbtn">${ico("M8 2l1.5 4H14l-3.5 2.5L12 13 8 10.5 4 13l1.5-4.5L2 6h4.5z", 11)}</div><div class="hg-cbtn">${ico("M2 4h12M2 8h12M2 12h8", 11)}</div></div>
        <div class="hg-cbright"><div class="hg-genbtn">✦ 生成 ▾</div><div class="hg-submitbtn"><svg viewBox="0 0 12 12" fill="none" width="10" height="10"><path d="M6 9V3M3 6l3-3 3 3" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div></div></div>
       <div class="selection-ring"><div class="sel-handle tl"></div><div class="sel-handle tr"></div><div class="sel-handle bl"></div><div class="sel-handle br"></div><div class="sel-label">${esc(content.selLabel)}</div></div>
      </div>
      <div class="hg-stylessec art-piece"><div class="hg-stitle">社区热门风格</div>
       <div class="hg-spills"><div class="hg-spill hg-spactive">全部风格</div><div class="hg-spill">复古科技</div><div class="hg-spill">艺术家</div><div class="hg-spill">流行文化</div><div class="hg-spill">印刷</div><div class="hg-spill">电影感</div></div>
       <div class="hg-scards"><div class="hg-sc" style="background:linear-gradient(135deg,#1b2a5e,#2d4a9a)"><span class="hg-sclbl">落地深度</span></div><div class="hg-sc" style="background:linear-gradient(160deg,#c9ad88,#b89668)"><span class="hg-sclbl" style="color:#3d2810;font-style:italic">策略就是学会说不</span></div><div class="hg-sc" style="background:#ede9e0;display:flex;align-items:center;justify-content:center"><span style="color:#cc4422;font-size:14px;font-weight:700">?</span></div><div class="hg-sc" style="background:linear-gradient(135deg,#8b1515,#c92020)"><span class="hg-sclbl" style="color:#ffd9a0">想得远<br>做得小</span></div></div>
      </div>
     </div>
    </div>
   </div>
   <div class="fig-props">
    <div class="panel-tabs"><span class="ptab active">设计</span><span class="ptab">原型</span><span class="ptab">检查</span></div>
    <div class="prop-align"><div class="align-btn">⬓</div><div class="align-btn">⬒</div><div class="align-btn active-align">⬔</div><div class="align-divider"></div><div class="align-btn">⬕</div><div class="align-btn">⬗</div></div>
    <div class="prop-section">${field("W", "322", "H", "110")}${field("X", "1244", "Y", "18")}${field("↺", "0°", "⌐", "12")}</div>
    <div class="prop-section"><div class="prop-section-head"><span>自动布局</span><span class="prop-section-icon">−</span></div>${field("→", "12px", "⊡", "14 / 8")}</div>
    <div class="prop-section"><div class="prop-section-head"><span>填充</span><span class="prop-section-icon">+</span></div><div class="fill-row"><div class="fill-preview" style="background:#fff"></div><span class="fill-hex">FFFFFF</span><span class="fill-pct">100%</span></div></div>
    <div class="prop-section"><div class="prop-section-head"><span>描边</span><span class="prop-section-icon">+</span></div><div class="fill-row"><span class="prop-empty">无描边</span></div></div>
    <div class="prop-section"><div class="prop-section-head"><span>效果</span><span class="prop-section-icon">+</span></div><div class="effect-row"><div class="effect-dot"></div><span>投影</span></div></div>
    <div class="prop-section"><div class="prop-section-head"><span>导出</span><span class="prop-section-icon">+</span></div></div>
   </div>
  </div>
 </div><div class="depth-right"></div></div></div>
</div>
<div class="outro-layer"><svg class="full" viewBox="0 0 1920 1080">
  <g transform="translate(880,310) scale(0.8421)">${logo(2.4)}</g>
  <rect class="url-border" x="${960 - urlW / 2}" y="688" width="${urlW}" height="40" rx="20" fill="none" stroke="#3C3C3C" stroke-width="1.5" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/>
  <rect class="url-bg" x="${960 - urlW / 2}" y="688" width="${urlW}" height="40" rx="20" fill="#2C2C2C" opacity="0"/>
  <text class="url-text" x="960" y="713.5" text-anchor="middle" fill="#868686" font-size="16" font-weight="400" opacity="0" style="font-family:var(--kit-font)">${esc(content.url)}</text>
 </svg>
 <div class="outro-tagline">${esc(content.tagline)}</div>
</div>
<div class="outro-fade"></div>`;

  const q = (s) => stage.querySelector(s);
  const qa = (s) => Array.from(stage.querySelectorAll(s));
  const intro = q(".intro-layer"), outro = q(".outro-layer");
  const introStrokes = Array.from(intro.querySelectorAll(".lg-stroke"));
  const introFills = Array.from(intro.querySelectorAll(".lg-fill"));
  const outroStrokes = Array.from(outro.querySelectorAll(".lg-stroke"));
  const outroFills = Array.from(outro.querySelectorAll(".lg-fill"));
  const scene = q(".scene"), wrap = q(".card-wrapper"), glow = q(".card-glow");
  const input = q(".hg-cinput");
  const chars = KIT.splitChars(q(".outro-tagline"));

  const tl = SLATE.timeline();

  // —— 开场：标志描边 + 填色 ——
  tl.tween(introStrokes, { attr: { "stroke-dashoffset": 0 } }, { at: K(0.3), dur: K(0.9), ease: "inOutCubic", each: K(0.12) });
  tl.tween(introFills, { opacity: [0, 1] }, { at: K(1.2), dur: K(0.5), ease: "outCubic", each: K(0.08) });
  tl.tween(introStrokes, { opacity: 0 }, { at: K(1.6), dur: K(0.4), ease: "outQuad" });
  tl.tween(intro, { scale: 0.7, opacity: 0 }, { at: K(2.1), dur: K(0.5), ease: "inCubic" });

  // —— 界面透视翻入 ——
  tl.tween(scene, { opacity: [0, 1] }, { at: K(2.3), dur: K(0.7), ease: "outQuad" });
  tl.tween(wrap, { rotateX: [35, 14], rotateY: [-30, -18], z: [-900, 0] }, { at: K(2.3), dur: K(1.8), ease: "outQuart" });
  tl.tween(glow, { opacity: [0, 1] }, { at: K(2.6), dur: K(1.5), ease: "outQuad" });
  tl.tween(q(".fig-toolbar"), { y: [-16, 0], opacity: [0, 1] }, { at: K(2.9), dur: K(0.6), ease: "outCubic" });
  tl.tween(q(".fig-layers"), { x: [-24, 0], opacity: [0, 1] }, { at: K(3.05), dur: K(0.6), ease: "outCubic" });
  tl.tween(q(".fig-props"), { x: [24, 0], opacity: [0, 1] }, { at: K(3.15), dur: K(0.6), ease: "outCubic" });
  tl.tween(q(".artboard"), { scale: [0.94, 1], opacity: [0, 1] }, { at: K(3.25), dur: K(0.8), ease: "outCubic" });
  tl.tween(qa(".layer-item"), { x: [-8, 0], opacity: [0, 1] }, { at: K(3.3), dur: K(0.4), ease: "outCubic", each: K(0.04) });
  tl.tween(qa(".prop-section"), { opacity: [0, 1] }, { at: K(3.4), dur: K(0.4), ease: "outQuad", each: K(0.05) });
  tl.tween(qa(".art-piece"), { y: [10, 0], opacity: [0, 1] }, { at: K(3.6), dur: K(0.6), ease: "outCubic", each: K(0.1) });

  // —— 缓慢转动，选中卡片并输入 ——
  tl.tween(wrap, { rotateX: 6, rotateY: 10 }, { at: K(4.1), dur: K(4.1), ease: "inOutSine" });
  tl.tween(q(".selected-layer"), { backgroundColor: ["rgba(24,160,251,0)", "rgba(24,160,251,0.18)"] }, { at: K(5.0), dur: K(0.3), ease: "outQuad" });
  tl.tween(q(".selection-ring"), { opacity: [0, 1], scale: [1.08, 1] }, { at: K(5.0), dur: K(0.5), ease: "outBack(1.7)" });
  tl.tween(q(".sel-label"), { opacity: [0, 1], y: [-4, 0] }, { at: K(5.2), dur: K(0.4), ease: "outCubic" });
  const prompt = Array.from(String(content.prompt));
  tl.call((p) => {
    if (p <= 0) { input.textContent = content.placeholder; input.classList.remove("typing"); return; }
    const n = Math.round(p * prompt.length);
    input.textContent = prompt.slice(0, n).join("") + (p < 1 ? "|" : "");
    input.classList.add("typing");
  }, { at: K(5.6), dur: K(1.6), ease: "linear" });

  // —— 界面退远 ——
  tl.tween(wrap, { rotateX: 0, rotateY: 0 }, { at: K(8.2), dur: K(0.6), ease: "inOutCubic" });
  tl.tween(wrap, { z: -1200 }, { at: K(8.7), dur: K(0.7), ease: "inCubic" });
  tl.tween(scene, { opacity: 0 }, { at: K(8.8), dur: K(0.6), ease: "inQuad" });
  tl.tween(glow, { opacity: 0 }, { at: K(8.7), dur: K(0.5), ease: "inQuad" });

  // —— 收尾：标志重建 + 标语 + 网址 ——
  tl.tween(outroStrokes, { attr: { "stroke-dashoffset": 0 } }, { at: K(9.4), dur: K(0.8), ease: "inOutCubic", each: K(0.1) });
  tl.tween(outroFills, { opacity: [0, 1] }, { at: K(10.0), dur: K(0.5), ease: "outCubic", each: K(0.07) });
  tl.tween(outroStrokes, { opacity: 0 }, { at: K(10.4), dur: K(0.4), ease: "outQuad" });
  tl.tween(chars, { opacity: [0, 1], y: [14, 0] }, { at: K(10.5), dur: K(0.5), ease: "outCubic", each: K(0.035) });
  tl.tween(q(".url-border"), { attr: { "stroke-dashoffset": 0 } }, { at: K(11.2), dur: K(0.6), ease: "inOutCubic" });
  tl.tween(q(".url-bg"), { opacity: [0, 1] }, { at: K(11.6), dur: K(0.4), ease: "outQuad" });
  tl.tween(q(".url-text"), { opacity: [0, 1] }, { at: K(11.7), dur: K(0.4), ease: "outQuad" });

  // —— 黑场 ——
  tl.tween(q(".outro-fade"), { opacity: [0, 1] }, { at: exitAt(0.8), dur: 0.8, ease: "inQuad" });
  return tl;
};
