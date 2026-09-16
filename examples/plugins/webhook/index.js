'use strict';

/** @param {{ installPath: string, readConfig: () => object, writeConfig: (data: object) => void, log: Function, fetch?: Function }} ctx */
function activate(ctx) {
  const http = typeof ctx.fetch === 'function' ? ctx.fetch.bind(ctx) : fetch;

  function postPayload(payload) {
    const cfg = ctx.readConfig();
    const url = String(cfg.webhookUrl || '').trim();
    if (!url) return Promise.resolve({ skipped: true, reason: 'no_url' });
    return http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async (res) => {
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`Webhook 失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return { ok: true, status: res.status, body: text.slice(0, 500) };
    });
  }

  return {
    handleTool(name, args) {
      if (name !== 'send') {
        throw new Error(`未知工具: ${name}`);
      }
      const cfg = ctx.readConfig();
      const url = String(cfg.webhookUrl || '').trim();
      if (!url) {
        const err = new Error('请在插件设置中配置 Webhook URL');
        err.code = 'WEBHOOK_NOT_CONFIGURED';
        throw err;
      }
      const payload = args && args.payload != null ? args.payload : {};
      return postPayload(payload);
    },
    onPlanRan(event) {
      const cfg = ctx.readConfig();
      if (!cfg.notifyOnPlanRan) return;
      return postPayload({
        type: 'plan_ran',
        planId: event && event.planId,
        planName: event && event.planName,
        ok: !!(event && event.ok),
        summary: event && event.summary,
        error: event && event.error,
        sessionId: event && event.sessionId
      });
    }
  };
}

module.exports = { activate };
