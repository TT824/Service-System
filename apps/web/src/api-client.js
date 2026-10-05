/**
 * 浏览器端 API 适配层。
 *
 * 这个文件只负责 HTTP、会话令牌和后端字段，不参与页面渲染。开发服务器把
 * `/api/*` 反向代理到 Nest API，因此浏览器始终使用同源请求。
 */
(function exposeApiClient() {
  const TOKEN_KEY = 'kefu.access-token';
  let workspaceTenantId = '';

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
    workspaceTenantId = '';
  }

  async function request(path, options = {}) {
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    const accessToken = token();
    if (options.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (options.tenantId || workspaceTenantId) headers['x-tenant-id'] = options.tenantId || workspaceTenantId;

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
      if (response.status === 401 && options.auth !== false) {
        clearToken();
        if (window.Event && window.dispatchEvent) window.dispatchEvent(new window.Event('kefu:session-expired'));
      }
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
    setWorkspaceTenant: id => { workspaceTenantId = id || ''; },
    workspaceTenant: () => workspaceTenantId,
    suggestions: id => request('/retrieval/suggestions', { method: 'POST', body: { conversationId: id, limit: 3 } }),
    suggestionDetail: id => request(`/retrieval/suggestions/${encodeURIComponent(id)}`),
    transferTargets: id => request(`/conversations/${encodeURIComponent(id)}/transfer-targets`),
    assignments: id => request(`/conversations/${encodeURIComponent(id)}/assignments`),
    transferConversation: (id, version, toMemberId) => request(`/conversations/${encodeURIComponent(id)}/transfer`, {
      method: 'POST', body: { expectedVersion: version, toMemberId },
    }),
    realtimeResponse: (signal, reconnect) => fetch(`/api/v1/realtime${reconnect ? '?reconnect=true' : ''}`, {
      signal, headers: { accept: 'text/event-stream', authorization: `Bearer ${token()}`, 'x-tenant-id': workspaceTenantId },
    }),
    exportJobs: tenantId => request('/exports', { tenantId }),
    createExport: (tenantId, input) => request('/exports', { method: 'POST', tenantId, body: input }),
    exportConversations: tenantId => request('/conversations', { tenantId }),
    downloadExport: async (tenantId, id, format) => {
      const response = await fetch(`/api/v1/exports/${encodeURIComponent(id)}/download/${format}`, {
        headers: { authorization: `Bearer ${token()}`, 'x-tenant-id': tenantId },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (response.status === 401) clearToken();
        throw new ApiError(response.status, payload?.code, payload?.message || '下载失败，请刷新任务后重试');
      }
      return { blob: await response.blob(), filename: /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || `export-${id}.${format === 'xlsx' ? 'xlsx' : 'txt'}` };
    },
    knowledgeProducts: tenantId => request('/knowledge/products', { tenantId }),
    catalogSpus: tenantId => request('/knowledge/spus', { tenantId }),
    catalogCategories: tenantId => request('/knowledge/categories', { tenantId }),
    catalogDetail: (tenantId, id) => request(`/knowledge/spus/${encodeURIComponent(id)}`, { tenantId }),
    createCatalogSpu: (tenantId, body) => request('/knowledge/spus', { method: 'POST', tenantId, body }),
    updateCatalogSpu: (tenantId, id, body) => request(`/knowledge/spus/${encodeURIComponent(id)}`, { method: 'PATCH', tenantId, body }),
    createCatalogSku: (tenantId, id, body) => request(`/knowledge/spus/${encodeURIComponent(id)}/skus`, { method: 'POST', tenantId, body }),
    updateCatalogSku: (tenantId, id, body) => request(`/knowledge/skus/${encodeURIComponent(id)}`, { method: 'PATCH', tenantId, body }),
    knowledgeFaqs: tenantId => request('/knowledge/faqs', { tenantId }),
    faqVariants: (tenantId, faqId) => request(`/knowledge/faqs/${encodeURIComponent(faqId)}/variants`, { tenantId }),
    createFaqVariant: (tenantId, faqId, input) => request(`/knowledge/faqs/${encodeURIComponent(faqId)}/variants`, {
      method: 'POST', tenantId, body: input,
    }),
    updateFaqVariant: (tenantId, id, patch) => request(`/knowledge/faq-variants/${encodeURIComponent(id)}`, {
      method: 'PATCH', tenantId, body: patch,
    }),
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
    conversations: storeId => request(`/conversations${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ''}`),
    conversation: id => request(`/conversations/${encodeURIComponent(id)}`),
    sendMessage: (id, content, source, candidateId) => request(`/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: {
        content,
        source,
        ...(candidateId ? { candidateId } : {}),
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
