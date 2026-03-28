# 飞书日历 / Feishu Calendar for Obsidian

在 Obsidian 里直接打开飞书日历，并把飞书日程操作纳入笔记工作流。

Open Feishu Calendar directly inside Obsidian and bring calendar workflows closer to your notes.

## 项目定位 / What This Plugin Does

- 在 Obsidian 内嵌显示飞书日历网页
- 默认隐藏飞书网页左侧栏，并支持一键切换
- 优先通过飞书 API 进行日程创建、读取、更新、删除
- 保留飞书 CalDAV 兼容能力，方便复用到 macOS Calendar.app

- Embed the Feishu Calendar web app inside Obsidian
- Hide the Feishu web sidebar by default and toggle it on demand
- Use the Feishu API as the primary path for event create, read, update, and delete
- Keep Feishu CalDAV as a compatibility layer for reuse in macOS Calendar.app

## 功能亮点 / Highlights

- 左侧 Ribbon 图标一键打开飞书日历视图
- 自定义 Obsidian 视图，而不是简单外链跳转
- 中文文案界面，适合作为中文用户的日常工作流入口
- 支持飞书网页视图和飞书日程数据两条路径并存

- Open the calendar from a dedicated ribbon icon
- Use a custom Obsidian view instead of a simple external link
- Chinese-first UI copy for daily use
- Combine an embedded Feishu web view with direct Feishu event data operations

## 安装 / Install

### BRAT

1. 安装并启用 BRAT
2. 添加本仓库
3. 安装插件

### 手动安装 / Manual

将以下文件放到 Vault 的 `.obsidian/plugins/feishu-calendar-launcher/` 目录：

- `manifest.json`
- `main.js`
- `styles.css`
- `caldav.js`
- `feishu-api.js`
- `ics.js`

## 配置 / Setup

### 1. 飞书日历网页地址 / Feishu Calendar URL

在插件设置中填写你的飞书日历网页地址，例如：

`https://<tenant>.feishu.cn/calendar/week`

### 2. 飞书 API / Feishu API

在插件设置中填写：

- `飞书 user_access_token`
- 如有需要，点击“读取主日历”自动填充 `飞书 API 日历 ID`

填写 Token 后，插件会优先使用飞书 API 执行日程 CRUD。

Add your Feishu `user_access_token` in plugin settings.  
If needed, click the primary calendar action to auto-fill the `Feishu API Calendar ID`.

Once a token is configured, the plugin prefers the Feishu API for event CRUD.

### 3. CalDAV 配置 / CalDAV Credentials

如果你还需要接入 macOS Calendar.app，先在飞书中生成 CalDAV 配置，然后在插件设置中填写：

- `CalDAV 服务器地址`
- `CalDAV 用户名`
- `CalDAV 密码`

之后可以点击“测试连接”并选择目标日历。

If you also want to use macOS Calendar.app, generate Feishu CalDAV credentials first and fill in the same account details in plugin settings.

## macOS Calendar.app

本插件不会自动修改 macOS 系统日历配置，而是复用同一套飞书 CalDAV 账号。

你可以在插件设置中点击“复制 CalDAV 配置”，然后到 macOS Calendar.app 手动添加 CalDAV 账户。

This plugin does not configure macOS Calendar.app automatically.  
Instead, it helps you reuse the same Feishu CalDAV account and copy the necessary settings.

## 当前状态 / Current Status

- 适合单飞书账户、单目标日历的个人工作流
- API 模式用于主读写路径
- CalDAV 模式主要保留给兼容读取和 macOS 复用

- Best suited for a single-account, single-calendar workflow
- API mode is the primary read/write path
- CalDAV is mainly kept for compatibility and macOS reuse

## 已知限制 / Known Limitations

- 当前只支持单飞书账户和单目标日历
- 飞书网页内部左侧栏的隐藏逻辑依赖当前网页结构，飞书改版后可能需要插件更新
- 飞书 API 模式依赖有效的 `user_access_token`，Token 过期后需要重新填写
- 飞书当前 CalDAV 实测可用于读取和同步，但写入会返回 `409`，因此插件在飞书环境下默认只将 CalDAV 用作兼容层

- Only one Feishu account and one target calendar are supported right now
- The sidebar-hiding logic depends on Feishu's current web DOM structure
- API mode requires a valid `user_access_token`
- Feishu CalDAV works for read/sync in practice, but write requests currently return `409`, so CalDAV is treated as a compatibility layer

## 发布文件 / Release Files

如果你不做 bundling，每次 GitHub Release 至少需要包含：

- `manifest.json`
- `main.js`
- `styles.css`
- `caldav.js`
- `feishu-api.js`
- `ics.js`

If you publish without bundling, include at least these files in each GitHub release:

- `manifest.json`
- `main.js`
- `styles.css`
- `caldav.js`
- `feishu-api.js`
- `ics.js`

如果后续提交到 Obsidian 社区插件目录，还需要在仓库根目录保留：

- `versions.json`
- `README.md`
- `LICENSE`

For an eventual Obsidian community plugin submission, also keep these files at the repository root:

- `versions.json`
- `README.md`
- `LICENSE`
