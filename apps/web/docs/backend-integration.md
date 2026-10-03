# 前后端对接清单（MVP 与新增界面原型）

本文件列出当前界面需要的数据和状态。标记「文档已指定」的路径来自需求文档；标记「待确认」的是前端提出的接口需求，正式开发前由前后端共同确定路径和字段。

## 2026-09-24 首轮整合状态

整合副本已经按后端现有契约实现以下调用：

- `POST /api/v1/auth/login/password`、`GET /api/v1/auth/session`、`POST /api/v1/auth/logout`；令牌仅保存在当前标签页的 `sessionStorage`。
- `PUT /api/v1/assignment/presence` 与 `POST /api/v1/assignment/presence/heartbeat`。
- `GET /api/v1/conversations`、`GET /api/v1/conversations/:conversationId`。
- `POST /api/v1/conversations/:conversationId/messages`，请求字段为 `content`、`source`、`dedupKey`。
- `POST /api/v1/conversations/:conversationId/close`，并传 `expectedVersion`。
- `GET /api/v1/directory/tenants`，用于平台管理员选择单公司业务范围和默认门店。
- `GET/POST/PATCH /api/v1/knowledge/products`、`/knowledge/faqs`、`/knowledge/shortcuts`；所有成员可读，只有管理员可写。
- `POST /api/v1/knowledge/import-batches/preview` 与 `/apply`；使用 `multipart/form-data` 上传 CSV / XLSX，先预览再应用。

本地 Web 服务把 `/api/*` 同源代理到 API，避免开发环境的 `localhost` / `127.0.0.1` 跨域差异。实时事件、附件、转接以及下表其余模块仍待后续接入。

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
| 左侧联系人 | 新建分组、调整联系人分组 | 路径待确认 | 变更由服务端校验角色和租户范围，返回分组 ID、版本与更新结果；当前原型只修改浏览器内存。黑名单操作在权限与规则明确前不开放。 |
| 内部群聊 | 群列表、按名称或成员搜索、新建群、群成员与历史消息、发送消息 | 路径待确认 | 群 ID、租户 ID、成员 ID、消息 ID、发送人、时间、游标与发送状态；创建和发送由服务端校验成员资格与租户范围，实时事件推送新消息。当前仅为本地演示，不能复用微信客服外发接口。 |
| 会话列表 | 查询当前客服的处理中 / 已结束会话 | 路径待确认 | `conversation_id`、`store_id`、买家脱敏显示名、最近消息、未读数、`state`、`state_version`、接待客服、`ended_at`；“我的会话”下按 active / ended 分类，返回独立计数和分页。结束成功后从处理中移入已结束并保留历史消息；已结束仅可读，服务端同时禁止发送 / 转接。买家联系人可进入对应分类的会话。 |
| 会话分配 | 系统自动分配并通知目标客服 | `GET /realtime`、`GET /conversations` | 事件触发 REST 补读，无抢单或退池入口；无人在线等待后端重试分配。 |
| 会话操作 | 转指定客服、结束、分配历史 | `POST /conversations/:id/transfer`、`POST /conversations/:id/close`、`GET /conversations/:id/assignments` | 写入携带 expectedVersion，转接目标由 transfer-targets 返回，同公司且在线接单。 |
| 对话区 | 拉取消息、查询外发状态 | 路径待确认 | `message_id`、方向、类型、正文/媒体引用、文件名、大小、时间、`message_source`、发送状态。图片、视频和文件按类型展示；媒体不可用时显示占位或失败原因。 |
| 回复栏 | 发送最终文本；媒体仍为原型 | `POST /conversations/:id/messages` | content、source、candidateId、dedupKey；展示 deliveries 最终结果，失败不假定成功。 |
| 智能辅助 | 获取最多 3 条候选及来源 | `POST /retrieval/suggestions`、`GET /retrieval/suggestions/:id` | provider、候选集合 ID、来源 ID、内容、评分、降级原因；人工确认后发送。 |
| 商品库 | Excel/CSV 导入、清洗错误、异步索引进度 | 路径待确认 | SPU、SKU、类目扩展属性、商品链接、`snapshot_at`、导入任务和索引状态。价格与库存仅作快照展示。 |
| 统一知识库 | 商品、FAQ、公司快捷话术的列表、创建、编辑和启停 | 已接 `/api/v1/knowledge/products`、`/faqs`、`/shortcuts` 的 GET / POST / PATCH | 平台管理员请求带 `x-tenant-id`；商品和 FAQ 新增带默认 `storeId`，公司话术新增传 `storeId: null`。客服可读但写入由后端返回 403；管理员写入仍由服务端 `requireConfigurator` 校验。 |
| 统一知识库 | SPU / SKU 详细维护 | 已接 `GET /knowledge/spus`、`GET /knowledge/spus/:id`、`POST /knowledge/spus`、`PATCH /knowledge/spus/:id`、`POST /knowledge/spus/:id/skus`、`PATCH /knowledge/skus/:id`；分类 `GET /knowledge/categories` | 请求带 Bearer 和 `x-tenant-id`；列表按服务端授权返回。详情为 `{spu, skus}`。SPU 创建必填 `storeId/productCode/title`；修改仅提交可变字段。SKU 从所属 SPU 继承门店，前端不指定归属。 |
| 统一知识库 | 商品 CSV / XLSX 导入预览与应用 | 已接 `POST /api/v1/knowledge/import-batches/preview`、`/apply` | `multipart/form-data` 字段为 `file`、`storeId`；先展示总行数、可导入行和错误，再由管理员确认应用。 |
| 统一知识库 | 页面内回答测试 | 前端快速匹配，正式召回待接 | 当前从已读取的启用商品、FAQ 和公司快捷话术中展示前三条匹配；正式版本应调用检索接口并返回相关性、来源切片和未命中原因。 |
| 快捷短语 | 个人 / 团队列表、搜索、创建、编辑、启停与回复栏联想 | 路径待确认 | 团队短语按租户共享，普通客服可读，企业管理员可写；个人短语按登录员工隔离，本人可读写。返回短语 ID、范围、归属员工、标题、分类、关键词、正文、启用状态、版本及使用次数。启停后更新右侧列表和输入联想；写操作需版本、幂等键和服务端权限校验。店铺 / 客服组级范围待评审。 |
| 数据概览 | 会话量、首次响应、采纳率、手打率 | 路径待确认 | 支持日/周与店铺范围。计算口径以需求文档 §4.8 为准，不在浏览器端重新定义。 |
| 管理员中心 | 员工本日/周/月服务指标与员工对比 | 路径待确认 | 按租户、授权店铺、员工和统计周期返回接单量、付款人数、付款金额、平均响应时长、满意度、3 分钟回复率、数据更新时间及可用状态。付款类指标需订单回传和归因定义；不可用时返回明确状态，不得以演示值代替。 |
| 管理员中心 | 查询与修改员工管理权限 | 路径待确认 | 支持完整管理员权限和模块级授权。服务端校验操作者权限与租户范围，防止移除最后一名完整管理员；写入需版本、幂等键和审计记录。未授权读取或写入统一返回 403，前端显示“暂无权限”。 |
| 管理员中心 | 首页访问与模块权限 | 路径待确认 | 企业员工可访问功能卡片首页；汇总数字与模块数据按权限返回。首页汇总员工数 / 接单量 / 付款金额对应员工对比权限，可参与接待人数对应分流权限。角色 / 权限变化应清空旧数据并重新获取权限。 |
| 管理员中心 | 申请授权与申请状态 | 路径待确认 | 无权限弹窗可申请当前模块，提交申请人、租户、模块、幂等键；服务端从登录身份确定申请人，去重未结申请并返回 pending / approved / rejected。只有有审批权限的管理员可审批，记录审计并通知申请人；申请本身不授予权限。当前仅在内存模拟待审批，无真实通知和审批服务。 |
| 管理员中心 | 员工分流资格 | 路径待确认 | 管理是否参与自动接待及授权店铺范围。最终分配算法、优先级和容量规则待产品及后端确定；前端不自行决定目标客服。保存结果需返回版本和生效时间。 |
| 管理员中心 | 员工聊天记录与操作日志 | 路径待确认 | 按授权店铺、员工、客户和时间查询，消息使用 cursor 分页；客户信息脱敏。查看原文、导出及权限变更都需要单独授权与审计，结果按数据保留策略返回。 |
| 设置 | 微信客服连接、欢迎语、离线回复、成员和店铺范围 | 路径待确认 | 展示连接状态、最近同步时间、配置错误；只有「在线接单」参与自动派单。 |
| 话术审核 | 待审列表、通过、编辑后通过、拒绝 | 路径待确认 | 平台运营人工审核；默认只显示候选话术和脱敏来源片段，保留审核动作历史。 |
| 审核策略 | 读取 / 修改策略 | `GET/PATCH /api/v1/platform/phrase-review-policy` 文档已指定 | 平台运营可读；只有平台超级管理员可改。PATCH 需策略版本与幂等键，版本冲突返回 409。 |
| 租户管理 | 开通租户、店铺、成员角色及店铺范围 | 路径待确认 | 普通注册用户未配置前只能进入账号中心；服务端按角色和店铺授权数据。 |
| 登录与账号 | 当前员工资料、头像上传、资料更新、密码修改、退出登录、注册、密码/验证码登录、找回密码、SSO 绑定、受信设备管理 | 路径待确认 | 资料响应返回姓名、脱敏手机号、角色和头像地址；手机号修改需二次验证。头像服务校验 PNG/JPEG/WebP、大小和内容并返回持久地址。密码修改校验当前密码和服务端强度策略，成功后按策略撤销旧会话；退出登录使当前会话失效；SSO 绑定先验证本地账号。 |

## 需要前端显示的异常状态

1. 模型超时、限流或不可用：展示 FAQ、快捷短语或纯检索候选，并写明降级原因；回复栏仍可人工使用。
2. 商品索引未完成：展示处理中与快照时间，允许使用结构化资料或快捷短语。
3. 无相关商品或 FAQ：不生成看似确定的答案，提示客服人工处理。
4. 外发额度接近上限、窗口到期或渠道失败：提示客服并显示每条消息最终发送状态。
5. 自动分配或转接后会话归属变化：通过实时事件刷新当前客服的会话列表；结束操作遇到版本冲突时刷新状态。
6. 图片、视频或文件拉取 / 上传失败：保留消息占位与人工回复能力。

## 当前原型与正式版本的区别

回复框输入联想当前在本地匹配个人与团队 `quickPhrases` 的标题、正文和关键词；结果显示所属范围及命中词，个人命中优先。管理页和右侧面板的新增 / 编辑 / 启停只修改浏览器内存。正式接口应按登录员工返回本人个人短语及有权使用的团队短语；异步搜索应取消或忽略过期响应，停用项不得返回给发送入口。选用短语仅回填草稿，人工确认后发送。

回复工具栏支持表情插入、系统截图粘贴与本地附件草稿：图片不超过 5 MB、视频不超过 50 MB、文件不超过 20 MB，一次选择一个，按会话暂存。当前消息区的视频播放和文件下载均使用浏览器本地对象地址，没有上传或真实外发。正式发送前需上传并取得媒体 ID；类型、时长、大小、病毒扫描和渠道能力由后端确认。邀请下单目前回填示例商品链接；实际商品、规格、有效下单链接及渠道能力须由服务端提供，确认后才发送。

`src/mock-data.js` 仍为联系人、群聊和独立快捷短语页面提供固定示例。登录后的 AI 候选、会话转接、分配历史和实时更新，以及统一知识库和商品批量导入，均已使用真实 API。附件、管理员中心配置和审核仍是演示。服务端继续负责身份、权限、租户范围、幂等、审核和最终状态；前端隐藏控件不承担鉴权。

## 数据导出对接
- `GET /api/v1/directory/tenants`：授权公司目录；平台管理员也必须明确选择公司。
- `GET /api/v1/conversations`：获取当前公司的可选会话。
- `POST /api/v1/exports`：提交 `{scope: "customers", q, from, to}` 或 `{scope: "conversation", conversationId}`；日期按 UTC 筛选，空日期不提交。
- `GET /api/v1/exports`：查询最近任务，显示 `status`、`rowCount`、`error`、`artifacts` 及时间戳。
- `GET /api/v1/exports/:jobId/download/:format`：format 为 xlsx 或 transcript，返回二进制文件，以 Content-Disposition 中的文件名下载。
- 所有导出、会话和下载请求携带 Bearer 令牌及 x-tenant-id；不使用浏览器角色判断替代服务端鉴权。未完成任务轮询更新，离开页面后取消后续轮询。

## 工作台已接入的接口
- `POST /api/v1/retrieval/suggestions`：`{conversationId, limit:3}`，自动按最新客户消息检索；`GET /retrieval/suggestions/:id` 查询持久化集合。返回 `provider`、`candidates`（kind/sourceId/title/content/score/tenantId/storeId）和 `fallbackReasons`。未配置模型时展示知识库候选，不展示模拟生成内容。
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
- 退出立即清除 UI 会话及旧知识数据，角色显示未登录；后台撤销请求结束前禁用新登录，避免旧请求清除新令牌。公司范围和 SPU / SKU 数据不跨账号复用，迟到结果不更新已退出页面。
- 管理员可写需要真实已连接会话及后端角色；UI 角色下拉不提供模拟提权。真实管理员登录 / 退出 / 再登录验证通过，12 项前端回归测试及 10 个脚本语法检查通过；实际商品写入持久化验证限制不变。
