# 猫角落 Corner · V4 契约（家人回应：从表态到行动）

> 在 V1/V2/V3 之上的增补，只做加法。
> 目标：把「家庭社交」从**异步留言板**补成**闭环**——家人不只是按个态度，还能把"我能做什么"和"我看到什么"传回来；
> 主人拿到后能直接推进流程（尤其是把家人拍的现场照用作改造后对比）。这就是 Muse 式的一刻：**把当下交给别人，并拿回东西**。

---

## 1. 新增接口

### 1.1 `POST /api/share/:token/respond`
家庭侧（无需登录）在只读页点的"行动回应"。

```jsonc
// 请求
{
  "action": "measure" | "photo" | "disagree" | "agree",
  "note": "周末我来量",          // ≤40 字，可空
  "name": "室友",                // ≤12 字，可空 → 匿名「家人 N」
  "deviceId": "d_xxxxxxxx",      // 本设备随机 id，用于区分「家人 N」并覆盖本人重复点击
  "consent": true,               // action==="photo" 时必须为 true
  "photoDataUrl": "data:image/jpeg;base64,..."  // 仅 photo：客户端压到长边 900 / q0.82
}
// 响应
{ "ok": true, "respondCount": 2, "responds": [Respond] }
```

规则：
- 同一 `deviceId` + `action` 只保留最后一次（覆盖），`photo` 每次新增（最多保留 5 张/分享）。
- `action==="photo"` 时若无 `consent:true` → 400 `need_consent`；无 `photoDataUrl` → 400 `bad_request`。
- 图片体积上限沿用 12MB；服务端另存为分享专用文件（**不写入会话主图**）。
- 分享已撤销/过期 → 404 / 410（照片路由同：撤销 404、过期 410，二者都算"拿不到"）。

### 1.2 `POST /api/sessions/:id/after-from-respond`
主人侧：把「家人回传的照片」设为本角落的**改造后照片**（用于前后对比）。

```jsonc
{ "respondId": "rs_ab12cd34" }
// → { session }   // session.afterImage 指向该图（复制一份，不引用分享文件）
```

### 1.3 `ShareView` 新增字段
```jsonc
{
  "responds": [
    {
      "id": "rs_ab12cd34",
      "action": "measure",
      "label": "我周末来量",           // 服务端给的中文标签
      "note": "周末我来量",
      "name": "室友",
      "at": "ISO",
      "photoUrl": null                  // photo 时 = /api/share/<token>/photo?kind=respond&id=rs_xxx
    }
  ],
  "respondCount": 2
}
```

### 1.4 `GET /api/sessions/:id/votes` 扩展
```jsonc
{
  "votes": [...], "counts": {...}, "voteCount": 2,
  "responds": [Respond],       // 同上（含 photoUrl，主人侧可看缩略图）
  "respondCount": 2,
  "expiresAt": "ISO"
}
```

### 1.5 图片路由
`GET /api/share/:token/photo?kind=respond&id=rs_xxx` → 该回应附带的照片（仅局域网 / token 有效期内）。

---

## 2. 家庭页（`/s/<token>`）UI 要求

在现有「家人意见（投票）」下方新增**「我能做什么」**区：

```
我能做什么（选一个就行，不用登录）
[ 🪜 我周末来量 ]  [ 📷 我拍了现场照 ]  [ ⛔ 这个位置我不同意 ]  [ ✅ 就按这个来 ]
   ↑ 点击后展开：一句话留言（选填）+ 昵称（选填）+ [发送]
   ↑ 选「我拍了现场照」时出现文件选择 + 勾选「这张照片会发给设置这个角落的人」
发送后按钮变已选态，显示「已告诉 TA」
```
- 移动优先，按钮 ≥44px，两列网格。
- 页面底部加一行小字：`你回的这些只会发给设置这个角落的人，不会公开。`

## 3. 主人端 UI 要求

`votesCard` 升级为 **「家人意见 / 家人回应」双段卡**（同一个卡，两段）：

```
家人意见                                  最近更新 · 3 分钟前
1 人看过 · 支持 1
  室友 · 支持「复用现有猫窝」  "这个位置我同意"      刚刚

家人回应
  室友 · 我周末来量        "周六上午有空"            刚刚
  妈妈 · 我拍了现场照       [缩略图]                 2 分钟前
        └ [设为改造后照片]
```
- 有照片的回应：显示 72×72 缩略图；点开看大图（复用全屏查看器或简单 modal）。
- 「设为改造后照片」→ 调 1.2 接口 → 成功后渲染 `.card-compare`（复用现有对比卡），并 toast「已用家人拍的照片做对比」。
- 空段不渲染；整卡无内容不渲染。

## 4. 本轮顺带修（体验）

1. **测量卡显式反馈**：一屏一问、两张卡时，第一张提交后卡片头要写：
   `已记下 1/2，填完下面这个就提交`（现在是 toast 一闪而过，用户不知道还没提交）。
2. **交付卡三数字**：390 下改成 2 列网格（`3 | 6` 一行、`3+6` 跨两列），不要出现「3 | 6 / 3+6」参差。
3. **分享链接一次性**：分享面板里加一行 `已访问 N 次`（服务端在 ShareView 里给 `viewCount`），让主人知道链接被谁打开过（不记录身份）。

## 5. 服务端实现状态（Lead，已自测）

- `POST /api/share/:token/respond` ✅ 23 项自测全过（`.scratch/v4-api-test.mjs`）：
  无 consent→400 `need_consent`、缺照片→400、未知 action→400、同 deviceId+action 覆盖、撤销后 404。
- `GET /api/share/:token/photo?kind=respond&id=rs_x` ✅ 200 image/jpeg，撤销后 404。
- `GET /api/sessions/:id/votes` ✅ 返回 `responds/respondCount/viewCount`；名字按 device 匿名化为「家人 N」。
- `POST /api/sessions/:id/after-from-respond` ✅ 复制图片（不引用分享文件）→ `session.afterImage.fromRespondId`，
  分享页 `afterPhotoUrl` 立即变 200。
- `GET /api/share/:token` ✅ `viewCount` 每次打开 +1（不记身份）。
- **删除会话时一并清理**：主图 + 改造后照片 + 分享文件 + 分享缩略图 + 家人回传照片（`.scratch/v4-delete-cleanup.mjs` 5/5 PASS）。
  这是「删除即从服务器移除」承诺的兑现，别退化。

## 6. 写入范围


| 角色 | 路径 |
|---|---|
| Lead | `app/server/index.mjs`、`app/server/store.mjs`、`docs/CONTRACT-V4.md` |
| ui-logic | `app/public/js/**`（`share.js` / `cards.js` / `flow.js` / `app.js` / `api.js`） |
| ui-shell | `app/public/styles/**`、`docs/UI-CLASSES.md` |
| verifier | `tests/**`、`docs/QA-REPORT-V4.md` |

## 7. DoD

- [x] 家人页能发 4 种回应（含上传照片 + consent），发送后变已选态
- [x] 主人端出现「家人回应」段，含照片缩略图与「设为改造后照片」
- [x] 点「设为改造后照片」后，对比卡出现且用的是家人那张图
- [x] 撤销/过期后，回应接口 404/410，照片路由 404/410
- [x] 390×844：家人页与主人端回应段无横向溢出、按钮 ≥44px、无 JS 报错
- [x] V1/V2/V3 全部既有测试继续通过；CI 绿

### 验收证据（2026-10-24）

| 项 | 证据 |
|---|---|
| 服务端 23 项 | `.scratch/v4-api-test.mjs` PASS |
| 服务端 80 项（独立写） | `tests/api-e2e-v4.mjs` PASS（含 consent/超限/覆盖/撤销/过期） |
| 删除即移除 | `.scratch/v4-delete-cleanup.mjs` 5/5 PASS（主图+改造后+分享图+家人照片） |
| 前端端到端 17 项 | `.scratch/v4-lead-verify.mjs` PASS（390 家庭页 → 1440 主人端 → 对比卡） |
| 回归 | `dom-check` 5 / `api-e2e-v2` 691 / `api-e2e-v3` 218 全 PASS |
| 截图 | `docs/screens/16~19` |
