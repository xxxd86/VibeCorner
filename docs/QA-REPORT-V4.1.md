# 猫角落 Corner · V4.1 独立验收报告（家人回应的回执与未读）

> 验收方：verifier（独立于实现方；只写 `tests/**`、`docs/**`）
> 契约依据：`docs/CONTRACT-V4.1.md`
> **最终结论：PASS** —— 独立验收 3 个浏览器场景 / **72 checks 全部通过**；V1/V2/V3/V4 既有回归全绿。
> 本文件 UTF-8 无 BOM。

---

## 1. 验收环境与产物

| 项 | 内容 |
|---|---|
| 服务端 | `http://127.0.0.1:8848`，V4.1 前端（ui-logic/ui-shell 已冻结） |
| 验收脚本 | `tests/v4.1-receipt.mjs`（独立编写，未复用 Lead 的 `.scratch/v4.1-receipt.mjs`） |
| 运行 | `2026-10-24 22:51:23`，runId `2026-10-24_14-51-23` |
| 结果 | **PASS**：3 场景（owner-390 / owner-390-reload / owner-1440）/ **72 checks** / failed=0 |
| 证据 | `.scratch/qa-v41-receipt-2026-10-24_14-51-23.json`、`.scratch/qaV41-receipt-run6.log` |
| 截图 | `docs/screens/24-receipt-toast-390.png`、`docs/screens/25-receipt-unread-1440.png` |
| 清理 | 只删本脚本创建的 session / share / respond 图片 |

> 测试方法：CDP 真仿真（390×844 / 1440×900）+ 页面内 `fetch` 注入家人回应，避免“轮询时间差”干扰；
> 用两个浏览器 profile：A 用于「已读基线 + 刷新持久化」，B 用于「首次无基线」。
> 因主人端打开的是「最近更新会话」，每次 CDP 前会 touch 本会话，确保打开的是被测会话（测试侧处理，不修改产品）。

---

## 2. 契约逐条验收

### 2.1 toast 三分支（§3）

| 情况 | 期望 | 实测 | 结果 |
|---|---|---|---|
| 1 条，带照片 | `家人拍了现场照 · 1 张` | `家人拍了现场照 · 1 张` | ✅ |
| 1 条，无照片 | `家人回应了你 · <label>` | `家人回应了你 · 我周末来量` | ✅ |
| 2 条及以上 | `家人给了 N 条回应` | `家人给了 2 条回应` / `家人给了 10 条回应` | ✅ |
| 投票 + 回应同轮 | 两条都出现、先投票后回应、不互相覆盖 | DOM 顺序：`家人给了意见 · 支持 1 · 犹豫 0` → `家人拍了现场照 · 1 张`（回应延后 450ms） | ✅ |

### 2.2 未读角标 / handoff 状态（§4）

| 情况 | 期望 | 实测 | 结果 |
|---|---|---|---|
| 卡内角标 | `.respond-unread-chip` 文本 `新 N`，`aria-label="N 条新回应"` | `新 1` / `1 条新回应` | ✅ |
| 未读 ≥10 | 文本 `新 9+`，aria 用完整数字 | `新 9+` / `10 条新回应` | ✅ |
| 交付卡 `respondCount=0` | `已分享 · 等待家人意见` | 一致 | ✅ |
| `respondCount>0` 且有未读 | `家人已回应 N 条 · N 条新` | `家人已回应 11 条 · 10 条新` | ✅ |
| `respondCount>0` 且无未读 | `家人已回应 N 条`（无“新”） | 一致 | ✅ |
| 未分享 | 状态行隐藏/空 | `statusHidden=true` 且文案空 | ✅ |

### 2.3 已读与基线（§2/§5）

| 情况 | 期望 | 实测 | 结果 |
|---|---|---|---|
| 未读时 | 基线不写入 | `corner.respondsRead.<sid>` = null、`corner.votesRead.<sid>` = null | ✅ |
| 点卡片已读 | 角标清零、状态行无“新”、基线=当时 count | `respondsRead=1`、`votesRead=0`、角标空、状态行「家人已回应 1 条」 | ✅ |
| 刷新（有基线） | 不再 toast、无未读、基线保留 | 无 toast、无角标、`respondsRead=1`、状态行不变 | ✅ |
| 首次无基线 | 不 toast，仅角标 | 无 toast、`新 1`、aria「1 条新回应」、基线仍空 | ✅ |
| 未读期间再收 10 条 | 基线保持旧值，不提前写入 | 基线仍 `1`；全部已读后写 `11` | ✅ |
| 缺失 `responds/respondCount` 老数据 | 不报错、按 0 处理 | 无异常、无 banner；恢复真实数据后卡片与状态行恢复 | ✅ |

### 2.4 健康与移动端（DoD）

| 项 | 实测 |
|---|---|
| 390 无横向溢出 / 无 banner / 无 JS 异常 | ✅（owner-390、owner-390-reload） |
| 1440 同上 | ✅（owner-1440） |
| `tinyButtons`（<40px） | 390 = **0**，1440 = **0** |

---

## 3. 关键实测数字

```
owner-390:        4.9s  — 照片 toast + 新1 + handoff·1条新 → 点击已读 → 基线 respondsRead=1 / votesRead=0
owner-390-reload: 3.4s  — 有基线刷新：无 toast、无角标、基线=1
owner-1440:      10.8s  — 首次无基线（新1 无 toast）→ 首读基线=1 → 再收 10 条（新 9+ / aria 10 条）
                          → 全部已读基线=11 → 投票+回应同轮双 toast（先投票后回应）
                          → 单条无照片 toast → 2 条 toast → 基线=15 → 老数据容错 OK
```

---

## 4. 观察项（不阻断 DoD）

| ID | 级别 | 观察 | 建议 / 负责 |
|---|---|---|---|
| OBS-V41-1 | 说明 | 同轮到达的两条 toast 依赖 `setTimeout(450ms)` 避免覆盖；测试在 1s 窗口内可稳定看到两条。若未来 toast 生命周期缩短，需同步调整延迟 | 保持 2.6s 生命周期即可；ui-logic（无需动作） |
| OBS-V41-2 | P3（测试可读性） | 已读后基线写入的是「当时拉取到的 count」，若拉取与点击之间有新回应，未读不会丢（下次仍会提示）——实现符合“最后已知”语义 | 无需改 |
| OBS-V41-3 | P3（截图方式） | 24/25 截图为了同时展示 toast/角标，测试临时把 `.card-votes` 钉在视口内再截图，随后恢复 DOM（页面逻辑未改）；截图内容为真实卡片与 toast | 仅证据说明，不影响验收 |
| OBS-V41-4 | 说明（回归口径） | V4.1 已读条件收紧为「用户滚动（wheel/touch/键盘）且卡片 ≥90% 可见」；程序化 `scrollTop` 不再清未读。V3 旧测试因此失败，已改为真实 `mouseWheel` 事件后 PASS | 契约行为变更，非产品回归；verifier 已更新测试 |

> 未发现 P0/P1；契约 §2-§5 的实现与 Lead 描述一致。

---

## 5. DoD 对照（`docs/CONTRACT-V4.1.md` §8）

| DoD | 状态 | 证据 |
|---|---|---|
| 页面开着时家人新发一条回应（含照片）→ 3 秒内 toast，卡内「新 1」 | ✅ | owner-390：toast 800ms 内出现、`新 1` |
| 卡片滚入视口/点击 → 角标消失、交付卡「家人已回应 N 条」（不带“新”），刷新后仍不显示未读 | ✅ | owner-390 + reload |
| 刷新页面（有基线）→ 不弹 toast、无未读 | ✅ | owner-390-reload |
| 首次打开（无基线）→ 不弹 toast、只有角标 | ✅ | owner-1440 firstNoBaseline |
| 投票与回应同时到达 → 两条 toast 内容正确、不互相覆盖 | ✅ | `["家人给了意见 · 支持 1 · 犹豫 0","家人拍了现场照 · 1 张"]` |
| 390/1440 无溢出、无 banner、无 JS 异常；tinyButtons=0 | ✅ | 三场景 diag + tinyButtons 计数 |

---

## 6. 回归（同一冻结服务端/前端）

| 套件 | 结果 |
|---|---|
| `dom-check` | **PASS 5 checks** |
| `api-e2e-v2` | **PASS 6 阶段 697 checks（57.7s）** |
| `api-e2e-v3` | **PASS 13 阶段 218 checks（21.5s）** |
| `api-e2e-v4` | **PASS 9 阶段 80 checks** |
| `v3-shots` | **PASS 161 checks / 6 场景**（已把 V3 的「未读清零」步骤从程序化 `scrollTop` 改为真实 wheel 用户滚动——V4.1 §5 明确「程序化滚动不算已读」，旧断言不再适用） |

> **回归口径变化（重要）**：V4.1 把「已读」条件收紧为「用户自己滚动过（wheel/touchmove/键盘）且卡片 ≥90% 可见」；V3 旧测试用 `feed.scrollTop=...` 程序化滚动，因此不再触发已读。这是**契约要求的行为变更，不是产品回归**；`tests/v3-shots.mjs` 已改为先程序化定位、再发送真实 `mouseWheel` 事件触发用户滚动，复测 PASS。

---

## 7. 证据文件

| 文件 | 内容 |
|---|---|
| `tests/v4.1-receipt.mjs` | V4.1 独立验收（3 场景 72 checks） |
| `.scratch/qa-v41-receipt-2026-10-24_14-51-23.json` | 最终轮证据（每步 value、截图、diag） |
| `.scratch/qaV41-receipt-run6.log` | 最终轮控制台输出 |
| `.scratch/qaV41-reg-*.log` | dom / v2 / v3 / v4 / v3-shots 回归输出 |
| `docs/screens/24-receipt-toast-390.png` | 390：照片回应 toast + 卡内「新 1」 |
| `docs/screens/25-receipt-unread-1440.png` | 1440：卡内「新 9+」+ 11 条回应 + 「家人给了 10 条回应」toast |

_本报告为 V4.1 最终版；结论 PASS（72 checks），未发现 P0/P1。_
