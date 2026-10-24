# 猫角落 Corner · V4 独立验收报告（家人回应：从表态到行动）

> 验收方：verifier（独立于实现方；只写 `tests/**`、`docs/QA-REPORT-V4.md`、`.scratch/qa-*`）
> 契约依据：`docs/CONTRACT-V4.md`（在 V1/V2/V3 之上仅做加法）
> **最终结论：PASS** —— API 段 9 阶段 / 80 checks PASS；UI 段 6 场景 / 110 checks PASS；既有 dom / V2 API / V3 API / V3 UI 回归 PASS。
> 2 条 soft 观察（note/name 长度口径、刷新后不保留已选态）+ 1 条已修复记录（超大 payload 413）。
> 本文件 UTF-8 无 BOM。

---

## 1. 验收环境与产物

| 项 | 内容 |
|---|---|
| 服务端 | `http://127.0.0.1:8848`，真实 DeepSeek `deepseek-flash`，V4 最终代码（前端冻结） |
| API 验收 | `tests/api-e2e-v4.mjs`（统一 lib 风格，9 阶段 80 checks） |
| UI 验收 | `tests/v4-shots.mjs`（CDP 真仿真，6 场景 110 checks） |
| API 运行 | `2026-10-24 22:12:47`，runId `2026-10-24_14-12-47`，**PASS** |
| UI 运行 | `2026-10-24 22:26:52`，runId `2026-10-24_14-26-52`，**PASS** |
| 证据 | `.scratch/qa-e2e-v4-2026-10-24_14-12-47.json`、`.scratch/qa-v4-shots-2026-10-24_14-26-52.json`、`qaV4-api-run8.log`、`qaV4-shots-run3.log` |
| 清理 | 只删本脚本创建的 session / share / respond 图片，未动其他会话 |

---

## 2. API 验收（`tests/api-e2e-v4.mjs`，9 阶段 80 checks）

| 阶段 | 结果 | checks | 关键断言 |
|---|---|---|---|
| 0 环境预检 | PASS | 3 | fixture 存在、服务端健康 |
| 1 准备已交付 plan 的会话 | PASS | 2 | 真实 AI 流程 quality→l0→measure→plan |
| 2 share + viewCount + ShareView 新字段 | PASS | 6 | responds 初始 []、respondCount=0、**每次 GET share 恰好 viewCount+1** |
| 3 4 种 action 计数/排序/匿名/覆盖 | PASS | 23 | 标签、ISO 时间、匿名「家人 N」、deviceId+action 覆盖、同 device 不同 action 计新票 |
| 4 校验与边界 | PASS | 12 | consent/缺图/未知 action/非法图/超大 payload 413/失败不污染计数/长度截断 |
| 5 photo 每次新增、最多 5 张 | PASS | 3 | 连续 6 次 photo 后保留 5 张，respondCount 一致 |
| 6 owner votes 扩展字段 | PASS | 6 | responds/respondCount/viewCount 与 ShareView 口径一致 |
| 7 after-from-respond | PASS | 17 | 复制而非引用、fromRespondId/fromFamilyName、重复调用 200、未知/非本分享 respondId → 400、被拒不改 afterImage |
| 8 撤销/过期 | PASS | 5 | respond 404/410、respond 照片 404/410 |

### 2.1 契约逐条覆盖

| 契约 | 验收点 | 结果 |
|---|---|---|
| §1.1 respond 4 action | `measure/photo/disagree/agree` 全部 200；中文标签「我周末来量 / 我拍了现场照 / 这个位置我不同意 / 就按这个来」 | ✅ |
| §1.1 consent | photo 无 `consent:true` → **400 `need_consent`**，不写入 | ✅ |
| §1.1 缺图/未知 action | 无 `photoDataUrl` → 400；未知 action → 400 `bad_action`；非法格式 → 400 `bad_image` | ✅ |
| §1.1 覆盖规则 | 同 deviceId+action 只保留最后一次；photo 每次新增、最多 5 张 | ✅ |
| §1.1 体积 | 超大 payload **干净 413**（Lead 修复 readBody：Content-Length 预检 → `req.resume()` + 413） | ✅ |
| §1.2 after-from-respond | 复制 respond 照片为新 upload（imageId 不同、字节相同）；fromRespondId/fromFamilyName 正确；重复调用 200 | ✅ |
| §1.2 respondId 归属 | 未知 → 400；**非本分享 → 400**，afterImage 不变 | ✅ |
| §1.3/§1.4 ShareView/owner | responds/respondCount/viewCount；photoUrl 可读；owner 侧缩略图 200 | ✅ |
| §1.5 图片路由 | respond 照片与上传缩略图逐字节一致（25,708B） | ✅ |
| §6 撤销/过期 | respond 404/410；照片 404/410（DoD 修订为 404 或 410） | ✅ |

### 2.2 关键实测数据
```
viewCount: 2 → 3（单次 GET 严格 +1）
responds: {measure:1, photo:1, disagree:1, agree:2}
photo 上限: 连续 6 次 → 保留 5 张，respondCount=10
after-from-respond: rs_xxx → 新 imageId（≠ respond 原图），bytes=25,708 一致
超大 payload: 413 {"code":"error","message":"请求体过大"}
```

---

## 3. UI / DOM 验收（`tests/v4-shots.mjs`，6 场景 110 checks）

### 3.1 家庭页 `/s/<token>`（390×844 + 1440）

| 验收点 | 实测 | 结果 |
|---|---|---|
| 「我能做什么」区 | 标题「我能做什么（选一个就行，不用登录）」+ 4 按钮 measure/photo/disagree/agree | ✅ |
| 4 按钮触控 | 高度全部 **44px**；390 为两行 2×2 网格；无横向溢出（rowOverflow=false/page=0） | ✅ |
| 底部隐私说明 | 「你回的这些只会发给设置这个角落的人，不会公开。」 | ✅ |
| **投票输入默认隐藏**（新规则） | 初始 2 个投票卡：`.vote-fields`/`.vote-submit` 均 hidden，`is-voting` 卡数=0 | ✅ |
| 点当前卡才展开 | 点第 1 张的「支持」→ 仅该卡 `is-voting`，fields/submit 仅该卡显示，另一卡仍 hidden | ✅ |
| 再点收回 | 再点同一「支持」→ `is-voting`=0，全部 fields hidden | ✅ |
| 回应表单 | 点「我拍了现场照」→ 表单展开、文件选择 + consent 可见；consent 默认未勾选 | ✅ |
| consent 禁用 | 选照片但未勾 consent → 发送按钮 **disabled**；勾选后 → enabled | ✅ |
| 发送后 | 显示「我拍了现场照 · 已告诉 TA」；按钮 `aria-pressed=true` + `is-selected`；表单收起；无溢出/无红条 | ✅ |
| 两表单互斥 | 打开回应表单时，投票输入全部收起 | ✅ |
| 刷新保留本人选择 | **未保留**（deviceId 已持久化，但 UI 未恢复已选态/已告诉）→ §4 OBS-V4-4 | ⚠️ WARN |

### 3.2 主人端 handoff 状态（三态）
| 状态 | 实测 |
|---|---|
| 未分享 | `.handoff-share-status` hidden 且文案为空（owner-pre） ✅ |
| 已分享、无人回应 | 「已分享 · 等待家人意见」（owner-wait） ✅ |
| 已有回应 | 「家人已回应 4 条」（注入 2 条 + 家人页发送 2 条后） ✅ |

### 3.3 主人端双段卡 + 设为改造后照片（1440 / 390）
| 验收点 | 实测 | 结果 |
|---|---|---|
| 双段结构 | `.card-votes` 头部 chip「家人意见」+ `.respond-section-title`「家人回应」；投票行与回应行同时存在 | ✅ |
| 回应行 | 文本回应 + 照片回应共 4 行（`.respond-row`），含匿名「家人 1/2」、室友、妈妈 | ✅ |
| 照片缩略图 | `.respond-photo` naturalWidth=72、渲染 **72×72**、complete | ✅ |
| 设为改造后照片 | `.respond-use`「设为改造后照片」**107×44（高 ≥44）**，390/1440 均达标 | ✅ |
| 点击后对比卡 | `.card-compare` 出现；改造后图片 URL `/api/image/<copy>`；`afterImage.fromRespondId` / `fromFamilyName="妈妈"` | ✅ |
| 用的是家人图 | after 图片字节 = 被点击回应的照片字节（25,708 = 25,708）；不是会话原图 | ✅ |
| 390 双段 | 回应段存在、4 行、3 张图 72×72、3 个 use 按钮 44px、无横向溢出 | ✅ |
| 无 JS 报错 | 所有场景 `#dev-error-banner` 空、无未捕获异常、无 console.error | ✅ |

### 3.4 截图（`docs/screens/`）
| 文件 | 内容 |
|---|---|
| `20-v4-share-390.png` | 家庭页 390：家人意见 + 「我能做什么」2×2 + 照片已选态 + 隐私说明 |
| `21-v4-owner-390.png` | 主人端 390：双段卡（家人意见 / 家人回应）、72×72 缩略图、设为改造后照片 |
| `22-v4-owner-1440.png` | 主人端 1440：双段卡完整视图（家人回应 4 条） |
| `23-v4-compare-1440.png` | 设为改造后照片后的对比卡 + toast「已用家人拍的照片做对比」 |

### 3.5 回归（V4 UI 改动后）
| 套件 | 结果 |
|---|---|
| `dom-check` | **PASS 5 checks** |
| `api-e2e-v2` | **PASS 6 阶段 680 checks（55.6s）** |
| `api-e2e-v3` | **PASS 13 阶段 218 checks（21.9s）** |
| `v3-shots`（V3 UI，补跑） | **PASS 161 checks / 6 场景**（V4 前端改动后 V3 UI 未被破坏；run `2026-10-24_14-28-01`） |

---

## 4. 观察项（soft，不阻断 DoD）

| ID | 级别 | 观察 | 建议 / 负责 |
|---|---|---|---|
| OBS-V4-1 | P2（契约/实现不一致） | 契约 §1.1 写 `note ≤40 字 / name ≤12 字`，服务端 `addRespond` 实际 `slice(0,60)` / `slice(0,16)`（超长请求 200 并截断到 60/16）；前端已按 40/12 截断，API 直连可绕过 | 服务端改 `slice(0,40)`/`slice(0,12)` 或超长 400；**负责：Lead（`app/server/store.mjs`）** |
| OBS-V4-2 | 已修复（记录闭环） | 超大 payload 原实现 `req.destroy()` → 客户端 ECONNRESET 或 400 `bad_action`（错误码误导）；Lead 修复为 Content-Length 预检 + 干净 413 | 已复测 PASS |
| OBS-V4-3 | P3（说明） | `after-from-respond` 重复调用会再复制一次（每次新 imageId、删除旧 after 文件）；幂等语义可接受，但前端重复点击会多写磁盘 | 前端 loading 防重复，或服务端按 fromRespondId 去重；**负责：ui-logic（可选）** |
| OBS-V4-4 | P2（原任务清单项） | 家庭页发送后刷新，未恢复「已选态/已告诉 TA」；deviceId 已持久化但 UI 未读取自己的 respond 恢复选中。**契约 V4 §2/§6 未列此条，故不阻断 DoD**；原任务清单要求「刷新后仍显示自己的选择」 | ui-logic 在 `renderResponds` 里按 `deviceId` 匹配 `view.responds` 恢复已选态；**负责：ui-logic** |
| OBS-V4-5 | P3（维护性） | `cards.js` 的回应段大量内联样式，且类名与 ui-shell 的 `.respond-head/.respond-label/.respond-time` 不完全一致（实际用 `.respond-who/.respond-action/.respond-when`）；视觉通过、无布局 bug | 统一到 `docs/UI-CLASSES.md`；负责：ui-logic + ui-shell（非阻塞） |

---

## 5. DoD 对照（`docs/CONTRACT-V4.md` §6）

| DoD | 状态 | 证据 / 负责 |
|---|---|---|
| 家人页能发 4 种回应（含上传照片 + consent），发送后变已选态 | ✅ **通过** | 90/1440：4 按钮 44px、consent 禁用→发送、`aria-pressed=true` + is-selected + 「已告诉 TA」；Lead+ui-logic |
| 主人端出现「家人回应」段，含照片缩略图与「设为改造后照片」 | ✅ **通过** | `.card-votes` 双段、72×72 缩略图、107×44 按钮；Lead+ui-logic |
| 点「设为改造后照片」后，对比卡出现且用的是家人那张图 | ✅ **通过** | `.card-compare` + 字节一致（25,708=25,708）+ fromRespondId/妈妈；Lead+ui-logic |
| 撤销/过期后，回应接口 404/410，照片路由 404/410 | ✅ **通过** | API 阶段 8；Lead |
| 390×844：家人页与主人端回应段无横向溢出、按钮 ≥44px、无 JS 报错 | ✅ **通过** | UI 6 场景 110 checks；ui-shell + ui-logic |
| V1/V2/V3 既有测试继续通过；CI 绿 | ✅ **通过** | `dom-check` 5 PASS、`api-e2e-v2` 680 PASS、`api-e2e-v3` 218 PASS、`v3-shots` 161 PASS（V4 前端改动后）；verifier |

> 说明：V1 的 `api-e2e.mjs` 本轮未重跑（Lead 指定回归范围为 dom-check + v2 + v3）；V1 静态契约由 `dom-check` 覆盖，V3 服务端由 `api-e2e-v3` 覆盖。若 CI 需要，建议下一轮顺带跑一次 `api-e2e`。

---

## 6. 证据文件

| 文件 | 内容 |
|---|---|
| `tests/api-e2e-v4.mjs` | V4 API 验收（9 阶段 80 checks） |
| `tests/v4-shots.mjs` | V4 UI/CDP 验收（6 场景 110 checks） |
| `.scratch/qa-e2e-v4-2026-10-24_14-12-47.json` | API 最终轮证据 |
| `.scratch/qa-v4-shots-2026-10-24_14-26-52.json` | UI 最终轮证据（每步 value、截图路径、diag） |
| `.scratch/qaV4-api-run8.log` / `qaV4-shots-run3.log` | 最终轮控制台输出 |
| `.scratch/qaV4-reg-*.log` | dom / V2 / V3 API 回归输出 |
| `.scratch/qaV4-reg-v3shots.log` / `.scratch/qa-v3-shots-2026-10-24_14-28-01.json` | V3 UI 回归（V4 前端改动后 161 checks PASS） |
| `docs/screens/20-v4-share-390.png` ~ `23-v4-compare-1440.png` | UI 截图（20/21 为 Lead 指定，22/23 补充证据） |

_本报告为 V4 最终版：API + UI + 回归均已实测；结论 PASS（2 条 soft 观察见 §4）。_

---

## 附录 · Lead 复核与观察项处理（2026-10-24 22:35）

| 观察项 | 处理 | 证据 |
|---|---|---|
| OBS-V4-4 家庭页刷新后未恢复本人已选态 | **已修**：`GET /api/share/:token?deviceId=` → 每条 respond 带 `mine`；前端按最后一条 mine 恢复按钮态/「已告诉 TA」/预填留言昵称 | `.scratch/v4-lead-verify.mjs`「刷新后恢复自己的已选回应」PASS（`selected=["我周末来量"], done="我周末来量 · 已告诉 TA"`） |
| OBS-V4-1 note ≤40 / name ≤12 与实现不一致 | **已修**：`store.addRespond` 改为 `slice(0,40)` / `slice(0,12)`（复核：该报告依据的是旧一轮 run） | `tests/api-e2e-v4.mjs` 无 soft-warn |
| OBS-V4-3 重复点「设为改造后照片」会重复复制 | **已修**：`after-from-respond` 幂等（`fromRespondId` 相同直接返回 `reused:true`） | `.scratch/v4-api-test.mjs`「重复设置幂等」PASS |
| OBS-V4-2 超限 413 | 已修并复测 | 13MB → `413 请求体过大` |
| OBS-V4-5 内联样式/类名与 CSS 不完全一致 | 保留（P3 维护性） | 视觉回归通过，留待 V5 清理 |

**Lead 独立端到端（20 项）**：`.scratch/v4-lead-verify.mjs` PASS —— 390 家庭页（4 动作 44px、投票输入默认隐藏、点卡只展开一张、表单互斥、consent 禁用、发送、刷新恢复）→ 1440 主人端（双段卡、72×72 缩略图、设为改造后照片）→ 对比卡使用家人照片（`/api/image/i_…`），无 banner/溢出/JS 异常。

**最终回归**：`dom-check` 5 · `api-e2e-v2` 684 · `api-e2e-v3` 218 · `api-e2e-v4` 80 · `v4-api-test` 27 —— 全 PASS。
