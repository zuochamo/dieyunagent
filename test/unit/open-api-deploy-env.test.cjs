'use strict';

const {
  getDieyunOpenApiEnvFromDeploy,
  mergeMcpServerSecrets
} = require('../../src/mcp/open-api-deploy-env');

describe('open-api-deploy-env', () => {
  it('maps deploy.openApi to env vars', () => {
    const env = getDieyunOpenApiEnvFromDeploy({
      deployConfig: {
        openApi: {
          daizhang: { url: 'http://127.0.0.1:3011/api/open-api/v1/', key: 'sk_a' },
          pixel: { url: 'http://127.0.0.1:3003/api/open-api/v1', apiKey: 'pom_x' }
        }
      }
    });
    expect(env.DAIZHANG_API_URL).toBe('http://127.0.0.1:3011/api/open-api/v1');
    expect(env.DAIZHANG_API_KEY).toBe('sk_a');
    expect(env.PIXEL_API_KEY).toBe('pom_x');
    expect(env.TOOLS_API_KEY).toBeUndefined();
  });

  it('merges deploy env into mcp secrets without overriding existing', () => {
    const merged = mergeMcpServerSecrets(
      'mcp-daizhang',
      { token: '', env: { DAIZHANG_API_KEY: 'from-creds' } },
      {
        deployEnv: {
          DAIZHANG_API_KEY: 'from-deploy',
          DAIZHANG_API_URL: 'http://x/api'
        },
        applyProcessEnv: false
      }
    );
    expect(merged.env.DAIZHANG_API_KEY).toBe('from-creds');
    expect(merged.env.DAIZHANG_API_URL).toBe('http://x/api');
  });

});
