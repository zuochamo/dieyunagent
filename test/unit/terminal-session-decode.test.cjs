'use strict';

const { createOutputStreamDecoder } = require('../../src/terminal/session');

/**
 * 回归点：本机（管道 stdio）终端输出的解码。
 * 旧实现每块 `new TextDecoder('gbk').decode(buf)`：写死 GBK（Win11 的 cmd 会混着吐 UTF-8，
 * 例如 sudo 提示 → 整行乱码），且没有跨块续接（被数据块切开的汉字解成 U+FFFD 并把后面几个
 * 字节一起带偏）。
 */
describe('terminal 输出解码：UTF-8 优先 + GBK 回落 + 跨块续接', () => {
  it('GBK（控制台码页）按 GBK 解', () => {
    const d = createOutputStreamDecoder();
    // B0 E6 B1 BE = “版本”
    expect(d(Buffer.from([0xb0, 0xe6, 0xb1, 0xbe]))).toBe('版本');
  });

  it('UTF-8 输出按 UTF-8 解，而不是按 GBK 变成乱码', () => {
    const d = createOutputStreamDecoder();
    const text = '已在此计算机上禁用 Sudo。若要启用它，请转到“设置”应用中的 Developer Settings page';
    expect(d(Buffer.from(text, 'utf8'))).toBe(text);
  });

  it('同一路输出里混着两种码页也各解各的', () => {
    const d = createOutputStreamDecoder();
    expect(d(Buffer.from([0xb0, 0xe6, 0xb1, 0xbe]))).toBe('版本');
    expect(d(Buffer.from('已在此计算机上禁用 Sudo。', 'utf8'))).toBe('已在此计算机上禁用 Sudo。');
    expect(d(Buffer.from([0xb0, 0xe6, 0xb1, 0xbe]))).toBe('版本');
  });

  it('ASCII 不做多余滞留（当块即出）', () => {
    const d = createOutputStreamDecoder();
    expect(d(Buffer.from('E:\\dieyunagent>ls -la\r\n', 'utf8'))).toBe('E:\\dieyunagent>ls -la\r\n');
  });

  it('跨块切开的 UTF-8 多字节字符能拼回来', () => {
    const d = createOutputStreamDecoder();
    const bytes = Buffer.from('版本', 'utf8'); // E7 89 88 E6 9C AC
    expect(d(bytes.subarray(0, 1))).toBe(''); // 只有首字节：等续字节
    expect(d(bytes.subarray(1, 3))).toBe('版');
    expect(d(bytes.subarray(3))).toBe('本');
  });

  it('跨块切开的 GBK 双字节字符能拼回来（旧实现解成 U+FFFD）', () => {
    const d = createOutputStreamDecoder();
    const bytes = Buffer.from([0xb0, 0xe6, 0xb1, 0xbe]); // 版本
    expect(d(bytes.subarray(0, 1))).toBe(''); // 前导字节单独到达
    expect(d(bytes.subarray(1))).toBe('版本'); // 后续即使像 UTF-8，也必须继续按 GBK 收尾
  });

  it('GBK 在「整对边界」被切开也正确', () => {
    const d = createOutputStreamDecoder();
    const bytes = Buffer.from([0xb0, 0xe6, 0xb1, 0xbe]);
    expect(d(bytes.subarray(0, 2))).toBe('版');
    expect(d(bytes.subarray(2))).toBe('本');
  });

  it('空块既不吐内容也不吞掉滞留字节', () => {
    const d = createOutputStreamDecoder();
    const bytes = Buffer.from('版本', 'utf8');
    expect(d(bytes.subarray(0, 1))).toBe('');
    expect(d(Buffer.alloc(0))).toBe('');
    expect(d(bytes.subarray(1))).toBe('版本');
  });
});
