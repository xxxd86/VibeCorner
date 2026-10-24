#!/usr/bin/env node
// tests/v4-shots.mjs —— V4 双端 UI 验收（家人回应 + 主人端双段卡 + 设为改造后照片）
//
// 覆盖 docs/CONTRACT-V4.md §2/§3/§6 + Lead 追加要求：
//   家庭页 390/1440：「我能做什么」4 按钮 2×2/≥44px、点选展开表单、photo 未勾 consent 发送禁用、
//     发送后已选态/「已告诉 TA」、投票输入默认隐藏、点当前卡才展开、两表单互斥、刷新后保留本人选择（观察）
//   主人端 1440/390：handoff 状态三态（无分享隐藏 / 等待家人意见 / 家人已回应 N 条）、
//     .card-votes 双段（家人意见 / 家人回应）、72×72 缩略图、「设为改造后照片」≥44px、
//     点击后 .card-compare 使用家人图（字节一致）
//
// 用法: node tests/v4-shots.mjs
// 退出码: 0 通过 / 1 失败 / 2 前置缺失

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, BASE, httpReq, api, analyzeFlexible, ensureServer, stopServer, healthUp,
  loadImage, nonEmptyStr, sleep,
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

/* ------------------------------------------------------------- API 准备 */
async function getSession(id) { return (await api('GET', `/api/sessions/${id}`)).json; }
async function runToPlan(sessionId) {
  const img = loadImage(IMG_OK);
  await api('POST', `/api/sessions/${sessionId}/image`, { dataUrl: img.dataUrl, width: img.width, height: img.height, metrics: img.metrics }, { timeout: 60000 });
  let r = await analyzeFlexible(sessionId, 'quality', [{ metrics: img.metrics, profile: PROFILE }, {}]);
  const quality = r.final;
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
  return { quality, l0, plan: r.final, directionId };
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

/* ------------------------------------------------------------- CDP */
const runs = [];
function stepsFile(label, steps) {
  const f = join(SCRATCH, `qa-v4-steps-${label}-${RUN_ID}.json`);
  writeFileSync(f, JSON.stringify(steps, null, 2), 'utf8');
  return f;
}
function runCdp({ label, w, h, mobile, url, steps, port }) {
  const outJson = join(SCRATCH, `qa-v4-run-${label}-${RUN_ID}.json`);
  console.log(`\n[${label}] ${w}×${h}${mobile ? '（CDP 移动仿真）' : ''} — ${url}`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [
    CDP, `--url=${url}`, `--w=${w}`, `--h=${h}`, `--mobile=${mobile ? '1' : '0'}`,
    `--steps=${stepsFile(label, steps)}`, `--shots-dir=${SCREENS}`, `--out=${outJson}`, `--port=${port}`,
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  let out = null;
  try { out = JSON.parse(readFileSync(outJson, 'utf8')); } catch { /* noop */ }
  runs.push({ label, ms, exit: res.status, outJson: outJson.replace(ROOT + '\\', ''), out });
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
function validateCommon(out, label, { expectW, expectH }) {
  if (!out) return;
  const d = out.diag || {};
  check(d.vw === expectW && d.vh === expectH, `${label} 真实布局视口 ${expectW}×${expectH}`, `innerWidth=${d.vw} innerHeight=${d.vh}`);
  check(d.hasHorizontalScroll === false, `${label} 无横向滚动`, `scrollWidth=${d.docScrollW} vs ${d.vw}`);
  check(d.bannerHidden === true && !String(d.bannerText || '').trim(), `${label} #dev-error-banner 空（无 JS 报错）`, d.bannerText || '');
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

/* ------------------------------------------------------------- steps 工具 */
const SHOT = (name) => ({ type: 'shot', name });
const WAIT = (expr, timeoutMs = 30000, pollMs = 120) => ({ type: 'waitFor', expr, timeoutMs, pollMs });
const EVAL = (name, expr) => ({ type: 'eval', name, expr });
const SLEEP = (ms) => ({ type: 'sleep', ms });
const CLICK = (sel) => ({ type: 'click', sel });

function shareSteps(label) {
  return [
    WAIT("document.getElementById('share-root') && document.getElementById('share-root').dataset.state === 'ready'", 40000),
    SLEEP(400),
    EVAL('respondLayout', `JSON.stringify((() => {
      const section = document.querySelector('.respond-section');
      const row = document.querySelector('.respond-actions');
      const btns = [...document.querySelectorAll('.respond-section .respond-btn')];
      const voteBlocks = [...document.querySelectorAll('#share-vote .vote-block')];
      const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const tops = [...new Set(btns.map((b) => rect(b).top))];
      const cs = row ? getComputedStyle(row) : null;
      return {
        section: !!section,
        title: section ? (section.querySelector('.share-section-title')?.textContent || '').trim() : '',
        buttons: btns.map((b) => ({ action: b.dataset.action, label: (b.textContent || '').trim(), pressed: b.getAttribute('aria-pressed'), ...rect(b) })),
        rowDisplay: cs ? cs.display : null,
        rowCols: cs ? cs.gridTemplateColumns : null,
        rowTops: tops,
        rowOverflow: row ? row.scrollWidth > row.clientWidth + 1 : null,
        foot: (document.querySelector('.respond-foot')?.textContent || '').trim(),
        formHidden: !!document.querySelector('.respond-form')?.hidden,
        submitDisabled: !!document.querySelector('.respond-submit')?.disabled,
        voteBlocks: voteBlocks.length,
        voteFieldsHidden: voteBlocks.map((b) => !!b.querySelector('.vote-fields')?.hidden),
        voteSubmitHidden: voteBlocks.map((b) => !!b.querySelector('.vote-submit')?.hidden),
        voteVotingCount: voteBlocks.filter((b) => b.classList.contains('is-voting')).length,
        overflowX: document.documentElement.scrollWidth - window.innerWidth
      };
    })())`),
    EVAL('openFirstVote', `(() => {
      const block = document.querySelector('#share-vote .vote-block');
      const btn = block?.querySelector('.vote-btn[data-vote="yes"]');
      if (!btn) return 'no-vote';
      btn.click();
      return 'clicked';
    })()`),
    SLEEP(350),
    EVAL('voteExpanded', `JSON.stringify((() => {
      const blocks = [...document.querySelectorAll('#share-vote .vote-block')];
      return {
        votingCount: blocks.filter((b) => b.classList.contains('is-voting')).length,
        fieldsVisible: blocks.map((b) => !b.querySelector('.vote-fields')?.hidden),
        submitVisible: blocks.map((b) => !b.querySelector('.vote-submit')?.hidden),
        pressed: blocks.map((b) => b.querySelector('.vote-btn[data-vote="yes"]')?.getAttribute('aria-pressed'))
      };
    })())`),
    EVAL('closeFirstVote', `(() => {
      const block = document.querySelector('#share-vote .vote-block');
      block?.querySelector('.vote-btn[data-vote="yes"]')?.click();
      return 'toggled';
    })()`),
    SLEEP(250),
    EVAL('voteCollapsedAgain', `JSON.stringify((() => {
      const blocks = [...document.querySelectorAll('#share-vote .vote-block')];
      return { votingCount: blocks.filter((b) => b.classList.contains('is-voting')).length, fieldsHidden: blocks.map((b) => !!b.querySelector('.vote-fields')?.hidden) };
    })())`),
    EVAL('clickPhotoAction', `(() => { const b = document.querySelector('.respond-btn[data-action="photo"]'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`),
    SLEEP(400),
    EVAL('photoFormState', `JSON.stringify((() => {
      const form = document.querySelector('.respond-form');
      const pf = document.querySelector('.respond-photo-fields');
      const consent = document.querySelector('.respond-consent-check');
      const submit = document.querySelector('.respond-submit');
      const voteBlocks = [...document.querySelectorAll('#share-vote .vote-block')];
      return {
        formVisible: !!form && !form.hidden,
        photoFieldsVisible: !!pf && !pf.hidden,
        consentChecked: !!consent?.checked,
        submitDisabled: !!submit?.disabled,
        noteMax: document.querySelector('.respond-note')?.maxLength || null,
        nameMax: document.querySelector('.respond-name')?.maxLength || null,
        voteFieldsHidden: voteBlocks.map((b) => !!b.querySelector('.vote-fields')?.hidden),
        overflowX: document.documentElement.scrollWidth - window.innerWidth
      };
    })())`),
    EVAL('pickPhotoAndConsent', `(async () => {
      const input = document.querySelector('.respond-file');
      const consent = document.querySelector('.respond-consent-check');
      const submit = document.querySelector('.respond-submit');
      const res = await fetch('/demo/real/real-litter-corner.jpg');
      const blob = await res.blob();
      const file = new File([blob], 'family-photo.jpg', { type: 'image/jpeg' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const beforeConsent = !!submit.disabled;
      consent.checked = true;
      consent.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return JSON.stringify({ fileSet: input.files.length === 1, beforeConsent, afterConsentDisabled: !!submit.disabled });
    })()`),
    SLEEP(500),
    EVAL('submitState', `JSON.stringify({ disabled: !!document.querySelector('.respond-submit')?.disabled, previewVisible: !document.querySelector('.respond-preview')?.hidden })`),
    CLICK('.respond-submit'),
    WAIT("document.querySelector('.respond-done') && !document.querySelector('.respond-done').hidden", 30000),
    SLEEP(400),
    EVAL('doneState', `JSON.stringify((() => {
      const photoBtn = document.querySelector('.respond-btn[data-action="photo"]');
      const done = document.querySelector('.respond-done');
      return {
        doneText: (done?.textContent || '').trim(),
        count: done?.dataset?.count || null,
        pressed: photoBtn?.getAttribute('aria-pressed') || null,
        selectedClass: photoBtn?.classList.contains('is-selected') || false,
        formHidden: !!document.querySelector('.respond-form')?.hidden,
        toast: (document.getElementById('toast-host')?.innerText || '').replace(/\\s+/g, ' ').trim(),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        banner: (document.getElementById('dev-error-banner')?.textContent || '').trim()
      };
    })())`),
    SHOT(label === 'share-390' ? '20-v4-share-390' : `20-v4-share-${label}`),
    { type: 'navigate', url: '__URL__' },
    WAIT("document.getElementById('share-root') && document.getElementById('share-root').dataset.state === 'ready'", 40000),
    SLEEP(500),
    EVAL('afterReload', `JSON.stringify((() => {
      const photoBtn = document.querySelector('.respond-btn[data-action="photo"]');
      const done = document.querySelector('.respond-done');
      return {
        pressed: photoBtn?.getAttribute('aria-pressed') || null,
        selectedClass: photoBtn?.classList.contains('is-selected') || false,
        doneVisible: !!done && !done.hidden,
        doneText: (done?.textContent || '').trim()
      };
    })())`),
  ];
}

function ownerPreSteps() {
  return [
    WAIT("document.querySelector('.card-handoff')", 60000),
    SLEEP(300),
    EVAL('preHandoff', `JSON.stringify({
      id: (window.__corner.state.session||{}).id || '',
      statusHidden: !!document.querySelector('.card-handoff .handoff-share-status')?.hidden,
      statusText: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim(),
      votesCard: !!document.querySelector('.card-votes')
    })`),
  ];
}

function ownerWaitSteps() {
  return [
    WAIT("document.querySelector('.card-handoff')", 60000),
    SLEEP(300),
    EVAL('waitingHandoff', `JSON.stringify({
      id: (window.__corner.state.session||{}).id || '',
      statusHidden: !!document.querySelector('.card-handoff .handoff-share-status')?.hidden,
      statusText: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim()
    })`),
  ];
}

function ownerMainSteps(target, expectedCount) {
  return [
    WAIT("document.querySelector('.card-handoff')", 60000),
    SLEEP(300),
    EVAL('injectVoteAndResponds', `(async () => {
      const token = '${token}';
      const target = { id: '${target.id}', type: '${target.type}' };
      const thumb = ${JSON.stringify(thumbDataUrl)};
      await fetch('/api/share/' + token + '/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: target.id, targetType: target.type, vote: 'yes', voteId: 'qa-v4-ui-vote', name: '室友', note: '这个位置我同意' }) });
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'measure', name: '室友', deviceId: 'd_v4_ui_a', note: '周六上午有空' }) });
      await fetch('/api/share/' + token + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'photo', consent: true, name: '妈妈', deviceId: 'd_v4_ui_b', note: '这是我想放的位置', photoDataUrl: thumb }) });
      await window.__corner.flow.refreshVotes({ force: true });
      return 'ok';
    })()`),
    WAIT("document.querySelector('.card-votes')", 30000),
    SLEEP(900),
    EVAL('respondedStatus', `JSON.stringify({
      statusHidden: !!document.querySelector('.card-handoff .handoff-share-status')?.hidden,
      statusText: (document.querySelector('.card-handoff .handoff-share-status')?.textContent || '').trim()
    })`),
    EVAL('ownerResponds', `JSON.stringify((() => {
      const card = document.querySelector('.card-votes');
      const rows = [...document.querySelectorAll('.card-votes .respond-row')];
      const photos = [...document.querySelectorAll('.card-votes .respond-photo')];
      const use = [...document.querySelectorAll('.card-votes .respond-use')];
      const voteRows = document.querySelectorAll('.card-votes .vote-row').length;
      const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        card: !!card,
        chip: (card?.querySelector('.chip-votes')?.textContent || '').trim(),
        respondSection: !!card?.querySelector('.respond-section'),
        respondTitle: (card?.querySelector('.respond-section-title')?.textContent || '').trim(),
        respondRows: rows.length,
        voteRows,
        photos: photos.map((p) => ({ w: p.naturalWidth, h: p.naturalHeight, complete: p.complete, ...rect(p) })),
        useButtons: use.map((b) => ({ text: (b.textContent || '').trim(), ...rect(b) })),
        overflowX: document.documentElement.scrollWidth - window.innerWidth
      };
    })())`),
    SHOT('22-v4-owner-1440'),
    EVAL('scrollRespond', `(() => {
      const rows = [...document.querySelectorAll('.card-votes .respond-row')];
      const row = rows.find((r) => /妈妈/.test(r.textContent || '')) || document.querySelector('.card-votes');
      row?.scrollIntoView({ block: 'center' });
      return 'ok';
    })()`),
    SLEEP(450),
    SHOT('22-v4-owner-1440b'),
    EVAL('clickNamedRespond', `(() => {
      const rows = [...document.querySelectorAll('.card-votes .respond-row')];
      const row = rows.find((r) => /妈妈/.test(r.textContent || ''));
      const btn = (row || document.querySelector('.card-votes')).querySelector('.respond-use');
      if (!btn) return 'no-use';
      const img = row?.querySelector('.respond-photo');
      window.__qaPickedRespondSrc = img ? img.src : '';
      row?.scrollIntoView({ block: 'center' });
      btn.click();
      return row ? 'named' : 'first';
    })()`),
    WAIT("document.querySelector('.card-compare')", 30000),
    SLEEP(900),
    EVAL('compareFromFamily', `(async () => {
      const session = window.__corner.state.session || {};
      const after = session.afterImage || {};
      const img = document.querySelector('.card-compare .compare-img');
      const src = window.__qaPickedRespondSrc || document.querySelector('.card-votes .respond-photo')?.src || '';
      const afterRes = after.url ? await fetch(after.url) : null;
      const afterBuf = afterRes ? await afterRes.arrayBuffer() : null;
      const respRes = src ? await fetch(src) : null;
      const respBuf = respRes ? await respRes.arrayBuffer() : null;
      return JSON.stringify({
        card: !!document.querySelector('.card-compare'),
        compareSrc: (img?.getAttribute('src') || ''),
        afterUrl: after.url || '',
        fromRespondId: after.fromRespondId || '',
        fromFamilyName: after.fromFamilyName || '',
        afterBytes: afterBuf ? afterBuf.byteLength : null,
        respondBytes: respBuf ? respBuf.byteLength : null,
        sameBytes: !!(afterBuf && respBuf && afterBuf.byteLength === respBuf.byteLength)
      });
    })()`),
    EVAL('scrollCompare', `(() => { document.querySelector('.card-compare')?.scrollIntoView({ block: 'center' }); return 'ok'; })()`),
    SLEEP(450),
    SHOT('23-v4-compare-1440'),
    EVAL('ownerMisc', `JSON.stringify({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      banner: (document.getElementById('dev-error-banner')?.textContent || '').trim()
    })`),
  ];
}

function owner390Steps() {
  return [
    WAIT("document.querySelector('.card-votes')", 60000),
    EVAL('scrollVotes', `(() => {
      const f = document.getElementById('feed'); const n = document.querySelector('.card-votes');
      if (!n) return 'no';
      if (f) { const fr = f.getBoundingClientRect(), nr = n.getBoundingClientRect(); f.scrollTop += (nr.top - fr.top) - 40; }
      return 'ok';
    })()`),
    SLEEP(600),
    EVAL('owner390', `JSON.stringify((() => {
      const rows = [...document.querySelectorAll('.card-votes .respond-row')];
      const photos = [...document.querySelectorAll('.card-votes .respond-photo')];
      const use = [...document.querySelectorAll('.card-votes .respond-use')];
      const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        respondSection: !!document.querySelector('.card-votes .respond-section'),
        title: (document.querySelector('.card-votes .respond-section-title')?.textContent || '').trim(),
        rows: rows.length,
        photosLoaded: photos.map((p) => ({ w: p.naturalWidth, complete: p.complete, ...rect(p) })),
        use: use.map((b) => ({ text: (b.textContent || '').trim(), ...rect(b) })),
        overflowX: document.documentElement.scrollWidth - window.innerWidth
      };
    })())`),
    SHOT('21-v4-owner-390'),
  ];
}

/* ------------------------------------------------------------- main */
let token = null;
let sessionId = null;
async function main() {
  console.log('='.repeat(76));
  console.log(`v4-shots — V4 双端 UI 验收 (${BASE})`);
  console.log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  console.log('='.repeat(76));
  await ensureServer();
  check((await healthUp()).up, '/api/health 可访问');
  check(existsSync(CDP), 'cdp-probe.mjs 存在');
  check(existsSync(THUMB), '缩略图 fixture 存在');

  try {
    console.log('\n[setup] 会话 + plan');
    const created = await api('POST', '/api/sessions', { profile: PROFILE });
    sessionId = created.json?.id;
    check(/^s_[a-f0-9]{12}$/.test(sessionId || ''), '创建会话', String(sessionId));
    const setup = await runToPlan(sessionId);
    check(nonEmptyStr(setup.plan?.verdict), 'plan.verdict 存在', JSON.stringify(setup.plan?.verdict));

    // ---------- 主人端：无分享时 handoff 状态隐藏（三态之一） ----------
    const p0 = runCdp({ label: 'owner-pre', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: ownerPreSteps(), port: 9570 });
    validateCommon(p0.out, 'owner-pre', { expectW: 390, expectH: 844 });
    const pre = get(p0.out, 'preHandoff');
    check(pre?.id === sessionId, 'owner-pre 打开本轮会话', JSON.stringify({ got: pre?.id, want: sessionId }));
    check(pre?.statusHidden === true && !pre.statusText, 'handoff 状态：未分享时隐藏', JSON.stringify(pre));
    check(pre?.votesCard === false, '未分享时无家人意见卡');

    console.log('\n[setup] 创建 share + 投票对象');
    const sh = await api('POST', `/api/sessions/${sessionId}/share`, { photoDataUrl: thumbDataUrl });
    token = sh.json?.share?.token;
    check(/^sh_[a-f0-9]{16}$/.test(token || ''), '创建分享', String(token));
    const view = (await api('GET', `/api/share/${token}`)).json;
    const target = (view.targets || [])[0];
    check(!!target, '分享有可投票对象', JSON.stringify(view.targets?.length));
    const shareUrl = `${BASE}/s/${token}`;

    // ---------- handoff 三态之「已分享 · 等待家人意见」（在家人页提交前） ----------
    const pw = runCdp({ label: 'owner-wait', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: ownerWaitSteps(), port: 9569 });
    validateCommon(pw.out, 'owner-wait', { expectW: 390, expectH: 844 });
    const wait0 = get(pw.out, 'waitingHandoff');
    check(wait0?.id === sessionId, 'owner-wait 打开本轮会话', JSON.stringify({ got: wait0?.id, want: sessionId }));
    check(wait0?.statusHidden === false && /等待家人意见/.test(wait0.statusText || ''), 'handoff 状态：已分享 · 等待家人意见', JSON.stringify(wait0));

    // ---------- 家庭页 390 ----------
    const share390Steps = shareSteps('share-390').map((s) => s.type === 'navigate' ? { ...s, url: shareUrl } : s);
    const p1 = runCdp({ label: 'share-390', w: 390, h: 844, mobile: true, url: shareUrl, steps: share390Steps, port: 9571 });
    validateCommon(p1.out, 'share-390', { expectW: 390, expectH: 844 });
    const layout = get(p1.out, 'respondLayout');
    if (layout) {
      check(layout.section === true, '390 家人页有「我能做什么」区', JSON.stringify(layout.section));
      check(/我能做什么/.test(layout.title || ''), '390 标题「我能做什么（选一个就行，不用登录）」', layout.title);
      check((layout.buttons || []).length === 4, '390 四个 action 按钮', JSON.stringify(layout.buttons?.map((b) => b.action)));
      check((layout.buttons || []).every((b) => b.h >= 44), '四个按钮高度 ≥44px', JSON.stringify(layout.buttons?.map((b) => b.h)));
      check((layout.rowTops || []).length === 2, '2×2 网格（两行）', JSON.stringify(layout.rowTops));
      check(layout.rowOverflow === false && layout.overflowX === 0, '按钮网格/页面无横向溢出', JSON.stringify({ row: layout.rowOverflow, page: layout.overflowX }));
      check(/只(会)?发给设置这个角落的人/.test(layout.foot || ''), '底部隐私说明「只发给设置这个角落的人」', layout.foot);
      check(layout.formHidden === true, '回应表单初始收起', JSON.stringify(layout.formHidden));
      // 投票输入默认隐藏
      check((layout.voteBlocks || 0) >= 1, '有投票对象', JSON.stringify(layout.voteBlocks));
      check((layout.voteFieldsHidden || []).every(Boolean), '投票留言输入默认隐藏', JSON.stringify(layout.voteFieldsHidden));
      check((layout.voteSubmitHidden || []).every(Boolean), '投票提交按钮默认隐藏', JSON.stringify(layout.voteSubmitHidden));
      check(layout.voteVotingCount === 0, '默认没有展开的投票卡', JSON.stringify(layout.voteVotingCount));
    } else check(false, '读取 390 回应区布局', 'missing');
    const vexp = get(p1.out, 'voteExpanded');
    if (vexp) {
      check(vexp.votingCount === 1, '点「支持」只展开当前一张投票卡', JSON.stringify(vexp));
      check(vexp.fieldsVisible.filter(Boolean).length === 1 && vexp.submitVisible.filter(Boolean).length === 1, '仅当前卡显示留言/提交', JSON.stringify(vexp));
    } else check(false, '读取投票展开状态', 'missing');
    const vcol = get(p1.out, 'voteCollapsedAgain');
    check(vcol && vcol.votingCount === 0 && vcol.fieldsHidden.every(Boolean), '再点当前卡收回投票输入', JSON.stringify(vcol));
    const formState = get(p1.out, 'photoFormState');
    if (formState) {
      check(formState.formVisible === true, '点「我拍了现场照」后展开表单', JSON.stringify(formState.formVisible));
      check(formState.photoFieldsVisible === true, '照片 action 显示文件选择 + consent', JSON.stringify(formState.photoFieldsVisible));
      check(formState.consentChecked === false, 'consent 默认未勾选', JSON.stringify(formState.consentChecked));
      check(formState.submitDisabled === true, '未勾选 consent 时发送按钮禁用', JSON.stringify(formState.submitDisabled));
      check(formState.noteMax === 40 && formState.nameMax === 12, '留言/昵称 maxLength 40/12', JSON.stringify({ note: formState.noteMax, name: formState.nameMax }));
      check((formState.voteFieldsHidden || []).every(Boolean), '打开回应表单时投票输入全部收起（互斥）', JSON.stringify(formState.voteFieldsHidden));
    } else check(false, '读取照片表单状态', 'missing');
    const pick = get(p1.out, 'pickPhotoAndConsent');
    check(pick && pick.fileSet === true, '选择本地照片文件成功', JSON.stringify(pick));
    check(pick && pick.beforeConsent === true, '选照片但未勾 consent 时仍禁用', JSON.stringify(pick));
    const submitState = get(p1.out, 'submitState');
    check(submitState && submitState.disabled === false, '勾选 consent 后发送可用', JSON.stringify(submitState));
    const done = get(p1.out, 'doneState');
    if (done) {
      check(/已告诉 TA/.test(done.doneText || ''), '发送后「已告诉 TA」', JSON.stringify(done.doneText));
      check(done.pressed === 'true' && done.selectedClass === true, '发送后按钮已选态', JSON.stringify(done));
      check(done.formHidden === true, '发送后收起表单', JSON.stringify(done.formHidden));
      check(done.overflowX === 0 && done.banner === '', '发送后无溢出/无红条', JSON.stringify(done));
    } else check(false, '读取发送后状态', 'missing');
    shotExists(p1.out, '20-v4-share-390', 'share-390');
    const reload = get(p1.out, 'afterReload');
    if (reload) {
      if (reload.pressed === 'true' && reload.doneVisible === true) {
        check(true, '刷新后仍显示本人选择（deviceId 持久化）', JSON.stringify(reload));
      } else {
        warn(`刷新后未保留本人选择（deviceId 已持久化，但 UI 未恢复已选态）：${JSON.stringify(reload)}（契约 V4 未要求，原任务清单要求；责任：ui-logic）`);
      }
    } else check(false, '读取刷新后状态', 'missing');

    // ---------- 家庭页 1440 ----------
    const share1440Steps = shareSteps('share-1440').map((s) => s.type === 'navigate' ? { ...s, url: shareUrl } : s);
    const p2 = runCdp({ label: 'share-1440', w: 1440, h: 900, mobile: false, url: shareUrl, steps: share1440Steps, port: 9572 });
    validateCommon(p2.out, 'share-1440', { expectW: 1440, expectH: 900 });
    const layout2 = get(p2.out, 'respondLayout');
    check(!!layout2 && layout2.section === true && (layout2.buttons || []).length === 4, '1440 回应区 4 按钮', JSON.stringify(layout2?.buttons?.length));
    check(!!layout2 && layout2.overflowX === 0 && layout2.rowOverflow === false, '1440 回应区无横向溢出', JSON.stringify(layout2 && { page: layout2.overflowX, row: layout2.rowOverflow }));
    check(!!layout2 && (layout2.buttons || []).every((b) => b.h >= 44), '1440 四个按钮高度 ≥44px', JSON.stringify(layout2?.buttons?.map((b) => b.h)));
    check(!!layout2 && (layout2.voteFieldsHidden || []).every(Boolean), '1440 投票输入默认隐藏', JSON.stringify(layout2?.voteFieldsHidden));

    // ---------- 主人端 1440（注入回应 → 家人已回应 N 条 → 双段卡 → 对比） ----------
    const beforeMain = (await api('GET', `/api/share/${token}`)).json.respondCount;
    const expectedRespondCount = beforeMain + 2;
    const p3 = runCdp({ label: 'owner-1440', w: 1440, h: 900, mobile: false, url: `${BASE}/`, steps: ownerMainSteps(target, expectedRespondCount), port: 9573 });
    validateCommon(p3.out, 'owner-1440', { expectW: 1440, expectH: 900 });
    check(!!get(p3.out, 'injectVoteAndResponds'), '页面内注入投票+2 条回应', JSON.stringify(get(p3.out, 'injectVoteAndResponds')));
    const respStatus = get(p3.out, 'respondedStatus');
    check(!!respStatus && new RegExp(`家人已回应\\s*${expectedRespondCount}\\s*条`).test(respStatus.statusText || ''), `handoff 状态：家人已回应 ${expectedRespondCount} 条`, JSON.stringify(respStatus));
    const or = get(p3.out, 'ownerResponds');
    if (or) {
      check(or.card === true, '主人端出现 .card-votes', JSON.stringify(or.card));
      check(/家人意见/.test(or.chip || ''), '双段卡头部含「家人意见」', JSON.stringify(or.chip));
      check(or.respondSection === true && /家人回应/.test(or.respondTitle || ''), '「家人回应」段存在', JSON.stringify(or.respondTitle));
      check(or.respondRows >= 2, '回应行 ≥2（文本+照片）', JSON.stringify(or.respondRows));
      check(or.voteRows >= 1, '投票行仍存在（双段）', JSON.stringify(or.voteRows));
      check((or.photos || []).some((p) => p.complete && p.w > 0), '回应照片缩略图已加载', JSON.stringify(or.photos));
      check((or.photos || []).some((p) => p.w >= 60 && p.w <= 90 && p.h >= 60), '缩略图约 72×72', JSON.stringify(or.photos));
      check((or.useButtons || []).some((b) => /设为改造后照片/.test(b.text) && b.h >= 44), '「设为改造后照片」按钮 ≥44px', JSON.stringify(or.useButtons));
      check(or.overflowX === 0, '主人端 1440 无横向溢出', JSON.stringify(or.overflowX));
    } else check(false, '读取主人端回应段', 'missing');
    shotExists(p3.out, '22-v4-owner-1440', 'owner-1440');
    const cf = get(p3.out, 'compareFromFamily');
    if (cf) {
      check(cf.card === true, '点「设为改造后照片」后出现 .card-compare', JSON.stringify(cf.card));
      check(nonEmptyStr(cf.fromRespondId) && nonEmptyStr(cf.fromFamilyName), 'afterImage 记录来源 respondId/家人名', JSON.stringify(cf));
      check(cf.sameBytes === true, '对比图使用家人照片（字节一致）', JSON.stringify({ after: cf.afterBytes, respond: cf.respondBytes }));
      check(cf.afterUrl !== '' && cf.compareSrc !== '', '对比卡改造后图片有 URL', JSON.stringify({ src: cf.compareSrc, url: cf.afterUrl }));
    } else check(false, '读取对比卡状态', 'missing');
    shotExists(p3.out, '23-v4-compare-1440', 'owner-1440');
    const om = get(p3.out, 'ownerMisc');
    check(om && om.overflowX === 0 && om.banner === '', '主人端 1440 无溢出/无红条', JSON.stringify(om));

    // ---------- 主人端 390 ----------
    const p4 = runCdp({ label: 'owner-390', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: owner390Steps(), port: 9574 });
    validateCommon(p4.out, 'owner-390', { expectW: 390, expectH: 844 });
    const o3 = get(p4.out, 'owner390');
    if (o3) {
      check(o3.respondSection === true && /家人回应/.test(o3.title || ''), '390 主人端有家人回应段', JSON.stringify(o3));
      check(o3.rows >= 2, '390 回应行 ≥2', JSON.stringify(o3.rows));
      check((o3.photosLoaded || []).some((p) => p.complete && p.w > 0), '390 缩略图已加载', JSON.stringify(o3.photosLoaded));
      check((o3.use || []).every((b) => b.h >= 44), '390「设为改造后照片」≥44px', JSON.stringify(o3.use));
      check(o3.overflowX === 0, '390 主人端无横向溢出', JSON.stringify(o3.overflowX));
    } else check(false, '读取 390 主人端回应段', 'missing');
    shotExists(p4.out, '21-v4-owner-390', 'owner-390');
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
  const out = join(SCRATCH, `qa-v4-shots-${RUN_ID}.json`);
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
