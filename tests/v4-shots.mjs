#!/usr/bin/env node
// tests/v4-shots.mjs —— V4 双端 UI 验收（家人回应 + 主人端回应段 + 设为改造后照片）
//
// 覆盖 docs/CONTRACT-V4.md §2/§3/§6：
//   /s/<token> 390×844 + 1440：4 个「我能做什么」按钮 2×2、≥44px、无溢出；点选展开表单；
//     选「我拍了现场照」未勾 consent 时发送禁用；发送后已选态/「已告诉 TA」；刷新后保留本人选择
//   主人端 1440/390：.card-votes 双段（家人意见 / 家人回应）、照片缩略图、
//     「设为改造后照片」→ .card-compare 且用的是家人回传图（不是会话原图）
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

/* ------------------------------------------------------------- CDP 运行 */
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

/* ------------------------------------------------------------- steps */
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
        overflowX: document.documentElement.scrollWidth - window.innerWidth
      };
    })())`),
    EVAL('clickPhotoAction', `(() => { const b = document.querySelector('.respond-btn[data-action="photo"]'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`),
    SLEEP(400),
    EVAL('photoFormState', `JSON.stringify((() => {
      const form = document.querySelector('.respond-form');
      const pf = document.querySelector('.respond-photo-fields');
      const consent = document.querySelector('.respond-consent-check');
      const submit = document.querySelector('.respond-submit');
      return {
        formVisible: !!form && !form.hidden,
        photoFieldsVisible: !!pf && !pf.hidden,
        consentChecked: !!consent?.checked,
        submitDisabled: !!submit?.disabled,
        noteMax: document.querySelector('.respond-note')?.maxLength || null,
        nameMax: document.querySelector('.respond-name')?.maxLength || null,
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
    SHOT(label === 'share-390' ? '16-share-respond-390' : `16-share-respond-${label}`),
    { type: 'navigate', url: `${BASE}/s/__TOKEN__` },
    WAIT("document.getElementById('share-root') && document.getElementById('share-root').dataset.state === 'ready'", 40000),
    SLEEP(500),
    EVAL('afterReload', `JSON.stringify((() => {
      const photoBtn = document.querySelector('.respond-btn[data-action="photo"]');
      const done = document.querySelector('.respond-done');
      return {
        pressed: photoBtn?.getAttribute('aria-pressed') || null,
        selectedClass: photoBtn?.classList.contains('is-selected') || false,
        doneVisible: !!done && !done.hidden,
        doneText: (done?.textContent || '').trim(),
        bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)
      };
    })())`),
  ];
}

function ownerSteps() {
  return [
    WAIT("document.querySelector('.card-votes')", 60000),
    SLEEP(800),
    EVAL('ownerSession', `JSON.stringify({
      id: (window.__corner.state.session||{}).id || '',
      title: (window.__corner.state.session||{}).title || ''
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
    SHOT('17-owner-responds-1440'),
    CLICK('.card-votes .respond-use'),
    WAIT("document.querySelector('.card-compare')", 30000),
    SLEEP(900),
    EVAL('compareFromFamily', `(async () => {
      const session = window.__corner.state.session || {};
      const after = session.afterImage || {};
      const img = document.querySelector('.card-compare .compare-img');
      const respondImg = document.querySelector('.card-votes .respond-photo');
      const afterRes = after.url ? await fetch(after.url) : null;
      const afterBuf = afterRes ? await afterRes.arrayBuffer() : null;
      const respRes = respondImg ? await fetch(respondImg.src) : null;
      const respBuf = respRes ? await respRes.arrayBuffer() : null;
      return JSON.stringify({
        card: !!document.querySelector('.card-compare'),
        compareSrc: (img?.getAttribute('src') || ''),
        afterUrl: after.url || '',
        fromRespondId: after.fromRespondId || '',
        fromFamilyName: after.fromFamilyName || '',
        afterBytes: afterBuf ? afterBuf.byteLength : null,
        respondBytes: respBuf ? respBuf.byteLength : null,
        sameImage: !!(after.url && respondImg && after.url === respondImg.src),
        sameBytes: !!(afterBuf && respBuf && afterBuf.byteLength === respBuf.byteLength)
      });
    })()`),
    SHOT('18-compare-from-family-1440'),
    EVAL('ownerMisc', `JSON.stringify({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      banner: (document.getElementById('dev-error-banner')?.textContent || '').trim()
    })`),
  ];
}

function owner390Steps() {
  return [
    WAIT("document.querySelector('.card-votes')", 60000),
    EVAL('scrollVotes', `(() => { const f = document.getElementById('feed'); const n = document.querySelector('.card-votes'); if (!n) return 'no'; if (f) { const fr = f.getBoundingClientRect(), nr = n.getBoundingClientRect(); f.scrollTop += (nr.top - fr.top) - 40; } return 'ok'; })()`),
    SLEEP(500),
    EVAL('owner390', `JSON.stringify((() => {
      const rows = [...document.querySelectorAll('.card-votes .respond-row')];
      const photos = [...document.querySelectorAll('.card-votes .respond-photo')];
      const use = [...document.querySelectorAll('.card-votes .respond-use')];
      const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        respondSection: !!document.querySelector('.card-votes .respond-section'),
        rows: rows.length,
        photosLoaded: photos.map((p) => ({ w: p.naturalWidth, complete: p.complete, ...rect(p) })),
        use: use.map((b) => ({ text: (b.textContent || '').trim(), ...rect(b) })),
        smallUse: use.filter((b) => b.getBoundingClientRect().height < 44).length,
        overflowX: document.documentElement.scrollWidth - window.innerWidth
      };
    })())`),
  ];
}

/* ------------------------------------------------------------- main */
async function main() {
  console.log('='.repeat(76));
  console.log(`v4-shots — V4 双端 UI 验收 (${BASE})`);
  console.log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  console.log('='.repeat(76));
  await ensureServer();
  const h = await healthUp();
  check(h.up, '/api/health 可访问');
  check(existsSync(CDP), 'cdp-probe.mjs 存在');
  check(existsSync(THUMB), '缩略图 fixture 存在');

  let sessionId = null;
  let token = null;
  let setup = null;
  try {
    console.log('\n[setup] 创建会话 + 真实 AI plan + share + 预置意见/回应');
    const created = await api('POST', '/api/sessions', { profile: PROFILE });
    sessionId = created.json?.id;
    check(/^s_[a-f0-9]{12}$/.test(sessionId || ''), '创建会话', String(sessionId));
    setup = await runToPlan(sessionId);
    check(nonEmptyStr(setup.plan?.verdict), 'plan.verdict 存在', JSON.stringify(setup.plan?.verdict));
    const sh = await api('POST', `/api/sessions/${sessionId}/share`, { photoDataUrl: thumbDataUrl });
    token = sh.json?.share?.token;
    check(/^sh_[a-f0-9]{16}$/.test(token || ''), '创建分享', String(token));
    // 预置：一条投票 + 两条回应（文本 + 照片）
    const view = (await api('GET', `/api/share/${token}`)).json;
    const target = (view.targets || [])[0];
    check(!!target, '分享有可投票对象', JSON.stringify(view.targets?.length));
    await httpReq('POST', `/api/share/${token}/vote`, { body: { targetId: target.id, targetType: target.type, vote: 'yes', voteId: 'qa-v4-ui-vote', name: '室友', note: '这个位置我同意' } });
    await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'measure', name: '室友', deviceId: 'd_v4_ui_a', note: '周六上午有空' } });
    await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'photo', consent: true, name: '妈妈', deviceId: 'd_v4_ui_b', note: '这是我想放的位置', photoDataUrl: thumbDataUrl } });
    const v2 = (await api('GET', `/api/share/${token}`)).json;
    check(v2.respondCount >= 2 && v2.responds.some((x) => x.photoUrl), '预置回应含照片', JSON.stringify({ count: v2.respondCount }));
    console.log(`  [info] session=${sessionId} token=${token} plan=${setup.plan?.verdict}`);

    // ---------- 家人页 390 ----------
    const p1 = runCdp({ label: 'share-390', w: 390, h: 844, mobile: true, url: `${BASE}/s/${token}`, steps: shareSteps('share-390').map((s) => s.type === 'navigate' ? { ...s, url: `${BASE}/s/${token}` } : s), port: 9561 });
    validateCommon(p1.out, 'share-390', { expectW: 390, expectH: 844 });
    const layout = get(p1.out, 'respondLayout');
    if (layout) {
      check(layout.section === true, '390 家人页有「我能做什么」区', JSON.stringify(layout.section));
      check(/我能做什么/.test(layout.title || ''), '390 标题「我能做什么（选一个就行，不用登录）」', layout.title);
      check((layout.buttons || []).length === 4, '390 四个 action 按钮', JSON.stringify(layout.buttons?.map((b) => b.action)));
      check((layout.buttons || []).every((b) => b.h >= 44), '四个按钮高度 ≥44px', JSON.stringify(layout.buttons?.map((b) => b.h)));
      check((layout.rowTops || []).length === 2, '2×2 网格（两行）', JSON.stringify(layout.rowTops));
      check(layout.rowOverflow === false, '按钮网格无横向溢出', JSON.stringify(layout.rowOverflow));
      check(layout.overflowX === 0, '390 分享页无横向溢出', JSON.stringify(layout.overflowX));
      check(/只发给设置这个角落的人/.test(layout.foot || ''), '底部隐私说明「只发给设置这个角落的人」', layout.foot);
      check(layout.formHidden === true, '初始表单收起', JSON.stringify(layout.formHidden));
    } else check(false, '读取 390 回应区布局', 'missing');
    const formState = get(p1.out, 'photoFormState');
    if (formState) {
      check(formState.formVisible === true, '点「我拍了现场照」后展开表单', JSON.stringify(formState.formVisible));
      check(formState.photoFieldsVisible === true, '照片 action 显示文件选择 + consent', JSON.stringify(formState.photoFieldsVisible));
      check(formState.consentChecked === false, 'consent 默认未勾选', JSON.stringify(formState.consentChecked));
      check(formState.submitDisabled === true, '未勾选 consent 时发送按钮禁用', JSON.stringify(formState.submitDisabled));
      check(formState.noteMax === 40 && formState.nameMax === 12, '留言/昵称 maxLength 40/12', JSON.stringify({ note: formState.noteMax, name: formState.nameMax }));
    } else check(false, '读取照片表单状态', 'missing');
    const pick = get(p1.out, 'pickPhotoAndConsent');
    check(pick && pick.fileSet === true, '选择本地照片文件成功', JSON.stringify(pick));
    const submitState = get(p1.out, 'submitState');
    check(submitState && submitState.disabled === false, '勾选 consent 后发送可用', JSON.stringify(submitState));
    const done = get(p1.out, 'doneState');
    if (done) {
      check(/已告诉 TA/.test(done.doneText || ''), '发送后显示「已告诉 TA」', JSON.stringify(done.doneText));
      check(done.pressed === 'true' && done.selectedClass === true, '发送后按钮已选态（aria-pressed + is-selected）', JSON.stringify(done));
      check(done.formHidden === true, '发送后收起表单', JSON.stringify(done.formHidden));
      check(done.overflowX === 0 && done.banner === '', '发送后无溢出/无红条', JSON.stringify(done));
    } else check(false, '读取发送后状态', 'missing');
    shotExists(p1.out, '16-share-respond-390', 'share-390');
    const reload = get(p1.out, 'afterReload');
    if (reload) {
      check(reload.pressed === 'true' && reload.doneVisible === true, '刷新后仍显示本人选择（deviceId 持久化）', JSON.stringify(reload));
    } else check(false, '读取刷新后状态', 'missing');

    // ---------- 家人页 1440 ----------
    const p2 = runCdp({ label: 'share-1440', w: 1440, h: 900, mobile: false, url: `${BASE}/s/${token}`, steps: shareSteps('share-1440').map((s) => s.type === 'navigate' ? { ...s, url: `${BASE}/s/${token}` } : s), port: 9562 });
    validateCommon(p2.out, 'share-1440', { expectW: 1440, expectH: 900 });
    const layout2 = get(p2.out, 'respondLayout');
    check(!!layout2 && layout2.section === true && (layout2.buttons || []).length === 4, '1440 回应区 4 按钮', JSON.stringify(layout2?.buttons?.length));
    check(!!layout2 && layout2.overflowX === 0 && layout2.rowOverflow === false, '1440 回应区无横向溢出', JSON.stringify(layout2 && { overflowX: layout2.overflowX, row: layout2.rowOverflow }));
    check(!!layout2 && (layout2.buttons || []).every((b) => b.h >= 44), '1440 四个按钮高度 ≥44px', JSON.stringify(layout2?.buttons?.map((b) => b.h)));

    // ---------- 主人端 1440 ----------
    const p3 = runCdp({ label: 'owner-1440', w: 1440, h: 900, mobile: false, url: `${BASE}/`, steps: ownerSteps(), port: 9563 });
    validateCommon(p3.out, 'owner-1440', { expectW: 1440, expectH: 900 });
    const os = get(p3.out, 'ownerSession');
    check(os?.id === sessionId, '主人端打开的是本轮会话', JSON.stringify({ got: os?.id, want: sessionId }));
    const or = get(p3.out, 'ownerResponds');
    if (or) {
      check(or.card === true, '主人端出现 .card-votes', JSON.stringify(or.card));
      check(/家人意见/.test(or.chip || ''), '双段卡头部含「家人意见」', JSON.stringify(or.chip));
      check(or.respondSection === true && /家人回应/.test(or.respondTitle || ''), '「家人回应」段存在', JSON.stringify(or.respondTitle));
      check(or.respondRows >= 2, '回应行 ≥2（文本+照片）', JSON.stringify(or.respondRows));
      check(or.voteRows >= 1, '投票行仍存在（双段）', JSON.stringify(or.voteRows));
      check((or.photos || []).some((p) => p.complete && p.w > 0), '回应照片缩略图已加载', JSON.stringify(or.photos));
      check((or.photos || []).some((p) => p.w >= 60 && p.w <= 90 && p.h >= 60), '缩略图约 72×72', JSON.stringify(or.photos));
      check((or.useButtons || []).some((b) => /设为改造后照片/.test(b.text)), '有「设为改造后照片」按钮', JSON.stringify(or.useButtons));
      check(or.overflowX === 0, '主人端 1440 无横向溢出', JSON.stringify(or.overflowX));
    } else check(false, '读取主人端回应段', 'missing');
    shotExists(p3.out, '17-owner-responds-1440', 'owner-1440');
    const cf = get(p3.out, 'compareFromFamily');
    if (cf) {
      check(cf.card === true, '点「设为改造后照片」后出现 .card-compare', JSON.stringify(cf.card));
      check(nonEmptyStr(cf.fromRespondId), 'afterImage.fromRespondId 记录来源回应', JSON.stringify(cf.fromRespondId));
      check(nonEmptyStr(cf.fromFamilyName), 'afterImage.fromFamilyName 记录家人名', JSON.stringify(cf.fromFamilyName));
      check(cf.sameBytes === true, '对比图使用家人照片（字节一致）', JSON.stringify({ after: cf.afterBytes, respond: cf.respondBytes }));
      check(cf.afterUrl !== '' && cf.compareSrc !== '', '对比卡改造后图片有 URL', JSON.stringify({ src: cf.compareSrc, url: cf.afterUrl }));
    } else check(false, '读取对比卡状态', 'missing');
    shotExists(p3.out, '18-compare-from-family-1440', 'owner-1440');
    const om = get(p3.out, 'ownerMisc');
    check(om && om.overflowX === 0 && om.banner === '', '主人端 1440 无溢出/无红条', JSON.stringify(om));

    // ---------- 主人端 390 ----------
    const p4 = runCdp({ label: 'owner-390', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: owner390Steps(), port: 9564 });
    validateCommon(p4.out, 'owner-390', { expectW: 390, expectH: 844 });
    const o3 = get(p4.out, 'owner390');
    if (o3) {
      check(o3.respondSection === true, '390 主人端有家人回应段', JSON.stringify(o3.respondSection));
      check(o3.rows >= 2, '390 回应行 ≥2', JSON.stringify(o3.rows));
      check((o3.photosLoaded || []).some((p) => p.complete && p.w > 0), '390 缩略图已加载', JSON.stringify(o3.photosLoaded));
      check(o3.smallUse === 0, '390「设为改造后照片」按钮 ≥44px', JSON.stringify(o3.use));
      check(o3.overflowX === 0, '390 主人端无横向溢出', JSON.stringify(o3.overflowX));
    } else check(false, '读取 390 主人端回应段', 'missing');
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
  writeFileSync(out, JSON.stringify({ runId: RUN_ID, base: BASE, checks, runs: runs.map((r) => ({ label: r.label, ms: r.ms, outJson: r.outJson })) }, null, 2), 'utf8');
  console.log(`证据: ${out.replace(ROOT + '\\', '')}`);
  if (failed === 0) {
    console.log(`RESULT: PASS  (${checks.length} checks，${runs.length} 个浏览器场景)`);
    console.log('截图: docs/screens/16-share-respond-390.png, 17-owner-responds-1440.png, 18-compare-from-family-1440.png');
    stopServer(); process.exit(0);
  } else {
    console.log(`RESULT: FAIL  (${failed} 项失败)`);
    for (const b of checks.filter((c) => !c.ok).slice(0, 20)) console.log(`  ✗ ${b.msg}${b.detail ? ' — ' + b.detail : ''}`);
    stopServer(); process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); stopServer(); process.exit(1); });
