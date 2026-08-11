#!/usr/bin/env node
// 呼吸森林 Android 构建脚本
// 1) 注入后端地址 window.__API_BASE__（构建时从 BACKEND_HOST 环境变量读取）
// 2) 复制前端静态文件到 app/dist（Capacitor webDir）
// 3) 计算并同步 APP_VERSION（android 版本 = 前端版本）
// 4) 替换 MainActivity.java / capacitor.config.json / build.gradle 中的占位符
//
// 用法：
//   BACKEND_HOST=1.2.3.4:8080 npm run sync   # 完整构建
//   npm run sync                              # 缺省用 127.0.0.1:8787（本地模拟）

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const FRONTEND = path.resolve(ROOT, '..', 'frontend');
const DIST = path.join(ROOT, 'app', 'dist');

// ---- 后端地址 ----
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1:8787';
// 注：APP_VERSION 已由 build.js 在更新 DIST/index.html 时替换；这里保持幂等
const API_BASE = `http://${BACKEND_HOST}/v1`;

// ---- 版本 ----
const version = (() => {
  const m = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8').match(/const APP_VERSION = '([^']+)'/);
  return m ? m[1] : '0.0.0';
})();
console.log(`[build] 前端版本: ${version}`);
console.log(`[build] 后端地址: ${API_BASE}`);

// ---- 1. 复制前端到 app/dist ----
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const webFiles = ['index.html', '404.html', 'manifest.webmanifest', 'styles.css', 'sw.js'];
for (const f of webFiles) {
  const src = path.join(FRONTEND, f);
  if (existsSync(src)) copyFileSync(src, path.join(DIST, f));
}
const dirs = ['src', 'vendor', 'assets', 'icons'];
for (const d of dirs) {
  copyDir(path.join(FRONTEND, d), path.join(DIST, d));
}

// ---- 2. 注入后端地址到打包的 index.html / 404.html ----
// 后端直连 IP:8080，WebView 里不再需要隧道/Pages 地址
const injectScript = readFileSync(path.join(ROOT, 'inject.js'), 'utf8')
  .replace("'http://__BACKEND_HOST__/v1'", "'http://" + BACKEND_HOST + "/v1'");
for (const f of ['index.html', '404.html']) {
  const file = path.join(DIST, f);
  let html = readFileSync(file, 'utf8');
  html = html.replace(
    /window\.__API_BASE__ = 'https:\/\/[^']*'/,
    `window.__API_BASE__ = '${API_BASE}'`
  );
  // 双保险：在 <head> 后插入 inject.js（JS 注入 + HTML 注入双通道）
  html = html.replace(
    '<head>',
    `<head>\n    <script>${injectScript}</script>`
  );
  writeFileSync(file, html);
}

// ---- 3. 同步后端地址与 APP_VERSION 到 Java 壳 ----
// Java 里用 __API_BASE__ / __APP_VERSION__ 占位符，构建时替换成真实值。
// 这样「Java 注入」与「HTML 注入」双通道拿到的后端地址一致。
const NATIVE = path.join(ROOT, 'android');
const mainActivity = path.join(NATIVE, 'app', 'src', 'main', 'java', 'io', 'forest', 'breath', 'MainActivity.java');
if (existsSync(mainActivity)) {
  writeFileSync(mainActivity,
    readFileSync(mainActivity, 'utf8')
      .replace(/API_BASE = "[^"]*"/, `API_BASE = "${API_BASE}"`)
      .replace(/APP_VERSION = "[^"]*"/, `APP_VERSION = "${version}"`));
}

const cfg = path.join(ROOT, 'capacitor.config.json');
writeFileSync(cfg,
  readFileSync(cfg, 'utf8').replace(/"appName": "[^"]*"/, `"appName": "呼吸森林"`));

console.log('[build] 完成，产物在 app/dist');
console.log('[build] 下一步：npx cap sync android && cd android/android && ./gradlew assembleRelease');

function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}
