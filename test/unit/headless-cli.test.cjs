/* globals describe, it, expect */
'use strict';

const path = require('path');
const { parseCliArgs, USAGE } = require('../../src/headless/cli-args');

/** 用真实 argv 形状（前两项是 node 与脚本路径） */
const argv = (...rest) => ['node', 'src/headless/main.js', ...rest];

describe('headless/cli-args', () => {
  it('缺省 = serve，且不覆盖任何配置', () => {
    const r = parseCliArgs(argv());
    expect(r.ok).toBe(true);
    expect(r.opts.command).toBe('serve');
    expect(r.opts.web).toBe(false);
    expect(r.opts.plans).toBe(false);
    expect(r.opts.port).toBe(0);
    expect(r.opts.workspace).toBe('');
  });

  it('run 的多个位置参数拼成任务文本（引号由 shell 处理）', () => {
    const r = parseCliArgs(argv('run', '看下', '这个仓库'));
    expect(r.opts.command).toBe('run');
    expect(r.opts.text).toBe('看下 这个仓库');
  });

  it('run 没有任务文本时直接报错（不静默跑一轮空消息）', () => {
    const r = parseCliArgs(argv('run'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/需要任务文本/);
  });

  it('--workspace 解析成绝对路径；--sandbox 只接受三档', () => {
    const ok = parseCliArgs(argv('serve', '--workspace', './tmp-fake'));
    expect(ok.opts.workspace).toBe(path.resolve('./tmp-fake'));
    expect(ok.opts.sandbox).toBe('');

    const bad = parseCliArgs(argv('serve', '--sandbox', 'root'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/read-only/);
  });

  it('缺值的开关报错：避免 --workspace 漏写后跑错目录', () => {
    const r = parseCliArgs(argv('serve', '--workspace'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/需要一个值/);

    const r2 = parseCliArgs(argv('serve', '--workspace', '--web'));
    expect(r2.ok).toBe(false);
  });

  it('未知参数 / 未知命令都拒绝（不猜用户意图）', () => {
    expect(parseCliArgs(argv('--nope')).ok).toBe(false);
    expect(parseCliArgs(argv('serv')).ok).toBe(false);
  });

  it('端口非法时报错，合法时保留数字', () => {
    expect(parseCliArgs(argv('serve', '--port', 'abc')).ok).toBe(false);
    expect(parseCliArgs(argv('serve', '--port', '0')).ok).toBe(false);
    expect(parseCliArgs(argv('serve', '--port', '17399')).opts.port).toBe(17399);
  });

  it('gen-key 必须给 --out；--help 只回帮助不解析', () => {
    expect(parseCliArgs(argv('gen-key')).ok).toBe(false);
    const h = parseCliArgs(argv('--help'));
    expect(h.help).toBe(true);
    expect(USAGE).toMatch(/dieyun-headless/);
  });

  it('日志级别归一：乱写的值退回 info，不静默变成「什么都不打」', () => {
    expect(parseCliArgs(argv('serve', '--log-level', 'debug')).opts.logLevel).toBe('debug');
    expect(parseCliArgs(argv('serve', '--log-level', 'loud')).opts.logLevel).toBe('info');
  });

  it('--version / -v 是「只回版本」，不启动任何东西', () => {
    for (const flag of ['--version', '-v']) {
      const r = parseCliArgs(argv(flag));
      expect(r.ok).toBe(true);
      expect(r.version).toBe(true);
      expect(r.opts).toBe(null);
    }
    expect(USAGE).toMatch(/--version/);
  });
});
