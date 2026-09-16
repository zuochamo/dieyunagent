---
name: 查询天气
description: 查询中国及全球城市的实时天气（温度、湿度、风力、天气现象）
description_zh: "查询城市实时天气；用 web_fetch 调用 Open-Meteo，勿编造气温。"
category: 生活服务
skillKey: weather
---

当用户询问某地天气、气温、是否下雨/下雪时，**必须用 `web_fetch` 查询 Open-Meteo**（禁止编造）。

1. 地理编码：`https://geocoding-api.open-meteo.com/v1/search?name={URL编码城市名}&count=1&language=zh`
2. 从 JSON 的 `results[0]` 取 `latitude`、`longitude`、`name`、`admin1`
3. 预报：`https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`
4. 从 `current` 整理温度（℃）、湿度（%）、风速（km/h）；`weather_code` 常见：0 晴、2 多云、3 阴、45 雾、61–65 雨、71–75 雪、95 雷暴

若无 `results` 或请求失败，说明原因并建议更具体的城市名。
