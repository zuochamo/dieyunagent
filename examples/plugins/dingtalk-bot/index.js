'use strict';

const crypto = require('crypto');

function activate(ctx) {
  const http = typeof ctx.fetch === 'function' ? ctx.fetch.bind(ctx) : fetch;

  function signedUrl(baseUrl) {
    const cfg = ctx.readConfig();
    const secret = String(cfg.secret || '').trim();
    if (!secret) return baseUrl;
    const ts = Date.now();
    const str = `${ts}\n${secret}`;
    const sign = encodeURIComponent(
      crypto.createHmac('sha256', secret).update(str).digest('base64')
    );
    const u = new URL(baseUrl);
    u.searchParams.set('timestamp', String(ts));
    u.searchParams.set('sign', sign);
    return u.toString();
  }

  function postMessage(payload) {
    const cfg = ctx.readConfig();
    const base = String(cfg.webhookUrl || '').trim();
    if (!base) {
      const err = new Error('请在插件设置中配置钉钉 Webhook');
      err.code = 'DINGTALK_NOT_CONFIGURED';
      throw err;
    }
    const url = signedUrl(base);
    return http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async (res) => {
      const body = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`钉钉 API 失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = { raw: body };
      }
      if (parsed.errcode != null && Number(parsed.errcode) !== 0) {
        throw new Error(`钉钉返回错误: ${parsed.errmsg || body}`);
      }
      return { ok: true, response: parsed };
    });
  }

  return {
    handleTool(name, args) {
      const a = args || {};
      if (name === 'send_text') {
        return postMessage({ msgtype: 'text', text: { content: String(a.text || '').slice(0, 4000) } });
      }
      if (name === 'send_markdown') {
        return postMessage({
          msgtype: 'markdown',
          markdown: {
            title: String(a.title || '').slice(0, 200),
            text: String(a.text || '').slice(0, 4000)
          }
        });
      }
      throw new Error(`未知工具: ${name}`);
    }
  };
}

module.exports = { activate };
