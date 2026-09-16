'use strict';

/**
 * Smoke: src/agent/write-smell-hints.js
 *
 * 覆盖：替身键归一（含 step4b 这类中段数字）、扩展名不同不算同族、
 * glob 模式换算与元字符放弃、吞异常三种形态、明文凭据、全大写常量抽取、
 * 目录同胞（注入式）、按 (run, 目录) 只查一次、查询失败后不重试而降级为「本轮可见」、
 * 编辑已存在文件不报替身、上限 0 = 关闭、失败结果不提示、非写工具不查询。
 */

const {
  twinKey,
  relDirOf,
  relDirGlobPattern,
  filterDirNames,
  scanSwallowedExceptions,
  scanPlaintextSecret,
  extractConstantAssignments,
  resetWriteSmellTrackers,
  collectWriteSmellHints
} = require('../src/agent/write-smell-hints');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const LIMITS = { writeSmellHintMaxItems: 5, writeSmellHintMaxChars: 2000 };

/** 目录清单桩：按目录返回文件名；badDirs 里的目录抛错，用于验证降级。 */
function makeStub(listings, badDirs = []) {
  const state = { calls: 0 };
  const readDirNames = async (filePath) => {
    state.calls += 1;
    const dir = String(filePath).replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if (badDirs.includes(dir)) throw new Error('glob 不可用');
    return listings[dir] || [];
  };
  return { state, readDirNames };
}

async function main() {
  // --- 替身键 ---
  assert(twinKey('a/convert_ico.py') === twinKey('a/convert_ico2.py'), 'convert_ico / convert_ico2 同键');
  assert(twinKey('a/convert_ico3.py') === twinKey('a/convert_ico.py'), 'convert_ico3 同键');
  assert(twinKey('a/_verify_kblist.py') === twinKey('a/_verify_kblist2.py'), '下划线前缀同族归一');
  assert(twinKey('a/step4_entry.py') === twinKey('a/step4b_entry.py'), '中段数字 + 单字母归一');
  assert(twinKey('a/icon.png') !== twinKey('a/icon.ico'), '扩展名不同不算同族');
  assert(twinKey('a/utils.py') !== twinKey('a/other.py'), '不同功能不算同族');

  // --- glob 模式换算 ---
  assert(relDirGlobPattern('E:/ws/src/a.py', 'E:/ws') === 'src/*', '绝对路径换算相对模式');
  assert(relDirGlobPattern('src/a.py', 'E:/ws') === 'src/*', '相对路径直接使用');
  assert(relDirGlobPattern('a.py', 'E:/ws') === '*', '工作区根目录');
  assert(relDirGlobPattern('D:/other/a.py', 'E:/ws') === null, '工作区外绝对路径应放弃');
  assert(relDirGlobPattern('E:/ws/we[i]rd/a.py', 'E:/ws') === null, 'glob 元字符目录应放弃');
  assert(relDirGlobPattern('src\\a.py', 'E:\\ws\\') === 'src/*', '反斜杠应归一');
  assert(relDirOf('E:/ws/src/a.py', 'E:/ws') === 'src', 'relDir 绝对路径');
  assert(relDirOf('a.py', 'E:/ws') === '', 'relDir 工作区根应为空串');
  assert(relDirOf('D:/other/a.py', 'E:/ws') === null, 'relDir 工作区外应为 null');

  // 工作区根的模式是 '*'，ripgrep 对不含 / 的模式按 basename 在任意深度匹配 → 必须自己按目录筛
  const filtered = filterDirNames(
    ['E:/ws/p/a.py', 'E:/ws/p/sub/b.py', 'p/c.py', 'E:/ws/other/d.py'],
    'p',
    'E:/ws'
  );
  assert(
    filtered.length === 2 && filtered.includes('a.py') && filtered.includes('c.py'),
    `应只留目标目录直接子项，实际 ${JSON.stringify(filtered)}`
  );
  const rootFiltered = filterDirNames(['E:/ws/a.py', 'E:/ws/sub/b.py', 'a2.py'], '', 'E:/ws');
  assert(
    rootFiltered.length === 2 && rootFiltered.includes('a.py') && rootFiltered.includes('a2.py'),
    `工作区根应只留顶层文件，实际 ${JSON.stringify(rootFiltered)}`
  );

  // --- 静默吞异常 ---
  assert(scanSwallowedExceptions('except Exception:\n    pass\n') === 'except 后接 pass', 'python 多行吞异常');
  assert(scanSwallowedExceptions('except Exception: pass\n') === 'except: pass', 'python 单行吞异常');
  assert(scanSwallowedExceptions('try { f(); } catch (e) {}\n') === 'catch {}', 'js 空 catch');
  assert(scanSwallowedExceptions('except Exception as e:\n    log(e)\n') === '', '有处理则不算吞异常');
  assert(
    scanSwallowedExceptions('except Exception:\r\n    pass\r\n') === 'except 后接 pass',
    'CRLF 的 python 吞异常应可识别'
  );
  assert(scanSwallowedExceptions('except Exception:\n\tpass\n') === 'except 后接 pass', 'Tab 缩进应可识别');

  // --- 明文凭据 ---
  assert(scanPlaintextSecret('PASSWORD = "123456"') === 'PASSWORD', '明文口令');
  assert(scanPlaintextSecret('api_key: "abc"') === 'api_key', '明文 api key');
  assert(scanPlaintextSecret('PASSWORD = process.env.PASSWORD') === '', '环境变量不算明文');

  // --- 全大写常量抽取 ---
  const consts = extractConstantAssignments('HOST = "10.0.0.1"\n$PORT = "22"\nother = "x"\n');
  assert(consts.length === 2, `只抽全大写常量，实际 ${consts.length}`);
  assert(consts[0].name === 'HOST' && consts[0].value === '10.0.0.1', 'HOST 抽取');
  assert(consts[1].name === 'PORT', 'PowerShell $VAR 抽取');
  assert(extractConstantAssignments('HOST = "10.0.0.1"\r\n').length === 1, 'CRLF 行应能抽出常量');

  // --- 不注入目录读取：退化为「本轮可见」 ---
  resetWriteSmellTrackers();
  const base = { runKey: 'same-run', limits: LIMITS };
  const write = (extra) => collectWriteSmellHints({ ...base, result: { ok: true }, ...extra });

  const s1 = await write({ toolName: 'fs_write_file', args: { filePath: 'p/a.py', content: 'HOST = "10.0.0.1"\n' } });
  assert(s1.length === 0, `首次写入不应有提示，实际 ${JSON.stringify(s1)}`);

  const s2 = await write({ toolName: 'fs_write_file', args: { filePath: 'p/a2.py', content: 'HOST = "10.0.0.1"\n' } });
  assert(s2.some((x) => x.includes('同一目录本轮已写入同族文件')), `应提示本轮同族，实际 ${JSON.stringify(s2)}`);
  assert(s2.some((x) => x.includes('HOST')), '应提示常量重复');

  const s3 = await write({
    toolName: 'fs_edit',
    args: { filePath: 'p/b.py', newString: 'try:\n    f()\nexcept Exception:\n    pass\n' }
  });
  assert(s3.some((x) => x.includes('静默吞异常')), `fs_edit 新文本应检出吞异常，实际 ${JSON.stringify(s3)}`);

  const s4 = await write({ toolName: 'fs_edit', args: { filePath: 'p/a.py', newString: 'x = 1\n' } });
  assert(!s4.some((x) => x.includes('同族文件')), `已存在文件再次编辑不应重复报同族，实际 ${JSON.stringify(s4)}`);

  // --- 注入目录读取：能看见落盘前就存在的同族文件 ---
  resetWriteSmellTrackers();
  const stub = makeStub({ p: ['convert_ico.py', 'convert_ico2.py', 'readme.txt'], q: [] });
  const withDisk = (extra) =>
    collectWriteSmellHints({
      runKey: 'disk-run',
      limits: LIMITS,
      readDirNames: stub.readDirNames,
      result: { ok: true },
      ...extra
    });

  const diskTwin = await withDisk({
    toolName: 'fs_write_file',
    args: { filePath: 'p/convert_ico3.py', content: 'x = 1\n' }
  });
  assert(
    diskTwin.some((s) => s.includes('同目录已存在同族文件')),
    `应提示目录已存在同族，实际 ${JSON.stringify(diskTwin)}`
  );
  assert(diskTwin.some((s) => s.includes('convert_ico.py') && s.includes('convert_ico2.py')), '应列出同族文件名');
  assert(!diskTwin.some((s) => s.includes('readme')), '不应把非同族文件算进来');
  assert(stub.state.calls === 1, `首次应查询一次，实际 ${stub.state.calls}`);

  const cached = await withDisk({ toolName: 'fs_write_file', args: { filePath: 'p/convert_ico4.py', content: 'x = 1\n' } });
  assert(cached.some((s) => s.includes('同族文件')), '第二个替身也应提示');
  assert(stub.state.calls === 1, `同目录应命中缓存，实际 ${stub.state.calls}`);

  const editExisting = await withDisk({ toolName: 'fs_edit', args: { filePath: 'p/convert_ico.py', newString: 'x = 1\n' } });
  assert(!editExisting.some((s) => s.includes('同族文件')), `编辑已存在文件不应报替身，实际 ${JSON.stringify(editExisting)}`);
  assert(stub.state.calls === 1, `仍应命中缓存，实际 ${stub.state.calls}`);

  const emptyDir = await withDisk({ toolName: 'fs_write_file', args: { filePath: 'q/a.py', content: 'x = 1\n' } });
  assert(!emptyDir.some((s) => s.includes('同族文件')), '目录内无同族不应提示');
  assert(stub.state.calls === 2, `新目录应查询一次，实际 ${stub.state.calls}`);

  // --- 并行写同一目录：缓存的是 Promise，应共享同一次查询 ---
  resetWriteSmellTrackers();
  let concurrentCalls = 0;
  const slowRead = async () => {
    concurrentCalls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return ['conv.py', 'conv2.py'];
  };
  const parallelWrite = (filePath) =>
    collectWriteSmellHints({
      runKey: 'par-run',
      limits: LIMITS,
      readDirNames: slowRead,
      toolName: 'fs_write_file',
      args: { filePath, content: 'x = 1\n' },
      result: { ok: true }
    });
  const parallel = await Promise.all([parallelWrite('par/conv3.py'), parallelWrite('par/conv4.py')]);
  assert(concurrentCalls === 1, `并行写同目录应共享一次查询，实际 ${concurrentCalls}`);
  assert(
    parallel.every((h) => h.some((s) => s.includes('同族文件'))),
    `两个并行写都应拿到同族提示，实际 ${JSON.stringify(parallel)}`
  );

  // --- 查询失败：降级为本轮可见，且本轮不重试 ---
  resetWriteSmellTrackers();
  const bad = makeStub({ r: [] }, ['r']);
  const withBad = (extra) =>
    collectWriteSmellHints({
      runKey: 'bad-run',
      limits: LIMITS,
      readDirNames: bad.readDirNames,
      result: { ok: true },
      ...extra
    });

  const b1 = await withBad({ toolName: 'fs_write_file', args: { filePath: 'r/a.py', content: 'x = 1\n' } });
  assert(b1.length === 0, `查询失败时首次不应提示，实际 ${JSON.stringify(b1)}`);
  const b2 = await withBad({ toolName: 'fs_write_file', args: { filePath: 'r/a2.py', content: 'x = 1\n' } });
  assert(
    b2.some((s) => s.includes('同一目录本轮已写入同族文件')),
    `查询失败时应退化为本轮检测，实际 ${JSON.stringify(b2)}`
  );
  assert(bad.state.calls === 1, `查询失败后本轮不应重试，实际 ${bad.state.calls}`);

  // --- 关闭 / 失败 / 非写工具 ---
  const off = await collectWriteSmellHints({
    runKey: 'off-run',
    limits: { writeSmellHintMaxItems: 0, writeSmellHintMaxChars: 0 },
    toolName: 'fs_write_file',
    args: { filePath: 'z/a.py', content: 'except: pass\n' },
    result: { ok: true }
  });
  assert(Array.isArray(off) && off.length === 0, '上限 0 时关闭提示');

  const failed = await collectWriteSmellHints({
    runKey: 'disk-run',
    limits: LIMITS,
    readDirNames: stub.readDirNames,
    toolName: 'fs_write_file',
    args: { filePath: 'p/c.py', content: 'except: pass' },
    result: { error: '写入失败' }
  });
  assert(failed.length === 0, '失败结果不应提示');

  const callsBefore = stub.state.calls;
  const nonWrite = await collectWriteSmellHints({
    runKey: 'disk-run',
    limits: LIMITS,
    readDirNames: stub.readDirNames,
    toolName: 'fs_read_file',
    args: { filePath: 'p/a.py' },
    result: { ok: true }
  });
  assert(nonWrite.length === 0, '非写工具不应提示');
  assert(stub.state.calls === callsBefore, `非写工具不应查询目录，实际 ${stub.state.calls}`);

  const noPath = await collectWriteSmellHints({
    runKey: 'disk-run',
    limits: LIMITS,
    toolName: 'fs_edit',
    args: { newString: 'except: pass' },
    result: {}
  });
  assert(noPath.length === 0, '无路径时不应提示');

  // --- limits 惰性取值 ---
  resetWriteSmellTrackers();
  let limitCalls = 0;
  const lazyLimits = () => {
    limitCalls += 1;
    return LIMITS;
  };
  const lazy = await collectWriteSmellHints({
    runKey: 'lazy-run',
    limits: lazyLimits,
    toolName: 'fs_write_file',
    args: { filePath: 'lazy/a.py', content: 'except: pass\n' },
    result: { ok: true }
  });
  assert(lazy.length > 0, `惰性上限下仍应给出提示，实际 ${JSON.stringify(lazy)}`);
  assert(limitCalls === 1, `写工具应解析一次上限，实际 ${limitCalls}`);

  const lazyNonWrite = await collectWriteSmellHints({
    runKey: 'lazy-run',
    limits: lazyLimits,
    toolName: 'fs_read_file',
    args: { filePath: 'lazy/a.py' },
    result: { ok: true }
  });
  assert(lazyNonWrite.length === 0, '非写工具不应提示');
  assert(limitCalls === 1, `非写工具不应解析上限，实际 ${limitCalls}`);

  // --- 接线：真走 Main 工具漏斗，确认发出的是 fs.glob 且 pattern 正确 ---
  // 纯函数测试用的是注入桩；这一段保证「工具名映射 / 参数形状 / warnings 挂载」不会静默坏掉。
  const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
  const calls = [];
  const gateway = {
    async invokeRpc(method, params) {
      calls.push({ method, params });
      if (method === 'fs.glob') {
        return { ok: true, files: ['/ws/p/convert_ico.py', '/ws/p/convert_ico2.py'], source: 'stub' };
      }
      if (method === 'fs.write_file') return { ok: true, bytes: 13 };
      return { ok: true };
    }
  };
  const bridge = createMainToolBridge({ gateway, userDataPath: '' });
  const ctx = { sessionId: 'wiring-s', runId: 'wiring-r', workspacePath: '/ws', contextTierId: 'default' };

  const wired = await bridge.executeAgentTool(
    'fs_write_file',
    { filePath: '/ws/p/convert_ico3.py', content: 'x = 1\n' },
    ctx
  );
  assert(wired && wired.ok === true, '写入结果应保持 ok');
  assert(Array.isArray(wired.warnings) && wired.warnings.length > 0, `应挂上 warnings，实际 ${JSON.stringify(wired)}`);
  assert(wired.warnings.some((s) => s.includes('convert_ico2.py')), 'warnings 应含落盘已存在的同族文件名');

  const globCall = calls.find((c) => c.method === 'fs.glob');
  assert(globCall, `应通过 fs.glob 查目录，实际调用 ${JSON.stringify(calls.map((c) => c.method))}`);
  assert(globCall.params.pattern === 'p/*', `glob pattern 应为 p/*，实际 ${globCall.params.pattern}`);
  assert(globCall.params.runWorkspaceRoot === '/ws', 'glob 应带上工作区根');

  const callsBeforeRead = calls.length;
  const readResult = await bridge.executeAgentTool('fs_read_file', { filePath: '/ws/p/convert_ico3.py' }, ctx);
  assert(readResult && !readResult.warnings, '非写工具不应挂 warnings');
  assert(calls.length === callsBeforeRead + 1, `非写工具不应额外查目录，实际新增 ${calls.length - callsBeforeRead} 次调用`);

  // 别名工具名：必须归一化后照常判定，否则模型用 edit / write_file 时会被整体跳过
  const aliasResult = await bridge.executeAgentTool(
    'edit',
    { path: '/ws/p/z_alias.py', old_string: 'a', new_string: 'try:\n    f()\nexcept Exception:\n    pass\n' },
    ctx
  );
  assert(
    Array.isArray(aliasResult.warnings) && aliasResult.warnings.some((s) => s.includes('静默吞异常')),
    `别名工具名也应命中，实际 ${JSON.stringify(aliasResult)}`
  );

  // glob 失败时：写入结果照旧返回，绝不因提示能力而降级工具成败
  const callsFail = [];
  const bridgeFail = createMainToolBridge({
    gateway: {
      async invokeRpc(method, params) {
        callsFail.push(method);
        if (method === 'fs.glob') throw new Error('LSP/Glob 不可用');
        return { ok: true, bytes: 3 };
      }
    },
    userDataPath: ''
  });
  const tolerated = await bridgeFail.executeAgentTool(
    'fs_write_file',
    { filePath: '/ws/p/x.py', content: 'x = 1\n' },
    { sessionId: 'wiring-f', runId: 'wiring-f', workspacePath: '/ws' }
  );
  assert(tolerated && tolerated.ok === true, 'glob 失败不应影响写入结果');
  assert(!tolerated.warnings, 'glob 失败时不应产生 warnings');
  assert(callsFail.includes('fs.glob'), '应当尝试过 fs.glob');
}

main().then(
  () => console.log('test-write-smell-hints.cjs ok'),
  (e) => {
    console.error(`test-write-smell-hints.cjs FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
);
