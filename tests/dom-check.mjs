#!/usr/bin/env node
// tests/dom-check.mjs —— 独立验收：契约第 4 节 DOM / 静态资源检查
// 零依赖。只解析文本，不启动浏览器。
// 用法: node tests/dom-check.mjs
// 退出码: 0 全部通过 / 1 有失败 / 2 index.html 不存在（功能未落地）

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'app', 'public');
const HTML_PATH = join(PUBLIC_DIR, 'index.html');

// ---- 契约第 4 节「必须存在的 ID」（docs/CONTRACT.md L171，逐字抄录） ----
const REQUIRED_IDS = [
  'app', 'rail', 'brand', 'btn-new', 'session-list', 'btn-privacy',
  'stage', 'stage-title', 'stage-chip', 'btn-help', 'btn-panel-toggle',
  'feed', 'composer', 'suggest-chips', 'composer-box', 'btn-attach',
  'file-input', 'composer-input', 'btn-send', 'composer-foot',
  'canvas-panel', 'canvas-badge', 'panel-empty', 'canvas-stage',
  'scene-canvas', 'canvas-hint', 'canvas-toolbar',
  'btn-zoom-out', 'btn-zoom-fit', 'btn-zoom-in', 'btn-pick-mode',
  'measure-dock', 'measure-progress', 'measure-progress-bar', 'measure-dock-list',
  'deliver-dock', 'btn-deliver', 'btn-export',
  'toast-host', 'modal-host', 'dev-error-banner',
];

// 契约 5.7：唯一入口必须是 /js/app.js 的 module script
const REQUIRED_MODULE_ENTRIES = ['/js/app.js'];

const pass = [];
const fail = [];
const warn = [];

function P(msg) { pass.push(msg); }
function F(msg, detail) { fail.push({ msg, detail }); }
function W(msg) { warn.push(msg); }

if (!existsSync(HTML_PATH)) {
  console.error(`[FAIL] 缺少 ${HTML_PATH}`);
  console.error('  → index.html 尚未落地（UI 外壳任务未完成），本次 dom-check 无法执行。');
  console.error('  复现: node tests/dom-check.mjs');
  process.exit(2);
}

const raw = readFileSync(HTML_PATH, 'utf8');
const htmlBytes = Buffer.byteLength(raw);
if (raw.charCodeAt(0) === 0xfeff) W('index.html 带 UTF-8 BOM（契约第 9.3 条要求无 BOM）');

// 去掉 HTML 注释：注释里的 id/href 不算真实 DOM
const html = raw.replace(/<!--[\s\S]*?-->/g, '');

// ---- 1. 必存 ID ----
const idMap = new Map();
for (const m of html.matchAll(/(?<![\w-])id\s*=\s*["']([^"']+)["']/g)) {
  idMap.set(m[1], (idMap.get(m[1]) || 0) + 1);
}
const idDup = [];
for (const [id, n] of idMap) if (n > 1) idDup.push(id);
const missingIds = REQUIRED_IDS.filter((id) => !idMap.has(id));

if (missingIds.length === 0) {
  P(`必存 ID ${REQUIRED_IDS.length}/${REQUIRED_IDS.length} 全部存在`);
} else {
  F(`必存 ID 缺失 ${missingIds.length}/${REQUIRED_IDS.length}`, missingIds.join(', '));
}
if (idDup.length) W(`重复 id: ${idDup.join(', ')}（HTML 中 id 应唯一）`);

// ---- 2. 入口 module script ----
const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
const scriptSrcs = [];
for (const attrs of scriptTags) {
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
  if (src) scriptSrcs.push(src[1]);
}
const moduleScripts = scriptSrcs.filter((s) => /\/js\/app\.js(?:[?#]|$)/.test(s));
if (moduleScripts.length) {
  P(`入口 script 存在: ${moduleScripts.join(', ')}`);
} else {
  F('缺少 <script type="module" src="/js/app.js">', `实际 script src: ${scriptSrcs.length ? scriptSrcs.join(', ') : '（无外链 script）'}`);
}

// ---- 3. 引用资源真实存在 ----
function resolveAsset(ref) {
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return null;
  if (/^(https?:)?\/\//i.test(clean) || /^(data|javascript|mailto):/i.test(clean)) return null; // 外链不检查
  // 注意：Windows 上 path.resolve(PUBLIC, '/js/app.js') 会被当成盘符绝对路径，必须先去掉前导斜杠
  const rel = clean.replace(/^[/\\]+/, '');
  return resolve(PUBLIC_DIR, rel);
}

const refs = [];
for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
  const attrs = m[1];
  const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || '';
  const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
  if (href) refs.push({ kind: `link[rel=${rel || '?'}]`, ref: href });
}
for (const m of html.matchAll(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
  refs.push({ kind: 'script[src]', ref: m[2] });
}
refs.push({ kind: 'favicon', ref: '/favicon.svg' });

const missingAssets = [];
const checkedAssets = [];
for (const { kind, ref } of refs) {
  const abs = resolveAsset(ref);
  if (!abs) continue;
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    missingAssets.push(`${kind} ${ref} → ${abs.replace(ROOT + '\\', '')}`);
  } else {
    checkedAssets.push(`${kind} ${ref} (${statSync(abs).size}B)`);
  }
}
if (missingAssets.length === 0) {
  P(`引用资源 ${checkedAssets.length} 个全部存在`);
} else {
  F(`引用资源缺失 ${missingAssets.length} 个`, missingAssets.join(' | '));
}

// ---- 4. 额外合约项（契约 9.7：任何 JS 报错冒泡到 #dev-error-banner）----
const hasOnerror = /window\.onerror\s*=/.test(html);
const hasRejection = /unhandledrejection/.test(html);
const mentionsBanner = /dev-error-banner/.test(html);
if (hasOnerror && hasRejection && mentionsBanner) P('window.onerror + unhandledrejection 兜底已接 #dev-error-banner');
else W(`#dev-error-banner 兜底不完整 (onerror=${hasOnerror}, unhandledrejection=${hasRejection}, mentionBanner=${mentionsBanner})，JS 报错可能无法截图验证`);

// 关键骨架属性
const appTheme = /id\s*=\s*["']app["'][^>]*data-theme\s*=\s*["'](light|dark)["']/.test(html);
const appReady = /id\s*=\s*["']app["'][^>]*data-ready\s*=\s*["']0["']/.test(html);
if (appTheme && appReady) P('#app 带 data-theme/data-ready 初始属性');
else W(`#app 初始属性不完整 (data-theme=${appTheme}, data-ready="0"=${appReady})`);

// ---- 输出 ----
console.log('='.repeat(72));
console.log('dom-check — 契约第 4 节 DOM / 静态资源检查');
console.log('='.repeat(72));
console.log(`文件: ${HTML_PATH.replace(ROOT + '\\', '')}  (${(htmlBytes / 1024).toFixed(1)} KB)`);
console.log(`必存 ID: ${REQUIRED_IDS.length} 个；页面解析到 id: ${idMap.size} 个`);
console.log('');
for (const m of pass) console.log('  [PASS] ' + m);
for (const m of warn) console.log('  [WARN] ' + m);

if (fail.length) {
  console.log('');
  for (const f of fail) {
    console.log('  [FAIL] ' + f.msg);
    if (Array.isArray(f.detail)) for (const d of f.detail) console.log('         · ' + d);
    else if (f.detail) console.log('         · ' + f.detail);
  }
}

console.log('');
console.log('-'.repeat(72));
if (fail.length === 0) {
  console.log(`RESULT: PASS   (${pass.length} checks pass, ${warn.length} warn)`);
  process.exit(0);
} else {
  console.log(`RESULT: FAIL   (${fail.length} fail, ${warn.length} warn)`);
  console.log('复现: node tests/dom-check.mjs');
  process.exit(1);
}
