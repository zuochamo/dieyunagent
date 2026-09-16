---
name: Baidu Search · 百度搜索
description: 叠云 Agent 预装精选技能
description_zh: "通过百度搜索关键词；可打开结果页或结合多引擎技能获取摘要。"
category: 预装精选
skillKey: curated:baidu-search
---

用户需要百度网页搜索时：

1. 优先使用 `host_open_url` 打开 `https://www.baidu.com/s?wd=` + URL 编码后的关键词，供用户查看结果。
2. 若已启用「多引擎搜索」能力，可配合 `multi-search-engine` 技能中的 Baidu 引擎说明，用 `host_exec` / 抓取方式获取摘要（遵守站点规则）。
3. 不要伪造搜索结果列表；无法抓取时说明已打开搜索页请用户查看。
