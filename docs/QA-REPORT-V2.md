# 猫角落 Corner · V2 独立验收报告（QA-REPORT-V2）

> 验收方：verifier（独立于实现方；只测不改业务代码）
> 契约依据：`docs/CONTRACT-V2.md`（2026-10-24 02:5x 版，已正式纳入 `warn` 四态）+ `docs/CONTRACT.md`（V1 基线）+ `docs/PRODUCT-V2.md` + `docs/RESEARCH-CAT.md` / `docs/RESEARCH-PSYCH.md`
> **最终结论：PASS** —— V1 回归全绿；V2 新增字段/规则/交互/诚实性断言全绿；无 P0/P1 残留；2 条「建议项」与 1 条体验观察（不阻断）。
> 最终轮时间：**2026-10-24 02:53:03—03:03:33（Asia/Shanghai）**，全部代码最终冻结后（服务端 02:51；前端 02:55 由 Lead 完成 `CATFIT_STATUS.na`/`.status-na` 收尾后完全冻结）。
> 说明：API 侧（V1 `api-e2e`、V2 `api-e2e-v2`）在 02:53—02:55 服务端冻结版本上运行；UI 侧（`shot`/`v2-shots`）在 03:01—03:03 的「Lead 02:55 收尾版」前端上重跑，本报告所有截图/UI 数据均来自该最终版本。
> 本文件 UTF-8 无 BOM。

---

## 1. 最终轮校验记录

```
=== V2 FINAL RUN 2026-10-24 02:53:03 ===
node tests/dom-check.mjs   → exit 0  PASS (5 checks)
node tests/api-e2e.mjs     → exit 0  PASS (4/4 阶段, 38.8s)         ← V1 回归
node tests/shot.mjs        → exit 0  PASS (28 checks, 2 张截图)      ← V1 回归（02:53 版）
node tests/api-e2e-v2.mjs  → exit 0  PASS (6 阶段, 677 checks, 50.6s)
node tests/v2-shots.mjs    → exit 0  PASS (100 checks, 2 视口, 18 张截图)（02:55 前版）

=== FINAL POLISH RERUN 2026-10-24 03:01:35 ===（Lead 02:55 收尾后，UI 最终冻结版）
node tests/shot.mjs        → exit 0  PASS (28 checks, 2 张截图)      ← 03:01:35—03:02:30
node tests/v2-shots.mjs    → exit 0  PASS (100 checks, 2 视口, 18 张截图) ← 03:02:30—03:03:33
合计 02:53:03—03:03:33（服务端冻结 + 前端最终冻结后各跑一轮，全部 PASS）
```

| 检查 | 结果 | 关键数据 |
|---|---|---|
| V1 DOM 契约（41 ID / 资源 / 入口 / 错误兜底） | ✅ PASS | 41/41 ID；6 个引用资源存在；`window.onerror+unhandledrejection` 已接 banner |
| V1 API 端到端 A/B | ✅ PASS | 38.8s；A 20.6s（quality 4.25s/2460tok、l0 5.60s/4014tok、plan 5.29s/6959tok）、B 18.2s；`repaired 0/5`；measure 收敛 `measureDone=true` |
| V1 双端截图 + 导出/点选 | ✅ PASS | 1440×900 / 390×844 无横向滚动、无异常、无 console.error；`?demo=1` 到 L1：1440 23.4s / 390 22.9s；导出 PNG 2720×2292（3.9MB）+ download；点选后 feed 15 / card 10；planTabs=5 |
| V2 证据目录 | ✅ PASS（9 checks） | 29 条（≥25），id/claim/strength/kind/badge/strengthLabel/hasUrl 全合法；badge ∈ {研究支持,专家共识,经验值} 且与 kind/strengthLabel 自洽；27 条有 url；2 条 `hasUrl:false`（内部规则/证据缺口，诚实标注） |
| V2 A 正常流程（含区间） | ✅ PASS（236 checks, 19.2s） | quality 1.86s/2136tok、l0 5.29s/3983tok、plan 5.10s/6899tok、ask 1.78s/2754tok；catFit 6 项、NA 3 项、区间按保守端 55cm 判定 |
| V2 B 关键尺寸全缺 | ✅ PASS（223 checks, 18.5s） | 全 skipped、`measureDone=true`；plan `insufficient`、3 条关键约束 `unknown`、`usedMeasurements=[]` |
| V2 C 坏照片诚实性 | ✅ PASS（203 checks, 12.9s） | quality=retake(8) → L0 `insufficient` + 具体指认「使用流程说明页」→ plan `insufficient`「照片不合格，先重拍再定」；catFit 5×na |
| V2 D 前端文案禁用词 | ✅ PASS | 13 个前端文件（剔除注释后）命中 0 处 |
| V2 双端截图/交互 | ✅ PASS（100 checks） | 每视口 9 张：L0 推荐折叠 / 区间输入 / 5 tab / 依据 popover / 回访卡；5 tab 顺序固定；无 JS 报错；无横向滚动；最终冻结版重跑 1440 31.9s / 390 31.3s |

---

## 2. V1 回归结论（契约要求「V1 测试必须继续 PASS」）

- `tests/dom-check.mjs`：**PASS**（41/41 ID；index.html 21.6KB）。
- `tests/api-e2e.mjs`：**PASS 4/4**。本轮发现并修复两处 V2 引入的回归风险（见 §6 BUG-V2-2/BUG-V2-3），修复后通过。
  - A：`verdict=conditional`，constraints 四态（含 `warn`）校验；headline 已无「可换/可以放」类肯定语义。
  - B：全 skipped → `insufficient`、`unknown约束=3`、headline「还差…没量，先别定」。
- `tests/shot.mjs`：**PASS 28 checks**；`?demo=1` 双端均 21.9s/23.0s 到 L1；导出 PNG「2720×2292」；点选追问正常；`#dev-error-banner` 空。
- **V1 语义不变**：V2 只是在「经验阈值」场景新增 `warn`（契约 §2.2 四态），其余 V1 字段/结构/流程未变；V1 测试已按四态校验并继续覆盖原断言。

---

## 3. V2 新断言逐条（TRACE：契约条目 → 实测结果 → 证据）

| 契约条目 | 断言 | 实测结果 | 证据 |
|---|---|---|---|
| §1 证据目录 | `GET /api/evidence` ≥25 条；每条 id/claim/strength/kind/badge | ✅ 29 条；strength ∈ {consensus×18, moderate×3, weak×5, strong×3}；kind ∈ {guideline×17, study×7, consensus×3, experience×1, review×1} | `qa-e2e-v2-…18-54-36.json` |
| §1 证据徽章 | 徽章家族三选一 + strengthLabel/kind 自洽；≥20 条有 url | ✅ 研究支持×8 / 专家共识×20 / 经验值×1；`hasUrl` 与 url 一致；27 条有 url | 同上 |
| §2.3 L0 recognition | 非空且具体，不能是「一个角落」 | ✅「电视柜右侧墙角，地上已有灰色圆窝和一块猫抓板」（含位置+物件） | A_l0 |
| §2.3 L0 boundary | 非空、表达判断边界 | ✅「照片里没有墙角和地面，这一步看不出任何落点…」 | C_l0（最强） |
| §2.3 L0 env | 6 字段对象 | ✅ floorType/nearAppliance/nearFood/draft/sunlight/wallExterior 全枚举/布尔合法 | A_l0 |
| §2.8 recommend | directionId ∈ directions；why/alternativesNote；≥1 个 reuse 方向 | ✅ d1(reuse)，why「不花钱，只挪现有猫窝…」，alternativesNote 非空 | A_l0 |
| §2.12 进度口径 | measure 返回 totalTargets/attemptedTargets，单调合理，收敛时 measureDone=true | ✅ A：totals=[4,4,4]、attempted=[0,2,4]；B：全 skipped 后 attempted==total；`measureDone=true`；出题 2—3 轮 ≤3 | A/B_measure |
| §2.3 catFit | 恰好 6 项（key 固定）、status 五态、basisId 可查、strength 与目录一致 | ✅ 6/6；`hide=warn/respas=pass/litter=na/scratch=na/vertical=na/climate=pass` | A_plan.catFit |
| §2.3 catFit verdict | 确定性规则（fail→poor / keyUnknown→unknown / ≥2 warn→caution / ≥4 pass→good） | ✅ verdict=caution（pass=3<4、warn=1、fail=0、关键项非 unknown，重算一致） | A_plan.catFit |
| §2.3 **NA-RULE** | 方案不涉及的功能必须 `na`，不能 `pass` | ✅ 方案只有猫窝/复用 → litter/scratch/vertical 全 `na`（basisId=NA-RULE，why 写明「这次方案不涉及…」）；na 不计入 pass 数 | A/B_plan.catFit |
| §2.2 **PASSAGE_WIDTH** | 经验阈值类约束永不 fail，必须 honest:true | ✅ 区间 55cm < 60cm：`status=warn`（不是 fail）、`honest:true`、`estimate:true`、note「按 55cm 保守估算；经验阈值…不判不合格」 | A_plan.constraints |
| §2.2 **LITTER_BOX_COUNT** | 相关建议永不 fail | ✅ `litterCount.status=warn`、`honest:true`、文案「只是经验值，不是不合格判定」 | A_plan.litterCount |
| §2.2 依据 | constraints 每条有 basisId；区间按保守端 | ✅ corridorWidth→PASSAGE_WIDTH(weak/honest)、cornerWidthA/freeDepth→REST_SIZE_STRETCH(consensus/honest)；`actualCm=rangeCm[0]=55`、`valueCm=55`、`estimate:true`、note 含「保守估算」 | A_plan + session.measurements |
| §2.4 behavior | likelyUse/whyNot(0—3)/firstSign 可观察 | ✅「大概率…背靠墙睡」；whyNot 2 条机制；firstSign「三天内没有主动趴进去…」 | A_plan |
| §2.5 observe | 固定 1/3/7 天；第 3 天含「不算失败」 | ✅ 3 条；day3 首条「3 天内不用不算失败…」；day7「主动使用次数 ≥2 次」 | A_plan |
| §2.6 ifThen | ≥2 条；if 可观察事实 + then 单一动作 | ✅ 2—3 条；如「7 天内猫一次都没主动进去 → 把窝移到离电视柜更远的墙边」 | A_plan |
| §2.7 usedMeasurements | 只含用户实测项、值一致 | ✅ A 4 项（62/100/45/160…）、B 全 skipped 时为 `[]`；与 session.measurements 完全一致；UI 显示「这份方案用了你量的 4 个数」 | A/B_plan + UI |
| §3 信息架构 | 5 tab 固定顺序 标注→位置→尺寸条件→建议→清单 | ✅ 双端实测顺序一致（`plan-tabs` + `data-panel`） | v2-shots |
| §3.4 信任标注 | 每条 constraint/catFit 带依据徽章；点开见 claim/source/url/caveat | ✅ catFit 6/6 徽章、尺寸条件每条徽章；popover 显示「经验值 × 通道与通过性 / claim / van der Leij et al. 2019, PLoS ONE / 原文链接 / 适用边界」 | popover 截图 |
| §3.5 归属感 | 交付卡顶部「用了你量的 N 个数」 | ✅ A 显示 4 个数（走廊 62/墙角 A 100/进深 45/上方净空 160） | position 截图 |
| §2.9 猫档案 / §2.13 目标 chips | 可跳过、写回 profile、不阻塞 | ✅ `#goal-choices` 4 chips 渲染并写入「猫不进去」（demo 实测）；`#btn-cat-profile` 存在；payload profile 回写 `catSize=large/cats=1` | A 证据 + 截图 |
| §2.10 依据弹层 | `#basis-popover` role=dialog，数据只来自 /api/evidence | ✅ 打开后内容含 claim/source/caveat/url，与目录逐字一致 | popover 截图 + 断言 |
| §2.11 区间估计 | 支持 rangeCm；保守端；estimate 标记 | ✅ `.measure-range` 上下限输入；服务端按 55cm 保守端存 `valueMm=550`、`rangeCm=[55,65]`、`estimate:true` | measure-range 截图 + A 证据 |

---

## 4. 诚实性专项结论（V2 核心卖点）

### 4.1 `na` 没有变成虚假的绿色（强证据）
- A 场景方案只做「现有猫窝/复用」→ catFit 中 **litter=na、scratch=na、vertical=na**（basisId=NA-RULE，why 均写明「这次方案不涉及…」），**不是 pass**。
- 由于 pass 只有 3 项（hide/resources/climate），catFit verdict = **caution**（规则：pass<4 不给 good）——机制上无法因为「没发现问题」刷出绿色。
- 若方案含砂盆/抓板/爬架，对应项才会从 na 变为 pass/warn/fail（规则按品类判断，见 `rules.mjs computeCatFit`）。

### 4.2 坏照片：宁可说不知道（强证据）
- img4（流程图）→ quality `status=retake, score=8`；
- L0 仍给具体指认：「整张图是『猫角落改造助手』使用流程说明页，没有墙角或地面」+ 边界「照片里没有墙角和地面，这一步看不出任何落点，能不能放下要重拍并量过才算」→ `verdict=insufficient`；
- plan `verdict=insufficient`、headline「**照片不合格，先重拍再定**」、catFit 5×na + climate=unknown、usedMeasurements=[]；
- 全程无「重拍也先给个方向」的过度承诺。

### 4.3 关键尺寸缺失 → 不给结论（V1 断言延续）
- B 场景全 skipped：plan `insufficient`、3 条关键约束 `unknown`、headline「还差『通道净宽、墙角 A 边长』没量，先别定」；`usedMeasurements=[]`。

### 4.4 依据不能乱挂（针对「挂个引用装样子」）
- **PASSAGE_WIDTH**：claim 明确「60cm/18cm 不是研究结论」，产品把通道阈值降为 `warn`（不是 fail）、`honest:true`、强度「经验值」——与 RESEARCH-CAT `P-02` 一致，没有把无实证的阈值当硬判定。
- **REST_SIZE_STRETCH**：猫窝尺寸约束挂此依据（不是 HIDING_ENCLOSURE），`honest:true`；claim 自述「『猫窝必须比猫大 2 倍』没有出处，只能做宽松判断」，caveat 提醒唯一有实验的是砂盆 1.5 倍且猫窝不要套用——产品没有把 2 倍体长包装成研究结论。
- **LITTER_BOX_COUNT**：仅作 `warn` 软建议，文案「单猫建议 2 个…只是经验值，不是不合格判定」；caveat 明确 n+1 是历史经验法则、横断面甚至反向关联，不判 fail。
- **NA-RULE**：内部产品原则条目（`hasUrl:false`），用于防虚假绿色，来源写「产品原则（参见 UC-1/UC-2 与 RESEARCH-CAT §3）」——不是伪造文献。

### 4.5 前后端禁用词 / 绝对化承诺
- 前端 13 个文件（js/mjs/html/css/svg，剔除注释后）：`限时|仅剩|最后机会|错过|保证|一定能|研究表明|科学证明|帮你打造|赋能` **0 命中**（「不能保证放得下」这类诚实否定式与 CSS 注释被正确排除）。
- 后端返回 payload 全量扫描（why/claim/note/checks/if/then/headline）：无绝对化承诺（保证/一定能/绝对/100%/必然/肯定会/永远不会/科学证明/研究表明/限时/仅剩）。

### 4.6 headline 与 verdict 一致
- 新增断言（verdict≠ok 时 headline 不得含「可以放/可换/建议买/能放下」）在 V1 回归中被真实模型输出命中过一次（「墙角可换半包窝，先清走旧窝和抓板」），已由 ai-engine 修复为 `placeWords` 拦截；最终轮 V1/V2 全部通过（conditional→「墙角尺寸够放半包窝，先确认上方净空」、insufficient→「先量现有物品的外径和占地，再定复用」）。

---

## 5. 截图与交互验收（`tests/screens/v2/`，18 张，双端各 9 张）

每张均已人工目检（`read_image`），全绿：无破版、无文字截断、无横向滚动、无红条、无 `undefined`。

| 截图（1440 / 390 各一张） | 目检结论 |
|---|---|
| `v2-l0-recommend-*.png` | L0 卡片：具体指认句 + 边界句 + **只展开推荐的 1 个方向**（d1「推荐先试这个」+ why），其余 2 个方向折叠成一行（含 alternativesNote）；「你最想解决哪个？」4 chips |
| `v2-measure-range-*.png` | 测量卡「不确定，估个范围」切换成功：双输入框 + 「按保守的一端算…」提示；进度「已完成 1/5 · 还差 4 个数字」；右侧 dock 同口径 |
| `v2-tab-annotate/position/constraints/items/checklist-*.png` | 5 个 tab 顺序正确；位置 tab = 6 项 catFit（3 个「不涉及」灰态 + 各带依据徽章）+ 机制解释；尺寸条件每条带徽章与「经验阈值，不同猫会有差异」；清单含计划句/observe 1/3/7 天/if-then |
| `v2-basis-popover-*.png` | 点依据徽章弹出真实证据：标题「经验值 × 通道与通过性」+ claim + source（van der Leij et al. 2019, PLoS ONE）+ 可点原文链接 + 适用边界；非空壳引用 |
| `v2-followup-*.png` | `?followup=1` 渲染第 2 天/第 7 天两张轻回访卡（「今天做还是周末做？」/「用上了吗？」）；文案「不用也没关系，换个位置可能更合适」——不制造愧疚 |

交互断言（v2-shots，100 checks）另外覆盖：5 tab 顺序/panel、L0 expanded=1/collapsed=2、区间输入 2 框、catFit 6 项状态、popover `data-open=true` + 链接、计划句、observe=3、ifThen≥2、usedMeasurements 文案、回访卡 2 张、0 异常/0 console.error/无横向滚动。

> 说明：截图时 demo 完成 toast 仍停留（约 3s），会短暂覆盖交付卡底部/输入框上沿——这是**瞬时 toast**，不是布局缺陷（见 §6 OBS-V2-3）。

---

## 6. 缺陷表（发现 → 修复 → 复测闭环）

> 分级：P0 阻断 / P1 严重 / P2 体验。只记录实测可复现问题。

| ID | 级别 | 文件:行号（修复前） | 现象 / 复现 | 状态 |
|---|---|---|---|---|
| BUG-V2-1 | P2 | `app/server/evidence.mjs:41-49 badgeOf()` | 2 条证据 badge=「研究支持（弱）」，不在 `badgeLegend` / 契约 §3.4 三家族内（`SUNLIGHT_POSITION`、`SCRATCH-PLAY-PARADOX`）；`curl /api/evidence` 可复现 | ✅ **已修复**：`badge` 改为三家族 + 新增 `strengthLabel`/`badgeFull`/`hasUrl`；29 条全部自洽（Lead 修复，我复测） |
| BUG-V2-2 | **P1** | `app/server/rules.mjs:1302-1305`（conditional headline 分支） | plan verdict=conditional 但 headline「墙角可换半包窝，先清走旧窝和抓板」含「可换」；违反您定的「verdict≠ok 不得含肯定语义」→ **V1 回归直接 FAIL**；`node tests/api-e2e.mjs --only=A` 复现 | ✅ **已修复并复测**：conditional 分支复用 `placeWords`；最终轮 V1/V2 全绿（headline「墙角尺寸够放半包窝，先确认上方净空」） |
| BUG-V2-3 | P2 | `docs/CONTRACT-V2.md §2.2` vs `rules.mjs:1009-1014` | 实现会产出 `constraints[].status="warn"`，但契约枚举仍写 `pass|fail|unknown`；V1 严格枚举断言会因四态不一致而挂 | ✅ **已修复**：契约正式四态 + `warn` 语义写死；`tests/api-e2e.mjs` 改为四态并断言 `warn→honest:true`（报告注明「V2 契约扩展，V1 语义不变」）；V1 复测通过 |
| REC-V2-1 | **建议项（非缺陷）** | `rules.mjs:988-994`（checkFit）+ `REST_SIZE_STRETCH` | `freeDepth` 44cm vs 商品需要 45cm（差 1cm）用了硬 `fail`。**为什么算建议而不是缺陷**：休息点尺寸本来只有专家共识、没有「倍数」研究（claim 自述「只能做宽松判断」，caveat 明确「猫窝不要套用 2 倍体长」），用 1cm 级硬阈值会显得假精确；当前实现已用 `honest:true` 标注、UI 会显示「经验阈值，不同猫会有差异」，没有冒充研究结论，所以不构成诚信违规。复现：`node tests/api-e2e.mjs --only=A`（V1 冻结证据 `qa-e2e-…18-53-03.json` 的 A_plan constraints） | 🔭 **留给下一版的改进方向**：当依据为「宽松/经验」类且差距 <5cm 时降为 `warn`，或 note 注明「按商品尺寸差 1cm 判定，不是行为学结论」，让 expert-consensus+honest 类阈值统一不对 1cm 级差距下 fail |
| OBS-V2-2 | 建议项（非缺陷，文档） | `CONTRACT-V2.md §2.3` | catFit verdict 规则在契约里的书写顺序把「关键项 unknown → unknown」放在最后，与实现优先级（fail → keyUnknown → warn≥2 → pass≥4）不完全一致，易被误读 | 🔭 文档建议：按实现优先级重排一句 |
| OBS-V2-3 | 体验观察（非缺陷） | demo toast | 交付完成 toast（约 3s）在截图/交互瞬间会短暂覆盖卡片底部与输入框上沿 | ℹ️ 截图时机所致，非布局缺陷 |

**残留 P0/P1：0。**

---

## 7. 「这个产品的建议是否真的可核查」——3 条 basisId ↔ claim 人工核对（独立判断）

> 抽查方法：从最终轮真实 plan 里取 3 条挂 `basisId` 的建议，逐条读 `/api/evidence` 的 claim/source/caveat，判断「建议语义」与「依据语义」是否真相符，而不是只查 ID 是否存在。

### 核对 1：`freeDepth` 尺寸约束 ← `REST_SIZE_STRETCH`（V1 final plan，status=fail，44cm<45cm）
- 建议文案：`可用进深 ≥45cm · 实测 44cm · ❌`（fitNote「可用进深 44cm，小于需要的 45cm；需换进深 ≤44cm 的款」）。
- 依据 claim：「休息点要能让猫整个身体伸展开；『猫窝必须比猫大 2 倍』没有出处，只能做宽松判断。」
- 依据 caveat：「唯一有实验的倍数建议是砂盆 1.5 倍体长，且该倍数本身也是专家推荐值；猫窝不要套用。」
- **判断：语义相符，不是装样子**。依据确实支撑「休息点要留出伸展空间」，且产品明确标 `honest:true`、strength=专家共识，没有把「2 倍体长」当研究结论。**保留意见（建议项，非缺陷）**：claim 自己说「只能做宽松判断」，把它用于 44 vs 45 的 1cm 硬 fail 偏严（→ REC-V2-1，建议小差距降 warn）。

### 核对 2：catFit「抓挠位置」← `SCRATCH_POST_FORM`（V1 final plan，status=warn）
- 建议文案：「只有水平瓦楞板，缺竖直面，猫没法把身体整个拉长」。
- 依据 claim：「竖直的麻绳面能让猫把身子整个拉长，顺带在脚垫上留下自己的气味。」
- 依据 caveat：「横断面自报数据；『动线』需产品用照片推断，误判率可能高，宜给软提示。」
- **判断：完全相符**。why 直接复述依据机制（竖直面→拉长身体），且给了 warn 而非 fail，与 caveat「宜给软提示」一致。

### 核对 3：砂盆数量软建议 ← `LITTER_BOX_COUNT`（V1 final plan，status=warn）
- 建议文案：「单猫建议 2 个砂盆分两处；多猫按猫数+1（2 个）只是经验值，不是不合格判定。」
- 依据 claim：「只有一处厕所时，胆小的猫会排队等到憋不住，最后转去沙发角落。」
- 依据 caveat：「指南原文称 n+1 是历史经验法则、不是绝对要求；横断面数据甚至显示盆多与问题正相关（因果倒置），不可当硬规则。」
- **判断：语义相符且克制**。建议没有把「猫数+1」当硬性判定（与 caveat 完全一致），并主动标注「经验值」；这是「不装懂」的直接证据。

### 附加核对 4（通道阈值）：`corridorWidth` ← `PASSAGE_WIDTH`（A 场景，55cm → warn）
- 依据 claim：「缝太窄猫得侧身挤过去，它宁愿绕远路，久了这个位置就废了。」
- 依据 caveat：「『60 cm 通道』『18 cm 净宽』都不是研究结论；遇到窄缝应回答『无法判断』并建议观察。」
- 建议行为：55cm < 60cm 只给 `warn` + `honest:true` + note「经验阈值…不判不合格」，不改 fit、不阻断。
- **判断：相符，且是全产品最诚实的降级**——把最常见、最像「标准」的 60cm 明确降级为经验观察，没有用它判用户不合格。

**总体独立判断：证据可核查性成立，不是「挂个引用装样子」。** 29 条证据、27 条可点原文、badge 与 kind/strength 自洽；UI 的 claim/source/url/caveat 全部来自 `/api/evidence`，前端未写死依据文案；4 条抽查均语义对齐，且两条「无实证/经验法则」被主动降级（warn/honest）。**保留意见两点**：① `claim` 是「基于 source 的产品改写」而非原文摘录（抽查未见夸大，但建议在产品/文档中明示这一点，避免读者把改写句当论文原句）；② REST_SIZE_STRETCH 用于 1cm 硬 fail 的尺度问题（OBS-V2-1）。

---

## 8. 已知边界（刻意为之，不是缺陷）

1. **不接真实支付**：付费段是「演示解锁」模拟校验 0.1s（V1 契约 §9.4）。
2. **SKU 库 14 条**（SKU-001…014），演示用精简库，不是真实商品目录。
3. **不做像素反推厘米**：尺寸只来自用户输入/模型建议，`cm×10 → valueMm` 整数入库（`store.mjs toMm`），契约 §7 明令禁止。
4. **回访卡真实时间条件**：按 `planDeliveredAt` 天数（≥2 天/≥7 天）触发，最终验收用 `?followup=1` 强制显示两张卡；未等真实两天。生产逻辑已实现（`flow.js appendFollowups`），但「等 2 天自然触发」未实测。
5. **2 条证据无外部 url**：`NA-RULE`（产品原则）、`EVIDENCE-GAP-NOUSE`（证据缺口）为内部条目，`hasUrl:false`，弹层只显示 source 文本；这是刻意诚实标注，不是缺失。
6. **区间估算是用户手填百分比**：产品只负责按保守端计算与标注，不自动估计数值。

---

## 9. 遗留问题与未覆盖项

1. **真实移动设备未测**：390×844 为 CDP 真仿真（视口/DPR/布局真实），iOS Safari / 真机触控未验证。
2. **本地质检阈值**（过暗/模糊/太小）未用坏图逐项触发；`api-e2e` 的 metrics 由测试给中性值（真实指标由前端计算）。
3. **异常路径未自动化**：模型超时/SSE error 恢复、quality retake 的重拍循环（≤2 轮）、断网、并发会话。
4. **UI 明细交互**：`改一改`（就地改尺寸/换方向/点选重算）只做了 DOM 存在性 + 人工目检，未逐项点击断言；`#btn-cat-profile` 弹窗、L0「不对？点图重选」、`#btn-modify` 未自动化。
5. **回访卡真实 2/7 天时序**未等（用 `?followup=1`）。
6. **证据 claim 与原文的逐字核对**：29 条中抽查 4 条语义/来源/边界一致；未逐条打开原文 paper 核对。
7. **并发/性能**：单会话串行实测；未压测多会话并发、长会话。
8. **视觉回归**：截图靠人工目检，未接像素 diff 基线（`tests/screens/v2/*.png` 可作基线）。

---

## 10. 复现方式与证据文件

```powershell
cd D:\OneProject
node app/server/index.mjs                # 服务端（测试脚本也会自动 spawn + 轮询 /api/health）
node tests/dom-check.mjs                 # V1 DOM 契约        → PASS
node tests/api-e2e.mjs                   # V1 回归（A+B）      → PASS 4/4，约 39s
node tests/shot.mjs                      # V1 双端截图+导出/点选 → PASS 28 checks
node tests/api-e2e-v2.mjs                # V2 全量（EVIDENCE/A/B/C/D）→ PASS 677 checks，约 51s
node tests/v2-shots.mjs                  # V2 双端 5tab/popover/区间/回访截图 → PASS 100 checks
# 只跑部分：node tests/api-e2e-v2.mjs --only=EVIDENCE,A,C
```

| 证据文件（`.scratch/`） | 内容 |
|---|---|
| `qaV2-dom.log` / `qaV2-v1-e2e.log` / `qaV2-e2e.log` | API 侧最终轮原始输出（02:53—02:55，服务端冻结版） |
| `qaV2-v1-shot.log` / `qaV2-shots.log` | UI 侧首轮（02:53—02:59，含 02:55 前前端） |
| `qaV2-v1-shot2.log` / `qaV2-shots2.log` | **UI 侧最终冻结版重跑**（03:01:35—03:03:33，Lead 02:55 收尾版） |
| `qa-e2e-2026-10-23_18-53-03.json` | V1 最终回归（A/B payload、token、repaired、verdict 降级） |
| `qa-shot-2026-10-23_19-01-35.json` | **V1 双端截图最终冻结版**（导出 PNG 2720×2292、点选追问） |
| `qa-e2e-v2-2026-10-23_18-54-36.json` | **V2 最终全量**：证据目录快照、L0/env/recommend、measure 进度、plan（catFit/behavior/observe/ifThen/usedMeasurements/litterCount）、ask、文案扫描 |
| `qa-v2-shots-2026-10-23_19-02-30.json` | **V2 双端交互最终冻结版**：40 步/视口、9 张截图/视口、popover 真数据、回访卡 |
| `tests/screens/v2/*.png` | 18 张最终冻结版截图（双端 × 9 场景，03:02—03:03 重出） |
| `qa-evidence-v2.json` | `/api/evidence` 快照（29 条） |

---

## 11. 这次改造的证据链（「依据可核查」的唯一可审计路径）

V2 的「每条建议都能回答依据是什么」不是一句文案，而是一条可逐级追溯的链路；后续接手的人按这条链审即可：

```
docs/RESEARCH-CAT.md           30 条猫行为学证据（来源/强度/阈值/缺口，含 ID S-02、L-04、P-02…）
        │  （逐条标注 strength + kind + caveat）
        ▼
docs/RESEARCH-PSYCH.md         28 条决策心理学证据（含「不要做」清单：假稀缺/损失框架/假置信度…）
        │
        ▼
docs/PRODUCT-V2.md             把「证据 → 产品动作」合成：位置先于尺寸 / 依据可核查 / 不知道就说不知道；
                              明确哪些旧做法被降级（60cm 通道→warn、砂盆 n+1→软建议、选择过载叙事→不滥用）
        │
        ▼
app/server/data/evidence.json  → GET /api/evidence（29 条可查询目录：id/claim/strength/kind/source/url/threshold/caveat
                              + badge 家族 / strengthLabel / badgeFull / hasUrl）
        │
        ▼
app/server/rules.mjs          basisId 挂载点：catFit 6 项、constraints 每条、litterCount、behavior/observe/ifThen
                              （确定性规则按 basisId 取 strength/honest，UI 不写死依据文案）
        │
        ▼
app/public/js/cards.js        basis-badge（研究支持/专家共识/经验值）→ #basis-popover
app/public/js/app.js          popover 只从 /api/evidence 数据渲染 claim/source/url/caveat
        │
        ▼
用户可见                      徽章 + 依据弹层（claim / source / 可点 url / caveat / 「经验阈值，不同猫会有差异」）
```

**审计要点（本报告已验证的环节）**：
1. 目录条目字段齐全（29/29）、strength/kind 枚举合法、badge 与 kind/strengthLabel 自洽、27 条有可点 url（2 条内部条目 `hasUrl:false` 属刻意诚实标注）。
2. UI 徽章与 popover 数据逐字来自 `/api/evidence`（抽查 popover 的 claim/source/url/caveat 与目录一致），前端没有写死依据文案。
3. `basisId` 挂载正确：尺寸约束挂 `REST_SIZE_STRETCH`（不是行为学的 `HIDING_ENCLOSURE`）、通道挂 `PASSAGE_WIDTH`（诚实降级）、砂盆数量挂 `LITTER_BOX_COUNT`（仅软建议）、不涉及项挂 `NA-RULE`（防虚假绿色）。
4. 抽查 4 条建议的「建议语义 ↔ claim/caveat」均相符（§7），未发现「挂引用装样子」。
5. **建议下一版补的审计环节**：把 `claim` 明示为「基于 source 的产品改写」；建立 `evidence.json` 与两份 RESEARCH 文档的 ID 对照自动校验（例如 RESEARCH-CAT 行号 ↔ evidence id），防止未来改文案时依据漂移。

---

_本报告只记录真实实测结果；所有断言均可在冻结代码上复现。测试期间服务端重启导致的 `ECONNRESET` 已确认为测试环境中断（非产品缺陷），最终轮全程稳定。_
