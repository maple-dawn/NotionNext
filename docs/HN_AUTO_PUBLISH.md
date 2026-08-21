# Hacker News 中文文章自动发布

该任务每天读取 Hacker News Active，选择前 10 条中第一篇尚未发布且能完整提取正文的文章，使用 Gemini 翻译为简体中文，再写入 NotionNext 数据库。

## 1. 创建 Notion 专用连接

1. 在 Notion 开发者工具的“连接”页面新建内部连接，名称建议使用 `HN Blog Publisher`。
2. 只启用读取内容、插入内容和更新内容能力。
3. 打开“晨枫博客”数据库，通过页面的连接菜单将该数据库共享给 `HN Blog Publisher`。
4. 保存连接令牌。不要把令牌提交到 Git。

任务使用 Notion API `2025-09-03`，会从数据库 ID 自动发现唯一的 `data_source_id`。如果以后给数据库增加多个数据源，任务会停止并要求明确指定目标，不会向未知数据源写入。

数据库必须保留以下 NotionNext 标准字段及类型：

| 字段 | 类型 | 必需选项 |
| --- | --- | --- |
| `type` | Select | `Post` |
| `status` | Select 或 Status | `Published` |
| `title` | Title | — |
| `summary` | Rich text | — |
| `slug` | Rich text | — |
| `category` | Select | `新闻` |
| `date` | Date | — |
| `tags` | Multi-select | — |

## 2. 创建 Gemini API Key

在 Google AI Studio 创建 Gemini API Key。默认模型是 `gemini-3.5-flash-lite`。免费层提交的内容可能被 Google 用于改进产品；如不接受这一点，不要启用任务。

## 3. 配置 Vercel

在 Vercel 项目的 Production 环境添加：

```text
NOTION_API_TOKEN=<HN Blog Publisher 的令牌>
NOTION_DATABASE_ID=5dc97cb8ae4f4dad91bb3a0cbf7df3c8
GEMINI_API_KEY=<Gemini API Key>
GEMINI_MODEL=gemini-3.5-flash-lite
CRON_SECRET=<至少 16 位的随机字符串>
```

`CRON_SECRET` 设置后，Vercel Cron 会自动用 `Authorization: Bearer <CRON_SECRET>` 调用受保护接口。部署 `vercel.json` 后，任务每天 UTC 00:00（新加坡时间约 08:00）执行。Vercel Hobby 计划可能在该小时内延迟触发。

## 4. 上线验收

部署后先执行 dry-run。它会读取 Notion 做去重、抓取文章并调用 Gemini，但不会创建页面：

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.imaple.tech/api/cron/hn-publish?dryRun=1"
```

成功时返回 `status: "skipped"` 和 `reason: "dry_run"`。确认 Vercel 日志中的提取、块数量和翻译耗时正常后，再手动执行一次正式发布：

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.imaple.tech/api/cron/hn-publish"
```

正式成功返回 `status: "published"`、HN item ID、Notion 页面 ID 和文章地址。文章通常会在网站下一次 ISR 刷新后出现。

## 行为说明

- slug 固定为 `hn-{HN item ID}`，已存在的 slug 会被跳过。
- 付费墙、PDF、空正文、纯客户端页面、私网地址、超长文章或无法在 100 个 Notion 块内完整表达的文章会被跳过，并继续尝试下一条。
- 图片不会复制或热链；标题、段落、列表、引用、代码和链接会保留。
- Gemini 或 Notion 的认证、限流和服务错误会终止当次任务，避免误发多篇。
- 不会绕过登录、付费墙或反爬措施。自动发布全文所需的转载授权仍由站点所有者负责。
