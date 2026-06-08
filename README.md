# AI HOT Daily Briefing

这是一个轻量化 AI 资讯日报系统：不用本机常驻，Cloudflare Worker 每天定时抓取 AI HOT 原站精选内容，推送简洁飞书日报，并把完整内容归档成可打开的知识卡片。

## 当前定位

- 飞书群：只发简洁日报，方便大家快速扫一眼。
- 飞书多维表格：只做“日报索引库”，一天一行，避免触碰行数上限。
- Cloudflare KV：保存完整归档，是外挂知识库的数据底座。
- 网页端：提供知识库总入口和某一天的可视化知识卡片，用来检索、筛选、回看、复盘和分享。

## 工作流程

1. Cloudflare Cron 每天北京时间 21:29 触发。
2. Worker 抓取 AI HOT 原站公开接口。
3. Worker 选出当日资讯和论文候选。
4. Worker 调用配置的大模型接口生成简洁总结；失败时会明确标记，不静默伪装。
5. Worker 写入 Cloudflare KV：`archive:YYYY-MM-DD` 保存当天完整知识卡片。
6. Worker 写入飞书多维表格：一天只写一行日报索引。
7. Worker 等到北京时间 21:30，再推送飞书群日报。

## 日报索引库字段

索引库只保留给团队查看有意义的字段：

```text
日期
今日一句话
今日重点
最新论文
工具项目
关键方向
知识卡片入口
```

这些字段的作用：

- `日期`：按天定位日报。
- `今日一句话`：快速判断当天主线。
- `今日重点`：当天最值得扫的少量内容。
- `最新论文`：适合实验室同学继续阅读、复现或跟踪的论文线索。
- `工具项目`：值得试用、复现或调研的工具线索。
- `关键方向`：用于筛选方向，例如智能体、RAG、AI Coding、论文评测等。
- `知识卡片入口`：打开网页端可视化卡片，这才是真正展开阅读的地方。

不再展示这些后台字段：批次时间、总条数、模型、Tokens、归档说明、完整归档键。它们对阅读者没有帮助，只保留在后台结果中用于排障。

## 知识库网页

知识卡片不是多维表格里的一大坨文字。网页端分两层：

```text
https://aihot.agflow.cc/library
```

这是总入口，支持：

- 跨日期搜索标题、来源、方向和用途
- 按日期按钮快速筛某一天
- 按开始/结束日期筛选一段时间
- 按类型筛选论文、工具、模型、行业等
- 最近 7/30/90 天阶段复盘

```text
https://aihot.agflow.cc/daily?date=YYYY-MM-DD
```

这是单日详情页。

每张卡片包含：

- 标题
- 来源
- 原文链接
- 一句话事实
- 方向标签
- 用途
- 下一步建议

它的作用不是复刻原站，而是把每天已经推送过的信息沉淀下来：后面想找某一天、某个方向、某篇论文或某个工具时，可以直接搜索和筛选，不用翻飞书群，也不用回到原站重新筛。

多维表格只放入口和少量索引，避免变成难读的文字墙。

## 数据保留策略

- 旧表 `AI HOT数据库` 已废弃并删除。
- 旧表 `AI HOT 知识卡片库` 已废弃并删除。
- 当前只保留 `AI HOT 日报索引库`。
- KV 只保留 `archive:*` 完整归档和少量 `bitable:*` 去重标记。
- 一天一行索引，完整明细放 KV，不会消耗飞书多维表格行数。

## 管理接口

所有管理接口都需要 `ADMIN_TOKEN`。

```text
GET /health
GET /run-now
GET /archive-now
GET /reset-index-library
GET /api/latest
GET /api/index-status
GET /api/archive?date=YYYY-MM-DD
GET /library
GET /review
GET /daily?date=YYYY-MM-DD
```

- `/run-now`：立刻抓取并推送到飞书群。
- `/archive-now`：只归档和写索引，不推送飞书群。
- `/reset-index-library`：清理旧表、旧字段、旧记录，并从 KV 重建日报索引库。
- `/api/index-status`：查看索引库当前字段、记录数和入口。
- `/api/archive`：读取某天完整归档。
- `/library`：打开跨日期知识库入口。
- `/review`：同样打开知识库入口，默认展示阶段复盘。
- `/daily`：打开某天可视化知识卡片网页。

## 当前部署

```text
Worker: https://aihot-feishu-briefing.weinihu9527.workers.dev
Custom Domain: https://aihot.agflow.cc
Cron: 29 13 * * *  // 北京时间 21:29 触发，21:30 推送
Model: gpt-5.5
```

对外描述时建议这样说：这个项目部署在 Cloudflare Worker 上，并绑定了自定义域名 `aihot.agflow.cc`。Worker 负责定时任务、数据归档、飞书推送和知识库网页渲染。

## 成本边界

主要成本来自大模型 API。飞书多维表格只存每天一行，不按新闻条目增加行数。Cloudflare KV 当前只保存按日归档，体量很小，适合继续作为轻量知识库底座。
