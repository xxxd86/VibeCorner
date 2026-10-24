# 猫角落 Corner · V4.2 独立验收报告（系统通知：让产品来找你）

> 验收方：verifier（独立于实现方；只写 `tests/**`、`docs/**`）
> 契约依据：`docs/CONTRACT-V4.2.md`
> **最终结论：PASS** —— 独立验收 2 个浏览器场景 / **64 checks 全部通过**；V4.1/V4/V3/V2 既有回归全绿。
> 本文件 UTF-8 无 BOM。

---

## 1. 验收环境与产物

| 项 | 内容 |
|---|---|
| 服务端 | `http://127.0.0.1:8848`，V4.2 前端（已冻结） |
| 验收脚本 | `tests/v4.2-notify.mjs`（独立编写；CDP 真仿真 + 注入 `FakeNotification` / `document.visibilityState` / `Date.now` stub） |
| 运行 | `2026-10-24 23:10:45`，runId `2026-10-24_15-10-45` |
| 结果 | **PASS**：notify-390 / notify-1440 两场景 / **64 checks** / failed=0 |
| 证据 | `.scratch/qa-v42-notify-2026-10-24_15-10-45.json`、`.scratch/qaV42-notify-run3.log` |
| 截图 | `docs/screens/26-notify-toggle-390.png`（.is-on）、`docs/screens/27-notify-toggle-1440.png`（.is-on） |
| 测试侧增强 | `tests/cdp-probe.mjs` 新增 `--init-script`（页面脚本前注入 stub），用于验证「加载时不自动请求权限」 |

> 说明：系统通知本身无法在无头浏览器里弹出真实 OS 通知；本验收用标准 `Notification` stub 断言**构造参数与调用次数**，并用 `visibilityState` 覆盖模拟后台。iOS/PWA 真机行为属契约已知边界，本轮未测。

---

## 2. 契约逐条验收

### 2.1 入口三态与权限（§1）

| 验收点 | 期望 | 实测 | 结果 |
|---|---|---|---|
| 默认态 | `家人回应时提醒我`、可点、无 `.is-on` | 一致；`getNotifyState()=off`、`localStorage['corner.notify']=null` | ✅ |
| **加载不自动请求权限** | `Notification.requestPermission` 调用数 = 0 | 页面加载后 **0**，无 Notification 构造 | ✅ |
| 点击开启 | 请求权限 1 次 → `已开启提醒 · 点此关闭`、`.is-on`、storage=1 | 请求 1 次；文案/class/storage 全对；state=`enabled` | ✅ |
| permission=denied | `浏览器不支持提醒`、disabled、不再请求权限 | 一致；点击 disabled 按钮 requestPermission 不增加 | ✅ |
| 无 `Notification` | `浏览器不支持提醒`、disabled、无异常 | 一致；state=`unsupported`，无 banner | ✅ |
| `getNotifyState()` | 与实现对齐 | `off` / `enabled` / `unsupported`（denied 归 unsupported）；见 OBS-V42-1 | ✅ |

### 2.2 触发与内容（§2）

| 验收点 | 实测 |
|---|---|
| 条件：permission=granted + 开关 on + `visibilityState=hidden` + 新回应 | 构造 **1 次** `Notification` |
| title / body | `猫角落 · 家人给了回应` / `家人拍了现场照 · 1 张`（与 toast 一致） |
| tag / icon | `corner-s_<sessionId>` / `/icons/icon-192.png` |
| 只有投票、无回应 | title `猫角落 · 家人给了意见`，body `家人给了意见 · 支持 1 · 犹豫 0` |
| 同时角标 | 卡内 `新 1` 仍正常出现 |

### 2.3 去重与节流（§3）

| 验收点 | 实测 |
|---|---|
| 同一批数据再次 `refreshVotes` | 通知数仍 1（不重复） |
| 30s 内新事件 | 第 2 条通知被节流（仍 1） |
| `Date.now + 31s` 后新事件 | 第 2 条通知构造，title/body/tag 正确 |

### 2.4 点击通知（§2）

| 验收点 | 实测 |
|---|---|
| 点击回调 | `.card-votes` 进入视口（top=432 < vh=844） |
| 未读清零 | 卡内 chip 清空；`corner.respondsRead.<sid>=3`（当时 count=3） |

### 2.5 关闭与降级（§4/§5）

| 验收点 | 实测 |
|---|---|
| 再点开关关闭 | storage=`0`、文案回默认、state=`off` |
| 关闭后新事件 | 即使 permission=granted + hidden 也不通知（数量不变） |
| 关闭后角标/toast | 仍正常（chip `新 1`） |
| denied / 无 Notification | 不通知、无异常、无 banner；chip 仍正常（`新 2`） |
| 390/1440 健康 | 无横向溢出、无 banner、无 JS 异常；1440 开关 is-on 尺寸 **163×44** |

---

## 3. 关键实测数字

```
390 初始：requestPermission=0，通知=0，state=off，按钮「家人回应时提醒我」
点击开启：requestPermission=1，storage=1，state=enabled，按钮「已开启提醒 · 点此关闭」
后台+照片回应：通知=1，title/body/tag/icon 全对
同批 refresh：通知=1（去重）
30s 内新事件：通知=1（节流）；Date.now+31s：通知=2
点通知：chip 清空，respondsRead=3，card top=432/vh=844
关闭后：通知仍=3（不再发）；chip 新1
只有投票：第 3 条通知 title=「猫角落 · 家人给了意见」
denied/无 Notification：state=unsupported、disabled、无异常
```

---

## 4. 观察项（不阻断 DoD）

| ID | 级别 | 观察 | 建议 / 负责 |
|---|---|---|---|
| OBS-V42-1 | 说明（命名） | `getNotifyState()` 实际返回 `off/enabled/unsupported`；契约表里写“已授权/已拒绝”，Lead 任务清单提到 `'denied'/'on'`。实现把 denied 归为 `unsupported`（UI 三态一致），属命名映射差异 | 建议契约/文档统一写 `off/enabled/unsupported`；实现无需改 |
| OBS-V42-2 | P3（节流取舍） | 30s 内被节流的事件不进入 `notifiedEventIds`，也不聚合到下一窗口；31s 后的通知只反映“当时那一条”。契约允许“最多 1 条/30s”，但会丢失中间事件的摘要 | 可选：窗口内合并为「家人给了 N 条新消息」；非本轮 DoD |
| OBS-V42-3 | 边界（未测） | 真机 iOS Safari / 非 PWA 的 Notification 支持、系统通知实际展示、点击后切回应用的真实聚焦行为，无头环境不可验 | 已知边界；按契约 §5 诚实降级，不宣称手机必达 |
| OBS-V42-4 | 说明（测试） | 验收使用 stub（FakeNotification/visibility/Date.now），非真实系统通知；stub 在页面脚本前注入，保证能断言“加载时 0 次权限请求” | 测试手段说明 |

---

## 5. DoD 对照（`docs/CONTRACT-V4.2.md` §7）

| DoD | 状态 | 证据 |
|---|---|---|
| 按钮三态正确；不支持时禁用不弹窗 | ✅ | 默认/已开启/不支持三态；disabled 时 requestPermission 不增 |
| 模拟后台 + 新回应 → `Notification` 构造被调用 | ✅ | 1 次，字段全对 |
| 同一事件不重复通知；30s 节流生效 | ✅ | 去重 1；31s 后 2 |
| 点击通知 → 应用聚焦并滚到 `.card-votes`，未读清零 | ✅ | top=432，chip 清空，respondsRead=3 |
| 关闭开关后不再通知 | ✅ | 通知数不变，chip 正常 |
| 权限被拒时无异常、toast/角标仍正常 | ✅ | denied/无 Notification 均无 banner/异常 |
| 390/1440 无溢出、无 banner、无 JS 异常 | ✅ | 两场景 diag |

---

## 6. 回归（同一冻结服务端/前端）

| 套件 | 结果 |
|---|---|
| `dom-check` | **PASS 5 checks** |
| `api-e2e-v2` | **PASS 6 阶段 689 checks（57.3s）** |
| `api-e2e-v3` | **PASS 13 阶段 220 checks（21.6s）** |
| `api-e2e-v4` | **PASS 9 阶段 80 checks** |
| `v4.1-receipt` | **PASS 3 场景 72 checks** |
| `v3-shots` | **PASS 6 场景 161 checks** |

---

## 7. 证据文件

| 文件 | 内容 |
|---|---|
| `tests/v4.2-notify.mjs` | V4.2 独立验收（2 场景 64 checks） |
| `tests/cdp-probe.mjs` | 新增 `--init-script`（stub 注入）；既有 `--profile`/`wheel` 步骤 |
| `.scratch/qa-v42-notify-2026-10-24_15-10-45.json` | 最终轮证据（stub 快照、通知字段、chip/基线） |
| `.scratch/qaV42-notify-run3.log` | 最终轮控制台输出 |
| `.scratch/qaV42-reg-*.log` | dom / v2 / v3 / v4 / v4.1 / v3-shots 回归输出 |
| `docs/screens/26-notify-toggle-390.png` | 390：`已开启提醒 · 点此关闭`（.is-on） |
| `docs/screens/27-notify-toggle-1440.png` | 1440：`.is-on` 开关（163×44）与已读基线 |

_本报告为 V4.2 最终版；结论 PASS（64 checks），未发现 P0/P1。_
