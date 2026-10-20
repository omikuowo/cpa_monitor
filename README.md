# CPA Monitor

CPA 反代工具的 Codex 额度监测面板：集中查看多个 CPA 实例的认证文件、401 失效、额度受限和剩余额度。

- **一键部署**：点按钮部署到 Cloudflare Workers，KV 存储自动创建，不需要填任何环境变量
- **网页配置**：首次打开进入初始化向导，管理员密码、CPA 地址和密钥、检测参数全部在网页里填写，之后可以随时在「设置」里修改
- **定时检测**：后台 Cron 按设定的间隔自动检测，访客打开就能看到最新结果
- **访客模式**：可公开或仅管理员可见；隐私模式会在服务端对访客脱敏文件名、账号和邮箱
- **自托管**：同一份代码也能用 Docker 跑在自己的服务器上

## 部署

### 方式一：Cloudflare 一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/omikuowo/cpa_monitor)

1. 点击上面的按钮，登录 Cloudflare，按提示授权 GitHub
2. 页面会显示 `CPA_MONITOR_KV`，保持默认，它会自动创建
3. 点击部署，完成后打开 `https://cpa-monitor.<你的子域>.workers.dev`
4. 按向导设置管理员密码、添加 CPA 实例，完成

部署按钮会把仓库复制到你的 GitHub 并开启自动构建，之后推送到这个仓库就会自动重新部署。需要自定义域名时，在 Cloudflare 的 Worker 设置 → 域和路由里添加。

### 方式二：命令行部署到 Cloudflare

```bash
git clone https://github.com/omikuowo/cpa_monitor && cd cpa_monitor
npm install
npx wrangler login
npm run deploy   # KV namespace 会自动创建并绑定
```

### 方式三：Docker 自托管

```bash
git clone https://github.com/omikuowo/cpa_monitor && cd cpa_monitor
docker compose up -d
```

打开 `http://服务器IP:8787` 进入初始化向导。数据保存在 Docker volume `cpa-data` 中。

不用 Docker 时，直接用 Node.js 20+ 运行也可以：

```bash
npm start   # 数据默认保存在 ./data，可用 DATA_DIR 和 PORT 修改
```

放在 Nginx / Caddy 后面并启用 HTTPS 时，设置 `TRUST_PROXY=true`，这样登录限速才能拿到真实 IP，Cookie 也会带上 `Secure`。

## 初始化与安全

- 部署后第一个打开网站的人会进入初始化向导。如果担心别人抢先初始化，可以在部署时设置环境变量 `SETUP_TOKEN`，向导会要求输入它
- 管理员密码用 PBKDF2 加盐哈希后保存，登录态是 HttpOnly + SameSite=Strict 的 Cookie，连续输错 8 次会锁 10 分钟
- CPA 管理密钥只保存在服务端，设置页面里只显示末 4 位；编辑实例时密钥留空表示不修改
- 访客的检测请求在缓存期内（默认 60 秒）直接复用结果，不会反复请求 CPA

## 可选环境变量

全部可选，正常使用不需要设置任何一个。

| 变量 | 说明 |
| --- | --- |
| `SETUP_TOKEN` | 初始化口令，设置后向导会要求输入 |
| `ADMIN_PASSWORD` | 用环境变量管理管理员密码（会覆盖网页设置的密码） |
| `CPA_BASE_URL` / `CPA_ACCESS_KEY` / `CPA_INSTANCE_NAME` | 兼容旧版：以只读方式附加一个 CPA 实例 |
| `CPA_INSTANCES_JSON` | 兼容旧版：JSON 数组形式附加多个只读实例 |

## 从旧版（Cloudflare Pages）迁移

旧版用 Pages + Functions，配置全部写在环境变量里。新版是 Worker + KV：

1. 用上面任意一种方式部署新版，在向导里重新填写 CPA 地址和密钥
2. 确认新版正常后，删除旧的 Pages 项目

旧版的环境变量（`ADMIN_PASSWORD`、`CPA_BASE_URL` 等）依然有效，所以也可以把它们填到新 Worker 的变量里直接沿用。

## 检测说明

- 先通过 `GET /v0/management/auth-files` 拉取认证文件，只保留 Codex 文件
- 再通过 `POST /v0/management/api-call` 用每个认证文件请求 `https://chatgpt.com/backend-api/wham/usage`
- 结果分类：`正常`（2xx）、`401 失效`、`受限`（403 / 429 / 额度不足）、`上游错误`（5xx）、`检测错误`（超时、网络等）、`已跳过`（disabled）
- Cloudflare 免费版单次请求最多 50 个子请求，所以检测按每批 40 个分批进行，页面上会显示进度；定时检测每次最多补检 45 个最久未检测的文件

## 本地开发

```bash
npm install
npm run dev     # wrangler dev，本地模拟 KV 和定时任务
npm test        # 接口测试（使用模拟 CPA）
```

目录结构：

```text
src/            Worker 后端
  index.js        路由、初始化、登录、设置接口
  service.js      列表拉取、分批检测、定时检测、视图脱敏
  cpa.js          CPA 管理接口客户端与额度解析
  auth.js         密码哈希与会话
  store.js        KV 中的配置 / 快照
public/         前端静态文件（无构建步骤）
server/node.js  Node.js / Docker 自托管入口
tests/          node:test 测试
```
