const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const tick=()=>new Promise(r=>setTimeout(r,0));
async function setup(editable=true){
 const {JSDOM}=await import('jsdom');
 const dom=new JSDOM(fs.readFileSync(path.resolve(__dirname,'../pages/knowledge.html'),'utf8'),{runScripts:'outside-only'});
 const w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 const p={id:'p1',storeId:'s1',productCode:'CUP-1',title:'保温杯',shelfStatus:'on_shelf',commonAttributes:{容量:500,食品级:true},sellingPoints:['保温'],sourceType:'manual'};
 const s={id:'k1',skuCode:'CUP-RED',variant:{颜色:'红色',尺寸:'500ml'},searchAttributes:{别名:'红杯'},status:'active'};
 const api={catalogSpus:async()=>[p],catalogCategories:async()=>[],catalogDetail:async()=>({spu:p,skus:[s]})};
 for(const method of ['createCatalogSpu','updateCatalogSpu','createCatalogSku','updateCatalogSku'])api[method]=async(...args)=>{calls.push([method,...args]);const body=args.at(-1);return {...(method.includes('Spu')?p:s),...body}};
 let active=true,write=editable;
 const options={api,scope:async()=>({tenantId:'t1',storeId:'s1',tenantName:'公司',stores:[{id:'s1',name:'门店'}]}),canWrite:()=>write,active:()=>active,session:{},notify:()=>{}};
 vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../src/catalog.js'),'utf8'),dom.getInternalVMContext());
 w.KefuCatalog.render(options);await tick();
 const submit=id=>$(id).dispatchEvent(new w.Event('submit',{cancelable:true}));
 const click=sel=>w.document.querySelector(sel).click();
 return {dom,w,$,calls,api,options,submit,click,setWrite:v=>write=v,setActive:v=>active=v};
}
test('管理员创建 SPU、修改公共属性、创建及修改 SKU，写入带公司范围且锁定不可编辑字段',async()=>{
 const h=await setup();const {$,click,submit,calls}=h;
 $('catalog-code').value='NEW';$('catalog-title').value='新杯';
 click('[data-add-attribute="catalog-common"]');let row=$('catalog-common').firstElementChild;
 row.querySelector('[data-key]').value='容量';row.querySelector('[data-type]').value='number';row.querySelector('[data-value]').value='650';
 submit('catalog-spu-form');await tick();
 assert.equal(calls[0][0],'createCatalogSpu');assert.equal(calls[0][1],'t1');assert.equal(calls[0][2].commonAttributes.容量,650);assert.equal(calls[0][2].storeId,'s1');assert.equal($('catalog-code').disabled,true);
 $('catalog-title').value='改标题';submit('catalog-spu-form');await tick();assert.equal(calls[1][0],'updateCatalogSpu');assert.equal('productCode' in calls[1][3],false);assert.equal(calls[1][3].title,'改标题');
 click('#catalog-new-sku');$('catalog-sku-code').value='NEW-BLUE';click('[data-add-attribute="catalog-variant"]');row=$('catalog-variant').firstElementChild;row.querySelector('[data-key]').value='颜色';row.querySelector('[data-value]').value='蓝色';
 submit('catalog-sku-form');await tick();assert.equal(calls[2][0],'createCatalogSku');assert.equal(calls[2][3].variant.颜色,'蓝色');
 $('catalog-sku-status').value='inactive';$('catalog-variant').firstElementChild.querySelector('[data-value]').value='浅蓝';submit('catalog-sku-form');await tick();assert.equal(calls[3][0],'updateCatalogSku');assert.equal(calls[3][3].status,'inactive');assert.equal(calls[3][3].variant.颜色,'浅蓝');assert.equal('externalSkuId' in calls[3][3],false);
 h.dom.window.close();
});
test('客服能查看 SKU；无写入入口且提交处理器再次阻止写入',async()=>{
 const h=await setup(false);h.click('[data-catalog-open]');await tick();h.click('[data-sku-open]');
 assert.equal(h.$('catalog-title').disabled,true);assert.equal(h.$('catalog-sku-code').disabled,true);assert.equal(h.w.document.querySelector('[data-add-attribute]'),null);assert.equal(h.$('catalog-new-sku'),null);
 h.submit('catalog-spu-form');h.submit('catalog-sku-form');await tick();assert.equal(h.calls.length,0);assert.equal(h.$('catalog-variant').firstElementChild.querySelector('[data-value]').value,'红色');h.dom.window.close();
});
test('重复属性和无效类型被阻止；后端错误保留原草稿且可以重试',async()=>{
 const h=await setup();h.click('[data-catalog-open]');await tick();const row=h.$('catalog-common').firstElementChild;row.querySelector('[data-value]').value='不是数值';h.submit('catalog-spu-form');assert.match(h.$('catalog-error').textContent,/有效数值/);assert.equal(h.calls.length,0);
 row.querySelector('[data-value]').value='800';h.click('[data-add-attribute="catalog-common"]');const duplicate=h.$('catalog-common').lastElementChild;duplicate.querySelector('[data-key]').value='容量';duplicate.querySelector('[data-value]').value='700';h.submit('catalog-spu-form');assert.match(h.$('catalog-error').textContent,/重复/);assert.equal(h.calls.length,0);duplicate.remove();h.$('catalog-title').value='保留的草稿';h.api.updateCatalogSpu=async()=>{throw new Error('商品编码冲突')};h.submit('catalog-spu-form');await tick();assert.equal(h.$('catalog-title').value,'保留的草稿');assert.match(h.$('catalog-error').textContent,/冲突/);assert.equal(h.$('catalog-title').disabled,false);assert.equal(h.$('catalog-code').disabled,true);
 h.click('[data-sku-open]');h.$('catalog-sku-code').value='保留SKU';h.api.updateCatalogSku=async()=>{throw new Error('SKU 重复')};h.submit('catalog-sku-form');await tick();assert.equal(h.$('catalog-sku-code').value,'保留SKU');assert.match(h.$('catalog-sku-error').textContent,/重复/);assert.equal(h.$('catalog-sku-code').disabled,false);h.dom.window.close();
});
test('延迟详情不能覆盖新建表单',async()=>{
 const h=await setup();let resolve;h.api.catalogDetail=()=>new Promise(r=>resolve=r);h.click('[data-catalog-open]');h.w.KefuCatalog.newSpu();h.$('catalog-title').value='当前草稿';resolve({spu:{id:'old',title:'旧详情'},skus:[]});await tick();assert.equal(h.$('catalog-title').value,'当前草稿');h.dom.window.close();
});
test('新账号切换会清空商品详情并忽略旧账号请求结果',async()=>{
 const h=await setup();let resolve;h.api.catalogDetail=()=>new Promise(r=>resolve=r);h.click('[data-catalog-open]');
 h.options.session={};h.options.api={...h.api,catalogSpus:async()=>[],catalogCategories:async()=>[]};h.w.KefuCatalog.render(h.options);await tick();resolve({spu:{id:'old',title:'不应泄露的旧账号商品'},skus:[]});await tick();
 assert.equal(h.$('catalog-title').value,'');assert.match(h.$('knowledge-count').textContent,/0 \/ 0/);h.dom.window.close();
});
test('SPU/SKU API 适配使用真实路径、Bearer 和租户头，不混用旧商品接口',async()=>{
 const storage=new Map([['kefu.access-token','test-token']]),requests=[];
 const context={window:{},FormData,sessionStorage:{getItem:k=>storage.get(k),removeItem:k=>storage.delete(k),setItem:(k,v)=>storage.set(k,v)},fetch:async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({data:{id:'saved'}})}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../src/api-client.js'),'utf8'),context);
 const api=context.window.KefuApi;
 await api.catalogSpus('t1');await api.catalogCategories('t1');await api.catalogDetail('t1','spu/1');await api.createCatalogSpu('t1',{productCode:'ABC',storeId:'s1'});await api.updateCatalogSpu('t1','p1',{title:'杯'});await api.createCatalogSku('t1','p1',{skuCode:'BLUE'});await api.updateCatalogSku('t1','k1',{variant:{颜色:'蓝色'}});
 assert.deepEqual(requests.map(r=>r.url),['/api/v1/knowledge/spus','/api/v1/knowledge/categories','/api/v1/knowledge/spus/spu%2F1','/api/v1/knowledge/spus','/api/v1/knowledge/spus/p1','/api/v1/knowledge/spus/p1/skus','/api/v1/knowledge/skus/k1']);
 for(const r of requests){assert.equal(r.headers['x-tenant-id'],'t1');assert.equal(r.headers.authorization,'Bearer test-token')}
 assert.equal(requests[4].method,'PATCH');assert.equal(JSON.parse(requests[6].body).variant.颜色,'蓝色');
});
