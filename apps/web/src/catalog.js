/* 结构化商品与旧知识商品分别维护；所有写入由服务端再次校验公司、门店和管理员权限。 */
(function () {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const shelf = {on_shelf:'上架',off_shelf:'下架',unknown:'未知'};
  // SPU 的搜索文本：五个字段拼成一条小写串。这把尺子由「SPU / SKU」「知识库 → 商品」和
  // 「商品库」三处搜索共用（经 window.KefuSpuSearchText 暴露）；以前三处各写一份，
  // 商品库那份漏了公共属性，同一个词在两个页面就会给出不同的命中。
  const spuSearchText = spu => JSON.stringify([spu.productCode,spu.title,spu.subtitle,spu.sellingPoints,spu.commonAttributes]).toLowerCase();
  let ctx, scope, spus=[], categories=[], current=null, skus=[], sku=null, loaded=false, loading=false, busy=false, epoch=0, detailEpoch=0;
  // 别处（商品导入、商品库页）改过目录之后，本页手上这份列表就过期了。`invalidated`
  // 记的就是这件事：它让下一次进入这一页签重新读一遍，而不是把旧数据当缓存一直端上来。
  let invalidated=false;
  const writable = () => ctx?.active() && ctx.canWrite() && !busy;
  const stamp = value => value ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '—';
  const field = (name, label, value='', type='text', locked=false) => `<label for="catalog-${name}">${label}</label><input class="field" id="catalog-${name}" type="${type}" value="${esc(value)}" ${locked||!writable()?'disabled':''}>`;
  const select = (name,label,options,value,locked=false) => `<label for="catalog-${name}">${label}</label><select class="field" id="catalog-${name}" ${locked||!writable()?'disabled':''}>${options.map(([v,t])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(t)}</option>`).join('')}</select>`;
  const value = name => $(`catalog-${name}`).value.trim();
  const nullable = name => value(name)||null;
  // 行式编辑器保留数值/布尔类型；SKU 规格仅允许字符串，与现有 API 契约一致。
  function attributes(id, label, values, typed) {
    return `<fieldset class="catalog-attributes"><legend>${label}</legend><div id="${id}" data-typed="${typed}">${Object.entries(values||{}).map(([key,v])=>row(key,v,typed)).join('')}</div>${writable()?`<button type="button" class="small-link" data-add-attribute="${id}">＋ 添加属性</button>`:''}</fieldset>`;
  }
  function row(key='',v='',typed=false) {
    const kind=typeof v;
    return `<div class="catalog-attribute-row"><input class="field" data-key aria-label="属性名称" placeholder="例如：颜色" value="${esc(key)}" ${!writable()?'disabled':''}>${typed?`<select class="field" data-type aria-label="值类型" ${!writable()?'disabled':''}>${['string','number','boolean'].map(t=>`<option value="${t}" ${kind===t?'selected':''}>${({string:'文字',number:'数值',boolean:'布尔'})[t]}</option>`).join('')}</select>`:''}<input class="field" data-value aria-label="属性值" placeholder="属性值" value="${esc(v)}" ${!writable()?'disabled':''}>${writable()?'<button type="button" class="small-link" data-remove-attribute aria-label="移除属性">移除</button>':''}</div>`;
  }
  function readAttributes(id) {
    const result=Object.create(null);
    for(const r of $(id).querySelectorAll('.catalog-attribute-row')) {
      const key=r.querySelector('[data-key]').value.trim(), text=r.querySelector('[data-value]').value.trim(),type=r.querySelector('[data-type]')?.value||'string';
      if(!key&&!text)continue;
      if(!key||!text)throw new Error('属性名称和属性值均需填写，或移除空行。');
      if(Object.hasOwn(result,key))throw new Error(`属性“${key}”重复，请合并为一行。`);
      if(type==='number'&&!Number.isFinite(Number(text)))throw new Error(`属性“${key}”必须为有效数值。`);
      if(type==='boolean'&&!['true','false'].includes(text))throw new Error(`属性“${key}”请填写 true 或 false。`);
      result[key]=type==='number'?Number(text):type==='boolean'?text==='true':text;
    }
    return result;
  }
  function bindRows() {
    $('catalog-editor').querySelectorAll('[data-add-attribute]').forEach(b=>b.onclick=()=>{if(!writable())return;const box=$(b.dataset.addAttribute);box.insertAdjacentHTML('beforeend',row('','',box.dataset.typed==='true'));bindRows()});
    $('catalog-editor').querySelectorAll('[data-remove-attribute]').forEach(b=>b.onclick=()=>{if(writable())b.closest('.catalog-attribute-row').remove()});
  }
  function list() {
    if(!ctx?.active())return;
    const q=$('knowledge-search').value.trim().toLowerCase(),status=$('knowledge-status-filter').value;
    const items=spus.filter(p=>(status==='all'||(status==='enabled'?p.shelfStatus==='on_shelf':p.shelfStatus==='off_shelf'))&&spuSearchText(p).includes(q));
    $('knowledge-count').textContent=loaded?`${items.length} / ${spus.length} 个 SPU`:'—';
    $('knowledge-list').innerHTML=`<div class="catalog-list-tools"><span>结构化商品与“商品”页签独立维护；状态筛选：已启用＝上架，已停用＝下架。</span><button type="button" class="small-link" id="catalog-refresh" ${loading||busy?'disabled':''}>刷新</button></div>`+(loaded?items.length?`<div class="knowledge-table-wrap"><table class="table knowledge-table"><thead><tr><th>商品 / SPU 编码</th><th>门店</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${items.map(p=>`<tr class="${p.id===current?.id?'knowledge-row-selected':''}"><td><span class="knowledge-table-main">${esc(p.title)}</span><span class="knowledge-table-sub">${esc(p.productCode)}</span></td><td>${esc(scope.stores.find(s=>s.id===p.storeId)?.name||p.storeId)}</td><td>${esc(shelf[p.shelfStatus])}</td><td>${esc(stamp(p.updatedAt))}</td><td><button class="small-link" type="button" data-catalog-open="${esc(p.id)}" ${busy?'disabled':''}>${writable()?'编辑':'查看'}</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">当前条件下没有 SPU；管理员可点击“创建 SPU”。</div>':'<div class="empty">正在读取结构化商品…</div>');
    $('catalog-refresh').onclick=()=>void load(true);
    $('knowledge-list').querySelectorAll('[data-catalog-open]').forEach(b=>b.onclick=()=>void open(b.dataset.catalogOpen));
  }
  function editor() {
    if(!ctx?.active())return;
    if(loaded&&scope){
      $('knowledge-scope-note').className='knowledge-scope-note';
      $('knowledge-scope-note').textContent=`${scope.tenantName} · SPU / SKU 详细维护 · ${ctx.canWrite()?'管理员可修改':'客服只读'} · 与旧商品条目独立`;
    }
    $('knowledge-form-title').textContent=`${ctx.canWrite()?(current?'编辑':'创建'):'查看'} SPU / SKU`;
    $('knowledge-form-reset').hidden=!ctx.canWrite();
    $('knowledge-form-reset').disabled=busy||loading;
    $('knowledge-add').disabled=busy||loading;
    if(!loaded){$('catalog-editor').innerHTML='<p class="knowledge-form-help">等待读取商品数据。</p>';return}
    const p=current||{}, storeId=p.storeId||scope.storeId;
    $('catalog-editor').innerHTML=`<p class="knowledge-form-help">先保存 SPU，再维护其 SKU。SPU 编码与归属门店创建后不可修改。${!ctx.canWrite()?'当前账号只读。':''}</p><form id="catalog-spu-form" class="knowledge-form-fields">
      ${select('store','归属门店 *',scope.stores.map(s=>[s.id,s.name]),storeId,!!current)}
      ${field('code','SPU 编码 *',p.productCode,'text',!!current)}${field('title','商品标题 *',p.title)}${field('subtitle','副标题',p.subtitle)}
      ${select('category','商品分类',[['','未分类'],...categories.filter(c=>c.storeId===storeId&&(c.status==='enabled'||c.id===p.categoryId)).map(c=>[c.id,c.name])],p.categoryId||'')}
      ${select('shelf','上架状态',Object.entries(shelf),p.shelfStatus||'unknown')}
      ${field('external','外部商品 ID',p.externalProductId,'text',!!current)}${field('image','主图链接',p.mainImageUrl,'url')}${field('url','商品链接',p.productUrl,'url')}
      <label for="catalog-points">卖点（每行一条）</label><textarea id="catalog-points" class="field" ${!writable()?'disabled':''}>${esc((p.sellingPoints||[]).join('\n'))}</textarea>
      ${attributes('catalog-common','公共属性（例如材质、容量；布尔值填 true / false）',p.commonAttributes,true)}
      <p class="knowledge-form-help">来源：${esc(p.sourceType||'manual')} · 来源更新时间：${esc(stamp(p.sourceUpdatedAt))}<br>保存更新时间：${esc(stamp(p.updatedAt))}。这里不提供实时价格或库存编辑。</p>
      ${ctx.canWrite()?`<button class="btn primary" type="submit" ${busy?'disabled':''}>${busy?'正在保存…':current?'保存 SPU 修改':'创建 SPU'}</button>`:''}
    </form><p id="catalog-error" class="knowledge-form-error" role="alert"></p>`;
    $('catalog-spu-form').onsubmit=saveSpu;
    $('catalog-store').onchange=()=>{const id=value('store');$('catalog-category').innerHTML='<option value="">未分类</option>'+categories.filter(c=>c.storeId===id&&c.status==='enabled').map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')};
    if(current)skuPanel();
    bindRows();
  }
  function skuPanel() {
    $('catalog-editor').insertAdjacentHTML('beforeend',`<div class="catalog-skus"><div class="catalog-section-head"><strong>SKU 规格（${skus.length}）</strong>${ctx.canWrite()?`<button type="button" class="small-link" id="catalog-new-sku" ${busy?'disabled':''}>＋ 新增 SKU</button>`:''}</div><p class="knowledge-form-help">规格可填写颜色、尺寸、型号等任意维度。检索属性用于搜索补充；SKU 停用通过状态修改。</p><div class="knowledge-table-wrap"><table class="table"><thead><tr><th>SKU 编码 / 规格</th><th>状态</th><th>操作</th></tr></thead><tbody>${skus.map(s=>`<tr><td>${esc(s.skuCode)}<span class="knowledge-table-sub">${esc(Object.entries(s.variant||{}).map(([k,v])=>`${k}：${v}`).join(' / ')||'无规格')}<br>更新：${esc(stamp(s.updatedAt))}</span></td><td>${s.status==='active'?'启用':'停用'}</td><td><button class="small-link" type="button" data-sku-open="${esc(s.id)}" ${busy?'disabled':''}>${ctx.canWrite()?'编辑':'查看'}</button></td></tr>`).join('')||'<tr><td colspan="3">还没有 SKU</td></tr>'}</tbody></table></div><div id="catalog-sku-editor"></div></div>`);
    $('catalog-new-sku')?.addEventListener('click',()=>{if(writable()){sku=null;skuEditor()}});
    $('catalog-editor').querySelectorAll('[data-sku-open]').forEach(b=>b.onclick=()=>{sku=skus.find(s=>s.id===b.dataset.skuOpen);skuEditor()});
    if(sku)skuEditor();
  }
  function skuEditor() {
    const s=sku||{};
    $('catalog-sku-editor').innerHTML=`<form id="catalog-sku-form" class="knowledge-form-fields"><h3>${ctx.canWrite()?(sku?'编辑':'新增'):'查看'} SKU</h3>${field('sku-code','SKU 编码 *',s.skuCode)}${field('sku-external','外部 SKU ID',s.externalSkuId,'text',!!sku)}${select('sku-status','状态',[['active','启用'],['inactive','停用']],s.status||'active')}${attributes('catalog-variant','销售规格',s.variant,false)}${attributes('catalog-search','检索属性',s.searchAttributes,false)}${ctx.canWrite()?`<button class="btn primary" type="submit" ${busy?'disabled':''}>${busy?'正在保存…':sku?'保存 SKU 修改':'创建 SKU'}</button>`:''}<button class="btn" id="catalog-sku-cancel" type="button" ${busy?'disabled':''}>收起</button><p id="catalog-sku-error" class="knowledge-form-error" role="alert"></p></form>`;
    $('catalog-sku-form').onsubmit=saveSku;
    $('catalog-sku-cancel').onclick=()=>{sku=null;$('catalog-sku-editor').innerHTML=''};
    bindRows();
  }
  async function load(force=false) {
    if(!ctx?.active()||loading||busy||loaded&&!force&&!invalidated)return;
    loading=true;const n=++epoch;list();editor();
    try {
      const s=await ctx.scope();
      const [rows,cats]=await Promise.all([ctx.api.catalogSpus(s.tenantId),ctx.api.catalogCategories(s.tenantId)]);
      if(n!==epoch||!ctx.active())return;
      scope=s;spus=rows;categories=cats;loaded=true;invalidated=false;current=null;skus=[];sku=null;++detailEpoch;
      $('knowledge-scope-note').className='knowledge-scope-note';
      $('knowledge-scope-note').textContent=`${s.tenantName} · SPU / SKU 详细维护 · ${ctx.canWrite()?'管理员可修改':'客服只读'} · 与旧商品条目独立`;
    } catch(e) {if(n===epoch&&ctx.active()){$('knowledge-scope-note').className='knowledge-scope-note error';$('knowledge-scope-note').textContent=e.message||'商品读取失败，请刷新重试'}}
    finally {if(n===epoch){loading=false;list();editor()}}
  }
  async function open(id) {
    if(!ctx.active()||busy)return;
    const n=++detailEpoch,session=ctx.session;
    $('catalog-editor').innerHTML='<p class="knowledge-form-help">正在读取 SPU 和 SKU…</p>';
    try {const detail=await ctx.api.catalogDetail(scope.tenantId,id);if(n!==detailEpoch||session!==ctx.session||!ctx.active())return;current=detail.spu;skus=detail.skus;sku=null;editor();list()}
    catch(e){if(n===detailEpoch&&ctx.active()){$('catalog-editor').textContent=e.message||'详情读取失败'}}
  }
  function newSpu() {if(!writable()||!loaded||loading)return;++detailEpoch;current=null;skus=[];sku=null;editor();list()}
  async function saveSpu(event) {
    event.preventDefault();if(!writable())return;
    let body;
    try {
      body={title:value('title'),subtitle:nullable('subtitle'),categoryId:nullable('category'),shelfStatus:value('shelf'),mainImageUrl:nullable('image'),productUrl:nullable('url'),sellingPoints:value('points').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),commonAttributes:readAttributes('catalog-common')};
      if(!body.title)throw new Error('请填写商品标题。');
      if(!current){Object.assign(body,{storeId:value('store'),productCode:value('code'),externalProductId:nullable('external'),sourceType:'manual'});if(!body.storeId||!body.productCode)throw new Error('请选择门店并填写 SPU 编码。')}
    }catch(e){$('catalog-error').textContent=e.message;return}
    $('catalog-error').textContent='';
    const n=epoch,session=ctx.session,was=current;
    busy=true;const unlock=lockEditor();list();
    try {
      const p=was?await ctx.api.updateCatalogSpu(scope.tenantId,was.id,body):await ctx.api.createCatalogSpu(scope.tenantId,body);
      if(n!==epoch||session!==ctx.session||!ctx.active())return;
      const i=spus.findIndex(s=>s.id===p.id);if(i<0)spus.unshift(p);else spus[i]=p;current=p;ctx.notify('SPU 已保存到业务后端');
    }catch(e){if(n===epoch&&ctx.active()){$('catalog-error').textContent=e.message||'SPU 保存失败';return}}
    finally{if(n===epoch){busy=false;unlock();if(ctx.active()){if(!errorText())editor();list()}}}
  }
  function errorText() {return $('catalog-error')?.textContent||''}
  function lockEditor() {
    const fields=[...$('catalog-editor').querySelectorAll('input,select,textarea,button'),$('knowledge-add'),$('knowledge-form-reset')];
    const previous=fields.map(e=>e.disabled);fields.forEach(e=>e.disabled=true);
    return ()=>fields.forEach((e,i)=>e.disabled=previous[i]||!ctx.canWrite());
  }
  async function saveSku(event) {
    event.preventDefault();if(!writable()||!current)return;
    let body;const was=sku;
    try {body={skuCode:value('sku-code'),status:value('sku-status'),variant:readAttributes('catalog-variant'),searchAttributes:readAttributes('catalog-search')};if(!body.skuCode)throw new Error('请填写 SKU 编码。');if(!was)body.externalSkuId=nullable('sku-external')}
    catch(e){$('catalog-sku-error').textContent=e.message;return}
    const n=epoch,session=ctx.session;busy=true;
    // 保留输入，在请求期间禁用整块编辑器，避免串写另一条商品。
    const unlock=lockEditor();$('catalog-sku-error').textContent='';list();
    let error='';
    try {const s=was?await ctx.api.updateCatalogSku(scope.tenantId,was.id,body):await ctx.api.createCatalogSku(scope.tenantId,current.id,body);if(n!==epoch||session!==ctx.session||!ctx.active())return;const i=skus.findIndex(v=>v.id===s.id);if(i<0)skus.push(s);else skus[i]=s;sku=s;ctx.notify('SKU 规格已保存到业务后端')}
    catch(e){error=e.message||'SKU 保存失败'}
    finally {if(n===epoch){busy=false;unlock();if(ctx.active()){if(error)$('catalog-sku-error').textContent=error;else editor();list()}}}
  }
  function reset(){++epoch;++detailEpoch;ctx=null;scope=null;spus=[];categories=[];current=null;skus=[];sku=null;loaded=false;loading=false;busy=false;invalidated=false;$('catalog-editor').innerHTML=''}
  // 别处改过目录之后叫这一声。页面不在这一页签时 refresh 不会发请求（load 有 active 门），
  // 但 invalidated 会留着，等进入页签时补读——否则「导入完成」之后看到的是导入前的列表。
  function invalidate(){invalidated=true}
  window.KefuCatalog={render(options){if(ctx?.session!==options.session)reset();ctx={...options};editor();list();void load()},list,newSpu,reset,invalidate,refresh:()=>load(true)};
  // 三处搜索共用的匹配口径，见上面的 spuSearchText；products.js 与 app.js 从这里取。
  window.KefuSpuSearchText = spuSearchText;
})();
