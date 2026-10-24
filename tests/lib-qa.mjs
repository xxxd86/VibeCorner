// tests/lib-qa.mjs —— V2 验收脚本共享工具（零依赖，只用 node:*）
// 供 tests/api-e2e-v2.mjs 使用；V1 的 tests/api-e2e.mjs 保持原样（回归不能被改动）。

import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT || 8848);
export const BASE = `http://${HOST}:${PORT}`;
export const SERVER_ENTRY = join(ROOT, 'app', 'server', 'index.mjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ HTTP */
export function httpReq(method, path, { body, timeout = 30000, headers = {}, host = HOST, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined || body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (raw) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = String(raw.length); }
    // agent:false 禁用 keep-alive 连接池：Node 19+ 默认复用 socket，
    // 服务端在响应后关闭的旧连接会导致下一次请求 ECONNRESET（测试环境已踩到）。
    const req = http.request({ host, port, method, path, headers: h, timeout, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, bytes: buf.length, buffer: buf });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP 超时 ${timeout}ms: ${method} ${path}`)));
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

export async function api(method, path, body, opts = {}) {
  const r = await httpReq(method, path, { body, ...opts });
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} → HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  return r;
}

/* ------------------------------------------------------------------ SSE */
function splitSSEBlock(block, events) {
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try { events.push(JSON.parse(payload)); } catch { events.push({ __parseError: payload.slice(0, 200) }); }
  }
}

export function postSSE(path, body, { timeout = 200000 } = {}) {
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
    let hardTimer = null;

    const finish = (reason) => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try { req.destroy(); } catch { /* noop */ }
      resolve({
        reason, events, final: finalEv ? finalEv.payload : null, finalEvent: finalEv,
        session: finalEv ? finalEv.session : null, meta: finalEv ? finalEv.meta : null,
        errorEvent: errorEv, ttfbMs, ms: Date.now() - t0, bytes: Buffer.byteLength(buf),
      });
    };

    const req = http.request({
      host: HOST, port: PORT, method: 'POST', path, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(raw.length), accept: 'text/event-stream' },
    }, (res) => {
      ttfbMs = Date.now() - t0;
      if (res.statusCode !== 200) {
        let txt = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { txt += c; });
        res.on('end', () => { if (!done) { done = true; clearTimeout(hardTimer); reject(new Error(`POST ${path} → HTTP ${res.statusCode}: ${txt.slice(0, 400)}`)); } });
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
            if (ev.type === 'final' && !finalEv) { finalEv = ev; graceTimer = setTimeout(() => finish('final-grace'), 2500); }
            else if (ev.type === 'error' && !errorEv) { errorEv = ev; graceTimer = setTimeout(() => finish('error'), 300); }
          }
        }
      });
      res.on('end', () => finish('end'));
      res.on('error', (e) => { if (!done) { done = true; clearTimeout(hardTimer); reject(e); } });
    });

    hardTimer = setTimeout(() => { if (!done) { done = true; reject(new Error(`SSE 超时 ${timeout}ms（events=${events.length}, final=${finalEv ? '有' : '无'}）`)); } }, timeout);
    req.on('error', (e) => { if (!done) { done = true; clearTimeout(hardTimer); reject(e); } });
    req.write(raw);
    req.end();
  });
}

export async function analyze(sessionId, stage, payload, timeout) {
  const r = await postSSE('/api/analyze', { sessionId, stage, payload }, { timeout });
  if (r.errorEvent) throw new Error(`SSE error 事件（stage=${stage}): ${r.errorEvent.message || JSON.stringify(r.errorEvent)}`);
  if (!r.final) throw new Error(`SSE 没有 final（stage=${stage}，events=${r.events.length}）`);
  return r;
}

export async function analyzeFlexible(sessionId, stage, candidates, timeout) {
  let lastErr = null;
  for (const payload of candidates) {
    try { return await analyze(sessionId, stage, payload, timeout); }
    catch (e) {
      lastErr = e;
      if (/HTTP 4\d\d/.test(e.message)) continue;
      throw e;
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ 服务端生命周期 */
let child = null;
let spawned = false;

export async function healthUp() {
  try { const r = await httpReq('GET', '/api/health', { timeout: 1500 }); return { up: r.status === 200, res: r }; }
  catch { return { up: false, res: null }; }
}

export async function ensureServer() {
  const h = await healthUp();
  if (h.up) return h.res;
  if (!existsSync(SERVER_ENTRY)) throw new Error(`缺少 ${SERVER_ENTRY}`);
  child = spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned = true;
  let exitInfo = null;
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('exit', (code) => { exitInfo = { code }; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exitInfo) throw new Error(`server 提前退出 code=${exitInfo.code}`);
    if ((await healthUp()).up) return (await healthUp()).res;
    await sleep(400);
  }
  throw new Error('30s 内 /api/health 未就绪');
}

export function stopServer() {
  if (spawned && child) { try { child.kill(); } catch { /* noop */ } }
}

/* ------------------------------------------------------------------ 图片 */
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('不是 JPEG');
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
  throw new Error('未找到 SOF');
}

export function loadImage(imgPath) {
  if (!existsSync(imgPath)) throw new Error(`缺少测试图片 ${imgPath}`);
  const buf = readFileSync(imgPath);
  const { width, height } = jpegSize(buf);
  return {
    buf, width, height,
    dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'),
    // 前端真实计算指标；测试给中性值（不会触发本地拦截），与 V1 e2e 口径一致
    metrics: { brightness: 128, contrast: 52, sharpness: 180, width, height, bytes: buf.length },
  };
}

/* ------------------------------------------------------------------ 文本扫描 */
export const NEG = /(不|未|没|无|非|难)/;

export function walkStrings(obj, cb, p = '') {
  if (typeof obj === 'string') { cb(obj, p); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => walkStrings(v, cb, `${p}[${i}]`)); return; }
  if (obj && typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) walkStrings(v, cb, p ? `${p}.${k}` : k); }
}

/** 找词；allowNegated=true 时放行「不能保证/不可行」这类否定式 */
export function findBanned(text, words, allowNegated = true) {
  const hits = [];
  for (const w of words) {
    let from = 0;
    while (true) {
      const i = text.indexOf(w, from);
      if (i < 0) break;
      const prev = text.slice(Math.max(0, i - 2), i);
      if (!(allowNegated && NEG.test(prev))) hits.push({ word: w, snippet: text.slice(Math.max(0, i - 14), i + w.length + 14) });
      from = i + w.length;
    }
  }
  return hits;
}

export function bannedHitsIn(payload, words, rootName, allowNegated = true) {
  const out = [];
  walkStrings(payload, (s, p) => {
    for (const h of findBanned(s, words, allowNegated)) out.push({ path: `${rootName}.${p}`, ...h });
  });
  return out;
}

/* ------------------------------------------------------------------ 基础断言工具 */
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
export const isEnum = (v, list) => list.includes(v);
export const isNum01 = (v) => isNum(v) && v >= 0 && v <= 1;
export const validBbox = (b) => Array.isArray(b) && b.length === 4 && b.every(isNum01) && b[2] > 0.001 && b[3] > 0.001;
export const charLen = (s) => Array.from(String(s || '')).length;

/* ------------------------------------------------------------------ 证据目录语义对照（人工核对辅助） */
// 每个 basisId 的「语义关键词」：建议文案 / 证据 claim 至少各命中一个，防止「挂个引用装样子」。
export const BASIS_SEMANTIC_HINTS = {
  PASSAGE_WIDTH: { claim: [/窄|挤|绕|缝/], item: [/通道|窄|经验|观察|不判|保守/] },
  LITTER_BOX_SIZE: { claim: [/砂盆|转身|刨|憋/], item: [/砂盆|体长|转身|尺寸|cm/] },
  LITTER_BOX_COUNT: { claim: [/厕所|砂盆|排队|憋|沙发/], item: [/砂盆|数量|个|经验|不判/] },
  LITTER_NEAR_APPLIANCE: { claim: [/洗衣机|响|家电|上厕所/], item: [/家电|洗衣|冰箱|噪音|响/] },
  LITTER_NEAR_FOOD: { claim: [/吃饭|饭碗|食|角落/], item: [/食盆|吃饭|食物|水|吃/] },
  LITTER_BOX_ADJACENCY: { claim: [/盆|挨着|出口|大盆/], item: [/砂盆|并排|挨着|出口|分开/] },
  LITTER_SCOOP_FREQUENCY: { claim: [/尿块|脏|憋|砂/], item: [/铲|清理|每天|频次|砂盆|脏/] },
  LITTER_COVERED: { claim: [/盖|味|尿|进去/], item: [/盖|封闭|通风|味|砂盆/] },
  HIDING_PLACE_COUNT: { claim: [/躲|位置|两只猫|盯/], item: [/藏|躲|藏身|数量|处|多猫/] },
  HIDING_ENCLOSURE: { claim: [/三面|遮挡|口|缩|背后/], item: [/三面|遮挡|围|半包|封闭|藏/] },
  HIDING_BOX_EFFECT: { claim: [/箱子|躲|缓|星期|天/], item: [/藏|躲|半包|封闭|箱|适应/] },
  PERCH_SIZE: { claim: [/摊平|悬空|趴|身体/], item: [/平台|跳台|栖架|爬架|摊|伸展|尺寸/] },
  PERCH_CONCEALMENT: { claim: [/高|看到|透风|胆小|藏/], item: [/高|平台|遮挡|封闭|靠墙|藏/] },
  SCRATCH_POST_LOCATION: { claim: [/抓板|路过|伸懒腰|爪|动线/], item: [/抓板|抓挠|磨爪|动线|路过|沙发|位置/] },
  SCRATCH_POST_FORM: { claim: [/竖直|麻绳|拉长|气味|抓/], item: [/竖直|水平|瓦楞|麻绳|面|抓板/] },
  NEW_ITEM_SCENT: { claim: [/新窝|味|闻|爪子/], item: [/气味|味道|擦|洗|新/] },
  ACCLIMATION_WINDOW: { claim: [/几天|一周|绕着走|适应/], item: [/适应|天|周|时间/] },
  LITTER_RELOCATION: { claim: [/厕所|挪|认|慢慢/], item: [/砂盆|移|挪|位置|周|天/] },
  THERMAL_COMFORT: { claim: [/20|温度|冷|晒|地板/], item: [/温度|暖|冷|热|地板|垫/] },
  DRAFT_AND_FLOOR: { claim: [/地面|风口|凉|换地方/], item: [/风|穿堂|地面|地板|瓷砖|凉|冷/] },
  SUNLIGHT_POSITION: { claim: [/晒|太阳|温度|暖炕/], item: [/日照|阳光|太阳|晒|光/] },
  MULTICAT_SEPARATION: { claim: [/资源|猫|一处|水/], item: [/多猫|资源|分开|分隔|冲突/] },
  PLAY_SEQUENCE: { claim: [/追|玩具|抓|捕猎/], item: [/逗猫棒|玩|游戏|猎|捕/] },
  'EVIDENCE-GAP-NOUSE': { claim: [/研究|原因|排查|排名/], item: [/证据|不知道|没有|研究|排查/] },
  'REST-QUALITY': { claim: [/休息|躺卧|舒适|生活/], item: [/睡眠|休息|睡|舒适/] },
  'PLAY-DURATION-NO-EVIDENCE': { claim: [/陪玩|对照|时长|没有/], item: [/陪玩|时长|分钟|证据/] },
  REST_SIZE_STRETCH: { claim: [/伸展|休息|窝|宽松|出处/], item: [/边长|宽度|进深|尺寸|空间|窝|休息|≥|>=/] },
  'NA-RULE': { claim: [/不涉及|没发现问题|通过|绿/], item: [/不涉及|没有|这次|不做|nas?/i] },
  'SCRATCH-PLAY-PARADOX': { claim: [/抓|陪玩|不成立/], item: [/抓板|抓挠|陪玩|证据/] },
};

/** 语义自查：item 文案与 evidence claim 是否各命中至少一个预期关键词 */
export function semanticCheck(basisId, claim, itemText) {
  const hint = BASIS_SEMANTIC_HINTS[basisId];
  if (!hint) return { supported: null, note: '未配置语义关键词（人工核对）' };
  const claimOk = hint.claim.some((re) => re.test(claim || ''));
  const itemOk = hint.item.some((re) => re.test(itemText || ''));
  return {
    supported: claimOk && itemOk,
    claimOk,
    itemOk,
    note: `claim命中=${claimOk} 建议命中=${itemOk}`,
  };
}
