/**
 * 「商品」页签的搜索连着结构化商品库一起搜。
 *
 * 导入写进的是 `product_spus` / `product_skus`，「商品」页签读的却是旧的手工条目表，
 * 所以在那一页搜不到刚导入的商品——这正是「导进去了却找不到」的现场。这组断言盯着
 * 边界：搜到商品库的命中要标出来源、不能在这里编辑、点行进目录页签；没有搜索词时
 * 不并进来；状态筛选两个页签同一口径；商品库读不到时要说明，而不是静默少一半结果。
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));

const spu=(code,title,shelfStatus='on_shelf')=>({id:`p-${code}`,storeId:'s1',productCode:code,title,shelfStatus,commonAttributes:{},sellingPoints:[],updatedAt:'2026-10-08T02:29:08.179Z'});

async function setup({spus=[spu('SPU-1','蕉下长款宽松防晒手套'),spu('SPU-2','蕉下凉感防晒手套',) ],failSpus=false}={}){
 const {JSDOM}=await import('jsdom');
 const ids=['workspace','products','knowledge','phrases','analytics','exports','admin','settings','review','tenants','account','login'];
 const markup=read('index.html').replace('<div id="page-root"></div>',`<div id="page-root">${ids.map(id=>read(`pages/${id}.html`)).join('')}</div>`);
 const dom=new JSDOM(markup,{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 w.structuredClone=structuredClone;
 let spuReads=0;
 w.KefuApi={hasSession:()=>true,clearToken:()=>{},setWorkspaceTenant:()=>{},
  currentSession:async()=>({access:{role:'platform_admin',tenantId:'t1',member:{id:'m1',displayName:'管理员'}},account:{}}),
  health:async()=>{},login:async()=>{},logout:async()=>{},presence:async()=>{},heartbeat:async()=>{},conversations:async()=>[],
  directoryTenants:async()=>[{tenant:{id:'t1',name:'测试公司'},stores:[{id:'s1',name:'门店'}]}],
  // 手工条目只有一条，标题与商品库的命中不重叠，便于区分两块结果。
  knowledgeProducts:async()=>[{id:'old',title:'手工保温杯',description:'手工录入',sku:'OLD-1',enabled:true,storeId:'s1'}],
  knowledgeFaqs:async()=>[],knowledgeShortcuts:async()=>[],
  catalogCategories:async()=>[],catalogSpus:async()=>{spuReads++;if(failSpus)throw new Error('商品库目录读取失败');return spus},
  catalogDetail:async()=>({spu:{},skus:[]})};
 w.KefuRealtime={subscribe:(api,frame,callback)=>{callback('connected');return ()=>{}}};
 w.eval(read('src/mock-data.js'));w.eval(read('src/admin-data.js'));w.eval(read('src/catalog.js'));w.eval(read('src/app.js'));await tick();await tick();
 $('auth-username').value='account';$('auth-secret').value='password';$('auth-submit').click();await tick();await tick();
 w.document.querySelector('[data-view="knowledge"]').click();await tick();await tick();
 const search=async value=>{$('knowledge-search').value=value;$('knowledge-search').dispatchEvent(new w.Event('input',{bubbles:true}));await tick();await tick();await tick()};
 const filter=async value=>{$('knowledge-status-filter').value=value;$('knowledge-status-filter').dispatchEvent(new w.Event('change',{bubbles:true}));await tick();await tick()};
 return {dom,w,$,search,filter,getSpuReads:()=>spuReads};
}

test('在「商品」页签搜索会一并列出商品库的命中，标明来源且只能去维护',async()=>{
 const h=await setup();try{
  const {$,w}=h;
  assert.equal($('knowledge-catalog-matches'),null,'没有搜索词时不并进来');
  assert.match($('knowledge-list').textContent,/手工保温杯/);
  await h.search('蕉下');
  const block=$('knowledge-catalog-matches');
  assert.ok(block,'有搜索词时要有商品库结果区');
  assert.match(block.textContent,/2/);
  assert.match(block.textContent,/蕉下长款宽松防晒手套/);
  assert.match(block.textContent,/SPU-1/);
  assert.match(block.textContent,/SPU \/ SKU/,'要说清这批行来自哪一页，编辑在哪');
  assert.equal(/手工保温杯/.test(block.textContent),false,'手工条目不该混进商品库那一段');
  assert.equal($('knowledge-count').textContent,'0 条手工 + 2 条商品库');
  // 商品库的行只提供「去维护」：切到目录页签并把编码填进同一个搜索框。
  block.querySelector('[data-knowledge-catalog-open]').click();await tick();
  assert.equal(w.document.querySelector('[data-knowledge-tab="catalog"]').classList.contains('active'),true);
  assert.equal($('knowledge-search').value,'SPU-1');
  assert.match($('knowledge-list').textContent,/蕉下长款宽松防晒手套/);
 }finally{h.dom.window.close()}
});

test('搜索词同时命中两套数据时两块都在，计数分开写',async()=>{
 const h=await setup({spus:[spu('SPU-3','手工同款·手套')]});try{
  const {$,w}=h;
  await h.search('手');
  assert.match($('knowledge-list').textContent,/手工保温杯/,'手工条目照旧在上面');
  assert.match($('knowledge-catalog-matches').textContent,/SPU-3/,'商品库的命中在下面');
  assert.equal($('knowledge-count').textContent,'1 条手工 + 1 条商品库');
 }finally{h.dom.window.close()}
});

test('状态筛选只管手工条目，不把上架状态「未知」的导入商品藏起来',async()=>{
 const h=await setup({spus:[spu('UP-1','上架手套'),spu('DOWN-1','下架手套','off_shelf'),spu('UNK-1','未知状态手套','unknown')]});try{
  const {$,w}=h;
  // 用一个同时能命中手工条目和商品库的词，才看得出筛选分别作用在哪一边。
  await h.search('手');
  // 选「已启用」时，商品库的三条都要在：那组选项管的是知识条目的启用 / 停用，
  // 导入的商品没有这个状态，按「已停用＝下架」去套会把它们整批筛没。
  await h.filter('enabled');
  assert.match($('knowledge-catalog-matches').textContent,/UP-1/);
  assert.match($('knowledge-catalog-matches').textContent,/DOWN-1/);
  assert.match($('knowledge-catalog-matches').textContent,/UNK-1/);
  assert.match($('knowledge-catalog-matches').textContent,/状态筛选只作用于手工条目/);
  await h.filter('disabled');
  assert.match($('knowledge-catalog-matches').textContent,/UNK-1/);
  // 手工条目照旧受筛选：唯一那条是启用状态，选「已停用」时它不该出现。
  assert.equal(/手工保温杯/.test($('knowledge-list').textContent),false);
  await h.filter('enabled');
  assert.match($('knowledge-list').textContent,/手工保温杯/);
 }finally{h.dom.window.close()}
});

test('商品库读不到时说明结果只覆盖手工条目，并只读一次不反复重试',async()=>{
 const h=await setup({failSpus:true});try{
  const {$,w}=h;
  await h.search('手套');
  assert.match($('knowledge-catalog-matches').textContent,/商品库目录读取失败/);
  assert.match($('knowledge-catalog-matches').textContent,/只覆盖上面的手工条目/);
  assert.equal(h.getSpuReads(),1);
  await h.search('手套保温');
  assert.equal(h.getSpuReads(),1,'已经失败过就不要每敲一个字再打一次接口');
 }finally{h.dom.window.close()}
});

test('商品库的命中走的是与「SPU / SKU」同一把尺子：公共属性里的词也算',async()=>{
 // 三处搜索曾经各写一份字段数组，商品库那份漏了 commonAttributes，于是同一个词在这两个
 // 页面命中不同。这里钉住「知识库 → 商品」这一侧，另一侧在 product-library.test.cjs。
 const row={...spu('SPU-9','轻享保温杯','unknown'),commonAttributes:{材质:'316 不锈钢'}};
 const h=await setup({spus:[row]});try{
  const {$,w}=h;
  await h.search('不锈钢');
  assert.match($('knowledge-catalog-matches').textContent,/SPU-9/);
  assert.equal($('knowledge-count').textContent,'0 条手工 + 1 条商品库');
 }finally{h.dom.window.close()}
});
