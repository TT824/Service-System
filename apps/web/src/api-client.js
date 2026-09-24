/**
 * 浏览器端 API 适配层。
 *
 * 这个文件只负责 HTTP、会话令牌和后端字段，不参与页面渲染。开发服务器把
 * `/api/*` 反向代理到 Nest API，因此浏览器始终使用同源请求。
 */
(function exposeApiClient() {
  const TOKEN_KEY = 'kefu.access-token';

  class ApiError extends Error {
    constructor(status, code, message, details = []) {
      super(message || `请求失败（HTTP ${status}）`);
      this.name = 'ApiError';
      this.status = status;
      this.code = code || 'unknown_error';
      this.details = Array.isArray(details) ? details : [];
    }
  }

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
  }

  async function request(path, options = {}) {
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    const accessToken = token();
    if (options.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (options.tenantId) headers['x-tenant-id'] = options.tenantId;

    let body;
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        // 让浏览器为 multipart 请求生成带 boundary 的 Content-Type。
        body = options.body;
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
    }

    const response = await fetch(`/api/v1${path}`, {
      method: options.method || 'GET',
      headers,
      body,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && options.auth !== false) clearToken();
      throw new ApiError(
        response.status,
        payload?.code,
        payload?.message || `请求失败（HTTP ${response.status}）`,
        payload?.details,
      );
    }
    return payload?.data;
  }

  async function login(username, password) {
    const issued = await request('/auth/login/password', {
      method: 'POST',
      auth: false,
      body: { username, password },
    });
    if (!issued?.token) throw new ApiError(502, 'malformed_response', '登录响应缺少访问令牌');
    sessionStorage.setItem(TOKEN_KEY, issued.token);
    return issued;
  }

  async function logout() {
    try {
      if (token()) await request('/auth/logout', { method: 'POST', body: { all_sessions: false } });
    } finally {
      clearToken();
    }
  }

  function productImport(file, storeId, tenantId, mode) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('storeId', storeId);
    return request(`/knowledge/import-batches/${mode}`, {
      method: 'POST',
      body: form,
      tenantId,
    });
  }

  window.KefuApi = Object.freeze({
    ApiError,
    hasSession: () => Boolean(token()),
    clearToken,
    health: () => request('/health/ready', { auth: false }),
    login,
    logout,
    currentSession: () => request('/auth/session'),
    directoryTenants: () => request('/directory/tenants'),
    knowledgeProducts: tenantId => request('/knowledge/products', { tenantId }),
    knowledgeFaqs: tenantId => request('/knowledge/faqs', { tenantId }),
    knowledgeShortcuts: tenantId => request('/knowledge/shortcuts', { tenantId }),
    createKnowledgeProduct: (tenantId, input) => request('/knowledge/products', {
      method: 'POST', tenantId, body: input,
    }),
    updateKnowledgeProduct: (tenantId, id, patch) => request(`/knowledge/products/${encodeURIComponent(id)}`, {
      method: 'PATCH', tenantId, body: patch,
    }),
    createKnowledgeFaq: (tenantId, input) => request('/knowledge/faqs', {
      method: 'POST', tenantId, body: input,
    }),
    updateKnowledgeFaq: (tenantId, id, patch) => request(`/knowledge/faqs/${encodeURIComponent(id)}`, {
      method: 'PATCH', tenantId, body: patch,
    }),
    createKnowledgeShortcut: (tenantId, input) => request('/knowledge/shortcuts', {
      method: 'POST', tenantId, body: input,
    }),
    updateKnowledgeShortcut: (tenantId, id, patch) => request(`/knowledge/shortcuts/${encodeURIComponent(id)}`, {
      method: 'PATCH', tenantId, body: patch,
    }),
    previewKnowledgeImport: (tenantId, storeId, file) => productImport(file, storeId, tenantId, 'preview'),
    applyKnowledgeImport: (tenantId, storeId, file) => productImport(file, storeId, tenantId, 'apply'),
    conversations: () => request('/conversations'),
    conversation: id => request(`/conversations/${encodeURIComponent(id)}`),
    sendMessage: (id, content, source) => request(`/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: {
        content,
        source,
        dedupKey: `frontend-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      },
    }),
    closeConversation: (id, version) => request(`/conversations/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      body: { expectedVersion: version },
    }),
    presence: status => request('/assignment/presence', { method: 'PUT', body: { status } }),
    heartbeat: () => request('/assignment/presence/heartbeat', { method: 'POST' }),
  });
})();
