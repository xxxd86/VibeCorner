# 猫角落 Corner · AI 逻辑层说明（prompts / rules / SKU / 实测）

> 本文记录 AI 逻辑层的设计依据、实现要点与真实 API 实测数据。契约见 `docs/CONTRACT.md` / `docs/CONTRACT-V2.md`，本文不改变任何契约字段。
> 最后更新：2026-10-24 02:56（V2.1，deepseek-flash 实测）

## 1. 职责边界

| 文件 | 职责 | I/O |
|---|---|---|
| `app/server/prompts.mjs` | `buildRequest(stage, session)` 组 DeepSeek 请求；`normalize(stage, raw, session)` 结构补全 + 强校验 + 禁用词清洗 + 免责注入 | 只在 buildRequest 里读 `session.image.absPath` 的 jpg |
| `app/server/rules.mjs` | `MEASUREMENT_SPECS`（契约 §7 字典）、`SKUS`、`apply(stage, payload, session)` 确定性规则；cm→mm 换算 | 模块加载时读一次 `data/skus.json`，其余纯函数 |
| `app/server/data/skus.json` | 14 个电商风格猫用品 SKU（猫窝/猫抓板/猫砂盆/猫爬架），含 dimsCm/price/tags/materials/unknowns | 静态数据 |
| `scripts/test-ai.mjs` | 自包含真实 API 回归：3 张图跑 quality→l0→measure*→plan→ask + 关键尺寸缺失降级 + 规则单测，输出 PASS/FAIL 表 | 自带 fetch，读 `app/.env` |
| `scripts/preview-bboxes.py` | 把 `scripts/last-run.json` 的 bbox 画到原图，目检热区语义 | 诊断脚本 |
| `scripts/last-run.json` | 最近一次全量回归的逐阶段结果与最终 payload | 测试产物 |

服务端调用顺序固定为：`buildRequest` → 模型 → `JSON.parse` → `normalize` → `apply` → 落库 → SSE `final`。
两个模块都保证不抛错：`normalize` 有兜底结构，`apply` 捕获异常回退入参，最差情况服务端仍能返回可渲染结构。

## 2. 产品底线如何落到代码

| 底线（项目纲领） | 代码位置 |
|---|---|
| L0 只能给方向，禁止「可行/能放下/保证/推荐买」 | `SYSTEM_PROMPT` 第 1、5 条；`L0_ASSERTIONS` 正则清洗（带否定句 lookbehind，不会把「不能判断能不能放下」误改）；`test-ai.mjs` 的 `assertL0` 越级断言检查 |
| 未知就是未知，不许猜尺寸/像素反推 | `SYSTEM_PROMPT` 第 2、8 条；plan 缺关键尺寸一律 `insufficient`；`applyPlan` 用实测值重算 constraints，不信模型自报 pass |
| 关键尺寸缺失不能发布 L1 | `normalizePlan` 与 `applyPlan` 双层降级：`criticalUnknown` 非空 → `verdict=insufficient`，并写入 blocked / 现场补量清单 |
| 预算超限、遮挡保留物不能当没事 | `applyPlan`：`budget.status=over` → 最多 conditional + blocked；`profile.keep` 未被方案文本处理 → 注入 critical 清单 + 降级 |
| SKU 只能从库里取，库外不能编 | `normalizePlan` 校验 `SKU-*`，库外置 `fit=blocked`；`applyPlan` 直接丢弃库外新品并写 blocked；尺寸/价格/标题一律以库为准 |
| 每轮只问 1—2 项，量完能出方案 | `applyMeasure` 的收敛 target（见 §4.2），target 喝完返回空 questions，服务端因此置 `measureDone=true` |
| L1 免责文案固定 | `normalize` 对 l0/plan 强制覆盖 `disclaimer`（`L0_DISCLAIMER` / `L1_DISCLAIMER`） |

## 3. 提示词设计

### 3.1 公共 system prompt（8 条）

强约束、短句、全部可验证：只输出 JSON、禁止 markdown/多余字段、bbox 归一化语义、SKU 只能库内、关键尺寸缺失降级、禁用词、不确定写 unknown。每阶段再追加固定 JSON 结构（字面量，含枚举与字段类型），比「请参考以下 schema」更抗漂移。

### 3.2 各阶段要点

| 阶段 | temperature / maxTokens / thinking | 提示词要点 |
|---|---|---|
| quality | 0.1 / 1600 / enabled | 只判断能否用于空间判断；六类问题；block→retake；本地 `metrics`、`analysisNote` 只作辅助证据 |
| l0 | 0.25 / 2000 / disabled | 1—5 个 region（bbox 紧贴候选地面，面积 5%—30%）；1—3 个方向；firstMeasurements 必须含 `corridorWidth`；只允许「有条件继续/当前条件不支持/信息不足」；附完整测量字典 |
| measure | 0.2 / 600 / disabled | 每轮 1—2 题；优先 firstMeasurements，再 `corridorWidth→cornerWidthA→freeDepth`；写清端点/单位/为什么/怎么量/示例；target 齐了返回空数组 |
| plan | 0.2 / 6000 / **disabled**（见 §5.2） | 锁定 chosenDirectionId；关键尺寸只认 3 个；verdict 判定顺序；SKU 库全量注入；预算/保留物/清单/雷达/免责；输出体积上限（items≤4、annotations≤3、checklist≤6、blocked≤4、constraints≤5、radar note≤12 字） |
| ask | 0.3 / 800 / disabled | 输入把最近点选转成「横向 X%、纵向 Y%（左/中/右）点了一下」+ 历史 picks；输出 `{reply, verdict, pieces, missing}`（Lead 约定）；没量关键尺寸时最多 conditional |

### 3.3 上下文注入

- 图片：`session.image.absPath` 读 jpg → `data:image/jpeg;base64,...` 放进 user content 的 `image_url`；读不到就不带图并提示模型保守判断。
- 会话上下文用压缩 JSON 注入：`goal`（用户自然语言诉求）、`budgetYuan`（含从 goal 解析「预算 300」的兜底）、`keep`、`cats`、`metrics`、`analysisNote`、quality、l0、已量尺寸（cm）、skipped、picks、chosenDirectionId 对应方向、plan 阶段附 SKU 全库 + 测量字典。
- `buildRequest` 额外返回 `response_format:{type:"json_object"}`，调用方可直接透传给 API（服务端未用也不影响，`normalize` 仍能剥围栏/截取 JSON）。

## 4. 确定性规则（rules.mjs）

### 4.1 测量字典与单位

`MEASUREMENT_SPECS` 严格对应契约 §7 的 9 个 key，额外字段只有 label/endpoints/why/hint/minCmV（`corridorWidth=60`）。入库统一 `valueMm`，展示 `valueCm` 一位小数；`cmToMm`/`mmToCm` 导出。禁止像素反推。

### 4.2 measure 收敛（P1 修复）

`target = FLOOR_REQUIRED_KEYS(corridorWidth, cornerWidthA, freeDepth) ∪ 当前方向 firstMeasurements ∪ l0.missing`（chosenDirectionId 优先，空则 directions[0]）。

- 只允许问 target 内、未 attempted（含 `skipped:true`）的 key；问范围外的题直接丢。
- `remainingKeys = target 中尚未 attempted 的 key`（含本轮问题），进度环分母单调收敛。
- target 全部 attempted → `{questions:[], remainingKeys:[], askNote:'关键尺寸已齐，可以出方案了'}`，服务端置 `measureDone=true`；`measureDone=true` 时直接返回空题。
- 实测：img1 3 轮（3→1→0）、img2 3 轮（4→2→0）、img3 3 轮（4→2→0），不再出现第 4/5 轮问 `obstructionH/ceilingFree` 的死循环。

### 4.3 plan 规则

1. **SKU 门禁**：新品 sku 不在库 → 丢弃 + blocked；库内则用库数据覆盖标题/尺寸/价格/tags。
2. **fit 判定**：`needW=min(w,d)`、`needD=max(w,d)`（按可旋转 90° 保守估算）；必须三项尺寸已知；通道 <60cm 阻断；可用宽/深不足阻断；猫爬架因「固定/承重未知」一律 blocked；窗台吸盘款地面方案不适用。
3. **constraints 全部重算**：corridorWidth≥60、cornerWidthA≥max(needW)、freeDepth≥max(needD)，actualCm 来自 session.measurements；未知→unknown。
4. **标注语义**：plan annotations 与 L0 regions 的重叠率 <0.5 时吸附到最匹配候选区，保证框落在墙角/家具/候选地面，而不是随便一框；无标注时用 L0 regions 兜底。
5. **清单**：关键尺寸 unknown → blocked + critical 补量项；编号与标注一一对应（AC08）；保留物未处理 → critical 清单；预算超 → blocked + 清单。
6. **verdict 双层**：
   - 压低：critical unknown→insufficient；全部商品 blocked→not_supported（纯复用且只是缺旧物尺寸→insufficient）；预算超/保留物未处理/重度遮挡→最多 conditional；照片 retake→insufficient。
   - 可交付下限：三个关键约束全 pass + 至少一个 `fit=ok` + 预算不超 + 保留物已处理 + 照片合格 → 模型即使保守写 insufficient/not_supported，也抬到 **conditional**（绝不自动抬到 ok）。这是为了满足「L1 可在测量补齐后交付」，且所有前提都是确定性可验证的。
7. **headline 强制一致**：insufficient → 「还差「X」没量，先别定」/「照片不合格，先重拍再定」/「先量现有物品的外径…」；not_supported → 「先别放：可用进深只有 44cm，不够」；conditional 清掉「完全可以」等；ok 不能是否定式。
8. **blocked 商品 fitNote**：必须写清原因 + 什么条件下可行（如「还缺「可用进深」；补齐后按尺寸复算」「需换进深 ≤44cm 的款」），QA 可断言。

### 4.4 quality / l0 / ask

- quality：本地 metrics 直接注入问题（`brightness<45`→dark block、`sharpness<35`→blurry warn、`width<640`→small warn）；模型 block 问题 → 强制 retake + score≤55；scene 字段与 issues 保持一致。
- l0：照片 retake→insufficient；没有任何测量时方向 confidence 不能 high、region `ok` 降为 `conditional`；keep 未在 L0 文本中出现 → 补 `obstructionH` missing 并压低 confidence。
- ask：没量关键尺寸时 ok → conditional；照片 retake → insufficient；pieces/missing 空则给兜底文案。

## 5. 真实 API 实测

### 5.1 全量回归（3 张真实照片，27 次调用）

命令：`node scripts/test-ai.mjs`（Key 只从 `app/.env` 读，不打印）

| 阶段 | 耗时范围 | tokens（in+out，含 thinking） | JSON | 断言组 |
|---|---|---|---|---|
| quality | 3.77—5.22s | 2256—2484 | 3/3 ok | 3/3 PASS |
| l0 | 4.16—4.17s | 3058—3112 | 3/3 ok | 3/3 PASS |
| ask | 1.45—1.58s | 2502—2540 | 3/3 ok | 3/3 PASS |
| measure r1 | 1.68—2.19s | 2309—2369 | 3/3 ok | 3/3 PASS |
| measure r2 | 1.62—2.31s | 2323—2434 | 3/3 ok | 3/3 PASS |
| measure r3（收敛） | 0.77—1.54s | 2239—2273 | 3/3 ok | 3/3 PASS |
| plan（已量尺寸） | **3.98—4.57s** | 5263—5476 | 3/3 ok | 3/3 PASS，verdict 均 conditional |
| plan（关键尺寸缺失） | 3.82—4.22s | 5226—5317 | 3/3 ok | 3/3 PASS，verdict 均 insufficient |
| 规则单测（无模型） | — | — | — | 14/14 PASS |

**总计：41/41 断言组 PASS，27 次 API 调用全部 JSON 合法，累计 70.8s / 76708 tokens。**

关键尺寸缺失降级证据（3 张图一致）：

```
plan-missing: verdict=insufficient
  unknownConstraints = corridorWidth, cornerWidthA, freeDepth
  blocked 包含「关键尺寸「通道净宽」」等条目
```

bbox 目检：`scripts/bbox-img1.jpg`、`bbox-img2.jpg`、`bbox-img3.jpg`（L0 region 细框/plan 标注粗框叠在原图上）。3 张图的热区都落在墙角地面/猫窝/抓板位置，plan 标注与 L0 候选区一致，没有整图框或乱框。

### 5.2 plan 思考开关 A/B（同一张 img2、同一输入）

| 配置 | 耗时 | completion tokens（其中 reasoning） | JSON | verdict |
|---|---|---|---|---|
| `thinking:{type:'enabled'}` | 35.23s | 5997（5323） | **截断→非法** | — |
| `thinking:{type:'enabled', effort:'low'}` | 11.70s | 2142（1108） | ok | insufficient |
| `thinking:{type:'disabled'}` | **4.75s** | 1120（0） | ok | insufficient |

结论：plan 默认 **disabled**。思考会把 reasoning 顶到 5000+，既慢又容易把 JSON 挤断；关掉后 4—5s、输出仍含约束/阻断/清单，质量没有可观察退化。`maxTokens` 仍保留 6000 作为安全余量。需要更谨慎时调用方可覆盖为 `{type:'enabled', effort:'low'}`（`test-ai.mjs --plan-thinking=low` 可复现）。

## 6. 已知局限（诚实清单）

1. **照片不反推厘米**：所有尺寸来自用户实测；照片只用于判断位置、遮挡、方向、热区。这是产品底线，也意味着 L0 的所有「能不能放」都必须等测量。
2. **fit 是保守近似**：按可旋转 90° 用 `min(w,d)`/`max(w,d)` 估算，未按具体朝向/开门方向细化；没有臆造统一安全余量（项目纲领要求由审核后的规则表维护）。
3. **猫爬架一律阻断**：墙面固定方式与承重属于「关键未知」，MVP 阶段宁可 blocked 也不塞进现场确认清单。仅复用旧物且旧物尺寸未记录时给 insufficient，而不是硬编尺寸。
4. **模型保守 vs 规则兜底**：flash 在部分场景会因非关键未知（cornerWidthB、门开合等）自判 insufficient；规则只在「三个关键约束全 pass + 有 fit=ok 商品 + 预算/保留物/照片都过」时抬到 conditional，绝不自动给 ok，最终是否发布仍应由人工复核决定。
5. **bbox 语义靠提示词 + 吸附**：模型有时把框画在墙面上；rules 会把与 L0 候选区重叠不足 50% 的 plan 标注吸附到候选区。极端构图仍可能需要人工修正。
6. **单图、单角落、单猫**：多角度照片、多猫、高位/阳台/墙面方案不在 MVP 范围（与项目纲领的暂缓项一致）。
7. **SKU 是静态样例**：14 个 SKU 的价格/库存/可售性未接真实电商，`unknowns` 是现场确认项不是保证。
8. **图片以大图 base64 上传**：2730×1536 的 jpg 约 665KB base64，单次 vision prompt ~1700—2400 tokens；前端压到长边 1280 会更省，但测的是原图，结论按原图给出。
9. **API 偶发抖动**：测试脚本对 429/5xx 做了 3 次重试；服务端建议保留「截断/解析失败重跑」兜底（Lead 已实现）。
10. **ask 结构按 Lead 约定**：`{reply, verdict, pieces, missing}`，与 6.2 的卡片 schema 不同；前端若复用 L0 卡片渲染，需要单独适配（本次已按 Lead 明确要求返回该结构）。

## 7. 服务端集成要点（给 index.mjs）

- `buildRequest(stage, session)` 返回 `{messages, temperature, maxTokens, thinking, label, response_format}`；`label` 可直接作为 SSE `{"type":"stage","label"}`。
- 图片：调用前把落盘路径写到 `session.image.absPath`（或 `image.path` / `imageId` 对应 `app/data/uploads/<imageId>.jpg`），否则请求不带图、模型会保守输出。
- 方向锁定：`session.chosenDirectionId` 优先；为空退化 `l0.directions[0]`。measure 的收敛 target 与 plan 的提示都用它。
- 测量结束：`apply` 后若 `questions.length===0`，置 `session.measureDone=true` 并进入 plan；`measureDone` 也会让 measure 直接返回空题。
- 画布点选：`session.picks`（最多 8 条 `{nx,ny,note}`）会被转成「横向 X%、纵向 Y%、左/中/右」的中文描述；ask 只针对最新点选作答。
- `session.analysisNote`、`session.metrics` 会进入 quality 上下文；`profile.goal` 会进入 l0/plan 上下文，goal 里的「预算 300」也会被 `budgetFromGoal` 解析为预算上限。
- 免责文案由 `normalize` 强制覆盖，服务端不要二次改写；`DISCLAIMER_L0/L1` 常量与契约一致，可从 `prompts.mjs` 或 `rules.mjs` 导入。
- 规则层不做发布判定：`verdict=conditional` 仍应视为「有条件交付」，最终 L1 发布建议保留人工复核标记（项目纲领 F9）。

## 8. 复现命令

```powershell
# 全量：3 图 × quality/l0/ask/measure(收敛)/plan/plan-missing + 规则单测
node scripts/test-ai.mjs

# 只跑规则单测（不耗 token）
node scripts/test-ai.mjs --rules-only

# 单图快速迭代
node scripts/test-ai.mjs --images=img1 --quick --dump --no-save

# plan 思考开关对比
node scripts/test-ai.mjs --images=img2 --plan-thinking=disabled
node scripts/test-ai.mjs --images=img2 --plan-thinking=low

# bbox 目检（生成 scripts/bbox-img*.jpg）
python scripts/preview-bboxes.py
```

## 9. 后续可做

- 用真实用户照片扩充回归集（现在 3 张是概念图，背景干净、光线好）。
- 测量字典增加「门槛/踢脚线/暖气片」等现场项，规则表接入审核后的余量阈值。
- 给 plan 增加「复用优先」的确定性评分（0 元方案同权/优先展示）。
- ask 若前端复用 L0 卡片，可在 `normalize('ask')` 里并出 `region/direction`（当前按 Lead 约定保持轻结构）。

---

## 10. V2 / V2.1 证据驱动升级（2026-10-24）

依据：`docs/CONTRACT-V2.md`、`docs/RESEARCH-CAT.md`（27 条证据 + 23 条判定规则 + 8 条「不知道」）、`docs/RESEARCH-PSYCH.md`（28 条心理学证据 + 24 条设计动作 + 9 条拒绝清单）、`docs/PRODUCT-V2.md`。

### 10.1 证据挂载（rules 统一从 evidence.mjs 取，不手写依据）

- `rules.mjs` 只 import `{ compact }` 与 `{ measureTargetKeys }` 等方式使用证据；**所有 `basisText` = `compact(id).claim`**，strength/kind/badge 也来自目录。
- `plan.constraints[]` 每条新增：`basisId / strength / basisText / honest / estimate`。依据映射：
  - `corridorWidth` → `PASSAGE_WIDTH`（weak/experience，`honest:true`，永不 fail，<60cm 只 warn）；
  - `cornerWidthA` / `freeDepth` → 砂盆方案用 `LITTER_BOX_SIZE`，爬架方案用 `PERCH_SIZE`（honest），其余用 `HIDING_ENCLOSURE`；
  - 无商品时仍补齐三项 unknown 约束（含依据），避免模型不给 items 就丢失缺失信息。
- `plan.catFit.items[]`：6 项固定 key（hide/resources/litter/scratch/vertical/climate），每项 `{key,label,status,why,basisId,strength,basisText}`；`verdict` 确定性计算：任一 fail→poor；hide/litter unknown→unknown；warn≥2→caution；pass≥4→good；否则 caution。
- 关键依据选择：
  - hide → `HIDING_BOX_EFFECT`（强，半包/封闭窝）或 `HIDING_ENCLOSURE` / `HIDING_PLACE_COUNT`（开放式/多猫不足）；
  - resources → `LITTER_NEAR_FOOD`（食盆邻接） / `MULTICAT_SEPARATION`；
  - litter → `LITTER_NEAR_APPLIANCE`（可 fail） / `LITTER_BOX_SIZE`（按 catSize 体长估算：small 40 / medium 45 / large 50cm ×1.5 长、×1.2 宽，why 标注估算） / `LITTER_COVERED`（有盖只 warn） / 铲砂建议；
  - scratch → `SCRATCH_POST_LOCATION`（动线优先，塞墙角 warn） / `SCRATCH_POST_FORM`（只有水平瓦楞板 warn）；
  - vertical → `PERCH_SIZE` / `PERCH_CONCEALMENT`（爬架固定承重未知→warn，不 fail）；
  - climate → `DRAFT_AND_FLOOR`（瓷砖/穿堂风 warn） / `THERMAL_COMFORT` / `SUNLIGHT_POSITION`；照片看不出地面材质才 unknown。
- `plan.litterCount`：`LITTER_BOX_COUNT` 软建议（status 恒 warn，honest:true，n+1 绝不 fail）。
- `plan.usedMeasurements`：只取 `session.measurements[key].source==='user' && valueMm != null`，含 key/label/valueCm。

### 10.2 区间估计（CONTRACT-V2 §2.11）

- `measurementMap` 读取 `estimate:true` 与 `rangeCm`；缺失 valueMm 时按区间下界兜底。
- `constraintFor`：`>=` 取 `rangeCm[0]`、`<=` 取 `rangeCm[1]`；`constraints[].estimate=true`，note 写「按 55cm 保守估算」。PASSAGE_WIDTH 即使保守端低于 60cm 也只 warn。

### 10.3 L0 新增 `env` / `recommend` / `recognition` / `boundary`

- 提示词只允许模型写照片可见事实：floorType、nearAppliance（washer/fridge/speaker）、nearFood、draft、sunlight、wallExterior；看不出就 false/unknown。
- `recommend` 只推荐 1 个 directionId（非法 id 兜底到 directions[0]），why/alternativesNote ≤40 字；`profile.primaryPain` 进入上下文，供模型给推荐排序。
- `recognition`（≤30 字）必须指认具体位置/物件；缺失时用「房间+首个 region label」兜底。
- `boundary`（≤40 字）用专业边界口吻（「照片里看不出进深，这一步只能给方向，能不能放下要量过才算」），不写免责声明。
- rules 兜底：directions 里没有 `kit:"reuse"` 时，把 mix/最后一个方向改为 reuse 并补 `itemsPreview`，保证至少一个 0 元方向。

### 10.4 plan 新增行为与实施意图（V2 + 心理学）

- `behavior`：`likelyUse` 一句预测、`whyNot` 0—3 条机制原因（缺省取 catFit 的 warn/fail why）、`firstSign` 必须是可观察信号（正则校验，不合格由规则替换）。
- `observe`：固定第 1/3/7 天；第 1 天含开箱擦气味 + **二选一计划句**（今天做还是周末做）；第 3 天必含「3 天内不用不算失败」；第 7 天含「主动使用次数 ≥2 次」可操作判定。
- `ifThen`：2—3 条；`if` 必须是可观察事实（次数/天数/现象），`then` 必须是单一动作（正则拒绝「多观察/注意一下/再看看/同时/逗号」）；按 scratch/litter/hide/use 分类去重，规则兜底至少 2 条。
- `checklist[0]` 必须是**计划句**：时间 + 地点 + 一个可核对条件（如「周六上午去店里，先看「可用进深 ≥50cm」的半封闭猫窝」）；不满足时规则用首个 fit=ok 商品 + freeDepth 约束生成并置顶。
- 文案铁律写进 system prompt：收益框架、禁止恐吓/愧疚/损失框架/假精确置信度；禁用词新增 限时/仅剩/最后机会/错过/必须/一定能/等于/研究表明/科学证明/多陪玩就不会乱抓（`cleanText` 统一替换或删除）。

### 10.5 measure 真实进度（CONTRACT-V2 §2.12）

- 导出 `measureTargetKeys(session)` 复用于 normalize 与 rules。
- `measure` 返回新增 `totalTargets` / `attemptedTargets`：`remainingKeys = target 未 attempted`，三者守恒；`measureDone` 时 attempted=total。前端可显示「已完成 1/N · 还差 N-1 个数字」（照片算第 1 步由前端处理）。

### 10.6 V2.1 实测（3 张概念图 + 4 张真实家庭照片）

命令：`node scripts/test-ai.mjs`（plan thinking disabled，证据目录 29 条）；真实照片另跑 `.scratch/real-case-check.mjs`

| 阶段 | 耗时范围 | tokens | JSON | 断言 |
|---|---|---|---|---|
| quality | 2.19—7.69s | 2169—3034 | 3/3 ok | 3/3 PASS |
| l0（含 env/recognition/boundary/recommend） | 5.12—6.20s | 3951—4124 | 3/3 ok | 3/3 PASS |
| ask | 1.56—2.13s | 2595—2777 | 3/3 ok | 3/3 PASS |
| measure（收敛） | 0.73—2.42s | 2331—2544 | 3/3 ok | 3/3 PASS，进度 3/3—5/5 |
| plan（已量尺寸） | 6.04—7.35s | 7078—7245 | 3/3 ok | 3/3 PASS，均为 conditional |
| plan（关键尺寸缺失） | 5.46—6.45s | 6912—7156 | 3/3 ok | 3/3 PASS，均 insufficient |
| 规则单测 | — | — | — | 50/50 PASS |

**总计：78/78 断言组 PASS，28 次 API 调用全部 JSON 合法，88.5s / 95405 tokens。**

实测样例（img2，最终一轮）：

- `recognition`：「电视柜右侧墙角，现有灰色猫窝和方形抓板并排」
- `boundary`：「照片看不出墙角边长和通道净宽，这一步只能给方向，能不能放下要量过才算」
- `checklist[0]`：「周六上午去店里，先看可用进深≥40cm 的猫窝」（23 字，不截断）
- `catFit`：hide=pass、resources=pass、litter=**na**、scratch=warn、vertical=**na**、climate=pass → verdict `caution`
- `constraints`：通道净宽 pass（PASSAGE_WIDTH，honest:true）；墙角 A / 可用进深 pass（REST_SIZE_STRETCH，honest:true）
- `usedMeasurements`：通道净宽 62、墙角 A 80、墙角 B 70、可用进深 52

### 10.7 V2.1 语义修正（本轮）

- **`catFit.status` 新增 `na`（不涉及）**：方案不放砂盆/不含抓板/没有高位时，对应项 `na` + `NA-RULE` 依据，why 写「这次方案不涉及…」；`na` 不计入 pass/warn/fail，也不把 verdict 抬成 good。修复了「没检查的砂盆条件却显示绿色 pass」的虚假确定。
- **尺寸约束挂 `REST_SIZE_STRETCH`**：猫窝/休息点的 `cornerWidthA`/`freeDepth` 不再挂 HIDING_ENCLOSURE（那是「遮蔽程度」，语义不对），并标 `honest:true`（经验判断、非硬阈值）；砂盆方案仍挂 LITTER_BOX_SIZE、爬架挂 PERCH_SIZE、纯抓板方案挂 SCRATCH_POST_LOCATION。
- **计划句生成器**：`checklist[0]` 由规则生成或用模型版本；≤40 字、不得截断在数字/单位/型号中间，必须同时含时间词 + 动作 + 可核对条件；不合格时用「周六上午去店里，先看{尺寸条件}的{品类}」重建（不再截 SKU 型号）。
- **`ifThen` 与 na 对齐**：不涉及项的排查分支（如不放砂盆却出现「砂盆外出现尿块」）会被过滤；`then` 仍是单一动作。
- **conditional headline 严格一致**：条件句里出现「可以放/能放/可换/推荐」等肯定词时，必须同时出现「但/满足/才可/条件/若/如果」等条件词，否则替换成「满足下列条件才可放，先看尺寸条件」。`not_supported`/`insufficient` 仍走原有否定/缺失句。
- **`constraints[].status` 四态**：`pass|warn|fail|unknown`；PASSAGE_WIDTH、LITTER_BOX_COUNT 类只有共识/经验支持的规则永不 fail、必须 honest:true；有指南支持的（如 LITTER_NEAR_APPLIANCE）可以 fail。

### 10.8 V2 层已知局限（新增）

1. **catFit 是启发式评分**：litter/资源项依赖 L0 `env`（模型只看照片可见物）；照片里没有噪音家电≠现实中没有，`unknown/false` 只代表「照片看不出」。
2. **抓板动线靠照片+文案推断**：`SCRATCH_POST_LOCATION` 用区域标签/文案关键词判断是否在日常动线，误判率高于尺寸类规则，故最多给 warn/pass。
3. **猫爬架仍全部 blocked**（固定/承重未知），因此 `vertical` 项在含爬架的方案里通常是 warn/na，不会被判定为 fail。
4. **温度项只能给方向**：`THERMAL_COMFORT` 是生理参数（30—38℃），不是「猫最喜欢的室温」；没有真实室温输入时只按地面材质/日照/风给 pass/warn。
5. **区间估计保守端**会让结论偏保守（55—65cm 按 55cm 算），可能劝退；UI 需同屏说明「按 55cm 保守估算」。
6. **证据文案只来自 claim**：evidence.mjs 的 `compact()` 不返回 `rule` 字段，因此提示词摘要只含 claim+strength/kind（不自己读 evidence.json）。
7. **quality 有波动**：同图多轮中模型偶尔判 retake（如 img1 某轮 no_floor）；规则会诚实降级为 insufficient，不放行 L1，这属于预期行为而非 bug。
8. 其余 V1 局限（照片不反推厘米、可旋转 90° 保守估算、SKU 静态样例、单图单角落）继续有效。

### 10.9 V2 证据挂载规则（给后续接手的人）

这三条是「依据可核查」产品承诺的代码证据链，改动前先读：

1. **`basisId` 只能来自 `app/server/data/evidence.json`（当前 29 条）**，通过 `app/server/evidence.mjs` 的 `getEvidence / compact / allEvidence` 读取；`rules.mjs` 里**禁止手写依据文案**，`basisText` 一律取 `compact(id).claim`，`strength / kind / badge` 也随目录。新增依据只改 evidence.json，不改代码里的文案。
2. **永不 fail 的规则**：`PASSAGE_WIDTH`（60cm 通道，经验值，查无实证）与 `LITTER_BOX_COUNT`（n+1，原文自称经验法则）**只能 pass / warn / unknown，永不 fail，且必须 `honest:true`**；PASSAGE_WIDTH 低于 60cm 只给 warn + 「经验阈值，不同猫会有差异」。有指南支持的规则（如 `LITTER_NEAR_APPLIANCE` 洗衣机/冰箱邻接）可以 fail。
3. **尺寸类约束挂 `REST_SIZE_STRETCH`**（休息点要能完全舒展；「2 倍体长」查无出处，故 honest:true），不要挂 HIDING_ENCLOSURE；**`catFit` 的 `na`（不涉及）不得计入 pass 分子**，也不得把 verdict 抬成 good——没检查的东西不能算通过。

### 10.10 复现命令（V2 补充）

```powershell
node scripts/test-ai.mjs --rules-only   # 50 条规则单测，不耗 token
node scripts/test-ai.mjs                # 78 组断言 + 28 次真实 API
node scripts/test-ai.mjs --images=img2 --dump  # 看单图的 env/catFit/observe/ifThen 实际输出
node .scratch/real-case-check.mjs       # 4 张真实家庭照片（需 8848 服务端）
```

## 11. 真实照片场景规则（2026-10-24 追加）

真实家庭照片暴露的三个逻辑硬伤及对应代码位置：

1. **catFit fail 必须否决 plan（P1）**
   - `litter` / `resources` 等核心项出现 `fail` → `plan.verdict` 最高 `not_supported`（不再出现「可试放」）。
   - `headline` 以 **先别放：** 开头，优先用短阻断句（如「先别放：旁边是洗衣机，猫会不敢上厕所」）；`blocked` 增加 `位置否决：<catFit 项>`；清单插入「这个位置先别放」。
   - 例外：方案本身是**换位置方案**（headline/标注明确「移到/换到远离洗衣机/食盆的位置」）才允许 `conditional`，headline 写「换位置方案：别原地放，移到远离噪音或食盆的位置」。
   - 照片 retake 时按产品 F2 优先 `insufficient` 先重拍（即使 catFit 有 fail）；只有照片可用时才走「先别放」阻断。
2. **catFit 的 why 按方案品类生成（P2）**
   - 砂盆方案：`hide` = `na`（「这次方案是砂盆，不涉及休息点」），不再套猫窝的「开放式垫子」文案；猫窝方案才有 hide 判定；不涉及的抓板/高位同样 `na` + `NA-RULE`。
3. **尺寸阈值与遮挡（P2）**
   - 阈值只来自 `MEASUREMENT_SPECS` + `CAT_SIZE_BODY_CM` 体长倍数：砂盆 1.2×/1.5×、休息点 0.6×/1.0×、栖架 0.6×/1.0×、抓板 0.4×/0.8×；再与商品占地取大。`constraints[].why` 写明「medium 体长 45cm × 1.5 = 67.5cm；商品最大边 55cm，取大 67.5cm」。
   - 照片 `env.note` / `plan.annotations` 提示落点有杂物、衣架、纸箱、遮挡时，`freeDepth` 的 pass/fail 都不可靠 → 统一降为 `warn`，note 写「落点前有杂物，实际可用进深要清空后复测」。
   - 实测 4 张真实照片：washer / fridge 两例 `catFit.litter=fail` → `plan.verdict=not_supported`、headline 以先别放开头、blocked 含位置否决；砂盆方案 hide=na；所有尺寸约束 why 可追溯到体长倍数；遮挡场景 freeDepth=warn；retake 照片保持 insufficient（先重拍）。

