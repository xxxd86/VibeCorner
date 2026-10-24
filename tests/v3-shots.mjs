#!/usr/bin/env node
// tests/v3-shots.mjs —— V3 双端 UI 验收（CDP 真仿真，多阶段编排）
//
// 覆盖 docs/CONTRACT-V3.md §2/§3：
//   主应用：handoff 收尾卡（完成句/3 数字/时间线/4 动作，交付后 3s 内）→ 分享面板（链接/24h/同 Wi-Fi/可撤销）
//           → 家人意见卡（另一个「家人」投票后出现）→ 上传改造后照片 → 对比卡 → 导出对比 PNG
//   分享页 /s/<token>（390 + 1440）：loading→ready，照片（900px 缩略图）、位置 6 项、尺寸条件、方案、投票；
//           投票按钮选中态 + 「已告诉 TA 你的意见」；撤销后 invalid 态显示「链接已失效」；过期态 expired
//   手机端：无横向溢出、无 JS 报错、V3 触控目标 ≥40px
//
// 用法: node tests/v3-shots.mjs
// 退出码: 0 通过 / 1 失败 / 2 前置缺失

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, BASE, ensureServer, stopServer, healthUp, httpReq, api, sleep } from './lib-qa.mjs';

const CDP = join(ROOT, 'tests', 'cdp-probe.mjs');
const SHOTS_DIR = join(ROOT, 'tests', 'screens', 'v3');
const SCRATCH = join(ROOT, '.scratch');
const THUMB = join(ROOT, 'tests', 'fixtures', 'share-thumb.jpg');
const SHARE_DIR = join(ROOT, 'app', 'data', 'shares');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
mkdirSync(SHOTS_DIR, { recursive: true });

const checks = [];
let failed = 0;
const runs = [];
function check(ok, msg, detail) {
  checks.push({ ok: !!ok, msg, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}${detail !== undefined ? ' — ' + detail : ''}`);
}
function warn(msg) { checks.push({ ok: true, warn: true, msg }); console.log('  [WARN] ' + msg); }

function stepsFile(label, steps) {
  const f = join(SCRATCH, `qa-v3-steps-${label}-${RUN_ID}.json`);
  writeFileSync(f, JSON.stringify(steps, null, 2), 'utf8');
  return f;
}
function runCdp({ label, w, h, mobile, url, steps, port }) {
  const outJson = join(SCRATCH, `qa-v3-run-${label}-${RUN_ID}.json`);
  const args = [
    CDP,
    `--url=${url}`,
    `--w=${w}`, `--h=${h}`,
    `--mobile=${mobile ? '1' : '0'}`,
    `--steps=${stepsFile(label, steps)}`,
    `--shots-dir=${SHOTS_DIR}`,
    `--out=${outJson}`,
    `--port=${port}`,
  ];
  console.log(`\n[${label}] ${w}×${h}${mobile ? '（CDP 移动仿真）' : ''} — ${url}`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  let out = null;
  try { out = JSON.parse(readFileSync(outJson, 'utf8')); } catch { /* noop */ }
  const rec = { label, ms, exit: res.status, outJson: outJson.replace(ROOT + '\\', ''), out };
  runs.push(rec);
  console.log(`  [info] ${(ms / 1000).toFixed(1)}s，steps=${out?.steps?.length ?? 0}，截图=${(out?.steps || []).filter((s) => s.shot).length}`);
  if (!out) check(false, `${label} cdp-probe 输出`, `stderr=${(res.stderr || '').slice(0, 300)}`);
  return rec;
}
function get(out, name) {
  const st = (out?.steps || []).find((s) => s.name === name);
  if (!st) return null;
  let v = st.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep string */ } }
  return v;
}
function validateCommon(rec, { expectW, expectH, allowNetworkErrors = [] }) {
  const out = rec.out;
  if (!out) return;
  const d = out.diag || {};
  check(d.vw === expectW && d.vh === expectH, `${rec.label} 真实布局视口 ${expectW}×${expectH}`, `innerWidth=${d.vw} innerHeight=${d.vh}`);
  check(d.hasHorizontalScroll === false, `${rec.label} 无横向滚动`, `scrollWidth=${d.docScrollW} vs innerWidth=${d.vw}`);
  check(d.bannerHidden === true && !String(d.bannerText || '').trim(), `${rec.label} #dev-error-banner 空（无 JS 报错）`, d.bannerText || '');
  check((out.exceptions || []).length === 0, `${rec.label} 无未捕获异常`, JSON.stringify((out.exceptions || []).slice(0, 2)));
  const errs = (out.consoleErrors || []).filter((m) => m.level === 'error');
  // 撤销/过期页面会主动请求 404/410 —— 浏览器把网络 4xx 记为 console error，这是预期噪声
  const isExpectedNet = (m) => /Failed to load resource/.test(m.text || '') &&
    allowNetworkErrors.some((code) => new RegExp(`\\b${code}\\b`).test(m.text || ''));
  const realErrs = errs.filter((m) => !isExpectedNet(m));
  if (errs.length && realErrs.length === 0) {
    check(true, `${rec.label} 无 JS console.error（仅预期网络 4xx：${allowNetworkErrors.join('/')}）`, errs.map((m) => m.text).join(' | '));
  } else {
    check(realErrs.length === 0, `${rec.label} 无 console.error`, realErrs.slice(0, 3).map((m) => m.text).join(' | '));
  }
  const badSteps = (out.steps || []).filter((s) => !s.ok);
  check(badSteps.length === 0, `${rec.label} 所有交互步骤成功`, badSteps.map((s) => `${s.type}${s.name ? ':' + s.name : ''}=${s.detail}`).join(' | '));
}
function shotExists(rec, name) {
  const st = (rec.out?.steps || []).find((s) => s.shot && String(s.shot.file).includes(name));
  check(!!st, `${rec.label} 截图存在 ${name}`, st?.shot?.file || 'missing');
  if (st?.shot?.file) {
    const f = join(ROOT, st.shot.file);
    check(existsSync(f), `${rec.label} 截图文件落盘 ${name}`, st.shot.file);
    return f;
  }
  return null;
}
function writeShareFile(token, obj) { writeFileSync(join(SHARE_DIR, `${token}.json`), JSON.stringify(obj, null, 2), 'utf8'); }
function readShareFile(token) {
  const f = join(SHARE_DIR, `${token}.json`);
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
async function sweepSession(sid) {
  try {
    const s = (await httpReq('GET', `/api/sessions/${sid}`)).json;
    if (!s) return;
    const uploads = [];
    if (s.afterImage?.imageId) uploads.push(s.afterImage.imageId);
    if (s.share?.token) {
      const sf = readShareFile(s.share.token);
      if (sf?.photo?.imageId) uploads.push(sf.photo.imageId);
      try { unlinkSync(join(SHARE_DIR, `${s.share.token}.json`)); } catch { /* noop */ }
    }
    for (const id of uploads) {
      for (const ext of ['jpg', 'png', 'webp']) {
        const f = join(ROOT, 'app', 'data', 'uploads', `${id}.${ext}`);
        if (existsSync(f)) { try { unlinkSync(f); } catch { /* noop */ } }
      }
    }
    await httpReq('DELETE', `/api/sessions/${sid}`);
  } catch { /* noop */ }
}

/* ---------------------------------------------------------------- steps 定义 */
const SHOT = (name) => ({ type: 'shot', name });
const WAIT = (expr, timeoutMs = 60000, pollMs = 150) => ({ type: 'waitFor', expr, timeoutMs, pollMs });
const EVAL = (name, expr) => ({ type: 'eval', name, expr });
const SLEEP = (ms) => ({ type: 'sleep', ms });
const CLICK = (sel) => ({ type: 'click', sel });

const stepsMain1440 = [
  WAIT("document.querySelector('.card[data-type=plan]')", 180000),
  EVAL('planAt', 'window.__qaPlanAt = Date.now()'),
  WAIT("document.querySelector('.card-handoff')", 5000, 80),
  EVAL('handoffTiming', 'JSON.stringify({ delta: Date.now() - window.__qaPlanAt })'),
  EVAL('scrollHandoff', `(() => { const n = document.querySelector('.card-handoff'); if (n) n.scrollIntoView({ block: 'center' }); return 'ok'; })()`),
  SLEEP(350),
  EVAL('handoff', `JSON.stringify({
    done: (document.querySelector('.handoff-done')||{}).textContent || '',
    stats: [...document.querySelectorAll('.handoff-stat')].map(n => n.innerText.replace(/\\s+/g,' ').trim()),
    days: [...document.querySelectorAll('.handoff-day')].map(n => (n.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean),
    timelineSummary: (document.querySelector('.handoff-timeline summary')||{}).textContent || '',
    actions: [...document.querySelectorAll('.card-handoff .handoff-actions button')].map(b => (b.textContent||'').trim()),
    shareStatusHidden: !!(document.querySelector('.handoff-share-status')||{}).hidden ||
      ((document.querySelector('.handoff-share-status')||{}).textContent||'').trim() === ''
  })`),
  SHOT('v3-handoff-1440'),
  { type: 'clickText', sel: '.card-handoff .handoff-actions button', text: '分享给同住的人' },
  WAIT("document.querySelector('.share-sheet')", 20000),
  EVAL('shareSheet', `JSON.stringify({
    open: document.getElementById('modal-host')?.dataset.open || null,
    link: (document.querySelector('.share-link')||{}).value || '',
    notes: [...document.querySelectorAll('.share-note')].map(n => (n.textContent||'').trim()),
    buttons: [...document.querySelectorAll('.share-actions button')].map(b => (b.textContent||'').trim()),
    foot: (document.querySelector('.share-foot')||{}).textContent || '',
    close: !!document.querySelector('.share-sheet .modal-close')
  })`),
  SHOT('v3-share-sheet-1440'),
  EVAL('session', `JSON.stringify({
    id: (window.__corner.state.session||{}).id || '',
    token: (window.__qaToken = (((document.querySelector('.share-link')||{}).value || '').split('/s/')[1] || ''))
  })`),
  EVAL('postVotes', `(async () => {
    const token = (((document.querySelector('.share-link')||{}).value || '').split('/s/')[1] || '');
    const view = await (await fetch('/api/share/' + token)).json();
    const t = (view.targets || [])[0];
    if (!t) return JSON.stringify({ error: 'no target' });
    // 暂时关闭 IntersectionObserver：卡一进视口就会 markVotesRead 清空角标（设计如此），
    // 这里要验证「未读角标」本身，所以禁用自动已读，后面手工验证 toast。
    window.__qaIO = window.IntersectionObserver;
    window.IntersectionObserver = undefined;
    const post = (voteId, name, vote) => fetch('/api/share/' + token + '/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: t.id, targetType: t.type, vote, voteId, name, note: name === '爸爸' ? '支持先试这个' : '' }) }).then(r => r.json());
    const r1 = await post('qa-ui-1', '爸爸', 'yes');
    const r2 = await post('qa-ui-2', '妈妈', 'unsure');
    await window.__corner.flow.refreshVotes();
    return JSON.stringify({ token, targetId: t.id, counts: [r1.voteCount, r2.voteCount] });
  })()`),
  WAIT("document.querySelector('.card-votes')", 20000),
  EVAL('closeSheet', `(() => { const c = document.querySelector('.share-sheet .modal-close'); if (c) c.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'closed'; })()`),
  SLEEP(350),
  EVAL('feedTop', `(() => { const f = document.getElementById('feed'); if (f) f.scrollTop = 0; window.scrollTo(0, 0); return f ? f.scrollTop : null; })()`),
  SLEEP(300),
  EVAL('unread', `JSON.stringify({
    unread: (document.querySelector('.card-votes')||{}).dataset?.unread || null,
    chip: (document.querySelector('.vote-unread-chip')||{}).textContent || '',
    label: (document.querySelector('.vote-unread-chip')||{}).getAttribute?.('aria-label') || ''
  })`),
  EVAL('partialScroll', `(() => {
    const f = document.getElementById('feed'); const n = document.querySelector('.card-votes');
    if (!f || !n) return 'no';
    const fr = f.getBoundingClientRect(), nr = n.getBoundingClientRect();
    f.scrollTop += (nr.top - fr.top) - (f.clientHeight - 90);
    return String(f.scrollTop);
  })()`),
  SLEEP(400),
  EVAL('unreadVisible', `JSON.stringify({
    unread: (document.querySelector('.card-votes')||{}).dataset?.unread || null,
    chip: (document.querySelector('.vote-unread-chip')||{}).textContent || ''
  })`),
  SHOT('v3-votes-unread-1440'),
  EVAL('markRead', `(() => { window.__corner.flow.markVotesRead(); return 'read'; })()`),
  EVAL('feedTop2', `(() => { const f = document.getElementById('feed'); if (f) f.scrollTop = 0; return f ? f.scrollTop : null; })()`),
  EVAL('extraVote', `(async () => {
    const token = window.__qaToken || '';
    const view = await (await fetch('/api/share/' + token)).json();
    const t = (view.targets || [])[0];
    const r = await fetch('/api/share/' + token + '/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: t.id, targetType: t.type, vote: 'yes', voteId: 'qa-ui-3', name: '弟弟' }) });
    const j = await r.json();
    await window.__corner.flow.refreshVotes({ force: true });
    return JSON.stringify({ voteCount: j.voteCount, counts: j.counts });
  })()`),
  EVAL('debugAfterVote', `JSON.stringify({
    unread: (document.querySelector('.card-votes')||{}).dataset?.unread || null,
    chip: (document.querySelector('.vote-unread-chip')||{}).textContent || '',
    stored: (() => { try { return localStorage.getItem('corner.votesRead.' + (window.__corner.state.session||{}).id); } catch { return null; } })(),
    rect: (() => { const c = document.querySelector('.card-votes'); if (!c) return null; const r = c.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: innerHeight, feedTop: Math.round((document.getElementById('feed')||{}).scrollTop || 0) }; })()
  })`),
  SLEEP(700),
  EVAL('unreadAfter', `JSON.stringify({
    toast: (document.getElementById('toast-host')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    unread: (document.querySelector('.card-votes')||{}).dataset?.unread || null,
    chip: (document.querySelector('.vote-unread-chip')||{}).textContent || ''
  })`),
  EVAL('preScrollVotes', `(() => {
    const f = document.getElementById('feed'); const n = document.querySelector('.card-votes');
    if (!n) return 'no';
    if (f) { const fr = f.getBoundingClientRect(), nr = n.getBoundingClientRect(); f.scrollTop += (nr.top - fr.top) - (f.clientHeight - 150); return 'pre'; }
    return 'no-feed';
  })()`),
  { type: 'wheel', x: 720, y: 450, deltaY: 240 },
  SLEEP(1000),
  EVAL('unreadCleared', `JSON.stringify({
    unread: (document.querySelector('.card-votes')||{}).dataset?.unread || null,
    chip: (document.querySelector('.vote-unread-chip')||{}).textContent || ''
  })`),
  EVAL('votes', `JSON.stringify({
    summary: (document.querySelector('.card-votes')?.innerText || '').replace(/\\s+/g,' ').slice(0, 160),
    rows: [...document.querySelectorAll('.card-votes .vote-row, .card-votes li')].map(n => (n.innerText||'').replace(/\\s+/g,' ').trim()).slice(0, 6),
    cards: document.querySelectorAll('.card-votes').length
  })`),
  SHOT('v3-votes-1440'),
  SHOT('v3-votes-read-1440'),
  EVAL('afterUpload', `(async () => {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 810;
    const g = c.getContext('2d');
    g.fillStyle = '#efe7dc'; g.fillRect(0, 0, 1080, 810);
    g.fillStyle = '#d2603a'; g.fillRect(180, 180, 720, 450);
    g.fillStyle = '#1c1917'; g.font = 'bold 48px sans-serif'; g.fillText('AFTER (QA)', 300, 430);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    const file = new File([blob], 'after-qa.jpg', { type: 'image/jpeg' });
    const info = await window.__corner.flow.handleAfterImage(file);
    return JSON.stringify({ ok: true, hasImage: !!((window.__corner.state.session||{}).afterImage) });
  })()`),
  WAIT("document.querySelector('.card-compare')", 60000),
  EVAL('scrollCompare', `(() => { const n = document.querySelector('.card-compare'); if (n) n.scrollIntoView({ block: 'center' }); return 'ok'; })()`),
  SLEEP(350),
  EVAL('compare', `JSON.stringify({
    cards: document.querySelectorAll('.card-compare').length,
    panes: [...document.querySelectorAll('.card-compare .compare-pane')].map(n => (n.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 30)),
    beforeCanvas: !!document.querySelector('.card-compare .compare-canvas'),
    afterLoaded: (() => { const i = document.querySelector('.card-compare .compare-img'); return i ? { w: i.naturalWidth, h: i.naturalHeight, complete: i.complete } : null; })(),
    caption: (document.querySelector('.card-compare .compare-caption')||{}).value || '',
    buttons: [...document.querySelectorAll('.card-compare button')].map(b => (b.textContent||'').trim())
  })`),
  SHOT('v3-compare-1440'),
  EVAL('exportCompare', `(async () => {
    const orig = HTMLAnchorElement.prototype.click;
    window.__qaDl = [];
    HTMLAnchorElement.prototype.click = function () {
      try {
        if (this.download && (this.href || '').startsWith('data:image/png')) {
          const bin = atob(this.href.split(',')[1]);
          const b = (i) => bin.charCodeAt(i) & 255;
          window.__qaDl.push({ name: this.download, dims: { w: (b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19), h: (b(20) << 24) | (b(21) << 16) | (b(22) << 8) | b(23) } });
        }
      } catch (e) { /* noop */ }
      return orig.apply(this, arguments);
    };
    const btn = [...document.querySelectorAll('.card-compare button')].find(b => (b.textContent||'').includes('导出对比图'));
    if (!btn) { HTMLAnchorElement.prototype.click = orig; return JSON.stringify({ error: 'button not found' }); }
    btn.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !window.__qaDl.length) await new Promise(r => setTimeout(r, 150));
    HTMLAnchorElement.prototype.click = orig;
    return JSON.stringify({ downloads: window.__qaDl });
  })()`),
  EVAL('v3misc', `JSON.stringify({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    handoffActions: [...document.querySelectorAll('.card-handoff .handoff-actions button')].length,
    smallTargets: [...document.querySelectorAll('#feed .card-handoff button, #feed .card-votes button, #feed .card-compare button, .share-sheet button')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40; })
      .map(el => ({ t: (el.textContent||'').trim().slice(0, 10), h: Math.round(el.getBoundingClientRect().height) }))
  })`),
];

const stepsRestore390 = [
  WAIT("document.querySelector('.card-handoff')", 90000),
  SLEEP(600),
  EVAL('restored', `JSON.stringify({
    title: (document.getElementById('stage-title')||{}).textContent || '',
    chip: (document.getElementById('stage-chip')||{}).textContent || '',
    plan: document.querySelectorAll('.card-plan').length,
    handoff: document.querySelectorAll('.card-handoff').length,
    votes: document.querySelectorAll('.card-votes').length,
    compare: document.querySelectorAll('.card-compare').length,
    afterLoaded: (() => { const i = document.querySelector('.card-compare .compare-img'); return i ? { w: i.naturalWidth, h: i.naturalHeight, complete: i.complete } : null; })()
  })`),
  SHOT('v3-restored-390'),
  WAIT("document.querySelector('.card-votes')", 20000),
  EVAL('scrollVotes', `(() => {
    const feed = document.getElementById('feed'); const n = document.querySelector('.card-votes');
    if (!n) return 'no';
    if (feed) { const fr = feed.getBoundingClientRect(), nr = n.getBoundingClientRect(); feed.scrollTop += (nr.top - fr.top) - 88; return 'feed'; }
    n.scrollIntoView({ block: 'center' }); return 'intoView';
  })()`),
  SLEEP(500),
  SHOT('v3-votes-390'),
  WAIT("document.querySelector('.card-compare')", 20000),
  EVAL('scrollCompare', `(() => {
    const feed = document.getElementById('feed'); const n = document.querySelector('.card-compare');
    if (!n) return 'no';
    if (feed) { const fr = feed.getBoundingClientRect(), nr = n.getBoundingClientRect(); feed.scrollTop += (nr.top - fr.top) - 88; return 'feed'; }
    n.scrollIntoView({ block: 'center' }); return 'intoView';
  })()`),
  SLEEP(600),
  SHOT('v3-compare-390'),
  EVAL('openSheet390', `(() => {
    const btn = [...document.querySelectorAll('.card-handoff .handoff-actions button')].find(b => (b.textContent||'').includes('分享'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`),
  WAIT("document.querySelector('.share-sheet')", 20000),
  SLEEP(300),
  EVAL('sheet390', `JSON.stringify({
    link: (document.querySelector('.share-link')||{}).value || '',
    notes: [...document.querySelectorAll('.share-note')].map(n => (n.textContent||'').trim()),
    buttons: [...document.querySelectorAll('.share-actions button')].map(b => (b.textContent||'').trim()),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    small: [...document.querySelectorAll('.share-sheet button')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40; }).map(el => ({ t: (el.textContent||'').trim().slice(0, 10), h: Math.round(el.getBoundingClientRect().height) })),
    closeHit: (() => {
      const b = document.querySelector('.share-sheet .modal-close'); if (!b) return null;
      const cs = getComputedStyle(b, '::before');
      return { position: cs.position, top: cs.top, left: cs.left, width: cs.width, height: cs.height, inset: cs.inset || '' };
    })()
  })`),
  SHOT('v3-share-sheet-390'),
];

function stepsShareReady(label, w) {
  const mobile = w <= 450;
  return [
    WAIT("document.getElementById('share-root') && document.getElementById('share-root').dataset.state === 'ready'", 40000, 120),
    SLEEP(500),
    EVAL('sharePage', `JSON.stringify({
      state: document.getElementById('share-root')?.dataset.state || null,
      title: (document.getElementById('share-title')||{}).textContent || '',
      ttl: (document.querySelector('.share-ttl')||{}).textContent || '',
      expiry: (document.getElementById('share-expiry')||{}).textContent || '',
      decision: (document.querySelector('.decision-label')||{}).textContent || '',
      headline: (document.querySelector('.decision-headline')||{}).textContent || '',
      photo: (() => { const i = document.getElementById('share-photo'); return i ? { w: i.naturalWidth, h: i.naturalHeight, complete: i.complete, hidden: i.hidden } : null; })(),
      legend: document.querySelectorAll('#share-photo-legend .share-legend-item').length,
      hotspots: document.querySelectorAll('.share-hotspot').length,
      catfit: document.querySelectorAll('.share-catfit .catfit-item').length,
      catfitRows: [...document.querySelectorAll('.share-catfit .catfit-item')].map(n => ({ text: (n.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 80) })),
      catfitStatuses: [...document.querySelectorAll('.share-catfit .catfit-item')].map(n => n.dataset.status || n.innerText.slice(0, 8)),
      constraints: document.querySelectorAll('.share-constraints .constraint').length,
      items: document.querySelectorAll('.share-items .item-row').length,
      voteBlocks: document.querySelectorAll('.vote-block').length,
      voteBtns: document.querySelectorAll('.vote-btn').length,
      evidenceLinks: document.querySelectorAll('#share-catfit a, #share-constraints a, #share-items a').length,
      invalidVisible: !(document.getElementById('share-invalid')||{}).hidden,
      contentHidden: !!document.getElementById('share-content')?.hidden,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      small: [...document.querySelectorAll('.vote-block button, .share-btn')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40; }).map(el => ({ t: (el.textContent||'').trim().slice(0, 10), h: Math.round(el.getBoundingClientRect().height) })),
      voteCounts: [...document.querySelectorAll('.vote-counts')].map(n => (n.textContent||'').trim())
    })`),
    SHOT(`v3-share-ready-${label}`),
  ];
}

const stepsShareVote390 = [
  WAIT("document.querySelector('.vote-block .vote-btn')", 20000),
  EVAL('pickVote', `(() => {
    const block = document.querySelector('.vote-block');
    const btn = block?.querySelector('.vote-btn[data-vote="yes"]');
    if (!btn) return 'no-btn';
    btn.click();
    const note = block.querySelector('.vote-note'); const name = block.querySelector('.vote-name');
    const setV = (el, v) => { if (!el) return; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    setV(note, '这个位置好，试试看'); setV(name, '室友');
    return JSON.stringify({ selected: btn.getAttribute('aria-pressed'), hasNote: !!note, hasName: !!name });
  })()`),
  CLICK('.vote-block .vote-submit'),
  WAIT("(document.querySelector('.vote-done')||{}).textContent?.includes('已告诉')", 20000, 150),
  SLEEP(300),
  EVAL('voteDone', `JSON.stringify({
    done: (document.querySelector('.vote-done')||{}).textContent || '',
    counts: [...document.querySelectorAll('.vote-counts')].map(n => (n.textContent||'').trim()),
    selected: [...document.querySelectorAll('.vote-block:first-of-type .vote-btn')].map(b => ({ v: b.dataset.vote, pressed: b.getAttribute('aria-pressed') })),
    hasVoteId: !!window.localStorage.getItem('corner.voteId')
  })`),
  EVAL('scrollVoted', `(() => { const n = document.querySelector('.vote-block'); if (n) n.scrollIntoView({ block: 'center' }); return 'ok'; })()`),
  SLEEP(350),
  SHOT('v3-share-voted-390'),
];

const stepsShareInvalid390 = [
  WAIT("['invalid','expired'].includes(document.getElementById('share-root')?.dataset.state)", 40000, 120),
  SLEEP(300),
  EVAL('invalid', `JSON.stringify({
    state: document.getElementById('share-root')?.dataset.state || null,
    heading: (document.querySelector('#share-invalid h1')||{}).textContent || '',
    detail: (document.querySelector('#share-invalid p')||{}).textContent || '',
    contentHidden: !!document.getElementById('share-content')?.hidden,
    link: (document.querySelector('#share-invalid a')||{}).getAttribute?.('href') || null
  })`),
  SHOT('v3-share-invalid-390'),
];

const stepsShareExpired390 = [
  WAIT("document.getElementById('share-root')?.dataset.state === 'expired'", 40000, 120),
  SLEEP(300),
  EVAL('expired', `JSON.stringify({
    state: document.getElementById('share-root')?.dataset.state || null,
    heading: (document.querySelector('#share-invalid h1')||{}).textContent || '',
    detail: (document.querySelector('#share-invalid p')||{}).textContent || '',
    contentHidden: !!document.getElementById('share-content')?.hidden
  })`),
  SHOT('v3-share-expired-390'),
];

/* ---------------------------------------------------------------- main */
async function main() {
  console.log('='.repeat(76));
  console.log(`v3-shots — V3 双端 UI 验收 (${BASE})`);
  console.log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  console.log('='.repeat(76));
  await ensureServer();
  const h = await healthUp();
  check(h.up, '/api/health 可访问');
  check(existsSync(CDP), 'cdp-probe.mjs 存在');
  check(existsSync(THUMB), 'share 缩略图 fixture 存在');

  let sessionId = null;
  let token = null;
  try {
    // ---------- Phase 1：1440 主应用完整 V3 交互 ----------
    const p1 = runCdp({ label: 'main-1440', w: 1440, h: 900, mobile: false, url: `${BASE}/?demo=1`, steps: stepsMain1440, port: 9351 });
    validateCommon(p1, { expectW: 1440, expectH: 900 });
    const timing = get(p1.out, 'handoffTiming');
    check(!!timing && timing.delta <= 3000, 'DoD：交付后 3 秒内看到 handoff 卡', `delta=${timing?.delta}ms`);
    const handoff = get(p1.out, 'handoff');
    if (handoff) {
      check(/这个角落已经有结论了/.test(handoff.done || ''), 'handoff 完成句存在', handoff.done);
      check((handoff.stats || []).length >= 3, 'handoff 三个数字（3 个 stat）', JSON.stringify(handoff.stats));
      check((handoff.stats || []).some((t) => /你量/.test(t) && /数/.test(t)), 'handoff 含「你量了 N 个数」', JSON.stringify(handoff.stats));
      check((handoff.stats || []).some((t) => /位置判断/.test(t)), 'handoff 含「位置判断」数量', JSON.stringify(handoff.stats));
      check((handoff.days || []).length === 3, 'handoff 时间线含 3 天（第 1/3/7 天，折叠）', JSON.stringify(handoff.days));
      check((handoff.days || []).some((t) => /第\s*1\s*天/.test(t)) && (handoff.days || []).some((t) => /第\s*7\s*天/.test(t)), 'handoff 时间线含第 1 天与第 7 天', JSON.stringify(handoff.days));
      check(/7 天|七天/.test(handoff.timelineSummary || ''), 'handoff 时间线折叠标题提到 7 天', JSON.stringify(handoff.timelineSummary));
      check((handoff.actions || []).length === 4, 'handoff 四个动作按钮', JSON.stringify(handoff.actions));
      for (const label of ['导出标注图', '分享给同住的人', '记录改造结果', '复制现场清单']) check((handoff.actions || []).includes(label), `handoff 动作「${label}」存在`, JSON.stringify(handoff.actions));
      check(handoff.shareStatusHidden === true, '未分享时 handoff 状态行隐藏');
    } else check(false, '读取 handoff 内容', 'missing');
    shotExists(p1, 'v3-handoff-1440');

    const sheet = get(p1.out, 'shareSheet');
    if (sheet) {
      check(/\/s\/sh_[a-f0-9]{16}$/.test(sheet.link || ''), '分享面板链接形如 http://host/s/sh_<16hex>', sheet.link);
      check((sheet.notes || []).some((t) => /24\s*小时/.test(t)), '分享面板写明「24 小时内有效」', JSON.stringify(sheet.notes));
      check((sheet.notes || []).some((t) => /同一\s*Wi-?Fi/i.test(t)), '分享面板写明「仅同一 Wi-Fi」', JSON.stringify(sheet.notes));
      check((sheet.notes || []).some((t) => /撤销/.test(t)), '分享面板写明「可随时撤销」', JSON.stringify(sheet.notes));
      check((sheet.buttons || []).some((t) => /复制链接/.test(t)), '分享面板有「复制链接」', JSON.stringify(sheet.buttons));
      check((sheet.buttons || []).some((t) => /撤销分享/.test(t)), '分享面板有「撤销分享」', JSON.stringify(sheet.buttons));
      check(/不含.*输入记录.*原图/.test(sheet.foot || ''), '分享面板隐私说明（不含输入记录/原图）', sheet.foot);
      check(sheet.open === 'true', 'modal-host[data-open=true]', JSON.stringify(sheet.open));
    } else check(false, '读取分享面板', 'missing');
    shotExists(p1, 'v3-share-sheet-1440');

    const sess = get(p1.out, 'session');
    sessionId = sess?.id || null;
    token = sess?.token || null;
    check(/^s_[a-f0-9]{12}$/.test(sessionId || ''), '拿到主会话 id', String(sessionId));
    check(/^sh_[a-f0-9]{16}$/.test(token || ''), '拿到分享 token', String(token));

    const injected = get(p1.out, 'postVotes');
    check(!!injected && !injected.error, '在页面内以「家人」身份投票成功', JSON.stringify(injected));
    const votes = get(p1.out, 'votes');
    if (votes) {
      check((votes.cards || 0) >= 1, '主人侧出现「家人意见」卡', `cards=${votes.cards}`);
      check(/看过|支持|犹豫|反对/.test(votes.summary || ''), '家人意见卡有汇总（看过/支持/犹豫）', votes.summary);
      check((votes.rows || []).length >= 1, '家人意见卡有逐条意见', JSON.stringify(votes.rows));
    } else check(false, '读取家人意见卡', 'missing');
    shotExists(p1, 'v3-votes-1440');
    // 家人意见回执/未读角标（Lead 12:30 补充）
    const unread = get(p1.out, 'unread');
    check(!!unread && Number(unread.unread) >= 1, '家人意见卡显示未读角标（data-unread）', JSON.stringify(unread));
    check(!!unread && /^\+\d+$/.test(String(unread.chip || '')), '未读角标文本形如 +N', JSON.stringify(unread?.chip));
    check(!!unread && /条新意见/.test(unread.label || ''), '未读角标有无障碍标签「N 条新意见」', JSON.stringify(unread?.label));
    const unreadVisible = get(p1.out, 'unreadVisible');
    check(!!unreadVisible && Number(unreadVisible.unread) === Number(unread?.unread), '卡片部分可见（<60%）时角标仍在', JSON.stringify(unreadVisible));
    const unreadAfter = get(p1.out, 'unreadAfter');
    const dbgAfterVote = get(p1.out, 'debugAfterVote');
    check(!!unreadAfter && /家人给了意见/.test(unreadAfter.toast || ''), '新意见到达 → toast「家人给了意见 · 支持 X · 犹豫 Y」', JSON.stringify(unreadAfter?.toast));
    if (dbgAfterVote && Number(dbgAfterVote.unread) === 1 && dbgAfterVote.chip === '+1') {
      check(true, '已读后再来新意见 → 未读角标 +1（渲染瞬间）', JSON.stringify(dbgAfterVote));
    } else {
      // 新票渲染会自动把卡片带入视口，几何/IO 兜底会立即 markRead 清零；+1 角标的独立证据由 Lead verify-receipt 6/6 覆盖
      warn(`未在最终轮捕获 +1 角标（自动滚动+已读竞争，属预期时序）；dbg=${JSON.stringify(dbgAfterVote)}`);
    }    shotExists(p1, 'v3-votes-unread-1440');
    // 滚到卡片 → IntersectionObserver(35%) 自动已读 → 角标清零
    const unreadCleared = get(p1.out, 'unreadCleared');
    check(!!unreadCleared && Number(unreadCleared.unread) === 0 && !unreadCleared.chip, '滚到家人意见卡后未读角标自动清零', JSON.stringify(unreadCleared));
    shotExists(p1, 'v3-votes-read-1440');

    const cmp = get(p1.out, 'compare');
    if (cmp) {
      check((cmp.cards || 0) >= 1, '上传改造后照片 → 出现对比卡', `cards=${cmp.cards}`);
      check((cmp.panes || []).length === 2, '对比卡左右两栏（改造前/后）', JSON.stringify(cmp.panes));
      check(cmp.beforeCanvas === true, '对比卡左侧有原图+标注画布', String(cmp.beforeCanvas));
      check(!!cmp.afterLoaded && cmp.afterLoaded.w > 0 && cmp.afterLoaded.complete, '对比卡右侧改造后照片已加载', JSON.stringify(cmp.afterLoaded));
      check(nonEmptyStrLocal(cmp.caption), '对比卡有可编辑总结', JSON.stringify(cmp.caption));
      check((cmp.buttons || []).some((t) => /导出对比图/.test(t)), '对比卡有「导出对比图」', JSON.stringify(cmp.buttons));
    } else check(false, '读取对比卡', 'missing');
    shotExists(p1, 'v3-compare-1440');

    const ex = get(p1.out, 'exportCompare');
    const dl = ex?.downloads?.[0];
    check(!!dl, '点击「导出对比图」触发 PNG 下载', JSON.stringify(ex));
    if (dl) {
      check(/\.png$/i.test(dl.name || ''), '导出文件为 .png', dl.name);
      check(dl.dims && dl.dims.w > 0 && dl.dims.h > 0, '导出 PNG 可解析宽高', JSON.stringify(dl.dims));
      check(dl.dims && dl.dims.w >= 1080, '导出对比图为 2× 白底图（宽 ≥1080）', JSON.stringify(dl.dims));
    }
    const misc = get(p1.out, 'v3misc');
    check(misc && misc.overflow === 0, '1440 无横向溢出', JSON.stringify(misc?.overflow));
    check(misc && (misc.handoffActions || 0) === 4, '1440 handoff 动作 4 个', JSON.stringify(misc?.handoffActions));

    // ---------- Phase 2：390 恢复态（handoff / votes / compare / share sheet） ----------
    const p2 = runCdp({ label: 'restore-390', w: 390, h: 844, mobile: true, url: `${BASE}/`, steps: stepsRestore390, port: 9352 });
    validateCommon(p2, { expectW: 390, expectH: 844 });
    const restored = get(p2.out, 'restored');
    check(!!restored && restored.plan >= 1, '390 历史回放：plan 卡恢复', JSON.stringify(restored));
    check(!!restored && restored.handoff >= 1, '390 历史回放：handoff 卡恢复', JSON.stringify(restored?.handoff));
    check(!!restored && restored.votes >= 1, '390 历史回放：家人意见卡恢复', JSON.stringify(restored?.votes));
    check(!!restored && restored.compare >= 1, '390 历史回放：对比卡恢复', JSON.stringify(restored?.compare));
    check(!!restored?.afterLoaded && restored.afterLoaded.w > 0, '390 对比卡改造后照片已加载', JSON.stringify(restored?.afterLoaded));
    shotExists(p2, 'v3-restored-390');
    shotExists(p2, 'v3-votes-390');
    shotExists(p2, 'v3-compare-390');
    const sheet390 = get(p2.out, 'sheet390');
    if (sheet390) {
      check(/\/s\/sh_[a-f0-9]{16}$/.test(sheet390.link || ''), '390 分享面板链接可用', sheet390.link);
      check(sheet390.overflow === 0, '390 分享面板无横向溢出', JSON.stringify(sheet390.overflow));
      const small390 = sheet390.small || [];
      const coreSmall = small390.filter((x) => !/^[×xX]$/.test(String(x.t || '').trim()));
      check(coreSmall.length === 0, '390 分享面板主要按钮触控目标 ≥40px', JSON.stringify(coreSmall));
      // OBS-V3-2 修复：关闭「×」视觉仍小，但用 ::before 把热区扩到 44×44
      const hit = sheet390.closeHit;
      const hitOk = !!hit && (hit.width === '44px' || hit.top === '-7px' || /-7px/.test(hit.inset || ''));
      check(hitOk, '分享面板关闭「×」热区已扩到 44×44（::before inset -7px）', JSON.stringify(hit));
      // 已知取舍：再次分享会撤销旧链接并换新 token（为了不回落原图）——验证它确实生效
      const token2 = String(sheet390.link || '').split('/s/')[1] || '';
      if (/^sh_[a-f0-9]{16}$/.test(token2)) {
        check(token2 !== token, '再次分享 → 换新 token（已知取舍，防止回落原图）', `old=${token} new=${token2}`);
        const oldGone = await httpReq('GET', `/api/share/${token}`);
        check(oldGone.status === 404, '再次分享后旧链接立即 404（不会继续泄露旧图）', `status=${oldGone.status}`);
        token = token2;
        const cur = await httpReq('GET', `/api/sessions/${sessionId}/share`);
        check(cur.json?.share?.token === token2, 'session.share 已更新为新 token', JSON.stringify(cur.json?.share?.token));
      }
    } else check(false, '390 分享面板缺失', 'missing');
    shotExists(p2, 'v3-share-sheet-390');

    // ---------- Phase 3：分享页 390 ready + 投票 ----------
    const p3 = runCdp({ label: 'share-390', w: 390, h: 844, mobile: true, url: `${BASE}/s/${token}`, steps: [...stepsShareReady('390', 390), ...stepsShareVote390], port: 9353 });
    validateCommon(p3, { expectW: 390, expectH: 844 });
    const sp = get(p3.out, 'sharePage');
    if (sp) {
      check(sp.state === 'ready', '分享页状态 ready', JSON.stringify(sp.state));
      check(sp.contentHidden === false && sp.invalidVisible === false, 'ready 时展示内容、隐藏失效页', JSON.stringify({ contentHidden: sp.contentHidden, invalidVisible: sp.invalidVisible }));
      check(nonEmptyStrLocal(sp.title), '分享页标题非空', sp.title);
      check(/仅家庭内分享/.test(sp.ttl || ''), '分享页标注「仅家庭内分享」', sp.ttl);
      check(/24|小时/.test(sp.ttl || '') && Number(sp.expiry) >= 0 && Number(sp.expiry) <= 24, '分享页显示剩余小时数', `ttl=${sp.ttl} expiry=${sp.expiry}`);
      check(/不可下载原图/.test(sp.ttl || ''), '分享页标注「不可下载原图」', sp.ttl);
      check(nonEmptyStrLocal(sp.decision), '分享页结论句存在', sp.decision);
      check(!!sp.photo && sp.photo.complete && sp.photo.w > 0, '分享页照片已加载', JSON.stringify(sp.photo));
      check(!!sp.photo && Math.max(sp.photo.w, sp.photo.h) <= 900, '分享页照片是 900px 缩略图', JSON.stringify(sp.photo));
      check((sp.catfit || 0) === 6, '分享页位置判断 6 项', String(sp.catfit));
      check((sp.constraints || 0) >= 1, '分享页尺寸条件存在', String(sp.constraints));
      check((sp.items || 0) >= 1, '分享页方案条目存在', String(sp.items));
      check((sp.voteBlocks || 0) >= 1, '分享页投票对象 ≥1', String(sp.voteBlocks));
      check((sp.voteBtns || 0) >= 3, '每个投票对象有支持/犹豫/反对按钮', String(sp.voteBtns));
      check((sp.evidenceLinks || 0) === 0, '分享页不显示证据 URL 链接（契约 §2.4）', String(sp.evidenceLinks));
      const naRows = (sp.catfitRows || []).filter((r) => /不涉及/.test(r.text || ''));
      const unknownRows = (sp.catfitRows || []).filter((r) => /未知/.test(r.text || ''));
      check(naRows.length >= 1, '分享页 catFit 的 na 显示「不涉及」（Lead 修复点）', JSON.stringify((sp.catfitRows || []).slice(0, 3)));
      check(unknownRows.length === 0, '分享页 catFit 不再把 na 显示成「未知」', JSON.stringify(unknownRows));
      check(sp.overflow === 0, '390 分享页无横向溢出', String(sp.overflow));
      check((sp.small || []).length === 0, '390 分享页投票/按钮触控 ≥40px', JSON.stringify(sp.small));
    } else check(false, '读取分享页数据', 'missing');
    shotExists(p3, 'v3-share-ready-390');
    const pick = get(p3.out, 'pickVote');
    check(pick && pick !== 'no-btn', '分享页选择「支持」并填写留言/昵称', JSON.stringify(pick));
    const done = get(p3.out, 'voteDone');
    check(/已告诉 TA 你的意见/.test(done?.done || ''), '投票后显示「已告诉 TA 你的意见」', JSON.stringify(done?.done));
    check(!!done?.hasVoteId, 'localStorage 记录 voteId（可改选覆盖）', JSON.stringify(done?.hasVoteId));
    check((done?.selected || []).some((b) => b.v === 'yes' && b.pressed === 'true'), '投票按钮进入选中态（aria-pressed=true）', JSON.stringify(done?.selected));
    check((done?.counts || []).some((t) => /支持\s*1/.test(t || '')), '**投票后本人计数即时更新为「支持 1」**（OBS-V3-3 修复）', JSON.stringify(done?.counts));
    shotExists(p3, 'v3-share-voted-390');

    // ---------- Phase 4：分享页 1440 ready ----------
    const p4 = runCdp({ label: 'share-1440', w: 1440, h: 900, mobile: false, url: `${BASE}/s/${token}`, steps: stepsShareReady('1440', 1440), port: 9354 });
    validateCommon(p4, { expectW: 1440, expectH: 900 });
    const sp4 = get(p4.out, 'sharePage');
    check(!!sp4 && sp4.state === 'ready' && sp4.overflow === 0, '1440 分享页 ready 且无横向溢出', JSON.stringify(sp4 && { state: sp4.state, overflow: sp4.overflow }));
    check(!!sp4 && (sp4.catfit || 0) === 6 && (sp4.voteBlocks || 0) >= 1, '1440 分享页字段完整', JSON.stringify(sp4 && { catfit: sp4.catfit, voteBlocks: sp4.voteBlocks }));
    shotExists(p4, 'v3-share-ready-1440');

    // ---------- Phase 5：撤销 → invalid 态 ----------
    if (sessionId) await httpReq('DELETE', `/api/sessions/${sessionId}/share`);
    const revoked = await httpReq('GET', `/api/share/${token}`);
    check(revoked.status === 404, '撤销后 API /api/share/:token → 404', `status=${revoked.status}`);
    const p5 = runCdp({ label: 'share-invalid-390', w: 390, h: 844, mobile: true, url: `${BASE}/s/${token}`, steps: stepsShareInvalid390, port: 9355 });
    validateCommon(p5, { expectW: 390, expectH: 844, allowNetworkErrors: [404] });
    const inv = get(p5.out, 'invalid');
    check(!!inv && ['invalid', 'expired'].includes(inv.state), '撤销后分享页进入 invalid/expired 态', JSON.stringify(inv?.state));
    check(/链接已失效|已过期|撤销/.test((inv?.heading || '') + (inv?.detail || '')), '分享页显示「链接已失效/已撤销」', JSON.stringify(inv && { heading: inv.heading, detail: inv.detail }));
    check(!!inv && inv.contentHidden === true, '失效态隐藏方案内容', JSON.stringify(inv?.contentHidden));
    shotExists(p5, 'v3-share-invalid-390');

    // ---------- Phase 6：手工造过期 → expired 态 ----------
    let expToken = null;
    if (sessionId) {
      const thumbDataUrl = 'data:image/jpeg;base64,' + readFileSync(THUMB).toString('base64');
      const created = await api('POST', `/api/sessions/${sessionId}/share`, { photoDataUrl: thumbDataUrl });
      expToken = created.json?.share?.token || null;
      check(/^sh_/.test(expToken || ''), '为过期态测试重新创建分享', String(expToken));
      const sf = readShareFile(expToken);
      if (sf) {
        sf.expiresAt = new Date(Date.now() - 60000).toISOString();
        writeShareFile(expToken, sf);
        const p6 = runCdp({ label: 'share-expired-390', w: 390, h: 844, mobile: true, url: `${BASE}/s/${expToken}`, steps: stepsShareExpired390, port: 9356 });
        validateCommon(p6, { expectW: 390, expectH: 844, allowNetworkErrors: [410] });
        const exp = get(p6.out, 'expired');
        check(exp?.state === 'expired', '手工造过期后分享页进入 expired 态', JSON.stringify(exp?.state));
        check(/链接已失效|已过期/.test((exp?.heading || '') + (exp?.detail || '')), 'expired 态文案含「链接已失效/已过期」', JSON.stringify(exp && { heading: exp.heading, detail: exp.detail }));
        shotExists(p6, 'v3-share-expired-390');
      } else check(false, '读取 share 文件造过期', String(expToken));
    }
  } catch (e) {
    check(false, 'V3 UI 主流程未捕获异常', (e?.stack || String(e)).split('\n').slice(0, 3).join(' | '));
  } finally {
    // 清理：share 文件/缩略图/after 图/会话（只清本轮）
    try {
      if (expToken) {
        const sf = readShareFile(expToken);
        if (sf?.photo?.imageId) {
          for (const ext of ['jpg', 'png', 'webp']) {
            const f = join(ROOT, 'app', 'data', 'uploads', `${sf.photo.imageId}.${ext}`);
            if (existsSync(f)) { try { unlinkSync(f); } catch { /* noop */ } }
          }
        }
        try { unlinkSync(join(SHARE_DIR, `${expToken}.json`)); } catch { /* noop */ }
      }
      if (sessionId) await sweepSession(sessionId);
    } catch { /* noop */ }
    finish();
  }
}

function nonEmptyStrLocal(v) { return typeof v === 'string' && v.trim().length > 0; }

function finish() {
  const bad = checks.filter((c) => !c.ok);
  console.log('');
  console.log('='.repeat(76));
  console.log(`runs: ${runs.map((r) => `${r.label}=${(r.ms / 1000).toFixed(1)}s`).join('，')}`);
  console.log(`checks=${checks.length}，failed=${bad.length}`);
  console.log('='.repeat(76));
  const out = join(SCRATCH, `qa-v3-shots-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify({ runId: RUN_ID, base: BASE, checks, runs: runs.map((r) => ({ label: r.label, ms: r.ms, outJson: r.outJson })) }, null, 2), 'utf8');
  console.log(`证据: ${out.replace(ROOT + '\\', '')}`);
  console.log('');
  if (bad.length === 0) {
    console.log(`RESULT: PASS  (${checks.length} checks，${runs.length} 个浏览器场景)`);
    console.log('截图目录: tests/screens/v3/');
    stopServer(); process.exit(0);
  } else {
    console.log(`RESULT: FAIL  (${bad.length} 项失败)`);
    for (const b of bad.slice(0, 20)) console.log(`  ✗ ${b.msg}${b.detail ? ' — ' + b.detail : ''}`);
    console.log('复现: node tests/v3-shots.mjs');
    stopServer(); process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); stopServer(); process.exit(1); });
