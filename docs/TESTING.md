# 测试与验证记录

本次公开源码移除了会话审查页面、后台入口、相关聊天/文件/录音读取接口与消息旧正文收集。原项目运行数据不在仓库内。

## 已通过的针对性验证

- 会话权限及历史迁移专项：9 项通过。覆盖超级管理员、管理员、本人、其他用户与未登录访问；旧接口对不同 HTTP 方法均返回 404；正常本人聊天、文件、语音、编辑、重新回复和软删除仍可用。
- 原有提示词、键盘、视口、导航、爬虫控制专项：34 项通过。
- Chrome 无头浏览器验证：管理员登录、9 个现存管理标签、卡片与日志页正常；旧界面地址回退，旧 API 返回 404，页面无 JavaScript 异常。
- 源码脱敏扫描、图标元数据清理、语法与导入检查通过。

## 离线全量测试

使用 Node.js 22.17.0、临时 HOME、无真实服务商密钥，串行运行全部测试文件，排除会调用真实外部服务的 `integration.test.mjs`。

| 版本 | 测试数 | 通过 | 失败 |
| --- | ---: | ---: | ---: |
| 清理前基线 | 355 | 289 | 66 |
| 本次公开版 | 360 | 298 | 62 |

全量测试尚未通过。失败集中在已有的角色来源假数据、旧权限初始化、旧 schema 断言和本机工具测试等场景；专项通过不替代整体质量验收。基线对照仅用于识别本次改动范围，不能据此将剩余失败视为通过。

## 剩余失败分布

| 测试文件 | 失败数 |
| --- | ---: |
| `cards.test.mjs` | 6 |
| `hardening.test.mjs` | 1 |
| `invites.test.mjs` | 1 |
| `logs.test.mjs` | 6 |
| `mirror-images.test.mjs` | 2 |
| `mirror-thumbnails.test.mjs` | 1 |
| `models.test.mjs` | 5 |
| `permissions.test.mjs` | 4 |
| `proxy.test.mjs` | 6 |
| `reading-settings.test.mjs` | 1 |
| `roles.test.mjs` | 16 |
| `v10-translate-settings.test.mjs` | 13 |

<details>
<summary>展开 62 项失败用例名称</summary>

- `cards.test.mjs`：chub 卡 fork：复制 definition 与 embedded lorebook、下载头像存本地、标原作者；成人 chub 卡 403
- `cards.test.mjs`：自建卡开聊：开场白宏替换；提示词带角色设定与命中的世界书；剧情卡叙述者口吻；chub 卡 embedded lorebook 也生效
- `cards.test.mjs`：软删除：删消息 / 重新生成 / 删会话之后，用户侧任何接口都拿不到，404 与不存在一致；费用只算未删；数据库保留软删原因
- `cards.test.mjs`：编辑消息：本人只见改后内容、id 不变；删除后不可见；他人无法读取
- `cards.test.mjs`：软删除：删账号 → 不能登录（与不存在一致）、旧登录立即失效、用户名仍占用；他的公开卡从社区隐藏；账号管理仍显示删除状态
- `cards.test.mjs`：迁移 v5 → v6：带数据升级，旧数据一条不丢；chats 可存自建卡会话；外键仍生效；会话 id 不复用；幂等
- `hardening.test.mjs`：每日上限 1：多个会话并发发消息只放行 1 条
- `invites.test.mjs`：迁移 v6 → v9：旧账号 note 为空、不强制改密；新表与索引就位；幂等
- `logs.test.mjs`：shelf.create / update / add_item / reorder / remove_item / delete
- `logs.test.mjs`：llm.error：拒答 warn / 上游错误 error / 超时 warn；写模型、会话、用户、code、HTTP 状态，不写对话内容与上游正文
- `logs.test.mjs`：GET /api/admin/logs：结构、倒序、kind 精确与前缀、级别、账号、关键词
- `logs.test.mjs`：v1.0 chat.override_update / chat.rewind：只记改了哪些字段与条数，不记设定正文与聊天内容
- `logs.test.mjs`：隐私：日志表与日志接口响应里没有密码、密码哈希、key、会话内容、上游正文、cookie
- `logs.test.mjs`：迁移：v4 带数据的库升级到 v5，旧数据一条不丢，logs 表与索引就位，记 system.migrate；再开幂等
- `mirror-images.test.mjs`：头像接点NAS优先且本地损坏安全回源，成人角色不能借CDN绕过
- `mirror-images.test.mjs`：镜像不可用时成人搜索头像和删除p后的旧链接仍逐请求受保护
- `mirror-thumbnails.test.mjs`：缩图命中不重新读取原图且同键并发只生成一份
- `models.test.mjs`：普通用户不能用停用模型；默认模型设置与清除
- `models.test.mjs`：切换会话模型后，下一条回复用新模型，messages.model 写真实模型 ID
- `models.test.mjs`：SSE 错误带 code：refused（部分照存）/ upstream / timeout
- `models.test.mjs`：管理：列表只给 key_set / key_hint；新建校验 SSRF；改 key 留空不改；测试；排序；默认；删除在用的改停用
- `models.test.mjs`：没有任何启用的模型：生成回 SSE error（upstream），不崩
- `permissions.test.mjs`：nsfw 关的用户打不开 nsfw 角色、搜索里也看不到；打开后可以
- `permissions.test.mjs`：会话只能看自己的；SSE 流程、编辑、删除及其后消息
- `permissions.test.mjs`：每日限额：0 不限；设为 1 后第二条 429；用量有记录
- `permissions.test.mjs`：管理员：停用账号后会话立即失效；不能停用/删除自己；货架增删排序
- `proxy.test.mjs`：会话消费：xAI 实价（upstream，= ticks）；DeepSeek 式按人民币单价推算（estimate）；会话合计与列表
- `proxy.test.mjs`：思考 token 另计（xAI）：按输出价计费；没单价 → cost null 且会话 cost_partial
- `proxy.test.mjs`：停止生成：上游没给 usage → 按字数粗估（输入 = 提示词，输出 = 已生成），标 estimate，用量照记
- `proxy.test.mjs`：上游已回 usage 但正文为空：不存空消息，token 与花费照记进 usage_daily（不占每日条数）
- `proxy.test.mjs`：翻译开场白与后台测试的花费记 system_costs，不算进会话；super 用量页看得到，admin 看不到
- `proxy.test.mjs`：本人会话接口：列表与详情带花费
- `reading-settings.test.mjs`：v11 升级只添加阅读列，旧账号密码角色会话消息保留且再次打开幂等
- `roles.test.mjs`：/api/me 带 role，is_admin 兼容 = role!==tenant
- `roles.test.mjs`：矩阵：账号列表与可见范围
- `roles.test.mjs`：矩阵：建账号（admin 只能建租户，created_by=自己；super 可建 admin/tenant，建 super 只能走脚本）
- `roles.test.mjs`：矩阵：改账号——范围外一律 404，且与不存在的账号回应完全一致
- `roles.test.mjs`：admin 不能改 role（含 is_admin）；super 可以 admin↔tenant，降级后权限立即收回
- `roles.test.mjs`：矩阵：删账号——范围外 404；admin 能删自己建的租户
- `roles.test.mjs`：admin 停用 / 给自己租户发重置码：租户登录立即失效，用户自己设新密码
- `roles.test.mjs`：矩阵：用量——super 看全部；admin 只看自己建的租户（不含自己）
- `roles.test.mjs`：矩阵：模型 / 货架 / 设置只限 super，admin 与租户 403
- `roles.test.mjs`：超管看别人会话：普通 /api/chats/:id 始终 404
- `roles.test.mjs`：最后一个 super 保护：不能停用 / 删除 / 降级自己；不能动别的 super
- `roles.test.mjs`：super 删除管理员（软删）：登录立即失效，他建的租户转给执行删除的超管
- `roles.test.mjs`：scripts/create-admin.mjs --role super|admin（默认 super），不能降级最后一个 super
- `roles.test.mjs`：慢速请求体：admin 挂起的改密请求，目标在此期间被超管升为 admin → 404，密码不变
- `roles.test.mjs`：慢速请求体：admin 挂起的建租户请求，期间被停用 / 降为租户 → 不再按旧权限执行
- `roles.test.mjs`：慢速请求体：super 挂起的设置写请求，期间会话失效 → 401，不执行
- `v10-translate-settings.test.mjs`：详情：秒开先回原文 + pending；后台整卡翻译完成后返回全部字段的原文与译文；花费记 system_costs(translate, 触发者)
- `v10-translate-settings.test.mjs`：并发：同一角色同时打开 6 次、再新建会话，整卡翻译只跑一次
- `v10-translate-settings.test.mjs`：源卡内容变化（chub 刷新后 card_json 变了）→ 重翻；没变不重翻
- `v10-translate-settings.test.mjs`：翻译失败：显示原文、不自动重试；「重试翻译」接口重来并成功
- `v10-translate-settings.test.mjs`：nsfw 关的用户打不开成人角色详情，也不会触发翻译
- `v10-translate-settings.test.mjs`：列表中文：首页热门 / 搜索先回已有译文，缺的标 translating 并后台批量翻（每批 ≤24 项），标签走共享译名表；稍后刷新就有中文
- `v10-translate-settings.test.mjs`：列表：一批里有一条翻不出来（被拒），重试时拆小批不连累别的；翻不出来的一段时间内不再反复排队
- `v10-translate-settings.test.mjs`：中文名搜索：本地缓存过的卡按 name_zh / tagline_zh 命中，排在 chub 结果前面；nsfw 关的用户搜不到成人卡
- `v10-translate-settings.test.mjs`：聊天用中文设定：提示词里是中文角色名与 card_json_zh 的设定；世界书中文触发词也能命中
- `v10-translate-settings.test.mjs`：翻译模型设置 translate_model_id：super 可改（只能选启用的），admin 403；之后翻译用它
- `v10-translate-settings.test.mjs`：本会话设定：GET 返回原设定（中文优先）/ 覆盖 / 人设；PATCH 只存差异、下一条起生效；DELETE 恢复；别人的会话 404
- `v10-translate-settings.test.mjs`：rewind：改用户消息 → 之后的消息软删（edit_rewind）、按修改后的内容重新生成
- `v10-translate-settings.test.mjs`：rewind 权限：只能用于自己会话里的用户消息；AI 消息 400、别人的 / 已删的 404、空内容 400、生成中 409

</details>

本次未运行需要真实模型密钥的集成测试，也未进行完整的 Linux / Windows 工具链验收。
