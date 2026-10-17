/**
 * 商品库页读真数据。
 *
 * 这一页原来把统计、列表和索引状态都写成演示值，导入完成也从来不会变——「导进去了却
 * 找不到」有一半是因为这里。断言的重点因此是：页面上每个数字都来自接口返回值，
 * 点行内的入口会把款式编码带去知识库的 SPU / SKU 页签，以及换账号后旧数据不残留。
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));

const categories=[{id:'c1',name:'杯子',status:'enabled'},{id:'c2',name:'杯盖',status:'disabled'}];
const spu=(index,extra={})=>({id:`p${index}`,storeId:'s1',productCode:`SPU-${index}`,title:`商品 ${index}`,categoryId:'c1',shelfStatus:'on_shelf',sourceType:'erp_import',updatedAt:'2026-10-01T02:00:00.000Z',...extra});

async function setup(){return setupWith()}

async function setupWith(overrides={}){
 const {JSDOM}=await import('jsdom');
 const dom=new JSDOM(read('pages/products.html'),{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 const api={catalogSpus:async()=>[spu(1)],catalogCategories:async()=>categories,
  knowledgeIndexStatus:async()=>({counts:{pending:1,indexed:4,failed:1,skipped:1,total:6},embeddings:4,
   recentFailures:[{sourceKind:'spu',sourceId:'p9',indexStatus:'failed',indexAttempts:3,indexError:'模型服务不可用'}]}),
  knowledgeImportBatches:async()=>[{id:'b1',storeId:'s1',status:'completed',totalRows:10,successRows:9,failedRows:1,createdAt:'2026-10-02T03:00:00.000Z'}],...overrides};
 let active=true,write=true;
 const options={api,scope:async()=>({tenantId:'t1',tenantName:'测试公司',storeId:'s1',stores:[{id:'s1',name:'门店'}]}),
  canWrite:()=>write,active:()=>active,session:{id:'s'},notify:()=>{},
  openImport:()=>calls.push('import'),downloadTemplate:()=>calls.push('template'),
  gotoCatalog:code=>calls.push(`goto:${code}`)};
 // 搜索口径来自 catalog.js 暴露的 window.KefuSpuSearchText（真实页面里也是这个加载顺序）。
 vm.runInContext(read('src/catalog.js'),dom.getInternalVMContext());
 vm.runInContext(read('src/products.js'),dom.getInternalVMContext());
 w.KefuProductLibrary.open(options);await tick();await tick();await tick();
 return {dom,w,$,api,options,calls,setActive:v=>active=v,setWrite:v=>write=v,
  fire:(id,type)=>{const el=$(id);el.dispatchEvent(new w.Event(type,{bubbles:true}))}};
}

test('统计、索引状态、导入批次和列表都来自接口返回值',async()=>{
 const h=await setup();try{
  const {$,w}=h;
  assert.equal($('products-stat-spu').textContent,'1');
  assert.equal($('products-stat-category').textContent,'1','停用的类目不计入');
  assert.equal($('products-stat-indexed').textContent,'4 / 6');
  assert.equal($('products-stat-attention').textContent,'1 / 2','失败要带上已放弃的 skipped');
  assert.equal($('products-index-pill').textContent,'1 条待索引');
  assert.equal($('products-index-embeddings').textContent,'4');
  assert.match($('products-index-failures').textContent,/模型服务不可用/);
  assert.match($('products-index-failures').textContent,/第 3 次/);
  const batch=$('products-batches').textContent;
  assert.match(batch,/完成/);assert.match(batch,/9 \/ 1/);assert.match(batch,/门店/);
  const list=$('products-list').textContent;
  assert.match(list,/商品 1/);assert.match(list,/SPU-1/);assert.match(list,/杯子/);assert.match(list,/上架/);assert.match(list,/erp_import/);
  assert.match($('products-scope-note').textContent,/测试公司/);
 }finally{h.dom.window.close()}
});

test('行内入口把款式编码带去知识库维护页；无写权限时页头两个按钮不出现',async()=>{
 const h=await setup();try{
  assert.equal(h.$('import-products').hidden,false);assert.equal(h.$('download-template').hidden,false);
  h.$('import-products').click();h.$('download-template').click();
  assert.deepEqual(h.calls,['import','template']);
  h.w.document.querySelector('[data-products-maintain]').click();
  assert.deepEqual(h.calls,['import','template','goto:SPU-1']);
 }finally{h.dom.window.close()}
 const readOnly=await setupWith();readOnly.setWrite(false);
 readOnly.w.KefuProductLibrary.open({...readOnly.options,canWrite:()=>false});await tick();
 try{
  assert.equal(readOnly.$('import-products').hidden,true);
  assert.equal(readOnly.$('download-template').hidden,true);
  assert.match(readOnly.$('products-scope-note').textContent,/客服只读/);
 }finally{readOnly.dom.window.close()}
});

test('搜索与上架状态筛选在本地过滤，翻页按钮按需出现',async()=>{
 const rows=Array.from({length:55},(_,index)=>spu(index+1,index===54?{shelfStatus:'off_shelf',title:'末页商品'}:{}));
 const h=await setupWith({catalogSpus:async()=>rows});try{
  const {$,fire,w}=h;
  assert.match($('products-list-note').textContent,/显示 50 \/ 55/);
  assert.ok($('products-more'),'超过一页时要能继续显示');
  $('products-more').click();
  assert.match($('products-list-note').textContent,/显示 55 \/ 55/);
  assert.equal($('products-more'),null);
  $('products-search').value='末页';fire('products-search','input');
  assert.match($('products-list').textContent,/末页商品/);assert.doesNotMatch($('products-list').textContent,/商品 2/);
  $('products-search').value='';fire('products-search','input');
  $('products-status-filter').value='off_shelf';fire('products-status-filter','change');
  assert.match($('products-list-note').textContent,/显示 1 \/ 1/);
  assert.match($('products-list').textContent,/末页商品/);
 }finally{h.dom.window.close()}
});

test('接口失败在范围条上报错；换账号后旧账号的目录与索引状态不残留',async()=>{
 let reject;const h=await setupWith({catalogSpus:()=>new Promise((resolve,rejectFn)=>{reject=rejectFn})});
 try{
  assert.equal(h.$('products-stat-spu').textContent,'—');
  reject(new Error('目录读取失败'));
  await tick();
  assert.equal(h.$('products-scope-note').textContent,'目录读取失败');
  assert.equal(h.$('products-scope-note').className,'knowledge-scope-note error');
 }finally{h.dom.window.close()}
 const first=await setup();let resolveLate,firstCall=true;
 first.api.knowledgeIndexStatus=()=>{if(firstCall){firstCall=false;return new Promise(r=>{resolveLate=r})}
  return Promise.resolve({counts:{pending:0,indexed:1,failed:0,skipped:0,total:1},embeddings:1,recentFailures:[]})};
 first.w.KefuProductLibrary.refresh();
 first.w.KefuProductLibrary.leave();
 first.w.KefuProductLibrary.open({...first.options,session:{id:'other'}});await tick();await tick();await tick();
 resolveLate({counts:{pending:0,indexed:99,failed:0,skipped:0,total:99},embeddings:99,recentFailures:[]});await tick();await tick();
 try{
  assert.equal(first.$('products-index-embeddings').textContent,'1','旧账号迟到的索引状态不能覆盖新账号的页面');
  assert.equal(first.$('products-stat-spu').textContent,'1');
 }finally{first.dom.window.close()}
});

test('搜索口径与知识库共用一份：只写在公共属性里的词也搜得到',async()=>{
 // 这一页原来的字段数组漏了 commonAttributes，「知识库」页搜得到的词在这里搜不到——
 // 同一个词两个页面给出不同命中，正是三份谓词各写一份的后果。
 const h=await setupWith({catalogSpus:async()=>[spu(1,{title:'轻享保温杯',commonAttributes:{材质:'316 不锈钢'}})]});
 try{
  const {$,fire}=h;
  $('products-search').value='不锈钢';fire('products-search','input');
  assert.match($('products-list').textContent,/轻享保温杯/);
  assert.match($('products-list-note').textContent,/显示 1 \/ 1/);
  $('products-search').value='316 不锈钢';fire('products-search','input');
  assert.match($('products-list').textContent,/轻享保温杯/,'带空格的写法同样命中');
 }finally{h.dom.window.close()}
});
