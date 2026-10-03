const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
async function setup(){
 const {JSDOM}=await import('jsdom');
 const ids=['workspace','products','knowledge','phrases','analytics','exports','admin','settings','review','tenants','account','login'];
 const markup=read('index.html').replace('<div id="page-root"></div>',`<div id="page-root">${ids.map(id=>read(`pages/${id}.html`)).join('')}</div>`);
 const dom=new JSDOM(markup,{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);w.structuredClone=structuredClone;
 let role='platform_admin',hasSession=true,state,resolveProducts,reads=0;
 const directories=[{tenant:{id:'t1',name:'测试公司'},stores:[{id:'s1',name:'门店'}]}];
 w.KefuApi={hasSession:()=>hasSession,currentSession:async()=>({access:{role,tenantId:'t1',member:{id:role,displayName:role==='agent'?'客服':'管理员'}},account:{}}),health:async()=>{},
  login:async()=>{hasSession=true},logout:async()=>{hasSession=false},clearToken:()=>{hasSession=false},setWorkspaceTenant:()=>{},presence:async()=>{},heartbeat:async()=>{},conversations:async()=>[],directoryTenants:async()=>directories,
  knowledgeProducts:()=>new Promise(r=>resolveProducts=r),knowledgeFaqs:async()=>[],knowledgeShortcuts:async()=>[],catalogCategories:async()=>[],catalogSpus:async()=>{reads++;return [{id:'p1',storeId:'s1',productCode:'SPU-1',title:'真实结构化商品',shelfStatus:'on_shelf',commonAttributes:{}}]},catalogDetail:async()=>({spu:{id:'p1',storeId:'s1',productCode:'SPU-1',title:'真实结构化商品'},skus:[]})};
 w.KefuRealtime={subscribe:(api,frame,callback)=>{state=callback;callback('connected');return ()=>{}}};
 w.eval(read('src/mock-data.js'));w.eval(read('src/admin-data.js'));w.eval(read('src/catalog.js'));w.eval(read('src/app.js'));await tick();await tick();
 const clickKnowledge=()=>w.document.querySelector('[data-view="knowledge"]').click();
 const clickCatalog=()=>w.document.querySelector('[data-knowledge-tab="catalog"]').click();
 const login=async(nextRole='platform_admin')=>{role=nextRole;$('auth-username').value='account';$('auth-secret').value='password';$('auth-submit').click();await tick();await tick()};
 return {dom,w,$,clickKnowledge,clickCatalog,login,expire:()=>state('unauthorized'),getReads:()=>reads,resolveOld:rows=>resolveProducts(rows)};
}
test('真实管理员能维护；退出后清除角色和两种知识数据，重新登录恢复管理员入口',async()=>{
 const h=await setup();try{
  h.clickKnowledge();await tick();h.clickCatalog();await tick();
  assert.equal(h.$('knowledge-add').hidden,false);assert.equal(h.$('catalog-title').disabled,false);assert.match(h.$('knowledge-list').textContent,/真实结构化商品/);
  h.resolveOld([{id:'old',title:'旧简单商品',sku:'OLD',enabled:true}]);await tick();assert.match(h.$('knowledge-list').textContent,/真实结构化商品/);assert.doesNotMatch(h.$('knowledge-list').textContent,/旧简单商品/);
  h.w.document.querySelector('[data-catalog-open]').click();await tick();assert.equal(h.$('catalog-title').value,'真实结构化商品');
  h.$('profile-sign-out').click();await tick();
  assert.equal(h.$('role-select').value,'unauth');assert.equal(h.$('role-select').disabled,true);assert.match(h.$('backend-status').textContent,/已退出/);assert.equal(h.$('catalog-editor').textContent,'');assert.equal(h.$('knowledge-list').textContent,'');assert.equal(h.$('login').classList.contains('active'),true);
  const reads=h.getReads();h.clickKnowledge();assert.equal(h.$('knowledge').classList.contains('active'),false);assert.equal(h.getReads(),reads);
  await h.login();h.clickKnowledge();await tick();assert.equal(h.$('knowledge-add').hidden,false);assert.equal(h.$('catalog-title').disabled,false);
  h.expire();assert.equal(h.$('role-select').value,'unauth');assert.equal(h.$('knowledge-list').textContent,'');assert.equal(h.$('login').classList.contains('active'),true);
  await h.login('agent');h.clickKnowledge();await tick();assert.equal(h.$('knowledge-add').hidden,true);assert.equal(h.$('catalog-title').disabled,true);
 }finally{h.dom.window.close()}
});
test('退出后迟到的旧知识读取不能重新显示列表；REST 失效事件清除管理员身份',async()=>{
 const h=await setup();try{
  h.clickKnowledge();await tick();h.$('profile-sign-out').click();await tick();h.resolveOld([{id:'old',title:'不应残留的知识',sku:'SECRET',enabled:true}]);await tick();
  assert.equal(h.$('knowledge-list').textContent,'');assert.equal(h.$('login').classList.contains('active'),true);
  await h.login();h.clickKnowledge();h.clickCatalog();await tick();h.w.dispatchEvent(new h.w.Event('kefu:session-expired'));
  assert.equal(h.$('role-select').value,'unauth');assert.equal(h.$('catalog-editor').textContent,'');assert.match(h.$('backend-status').textContent,/失效/);
 }finally{h.dom.window.close()}
});
test('鉴权请求 401 清除令牌并发出失效事件；密码登录失败不冒充已登录失效',async()=>{
 const {JSDOM}=await import('jsdom');const dom=new JSDOM('',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
 try{
  w.fetch=async()=>({ok:false,status:401,json:async()=>({code:'unauthorized',message:'令牌已失效'})});w.eval(read('src/api-client.js'));
  let expired=0;w.addEventListener('kefu:session-expired',()=>expired++);w.sessionStorage.setItem('kefu.access-token','expired-token');
  await assert.rejects(w.KefuApi.catalogSpus('tenant'));assert.equal(expired,1);assert.equal(w.KefuApi.hasSession(),false);
  await assert.rejects(w.KefuApi.login('admin','wrong-password'));assert.equal(expired,1);
 }finally{w.close()}
});
