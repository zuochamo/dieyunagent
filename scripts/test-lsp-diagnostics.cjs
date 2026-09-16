'use strict';

/**
 * 验证 LSP 诊断服务（无需启动 Electron）
 * 用法: node scripts/test-lsp-diagnostics.cjs
 *
 * 首次运行会通过 npx 拉取 typescript-language-server，需网络。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { createLspDiagnosticsService } = require('../src/lsp/diagnostics-service');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-lsp-test-'));
  const tsconfig = {
    compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs' },
    include: ['*.ts']
  };
  fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  fs.writeFileSync(path.join(tmp, 'bad.ts'), 'const x: number = "hello";\n');

  console.log('installing typescript in temp workspace...');
  execSync('npm init -y', { cwd: tmp, stdio: 'ignore' });
  execSync('npm install typescript@5 --no-save --silent', { cwd: tmp, stdio: 'inherit', timeout: 120000 });

  const userData = path.join(tmp, 'user-data');
  fs.mkdirSync(userData, { recursive: true });

  const svc = createLspDiagnosticsService({
    userDataPath: userData,
    log: (m) => console.log(m)
  });

  console.log('workspace:', tmp);
  console.log('diagnosing bad.ts (timeout 60s for first npx download)...');

  const result = await svc.diagnoseFiles({
    workspaceRoot: tmp,
    files: ['bad.ts'],
    maxFiles: 1,
    timeoutMs: 60000
  });

  console.log(JSON.stringify(result, null, 2));

  const item = (result.items || [])[0];
  const hasError = item && (item.diagnostics || []).some((d) => d.severity === 'error');
  if (!hasError) {
    console.error('FAIL: expected at least one error diagnostic in bad.ts');
    if (item && item.error) console.error('item error:', item.error);
    await svc.shutdown();
    process.exit(1);
  }

  await svc.shutdown();
  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
