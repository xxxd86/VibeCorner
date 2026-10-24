// 录「家庭社交闭环」演示视频：分享 → 家人回应+拍照 → 回执 → 家人照片变对比图
// 真服务端、真接口；会话/方案用 API 预置（视频不等待模型），其余全部真实交互
// 用法: node --experimental-websocket scripts/make-social-demo-video.mjs [--w=390] [--h=844] [--out=docs/demo/corner-social-demo-phone.mp4]
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const B = 'http://127.0.0.1:8848';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const W = Number(args.w || 390);
const H = Number(args.h || 844);
const OUT = args.out || 'docs/demo/corner-social-demo-phone.mp4';
const FRAMES = path.resolve('.scratch/social-frames');
const PHOTO = path.resolve('app/public/demo/real/real-litter-corner.jpg').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);

fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* ---------------- API 预置：会话 + 方案 + 分享 ---------------- */
const json = async (r) => { try { return await r.json(); } catch { return {}; } };
const post = async (p, b) => json(await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }));
const get = async (p) => json(await fetch(B + p));
async function analyze(sessionId, stage, payload) {
  const res = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, stage, payload: payload || {} }) });
  if (!res.ok) throw new Error('analyze ' + res.status);
  const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '', final = null;
  for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 2); if (!raw.startsWith('data:')) continue; const j = JSON.parse(raw.slice(5).trim()); if (j.type === 'final') final = j; } }
  return final;
}

log('准备会话 / 方案 / 分享…');
for (const old of (await get('/api/sessions')).sessions || []) await fetch(B + `/api/sessions/${old.id}`, { method: 'DELETE' }).catch(() => {});
const s = await post('/api/sessions', {});
const b64 = fs.readFileSync(PHOTO).toString('base64');
await post(`/api/sessions/${s.id}/image`, { dataUrl: 'data:image/jpeg;base64,' + b64, width: 1280, height: 720, metrics: { brightness: 150, contrast: 45, sharpness: 260 } });
await analyze(s.id, 'quality', { profile: {} });
const l0 = await analyze(s.id, 'l0', { profile: {} });
const dirId = l0.payload.recommend?.directionId || l0.payload.directions[0].id;
const d = l0.payload.directions.find((x) => x.id === dirId) || l0.payload.directions[0];
const answers = {};
for (const m of d.firstMeasurements || []) answers[m.key] = { valueCm: 62 };
await analyze(s.id, 'measure', { directionId: dirId, answers, profile: {} });
let guard = 0;
for (;;) { const sess = await get(`/api/sessions/${s.id}`); if (sess.measureDone || guard++ > 2) break;
  await analyze(s.id, 'measure', { directionId: dirId, answers: { cornerWidthA: { valueCm: 62 }, cornerWidthB: { valueCm: 62 }, corridorWidth: { valueCm: 62 }, freeDepth: { valueCm: 62 } }, profile: {} }); }
const plan = await analyze(s.id, 'plan', { directionId: dirId, profile: {} });
const sh = await post(`/api/sessions/${s.id}/share`, { hasPhoto: true, photoDataUrl: 'data:image/jpeg;base64,' + b64 });
const token = sh.share.token;
const shareUrl = `${B}/s/${token}`;
log('会话', s.id, '| 方案', plan.payload.verdict, '|', shareUrl);

/* ---------------- CDP ---------------- */
const PORT = 9588;
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${PORT}`, '--window-size=390,844', '--user-data-dir=' + process.env.TEMP + '\\edgesocial-' + Date.now(), 'about:blank'], { stdio: 'ignore' });
const getJson = (p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { rej(e); } }); }).on('error', rej); });
let pg = null;
for (let i = 0; i < 80; i++) { await sleep(250); try { pg = (await getJson('/json/list')).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (pg) break; } catch {} }
if (!pg) throw new Error('CDP connect failed');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const listeners = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } for (const l of listeners) l(m); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const frames = [];
let frameSeq = 0;
listeners.push((m) => {
  if (m.method !== 'Page.screencastFrame') return;
  const { data, sessionId: sid, metadata } = m.params;
  frameSeq += 1;
  const file = path.join(FRAMES, `f${String(frameSeq).padStart(5, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, ts: metadata.timestamp || Date.now() / 1000 });
  send('Page.screencastFrameAck', { sessionId: sid });
});

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
await send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const waitFor = async (sel, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) === true) return true; await sleep(200); } return false; };
const must = (label, ok) => { if (ok !== true && ok !== 'ok') throw new Error('[abort] ' + label); };
const clickText = (text, sel = 'button') => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => (x.textContent || '').includes(${JSON.stringify(text)}) && x.offsetParent !== null); if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok'; })()`);
const clickAny = async (texts, sel = 'button') => { for (const t of texts) { if ((await clickText(t, sel)) === 'ok') return 'ok'; } return 'missing'; };
const scrollTo = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
async function setFiles(selector, filePath) { const doc = await send('DOM.getDocument', { depth: -1 }); const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector }); if (!q.result?.nodeId) return 'no-input'; await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [filePath] }); return 'ok'; }

const injectOverlay = () => ev(`(() => {
  if (window.__socialInjected) return 'already';
  window.__socialInjected = true;
  const css = document.createElement('style');
  css.textContent = \`
    #social-cap{position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:99999;max-width:88vw;
      padding:10px 18px;border-radius:18px;background:rgba(28,25,23,.86);color:#FAF6F0;
      font:15px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;text-align:center;
      box-shadow:0 10px 34px rgba(40,26,14,.28);opacity:0;transition:opacity .25s ease;pointer-events:none}
    #social-cap[data-show="true"]{opacity:1}
    #social-end{position:fixed;inset:0;z-index:99997;display:none;place-items:center;background:#FAF6F0;color:#1C1917}
    #social-end[data-show="true"]{display:grid}
  \`;
  document.head.append(css);
  const cap = document.createElement('div'); cap.id = 'social-cap'; document.body.append(cap);
  const end = document.createElement('div'); end.id = 'social-end'; document.body.append(end);
  window.__cap = (t) => { const c = document.querySelector('#social-cap'); if (!c) return; c.textContent = t || ''; c.dataset.show = t ? 'true' : 'false'; };
  return 'injected';
})()`);
const caption = async (text, hold = 0) => { await ev(`window.__cap && window.__cap(${JSON.stringify(text)})`); if (hold) await sleep(hold); };

/* ================= 录 ================= */
log('1) 应用：已交付的角落');
await send('Page.navigate', { url: B + '/' });
await sleep(3000);
await injectOverlay();
await caption('一个角落已经有结论了', 1400);
must('交付卡', await waitFor('.card-handoff', 15000));
await scrollTo('.card-handoff');
await caption('把它交给同住的人一起定', 1400);

log('2) 分享面板');
must('分享按钮', await clickAny(['分享给同住的人', '再次分享给大家', '再次分享']));
must('分享面板', await waitFor('.share-sheet', 12000));
await sleep(900);
await caption('链接 24 小时有效 · 只在家里网络能打开', 1900);
// 用应用刚刚生成的那条链接（重新分享时会换新 token）
let liveUrl = '';
for (let i = 0; i < 20; i++) {
  liveUrl = await ev(`(() => { const n = document.querySelector('.share-link'); return n ? (n.value || '') : ''; })()`);
  if (liveUrl && /\/s\/sh_/.test(liveUrl)) break;
  await sleep(300);
}
log('   分享链接 =', liveUrl);
must('拿到分享链接', liveUrl && /\/s\/sh_/.test(liveUrl) ? 'ok' : 'missing');

log('3) 家人打开分享页');
await send('Page.navigate', { url: liveUrl });
await sleep(2500);
await injectOverlay();
await caption('家人打开就是这样：结论、位置判断、尺寸条件', 1600);
await ev(`window.scrollTo({ top: 0 })`);

log('4) 家人回应 + 拍现场照');
must('回应区', await waitFor('.respond-block', 12000));
await scrollTo('.respond-block');
await sleep(500);
await caption('不用登录，能直接告诉我「他能做什么」', 1500);
must('点现场照', await clickText('我拍了现场照', '.respond-btn'));
await sleep(700);
await caption('拍一张现场照，勾选后才会发给我', 900);
await setFiles('input.respond-file, .respond-file input[type=file]', PHOTO);
await ev(`(() => { const c = document.querySelector('.respond-consent input'); if (c && !c.checked) c.click(); const n = document.querySelector('.respond-note'); if (n) { n.focus(); n.value = '我拍了现在的位置'; n.dispatchEvent(new Event('input', { bubbles: true })); } return 'ok'; })()`);
await sleep(900);
must('发送', await clickText('发送', '.respond-submit'));
must('已告诉 TA', await waitFor('.respond-done', 12000));
await caption('发出去了', 1200);

log('5) 回到应用：回执');
await send('Page.navigate', { url: B + '/' });
await sleep(3400);
await injectOverlay();
await caption('切回应用：收到家人回应', 800);
await sleep(2600); // 让 toast / 未读角标出现并停留
await ev(`(() => { const c=document.querySelector('#feed .card-votes'); if (c) c.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
await caption('谁做了什么、说了什么、拍了什么，一眼看完', 2200);

log('6) 设为改造后照片 → 对比图');
must('设为改造后', await clickText('设为改造后照片', '.respond-use'));
must('对比卡', await waitFor('.card-compare', 12000));
await sleep(600);
await scrollTo('.card-compare');
await caption('家人拍的那张，直接变成「改造后」', 2400);

log('7) 结尾卡');
await ev(`window.__cap && window.__cap('')`);
await sleep(600);
await ev(`(() => {
  const end = document.querySelector('#social-end');
  if (!end) return;
  end.innerHTML = '<div style="text-align:center;max-width:520px;padding:28px">' +
    '<div style="font-size:12px;letter-spacing:.16em;color:#8C857B">猫角落 corner.</div>' +
    '<div style="font:600 30px/1.35 -apple-system,\\'Segoe UI\\',\\'PingFang SC\\',\\'Microsoft YaHei\\',sans-serif;margin:14px 0 12px">一家人，<br>一个角落。</div>' +
    '<div style="color:#5A544C;font-size:14px;line-height:1.8">分享 → 家人回应 → 带回现场照<br>不用登录、不用装 App、24 小时自动失效</div>' +
    '<div style="margin-top:18px;font:12px ui-monospace,Consolas,monospace;color:#D2603A">http://192.168.1.5:8848</div>' +
    '</div>';
  end.dataset.show = 'true';
})()`);
await sleep(1200);
// 结尾卡单独截一张静帧，编码时接在最后（避免 screencast 不重绘导致结尾丢失）
const endShot = path.join(FRAMES, 'end.jpg');
const cap = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
fs.writeFileSync(endShot, Buffer.from(cap.result.data, 'base64'));
log('   结尾卡静帧已捕获');

await send('Page.stopScreencast');
ws.close(); proc.kill();
await sleep(300);

/* ---------------- 编码 ---------------- */
log(`frames=${frames.length}, encoding...`);
if (frames.length < 10) throw new Error('too few frames');
// 去掉导航过程中的空白帧（体积很小的白屏），避免成片出现闪白
const kept = frames.filter((f, i) => {
  try {
    const size = fs.statSync(f.file).size;
    return size >= 12000 || i === 0;
  } catch {
    return true;
  }
});
log(`  过滤空白帧 ${frames.length} → ${kept.length}`);
const lines = [];
let total = 0;
for (let i = 0; i < kept.length; i++) {
  const cur = kept[i]; const nxt = kept[i + 1];
  const gap = nxt ? nxt.ts - cur.ts : 1 / 30;
  const dur = Math.min(2.5, Math.max(1 / 30, gap));
  total += dur;
  lines.push(`file '${cur.file.replace(/\\/g, '/')}'`);
  lines.push(`duration ${dur.toFixed(3)}`);
}
lines.push(`file '${kept[kept.length - 1].file.replace(/\\/g, '/')}'`);
// 结尾卡静帧：保持 3 秒
const endFile = path.join(FRAMES, 'end.jpg');
if (fs.existsSync(endFile)) {
  lines.push(`file '${endFile.replace(/\\/g, '/')}'`);
  lines.push('duration 3.000');
  total += 3;
}
lines.push(`file '${endFile.replace(/\\/g, '/')}'`);
fs.writeFileSync(path.join(FRAMES, 'list.txt'), lines.join('\n'), 'utf8');
log(`duration ~ ${total.toFixed(1)}s`);
const ffmpeg = execFileSync('python', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(FRAMES, 'list.txt'), '-vf', `scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
log(`done: ${OUT} ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
await fetch(B + `/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {});
