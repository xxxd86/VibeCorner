#!/usr/bin/env node
// tests/cdp-probe.mjs —— 在真实无头 Edge 里通过 CDP 执行诊断 JS（零依赖）
//
// 用途（独立验收）：
//   - 客观量化横向溢出：document.scrollWidth vs innerWidth，列出越界元素（比截图肉眼可靠）
//   - 抓取 console 错误 / 未捕获异常 / 资源加载失败（比 #dev-error-banner 更早发现问题）
//   - 读取 #app data-ready、#dev-error-banner、.feed-item/.card 渲染数量
//
// 用法:
//   node tests/cdp-probe.mjs --w=1440 --h=900
//   node tests/cdp-probe.mjs --w=390  --h=844 --url=http://127.0.0.1:8848/?demo=1
// 选项: --url= --w= --h= --wait=毫秒 --out=路径 --port=调试端口
// 退出码: 0 诊断完成（是否有问题看输出）/ 1 启动或连接失败
//
// 说明：Node 20 的 WebSocket 需要 --experimental-websocket，本脚本会自动用该 flag 重启自身。
//
// 重要：Edge/Chromium 无头模式有最小窗口宽度（约 500px），`--window-size=390,844` 实际
// innerWidth 会是 492 左右，用截图宽度裁切会造成「移动端破版」假象。
// 真移动端验收必须用 CDP Emulation.setDeviceMetricsOverride（本脚本 --mobile=1）。

import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Node 20 的 WebSocket 默认不启用；用带 --experimental-websocket 的 node 重启自身
const NEED_RELAUNCH = typeof WebSocket === 'undefined';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCRATCH = join(ROOT, '.scratch');
mkdirSync(SCRATCH, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const URL_TARGET = args.url || `http://127.0.0.1:${process.env.PORT || 8848}/?demo=1`;
const W = Number(args.w || 1440);
const H = Number(args.h || 900);
const WAIT_MS = Number(args.wait || 15000);
const PORT = Number(args.port || 9333);
const MOBILE = args.mobile === '1' || args.mobile === true;
const SHOT = args.shot ? (isAbsolute(String(args.shot)) ? String(args.shot) : resolve(ROOT, String(args.shot))) : null;
const WAIT_FOR = args['wait-for'] ? String(args['wait-for']) : null;
const WAIT_FOR_MS = Number(args['wait-for-ms'] || 90000);
const SCRIPT = args.script ? (isAbsolute(String(args.script)) ? String(args.script) : resolve(ROOT, String(args.script))) : null;
// 交互步骤脚本：数组 [{type:'waitFor'|'sleep'|'eval'|'click'|'shot'|'shotIf'|'waitForOptional', ...}]
const STEPS = args.steps ? (isAbsolute(String(args.steps)) ? String(args.steps) : resolve(ROOT, String(args.steps))) : null;
const SHOTS_DIR = args['shots-dir'] ? (isAbsolute(String(args['shots-dir'])) ? String(args['shots-dir']) : resolve(ROOT, String(args['shots-dir']))) : join(SCRATCH, 'qa-cdp-shots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const OUT = args.out || join(SCRATCH, `qa-cdp-${W}x${H}-${RUN_ID}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(path, port = PORT) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path, timeout: 3000 }, (r) => {
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { rej(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rej);
    req.end();
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString()); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    });
  }
  call(method, params = {}, timeout = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); reject(e); }
    });
  }
  on(fn) { this.handlers.push(fn); }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('WS 连接失败: ' + (e.message || ''))));
  });
}

// 诊断表达式：注入页面执行，返回 JSON 字符串
const DIAG_EXPR = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const de = document.documentElement, body = document.body;
  const banner = document.getElementById('dev-error-banner');
  const app = document.getElementById('app');
  const offenders = [];
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      const cs = getComputedStyle(el);
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 70),
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
        position: cs.position, overflowX: cs.overflowX,
      });
    }
  }
  offenders.sort((a, b) => b.right - a.right);
  const seen = new Set(); const uniq = [];
  for (const o of offenders) { const k = o.id || o.cls; if (seen.has(k)) continue; seen.add(k); uniq.push(o); if (uniq.length >= 25) break; }
  const sessionList = Array.from(document.querySelectorAll('#session-list > *')).slice(0, 10).map((el) => ({
    text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
    current: el.getAttribute('aria-current') || /(^|\\s)(is-active|active|is-current)(\\s|$)/.test(String(el.className || '')),
    title: el.getAttribute('title'),
  }));
  const scripts = [];
  for (const s of document.scripts) if (s.src) scripts.push(s.src.replace(location.origin, ''));
  return JSON.stringify({
    url: location.href, title: document.title,
    vw, vh, dpr: window.devicePixelRatio,
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    bodyScrollW: body ? body.scrollWidth : null,
    hasHorizontalScroll: de.scrollWidth > vw + 1,
    hasVerticalScroll: de.scrollHeight > vh + 1,
    ready: app ? app.getAttribute('data-ready') : null,
    bannerExists: Boolean(banner),
    bannerHidden: banner ? banner.hasAttribute('hidden') : null,
    bannerText: banner ? (banner.textContent || '').trim().slice(0, 500) : null,
    feedItems: document.querySelectorAll('.feed-item').length,
    cards: document.querySelectorAll('.card').length,
    chips: document.querySelectorAll('.chip').length,
    planTabs: document.querySelectorAll('.plan-tabs button').length,
    thinks: document.querySelectorAll('.think').length,
    stageChip: ((document.querySelector('#stage-chip') || {}).textContent || '').trim(),
    stageTitle: ((document.querySelector('#stage-title') || {}).textContent || '').trim(),
    sessionList,
    bodyTextLen: (body ? body.innerText : '').length,
    scripts,
    offenders: uniq,
  });
})()`;

async function main() {
  if (!existsSync(EDGE)) { console.error(`[FAIL] 找不到 Edge: ${EDGE}`); process.exit(1); }
  const profile = args.profile ? resolve(ROOT, String(args.profile)) : join(SCRATCH, `qa-cdp-profile-${PORT}-${Date.now()}`);
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${W},${H}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let pageWsUrl = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const list = await httpGet('/json/list');
      const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { pageWsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* not ready */ }
    await sleep(300);
  }
  if (!pageWsUrl) { console.error('[FAIL] 20s 内拿不到 CDP page target'); edge.kill(); process.exit(1); }

  const ws = await connect(pageWsUrl);
  const cdp = new CDP(ws);
  const consoleMsgs = [];
  const exceptions = [];
  const failedRequests = [];
  const reqUrls = new Map();
  let loaded = false;

  cdp.on((m) => {
    if (m.method === 'Page.loadEventFired') loaded = true;
    if (m.method === 'Network.requestWillBeSent') reqUrls.set(m.params.requestId, (m.params.request || {}).url || '');
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.type;
      if (t === 'error' || t === 'warning') {
        consoleMsgs.push({ level: t, text: (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400) });
      }
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push({ text: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception', url: d.url, line: d.lineNumber });
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry || {};
      if (e.level === 'error' || e.level === 'warning') consoleMsgs.push({ level: e.level, text: `[${e.source}] ${e.text}`, url: e.url });
    }
    if (m.method === 'Network.loadingFailed') failedRequests.push({ error: m.params.errorText, type: m.params.type, url: reqUrls.get(m.params.requestId) || m.params.requestId });
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response || {};
      if (r.status >= 400) failedRequests.push({ status: r.status, url: r.url, type: m.params.type });
    }
  });

  await cdp.call('Runtime.enable');
  await cdp.call('Log.enable');
  await cdp.call('Network.enable');
  await cdp.call('Page.enable');
  // 统一用 CDP 设备指标覆盖：桌面端也能拿到精确 1440×900 布局（无头窗口有边框/最小宽限制）
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: MOBILE, screenWidth: W, screenHeight: H,
  });
  await cdp.call('Page.navigate', { url: URL_TARGET });

  // 等待 loadEvent + 页面 ready（有 #app 时等 data-ready=1，最多 WAIT_MS）
  const t0 = Date.now();
  let readyVal = null;
  while (Date.now() - t0 < WAIT_MS) {
    await sleep(300);
    if (!loaded && Date.now() - t0 < 3000) continue;
    try {
      const r = await cdp.call('Runtime.evaluate', { expression: "document.getElementById('app') ? document.getElementById('app').getAttribute('data-ready') : 'no-app'", returnByValue: true }, 5000);
      readyVal = r.result?.value;
      if (readyVal === '1' || readyVal === 'no-app') break;
    } catch { /* mid-navigation */ }
  }
  await sleep(500); // 动画/布局稳定

  // 可选：等待页面进入某个状态（例如 ?demo=1 跑到 L1 交付包）
  let waitFor = null;
  if (WAIT_FOR) {
    const tW = Date.now();
    let hit = false;
    while (Date.now() - tW < WAIT_FOR_MS) {
      try {
        const r = await cdp.call('Runtime.evaluate', { expression: `Boolean(${WAIT_FOR})`, returnByValue: true }, 5000);
        if (r.result?.value === true) { hit = true; break; }
      } catch { /* 页面跳转中 */ }
      await sleep(500);
    }
    waitFor = { expr: WAIT_FOR, hit, ms: Date.now() - tW };
    if (hit) await sleep(700); // 让卡片入场动画结束
  }

  // ---- 交互步骤（V2：5 tabs / 依据 popover / L0 推荐 / 区间输入 等的截图与断言素材）
  const stepResults = [];
  async function evalExpr(expr, timeout = 15000) {
    const r = await cdp.call('Runtime.evaluate', { expression: String(expr), returnByValue: true, awaitPromise: true }, timeout);
    return r.result ? r.result.value : undefined;
  }
  async function captureShot(file) {
    mkdirSync(dirname(file), { recursive: true });
    // 先逼出一帧合成（无头模式下连续截图有时会拿到上一帧），再抓图
    try {
      await cdp.call('Runtime.evaluate', {
        expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))',
        awaitPromise: true, returnByValue: true,
      }, 5000);
      await sleep(60);
    } catch { /* 忽略 */ }
    const sh = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 25000);
    const buf = Buffer.from(sh.data, 'base64');
    writeFileSync(file, buf);
    return { file, bytes: buf.length };
  }
  if (STEPS) {
    let defs = [];
    try { defs = JSON.parse(readFileSync(STEPS, 'utf8')); } catch (e) { defs = []; console.error('steps 解析失败: ' + e.message); }
    for (const [idx, st] of defs.entries()) {
      const res = { i: idx, type: st.type, name: st.name || null, ok: true, detail: null };
      const t = Date.now();
      try {
        if (st.type === 'sleep') {
          await sleep(Number(st.ms) || 300);
        } else if (st.type === 'eval') {
          const v = await evalExpr(st.expr, st.timeout || 20000);
          res.value = typeof v === 'string' ? v.slice(0, 3000) : v;
        } else if (st.type === 'click') {
          const v = await evalExpr(`(() => { const el = document.querySelector(${JSON.stringify(st.sel)}); if (!el) return { ok: false, err: 'not found: ${String(st.sel).replace(/'/g, '')}' }; el.click(); return { ok: true, text: (el.textContent || '').trim().slice(0, 40) }; })()`);
          res.value = v; res.ok = !!(v && v.ok);
          if (!res.ok) res.detail = v && v.err;
        } else if (st.type === 'clickText') {
          const v = await evalExpr(`(() => { const sel = ${JSON.stringify(st.sel || 'button')}; const el = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').includes(${JSON.stringify(st.text)})); if (!el) return { ok: false, err: 'text not found' }; el.click(); return { ok: true }; })()`);
          res.value = v; res.ok = !!(v && v.ok);
          if (!res.ok) res.detail = v && v.err;
        } else if (st.type === 'waitFor' || st.type === 'waitForOptional') {
          const deadline = Date.now() + (Number(st.timeoutMs) || 60000);
          let hit = false;
          while (Date.now() < deadline) {
            try {
              if (await evalExpr(`Boolean(${st.expr})`, 5000)) { hit = true; break; }
            } catch { /* 页面刷新中 */ }
            await sleep(Number(st.pollMs) || 150);
          }
          res.hit = hit; res.ok = hit || st.type === 'waitForOptional';
          if (!hit && st.type === 'waitFor') res.detail = 'waitFor 超时: ' + st.expr;
        } else if (st.type === 'navigate') {
          await cdp.call('Page.navigate', { url: st.url });
          await sleep(900);
          const deadline = Date.now() + (Number(st.timeoutMs) || 45000);
          while (Date.now() < deadline) {
            try {
              const v = await evalExpr("document.getElementById('app') ? document.getElementById('app').getAttribute('data-ready') : 'no-app'", 3000);
              if (v === '1' || v === 'no-app') break;
            } catch { /* 导航中 */ }
            await sleep(200);
          }
          res.value = { url: st.url };
        } else if (st.type === 'shot' || st.type === 'shotIf') {
          let should = true;
          if (st.type === 'shotIf') {
            try { should = !!(await evalExpr(`Boolean(${st.expr})`, 5000)); } catch { should = false; }
          }
          if (should) {
            let fname = st.name ? String(st.name) : `step-${idx}`;
            if (!/\.png$/i.test(fname)) fname += '.png';
            const shot = await captureShot(join(SHOTS_DIR, fname));
            res.shot = { file: shot.file.replace(ROOT + '\\', ''), bytes: shot.bytes };
          } else {
            res.skipped = true;
          }
        } else {
          res.ok = false; res.detail = '未知 step 类型: ' + st.type;
        }
      } catch (e) {
        res.ok = false; res.detail = String((e && e.message) || e);
      }
      res.ms = Date.now() - t;
      stepResults.push(res);
      if (!res.ok) console.error(`  [step ${idx} ${res.type}${res.name ? ' ' + res.name : ''}] 失败: ${res.detail}`);
    }
  }

  const ev = await cdp.call('Runtime.evaluate', { expression: DIAG_EXPR, returnByValue: true }, 10000);
  let diag = null;
  try { diag = JSON.parse(ev.result?.value); } catch (e) { diag = { parseError: String(e), raw: String(ev.result?.value).slice(0, 500) }; }

  // 通过 CDP 截图（移动端仿真下才是真实 390 宽布局）
  let shotFile = null;
  let shotBytes = 0;
  if (SHOT) {
    mkdirSync(dirname(SHOT), { recursive: true });
    const sh = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 25000);
    const buf = Buffer.from(sh.data, 'base64');
    writeFileSync(SHOT, buf);
    shotFile = SHOT; shotBytes = buf.length;
  }

  // 可选：页面内交互脚本（例如验证导出 PNG / 画布点选追问）。脚本应返回 JSON 字符串。
  let customScript = null;
  if (SCRIPT) {
    try {
      const code = readFileSync(SCRIPT, 'utf8');
      const r = await cdp.call('Runtime.evaluate', { expression: `(async () => {${code}\n})()`, awaitPromise: true, returnByValue: true }, 120000);
      let val = r.result?.value;
      if (typeof val === 'string') { try { val = JSON.parse(val); } catch { /* 保留字符串 */ } }
      customScript = { file: SCRIPT.replace(ROOT + '\\', ''), result: val, error: null };
    } catch (e) {
      customScript = { file: SCRIPT.replace(ROOT + '\\', ''), result: null, error: String(e && e.message || e) };
    }
  }

  const out = {
    runId: RUN_ID, target: URL_TARGET, viewport: { width: W, height: H }, mobileEmulation: MOBILE, waitMs: WAIT_MS,
    elapsedMs: Date.now() - t0, ready: readyVal, diag, waitFor, shot: shotFile ? { file: shotFile, bytes: shotBytes } : null,
    customScript, steps: stepResults,
    consoleErrors: consoleMsgs.slice(0, 40),
    exceptions: exceptions.slice(0, 20),
    failedRequests: failedRequests.slice(0, 30),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

  // ---- 打印摘要
  console.log('='.repeat(74));
  console.log(`cdp-probe ${W}×${H}  ${URL_TARGET}`);
  console.log('='.repeat(74));
  if (diag && diag.vw) {
    console.log(`视口 innerWidth=${diag.vw}  innerHeight=${diag.vh}  dpr=${diag.dpr}`);
    console.log(`scrollWidth=${diag.docScrollW} (client=${diag.docClientW})  → 横向滚动: ${diag.hasHorizontalScroll ? '有 ⚠' : '无'}`);
    console.log(`纵向滚动: ${diag.hasVerticalScroll ? '有' : '无'}   #app data-ready=${diag.ready}`);
    console.log(`#dev-error-banner: exists=${diag.bannerExists} hidden=${diag.bannerHidden} text="${diag.bannerText || ''}"`);
    console.log(`渲染: .feed-item=${diag.feedItems} .card=${diag.cards} .chip=${diag.chips} .planTabs=${diag.planTabs} .think=${diag.thinks} bodyText=${diag.bodyTextLen} chars`);
    console.log(`stage: chip="${diag.stageChip}" title="${diag.stageTitle}"`);
    if (Array.isArray(diag.sessionList) && diag.sessionList.length) {
      console.log(`会话列表 ${diag.sessionList.length} 条（第一条 current=${diag.sessionList[0].current}）：`);
      for (const s of diag.sessionList.slice(0, 5)) console.log(`  ${s.current ? '▶' : ' '} "${s.text}"`);
    }
    console.log(`scripts: ${(diag.scripts || []).join(', ') || '(无外链)'}`);
    if (diag.offenders && diag.offenders.length) {
      console.log(`越界元素 ${diag.offenders.length} 个（right > vw+1 或 left < -1）：`);
      for (const o of diag.offenders) {
        console.log(`  <${o.tag}${o.id ? '#' + o.id : ''}${o.cls ? '.' + o.cls.split(/\s+/).join('.') : ''}> left=${o.left} right=${o.right} w=${o.width} pos=${o.position}`);
      }
    } else {
      console.log('越界元素: 无');
    }
  } else {
    console.log('诊断表达式执行失败:', JSON.stringify(diag).slice(0, 600));
  }
  if (exceptions.length) {
    console.log(`未捕获异常 ${exceptions.length} 条：`);
    for (const e of exceptions.slice(0, 8)) console.log(`  ✗ ${String(e.text).slice(0, 300)}`);
  }
  const consoleErrOnly = consoleMsgs.filter((m) => m.level === 'error');
  if (consoleErrOnly.length) {
    console.log(`console.error ${consoleErrOnly.length} 条：`);
    for (const m of consoleErrOnly.slice(0, 10)) console.log(`  ✗ ${m.text}`);
  } else {
    console.log('console.error: 无');
  }
  const badReqs = failedRequests.filter((r) => r.status >= 400 || r.error);
  if (badReqs.length) {
    console.log(`失败请求 ${badReqs.length} 条：`);
    for (const r of badReqs.slice(0, 10)) console.log(`  ✗ ${r.status ? r.status + ' ' : ''}${r.error || ''} ${r.url || r.type || ''}`.trim());
  }
  if (shotFile) console.log(`截图: ${shotFile.replace(ROOT + '\\', '')} (${(shotBytes / 1024).toFixed(1)}KB, ${diag?.vw}×${diag?.vh} 布局)`);
  if (stepResults.length) {
    const shots = stepResults.filter((r) => r.shot);
    const bad = stepResults.filter((r) => !r.ok);
    console.log(`steps: ${stepResults.length} 步，截图 ${shots.length} 张，失败 ${bad.length} 步（${(stepResults.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s）`);
    for (const r of shots) console.log(`  shot ${r.name || r.i}: ${r.shot.file} (${(r.shot.bytes / 1024).toFixed(1)}KB)`);
    for (const r of bad) console.log(`  ✗ step ${r.i} ${r.type}${r.name ? ' ' + r.name : ''}: ${r.detail}`);
  }
  if (waitFor) console.log(`wait-for: ${waitFor.hit ? '已达成' : '未达成(超时)'} (${(waitFor.ms / 1000).toFixed(1)}s)`);
  if (customScript) {
    if (customScript.error) console.log(`页面脚本失败: ${customScript.error}`);
    else console.log(`页面脚本结果: ${JSON.stringify(customScript.result).slice(0, 1200)}`);
  }
  console.log(`证据: ${OUT.replace(ROOT + '\\', '')}`);

  try { edge.kill(); } catch { /* noop */ }
  process.exit(0);
}

if (NEED_RELAUNCH) {
  const child = spawn(process.execPath, ['--experimental-websocket', ...process.argv.slice(1)], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  main().catch((e) => { console.error('FATAL:', e && e.stack ? e.stack : e); process.exit(1); });
}
