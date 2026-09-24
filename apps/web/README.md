# 栖点客服前端界面（整合副本）

本目录在保留原界面结构的基础上，已经接入 `../api` 的首轮真实链路。整合范围与启动方式见仓库根目录 `MERGE-NOTES.md`。

电商智能客服 SaaS 的 MVP 界面。以人工客服工作台为中心，AI 提供候选话术，客服确认或编辑后发送。

## 查看

在项目目录运行：

```powershell
npm run dev
```

然后打开 `http://127.0.0.1:5173`。需要本机有 Node.js，但无需安装项目依赖或启动业务后端。如果 PowerShell 阻止执行 `npm`，可直接运行 `node server.js`。页面里的会话、商品和报表均为模拟数据。页面结构拆分在 `pages/`，浏览器直接打开 `index.html` 时无法加载这些片段。

## 服务器部署目标

正式部署时，由服务器上的静态文件服务提供 `index.html`、`styles.css`、`pages/` 和 `src/`。目前这些资源使用相对路径，在网站根目录或以 `/app/` 这类带末尾斜杠的子路径发布都可以；服务器应允许浏览器请求 `pages/*.html`。`server.js` 仅供本地开发，不需要作为正式服务器长期运行。

部署后用户访问的是服务器的域名和 HTTPS 地址，其他电脑能否访问取决于服务器网络与访问权限。接入后端时，再通过同域名下的 API 路径或服务器反向代理连接业务服务；目前页面仍是模拟数据，账号、权限和消息发送也没有真实后端能力。具体服务器、域名和后端地址确定后再添加对应部署配置。

## 目录

```text
Frontend/
├─ index.html                 导航、顶部栏与共用弹窗
├─ pages/                     各页面独立 HTML 片段
├─ server.js                  本地静态服务
├─ package.json               npm run dev 命令
├─ styles.css                 视觉样式与响应式布局
├─ src/
│  ├─ mock-data.js            演示数据
│  ├─ load-pages.js           页面片段加载与脚本初始化
│  ├─ app.js                  页面交互
│  ├─ admin-data.js           管理员中心演示数据
│  └─ admin.js                管理员中心交互
├─ docs/backend-integration.md  前后端对接清单
├─ function.md               页面模块与功能清单
└─ AGENTS.md                  界面地图和修改约定
```

## 基础检查

```powershell
node --check src/app.js
node --check src/mock-data.js
```

此原型不包含真实企业微信连接、模型调用、数据持久化或权限鉴权。接口边界见 `docs/backend-integration.md`。
