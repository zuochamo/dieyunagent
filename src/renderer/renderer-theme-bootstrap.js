'use strict';

/** 首屏前应用主题，避免浅色模式闪一下暗色（须在 styles.css 之前加载） */
try {
  if (localStorage.getItem('diecloud.theme.v1') !== 'dark') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
} catch {
  // ignore
}
