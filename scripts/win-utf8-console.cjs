'use strict';

/** Windows 终端默认 GBK，UTF-8 中文日志会乱码；dev 启动时切到 UTF-8。 */
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001 >nul', {
      shell: true,
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (_) {
    /* ignore */
  }
  for (const stream of [process.stdout, process.stderr]) {
    if (stream?.isTTY && typeof stream.setDefaultEncoding === 'function') {
      try {
        stream.setDefaultEncoding('utf8');
      } catch (_) {
        /* ignore */
      }
    }
  }
}
