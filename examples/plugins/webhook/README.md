# Webhook 示例插件

叠云用户插件示例。安装后在插件列表点击 **设置** 配置 Webhook URL（Phase 2 JSON Schema 表单）。

## 安装

1. 打开 **设置 → 扩展 → 插件**
2. **添加**：选择本目录；或 **从 Zip**：选择打包后的 `.zip`（根目录含 `dieyun-plugin.json`）
3. 启用插件
4. 点击 **设置**，填写 Webhook URL 并保存

也可手动编辑 `%AppData%/dieyunagent/plugins/com.dieyun.example.webhook/config.json`。

## 更新

重新选择文件夹或 Zip 安装同 id 插件；版本更高时会自动升级，更低版本需确认覆盖。

## 插件市场（Phase 3）

内置目录 `plugins/bundled/catalog.json`。设置 → 插件 → **市场** 可一键安装。

企业内网可在市场页添加扩展 **catalog.json** URL（HTTPS，JSON 格式与内置目录相同）。远程包可带 `downloadUrl` + 可选 `sha256` 校验。

## 生命周期 Hook

Manifest 可声明 `"hooks": ["onPlanRan"]`，入口实现同名方法：

- `onPlanRan(event)` — 定时任务执行完成后（需启用插件）
- `onAgentTurnEnd(event)` — 单次 Agent 对话轮次成功结束后

本示例 `onPlanRan` 在设置中开启「定时任务完成后通知」时向 Webhook 发送摘要。
