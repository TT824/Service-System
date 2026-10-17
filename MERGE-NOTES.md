# AI Customer Service 初次整合说明

本目录是独立整合副本，源目录 `D:\vscode\Frontend` 与 `D:\vscode\End` 不参与运行时写入。

## 代码来源

- 后端、Worker、数据库、共享包、测试与 Docker 配置来自 `D:\vscode\End`。
- `apps/web` 来自 `D:\vscode\Frontend`，没有采用 `End/apps/web` 的 React 页面代码。
- `apps/web/server.js` 提供 `/api/*` 同源反向代理，读取根 `.env` 的 API_PORT，API_PROXY_TARGET 可覆盖；当前本机 API 使用 3000（曾为避免与占用 3000 的微信小店助手冲突改用 3002）、Worker 3001、Web 5173。

## 首轮已经接通

- 后端账号密码登录、会话恢复与退出。
- 后端账号资料和角色映射。
- 坐席在线、挂起、离线状态及在线心跳。
- 真实会话列表、详情和消息记录。
- 文本消息发送与结束会话。
- 登录页和顶栏显示后端连接状态。
- 统一知识库：商品、常见问题和公司快捷话术读取真实后端；管理员可新增、编辑、启停及批量导入，客服只读。
- 数据导出：创建顾客 / 单会话导出、任务状态查询、Excel / 对话记录下载入口已接真实接口，实际产物完整验证仍待完成。
- AI 候选与来源详情、真实转接、分配历史、SSE 更新及断线补读已接通，接口和交互测试通过，实际客户会话端到端验证仍待完成。

独立商品库、个人快捷短语、报表、设置和管理员配置仍保留部分前端原型交互。真实会话使用后端候选（已接 DeepSeek 生成与本地嵌入语义检索，未配置时显示降级原因）。会话附件与内部会话附件均已接通后端，不再是本地草稿。

## 持续维护入口

- [项目变更记录](CHANGELOG.md)：每轮记录变更时间、内容、涉及范围、验证及 Git 状态。
- [前后端差异报告](FRONTEND-BACKEND-DIFF.md)：同步更新已接通、部分接通、未接通及契约待补的现状。
- [维护约定](AGENTS.md)：前后端每轮修改都要同步维护上述记录，原始两个代码目录不修改。

## 启动

先启动基础设施并完成数据库迁移和种子：

```powershell
docker compose up -d
npm run db:migrate
npm run db:seed
```

分别启动三个进程：

```powershell
npm run dev:api
npm run dev:worker
npm run dev:web
```

浏览器访问 `http://127.0.0.1:5173`。本地演示账号：

- 坐席：`agent01 / Agent123456`
- 平台管理员：`admin`（README 里记的 `Admin123456` 已在 2026-10-05 改密后失效，`db:seed` 是 `ON CONFLICT DO NOTHING`，重跑不会改回来；日常登录用种子客服 `agent01 / Agent123456`）

如端口被占用，可以给 Web 进程设置 `WEB_PORT`，给代理设置 `API_PROXY_TARGET`。
