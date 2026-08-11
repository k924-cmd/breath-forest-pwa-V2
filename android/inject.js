// 呼吸森林 Android 注入脚本（fallback）
// 正常情况下 Java 壳会在 onPageStarted/onPageLoaded 注入 window.__API_BASE__。
// 该文件被 build.js 注入到打包后 index.html 的 <head> 里，作为双保险：
// 若 Java 注入因时序未生效，页面自身也会带上后端地址。
;(function () {
  try {
    window.__API_BASE__ = 'http://__BACKEND_HOST__/v1';
    window.__ANDROID_APP__ = true;
  } catch (e) {}
})();
