// 会话与图片落盘：每个会话一个 JSON 文件，图片存 uploads/。
// 零依赖，磁盘即数据库。所有读写都是原子的（tmp + rename）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_DIR, UPLOAD_DIR, DATA_DIR, CONFIG } from './config.mjs';

const SESSION_ID_RE = /^s_[a-f0-9]{12}$/;
const IMAGE_ID_RE = /^i_[a-f0-9]{16}$/;

export function newSessionId() {
  return 's_' + crypto.randomBytes(6).toString('hex');
}
export function newImageId() {
  return 'i_' + crypto.randomBytes(8).toString('hex');
}

export function emptySession(id = newSessionId()) {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    title: '新的角落',
    stage: 'empty',
    image: null,
    metrics: null,
    profile: {
      goal: '',
      budget: null,
      keep: [],
      cats: 1,
      catSize: 'medium', // small|medium|large
      catAge: 'adult', // kitten|adult|senior
      multiCat: false,
      floorType: 'unknown', // wood|tile|carpet|unknown
      climate: 'unknown', // cold|mild|hot|unknown
      primaryPain: '', // 猫不进去|太乱占道|有味道|都还行
    },
    quality: null,
    l0: null,
    asks: [],
    measurements: {},
    plan: null,
    planDeliveredAt: null,
    afterImage: null,
    share: null,
    picks: [],
    chosenDirectionId: null,
    revisions: 0,
  };
}

function sessionFile(id) {
  if (!SESSION_ID_RE.test(id)) return null;
  return path.join(SESSION_DIR, id + '.json');
}

export async function saveSession(session) {
  const file = sessionFile(session.id);
  if (!file) throw new Error('非法的会话 ID');
  session.updatedAt = new Date().toISOString();
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const clean = stripRuntime(session);
  await fsp.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return session;
}

export async function getSession(id) {
  const file = sessionFile(id);
  if (!file) return null;
  try {
    const text = await fsp.readFile(file, 'utf8');
    const s = JSON.parse(text);
    // 兼容老数据
    s.asks ||= [];
    s.picks ||= [];
    s.measurements ||= {};
    s.profile ||= { goal: '', budget: null, keep: [], cats: 1 };
    return s;
  } catch {
    return null;
  }
}

export async function deleteSession(id) {
  const file = sessionFile(id);
  if (!file) return false;
  const session = await getSession(id);
  try {
    await fsp.unlink(file);
  } catch {
    /* ignore */
  }
  // 隐私承诺「删除即从服务器移除」：主图、改造后照片、分享记录、分享缩略图、家人回传照片一起删
  const doomed = [];
  if (session?.image?.imageId) doomed.push(session.image);
  if (session?.afterImage?.imageId) doomed.push(session.afterImage);
  if (session?.share?.token) {
    const share = await getShare(session.share.token);
    if (share?.photo?.imageId) doomed.push(share.photo);
    for (const r of shareResponds(share)) {
      if (r?.photo?.imageId) doomed.push(r.photo);
    }
    await deleteShare(session.share.token).catch(() => {});
  }
  const seen = new Set();
  for (const img of doomed) {
    if (!img?.imageId || seen.has(img.imageId)) continue;
    seen.add(img.imageId);
    const p = imagePath(img.imageId, img.ext || 'jpg');
    if (p) await fsp.unlink(p).catch(() => {});
  }
  return true;
}

export async function listSessions() {
  let names = [];
  try {
    names = await fsp.readdir(SESSION_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const s = await getSession(id);
    if (!s) continue;
    out.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      stage: s.stage,
      thumb: s.image?.url || null,
      verdict: s.plan?.verdict || null,
      level: s.plan ? 'L1' : s.l0 ? 'L0' : null,
    });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out.slice(0, 60);
}

/** 把 dataURL 落成文件，返回 {imageId, ext, bytes} */
export async function saveImageDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('图片格式不支持，请上传 JPG / PNG / WebP'), { status: 400 });
  const kind = m[1] === 'jpg' ? 'jpeg' : m[1];
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (buf.length < 64) throw Object.assign(new Error('图片内容为空'), { status: 400 });
  if (buf.length > CONFIG.maxUploadBytes) throw Object.assign(new Error('图片过大（上限 12MB）'), { status: 413 });
  const imageId = newImageId();
  const ext = kind === 'jpeg' ? 'jpg' : kind;
  const file = path.join(UPLOAD_DIR, `${imageId}.${ext}`);
  await fsp.writeFile(file, buf);
  return { imageId, ext, bytes: buf.length };
}

export function imagePath(imageId, ext = 'jpg') {
  if (!IMAGE_ID_RE.test(String(imageId || ''))) return null;
  const safeExt = /^(jpg|jpeg|png|webp)$/.test(ext) ? ext : 'jpg';
  return path.join(UPLOAD_DIR, `${imageId}.${safeExt}`);
}

/** 供 prompts 使用的运行时副本：附带图片绝对路径 */
export function hydrate(session) {
  if (!session?.image?.imageId) return session;
  const abs = imagePath(session.image.imageId, session.image.ext);
  return { ...session, image: { ...session.image, absPath: abs } };
}

function stripRuntime(session) {
  const { ...rest } = session;
  if (rest.image) {
    const { absPath, ...img } = rest.image;
    rest.image = img;
  }
  return rest;
}

/** cm → mm 统一存储（整数毫米）；非法返回 null */
export function toMm(valueCm) {
  const n = Number(valueCm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10);
}

/* ============================================================== 家庭分享（V3）
 * 分享单元是「住在一起的人」，不是公开社区：
 *   · 链接 24h 过期、可随时撤销
 *   · 只存投票，不存任何访客个人数据
 *   · 分享页只给缩略图（客户端已压到长边 1280），拿不到原图
 */

const SHARE_DIR = path.join(DATA_DIR, 'shares');
fs.mkdirSync(SHARE_DIR, { recursive: true });

const SHARE_TOKEN_RE = /^sh_[a-f0-9]{16}$/;
const SHARE_TTL_MS = Math.max(1, CONFIG.shareTtlHours || 24) * 60 * 60 * 1000;

export function newShareToken() {
  return 'sh_' + crypto.randomBytes(8).toString('hex');
}

export function isValidShareToken(token) {
  return SHARE_TOKEN_RE.test(String(token || ''));
}

function shareFile(token) {
  if (!isValidShareToken(token)) return null;
  return path.join(SHARE_DIR, token + '.json');
}

export async function createShare(session, { hasPhoto = true, photo = null } = {}) {
  const now = Date.now();
  const share = {
    token: newShareToken(),
    sessionId: session.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SHARE_TTL_MS).toISOString(),
    hasPhoto: Boolean(hasPhoto),
    // 分享页专用缩略图（客户端生成，长边 900）：拿不到原图
    photo: photo && photo.imageId ? { imageId: photo.imageId, ext: photo.ext || 'jpg', bytes: photo.bytes || 0 } : null,
    votes: [],
    // V4：家人的「行动回应」（我周末来量 / 我拍了现场照 / 我不同意 / 就按这个来）
    responds: [],
    viewCount: 0,
  };
  const file = shareFile(share.token);
  await fsp.writeFile(file, JSON.stringify(share, null, 2), 'utf8');
  return share;
}

/* ---------------- V4：家人回应 ---------------- */

export const RESPOND_ACTIONS = Object.freeze({
  measure: '我周末来量',
  photo: '我拍了现场照',
  disagree: '这个位置我不同意',
  agree: '就按这个来',
});

export function newRespondId() {
  return 'rs_' + crypto.randomBytes(4).toString('hex');
}

/**
 * 记录一条家人回应。
 * - 同一 deviceId + action（非 photo）覆盖，避免重复点
 * - photo 最多保留 5 张
 */
export async function addRespond(token, { action, note = '', name = '', deviceId = '', photo = null }) {
  const share = await getShare(token);
  if (!share) return null;
  if (!RESPOND_ACTIONS[action]) return null;
  const list = Array.isArray(share.responds) ? share.responds : [];
  const entry = {
    id: newRespondId(),
    action,
    note: String(note || '').slice(0, 40),
    name: String(name || '').slice(0, 12),
    deviceId: String(deviceId || '').slice(0, 40),
    at: new Date().toISOString(),
    photo: photo && photo.imageId ? { imageId: photo.imageId, ext: photo.ext || 'jpg' } : null,
    consent: Boolean(photo),
  };
  let next = list;
  if (action === 'photo') {
    const photos = list.filter((r) => r && r.action === 'photo');
    next = list.filter((r) => !(r && r.action === 'photo' && r.id === (photos[0] && photos[0].id) && photos.length >= 5));
    next = next.concat(entry).slice(-50);
  } else {
    const keep = list.filter((r) => !(r && r.action === action && entry.deviceId && r.deviceId === entry.deviceId));
    next = keep.concat(entry).slice(-50);
  }
  share.responds = next;
  await fsp.writeFile(shareFile(token), JSON.stringify(share, null, 2), 'utf8');
  return share;
}

export function shareResponds(share) {
  return Array.isArray(share?.responds) ? share.responds : [];
}

/** 分享页被打开一次（用于「已访问 N 次」，不记录身份） */
export async function bumpShareView(token) {
  const share = await getShare(token);
  if (!share) return null;
  share.viewCount = (Number(share.viewCount) || 0) + 1;
  await fsp.writeFile(shareFile(token), JSON.stringify(share, null, 2), 'utf8');
  return share;
}

/** 复制一张已有图片（家人回传的照片 → 会话的改造后照片），返回新 {imageId, ext} */
export async function copyImage(imageId, ext = 'jpg') {
  if (!IMAGE_ID_RE.test(String(imageId || ''))) return null;
  const src = imagePath(imageId, ext);
  if (!src) return null;
  const buf = await fsp.readFile(src);
  const nextId = newImageId();
  const safeExt = /^(jpg|png|webp)$/.test(ext) ? ext : 'jpg';
  await fsp.writeFile(path.join(UPLOAD_DIR, `${nextId}.${safeExt}`), buf);
  return { imageId: nextId, ext: safeExt, bytes: buf.length };
}

export async function getShare(token) {
  const file = shareFile(token);
  if (!file) return null;
  try {
    const share = JSON.parse(await fsp.readFile(file, 'utf8'));
    return share;
  } catch {
    return null;
  }
}

export function isShareExpired(share) {
  return !share || Date.parse(share.expiresAt) < Date.now();
}

export async function deleteShare(token) {
  const file = shareFile(token);
  if (!file) return false;
  try {
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/** 记录/覆盖一条投票（同一个 voteId 对同一个 target 只保留最后一次） */
export async function addVote(token, { targetId, targetType, vote, note, name, voteId }) {
  const share = await getShare(token);
  if (!share) return null;
  const entry = {
    targetId: String(targetId || '').slice(0, 32),
    targetType: String(targetType || 'item').slice(0, 16),
    vote: ['yes', 'unsure', 'no'].includes(vote) ? vote : 'unsure',
    note: String(note || '').slice(0, 60),
    name: String(name || '').slice(0, 16),
    voteId: String(voteId || '').slice(0, 32),
    at: new Date().toISOString(),
  };
  const votes = (share.votes || []).filter((v) => !(v.voteId && entry.voteId && v.voteId === entry.voteId && v.targetId === entry.targetId));
  votes.push(entry);
  share.votes = votes.slice(-200);
  await fsp.writeFile(shareFile(token), JSON.stringify(share, null, 2), 'utf8');
  return share;
}

export function shareVotes(share) {
  return Array.isArray(share?.votes) ? share.votes : [];
}
