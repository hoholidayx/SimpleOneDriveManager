# Simple OneDrive Manager

基于 Node 24、React 19、Vite 8、TypeScript 和 Ant Design 6 的本机 OneDrive 管理系统。后端使用 Fastify 5、MSAL Node 和 Node 内置 SQLite。

适合一个人在本机管理一个国际版 OneDrive，支持个人微软账号和 Microsoft 365 工作 / 学校账号。

## 快速开始

需要 Node **24.x**、npm，以及 macOS / Linux 的 `ps`、`lsof`。

```sh
npm install
npm run setup
# 在 .env 填写微软应用信息（见下节）
npm run build
./manage.sh start
./manage.sh status
```

默认地址是 <http://localhost:3000>。如果端口已被占用，请按下方说明调整本机配置。页面和接口都由同一后台服务提供；不需要启动 Vite 才能使用。

未配置微软应用时可以打开配置指引，文件管理在完成授权后启用。

```sh
./manage.sh stop
./manage.sh restart
./manage.sh status
```

根目录的 `manage.sh` 支持从任意工作目录调用，提供 `start`、`stop`、`exit`、`restart`、`status`、`build`、`logs` 和 `help`。`exit` 等同于停止服务；`./manage.sh logs --follow` 持续查看日志，Ctrl+C 仅退出日志查看。

`start` / `restart` 在构建产物缺失时自动构建；已有产物时直接使用。修改源码后执行 `./manage.sh build && ./manage.sh restart`。首次使用先安装依赖；脚本不会自动安装软件或依赖。原有的 `npm start`、`npm stop`、`npm run restart`、`npm run status` 仍可使用。

## 配置微软 OAuth

1. 在 [Microsoft Entra 应用注册](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app) 中创建应用，支持的账户类型选择“任何组织目录中的账户和个人 Microsoft 账户”。
2. 添加 **Web** 平台，注册精确的回调地址，默认是 `http://localhost:3000/api/auth/callback`。如已修改端口，以本机“连接设置”显示的地址为准。不要选择 SPA 平台。
3. 添加 Microsoft Graph **委托权限** `User.Read`、`Files.ReadWrite`。授权流程也会请求 `openid`、`profile`、`offline_access`。组织策略可能要求管理员批准。
4. 在“证书和密码”中创建客户端密钥，复制**密钥值**，不是密钥 ID。
5. 将应用的客户端 ID 和密钥值写入本机 `.env` 的 `MS_CLIENT_ID`、`MS_CLIENT_SECRET`。密钥含 `#` 等字符时用双引号包裹完整值。不要使用 `VITE_` 前缀保存密钥。
6. 执行 `npm run restart`，回到“连接设置”检查配置，然后点击“连接 OneDrive”。

| 环境变量 | 用途 |
| --- | --- |
| `MS_CLIENT_ID` | 微软应用客户端 ID |
| `MS_CLIENT_SECRET` | 微软应用客户端密钥值 |
| `MS_TENANT_ID` | 默认 `common`；也可指定 `consumers`、`organizations` 或租户 GUID |
| `APP_ORIGIN` | 页面返回地址，默认 `http://localhost:3000` |
| `MS_REDIRECT_URI` | 微软 Web 回调完整地址，必须与应用注册一致 |
| `PORT` | 后端监听端口，默认 `3000` |
| `TOKEN_ENCRYPTION_KEY` | `npm run setup` 自动生成的 32 字节 Base64 加密密钥 |

端口变更时同步修改 `PORT`、`APP_ORIGIN`、`MS_REDIRECT_URI`，并更新微软应用注册的回调地址。请始终使用同一个主机名访问，例如 `localhost`；`127.0.0.1` 的浏览器会话与其独立。

登录使用授权码流程、PKCE、一次性 state 和 nonce，后端交换并刷新令牌。浏览器只保存 HttpOnly / SameSite 会话 Cookie；写操作还校验 CSRF 和来源。账号授权与会话在重启后保留，有效会话期限为 7 天；微软要求重新授权时页面会提示连接。退出清除本应用的账号、缓存、会话及上传任务，不退出其他应用中的微软账号。

只有一个账号可绑定。其他浏览器可重新授权同一账号；更换账号前，先在原会话中断开连接。

## 文件管理

- 浏览目录、面包屑、懒加载目录树、详情和容量信息；每次加载最多 100 项，点击“加载更多”继续。筛选、排序和全选作用于已加载的项目。
- 支持文本列表与图片网格，记住上次布局。列表不请求缩略图；网格只为可见图片加载中等缩略图，最多并发 6 个请求，其他文件显示类型图标。
- 点击图片打开大缩略图预览；只有点击“查看原图”才在弹窗内加载原文件，并提供缩放和实际大小查看。缩略图失败不会自动加载原图，HEIC 等无法解码的原图可以用“下载文件”保存后查看。
- 多文件选择或拖拽上传；支持空文件。已存在同名文件时询问覆盖、保留两份或跳过。
- 单文件下载、替换内容、重命名；替换内容保持云端文件名不变。
- 新建、重命名、移动和删除文件夹；移动与删除支持最多 500 项的批量操作，每项单独报告结果。
- 删除进入 OneDrive 回收站；恢复操作请在 OneDrive 中完成。删除文件夹会包含其全部内容。
- 移动限于当前账号的同一网盘。根目录受保护，不能将目录移入自身或后代目录。
- 更改和删除携带支持的 ETag 条件；遇到并发修改时先刷新再操作。

### 上传恢复

不超过 10 MiB 的文件一次上传；更大的文件使用微软上传会话，每片 10 MiB，单文件顺序传输，最多并行 3 个文件。

“传输任务”中可以暂停、继续或取消。暂停和取消会在当前分片结束后生效。页面刷新或服务重启后，选择原文件并核对文件名、大小、修改时间后继续；后端会向 OneDrive 核对实际已接收的范围。浏览器不能自动重新取得本机文件访问权。

上传会话过期后需要重新上传。若最后一片响应因网络中断丢失，可能出现云端已完成而任务未确认的情况；请先刷新目录检查结果，再决定重新上传。当前不提供整个文件夹上传、文件夹打包下载、在线编辑、分享权限、回收站管理或跨盘移动。

## 本地数据与后台进程

`.env` 和 `.runtime/` 已忽略提交。

- `.runtime/app.sqlite`：账号、加密 MSAL 缓存、会话及加密上传任务。文件内容直接转发至 OneDrive，不在本机做完整副本。
- `.runtime/service.json`：PID、进程启动标识、完整启动命令、项目路径、运行实例、监听端口和日志位置。
- `.runtime/stdout.log`、`.runtime/stderr.log`：服务日志。授权码、Cookie、Authorization 等不会写入请求日志。

启动脚本使用 Node 的独立会话 / 进程组，标准输入关闭、标准输出和错误重定向，并解除父进程引用。服务显式处理 `SIGHUP`；启动命令结束后服务继续运行。启动会核对 PID、端口所属进程和 `/health` 返回的实例标识。停止发送 `SIGTERM`，等待当前请求关闭；不自动强杀或按端口杀进程。

停止或重启前会验证 PID 的启动时间、完整命令和入口路径。端口被其他程序占用、PID 复用或运行记录不匹配时拒绝操作。启停操作加锁，重复启动会报告已有服务。当前只监听 `127.0.0.1`，不提供登录自启、系统托管或异常自动恢复。

备份或迁移授权时，应同时保留 `.env` 的加密密钥和 `.runtime/app.sqlite`。修改密钥后旧缓存无法解密；需要恢复原密钥，或停止服务、移走旧数据库及其 `-wal` / `-shm` 文件后重新授权。不要将这些文件提交到仓库。

## 开发和检查

后台生产服务与开发后端使用同一端口，开发前先执行 `npm stop`。

```sh
npm run dev
# 前端 http://localhost:5173；后端使用 .env 的 PORT
# 开发启动会将 APP_ORIGIN 覆盖为 http://localhost:5173
# 微软回调仍使用 .env 中的后端回调地址

npm run typecheck
npm test
npm run build
```

前端代理 `/api` 和 `/health`；后端依然只监听本机。开发与生产共享本机账号缓存，因此请关闭开发进程后再运行 `npm start`。

测试使用内存模拟 OneDrive，不调用真实微软账号。覆盖授权会话边界、目录 CRUD、批量部分失败、下载字节、ETag、同名处理、分片中断恢复、加密持久化和独立后台服务启停。`tests/browser-fixture.ts` 仅用于本机浏览器验收，通过显式注入内存网盘启动，与生产入口分离。

图片预览浏览器验收使用 Playwright 和已安装的 Google Chrome：

```sh
npm run build
npm run browser:start
npm run test:browser
npm run browser:stop
```

测试服务默认监听 `127.0.0.1:3101`；可通过 `ODM_BROWSER_TEST_PORT` 指定独立端口。`browser:start/stop/restart/status` 复用生产服务的后台启动和进程归属检查，记录与日志位于 `.runtime/browser-check/.runtime/`。页面使用内存测试账号，绝不连接真实 OneDrive。浏览器测试覆盖请求分级、按需原图、失败重试、取消、并发限制和窄屏布局；截图保存在 `.runtime/browser-screenshots/`。若使用 Playwright 自带 Chromium，先运行 `npx playwright install chromium`，再设置 `ODM_BROWSER_CHANNEL=chromium`。

**真实 OneDrive 验收需要有效 Client ID、Client Secret 和用户授权。** 当前代码已接入真实 Graph 接口；未配置这两项时，只能完成自动化与模拟网盘验收。

## 接口概览

| 接口 | 说明 |
| --- | --- |
| `GET /api/auth/status` | 配置和登录状态，签发会话及 CSRF |
| `GET /api/auth/login`、`GET /api/auth/callback` | 微软 OAuth 登录和回调 |
| `POST /api/auth/logout` | 清理本应用连接 |
| `GET /api/drive` | 网盘容量及根目录 |
| `GET /api/items/:id`、`GET /api/items/:id/children` | 详情、路径及带签名游标的目录分页 |
| `POST /api/items/:id/folders` | 新建子文件夹 |
| `PATCH /api/items/:id`、`DELETE /api/items/:id` | 重命名、移动、删除 |
| `GET /api/items/:id/download` | 流式下载文件 |
| `GET /api/items/:id/thumbnail?size=medium\|large` | 仅代理指定档位的图片缩略图，无缩略图时返回错误 |
| `GET /api/items/:id/original` | 按需代理图片原文件，供浏览器通过 Blob 显示 |
| `POST /api/batch` | 批量移动或删除，逐项返回结果 |
| `GET/POST /api/uploads` | 列出或创建上传任务 |
| `GET /api/uploads/:id?reconcile=1` | 核对上传范围并恢复任务 |
| `PUT /api/uploads/:id/content` | 二进制文件 / 分片，使用 Content-Range |
| `POST /api/uploads/:id/pause`、`DELETE /api/uploads/:id` | 暂停、取消 |
| `GET /health` | 运行实例、PID 和健康状态 |

除授权入口和健康检查外，接口需要会话；写接口还需要 `X-CSRF-Token`。错误统一返回 `{ error: { code, message, requestId } }`。

## 发布前隐私检查

提交前执行 `git add` 后运行 `npm run check:secrets -- --include-build`，检查待提交内容和已有浏览器构建产物。检查会拒绝运行数据、数据库、日志、私钥等受保护文件，并检测常见令牌及本机 `.env` 中的应用 ID、密钥和加密密钥；只报告文件名与类别，不输出命中的值。它属于基础检查，不能替代人工审查。

GitHub Actions 会在每次推送和拉取请求时运行凭据检查、测试、构建、依赖审计与模拟网盘浏览器验收。测试不需要真实微软凭据，运行数据和截图不会上传为公开构建产物。
