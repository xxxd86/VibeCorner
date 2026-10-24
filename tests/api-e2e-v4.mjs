#!/usr/bin/env node
// tests/api-e2e-v4.mjs —— V4 契约验收：家人回应（从表态到行动）+ 回传照片 + after-from-respond
//
// 覆盖 docs/CONTRACT-V4.md：
//   §1.1 POST /api/share/:token/respond（4 种 action、consent、deviceId+action 覆盖、photo 每次新增/最多 5 张）
//   §1.2 POST /api/sessions/:id/after-from-respond（复制图片、设 afterImage、respondId 必须属于本分享）
//   §1.3/§1.4 ShareView / owner votes 新增 responds/respondCount/viewCount
//   §1.5 GET /api/share/:token/photo?kind=respond&id=rs_x（局域网 + token 有效期内）
//   §6 撤销/过期：respond 404/410、respond 照片 404/410
//   补充：超大/非法 dataURL 拒绝、多人 4 种 action 计数与排序、非本分享 respondId → 400
//
// 用法: node tests/api-e2e-v4.mjs
// 退出码: 0 全绿 / 1 失败 / 2 前置缺失

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, BASE, httpReq, api, analyzeFlexible, ensureServer, stopServer, healthUp,
  loadImage, isNum, nonEmptyStr, isEnum, charLen, sleep,
} from './lib-qa.mjs';

const IMG_OK = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img2_annotate.jpg');
const THUMB = join(ROOT, 'tests', 'fixtures', 'share-thumb.jpg');
const SHARE_DIR = join(ROOT, 'app', 'data', 'shares');
const UPLOAD_DIR = join(ROOT, 'app', 'data', 'uploads');
const SCRATCH = join(ROOT, '.scratch');
mkdirSync(SCRATCH, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);

const PROFILE = { goal: '想给猫找个睡觉的角落', budget: 300, cats: 1, catSize: 'medium', catAge: 'adult', multiCat: false, floorType: 'wood', climate: 'mild' };
const SAMPLE_CM = { corridorWidth: 62, cornerWidthA: 100, cornerWidthB: 80, freeDepth: 60, obstructionH: 75, ceilingFree: 120, outletDist: 90, doorSwing: 80, windowDist: 150 };
const LABELS = { measure: '我周末来量', photo: '我拍了现场照', disagree: '这个位置我不同意', agree: '就按这个来' };

/* ---------------------------------------------------------------- 结果框架 */
const steps = [];
let current = null;
let failed = 0;
let totalChecks = 0;
const softWarn = [];
const evidence = { runId: RUN_ID, startedAt: new Date().toISOString(), base: BASE, steps: [], sessions: {}, evidence: {} };
const log = (m) => console.log(m);
function check(cond, msg, detail) {
  totalChecks++;
  if (current) {
    if (cond) current.pass++;
    else { current.issues.push({ msg, detail: detail === undefined ? '' : String(detail) }); failed++; }
  }
  return !!cond;
}
function softCheck(cond, msg, detail) {
  totalChecks++;
  if (current && cond) current.pass++;
  if (!cond) softWarn.push({ step: current?.name || '', msg, detail: detail === undefined ? '' : String(detail) });
  return !!cond;
}
function note(m) { if (current) current.notes.push(String(m)); }
async function step(name, fn) {
  const s = { name, ok: true, ms: 0, pass: 0, issues: [], notes: [] };
  steps.push(s); evidence.steps.push(s); current = s;
  const t0 = Date.now();
  try { await fn(s); }
  catch (e) { s.issues.push({ msg: '未捕获异常: ' + (e?.message || String(e)), detail: e?.stack ? String(e.stack).split('\n').slice(1, 3).join(' | ') : '' }); }
  finally {
    s.ms = Date.now() - t0; s.ok = s.issues.length === 0;
    if (!s.ok) failed += s.issues.length;
    current = null;
    log(`[${s.ok ? 'PASS' : 'FAIL'}] ${name} (${(s.ms / 1000).toFixed(1)}s, ${s.pass} checks)`);
    for (const n of s.notes) log('        · ' + n);
    for (const i of s.issues) log('        ✗ ' + i.msg + (i.detail ? ' — ' + i.detail : ''));
  }
  return s;
}

/* ---------------------------------------------------------------- 辅助 */
const thumbBuf = readFileSync(THUMB);
const thumbDataUrl = 'data:image/jpeg;base64,' + thumbBuf.toString('base64');
const dataUrlOf = (buf, type = 'image/jpeg') => `data:${type};base64,` + Buffer.from(buf).toString('base64');

async function getSession(id) { return (await api('GET', `/api/sessions/${id}`)).json; }
async function getShare(token) { return (await api('GET', `/api/share/${token}`)).json; }
async function ownerVotes(id) { return (await api('GET', `/api/sessions/${id}/votes`)).json; }
function shareFile(token) { return join(SHARE_DIR, `${token}.json`); }
function readShareFile(token) {
  try { return JSON.parse(readFileSync(shareFile(token), 'utf8')); } catch { return null; }
}
async function writeShareFile(token, obj) { writeFileSync(shareFile(token), JSON.stringify(obj, null, 2), 'utf8'); }

async function runToPlan(sessionId, img) {
  const flow = {};
  const up = await api('POST', `/api/sessions/${sessionId}/image`, { dataUrl: img.dataUrl, width: img.width, height: img.height, metrics: img.metrics }, { timeout: 60000 });
  flow.upload = up.json;
  let r = await analyzeFlexible(sessionId, 'quality', [{ metrics: img.metrics, profile: PROFILE }, {}]);
  flow.quality = r.final;
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
  }
  r = await analyzeFlexible(sessionId, 'plan', [{ directionId, profile: PROFILE }, { profile: PROFILE }, {}]);
  flow.plan = r.final;
  flow.directionId = directionId;
  return flow;
}

/** 清理：只删本轮 session 及 share / uploads 残留 */
async function sweep(sessionId) {
  try {
    const session = await getSession(sessionId);
    const uploads = [];
    if (session?.image?.imageId) uploads.push(session.image.imageId);
    if (session?.afterImage?.imageId) uploads.push(session.afterImage.imageId);
    if (session?.share?.token) {
      const sf = readShareFile(session.share.token);
      if (sf?.photo?.imageId) uploads.push(sf.photo.imageId);
      for (const r of sf?.responds || []) if (r?.photo?.imageId) uploads.push(r.photo.imageId);
      try { unlinkSync(shareFile(session.share.token)); } catch { /* noop */ }
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

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  log('='.repeat(76));
  log(`api-e2e-v4 — V4 家人回应验收 (${BASE})`);
  log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  log('='.repeat(76));
  await ensureServer();
  const h = await healthUp();
  check(h.up, '/api/health 可访问');

  let sessionId = null;
  let token = null;
  try {
    await step('0. 环境预检', async () => {
      check(existsSync(IMG_OK), '测试图片存在', IMG_OK);
      check(existsSync(THUMB), '缩略图 fixture 存在', THUMB);
      check(healthUp && (await healthUp()).up, '服务端健康');
    });

    let flow = null;
    await step('1. 准备一个已交付 plan 的会话（真实 AI 流程）', async () => {
      const img = loadImage(IMG_OK);
      const created = await api('POST', '/api/sessions', { profile: PROFILE });
      sessionId = created.json?.id;
      check(/^s_[a-f0-9]{12}$/.test(sessionId || ''), '创建会话', String(sessionId));
      flow = await runToPlan(sessionId, img);
      check(nonEmptyStr(flow.plan?.verdict), 'plan.verdict 存在', JSON.stringify(flow.plan?.verdict));
      note(`session=${sessionId} plan=${flow.plan?.verdict}`);
      evidence.sessions.main = sessionId;
    });

    await step('2. share 创建 + viewCount 递增 + ShareView 新字段', async () => {
      const created = await api('POST', `/api/sessions/${sessionId}/share`, { photoDataUrl: thumbDataUrl });
      token = created.json?.share?.token;
      check(/^sh_[a-f0-9]{16}$/.test(token || ''), '创建分享', String(token));
      const v0 = await getShare(token);
      check(Array.isArray(v0.responds) && v0.responds.length === 0, 'ShareView.responds 初始 []', JSON.stringify(v0.responds));
      check(v0.respondCount === 0, 'ShareView.respondCount 初始 0', JSON.stringify(v0.respondCount));
      check(isNum(v0.viewCount) && v0.viewCount >= 1, 'ShareView.viewCount 数字且 ≥1', JSON.stringify(v0.viewCount));
      // viewCount：中间只读一次，严格 +1（页面/其他读取会额外 +1，测试不要多读）
      const baseView = v0.viewCount;
      const v1 = await getShare(token);
      check(v1.viewCount === baseView + 1, '每次 GET /api/share/:token viewCount 恰好 +1', `before=${baseView} after=${v1.viewCount}`);
      check(Array.isArray(v1.responds) && v1.respondCount === 0, '无回应时 responds 空、respondCount=0');
      note(`token=${token} viewCount=${v1.viewCount}`);
      evidence.evidence.share = { token, viewCount: v1.viewCount };
    });

    let photoRespond = null;
    let firstPhotoRespondId = null;
    await step('3. 4 种 action：计数、标签、排序、匿名、覆盖规则', async () => {
      const post = (body) => httpReq('POST', `/api/share/${token}/respond`, { body });
      const r1 = await post({ action: 'measure', note: '周六上午有空', name: '室友', deviceId: 'd_v4_a' });
      check(r1.status === 200 && r1.json?.ok === true, 'measure 回应成功', `status=${r1.status}`);
      check(r1.json?.respondCount === 1, 'measure → respondCount=1', JSON.stringify(r1.json?.respondCount));
      let list = r1.json?.responds || [];
      check(list[0]?.action === 'measure', '首条 action=measure', JSON.stringify(list[0]?.action));
      check(list[0]?.label === LABELS.measure, 'measure 中文标签「我周末来量」', JSON.stringify(list[0]?.label));
      check(list[0]?.note === '周六上午有空' && list[0]?.name === '室友', 'note/name 回显', JSON.stringify({ note: list[0]?.note, name: list[0]?.name }));
      check(nonEmptyStr(list[0]?.at) && !Number.isNaN(Date.parse(list[0].at)), 'at 为 ISO 时间', JSON.stringify(list[0]?.at));
      check(list[0]?.photoUrl === null, 'measure 回应 photoUrl=null', JSON.stringify(list[0]?.photoUrl));

      const rPhoto = await post({ action: 'photo', consent: true, name: '妈妈', note: '这是我想放的位置', deviceId: 'd_v4_b', photoDataUrl: thumbDataUrl });
      check(rPhoto.status === 200 && rPhoto.json?.respondCount === 2, 'photo 回应成功 → count=2', `status=${rPhoto.status} count=${rPhoto.json?.respondCount}`);
      list = rPhoto.json?.responds || [];
      photoRespond = list.find((x) => x.action === 'photo');
      firstPhotoRespondId = photoRespond?.id;
      check(photoRespond?.label === LABELS.photo, 'photo 中文标签「我拍了现场照」', JSON.stringify(photoRespond?.label));
      check(/^rs_[a-f0-9]{8}$/.test(photoRespond?.id || ''), '回应 id 格式 rs_[a-f0-9]{8}', JSON.stringify(photoRespond?.id));
      check(photoRespond?.photoUrl === `/api/share/${token}/photo?kind=respond&id=${photoRespond.id}`, 'photoUrl 指向 respond 照片路由', JSON.stringify(photoRespond?.photoUrl));
      const img = await httpReq('GET', photoRespond.photoUrl, { timeout: 15000 });
      check(img.status === 200 && /^image\//.test(img.headers['content-type'] || ''), 'respond 照片 GET 200 且是图片', `status=${img.status} ct=${img.headers['content-type']}`);
      check(img.buffer?.equals(thumbBuf), 'respond 照片字节与上传缩略图一致', `bytes=${img.bytes} vs ${thumbBuf.length}`);

      const rDis = await post({ action: 'disagree', deviceId: 'd_v4_c', name: '爸爸', note: '别放这' });
      const rAgree = await post({ action: 'agree', deviceId: 'd_v4_d' });
      check(rDis.status === 200 && rDis.json?.respondCount === 3, 'disagree → count=3', JSON.stringify(rDis.json?.respondCount));
      check(rAgree.status === 200 && rAgree.json?.respondCount === 4, 'agree → count=4', JSON.stringify(rAgree.json?.respondCount));
      list = rAgree.json?.responds || [];
      check(list.map((x) => x.action).join(',') === 'measure,photo,disagree,agree', '回应按时间排序（measure→photo→disagree→agree）', JSON.stringify(list.map((x) => x.action)));
      check(list.map((x) => x.label).join('|') === Object.values(LABELS).join('|'), '4 种中文标签全部正确', JSON.stringify(list.map((x) => x.label)));
      const anon = list.find((x) => x.action === 'agree');
      check(/^家人 \d+$/.test(anon?.name || ''), '匿名回应默认「家人 N」', JSON.stringify(anon?.name));

      // 同一 deviceId+action 覆盖（不增长，note 更新，位置移到末尾）
      const r1b = await post({ action: 'measure', note: '改成周日', name: '室友', deviceId: 'd_v4_a' });
      check(r1b.json?.respondCount === 4, '**同 deviceId+action 覆盖不增加计数**', JSON.stringify(r1b.json?.respondCount));
      list = r1b.json?.responds || [];
      const measureRows = list.filter((x) => x.action === 'measure');
      check(measureRows.length === 1 && measureRows[0].note === '改成周日', '覆盖后只保留最后一条且 note 更新', JSON.stringify(measureRows));
      check(list[list.length - 1]?.action === 'measure', '覆盖后该回应排序到末尾（最近更新）', JSON.stringify(list.map((x) => x.action)));

      // 同一 device 不同 action：算不同回应
      const r1c = await post({ action: 'agree', deviceId: 'd_v4_a', name: '室友' });
      check(r1c.json?.respondCount === 5, '同 deviceId 不同 action 算新回应 → count=5', JSON.stringify(r1c.json?.respondCount));
      list = r1c.json?.responds || [];
      const counts = list.reduce((m, x) => ((m[x.action] = (m[x.action] || 0) + 1), m), {});
      check(counts.measure === 1 && counts.photo === 1 && counts.disagree === 1 && counts.agree === 2, '4 种 action 计数正确（measure1/photo1/disagree1/agree2）', JSON.stringify(counts));
      note(`responds=${JSON.stringify(counts)}`);
      evidence.evidence.responds = list;
    });

    await step('4. 校验与边界：consent / 缺图 / 未知 action / 非法图 / 超大图 / 长度', async () => {
      const before = (await getShare(token)).respondCount;
      const post = (body) => httpReq('POST', `/api/share/${token}/respond`, { body });
      let r = await post({ action: 'photo', deviceId: 'd_v4_x', photoDataUrl: thumbDataUrl });
      check(r.status === 400 && r.json?.error?.code === 'need_consent', 'photo 无 consent → 400 need_consent', `status=${r.status} code=${r.json?.error?.code}`);
      r = await post({ action: 'photo', consent: true, deviceId: 'd_v4_x' });
      check(r.status === 400, 'photo 无 dataURL → 400', `status=${r.status} code=${r.json?.error?.code}`);
      r = await post({ action: 'dance', deviceId: 'd_v4_x' });
      check(r.status === 400 && r.json?.error?.code === 'bad_action', '未知 action → 400 bad_action', `status=${r.status} code=${r.json?.error?.code}`);
      r = await post({ action: 'photo', consent: true, deviceId: 'd_v4_x', photoDataUrl: 'data:text/plain;base64,aGVsbG8=' });
      check(r.status === 400, '非法图片格式 → 400（bad_image）', `status=${r.status} code=${r.json?.error?.code}`);
      // 超大 dataURL：图片上限 12MB，但服务端 readBody 上限 = maxUploadBytes(12MB)，
      // base64 有 4/3 膨胀 → 超过约 9MB 的图片请求体会先触达 readBody 上限并被 destroy（客户端 ECONNRESET）
      const big = Buffer.alloc(12 * 1024 * 1024 + 1024, 7);
      const bigUrl = dataUrlOf(big);
      let bigRes = null, bigErr = null;
      try { bigRes = await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'photo', consent: true, deviceId: 'd_v4_big', photoDataUrl: bigUrl }, timeout: 60000 }); }
      catch (e) { bigErr = e?.message || String(e); }
      const rejected = bigRes ? bigRes.status === 413 : false;
      check(rejected, '超大 payload → 干净 413（未写入回应）', bigRes ? `status=${bigRes.status} code=${bigRes.json?.error?.code} msg=${bigRes.json?.error?.message || ''}` : `transport=${bigErr}`);
      check(!!bigRes && nonEmptyStr(bigRes.json?.error?.message), '413 带可读错误说明', JSON.stringify(bigRes?.json?.error || null));
      const healthAfterBig = await healthUp();
      check(healthAfterBig.up, '超大请求后服务端仍健康', JSON.stringify(healthAfterBig.error || ''));
      const after = (await getShare(token)).respondCount;
      check(after === before, '所有失败请求未污染 respondCount', `before=${before} after=${after}`);
      // 长度：契约 note ≤40 / name ≤12；服务端 slice(0,60)/(0,16)
      const longNote = '这是一条很长的留言'.repeat(10);
      const longName = '昵称'.repeat(12);
      r = await post({ action: 'disagree', deviceId: 'd_v4_len', note: longNote, name: longName });
      check(r.status === 200, '超长 note/name 请求被接受（服务端截断）', `status=${r.status}`);
      const row = (r.json?.responds || []).slice(-1)[0];
      check(row && row.action === 'disagree', '超长 note/name 的 disagree 回应在末尾', JSON.stringify(row?.action));
      check(row && charLen(row.note) <= 60, '服务端 note 截断 ≤60', `len=${charLen(row?.note)}`);
      check(row && charLen(row.name) <= 16, '服务端 name 截断 ≤16', `len=${charLen(row?.name)}`);
      softCheck(charLen(row?.note) <= 40, '契约要求 note ≤40：当前服务端允许到 60，不符合契约（建议 slice(0,40) 或 400）', `len=${charLen(row?.note)}`);
      softCheck(charLen(row?.name) <= 12, '契约要求 name ≤12：当前服务端允许到 16，不符合契约（建议 slice(0,12)）', `len=${charLen(row?.name)}`);
      note(`无效请求后 respondCount 保持 ${after}`);
    });

    await step('5. photo 每次新增 + 最多保留 5 张', async () => {
      const before = (await getShare(token)).respondCount;
      const photosBefore = (await getShare(token)).responds.filter((x) => x.action === 'photo').length;
      const added = [];
      for (let i = 0; i < 6; i++) {
        const r = await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'photo', consent: true, deviceId: `d_v4_multi_${i}`, name: `家人${i}`, photoDataUrl: thumbDataUrl }, timeout: 30000 });
        if (r.status === 200) added.push(r.json);
      }
      const view = await getShare(token);
      const photos = (view.responds || []).filter((x) => x.action === 'photo');
      check(photos.length === 5, '**photo 每次新增但最多保留 5 张**', `photos=${photos.length} beforePhotos=${photosBefore}`);
      check(view.respondCount === before + 6 - (photosBefore + 6 - 5), 'respondCount = 非照片 + 5 张照片', `count=${view.respondCount}`);
      check(added.every((x) => x.ok === true), '连续 6 次 photo 均 200', JSON.stringify(added.map((x) => x.ok)));
      note(`photos=${photos.length} respondCount=${view.respondCount}`);
      evidence.evidence.photoCap = photos.length;
    });

    await step('6. owner votes 扩展字段 + 缩略图可读', async () => {
      const share = await getShare(token);
      const ov = await ownerVotes(sessionId);
      check(Array.isArray(ov.responds), 'owner votes.responds 数组', JSON.stringify(Array.isArray(ov.responds)));
      check(ov.respondCount === share.respondCount, 'owner respondCount 与 ShareView 一致', `owner=${ov.respondCount} share=${share.respondCount}`);
      // GET share 会 +1、GET votes 不 +1；先后读取允许差 1，最多 ≤2 的时序差
      check(isNum(ov.viewCount) && ov.viewCount <= share.viewCount && share.viewCount - ov.viewCount <= 2, 'owner viewCount ≤ ShareView.viewCount（允许先后读取差 ≤2）', `owner=${ov.viewCount} share=${share.viewCount}`);
      check(ov.responds.every((x) => nonEmptyStr(x.label) && nonEmptyStr(x.name) && nonEmptyStr(x.at)), 'owner responds 每条含 label/name/at', JSON.stringify(ov.responds.map((x) => `${x.name}:${x.label}`)));
      const withPhoto = ov.responds.filter((x) => x.photoUrl);
      check(withPhoto.length >= 1, 'owner responds 中照片回应带 photoUrl（缩略图来源）', JSON.stringify(withPhoto.length));
      const p = await httpReq('GET', withPhoto[0].photoUrl, { timeout: 15000 });
      check(p.status === 200 && /^image\//.test(p.headers['content-type'] || ''), 'owner 侧 photoUrl 可读 200', `status=${p.status}`);
      evidence.evidence.ownerVotes = { respondCount: ov.respondCount, viewCount: ov.viewCount };
    });

    await step('7. after-from-respond：复制图片、设 afterImage、对比图数据源', async () => {
      const view = await getShare(token);
      const photoRows = (view.responds || []).filter((x) => x.action === 'photo' && x.photoUrl);
      check(photoRows.length >= 1, '存在带照片的回应可供设置', JSON.stringify(photoRows.length));
      const pick = photoRows[0];
      const sfNow = readShareFile(token);
      const sfPick = (sfNow?.responds || []).find((x) => x.id === pick.id);
      check(!!sfPick?.photo?.imageId, 'share 文件里该 respond 含 photo.imageId（可供 after-from-respond）', JSON.stringify({ pick: pick.id, photo: sfPick?.photo || null }));
      const sessNow = await getSession(sessionId);
      check(sessNow?.share?.token === token, 'session.share.token 与当前 token 一致', JSON.stringify({ sessionShare: sessNow?.share?.token, token }));
      const hadAfter = sessNow?.afterImage?.imageId || null;
      const raw1 = await httpReq('POST', `/api/sessions/${sessionId}/after-from-respond`, { body: { respondId: pick.id } });
      check(raw1.status === 200, 'after-from-respond 200（第 1 次）', `status=${raw1.status} body=${JSON.stringify(raw1.json?.error || '')}`);
      const sfAfter1 = readShareFile(token);
      check((sfAfter1?.responds || []).some((x) => x.id === pick.id && x.photo?.imageId), '第 1 次调用后 share 文件仍保留该 respond 照片', JSON.stringify((sfAfter1?.responds || []).map((x) => `${x.id}:${x.photo?.imageId || '-'}`)));
      const raw2 = await httpReq('POST', `/api/sessions/${sessionId}/after-from-respond`, { body: { respondId: pick.id } });
      check([200].includes(raw2.status), 'after-from-respond 重复调用仍 200（幂等复制）', `status=${raw2.status} body=${JSON.stringify(raw2.json?.error || '')}`);
      const after = (raw2.json?.session || raw1.json?.session)?.afterImage;
      check(!!after?.imageId && after.imageId !== hadAfter, 'session.afterImage 更新为新图', JSON.stringify({ old: hadAfter, new: after?.imageId }));
      check(after?.fromRespondId === pick.id, 'afterImage.fromRespondId 记录来源回应', JSON.stringify(after?.fromRespondId));
      check(nonEmptyStr(after?.fromFamilyName), 'afterImage.fromFamilyName 记录家人名', JSON.stringify(after?.fromFamilyName));
      // 复制而非引用：after 图 imageId 必须 ≠ respond 原图 imageId；但字节相同
      const shareFileObj = readShareFile(token);
      const resRow = (shareFileObj?.responds || []).find((x) => x.id === pick.id);
      check(after?.imageId !== resRow?.photo?.imageId, 'after 图片是复制件（imageId ≠ respond photo imageId）', JSON.stringify({ after: after?.imageId, respond: resRow?.photo?.imageId }));
      const img = await httpReq('GET', `/api/image/${after.imageId}`, { timeout: 15000 });
      check(img.status === 200 && img.buffer?.equals(thumbBuf), 'after 图片字节 = 家人回传照片', `bytes=${img.bytes}/${thumbBuf.length}`);
      // 分享页 afterPhotoUrl 可读
      const v = await getShare(token);
      check(v.afterPhotoUrl === `/api/share/${token}/photo?kind=after`, 'ShareView.afterPhotoUrl 指向分享图路由', JSON.stringify(v.afterPhotoUrl));
      const a = await httpReq('GET', v.afterPhotoUrl, { timeout: 15000 });
      check(a.status === 200, 'ShareView afterPhotoUrl 可读 200', `status=${a.status}`);
      // 非法/非本分享 respondId（预期 400，用 httpReq 避免 api() 抛异常）
      const bad = await httpReq('POST', `/api/sessions/${sessionId}/after-from-respond`, { body: { respondId: 'rs_00000000' } });
      check(bad.status === 400, '未知 respondId → 400', `status=${bad.status} code=${bad.json?.error?.code}`);
      // 非本分享：撤销后重建 share，用旧 share 的 respondId
      await api('DELETE', `/api/sessions/${sessionId}/share`);
      const re = await api('POST', `/api/sessions/${sessionId}/share`, { photoDataUrl: thumbDataUrl });
      check([200, 201].includes(re.status), '重建分享（用于非本分享 respondId 测试）', `status=${re.status}`);
      const foreign = await httpReq('POST', `/api/sessions/${sessionId}/after-from-respond`, { body: { respondId: pick.id } });
      check(foreign.status === 400, '**非本分享 respondId → 400**', `status=${foreign.status} code=${foreign.json?.error?.code}`);
      const nowSession = await getSession(sessionId);
      check(nowSession?.afterImage?.imageId === after.imageId, '被拒绝的请求未改动 afterImage', JSON.stringify({ now: nowSession?.afterImage?.imageId, expect: after.imageId }));
      token = re.json?.share?.token;
      evidence.evidence.afterFromRespond = { afterImageId: after.imageId, fromRespondId: after.fromRespondId };
    });

    await step('8. 撤销/过期：respond 404/410、respond 照片 404/410', async () => {
      // 当前 token 为 step7 重建的 share；先加一条带照片回应
      const before = (await getShare(token)).respondCount;
      const rp = await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'photo', consent: true, deviceId: 'd_v4_rev', photoDataUrl: thumbDataUrl } });
      check(rp.status === 200, '撤销前创建一条照片回应', `status=${rp.status}`);
      const target = (rp.json?.responds || []).filter((x) => x.action === 'photo').slice(-1)[0];
      await api('DELETE', `/api/sessions/${sessionId}/share`);
      let r = await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'agree', deviceId: 'd_v4_rev2' } });
      check(r.status === 404, '撤销后 respond → 404', `status=${r.status}`);
      r = await httpReq('GET', target.photoUrl);
      check(r.status === 404, '撤销后 respond 照片 → 404', `status=${r.status}`);
      // 过期：重建 share 后手改 expiresAt（测试专用，测后删除）
      const re = await api('POST', `/api/sessions/${sessionId}/share`, { photoDataUrl: thumbDataUrl });
      token = re.json?.share?.token;
      const rp2 = await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'photo', consent: true, deviceId: 'd_v4_exp', photoDataUrl: thumbDataUrl } });
      const expTarget = (rp2.json?.responds || []).filter((x) => x.action === 'photo').slice(-1)[0];
      const sf = readShareFile(token);
      if (sf) {
        sf.expiresAt = new Date(Date.now() - 60000).toISOString();
        await writeShareFile(token, sf);
        r = await httpReq('POST', `/api/share/${token}/respond`, { body: { action: 'agree', deviceId: 'd_v4_exp2' } });
        check(r.status === 410, '过期后 respond → 410', `status=${r.status}`);
        r = await httpReq('GET', expTarget.photoUrl);
        check([404, 410].includes(r.status), '过期后 respond 照片不可读（404 或 410）', `status=${r.status}`);
      } else check(false, '读取 share 文件造过期', token);
      note(`expired target=${expTarget?.id}`);
    });
  } finally {
    try { if (sessionId) await sweep(sessionId); } catch { /* noop */ }
    finish();
  }
}

function finish() {
  const bad = steps.filter((s) => !s.ok);
  log('');
  log('='.repeat(76));
  log(`checks=${totalChecks}  failed=${failed}  steps=${steps.map((s) => `${s.name.split('.')[0]}=${s.ok ? 'PASS' : 'FAIL'}`).join(' ')}`);
  if (softWarn.length) { log(`soft-warn=${softWarn.length}`); for (const w of softWarn) log(`  ~ ${w.msg}${w.detail ? ' — ' + w.detail : ''}`); }
  log('='.repeat(76));
  const out = join(SCRATCH, `qa-e2e-v4-${RUN_ID}.json`);
  evidence.totalChecks = totalChecks;
  evidence.failed = failed;
  evidence.softWarn = softWarn;
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
  log(`证据: ${out.replace(ROOT + '\\', '')}`);
  if (failed === 0) {
    log(`RESULT: PASS  (${steps.length} 阶段, ${totalChecks} checks${softWarn.length ? `, soft-warn=${softWarn.length}` : ''})`);
    stopServer(); process.exit(0);
  } else {
    log(`RESULT: FAIL  (${failed} 项失败)`);
    for (const s of bad) for (const i of s.issues) log(`  ✗ [${s.name}] ${i.msg}${i.detail ? ' — ' + i.detail : ''}`);
    log('复现: node tests/api-e2e-v4.mjs');
    stopServer(); process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); stopServer(); process.exit(1); });
