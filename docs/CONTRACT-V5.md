# 猫角落 Corner · V5 契约（回访闭环：交付后 7 天，产品还在场）

> 现状（已确认是"假功能"）：
> `appendFollowups()` 会在交付 ≥2 天 / ≥7 天弹回访卡，但 `onAnswer` 只写 `state.session.followupAnswers`（内存），
> **不落库、刷新就丢、也不影响任何判断**。用户点完只看到一句 toast。
>
> 这一轮把它做成真闭环：**答了要记住 → 记住要改变后续建议 → 「方案不对」要能一键换方向**。
> 这直接对应目标里的"一次需求解决过程后，让用户感觉产品更强大"。

---

## 1. 数据模型（服务端）

`session.followups`（新增，数组，按下标顺序）：

```jsonc
[
  { "day": 2, "value": "weekend", "note": "", "at": "2026-10-25T09:00:00.000Z" },
  { "day": 7, "value": "not_yet",  "note": "猫只在上面睡，不进去", "at": "2026-10-30T09:00:00.000Z" }
]
```

合法值：

| day | value 允许值 | 含义 |
|---|---|---|
| 2 | `today` / `weekend` / `skipped` | 清单第一项什么时候做 / 暂时不做 |
| 7 | `used` / `not_yet` / `wrong` | 用上了 / 还没 / 方案不对（要换方向） |

同一 day 重复提交 → **覆盖**（不算新增），更新 `at`。

## 2. 接口

### 2.1 `POST /api/sessions/:id/followup`
```jsonc
{ "day": 2, "value": "today", "note": "先量一下再买" }   // note ≤40 字，可空
// → { ok: true, session }
```
- `day` 不是 2/7 → 400 `bad_day`
- `value` 不在允许集合 → 400 `bad_value`
- 会话没有 `planDeliveredAt` → 400 `not_delivered`
- 覆盖同 day：`followups` 保持按 day 升序

### 2.2 `GET /api/sessions/:id`
原样返回 `followups`（已有 session 接口自动带上）。

## 3. 前端行为

### 3.1 何时出卡（改 `appendFollowups`）
- 依据 `session.planDeliveredAt` 的天数差（服务器时区无关，用毫秒差 / 86400000）
- 规则：
  - `>= 2` 天且 day2 **未答** → 出第 2 天卡
  - `>= 7` 天且 day7 **未答** → 出第 7 天卡（第 2 天未答时先出第 2 天，答完后再出第 7 天）
  - `?followup=1` 强制：把两张卡都摆出来（已答的显示「已记录」态，不再可点）
- **已答过的天不再弹**（刷新、重放都不再出现未答态）

### 3.2 回答之后
1. `POST /followup` 落库 → 用返回的 `session` 覆盖 state（不要本地拼）
2. 卡片切成**已记录态**：`第 2 天 · 周末做` + 「可以改」小按钮；`at` 用相对时间
3. 若 `day7` 的 value 是 `not_yet` 或 `wrong`：
   - 追加一张 **「要不要换个方向？」** 卡（`.card-followup-next`）：
     - `wrong` → 「换一个方向重算」（主按钮）／「先不动」
     - `not_yet` → 「再等几天」／「换个方向重算」
   - 点「换一个方向重算」→ 走现有 `recalculatePlan` / 方向选择（不新增 AI 流程，复用「改一改」）
4. handoff 卡的「接下来 7 天怎么判断」区域显示**已记录的时间线**：
   `第 2 天 · 周末做 › 第 7 天 · 还没用上`
   - 未答的天显示 `第 2 天 · 待回访`（灰）
   - 时间线可点开看每条的 note

### 3.3 回访答案影响方案（诚实规则）
- `day7 = wrong` 时点「换一个方向重算」：**客户端显式切到另一个方向**（不与上次 `chosenDirectionId` 相同），确定性保证"不重复上次位置"
- 请求体带 `followupFeedback: 'wrong'`，服务端记到 `session.lastFeedback`（供后续 prompt 使用，本轮不改模型提示词）
- 不承诺"一定更好"，只承诺"不会推荐同一个"

## 4. 不做什么

- 不做定时推送/邮件（回访卡只在打开应用时出现）
- 不做评分/满意度调查
- 不因为"没答"而反复弹（每张卡一天最多出现一次，用 `localStorage` 记当天已展示）

## 5. 写入范围

| 角色 | 路径 |
|---|---|
| Lead | `app/server/index.mjs`（`/followup` 接口）、`docs/CONTRACT-V5.md` |
| ui-logic | `app/public/js/flow.js`、`cards.js`、`api.js` |
| ui-shell | `app/public/styles/components.css`（回访已记录态 / 时间线 / next 卡）、`docs/UI-CLASSES.md` |
| verifier | `tests/v5-followup.mjs`、`docs/QA-REPORT-V5.md` |

## 6. DoD

- [ ] `POST /followup` 落库、覆盖、校验（bad_day / bad_value / not_delivered）
- [ ] 刷新后回访卡状态与答案都在（不再回到未答）
- [ ] day7 = `wrong` → 出现「换一个方向重算」，点击后新方案的推荐方向 ≠ 上次
- [ ] handoff 时间线正确显示已答/待答
- [ ] `?followup=1` 强制展示两种状态（未答可点 / 已答已记录）
- [ ] 390/1440 无溢出、按钮 ≥44px、无 banner、无 JS 异常
- [ ] 既有回归全绿
