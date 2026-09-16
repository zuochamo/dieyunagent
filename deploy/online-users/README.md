# 叠云 Agent 工位监控（内网）

内网 **工位监控**：Socket.IO 实时 CPU / 键鼠。客户端 `SERVER_URL` 指向本服务。

## 与桌面客户端的关系

| 能力 | 客户端配置 | 服务端 |
|------|-----------|--------|
| **工位监控**（默认开，可关） | `SERVER_URL=http://192.168.31.62:3003` | `workplace-server.mjs` |

可在客户端「设置 → 权限」关闭工位监控上报。

## 快速启动

```bash
cd deploy/online-users
npm install
npm start
```

浏览器或脚本可请求：**http://localhost:3003/api/users/online**

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` / `ONLINE_USERS_PORT` | 3003 | 服务端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `GEO_CACHE_TTL_MS` | 6h | IP 地理信息缓存 |
| `OFFLINE_MS` | 35000 | 离线判定 |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/users/online` | 在线用户列表 |
| Socket.IO | `register` / `status-update` | 客户端实时上报 |

## 目录结构

```
deploy/online-users/
  workplace-server.mjs    # 内网工位监控（Socket.IO）
  start.bat
```
