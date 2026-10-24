# 部署说明（拿到公网链接的三条路）

代码本身是**一个 Node 进程 + 文件系统**的应用（服务端要持有 API Key、跑 SSE、存照片），
所以它不能直接丢到 GitHub Pages（Pages 只能放静态文件）。下面三条路任选一条。

---

## 路线 A：Render 免费 Web Service（推荐，最快拿到链接）

1. 打开 <https://render.com> → 用 GitHub 登录；
2. **New → Blueprint** → 选仓库 `xxxd86/VibeCorner`（仓库里已有 `render.yaml`）→ Apply；
3. 在服务的 **Environment** 里填两项：
   - `DEEPSEEK_API_KEY` = 你的 key（仓库里没有，也不会提交）
   - 其余已由 `render.yaml` 配好（`SHARE_LAN_ONLY=0`、`NODE_VERSION=20`…）
4. 等 1—2 分钟，拿到形如 `https://vibe-corner-xxxx.onrender.com` 的**公网地址**；
5. 之后每次 `git push` 到 `main`，Render 会自动重新部署（`autoDeploy: true`）。

> 想同时让 Actions 里出现「部署」这一步：Render 服务页 → **Settings → Deploy Hook**，
> 复制 URL，粘到仓库 `Settings → Secrets and variables → Actions → New repository secret`：
> 名字 `RENDER_DEPLOY_HOOK`。之后 `.github/workflows/deploy-render.yml` 会在 push 时触发它。

**免费档的限制**：15 分钟无访问会休眠（下次访问冷启动 ~30s）；容器磁盘是临时的，
重新部署后会话/照片会清空——演示够用，正式用请挂持久盘或换数据库。

---

## 路线 B：Docker 镜像（已经自动构建，无需任何账号配置）

push 到 `main` 后，`.github/workflows/docker.yml` 会自动构建镜像并推到 GHCR：

```
ghcr.io/xxxd86/vibecorner:latest
```

远程链接（包页面）：
<https://github.com/xxxd86/VibeCorner/pkgs/container/vibecorner>

在任何装了 Docker 的机器上跑：

```bash
docker run -d --name vibe-corner -p 8848:8848 \
  -e DEEPSEEK_API_KEY=sk-你的key \
  ghcr.io/xxxd86/vibecorner:latest
```

打开 <http://localhost:8848>。

> 如果包页面显示 404：仓库 `Settings → Actions → General` 里把 Workflow permissions 设为
> **Read and write**，或第一次跑完后到 **Packages** 里把包设为 public。

---

## 路线 C：VPS / 任意服务器

```bash
git clone git@github.com:xxxd86/VibeCorner.git
cd VibeCorner
cp app/.env.example app/.env   # 填 DEEPSEEK_API_KEY
node app/server/index.mjs
```

配合 systemd / pm2 常驻即可；`HOST=0.0.0.0` 让它对公网可达，
公网部署时把 `SHARE_LAN_ONLY=0`（否则家庭分享页只放行内网地址）。

---

## CI 会做什么（`.github/workflows/ci.yml`）

每次 push / PR：

1. `node --check` 检查服务端 + 前端全部 JS 语法；
2. `tests/dom-check.mjs`：校验 `index.html` 里 41 个必需 DOM id、CSS/JS 资源引用、错误兜底；
3. 启动服务 → `/api/health`、`/api/evidence`、`/`、`/share.html`、`/manifest.webmanifest`、
   `/js/app.js`、`/styles/base.css` 全部断言 200；验证 gzip 生效；
4. 若仓库配了 `DEEPSEEK_API_KEY` secret，额外跑一次真模型回归（`scripts/test-ai.mjs --quick`）。

> CI 里不配 Key 也能全绿：`/api/analyze` 会返回 503，但静态资源、会话、证据目录都正常。

---

## 安全提醒

- `app/.env`（含真实 Key）已在 `.gitignore` 里，**不会进仓库**；提交前可用
  `git status --short` 确认它没出现在列表里。
- 仓库里的 key 一旦泄露要立刻在 DeepSeek 控制台轮换。
- 公网部署后任何人都能打开你的站点并消耗你的 API 额度，建议加额度上限或访问口令。

---

## 本仓库已实测的状态（2026-10-24）

- push 到 `main` 后：
  - `CI` ✅ success（语法 / DOM 契约 / 冒烟 / gzip 全绿）
  - `Docker 镜像` ✅ success（镜像已推到 GHCR）
  - `部署到 Render` ✅ success（当前未配 Deploy Hook，只走"跳过"分支）
- GHCR 包默认可能是 **private**：`api.github.com/users/<user>/packages` 返回 401 属正常。
  要给别人 `docker pull`，需要：仓库 → **Packages** → 该包 → Settings → Change visibility → **Public**。
- 仓库是 **public**，所以 CI 里不带 Key 也能跑；只有"真模型回归"那一步需要
  `Settings → Secrets and variables → Actions → DEEPSEEK_API_KEY`。
