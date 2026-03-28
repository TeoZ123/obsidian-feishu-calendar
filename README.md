# 飞书日历 / Feishu Calendar for Obsidian

在 Obsidian 内嵌显示飞书日历，优先通过飞书 API 完成日程读写，并保留飞书 CalDAV 兼容能力。

Embed Feishu Calendar inside Obsidian, use the Feishu API for event CRUD, and keep Feishu CalDAV as a compatibility layer.

## 功能 / Features

- 在左侧 Ribbon 中打开飞书日历视图
- 默认隐藏飞书网页内部左侧栏，并支持一键切换
- 基于飞书 API 的日程创建、读取、更新、删除
- CalDAV 读取与同步兼容层
- 复制同一套 CalDAV 配置给 macOS Calendar.app

- Open Feishu Calendar from the Obsidian ribbon
- Hide/show Feishu's internal web sidebar
- Feishu API based event create, read, update, and delete
- CalDAV read/sync compatibility layer
- Reuse the same CalDAV account in macOS Calendar.app

## 安装 / Install

### BRAT

1. 安装并启用 BRAT
2. 添加此仓库
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

填写 Token 后，插件会优先走飞书 API 做日程 CRUD。

### 3. CalDAV 配置 / CalDAV Credentials

如果你还需要同步到 macOS Calendar.app，先在飞书中生成 CalDAV 配置，然后在插件设置中填写：

- `CalDAV 服务器地址`
- `CalDAV 用户名`
- `CalDAV 密码`

之后可以点击“测试连接”并选择目标日历。

## macOS Calendar.app

本插件不会替你自动配置 macOS 日历，而是复用同一套飞书 CalDAV 账号。

在插件设置中点击“复制 CalDAV 配置”，然后到 macOS Calendar.app 手动添加 CalDAV 账户。

## 已知限制 / Known Limitations

- 当前只支持单飞书账户和单目标日历
- 飞书网页内部左侧栏的隐藏逻辑依赖当前网页结构，飞书改版后可能需要插件更新
- 飞书 API 模式依赖有效的 `user_access_token`，Token 过期后需要重新填写
- 飞书当前 CalDAV 实测可用于读取/同步，但写入会返回 `409`，因此插件在飞书环境下默认只将 CalDAV 用作兼容层

## 发布 / Release

如果你不做 bundling，每次 GitHub Release 至少需要包含：

- `manifest.json`
- `main.js`
- `styles.css`
- `caldav.js`
- `feishu-api.js`
- `ics.js`

如果后续发布到 Obsidian 社区插件目录，还需要在仓库根目录保留：

- `versions.json`
- `README.md`
- `LICENSE`
