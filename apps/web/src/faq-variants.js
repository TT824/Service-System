/** FAQ 的近似问法继承标准问题的公司及门店范围；权限由后端再次校验。 */
(function exposeFaqVariants() {
  const $ = id => document.getElementById(id);
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const sources = { manual:'人工录入', generated:'自动生成', imported:'导入' };
  let context = null, revision = 0, rows = [], editingId = null, loading = false, saving = false, loaded = false;

  function reset() {
    revision++;
    context = null; rows = []; editingId = null; loading = false; saving = false; loaded = false;
    const root = $('faq-variants-editor');
    if (root) { root.innerHTML = ''; root.hidden = true; }
  }
  // 切换 FAQ、页签或账号后，旧请求不能覆盖新表单，也不能使用新账号提交旧草稿。
  function valid(version) { return version === revision && context?.active(); }
  function writable() { return context?.faq?.id && context.active() && context.canWrite() && loaded && !loading && !saving; }
  function permissions() {
    const editable = Boolean(context?.canWrite()), enabled = Boolean(writable());
    $('faq-variant-form').hidden = !editable || !context?.faq?.id;
    $('faq-variant-new').hidden = !editable || !context?.faq?.id;
    $('faq-variant-new').disabled = !enabled;
    $('faq-variant-question').disabled = !enabled;
    $('faq-variant-status').disabled = !enabled || !editingId;
    $('faq-variant-save').disabled = !enabled;
    $('faq-variant-save').textContent = saving ? '正在保存…' : editingId ? '保存问法修改' : '添加近似问法';
    $('faq-variant-refresh').hidden = !context?.faq?.id;
    $('faq-variant-refresh').disabled = loading || saving;
    $('faq-variants-list').querySelectorAll('button').forEach(button => { button.disabled = loading || saving; });
  }
  function list() {
    $('faq-variant-count').textContent = loaded ? `${rows.filter(row => row.status === 'enabled').length} 条启用 / 共 ${rows.length} 条` : '—';
    $('faq-variants-list').innerHTML = !context?.faq?.id ? `<p class="knowledge-form-help">选择左侧已有 FAQ 查看近似问法。${context?.canWrite() ? '新增 FAQ 请先保存标准问题和答案。' : '暂无 FAQ 时请联系管理员录入。'}</p>` : loading ? '<p class="knowledge-form-help">正在读取近似问法…</p>' : !loaded ? '<p class="knowledge-form-help">近似问法尚未读取，请重试。</p>' : rows.length ? rows.map(row => {
      const date = new Date(row.updatedAt);
      const updated = Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN', {hour12:false});
      return `<div class="faq-variant-row${editingId === row.id ? ' selected' : ''}"><span class="faq-variant-text">${safe(row.questionText)}</span><div class="faq-variant-meta"><span class="pill ${row.status === 'enabled' ? 'green' : 'gray'}">${row.status === 'enabled' ? '已启用' : '已停用'}</span><span>${safe(sources[row.source] || row.source)}</span><span>${safe(updated)}</span>${context.canWrite() ? `<button class="small-link" type="button" data-variant-edit="${safe(row.id)}">编辑问法</button>` : ''}</div></div>`;
    }).join('') : '<p class="knowledge-form-help">暂无近似问法。</p>';
    $('faq-variants-list').querySelectorAll('[data-variant-edit]').forEach(button => {
      button.onclick = () => { if (writable()) draft(rows.find(row => row.id === button.dataset.variantEdit)); };
    });
    permissions();
  }
  function draft(row) {
    editingId = row?.id || null;
    $('faq-variant-question').value = row?.questionText || '';
    $('faq-variant-status').value = row?.status || 'enabled';
    $('faq-variant-error').textContent = '';
    list();
  }
  async function load() {
    if (!context?.faq?.id || loading || saving || !context.active()) return;
    const version = revision, captured = context;
    loading = true; loaded = false; rows = []; list();
    $('faq-variant-error').textContent = '';
    try {
      const scope = await captured.scope();
      if (!valid(version)) return;
      const result = await captured.api.faqVariants(scope.tenantId, captured.faq.id);
      if (!valid(version)) return;
      rows = result || []; loaded = true;
      // 刷新后若当前编辑条目已不存在，回到新增；不覆盖仍在编辑的文字。
      if (editingId && !rows.some(row => row.id === editingId)) draft(null);
    } catch (error) {
      if (valid(version)) $('faq-variant-error').textContent = error.message || '近似问法读取失败';
    } finally {
      if (valid(version)) { loading = false; list(); }
    }
  }
  async function save(event) {
    event.preventDefault();
    if (!writable()) return;
    const questionText = $('faq-variant-question').value.trim();
    if (!questionText || questionText.length > 300) {
      $('faq-variant-error').textContent = '请填写 1–300 字的近似问法。'; return;
    }
    const status = $('faq-variant-status').value;
    if (!['enabled','disabled'].includes(status)) return;
    const version = revision, captured = context, id = editingId;
    saving = true; permissions(); $('faq-variant-error').textContent = '';
    try {
      const scope = await captured.scope();
      if (!valid(version) || !captured.canWrite()) return;
      const saved = id ? await captured.api.updateFaqVariant(scope.tenantId, id, {questionText, status}) :
        await captured.api.createFaqVariant(scope.tenantId, captured.faq.id, {questionText, source:'manual'});
      if (!valid(version)) return;
      const index = rows.findIndex(row => row.id === saved.id);
      if (index >= 0) rows.splice(index, 1, saved); else rows.push(saved);
      draft(saved);
      captured.notify(`近似问法已${id ? '更新' : '添加'}到业务后端`);
    } catch (error) {
      if (valid(version)) $('faq-variant-error').textContent = [error.message, ...(error.details || [])].filter(Boolean).join('；') || '问法保存失败';
    } finally {
      if (valid(version)) { saving = false; permissions(); }
    }
  }
  function render(options) {
    if (!options.active()) { reset(); return; }
    if (context && context.session === options.session && context.faq?.id === options.faq?.id) {
      context = options; permissions(); return;
    }
    reset(); context = options;
    const root = $('faq-variants-editor'); root.hidden = false;
    root.innerHTML = `<div class="faq-variants-heading"><strong>近似问法</strong><span id="faq-variant-count" class="knowledge-count">—</span><button id="faq-variant-refresh" class="small-link" type="button">刷新问法</button></div>
      <p class="knowledge-form-help">客户可能提出的其他问法，共用当前 FAQ 的标准答案。${options.canWrite() ? '新增问法默认启用，停用后不参与匹配。' : '客服只读，由管理员维护。'}</p>
      <div id="faq-variants-list" aria-live="polite"></div>
      <button id="faq-variant-new" class="btn" type="button">＋ 新增问法</button>
      <form id="faq-variant-form" class="knowledge-form-fields">
        <label for="faq-variant-question">近似问法</label><textarea id="faq-variant-question" class="field" maxlength="300" placeholder="例如：今天下单什么时候可以发货？"></textarea>
        <label for="faq-variant-status">问法状态</label><select id="faq-variant-status" class="field"><option value="enabled">启用</option><option value="disabled">停用</option></select>
        <div class="knowledge-form-actions"><button id="faq-variant-save" class="btn primary" type="submit">添加近似问法</button></div>
      </form><p id="faq-variant-error" class="knowledge-form-error" role="alert"></p>`;
    $('faq-variant-new').onclick = () => { if (writable()) draft(null); };
    $('faq-variant-form').onsubmit = save;
    $('faq-variant-refresh').onclick = () => void load();
    list(); if (options.faq?.id) void load();
  }
  window.KefuFaqVariants = Object.freeze({render, reset});
})();
