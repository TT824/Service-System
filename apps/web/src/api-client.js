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

  /**
   * 修改当前登录账号的密码。
   *
   * 这条路由用「知道当前密码」证明调用者，而 `password/reset` 用「能收到恢复码」
   * 证明，两者的差别就是提交之后谁还活着：改密码只结束其他设备上的会话，把发起
   * 修改的这一次留在原地；重置会结束全部会话并忘掉受信设备。
   *
   * @param currentPassword - 当前密码。
   * @param newPassword - 新密码，长度与复用规则由服务端判定。
   * @returns `{ userId, revokedSessions }`。
   */
  function changePassword(currentPassword, newPassword) {
    return request('/auth/password/change', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    });
  }

  /**
   * 保存当前登录账号的头像。
   *
   * 头像存在账号上（不是成员上），所以这条路由只认调用者自己的会话，没有「改别人的
   * 头像」这个动作。`avatarUrl` 传 `null` 是清空——清空是一个正式操作，界面会退回
   * 姓名首字，不是出错。服务端仍会校验类型、字节签名和总长度（65536 字符），前端
   * 先缩放的图片不等于服务端就会收。
   *
   * @param avatarUrl - base64 `data:` URL，或 `null` 表示清空。
   * @returns 保存后的账号（`avatarUrl` 为服务端实际存下的值）。
   */
  function setAvatar(avatarUrl) {
    return request('/auth/avatar', { method: 'POST', body: { avatar_url: avatarUrl } });
  }

  /**
   * 上传一份商品文件做预览或导入。
   *
   * `mapping` 是「我们的字段 ← 文件里的哪一列」，只在文件表头不是本系统字段名时才传
   * （ERP 导出原表就是这种）。别名的识别靠猜列名，而猜错时丢掉的是一整列数据，
   * 所以映射写得出来就必须写出来；字段名与取值规则见服务端别名表。
   *
   * @param file - CSV / XLSX 文件。
   * @param storeId - 导入归属门店。
   * @param tenantId - 公司范围。
   * @param mode - `preview` 只读检查，`apply` 真正写入。
   * @param mapping - 可选的列映射；缺省时让服务端按别名表识别表头。
   * @returns 预览结果或导入回执。
   */
  function productImport(file, storeId, tenantId, mode, mapping) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('storeId', storeId);
    if (mapping && Object.keys(mapping).length > 0) form.append('mapping', JSON.stringify(mapping));
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
    changePassword,
    setAvatar,
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
    // 个人快捷短语。归属由服务端按 Bearer 会话决定，所以这三个方法都不收 memberId，
    // 请求体里也没有 owner：一个人只能读到、只能改到自己的那几行。
    // 公司范围沿用统一的 x-tenant-id（见 request 里那个 workspaceTenantId），
    // 个人短语不另开一套范围，一个人的笔记只属于他所在的租户。
    personalPhrases: () => request('/personal-phrases'),
    createPersonalPhrase: input => request('/personal-phrases', { method: 'POST', body: input }),
    updatePersonalPhrase: (id, patch) => request(`/personal-phrases/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: patch,
    }),
    previewKnowledgeImport: (tenantId, storeId, file, mapping) => productImport(file, storeId, tenantId, 'preview', mapping),
    applyKnowledgeImport: (tenantId, storeId, file, mapping) => productImport(file, storeId, tenantId, 'apply', mapping),
    // 索引状态：切片各状态计数与已写向量数，读的是索引表而不是目录表——「已经导进来了」
    // 与「检索找得到」是两件事，界面上必须能分开看。读 open 给任何成员。
    knowledgeIndexStatus: (tenantId, filter = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value);
      const suffix = query.toString() ? `?${query}` : '';
      return request(`/knowledge/index-status${suffix}`, { tenantId });
    },
    // 导入批次账：每次 apply 都会留下一条，含行数结果。逐行错误明细走
    // `/knowledge/import-batches/:id`，界面只在需要时再取一次。
    knowledgeImportBatches: tenantId => request('/knowledge/import-batches', { tenantId }),
    // 渠道连接（企业微信「微信客服」）。overview 任何登录成员都能读；写凭据由
    // 服务端限制为平台管理员，前端不做也不该做这层判断。
    channelsOverview: tenantId => request('/channels', { tenantId }),
    connectWecom: (tenantId, values) => request('/channels/wecom/credentials', {
      method: 'PUT', tenantId, body: values,
    }),
    // 回调自检：由服务端拿已保存的凭据，按企业微信的方式请求一次这个地址。
    // 只接受 HTTPS 公网地址，且仅平台超级管理员可调用；失败原因由服务端给出，
    // 前端只负责原样呈现，不在这里判断地址是否合规。
    selfCheckWecomCallback: (tenantId, url) => request('/channels/wecom/callback-selfcheck', {
      method: 'POST', tenantId, body: { url },
    }),
    // 客服账号：成员列表与启停。服务端按调用者的公司范围收口，商家/平台管理员
    // 只能作用在自己有权限的租户，客服调用会被拒绝。
    adminMembers: tenantId => request(`/admin/tenants/${encodeURIComponent(tenantId)}/members`, { tenantId }),
    createMember: (tenantId, input) => request('/admin/members', {
      method: 'POST', tenantId, body: { tenant_id: tenantId, ...input },
    }),
    setMemberEnabled: (tenantId, memberId, enabled) => request(`/admin/members/${encodeURIComponent(memberId)}/enabled`, {
      method: 'POST', tenantId, body: { enabled },
    }),
    // 登录账号与成员是两件事：账号带密码、能被停用并踢下线，成员是排班席位。
    // 建一个能登录的客服账号 = 建成员 + 建账号 + 把两者绑定。
    adminAccounts: tenantId => request('/admin/accounts', { tenantId }),
    createAccount: (tenantId, input) => request('/admin/accounts', {
      method: 'POST', tenantId, body: input,
    }),
    linkMemberAccount: (tenantId, memberId, userId) => request(`/admin/members/${encodeURIComponent(memberId)}/link`, {
      method: 'POST', tenantId, body: { user_id: userId },
    }),
    setAccountDisabled: (tenantId, userId, disabled) => request(
      `/admin/accounts/${encodeURIComponent(userId)}/${disabled ? 'disable' : 'enable'}`,
      { method: 'POST', tenantId },
    ),
    conversations: storeId => request(`/conversations${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ''}`),
    conversation: id => request(`/conversations/${encodeURIComponent(id)}`),
    sendMessage: (id, content, source, candidateId) => request(`/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: {
        content,
        source,
        // 采纳来源：服务端用 candidateId 记住这条消息出自哪条候选（§4.8 的采纳率口径）。
        // 只有确实从候选发出的消息才带，手打的消息不带，否则来源追溯会凭空多一条引用。
        ...(candidateId ? { candidateId } : {}),
        dedupKey: `frontend-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      },
    }),
    // 附件走单独一条路由，带的是字节而不是一个草稿 ID：渠道消息的媒体要先传到平台那边
    // 换一个临时素材句柄，句柄会过期，所以上传和发送必须在同一次请求里完成，中间没有
    // 可以放在浏览器里的状态（这一点和内部协作的两步上传不同，那边存的是我们自己的
    // 草稿）。没有 candidateId：媒体消息不带文字，也就没有「这条出自哪条候选」可言。
    sendMediaMessage: (id, file, source) => {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('source', source || 'manual_typed');
      // 幂等键和文字发送同一套格式：网络重试撞上同一个键时服务端只算一条。
      form.append('dedupKey', `frontend-media-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
      return request(`/conversations/${encodeURIComponent(id)}/messages/media`, {
        method: 'POST', body: form,
      });
    },
    // 候选回复由服务端一次算完：意图识别 → 话术库优先检索（命中就直出、不调用模型）→
    // 未命中才检索商品库并由大模型生成。前端不复刻这条链路，只渲染服务端写下来的
    // intent / origin / fallbackReasons，因为它们才是「为什么没有候选」的答案。
    closeConversation: (id, version) => request(`/conversations/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      body: { expectedVersion: version },
    }),
    // 内部协作（同事之间）走独立接口，不复用客户会话的外发通道：内部消息没有
    // 渠道、客户身份和 48 小时窗口，混进 /conversations 会污染会话队列与指标。
    internalPeers: () => request('/internal-chat/peers'),
    internalThreads: () => request('/internal-chat/threads'),
    internalOpenThread: peerMemberId => request('/internal-chat/threads', { method: 'POST', body: { peerMemberId } }),
    internalMessages: threadId => request(`/internal-chat/threads/${encodeURIComponent(threadId)}/messages`),
    // 有附件时把草稿 ID 一起报上去，服务端在同一笔事务里认领它并挂到这条消息上；
    // 没附件时字段干脆不出现，免得后端把 undefined 当成「要认领一个不存在的附件」。
    internalSend: (threadId, content, attachmentId) => request(`/internal-chat/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST', body: { content, ...(attachmentId ? { attachmentId } : {}) },
    }),
    // 附件先单独上传拿草稿 ID，再随消息一起发送：上传会失败（超限、格式不支持、
    // 存储不可用），而「字节没落盘」和「消息已存在」是两件不同的事，所以两步不能合成一步。
    // FormData 交给 request() 原样传，Content-Type 与 boundary 由浏览器生成。
    internalUploadAttachment: (threadId, file) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return request(`/internal-chat/threads/${encodeURIComponent(threadId)}/attachments`, {
        method: 'POST', body: form,
      });
    },
    presence: status => request('/assignment/presence', { method: 'PUT', body: { status } }),
    heartbeat: () => request('/assignment/presence/heartbeat', { method: 'POST' }),
    // 会话分流：读的是每个客服当前的权重和在手会话数，写的是页面提交的那几个客服。
    // 服务端按名单更新，没提交的客服保持原值，所以这里传数组而不是整表。
    conversationRouting: tenantId => request('/assignment/routing', { tenantId }),
    saveConversationRouting: (tenantId, weights) => request('/assignment/routing', {
      method: 'PUT', tenantId, body: { weights },
    }),
  });
})();
