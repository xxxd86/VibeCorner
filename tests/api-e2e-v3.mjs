#!/usr/bin/env node
// tests/api-e2e-v3.mjs —— V3 契约验收（服务端 + 分享页数据）
//
// 覆盖 docs/CONTRACT-V3.md：
//   §1   share 生命周期（创建/复用/查询/撤销）、expiresAt≈24h
//   §1.1 ShareView 字段齐全 + 脱敏（不得含 measurements/picks/profile/metrics/quality/voteId/imageId）
//   §1   /api/share/:token/photo 只给客户端生成的 900px 缩略图（Content-Length < 200KB、长边 ≤900、非原图）
//   §1.2 Vote：同一 voteId+targetId 覆盖；targets 聚合 support/unsure/oppose 正确
//   §1   owner votes：票+留言可见、匿名默认「家人 N」、不暴露 voteId
//   §1   after：上传/读取/分享页 afterPhotoUrl/删除
//   §1   边界：未生成 plan 400、未知 token 404、过期 token 410（手改 share 文件造过期，测完清理）
//   §0   隐私：分享响应 grep 不到用户名/ voteId / metrics / 原始测量 JSON / 原图 imageId
//
// 用法: node tests/api-e2e-v3.mjs [--only=...]
// 退出码: 0 全绿 / 1 有失败 / 2 前置缺失 / 3 AI 未就绪

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { join, resolve } from 'node:path';
import {
  ROOT, BASE, SERVER_ENTRY, httpReq, api, analyzeFlexible, ensureServer, stopServer, healthUp,
  loadImage, isNum, nonEmptyStr, isEnum, validBbox, charLen, sleep,
} from './lib-qa.mjs';

const IMG_OK = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img2_annotate.jpg');
const IMG_AFTER = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img3_measure.jpg');
const THUMB = join(ROOT, 'tests', 'fixtures', 'share-thumb.jpg');
const SHARE_DIR = join(ROOT, 'app', 'data', 'shares');
const SCRATCH = join(ROOT, '.scratch');
mkdirSync(SCRATCH, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
const KEEP_DATA = process.env.QA_V3_KEEP_DATA === '1';

const MEASURE_KEYS = ['corridorWidth', 'cornerWidthA', 'cornerWidthB', 'freeDepth', 'obstructionH', 'ceilingFree', 'outletDist', 'doorSwing', 'windowDist'];
const SAMPLE_CM = { corridorWidth: 62, cornerWidthA: 100, cornerWidthB: 80, freeDepth: 60, obstructionH: 75, ceilingFree: 120, outletDist: 90, doorSwing: 80, windowDist: 150 };
const PROFILE = { goal: '想给猫找个睡觉的角落', budget: 300, cats: 1, catSize: 'medium', catAge: 'adult', multiCat: false, floorType: 'wood', climate: 'mild' };

/* ---------------------------------------------------------------- 结果框架 */
const steps = [];
let current = null;
let failed = 0;
let totalChecks = 0;
const evidence = { runId: RUN_ID, startedAt: new Date().toISOString(), base: BASE, steps: [], sessions: {}, evidence: {} };
const fatal = [];
const log = (m) => console.log(m);
function check(cond, msg, detail) {
  totalChecks++;
  if (!current) return !!cond;
  if (cond) { current.pass++; return true; }
  current.issues.push({ msg, detail: detail === undefined ? '' : String(detail) });
  failed++;
  return false;
}
function softCheck(cond, msg, detail) {
  totalChecks++;
  if (!current) return !!cond;
  if (cond) { current.pass++; return true; }
  current.soft.push({ msg, detail: detail === undefined ? '' : String(detail) });
  return false;
}
function note(m) { if (current) current.notes.push(String(m)); }
async function step(name, fn) {
  const s = { name, ok: true, ms: 0, pass: 0, issues: [], soft: [], notes: [] };
  steps.push(s); evidence.steps.push(s); current = s;
  const t0 = Date.now();
  try { await fn(s); } catch (e) { s.issues.push({ msg: '未捕获异常: ' + (e?.message || String(e)), detail: e?.stack ? String(e.stack).split('\n')[1] : '' }); }
  finally {
    s.ms = Date.now() - t0; s.ok = s.issues.length === 0;
    if (!s.ok) failed += s.issues.length;
    current = null;
    log(`[${s.ok ? 'PASS' : 'FAIL'}] ${name} (${(s.ms / 1000).toFixed(1)}s, ${s.pass} checks)`);
    for (const n of s.notes) log('        · ' + n);
    for (const w of s.soft) log('        ~ soft ' + w.msg + (w.detail ? ' — ' + w.detail : ''));
    for (const i of s.issues) log('        ✗ ' + i.msg + (i.detail ? ' — ' + i.detail : ''));
  }
  return s;
}

function timing(r) {
  const u = r.meta?.usage || null;
  return `total=${(r.ms / 1000).toFixed(2)}s ${u ? (u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0))) + 'tok' : 'tok n/a'} repaired=${r.meta?.repaired === true}`;
}
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}
function dataUrlOf(buf) { return 'data:image/jpeg;base64,' + buf.toString('base64'); }

async function createSession(profile = PROFILE) {
  const r = await api('POST', '/api/sessions', { profile });
  if (!r.json?.id) throw new Error('POST /api/sessions 失败: ' + r.text.slice(0, 200));
  return r.json;
}
async function upload(id, img) {
  const r = await api('POST', `/api/sessions/${id}/image`, { dataUrl: img.dataUrl, width: img.width, height: img.height, metrics: img.metrics }, { timeout: 60000 });
  return r.json?.session || r.json;
}
async function getSession(id) { return (await api('GET', `/api/sessions/${id}`)).json; }

/** 走完 quality → l0 → measure(收敛) → plan，返回各阶段 payload */
async function runToPlan(sessionId, img) {
  const flow = {};
  await upload(sessionId, img);
  let r = await analyzeFlexible(sessionId, 'quality', [{ metrics: img.metrics, profile: PROFILE }, {}]);
  flow.quality = r.final; flow.qualityMeta = r.meta;
  r = await analyzeFlexible(sessionId, 'l0', [{ profile: PROFILE }, {}]);
  flow.l0 = r.final;
  const directionId = flow.l0.recommend?.directionId || flow.l0.directions?.[0]?.id;
  let payload = { directionId, profile: PROFILE };
  for (let round = 1; round <= 5; round++) {
    r = await analyzeFlexible(sessionId, 'measure', [payload, directionId ? { directionId } : {}]);
    const qs = r.final.questions || [];
    if (!qs.length) break;
    const answers = {};
    for (const q of qs) answers[q.key] = { valueCm: q.key === 'corridorWidth' ? 55 : SAMPLE_CM[q.key] ?? 80 };
    payload = { directionId, profile: PROFILE, answers };
    flow.lastMeasure = r.final;
  }
  r = await analyzeFlexible(sessionId, 'plan', [{ directionId, profile: PROFILE }, { profile: PROFILE }, {}]);
  flow.plan = r.final; flow.planMeta = r.meta;
  return flow;
}

/** 读/写 share 文件（仅用于「过期 token 返回 410」测试；Lead 已授权，测完清理） */
function shareFile(token) { return join(SHARE_DIR, `${token}.json`); }
function readShareFile(token) {
  const f = shareFile(token);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
function writeShareFileRaw(token, obj) { writeFileSync(shareFile(token), JSON.stringify(obj, null, 2), 'utf8'); }
function removeShareFile(token) { try { if (existsSync(shareFile(token))) unlinkSync(shareFile(token)); } catch { /* noop */ } }

/* ---------------------------------------------------------------- 断言辅助 */
function assertShareView(view, flow, s) {
  const plan = flow.plan;
  for (const k of ['token', 'title', 'createdAt', 'expiresAt', 'ownerLabel', 'recognition', 'boundary', 'decision', 'decisionLabel', 'headline', 'annotations', 'catFit', 'constraints', 'items', 'targets', 'voteCount', 'disclaimer']) {
    check(Object.prototype.hasOwnProperty.call(view, k), `ShareView 含字段 ${k}`, JSON.stringify(Object.keys(view)));
  }
  check(/^sh_[a-f0-9]{16}$/.test(view.token || ''), 'ShareView.token 格式 sh_[a-f0-9]{16}', JSON.stringify(view.token));
  check(nonEmptyStr(view.title), 'ShareView.title 非空', JSON.stringify(view.title));
  check(isEnum(view.decision, ['ok', 'conditional', 'not_supported', 'insufficient']), 'ShareView.decision 与 plan.verdict 同义域', JSON.stringify(view.decision));
  check(view.decision === plan.verdict, 'ShareView.decision === plan.verdict', `view=${view.decision} plan=${plan.verdict}`);
  check(nonEmptyStr(view.decisionLabel), 'ShareView.decisionLabel 非空（人话结论）', JSON.stringify(view.decisionLabel));
  check(nonEmptyStr(view.headline), 'ShareView.headline 非空', JSON.stringify(view.headline));
  check(nonEmptyStr(view.recognition), 'ShareView.recognition 非空（具体指认）', JSON.stringify(view.recognition));
  check(nonEmptyStr(view.boundary), 'ShareView.boundary 非空（判断边界）', JSON.stringify(view.boundary));
  check(nonEmptyStr(view.disclaimer), 'ShareView.disclaimer 非空');
  // 照片
  check('photoUrl' in view, 'ShareView 含 photoUrl 字段', JSON.stringify(view.photoUrl));
  if (view.photoUrl) check(view.photoUrl === `/api/share/${view.token}/photo`, 'photoUrl 指向 token 化分享图（非原图 URL）', JSON.stringify(view.photoUrl));
  // annotations
  check(Array.isArray(view.annotations) && view.annotations.length <= 3, 'ShareView.annotations 数组且 ≤3', JSON.stringify(view.annotations?.length));
  for (const [i, a] of (view.annotations || []).entries()) {
    check(validBbox(a.bbox), `annotations[${i}].bbox 0—1`, JSON.stringify(a.bbox));
    check(nonEmptyStr(a.label), `annotations[${i}].label 非空`);
  }
  // catFit
  check(view.catFit && typeof view.catFit === 'object', 'ShareView.catFit 对象存在');
  check(isEnum(view.catFit?.verdict, ['good', 'caution', 'poor', 'unknown']), 'catFit.verdict 合法', JSON.stringify(view.catFit?.verdict));
  check(Array.isArray(view.catFit?.items) && view.catFit.items.length === 6, 'catFit.items 恰好 6 项', JSON.stringify(view.catFit?.items?.length));
  for (const [i, it] of (view.catFit?.items || []).entries()) {
    check(nonEmptyStr(it.key) && nonEmptyStr(it.label), `catFit.items[${i}] key/label 非空`);
    check(isEnum(it.status, ['pass', 'warn', 'fail', 'unknown', 'na']), `catFit.items[${i}].status 合法`, JSON.stringify(it.status));
    check(nonEmptyStr(it.why), `catFit.items[${i}].why 非空`);
    check(!Object.prototype.hasOwnProperty.call(it, 'basisId'), `catFit.items[${i}] 不在分享页暴露 basisId/URL（契约 §2.4）`, JSON.stringify(Object.keys(it)));
  }
  // constraints
  check(Array.isArray(view.constraints), 'ShareView.constraints 数组');
  for (const [i, c] of (view.constraints || []).entries()) {
    check(nonEmptyStr(c.label) && isEnum(c.status, ['pass', 'warn', 'fail', 'unknown']), `constraints[${i}] label/status 合法`, JSON.stringify(c));
  }
  // items
  check(Array.isArray(view.items), 'ShareView.items 数组');
  for (const [i, it] of (view.items || []).entries()) {
    check(nonEmptyStr(it.id) && nonEmptyStr(it.title), `items[${i}] id/title 非空`);
    check(isEnum(it.type, ['new', 'reuse']), `items[${i}].type 合法`, JSON.stringify(it.type));
    check(isEnum(it.fit, ['ok', 'blocked']), `items[${i}].fit 合法`, JSON.stringify(it.fit));
  }
  // targets
  check(Array.isArray(view.targets) && view.targets.length >= 1 && view.targets.length <= 5, 'targets 1—5 个可投票对象', JSON.stringify(view.targets?.length));
  for (const [i, t] of (view.targets || []).entries()) {
    check(nonEmptyStr(t.id) && nonEmptyStr(t.label) && ['item', 'direction'].includes(t.type), `targets[${i}] id/label/type 合法`, JSON.stringify(t));
    check([t.support, t.unsure, t.oppose].every(isNum), `targets[${i}] 聚合计数为数字`, JSON.stringify(t));
  }
  check(isNum(view.voteCount), 'ShareView.voteCount 数字', JSON.stringify(view.voteCount));
  // 脱敏
  const raw = JSON.stringify(view);
  for (const forbidden of ['measurements', 'picks', 'profile', 'metrics', 'quality', 'asks', 'voteId', 'analysisNote', 'imageId', '/api/image/']) {
    check(!raw.includes(`"${forbidden}"`) && !raw.includes(forbidden), `分享响应不含敏感字段 ${forbidden}`, raw.slice(0, 200));
  }
  check(!raw.includes(PROFILE.goal), '分享响应不含用户输入的 goal 文本', PROFILE.goal);
  if (flow.session?.image?.imageId) check(!raw.includes(flow.session.image.imageId), '分享响应不含原图 imageId', flow.session.image.imageId);
  // 原图地址不可从分享响应推出
  check(!/\/api\/image\//.test(raw), '分享响应不暴露 /api/image/ 原图路径');
  note(`decision=${view.decision} catFit=${view.catFit?.verdict} items=${view.items?.length} targets=${view.targets?.length} voteCount=${view.voteCount}`);
}

async function ownerVotes(id) {
  const r = await api('GET', `/api/sessions/${id}/votes`);
  return r.json;
}

/** 清理本轮测试产物：share 文件及其缩略图、afterImage、session（测试数据不留给用户） */
async function sweepSessionArtifacts(sid) {
  try {
    const s = await getSession(sid);
    if (!s) return;
    const uploads = [];
    if (s.afterImage?.imageId) uploads.push(s.afterImage.imageId);
    const tokens = [];
    if (s.share?.token) tokens.push(s.share.token);
    for (const tk of tokens) {
      const sf = readShareFile(tk);
      if (sf?.photo?.imageId) uploads.push(sf.photo.imageId);
      removeShareFile(tk);
    }
    for (const id of uploads) {
      for (const ext of ['jpg', 'png', 'webp']) {
        const f = join(ROOT, 'app', 'data', 'uploads', `${id}.${ext}`);
        if (existsSync(f)) { try { unlinkSync(f); } catch { /* noop */ } }
      }
    }
  } catch { /* noop */ }
}

/* ---------------------------------------------------------------- main */
async function main() {
  const tStart = Date.now();
  log('='.repeat(76));
  log(`api-e2e-v3 — V3 契约验收 (${BASE})`);
  log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  log('='.repeat(76));

  await step('0. 环境预检 / 服务端', async (s) => {
    check(existsSync(SERVER_ENTRY), '服务端入口存在');
    const health = await ensureServer();
    const h = health.json || {};
    check(h.ok === true, 'health.ok', health.text.slice(0, 160));
    check(h.hasKey === true && h.aiReady === true, 'hasKey && aiReady（真实 DeepSeek）', JSON.stringify({ hasKey: h.hasKey, aiReady: h.aiReady }));
    if (h.aiReady === false) fatal.push('aiReady=false');
    evidence.health = h;
  });

  if (fatal.length) { finish(tStart); return; }

  const img = loadImage(IMG_OK);
  const imgAfter = loadImage(IMG_AFTER);
  const thumbBuf = readFileSync(THUMB);
  const thumbDataUrl = dataUrlOf(thumbBuf);
  const thumbSize = jpegSize(thumbBuf);
  check(thumbSize && thumbSize.width === 900 && thumbSize.height === 675, '测试缩略图 fixture 900×675', JSON.stringify(thumbSize));

  let session = null;
  const cleanup = [];
  try {
    await step('1. 走完完整流程到 plan（为 share 准备真实会话）', async (s) => {
      session = await createSession();
      evidence.sessions.main = session.id;
      note(`session=${session.id}`);
      const flow = await runToPlan(session.id, img);
      evidence.plan = flow.plan;
      evidence.l0 = flow.l0;
      check(nonEmptyStr(flow.plan?.headline), 'plan.headline 非空', JSON.stringify(flow.plan?.headline));
      check(Array.isArray(flow.plan?.items), 'plan.items 数组');
      check(Array.isArray(flow.plan?.constraints) && flow.plan.constraints.length >= 1, 'plan.constraints 非空');
      evidence.sessionAfterPlan = await getSession(session.id);
      note(`plan ${timing({ ms: 0, meta: flow.planMeta })} verdict=${flow.plan.verdict} items=${(flow.plan.items || []).length} constraints=${(flow.plan.constraints || []).length}`);
      evidence.sessions.flow = flow;
    });
    if (!session) throw new Error('session 未创建');

    // ---------------- share 主流程 ----------------
    await step('2. share 生命周期：创建 / 复用 / 查询 / 24h', async (s) => {
      const before = await api('GET', `/api/sessions/${session.id}/share`);
      check(before.json?.share === null, '未分享时 GET share → {share:null}', JSON.stringify(before.json));
      // 先验证「不带缩略图」的回落行为（应被记为风险，主路径在下一步用缩略图）
      const raw = await api('POST', `/api/sessions/${session.id}/share`, {});
      check([200, 201].includes(raw.status), 'POST share 成功（复用或新建）', `status=${raw.status}`);
      const share = raw.json?.share;
      check(!!share?.token, 'POST share 返回 token', JSON.stringify(share));
      check(/^sh_[a-f0-9]{16}$/.test(share?.token || ''), 'token 格式 sh_[a-f0-9]{16}', JSON.stringify(share?.token));
      check(share?.url === `/s/${share.token}`, 'share.url = /s/<token>', JSON.stringify(share?.url));
      const exp = Date.parse(share?.expiresAt);
      const hours = (exp - Date.now()) / 3600000;
      check(hours > 23.5 && hours <= 24.5, 'expiresAt ≈ 创建后 24 小时', `${hours.toFixed(2)}h`);
      check(share?.hasPhoto === true, '默认 hasPhoto=true', JSON.stringify(share?.hasPhoto));
      evidence.shareNoThumb = share;
      // 无客户端缩略图时：服务端必须 404，绝不回落到会话主图（V3 修复 OBS-V3-1）
      const p0 = await httpReq('GET', `/api/share/${share.token}/photo`, { timeout: 15000 });
      check(p0.status === 404, '**无缩略图时分享图直接 404（绝不回落原图）**', `status=${p0.status} bytes=${p0.bytes}`);
      if (p0.status === 200) softCheck(false, '分享图仍在回落原图（OBS-V3-1 回归）', `bytes=${p0.bytes} 原图=${img.buf.length}`);
      // 删除旧分享，改用客户端 900px 缩略图创建主分享
      await api('DELETE', `/api/sessions/${session.id}/share`);
      const created = await api('POST', `/api/sessions/${session.id}/share`, { photoDataUrl: thumbDataUrl, hasPhoto: true });
      const share2 = created.json?.share;
      evidence.share = share2;
      check(/^sh_[a-f0-9]{16}$/.test(share2?.token || ''), '带缩略图创建 share 成功', JSON.stringify(share2));
      // 复用未过期分享
      const again = await api('POST', `/api/sessions/${session.id}/share`, {});
      check(again.json?.share?.token === share2.token, '未过期时重复创建 → 复用同一 token', `${again.json?.share?.token} vs ${share2.token}`);
      const got = await api('GET', `/api/sessions/${session.id}/share`);
      check(got.json?.share?.token === share2.token, 'GET session share 读回同一 token');
      note(`share=${share2.token} url=${share2.url} expiresAt=${share2.expiresAt}`);
    });

    const share = evidence.share;
    check(!!share?.token, '拿到主 share token');

    await step('3. ShareView 字段齐全 + 脱敏', async (s) => {
      const r = await httpReq('GET', `/api/share/${share.token}`, { timeout: 15000 });
      check(r.status === 200, 'GET /api/share/:token → 200', `status=${r.status} ${r.text.slice(0, 200)}`);
      const view = r.json || {};
      evidence.shareView = view;
      assertShareView(view, evidence.sessions.flow, s);
      check(!view.afterPhotoUrl, '未上传改造后照片时 afterPhotoUrl 为 null/缺省', JSON.stringify(view.afterPhotoUrl));
    });

    await step('4. 分享图 = 900px 缩略图（<200KB，非原图）', async (s) => {
      const r = await httpReq('GET', `/api/share/${share.token}/photo`, { timeout: 15000 });
      check(r.status === 200, 'GET share photo → 200', `status=${r.status}`);
      check(/^image\//.test(r.headers['content-type'] || ''), 'Content-Type=image/*', r.headers['content-type']);
      check(r.bytes < 200 * 1024, '**Content-Length < 200KB（证明是 900px 缩略图不是原图）**', `${r.bytes}B`);
      check(r.bytes !== img.buf.length, '分享图字节数 ≠ 原图（没有回落原图）', `share=${r.bytes} 原图=${img.buf.length}`);
      const dim = jpegSize(r.buffer);
      check(!!dim && Math.max(dim.width, dim.height) <= 900, '缩略图长边 ≤900px', dim ? `${dim.width}×${dim.height}` : '无法解析');
      check(r.buffer.equals(thumbBuf), '分享图 = 客户端上传的 900px 缩略图（逐字节一致）', `share=${r.bytes} fixture=${thumbBuf.length}`);
      check((r.headers['x-robots-tag'] || '').includes('noindex'), '分享图 noindex（不可被搜索引擎索引）', r.headers['x-robots-tag']);
      evidence.photo = { bytes: r.bytes, contentType: r.headers['content-type'], dim, equalsFixture: r.buffer.equals(thumbBuf) };
    });

    await step('5. 投票：覆盖 / 聚合 / 匿名命名', async (s) => {
      const viewBefore = (await api('GET', `/api/share/${share.token}`)).json;
      const targets = viewBefore.targets || [];
      check(targets.length >= 1, '有可投票 target', JSON.stringify(targets));
      const t1 = targets[0];
      const t2 = targets[1] || null;
      let expected = 0;
      // 缺少 targetId → 400
      const bad = await httpReq('POST', `/api/share/${share.token}/vote`, { body: { vote: 'yes' } });
      check(bad.status === 400, '缺 targetId → 400', `status=${bad.status}`);
      // 投票 1：室友 / 支持
      const v1 = await api('POST', `/api/share/${share.token}/vote`, { targetId: t1.id, targetType: t1.type, vote: 'yes', voteId: 'qa-vote-1', name: '室友', note: '这个窝好清理' });
      expected = 1;
      check(v1.json?.ok === true && v1.json?.voteCount === expected, '第一次投票 voteCount=1', JSON.stringify(v1.json));
      check(Array.isArray(v1.json?.targets) && v1.json.targets.length >= 1, 'vote 响应返回最新 targets（前端就地刷新计数）', JSON.stringify(v1.json?.targets?.length));
      check(v1.json?.counts?.yes === 1 && v1.json?.counts?.unsure === 0 && v1.json?.counts?.no === 0, 'vote 响应返回 counts（yes=1）', JSON.stringify(v1.json?.counts));
      // 同一 voteId+target 改选 → 不增加票数（最后一次的 note 生效）
      const v1b = await api('POST', `/api/share/${share.token}/vote`, { targetId: t1.id, targetType: t1.type, vote: 'unsure', voteId: 'qa-vote-1', name: '室友', note: '改主意了，先进去看看' });
      check(v1b.json?.voteCount === expected, '**同一 voteId+targetId 重复提交只计最后一次**（voteCount 不变）', JSON.stringify(v1b.json));
      check(v1b.json?.counts?.yes === 0 && v1b.json?.counts?.unsure === 1, '改选后 vote 响应 counts 同步（yes=0/unsure=1）', JSON.stringify(v1b.json?.counts));
      // 同一 voteId 不同 target → 各算一票
      if (t2 && t2.id !== t1.id) {
        const v2 = await api('POST', `/api/share/${share.token}/vote`, { targetId: t2.id, targetType: t2.type, vote: 'no', voteId: 'qa-vote-1', name: '室友' });
        expected += 1;
        check(v2.json?.voteCount === expected, '同一投票人对不同 target 分别计票', JSON.stringify(v2.json));
      } else note('只有一个 target，跳过「不同 target 各算一票」');
      // 另一个 voteId（匿名）→ 再算一票
      const va = await api('POST', `/api/share/${share.token}/vote`, { targetId: t1.id, targetType: t1.type, vote: 'yes', voteId: 'qa-vote-anon' });
      expected += 1;
      check(va.json?.voteCount === expected, '不同 voteId 算新票（匿名）', JSON.stringify(va.json));
      // 非法 vote 值 → 归一化为 unsure，仍计票
      const vx = await api('POST', `/api/share/${share.token}/vote`, { targetId: t1.id, targetType: t1.type, vote: 'maybe', voteId: 'qa-vote-x' });
      expected += 1;
      check(vx.status === 200 && vx.json?.voteCount === expected, '非法 vote 值归一化为 unsure 并计票', `status=${vx.status} count=${vx.json?.voteCount}`);
      // targets 聚合：t1 = support1(anon) / unsure2(qa-1改选+qa-x) / oppose0；t2 = oppose1
      const view = (await api('GET', `/api/share/${share.token}`)).json;
      const agg1 = (view.targets || []).find((t) => t.id === t1.id);
      check(agg1 && agg1.support === 1 && agg1.unsure === 2 && agg1.oppose === 0, 'targets 聚合正确（' + t1.id + '：支持1/犹豫2/反对0）', JSON.stringify(agg1));
      if (t2 && t2.id !== t1.id) {
        const agg2 = (view.targets || []).find((t) => t.id === t2.id);
        check(agg2 && agg2.oppose === 1, 'targets 聚合正确（' + t2.id + '：反对1）', JSON.stringify(agg2));
      }
      check(view.voteCount === expected, 'ShareView.voteCount 与总票数一致', `view=${view.voteCount} expected=${expected}`);
      // owner 视角
      const ov = await ownerVotes(session.id);
      check(Array.isArray(ov?.votes) && ov.votes.length === expected, 'owner GET votes 票数一致', `votes=${ov?.votes?.length} expected=${expected}`);
      check(isNum(ov?.counts?.yes) && isNum(ov?.counts?.unsure) && isNum(ov?.counts?.no), 'owner counts 有 yes/unsure/no', JSON.stringify(ov?.counts));
      check(ov.counts.yes === 1 && ov.counts.unsure === 2 && ov.counts.no === (t2 && t2.id !== t1.id ? 1 : 0), 'owner counts 正确', JSON.stringify(ov.counts));
      const named = ov.votes.find((v) => v.name === '室友');
      check(!!named, 'owner 能看到投票人昵称「室友」', JSON.stringify(ov.votes.map((v) => v.name)));
      check(!!named && named.note === '改主意了，先进去看看', 'owner 能看到最后一次留言（改选后 note 覆盖）', JSON.stringify(named?.note));
      check(ov.votes.every((v) => !Object.prototype.hasOwnProperty.call(v, 'voteId')), 'owner votes 不暴露 voteId', JSON.stringify(Object.keys(ov.votes[0] || {})));
      check(ov.votes.some((v) => /^家人 \d+$/.test(v.name || '')), '匿名票默认名「家人 N」', JSON.stringify(ov.votes.map((v) => v.name)));
      evidence.votes = ov;
      // 未知 targetId：服务端必须 400 bad_target（V3 修复 OBS-V3-4），且不能污染 voteCount
      const unknown = await httpReq('POST', `/api/share/${share.token}/vote`, { body: { targetId: 'i_not_a_target', targetType: 'item', vote: 'yes', voteId: 'qa-vote-unknown' } });
      check(unknown.status === 400, '**未知 targetId 投票 → 400**', `status=${unknown.status}`);
      check(unknown.json?.error?.code === 'bad_target', '未知 targetId 错误码 bad_target', JSON.stringify(unknown.json?.error));
      const viewAfterUnknown = (await api('GET', `/api/share/${share.token}`)).json;
      check(viewAfterUnknown.voteCount === expected, '未知 targetId 未污染 voteCount', `view=${viewAfterUnknown.voteCount} expected=${expected}`);
    });

    await step('6. 改造后照片：上传 / 分享页出现 / 删除', async (s) => {
      const up = await api('POST', `/api/sessions/${session.id}/after`, { dataUrl: imgAfter.dataUrl, width: imgAfter.width, height: imgAfter.height }, { timeout: 60000 });
      const after = up.json?.session?.afterImage;
      check(!!after?.imageId, 'POST after → session.afterImage.imageId', JSON.stringify(after));
      check(after?.url === `/api/image/${after?.imageId}`, 'afterImage.url 指向图片', JSON.stringify(after?.url));
      const imgRes = await httpReq('GET', after.url, { timeout: 15000 });
      check(imgRes.status === 200 && imgRes.bytes === imgAfter.buf.length, 'GET afterImage 字节数与上传一致', `status=${imgRes.status} bytes=${imgRes.bytes}`);
      const view = (await api('GET', `/api/share/${share.token}`)).json;
      check(view.afterPhotoUrl === `/api/share/${share.token}/photo?kind=after`, 'ShareView.afterPhotoUrl 出现', JSON.stringify(view.afterPhotoUrl));
      const ph = await httpReq('GET', view.afterPhotoUrl, { timeout: 15000 });
      check(ph.status === 200, '分享页可读取改造后照片', `status=${ph.status}`);
      const del = await api('DELETE', `/api/sessions/${session.id}/after`);
      check(del.json?.ok === true, 'DELETE after → {ok:true}', JSON.stringify(del.json));
      const sess = await getSession(session.id);
      check(sess.afterImage === null, '删除后 session.afterImage=null', JSON.stringify(sess.afterImage));
      const view2 = (await api('GET', `/api/share/${share.token}`)).json;
      check(!view2.afterPhotoUrl, '删除后 ShareView.afterPhotoUrl 消失', JSON.stringify(view2.afterPhotoUrl));
      const ph2 = await httpReq('GET', `/api/share/${share.token}/photo?kind=after`, { timeout: 15000 });
      check(ph2.status === 404, '删除后分享页改造后照片 404', `status=${ph2.status}`);
      evidence.after = { uploaded: after, deleted: true };
    });

    await step('7. 边界：未生成 plan 400 / 未知 token 404 / 过期 token 410', async (s) => {
      // 未生成 plan
      const bare = await createSession({ goal: '' });
      evidence.sessions.bare = bare.id;
      const r400 = await httpReq('POST', `/api/sessions/${bare.id}/share`, {});
      check(r400.status === 400, '未生成 plan 时创建分享 → 400', `status=${r400.status} ${r400.text.slice(0, 120)}`);
      check(r400.json?.error?.code === 'no_plan', '错误码 no_plan', JSON.stringify(r400.json?.error));
      await httpReq('DELETE', `/api/sessions/${bare.id}`);
      // 未知/非法 token
      const nf = await httpReq('GET', '/api/share/sh_0123456789abcdef');
      check(nf.status === 404, '未知（格式合法）token → 404', `status=${nf.status}`);
      const mal = await httpReq('GET', '/api/share/not-a-token');
      check(mal.status === 404, '非法格式 token → 404', `status=${mal.status}`);
      // 过期 token：手改 share 文件的 expiresAt（Lead 授权，测完清理）
      const file = shareFile(share.token);
      check(existsSync(file), 'share 文件存在（用于造过期）', file.replace(ROOT + '\\', ''));
      const raw = readShareFile(share.token);
      evidence.shareFileBackup = raw;
      if (raw) {
        raw.expiresAt = new Date(Date.now() - 60_000).toISOString();
        writeShareFileRaw(share.token, raw);
        const expired = await httpReq('GET', `/api/share/${share.token}`);
        check(expired.status === 410, '**过期 token → 410**', `status=${expired.status}`);
        check(expired.json?.error?.code === 'expired', '过期错误码 expired', JSON.stringify(expired.json?.error));
        const expPhoto = await httpReq('GET', `/api/share/${share.token}/photo`);
        check(expPhoto.status === 410, '过期 token 的照片 → 410', `status=${expPhoto.status}`);
        const expVote = await httpReq('POST', `/api/share/${share.token}/vote`, { body: { targetId: 'x', vote: 'yes' } });
        check(expVote.status === 410, '过期 token 的投票 → 410', `status=${expVote.status}`);
        const expVotes = await ownerVotes(session.id);
        check(expVotes?.expired === true || expVotes?.voteCount === 0, 'owner votes 对过期分享显示 expired/空', JSON.stringify(expVotes));
      }
      // 恢复文件内容（撤销测试仍走 API）
      if (raw) { raw.expiresAt = evidence.shareFileBackup.expiresAt; writeShareFileRaw(share.token, raw); }
    });

    await step('8. 撤销分享：立即 404 + 页面失效 + 无残留', async (s) => {
      const del = await api('DELETE', `/api/sessions/${session.id}/share`);
      check(del.json?.ok === true, 'DELETE share → {ok:true}', JSON.stringify(del.json));
      const view = await httpReq('GET', `/api/share/${share.token}`);
      check(view.status === 404, '**撤销后 GET /api/share/:token → 404**', `status=${view.status}`);
      const ph = await httpReq('GET', `/api/share/${share.token}/photo`);
      check(ph.status === 404, '撤销后分享图 → 404', `status=${ph.status}`);
      const sess = await getSession(session.id);
      check(sess.share === null, '撤销后 session.share=null', JSON.stringify(sess.share));
      const got = await api('GET', `/api/sessions/${session.id}/share`);
      check(got.json?.share === null, '撤销后 GET session share → {share:null}');
      const ov = await ownerVotes(session.id);
      check((ov?.votes || []).length === 0 && ov?.voteCount === 0, '撤销后 owner votes 空', JSON.stringify(ov));
      check(!existsSync(shareFile(share.token)), '撤销后 share 文件已删除', shareFile(share.token).replace(ROOT + '\\', ''));
    });

    await step('9. 无照片分享 + 分享页 HTML 可访问（/s/<token>）', async (s) => {
      // hasPhoto:false → photoUrl null、照片 404
      const noPhoto = await api('POST', `/api/sessions/${session.id}/share`, { hasPhoto: false, photoDataUrl: '' });
      const npTok = noPhoto.json?.share?.token;
      check(/^sh_/.test(npTok || ''), '创建 hasPhoto:false 分享成功', JSON.stringify(noPhoto.json));
      check(noPhoto.json?.share?.hasPhoto === false, 'share.hasPhoto=false', JSON.stringify(noPhoto.json?.share));
      const npView = (await api('GET', `/api/share/${npTok}`)).json;
      check(!npView?.photoUrl, '无照片分享的 photoUrl 为空', JSON.stringify(npView?.photoUrl));
      const npPhoto = await httpReq('GET', `/api/share/${npTok}/photo`);
      check(npPhoto.status === 404, '无照片分享的照片 → 404', `status=${npPhoto.status}`);
      evidence.shareNoPhoto = noPhoto.json?.share;
      await api('DELETE', `/api/sessions/${session.id}/share`);
      // 重新创建一个带缩略图的分享用于页面可访问性检查
      const created = await api('POST', `/api/sessions/${session.id}/share`, { photoDataUrl: thumbDataUrl });
      const tok = created.json?.share?.token;
      evidence.share2 = created.json?.share;
      check(/^sh_/.test(tok || ''), '重新创建 share 成功', JSON.stringify(created.json));
      const page = await httpReq('GET', `/s/${tok}`, { timeout: 15000 });
      check(page.status === 200, 'GET /s/<token> → 200', `status=${page.status}`);
      check(/text\/html/.test(page.headers['content-type'] || ''), '分享页 Content-Type text/html', page.headers['content-type']);
      check(/id="share-root"/.test(page.text), '分享页含 #share-root', `${page.bytes}B`);
      check(/share\.js/.test(page.text), '分享页加载 js/share.js');
      check(/share\.css/.test(page.text), '分享页加载 styles/share.css');
      const view = (await api('GET', `/api/share/${tok}`)).json;
      check(view?.token === tok, '分享页对应 ShareView 可读');
      // 清理页面测试用分享
      await api('DELETE', `/api/sessions/${session.id}/share`);
    });

    await step('10. PWA：manifest / icons / index.html 引用', async (s) => {
      const manifestRes = await httpReq('GET', '/manifest.webmanifest', { timeout: 10000 });
      check(manifestRes.status === 200, 'GET /manifest.webmanifest → 200', `status=${manifestRes.status}`);
      check(/application\/manifest\+json/.test(manifestRes.headers['content-type'] || ''), 'manifest Content-Type application/manifest+json', manifestRes.headers['content-type']);
      const mf = manifestRes.json || {};
      check(nonEmptyStr(mf.name) && nonEmptyStr(mf.short_name), 'manifest 有 name/short_name', JSON.stringify({ name: mf.name, short_name: mf.short_name }));
      check(nonEmptyStr(mf.start_url), 'manifest 有 start_url', JSON.stringify(mf.start_url));
      check(mf.display === 'standalone' || mf.display === 'minimal-ui', 'manifest display=standalone/minimal-ui', JSON.stringify(mf.display));
      check(Array.isArray(mf.icons) && mf.icons.length >= 2, 'manifest icons ≥2', JSON.stringify(mf.icons?.length));
      const icons = Array.isArray(mf.icons) ? mf.icons : [];
      const sizes = icons.map((i) => String(i.sizes || ''));
      check(sizes.includes('192x192'), 'icons 含 192×192', JSON.stringify(sizes));
      check(sizes.includes('512x512'), 'icons 含 512×512', JSON.stringify(sizes));
      check(icons.some((i) => /maskable/.test(String(i.purpose || ''))), 'icons 含 maskable', JSON.stringify(icons.map((i) => i.purpose)));
      for (const icon of icons) {
        const ir = await httpReq('GET', icon.src, { timeout: 10000 });
        check(ir.status === 200, `icon ${icon.src} → 200`, `status=${ir.status}`);
        check(/image\/(png|jpeg|svg)/.test(ir.headers['content-type'] || ''), `icon ${icon.src} Content-Type image/*`, ir.headers['content-type']);
        if (ir.status === 200 && /png/.test(ir.headers['content-type'] || '')) {
          const b = ir.buffer;
          if (b && b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
            const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
            const want = String(icon.sizes || '');
            if (/^\d+x\d+$/.test(want)) check(want === `${w}x${h}`, `icon ${icon.src} 实际尺寸 ${w}×${h} 与声明一致`, want);
          }
        }
      }
      const html = await httpReq('GET', '/', { timeout: 15000 });
      check(/rel="manifest"/.test(html.text), 'index.html 引用 manifest', '');
      check(/apple-touch-icon/.test(html.text), 'index.html 有 apple-touch-icon', '');
      check(/theme-color/.test(html.text), 'index.html 有 theme-color', '');
      evidence.pwa = { manifest: mf, icons: icons.map((i) => i.src) };
    });
    await step('11. 静态资源 gzip / API 不压缩', async (s) => {
      const css = await httpReq('GET', '/styles/components.css', { headers: { 'accept-encoding': 'gzip' }, timeout: 15000 });
      check(css.status === 200, 'GET components.css（Accept-Encoding: gzip）→ 200', `status=${css.status}`);
      check(css.headers['content-encoding'] === 'gzip', '静态 CSS 响应含 Content-Encoding: gzip', JSON.stringify(css.headers['content-encoding']));
      const cl = Number(css.headers['content-length'] || 0);
      check(cl > 0 && cl < 20000, 'gzip 后 Content-Length < 20000（实测 15830 期望量级）', String(cl));
      const plain = await httpReq('GET', '/styles/components.css', { headers: { 'accept-encoding': 'identity' }, timeout: 15000 });
      check(plain.status === 200 && !plain.headers['content-encoding'], '不带 gzip 时静态 CSS 正常返回且无 Content-Encoding', `status=${plain.status} ce=${plain.headers['content-encoding']}`);
      check(Number(plain.headers['content-length'] || 0) > cl, '回退路径返回原始大小（大于 gzip 后）', `plain=${plain.headers['content-length']} gzip=${cl}`);
      const js = await httpReq('GET', '/js/cards.js', { headers: { 'accept-encoding': 'gzip' }, timeout: 15000 });
      check(js.status === 200 && js.headers['content-encoding'] === 'gzip', '静态 JS（cards.js）也 gzip', `ce=${js.headers['content-encoding']} cl=${js.headers['content-length']}`);
      const html = await httpReq('GET', '/index.html', { headers: { 'accept-encoding': 'gzip' }, timeout: 15000 });
      check(html.status === 200 && html.headers['content-encoding'] === 'gzip', 'index.html gzip', `ce=${html.headers['content-encoding']} cl=${html.headers['content-length']}`);
      const shareHtml = await httpReq('GET', '/share.html', { headers: { 'accept-encoding': 'gzip' }, timeout: 15000 });
      check(shareHtml.status === 200 && shareHtml.headers['content-encoding'] === 'gzip', 'share.html gzip', `ce=${shareHtml.headers['content-encoding']} cl=${shareHtml.headers['content-length']}`);
      const apiEv = await httpReq('GET', '/api/evidence', { headers: { 'accept-encoding': 'gzip' }, timeout: 10000 });
      check(apiEv.status === 200 && !apiEv.headers['content-encoding'], '/api/evidence 不被 gzip（API 不压缩）', `ce=${apiEv.headers['content-encoding']}`);
      check(!/gzip/.test(String(apiEv.json?.version || '')), '/api/evidence JSON 可正常解析（未压缩）', JSON.stringify(apiEv.json?.count));
      evidence.gzip = { css: { gzip: cl, plain: plain.headers['content-length'] }, apiEncoding: apiEv.headers['content-encoding'] || null };
    });

    await step('12. 局域网限制 + SHARE_TTL_HOURS 测试钩子', async (s) => {
      // 重新创建一个带缩略图的分享用于 LAN 检查
      const created = await api('POST', `/api/sessions/${session.id}/share`, { photoDataUrl: thumbDataUrl });
      const tok = created.json?.share?.token;
      check(/^sh_/.test(tok || ''), '为 LAN/TTL 测试重建分享', String(tok));
      const loop = await httpReq('GET', `/api/share/${tok}`, { timeout: 10000 });
      check(loop.status === 200, 'loopback 访问 /api/share/:token → 200', `status=${loop.status}`);
      const page = await httpReq('GET', `/s/${tok}`, { timeout: 10000 });
      check(page.status === 200 && /text\/html/.test(page.headers['content-type'] || ''), 'loopback 访问 /s/:token → 200 HTML', `status=${page.status}`);
      const localIps = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      let lanOk = 0;
      for (const ip of localIps) {
        try {
          const r = await httpReq('GET', `/api/share/${tok}`, { host: ip, timeout: 5000 });
          if (r.status === 200) lanOk += 1;
        } catch { /* 网卡不可达则跳过 */ }
      }
      if (localIps.length) check(lanOk > 0, '局域网网卡（192.168/10/172.16-31）访问放行', `候选=${JSON.stringify(localIps)} 成功=${lanOk}`);
      else note('本机没有非 loopback IPv4，私网放行仅按代码路径记录（isLanRequest: loopback/10/172.16-31/192.168 放行，其余 403 lan_only）');
      evidence.lan = { token: tok, localIps, lanOk };
      // SHARE_TTL_HOURS 钩子：独立端口起第二个服务端（同一数据目录），验证 TTL 改为 1h（不是默认 24h）
      // 注意：store 里 `Math.max(1, CONFIG.shareTtlHours)` 会把 TTL 钳到最小 1 小时，
      // 因此无法用 <1h 做快速过期；过期 410 的端到端验证在 step 7 通过手改 expiresAt 完成。
      const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        env: { ...process.env, PORT: '8851', SHARE_TTL_HOURS: '1', SHARE_LAN_ONLY: '0' },
        stdio: 'ignore',
      });
      const port = 8851;
      try {
        let up = false;
        for (let i = 0; i < 50; i++) {
          try { const h = await httpReq('GET', '/api/health', { port, timeout: 1000 }); if (h.status === 200) { up = true; break; } } catch { /* retry */ }
          await sleep(200);
        }
        check(up, 'SHARE_TTL_HOURS 测试服务端（:8851）启动', `up=${up}`);
        if (up) {
          await httpReq('DELETE', `/api/sessions/${session.id}/share`, { port });
          const shortShare = await httpReq('POST', `/api/sessions/${session.id}/share`, { body: { photoDataUrl: thumbDataUrl }, port, timeout: 15000 });
          const stok = shortShare.json?.share?.token;
          check(/^sh_/.test(stok || ''), '短 TTL 分享创建成功', String(stok));
          const ttlMs = Date.parse(shortShare.json?.share?.expiresAt) - Date.now();
          check(ttlMs > 55 * 60000 && ttlMs < 65 * 60000, '**SHARE_TTL_HOURS 生效（约 1 小时，而非默认 24h）**', `${(ttlMs / 3600000).toFixed(2)}h`);
          note('TTL 实现有 Math.max(1, ...) 钳制，小于 1 小时无法配置；过期 410 由 step 7 手改 expiresAt 覆盖');
          await httpReq('DELETE', `/api/sessions/${session.id}/share`, { port });
        }
      } finally {
        try { child.kill(); } catch { /* noop */ }
      }
    });
  } finally {
    // 清理测试会话与可能残留的 share/缩略图文件（只删本轮创建的）
    try {
      for (const tk of [evidence.share?.token, evidence.shareNoThumb?.token, evidence.shareNoPhoto?.token, evidence.share2?.token].filter(Boolean)) {
        const sf = readShareFile(tk);
        if (sf?.photo?.imageId) {
          for (const ext of ['jpg', 'png', 'webp']) {
            const f = join(ROOT, 'app', 'data', 'uploads', `${sf.photo.imageId}.${ext}`);
            if (existsSync(f)) { try { unlinkSync(f); } catch { /* noop */ } }
          }
        }
        removeShareFile(tk);
      }
      for (const sid of [evidence.sessions.main, evidence.sessions.bare].filter(Boolean)) {
        if (KEEP_DATA) break;
        await sweepSessionArtifacts(sid);
        await httpReq('DELETE', `/api/sessions/${sid}`);
      }
    } catch { /* noop */ }
    finish(tStart);
  }
}

function finish(tStart) {
  const totalMs = Date.now() - tStart;
  const bad = steps.filter((s) => !s.ok);
  log('');
  log('='.repeat(76));
  for (const s of steps) log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${(s.ms / 1000).toFixed(1).padStart(6)}s  ${s.name}  (${s.pass} checks)`);
  log(`  合计 ${(totalMs / 1000).toFixed(1)}s，checks=${totalChecks}，失败阶段=${bad.length}`);
  log('='.repeat(76));
  evidence.finishedAt = new Date().toISOString();
  evidence.totalMs = totalMs;
  evidence.totalChecks = totalChecks;
  const out = join(SCRATCH, `qa-e2e-v3-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
  log(`证据: ${out.replace(ROOT + '\\', '')}`);
  log('');
  if (fatal.length) { log('RESULT: FAIL（依赖阻塞）: ' + fatal.join(' ; ')); stopServer(); process.exit(3); }
  if (bad.length === 0) { log(`RESULT: PASS  (${steps.length} 阶段, ${totalChecks} checks, ${(totalMs / 1000).toFixed(1)}s)`); stopServer(); process.exit(0); }
  log(`RESULT: FAIL  (${bad.length} 阶段失败)`);
  for (const s of bad) for (const i of s.issues.slice(0, 8)) log(`  ✗ ${s.name}: ${i.msg}${i.detail ? ' — ' + i.detail : ''}`);
  log('复现: node tests/api-e2e-v3.mjs');
  stopServer(); process.exit(1);
}

process.on('SIGINT', () => { stopServer(); process.exit(130); });
main().catch((e) => { console.error('FATAL:', e?.stack || e); stopServer(); process.exit(1); });
