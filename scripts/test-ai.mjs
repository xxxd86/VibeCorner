// 猫角落 Corner · AI 逻辑自测（自包含）
// 用法：
//   node scripts/test-ai.mjs                       全量：3 张图 × quality/l0/ask/measure/plan(+缺失降级)
//   node scripts/test-ai.mjs --images=img1 --quick  快速迭代：只跑 img1，跳过 ask 与第二轮测量
//   node scripts/test-ai.mjs --no-save              不写 scripts/last-run.json
// 依赖：只 import 本项目 app/server 下的 prompts.mjs / rules.mjs；Key 从 app/.env 读，不打印。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequest, normalize } from '../app/server/prompts.mjs';
import { apply, MEASUREMENT_KEYS, MEASUREMENT_SPECS, SKUS, SKU_BY_ID } from '../app/server/rules.mjs';
import { allEvidence } from '../app/server/evidence.mjs';

const EVIDENCE = allEvidence();
const EVIDENCE_BY_ID = new Map((EVIDENCE.items || []).map((e) => [e.id, e]));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const QUICK = ARGS.includes('--quick');
const RULES_ONLY = ARGS.includes('--rules-only');
const NO_SAVE = ARGS.includes('--no-save');
const IMAGE_FILTER = (ARGS.find((a) => a.startsWith('--images=')) || '').replace('--images=', '').split(',').filter(Boolean);
const PLAN_THINKING = (ARGS.find((a) => a.startsWith('--plan-thinking=')) || '').replace('--plan-thinking=', '');

function loadEnv() {
  const raw = fs.readFileSync(path.join(ROOT, 'app', '.env'), 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const ENV = loadEnv();
const API_KEY = ENV.DEEPSEEK_API_KEY || '';
const BASE_URL = (ENV.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = ENV.DEEPSEEK_MODEL || 'deepseek-flash';
const IMG_DIR = path.join(ROOT, 'doc', '猫角落改造助手 · 项目思路与执行纲领', '图片和附件');

const IMAGES = [
  { key: 'img1', file: 'img1_scene.jpg', goal: '客厅沙发旁的空墙想放个猫窝，预算 300，那盆龟背竹要留着', keep: ['龟背竹'] },
  { key: 'img2', file: 'img2_annotate.jpg', goal: '电视柜右边的墙角想放猫窝和抓板，预算 300', keep: [] },
  { key: 'img3', file: 'img3_measure.jpg', goal: '电视柜和门之间的墙角想放猫窝，预算 300，通道要能过人', keep: [] }
].filter((img) => !IMAGE_FILTER.length || IMAGE_FILTER.includes(img.key));

const ANSWER_CM = {
  corridorWidth: 62,
  cornerWidthA: 80,
  cornerWidthB: 70,
  freeDepth: 52,
  obstructionH: 30,
  ceilingFree: 180,
  outletDist: 150,
  doorSwing: 85,
  windowDist: 120
};

const BANNED_WORDS = ['赋能', '打造', '极致', '一站式', '完美', '绝对', '保证', '100%', '一定能', '百分百', '研究表明', '科学证明', '多陪玩就不会乱抓', '限时', '仅剩', '最后机会', '错过', '必须', '等于'];
// L0 只允许「有条件继续 / 当前条件不支持 / 信息不足」；否定句（不能/没法/无法）不算越级
const L0_FORBIDDEN_PATTERNS = [
  [/(?<![不未没法])可行/, '可行'],
  [/(?<![不未没法否])能放下/, '能放下'],
  [/(?<![不未没法否])放得下/, '放得下'],
  [/放得进去/, '放得进去'],
  [/推荐买|推荐购买/, '推荐买'],
  [/保证/, '保证'],
  [/一定可以/, '一定可以']
];
const DUMP = ARGS.includes('--dump');
const L0_DISCLAIMER = '这是方向预览，不是摆放结论；关键尺寸补齐前不能判断能不能放下。';
const L1_DISCLAIMER = '以交付时的尺寸条件为准，落地前请现场确认。';

const rows = [];
const payloads = [];
let current = null;
let totalTokens = 0;
let totalMs = 0;

function check(cond, message) {
  if (!cond) current.fails.push(message);
  return !!cond;
}

function allStrings(value, out = [], skipKeys = null) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out, skipKeys);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (skipKeys && skipKeys.has(k)) continue;
      allStrings(v, out, skipKeys);
    }
  }
  return out;
}

function findBanned(value) {
  // basisText 是证据目录原文（可能引用「必须比猫大 2 倍」这类待辟谣说法），不算模型营销文案
  const text = allStrings(value, [], new Set(['basisText'])).join('\n');
  return BANNED_WORDS.filter((w) => text.includes(w));
}

function findL0Forbidden(value) {
  const text = allStrings(value).join('\n');
  return L0_FORBIDDEN_PATTERNS.filter(([re]) => re.test(text)).map(([, name]) => name);
}

function isBbox(b) {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v)) && b[0] >= 0 && b[1] >= 0 && b[2] > 0 && b[3] > 0 && b[0] + b[2] <= 1.001 && b[1] + b[3] <= 1.001;
}

function bboxArea(b) {
  return b[2] * b[3];
}

function brief(value, max = 180) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callAPI(stage, session) {
  const req = buildRequest(stage, session);
  const body = {
    model: MODEL,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    thinking: req.thinking,
    response_format: req.response_format,
    stream: false
  };
  // 思考开关 A/B：--plan-thinking=disabled|enabled|low|max
  if (stage === 'plan' && PLAN_THINKING) {
    body.thinking = PLAN_THINKING === 'disabled'
      ? { type: 'disabled' }
      : PLAN_THINKING === 'low' || PLAN_THINKING === 'max'
        ? { type: 'enabled', effort: PLAN_THINKING }
        : { type: 'enabled' };
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(150000)
      });
      const raw = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1200 * attempt));
          continue;
        }
        throw lastErr;
      }
      const data = JSON.parse(raw);
      const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '';
      const usage = data.usage || {};
      return {
        content,
        ms,
        usage,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        reasoningTokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
        reasoningLen: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.reasoning_content || '').length
      };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastErr;
}

async function runStage(imageLabel, stage, session, assertions, stageLabel = stage) {
  current = { image: imageLabel, stage: stageLabel, ms: 0, tokens: 0, jsonOk: false, pass: false, fails: [], verdict: '', note: '' };
  rows.push(current);
  try {
    const res = await callAPI(stage, session);
    current.ms = res.ms;
    current.tokens = res.promptTokens + res.completionTokens;
    totalMs += res.ms;
    totalTokens += current.tokens;
    const json = parseJson(res.content);
    current.jsonOk = !!json;
    check(!!json, '返回内容不是合法 JSON');
    const normalized = normalize(stage, res.content, session);
    const applied = apply(stage, normalized, session);
    payloads.push({ image: imageLabel, stage: stageLabel, normalized, applied });
    if (DUMP) console.log(`    dump[${stageLabel}]: ${brief(JSON.stringify(applied), 1600)}`);
    if (assertions) assertions(applied, normalized, res, json);
    current.pass = current.fails.length === 0;
    const tag = current.pass ? 'PASS' : 'FAIL';
    console.log(
      `[${imageLabel}] ${stageLabel.padEnd(11)} ${tag}  ${(res.ms / 1000).toFixed(2)}s  in=${res.promptTokens} out=${res.completionTokens} think=${res.reasoningTokens}  json=${current.jsonOk ? 'ok' : 'BAD'}  ${current.note}`
    );
    if (!current.pass) for (const f of current.fails) console.log(`    ✗ ${f}`);
    return applied;
  } catch (err) {
    current.fails.push(`API 调用失败：${err && err.message ? err.message : err}`);
    current.pass = false;
    console.log(`[${imageLabel}] ${stageLabel.padEnd(11)} FAIL  API error: ${err && err.message ? err.message : err}`);
    return null;
  }
}

function assertNoBanned(value) {
  const banned = findBanned(value);
  check(!banned.length, `出现禁用词：${banned.join('、')}`);
}

function assertQuality(q) {
  check(['pass', 'retake'].includes(q.status), `quality.status 非法：${q.status}`);
  check(Number.isInteger(q.score) && q.score >= 0 && q.score <= 100, `quality.score 非法：${q.score}`);
  check(typeof q.scene === 'object' && q.scene !== null, 'scene 缺失');
  check(['none', 'some', 'heavy'].includes(q.scene.obstruction), `obstruction 非法：${q.scene.obstruction}`);
  check(Array.isArray(q.issues), 'issues 不是数组');
  check(typeof q.photoTip === 'string' && q.photoTip.length > 0, 'photoTip 为空');
  for (const issue of q.issues) {
    check(['dark', 'blurry', 'occluded', 'no_floor', 'not_indoor', 'too_close', 'other'].includes(issue.code), `issue.code 非法：${issue.code}`);
    check(['block', 'warn'].includes(issue.severity), `issue.severity 非法：${issue.severity}`);
    check(['high', 'mid', 'low'].includes(issue.impact), `issue.impact 非法：${issue.impact}`);
  }
  if (q.issues.some((i) => i.severity === 'block')) check(q.status === 'retake', '有 block 问题但 status != retake');
  assertNoBanned(q);
  current.note = `status=${q.status} score=${q.score} issues=${q.issues.map((i) => i.code).join(',') || '无'}`;
}

function assertL0(l0) {
  check(['continue', 'not_supported', 'insufficient'].includes(l0.verdict), `l0.verdict 非法：${l0.verdict}`);
  check(l0.directions.length >= 1 && l0.directions.length <= 3, `directions 数量越界：${l0.directions.length}`);
  check(l0.regions.length <= 5, `regions 超过 5 个：${l0.regions.length}`);
  check(l0.missing.length >= 1, 'missing 为空（L0 必须给缺失项）');
  for (const r of l0.regions) {
    check(isBbox(r.bbox), `region ${r.id} bbox 非法：${JSON.stringify(r.bbox)}`);
    if (isBbox(r.bbox)) check(bboxArea(r.bbox) <= 0.45 && bboxArea(r.bbox) >= 0.005, `region ${r.id} bbox 面积异常：${bboxArea(r.bbox).toFixed(3)}`);
    check(['ok', 'conditional', 'blocked', 'unknown'].includes(r.verdict), `region ${r.id} verdict 非法：${r.verdict}`);
    check(typeof r.label === 'string' && r.label.length > 0, `region ${r.id} label 为空`);
    check(typeof r.why === 'string' && r.why.length > 0, `region ${r.id} why 为空`);
  }
  for (const d of l0.directions) {
    check(['new', 'reuse', 'mix'].includes(d.kit), `direction ${d.id} kit 非法：${d.kit}`);
    check(['high', 'medium', 'low'].includes(d.confidence), `direction ${d.id} confidence 非法：${d.confidence}`);
    check(d.firstMeasurements.length >= 1 && d.firstMeasurements.length <= 2, `direction ${d.id} firstMeasurements 数量异常`);
    for (const f of d.firstMeasurements) check(!!MEASUREMENT_SPECS[f.key], `direction ${d.id} 测量 key 不在字典：${f.key}`);
    if (d.regionId != null) check(l0.regions.some((r) => r.id === d.regionId), `direction ${d.id} regionId 不存在：${d.regionId}`);
  }
  for (const m of l0.missing) check(!!MEASUREMENT_SPECS[m.key], `missing key 不在字典：${m.key}`);

  // V2：env（照片可见环境事实）
  check(l0.env && typeof l0.env === 'object', 'L0 env 缺失');
  if (l0.env) {
    check(['wood', 'tile', 'carpet', 'unknown'].includes(l0.env.floorType), `env.floorType 非法：${l0.env.floorType}`);
    check(Array.isArray(l0.env.nearAppliance) && l0.env.nearAppliance.every((a) => ['washer', 'fridge', 'speaker'].includes(a)), 'env.nearAppliance 非法');
    check(typeof l0.env.nearFood === 'boolean', 'env.nearFood 不是布尔');
    check(typeof l0.env.draft === 'boolean', 'env.draft 不是布尔');
    check(['none', 'indirect', 'direct'].includes(l0.env.sunlight), `env.sunlight 非法：${l0.env.sunlight}`);
    check(typeof l0.env.wallExterior === 'boolean', 'env.wallExterior 不是布尔');
  }
  // V2：只推荐 1 个方向
  check(l0.recommend && typeof l0.recommend === 'object', 'L0 recommend 缺失');
  if (l0.recommend) {
    check(l0.directions.some((d) => d.id === l0.recommend.directionId), `recommend.directionId 不存在：${l0.recommend.directionId}`);
    check(typeof l0.recommend.why === 'string' && l0.recommend.why.length > 0, 'recommend.why 为空');
  }

  // V2.1：一句具体指认 + 一句专业边界
  check(typeof l0.recognition === 'string' && Array.from(l0.recognition).length >= 6 && Array.from(l0.recognition).length <= 30, `L0 recognition 长度异常：${l0.recognition}`);
  check(!/^(一个|这个)?角落$/.test(l0.recognition || ''), `L0 recognition 太泛：${l0.recognition}`);
  check(typeof l0.boundary === 'string' && Array.from(l0.boundary).length >= 8 && Array.from(l0.boundary).length <= 40, `L0 boundary 长度异常：${l0.boundary}`);
  // 至少 1 个不花钱的复用方向
  check(l0.directions.some((d) => d.kit === 'reuse'), 'directions 里没有 kit=reuse（不花钱方向）');

  check(l0.disclaimer === L0_DISCLAIMER, 'L0 免责文案不匹配');
  const forbidden = findL0Forbidden(l0);
  check(forbidden.length === 0, `L0 出现越级断言：${forbidden.join('、')}`);
  assertNoBanned(l0);
  current.note = `verdict=${l0.verdict} regions=${l0.regions.length} dirs=${l0.directions.length} env=${l0.env ? `${l0.env.floorType}/${l0.env.sunlight}` : '—'} rec=${l0.recommend ? l0.recommend.directionId : '—'} bbox=${l0.regions.map((r) => r.bbox.map((n) => n.toFixed(2)).join('/')).join(' | ')}`;
}

function assertAsk(ask) {
  check(typeof ask.reply === 'string' && ask.reply.length > 0, 'ask.reply 为空');
  check(['ok', 'conditional', 'blocked', 'insufficient'].includes(ask.verdict), `ask.verdict 非法：${ask.verdict}`);
  check(Array.isArray(ask.pieces) && ask.pieces.length >= 1 && ask.pieces.length <= 4, `ask.pieces 数量异常：${Array.isArray(ask.pieces) ? ask.pieces.length : 'not array'}`);
  check(Array.isArray(ask.missing) && ask.missing.length <= 3, 'ask.missing 不是数组或超过 3 条');
  for (const p of ask.pieces) check(typeof p === 'string' && p.length > 0, 'ask.pieces 含空项');
  const forbidden = findL0Forbidden(ask);
  check(forbidden.length === 0, `ask 出现越级断言：${forbidden.join('、')}`);
  assertNoBanned(ask);
  current.note = `verdict=${ask.verdict} pieces=${ask.pieces.length} missing=${ask.missing.join(',')}`;
}

function assertMeasure(measure, sessionBefore) {
  check(Number.isInteger(measure.totalTargets) && measure.totalTargets >= 1, `totalTargets 非法：${measure.totalTargets}`);
  check(Number.isInteger(measure.attemptedTargets) && measure.attemptedTargets >= 0, `attemptedTargets 非法：${measure.attemptedTargets}`);
  check(measure.attemptedTargets <= measure.totalTargets, `attemptedTargets > totalTargets：${measure.attemptedTargets}/${measure.totalTargets}`);
  if (sessionBefore && sessionBefore.measureDone === true) {
    check(measure.questions.length === 0 && measure.remainingKeys.length === 0, 'measureDone 时 questions/remainingKeys 应为空');
    check(measure.attemptedTargets === measure.totalTargets, 'measureDone 时 attemptedTargets 应等于 totalTargets');
    current.note = `measureDone=true → 空 questions，进度 ${measure.attemptedTargets}/${measure.totalTargets}`;
    return;
  }
  // 收敛：target 喝完 → questions 空、remainingKeys 空（P1 修复）
  if (measure.questions.length === 0) {
    check(measure.remainingKeys.length === 0, `questions 为空但 remainingKeys 非空：${measure.remainingKeys.join(',')}`);
    check(measure.attemptedTargets === measure.totalTargets, '收敛时 attemptedTargets 应等于 totalTargets');
    current.note = `CONVERGED questions=[] 进度 ${measure.attemptedTargets}/${measure.totalTargets}`;
    return;
  }
  // 进度必须真实：remainingKeys = 尚未 attempted 的 target，attempted + remaining = total
  check(measure.attemptedTargets + measure.remainingKeys.length === measure.totalTargets, `进度不守恒：attempted ${measure.attemptedTargets} + remaining ${measure.remainingKeys.length} != total ${measure.totalTargets}`);
  check(measure.questions.length >= 1 && measure.questions.length <= 2, `questions 数量异常：${measure.questions.length}`);
  const keys = new Set();
  for (const q of measure.questions) {
    check(!!MEASUREMENT_SPECS[q.key], `question key 不在字典：${q.key}`);
    check(!keys.has(q.key), `question key 重复：${q.key}`);
    keys.add(q.key);
    check(measure.remainingKeys.includes(q.key), `remainingKeys 不包含本轮问题 key：${q.key}（进度环会自相矛盾）`);
    check(q.unit === 'cm', `unit 不是 cm：${q.unit}`);
    check(typeof q.endpoints === 'string' && q.endpoints.length > 0, 'endpoints 为空');
    check(typeof q.why === 'string' && q.why.length > 0, 'why 为空');
    check(typeof q.optional === 'boolean', 'optional 不是布尔');
  }
  check(measure.remainingKeys.length >= measure.questions.length, `remainingKeys 少于本轮问题数：${measure.remainingKeys.length} < ${measure.questions.length}`);
  check(Number.isInteger(measure.round) && measure.round >= 1, `round 非法：${measure.round}`);
  assertNoBanned(measure);
  current.note = `round=${measure.round} keys=${measure.questions.map((q) => q.key).join(',')} remaining=${measure.remainingKeys.join(',') || '—'}`;
}

function assertPlan(plan, options = {}) {
  const { missingCase = false, qualityRetake = false, session = null } = options;
  check(['ok', 'conditional', 'not_supported', 'insufficient'].includes(plan.verdict), `plan.verdict 非法：${plan.verdict}`);
  check(typeof plan.headline === 'string' && plan.headline.length > 0, 'headline 为空');
  check(plan.annotations.length <= 5, `annotations 超过 5 个：${plan.annotations.length}`);
  for (const a of plan.annotations) {
    check(isBbox(a.bbox), `annotation ${a.id} bbox 非法：${JSON.stringify(a.bbox)}`);
    check(typeof a.label === 'string' && a.label.length > 0, `annotation ${a.id} label 为空`);
  }
  for (const item of plan.items) {
    check(['new', 'reuse'].includes(item.type), `item.type 非法：${item.type}`);
    check(['ok', 'blocked'].includes(item.fit), `item.fit 非法：${item.fit}`);
    if (item.type === 'new') check(!!SKU_BY_ID.get(item.sku), `item.sku 不在 SKU 库：${item.sku}`);
    check(typeof item.dimsCm === 'object' && item.dimsCm !== null, `item.dimsCm 缺失：${item.id}`);
  }
  for (const c of plan.constraints) {
    check(!!MEASUREMENT_SPECS[c.key], `constraint key 不在字典：${c.key}`);
    check(['pass', 'warn', 'fail', 'unknown'].includes(c.status), `constraint.status 非法：${c.key}=${c.status}`);
    check(['>=', '<=', '>', '<', '=='].includes(c.op), `constraint.op 非法：${c.key}=${c.op}`);
  }
  check(plan.checklist.length >= 1, 'checklist 为空');
  for (const c of plan.checklist) check(typeof c.text === 'string' && c.text.length > 0, 'checklist.text 为空');
  check(plan.radar.length === 5, `radar 必须是 5 维，实际 ${plan.radar.length}`);
  const radarKeys = plan.radar.map((r) => r.key).join(',');
  check(radarKeys === 'hide,path,sun,quiet,flow', `radar key 顺序/内容非法：${radarKeys}`);
  for (const r of plan.radar) check(Number.isInteger(r.score) && r.score >= 0 && r.score <= 5, `radar.score 非法：${r.key}=${r.score}`);
  check(plan.disclaimer === L1_DISCLAIMER, 'L1 免责文案不匹配');
  check(typeof plan.aftercare.day7 === 'string' && typeof plan.aftercare.day14 === 'string', 'aftercare 缺失');
  assertNoBanned(plan);
  const l1Forbidden = allStrings(plan).join('\n');
  check(!/保证安全/.test(l1Forbidden), 'L1 出现「保证安全」');
  check(!/保证猫(会)?喜欢/.test(l1Forbidden), 'L1 出现「保证猫会喜欢」');
  check(!/代替现场确认/.test(l1Forbidden), 'L1 出现「代替现场确认」');

  // ===== V2：catFit 6 项（确定性 verdict） =====
  check(plan.catFit && typeof plan.catFit === 'object', 'plan.catFit 缺失');
  if (plan.catFit) {
    const keys = plan.catFit.items.map((i) => i.key).join(',');
    check(keys === 'hide,resources,litter,scratch,vertical,climate', `catFit key 顺序/数量非法：${keys}`);
    for (const it of plan.catFit.items) {
      check(['pass', 'warn', 'fail', 'na', 'unknown'].includes(it.status), `catFit ${it.key} status 非法：${it.status}`);
      if (it.status === 'na') check(it.basisId === 'NA-RULE', `catFit ${it.key} 的 na 应挂 NA-RULE，实际 ${it.basisId}`);
      const whyLen = Array.from(String(it.why || '')).length;
      check(whyLen >= 8 && whyLen <= 40, `catFit ${it.key} why 长度异常：${whyLen}`);
      check(!!EVIDENCE_BY_ID.get(it.basisId), `catFit ${it.key} basisId 不在证据目录：${it.basisId}`);
      if (EVIDENCE_BY_ID.get(it.basisId)) {
        check(it.strength === EVIDENCE_BY_ID.get(it.basisId).strength, `catFit ${it.key} strength 与证据目录不一致`);
      }
      check(typeof it.basisText === 'string' && it.basisText.length > 0, `catFit ${it.key} basisText 为空（应从证据目录取）`);
    }
    const failCount = plan.catFit.items.filter((i) => i.status === 'fail').length;
    const warnCount = plan.catFit.items.filter((i) => i.status === 'warn').length;
    const passCount = plan.catFit.items.filter((i) => i.status === 'pass').length;
    const hideStatus = plan.catFit.items.find((i) => i.key === 'hide');
    const litterStatus = plan.catFit.items.find((i) => i.key === 'litter');
    const keyUnknown = (hideStatus && hideStatus.status === 'unknown') || (litterStatus && litterStatus.status === 'unknown');
    const expected = failCount > 0 ? 'poor' : keyUnknown ? 'unknown' : warnCount >= 2 ? 'caution' : passCount >= 4 ? 'good' : 'caution';
    check(plan.catFit.verdict === expected, `catFit verdict 与 status 不一致：${plan.catFit.verdict} != ${expected}`);
  }

  // ===== V2：constraints 每条挂证据；PASSAGE_WIDTH 永不 fail =====
  let passageCount = 0;
  for (const c of plan.constraints) {
    check(!!EVIDENCE_BY_ID.get(c.basisId), `constraint ${c.key} basisId 不在证据目录：${c.basisId}`);
    if (EVIDENCE_BY_ID.get(c.basisId)) {
      check(c.strength === EVIDENCE_BY_ID.get(c.basisId).strength, `constraint ${c.key} strength 与证据目录不一致`);
    }
    check(typeof c.honest === 'boolean', `constraint ${c.key} 缺 honest`);
    if (c.basisId === 'PASSAGE_WIDTH') {
      passageCount += 1;
      check(c.status !== 'fail', `PASSAGE_WIDTH 永远不能 fail，实际 ${c.status}`);
      check(c.honest === true, 'PASSAGE_WIDTH 必须 honest:true（经验阈值）');
    }
  }
  check(passageCount >= 1, '缺少带 PASSAGE_WIDTH 依据的通道约束');

  // ===== V2：behavior / observe / ifThen / usedMeasurements / litterCount =====
  check(plan.behavior && typeof plan.behavior === 'object', 'plan.behavior 缺失');
  if (plan.behavior) {
    check(typeof plan.behavior.likelyUse === 'string' && plan.behavior.likelyUse.length > 0, 'behavior.likelyUse 为空');
    check(Array.isArray(plan.behavior.whyNot) && plan.behavior.whyNot.length <= 3, 'behavior.whyNot 非法');
    check(typeof plan.behavior.firstSign === 'string' && plan.behavior.firstSign.length > 0, 'behavior.firstSign 为空');
  }
  check(Array.isArray(plan.observe) && plan.observe.map((o) => o.day).join(',') === '1,3,7', `observe 必须含 1/3/7 天，实际 ${(plan.observe || []).map((o) => o.day).join(',')}`);
  for (const o of plan.observe || []) {
    check(typeof o.title === 'string' && o.title.length > 0, `observe 第 ${o.day} 天 title 为空`);
    check(Array.isArray(o.checks) && o.checks.length >= 1 && o.checks.length <= 4, `observe 第 ${o.day} 天 checks 数量异常`);
    for (const c of o.checks || []) check(typeof c === 'string' && c.length > 0, `observe 第 ${o.day} 天含空 check`);
  }
  const day3 = (plan.observe || []).find((o) => o.day === 3);
  check(day3 && (day3.checks || []).some((c) => /(3\s*天|三天).*不算失败/.test(c)), 'observe 第 3 天缺「3 天内不用不算失败」');
  check(Array.isArray(plan.ifThen) && plan.ifThen.length >= 2 && plan.ifThen.length <= 3, `ifThen 必须 2—3 条，实际 ${(plan.ifThen || []).length}`);
  for (const x of plan.ifThen || []) {
    check(typeof x.if === 'string' && /(\d+\s*(天|次|周|小时)|\d+%|出现|留下|没有|超过|连续|每天|一周|三天|七天|尿|抓痕|压痕|毛发)/.test(x.if), `ifThen.if 不是可观察事实：${x.if}`);
    check(typeof x.then === 'string' && x.then.length <= 30 && !/(多观察|注意一下|留意|再看看|多种|同时|并且|，|,|；|;)/.test(x.then), `ifThen.then 不是单一动作：${x.then}`);
  }
  // na 的项不能出现在 ifThen 里（不涉及的方案不该给它的排查分支）
  if (plan.catFit) {
    const byKey = Object.fromEntries(plan.catFit.items.map((i) => [i.key, i]));
    for (const x of plan.ifThen || []) {
      const text = `${x.if} ${x.then}`;
      if (/抓板|抓痕/.test(text)) check(byKey.scratch && byKey.scratch.status !== 'na', `scratch=na 却出现在 ifThen：${x.if}`);
      if (/砂盆|尿|厕所/.test(text)) check(byKey.litter && byKey.litter.status !== 'na', `litter=na 却出现在 ifThen：${x.if}`);
    }
  }
  // V2.1：checklist[0] 必须是计划句（时间 + 地点 + 可核对条件）
  const planSentence = (plan.checklist && plan.checklist[0] && plan.checklist[0].text) || '';
  check(/(周[一二三四五六日末]|今天|明天|周末|工作日|上午|下午|晚上)/.test(planSentence), `checklist[0] 缺时间：${planSentence}`);
  check(/(去|到|在)(店里|商店|网上|家|客厅|房间|此处|现场|宠物店)/.test(planSentence), `checklist[0] 缺地点：${planSentence}`);
  check(/(≥|≤|>\s*\d|<\s*\d|\d+\s*cm|进深|宽度|长度|尺寸|净宽)/.test(planSentence), `checklist[0] 缺可核对条件：${planSentence}`);
  check(Array.from(planSentence).length <= 40, `checklist[0] 超过 40 字：${planSentence}`);
  check(!/[\d×≥≤<>/．.、-]$/.test(planSentence.trim()), `checklist[0] 截断在数字/单位/型号中间：${planSentence}`);
  // 猫窝/休息点尺寸约束必须挂 REST_SIZE_STRETCH，不能挂 HIDING_ENCLOSURE（语义错）
  const spaceCons = plan.constraints.filter((c) => c.key === 'cornerWidthA' || c.key === 'freeDepth');
  for (const c of spaceCons) {
    check(c.basisId !== 'HIDING_ENCLOSURE', `constraint ${c.key} 仍挂 HIDING_ENCLOSURE（语义不对）`);
    if (c.basisId === 'REST_SIZE_STRETCH') check(c.honest === true, `constraint ${c.key} 挂 REST_SIZE_STRETCH 时应 honest:true`);
    check(typeof c.why === 'string' && /(体长|经验阈值|倍数|取大)/.test(c.why), `constraint ${c.key} 的 why 缺阈值推导：${c.why}`);
  }
  // 位置已否决（catFit fail）时，方案必须阻断且 headline 先行否定
  if (plan.catFit && plan.catFit.items.some((i) => i.status === 'fail')) {
    const isMove = /换位置方案/.test(plan.headline || '');
    if (!isMove) {
      check(plan.verdict === 'not_supported', `catFit 有 fail 但 verdict=${plan.verdict}（应 not_supported）`);
      check(/^先别放/.test(plan.headline || ''), `catFit 有 fail 但 headline 不以「先别放」开头：${plan.headline}`);
      check((plan.blocked || []).some((b) => /位置否决/.test(b.what)), 'catFit fail 时 blocked 缺「位置否决」条目');
    }
  }
  // 砂盆方案的 hide 必须是 na，不能套猫窝文案
  if (plan.catFit) {
    const hideItem = plan.catFit.items.find((i) => i.key === 'hide');
    const hasLitter = (plan.items || []).some((i) => i.sku && /^SKU-00[56]$|^SKU-013$/.test(i.sku));
    if (hasLitter && hideItem) check(hideItem.status === 'na', `砂盆方案 hide 应为 na，实际 ${hideItem.status}：${hideItem.why}`);
  }
  // V2.1：observe 第 1 天二选一 + 第 7 天可操作判定
  const day1Observe = plan.observe.find((o) => o.day === 1);
  check(day1Observe && day1Observe.checks.some((c) => /(今天|周末|周[一二三四五六日]).*(做|量|试|开始|去)/.test(c)), 'observe 第 1 天缺二选一计划句');
  const day7Observe = plan.observe.find((o) => o.day === 7);
  check(day7Observe && day7Observe.checks.some((c) => /主动使用.*(≥|>=|至少|2\s*次|次数)/.test(c)), 'observe 第 7 天缺可操作判定');
  // V2.1：firstSign 必须是可观察信号
  check(/(\d+\s*天|三天|7\s*天|一周|次|没有主动|没有进去|停留|压痕|毛发)/.test(plan.behavior.firstSign || ''), `behavior.firstSign 不是可观察信号：${plan.behavior.firstSign}`);
  // V2.1：区间估计标记
  for (const c of plan.constraints) check(typeof c.estimate === 'boolean', `constraint ${c.key} 缺 estimate`);

  check(Array.isArray(plan.usedMeasurements), 'plan.usedMeasurements 不是数组');
  if (session) {
    const expectedKeys = Object.entries(session.measurements || {})
      .filter(([, v]) => v && v.source === 'user' && typeof v.valueMm === 'number' && !v.skipped)
      .map(([k]) => k)
      .sort();
    const usedKeys = (plan.usedMeasurements || []).map((u) => u.key).sort();
    check(JSON.stringify(usedKeys) === JSON.stringify(expectedKeys), `usedMeasurements 与用户实测不一致：${usedKeys.join(',')} != ${expectedKeys.join(',')}`);
    for (const u of plan.usedMeasurements || []) {
      const m = session.measurements && session.measurements[u.key];
      check(!!m && Math.abs((m.valueMm / 10) - u.valueCm) < 0.05, `usedMeasurements ${u.key} 数值与 session 不一致`);
      check(u.label === MEASUREMENT_SPECS[u.key].label, `usedMeasurements ${u.key} label 非法`);
    }
  }
  check(plan.litterCount && plan.litterCount.basisId === 'LITTER_BOX_COUNT', 'litterCount 缺 LITTER_BOX_COUNT 依据');
  if (plan.litterCount) {
    check(plan.litterCount.status !== 'fail', `LITTER_BOX_COUNT 永远不能 fail，实际 ${plan.litterCount.status}`);
    check(plan.litterCount.honest === true, 'LITTER_BOX_COUNT 必须 honest:true');
  }

  // 输出体积上限（Lead 要求，防止 reasoning + 输出顶满 maxTokens）
  check(plan.items.length <= 4, `items 超过 4 个：${plan.items.length}`);
  check(plan.annotations.length <= 3, `annotations 超过 3 个：${plan.annotations.length}`);
  check(plan.checklist.length <= 6, `checklist 超过 6 条：${plan.checklist.length}`);
  check(plan.blocked.length <= 4, `blocked 超过 4 条：${plan.blocked.length}`);
  check(plan.constraints.length <= 5, `constraints 超过 5 条：${plan.constraints.length}`);
  for (const r of plan.radar) check(Array.from(String(r.note || '')).length <= 12, `radar note 超过 12 字：${r.note}`);
  for (const item of plan.items) {
    if (item.fit === 'blocked') {
      check(typeof item.fitNote === 'string' && item.fitNote.length > 0, `blocked item ${item.id} fitNote 为空`);
      check(/(才|需|补|换|再|条件|复算)/.test(item.fitNote || ''), `blocked item ${item.id} fitNote 没写可行条件：${item.fitNote}`);
    }
  }

  // headline 与 verdict 一致（Lead 的产品底线）
  if (plan.verdict === 'not_supported') {
    check(/^(不可|不建议|先别|别|需换|当前条件不支持)/.test(plan.headline), `not_supported 时 headline 未否定：${plan.headline}`);
  }
  if (plan.verdict === 'insufficient') {
    check(/(还差|没量|缺|未量|重拍|先别|先量)/.test(plan.headline), `insufficient 时 headline 未点明缺什么：${plan.headline}`);
  }
  if (plan.verdict === 'ok' && /(不|别|无法)/.test(plan.headline.slice(0, 2))) {
    check(false, `verdict=ok 但 headline 是否定式：${plan.headline}`);
  }
  // conditional = 有条件可放：肯定语义必须同时出现在条件里
  if (plan.verdict === 'conditional' && /(完全可以|可以放|能放|可换|能换|放得下|可行|没问题|推荐)/.test(plan.headline)) {
    check(/(但|满足|才可|条件|若|如果|需要先|先看|先量)/.test(plan.headline), `conditional 的肯定 headline 缺条件：${plan.headline}`);
  }

  // L1 可交付性：关键约束全 pass 且有 fit=ok 商品时，verdict 必须是 ok/conditional（不能一直 insufficient）
  if (!missingCase && !qualityRetake) {
    const criticalPass = ['corridorWidth', 'cornerWidthA', 'freeDepth'].every((k) => {
      const c = plan.constraints.find((x) => x.key === k);
      return c && c.status === 'pass';
    });
    const someItemOk = plan.items.some((i) => i.fit === 'ok');
    if (criticalPass && someItemOk && plan.budget.status !== 'over') {
      check(['ok', 'conditional'].includes(plan.verdict), `关键约束全 pass 且有 fit=ok 商品，verdict 不应是 ${plan.verdict}`);
    }
  }

  // verdict 一致性（产品底线）
  const unknownConstraints = plan.constraints.filter((c) => c.status === 'unknown');
  if (plan.verdict === 'ok') {
    check(unknownConstraints.length === 0, `verdict=ok 但存在 unknown 约束：${unknownConstraints.map((c) => c.key).join(',')}`);
    check(plan.items.length > 0 && plan.items.every((i) => i.fit === 'ok'), 'verdict=ok 但存在 blocked 商品');
    check(plan.budget.status !== 'over', 'verdict=ok 但预算超限');
  }
  if (missingCase) {
    check(plan.verdict === 'insufficient', `关键尺寸缺失时 verdict 必须降级为 insufficient，实际：${plan.verdict}`);
    check(unknownConstraints.length > 0, '关键尺寸缺失时 constraints 应含 unknown');
    check(plan.blocked.length > 0, '关键尺寸缺失时应写入 blocked');
    current.note = `DEGRADED verdict=${plan.verdict} unknownConstraints=${unknownConstraints.map((c) => c.key).join(',')}`;
  } else {
    current.note = `verdict=${plan.verdict} items=${plan.items.length} okItems=${plan.items.filter((i) => i.fit === 'ok').length} blocked=${plan.blocked.length} budget=${plan.budget.est}/${plan.budget.cap ?? '—'}(${plan.budget.status})`;
  }
}

// ---------- 本地规则单元断言（不调 API） ----------

function runRuleUnitChecks() {
  console.log('\n── 确定性规则单测（不调模型） ──');
  const checks = [];
  const measurements = {
    corridorWidth: { valueMm: 620, valueCm: 62 },
    cornerWidthA: { valueMm: 800, valueCm: 80 },
    freeDepth: { valueMm: 520, valueCm: 52 }
  };
  const baseSession = {
    quality: { status: 'pass', scene: { obstruction: 'none' } },
    profile: { budget: 300, keep: [], goal: '', cats: 1, catSize: 'medium', catAge: 'adult', multiCat: false, floorType: 'wood', climate: 'unknown' },
    measurements,
    l0: { env: { floorType: 'wood', nearAppliance: [], nearFood: false, draft: false, sunlight: 'indirect', wallExterior: false } }
  };
  const basePlan = {
    verdict: 'ok',
    headline: '可以放',
    annotations: [{ id: '1', label: '猫窝', bbox: [0.3, 0.55, 0.25, 0.2], note: '' }],
    items: [{ id: 'i1', type: 'new', sku: 'SKU-001', title: '半封闭猫窝', dimsCm: { w: 45, d: 40, h: 38 }, price: 129, why: '', fit: 'ok', fitNote: '', confidence: 'high', tags: [] }],
    constraints: [],
    checklist: [{ id: 'c1', text: '现场核对 #1', critical: true }],
    blocked: [],
    radar: [],
    aftercare: {}
  };

  // 1) 关键尺寸缺失 → insufficient
  {
    const out = apply('plan', { ...basePlan }, { ...baseSession, measurements: {} });
    checks.push(['关键尺寸缺失 → verdict 降级', out.verdict === 'insufficient' && out.constraints.some((c) => c.status === 'unknown')]);
    checks.push(['关键尺寸缺失 → blocked 写入', out.blocked.some((b) => /关键尺寸/.test(b.what))]);
  }
  // 2) 预算超限 → 最多 conditional
  {
    const out = apply('plan', { ...basePlan }, { ...baseSession, profile: { budget: 100, keep: [] } });
    checks.push(['预算超限 → budget.over + verdict 非 ok', out.budget.status === 'over' && out.verdict !== 'ok' && out.blocked.some((b) => /预算/.test(b.what))]);
  }
  // 3) 库外 SKU → 丢弃并 blocked
  {
    const out = apply('plan', { ...basePlan, items: [{ ...basePlan.items[0], sku: 'SKU-999' }] }, baseSession);
    checks.push(['库外 SKU → 丢弃 + blocked', out.items.length === 0 && out.blocked.some((b) => /库内/.test(b.reason))]);
  }
  // 4) 遮挡保留物未处理 → conditional + 清单注入
  {
    const out = apply('plan', { ...basePlan }, { ...baseSession, profile: { budget: 300, keep: ['龟背竹'] } });
    checks.push(['保留物未处理 → verdict 降级 + 清单注入', out.verdict === 'conditional' && out.checklist.some((c) => c.text.includes('龟背竹'))]);
  }
  // 5) 通道 <60cm：PASSAGE_WIDTH 只 warn，不阻断、不判不合格
  {
    const out = apply('plan', { ...basePlan }, { ...baseSession, measurements: { ...measurements, corridorWidth: { valueMm: 550, valueCm: 55 } } });
    const passage = out.constraints.find((c) => c.basisId === 'PASSAGE_WIDTH');
    checks.push(['通道 <60cm → PASSAGE_WIDTH 只 warn', !!passage && passage.status === 'warn' && passage.honest === true]);
    checks.push(['通道 <60cm → 商品仍 fit=ok、verdict 非 not_supported', out.items[0].fit === 'ok' && out.verdict !== 'not_supported']);
  }
  // 6) 猫爬架关键未知 → blocked
  {
    const session = { ...baseSession, measurements: { ...measurements, ceilingFree: { valueMm: 2400, valueCm: 240 }, obstructionH: { valueMm: 300, valueCm: 30 } } };
    const plan = { ...basePlan, items: [{ ...basePlan.items[0], sku: 'SKU-007' }] };
    const out = apply('plan', plan, session);
    checks.push(['猫爬架固定/承重未知 → blocked', out.items[0].fit === 'blocked' && /固定|承重/.test(out.items[0].fitNote)]);
  }
  // 7) measureDone → 空 questions
  {
    const out = apply('measure', { questions: [{ key: 'corridorWidth' }], remainingKeys: ['freeDepth'] }, { ...baseSession, measureDone: true });
    checks.push(['measureDone=true → 空 questions', out.questions.length === 0 && out.remainingKeys.length === 0]);
  }
  // 8) cm→mm 换算
  {
    const out = apply('measure', { questions: [{ key: 'corridorWidth' }] }, { ...baseSession, measurements: {} });
    checks.push(['measure 选题 key 合法', out.questions.every((q) => MEASUREMENT_KEYS.includes(q.key))]);
  }
  // 9) measure 收敛：补题池只用 target，不会把 9 个字典 key 全问一遍
  {
    const session = {
      measurements: { corridorWidth: { valueMm: 620 }, cornerWidthA: { valueMm: 800 }, freeDepth: { valueMm: 520 } },
      chosenDirectionId: 'd1',
      l0: {
        directions: [{ id: 'd1', firstMeasurements: [{ key: 'cornerWidthA' }, { key: 'corridorWidth' }] }],
        missing: [{ key: 'cornerWidthB' }]
      }
    };
    const out = apply('measure', { questions: [] }, session);
    checks.push(['target 未齐时只补 target 内 key', out.questions.length >= 1 && out.questions.every((q) => q.key === 'cornerWidthB')]);
  }
  {
    const session = {
      measurements: {
        corridorWidth: { valueMm: 620 },
        cornerWidthA: { valueMm: 800 },
        freeDepth: { valueMm: 520 },
        cornerWidthB: { valueMm: 700, skipped: true }
      },
      chosenDirectionId: 'd1',
      l0: {
        directions: [{ id: 'd1', firstMeasurements: [{ key: 'cornerWidthA' }, { key: 'corridorWidth' }] }],
        missing: [{ key: 'cornerWidthB' }]
      }
    };
    const out = apply('measure', { questions: [] }, session);
    checks.push(['target 全 attempted → questions=[]（可置 measureDone）', out.questions.length === 0 && out.remainingKeys.length === 0]);
  }
  // 10) freeDepth 不足 → not_supported 且 headline 必须否定
  {
    const session = { ...baseSession, measurements: { ...measurements, freeDepth: { valueMm: 440, valueCm: 44 } } };
    const out = apply('plan', { ...basePlan, headline: '墙角可换半包式猫窝' }, session);
    checks.push(['freeDepth 不足 → verdict=not_supported + headline 否定', out.verdict === 'not_supported' && /^(先别|不可|不建议|需换)/.test(out.headline)]);
  }
  // 11) 规则全过但模型保守说 insufficient → 至少给 conditional（L1 可交付）
  {
    const out = apply('plan', { ...basePlan, verdict: 'insufficient', headline: '还差侧墙长度没量' }, baseSession);
    checks.push(['关键约束全过 + fit=ok + 模型保守 → conditional', out.verdict === 'conditional' && /能放|条件/.test(out.headline)]);
  }
  // 12) 纯复用但旧物尺寸未知 → insufficient，headline 指向量旧物
  {
    const plan = {
      ...basePlan,
      items: [{ id: 'i1', type: 'reuse', sku: null, title: '现有猫窝', dimsCm: { w: 0, d: 0, h: 0 }, price: 0, fit: 'blocked', fitNote: '', confidence: 'low', tags: [] }],
      annotations: []
    };
    const out = apply('plan', { ...plan, verdict: 'not_supported', headline: '现有猫窝可原位保留' }, baseSession);
    checks.push(['纯复用缺尺寸 → insufficient + 先量旧物', out.verdict === 'insufficient' && /先量/.test(out.headline)]);
  }
  // 13) V2 catFit 六项 + verdict 公式
  {
    const out = apply('plan', { ...basePlan }, baseSession);
    const items = out.catFit ? out.catFit.items : [];
    checks.push([
      'catFit 六项齐全且 basis 在证据目录',
      items.map((i) => i.key).join(',') === 'hide,resources,litter,scratch,vertical,climate' && items.every((i) => EVIDENCE_BY_ID.has(i.basisId))
    ]);
    const failCount = items.filter((i) => i.status === 'fail').length;
    const warnCount = items.filter((i) => i.status === 'warn').length;
    const passCount = items.filter((i) => i.status === 'pass').length;
    const keyUnknown = items.some((i) => (i.key === 'hide' || i.key === 'litter') && i.status === 'unknown');
    const expected = failCount > 0 ? 'poor' : keyUnknown ? 'unknown' : warnCount >= 2 ? 'caution' : passCount >= 4 ? 'good' : 'caution';
    checks.push(['catFit verdict 由状态确定性算出', out.catFit && out.catFit.verdict === expected]);
  }
  // 14) LITTER_BOX_COUNT 永远 warn
  {
    const out = apply('plan', { ...basePlan }, baseSession);
    checks.push(['LITTER_BOX_COUNT 软建议且永不 fail', out.litterCount && out.litterCount.basisId === 'LITTER_BOX_COUNT' && out.litterCount.status === 'warn' && out.litterCount.honest === true]);
  }
  // 15) observe / ifThen 兜底
  {
    const out = apply('plan', { ...basePlan, observe: [], ifThen: [] }, baseSession);
    checks.push(['observe 1/3/7 + 3 天不算失败兜底', out.observe.map((o) => o.day).join(',') === '1,3,7' && out.observe.find((o) => o.day === 3).checks.some((c) => /3\s*天.*不算失败/.test(c))]);
    checks.push(['ifThen 兜底 ≥2 且格式合法', Array.isArray(out.ifThen) && out.ifThen.length >= 2 && out.ifThen.every((x) => typeof x.if === 'string' && typeof x.then === 'string')]);
  }
  // 16) usedMeasurements 只含 source=user
  {
    const session = {
      ...baseSession,
      measurements: {
        corridorWidth: { valueMm: 620, valueCm: 62, source: 'user' },
        cornerWidthA: { valueMm: 800, valueCm: 80, source: 'user' },
        freeDepth: { valueMm: 520, valueCm: 52, source: 'user' },
        cornerWidthB: { valueMm: 700, valueCm: 70, source: 'inferred' }
      }
    };
    const out = apply('plan', { ...basePlan }, session);
    checks.push(['usedMeasurements 只含 source=user', out.usedMeasurements.length === 3 && out.usedMeasurements.every((u) => u.key !== 'cornerWidthB')]);
  }
  // 17) 砂盆方案：litter 项挂 LITTER_BOX_SIZE，按体型估算
  {
    const out = apply('plan', { ...basePlan, items: [{ ...basePlan.items[0], sku: 'SKU-013' }] }, baseSession);
    const litter = out.catFit.items.find((i) => i.key === 'litter');
    checks.push(['砂盆方案 litter 项挂 LITTER_BOX_SIZE', litter && litter.basisId === 'LITTER_BOX_SIZE']);
  }
  // 18) 区间估计：按保守端判定 + estimate 标记
  {
    const session = {
      ...baseSession,
      measurements: {
        ...measurements,
        corridorWidth: { valueMm: 550, valueCm: 55, rangeCm: [55, 65], estimate: true, source: 'user', skipped: false }
      }
    };
    const out = apply('plan', { ...basePlan }, session);
    const passage = out.constraints.find((c) => c.basisId === 'PASSAGE_WIDTH');
    checks.push(['区间估计按保守端 + note 标保守', passage && passage.estimate === true && passage.status === 'warn' && /保守/.test(passage.note)]);
  }
  // 19) L0 recognition / boundary / 至少一个 reuse 方向兜底
  {
    const l0 = {
      scene: { summary: '电视柜右侧墙角，旁边有个插座', roomGuess: '客厅', light: 'bright', floor: 'wood' },
      verdict: 'continue',
      regions: [{ id: 'r1', label: '电视柜右侧墙角', bbox: [0.3, 0.5, 0.2, 0.2], verdict: 'conditional', why: '', risk: '' }],
      directions: [{ id: 'd1', title: '墙角放猫窝', pitch: '', kit: 'new', firstMeasurements: [{ key: 'corridorWidth' }], confidence: 'low' }],
      missing: [{ key: 'corridorWidth' }]
    };
    const out = apply('l0', l0, baseSession);
    checks.push(['L0 recognition/boundary 兜底非空', Array.from(out.recognition).length >= 6 && Array.from(out.boundary).length >= 8]);
    checks.push(['L0 至少一个 reuse 方向兜底', out.directions.some((d) => d.kit === 'reuse')]);
  }
  // 20) measure 真实进度：attempted + remaining = total
  {
    const session = {
      ...baseSession,
      l0: {
        directions: [{ id: 'd1', firstMeasurements: [{ key: 'cornerWidthA' }, { key: 'corridorWidth' }] }],
        missing: [{ key: 'freeDepth' }]
      },
      measurements: { cornerWidthA: { valueMm: 800, valueCm: 80, source: 'user' } }
    };
    const out = apply('measure', { questions: [] }, session);
    checks.push(['measure totalTargets=3 / attempted=1 / remaining=2', out.totalTargets === 3 && out.attemptedTargets === 1 && out.remainingKeys.length === 2]);
  }
  // 21) 计划句 / observe 二选一 / firstSign 可观察 兜底
  {
    const plan = {
      ...basePlan,
      checklist: [{ id: 'c1', text: '把绿植挪走', critical: true }],
      behavior: { likelyUse: '', whyNot: [], firstSign: '看猫喜不喜欢' },
      observe: [],
      ifThen: []
    };
    const out = apply('plan', plan, baseSession);
    const firstCheck = out.checklist[0] && out.checklist[0].text;
    checks.push(['checklist[0] 计划句兜底', /(周[一二三四五六日末]|今天|周末)/.test(firstCheck) && /(去|到|在)(店里|现场|家)/.test(firstCheck) && /(≥|≤|cm|进深|尺寸)/.test(firstCheck)]);
    checks.push(['observe 第 1 天二选一 + 第 7 天次数判定', out.observe.find((o) => o.day === 1).checks.some((c) => /今天.*周末/.test(c)) && out.observe.find((o) => o.day === 7).checks.some((c) => /主动使用.*≥2/.test(c))]);
    checks.push(['firstSign 不可观察时被替换', /(\d+\s*天|三天|7\s*天|没有主动|停留)/.test(out.behavior.firstSign)]);
  }
  // 22) na 状态：不涉及的项不能算 pass（虚假绿色）
  {
    const out = apply('plan', { ...basePlan }, baseSession);
    const byKey = Object.fromEntries(out.catFit.items.map((i) => [i.key, i]));
    checks.push(['不涉及砂盆/高位/抓板 → na', byKey.litter.status === 'na' && byKey.vertical.status === 'na' && byKey.scratch.status === 'na']);
    checks.push(['na 挂 NA-RULE 依据', byKey.litter.basisId === 'NA-RULE' && byKey.vertical.basisId === 'NA-RULE']);
    checks.push(['na 不把 catFit 算成 good（pass 只有 3 项）', out.catFit.verdict === 'caution']);
    checks.push(['NA-RULE 在证据目录', EVIDENCE_BY_ID.has('NA-RULE')]);
  }
  // 23) 休息点尺寸约束挂 REST_SIZE_STRETCH + honest，不挂 HIDING_ENCLOSURE
  {
    const out = apply('plan', { ...basePlan }, baseSession);
    const space = out.constraints.filter((c) => c.key === 'cornerWidthA' || c.key === 'freeDepth');
    checks.push(['尺寸约束挂 REST_SIZE_STRETCH 且 honest', space.length >= 1 && space.every((c) => c.basisId === 'REST_SIZE_STRETCH' && c.honest === true)]);
    checks.push(['尺寸约束没挂 HIDING_ENCLOSURE', space.every((c) => c.basisId !== 'HIDING_ENCLOSURE')]);
  }
  // 24) 计划句 ≤40 字且不截断在数字/单位/型号
  {
    const out = apply('plan', { ...basePlan, checklist: [{ id: 'c1', text: '把绿植挪走', critical: true }] }, baseSession);
    const text = out.checklist[0].text;
    checks.push(['计划句 ≤40 字且不截断', Array.from(text).length <= 40 && !/[\d×≥≤<>/．.、-]$/.test(text)]);
  }
  // 25) 纯复用（dims 0）+ 尺寸缺失 → 三个关键约束都要列为 unknown
  {
    const plan = {
      ...basePlan,
      items: [{ id: 'i1', type: 'reuse', sku: null, title: '现有猫窝', dimsCm: { w: 0, d: 0, h: 0 }, price: 0, fit: 'blocked', fitNote: '', confidence: 'low', tags: [] }],
      annotations: []
    };
    const out = apply('plan', plan, { ...baseSession, measurements: {} });
    const unknownKeys = out.constraints.filter((c) => c.status === 'unknown').map((c) => c.key);
    checks.push(['复用缺尺寸 → 3 个关键约束 unknown', ['corridorWidth', 'cornerWidthA', 'freeDepth'].every((k) => unknownKeys.includes(k))]);
  }
  // 26) conditional 的肯定 headline（如「可换」）没有条件 → 被替换成中性条件句
  {
    const out = apply('plan', { ...basePlan, verdict: 'conditional', headline: '墙角可换半包窝，先清走旧窝和抓板' }, baseSession);
    checks.push(['conditional 肯定 headline 无条件 → 中性化', out.verdict === 'conditional' && /(但|满足|才可|条件)/.test(out.headline) && !/可换/.test(out.headline)]);
  }
  // 27) constraints.status 允许 warn（契约四态）
  {
    const out = apply('plan', { ...basePlan }, { ...baseSession, measurements: { ...measurements, corridorWidth: { valueMm: 550, valueCm: 55 } } });
    checks.push(['constraint 四态含 warn', out.constraints.some((c) => c.status === 'warn')]);
  }
  // 28) 真实场景：砂盆方案 + 洗衣机邻接 → catFit litter=fail ⇒ not_supported / 先别放 / blocked
  const sandboxPlan = {
    ...basePlan,
    items: [{ ...basePlan.items[0], id: 'i1', type: 'new', sku: 'SKU-013', fit: 'ok', dimsCm: { w: 50, d: 38, h: 16 }, price: 59 }],
    annotations: [{ id: '1', label: '砂盆', bbox: [0.3, 0.55, 0.25, 0.2], note: '洗衣机旁墙根' }]
  };
  const washerSession = {
    ...baseSession,
    profile: { ...baseSession.profile },
    l0: { env: { floorType: 'tile', nearAppliance: ['washer'], nearFood: false, draft: false, sunlight: 'indirect', wallExterior: false } },
    measurements: { ...measurements }
  };
  {
    const out = apply('plan', sandboxPlan, washerSession);
    const byKey = Object.fromEntries(out.catFit.items.map((i) => [i.key, i]));
    checks.push(['真实场景：洗衣机旁砂盆 litter=fail', byKey.litter.status === 'fail' && byKey.litter.basisId === 'LITTER_NEAR_APPLIANCE']);
    checks.push(['litter fail ⇒ plan not_supported + 先别放', out.verdict === 'not_supported' && /^先别放/.test(out.headline)]);
    checks.push(['litter fail ⇒ blocked 位置否决', out.blocked.some((b) => /位置否决/.test(b.what) && /洗衣机/.test(b.reason))]);
    checks.push(['砂盆方案 hide=na（不套猫窝文案）', byKey.hide.status === 'na' && /不涉及休息点/.test(byKey.hide.why)]);
    checks.push(['砂盆尺寸约束 why 写体长推导', out.constraints.filter((c) => c.key !== 'corridorWidth').every((c) => /体长/.test(c.why || ''))]);
  }
  // 29) 换位置方案例外：明确「移到远离洗衣机」→ 允许 conditional
  {
    const movePlan = { ...sandboxPlan, headline: '把砂盆移到远离洗衣机的位置', checklist: [{ id: 'c1', text: '把砂盆移到远离洗衣机的位置', critical: true }] };
    const out = apply('plan', movePlan, washerSession);
    checks.push(['换位置方案 → conditional + 换位置方案 headline', out.verdict === 'conditional' && /换位置方案/.test(out.headline)]);
  }
  // 30) 遮挡场景：env/标注提示杂物 → freeDepth pass 必须降 warn + note
  {
    const obstructSession = {
      ...baseSession,
      l0: { env: { floorType: 'wood', nearAppliance: [], nearFood: false, draft: false, sunlight: 'indirect', wallExterior: false, note: '墙角有纸箱和杂物挡住' } }
    };
    const out = apply('plan', { ...basePlan, annotations: [{ id: '1', label: '猫窝', bbox: [0.3, 0.55, 0.25, 0.2], note: '前面有纸箱挡住' }] }, obstructSession);
    const fd = out.constraints.find((c) => c.key === 'freeDepth');
    checks.push(['遮挡场景 freeDepth 不能直接 pass', !!fd && fd.status === 'warn' && /杂物/.test(fd.note)]);
  }
  // 31) 尺寸阈值来源一致：medium 猫窝 = 体长 45 × 1.0 取商品 45，宽 ×0.6 取商品 40
  {
    const out = apply('plan', { ...basePlan }, baseSession);
    const cw = out.constraints.find((c) => c.key === 'cornerWidthA');
    const fd = out.constraints.find((c) => c.key === 'freeDepth');
    checks.push(['休息点阈值由体长推导：宽 40 / 深 45', cw && cw.valueCm === 40 && fd && fd.valueCm === 45]);
    checks.push(['阈值 why 含 medium 体长 45cm 推导', cw && /medium.*45cm|45cm.*medium/.test(cw.why || '') && /取大/.test(cw.why || '')]);
  }
  // 32) 照片 retake：优先 insufficient 先重拍（即使 catFit 有 fail），与产品 F2 一致
  {
    const retakeSession = {
      ...washerSession,
      quality: { status: 'retake', score: 40, issues: [{ code: 'occluded', severity: 'block', label: '遮挡' }] }
    };
    const out = apply('plan', sandboxPlan, retakeSession);
    checks.push(['retake 优先 → insufficient（先重拍）', out.verdict === 'insufficient']);
    const safeRetake = apply('plan', { ...basePlan }, { ...baseSession, quality: { status: 'retake', score: 40, issues: [{ code: 'other', severity: 'block' }] } });
    checks.push(['retake 无 catFail → 仍 insufficient', safeRetake.verdict === 'insufficient']);
  }

  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    rows.push({ image: 'rules', stage: 'unit', ms: 0, tokens: 0, jsonOk: true, pass: ok, fails: ok ? [] : [name], verdict: '', note: name });
  }
  return checks.every(([, ok]) => ok);
}

// ---------- 主流程 ----------

async function runImage(image) {
  const absPath = path.join(IMG_DIR, image.file);
  const metrics = { brightness: 118, contrast: 46, sharpness: 180, width: 2730, height: 1536 };
  const session = {
    id: `t_${image.key}`,
    image: { imageId: image.key, absPath, width: 2730, height: 1536 },
    metrics,
    profile: {
      goal: image.goal,
      budget: 300,
      keep: image.keep,
      cats: 1,
      catSize: 'medium',
      catAge: 'adult',
      multiCat: false,
      floorType: 'unknown',
      climate: 'unknown',
      primaryPain: '猫不进去'
    },
    quality: null,
    l0: null,
    asks: [],
    measurements: {},
    plan: null,
    picks: [],
    chosenDirectionId: null,
    analysisNote: ''
  };

  console.log(`\n══ ${image.key} · ${image.file} ══`);
  if (!fs.existsSync(absPath)) {
    rows.push({ image: image.key, stage: 'file', ms: 0, tokens: 0, jsonOk: false, pass: false, fails: [`图片不存在：${absPath}`], verdict: '', note: '' });
    return;
  }

  // 1) quality
  const quality = await runStage(image.key, 'quality', session, (q) => assertQuality(q));
  if (!quality) return;
  session.quality = quality;

  // 2) l0
  const l0 = await runStage(image.key, 'l0', session, (payload) => assertL0(payload));
  if (!l0) return;
  session.l0 = l0;
  session.chosenDirectionId = l0.directions[0] ? l0.directions[0].id : null;

  // 3) ask（画布点选）
  if (!QUICK) {
    session.picks = [{ nx: 0.62, ny: 0.68, note: '这里想放猫窝' }];
    const ask = await runStage(image.key, 'ask', session, (payload) => assertAsk(payload));
    if (ask) session.picks[0].reply = ask.reply;
  }

  // 4) measure：逐轮出题 → 答题 → 直到收敛（questions:[]）。最多 4 轮，验证 P1 修复
  const askedKeys = [];
  let converged = false;
  const maxRounds = QUICK ? 1 : 4;
  for (let round = 1; round <= maxRounds; round += 1) {
    session.measureDone = false;
    const res = await runStage(image.key, 'measure', session, (payload) => assertMeasure(payload, session), `measure-r${round}`);
    if (!res) break;
    if (res.questions.length === 0) {
      converged = true;
      break;
    }
    for (const q of res.questions) {
      const cm = ANSWER_CM[q.key];
      session.measurements[q.key] = { valueMm: cm * 10, valueCm: cm, source: 'user', at: new Date().toISOString(), skipped: false };
      askedKeys.push(q.key);
    }
    session.asks.push({ round: res.round, questions: res.questions, answers: { ...ANSWER_CM }, at: new Date().toISOString() });
  }
  if (!QUICK) {
    rows.push({
      image: image.key,
      stage: 'measure-done',
      ms: 0,
      tokens: 0,
      jsonOk: true,
      pass: converged,
      fails: converged ? [] : [`measure 在 ${maxRounds} 轮内没有收敛（questions 没有变空）`],
      verdict: '',
      note: converged ? `CONVERGED in ≤${maxRounds} 轮，已量：${Object.keys(session.measurements).join(',') || '无'}` : '未收敛'
    });
    if (!converged) console.log(`  ✗ measure 未在 ${maxRounds} 轮内收敛`);
  }
  session.measureDone = true;

  // 6) plan（已量尺寸）
  const plan = await runStage(image.key, 'plan', session, (payload) => assertPlan(payload, { qualityRetake: session.quality && session.quality.status === 'retake', session }));
  if (plan) session.plan = plan;

  // 7) plan（关键尺寸缺失 → 必须降级）
  const missingSession = JSON.parse(JSON.stringify({
    ...session,
    measurements: {},
    plan: null,
    asks: [],
    measureDone: true
  }));
  const missingPlan = await runStage(image.key, 'plan', missingSession, (payload) => assertPlan(payload, { missingCase: true, session: missingSession }), 'plan-missing');
  if (!missingPlan) return;

  console.log(`  ↳ 测量补齐：${Object.keys(session.measurements).join(',') || '（无）'}；plan 实测 verdict=${plan ? plan.verdict : '—'}；关键缺失 verdict=${missingPlan.verdict}`);
}

async function main() {
  console.log('猫角落 Corner · AI 逻辑自测');
  console.log(`model=${MODEL}  base=${BASE_URL}  keyLen=${API_KEY.length}  images=${IMAGES.map((i) => i.key).join(',')}  quick=${QUICK}  planThinking=${PLAN_THINKING || '配置默认(plan disabled)'}`);
  console.log(`SKU 库：${SKUS.length} 个；测量字典：${MEASUREMENT_KEYS.length} 个 key；证据目录：${(EVIDENCE.items || []).length} 条（${EVIDENCE.version || '—'}）`);
  if (!API_KEY && !RULES_ONLY) {
    console.error('缺少 DEEPSEEK_API_KEY（app/.env）');
    process.exit(1);
  }

  for (const image of RULES_ONLY ? [] : IMAGES) {
    await runImage(image);
  }

  runRuleUnitChecks();

  // 汇总表
  console.log('\n══════════ 汇总 ══════════');
  const pad = (s, n) => {
    const w = Array.from(String(s)).reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
    return String(s) + ' '.repeat(Math.max(0, n - w));
  };
  console.log(`${pad('图', 8)}${pad('阶段', 13)}${pad('结果', 7)}${pad('耗时', 9)}${pad('tokens', 10)}${pad('JSON', 7)}备注`);
  for (const r of rows) {
    console.log(`${pad(r.image, 8)}${pad(r.stage, 13)}${pad(r.pass ? 'PASS' : 'FAIL', 7)}${pad((r.ms / 1000).toFixed(2) + 's', 9)}${pad(r.tokens, 10)}${pad(r.jsonOk ? 'ok' : 'BAD', 7)}${r.note}`);
    for (const f of r.fails) console.log(`${pad('', 8)}${pad('', 13)}↳ ${f}`);
  }

  const failures = rows.filter((r) => !r.pass);
  const apiRows = rows.filter((r) => r.stage !== 'unit' && r.stage !== 'file');
  const jsonBad = apiRows.filter((r) => !r.jsonOk);
  console.log(`\n总计：${rows.length} 项断言组，失败 ${failures.length}；API 调用 ${apiRows.length} 次，非 JSON ${jsonBad.length} 次`);
  console.log(`累计耗时 ${(totalMs / 1000).toFixed(1)}s，累计 tokens ${totalTokens}（含 thinking）`);
  console.log(failures.length === 0 ? '\n✅ PASS 全部通过' : `\n❌ FAIL：${failures.length} 项未通过`);
  process.exitCode = failures.length === 0 ? 0 : 1;

  if (!NO_SAVE) {
    const savePath = path.join(ROOT, 'scripts', 'last-run.json');
    fs.writeFileSync(
      savePath,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          model: MODEL,
          quick: QUICK,
          rows: rows.map((r) => ({ image: r.image, stage: r.stage, pass: r.pass, ms: r.ms, tokens: r.tokens, jsonOk: r.jsonOk, note: r.note, fails: r.fails })),
          totals: { calls: apiRows.length, tokens: totalTokens, ms: totalMs },
          payloads
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`结果已写入 ${savePath}`);
  }
}

(main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
}));
