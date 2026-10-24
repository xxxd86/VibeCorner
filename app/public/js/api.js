// api.js — 唯一 fetch 出口。所有服务端调用都从这里走，方便统一超时与中文错误。
// SSE：POST /api/analyze，按 `data: {...}\n\n` 逐条 dispatch 给 handlers。

const ANALYZE_TIMEOUT_MS = 125000; // 服务端模型调用最长 120s，这里留 5s 余量
const QUICK_TIMEOUT_MS = 10000;

/** 可读中文错误；status 用于 UI 决定是否提示接口故障 */
export class ApiError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'ApiError';
    this.status = info && info.status ? info.status : 0;
    this.code = (info && info.code) || 'error';
  }
}

function emitApiError(message, status, path) {
  try {
    document.dispatchEvent(
      new CustomEvent('corner:api-error', {
        detail: { message: String(message || ''), status: Number(status) || 0, path: String(path || '') },
      })
    );
  } catch {
    /* 事件派发失败不影响主流程 */
  }
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    },
  };
}

async function readErrorBody(res) {
  let message = '';
  let code = '';
  try {
    const data = await res.json();
    if (data && data.error) {
      message = data.error.message || '';
      code = data.error.code || '';
    }
  } catch {
    /* 非 JSON 错误体，用状态码兜底 */
  }
  return { message, code };
}

/**
 * @param {string} path
 * @param {{method?:string, body?:any, timeout?:number, silent?:boolean}} opts
 *        silent=true 时不把错误写进 #dev-error-banner（用于可选的证据目录接口）
 */
async function request(path, opts = {}) {
  const method = opts.method || 'GET';
  const timeout = opts.timeout || QUICK_TIMEOUT_MS;
  const { signal, clear } = withTimeout(timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: opts.body == null ? undefined : { 'content-type': 'application/json' },
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
      signal,
    });
  } catch (err) {
    clear();
    const message =
      err && err.name === 'AbortError'
        ? '本地服务响应超时，稍后再试'
        : '连不上本地服务（8848）。确认 node app/server/index.mjs 正在运行';
    if (!opts.silent) emitApiError(message, 0, path);
    throw new ApiError(message, { status: 0, code: 'network' });
  } finally {
    clear();
  }
  if (!res.ok) {
    const { message, code } = await readErrorBody(res);
    const text = message || `请求失败（HTTP ${res.status}）`;
    if (!opts.silent) emitApiError(text, res.status, path);
    throw new ApiError(text, { status: res.status, code: code || 'http_error' });
  }
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return res.json();
  return res.text();
}

/* ------------------------------------------------------------------ 会话 */

export async function health() {
  return request('/api/health', { timeout: 8000 });
}

export async function createSession() {
  return request('/api/sessions', { method: 'POST', body: {} });
}

export async function listSessions() {
  const data = await request('/api/sessions');
  if (Array.isArray(data)) return data;
  return Array.isArray(data && data.sessions) ? data.sessions : [];
}

/** 服务端个别图片对象只带 imageId；补出 url，避免对比卡等渲染成空 */
function normalizeSession(session) {
  if (session && session.afterImage && !session.afterImage.url && session.afterImage.imageId) {
    session.afterImage.url = `/api/image/${session.afterImage.imageId}`;
  }
  return session;
}

export async function getSession(id) {
  return normalizeSession(await request(`/api/sessions/${encodeURIComponent(id)}`));
}

export async function deleteSession(id) {
  return request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function uploadImage(sessionId, { dataUrl, width, height, metrics } = {}) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/image`, {
    method: 'POST',
    body: { dataUrl, width, height, metrics },
    timeout: 30000,
  });
  return data && data.session ? data.session : data;
}

export function imageUrl(session) {
  const image = session && session.image;
  if (!image) return '';
  if (image.url) return image.url;
  if (image.imageId) return `/api/image/${image.imageId}`;
  return '';
}

/** 单条尺寸落库（V2.1「改一改」重算前使用；支持区间估计） */
export async function answer(sessionId, { key, valueCm, rangeCm, estimate, skipped } = {}) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
    method: 'POST',
    body: { key, valueCm, rangeCm, estimate, skipped },
  });
  return data && data.session ? data.session : data;
}

/* ------------------------------------------ V3 家庭分享 / 家人意见 / 改造后 */

/** 生成分享链接：{token,url,expiresAt,hasPhoto}；photoDataUrl 为 900px 分享缩略图 */
export async function createShare(sessionId, { hasPhoto = true, photoDataUrl = '' } = {}) {
  const body = { hasPhoto };
  if (photoDataUrl) body.photoDataUrl = photoDataUrl;
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
    method: 'POST',
    body,
    timeout: 30000,
  });
  return data && data.share ? data.share : data;
}

/** 当前会话的分享；没有返回 null */
export async function getShare(sessionId) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/share`);
  if (data && Object.prototype.hasOwnProperty.call(data, 'share')) return data.share || null;
  return data && data.token ? data : null;
}

/** 撤销分享（立即失效） */
export async function revokeShare(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/share`, { method: 'DELETE' });
}

/** 主人侧家人意见/回应：{votes, counts, voteCount, responds, respondCount} */
export async function getVotes(sessionId) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/votes`);
  if (Array.isArray(data)) {
    return { votes: data, counts: {}, voteCount: data.length, responds: [], respondCount: 0 };
  }
  const votes = Array.isArray(data && data.votes) ? data.votes : [];
  const responds = Array.isArray(data && data.responds) ? data.responds : [];
  return {
    votes,
    counts: (data && data.counts) || {},
    voteCount: Number.isFinite(Number(data && data.voteCount)) ? Number(data.voteCount) : votes.length,
    responds,
    respondCount: Number.isFinite(Number(data && data.respondCount)) ? Number(data.respondCount) : responds.length,
    viewCount: Number.isFinite(Number(data && data.viewCount)) ? Number(data.viewCount) : null,
    expiresAt: (data && data.expiresAt) || null,
  };
}

/** 家庭页行动回应（measure/photo/disagree/agree） */
export async function respondShare(token, { action, note = '', name = '', deviceId = '', consent = false, photoDataUrl = '' } = {}) {
  const body = { action, note, name, deviceId, consent };
  if (photoDataUrl) body.photoDataUrl = photoDataUrl;
  return request(`/api/share/${encodeURIComponent(token)}/respond`, {
    method: 'POST',
    body,
    timeout: 30000,
  });
}

/** 主人：把家人回传的现场照设为改造后照片 */
export async function useSharePhotoAsAfter(sessionId, respondId) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/after-from-respond`, {
    method: 'POST',
    body: { respondId },
    timeout: 30000,
  });
  return normalizeSession(data && data.session ? data.session : data);
}

/** 上传「改造后」照片，返回更新后的 session */
export async function uploadAfter(sessionId, { dataUrl, width, height } = {}) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/after`, {
    method: 'POST',
    body: { dataUrl, width, height },
    timeout: 30000,
  });
  return normalizeSession(data && data.session ? data.session : data);
}

export async function deleteAfter(sessionId) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/after`, { method: 'DELETE' });
}

/** 分享页只读数据（ShareView） */
export async function fetchShareView(token) {
  return request(`/api/share/${encodeURIComponent(token)}`, { timeout: 12000 });
}

export function sharePhotoUrl(token) {
  return `/api/share/${encodeURIComponent(token)}/photo`;
}

/** 家人投票（同一 voteId + targetId 覆盖上一次） */
export async function vote(token, { targetId, targetType = 'item', vote: choice, note = '', name = '', voteId = '' } = {}) {
  return request(`/api/share/${encodeURIComponent(token)}/vote`, {
    method: 'POST',
    body: { targetId, targetType, vote: choice, note, name, voteId },
    timeout: 15000,
  });
}

/* ------------------------------------------------------------------ SSE */

function makeBlockParser(onMessage) {
  return function feed(block) {
    const dataLines = [];
    const lines = String(block || '').split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // 半帧/脏帧忽略，等待后续
    }
    if (msg && typeof msg === 'object') onMessage(msg);
  };
}

/**
 * 流式分析。
 * handlers = {onStage(label), onReasoning(delta), onFinal(payload), onError(msg), onSession(session)}
 * 返回 final.payload；`final` 里若带 session，会通过 onSession 交给调用方覆盖本地会话。
 */
export async function streamStage({ sessionId, stage, payload = {} } = {}, handlers = {}) {
  const onStage = typeof handlers.onStage === 'function' ? handlers.onStage : () => {};
  const onReasoning = typeof handlers.onReasoning === 'function' ? handlers.onReasoning : () => {};
  const onFinal = typeof handlers.onFinal === 'function' ? handlers.onFinal : () => {};
  const onError = typeof handlers.onError === 'function' ? handlers.onError : () => {};
  const onSession = typeof handlers.onSession === 'function' ? handlers.onSession : () => {};

  const path = '/api/analyze';
  const { signal, clear } = withTimeout(ANALYZE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, stage, payload }),
      signal,
    });
  } catch (err) {
    clear();
    const message =
      err && err.name === 'AbortError'
        ? '分析超时（服务端最长 120 秒），请重试'
        : '连不上本地服务（8848）。确认 node app/server/index.mjs 正在运行';
    emitApiError(message, 0, path);
    throw new ApiError(message, { status: 0, code: 'network' });
  }

  if (!res.ok) {
    clear();
    const { message, code } = await readErrorBody(res);
    const text = message || `分析请求失败（HTTP ${res.status}）`;
    emitApiError(text, res.status, path);
    throw new ApiError(text, { status: res.status, code: code || 'http_error' });
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    clear();
    const message = '当前浏览器不支持流式读取，换 Edge / Chrome 再试';
    emitApiError(message, 0, path);
    throw new ApiError(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  let finalPayload = null;
  let streamError = null;
  let dispatching = false;

  const parseBlock = makeBlockParser((msg) => {
    if (finished) return;
    if (msg.type === 'stage') {
      onStage(String(msg.label || ''));
      return;
    }
    if (msg.type === 'reasoning') {
      onReasoning(String(msg.delta || ''));
      return;
    }
    if (msg.type === 'final') {
      finished = true;
      finalPayload = msg.payload == null ? null : msg.payload;
      if (msg.session) onSession(msg.session);
      onFinal(finalPayload);
      return;
    }
    if (msg.type === 'error') {
      const message = String(msg.message || '分析失败');
      streamError = new ApiError(message, { status: Number(msg.status) || 0, code: 'sse_error' });
      onError(message);
      emitApiError(message, Number(msg.status) || 0, path);
    }
    // heartbeat / 未知类型：忽略
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        dispatching = true;
        try {
          parseBlock(block);
        } finally {
          dispatching = false;
        }
        if (finished || streamError) break;
        cut = buffer.indexOf('\n\n');
      }
      if (finished || streamError) {
        try {
          await reader.cancel();
        } catch {
          /* 正常 */
        }
        break;
      }
    }
    if (!finished && !streamError) {
      buffer += decoder.decode();
      if (buffer.trim()) parseBlock(buffer);
    }
  } catch (err) {
    clear();
    if (dispatching) throw err; // 渲染/回调里的 JS 错误原样抛出，交给错误横幅
    if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)))) {
      const message = '分析超时（服务端最长 120 秒），请重试';
      emitApiError(message, 0, path);
      throw new ApiError(message);
    }
    const message = '分析连接中断，请重试';
    emitApiError(message, 0, path);
    throw new ApiError(message);
  } finally {
    clear();
    try {
      reader.releaseLock && reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (streamError) throw streamError;
  if (!finished) {
    const message = '分析流提前结束，没有拿到结果，请重试';
    emitApiError(message, 502, path);
    throw new ApiError(message, { status: 502, code: 'no_final' });
  }
  return finalPayload;
}

/* ------------------------------------------------------------------ 证据目录（V2） */

const evidenceCache = { loaded: false, items: [], byId: new Map() };
let evidencePromise = null;

/**
 * CONTRACT-V2 §1 证据目录。进程内只拉一次；失败返回 {items:[]}，绝不抛错，
 * 也不写 #dev-error-banner（接口可能还没上线）。
 * @returns {Promise<{items:Array}>}
 */
export async function getEvidence() {
  if (evidenceCache.loaded) return { items: evidenceCache.items };
  if (evidencePromise) return evidencePromise;
  evidencePromise = (async () => {
    try {
      const data = await request('/api/evidence', { timeout: 8000, silent: true });
      const items = Array.isArray(data) ? data : Array.isArray(data && data.items) ? data.items : [];
      evidenceCache.items = items;
      evidenceCache.loaded = true;
      evidenceCache.byId = new Map();
      items.forEach((item) => {
        if (item && item.id) evidenceCache.byId.set(String(item.id), item);
      });
      return { items };
    } catch {
      evidencePromise = null; // 下次还能重试
      return { items: [] };
    }
  })();
  return evidencePromise;
}

/** 同步查一条证据；未加载或不存在返回 null（卡片据此不显示徽章） */
export function evidenceById(id) {
  if (id == null || id === '') return null;
  return evidenceCache.byId.get(String(id)) || null;
}

/* ------------------------------------------------------------------ demo */

/**
 * ?demo=1 用的内置示例图。返回 Blob；都不存在时返回 null（由 flow 合成兜底）。
 * @returns {Promise<Blob|null>}
 */
export async function loadDemoImage() {
  const candidates = ['/demo/corner.jpg', '/demo/scene.jpg'];
  for (const path of candidates) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob && blob.size > 1024) return blob;
    } catch {
      /* try next */
    }
  }
  return null;
}
