// 猫角落 Corner · 零依赖服务端
// 静态资源 + 会话落盘 + DeepSeek 多模态分析（SSE 流式）。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { CONFIG, PUBLIC_DIR, ROOT_DIR } from './config.mjs';
import * as store from './store.mjs';
import { chatStream, extractJson, isConfigured } from './deepseek.mjs';
import { allEvidence } from './evidence.mjs';

// prompts/rules 由 AI 逻辑层并行提供；缺失时服务仍可启动（/api/analyze 返回 503）
let PROMPTS = null;
let RULES = null;
let aiReadyError = '';
try {
  PROMPTS = await import('./prompts.mjs');
} catch (e) {
  aiReadyError += `prompts.mjs 未就绪：${e.message} `;
}
try {
  RULES = await import('./rules.mjs');
} catch (e) {
  aiReadyError += `rules.mjs 未就绪：${e.message}`;
}

const STAGES = ['quality', 'l0', 'measure', 'plan', 'ask'];
const STAGE_LABEL = {
  quality: '正在检查这张照片…',
  l0: '正在读这个角落…',
  measure: '正在确定下一步量哪里…',
  plan: '正在按你的尺寸排方案…',
  ask: '正在看你点的位置…',
};

/* ------------------------------------------------------------------ 工具 */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, message, code = 'error') {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req, limit = CONFIG.maxUploadBytes) {
  return new Promise((resolve, reject) => {
    // 先看 Content-Length：明显超限就别读那几十 MB，直接 413
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limit) {
      req.resume(); // 丢掉剩余字节，避免客户端写一半被 reset
      reject(Object.assign(new Error('请求体过大'), { status: 413 }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  return {
    send(obj) {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        closed = true;
      }
    },
    end() {
      if (closed) return;
      try {
        res.end();
      } catch {
        /* ignore */
      }
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

const publicSession = (s) => s; // absPath 只加在 hydrate 副本上，落盘前已剥离

function shortTitle(session) {
  const room = String(session.l0?.scene?.roomGuess || '').trim();
  const dirs = session.l0?.directions || [];
  const chosen = dirs.find((d) => d?.id === session.chosenDirectionId) || dirs[0];
  // 优先级：选中方向标题 → 首个区域名 → 场景摘要第一个分句
  let core = String(chosen?.title || '').trim();
  if (!core) core = String(session.l0?.regions?.[0]?.label || '').trim();
  if (!core) core = String(session.l0?.scene?.summary || '').split(/[，,。；;、]/)[0].trim();
  core = core.replace(/[。．.，,；;]+$/, '').slice(0, 16);
  if (!core) return session.title;
  return room && !core.includes(room) ? `${room} · ${core}` : core;
}

/** 记一条测量（支持区间：区间一律按保守端存 valueMm） */
function storeMeasurement(session, key, ans) {
  const skipped = Boolean(ans?.skipped) || (ans?.valueCm == null && !Array.isArray(ans?.rangeCm)) || ans?.valueCm === '';
  if (skipped) {
    session.measurements[key] = {
      valueMm: null,
      valueCm: null,
      source: 'user',
      skipped: true,
      at: new Date().toISOString(),
    };
    return session.measurements[key];
  }
  let range = Array.isArray(ans?.rangeCm)
    ? ans.rangeCm.map((v) => store.toMm(v)).filter((v) => v != null)
    : [];
  if (range.length === 2) range = [Math.min(...range), Math.max(...range)];
  else range = [];
  // 保守端：区间取下限（对「>= 最小宽度」类约束最保守）
  const baseCm = range.length === 2 ? range[0] / 10 : ans.valueCm;
  const valueMm = store.toMm(baseCm);
  session.measurements[key] = {
    valueMm,
    valueCm: valueMm == null ? null : Number((valueMm / 10).toFixed(1)),
    ...(range.length === 2
      ? { rangeMm: range, rangeCm: [Number((range[0] / 10).toFixed(1)), Number((range[1] / 10).toFixed(1))], estimate: true }
      : {}),
    source: 'user',
    skipped: valueMm == null,
    at: new Date().toISOString(),
  };
  return session.measurements[key];
}

/** 把请求 payload 合进会话（在调用模型之前） */
function applyPayload(session, stage, payload = {}) {
  if (payload?.profile) {
    session.profile = { ...session.profile, ...payload.profile };
  }
  if (payload?.directionId) {
    session.chosenDirectionId = String(payload.directionId).slice(0, 24);
  }
  if (stage === 'measure') {
    const answers = payload?.answers || {};
    const last = session.asks[session.asks.length - 1];
    for (const [key, ans] of Object.entries(answers)) {
      const stored = storeMeasurement(session, key, ans);
      if (last) last.answers = { ...(last.answers || {}), [key]: stored };
    }
  }
  if (stage === 'plan' && payload?.measurements) {
    for (const [key, val] of Object.entries(payload.measurements)) {
      if (session.measurements[key]?.valueMm) continue;
      storeMeasurement(session, key, val);
    }
  }
  if (stage === 'ask') {
    session.picks.push({
      nx: Number(payload?.nx ?? 0.5),
      ny: Number(payload?.ny ?? 0.5),
      note: String(payload?.note || '').slice(0, 300),
      at: new Date().toISOString(),
    });
    session.picks = session.picks.slice(-8);
  }
  if (payload?.metrics) session.metrics = payload.metrics;
  if (payload?.analysisNote) session.analysisNote = String(payload.analysisNote).slice(0, 500);
}

/** 把模型结果写回会话状态机 */
function commit(session, stage, out) {
  if (stage === 'quality') {
    session.quality = out;
    session.stage = 'quality';
  } else if (stage === 'l0') {
    session.l0 = out;
    session.stage = 'l0';
    session.title = shortTitle(session);
    session.titleAuto = true;
  } else if (stage === 'measure') {
    const questions = Array.isArray(out?.questions) ? out.questions : [];
    session.asks.push({
      round: out?.round ?? session.asks.length + 1,
      questions,
      answers: {},
      remainingKeys: out?.remainingKeys || [],
      at: new Date().toISOString(),
    });
    session.stage = 'measuring';
    session.measureDone = questions.length === 0;
    if (session.titleAuto) session.title = shortTitle(session);
  } else if (stage === 'plan') {
    session.plan = out;
    session.stage = 'delivered';
    session.planDeliveredAt = new Date().toISOString();
    session.deliveredAt = session.planDeliveredAt;
    session.revisions = (session.revisions || 0) + 1;
  } else if (stage === 'ask') {
    const last = session.picks[session.picks.length - 1];
    if (last) last.reply = out?.reply || out?.headline || '';
    session.lastAsk = out;
  }
}

/* --------------------------------------------------- 家庭分享（V3，已脱敏） */

/** 只在局域网内可访问（承诺「仅同一 Wi-Fi 可打开」的技术兜底） */
function isLanRequest(req) {
  if (!CONFIG.shareLanOnly) return true;
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

function blockNonLan(res) {
  return fail(res, 403, '这个分享链接只能在同一 Wi-Fi 下打开', 'lan_only');
}

const VERDICT_HUMAN = {
  conditional: '有条件可放',
  not_supported: '现在不建议放',
  insufficient: '还差几个数字',
  ok: '可以放',
};

/** 可投票对象：未阻断的方案 + L0 里的 reuse 方向（最多 5 个） */
function shareTargets(plan, l0, votes) {
  const targets = [];
  for (const it of Array.isArray(plan?.items) ? plan.items : []) {
    if (!it || it.fit === 'blocked') continue;
    targets.push({ id: String(it.id || `i${targets.length + 1}`), type: 'item', label: it.title || '方案' });
    if (targets.length >= 4) break;
  }
  const reuse = (Array.isArray(l0?.directions) ? l0.directions : []).find((d) => d && d.kit === 'reuse');
  if (reuse) targets.push({ id: String(reuse.id || 'reuse'), type: 'direction', label: reuse.title || '复用现有物品' });
  const capped = targets.slice(0, 5).map((t) => ({ ...t, support: 0, unsure: 0, oppose: 0 }));
  for (const v of Array.isArray(votes) ? votes : []) {
    const t = capped.find((x) => x.id === v.targetId);
    if (!t) continue;
    if (v.vote === 'yes') t.support++;
    else if (v.vote === 'no') t.oppose++;
    else t.unsure++;
  }
  return capped;
}

/** 汇总各 target 的票数 */
function voteCounts(targets) {
  const counts = { yes: 0, unsure: 0, no: 0 };
  for (const t of Array.isArray(targets) ? targets : []) {
    counts.yes += t.support || 0;
    counts.unsure += t.unsure || 0;
    counts.no += t.oppose || 0;
  }
  return counts;
}

/** V4：家人回应 → 对外视图（名字按设备匿名化、附照片地址；viewer 传入时标出"我发的"） */
function buildRespondViews(share, viewerDeviceId = '') {
  const list = store.shareResponds(share);
  const nameByDevice = new Map();
  let anon = 0;
  for (const r of list) {
    const key = String(r.deviceId || r.id);
    if (!nameByDevice.has(key)) nameByDevice.set(key, r.name || `家人 ${++anon}`);
    else if (r.name) nameByDevice.set(key, r.name);
  }
  return list.map((r) => ({
    id: r.id,
    action: r.action,
    label: store.RESPOND_ACTIONS[r.action] || '回应',
    note: r.note || '',
    name: r.name || nameByDevice.get(String(r.deviceId || r.id)),
    at: r.at,
    photoUrl: r.photo?.imageId ? `/api/share/${share.token}/photo?kind=respond&id=${r.id}` : null,
    // 只回传 true/false，绝不把 deviceId 发给前端
    mine: Boolean(viewerDeviceId) && String(r.deviceId || '') === String(viewerDeviceId),
  }));
}

/** 分享页数据：只给结论、位置判断、三态条件、方案名；不给输入记录/picks/metrics/画像 */
function buildShareView(share, session, viewerDeviceId = '') {
  const plan = session.plan || {};
  const l0 = session.l0 || {};
  const votes = store.shareVotes(share);
  const catFit = plan.catFit
    ? {
        verdict: plan.catFit.verdict || 'unknown',
        items: (plan.catFit.items || []).map((i) => ({
          key: i.key,
          label: i.label,
          status: i.status,
          why: i.why,
        })),
      }
    : null;
  return {
    token: share.token,
    title: session.title || '一个角落',
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    ownerLabel: '家的角落',
    recognition: l0.recognition || '',
    boundary: l0.boundary || '',
    decision: plan.verdict || 'insufficient',
    decisionLabel: VERDICT_HUMAN[plan.verdict] || '还判断不了',
    headline: plan.headline || '',
    photoUrl: share.hasPhoto && session.image ? `/api/share/${share.token}/photo` : null,
    afterPhotoUrl: session.afterImage ? `/api/share/${share.token}/photo?kind=after` : null,
    annotations: (plan.annotations || []).map((a) => ({ id: String(a.id || ''), label: a.label || '', bbox: a.bbox || null, note: a.note || '' })),
    catFit,
    constraints: (plan.constraints || []).map((c) => ({
      label: c.label,
      op: c.op,
      valueCm: c.valueCm,
      actualCm: c.actualCm,
      status: c.status,
      estimate: Boolean(c.estimate),
    })),
    items: (plan.items || []).map((i) => ({ id: i.id, type: i.type, title: i.title, price: i.price, fit: i.fit, why: i.why })),
    targets: shareTargets(plan, l0, votes),
    voteCount: votes.length,
    // V4：家人回应（行动）与访问次数（只计数、不记身份）
    responds: buildRespondViews(share, viewerDeviceId),
    respondCount: store.shareResponds(share).length,
    viewCount: Number(share.viewCount) || 0,
    disclaimer: plan.disclaimer || '以交付时的尺寸条件为准，落地前请现场确认。',
  };
}

async function handleCreateShare(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  if (!session.plan) return fail(res, 400, '还没生成方案，暂时不能分享', 'no_plan');
  const body = await readJson(req).catch(() => ({}));
  // 复用未过期的旧分享
  if (session.share?.token) {
    const old = await store.getShare(session.share.token);
    if (old && !store.isShareExpired(old)) {
      return sendJson(res, 200, { share: session.share });
    }
  }
  // 客户端生成的分享缩略图（长边 900），拿不到原图
  let photo = null;
  if (body?.photoDataUrl) {
    try {
      photo = await store.saveImageDataUrl(body.photoDataUrl);
    } catch {
      photo = null;
    }
  }
  const share = await store.createShare(session, {
    hasPhoto: body?.hasPhoto !== false && Boolean(photo || session.image),
    photo,
  });
  session.share = { token: share.token, url: `/s/${share.token}`, expiresAt: share.expiresAt, hasPhoto: share.hasPhoto };
  await store.saveSession(session);
  sendJson(res, 201, { share: session.share });
}

async function handleGetShare(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  if (!session.share?.token) return sendJson(res, 200, { share: null });
  const share = await store.getShare(session.share.token);
  if (!share || store.isShareExpired(share)) return sendJson(res, 200, { share: null });
  sendJson(res, 200, { share: session.share });
}

async function handleDeleteShare(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  if (session.share?.token) {
    await store.deleteShare(session.share.token);
    session.share = null;
    await store.saveSession(session);
  }
  sendJson(res, 200, { ok: true });
}

async function handlePublicShare(req, res, token) {
  if (!isLanRequest(req)) return blockNonLan(res);
  let share = await store.getShare(token);
  if (!share) return fail(res, 404, '分享不存在或已撤销', 'not_found');
  if (store.isShareExpired(share)) return fail(res, 410, '分享链接已过期', 'expired');
  const session = await store.getSession(share.sessionId);
  if (!session) return fail(res, 404, '分享不存在或已撤销', 'not_found');
  // 记一次访问（只计数、不记身份）；带上 deviceId 时把自己的回目标成 mine，刷新后可恢复状态
  share = (await store.bumpShareView(token)) || share;
  const viewer = String(new URL(req.url || '/', 'http://localhost').searchParams.get('deviceId') || '').slice(0, 40);
  sendJson(res, 200, buildShareView(share, session, viewer));
}

/** V4：家人「行动回应」——我周末来量 / 我拍了现场照 / 我不同意 / 就按这个来 */
async function handleShareRespond(req, res, token) {
  if (!isLanRequest(req)) return blockNonLan(res);
  const share = await store.getShare(token);
  if (!share) return fail(res, 404, '分享不存在或已撤销', 'not_found');
  if (store.isShareExpired(share)) return fail(res, 410, '分享链接已过期', 'expired');
  const session = await store.getSession(share.sessionId);
  if (!session) return fail(res, 404, '分享不存在', 'not_found');

  const body = await readJson(req);
  const action = String(body?.action || '');
  if (!store.RESPOND_ACTIONS[action]) return fail(res, 400, '这个回应不认识，刷新页面再试', 'bad_action');

  let photo = null;
  if (action === 'photo') {
    if (body?.consent !== true) return fail(res, 400, '需要先勾选「这张照片会发给设置这个角落的人」', 'need_consent');
    if (!body?.photoDataUrl) return fail(res, 400, '没收到照片', 'bad_request');
    try {
      photo = await store.saveImageDataUrl(body.photoDataUrl);
    } catch {
      return fail(res, 400, '照片格式不支持，换一张试试', 'bad_image');
    }
  }

  const updated = await store.addRespond(token, {
    action,
    note: body?.note,
    name: body?.name,
    deviceId: body?.deviceId,
    photo,
  });
  if (!updated) return fail(res, 400, '回应没记上，再试一次', 'bad_action');
  sendJson(res, 200, {
    ok: true,
    respondCount: store.shareResponds(updated).length,
    responds: buildRespondViews(updated, body?.deviceId || ''),
  });
}

async function handleSharePhoto(req, res, token, kind, respondId) {
  if (!isLanRequest(req)) return blockNonLan(res);
  const share = await store.getShare(token);
  if (!share) return fail(res, 404, '分享不存在或已撤销', 'not_found');
  if (store.isShareExpired(share)) return fail(res, 410, '分享链接已过期', 'expired');
  const session = await store.getSession(share.sessionId);
  if (!session) return fail(res, 404, '分享不存在', 'not_found');
  // 分享页只给缩略图：before 用客户端生成的那张；after 也必须是压缩版（≤1280）。
  // 绝不回落到会话主图，避免「拿不到原图」的承诺失效。
  let img = null;
  if (kind === 'respond') {
    // V4：家人回传的现场照（只能是这次分享里、带 id 的那张）
    const r = store.shareResponds(share).find((x) => x.id === String(respondId || ''));
    if (r?.photo?.imageId) img = r.photo;
  } else {
    img = kind === 'after' ? session.afterImage : share.photo;
  }
  if (!img?.imageId) {
    return fail(res, 404, kind === 'after' ? '这次分享没有改造后照片' : '这次分享没有包含照片', 'not_found');
  }
  for (const ext of ['jpg', 'png', 'webp']) {
    const file = store.imagePath(img.imageId, ext);
    if (!file) break;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      res.writeHead(200, {
        'Content-Type': ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=600',
        'X-Robots-Tag': 'noindex',
        'Content-Disposition': 'inline; filename="corner-share.jpg"',
      });
      fs.createReadStream(file).pipe(res);
      return;
    } catch {
      /* next */
    }
  }
  return fail(res, 404, '没有照片', 'not_found');
}

async function handleShareVote(req, res, token) {
  if (!isLanRequest(req)) return blockNonLan(res);
  const share = await store.getShare(token);
  if (!share) return fail(res, 404, '分享不存在或已撤销', 'not_found');
  if (store.isShareExpired(share)) return fail(res, 410, '分享链接已过期', 'expired');
  const body = await readJson(req).catch(() => ({}));
  if (!body?.targetId) return fail(res, 400, '缺少要投票的方案', 'bad_request');
  // 校验 targetId 必须属于这次分享的方案列表，避免脏票污染统计
  const session = await store.getSession(share.sessionId);
  if (!session) return fail(res, 404, '分享不存在', 'not_found');
  const allowed = shareTargets(session.plan || {}, session.l0 || {}, []);
  if (!allowed.some((t) => t.id === String(body.targetId))) {
    return fail(res, 400, '这个方案不在本次分享里，刷新页面再试', 'bad_target');
  }
  const updated = await store.addVote(token, body);
  if (!updated) return fail(res, 404, '分享不存在', 'not_found');
  const view = buildShareView(updated, session);
  sendJson(res, 200, { ok: true, voteCount: store.shareVotes(updated).length, targets: view.targets, counts: voteCounts(view.targets) });
}

async function handleSessionVotes(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  const empty = { votes: [], counts: {}, voteCount: 0, responds: [], respondCount: 0, viewCount: 0 };
  if (!session.share?.token) return sendJson(res, 200, empty);
  const share = await store.getShare(session.share.token);
  if (!share || store.isShareExpired(share)) return sendJson(res, 200, Object.assign({}, empty, { expired: true }));
  const votes = store.shareVotes(share).map((v, idx) => ({
    targetId: v.targetId,
    targetType: v.targetType,
    vote: v.vote,
    note: v.note,
    // 匿名化：没填名字的按出现顺序编号「家人 N」，不落任何访客标识
    name: v.name || `家人 ${idx + 1}`,
    at: v.at,
  }));
  const counts = { yes: 0, unsure: 0, no: 0 };
  for (const v of votes) counts[v.vote] = (counts[v.vote] || 0) + 1;
  const responds = buildRespondViews(share);
  sendJson(res, 200, {
    votes,
    counts,
    voteCount: votes.length,
    responds,
    respondCount: responds.length,
    viewCount: Number(share.viewCount) || 0,
    expiresAt: share.expiresAt,
  });
}

/** V4：把家人回传的照片设为「改造后照片」（用于前后对比） */
async function handleAfterFromRespond(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  const body = await readJson(req);
  if (!session.share?.token) return fail(res, 400, '这个角落还没有分享过', 'no_share');
  const share = await store.getShare(session.share.token);
  if (!share) return fail(res, 404, '分享已撤销', 'not_found');
  const r = store.shareResponds(share).find((x) => x.id === String(body?.respondId || ''));
  if (!r?.photo?.imageId) return fail(res, 400, '这条回应里没有照片', 'no_photo');
  // 幂等：已经用过这张就不再复制一份
  if (session.afterImage?.fromRespondId === r.id) {
    return sendJson(res, 200, { ok: true, reused: true, session });
  }
  const copied = await store.copyImage(r.photo.imageId, r.photo.ext || 'jpg');
  if (!copied) return fail(res, 400, '照片读不出来，让家人再发一张', 'photo_missing');
  if (session.afterImage?.imageId && session.afterImage.imageId !== session.image?.imageId) {
    const old = store.imagePath(session.afterImage.imageId, session.afterImage.ext);
    if (old) await fsp.unlink(old).catch(() => {});
  }
  session.afterImage = {
    imageId: copied.imageId,
    ext: copied.ext,
    bytes: copied.bytes,
    at: new Date().toISOString(),
    fromRespondId: r.id,
    fromFamilyName: r.name || '',
  };
  await store.saveSession(session);
  sendJson(res, 200, { ok: true, session });
}

/** 改造后照片 */
async function handleUploadAfter(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  if (!session.plan) return fail(res, 400, '还没生成方案', 'no_plan');
  const body = await readJson(req);
  if (!body?.dataUrl) return fail(res, 400, '缺少图片数据', 'bad_request');
  const saved = await store.saveImageDataUrl(body.dataUrl);
  if (session.afterImage?.imageId && session.afterImage.imageId !== session.image?.imageId) {
    const old = store.imagePath(session.afterImage.imageId, session.afterImage.ext);
    if (old) await fsp.unlink(old).catch(() => {});
  }
  session.afterImage = {
    imageId: saved.imageId,
    ext: saved.ext,
    url: `/api/image/${saved.imageId}`,
    width: Number(body.width) || 0,
    height: Number(body.height) || 0,
    at: new Date().toISOString(),
  };
  await store.saveSession(session);
  sendJson(res, 200, { session });
}

async function handleDeleteAfter(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  if (session.afterImage?.imageId) {
    const old = store.imagePath(session.afterImage.imageId, session.afterImage.ext);
    if (old) await fsp.unlink(old).catch(() => {});
    session.afterImage = null;
    await store.saveSession(session);
  }
  sendJson(res, 200, { ok: true });
}

async function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    model: CONFIG.model,
    hasKey: isConfigured(),
    aiReady: Boolean(PROMPTS && RULES),
    aiReadyError: aiReadyError.trim() || null,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

async function handleListSessions(req, res) {
  sendJson(res, 200, { sessions: await store.listSessions() });
}

/** 证据目录：前端「依据」徽章的唯一数据来源 */
async function handleEvidence(req, res) {
  const catalog = allEvidence();
  sendJson(res, 200, {
    version: catalog.version,
    count: catalog.count,
    items: catalog.items,
    badgeLegend: {
      study: '研究支持（强/中/弱由 strength 决定）',
      consensus: '专家共识',
      experience: '经验值',
    },
    note: '徽章只分三类家族：研究支持 / 专家共识 / 经验值；强度用 strengthLabel 表达，不显示精确置信度。',
  });
}

async function handleCreateSession(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const session = store.emptySession();
  if (body?.profile) session.profile = { ...session.profile, ...body.profile };
  await store.saveSession(session);
  sendJson(res, 201, session);
}

async function handleGetSession(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  sendJson(res, 200, session);
}

async function handleDeleteSession(req, res, id) {
  const ok = await store.deleteSession(id);
  if (!ok) return fail(res, 404, '会话不存在', 'not_found');
  sendJson(res, 200, { ok: true });
}

async function handleUploadImage(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  const body = await readJson(req);
  if (!body?.dataUrl) return fail(res, 400, '缺少图片数据', 'bad_request');
  const saved = await store.saveImageDataUrl(body.dataUrl);
  // 覆盖旧图：删掉旧文件
  if (session.image?.imageId) {
    const old = store.imagePath(session.image.imageId, session.image.ext);
    if (old) await fsp.unlink(old).catch(() => {});
  }
  const width = Number(body.width) || 0;
  const height = Number(body.height) || 0;
  session.image = {
    imageId: saved.imageId,
    ext: saved.ext,
    url: `/api/image/${saved.imageId}`,
    width,
    height,
    bytes: saved.bytes || body.bytes || 0,
    at: new Date().toISOString(),
  };
  session.metrics = body.metrics || null;
  session.stage = 'uploaded';
  session.quality = null;
  session.l0 = null;
  session.plan = null;
  session.asks = [];
  session.measurements = {};
  session.picks = [];
  session.chosenDirectionId = null;
  session.measureDone = false;
  session.lastAsk = null;
  if (session.titleAuto) session.title = '新的角落';
  await store.saveSession(session);
  sendJson(res, 200, { session });
}

async function handleAnswer(req, res, id) {
  const session = await store.getSession(id);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  const body = await readJson(req);
  const key = String(body?.key || '');
  if (!key) return fail(res, 400, '缺少 key', 'bad_request');
  const stored = storeMeasurement(session, key, body);
  if (stored.valueMm == null && !stored.skipped) return fail(res, 400, '数值不合法', 'bad_request');
  await store.saveSession(session);
  sendJson(res, 200, { session });
}

async function handleImage(req, res, imageId) {
  for (const ext of ['jpg', 'png', 'webp']) {
    const file = store.imagePath(imageId, ext);
    if (!file) break;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=86400',
      });
      fs.createReadStream(file).pipe(res);
      return;
    } catch {
      /* try next ext */
    }
  }
  return fail(res, 404, '图片不存在', 'not_found');
}

async function handleAnalyze(req, res) {
  const body = await readJson(req);
  const { sessionId, stage } = body || {};
  if (!STAGES.includes(stage)) return fail(res, 400, `未知阶段：${stage}`, 'bad_request');
  const session = await store.getSession(sessionId);
  if (!session) return fail(res, 404, '会话不存在', 'not_found');
  if (!session.image) return fail(res, 400, '请先上传一张角落照片', 'no_image');
  if (!PROMPTS || !RULES) return fail(res, 503, aiReadyError.trim() || 'AI 模块未就绪', 'ai_not_ready');

  const sse = openSSE(res);
  const heartbeat = setInterval(() => sse.send({ type: 'heartbeat' }), 8000);
  const started = Date.now();
  try {
    applyPayload(session, stage, body.payload || {});
    await store.saveSession(session);

    sse.send({ type: 'stage', label: STAGE_LABEL[stage] || '正在思考…' });

    const reqSpec = PROMPTS.buildRequest(stage, store.hydrate(session));
    let result = await chatStream(reqSpec, {
      onReasoning: (delta) => sse.send({ type: 'reasoning', delta }),
    });
    let raw = extractJson(result.content);

    // 输出被截断时：直接加预算重来，比让模型"修 JSON"更可靠
    if (!raw && result.finishReason === 'length') {
      const bumped = Math.min(8000, Math.round((reqSpec.maxTokens || 4000) * 1.9));
      console.warn(`[analyze:${stage}] 输出被截断，maxTokens ${reqSpec.maxTokens} → ${bumped} 重试`);
      result = await chatStream(
        { ...reqSpec, maxTokens: bumped, temperature: 0.2 },
        { onReasoning: (delta) => sse.send({ type: 'reasoning', delta }) }
      );
      raw = extractJson(result.content);
      if (raw) result.retriedForLength = true;
    }

    // 一次自修复：模型偶尔会在 JSON 前后加解释
    if (!raw) {
      const repairMessages = [
        ...reqSpec.messages,
        { role: 'assistant', content: String(result.content || '').slice(0, 8000) },
        { role: 'user', content: '上面的输出不是合法 JSON。只输出修正后的 JSON 对象，不要解释，不要 markdown 围栏。' },
      ];
      const repair = await chatStream(
        { ...reqSpec, messages: repairMessages, temperature: 0.2, thinking: { type: 'disabled' } },
        {}
      );
      raw = extractJson(repair.content);
      result = { ...repair, ms: Date.now() - started, repaired: true };
    }
    if (!raw) throw Object.assign(new Error('模型没有返回可解析的 JSON，请重试'), { status: 502 });

    let out = PROMPTS.normalize(stage, raw, session);
    const ruled = RULES.apply(stage, out, session);
    if (ruled && typeof ruled === 'object') out = ruled.payload || ruled;
    commit(session, stage, out);
    await store.saveSession(session);

    sse.send({
      type: 'final',
      payload: out,
      session: publicSession(session),
      meta: {
        ms: Date.now() - started,
        usage: result.usage || null,
        model: result.model,
        finishReason: result.finishReason || null,
        repaired: Boolean(result.repaired),
        retriedForLength: Boolean(result.retriedForLength),
      },
    });
  } catch (err) {
    console.error(`[analyze:${stage}]`, err?.message);
    sse.send({ type: 'error', message: err?.message || '分析失败', status: err?.status || 500 });
  } finally {
    clearInterval(heartbeat);
    sse.end();
  }
}

/* ------------------------------------------------------------- 静态文件 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.webmanifest', '.txt']);

// gzip 缓存：key = 文件路径 + mtime + size（改文件自动失效）
const gzipCache = new Map();

function gzipFor(file, stat) {
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const raw = fs.readFileSync(file);
  const gz = zlib.gzipSync(raw, { level: 6 });
  const entry = { raw, gz };
  // 简单上限，避免内存无限增长
  if (gzipCache.size > 120) gzipCache.clear();
  gzipCache.set(key, entry);
  return entry;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!target.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden', 'forbidden');

  let file = target;
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // 无扩展名 → 交给前端（SPA 兜底）
    if (!path.extname(rel)) file = path.join(PUBLIC_DIR, 'index.html');
  }

  try {
    const stat = await fsp.stat(file);
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const noStore = ['.html', '.js', '.css', '.mjs', '.webmanifest'].includes(ext);
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));

    if (acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024) {
      const { raw, gz } = gzipFor(file, stat);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': gz.length,
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
        'Cache-Control': noStore ? 'no-store' : 'public, max-age=3600',
      });
      res.end(gz);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      Vary: 'Accept-Encoding',
      'Cache-Control': noStore ? 'no-store' : 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    fail(res, 404, '文件不存在', 'not_found');
  }
}

/* ------------------------------------------------------------------ 启动 */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  res.on('finish', () => {
    const ms = Date.now() - started;
    if (p.startsWith('/api/')) console.log(`${method} ${p} ${res.statusCode} ${ms}ms`);
  });

  try {
    if (method === 'GET' && p === '/api/health') return await handleHealth(req, res);
    if (method === 'GET' && p === '/api/evidence') return await handleEvidence(req, res);
    if (p === '/api/sessions' && method === 'GET') return await handleListSessions(req, res);
    if (p === '/api/sessions' && method === 'POST') return await handleCreateSession(req, res);
    if (method === 'POST' && p === '/api/analyze') return await handleAnalyze(req, res);

    let m = /^\/api\/sessions\/(s_[a-f0-9]{12})$/.exec(p);
    if (m && method === 'GET') return await handleGetSession(req, res, m[1]);
    if (m && method === 'DELETE') return await handleDeleteSession(req, res, m[1]);

    m = /^\/api\/sessions\/(s_[a-f0-9]{12})\/image$/.exec(p);
    if (m && method === 'POST') return await handleUploadImage(req, res, m[1]);

    m = /^\/api\/sessions\/(s_[a-f0-9]{12})\/answer$/.exec(p);
    if (m && method === 'POST') return await handleAnswer(req, res, m[1]);

    // ---- V3：家庭分享 / 投票 / 改造后照片 ----
    m = /^\/api\/sessions\/(s_[a-f0-9]{12})\/share$/.exec(p);
    if (m && method === 'POST') return await handleCreateShare(req, res, m[1]);
    if (m && method === 'GET') return await handleGetShare(req, res, m[1]);
    if (m && method === 'DELETE') return await handleDeleteShare(req, res, m[1]);

    m = /^\/api\/sessions\/(s_[a-f0-9]{12})\/votes$/.exec(p);
    if (m && method === 'GET') return await handleSessionVotes(req, res, m[1]);

    m = /^\/api\/sessions\/(s_[a-f0-9]{12})\/after$/.exec(p);
    if (m && method === 'POST') return await handleUploadAfter(req, res, m[1]);
    if (m && method === 'DELETE') return await handleDeleteAfter(req, res, m[1]);

    // V4：把家人回传的照片设为改造后照片
    m = /^\/api\/sessions\/(s_[a-f0-9]{12})\/after-from-respond$/.exec(p);
    if (m && method === 'POST') return await handleAfterFromRespond(req, res, m[1]);

    m = /^\/api\/share\/(sh_[a-f0-9]{16})$/.exec(p);
    if (m && method === 'GET') return await handlePublicShare(req, res, m[1]);

    m = /^\/api\/share\/(sh_[a-f0-9]{16})\/photo$/.exec(p);
    if (m && method === 'GET') {
      const kind = url.searchParams.get('kind');
      const kindNorm = kind === 'after' ? 'after' : kind === 'respond' ? 'respond' : 'before';
      return await handleSharePhoto(req, res, m[1], kindNorm, url.searchParams.get('id'));
    }

    m = /^\/api\/share\/(sh_[a-f0-9]{16})\/respond$/.exec(p);
    if (m && method === 'POST') return await handleShareRespond(req, res, m[1]);

    m = /^\/api\/share\/(sh_[a-f0-9]{16})\/vote$/.exec(p);
    if (m && method === 'POST') return await handleShareVote(req, res, m[1]);

    m = /^\/api\/image\/(i_[a-f0-9]{16})$/.exec(p);
    if (m && method === 'GET') return await handleImage(req, res, m[1]);

    if (p.startsWith('/api/')) return fail(res, 404, `未知接口 ${method} ${p}`, 'not_found');

    // 分享页：/s/<token> → 独立的只读页面（仅局域网）
    if (p === '/s' || p.startsWith('/s/')) {
      if (!isLanRequest(req)) {
        const html = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<title>需要同一 Wi-Fi</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#FAF6F0;color:#1C1917;font:15px/1.6 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:340px;padding:28px;text-align:center">
<div style="font-size:13px;letter-spacing:.08em;color:#8C857B">猫角落 corner.</div>
<h1 style="font-size:22px;margin:12px 0 8px">需要在同一个 Wi-Fi 下打开</h1>
<p style="color:#5A544C;margin:0">这个链接只在家里网络内有效，24 小时后自动失效。让家人重新发一次链接，或换成家里的 Wi-Fi 再试。</p>
</div></body>`;
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      return await serveStatic(req, res, '/share.html');
    }

    return await serveStatic(req, res, p);
  } catch (err) {
    const status = err?.status || 500;
    if (!res.headersSent) fail(res, status, err?.message || '服务器内部错误');
    else res.end();
  }
});

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      if (ni.internal) continue;
      out.push({ name, address: ni.address });
    }
  }
  return out;
}

server.listen(CONFIG.port, CONFIG.host, () => {
  const lanMode = CONFIG.host === '0.0.0.0' || CONFIG.host === '::';
  console.log('');
  console.log('  猫角落 corner.');
  console.log(`  本机     http://127.0.0.1:${CONFIG.port}`);
  if (lanMode) {
    for (const { name, address } of lanAddresses()) {
      console.log(`  局域网   http://${address}:${CONFIG.port}   （${name}）`);
    }
    console.log('');
    console.log('  同一 Wi-Fi 下的手机 / 平板打开上面「局域网」那行即可。');
    console.log('  ⚠ 这是开放访问：同一网络内任何人都能用这个服务并消耗你的 API 额度。');
    console.log('    只给可信网络使用；用完把 app/.env 里的 HOST 改回 127.0.0.1 即可关闭。');
  } else {
    console.log(`  （仅本机，HOST=${CONFIG.host}）`);
  }
  console.log(`  模型 ${CONFIG.model} · Key ${isConfigured() ? '已加载' : '缺失'} · AI 模块 ${PROMPTS && RULES ? '就绪' : '未就绪'}`);
  if (aiReadyError.trim()) console.log('  ⚠ ' + aiReadyError.trim());
  console.log('');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
