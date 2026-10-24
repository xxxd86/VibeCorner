#!/usr/bin/env node
// tests/api-e2e.mjs —— 独立验收：真实服务端 API + SSE 端到端
//
// 零依赖（只用 node:*）。流程：
//   起服务（若 8848 未监听则 spawn app/server/index.mjs，轮询 /api/health ≤30s）
//   → POST /api/sessions
//   → POST /api/sessions/:id/image（读 doc 真实照片转 dataURL）
//   → POST /api/analyze stage=quality → l0 → measure(1-2 轮) → plan（SSE）
//   → 校验契约 6.2 结构 / bbox 0—1 / 测量 key 白名单 / 禁用词 / 关键尺寸缺失不得 verdict=ok
//   → GET /api/sessions 能读到、DELETE 后 GET 404
//
// 用法:
//   node tests/api-e2e.mjs                 # 场景 A（正常流程）+ 场景 B（跳过全部测量，验证 verdict 降级）
//   node tests/api-e2e.mjs --only=A        # 只跑场景 A（快速迭代用）
//   QA_KEEP_SERVER=1 node tests/api-e2e.mjs  # 保留本轮 spawn 的服务进程
//   QA_KEEP_DATA=1 ...                     # 不删除测试会话（便于人工排查）
//
// 退出码: 0 全部通过 / 1 有失败 / 2 前置条件缺失（服务端文件不存在等）

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8848);
const BASE = `http://${HOST}:${PORT}`;
const SERVER_ENTRY = join(ROOT, 'app', 'server', 'index.mjs');
const IMG_PATH = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img2_annotate.jpg');
const SCRATCH = join(ROOT, '.scratch');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

// 契约第 7 节：测量字典 key 白名单
const MEASURE_KEYS = new Set([
  'corridorWidth', 'cornerWidthA', 'cornerWidthB', 'freeDepth',
  'obstructionH', 'ceilingFree', 'outletDist', 'doorSwing', 'windowDist',
]);
// 契约第 8 节禁用词（含第 1 节 L0 禁语）
const BANNED = ['赋能', '打造', '极致', '一站式', '完美', '绝对', '保证', '100%'];
// 契约第 1 节 L0 禁止的「摆放结论」类断言。
// 注意：不要用裸「能放」——「决定猫抓板能放多深」是尺寸用途说明，不是可行性断言（实测误报）。
const L0_BANNED_CLAIMS = ['能放下', '放得下', '可行', '可以放', '推荐买', '保证'];
// 允许否定式：不能保证 / 不可行 / 不一定能放下 …
const NEG = /(不|未|没|无|非|难)/;

const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const ONLY = onlyArg ? onlyArg.split(',').map((s) => s.trim().toUpperCase()) : ['A', 'B'];
const KEEP_SERVER = process.env.QA_KEEP_SERVER === '1';
const KEEP_DATA = process.env.QA_KEEP_DATA === '1';
let AI_READY = null; // null=未知；false=服务端自报 AI 层未就绪

mkdirSync(SCRATCH, { recursive: true });

// ---------------------------------------------------------------- 结果框架
const steps = [];
let current = null;
const fatal = [];
const serverLogs = [];
const evidence = { runId: RUN_ID, startedAt: new Date().toISOString(), base: BASE, steps, sessions: {}, serverLogs };

function log(msg) { console.log(msg); }
function check(cond, msg, detail) {
  if (!cond && current) current.issues.push({ msg, detail: detail === undefined ? '' : String(detail) });
  return !!cond;
}
function note(msg) { if (current) current.notes.push(String(msg)); }
function warn(msg) { if (current) current.warn.push(String(msg)); }

async function step(name, fn) {
  const s = { name, ok: true, ms: 0, issues: [], notes: [], warn: [], data: null };
  steps.push(s);
  current = s;
  const t0 = Date.now();
  try {
    await fn(s);
  } catch (e) {
    s.issues.push({ msg: '未捕获异常: ' + (e && e.message ? e.message : String(e)), detail: e?.stack ? String(e.stack).split('\n').slice(1, 3).join(' | ') : '' });
  } finally {
    s.ms = Date.now() - t0;
    s.ok = s.issues.length === 0;
    current = null;
    const tag = s.ok ? 'PASS' : 'FAIL';
    log(`[${tag}] ${name}  (${(s.ms / 1000).toFixed(1)}s)`);
    for (const n of s.notes) log('        · ' + n);
    for (const w of s.warn) log('        ! WARN ' + w);
    for (const i of s.issues) log('        ✗ ' + i.msg + (i.detail ? ` — ${i.detail}` : ''));
  }
  return s;
}

// ---------------------------------------------------------------- HTTP
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpReq(method, path, { body, timeout = 30000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined || body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (raw) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = String(raw.length); }
    const req = http.request({ host: HOST, port: PORT, method, path, headers: h, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, bytes: buf.length });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP 超时 ${timeout}ms: ${method} ${path}`)));
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

async function api(method, path, body, opts = {}) {
  const r = await httpReq(method, path, { body, ...opts });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${method} ${path} → HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  }
  return r;
}

// ---------------------------------------------------------------- SSE
function splitSSEBlock(block, events) {
  // 单条 SSE 事件块；只取 data: 行（忽略注释/event/id/retry）
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let ev;
    try { ev = JSON.parse(payload); } catch {
      events.push({ __parseError: payload.slice(0, 200) });
      continue;
    }
    events.push(ev);
  }
}

/** POST /api/analyze，解析 SSE。返回 {events, final, errorEvent, status, ttfbMs, ms, bytes, contentType} */
function postSSE(path, body, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify(body));
    const t0 = Date.now();
    const events = [];
    let buf = '';
    let ttfbMs = null;
    let finalEv = null;
    let errorEv = null;
    let done = false;
    let graceTimer = null;

    const finish = (reason) => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      try { req.destroy(); } catch { /* noop */ }
      resolve({
        reason, events, final: finalEv ? finalEv.payload : null, finalEvent: finalEv,
        session: finalEv?.session || null, meta: finalEv?.meta || null,
        errorEvent: errorEv, ttfbMs, ms: Date.now() - t0, bytes: Buffer.byteLength(buf),
      });
    };

    const req = http.request({
      host: HOST, port: PORT, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'content-length': String(raw.length), accept: 'text/event-stream' },
    }, (res) => {
      ttfbMs = Date.now() - t0;
      if (res.statusCode !== 200) {
        let txt = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { txt += c; });
        res.on('end', () => {
          if (done) return; done = true; clearTimeout(hardTimer);
          reject(new Error(`POST ${path} → HTTP ${res.statusCode}: ${txt.slice(0, 400)}`));
        });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const before = events.length;
          splitSSEBlock(block, events);
          for (let i = before; i < events.length; i++) {
            const ev = events[i];
            if (ev.type === 'final' && !finalEv) {
              finalEv = ev;
              // 契约 6.3：final 之后可能有心跳；给 2.5s 宽限即收尾，避免挂死
              graceTimer = setTimeout(() => finish('final-grace'), 2500);
            } else if (ev.type === 'error' && !errorEv) {
              errorEv = ev;
              graceTimer = setTimeout(() => finish('error'), 300);
            }
          }
        }
      });
      res.on('end', () => finish('end'));
      res.on('error', (e) => { if (!done) { done = true; clearTimeout(hardTimer); reject(e); } });
    });

    const hardTimer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`SSE 超时 ${timeout}ms（收到 ${events.length} 条事件，final=${finalEv ? '有' : '无'}）`));
    }, timeout);

    req.on('error', (e) => { if (!done) { done = true; clearTimeout(hardTimer); reject(e); } });
    req.write(raw);
    req.end();
  });
}

async function analyze(sessionId, stage, payload, timeout = 180000) {
  const r = await postSSE('/api/analyze', { sessionId, stage, payload }, { timeout });
  if (r.errorEvent) throw new Error(`SSE error 事件（stage=${stage}): ${r.errorEvent.message || JSON.stringify(r.errorEvent)}`);
  if (!r.final) throw new Error(`SSE 没有 final 事件（stage=${stage}，收到 ${r.events.length} 条: ${JSON.stringify(r.events.slice(-3)).slice(0, 300)}）`);
  return r;
}

/** 某些 stage 的 payload 服务端实现细节未在契约固定：按候选逐个尝试（仅 HTTP 4xx 时换） */
async function analyzeFlexible(sessionId, stage, candidates, timeout = 180000) {
  let lastErr = null;
  for (const payload of candidates) {
    try {
      return await analyze(sessionId, stage, payload, timeout);
    } catch (e) {
      lastErr = e;
      if (/HTTP 4\d\d/.test(e.message)) { log(`        (payload ${JSON.stringify(payload)} 被拒: ${e.message.slice(0, 120)})`); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- 服务端生命周期
async function healthUp() {
  try {
    const r = await httpReq('GET', '/api/health', { timeout: 1500 });
    return { up: r.status === 200, res: r };
  } catch { return { up: false, res: null }; }
}

function pushLog(kind, buf) {
  const text = String(buf);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    serverLogs.push(`[${kind}] ${line}`);
    if (serverLogs.length > 400) serverLogs.shift();
  }
}

let child = null;
let spawnedServer = false;

async function ensureServer() {
  const h = await healthUp();
  if (h.up) { log(`[server] ${BASE} 已在监听，复用外部进程`); return h.res; }
  if (!existsSync(SERVER_ENTRY)) throw new Error(`缺少 ${SERVER_ENTRY}（服务端尚未交付）`);
  log(`[server] ${BASE} 未监听 → spawn node app/server/index.mjs`);
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawnedServer = true;
  let exitInfo = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => pushLog('out', d));
  child.stderr.on('data', (d) => pushLog('err', d));
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exitInfo) {
      throw new Error(`server 进程提前退出 code=${exitInfo.code} signal=${exitInfo.signal}\n${serverLogs.slice(-12).join('\n')}`);
    }
    const hh = await healthUp();
    if (hh.up) { log(`[server] 就绪（${((30000 - (deadline - Date.now())) / 1000).toFixed(1)}s 内） pid=${child.pid}`); return hh.res; }
    await sleep(400);
  }
  throw new Error(`30s 内 /api/health 未就绪\n${serverLogs.slice(-12).join('\n')}`);
}

function stopServer() {
  if (spawnedServer && child && !KEEP_SERVER) {
    try { child.kill(); log('[server] 已停止本轮 spawn 的服务进程'); } catch { /* noop */ }
  } else if (spawnedServer) {
    log(`[server] QA_KEEP_SERVER=1，保留 pid=${child?.pid}`);
  }
}

// ---------------------------------------------------------------- 图片 / 数据工具
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('不是 JPEG（magic 不匹配）');
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('未找到 SOF 标记');
}

function loadImage() {
  if (!existsSync(IMG_PATH)) throw new Error(`缺少测试图片 ${IMG_PATH}`);
  const buf = readFileSync(IMG_PATH);
  const { width, height } = jpegSize(buf);
  const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
  // 客户端会算真实指标；这里给中性值，避免质检因测试侧指标被判 blocking（真实值由前端 image-utils 产出）
  const metrics = { brightness: 128, contrast: 52, sharpness: 180, width, height, bytes: buf.length };
  return { buf, width, height, dataUrl, metrics };
}

// 按 key 给一个「看起来像真人会量的」厘米值（用于正常流程）
const SAMPLE_CM = {
  corridorWidth: 62, cornerWidthA: 74, cornerWidthB: 58, freeDepth: 44,
  obstructionH: 75, ceilingFree: 120, outletDist: 90, doorSwing: 80, windowDist: 150,
};

// ---------------------------------------------------------------- 结构校验工具
function walkStrings(obj, cb, p = '') {
  if (typeof obj === 'string') { cb(obj, p); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => walkStrings(v, cb, `${p}[${i}]`)); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) walkStrings(v, cb, p ? `${p}.${k}` : k);
  }
}

/** 找禁用词；否定式（不能保证/不可行）放行 */
function findBanned(text, words) {
  const hits = [];
  for (const w of words) {
    let from = 0;
    while (true) {
      const i = text.indexOf(w, from);
      if (i < 0) break;
      const prev = text.slice(Math.max(0, i - 2), i);
      if (!NEG.test(prev)) hits.push({ word: w, snippet: text.slice(Math.max(0, i - 14), i + w.length + 14) });
      from = i + w.length;
    }
  }
  return hits;
}

function bannedHitsIn(payload, words, rootName) {
  const out = [];
  walkStrings(payload, (s, p) => {
    for (const h of findBanned(s, words)) out.push({ path: `${rootName}.${p}`, ...h });
  });
  return out;
}

function isNum01(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1; }
function validBbox(b) { return Array.isArray(b) && b.length === 4 && b.every(isNum01); }
function nonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }
function isEnum(v, list) { return list.includes(v); }

// ---------------- 各阶段 schema 校验（契约 6.2） ----------------
function validateQuality(p, s) {
  check(p && typeof p === 'object', 'quality payload 是对象');
  check(isEnum(p.status, ['pass', 'retake']), 'quality.status ∈ pass|retake', JSON.stringify(p.status));
  check(typeof p.score === 'number' && p.score >= 0 && p.score <= 100, 'quality.score 是 0—100 数字', JSON.stringify(p.score));
  check(p.scene && typeof p.scene === 'object', 'quality.scene 是对象');
  if (p.scene && typeof p.scene === 'object') {
    check(typeof p.scene.indoor === 'boolean', 'quality.scene.indoor 是布尔', typeof p.scene.indoor);
    check(typeof p.scene.cornerVisible === 'boolean', 'quality.scene.cornerVisible 是布尔', typeof p.scene.cornerVisible);
    check(typeof p.scene.floorVisible === 'boolean', 'quality.scene.floorVisible 是布尔', typeof p.scene.floorVisible);
    check(isEnum(p.scene.obstruction, ['none', 'some', 'heavy']), 'quality.scene.obstruction ∈ none|some|heavy', JSON.stringify(p.scene.obstruction));
    check(typeof p.scene.note === 'string', 'quality.scene.note 是字符串');
  }
  check(Array.isArray(p.issues), 'quality.issues 是数组');
  for (const [i, it] of (p.issues || []).entries()) {
    check(isEnum(it.code, ['dark', 'blurry', 'occluded', 'no_floor', 'not_indoor', 'too_close', 'other']), `quality.issues[${i}].code 合法`, JSON.stringify(it.code));
    check(isEnum(it.impact, ['high', 'mid', 'low']), `quality.issues[${i}].impact 合法`, JSON.stringify(it.impact));
    check(isEnum(it.severity, ['block', 'warn']), `quality.issues[${i}].severity 合法`, JSON.stringify(it.severity));
    check(typeof it.label === 'string' && typeof it.hint === 'string', `quality.issues[${i}] 有 label/hint`);
  }
  check(typeof p.photoTip === 'string', 'quality.photoTip 是字符串');
  note(`status=${p.status} score=${p.score} issues=${(p.issues || []).length}`);
}

function validateL0(p, s) {
  check(p && typeof p === 'object', 'L0 payload 是对象');
  check(p.scene && typeof p.scene === 'object', 'L0.scene 是对象');
  if (p.scene && typeof p.scene === 'object') {
    check(nonEmptyStr(p.scene.summary), 'L0.scene.summary 非空', JSON.stringify(p.scene.summary));
    check(isEnum(p.scene.roomGuess, ['客厅', '卧室', '书房', '阳台', '玄关', '餐厅', '卫生间', '其他']) || nonEmptyStr(p.scene.roomGuess), 'L0.scene.roomGuess 存在', JSON.stringify(p.scene.roomGuess));
    check(isEnum(p.scene.light, ['medium', 'bright', 'dim']), 'L0.scene.light ∈ medium|bright|dim', JSON.stringify(p.scene.light));
    check(isEnum(p.scene.floor, ['wood', 'tile', 'other']), 'L0.scene.floor ∈ wood|tile|other', JSON.stringify(p.scene.floor));
  }
  check(isEnum(p.verdict, ['continue', 'not_supported', 'insufficient']), 'L0.verdict ∈ continue|not_supported|insufficient', JSON.stringify(p.verdict));
  check(nonEmptyStr(p.verdictReason), 'L0.verdictReason 非空', JSON.stringify(p.verdictReason));
  check(Array.isArray(p.regions) && p.regions.length >= 0 && p.regions.length <= 5, 'L0.regions 是 0—5 数组', JSON.stringify(p.regions?.length));
  for (const [i, r] of (p.regions || []).entries()) {
    check(validBbox(r.bbox), `L0.regions[${i}].bbox 是 0—1 的 4 元数组`, JSON.stringify(r.bbox));
    check(isEnum(r.verdict, ['ok', 'conditional', 'blocked', 'unknown']), `L0.regions[${i}].verdict 合法`, JSON.stringify(r.verdict));
    check(nonEmptyStr(r.id) && nonEmptyStr(r.label), `L0.regions[${i}] 有 id/label`);
  }
  check(Array.isArray(p.directions) && p.directions.length >= 1 && p.directions.length <= 3, 'L0.directions 是 1—3 数组', JSON.stringify(p.directions?.length));
  for (const [i, d] of (p.directions || []).entries()) {
    check(nonEmptyStr(d.id) && nonEmptyStr(d.title) && nonEmptyStr(d.pitch), `L0.directions[${i}] 有 id/title/pitch`);
    check(isEnum(d.kit, ['new', 'reuse', 'mix']), `L0.directions[${i}].kit ∈ new|reuse|mix`, JSON.stringify(d.kit));
    check(isEnum(d.confidence, ['high', 'medium', 'low']), `L0.directions[${i}].confidence 合法`, JSON.stringify(d.confidence));
    check(Array.isArray(d.firstMeasurements), `L0.directions[${i}].firstMeasurements 是数组`);
    for (const [j, m] of (d.firstMeasurements || []).entries()) {
      check(MEASURE_KEYS.has(m.key), `L0.directions[${i}].firstMeasurements[${j}].key 在字典内`, JSON.stringify(m.key));
    }
  }
  check(Array.isArray(p.missing), 'L0.missing 是数组');
  for (const [i, m] of (p.missing || []).entries()) {
    check(MEASURE_KEYS.has(m.key), `L0.missing[${i}].key 在测量字典内`, JSON.stringify(m.key));
  }
  check(typeof p.nextAction === 'string', 'L0.nextAction 是字符串', typeof p.nextAction);
  check(typeof p.heatmapNote === 'string', 'L0.heatmapNote 是字符串');
  check(nonEmptyStr(p.disclaimer) && p.disclaimer.includes('方向预览'), 'L0.disclaimer 含「方向预览」', JSON.stringify(p.disclaimer));
  // L0 不得给摆放结论
  const claims = bannedHitsIn(p, L0_BANNED_CLAIMS, 'l0');
  check(claims.length === 0, 'L0 无「能放下/可行/推荐买」类断言', claims.slice(0, 3).map((h) => `${h.path}~"${h.snippet}"`).join(' ; '));
  // 全站禁用词
  const banned = bannedHitsIn(p, BANNED, 'l0');
  check(banned.length === 0, 'L0 无禁用词（赋能/打造/极致/一站式/完美/绝对/保证/100%）', banned.slice(0, 3).map((h) => `${h.path}~"${h.snippet}"`).join(' ; '));
  note(`verdict=${p.verdict} directions=${(p.directions || []).length} regions=${(p.regions || []).length} missing=[${(p.missing || []).map((m) => m.key).join(',')}]`);
  return { directions: p.directions, missing: p.missing, regions: p.regions };
}

function validateMeasure(p, s) {
  check(p && typeof p === 'object', 'measure payload 是对象');
  check(typeof p.round === 'number' && p.round >= 1, 'measure.round 是 ≥1 数字', JSON.stringify(p.round));
  const qs = p.questions || [];
  check(Array.isArray(p.questions), 'measure.questions 是数组');
  check(qs.length <= 2, 'measure.questions ≤2（契约：每轮只 1—2 项）', `length=${qs.length}`);
  if (qs.length === 0) note('本轮 questions 为空（测量已收敛）');
  for (const [i, q] of qs.entries()) {
    check(MEASURE_KEYS.has(q.key), `measure.questions[${i}].key 在测量字典内`, JSON.stringify(q.key));
    check(nonEmptyStr(q.label) && nonEmptyStr(q.endpoints) && nonEmptyStr(q.why), `measure.questions[${i}] 有 label/endpoints/why`);
    check(q.unit === 'cm', `measure.questions[${i}].unit === "cm"`, JSON.stringify(q.unit));
    check(typeof q.optional === 'boolean' || q.optional === undefined, `measure.questions[${i}].optional 是布尔`);
  }
  check(Array.isArray(p.remainingKeys), 'measure.remainingKeys 是数组');
  for (const [i, k] of (p.remainingKeys || []).entries()) check(MEASURE_KEYS.has(k), `measure.remainingKeys[${i}] 在字典内`, JSON.stringify(k));
  check(typeof p.askNote === 'string', 'measure.askNote 是字符串');
  note(`round=${p.round} questions=[${qs.map((q) => q.key).join(',')}] remaining=[${(p.remainingKeys || []).join(',')}]`);
  return { questions: qs, remainingKeys: p.remainingKeys };
}

function validatePlan(p, s, ctx) {
  check(p && typeof p === 'object', 'plan payload 是对象');
  check(isEnum(p.verdict, ['ok', 'conditional', 'not_supported', 'insufficient']), 'plan.verdict 合法', JSON.stringify(p.verdict));
  check(nonEmptyStr(p.headline), 'plan.headline 非空', JSON.stringify(p.headline));
  check(nonEmptyStr(p.disclaimer) && p.disclaimer.includes('现场确认'), 'plan.disclaimer 含「现场确认」（L1 免责行）', JSON.stringify(p.disclaimer));

  check(Array.isArray(p.annotations), 'plan.annotations 是数组');
  for (const [i, a] of (p.annotations || []).entries()) {
    check(validBbox(a.bbox), `plan.annotations[${i}].bbox 是 0—1 的 4 元数组`, JSON.stringify(a.bbox));
    check(nonEmptyStr(a.id) && nonEmptyStr(a.label), `plan.annotations[${i}] 有 id/label`);
  }
  check(Array.isArray(p.items), 'plan.items 是数组');
  for (const [i, it] of (p.items || []).entries()) {
    check(isEnum(it.type, ['new', 'reuse']), `plan.items[${i}].type ∈ new|reuse`, JSON.stringify(it.type));
    check(nonEmptyStr(it.id) && nonEmptyStr(it.title), `plan.items[${i}] 有 id/title`);
    if (it.type === 'new') {
      if (!(typeof it.price === 'number')) warn(`plan.items[${i}] type=new 但缺 price`);
      if (!nonEmptyStr(it.sku)) warn(`plan.items[${i}] type=new 但缺 sku`);
    }
  }
  check(Array.isArray(p.constraints), 'plan.constraints 是数组');
  let unknownConstraints = 0;
  for (const [i, c] of (p.constraints || []).entries()) {
    check(MEASURE_KEYS.has(c.key), `plan.constraints[${i}].key 在测量字典内`, JSON.stringify(c.key));
    // V2 契约扩展（CONTRACT-V2 §2.2）：status 四态 pass|warn|fail|unknown。
    // warn = 按经验阈值偏紧、但无可靠证据支持否决（只出现在经验阈值类依据上，且必须 honest:true）。
    // V1 语义不变：后端只在「经验阈值」场景产出 warn，不会把有指南支持的判定降成 warn。
    check(isEnum(c.status, ['pass', 'warn', 'fail', 'unknown']), `plan.constraints[${i}].status 合法（V2 四态）`, JSON.stringify(c.status));
    if (c.status === 'warn') check(c.honest === true, `plan.constraints[${i}].status=warn 时必须 honest:true`, JSON.stringify(c.honest));
    check(nonEmptyStr(c.label), `plan.constraints[${i}].label 非空`);
    if (c.status === 'unknown') unknownConstraints++;
  }
  check(Array.isArray(p.checklist) && p.checklist.length >= 1, 'plan.checklist 是非空数组', JSON.stringify(p.checklist?.length));
  for (const [i, c] of (p.checklist || []).entries()) {
    check(nonEmptyStr(c.id) && nonEmptyStr(c.text), `plan.checklist[${i}] 有 id/text`);
    check(typeof c.critical === 'boolean', `plan.checklist[${i}].critical 是布尔`);
  }
  check(Array.isArray(p.radar) && p.radar.length >= 1, 'plan.radar 是非空数组', JSON.stringify(p.radar?.length));
  if (Array.isArray(p.radar) && p.radar.length !== 5) warn(`plan.radar 维度数=${p.radar.length}（契约第 2 节：五维）`);
  for (const [i, r] of (p.radar || []).entries()) {
    check(nonEmptyStr(r.label) && typeof r.score === 'number' && r.score >= 0 && r.score <= 5, `plan.radar[${i}] 有 label 且 score 0—5`, JSON.stringify({ label: r.label, score: r.score }));
  }
  if (!p.budget || typeof p.budget !== 'object') warn('plan 缺 budget 对象（契约 6.2 有此字段）');
  if (!p.aftercare || typeof p.aftercare !== 'object') warn('plan 缺 aftercare 对象（契约 6.2 有此字段）');

  // Lead 追加断言：verdict != ok 时 headline 不得含肯定语义
  if (p.verdict !== 'ok' && nonEmptyStr(p.headline)) {
    const POSITIVE = [/可以放/, /可换/, /建议买/, /能放下/, /放得下/, /推荐买/, /没问题/];
    const hit = POSITIVE.filter((re) => re.test(p.headline)).map((re) => re.source);
    check(hit.length === 0, `plan.verdict=${p.verdict} 时 headline 不得含肯定语义（可以放/可换/建议买/能放下）`, `headline="${p.headline}" 命中 [${hit.join(',')}]`);
  }
  // Lead 追加断言：blocked 条目必须有非空 fitNote，且 constraints 至少一条 fail|unknown
  const blockedItems = (p.items || []).filter((it) => it.fit === 'blocked');
  for (const [i, it] of (p.items || []).entries()) {
    if (it.fit === 'blocked') check(nonEmptyStr(it.fitNote), `plan.items[${i}] fit=blocked 必须有非空 fitNote`, JSON.stringify(it.fitNote));
  }
  if (blockedItems.length > 0) {
    const bad = (p.constraints || []).filter((c) => c.status === 'fail' || c.status === 'unknown');
    check(bad.length >= 1, '存在 fit=blocked 条目时 constraints 至少一条 status=fail|unknown', `blocked=${blockedItems.length} fail/unknown=${bad.length}`);
  }

  const banned = bannedHitsIn(p, BANNED, 'plan');
  check(banned.length === 0, 'plan 无禁用词（赋能/打造/极致/一站式/完美/绝对/保证/100%）', banned.slice(0, 3).map((h) => `${h.path}~"${h.snippet}"`).join(' ; '));

  // 关键尺寸缺失 → verdict 不得为 ok
  const unmeasured = ctx.unmeasuredCritical || [];
  if (p.verdict === 'ok' && unmeasured.length > 0) {
    check(false, `关键尺寸缺失但 plan.verdict=ok（未测: ${unmeasured.join(',')}）`, '契约 1/6.2：未知就是未知，缺失必须 unknown 或阻断');
  } else if (p.verdict === 'ok' && unknownConstraints > 0) {
    check(false, `plan.verdict=ok 但存在 ${unknownConstraints} 条 unknown 约束`, '未知约束与 ok 结论矛盾');
  } else {
    note(`verdict 与缺失尺寸一致性检查通过（未测键=[${unmeasured.join(',')}] unknown约束=${unknownConstraints}）`);
  }
  note(`verdict=${p.verdict} annotations=${(p.annotations || []).length} items=${(p.items || []).length} constraints=${(p.constraints || []).length} checklist=${(p.checklist || []).length} radar=${(p.radar || []).length} unknown约束=${unknownConstraints}`);
  return { unknownConstraints, unmeasured };
}

// ---------------------------------------------------------------- 业务流程
function classifyStageTiming(r) {
  const u = r.meta?.usage || null;
  let tok = 'tokens=n/a';
  if (u) {
    const total = u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
    tok = `tokens=${total}(in=${u.prompt_tokens ?? '?'},out=${u.completion_tokens ?? '?'})`;
  }
  return `ttfb=${(r.ttfbMs / 1000).toFixed(2)}s total=${(r.ms / 1000).toFixed(2)}s events=${r.events.length} ${tok} repaired=${r.meta?.repaired === true}`;
}

async function createSession(titleHint) {
  const r = await api('POST', '/api/sessions', {});
  const s = r.json;
  if (!s || typeof s !== 'object' || !nonEmptyStr(s.id)) throw new Error('POST /api/sessions 未返回合法 Session: ' + r.text.slice(0, 300));
  return s;
}

async function uploadImage(sessionId, img) {
  const r = await api('POST', `/api/sessions/${sessionId}/image`, {
    dataUrl: img.dataUrl, width: img.width, height: img.height, metrics: img.metrics,
  }, { timeout: 60000 });
  return r.json?.session || r.json;
}

async function getSession(id) {
  const r = await api('GET', `/api/sessions/${id}`);
  return r.json;
}

async function deleteSession(id) {
  try { await api('DELETE', `/api/sessions/${id}`); return true; } catch (e) { log(`        (清理 DELETE 失败: ${e.message.slice(0, 160)})`); return false; }
}

async function answer(sessionId, key, valueCm, skipped) {
  return api('POST', `/api/sessions/${sessionId}/answer`, { key, valueCm, skipped });
}

/** 跑测量直到服务端不再出题（契约 §6.1：measure 结束时 questions:[] 且 measureDone=true） */
async function runMeasureLoop(sessionId, { skipAll = false, maxRounds = 5, directionId = null } = {}) {
  const rounds = [];
  let payload = directionId ? { directionId } : {};
  let converged = false;
  for (let round = 1; round <= maxRounds; round++) {
    const r = await analyzeFlexible(sessionId, 'measure', [payload, {}]);
    const v = validateMeasure(r.final);
    rounds.push({ round, final: r.final, timing: classifyStageTiming(r), meta: r.meta });
    if (!v.questions.length) { converged = true; break; }
    const answers = {};
    for (const q of v.questions) {
      answers[q.key] = skipAll ? { skipped: true } : { valueCm: SAMPLE_CM[q.key] ?? 60 };
    }
    // 契约 §6.1：answers 随下一次 measure 的 payload 提交；同时把其中第一个答案走一遍
    // POST /answer（契约 §6 表格），两条路径都应落库到 session.measurements
    if (round === 1) {
      const [k, a] = Object.entries(answers)[0];
      await answer(sessionId, k, a.skipped ? null : a.valueCm, Boolean(a.skipped));
    }
    payload = directionId ? { directionId, answers } : { answers };
  }
  return { rounds, converged };
}

function plannedPayloadsFor(stage, ctx = {}) {
  if (stage === 'quality') return [{ metrics: ctx.metrics, profile: { goal: '想放一个猫窝，预算 300', cats: 1 } }, {}];
  if (stage === 'l0') return [{}];
  if (stage === 'plan') {
    const c = [];
    const p = { profile: { goal: '想放一个猫窝', budget: 300, cats: 1 } };
    if (ctx.directionId) c.push({ directionId: ctx.directionId, ...p });
    c.push(p, {});
    return c;
  }
  return [{}];
}

function collectCriticalContext(l0, session) {
  const measured = session?.measurements || {};
  const measuredKeys = Object.entries(measured)
    .filter(([, v]) => v && !v.skipped && (v.valueMm > 0 || v.valueCm > 0))
    .map(([k]) => k);
  const missing = (l0?.missing || []).map((m) => m.key).filter(Boolean);
  const unmeasured = [...new Set(missing.filter((k) => !measuredKeys.includes(k)))];
  return { measuredKeys, unmeasured };
}

// ================================================================ 场景 A
async function scenarioA(s, img) {
  s.data = {};
  const session = await createSession();
  s.data.sessionId = session.id;
  evidence.sessions.A = session.id;
  check(/^s_/.test(session.id), 'Session.id 形如 s_xxx', session.id);
  check(isEnum(session.stage, ['empty', 'uploaded', 'quality', 'l0', 'measuring', 'ready', 'delivered']), 'Session.stage 合法', JSON.stringify(session.stage));
  note(`session=${session.id} stage=${session.stage}`);

  const up = await uploadImage(session.id, img);
  const upT = Date.now();
  check(up && typeof up === 'object', '上传图片返回对象');
  check(up?.image && nonEmptyStr(up.image.imageId), 'session.image.imageId 存在', JSON.stringify(up?.image));
  check(up?.image && up.image.width > 0 && up.image.height > 0, 'session.image 有宽高', JSON.stringify(up?.image));
  check(isEnum(up.stage, ['uploaded', 'quality', 'l0', 'measuring', 'ready', 'delivered']), '上传后 stage 合法', JSON.stringify(up.stage));
  note(`upload ${((Date.now() - upT) / 1000).toFixed(2)}s image=${JSON.stringify(up?.image)} metrics=${JSON.stringify(up?.metrics)}`);

  if (up?.image?.url) {
    const ir = await httpReq('GET', up.image.url, { timeout: 15000 });
    check(ir.status === 200, 'GET /api/image/:id 返回 200', `status=${ir.status}`);
    check(/^image\//.test(ir.headers['content-type'] || ''), '图片 Content-Type 是 image/*', ir.headers['content-type']);
    check(ir.bytes === img.buf.length, '取回图片字节数与上传一致', `uploaded=${img.buf.length} got=${ir.bytes}`);
    const nf = await httpReq('GET', '/api/image/i_does_not_exist', { timeout: 5000 });
    check(nf.status === 404, '不存在的 imageId 返回 404（id 不可猜）', `status=${nf.status}`);
  } else {
    check(false, 'session.image.url 缺失，无法验证图片存取');
  }

  // ---- quality（契约 §6.1：quality payload = {metrics, profile?}）
  let r = await analyzeFlexible(session.id, 'quality', plannedPayloadsFor('quality', { metrics: img.metrics }));
  validateQuality(r.final, s);
  s.data.quality = r.final;
  note(`quality ${classifyStageTiming(r)}`);
  evidence.sessions.A_quality = r.final;
  evidence.sessions.A_meta_quality = r.meta;

  // ---- l0
  r = await analyzeFlexible(session.id, 'l0', plannedPayloadsFor('l0'));
  const l0Payload = r.final;
  s.data.l0 = l0Payload;
  validateL0(l0Payload, s);
  note(`l0 ${classifyStageTiming(r)}`);
  evidence.sessions.A_l0 = l0Payload;
  evidence.sessions.A_meta_l0 = r.meta;
  const directionId = l0Payload?.directions?.[0]?.id || null;
  check(nonEmptyStr(directionId), 'L0 至少给出一个可选择方向（directions[0].id）', JSON.stringify(directionId));

  // ---- measure（契约 §6.1：measure payload = {directionId, answers}）
  const loop = await runMeasureLoop(session.id, { skipAll: false, directionId });
  const rounds = loop.rounds;
  s.data.rounds = rounds;
  check(rounds.length >= 1, 'measure 至少跑通 1 轮', `rounds=${rounds.length}`);
  check(loop.converged, 'measure 收敛到 questions:[]（契约 §6.1：measureDone）', `rounds=${rounds.length}，最后一轮 questions=${(rounds.at(-1)?.final?.questions || []).length}`);
  const questionRounds = rounds.filter((x) => (x.final.questions || []).length > 0).length;
  if (loop.converged) check(questionRounds <= 3, '出题轮次 ≤3（flow.js 上限，DoD 期望 2 轮）', `出题轮次=${questionRounds}（共 ${rounds.length} 次 measure 调用）`);
  note(`measure 调用 ${rounds.length} 次，其中出题 ${questionRounds} 轮`);
  evidence.sessions.A_measure = rounds.map((x) => x.final);

  // ---- 会话落库检查（测量答案 + measureDone）
  const sessionAfterMeasure = await getSession(session.id);
  const measuredKeys = Object.keys(sessionAfterMeasure.measurements || {});
  check(measuredKeys.length >= 1, 'GET session 中 measurements 已落库', JSON.stringify(measuredKeys));
  check(isEnum(sessionAfterMeasure.stage, ['measuring', 'ready', 'delivered', 'l0', 'quality', 'uploaded']), '测量后 stage 合法', JSON.stringify(sessionAfterMeasure.stage));
  note(`measurements=${JSON.stringify(Object.fromEntries(Object.entries(sessionAfterMeasure.measurements || {}).map(([k, v]) => [k, v.valueCm ?? v.valueMm])))}`);
  check(sessionAfterMeasure.measureDone === true, 'measureDone === true（契约 §6.1：measure 结束由服务端置位）', JSON.stringify(sessionAfterMeasure.measureDone));

  // ---- plan（契约 §6.1：plan payload = {directionId, profile}）
  r = await analyzeFlexible(session.id, 'plan', plannedPayloadsFor('plan', { directionId }));
  const sessionNow = await getSession(session.id);
  const ctx = collectCriticalContext(l0Payload, sessionNow);
  const planV = validatePlan(r.final, s, ctx);
  s.data.plan = r.final;
  note(`plan ${classifyStageTiming(r)}`);
  evidence.sessions.A_plan = r.final;
  evidence.sessions.A_meta_plan = r.meta;

  if (r.final.verdict === 'ok') {
    const sk = ctx.measuredKeys;
    check(sk.length > 0, 'verdict=ok 时至少有一个真实测量值', JSON.stringify(sk));
  }

  // ---- POST /api/sessions/:id/answer 冒烟（契约 §6 表格：仅落库、不走模型）
  await api('POST', `/api/sessions/${session.id}/answer`, { key: 'outletDist', valueCm: 88, skipped: false });
  const ansSession = await getSession(session.id);
  check(ansSession.measurements?.outletDist?.valueMm === 880, '/answer 落库 outletDist valueCm=88 → valueMm=880', JSON.stringify(ansSession.measurements?.outletDist));
  await api('POST', `/api/sessions/${session.id}/answer`, { key: 'windowDist', valueCm: null, skipped: true });
  const ansSession2 = await getSession(session.id);
  check(ansSession2.measurements?.windowDist?.skipped === true, '/answer skipped:true 落库为 skipped', JSON.stringify(ansSession2.measurements?.windowDist));

  // ---- 列表 / 删除 / 404
  const list = await api('GET', '/api/sessions');
  const arr = list.json?.sessions;
  check(Array.isArray(arr), 'GET /api/sessions 返回 {sessions:[]}', list.text.slice(0, 200));
  check(Array.isArray(arr) && arr.some((x) => x.id === session.id), 'GET /api/sessions 能读到本会话', `list=${arr?.length}`);
  const summary = Array.isArray(arr) ? arr.find((x) => x.id === session.id) : null;
  if (summary) {
    check(nonEmptyStr(summary.title), 'SessionSummary.title 非空', JSON.stringify(summary.title));
    check(typeof summary.createdAt === 'string' && !Number.isNaN(Date.parse(summary.createdAt)), 'SessionSummary.createdAt 是 ISO 时间', JSON.stringify(summary.createdAt));
  }

  if (KEEP_DATA) {
    note('QA_KEEP_DATA=1，跳过 DELETE');
  } else {
    const del = await httpReq('DELETE', `/api/sessions/${session.id}`);
    check(del.status === 200 && del.json?.ok === true, 'DELETE /api/sessions/:id 返回 {ok:true}', `status=${del.status} body=${del.text.slice(0, 200)}`);
    const gone = await httpReq('GET', `/api/sessions/${session.id}`);
    check(gone.status === 404, 'DELETE 后 GET 该 id 返回 404', `status=${gone.status}`);
    if (gone.text) {
      const errOk = gone.json?.error && (gone.json.error.code || gone.json.error.message);
      if (!errOk) warn('404 错误体不符合契约 {error:{code,message}}: ' + gone.text.slice(0, 160));
    }
    const list2 = await api('GET', '/api/sessions');
    check(Array.isArray(list2.json?.sessions) && !list2.json.sessions.some((x) => x.id === session.id), 'DELETE 后列表中不再出现该会话');
  }
}

// ================================================================ 场景 B
// 上传 + 质检 + L0 → 测量全部「跳过」→ plan：关键尺寸全缺时 verdict 不得为 ok
async function scenarioB(s, img) {
  s.data = {};
  const session = await createSession();
  s.data.sessionId = session.id;
  evidence.sessions.B = session.id;
  note(`session=${session.id}`);

  await uploadImage(session.id, img);
  let r = await analyzeFlexible(session.id, 'quality', plannedPayloadsFor('quality', { metrics: img.metrics }));
  validateQuality(r.final, s);
  r = await analyzeFlexible(session.id, 'l0', plannedPayloadsFor('l0'));
  const l0 = r.final;
  validateL0(l0, s);
  note(`l0 ${classifyStageTiming(r)}`);
  evidence.sessions.B_meta_l0 = r.meta;
  const directionId = l0?.directions?.[0]?.id || null;

  const loopB = await runMeasureLoop(session.id, { skipAll: true, directionId });
  const rounds = loopB.rounds;
  s.data.rounds = rounds;
  check(loopB.converged, '（场景 B）measure 收敛到 questions:[]（measureDone）', `rounds=${rounds.length}`);
  evidence.sessions.B_measure = rounds.map((x) => x.final);

  const sessionNow = await getSession(session.id);
  const skippedKeys = Object.entries(sessionNow.measurements || {}).filter(([, v]) => v?.skipped).map(([k]) => k);
  note(`skipped measurements=[${skippedKeys.join(',')}] measureDone=${Boolean(sessionNow.measureDone)}`);

  r = await analyzeFlexible(session.id, 'plan', plannedPayloadsFor('plan', { directionId }));
  const ctx = collectCriticalContext(l0, sessionNow);
  const pv = validatePlan(r.final, s, ctx);
  evidence.sessions.B_plan = r.final;
  evidence.sessions.B_meta_plan = r.meta;

  // 场景 B 的核心断言：关键尺寸全缺 / 全部跳过 → 不能给 ok
  const l0Missing = (l0?.missing || []).map((m) => m.key);
  const allSkipped = skippedKeys.length > 0 && skippedKeys.length === Object.keys(sessionNow.measurements || {}).length;
  if (l0Missing.length > 0 || allSkipped) {
    check(r.final.verdict !== 'ok', '关键尺寸缺失/全部跳过时 plan.verdict ≠ ok', `verdict=${r.final.verdict} l0Missing=[${l0Missing.join(',')}] skipped=[${skippedKeys.join(',')}]`);
    check(ctx.unmeasured.length > 0 || pv.unknownConstraints > 0, '缺失尺寸在 plan 中体现为 unknown/未测', `unmeasured=[${ctx.unmeasured.join(',')}] unknown约束=${pv.unknownConstraints}`);
  } else {
    warn('L0 未声明缺失尺寸且无跳过记录，本场景降级断言不适用');
  }

  if (!KEEP_DATA) await deleteSession(session.id);
}

// ================================================================ 场景 C（AI 层未就绪时先验 CRUD）
async function scenarioCRUD(s, img) {
  const session = await createSession();
  evidence.sessions.C = session.id;
  check(/^s_/.test(session.id), 'Session.id 形如 s_xxx', session.id);
  note(`session=${session.id}`);

  const t0 = Date.now();
  const up = await uploadImage(session.id, img);
  check(!!up?.image?.imageId, '上传图片 → session.image.imageId', JSON.stringify(up?.image));
  check(up?.image?.url && up.image.width > 0 && up.image.height > 0, 'session.image 有 url/宽高', JSON.stringify(up?.image));
  if (up?.image?.url) {
    const ir = await httpReq('GET', up.image.url, { timeout: 15000 });
    check(ir.status === 200, 'GET /api/image/:id → 200', `status=${ir.status}`);
    check(ir.bytes === img.buf.length, '取回字节数与上传一致', `uploaded=${img.buf.length} got=${ir.bytes}`);
    const nf = await httpReq('GET', '/api/image/i_does_not_exist', { timeout: 5000 });
    check(nf.status === 404, '不存在的 imageId → 404', `status=${nf.status}`);
  }
  note(`upload+image ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const list = await api('GET', '/api/sessions');
  check(Array.isArray(list.json?.sessions) && list.json.sessions.some((x) => x.id === session.id), 'GET /api/sessions 能读到本会话', `list=${list.json?.sessions?.length}`);
  const own = list.json?.sessions?.find((x) => x.id === session.id);
  if (own) {
    check(nonEmptyStr(own.title), 'SessionSummary.title 非空', JSON.stringify(own.title));
    check(typeof own.createdAt === 'string' && !Number.isNaN(Date.parse(own.createdAt)), 'SessionSummary.createdAt 是 ISO 时间', JSON.stringify(own.createdAt));
  }
  const one = await api('GET', `/api/sessions/${session.id}`);
  check(one.json?.id === session.id, 'GET /api/sessions/:id 能读回', one.text.slice(0, 120));

  if (!KEEP_DATA) {
    const del = await httpReq('DELETE', `/api/sessions/${session.id}`);
    check(del.status === 200 && del.json?.ok === true, 'DELETE → {ok:true}', `status=${del.status}`);
    const gone = await httpReq('GET', `/api/sessions/${session.id}`);
    check(gone.status === 404, 'DELETE 后 GET 该 id → 404', `status=${gone.status}`);
    const list2 = await api('GET', '/api/sessions');
    check(Array.isArray(list2.json?.sessions) && !list2.json.sessions.some((x) => x.id === session.id), 'DELETE 后列表不含该会话');
  }
}

// ================================================================ main
async function main() {
  const tStart = Date.now();
  log('='.repeat(74));
  log(`api-e2e — 真实端到端 (${BASE})`);
  log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  log(`场景: ${ONLY.join(',')}  keepServer=${KEEP_SERVER} keepData=${KEEP_DATA}`);
  log('='.repeat(74));

  await step('0. 环境预检 / 启动服务', async (s) => {
    check(existsSync(SERVER_ENTRY), `存在 ${SERVER_ENTRY.replace(ROOT + '\\', '')}`, existsSync(SERVER_ENTRY) ? '' : '服务端尚未交付');
    if (!existsSync(SERVER_ENTRY)) {
      const h = await healthUp();
      if (!h.up) { fatal.push('服务端文件不存在且 8848 未监听'); return; }
    }
    const health = await ensureServer();
    const h = health.json || {};
    check(h.ok === true, 'GET /api/health → {ok:true}', health.text.slice(0, 200));
    check(h.hasKey === true, 'health.hasKey === true（真实 DeepSeek Key 已配置）', JSON.stringify(h.hasKey));
    if (h.model !== undefined) check(h.model === 'deepseek-flash', 'health.model === "deepseek-flash"', JSON.stringify(h.model));
    if (h.aiReady === false) {
      AI_READY = false;
      fatal.push('aiReady=false：AI 层（prompts/rules）未就绪，POST /api/analyze 返回 503');
    }
    note(`health=${JSON.stringify(h)}`);
    evidence.health = h;
  });

  const blocked = fatal.length > 0;
  let img;
  await step('1. 准备测试图片（真实照片 → dataURL）', async (s) => {
    img = loadImage();
    check(img.width > 0 && img.height > 0, `img2_annotate.jpg 解析成功 ${img.width}×${img.height}`, `${img.width}×${img.height}`);
    check(img.buf.length > 10000, '图片文件 >10KB', `${img.buf.length}B`);
    note(`file=${IMG_PATH.replace(ROOT + '\\', '')} ${img.width}×${img.height} ${(img.buf.length / 1024).toFixed(0)}KB dataUrl=${(img.dataUrl.length / 1024).toFixed(0)}KB`);
  });

  if (img && blocked) {
    // AI 阶段被依赖阻塞：先把不依赖 AI 的 CRUD/图片链路跑完，留下可用证据
    await step('C. CRUD 基础链路（AI 层未就绪时的最小验证）', (s) => scenarioCRUD(s, img));
  } else if (img) {
    if (ONLY.includes('A')) await step('A. 正常流程：上传 → quality → l0 → measure → plan → 列表/删除', (s) => scenarioA(s, img));
    if (ONLY.includes('B')) await step('B. 缺失尺寸流程：measure 全部跳过 → plan（verdict 必须降级）', (s) => scenarioB(s, img));
  }

  finish(tStart, blocked);
}

function finish(tStart, blocked = false) {
  const totalMs = Date.now() - tStart;
  const failed = steps.filter((s) => !s.ok);
  const passed = steps.filter((s) => s.ok);

  log('');
  log('='.repeat(74));
  log('阶段耗时汇总');
  for (const s of steps) log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${(s.ms / 1000).toFixed(1).padStart(7)}s  ${s.name}`);
  log(`  合计 ${(totalMs / 1000).toFixed(1)}s`);
  const apiish = steps.filter((s) => /quality|l0|measure|plan/.test(s.name));
  if (apiish.length) log(`  其中 AI 阶段（含场景 B）共 ${(apiish.reduce((a, b) => a + b.ms, 0) / 1000).toFixed(1)}s`);
  const metas = Object.entries(evidence.sessions).filter(([k]) => k.includes('_meta'));
  const repairedList = metas.filter(([, m]) => m && m.repaired === true);
  if (metas.length) log(`  JSON 自修复(repaired): ${repairedList.length}/${metas.length}${repairedList.length ? ' ← ' + repairedList.map(([k]) => k).join(',') : '（无）'}`);
  log('='.repeat(74));

  evidence.finishedAt = new Date().toISOString();
  evidence.totalMs = totalMs;
  evidence.serverLogsTail = serverLogs.slice(-60);
  const out = join(SCRATCH, `qa-e2e-${RUN_ID}.json`);
  try { writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8'); log(`证据: ${out.replace(ROOT + '\\', '')}`); } catch (e) { log('写证据失败: ' + e.message); }

  log('');
  if (blocked) {
    log('RESULT: BLOCKED  (AI 层未就绪，仅完成前置链路验证；不是测试脚本故障)');
    if (fatal.length) log('  BLOCKED 原因: ' + fatal.join(' ; '));
    const crudFail = failed.filter((s) => /CRUD/.test(s.name));
    log(`  非 AI 链路: ${crudFail.length === 0 ? 'PASS' : 'FAIL'}`);
    log('  等 ai-engine 的 prompts.mjs/rules.mjs 落地、health.aiReady=true 后重跑: node tests/api-e2e.mjs');
    stopServer();
    process.exit(3);
  } else if (failed.length === 0 && fatal.length === 0) {
    log(`RESULT: PASS  (${passed.length}/${steps.length} 阶段通过, ${(totalMs / 1000).toFixed(1)}s)`);
    stopServer();
    process.exit(0);
  } else {
    log(`RESULT: FAIL  (${failed.length} 阶段失败 / ${steps.length})`);
    for (const f of failed) {
      log(`  ✗ ${f.name}`);
      for (const i of f.issues.slice(0, 6)) log(`      - ${i.msg}${i.detail ? ' — ' + i.detail : ''}`);
      if (f.issues.length > 6) log(`      … 另有 ${f.issues.length - 6} 条，见证据 JSON`);
    }
    if (fatal.length) log('  FATAL: ' + fatal.join(' ; '));
    log('复现: node tests/api-e2e.mjs');
    stopServer();
    process.exit(1);
  }
}

process.on('SIGINT', () => { stopServer(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); stopServer(); process.exit(1); });

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  stopServer();
  process.exit(1);
});
