/**
 * 加载独立页面片段后再启动交互脚本。
 * 现有 app.js / admin.js 在执行时直接查找 DOM，因此必须等待所有片段插入。
 */
(async function boot() {
  const pageIds = [
    'workspace', 'products', 'knowledge', 'phrases', 'analytics',
    'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'
  ];
  const root = document.getElementById('page-root');

  try {
    if (location.protocol === 'file:') {
      throw new Error('请通过本地开发服务或已部署的网站地址访问；本地开发可运行 npm run dev');
    }

    // 并行读取片段，按导航顺序插入；任一片段失败时不启动依赖完整 DOM 的脚本。
    const pages = await Promise.all(pageIds.map(async id => {
      const response = await fetch(`pages/${id}.html`);
      if (!response.ok) throw new Error(`页面 ${id} 加载失败（HTTP ${response.status}）`);
      return response.text();
    }));
    root.innerHTML = pages.join('\n');

    for (const src of ['src/api-client.js', 'src/realtime.js', 'src/mock-data.js', 'src/admin-data.js', 'src/exports.js', 'src/catalog.js', 'src/faq-variants.js', 'src/app.js', 'src/admin.js']) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`脚本 ${src} 加载失败`));
        document.body.appendChild(script);
      });
    }
  } catch (error) {
    root.innerHTML = '';
    const message = document.createElement('div');
    message.className = 'page-load-error';
    message.textContent = error.message;
    root.appendChild(message);
    console.error(error);
  }
})();
