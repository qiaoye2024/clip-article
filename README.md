# clip-article

> 微信公众号文章 → Obsidian Markdown 笔记，一键剪藏。

把任意微信公众号文章 URL 转成 Obsidian 标准 `.md` 笔记，含 frontmatter、本地化图片、自动图注识别，留出 AI 填充的理解字段（标签、摘要、关键要点、我的思考、发芽）。

## 效果

**输入：** 一篇微信公众号文章链接

**输出：** 含 frontmatter + 本地图片 + AI 待填充字段的 `.md` 笔记。

## 依赖

| 依赖 | 说明 |
|------|------|
| **Chrome 浏览器**（或 TabBit 等 Chromium 内核浏览器） | 渲染微信页面 |
| **bash** + **curl** + **jq** + **python3** + **Node.js 22+** | 脚本运行环境 |
| **Obsidian** vault | 笔记存储位置 |

**自包含。** CDP 浏览器代理已捆在 `cdp-proxy/` 目录中，无需额外安装 web-access 等技能。

## 安装

```bash
git clone https://github.com/qiaoye2024/clip-article.git ~/.claude/skills/clip-article
```

安装后无需额外配置。首次运行时脚本会自动启动 Chrome 并建立 CDP 连接。

## 用法

在 Claude Code 中直接粘贴微信公众号文章链接即可自动触发。或手动运行：

```bash
cd /path/to/your-obsidian-vault
bash ~/.claude/skills/clip-article/clip.sh "https://mp.weixin.qq.com/s/xxx" "/path/to/vault"
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_PORT` | `3456` | CDP Proxy HTTP API 端口 |

## 工作原理

```
clip.sh（入口路由）
  │
  ▼
clip-fetch.sh（浏览器操控）
  │  启动 cdp-proxy/check-deps.mjs → cdp-proxy.mjs
  │  CDP HTTP API (localhost:3456)
  │  ├─ 打开微信公众号页面
  │  ├─ 滚动触发懒加载
  │  ├─ 提取元数据（标题/作者/日期）
  │  ├─ 注入 clip-html2md.js 浏览器端执行
  │  │   ├─ 8 条路径 + 多维打分模型提取图注
  │  │   ├─ HTML → Markdown 递归转换
  │  │   └─ 文本后处理（去重/推广清理/底部截断）
  │  └─ curl + fetch base64 双重下载图片
  │
  ▼
clip-assemble.py（笔记组装）
   ├─ 生成 Obsidian frontmatter
   ├─ 替换图片占位符（![[本地路径]]）
   ├─ 图注转灰色小字
   └─ 写入 .md 文件
```

## 文件说明

```
clip-article/
├── SKILL.md           # AI 指令（触发条件 + 4 步工作流 + 铁律）
├── clip.sh            # 一行入口，管道连接 fetch + assemble
├── clip-fetch.sh      # 浏览器操控、正文提取、图片下载
├── clip-html2md.js    # 浏览器端 JS：HTML→Markdown + 图注识别
├── clip-assemble.py   # 后端：JSON → Obsidian .md 组装
├── clip-fetch.md      # 设计文档（面向开发者）
└── cdp-proxy/         # CDP 浏览器代理（自包含）
    ├── cdp-proxy.mjs  # HTTP API 服务器，封装 Chrome DevTools Protocol
    └── check-deps.mjs # 环境检查 + 自动启动代理
```

## 图注识别

8 条 DOM 路径（优先级从高到低），每条路径的候选文本通过**多维打分模型**（长度、句号数、图注关键词、叙述性正文特征等维度）判断，≥ 60 分才认定为图注。

## 设计决策

**为什么要用浏览器而不是直接 curl？** 微信公众号文章是纯 JS 渲染的，curl 只能拿到空壳 HTML。

**为什么是 CDP 而不是 Puppeteer/Playwright？** CDP 直接操控用户本地 Chrome，带上 cookie、登录态、浏览器指纹，微信看到的是"正常人类在浏览"，有助于规避反爬。

**为什么图注提取放在浏览器端？** 图注判断依赖 CSS 样式、字号、布局位置，只能在页面内通过 JS 读取 computed style。

**为什么图片下载用 curl + fetch 双重策略？** curl 速度快但可能被防盗链拦截；fetch 在浏览器内执行，天然带 cookie/referer，作为兜底。

## CDP Proxy 可靠性

本包的 CDP Proxy 针对以下问题做了修复：

- **陈旧 UUID 死循环**：启动时通过 `/json/version` 验证 Chrome 实例身份，不再盲信缓存文件
- **孤儿进程堆积**：启动时自动清理上次会话残留的 Chrome 进程
- **连接状态检查**：剪藏脚本启动时验证 proxy 已实际连接 Chrome，未连接则自动重启

## 致谢

CDP Proxy 部分（`cdp-proxy/`）源自 [eze-is/web-access](https://github.com/eze-is/web-access)（MIT License），在此基础上增加了上述可靠性修复。

## License

MIT
