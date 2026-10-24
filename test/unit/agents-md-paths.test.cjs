'use strict';

/**
 * 项目地图的「按路径注入」（对齐 Claude Code 的 path-scoped rules / Cursor 的 globs）。
 *
 * 协议：section 标记可带 `paths="a/**, b/*.md"`。带 paths 的是条件段 —— 本轮没碰到
 * 相关路径就不注入，把预算让给命中的段；不带 paths 的是常驻段，永远注入。
 *
 * 筛选只用结构信号（消息里的路径 / 会话关注文件 / 变更文件），不做关键词表。
 */

const {
  parseSections,
  parsePathGlobs,
  compilePathGlob,
  matchesAnyPathGlob,
  selectSectionsByPath
} = require('../../src/agents-md');
const {
  lightAgentsMdContent,
  collectInjectPathHints
} = require('../../src/agent/system-prompt-prep');

const DOC = [
  '# AGENTS.md',
  '',
  '<!-- dieyun:section:overview status=stable -->',
  '## 项目概览',
  '这是测试项目',
  '',
  '<!-- dieyun:section:commands status=stable paths="tools/**, shows/ep02/**" -->',
  '## 常用命令',
  '- UE-PIPELINE-SECRET',
  '',
  '<!-- dieyun:section:gotchas status=stable -->',
  '## 已知坑点',
  '- GOTCHA-SECRET',
  ''
].join('\n');

describe('paths 属性解析', () => {
  it('marker 里的 paths 拆成 glob 列表', () => {
    const secs = parseSections(DOC);
    expect(secs.map((s) => s.id)).toEqual(['overview', 'commands', 'gotchas']);
    expect(secs.find((s) => s.id === 'commands').paths).toEqual(['tools/**', 'shows/ep02/**']);
    expect(secs.find((s) => s.id === 'overview').paths).toEqual([]);
  });

  it('parsePathGlobs 兼容反斜杠与空格', () => {
    expect(parsePathGlobs(' tools\\ue5\\** ,  src/*.js ')).toEqual(['tools/ue5/**', 'src/*.js']);
    expect(parsePathGlobs(undefined)).toEqual([]);
  });

  it('旧格式（无 paths）仍能解析', () => {
    const secs = parseSections('<!-- dieyun:section:overview status=stable -->\n内容');
    expect(secs[0].paths).toEqual([]);
  });
});

describe('glob 匹配', () => {
  it('** 跨目录，且允许任意前缀（绝对路径也能命中）', () => {
    const re = compilePathGlob('tools/ue5/**');
    expect(re.test('tools/ue5/a.py')).toBe(true);
    expect(re.test('D:/PixelOfficeMonitor/tools/ue5/a.py')).toBe(true);
    expect(re.test('src/a.py')).toBe(false);
  });

  it('单星不跨目录', () => {
    const re = compilePathGlob('src/*.js');
    expect(re.test('src/a.js')).toBe(true);
    expect(re.test('src/deep/a.js')).toBe(false);
  });

  it('无条件段永远算命中，无路径信号时退化为全注入', () => {
    expect(matchesAnyPathGlob([], ['src/a.js'])).toBe(true);
    expect(matchesAnyPathGlob(['tools/**'], [])).toBe(true);
    expect(matchesAnyPathGlob(['tools/**'], ['src/a.js'])).toBe(false);
  });
});

describe('按路径筛段', () => {
  const secs = [
    { id: 'overview', paths: [] },
    { id: 'commands', paths: ['tools/**'] },
    { id: 'gotchas', paths: [] }
  ];

  it('未命中的条件段被跳过', () => {
    expect(selectSectionsByPath(secs, ['src/a.js'])).toEqual({
      picked: [secs[0], secs[2]],
      skipped: ['commands']
    });
  });

  it('命中则保留', () => {
    expect(selectSectionsByPath(secs, ['tools/x.py']).picked).toHaveLength(3);
  });

  it('无路径信号时不筛（向后兼容）', () => {
    expect(selectSectionsByPath(secs, []).picked).toHaveLength(3);
  });
});

describe('注入时应用路径筛选', () => {
  it('路径命中：条件段正常注入', () => {
    const light = lightAgentsMdContent(DOC, 6000, { pathHints: ['tools/ue5/x.py'] });
    expect(light).toContain('UE-PIPELINE-SECRET');
    expect(light).toContain('GOTCHA-SECRET');
    expect(light).not.toContain('未注入');
  });

  it('路径不命中：条件段不注入，并提示还有哪些段', () => {
    const light = lightAgentsMdContent(DOC, 6000, { pathHints: ['README.md'] });
    expect(light).not.toContain('UE-PIPELINE-SECRET');
    expect(light).toContain('GOTCHA-SECRET');
    expect(light).toContain('commands');
    expect(light).toMatch(/未涉及相关路径而未注入/);
  });

  it('不传 pathHints 时行为不变（全注入）', () => {
    const light = lightAgentsMdContent(DOC);
    expect(light).toContain('UE-PIPELINE-SECRET');
    expect(light).not.toContain('未注入');
  });

  it('全部条件段都被跳过时仍注入常驻段', () => {
    const onlyCond = [
      '# AGENTS.md',
      '<!-- dieyun:section:overview status=stable -->',
      '## 项目概览',
      'BASE-SECRET',
      '<!-- dieyun:section:commands status=stable paths="tools/**" -->',
      '## 常用命令',
      'COND-SECRET'
    ].join('\n');
    const light = lightAgentsMdContent(onlyCond, 6000, { pathHints: ['docs/x.md'] });
    expect(light).toContain('BASE-SECRET');
    expect(light).not.toContain('COND-SECRET');
  });

  it('所有段都带 paths 且全不命中时退回全注入，且不能声称有段未注入', () => {
    const allCond = [
      '# AGENTS.md',
      '<!-- dieyun:section:overview status=stable paths="src/**" -->',
      'BASE-SECRET',
      '<!-- dieyun:section:commands status=stable paths="tools/**" -->',
      'COND-SECRET'
    ].join('\n');
    const light = lightAgentsMdContent(allCond, 6000, { pathHints: ['docs/x.md'] });
    expect(light).toContain('BASE-SECRET');
    expect(light).toContain('COND-SECRET');
    expect(light).not.toMatch(/未涉及相关路径而未注入/);
  });
});

describe('collectInjectPathHints', () => {
  it('汇总用户消息 / 关注文件 / 变更文件三类信号', () => {
    const hints = collectInjectPathHints({
      userQuery: '看一下 src/a.js 的实现',
      openFilePaths: ['src/b.js'],
      changeRows: [{ path: 'src/c.js' }]
    });
    expect(hints).toContain('src/a.js');
    expect(hints).toContain('src/b.js');
    expect(hints).toContain('src/c.js');
  });

  it('反斜杠归一为正斜杠，且去重', () => {
    const hints = collectInjectPathHints({
      userQuery: '',
      openFilePaths: ['tools\\ue5\\a.py', 'tools/ue5/a.py'],
      changeRows: []
    });
    expect(hints).toEqual(['tools/ue5/a.py']);
  });

  it('空 snapshot 返回空数组', () => {
    expect(collectInjectPathHints({})).toEqual([]);
    expect(collectInjectPathHints(null)).toEqual([]);
  });
});
