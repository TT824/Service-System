/**
 * 批量导入的入口与表头来源。
 *
 * 这一组盯的是「导进去了却找不到」的三个成因里属于前端的那两个：入口长在商品页签
 * （结果却落在 SPU / SKU），以及 ERP 原表被按本系统字段名硬读。断言的范围就是这两点：
 * 按钮在哪个页签可见、跳转条指到哪、发给服务端的 mapping 是不是所选表头来源那一份。
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));

async function setup(role='platform_admin'){
 const {JSDOM}=await import('jsdom');
 const ids=['workspace','products','knowledge','phrases','analytics','exports','admin','settings','review','tenants','account','login'];
 const markup=read('index.html').replace('<div id="page-root"></div>',`<div id="page-root">${ids.map(id=>read(`pages/${id}.html`)).join('')}</div>`);
 const dom=new JSDOM(markup,{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 w.structuredClone=structuredClone;
 let catalogReads=0,productsRefreshes=0,previews=[],applies=[];
 w.KefuApi={hasSession:()=>true,clearToken:()=>{},setWorkspaceTenant:()=>{},
  currentSession:async()=>({access:{role,tenantId:'t1',member:{id:role,displayName:'管理员'}},account:{}}),
  health:async()=>{},login:async()=>{},logout:async()=>{},presence:async()=>{},heartbeat:async()=>{},conversations:async()=>[],
  directoryTenants:async()=>[{tenant:{id:'t1',name:'测试公司'},stores:[{id:'s1',name:'门店'}]}],
  knowledgeProducts:async()=>[],knowledgeFaqs:async()=>[],knowledgeShortcuts:async()=>[],
  catalogCategories:async()=>[],catalogSpus:async()=>{catalogReads++;return [{id:'p1',storeId:'s1',productCode:'SPU-1',title:'真实结构化商品',shelfStatus:'on_shelf',commonAttributes:{}}]},
  catalogDetail:async()=>({spu:{id:'p1',productCode:'SPU-1',title:'真实结构化商品'},skus:[]}),
  knowledgeIndexStatus:async()=>({counts:{pending:0,indexed:1,failed:0,skipped:0,total:1},embeddings:1,recentFailures:[]}),
  knowledgeImportBatches:async()=>[],
  previewKnowledgeImport:(tenantId,storeId,file,mapping)=>{previews.push({tenantId,storeId,file,mapping});return Promise.resolve({summary:{totalRows:3,previewRowCount:3,failedRowCount:0},issues:[]})},
  applyKnowledgeImport:(tenantId,storeId,file,mapping)=>{applies.push({tenantId,storeId,file,mapping});return Promise.resolve({summary:{successRows:3,createdSpuCount:2,rejectedRowCount:0,unreadableRowCount:0}})}};
 w.KefuRealtime={subscribe:(api,frame,callback)=>{callback('connected');return ()=>{}}};
 w.eval(read('src/mock-data.js'));w.eval(read('src/admin-data.js'));w.eval(read('src/catalog.js'));w.eval(read('src/products.js'));w.eval(read('src/app.js'));await tick();await tick();
 // 商品库页的刷新是 app.js 在导入成功后叫的，换成计数桩才能断言它真的被叫了。
 w.KefuProductLibrary.refresh=()=>{productsRefreshes++};
 $('auth-username').value='account';$('auth-secret').value='password';$('auth-submit').click();await tick();await tick();
 const click=selector=>w.document.querySelector(selector).click();
 const openKnowledge=async()=>{click('[data-view="knowledge"]');await tick()};
 const openCatalogTab=async()=>{click('[data-knowledge-tab="catalog"]');await tick()};
 /** 选文件：jsdom 的 input.files 是只读 getter，只能在实例上覆盖。 */
 const pickFile=(name='erp.csv')=>Object.defineProperty($('knowledge-import-file'),'files',{value:[new w.File(['a,b\n'],name,{type:'text/csv'})],configurable:true});
 const chooseLayout=value=>{const input=w.document.querySelector(`input[name="knowledge-import-layout"][value="${value}"]`);input.checked=true;input.dispatchEvent(new w.Event('change'))};
 return {dom,w,$,click,openKnowledge,openCatalogTab,pickFile,chooseLayout,
  previews,applies,getCatalogReads:()=>catalogReads,getProductRefreshes:()=>productsRefreshes};
}

test('导入入口只在 SPU / SKU 页签可用',async()=>{
 const h=await setup();try{
  await h.openKnowledge();
  // 默认落在「商品」页签：它是手工录入的知识条目，批量导入不在这一页。
  assert.equal(h.$('knowledge-import').hidden,true);
  assert.equal(h.$('knowledge-download-template').hidden,true);
  // 指路条按用户要求删掉了（CHG-20261008-10）：这一页不再有任何指向「SPU / SKU」的入口。
  assert.equal(h.w.document.querySelector('[data-knowledge-goto-catalog]'),null);
  assert.equal(/手工录入的知识条目/.test(h.$('knowledge-list').textContent),false);
  await h.openCatalogTab();
  assert.equal(h.w.document.querySelector('[data-knowledge-tab="catalog"]').classList.contains('active'),true);
  assert.equal(h.$('knowledge-import').hidden,false);
  assert.equal(h.$('knowledge-download-template').hidden,false);
 }finally{h.dom.window.close()}
 const agent=await setup('agent');try{
  // 无写权限的账号即使切到目录页签也不该看到导入入口。
  await agent.openKnowledge();await agent.openCatalogTab();
  assert.equal(agent.$('knowledge-import').hidden,true);
  assert.equal(agent.$('knowledge-download-template').hidden,true);
 }finally{agent.dom.window.close()}
});

test('选 ERP 原表后提交：预览与导入都带 mapping，完成后切回目录页签并刷新两处列表',async()=>{
 const h=await setup();try{
  await h.openKnowledge();await h.openCatalogTab();
  h.$('knowledge-import').click();
  assert.equal(h.$('knowledge-import-optional').hidden,true,'本系统模板不需要可选列');
  h.chooseLayout('erp');
  assert.equal(h.$('knowledge-import-optional').hidden,false,'ERP 原表要问图片与修改时间这两列在不在');
  h.pickFile();
  h.$('modal-confirm').click();await tick();await tick();
  assert.equal(h.previews.length,1);
  // 映射对象长在 jsdom 那个 realm 里，展开成当前 realm 的普通对象再比对。
  assert.deepEqual({...h.previews[0].mapping},{product_code:'款式编码',sku_code:'商品编码',title:'商品名称',main_image_url:'图片',source_updated_at:'修改时间'});
  assert.equal(h.previews[0].tenantId,'t1');assert.equal(h.previews[0].storeId,'s1');
  // 预览之后仍要人点一次「导入 N 行」，检查只报数不写库。
  assert.equal(h.applies.length,0);
  assert.equal(h.$('modal-confirm').textContent,'导入 3 行');
  h.$('knowledge-search').value='SPU-1';
  const readsBefore=h.getCatalogReads();
  h.$('modal-confirm').click();await tick();await tick();
  assert.equal(h.applies.length,1);
  assert.deepEqual(h.applies[0].mapping,h.previews[0].mapping);
  assert.equal(h.$('knowledge-search').value==='',true,'导入完成后残留的搜索词要清掉，否则新商品看起来没进来');
  assert.equal(h.w.document.querySelector('[data-knowledge-tab="catalog"]').classList.contains('active'),true,'导入完成后要停在结果所在的页签');
  assert.equal(h.getCatalogReads()>readsBefore,true,'导入完成后要重新读一次目录');
  assert.equal(h.getProductRefreshes()>=1,true,'商品库页若开着也要刷新');
 }finally{h.dom.window.close()}
});

test('取消可选列后 mapping 里不再出现那一列；模板一行也不带 mapping',async()=>{
 const h=await setup();try{
  await h.openKnowledge();await h.openCatalogTab();
  h.$('knowledge-import').click();h.chooseLayout('erp');
  h.$('knowledge-import-image').checked=false;
  h.pickFile('无图.csv');
  h.$('modal-confirm').click();await tick();await tick();
  assert.equal('main_image_url' in h.previews[0].mapping,false);
  assert.equal(h.previews[0].mapping.source_updated_at,'修改时间');
  // 模板/已整理文件走别名表，不该硬塞映射去覆盖它。
  h.$('modal-cancel').click();
  h.$('knowledge-import').click();h.chooseLayout('template');
  assert.equal(h.$('knowledge-import-optional').hidden,true);
  h.pickFile('模板.csv');
  h.$('modal-confirm').click();await tick();await tick();
  assert.equal(h.previews.length,2);
  assert.equal(h.previews[1].mapping,null);
 }finally{h.dom.window.close()}
});

test('导入请求把 mapping 作为 JSON 放进 multipart，索引状态与批次读带租户头',async()=>{
 const storage=new Map([['kefu.access-token','test-token']]),requests=[];
 const context={window:{},FormData,File,URLSearchParams,sessionStorage:{getItem:k=>storage.get(k),removeItem:k=>storage.delete(k),setItem:(k,v)=>storage.set(k,v)},fetch:async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({data:{summary:{}}})}}};
 vm.createContext(context);vm.runInContext(read('src/api-client.js'),context);
 const api=context.window.KefuApi;
 await api.applyKnowledgeImport('t1','s1',new File(['a,b\n'],'erp.csv'),{product_code:'款式编码',title:'商品名称'});
 const body=requests[0].body;
 assert.equal(requests[0].url,'/api/v1/knowledge/import-batches/apply');
 assert.equal(body.get('storeId'),'s1');
 assert.equal(body.get('file').name,'erp.csv');
 assert.deepEqual(JSON.parse(body.get('mapping')),{product_code:'款式编码',title:'商品名称'});
 await api.previewKnowledgeImport('t1','s1',new File(['a,b\n'],'a.csv'),null);
 assert.equal(requests[1].body.get('mapping'),null,'没有映射时不要发一个空对象');
 await api.knowledgeIndexStatus('t1',{storeId:'s1',status:'failed'});
 await api.knowledgeImportBatches('t1');
 assert.equal(requests[2].url,'/api/v1/knowledge/index-status?storeId=s1&status=failed');
 assert.equal(requests[3].url,'/api/v1/knowledge/import-batches');
 for(const request of requests)assert.equal(request.headers['x-tenant-id'],'t1');
});
