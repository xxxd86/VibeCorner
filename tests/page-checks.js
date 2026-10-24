// tests/page-checks.js
// 在真实页面里执行的浏览器端脚本（由 tests/cdp-probe.mjs --script 注入，外层包 async 函数体）。
// 目的：验证 DoD 第 1/2 条里无法靠截图证明的部分：
//   1) 导出标注图 PNG：window.__corner.canvas.exportPNG() 返回合法 dataURL；点击导出按钮触发 download
//   2) 画布点选：进入点选模式后在 #scene-canvas 上派发 click，应得到 AI 追问（feed 增加）
// 约定：以 `return JSON.stringify(out);` 结束（作为 async 函数体执行）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: [] };
const C = window.__corner || null;
out.hasCorner = !!C;
if (!C) return JSON.stringify(out);

// ---- 1. exportPNG 直接调用
try {
  const dataUrl = C.canvas.exportPNG();
  const info = {
    isDataUrl: typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,'),
    length: typeof dataUrl === 'string' ? dataUrl.length : 0,
    approxBytes: typeof dataUrl === 'string' ? Math.round(((dataUrl.length - 'data:image/png;base64,'.length) * 3) / 4) : 0,
  };
  // 解析 PNG IHDR 宽高（验证导出为 2 倍图，例如 2720×2292）
  if (info.isDataUrl) {
    try {
      const bin = atob(dataUrl.slice('data:image/png;base64,'.length));
      const b = (i) => bin.charCodeAt(i) & 0xff;
      const be32 = (i) => (b(i) << 24) | (b(i + 1) << 16) | (b(i + 2) << 8) | b(i + 3);
      info.png = { width: be32(16), height: be32(20) };
    } catch (e) { info.png = { error: String(e) }; }
  }
  out.export = info;
} catch (e) {
  out.export = { error: String((e && e.message) || e) };
}

// ---- 2. 导出按钮 → 触发 download（hook a.click）
const exportBtn = document.getElementById('btn-export');
out.exportBtn = exportBtn ? { disabled: exportBtn.disabled, text: (exportBtn.textContent || '').trim() } : null;
window.__qaDownloads = [];
const origClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  try { if (this.download) window.__qaDownloads.push({ download: this.download, hrefLen: (this.href || '').length, isPng: /^data:image\/png/.test(this.href || '') }); } catch (e) { /* noop */ }
  return origClick.apply(this, arguments);
};
if (exportBtn && !exportBtn.disabled) {
  exportBtn.click();
  await sleep(1500);
}
out.downloads = window.__qaDownloads;

// ---- 3. 画布点选 → AI 追问
const pickBtn = document.getElementById('btn-pick-mode');
const canvas = document.getElementById('scene-canvas');
const count = (sel) => document.querySelectorAll(sel).length;
out.beforePick = { feed: count('.feed-item'), cards: count('.card'), stage: (document.getElementById('stage-chip') || {}).textContent || '' };
if (pickBtn && canvas) {
  if (pickBtn.getAttribute('aria-pressed') !== 'true') pickBtn.click();
  await sleep(350);
  const r = canvas.getBoundingClientRect();
  const x = r.left + r.width * 0.5;
  const y = r.top + r.height * 0.55;
  for (const type of ['mousedown', 'mouseup', 'click']) {
    canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }));
  }
  out.pick = { x: Math.round(x), y: Math.round(y), pickMode: pickBtn.getAttribute('aria-pressed'), canvasRect: Math.round(r.width) + 'x' + Math.round(r.height) };
  const t0 = Date.now();
  let changed = false;
  while (Date.now() - t0 < 30000) {
    await sleep(500);
    const banner = ((document.getElementById('dev-error-banner') || {}).textContent || '').trim();
    if (count('.feed-item') > out.beforePick.feed || count('.card') > out.beforePick.cards || banner) { changed = true; break; }
  }
  await sleep(800);
  out.afterPick = {
    changed,
    feed: count('.feed-item'), cards: count('.card'),
    stage: (document.getElementById('stage-chip') || {}).textContent || '',
    banner: ((document.getElementById('dev-error-banner') || {}).textContent || '').trim().slice(0, 300),
    lastText: ((document.querySelector('.feed-item:last-child') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
} else {
  out.pick = { error: 'missing #btn-pick-mode 或 #scene-canvas' };
}

// 恢复原型，避免影响后续
HTMLAnchorElement.prototype.click = origClick;
return JSON.stringify(out);
