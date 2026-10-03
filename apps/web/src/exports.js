/** 导出只创建后台任务；下载必须等到成功且产物存在。 */
(function () {
  const api = window.KefuApi;
  const el = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  let active = false, generation = 0, timer = null, loading = false, jobs = [];
  const tenant = () => el('export-tenant').value;
  const notice = (message, error = false) => {
    el('export-notice').textContent = message;
    el('export-notice').classList.toggle('error', error);
  };
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  function render() {
    const labels = { pending: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' };
    el('export-jobs').innerHTML = jobs.length ? `<table class="table"><thead><tr><th>导出内容</th><th>状态</th><th>创建时间</th><th>完成时间</th><th>行数</th><th>下载 / 结果</th></tr></thead><tbody>${jobs.map(job => `<tr><td>${escape(job.label)}<small class="export-job-id">${escape(job.id)}</small></td><td>${escape(labels[job.status] || job.status)}</td><td>${escape(time(job.createdAt))}</td><td>${escape(time(job.finishedAt))}</td><td>${escape(job.rowCount ?? '—')}</td><td>${job.status === 'succeeded' ? ['xlsx', 'transcript'].map(format => `<button class="btn" type="button" data-export-id="${escape(job.id)}" data-format="${format}" ${job.artifacts?.includes(format) ? '' : 'disabled'}>${format === 'xlsx' ? 'Excel' : '对话记录'}</button>`).join(' ') : escape(job.error || '等待后台处理')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无导出任务</div>';
  }
  async function refresh() {
    if (!active || !tenant() || loading) return;
    const stamp = generation, scope = tenant();
    loading = true;
    el('export-refresh').disabled = true;
    clearTimeout(timer);
    try {
      const rows = await api.exportJobs(scope);
      if (stamp !== generation || !active) return;
      jobs = rows || []; render();
    } catch (error) {
      if (stamp === generation && active) notice(error.message, true);
    } finally {
      loading = false; el('export-refresh').disabled = false;
      if (active && stamp !== generation) timer = setTimeout(refresh, 0);
      else if (stamp === generation && active && jobs.some(job => ['pending', 'running'].includes(job.status))) timer = setTimeout(refresh, 4000);
    }
  }
  async function changeTenant() {
    const stamp = ++generation;
    clearTimeout(timer); jobs = []; render();
    notice('');
    el('export-conversation').innerHTML = '<option value="">正在读取会话…</option>';
    try {
      const rows = await api.exportConversations(tenant());
      if (stamp !== generation || !active) return;
      el('export-conversation').innerHTML = '<option value="">请选择会话</option>' + (rows || []).map(row => `<option value="${escape(row.id)}">${escape(row.title || row.externalCustomerId || row.id)} · ${escape(row.storeId)}</option>`).join('');
    } catch (error) {
      if (stamp === generation) { el('export-conversation').innerHTML = '<option value="">会话读取失败</option>'; notice(error.message, true); }
    }
    if (stamp === generation) await refresh();
  }
  el('export-tenant').onchange = changeTenant;
  el('export-scope').onchange = () => {
    const single = el('export-scope').value === 'conversation';
    el('export-customer-fields').hidden = single;
    el('export-conversation-field').hidden = !single;
    el('export-conversation').required = single;
  };
  el('export-refresh').onclick = refresh;
  el('export-form').onsubmit = async event => {
    event.preventDefault();
    if (!tenant()) return notice('请选择公司', true);
    const scope = el('export-scope').value;
    const from = el('export-from').value, to = el('export-to').value;
    if (scope === 'customers' && from && to && from > to) return notice('开始日期不能晚于结束日期', true);
    const input = scope === 'conversation' ? { scope, conversationId: el('export-conversation').value } : { scope, q: el('export-query').value.trim(), from: from ? `${from}T00:00:00.000Z` : undefined, to: to ? `${to}T23:59:59.999Z` : undefined };
    const stamp = generation;
    el('export-submit').disabled = true;
    try {
      await api.createExport(tenant(), input);
      if (stamp !== generation || !active) return;
      notice('任务已创建，后台正在处理。完成后可下载文件。');
      await refresh();
    } catch (error) { if (stamp === generation) notice(error.message, true); }
    finally { el('export-submit').disabled = false; }
  };
  el('export-jobs').onclick = async event => {
    const button = event.target.closest('[data-export-id]');
    if (!button || button.disabled) return;
    const stamp = generation;
    button.disabled = true;
    try {
      const file = await api.downloadExport(tenant(), button.dataset.exportId, button.dataset.format);
      if (stamp !== generation || !active) return;
      const url = URL.createObjectURL(file.blob), link = document.createElement('a');
      link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { if (stamp === generation) notice(error.message, true); }
    finally { button.disabled = false; }
  };
  window.ExportPortal = {
    leave() { active = false; generation++; clearTimeout(timer); jobs = []; el('export-jobs').innerHTML = '<div class="empty">请选择公司后读取任务</div>'; },
    async open() {
      active = true;
      const stamp = ++generation;
      el('export-tenant').innerHTML = '<option value="">正在读取…</option>';
      notice('');
      el('export-submit').disabled = true;
      try {
        const [directories, session] = await Promise.all([api.directoryTenants(), api.currentSession()]);
        if (!active || stamp !== generation) return;
        const options = directories || [];
        el('export-tenant').innerHTML = options.map(entry => `<option value="${escape(entry.tenant.id)}">${escape(entry.tenant.name)}</option>`).join('');
        const own = session.access?.tenantId || session.access?.member?.tenantId;
        if (options.some(entry => entry.tenant.id === own)) el('export-tenant').value = own;
        if (!options.length) return notice('当前账号没有可导出的公司范围', true);
        await changeTenant();
      } catch (error) {
        if (stamp === generation) {
          el('export-tenant').innerHTML = '<option value="">公司读取失败，请登录后重试</option>';
          notice(error.message || '请先登录业务后端', true);
        }
      }
      finally { if (active) el('export-submit').disabled = !tenant(); }
    },
  };
})();
