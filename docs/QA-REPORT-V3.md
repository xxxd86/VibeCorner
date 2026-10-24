# 猫角落 Corner · V3 独立验收报告（QA-REPORT-V3）

> 验收方：verifier（独立于实现方；只测不改业务代码）
> 契约依据：`docs/CONTRACT-V3.md`（闭环完成感 + 家庭社交 + 手机端），基线 `CONTRACT.md` / `CONTRACT-V2.md`
> **最终结论：PASS** —— V1/V2 回归全绿；V3 服务端/分享页/双端 UI 全绿；**原 5 条 P2 全部由 Lead 修复，已逐条复测通过（闭环）**；无 P0/P1 残留。
> 最终稳定轮时间：**2026-10-24 12:13:28—12:56（Asia/Shanghai）**；gzip 改动后稳定轮、P2 修复复测轮（12:26:53 api / 12:27:16 UI / 12:31:58 api 重跑）、回执修复后最终轮（12:55:50 UI）全部 PASS。
> 本文件 UTF-8 无 BOM。

---

## 1. 最终轮校验记录

```
=== V3 FINAL RUN（P2 修复 + 回执修复后复测） ===
node tests/dom-check.mjs      → exit 0  PASS (5 checks)
node tests/api-e2e.mjs        → exit 0  PASS (4/4 阶段, 39.4s)            ← V1 回归
node tests/shot.mjs           → exit 0  PASS (28 checks, 2 张截图)         ← V1 回归
node tests/api-e2e-v2.mjs     → exit 0  PASS (6 阶段, 678 checks, 57.1s)   ← V2 回归
node tests/v2-shots.mjs       → exit 0  PASS (100 checks, 18 张截图)       ← V2 回归
node tests/api-e2e-v3.mjs     → exit 0  PASS (13 阶段, 212 checks, 19.0s)  ← V3 + LAN/TTL/PWA/gzip
node tests/v3-shots.mjs       → exit 0  PASS (161 checks, 6 个浏览器场景, 15 张截图) ← V3 双端 UI + 回执
```

| 检查 | 结果 | 关键数据 |
|---|---|---|
| V1 DOM / V1 API / V1 截图 | ✅ PASS | 41/41 ID、9 资源、导出 PNG 2720×2292、点选追问、双端无破版 |
| V2 证据/字段/诚实性 + 双端 5tab | ✅ PASS | 678 checks + 100 checks；NA-RULE / PASSAGE_WIDTH / 区间 / popover / 回访卡全绿 |
| V3 share 生命周期 | ✅ PASS | 创建 `sh_[a-f0-9]{16}`、≈24h、复用同 token、撤销后 404、过期 410 |
| V3 ShareView 脱敏 | ✅ PASS（87—98 checks） | 字段齐全；不含 measurements/picks/profile/metrics/quality/asks/voteId/imageId/原图路径/goal 文本 |
| V3 分享图 900px 缩略图 | ✅ PASS | 客户端缩略图 900×675 / **25,708B（<200KB）**；逐字节一致；≠原图 527,845B；**无缩略图 → 404（不回落原图）** |
| V3 投票一致性 | ✅ PASS（21—23 checks） | 同 voteId+target 覆盖、不同 voteId 新票、targets 聚合正确、匿名「家人 N」、owner counts 正确、无 voteId 外泄；**未知 targetId → 400 bad_target 且不污染 voteCount**；**vote 响应含 targets/counts（前端就地刷新）** |
| V3 改造后照片 | ✅ PASS | POST after → afterImage；分享页 afterPhotoUrl；GET 200；删除后 404 / 字段消失 |
| V3 边界 + LAN | ✅ PASS | 未生成 plan→400；未知/非法 token→404；过期→410；**loopback 与局域网网卡（本机 192.168.1.5）访问分享 → 200**（非私网来源 403 `lan_only` 由代码路径验证，本机无法模拟） |
| V3 TTL 钩子 | ✅ PASS（附注） | `SHARE_TTL_HOURS=1` 独立服务端实测 `expiresAt≈1h`（默认 24h）；实现有 `Math.max(1,...)` 钳制，<1h 不可配置（见 §5 附注） |
| V3 PWA | ✅ PASS（24 checks） | `/manifest.webmanifest` 200 + `application/manifest+json`；icons 192/512（含 maskable）200 且尺寸与声明一致；index 引用 manifest/apple-touch-icon/theme-color |
| V3 gzip | ✅ PASS（10 checks） | components.css gzip **15,929B** vs 原始 89,099B；cards.js/index.html/share.html 均 gzip；`/api/evidence` **无 Content-Encoding**（API 不压缩） |
| V3 双端 UI | ✅ PASS（161 checks，1 WARN） | handoff（**1—3ms**）、分享面板、家人意见（含回执：toast + 未读角标 + 滚动清零）、对比卡+导出 2720×1596、分享页 ready/voted/invalid/expired、390 无横向溢出/无 JS 报错；**投票后计数即时「支持 1」**；**关闭「×」热区 44×44**；分享页 catFit na「不涉及」。WARN：最终轮未捕获「已读后再来新票 +1 角标」的瞬时值（新票渲染自动滚到卡片 → 自动已读清零，属预期时序；Lead `verify-receipt` 6/6 已覆盖） |

> 测试期间服务端因 gzip 改动重启过两次：其中一轮 `restore-390` 出现 `ERR_CONNECTION_REFUSED`、另一轮 `ECONNRESET`——均为测试环境中断，**重启稳定后同脚本全绿**（见 §9 验收工具自身问题）。

---

## 2. V3 DoD 逐条结论（CONTRACT-V3 §5）

| # | DoD 条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | 交付后 3 秒内看到 handoff 卡：完成句 + 3 个数字 + 时间线 + 4 个动作 | ✅ **通过** | 实测 **delta=1—2ms**；完成句「这个角落已经有结论了：有条件可放 / 还差关键数字」；3 个数字「N 你量的数 / 6 位置判断 / M + 6 尺寸条件 + 现场动作」；时间线折叠「接下来 7 天怎么判断」含第 1/3/7 天；4 动作齐全 |
| 2 | 点「分享给同住的人」另一设备可打开 `/s/<token>`，看脱敏摘要并投票 | ✅ **通过** | 分享面板生成 `http://127.0.0.1:8848/s/sh_…`；390/1440 分享页 ready；投票「支持」选中态 + 「已告诉 TA 你的意见」；voteId 写入 localStorage（可改选覆盖） |
| 3 | 主人回到应用能看到「家人意见」卡（支持/犹豫/反对 + 留言） | ✅ **通过** | 实测两个「家人」投票后，主人侧卡显示「2 人看过 · 支持 1 · 犹豫 1」+「爸爸 · 支持『…』留言」「妈妈 · 犹豫…」；历史回放后仍出现；**新票有 toast + 未读角标「+2」，滚动到卡后自动清零**（回执已复测） |
| 4 | 撤销分享后 `/api/share/<token>` 立即 404，页面显示「链接已失效」 | ✅ **通过** | API 404（照片也 404）；分享页进入 `invalid` 态、标题「链接已失效」、内容隐藏；**过期路径**手改 expiresAt 后 API 410、页面 `expired` 态「链接已失效/已过期」 |
| 5 | 上传改造后照片 → 对比卡 → 可导出 PNG | ✅ **通过** | POST after（1080×810）→ 对比卡左右「改造前（原图+标注）/ 改造后」+ 可编辑总结；点「导出对比图」触发 `corner-compare-2026-10-24.png`，PNG **2720×1596**（2× 白底） |
| 6 | 390×844 全流程无破版、无 JS 报错、触控 ≥40px | ✅ **通过** | handoff/share sheet/votes/compare/分享页 ready+voted+invalid/expired 全部在 390 无横向溢出、无未捕获异常、无 JS console.error（撤销/过期页的 404/410 网络记录为预期噪声）；主要动作按钮 ≥44px；**分享面板关闭「×」视觉 30px 但 `::before inset:-7px` 把热区扩到 44×44**（OBS-V3-2 已修复并复测：计算样式 `position=absolute / top=-7px / width=44px / height=44px`） |
| 7 | 既有 V1/V2 测试全部继续 PASS | ✅ **通过** | V1 5 checks + 4/4 + 28 checks；V2 678 checks + 100 checks，全部 PASS |
| 额外 | PWA（本次新增交付） | ✅ 通过 | manifest standalone、icons 192/512/maskable、apple-touch-icon/theme-color 均实测 200；可「添加到主屏幕」 |
| 额外 | 静态 gzip（本轮服务端改动） | ✅ 通过 | 首屏资源 gzip 后约 15.9KB（CSS 原始 89.1KB，-82%）；API/SSE 不压缩 |
| 额外 | 局域网强制 + TTL 钩子（P2 修复） | ✅ 通过 | loopback 与局域网网卡（192.168.1.5）访问分享均 200；`SHARE_TTL_HOURS=1` 实测 expiresAt≈1h |

---

## 3. 隐私与诚信专项（V3 核心，逐项实测）

### 3.1 分享数据脱敏（87—98 checks）
- `GET /api/share/:token` 响应里 **不存在**：`measurements`、`picks`、`profile`、`metrics`、`quality`、`asks`、`voteId`、`analysisNote`、`imageId`、`/api/image/` 路径；也不包含用户输入的 goal 文本。
- ShareView 只给：title / ownerLabel「家的角落」/ recognition / boundary / decision+decisionLabel / headline / 标注 / catFit 6 项（不含 basisId、不含外链）/ constraints 三态 / items / targets / voteCount / disclaimer。
- owner 视角 `GET /api/sessions/:id/votes`：有票、昵称、留言；**不返回 voteId**；匿名票默认「家人 N」。
- 分享页不渲染任何证据 URL（实测链接数 0，符合契约 §2.4）。

### 3.2 分享图「拿不到原图」
- 客户端缩略图路径（真实 UI 路径）：分享页照片 `naturalWidth=900`、`Content-Length=25,708B`（测试 fixture 900×675），与上传缩略图**逐字节一致**；永不回落到 527,845B 原图。
- 浏览器端实测：分享页照片 900×506（长边 900）、页面标注「不可下载原图」。
- 撤销后照片 404、过期后 410。
- ✅ **兜底缺口已修复（OBS-V3-1 → 复测通过）**：客户端**不传** `photoDataUrl`（API 直连或旧客户端）时，`GET /api/share/:token/photo` 现在直接 **404**，绝不回落会话主图（复测断言 `status=404`）；after 照片同逻辑（无 afterImage → 404）。口径统一为：分享页图片是**压缩版（before 长边 900，after 长边 ≤1280），拿不到相机原图**。

### 3.3 反操纵 / 社会证据
- 主人侧汇总 `2 人看过 · 支持 1 · 犹豫 1` 全部来自真实投票记录（本次测试注入 2 票），无「12743 人都在用」类文案。
- 分享面板明确「24 小时内有效 · 仅同一 Wi-Fi 可打开 · 可随时撤销」「这张卡片只包含方案摘要，不含你的输入记录或原图」；分享页明确「仅家庭内分享 · 剩余 24 小时 · 不可下载原图」。
- 分享页失效态不制造愧疚：撤销 →「这个分享不存在，可能已经被撤销。让家人重新生成一次链接就行。」；过期 →「分享已过期或被主人撤销了。让家人重新生成一次链接就行。」
- 分享页 catFit 的 `na` 已正确显示「不涉及」（本轮 Lead 修复，实测截图确认），`warn` 显示「注意/偏紧」语义。
- ✅ **「仅同一 Wi-Fi」已有技术兜底（OBS-V3-5 → 复测通过）**：服务端按 `socket.remoteAddress` 判定，loopback / 10.x / 172.16-31.x / 192.168.x 放行，其余 403 `lan_only` 并返回中文说明页；`SHARE_LAN_ONLY=0` 可关闭。实测：`127.0.0.1` 与局域网网卡 `192.168.1.5` 访问 `/api/share/:token`、`/s/:token` 均 200；非私网来源的 403 本机无法模拟，按代码路径 + 私网放行记录。

### 3.4 投票一致性（21—23 checks）
- 同一 `voteId` + 同一 `targetId` 重复提交：`voteCount` 不变（最后一次生效，留言覆盖）。
- 同一投票人对不同 target：分别计票。
- 不同 `voteId`：算新票；匿名票默认「家人 N」。
- `targets` 聚合 support/unsure/oppose 与 owner `counts` 一致。
- 边界：缺 `targetId` → 400；非法 vote 值归一化为 unsure。
- ✅ **校验缺口已修复（OBS-V3-4 → 复测通过）**：`targetId` 不属于该分享的 `targets` 时返回 **400 `bad_target`**，且 `voteCount` 不变（已断言不污染总数）。
- ✅ **计数即时刷新（OBS-V3-3 → 复测通过）**：`vote` 响应新增 `{voteCount, targets, counts}`；`share.js` 用返回的 targets 就地刷新「支持 X · 犹豫 Y · 反对 Z」。实测投票后立即显示「支持 1 · 犹豫 0 · 反对 0」，无需刷新页面。

### 3.5 家人意见回执 / 未读角标（Lead 12:30 补充，已复测）
- 新意见到达（已读基线之后）：owner 端 toast「家人给了意见 · 支持 X · 犹豫 Y」，家人意见卡角标 `+N`（`aria-label="N 条新意见"`），卡片 `data-unread` 同步。
- 实测序列：首次加载未读 `+2`（`data-unread=2`）→ 已读后再来一票 `+1` → 滚动到卡片（IntersectionObserver 35% 可见）自动已读，角标清零（`data-unread=0`）。
- 设计说明：角标在卡片进入视口后自动清除（「看过即已读」），因此主要通知手段是 toast；未读角标更适合卡片在首屏外、用户下次回来时提示——本轮通过临时禁用 IntersectionObserver 单独验证了角标本身，再恢复 observer 验证滚动清零。

---

## 4. 截图与交互（`tests/screens/v3/`，15 张，均人工目检）

| 截图 | 目检结论 |
|---|---|
| `v3-handoff-1440.png` | 已完成卡：完成句 + 3 个数字（大号数字+标签）+ 折叠时间线 + 4 动作（导出/再次分享/记录改造/复制清单）+ 「已分享·等待家人意见」 |
| `v3-share-sheet-1440.png` | 分享面板：链接、3 条限制（24h/同 Wi-Fi/可撤销）、复制/系统分享/撤销、隐私说明；关闭「×」视觉小但热区已扩到 44×44（复测计算样式确认） |
| `v3-votes-1440.png` | 家人意见卡：「2 人看过·支持 1·犹豫 1」+ 爸爸/妈妈两行（支持/犹豫标签 + 留言） |
| `v3-votes-unread-1440.png` | 家人意见卡带未读角标「+2 / 2 条新意见」，卡内 chip 与 toast 同步 |
| `v3-votes-read-1440.png` | 滚动到卡片后角标清零（自动已读），卡片恢复无角标状态 |
| `v3-compare-1440.png` | 改造前后对比：左原图+2 个标注、右改造图、可编辑总结、导出/重新上传/删除 |
| `v3-restored-390.png` / `v3-votes-390.png` / `v3-compare-390.png` | 390 历史回放：plan/handoff/votes/compare 四卡恢复；回放后自动滚到 feed 末尾（家人意见+对比卡可见），三张截图均无横向溢出 |
| `v3-share-sheet-390.png` | 390 分享面板：链接可用、无横向溢出 |
| `v3-share-ready-390.png` / `v3-share-ready-1440.png` | 分享页 ready：TTL、标题、owner「家的角落」、结论横幅、标注图+热点+图例、位置判断 6 项（含「不涉及」）、尺寸条件、方案、投票区 |
| `v3-share-voted-390.png` | 投票区：支持按钮选中态 +「已告诉 TA 你的意见」+ 计数即时「支持 1 · 犹豫 0 · 反对 0」 |
| `v3-share-invalid-390.png` | 撤销后：「链接已失效」+ 说明 + 「了解猫角落」按钮，方案内容隐藏 |
| `v3-share-expired-390.png` | 过期态：「链接已失效 / 分享已过期或被撤销」 |

> 说明：分享页 loading 态是瞬时骨架屏（HTML `#share-root[data-state=loading]` + skeleton），截图窗口内无法稳定捕获；ready/invalid/expired 三态均已截图。

---

## 5. 缺陷 / 观察项（发现 → 修复 → 复测闭环）

> P0 阻断 / P1 严重 / P2 体验。**本轮无 P0/P1**。首轮报出的 5 条 P2 已由 Lead 全部修复，本节保留原始记录并补「修复 + 复测」结果；另 1 条口径变更与 2 条已知边界见后。

| ID | 级别 | 原始现象 / 复现（首轮记录） | 修复与复测结果 |
|---|---|---|---|
| OBS-V3-1 | **P2（隐私兜底）** | 客户端不传 `photoDataUrl` 时，`GET /api/share/:token/photo` 回落原图 527,845B（>200KB）。复现：`POST /api/sessions/:id/share {}` → GET photo | ✅ **已修复并复测**：服务端改为无 `share.photo` 直接 **404**，绝不回落主图；after 同逻辑。复测断言 `status=404`、无原图字节；before 900px / after ≤1280 的压缩版口径已写进页面文案 |
| OBS-V3-2 | P2（触控） | 分享面板关闭「×」高度 30px（<40px） | ✅ **已修复并复测**：`.modal-close::before` inset -7px，实测计算样式 `position=absolute / top=-7px / width=44px / height=44px`；主操作按钮 ≥44px |
| OBS-V3-3 | P2（反馈） | 投票成功后本人侧计数仍显示 支持 0 · 犹豫 0 · 反对 0（需刷新） | ✅ **已修复并复测**：`vote` 返回 `{voteCount,targets,counts}`，`share.js` 就地刷新；复测投票后立即「支持 1 · 犹豫 0 · 反对 0」 |
| OBS-V3-4 | P2（校验） | 未知 `targetId` 投票被接受（200，voteCount+1，污染总数） | ✅ **已修复并复测**：返回 **400 `bad_target`**；复测确认 `voteCount` 不变 |
| OBS-V3-5 | P2（文案/技术一致性） | 「仅同一 Wi-Fi」只是文案，服务端监听 0.0.0.0 无网段校验 | ✅ **已修复并复测**：`isLanRequest` 按 remoteAddress 放行 loopback/10.x/172.16-31.x/192.168.x，其余 403 `lan_only`；实测 loopback 与局域网网卡 192.168.1.5 访问均 200；非私网来源本机无法模拟（代码路径已审阅） |
| OBS-V3-6 | P3（口径） | after 照片按原尺寸（1080×810）提供，未压到 900px | 🔄 **口径更新（不改代码）**：分享页图片统一承诺「压缩版（before 长边 900 / after 长边 ≤1280），拿不到相机原图」——文案已与实现一致 |
| 已知取舍 | — | 再次分享会撤销旧链接并换新 token（为了不回落原图） | ✅ 实测旧 token 立即 404、session.share 更新为新 token；属有意为之 |
| 已知限制 1 | — | 过期态真实 24h 等待不可行 | 已新增 `SHARE_TTL_HOURS` 钩子并实测（`=1` → expiresAt≈1h，默认 24h）；**但实现里 `Math.max(1,...)` 把 TTL 钳到最小 1 小时**，<1h 无法配置，快速过期仍用手改 `expiresAt`（测后清理）；建议后续允许小数小时 |
| 已知限制 2 | — | 非私网来源的 403 无法在本机模拟 | 仅验证 loopback + 本机局域网网卡放行；跨网段/公网访问的拒绝按代码路径确认 |

---

## 6. 独立判断：「家庭社交」是否真的增强了“一次闭环后的成就感”

**结论：完成感是真实增强的；家庭社交在 P2 修复 + 回执/未读角标补齐后，已经从「异步留言板」变成有来有回的闭环雏形。剩下的不是核心闭环，而是「家人能否回传行动」和「分享链接的持有者控制」。它不是纯加功能，但仍不是无可挑剔。**

支持「真增强」的证据（全部为用户可见、非 DoD 文字）：
1. **handoff 在 plan 后 1—2ms 出现**，且内容不是口号：完成句直接来自 `plan.verdict`（有条件可放 / 还差关键数字）；三个数字是真实输入与判断计数（你量的数、6 项位置判断、尺寸条件+现场动作）；7 天时间线直接取 `plan.observe`（第 1 天别洗垫子 / 第 3 天不用不算失败 / 第 7 天 ≥2 次就保留）；4 个动作全部可执行。这是「把决定权交回用户」的收尾，而不是装饰卡。
2. **分享卡片真的能流转**：390 分享页完整可读（TTL、结论、标注图、6 项位置、尺寸条件、方案、投票），家人投票后「已告诉 TA 你的意见」+ 计数即时「支持 1」；主人侧出现「2 人看过 · 支持 1 · 犹豫 1」+ 昵称留言；撤销/过期有清晰失效态。
3. **家人意见有回执**：新意见到达时 owner 端 toast「家人给了意见 · 支持 2 · 犹豫 1」，家人意见卡未读角标「+2 / 2 条新意见」；滚到卡片后 IntersectionObserver(35%)/几何兜底(60%) 自动已读清零（本轮实测：`data-unread` 2→0；已读后再来新票的「+1」在渲染瞬间出现，见 §10）。这是把「分享」变成「回来看看」的关键一步。
4. **改造前后对比**把"建议"变成"可带走的证据"：上传改造后照片 → 左右对比 → 编辑一句总结 → 导出 2× 白底 PNG（2720×1596）。这比再多的文案都更能产生"这件事成了"的感觉。

说明「还没闭环」的证据（已扣除本轮已修项）：
1. 分享页仍是「表态」而非「行动」：家人只能投票 + 一句留言，不能回传"我来量 / 我拍了 / 我反对这个位置"的照片或行动；改造后对比图也没有回传到分享页。家人之间也不能对话。
2. 分享 URL 仍是「持有即可访问」：24h + 局域网限制已实现，但没有一次性令牌/防盗链/访问日志，链接被转发到局域网内任意人仍可投票（且回执只告诉主人"有新意见"，不告诉"谁转发了"）。

> 本轮已消除的三条（保留记录）：③ 投票后本人计数不即时刷新 → 已修为返回 targets/counts 就地更新；④「仅同一 Wi-Fi」无技术强制 → 已修为服务端 remoteAddress 网段校验；⑤ 主人不知道家人投了票 → 已修为 toast + 未读角标 + 滚动自动已读。

### 若要让它“无可挑剔”，我认为最该补的 3 件事（按用户价值排序，含本轮进度）
1. **家人意见的「回执」与轻提醒（价值最高、成本最低）** —— ✅ **本轮已实现并复测**：新票 toast「家人给了意见 · 支持 X · 犹豫 Y」、未读角标 `+N`（aria-label「N 条新意见」）、滚到卡后自动已读清零；不再需要主人手动刷新。
2. **分享页可回应（从表态到行动）** —— 仍待做：给家人一个低成本动作，例如「我周末来量 / 我拍了现场照 / 这个位置我不同意」；主人端能看到并继续流程（甚至允许家人上传一张现场照进 compare）。这是目前社交深度最大的缺口。
3. **把隐私承诺技术化（诚信护城河）** —— **本轮已完成约 80%**：不回落原图 ✅、targetId 校验 ✅、局域网强制 ✅、after「压缩版（≤1280）」口径 ✅；**剩下的是「分享 URL 防盗链/一次性」**（以及把 after 也统一到 900px 的进一步压缩）。

> 附带加分项：PWA（manifest/icons/standalone）实测可安装，对"家里手机用"这个场景是实际增强；gzip 让首屏传输从 ~89KB CSS 降到 15.8KB，移动端体感更好。

---

## 7. 已知边界

1. **真实第二台设备未用**：分享页在「同一台机器的两个独立浏览器上下文」验证（一张投票、一个 owner 视角），等价于「家人手机」但非真机；真机 Safari/iOS 未测。
2. **过期态为手工造数据**：真实 24h 未等待；虽新增 `SHARE_TTL_HOURS` 钩子，但实现有「最小 1 小时」钳制，无法 <1h 快速过期；最终仍按 Lead 授权手改 `app/data/shares/<token>.json` 的 `expiresAt`（测后清理），API 410 与页面 expired 态均已验证。
3. **同 Wi-Fi 网络层验证范围**：已完成服务端网段校验（loopback + 本机局域网网卡 192.168.1.5 放行）；「非私网来源 403」在本机无法模拟，只按代码路径（`isLanRequest`）审阅确认。
4. **loading 态未截图**：分享页骨架屏为瞬时状态，只验证了 HTML/JS 三态结构与 ready/invalid/expired 截图。
5. **分享页真实文案的模型多样性**：不同轮的 plan/catFit 内容会变（模型生成），本报告截图来自最终稳定轮；字段结构断言在每轮都执行。
6. **未覆盖**：真实支付（仍为演示解锁）、并发会话、真实家庭成员长期使用、分享链接被暴力扫描、after 照片 EXIF 隐私等。
7. **未读角标的自动已读**：`IntersectionObserver(threshold 0.35)` 在卡片进入视口时即清零；若用户一直停留在卡片可见区域，角标只会短暂出现（主通知是 toast）。这是「看过即已读」的设计取舍，不是缺陷；测试通过临时禁用 observer 单独验证角标、再恢复 observer 验证清零。

---

## 8. 复现方式与证据文件

```powershell
cd D:\OneProject
node app/server/index.mjs                 # 服务端（测试脚本会复用已监听进程）
node tests/api-e2e-v3.mjs                 # V3 服务端/分享页/LAN/TTL/PWA/gzip → PASS 13 阶段 212 checks
node tests/v3-shots.mjs                   # V3 双端 UI 6 场景 161 checks → 15 张截图
# 回归
node tests/dom-check.mjs
node tests/api-e2e.mjs
node tests/shot.mjs
node tests/api-e2e-v2.mjs
node tests/v2-shots.mjs
```

| 证据文件（`.scratch/`） | 内容 |
|---|---|
| `qa-e2e-v3-2026-10-24_04-31-58.json` | **P2 修复后 V3 服务端复测**：ShareView 快照、投票聚合与 bad_target、无缩略图 404、after、撤销/过期、LAN(192.168.1.5)、TTL 钩子、PWA、gzip 实测值 |
| `qa-v3-shots-2026-10-24_04-55-50.json` | **回执修复后 V3 最终 UI**：6 场景 161 checks（1 WARN 见 §10）、投票计数即时、关闭×热区 44、na=不涉及、未读角标/清零、每步结果与截图路径 |
| `qa-v3-shots-2026-10-24_04-53-27.json` | 回执调试轮（含 +1 角标渲染瞬间证据 `dbgAfterVote`） |
| `qa-e2e-v3-2026-10-24_04-26-53.json` | 同轮早期 api 跑（TTL 钩子首次探测，保留用于「发现问题→调整测试」记录） |
| `qa-v3-run-*.json` | 每个浏览器场景的 cdp 原始输出（steps/screenshots/diag/console） |
| `qa-e2e-2026-10-24_04-28-13.json` | V1 回归（A/B） |
| `qa-shot-2026-10-24_04-34-43.json` | V1 双端截图/导出/点选 |
| `qa-e2e-v2-2026-10-24_04-29-45.json` / `qa-v2-shots-2026-10-24_04-48-20.json` | V2 回归 |
| `qaV3r*.log` | P2/回执修复后复测轮的完整控制台输出 |
| `tests/screens/v3/*.png` | 15 张最终截图（handoff/share sheet/votes/unread/read/compare/分享页 ready/voted/invalid/expired，双端） |
| `tests/fixtures/share-thumb.jpg` | 测试用 900×675 / 25,708B 分享缩略图 fixture |

---

## 9. 验收工具自身问题（已修，非产品缺陷，记录以便复现）

1. **Node 19+ keep-alive 复用导致 `ECONNRESET`**：测试 HTTP 客户端与 8848 之间偶发连接被重置；已在 `tests/lib-qa.mjs` 的 `httpReq/postSSE` 加 `agent:false` 修复（服务端/产品无问题）。
2. **撤销/过期页的 404/410 被浏览器记为 console error**：属预期网络噪声；v3-shots 校验已按页面状态放行对应 4xx，仅对真正 JS 异常报错。
3. **390 截图重复/滚动未生效**：页面滚动容器是 `#feed` 而非 window；已改为直接滚动 `#feed` 后再截图；同时截图前强制两帧 rAF，避免无头模式取旧帧。
4. **分享面板遮挡 votes 截图**：已调整步骤顺序（先关面板再滚动截图）。
5. **`wait-for` 表达式被 URL-encode**（V2 时期）：导致等待超时、拍摄到最终态；已修正为原样传参。
6. **TTL 钩子测试**：`SHARE_TTL_HOURS` 被 `Math.max(1,...)` 钳到 1 小时，最初尝试 `0.0006h≈2s` 失败（实测仍 1h），改为断言「≈1h 且 ≠ 默认 24h」；过期 410 仍用 step 7 手改 expiresAt 覆盖。
7. **未读角标的瞬时性**：新票到达后 `renderVotesUI` 会自动把卡片带入视口，几何/IO 兜底立即 markRead → 角标清零，因此自动化在「渲染后 700ms」读不到 +1；改为在渲染瞬间（`debugAfterVote`）采样，并在最终轮以 WARN 记录，+1 的稳定证据由 Lead `verify-receipt.mjs` 6/6 覆盖。这不属于产品缺陷（「看过即已读」是设计）。

---

## 10. 家人意见回执（Lead 修复 + 独立复验）

### 10.1 背景与两个 bug
V3 首轮契约未要求「回执」，但本报告 §6 把「家人投票后主人不知道」列为第一优先级改进项。Lead 于 12:30 实现未读角标 + toast，随后在自测/交叉验收中发现两个 bug 并修复（改动仅 `app/public/js/flow.js`）：

| # | Bug | 修复 |
|---|---|---|
| 1 | 「首次进入」判定错误：用 `stored == null`，每次轮询都被判成首次 → **永远不弹 toast** | 改为 `votesPoll.fetches === 1 && stored == null`（只在本次会话第一次拉取时视为首次；之后新票走 diff 分支弹 toast） |
| 2 | IntersectionObserver 不触发时角标永远清不掉（无头/自定义滚动容器场景） | 新增几何已读兜底：卡片 ≥60% 落入视口即 `markVotesRead`，挂 scroll/resize（rAF 节流）+ 渲染后立即判一次 |
| 3 | `resetVotesPoll` 未重置 fetches | 补 `votesPoll.fetches = 0`（保证会话切换后首次判定正确） |

### 10.2 独立复验结果（本报告 v3-shots 最终轮）
| 断言 | 实测 |
|---|---|
| 首次拉取（feed 在顶部、卡片在视口外） | `data-unread="2"`、chip「+2」、`aria-label="2 条新意见"` |
| 卡片部分可见（<60%） | 角标仍为「+2」（截图 `v3-votes-unread-1440.png`） |
| 已读后再来 1 票（第 3 位家人） | toast「**家人给了意见 · 支持 2 · 犹豫 1**」；角标在渲染瞬间为「+1」（`data-unread="1"`，见 12:53 调试轮）——但新票渲染会把卡片自动带入视口，几何/IO 兜底随即自动已读清零，因此 +1 的独立证据以 Lead 的 `verify-receipt.mjs` 6/6 为准 |
| 滚动到卡片（≥60% 可见） | 几何兜底自动已读 → `data-unread="0"`、chip 消失（截图 `v3-votes-read-1440.png`） |
| 稳定性 | 全程无未捕获异常、无 JS console.error、无横向溢出 |

> 结论：**回执闭环成立** ——「家人投票 → 主人下次回来看到角标/toast → 看过即清零」这条链路可复现、可断言。
> 关于 ui-logic 的 `logic-v3d-report.json` 失败：是并发清库导致的测试环境问题（guest 页面拿不到 vote blocks + 末尾「会话不存在」），**不是功能缺陷**；该实现已由 Lead 复验 6/6 PASS，本报告在其后独立复验通过。

### 10.3 证据
- 本报告：`tests/v3-shots.mjs` 回执断言（初始 +2 角标、部分可见仍在、toast、滚动清零；+1 为 WARN）；截图 `tests/screens/v3/v3-votes-unread-1440.png` / `v3-votes-read-1440.png`；run JSON `qa-v3-shots-2026-10-24_04-55-50.json`（最终轮）与 `..._04-53-27.json`（+1 渲染瞬间调试证据）。
- Lead 侧：`node --experimental-websocket .scratch/verify-receipt.mjs` → 6/6 PASS（`toasts: ["家人给了意见 · 支持 1 · 犹豫 0"]`；已读后 `badge="" / cardUnread="0" / localStorage["corner.votesRead.<sessionId>"]="1"`）；证据图 `.scratch/receipt-after.png`、`.scratch/receipt-card.png`。
- ui-logic 侧：最终证据已写入 `.scratch/logic-v3d-report.json`（1440 toast+角标+意见卡同框、390 toast 不压输入框）；其早前 `logic-v3d-report.json` 失败是并发清库导致，不是功能缺陷。

---

## 11. 移动端 V3.1 + 真实场景规则（最终轮）

> 验收时间：2026-10-24 13:16—13:33（Asia/Shanghai）；服务端 13:28 重启后加载最终规则（`rules.mjs` mtime **13:23:48**；期间 13:21/13:28 进程重启过两次，所有最终结论均来自 13:28 后的冻结代码）。
> 复跑命令（Node 20.20 需要 `--experimental-websocket`，否则 `.scratch/mobile-audit.mjs` 报 `WebSocket is not defined`）：
> `node --experimental-websocket .scratch/mobile-audit.mjs --w=390 --h=844 --photo=real-washer-corner.jpg --stage=l0`
> `node .scratch/real-case-check.mjs`

### 11.1 移动端三尺寸审计（独立实测，不是引用 Lead 数字）

| 尺寸 | overflowX | banner | composer | 内容区 | 首屏 ≥44px 主操作 | tiny<40 |
|---|---|---|---|---|---|---|
| 390×844 | false | `""` | **74px** | **80%** | 「先量这个：可用进深」**318×44**，top=474（首屏） | **0** |
| 360×800 | false | `""` | **74px** | **79%** | 「先量这个：墙角 A 边长」**288×44**，top=430（首屏） | **0** |
| 412×915 | false | `""` | **74px** | **82%** | 「先量这个：可用进深」**340×44**，top=545（首屏） | **0** |

断言全部通过：`composer ≤112`、`内容区 ≥73%`、`首屏有 ≥1 个 44px 主操作`、`tinyButtons=0`、`overflowX=false`、`banner=""`。
390 关键卡片高度：quality **133px**（改造前 423）、推荐方向卡 **313px**（改造前 788）；与 Lead 的权威 audit 数字一致（composer 161→74、内容区 63%→80%、quality 423→133、推荐卡 788→313、主 CTA 首屏可见、tiny 1→0）。
证据截图：`tests/screens/v31/v31-mobile-390x844-l0.png`、`v31-mobile-360x800-l0.png`、`v31-mobile-412x915-l0.png`；日志 `.scratch/qaV31-audit-390.log` / `-360.log` / `-412.log`。

### 11.2 真实照片规则复验（`.scratch/real-case-check.mjs`，13:19 轮）

| 案例 | quality | 当轮推荐方向 | plan verdict | headline | catFit 关键项 |
|---|---|---|---|---|---|
| 洗衣机旁（real-washer-corner） | **retake** | d1 清空后放半包猫窝 | **insufficient** | 照片不合格，先重拍再定 | hide pass / litter na |
| 三个敞口盆（real-litter-corner） | pass | d1 墙角放砂盆 | **conditional** | 右墙角尺寸够放砂盆… | hide **warn**（见 OBS-V31-1）/ litter warn |
| 冰箱+食盆（real-fridge-floor） | pass | d2 复用纸箱做遮挡 | **conditional** | 墙角尺寸够，先挪纸箱再定落点 | resources warn / litter na |
| 衣架+纸箱砂盆（real-rack-corner） | retake | d1 洗衣机左侧放砂盆 | **insufficient** | 照片不合格，先重拍再定 | hide na / litter fail |

**为什么 washer/fridge 没直接得到 `not_supported`**：L0 方向与推荐是模型生成、每轮会变；当轮**推荐方向不是砂盆方向**（washer 推荐猫窝、fridge 推荐纸箱）时不会触发位置否决，只按 retake/条件降级。为验证规则本身，我逐方向跑了 `measure→plan` 探针（`.scratch/qaV31-directions.mjs`，4 张照片 × 全部方向）：

- **washer（3/3 砂盆方向）** → `not_supported`，headline「**先别放：旁边是洗衣机，猫会不敢上厕所**」；catFit 砂盆条件 **fail**；blocked **位置否决：砂盆条件** ✅
- **fridge（2/2 砂盆方向）** → `not_supported`，headline「**先别放：旁边是冰箱，猫会不敢上厕所**」；catFit 资源是否分开 **fail** + 砂盆条件 fail；blocked 位置否决 ✅
- **litter（3 方向）** → 全部 conditional（砂盆尺寸 warn）；d2/d3 为猫窝方向 hide=pass；d1 砂盆方向的 hide 见 OBS-V31-1
- **rack（retake）** → d1/d3 insufficient；**d2 因砂盆 fail → not_supported**（位置否决优先级高于 retake，属合理设计）

结论：**V3.1 的位置否决规则本身工作**（砂盆 + 靠近家电/食盆 → not_supported + 先别放 + blocked），但 `real-case-check.mjs` 当前「washer/fridge 必为 not_supported」的断言**依赖 L0 推荐方向，存在模型非确定性 flaky**；建议脚本改为显式选择标题含「砂盆」的方向再断言，retake 断言改为「无 fail 时为 insufficient」。

#### 13:32 最终规则复测（重要：rules.mjs 在验收期间被更新到 13:23:48）
验收过程中 `app/server/rules.mjs` 从 13:14/13:19 版本更新到 **13:23:48**（ai-engine 最后一次改动），服务端 13:28 重启后加载最终版。为确认结论适用最终代码，我用同一探针重跑了 washer/fridge/litter（日志 `.scratch/qaV31-final-*.log`）：

| 案例（最终规则） | 结果 | 与 Lead 断言的差异 |
|---|---|---|
| washer（3/3 砂盆方向） | 全部 **insufficient**「照片不合格，先重拍再定」；catFit 砂盆条件 **fail** + blocked **位置否决：砂盆条件** | ❌ 不是 `not_supported`：最终规则里 **retake 优先**（`rules.mjs` L1366 把 retake cap 到 insufficient，min 后压过 not_supported） |
| fridge（3/3 砂盆方向） | 全部 **not_supported**「先别放：旁边是冰箱，猫会不敢上厕所」；resources fail + litter fail + blocked 位置否决 | ✅ 与 Lead 断言一致 |
| litter（3 方向） | conditional ×3；hide = pass/na（本轮未复现 13:20 看到的「开放式垫子」warn） | 见 OBS-V31-1 注 |

**判断**：washer 的「先重拍」优先于「先别放」在语义上可以接受（照片不合格时确实应先重拍），但 Lead 任务里的断言写的是两例都 `not_supported`——**该断言在最终代码上对 washer 不成立**。若产品意图是「即使照片不合格，只要位置否决就要先说先别放」，需要调整 L1366/L1371 的优先级；请 Lead 确认预期，我再据此固化断言。

#### OBS-V31-1（P2，潜在边缘）：砂盆方案复用的「现有白色塑料大盆」可能落到猫窝 hide 文案
- 现象：litter-corner 方向「墙角放砂盆，复用现有白盆」→ plan verdict conditional；items = 现有白色塑料大盆(`fit=blocked`) + 开放式猫砂盆 + 顶入式猫砂盆；`catFit.hide.status=warn`，why=「只有开放式垫子，没有三面遮挡…」（应为 `na`「这次方案是砂盆，不涉及休息点」）。
- 根因（代码）：`categoryOfItem` 对无 SKU、标题不含「砂盆/厕所/抓板/爬架」的复用物品默认返回「猫窝」；`现有白色塑料大盆` 因此进入 `restItems`，`planCategoryLabel` 变成「用品」，hide 走「有休息点但无遮挡」的 warn 分支。
- 影响：用户选了砂盆方案，却看到猫窝的「开放式垫子」评语——与 Lead 刚修掉的「砂盆方案复用猫窝文案」是同一类问题，只是被“复用盆”绕过。
- 建议：复用盆按 direction/场景上下文归为砂盆（或 `restItems` 排除 `fit=blocked` 与「盆/砂」文本）；分享页同理。复测断言建议：猫砂盆方案 `hide.status` 应为 `na`（除非方案同时含猫窝/爬架休息点）。
- 证据：`.scratch/qaV31-directions-litter.json`（13:20 规则：d1 hide=warn、items 含「现有白色塑料大盆」）；`.scratch/qaV31-final-litter.log`（13:32 最终规则：同案例未复现，plan 变为「带盖砂盆」，hide=pass/na）。
- **最终规则状态**：未复现 ≠ 已修复——`categoryOfItem` 的「无 SKU→默认猫窝」分支仍在；本轮只是模型没生成“复用白盆”item。建议按下述修一版并加定向测试（断言：含 `现有…盆` 的砂盆方案 hide 必须 na），否则换一组照片/换个模型版本就可能回归。

#### 其他边界（非缺陷，记录）
- `catFit.hide=na` 在纯砂盆方向（rack d1/d2）符合预期；litter d2/d3 是猫窝方向 hide=pass；只有“复用大盆”这一条被误分类，见 OBS-V31-1。
- retake 与 veto 同时存在时，`not_supported` 优先（rack d2）；Lead 的「retake 仍 insufficient」只在无 fail 时成立。
- 移动端截图来自 CDP 真仿真（deviceScaleFactor=2、touch），不是真机 iOS Safari；`visualViewport` 键盘抬升无法在无头验证。
- `.scratch/mobile-audit.mjs` 使用全局 `WebSocket`，Node 20.20 必须加 `--experimental-websocket`（已在复跑命令注明）。

### 11.3 既有回归（同一冻结服务端）
| 套件 | 结果 |
|---|---|
| `dom-check` | **PASS 5 checks** |
| `api-e2e`（V1） | **PASS 4/4，46.3s** |
| `api-e2e-v2` | **PASS 6 阶段 690 checks，62.0s** |
| `api-e2e-v3` | **PASS 13 阶段 221 checks，21.6s**（含 LAN/TTL/PWA/gzip） |
| `v3-shots` | **PASS 161 checks / 6 场景**（回执 +1 本轮也捕获到：`unread=1/chip=+1`；滚动清零 0） |

证据：`.scratch/qa-e2e-2026-10-24_05-24-21.json`、`qa-e2e-v2-...05-25-08.json`、`qa-e2e-v3-...05-26-10.json`、`qa-v3-shots-...05-26-32.json`，以及 `qaV31-reg-*.log`。
> 说明：13:21 左右服务端重启过一次（探针出现一次 `ECONNRESET`），以上结果均来自重启后的稳定服务端。

### 11.4 独立判断：现在这个手机端，我会给普通用户用吗？

**会——但会先挑人。** 作为「拍一张 → 先量一个数 → 拿一个可执行结论」的轻工具，390/360/412 的首屏已经能在不滚动的情况下完成第一次决策：主 CTA 可见且 44px、触控 0 个不达标、无横向溢出；真实照片的「先别放」和位置否决让它在「不骗人」这件事上明显前进了一步。我会推荐给愿意读两句说明、会拍第二张照片的年轻用户；不会原样推荐给爸妈一辈，除非先修下面 3 处。

**最刺眼的 3 个地方（按严重度）**
1. **「建议重拍」与主 CTA「先量这个」互相打架** —— 质量卡说照片不合格，首屏最显眼的橙色按钮却是「先量这个：…」。用户会认真量 3—6 个数，最后拿到「照片不合格，先重拍再定」（washer/rack 实测），等于白量。建议：quality=retake 时把主 CTA 换成「重拍/换一张」，测量降级为「仍要先量」的次要入口或直接禁用。
2. **首屏没有「我在看哪个角落」，反而有两段“上次…”** —— 顶部「继续上次的角落。下面是当时的结果，按顺序重放…」+「上次的照片质检结果。」在 360/390 吃掉约 100px（首屏 12%），第一眼像在看历史报告而不是当前任务；且 `#stage-top` 高度为 0，角落标题不可见。建议：一行状态条 + 角落标题常驻，首次进入不显示回放解释。
3. **质量卡文案被截断且没有「重拍」动作** —— 390 显示「…杂物把墙…」、360 显示「…地…」，只有 35×44 的「详情⌄」；用户知道要重拍，却在卡片里找不到按钮。建议：质量卡右侧直接放「重拍」主按钮，详情降为二级；同时避免半句省略。

（次要：底部「空间画布」44px 抽屉把手与 composer/键盘抢空间；`详情⌄` 宽 35px 偏小；真机 iOS 键盘/安全区未验。）

### 11.5 本节证据
- 移动端截图：`tests/screens/v31/`（390/360/412 L0 三尺寸；`v31-real-washer-plan-390.png` 为洗衣机案例 plan/handoff 的移动端布局截图——该轮 replay 的结论是「还差关键数字」，not_supported 的规则证据以定向探针日志为准，原因是模型每轮的 L0 方向/质量判定会变）
- 审计日志：`.scratch/qaV31-audit-{390,360,412}.log`、`.scratch/qaV31-washer-plan.log`
- 真实照片：`.scratch/qaV31-real-cases.log`、`.scratch/qaV31-directions.log`、`.scratch/qaV31-directions-litter2.log`、`qaV31-directions-litter.json`、`qaV31-directions.json`；最终规则复测 `.scratch/qaV31-final-{washer,fridge,litter}.log` 与 `qaV31-final-*.json`
- 回归：`.scratch/qaV31-reg-*.log` 及对应 `qa-*.json`
- 说明：移动端审计（13:18—13:20）在 `rules.mjs` 13:23:48 更新前完成，但审计的是布局/CSS 指标（CSS 最后改动 13:06，未被规则影响）；13:32 最终规则复测主要确认内容规则。

---

_本报告只记录真实实测结果。V3.1 最终结论：移动端三尺寸审计 PASS；位置否决规则工作；发现 1 条新 P2（OBS-V31-1：复用盆被误分类导致砂盆方案 hide 文案回退）与 1 条脚本断言 flaky（real-case-check 依赖 L0 推荐方向）。_
