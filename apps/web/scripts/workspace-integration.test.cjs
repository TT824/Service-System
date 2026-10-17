const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('SSE decodes fragmented CRLF and multiline data, ignores malformed blocks', () => {
  const context = { window: {} }; vm.createContext(context);
  vm.runInContext(read('src/realtime.js'), context);
  const frames = [], accept = context.window.KefuRealtime.decoder(frame => frames.push(frame));
  const stream = ': heartbeat\r\n\r\ndata: invalid\r\n\r\nevent: message.created\r\ndata: {"event_id":"1",\r\ndata: "event_type":"message.created","data":{"text":"你好"}}\r\n\r\n';
  for (const character of stream) accept(character);
  assert.equal(frames.length, 1); assert.equal(frames[0].data.text, '你好');
});

test('SSE reconnects after EOF, compensates with a new handshake, and stops on expired authentication', async () => {
  let nextId=1, calls=0, cleared=false;
  const timers=new Map(),frames=[],states=[];
  const context={window:{},AbortController,TextDecoder,console,
    setTimeout:(fn,delay)=>{const id=nextId++;timers.set(id,{fn,delay});return id},
    clearTimeout:id=>timers.delete(id),setInterval:()=>nextId++,clearInterval:()=>{},
  };
  vm.createContext(context);vm.runInContext(read('src/realtime.js'),context);
  const api={clearToken:()=>{cleared=true},realtimeResponse:async(signal,reconnect)=>{
    calls++;
    if(calls===2){assert.equal(reconnect,true);return {status:401,ok:false}}
    const bytes=new TextEncoder().encode('data: {"event_id":"h1","event_type":"realtime.connected","data":{"reconnect":false}}\n\n');
    return {status:200,ok:true,headers:new Headers({'content-type':'text/event-stream'}),body:new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,9));controller.enqueue(bytes.slice(9));controller.close()}})};
  }};
  const stop=context.window.KefuRealtime.subscribe(api,frame=>frames.push(frame),state=>states.push(state));
  await tick();
  assert.equal(frames[0].event_type,'realtime.connected');assert.ok(states.includes('reconnecting'));
  const retry=[...timers.entries()].find(([,timer])=>timer.delay===1000);
  assert.ok(retry);timers.delete(retry[0]);retry[1].fn();await tick();
  assert.equal(cleared,true);assert.equal(states.at(-1),'unauthorized');assert.equal(timers.size,0);
  stop();
});

test('workspace uses real candidates, traces adoption, transfers with version, and refreshes on SSE', async () => {
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace','products','knowledge','phrases','analytics','exports','admin','settings','review','tenants','account','login'];
  const markup = read('index.html').replace('<div id="page-root"></div>', `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`);
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window; w.structuredClone = structuredClone;
  let onFrame, sent, transferred, listReads = 0, claimed = true;
  const conversation = () => ({id:'c1',tenantId:'t1',storeId:'s1',title:'测试客户',status:'claimed',version:7,assignedMemberId:claimed?'agent1':'agent2'});
  const set = {id:'set1',provider:'none',fallbackReasons:['no_generation_provider'],candidates:[{rank:1,kind:'faq',sourceId:'faq1',tenantId:'t1',storeId:'s1',title:'发货时间',content:'48 小时内发出',score:0.8}]};
  w.KefuApi = {
    hasSession:()=>true,currentSession:async()=>({access:{role:'agent',tenantId:'t1',member:{id:'agent1',displayName:'客服一'}},account:{}}),
    presence:async()=>{},heartbeat:async()=>{},directoryTenants:async()=>[{tenant:{id:'t1',name:'测试公司'},stores:[{id:'s1',name:'旗舰店'}],members:[{id:'agent2',displayName:'客服二'}]}],
    setWorkspaceTenant:()=>{},conversations:async()=>{listReads++;return [conversation()]},
    conversation:async()=>({conversation:conversation(),canReply:claimed,messages:[{id:'m1',direction:'inbound',content:'什么时候发货',createdAt:new Date().toISOString()}],deliveries:[]}),
    suggestions:async()=>set,suggestionDetail:async()=>set,
    sendMessage:async(...args)=>{sent=args},transferTargets:async()=>[{memberId:'agent2',displayName:'客服二',inProgressCount:0}],
    transferConversation:async(...args)=>{transferred=args;claimed=false},assignments:async()=>[{action:'transfer',result:'success',fromMemberId:'agent1',toMemberId:'agent2',stateVersionBefore:7,stateVersionAfter:8,createdAt:new Date().toISOString()}],
    clearToken:()=>{},logout:async()=>{},
  };
  w.KefuRealtime={subscribe:(api,frame,state)=>{onFrame=frame;state('connected');return ()=>{onFrame=null}}};
  try {
    w.eval(read('src/mock-data.js')); w.eval(read('src/admin-data.js')); w.eval(read('src/app.js'));
    await tick(); await tick();
    assert.match(w.document.getElementById('candidates').textContent, /48 小时内发出/);
    assert.match(w.document.getElementById('candidates').textContent, /未配置生成模型/);
    // 顶部指标：接了后端就不该再拿会话列表凑一个「今日接待」——原来那个过滤条件
    // （time !== '昨天'）对 HH:MM 的后端时间恒为真，数出来等于会话总数，是假数值。
    assert.equal(w.document.getElementById('today-served').textContent, '—');
    w.document.querySelector('.use-btn').click();
    w.document.getElementById('reply').value += '，请稍等';
    w.document.getElementById('send-btn').click(); await tick();
    assert.equal(sent[2], 'edited_send'); assert.equal(sent[3], 'set1');
    w.document.getElementById('candidate-detail').click();await tick();
    assert.match(w.document.getElementById('modal-extra').textContent, /faq1/);
    w.document.getElementById('modal-cancel').click();
    const before = listReads;
    onFrame({event_type:'message.created',data:{conversation_id:'c1'}});
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.ok(listReads>before);
    w.document.getElementById('transfer-btn').click();await tick();
    w.document.getElementById('modal-confirm').click();await tick();await tick();
    assert.deepEqual(transferred, ['c1',7,'agent2']);
    assert.equal(w.document.querySelector('.composer').hidden,true);
    w.document.getElementById('assignment-history-btn').click();await tick();
    assert.match(w.document.getElementById('modal-extra').textContent,/客服二/);
  } finally { dom.window.close(); }
});
