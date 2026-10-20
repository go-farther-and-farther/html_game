/* 运行环境检测
 * 在 Capacitor APK 内给 <html> 加上 is-app，CSS 用 html.is-app .web-only 隐藏仅网页内容。
 * 尽量早执行（放在 <head> 里、样式表之前），避免网页专属入口先闪现再消失。
 */
(function () {
  'use strict';

  function isNativeApp() {
    try {
      var cap = window.Capacitor;
      if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
        return true;
      }
    } catch (err) {
      /* Capacitor 注入异常时按网页处理 */
    }
    return location.protocol === 'https:' && location.hostname === 'localhost';
  }

  function apply() {
    if (isNativeApp()) {
      document.documentElement.classList.add('is-app');
    }
  }

  apply();

  // Capacitor 可能注入得比本脚本晚：DOM 就绪和 load 时再补一次（幂等）
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', apply);
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('load', apply);
  }
})();
