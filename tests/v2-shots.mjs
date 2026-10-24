#!/usr/bin/env node
// tests/v2-shots.mjs —— V2 双端截图 + 交互验收（CDP 真移动仿真）
//
// 一次 demo 跑完，自动执行 tests/v2-steps-<视口>.json 里的交互步骤：
//   L0 推荐方向 + 折叠 / 区间输入 / 5 个 tab / 依据 popover / 回访卡
// 并断言：无 JS 报错、无横向滚动、#dev-error-banner 空、5 tab 顺序、catFit 6 项、popover 打开且有来源链接、
//        区间输入存在、计划句 / observe / ifThen / usedMeasurements / 回访卡渲染。
//
// 用法: node tests/v2-shots.mjs
// 退出码: 0 通过 / 1 失败 / 2 前置条件缺失

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, BASE, ensureServer, stopServer, healthUp, sleep } from './lib-qa.mjs';

const CDP = join(ROOT, 'tests', 'cdp-probe.mjs');
const SHOTS_DIR = join(ROOT, 'tests', 'screens', 'v2');
const SCRATCH = join(ROOT, '.scratch');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
mkdirSync(SHOTS_DIR, { recursive: true });

const REQUIRED_SHOTS = [
  'v2-l0-recommend', 'v2-measure-range', 'v2-tab-annotate', 'v2-tab-position',
  'v2-tab-constraints', 'v2-tab-items', 'v2-tab-checklist', 'v2-basis-popover', 'v2-followup',
];
const VIEWS = [
  { label: '1440', w: 1440, h: 900, mobile: false, port: 9341 },
  { label: '390', w: 390, h: 844, mobile: true, port: 9342 },
];

const checks = [];
let failed = 0;
function check(ok, msg, detail) {
  checks.push({ ok: !!ok, msg, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}${detail !== undefined ? ' — ' + detail : ''}`);
}
function warn(msg) { checks.push({ ok: true, warn: true, msg }); console.log('  [WARN] ' + msg); }

function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

function runView(view) {
  const stepsFile = join(ROOT, 'tests', `v2-steps-${view.label}.json`);
  const outJson = join(SCRATCH, `qa-v2-shots-${view.label}-${RUN_ID}.json`);
  const shotsDir = SHOTS_DIR;
  console.log(`\n[${view.label}] ${view.w}×${view.h}${view.mobile ? '（CDP 移动仿真）' : ''} — 开始交互流程`);
  const args = [
    CDP,
    `--url=${BASE}/?demo=1`,
    `--w=${view.w}`, `--h=${view.h}`,
    `--mobile=${view.mobile ? '1' : '0'}`,
    `--steps=${stepsFile}`,
    `--shots-dir=${shotsDir}`,
    `--out=${outJson}`,
    `--port=${view.port}`,
    // 注意：不要 encodeURIComponent——参数经 spawn 数组直传，编码后表达式会语法错误导致等满 60s
    `--wait-for=document.getElementById('app')?.getAttribute('data-ready')==='1'`,
    '--wait-for-ms=60000',
  ];
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  const ms = Date.now() - t0;
  let out = null;
  try { out = JSON.parse(readFileSync(outJson, 'utf8')); } catch { /* noop */ }
  return { view, res, ms, out, outJson };
}

function validateView({ view, res, ms, out, outJson }) {
  console.log(`\n[${view.label}] 结果（${(ms / 1000).toFixed(1)}s）`);
  if (!out) {
    check(false, `${view.label} cdp 输出解析`, `stderr=${(res.stderr || '').slice(0, 400)}`);
    return null;
  }
  const d = out.diag || {};
  check(d.vw === view.w && d.vh === view.h, `${view.label} 真实布局视口 = ${view.w}×${view.h}`, `innerWidth=${d.vw} innerHeight=${d.vh}`);
  check(d.hasHorizontalScroll === false, `${view.label} 无横向滚动`, `scrollWidth=${d.docScrollW} vs innerWidth=${d.vw}`);
  check(out.ready === '1', `${view.label} #app data-ready=1`, `ready=${out.ready}`);
  check(d.bannerHidden === true && !String(d.bannerText || '').trim(), `${view.label} #dev-error-banner 空（无 JS 报错红条）`, d.bannerText || '');
  check((out.exceptions || []).length === 0, `${view.label} 无未捕获异常`, JSON.stringify((out.exceptions || []).slice(0, 3)));
  const consoleErrors = (out.consoleErrors || []).filter((m) => m.level === 'error');
  check(consoleErrors.length === 0, `${view.label} 无 console.error`, consoleErrors.slice(0, 3).map((m) => m.text).join(' | '));
  check(out.diag?.bannerHidden === true, `${view.label} 最终态无错误横幅`);

  const steps = Array.isArray(out.steps) ? out.steps : [];
  const byName = Object.fromEntries(steps.filter((s) => s.name).map((s) => [s.name, s]));
  const shots = steps.filter((s) => s.shot);
  const failedSteps = steps.filter((s) => !s.ok);
  console.log(`  [info] steps=${steps.length}，截图=${shots.length}，失败 step=${failedSteps.length}`);
  for (const f of failedSteps) console.log(`  [info] step 失败: ${f.i} ${f.type} ${f.name || ''} — ${f.detail}`);

  // 截图齐全 + 尺寸正确
  for (const base of REQUIRED_SHOTS) {
    const name = `${base}-${view.label}`;
    const step = steps.find((s) => s.shot && String(s.shot.file).includes(name));
    if (!step) { check(false, `${view.label} 缺少截图 ${name}`, JSON.stringify(steps.filter((s) => s.shot).map((s) => s.shot.file))); continue; }
    const file = join(ROOT, step.shot.file);
    check(existsSync(file), `${view.label} 截图文件存在 ${name}`, step.shot.file);
    if (existsSync(file)) {
      const dim = pngSize(file);
      check(dim && dim.width === view.w && dim.height === view.h, `${view.label} 截图尺寸 ${name} = ${view.w}×${view.h}`, dim ? `${dim.width}×${dim.height}` : 'bad png');
    }
  }
  // 5 tab 顺序
  const tabs = byName.tabs?.value ? JSON.parse(byName.tabs.value) : null;
  if (tabs) {
    check(JSON.stringify(tabs.labels) === JSON.stringify(['标注', '位置', '尺寸条件', '建议', '清单']), `${view.label} 5 tab 顺序固定（标注→位置→尺寸条件→建议→清单）`, JSON.stringify(tabs.labels));
    check(JSON.stringify(tabs.panels) === JSON.stringify(['annotate', 'position', 'constraints', 'items', 'checklist']), `${view.label} 5 tab panel 齐全`, JSON.stringify(tabs.panels));
  } else check(false, `${view.label} 读取 tab 结构`, 'tabs step missing');
  // L0 推荐 + 折叠
  const l0 = byName.l0State?.value ? JSON.parse(byName.l0State.value) : null;
  if (l0) {
    check(l0.goalChoices === true, `${view.label} L0 先问一句（#goal-choices）`, JSON.stringify(l0.goalChip));
    check(l0.recommended === 'true', `${view.label} L0 卡片标记推荐方向`, JSON.stringify(l0.recommended));
    check(l0.expanded === 1, `${view.label} L0 只展开 1 个方向`, `expanded=${l0.expanded} collapsed=${l0.collapsed}`);
    if (l0.collapsed < 1) warn(`${view.label} 只有 1 个方向，无可折叠项（模型输出如此，不是缺陷）`);
    check(l0.recommendTag === true, `${view.label} 推荐方向有「推荐」标签`);
    check(String(l0.recommendWhy || '').length > 3, `${view.label} 推荐有 why 说明`, l0.recommendWhy);
  } else check(false, `${view.label} 读取 L0 推荐状态`, 'l0State step missing');
  // 区间输入
  const range = byName.rangeState?.value ? JSON.parse(byName.rangeState.value) : null;
  if (range) {
    check(range.rangeWrap >= 1, `${view.label} 测量卡可切「估个范围」区间输入`, JSON.stringify(range.toggleText));
    check(range.inputs >= 2, `${view.label} 区间输入有上下限两个框`, `inputs=${range.inputs}`);
  } else check(false, `${view.label} 读取区间输入状态`, 'rangeState step missing');
  // 位置 tab
  const pos = byName.position?.value ? JSON.parse(byName.position.value) : null;
  if (pos) {
    check(pos.catfitItems === 6, `${view.label} 「位置」tab 渲染 catFit 6 项`, `items=${pos.catfitItems}`);
    check(Array.isArray(pos.statuses) && pos.statuses.length === 6, `${view.label} catFit 6 项都有状态`, JSON.stringify(pos.statuses));
    check(pos.badges >= 6, `${view.label} catFit 每项带依据徽章`, `badges=${pos.badges}`);
    check(/能被|能藏|资源|砂盆|抓挠|高处|温度/.test(pos.text || ''), `${view.label} 「位置」tab 有机制解释文案`, String(pos.text).slice(0, 100));
  } else check(false, `${view.label} 读取「位置」tab`, 'position step missing');
  // 尺寸条件 tab + 依据 popover
  const cons = byName.constraints?.value ? JSON.parse(byName.constraints.value) : null;
  if (cons) {
    check(cons.badges >= 1, `${view.label} 尺寸条件每条带依据徽章`, `badges=${cons.badges}`);
    check(String(cons.text || '').length > 10, `${view.label} 尺寸条件有内容`, String(cons.text).slice(0, 120));
  } else check(false, `${view.label} 读取尺寸条件 tab`, 'constraints step missing');
  const pop = byName.popover?.value ? JSON.parse(byName.popover.value) : null;
  if (pop) {
    check(pop.open === 'true', `${view.label} 点依据徽章弹出 #basis-popover`, `open=${pop.open}`);
    check(String(pop.text || '').length > 10, `${view.label} popover 显示 claim/source 文本`, String(pop.text).slice(0, 120));
    check(Array.isArray(pop.links) && pop.links.some((u) => /^https?:\/\//.test(u || '')), `${view.label} popover 有可点原文链接`, JSON.stringify(pop.links));
  } else check(false, `${view.label} 读取依据 popover`, 'popover step missing');
  // 清单
  const cl = byName.checklist?.value ? JSON.parse(byName.checklist.value) : null;
  if (cl) {
    check(/周[一二三四五六日末]|今天|明天|周末|上午|下午|晚上/.test(cl.first || ''), `${view.label} checklist[0] 是计划句`, JSON.stringify(cl.first));
    check(cl.observe === 3, `${view.label} 清单含 observe 1/3/7 天`, `observe=${cl.observe}`);
    check(cl.ifThen >= 2, `${view.label} 清单含 ifThen ≥2`, `ifThen=${cl.ifThen}`);
    check(/这份方案用了你量的/.test(cl.used || ''), `${view.label} 显示「这份方案用了你量的 N 个数」`, String(cl.used).slice(0, 100));
  } else check(false, `${view.label} 读取清单 tab`, 'checklist step missing');
  // 回访卡
  const fu = byName.followup?.value ? JSON.parse(byName.followup.value) : null;
  if (fu) {
    check(fu.cards >= 1, `${view.label} ?followup=1 渲染回访轻卡`, `cards=${fu.cards}`);
    check((fu.texts || []).some((t) => /第 \d+ 天|回访|用上了吗|今天做还是周末做/.test(t)), `${view.label} 回访卡有可读文案`, JSON.stringify(fu.texts));
  } else check(false, `${view.label} 读取回访卡`, 'followup step missing');

  return { out, shots };
}

async function main() {
  console.log('='.repeat(76));
  console.log(`v2-shots — V2 双端截图 + 交互验收 (${BASE})`);
  console.log(`开始: ${new Date().toISOString()}  runId=${RUN_ID}`);
  console.log('='.repeat(76));
  await ensureServer();
  const h = await healthUp();
  check(h.up, '/api/health 可访问');
  check(existsSync(CDP), 'cdp-probe.mjs 存在');

  const results = [];
  for (const view of VIEWS) {
    if (!existsSync(join(ROOT, 'tests', `v2-steps-${view.label}.json`))) { check(false, `缺少 v2-steps-${view.label}.json`); continue; }
    const r = runView(view);
    validateView(r);
    results.push({ label: view.label, ms: r.ms, outJson: r.outJson.replace(ROOT + '\\', ''), steps: r.out?.steps?.length, shots: (r.out?.steps || []).filter((s) => s.shot).length });
  }

  const evidence = { runId: RUN_ID, base: BASE, checks, views: results };
  const out = join(SCRATCH, `qa-v2-shots-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`\n证据: ${out.replace(ROOT + '\\', '')}`);
  console.log('-'.repeat(76));
  if (failed === 0) {
    console.log(`RESULT: PASS  (${checks.length} checks，${results.length} 个视口)`);
    console.log(`截图目录: tests/screens/v2/`);
    for (const v of results) console.log(`  ${v.label}: ${v.shots} 张，${(v.ms / 1000).toFixed(1)}s`);
    stopServer(); process.exit(0);
  } else {
    console.log(`RESULT: FAIL  (${failed} 项失败)`);
    console.log('复现: node tests/v2-shots.mjs');
    stopServer(); process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); stopServer(); process.exit(1); });
