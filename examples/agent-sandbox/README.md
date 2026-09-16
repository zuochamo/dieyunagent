# Agent Sandbox

最小工作区，供 Agent 在 **不污染主 UI** 的情况下验证写文件、改 HTML/CSS/JS。

## 用途

- `test:tool-harness` / `test:sandbox-smoke` 默认 workspace
- 手动：在叠云 Agent 中把工作区切到 `examples/agent-sandbox`
- 适合练手任务：改按钮文案、加计数器、调样式

## 文件

| 文件 | 说明 |
|------|------|
| `index.html` | 静态页面入口 |
| `app.js` | 简单交互逻辑 |
| `styles.css` | 样式 |
| `README.md` | 本说明 |

## 验证

```bash
npm run test:sandbox-smoke
npm run test:tool-harness
```

## 注意

- 勿把 dieyunagent 核心业务逻辑放进此目录
- 改 sandbox 后跑 `npm run test:sandbox-smoke`
