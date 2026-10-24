# 猫角落 Corner · MVP 工程契约（唯一事实来源）

> 本文件是并行开发的**唯一接口契约**。所有角色（AI 逻辑 / UI 外壳 / 前端逻辑 / 测试）都按本文件写代码，
> 不允许私自改动字段名、ID、导出函数签名。发现契约不合理：先在回复里指出，由 Lead 改契约。

---

## 1. 产品定义（一句话）

**拍下家里一个角落，先免费判断「值不值得改、下一步量哪里」；量完 1—2 个关键尺寸后，拿到可执行的
「标注图 + 放置建议 + 尺寸条件 + 现场确认清单」。**

- 名字：**猫角落 Corner**（品牌字 `corner.`）
- 中文 UI，语气：像一个懂猫、懂尺寸、不夸大的设计师朋友。**短句、具体、不卖货。**
- 反 AI 味：不说「作为一个AI」「很高兴为您服务」「希望对您有帮助」。

### 信任分级（贯穿全站，不可越级）

| 等级 | 名称 | UI 徽章 | 允许说 | 禁止说 |
|---|---|---|---|---|
| L0 | 方向预览（免费） | `L0 · 方向预览` | 有条件继续 / 当前条件不支持 / 信息不足 | 可行、能放下、保证、推荐买 |
| L1 | 可执行建议（解锁后） | `L1 · 可执行` | 在以下尺寸条件下可放 / 建议先量这个 | 保证安全、保证猫会喜欢、代替现场确认 |

- **未知就是未知**：关键尺寸缺失时，结论必须是 `unknown` 或直接阻断，不能给「应该可以」。
- 每张 L1 卡片底部固定一行：`以交付时的尺寸条件为准，落地前请现场确认。`（文案常量 `DISCLAIMER_L1`）
- L0 卡片底部固定：`这是方向预览，不是摆放结论；关键尺寸补齐前不能判断能不能放下。`

---

## 2. 设计方向（学谁 · 取什么 · 我的创新）

| 来源 | 取什么 |
|---|---|
| **千问 / 豆包** | 输入框是中枢；**回复不是一坨文字，而是结构化卡片**；流式输出 + 可折叠「思考过程」；上方一排 suggestion chips；底部多模态上传（拍照/图片）；深浅两套主题 |
| **Meta Muse（Ray-Ban Display 的产品设计）** | **内容优先、chrome 极简**；深色沉浸画布；渐进披露（先给一句话结论，展开才是细节）；单手可操作、大点击区；「辅助而非打扰」——不弹窗、不逼选择 |
| **我的创新 ①** | **空间画布（Spatial Canvas）**：照片不是缩略图，而是可点击的工作台。AI 返回归一化热区，画布上叠加编号框；用户可直接在画布上「点这里我想放」，AI 针对该点位评估。|
| **我的创新 ②** | **测量卡（Measurement Card）**：每轮只问 1—2 项，卡片画出「端点 · 单位 · 为什么量」，一步一卡，可跳过，顶部有进度环。测量本身成为产品体验，而不是表单。|
| **我的创新 ③** | **不买东西模式**：方案里「复用你已有的」和「买新品」同权展示；优先给出 0 元方案。|
| **我的创新 ④** | **猫视角雷达**：藏身感 / 通道 / 日照 / 安静 / 动线 五维 0—5 分，标注「启发式参考，非实测」，把不可量化的部分诚实可视化。|
| **我的创新 ⑤** | **交付包可导出**：一键导出标注图 PNG + 复制现场清单，让结果能带离屏幕。|

---

## 3. 设计令牌（CSS 变量，写在 `base.css` 的 `:root`）

```css
:root{
  /* 纸面暖色（豆包式温暖，但更克制） */
  --paper:#FAF6F0; --paper-2:#FFFFFF; --paper-3:#F3ECE2;
  --ink:#1C1917; --ink-2:#5A544C; --ink-3:#8C857B;
  --line:rgba(28,25,23,.08); --line-2:rgba(28,25,23,.14);
  /* 主色：陶土橙（猫/木/家） */
  --accent:#D2603A; --accent-hi:#E2714A; --accent-soft:#FCEDE5; --accent-ink:#7A2E16;
  /* 语义色 */
  --ok:#4F7A63; --ok-soft:#E7F0EA;      /* 通过/已确认 */
  --warn:#A9762B; --warn-soft:#F8EEDC;  /* 有条件/未知 */
  --bad:#B0453B; --bad-soft:#F9E6E3;    /* 阻断 */
  /* 沉浸画布（Muse 式深色） */
  --canvas-bg:#141110; --canvas-ink:#F5EFE8; --canvas-line:rgba(245,239,232,.12);
  /* 圆角 */
  --r-xs:8px; --r-s:12px; --r-m:16px; --r-l:22px; --r-xl:28px; --r-pill:999px;
  /* 阴影（暖色，不要灰黑） */
  --sh-1:0 1px 2px rgba(60,40,25,.06),0 2px 8px rgba(60,40,25,.05);
  --sh-2:0 2px 6px rgba(60,40,25,.07),0 10px 28px rgba(60,40,25,.08);
  --sh-3:0 8px 40px rgba(60,40,25,.14);
  /* 间距（4 的倍数） */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px;
  /* 动效 */
  --ease:cubic-bezier(.22,.61,.36,1); --spring:cubic-bezier(.34,1.32,.5,1);
  --t-fast:140ms; --t:220ms; --t-slow:420ms;
  /* 字体 */
  --font:"Inter","SF Pro Text",-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --font-num:"SF Mono",ui-monospace,Consolas,monospace;
}
```

**禁止**：紫色渐变、蓝紫科技感、`#7C3AED`、玻璃拟态糊一层、emoji 当图标（用内联 SVG，`stroke-width:1.6`，`currentColor`）。
**必须**：所有可点元素有 `:focus-visible` 环；过渡只用 `transform/opacity/background-color`；尊重 `prefers-reduced-motion`。

### 字号阶梯
`11/12/13/15/17/20/26/34`px。正文 15px，行高 1.6（中文）。数字用 `--font-num` + `font-variant-numeric:tabular-nums`。
标题字重 650，letter-spacing `-0.01em`；小标签 12px、`letter-spacing:.08em`、大写或「· 分隔」。

---

## 4. 页面骨架（`index.html` 的 DOM 与 ID）

桌面 ≥1180px 三栏：`rail(248px) | stage(1fr, max 760 内容居中) | panel(400px)`
平板 900—1179px：`rail 收起为 64px 图标条`，panel 变 340px
手机 <900px：单列；`#canvas-panel` 变成**底部抽屉**（`data-open` 控制），`#rail` 变成顶部抽屉

```html
<body>
<div id="app" data-theme="light" data-ready="0">

  <!-- ===== 左栏 ===== -->
  <aside id="rail" data-collapsed="false">
    <div id="brand"><svg class="logo">…</svg><span class="brand-word">corner<span class="dot">.</span></span></div>
    <button id="btn-new" class="btn btn-primary btn-block">＋ 新的角落</button>
    <div class="rail-label">最近</div>
    <nav id="session-list" aria-label="历史角落"></nav>
    <div id="rail-footer">
      <button id="btn-privacy" class="btn btn-ghost btn-block">隐私与数据</button>
    </div>
  </aside>

  <!-- ===== 中栏：会话流 ===== -->
  <main id="stage">
    <header id="stage-top">
      <div class="stage-title-wrap">
        <h1 id="stage-title">新的角落</h1>
        <div id="stage-meta"><span id="stage-chip" class="chip chip-l0">未开始</span></div>
      </div>
      <button id="btn-help" class="btn btn-icon" aria-label="怎么用">?</button>
      <button id="btn-panel-toggle" class="btn btn-icon only-mobile" aria-label="画布">▤</button>
    </header>

    <div id="feed" role="log" aria-live="polite"></div>

    <!-- 输入中枢 -->
    <footer id="composer">
      <div id="suggest-chips"></div>
      <div id="composer-box">
        <button id="btn-attach" class="btn btn-icon" aria-label="上传照片">📷SVG</button>
        <input id="file-input" type="file" accept="image/*" hidden>
        <textarea id="composer-input" rows="1" placeholder="拍下角落，或说说你想放什么…"></textarea>
        <button id="btn-send" class="btn btn-primary btn-icon" aria-label="发送">↑SVG</button>
      </div>
      <div id="composer-foot">照片只用于这次分析 · 可随时删除</div>
    </footer>
  </main>

  <!-- ===== 右栏：空间画布 ===== -->
  <aside id="canvas-panel" data-open="false" data-empty="true">
    <div class="panel-head">
      <span class="panel-title">空间画布</span>
      <span id="canvas-badge" class="chip">未上传</span>
    </div>
    <div id="panel-empty">
      <div class="empty-art">SVG</div>
      <p>传一张照片，画布上会直接标出「能放 / 有条件 / 别放」的区域。</p>
    </div>
    <div id="canvas-stage" data-visible="false">
      <canvas id="scene-canvas"></canvas>
      <div id="canvas-hint" data-show="false"></div>
      <div id="canvas-toolbar">
        <button id="btn-zoom-out" class="btn btn-icon" aria-label="缩小">−</button>
        <button id="btn-zoom-fit" class="btn btn-icon" aria-label="适应">⤢</button>
        <button id="btn-zoom-in" class="btn btn-icon" aria-label="放大">＋</button>
        <button id="btn-pick-mode" class="btn btn-chip" aria-pressed="false">点选位置</button>
      </div>
    </div>
    <div id="measure-dock" data-visible="false">
      <div class="dock-head"><span>测量进度</span><span id="measure-progress" class="mono">0/0</span></div>
      <div class="progress"><div id="measure-progress-bar" style="width:0%"></div></div>
      <div id="measure-dock-list"></div>
    </div>
    <div id="deliver-dock" data-visible="false">
      <button id="btn-deliver" class="btn btn-primary btn-block">生成可执行方案</button>
      <button id="btn-export" class="btn btn-ghost btn-block" disabled>导出标注图</button>
    </div>
  </aside>

</div>
<div id="toast-host" aria-live="polite"></div>
<div id="modal-host" data-open="false"></div>
<div id="dev-error-banner" hidden></div>   <!-- 任何 window.onerror 写这里，截图即验证 -->
</body>
```

**必须存在的 ID（测试会校验）**：`app, rail, brand, btn-new, session-list, btn-privacy, stage, stage-title, stage-chip, btn-help, btn-panel-toggle, feed, composer, suggest-chips, composer-box, btn-attach, file-input, composer-input, btn-send, composer-foot, canvas-panel, canvas-badge, panel-empty, canvas-stage, scene-canvas, canvas-hint, canvas-toolbar, btn-zoom-out, btn-zoom-fit, btn-zoom-in, btn-pick-mode, measure-dock, measure-progress, measure-progress-bar, measure-dock-list, deliver-dock, btn-deliver, btn-export, toast-host, modal-host, dev-error-banner`

### 会话流里的消息结构（由 `feed.js` 生成，CSS 负责样式）

```
.feed-item.user          用户气泡（可含 .user-thumb 缩略图）
.feed-item.ai            助手消息容器
  .think                 折叠的「思考过程」（<details>，summary 文案：展开思考）
    .think-body
  .ai-body               正文区（流式写入 .stream 文本）
  .cards                 卡片槽（每张卡片一个 .card）
.card                    通用卡片：.card-head .card-body .card-foot
  .card[data-type=directions|measure|quality|plan|verdict|blocked|radar]
.card-direction          L0 方向卡
.card-measure            测量卡（.measure-item × 1—2）
.card-quality            质检卡
.card-plan               L1 交付包（内部 tabs：.plan-tabs > button[data-tab=annotate|items|constraints|checklist]）
.badge.l0 / .badge.l1    分级徽章
.verdict.continue / .not_supported / .insufficient
```
`.card` 入场：`opacity 0→1` + `translateY(8px→0)`，`--t-slow`，`animation-delay` 逐张 +40ms。

---

## 5. 客户端模块契约（`app/public/js/`，纯 ES module，无构建、无依赖）

```
js/api.js         服务端调用（唯一 fetch 出口）
js/state.js       全局 store（发布订阅）
js/image-utils.js 本地图片压缩 + 质检指标
js/feed.js        会话流渲染（流式）
js/cards.js       各类卡片渲染
js/canvas.js      照片画布（绘制热区 / 点选 / 导出）
js/flow.js        业务流程编排（质检→L0→测量→L1）
js/app.js         启动 + DOM 事件绑定（唯一入口，<script type="module" src="/js/app.js">）
```

### 5.1 `api.js`
```js
export async function health()                                  // {ok,model,hasKey}
export async function createSession()                           // Session
export async function listSessions()                            // [{id,title,createdAt,updatedAt,stage,thumb}]
export async function getSession(id)                            // Session
export async function deleteSession(id)                         // {ok}
export async function uploadImage(sessionId,{dataUrl,width,height,metrics}) // {session}
// SSE 流：handlers = {onStage(label), onReasoning(delta), onFinal(payload), onError(msg)}
export async function streamStage({sessionId,stage,payload},handlers) // stage: quality|l0|measure|plan|ask
export function imageUrl(session)                               // 画布图片来源
```

### 5.2 `state.js`
```js
export const state = { sessions:[], session:null, busy:false, stage:'empty', pickMode:false, panelOpen:false, theme:'light' }
export function setState(patch)          // 浅合并 + notify
export function subscribe(fn)            // 返回 unsubscribe
export function getUserGoal()/setUserGoal(v)  // 输入框草稿
```

### 5.3 `image-utils.js`
```js
// 读取文件 → 长边压到 1280 → jpeg 0.86 → 返回本地质检指标
export async function prepareImage(file) // {dataUrl,width,height,metrics:{brightness,contrast,sharpness,width,height,bytes}}
export async function prepareFromUrl(url)
export function localIssues(metrics)     // [{code,label,hint,severity}]  客户端先拦：过暗/模糊/太小
```
指标定义：`brightness` 0—255 平均亮度；`contrast` 亮度标准差；`sharpness` 灰度拉普拉斯方差（越高越清晰）；
阈值：`brightness<45` → `dark`(block)；`sharpness<35` → `blurry`(warn)；`width<640` → `small`(warn)。

### 5.4 `feed.js`
```js
export function clearFeed()
export function addWelcome()                                     // 欢迎语 + 三张引导卡（不是按钮，是示例）
export function addUser(text,{thumbUrl}={})
export function addAI()                                          // 返回句柄
// 句柄：{el, setStage(label), setReasoning(delta), appendText(delta), setText(t), addCard(el), done()}
export function addCardOnly(el)                                   // 无气泡，只插卡片
export function scrollToEnd()
```

### 5.5 `cards.js` —— 所有卡片都是 `(data, ctx) => HTMLElement`
```js
export function qualityCard(q, ctx)        // ctx.onRetake / ctx.onSkip
export function directionsCard(l0, ctx)    // ctx.onChoose(direction) / ctx.onMeasureNow() / ctx.onPickRegion(regionId)
export function measureCard(ask, ctx)      // ask.questions[1..2]；ctx.onSubmit(answers) / ctx.onSkipAll()
export function planCard(plan, ctx)        // ctx.onExport / ctx.onTab / ctx.onToggleCheck
export function verdictCard(v)             // 一句话结论的轻卡（Muse 式渐进披露）
export function blockedCard(items)
```

### 5.6 `canvas.js`
```js
export function initCanvas()
export function setImage(url, {width,height})                    // 绘制底图，fit 到容器
export function renderOverlays({regions=[],annotations=[],activeId=null})
export function setPickMode(on)                                  // true 时鼠标变十字，点击回调
export function onPick(fn)                                       // fn({x,y,nx,ny})  nx,ny 为 0—1 归一化
export function zoom(dir)   // 'in'|'out'|'fit'
export function exportPNG() // 返回 dataURL（含标注与图例，白底）
export function clear()
```
坐标一律用**归一化 0—1 的 `bbox:[x,y,w,h]`**（相对原照片），渲染时乘画布尺寸。

### 5.7 `flow.js` —— 流程编排（改流程只改这里）
```js
export async function startSession()
export async function handleImage(file)     // 压缩 → 本地拦 → 上传 → 质检 → L0
export async function runQuality()
export async function runL0()
export async function runMeasure(answers)   // 没有下一轮就 promptPlan()
export async function runPlan()
export async function handlePick({nx,ny})   // 点选画布 → 追问式评估
export async function handleUserText(text)  // 输入框文本：/重拍、/重来、其它交给 ask
export async function replaySession(session) // 历史会话回放，见 5.8
```

### 5.8 `replaySession(session)` —— 历史会话必须能"重放"成一屏

**这是硬要求**：点侧栏历史项（或启动时恢复上次会话）时，中栏必须重建出完整会话，
不能只显示一行「打开了…」；右栏画布与测量进度也必须同步。

按顺序重建（只渲染会话里已经存在的阶段）：

| session 里有什么 | 中栏渲染 | 右栏 |
|---|---|---|
| `image` | 一条用户消息（带图片缩略图）+ 系统提示「继续上次的角落」 | `setImage()`，`#canvas-panel[data-empty="false"]` |
| `quality` | `qualityCard(quality)` | — |
| `l0` | `directionsCard(l0)`；`chosenDirectionId` 标记为已选且其余方向折叠 | `renderOverlays({regions: l0.regions})` |
| `asks[]` 里有 `answers` 的轮次 | 一条紧凑的「已量：A 62cm / B 72cm」记录行（不要重画整张测量卡） | 进度环与 `#measure-dock-list` 同步 |
| 最后一个 `ask` 的 `questions` 还没答案 | `measureCard(最后一轮 questions)` | — |
| `plan` | `planCard(plan)` + 「导出标注图」可用 | `renderOverlays({regions: l0.regions, annotations: plan.annotations})`，`#btn-export` 启用 |

- 回放**不发任何模型请求**（纯本地重建）。
- 回放后滚动到底部。
- 会话里什么都没有（stage=empty）→ 直接显示欢迎态（`clearFeed()+addWelcome()`）。


---

## 6. 服务端 API 契约（`app/server/index.mjs`，零依赖 `node:http`）

Base：`http://127.0.0.1:8848`。JSON 请求/响应；SSE 用于分析流。
错误统一：`{error:{code,message}}` + 非 2xx。所有时间 ISO 字符串。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok:true,model:"deepseek-flash",hasKey:true}` |
| GET | `/api/sessions` | — | `{sessions:[SessionSummary]}` |
| POST | `/api/sessions` | `{}` | `Session` |
| GET | `/api/sessions/:id` | — | `Session` |
| DELETE | `/api/sessions/:id` | — | `{ok:true}` |
| POST | `/api/sessions/:id/image` | `{dataUrl,width,height,metrics}` | `{session}` |
| GET | `/api/image/:imageId` | — | 图片字节（id 不可猜） |
| POST | `/api/analyze` | `{sessionId,stage,payload}` | SSE，见 6.3 |
| POST | `/api/sessions/:id/answer` | `{key,valueCm,skipped}` | `{session}` 仅落库，不走模型 |

### 6.1 `Session` 完整结构（服务端唯一权威；前端只读）
```jsonc
{
  "id":"s_ab12cd","createdAt":"ISO","updatedAt":"ISO","title":"客厅 · 电视柜右角",
  "stage":"empty|uploaded|quality|l0|measuring|ready|delivered",
  "image":{"imageId":"i_x","url":"/api/image/i_x","width":1280,"height":960} | null,
  "metrics":{"brightness":120,"contrast":48,"sharpness":210} | null,
  "profile":{"goal":"","budget":null,"keep":[],"cats":1},
  "quality":Quality | null,
  "l0":L0 | null,
  "asks":[Ask],                 // 每轮测量：{round,questions,answers,at}
  "measurements":{"corridorWidth":{"valueMm":600,"valueCm":60,"source":"user","at":"ISO","skipped":false}},
  "plan":Plan | null,
  "picks":[{"nx":0.4,"ny":0.6,"at":"ISO","reply":"…"}],
  "chosenDirectionId":"d1" | null,   // 用户在 L0 卡片里选的方向，后续 measure/plan 以它为准
  "measureDone":true,               // measure 阶段返回 questions:[] 时由服务端置 true
  "revisions":0
}
```

**`/api/analyze` 各阶段的 `payload`**：
- `quality`：`{metrics, profile?}`
- `l0`：`{profile?, directionId?}` — `profile.goal` 是用户输入框里说的"想放什么"
- `measure`：`{directionId?, answers:{[key]:{valueCm:number}|{skipped:true}}}`
- `plan`：`{directionId?, profile?}`

### 6.2 各阶段输出 schema（模型必须返回这个结构，字段缺失由 `prompts.normalize` 补默认）

**Quality**（`stage:"quality"`）
```jsonc
{"status":"pass|retake","score":0,"scene":{"indoor":true,"cornerVisible":true,"floorVisible":true,"obstruction":"none|some|heavy","note":"一句话"},
 "issues":[{"code":"dark|blurry|occluded|no_floor|not_indoor|too_close|other","label":"过暗","impact":"high|mid|low","hint":"怎么重拍","severity":"block|warn"}],
 "photoTip":"一句补拍建议"}
```

**L0**（`stage:"l0"`）—— 免费段，只能给方向
```jsonc
{"scene":{"summary":"电视柜右侧墙角，木地板，采光中等","roomGuess":"客厅","light":"medium|bright|dim","floor":"wood|tile|other"},
 "verdict":"continue|not_supported|insufficient","verdictReason":"一句话",
 "regions":[{"id":"r1","label":"猫窝候选","bbox":[0.32,0.42,0.26,0.22],"verdict":"ok|conditional|blocked|unknown","why":"…","risk":"…"}],
 "directions":[{"id":"d1","title":"靠右墙角放猫窝","pitch":"…","regionId":"r1","kit":"new|reuse|mix",
   "itemsPreview":[{"title":"半包式猫窝","type":"new"}],
   "firstMeasurements":[{"key":"cornerWidthA","label":"墙角靠右的长度","why":"决定猫窝最大宽度"}],
   "risk":"…","confidence":"high|medium|low"}],
 "missing":[{"key":"cornerWidthA","label":"墙角靠右的长度","why":"…"}],
 "nextAction":"先量墙角靠右的长度，再决定 60 还是 70 宽",
 "heatmapNote":"…","disclaimer":L0_DISCLAIMER}
```
约束：`directions` 1—3 个；`regions` 0—5 个；`bbox` 必须是 0—1 浮点，且框在照片内。

**Measure**（`stage:"measure"`）—— 每轮只 1—2 项
```jsonc
{"round":1,"questions":[{"key":"corridorWidth","label":"通道净宽","endpoints":"最近的家具到对面墙","unit":"cm","why":"低于 60cm 猫会绕着走","hint":"量最窄处","example":"约 62","optional":false}],
 "remainingKeys":["freeDepth"],"askNote":"这轮只要这两个数就够了"}
```
`key` 必须来自第 7 节的测量字典。`remainingKeys` 用于进度环分母。

**Plan**（`stage:"plan"`）—— L1 交付包
```jsonc
{"verdict":"ok|conditional|not_supported|insufficient","headline":"可以放，但要选进深 ≤ 45cm 的窝",
 "budget":{"cap":300,"est":259,"status":"within|over"},
 "annotations":[{"id":"1","label":"猫窝","bbox":[0.32,0.42,0.26,0.22],"note":"贴右墙，留 60cm 通道"}],
 "items":[{"id":"i1","type":"new|reuse","title":"半包式猫窝 45×40","sku":"SKU-021","dimsCm":{"w":45,"d":40,"h":38},"price":129,
   "why":"进深 40cm，通道剩 62cm","fit":"ok|blocked","fitNote":"","confidence":"high|medium|low","tags":["可拆洗"]}],
 "constraints":[{"key":"corridorWidth","label":"通道净宽","op":">=","valueCm":60,"actualCm":62,"status":"pass|fail|unknown","note":""}],
 "checklist":[{"id":"c1","text":"把电视柜右侧的绿植挪到窗边","critical":true}],
 "blocked":[{"what":"70cm 以上猫爬架","reason":"墙高与固定方式未知"}],
 "radar":[{"key":"hide","label":"藏身感","score":4,"note":"三面有围挡"}],
 "aftercare":{"day7":"猫不进窝的话，把窝垫换成旧衣服","day14":"…"},
 "disclaimer":L1_DISCLAIMER}
```

### 6.3 SSE 协议（`POST /api/analyze`）
`Content-Type: text/event-stream`，每条消息一行 `data: `，JSON，`\n\n` 分隔：
```jsonc
{"type":"stage","label":"正在读照片…"}
{"type":"reasoning","delta":"…"}         // 可多条，前端写进 .think-body
{"type":"final","payload":{...},"session":Session,"meta":{"ms":1234,"usage":{},"model":"deepseek-flash"}}
                                          // 恰好一条；payload 结构见 6.2；
                                          // session = 服务端已更新完的完整会话，前端直接替换本地 state.session；
                                          // meta 仅供调试
{"type":"error","message":"…"}           // 结束
```
服务端在 `final` 前可发 `{"type":"heartbeat"}`。服务端负责：调模型 → `JSON.parse` → `prompts.normalize(stage,raw,session)` → `rules.apply(stage,...)` → 落库 → 发 `final`。

---

## 7. 测量字典（`rules.mjs` 导出 `MEASUREMENT_SPECS`，key 固定）

| key | label | endpoints（端点说明） | 默认阈值/用途 |
|---|---|---|---|
| `corridorWidth` | 通道净宽 | 最近的家具外沿 → 对面墙/家具最窄处 | <60cm 猫会绕行 |
| `cornerWidthA` | 墙角 A 边长 | 沿主墙，墙面可用的长度 | 决定最大宽度 |
| `cornerWidthB` | 墙角 B 边长 | 沿侧墙，墙面可用的长度 | 决定最大深度 |
| `freeDepth` | 可用进深 | 墙根 → 最近的障碍物/通道边 | 决定猫窝进深上限 |
| `obstructionH` | 遮挡物高度 | 该区域内最高的家具/物品到地面 | 影响高低位方案 |
| `ceilingFree` | 上方净空 | 地面 → 正上方最近物体 | 猫爬架高度上限 |
| `outletDist` | 到最近插座 | 计划落点位 → 最近插座 | 饮水机/电动砂盆 |
| `doorSwing` | 门开合范围 | 门轴 → 门完全打开的外沿 | 避免放门口 |
| `windowDist` | 到窗距离 | 落点位 → 最近窗台水平距离 | 日照/观景位 |

单位：**入库一律毫米（valueMm）**，卡片一律显示厘米（`valueCm`，1 位小数）。模型/用户给的 cm 由服务端 ×10 取整。**禁止像素反推厘米**。

---

## 8. 文案规范

- 标题：≤12 字，动词优先（「先量通道，再定宽度」）
- 卡片正文：每段 ≤2 行；解释「为什么」时给具体数字或实物参照（「比 A4 纸宽出 10cm」）
- 阻断项：必须写「为什么不行」+「什么条件下才可能行」
- 禁用词：赋能、打造、极致、一站式、完美、绝对、保证、100%
- 数字：`60cm` 不写 `60 厘米`；范围用 `60—70cm`
- 空状态：给一句能立刻照做的话，不给「暂无数据」

---

## 9. 工程约定

1. **零依赖**：不用 npm 包、不用框架、不用打包器。前端 `<script type="module">`，服务端只用 `node:*`。
2. Node ≥ 20；`node app/server/index.mjs` 即启动；端口 `8848`（可用 `PORT` 覆盖）。
3. 所有文件 UTF-8 无 BOM；缩进 2 空格；`;` 可有可无但文件内统一。
4. 不做登录、不接支付：付费段用「演示解锁」按钮（`#btn-deliver` → 弹一个 0.1 秒的模拟校验 → 解锁 L1）。
5. 隐私：图片存 `app/data/uploads/<imageId>.jpg`，`DELETE /api/sessions/:id` 同时删文件；界面写明「照片只用于这次分析」。
6. API Key 只存在于 `app/.env`（`DEEPSEEK_API_KEY=...`），**不进前端、不进日志**。
7. 前端任何 JS 报错必须冒泡到 `#dev-error-banner`（`window.onerror` + `unhandledrejection`），便于截图验收。

## 10. MVP 完成定义（DoD）

- [ ] `node app/server/index.mjs` 启动后，浏览器打开 `http://127.0.0.1:8848` 能走完：上传 → 质检 → L0 方向 → 测量 2 轮 → 解锁 → L1 交付包 → 导出 PNG
- [ ] 画布能看到 AI 返回的热区，可点选位置并得到追问
- [ ] 全部请求走真实 DeepSeek（`deepseek-flash`，图文多模态），无 mock
- [ ] 刷新页面后历史会话仍在（服务端落盘）
- [ ] 无 JS 报错（`#dev-error-banner` 为空）；1440×900 与 390×844 截图均无破版
- [ ] `docs/QA-REPORT.md` 记录实测截图与遗留问题
