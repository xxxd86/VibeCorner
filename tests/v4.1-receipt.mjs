#!/usr/bin/env node
// tests/v4.1-receipt.mjs —— V4.1 家人回应回执/未读独立验收
// 覆盖 docs/CONTRACT-V4.1.md §2-§5 + DoD：
//   双基线写入、toast 三分支、投票+回应同轮双 toast、首次无基线仅角标、
//   9+ 角标、缺失 responds/respondCount 容错、刷新持久化
// 用法: node tests/v4.1-receipt.mjs / 退出码 0 通过,1 失败

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
const thumbBuf = readFileSync(THUMB);
const thumbDataUrl = 'data:image/jpeg;base64,' + thumbBuf.toString('base64');

const checks = [];
let failed = 0;
function check(ok, msg, detail) {
  checks.push({ ok: !!ok, msg, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}${detail !== undefined ? ' — ' + detail : ''}`);
}
function warn(msg) { checks.push({ ok: true, warn: true, msg }); console.log('  [WARN] ' + msg); }

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
function runCdp({ label, w, h, mobile, url, steps, port, profile }) {
  const outJson = join(SCRATCH, `qa-v41-run-${label}-${RUN_ID}.json`);
  const stepsPath = join(SCRATCH, `qa-v41-steps-${label}-${RUN_ID}.json`);
  writeFileSync(stepsPath, JSON.stringify(steps, null, 2), 'utf8');
  console.log(`\n[${label}] ${w}×${h}${mobile ? '（CDP 移动仿真）' : ''} — ${url}`);
  const t0 = Date.now();
  const extra = profile ? [`--profile=${profile}`] : [];
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

const PIN_CARD = `(() => {
  const card = document.querySelector('.card-votes'); if (!card) return 'no-card';
  window.__qaCardHome = { parent: card.parentElement, next: card.nextElementSibling };
  window.__qaCardStyle = card.getAttribute('style') || '';
  document.body.appendChild(card);
  card.style.position = 'fixed'; card.style.left = '8px'; card.style.right = '8px';
  card.style.top = '64px'; card.style.bottom = '96px'; card.style.zIndex = '90';
  card.style.overflow = 'auto'; card.style.background = 'var(--bg, #fbf7f1)';
  return 'pinned';
})()`;
const UNPIN_CARD = `(() => {
  const card = document.querySelector('.card-votes'); if (!card) return 'no-card';
  card.setAttribute('style', window.__qaCardStyle || '');
  const home = window.__qaCardHome;
  if (home && home.parent && home.parent.isConnected) home.parent.insertBefore(card, home.next && home.next.parentElement === home.parent ? home.next : null);
  return 'unpinned';
})()`;

function owner390ReloadSteps() {
  return [
    WAIT("document.querySelector('.card-handoff')", 60000),
    SLEEP(1200),
    EVAL('afterReload', `JSON.stringify((() => {
      const sid = window.__corner.state.session?.id || '';
      return { sid, toasts: [...document.querySelectorAll('#toast-host .toast')].map((n) => n.textContent.trim()), chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null, votesRead: sid ? localStorage.getItem('corner.votesRead.' + sid) : null };
    })())`),
  ];
}

function owner390Steps() {
  return [
    WAIT("document.querySelector('.card-handoff')", 60000),
    SLEEP(1000),
    EVAL('initial', `JSON.stringify((() => {
      const sid = window.__corner.state.session?.id || '';
      return { sid, handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), votesCard: !!document.querySelector('.card-votes'), toasts: [...document.querySelectorAll('#toast-host .toast')].map((n) => n.textContent.trim()), tinyButtons: [...document.querySelectorAll('#feed button')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 40).length, respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null, votesRead: sid ? localStorage.getItem('corner.votesRead.' + sid) : null };
    })())`),
    EVAL('addPhotoRespondAndRefresh', `(async () => {
      const token = '${token}';
      const r = await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'photo', consent: true, name: '妈妈', deviceId: 'd_v41_a', note: '现场照', photoDataUrl: ${JSON.stringify(thumbDataUrl)} }) });
      if (!r.ok) return JSON.stringify({ error: 'respond ' + r.status });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((res) => setTimeout(res, 800));
      const sid = window.__corner.state.session?.id || '';
      return JSON.stringify({ toasts: [...document.querySelectorAll('#toast-host .toast')].map((n) => n.textContent.trim()), chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), chipAria: document.querySelector('.card-votes .respond-unread-chip')?.getAttribute('aria-label') || '', handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null, votesRead: sid ? localStorage.getItem('corner.votesRead.' + sid) : null });
    })()`),
    EVAL('pinForToastShot', PIN_CARD),
    SLEEP(300),
    SHOT('24-receipt-toast-390'),
    EVAL('unpinAfterToastShot', UNPIN_CARD),
    EVAL('clickCardMarkRead', `(async () => {
      document.querySelector('.card-votes')?.click();
      await new Promise((res) => setTimeout(res, 600));
      const sid = window.__corner.state.session?.id || '';
      return JSON.stringify({ chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null, votesRead: sid ? localStorage.getItem('corner.votesRead.' + sid) : null });
    })()`),
  ];
}

function owner1440Steps() {
  return [
    WAIT("document.querySelector('.card-handoff')", 60000),
    SLEEP(1200),
    EVAL('firstNoBaseline', `JSON.stringify((() => {
      const sid = window.__corner.state.session?.id || '';
      return { sid, toasts: [...document.querySelectorAll('#toast-host .toast')].map((n) => n.textContent.trim()), tinyButtons: [...document.querySelectorAll('#feed button')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 40).length, chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), chipAria: document.querySelector('.card-votes .respond-unread-chip')?.getAttribute('aria-label') || '', handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null };
    })())`),
    EVAL('markInitialRead', `(async () => {
      document.querySelector('.card-votes')?.click();
      await new Promise((res) => setTimeout(res, 600));
      const sid = window.__corner.state.session?.id || '';
      return JSON.stringify({ chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null });
    })()`),
    EVAL('add10AndRefresh', `(async () => {
      const token = '${token}';
      const acts = ['measure', 'disagree', 'agree'];
      for (let i = 0; i < 10; i++) await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: acts[i % 3], name: '家人' + (i + 1), deviceId: 'd_v41_m' + i, note: '批量回应 ' + (i + 1) }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((res) => setTimeout(res, 900));
      const sid = window.__corner.state.session?.id || '';
      return JSON.stringify({ chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), chipAria: document.querySelector('.card-votes .respond-unread-chip')?.getAttribute('aria-label') || '', handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null });
    })()`),
    EVAL('pinForUnreadShot', PIN_CARD),
    SLEEP(300),
    SHOT('25-receipt-unread-1440'),
    EVAL('unpinAfterUnreadShot', UNPIN_CARD),
    EVAL('markAllRead', `(async () => {
      document.querySelector('.card-votes')?.click();
      await new Promise((res) => setTimeout(res, 600));
      const sid = window.__corner.state.session?.id || '';
      return JSON.stringify({ chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null });
    })()`),
    EVAL('voteAndRespondSameRound', `(async () => {
      const token = '${token}';
      const view = await (await fetch('/api/share/' + token)).json();
      const target = (view.targets || [])[0];
      await fetch('/api/share/' + token + '/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: target.id, targetType: target.type, vote: 'yes', voteId: 'qa-v41-vote', name: '室友', note: '我同意' }) });
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'photo', consent: true, name: '爸爸', deviceId: 'd_v41_v', photoDataUrl: ${JSON.stringify(thumbDataUrl)} }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((res) => setTimeout(res, 1000));
      const sid = window.__corner.state.session?.id || '';
      return JSON.stringify({ toasts: [...document.querySelectorAll('#toast-host .toast')].map((n) => n.textContent.trim()), chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(), respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null });
    })()`),
    EVAL('clearAfterSimultaneous', `(async () => { document.querySelector('.card-votes')?.click(); await new Promise((r) => setTimeout(r, 500)); return 'ok'; })()`),
    EVAL('singleNoPhotoToast', `(async () => {
      const token = '${token}';
      const sid = window.__corner.state.session?.id || '';
      const before = localStorage.getItem('corner.respondsRead.' + sid);
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'measure', name: '室友', deviceId: 'd_v41_single', note: '周末我来量' }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((res) => setTimeout(res, 700));
      return JSON.stringify({ toasts: [...document.querySelectorAll('#toast-host .toast')].map((n) => n.textContent.trim()), chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim(), baselineBefore: before, respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null });
    })()`),
    EVAL('clearSingleRead', `(async () => { document.querySelector('.card-votes')?.click(); await new Promise((r) => setTimeout(r, 500)); return 'ok'; })()`),
    EVAL('twoRespondsToast', `(async () => {
      const token = '${token}';
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'disagree', name: '妈妈', deviceId: 'd_v41_two1' }) });
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'agree', name: '弟弟', deviceId: 'd_v41_two2' }) });
      await window.__corner.flow.refreshVotes({ force: true });
      await new Promise((res) => setTimeout(res, 900));
      return JSON.stringify({ toasts: [...document.querySelectorAll('#toast-host .toast')].map((n) => n.textContent.trim()), chip: (document.querySelector('.card-votes .respond-unread-chip')?.textContent || '').trim() });
    })()`),
    EVAL('clearTwoRead', `(async () => { document.querySelector('.card-votes')?.click(); await new Promise((r) => setTimeout(r, 500)); const sid = window.__corner.state.session?.id || ''; return JSON.stringify({ respondsRead: sid ? localStorage.getItem('corner.respondsRead.' + sid) : null }); })()`),
    EVAL('oldDataMissingFields', `(async () => {
      const sid = window.__corner.state.session?.id || '';
      const orig = window.fetch;
      window.fetch = (u, o) => String(u).includes('/api/sessions/' + sid + '/votes')
        ? Promise.resolve(new Response(JSON.stringify({ votes: [], counts: {}, voteCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }))
        : orig(u, o);
      let err = null;
      try { await window.__corner.flow.refreshVotes({ force: true }); await new Promise((r) => setTimeout(r, 500)); }
      catch (e) { err = e?.message || String(e); }
      window.fetch = orig;
      await window.__corner.flow.refreshVotes({ force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      return JSON.stringify({ err, banner: (document.getElementById('dev-error-banner')?.textContent || '').trim(), card: !!document.querySelector('.card-votes'), handoff: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim() });
    })()`),
  ];
}

async function touchSession() {
  await httpReq('POST', `/api/sessions/${sessionId}/after`, { body: { dataUrl: thumbDataUrl, width: 900, height: 675 }, timeout: 60000 });
  await httpReq('DELETE', `/api/sessions/${sessionId}/after`);
}

let token = null;
let sessionId = null;
async function main() {
  console.log('='.repeat(76));
  console.log(`v4.1-receipt — V4.1 家人回应回执/未读验收 (${BASE})`);
  console.log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  console.log('='.repeat(76));
  await ensureServer();
  check((await healthUp()).up, '/api/health 可访问');
  check(existsSync(CDP), 'cdp-probe.mjs 存在');
  check(existsSync(THUMB), '缩略图 fixture 存在');

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
    const v0 = (await api('GET', `/api/share/${token}`)).json;
    check(v0.respondCount === 0, '初始 respondCount=0', JSON.stringify(v0.respondCount));
    console.log(`  [info] session=${sessionId} token=${token}`);

    const profileA = '.scratch/qa-v41-profile-a';
    await touchSession();
    const p1 = runCdp({ label: 'owner-390', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: owner390Steps(), port: 9581, profile: profileA });
    validateCommon(p1.out, 'owner-390');
    const init = get(p1.out, 'initial');
    check(init?.sid === sessionId, '390 打开本轮会话', JSON.stringify({ got: init?.sid, want: sessionId }));
    check(init?.votesCard === false, '初始无家人意见卡（0 条回应）', JSON.stringify(init?.votesCard));
    check(init?.tinyButtons === 0, '390 tinyButtons=0', JSON.stringify(init?.tinyButtons));
    check(/等待家人意见/.test(init?.handoff || ''), '初始 handoff「等待家人意见」', JSON.stringify(init?.handoff));
    check((init?.toasts || []).length === 0 && init?.respondsRead == null, '初始无 toast、无 respondsRead 基线', JSON.stringify(init));
    const add = get(p1.out, 'addPhotoRespondAndRefresh');
    if (add && !add.error) {
      check((add.toasts || []).some((t) => /家人拍了现场照 · 1 张/.test(t)), '新增 1 条带照片回应 → toast「家人拍了现场照 · 1 张」', JSON.stringify(add.toasts));
      check(/^新 1$/.test(add.chip || ''), '卡内角标「新 1」', JSON.stringify(add.chip));
      check(add.chipAria === '1 条新回应', '角标 aria-label「1 条新回应」', JSON.stringify(add.chipAria));
      check(/家人已回应 1 条 · 1 条新/.test(add.handoff || ''), 'handoff「家人已回应 1 条 · 1 条新」', JSON.stringify(add.handoff));
      check(add.respondsRead == null && add.votesRead == null, '未读时基线仍未写入', JSON.stringify({ respondsRead: add.respondsRead, votesRead: add.votesRead }));
    } else check(false, '新增照片回应并刷新', JSON.stringify(add));
    shotExists(p1.out, '24-receipt-toast-390', 'owner-390');
    const read = get(p1.out, 'clickCardMarkRead');
    if (read) {
      check(!read.chip, '点击卡片后角标消失', JSON.stringify(read.chip));
      check(/家人已回应 1 条$/.test(read.handoff || ''), '点击后 handoff「家人已回应 1 条」（无"新"）', JSON.stringify(read.handoff));
      check(read.respondsRead === '1', '**已读后 corner.respondsRead.<sid> = 1**', JSON.stringify(read.respondsRead));
      check(read.votesRead === '0', '**已读后 corner.votesRead.<sid> = 0**', JSON.stringify(read.votesRead));
    } else check(false, '读取已读状态', 'missing');
    await touchSession();
    const p1b = runCdp({ label: 'owner-390-reload', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: owner390ReloadSteps(), port: 9583, profile: profileA });
    validateCommon(p1b.out, 'owner-390-reload');
    const reload = get(p1b.out, 'afterReload');
    if (reload) {
      check(reload.sid === sessionId, '刷新后打开本轮会话', JSON.stringify({ got: reload.sid, want: sessionId }));
      check((reload.toasts || []).length === 0, '刷新后（有基线）不再 toast', JSON.stringify(reload.toasts));
      check(!reload.chip, '刷新后无未读角标', JSON.stringify(reload.chip));
      check(/家人已回应 1 条$/.test(reload.handoff || ''), '刷新后 handoff「家人已回应 1 条」', JSON.stringify(reload.handoff));
      check(reload.respondsRead === '1', '刷新后 localStorage respondsRead 仍 = 1', JSON.stringify(reload.respondsRead));
    } else check(false, '读取刷新后状态', 'missing');

    await touchSession();
    const p2 = runCdp({ label: 'owner-1440', w: 1440, h: 900, mobile: false, url: `${BASE}/`, steps: owner1440Steps(), port: 9582, profile: '.scratch/qa-v41-profile-b' });
    validateCommon(p2.out, 'owner-1440');
    const first = get(p2.out, 'firstNoBaseline');
    if (first) {
      check(first.sid === sessionId, '1440 打开本轮会话', JSON.stringify({ got: first.sid, want: sessionId }));
      check(first.tinyButtons === 0, '1440 tinyButtons=0', JSON.stringify(first.tinyButtons));
      check((first.toasts || []).length === 0, '首次无基线：不 toast', JSON.stringify(first.toasts));
      check(/^新 1$/.test(first.chip || ''), '首次无基线：仅「新 1」角标', JSON.stringify(first.chip));
      check(first.chipAria === '1 条新回应', '首次无基线：aria-label「1 条新回应」', JSON.stringify(first.chipAria));
      check(first.respondsRead == null, '首次无基线：respondsRead 仍为空', JSON.stringify(first.respondsRead));
    } else check(false, '读取首次无基线状态', 'missing');
    const initRead = get(p2.out, 'markInitialRead');
    check(initRead?.respondsRead === '1', '首读后基线 = 1', JSON.stringify(initRead));
    const ten = get(p2.out, 'add10AndRefresh');
    if (ten) {
      check(/^新 9\+$/.test(ten.chip || ''), '**respondUnread=10 → 角标「新 9+」**', JSON.stringify(ten.chip));
      check(ten.chipAria === '10 条新回应', '角标 aria-label「10 条新回应」', JSON.stringify(ten.chipAria));
      check(/家人已回应 11 条 · 10 条新/.test(ten.handoff || ''), 'handoff「家人已回应 11 条 · 10 条新」', JSON.stringify(ten.handoff));
      check(ten.respondsRead === '1', '未读期间基线保持旧值 1', JSON.stringify(ten.respondsRead));
    } else check(false, '读取 9+ 状态', 'missing');
    shotExists(p2.out, '25-receipt-unread-1440', 'owner-1440');
    const allRead = get(p2.out, 'markAllRead');
    check(allRead?.respondsRead === '11', '全部已读后基线 = 11（当时 count）', JSON.stringify(allRead));
    check(!allRead?.chip && /家人已回应 11 条$/.test(allRead?.handoff || ''), '已读后角标消失、handoff 无"新"', JSON.stringify(allRead));
    const both = get(p2.out, 'voteAndRespondSameRound');
    if (both) {
      const texts = both.toasts || [];
      check(texts.some((t) => /家人给了意见 · 支持/.test(t)), '投票+回应同轮：投票 toast 存在', JSON.stringify(texts));
      check(texts.some((t) => /家人拍了现场照 · 1 张/.test(t)), '投票+回应同轮：回应 toast 存在', JSON.stringify(texts));
      const iv = texts.findIndex((t) => /家人给了意见/.test(t));
      const ir = texts.findIndex((t) => /家人拍了现场照/.test(t));
      check(iv >= 0 && ir > iv, '两条 toast 顺序：先投票后回应（DOM 顺序）', JSON.stringify(texts));
      check(/^新 1$/.test(both.chip || ''), '同轮到达后角标「新 1」', JSON.stringify(both.chip));
      check(/· 1 条新/.test(both.handoff || ''), '同轮到达 handoff 带「· 1 条新」', JSON.stringify(both.handoff));
    } else check(false, '读取投票+回应同轮状态', 'missing');
    const single = get(p2.out, 'singleNoPhotoToast');
    if (single) {
      check((single.toasts || []).some((t) => /家人回应了你 · 我周末来量/.test(t)), '1 条无照片 → toast「家人回应了你 · 我周末来量」', JSON.stringify(single.toasts));
      check(single.baselineBefore === '12' && single.respondsRead === '12', '未读时基线保持 12', JSON.stringify(single));
    } else check(false, '读取单条无照片 toast', 'missing');
    const two = get(p2.out, 'twoRespondsToast');
    if (two) {
      check((two.toasts || []).some((t) => /家人给了 2 条回应/.test(t)), '≥2 条 → toast「家人给了 2 条回应」', JSON.stringify(two.toasts));
      check(/^新 2$/.test(two.chip || ''), '≥2 条后角标「新 2」', JSON.stringify(two.chip));
    } else check(false, '读取两条 toast', 'missing');
    const twoRead = get(p2.out, 'clearTwoRead');
    check(twoRead?.respondsRead === '15', '清理后基线 = 15（11 + 1 + 2）', JSON.stringify(twoRead));
    const old = get(p2.out, 'oldDataMissingFields');
    if (old) {
      check(!old.err, '缺失 responds/respondCount 老数据：无异常', JSON.stringify(old.err));
      check(old.banner === '', '老数据：无 #dev-error-banner', JSON.stringify(old.banner));
      check(old.card === true, '老数据：恢复真实数据后卡片仍存在', JSON.stringify(old.card));
      check(/家人已回应 15 条/.test(old.handoff || ''), '老数据：handoff 仍为 15 条', JSON.stringify(old.handoff));
    } else check(false, '读取老数据容错状态', 'missing');
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
  const out = join(SCRATCH, `qa-v41-receipt-${RUN_ID}.json`);
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
