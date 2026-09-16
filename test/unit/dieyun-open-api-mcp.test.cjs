'use strict';

const {
  OPEN_API_MCP_DEFS,
  isOpenApiMcpId,
  buildDieyunServiceConfigForUi,
  getDieyunOpenApiEnvFromDeploy,
  mergeMcpServerSecrets
} = require('../../src/mcp/open-api-deploy-env');
const { listBuiltinMcpServers } = require('../../src/mcp/registry');
const { resolveBundledMcpLaunch } = require('../../src/mcp/bundled-launch');

describe('dieyun open api split mcps', () => {
  it('registers four named builtins', () => {
    const ids = listBuiltinMcpServers()
      .filter((s) => isOpenApiMcpId(s.id))
      .map((s) => s.name);
    expect(ids).toEqual(['叠云代账', '叠云Tools', '叠云Index', 'PixelOfficeMonitor']);
    expect(OPEN_API_MCP_DEFS).toHaveLength(4);
  });

  it('launch sets DIEYUN_OPEN_API_SERVICE', () => {
    const launched = resolveBundledMcpLaunch({
      id: 'mcp-daizhang',
      bundledServer: 'dieyun-open-api',
      openApiService: 'daizhang',
      command: 'bundled',
      args: []
    });
    expect(launched.launchEnv.DIEYUN_OPEN_API_SERVICE).toBe('daizhang');
    expect(launched.launchEnv.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('per-service ui config', () => {
    const ui = buildDieyunServiceConfigForUi(
      'daizhang',
      { env: {} },
      {
        deployEnv: {
          DAIZHANG_API_URL: 'http://192.168.31.62:3011/api/open-api/v1',
          DAIZHANG_API_KEY: 'sk_x'
        },
        processEnv: {}
      }
    );
    expect(ui.configKind).toBe('dieyun-service');
    expect(ui.label).toBe('叠云代账');
    expect(ui.key).toBe('sk_x');
  });

  it('merge secrets only injects that service', () => {
    const merged = mergeMcpServerSecrets(
      'mcp-tools',
      { token: '', env: {} },
      {
        deployEnv: getDieyunOpenApiEnvFromDeploy({
          deployConfig: {
            openApi: {
              tools: { url: 'http://x:5000/api/open-api/v1', key: 'sk-tools' },
              daizhang: { url: 'http://x:3011/api/open-api/v1', key: 'sk-dz' }
            }
          },
          serviceId: 'tools'
        }),
        applyProcessEnv: false
      }
    );
    expect(merged.env.TOOLS_API_KEY).toBe('sk-tools');
    expect(merged.env.DAIZHANG_API_KEY).toBeUndefined();
  });
});
