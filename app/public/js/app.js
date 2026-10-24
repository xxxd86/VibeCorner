// app.js — 启动 + DOM 事件绑定（唯一入口）。
// 负责：会话列表 / 切换 / toast / modal / stage-chip / 右侧 dock / 抽屉 / 错误横幅 / ?demo=1。

import * as api from './api.js';
import { state, setState, subscribe } from './state.js';
import {
  initCanvas,
  setPickMode,
  onPick,
  zoom,
  exportPNG,
  clear as clearCanvas,
} from './canvas.js';
import * as flow from './flow.js';
import { clearFeed, addWelcome } from './feed.js';
import * as cardsModule from './cards.js';

const REQUIRED_IDS = [
  'app', 'rail', 'brand', 'btn-new', 'session-list', 'btn-privacy', 'stage', 'stage-title', 'stage-chip',
  'btn-help', 'btn-panel-toggle', 'feed', 'composer', 'suggest-chips', 'composer-box', 'btn-attach',
  'file-input', 'composer-input', 'btn-send', 'composer-foot', 'canvas-panel', 'canvas-badge',
  'panel-empty', 'canvas-stage', 'scene-canvas', 'canvas-hint', 'canvas-toolbar', 'btn-zoom-out',
  'btn-zoom-fit', 'btn-zoom-in', 'btn-pick-mode', 'measure-dock', 'measure-progress',
  'measure-progress-bar', 'measure-dock-list', 'deliver-dock', 'btn-deliver', 'btn-export',
  'toast-host', 'modal-host', 'dev-error-banner',
];

const STAGE_CHIP = {
  empty: { text: '未开始', cls: 'chip' },
  uploaded: { text: '照片已上传', cls: 'chip' },
  quality: { text: '照片已质检', cls: 'chip' },
  l0: { text: 'L0 · 方向预览', cls: 'chip chip-l0' },
  measuring: { text: '测量中', cls: 'chip chip-warn' },
  ready: { text: '可以出方案', cls: 'chip chip-warn' },
  delivered: { text: 'L1 · 可执行', cls: 'chip chip-l1' },
};

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

// chips 文案压到 ≤6 字，手机端单行放得下；点击后填入更完整的一句
const SUGGESTIONS = [
  ['通道多宽', '通道到底要多宽'],
  ['门口能放吗', '猫砂盆放门口行吗'],
  ['窗边晒吗', '窗边会不会太晒'],
  ['预算 300', '预算 300 以内，先复用家里有的'],
];

const $ = (id) => document.getElementById(id);

let booted = false;
let unlocking = false;

/* ------------------------------------------------------------------ 小工具 */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function toast(text, opts = {}) {
  const host = $('toast-host');
  if (!host) return;
  const node = el('div', 'toast' + (opts.tone ? ' ' + opts.tone : ''), text);
  host.append(node);
  const life = typeof opts.ms === 'number' ? opts.ms : 2600;
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 260);
  }, life);
}

/** 让 toast 始终浮在输入中枢之上，不压 chips / 输入框 / 发送键 */
function layoutToastHost() {
  const host = $('toast-host');
  const composer = $('composer');
  if (!host || !composer) return;
  const rect = composer.getBoundingClientRect();
  const height = window.innerHeight - rect.top;
  if (!Number.isFinite(height) || height <= 0) return;
  host.style.bottom = Math.round(height + 12) + 'px';
}

/* ============================================================ 猫档案（V2） */

const CAT_PROFILE_DEFAULTS = { catSize: 'medium', catAge: 'adult', cats: 1, multiCat: false, floorType: 'unknown' };
const PROFILE_GROUP_FIELDS = ['catSize', 'catAge', 'cats', 'floorType'];
const CAT_SIZE_TEXT = { small: '小型', medium: '中型', large: '大型' };

let catProfileTemplate = null;
let modalOnClose = null;

function currentProfile() {
  const base = (state.session && state.session.profile) || {};
  return Object.assign({}, CAT_PROFILE_DEFAULTS, base, state.profileDraft || {});
}

function profileSummary(profile) {
  const size = CAT_SIZE_TEXT[profile.catSize] || '中型';
  const cats = Number(profile.cats) || 1;
  return `猫：${size} · ${cats >= 3 ? '3 只以上' : cats + ' 只'}`;
}

function updateProfileChip() {
  const chip = $('btn-cat-profile');
  if (!chip) return;
  const span = chip.querySelector('span');
  if (span) span.textContent = profileSummary(currentProfile());
}

/** 启动时把 #cat-profile-form 模板从 #modal-host 救出来，避免 openModal 清空 host 时丢掉 */
function captureProfileTemplate() {
  const form = document.getElementById('cat-profile-form');
  if (!form) return;
  catProfileTemplate = form;
  const host = $('modal-host');
  if (host && host.contains(form) && form.parentElement) {
    form.parentElement.removeChild(form);
  }
}

function buildFallbackProfileForm() {
  const form = el('div', 'cat-profile-form');
  const groups = [
    ['catSize', '猫的体型', [['small', '小型'], ['medium', '中型'], ['large', '大型']]],
    ['catAge', '年龄段', [['kitten', '幼猫'], ['adult', '成年'], ['senior', '老年']]],
    ['cats', '猫的数量', [['1', '1 只'], ['2', '2 只'], ['3', '3 只以上']]],
    ['floorType', '地面材质', [['wood', '木地板'], ['tile', '瓷砖'], ['carpet', '地毯']]],
  ];
  groups.forEach(([field, label, options]) => {
    const group = el('div', 'cpf-group');
    group.dataset.field = field;
    group.append(el('div', 'cpf-label', label));
    const row = el('div', 'cpf-options');
    options.forEach(([value, text]) => {
      const btn = el('button', 'cpf-option', text);
      btn.type = 'button';
      btn.dataset.value = value;
      row.append(btn);
    });
    group.append(row);
    form.append(group);
  });
  ['catSize', 'catAge', 'cats', 'multiCat', 'floorType'].forEach((name) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    form.append(input);
  });
  return form;
}

function wireProfileForm(form) {
  const profile = currentProfile();
  ['catSize', 'catAge', 'cats', 'multiCat', 'floorType'].forEach((name) => {
    const input = form.querySelector(`input[name="${name}"]`);
    if (!input) return;
    if (name === 'multiCat') input.value = profile.multiCat ? 'true' : '';
    else input.value = profile[name] == null ? '' : String(profile[name]);
  });

  const groups = Array.from(form.querySelectorAll('.cpf-group'));
  groups.forEach((group, index) => {
    const field = group.dataset.field || PROFILE_GROUP_FIELDS[index] || 'floorType';
    const buttons = Array.from(group.querySelectorAll('.cpf-option'));
    const current = String(profile[field] == null ? '' : profile[field]);
    buttons.forEach((btn) => {
      const value = String(btn.dataset.value == null ? btn.textContent : btn.dataset.value).trim();
      btn.setAttribute('aria-pressed', value === current ? 'true' : 'false');
      btn.addEventListener('click', () => {
        buttons.forEach((other) => other.setAttribute('aria-pressed', other === btn ? 'true' : 'false'));
        const input = form.querySelector(`input[name="${field}"]`);
        if (input) input.value = value;
      });
    });
  });
}

function saveProfileForm(form) {
  if (!form) return;
  const next = {};
  ['catSize', 'catAge', 'floorType'].forEach((name) => {
    const input = form.querySelector(`input[name="${name}"]`);
    if (input && input.value) next[name] = input.value;
  });
  const catsInput = form.querySelector('input[name="cats"]');
  const cats = Number(catsInput && catsInput.value);
  next.cats = Number.isFinite(cats) && cats > 0 ? cats : 1;
  const multiInput = form.querySelector('input[name="multiCat"]');
  next.multiCat = Boolean(multiInput && (multiInput.value === 'true' || multiInput.checked === true));

  const merged = Object.assign({}, currentProfile(), next);
  setState({ profileDraft: merged });
  if (state.session) {
    const session = Object.assign({}, state.session, {
      profile: Object.assign({}, state.session.profile || {}, next),
    });
    setState({ session });
  }
  updateProfileChip();
  toast('猫档案已保存，会用在后面的判断里', { tone: 'ok' });
}

function openCatProfile() {
  const template = catProfileTemplate || document.getElementById('cat-profile-form');
  const usingFallback = !template;
  const form = template ? template.cloneNode(true) : buildFallbackProfileForm();
  form.removeAttribute('id');
  form.hidden = false;
  form.removeAttribute('hidden');
  form.style.display = '';
  if (!form.classList.contains('cat-profile-form')) form.classList.add('cat-profile-form');

  openModal(
    '猫档案',
    (body) => {
      // 模板自带 cpf-intro；只有兜底表单才补一句说明
      if (usingFallback) {
        body.append(
          el('p', 'modal-note', '这几项会改变尺寸阈值的判定：体型影响砂盆和通道，年龄影响台阶高低，数量影响资源是否要分开。')
        );
      }
      body.append(form);
      wireProfileForm(form);
    },
    {
      actions: [
        { label: '取消' },
        {
          label: '保存',
          primary: true,
          onClick: () => {
            saveProfileForm(form);
          },
        },
      ],
      onClose: () => {
        form.remove();
      },
    }
  );
}

/* ============================================================ 依据 popover（V2） */

let activeBasisBadge = null;

function ensureBasisPopover() {
  let pop = document.getElementById('basis-popover');
  if (!pop) {
    pop = el('div', 'basis-popover');
    pop.id = 'basis-popover';
    pop.dataset.open = 'false';
    pop.setAttribute('role', 'dialog');
    pop.style.position = 'fixed';
    pop.style.zIndex = '110';
    document.body.append(pop);
  }
  if (!pop.dataset.open) pop.dataset.open = 'false';
  return pop;
}

function closeBasisPopover() {
  const pop = document.getElementById('basis-popover');
  if (activeBasisBadge) {
    activeBasisBadge.setAttribute('aria-expanded', 'false');
    activeBasisBadge = null;
  }
  if (!pop) return;
  pop.dataset.open = 'false';
  pop.textContent = '';
}

function positionBasisPopover(pop, badge) {
  const badgeRect = badge.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const margin = 8;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(popRect.width || 320, vw - margin * 2);

  let left = badgeRect.left + badgeRect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(vw - width - margin, left));

  let placement = 'bottom';
  let top = badgeRect.bottom + gap;
  if (top + popRect.height > vh - margin) {
    if (badgeRect.top - gap - popRect.height >= margin) {
      placement = 'top';
      top = badgeRect.top - gap - popRect.height;
    } else {
      top = Math.max(margin, vh - margin - popRect.height);
    }
  }
  pop.dataset.placement = placement;
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
  const arrowX = Math.max(12, Math.min(width - 12, badgeRect.left + badgeRect.width / 2 - left));
  pop.style.setProperty('--arrow-x', Math.round(arrowX) + 'px');
}

function openBasisPopover(badge) {
  const pop = ensureBasisPopover();
  if (activeBasisBadge === badge && pop.dataset.open === 'true') {
    closeBasisPopover();
    return;
  }
  if (activeBasisBadge) activeBasisBadge.setAttribute('aria-expanded', 'false');
  activeBasisBadge = badge;
  badge.setAttribute('aria-expanded', 'true');

  pop.textContent = '';
  // ui-shell 在 #basis-popover 内留了 .basis-pop-body 负责滚动/卡片底；内容写进它
  const body = el('div', 'basis-pop-body');
  pop.append(body);

  const headEl = el('div', 'basis-pop-head');
  const tag = el('span', 'basis-badge', badge.dataset.label || badge.textContent || '依据');
  tag.dataset.kind = badge.dataset.kind || 'consensus';
  if (badge.dataset.basisId) tag.dataset.basisId = badge.dataset.basisId;
  const closeBtn = el('button', 'basis-pop-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭依据');
  closeBtn.addEventListener('click', closeBasisPopover);
  headEl.append(tag, closeBtn);

  const title = el('div', 'basis-pop-title', badge.dataset.topic || '这条建议的依据');
  const claim = el('p', 'basis-pop-claim', badge.dataset.claim || '这条建议来自经验判断，不同猫会有差异。');
  body.append(headEl, title, claim);

  if (badge.dataset.source) {
    if (badge.dataset.url) {
      const link = el('a', 'basis-pop-source', badge.dataset.source);
      link.href = badge.dataset.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      body.append(link);
    } else {
      body.append(el('div', 'basis-pop-source', badge.dataset.source));
    }
  }
  if (badge.dataset.caveat) body.append(el('p', 'basis-pop-caveat', badge.dataset.caveat));
  if (badge.dataset.honest === 'true') {
    body.append(el('p', 'constraint-note', '经验阈值，不同猫会有差异'));
  }

  pop.dataset.open = 'true';
  positionBasisPopover(pop, badge);
}

function handleBasisClick(target) {
  const badge = target.closest('.basis-badge');
  if (badge) {
    openBasisPopover(badge);
    return true;
  }
  if (target.closest('.basis-pop-close')) {
    closeBasisPopover();
    return true;
  }
  const pop = document.getElementById('basis-popover');
  if (pop && pop.dataset.open === 'true' && !pop.contains(target)) closeBasisPopover();
  return false;
}

function reportError(err) {
  if (err && err.name === 'ApiError') return; // 接口错误统一走 corner:api-error
  const banner = $('dev-error-banner');
  if (!banner) return;
  const msg = err && err.stack ? err.stack : err && err.message ? err.message : String(err);
  banner.hidden = false;
  banner.textContent = 'JS 错误：' + msg;
}

function reportApiError(detail) {
  const banner = $('dev-error-banner');
  if (!banner) return;
  const status = detail && detail.status ? `HTTP ${detail.status}` : '网络';
  banner.hidden = false;
  banner.textContent = `接口错误（${status}）：${(detail && detail.message) || '请求失败'}`;
}

function guard(fn) {
  return function guarded(...args) {
    try {
      const result = fn.apply(this, args);
      if (result && typeof result.then === 'function') result.catch((err) => reportError(err));
      return result;
    } catch (err) {
      reportError(err);
      return undefined;
    }
  };
}

function measureLabel(key) {
  return MEASURE_LABELS[key] || key;
}

function stageLabel(stage) {
  const map = {
    empty: '未开始',
    uploaded: '已上传',
    quality: '已质检',
    l0: 'L0 方向',
    measuring: '测量中',
    ready: '待出方案',
    delivered: 'L1 已交付',
  };
  return map[stage] || '未开始';
}

/* ------------------------------------------------------------------ 渲染 */

function render() {
  renderChip();
  renderRail();
  renderCanvasPanel();
  renderMeasureDock();
  renderDeliverDock();
  renderPickButton();
  renderComposerChrome();
  updateProfileChip();
  layoutToastHost();
}

/** V3.1 composer：有会话内容后手机进入 compact，chips 只在欢迎态显示 */
function renderComposerChrome() {
  const composer = $('composer');
  if (!composer) return;
  const mobile =
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 899px)').matches;
  const hasContent = Boolean(state.session);
  const compact = mobile && hasContent;
  composer.dataset.compact = compact ? 'true' : 'false';
  const chips = $('suggest-chips');
  if (chips) chips.hidden = compact;
}

function renderChip() {
  const title = $('stage-title');
  if (title) title.textContent = (state.session && state.session.title) || '新的角落';
  const chip = $('stage-chip');
  if (!chip) return;
  const info = STAGE_CHIP[state.stage] || STAGE_CHIP.empty;
  chip.className = info.cls;
  chip.textContent = info.text;
}

/** V3.1 手机 rail：会话抽屉（点 #rail 空白 scrim 或会话项关闭） */
function setRailDrawer(open) {
  const rail = $('rail');
  if (!rail) return;
  rail.dataset.open = open ? 'true' : 'false';
  const btn = $('btn-sessions');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

function toggleRailDrawer() {
  const rail = $('rail');
  if (!rail) return;
  setRailDrawer(rail.dataset.open !== 'true');
}

function renderRail() {
  const list = $('session-list');
  if (!list) return;
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const currentId = state.session ? state.session.id : '';
  const sig = sessions.map((s) => `${s.id}:${s.updatedAt || ''}:${s.title || ''}`).join('|') + '#' + currentId;
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.textContent = ''; // 空列表交给 CSS :empty::after
  sessions.forEach((session) => {
    const item = el('div', 'session-item' + (session.id === currentId ? ' is-active' : ''));
    item.dataset.id = session.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    if (session.id === currentId) item.setAttribute('aria-current', 'page');
    item.append(el('span', 's-title', session.title || '未命名角落'));
    item.append(el('span', 's-meta', stageLabel(session.stage)));

    const del = el('button', 'session-del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', '删除这个角落');
    del.addEventListener(
      'click',
      guard(async (ev) => {
        ev.stopPropagation();
        await confirmDelete(del, session.id);
      })
    );
    item.append(del);

    item.addEventListener(
      'click',
      guard(async () => {
        if (state.busy) {
          toast('等当前这一步跑完再切换');
          return;
        }
        await openSession(session.id);
      })
    );
    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        item.click();
      }
    });
    list.append(item);
  });
}

function renderCanvasPanel() {
  const panel = $('canvas-panel');
  if (!panel) return;
  const session = state.session;
  const hasImage = Boolean(session && session.image);
  panel.dataset.empty = hasImage ? 'false' : 'true';
  panel.dataset.open = state.panelOpen ? 'true' : 'false';
  const mobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 899px)').matches;
  panel.dataset.viewer = state.panelOpen && mobile ? 'true' : 'false';

  const stageEl = $('canvas-stage');
  if (stageEl) stageEl.dataset.visible = hasImage ? 'true' : 'false';

  const badge = $('canvas-badge');
  if (!badge) return;
  let text = '未上传';
  let cls = 'chip';
  if (hasImage) {
    const plan = session.plan;
    const l0 = session.l0;
    if (plan && Array.isArray(plan.annotations) && plan.annotations.length) {
      text = `L1 · ${plan.annotations.length} 处标注`;
      cls = 'chip chip-l1';
    } else if (l0 && Array.isArray(l0.regions) && l0.regions.length) {
      text = `L0 · ${l0.regions.length} 个区域`;
      cls = 'chip chip-l0';
    } else {
      text = '已上传';
    }
  }
  badge.textContent = text;
  badge.className = cls;
}

function renderMeasureDock() {
  const dock = $('measure-dock');
  if (!dock) return;
  const session = state.session;
  const asks = session && Array.isArray(session.asks) ? session.asks : [];
  const measurements = (session && session.measurements) || {};
  const answered = Object.keys(measurements).length;
  const lastAsk = asks[asks.length - 1];
  const remaining = lastAsk && Array.isArray(lastAsk.remainingKeys) ? lastAsk.remainingKeys : [];
  const total = answered + remaining.length;
  const show = Boolean(session) && asks.length > 0 && state.stage === 'measuring';
  dock.dataset.visible = show ? 'true' : 'false';

  const progress = $('measure-progress');
  const bar = $('measure-progress-bar');
  const done = Boolean(session && session.measureDone);
  // V2.1 进度口径：照片算第 1 步，与测量卡一致（flow 在 measure 返回时写入 measureProgress）
  const measureProgress = session && session.measureProgress;
  if (measureProgress && Number.isFinite(Number(measureProgress.total)) && Number(measureProgress.total) > 0) {
    const shownDone = Math.min(Number(measureProgress.total), Math.max(0, Number(measureProgress.done) || 0));
    if (progress) progress.textContent = done ? '完成' : `${shownDone}/${measureProgress.total}`;
    if (bar) bar.style.width = Math.round((shownDone / Number(measureProgress.total)) * 100) + '%';
  } else {
    const pct = done ? 100 : total ? Math.round((answered / total) * 100) : answered ? 100 : 0;
    if (progress) progress.textContent = done ? '完成' : `${answered}/${total || answered}`;
    if (bar) bar.style.width = pct + '%';
  }

  const listEl = $('measure-dock-list');
  if (!listEl) return;
  const sig = asks.map((a) => `${a.round}:${(a.questions || []).length}`).join('|') + `#${answered}#${done}`;
  if (listEl.dataset.sig === sig) return;
  listEl.dataset.sig = sig;
  listEl.textContent = '';
  asks.forEach((ask) => {
    const labels = (ask.questions || []).map((q) => q.label || measureLabel(q.key)).join(' / ');
    const answeredThis = ask.answers && Object.keys(ask.answers).length > 0;
    const row = el('div', 'dock-item' + (labels ? '' : ' is-missing'));
    row.append(el('span', 'dock-label', `第 ${ask.round || '?'} 步 · ${labels || '测量完成'}`));
    row.append(el('span', 'dock-value', answeredThis ? '已量' : '待量'));
    listEl.append(row);
  });
  remaining.forEach((key) => {
    const row = el('div', 'dock-item is-missing');
    row.append(el('span', 'dock-label', '还差 · ' + measureLabel(key)));
    row.append(el('span', 'dock-value', '待量'));
    listEl.append(row);
  });
  if (!asks.length) listEl.append(el('div', 'dock-item is-missing', '还没有开始测量'));
}

function renderDeliverDock() {
  const dock = $('deliver-dock');
  if (!dock) return;
  const visible = state.stage === 'ready' || state.stage === 'delivered';
  dock.dataset.visible = visible ? 'true' : 'false';
  dock.dataset.state = state.stage === 'delivered' ? 'done' : '';

  const deliver = $('btn-deliver');
  if (deliver) {
    deliver.disabled = Boolean(state.busy);
    deliver.textContent = state.stage === 'delivered' ? '重新生成方案' : '生成可执行方案';
  }
  // 中栏内联主按钮（promptPlan 动态生成）：交付后整条收起，避免 feed 顶部挂一个大按钮
  const inline = $('btn-deliver-inline');
  if (inline) {
    const inlineCard = inline.closest('.card');
    const done = state.stage === 'delivered';
    if (inlineCard) inlineCard.hidden = done;
    inline.hidden = done;
    if (!done) {
      inline.disabled = Boolean(state.busy);
      inline.textContent = '生成可执行方案';
    }
  }
  const exportBtn = $('btn-export');
  if (exportBtn) exportBtn.disabled = !(state.session && state.session.plan);
}

function renderPickButton() {
  const btn = $('btn-pick-mode');
  if (!btn) return;
  btn.setAttribute('aria-pressed', state.pickMode ? 'true' : 'false');
  const span = btn.querySelector('span');
  if (span) span.textContent = state.pickMode ? '退出点选' : '点选位置';
}

function renderSuggestChips() {
  const host = $('suggest-chips');
  if (!host) return;
  host.textContent = '';
  SUGGESTIONS.forEach(([short, full]) => {
    const btn = el('button', 'suggest-chip', short);
    btn.type = 'button';
    btn.addEventListener(
      'click',
      guard(() => {
        const input = $('composer-input');
        if (!input) return;
        input.value = full || short;
        autogrow(input);
        input.focus();
      })
    );
    host.append(btn);
  });
}

/* ------------------------------------------------------------------ 会话 */

async function refreshSessions() {
  try {
    const list = await api.listSessions();
    setState({ sessions: Array.isArray(list) ? list : [] });
  } catch (err) {
    if (err && err.name !== 'ApiError') throw err;
  }
}

async function openSession(id) {
  if (!id) return;
  setRailDrawer(false);
  const session = await api.getSession(id);
  clearFeed();
  clearCanvas();
  setPickMode(false);
  setState({ pickMode: false, panelOpen: false });
  await flow.replaySession(session); // CONTRACT §5.8：纯本地重放，不发模型请求
  await refreshSessions();
}

async function confirmDelete(btn, id) {
  if (btn.dataset.armed === '1') {
    await api.deleteSession(id);
    if (state.session && state.session.id === id) {
      clearFeed();
      clearCanvas();
      setPickMode(false);
      setState({ session: null, stage: 'empty', pickMode: false });
      addWelcome();
    }
    await refreshSessions();
    toast('已删除这个角落和它的照片', { tone: 'ok' });
    return;
  }
  btn.dataset.armed = '1';
  btn.textContent = '删';
  setTimeout(() => {
    if (btn.isConnected) {
      btn.dataset.armed = '';
      btn.textContent = '×';
    }
  }, 2600);
}

/* ------------------------------------------------------------------ 模态 */

function closeModal() {
  const host = $('modal-host');
  const onClose = modalOnClose;
  modalOnClose = null;
  const wasShareSheet = shareSheetOpen;
  shareSheetOpen = false;
  if (host) {
    host.dataset.open = 'false';
    host.textContent = '';
  }
  if (typeof onClose === 'function') {
    try {
      onClose();
    } catch (err) {
      reportError(err);
    }
  }
  if (wasShareSheet) {
    try {
      flow.notifyShareClosed();
    } catch (err) {
      reportError(err);
    }
  }
}

function openModal(title, buildBody, opts = {}) {
  const host = $('modal-host');
  if (!host) return;
  shareSheetOpen = false;
  host.textContent = '';
  const sheet = el('div', 'modal');
  const headEl = el('div', 'modal-head');
  const heading = el('h2', 'modal-title', title);
  const close = el('button', 'modal-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', closeModal);
  headEl.append(heading, close);

  const body = el('div', 'modal-body');
  buildBody(body);

  const footEl = el('div', 'modal-foot');
  const actions =
    Array.isArray(opts.actions) && opts.actions.length
      ? opts.actions
      : [{ label: '知道了', primary: true, onClick: null }];
  actions.forEach((action) => {
    const btn = el('button', 'btn ' + (action.primary ? 'btn-primary' : 'btn-ghost'), action.label || '好');
    btn.type = 'button';
    btn.addEventListener(
      'click',
      guard(() => {
        const result = typeof action.onClick === 'function' ? action.onClick() : undefined;
        if (action.keepOpen !== true && result !== false) closeModal();
      })
    );
    footEl.append(btn);
  });

  sheet.append(headEl, body, footEl);
  host.append(sheet);
  host.dataset.open = 'true';
  modalOnClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  close.focus();
}

function openPrivacy() {
  openModal('隐私与数据', (body) => {
    body.append(el('h4', null, '照片存在哪'));
    body.append(el('p', null, '上传的照片存在本机 app/data/uploads/，只用于这次分析；在左栏删掉这个角落，照片文件会一起删除。'));
    body.append(el('h4', null, '不接支付'));
    body.append(el('p', null, '现在没有登录、没有账号、没有支付。点「生成可执行方案」是演示解锁，不会扣款。'));
    body.append(el('h4', null, 'API Key'));
    body.append(el('p', null, '模型的 API Key 只在服务端 app/.env，不会出现在浏览器里。'));
    body.append(el('h4', null, '你可以随时'));
    const list = el('ul');
    ['删除任何一个角落和它的照片', '刷新页面后会话仍在本机', '换一台设备就看不到这些记录'].forEach((text) => {
      list.append(el('li', null, text));
    });
    body.append(list);

    // V3.1：底部信息行 ⓘ 进来的隐私弹层里，提供「删除这个角落（含照片）」入口
    const current = state.session;
    if (current) {
      body.append(el('h4', null, '删除这个角落'));
      body.append(el('p', null, '删除后，这个角落的照片和记录都会从本机移除，不能恢复。'));
      const del = el('button', 'btn btn-ghost', '删除这个角落（含照片）');
      del.type = 'button';
      del.style.minHeight = '44px';
      del.addEventListener(
        'click',
        guard(async () => {
          if (del.dataset.armed !== '1') {
            del.dataset.armed = '1';
            del.textContent = '再点一次确认删除';
            setTimeout(() => {
              if (del.isConnected) {
                del.dataset.armed = '';
                del.textContent = '删除这个角落（含照片）';
              }
            }, 3000);
            return;
          }
          await api.deleteSession(current.id);
          closeModal();
          clearFeed();
          clearCanvas();
          setPickMode(false);
          setState({ session: null, stage: 'empty', pickMode: false });
          addWelcome();
          await refreshSessions();
          toast('已删除这个角落和它的照片', { tone: 'ok' });
        })
      );
      body.append(del);
    }
  });
}

function openHelp() {
  openModal('怎么用', (body) => {
    body.append(el('p', null, '拍一张角落照片，先免费判断值不值得改；量 1—2 个关键尺寸，再拿可执行方案。'));
    const steps = el('ul');
    [
      '拍照提交：照片里要能看到墙和地面的交界',
      '照片质检：太暗、太糊、太小会先拦一次，可以重拍',
      '方向预览（免费）：只给方向，不下「放得下」的结论',
      '渐进测量：每轮只问 1—2 项，不确定可以直接跳过',
      '报价核款：演示解锁，不会真实扣款',
      '规则校验：按尺寸条件逐条判断通过 / 不满足 / 待确认',
      '人工复核：演示环境里用规则自查代替',
      'L1 交付：标注图 + 放置建议 + 尺寸条件 + 现场清单，可导出',
    ].forEach((text) => {
      steps.append(el('li', null, text));
    });
    body.append(steps);
    const note = el('div', 'modal-note');
    note.textContent = '量最窄处。跳过项不会当成通过，会记为「待确认」。';
    body.append(note);
  });
}

/* ------------------------------------------------------------------ 交互 */

/* ------------------------------------------------ V3 家庭分享面板 */

let shareSheetOpen = false;

function shareUrlOf(share) {
  const raw = share && share.url ? String(share.url) : '';
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return window.location.protocol + '//' + window.location.host + (raw.startsWith('/') ? raw : '/' + raw);
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback below */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function openShareSheet(share) {
  const host = $('modal-host');
  if (!host || !share || !share.token) return;
  // 打开分享面板视为已读：清掉未读角标并记住 voteCount
  try {
    flow.markVotesRead();
  } catch (err) {
    reportError(err);
  }
  closeModal();
  host.textContent = '';
  const sheet = el('div', 'share-sheet');
  const headEl = el('div', 'share-head');
  headEl.append(el('h2', 'share-title', '分享给同住的人'));
  const close = el('button', 'modal-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭分享');
  close.addEventListener('click', closeModal);
  headEl.append(close);

  const body = el('div', 'share-body');
  const url = shareUrlOf(share);
  const linkRow = el('div', 'share-link-row');
  const linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.className = 'share-link';
  linkInput.readOnly = true;
  linkInput.value = url;
  linkInput.setAttribute('aria-label', '分享链接');
  linkInput.addEventListener('focus', () => linkInput.select());
  linkRow.append(linkInput);
  body.append(linkRow);

  const notes = el('ul', 'share-notes');
  ['24 小时内有效', '仅同一 Wi-Fi 可打开', '可随时撤销'].forEach((text) => notes.append(el('li', 'share-note', text)));
  body.append(notes);

  const actions = el('div', 'share-actions');
  const addAction = (label, primary, handler) => {
    const btn = el('button', 'btn ' + (primary ? 'btn-primary' : 'btn-ghost'), label);
    btn.type = 'button';
    btn.style.minHeight = '44px';
    btn.addEventListener('click', guard(handler));
    actions.append(btn);
    return btn;
  };
  addAction('复制链接', true, async () => {
    const ok = await copyToClipboard(url);
    toast(ok ? '链接已复制，发给同住的人就行' : '复制失败，手动选中链接复制');
  });
  if (navigator.share) {
    addAction('系统分享', false, async () => {
      try {
        await navigator.share({ title: '猫角落 · 家里的角落', text: '帮我看下这个角落的布置', url });
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        toast('系统分享没打开，可以复制链接');
      }
    });
  }
  addAction('撤销分享', false, async () => {
    await flow.revokeShareSession();
    closeModal();
  });
  const revokeBtn = actions.lastElementChild;
  if (revokeBtn) revokeBtn.classList.add('btn-danger');
  body.append(actions);
  body.append(el('p', 'share-foot', '这张卡片只包含方案摘要，不含你的输入记录或原图。'));
  sheet.append(headEl, body);
  host.append(sheet);
  host.dataset.open = 'true';
  shareSheetOpen = true;
  close.focus();
}

function pickAfterFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  document.body.append(input);
  input.addEventListener(
    'change',
    guard(async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) await flow.handleAfterImage(file);
    }),
    { once: true }
  );
  input.click();
}

function bindVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    const composer = $('composer');
    if (!composer) return;
    const gap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    composer.style.transform = gap > 24 ? `translateY(-${Math.min(gap, 240)}px)` : '';
    // ui-shell 预留：键盘打开时收紧 stage / 隐藏画布抽屉把手
    const app = $('app');
    if (app) app.dataset.keyboard = gap > 100 ? 'open' : 'closed';
  };
  vv.addEventListener('resize', guard(sync));
  vv.addEventListener('scroll', guard(sync));
  sync();
}

function autogrow(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(132, Math.max(38, input.scrollHeight)) + 'px';
}

function sendComposer() {
  const input = $('composer-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    toast('先说说想改哪里，或点相机传一张照片');
    return;
  }
  input.value = '';
  autogrow(input);
  const pending = flow.handleUserText(text);
  if (pending && pending.catch) pending.catch(reportError);
}

function togglePick() {
  const on = !state.pickMode;
  setState({ pickMode: on });
  setPickMode(on);
  if (on) toast('点照片上你想放的位置');
}

function startUnlock() {
  if (unlocking || state.busy) return;
  unlocking = true;
  const dockBtn = $('btn-deliver');
  if (dockBtn) dockBtn.disabled = true;
  toast('演示环境，未真实扣款', { ms: 2400 });
  setTimeout(() => {
    const pending = flow.runPlan();
    Promise.resolve(pending)
      .catch(reportError)
      .finally(() => {
        unlocking = false;
        const btn = $('btn-deliver');
        if (btn) btn.disabled = Boolean(state.busy) || state.stage === 'delivered';
      });
  }, 900);
}

function bindEvents() {
  const onClick = (id, fn) => {
    const node = $(id);
    if (node) node.addEventListener('click', guard(fn));
  };

  onClick('btn-new', () => {
    const pending = flow.startSession();
    if (pending && pending.catch) pending.catch(reportError);
  });
  onClick('btn-privacy', openPrivacy);
  onClick('btn-foot-info', openPrivacy);
  onClick('btn-help', openHelp);
  onClick('btn-sessions', () => toggleRailDrawer());

  // 手机 rail 抽屉：点 scrim（#rail 自身）或会话项后关闭
  const railEl = $('rail');
  if (railEl) {
    railEl.addEventListener('click', (ev) => {
      const target = ev.target;
      if (target === railEl || (target.closest && target.closest('.session-item'))) setRailDrawer(false);
    });
  }

  // V3.1：跨 899px 断点时 debounce 150ms 重渲染卡片结构
  if (typeof window.matchMedia === 'function') {
    const mobileQuery = window.matchMedia('(max-width: 899px)');
    let lastMobile = mobileQuery.matches;
    let viewportTimer = null;
    const onViewportChange = () => {
      if (mobileQuery.matches === lastMobile) return;
      lastMobile = mobileQuery.matches;
      if (!mobileQuery.matches && state.panelOpen) flow.closeCanvas();
      clearTimeout(viewportTimer);
      viewportTimer = setTimeout(() => {
        render();
        const session = state.session;
        if (session && state.stage !== 'empty' && !state.busy) {
          const pending = flow.replaySession(session);
          if (pending && pending.catch) pending.catch(reportError);
        }
      }, 150);
    };
    if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', onViewportChange);
    else if (mobileQuery.addListener) mobileQuery.addListener(onViewportChange);
  }
  onClick('btn-cat-profile', openCatProfile);
  onClick('btn-panel-toggle', () => setState({ panelOpen: !state.panelOpen }));
  onClick('btn-zoom-in', () => zoom('in'));
  onClick('btn-zoom-out', () => zoom('out'));
  onClick('btn-zoom-fit', () => zoom('fit'));
  onClick('btn-pick-mode', togglePick);
  onClick('btn-export', () => flow.exportDeliver());
  onClick('btn-attach', () => {
    const file = $('file-input');
    if (file) file.click();
  });
  onClick('btn-send', sendComposer);

  const file = $('file-input');
  if (file) {
    file.addEventListener(
      'change',
      guard(async () => {
        const picked = file.files && file.files[0];
        file.value = '';
        if (picked) await flow.handleImage(picked);
      })
    );
  }

  const input = $('composer-input');
  if (input) {
    input.addEventListener('input', guard(() => autogrow(input)));
    input.addEventListener(
      'keydown',
      guard((ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          sendComposer();
        }
      })
    );
  }

  const stage = $('stage');
  if (stage) {
    stage.addEventListener('dragover', (ev) => {
      ev.preventDefault();
    });
    stage.addEventListener(
      'drop',
      guard(async (ev) => {
        ev.preventDefault();
        const dropped = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (dropped) await flow.handleImage(dropped);
      })
    );
    // 手机端画布改为全屏查看器：点击关闭统一在 #canvas-panel 上处理
  }

  // 手机端全屏画布：点关闭按钮 / 图片外区域关闭（stage/toolbar/legend/dock 内不关）
  const panel = $('canvas-panel');
  if (panel) {
    panel.addEventListener('click', (ev) => {
      if (window.innerWidth >= 900 || !state.panelOpen) return;
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;
      if (target.closest('#btn-canvas-close')) return; // 按钮自己绑定
      if (
        target.closest('#canvas-stage') ||
        target.closest('#canvas-toolbar') ||
        target.closest('#canvas-legend') ||
        target.closest('#measure-dock') ||
        target.closest('#deliver-dock')
      ) {
        return;
      }
      flow.closeCanvas();
    });
  }

  // 画布点选
  onPick(
    guard((point) => {
      setState({ pickMode: false });
      setPickMode(false);
      const pending = flow.handlePick(point);
      if (pending && pending.catch) pending.catch(reportError);
    })
  );

  // 动态主按钮（右栏 dock + 中栏内联）统一走解锁
  document.addEventListener(
    'click',
    guard((ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#btn-deliver, #btn-deliver-inline')) startUnlock();
    })
  );

  document.addEventListener('click', (ev) => {
    const host = $('modal-host');
    if (host && host.dataset.open === 'true' && ev.target === host) closeModal();
  });

  // V2 依据徽章 / popover：点徽章开，点外部/关闭按钮/滚动/缩放关
  document.addEventListener(
    'click',
    guard((ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.basis-badge')) ev.stopPropagation();
      handleBasisClick(target);
    })
  );
  window.addEventListener('scroll', closeBasisPopover, true);
  window.addEventListener('resize', closeBasisPopover);

  document.addEventListener(
    'keydown',
    guard((ev) => {
      if (ev.key === 'Escape') {
        closeBasisPopover();
        closeModal();
        if (state.panelOpen && window.innerWidth < 900) flow.closeCanvas();
      }
    })
  );

  document.addEventListener('corner:toast', (ev) => {
    const text = ev.detail && ev.detail.text;
    if (text) toast(text);
  });

  document.addEventListener('corner:pick-file', () => {
    const fileInput = $('file-input');
    if (fileInput) fileInput.click();
  });

  document.addEventListener('corner:unlock', () => startUnlock());

  document.addEventListener('corner:api-error', (ev) => reportApiError(ev.detail));

  // V3：分享面板 / 改造后照片 / 家人意见刷新 / 手机键盘适配
  document.addEventListener('corner:share-sheet', (ev) => {
    const share = ev.detail && ev.detail.share;
    if (share) openShareSheet(share);
  });
  document.addEventListener('corner:pick-after', pickAfterFile);

  // V3 回执：切回标签 / 窗口聚焦 / 分享面板关闭后拉家人意见（flow 内 15s 节流）
  const pullVotes = (reason) => {
    const pending = flow.refreshVotes({ reason });
    if (pending && pending.catch) {
      pending.catch((err) => {
        if (!(err && err.name === 'ApiError')) reportError(err);
      });
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullVotes('visibility');
  });
  window.addEventListener('focus', () => pullVotes('focus'));
  bindVisualViewport();

  window.addEventListener('resize', layoutToastHost);

  document.addEventListener('corner:example', (ev) => {
    const text = ev.detail && ev.detail.text;
    const composer = $('composer-input');
    if (!text || !composer) return;
    composer.value = text;
    autogrow(composer);
    composer.focus();
  });
}

/* ------------------------------------------------------------------ 启动 */

function bindGlobalErrors() {
  window.addEventListener('error', (ev) => {
    reportError(ev.error || ev.message || '未知脚本错误');
  });
  window.addEventListener('unhandledrejection', (ev) => {
    reportError(ev.reason || '未处理的 Promise 拒绝');
  });
}

async function loadInitial() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('demo') === '1') {
    const pending = flow.startDemo();
    if (pending && pending.catch) pending.catch(reportError);
    return;
  }
  let sessions = [];
  try {
    sessions = await api.listSessions();
  } catch (err) {
    if (err && err.name === 'ApiError') {
      toast('服务还没连上：' + err.message, { tone: 'error', ms: 4200 });
    } else {
      throw err;
    }
  }
  setState({ sessions: Array.isArray(sessions) ? sessions : [] });
  if (sessions && sessions.length) {
    try {
      await openSession(sessions[0].id);
    } catch (err) {
      if (err && err.name !== 'ApiError') throw err;
    }
  }
}

function boot() {
  if (booted) return;
  booted = true;

  const missing = REQUIRED_IDS.filter((id) => !$(id));
  initCanvas();
  bindGlobalErrors();
  captureProfileTemplate();
  bindEvents();
  subscribe(render);
  renderSuggestChips();

  // index.html 的静态欢迎态只用于 file:// 截图；运行时换成可交互版本
  clearFeed();
  addWelcome();
  render();

  const app = $('app');
  if (app) app.dataset.ready = '1';

  if (missing.length) reportError(new Error('index.html 缺少必需 ID：' + missing.join('、')));

  loadInitial().catch(reportError);
}

window.__corner = {
  state,
  flow,
  api,
  cards: cardsModule,
  canvas: { initCanvas, setPickMode, onPick, zoom, exportPNG, clear: clearCanvas },
  openCatProfile,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
