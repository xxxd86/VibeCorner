#!/usr/bin/env node
// tests/v4.2-notify.mjs —— V4.2 系统通知独立验收
//
// 覆盖 docs/CONTRACT-V4.2.md：
//   §1 三态按钮（默认 / 已开启 is-on / 不支持 disabled）；绝不自动 requestPermission
//   §2 后台 + 新回应/投票 → 构造 Notification（title/body/tag/icon）
//   §3 同一 eventId 去重；30s 节流（Date.now stub 验证）
//   §4 关闭开关后不再通知
//   §5 permission=denied / 无 Notification → 不支持且不抛错，toast/角标仍正常
//   getNotifyState() 返回 off / enabled / unsupported（denied 归 unsupported）
//
// 用法: node tests/v4.2-notify.mjs / 退出码 0 通过,1 失败

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, BASE, httpReq, api, analyzeFlexible, ensureServer, stopServer, healthUp,
  loadImage, nonEmptyStr,
} from './lib-qa.mjs';

const CDP = join(ROOT, 'tests', 'cdp-probe.mjs');
const THUMB = join(ROOT, 'tests', 'fixtures', 'share-thumb.jpg');
const IMG_OK = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img2_annotate.jpg');
const SCRATCH = join(ROOT, '.scratch');
const SCREENS = join(ROOT, 'docs', 'screens');
const SHARE_DIR = join(ROOT, 'app', 'data', 'shares');
const UPLOAD_DIR = join(ROOT, 'app', 'data', 'uploads');
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SCREENS, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);

const PROFILE = { goal: '想给猫找个睡觉的角落', budget: 300, cats: 1, catSize: 'medium', catAge: 'adult', multiCat: false, floorType: 'wood', climate: 'mild' };
const SAMPLE_CM = { corridorWidth: 62, cornerWidthA: 100, cornerWidthB: 80, freeDepth: 60, obstructionH: 75, ceilingFree: 120, outletDist: 90, doorSwing: 80, windowDist: 150 };
const thumbDataUrl = 'data:image/jpeg;base64,' + readFileSync(THUMB).toString('base64');

const checks = [];
let failed = 0;
function check(ok, msg, detail) {
  checks.push({ ok: !!ok, msg, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}${detail !== undefined ? ' — ' + detail : ''}`);
}
function warn(msg) { checks.push({ ok: true, warn: true, msg }); console.log('  [WARN] ' + msg); }

const INIT_SCRIPT = `(() => {
  window.__notifs = [];
  window.__permCalls = 0;
  window.__vis = 'visible';
  class FakeNotification {
    static permission = 'default';
    static requestPermission = async () => {
      window.__permCalls += 1;
      FakeNotification.permission = 'granted';
      return 'granted';
    };
    constructor(title, opts) {
      this.title = String(title || '');
      this.body = String((opts && opts.body) || '');
      this.tag = (opts && opts.tag) || '';
      this.icon = (opts && opts.icon) || '';
      this.onclick = null;
      this.close = () => {};
      window.__notifs.push(this);
    }
  }
  window.Notification = FakeNotification;
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => window.__vis !== 'visible', configurable: true });
  } catch (e) { /* ignore */ }
})();`;

async function getSession(id) { return (await api('GET', `/api/sessions/${id}`)).json; }
async function runToPlan(sessionId) {
  const img = loadImage(IMG_OK);
  await api('POST', `/api/sessions/${sessionId}/image`, { dataUrl: img.dataUrl, width: img.width, height: img.height, metrics: img.metrics }, { timeout: 60000 });
  let r = await analyzeFlexible(sessionId, 'quality', [{ metrics: img.metrics, profile: PROFILE }, {}]);
  r = await analyzeFlexible(sessionId, 'l0', [{ profile: PROFILE }, {}]);
  const l0 = r.final;
  const directionId = l0.recommend?.directionId || l0.directions?.[0]?.id;
  let payload = { directionId, profile: PROFILE };
  for (let round = 1; round <= 5; round++) {
    r = await analyzeFlexible(sessionId, 'measure', [payload, directionId ? { directionId } : {}]);
    const qs = r.final.questions || [];
    if (!qs.length) break;
    const answers = {};
    for (const q of qs) answers[q.key] = { valueCm: q.key === 'corridorWidth' ? 55 : SAMPLE_CM[q.key] ?? 80 };
    payload = { directionId, profile: PROFILE, answers };
  }
  r = await analyzeFlexible(sessionId, 'plan', [{ directionId, profile: PROFILE }, { profile: PROFILE }, {}]);
  return { plan: r.final };
}

async function sweep(sessionId) {
  try {
    const session = await getSession(sessionId);
    const uploads = [];
    if (session?.image?.imageId) uploads.push(session.image.imageId);
    if (session?.afterImage?.imageId) uploads.push(session.afterImage.imageId);
    if (session?.share?.token) {
      let sf = null;
      try { sf = JSON.parse(readFileSync(join(SHARE_DIR, `${session.share.token}.json`), 'utf8')); } catch { /* noop */ }
      if (sf?.photo?.imageId) uploads.push(sf.photo.imageId);
      for (const r of sf?.responds || []) if (r?.photo?.imageId) uploads.push(r.photo.imageId);
      try { unlinkSync(join(SHARE_DIR, `${session.share.token}.json`)); } catch { /* noop */ }
    }
    await api('DELETE', `/api/sessions/${sessionId}`);
    for (const id of uploads) {
      for (const ext of ['jpg', 'png', 'webp']) {
        const f = join(UPLOAD_DIR, `${id}.${ext}`);
        if (existsSync(f)) { try { unlinkSync(f); } catch { /* noop */ } }
      }
    }
  } catch { /* noop */ }
}

const runs = [];
function runCdp({ label, w, h, mobile, url, steps, port, initScript }) {
  const outJson = join(SCRATCH, `qa-v42-run-${label}-${RUN_ID}.json`);
  const stepsPath = join(SCRATCH, `qa-v42-steps-${label}-${RUN_ID}.json`);
  writeFileSync(stepsPath, JSON.stringify(steps, null, 2), 'utf8');
  console.log(`\n[${label}] ${w}×${h}${mobile ? '（CDP 移动仿真）' : ''} — ${url}`);
  const t0 = Date.now();
  const extra = initScript ? [`--init-script=${initScript}`] : [];
  const res = spawnSync(process.execPath, [
    CDP, `--url=${url}`, `--w=${w}`, `--h=${h}`, `--mobile=${mobile ? '1' : '0'}`,
    `--steps=${stepsPath}`, `--shots-dir=${SCREENS}`, `--out=${outJson}`, `--port=${port}`, ...extra,
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  let out = null;
  try { out = JSON.parse(readFileSync(outJson, 'utf8')); } catch { /* noop */ }
  runs.push({ label, ms, exit: res.status, outJson, out });
  console.log(`  [info] ${(ms / 1000).toFixed(1)}s，steps=${out?.steps?.length ?? 0}，截图=${(out?.steps || []).filter((s) => s.shot).length}`);
  if (!out) check(false, `${label} cdp-probe 输出`, (res.stderr || '').slice(0, 400));
  return { label, ms, out };
}
function get(out, name) {
  const st = (out?.steps || []).find((s) => s.name === name);
  if (!st) return null;
  let v = st.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep */ } }
  return v;
}
function validateCommon(out, label) {
  if (!out) return;
  const d = out.diag || {};
  check(d.hasHorizontalScroll === false, `${label} 无横向滚动`, `scrollWidth=${d.docScrollW} vs ${d.vw}`);
  check(d.bannerHidden === true && !String(d.bannerText || '').trim(), `${label} #dev-error-banner 空`, d.bannerText || '');
  check((out.exceptions || []).length === 0, `${label} 无未捕获异常`, JSON.stringify((out.exceptions || []).slice(0, 2)));
  const errs = (out.consoleErrors || []).filter((m) => m.level === 'error' && !/Failed to load resource/.test(m.text || ''));
  check(errs.length === 0, `${label} 无 JS console.error`, errs.slice(0, 3).map((m) => m.text).join(' | '));
  const bad = (out.steps || []).filter((s) => !s.ok);
  check(bad.length === 0, `${label} 所有交互步骤成功`, bad.map((s) => `${s.type}${s.name ? ':' + s.name : ''}=${s.detail}`).join(' | '));
}
function shotExists(out, name, label) {
  const st = (out?.steps || []).find((s) => s.shot && String(s.shot.file).includes(name));
  check(!!st, `${label} 截图存在 ${name}`, st?.shot?.file || 'missing');
  if (st?.shot?.file) {
    const f = join(ROOT, st.shot.file);
    check(existsSync(f) && statSync(f).size > 1024, `${label} 截图落盘 ${name}`, st.shot.file);
  }
}

const SHOT = (name) => ({ type: 'shot', name });
const WAIT = (expr, timeoutMs = 30000, pollMs = 120) => ({ type: 'waitFor', expr, timeoutMs, pollMs });
const EVAL = (name, expr) => ({ type: 'eval', name, expr });
const SLEEP = (ms) => ({ type: 'sleep', ms });

function toggleSnapshotExpr() {
  return `JSON.stringify((() => {
    const btn = document.querySelector('.card-handoff .notify-toggle');
    return {
      permCalls: window.__permCalls,
      notifCount: window.__notifs.length,
      notifs: window.__notifs.map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon })),
      toggleText: (btn?.textContent || '').trim(),
      disabled: !!btn?.disabled,
      isOn: !!btn?.classList.contains('is-on'),
      state: window.__corner.flow.getNotifyState ? window.__corner.flow.getNotifyState() : null,
      storage: localStorage.getItem('corner.notify'),
      vis: window.__vis
    };
  })())`;
}

function steps390() {
  return [
    WAIT("document.querySelector('.card-handoff .notify-toggle')", 60000),
    SLEEP(800),
    EVAL('initialNotify', toggleSnapshotExpr()),
    EVAL('scrollToggle', `(() => { const n = document.querySelector('.card-handoff .notify-toggle'); n?.scrollIntoView({ block: 'center' }); return 'ok'; })()`),
    SLEEP(300),
    SHOT('26-notify-toggle-390'),
    EVAL('toggleOn', `(async () => {
      document.querySelector('.card-handoff .notify-toggle')?.click();
      await new Promise((r) => setTimeout(r, 600));
      return ${toggleSnapshotExpr()};
    })()`),
    EVAL('hiddenAddPhoto', `(async () => {
      const token = '${token}';
      window.__vis = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'photo', consent: true, name: '妈妈', deviceId: 'd_v42_a', photoDataUrl: ${JSON.stringify(thumbDataUrl)} }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((r) => setTimeout(r, 900));
      const btn = document.querySelector('.card-handoff .notify-toggle');
      return JSON.stringify({
        notifCount: window.__notifs.length,
        notifs: window.__notifs.map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon })),
        chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(),
        toggleText: (btn?.textContent || '').trim(),
        state: window.__corner.flow.getNotifyState(),
        vis: window.__vis
      });
    })()`),
    EVAL('refreshAgainNoDuplicate', `(async () => {
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((r) => setTimeout(r, 500));
      return JSON.stringify({ notifCount: window.__notifs.length });
    })()`),
    EVAL('stubNow', `(() => { window.__qaRealNow = Date.now; window.__now = Date.now(); Date.now = () => window.__now; return String(window.__now); })()`),
    EVAL('throttledEvent', `(async () => {
      const token = '${token}';
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'measure', name: '室友', deviceId: 'd_v42_b' }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((r) => setTimeout(r, 600));
      return JSON.stringify({ notifCount: window.__notifs.length, now: window.__now });
    })()`),
    EVAL('after31sEvent', `(async () => {
      const token = '${token}';
      window.__now += 31000;
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'disagree', name: '爸爸', deviceId: 'd_v42_c' }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((r) => setTimeout(r, 800));
      return JSON.stringify({ notifCount: window.__notifs.length, notifs: window.__notifs.map((n) => ({ title: n.title, body: n.body, tag: n.tag })), now: window.__now });
    })()`),
    EVAL('clickNotification', `(async () => {
      const n = window.__notifs[0];
      if (n && typeof n.onclick === 'function') n.onclick();
      await new Promise((r) => setTimeout(r, 800));
      const card = document.querySelector('.card-votes');
      const rect = card ? card.getBoundingClientRect() : null;
      const sid = window.__corner.state.session?.id || '';
      return JSON.stringify({
        chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(),
        respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null,
        votesRead: sid ? localStorage.getItem('corner.votesRead.' + sid) : null,
        cardRect: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), vh: window.innerHeight } : null,
        notifCount: window.__notifs.length
      });
    })()`),
    EVAL('toggleOff', `(async () => {
      document.querySelector('.card-handoff .notify-toggle')?.click();
      await new Promise((r) => setTimeout(r, 500));
      return ${toggleSnapshotExpr()};
    })()`),
    EVAL('afterOffNewEvent', `(async () => {
      const token = '${token}';
      window.__now += 60000;
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'agree', name: '弟弟', deviceId: 'd_v42_d' }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((r) => setTimeout(r, 800));
      return JSON.stringify({ notifCount: window.__notifs.length, chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), toast: (document.getElementById('toast-host')?.innerText || '').replace(/\\s+/g, ' ').trim() });
    })()`),
    EVAL('deniedState', `(() => {
      window.Notification.permission = 'denied';
      window.__corner.flow.updateNotifyToggles();
      const btn = document.querySelector('.card-handoff .notify-toggle');
      const before = window.__permCalls;
      btn?.click();
      return JSON.stringify({ permCallsBefore: before, permCallsAfter: window.__permCalls, toggleText: (btn?.textContent || '').trim(), disabled: !!btn?.disabled, state: window.__corner.flow.getNotifyState() });
    })()`),
    EVAL('deniedNewEvent', `(async () => {
      const token = '${token}';
      window.__vis = 'hidden';
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'measure', name: '妈妈', deviceId: 'd_v42_e' }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((r) => setTimeout(r, 800));
      return JSON.stringify({ notifCount: window.__notifs.length, chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), banner: (document.getElementById('dev-error-banner')?.textContent || '').trim() });
    })()`),
    EVAL('noNotification', `(() => {
      let err = null;
      try {
        delete window.Notification;
        window.__corner.flow.updateNotifyToggles();
      } catch (e) { err = e?.message || String(e); }
      const btn = document.querySelector('.card-handoff .notify-toggle');
      return JSON.stringify({ err, toggleText: (btn?.textContent || '').trim(), disabled: !!btn?.disabled, state: window.__corner.flow.getNotifyState(), banner: (document.getElementById('dev-error-banner')?.textContent || '').trim() });
    })()`),
  ];
}

function steps1440() {
  return [
    WAIT("document.querySelector('.card-handoff .notify-toggle')", 60000),
    SLEEP(800),
    EVAL('initialNotify', toggleSnapshotExpr()),
    EVAL('toggleOn', `(async () => {
      document.querySelector('.card-handoff .notify-toggle')?.click();
      await new Promise((r) => setTimeout(r, 600));
      return ${toggleSnapshotExpr()};
    })()`),
    EVAL('scrollToggle', `(() => { const n = document.querySelector('.card-handoff .notify-toggle'); n?.scrollIntoView({ block: 'center' }); return 'ok'; })()`),
    SLEEP(300),
    EVAL('toggleLayout', `JSON.stringify((() => { const b = document.querySelector('.card-handoff .notify-toggle'); const r = b?.getBoundingClientRect(); return { text: (b?.textContent || '').trim(), isOn: !!b?.classList.contains('is-on'), w: Math.round(r?.width || 0), h: Math.round(r?.height || 0), disabled: !!b?.disabled, overflowX: document.documentElement.scrollWidth - window.innerWidth }; })())`),
    SHOT('27-notify-toggle-1440'),
  ];
}

let token = null;
let sessionId = null;
async function main() {
  console.log('='.repeat(76));
  console.log(`v4.2-notify — V4.2 系统通知验收 (${BASE})`);
  console.log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  console.log('='.repeat(76));
  await ensureServer();
  check((await healthUp()).up, '/api/health 可访问');
  check(existsSync(CDP), 'cdp-probe.mjs 存在');
  check(existsSync(THUMB), '缩略图 fixture 存在');
  const initPath = join(SCRATCH, `qa-v42-init-${RUN_ID}.js`);
  writeFileSync(initPath, INIT_SCRIPT, 'utf8');

  try {
    console.log('\n[setup] 会话 + plan + share（初始 0 条回应）');
    const created = await api('POST', '/api/sessions', { profile: PROFILE });
    sessionId = created.json?.id;
    check(/^s_[a-f0-9]{12}$/.test(sessionId || ''), '创建会话', String(sessionId));
    const setup = await runToPlan(sessionId);
    check(nonEmptyStr(setup.plan?.verdict), 'plan.verdict 存在', JSON.stringify(setup.plan?.verdict));
    const sh = await api('POST', `/api/sessions/${sessionId}/share`, { photoDataUrl: thumbDataUrl });
    token = sh.json?.share?.token;
    check(/^sh_[a-f0-9]{16}$/.test(token || ''), '创建分享', String(token));
    console.log(`  [info] session=${sessionId} token=${token}`);

    // ---------- 390：三态/自动请求/后台通知/去重/节流/点击/关闭/降级 ----------
    const p1 = runCdp({ label: 'notify-390', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: steps390(), port: 9591, initScript: initPath });
    validateCommon(p1.out, 'notify-390');
    const init = get(p1.out, 'initialNotify');
    check(init?.permCalls === 0, '**页面加载后 Notification.requestPermission 未被调用**', JSON.stringify(init?.permCalls));
    check(init?.notifCount === 0, '加载时无通知构造', JSON.stringify(init?.notifCount));
    check(init?.state === 'off', 'getNotifyState() 初始 = off', JSON.stringify(init?.state));
    check(init?.toggleText === '家人回应时提醒我', '三态按钮默认「家人回应时提醒我」', JSON.stringify(init?.toggleText));
    check(init?.disabled === false && init?.isOn === false, '默认按钮可点、非 is-on', JSON.stringify(init));
    shotExists(p1.out, '26-notify-toggle-390', 'notify-390');
    const on = get(p1.out, 'toggleOn');
    if (on) {
      check(on.permCalls === 1, '**只有点击开关才 requestPermission（1 次）**', JSON.stringify(on.permCalls));
      check(on.storage === '1', '开启后 localStorage corner.notify=1', JSON.stringify(on.storage));
      check(on.toggleText === '已开启提醒 · 点此关闭', '开启态文案正确', JSON.stringify(on.toggleText));
      check(on.isOn === true && on.state === 'enabled', 'is-on + getNotifyState=enabled', JSON.stringify(on));
    } else check(false, '读取开启状态', 'missing');
    const hid = get(p1.out, 'hiddenAddPhoto');
    if (hid) {
      check(hid.notifCount === 1, '后台 + 新照片回应 → 构造 1 次 Notification', JSON.stringify(hid.notifCount));
      const n = (hid.notifs || [])[0] || {};
      check(n.title === '猫角落 · 家人给了回应', '通知 title「猫角落 · 家人给了回应」', JSON.stringify(n.title));
      check(n.body === '家人拍了现场照 · 1 张', '通知 body 与 toast 一致', JSON.stringify(n.body));
      check(n.tag === `corner-${sessionId}`, '通知 tag=corner-<sessionId>', JSON.stringify(n.tag));
      check(n.icon === '/icons/icon-192.png', '通知 icon=/icons/icon-192.png', JSON.stringify(n.icon));
      check(/^新 1$/.test(hid.chip || ''), '同时卡内角标仍为「新 1」', JSON.stringify(hid.chip));
    } else check(false, '读取后台通知状态', 'missing');
    const dup = get(p1.out, 'refreshAgainNoDuplicate');
    check(dup?.notifCount === 1, '同一批数据再次 refresh 不重复通知', JSON.stringify(dup));
    const thr = get(p1.out, 'throttledEvent');
    check(thr?.notifCount === 1, '30s 内新事件被节流（仍 1 条通知）', JSON.stringify(thr));
    const later = get(p1.out, 'after31sEvent');
    if (later) {
      check(later.notifCount === 2, 'Date.now +31s 后新事件 → 第 2 条通知', JSON.stringify(later.notifCount));
      const n2 = (later.notifs || [])[1] || {};
      check(n2.title === '猫角落 · 家人给了回应', '第 2 条 title 正确', JSON.stringify(n2.title));
      check(n2.body === '家人回应了你 · 这个位置我不同意', '第 2 条 body 用 label', JSON.stringify(n2.body));
      check(n2.tag === `corner-${sessionId}`, '第 2 条 tag 正确', JSON.stringify(n2.tag));
    } else check(false, '读取 31s 后通知', 'missing');
    const click = get(p1.out, 'clickNotification');
    if (click) {
      check(!click.chip, '点通知后卡内未读角标清空', JSON.stringify(click.chip));
      check(click.respondsRead === '3', '点通知后 respondsRead=3（当时 count）', JSON.stringify(click.respondsRead));
      check(click.cardRect && click.cardRect.top < click.cardRect.vh && click.cardRect.bottom > 0, '点通知后 .card-votes 进入视口', JSON.stringify(click.cardRect));
    } else check(false, '读取点击通知结果', 'missing');
    const off = get(p1.out, 'toggleOff');
    if (off) {
      check(off.storage === '0', '关闭后 localStorage corner.notify=0', JSON.stringify(off.storage));
      check(off.toggleText === '家人回应时提醒我', '关闭后按钮回默认文案', JSON.stringify(off.toggleText));
      check(off.state === 'off', '关闭后 getNotifyState=off', JSON.stringify(off.state));
    } else check(false, '读取关闭状态', 'missing');
    const afterOff = get(p1.out, 'afterOffNewEvent');
    check(afterOff?.notifCount === 2, '关闭开关后即使后台/permission granted 也不再通知', JSON.stringify(afterOff?.notifCount));
    check(/^新 1$/.test(afterOff?.chip || ''), '关闭开关后角标仍正常（新 1）', JSON.stringify(afterOff?.chip));
    const denied = get(p1.out, 'deniedState');
    if (denied) {
      check(denied.toggleText === '浏览器不支持提醒', 'denied → 按钮「浏览器不支持提醒」', JSON.stringify(denied.toggleText));
      check(denied.disabled === true && denied.state === 'unsupported', 'denied → 按钮 disabled + getNotifyState=unsupported', JSON.stringify(denied));
      check(denied.permCallsAfter === denied.permCallsBefore, 'denied 时点击不再请求权限', JSON.stringify(denied));
    } else check(false, '读取 denied 状态', 'missing');
    const deniedEv = get(p1.out, 'deniedNewEvent');
    check(deniedEv?.notifCount === 2 && deniedEv?.banner === '', 'denied 时新回应不通知、无 banner', JSON.stringify(deniedEv));
    check(/^新/.test(deniedEv?.chip || ''), 'denied 时角标仍正常', JSON.stringify(deniedEv?.chip));
    const none = get(p1.out, 'noNotification');
    if (none) {
      check(!none.err, '无 Notification 时无异常', JSON.stringify(none.err));
      check(none.toggleText === '浏览器不支持提醒' && none.disabled === true, '无 Notification → 不支持态且 disabled', JSON.stringify(none));
      check(none.state === 'unsupported', '无 Notification → getNotifyState=unsupported', JSON.stringify(none.state));
    } else check(false, '读取无 Notification 状态', 'missing');

    // ---------- 1440：开关 is-on 截图 ----------
    const p2 = runCdp({ label: 'notify-1440', w: 1440, h: 900, mobile: false, url: `${BASE}/`, steps: steps1440(), port: 9592, initScript: initPath });
    validateCommon(p2.out, 'notify-1440');
    const on2 = get(p2.out, 'toggleOn');
    check(on2?.isOn === true && on2?.state === 'enabled', '1440 开启态 is-on/enabled', JSON.stringify(on2));
    const lay = get(p2.out, 'toggleLayout');
    check(lay?.isOn === true && lay?.h >= 44, '1440 开关 is-on 且高度 ≥44px', JSON.stringify(lay));
    check(lay?.overflowX === 0, '1440 无横向溢出', JSON.stringify(lay?.overflowX));
    shotExists(p2.out, '27-notify-toggle-1440', 'notify-1440');
  } finally {
    try { if (sessionId) await sweep(sessionId); } catch { /* noop */ }
    finalize();
  }
}

function finalize() {
  console.log('');
  console.log('='.repeat(76));
  console.log(`runs: ${runs.map((r) => `${r.label}=${(r.ms / 1000).toFixed(1)}s`).join('，')}`);
  console.log(`checks=${checks.length}，failed=${failed}`);
  console.log('='.repeat(76));
  const out = join(SCRATCH, `qa-v42-notify-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify({ runId: RUN_ID, base: BASE, sessionId, token, checks, runs: runs.map((r) => ({ label: r.label, ms: r.ms, outJson: r.outJson })) }, null, 2), 'utf8');
  console.log(`证据: ${out.replace(ROOT + '\\', '')}`);
  if (failed === 0) {
    console.log(`RESULT: PASS  (${checks.length} checks，${runs.length} 个浏览器场景)`);
    stopServer(); process.exit(0);
  } else {
    console.log(`RESULT: FAIL  (${failed} 项失败)`);
    for (const b of checks.filter((c) => !c.ok).slice(0, 20)) console.log(`  ✗ ${b.msg}${b.detail ? ' — ' + b.detail : ''}`);
    stopServer(); process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); stopServer(); process.exit(1); });
