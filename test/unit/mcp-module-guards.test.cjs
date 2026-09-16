'use strict';

const { serverSignature } = require('../../src/mcp/runtime-manager');
const { runtimeArgsWithoutNpxPackage, getMcpNpmPackageMeta } = require('../../src/mcp/package-store');

describe('mcp session signature', () => {
  const remote = {
    id: 'mcp-remote',
    transportKind: 'remote',
    remoteUrl: 'https://example.com/mcp',
    remoteTransport: 'streamable-http',
    authHeaderName: 'Authorization'
  };

  it('changes when the token value changes', () => {
    expect(serverSignature(remote, { token: 'token-A' })).not.toBe(
      serverSignature(remote, { token: 'token-B' })
    );
  });

  it('never embeds the raw token', () => {
    expect(serverSignature(remote, { token: 'super-secret-value' }).includes('super-secret-value')).toBe(
      false
    );
  });

  it('is stable for the same token and for empty tokens', () => {
    expect(serverSignature(remote, { token: 'x' })).toBe(serverSignature(remote, { token: 'x' }));
    expect(serverSignature(remote, {})).toBe(serverSignature(remote, { token: '' }));
  });

  it('still tracks stdio env changes', () => {
    const stdio = { id: 's', command: 'node', args: ['a.js'] };
    expect(serverSignature(stdio, { env: { K: '1' } })).not.toBe(
      serverSignature(stdio, { env: { K: '2' } })
    );
  });
});

describe('npx runtime args', () => {
  it('drops -y and the package arg only', () => {
    const server = { id: 'mcp-x', command: 'npx', args: ['-y', '@scope/pkg@1.2.3', '2'] };
    const meta = getMcpNpmPackageMeta(server);
    expect(meta.name).toBe('@scope/pkg');
    expect(meta.version).toBe('1.2.3');
    expect(runtimeArgsWithoutNpxPackage(server.args, meta)).toEqual(['2']);
  });

  it('keeps a numeric arg whose text equals a removed index', () => {
    // argIndex=1 会被移除；参数值 "1" 恰好等于该索引文本，旧实现会把两者一起删掉
    const args = ['-y', '@scope/pkg', '1'];
    const meta = { argIndex: 1, flagIndex: -1 };
    expect(runtimeArgsWithoutNpxPackage(args, meta)).toEqual(['1']);
  });
});
