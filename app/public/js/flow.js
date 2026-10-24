// flow.js — 业务流程编排（改流程只改这里）。
// 上传 → 本地质检 → 服务端质检（retake ≤2 轮）→ L0 → 选方向 → 测量（≤3 轮）→ 演示解锁 → plan → 交付。

import * as api from './api.js';
import { state, setState, getUserGoal, setUserGoal } from './state.js';
import { prepareImage, prepareShareThumb, localIssues } from './image-utils.js';
import { addAI, addUser, addCardOnly, addWelcome, clearFeed, scrollToEnd } from './feed.js';
import {
  qualityCard,
  directionsCard,
  measureCard,
  planCard,
  verdictCard,
  blockedCard,
  askCard,
  errorCard,
  waitCard,
  goalChoices,
  waitStepsCard,
  followupCard,
  followupNextCard,
  followupTimeline,
  handoffCard,
  votesCard,
  compareCard,
  photoStrip,
} from './cards.js';
import {
  initCanvas,
  setImage,
  renderOverlays,
  setPickMode,
  exportPNG,
  composeComparePNG,
  zoom,
  clear as clearCanvas,
} from './canvas.js';

const MEASURE_DEFAULTS = {
  corridorWidth: 62,
  cornerWidthA: 100,
  cornerWidthB: 72,
  freeDepth: 45,
  obstructionH: 40,
  ceilingFree: 160,
  outletDist: 120,
  doorSwing: 85,
  windowDist: 90,
};

let retakeRounds = 0;
let directionId = null;
let demoMode = false;
let planCtaShown = false;
let followupFeedback = null;
let currentWaitSteps = null;

const MEASURE_LEAD_COPY = '这两个数字只有你能给。量完这一步，方案就是你自己的了。';

/* ------------------------------------------- V3 家人意见：回执 / 未读角标 */

const VOTES_POLL_MIN_MS = 15000;
const votesPoll = {
  sessionId: null,
  votes: [],
  responds: [],
  respondCount: 0,
  counts: {},
  lastCount: 0,
  unread: 0,
  lastRespondCount: 0,
  respondUnread: 0,
  respondIds: [],
  lastFetchAt: 0,
  inFlight: null,
  timer: null,
  readRequested: false,
  lastUpdatedAt: '',
  scrollSinceRender: false,
};
let votesObserver = null;
let votesScrollBound = false;
const VOTES_READ_RATIO = 0.9;

/** 只有用户自己滚动/操作过之后、且卡片基本完整进入视口，才算已读（程序化滚动不清零）。 */
function ensureVotesScrollListener() {
  if (votesScrollBound || typeof window === 'undefined') return;
  votesScrollBound = true;
  const markUserScroll = () => {
    votesPoll.scrollSinceRender = true;
  };
  ['wheel', 'touchmove'].forEach((type) => window.addEventListener(type, markUserScroll, { passive: true }));
  window.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) markUserScroll();
  });
}

function cardMostlyVisible(entry) {
  if (!entry) return false;
  if (entry.intersectionRatio && entry.intersectionRatio >= VOTES_READ_RATIO) return true;
  const card = entry.target;
  const rect = card.getBoundingClientRect();
  const viewport = window.innerHeight || 0;
  if (!rect.height || !viewport) return false;
  const visible = Math.max(0, Math.min(rect.bottom, viewport) - Math.max(rect.top, 0));
  return visible / rect.height >= VOTES_READ_RATIO;
}

function observeVotesCard(card) {
  if (votesObserver) {
    try {
      votesObserver.disconnect();
    } catch {
      /* ignore */
    }
    votesObserver = null;
  }
  ensureVotesScrollListener();
  card.addEventListener('click', () => markVotesRead());
  if (typeof IntersectionObserver !== 'function') return;
  votesObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && votesPoll.scrollSinceRender && cardMostlyVisible(entry)) {
          markVotesRead();
          break;
        }
      }
    },
    { threshold: [0, VOTES_READ_RATIO, 1] }
  );
  votesObserver.observe(card);
}

function votesStorageKey(sessionId) {
  return 'corner.votesRead.' + sessionId;
}

function readStoredVotesCount(sessionId) {
  try {
    const raw = window.localStorage.getItem(votesStorageKey(sessionId));
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeVotesCount(sessionId, count) {
  try {
    window.localStorage.setItem(votesStorageKey(sessionId), String(Math.max(0, Number(count) || 0)));
  } catch {
    /* 隐私模式忽略 */
  }
}

function respondsStorageKey(sessionId) {
  return 'corner.respondsRead.' + sessionId;
}

function readStoredRespondsCount(sessionId) {
  try {
    const raw = window.localStorage.getItem(respondsStorageKey(sessionId));
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeRespondsCount(sessionId, count) {
  try {
    window.localStorage.setItem(respondsStorageKey(sessionId), String(Math.max(0, Number(count) || 0)));
  } catch {
    /* 隐私模式忽略 */
  }
}

/* ------------------------------------------------ V4.2 系统通知 */

const NOTIFY_KEY = 'corner.notify';
const notifiedEventIds = new Set();
let lastSystemNotifyAt = 0;

/** 是否允许发系统通知（权限/开关/后台/支持度） */
export function canNotifySystem() {
  try {
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') return false;
    const NotificationCtor = window.Notification;
    if (typeof NotificationCtor === 'undefined') return false;
    if (NotificationCtor.permission !== 'granted') return false;
    return window.localStorage.getItem(NOTIFY_KEY) !== '0';
  } catch {
    return false;
  }
}

/** 交付卡开关三态：unsupported / off / enabled */
export function getNotifyState() {
  try {
    const NotificationCtor = window.Notification;
    if (typeof NotificationCtor === 'undefined') return 'unsupported';
    if (NotificationCtor.permission === 'denied') return 'unsupported';
    if (NotificationCtor.permission === 'granted') {
      return window.localStorage.getItem(NOTIFY_KEY) === '0' ? 'off' : 'enabled';
    }
    return 'off';
  } catch {
    return 'unsupported';
  }
}

export function updateNotifyToggles() {
  const state = getNotifyState();
  document.querySelectorAll('#feed .notify-toggle').forEach((btn) => {
    btn.dataset.state = state;
    btn.disabled = state === 'unsupported';
    btn.classList.toggle('is-on', state === 'enabled');
    btn.textContent =
      state === 'unsupported'
        ? '浏览器不支持提醒'
        : state === 'enabled'
        ? '已开启提醒 · 点此关闭'
        : '家人回应时提醒我';
  });
}

/** 用户点击开关：只在此时 requestPermission；绝不自动弹权限 */
export async function toggleSystemNotify() {
  const state = getNotifyState();
  if (state === 'unsupported') return null;
  try {
    if (state === 'enabled') {
      window.localStorage.setItem(NOTIFY_KEY, '0');
      updateNotifyToggles();
      notify('已关闭系统提醒');
      return 'off';
    }
    const permission = await window.Notification.requestPermission();
    if (permission === 'granted') {
      window.localStorage.setItem(NOTIFY_KEY, '1');
      updateNotifyToggles();
      notify('已开启系统提醒');
      return 'enabled';
    }
    updateNotifyToggles();
    notify('没有拿到通知权限，未读角标和提示仍会保留');
    return 'off';
  } catch {
    updateNotifyToggles();
    return null;
  }
}

/**
 * 发系统通知：支持度/权限/开关/后台 + 事件去重 + 30s 节流。
 * @returns {boolean} 是否真正创建了 Notification
 */
export function sendSystemNotification({ sessionId, title, body, eventId } = {}) {
  if (!canNotifySystem()) return false;
  const key = String(eventId || '');
  if (!key || notifiedEventIds.has(key)) return false;
  const now = Date.now();
  if (now - lastSystemNotifyAt < 30000) return false;
  try {
    const NotificationCtor = window.Notification;
    const notification = new NotificationCtor(title || '猫角落', {
      body: body || '',
      tag: 'corner-' + sessionId,
      icon: '/icons/icon-192.png',
    });
    notifiedEventIds.add(key);
    while (notifiedEventIds.size > 100) {
      const oldest = notifiedEventIds.values().next().value;
      notifiedEventIds.delete(oldest);
    }
    lastSystemNotifyAt = now;
    try {
      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
        const card = document.querySelector('#feed .card-votes');
        if (card && typeof card.scrollIntoView === 'function') {
          card.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
        markVotesRead();
      };
    } catch {
      /* 部分环境不允许挂 onclick */
    }
    return true;
  } catch {
    return false;
  }
}

function relativeTime(iso) {
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

function resetVotesPoll(sessionId) {
  if (votesObserver) {
    try {
      votesObserver.disconnect();
    } catch {
      /* ignore */
    }
    votesObserver = null;
  }
  if (votesPoll.timer) {
    clearTimeout(votesPoll.timer);
    votesPoll.timer = null;
  }
  votesPoll.sessionId = sessionId || null;
  votesPoll.votes = [];
  votesPoll.responds = [];
  votesPoll.respondCount = 0;
  votesPoll.counts = {};
  votesPoll.lastCount = 0;
  votesPoll.unread = 0;
  votesPoll.lastRespondCount = 0;
  votesPoll.respondUnread = 0;
  votesPoll.respondIds = [];
  votesPoll.lastFetchAt = 0;
  votesPoll.inFlight = null;
  votesPoll.readRequested = false;
  votesPoll.lastUpdatedAt = '';
  votesPoll.fetches = 0;
}

function removeVotesUI() {
  document.querySelectorAll('#feed .card-votes').forEach((node) => {
    const item = node.closest('.feed-item');
    if (item) item.remove();
    else node.remove();
  });
}

/* ------------------------------------------------ V4 家人回应：看图 / 设为改造后 */

let respondPhotoState = null;

function closeRespondPhoto() {
  if (!respondPhotoState) return;
  const { overlay, onKey } = respondPhotoState;
  respondPhotoState = null;
  document.removeEventListener('keydown', onKey);
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
}

function openRespondPhoto(url, respond) {
  if (!url) return;
  closeRespondPhoto();
  const overlay = document.createElement('div');
  overlay.className = 'respond-photo-viewer';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '120',
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(20,17,16,.82)',
    padding: '18px',
  });
  const img = document.createElement('img');
  img.className = 'respond-photo-large';
  img.src = url;
  img.alt = (respond && respond.note) || '家人拍的现场照';
  Object.assign(img.style, {
    maxWidth: '92vw',
    maxHeight: '84vh',
    borderRadius: '14px',
    boxShadow: '0 24px 60px rgba(0,0,0,.4)',
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-ghost respond-photo-close';
  close.textContent = '关闭';
  close.style.minHeight = '44px';
  close.style.position = 'absolute';
  close.style.top = 'calc(14px + env(safe-area-inset-top, 0px))';
  close.style.right = '14px';
  close.addEventListener('click', () => closeRespondPhoto());
  overlay.append(img, close);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeRespondPhoto();
  });
  const onKey = (ev) => {
    if (ev.key === 'Escape') closeRespondPhoto();
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  respondPhotoState = { overlay, onKey };
  close.focus();
}

async function useRespondPhotoAsAfter(respond) {
  const session = state.session;
  if (!session || !respond || !respond.id) return;
  try {
    const updated = await api.useSharePhotoAsAfter(session.id, respond.id);
    if (!updated) {
      notify('这张照片暂时用不了，稍后再试');
      return;
    }
    setState({ session: updated });
    renderCompareCard(state.session);
    notify('已用家人拍的照片做对比');
    markVotesRead();
  } catch (err) {
    if (isApiError(err)) notify(err.message);
    else throw err;
  }
}

function renderVotesUI() {
  removeVotesUI();
  if (!votesPoll.votes.length && !votesPoll.responds.length) return;
  const card = votesCard(votesPoll.votes, {
    labels: cardLabels(),
    unread: votesPoll.unread,
    respondUnread: votesPoll.respondUnread,
    responds: votesPoll.responds,
    respondCount: votesPoll.respondCount,
    onUseRespondPhoto: (respond) => safeAsync(useRespondPhotoAsAfter(respond)),
    onOpenRespondPhoto: (url, respond) => openRespondPhoto(url, respond),
  });
  if (!card) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'feed-item ai';
  const cards = document.createElement('div');
  cards.className = 'cards';
  cards.append(card);
  wrapper.append(cards);
  const handoff = document.querySelector('#feed .card-handoff');
  const anchor = handoff;
  if (anchor) {
    const anchorItem = anchor.closest('.feed-item') || anchor;
    anchorItem.insertAdjacentElement('afterend', wrapper);
  } else {
    const feed = document.getElementById('feed');
    if (feed) feed.append(wrapper);
  }
  votesPoll.scrollSinceRender = false;
  observeVotesCard(card);
  // 兜底：某些环境（无头浏览器/自定义滚动容器）IntersectionObserver 不触发，
  // 渲染后先用几何判定一次，再挂滚动/尺寸变化监听，避免角标永远清不掉。
  requestAnimationFrame(() => {
    maybeMarkReadByViewport(card);
  });
  bindVotesViewportFallback();
}

let votesViewportBound = false;
function bindVotesViewportFallback() {
  if (votesViewportBound) return;
  votesViewportBound = true;
  const check = () => {
    const card = document.querySelector('#feed .card-votes');
    if (card) maybeMarkReadByViewport(card);
  };
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      check();
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onScroll, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
}

/** 卡片有 60% 以上落在视口内，且用户自己滚动过 → 视为已读（程序化滚动不清零） */
function maybeMarkReadByViewport(card) {
  if (!card || !card.isConnected || !votesPoll.scrollSinceRender) return;
  if (votesPoll.unread <= 0 && votesPoll.respondUnread <= 0) return;
  const rect = card.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const visible = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
  if (rect.height > 0 && visible / rect.height >= 0.6) markVotesRead();
}

/** 已读：滚到卡片 / 打开分享面板 / 点设为改造后照片时调用，清零两路未读并记住基线 */
export function markVotesRead() {
  const session = state.session;
  if (!session) return;
  if (votesPoll.sessionId !== session.id) resetVotesPoll(session.id);
  const hadUnread = votesPoll.unread > 0 || votesPoll.respondUnread > 0;
  votesPoll.unread = 0;
  votesPoll.respondUnread = 0;
  if (votesPoll.lastFetchAt === 0) votesPoll.readRequested = true;
  else {
    storeVotesCount(session.id, votesPoll.lastCount);
    storeRespondsCount(session.id, votesPoll.lastRespondCount);
  }
  if (hadUnread) renderVotesUI();
  updateHandoffStatus(session.share);
}

function votesToastText(counts) {
  const support = Number(counts && counts.yes) || 0;
  const unsure = Number(counts && counts.unsure) || 0;
  const oppose = Number(counts && counts.no) || 0;
  let text = `家人给了意见 · 支持 ${support} · 犹豫 ${unsure}`;
  if (oppose > 0) text += ` · 反对 ${oppose}`;
  return text;
}

function respondToastText(newResponds, diff) {
  const count = Math.max(0, Number(diff) || 0);
  const list = Array.isArray(newResponds) ? newResponds : [];
  if (count >= 2) return `家人给了 ${count} 条回应`;
  const item = list[0] || null;
  if (item && item.photoUrl) return '家人拍了现场照 · 1 张';
  const label = (item && (item.label || item.action)) || '回应';
  return `家人回应了你 · ${label}`;
}

function applyVotesData(sessionId, data, reason) {
  const votes = Array.isArray(data.votes) ? data.votes : [];
  const responds = Array.isArray(data.responds) ? data.responds.filter((item) => item && item.action) : [];
  const counts = data.counts && typeof data.counts === 'object' ? data.counts : {};
  const voteCount = Number.isFinite(Number(data.voteCount)) ? Number(data.voteCount) : votes.length;
  const respondCount = Number.isFinite(Number(data.respondCount)) ? Number(data.respondCount) : responds.length;
  const storedVotes = readStoredVotesCount(sessionId);
  const storedResponds = readStoredRespondsCount(sessionId);
  const previousVotes = votesPoll.lastCount;
  const previousResponds = votesPoll.lastRespondCount;
  const previousRespondIds = Array.isArray(votesPoll.respondIds) ? votesPoll.respondIds : [];

  // 本轮新增的回应（按 id 比对；无 id 的老数据用尾部差量兜底）
  let newResponds = responds.filter((item) => item && item.id && !previousRespondIds.includes(String(item.id)));
  if (!newResponds.length && respondCount > previousResponds) {
    newResponds = responds.slice(Math.max(0, responds.length - (respondCount - previousResponds)));
  }

  votesPoll.votes = votes;
  votesPoll.responds = responds;
  votesPoll.respondCount = respondCount;
  votesPoll.respondIds = responds.map((item) => (item && item.id ? String(item.id) : '')).filter(Boolean);
  votesPoll.counts = counts;
  votesPoll.lastCount = voteCount;
  votesPoll.lastRespondCount = respondCount;
  if (votes.length || responds.length) {
    const latest = votes
      .map((vote) => vote && vote.at)
      .concat(responds.map((item) => item && item.at))
      .filter(Boolean)
      .sort()
      .slice(-1)[0];
    votesPoll.lastUpdatedAt = latest || '';
  }

  // 只有「本次会话里的第一次拉取」才算首次进入；之后再出现新增要提示
  votesPoll.fetches = (votesPoll.fetches || 0) + 1;
  const isFirstFetch = votesPoll.fetches === 1;
  let diffVotes = 0;
  let diffResponds = 0;

  if (votesPoll.readRequested) {
    // 打开分享面板时先清掉、再拉一次：这次不提示
    votesPoll.unread = 0;
    votesPoll.respondUnread = 0;
    votesPoll.readRequested = false;
    storeVotesCount(sessionId, voteCount);
    storeRespondsCount(sessionId, respondCount);
  } else {
    let toastVotes = false;
    let toastResponds = false;
    if (isFirstFetch && storedVotes == null) {
      votesPoll.unread = voteCount;
    } else {
      diffVotes = voteCount - Math.max(storedVotes == null ? 0 : storedVotes, previousVotes);
      if (diffVotes > 0) {
        votesPoll.unread = Math.min(99, votesPoll.unread + diffVotes);
        toastVotes = true;
      }
    }
    if (isFirstFetch && storedResponds == null) {
      votesPoll.respondUnread = respondCount;
    } else {
      diffResponds = respondCount - Math.max(storedResponds == null ? 0 : storedResponds, previousResponds);
      if (diffResponds > 0) {
        votesPoll.respondUnread = Math.min(99, votesPoll.respondUnread + diffResponds);
        toastResponds = true;
        newResponds = newResponds.length ? newResponds : responds.slice(-diffResponds);
        const text = respondToastText(newResponds, diffResponds);
        // 投票与回应同轮到达：先投票、约 450ms 后回应，避免互相覆盖
        if (toastVotes) setTimeout(() => notify(text), 450);
        else notify(text);
      }
    }
    if (toastVotes) notify(votesToastText(counts));

    // V4.2：后台时发系统通知（权限/开关/后台/去重/30s 节流都在 sendSystemNotification 内）
    if (toastVotes || toastResponds) {
      const lastVote = votes.length ? votes[votes.length - 1] : null;
      const eventId = toastResponds
        ? 'respond:' + newResponds.map((item) => (item && (item.id || item.at)) || '').filter(Boolean).join(',')
        : `vote:${voteCount}:${(lastVote && lastVote.at) || ''}:${(lastVote && lastVote.name) || ''}`;
      sendSystemNotification({
        sessionId,
        title: toastResponds ? '猫角落 · 家人给了回应' : '猫角落 · 家人给了意见',
        body: toastResponds ? respondToastText(newResponds, diffResponds) : votesToastText(counts),
        eventId,
      });
    }
  }

  if (!votes.length && !responds.length) {
    removeVotesUI();
    updateHandoffStatus(state.session && state.session.share);
    return { voteCount, counts };
  }
  renderVotesUI();
  updateHandoffStatus(state.session && state.session.share);
  return { voteCount, counts, respondCount };
}

/** 按事件拉家人意见：默认 15s 节流；force=true 跳过节流（内部/首次） */
export async function refreshVotes(opts = {}) {
  const session = state.session;
  if (!session || !session.plan) return null;
  if (votesPoll.sessionId !== session.id) resetVotesPoll(session.id);
  if (votesPoll.inFlight) return votesPoll.inFlight;
  const force = opts.force === true;
  const now = Date.now();
  if (!force && now - votesPoll.lastFetchAt < VOTES_POLL_MIN_MS) {
    if (!votesPoll.timer) {
      const wait = VOTES_POLL_MIN_MS - (now - votesPoll.lastFetchAt) + 100;
      votesPoll.timer = setTimeout(() => {
        votesPoll.timer = null;
        safeAsync(refreshVotes({ force: true, reason: 'trailing' }));
      }, wait);
    }
    return null;
  }
  const request = (async () => {
    try {
      const data = await api.getVotes(session.id);
      votesPoll.lastFetchAt = Date.now();
      return applyVotesData(session.id, data, opts.reason || 'poll');
    } catch (err) {
      if (isApiError(err)) return null; // 意见接口不可用时静默
      throw err;
    } finally {
      votesPoll.inFlight = null;
    }
  })();
  votesPoll.inFlight = request;
  return request;
}

/* ------------------------------------------------------------------ 工具 */

function notify(text) {
  try {
    document.dispatchEvent(new CustomEvent('corner:toast', { detail: { text: String(text || '') } }));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------ V3.1 移动端滚动/布局 */

function isMobileViewport() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 899px)').matches
  );
}

/** L0 推荐方向 / 测量卡渲染后：移动端滚到卡顶（reduced-motion 时 behavior:auto） */
function scrollCardToTop(card) {
  if (!card || !isMobileViewport()) return;
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const run = () => {
    if (!card.isConnected) return;
    try {
      card.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    } catch {
      /* ignore */
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

/* ------------------------------------------------ V3.2 手机照片条 / 全屏画布 */

let lastCanvasTrigger = null;

/** feed 顶部照片条：回放/切会话/上传后重建，始终在最前面（quality 卡之前） */
function renderPhotoStrip(session) {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const old = feed.querySelector('.photo-strip');
  if (old) old.remove();
  if (!isMobileViewport() || !session || !session.image) return;
  const strip = photoStrip(session, { onOpen: (trigger) => openCanvas(trigger) });
  if (strip) feed.prepend(strip);
}

function ensureCanvasCloseButton() {
  const panel = document.getElementById('canvas-panel');
  if (!panel) return null;
  let btn = document.getElementById('btn-canvas-close');
  if (btn) return btn;
  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-canvas-close';
  btn.className = 'btn-canvas-close canvas-close';
  btn.setAttribute('aria-label', '关闭画布');
  btn.innerHTML =
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeCanvas();
  });
  const headEl = panel.querySelector('.panel-head');
  if (headEl) headEl.prepend(btn);
  else panel.prepend(btn);
  return btn;
}

/** 手机端打开全屏画布：切 data-open → 下一帧重初始化并重绘 → 聚焦关闭 */
export function openCanvas(trigger) {
  const session = state.session;
  if (!session || !session.image) {
    notify('先传一张照片再看标注');
    return;
  }
  lastCanvasTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  setState({ panelOpen: true });
  const panel = document.getElementById('canvas-panel');
  if (panel) panel.dataset.viewer = 'true';
  ensureCanvasCloseButton();
  // 查看器 badge 用纯数字语义「标注 N 处」
  const badge = document.getElementById('canvas-badge');
  if (badge) {
    const annotations = session.plan && Array.isArray(session.plan.annotations) ? session.plan.annotations : [];
    const regions = session.l0 && Array.isArray(session.l0.regions) ? session.l0.regions : [];
    const count = annotations.length || regions.length;
    if (count) badge.textContent = '标注 ' + count + ' 处';
  }
  const redraw = async () => {
    initCanvas();
    try {
      await setImage(api.imageUrl(session), {
        width: session.image && session.image.width,
        height: session.image && session.image.height,
      });
    } catch {
      return;
    }
    renderOverlays({
      regions: session.l0 && Array.isArray(session.l0.regions) ? session.l0.regions : [],
      annotations: session.plan && Array.isArray(session.plan.annotations) ? session.plan.annotations : [],
      activeId: null,
    });
    zoom('fit');
    const close = document.getElementById('btn-canvas-close');
    if (close) close.focus();
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      redraw().catch(() => {});
    });
  } else {
    redraw().catch(() => {});
  }
}

export function closeCanvas() {
  const panel = document.getElementById('canvas-panel');
  if (panel) {
    panel.dataset.open = 'false';
    panel.dataset.viewer = 'false';
  }
  setState({ panelOpen: false });
  setPickMode(false);
  const trigger = lastCanvasTrigger;
  lastCanvasTrigger = null;
  if (trigger && trigger.isConnected) {
    try {
      trigger.focus();
    } catch {
      /* ignore */
    }
  }
}

export function isCanvasViewerOpen() {
  return Boolean(state.panelOpen);
}

function requestFile() {
  try {
    document.dispatchEvent(new CustomEvent('corner:pick-file'));
  } catch {
    /* ignore */
  }
}

function safeAsync(promise) {
  if (!promise || typeof promise.catch !== 'function') return;
  promise.catch((err) => {
    if (err && err.name === 'ApiError') return; // 已在卡片里展示
    setTimeout(() => {
      throw err;
    }, 0);
  });
}

/** 只在 demo 模式下的自动推进 */
function schedule(fn, ms = 800) {
  if (!demoMode) return;
  setTimeout(() => {
    try {
      safeAsync(fn());
    } catch (err) {
      setTimeout(() => {
        throw err;
      }, 0);
    }
  }, ms);
}

function isApiError(err) {
  return Boolean(err && err.name === 'ApiError');
}

function profilePayload() {
  const sessionProfile = (state.session && state.session.profile) || {};
  const draft = state.profileDraft && typeof state.profileDraft === 'object' ? state.profileDraft : {};
  const merged = Object.assign({}, sessionProfile, draft);
  const goal = getUserGoal() || merged.goal || '';
  const budgetMatch = /预算\s*(\d{2,6})/.exec(goal);
  const budget = budgetMatch
    ? Number(budgetMatch[1])
    : typeof merged.budget === 'number'
    ? merged.budget
    : null;
  return {
    goal,
    budget,
    keep: Array.isArray(merged.keep) ? merged.keep : [],
    // V2 猫档案（CONTRACT-V2 §2.1）
    cats: Number(merged.cats) || 1,
    catSize: merged.catSize || 'medium',
    catAge: merged.catAge || 'adult',
    multiCat: Boolean(merged.multiCat),
    floorType: merged.floorType || 'unknown',
    climate: merged.climate || 'unknown',
    // V2.1 L0 先问一句（只允许一次点击）
    primaryPain: merged.primaryPain || '',
  };
}

/** 写 profile 字段（会话 + 本地草稿），不弹窗、不打断 */
function setProfileValue(key, value) {
  const draft = Object.assign({}, state.profileDraft || {}, { [key]: value });
  setState({ profileDraft: draft });
  if (state.session) {
    setState({
      session: Object.assign({}, state.session, {
        profile: Object.assign({}, state.session.profile || {}, { [key]: value }),
      }),
    });
  }
}

/* ------------------------------ V2.1 等待 3 步 / 重选 / 回访 ------------------------------ */

function ensureWaitSteps() {
  if (currentWaitSteps && currentWaitSteps.el && currentWaitSteps.el.isConnected) return currentWaitSteps;
  currentWaitSteps = waitStepsCard();
  addCardOnly(currentWaitSteps.el);
  return currentWaitSteps;
}

function resetWaitSteps() {
  currentWaitSteps = null;
}

/** 指认错了：直接进画布点选模式重选 */
function reselectPosition() {
  setState({ pickMode: true });
  setPickMode(true);
  if (typeof window !== 'undefined' && window.innerWidth < 900) setState({ panelOpen: true });
  notify('点画布上想放的位置，我会重新看这个点');
}

function daysSince(iso) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return null;
  return (Date.now() - time) / 86400000;
}

/** 回访换方向：从 l0.directions 里确定性地挑一个「不同」的方向 */
function pickAlternativeDirection(session) {
  const data = session || {};
  const directions = data.l0 && Array.isArray(data.l0.directions) ? data.l0.directions.filter(Boolean) : [];
  if (directions.length < 2) return null;
  const currentId = data.chosenDirectionId == null ? '' : String(data.chosenDirectionId);
  const others = directions.filter((direction) => String(direction.id) !== currentId);
  if (!others.length) return null;
  const current = directions.find((direction) => String(direction.id) === currentId) || null;
  const fresh = others.find((direction) => direction.kit === 'new');
  if (fresh) return fresh;
  if (current && current.regionId) {
    const differentRegion = others.find((direction) => direction.regionId && direction.regionId !== current.regionId);
    if (differentRegion) return differentRegion;
  }
  return others[0];
}

function followupNextDoneKey(sessionId) {
  return `corner.followupNextDone.${sessionId}`;
}

function readFollowupNextDone(sessionId) {
  try {
    return window.localStorage.getItem(followupNextDoneKey(sessionId)) || '';
  } catch {
    return '';
  }
}

function storeFollowupNextDone(sessionId, value) {
  try {
    window.localStorage.setItem(followupNextDoneKey(sessionId), String(value || 'handled'));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 回访轻卡：按 planDeliveredAt 天数出卡；答案落库、可修改、day7 反馈可换方向 */
export function appendFollowups(session, opts = {}) {
  if (!session || !session.plan) return;
  const data = session;
  const force =
    opts.force === true ||
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('followup') === '1');
  const days = daysSince(data.planDeliveredAt);
  const answers = {};
  (Array.isArray(data.followups) ? data.followups : []).forEach((item) => {
    if (item && (item.day === 2 || item.day === 7)) answers[item.day] = item;
  });
  const answered = (day) => Boolean(answers[day]);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const shownKey = (day) => `corner.followupShown.${data.id}.${day}`;
  const shownToday = (day) => {
    try {
      return window.localStorage.getItem(shownKey(day)) === todayKey;
    } catch {
      return false;
    }
  };
  const markShown = (day) => {
    try {
      window.localStorage.setItem(shownKey(day), todayKey);
    } catch {
      /* 隐私模式忽略 */
    }
  };

  const day2Payload = {
    day: 2,
    title: '清单第一项，今天做还是周末做？',
    sub: '先做一件小事就够了，不用一次改完。',
    actions: [
      { label: '今天做', value: 'today' },
      { label: '周末做', value: 'weekend' },
      { label: '暂时不做', value: 'skipped' },
    ],
  };
  const day7Payload = {
    day: 7,
    title: '用上了吗？',
    sub: '不用也没关系，换个位置可能更合适。',
    actions: [
      { label: '用上了', value: 'used' },
      { label: '还没', value: 'not_yet' },
      { label: '方案不对', value: 'wrong' },
    ],
  };

  const cards = [];
  if (force) {
    cards.push({ payload: day2Payload, answer: answers[2] || null });
    cards.push({ payload: day7Payload, answer: answers[7] || null });
  } else {
    if (days != null && days >= 2 && !answered(2) && !shownToday(2)) cards.push({ payload: day2Payload, answer: null });
    if (days != null && days >= 7 && !answered(7) && !shownToday(7) && (answered(2) || cards.length === 0)) {
      cards.push({ payload: day7Payload, answer: null });
    }
  }
  if (!cards.length) return;

  const updateTimeline = (nextSession) => {
    const details = document.querySelector('#feed .card-handoff .handoff-timeline');
    if (!details) return;
    const old = details.querySelector('.followup-timeline');
    const next = followupTimeline(nextSession);
    if (old) old.replaceWith(next);
    else details.append(next);
  };

  const markNextHandled = (sessionId, status) => {
    if (sessionId) storeFollowupNextDone(sessionId, status);
  };

  const updateNextCardDone = (text) => {
    const nextCard = document.querySelector('#feed .card-followup-next');
    if (!nextCard) return;
    nextCard.classList.add('is-done');
    nextCard.dataset.handled = 'true';
    const title = nextCard.querySelector('.followup-next-title');
    if (title) title.textContent = text;
    const sub = nextCard.querySelector('.followup-next-sub');
    if (sub) sub.remove();
    const actions = nextCard.querySelector('.followup-next-actions');
    if (actions) actions.remove();
  };

  const handleNextSwitch = async (feedback) => {
    const sessionNow = state.session;
    if (!sessionNow) return;
    const alternative = pickAlternativeDirection(sessionNow);
    if (!alternative) {
      notify('只有一个方向，可以在标注里调整位置');
      return;
    }
    try {
      await recalculatePlan({ directionId: alternative.id, followupFeedback: feedback || 'wrong' });
      markNextHandled(sessionNow.id, 'recalculated');
      updateNextCardDone('已换个方向重算 · 看看新方案');
    } catch (err) {
      if (isApiError(err)) notify(err.message);
      else throw err;
    }
  };

  const handleNextLater = () => {
    const sessionNow = state.session;
    if (sessionNow) markNextHandled(sessionNow.id, 'later');
    updateNextCardDone('已记下 · 先不动');
    notify('好，那先不动。之后想换方向随时回来');
  };

  const addNextCard = (value, sessionNow) => {
    const currentSession = sessionNow || state.session;
    if (!currentSession) return;
    if (readFollowupNextDone(currentSession.id)) return; // 已处理过，刷新后不再弹未处理态
    if (document.querySelector('#feed .card-followup-next')) return;
    const alternative = pickAlternativeDirection(currentSession);
    const canSwitch = Boolean(alternative);
    addCardOnly(
      followupNextCard(
        { value },
        {
          canSwitchDirection: canSwitch,
          onRecalculate: (feedback) => safeAsync(handleNextSwitch(feedback || value)),
          onLater: handleNextLater,
          onNoAlternative: () => notify('只有一个方向，可以在标注里调整位置'),
        }
      )
    );
  };

  const answerFollowup = async (payload, cardEl, value, note) => {
    const sessionNow = state.session;
    if (!sessionNow) return;
    try {
      const updated = await api.postFollowup(sessionNow.id, { day: payload.day, value, note });
      if (!updated) return;
      setState({ session: updated });
      syncSessionSummary(updated);
      const answer = (Array.isArray(updated.followups) ? updated.followups : []).find((item) => item && item.day === payload.day) || {
        day: payload.day,
        value,
        note,
        at: new Date().toISOString(),
      };
      if (cardEl && typeof cardEl.setFollowupState === 'function') cardEl.setFollowupState(answer);
      updateTimeline(updated);
      notify('记下了，之后也可以改');
      if (payload.day === 7 && (value === 'not_yet' || value === 'wrong')) {
        addNextCard(value, updated);
      }
      // 第 2 天答完后，若已到第 7 天且未答，再出第 7 天卡
      if (payload.day === 2 && !force) appendFollowups(updated);
    } catch (err) {
      if (isApiError(err)) notify(err.message);
      else throw err;
    }
  };

  cards.forEach(({ payload, answer }) => {
    const payloadWithAnswer = Object.assign({}, payload, { answer });
    const cardEl = followupCard(payloadWithAnswer, {
      onAnswer: (day, value, note) => safeAsync(answerFollowup(payload, cardEl, value, note)),
    });
    addCardOnly(cardEl);
    markShown(payload.day);
    if (payload.day === 7 && answer && (answer.value === 'not_yet' || answer.value === 'wrong')) {
      addNextCard(answer.value, data);
    }
  });
  scrollToEnd();
}

function chosenDirectionId() {
  const session = state.session;
  return (session && session.chosenDirectionId) || directionId || null;
}

function stageHandlers(ai) {
  return {
    onStage(label) {
      if (ai) ai.setStage(label);
    },
    onReasoning(delta) {
      if (ai) ai.setReasoning(delta);
    },
    onSession(session) {
      if (!session) return;
      setState({ session });
      if (session.chosenDirectionId) directionId = session.chosenDirectionId;
      syncSessionSummary(session);
      scheduleSessionRefresh();
    },
  };
}

const STAGE_LABEL = {
  quality: '正在读照片',
  l0: '正在判断这个角落',
  measure: '正在算下一步',
  plan: '正在整理交付包',
  ask: '正在看这个位置',
};

const STAGE_ESTIMATE = {
  quality: 12000,
  l0: 14000,
  measure: 10000,
  plan: 10000,
  ask: 12000,
};

/** 等待反馈：阶段文案之外再给骨架屏 + 渐近进度，plan 阶段立即出现 */
function beginWait(ai, stage) {
  const label = (STAGE_LABEL[stage] || '正在处理') + '…';
  const wait = waitCard(label, {
    estimateMs: STAGE_ESTIMATE[stage] || 10000,
    hint:
      stage === 'plan'
        ? '正在按你的尺寸逐条对齐；通常 5—10 秒，不用刷新。'
        : '正在跑模型；通常几秒，不用刷新。',
  });
  let added = false;
  const show = () => {
    if (added) return;
    added = true;
    if (ai) ai.addCard(wait.el);
  };
  const timer = setTimeout(show, stage === 'plan' ? 0 : 900);
  return {
    finish() {
      clearTimeout(timer);
      if (added) wait.finish();
      else wait.fail();
    },
    fail() {
      clearTimeout(timer);
      wait.fail();
    },
  };
}

async function requestStage(ai, sessionId, stage, payload) {
  // 交付包需要证据徽章：渲染前先把 /api/evidence 拉一次（进程内缓存；失败不报错）
  if (stage === 'plan') {
    try {
      await api.getEvidence();
    } catch {
      /* 目录接口失败不影响交付 */
    }
  }
  const waiting = beginWait(ai, stage);
  try {
    const result = await api.streamStage({ sessionId, stage, payload }, stageHandlers(ai));
    waiting.finish();
    return result;
  } catch (err) {
    waiting.fail();
    throw err;
  }
}

let sessionsRefreshTimer = null;

/** 本地同步侧栏摘要，避免每次都要等 /api/sessions */
function syncSessionSummary(session) {
  if (!session) return;
  const list = Array.isArray(state.sessions) ? state.sessions.slice() : [];
  const index = list.findIndex((s) => s && s.id === session.id);
  const stage = session.plan ? 'delivered' : session.measureDone ? 'ready' : session.stage;
  const summary = Object.assign({}, index >= 0 ? list[index] : { id: session.id }, {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || new Date().toISOString(),
    stage,
    thumb: session.image ? session.image.url : index >= 0 ? list[index].thumb : '',
    verdict: session.plan ? session.plan.verdict : index >= 0 ? list[index].verdict : null,
    level: session.plan ? 'L1' : session.l0 ? 'L0' : null,
  });
  if (index >= 0) list[index] = summary;
  else list.unshift(summary);
  setState({ sessions: list });
}

function scheduleSessionRefresh() {
  if (sessionsRefreshTimer != null) return;
  sessionsRefreshTimer = setTimeout(() => {
    sessionsRefreshTimer = null;
    refreshSessions();
  }, 500);
}

function refreshSessions() {
  return api
    .listSessions()
    .then((list) => setState({ sessions: Array.isArray(list) ? list : [] }))
    .catch(() => {
      /* 列表刷新失败不打断主流程 */
    });
}

async function withBusy(fn) {
  if (state.busy) {
    notify('稍等，上一步还在跑');
    return null;
  }
  setState({ busy: true });
  try {
    return await fn();
  } finally {
    setState({ busy: false });
  }
}

function renderStageError(ai, err, retry) {
  if (!ai) return;
  ai.setStage('');
  ai.setText('这一步没跑通。');
  ai.addCard(
    errorCard(err && err.message ? err.message : '服务暂时不可用，稍后再试。', {
      onRetry: () => {
        safeAsync(retry());
      },
    })
  );
  ai.done();
}

function summarizeAnswers(answers) {
  const parts = [];
  Object.entries(answers || {}).forEach(([key, value]) => {
    const label = measureLabel(key);
    if (!value || value.skipped) parts.push(`${label}：跳过`);
    else parts.push(`${label} ${value.valueCm}cm`);
  });
  return parts.join('，');
}

function measureLabel(key) {
  const map = {
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
  return map[key] || key;
}

/* ------------------------------------------------------------------ 会话 */

export async function startSession() {
  return withBusy(async () => {
    clearFeed();
    clearCanvas();
    setPickMode(false);
    renderOverlays({ regions: [], annotations: [] });
    retakeRounds = 0;
    directionId = null;
    planCtaShown = false;
    resetWaitSteps();
    resetVotesPoll(null);
    setState({ session: null, stage: 'empty', pickMode: false });
    const session = await api.createSession().catch((err) => {
      if (isApiError(err)) {
        notify(err.message);
        return null;
      }
      throw err;
    });
    if (!session) return null;
    setState({ session });
    syncSessionSummary(session);
    addWelcome();
    await refreshSessions();
    return session;
  });
}

async function ensureSession() {
  if (state.session) return state.session;
  const session = await api.createSession();
  setState({ session });
  syncSessionSummary(session);
  await refreshSessions();
  return session;
}

/* ------------------------------------------------------------------ 上传 */

export async function handleImage(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) {
    notify('这个文件不是图片，换一张 jpg / png');
    return;
  }
  return withBusy(async () => {
    retakeRounds = 0;
    directionId = null;
    planCtaShown = false;
    const ai = addAI();
    ai.setStage('正在压缩照片…');
    try {
      const prepared = await prepareImage(file);
      addUser('拍好了，帮我看看这个角落。', { thumbUrl: prepared.dataUrl });

      const session = await ensureSession();
      const updated = await api.uploadImage(session.id, {
        dataUrl: prepared.dataUrl,
        width: prepared.width,
        height: prepared.height,
        metrics: prepared.metrics,
      });
      // 服务端 upload 会重置 quality/l0/plan/asks，但可能残留 measureDone / chosenDirectionId，
      // 前端这里清掉，避免重拍或复用 demo 会话时直接跳过测量。
      const cleanSession = Object.assign({}, updated, {
        measureDone: false,
        chosenDirectionId: null,
        lastAsk: null,
        asks: [],
        measurements: {},
      });
      setState({ session: cleanSession, stage: 'uploaded' });
      syncSessionSummary(cleanSession);
      scheduleSessionRefresh();
      setState({ panelOpen: false });
      renderPhotoStrip(cleanSession);

      initCanvas();
      await setImage(api.imageUrl(cleanSession) || prepared.dataUrl, {
        width: (cleanSession.image && cleanSession.image.width) || prepared.width,
        height: (cleanSession.image && cleanSession.image.height) || prepared.height,
      });
      // 新照片：清掉上一张图的标注与图例
      renderOverlays({ regions: [], annotations: [], activeId: null });
      // V2.1 等待三步骤（3 秒内给出具体进度，而不是无限 spinner）
      ensureWaitSteps().setStep(0);

      ai.setStage('');
      ai.done();

      const issues = localIssues(prepared.metrics);
      if (issues.length) {
        const blockedNow = issues.some((issue) => issue.severity === 'block');
        ai.setText(blockedNow ? '这张照片我先拦一下，先说问题。' : '照片能看，但有个小问题。');
        ai.addCard(
          qualityCard(
            {
              status: blockedNow ? 'retake' : 'pass',
              scene: { note: '先说明：这是在本机看出来的，还没交给模型。' },
              issues,
              photoTip: '能补光就补光，能稳住手机就稳住；重拍不扣次数。',
            },
            {
              onRetake: () => {
                requestFile();
                notify('换一张更清楚的照片');
              },
              onSkip: () => {
                safeAsync(qualityFlow());
              },
            }
          )
        );
        ai.done();
        schedule(() => qualityFlow(), 400);
        return;
      }
      await qualityFlow();
    } catch (err) {
      if (!isApiError(err)) throw err;
      renderStageError(ai, err, () => qualityFlow());
    }
  });
}

/* ------------------------------------------------------------------ 质检 */

export async function runQuality() {
  return withBusy(() => qualityFlow());
}

async function qualityFlow() {
  const session = state.session;
  if (!session) {
    notify('先传一张照片');
    return;
  }
  const ai = addAI();
  ai.setStage('正在读照片…');
  ensureWaitSteps().setStep(0);
  try {
    const payload = await requestStage(ai, session.id, 'quality', { profile: profilePayload() });
    const q = payload || {};
    const latest = state.session || session;
    const quality = latest.quality || q;
    ai.setStage('');
    if (currentWaitSteps) currentWaitSteps.setStep(1);
    ai.setText(
      quality.status === 'retake'
        ? '这张照片还有问题，先看一眼；也可以先按这张继续，但方向会保守一些。'
        : '照片可以。我先把场景看清楚，再给方向。'
    );
    ai.addCard(
      qualityCard(quality, {
        onRetake: () => {
          if (retakeRounds >= 2) {
            notify('已经重拍两次了，先按现有照片继续');
            return;
          }
          retakeRounds += 1;
          requestFile();
        },
        onSkip: () => {
          safeAsync(runL0());
        },
      })
    );
    ai.done();
    setState({ stage: 'quality' });
    schedule(() => runL0(), 700);
  } catch (err) {
    if (!isApiError(err)) throw err;
    renderStageError(ai, err, () => qualityFlow());
  }
}

/* ------------------------------------------------------------------ L0 */

export async function runL0() {
  return withBusy(() => l0Flow());
}

async function l0Flow() {
  const session = state.session;
  if (!session) {
    notify('先传一张照片');
    return;
  }
  const ai = addAI();
  ai.setStage('正在判断这个角落…');
  ensureWaitSteps().setStep(1);
  try {
    const payload = await requestStage(ai, session.id, 'l0', {
      profile: profilePayload(),
      directionId: chosenDirectionId(),
    });
    const l0 = payload || {};
    const latest = state.session || session;
    const data = latest.l0 || l0;

    // V2.1：指认句 + 边界句（服务端 recognition/boundary，旧数据用场景摘要兜底）
    const recognition = data.recognition || l0.recognition || (data.scene && data.scene.summary) || '';
    const boundary =
      data.boundary || l0.boundary || '照片里看不出进深，这一步只能给方向，不能保证放得下。';
    if (currentWaitSteps) {
      currentWaitSteps.setStep(2);
      currentWaitSteps.showRecognition(recognition, boundary, reselectPosition);
    }

    ai.setStage('');
    ai.setText(data.nextAction || data.verdictReason || '先看这几个方向。');

    // V2.1：L0 方向卡之前先问一句（一次点击写 profile.primaryPain，不做问卷）
    const sessionProfile = (state.session && state.session.profile) || {};
    const draftProfile = state.profileDraft || {};
    ai.addCard(
      goalChoices({
        selected: sessionProfile.primaryPain || draftProfile.primaryPain || '',
        onSelect: (label) => {
          setProfileValue('primaryPain', label);
          notify('记下了：' + label + '。后面的判断会按这个优先');
        },
      })
    );

    const directions = Array.isArray(data.directions) ? data.directions : [];
    let dirCard = null;
    if (directions.length) {
      dirCard = directionsCard(data, {
        onChoose: (direction) => safeAsync(chooseDirection(direction)),
        onMeasureNow: (direction) => safeAsync(chooseDirection(direction || directions[0])),
        onPickRegion: (regionId) => {
          renderOverlays({ regions: data.regions || [], annotations: [], activeId: regionId });
          notify('画布上高亮了这块区域');
        },
      });
      ai.addCard(dirCard);
    } else {
      ai.addCard(verdictCard(data));
      const blocked = Array.isArray(data.blocked) && data.blocked.length
        ? data.blocked
        : [{ what: '这个方向先不动', reason: data.verdictReason || '当前条件不成立', condition: data.nextAction || '' }];
      ai.addCard(blockedCard(blocked));
    }

    const regions = Array.isArray(data.regions) ? data.regions : [];
    if (regions.length) renderOverlays({ regions, annotations: [], activeId: null });

    setState({ stage: 'l0' });
    renderPhotoStrip(state.session);
    ai.done();
    if (dirCard) scrollCardToTop(dirCard);
    // demo 自动点一下「最想解决」chip，验证 primaryPain 会带进后续 payload
    schedule(() => {
      const chip = document.querySelector('#feed .goal-choice');
      if (chip) chip.click();
      return null;
    }, 300);
    schedule(() => {
      const first = directions[0];
      if (first) return chooseDirection(first);
      return null;
    }, 1000);
  } catch (err) {
    if (!isApiError(err)) throw err;
    renderStageError(ai, err, () => l0Flow());
  }
}

async function chooseDirection(direction) {
  if (!direction) return null;
  directionId = direction.id || directionId;
  setState({ session: Object.assign({}, state.session, { chosenDirectionId: directionId }) });
  addUser(`我想试这个：${direction.title || '这个方向'}`);
  setUserGoal(direction.title || getUserGoal());
  return runMeasure();
}

/* ------------------------------------------------------------------ 测量 */

export async function runMeasure(answers) {
  return withBusy(() => measureFlow(answers));
}

async function measureFlow(answers) {
  const session = state.session;
  if (!session) {
    notify('先传一张照片');
    return;
  }
  if (answers && Object.keys(answers).length) {
    const summary = summarizeAnswers(answers);
    if (summary) addUser('量好了：' + summary);
  }

  const roundsSoFar = Array.isArray(session.asks) ? session.asks.length : 0;
  if (session.measureDone || roundsSoFar >= 3) {
    promptPlan();
    return;
  }

  const ai = addAI();
  ai.setStage(answers ? '正在对照尺寸…' : '正在挑这轮要量什么…');
  try {
    const payload = await requestStage(ai, session.id, 'measure', {
      directionId: chosenDirectionId(),
      answers: answers || {},
      profile: profilePayload(),
    });
    const out = payload || {};
    const latest = state.session || session;
    const asks = Array.isArray(latest.asks) ? latest.asks : [];
    const done = latest.measureDone === true || (Array.isArray(out.questions) && out.questions.length === 0);

    ai.setStage('');
    if (done) {
      ai.setText('关键尺寸够了。可以出方案了。');
      ai.done();
      setState({ stage: 'ready' });
      promptPlan();
      return;
    }

    const storedAsk = asks[asks.length - 1] || {
      round: out.round || roundsSoFar + 1,
      questions: out.questions || [],
      remainingKeys: out.remainingKeys || [],
      askNote: out.askNote || '',
    };
    // totalTargets / attemptedTargets 来自 analyze payload，不落 session.asks，这里合并给卡片用
    const lastAsk = Object.assign({}, storedAsk, {
      totalTargets: out.totalTargets != null ? out.totalTargets : storedAsk.totalTargets,
      attemptedTargets: out.attemptedTargets != null ? out.attemptedTargets : storedAsk.attemptedTargets,
      askNote: storedAsk.askNote || out.askNote || '',
    });
    // 右栏测量进度与卡片同一口径（照片算第 1 步）
    const totalTargets = Number(lastAsk.totalTargets);
    if (Number.isFinite(totalTargets) && totalTargets > 0 && state.session) {
      const done = Math.min(totalTargets + 1, (Number(lastAsk.attemptedTargets) || 0) + 1);
      setState({
        session: Object.assign({}, state.session, { measureProgress: { total: totalTargets + 1, done } }),
      });
    }
    const questions = (Array.isArray(lastAsk.questions) ? lastAsk.questions : []).slice(0, 2);
    const labels = questions.map((q) => q.label || measureLabel(q.key)).join('、');
    ai.setText(lastAsk.askNote || `下一步：量 ${labels}。`);
    let firstMeasureCard = null;
    if (questions.length > 1) {
      // V2.1 一卡一项：拆成独立卡、连续提交；最后一张填完才发一次请求
      const collected = {};
      questions.forEach((question, index) => {
        const singleAsk = Object.assign({}, lastAsk, { questions: [question] });
        const cardEl = measureCard(singleAsk, {
          leadText: index === 0 ? MEASURE_LEAD_COPY : '',
          onSubmit: (nextAnswers) => {
            Object.assign(collected, nextAnswers);
            const answered = Object.keys(collected).length;
            if (answered >= questions.length) {
              safeAsync(runMeasure(collected));
            } else {
              // 显式反馈：第一张卡头写清楚「已记下 1/2」
              const kicker = cardEl.querySelector('.card-kicker');
              if (kicker) kicker.textContent = `已记下 ${answered}/${questions.length}，填完下面这个就提交`;
              notify(`记下了，再填下面 ${questions.length - answered} 个就提交`);
            }
          },
          onSkipAll: () => promptPlan(),
        });
        if (!firstMeasureCard) firstMeasureCard = cardEl;
        ai.addCard(cardEl);
      });
    } else {
      firstMeasureCard = measureCard(lastAsk, {
        onSubmit: (nextAnswers) => safeAsync(runMeasure(nextAnswers)),
        onSkipAll: () => promptPlan(),
      });
      ai.addCard(firstMeasureCard);
    }
    ai.done();
    setState({ stage: 'measuring' });
    if (firstMeasureCard) scrollCardToTop(firstMeasureCard);
    schedule(() => submitDemoAnswers(questions), 900);
  } catch (err) {
    if (!isApiError(err)) throw err;
    renderStageError(ai, err, () => measureFlow());
  }
}

function submitDemoAnswers(questions) {
  if (!Array.isArray(questions) || !questions.length) return null;
  const answers = {};
  questions.forEach((q) => {
    answers[q.key] = { valueCm: MEASURE_DEFAULTS[q.key] || 60 };
  });
  return runMeasure(answers);
}

/** 测量完成后的 CTA（中栏内联按钮 + 右栏 dock 都会出现） */
export function promptPlan() {
  const session = state.session;
  if (!session) return;
  setState({ stage: 'ready' });
  if (planCtaShown) {
    const existing = document.getElementById('btn-deliver-inline');
    if (existing) {
      existing.focus();
      scrollToEnd();
      return;
    }
  }
  planCtaShown = true;

  const ai = addAI();
  ai.setText('尺寸够了。下一步走规则校验，生成标注图、放置建议、尺寸条件和现场清单。');
  ai.addCard(buildPlanCta());
  ai.done();
  setState({ stage: 'ready' });
  schedule(() => {
    try {
      document.dispatchEvent(new CustomEvent('corner:unlock'));
    } catch {
      /* ignore */
    }
    return null;
  }, 600);
}

function buildPlanCta() {
  const card = document.createElement('div');
  card.className = 'card card-cta';
  card.dataset.type = 'cta';

  const body = document.createElement('div');
  body.className = 'card-body';
  const lead = document.createElement('p');
  lead.className = 'card-lead';
  lead.textContent = '这一步只做演示解锁：不接支付，也不会扣款。校验过一遍规则后给你 L1。';
  body.append(lead);

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-deliver-inline';
  btn.className = 'btn btn-primary btn-block';
  btn.textContent = '生成可执行方案';
  btn.addEventListener('click', () => {
    try {
      document.dispatchEvent(new CustomEvent('corner:unlock'));
    } catch {
      /* ignore */
    }
  });
  foot.append(btn);
  card.append(body, foot);
  return card;
}

/* ------------------------------------------------------------------ 方案 */

export async function runPlan() {
  return withBusy(() => planFlow());
}

async function planFlow() {
  const session = state.session;
  if (!session) {
    notify('先传一张照片');
    return;
  }
  const ai = addAI();
  ai.setStage('正在按尺寸排方案…');
  try {
    const payload = await requestStage(ai, session.id, 'plan', {
      directionId: chosenDirectionId(),
      profile: profilePayload(),
      ...(followupFeedback ? { followupFeedback } : {}),
    });
    followupFeedback = null;
    const plan = payload || {};
    const latest = state.session || session;
    const data = latest.plan || plan;
    ai.setStage('');
    ai.setText('交付包整理好了：标注、位置、尺寸条件、建议、清单都在下面。');
    const l0Directions =
      latest.l0 && Array.isArray(latest.l0.directions) ? latest.l0.directions : [];
    ai.addCard(
      planCard(data, {
        onExport: () => exportDeliver(),
        onTab: () => {},
        onToggleCheck: () => {},
        directions: l0Directions,
        chosenDirectionId: chosenDirectionId(),
        onRecalculate: (patch) => safeAsync(recalculatePlan(patch)),
        onPickRegions: () => {
          setState({ pickMode: true });
          setPickMode(true);
          if (typeof window !== 'undefined' && window.innerWidth < 900) setState({ panelOpen: true });
          notify('点画布上的新位置，我会重新看这个点');
        },
      })
    );
    const annotations = Array.isArray(data.annotations) ? data.annotations : [];
    renderOverlays({ regions: [], annotations, activeId: null });
    setState({ stage: 'delivered' });
    renderPhotoStrip(state.session);
    // V3 交付收尾卡（完成感），在 plan 卡下方
    const deliveredSession = state.session || latest;
    ai.addCard(handoffCard(deliveredSession, handoffContext(data)));
    ai.done();
    renderCompareCard(deliveredSession);
    safeAsync(refreshVotes());
    notify('方案已生成，可以导出标注图带走');
    schedule(() => {
      notify('演示流程跑完了。可以点画布上的位置继续问，或导出一张标注图。');
      return null;
    }, 900);
  } catch (err) {
    if (!isApiError(err)) throw err;
    renderStageError(ai, err, () => planFlow());
  }
}

export function exportDeliver() {
  try {
    const dataUrl = exportPNG();
    if (dataUrl) notify('标注图已导出（PNG）');
  } catch (err) {
    notify('导出失败：' + (err && err.message ? err.message : '未知原因'));
  }
}

/** V2.1「改一改」：就地改尺寸 / 换方向后重算（不新开弹窗） */
export async function recalculatePlan(patch = {}) {
  return withBusy(async () => {
    const session = state.session;
    if (!session) {
      notify('先有一个交付包才能改');
      return;
    }
    const changes = patch && typeof patch === 'object' ? patch : {};
    if (changes.followupFeedback) followupFeedback = changes.followupFeedback;
    if (changes.measurements && typeof changes.measurements === 'object') {
      for (const [key, value] of Object.entries(changes.measurements)) {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) continue;
        const updated = await api.answer(session.id, { key, valueCm: num }).catch((err) => {
          if (isApiError(err)) {
            notify(err.message);
            return null;
          }
          throw err;
        });
        if (updated) setState({ session: updated });
      }
    }
    if (changes.directionId != null) {
      directionId = changes.directionId;
      if (state.session) {
        setState({
          session: Object.assign({}, state.session, { chosenDirectionId: changes.directionId }),
        });
      }
    }
    notify('按你的修改重算一遍');
    await planFlow();
  });
}

/* ------------------------------------------------------------------ 点选 */

export async function handlePick({ nx, ny } = {}) {
  const x = Number(nx);
  const y = Number(ny);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  return withBusy(async () => {
    const session = state.session;
    if (!session) {
      notify('先传一张照片');
      return;
    }
    const ai = addAI();
    addUser(`我想放在这里（横向 ${Math.round(x * 100)}% · 纵向 ${Math.round(y * 100)}% 的位置）`);
    ai.setStage('正在看这个位置…');
    try {
      const payload = await requestStage(ai, session.id, 'ask', {
        nx: Math.round(x * 1000) / 1000,
        ny: Math.round(y * 1000) / 1000,
        note: getUserGoal() || '想在这里放猫窝',
        profile: profilePayload(),
      });
      const out = payload || {};
      const latest = state.session || session;
      const data = latest.lastAsk || out;
      ai.setStage('');
      ai.setText('这个位置我看过了，先给结论：');
      if (data.verdict || (Array.isArray(data.pieces) && data.pieces.length)) ai.addCard(askCard(data));
      ai.done();
      setState({ pickMode: false });
      setPickMode(false);
      schedule(() => null, 0);
    } catch (err) {
      if (!isApiError(err)) throw err;
      renderStageError(ai, err, () => handlePick({ nx: x, ny: y }));
    }
  });
}

/* ------------------------------------------------------------------ 输入框 */

function handleCommand(raw) {
  const cmd = raw.split(/\s+/)[0];
  switch (cmd) {
    case '/重拍':
      requestFile();
      notify('选一张新照片');
      return true;
    case '/重来':
      safeAsync(startSession());
      return true;
    case '/测量':
      safeAsync(runMeasure());
      return true;
    case '/方案':
      promptPlan();
      return true;
    case '/导出':
      exportDeliver();
      return true;
    case '/帮助':
    case '/?':
      notify('可用命令：/重拍 /重来 /测量 /方案 /导出');
      return true;
    default:
      notify('没认出这个命令。可用：/重拍 /重来 /测量 /方案 /导出');
      return true;
  }
}

export async function handleUserText(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return;
  if (state.busy) {
    notify('上一步还在跑，等一下');
    return;
  }
  addUser(raw);
  setUserGoal(raw);
  if (raw.startsWith('/')) {
    handleCommand(raw);
    return;
  }

  if (!state.session) {
    const ai = addAI();
    ai.setText('收到。先把角落拍下来——照片里能看到墙和地面，我就能判断值不值得改。');
    ai.done();
    return;
  }

  const stage = state.stage;
  if (stage === 'empty' || stage === 'uploaded') {
    const ai = addAI();
    ai.setText('先传一张照片吧。你说的这个位置，我得看到墙、地面和旁边的家具才能判断。');
    ai.done();
    return;
  }

  return withBusy(async () => {
    const session = state.session;
    const ai = addAI();
    ai.setStage('正在想…');
    try {
      const payload = await requestStage(ai, session.id, 'ask', { nx: 0.5, ny: 0.5, note: raw, profile: profilePayload() });
      const out = payload || {};
      const latest = state.session || session;
      const data = latest.lastAsk || out;
      ai.setStage('');
      ai.setText('先按你现在的描述说，不硬给结论：');
      if (data.verdict || (Array.isArray(data.pieces) && data.pieces.length)) ai.addCard(askCard(data));
      if (Array.isArray(data.questions) && data.questions.length) {
        ai.addCard(
          measureCard(
            { round: (latest.asks || []).length + 1, questions: data.questions },
            { onSubmit: (answers) => safeAsync(runMeasure(answers)), onSkipAll: () => promptPlan() }
          )
        );
      }
      ai.done();
    } catch (err) {
      if (!isApiError(err)) throw err;
      renderStageError(ai, err, () => handleUserText(raw));
    }
  });
}

/* ------------------------------------------------------------------ 历史回放 */

/**
 * replaySession(session) — 历史会话重放成一屏（CONTRACT §5.8）。
 * 纯本地重建，不发任何模型请求。
 */
export async function replaySession(session) {
  if (!session) return;
  setState({ session });
  directionId = session.chosenDirectionId || null;
  planCtaShown = Boolean(session.plan);
  retakeRounds = 0;
  resetWaitSteps();
  resetVotesPoll(session.id);
  clearFeed();
  clearCanvas();
  setPickMode(false);
  renderOverlays({ regions: [], annotations: [], activeId: null });

  const asks = Array.isArray(session.asks) ? session.asks : [];
  const hasAnything = Boolean(
    session.image || session.quality || session.l0 || asks.length || session.plan
  );
  if (!hasAnything) {
    setState({ stage: 'empty', pickMode: false });
    addWelcome();
    return;
  }

  const stage = session.plan
    ? 'delivered'
    : session.measureDone
    ? 'ready'
    : session.stage === 'measuring'
    ? 'measuring'
    : session.l0
    ? 'l0'
    : session.quality
    ? 'quality'
    : 'uploaded';
  setState({ stage });

  // 1) 图片
  const imageUrl = api.imageUrl(session);
  if (session.image) {
    try {
      await setImage(imageUrl, { width: session.image.width, height: session.image.height });
    } catch {
      /* 图片可能已被删除，文字部分照常回放 */
    }
    addUser('', { thumbUrl: imageUrl });
    const tip = addAI();
    tip.setText('继续上次的角落。下面是当时的结果，按顺序重放，不会重新跑模型。');
    tip.done();
  }

  // 2) 质检
  let replayDirCard = null;
  let replayMeasureCard = null;
  if (session.quality) {
    const ai = addAI();
    ai.setText('上次的照片质检结果。');
    ai.addCard(qualityCard(session.quality, {}));
    ai.done();
  }

  // 3) L0 方向（已选方向置顶，其余折叠）
  if (session.l0) {
    const ai = addAI();
    ai.setText(session.l0.nextAction || session.l0.verdictReason || '上次看到的方向。');
    replayDirCard = directionsCard(session.l0, {
      chosenId: session.chosenDirectionId || null,
      onPickRegion: (regionId) => {
        renderOverlays({ regions: session.l0.regions || [], annotations: [], activeId: regionId });
      },
    });
    ai.addCard(replayDirCard);
    ai.done();
  }

  // 4) 测量轮次：已答轮次只出紧凑记录行；最后一个未答轮次出测量卡
  const measurements = session.measurements || {};
  asks.forEach((ask, index) => {
    const questions = Array.isArray(ask.questions) ? ask.questions : [];
    if (!questions.length) return;
    const answered = ask.answers && Object.keys(ask.answers).length > 0;
    const isLast = index === asks.length - 1;
    if (answered) {
      const parts = questions
        .map((q) => {
          const ans = ask.answers[q.key] || measurements[q.key];
          const label = q.label || measureLabel(q.key);
          if (!ans) return null;
          if (ans.skipped) return label + '：跳过';
          const valueCm =
            ans.valueCm != null ? ans.valueCm : ans.valueMm != null ? Number((ans.valueMm / 10).toFixed(1)) : null;
          return label + (valueCm == null ? '：待确认' : ' ' + valueCm + 'cm');
        })
        .filter(Boolean);
      const ai = addAI();
      ai.setText(`第 ${ask.round || index + 1} 步 · 已量：${parts.join(' / ') || '已记录'}`);
      ai.done();
    } else if (isLast) {
      const ai = addAI();
      ai.setText('上次停在这一步，接着量就行。');
      replayMeasureCard = measureCard(ask, {
        onSubmit: (answers) => safeAsync(runMeasure(answers)),
        onSkipAll: () => promptPlan(),
      });
      ai.addCard(replayMeasureCard);
      ai.done();
    }
  });

  // 5) L1 交付包（先拉证据目录，徽章才能显示；失败不影响回放）
  if (session.plan) {
    try {
      await api.getEvidence();
    } catch {
      /* 证据目录不可用就只回放卡片本体 */
    }
    const ai = addAI();
    ai.setText('上次的 L1 交付包。');
    ai.addCard(planCard(session.plan, { onExport: () => exportDeliver() }));
    // V3 收尾卡 + 已记录的改造对比 + 家人意见
    ai.addCard(handoffCard(session, handoffContext(session.plan)));
    ai.done();
    renderOverlays({
      regions: session.l0 && Array.isArray(session.l0.regions) ? session.l0.regions : [],
      annotations: Array.isArray(session.plan.annotations) ? session.plan.annotations : [],
      activeId: null,
    });
    renderCompareCard(session);
    safeAsync(refreshVotes());
  } else if (session.l0) {
    renderOverlays({
      regions: session.l0.regions || [],
      annotations: [],
      activeId: session.chosenDirectionId || null,
    });
  }

  if (!session.plan && session.measureDone) promptPlan();
  appendFollowups(session);
  renderPhotoStrip(state.session || session);
  scrollToEnd();
  // V3.1：移动端把测量卡 / 推荐方向卡滚到顶部（主 CTA 进首屏）；plan 阶段不抢滚动
  if (!session.plan) {
    if (replayMeasureCard) scrollCardToTop(replayMeasureCard);
    else if (replayDirCard) scrollCardToTop(replayDirCard);
  }
}

/** 供 app 恢复历史会话时复用 */
export function applyRestoredSession(session) {
  if (!session) return;
  setState({ session });
  if (session.chosenDirectionId) directionId = session.chosenDirectionId;
}

/* ---------------------------------------------- V3 收尾卡 / 分享 / 家人意见 / 对比 */

function cardLabels() {
  const map = {};
  const session = state.session;
  const plan = session && session.plan;
  if (plan && Array.isArray(plan.items)) {
    plan.items.forEach((item) => {
      if (item && item.id != null) map[String(item.id)] = item.title || '这个方案';
    });
  }
  if (session && session.l0 && Array.isArray(session.l0.directions)) {
    session.l0.directions.forEach((direction) => {
      if (direction && direction.id != null) map[String(direction.id)] = direction.title || '这个方向';
    });
  }
  return map;
}

function copyChecklistText(plan) {
  const checklist = plan && Array.isArray(plan.checklist) ? plan.checklist : [];
  const lines = checklist.map((item, index) => `${index + 1}. ${item.text || ''}${item.critical ? '（关键）' : ''}`);
  const text = [plan && plan.headline ? plan.headline : '', '', ...lines, '', '以交付时的尺寸条件为准，落地前请现场确认。']
    .filter((line) => line !== undefined && line !== null)
    .join('\n');
  if (!checklist.length) {
    notify('这份方案没有现场清单可复制');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => notify('现场清单已复制'))
      .catch(() => notify('复制失败，可以截图清单'));
  } else {
    notify('浏览器不支持剪贴板，截图清单也可以');
  }
}

function requestAfterFile() {
  try {
    document.dispatchEvent(new CustomEvent('corner:pick-after'));
  } catch {
    /* ignore */
  }
}

function updateHandoffStatus(share) {
  const session = state.session;
  const activeShare = share || (session && session.share) || null;
  const hasShare = Boolean(activeShare && activeShare.token);
  const count =
    votesPoll.sessionId && session && votesPoll.sessionId === session.id
      ? Number(votesPoll.respondCount) || 0
      : Number(activeShare && activeShare.respondCount) || 0;
  const unread =
    votesPoll.sessionId && session && votesPoll.sessionId === session.id ? Number(votesPoll.respondUnread) || 0 : 0;
  document.querySelectorAll('#feed .card-handoff .handoff-share-status').forEach((node) => {
    node.hidden = !hasShare;
    node.textContent = '';
    if (!hasShare) return;
    if (count > 0) {
      node.append(document.createTextNode(`家人已回应 ${count} 条`));
      if (unread > 0) {
        const strong = document.createElement('b');
        strong.className = 'handoff-new';
        strong.textContent = ` · ${unread} 条新`;
        node.append(strong);
      }
    } else {
      node.textContent = '已分享 · 等待家人意见';
    }
  });
  document.querySelectorAll('#feed .card-handoff .handoff-actions .btn-primary').forEach((btn) => {
    btn.textContent = hasShare ? '再次分享给大家' : '分享给同住的人';
  });
}

function handoffContext(planData) {
  return {
    onExport: () => exportDeliver(),
    onShare: () => safeAsync(shareSession()),
    onAfter: () => requestAfterFile(),
    onCopyChecklist: () => copyChecklistText(planData),
    notifyState: getNotifyState(),
    onToggleNotify: () => safeAsync(toggleSystemNotify()),
  };
}

/** 生成（或复用）分享链接，并让 app 打开分享面板 */
export async function shareSession() {
  const session = state.session;
  if (!session) {
    notify('先完成一次交付再分享');
    return null;
  }
  try {
    // 分享页只拿 900px 缩略图：用同一套压缩逻辑生成，失败降级为不传
    let photoDataUrl = '';
    const beforeUrl = api.imageUrl(session);
    if (beforeUrl) {
      try {
        const thumb = await prepareShareThumb(beforeUrl);
        if (thumb && thumb.dataUrl) photoDataUrl = thumb.dataUrl;
      } catch {
        photoDataUrl = '';
      }
    }

    let existing = await api.getShare(session.id).catch(() => null);
    // 旧分享可能仍是原图：这次带了缩略图就撤销重建，确保分享页拿不到原图
    if (existing && existing.token && photoDataUrl) {
      await api.revokeShare(session.id).catch(() => {});
      existing = null;
    }
    const share =
      existing && existing.token
        ? existing
        : await api.createShare(session.id, {
            hasPhoto: Boolean(photoDataUrl),
            photoDataUrl,
          });
    if (!share || !share.token) {
      notify('分享链接生成失败，稍后再试');
      return null;
    }
    // 缩略图失败时降级：分享页不含照片（隐私优先），明确告诉用户
    if (beforeUrl && !photoDataUrl) {
      notify('照片没上传成功，分享页将不含照片');
    }
    setState({ session: Object.assign({}, state.session, { share }) });
    updateHandoffStatus(share);
    try {
      document.dispatchEvent(new CustomEvent('corner:share-sheet', { detail: { share, sessionId: session.id } }));
    } catch {
      /* ignore */
    }
    return share;
  } catch (err) {
    if (isApiError(err)) {
      notify(err.message);
      return null;
    }
    throw err;
  }
}

/** 撤销分享：链接立即失效 */
export async function revokeShareSession() {
  const session = state.session;
  if (!session) return;
  try {
    await api.revokeShare(session.id);
    setState({ session: Object.assign({}, state.session, { share: null }) });
    updateHandoffStatus(null);
    notify('分享已撤销，链接立即失效');
  } catch (err) {
    if (isApiError(err)) notify(err.message);
    else throw err;
  }
}

/** 分享面板关闭后刷新家人意见（会走 15s 节流，必要时排尾随请求） */
export function notifyShareClosed() {
  safeAsync(refreshVotes({ reason: 'share-closed' }));
}

function removeCompareUI() {
  document.querySelectorAll('#feed .card-compare').forEach((node) => {
    const item = node.closest('.feed-item');
    if (item) item.remove();
    else node.remove();
  });
}

function renderCompareCard(session) {
  removeCompareUI();
  if (!session || !session.afterImage || !session.afterImage.url) return;
  const card = compareCard(session, {
    beforeUrl: api.imageUrl(session),
    onExportCompare: (summary) => safeAsync(exportCompare(summary)),
    onPickAfter: () => requestAfterFile(),
    onRemoveAfter: () => safeAsync(removeAfterImage()),
  });
  if (!card) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'feed-item ai';
  const cards = document.createElement('div');
  cards.className = 'cards';
  cards.append(card);
  wrapper.append(cards);
  const handoff = document.querySelector('#feed .card-handoff');
  const votes = document.querySelector('#feed .card-votes');
  const anchor = votes || handoff;
  if (anchor) {
    const anchorItem = anchor.closest('.feed-item') || anchor;
    anchorItem.insertAdjacentElement('afterend', wrapper);
  } else {
    const feed = document.getElementById('feed');
    if (feed) feed.append(wrapper);
  }
  scrollToEnd();
}

/** 上传「改造后」照片 → 生成前后对比卡 */
export async function handleAfterImage(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) {
    notify('这个文件不是图片，换一张 jpg / png');
    return;
  }
  return withBusy(async () => {
    const session = state.session;
    if (!session || !session.plan) {
      notify('先完成一次交付再记录改造结果');
      return;
    }
    const ai = addAI();
    ai.setStage('正在压缩改造后照片…');
    try {
      const prepared = await prepareImage(file);
      const updated = await api.uploadAfter(session.id, {
        dataUrl: prepared.dataUrl,
        width: prepared.width,
        height: prepared.height,
      });
      setState({ session: updated || state.session });
      ai.setStage('');
      ai.setText('改造后的照片记录好了，下面是前后对比。');
      ai.done();
      renderCompareCard(state.session);
      notify('已生成改造前后对比');
    } catch (err) {
      if (!isApiError(err)) throw err;
      renderStageError(ai, err, () => handleAfterImage(file));
    }
  });
}

export async function removeAfterImage() {
  const session = state.session;
  if (!session || !session.afterImage) return;
  return withBusy(async () => {
    try {
      await api.deleteAfter(session.id);
      setState({ session: Object.assign({}, state.session, { afterImage: null }) });
      removeCompareUI();
      notify('已删除改造后照片');
    } catch (err) {
      if (isApiError(err)) notify(err.message);
      else throw err;
    }
  });
}

async function exportCompare(summary) {
  const session = state.session;
  const after = session && session.afterImage;
  if (!session || !after || !after.url) {
    notify('先上传改造后照片');
    return;
  }
  try {
    const dataUrl = await composeComparePNG({
      beforeUrl: api.imageUrl(session),
      afterUrl: after.url,
      annotations: session.plan && Array.isArray(session.plan.annotations) ? session.plan.annotations : [],
      title: '猫角落 corner. · 改造前后',
      summary: summary || '按方案落地后的样子',
    });
    if (dataUrl) notify('对比图已导出（PNG）');
  } catch (err) {
    notify('导出失败：' + (err && err.message ? err.message : '未知原因'));
  }
}

/* ------------------------------------------------------------------ demo */

async function demoFile() {
  const blob = await api.loadDemoImage();
  if (!blob) throw new api.ApiError('示例图片没加载出来（/demo/corner.jpg），检查服务端静态目录');
  const type = blob.type && /^image\//.test(blob.type) ? blob.type : 'image/jpeg';
  return new File([blob], 'corner-demo.jpg', { type });
}

/**
 * ?demo=1：真实走一遍上传 → 质检 → L0 → 测量 → 解锁 → 交付（只有解锁是模拟的）。
 * 复用 localStorage 里记住的 demo 会话，避免每次刷新都堆一条同名历史。
 */
export async function startDemo() {
  demoMode = true;
  try {
    let session = null;
    try {
      const saved = window.localStorage.getItem('corner.demoSessionId');
      if (saved) session = await api.getSession(saved);
    } catch {
      session = null;
    }
    if (!session) {
      session = await api.createSession();
      try {
        window.localStorage.setItem('corner.demoSessionId', session.id);
      } catch {
        /* 隐私模式忽略 */
      }
    }
    clearFeed();
    clearCanvas();
    setPickMode(false);
    renderOverlays({ regions: [], annotations: [], activeId: null });
    retakeRounds = 0;
    directionId = null;
    planCtaShown = false;
    resetWaitSteps();
    resetVotesPoll(session.id);
    setState({ session, stage: 'empty', pickMode: false });
    syncSessionSummary(session);
    scheduleSessionRefresh();
    const file = await demoFile();
    await handleImage(file);
  } catch (err) {
    if (isApiError(err)) {
      notify(err.message);
      addCardOnly(errorCard(err.message, { onRetry: () => safeAsync(startDemo()) }));
      return;
    }
    throw err;
  }
}

export function isDemoMode() {
  return demoMode;
}
