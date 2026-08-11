# 安卓 App（Capacitor 壳）部署与维护

呼吸森林安卓版 = **前端打进 APK** + **后端直连 `http://服务器IP:端口`**。不用域名、不用备案、不用隧道。

## 架构

```
安卓手机 → APK 内 WebView (cap://localhost, 安全上下文)
              ├─ 前端静态文件（打进 APK，本机加载，可离线）
              └─ fetch http://服务器IP:8080/v1 → 阿里云 Nginx → 127.0.0.1:8787 后端(PM2+SQLite)
```

- **语音可用**：WebView 以 `cap://localhost` 加载，属于安全上下文，`getUserMedia` 麦克风放行。
- **无混合内容**：前端页面和 API 都是 http（WebView 内），不涉及 https 页拉 http。
- **服务端 SW 已禁用**：壳拦截 `/sw.js` 返回空文档，避免 SW 吞掉发往后端 IP 的请求。

## 目录结构（`android/`）

```
android/
├── build.js                # 构建脚本：复制前端 + 注入后端地址 + 同步版本号
├── inject.js               # HTML 内注入 window.__API_BASE__（fallback）
├── capacitor.config.json   # Capacitor 配置（appId / webDir / allowMixedContent）
├── package.json            # @capacitor/core@8 / cli / android
└── android/                # Capacitor 生成的原生 Android 工程（源码入库，CI 依赖）
    ├── app/build.gradle    # 已加 debug keystore 签名 release
    └── app/src/main/
        ├── java/io/forest/breath/MainActivity.java   # 壳：注入后端地址 + 禁 SW
        ├── AndroidManifest.xml                       # INTERNET + RECORD_AUDIO + cleartext
        └── res/xml/network_security_config.xml       # 放行明文 HTTP
```

## 构建流程（CI 自动）

`.github/workflows/android-build.yml` 在 push 到 `main`（且改动 `frontend/` 或 `android/`）时自动触发：

1. `node build.js`：把 `frontend/` 复制到 `android/app/dist`，并把
   `window.__API_BASE__` 替换成 `http://$BACKEND_HOST/v1`。
   - 后端地址来自 workflow 的 `backend` 输入，留空默认 `127.0.0.1:8787`（仅本地模拟）。
   - 同步 `APP_VERSION`（前端 index.html 的版本号）到 Java 壳。
2. `npx cap sync android`：把 dist 同步到 `android/android/app/src/main/assets/public`。
3. `./gradlew assembleRelease`：产出 **debug 签名** 的 release APK（可安装，自分发）。
4. 上传 APK 到 Actions artifact。

## 如何出一个 APK（手动触发）

仓库 → Actions → **Build Android APK** → Run workflow → 填后端地址 `1.2.3.4:8080` → 运行。
完成后在运行记录的 **Artifacts** 下载 `breath-forest-android`，里面是 `app-release.apk`。

## 更新 App（改前端后）

只需重新构建 APK 并分发（APK 内的前端是固定版本，用户需覆盖安装）：

1. 改前端（记得升版本号 + sw.js CACHE_NAME，沿用现有规矩）。
2. push 到 main（或手动触发 workflow，填后端地址）。
3. 下载新 APK，发给用户覆盖安装。

> 前端更新频率高时，这条"每次重装"很烦。若想免重装，可改方案为"服务器托管前端"
> （WebView 加载 `http://IP:8080/`），但那样 http 非安全上下文，**安卓语音会不可用**。

## 后端服务器侧（对应安卓直连）

Nginx 监听 **8080**（避开 80/443 备案拦截），只反代后端，不托管前端：

```nginx
server {
    listen 8080;
    server_name _;

    location /v1/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

后端仍用 PM2 跑 `HOST=0.0.0.0 ALLOW_ORIGINS_WILDCARD=1 node src/server.js`（CORS 放行 cap:// 与 http 来源）。

## 常见问题

- **App 白屏**：多半是 APK 里 `window.__API_BASE__` 仍是占位符 → 构建时没传 `BACKEND_HOST`，
  或 cap sync 失败导致 assets 旧。重跑构建。
- **语音不可用**：确认 APK 里前端加载的是 `cap://localhost`（打进包），而非服务器 http 页面；
  真机首次使用需授权麦克风（App 会弹系统权限框）。
- **后端连不上**：手机和服务器同一网络能通 `http://IP:8080/v1/health`；服务器防火墙放行 8080。
- **APK 装不上（国产 ROM）**：设置里允许"未知来源安装"。
