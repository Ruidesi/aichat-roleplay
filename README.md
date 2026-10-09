# AI 角色聊天

一个以中文体验为主的自托管 AI 角色聊天应用：从 Chub 获取角色、导入或创作角色卡，与角色进行流式对话，也可以围绕上传的文件聊天。项目使用原生浏览器界面、Node.js 内置模块和 SQLite，核心应用没有 npm 运行依赖，也不需要前端构建步骤。

本仓库提供脱敏后的应用源码和配置示例，不包含运行数据库、用户聊天记录、角色镜像、账号凭据或外部服务。项目采用 [MIT 许可证](LICENSE)，允许商用与修改，分发时须保留版权及许可声明。第三方角色卡、模型和素材不自动适用本项目的 MIT 许可。

## 功能

- **角色与剧情卡**：Chub 在线搜索、本地镜像浏览，自建角色卡和剧情卡，JSON / PNG 角色卡导入导出，私有或公开可见性，世界书设定。
- **角色对话**：SSE 流式回复、模型切换、用户人设、会话级角色设定、回复重生成，以及消息编辑与删除。
- **中文翻译**：角色卡翻译、译文版本历史与用户独立选择；支持模型 API，以及可选的本机 Grok CLI 翻译入口。
- **文件与语音**：文件提取文本后开聊，长文使用分块检索；录音经语音识别后整理为消息。部分格式依赖 macOS 工具，详见下方限制。
- **账号与管理**：超级管理员、管理员、租户角色，邀请码、密码重置、登录记录、模型配置、调用用量与费用记录、系统日志和自建卡管理。
- **浏览体验**：桌面与移动端布局、阅读设置、图片浏览和缩略图缓存。

## 技术栈

| 层次 | 实现 |
| --- | --- |
| 前端 | 原生 JavaScript ES Modules、HTML、CSS；Hash 路由；Fetch 读取 SSE |
| 后端 | Node.js ESM；内置 HTTP / HTTPS、文件系统、加密、网络与子进程模块 |
| 数据库 | `node:sqlite` 的 `DatabaseSync`；SQLite、WAL、版本迁移 |
| 模型接口 | OpenAI 兼容的 `/chat/completions` HTTP API；支持流式响应与可配置代理 |
| 文件处理 | Node.js 文本处理与工作线程；可选 Swift PDFKit / Vision 和系统命令 |
| 镜像读取 | 只读 SQLite 索引、文件目录；可选 NAS API 或 Python 读取进程 |
| 测试 | Node.js 内置 `node:test` 与 `assert`，本地假上游和临时数据库 |

## 本地启动

发布整理使用的 Node.js 版本为 **22.17.0**。运行环境需要支持 `node:sqlite` 和 `--env-file`；可先检查：

```sh
node --version
node -e "require('node:sqlite')"
```

获取源码后，在仓库根目录创建自己的配置：

```sh
git clone https://github.com/Ruidesi/aichat-roleplay.git
cd aichat-roleplay
```

```sh
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，将 `ADMIN_BOOTSTRAP_PASSWORD` 填为自行设置的强密码，保留示例中的 `PORT=44982`、`MODEL_SEED_PROBE=0` 和 `SWIFT_WARMUP=0`，然后启动：

```sh
node --env-file=.env server.mjs
```

浏览器访问 <http://localhost:44982>，使用初始用户名 `admin` 和自行设置的密码登录。仅在数据库不存在启用的超级管理员时，启动密码才会触发创建或恢复账号；初始化后可清空该变量。也可以使用交互式脚本创建或重置管理员，密码输入不回显：

```sh
node --env-file=.env scripts/create-admin.mjs admin --role super
```

应用不会自动读取 `.env`，因此需要命令中的 `--env-file=.env`。数据目录和 SQLite 表会在启动时创建。默认监听所有网络接口；上述地址只是本机访问入口，部署时请按需要配置网络访问范围与 HTTPS。

### 配置模型与角色来源

登录后在管理界面填写可用模型的接口地址、模型 ID 和自己的 API 密钥。应用使用 OpenAI 兼容接口，不内置模型权重；没有配置模型时可以启动界面，但无法生成回复。

也可以在 `AI_KEYS_FILE` 指定的文件中配置服务商密钥，例如自行创建 `config/ai-keys.env` 并填写 `DEEPSEEK_API_KEY`。该文件与应用的 `.env` 用途不同：模型模块直接读取密钥文件，单独向进程环境注入同名密钥不能替代它。预置模型名称及 ID 见 [server/models.mjs](server/models.mjs)，能否调用以服务商实际账号、模型和接口支持为准。

首次使用没有本地角色镜像时，可在发现页切换到 **Chub 在线来源**，或先创建、导入自己的角色卡。首页及默认本地来源依赖另行准备的镜像库，源码仓库没有附带角色数据集。

## 角色设定如何进入提示词

每次生成都会重新组装角色描述、性格、场景、用户人设、世界书命中条目和对话历史。`{{char}}` / `<BOT>` 与 `{{user}}` / `<USER>` 宏会替换为当前角色和用户称呼；剧情卡使用叙述者及 NPC 口吻。

组装器加入简体中文、角色口吻、不替用户说话或行动等规则，并附加成年人及未成年人性内容拒绝规则。示例对话最多保留 2,000 字符，历史按从新到旧约 24,000 字符预算选择，至少保留最后一条；世界书另有 4,000 字符预算。会话级设定与人设覆盖可以独立调整，卡片的历史后提示会追加在历史之后。

这些机制为模型持续提供角色依据，但不能保证始终不偏离设定，也不构成提示词注入防护保证。自定义系统提示、导入卡片及历史后提示都会影响最终结果。具体实现见 [server/prompt.mjs](server/prompt.mjs)、[server/cards.mjs](server/cards.mjs) 和[架构说明](docs/ARCHITECTURE.md)。

## 配置参考

完整字段和默认值见 [server/config.mjs](server/config.mjs)，最小模板见 [.env.example](.env.example)。

| 配置 | 用途 |
| --- | --- |
| `PORT` / `PUBLIC_BASE_URL` | 监听端口与邀请链接前缀；本地示例为 `44982` 和 `http://localhost:44982` |
| `DATA_DIR` | 数据库、模型密钥加密主密钥、缓存、上传暂存和录音所在目录 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 无启用的超级管理员时，用于创建或恢复初始 `admin` |
| `AI_KEYS_FILE` | 服务商密钥文件；不会随源码提供 |
| `MODEL_SEED_PROBE` | `0` 关闭首次预置模型的真实调用探测；未关闭时探测可能产生费用 |
| `CHUB_API_KEY` | 可选 Chub API 密钥 |
| `MIRROR_DB_FILE` / `MIRROR_IMAGE_DIR` | 自行准备的角色镜像索引与图片目录 |
| `MIRROR_NAS_READER` | 镜像读取方式：`smb`、`api` 或实验性 `fast`，需对应基础设施 |
| `SWIFT_WARMUP` | `0` 关闭启动时 Swift 工具预编译；不禁止实际使用时按需编译 |
| `SSL_DIR` | 可选 TLS 证书目录；当前文件命名约定见 [server/net.mjs](server/net.mjs) |
| `DASHSCOPE_ASR_BASE` / `DASHSCOPE_ASR_MODEL` | 语音识别接口与模型；密钥文件需提供 `DASHSCOPE_API_KEY` |
| `GROK_CLI_PATH` / `GROK_CLI_PROXY_URL` | 可选本机 CLI 可执行文件与网络出口 |
| `GROK_CLI_QUOTA_PROBE_MODULE` | 可选额度探测模块的位置；仓库不附带该外部模块 |
| `CRAWLER_CONTROL_URL` / `CRAWLER_CONTROL_TOKEN_FILE` | 可选爬虫控制服务及令牌文件；需要另行部署 |

`data/`、`config/`、`.env`、日志和测试临时目录已列入 [.gitignore](.gitignore)。数据库内的模型密钥使用 `DATA_DIR/secret.key` 加密；备份时应一并保管数据库和该主密钥，不要提交到仓库。应用接口仅允许会话本人访问聊天内容、文件正文和录音，超级管理员也不能通过管理接口读取其他用户的会话内容。部署者仍直接控制数据库、录音文件和运行环境；这些内容并非端到端加密，模型请求会把相应内容发送到所选服务商。

## 平台与外部服务边界

- 基础 Web 服务使用 Node.js；完整文件处理链面向 macOS。Office 类转换使用 `textutil`，PDF 提取使用 Swift / PDFKit，图片 OCR 使用 Swift / Vision，音频格式转换可能使用 `afconvert`，部分压缩文档使用 `unzip`。Linux / Windows 的完整功能未在此次发布中验证。
- PDF 当前主要处理文字版；扫描 PDF 不会自动逐页 OCR。图片 OCR 是单独的解析路径。
- 本机 CLI 翻译需自行安装、登录和配置对应 CLI；CLI 账号、订阅、额度探测模块及代理均不随仓库提供。Python 仅用于可选的实验镜像读取进程，普通聊天不需要它。
- Chub、模型 API、语音识别、镜像库、NAS API 和爬虫控制服务都是外部依赖。其可用性、调用权限、额度和收费由各自服务决定。启动成功不表示这些集成都可用。
- 费用页依据上游 usage 和配置单价记录或估算，不能替代服务商账单。仓库没有性能基准或跨平台完整兼容性承诺。

Chub 角色来源接口实现在 [server/chub.mjs](server/chub.mjs)，使用 `api.chub.ai` 获取搜索和角色详情，并缓存允许来源的头像。外部角色卡、文本和图片属于其各自作者或权利人；本仓库没有附带这些素材，也未替它们授予使用许可。

## 测试与已知问题

测试使用 Node.js 内置运行器，无需 `npm install`。本次 9 项权限与迁移专项、34 项提示词与前端等专项通过，可运行：

```sh
node --test --test-concurrency=1 test/conversation-privacy.test.mjs test/prompt.test.mjs test/chat-keyboard.test.mjs test/chat-viewport.test.mjs test/navigation-links.test.mjs test/crawler.test.mjs
```

隔离环境启动、管理员登录和 Chrome 页面回归通过。会话接口检查所有者，管理员身份没有直接读取其他用户对话、文件全文或录音的接口。

**全量测试尚未通过**：排除真实外部集成后的 360 项测试中，298 项通过、62 项失败；清理前基线为 355 项、289 通过、66 失败。完整失败名称及验证边界见 [测试记录](docs/TESTING.md)。

`integration.test.mjs` 会连接真实 Chub 和模型服务，需要自行提供凭据并可能产生费用。全量命令 `node --test --test-concurrency=1 test/*.test.mjs` 包含该文件，不属于纯离线验证。

## 文档与源码入口

- [架构说明](docs/ARCHITECTURE.md)：模块职责、请求链路、存储及权限边界。
- [后端入口](server.mjs) / [路由与业务编排](server/app.mjs) / [数据库迁移](server/db.mjs)。
- [前端入口](public/js/app.js) / [模型接口](server/llm.mjs) / [配置模板](.env.example)。

部分代码注释保留了内部历史文档的章节编号；对应内部文档不在本次公开仓库中，使用方式以本 README 和当前源码为准。
