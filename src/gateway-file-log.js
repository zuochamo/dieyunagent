'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * @param {string} readableDir
 * @param {(msg: string) => void} [forwardLog]
 */
function createGatewayFileLogger(readableDir, forwardLog) {
  const logPath = path.join(readableDir, 'gateway.log');
  try {
    fs.mkdirSync(readableDir, { recursive: true });
  } catch {
    // ignore
  }

  function trimIfNeeded() {
    try {
      if (!fs.existsSync(logPath)) return;
      const { size } = fs.statSync(logPath);
      if (size <= MAX_BYTES) return;
      const raw = fs.readFileSync(logPath, 'utf8');
      fs.writeFileSync(logPath, raw.slice(-Math.floor(MAX_BYTES * 0.65)), 'utf8');
    } catch {
      // ignore
    }
  }

  return (msg) => {
    const text = String(msg == null ? '' : msg);
    if (forwardLog) forwardLog(text);
    try {
      trimIfNeeded();
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
    } catch {
      // ignore
    }
  };
}

module.exports = { createGatewayFileLogger };
