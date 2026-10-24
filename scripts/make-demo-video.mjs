// 录制「猫角落」真实全流程演示视频
// 真实 DeepSeek · 真实照片 · 真实分享/投票；CDP screencast 抓帧 → ffmpeg 编码
// 用法: node --experimental-websocket scripts/make-demo-video.mjs [--w=1440] [--h=900] [--out=docs/demo/x.mp4]
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const B = 'http://127.0.0.1:8848';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  })
);
const W = Number(args.w || 1440);
const H = Number(args.h || 900);
const OUT = args.out || 'docs/demo/corner-demo.mp4';
const FRAMES = path.resolve('.scratch/demo-frames');
const PHOTO = path.resolve('app/public/demo/real/' + (args.photo || 'real-litter-corner.jpg')).replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);

fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* ---------------- CDP ---------------- */
const PORT = Number(args.port || 9581);
const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900',
    '--user-data-dir=' + process.env.TEMP + '\\edgedemo-' + Date.now(),
    'about:blank',
  ],
  { stdio: 'ignore' }
);
const getJson = (p) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (r) => {
        const c = [];
        r.on('data', (d) => c.push(d));
        r.on('end', () => {
          try {
            res(JSON.parse(Buffer.concat(c).toString('utf8')));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on('error', rej);
  });
let pg = null;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  try {
    const list = await getJson('/json/list');
    pg = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg) break;
  } catch {}
}
if (!pg) throw new Error('CDP connect failed');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  for (const l of listeners) l(m);
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

/* ---------------- 抓帧 ---------------- */
const frames = [];
let frameSeq = 0;
listeners.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    console.log('   [exception]', (d.exception && (d.exception.description || d.exception.value)) || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('   [console.error]', (m.params.args || []).map((a) => a.value || a.description).join(' ').slice(0, 300));
  }
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

/* ---------------- 工具 ---------------- */
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const waitFor = async (sel, timeout = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await evalJs(`!!document.querySelector(${JSON.stringify(sel)})`)) === true) return true;
    await sleep(200);
  }
  return false;
};
const must = async (label, ok) => {
  if (ok !== true && ok !== 'ok') throw new Error(`[abort] ${label}`);
};
const waitCard = async (sel, label, timeout = 60000) => must(label, await waitFor(sel, timeout));
const clickSel = (sel) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'ok';
  })()`);
const clickText = (text, sel = 'button') =>
  evalJs(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(
      (x) => (x.textContent || '').includes(${JSON.stringify(text)}) && x.offsetParent !== null
    );
    if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'ok';
  })()`);
const rectOf = (sel) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), inView: r.top >= 0 && r.bottom <= innerHeight };
  })()`);
async function realClick(selector) {
  const pos = await rectOf(selector);
  if (!pos) return 'missing';
  await sleep(220); // 等滚动落位后再取坐标
  const fin = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const p = fin || pos;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(150);
  return 'ok';
}
async function pressEnter() {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r',
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(150);
}

/* ---------------- 字幕 / 光标 / 结尾卡 ---------------- */
const injectOverlay = () =>
  evalJs(`(() => {
    if (window.__demoInjected) return 'already';
    window.__demoInjected = true;
    const css = document.createElement('style');
    css.textContent = \`
      #demo-cap{position:fixed;left:50%;top:74px;transform:translateX(-50%);z-index:99999;
        max-width:min(760px,88vw);padding:11px 20px;border-radius:20px;
        background:rgba(28,25,23,.86);color:#FAF6F0;font:15px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        box-shadow:0 10px 34px rgba(40,26,14,.28);opacity:0;transition:opacity .25s ease;
        pointer-events:none;text-align:center}
      #demo-cap[data-show="true"]{opacity:1}
      #demo-cursor{position:fixed;z-index:99998;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
        background:rgba(210,96,58,.3);border:2px solid rgba(210,96,58,.85);pointer-events:none;
        opacity:0;transition:transform .45s cubic-bezier(.22,.61,.36,1),opacity .2s ease}
      #demo-cursor[data-show="true"]{opacity:1}
      #demo-end{position:fixed;inset:0;z-index:99997;display:none;place-items:center;background:#FAF6F0;color:#1C1917}
      #demo-end[data-show="true"]{display:grid}
    \`;
    document.head.append(css);
    const cap = document.createElement('div'); cap.id = 'demo-cap'; document.body.append(cap);
    const cur = document.createElement('div'); cur.id = 'demo-cursor'; cur.dataset.show = 'false'; document.body.append(cur);
    const end = document.createElement('div'); end.id = 'demo-end'; document.body.append(end);
    window.__cap = (t) => { const c = document.querySelector('#demo-cap'); if (!c) return; c.textContent = t; c.dataset.show = t ? 'true' : 'false'; };
    window.__point = (x, y) => { const c = document.querySelector('#demo-cursor'); if (!c) return; c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; c.dataset.show = 'true'; };
    window.__pointHide = () => { const c = document.querySelector('#demo-cursor'); if (c) c.dataset.show = 'false'; };
    return 'injected';
  })()`);
const caption = async (text, hold = 0) => {
  await evalJs(`window.__cap && window.__cap(${JSON.stringify(text)})`);
  if (hold) await sleep(hold);
};
const pointAt = async (sel) => {
  const pos = await rectOf(sel);
  if (!pos) return;
  await evalJs(`window.__point && window.__point(${pos.x}, ${pos.y})`);
  await sleep(420);
  await evalJs(`window.__pointHide && window.__pointHide()`);
};
async function setFilesOnInput(selector, filePath) {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
  if (!q.result?.nodeId) return 'no-input';
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [filePath] });
  return 'ok';
}

/* ---------------- 快慢控制 ---------------- */
const fastRanges = [];
let fastStart = null;
const fastBegin = () => { fastStart = Date.now() / 1000; };
const fastEnd = () => { if (fastStart) { fastRanges.push([fastStart, Date.now() / 1000]); fastStart = null; } };

/* ================= 录制 ================= */
try {
  const list = await (await fetch(B + '/api/sessions')).json();
  for (const s of list.sessions || []) await fetch(`${B}/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {});
  log('cleared', (list.sessions || []).length, 'sessions');
} catch (e) {
  log('clear failed (continue):', e.message);
}

log('open app');
await send('Page.navigate', { url: B + '/' });
await sleep(2500);
await injectOverlay();
await evalJs(`window.__cap('猫角落 corner. · 拍下家里一个角落，先判断值不值得改')`);
await sleep(1800);

log('1) upload real photo');
await caption('1 · 用手机拍一张（不摆拍也行）', 600);
await pointAt('#btn-attach');
await clickSel('#btn-attach');
await sleep(500);
log('   setFile ->', await setFilesOnInput('#file-input', PHOTO));

log('2) quality + L0');
fastBegin();
await caption('2 · 它在看照片：太暗、太糊会先让你重拍', 900);
await waitCard('.card-quality', 'quality card');
await sleep(1100);
await caption('   我看到的是：右侧白墙墙角，三个敞口盆压在地面中间', 1100);
if ((await clickText('继续看方向')) !== 'ok') await must('continue', await clickText('先按这张继续'));
await waitCard('.card-direction', 'directions card');
fastEnd();
await sleep(800);
await caption('3 · 先给方向：值得改吗、下一步量哪里', 1300);
await pointAt('.dir-cta');

if ((await evalJs(`!!document.querySelector('.photo-strip')`)) === true) {
  log('2b) fullscreen viewer');
  await caption('   照片和标注随时能看：点顶部照片条', 800);
  await pointAt('.photo-strip');
  await must('photo strip', await clickSel('.photo-strip'));
  await waitCard('#canvas-panel[data-open="true"]', 'viewer', 8000);
  await sleep(1400);
  await caption('    全屏看标注：编号和下方图例一一对应', 1500);
  await evalJs(`(() => { const b = document.querySelector('#canvas-panel .canvas-close, #btn-canvas-close'); if (b) b.click(); })()`);
  await sleep(800);
}

log('3) measure with real typing');
await caption('4 · 点「先量这个」，只问最关键的一个数', 800);
// 优先选一个「买新品/换位置」方向（复用方向会追问物品外径，交付包容易落在"信息不足"）
const dirClick = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.card-direction button')].filter((b) => /先量/.test(b.textContent || ''));
  if (!btns.length) return 'missing';
  const pick = btns.find((b) => {
    const item = b.closest('.dir-item') || b.closest('.card-direction');
    return item && !/复用/.test(item.textContent || '');
  }) || btns[0];
  pick.scrollIntoView({ block: 'center' });
  pick.click();
  return 'ok';
})()`);
await must('direction cta', dirClick);
await waitCard('.card-measure', 'measure card');
await sleep(900);
await caption('   卡片写清端点、单位、为什么量', 1100);
await pointAt('.m-input');

fastBegin();
// 一卡一项：每轮可能有两张卡，必须把「当前空着的那张」填完并提交；两张都提交后才发请求
for (let step = 0; step < 8; step++) {
  const idx = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.card-measure')];
    for (let i = cards.length - 1; i >= 0; i--) {
      const inp = cards[i].querySelector('.m-input');
      if (inp && !inp.value && !inp.disabled) return i;
    }
    return -1;
  })()`);
  if (idx === -1) {
    // 没有待填卡片：可能已进入下一轮或已完成
    if ((await evalJs(`!!document.getElementById('btn-deliver-inline')`)) === true) break;
    await sleep(1200);
    continue;
  }
  // 视觉上把光标移到输入框（失败不影响流程）
  await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.card-measure')];
    const card = cards[${idx}];
    const inp = card && card.querySelector('.m-input');
    if (!inp) return 'no';
    inp.scrollIntoView({ block: 'center', behavior: 'auto' });
    const r = inp.getBoundingClientRect();
    window.__point && window.__point(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return 'ok';
  })()`);
  await sleep(360);
  await evalJs(`window.__pointHide && window.__pointHide()`);
  await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.card-measure')];
    const card = cards[${idx}];
    if (!card) return 'no-card';
    const inp = card.querySelector('.m-input');
    inp.focus();
    inp.value = '62';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = [...card.querySelectorAll('button')].find((b) => /提交/.test(b.textContent || ''));
    if (btn) btn.click();
    return 'ok';
  })()`);
  await sleep(2000);
  const kicker = await evalJs(`(() => { const c = [...document.querySelectorAll('.card-measure')].pop(); return c ? (c.querySelector('.card-kicker') || {}).textContent : null; })()`);
  const banner = await evalJs(`(document.getElementById('dev-error-banner') || {}).textContent || ''`);
  log(`   step${step + 1}: card#${idx} -> ${kicker} banner=${banner.slice(0, 80)}`);
  if ((await evalJs(`!!document.getElementById('btn-deliver-inline')`)) === true) break;
}
if ((await evalJs(`!!document.getElementById('btn-deliver-inline')`)) !== true) {
  await clickText('全部跳过');
  await sleep(1700);
}
await caption('   点生成可执行方案（演示解锁，不扣款）', 700);
await must('deliver', await clickText('生成可执行方案'));
await waitCard('.card-plan', 'plan card', 70000);
fastEnd();
await sleep(1100);

log('4) deliverable tabs');
await caption('6 · 交付包先看「位置」：这个位置猫会不会用', 900);
await clickSel('.plan-tabs button[data-tab="position"]');
await sleep(1200);
await pointAt('.basis-badge');
await caption('   每条判断都能点开看依据：研究支持 / 专家共识 / 经验值', 1600);
await evalJs(`document.body.click()`);
await sleep(400);
await caption('7 · 再看「尺寸条件」：三态清楚，未知会说要量什么', 800);
await clickSel('.plan-tabs button[data-tab="constraints"]');
await sleep(1200);
await caption('8 · 最后是「清单」：第 1/3/7 天看什么，都写好了', 800);
await clickSel('.plan-tabs button[data-tab="list"]');
await sleep(1300);

log('5) share -> vote -> receipt');
await caption('9 · 一个链接发给同住的人，不用登录就能投票', 800);
await pointAt('.card-handoff button:not(.btn-primary)');
await must('share', await clickText('分享给同住的人'));
await waitCard('.share-sheet', 'share sheet', 25000);
await sleep(1100);
const shareUrl = await evalJs(`(() => { const i = document.querySelector('.share-link'); return i ? i.value : ''; })()`);
await caption('   24 小时有效 · 只在家里网络能打开 · 可随时撤销', 1500);
log('   shareUrl =', shareUrl);
if (shareUrl) {
  await send('Page.navigate', { url: shareUrl });
  await sleep(2600);
  await injectOverlay();
  await caption('10 · 家人打开就是这样：结论、位置、尺寸条件、方案', 1300);
  await evalJs(`window.scrollTo({ top: document.body.scrollHeight * 0.55 })`);
  await sleep(1100);
  await caption('    点一个态度 + 一句话，就投完了', 800);
  await clickText('支持', '.vote-btn');
  await sleep(700);
  await pointAt('.vote-submit');
  await clickText('告诉 TA 我的意见', '.vote-submit');
  await sleep(1500);
  await caption('    已告诉 TA 你的意见', 1100);
  await send('Page.navigate', { url: B + '/' });
  await sleep(3200);
  await injectOverlay();
  await caption('11 · 你切回应用：家人给了意见，支持 1 · 犹豫 0', 1700);
  await evalJs(`(() => { const c = document.querySelector('.card-votes'); if (c) c.scrollIntoView({ block: 'center' }); })()`);
  await sleep(1900);
}

log('6) end card');
await evalJs(`window.__cap && window.__cap('')`);
await sleep(400);
await evalJs(`(() => {
  const end = document.querySelector('#demo-end');
  if (!end) return;
  end.innerHTML = '<div style="text-align:center;max-width:560px;padding:32px">' +
    '<div style="font-size:13px;letter-spacing:.16em;color:#8C857B">猫角落 corner.</div>' +
    '<div style="font:600 34px/1.35 -apple-system,\\'Segoe UI\\',\\'PingFang SC\\',\\'Microsoft YaHei\\',sans-serif;margin:16px 0 14px;letter-spacing:-.01em">先看清这个角落，<br>再决定怎么改。</div>' +
    '<div style="color:#5A544C;font-size:15px;line-height:1.75">位置判断 · 尺寸条件 · 可带走清单 · 家人一起定<br>每条结论都有依据，不知道就写不知道</div>' +
    '<div style="margin-top:20px;font:13px ui-monospace,Consolas,monospace;color:#D2603A">http://192.168.1.5:8848</div>' +
    '</div>';
  end.dataset.show = 'true';
})()`);
await sleep(4200);
await evalJs(`(() => { const e = document.querySelector('#demo-end'); if (e) e.dataset.show = 'false'; })()`);
await sleep(300);

/* ---------------- 停录 + 编码 ---------------- */
await send('Page.stopScreencast');
ws.close();
proc.kill();
await sleep(300);

log(`frames=${frames.length}, encoding...`);
if (frames.length < 10) throw new Error('too few frames');
const lines = [];
let total = 0;
for (let i = 0; i < frames.length; i++) {
  const cur = frames[i];
  const nxt = frames[i + 1];
  const gap = nxt ? nxt.ts - cur.ts : 1 / 30;
  const inFast = fastRanges.some(([a, b]) => cur.ts >= a && cur.ts <= b);
  const dur = inFast ? Math.min(0.12, Math.max(1 / 30, gap)) : Math.min(2.5, Math.max(1 / 30, gap));
  total += dur;
  lines.push(`file '${cur.file.replace(/\\/g, '/')}'`);
  lines.push(`duration ${dur.toFixed(3)}`);
}
lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
const listFile = path.join(FRAMES, 'list.txt');
fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
log(`duration ~ ${total.toFixed(1)}s`);

const ffmpeg = execFileSync('python', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
log(`done: ${OUT} ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);

/* ---------------- self check ---------------- */
try {
  const list = await (await fetch(B + '/api/sessions')).json();
  const s = (list.sessions || [])[0];
  if (s) {
    const d = await (await fetch(`${B}/api/sessions/${s.id}`)).json();
    const keys = Object.keys(d.measurements || {});
    log(`check session=${s.id} asks=${(d.asks || []).length} measureDone=${d.measureDone}`);
    log(`check measurements=${keys.map((k) => `${k}=${d.measurements[k].valueCm}`).join(',') || '(empty)'}`);
    log(`check plan=${d.plan && d.plan.verdict} | ${(d.plan && d.plan.headline) || ''}`);
  }
} catch (e) {
  log('check failed:', e.message);
}
