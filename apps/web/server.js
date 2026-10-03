/** 无依赖的本地静态服务，并把 /api 反向代理到 Nest API。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.WEB_PORT || 5173);
// 与后端共享本地端口配置，避免代理误连占用 3000 的其他桌面应用。
const envPath = path.resolve(root, '../../.env');
const configuredPort = fs.existsSync(envPath) ? /^API_PORT\s*=\s*(\d+)\s*$/m.exec(fs.readFileSync(envPath, 'utf8'))?.[1] : null;
const apiTarget = new URL(process.env.API_PROXY_TARGET || `http://127.0.0.1:${process.env.API_PORT || configuredPort || 3000}`);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function proxyApi(request, response) {
  const headers = { ...request.headers, host: apiTarget.host };
  delete headers['content-length'];
  const upstream = http.request({
    protocol: apiTarget.protocol,
    hostname: apiTarget.hostname,
    port: apiTarget.port,
    method: request.method,
    path: request.url,
    headers,
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    response.flushHeaders();
    response.on('close', () => upstreamResponse.destroy());
    upstreamResponse.pipe(response);
  });
  upstream.on('error', error => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ code: 'api_unavailable', message: `业务后端不可用：${error.message}` }));
  });
  request.pipe(upstream);
}

http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    proxyApi(request, response);
    return;
  }

  const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    response.writeHead(200, {
      'content-type': types[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(content);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Merged frontend: http://127.0.0.1:${port}`);
  console.log(`API proxy: ${apiTarget.origin}`);
});
