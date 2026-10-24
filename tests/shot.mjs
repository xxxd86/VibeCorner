#!/usr/bin/env node
// tests/shot.mjs —— 独立验收：无头 Edge 真实截图 + 真移动端仿真 + 客观布局诊断
//
// 为什么不用 `msedge --window-size=390,844 --screenshot` 出移动图：
//   Chromium 无头窗口有最小宽度（约 500px），390 宽的 --screenshot 实际是 492 宽的布局
//   被裁掉右边，会制造「破版」假象。真移动端必须用 CDP
//   Emulation.setDeviceMetricsOverride（本脚本委托 tests/cdp-probe.mjs 完成）。
//
// 产物:
//   tests/screens/desktop-1440.png   1440×900 真实布局（?demo=1 跑到 L1 交付包）
//   tests/screens/mobile-390.png     390×844 真移动仿真（?demo=1 跑到 L1 交付包）
//   .scratch/qa-shot-<run>.json      证据（含 console 错误 / 越界元素 / 失败请求）
//   .scratch/qa-cdp-*.json           cdp-probe 原始诊断
//
// 用法: node tests/shot.mjs
// 退出码: 0 通过 / 1 有失败 / 2 前置条件缺失（Edge / 服务端）

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8848);
const BASE = `http://${HOST}:${PORT}`;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PROBE = join(ROOT, 'tests', 'cdp-probe.mjs');
const SERVER_ENTRY = join(ROOT, 'app', 'server', 'index.mjs');
const SCREENS = join(ROOT, 'tests', 'screens');
const SCRATCH = join(ROOT, '.scratch');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

mkdirSync(SCREENS, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

// ?demo=1 会真实跑 上传→质检→L0→测量→解锁→L1；等到 L1 卡片出现 / 出错红条 / 超时
const DEMO_WAIT = "(document.querySelectorAll('.card-plan').length > 0) || ((document.querySelector('#stage-chip')||{}).textContent||'').includes('L1') || ((document.getElementById('dev-error-banner')||{}).textContent||'').trim().length > 0";
const DEMO_TIMEOUT_MS = Number(process.env.QA_DEMO_TIMEOUT || 120000);

const checks = [];
const shots = [];
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(ok, msg, detail) {
  checks.push({ ok: !!ok, msg, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}${detail !== undefined ? ' — ' + detail : ''}`);
}
function warn(msg) {
  checks.push({ ok: true, warn: true, msg });
  console.log('  [WARN] ' + msg);
}

function httpReq(method, path, timeout = 8000) {
  return new Promise((res, rej) => {
    const req = http.request({ host: HOST, port: PORT, method, path, timeout }, (r) => {
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { const b = Buffer.concat(c); res({ status: r.statusCode, headers: r.headers, text: b.toString('utf8'), bytes: b.length }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rej); req.end();
  });
}
async function healthUp() {
  try { const r = await httpReq('GET', '/api/health', 1500); return r.status === 200; } catch { return false; }
}

let child = null, spawned = false;
async function ensureServer() {
  if (await healthUp()) { console.log(`[server] ${BASE} 已在监听，复用`); return; }
  if (!existsSync(SERVER_ENTRY)) { console.error(`[FAIL] 服务端未运行且缺少 ${SERVER_ENTRY}`); process.exit(2); }
  console.log('[server] 8848 未监听 → spawn node app/server/index.mjs');
  child = spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned = true;
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await healthUp()) return; await sleep(400); }
  console.error('[FAIL] 30s 内 /api/health 未就绪');
  process.exit(2);
}
function stopServer() { if (spawned && child) { try { child.kill(); } catch { /* noop */ } } }

function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

function shootOne(view) {
  const shotAbs = join(ROOT, 'tests', 'screens', view.file);
  const outJson = join(SCRATCH, `qashot-${view.label}-${RUN_ID}.json`);
  const args = [
    CDP_PROBE,
    `--url=${BASE}/?demo=1`,
    `--w=${view.w}`, `--h=${view.h}`,
    `--mobile=${view.mobile ? '1' : '0'}`,
    `--shot=${shotAbs}`,
    `--out=${outJson}`,
    `--wait-for=${DEMO_WAIT}`,
    `--wait-for-ms=${DEMO_TIMEOUT_MS}`,
    `--port=${view.port}`,
  ];
  if (view.script) args.push(`--script=${view.script}`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: DEMO_TIMEOUT_MS + 90000, maxBuffer: 32 * 1024 * 1024 });
  const ms = Date.now() - t0;
  let cdp = null;
  try { cdp = JSON.parse(readFileSync(outJson, 'utf8')); } catch { /* noop */ }
  const record = { label: view.label, viewport: `${view.w}×${view.h}`, mobile: view.mobile, url: `${BASE}/?demo=1`, screenshot: `tests/screens/${view.file}`, ms, exitCode: res.status, cdpOut: outJson.replace(ROOT + '\\', ''), cdp };
  shots.push(record);
  console.log(`\n[${view.label}] 视口 ${view.w}×${view.h}${view.mobile ? '（CDP 移动仿真）' : ''} — ${(ms / 1000).toFixed(1)}s`);

  if (!existsSync(shotAbs)) { check(false, `${view.label} 截图生成`, `缺少 ${shotAbs}`); return record; }
  const st = statSync(shotAbs), dim = pngSize(shotAbs);
  check(st.size > 2000, `${view.label} 截图大小合理`, `${(st.size / 1024).toFixed(1)}KB`);
  if (dim) check(dim.width === view.w && dim.height === view.h, `${view.label} 截图尺寸 = ${view.w}×${view.h}`, `${dim.width}×${dim.height}`);
  if (st.size < 15000) warn(`${view.label} 截图偏小 ${(st.size / 1024).toFixed(1)}KB，可能接近空白页`);

  if (!cdp) { check(false, `${view.label} cdp-probe 诊断输出`, `未生成 ${outJson}；stderr=${(res.stderr || '').slice(0, 300)}`); return record; }
  const d = cdp.diag || {};
  check(d.vw === view.w && d.vh === view.h, `${view.label} 真实布局视口 = ${view.w}×${view.h}`, `innerWidth=${d.vw} innerHeight=${d.vh}`);
  check(d.hasHorizontalScroll === false, `${view.label} 无横向滚动`, `scrollWidth=${d.docScrollW} vs innerWidth=${d.vw}`);
  check(cdp.ready === '1', `${view.label} #app data-ready=1（app.js 初始化完成）`, `ready=${cdp.ready}`);
  check(d.bannerHidden === true, `${view.label} #dev-error-banner 无内容（无 JS 报错红条）`, d.bannerText ? `红条: ${String(d.bannerText).slice(0, 300)}` : '');
  check((cdp.exceptions || []).length === 0, `${view.label} 无未捕获异常`, JSON.stringify((cdp.exceptions || []).slice(0, 3)));
  const consoleErrors = (cdp.consoleErrors || []).filter((m) => m.level === 'error');
  check(consoleErrors.length === 0, `${view.label} 无 console.error`, consoleErrors.slice(0, 3).map((m) => m.text).join(' | '));
  const allFailed = cdp.failedRequests || [];
  const benign = allFailed.filter((r) => r.error === 'net::ERR_ABORTED' && r.type === 'Fetch');
  const badReqs = allFailed.filter((r) => !benign.includes(r) && ((r.status && r.status >= 400) || r.error));
  if (benign.length) console.log(`  [info] ${benign.length} 条 SSE Fetch 在 final 后被前端主动 abort（预期行为）`);
  if (badReqs.length) warn(`${view.label} 有失败请求: ${badReqs.slice(0, 5).map((r) => `${r.status || ''} ${r.url || r.type || ''}`.trim()).join(' | ')}`);
  if (d.offenders && d.offenders.length) warn(`${view.label} 有元素超出视口（body overflow 可能裁切）: ${d.offenders.slice(0, 5).map((o) => `<${o.tag}${o.id ? '#' + o.id : ''}>right=${o.right}`).join(' | ')}`);
  if (cdp.waitFor && cdp.waitFor.hit === false) warn(`${view.label} ?demo=1 在 ${(DEMO_TIMEOUT_MS / 1000).toFixed(0)}s 内未到 L1（可能 AI 慢或流程中断，截图仍是有效现场）`);
  else console.log(`  [info] ?demo=1 已到 L1 交付包（${((cdp.waitFor?.ms || 0) / 1000).toFixed(1)}s），stage chip="${d.stageChip}"，计划卡 ${d.cards} 张`);
  console.log(`  [info] 渲染: feed-item=${d.feedItems} card=${d.cards} chip=${d.chips} planTabs=${d.planTabs} bodyText=${d.bodyTextLen}`);
  if (Array.isArray(d.sessionList)) console.log(`  [info] 会话列表 ${d.sessionList.length} 条，当前项=${d.sessionList.find((s) => s.current)?.text || '(未标记)'}`);

  // DoD 1/2 交互验证（导出 PNG / 画布点选追问）
  if (view.script) {
    const cs = cdp.customScript;
    check(!!cs && !cs.error, `${view.label} 页面交互脚本执行`, cs?.error || '');
    const r = cs && cs.result;
    if (r) {
      check(r.hasCorner === true, 'window.__corner 调试出口存在');
      check(r.export?.isDataUrl === true, 'DoD1: canvas.exportPNG() 返回合法 data:image/png', JSON.stringify(r.export));
      check((r.export?.approxBytes || 0) > 5000, 'DoD1: 导出 PNG 体积 >5KB', `${Math.round((r.export?.approxBytes || 0) / 1024)}KB`);
      check(Number(r.export?.png?.width) > 0 && Number(r.export?.png?.height) > 0, 'DoD1: 导出 PNG 可解析出宽高', JSON.stringify(r.export?.png));
      if (r.export?.png?.width) console.log(`  [info] 导出 PNG 尺寸: ${r.export.png.width}×${r.export.png.height}（${Math.round((r.export.approxBytes || 0) / 1024 / 1024 * 10) / 10}MB）`);
      check(Array.isArray(r.downloads) && r.downloads.length >= 1, 'DoD1: 点击导出按钮触发 download', JSON.stringify(r.downloads));
      if (r.exportBtn && r.exportBtn.disabled === true) warn('DoD1: #btn-export 仍禁用（可能是解锁时序）');
      check(r.afterPick?.changed === true, 'DoD2: 画布点选后得到 AI 追问（feed/card 增加）', JSON.stringify(r.afterPick));
      check(!r.afterPick?.banner, 'DoD2: 点选过程无 JS 报错', r.afterPick?.banner || '');
      if (r.afterPick?.lastText) console.log(`  [info] 点选后最后一条: ${r.afterPick.lastText.slice(0, 120)}`);
    } else {
      check(false, `${view.label} 页面交互脚本返回结果`, JSON.stringify(cs).slice(0, 300));
    }
  }
  return record;
}

async function main() {
  console.log('='.repeat(74));
  console.log(`shot — 无头 Edge 截图 + 真移动仿真 (${BASE}/?demo=1)`);
  console.log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  console.log('='.repeat(74));

  if (!existsSync(EDGE)) { console.error(`[FAIL] 找不到 Edge: ${EDGE}`); process.exit(2); }
  if (!existsSync(CDP_PROBE)) { console.error(`[FAIL] 缺少 ${CDP_PROBE}`); process.exit(2); }
  check(true, 'Edge 可执行文件存在', EDGE);
  await ensureServer();
  check(await healthUp(), '/api/health 可访问');

  try {
    const page = await httpReq('GET', '/', 15000);
    check(page.status === 200, 'GET / 返回 200', `status=${page.status}`);
    check(/id\s*=\s*["']app["']/.test(page.text), 'GET / 返回真实首页（含 #app）', `${page.bytes}B`);
  } catch (e) { check(false, 'GET / 失败', e.message); }

  shootOne({ label: 'desktop-1440', w: 1440, h: 900, mobile: false, port: 9333, file: 'desktop-1440.png', script: join(ROOT, 'tests', 'page-checks.js') });
  shootOne({ label: 'mobile-390', w: 390, h: 844, mobile: true, port: 9334, file: 'mobile-390.png' });

  const evidence = { runId: RUN_ID, base: BASE, demoWait: DEMO_WAIT, shots, checks };
  const out = join(SCRATCH, `qa-shot-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`\n证据: ${out.replace(ROOT + '\\', '')}`);

  console.log('');
  console.log('-'.repeat(74));
  if (failed === 0) {
    console.log(`RESULT: PASS  (${checks.length} checks, ${shots.length} 张截图)`);
    for (const s of shots) console.log(`  ${s.label}: ${s.screenshot} (${s.viewport})`);
    console.log('下一步（人工视觉验收）: read_image 打开 tests/screens/*.png 检查破版/截断/红条/卡片。');
    stopServer();
    process.exit(0);
  } else {
    console.log(`RESULT: FAIL  (${failed} 项失败)`);
    console.log('复现: node tests/shot.mjs');
    stopServer();
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e && e.stack ? e.stack : e); stopServer(); process.exit(1); });
