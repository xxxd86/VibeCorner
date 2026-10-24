# 猫角落 Corner · 独立验收报告（QA-REPORT）

> 验收方：verifier（独立于实现方；只测不改业务代码）
> 契约唯一事实来源：`docs/CONTRACT.md`（2026-10-24 02:10 版，§6.1 含 `chosenDirectionId/measureDone` 与各阶段 payload 约定）
> **最终结论：PASS —— 无残留 P0 / P1；P2 全部闭环；2 条低影响观察项在冻结版复测中已消除**
> 最终验收时间：**2026-10-24 02:20:40—02:22:05（Asia/Shanghai）**；冻结版本：前端 02:19、UI 02:13、AI 模块 02:07—02:10、服务端 02:09/02:14。
> 本文件为 **UTF-8 无 BOM**（已用 Node 字节校验：前 3 字节非 `EF BB BF`，无替换字符）。
> 所有命令、耗时、token、证据文件均可在本仓库复现。

---

## 0. 环境与测试资产

| 项 | 值 |
|---|---|
| 工作目录 | `D:\OneProject`（Windows / PowerShell） |
| Node | v20.20.1（零依赖，只用 `node:*`） |
| 浏览器 | Edge 155.0.4283.62（`--headless=new`）+ CDP |
| 服务 | `http://127.0.0.1:8848`（Lead 常驻后台 job；脚本检测到已监听即复用，不重复 spawn） |
| 引擎 | 真实 DeepSeek `deepseek-flash` 图文多模态（`hasKey:true / aiReady:true`，无 mock） |
| 测试照片 | `doc/猫角落改造助手 · 项目思路与执行纲领/图片和附件/img2_annotate.jpg`（2730×1536，515KB，上传后 527845B） |

测试脚本（全部零依赖，仅 `node:*`）：

| 文件 | 作用 | 复现命令 | 退出码 |
|---|---|---|---|
| `tests/dom-check.mjs` | 文本解析 `index.html`：契约第 4 节 41 个必存 ID、`<link>/<script src>` 真实存在、入口 module、错误兜底 | `node tests/dom-check.mjs` | 0/1/2 |
| `tests/api-e2e.mjs` | 真实 API + 自带 SSE 解析：quality→l0→measure(至收敛)→plan 全链路；图片/列表/删除/404；缺失尺寸 verdict 降级 | `node tests/api-e2e.mjs` | 0/1/3(依赖阻塞) |
| `tests/shot.mjs` | 无头 Edge 截图 1440×900 与真移动仿真 390×844（`?demo=1` 跑到 L1）+ 导出 PNG / 画布点选交互验证 | `node tests/shot.mjs` | 0/1/2 |
| `tests/cdp-probe.mjs` | CDP 诊断器：真移动视口（`Emulation.setDeviceMetricsOverride`）、`Page.captureScreenshot`、console/异常/失败请求/越界元素/`#dev-error-banner`、任意页面内脚本 | `node tests/cdp-probe.mjs --w=390 --h=844 --mobile=1` | 0/1 |
| `tests/page-checks.js` | 浏览器内交互脚本（cdp-probe `--script` 注入）：`exportPNG()` + PNG IHDR 宽高、导出按钮 download、画布点选→AI 追问 | 由 shot.mjs 调用 | — |

> **工具陷阱（已绕开，非产品缺陷）**：Chromium/Edge 无头窗口有最小宽度（约 500px），`--window-size=390,844 --screenshot` 实际是 **492px 布局裁成 390px 图**，会切掉右侧内容、误判“移动端破版”。本报告 390×844 截图全部用 CDP `Emulation.setDeviceMetricsOverride{width:390,height:844,deviceScaleFactor:1,mobile:true}` + `Page.captureScreenshot` 生成，实测 `innerWidth=390 && docScrollWidth=390`。

---

## 1. 最终轮校验记录（冻结版）

```
=== FINAL 2026-10-24 02:20:40 ===
node tests/dom-check.mjs   → exit 0   PASS (5 checks)
node tests/api-e2e.mjs     → exit 0   PASS (4/4 阶段, 30.5s)
node tests/shot.mjs        → exit 0   PASS (28 checks, 2 张截图)
node tests/cdp-probe.mjs … → exit 0   刷新恢复/回放诊断（无错误）
退出码汇总: dom=0 e2e=0 shot=0 replay=0   （02:22:05 结束）
```

| 检查 | 结果 | 关键数据 |
|---|---|---|
| DOM 契约（41 必存 ID / 静态资源 / 入口 / 错误兜底） | ✅ PASS | 41/41 ID；引用 6 个资源全部存在；`window.onerror+unhandledrejection` 已接 banner |
| API 端到端 A（正常流程） | ✅ PASS | 15.0s；measure 2 轮出题后 `measureDone=true`；plan `not_supported`（freeDepth 44<45，规则正确） |
| API 端到端 B（全 skipped 降级） | ✅ PASS | 15.5s；plan `insufficient`，3 条 constraints 全 `unknown` |
| 真实 DeepSeek 调用 / 无 mock / 无 JSON 自修复 | ✅ PASS | `repaired: 0/5`；每阶段 token 见 §2.4 |
| 双端截图 + 无 JS 报错 | ✅ PASS | 1440×900 / 390×844 均 `scrollWidth==innerWidth`；0 未捕获异常、0 console.error、banner 空 |
| DoD1 导出标注图 PNG | ✅ PASS | `exportPNG()` → **2720×2292** PNG（约 3.9MB）；按钮触发 download `corner-2026-10-24.png` |
| DoD2 画布点选→AI 追问 | ✅ PASS | 点选 (50%,55%) → feed 12→14、card 6→7，无报错 |
| 刷新后历史会话/回放 | ✅ PASS | 10 条列表、当前项 `aria-current=page`、chip「L1 · 可执行」、feed 7 / planTabs 4 恢复 |

---

## 2. 实测记录（按轮次）

### 2.1 Round 1 · 01:56 —— 依赖未交付（不计缺陷）

- `dom-check` exit 2：`app/public/index.html` 不存在。
- `api-e2e` exit 3 BLOCKED：`health.aiReady:false`（`prompts.mjs/rules.mjs` 缺失），`POST /api/analyze` 503。
- 不依赖 AI 的链路已全绿：`POST /api/sessions` 201、上传→`GET /api/image` 字节一致、`GET /api/sessions`、`DELETE → {ok:true}` → 404。
- 截图管线自证可用（当时 `/` 返回 404 JSON）。

### 2.2 Round 2 · 02:02—02:11 —— 发现 1×P1 + 3×P2，全部“发现→修复→复测”闭环

首轮 measure 实测不收敛（5 轮后仍出题、`measureDone=false`），据此定位根因并上报；owner 修复后逐轮复测（详见 §3 缺陷表）。其中 02:14 首次全绿：
`A 22.3s / B 16.7s / measure 2 轮出题后收敛 / repaired 0/5 / shot 27 checks PASS`。

### 2.3 Round 3 · 02:20:40—02:22:05 —— 冻结版最终轮（报告数据源）

#### A. `api-e2e` 场景 A（正常流程，session `s_8491d485cb0b`）

| 阶段 | 耗时（ttfb/total） | tokens（in/out） | repaired | 结论摘要 |
|---|---|---|---|---|
| quality | 0.00s / **2.15s** | 1951（1773/178） | false | `status=pass, score=82`，issues 0 |
| l0 | 0.01s / **5.38s** | 3167（2311/856） | false | `verdict=insufficient`，directions 3、regions 3、missing 3 |
| measure r1 | ~1.5s/轮 | — | — | 出题 `cornerWidthA + cornerWidthB`（remaining 4 项） |
| measure r2 | ~1.5s/轮 | — | — | 出题 `corridorWidth + freeDepth`（remaining 2 项） |
| measure r3 | ~1.5s/轮 | — | — | `questions:[]`、`remainingKeys:[]` → **收敛**，`measureDone=true` |
| plan | 0.00s / **3.31s** | 5048（4401/647） | false | `verdict=not_supported`，headline「先别放：可用进深只有 44cm，不够」 |
| 合计 | **15.0s** | — | — | 各阶段 schema / bbox / 禁用词 / measure key / verdict 降级断言全通过 |

- plan：annotations 1 / items 1（fit=blocked，fitNote 非空）/ constraints 3（freeDepth `fail`）/ checklist 5 / radar 5 / aftercare 2 天 / disclaimer「以交付时的尺寸条件为准，落地前请现场确认。」
- `/api/sessions/:id/answer` 冒烟：`outletDist 88cm → valueMm=880`；`skipped:true` 正确落库。
- 列表含该会话 → `DELETE {ok:true}` → GET 该 id **404** → 列表消失。

#### B. `api-e2e` 场景 B（关键尺寸全部 skipped，session `s_375bb4e4598e`）

- measure 2 轮出题（`cornerWidthA+corridorWidth` → `cornerWidthB+freeDepth`）+ 空轮收敛，`measureDone=true`，4 个 key 全部 `skipped:true`。
- plan：**`verdict=insufficient`**（≠ ok），constraints 3 条全 `unknown`，items fit=blocked 带 fitNote，headline 点明缺哪个尺寸。
- **产品底线通过**：关键尺寸缺失时不给 `ok`。

#### C. `shot`（真移动仿真 + 交互）

| 视口 | 到 L1 耗时 | 布局 | 渲染 | 交互证据 |
|---|---|---|---|---|
| 1440×900 | 21.4s（总 27.7s） | `innerWidth=1440, scrollWidth=1440`，无越界元素 | feed 12、card 6、planTabs 4 | 导出 PNG **2720×2292**（3.9MB）+ download `corner-2026-10-24.png`；点选 → feed 14 / card 7 |
| 390×844（CDP 仿真） | 21.4s（总 24.0s） | `innerWidth=390, scrollWidth=390`，无越界元素 | feed 12、card 6、planTabs 4 | 布局/抽屉/卡片目检 OK |

- 双双：`#app data-ready=1`、`#dev-error-banner` 空、0 未捕获异常、0 `console.error`；失败请求仅 5—6 条 `Fetch net::ERR_ABORTED` = **SSE final 后前端主动 abort，预期行为**。
- 会话列表实时刷新：截图时当前项=「客厅 · 墙角原位换半包式猫窝 / L1 已交付」。
- 刷新/回放（`cdp-probe` 重新打开 `/`）：chip「L1 · 可执行」、标题「客厅 · 墙角原位复用猫窝」、feed 7、planTabs 4、`.think` 7 均恢复，无 console.error/异常。

#### D. 客户端交互（浏览器内真实点击）

- `canvas.exportPNG()` → 合法 `data:image/png;base64`，PNG IHDR **2720×2292**，约 3,939,000B。
- 点击导出按钮 → hook `HTMLAnchorElement.click`：`{download:"corner-2026-10-24.png", isPng:true}`。
- 点选模式 → canvas `click(50%,55%)` → 30s 内 feed 12→14、card 6→7，最后一条用户消息「我想放在这里（横向 50% · 纵向 58% 的位置）」，无红条。

---

## 3. DoD 逐条结论（契约第 10 节）

| # | DoD 条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | 打开 8848 走完 上传→质检→L0→测量 2 轮→解锁→L1→导出 PNG | ✅ **通过** | `?demo=1` 真实跑完（21.4s 到 L1）；measure 正常流程 2 轮出题后收敛；导出 PNG 2720×2292 + download 均实测；`.scratch/qa-shot-2026-10-23_18-21-11.json` |
| 2 | 画布能看到 AI 热区、可点选位置并得到追问 | ✅ **通过** | 截图右侧画布 2 处编号热区 + `#canvas-legend` chips；CDP 点选后 AI 追问，feed/card 增加，无报错 |
| 3 | 全部请求走真实 DeepSeek（deepseek-flash 多模态），无 mock | ✅ **通过** | `health.model=deepseek-flash / hasKey / aiReady`；各阶段真实 token（quality 1951、l0 3167、plan 5048）；`repaired 0/5`；服务端 `deepseek.mjs` 实调 `api.deepseek.com` |
| 4 | 刷新页面后历史会话仍在（服务端落盘） | ✅ **通过** | 重开 `/`：10 条列表、当前项 `aria-current=page`、chip「L1 · 可执行」、标题+计划卡+思考折叠恢复；`app/data/sessions/*.json` + `app/data/uploads/*` |
| 5 | 无 JS 报错（`#dev-error-banner` 空）；1440×900 / 390×844 无破版 | ✅ **通过** | 双端：0 exceptions、0 console.error、banner 空、`scrollWidth==innerWidth`、无越界元素；`tests/screens/desktop-1440.png`、`tests/screens/mobile-390.png` 目检无破版/截断 |
| 6 | `docs/QA-REPORT.md` 记录实测截图与遗留问题 | ✅ 本文件 | 含命令/退出码/耗时/token、DoD 逐条、缺陷表、已知边界、遗留项 |

---

## 4. 缺陷表（附“发现→修复→复测”闭环）

> 分级：P0 阻断 / P1 严重 / P2 体验。只记录真实复现过的问题。

| ID | 级别 | 文件:行号（修复前） | 现象与复现 | 状态 |
|---|---|---|---|---|
| BUG-1 | **P1** | `app/server/rules.mjs:411-417`（补题池用全部 9 个字典 key）+ `app/server/index.mjs:201`（`measureDone = questions.length===0`）+ `app/server/prompts.mjs:516`（依赖 measureDone 才出空题） | measure 永不收敛：r1 `[cornerWidthA,cornerWidthB]` → r2 `[corridorWidth]` → r3 `[freeDepth]`（已齐）→ r4 `[obstructionH,ceilingFree]` → r5 `[outletDist,doorSwing]`，`measureDone` 恒 false，必须量完 9 个 key。违反契约 §6.1 与产品定义。复现：`node tests/api-e2e.mjs --only=A`（旧版），证据 `.scratch/qa-e2e-2026-10-23_18-03-07.json` | ✅ **已修复并复测**：补题池改为 `measureTargetKeys(session)`（方向 firstMeasurements + l0.missing + 3 个必需 key）；终轮实测 A 2 轮出题、B 2 轮出题即收敛到 `questions:[]`，`measureDone=true` |
| BUG-2 | P2 | `app/server/rules.mjs:435`（旧 remainingKeys） | 第 4/5 轮 `remainingKeys=[]` 但 `questions` 有 2 项，与契约 §6.2「remainingKeys 用于进度环分母」矛盾（进度环 0/0 仍出题） | ✅ **已修复**：`remainingKeys = targetKeys.filter(!attempted)`（含本轮）；前端 `app.js:250` `total=answered+remaining` 语义正确，进度 4→2→0 单调收敛 |
| BUG-3 | P2 | plan 规则段（verdict 降级处） | plan 降级时 headline 仍含肯定语义：`verdict=not_supported` 却写「墙角可换半包式猫窝，进深仅剩4cm…」，与阻断结论矛盾（契约 §1/§8） | ✅ **已修复**：终轮实测 `not_supported → 「先别放：可用进深只有 44cm，不够」`、`insufficient → 「还差…没量，先别定」`；新增断言（verdict≠ok 时 headline 禁「可以放/可换/建议买/能放下」、blocked 项须有 fitNote + 至少一条 fail/unknown 约束）通过 |
| BUG-4 | P2 | `app/public/js/app.js:336 refreshSessions()` | 会话推进到 L1 后，左栏当前项仍显示「新的角落 / 已上传」，刷新后才更新为标题/「L1 已交付」 | ✅ **已修复并复测**：终轮截图当前项=「客厅 · 墙角原位换半包式猫窝 / L1 已交付」 |
| OBS-1 | P2（观察） | `app/public/js/app.js:71` toast + `styles/screens.css` 定位 | 桌面/移动端 toast 与 composer 重叠，短暂遮挡输入框 | ✅ **冻结版已消除**：toast 抬到输入区上方（`tests/screens/mobile-390.png` 可见），仅与卡片底部短暂重叠（正常 toast 行为） |
| OBS-2 | P2（观察） | `app/public/js/cards.js:585-587` | 未设预算时显示「预算 未设 预估 ¥0」，语义易误解 | ✅ **冻结版已修复**：现在仅显示「预估 ¥178.9」（`tests/screens/desktop-1440.png`） |

**最终状态：P0 = 0；P1 = 0；P2 = 0 残留。** BUG-1～4 全部“发现→修复→复测通过”闭环；OBS-1/2 在冻结版复测中消除。

---

## 5. 已知边界（刻意为之，不是缺陷）

1. **不接真实支付**：付费段是「演示解锁」——`#btn-deliver` 弹「这一步只做演示解锁：不接支付，也不会扣款」→ 模拟校验 0.1s → 解锁 L1（契约 §9.4）。
2. **SKU 库只有 14 条**：`app/server/data/skus.json` 实测 **14 条**（SKU-001…SKU-014，猫窝/猫抓板/猫砂盆/猫爬架），是演示用精简库，不是真实商品目录。
3. **不做像素反推厘米**：尺寸只来自用户输入或模型建议，服务端一律 `cm ×10 → valueMm` 整数入库（`store.mjs toMm`），不存在从图片像素估算物理尺寸的路径（契约 §7 明确禁止）。

---

## 6. 遗留问题与未覆盖项（如实记录）

1. **真实移动设备未测**：390×844 为 CDP 设备仿真（视口/DPR/布局真实），非实体手机；iOS Safari 兼容性未验证。
2. **客户端本地质检阈值未构造坏图测试**：`image-utils.localIssues`（过暗 `<45`/模糊 `<35`/太小 `<640`）未被坏图触发；`api-e2e` 的 `metrics` 由测试给中性值（真实值由前端计算），因此“过暗/模糊阻断”分支未覆盖。
3. **失败/重试分支未覆盖**：模型超时、SSE `{"type":"error"}` 恢复、quality `retake`（≤2 轮重拍）、上传失败、断网等异常路径未自动化。
4. **UI 明细交互未逐项自动化**：plan 四个 tab 逐个切换、checklist 勾选、深浅主题切换、移动端抽屉展开/收起、隐私弹窗、删除会话 UI 仅做目检/DOM 存在性检查；导出 PNG 与画布点选已真实点击验证。
5. **导出 PNG 内容未做像素级断言**：已校验 dataURL 合法性、PNG IHDR 2720×2292、体积约 3.9MB、download 触发；未解码 PNG 逐像素核对标注框/图例（画布截图可作旁证）。
6. **并发/性能未压测**：单会话串行实测；未测多会话并发、超长会话、超大图片（>12MB 上限行为）。
7. **无视觉回归基线**：截图靠人工目检；后续可把 `tests/screens/*.png` 作为像素 diff 基线。
8. **报告口径**：`api-e2e` 测量答案使用测试内置样例值（`cornerWidthA=74` 等），plan 的 `ok/conditional/not_supported` 由规则与样例数值决定；本轮 A 因 `freeDepth=44 < 需求 45` 得 `not_supported`、B 因全 skipped 得 `insufficient`，均为规则正确工作。

---

## 7. 截图附录（冻结版，人工目检）

| 文件 | 时间/视口 | 目检结论 |
|---|---|---|
| `tests/screens/desktop-1440.png` | 02:21 / 1440×900 | 三栏正常：左栏当前项高亮「L1 已交付」；中栏 L1 计划卡（「L1 · 可执行」+「有条件可放」、标注/建议/尺寸条件/现场清单 tabs、两条标注、导出按钮、免责行、仅显示「预估 ¥178.9」）；右栏画布真实照片 + 编号热区 + `#canvas-legend` + dock；toast 在输入区上方。无破版/截断/横向滚动/红条 |
| `tests/screens/mobile-390.png` | 02:21 / 390×844（CDP 真仿真） | 单列正常：顶部 rail 条、标题+chip、计划卡完整、底部「空间画布 L1 · 2处标注」抽屉；无破版/截断/横向滚动/红条；toast 不再遮挡输入框 |

---

## 8. 复现方式与证据文件

```powershell
cd D:\OneProject
node app/server/index.mjs            # 服务端（若未运行；测试脚本也会自动 spawn + 轮询 /api/health）
node tests/dom-check.mjs             # → PASS exit 0
node tests/api-e2e.mjs               # → PASS 4/4 exit 0（约 30s，真实 DeepSeek）
node tests/api-e2e.mjs --only=A      # 只跑正常流程
node tests/shot.mjs                  # → PASS 28 checks exit 0（约 52s，含 ?demo=1 双端）
node tests/cdp-probe.mjs --w=390 --h=844 --mobile=1 --shot=.scratch/mobile.png
```

证据文件（`.scratch/`，均为真实输出）：

| 文件 | 内容 |
|---|---|
| `.scratch/qa-e2e-2026-10-23_18-20-41.json` | **最终冻结轮** A+B：每阶段 payload/meta/usage、measure 轮次、断言、server logs |
| `.scratch/qa-shot-2026-10-23_18-21-11.json` | **最终冻结轮** 双端截图/诊断/导出 PNG/点选结果 |
| `.scratch/qa-FINAL-replay.json` | 冻结版刷新恢复/回放诊断 |
| `.scratch/qa-FINAL-*.log` | 最终轮命令原始输出（dom/e2e/shot/replay） |
| `.scratch/qa-e2e-2026-10-23_18-03-07.json` | **P1 复现证据**（measure 5 轮不收敛、measureDone=false） |
| `.scratch/qa-e2e-2026-10-23_18-08-43.json` | P1 修复后首次全绿（含 A/B verdict 降级证据） |
| `.scratch/qa-cdp-390x844-*.json` | 移动端真仿真：`innerWidth=390 && docScrollW=390` |
| `.scratch/qa-e2e-*.json` / `.scratch/qa-shot-*.json` | 各轮中间证据（含被服务端重启打断的轮次，仅作过程记录） |

---

_本报告只记录真实实测结果。测试期间曾出现 3 次服务端主动重启导致的 `ECONNRESET/ECONNREFUSED`，已确认为测试环境中断、非产品缺陷；全部代码冻结后的最终轮（02:20:40—02:22:05）三项检查与回放诊断均通过。_

---

## 附：V2 契约扩展提示（2026-10-24 02:5x）

V2 在 `docs/CONTRACT-V2.md §2.2` 把 `plan.constraints[].status` 正式扩展为四态 `pass|warn|fail|unknown`
（`warn` = 经验阈值偏紧但无证据否决，只允许出现在 `PASSAGE_WIDTH`/`LITTER_BOX_COUNT` 等经验阈值类依据且必须 `honest:true`）。
V1 语义不变（后端只在经验阈值场景产出 `warn`）；`tests/api-e2e.mjs` 已按四态校验并继续覆盖原断言。
V2 的完整验收（证据目录、catFit、NA-RULE、区间估计、5-tab、回访卡、诚实性专项）见 `docs/QA-REPORT-V2.md`。
