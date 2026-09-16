---
name: Weather China · 中国天气
description: 叠云 Agent 预装精选技能
description_zh: "中国城市天气查询；用 web_fetch 调用 Open-Meteo，勿编造气温。"
category: 预装精选
skillKey: curated:weather-china
---

当用户询问中国城市天气、气温、降水、风力时，**必须用 `web_fetch` 查询 Open-Meteo**（禁止编造）。

1. `web_fetch` → `https://geocoding-api.open-meteo.com/v1/search?name={城市}&count=1&language=zh`
2. 取 `results[0]` 的经纬度与地名
3. `web_fetch` → `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`

将结果整理为简短中文；若无匹配城市或接口失败，说明原因并建议更具体的地名（如「上海浦东新区」）。
