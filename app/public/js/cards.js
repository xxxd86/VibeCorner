// cards.js — 所有卡片：纯 DOM API 构建，动态文本一律 textContent（防注入）。
// 纯静态图标 SVG 允许 innerHTML。class 对齐 ui-shell 的 components.css。

import { evidenceById } from './api.js';
import { renderPhotoThumb } from './canvas.js';

export const DISCLAIMER_L1 = '以交付时的尺寸条件为准，落地前请现场确认。';
export const DISCLAIMER_L0 = '这是方向预览，不是摆放结论；关键尺寸补齐前不能判断能不能放下。';

const MEASURE_LABELS = {
  corridorWidth: '通道净宽',
  cornerWidthA: '墙角 A 边长',
  cornerWidthB: '墙角 B 边长',
  freeDepth: '可用进深',
  obstructionH: '遮挡物高度',
  ceilingFree: '上方净空',
  outletDist: '到最近插座',
  doorSwing: '门开合范围',
  windowDist: '到窗距离',
};

const KIT_TEXT = { new: '需要新买', reuse: '复用现有', mix: '复用 + 新买' };
const CONF_TEXT = { high: '把握较大', medium: '中等把握', low: '把握较小' };
const VERDICT_TEXT = {
  continue: '有条件继续',
  ok: '在尺寸条件下可以放',
  conditional: '有条件可放',
  blocked: '先别放这儿',
  not_supported: '当前条件不支持',
  insufficient: '信息不足',
  unknown: '还判断不了',
};
const VERDICT_CLASS = {
  continue: 'continue',
  ok: 'continue',
  conditional: 'insufficient',
  blocked: 'not_supported',
  not_supported: 'not_supported',
  insufficient: 'insufficient',
  unknown: 'insufficient',
};
const LIGHT_TEXT = { bright: '采光好', medium: '采光中等', dim: '偏暗' };

function notify(text) {
  try {
    document.dispatchEvent(new CustomEvent('corner:toast', { detail: { text: String(text || '') } }));
  } catch {
    /* ignore */
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  // V3.1 触控：卡片里所有按钮 ≥44px（「看这个区域」等次级操作不再 36px）
  if (tag === 'button') node.style.minHeight = '44px';
  return node;
}

/** 移动端断点：与 ui-shell 的 ≤899px 一致 */
function isMobileLayout() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 899px)').matches
  );
}

/** 按字符截断（中文按字算），超长加省略号 */
function clipText(text, maxLength) {
  const chars = Array.from(String(text || '').trim());
  if (chars.length <= maxLength) return chars.join('');
  return chars.slice(0, maxLength).join('') + '…';
}

function touchStyle(node, minHeight = 44) {
  if (node && node.style) node.style.minHeight = minHeight + 'px';
  return node;
}

function makeCard(type, extraClass) {
  const card = el('div', 'card' + (extraClass ? ' ' + extraClass : ''));
  card.dataset.type = type;
  return card;
}

function head(card, ...children) {
  const node = el('div', 'card-head');
  children.filter(Boolean).forEach((child) => node.append(child));
  card.append(node);
  return node;
}

function foot(card, disclaimer) {
  const node = el('div', 'card-foot');
  if (disclaimer) node.append(el('span', 'disclaimer', disclaimer));
  card.append(node);
  return node;
}

function footActions(footEl) {
  let actions = footEl.querySelector('.card-foot-actions');
  if (!actions) {
    actions = el('div', 'card-foot-actions');
    footEl.append(actions);
  }
  return actions;
}

function verdictEl(verdict) {
  const cls = VERDICT_CLASS[verdict] || 'insufficient';
  return el('span', 'verdict ' + cls, VERDICT_TEXT[verdict] || VERDICT_TEXT.unknown);
}

function fmtCm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 10) / 10);
}

function opText(op) {
  const map = { '>=': '≥', '>': '>', '<=': '≤', '<': '<', '=': '=' };
  return map[op] || op || '≥';
}

function measureLabel(key) {
  return MEASURE_LABELS[key] || key;
}

/* ============================================================ V2 证据徽章 */

/** 证据强度 → 用户可读来源类型 + CSS data-kind（CONTRACT-V2 §3.4 / ui-shell 约定） */
function basisMetaOf(evid) {
  if (!evid) return null;
  const kind = String(evid.kind || '');
  const strength = String(evid.strength || '');
  if (kind === 'experience' || strength === 'weak') return { label: '经验值', kind: 'weak' };
  if (kind === 'guideline' || kind === 'consensus' || strength === 'consensus') {
    return { label: '专家共识', kind: 'consensus' };
  }
  if ((kind === 'study' || kind === 'review') && (strength === 'strong' || strength === 'moderate')) {
    return { label: strength === 'strong' ? '研究支持（强）' : '研究支持（中）', kind: strength };
  }
  if (strength === 'strong' || strength === 'moderate') {
    return { label: strength === 'strong' ? '研究支持（强）' : '研究支持（中）', kind: strength };
  }
  return null;
}

/**
 * 依据徽章。查不到证据就不渲染（返回 null），绝不出现空徽章。
 * 点开的弹层由 app.js 统一处理（读这些 data-*）。
 */
function basisBadge(basisId, honest) {
  if (!basisId) return null;
  const evid = evidenceById(basisId);
  if (!evid) return null;
  const meta = basisMetaOf(evid);
  if (!meta) return null;
  const badge = el('button', 'basis-badge', meta.label);
  badge.type = 'button';
  badge.dataset.basisId = String(basisId);
  badge.dataset.kind = meta.kind;
  badge.dataset.label = meta.label;
  badge.dataset.claim = evid.claim || '';
  badge.dataset.source = evid.source || '';
  badge.dataset.url = evid.url || '';
  badge.dataset.caveat = evid.caveat || '';
  badge.dataset.topic = evid.topic || '';
  badge.dataset.strength = evid.strength || '';
  if (honest) badge.dataset.honest = 'true';
  badge.setAttribute('aria-expanded', 'false');
  badge.title = evid.claim || '查看依据';
  return badge;
}

// 状态图标用内联 SVG（contract 明令禁止 emoji 当图标；CSS 负责 18px 圆形底色）
const CATFIT_STATUS = {
  pass: {
    svg: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.2 4.8 8.8 9.8 3.4"/></svg>',
    text: '通过',
    cls: 'status-pass',
  },
  warn: {
    svg: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v5M6 9.4v.01"/></svg>',
    text: '注意',
    cls: 'status-unknown',
  },
  fail: {
    svg: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>',
    text: '不满足',
    cls: 'status-fail',
  },
  unknown: {
    svg: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.3 4.3a1.8 1.8 0 1 1 2.4 1.7c-.4.2-.7.6-.7 1v.3M6 9.4v.01"/></svg>',
    text: '未知',
    cls: 'status-unknown',
  },
  // 不涉及：这次方案根本没用这项功能。绝不能算成「通过」（NA-RULE）
  na: {
    svg: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6"/></svg>',
    text: '不涉及',
    cls: 'status-na',
  },
};
const CATFIT_VERDICT = { good: '好位置', caution: '有条件', poor: '不建议', unknown: '信息不足' };

/* ================================================================== 质检卡 */

export function qualityCard(q, ctx = {}) {
  const data = q || {};
  const retake = data.status === 'retake';
  const scene = data.scene || {};
  const card = makeCard('quality', 'card-quality');
  card.dataset.collapsed = 'true';

  // 折叠态（移动端默认；桌面 CSS 会隐藏这块、强制显示 details）
  const collapsed = el('div', 'quality-collapsed');
  const foldTop = el('div', 'quality-collapsed-top');
  foldTop.style.display = 'flex';
  foldTop.style.alignItems = 'center';
  foldTop.style.gap = '8px';
  foldTop.style.width = '100%';
  foldTop.append(el('span', 'chip ' + (retake ? 'chip-warn' : 'chip-ok'), retake ? '建议重拍' : '照片可用'));
  const recognition = data.recognition || scene.note || data.photoTip || '照片可以用，能继续看方向';
  const seen = el('p', 'quality-seen', '我看到的是：' + clipText(recognition, 20));
  seen.style.flex = '1';
  seen.style.width = 'auto';
  seen.style.minWidth = '0';
  seen.style.margin = '0';
  foldTop.append(seen);
  const toggle = el('button', 'quality-toggle', '详情 ⌄');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  foldTop.append(toggle);
  collapsed.append(foldTop);

  // P0：手机上折叠态必须能继续，不能只有「详情」
  if (isMobileLayout()) {
    const foldActions = el('div', 'quality-collapsed-actions');
    foldActions.style.display = 'flex';
    foldActions.style.flexDirection = retake ? 'row' : 'column';
    foldActions.style.gap = '6px';
    foldActions.style.width = '100%';
    foldActions.style.marginTop = '2px';
    if (typeof ctx.onSkip === 'function') {
      const go = el('button', 'btn btn-primary quality-continue', retake ? '先按这张继续' : '继续看方向 ›');
      go.type = 'button';
      if (retake) go.style.flex = '1';
      else go.classList.add('btn-block');
      go.addEventListener('click', () => ctx.onSkip());
      foldActions.append(go);
    }
    if (retake && typeof ctx.onRetake === 'function') {
      const again = el('button', 'btn btn-ghost quality-retake', '重拍一张');
      again.type = 'button';
      again.style.flex = '1';
      again.addEventListener('click', () => ctx.onRetake());
      foldActions.append(again);
    }
    if (foldActions.childNodes.length) collapsed.append(foldActions);
  }

  // 展开态：原有 head / body / actions / foot 全部收在 .quality-details
  const details = el('div', 'quality-details');
  details.hidden = true;
  head(details, el('span', 'card-kicker', '照片质检'), el('span', 'chip' + (retake ? ' chip-warn' : ''), retake ? '建议重拍' : '照片可用'));

  const body = el('div', 'card-body');
  const scoreRow = el('div', 'q-score-row');
  if (typeof data.score === 'number') {
    const score = el('div', 'q-score');
    const full = data.score > 5 ? 100 : 5;
    score.append(document.createTextNode(String(data.score)), el('small', null, '/' + full));
    scoreRow.append(score);
  }
  if (scene.note) scoreRow.append(el('p', 'q-summary', scene.note));
  if (scoreRow.childNodes.length) body.append(scoreRow);

  const issues = Array.isArray(data.issues) ? data.issues : [];
  if (issues.length) {
    const list = el('div', 'issue-list');
    issues.forEach((issue) => {
      const item = el('div', 'issue');
      if (issue.severity === 'block') item.dataset.severity = 'block';
      const main = el('div', 'issue-main');
      main.append(el('div', 'issue-label', issue.label || issue.code || '照片问题'));
      if (issue.hint) main.append(el('div', 'issue-hint', issue.hint));
      item.append(main);
      list.append(item);
    });
    body.append(list);
  }

  if (data.photoTip) {
    const tip = el('div', 'q-tip');
    tip.append(el('span', null, data.photoTip));
    body.append(tip);
  }
  details.append(body);

  const footEl = foot(details, '照片只用于这次分析，可随时删除。');
  const actions = footActions(footEl);
  if (typeof ctx.onSkip === 'function') {
    const go = el('button', 'btn btn-primary', retake ? '先按这张继续' : '继续看方向');
    go.type = 'button';
    go.addEventListener('click', () => ctx.onSkip());
    actions.append(go);
  }
  if (typeof ctx.onRetake === 'function') {
    const again = el('button', 'btn btn-ghost', '重拍一张');
    again.type = 'button';
    again.addEventListener('click', () => ctx.onRetake());
    actions.append(again);
  }

  toggle.addEventListener('click', () => {
    const open = details.hidden;
    details.hidden = !open;
    card.dataset.collapsed = open ? 'false' : 'true';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? '收起 ⌃' : '详情 ⌄';
  });

  // 桌面初始保持旧结构（CSS 未就绪也不退化）；移动端默认折叠
  if (isMobileLayout()) {
    collapsed.hidden = false;
    details.hidden = true;
  } else {
    collapsed.hidden = true;
    details.hidden = false;
  }
  card.append(collapsed, details);
  return card;
}

/* ================================================================ 方向预览卡 */

export function directionsCard(l0, ctx = {}) {
  const data = l0 || {};
  const mobile = isMobileLayout();
  const card = makeCard('directions', 'card-direction');
  if (mobile) {
    card.classList.add('is-mobile');
    card.dataset.mobile = 'true';
  }
  const scene = data.scene || {};

  const headEl = head(card, el('span', 'badge l0', 'L0 · 方向预览'));
  if (scene.roomGuess) {
    const light = LIGHT_TEXT[scene.light] ? ' · ' + LIGHT_TEXT[scene.light] : '';
    headEl.append(el('span', 'card-kicker', scene.roomGuess + light));
  }

  const body = el('div', 'card-body');
  // 移动端：卡片级说明/免责先收进 extraNodes，最后放进推荐方向的「更多细节」
  const extraNodes = [];
  const addExtra = (node) => {
    if (!node) return;
    if (mobile) extraNodes.push(node);
    else body.append(node);
  };

  if (scene.summary) addExtra(el('p', null, scene.summary));

  const verdictLine = el('div', 'verdict-line');
  verdictLine.append(verdictEl(data.verdict));
  if (data.verdictReason) verdictLine.append(el('span', null, data.verdictReason));
  addExtra(verdictLine);
  if (data.nextAction) addExtra(el('p', 'verdict-reason', '下一步：' + data.nextAction));

  const missing = Array.isArray(data.missing) ? data.missing : [];
  if (missing.length) {
    const labels = missing.map((m) => (typeof m === 'string' ? m : m.label || measureLabel(m.key))).join('、');
    addExtra(el('p', 'disclaimer', `还差 ${missing.length} 个关键尺寸：${labels}`));
  }

  // 退出说明 / 免责：桌面在 card-foot，移动端收进「更多细节」
  const footLines = el('div', 'l0-footlines');
  footLines.style.display = 'flex';
  footLines.style.flexDirection = 'column';
  footLines.style.gap = '2px';
  footLines.append(el('p', 'disclaimer', '现在退出也可以，这张方向图会留在你的角落档案里。'));
  footLines.append(el('p', 'disclaimer', '继续只要 2 个尺寸，约 1 分钟。'));
  if (data.disclaimer) footLines.append(el('p', 'disclaimer', data.disclaimer));
  if (mobile) extraNodes.push(footLines);

  const directions = Array.isArray(data.directions) ? data.directions.slice(0, 3) : [];

  function firstMeasureLabel(direction) {
    const first = Array.isArray(direction.firstMeasurements) ? direction.firstMeasurements[0] : null;
    if (!first) return '';
    return first.label || measureLabel(first.key) || '';
  }

  /** 移动端推荐方向：标题行（序号+标题+推荐徽章同排）→ pitch 2 行 → 全宽 CTA → 次级 → 更多细节 */
  function buildMobileDirectionItem(direction, index, options = {}) {
    const isChosen = Boolean(options.chosen);
    const isRecommended = Boolean(options.recommended);
    const item = el('div', 'dir-item is-mobile' + (isChosen ? ' is-active' : ''));
    if (isRecommended) item.dataset.recommended = 'true';
    item.dataset.details = 'false';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-expanded', 'false');

    const headRow = el('div', 'dir-reco-head');
    headRow.append(el('span', 'dir-index', String(index + 1).padStart(2, '0')));
    const title = el('div', 'dir-title');
    title.append(el('span', null, direction.title || '未命名方向'));
    if (direction.kit) {
      title.append(el('span', 'kit-chip kit-' + direction.kit, KIT_TEXT[direction.kit] || ''));
    }
    if (isRecommended) title.append(el('span', 'recommend-tag', '推荐先试这个'));
    headRow.append(title);
    item.append(headRow);

    if (direction.pitch) item.append(el('p', 'dir-pitch is-clamp', direction.pitch));

    const measureText = firstMeasureLabel(direction);
    const cta = el('button', 'btn btn-primary btn-block dir-cta', measureText ? '先量这个：' + measureText : '先量关键尺寸');
    cta.type = 'button';
    touchStyle(cta);
    const first = Array.isArray(direction.firstMeasurements) ? direction.firstMeasurements[0] : null;
    if (first && first.why) cta.title = first.why;
    cta.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof ctx.onMeasureNow === 'function') ctx.onMeasureNow(direction);
      else if (typeof ctx.onChoose === 'function') ctx.onChoose(direction);
    });
    item.append(cta);

    const actionsWrap = el('div', 'dir-secondary');
    if (direction.regionId && typeof ctx.onPickRegion === 'function') {
      const regionBtn = el('button', 'btn btn-ghost dir-region', '看这个区域');
      regionBtn.type = 'button';
      touchStyle(regionBtn);
      regionBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctx.onPickRegion(direction.regionId);
      });
      actionsWrap.append(regionBtn);
    }

    const details = el('div', 'dir-details');
    details.hidden = true;

    const meta = el('div', 'dir-meta');
    if (isChosen) meta.append(el('span', 'item-tag', '已选'));
    if (direction.confidence) meta.append(el('span', 'item-tag', CONF_TEXT[direction.confidence] || ''));
    if (measureText) meta.append(el('span', 'item-tag', '先量：' + measureText));
    if (meta.childNodes.length) details.append(meta);
    if (direction.regionId) details.append(el('p', 'dir-region-line', '区域 ' + direction.regionId));
    if (direction.risk) details.append(el('p', 'dir-risk', direction.risk));
    if (options.recommendWhy) details.append(el('p', 'recommend-why', '为什么推荐这个：' + options.recommendWhy));
    (Array.isArray(options.extra) ? options.extra : []).forEach((node) => details.append(node));

    if (details.childNodes.length) {
      const toggle = el('button', 'btn btn-ghost dir-more', '更多细节 ⌄');
      toggle.type = 'button';
      touchStyle(toggle);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const open = details.hidden;
        details.hidden = !open;
        item.dataset.details = open ? 'true' : 'false';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '收起 ⌃' : '更多细节 ⌄';
        item.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      actionsWrap.append(toggle);
    }
    if (actionsWrap.childNodes.length) item.append(actionsWrap);
    item.append(details);

    if (typeof ctx.onChoose === 'function') {
      headRow.addEventListener('click', () => ctx.onChoose(direction));
      item.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ctx.onChoose(direction);
        }
      });
    }
    return item;
  }

  function buildDirectionItem(direction, index, options = {}) {
    if (mobile) return buildMobileDirectionItem(direction, index, options);
    const isChosen = Boolean(options.chosen);
    const isRecommended = Boolean(options.recommended);
    const item = el('div', 'dir-item' + (isChosen ? ' is-active' : ''));
    if (isRecommended) item.dataset.recommended = 'true';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.append(el('span', 'dir-index', String(index + 1).padStart(2, '0')));

    const title = el('div', 'dir-title');
    title.append(el('span', null, direction.title || '未命名方向'));
    if (direction.kit) {
      const kit = el('span', 'kit-chip kit-' + direction.kit, KIT_TEXT[direction.kit] || '');
      title.append(kit);
    }
    item.append(title);

    if (direction.pitch) item.append(el('p', 'dir-pitch', direction.pitch));

    const meta = el('div', 'dir-meta');
    if (isRecommended) meta.append(el('span', 'recommend-tag', '推荐先试这个'));
    if (isChosen) meta.append(el('span', 'item-tag', '已选'));
    if (direction.confidence) meta.append(el('span', 'item-tag', CONF_TEXT[direction.confidence] || ''));
    const first = Array.isArray(direction.firstMeasurements) ? direction.firstMeasurements[0] : null;
    if (first) meta.append(el('span', 'item-tag', '先量：' + (first.label || measureLabel(first.key))));
    if (direction.regionId) meta.append(el('span', 'item-tag', '区域 ' + direction.regionId));
    if (meta.childNodes.length) item.append(meta);

    if (direction.risk) item.append(el('p', 'dir-risk', direction.risk));

    const actions = el('div', 'card-actions');
    if (typeof ctx.onMeasureNow === 'function') {
      const measureBtn = el('button', 'btn btn-chip', first ? '先量这个：' + (first.label || measureLabel(first.key)) : '先量关键尺寸');
      measureBtn.type = 'button';
      touchStyle(measureBtn);
      if (first && first.why) measureBtn.title = first.why;
      measureBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctx.onMeasureNow(direction);
      });
      actions.append(measureBtn);
    }
    if (direction.regionId && typeof ctx.onPickRegion === 'function') {
      const regionBtn = el('button', 'btn btn-ghost', '看这个区域');
      regionBtn.type = 'button';
      touchStyle(regionBtn);
      regionBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctx.onPickRegion(direction.regionId);
      });
      actions.append(regionBtn);
    }
    if (actions.childNodes.length) item.append(actions);

    if (typeof ctx.onChoose === 'function') {
      item.addEventListener('click', () => ctx.onChoose(direction));
      item.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ctx.onChoose(direction);
        }
      });
    }
    return item;
  }

  /** 非推荐方向折叠成一行（移动端 48px：序号 + 标题 + 箭头） */
  function buildCollapsedItem(direction, index, options = {}) {
    const row = el('div', 'dir-item is-collapsed' + (mobile ? ' is-mobile' : ''));
    row.dataset.collapsed = 'true';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', 'false');
    row.append(el('span', 'dir-index', String(index + 1).padStart(2, '0')));

    const title = el('div', 'dir-title');
    title.append(el('span', null, direction.title || '未命名方向'));
    if (options.recommended) title.append(el('span', 'item-tag', '推荐'));
    if (options.chosen) title.append(el('span', 'item-tag', '已选'));
    row.append(title);
    if (mobile) {
      const arrow = el('span', 'dir-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      row.append(arrow);
    }

    const expand = () => {
      const expanded = buildDirectionItem(direction, index, options);
      row.replaceWith(expanded);
    };
    row.addEventListener('click', expand);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        expand();
      }
    });
    return row;
  }

  if (directions.length) {
    const recommend = data.recommend && typeof data.recommend === 'object' ? data.recommend : null;
    const recommendId = recommend && recommend.directionId != null ? String(recommend.directionId) : null;
    if (recommendId) card.dataset.recommended = 'true';
    const chosenId = ctx.chosenId == null ? null : String(ctx.chosenId);
    const expandedId = chosenId || recommendId;

    if (expandedId || mobile) {
      // V2：只展开推荐（或回放时已选）的方向，其余折叠成一行；移动端必定折叠其余
      const expanded = expandedId
        ? directions.find((d) => String(d.id) === expandedId) || directions[0]
        : directions[0];
      const isRecommended = recommendId != null && String(expanded.id) === recommendId;
      const list = el('div', 'dir-list');
      list.append(
        buildDirectionItem(expanded, directions.indexOf(expanded), {
          chosen: chosenId != null && String(expanded.id) === chosenId,
          recommended: isRecommended || (mobile && !recommendId),
          extra: mobile ? extraNodes : [],
          recommendWhy: isRecommended && recommend ? recommend.why : '',
        })
      );
      body.append(list);
      if (!mobile && isRecommended && recommend && recommend.why) {
        body.append(el('p', 'recommend-why', '为什么推荐这个：' + recommend.why));
      }

      const others = directions.filter((d) => d !== expanded);
      if (others.length) {
        const group = el('div', 'dir-collapsed-group');
        others.forEach((direction) => {
          group.append(
            buildCollapsedItem(direction, directions.indexOf(direction), {
              chosen: chosenId != null && String(direction.id) === chosenId,
              recommended: recommendId != null && String(direction.id) === recommendId,
            })
          );
        });
        if (recommend && recommend.alternativesNote) {
          group.append(el('p', 'alternatives-note', recommend.alternativesNote));
        }
        body.append(group);
      }
    } else {
      // V1 旧数据（没有 recommend / chosenId）：桌面全部展开、移动端首张展开其余折叠
      const list = el('div', 'dir-list');
      directions.forEach((direction, index) => list.append(buildDirectionItem(direction, index, {})));
      body.append(list);
    }
  } else if (data.verdict === 'not_supported' || data.verdict === 'insufficient') {
    addExtra(el('p', null, '这个角落现在不适合直接动。先把上面说的问题解决，再回来看。'));
  }

  card.append(body);
  if (!mobile) {
    const footEl = el('div', 'card-foot');
    footEl.append(footLines);
    card.append(footEl);
  }
  return card;
}

/* ================================================================ V2.1 目标选择 */

const GOAL_OPTIONS = [
  { value: 'ignore', label: '猫不进去' },
  { value: 'messy', label: '太乱占道' },
  { value: 'smell', label: '有味道' },
  { value: 'fine', label: '都还行' },
];

/** L0 方向卡之前的一句提问：一次点击写 profile.primaryPain，不做问卷 */
export function goalChoices(ctx = {}) {
  const wrap = el('div', 'goal-choices');
  if (!document.getElementById('goal-choices')) wrap.id = 'goal-choices';
  wrap.append(el('div', 'goal-choices-label', '你最想解决哪个？（点一下就行）'));
  const row = el('div', 'goal-choices-row');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', '你最想解决哪个');

  const selected = ctx.selected == null ? '' : String(ctx.selected);
  GOAL_OPTIONS.forEach((option) => {
    const btn = el('button', 'goal-choice', option.label);
    btn.type = 'button';
    btn.dataset.value = option.value;
    btn.setAttribute('aria-pressed', selected === option.label || selected === option.value ? 'true' : 'false');
    btn.addEventListener('click', () => {
      Array.from(row.children).forEach((child) => child.setAttribute('aria-pressed', child === btn ? 'true' : 'false'));
      if (typeof ctx.onSelect === 'function') ctx.onSelect(option.label, option.value);
    });
    row.append(btn);
  });
  wrap.append(row);
  return wrap;
}

/* ================================================================ V2.1 等待三步骤 */

const WAIT_STEP_TEXTS = [
  '读空间结构：找到墙角、地面和遮挡物',
  '估算尺寸关系：先判断大方向站不站得住',
  '筛掉放不下的方向，留下能去店里问的清单',
];

/** 上传后等待：3 步 checklist 代替无限 spinner；指认句 + 边界句 + 重选出口 */
export function waitStepsCard() {
  const card = makeCard('waitsteps', 'card-waitsteps');
  head(card, el('span', 'card-kicker', '正在看这张照片'), el('span', 'chip', '通常 8—15 秒'));

  const body = el('div', 'card-body');
  const list = el('ol', 'wait-steps');
  if (!document.getElementById('wait-steps')) list.id = 'wait-steps';
  const items = WAIT_STEP_TEXTS.map((text, index) => {
    const li = el('li', null, text);
    li.dataset.state = index === 0 ? 'active' : 'todo';
    list.append(li);
    return li;
  });
  const recognition = el('div', 'wait-recognition');
  recognition.hidden = true;
  body.append(list, recognition);
  card.append(body);

  let pickCb = null;
  return {
    el: card,
    /** doneCount=0/1/2：前面的打勾，当前项 active */
    setStep(doneCount) {
      const done = Math.max(0, Math.min(items.length, doneCount));
      items.forEach((li, index) => {
        li.dataset.state = index < done ? 'done' : index === done ? 'active' : 'todo';
      });
    },
    showRecognition(text, boundary, onPick) {
      items.forEach((li) => {
        li.dataset.state = 'done';
      });
      recognition.hidden = false;
      recognition.textContent = '';
      recognition.append(el('p', 'recognition-line', text || '找到这个角落了。'));
      recognition.append(
        el('p', 'recognition-boundary', boundary || '照片里看不出进深，这一步只能给方向，不能保证放得下。')
      );
      const btn = el('button', 'btn btn-ghost', '不对？点图重选');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (typeof onPick === 'function') onPick();
      });
      pickCb = onPick;
      recognition.append(btn);
    },
    fail(message) {
      items.forEach((li) => {
        li.dataset.state = 'todo';
      });
      recognition.hidden = false;
      recognition.textContent = '';
      recognition.append(el('p', 'recognition-boundary', message || '这一步没跑通，点下面的按钮重试。'));
    },
    get pickHandler() {
      return pickCb;
    },
  };
}

/* ================================================================ V3.2 手机照片条 */

/** 手机端 feed 顶部照片条：缩略图 + 「这张角落照片 · 标注 N 处」+ 查看标注 */
export function photoStrip(session, ctx = {}) {
  const data = session || {};
  const image = data.image;
  if (!image) return null;
  const imageUrl = image.url || (image.imageId ? '/api/image/' + image.imageId : '');
  if (!imageUrl) return null;
  const plan = data.plan;
  const l0 = data.l0;
  const annotationCount = plan && Array.isArray(plan.annotations) ? plan.annotations.length : 0;
  const regionCount = l0 && Array.isArray(l0.regions) ? l0.regions.length : 0;
  const count = annotationCount || regionCount;

  const strip = el('button', 'photo-strip');
  strip.id = 'photo-strip';
  strip.type = 'button';
  strip.style.minHeight = '56px';
  strip.setAttribute('aria-label', count ? `查看这张角落照片的 ${count} 处标注` : '查看这张角落照片');

  const thumb = document.createElement('img');
  thumb.className = 'photo-strip-thumb';
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.src = imageUrl;
  strip.append(thumb);

  const text = el('span', 'photo-strip-text');
  text.append(el('span', 'photo-strip-title', '这张角落照片'));
  if (count) text.append(el('span', 'photo-strip-count', '标注 ' + count + ' 处'));
  strip.append(text);

  strip.append(el('span', 'photo-strip-cta', '查看标注 ›'));

  strip.addEventListener('click', () => {
    if (typeof ctx.onOpen === 'function') ctx.onOpen(strip);
  });
  return strip;
}

/* ================================================================ V3 交付收尾卡 */

const HANDOFF_VERDICT_TEXT = {
  ok: '可以放',
  conditional: '有条件可放',
  not_supported: '现在不建议放',
  insufficient: '还差关键数字',
};

function touchButton(className, text, onClick) {
  const btn = el('button', 'btn ' + className, text);
  btn.type = 'button';
  btn.style.minHeight = '44px';
  btn.addEventListener('click', () => {
    if (typeof onClick === 'function') onClick();
  });
  return btn;
}

/** 交付后的收尾卡：完成句 + 三个数字 + 时间线 + 四个动作 */
export function handoffCard(session, ctx = {}) {
  const data = session || {};
  const plan = data.plan || {};
  const card = makeCard('handoff', 'card-handoff');
  head(card, el('span', 'chip chip-handoff', '已完成'), el('span', 'card-kicker', '这个角落的结论'));

  const body = el('div', 'card-body');
  const verdict = HANDOFF_VERDICT_TEXT[plan.verdict] ? plan.verdict : 'insufficient';
  const unknownCount = Array.isArray(plan.constraints)
    ? plan.constraints.filter((constraint) => constraint.status === 'unknown').length
    : 0;
  const verdictText =
    verdict === 'insufficient' && unknownCount
      ? `还差 ${unknownCount} 个数字`
      : HANDOFF_VERDICT_TEXT[verdict] || '还差关键数字';
  body.append(el('p', 'handoff-done', '这个角落已经有结论了：' + verdictText));

  const measured = Array.isArray(plan.usedMeasurements) ? plan.usedMeasurements.length : 0;
  const catfitCount = plan.catFit && Array.isArray(plan.catFit.items) ? plan.catFit.items.length : 0;
  const constraintCount = Array.isArray(plan.constraints) ? plan.constraints.length : 0;
  const checklistCount = Array.isArray(plan.checklist) ? plan.checklist.length : 0;

  const stats = el('div', 'handoff-stats');
  const addStat = (value, label) => {
    const stat = el('div', 'handoff-stat');
    stat.append(el('b', 'mono', String(value)), el('span', null, label));
    stats.append(stat);
  };
  addStat(measured, '你量的数');
  addStat(catfitCount, '位置判断');
  addStat(`${constraintCount} + ${checklistCount}`, '尺寸条件 + 现场动作');
  body.append(stats);

  const observe = Array.isArray(plan.observe)
    ? plan.observe.filter((day) => day && (day.title || (Array.isArray(day.checks) && day.checks.length)))
    : [];
  if (observe.length) {
    const details = document.createElement('details');
    details.className = 'handoff-timeline';
    const summary = document.createElement('summary');
    summary.textContent = '接下来 7 天怎么判断';
    const list = el('ol', 'handoff-days');
    observe.forEach((day, index) => {
      const dayNumber = day.day == null ? index + 1 : day.day;
      const item = el('li', 'handoff-day');
      item.append(el('span', 'handoff-day-num mono', '第 ' + dayNumber + ' 天'));
      const text = Array.isArray(day.checks) && day.checks.length ? day.checks[0] : day.title || '';
      item.append(el('span', null, text));
      list.append(item);
    });
    details.append(summary, list);
    body.append(details);
  }

  const share = data.share && data.share.token ? data.share : null;
  const shareStatus = el('p', 'handoff-share-status', share ? '已分享 · 等待家人意见' : '');
  shareStatus.hidden = !share;
  body.append(shareStatus);
  card.append(body);

  const actions = el('div', 'handoff-actions');
  if (typeof ctx.onExport === 'function') actions.append(touchButton('btn-ghost', '导出标注图', ctx.onExport));
  if (typeof ctx.onShare === 'function') {
    actions.append(touchButton('btn-primary', share ? '再次分享给大家' : '分享给同住的人', ctx.onShare));
  }
  if (typeof ctx.onAfter === 'function') actions.append(touchButton('btn-ghost', '记录改造结果', ctx.onAfter));
  if (typeof ctx.onCopyChecklist === 'function') {
    actions.append(touchButton('btn-ghost', '复制现场清单', ctx.onCopyChecklist));
  }
  if (actions.childNodes.length) card.append(actions);

  return card;
}

/* ================================================================ V3 家人意见 */

/** 相对时间（家人意见用）：刚刚 / N 分钟前 / N 小时前 / N 天前 */
function formatRelative(iso) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60000) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function votesCard(votes, ctx = {}) {
  const list = (Array.isArray(votes) ? votes : []).filter((vote) => vote && vote.vote);
  const responds = (Array.isArray(ctx.responds) ? ctx.responds : []).filter((item) => item && item.action);
  if (!list.length && !responds.length) return null; // 整卡两边都空不渲染
  const labels = ctx.labels && typeof ctx.labels === 'object' ? ctx.labels : {};
  const voteText = { yes: '支持', unsure: '犹豫', no: '反对' };
  const support = list.filter((vote) => vote.vote === 'yes').length;
  const unsure = list.filter((vote) => vote.vote === 'unsure').length;
  const oppose = list.filter((vote) => vote.vote === 'no').length;
  const people = new Set(list.map((vote, index) => (vote.name || vote.voteId || 'person-' + index).trim())).size;
  const unread = Math.max(0, Number(ctx.unread) || 0);
  const latestAt = list
    .map((vote) => vote.at)
    .concat(responds.map((item) => item.at))
    .filter(Boolean)
    .sort()
    .slice(-1)[0];

  const card = makeCard('votes', 'card-votes');
  const headLabel = list.length ? '家人意见' : '家人回应';
  if (!list.length) card.dataset.only = 'responds';
  const headEl = head(card, el('span', 'chip chip-votes', headLabel));
  if (unread > 0) {
    const badge = el('span', 'chip vote-unread-chip', unread > 9 ? '9+' : '+' + unread);
    badge.setAttribute('aria-label', `${unread} 条新意见`);
    badge.style.marginLeft = '6px';
    headEl.append(badge);
  }
  card.dataset.unread = String(unread);

  const summary = el('div', 'vote-summary');
  if (list.length) {
    summary.append(el('b', 'mono', String(people)), document.createTextNode(' 人看过 · 支持 '));
    summary.append(el('b', 'mono', String(support)));
    if (unsure) {
      summary.append(document.createTextNode(' · 犹豫 '));
      summary.append(el('b', 'mono', String(unsure)));
    }
    if (oppose) {
      summary.append(document.createTextNode(' · 反对 '));
      summary.append(el('b', 'mono', String(oppose)));
    }
  } else {
    summary.append(el('b', 'mono', String(responds.length)), document.createTextNode(' 条行动回应'));
  }
  if (latestAt) {
    const updated = el('span', 'vote-updated', '最近更新 · ' + formatRelative(latestAt));
    updated.style.marginLeft = 'auto';
    updated.style.fontSize = '11px';
    updated.style.color = 'var(--ink-3)';
    summary.append(updated);
  }
  card.append(summary);

  if (list.length) {
    const rowList = el('div', 'vote-list');
    list.forEach((vote, index) => {
      const row = el('div', 'vote-row');
      const name = vote.name || '家人 ' + (index + 1);
      row.append(el('span', 'vote-avatar', name.slice(0, 1) || '家'));
      const main = el('div', 'vote-main');
      const who = el('div', 'vote-who');
      const targetLabel = labels[vote.targetId] || '这个方案';
      who.append(el('b', 'vote-name', name), document.createTextNode(` · ${voteText[vote.vote] || '看过'}「${targetLabel}」`));
      main.append(who);
      if (vote.note) main.append(el('blockquote', null, vote.note));
      if (vote.at) {
        const when = el('div', 'vote-when', formatRelative(vote.at));
        when.style.fontSize = '11px';
        when.style.lineHeight = '1.5';
        when.style.color = 'var(--ink-4)';
        main.append(when);
      }
      row.append(main);
      row.append(el('span', 'vote-badge', voteText[vote.vote] || '看过'));
      row.lastChild.dataset.vote = vote.vote;
      rowList.append(row);
    });
    card.append(rowList);
  }

  if (responds.length) {
    const respondUnread = Math.max(0, Number(ctx.respondUnread) || 0);
    const section = el('div', 'respond-section');
    const sectionTitle = el('div', 'respond-section-title');
    const titleText = el('span', 'respond-section-title-text', '家人回应');
    titleText.style.minWidth = '0';
    titleText.style.overflow = 'hidden';
    titleText.style.textOverflow = 'ellipsis';
    titleText.style.whiteSpace = 'nowrap';
    sectionTitle.append(titleText);
    if (respondUnread > 0) {
      const chip = el('span', 'respond-unread-chip', '新 ' + (respondUnread >= 10 ? '9+' : String(respondUnread)));
      chip.setAttribute('aria-label', `${respondUnread} 条新回应`);
      sectionTitle.append(chip);
    }
    section.append(sectionTitle);
    const respondList = el('div', 'respond-list');
    respondList.style.display = 'flex';
    respondList.style.flexDirection = 'column';
    respondList.style.gap = '6px';
    responds.forEach((respond, index) => {
      const name = respond.name || '家人 ' + (index + 1);
      const row = el('div', 'respond-row');
      row.style.padding = '4px 0';
      row.append(el('span', 'vote-avatar', name.slice(0, 1) || '家'));
      const main = el('div', 'respond-main');
      main.style.display = 'flex';
      main.style.flexDirection = 'column';
      main.style.gap = '4px';
      main.style.alignItems = 'flex-start';
      const who = el('div', 'respond-who');
      who.append(el('b', 'vote-name', name));
      who.append(document.createTextNode(' · '));
      who.append(el('span', 'respond-action', respond.label || respond.action || '回应'));
      main.append(who);
      if (respond.note) main.append(el('blockquote', null, respond.note));
      if (respond.photoUrl) {
        const photo = document.createElement('img');
        photo.className = 'respond-photo';
        photo.src = respond.photoUrl;
        photo.alt = '家人拍的现场照';
        photo.loading = 'lazy';
        photo.style.width = '72px';
        photo.style.height = '72px';
        photo.style.objectFit = 'cover';
        photo.style.borderRadius = '8px';
        photo.style.cursor = 'zoom-in';
        photo.addEventListener('click', () => {
          if (typeof ctx.onOpenRespondPhoto === 'function') ctx.onOpenRespondPhoto(respond.photoUrl, respond);
        });
        const media = el('div', 'respond-media');
        media.style.display = 'flex';
        media.style.alignItems = 'center';
        media.style.gap = '8px';
        media.append(photo);
        const use = el('button', 'btn btn-ghost respond-use', '设为改造后照片');
        use.type = 'button';
        use.addEventListener('click', () => {
          if (typeof ctx.onUseRespondPhoto === 'function') ctx.onUseRespondPhoto(respond);
        });
        media.append(use);
        main.append(media);
      }
      if (respond.at) {
        const when = el('span', 'respond-when', formatRelative(respond.at));
        when.style.fontSize = '11px';
        when.style.color = 'var(--ink-4)';
        main.append(when);
      }
      row.append(main);
      respondList.append(row);
    });
    section.append(respondList);
    card.append(section);
  }
  return card;
}

/* ================================================================ V3 改造前后对比 */

export function compareCard(session, ctx = {}) {
  const data = session || {};
  const after = data.afterImage;
  if (!after || !after.url) return null;
  const beforeUrl = ctx.beforeUrl || (data.image && data.image.url) || '';
  if (!beforeUrl) return null;
  const annotations = data.plan && Array.isArray(data.plan.annotations) ? data.plan.annotations : [];

  const card = makeCard('compare', 'card-compare');
  const at = after.at ? String(after.at).slice(0, 10) : '';
  head(card, el('span', 'chip chip-compare', '改造前后'), el('span', 'card-kicker', at || '同一位置'));

  const grid = el('div', 'compare-grid');
  const beforePane = el('div', 'compare-pane is-before');
  beforePane.append(el('span', 'compare-label', '改造前'));
  const beforeCanvas = document.createElement('canvas');
  beforeCanvas.className = 'compare-canvas';
  beforePane.append(beforeCanvas);
  const arrow = el('div', 'compare-arrow', '→');
  const afterPane = el('div', 'compare-pane is-after');
  afterPane.append(el('span', 'compare-label', '改造后'));
  const afterImg = document.createElement('img');
  afterImg.className = 'compare-img';
  afterImg.src = after.url;
  afterImg.alt = '改造后照片';
  afterPane.append(afterImg);
  grid.append(beforePane, arrow, afterPane);
  card.append(grid);

  const caption = document.createElement('input');
  caption.type = 'text';
  caption.className = 'compare-caption';
  caption.maxLength = 30;
  caption.placeholder = '按方案落地后的样子';
  caption.value = ctx.summary || '按方案落地后的样子';
  card.append(caption);

  const actions = el('div', 'compare-actions');
  if (typeof ctx.onExportCompare === 'function') {
    actions.append(
      touchButton('btn-primary', '导出对比图', () => ctx.onExportCompare(caption.value.trim() || '按方案落地后的样子'))
    );
  }
  if (typeof ctx.onPickAfter === 'function') actions.append(touchButton('btn-ghost', '重新上传', ctx.onPickAfter));
  if (typeof ctx.onRemoveAfter === 'function') actions.append(touchButton('btn-ghost', '删除对比', ctx.onRemoveAfter));
  if (actions.childNodes.length) card.append(actions);

  // 复用主画布的绘制工具画「改造前 + 标注」
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      renderPhotoThumb(beforeCanvas, { url: beforeUrl, annotations }).catch(() => {});
    });
  } else {
    renderPhotoThumb(beforeCanvas, { url: beforeUrl, annotations }).catch(() => {});
  }
  return card;
}

/* ================================================================ V2.1 回访轻卡 */

export function followupCard(data, ctx = {}) {
  const payload = data || {};
  const card = makeCard('followup', 'card-followup');
  head(card, el('span', 'chip chip-followup', `第 ${payload.day || 2} 天`), el('span', 'card-kicker', '回访'));

  const body = el('div', 'card-body');
  body.append(el('p', 'followup-title', payload.title || '用上了吗？'));
  if (payload.sub) body.append(el('p', 'followup-sub', payload.sub));
  card.append(body);

  const actions = el('div', 'followup-actions');
  (Array.isArray(payload.actions) ? payload.actions : []).forEach((action) => {
    const btn = el('button', 'btn btn-chip', action.label || '好');
    btn.type = 'button';
    btn.dataset.value = action.value || action.label || '';
    btn.addEventListener('click', () => {
      Array.from(actions.children).forEach((child) => child.setAttribute('aria-pressed', child === btn ? 'true' : 'false'));
      if (typeof ctx.onAnswer === 'function') ctx.onAnswer(payload.day || 2, action.value || action.label || '');
    });
    actions.append(btn);
  });
  card.append(actions);
  return card;
}

/* ================================================================== 测量卡（V2.1） */

const MEASURE_LEAD = '这两个数字只有你能给。量完这一步，方案就是你自己的了。';

function measureProgressHead(data) {
  const totalTargets = Number(data.totalTargets);
  if (Number.isFinite(totalTargets) && totalTargets > 0) {
    // 照片算第 1 步：分母 = 目标尺寸数 + 1
    const total = totalTargets + 1;
    const attempted = Math.min(totalTargets, Math.max(0, Number(data.attemptedTargets) || 0));
    const done = Math.min(total, attempted + 1);
    const left = Math.max(0, total - done);
    return `已完成 ${done}/${total} · ${left > 0 ? `还差 ${left} 个数字` : '尺寸齐了'}`;
  }
  return `第 ${data.round || 1} 步测量`;
}

function createMeasureInput(question, ariaLabel) {
  const input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.step = '0.1';
  input.min = '1';
  input.max = '2000';
  input.className = 'm-input';
  input.placeholder = question && question.example ? '例如 ' + question.example : '例如 62';
  input.setAttribute('aria-label', ariaLabel);
  return input;
}

function parseCm(raw) {
  const num = Number(String(raw == null ? '' : raw).replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0 || num > 2000) return null;
  return Math.round(num * 10) / 10;
}

export function measureCard(ask, ctx = {}) {
  const data = ask || {};
  // V2.1 一卡一项：一次只问一个数字
  const question = (Array.isArray(data.questions) ? data.questions : [])[0];
  const card = makeCard('measure', 'card-measure');

  const headEl = head(card, el('span', 'card-kicker', measureProgressHead(data)));
  if (!Number.isFinite(Number(data.totalTargets)) && Array.isArray(data.remainingKeys) && data.remainingKeys.length) {
    headEl.append(el('span', 'item-tag', `还差 ${data.remainingKeys.length} 项`));
  }

  const body = el('div', 'card-body');
  if (typeof ctx.leadText === 'string') {
    if (ctx.leadText) body.append(el('p', 'measure-lead', ctx.leadText));
  } else {
    body.append(el('p', 'measure-lead', MEASURE_LEAD));
  }
  if (data.askNote) body.append(el('p', 'm-hint', data.askNote));

  if (!question) {
    body.append(el('p', 'm-hint', '这轮没有要量的尺寸了。'));
    card.append(body);
    return card;
  }

  const item = el('div', 'measure-item');
  const itemHead = el('div', 'm-head');
  itemHead.append(el('span', 'm-num', '01'));
  itemHead.append(el('span', 'm-label', question.label || measureLabel(question.key)));
  item.append(itemHead);
  if (question.endpoints) item.append(el('p', 'm-endpoints', question.endpoints));
  if (question.why) item.append(el('p', 'm-why', '为什么量：' + question.why));
  if (question.hint) item.append(el('p', 'm-hint', question.hint));

  const singleInput = createMeasureInput(question, (question.label || measureLabel(question.key)) + '，单位厘米');
  const singleWrap = el('div', 'measure-single');
  singleWrap.style.display = 'flex';
  singleWrap.style.alignItems = 'center';
  singleWrap.style.gap = '8px';
  singleWrap.append(singleInput, el('span', 'm-unit', 'cm'));

  const field = el('div', 'm-field');
  field.append(singleWrap);
  item.append(field);

  const toggle = el('button', 'measure-range-toggle', '不确定，估个范围');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');
  const note = el('p', 'measure-range-note');
  note.hidden = true;

  const actions = el('div', 'm-actions');
  const skipBtn = el('button', 'btn m-skip', '不确定，先跳过');
  skipBtn.type = 'button';
  skipBtn.setAttribute('aria-pressed', 'false');
  actions.append(skipBtn, toggle);
  item.append(actions, note);

  const error = el('p', 'm-hint status-fail');
  error.hidden = true;
  item.append(error);

  let skipped = false;
  let rangeMode = false;
  let lowerInput = null;
  let upperInput = null;
  let rangeWrap = null;

  function setRangeMode(on) {
    rangeMode = Boolean(on);
    toggle.setAttribute('aria-pressed', rangeMode ? 'true' : 'false');
    toggle.textContent = rangeMode ? '填一个数就行' : '不确定，估个范围';
    field.textContent = '';
    if (rangeMode) {
      rangeWrap = el('div', 'measure-range');
      lowerInput = createMeasureInput(question, '下限（厘米）');
      upperInput = createMeasureInput(question, '上限（厘米）');
      const dash = el('span', 'measure-range-dash', '—');
      rangeWrap.append(lowerInput, dash, upperInput, el('span', 'm-unit', 'cm'));
      if (singleInput.value.trim()) lowerInput.value = singleInput.value;
      field.append(rangeWrap);
      note.hidden = false;
      note.textContent = '估范围也可以：会按保守的一端算，方案里会注明「按 Xcm 保守估算」。';
    } else {
      field.append(singleWrap);
      note.hidden = true;
    }
    error.hidden = true;
  }

  toggle.addEventListener('click', () => setRangeMode(!rangeMode));

  skipBtn.addEventListener('click', () => {
    skipped = !skipped;
    skipBtn.setAttribute('aria-pressed', skipped ? 'true' : 'false');
    item.classList.toggle('is-skipped', skipped);
    item.querySelectorAll('.m-input').forEach((input) => {
      input.disabled = skipped;
    });
    if (skipped) {
      singleInput.value = '';
      if (lowerInput) lowerInput.value = '';
      if (upperInput) upperInput.value = '';
    }
    error.hidden = true;
  });

  field.addEventListener('input', () => {
    error.hidden = true;
  });
  singleInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });

  body.append(item);
  card.append(body);

  const footEl = foot(card, '跳过不会算通过，会记为「待确认」。');
  const footButtons = footActions(footEl);
  const skipAllBtn = el('button', 'btn btn-ghost', '全部跳过');
  skipAllBtn.type = 'button';
  skipAllBtn.addEventListener('click', () => {
    if (typeof ctx.onSkipAll === 'function') ctx.onSkipAll();
  });
  const submitBtn = el('button', 'btn btn-primary', '提交这个数');
  submitBtn.type = 'button';
  submitBtn.addEventListener('click', () => submit());
  footButtons.append(skipAllBtn, submitBtn);

  function submit() {
    const key = question.key;
    if (skipped) {
      if (typeof ctx.onSubmit === 'function') ctx.onSubmit({ [key]: { skipped: true } });
      return;
    }
    if (rangeMode && lowerInput && upperInput) {
      const low = parseCm(lowerInput.value);
      const high = parseCm(upperInput.value);
      if (low == null || high == null) {
        showError('两个数都填一下，或点「填一个数就行」。', lowerInput);
        return;
      }
      const lo = Math.min(low, high);
      const hi = Math.max(low, high);
      if (typeof ctx.onSubmit === 'function') ctx.onSubmit({ [key]: { valueCm: lo, rangeCm: [lo, hi], estimate: true } });
      return;
    }
    const value = parseCm(singleInput.value);
    if (value == null) {
      showError('填一个数，或点「不确定，先跳过」。', singleInput);
      return;
    }
    if (typeof ctx.onSubmit === 'function') ctx.onSubmit({ [key]: { valueCm: value } });
  }

  function showError(message, target) {
    error.textContent = message;
    error.hidden = false;
    if (target) target.focus();
  }

  return card;
}

/* ================================================================ 点位评估卡 */

export function askCard(res) {
  const data = res || {};
  const card = makeCard('ask', 'card-ask');
  head(card, el('span', 'card-kicker', '点位评估'), verdictEl(data.verdict));

  const body = el('div', 'card-body');
  body.append(el('p', null, data.reply || data.headline || '这个位置我看到了。'));

  const pieces = Array.isArray(data.pieces) ? data.pieces : [];
  pieces.forEach((piece) => {
    const p = el('p', null);
    if (typeof piece === 'string') {
      p.textContent = piece;
    } else {
      p.append(el('strong', null, piece.label || piece.what || ''));
      const value = piece.value || piece.note || piece.reason || '';
      if (value) p.append(document.createTextNode((piece.label ? '：' : '') + value));
    }
    if (p.childNodes.length) body.append(p);
  });

  const missing = Array.isArray(data.missing) ? data.missing : [];
  if (missing.length) {
    const labels = missing.map((m) => (typeof m === 'string' ? m : m.label || measureLabel(m.key))).join('、');
    body.append(el('p', 'disclaimer', '这个位置的判断还差：' + labels));
  }
  card.append(body);
  foot(card, DISCLAIMER_L0);
  return card;
}

/* ================================================================ 交付包 card */

function buildRadar(radar) {
  const wrap = el('div', 'radar-wrap');
  const data = (Array.isArray(radar) ? radar : []).slice(0, 5);
  if (!data.length) return null;

  const NS = 'http://www.w3.org/2000/svg';
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const R = 68;
  const n = 5;
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const point = (i, radius) => [cx + Math.cos(angle(i)) * radius, cy + Math.sin(angle(i)) * radius];

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'radar-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '猫视角雷达：' + data.map((d) => `${d.label}${d.score}`).join('，'));

  for (let ring = 1; ring <= 5; ring++) {
    const radius = (R * ring) / 5;
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute(
      'points',
      Array.from({ length: n }, (_, i) => point(i, radius).map((v) => v.toFixed(1)).join(',')).join(' ')
    );
    poly.setAttribute('class', 'radar-grid');
    svg.append(poly);
  }

  for (let i = 0; i < n; i++) {
    const [x, y] = point(i, R);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(cx));
    line.setAttribute('y1', String(cy));
    line.setAttribute('x2', x.toFixed(1));
    line.setAttribute('y2', y.toFixed(1));
    line.setAttribute('class', 'radar-axis');
    svg.append(line);

    const item = data[i] || { label: '—', score: 0 };
    const [lx, ly] = point(i, R + 22);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', lx.toFixed(1));
    text.setAttribute('y', ly.toFixed(1));
    text.setAttribute('class', 'radar-label');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = item.label || '';
    svg.append(text);
  }

  const scorePoints = data.map((d, i) => {
    const score = Math.max(0, Math.min(5, Number(d.score) || 0));
    return point(i, (R * score) / 5);
  });
  const shape = document.createElementNS(NS, 'polygon');
  shape.setAttribute('points', scorePoints.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '));
  shape.setAttribute('class', 'radar-shape');
  svg.append(shape);
  scorePoints.forEach(([x, y]) => {
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', y.toFixed(1));
    dot.setAttribute('r', '3');
    dot.setAttribute('class', 'radar-point');
    svg.append(dot);
  });

  const legend = el('div', 'radar-legend');
  data.forEach((d) => {
    const row = el('div', 'radar-row');
    row.append(el('span', 'radar-key', d.label || ''));
    const bar = el('div', 'radar-bar');
    const fill = el('i');
    fill.style.width = Math.round(((Number(d.score) || 0) / 5) * 100) + '%';
    bar.append(fill);
    row.append(bar);
    row.append(el('span', 'radar-score', String(d.score == null ? 0 : d.score)));
    legend.append(row);
  });

  wrap.append(svg, legend);
  wrap.append(el('p', 'radar-note', '启发式参考，非实测；以尺寸条件与现场清单为准。'));
  return wrap;
}

function buildTabs(tabs, panels, onTab) {
  const nav = el('div', 'plan-tabs');
  nav.setAttribute('role', 'tablist');

  function activate(key) {
    Object.entries(panels).forEach(([k, panel]) => {
      panel.classList.toggle('is-active', k === key);
    });
    Array.from(nav.children).forEach((btn) => {
      const on = btn.dataset.tab === key;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (typeof onTab === 'function') onTab(key);
  }

  tabs.forEach(([key, label]) => {
    const btn = el('button', null, label);
    btn.type = 'button';
    btn.dataset.tab = key;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => activate(key));
    nav.append(btn);
  });

  const wrap = el('div', 'plan-panels');
  Object.values(panels).forEach((panel) => wrap.append(panel));
  return { nav, wrap, activate };
}

function panelEl(key) {
  const panel = el('div', 'tab-panel');
  panel.dataset.panel = key;
  return panel;
}

/* ------------------------------------------------ V2「位置」tab 构建 */

function buildPositionPanel(data) {
  const panel = panelEl('position');
  const catFit = data.catFit && typeof data.catFit === 'object' ? data.catFit : null;
  const items = catFit && Array.isArray(catFit.items) ? catFit.items.filter(Boolean) : [];

  if (catFit && (catFit.verdict || items.length)) {
    const verdict = CATFIT_VERDICT[catFit.verdict] ? catFit.verdict : 'unknown';
    const line = el('div', 'catfit-verdict');
    // ui-shell 的 .verdict 直接支持 good / caution / poor / unknown 四色
    line.append(el('span', 'verdict ' + verdict, CATFIT_VERDICT[verdict]));
    if (catFit.verdictReason) line.append(el('span', null, catFit.verdictReason));
    panel.append(line);
  }

  if (items.length) {
    const list = el('div', 'catfit-list');
    items.forEach((item) => {
      const status = CATFIT_STATUS[item.status] || CATFIT_STATUS.unknown;
      const row = el('div', 'catfit-item');
      row.dataset.status = CATFIT_STATUS[item.status] ? item.status : 'unknown';
      // 状态图标 + 主内容 + 右侧依据徽章（ui-shell CSS 按这个顺序排版）
      const statusIcon = el('span', 'catfit-status ' + status.cls);
      statusIcon.innerHTML = status.svg; // 纯静态内联 SVG
      row.append(statusIcon);
      const main = el('div', 'catfit-main');
      const labelRow = el('div');
      labelRow.append(el('span', 'catfit-label', item.label || item.key || '检查项'));
      labelRow.append(el('span', 'item-tag', status.text));
      main.append(labelRow);
      if (item.why) main.append(el('p', 'catfit-why', item.why));
      row.append(main);
      const badge = basisBadge(item.basisId, false);
      if (badge) row.append(badge);
      list.append(row);
    });
    panel.append(list);
  } else if (!catFit) {
    panel.append(el('p', 'disclaimer', '这份方案还没有位置判断（旧版本生成）。'));
  } else {
    panel.append(el('p', 'disclaimer', '位置判断数据不完整，先按尺寸条件与现场清单确认。'));
  }

  const behavior = data.behavior && typeof data.behavior === 'object' ? data.behavior : null;
  const whyNot = behavior && Array.isArray(behavior.whyNot) ? behavior.whyNot.filter(Boolean) : [];
  if (behavior && (behavior.likelyUse || whyNot.length || behavior.firstSign)) {
    const wrap = el('div', 'behavior');
    wrap.append(el('h4', 'card-kicker', '猫会怎么用'));
    if (behavior.likelyUse) wrap.append(el('p', 'behavior-likely', behavior.likelyUse));
    if (whyNot.length) {
      wrap.append(el('p', 'behavior-sub', '可能不用它的情况'));
      const ul = el('ul', 'behavior-why-not');
      whyNot.forEach((text) => ul.append(el('li', null, String(text))));
      wrap.append(ul);
    }
    if (behavior.firstSign) wrap.append(el('p', 'behavior-sign', '判断信号：' + behavior.firstSign));
    panel.append(wrap);
  }

  if (Array.isArray(data.radar) && data.radar.length) {
    panel.append(el('h4', 'card-kicker', '猫视角 · 启发式补充'));
    const radar = buildRadar(data.radar);
    if (radar) panel.append(radar);
  }

  if (!panel.childNodes.length) panel.append(el('p', 'disclaimer', '位置判断数据暂缺。'));
  return panel;
}

function buildObserveSection(observe) {
  const days = (Array.isArray(observe) ? observe : []).filter((item) => item && (item.title || (Array.isArray(item.checks) && item.checks.length)));
  if (!days.length) return null;
  const wrap = el('div', 'observe');
  wrap.append(el('h4', 'card-kicker', '放好之后按天看'));
  const list = el('ol', 'observe-list');
  days.forEach((day, index) => {
    const dayNumber = day.day == null ? index + 1 : day.day;
    const item = el('li', 'observe-item');
    const dayHead = el('div', 'observe-day');
    dayHead.append(el('span', 'observe-day-num mono', 'DAY ' + dayNumber));
    dayHead.append(el('span', 'observe-title', day.title || `第 ${dayNumber} 天`));
    item.append(dayHead);
    const checks = Array.isArray(day.checks) ? day.checks.filter(Boolean) : [];
    if (checks.length) {
      const ul = el('ul', 'observe-checks');
      checks.forEach((text) => ul.append(el('li', null, String(text))));
      item.append(ul);
    }
    list.append(item);
  });
  wrap.append(list);
  return wrap;
}

function buildIfThenSection(ifThen) {
  const rows = (Array.isArray(ifThen) ? ifThen : []).filter((item) => item && (item.if || item.then));
  if (!rows.length) return null;
  const wrap = el('div', 'if-then');
  wrap.append(el('h4', 'card-kicker', '如果猫不用，就按这个改'));
  const list = el('ul', 'if-then-list');
  rows.forEach((item) => {
    const li = el('li', 'if-then-row');
    // 只放原文；「如果 / → 就」由 CSS ::before 补
    li.append(el('span', 'if-then-if', item.if || ''), el('span', 'if-then-then', item.then || ''));
    list.append(li);
  });
  wrap.append(list);
  return wrap;
}

export function planCard(plan, ctx = {}) {
  const data = plan || {};
  const card = makeCard('plan', 'card-plan');
  const headEl = head(card, el('span', 'badge l1', 'L1 · 可执行'), verdictEl(data.verdict));

  const canModify = typeof ctx.onRecalculate === 'function' || typeof ctx.onPickRegions === 'function';
  let modifyBtn = null;
  if (canModify) {
    modifyBtn = el('button', 'btn btn-modify');
    modifyBtn.type = 'button';
    modifyBtn.setAttribute('aria-expanded', 'false');
    const icon = el('span');
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
    modifyBtn.append(icon, document.createTextNode(' 改一改'));
    headEl.append(modifyBtn);
  }

  const body = el('div', 'card-body');
  body.append(el('div', 'plan-headline', data.headline || '方案已生成'));

  // V2 归属感：这份方案用了你量的 N 个数
  const used = Array.isArray(data.usedMeasurements) ? data.usedMeasurements.filter((m) => m && (m.label || m.key)) : [];
  if (used.length) {
    const line = el('div', 'ownership-line');
    const content = el('span');
    content.append(document.createTextNode('这份方案用了你量的 '));
    content.append(el('b', 'mono', String(used.length)));
    content.append(document.createTextNode(' 个数：'));
    used.forEach((measurement, index) => {
      if (index) content.append(document.createTextNode('、'));
      content.append(document.createTextNode(String(measurement.label || measureLabel(measurement.key)) + ' '));
      if (Number.isFinite(Number(measurement.valueCm))) {
        content.append(el('span', 'mono', fmtCm(measurement.valueCm) + 'cm'));
      }
    });
    line.append(content);
    body.append(line);
  }

  if (data.budget) {
    const budget = el('div', 'plan-budget');
    // 未设预算 / 预估为 0 时不要出现「预估 ¥0」这种半句
    if (data.budget.cap != null) {
      budget.append(el('span', null, '预算'));
      budget.append(el('strong', null, '¥' + data.budget.cap));
    }
    const estimate = Number(data.budget.est);
    if (Number.isFinite(estimate) && estimate > 0) {
      budget.append(el('span', null, '预估 ¥' + data.budget.est));
    }
    if (data.budget.status === 'over') budget.append(el('span', 'status-fail', '超出预算'));
    if (budget.childNodes.length) body.append(budget);
  }
  card.append(body);

  /* --- 标注 --- */
  const annotate = panelEl('annotate');
  const annotations = Array.isArray(data.annotations) ? data.annotations : [];
  if (annotations.length) {
    const list = el('div', 'annotation-list');
    annotations.forEach((annotation) => {
      const item = el('div', 'annotation-item');
      item.append(el('span', 'annotation-index', annotation.id == null ? '·' : String(annotation.id)));
      const main = el('div');
      main.append(el('strong', null, annotation.label || '标注'));
      if (annotation.note) main.append(el('div', 'annotation-note', annotation.note));
      item.append(main);
      list.append(item);
    });
    annotate.append(list);
  } else {
    annotate.append(el('p', 'disclaimer', '这张图暂时没有标注。'));
  }
  if (typeof ctx.onExport === 'function') {
    const actions = el('div', 'card-actions');
    const exportBtn = el('button', 'btn btn-primary', '导出标注图 PNG');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () => ctx.onExport());
    actions.append(exportBtn);
    annotate.append(actions);
  }

  /* --- 位置（V2 主判断） --- */
  const positionPanel = buildPositionPanel(data);

  /* --- 建议 --- */
  const itemsPanel = panelEl('items');
  const items = Array.isArray(data.items) ? data.items : [];
  const reuseCount = items.filter((item) => item.type === 'reuse').length;
  if (items.length) {
    const list = el('div', 'item-list');
    items.forEach((item) => {
      const row = el('div', 'item-row' + (item.type === 'reuse' ? ' is-reuse' : ''));
      const main = el('div', 'item-main');
      const top = el('div', 'item-top');
      top.append(el('span', 'item-title', item.title || '猫用品'));
      if (item.fit) top.append(el('span', item.fit === 'ok' ? 'fit-ok' : 'fit-blocked', item.fit === 'ok' ? '尺寸够' : item.fit === 'blocked' ? '放不下' : '待确认'));
      if (item.price != null) top.append(el('span', 'item-price', '¥' + item.price));
      main.append(top);

      const dims = [];
      if (item.dimsCm) {
        const d = item.dimsCm;
        dims.push(`${fmtCm(d.w)}×${fmtCm(d.d)}×${fmtCm(d.h)}cm`);
      }
      if (item.type === 'reuse') dims.unshift('复用现有');
      if (item.sku) dims.push(item.sku);
      if (dims.length) main.append(el('div', 'item-dims', dims.join(' · ')));
      if (item.why) main.append(el('p', 'item-why', item.why));
      if (item.fitNote) main.append(el('p', 'fit-note', item.fitNote));

      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (tags.length) {
        const tagRow = el('div', 'item-tags');
        tags.forEach((tag) => tagRow.append(el('span', 'item-tag', tag)));
        main.append(tagRow);
      }
      row.append(main);
      list.append(row);
    });
    itemsPanel.append(list);
    if (items.length) {
      itemsPanel.append(el('p', 'disclaimer', `不买东西也是方案：${items.length} 项里有 ${reuseCount} 项可以先复用家里的。`));
    }
  } else {
    itemsPanel.append(el('p', 'disclaimer', '这次没有推荐具体商品，先按尺寸条件调整现有布置。'));
  }

  const blockedItems = Array.isArray(data.blocked) ? data.blocked : [];
  if (blockedItems.length) {
    const title = el('h4', 'card-kicker', '这些先别买');
    itemsPanel.append(title);
    const list = el('div', 'blocked-list');
    blockedItems.forEach((blocked) => {
      const item = el('div', 'blocked-item');
      item.append(el('div', 'blocked-what', blocked.what || '这一项'));
      item.append(el('div', 'blocked-why', blocked.reason || ''));
      list.append(item);
    });
    itemsPanel.append(list);
  }

  /* --- 尺寸条件 --- */
  const constraintsPanel = panelEl('constraints');
  const constraints = Array.isArray(data.constraints) ? data.constraints : [];
  const STATUS = {
    pass: { glyph: '✅', text: '通过', cls: 'status-pass' },
    fail: { glyph: '❌', text: '不满足', cls: 'status-fail' },
    unknown: { glyph: '⚠️', text: '待确认', cls: 'status-unknown' },
  };
  if (constraints.length) {
    const list = el('div', 'constraint-list');
    constraints.forEach((constraint) => {
      const status = STATUS[constraint.status] || STATUS.unknown;
      const item = el('div', 'constraint');
      item.dataset.status = STATUS[constraint.status] ? constraint.status : 'unknown';
      item.append(el('span', 'c-label', constraint.label || measureLabel(constraint.key)));
      const valueParts = [`${opText(constraint.op)} ${fmtCm(constraint.valueCm)}cm`];
      if (constraint.actualCm != null) valueParts.push(`实测 ${fmtCm(constraint.actualCm)}cm`);
      item.append(el('span', 'c-value', valueParts.join(' · ')));
      item.append(el('span', 'c-status ' + status.cls, `${status.glyph} ${status.text}`));
      // V2.1 区间估计：按保守一端估算时明确说明
      if (constraint.estimate === true) {
        const conservative = constraint.actualCm != null ? constraint.actualCm : constraint.valueCm;
        item.append(el('span', 'constraint-estimate', `按 ${fmtCm(conservative)}cm 保守估算`));
      }
      // V2 依据徽章：查不到证据就不显示；honest 阈值标出「经验阈值」
      const basisBtn = basisBadge(constraint.basisId, constraint.honest === true);
      if (basisBtn) item.append(basisBtn);
      if (constraint.honest === true) item.append(el('span', 'constraint-note', '经验阈值，不同猫会有差异'));
      list.append(item);
    });
    constraintsPanel.append(list);
    const unknownConstraints = constraints.filter((c) => c.status === 'unknown');
    if (unknownConstraints.length) {
      const labels = unknownConstraints.map((c) => c.label || measureLabel(c.key)).join('、');
      constraintsPanel.append(el('p', 'constraint-next', `再量 ${labels}（约 30 秒）`));
    }
    const unknownCount = constraints.filter((c) => c.status !== 'pass').length;
    constraintsPanel.append(
      el('p', 'disclaimer', unknownCount ? `有 ${unknownCount} 项不是「通过」；别当成结论，落地前按清单量一遍。` : '所有尺寸条件都通过了，仍要现场确认。')
    );
  } else {
    constraintsPanel.append(el('p', 'disclaimer', '这次没有可计算的尺寸条件，先按现场清单确认。'));
  }

  /* --- 现场清单 --- */
  const checklistPanel = panelEl('checklist');
  const checklist = Array.isArray(data.checklist) ? data.checklist : [];
  if (checklist.length) {
    const progress = el('div', 'radar-row');
    progress.append(el('span', 'radar-key', '已确认'));
    const bar = el('div', 'radar-bar');
    const fill = el('i');
    fill.style.width = '0%';
    bar.append(fill);
    progress.append(bar);
    const count = el('span', 'radar-score', `0/${checklist.length}`);
    progress.append(count);
    checklistPanel.append(progress);

    const list = el('div', 'checklist');
    checklist.forEach((item) => {
      const li = el('li', 'check-item');
      li.setAttribute('role', 'checkbox');
      li.setAttribute('aria-checked', 'false');
      li.tabIndex = 0;
      const box = el('span', 'check-box');
      const text = el('span', 'check-text', item.text || '');
      li.append(box, text);
      if (item.critical) li.append(el('span', 'check-critical', '关键'));

      const toggle = () => {
        const on = li.getAttribute('aria-checked') !== 'true';
        li.setAttribute('aria-checked', on ? 'true' : 'false');
        li.classList.toggle('is-done', on);
        item._checked = on;
        update();
        if (typeof ctx.onToggleCheck === 'function') ctx.onToggleCheck(item.id, on);
      };
      li.addEventListener('click', toggle);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          toggle();
        }
      });
      list.append(li);
    });
    checklistPanel.append(list);

    function update() {
      const done = checklist.filter((item) => item._checked).length;
      fill.style.width = (done / checklist.length) * 100 + '%';
      count.textContent = `${done}/${checklist.length}`;
    }

    const actions = el('div', 'card-actions');
    const copyBtn = el('button', 'btn btn-ghost', '复制现场清单');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      const lines = checklist.map((item, index) => `${index + 1}. ${item.text || ''}${item.critical ? '（关键）' : ''}`);
      const text = [data.headline || '', '', ...lines, '', data.disclaimer || DISCLAIMER_L1].filter(Boolean).join('\n');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          notify('清单已复制');
        } else {
          notify('浏览器不支持剪贴板，截图这一块也可以');
        }
      } catch {
        notify('复制失败，可以手动截图清单');
      }
    });
    actions.append(copyBtn);
    checklistPanel.append(actions);
  } else {
    checklistPanel.append(el('p', 'disclaimer', '没有额外的现场清单项。'));
  }

  // V2：观察清单（按天）+ if-then；旧会话没有 observe 时回退 aftercare
  const observeSection = buildObserveSection(data.observe);
  if (observeSection) checklistPanel.append(observeSection);
  const ifThenSection = buildIfThenSection(data.ifThen);
  if (ifThenSection) checklistPanel.append(ifThenSection);
  if (!observeSection) {
    const aftercare = data.aftercare && typeof data.aftercare === 'object' ? data.aftercare : null;
    if (aftercare && (aftercare.day7 || aftercare.day14)) {
      const wrap = el('div', 'aftercare');
      if (aftercare.day7) {
        const row = el('div', 'aftercare-row');
        row.append(el('span', 'aftercare-day', 'DAY 7'), el('span', null, aftercare.day7));
        wrap.append(row);
      }
      if (aftercare.day14) {
        const row = el('div', 'aftercare-row');
        row.append(el('span', 'aftercare-day', 'DAY 14'), el('span', null, aftercare.day14));
        wrap.append(row);
      }
      checklistPanel.append(wrap);
    }
  }

  // V2.1「改一改」：就地编辑 + 重算，不新开弹窗
  let modifyPanel = null;

  function buildModifyPanel() {
    const panel = el('div', 'plan-modify');
    panel.hidden = true;
    panel.append(el('div', 'plan-modify-head', '改一改，就地重算'));

    // 改尺寸
    if (used.length) {
      const section = el('div', 'plan-modify-section');
      section.append(el('h4', null, '改尺寸（cm）'));
      const rows = used.map((measurement) => {
        const row = el('label', 'plan-modify-row');
        row.append(el('span', null, measurement.label || measureLabel(measurement.key)));
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.className = 'm-input';
        input.inputMode = 'decimal';
        input.value = Number.isFinite(Number(measurement.valueCm)) ? String(measurement.valueCm) : '';
        row.append(input, el('span', 'm-unit', 'cm'));
        return { measurement, input, row };
      });
      rows.forEach((entry) => section.append(entry.row));
      const saveBtn = el('button', 'btn btn-primary', '保存并重算');
      saveBtn.type = 'button';
      saveBtn.addEventListener('click', () => {
        const measurements = {};
        rows.forEach((entry) => {
          const value = parseCm(entry.input.value);
          if (value != null) measurements[entry.measurement.key] = value;
        });
        if (!Object.keys(measurements).length) {
          notify('先改一个数再重算');
          return;
        }
        const original = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.textContent = '重算中…';
        const pending = ctx.onRecalculate({ measurements });
        Promise.resolve(pending)
          .catch(() => {})
          .finally(() => {
            saveBtn.disabled = false;
            saveBtn.textContent = original;
          });
      });
      section.append(saveBtn);
      panel.append(section);
    }

    // 换方向重算
    const directions = Array.isArray(ctx.directions) ? ctx.directions.slice(0, 3) : [];
    if (directions.length && typeof ctx.onRecalculate === 'function') {
      const section = el('div', 'plan-modify-section');
      section.append(el('h4', null, '换方向重算'));
      const row = el('div', 'plan-modify-chips');
      const current = ctx.chosenDirectionId == null ? null : String(ctx.chosenDirectionId);
      directions.forEach((direction) => {
        const title = direction.title || '方向 ' + (direction.id || '');
        const btn = el('button', 'btn btn-chip', title);
        btn.type = 'button';
        if (current != null && String(direction.id) === current) btn.setAttribute('aria-pressed', 'true');
        btn.addEventListener('click', () => {
          Array.from(row.children).forEach((child) => child.setAttribute('aria-pressed', child === btn ? 'true' : 'false'));
          btn.disabled = true;
          btn.textContent = '重算中…';
          const pending = ctx.onRecalculate({ directionId: direction.id });
          Promise.resolve(pending)
            .catch(() => {})
            .finally(() => {
              btn.disabled = false;
              btn.textContent = title;
            });
        });
        row.append(btn);
      });
      section.append(row);
      panel.append(section);
    }

    // 调整热区
    if (typeof ctx.onPickRegions === 'function') {
      const section = el('div', 'plan-modify-section');
      section.append(el('h4', null, '调整热区'));
      section.append(el('p', 'disclaimer', '在画布上点选新的落点，会重新评估并更新标注。'));
      const btn = el('button', 'btn btn-ghost', '在画布上点选新位置');
      btn.type = 'button';
      btn.addEventListener('click', () => ctx.onPickRegions());
      section.append(btn);
      panel.append(section);
    }
    return panel;
  }

  const panels = {
    annotate,
    position: positionPanel,
    constraints: constraintsPanel,
    items: itemsPanel,
    checklist: checklistPanel,
  };
  const tabs = buildTabs(
    [
      ['annotate', '标注'],
      ['position', '位置'],
      ['constraints', '尺寸条件'],
      ['items', '建议'],
      ['checklist', '清单'],
    ],
    panels,
    ctx.onTab
  );
  card.append(tabs.nav, tabs.wrap);

  if (modifyBtn) {
    modifyBtn.addEventListener('click', () => {
      if (!modifyPanel) {
        modifyPanel = buildModifyPanel();
        card.insertBefore(modifyPanel, tabs.nav);
      }
      const show = modifyPanel.hidden;
      modifyPanel.hidden = !show;
      modifyBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    });
  }

  const footEl = foot(card, data.disclaimer || DISCLAIMER_L1);
  if (typeof ctx.onExport === 'function') {
    const exportBtn = el('button', 'btn btn-ghost', '导出');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () => ctx.onExport());
    footActions(footEl).append(exportBtn);
  }
  tabs.activate('annotate');
  return card;
}

/* ================================================================== 轻结论卡 */

export function verdictCard(v) {
  const data = typeof v === 'string' ? { headline: v } : v || {};
  const card = makeCard('verdict', 'card-verdict');
  const body = el('div', 'card-body');

  const line = el('div', 'verdict-line');
  line.append(verdictEl(data.verdict || (data.headline ? 'insufficient' : 'insufficient')));
  const headline = data.headline || data.reply || '';
  if (headline) line.append(el('span', null, headline));
  body.append(line);

  const reason = data.verdictReason || data.reason || '';
  if (reason && reason !== headline) body.append(el('p', 'verdict-reason', reason));

  const detail = data.detail || '';
  if (detail) {
    const details = document.createElement('details');
    details.className = 'think';
    const summary = document.createElement('summary');
    summary.textContent = '展开依据';
    details.append(summary, el('div', 'think-body', detail));
    body.append(details);
  }

  card.append(body);
  return card;
}

/* ================================================================== 阻断卡 */

export function blockedCard(items) {
  const data = Array.isArray(items) ? items : items && Array.isArray(items.blocked) ? items.blocked : [];
  const card = makeCard('blocked', 'card-blocked');
  head(card, el('span', 'card-kicker', '阻断项'));

  const body = el('div', 'card-body');
  body.append(el('p', null, '下面这些现在别做：条件还不成立，做了也放不稳。'));
  const list = el('div', 'blocked-list');
  data.forEach((item) => {
    const node = el('div', 'blocked-item');
    node.append(el('div', 'blocked-what', item.what || item.label || '这一项'));
    if (item.reason) node.append(el('div', 'blocked-why', item.reason));
    if (item.condition) node.append(el('div', 'blocked-why', '什么条件下才可能行：' + item.condition));
    list.append(node);
  });
  body.append(list);
  card.append(body);
  foot(card, '先把阻断项解决，再回来继续。');
  return card;
}

/* ================================================================ 等待卡 */
// plan 阶段可能 8—20 秒：阶段文案 + 骨架屏 + 渐近进度（最多到 95%，不假装 100%）。

export function waitCard(label, opts = {}) {
  const estimateMs = Number(opts.estimateMs) || 12000;
  const hintBase = opts.hint || '正在跑模型；最慢 20 秒，不用刷新。';
  const card = makeCard('wait', 'card-wait');
  head(card, el('span', 'card-kicker', '进行中'), el('span', 'chip', label || '正在处理…'));

  const body = el('div', 'card-body');
  const sk1 = el('div', 'skeleton skeleton-line');
  sk1.style.setProperty('--w', '86%');
  const sk2 = el('div', 'skeleton skeleton-line');
  sk2.style.setProperty('--w', '58%');
  const bar = el('div', 'progress on-paper');
  const fill = el('i');
  fill.style.width = '60%';
  bar.append(fill);
  const note = el('p', 'disclaimer', hintBase);
  body.append(sk1, sk2, bar, note);
  card.append(body);

  const started = Date.now();
  let timer = null;

  function tick() {
    const elapsed = Date.now() - started;
    // 60% → 95% 渐近；越接近结束越慢，不跳到 100%
    const pct = Math.min(95, 60 + 35 * (1 - Math.exp(-elapsed / 9000)));
    fill.style.width = pct.toFixed(1) + '%';
    if (elapsed < estimateMs) {
      const left = Math.max(1, Math.ceil((estimateMs - elapsed) / 1000));
      note.textContent = `正在整理；大概还要 ${left} 秒。`;
    } else {
      note.textContent = '比预计稍慢一点，不要刷新，结果马上到。';
    }
  }

  tick();
  timer = setInterval(tick, 500);

  return {
    el: card,
    finish() {
      if (timer) clearInterval(timer);
      timer = null;
      tick();
      fill.style.width = '100%';
      setTimeout(() => card.remove(), 500);
    },
    fail() {
      if (timer) clearInterval(timer);
      timer = null;
      card.remove();
    },
  };
}

/* ================================================================== 错误卡 */
export function errorCard(message, ctx = {}) {
  const card = makeCard('error', 'card-error');
  head(card, el('span', 'card-kicker', '这一步没跑通'));
  const body = el('div', 'card-body');
  body.append(el('p', null, message || '服务暂时不可用，稍后再试。'));
  card.append(body);
  const footEl = foot(card, '这一步失败不会丢失已上传的照片和已量尺寸。');
  const actions = footActions(footEl);
  if (typeof ctx.onRetry === 'function') {
    const retry = el('button', 'btn btn-primary', '重试这一步');
    retry.type = 'button';
    retry.addEventListener('click', () => ctx.onRetry());
    actions.append(retry);
  }
  const help = el('button', 'btn btn-ghost', '看看怎么用');
  help.type = 'button';
  help.addEventListener('click', () => {
    const helpBtn = document.getElementById('btn-help');
    if (helpBtn) helpBtn.click();
  });
  actions.append(help);
  return card;
}
