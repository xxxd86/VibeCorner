# 猫角落 Corner · V4.1 契约（家人回应的回执与未读）

> 目标：V4 让家人能「回应 + 传照片」，但**你不在页面时发生的回应不会通知你**。
> 这一轮把「回应」变成和「意见」同级的**回执事件**：来了就提示、有未读就显示、看过就清零、刷新还记得。
> 这是"一次需求解决之后你还会再打开它"的关键一环。

---

## 1. 数据（服务端已有，不改接口）

`GET /api/sessions/:id/votes` 已返回：

```jsonc
{
  "votes": [...], "counts": {"yes":0,"unsure":0,"no":0}, "voteCount": 2,
  "responds": [{ "id","action","label","note","name","at","photoUrl","mine" }],
  "respondCount": 2,
  "viewCount": 3,
  "expiresAt": "ISO"
}
```

前端只需分别维护 `voteCount` 与 `respondCount` 的**已读基线**。

## 2. 本地已读基线

| key | 值 | 说明 |
|---|---|---|
| `corner.votesRead.<sessionId>` | 已读时的 `voteCount` | 已有，保持 |
| `corner.respondsRead.<sessionId>` | 已读时的 `respondCount` | **新增** |

规则：
- 首次进入某会话且本地没有基线（`stored == null`）→ **不弹 toast**，只显示未读角标（和投票一致）。
- `stored != null` 或本轮已经拉过一次 → 出现新增就提示。

## 3. 回执（toast）

新增回应的提示文案（不刷屏：一轮只弹一次）：

| 情况 | 文案 |
|---|---|
| 1 条，带照片 | `家人拍了现场照 · 1 张` |
| 1 条，无照片 | `家人回应了你 · 我周末来量`（用 `label`） |
| 2 条及以上 | `家人给了 N 条回应` |

投票 toast 保持现有：`家人给了意见 · 支持 X · 犹豫 Y`。
两者同一轮都出现时，**合并成两条**（先投票后回应），不要挤在一起。

## 4. 未读展示

1. **卡内角标**：`.card-votes` 的「家人回应」段标题右侧出现 `.respond-unread-chip`，文案 `新 N`（N≥10 显示 `9+`），`aria-label="N 条新回应"`。
2. **交付卡状态行**（`.handoff-share-status`）：
   - `respondCount === 0` → `已分享 · 等待家人意见`
   - `> 0` 且有未读 → `家人已回应 N 条 · N 条新`
   - `> 0` 且无未读 → `家人已回应 N 条`
3. 未读**不阻断**任何操作；点击卡片任意位置也算已读。

## 5. 已读判定

沿用投票那套（`flow.js` 现有逻辑），扩展为两路：

- 卡片 ≥60% 进入视口（用户自己滚动过才算，程序化滚动不算）→ 已读
- 点击卡片 / 打开分享面板 / 点「设为改造后照片」→ 已读
- 已读后：`storeRespondsCount(session.id, respondCount)`，`respondUnread = 0`，重渲染卡与交付卡状态

## 6. 不做什么（避免过度设计）

- 不做系统级推送 / 微信通知 / 邮件
- 不做「已读回执」给对方（家里人不该看到"他看到没"）
- 不做红点堆叠到侧栏会话列表（下一轮再议）

## 7. 写入范围

| 角色 | 路径 |
|---|---|
| ui-logic | `app/public/js/flow.js`、`cards.js`（chip）、`app.js`（`updateHandoffStatus`） |
| ui-shell | `app/public/styles/components.css`（`.respond-unread-chip`、交付卡状态行「N 条新」强调） |
| verifier | `tests/**`、`docs/QA-REPORT-V4.1.md` |

## 8. DoD

- [ ] 页面开着时，家人新发一条回应（含照片）→ 3 秒内出现 toast（文案按 §3），卡内出现「新 1」
- [ ] 卡片滚入视口 ≥60% 后 → 角标消失、交付卡状态变「家人已回应 N 条」（不带"新"），刷新后仍不显示未读
- [ ] 刷新页面（有基线）→ 不弹 toast、无未读
- [ ] 首次打开（无基线）→ 不弹 toast、只有角标
- [ ] 投票与回应同时到达 → 两条 toast 内容正确、互不覆盖
- [ ] 390/1440 无溢出、无 banner、无 JS 异常；`tinyButtons` 仍为 0
