# 猫角落 Corner · V4 独立验收报告（家人回应：从表态到行动）

> 验收方：verifier（独立于实现方；只写 `tests/**`、`docs/QA-REPORT-V4.md`、`.scratch/qa-*`）
> 契约依据：`docs/CONTRACT-V4.md`（在 V1/V2/V3 之上仅做加法）
> 当前状态：**API 段 PASS**（9 阶段 / 80 checks / 2 条 soft 观察，无 P0/P1）；**UI 段待 ui-logic/ui-shell 完成后补测**（见 §3）。
> 本文件 UTF-8 无 BOM。

---

## 1. 验收环境与产物

| 项 | 内容 |
|---|---|
| 服务端 | `http://127.0.0.1:8848`，真实 DeepSeek `deepseek-flash`，V4 代码（含 413 修复） |
| API 验收脚本 | `tests/api-e2e-v4.mjs`（统一 `tests/lib-qa.mjs` 风格，PASS/FAIL 计数 + 证据 JSON） |
| 最近一次运行 | `2026-10-24 22:12:47`（本地），runId `2026-10-24_14-12-47` |
| 结果 | **PASS**：9 阶段 / **80 checks** / failed=0 / soft-warn=2 |
| 证据 JSON | `.scratch/qa-e2e-v4-2026-10-24_14-12-47.json` |
| 日志 | `.scratch/qaV4-api-run8.log`（最终轮）、`qaV4-api-run1..7.log`（过程轮） |
| 清理 | 只删本脚本创建的 session 及其 share/respond 图片，未清其他会话 |

---

## 2. API 验收（`tests/api-e2e-v4.mjs`）

### 2.1 阶段与结果

| 阶段 | 结果 | checks | 关键断言 |
|---|---|---|---|
| 0 环境预检 | PASS | 3 | 图片 fixture 存在、服务端健康 |
| 1 准备已交付 plan 的会话 | PASS | 2 | 真实 AI 流程 quality→l0→measure→plan，plan.verdict 存在 |
| 2 share + viewCount + ShareView 新字段 | PASS | 6 | responds 初始 []、respondCount=0、**每次 GET share 恰好 viewCount+1** |
| 3 4 种 action 计数/排序/匿名/覆盖 | PASS | 23 | 标签映射、ISO 时间、匿名「家人 N」、deviceId+action 覆盖、同 device 不同 action 计新票 |
| 4 校验与边界 | PASS | 12 | consent/缺图/未知 action/非法图/超大 payload 413/失败不污染计数/长度截断 |
| 5 photo 每次新增、最多 5 张 | PASS | 3 | 连续 6 次 photo 后保留 5 张，respondCount 一致 |
| 6 owner votes 扩展字段 | PASS | 6 | responds/respondCount/viewCount 与 ShareView 口径一致（允许先后读取差 ≤2） |
| 7 after-from-respond | PASS | 17 | 复制而非引用、fromRespondId/fromFamilyName、重复调用幂等、未知/非本分享 respondId → 400、被拒不改 afterImage |
| 8 撤销/过期 | PASS | 5 | respond 404/410、respond 照片 404/410（过期照片 410 按修订后 DoD 接受） |
| **合计** | **PASS** | **80** | |

### 2.2 契约逐条覆盖

| 契约 | 验收点 | 结果 |
|---|---|---|
| §1.1 respond 4 action | `measure/photo/disagree/agree` 全部 200；中文标签依次为「我周末来量 / 我拍了现场照 / 这个位置我不同意 / 就按这个来」 | ✅ |
| §1.1 consent | `photo` 无 `consent:true` → **400 `need_consent`**，不写入回应 | ✅ |
| §1.1 缺图/未知 action | 无 `photoDataUrl` → 400；未知 action → **400 `bad_action`**；非法格式 → 400 `bad_image` | ✅ |
| §1.1 覆盖规则 | 同 `deviceId`+`action` 只保留最后一次（计数不增加、note 更新、排序到末尾）；同 device 不同 action 算新回应；`photo` 每次新增、最多 5 张 | ✅ |
| §1.1 体积 | **超大 payload 现在返回干净 `413 {"code":"error","message":"请求体过大"}`**（Lead 修复 `readBody`：先看 Content-Length，超限 `req.resume()` 丢字节再 413） | ✅ |
| §1.2 after-from-respond | 复制 respond 照片为新的 upload（`imageId` 不同、字节相同）；`session.afterImage.fromRespondId/fromFamilyName` 正确；重复调用 200（幂等） | ✅ |
| §1.2 respondId 归属 | 未知 `respondId` → 400；**非本分享的 respondId → 400**，且 afterImage 不被改动 | ✅ |
| §1.3 ShareView | 新增 `responds`（id/action/label/note/name/at/photoUrl）、`respondCount`、`viewCount`；photoUrl 指向 `/api/share/<token>/photo?kind=respond&id=rs_x` 且 200 | ✅ |
| §1.4 owner votes | 扩展 `responds/respondCount/viewCount`；respond 照片缩略图 URL 在 owner 侧可读 200 | ✅ |
| §1.5 图片路由 | respond 照片与上传缩略图**逐字节一致**（25,708B），仅同分享 + token 有效期内可读 | ✅ |
| §6 撤销/过期 | 撤销后 respond 404、照片 404；过期后 respond 410、照片 410/404（见 §4 口径说明） | ✅ |

### 2.3 关键实测数据（最终轮）

```
viewCount: 2 → 3（单次 GET 严格 +1）
responds: {measure:1, photo:1, disagree:1, agree:2}（同 device 覆盖后）
photo 上限: 连续 6 次 photo → 保留 5 张，respondCount=10
after-from-respond: photo rs_xxx → imageId 复制件（≠ respond photo imageId），bytes=25708 一致
超大 payload: 413 {"code":"error","message":"请求体过大"}
```

---

## 3. UI / DOM 验收（待 ui-logic + ui-shell 完成后补测）

> **状态：待补。** 前端正在改（Lead 已同步：①投票/回应表单重复字段 ②标题下空分隔线 ③主人端回应段间距）。待他们回 done 后执行：
> - `tests/v4-shots.mjs`（390×844 + 1440）：家人页 4 按钮 2×2、≥44px、consent 未勾选发送禁用、发送后已选态/「已告诉 TA」、刷新后保留本人选择（deviceId 持久化）；主人端 `.card-votes` 双段、缩略图、「设为改造后照片」→ `.card-compare` 使用家人图（非会话原图）。
> - 截图：`docs/screens/16-share-respond-390.png`、`17-owner-responds-1440.png`、`18-compare-from-family-1440.png`。
> - 回归：`v3-shots` + `dom-check` + `api-e2e-v2/v3`（Lead 已跑过 dom 5 / v2 691 / v3 218）。

---

## 4. 测试口径说明（与 Lead 对齐后）

1. **viewCount**：`GET /api/share/:token` 每次恰好 +1；测试只在中段读一次，避免页面/其他读取叠加。owner `GET votes` 不递增，允许 `share.viewCount - owner.viewCount ∈ [0,2]`。
2. **after-from-respond 取图**：必须从 `responds.find(r => r.photoUrl)` 取（没有照片的 respondId 会 400 `no_photo`，属预期）。
3. **过期照片**：410 与 404 都代表不可读；DoD 已改为「404 或 410」，测试接受两者。
4. **超大 payload**：期望 413 干净 JSON；不再断言 ECONNRESET。
5. **预期 400 的调用**用 `httpReq` 断言 status（`api()` 封装会对非 2xx 抛异常，不能用于负向断言）。

---

## 5. 观察项（soft，不阻断 DoD）

| ID | 级别 | 观察 | 建议 / 负责 |
|---|---|---|---|
| OBS-V4-1 | P2（契约/实现不一致） | 契约 §1.1 写 `note ≤40 字 / name ≤12 字`，服务端 `addRespond` 实际 `slice(0,60)` / `slice(0,16)`（超长请求 200 并截断到 60/16）；前端 `share.js` 已按 40/12 截断，API 直连可绕过 | 服务端改为 `slice(0,40)` / `slice(0,12)` 或超长 400；负责：Lead（`app/server/store.mjs`） |
| OBS-V4-2 | 已修复（记录闭环） | 超大 payload 原实现 `req.destroy()` → 客户端 ECONNRESET 或 400 `bad_action`（错误码误导）；Lead 修复为 Content-Length 预检 + 干净 413 | 已复测 PASS |
| OBS-V4-3 | 说明 | `after-from-respond` 重复调用会再复制一次（每次产生新 imageId、删除旧 after 文件）；幂等语义可接受，但若前端重复点击会多写一次磁盘 | 可选：前端按钮 loading 防重复；或服务端按 `fromRespondId` 去重 |

---

## 6. DoD 对照（`docs/CONTRACT-V4.md` §6）

| DoD | 状态 | 负责 / 证据 |
|---|---|---|
| 家人页能发 4 种回应（含上传照片 + consent），发送后变已选态 | **API ✅ / UI 待测** | Lead（API）+ ui-logic（UI） |
| 主人端出现「家人回应」段，含照片缩略图与「设为改造后照片」 | **API ✅ / UI 待测** | Lead + ui-logic |
| 点「设为改造后照片」后，对比卡出现且用的是家人那张图 | **API ✅（复制校验通过）/ UI 待测** | Lead + ui-logic |
| 撤销/过期后，回应接口 404/410，照片路由 404/410 | ✅ | Lead（§2.1 阶段 8） |
| 390×844：家人页与主人端回应段无横向溢出、按钮 ≥44px、无 JS 报错 | **待 UI** | ui-shell + ui-logic |
| V1/V2/V3 既有测试继续通过；CI 绿 | **✓ dom / V2 / V3 API 已过；V3 UI 待补** | verifier：`dom-check` PASS 5；`api-e2e-v2` PASS 680 checks（55.6s）；`api-e2e-v3` PASS 218 checks（21.9s），日志 `.scratch/qaV4-reg-*.log` |

---

## 7. 证据文件

| 文件 | 内容 |
|---|---|
| `tests/api-e2e-v4.mjs` | V4 API 验收（9 阶段 80 checks） |
| `.scratch/qa-e2e-v4-2026-10-24_14-12-47.json` | 最终轮证据（steps/checks/soft/responds/afterImage/viewCount） |
| `.scratch/qaV4-api-run8.log` | 最终轮控制台输出 |
| `.scratch/qaV4-api-run1..7.log` | 过程轮（含 413 修复前后、after-from-respond 口径调整） |
| `.scratch/qaV4-reg-*.log` | dom-check / api-e2e-v2 / api-e2e-v3 回归输出 |
| `docs/screens/16..18` | UI 段待补的 3 张截图 |

_本报告先提交 API 段；UI 段（DOM/CDP/截图/回归）待 ui-logic+ui-shell 完成后在同一文件补 §3，并回 PASS/FAIL 汇总。_
