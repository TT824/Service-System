const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function setup(editable=true){
  const {JSDOM}=await import('jsdom');
  const dom=new JSDOM(read('pages/knowledge.html'),{url:'http://localhost/',runScripts:'outside-only'});
  const w=dom.window,$=id=>w.document.getElementById(id),calls=[];
  let rows=[{id:'v1',faqId:'f1',questionText:'什么时候发货？',source:'imported',status:'enabled',updatedAt:'2026-10-04T01:00:00Z'}];
  const api={faqVariants:async(...args)=>{calls.push(['read',...args]);return structuredClone(rows.filter(row=>row.faqId===args[1]))},
    createFaqVariant:async(tenant,faqId,input)=>{calls.push(['create',tenant,faqId,input]);const saved={id:'v2',faqId,...input,status:'enabled'};rows.push(saved);return saved},
    updateFaqVariant:async(tenant,id,input)=>{calls.push(['update',tenant,id,input]);rows=rows.map(row=>row.id===id?{...row,...input}:row);return rows.find(row=>row.id===id)}};
  let active=true,write=editable;
  const options={api,scope:async()=>({tenantId:'t1'}),faq:{id:'f1'},session:{},active:()=>active,canWrite:()=>write,notify:()=>{}};
  w.eval(read('src/faq-variants.js'));w.KefuFaqVariants.render(options);await tick();
  return {dom,w,$,api,calls,options,submit:()=> $('faq-variant-form').dispatchEvent(new w.Event('submit',{cancelable:true})),setWrite:v=>write=v,setActive:v=>active=v};
}
test('管理员查询、添加、修改和停用近似问法，再次读取保留后端保存结果及来源',async()=>{
  const h=await setup();try{
    assert.deepEqual(h.calls[0],['read','t1','f1']);assert.match(h.$('faq-variants-list').textContent,/什么时候发货/);assert.match(h.$('faq-variants-list').textContent,/导入/);
    h.$('faq-variant-question').value=' 今天下单几时发货？ ';h.submit();await tick();
    assert.equal(h.calls[1][0],'create');assert.equal(h.calls[1][2],'f1');assert.equal(h.calls[1][3].questionText,'今天下单几时发货？');assert.equal(h.calls[1][3].source,'manual');
    assert.match(h.$('faq-variant-count').textContent,/2 条启用 \/ 共 2 条/);
    h.$('faq-variant-question').value='下单后多久发货？';h.$('faq-variant-status').value='disabled';h.submit();await tick();
    assert.equal(h.calls[2][0],'update');assert.equal(h.calls[2][2],'v2');assert.equal(h.calls[2][3].status,'disabled');
    h.w.KefuFaqVariants.reset();h.w.KefuFaqVariants.render(h.options);await tick();
    assert.match(h.$('faq-variants-list').textContent,/下单后多久发货/);assert.match(h.$('faq-variant-count').textContent,/1 条启用 \/ 共 2 条/);
    h.w.document.querySelector('[data-variant-edit="v1"]').click();h.$('faq-variant-question').value='改写进口问法';h.submit();await tick();
    assert.match(h.$('faq-variants-list').textContent,/导入/);assert.equal('source' in h.calls.at(-1)[3],false);
  }finally{h.dom.window.close()}
});
test('客服只读仍可查询及刷新；伪造提交事件不能调用写接口',async()=>{
  const h=await setup(false);try{
    assert.match(h.$('faq-variants-list').textContent,/什么时候发货/);assert.equal(h.$('faq-variant-form').hidden,true);assert.equal(h.$('faq-variant-question').disabled,true);
    assert.equal(h.w.document.querySelector('[data-variant-edit]'),null);h.submit();h.$('faq-variant-new').click();await tick();assert.equal(h.calls.length,1);
    h.$('faq-variant-refresh').click();await tick();assert.equal(h.calls.length,2);assert.equal(h.calls[1][0],'read');
  }finally{h.dom.window.close()}
});
test('空白校验、防重复提交、保存失败保留草稿；查询失败可重试且不会冒充空列表',async()=>{
  const h=await setup();try{
    h.$('faq-variant-question').value='  ';h.submit();assert.match(h.$('faq-variant-error').textContent,/请填写/);assert.equal(h.calls.length,1);
    let reject;let writes=0;h.api.createFaqVariant=()=>{writes++;return new Promise((resolve,r)=>reject=r)};
    h.$('faq-variant-question').value='保留的草稿';h.submit();h.submit();await tick();assert.equal(writes,1);assert.equal(h.$('faq-variant-question').disabled,true);
    reject(new Error('保存失败'));await tick();assert.equal(h.$('faq-variant-question').value,'保留的草稿');assert.match(h.$('faq-variant-error').textContent,/保存失败/);assert.equal(h.$('faq-variant-save').disabled,false);
    const original=h.api.faqVariants;h.api.faqVariants=async()=>{throw new Error('没有读取权限')};h.$('faq-variant-refresh').click();await tick();
    assert.match(h.$('faq-variant-error').textContent,/没有读取权限/);assert.doesNotMatch(h.$('faq-variants-list').textContent,/暂无近似问法/);assert.equal(h.$('faq-variant-save').disabled,true);
    h.api.faqVariants=original;h.$('faq-variant-refresh').click();await tick();assert.match(h.$('faq-variants-list').textContent,/什么时候发货/);assert.equal(h.$('faq-variant-question').value,'保留的草稿');
  }finally{h.dom.window.close()}
});
test('切换 FAQ、清空及退出后忽略迟到查询和写入结果；不串问法或泄露旧账号内容',async()=>{
  const h=await setup();try{
    let resolveRead;h.api.faqVariants=()=>new Promise(r=>resolveRead=r);h.$('faq-variant-refresh').click();await tick();
    const oldResolve=resolveRead;h.w.KefuFaqVariants.render({...h.options,faq:{id:'f2'},api:{...h.api,faqVariants:async()=>[]}});await tick();
    oldResolve([{id:'secret',questionText:'旧FAQ秘密'}]);await tick();assert.doesNotMatch(h.$('faq-variants-list').textContent,/秘密/);
    let resolveWrite;h.api.createFaqVariant=()=>new Promise(r=>resolveWrite=r);
    h.w.KefuFaqVariants.render({...h.options,faq:{id:'f3'},api:{...h.api,faqVariants:async()=>[]}});await tick();h.$('faq-variant-question').value='旧写入草稿';h.submit();await tick();
    h.w.KefuFaqVariants.render({...h.options,faq:null});assert.match(h.$('faq-variants-list').textContent,/先保存/);assert.equal(h.$('faq-variant-form').hidden,true);
    resolveWrite({id:'late',questionText:'不应显示的结果',status:'enabled'});await tick();assert.doesNotMatch(h.$('faq-variants-editor').textContent,/不应显示/);
    h.w.KefuFaqVariants.render({...h.options,session:{},api:{...h.api,faqVariants:()=>new Promise(r=>resolveRead=r)}});await tick();h.w.KefuFaqVariants.reset();
    resolveRead([{id:'late',questionText:'旧账号秘密'}]);await tick();assert.equal(h.$('faq-variants-editor').textContent,'');assert.equal(h.$('faq-variants-editor').hidden,true);
  }finally{h.dom.window.close()}
});
test('API 适配使用近似问法真实路径、编码 ID、Bearer 和租户头',async()=>{
  const {JSDOM}=await import('jsdom');const dom=new JSDOM('',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,requests=[];
  try{
    w.sessionStorage.setItem('kefu.access-token','test-token');w.fetch=async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({data:[]})}};w.eval(read('src/api-client.js'));
    await w.KefuApi.faqVariants('t1','faq/1');await w.KefuApi.createFaqVariant('t1','f1',{questionText:'发货？',source:'manual'});await w.KefuApi.updateFaqVariant('t1','v/1',{questionText:'多久发货？',status:'disabled'});
    assert.deepEqual(requests.map(r=>r.url),['/api/v1/knowledge/faqs/faq%2F1/variants','/api/v1/knowledge/faqs/f1/variants','/api/v1/knowledge/faq-variants/v%2F1']);
    for(const request of requests){assert.equal(request.headers.authorization,'Bearer test-token');assert.equal(request.headers['x-tenant-id'],'t1')}
    assert.equal(requests[1].method,'POST');assert.equal(requests[2].method,'PATCH');assert.equal(JSON.parse(requests[2].body).status,'disabled');
  }finally{w.close()}
});
test('完整知识库：新 FAQ 保存后开放问法维护，切换页签和退出清理编辑器',async()=>{
  const {JSDOM}=await import('jsdom');const ids=['workspace','products','knowledge','phrases','analytics','exports','admin','settings','review','tenants','account','login'];
  const dom=new JSDOM(read('index.html').replace('<div id="page-root"></div>',`<div id="page-root">${ids.map(id=>read(`pages/${id}.html`)).join('')}</div>`),{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);w.structuredClone=structuredClone;
  let hasSession=true,reads=0;
  w.KefuApi={hasSession:()=>hasSession,health:async()=>{},currentSession:async()=>({access:{role:'platform_admin',tenantId:'t1',member:{id:'admin',displayName:'管理员'}},account:{}}),setWorkspaceTenant:()=>{},clearToken:()=>{hasSession=false},logout:async()=>{},conversations:async()=>[],
    directoryTenants:async()=>[{tenant:{id:'t1',name:'公司'},stores:[{id:'s1',name:'门店'}]}],knowledgeProducts:async()=>[],knowledgeFaqs:async()=>[],knowledgeShortcuts:async()=>[],
    createKnowledgeFaq:async(t,input)=>({id:'saved-faq',...input,enabled:true}),faqVariants:async(t,id)=>{assert.equal(id,'saved-faq');reads++;return []}};
  w.KefuRealtime={subscribe:()=>()=>{}};
  try{
    for(const script of ['mock-data','admin-data','catalog','faq-variants','app'])w.eval(read(`src/${script}.js`));await tick();await tick();
    w.document.querySelector('[data-view="knowledge"]').click();w.document.querySelector('[data-knowledge-tab="faqs"]').click();await tick();
    assert.match($('faq-variants-editor').textContent,/先保存/);assert.equal($('faq-variant-form').hidden,true);
    $('knowledge-faq-question').value='何时发货？';$('knowledge-faq-answer').value='48小时内';$('knowledge-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
    assert.equal(reads,1);assert.equal($('faq-variant-save').disabled,false);
    w.document.querySelector('[data-knowledge-tab="products"]').click();assert.equal($('faq-variants-editor').hidden,true);
    w.document.querySelector('[data-knowledge-tab="faqs"]').click();w.document.querySelector('[data-knowledge-open]').click();await tick();assert.equal(reads,2);
    $('profile-sign-out').click();await tick();assert.equal($('faq-variants-editor').textContent,'');assert.equal($('faq-variants-editor').hidden,true);
  }finally{w.close()}
});
