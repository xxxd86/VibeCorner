# 猫角落 Corner · V4.2 契约（系统通知：让产品来找你）

> 目标：V4.1 让「回应」变成回执事件，但**只有你打开应用才看得到**。
> 这一轮补最后一环：家人回应/投票时，如果应用在后台，就发**系统通知**——点一下直接回到那张卡。
> 同时明确边界：不骚扰、不自动弹权限、iOS 不支持就诚实降级。

---

## 1. 入口与授权

- 入口两个（任选其一实现，推荐 A）：
  - A. 交付卡 `.card-handoff` 的状态行下方：`[家人回应时提醒我]` 小按钮（44px 热区）
  - B. 分享面板 `.share-sheet` 的链接行下方
- 文案三态：
  - 未授权且可申请 → `家人回应时提醒我`
  - 已授权 → `已开启提醒 · 点此关闭`
  - 不支持或已拒绝 → `浏览器不支持提醒`（禁用态，不可点）
- **绝不**在页面加载时自动 `requestPermission()`；必须用户点击。

## 2. 触发条件

发通知需同时满足：

1. `Notification.permission === 'granted'` 且用户开启开关（`localStorage['corner.notify'] !== '0'`）
2. `document.visibilityState === 'hidden'`（应用在后台）
3. 本轮 `refreshVotes` 发现**新增**投票或新增回应（复用 V4.1 的差量计算）

通知内容：

```text
标题: 猫角落 · 家人给了回应      （有新投票时：猫角落 · 家人给了意见）
正文: 与 toast 文案一致（家人拍了现场照 · 1 张 / 家人回应了你 · 我周末来量 / …）
tag:  corner-<sessionId>          （同 tag 覆盖，不堆叠）
icon: /icons/icon-192.png
```

点击通知：`window.focus()` → 滚到 `.card-votes` → `markVotesRead()`（已读清零）。

## 3. 节流与去重

- 同一条事件（respond `id` / vote 的 `at`+`name`）只通知一次（进程内 Set，最多记 100 条）。
- 30 秒内最多 1 条系统通知（合并为「家人给了 N 条新消息」也可）。
- 通知失败（iOS Safari 非 PWA、权限被撤）→ 静默 catch，**不影响**未读角标与 toast。

## 4. 关闭

- 再点一次按钮 → `localStorage['corner.notify'] = '0'`，按钮回「家人回应时提醒我」。
- 关闭后即使 `permission === 'granted'` 也不发通知。

## 5. 兼容与诚实降级

| 环境 | 行为 |
|---|---|
| Chrome / Edge / Android Chrome | 正常系统通知 |
| iOS Safari 非 PWA | `Notification` 可能不存在或静默失败 → 按钮显示「浏览器不支持提醒」或静默 catch，**不承诺** |
| iOS Safari 已「添加到主屏幕」 | 16.4+ 支持 web push，但本轮不做 push server；用 `new Notification()` 尝试，失败即静默 |
| 拒绝授权 | 按钮禁用，不再弹窗 |

README / docs 里要写清这条边界，不要宣称"手机上一定能收到通知"。

## 6. 写入范围

| 角色 | 路径 |
|---|---|
| ui-logic | `app/public/js/flow.js`、`app/public/js/cards.js`、`app/public/js/app.js` |
| ui-shell | `app/public/styles/components.css`（`.notify-toggle` 三态）、`docs/UI-CLASSES.md` |
| verifier | `tests/v4.2-notify.mjs`、`docs/QA-REPORT-V4.2.md` |

## 7. 实现状态（Lead 自测 14/14 PASS）

- 按钮三态（`.notify-toggle`）：`家人回应时提醒我` / `已开启提醒 · 点此关闭`（`.is-on`）/ `浏览器不支持提醒`（disabled）
- 仅在点击时调用 `requestPermission()`；开关存 `localStorage['corner.notify']`
- 后台（`visibilityState === 'hidden'`）+ 新回应 → `new Notification()` 恰好 1 次：
  `猫角落 · 家人给了回应` / body 与 toast 一致 / `tag=corner-<sessionId>` / `icon=/icons/icon-192.png`
- 同批数据不重复；30s 节流；关开关不发；点通知 → 聚焦 + 滚到 `.card-votes` + 已读清零
- 无 `Notification` → `getNotifyState()` 返回 `'unsupported'`，按钮禁用、无异常
- 自测脚本：`.scratch/v4.2-notify-verify.mjs`（14 项 PASS，含伪 Notification stub 与 hidden 模拟）

## 8. DoD

- [x] 按钮三态正确；不支持时禁用不弹窗
- [x] 模拟后台（CDP 设置 `document.hidden`/Page.setWebLifecycleState）+ 新回应 → `Notification` 构造被调用（可用 stub 断言）
- [x] 同一事件不重复通知；30s 节流生效
- [x] 点击通知 → 应用聚焦并滚到 `.card-votes`，未读清零
- [x] 关闭开关后不再通知
- [x] 权限被拒绝时无异常、toast/角标仍正常
- [x] 390/1440 无溢出、无 banner、无 JS 异常
