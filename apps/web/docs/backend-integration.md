# 前后端对接清单（MVP 与新增界面原型）

本文件列出当前界面需要的数据和状态。标记「文档已指定」的路径来自需求文档；标记「待确认」的是前端提出的接口需求，正式开发前由前后端共同确定路径和字段。

## 2026-09-24 首轮整合状态

整合副本已经按后端现有契约实现以下调用：

- `POST /api/v1/auth/login/password`、`GET /api/v1/auth/session`、`POST /api/v1/auth/logout`；令牌仅保存在当前标签页的 `sessionStorage`。
- `POST /api/v1/auth/password/change`，请求字段为 `current_password`、`new_password`，返回 `{ userId, revokedSessions }`。这条路由用当前密码证明调用者，成功后撤销其他会话、保留发起修改的这一次；密码长度（10–200）与「不能与当前密码相同」由服务端判定，前端只做同样规则的预检查。连续输错触发的临时锁定返回独立的 `account_locked`（HTTP 401，`message` 为 `Account Locked`），与凭据错误的 `unauthorized` 区分开。
- `PUT /api/v1/assignment/presence` 与 `POST /api/v1/assignment/presence/heartbeat`。
- `GET /api/v1/conversations`、`GET /api/v1/conversations/:conversationId`。
- `POST /api/v1/conversations/:conversationId/messages`，请求字段为 `content`、`source`、`dedupKey`。
- `POST /api/v1/conversations/:conversationId/close`，并传 `expectedVersion`。
- `GET /api/v1/conversations/:conversationId/transfer-targets` 与 `POST /api/v1/conversations/:conversationId/transfer`；转交名单由服务端给出，前端只渲染。
- `GET /api/v1/directory/tenants`，用于平台管理员选择单公司业务范围和默认门店。
- `GET/POST/PATCH /api/v1/knowledge/products`、`/knowledge/faqs`、`/knowledge/shortcuts`；所有成员可读，只有管理员可写。
- `POST /api/v1/knowledge/import-batches/preview` 与 `/apply`；使用 `multipart/form-data` 上传 CSV / XLSX，先预览再应用。可选字段 `mapping` 是「我们的字段 ← 文件里的哪一列」的 JSON 字符串，只在文件表头不是本系统字段名时才传（ERP 导出原表就是这种）。
- `GET /api/v1/knowledge/index-status`（切片各状态计数、已写向量数、最近失败切片）与 `GET /api/v1/knowledge/import-batches`（导入批次账，含行数结果）；商品库页用它们把「导进来了」（目录表）与「检索找得到」（索引表）分开显示。

本地 Web 服务把 `/api/*` 同源代理到 API，避免开发环境的 `localhost` / `127.0.0.1` 跨域差异。实时事件与转接已接入；**两条线的附件都已接入**——内部会话是「先上传换草稿 ID、发送时认领」（`CHG-20261005-22`），客户会话是「上传与发送在同一次请求里」（`CHG-20261006-09`，见下节「客户会话媒体消息契约」）；下表其余模块仍待后续接入。

本项目按单公司自用部署处理角色：后端 `platform_admin` 与 `merchant_admin` 均映射为前端“管理员”。两者在界面中拥有原管理员中心的完整入口；权限仍须在后端接口接入后由服务端最终校验。

## 共用约定

- 业务 API 前缀：`/api/v1`；请求带登录凭证。租户和店铺访问范围以服务端 Token 和成员配置为准，前端选择的店铺只作查询上下文。
- 列表支持时间范围与分页；消息、事件、日志优先 cursor 分页。
- 可重试写请求带 `Idempotency-Key`。转接、结束会话、管理员权限及分流配置写入还需版本字段，由服务端处理并发冲突。
- 错误体至少包含稳定错误码、可读消息、`request_id`，字段错误可另列详情。
- WebSocket/SSE 事件包含 `event_id`、`event_type`、`tenant_id`、`store_id`、`occurred_at`。断线后通过 REST 补拉。
- `POST /api/v1/messages/send` 成功只表示本地消息与发送任务创建成功；最终渠道状态须通过消息查询或实时事件更新。

## 按界面对接

| 界面 | 数据 / 操作 | 接口状态 | 关键字段与 UI 状态 |
|---|---|---|---|
| 工作台顶部 | 客服接待状态、AI 辅助开关、退出账号 | 路径待确认 | 在线 / 挂起 / 离线；只有在线参与自动派单。挂起保留当前会话但不接新单，离线停止客服消息发送。退出是独立的登出操作，不应作为接待状态提交。关闭 AI 辅助只暂停候选生成，消息接入与人工回复继续可用。状态操作需返回服务端实际保存结果。 |
| 工作台顶部 | 今日接待与展开指标 | 路径待确认 | 按当前租户、授权店铺、客服和日期返回指标值、统计时间与可用状态。未接入的订单、满意度、转化指标返回不可用状态，前端显示「—」，不得生成假数值。首响、采纳率和手打率使用需求文档中的口径。 |
| 左侧联系人 | 查询团队成员、可见买家、分组与黑名单 | 路径待确认 | 按当前租户和授权店铺返回联系人 ID、脱敏显示名、类型、分组 ID、在线状态与可访问会话 ID；支持搜索和分页。团队成员与买家联系人不得混用身份标识。 |
| 左侧联系人 | 新建分组、调整联系人分组 | 路径待确认 | 变更由服务端校验角色和租户范围，返回分组 ID、版本与更新结果；当前原型只修改浏览器内存。分组维护是管理动作：普通客服只读，服务端必须按角色拒绝越权请求，前端隐藏「＋ 新建分组」与行内「⋯」只改善体验。黑名单操作在权限与规则明确前不开放。 |
| 左侧联系人 | 从团队成员进入一对一内部会话 | 已接通：`GET /api/v1/internal-chat/peers`（同事目录）、`POST /api/v1/internal-chat/threads`（开会话 / 复用，返回 `thread` / `peer` / `lastMessage`）、`GET /api/v1/internal-chat/threads`（含最后一条消息摘要） | 同事目录排除自己，按显示名排序；分组用成员所在门店，`storeId` 为 null 时归入「未分配门店」。无历史时返回空数组而不是 404，前端显示空态。买家联系人与黑名单仍无接口。 |
| 内部协作 | 同事一对一：会话与消息历史、发送消息、**图片 / 视频 / 文件附件**（均已接通，见下节契约）；群聊：按名称或成员搜索、新建群、群成员与历史消息、发送消息（仍为本地演示，且没有附件） | 一对一：`/api/v1/internal-chat/*` 与 `POST /api/v1/internal-chat/threads/:threadId/attachments`、`GET /api/v1/internal-media/:messageId`；群聊：路径待确认 | 一对一已接通，成员资格与租户边界由服务端判定，实时事件只推送「有新消息」不含正文。附件上传与读取已接通（`CHG-20261005-22`）：先上传换草稿 ID，发送时认领，读取走十分钟寿命的签名地址。群聊仍缺群权限、成员变更与历史契约，不能复用一对一或客户会话接口，也不能复用微信客服外发接口或额度。 |
| 会话列表 | 查询当前客服的处理中 / 已结束会话 | 路径待确认 | `conversation_id`、`store_id`、买家脱敏显示名、最近消息、未读数、`state`、`state_version`、接待客服、`ended_at`；“我的会话”下按 active / ended 分类，返回独立计数和分页。结束成功后从处理中移入已结束并保留历史消息；已结束仅可读，服务端同时禁止发送 / 转接。买家联系人可进入对应分类的会话：前端按联系人上记录的会话 ID 查找，查不到时按客户显示名兜底，都没有则提示“当前没有可打开的会话”。正式版本应由联系人接口直接返回可打开的会话 ID（或返回空），前端不再依赖姓名匹配。 |
| 会话分配 | 系统自动分配并通知目标客服 | 路径待确认 | 服务端按在线状态、店铺范围等规则选择客服，并推送分配事件；实时事件走 `GET /api/v1/realtime`（SSE）；前端收到事件后刷新“我的会话”，不提供抢单或退池入口。若暂时无人在线，由服务端等待并在可分配时重试。 |
| 外发提醒 | 会话详情里的 48 小时回复窗口与剩余外发额度 | 已接 `GET /api/v1/conversations/:conversationId` 的 `replyWindow` | 字段为 `open`、`windowStartedAt`、`windowEndsAt`、`messageLimit`、`remaining`、`refusal`。窗口由客户最近一条入向消息开启（48 小时、最多 5 条），因此按**客户**而不是会话存在：同一位客户换一条会话，读到的仍是同一个窗口。`refusal` 区分三种「不能发」——`window_missing`（客户还没发过消息）、`window_expired`（窗口已关闭）、`quota_exceeded`（本窗口额度用尽），界面据此给出不同说明，并且与 Worker 拒收外发时用的是同一个判据，所以提醒不会承诺一条平台会拒绝的消息。窗口已关闭或额度用尽时前端拦下提交只改善体验，最终判定仍在服务端，被拒时会记录可见的降级原因。 |
| 会话操作 | 转指定客服、结束 | 已接 `GET /api/v1/conversations/:conversationId/transfer-targets`、`POST /api/v1/conversations/:conversationId/transfer`、`POST /api/v1/conversations/:conversationId/close` | 转交与结束都传 `expectedVersion`；转交另传 `toMemberId`。可转交名单由服务端返回（`memberId`、`displayName`、`storeId`、`availability`、`inProgressCount`），判定与转交路由同源：同租户、在线且可接单、排除自己，因此前端不复刻规则，也不会给出「能选但必被拒」的选项。入口是否出现读会话详情的 `canTakeOver` 与接待人字段（本人接待、或接手人已下线可由管理员 / 同店铺坐席接手），仅收口体验，不承担鉴权。名单为空与「会话不存在」「版本冲突」是三种不同结果：空名单返回空数组并提示“当前没有在线且可接单的同事”，未知会话返回 404，并发冲突返回 409 并需刷新会话。 |
| 对话区 | 拉取消息、查询外发状态 | 路径待确认 | `message_id`、方向、类型、正文/媒体引用、文件名、大小、时间、`message_source`、发送状态。图片、视频和文件按类型展示；媒体不可用时显示占位或失败原因。 |
| 回复栏 | 发送最终文本 / 图片 / 视频 / 文件 / 商品 link | `POST /api/v1/messages/send` 文档已指定 | 客服选中候选后回填并可编辑。传候选 ID、最终文本、会话 ID、媒体 ID、幂等键；服务端判定 `direct_candidate` / `edited_send` / `manual_typed` 等来源。视频 / 文件的渠道支持、大小及类型需后端确认。 |
| 智能辅助 | 获取最多 3 条候选及来源 | `POST /api/v1/retrieval/suggestions`（建）+ `GET /api/v1/retrieval/suggestions/{id}`（读） | 请求体 `{conversationId, query?}`：`query` 是坐席重新提问时给的文字，缺省则取该会话最后一条客户文本。返回一整个 suggestion set：`id`、`intent`（`question`\|`chitchat`）、`origin`（`script`\|`catalogue`\|`generated`\|`none`）、`provider`（`none`\|`deepseek`）、`candidates[]`（`rank`、`kind`（`faq`\|`shortcut`\|`product`）、`sourceId`、`title`、`content`、`score`、`recall{rank,modes}`）与 `fallbackReasons[]`。**意图和来源都由服务端定，前端只渲染**：`chitchat` 一定 `candidates: []` + `chitchat_no_retrieval`；话术库命中即直出店铺原句、不调用模型（`provider: none`，`origin: script`）。 |
| 商品库 | 款式 / 类目统计、索引状态与失败切片、导入批次、商品列表、导入入口 | 已接 `GET /knowledge/spus`、`GET /knowledge/categories`、`GET /knowledge/index-status`、`GET /knowledge/import-batches` 与导入 `preview` / `apply` | 统计与列表读目录表，索引状态读索引表，两者刻意分开展示。`/knowledge/spus` 与 `/knowledge/import-batches` 目前无分页参数，列表在前端分页；索引状态含 `counts` / `embeddings` / `recentFailures`（错误原因原样呈现）。导入对话框发送的 `mapping` 只覆盖 `product_code` / `sku_code` / `title` / `main_image_url` / `source_updated_at` 五个字段——颜色、规格、售价、分类需要合成 SKU 规格或取分类叶子节点，映射表达不出来。价格与库存仅作快照展示。 |
| 统一知识库 | 商品、FAQ、公司快捷话术的列表、创建、编辑和启停 | 已接 `/api/v1/knowledge/products`、`/faqs`、`/shortcuts` 的 GET / POST / PATCH | 平台管理员请求带 `x-tenant-id`；商品和 FAQ 新增带默认 `storeId`，公司话术新增传 `storeId: null`。客服可读但写入由后端返回 403；管理员写入仍由服务端 `requireConfigurator` 校验。 |
| FAQ 近似问法 | 查询、新增、修改文字、启停 | 已接 GET / POST `/api/v1/knowledge/faqs/:faqId/variants`；PATCH `/api/v1/knowledge/faq-variants/:variantId` | 近似问法继承父 FAQ 公司 / 门店，带 Bearer 及 `x-tenant-id`；创建传 questionText / source: manual，修改传 questionText / status。客服只读，写权限由服务端确认。 |
| 统一知识库 | SPU / SKU 详细维护 | 已接 `GET /knowledge/spus`、`GET /knowledge/spus/:id`、`POST /knowledge/spus`、`PATCH /knowledge/spus/:id`、`POST /knowledge/spus/:id/skus`、`PATCH /knowledge/skus/:id`；分类 `GET /knowledge/categories` | 请求带 Bearer 和 `x-tenant-id`；列表按服务端授权返回。详情为 `{spu, skus}`。SPU 创建必填 `storeId/productCode/title`；修改仅提交可变字段。SKU 从所属 SPU 继承门店，前端不指定归属。 |
| 统一知识库 | 商品 CSV / XLSX 导入预览与应用 | 已接 `POST /api/v1/knowledge/import-batches/preview`、`/apply` | `multipart/form-data` 字段为 `file`、`storeId`，可选 `mapping`（字段→列名的 JSON，如 `{"product_code":"款式编码","sku_code":"商品编码","title":"商品名称"}`）；先展示总行数、可导入行和错误，再由管理员确认应用。映射写了一个文件里不存在的列会导致整批拒绝（`mapping_column_not_found`），所以可选列（图片 / 修改时间）在界面上做成勾选框。入口只在「SPU / SKU」页签，客服不显示；导入成功后切到该页签并刷新目录与商品库两处。 |
| 统一知识库 | 页面内回答测试 | 前端快速匹配，正式召回待接 | 当前从已读取的启用商品、FAQ 和公司快捷话术中展示前三条匹配；正式版本应调用检索接口并返回相关性、来源切片和未命中原因。 |
| 快捷短语 | 个人 / 团队列表、搜索、创建、编辑、启停与回复栏联想 | **个人短语已接通**：`GET` / `POST /api/v1/personal-phrases`、`GET` / `PATCH /api/v1/personal-phrases/:phraseId`（见文末「个人快捷短语契约」，`CHG-20261008-11`）。**团队短语路径待确认** | 个人短语按登录员工隔离，本人可读写（**已做**，归属由会话决定，隔离在 SQL 层；无搜索 / 分页 / 版本 / 删除）。团队短语按租户共享，普通客服可读，企业管理员可写——**尚未接通**，公司级共享话术目前走 `/knowledge/shortcuts`。启停后更新右侧列表和输入联想（已做）；写操作的服务端权限校验与审计对**团队**那一半仍待补。店铺 / 客服组级范围待评审。 |
| 数据概览 | 会话量、首次响应、采纳率、手打率 | 路径待确认 | 支持日/周与店铺范围。计算口径以需求文档 §4.8 为准，不在浏览器端重新定义。 |
| 管理员中心 | 员工本日/周/月服务指标与员工对比 | 路径待确认 | 按租户、授权店铺、员工和统计周期返回接单量、付款人数、付款金额、平均响应时长、满意度、3 分钟回复率、数据更新时间及可用状态。付款类指标需订单回传和归因定义；不可用时返回明确状态，不得以演示值代替。 |
| 管理员中心 | 查询与修改员工管理权限 | 路径待确认 | 支持完整管理员权限和模块级授权。服务端校验操作者权限与租户范围，防止移除最后一名完整管理员；写入需版本、幂等键和审计记录。未授权读取或写入统一返回 403，前端显示“暂无权限”。 |
| 管理员中心 | 首页访问与模块权限 | 路径待确认 | 企业员工可访问功能卡片首页；汇总数字与模块数据按权限返回。首页汇总员工数 / 接单量 / 付款金额对应员工对比权限，可参与接待人数对应分流权限。角色 / 权限变化应清空旧数据并重新获取权限。 |
| 管理员中心 | 申请授权与申请状态 | 路径待确认 | 无权限弹窗可申请当前模块，提交申请人、租户、模块、幂等键；服务端从登录身份确定申请人，去重未结申请并返回 pending / approved / rejected。只有有审批权限的管理员可审批，记录审计并通知申请人；申请本身不授予权限。当前仅在内存模拟待审批，无真实通知和审批服务。 |
| 管理员中心 | 员工分流（新会话权重） | `GET` / `PUT /api/v1/assignment/routing` | **已接通**，契约见下方「2026-10-07：会话分流权重契约」一节。2026-10-08 这块面板从设置页整块搬到管理员中心，**路径、字段和权限一条没改**。最终分配算法、优先级和容量规则仍由后端确定；前端不自行决定目标客服。 |
| 管理员中心 | 员工聊天记录与操作日志 | 路径待确认 | 按授权店铺、员工、客户和时间查询，消息使用 cursor 分页；客户信息脱敏。查看原文、导出及权限变更都需要单独授权与审计，结果按数据保留策略返回。 |
| 设置 | 企业微信渠道连接与客服账号（客服、商家管理员、平台管理员；渠道接入对客服隐藏） | 已接通：`GET /api/v1/channels`、`PUT /api/v1/channels/wecom/credentials`、`POST /api/v1/channels/wecom/callback-selfcheck`；`GET /api/v1/admin/tenants/:tenantId/members`、`GET /api/v1/admin/accounts`、`POST /api/v1/admin/members`、`POST /api/v1/admin/accounts`、`POST /api/v1/admin/members/:memberId/link`、`POST /api/v1/admin/members/:memberId/enabled`、`POST /api/v1/admin/accounts/:userId/disable\|enable`（契约见文末） | 状态按服务端结论显示，只有真实传输且换到过 token 才算已连接；渠道连接的可见与可写按**后端下发角色**判定（不只是演示角色），凭据写入限平台超级管理员，Mock 构建拒绝连接尝试并提示改 `WECOM_TRANSPORT`，密钥不回显。客服账号新建是「成员 + 账号 + 绑定」三步，停用同时停成员与登录账号。 |
| 话术审核 | 待审列表、通过、编辑后通过、拒绝 | 路径待确认 | 平台运营人工审核；默认只显示候选话术和脱敏来源片段，保留审核动作历史。 |
| 审核策略 | 读取 / 修改策略 | `GET/PATCH /api/v1/platform/phrase-review-policy` 文档已指定 | 平台运营可读；只有平台超级管理员可改。PATCH 需策略版本与幂等键，版本冲突返回 409。 |
| 租户管理 | 开通租户、店铺、成员角色及店铺范围 | 路径待确认 | 普通注册用户未配置前只能进入账号中心；服务端按角色和店铺授权数据。 |
| 登录与账号 | 当前员工资料、头像上传、资料更新、密码修改、退出登录、注册、密码/验证码登录、找回密码、SSO 绑定、受信设备管理 | 密码修改已确认为 `POST /auth/password/change`（见上）；资料、头像与设备的路径待确认 | 资料响应返回姓名、脱敏手机号、角色和头像地址；手机号修改需二次验证。头像服务校验 PNG/JPEG/WebP、大小和内容并返回持久地址。密码修改校验当前密码和服务端强度策略，成功后按策略撤销旧会话；退出登录使当前会话失效；SSO 绑定先验证本地账号。 |

## 需要前端显示的异常状态

1. 模型超时、限流或不可用：展示 FAQ、快捷短语或纯检索候选，并写明降级原因；回复栏仍可人工使用。
2. 商品索引未完成：展示处理中与快照时间，允许使用结构化资料或快捷短语。
3. 无相关商品或 FAQ：不生成看似确定的答案，提示客服人工处理。
4. 外发额度接近上限、窗口到期或渠道失败：提示客服并显示每条消息最终发送状态。
5. 自动分配或转接后会话归属变化：通过实时事件刷新当前客服的会话列表；结束操作遇到版本冲突时刷新状态。
6. 图片、视频或文件拉取 / 上传失败：保留消息占位与人工回复能力。

智能辅助的降级原因由服务端写进 `fallbackReasons`，前端只把稳定码翻译成坐席能读懂的一句话，不在浏览器里推断：`chitchat_no_retrieval`（闲聊未检索）、`no_generation_provider`（未配置生成模型）、`generation_unavailable`（模型调用失败）、`semantic_recall_unavailable`（向量检索未运行）、`no_knowledge_match`（话术库与商品库都没命中）、`empty_query`（客户消息没有可检索文字，如语音/图片）、`content_blocked`（候选命中违禁词被拦截）。新增原因码时前端要同步补文案，否则面板只能把原始码摆给坐席看。

## 当前原型与正式版本的区别

回复框输入联想在本地匹配短语的标题、正文和关键词；结果显示所属范围及命中词，个人命中优先。**个人短语自 `CHG-20261008-11` 起已经是服务端事实**：登录后按成员读取、只含本人的那几份，管理页与右侧面板的新增 / 编辑 / 启停走 `POST` / `PATCH`（契约见文末「个人快捷短语契约」）。**仍是原型的是团队那一半**——渲染、新增 / 编辑 / 启停都基于 `quickPhrases`，登录后同样只落在本次页面。正式接口应按登录员工返回本人个人短语及有权使用的团队短语（个人的已做）；异步搜索应取消或忽略过期响应，停用项不得返回给发送入口（前端的联想匹配已经跳过停用项，个人那份的启停也由服务端记着）。选用短语仅回填草稿，人工确认后发送；**使用次数仍是前端本地累计**，刷新归零，服务端不记录。

回复工具栏支持表情插入、系统截图粘贴与附件：图片不超过 10 MB、视频不超过 10 MB（只收 MP4）、文件不超过 20 MB，一次选择一个，按会话暂存，确认后点击发送。**客户会话的附件已经是真的**（`CHG-20261006-09`）：点发送是一次 `POST /api/v1/conversations/:conversationId/messages/media` 的 multipart 请求，服务端在同一次请求里校验 → 写下我们自己那份字节 → 上传企业微信换 `media_id` → 写消息行 → 进发送队列（契约见下节「客户会话媒体消息契约」）。客户发进来的图片也按服务端签发的地址内嵌显示。前端那份类型与大小预检只是为了在坐席还没离开选择器时就说清哪个文件不行，**真正说了算的是服务端**（它按内容类型判定并再次校验，类型不在白名单或超限时把原因放在 `details` 里返回）。**附件消息不带文字**：渠道的媒体消息没有说明文字字段，服务端拒收，前端也在提交前拦住「附件 + 文字」的组合，让坐席自己挑一条发，不静默丢掉打过字的正文。视频时长、病毒扫描和渠道能力仍须由后端确认。邀请下单目前回填示例商品链接；实际商品、规格、有效下单链接及渠道能力须由服务端提供，确认后才发送。

`src/mock-data.js` 仍为联系人、群聊和独立快捷短语页面提供固定示例。登录后的 AI 候选、会话转接、分配历史和实时更新，以及统一知识库和商品批量导入，均已使用真实 API。**两条线的附件都已使用真实 API**：内部会话是上传、认领与签名读取（`CHG-20261005-22`），客户会话是一次请求内完成的上传与外发（`CHG-20261006-09`）。管理员中心配置和审核仍是演示。服务端继续负责身份、权限、租户范围、幂等、审核和最终状态；前端隐藏控件不承担鉴权。

## 数据导出对接
- `GET /api/v1/directory/tenants`：授权公司目录；平台管理员也必须明确选择公司。
- `GET /api/v1/conversations`：获取当前公司的可选会话。
- `POST /api/v1/exports`：提交 `{scope: "customers", q, from, to}` 或 `{scope: "conversation", conversationId}`；日期按 UTC 筛选，空日期不提交；表单默认填「上月本日 → 本日」（按 UTC 算，与提交的 `T00:00:00.000Z` / `T23:59:59.999Z` 同一口径），清空即不提交该日期。契约本身未变。
- `GET /api/v1/exports`：查询最近任务，显示 `status`、`rowCount`、`error`、`artifacts` 及时间戳。
- `GET /api/v1/exports/:jobId/download/:format`：format 为 xlsx 或 transcript，返回二进制文件，以 Content-Disposition 中的文件名下载。
- 所有导出、会话和下载请求携带 Bearer 令牌及 x-tenant-id；不使用浏览器角色判断替代服务端鉴权。未完成任务轮询更新，离开页面后取消后续轮询。

## 工作台已接入的接口
- `POST /api/v1/retrieval/suggestions`：`{conversationId, limit:3}`，自动按最新客户消息检索；`GET /retrieval/suggestions/:id` 查询持久化集合。返回 `provider`、`candidates`（kind/sourceId/title/content/score/tenantId/storeId）和 `fallbackReasons`。未配置模型时展示知识库候选，不展示模拟生成内容。配置了模型时，生成请求会带上**问题之前的最近 10 条对话**作为上下文（对话历史与问题、知识条目一样先脱敏，且只用于理解指代——候选仍须挂在给定的知识条目上）；话术库 / FAQ 命中时直接返回店铺自己的话术，不调用模型，也不产生这次费用。
- `POST /api/v1/conversations/:id/messages`：content/source/dedupKey/candidateId；candidateId 保存候选集合 ID。直接选用为 direct_candidate，编辑后为 edited_send；仅人工确认发送。
- 新增 `GET /api/v1/conversations/:id/transfer-targets`：先校验会话可读权限，复用转接资格规则，返回在线接单且心跳有效的其他客服（memberId/displayName/storeId/inProgressCount）。范围同公司，允许跨门店；最终写操作再次校验资格。
- `POST /api/v1/conversations/:id/transfer`：`{expectedVersion,toMemberId}`。409 提示状态变化并补读。`GET /conversations/:id/assignments` 展示 action/result/reasonCode/fromMemberId/toMemberId/stateVersionBefore/stateVersionAfter/createdAt。
- `GET /api/v1/realtime`：fetch 流式读取，以请求头携带令牌，不把令牌放入 URL。realtime.connected / conversation.opened / conversation.updated / message.created / message.delivery_updated 触发 REST 补读；presence.changed 同步本账号状态，ping 续活。
- 消息结果来自会话详情的 deliveries，独立 Worker 写入的 pending 状态每 5 秒补读。成功写入发送队列不等于渠道最终发送成功。
- 本地开发服务自动读取根 `.env` 的 API_PORT，API_PROXY_TARGET 可覆盖；本机使用 API 3002、Worker 3001、Web 5173，避免误连占用 3000 的微信小店助手。

## 2026-10-03：结构化 SPU / SKU 维护契约

- `src/catalog.js` 管理独立商品目录；旧 `products` 条目保留，不自动迁移、不互相覆盖。导入应用写入结构化目录，可在 SPU / SKU 页签刷新查看。
- SPU 可变字段：`categoryId`（清空传 null）、`title`、`subtitle`、`mainImageUrl`、`productUrl`（后三者清空传 null）、`sellingPoints`（数组）、`commonAttributes`（string / number / boolean 标量记录）、`shelfStatus`（on_shelf / off_shelf / unknown）。创建时可设置 `externalProductId`，`sourceType` 固定 manual；编码、门店、外部 ID 和来源创建后不通过 PATCH 修改。
- SKU 新增字段：`skuCode`、`externalSkuId`、`variant`、`searchAttributes`、`status`；修改仅 `skuCode/variant/searchAttributes/status`，外部 ID 锁定。规格和检索属性都是字符串键值记录，移除行后提交完整记录；状态 active / inactive。没有价格和库存写入字段。
- UI 新增 / 保存按钮仅对登录的 merchant_admin / platform_admin 开放；客服详情所有编辑字段禁用。写操作仍由服务端 requireConfigurator 和租户 / 门店范围校验，UI 不承担鉴权。后端当前无该资源的 state_version / Idempotency-Key 契约，前端不虚构；请求期间禁用保存防止连续点击，不能代替后端并发保护。
- 数值、布尔、重复属性和必填内容先在界面校验；服务端错误显示并保留输入。切换账号清空旧目录和详情，迟到的读取结果不能覆盖新建表单。
- 本轮验证：6 项目录交互 / API 适配测试及原 3 项工作台测试通过，10 个脚本语法检查通过；真实客服只读、管理员维护入口及必填校验通过。实际公司结构化列表为空，创建 / 修改写入在自动测试替身验证；尚未用真实商品完成数据库写入与刷新持久化验证。

## 2026-10-03：退出与鉴权失效清理

- 鉴权 REST 请求返回 401 时，API 适配清除令牌并发送本页 `kefu:session-expired` 事件；密码登录失败的 401 不触发已登录会话失效事件。SSE unauthorized 同样清除前端身份并返回登录。
- 401 里有一个例外：`account_locked`（连续输错触发的临时锁定）不是凭据错误也不是会话失效，登录页与修改密码弹窗各给一句说明——锁定期间即使密码正确也会被拒，重试不是正确的动作。前端不得把它当会话过期清令牌（当前登录失败发生在未登录状态，本来就无令牌）。阈值与时长由服务端策略决定（`DEFAULT_AUTH_POLICY.password`：连续 3 次失败锁定 15 分钟，登录成功清零），**前端不写死次数，也不要按次数提前拦人**——同一套规则还要被修改密码等入口复用，前端另写一份必然对不上。
- 退出立即清除 UI 会话及旧知识数据，角色显示未登录；后台撤销请求结束前禁用新登录，避免旧请求清除新令牌。公司范围和 SPU / SKU 数据不跨账号复用，迟到结果不更新已退出页面。
- 管理员可写需要真实已连接会话及后端角色；UI 角色下拉不提供模拟提权。真实管理员登录 / 退出 / 再登录验证通过，12 项前端回归测试及 10 个脚本语法检查通过；实际商品写入持久化验证限制不变。

## 2026-10-04：FAQ 近似问法维护契约

- `src/faq-variants.js` 在常见问题右侧详情下方渲染编辑器；FAQ 未保存前不创建问法，防止临时前端 ID 写入。查看或保存标准 FAQ 后按其真实 ID 读取列表，可手动刷新。
- GET 返回 `id/tenantId/faqId/questionText/source/status/updatedAt/createdAt`；来源 manual / generated / imported 分别显示人工录入 / 自动生成 / 导入。启用及总数量只统计本次成功读取的当前 FAQ，不推断其他 FAQ 的数量。
- POST 发送 `{questionText, source: 'manual'}`，新增状态由服务端默认 enabled；PATCH 发送 `{questionText, status}`，status 为 enabled / disabled。近似问法共用标准答案，不能单独修改答案、归属、来源和父 FAQ；停用可逆，没有删除接口或按钮。编辑器文字限制 1–300 字，失败保留草稿及错误信息。
- 全部请求使用当前登录 Bearer 和明确的 `x-tenant-id`。服务端 `requireFaq` 校验父 FAQ 租户及门店，写操作 `requireConfigurator` 限制 merchant_admin / platform_admin。接口未提供 state_version / Idempotency-Key，本前端不虚构此契约；提交期间禁用按钮只能阻止本页重复点击，不能提供并发写保护。
- FAQ、页签或账号变化会丢弃旧编辑器与迟到结果；退出 / REST 401 同样清除。18 项前端回归（含 6 项新增问法测试）与 11 个脚本语法检查通过；真实管理员入口、客服只读与退出清理通过。实际公司 FAQ 列表为空，未创建测试业务数据，数据库写入持久化及真实召回命中仍待验证。本地“回答测试”仍按既有字符匹配，不因本轮问法维护接通而变成后端语义检索。

## 2026-10-05：同事一对一内部会话契约

- `GET /api/v1/internal-chat/peers`：可对话的同事，返回 `memberId / displayName / role / storeId / avatarUrl`（`avatarUrl` 为 CHG-20261006-04 新增，见下文「头像契约」），排除自己与已停用成员，按显示名（zh-Hans-CN）排序。名单有**两个来源**：本租户的启用成员，以及**平台管理员**（`tenantId` 为空的 `platform_admin` 成员，他不在任何公司的成员表里，所以只有单独取才拿得到）。前端按 `storeId` 分组显示（映射不到门店名时用「未分配门店」），所以登录后团队栏里不再出现演示分组（售前 / 售后客服）；平台管理员按 `role` 单独归到「平台」分组、详情写「平台管理员 · 平台侧」，不归到「未分配门店」——「未分配门店」看起来像漏配的同事，而他是**本来就没有公司**的那一侧。名单里始终没有调用者自己。
- `POST /api/v1/internal-chat/threads`：body `{peerMemberId}`，返回 `{thread, peer, lastMessage}`。会话 ID 是 `internal-direct:<tenantId>:<较小的 memberId>:<较大的 memberId>`，由服务端推导，因此幂等：双方各自打开得到同一条。与自己会话返回 400；对方不存在 / 属别的租户 / 已停用一律 404（刻意不区分，避免这个接口变成猜成员是否存在的探针）。可开会的对象只有两类：**本租户的同事**，以及**平台管理员**（`tenantId === null` 且 `role === 'platform_admin'`，每个租户都可达——客服回得上去的那一侧）；其余情况仍走同一个 404。会话行仍写在**被聊的那位客服所属的租户**下，所以平台管理员是按 `x-tenant-id` 选定一家公司后读写，双方读的是同一个租户范围，读路径的租户边界没有任何放宽。
- `GET /api/v1/internal-chat/threads`：本人参与的会话，按 `lastMessageAt` 倒序，用于联系人列表的最后消息时间。
- `GET /api/v1/internal-chat/threads/:threadId/messages`：`InternalMessage[]`（`id / tenantId / threadId / senderMemberId / body / attachment / createdAt`），最旧在前。当前一次返回全量，无分页。`attachment` 为 `null` 或 `{id, kind, fileName, mimeType, byteSize, url}`——**`url` 不落库**，是每次读取时现签的（见下「内部会话附件契约」）。
- `POST /api/v1/internal-chat/threads/:threadId/messages`：body `{content?, attachmentId?}`，**两者至少要有一个**：只发文字、只发文件、文字加文件都是合法消息。`content` trim 后超过 2000 字返回 400；两者都没有返回 400。`attachmentId` 指向一次上传换来的草稿，服务端在写消息的**同一笔事务**里认领，条件是「同租户 + 同会话 + 同上传人 + 未被发送」四样齐全（`400 附件不存在或已发送，请重新选择文件`，不区分是哪一条不符——区分等于描述调用者看不到的行）。返回落库后的消息。前端发送时先清空输入框，失败把原文放回。
- `POST /api/v1/internal-chat/threads/:threadId/attachments`：`multipart/form-data`，字段名 `file`，**先上传后发送**——上传成功换回 `{id, kind, fileName, mimeType, byteSize}`，把它作为 `attachmentId` 随消息发出。成员资格与发消息同一处判定（不是参与者 403、会话不在本租户 404），所以「能上传」与「能发言」不会各说各话。字节先落对象存储、行后写库，中途失败只会留下一个没人引用的对象（可按 `tenants/<租户>/internal-attachments/` 前缀清理），不会留下一条承诺了不存在字节的记录。
- `GET /api/v1/internal-media/:messageId`：按签名读取附件字节，`@Public`（鉴权在签名里，不在 Bearer 里），签名由消息接口一并给出，寿命十分钟。图片与视频以内嵌方式返回，其余一律 `application/octet-stream` + `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`；`Cache-Control: private, max-age=300`（**不要**按公开资源缓存：地址是凭据）。验签失败 403，附件或对象不存在 404，对象存储不可用 503。
- 鉴权：`threadId` 不在本租户返回 404（不确认它存在），在同租户但不是参与人返回 403。租户管理员在一对一里**没有**更宽的视野——读取同事的私人会话不是管理动作；**平台管理员同样没有**：他能读的也只是自己参与的那些会话，别人的一对一对他仍是 403。前端气泡方向按 `senderMemberId === 当前登录成员 ID` 判定，不按显示名。
- 实时：新增 `internal.message.created`，`data` 为 `{thread_id, message_id, sender_member_id}`，**不含正文**。事件按租户广播（`store_id: null`），前端收到后按 `sender_member_id` 找到对应同事并回读 REST 补内容、更新摘要；自己发的消息由本窗口本地插入，不重复读（判断依据是帧内 `sender_member_id` 是否等于本人，不看显示名）。消息到达而对应会话不在前台时，前端额外弹一句提示，因为帧本身不带正文、联系人行也只更新一个时间，没有任何文字就等于“看不到”。同租户第三位同事也会收到该帧，但回读会 403——要做到连「有新消息」都不可见，需要把订阅按会话收窄，属后续工作。
- 展示层：「我的会话」列表在客户会话之外，按 `lastMessageAt` 混排列出**有消息的**同事会话（`GET /internal-chat/threads` 的结果过滤掉 `lastMessage` 为空的）。列表接口**不返回消息方向**，所以同事行能用 `lastMessage.senderMemberId === 本人` 推出「我（客服）」还是「客服 某某」，而客户会话行的发送方前缀只有在读过会话详情后才补得上，读不到就不标。列表本身不因为这是同事会话而少读任何一种权限：点进去仍然走 `GET /internal-chat/threads/:id/messages`，由服务端判成员资格。**平台管理员视角（CHG-20261005-19）**：他的工作台**不请求 `GET /conversations`**——他不属于任何公司、不在接待名单里，服务端给他的客户会话全是 `canReply=false` 的只读会话（回复区按 `canReply` 整块隐藏），留着就成了「看得到消息、发不出去」；因此这个身份的工作台只列内部会话，并在登录时就拉一次同事目录与会话摘要（否则进门看到的是空列表），列表标题行写明当前公司名（来自启动时选定的租户）。这是前端的展示口径，不是接口权限：后端的客户会话读取规则没有为平台管理员改变。**会话窗口不依赖同事目录（CHG-20261005-20）**：`GET /internal-chat/threads` 的每一行本来就带回了对方的 `displayName / role / storeId`，但前端原先只留下 `threadId / messages / lastMessageView`，渲染时再回目录里找人——目录里没有这个人（对方刚停用、目录请求失败、本机后端是旧构建）时，行会退化成匿名「同事」，而且 `activeContact()` 找不到人会让 `renderInternalChat()` 整个不渲染，看起来就是「点不开、回不了」。现在把会话带回的同事补进目录（只在缺少时补，目录答得上来就以目录为准），实时帧也不再丢弃「目录里没有的发件人」。**登录时对所有身份都拉一次同事目录与会话摘要**（原先只有平台管理员这样做，坐席要先点过联系人栏才看得到同事会话）。**内部会话的行与气泡标注改为按对方实际角色写**（原先一律写「客服」，源码注释的理由是「两边都是客服」，平台侧出现后不再成立），平台侧另有 `.role-chip.platform` / `.msg-role.platform` 配色。这些都是前端展示口径，接口返回的字段一个没少也没多。**内部会话工具栏的通用项（CHG-20261005-21）**：补上了表情 / 图片 / 视频 / 文件四个按钮，与客户会话共用同一套图标、样式与校验。**表情不需要接口支持**——它就是文本，插进输入框后随 `content` 字段一起提交，所以是真的能用。**图片 / 视频 / 文件（CHG-20261005-22 起真的能发能收）**：选完文件就**立刻上传**（`internalUploadAttachment`）换一个草稿 ID，草稿标「（上传中…）」并拦住发送，上传失败会撤掉草稿并把原因显示出来（`error.message` 与 `error.details` 用「；」拼起来）；发送时把草稿 ID 作为 `attachmentId` 一起提交。此处**曾经**只到「草稿 + 拦截」这一步（CHG-20261005-21），原因是内部消息契约当时只有 `content` 一个字符串字段；现在契约已扩展（见下节），**只有客户会话仍停在原来的提示上**。附件草稿按会话分开存（`direct:<成员 ID>` / `group:<群 ID>`），与客户会话的 `replyAttachments` 同一考量。工具栏的状态标签按「一对一 && 已登录」写「已接通后端」——此前恒写「仅本地演示」，与事实不符。
- 该通道与客户会话完全分离：内部消息没有渠道、客户身份、服务门店和 48 小时窗口，不进入会话队列、首响 / 采纳率指标和顾客导出，也不占用外发额度。因此不要把它实现成 `/conversations` 的一个标志位。
- 本轮验证：接口测试 **17 项**通过（CHG-20261005-22 新增 5 项，逐项见下节「内部会话附件契约」的「验证」；CHG-20261005-19 新增 4 项：平台管理员出现在每个租户的同事目录里、客服与平台管理员之间双向收发并在平台侧列表读回、平台管理员读别人的一对一仍 403、平台管理员只能按当前租户范围开会话，跨租户仍是 404）；本地 PostgreSQL 用 `liming` / `chenxiaoyu` 真实账号走通登录 → 开会话 → 发消息 → 对方读回，SSE 实测收到事件且帧内无正文（**这一轮的真实账号往返是 CHG-20261005-07 时做的，本轮未重跑，平台管理员一侧只用接口测试与内存存储验证，没有真实登录**）。前端 11 个脚本语法检查通过；前端全量脚本测试 33 项通过（CHG-20261005-21 新增 1 项，CHG-20261005-20 也新增 1 项），其中 `scripts/internal-chat-integration.test.cjs` 覆盖「联系人显示真实同事目录 → 打开会话读到历史 → 发送走接口 → 收到实时帧后回读并渲染 → 同事会话出现在我的会话列表并标『客服』→ 点该行回到同事会话」「客户会话行标『客户』、消息标签为『客户 / 客服』、门店显示门店名而非 ID」「收到与自己无关的同事会话帧不抛错」以及「平台管理员视角：一条客户会话都不请求、登录即列出与客服的内部会话、点开就是能发的内部会话」，与「发件人不在同事目录里时（目录里只有本租户同事、会话却来自平台管理员）：行名仍是服务端给的名字而不是『同事』、小标签是『平台管理员』且带 `platform` 类、点开真的打开会话窗口而不是空白面板、输入框与发送按钮可见、发送仍落到同一条 `threadId`」，与「内部会话工具栏：四个通用项都在、表情面板打开的是内部会话那一个（客户会话的面板同时收起）、表情插进内部输入框而不是客户回复框、**表情随消息真的提交给接口**（`internalSend` 收到 `😊收到`）、选文件后**立刻上传**且草稿写成『图片：对账单.png』、上传完成后不再显示『上传中』、发送时把草稿 ID 一起报给接口、只发附件（正文为空）也发得出去、上传失败撤掉草稿并把原因显示出来」，以及同文件里「同事发来的附件按签名地址渲染：图片内嵌 `img.message-image`、文件给 `a.message-file` 并带 `download` 文件名、正文为空的消息气泡里就是那个附件、『我的会话』行的摘要写『[文件] 对账单.pdf』而不是留一片空白」。未做：未读数与已读回执、分页、编辑、失败重试；**客户会话的附件当时仍未接入**（要企业微信的外发媒体上传；**已于 `CHG-20261006-09` 接入**，见文末「客户会话媒体消息契约」）；**发送前撤掉草稿不会删除已上传的字节**（没有删除接口，桶里会留下无主对象，也没有清理任务）；视频上限 50 MB 由 multer 全量读进内存；签名地址只有十分钟寿命；群聊未接通且没有附件；平台管理员**在浏览器里没有实测**（密码不在手上，没有真实登录）。

## 2026-10-05：内部会话附件契约（上传、认领与签名读取）

只覆盖**内部会话**（客服 ↔ 客服、客服 ↔ 平台管理员）。**客户会话不在其中**：给客户发附件要企业微信的外发媒体上传（先传素材换 `media_id` 再发消息），**那一轮（2026-10-05）没做**，客户回复框当时仍提示「首轮整合尚未开放真实附件发送」。**客户会话的契约是后来补的，走法也不同，见文末「2026-10-06：客户会话媒体消息契约」一节——两节不要互相当成对方的说明。**

- **两步走，不能合成一步**：`POST .../attachments` 上传换草稿 ID → `POST .../messages` 带 `attachmentId` 发送。上传会失败（超限、格式不支持、存储不可用），而发出去的消息撤不回来，所以文件必须先落地再发话。前端因此是「选完文件立刻上传」，不是「点发送时才上传」。
- **数据库**：迁移 `0020_internal_attachments` 新增表 `internal_attachments(id, tenant_id, thread_id, uploader_member_id, kind, file_name, mime_type, byte_size, object_key, message_id, created_at)`，`kind` 有 `CHECK IN ('image','video','file')`，另有部分唯一索引 `internal_attachments_message_idx ON (message_id) WHERE message_id IS NOT NULL`。**`internal_messages` 没有加字段**：一条消息的附件是 `LEFT JOIN internal_attachments a ON a.message_id = m.id` 读出来的，`message_id` 就是「已被哪条消息认领」这个事实本身——为空的都是还没发出去的草稿。一条消息最多一个附件由那个部分唯一索引保证。表删除时字节会留在桶里变成无主对象，`.down.sql` 里已注明。
- **对象键**：`tenants/<tenantId>/internal-attachments/<attachmentId>`，与客户媒体（`tenants/<tenantId>/messages/<messageId>`）同一命名空间下的不同前缀，可按前缀枚举与清理。
- **认领的四条**（缺一不可，全部在 SQL 的 `WHERE` 里）：同 `tenant_id`、同 `thread_id`、同 `uploader_member_id`、`message_id IS NULL`。它既是守卫也是写入，所以只有上传人本人、只有一次；拒绝时统一返回 `400`，不区分是哪一条不符。
- **顺序与外键**：写消息必须**先插消息行、再认领**。认领把消息 ID 写进 `internal_attachments.message_id`，那是一列指向 `internal_messages` 的**外键**；反过来会让外键指向一行还不存在的消息。这个错**只有连真库才能发现**——内存适配器没有外键，接口测试跑在内存适配器上完全看不见，第一版就是这么写的（见下「验证」）。
- **类型由服务端判定，不采信客户端**：`kind` 由服务端按内容类型推出。图片白名单 `image/png|jpeg|webp|gif`、视频白名单 `video/mp4|webm|quicktime`，**属于图片或视频却不在白名单里的一律拒绝**（`image/svg+xml` 明确拒绝——它是一份能执行脚本的文档，被当成图片内嵌就是从本平台域名渲染它）；其余一律算 `file`。分档上限：图片 5 MB、视频 50 MB、文件 20 MB（比较是 `>`，恰好等于上限是合法的）。文件名净化掉控制字符与 `\`、`/`，超长截到 120 字符并保留扩展名。
- **文件名编码**：浏览器把 UTF-8 文件名直接写进 `Content-Disposition` 这个 HTTP 头，而 multer 底下的 busboy 按 latin1 读，`对账单.png` 到达时是 `å¯¹è´¦å\x8d\x95.png`。服务端做一次带守卫的 latin1 → UTF-8 还原（用「往返编码一致」与替换字符两个条件判断，避免把本来就正确的名字改坏），所以存下来和显示出来的都是原名。
- **读取**：`GET /api/v1/internal-media/:messageId`，签名里有 `purpose`，与客户会话的地址**互不通用**（拿客户会话的地址读内部附件会验签失败，反之亦然）。签名寿命十分钟，每次回读会话都重新签发，所以**地址不要缓存、不要存进消息体**。
- **验证**：`internal-chat` e2e **17/17**（本轮新增 5 项：真实往返且字节逐一相等并带 `nosniff` / `Cache-Control` / 内嵌判定、拒绝路径（非参与者 403、超限 / SVG / 空文件 400 且对象存储里没多写）、认领规则（别人认领不走、重复发送被拒、PDF 按附件下载）、签名跨用途回放与跨租户 404、平台管理员与坐席双向各发一次）；core 单测 **7/7**（类型判定、白名单拒绝、文件名净化与截断、分档上限与空文件、`internalMessageBody` 有无附件两态）；`platform-postgres.integration` **30/30**（新增 1 项，**当场查出「先认领后插消息」的外键顺序 bug——它会让每一条带附件的发送都返回 500**，而内存适配器没有外键所以 e2e 看不见；同段还有一句错误注释被纠正：`transactions.run` 在回调正常返回时**总是提交**，只有抛异常才回滚，所以认领失败必须抛出去回滚整笔事务）；媒体套件 **6/6**（证明签名加 `purpose` 后客户那条链没被动到）；`knowledge-import` **18/18**（证明「上传超限过滤器」抽成公共文件后行为一致）；前端脚本测试 **33/33**。另用**真实 MinIO**（不是内存替身）做过一次往返：写 35 字节、读回逐字节相等且类型为 `image/png`、读不存在的键返回 `media_object_missing`（读取路由据此回 404），写完已删掉对象。**未在浏览器内真实登录验证**（密码不在用户以外的人手里）。

## 2026-10-05：设置页渠道连接与客服账号契约

设置页不再使用演示数据：渠道连接与客服账号都走服务端。本轮前端只调用了已有能力，**后端与数据库未改**。设置页对客服、商家管理员、平台管理员开放，页面内容按角色收口：**渠道接入整块对客服隐藏**，商家管理员能看到渠道状态与参数名但写入只读，凭据写入限平台超级管理员；写操作服务端仍按角色再校验。（CHG-20261005-12 曾把商家管理员的设置入口整个去掉，CHG-20261005-13 已更正。）

### 渠道连接（企业微信 · 微信客服）

- `GET /api/v1/channels` — 任何登录成员可读。返回 `providers[]`（每项含 `provider` / `mode`（`real` | `mock` | `none`）/ `enableRequested` / `credentialsPresent` / `credentialSource`（`console` | `environment` | `none`）/ `realTransportConnected` / `lastConnectionError` / `missingCredentials`（缺哪些变量，页面会原样列出）/ `callbackVerifyPath`（页面据此生成要填回企业微信后台的回调地址，不在浏览器里另抄一份））、`bindings[]`（本租户已绑定的客服账号，最新在前）与 `credentialVerdict`（上次连接尝试的结论，从未填过时为 null）。
- `PUT /api/v1/channels/wecom/credentials` — body `{ corp_id, kf_secret, callback_token, aes_key, open_kfid }`，五项都必填。**后端 `requirePlatformAdmin`，只有平台超级管理员可调用。** 后端用这五个值当场换取 access_token，再返回 `{ bindingId, connected, credentialSource, verifiedAt, verifiedError }`：`connected: false` 是 **200**，含义是「值已保存并生效，但没连上」；请求被拒（值不可用、Mock 构建没有真实 provider、部署已连到别的账号）才是错误响应。接口不返回、不记录也不回显任何值。
- `GET /api/v1/channels/wecom/callback` — `@Public()` 的回调 URL 校验握手，用**当前**已配置的凭据验签并把解密后的 echostr 原样返回（text/plain，无 JSON 包装、无引号、无 BOM、无尾换行）。前端只把这个地址显示给操作员填回企业微信后台，不调用它。
- `POST /api/v1/channels/wecom/callback` — 与上面**同一个地址**接收消息与事件（企业微信的「接收事件服务器」只登记一个 URL，GET 校验、POST 收消息都在它上面），返回 **200**（企业微信只把 200 当作已接收，Nest 对 POST 的默认 201 会被判失败并重试）。`POST /api/v1/channels/wecom/webhook` 是走同一段处理逻辑的**别名**，供已登记该路径的部署继续使用。两条路径的认证相同且都不接受平台身份。
- `POST /api/v1/channels/wecom/callback-selfcheck` — body `{ url }`（要登记的那个公网回调地址）。**后端 `requirePlatformAdmin`**：服务端会用**当前生效**的凭据按企业微信的格式造一次握手（造 `echostr` → 加密 → 用回调 Token 算 `msg_signature` → `GET` 该地址），并要求地址原样返回明文。返回 `{ ok, stage, detail, http_status, probed_url, credential_source, checked_at }`；`stage` 为 `transport` | `url` | `credentials` | `request` | `status` | `plaintext` | `ok`，指出卡在哪一步。**`ok: false` 也是 200**（自检跑完了，结论就是结果），只有越权（403）与缺 `url`（400）才走错误响应。地址限制：仅 HTTPS 公网地址（内网、回环与 `169.254.169.254` 等会被 `stage: 'url'` 直接拒绝，不做探测）、不内嵌用户名密码、不带 fragment、不跟随跳转、5 秒超时、响应体最多读 8KB。`probed_url` 只回 scheme + host + path（不含自检自己加的那四个参数，避免把可重放的签名交给浏览器历史），`detail` 不回显对方返回的正文——但平台自己的错误信封（`{ code, message }`）会说明，因为那对应「地址对了、凭据不对」。前端只把这个结论翻成中文句子显示，不在浏览器里判断地址是否合规。
- 密钥处理：`kf_secret` 与 `aes_key` 用密码框、提交成功后清空，页面不缓存、不回显。
- **未接**：`POST /api/v1/channels/wecom/bindings`（绑定客服账号到门店，同样限平台管理员）与 `POST /api/v1/channels/deliveries/:deliveryId/retry`（投递重试）在界面上都没有独立入口。绑定不必手工建：保存凭据时后端会按 `corp_id` + `open_kfid` 复用或新建绑定，门店由服务端的 `resolveServingStore` 规则选定，所以界面上没有「选门店」这一步。

### 客服账号

「能登录并接会话」的客服账号由两个对象组成：**member**（排班席位，决定是否被分配会话）与**account**（登录身份与密码，可被停用并踢下线）。前端按三步创建，任一步失败都会停下并说明已完成到哪一步：

1. `POST /api/v1/admin/members` — body `{ tenant_id, store_id, role, username, display_name, enabled }`，`role` ∈ `platform_admin` | `merchant_admin` | `agent`，`store_id` 允许空（落成 null）。返回 Member。
2. `POST /api/v1/admin/accounts` — body `{ username, display_name, password }`。返回的 `AdminAccountView` 带 `id`（即 userId）、`status`、`accessState` 和 `memberId`（未绑定时为 null）。
3. `POST /api/v1/admin/members/:memberId/link` — body `{ user_id }`，把账号绑到成员。

停用 / 启用同时做两件事：

- `POST /api/v1/admin/members/:memberId/enabled` — body `{ enabled }`，控制是否参与分配。
- `POST /api/v1/admin/accounts/:userId/disable` / `.../enable` — 控制能否登录；disable 会注销该账号已持有的会话。

列表读 `GET /api/v1/admin/tenants/:tenantId/members` 与 `GET /api/v1/admin/accounts`，前端按 `account.memberId === member.id` 对应两份数据；登录账号缺失（未绑定）或状态非 `active` 时，在状态列下方单独用小字说明，不与成员的启用状态混为一谈。**前端不提供停用自己的入口。**

### 边界

- **403 分不出「没权限」和「没配置」**：服务端的错误信封只原样透出 `KNOWN_ERROR_CODES` 里的 code（`apps/api/src/http/all-exceptions.filter.ts`），而 `access_denied`（账号停用／临时锁定、跨租户）与 `pending_config`（未绑定成员、所属公司被停用）都不在其中，两者到浏览器统一是 HTTP 403 + `forbidden` / `Forbidden`（CHG-20261005-18）。所以前端不能把 403 读成「数据是空的」，只能说明「登录身份被后端拒绝」；客服账号面板为空与服务端拒绝是两件事。**账号被临时锁定时，已经登录的会话也会拿到 403**——服务端对锁定的判定是「此刻」的（`locked_until` 一过就不再算锁定），但行里的状态要等下一次成功登录才写回，因此碰上锁请直接重新登录一次。
- **授权判断只在服务端。** 前端隐藏入口只是界面收口，不把它当授权依据；被拒时显示服务端返回的 message / details。设置页的渠道连接按**后端下发角色**（`session.access.role`）决定可见与可写（CHG-20261005-14 修正：此前只看演示角色，真平台超级管理员会看到只读表单），其余页面仍按演示角色收口。
- **上线连企业微信的前置条件**：部署侧 `WECOM_TRANSPORT=real`（否则绑定 Mock 传输，`PUT /channels/wecom/credentials` 以 `503 channel_disabled` 拒绝）；五项凭据可由控制台表单写入，也可由 `WECOM_CORP_ID` / `WECOM_KF_SECRET` / `WECOM_OPEN_KFID` / `WECOM_TOKEN` / `WECOM_AES_KEY` 提供，**控制台存了任一份就以控制台那份为准，不会回退到环境变量**；回调地址必须公网 HTTPS 可达并在企业微信后台登记，且登记的那个地址要能被这台服务器自己访问到——注册前先用 `POST /api/v1/channels/wecom/callback-selfcheck` 拿它验一次（CHG-20261005-17，地址填进设置页的「公网回调 URL（自检用）」）。`connected: true` 只代表拿到 access_token，不代表「注册的回调 URL + 运营建好的绑定 + 一次真实往返」这段回路已验证；自检通过也只证明「这个地址现在会用这份凭据原样回明文」，不等于企业微信后台一定接受——两者之间还差企业微信自己的可达性与域名校验。
- 本机为 **Mock 构建**时，`PUT /channels/wecom/credentials` 会被拒绝，填对五个值也拿不到「已连接」；真正连通需要企业微信后台的真实值并把部署切到真实传输。页面对这种部署会直接提示要改 `WECOM_TRANSPORT`。
- **没有真实登录验证**：以上契约按后端代码（`apps/api/src/channels/channels.controller.ts`、`apps/api/src/admin/admin.controller.ts`）与共享类型核对，未做端到端联调；CHG-20261005-14 的角色修正与提示文案也未经浏览器验证。

## 2026-10-06：头像契约（保存、恢复与同事头像）

- `POST /api/v1/auth/avatar`：body `{avatar_url: string | null}`，**字段必填，可以是 `null`**——`null` 是「这个账号现在没有头像」这个正当答案，字段缺失则是畸形请求（`400`），因为唯一会漏发它的调用者本意是设置头像，静默清空是没人要求的写入。返回 `PublicAccount`（camelCase），其中 `avatarUrl` 是**服务端实际存下的值**，前端以它为准而不是本地那份乐观值。`@HttpCode(200)`。
- 值本身是 base64 `data:` URL，不是对象存储地址。约束由 `packages/core/src/auth/avatar.ts` 定义并在服务端**每次写入都校验**：媒体类型白名单 `image/png | image/jpeg | image/webp`、按字节签名核对（自称 PNG 而字节不是 PNG 会被拒）、总长上限 `AVATAR_MAX_DATA_URL_LENGTH = 65536` 字符（约 48 KiB 图片）。数据库侧 `user_accounts.avatar_url` 有一条 `CHECK (avatar_url IS NULL OR (avatar_url LIKE 'data:image/%' AND length(avatar_url) <= 65536))` 兜底（迁移 `0015`）。拒绝统一是 `avatar_invalid`，**原因只在 message 里、是英文**，所以前端按 code 翻成中文提示，不把服务端原话直接给坐席看。
- 存在**账号**上（`user_accounts`），不是成员上；成员与账号之间由 `member_user_links` 的**活动**链接相连。所以「这位同事长什么样」是一次跨表读，不是读成员上的字段。
- 前端在**浏览器里先裁成方形、缩到 192px 以内**再提交，格式优先 WebP、不支持时退回 JPEG（PNG 照片可能超出长度上限）。这一步**不是授权判断**：类型、字节签名与长度仍由服务端判定，前端缩放只是让常见图片能通过。
- 恢复路径是 `GET /api/v1/auth/session` 的 `account.avatar_url`（snake_case，与上面返回体不同名——两处形状确实不一样，别再互相假设）。刷新、换设备都读这一处，所以头像不再只活在本次页面内存里。
- 同事头像：`GET /api/v1/internal-chat/peers` 的每一项，以及 `GET /internal-chat/threads` 与 `POST /internal-chat/threads` 返回的 `peer`，都多一个 `avatarUrl: string | null`。`null` 有三种来源并且**都是正常情况**：账号没上传过、成员没有活动链接、成员根本没有账号——前端一律退回姓名首字，不隐藏、不占位、不提示。
- 客户会话的**客服气泡按接待人**（会话行的 `assignedMemberId`）画脸和署名，因为 `messages` 没有发送人列，「这句话是谁说的」只能按接待人答。`assignedMemberId` 为空、或接待人不在本租户同事目录里时，退回当前登录账号这张（与改动前一致）。
- 上游限制：**企业微信侧的客户看不到头像**。微信客服的消息体里没有「客服头像」这一项，这条线的管道也不承载它；下面的「看到」只发生在**平台内部**（同事、管理员、平台侧）。
- 验证：`memory-repository` 3 项、`internal-chat` e2e 2 项、`auth-postgres.integration` 1 项（连真库的 `JOIN`，含撤回链接与空数组两条边界）、前端 jsdom 5 项（含「刷新后从 session 读回来」与「服务端拒绝时不假装存上」）。**未在浏览器里真人点过**：密码不在手上，选图按钮到接口那条路是脚本测试而不是真人操作，裁切是否好看也只能在浏览器验证。

## 2026-10-06：客户会话媒体消息契约（图片 / 视频 / 文件）

覆盖**客服 → 客户**的外发媒体（`CHG-20261006-06/07/08/09`），以及**客户 → 客服**那条线上现有的图片显示。与上一节「内部会话附件契约」的关键区别：这里**没有草稿、没有上传接口**，上传与发送是同一次请求。

- `POST /api/v1/conversations/:conversationId/messages/media`：`multipart/form-data`，文件字段名固定 `file`，可另带两个文本字段 `source` 与 `dedupKey`（与文字那条路由读的是同样两个，所以一次打错端点的重试仍然带着幂等键）。**没有 `candidateId`**：媒体消息不带文字，也就没有「这条出自哪条候选」可言。返回体与文字发送一致（`DispatchedMessage`）。
- **为什么是一步而不是两步**：企业微信要求先把素材上传换 `media_id` 再发消息，而 `media_id` 有寿命（3 天）且不接受平台自编的 ID。所以「挑选时上传、几小时后发送」可能拿到一个已经死掉的句柄；反过来，**worker 没有对象存储**（重试时它手上只有数据库那一行），句柄必须随消息行落库。两步在这里既不安全也没有必要——消息行出现的时刻，它记的每一件事都已经是真的（字节在我们桶里、企业微信手上有它自己那份）。
- **服务端的处理顺序**：校验（内容类型 → 类别 → 上限 → 文件名）→ 把我们自己那份字节写进对象存储（键 `tenants/<租户>/outbound-media/<消息 id>`）→ 上传企业微信换 `media_id` → 写消息行（类型、文件名、内容类型、字节数、`provider_media_id` 五个媒体列与消息行同一条 INSERT）→ 进 outbox。**字节先落、行后落**：崩在中间留下的是一个没人引用的对象，而不是一行指向不存在字节的记录。整个过程在一次请求里做完、**不重试**——上传失败答给还站在选择框前的客服，比「看起来发出去了、其实在等 worker 再试」诚实。
- **类型与上限**（`packages/core/src/platform/outbound-media.ts`，前端预检镜像同一份）：图片 `image/png | image/jpeg | image/gif` **10 MB**、视频**只收 `video/mp4`** 10 MB、其余按普通文件处理 **20 MB**。声明成图片或视频却不在白名单里的**一律拒绝而不是降级成文件**（`image/webp` 明确不在清单里：浏览器渲染得了但企业微信的图片类型表里没有它，放行只会变成几分钟后的一次上传失败）；`image/svg+xml` 同样拒绝。文件名清洗后最长 120 字符（去路径分隔符与控制字符、超长时保住扩展名）。
- **消息内容是服务端推出来的，不收客户端传的说明文字**：企业微信的图片 / 视频 / 文件消息都没有文字字段，收一个说明就等于存下一句永远到不了客户的话。**文档的内容就是清洗后的文件名**，图片与视频的内容是平台占位串（`[图片消息]` / `[视频消息]`）。同一个内容安全闸（`screenContent`）在两条发送路径上都是先拦后传。
- **错误应答**：校验不过 `400`，原因装在 `message` **数组**里（全局异常过滤器只把数组那一刻的条目收进 `details`，写成字符串客服只会看到「Bad Request」）；对象存储不可用 `503`；企业微信拒绝时状态码与稳定 `code` 取自 `channels/channel-outcome.ts` 那张既有映射表（`channel_not_configured` / `channel_disabled` → `503`，`channel_invalid_request` → `400` `bad_request`，`channel_provider_error` / `channel_delivery_unknown` → `502` `bad_gateway`），**只把话换成中文**，因为客服刚挑完文件，需要的是「下一步做什么」而不是厂商报错原文。非受理人 `403`、已结束会话 `409`，两者都**不写任何行**。前端把 `error.message` 与 `error.details` 用「；」拼起来显示。
- **读取客户发来的图片**：`GET /api/v1/conversations/:conversationId` 的详情里有 `messages[].media`（`{key, mimeType, bytes, name, providerMediaId}`，图片的 `name` 与 `providerMediaId` 恒为 `null`）和一份**按消息 id 索引的 `mediaUrls`**。`mediaUrls` 是**这一次响应的**事实：地址十分钟寿命、每次回读现签，所以不要缓存、不要存进消息体。两个字段缺一不可——有 `media` 说明这条消息确实带媒体，有 `mediaUrls[id]` 才是这一次能读到的地址；**签不出地址时前端退回服务端存下的那句占位文字**（说清「客户发过一张图」），不画一个必然裂掉的图。
- 前端侧（`CHG-20261006-09`）：`send()` 在草稿存在时改走 `sendMediaMessage`，**附件与文字不能同时提交**（拦下并让坐席挑一条，不静默丢掉正文）；发送期间草稿标「（发送中…）」、发送按钮禁用、移除按钮拒绝；成功后撤掉草稿与本地预览地址并重读会话；失败把草稿留在原处、`sending` 复位并把原因显示出来。消息气泡在**有可渲染媒体时不显示正文**——那段文字是给列表预览和导出用的（图片是占位串、文档就是文件名），气泡里已经有图 / 播放器 / 下载链接了，再写一遍就是「[图片消息]」压着一张图。
- 验证（`CHG-20261006-06/07/08`）：接口测试 `outbound-media.e2e-spec.ts` **9/9**（含「存储挂掉答 503 且**一行都没写**」「拒绝路径下对象存储**一次写都没发生**」这两条断言的是写入数组而不是状态码）；worker 单测 29/29；前端 jsdom **3 项**（`scripts/conversation-media.test.cjs`：附件真的走媒体路由且文字+附件被拦、客户图片渲染与占位文字不重复、`sendMediaMessage` 的 FormData 字段）。**接口测试绑的是 `WECOM_TRANSPORT=mock`**：本部署在测试配置下绑的是真实适配器且没有凭据，一切操作都会以 `channel_not_configured` 拒绝，成功路径根本跑不出来。
- 限制（写清楚）：**未在真实企业微信账号上验证**（凭据不在手上）——企业微信到底收不收这次上传、它的体积上限到底是多少（公开文档有两个互相打架的说法）、`media_id` 的 3 天寿命都只能等真账号；**接口测试通过不等于生产可用**。每个文件都现传一次临时素材（3 天自然过期），这是「不做草稿」的代价。附件仍受 48 小时回复窗口与每窗口 5 条额度约束。同一条消息的 worker 重试若跨过 3 天，手上那个句柄已经死了（没有任何地方会在重试前续期）。`ChannelCapabilities` 仍是布尔项、装不下「支持视频 / 文件」，设置页那行能力说明声明不了这两类。**客户发进来的视频与文件仍落成文字占位**（入站媒体管线只收图片，标成 `video` 却不下载字节只会得到一个永远播不出来的气泡）——这是有意的不对称，不是没做完。
- **未在浏览器里真人点过**：密码不在手上，选文件到发送那条路是 jsdom 脚本测试而不是真人操作，发送中状态、气泡里的图片尺寸与视频播放器样式只能由用户确认。

## 2026-10-07：会话分流权重契约（新会话按权重分配给客服）

> 2026-10-08 补充：这块界面从设置页搬到了管理员中心的「员工分流」（`CHG-20261008-02`）。
> **下面写的接口、字段、权限和校验全部照旧**，只有前端入口和几个 DOM id 变了。

覆盖 `CHG-20261007-05`。这是「新会话自动分配给谁」这条**既有链路**的**配置面**：分配规则本身（`planAutoAssign` → `selectAutoAssignee`、compare-and-swap 派发、无人在线时的单条离线自动回复）都没有改，只是候选上多了一个字段、排序换了一个比较函数。

- `GET /api/v1/assignment/routing` → `{tenantId, seats: RoutingSeat[]}`。席位字段（camelCase）：`memberId`、`weight`、`configured`（**是否单独设置过**，`false` 表示当前用的是默认 1）、`enabled`、`status`（接待状态）、`live`（是否在线接单：心跳还在有效期内）、`inProgressCount`、`updatedAt`、`updatedBy`。`updatedAt/updatedBy` 在没设置过时是 `null`——**「没配过」和「配成 1」在响应里是不同的**（`configured` 就是为这件事存在的），界面上分别写「默认权重（未单独设置）」和具体值。
- `PUT /api/v1/assignment/routing`：body `{weights: [{member_id, weight}, …]}`（snake_case，与其它写接口一致），返回保存后重读的整份 `ConversationRouting`。**只 upsert 提交上来的成员**——没出现在数组里的席位保持原值。这是刻意的：前端只提交页面上看得见的行，若按「整表覆盖」语义，一次部分提交就会把没渲染出来的客服静默重置成 0（= 从此不被自动分配）。要停掉某个人请显式提交 `weight: 0`。
- **权限**：两条路由都过 `assertTenantAdmin`，**客服读写都被拒（403）**。平台管理员按 `x-tenant-id` 指定租户（demo 头模式下需要同时给 `x-member-id` 与 `x-tenant-id`）。前端把面板对客服隐藏，但那只是不给入口——收口在服务端。
- **校验与错误**：每个 `{member_id, weight}` 逐项检查——必须是**本租户的客服成员**（不是：非客服 / 别的租户 / 不存在的 id → `400`）、`weight` 必须是 **0–1000 的整数**（小数、负数、1001 → `400`）、**同一成员不能出现两次**（重复 → `400`）。非法请求**什么都不写**。
- **规则**（`packages/core/src/platform/assignment.ts`）：合格候选人里取「**在手会话数 ÷ 权重**」最小者。四条边界值得记牢：①权重是**相对比例**——比的是比值而不是名额，6/4 ≡ 60/40，不必凑够 100；②**权重 0 不参与自动分配**，但它**不在资格判定（`assignmentEligibility`）里判**，因此这样的席位**仍然是合法的手动转交对象**；③**没有配置行 = `DEFAULT_ASSIGNMENT_WEIGHT = 1`**，已迁移但没有配置行的部署行为与改动前完全一致；④比较用**整数交叉相乘**（`a.count × b.weight` 与 `b.count × a.weight`）而不是先做除法，避免浮点误差让「相等」的比值被判成不等；比值相等时按 `memberId` 的**码位序**决定，不用 `localeCompare`（它随 locale 变）。
- **数据库**：新表 `conversation_routing_weights`（迁移 `0022`），`(tenant_id, member_id)` 为主键，`weight INTEGER NOT NULL CHECK (weight >= 0)`，`updated_at` / `updated_by`（`ON DELETE SET NULL`，与 `audit_log` 同一惯用法）。**表里没有行就是「没配过」，不等于权重 0**——这是上面③能成立的前提。
- **审计**：写入成功后追加一条 `assignment.routing.updated`（`targetType: 'conversation_routing_weights'`、`targetId` 为租户 id、`metadata.weights` 是本次提交的数组）。与其它审计一样是**事后**记录。
- **前端**（`pages/admin.html` 的 `#admin-view-routing`、`src/app.js` 的 `RoutingPortal`）：**2026-10-08 从设置页整块搬到管理员中心的「员工分流」**，接口、字段、权限一条没改，设置页的 `#settings-routing-panel` 已删除。表格五列——员工 / 接待状态 / 在手会话数 / 权重 / 实际占比。**「实际占比」是前端按当前输入实时重算的示意值**（分母只算已启用且在线接单的席位），不发请求、也不代表历史分配结果；把它当「服务端算给我的比例」就错了。**能不能看**由管理员中心的权限模块决定（没权限既不渲染也不去读），**能不能改**只看后端下发的角色（保存按钮只对平台管理员出现）。保存前做一次与服务端同口径的本地检查（0 或正整数）；**一个数字都没改时不发请求**，失败时保留已读到的数据。
- **限制**：**界面未在浏览器里真人点过**——平台管理员的密码在 `CHG-20261005-03` 的改密验证中被改掉，仓库里记的 `Admin123456` 已不能登录，所以平台侧真实会话拿不到；前端这一层只有 jsdom 脚本与静态检查。后端侧为实测：`assignment.e2e-spec.ts` 41/41、真实客服账号登录后 `GET /assignment/routing` 返回 403。权重只在**自动分配那一刻**参与，**不重洗已经分好的会话**；没有按班次 / 门店分策略、也没有策略历史与回滚。

## 2026-10-08：个人快捷短语契约（按登录客服隔离）

覆盖 `CHG-20261008-11`。此前「个人短语」只是 `mock-data.js` 里 `quickPhrases` 的一组全局演示数据：登录后所有客服看到的是同两条、谁都能改、也谁都能启停，改动只落在浏览器内存。这一条把**个人那一半**接成了服务端事实——**归属由会话决定，隔离写在 SQL 里**。

- `GET /api/v1/personal-phrases` → `PersonalPhrase[]`，**只含调用者自己的行**，按 `createdAt` 倒序（同一时刻按 id 兜底，只为让同一个适配器内的顺序稳定；两个适配器的实现不同——内存用计数器、真库用 UUID——所以**不要在跨适配器之间断言顺序**）。
- `GET /api/v1/personal-phrases/:phraseId` → 单条；**不是自己的 id 答 `404` 而不是 `403`**。403 等于承认「这个 id 存在」，可以拿来逐条探测别人的短语编号；两种情况的响应完全一致，因此读不出信息。
- `POST /api/v1/personal-phrases`：body `{title, text, category?, keywords?}`（**camelCase**）。`title` 与 `text` 必填，`category` 缺省为 `''`，`keywords` 缺省为 `[]`。返回 201 与刚写入的那一行（`enabled` 为 `true`）。
- `PATCH /api/v1/personal-phrases/:phraseId`：body 是上面任意字段的子集，**只覆盖点到的字段**（`COALESCE`，`patch ?? current`）。两条要记住的语义差别：`keywords: []` 是**真清空**（`undefined` 才算「别动它」）；**空 patch（`{}`）答 `400`**，而不是「什么都没做地返回 200」——一个空请求体几乎总是前端拼错了字段名。
- **归属人与租户都来自会话**：请求体里**没有也不接受** `memberId` / `ownerId`，服务端用 `access.resolveMember(req)` 作归属、`resolveTenantScope` 作范围。前端 `KefuApi` 的三个方法签名里也没有 `memberId`，公司范围沿用统一的 `x-tenant-id`（个人笔记只属于他所在的租户，不另开一套范围）。**这是这条契约最要紧的一点**：让客户端能指名归属人，就等于把「个人」交给了调用方自觉。
- **字段与长度**：`id`、`tenantId`、`memberId`、`category`、`title`、`keywords: string[]`、`text`、`enabled`、`updatedAt`、`createdAt`。上限是 `PERSONAL_PHRASE_LIMITS`——标题 60 / 分类 30 / 正文 2000 / 单个关键词 30 / 关键词最多 20 个，**按字符**而非字节计（`[...value].length`，中文按一个字算）；超限答 `400`。前端的 `maxlength` 是同一份数字，但**说了算的是服务端**。
- **数据库**：新表 `personal_phrases`（迁移 `0023`，`.up` / `.down` 成对），`tenant_id` 与 `member_id` 都是 `ON DELETE CASCADE` 外键（公司与成员消失时留着一份没有主的笔记没有意义），索引 `personal_phrases_tenant_member_created_idx (tenant_id, member_id, created_at DESC)`。**没有版本列、没有 DELETE**：停用一个短语是 `enabled = false`，它仍然属于作者、仍然可以被重新启用——所以这一条契约里不存在「别人删了我的笔记」这种情况。
- **前端**（`src/app.js`）：`phraseOwnerId()` / `visiblePhrases()` / `phraseById()` / `canManagePhrase()` 四个函数是唯一的出入口，**所有渲染与查找点（列表行、右侧选用面板、回复框输入联想、选用弹窗）都改走 `visiblePhrases()`**——`scope === '个人'` 的行只在 `ownerId === phraseOwnerId()` 时可见，团队短语照旧放行。列表读取带 epoch + 会话身份守卫，过期响应与登出后的响应直接丢弃；`clearBackendSession()` 里把短语集合恢复成 mock 快照，避免换账号后残留上一个人的短语。新建 / 编辑 / 启停**成功后才关弹窗**，然后重读一次列表（服务端那份才算数）；失败保留原状态并提示。**没有后端会话时行为不变**——仍是 `mock-data.js` 里那两条示例，改动只落在内存，且一次都不请求服务端。
- **限制**：**未在浏览器里真人点过**——平台管理员密码不在手上，且这一页对平台侧本来就不可见（导航把 `phrases` 限给客服与企业管理员），只有 jsdom 与接口两层证据。**没有删除能力**；**没有版本列**，两个窗口改同一条是后写覆盖先写。**没有搜索与分页**（一次读全量，一个人自己写的短语量级不大）。**团队短语没有接**——页面上的「团队」一半仍基于 `quickPhrases` 内存数据，与知识库页那份公司共享话术 `/knowledge/shortcuts` **不是同一个接口**，本轮也没有把两者合并。**正在运行的 3000 端口实例还没有这条路由**：`apps/api/dist` 未重建，改动要先 `npm run build`（或按既有约定 `touch apps/api/dist/main.js` 让 `--watch` 重启）。
