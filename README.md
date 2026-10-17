# 智能客服 SaaS 平台

SDD-002 工程骨架、环境与质量基线。本仓库只提供可持续开发、测试和部署的**工程基础**；SDD-001 业务需求属于外部前置依赖，不在本仓库实现。

## 仓库结构

```text
apps/web        React + Vite Web 客服内核操作控制台（会话/知识/审核/报表/渠道/目录/账户）
apps/api        NestJS HTTP API（/api/v1、health、request id、稳定错误、平台内核路由）
apps/worker     NestJS Worker（可启动、可观测，带独立 health server 与渠道出站投递处理器）
packages/core   @kefu/core 共享纯 TS 原语 + packages/core/src/platform 确定性平台领域模型
database        数据库迁移目录与最小迁移 runner（pgvector 扩展 + 平台内核业务表）
tests           跨包示例/接口测试
scripts         compose 结构检查、Vitest decorator 转换等开发脚本
```

## 前置依赖

- Node.js >= 20（仓库在 Node 22 上验证）
- npm（workspaces 已启用）
- Docker + Docker Compose（可选，仅用于启动本地基础设施；`npm run compose:check` 不依赖 Docker CLI）

## 新开发者启动

```bash
# 1. 安装依赖
npm ci

# 2. 复制环境变量（默认值可直接用于本地开发）
cp .env.example .env

# 3. 启动本地基础设施（PostgreSQL+pgvector、Redis、MinIO，并初始化 bucket）
docker compose up -d

# 4. 应用迁移并写入种子数据（种子会创建本地管理员账号 admin，密码见下）
npm run db:migrate
npm run db:seed

# 5. 三个终端分别启动应用
npm run dev:api      # http://127.0.0.1:3000
npm run dev:worker   # health server http://127.0.0.1:3001
npm run dev:web      # http://localhost:5173
```

自检：

```bash
curl http://127.0.0.1:3000/api/v1/health/live
curl http://127.0.0.1:3000/api/v1/health/ready
```

打开 http://localhost:5173 可看到**客服内核操作控制台**（多视图 Web Shell）：会话工作台、知识库、内容审核、报表与审计、渠道接入（真实企业微信接入配置与状态）、组织与租户目录、账户与权限。控制台需要登录：日常用种子客服 `agent01` / `Agent123456`；平台管理员是 `admin`，其密码已在 2026-10-05 改密后不再是种子默认值（见「登录与访问模型」）。

## 环境边界

所有应用（api / worker / web / compose）共用 `.env.example` 顶部的变量。

- `APP_ENV=local`：本地开发，使用本地依赖默认值。
- `APP_ENV=test`：自动化测试，与 local 共用本地默认值。
- `APP_ENV=production`：生产/试点。关键连接与凭据必须显式提供（`DATABASE_URL`、
  `REDIS_URL`、对象存储、`CORS_ORIGINS` 等），缺失时应用拒绝启动。

敏感值（连接串、access key/secret）在配置解析后以 `Redacted` 包装，不会进入日志。

## API 约定

所有路由在 `/api/v1` 版本前缀下。

- `GET /api/v1/health/live`：进程存活探针，返回 200。
- `GET /api/v1/health/ready`：就绪探针。检查 **PostgreSQL、Redis、对象存储（MinIO）与
  Worker**；每个连接、命令、HTTP 探测和整体检查都有 `HEALTH_TIMEOUT_MS` 有限 deadline
  （默认 `1000` 毫秒）。任一依赖不可用即返回 503，响应体 `data.dependencies` 给出逐项
  状态，失败状态不会被误报为 ready。
- `GET /api/v1/realtime`：一次性 SSE 基础事件流。事件包含 `event_id`、`event_type`、
  `tenant_id`、`store_id`、`occurred_at` 与 `data`；事件类型在
  `apps/api/src/realtime/realtime-events.ts` 集中定义。该通道只负责通知，断线后的数据补偿
  由后续 REST 接口完成。

成功响应使用稳定信封 `{ request_id, data, meta }`（SSE 原始事件流除外）。

错误响应使用稳定契约 `{ request_id, code, message, details }`。内部异常、连接串、token
与 stack 不会回显给客户端。

### 会话分配与在线状态

会话进入待接入池即**到期**，由 `AssignmentScheduler`（`ASSIGNMENT_SWEEP_INTERVAL_MS`，默认 5 秒
一轮，每轮至多 `ASSIGNMENT_BATCH_SIZE` 条）自动派给本店「在线接单且当前进行中会话最少」的坐席。
`claim` 保留为**人工抢先接手**入口——它与自动派单走**同一个 CAS**（`version` + `status='open'` +
`assigned_member_id IS NULL`），因此同一会话并发只有一个赢家。派不出去时会话留在池内且**仍然到期**，
一轮一轮自然重试；离线回复由 `offline_reply_at` 守卫，**只发一次**。

- `GET /api/v1/conversations/pool`：本店待接入池，最久等待在前。每项含 `waitingMs`（本轮等待）、
  `firstResponseMs`（买家为「等到一个人」花费的总时长，尚无回复时该键**缺席**而非 null）与
  `audienceMemberIds`（当前应被推送的坐席；推送本身属实时面，尚未落地）。
- `GET /api/v1/conversations/:id/assignments`：该会话的分配历史，**包含被拒的记录**。
  `action` 为 `claim` / `auto_assign` / `transfer` / `return` / `release`，
  `result` 为 `success` / `rejected` / `expired`。
- `GET /api/v1/assignment/presence`：读取**自己**的在线状态；从未上报过的坐席没有 `data`。
- `PUT /api/v1/assignment/presence`：上报状态，取值为 `accepting` / `busy` / `away` / `offline`。
  仅坐席可调用，管理员返回 403，取值越界返回 400。
- `POST /api/v1/assignment/presence/heartbeat`：只刷新存活时间、不改状态；从未上报过的坐席返回 404。

在线状态是 PostgreSQL 的 `agent_presence` 一行（**缺席的行即离线**），存活按 60 秒心跳窗口
**读时判定**，所以掉线的浏览器不需要自己上报「我离线了」。Redis 不承载在线状态。

### 登录与访问模型

控制台与 API 都以**Bearer 会话**为身份来源：先登录换取一次性返回的 token，之后的请求带
`authorization: Bearer <token>`。平台只保存 token 的指纹，因此 token 只在签发那一刻返回，
之后无法再次读取。

```bash
# 本地种子管理员登录（凭据见下文；仅本地/测试环境）
curl -X POST http://localhost:3000/api/v1/auth/login/password \
  -H 'content-type: application/json' \
  -d '{ "username": "admin", "password": "<平台管理员当前密码>" }'
# → { request_id, data: { token, expires_at, session, access }, meta }
#    其中 access.accessState 为 "active"，access.role 为 "platform_admin"

# 用该 token 访问需要身份的接口
export TOKEN='<上一步返回的 token>'
curl http://localhost:3000/api/v1/auth/session -H "authorization: Bearer $TOKEN"
curl http://localhost:3000/api/v1/admin/accounts -H "authorization: Bearer $TOKEN"
```

**本地种子凭据**：`npm run db:seed` 会写入账号 `admin` / 密码 `Admin123456`，但它用的是 `ON CONFLICT DO NOTHING`，**重跑不会把已改过的密码改回来**；`admin` 的密码已在 2026-10-05 变更，这个值不再可用，需要时用 `npm run db:create-account` 另建可登录的平台管理员账号（用户名不能与已存在的账号重复）
（见「数据库」一节）。它仅供本地开发与测试；部署到任何共享环境前必须更换，且种子**不会**
在重复执行时重置该密码。

**访问状态（`accessState`）**：会话与账户列表都按同一套规则派生出有效访问状态，因此两者不会
互相矛盾。

- `active`：账号、成员链接、成员与租户都可用，可以读写租户业务数据。
- `pending_config`：已通过认证但尚未绑定成员、成员链接已被撤销，或成员所属租户已被停用。
  该状态只能访问账户中心（`/api/v1/auth/*`），访问租户业务数据与管理接口会被稳定拒绝。
- `disabled`：账号被停用/锁定，或成员被停用；一律拒绝。

**一次性验证码**：`POST /api/v1/auth/otp/send` 默认只返回 `challengeId`，验证码仅存在于下发
的记录及其哈希中。本地开发需要闭环登录而又没有短信/邮件通道时，可在 `.env` 中显式设置
`AUTH_DEVELOPMENT_OTP_VISIBLE=true`（仅 `APP_ENV=local` 生效），此时响应会额外带有
`developmentCode` 字段。回显需要三个条件同时成立：`APP_ENV=local`、显式开启该开关、且实际
解析到的提供方就是进程内的确定性本地提供方；生产环境即便误开该开关也不会回显，日志、错误、
数据库与管理接口从不携带验证码明文。

**演示身份头（本地联调兼容）**：`x-member-id` / `x-tenant-id` 仍可用于本地联调，但生产环境
**始终**拒绝、`test` 环境始终接受、`local` 环境需显式设置 `AUTH_DEMO_IDENTITY_HEADERS=true`。
控制台已改用 Bearer 会话，因此仓库根 `.env` 本地默认值为 `false`；本地调试 curl 请求
如使用演示头，直接执行需先在 `.env` 中把该开关改为 `true` 并重启 API，或把
`-H 'x-member-id: ...'` 换成 `-H "authorization: Bearer $TOKEN"`。

- `x-member-id`：当前操作成员 ID。缺省为种子平台管理员 `u-platform-admin`；未知或已停用
  成员会被拒绝。
- `x-tenant-id`：仅平台管理员访问租户数据时需要。租户管理员与坐席**始终**限定在所属租户，
  传入了不同租户会收到 `403 tenant scope mismatch`。

坐席的会话/审核/知识库读取还会被进一步限定到其门店。种子身份：

| 成员 | 角色 | 租户 |
| --- | --- | --- |
| `u-platform-admin` | 平台管理员 | 无（跨租户） |
| `u-t1-admin` | 租户管理员 | `tenant-acme` |
| `u-t1-agent-1` / `u-t1-agent-2` | 坐席（`store-acme-flagship`） | `tenant-acme` |
| `u-t2-admin` | 租户管理员 | `tenant-beta` |
| `u-t2-agent-1` | 坐席（`store-beta-official`） | `tenant-beta` |

## 平台内核（T01）已交付能力

- **身份与目录**：`/access/status`、`/directory/tenants[/:tenantId]`，含租户/门店/成员只读
  配置视图与账户中心。
- **会话**：`/conversations` 列表/详情/发消息，以及 `claim`、`return`、`transfer`、`close`
  状态机（CAS `expectedVersion` 冲突 → `409 conflict`；仅当前接待坐席可归还/转交，管理员可
  结束会话）。
- **知识库**：商品 `/knowledge/products`、FAQ `/knowledge/faqs`、快捷话术
  `/knowledge/shortcuts`；管理员可录入，坐席门店范围只读。
- **检索与建议**：`POST /retrieval/suggestions` 依据会话消息与门店知识库生成建议
  （确定性实现，provider 为 `none`），候选可直发/编辑后发送。
- **内容审核**：平台级策略 `/review/policy`、待审队列 `/review/queue`、通过
  `/review/approve` 沉淀可复用话术 `/review/phrases`。
- **报表与审计**：`/reports/summary`、`/reports/audit`。
- **保留策略**：确定性保留策略与到期清理结果由 `packages/core/src/platform/retention.ts`
  给出，经 `KefuStore.summarizeRetention` 从 `/reports/summary` 的 `retention` 字段返回；
  `packages/core/src/platform` 内含确定性领域模型与内存 KefuStore（含审计日志、
  review/approved-phrases、retention）。保留**不在 Worker**：Worker 只负责渠道出站投递
  （`apps/worker/src/outbox` 的 outbox 处理器）。
- **渠道接入（真实企业微信，默认）**：`GET /channels` 如实返回企业微信通道的
  `mode: "real"` 或 `mode: "disabled"`、能力清单、回调路径与连接探测结果。
  配置字段不复述 `WECOM_ENABLED`：`enableRequested` 只表示环境变量是否请求启用，
  `credentialsPresent` 才是对真实微信客服所需字段（含脱敏的 secret/token/aesKey 非空校验）
  的实际检查结果，二者都不会被解读为已建立真实连接。`realTransportConnected` 只有在成功
  取到 token 后才为 `true`；凭证不完整时通道状态为 `mode: "disabled"` 并由
  `missingCredentials` 列出缺失的变量名。企业微信的「接收事件服务器」只登记**一个 URL**，
  并在该 URL 上使用两种方法：`GET /channels/wecom/callback` 完成 URL 校验握手，
  `POST /channels/wecom/callback` 接收消息与事件；两条路径都返回 **200**
  （企业微信只把 200 当作「已接收」，201 会被判为失败并重试）。`POST /channels/wecom/webhook`
  保留为同一处理逻辑的别名，供已登记该路径的部署继续使用。平台自有的投递状态入口
  `POST /channels/wecom/status`（**需认证**，不是企业微信提供的匿名回调地址）、投递详情
  `GET /channels/deliveries/:id` 与重试 `POST /channels/deliveries/:id/retry` 均已可用；
  出站发送会在调用适配器前校验 48 小时 / 5 条回复预算，并记录投递状态、尝试次数与降级原因；
  工作台「外发提醒」读的就是这同一个窗口（会话详情的 `replyWindow`，按客户而非按会话计算）。
- **微信客服传输（`WECOM_TRANSPORT=real`）**：绑定微信客服
  （`/cgi-bin/kf/*`，**不是**群机器人 webhook）适配器，封装回调 `msg_signature` 校验、
  AES-256-CBC + PKCS#7 解密、XML 文本/图片/链接映射，以及经注入式 HTTP 客户端的
  `kf/send_msg` 发送（access_token 走缓存、认证失败只重放一次、其余失败稳定映射、不重试）。
  `kf_msg_or_event` 通知触发的 `kf/sync_msg` 游标拉取、回调到租户/门店的绑定解析、入向图片下载
  （`fetchMedia` → `media/get`）与临时图片上传（`media/upload`，`type=image`）**都已接线**。
  绑定行既可以由运维直接写入 `wecom_channel_bindings`，也可以由控制台「渠道接入」面板完成：
  保存凭证时会按 `corp_id` + `open_kfid` 复用或新建绑定，门店由平台自身的
  `resolveServingStore` 规则选定（面板不要求、也不允许操作者指定门店）。未绑定的客服账号一律以
  稳定的 `channel_not_configured` 拒绝，不会伪造消息或凭空指定租户。超出 `kf/sync_msg`
  拉取范围的历史消息能力仍未接线。
## 微信客服真实传输（默认）

`WECOM_TRANSPORT=real` 为默认值。即便真实适配器已绑定，**只有凭证齐全且真正取到 token 时**
才会联网；凭证不完整时通道保持 `disabled`，不会回退到模拟传输。

```bash
# 真实模式所需变量（缺任意一个 → GET /channels 返回 mode: "disabled"，
# 并在 missingCredentials 中列出缺失的变量名；不会退化为 Mock，也不会启动失败）
WECOM_TRANSPORT=real
WECOM_CORP_ID=<企业 corp id>
WECOM_KF_SECRET=<微信客服专用应用 secret>
WECOM_TOKEN=<回调 Token>
WECOM_AES_KEY=<43 位 EncodingAESKey>
WECOM_OPEN_KFID=<客服账号 open_kfid>

# 回调 URL 校验（GET）。签名正确时响应体就是解密后的 echostr 明文：
# text/plain、无 JSON 信封、无引号、无结尾换行；签名错误或时间戳/nonce 缺失
# 一律以平台的稳定错误信封拒绝。
curl -G http://localhost:3000/api/v1/channels/wecom/callback \
  --data-urlencode 'msg_signature=<sha1(sort(Token, timestamp, nonce, echostr))>' \
  --data-urlencode 'timestamp=<ts>' --data-urlencode 'nonce=<nonce>' \
  --data-urlencode 'echostr=<encrypted>'
```

要点：

- **真实回调验签**：回调入口
  `POST /channels/wecom/callback`（别名 `POST /channels/wecom/webhook`）与
  `POST /channels/wecom/status` 从原始请求体读取字节，真实传输用 query 参数
  `msg_signature`/`timestamp`/`nonce` 校验。控制台展示的回调 URL 就是
  `/api/v1/channels/wecom/callback` 这一条：企业微信要求校验与消息落在同一个地址，
  拆成两条路径会让登记无法通过。
- **凭证边界**：`WECOM_KF_SECRET` 是微信客服专用 secret，**不会**回退到 `WECOM_SECRET`
  / `WECOM_AGENT_ID`（自建应用凭证）；缺失时一切操作以 `channel_not_configured` 拒绝，
  且不发起任何 HTTP 请求。
- **只申明做得到的能力**：能力清单为
  `receiveText/receiveImage/sendText/sendLink/sendImage: true`。`sendImage` 之所以成立，
  是因为一条图片投递的两半都在：临时图片上传
  `POST /cgi-bin/media/upload?type=image`（multipart 字段 `media`，仅接受 `image/*`、非空
  且不超过 10 MB，access_token 与发送共用同一缓存与刷新策略，认证失败只重放一次），以及
  既有的 `msgtype: image` 发送（携带 provider 返回的 `media_id`）。入向图片的**下载**
  （`fetchMedia` → `media/get`）同样接线：客户发来的图片会被抓取并落到对象存储，
  抓取失败的图片不阻断消息本身，消息照常入库且 `media` 保持为空。
- **运维前置**：真实模式下一条回调或一次拉取能落到哪个租户/门店，取决于
  `wecom_channel_bindings` 中是否存在该客服账号的启用绑定。绑定行可由运维写入，
  也可由控制台的连接动作建立（保存凭证时复用或新建绑定，门店按平台的
  `resolveServingStore` 规则选定）；未绑定的账号以稳定的 `channel_not_configured` 拒绝。
- **状态入口不是企业微信回调**：`POST /channels/wecom/status` 是平台自有的、需要成员认证的
  入口，用于平台内部按事件 ID 幂等地记录投递状态；企业微信在本协议范围内并不提供该
  匿名状态回调，它也不会被当作回调对外开放。
- **明确不做的部分**：超出已接线 `kf/sync_msg` 游标拉取范围的历史消息能力，以及由控制台
  选择绑定门店的界面（门店按平台规则选定）。任何未接线的能力都以稳定的
  `channel_not_configured` / `channel_invalid_request` 拒绝，不返回伪造的成功。
- **测试不发真实请求**：单元测试通过注入的假 HTTP 客户端与内存 token 缓存覆盖
  缓存命中/过期刷新、认证失败单次重放与稳定错误映射；接口测试使用本地假凭证。

### 接入配置：控制台能做什么

控制台渠道页的「渠道接入」面板不是材料整理，而是真正的接入动作——**平台管理员**在面板里
录入五个字段（`WECOM_CORP_ID`、`WECOM_KF_SECRET`、`WECOM_TOKEN`、`WECOM_AES_KEY`、
`WECOM_OPEN_KFID`）并点击连接：

- 浏览器先做必填与 `WECOM_AES_KEY` 的 43 位校验，并展示回调 URL
  （`<origin>/api/v1/channels/wecom/callback`，即上面那条「同一个地址」）。
- `PUT /api/v1/channels/wecom/credentials` 把五个值**写入数据库**
  （`wecom_channel_credentials`，按绑定存储）并按 `corp_id` + `open_kfid` 复用或新建
  `wecom_channel_bindings` 绑定；门店由平台的 `resolveServingStore` 规则选定。
- 写入后用这套值**真实取一次 token**，把结论（`connected` 与否、失败原因、验证时间）
  存回并返回给面板。控制台存储的凭证**总是优先于环境变量**，不会回退。
- 面板同时显示部署侧的诊断：凭证缺失时列出缺失的变量名。（2026-10-08 起，
  `WECOM_TRANSPORT=mock` 的部署**不再**在面板上提示「填真值也连不到企业微信，需要改
  成 real 后重启」——那句已按用户要求删掉。换传输仍是连上企业微信的前置条件，见上文。）
- `POST /api/v1/channels/wecom/callback-selfcheck`（请求体 `{ url }`）返回自检结论：服务端用
  当前生效的凭据伪造一次企业微信的握手并请求该地址。**限平台超级管理员**，地址**只接受 HTTPS
  公网地址**（不接受内网、回环与 `169.254.169.254` 这类地址）、**不跟随跳转**、5 秒超时、响应体
  最多读 8KB。结论里的 `stage` 指出卡在哪一步；`ok:false` 也是 `200`，只有越权与缺参数才报错。

**人工接入的顺序（顺序错了会一直验证失败）**：

1. 部署 API、Worker 与 Web，确认 API 的 `/api/v1/health/ready` 为就绪（它同时探测 Worker）。
2. 用**平台超级管理员**登录控制台，在「渠道接入」把五项填好并点「保存并连接」，确认状态行为已连通
   （这一步把凭证写入库并当场换到 token）。
3. **在登记之前先自检一次**：把「公网回调 URL（自检用）」改成你要登记的那个地址，点「自检回调地址」。
   服务端会拿第 2 步保存的凭据，按企业微信的方式请求这个地址并校验它是否原样返回明文——这正是
   企业微信登记时会做的那一次校验。看到「通过」再往下走；没通过时结果会指出卡在哪一步
   （地址不可用 / 没有可用凭据 / 请求发不出去 / 状态码不是 200 / 回的不是明文）。
4. **然后**再去企业微信后台登记回调 URL，登记值取自控制台显示的那一条。登记那一刻企业微信会
   立刻请求该地址做校验，校验用的正是第 2 步保存的 `WECOM_TOKEN` 与 `WECOM_AES_KEY` ——
   所以**不能先登记后填凭证**，没凭证时校验必然失败，且企业微信不会保存这个地址。
5. 用真实客户身份发一条消息，确认控制台收到会话与消息。

第 4 步的地址必须是**企业微信能访问到的公网 HTTPS 地址**。控制台显示的地址取自你打开控制台时
的站点 origin，所以**从内网地址打开控制台时显示的不是该登记的那一个**——请在公网域名下打开，
或按实际公网地址登记（第 3 步的自检框就是用来试这个地址的，只接受 HTTPS 公网地址）。绑定的门店由
服务端的 `resolveServingStore` 规则选定（当前是启用坐席最多的那个门店，没有启用门店时创建一个
默认门店），控制台上没有「选门店」这一步。

**自检通过说明什么**：这个地址上有一个持有本部署凭据的部署，能按企业微信的格式在超时内完成握手。
它**不**证明企业微信的网络一定能到那个地址（内网地址会被自检的公网规则直接拒绝，而不是被探测），
也**不**证明名字后面挂的就是本部署（前面若有反向代理，代理对谁都答同一句话）。自检会由服务器向该
地址发起一次真实的外部请求，因此只对平台超级管理员开放。

**已知边界**：凭证在库中是明文存储（见迁移 0017 的说明）；`WECOM_ENABLED` 不控制任何行为，
只作为 `enableRequested` 上报；「真实账号注册回调 URL 并完成端到端联调」仍需在部署环境
用真实企业微信账号完成，本仓库的自动化测试不发真实网络请求。

## 日志与脱敏

API 与 Worker 使用结构化 JSON logger。日志字段、`Error` 与错误 details 会经过递归脱敏：

- 敏感 key（`password`、`token`、`authorization`、连接串等）与 `Bearer` token 会被替换；
- `Error` 只保留 `name` 与脱敏后的 `message`，`stack` 替换为占位符；
- 循环引用、抛错 getter、`bigint`/`symbol`/`function`/`undefined` 与超过最大深度的对象
  都被安全投影，不会导致序列化崩溃。

## 部署：API 与 Worker 常驻运行

`docker compose up -d` **只启动基础设施**（PostgreSQL、Redis、MinIO），不启动 API，也不启动
Worker。部署到服务器时，三者要一起在运行，缺一不可：

- **API**：HTTP 入口，也是出站回复的**第一次**发送者——客服发消息时它内联调用企业微信。
- **Worker**：渠道 outbox 的重试者。第一次发送失败或结果未知的消息留在 `pending`，**只有
  Worker 会再试**；Worker 不运行时这些消息永远不会被重发。它同时跑导出、知识来源扫描与
  向量化扫描，并对外提供 `/health/live`、`/health/ready`。

两者都从**仓库根目录**的 `.env` 读取配置（Worker 通过 `resolveRepositoryEnvPath` 定位，没有
`apps/.env` 这一层），所以部署机上放一份 `.env`（`APP_ENV=production` 与真实凭证）即可。

```bash
npm ci
npm run build          # 构建 packages 与全部应用
npm run db:migrate     # 应用迁移（含 0017 的凭证表）
npm run db:seed        # 首次部署写入初始账号（按需）
```

用 systemd 让两个进程常驻（`/etc/systemd/system/kefu-api.service`）：

```ini
[Unit]
Description=kefu-saas API
After=network-online.target

[Service]
WorkingDirectory=/srv/AI-Customer-Survice
ExecStart=/usr/bin/node apps/api/dist/main.js
Restart=always
RestartSec=3
# 运行环境由仓库根目录的 .env 提供（APP_ENV=production 等），这里不重复设置。

[Install]
WantedBy=multi-user.target
```

Worker 用同样的单元，把 `ExecStart` 换成 `apps/worker/dist/main.js`、`Description` 改成
`kefu-saas Worker`（文件名 `kefu-worker.service`）：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kefu-api kefu-worker
```

**部署自检**：

```bash
curl -fsS http://127.0.0.1:3000/api/v1/health/ready   # API 就绪（其 readiness 会探测 Worker）
curl -fsS http://127.0.0.1:3001/health/ready          # Worker 就绪：所有循环都在跑
```

`/api/v1/health/ready` 探测的是 Worker 的 health server；Worker 没起来时 API 会如实报未就绪，
而不是假装健康。outbox 的每条消息都由**租约**认领后才发送，所以 Worker 重启、或短暂出现两个
Worker 进程，都不会让同一条回复被发出两次。

## Worker 优雅停止

Worker 收到 `SIGTERM`/`SIGINT` 后，先完全关闭 health server，再关闭 Nest context；任一步
出错都会被记录并反映在退出码中。

## 质量命令

```bash
npm run format:check   # Prettier 检查
npm run lint           # ESLint
npm run typecheck      # 全仓 TypeScript 类型检查
npm test               # 单元 + 接口测试（vitest）
npm run test:unit      # 仅单元测试
npm run test:interface # 仅接口/e2e 测试
npm run compose:check  # 离线校验 docker-compose.yml 结构（无需 Docker CLI）
```

> `docker compose up -d` 需要 Docker CLI 与正在运行的 Docker 引擎；本仓库的测试不要求
> 任何外部服务在线。

## 数据库：在线与离线校验

运行中的 PostgreSQL 只由两类命令需要：**在线迁移/就绪命令**要求 `DATABASE_URL` 指向可达的
PostgreSQL（本地通常先 `docker compose up -d`）；**离线质量命令**（format/lint/typecheck/
test/compose:check）不连接数据库，测试在无任何外部服务时也能通过。

```bash
npm run db:migrate     # 应用 pending 迁移（需 DATABASE_URL 与运行中的 PostgreSQL）
npm run db:rollback    # 回滚最近一次迁移
npm run db:status      # 查看已应用/待应用迁移
npm run db:check       # 只读 schema 冒烟检查：vector 扩展、schema_migrations 与核心平台表
npm run db:seed        # 幂等写入开发种子数据（目录 fixtures + 本地管理员账号）
npm run db:seed:demo   # 可选：写入演示会话、消息与外发回复窗口，让工作台有可打开的会话
npm run db:seed:demo:knowledge   # 可选：写入演示话术库与商品库，让智能辅助有内容可检索
```

`db:seed` 在**单个事务**内先写入与内存 store 一致的目录 fixtures（2 个租户、3 家门店、
6 个成员及其门店范围），随后写入本地管理员账号：用户名 `admin`、固定账号 ID
`user-platform-admin`、已验证的密码身份，以及指向平台成员 `u-platform-admin` 的有效链接。
密码以与领域哈希器相同格式的 scrypt 编码存储（`npm run db:seed` 的输出与数据库中都不会出现
明文）。所有写入都是 `ON CONFLICT DO NOTHING`，因此可重复执行：第二次运行报告
`0 inserted`，并且**不会**重置已写入的密码或其时间戳。若固定身份已被别的行占用（例如
`admin` 用户名已被其他账号使用、密码身份属于另一个账号、`u-platform-admin` 已链接到其他
账号），种子会以清晰的非敏感诊断信息失败并回滚整个事务，而不会静默接管。

`db:seed:demo` 是**可选**的演示数据：会话在真实系统里由企业微信渠道回调创建，本机没有绑定
好的渠道账号，因此 `db:seed` 之后工作台的「我的会话」和买家联系人都没有内容可打开。该命令把
`apps/web/src/mock-data.js` 里的演示客户写进演示租户 `tenant-acme`、门店
`store-acme-flagship` 和坐席 `u-t1-agent-2`（账号 `agent01`）：5 条会话（4 条接待中、1 条已结束）
与 10 条消息，客户名与演示前端里的买家一致，因此「点买家姓名 → 打开该客户会话」这条路径在本地
可用。它还会为每位演示客户写一行 `send_quota_windows`——客户最近一条入向消息开启的 48 小时回复
窗口，也就是工作台「外发提醒」读的那份数据（`GET /conversations/:id` 的 `replyWindow`）；这些消息
没走过渠道回调，不补这一行的话提醒会显示「窗口未开启」，而对话记录明明是从客户开口开始的。
窗口按同一份对话记录推算：最近一条入向消息是开启时刻，其后的客服回复是已用掉的额度。它
**不属于** `db:seed`，也不被任何测试调用——本机 e2e 测试使用同一个数据库。幂等
（固定 ID + `ON CONFLICT DO NOTHING`）；撤销用
`npm run seed:demo --workspace @kefu/database -- --undo`（只删这几条会话，消息随外键级联删除，
回复窗口一并删除——它对会话没有外键，不会自己消失；
`db:prune` 清的是另一件事，不能用来撤销这批数据）。

`db:seed:demo:knowledge` 是同一类**可选**演示数据的另一半：`db:seed` 与 `db:seed:demo` 都不写
任何话术库或商品库行，因此智能辅助的两条检索腿在新库上没有可检索内容。该命令向演示租户与门店写入
2 条 FAQ、1 条快捷话术，以及 1 个商品（`product_spus`）和它的 2 个规格（`product_skus`，含「米白」
与「黑色」）；措辞刻意对齐演示会话里客户的原话，使智能辅助同时可演示「话术库命中即直出、不调用模型」
与「话术库未命中则回退商品库」。商品必须落在 `product_spus` / `product_skus`：兼容读的 `products`
表**不参与索引**，只放那里的商品既拿不到召回证据、又不可能靠整句字面命中被引擎选中。撤销用
`npm run seed:demo:knowledge --workspace @kefu/database -- --undo`。Worker 的**知识来源扫描不依赖嵌入
provider**，所以本机未配置任何模型时也会写出切片与 BM25 词项，「话术库优先」这条路径仍然可用。

撤销会**连它产生的知识切片一起删**，这一步不能省：切片对来源行没有外键，Worker 的规则是「来源行被删掉
的切片留在索引里不动」（`knowledge-index-lifecycle.integration.spec.ts` 明确钉住了这个行为），于是两个
e2e 套件把整张切片表当成「上次跑完必须为空」来断言（`retrieval-overreach`、`knowledge-index-status`）。
因此**跑 `npm test` 之前先 `--undo`**：留着这批演示数据，这两个套件会以「knowledge_chunks already holds
rows for tenant-acme」失败，而那是演示数据而不是代码问题。

`db:check` 只执行 `SELECT`，可对已迁移数据库重复运行（幂等、不改动任何 schema）：它校验
`vector`（pgvector）扩展、迁移记录表 `schema_migrations` 以及 `database/migrations`
中各 `.up.sql` 声明的全部业务表是否真实存在；连接串不会打印到日志。缺少运行中的数据库时该
命令以非零码退出，属环境缺失而非代码缺陷。

同样的边界适用于 API 的 `GET /api/v1/health/ready`：PostgreSQL 探针复用 API 进程内的连接池
边界，只有真实执行参数无关的 `SELECT 1` 成功后才上报 `ok`；无数据库时返回 503，不会误报 ready。

迁移文件位于 `database/migrations`：`0001` 启用 `vector`（pgvector）扩展；`0002` 镜像
`packages/core/src/platform` 领域模型（tenants/stores/members/conversations/messages、
products/faqs/shortcuts、suggestion_sets、review_policy/approved_phrases、audit_log、
retention_policies）；同一文件还建了 `jobs` 表，但内存 KefuStore 没有对应实现，
该表目前无写入方。MVP 以内存 KefuStore 为运行时实现，PostgreSQL 用于后续持久化接入。

## 本地工作台演示会话

`database/scripts/seed-workspace-demo.cjs` 可补入 4 条处理中、1 条已结束的演示会话、21 条消息和 6 条预置分配记录，让登录后的工作台通过真实 API 展示界面。数据属于云集服饰旗舰店，分配给客服小蓝（账号 `agent01`）；管理员也可查看。标题带“（演示）”，首条消息标注非真实客户，固定 ID 前缀为 `demo-workspace-v1-`。

```powershell
node database/scripts/seed-workspace-demo.cjs          # 仅预览
node database/scripts/seed-workspace-demo.cjs --apply  # 写入演示数据
```

仅允许 `APP_ENV=local` 和本机 PostgreSQL。写入在单个事务中完成；再次执行跳过已有演示会话，保留用户后续回复、转接和结束，不覆盖真实数据或账号配置。脚本不改变前后端业务代码、数据库结构或渠道配置。

写入后刷新网页，使用 `agent01 / Agent123456` 登录并选择“公司全部门店”或“云集服饰旗舰店”；点击会话读取聊天详情。“已结束”页签中的条目只读。候选回复走服务端检索链路（已接 DeepSeek 生成与本地 Ollama 语义检索；模型或嵌入未配置时写降级原因）。

此脚本只建立历史记录，不创建渠道回调、发送窗口、外发任务或虚假的在线员工。当前没有演示客户的发送窗口，不能据此验证真实微信发送；转接需另一个符合服务端条件的在线客服。预置分配历史也不代表已经验证自动派单或转接执行。工作台外发额度提醒、客户信息及部分指标仍有原型固定内容，应以服务端事实为准。本地数据库数据不随 Git 提交上传，可在其他本地环境运行脚本重新创建。
