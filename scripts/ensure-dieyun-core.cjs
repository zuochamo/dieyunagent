'use strict';

const path = require('path');
const { syncArtifact, OUT, EXE_NAME } = require('./pack-dieyun-core.cjs');

/**
 * dev / start 前的 sidecar 闸门：产物**存在**不够，还要**是最新编译出来的**。
 *
 * 2026-11-17 的坑仍然按原样防住：`ensure` 只要 build/ 里有产物就报 OK 的那一版，让「改了 Rust
 * 却跑旧二进制」静默发生，整轮排查都打在旧代码上。这里不自己扫源码 mtime —— 源码变没变由
 * cargo 的指纹说话（无变化 0.29s 空跑），改了才编译，编译出的产物比 build/ 新才复制。
 * 判据与写盘都在 `pack-dieyun-core.cjs#syncArtifact` 一处，本文件只负责启动期的报错口径。
 */
syncArtifact()
  .then(({ copied }) => {
    console.log(
      `[dieyun-core] sidecar ${copied ? '已重打' : 'OK'}: ${path.join(OUT, EXE_NAME)}`
    );
  })
  .catch((e) => {
    console.error('[dieyun-core] ' + (e && e.message ? e.message : e));
    console.error('[dieyun-core] 仍需解决时可手动运行: npm run pack:dieyun-core');
    process.exit(1);
  });
