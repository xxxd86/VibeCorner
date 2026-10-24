# 猫角落 Corner · UI class 对照表

> 本文件由 UI 外壳（ui-shell）维护，供 `js/feed.js`、`js/cards.js`、`js/app.js` 对照使用。
> 契约（`docs/CONTRACT.md`）第 4 节规定的 ID 与 class **全部保留**；本文补充契约未覆盖、
> 由 UI 外壳定义的细粒度 class。改名前先确认没有别的模块依赖。

## 0. 文件清单

| 文件 | 作用 |
|---|---|
| `app/public/index.html` | 页面骨架（契约 §4 全部 ID + 静态欢迎态 + 内联错误兜底脚本） |
| `app/public/styles/base.css` | reset / 设计令牌 / 排版 / 滚动条 / 焦点环 / 降级动效 |
| `app/public/styles/components.css` | 按钮、芯片、徽章、进度、骨架屏、对话、卡片套件、dock、toast、modal |
| `app/public/styles/screens.css` | 三栏栅格、左栏、中栏、欢迎态、输入中枢、1180/900 断点、手机抽屉、入场动画 |
| `app/public/favicon.svg` | 纸面底 + 墨色取景角 + 陶土橙圆点 |

## 1. 设计令牌与字体（base.css `:root`）

契约 §3 的所有变量原值保留。额外约定：

- `--font` 在 `"Segoe UI"` 之后、`"PingFang SC"` 之前补入了 `"Noto Sans SC"`，其余顺序不变（改善 Windows 中文渲染）。
- 新增 `--font-brand`（衬线：Noto Serif SC → Songti SC → STSong → SimSun → Georgia），**只用于**品牌字 `corner.`、欢迎态大标题、modal 标题。
- 新增 `--ink-4`、`--canvas-bg-2`、`--canvas-ink-2/3`、`--canvas-accent`、`--rail-w`、`--panel-w`、`--stage-max`、`--rail-bar`、`--panel-peek`、`--focus-ring`、`--focus-ring-dark`、`--safe-t`、`--safe-b`。
- 字号阶梯：11 / 12 / 13 / 15 / 17 / 20 / 26 / 34；正文 15px、行高 1.6；标题字重 650、`letter-spacing:-.01em`。
- 数字一律 `.mono` 或 `.num`（`--font-num` + `tabular-nums`）。

## 2. 通用工具 class（base.css）

| class | 用途 |
|---|---|
| `.mono` | 等宽数字/编号（进度、尺寸、日期） |
| `.num` | 同上，无额外字距 |
| `.label` | 12px + `letter-spacing:.08em` + `--ink-3` 的小标签 |
| `.kicker` | 11px 全大写小标签（保留，卡片内用 `.card-kicker`） |
| `.sr-only` | 无障碍隐藏 |

## 3. 图标（components.css §1）

| class | 用途 |
|---|---|
| `.i` | 16px 内联 SVG，`stroke-width:1.6`、`currentColor` |
| `.i-sm` / `.i-lg` | 14px / 18px 变体 |
| `.logo` | 左栏品牌取景角图标（`stroke:currentColor`） |
| `.logo-dot` | 品牌图标中央的陶土橙圆点 |

**约定**：所有图标用内联 SVG，不用 emoji；`fill:none; stroke:currentColor`，由父级颜色控制。

## 4. 按钮（components.css §2）

| class | 用途 |
|---|---|
| `.btn` | 基础：40px 高、13px/600、hover 上移 1px、按下 `scale(.98)` |
| `.btn-primary` | 陶土橙主按钮 |
| `.btn-ghost` | 纸面次要按钮（细边框） |
| `.btn-icon` | 36×36 图标按钮；与 `.btn-primary` 组合时是圆形发送键 |
| `.btn-chip` | 30px 药丸形 chip 按钮（工具栏「点选位置」） |
| `.btn-block` | 撑满一行 |
| `.only-mobile` | 桌面隐藏（`#btn-panel-toggle` 使用） |

深色面板内 `#canvas-panel .btn-*` 有自动反色规则，直接使用同名 class 即可。
`#deliver-dock` 支持 `data-state="done"`：此时 `#btn-deliver` 转 ghost（可写「重新生成方案」），`#btn-export` 变 primary。

## 5. 芯片 / 徽章 / 建议（components.css §3）

| class | 用途 |
|---|---|
| `.chip` | 药丸形状态芯片，默认带 5px 圆点 |
| `.chip-l0` / `.chip-l1` | L0 方向预览 / L1 可执行 配色 |
| `.chip-warn` / `.chip-bad` | 语义配色 |
| `.chip.no-dot` | 去掉前置圆点 |
| `.badge` | 卡片头部 11px 分级徽章；`.badge.l0` / `.badge.l1` / `.badge.lock` |
| `#suggest-chips` | 输入框上方建议 chip 容器（静态首屏有 4 个示例，JS boot 时先清空再渲染） |
| `.suggest-chip` | 建议 chip 按钮 |

> 手机端（≤899px）`#suggest-chips` 为单行、只显示前 3 个 chip（`:nth-child(n+4)` 隐藏），
> 避免第二行只剩一个孤儿；`SUGGESTIONS` 写 3—4 条即可，若想手机端显示 4 条请把每条压到 6 字内。

> 静态欢迎态说明：`#feed` 里现有欢迎内容 + `#suggest-chips` 里 4 个示例 chip 都是**首屏占位**。
> `app.js` 启动时调用 `feed.clearFeed(); feed.addWelcome();` 并**先清空 `#suggest-chips`** 再渲染，
> 避免重复。`#session-list` 为空时的提示用 `:empty::after` 实现，JS 填入会话后自动消失，无需清理。

## 6. 进度 / 骨架屏（components.css §4–5）

| class | 用途 |
|---|---|
| `.progress` | 线性进度轨（深色面板默认轨道色） |
| `#measure-progress-bar` / `.progress-bar` / `.progress > i` | 进度填充（宽度由 JS 内联设置） |
| `.progress.on-paper` | 纸面底色上的深色轨道 |
| `.progress-ring` | 测量卡进度环，根元素内联 `style="--pct:33"`，内部 `<span>1/3</span>` |
| `.skeleton` / `.skeleton-line` / `.skeleton-block` | shimmer 骨架屏；行宽可用 `--w` 覆盖 |

## 7. 会话流（components.css §6）

契约结构：`.feed-item.user` / `.feed-item.ai` → `.think`（`<details>`）/ `.ai-body` / `.cards`。

| class | 用途 |
|---|---|
| `.feed-item` | 一轮消息容器（下间距 `--s5`） |
| `.feed-item.user` / `.user-bubble` / `.user-thumb` | 用户气泡（右对齐，暖纸底）与缩略图 |
| `.feed-item.ai` / `.ai-body` | 助手正文（15px/1.7） |
| `.ai-stage` | 「正在读照片…」阶段提示，前置脉动圆点 |
| `.stream` | 流式写入文本；加 `.is-streaming` 显示光标 |
| `.think` / `.think-body` | 折叠思考过程；`<details open>` 默认展开 |
| `.cards` | 卡片槽；每张卡入场 `translateY(8px)` + 40ms stagger |

## 8. 卡片通用（components.css §7）

| class | 用途 |
|---|---|
| `.card` | 白卡：`--r-l` 圆角、暖色阴影、hover 上移 1px |
| `.card-head` | 头部：类型色淡色渐变带；直接子 SVG 会自动变成 26px 色块图标 |
| `.card-titles` | **推荐**：把 `.card-kicker` 与 `.card-title` 包成上下两行 |
| `.card-kicker` | 12px 类型/场景小标签（前置类型色小方块） |
| `.card-title` | 17px/650 卡片标题 |
| `.card-body` | 15px 正文区（内部 `* + *` 自动 10px 间距） |
| `.card-foot` | 底部注脚（暖纸底 + 上边框） |
| `.card-actions` | 动作行；作为 `.card` 直接子元素时自动带 18px 内边距 |
| `.card-foot-actions` | 放在 `.card-foot` 右侧的动作组 |
| `.disclaimer` | 11px 免责文案（L0/L1 固定句直接放这里） |

> 卡片头部的尾部状态元素（`.chip` / `.badge` / `.verdict` / `.item-tag` 作为最后一个子元素时）
> 会自动靠右；方向卡里 badge 在第一位的写法也会被 CSS `order` 调成「kicker 左、badge 右」，无需改 JS 结构。

类型色（同时设 `data-type` 和对应 `.card-*` class 之一即可）：

| data-type | class | 色调 |
|---|---|---|
| `directions` | `.card-direction` | 陶土橙 |
| `measure` | `.card-measure` | 暖黄 |
| `quality` | `.card-quality` | 绿 |
| `plan` | `.card-plan` | 深陶土 |
| `verdict` | `.card-verdict` | 墨色 |
| `blocked` | `.card-blocked` | 红 |
| `radar` | `.card-radar` | 绿 |

## 9. L0 方向卡（components.css §8）

```html
<section class="card card-direction" data-type="directions">
  <div class="card-head">
    <svg class="i" viewBox="0 0 24 24">…</svg>            <!-- 可选，自动变图标瓦片 -->
    <div class="card-titles">
      <div class="card-kicker">客厅 · 电视柜右角</div>
      <h3 class="card-title">两个可走的方向</h3>
    </div>
    <span class="badge l0">L0 · 方向预览</span>
  </div>
  <div class="card-body">
    <p>先量通道。两个方向都成立的话，优先复用你已有的窝。</p>
    <div class="dir-list">
      <button class="dir-item" type="button" aria-pressed="true">
        <span class="dir-index">1</span>
        <span class="dir-title">靠右墙角放半包窝</span>
        <span class="dir-pitch">三面有墙，猫更有安全感；会吃掉一部分通道。</span>
        <span class="dir-meta">
          <span class="kit-chip kit-reuse">复用现有</span>
          <span class="chip">约 45cm 宽</span>
        </span>
        <span class="dir-risk">通道若不足 60cm，这个方向要放弃</span>
      </button>
    </div>
  </div>
  <div class="card-foot"><span class="disclaimer">这是方向预览……</span></div>
</section>
```

| class | 用途 |
|---|---|
| `.dir-list` / `.dir-item` | 方向列表 / 可点整行（选中 `aria-pressed="true"` 或 `.is-active`） |
| `.dir-index` | 左上角编号小方块 |
| `.dir-title` / `.dir-pitch` / `.dir-meta` / `.dir-risk` | 标题 / 一句话 / 标签行 / 风险行 |
| `.kit-chip` + `.kit-new` / `.kit-reuse` / `.kit-mix` | 复用 / 新品 / 混合 |

## 10. 测量卡（components.css §9）

```html
<section class="card card-measure" data-type="measure">
  <div class="card-head">
    <div class="progress-ring" style="--pct:33"><span>1/3</span></div>
    <div class="card-titles">
      <div class="card-kicker">第 1 轮测量</div>
      <h3 class="card-title">这轮只要两个数</h3>
    </div>
  </div>
  <div class="card-body">
    <p>量最窄的地方。不确定就跳过，不会硬猜。</p>
    <div class="measure-item">
      <div class="m-head"><span class="m-num">01</span><span class="m-label">通道净宽</span></div>
      <div class="m-endpoints">最近的家具外沿 → 对面墙的最窄处</div>
      <div class="m-field">
        <input class="m-input" type="number" inputmode="decimal" placeholder="62">
        <span class="m-unit">cm</span>
      </div>
      <div class="m-why">低于 60cm，猫会绕着走，窝就白放了。</div>
      <div class="m-actions">
        <button class="btn btn-primary">确认</button>
        <button class="m-skip">不确定，跳过</button>
      </div>
    </div>
  </div>
  <div class="card-foot"><span class="disclaimer">单位统一用厘米。</span></div>
</section>
```

| class | 用途 |
|---|---|
| `.measure-item` | 单条测量（`+` 自动间距；跳过态加 `.is-skipped`） |
| `.m-head` / `.m-num` / `.m-label` | 序号 + 名称 |
| `.m-endpoints` | 端点说明（前置短横线） |
| `.m-field` / `.m-input` / `.m-unit` | 数字输入行（116px 数字框 + 单位） |
| `.m-why` / `.m-hint` / `.m-example` | 为什么量 / 提示 / 示例值 |
| `.m-actions` / `.m-skip` | 操作行 / 「不确定，跳过」文字按钮 |
| `.measure-batch` | 多条测量批量提交的包裹层 |

## 11. 质检卡（components.css §10）

`.card-quality[data-type=quality]` + `.card-body`：

| class | 用途 |
|---|---|
| `.q-score-row` / `.q-score` / `.q-summary` | 分数（`92<small>/100</small>`）+ 一句话结论 |
| `.issue-list` / `.issue` | 问题列表；`data-severity="block"` 变红否则暖黄 |
| `.issue-main` / `.issue-label` / `.issue-hint` | 问题结构 |
| `.q-tip` | 绿色补拍建议条 |

操作按钮可放 `.card-body > .card-actions` 或 `.card` 直接子级 `.card-actions`。

## 12. L1 交付包（components.css §11）

```html
<section class="card card-plan" data-type="plan">
  <div class="card-head">
    <svg class="i">…</svg>
    <div class="card-titles">
      <div class="card-kicker">交付包</div>
      <h3 class="card-title">可以放，但要选进深 ≤ 45cm 的窝</h3>
    </div>
    <span class="badge l1">L1 · 可执行</span>
  </div>
  <div class="plan-tabs" role="tablist">
    <button type="button" data-tab="annotate" aria-selected="true">标注</button>
    <button type="button" data-tab="position">位置</button>
    <button type="button" data-tab="constraints">尺寸条件</button>
    <button type="button" data-tab="items">建议</button>
    <button type="button" data-tab="checklist">清单</button>
  </div>
  <div class="plan-panels">
    <div class="tab-panel is-active" data-tab="annotate">…</div>
    <div class="tab-panel" data-tab="position">…</div>
    …
  </div>
  <div class="card-foot">
    <span class="disclaimer">以交付时的尺寸条件为准，落地前请现场确认。</span>
    <div class="card-foot-actions"><button class="btn btn-ghost">导出标注图</button></div>
  </div>
</section>
```

> **V2.1 起 tab 顺序固定为：标注 → 位置 → 尺寸条件 → 建议 → 清单**（UC-1/UC-2：尺寸条件排在商品之前）。
> 「位置」tab 的内容见 §19。

| class | 用途 |
|---|---|
| `.plan-tabs > button[data-tab]` | Tab 头；选中用 `aria-selected="true"` 或 `.is-active`（黑底胶囊） |
| `.plan-panels` / `.tab-panel` | 面板容器 / 单个面板；显示时加 `.is-active` 或 `data-active="true"` |
| `.plan-headline` / `.plan-budget` | 一句话结论 / 预算行（`<strong>` 显示金额） |
| `.annotation-list` / `.annotation-item` / `.annotation-index` / `.annotation-note` | 「标注」Tab |
| `.item-list` / `.item-row` | 「建议」Tab 商品/复用行（复用行加 `.is-reuse` 虚线框） |
| `.item-thumb` / `.item-main` / `.item-top` / `.item-title` / `.item-price` / `.item-dims` / `.item-why` / `.item-tags` / `.item-tag` | 行内结构 |
| `.fit-ok` / `.fit-blocked` / `.fit-note` | 尺寸是否通过 |
| `.constraint-list` / `.constraint` | 「尺寸条件」行；`data-status="pass\|fail\|unknown"` 控制底色 |
| `.c-label` / `.c-value` / `.c-status` + `.status-pass` / `.status-fail` / `.status-unknown` | 行内三段 |
| `.checklist` / `.check-item` / `.check-box` / `.check-text` / `.check-critical` | 「清单」；`.check-item[role=checkbox][aria-checked=true]` 或 `.is-done` |
| `.aftercare` / `.aftercare-row` / `.aftercare-day` | 交付后回访建议 |

## 13. 结论 / 阻断 / 雷达（components.css §12–13）

| class | 用途 |
|---|---|
| `.verdict` | 结论胶囊；`.continue` / `.not_supported` / `.insufficient` |
| `.verdict-line` / `.verdict-reason` | 结论行（胶囊 + 一句话）/ 补充原因 |
| `.blocked-list` / `.blocked-item` / `.blocked-what` / `.blocked-why` | 阻断项 |
| `.radar-wrap` / `.radar-svg` | 雷达图与右侧图例（窄屏自动换行） |
| `.radar-grid` / `.radar-axis` / `.radar-shape` / `.radar-point` / `.radar-label` | SVG 内部样式（纯 SVG 元素） |
| `.radar-legend` / `.radar-row` / `.radar-key` / `.radar-bar > i` / `.radar-score` | 五维条形图例（`i` 宽度用内联百分比） |
| `.radar-note` | 「启发式参考，非实测」注脚 |

## 14. 右侧画布面板（components.css §14）

契约 ID：`#canvas-panel / .panel-head / .panel-title / #canvas-badge / #panel-empty / .empty-art / #canvas-stage / #scene-canvas / #canvas-hint / #canvas-toolbar / #measure-dock / #deliver-dock / .panel-foot`。

| 选择器 / class | 用途 |
|---|---|
| `#canvas-stage` | 相片托盘：`height:min(42vh,340px)`、`margin:0 14px`、`--r-m` 圆角（手机端 240px） |
| `#canvas-stage[data-visible=false]` | 隐藏画布（空状态） |
| `#canvas-hint[data-show=true/false]` | 画布顶部提示，淡入淡出 |
| `#canvas-toolbar` | 画布底部浮动工具条（深色胶囊） |
| `#btn-pick-mode[aria-pressed=true]` | 点选模式激活态（accent 实心） |
| `#canvas-legend` | **新增**：画布图例容器，由 ui-logic 填 `.legend-chip`；`data-visible="false"` 时 `visibility:hidden` **保留 40px 占位**，空状态下自动 `display:none` |
| `.legend-chip` | 图例 chip：`<span class="legend-num">1</span>猫窝落点位`；选中 `aria-pressed="true"` accent 描边；可加 `data-verdict="ok\|conditional\|blocked\|unknown"` 让序号变色 |
| `.legend-num` | 图例序号小方块 |
| `#measure-dock` / `.dock-head` / `#measure-progress` / `#measure-progress-bar` / `#measure-dock-list` | 测量进度 dock |
| `.dock-item` / `.dock-label` / `.dock-value` / `.dock-item.is-missing` | 单条已量/待量；未知用 `.is-missing` |
| `#deliver-dock` / `#btn-deliver` / `#btn-export` | 交付 dock；`data-state="done"` 时导出升主按钮，生成按钮降 ghost |
| `.panel-foot` | 面板底部小字（手机端隐藏） |

## 15. Toast / Modal（components.css §15–16）

| class | 用途 |
|---|---|
| `#toast-host` | 固定底部居中的 toast 容器（手机端自动抬高到抽屉把手之上） |
| `.toast` / `.toast.ok` / `.toast.error` / `.toast.is-leaving` | 普通 / 成功 / 失败 / 离场 |
| `#modal-host[data-open="true"]` | 打开遮罩 + 居中 modal |
| `.modal` / `.modal-head` / `.modal-title` / `.modal-close` / `.modal-body` / `.modal-foot` / `.modal-note` | 弹窗结构；标题用衬线 |

## 16. 布局与断点（screens.css）

| 选择器 / class | 用途 |
|---|---|
| `#app` | 桌面三栏：`248px minmax(0,1fr) 400px` |
| `#rail` | 左栏；`data-collapsed` 保留给 JS 控制 |
| `.brand-word` / `.brand-word .dot` | 品牌字 `corner.`（衬线）与橙点 |
| `.rail-label` | 「最近」小标签 |
| `#session-list:empty::after` | 左栏空态提示（纯 CSS，JS 一填即消失） |
| `.session-item` | 会话项；选中 `.is-active` / `aria-current="true"` 时左侧 2px accent 竖条 + 白底 |
| `.session-item .s-title` / `.s-meta` / `.s-thumb` / `.session-del` | 会话项内部（缩略图 56px 高、hover 显示删除） |
| `.stage-title-wrap` / `#stage-title` / `#stage-meta` | 中栏头部 |
| `#feed` | 会话流滚动区（顶部渐变遮罩 + 上下 padding 自动对齐 760 内容宽） |
| `#composer` / `#composer-box` / `#composer-input` / `#composer-foot` / `.kbd-hint` | 输入中枢（focus-within 陶土细环） |
| `.welcome` / `.welcome-eyebrow` / `.brand-mark` / `.eyebrow-rule` / `.eyebrow-text` | 欢迎态 hero |
| `.welcome-title` / `.mark` | 衬线大标题；`.mark` 是手绘橙色下划线 |
| `.welcome-lede` / `.welcome-steps` / `.step-num` / `.step-text` | 价值主张 / 三步说明 |
| `.example-block` / `.ex-head` / `.ex-label` / `.ex-hint` | 示例区标题行 |
| `.example-grid` / `.example-card` / `.ex-art` / `.ex-title` / `.ex-sub` / `.ex-arrow` | 三张示例卡（移动端自动变成左图右文的列表） |
| `.welcome-trust` | 三条产品原则小字 |
| `.panel-head` / `.panel-title` | 右栏头部 |
| `.empty-art` / `.empty-legend` / `.dot.ok/.mid/.no` | 右栏空状态插画与图例 |

**断点**：
- `≤1179px`：rail 收成 64px 图标条（会话项只显示 20px 色块），panel 340px。
- `≤899px`：单列；`#rail` 变顶部固定条；`#canvas-panel` 变底部抽屉：
  - `data-open="false"`：`translateY(calc(100% - 52px))`，只露把手 + 「空间画布」标题行；
  - `data-open="true"`：完全展开，`height:auto` + `max-height:min(80dvh,660px)`，内部可滚动；
  - 中栏预留 `padding-bottom: panel-peek`，因此输入框不会被抽屉把手盖住。
- 手机端 `.kbd-hint`、`.panel-foot`、示例卡箭头隐藏；文字全部换行，不允许横向滚动。

## 17. 状态属性协议（JS 只改这些，不改内联样式）

| 属性 | 取值 | 影响 |
|---|---|---|
| `#app[data-theme]` | `light` | 预留（当前只有浅色主题） |
| `#app[data-ready]` | `0/1` | 预留（JS 启动完成后可置 1） |
| `#rail[data-collapsed]` | `false/true` | 预留的收起开关（当前断点由 CSS 控制） |
| `#stage-chip` class | `chip chip-l0` / `chip chip-l1` / `chip chip-warn` / `chip chip-bad` | 阶段状态配色 |
| `#canvas-panel[data-empty]` | `true/false` | 控制空状态插画显隐 |
| `#canvas-panel[data-open]` | `true/false` | 手机端底部抽屉开合 |
| `#canvas-stage[data-visible]` | `true/false` | 画布显隐 |
| `#canvas-legend[data-visible]` | `true/false` | 图例显隐（false 保留占位） |
| `#canvas-hint[data-show]` | `true/false` | 提示淡入淡出 |
| `#measure-dock[data-visible]` | `true/false` | 测量 dock 显隐 |
| `#deliver-dock[data-visible]` | `true/false` | 交付 dock 显隐 |
| `#deliver-dock[data-state]` | `done` | 已交付：导出升 primary |
| `#btn-deliver[disabled]` | — | 已交付时可用 `data-state=done` + 可点文案替代 |
| `#btn-export[disabled]` | — | 未交付时禁用；done 状态下样式强制为 primary |
| `#btn-pick-mode[aria-pressed]` | `true/false` | 点选模式 |
| `.dir-item[aria-pressed]` | `true/false` | 方向选中 |
| `.check-item[aria-checked]` | `true/false` | 清单勾选 |
| `.card` 的 `data-type` | 见 §8 | 卡片类型色 |
| `.constraint[data-status]` | `pass/fail/unknown` | 尺寸条件配色 |
| `.toast.ok/.error` | — | toast 语义 |
| `.basis-badge[data-kind]` | `strong / moderate / consensus / weak` | 依据徽章配色（strong 绿、moderate 陶土、consensus 灰、weak 虚线） |
| `.basis-badge[aria-expanded]` | `true/false` | 当前打开的徽章（accent 环） |
| `#basis-popover[data-open]` | `true/false` | 依据气泡显隐 |
| `#basis-popover[data-placement]` | `bottom / top` | 箭头朝上（气泡在徽章下方）/ 朝下 |
| `#basis-popover` 的 `--arrow-x` | 任意 px | 箭头水平位置（相对气泡左边缘） |
| `#goal-choices[hidden]` / `.goal-choices` | — | 目标选择显隐（JS 填 4 个 `.goal-choice`） |
| `.goal-choice[aria-pressed]` | `true/false` | 单选选中态（accent 边框 + 浅底） |
| `#wait-steps[hidden]` / `.wait-steps` | — | 等待 3 步显隐 |
| `.wait-steps li[data-state]` | `done / active / todo` | 完成（灰+删除线+✓）/ 进行中（呼吸点）/ 未开始 |
| `.measure-range-toggle[aria-pressed]` | `true/false` | 当前是否区间模式 |
| `#cat-profile-form` | — | hidden 模板；JS 克隆进 modal body，按钮组 `[data-value][aria-pressed]` |
| `.cpf-option[aria-pressed]` | `true/false` | 猫档案选项选中态 |

## 19. V2 · 依据与位置（components.css §15–19）

契约增补见 `docs/CONTRACT-V2.md`。以下 class 由 UI 外壳提供、ui-logic 填充：

### 19.1 依据徽章与依据气泡
```html
<button class="basis-badge" data-kind="strong" data-basis-id="CAT-HIDE-01"
        data-label="研究支持（强）" data-topic="…" data-claim="…"
        data-source="Ellis et al. 2013 · JFMS" data-url="https://…" data-caveat="…"
        aria-expanded="false">研究支持（强）</button>
```
| class / 选择器 | 用途 |
|---|---|
| `.basis-badge[data-kind=strong\|moderate\|consensus\|weak]` | 四档依据徽章；weak 为虚线框（经验值） |
| `#basis-popover` | fixed 气泡外框，z-index 110（高于卡片、低于 modal/toast） |
| `#basis-popover > .basis-pop-body` | **内容层**：`max-height:50vh; overflow:auto` + 卡片底/边/阴影；三角挂在外层不会被裁 |
| `.basis-pop-head` / `.basis-pop-title` / `.basis-pop-claim` / `.basis-pop-source` / `.basis-pop-caveat` | 气泡内容结构（标题单行省略、来源可点、caveat 带「适用边界」小标签） |
| `.basis-pop-close` | 关闭按钮（可选） |

定位约定：JS 设 `#basis-popover` 的 `left/top`，设 `data-placement="bottom|top"` 控制箭头方向，
设内联 `--arrow-x` 让箭头对准徽章。

### 19.2 位置评估（「位置」tab）
| class | 用途 |
|---|---|
| `.catfit-verdict` | 顶部结论行（可放 `.verdict.good/.caution/.poor/.unknown`） |
| `.catfit-list` / `.catfit-item[data-status=pass\|warn\|fail\|unknown]` | 6 项判定行；fail 行左侧 2px 红条，warn/unknown 琥珀竖条；**unknown 与 fail 同等视觉重量**（UC-1/UC-2） |
| `.catfit-status`（内含内联 SVG）或 `.catfit-item > svg:first-child` | 18px 圆形状态图标（pass 绿 / warn·unknown 琥珀 / fail 红） |
| `.catfit-main` / `.catfit-label`（兼容 `.catfit-name`）/ `.catfit-why` | 名称 + 一句机制解释；标题行用 `.catfit-main > div:first-child` 排 label + `.item-tag` |
| `.catfit-item > .basis-badge` | 右侧依据徽章 |

### 19.3 猫会怎么用 / 观察 / if-then / 归属感
| class | 用途 |
|---|---|
| `.behavior`（兼容 `.behavior-block`） | 浅底机制块 |
| `.behavior-likely` | 一句预测（15px 加粗，前置 accent 方块） |
| `.behavior-sub` | 「可能不用它的情况」小标签 |
| `.behavior-why-not > li` | 每条前置红色 × |
| `.behavior-sign` | 判断信号浅底条（正文自带「判断信号：」） |
| `.observe` / `.observe-list` / `.observe-item` / `.observe-day` / `.observe-day-num` / `.observe-title` / `.observe-checks` | 按天时间线（左侧竖线 + 圆点） |
| `.if-then` / `.if-then-list` / `.if-then-row` / `.if-then-if` / `.if-then-then` | 实施意图：「如果 …」/「→ 就 …」，if/then 里只放原文，标签由 CSS 补 |
| `.ownership-line` | 「这份方案用了你量的 N 个数…」，数字用 `<b class="mono">`；顶部细线 |
| `.card-direction[data-recommended="true"]` / `.recommend-tag` / `.recommend-why` | L0 推荐方向（左侧 3px accent 竖条 + 「推荐先试这个」） |
| `.dir-item[data-recommended="true"]` | 被展开的推荐方向 |
| `.dir-item[data-collapsed="true"]` / `.dir-item.is-collapsed` / `.dir-collapsed-group` | 其余方向折叠成一行（编号 + 标题 + 展开箭头），可点击展开 |
| `.alternatives-note` | 折叠组末尾的补充说明 |

### 19.4 猫档案
| class | 用途 |
|---|---|
| `#btn-cat-profile` + `.chip-profile` | composer 底部的「猫：中型 · 1 只」chip（含猫头 SVG） |
| `#cat-profile-form` / `.cat-profile-form` | hidden 模板，JS 克隆进 modal body |
| `.cpf-intro` / `.cpf-group[data-field]` / `.cpf-label` / `.cpf-options` / `.cpf-option[data-value][aria-pressed]` / `.cpf-hint` | 4 组选项（体型/月龄/猫数量/冬季地面） |
| `.cpf-hidden-inputs` | 隐藏的 name=catSize… 初始值快照，不渲染 |

## 20. V2.1 · 决策心理学组件（components.css §20）

研究依据：`docs/RESEARCH-PSYCH.md`（CF-2 / DF-2 / PV-1 / PV-2 / UC-1 / UC-2 / AA-2 / EF-1 / PG-1）。

| class | 用途 |
|---|---|
| `#goal-choices` / `.goal-choices` | 方向卡前的「你最想解决哪个？」（初始 `hidden`，JS 动态创建更稳，`clearFeed()` 会清掉静态容器） |
| `.goal-choices-label` | 一行小标签「你最想解决哪个？（点一下就行）」 |
| `.goal-choices-row` / `.goal-choice[data-value][aria-pressed]` | 4 个比普通 chip 大一号的单选按钮：猫不进去 / 太乱占道 / 有味道 / 都还行 |
| `#wait-steps` / `.wait-steps` | 等待态 3 步 checklist（初始 `hidden`，建议动态创建） |
| `.wait-steps li[data-state=done\|active\|todo]` | done 灰+删除线+✓、active 呼吸点、todo 空心 |
| `.measure-range` / `.measure-range-dash` | 区间输入（两个 `.m-input` + em dash），与单值输入同为 42px 高 |
| `.measure-range-toggle` | 「不确定，估个范围」/「填一个数就行」切换文字按钮，位置固定避免跳高 |
| `.card.card-followup` / `.chip-followup` / `.followup-title` / `.followup-sub` / `.followup-actions` | 回访轻卡（无大阴影、浅底、第 2/7 天徽章、2—3 个动作） |
| `.btn-modify` | 交付卡标题右侧「改一改」（ghost、12px、铅笔 SVG） |
| `.plan-modify` / `.plan-modify-head` / `.plan-modify-section` / `.plan-modify-row` / `.plan-modify-chips` | 「改一改」就地重算面板（默认 `hidden`；改尺寸 / 换方向 / 调整热区三段） |
| `.card-waitsteps` + `.card-body > .wait-steps` | 等待卡；步骤列表嵌在 `card-body` 时自动去掉第二层卡片样式 |
| `.wait-recognition` / `.recognition-line` / `.recognition-boundary` | 等待卡的照片指认句 + 专业边界句 + 「不对？点图重选」 |
| `.measure-range-note` | 区间输入的补充说明 |
| `.checklist-list > li:first-child` / `.checklist > .check-item:first-child` | 清单第一条 = 计划句，浅 accent 底 + 加粗（自动生效，不用改结构） |

**V2.1 文案（静态 index.html 已落地，运行态由 feed.js 同步）**
- 欢迎态 lede：`拍一张角落 → 看清能怎么改 → 量 2 个尺寸，拿到能带去店里的清单。`
- 欢迎态底部：`不买也行 —— 0 元方案和买新品同权展示，且排在前面。`（`.welcome-keep`）
- composer 隐私句：`照片只用于这一次分析。右上角可随时删除，删除即从服务器移除。`
- 示例卡副文案带「0 元方案」。
- 「尺寸条件」tab 排在「建议」之前（UC-1/UC-2）。

## 21. 注意事项（补充）

1. `#goal-choices` / `#wait-steps` 是 `#feed` 内的静态占位，`feed.clearFeed()` 会移除它们——建议 ui-logic 动态创建，或 clearFeed 时保留这两个容器。
2. 依据气泡内容务必放进 `.basis-pop-body`；直接写 `#basis-popover` 会没有三角（但仍有完整卡片兜底）。
3. `.wait-steps` 的「进行中」呼吸动画已做 `prefers-reduced-motion` 降级。
4. 「未知」状态与「冲突」状态同权重是研究硬要求（UC-1/UC-2），不要加淡、不要用虚线弱化。
5. 5 个 tab 在 390 宽下可直接放下；若文案变长，`.plan-tabs` 自带横向滚动 + 右侧渐隐提示（隐藏滚动条）。

## 22. 通用注意事项（V1 沿用）

1. `#feed` 与 `#suggest-chips` 的静态内容只是首屏占位，**JS 启动时必须清空**再渲染，否则会重复。
2. 卡片内不要用 `innerHTML` 拼用户/AI 文本（cards.js 已按 DOM API 约定），样式对此无要求。
3. `.card:hover` 有 1px 上移，入场动画使用 `animation-fill-mode: backwards`，不会覆盖 hover 位移；新增动画请沿用该写法。
4. 只有 `.card[data-type]` / `.card-*` 的组合会带类型色，两者写一个即可（建议都写）。
5. 所有可点元素已统一 `:focus-visible` 焦点环；深色面板内焦点环换成 `--canvas-accent`。
6. 动效只使用 `transform / opacity / background-color`，并已处理 `prefers-reduced-motion`。
7. 手机端不允许横向滚动：新增内容请使用 `min-width:0` + 换行，不要用固定宽度的长文本行。

## 23. V3 · 闭环完成感 / 家庭社交（components.css 末尾）

契约见 `docs/CONTRACT-V3.md`。UI 外壳同时兼容 lead 命名与 ui-logic 实际生成的命名：

### 23.1 交付收尾卡
| 实际 class（ui-logic） | lead 契约别名 | 用途 |
|---|---|---|
| `.card.card-handoff[data-type=handoff]` | 同 | 比 plan 更轻的收尾卡（浅底、无阴影） |
| `.chip.chip-handoff` | 同 | 「已完成」徽章 |
| `.handoff-done` | 完成句 | 20px/650 完成句（移动端 18px 自动换行平衡） |
| `.handoff-stats > .handoff-stat`（`<b class=mono>` + `<span>`） | `.stat-triple > .stat`（`.stat-num` / `.stat-label`） | 三个大号等宽数字；390 下两列，第三个占满行 |
| `.handoff-timeline > summary` + `.handoff-days > .handoff-day`（`.handoff-day-num`） | `.timeline-mini > .timeline-mini-item` | 折叠的 7 天时间线（左侧细线 + 圆点） |
| `.handoff-share-status` | 同 | 「已分享 · 等待家人意见」小状态 |
| `.handoff-actions > .btn` ×4 | `.action-grid > .btn` ×4 | 2×2 动作，高度 ≥44px |

### 23.2 分享面板 `.share-sheet`
挂到 `#modal-host` 内；桌面居中卡片、手机底部抽屉（`#modal-host:has(.share-sheet)` 时贴底）。
| class | 用途 |
|---|---|
| `.share-sheet` + `data-open="true"` | 面板本体 / 显隐；遮罩由 `#modal-host[data-open]` 提供 |
| `.share-sheet .share-head` / `.share-title` / `.modal-close` | 头部（标题用衬线） |
| `.share-sheet .share-body` | 内容区 |
| `.share-link-row` / `input.share-link` | 等宽链接框（点击即复制由 JS 处理） |
| `.share-notes > li.share-note` | 三行说明 |
| `.share-actions > .btn` | 复制 / 系统分享 / 撤销 / 完成；撤销按钮加 `.btn-danger` |
| `.share-sheet .share-foot` | 底部隐私句（「只包含方案摘要…」） |

### 23.3 家人意见卡 `.card.card-votes`
| class | 用途 |
|---|---|
| `.chip.chip-votes` | 「家人意见」徽章 |
| `.vote-summary` 或 `.card-head .card-kicker` | 汇总（3 人看过 · 支持 2 · 犹豫 1） |
| `.vote-list > .vote-row` | 每行一位家人 |
| `.vote-avatar` | 首字母圆点（不要真头像）；按行自动换色 |
| `.vote-who` / `.vote-name` / `.vote-choice` | 名字 + 支持对象 |
| `.vote-note` / `blockquote` | 留言（引号块 / 浅底） |
| `.vote-badge[data-vote=yes\|unsure\|no]`（也支持 `.vote-yes/.vote-unsure/.vote-no`） | 三色小徽章 |

### 23.4 改造前后对比卡 `.card.card-compare`
| class | 用途 |
|---|---|
| `.compare-grid` | 两列 + 中间箭头（390 仍是两列，图片高度收窄） |
| `.compare-pane.is-before` / `.is-after` | 左右两格 |
| `.compare-canvas` / `.compare-img` | 原图（标注 canvas）/ 改造后 img |
| `.compare-label` | 左上角「改造前 / 改造后」标签 |
| `.compare-arrow` | 中间「→」 |
| `.compare-caption` | 可编辑一句（input 或 `contenteditable`，≤30 字） |
| `.compare-actions > .btn` | 导出对比图 / 重新上传 |

### 23.5 手机键盘
- `#app` 使用 `100dvh`；`#composer` 用 `max(10px, env(safe-area-inset-bottom))` 兜底。
- ui-logic 通过 `visualViewport` 给 `#composer` 加 `transform` 上移；另预留 `#app[data-keyboard="open"]`（隐藏画布抽屉 peek、收紧 stage padding），需要时可直接用。

## 24. V3 · 分享页 `share.html` / `share.css`

- 页面由服务端路由 `/s/<token>` 直接返回 `share.html`，所以资源用**绝对路径**：`/styles/base.css`、`/styles/share.css`、`/js/share.js`、`/favicon.svg`。
- 只引 base + share；**不引 components.css / screens.css**（share.js 复用的 `.catfit-list/.constraint-list/.item-list` 等在 share.css 内自足实现）。
- 必存 ID：`share-root, share-loading, share-invalid, share-content, share-title, share-owner, share-expiry, share-decision, share-photo-wrap, share-photo, share-photo-legend, share-catfit, share-constraints, share-items, share-vote, share-disclaimer`（+ `dev-error-banner`）。
- 页面状态：`#share-root[data-state=loading|ready|expired|invalid]`；JS 切换三个容器的 `hidden`。
- 布局：移动优先单列；`#share-root` 手机铺满、≥760px 变为居中 640px 的「卡片纸」；正文 15px；按钮触控 ≥44px。

### 24.1 分享页内容 class（share.js 填充）
| class | 用途 |
|---|---|
| `.share-topline`（`.share-ttl` + `#share-expiry`） | 顶部「仅家庭内分享 · 剩余 N 小时 · 不可下载原图」 |
| `.share-head` / `.share-brand` / `.share-title` / `.share-meta` / `#share-owner` | 品牌 + 标题 + 主人/时间 |
| `#share-decision.decision-banner` | 结论横幅；`data-decision=ok\|conditional\|not_supported\|insufficient` 或 `data-tone=pass\|warn\|fail` 控制三态色 |
| `.decision-label` / `.decision-headline` / `.decision-reason` | 横幅内三段 |
| `.share-photo-wrap` / `#share-photo` / `.share-hotspots > .share-hotspot`（`.share-hotspot-num`） | 标注缩略图（900px）与编号热区覆盖层 |
| `.share-photo-legend > .share-legend-item`（`.share-legend-num`） | 图例 chips（可带 `data-status`） |
| `.share-section` / `.share-section-title` / `.share-section-note` | 分区标题 |
| `.catfit-list` / `.catfit-item[data-status]` / `.catfit-status` / `.catfit-main` / `.catfit-label` / `.catfit-why` | 位置判断（与主应用同构，分享页不显示依据 URL） |
| `.constraint-list` / `.constraint[data-status]` / `.c-label` / `.c-value` / `.c-status` | 尺寸条件三态 |
| `.item-list` / `.item-row` / `.item-main` / `.item-top` / `.item-title` / `.item-price` / `.item-tags` / `.item-tag` / `.fit-ok\|fit-blocked` | 方案 |
| `.vote-block[data-target-id]` / `.vote-title` / `.vote-counts` / `.vote-actions` / `.vote-btn[data-vote=yes\|unsure\|no][aria-pressed]` / `.vote-fields` / `.vote-note` / `.vote-name` / `.vote-submit` / `.vote-done` | 投票区（按钮 44px；选中 支持=绿 / 犹豫=琥珀 / 反对=红） |
| `.share-foot` / `#share-disclaimer` / `.share-readonly` | 免责 + 「只读分享页，不能修改方案」 |
| `.share-loading` / `.share-skeleton` | 加载骨架屏（shimmer） |
| `.share-invalid` / `.share-invalid-art` | 失效/撤销态（插画 + 一句人话 + 回首页按钮） |

### 24.2 分享页注意
1. 原图不可下载：只提供 900px 缩略图 URL（`/api/share/<token>/photo`），页面文案标注「不可下载原图」。
2. 分享页不出现依据 URL（`basis-badge` 不渲染链接），避免把分享页变成文献页。
3. `share-invalid` 同时承载 expired / invalid 两态，标题与说明由 share.js 改写。
4. 不允许横向滚动；长标题、长留言用 `overflow-wrap:anywhere` / 省略处理。

## 25. V3 新增状态属性
| 属性 | 取值 | 影响 |
|---|---|---|
| `#share-root[data-state]` | `loading / ready / expired / invalid` | 分享页三/四态 |
| `#share-decision[data-decision]` | `ok / conditional / not_supported / insufficient` | 结论横幅配色 |
| `#share-decision[data-tone]` | `pass / warn / fail` | 备选配色入口 |
| `.share-sheet[data-open]` | `true / false` | 分享面板显隐（配合 `#modal-host[data-open]` 遮罩） |
| `.vote-btn[data-vote][aria-pressed]` | yes / unsure / no | 分享页投票选中态 |
| `.vote-badge[data-vote]` | yes / unsure / no | 家人意见徽章 |
| `.compare-caption` | `input` / `contenteditable` | 对比卡可编辑总结 |
| `#app[data-keyboard]` | `open` | 预留键盘适配（ui-logic 目前用 visualViewport transform） |

## 26. V3.1 · 手机端布局与折叠协议（screens.css / components.css）

目标硬指标：rail ≤48px、composer ≤112px、feed ≥73%、推荐方向卡 ≤340/整卡 ≤500、quality 折叠 ≤140、触控目标 ≥44（audit 以 <40 为 tiny，0 个）、首屏可见「先量这个」类主操作。

### 26.1 顶部 rail（≤899px）
手机端 rail 是 48px 顶栏：`☰ #btn-sessions` + `corner.`（14px）+ `＋ #btn-new`（44×44）。
会话列表变成左侧抽屉：
| 选择器 / class | 用途 |
|---|---|
| `#btn-sessions`（新增，桌面隐藏） | 打开/关闭会话抽屉；`aria-expanded` 同步 |
| `#rail[data-open="true"]` | 抽屉打开；`#rail::after` 是全屏 scrim（点击 target 为 `#rail`，可用来关闭） |
| `#session-list` | ≤899px 时 `position:fixed` 左侧抽屉（宽 `min(322px,84vw)`），关闭时 `translateX(-102%)` |
| `.session-item` 内部 `.s-title` / `.s-meta` | 抽屉内恢复显示（平板上被隐藏的文本在抽屉里要露出） |

### 26.2 composer（≤112px）
DOM 在 `#composer-foot` 新增 `#btn-foot-info`（ⓘ，绑定隐私弹层）与 `.foot-note-short`（「仅用于本次分析」）；桌面长句用 `.foot-note-long`。
| 选择器 / class | 手机端规则 |
|---|---|
| `#composer` | `padding: 4px 12px 0`，不遮把手 |
| `#suggest-chips` | 高 32px、单行横向滚动、隐藏滚动条；**仅欢迎态显示**（有内容时 ui-logic 加 `hidden`） |
| `#composer-box` / `#composer-input` | 52px 行高 / 输入 44px |
| `#btn-attach` / `#btn-send` | 44×44 |
| `#composer-foot` | 高 18px；`.foot-info`（16px）+ `.chip-profile`（文字化 11px）+ `.foot-note-short` 同一行 |
| `#composer[data-compact="true"]` | ui-logic 有会话内容时设置（chips 已隐藏后的紧凑态，实测 74px） |

### 26.3 画布抽屉把手（V3.1；V3.2 已改为全屏查看器，见 §27）
- V3.1 用 `--panel-peek: 44px` 的底部抽屉；**V3.2 起手机端不再常驻抽屉**，`#canvas-panel[data-open="false"]` 直接 `display:none`，把 44px 内容区还给 feed。
- V3.2 的入口是 feed 顶部 sticky 照片条（`.photo-strip`），打开后 `#canvas-panel` 全屏 cover；详见 §27。

### 26.4 quality 卡折叠（新 DOM，协议）
```html
<section class="card card-quality" data-type="quality" data-collapsed="true|false">
  <div class="quality-collapsed">
    <span class="chip chip-ok">照片可用</span>
    <p class="quality-seen">我看到的是：…</p>
    <button class="quality-toggle" type="button" aria-expanded="false">详情 ⌄</button>
  </div>
  <div class="quality-details" hidden>…原 .card-head / .card-body / .card-foot…</div>
</section>
```
| 选择器 / class | 用途 |
|---|---|
| `.chip-ok` / `.chip-warn` | 折叠态结论徽章（绿 / 琥珀） |
| `.quality-collapsed` | 折叠态容器（桌面 `display:none`，仅手机展示） |
| `.quality-seen` | 一句「我看到的是：…」（`-webkit-line-clamp:2`，保证 ≤140px） |
| `.quality-toggle` | 「详情 ⌄ / 收起 ⌃」，44px 触控 |
| `.card-quality[data-collapsed="true"]` | `.quality-details` 强制隐藏（含 `[hidden]`） |
| `.card-quality[data-collapsed="false"]` | 展示原 details，隐藏 collapsed |
| `.quality-details[hidden]` | 桌面端 CSS 强制可见（≥900px 回退桌面结构） |

### 26.5 方向卡手机压缩（一屏一卡）
ui-logic 在 ≤899px 生成 `.card-direction` + `.dir-item.is-mobile`：
| 选择器 / class | 手机端规则 |
|---|---|
| `.card-direction .card-head` / `.card-body > p` / `.verdict-line` / `.card-foot` | 隐藏（省高度） |
| `.dir-reco-head` | 同一行：`.dir-index` + `.dir-title`（16px）+ `.recommend-tag`（右） |
| `.dir-pitch.is-clamp` | 描述 2 行截断（12px） |
| `.dir-cta` | 全宽 44px 主 CTA「先量这个：…」 |
| `.dir-secondary > .dir-region / .dir-details-toggle` | 两列各 44px |
| `.dir-details[hidden]` / `.dir-details` | 「更多细节」折叠内容（meta/risk/recommend-why/dir-card-extra） |
| `.dir-item.is-collapsed` | 其它方向 48px 单行；`.dir-arrow` 自带「›」 |
| `.dir-collapsed-group` | 折叠组容器 |

### 26.6 触控与滚动
- `#feed .btn`、`.plan-tabs > button`、`.btn-modify`、`.measure-range-toggle` 等 ≤899px 统一 ≥44px；`.basis-badge` 40px（audit tiny 阈值为 <40，避免行高爆掉）。
- `#feed .card { scroll-margin-top: 8px; }`：ui-logic 的自动 `scrollIntoView` 用它把推荐卡/测量卡对齐 feed 顶部，主 CTA 进入首屏。
- 自动滚动尊重 `prefers-reduced-motion`（`behavior:auto`）。
- `stage-top` 在手机端高度为 0；feed 顶部从 48px 开始（照片条在 feed 内 sticky）。

## 27. V3.2 · 手机画布：照片条 + 全屏查看器（≤899px）

目标：手机不再有常驻底部抽屉；feed 顶部用一张 56px 照片条作为入口，点开是全屏查看器。桌面（≥900px）三栏完全不变。

### 27.1 照片条（ui-logic 动态 prepend 到 `#feed` 第一个子节点）
```html
<button class="photo-strip" type="button" aria-label="查看这张角落照片的 N 处标注">
  <img class="photo-strip-thumb" alt="" loading="lazy">
  <span class="photo-strip-text">
    <span class="photo-strip-title">这张角落照片</span>
    <span class="photo-strip-count"> · 标注 N 处</span>
  </span>
  <span class="photo-strip-cta">查看标注 ›</span>
</button>
```
| 选择器 / class | 规则 |
|---|---|
| `.photo-strip` | 仅 ≤899px 渲染；`position:sticky; top:0; height:56px; margin-bottom:10px`，吸在 rail 下方；`display:flex`，圆角纸卡 + 轻阴影 |
| `.photo-strip-thumb` | 44×44 圆角 8px `object-fit:cover`，直接用 `session.image.url` |
| `.photo-strip-text` | 一行：`.photo-strip-title`（13px/600）+ `.photo-strip-count`（11px/ink-3） |
| `.photo-strip-cta` | 「查看标注 ›」，accent 色，不换行 |
| 计数 | `plan.annotations.length \|\| l0.regions.length`，由 ui-logic 计算 |
| 打开 | 点击 → `flow.openCanvas(strip)`（ui-logic 已绑定） |

### 27.2 全屏查看器（复用 `#canvas-panel`）
- 收起：`#canvas-panel[data-open="false"]` 手机端 `display:none`，**不占底部高度**；`#stage` 不再预留 `--panel-peek`。
- 打开：`#canvas-panel[data-open="true"][data-viewer="true"]` → `position:fixed; inset:0; z-index:90; height:100dvh`，flex column；`background` 沿用深色画布。
- 结构：顶部 44px `.panel-head`（`.canvas-close` 44×44 + `.panel-title`「空间画布」+ `#canvas-badge`）→ `#canvas-stage`（`flex:1; min-height:0; margin:8px 12px 0`）→ `#canvas-legend`（max-height 92px，可滚动）→（隐藏 `#measure-dock` / `#deliver-dock` / `.panel-foot`，动作回到 feed 卡片）。
- 关闭按钮由 ui-logic 动态创建：`#btn-canvas-close.canvas-close`（44×44，在 `.panel-head` 内左侧；`[data-open="false"]` 时隐藏）。
- 关闭方式：点 × / 点图片外区域 / Esc（ui-logic 绑定）；关闭后焦点回到照片条。
- 画布重绘：打开下一帧 `initCanvas → setImage → renderOverlays → zoom('fit')`（ui-logic 已实现，ResizeObserver 也会在 `display:flex` 后触发）。
- 桌面：`.photo-strip`、`.canvas-close` 一律 `display:none`；`#canvas-panel` 三栏布局不变。

## 28. V4 · 家人回应（从表态到行动）

新增接口见 `docs/CONTRACT-V4.md`。UI 只加样式，不改 JS 结构。

### 28.1 家庭页「我能做什么」（`share.css`）
```html
<section class="share-section respond-section">
  <h2 class="share-section-title">我能做什么（选一个就行，不用登录）</h2>
  <div class="respond-block">
    <div class="respond-actions">4 × .respond-btn[data-action]</div>
    <div class="respond-form" hidden>
      <input class="respond-note"><input class="respond-name">
      <div class="respond-photo-fields" hidden>
        <input class="respond-file" type="file">
        <label class="respond-consent"><input type="checkbox">…</label>
        <img class="respond-preview">
      </div>
      <button class="respond-submit">发送</button>
      <p class="respond-error" hidden></p>
    </div>
    <p class="respond-done" hidden>已告诉 TA</p>
    <p class="respond-foot">你回的这些只会发给设置这个角落的人，不会公开。</p>
  </div>
</section>
```
| 选择器 / class | 用途 / 规则 |
|---|---|
| `.respond-block` | 区容器（顶部分隔线，与投票区分开） |
| `.respond-block .respond-actions` | **2 列网格**，gap 8px |
| `.respond-btn` | 动作按钮，min-height 44px；`data-action=measure\|photo\|disagree\|agree` |
| `.respond-btn[aria-pressed="true"]`（或 `.is-selected`） | 选中态：accent 浅底 + accent 描边 + 600 字重 |
| `.respond-btn svg` / `.respond-ic` | 内联 SVG 18px、stroke currentColor（不要用 emoji） |
| `.respond-form` | 展开表单；`[hidden]` 时 display:none |
| `.respond-note` / `.respond-name` | 单行输入，min-height 44px |
| `.respond-photo-fields` | photo 动作专属（文件 + consent + 预览） |
| `input.respond-file` | 原生 file input 显示成一行虚线框（base.css 默认 `display:none`，这里显式 `display:block`） |
| `.respond-consent` | 勾选行，min-height 44px |
| `.respond-preview` | 已选照片预览，最大 220×148、圆角 |
| `.respond-submit` | 主按钮，宽 100%、min-height 44px；`[disabled]` 时 45% 透明 |
| `.respond-error` | 红色错误句，12px |
| `.respond-done` | 「已告诉 TA」ok 色 + 圆点 |
| `.respond-foot` / `.respond-privacy` | 页脚隐私小字 11px ink-4 |

### 28.2 主人端「家人意见 / 家人回应」双段卡（`components.css`）
`.card.card-votes` 内保持原 `.vote-summary` / `.vote-list`，新增：
| 选择器 / class | 用途 |
|---|---|
| `.respond-section` | 第二段；顶部 `1px solid var(--line)` 分隔 |
| `.respond-section-title` | 「家人回应」12px/600 + 右侧最近更新时间 |
| `.respond-list` / `.respond-row` | 回应列表；行间 dashed 分隔 |
| `.vote-avatar` | 沿用投票头像圆点（30px） |
| `.respond-main` | 右侧主区；`padding-right:46px` 给相对时间留位 |
| `.respond-who` / `.respond-action` | 「名字 · 动作标签」；动作标签 19px 小 pill |
| `.respond-main > blockquote` | 留言：13px `--ink-2` + 左侧 2px 线 + 浅底 |
| `.respond-when` | 相对时间，absolute 右上，11px ink-4 |
| `.respond-photo` | 72×72 圆角 10px、`object-fit:cover`、`cursor:zoom-in` |
| `.respond-use` | 「设为改造后照片」ghost 按钮，40px 视觉 + 44px 热区（手机 `#feed` 内 44px） |
| `.respond-photo-viewer` | 家人照片大图 overlay（fixed inset 0、深色底、44px 关闭）；若复用 `#canvas-panel` 则不生效 |
| `.card-votes[data-only="responds"]` | 无投票只有回应；结构不变，只去掉第一段上间距 |

### 28.3 测量卡已提交反馈
| 选择器 / class | 用途 |
|---|---|
| `.measure-item.is-submitted` / `.is-done` / `[data-submitted="true"]` | 浅 ok 底 + ok 描边 + 输入框半透明白；`.m-head::after` 补「已记下」 |
| `.m-confirm` | 卡头/提交后的确认条：浅 ok 底、12px、前置圆点；文案如「已记下 1/2，填完下面这个就提交」 |

### 28.4 交付卡三数字（≤899px）
`.stat-triple` / `.handoff-stats` 两列；最后一个 `.stat` / `.handoff-stat` `grid-column: 1 / -1` 并补上边线，保证「3 | 6」一行、「3+6」独占一行且左对齐。

### 28.5 分享面板访问数
`.share-views`：分享面板里的「已访问 N 次」小字（11px ink-3 + accent 圆点），由 ui-logic 异步填 ShareView.viewCount。

### 28.6 V4.1 未读角标 / 状态行 / toast
| 选择器 / class | 用途 |
|---|---|
| `.respond-unread-chip` | 「家人回应」标题右侧未读胶囊：高 21px、圆角 999、accent-soft 底 + accent-ink 字、12px/600；`aria-label` 由 JS 给 |
| `.respond-section-title` | flex + gap 8 + align-items center；若有 `.mono`/`.respond-section-time` 则 `margin-left:auto` 靠右 |
| `.handoff-share-status` | 正文 `--ink-2`、前置 accent 圆点；`white-space:nowrap` + 省略号防 390 溢出 |
| `.handoff-share-status b / strong / .handoff-new / .handoff-unread` | 「N 条新」600 字重 + accent-ink；**JS 需把 N 条新包成 `b`/span 元素**，纯 textContent 无法局部加粗 |
| `.toast-respond`（或 `.toast.toast-respond`） | 深色胶囊 + 左侧 3px accent 竖条；复用通用 toast 时不用加 |

### 28.7 V4.2 系统通知开关 `.notify-toggle`
| 状态 / 选择器 | 规则 |
|---|---|
| `.notify-toggle` | 默认 ghost：min-height 44px、`border:1px solid var(--line)`、圆角 999、透明底、13px `--ink-2`；与上方状态行 `margin-top:10px` |
| `.notify-toggle.is-on` | 开启：`background:var(--accent-soft)`、`border-color:transparent`、`color:var(--accent-ink)` |
| `.notify-toggle[disabled]` | 不支持/已拒绝：`opacity:.55`、`cursor:not-allowed`，不再 hover 变色 |
| `.notify-dot` | 开启态前置 6px accent 圆点（在 `.notify-toggle` 内） |
| ≤899px | 按钮 `display:flex; width:100%`（全宽更稳），文案不换行、超出省略 |
| ≥900px | `inline-flex`，宽度随内容 |

## 29. V5 · 回访闭环样式（components.css 末尾）

契约见 `docs/CONTRACT-V5.md`。数据来自 `session.followups`（day 2/7）。

### 29.1 回访卡已记录态
| 选择器 / class | 用途 |
|---|---|
| `.card-followup[data-done="true"]` | 底色 `--paper-2`、边框 `--line`、无 hover 位移/阴影；`.card-head` 去渐变 |
| `.followup-answer` / `.followup-done-line` / `[data-done] .followup-title` | 「第 2 天 · 周末做」14px/600 `--ink` |
| `.followup-when` / `.followup-time` / `[data-done] .followup-sub` | 相对时间 12px `--ink-3` |
| `.followup-answer-row` | 答案 + 时间一行，时间 `margin-left:auto` |
| `.followup-edit` | 「可以改」：元素 44px（hit），`::before` 画 32px 胶囊视觉；ghost |

### 29.2 handoff「接下来 7 天」时间线
| 选择器 / class | 用途 |
|---|---|
| `.followup-timeline` | 横向 flex + `flex-wrap`（390 可换行）；`list-style:none` |
| `.followup-step`（`.is-pending` / `data-state=pending`） | 单步；未答灰色 `--ink-4`；自带 `.followup-dot` 时不重复画伪元素 |
| `.followup-dot` / `.followup-step::before` | 6px 圆点；已答 accent，未答 `--line-2` |
| `.followup-arrow` | 步骤间「›」，ink-4 |
| `.followup-step-note` | 展开的 note 11px ink-3 |

### 29.3 「要不要换个方向？」卡
| 选择器 / class | 用途 |
|---|---|
| `.card-followup-next` | 与回访卡间距 8px；纸卡底/边/圆角 |
| `.followup-next-title` / `.followup-next-sub` | 标题 14px/650 + 说明 12px ink-3 |
| `.followup-next-actions` / `.card-followup-next .followup-actions` | 竖排按钮组，主按钮 + 次按钮各全宽 44px |

### 29.4 回访选项 chips
≤899px `.followup-actions` 改为 2 列 grid，按钮各 44px、允许两行文案；≥900px 仍横向 wrap。
