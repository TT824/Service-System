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

# 4. 应用迁移并写入种子数据（含本地管理员账号 admin / Admin123456）
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

打开 http://localhost:5173 可看到**客服内核操作控制台**（多视图 Web Shell）：会话工作台、知识库、内容审核、报表与审计、渠道接入（真实企业微信接入配置与状态）、组织与租户目录、账户与权限。控制台需要登录：使用上一步种子写入的本地管理员凭据 `admin` / `Admin123456`（见「登录与访问模型」）。

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
  -d '{ "username": "admin", "password": "Admin123456" }'
# → { request_id, data: { token, expires_at, session, access }, meta }
#    其中 access.accessState 为 "active"，access.role 为 "platform_admin"

# 用该 token 访问需要身份的接口
export TOKEN='<上一步返回的 token>'
curl http://localhost:3000/api/v1/auth/session -H "authorization: Bearer $TOKEN"
curl http://localhost:3000/api/v1/admin/accounts -H "authorization: Bearer $TOKEN"
```

**本地种子凭据**：`npm run db:seed` 会写入账号 `admin` / 密码 `Admin123456`
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
  `missingCredentials` 列出缺失的变量名。入向回调 `POST /channels/wecom/webhook`、
  URL 校验 `GET /channels/wecom/callback`、平台自有的投递状态入口
  `POST /channels/wecom/status`（**需认证**，不是企业微信提供的匿名回调地址）、投递详情
  `GET /channels/deliveries/:id` 与重试 `POST /channels/deliveries/:id/retry` 均已可用；
  出站发送会在调用适配器前校验 48 小时 / 5 条回复预算，并记录投递状态、尝试次数与降级原因。
- **微信客服传输（`WECOM_TRANSPORT=real`）**：绑定微信客服
  （`/cgi-bin/kf/*`，**不是**群机器人 webhook）适配器，封装回调 `msg_signature` 校验、
  AES-256-CBC + PKCS#7 解密、XML 文本/图片/链接映射，以及经注入式 HTTP 客户端的
  `kf/send_msg` 发送（access_token 走缓存、认证失败只重放一次、其余失败稳定映射、不重试）。
  `kf_msg_or_event` 通知触发的 `kf/sync_msg` 游标拉取、回调到租户/门店的绑定解析与临时图片上传（`media/upload`，
  `type=image`）**都已接线**；但**绑定行必须由运维预先写入** `wecom_channel_bindings`
  （本仓库不提供绑定管理界面或接口），未绑定的客服账号一律以稳定的
  `channel_not_configured` 拒绝，不会伪造消息或凭空指定租户。媒体下载（`fetchMedia`）与
  超出 `kf/sync_msg` 拉取范围的历史消息能力仍未接线。
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

- **真实回调验签**：回调入口不变，
  `POST /channels/wecom/webhook` 与 `POST /channels/wecom/status` 从原始请求体读取字节，
  真实传输用 query 参数 `msg_signature`/`timestamp`/`nonce` 校验。
- **凭证边界**：`WECOM_KF_SECRET` 是微信客服专用 secret，**不会**回退到 `WECOM_SECRET`
  / `WECOM_AGENT_ID`（自建应用凭证）；缺失时一切操作以 `channel_not_configured` 拒绝，
  且不发起任何 HTTP 请求。
- **只申明做得到的能力**：能力清单为
  `receiveText/receiveImage/sendText/sendLink/sendImage: true`。`sendImage` 之所以成立，
  是因为一条图片投递的两半都在：临时图片上传
  `POST /cgi-bin/media/upload?type=image`（multipart 字段 `media`，仅接受 `image/*`、非空
  且不超过 10 MB，access_token 与发送共用同一缓存与刷新策略，认证失败只重放一次），以及
  既有的 `msgtype: image` 发送（携带 provider 返回的 `media_id`）。媒体**下载**仍未接线。
- **运维前置**：真实模式下一条回调或一次拉取能落到哪个租户/门店，取决于
  `wecom_channel_bindings` 中是否存在该客服账号的启用绑定。本仓库不提供绑定管理界面或
  接口，绑定行需由运维写入；未绑定的账号以稳定的 `channel_not_configured` 拒绝。
- **状态入口不是企业微信回调**：`POST /channels/wecom/status` 是平台自有的、需要成员认证的
  入口，用于平台内部按事件 ID 幂等地记录投递状态；企业微信在本协议范围内并不提供该
  匿名状态回调，它也不会被当作回调对外开放。
- **明确不做的部分**：媒体下载（`fetchMedia`）、绑定管理界面/接口，以及超出已接线
  `kf/sync_msg` 游标拉取范围的历史消息能力；任何未接线的能力都以稳定的
  `channel_not_configured` / `channel_invalid_request` 拒绝，不返回伪造的成功。
- **测试不发真实请求**：单元测试通过注入的假 HTTP 客户端与内存 token 缓存覆盖
  缓存命中/过期刷新、认证失败单次重放与稳定错误映射；接口测试使用本地假凭证。

### 接入配置：P0 与 P1 的边界

控制台渠道页提供「企业微信接入配置」面板，它是**材料整理**而不是**接入**：

- **P0（已提供）**：在前端录入五个基础字段（`WECOM_CORP_ID`、`WECOM_KF_SECRET`、
  `WECOM_TOKEN`、`WECOM_AES_KEY`、`WECOM_OPEN_KFID`），在浏览器内完成必填校验与
  `WECOM_AES_KEY` 的 43 位校验，并只生成含非敏感值（CorpID、OpenKfId）与两个端点
  （回调 URL、入向消息回调 URL）的本地摘要。三个凭证字段在摘要中一律显示为「已填写」。
  面板不保存凭证、不写入任何存储、不发起网络请求，也不建立真实连接；真实接入以服务端
  环境变量、绑定行与连接探测结果为准。
- **P1（未提供）**：凭证持久化（把面板填写的内容写入数据库或密钥管理并落到环境变量）、
  由控制台发起的 token 探测/连通性测试、以及真实回调集成（用真实企业微信账号注册回调 URL
  并完成端到端联调）仍属 P1；本仓库不提供这些界面或接口。服务端已有的连接探测只以
  `GET /api/v1/channels` 为入口，控制台不额外发起探测。

## 日志与脱敏

API 与 Worker 使用结构化 JSON logger。日志字段、`Error` 与错误 details 会经过递归脱敏：

- 敏感 key（`password`、`token`、`authorization`、连接串等）与 `Bearer` token 会被替换；
- `Error` 只保留 `name` 与脱敏后的 `message`，`stack` 替换为占位符；
- 循环引用、抛错 getter、`bigint`/`symbol`/`function`/`undefined` 与超过最大深度的对象
  都被安全投影，不会导致序列化崩溃。

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
```

`db:seed` 在**单个事务**内先写入与内存 store 一致的目录 fixtures（2 个租户、3 家门店、
6 个成员及其门店范围），随后写入本地管理员账号：用户名 `admin`、固定账号 ID
`user-platform-admin`、已验证的密码身份，以及指向平台成员 `u-platform-admin` 的有效链接。
密码以与领域哈希器相同格式的 scrypt 编码存储（`npm run db:seed` 的输出与数据库中都不会出现
明文）。所有写入都是 `ON CONFLICT DO NOTHING`，因此可重复执行：第二次运行报告
`0 inserted`，并且**不会**重置已写入的密码或其时间戳。若固定身份已被别的行占用（例如
`admin` 用户名已被其他账号使用、密码身份属于另一个账号、`u-platform-admin` 已链接到其他
账号），种子会以清晰的非敏感诊断信息失败并回滚整个事务，而不会静默接管。

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
