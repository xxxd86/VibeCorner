// 证据目录：产品里每一条「依据」都从这里取，前端不写死文案。
// 数据文件 app/server/data/evidence.json 可热更新（按 mtime 缓存）。
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './config.mjs';

// 证据目录放在 server/data/（与 skus.json 同目录），不是运行时数据目录
const FILE = path.join(APP_DIR, 'server', 'data', 'evidence.json');

let cache = { mtimeMs: 0, items: [], byId: new Map(), version: '' };

const STRENGTHS = new Set(['strong', 'moderate', 'weak', 'consensus']);
const KINDS = new Set(['study', 'review', 'guideline', 'consensus', 'experience']);

function normalize(raw) {
  const items = [];
  const byId = new Map();
  for (const e of Array.isArray(raw?.items) ? raw.items : []) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id || '').trim();
    if (!id || byId.has(id)) continue;
    const item = {
      id,
      topic: String(e.topic || '').slice(0, 40),
      claim: String(e.claim || '').slice(0, 120),
      strength: STRENGTHS.has(e.strength) ? e.strength : 'consensus',
      kind: KINDS.has(e.kind) ? e.kind : 'consensus',
      source: String(e.source || '').slice(0, 120),
      url: /^https?:\/\//.test(String(e.url || '')) ? String(e.url) : '',
      threshold: e.threshold && typeof e.threshold === 'object' ? e.threshold : null,
      caveat: String(e.caveat || '').slice(0, 160),
      // 给 UI 用的三类徽章家族 + 强度后缀（例：badge='研究支持', strengthLabel='弱' → 显示「研究支持 · 弱」）
      badge: badgeOf(e.strength, e.kind),
      strengthLabel: strengthLabelOf(e.strength, e.kind),
      badgeFull: [badgeOf(e.strength, e.kind), strengthLabelOf(e.strength, e.kind)].filter(Boolean).join(' · '),
      hasUrl: /^https?:\/\//.test(String(e.url || '')),
    };
    byId.set(id, item);
    items.push(item);
  }
  return { items, byId, version: String(raw?.version || '') };
}

function badgeOf(strength, kind) {
  // 三类徽章家族（契约 §3.4）：研究支持 / 专家共识 / 经验值；强度另用 strengthLabel 表达
  if (kind === 'experience') return '经验值';
  if (kind === 'guideline' || kind === 'consensus') return '专家共识';
  return '研究支持';
}

function strengthLabelOf(strength, kind) {
  if (kind === 'experience') return '';
  if (kind === 'guideline' || kind === 'consensus') return '';
  if (strength === 'strong') return '强';
  if (strength === 'moderate') return '中';
  if (strength === 'weak') return '弱';
  return '';
}

/** 读取（带 mtime 缓存）；文件缺失时返回空目录而不是抛错 */
export function loadEvidence() {
  let stat;
  try {
    stat = fs.statSync(FILE);
  } catch {
    cache = { mtimeMs: 0, items: [], byId: new Map(), version: '' };
    return cache;
  }
  if (stat.mtimeMs !== cache.mtimeMs) {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const norm = normalize(raw);
      cache = { mtimeMs: stat.mtimeMs, ...norm };
    } catch (e) {
      console.error('[evidence] 解析失败：', e.message);
    }
  }
  return cache;
}

export function getEvidence(id) {
  return loadEvidence().byId.get(String(id || '')) || null;
}

/** 供 rules 使用：只返回「可展示给用户」的精简字段 */
export function compact(id) {
  const e = getEvidence(id);
  if (!e) return null;
  return { id: e.id, claim: e.claim, strength: e.strength, kind: e.kind, badge: e.badge, source: e.source, url: e.url, caveat: e.caveat };
}

export function allEvidence() {
  const c = loadEvidence();
  return { version: c.version, count: c.items.length, items: c.items };
}
