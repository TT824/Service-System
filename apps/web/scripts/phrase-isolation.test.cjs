/**
 * 个人快捷短语只属于本人。
 *
 * 这一组盯的是「个人短语互通」：登录之后，别人的个人短语不能出现在列表、选用面板和回复框
 * 联想里，自己新建与启停要走服务端而不是本地内存。断言的范围就是这四件事——页面上画了哪些
 * 行、右侧面板列了哪些、联想浮层给不给、写请求发了什么。归属的最终裁决在服务端（
 * `/personal-phrases` 只按会话里的成员读写），前端这层的过滤是让人看不到、也点不到别人的行。
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));

/** 服务端那一行个人短语的形状（字段名与 /personal-phrases 的返回一致）。 */
const row=(id,memberId,title,text,keywords=[])=>({id,tenantId:'t1',memberId,category:'售前',title,keywords,text,enabled:true,updatedAt:'2026-10-08T03:00:00.000Z',createdAt:'2026-10-08T03:00:00.000Z'});

async function setup(memberId,initialRows){
 const {JSDOM}=await import('jsdom');
 const ids=['workspace','products','knowledge','phrases','analytics','exports','admin','settings','review','tenants','account','login'];
 const markup=read('index.html').replace('<div id="page-root"></div>',`<div id="page-root">${ids.map(id=>read(`pages/${id}.html`)).join('')}</div>`);
 const dom=new JSDOM(markup,{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 w.structuredClone=structuredClone;
 const rows=[...initialRows],created=[],patches=[];
 w.KefuApi={hasSession:()=>true,clearToken:()=>{},setWorkspaceTenant:()=>{},health:async()=>{},logout:async()=>{},
  currentSession:async()=>({access:{role:'agent',tenantId:'t1',member:{id:memberId,displayName:'客服'}},account:{}}),
  login:async()=>({}),presence:async()=>{},heartbeat:async()=>{},conversations:async()=>[],
  directoryTenants:async()=>[{tenant:{id:'t1',name:'测试公司'},stores:[{id:'s1',name:'门店'}],members:[]}],
  internalPeers:async()=>[],internalThreads:async()=>[],
  knowledgeProducts:async()=>[],knowledgeFaqs:async()=>[],knowledgeShortcuts:async()=>[],
  personalPhrases:async()=>rows.map(item=>({...item})),
  createPersonalPhrase:async input=>{created.push(input);const stored=row(`phrase-new-${created.length}`,memberId,input.title,input.text,input.keywords||[]);rows.unshift(stored);return stored},
  updatePersonalPhrase:async(id,patch)=>{patches.push({id,patch});const found=rows.find(item=>item.id===id);if(found)Object.assign(found,patch);return found}};
 w.KefuRealtime={subscribe:(api,frame,callback)=>{callback('connected');return ()=>{}}};
 w.eval(read('src/mock-data.js'));w.eval(read('src/admin-data.js'));w.eval(read('src/catalog.js'));w.eval(read('src/products.js'));w.eval(read('src/app.js'));await tick();await tick();
 $('auth-username').value='account';$('auth-secret').value='password';$('auth-submit').click();await tick();await tick();
 const click=selector=>w.document.querySelector(selector).click();
 const openPhrases=async()=>{click('[data-view="phrases"]');await tick();await tick()};
 /** 在回复框里敲一个词，看联想浮层列了谁。 */
 const type=async text=>{const reply=$('reply');reply.focus();reply.value=text;reply.dispatchEvent(new w.Event('input'));await tick()};
 return {dom,w,$,click,openPhrases,type,rows,created,patches};
}

test('登录后只看得到自己的个人短语，别人的不进列表、不进右侧面板',async()=>{
 const h=await setup('u-t1-agent-1',[row('p-mine','u-t1-agent-1','我的欢迎语','您好，我是陈小雨。',['欢迎']),row('p-other','u-t1-agent-2','同事的短语','这是同事自己写的话术。',['暗号'])]);
 try{
  await h.openPhrases();
  assert.equal(h.rows.length,2,'桩数据里两个人各一条');
  const table=h.$('phrase-rows').textContent;
  assert.match(table,/我的欢迎语/);
  assert.equal(/同事的短语/.test(table),false,'同事的个人短语不该出现在我的列表里');
  // mock 里那两条演示个人短语（ownerId=demo-agent）登录后同样不该出现。
  assert.equal(/稍后回复/.test(table),false);
  // 右侧选用面板同一把尺子：别人的短语连 id 都拿不到。
  assert.equal(/同事的短语/.test(h.$('phrase-aside-list').textContent),false);
  assert.equal(h.w.document.querySelector('[data-phrase-insert="p-other"]'),null);
  assert.equal(h.w.document.querySelector('[data-phrase-toggle="p-other"]'),null);
 }finally{h.dom.window.close()}
});

test('回复框联想只给本人的个人短语加上团队短语',async()=>{
 const h=await setup('u-t1-agent-1',[row('p-mine','u-t1-agent-1','我的欢迎语','您好，我是陈小雨。',['欢迎']),row('p-other','u-t1-agent-2','同事的短语','这是同事自己写的话术。',['暗号'])]);
 try{
  await h.openPhrases();
  await h.type('暗号');
  assert.equal(h.$('phrase-suggestions').hidden,true,'别人的关键词不该唤出联想');
  assert.equal(h.$('phrase-options').textContent,'');
  await h.type('欢迎');
  assert.equal(h.$('phrase-suggestions').hidden,false,'自己的关键词要能唤出联想');
  assert.match(h.$('phrase-options').textContent,/我的欢迎语/);
 }finally{h.dom.window.close()}
});

test('新建个人短语写服务端，请求里没有归属人；回来后列表以服务端为准',async()=>{
 const h=await setup('u-t1-agent-1',[]);
 try{
  await h.openPhrases();
  h.click('#add-phrase');
  h.$('phrase-title-field').value='新的跟进语';
  h.$('phrase-category-field').value='跟进';
  h.$('phrase-keywords-field').value='跟进，稍后';
  h.$('phrase-text-field').value='我先帮您核实，稍后回复您。';
  h.$('modal-confirm').click();await tick();await tick();
  assert.equal(h.created.length,1);
  const sent=h.created[0];
  // 请求体是 jsdom 那个 realm 里的对象（连 keywords 数组也是），JSON 走一圈换成当前 realm 的普通对象再比。
  assert.deepEqual(JSON.parse(JSON.stringify(sent)),{title:'新的跟进语',text:'我先帮您核实，稍后回复您。',category:'跟进',keywords:['跟进','稍后']});
  assert.equal('ownerId' in sent,false,'归属由服务端按会话决定，前端连字段都不该发');
  assert.equal('memberId' in sent,false);
  assert.equal(h.$('modal-bg').classList.contains('show'),false,'写成功才关弹窗');
  assert.match(h.$('phrase-rows').textContent,/新的跟进语/);
  assert.match(h.$('phrase-scope-note').textContent,/仅自己可见和编辑/);
 }finally{h.dom.window.close()}
});

test('启停自己的个人短语走 PATCH，失败时保留本地状态并提示',async()=>{
 const h=await setup('u-t1-agent-1',[row('p-mine','u-t1-agent-1','我的欢迎语','您好，我是陈小雨。',['欢迎'])]);
 try{
  await h.openPhrases();
  h.w.document.querySelector('[data-phrase-toggle="p-mine"]').click();await tick();await tick();
  assert.deepEqual(h.patches.map(entry=>({...entry.patch})),[{enabled:false}]);
  assert.match(h.$('phrase-rows').textContent,/已停用/);
 }finally{h.dom.window.close()}
});

test('演示模式（没有后端会话）仍然是 mock 里那两条示例个人短语',async()=>{
 const {JSDOM}=await import('jsdom');
 const ids=['workspace','products','knowledge','phrases','analytics','exports','admin','settings','review','tenants','account','login'];
 const markup=read('index.html').replace('<div id="page-root"></div>',`<div id="page-root">${ids.map(id=>read(`pages/${id}.html`)).join('')}</div>`);
 const dom=new JSDOM(markup,{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 w.structuredClone=structuredClone;
 let phraseReads=0;
 w.KefuApi={hasSession:()=>false,clearToken:()=>{},health:async()=>{},currentSession:async()=>({}),presence:async()=>{},heartbeat:async()=>{},personalPhrases:async()=>{phraseReads++;return []}};
 w.KefuRealtime={subscribe:(api,frame,callback)=>{callback('connected');return ()=>{}}};
 w.eval(read('src/mock-data.js'));w.eval(read('src/admin-data.js'));w.eval(read('src/catalog.js'));w.eval(read('src/products.js'));w.eval(read('src/app.js'));await tick();await tick();
 try{
  w.document.querySelector('[data-view="phrases"]').click();await tick();
  assert.match($('phrase-rows').textContent,/欢迎咨询/);
  assert.equal(phraseReads,0,'没有后端会话时不该去问服务端要个人短语');
 }finally{dom.window.close()}
});
