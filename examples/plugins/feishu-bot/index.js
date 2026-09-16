'use strict';

function activate(ctx) {
  const http = typeof ctx.fetch === 'function' ? ctx.fetch.bind(ctx) : fetch;

  function sendText(text) {
    const cfg = ctx.readConfig();
    const url = String(cfg.webhookUrl || '').trim();
    if (!url) {
      const err = new Error('请在插件设置中配置飞书 Webhook');
      err.code = 'FEISHU_NOT_CONFIGURED';
      throw err;
    }
    const content = String(text || '').trim();
    if (!content) throw new Error('消息不能为空');
    return http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: content.slice(0, 4000) }
      })
    }).then(async (res) => {
      const body = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`飞书 API 失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = { raw: body };
      }
      if (parsed.StatusCode != null && Number(parsed.StatusCode) !== 0) {
        throw new Error(`飞书返回错误: ${parsed.msg || parsed.StatusMessage || body}`);
      }
      return { ok: true, response: parsed };
    });
  }

  return {
    handleTool(name, args) {
      if (name !== 'send_text') throw new Error(`未知工具: ${name}`);
      return sendText(args && args.text);
    },
    onPlanRan(event) {
      const cfg = ctx.readConfig();
      if (!cfg.notifyOnPlanRan) return;
      const ok = !!(event && event.ok);
      const title = (event && event.planName) || '定时任务';
      const summary = (event && event.summary) || (event && event.error) || '';
      const line = ok
        ? `✅ ${title} 执行成功\n${summary}`.trim()
        : `❌ ${title} 执行失败\n${(event && event.error) || summary}`.trim();
      return sendText(line.slice(0, 4000));
    }
  };
}

module.exports = { activate };
