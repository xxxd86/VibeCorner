# 猫角落 Corner · V3 契约（闭环完成感 + 家庭社交）

> 在 CONTRACT.md / CONTRACT-V2.md 之上的增补，只做加法，不改既有字段。
> 本轮目标（对应产品目标）：① **一次需求闭环后要有"这件事成了"的完成感**；② **Muse 式社交=把这一刻的判断变成能在家人之间流转的卡片**；③ 手机端完整可用。

---

## 0. 为什么是「家庭社交」而不是「公开社区」

Muse 的社交属性不是"发到广场"，而是**把当下看到的东西变成可流转的一刻**。这个产品的使用场景天然是家庭决策：
猫窝放谁房间、砂盆谁清理、室友嫌不嫌弃——所以社交单元是**「住在一起的人」**，不是陌生人。

约束（继承产品诚信原则）：
- 不做公开社区、不做虚假社会证据（"12743 人都在用"）；
- 分享链接**默认 24 小时过期、可随时撤销**（`SHARE_TTL_HOURS` 可覆盖）；
- **仅局域网可访问**：`/api/share/*` 与 `/s/*` 会校验连接来源地址（loopback / 10.x / 172.16-31.x / 192.168.x），否则 403 `lan_only`
  （`SHARE_LAN_ONLY=0` 可关闭，用于公网隧道路演，但那就与页面文案不一致，需自行评估）；
- 分享页**不包含**：用户输入记录、picks 点选、metrics、profile；
- 分享页只提供**客户端生成的 900px 缩略图**；**没有缩略图就 404，绝不回落到会话主图**；
- 页面标注「仅家庭内分享 · 24 小时有效 · 不可下载原图」。

---

## 1. 服务端 API（新增）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/sessions/:id/share` | `{hasPhoto?:boolean(默认 true), photoDataUrl?:string}` | `{share:{token,url,expiresAt,hasPhoto}}` |
| GET | `/api/sessions/:id/share` | — | `{share \| null}` |
| DELETE | `/api/sessions/:id/share` | — | `{ok:true}`（立即失效） |
| GET | `/api/share/:token` | — | `ShareView`（**仅局域网**，否则 403 `lan_only`） |
| GET | `/api/share/:token/photo` | — | 客户端生成的 **900px 缩略图**（**无缩略图时 404，绝不回落会话原图**） |
| POST | `/api/share/:token/vote` | `{targetId,targetType,vote,note?,name?,voteId?}` | `{ok:true,voteCount,targets,counts}`；`targetId` 必须属于该分享的 targets，否则 400 `bad_target` |
| GET | `/api/sessions/:id/votes` | — | `{votes:[Vote], counts:{}}` |
| POST | `/api/sessions/:id/after` | `{dataUrl,width,height}` | `{session}`（记录"改造后"照片） |
| DELETE | `/api/sessions/:id/after` | — | `{ok:true}` |

### 1.1 `ShareView`（分享页唯一数据源，已脱敏）
```jsonc
{
  "token":"sh_ab12cd34",
  "title":"客厅 · 墙角原位换半包式猫窝",
  "createdAt":"ISO","expiresAt":"ISO","ownerLabel":"家的角落",
  "recognition":"电视柜右侧墙角，现有灰色猫窝和方形抓板并排摆着",
  "boundary":"照片里看不出进深，这一步只能给方向",
  "photoUrl":"/api/share/sh_x/photo" | null,
  "decision":"conditional",              // 与 plan.verdict 同义
  "headline":"满足下列条件才可放，先看尺寸条件",
  "annotations":[{"id":"1","label":"猫窝落位","bbox":[0.31,0.3,0.24,0.3],"note":"贴右墙，留 60cm 通道"}],
  "catFit":{"verdict":"caution","items":[{"key":"hide","label":"能藏的地方","status":"pass","why":"半包结构三面遮挡"}]},
  "constraints":[{"label":"通道净宽","op":">=","valueCm":60,"actualCm":62,"status":"pass","basisdge":null}],
  "items":[{"id":"i1","type":"new|reuse","title":"半包式猫窝 45×40","price":129,"fit":"ok"}],
  "targets":[{"id":"i1","type":"item","label":"半包式猫窝 45×40","support":2,"unsure":0,"oppose":0},
             {"id":"i2","type":"item","label":"复用现有猫窝","support":1,"unsure":0,"oppose":0}],
  "voteCount":3,
  "disclaimer":"以交付时的尺寸条件为准，落地前请现场确认。"
}
```
- `targets` = 可投票对象（方案 items 里 fit≠blocked 的 + L0 的 reuse 方向，最多 5 个）。
- 不含：`measurements` 原值以外的输入、`picks`、`metrics`、`profile`、`quality` 细节。

### 1.2 `Vote`
```jsonc
{"targetId":"i1","targetType":"item","vote":"yes|unsure|no","note":"这个窝好清理","name":"室友","at":"ISO"}
```
- `name` 可空（匿名显示「家人 2」）；`note` ≤40 字。
- 同一浏览器同一 token 同一 target 只计最后一次（本地 localStorage 记 `voteId`，服务端按 `voteId+targetId` 覆盖）。

### 1.3 `session` 新增字段
```jsonc
{
  "share": {"token":"sh_x","url":"/s/sh_x","expiresAt":"ISO","hasPhoto":true} | null,
  "afterImage": {"imageId":"i_x","url":"/api/image/i_x","width":1080,"height":810,"at":"ISO"} | null,
  "deliveredAt": "ISO" | null
}
```

---

## 2. 前端：完成感（`handoffCard`）

`plan` 交付后，在 plan 卡**下方**追加一张 `.card-handoff`，内容固定为 4 段：

1. **完成句**：`这个角落已经有结论了：<verdict 人话>`（conditional→「有条件可放」/not_supported→「现在不建议放」/insufficient→「还差 N 个数字」）
2. **三个数字**：`你量了 3 个数 · 判断了 6 项位置 · 4 条尺寸条件 + 6 条现场动作`
3. **下一步时间线**：`第 1 天 …` / `第 3 天 …` / `第 7 天 …`（取 `plan.observe`）
4. **四个动作按钮**：
   - `导出标注图`（已有 `exportPNG`）
   - `分享给同住的人`（生成链接 → 弹分享面板）
   - `记录改造结果`（上传改造后照片 → 生成对比卡）
   - `复制现场清单`（纯文本到剪贴板）

### 2.1 分享面板 `.share-sheet`
- 显示链接（`http://<当前 host>/s/<token>`）、`24 小时内有效 · 可随时撤销`、`仅同一 Wi-Fi`；
- 按钮：`复制链接` / `系统分享`（`navigator.share` 可用时）/ `撤销分享`；
- 分享后同一会话显示「已分享 · 等待家人意见」小状态。

### 2.2 家人意见卡 `.card-votes`
- 主人侧：当 `GET /api/sessions/:id/votes` 有数据时，在 handoff 卡下方显示；
- 每行：`家人 2 · 支持「复用现有猫窝」` + 留言（如有）；
- 顶部汇总：`3 人看过 · 支持 2 · 犹豫 1`。

### 2.3 改造前后对比 `.card-compare`
- 左右并排：左「改造前」（原图 + 标注）、右「改造后」（afterImage）；
- 底部一句总结（可编辑一句，≤30 字，默认「按方案落地后的样子」）；
- `导出对比图` → 生成 2× 白底 PNG（含标题、日期、两图、标注序号图例）；
- 生成后可选「分享对比」→ 用同一 share token（分享页展示对比图）。

### 2.4 分享页 `/s/:token`（独立页面）
`app/public/share.html` + `js/share.js`，只读。结构：
```
#share-root[data-state=loading|ready|expired|invalid]
  header: 标题 / ownerLabel / 「仅家庭内分享 · 剩余 23 小时」
  decision-banner: 结论句（三态色）
  photo: 标注图（含热区 + 序号）
  section 位置: catFit 6 项（与主应用同一套徽章语义，但**不显示 URL 链接**）
  section 尺寸条件: 三态
  section 方案: items + 投票按钮（支持/犹豫/反对 + 一句话留言 + 昵称可选）
  底部: disclaimer + 「这是只读分享页，不能修改方案」
```
移动优先：单列、max 640px、投票按钮大点击区。

---

## 3. 手机端必须满足（本轮验收清单）

- 390×844 下：rail 顶部抽屉、canvas 底部抽屉、`#goal-choices`、`#wait-steps`、测量区间输入、5 tab、依据 popover、share sheet、handoff 卡、votes 卡、compare 卡 **全部可用且不横向溢出**
- 输入框聚焦时页面不被顶飞（`visualViewport` 适配）；键盘弹起后发送按钮可见
- 分享页 `/s/:token` 在 390 下完整可读、投票可点
- 触控目标 ≥ 40px

---

## 4. 写入范围

| 角色 | 路径 |
|---|---|
| Lead | `app/server/index.mjs`、`app/server/store.mjs`、`docs/CONTRACT-V3.md` |
| ui-shell | `app/public/share.html`、`app/public/styles/**`、`docs/UI-CLASSES.md` |
| ui-logic | `app/public/js/**`（新增 `share.js`） |
| verifier | `tests/**`、`docs/QA-REPORT-V3.md` |

---

## 5. 完成定义（DoD）

- [ ] 交付后 3 秒内看到 handoff 卡：完成句 + 3 个数字 + 时间线 + 4 个动作
- [ ] 点「分享给同住的人」能在另一台设备（或另一浏览器）打开 `/s/<token>`，看到脱敏摘要并可投票
- [ ] 主人回到应用能看到「家人意见」卡（支持/犹豫/反对 + 留言）
- [ ] 撤销分享后 `/api/share/<token>` 立即 404，页面显示「链接已失效」
- [ ] 上传改造后照片 → 生成 before/after 对比卡 → 可导出 PNG
- [ ] 390×844 全流程无破版、无 JS 报错、触控目标 ≥40px
- [ ] 既有 V1/V2 测试全部继续 PASS
