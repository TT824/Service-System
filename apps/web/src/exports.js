/** 导出只创建后台任务；下载必须等到成功且产物存在。 */
(function () {
  const api = window.KefuApi;
  const el = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  let active = false, generation = 0, timer = null, loading = false, jobs = [];
  // 工作台点「导出对话记录」时寄存的待办：公司与会话清单要等后端读完才能选中。
  let pendingPrefill = null;
  const tenant = () => el('export-tenant').value;
  const notice = (message, error = false) => {
    el('export-notice').textContent = message;
    el('export-notice').classList.toggle('error', error);
  };
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

  /**
   * 表单的默认时间范围：上月本日 → 本日。
   *
   * 按 UTC 算，不按北京时间：这一页的日期筛选是 UTC 自然日（提交时把 `from` 拼成
   * `T00:00:00.000Z`、`to` 拼成 `T23:59:59.999Z`），而北京时间在 08:00 之前已经
   * 是新的一天、UTC 还在前一天，用本地日期当默认值就会默认多筛出一天。
   *
   * 上月没有这一天时取上月最后一天（3 月 31 日的「上月本日」是 2 月 28 日，闰年是
   * 2 月 29 日）。不夹取就会写出 `2026-02-31`，`<input type="date">` 把它判为无效、
   * 输入框直接空掉——表现正好是「默认值没生效」。
   *
   * @param now - 取默认值时的时刻。
   * @returns `[开始日期, 结束日期]`，都是 `YYYY-MM-DD`。
   */
  function defaultRange(now = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    const year = now.getUTCFullYear(), month = now.getUTCMonth(), day = now.getUTCDate();
    const prevYear = month === 0 ? year - 1 : year;
    const prevMonth = month === 0 ? 11 : month - 1;
    // 下个月的第 0 天即本月最后一天；上月是 12 月时这里传 12，Date.UTC 会自己跨年。
    const prevMonthDays = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();
    return [
      `${prevYear}-${pad(prevMonth + 1)}-${pad(Math.min(day, prevMonthDays))}`,
      `${year}-${pad(month + 1)}-${pad(day)}`,
    ];
  }

  /** 上一次写进输入框的默认值；用来分辨「操作者改过」与「还是默认值」。 */
  let offeredRange = null;

  /**
   * 把默认范围填进两个日期框。
   *
   * 只在空框或仍等于上次写入的默认值时填：首次打开两框都是空的；之后每次打开导出
   * 页，只要操作者没动过就跟着日历往前挪（页面开着过夜，「本日」不该停在昨天）。
   * 动过就保留他的选择——表单其余字段（关键词、范围、会话）本来也是这样留着的。
   */
  function applyDefaultRange() {
    const fromField = el('export-from'), toField = el('export-to');
    const untouched = offeredRange === null
      || (fromField.value === offeredRange[0] && toField.value === offeredRange[1]);
    if (!untouched) return;
    const range = defaultRange();
    fromField.value = range[0];
    toField.value = range[1];
    offeredRange = range;
  }

  function render() {
    const labels = { pending: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' };
    const scopeTags = { conversation: '会话', customers: '顾客' };
    // 两个产物按口径命名，而不是按格式命名：顾客口径的第二个文件是名单，不是对话
    // 记录。按钮写「对话记录」而文件里只有人名，操作者会以为导出漏了对话——这正是
    // 把顾客导出当成会话导出时看到的现象。
    const fileNames = {
      customers: { xlsx: 'Excel', transcript: '顾客名单' },
      conversation: { xlsx: 'Excel', transcript: '对话记录' },
    };
    const fileTitles = {
      customers: { xlsx: '顾客名单表格：姓名 / 渠道 / 电话 / 微信', transcript: '顾客名单文本：不含对话内容' },
      conversation: { xlsx: '聊天记录表格：时间 / 说话人 / 内容', transcript: '聊天记录文本：含会话里的每条消息' },
    };
    el('export-jobs').innerHTML = jobs.length ? `<table class="table"><thead><tr><th>导出内容</th><th>状态</th><th>创建时间</th><th>完成时间</th><th>行数</th><th>下载 / 结果</th></tr></thead><tbody>${jobs.map(job => {
      const names = fileNames[job.scope] || fileNames.customers;
      const titles = fileTitles[job.scope] || fileTitles.customers;
      const files = ['xlsx', 'transcript'].map(format => `<button class="btn" type="button" data-export-id="${escape(job.id)}" data-format="${format}" title="${escape(titles[format])}" ${job.artifacts?.includes(format) ? '' : 'disabled'}>${names[format]}</button>`).join(' ');
      return `<tr><td><span class="pill gray">${escape(scopeTags[job.scope] || '导出')}</span> ${escape(job.label)}<small class="export-job-id">${escape(job.id)}</small></td><td>${escape(labels[job.status] || job.status)}</td><td>${escape(time(job.createdAt))}</td><td>${escape(time(job.finishedAt))}</td><td>${escape(job.rowCount ?? '—')}</td><td>${job.status === 'succeeded' ? files : escape(job.error || '等待后台处理')}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">暂无导出任务</div>';
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
  /**
   * 让表单与当前范围一致，并说明这一次导出会得到什么。
   *
   * 两种口径的文件差别就在「有没有对话」：顾客口径导的是人，第二个产物是名单，不
   * 是聊天记录。把这句话写进表单，才不会有人拿着顾客名单找对话——那正是把一个顾客
   * 导出当成会话导出时看到的现象。
   *
   * @returns 是否选择了单条会话口径。
   */
  function syncScope() {
    const single = el('export-scope').value === 'conversation';
    el('export-customer-fields').hidden = single;
    el('export-conversation-field').hidden = !single;
    el('export-conversation').required = single;
    el('export-scope-hint').textContent = single
      ? '将导出所选会话的完整聊天记录：表格按钮是「Excel」，文本按钮是「对话记录」，两个文件里都有每条消息。'
      : '将导出符合条件的顾客名单：文本按钮是「顾客名单」，只有顾客与最后活动时间，不含对话内容。要某条会话的聊天记录，请把「导出范围」换成「单条会话记录（含对话）」。';
    return single;
  }
  el('export-scope').onchange = syncScope;
  syncScope();
  // 加载即填好，不让两个日期框以空白示人：空白的日期框看起来像「筛了全部时间」，
  // 而操作者多半只是想导最近这段时间。
  applyDefaultRange();

  /**
   * 把工作台带过来的会话填进表单。
   *
   * 入口在会话里、下单在导出页，中间隔着一次异步加载（公司与会话清单都是读后端），
   * 所以会话 id 先寄存，等下拉框真的有了这些选项再落进去。
   */
  function applyPrefill() {
    const pending = pendingPrefill;
    if (!pending) return;
    pendingPrefill = null;
    const scopeField = el('export-scope');
    if (pending.scope && [...scopeField.options].some(option => option.value === pending.scope)) scopeField.value = pending.scope;
    syncScope();
    const selected = pending.conversationId
      ? [...el('export-conversation').options].some(option => option.value === pending.conversationId)
      : false;
    if (selected) el('export-conversation').value = pending.conversationId;
    if (pending.conversationId && !selected) {
      notice('这条会话不在当前公司的导出范围内，请手动选择要导出的会话', true);
    } else if (selected) {
      notice('已选中当前会话，点「创建导出任务」生成对话记录。');
      el('export-form').scrollIntoView?.({ block: 'center' });
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
    /**
     * 记下要在导出页里选好的目标；下一次 `open()` 加载完成后生效。
     *
     * @param request - `{ scope, conversationId }`，字段都可省略。
     */
    prefill(request) { pendingPrefill = { ...request }; },
    /**
     * 表单默认范围的计算规则。
     *
     * 暴露出来是为了能钉住边界：月末（3 月 31 日 → 2 月 28 日）、跨年（1 月 → 上个
     * 12 月）、闰年 2 月 29 日——在页面上等不到这些日子，只能直接调这个纯函数。
     */
    defaultRange,
    leave() { active = false; generation++; clearTimeout(timer); jobs = []; el('export-jobs').innerHTML = '<div class="empty">请选择公司后读取任务</div>'; },
    async open() {
      active = true;
      applyDefaultRange();
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
        // 这里不比对 `stamp`：`changeTenant()` 自己会推进 generation，比对会把这次
        // 打开判成过期。会话清单与公司都由 `changeTenant()` 内部按它自己的 stamp
        // 收口，返回值回来时下拉框已经是这一次打开的选项。
        await changeTenant();
        applyPrefill();
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
