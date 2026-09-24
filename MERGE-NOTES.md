# AI Customer Service 初次整合说明

本目录是独立整合副本，源目录 `D:\vscode\Frontend` 与 `D:\vscode\End` 不参与运行时写入。

## 代码来源

- 后端、Worker、数据库、共享包、测试与 Docker 配置来自 `D:\vscode\End`。
- `apps/web` 来自 `D:\vscode\Frontend`，没有采用 `End/apps/web` 的 React 页面代码。
- `apps/web/server.js` 在静态服务之外增加 `/api/*` 同源反向代理，默认转发到 `http://127.0.0.1:3000`。

## 首轮已经接通

- 后端账号密码登录、会话恢复与退出。
- 后端账号资料和角色映射。
- 坐席在线、挂起、离线状态及在线心跳。
- 真实会话列表、详情和消息记录。
- 文本消息发送与结束会话。
- 登录页和顶栏显示后端连接状态。
- 统一知识库：商品、常见问题和公司快捷话术读取真实后端；管理员可新增、编辑、启停及批量导入，客服只读。

独立商品库、个人快捷短语、报表、设置和平台管理页面仍保留部分前端原型交互，等待下一轮逐页替换。真实会话模式不会显示模拟 AI 候选，也不会把附件当成已经发往后端。

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
- 平台管理员：`admin / Admin123456`

如端口被占用，可以给 Web 进程设置 `WEB_PORT`，给代理设置 `API_PROXY_TARGET`。
