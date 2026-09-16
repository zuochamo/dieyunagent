# 升级文件发布目录

本目录用于 **本机联调**（`npm run sync:updates` + `npm run serve:updates`）。

## 生产发布（每次更新）

生产环境使用网络盘：

**`Y:\client-electron\updates-published`**

每次发版前：

1. 映射 Y:（见 [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md)「打包与发布」）
2. `npm run build`（先提升 `package.json` 版本号）
3. 执行 `scripts\publish-updates-to-y.bat`（从 `dist\` 发布当前版本的 `latest.yml`、安装包、blockmap 到 Y:）

客户端 `UPDATE_URL` 默认指向 `http://192.168.31.62:3099/`，须能访问上述目录中的文件。

## 本机静态服务（开发）

1. 在 Windows 上打包后，将 `dist/` 中更新相关文件同步到本目录：`npm run sync:updates`
2. 在项目根目录：`npm run serve:updates`
3. 将客户端 `UPDATE_URL` 设为终端打印的地址（例如 `http://192.168.1.10:3099/`，**末尾保留 /**）

勿将含敏感信息的文件提交到公开仓库；本目录下二进制可加入 `.gitignore`。
