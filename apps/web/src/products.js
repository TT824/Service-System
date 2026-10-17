/* 商品库页：结构化目录的总览、导入入口与索引状态。
   逐条维护不在这里——它在「知识库 → SPU / SKU」（见 src/catalog.js），这一页只读目录、
   发起导入，并把「导进来了」和「检索找得到」分成两组数字显示。数据全部来自后端：
   目录读 /knowledge/spus、类目读 /knowledge/categories、索引状态读 /knowledge/index-status、
   导入批次读 /knowledge/import-batches；导入与模板下载由 app.js 经 ctx.openImport /
   ctx.downloadTemplate 注入，和知识库页是同一份实现。搜索口径共用 catalog.js 暴露的
   window.KefuSpuSearchText。 */
(function () {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const shelf = {on_shelf:'上架',off_shelf:'下架',unknown:'未知'};
  // 搜索口径不在这一页定义：与「知识库」「SPU / SKU」共用同一把尺子（catalog.js 先加载）。
  const spuSearchText = spu => window.KefuSpuSearchText(spu);
  // 批次状态词与导出页同一套口径（uploaded/validating/importing 都是「还没落库」）。
  const batchStatus = {uploaded:'已上传',validating:'校验中',importing:'导入中',completed:'完成',partial_failed:'部分失败',failed:'失败'};
  const PAGE_STEP = 50;
  let ctx = null, session = null, scope = null, spus = [], categories = [], index = null,
      batches = [], loaded = false, loading = false, failure = '', epoch = 0, shown = PAGE_STEP;

  const active = () => Boolean(ctx?.active?.());
  const stamp = value => value ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '—';
  const shortStamp = value => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '—'
      : date.toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  };
  const storeName = id => scope?.stores?.find(store => store.id === id)?.name || id || '—';
  const categoryName = id => id ? categories.find(item => item.id === id)?.name || '未分类' : '未分类';
  const counts = () => index?.counts || {pending:0,indexed:0,failed:0,skipped:0,total:0};

  /** 当前筛选条件下的 SPU。文本匹配按共用口径来（编码、标题、副标题、卖点、公共属性）。 */
  function filtered() {
    const query = ($('products-search')?.value || '').trim().toLowerCase();
    const status = $('products-status-filter')?.value || 'all';
    return spus.filter(spu =>
      (status === 'all' || spu.shelfStatus === status) &&
      (!query || spuSearchText(spu).includes(query)));
  }

  function renderStats() {
    const total = counts();
    $('products-stat-spu').textContent = loaded ? String(spus.length) : '—';
    $('products-stat-spu-note').textContent = loaded
      ? `${(scope?.stores || []).length} 个门店 · 读目录表`
      : '读 /knowledge/spus';
    $('products-stat-category').textContent = loaded
      ? String(categories.filter(item => item.status === 'enabled').length) : '—';
    $('products-stat-indexed').textContent = loaded ? `${total.indexed} / ${total.total}` : '—';
    $('products-stat-indexed-note').textContent = loaded
      ? `${index?.embeddings ?? 0} 条向量已落库` : '切片的索引状态';
    $('products-stat-attention').textContent = loaded ? `${total.pending} / ${total.failed + total.skipped}` : '—';
    $('products-stat-attention-note').textContent = loaded
      ? '等待索引 / 失败或已放弃' : '待处理与已放弃的切片';
  }

  function renderIndex() {
    const total = counts();
    $('products-index-indexed').textContent = loaded ? String(total.indexed) : '—';
    $('products-index-pending').textContent = loaded ? String(total.pending) : '—';
    $('products-index-failed').textContent = loaded ? String(total.failed + total.skipped) : '—';
    $('products-index-embeddings').textContent = loaded ? String(index?.embeddings ?? 0) : '—';
    const pill = $('products-index-pill');
    if (!loaded) { pill.className = 'pill blue'; pill.textContent = '读取中'; }
    else if (total.total === 0) { pill.className = 'pill blue'; pill.textContent = '目录里还没有切片'; }
    else if (total.pending === 0) { pill.className = 'pill green'; pill.textContent = '已就绪'; }
    else { pill.className = 'pill orange'; pill.textContent = `${total.pending} 条待索引`; }
    $('products-index-note').textContent = !loaded
      ? '正在读取索引状态…'
      : total.total === 0
        ? '目录里还没有待索引的切片：先导入商品，切片会在写入后出现。'
        : `切片由后台任务异步向量化（每轮认领一批）。「已写向量」少于「已就绪」时，检索搜得到的是同一批文本、但没有向量可用；「等待索引」长时间不动时先确认后台进程与模型服务。`;
    // 失败明细只画服务端记着的那几条：chunkId 指向具体切片，重试次数说明是「还有额度」
    // 还是「已经放弃」，错误原因原样显示，不在这里翻译。
    const failures = index?.recentFailures || [];
    $('products-index-failures').innerHTML = loaded && failures.length
      ? `<p class="knowledge-form-help">最近的失败切片（最多 ${failures.length} 条）</p>` + failures.map(item =>
          `<div class="products-index-failure"><span>${esc(item.sourceKind)} · ${esc(item.sourceId)}</span><span>${esc(item.indexStatus === 'skipped' ? '已跳过' : '待重试')} · 第 ${esc(item.indexAttempts)} 次</span><span>${esc(item.indexError || '未记录原因')}</span></div>`).join('')
      : '';
  }

  function renderBatches() {
    const rows = [...batches].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
    $('products-batches').innerHTML = !loaded
      ? '<tr><td colspan="5">正在读取导入记录…</td></tr>'
      : rows.length
        ? rows.map(batch => `<tr><td>${esc(shortStamp(batch.createdAt))}</td><td><span class="pill ${batch.status === 'completed' ? 'green' : batch.status === 'failed' ? 'red' : 'orange'}">${esc(batchStatus[batch.status] || batch.status)}</span></td><td>${esc(batch.totalRows)}</td><td>${esc(batch.successRows)} / ${esc(batch.failedRows)}</td><td>${esc(storeName(batch.storeId))}</td></tr>`).join('')
        : '<tr><td colspan="5">还没有导入记录。</td></tr>';
  }

  function renderList() {
    const rows = filtered();
    const visible = rows.slice(0, shown);
    $('products-list').innerHTML = !loaded
      ? '<tr><td colspan="6">正在读取商品目录…</td></tr>'
      : visible.length
        ? visible.map(spu => `<tr><td><span class="knowledge-table-main">${esc(spu.title)}</span><span class="knowledge-table-sub">${esc(spu.productCode)}</span></td><td>${esc(categoryName(spu.categoryId))}</td><td>${esc(storeName(spu.storeId))}</td><td>${esc(shelf[spu.shelfStatus] || spu.shelfStatus)}</td><td>${esc(shortStamp(spu.updatedAt))}<span class="knowledge-table-sub">来源 ${esc(spu.sourceType || 'manual')}</span></td><td><button class="small-link" type="button" data-products-maintain="${esc(spu.productCode)}">在知识库维护</button></td></tr>`).join('')
        : '<tr><td colspan="6">当前条件下没有商品。</td></tr>';
    $('products-list-note').innerHTML = !loaded
      ? '—'
      : `显示 ${visible.length} / ${rows.length} 个款式（目录共 ${spus.length} 个）` +
        (rows.length > visible.length ? ` <button type="button" class="small-link" id="products-more">再显示 ${Math.min(PAGE_STEP, rows.length - visible.length)} 个</button>` : '') +
        ' · 编辑与新增请在「知识库 → SPU / SKU」里做';
    $('products-more')?.addEventListener('click', () => { shown += PAGE_STEP; renderList(); });
    $('products-list').querySelectorAll('[data-products-maintain]').forEach(button => {
      button.onclick = () => ctx?.gotoCatalog?.(button.dataset.productsMaintain);
    });
  }

  /** 页头两个按钮由这一页自己接管：导入走的是知识库页同一份实现，按钮的可见性跟着写权限走。 */
  function renderActions() {
    const writable = Boolean(ctx?.canWrite?.());
    for (const [id, handler] of [['download-template', ctx?.downloadTemplate], ['import-products', ctx?.openImport]]) {
      const button = $(id);
      if (!button) continue;
      button.hidden = !writable;
      if (writable) button.onclick = handler;
    }
  }

  function render() {
    if (!ctx) return;
    renderActions();
    const note = $('products-scope-note');
    if (failure) { note.className = 'knowledge-scope-note error'; note.textContent = failure; }
    else if (!loaded) { note.className = 'knowledge-scope-note'; note.textContent = '正在读取商品目录…'; }
    else {
      note.className = 'knowledge-scope-note';
      note.textContent = `${scope?.tenantName || '当前公司'} · ${(scope?.stores || []).length} 个门店 · ${ctx.canWrite?.() ? '管理员可导入与维护' : '客服只读'} · 逐条维护在「知识库 → SPU / SKU」`;
    }
    renderStats(); renderIndex(); renderBatches(); renderList();
  }

  async function load(force = false) {
    if (!ctx || !active() || loading || (loaded && !force)) return;
    const n = ++epoch;
    loading = true; failure = ''; render();
    try {
      const resolved = await ctx.scope();
      // 四个读各自是独立的接口，「导进来了吗」与「索引好了吗」不是同一张表，所以并行读、
      // 谁先回来都不影响另一个的结论。
      const [rows, cats, status, batchRows] = await Promise.all([
        ctx.api.catalogSpus(resolved.tenantId),
        ctx.api.catalogCategories(resolved.tenantId),
        ctx.api.knowledgeIndexStatus(resolved.tenantId),
        ctx.api.knowledgeImportBatches(resolved.tenantId)
      ]);
      if (n !== epoch || !active()) return;
      scope = resolved; spus = rows || []; categories = cats || []; index = status || null;
      batches = batchRows || []; loaded = true;
    } catch (error) {
      if (n === epoch && active()) failure = error.message || '商品目录读取失败';
    } finally {
      if (n === epoch) { loading = false; render(); }
    }
  }

  /**
   * 记下这一页要用的账号与回调，然后读数据。
   *
   * 换了账号就整块清空：上一个账号的目录、索引状态和导入记录都不该留在页面上。
   */
  function open(options) {
    if (session !== options.session) leave();
    ctx = options; session = options.session;
    render();
    void load();
  }

  /** 别处（例如导入完成）改过目录之后叫这一声；不在这一页时不发请求，只留个待办。 */
  function refresh() { if (!active()) { loaded = false; return; } return load(true); }

  function leave() {
    ++epoch;
    ctx = null; session = null; scope = null; spus = []; categories = []; index = null;
    batches = []; loaded = false; loading = false; failure = ''; shown = PAGE_STEP;
  }

  const search = () => { shown = PAGE_STEP; renderList(); };
  document.addEventListener('input', event => { if (event.target?.id === 'products-search') search(); });
  document.addEventListener('change', event => { if (event.target?.id === 'products-status-filter') search(); });

  window.KefuProductLibrary = { open, refresh, leave, list: renderList };
})();
