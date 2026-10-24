// canvas.js — 空间画布：dpr 适配、底图 contain、归一化 bbox 热区、点选、2× 导出 PNG。
// 坐标契约：bbox 一律为相对原照片的归一化 [x,y,w,h]（0—1）。

const COLORS = {
  ok: '#4F7A63',
  conditional: '#A9762B',
  blocked: '#B0453B',
  unknown: '#8C857B',
  accent: '#D2603A',
};

const FONT_STACK =
  '"Inter","SF Pro Text",-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const MONO_STACK = '"SF Mono",ui-monospace,Consolas,monospace';
const WATERMARK = '猫角落 corner. · L1 交付 · 以尺寸条件为准';

let canvasEl = null;
let ctx2d = null;
let shellEl = null;
let hintEl = null;

let dpr = 1;
let cw = 0;
let ch = 0;

let image = null;
let imageW = 0;
let imageH = 0;
let fit = { x: 0, y: 0, w: 0, h: 0 };
let zoomLevel = 1;

let regions = [];
let annotations = [];
let activeId = null;
let hoverId = null;
let marker = null;

let pickMode = false;
let pickHandler = null;

let bound = false;
let resizeObserver = null;
let resizeQueued = false;

/* ------------------------------------------------------------------ 基础 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundRect(g, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  if (typeof g.roundRect === 'function') {
    g.roundRect(x, y, w, h, radius);
    return;
  }
  g.moveTo(x + radius, y);
  g.lineTo(x + w - radius, y);
  g.arcTo(x + w, y, x + w, y + radius, radius);
  g.lineTo(x + w, y + h - radius);
  g.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  g.lineTo(x + radius, y + h);
  g.arcTo(x, y + h, x, y + h - radius, radius);
  g.lineTo(x, y + radius);
  g.arcTo(x, y, x + radius, y, radius);
  g.closePath();
}

function colorOf(item) {
  if (item.kind === 'annotation') return COLORS.accent;
  if (item.verdict === 'ok') return COLORS.ok;
  if (item.verdict === 'conditional') return COLORS.conditional;
  if (item.verdict === 'blocked') return COLORS.blocked;
  return COLORS.unknown;
}

function toHexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function overlayList() {
  const list = [];
  regions.forEach((region, index) => {
    if (!region || !Array.isArray(region.bbox) || region.bbox.length < 4) return;
    list.push({
      kind: 'region',
      id: region.id || 'r' + (index + 1),
      label: region.label || '区域',
      note: region.why || region.risk || '',
      verdict: region.verdict || 'unknown',
      bbox: region.bbox,
      num: '',
    });
  });
  annotations.forEach((annotation, index) => {
    if (!annotation || !Array.isArray(annotation.bbox) || annotation.bbox.length < 4) return;
    list.push({
      kind: 'annotation',
      id: annotation.id == null ? 'a' + (index + 1) : String(annotation.id),
      label: annotation.label || '标注',
      note: annotation.note || '',
      verdict: 'accent',
      bbox: annotation.bbox,
      num: '',
    });
  });
  // 同一屏内统一连续编号，避免 L0 区域与 L1 标注重复出现 1、2
  list.forEach((item, index) => {
    item.num = String(index + 1);
  });
  return list;
}

/* ------------------------------------------------------------------ 尺寸 */

function imageRect() {
  if (!image) return { x: 0, y: 0, w: 0, h: 0 };
  const w = fit.w * zoomLevel;
  const h = fit.h * zoomLevel;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function computeFit() {
  if (!image || imageW <= 0 || imageH <= 0) {
    fit = { x: 0, y: 0, w: 0, h: 0 };
    return;
  }
  const padding = clamp(Math.min(cw, ch) * 0.05, 10, 28);
  const availW = Math.max(20, cw - padding * 2);
  const availH = Math.max(20, ch - padding * 2);
  const scale = Math.min(availW / imageW, availH / imageH);
  fit = {
    x: (cw - imageW * scale) / 2,
    y: (ch - imageH * scale) / 2,
    w: imageW * scale,
    h: imageH * scale,
  };
}

function resize() {
  if (!canvasEl) return false;
  const target = shellEl || canvasEl.parentElement;
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 8 || height < 8) return false;

  cw = width;
  ch = height;
  dpr = clamp(window.devicePixelRatio || 1, 1, 3);

  const pxW = Math.round(width * dpr);
  const pxH = Math.round(height * dpr);
  if (canvasEl.width !== pxW || canvasEl.height !== pxH) {
    canvasEl.width = pxW;
    canvasEl.height = pxH;
  }
  // 注意：CSS 已让 #scene-canvas 宽高 100%，这里只改位图分辨率，不改显示尺寸。
  computeFit();
  draw();
  return true;
}

function scheduleResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  const run = () => {
    resizeQueued = false;
    if (!resize()) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

/* ------------------------------------------------------------------ 绘制 */

function localPoint(ev) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function bboxRect(item, rect) {
  const bbox = item.bbox;
  const x = rect.x + clamp(Number(bbox[0]) || 0, 0, 1) * rect.w;
  const y = rect.y + clamp(Number(bbox[1]) || 0, 0, 1) * rect.h;
  const w = Math.max(6, clamp(Number(bbox[2]) || 0, 0, 1) * rect.w);
  const h = Math.max(6, clamp(Number(bbox[3]) || 0, 0, 1) * rect.h);
  return { x, y, w, h };
}

/**
 * 通用热区绘制：屏幕与导出共用。
 * 画布上只画「序号圆点 + ≤6 字短标签」，标签做矩形避让；放不下就只留圆点。
 * @param {CanvasRenderingContext2D} g
 * @param {object} item
 * @param {{x:number,y:number,w:number,h:number}} rect 图片绘制区
 * @param {{highlight?:boolean, static?:boolean, short?:boolean, noLabel?:boolean,
 *          labelRects?:Array<{x:number,y:number,w:number,h:number}>, boxes?:Array<object>}} opts
 */
function paintOverlay(g, item, rect, opts = {}) {
  const box = bboxRect(item, rect);
  const color = colorOf(item);
  const highlight = Boolean(opts.highlight) && !opts.static;
  const dashed = item.verdict === 'unknown';

  g.save();
  roundRect(g, box.x, box.y, box.w, box.h, Math.min(12, Math.max(4, Math.min(box.w, box.h) * 0.12)));

  if (highlight) {
    g.shadowColor = toHexAlpha(color, 0.65);
    g.shadowBlur = 16;
  }
  g.fillStyle = toHexAlpha(color, highlight ? 0.3 : 0.16);
  g.fill();
  g.shadowBlur = 0;

  g.lineWidth = highlight ? 2.5 : 1.75;
  g.strokeStyle = color;
  if (dashed) g.setLineDash([6, 4]);
  g.stroke();
  g.setLineDash([]);

  // 序号圆点（框内左上角，避免出界）
  const radius = highlight ? 12 : 10;
  const dotX = box.x + radius + 3;
  const dotY = box.y + radius + 3;
  g.beginPath();
  g.arc(dotX, dotY, radius, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(255,255,255,.85)';
  g.stroke();
  g.fillStyle = '#FFFFFF';
  g.font = `700 11px ${MONO_STACK}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(item.num, dotX, dotY + 0.5);

  // 标签：短标签 + 候选位置矩形避让
  if (opts.noLabel) {
    g.restore();
    return;
  }
  g.font = `600 12px ${FONT_STACK}`;
  const labelText = opts.short ? shortLabel(item.label) : String(item.label || '');
  const chipH = 22;
  const chipW = Math.min(rect.w - 4, g.measureText(labelText).width + 16);
  const maxX = rect.x + rect.w - chipW - 2;
  const maxY = rect.y + rect.h - chipH - 2;
  const clampX = (v) => Math.max(rect.x + 2, Math.min(maxX, v));
  const placed = Array.isArray(opts.labelRects) ? opts.labelRects : [];
  const others = Array.isArray(opts.boxes) ? opts.boxes.filter((b) => b.id !== item.id) : [];

  const candidates = [
    { x: clampX(box.x), y: box.y - chipH - 6 },
    { x: clampX(box.x), y: box.y + box.h + 6 },
    { x: clampX(box.x), y: box.y + 4 },
    { x: clampX(box.x), y: box.y + box.h - chipH - 4 },
    { x: clampX(box.x + box.w - chipW), y: box.y - chipH - 6 },
    { x: clampX(box.x + box.w - chipW), y: box.y + box.h + 6 },
    { x: box.x + box.w + 6, y: box.y },
    { x: box.x - chipW - 6, y: box.y },
  ];

  let chip = null;
  for (const candidate of candidates) {
    const next = { x: candidate.x, y: candidate.y, w: chipW, h: chipH };
    if (next.x < rect.x + 2 || next.y < rect.y + 2 || next.x + next.w > rect.x + rect.w - 2) continue;
    if (next.y + next.h > rect.y + rect.h - 2) continue;
    if (placed.some((p) => rectsIntersect(next, p, 2))) continue;
    if (others.some((b) => rectsIntersect(next, b, 4))) continue;
    chip = next;
    break;
  }

  if (chip) {
    placed.push(chip);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    roundRect(g, chip.x, chip.y, chip.w, chip.h, 6);
    g.fillStyle = toHexAlpha(color, 0.95);
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.fillText(labelText, chip.x + 8, chip.y + chip.h / 2 + 0.5);
  }

  // 选中/悬停时补一条备注（同样限制在图片区内）
  if (highlight && item.note) {
    const noteText = String(item.note);
    g.font = `400 12px ${FONT_STACK}`;
    let noteW = Math.min(280, g.measureText(noteText).width + 18);
    const noteH = 24;
    let noteY = box.y + box.h + 6;
    if (noteY + noteH > rect.y + rect.h - 2) noteY = box.y - noteH - 6;
    noteY = Math.max(rect.y + 2, Math.min(rect.y + rect.h - noteH - 2, noteY));
    const noteX = Math.max(rect.x + 2, Math.min(rect.x + rect.w - noteW - 2, box.x));
    let drawText = noteText;
    while (noteW > 40 && g.measureText(drawText).width + 18 > noteW) {
      drawText = drawText.slice(0, -2) + '…';
      if (drawText.length < 3) break;
    }
    roundRect(g, noteX, noteY, noteW, noteH, 6);
    g.fillStyle = 'rgba(20,17,16,.86)';
    g.fill();
    g.fillStyle = '#F5EFE8';
    g.fillText(drawText, noteX + 9, noteY + noteH / 2 + 0.5);
  }

  g.restore();
}

function rectsIntersect(a, b, pad = 0) {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

/** 画布上只保留 ≤6 字，完整标题放 #canvas-legend */
function shortLabel(text) {
  const value = String(text == null ? '' : text).replace(/\s+/g, '');
  if (!value) return '';
  return value.length > 6 ? value.slice(0, 6) : value;
}

function drawMarker(g, point) {
  if (!point) return;
  g.save();
  g.strokeStyle = COLORS.accent;
  g.lineWidth = 2;
  g.shadowColor = 'rgba(210,96,58,.5)';
  g.shadowBlur = 10;
  g.beginPath();
  g.arc(point.x, point.y, 13, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(point.x - 20, point.y);
  g.lineTo(point.x - 5, point.y);
  g.moveTo(point.x + 5, point.y);
  g.lineTo(point.x + 20, point.y);
  g.moveTo(point.x, point.y - 20);
  g.lineTo(point.x, point.y - 5);
  g.moveTo(point.x, point.y + 5);
  g.lineTo(point.x, point.y + 20);
  g.stroke();
  g.beginPath();
  g.arc(point.x, point.y, 2.6, 0, Math.PI * 2);
  g.fillStyle = COLORS.accent;
  g.fill();
  g.restore();
}

function draw() {
  if (!ctx2d || !canvasEl || cw <= 0 || ch <= 0) return;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, cw, ch);

  const rect = imageRect();
  if (image) {
    ctx2d.imageSmoothingEnabled = true;
    ctx2d.imageSmoothingQuality = 'high';
    ctx2d.drawImage(image, rect.x, rect.y, rect.w, rect.h);
    ctx2d.strokeStyle = 'rgba(245,239,232,.16)';
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }

  const list = overlayList();
  const boxes = list.map((item) => Object.assign({ id: item.id }, bboxRect(item, rect)));
  const labelRects = [];
  list.forEach((item) => {
    const highlight = item.id === activeId || item.id === hoverId;
    paintOverlay(ctx2d, item, rect, { highlight, short: true, labelRects, boxes });
  });

  if (marker) drawMarker(ctx2d, marker);
}

/* ------------------------------------------------------------------ 图例 */

function syncLegendActive() {
  const legend = document.getElementById('canvas-legend');
  if (!legend) return;
  Array.from(legend.children).forEach((chip) => {
    chip.setAttribute('aria-pressed', chip.dataset.id === activeId ? 'true' : 'false');
  });
}

function updateLegend() {
  const legend = document.getElementById('canvas-legend');
  if (!legend) return;
  const list = overlayList();
  legend.textContent = '';
  legend.dataset.visible = list.length ? 'true' : 'false';
  if (!list.length) return;
  list.forEach((item) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'legend-chip';
    chip.dataset.id = String(item.id);
    chip.dataset.verdict = item.verdict === 'accent' ? 'unknown' : item.verdict;
    chip.setAttribute('aria-pressed', item.id === activeId ? 'true' : 'false');
    const num = document.createElement('span');
    num.className = 'legend-num';
    num.textContent = item.num;
    const label = document.createElement('span');
    label.textContent = item.label || '';
    chip.append(num, label);
    chip.addEventListener('click', () => {
      activeId = activeId === String(item.id) ? null : String(item.id);
      draw();
      syncLegendActive();
    });
    chip.addEventListener('mouseenter', () => {
      hoverId = String(item.id);
      draw();
    });
    chip.addEventListener('mouseleave', () => {
      if (hoverId === String(item.id)) {
        hoverId = null;
        draw();
      }
    });
    legend.append(chip);
  });
}

/* ------------------------------------------------------------------ 交互 */

function eventToNormalized(ev) {
  const rect = canvasEl ? canvasEl.getBoundingClientRect() : null;
  if (!rect) return null;
  const point = localPoint(ev);
  const imgRect = imageRect();
  if (point.x < imgRect.x || point.x > imgRect.x + imgRect.w || point.y < imgRect.y || point.y > imgRect.y + imgRect.h) {
    return null;
  }
  return {
    x: point.x,
    y: point.y,
    nx: clamp((point.x - imgRect.x) / imgRect.w, 0, 1),
    ny: clamp((point.y - imgRect.y) / imgRect.h, 0, 1),
  };
}

function hitTest(px, py) {
  const rect = imageRect();
  if (!image) return null;
  const list = overlayList();
  for (let i = list.length - 1; i >= 0; i--) {
    const box = bboxRect(list[i], rect);
    if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h) return list[i];
  }
  return null;
}

function setHint(show, text) {
  if (!hintEl) return;
  hintEl.dataset.show = show ? 'true' : 'false';
  if (text != null) hintEl.textContent = text;
}

function handleMove(ev) {
  if (!canvasEl) return;
  if (pickMode) {
    canvasEl.style.cursor = 'crosshair';
    return;
  }
  const point = localPoint(ev);
  const hit = hitTest(point.x, point.y);
  const nextHover = hit ? hit.id : null;
  canvasEl.style.cursor = hit ? 'pointer' : '';
  if (nextHover !== hoverId) {
    hoverId = nextHover;
    draw();
  }
}

function handleLeave() {
  if (hoverId != null) {
    hoverId = null;
    draw();
  }
}

function handleClick(ev) {
  if (!canvasEl) return;
  if (pickMode) {
    const picked = eventToNormalized(ev);
    if (!picked) return;
    marker = { x: picked.x, y: picked.y };
    draw();
    if (typeof pickHandler === 'function') pickHandler({ x: picked.x, y: picked.y, nx: picked.nx, ny: picked.ny });
    return;
  }
  // 非点选模式：点热区只做轻微选中反馈
  const point = localPoint(ev);
  const hit = hitTest(point.x, point.y);
  if (hit) {
    activeId = hit.id;
    draw();
    syncLegendActive();
  }
}

function bind() {
  canvasEl.addEventListener('mousemove', handleMove);
  canvasEl.addEventListener('mouseleave', handleLeave);
  canvasEl.addEventListener('click', handleClick);

  const target = shellEl || canvasEl.parentElement;
  if (target && typeof ResizeObserver === 'function') {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => scheduleResize());
    resizeObserver.observe(target);
  }
  window.addEventListener('resize', scheduleResize);
}

/* ------------------------------------------------------------------ 公共 API */

export function initCanvas() {
  const el = document.getElementById('scene-canvas');
  if (!el) return null;
  if (canvasEl !== el) {
    canvasEl = el;
    ctx2d = el.getContext('2d');
    shellEl = el.parentElement;
    hintEl = document.getElementById('canvas-hint');
    bound = false;
  }
  if (!bound) {
    bind();
    bound = true;
  }
  scheduleResize();
  return { el: canvasEl };
}

/**
 * 绘制底图（同源 URL）。CSS px 尺寸由容器决定；图片 contain 居中。
 * @returns {Promise<{width:number,height:number}|null>}
 */
export function setImage(url, { width, height } = {}) {
  if (!canvasEl) initCanvas();
  if (!url) {
    clear();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      image = img;
      imageW = Number(width) || img.naturalWidth || img.width || 0;
      imageH = Number(height) || img.naturalHeight || img.height || 0;
      if (!imageW || !imageH) {
        image = null;
        reject(new Error('画布图片尺寸异常'));
        return;
      }
      activeId = null;
      hoverId = null;
      marker = null;
      zoomLevel = 1;
      let attempts = 0;
      const settle = () => {
        if (resize()) {
          draw();
          resolve({ width: imageW, height: imageH });
          return;
        }
        attempts++;
        if (attempts > 60) {
          draw();
          resolve({ width: imageW, height: imageH });
          return;
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(settle);
        else setTimeout(settle, 40);
      };
      settle();
    };
    img.onerror = () => reject(new Error('画布图片加载失败'));
    img.src = url;
  });
}

export function renderOverlays({ regions: nextRegions = [], annotations: nextAnnotations = [], activeId: nextActive = null } = {}) {
  regions = Array.isArray(nextRegions) ? nextRegions : [];
  annotations = Array.isArray(nextAnnotations) ? nextAnnotations : [];
  activeId = nextActive == null ? null : String(nextActive);
  if (activeId != null) {
    const found = overlayList().find((item) => item.id === activeId);
    if (!found) activeId = null;
  }
  draw();
  updateLegend();
}

export function setPickMode(on) {
  pickMode = Boolean(on);
  const stage = document.getElementById('canvas-stage');
  if (stage) stage.dataset.pick = pickMode ? 'true' : 'false';
  if (canvasEl) canvasEl.style.cursor = pickMode ? 'crosshair' : '';
  if (pickMode) setHint(true, '点照片上你想放的位置，我会专门看这里');
  else setHint(false, '');
  if (!pickMode) {
    hoverId = null;
  }
  draw();
}

export function onPick(fn) {
  pickHandler = typeof fn === 'function' ? fn : null;
}

export function zoom(dir) {
  if (dir === 'fit') zoomLevel = 1;
  else if (dir === 'in') zoomLevel = clamp(zoomLevel * 1.35, 1, 4);
  else if (dir === 'out') zoomLevel = clamp(zoomLevel / 1.35, 1, 4);
  draw();
  return zoomLevel;
}

export function clear() {
  image = null;
  imageW = 0;
  imageH = 0;
  fit = { x: 0, y: 0, w: 0, h: 0 };
  regions = [];
  annotations = [];
  activeId = null;
  hoverId = null;
  marker = null;
  zoomLevel = 1;
  setHint(false, '');
  draw();
  updateLegend();
}

/* ------------------------------------------------------------------ 导出 */

function truncateWidth(g, text, maxWidth) {
  let out = String(text || '');
  if (g.measureText(out).width <= maxWidth) return out;
  while (out.length > 2 && g.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
  return out + '…';
}

/**
 * 2× 白底导出：照片 + 标注 + 图例 + 右下角分级水印。
 * @returns {string} PNG dataURL
 */
export function exportPNG() {
  const W = 1360;
  const PAD = 60;
  const HEAD_H = 132;
  const overlays = overlayList();
  const hasImage = Boolean(image);

  const maxImgW = W - PAD * 2;
  const maxImgH = 820;
  let drawW = 0;
  let drawH = 0;
  if (hasImage) {
    const scale = Math.min(maxImgW / imageW, maxImgH / imageH);
    drawW = Math.max(1, Math.round(imageW * scale));
    drawH = Math.max(1, Math.round(imageH * scale));
  } else {
    drawW = maxImgW;
    drawH = 260;
  }

  const legendRows = Math.max(1, overlays.length);
  const legendH = 56 + legendRows * 46;
  const H = HEAD_H + drawH + 32 + legendH + 40 + 96;

  const out = document.createElement('canvas');
  out.width = W * 2;
  out.height = H * 2;
  const g = out.getContext('2d');
  if (!g) throw new Error('导出失败：浏览器不支持 canvas');
  g.scale(2, 2);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, W, H);

  // 顶部品牌条
  g.fillStyle = '#FAF6F0';
  g.fillRect(0, 0, W, 6);
  g.fillStyle = '#D2603A';
  g.fillRect(0, 0, 132, 6);

  // 标题
  g.fillStyle = '#1C1917';
  g.font = `600 30px ${FONT_STACK}`;
  g.fillText('猫角落 corner. · 空间标注', PAD, 66);
  g.fillStyle = '#5A544C';
  g.font = `400 15px ${FONT_STACK}`;
  g.fillText('L1 · 可执行建议 · 尺寸条件写在图例里', PAD, 96);

  g.textAlign = 'right';
  g.fillStyle = '#8C857B';
  g.font = `400 13px ${MONO_STACK}`;
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  g.fillText(stamp, W - PAD, 66);
  g.fillText('以尺寸条件为准', W - PAD, 88);
  g.textAlign = 'left';

  // 图片
  const imgX = (W - drawW) / 2;
  const imgY = HEAD_H;
  g.fillStyle = '#141110';
  g.fillRect(imgX, imgY, drawW, drawH);
  if (hasImage) {
    g.drawImage(image, imgX, imgY, drawW, drawH);
    const rect = { x: imgX, y: imgY, w: drawW, h: drawH };
    const boxes = overlays.map((item) => Object.assign({ id: item.id }, bboxRect(item, rect)));
    const labelRects = [];
    overlays.forEach((item) => paintOverlay(g, item, rect, { static: true, short: false, labelRects, boxes }));
    g.strokeStyle = 'rgba(28,25,23,.12)';
    g.lineWidth = 1;
    g.strokeRect(imgX + 0.5, imgY + 0.5, drawW - 1, drawH - 1);
  } else {
    g.fillStyle = '#F3ECE2';
    g.fillRect(imgX, imgY, drawW, drawH);
    g.fillStyle = '#8C857B';
    g.font = `400 18px ${FONT_STACK}`;
    g.textAlign = 'center';
    g.fillText('还没有上传照片', W / 2, imgY + drawH / 2);
    g.textAlign = 'left';
  }

  // 图例
  let ly = imgY + drawH + 46;
  g.fillStyle = '#1C1917';
  g.font = `600 17px ${FONT_STACK}`;
  g.fillText('图例', PAD, ly);
  g.fillStyle = '#8C857B';
  g.font = `400 13px ${FONT_STACK}`;
  g.fillText('圆点编号与照片上的标注一一对应', PAD + 52, ly);
  ly += 26;

  if (!overlays.length) {
    g.fillStyle = '#8C857B';
    g.font = `400 14px ${FONT_STACK}`;
    g.fillText('这张图还没有标注。', PAD, ly + 18);
  }
  overlays.forEach((item) => {
    const color = colorOf(item);
    g.beginPath();
    g.arc(PAD + 12, ly + 9, 12, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.font = `700 12px ${MONO_STACK}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(item.num, PAD + 12, ly + 9.5);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    g.fillStyle = '#1C1917';
    g.font = `600 15px ${FONT_STACK}`;
    g.fillText(item.label, PAD + 34, ly + 14);
    const labelW = g.measureText(item.label).width;
    g.fillStyle = '#8C857B';
    g.font = `400 13px ${FONT_STACK}`;
    const verdict = item.kind === 'annotation' ? 'L1 标注' : L1_VERDICT[item.verdict] || '';
    g.fillText(verdict, PAD + 34 + labelW + 12, ly + 14);
    if (item.note) {
      g.fillStyle = '#5A544C';
      g.font = `400 13px ${FONT_STACK}`;
      g.fillText(truncateWidth(g, item.note, W - PAD * 2 - 40), PAD + 34, ly + 34);
    }
    ly += 46;
  });

  // 免责 + 水印
  const footY = H - 62;
  g.strokeStyle = 'rgba(28,25,23,.10)';
  g.beginPath();
  g.moveTo(PAD, footY - 30);
  g.lineTo(W - PAD, footY - 30);
  g.stroke();
  g.fillStyle = '#5A544C';
  g.font = `400 14px ${FONT_STACK}`;
  g.fillText('以交付时的尺寸条件为准，落地前请现场确认。', PAD, footY);

  g.textAlign = 'right';
  g.fillStyle = '#8C857B';
  g.font = `500 12px ${FONT_STACK}`;
  g.fillText(WATERMARK, W - PAD, H - 26);
  g.textAlign = 'left';

  const dataUrl = out.toDataURL('image/png');
  try {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `corner-${stamp}.png`;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } catch {
    /* 下载被拦截不影响返回 dataURL */
  }
  return dataUrl;
}

const L1_VERDICT = {
  ok: '能放',
  conditional: '有条件',
  blocked: '别放',
  unknown: '待确认',
  accent: '标注',
};

/* ------------------------------------------------ V3 改造前后对比 */

function loadCanvasImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('没有图片'));
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('对比图片加载失败'));
    img.src = url;
  });
}

function annotationItems(annotations) {
  return (Array.isArray(annotations) ? annotations : [])
    .filter((annotation) => annotation && Array.isArray(annotation.bbox) && annotation.bbox.length >= 4)
    .map((annotation, index) => ({
      kind: 'annotation',
      id: annotation.id == null ? 'a' + (index + 1) : String(annotation.id),
      label: annotation.label || '标注',
      note: annotation.note || '',
      verdict: 'accent',
      bbox: annotation.bbox,
      num: String(index + 1),
    }));
}

/**
 * 把「照片 + 标注」画进任意小 canvas（复用主画布 paintOverlay，不新写坐标系）。
 * @returns {Promise<{width:number,height:number}|null>}
 */
export async function renderPhotoThumb(canvasEl, { url, annotations = [] } = {}) {
  if (!canvasEl || !url) return null;
  const img = await loadCanvasImage(url);
  const cssW = Math.max(120, Math.round(canvasEl.clientWidth || 320));
  const cssH = Math.max(90, Math.round(canvasEl.clientHeight || cssW * 0.62));
  const ratio = clamp(window.devicePixelRatio || 1, 1, 3);
  canvasEl.width = Math.round(cssW * ratio);
  canvasEl.height = Math.round(cssH * ratio);
  const g = canvasEl.getContext('2d');
  if (!g) return null;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  g.fillStyle = '#F3ECE2';
  g.fillRect(0, 0, cssW, cssH);
  const scale = Math.min(cssW / img.naturalWidth, cssH / img.naturalHeight);
  const rect = {
    x: (cssW - img.naturalWidth * scale) / 2,
    y: (cssH - img.naturalHeight * scale) / 2,
    w: img.naturalWidth * scale,
    h: img.naturalHeight * scale,
  };
  g.drawImage(img, rect.x, rect.y, rect.w, rect.h);
  const items = annotationItems(annotations);
  const boxes = items.map((item) => Object.assign({ id: item.id }, bboxRect(item, rect)));
  const labelRects = [];
  items.forEach((item) => paintOverlay(g, item, rect, { static: true, short: true, labelRects, boxes }));
  return { width: cssW, height: cssH };
}

/**
 * 2× 白底「改造前后」拼图（标题 + 日期 + 两图 + 标注 + 总结 + 小字），返回 dataURL 并触发下载。
 */
export async function composeComparePNG({
  beforeUrl,
  afterUrl,
  annotations = [],
  title = '改造前后对比',
  summary = '按方案落地后的样子',
  dateLabel,
} = {}) {
  const [beforeImg, afterImg] = await Promise.all([loadCanvasImage(beforeUrl), loadCanvasImage(afterUrl)]);
  const W = 1360;
  const PAD = 56;
  const HEAD = 128;
  const GAP = 40;
  const panelW = Math.round((W - PAD * 2 - GAP) / 2);
  const panelH = 520;
  const H = HEAD + panelH + 150;

  const out = document.createElement('canvas');
  out.width = W * 2;
  out.height = H * 2;
  const g = out.getContext('2d');
  if (!g) throw new Error('导出失败：浏览器不支持 canvas');
  g.scale(2, 2);
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, W, H);

  const now = new Date();
  const stamp =
    dateLabel ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  g.fillStyle = '#1C1917';
  g.font = `600 30px ${FONT_STACK}`;
  g.fillText(title, PAD, 66);
  g.fillStyle = '#5A544C';
  g.font = `400 14px ${FONT_STACK}`;
  g.fillText('同一位置 · 改造前 / 改造后', PAD, 96);
  g.textAlign = 'right';
  g.fillStyle = '#8C857B';
  g.font = `400 13px ${MONO_STACK}`;
  g.fillText(stamp, W - PAD, 66);
  g.textAlign = 'left';

  const panelY = HEAD;
  const drawPanel = (img, x, label) => {
    g.fillStyle = '#F3ECE2';
    g.fillRect(x, panelY, panelW, panelH);
    const scale = Math.min(panelW / img.naturalWidth, panelH / img.naturalHeight);
    const rect = {
      x: x + (panelW - img.naturalWidth * scale) / 2,
      y: panelY + (panelH - img.naturalHeight * scale) / 2,
      w: img.naturalWidth * scale,
      h: img.naturalHeight * scale,
    };
    g.drawImage(img, rect.x, rect.y, rect.w, rect.h);
    g.strokeStyle = 'rgba(28,25,23,.12)';
    g.lineWidth = 1;
    g.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    g.font = `600 15px ${FONT_STACK}`;
    const textW = g.measureText(label).width;
    roundRect(g, x + 14, panelY + 14, textW + 24, 30, 8);
    g.fillStyle = 'rgba(28,25,23,.78)';
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.fillText(label, x + 26, panelY + 34);
    return rect;
  };
  const beforeRect = drawPanel(beforeImg, PAD, '改造前');
  drawPanel(afterImg, PAD + panelW + GAP, '改造后');

  const items = annotationItems(annotations);
  const boxes = items.map((item) => Object.assign({ id: item.id }, bboxRect(item, beforeRect)));
  const labelRects = [];
  items.forEach((item) => paintOverlay(g, item, beforeRect, { static: true, short: false, labelRects, boxes }));

  g.fillStyle = '#D2603A';
  g.font = `600 34px ${FONT_STACK}`;
  g.textAlign = 'center';
  g.fillText('→', W / 2, panelY + panelH / 2);
  g.textAlign = 'left';

  const summaryY = HEAD + panelH + 58;
  g.fillStyle = '#1C1917';
  g.font = `600 18px ${FONT_STACK}`;
  g.fillText(summary || '按方案落地后的样子', PAD, summaryY);

  g.strokeStyle = 'rgba(28,25,23,.10)';
  g.beginPath();
  g.moveTo(PAD, H - 58);
  g.lineTo(W - PAD, H - 58);
  g.stroke();
  g.fillStyle = '#5A544C';
  g.font = `400 13px ${FONT_STACK}`;
  g.fillText('以交付时的尺寸条件为准，落地前请现场确认。', PAD, H - 28);
  g.textAlign = 'right';
  g.fillStyle = '#8C857B';
  g.font = `500 12px ${FONT_STACK}`;
  g.fillText('猫角落 corner.', W - PAD, H - 28);
  g.textAlign = 'left';

  const dataUrl = out.toDataURL('image/png');
  try {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `corner-compare-${stamp}.png`;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } catch {
    /* 下载被拦截不影响返回 dataURL */
  }
  return dataUrl;
}
