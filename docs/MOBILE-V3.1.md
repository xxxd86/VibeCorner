# 移动端体验硬指标（V3.1 · 真机视角）

> 依据：真机截图 + `mobile-audit.mjs` 在 390×844 / 360×800 / 412×915 的实测。
> 原则：**手机上首屏必须能完成第一次决策**，而不是让人先滚两屏。

## 1. 当前实测（390×844，真实照片 `real-washer-corner.jpg`）

| 指标 | 现在 | 目标 |
|---|---|---|
| 顶部 rail | 56px | **≤ 48px** |
| 输入区 composer | **161px（19%）** | **≤ 112px** |
| 画布抽屉把手 | 52px，且与 composer 重叠 | **44px，独立不重叠** |
| 内容区 feed | 531px（63%） | **≥ 620px（≥73%）** |
| 推荐方向卡 | **788px**（比内容区还高） | **≤ 340px** |
| 主 CTA「先量这个」 | **不在首屏** | 首屏可见（`top+height ≤ 844-112-44`） |
| 触控目标 <40px | 1 个（看这个区域 36px） | **0 个** |
| quality 卡 | 423px | **≤ 140px**（详情折叠） |

## 2. 明确的结构要求

### 2.1 顶部 rail（手机）
- 高度 ≤ 48px；只保留品牌字（14px）+「＋」图标按钮（44×44）。
- 会话列表移入抽屉（左侧滑出），不再占顶部空间。

### 2.2 composer（手机）
三行压缩成两行，隐私文案折叠进 ⓘ：
```
[通道多宽] [门口能放吗] [窗边晒吗]        ← 32px 高、横向滚动、可整体隐藏
[📷] [想放什么…            ] [↑]         ← 44px 高
[ⓘ 猫：中型·1只]                          ← 16px 高，隐私/删除入口放这里
```
- chips：单行横向滚动，高 32px；**有会话内容后不再显示**（只在欢迎态显示）。
- 猫档案 chip 与「隐私与数据」合并成一行 12px 文本，点击打开猫档案/隐私弹层。
- 目标：`#composer` 高度 ≤ 112px（不含安全区）。

### 2.3 方向卡（手机）—— 一屏一卡
```
┌─────────────────────────────┐
│ 01  墙角换半包式砂盆   [推荐先试] │  ← 一行，标题 17px
│ 把包和衣物挪走，墙根贴墙放半包窝  │  ← 最多 2 行
│ [ 先量这个：墙角 A 边长  › ]     │  ← 主 CTA，全宽 44px
│ [看这个区域]  [更多细节 ⌄]       │  ← 次级，各 44px 高
└─────────────────────────────┘
（展开「更多细节」后才有：区域 r1 / 风险 / 为什么推荐 / 退出说明 / 免责）
```
- 折叠的其它方向卡：一行 48px（序号 + 标题 + 展开箭头），不显示描述。
- 推荐标记用徽章，不要单独一行。
- 目标：折叠态推荐卡 **≤ 340px**；整张 directions 卡 ≤ 500px。

### 2.4 quality 卡（手机）
- 折叠态 ≤ 140px：`照片可用` 徽章 + 一句 `我看到的是：<recognition 前 20 字>` + 「详情 ⌄」。
- 展开后才是现有明细（问题列表 / 补拍建议）。

### 2.5 画布抽屉
- 把手 44px（含安全区），位于 composer **下方**，不覆盖输入框。
- composer 的 `padding-bottom` 必须 ≥ 把手高度。

### 2.6 滚动行为
- L0 渲染完成后，**自动把推荐方向卡滚到顶上**（`block:'start'`），让主 CTA 进入首屏。
- 测量卡渲染后用同样方式滚到卡顶。
- 任何自动滚动都要尊重 `prefers-reduced-motion`（用 `behavior:'auto'`）。

## 3. 验收（必须用 `mobile-audit.mjs`）
```powershell
node --experimental-websocket .scratch/mobile-audit.mjs --w=390 --h=844 --photo=real-washer-corner.jpg --stage=l0
node --experimental-websocket .scratch/mobile-audit.mjs --w=360 --h=800 --photo=real-litter-corner.jpg --stage=l0
node --experimental-websocket .scratch/mobile-audit.mjs --w=412 --h=915 --photo=real-rack-corner.jpg --stage=plan
```
通过标准（三种尺寸 × 三种 stage 都要）：
- `overflowX === false`、`banner === ''`
- composer ≤ 112、rail ≤ 48、内容区 ≥ 73%
- **首屏能看到至少一个主操作按钮**（`buttons` 里 `inView && h>=44` 至少 1 个，且文本是「先量这个」类）
- `tinyButtons.length === 0`
- 推荐卡高度 ≤ 340
