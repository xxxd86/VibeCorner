# 猫角落 Corner · V2 契约增补（证据驱动升级）

> 在 `docs/CONTRACT.md` 之上的**唯一增补**。V1 字段不删不改；本文件只做加法。
> 目的：把产品从「尺寸放不放得下」升级为「**这个位置猫会不会用** + 放不放得下」，并让每条建议带可核查的依据。

---

## 0. 新的产品 thesis（一句话）

> **猫用品买错的真正原因，通常不是尺寸不合适，而是位置违反了猫的行为需求。**
> 所以本产品做两件事：① 用行为学证据检查「位置对不对」；② 用尺寸检查「放不放得下」。
> 前者决定猫会不会用，后者决定买回来能不能装。

对应到交付：每条建议必须能回答「依据是什么」「如果猫不用，第一步改什么」。

---

## 1. 证据目录（服务器提供，前端可查）

`GET /api/evidence` → `{version, items:[Evidence]}`

```jsonc
// Evidence
{
  "id":"CAT-LITTER-SIZE",           // 稳定 ID，代码里引用，不翻译
  "topic":"猫砂盆尺寸",
  "claim":"砂盆太短，猫转身时容易把砂刨出来，也会憋着少用",  // 给用户看的人话（≤40 字）
  "strength":"strong|moderate|weak|consensus",              // 证据强度，必须真实
  "kind":"study|review|guideline|consensus|experience",     // 来源类型
  "source":"Ellis et al. 2013, JFMS",                        // 作者 年份 期刊
  "url":"https://...",                                      // 可点击原文
  "threshold":{"minMultipleOfBodyLength":1.5},              // 可选的量化阈值
  "caveat":"体长从鼻尖到尾根量；长毛猫按实际体积再放大一档"      // 不适用/需现场确认的情形
}
```

- 前端不得自己写死依据文案，一律通过 `basisId` 查目录（保证「依据」可被审阅、可被替换）。
- `strength` 必须在 UI 上可见（见 §3.4 信任标注）。

---

## 2. 新增字段

### 2.1 `session.profile`（扩展现有）
```jsonc
{"goal":"","budget":null,"keep":[],"cats":1,
 "catSize":"small|medium|large",     // 影响砂盆/通道/窝的尺寸判定，默认 medium
 "catAge":"kitten|adult|senior",     // senior 提高「低台阶、易进出」权重
 "multiCat":false,                   // true 时启用资源分散类规则
 "floorType":"wood|tile|carpet|unknown",
 "climate":"cold|mild|hot|unknown"}  // 影响保暖/日照相关建议权重
```

### 2.2 `plan.constraints[]`（每条加 3 个字段）
```jsonc
{"key":"corridorWidth","label":"通道净宽","op":">=","valueCm":60,"actualCm":62,
 "status":"pass|warn|fail|unknown", // V2 起正式四态：warn = 经验阈值未达/存疑，但不构成否决
 "note":"",
 "basisId":"CAT-PASSAGE-60",        // 新增：证据目录 ID
 "strength":"moderate",             // 新增：从证据目录复制，便于排序/标注
 "honest":true}                     // 新增：true 表示这是"经验阈值"而非研究终值，UI 要标出来
```
**`warn` 的语义（V2 正式加入）**：`warn` 表示「按经验阈值看偏紧/存疑，但没有可靠证据支持直接否决」。
- `PASSAGE_WIDTH`、`LITTER_BOX_COUNT` 这类只有专家共识/经验值的规则，**只能产出 `pass|warn|unknown`，永不 `fail`**，且必须 `honest:true`。
- 有指南/研究支持的位置类规则（如 `LITTER_NEAR_APPLIANCE`）可以 `fail`。
- UI 三态映射：`pass` ✅ / `warn` ⚠️（琥珀，与 unknown 同视觉重量）/ `unknown` ⚠️ / `fail` ❌。

### 2.3 `plan.catFit`（新增，替代原 `radar`，雷达图保留兼容但以后者为准）
按 AAFP/ISFM「环境需求」五支柱落地成 6 个可判定项（key 固定）：
`hide`（能藏的地方）、`resources`（资源是否分隔）、`litter`（砂盆条件）、`scratch`（抓挠位置）、`vertical`（垂直/高处）、`climate`（温度/日照/风）。

```jsonc
{"verdict":"good|caution|poor|unknown",
 "items":[{"key":"hide","label":"能藏的地方","status":"pass|warn|fail|unknown|na",
           "why":"猫窝如果只是敞开放在通道边，猫不会把它当藏身处",  // ≤40 字，说机制
           "basisId":"CAT-HIDE-01","strength":"strong"}]}
```
`verdict` 规则（确定性，由 `rules.mjs` 算，不由模型定）：任一项 `fail` → `poor`；≥2 项 `warn` → `caution`；全部 pass/warn 且至少 4 项 pass → `good`；关键项（hide/litter）`unknown` → `unknown`。
**`na`（不涉及）不计入任何分子分母**：本方案不放砂盆时 `litter.status="na"`，绝不能因为"没发现问题"就给 `pass`——那是虚假的绿色（依据 `NA-RULE`）。UI 用中性灰「不涉及」渲染。

### 2.4 `plan.behavior`（新增）—— 猫会怎么用
```jsonc
{"likelyUse":"大概率用来睡觉，不会用来磨爪",        // 一句预测
 "whyNot":["离食盆太近，猫通常不在进食区附近如厕"],  // 0—3 条"可能不用"的原因（带机制）
 "firstSign":"如果三天内没有主动趴进去，基本可以判断位置不对"}  // 一条判断信号
```

### 2.5 `plan.observe`（新增）—— 观察清单，替换原 `aftercare`
```jsonc
[{"day":1,"title":"第 1 天","checks":["把旧垫子放进去，别洗","看它是否愿意在新位置停留 10 秒以上"]},
 {"day":3,"title":"第 3 天","checks":["有没有留下压痕/毛发"]},
 {"day":7,"title":"第 7 天","checks":["主动使用次数 ≥2 次 → 保留；0 次 → 执行下面的 if-then"]}]
```

### 2.6 `plan.ifThen`（新增）—— 实施意图
```jsonc
[{"if":"7 天内猫一次都没主动进去","then":"把窝移到离食盆更远的墙边，位置不动 3 天再观察"}]
```
硬约束：`if` 必须是**可观察的事实**（次数/天数/现象），`then` 必须是**单一动作**；禁止「多观察」「注意」这类空动作。2—3 条。

### 2.7 `plan.usedMeasurements`（新增）—— 归属感
```jsonc
[{"key":"corridorWidth","label":"通道净宽","valueCm":62}]
```
UI 显示「这份方案用了你量的 3 个数」。只含 `source==="user"` 的项。

### 2.8 `l0.recommend`（新增）—— 减少决策过载
```jsonc
{"directionId":"d1","why":"这个位置同时满足藏身和观察，改动成本最低",
 "alternativesNote":"另外 2 个方向也可以，但都要先量同一组尺寸"}
```
- `directions` 仍是 1—3 个，但 L0 卡默认**只把 `recommend.directionId` 展开**，其余折叠成一行。
- L0 的 `verdict` 语义不变（continue / not_supported / insufficient）。

### 2.9 猫的情况（profile 的输入入口，新增 UI）
- `#btn-cat-profile`：`#composer` 里的一个小 chip，文案实时反映当前值（`猫：中型 · 1 只`）。点击打开 modal。
- `#cat-profile-form`：放在 `#modal-host` 内，4 组 `button[data-value][aria-pressed]`：
  体型 `catSize: small|medium|large`｜月龄 `catAge: kitten|adult|senior`｜几只猫 `cats: 1|2|3+`（`multiCat = cats>1`）｜地面 `floorType: wood|tile|carpet`
- 全部可跳过，默认 `medium / adult / 1 / unknown`。改动后写回 `session.profile`，后续 analyze 的 payload 带上 `profile`。
- **不阻塞主流程**：没填也能走完全程，只是 catFit 里依赖体型的项会落到 `unknown`。

### 2.10 依据弹层
`#basis-popover`（`index.html` 内，`role="dialog"`，默认 `data-open="false"`）：点徽章展开，内容是
`claim` + `source` + 可点 `url` + `caveat` + 一句强度说明。点外部或 Esc 关闭。数据只许来自 `/api/evidence`。

### 2.11 区间估计（降低放弃率，`AA-2` + 测量卡 #14）
测量卡支持"不确定就先估个区间"：
```jsonc
// 单点
{"key":"corridorWidth","valueCm":62,"source":"user"}
// 区间（用户选"约"模式）
{"key":"corridorWidth","valueCm":55,"rangeCm":[55,65],"estimate":true,"source":"user"}
```
- **服务端/规则一律按保守端计算**：`>=` 类约束取 `rangeCm[0]`，`<=` 类取 `rangeCm[1]`；`valueCm` 存保守端（兼容旧逻辑）。
- `constraints[].estimate === true` 时，UI 在依据徽章旁加小字「按 55cm 保守估算」。
- 区间不改变"未知/冲突"三态语义：算出来仍是 pass/warn/fail。

### 2.12 进度口径（起步赠进度，`PG-2`）
测量进度 = **照片（1 步，已完成）+ 目标尺寸（N 步）**。
- 展示 `已完成 1/3`、`还差 2 个数字`（不是 `0/2`）。
- 分母 `N` = `remainingKeys + 已 attempted 的 target 数`，由服务端 `measure` 返回的 `totalTargets` 提供（新增字段，见下）。
- 进度必须真实：没做的步骤不能算完成。

`measure` 阶段 `payload` 额外返回：`{"totalTargets":3,"attemptedTargets":1}`。

### 2.13 L0 先问一句（认知强制，`UC-4`，限制为一次点击）
`#goal-choices`（响应区域内，方向卡**之前**）：4 个 chip，单选，写回 `profile.primaryPain`：
`猫不进去` / `太乱占道` / `有味道` / `都还行`。点完才渲染方向卡（未点也可直接滚动，不阻塞）。
- payload 里带 `profile.primaryPain`；模型可据此调整推荐方向的排序。**只允许一次点击，不做问卷。**

---

## 3. 交付包的信息架构（UI 硬要求）

`planCard` 的 tabs 从 4 个变成 5 个，顺序固定（**尺寸条件必须在建议之前**，依据 `UC-1/UC-2`）：

| tab | 内容 | 心理学作用 |
|---|---|---|
| `标注` | 画布标注编号 + 落位说明 | 空间具体化 |
| `位置` | **新**：`catFit` 6 项 + `behavior.likelyUse/whyNot/firstSign` + 每条 `basisId`；底部保留 `radar` | 解释"为什么这个位置" |
| `尺寸条件` | `constraints`，每条带依据徽章；**未知项给出"再量 X（约 30 秒）"** | 信任校准；无知变行动 |
| `建议` | 商品/复用卡，`fit` 三态 | 决策收敛 |
| `清单` | `checklist`（第一条是**计划句**）+ `observe` 分天 + `ifThen` | 实施意图 |

### 3.4 信任标注（硬要求）
- 每条 constraint / catFit 项旁显示依据徽章：`研究支持`（strong/moderate+study/review）、`专家共识`（guideline/consensus）、`经验值`（experience/weak）。
- **禁止**显示假的精确置信度数字（如「置信度 87%」）。
- 点徽章展开：`claim` + `source` + `url` + `caveat`。
- `honest:true` 的阈值，文案写「经验阈值，不同猫会有差异」。

### 3.5 归属感（硬要求）
交付卡顶部一行：`这份方案用了你量的 3 个数：通道净宽 62cm、墙角 A 120cm、可用进深 48cm`。

---

## 4. 各角色写入范围（并行安全）

| 角色 | 写入路径 |
|---|---|
| Lead | `app/server/index.mjs`（`/api/evidence`、字段透传）、`docs/RESEARCH-*.md`→`docs/PRODUCT-V2.md`、`app/server/data/evidence.json`（合并两份研究） |
| ai-engine | `app/server/prompts.mjs`、`app/server/rules.mjs`、`app/server/data/skus.json`、`scripts/test-ai.mjs` |
| ui-logic | `app/public/js/**` |
| ui-shell | `app/public/index.html`、`app/public/styles/**` |
| verifier | `tests/**`、`docs/QA-REPORT-V2.md` |

字段名、key 名、tab 名一律不得改。新增字段必须由 `rules.mjs` 兜底补齐（模型没返回也不能空）。

---

## 5. V2 完成定义

- [ ] `GET /api/evidence` 返回 ≥20 条，每条有 `url` 与 `strength`
- [ ] `plan.catFit` 6 项齐全，`verdict` 由确定性规则算出（不是模型自评）
- [ ] 交付包 5 个 tab 齐全，「位置」tab 能解释「为什么这个位置/为什么可能不用」
- [ ] 每条尺寸条件都有依据徽章，点开能看 claim/source/caveat
- [ ] `ifThen` ≥2 条且都满足「可观察事实 + 单一动作」
- [ ] 交付包显示「用了你量的 N 个数」
- [ ] L0 只展开推荐的 1 个方向，其余折叠
- [ ] 现有 V1 验收（`tests/api-e2e.mjs`、`dom-check.mjs`、`shot.mjs`）全部继续 PASS
