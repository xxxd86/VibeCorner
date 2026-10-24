#!/usr/bin/env node
// tests/api-e2e-v2.mjs —— V2 契约验收（证据驱动升级）
//
// 覆盖 docs/CONTRACT-V2.md 的硬要求：
//   1) GET /api/evidence：≥25 条、id/claim/strength/kind/badge 齐全、strength/kind 枚举、url 可点
//   2) L0：recognition 具体、boundary 非空、env 对象、recommend.directionId 在 directions 内、≥1 个 kit=reuse
//   3) measure：totalTargets / attemptedTargets 单调合理，收敛时 measureDone=true
//   4) plan：catFit 恰好 6 项（status 五态）、basisId 可查、verdict 确定性规则一致
//      NA-RULE / PASSAGE_WIDTH 永不为 fail / LITTER_BOX_COUNT 建议永不为 fail
//      ifThen ≥2（可观察事实 + 单一动作）、observe 含 1/3/7 天且含「不算失败」
//      checklist[0] 计划句（时间+动作+可核对条件，不截断）、constraints 每条 basisId、
//      区间估计按保守端且 estimate:true、usedMeasurements 只含用户实测
//   5) 诚实性专项：坏照片 L0 仍给 recognition 但降级；缺尺寸 verdict 降级；前后端禁用词扫描
//   6) 3 条建议的人工核对素材（basisId vs claim 语义）写入证据 JSON，供 QA-REPORT-V2 引用
//
// 用法:
//   node tests/api-e2e-v2.mjs              # 全部（evidence + A 正常 + B 缺尺寸 + C 坏照片 + D 文案扫描）
//   node tests/api-e2e-v2.mjs --only=A,C   # 只跑指定场景
//   QA_V2_KEEP_DATA=1 ...                  # 保留测试会话便于排查
//
// 退出码: 0 全绿 / 1 有失败 / 2 前置条件缺失 / 3 AI 层未就绪（依赖阻塞）

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import {
  ROOT, BASE, SERVER_ENTRY, sleep, httpReq, api, postSSE, analyze, analyzeFlexible,
  ensureServer, stopServer, healthUp, loadImage, isNum, nonEmptyStr, isEnum, validBbox,
  charLen, walkStrings, findBanned, bannedHitsIn, semanticCheck, BASIS_SEMANTIC_HINTS,
} from './lib-qa.mjs';

const IMG_OK = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img2_annotate.jpg');
const IMG_BAD = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img4_useflow.jpg');
const IMG_ALT = join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件', 'img3_measure.jpg');
const SCRATCH = join(ROOT, '.scratch');
mkdirSync(SCRATCH, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='));
  return a ? a.split('=')[1].split(',').map((s) => s.trim().toUpperCase()) : ['EVIDENCE', 'A', 'B', 'C', 'D'];
})();
const KEEP_DATA = process.env.QA_V2_KEEP_DATA === '1';

const MEASURE_KEYS = new Set([
  'corridorWidth', 'cornerWidthA', 'cornerWidthB', 'freeDepth',
  'obstructionH', 'ceilingFree', 'outletDist', 'doorSwing', 'windowDist',
]);
const CATFIT_KEYS = ['hide', 'resources', 'litter', 'scratch', 'vertical', 'climate'];
const CATFIT_STATUS = ['pass', 'warn', 'fail', 'unknown', 'na'];
const VERDICTS = ['ok', 'conditional', 'not_supported', 'insufficient'];
const CATFIT_VERDICTS = ['good', 'caution', 'poor', 'unknown'];
const STRENGTHS = ['strong', 'moderate', 'weak', 'consensus'];
const KINDS = ['study', 'review', 'guideline', 'consensus', 'experience'];
// Lead 指定的前端可见禁用词
const WEB_BANNED = ['限时', '仅剩', '最后机会', '错过', '保证', '一定能', '研究表明', '科学证明', '帮你打造', '赋能'];
// 后端返回文案里的绝对化承诺
const ABSOLUTE = ['保证', '一定能', '绝对', '100%', '必然', '肯定会', '永远不会', '科学证明', '研究表明', '限时', '仅剩', '最后机会'];
// L0 不得出现摆放结论
const L0_CLAIMS = ['能放下', '放得下', '可行', '可以放', '推荐买', '保证'];
// 缺尺寸时 headline 不得含肯定语义
const POSITIVE_HEADLINE = [/可以放/, /可换/, /建议买/, /能放下/, /放得下/, /推荐买/, /没问题/, /完全可以/];

const SAMPLE_CM = {
  corridorWidth: 62, cornerWidthA: 120, cornerWidthB: 90, freeDepth: 60,
  obstructionH: 75, ceilingFree: 120, outletDist: 90, doorSwing: 80, windowDist: 150,
};
// 故意给一个「按保守端会低于 60」的区间，用来验证 PASSAGE_WIDTH 永不 fail + 区间取保守端
const RANGE_ANSWER = { valueCm: 55, rangeCm: [55, 65], estimate: true };

const PROFILE = {
  goal: '想给猫找个睡觉的角落', budget: 300, keep: [], cats: 1,
  catSize: 'large', catAge: 'adult', multiCat: false, floorType: 'wood', climate: 'mild',
  primaryPain: '猫不进去',
};

/* ---------------------------------------------------------------- 结果框架 */
const steps = [];
let current = null;
let failed = 0;
let totalChecks = 0;
const evidence = { runId: RUN_ID, startedAt: new Date().toISOString(), base: BASE, only: ONLY, steps: [], sessions: {}, catalog: null, webScan: null, basisReviews: [] };
const fatal = [];

function log(m) { console.log(m); }
function check(cond, msg, detail) {
  totalChecks++;
  if (!current) return !!cond;
  if (cond) { current.pass++; return true; }
  current.issues.push({ msg, detail: detail === undefined ? '' : String(detail) });
  if (current.soft) current.softFails++;
  else failed++;
  return false;
}
function softCheck(cond, msg, detail) {
  totalChecks++;
  if (!current) return !!cond;
  if (cond) { current.pass++; return true; }
  current.softFails++;
  current.softIssues.push({ msg, detail: detail === undefined ? '' : String(detail) });
  return false;
}
function note(m) { if (current) current.notes.push(String(m)); }
function warn(m) { if (current) current.warn.push(String(m)); }

async function step(name, fn, { soft = false } = {}) {
  const s = { name, ok: true, ms: 0, pass: 0, issues: [], softIssues: [], softFails: 0, notes: [], warn: [], soft };
  steps.push(s); evidence.steps.push(s); current = s;
  const t0 = Date.now();
  try { await fn(s); }
  catch (e) { s.issues.push({ msg: '未捕获异常: ' + (e?.message || String(e)), detail: e?.stack ? String(e.stack).split('\n')[1] : '' }); }
  finally {
    s.ms = Date.now() - t0;
    s.ok = s.issues.length === 0;
    if (!s.ok) failed += s.issues.length;
    current = null;
    log(`[${s.ok ? 'PASS' : 'FAIL'}] ${name} (${(s.ms / 1000).toFixed(1)}s, ${s.pass} checks${s.softFails ? `, ${s.softFails} soft-warn` : ''})`);
    for (const n of s.notes) log('        · ' + n);
    for (const w of s.warn) log('        ! WARN ' + w);
    for (const w of s.softIssues) log('        ~ soft ' + w.msg + (w.detail ? ' — ' + w.detail : ''));
    for (const i of s.issues) log('        ✗ ' + i.msg + (i.detail ? ' — ' + i.detail : ''));
  }
  return s;
}

function timing(r) {
  const u = r.meta?.usage || null;
  const tok = u ? `${u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0))}tok` : 'tok n/a';
  return `ttfb=${(r.ttfbMs / 1000).toFixed(2)}s total=${(r.ms / 1000).toFixed(2)}s events=${r.events.length} ${tok} repaired=${r.meta?.repaired === true}`;
}

/* ---------------------------------------------------------------- 通用校验 */
function checkCommonPlan(p, s) {
  check(p && typeof p === 'object', 'plan payload 对象');
  check(isEnum(p.verdict, VERDICTS), 'plan.verdict 合法', JSON.stringify(p.verdict));
  check(nonEmptyStr(p.headline), 'plan.headline 非空', JSON.stringify(p.headline));
  check(Array.isArray(p.constraints) && p.constraints.length >= 1, 'plan.constraints 非空');
  check(Array.isArray(p.checklist) && p.checklist.length >= 1, 'plan.checklist 非空');
  check(Array.isArray(p.radar) && p.radar.length === 5, 'plan.radar 保留五维（V1 兼容）', JSON.stringify(p.radar?.length));
  check(nonEmptyStr(p.disclaimer) && p.disclaimer.includes('现场确认'), 'plan.disclaimer 含「现场确认」', JSON.stringify(p.disclaimer));
  check(Array.isArray(p.annotations), 'plan.annotations 是数组');
  for (const [i, a] of (p.annotations || []).entries()) check(validBbox(a.bbox), `plan.annotations[${i}].bbox 0—1`, JSON.stringify(a.bbox));
  check(Array.isArray(p.items), 'plan.items 是数组');
  check(Array.isArray(p.blocked), 'plan.blocked 是数组');
  check(p.behavior && typeof p.behavior === 'object', 'plan.behavior 对象存在');
  check(Array.isArray(p.observe), 'plan.observe 是数组');
  check(Array.isArray(p.ifThen), 'plan.ifThen 是数组');
  check(Array.isArray(p.usedMeasurements), 'plan.usedMeasurements 是数组');
  check(p.litterCount && typeof p.litterCount === 'object', 'plan.litterCount 软建议对象存在');
}

function validateL0V2(p, s, { requireSpecific = true } = {}) {
  check(isEnum(p.verdict, ['continue', 'not_supported', 'insufficient']), 'L0.verdict 合法', JSON.stringify(p.verdict));
  check(Array.isArray(p.directions) && p.directions.length >= 1 && p.directions.length <= 3, 'L0.directions 1—3 个', JSON.stringify(p.directions?.length));
  check(Array.isArray(p.regions), 'L0.regions 是数组');
  for (const [i, r] of (p.regions || []).entries()) {
    check(validBbox(r.bbox), `L0.regions[${i}].bbox 0—1`, JSON.stringify(r.bbox));
    check(isEnum(r.verdict, ['ok', 'conditional', 'blocked', 'unknown']), `L0.regions[${i}].verdict 合法`, JSON.stringify(r.verdict));
  }
  check(nonEmptyStr(p.disclaimer) && p.disclaimer.includes('方向预览'), 'L0.disclaimer 含「方向预览」', JSON.stringify(p.disclaimer));
  // V2：recognition / boundary / env / recommend
  check(nonEmptyStr(p.recognition), 'L0.recognition 非空', JSON.stringify(p.recognition));
  const rec = String(p.recognition || '');
  check(charLen(rec) >= 8, 'L0.recognition 长度 ≥8 字', `${charLen(rec)} 字: "${rec}"`);
  if (requireSpecific) {
    const generic = [
      /^(一个|这个|那个|某个)?(室内)?(的)?角落[。.]?$/,
      /^(这个|那个)?角落[。.]?$/,
      /^(一张|一张照片)/,
      /^看不清/,
    ];
    check(!generic.some((re) => re.test(rec.trim())), 'L0.recognition 不是空泛话术', `"${rec}"`);
    check(/(墙|柜|桌|窗|门|地|沙发|床|台|架|盆|窝|板|砖|木|角|线|电|家具|地板|角落)/.test(rec), 'L0.recognition 具体到位置/物件', `"${rec}"`);
    check(!/(的)?这个角落$/.test(rec.trim()), 'L0.recognition 不是兜底模板', `"${rec}"`);
  }
  check(nonEmptyStr(p.boundary), 'L0.boundary 非空', JSON.stringify(p.boundary));
  check(charLen(p.boundary || '') >= 8, 'L0.boundary 长度 ≥8 字', `${charLen(p.boundary || '')} 字`);
  check(/(看不出|看不到|只能|无法|要量|量过|现场|确认|照片)/.test(String(p.boundary || '')), 'L0.boundary 表达了判断边界', `"${p.boundary}"`);
  check(p.env && typeof p.env === 'object', 'L0.env 对象存在');
  if (p.env && typeof p.env === 'object') {
    check(isEnum(p.env.floorType, ['wood', 'tile', 'carpet', 'unknown']), 'L0.env.floorType 枚举', JSON.stringify(p.env.floorType));
    check(Array.isArray(p.env.nearAppliance), 'L0.env.nearAppliance 数组', JSON.stringify(p.env.nearAppliance));
    check(typeof p.env.nearFood === 'boolean', 'L0.env.nearFood 布尔', JSON.stringify(p.env.nearFood));
    check(typeof p.env.draft === 'boolean', 'L0.env.draft 布尔', JSON.stringify(p.env.draft));
    check(isEnum(p.env.sunlight, ['none', 'indirect', 'direct']), 'L0.env.sunlight 枚举', JSON.stringify(p.env.sunlight));
    check(typeof p.env.wallExterior === 'boolean', 'L0.env.wallExterior 布尔', JSON.stringify(p.env.wallExterior));
  }
  const dirs = Array.isArray(p.directions) ? p.directions : [];
  const dirIds = new Set(dirs.map((d) => d.id));
  check(p.recommend && typeof p.recommend === 'object', 'L0.recommend 对象存在');
  check(p.recommend?.directionId && dirIds.has(p.recommend.directionId), 'L0.recommend.directionId 在 directions 内', JSON.stringify(p.recommend?.directionId));
  check(nonEmptyStr(p.recommend?.why), 'L0.recommend.why 非空', JSON.stringify(p.recommend?.why));
  check(nonEmptyStr(p.recommend?.alternativesNote), 'L0.recommend.alternativesNote 非空', JSON.stringify(p.recommend?.alternativesNote));
  const reuseCount = dirs.filter((d) => d.kit === 'reuse').length;
  check(reuseCount >= 1, 'directions 至少 1 个 kit=reuse（不买东西选项）', `reuse=${reuseCount} kits=[${dirs.map((d) => d.kit).join(',')}]`);
  // L0 不得给摆放结论 / 禁用词
  const claims = bannedHitsIn(p, L0_CLAIMS, 'l0');
  check(claims.length === 0, 'L0 无「能放下/可行/推荐买」类断言', claims.slice(0, 3).map((h) => `${h.path}~"${h.snippet}"`).join(' ; '));
  const banned = bannedHitsIn(p, ABSOLUTE, 'l0');
  check(banned.length === 0, 'L0 无绝对化承诺/反操纵词', banned.slice(0, 3).map((h) => `${h.path}~"${h.snippet}"`).join(' ; '));
  return { dirIds };
}

function validateMeasureV2(p, round) {
  check(isNum(p.round), 'measure.round 数字', JSON.stringify(p.round));
  check(Array.isArray(p.questions), 'measure.questions 数组');
  check((p.questions || []).length <= 2, 'measure.questions ≤2', JSON.stringify(p.questions?.length));
  for (const [i, q] of (p.questions || []).entries()) {
    check(MEASURE_KEYS.has(q.key), `measure.questions[${i}].key 在字典内`, JSON.stringify(q.key));
    check(q.unit === 'cm', `measure.questions[${i}].unit=cm`, JSON.stringify(q.unit));
    check(nonEmptyStr(q.label) && nonEmptyStr(q.endpoints), `measure.questions[${i}] 有 label/endpoints`);
  }
  check(isNum(p.totalTargets) && p.totalTargets >= 1, 'measure.totalTargets ≥1（V2 进度口径）', JSON.stringify(p.totalTargets));
  check(isNum(p.attemptedTargets) && p.attemptedTargets >= 0, 'measure.attemptedTargets ≥0（V2 进度口径）', JSON.stringify(p.attemptedTargets));
  check(p.attemptedTargets <= p.totalTargets, 'measure.attemptedTargets ≤ totalTargets', `${p.attemptedTargets}/${p.totalTargets}`);
  check(Array.isArray(p.remainingKeys), 'measure.remainingKeys 数组');
  for (const [i, k] of (p.remainingKeys || []).entries()) check(MEASURE_KEYS.has(k), `remainingKeys[${i}] 在字典内`, JSON.stringify(k));
  check(nonEmptyStr(p.askNote), 'measure.askNote 非空', JSON.stringify(p.askNote));
}

function validatePlanV2(p, s, ctx) {
  const { evidenceMap, session } = ctx;
  checkCommonPlan(p, s);
  // ---- catFit
  const cf = p.catFit;
  check(cf && typeof cf === 'object', 'plan.catFit 对象存在');
  const items = Array.isArray(cf?.items) ? cf.items : [];
  check(items.length === 6, 'plan.catFit.items 恰好 6 项', `length=${items.length}`);
  const keys = items.map((i) => i.key);
  for (const k of CATFIT_KEYS) check(keys.includes(k), `catFit 含 key=${k}`, JSON.stringify(keys));
  check(new Set(keys).size === keys.length, 'catFit key 不重复', JSON.stringify(keys));
  check(isEnum(cf?.verdict, CATFIT_VERDICTS), 'plan.catFit.verdict 合法', JSON.stringify(cf?.verdict));
  const statuses = {};
  for (const [i, it] of items.entries()) {
    const tag = `catFit[${it.key || i}]`;
    check(isEnum(it.status, CATFIT_STATUS), `${tag}.status ∈ pass|warn|fail|unknown|na`, JSON.stringify(it.status));
    check(nonEmptyStr(it.label), `${tag}.label 非空`);
    check(nonEmptyStr(it.why), `${tag}.why 非空`, JSON.stringify(it.why));
    check(charLen(it.why) <= 40, `${tag}.why ≤40 字`, `${charLen(it.why)} 字`);
    check(nonEmptyStr(it.basisId), `${tag}.basisId 非空`, JSON.stringify(it.basisId));
    if (it.basisId) {
      const ev = evidenceMap.get(it.basisId);
      check(!!ev, `${tag}.basisId 能在 /api/evidence 查到`, JSON.stringify(it.basisId));
      if (ev) {
        check(it.strength === ev.strength, `${tag}.strength 与证据目录一致`, `plan=${it.strength} catalog=${ev.strength}`);
      }
    }
    statuses[it.key] = it.status;
  }
  // ---- catFit verdict 确定性规则（与 rules.mjs 一致）
  const failCount = items.filter((i) => i.status === 'fail').length;
  const warnCount = items.filter((i) => i.status === 'warn').length;
  const passCount = items.filter((i) => i.status === 'pass').length;
  const keyUnknown = statuses.hide === 'unknown' || statuses.litter === 'unknown';
  let expect = 'caution';
  if (failCount > 0) expect = 'poor';
  else if (keyUnknown) expect = 'unknown';
  else if (warnCount >= 2) expect = 'caution';
  else if (passCount >= 4) expect = 'good';
  check(cf?.verdict === expect, 'catFit.verdict 由确定性规则算出', `actual=${cf?.verdict} expect=${expect} (fail=${failCount} warn=${warnCount} pass=${passCount} keyUnknown=${keyUnknown})`);
  // ---- NA-RULE：方案不涉及的功能必须是 na，不能是 pass
  const itemTitles = (p.items || []).map((i) => String(i.title || '')).join(' ');
  const involved = {
    litter: /砂盆|猫砂/.test(itemTitles),
    scratch: /抓板|抓挠/.test(itemTitles),
    vertical: /爬架|跳台|栖架|平台/.test(itemTitles),
  };
  for (const [key, isInvolved] of Object.entries(involved)) {
    if (!isInvolved && keys.includes(key)) {
      check(statuses[key] === 'na', `NA-RULE: 方案不涉及 ${key} 时 catFit.${key}.status 必须是 na（不能虚假 pass）`, `status=${statuses[key]}`);
      const it = items.find((x) => x.key === key);
      check(/(不涉及|未涉及|没有|这次|不做|不看)/.test(String(it?.why || '')), `NA-RULE: catFit.${key}.why 说明「不涉及」`, JSON.stringify(it?.why));
    }
  }
  // na 不计入任何分子分母：上面 verdict 重算已排除（statuses 中 na 既不 pass 也不 fail/warn）
  const naCount = items.filter((i) => i.status === 'na').length;
  check(naCount >= 0 && naCount <= 6, 'catFit na 数量合理', String(naCount));
  note(`catFit verdict=${cf?.verdict} status=${JSON.stringify(statuses)} na=${naCount}`);

  // ---- constraints：basisId / 区间保守端 / PASSAGE_WIDTH 永不 fail
  const constraints = Array.isArray(p.constraints) ? p.constraints : [];
  check(constraints.length >= 1, 'constraints 非空');
  let passage = null;
  for (const [i, c] of constraints.entries()) {
    const tag = `constraint[${c.key || i}]`;
    check(nonEmptyStr(c.basisId), `${tag}.basisId 非空`, JSON.stringify(c.basisId));
    if (c.basisId) {
      const ev = evidenceMap.get(c.basisId);
      check(!!ev, `${tag}.basisId 可查`, JSON.stringify(c.basisId));
      if (ev) check(c.strength === ev.strength, `${tag}.strength 与证据目录一致`, `plan=${c.strength} catalog=${ev.strength}`);
    }
    // V2 扩展：PASSAGE_WIDTH 允许 warn（PRODUCT-V2「只给 warn/unknown」）；warn 必须 honest
    check(isEnum(c.status, ['pass', 'warn', 'fail', 'unknown']), `${tag}.status ∈ pass|warn|fail|unknown`, JSON.stringify(c.status));
    if (c.status === 'warn') {
      check(c.honest === true, `${tag}.status=warn 时必须 honest:true（经验阈值不当硬判定）`, JSON.stringify(c.honest));
    }
    if (c.key === 'corridorWidth') passage = c;
  }
  check(!!passage, '存在 corridorWidth 约束（PASSAGE_WIDTH 规则验证点）');
  if (passage) {
    check(passage.basisId === 'PASSAGE_WIDTH', 'corridorWidth 约束挂 PASSAGE_WIDTH', JSON.stringify(passage.basisId));
    check(passage.status !== 'fail', '**PASSAGE_WIDTH 约束永不为 fail**', `status=${passage.status}`);
    check(passage.honest === true, 'PASSAGE_WIDTH 标记 honest:true（经验阈值）', JSON.stringify(passage.honest));
  }
  // 尺寸约束依据：不得挂 HIDING_ENCLOSURE；纯休息点方案的尺寸应挂 REST_SIZE_STRETCH + honest:true
  const itemTitleText = (p.items || []).map((i) => String(i.title || '')).join(' ');
  const hasLitterItem = /砂盆|猫砂/.test(itemTitleText);
  const hasPerchItem = /爬架|跳台|栖架/.test(itemTitleText);
  const hasRestItem = /窝|垫|屋|箱/.test(itemTitleText);
  const spaceConstraints = constraints.filter((c) => c.key === 'cornerWidthA' || c.key === 'freeDepth');
  for (const c of spaceConstraints) {
    check(c.basisId !== 'HIDING_ENCLOSURE', `尺寸约束 ${c.key} 不能挂 HIDING_ENCLOSURE（行为学证据不能当尺寸依据）`, JSON.stringify(c.basisId));
  }
  if (hasRestItem && !hasLitterItem && !hasPerchItem && spaceConstraints.length) {
    for (const c of spaceConstraints) {
      check(c.basisId === 'REST_SIZE_STRETCH', `休息点尺寸约束 ${c.key} 挂 REST_SIZE_STRETCH`, JSON.stringify(c.basisId));
      check(c.honest === true, `休息点尺寸约束 ${c.key} honest:true（经验换算）`, JSON.stringify(c.honest));
    }
  } else if (spaceConstraints.length) {
    note(`空间约束 basis=[${spaceConstraints.map((c) => c.basisId).join(',')}]（含砂盆/爬架品类，按品类依据）`);
  }
  // 区间估计：按保守端判定且 estimate:true
  const rangeKey = ctx.rangeKey;
  if (rangeKey) {
    const meas = (session.measurements || {})[rangeKey];
    const c = constraints.find((x) => x.key === rangeKey);
    check(!!c, `区间估计的 ${rangeKey} 出现在 constraints`, JSON.stringify(constraints.map((x) => x.key)));
    if (c && meas) {
      check(c.estimate === true, `${rangeKey} 约束 estimate=true`, JSON.stringify(c.estimate));
      check(meas.estimate === true && Array.isArray(meas.rangeCm), `session.measurements.${rangeKey} 记录 rangeCm+estimate`, JSON.stringify(meas));
      const conservative = meas.rangeCm ? meas.rangeCm[0] : null;
      if (conservative != null) {
        check(c.actualCm === conservative, `${rangeKey} 按保守端判定（actualCm=区间下界）`, `actual=${c.actualCm} range=${JSON.stringify(meas.rangeCm)}`);
        check(String(c.note || '').includes('保守估算'), `${rangeKey} 约束 note 注明「保守估算」`, JSON.stringify(c.note));
        check(meas.valueCm === conservative, `${rangeKey} valueCm 存保守端`, `valueCm=${meas.valueCm} range=${JSON.stringify(meas.rangeCm)}`);
      }
    }
  }
  // ---- LITTER_BOX_COUNT 相关建议永不为 fail
  check(!!p.litterCount, 'plan.litterCount 存在（砂盆数量软建议）');
  if (p.litterCount) {
    check(p.litterCount.status !== 'fail', '**LITTER_BOX_COUNT 相关建议永不为 fail**', `status=${p.litterCount.status}`);
    check(p.litterCount.basisId === 'LITTER_BOX_COUNT', 'litterCount 挂 LITTER_BOX_COUNT', JSON.stringify(p.litterCount.basisId));
    check(p.litterCount.honest === true, 'litterCount 标记 honest:true', JSON.stringify(p.litterCount.honest));
  }
  // ---- ifThen：≥2、可观察事实 + 单一动作
  const ifThen = Array.isArray(p.ifThen) ? p.ifThen : [];
  check(ifThen.length >= 2, 'plan.ifThen ≥2 条', `length=${ifThen.length}`);
  check(ifThen.length <= 3, 'plan.ifThen ≤3 条（输出上限）', `length=${ifThen.length}`);
  for (const [i, x] of ifThen.entries()) {
    check(nonEmptyStr(x.if), `ifThen[${i}].if 非空`, JSON.stringify(x.if));
    check(nonEmptyStr(x.then), `ifThen[${i}].then 非空`, JSON.stringify(x.then));
    check(/(\d+\s*(天|次|周|小时)|\d+%|出现|留下|没有|超过|连续|每天|一周|三天|七天|尿|抓痕|压痕|毛发)/.test(String(x.if || '')), `ifThen[${i}].if 是可观察事实`, JSON.stringify(x.if));
    check(!/(多观察|注意一下|注意|留意|再看看|多种|同时|并且|，|,|；|;)/.test(String(x.then || '')), `ifThen[${i}].then 是单一动作`, JSON.stringify(x.then));
    check(/(挪|换|移|加|放|撤|关|开|擦|洗|清|铲|垫|挡|调|收|买|量|拍|改|用)/.test(String(x.then || '')), `ifThen[${i}].then 含具体动作`, JSON.stringify(x.then));
  }
  // ---- observe：1/3/7 天 + 「不算失败」
  const observe = Array.isArray(p.observe) ? p.observe : [];
  check(observe.length === 3, 'plan.observe 恰好 3 条（1/3/7 天）', `length=${observe.length}`);
  const days = observe.map((o) => Number(o.day));
  for (const d of [1, 3, 7]) check(days.includes(d), `observe 含第 ${d} 天`, JSON.stringify(days));
  const day3 = observe.find((o) => Number(o.day) === 3);
  const day3Text = JSON.stringify(day3?.checks || []);
  check(/(不算失败|不是失败|不算做失败)/.test(day3Text), 'observe 第 3 天含「不算失败」', day3Text.slice(0, 160));
  for (const [i, o] of observe.entries()) {
    check(Array.isArray(o.checks) && o.checks.length >= 1 && o.checks.length <= 4, `observe[day=${o.day || i}] checks 1—4 条`, JSON.stringify(o.checks?.length));
    check(o.checks.every((c) => nonEmptyStr(c)), `observe[day=${o.day || i}] checks 非空`);
  }
  // ---- checklist[0] 计划句
  const first = (p.checklist || [])[0];
  const firstText = String(first?.text || '');
  check(charLen(firstText) >= 8, 'checklist[0] 长度 ≥8 字', `${charLen(firstText)} 字: "${firstText}"`);
  check(/(周[一二三四五六日末]|今天|明天|周末|工作日|上午|下午|晚上)/.test(firstText), 'checklist[0] 含时间词（计划句）', `"${firstText}"`);
  check(/(去|到|在)(店里|商店|网上|家|客厅|房间|此处|现场|宠物店)/.test(firstText), 'checklist[0] 含地点动作（计划句）', `"${firstText}"`);
  check(/(≥|≤|>\s*\d|<\s*\d|\d+\s*cm|进深|宽度|长度|尺寸|净宽)/.test(firstText), 'checklist[0] 含可核对条件', `"${firstText}"`);
  check(!/[\d×≥≤<>/．.、-]$/.test(firstText.trim()), 'checklist[0] 未截断在数字/单位/符号中间', `"${firstText}"`);
  check(!/[（(【\[]$/.test(firstText.trim()), 'checklist[0] 未截断在括号中间', `"${firstText}"`);
  // ---- usedMeasurements：只含用户实测
  const userMeasured = Object.entries(session.measurements || {})
    .filter(([, v]) => v && v.source === 'user' && !v.skipped && isNum(v.valueMm))
    .map(([k]) => k);
  const used = (p.usedMeasurements || []).map((u) => u.key);
  check(used.every((k) => MEASURE_KEYS.has(k)), 'usedMeasurements.key 都在测量字典内', JSON.stringify(used));
  const usedSet = new Set(used);
  check(used.every((k) => userMeasured.includes(k)), 'usedMeasurements 只含用户实测项', `used=${JSON.stringify(used)} measured=${JSON.stringify(userMeasured)}`);
  check(userMeasured.every((k) => usedSet.has(k)), '用户实测项都被 usedMeasurements 认领（归属感完整）', `missing=${JSON.stringify(userMeasured.filter((k) => !usedSet.has(k)))}`);
  for (const u of p.usedMeasurements || []) {
    const m = (session.measurements || {})[u.key];
    check(!m || u.valueCm === m.valueCm, `usedMeasurements[${u.key}].valueCm 与落库一致`, `used=${u.valueCm} session=${m?.valueCm}`);
  }
  note(`usedMeasurements=${JSON.stringify(used)}`);
  // ---- behavior
  check(p.behavior?.likelyUse && nonEmptyStr(p.behavior.likelyUse), 'behavior.likelyUse 非空', JSON.stringify(p.behavior?.likelyUse));
  check(Array.isArray(p.behavior?.whyNot) && p.behavior.whyNot.length <= 3, 'behavior.whyNot 0—3 条', JSON.stringify(p.behavior?.whyNot?.length));
  check(nonEmptyStr(p.behavior?.firstSign), 'behavior.firstSign 非空', JSON.stringify(p.behavior?.firstSign));
  check(/(\d+\s*天|三天|7 天|次|没有主动|没有进去|停留|压痕|毛发)/.test(String(p.behavior?.firstSign || '')), 'behavior.firstSign 是可观察信号', JSON.stringify(p.behavior?.firstSign));
  check(!/(看猫喜不喜欢|感觉|多观察|注意观察)/.test(String(p.behavior?.firstSign || '')), 'behavior.firstSign 不是主观判断', JSON.stringify(p.behavior?.firstSign));

  // ---- headline 与 verdict 一致性
  if (p.verdict !== 'ok') {
    const hit = POSITIVE_HEADLINE.filter((re) => re.test(String(p.headline || ''))).map((re) => re.source);
    check(hit.length === 0, `plan.verdict=${p.verdict} 时 headline 不含肯定语义`, `headline="${p.headline}" hit=[${hit.join(',')}]`);
  }
  const unknownFloor = constraints.filter((c) => ['corridorWidth', 'cornerWidthA', 'freeDepth'].includes(c.key) && c.status === 'unknown');
  if (unknownFloor.length) check(p.verdict !== 'ok', '关键尺寸未知时 plan.verdict ≠ ok', `unknown=[${unknownFloor.map((c) => c.key)}] verdict=${p.verdict}`);

  // ---- 禁用词 / 绝对化承诺全量扫描
  const absolute = bannedHitsIn(p, ABSOLUTE, 'plan');
  check(absolute.length === 0, 'plan 无绝对化承诺/反操纵词', absolute.slice(0, 4).map((h) => `${h.path}~"${h.snippet}"`).join(' ; '));
  // ---- basis 语义自查素材（供报告人工核对 3 条）
  const candidates = [];
  for (const c of constraints) {
    if (!c.basisId || !BASIS_SEMANTIC_HINTS[c.basisId]) continue;
    const ev = evidenceMap.get(c.basisId);
    if (!ev) continue;
    candidates.push({ kind: 'constraint', basisId: c.basisId, claim: ev.claim, source: ev.source, url: ev.url, itemText: `${c.label} ${c.status} ${c.note || ''}`, ...semanticCheck(c.basisId, ev.claim, `${c.label} ${c.status} ${c.note || ''}`) });
  }
  for (const it of items) {
    if (!it.basisId || !BASIS_SEMANTIC_HINTS[it.basisId]) continue;
    const ev = evidenceMap.get(it.basisId);
    if (!ev) continue;
    candidates.push({ kind: 'catFit', key: it.key, basisId: it.basisId, claim: ev.claim, source: ev.source, url: ev.url, itemText: `${it.label} ${it.why}`, ...semanticCheck(it.basisId, ev.claim, `${it.label} ${it.why}`) });
  }
  if (p.litterCount?.basisId && evidenceMap.get(p.litterCount.basisId)) {
    const ev = evidenceMap.get(p.litterCount.basisId);
    candidates.push({ kind: 'litterCount', basisId: p.litterCount.basisId, claim: ev.claim, source: ev.source, url: ev.url, itemText: p.litterCount.text || '', ...semanticCheck(p.litterCount.basisId, ev.claim, p.litterCount.text || '') });
  }
  ctx.basisCandidates = candidates;
  check(candidates.length >= 3, '至少有 3 条建议可做 basisId↔claim 语义核对', `candidates=${candidates.length}`);
  for (const c of candidates.filter((x) => x.supported === false)) {
    softCheck(false, `basisId 语义疑似不符：${c.basisId}（${c.note}）`, `claim="${c.claim}" item="${c.itemText}"`);
  }
}

/* ---------------------------------------------------------------- 场景 */
async function createSession(profile) {
  const r = await api('POST', '/api/sessions', { profile });
  const s = r.json;
  if (!s?.id) throw new Error('POST /api/sessions 未返回 Session: ' + r.text.slice(0, 200));
  return s;
}

async function upload(id, img) {
  const r = await api('POST', `/api/sessions/${id}/image`, { dataUrl: img.dataUrl, width: img.width, height: img.height, metrics: img.metrics }, { timeout: 60000 });
  return r.json?.session || r.json;
}

async function getSession(id) { return (await api('GET', `/api/sessions/${id}`)).json; }

async function runMeasure(sessionId, { directionId, profile, answerMode, rangeKeyHolder }) {
  const rounds = [];
  let payload = { directionId, profile };
  let converged = false;
  for (let round = 1; round <= 6; round++) {
    const r = await analyzeFlexible(sessionId, 'measure', [payload, directionId ? { directionId } : {}]);
    validateMeasureV2(r.final, round);
    rounds.push({ round, final: r.final, meta: r.meta, timing: timing(r) });
    const qs = r.final.questions || [];
    if (!qs.length) { converged = true; break; }
    const answers = {};
    for (const q of qs) {
      if (answerMode === 'skip') answers[q.key] = { skipped: true };
      else if (q.key === 'corridorWidth') { answers[q.key] = RANGE_ANSWER; if (rangeKeyHolder) rangeKeyHolder.key = q.key; }
      else answers[q.key] = { valueCm: SAMPLE_CM[q.key] ?? 80 };
    }
    payload = { directionId, profile, answers };
  }
  return { rounds, converged };
}

// ---- 场景 A：正常流程（profile + 区间估计）
async function scenarioA(s) {
  const img = loadImage(IMG_OK);
  const session = await createSession(PROFILE);
  s.sessionId = session.id; evidence.sessions.A = session.id;
  note(`session=${session.id}`);
  await upload(session.id, img);
  const profile = { ...PROFILE };
  const rangeKeyHolder = { key: null };

  let r = await analyzeFlexible(session.id, 'quality', [{ metrics: img.metrics, profile }, {}]);
  const q = r.final;
  check(isEnum(q.status, ['pass', 'retake']), 'quality.status 合法', JSON.stringify(q.status));
  check(Array.isArray(q.issues), 'quality.issues 数组');
  note(`quality ${timing(r)}`);
  evidence.sessions.A_quality = q;

  r = await analyzeFlexible(session.id, 'l0', [{ profile }, {}]);
  const l0 = r.final;
  evidence.sessions.A_l0 = l0;
  validateL0V2(l0, s, { requireSpecific: true });
  note(`l0 ${timing(r)} verdict=${l0.verdict} recognition="${l0.recognition}"`);
  const directionId = l0.recommend?.directionId || l0.directions?.[0]?.id;
  check(nonEmptyStr(directionId), '取到推荐 directionId', JSON.stringify(directionId));

  const loop = await runMeasure(session.id, { directionId, profile, answerMode: 'normal', rangeKeyHolder });
  evidence.sessions.A_measure = loop.rounds.map((x) => x.final);
  evidence.sessions.A_measureMeta = loop.rounds.map((x) => x.meta);
  const rounds = loop.rounds;
  check(rounds.length >= 1, 'measure 至少 1 轮');
  check(loop.converged, 'measure 收敛到 questions:[]', `rounds=${rounds.length}`);
  const questionRounds = rounds.filter((x) => (x.final.questions || []).length > 0).length;
  check(questionRounds <= 3, 'measure 出题轮次 ≤3（flow 上限）', `questionRounds=${questionRounds}`);
  // totalTargets / attemptedTargets 单调合理
  const totals = rounds.map((x) => x.final.totalTargets);
  const attempteds = rounds.map((x) => x.final.attemptedTargets);
  check(totals.every((t) => t === totals[0]), 'totalTargets 全程不变', JSON.stringify(totals));
  check(attempteds.every((v, i) => i === 0 || v >= attempteds[i - 1]), 'attemptedTargets 单调不减', JSON.stringify(attempteds));
  check(attempteds.every((v) => v <= totals[0]), 'attemptedTargets ≤ totalTargets', JSON.stringify(attempteds));
  const last = rounds[rounds.length - 1].final;
  check(last.attemptedTargets === last.totalTargets, '收敛时 attemptedTargets == totalTargets', `${last.attemptedTargets}/${last.totalTargets}`);
  const sessionAfter = await getSession(session.id);
  check(sessionAfter.measureDone === true, 'session.measureDone === true', JSON.stringify(sessionAfter.measureDone));
  check(rangeKeyHolder.key === 'corridorWidth', 'corridorWidth 通过区间方式回答（区间估计验证点）', JSON.stringify(rangeKeyHolder.key));
  note(`measure rounds=${rounds.length} questionRounds=${questionRounds} totals=${JSON.stringify(totals)} attempted=${JSON.stringify(attempteds)}`);

  r = await analyzeFlexible(session.id, 'plan', [{ directionId, profile }, { profile }, {}]);
  const plan = r.final;
  evidence.sessions.A_plan = plan;
  note(`plan ${timing(r)} verdict=${plan.verdict} headline="${plan.headline}"`);
  const planCtx = { evidenceMap: evidence.catalog.map, session: sessionAfter, rangeKey: rangeKeyHolder.key };
  validatePlanV2(plan, s, planCtx);
  evidence.basisReviews = planCtx.basisCandidates || [];
  // session 落盘字段
  const finalSession = await getSession(session.id);
  check(isNonIso(finalSession.planDeliveredAt), 'session.planDeliveredAt 是 ISO 时间', JSON.stringify(finalSession.planDeliveredAt));
  check(finalSession.profile?.catSize === 'large' && finalSession.profile?.cats === 1, 'session.profile 回写 V2 字段', JSON.stringify(finalSession.profile));
  check(finalSession.stage === 'delivered', 'session.stage=delivered', JSON.stringify(finalSession.stage));

  // ask 阶段（V2 结构 {reply,verdict,pieces,missing}）
  const ask = await analyzeFlexible(session.id, 'ask', [{ nx: 0.5, ny: 0.55, note: '想放这里' }, {}]);
  const ap = ask.final;
  evidence.sessions.A_ask = ap;
  check(nonEmptyStr(ap.reply), 'ask.reply 非空', JSON.stringify(ap.reply));
  check(isEnum(ap.verdict, ['ok', 'conditional', 'blocked', 'insufficient']), 'ask.verdict 合法', JSON.stringify(ap.verdict));
  check(Array.isArray(ap.pieces), 'ask.pieces 数组', JSON.stringify(ap.pieces));
  check(Array.isArray(ap.missing), 'ask.missing 数组', JSON.stringify(ap.missing));
  const askBanned = bannedHitsIn(ap, ABSOLUTE, 'ask');
  check(askBanned.length === 0, 'ask 无绝对化承诺', askBanned.slice(0, 3).map((h) => h.path).join(' ; '));
  note(`ask ${timing(ask)} verdict=${ap.verdict}`);

  if (!KEEP_DATA) {
    const del = await httpReq('DELETE', `/api/sessions/${session.id}`);
    check(del.status === 200, 'DELETE 会话 200', `status=${del.status}`);
  }
}

function isNonIso(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

// ---- 场景 B：关键尺寸全缺
async function scenarioB(s) {
  const img = loadImage(IMG_ALT);
  const session = await createSession({ ...PROFILE, primaryPain: '太乱占道' });
  s.sessionId = session.id; evidence.sessions.B = session.id;
  note(`session=${session.id}`);
  await upload(session.id, img);
  let r = await analyzeFlexible(session.id, 'quality', [{ metrics: img.metrics, profile: PROFILE }, {}]);
  evidence.sessions.B_quality = r.final;
  r = await analyzeFlexible(session.id, 'l0', [{ profile: PROFILE }, {}]);
  const l0 = r.final;
  evidence.sessions.B_l0 = l0;
  validateL0V2(l0, s, { requireSpecific: true });
  note(`l0 ${timing(r)} verdict=${l0.verdict}`);
  const directionId = l0.recommend?.directionId || l0.directions?.[0]?.id;

  const loop = await runMeasure(session.id, { directionId, profile: PROFILE, answerMode: 'skip' });
  evidence.sessions.B_measure = loop.rounds.map((x) => x.final);
  check(loop.converged, '（B）measure 收敛', `rounds=${loop.rounds.length}`);
  const sessionAfter = await getSession(session.id);
  check(sessionAfter.measureDone === true, '（B）measureDone=true', JSON.stringify(sessionAfter.measureDone));
  const skipped = Object.entries(sessionAfter.measurements || {}).filter(([, v]) => v?.skipped).map(([k]) => k);
  note(`skipped=[${skipped.join(',')}]`);

  r = await analyzeFlexible(session.id, 'plan', [{ directionId, profile: PROFILE }, { profile: PROFILE }, {}]);
  const plan = r.final;
  evidence.sessions.B_plan = plan;
  note(`plan ${timing(r)} verdict=${plan.verdict} headline="${plan.headline}"`);
  validatePlanV2(plan, s, { evidenceMap: evidence.catalog.map, session: sessionAfter, rangeKey: null });
  check(plan.verdict !== 'ok', '（B）关键尺寸缺失时 plan.verdict ≠ ok', JSON.stringify(plan.verdict));
  check(['insufficient', 'not_supported'].includes(plan.verdict), '（B）missing 场景应 insufficient/not_supported（可交付下限也不该抬到 conditional）', JSON.stringify(plan.verdict));
  const used = plan.usedMeasurements || [];
  check(used.length === 0, '（B）全 skipped 时 usedMeasurements 为空', JSON.stringify(used));
  if (!KEEP_DATA) await httpReq('DELETE', `/api/sessions/${session.id}`);
}

// ---- 场景 C：坏照片（流程图）诚实性
async function scenarioC(s) {
  const img = loadImage(IMG_BAD);
  const session = await createSession({ ...PROFILE, goal: '想放个猫窝' });
  s.sessionId = session.id; evidence.sessions.C = session.id;
  note(`session=${session.id} 使用非室内照片 img4_useflow.jpg`);
  await upload(session.id, img);
  let r = await analyzeFlexible(session.id, 'quality', [{ metrics: img.metrics, profile: PROFILE }, {}]);
  const q = r.final;
  evidence.sessions.C_quality = q;
  note(`quality status=${q.status} score=${q.score}`);
  r = await analyzeFlexible(session.id, 'l0', [{ profile: PROFILE }, {}]);
  const l0 = r.final;
  evidence.sessions.C_l0 = l0;
  validateL0V2(l0, s, { requireSpecific: false });
  note(`l0 ${timing(r)} verdict=${l0.verdict} recognition="${l0.recognition}" boundary="${l0.boundary}"`);
  // 诚实性：照片不合格时 L0 仍给 recognition，但 verdict 合理降级
  if (q.status === 'retake') {
    check(l0.verdict !== 'continue', '坏照片（quality=retake）时 L0 verdict 降级（≠ continue）', JSON.stringify(l0.verdict));
  } else {
    warn(`quality.status=${q.status}（模型未判 retake），无法验证 retake→L0 降级链路；recognition/boundary 仍校验`);
  }
  const directionId = l0.recommend?.directionId || l0.directions?.[0]?.id;
  const loop = await runMeasure(session.id, { directionId, profile: PROFILE, answerMode: 'skip' });
  check(loop.converged, '（C）measure 收敛', `rounds=${loop.rounds.length}`);
  const sessionAfter = await getSession(session.id);
  r = await analyzeFlexible(session.id, 'plan', [{ directionId, profile: PROFILE }, { profile: PROFILE }, {}]);
  const plan = r.final;
  evidence.sessions.C_plan = plan;
  validatePlanV2(plan, s, { evidenceMap: evidence.catalog.map, session: sessionAfter, rangeKey: null });
  note(`plan ${timing(r)} verdict=${plan.verdict} headline="${plan.headline}"`);
  if (q.status === 'retake') {
    check(plan.verdict === 'insufficient', '坏照片时 plan.verdict 必须 insufficient（rules 硬规则）', JSON.stringify(plan.verdict));
    check(/(照片|重拍|先别|没量|缺)/.test(String(plan.headline || '')), '坏照片时 headline 与 verdict 一致', JSON.stringify(plan.headline));
  }
  if (!KEEP_DATA) await httpReq('DELETE', `/api/sessions/${session.id}`);
}

// ---- 场景 D：前端可见文案扫描
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释（JS/CSS）
    .replace(/<!--[\s\S]*?-->/g, ' ')    // HTML 注释
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 '); // 行注释（跳过 http://）
}
function scanWebCopy(s) {
  const publicDir = join(ROOT, 'app', 'public');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (/\.(js|mjs|html|css|svg)$/.test(name)) files.push(abs);
    }
  };
  walk(publicDir);
  const hits = [];
  const NEG_WORDS = ['保证', '一定能', '错过']; // 允许「不能保证/不一定/不会错过」等诚实否定式
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel.includes('demo')) continue;
    const raw = readFileSync(file, 'utf8');
    const visible = stripComments(raw);
    const lines = visible.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const w of WEB_BANNED) {
        let from = 0;
        while (true) {
          const at = lines[i].indexOf(w, from);
          if (at < 0) break;
          const prev = lines[i].slice(Math.max(0, at - 2), at);
          const negated = NEG_WORDS.includes(w) && /(不|未|没|无|非|难)/.test(prev);
          if (!negated) hits.push({ file: rel, line: i + 1, word: w, text: lines[i].slice(Math.max(0, at - 30), at + w.length + 30).trim().slice(0, 120) });
          from = at + w.length;
        }
      }
    }
  }
  evidence.webScan = { files: files.length, hits };
  check(files.length >= 8, '扫描到前端文件数 ≥8', String(files.length));
  check(hits.length === 0, '前端可见文案无禁用词（限时/仅剩/最后机会/错过/保证/一定能/研究表明/科学证明/帮你打造/赋能；已排除注释与「不能保证」类诚实否定式）', hits.slice(0, 6).map((h) => `${h.file}:${h.line}「${h.word}」${h.text}`).join(' | '));
  note(`扫描 ${files.length} 个前端文件（已剔除注释），命中 ${hits.length} 处`);
}

/* ---------------------------------------------------------------- main */
async function main() {
  const tStart = Date.now();
  log('='.repeat(76));
  log(`api-e2e-v2 — V2 契约验收 (${BASE})`);
  log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  log(`场景: ${ONLY.join(',')}  keepData=${KEEP_DATA}`);
  log('='.repeat(76));

  await step('0. 环境预检 / 服务端', async (s) => {
    check(existsSync(SERVER_ENTRY), '服务端入口存在', SERVER_ENTRY.replace(ROOT + '\\', ''));
    const health = await ensureServer();
    const h = health.json || {};
    check(h.ok === true, 'GET /api/health ok', health.text.slice(0, 160));
    check(h.hasKey === true, 'health.hasKey=true（真实 DeepSeek）', JSON.stringify(h.hasKey));
    check(h.aiReady === true, 'health.aiReady=true（V2 prompts/rules 已就绪）', JSON.stringify(h.aiReady));
    if (h.aiReady === false) { fatal.push('aiReady=false'); }
    note(`health=${JSON.stringify(h)}`);
    evidence.health = h;
  });

  if (!fatal.length && (ONLY.includes('EVIDENCE') || ONLY.includes('A') || ONLY.includes('B') || ONLY.includes('C'))) {
    await step('1. GET /api/evidence（证据目录）', async (s) => {
      const r = await httpReq('GET', '/api/evidence', { timeout: 10000 });
      check(r.status === 200, 'GET /api/evidence → 200', `status=${r.status}`);
      const j = r.json || {};
      const items = Array.isArray(j.items) ? j.items : [];
      check(items.length >= 25, '证据条目 ≥25', `count=${items.length}`);
      check(j.count === items.length, '返回 count 与 items 数量一致', `count=${j.count} items=${items.length}`);
      check(nonEmptyStr(j.version), 'version 非空', JSON.stringify(j.version));
      check(j.badgeLegend && typeof j.badgeLegend === 'object', 'badgeLegend 存在', JSON.stringify(j.badgeLegend));
      const map = new Map();
      const bad = [];
      const badgeBad = [];
      const urlMissing = [];
      // 契约 §3.4：徽章只允许三个「家族」；强度单独放 strengthLabel，不混进家族名
      const BADGE_FAMILY = ['研究支持', '专家共识', '经验值'];
      let urlOkCount = 0;
      for (const it of items) {
        const miss = ['id', 'claim', 'strength', 'kind', 'badge'].filter((k) => !it[k]);
        if (miss.length) { bad.push(`${it.id || '?'} 缺 ${miss.join('/')}`); continue; }
        if (!STRENGTHS.includes(it.strength)) bad.push(`${it.id} strength=${it.strength}`);
        if (!KINDS.includes(it.kind)) bad.push(`${it.id} kind=${it.kind}`);
        if (typeof it.hasUrl !== 'boolean') bad.push(`${it.id} 缺 hasUrl 布尔`);
        if (/^https?:\/\//.test(it.url || '')) urlOkCount++; else urlMissing.push(it.id);
        if (it.hasUrl !== Boolean(it.url && /^https?:\/\//.test(it.url))) badgeBad.push(`${it.id} hasUrl=${it.hasUrl} 与 url 不一致`);
        // 徽章家族 + strengthLabel + kind 三者自洽
        if (!BADGE_FAMILY.includes(it.badge)) {
          badgeBad.push(`${it.id} badge="${it.badge}" 不在契约三家族 ${BADGE_FAMILY.join('/')}`);
        } else if (it.badge === '研究支持') {
          if (!['强', '中', '弱'].includes(String(it.strengthLabel || ''))) badgeBad.push(`${it.id} badge=研究支持 但 strengthLabel="${it.strengthLabel}" 不在 强/中/弱`);
          if (!(it.strength === 'strong' || it.strength === 'moderate' || it.strength === 'weak')) badgeBad.push(`${it.id} badge=研究支持 但 strength=${it.strength}`);
        } else if (it.badge === '专家共识') {
          if (!['guideline', 'consensus'].includes(it.kind)) badgeBad.push(`${it.id} badge=专家共识 但 kind=${it.kind}`);
        } else if (it.badge === '经验值') {
          if (it.kind !== 'experience') badgeBad.push(`${it.id} badge=经验值 但 kind=${it.kind}`);
        }
        map.set(it.id, it);
      }
      check(bad.length === 0, '每条证据 id/claim/strength/kind/badge/hasUrl 合法', bad.slice(0, 6).join(' | '));
      check(badgeBad.length === 0, '徽章家族（研究支持/专家共识/经验值）与 strengthLabel/kind 自洽', badgeBad.slice(0, 6).join(' | '));
      check(urlOkCount >= 20, '≥20 条证据带可点击 url（契约 V2 DoD）', `带 url=${urlOkCount}/${items.length}`);
      if (urlMissing.length) note(`无 url 的条目（hasUrl:false，内部规则/证据缺口，诚实标注）：${urlMissing.join(', ')}`);
      check(new Set(items.map((x) => x.id)).size === items.length, '证据 id 唯一');
      const strengths = items.reduce((a, x) => { a[x.strength] = (a[x.strength] || 0) + 1; return a; }, {});
      note(`version=${j.version} items=${items.length} strengths=${JSON.stringify(strengths)} kinds=${JSON.stringify(items.reduce((a, x) => { a[x.kind] = (a[x.kind] || 0) + 1; return a; }, {}))}`);
      evidence.catalog = { version: j.version, count: items.length, items, map };
    });
  }

  if (!fatal.length && ONLY.includes('A')) await step('A. 正常流程（profile + 区间估计 + V2 全字段）', (s) => scenarioA(s));
  if (!fatal.length && ONLY.includes('B')) await step('B. 关键尺寸全缺（verdict 降级）', (s) => scenarioB(s));
  if (!fatal.length && ONLY.includes('C')) await step('C. 坏照片诚实性（非室内照片）', (s) => scenarioC(s));
  if (!fatal.length && ONLY.includes('D')) await step('D. 前端可见文案禁用词扫描', (s) => scanWebCopy(s));

  finish(tStart);
}

function finish(tStart) {
  const totalMs = Date.now() - tStart;
  const failedSteps = steps.filter((s) => !s.ok);
  const softFails = steps.reduce((a, s) => a + (s.softFails || 0), 0);
  log('');
  log('='.repeat(76));
  for (const s of steps) log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${(s.ms / 1000).toFixed(1).padStart(6)}s  ${s.name}  (${s.pass} checks)`);
  log(`  合计 ${(totalMs / 1000).toFixed(1)}s，checks=${totalChecks}，soft-warn=${softFails}`);
  log('='.repeat(76));

  evidence.finishedAt = new Date().toISOString();
  evidence.totalMs = totalMs;
  evidence.totalChecks = totalChecks;
  evidence.softFails = softFails;
  evidence.failed = failedSteps.length;
  evidence.basisReviewCandidates = evidence.basisReviewCandidates || [];
  const out = join(SCRATCH, `qa-e2e-v2-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
  log(`证据: ${out.replace(ROOT + '\\', '')}`);

  log('');
  if (fatal.length) {
    log('RESULT: FAIL（依赖阻塞）: ' + fatal.join(' ; '));
    stopServer(); process.exit(3);
  } else if (failedSteps.length === 0) {
    log(`RESULT: PASS  (${steps.length} 阶段, ${totalChecks} checks, ${(totalMs / 1000).toFixed(1)}s, soft-warn=${softFails})`);
    stopServer(); process.exit(0);
  } else {
    log(`RESULT: FAIL  (${failedSteps.length} 阶段失败, ${failed} checks)`);
    for (const f of failedSteps) {
      log(`  ✗ ${f.name}`);
      for (const i of f.issues.slice(0, 8)) log(`      - ${i.msg}${i.detail ? ' — ' + i.detail : ''}`);
    }
    log('复现: node tests/api-e2e-v2.mjs');
    stopServer(); process.exit(1);
  }
}

process.on('SIGINT', () => { stopServer(); process.exit(130); });
main().catch((e) => { console.error('FATAL:', e?.stack || e); stopServer(); process.exit(1); });
