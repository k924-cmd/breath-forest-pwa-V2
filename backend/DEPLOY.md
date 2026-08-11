# 部署指南：呼吸森林后端（cloudflared 隧道 + Cloudflare Access）

本仓库的部署形态是「GitHub Pages 前端 + 公网隧道 + 本机后端」。后端只监听 `127.0.0.1:8787`，通过 cloudflared 隧道暴露。**本文档是部署到公网时的完整步骤**，与代码里的认证/限流/守卫配套。

## 安全模型（务必先读）

部署后你会有三层防护，每层挡不同的人：

1. **Cloudflare Access（云边缘，最强）**：要求访问者先通过身份校验（GitHub 登录）才把请求转发到隧道。**挡所有人**，包括 curl。
2. **API Key（`X-Api-Key`）**：前端注入的共享口令。挡「没看过代码随手路过的人」。注意：SPA 前端里的 key 对任何人都可见（F12 就能看到），它**不是秘密**，只是降低被无脑刷的概率。
3. **管理员登录会话（`/v1/auth/login`）**：后端对密码做 SCrypt 比对后签发 session token，前端持 token 调 API。**挡「拿到 key 但没有登录口令」的人**。

另外后端内置了：
- **速率限制**（默认关，`RATE_LIMIT_ENABLED=true` 开启）：对 `/v1/asr`、`/v1/tts/easter-egg`、`/v1/conversations/messages` 按 `CF-Connecting-IP` 限流（默认 10 次/分钟/IP），防额度被刷爆。GET / OPTIONS / 登录不限。
- **请求体守卫**：JSON 深度上限（64 层）+ 字段白名单 + 64KB 体积限制。

## 前置：买域名并接入 Cloudflare

`cloudflared tunnel route dns` 需要**你拥有 DNS 控制权的域名**。`github.io` 是 GitHub 的域名，你无法在其下建子域名，所以必须自有域名。

- **在 Cloudflare 购买**：成本价续费、DNS 与隧道/Access 在同一处管理，链路最短，**推荐**。国内用户访问走境外 CDN 稍慢。
- **在腾讯云/阿里云购买**：国内访问更友好；但需实名认证，且国内上线需要 ICP 备案（流程约 7–20 天）。若把 NS 迁到 Cloudflare，则 DNS 解析、命名隧道、Access 都能用。

> 备案：面向大陆用户提供对外服务**必须 ICP 备案**。如果主要面向海外用户或可接受境外节点，可不备案，但国内访问可能受限或变慢。

## 一、迁移到命名隧道（替代 TryCloudflare）

当前用 `cloudflared tunnel --url http://127.0.0.1:8787`（TryCloudflare quick tunnel）时 URL 随机、重启即失效，且无法挂 Access。改为命名隧道：

```bash
cloudflared tunnel login                       # 选你域名所在账户，授权
cloudflared tunnel create iaq-backend          # 生成隧道，记下 Tunnel UUID
cloudflared tunnel route dns iaq-backend backend.你的域名.com
```

写 `~/.cloudflared/config.yml`：

```yaml
tunnel: <上面记下的 Tunnel UUID>
credentials-file: C:\Users\<你>\.cloudflared\<Tunnel UUID>.json
ingress:
  - hostname: backend.你的域名.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

启动后端 + 隧道：

```bash
cd backend && npm run start:http        # 127.0.0.1:8787
cloudflared tunnel run iaq-backend
```

## 二、配置后端 .env

`backend/.env`（已被 .gitignore 忽略，**不要提交**）：

```ini
# 认证
API_KEY=<openssl rand -hex 32>
ADMIN_PASSWORD_HASH=<见下方生成方式>

# CORS：指向你的 GitHub Pages 前端域名（不要用通配符）
ALLOWED_ORIGINS=https://<你的账户名>.github.io

# 限流（默认关，部署开启）
RATE_LIMIT_ENABLED=true
RATE_LIMIT_PER_MINUTE=10
```

生成 `ADMIN_PASSWORD_HASH`（SCrypt，格式：64 位 hex 盐 + 128 位 hex 哈希）：

```bash
node -e "const c=require('node:crypto');const s=c.randomBytes(32);console.log(s.toString('hex')+c.scryptSync(process.argv[1],s,64).toString('hex'))" '你的管理员密码'
```

## 三、更新前端注入

部署后前端在非 localhost 下会自动读取这两个全局变量（`frontend/index.html` 与 `frontend/404.html`）：

```js
if (!isLocal) {
  window.__API_BASE__ = 'https://backend.你的域名.com/v1';
  window.__API_KEY__ = '<与后端 API_KEY 相同>';
}
```

前端所有请求（含 asr / tts / weather 三个直连服务）会自动带上 `X-Api-Key` 与登录后的 `Authorization: Bearer <token>`。

## 四、Cloudflare Access（云侧身份校验）

在 Cloudflare Zero Trust 控制台给 `backend.你的域名.com` 建 Access 应用：
- 策略：Allow 当 `登录方法 = GitHub`（或任意身份提供方）。
- 这样任何人在浏览器里访问隧道，先被要求登录 GitHub 才能到达后端；未登录的 curl 直接被 403 拒绝。

> Access 放行优先于源站 key 校验，所以即使 `__API_KEY__` 在公开仓库里被看到，也绕不过 Access 的登录门槛。

## 五、移动端部署：iOS PWA 与 Android APK

前端同时面向 iOS PWA 与 Android APK，二者形态不同，注意点也不同。

### 前端配置统一入口（`frontend/src/config.js`）

部署时**只改这一处**：`API_BASE_URL` 填后端公网地址、`API_KEY` 填后端密钥。本文件是所有平台（浏览器 / GitHub Pages / Capacitor）的单一配置来源，兼容旧的内联注入（`window.__API_BASE__` / `__API_KEY__`）但推荐用这里的常量。

```js
const API_BASE_URL = 'https://backend.你的域名.com/v1';
const API_KEY = 'xJ0v...';
```

### iOS PWA

- PWA 是「添加到主屏幕」的网页，跑在 Safari 里，**有 Origin**，能过 CORS。
- `manifest.webmanifest` 提供独立窗口图标；`apple-mobile-web-app-*` meta 已配好。
- **注意**：Service Worker 缓存的是 `frontend/` 构建产物。发布新版时若只改 `config.js` 而没 bump `sw.js` 里的 `CACHE_NAME`，老用户会拿不到新配置（SW 不回源）。改配置必须同时 bump。
- 登录 token 存 `sessionStorage`，关标签页即失效，每次打开需重新登录——属体验问题，非安全漏洞。

### Android APK（Capacitor）

- APK 打包的是 `android/app/src/main/assets/` 里那份 `webDir` 拷贝，**与 GitHub Pages 那份是两份独立代码**，后端地址/密钥要分别在 config.js 里填好再 `npx cap sync` 重打包。
- **`isLocal` 判定在 Capacitor 里不可靠**：原生壳的 `location.hostname` 可能恰好是 `localhost`（指向设备自身），所以 config.js 里对 Capacitor 强制走 `API_BASE_URL`，绝不回退到 `127.0.0.1`。
- **明文 HTTP 已关闭**：`network_security_config.xml` 与 `AndroidManifest.xml` 的 `usesCleartextTraffic` 均设为 `false`，只允许 HTTPS。若后端尚未配证书（临时用裸 IP），需临时放回 `true` 联调，上线前务必恢复。
- **APK 解包可见密钥**：打包进 APK 的 `API_KEY` 任何人 `apktool` 就能提取，比 PWA 更"公开"。它是共享口令不是秘密，真正的防线是 Cloudflare Access + 后端登录。
- **限流 IP 是 NAT 后 IP**：手机流量/办公室共享出口会被一起计数，`RATE_LIMIT_PER_MINUTE` 按实际使用调大。

### 版本同步提醒

前端用 `?v=20260808-7` 做资源指纹，SW 缓存按 `CACHE_NAME` 版本区分。改动 `config.js` 或任何模块后，需要：
1. bump `sw.js` 的 `CACHE_NAME`（如 `v33` → `v34`）；
2. 更新各 `?v=` 指纹（或统一用构建工具注入版本）；
3. APK 重新 `npx cap sync` + 重打包。

## 六、验证清单

- `cd backend && npm test` 全绿（含登录/限流/深度守卫测试）。
- 无 key 访问 → 401；key 错误 → 401；key 正确但未登录 → 401（仅当配置了 `ADMIN_PASSWORD_HASH`）。
- 同一 IP 在窗口内第 N+1 次（N=`RATE_LIMIT_PER_MINUTE`）POST 敏感路由 → 429 + `Retry-After: 60`。
- 浏览器打开 GitHub Pages：未登录 → 被 Access 拦；GitHub 登录后 → 进入应用，输入管理员口令成功进入。
- 手机（非 localhost）走隧道 URL 全链路可用。
- iOS PWA：添加到主屏幕 → 独立窗口打开 → 登录 → 对话/语音可用。
- Android APK：安装后启动 → 连到公网后端（不落回 127.0.0.1）→ 登录 → 对话/语音可用。

## 常见坑

- **`route dns backend.xxx.github.io` 报错**：`github.io` 无 DNS 权限，必须用自有域名。
- **改了 .env 不生效**：`config/env.js` 只加载白名单内的键；`API_KEY`、`ADMIN_PASSWORD_HASH`、`RATE_LIMIT_*`、`ALLOWED_ORIGINS`、`HOST`、`PORT`、`SQLITE_*` 均已加入白名单，其余新键需同步更新 loader。
- **限流误伤自己**：默认 10 次/分钟/IP，办公室/校园共享 IP 会一起计数，可调大 `RATE_LIMIT_PER_MINUTE`。
- **会话仅存内存**：后端重启后所有登录 token 失效，用户需重新登录；个人部署可接受。
