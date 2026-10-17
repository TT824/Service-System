/**
 * UI controller for the static prototype.
 * TODO(API): Replace the simulated mutations below with the contracts described
 * in docs/backend-integration.md. Keep permission checks on the server; the UI
 * role switcher is only for reviewing screens.
 */

  const api = window.KefuApi;
  const conversations = JSON.parse(JSON.stringify(window.CustomerServiceMock.conversations));
  const suggestions = window.CustomerServiceMock.suggestions;
  const contactGroups = JSON.parse(JSON.stringify(window.CustomerServiceMock.contactGroups));
  const contacts = JSON.parse(JSON.stringify(window.CustomerServiceMock.contacts));
  // 附件草稿按会话保存，避免切换客户后误发给另一位买家。
  const replyAttachments=new Map();
  // 内部会话（同事一对一 / 平台侧 / 群聊）的附件草稿，同样按会话分开存：
  // 换个人聊天时不能把上一条的附件留在输入框下面。
  const internalAttachments=new Map();
  const quickPhrases=structuredClone(window.CustomerServiceMock.quickPhrases);
  let phrasePageScope='个人',phraseAsideScope='个人',assistView='ai';
  let knowledgeTab='products',knowledgeLoaded=false,knowledgeLoading=false,knowledgeEditingId=null;
  let knowledgeScope=null,knowledgeEpoch=0;
  const knowledgeState={products:[],faqs:[],shortcuts:[]};
  let phraseMatches=[], phraseIndex=0, phraseRange=null, replyComposing=false, phraseEpoch=0;
  // 登录方式与密码显隐：navigate() 在初始化早期就会走到登录页，所以这两个状态和其他
  // 顶层状态放在一起声明，避免被后面的 let 声明挡住（TDZ）。
  let authMode='password',secretRevealed=false;
  const groupChats = JSON.parse(JSON.stringify(window.CustomerServiceMock.groupChats));
  // 同事一对一内部会话：按联系人 id 归类，和客户会话、群聊分开保存，避免误发。
  // 演示模式下消息只存在这个 Map 里；登录后改用服务端的 /internal-chat（见 remoteThreads）。
  const directThreads=new Map(Object.entries(JSON.parse(JSON.stringify(window.CustomerServiceMock.directThreads||{}))));
  // 真实后端的内部协作状态。两组数据不混用：登录后联系人里的“团队”就是本租户同事目录
  // （remotePeers），演示名单只在本机没连后端时展示——两套名单混着显示会出现点了不存在的同事。
  let remotePeers=[], remoteStores=new Map();
  // peerMemberId -> { threadId, messages: 视图对象[], lastMessageView }。消息用渲染后的视图
  // （sender/time/text/mine）保存，因为服务端只给 member_id 与 body，名字与气泡方向是界面的事。
  let remoteThreads=new Map();
  let currentId=1, selectedSuggestion=-1, originalSuggestion='', modalAction=null, currentSuggestions=suggestions, assistEnabled=true, presenceState='online';
  // 真实会话的候选来自服务端一次算完的 set（POST /retrieval/suggestions）。这几个变量只记
  // 「哪个会话的、哪一次请求的」结果，候选本身不在这里拼：意图、检索和降级原因都是服务端的
  // 事实，浏览器复刻一遍就会两边漂移。
  let contactCategory='team', activeGroupChatId=null, activeDirectId=null;
  // 「我的会话」里当前打开的是哪条内部会话（同事）。客户会话与同事会话共用一个列表，
  // 所以必须记住是哪一种，否则切回「我的会话」时会把内部会话顶掉、跳回客户会话。
  let queueInternalPeerId=null;
  let conversationStatus='active';
  const profile={name:'陈小雨',phoneRaw:'13800002068',phoneMasked:'138****2068',avatarUrl:''};
  let backendSession=null,backendConnected=false,heartbeatTimer=null;
  let stopRealtime=null,refreshTimer=null,deliveryTimer=null,refreshRunning=false,refreshAgain=false,workspaceEpoch=0,workspaceStoreId='',workspaceTenantName='';
  let selectedCandidateId=null,selectedCandidateConversation=null;
  const remoteSuggestions=new Map();
  // 登录后服务端下发的本人成员 ID：用于判断某条会话是不是自己在接待（能转移的对象），
  // 与角色无关，也不参与鉴权，只决定按钮显不显示。
  let selfMemberId=null;
  // 首帧的默认路由由初始化流程自己走完，不弹“请先登录”提示；此后才算用户操作。
  let booted=false;
  let profileAvatarObjectUrl='';
  // 分组展开状态记两笔：展开的、收起的。只记一笔的话，「默认展开」的分组
  // 和「用户点开」的分组没法区分，收起动作就没有地方落笔。
  const expandedContactGroups=new Set(['team:售前客服','buyers:重点客户']);
  const collapsedContactGroups=new Set();
  const el=id=>document.getElementById(id);
  function toast(message){ const t=el('toast'); t.textContent=message; t.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer=setTimeout(()=>t.classList.remove('show'),2600); }
  function setAuthStatus(message,state=''){
    el('auth-status').textContent=message;
    el('auth-status').className='auth-status'+(state?' '+state:'');
  }
  function setBackendStatus(message,state=''){
    el('backend-status').textContent=message;
    if(state)el('backend-status').dataset.state=state;else delete el('backend-status').dataset.state;
  }
  function formatBackendTime(value){
    const date=new Date(value);
    if(Number.isNaN(date.valueOf()))return '';
    return date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
  }
  function formatWindowDeadline(value){
    const date=new Date(value);
    if(Number.isNaN(date.valueOf()))return '';
    const pad=number=>String(number).padStart(2,'0');
    return `${pad(date.getMonth()+1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  // 外发提醒的四句话都读服务端 GET /conversations/:id 的 replyWindow：窗口何时开、何时关、
  // 还剩几条额度是平台的事实（客户入向消息开窗、窗口内最多 5 条），浏览器从前看不到，
  // 所以这一块曾经写死。这里只做两件事——把服务端给的数字填进句子，以及页面停留很久、
  // 截止时间已经过去时改口说「已关闭」：后者是对服务端给出的绝对截止时间的一次读法
  // （同一个半开区间），能发与否仍然由服务端在提交时判定，前端不自己下结论。
  function replyWindowView(replyWindow){
    if(!replyWindow)return null;
    const deadline=replyWindow.windowEndsAt?formatWindowDeadline(replyWindow.windowEndsAt):'';
    const limit=replyWindow.messageLimit;
    const expired=replyWindow.windowEndsAt!==null&&Date.now()>=Date.parse(replyWindow.windowEndsAt);
    if(replyWindow.open&&!expired){
      return {
        open:true,
        html:`当前会话处于 48 小时回复窗口，剩余<b id="budget">${replyWindow.remaining}</b>条外发额度（本窗口共 ${limit} 条）；请尽量合并回复。`,
        deadline:deadline?`窗口至 ${deadline}`:'',
      };
    }
    if(replyWindow.refusal==='window_missing'){
      return {open:false,html:'客户尚未发来消息，48 小时回复窗口未开启。',deadline:'尚无回复窗口',toast:'客户尚未发来消息，回复窗口未开启'};
    }
    if(replyWindow.refusal==='quota_exceeded'){
      return {
        open:false,
        html:`本窗口的 ${limit} 条外发额度已用完，客户再次发来消息后重置。`,
        deadline:deadline?`窗口至 ${deadline}`:'',
        toast:'本窗口外发额度已用完，等待客户再次发来消息',
      };
    }
    return {
      open:false,
      html:`48 小时回复窗口已关闭${deadline?`（${deadline} 截止）`:''}，客户再次发来消息后可继续回复。`,
      deadline:'窗口已关闭',
      toast:'回复窗口已关闭，客户再次发来消息后可继续回复',
    };
  }
  // 未连后端（原型模式）时保留 pages/workspace.html 里的默认文案：那种模式下没有服务端窗口
  // 可读，界面显示什么由原型自己决定。默认值在第一次改写之前抓取，之后不再变。
  let noticeDefaults=null;
  function renderReplyWindow(c){
    if(noticeDefaults===null){
      noticeDefaults={sentence:el('notice-reply-window').innerHTML,deadline:el('notice-window-deadline').textContent};
    }
    const view=c&&c.replyWindow?replyWindowView(c.replyWindow):null;
    if(!view){
      el('notice-reply-window').innerHTML=noticeDefaults.sentence;
      el('notice-window-deadline').textContent=noticeDefaults.deadline;
      return null;
    }
    el('notice-reply-window').innerHTML=view.html;
    el('notice-window-deadline').textContent=view.deadline;
    return view;
  }
  // 单公司部署中，后端 platform_admin 与 merchant_admin 都是前端的公司管理员。
  // 前端不再把 platform_admin 降到只可见租户/审核页的“超级管理员”壳层。
  function frontendRoleOf(role){return role==='platform_admin'||role==='merchant_admin'?'merchant':'agent'}
  // 平台管理员不属于任何公司，接待名单里没有他，服务端也不会给他一条能回复的客户会话：
  // 他能读到的每一条客户会话都是只读的（服务端 canReply=false，回复区整块隐藏）。
  // 所以这块界面不为他读客户会话，只留与客服的内部会话。
  function isPlatformAdminView(){return backendConnected&&backendSession?.access?.role==='platform_admin'}
  function backendConversationOf(row,previous){
    const name=row.title||row.externalCustomerId||'未命名客户';
    return {
      id:row.id,
      backendId:row.id,
      tenantId:row.tenantId,
      name,
      initial:[...name][0]||'客',
      preview:previous?.preview||'点击查看会话记录',
      time:formatBackendTime(row.lastMessageAt),
      store:row.storeId,
      status:row.status==='closed'?'ended':'active',
      rawStatus:row.status,
      version:row.version,
      assignedMemberId:row.assignedMemberId,
      endedAt:row.closedAt?new Date(row.closedAt).valueOf():null,
      messages:previous?.messages||[],
      canReply:previous?.canReply,
      replyWindow:previous?.replyWindow,
    };
  }
  // 这条消息带着的媒体，服务端怎么说就怎么读。两样东西缺一不可：`message.media`
  // 说明这条消息确实有媒体（入站是平台抓下来的那份图，出站是我们自己的副本），
  // `mediaUrls[id]` 是这次回读现签的地址（十分钟寿命，每次重读换一份，所以它不在
  // 消息行上）。只有前者没有后者，说明这一次没签出来——那就当没有可渲染的媒体，
  // 气泡退回服务端存下的那句占位文字（「[图片消息]」），而不是画一个必然裂掉的图。
  function backendMediaOf(message,mediaUrls){
    const media=message.media;
    if(!media)return null;
    const url=mediaUrls?.[message.id];
    if(!url)return null;
    // kind 先按服务端判定的 messageType 取，它不是这三种媒体之一时才退回按内容类型
    // 猜——这是唯一的兜底，不是第二次判定：客户发来的图片服务端记的就是 image。
    const kind=['image','video','file'].includes(message.messageType)
      ?message.messageType
      :media.mimeType?.startsWith('image/')?'image'
      :media.mimeType?.startsWith('video/')?'video'
      :'file';
    return {
      kind,
      // 只有文档和视频有名字（客户发来的图片没有），没有就按类给一个，否则下载下来的
      // 文件名会是空的。
      name:media.name||`${{image:'图片',video:'视频',file:'文件'}[kind]}`,
      url,
    };
  }
  function backendMessageOf(message,mediaUrls){
    const sourceLabels={manual_typed:'手打',direct_candidate:'直接采纳',edited_send:'编辑后发送',welcome:'欢迎语',offline_auto_reply:'离线回复',other:'其他'};
    return {
      id:message.id,
      direction:message.direction,
      by:message.direction==='outbound'?'agent':'customer',
      time:formatBackendTime(message.createdAt),
      text:message.content||`[${message.messageType||'消息'}]`,
      source:message.source?sourceLabels[message.source]||message.source:'',
      attachment:backendMediaOf(message,mediaUrls),
    };
  }
  async function loadConversationDetail(id){
    if(!backendConnected||!id)return;
    const epoch=workspaceEpoch;
    const detail=await api.conversation(id);
    if(epoch!==workspaceEpoch||!backendConnected)return;
    const index=conversations.findIndex(item=>String(item.id)===String(id));
    if(index<0)return;
    const mapped=backendConversationOf(detail.conversation,conversations[index]);
    mapped.messages=(detail.messages||[]).map(message=>backendMessageOf(message,detail.mediaUrls));
    mapped.preview=mapped.messages.at(-1)?.text||mapped.preview;
    mapped.canReply=detail.canReply;
    mapped.canTakeOver=detail.canTakeOver;
    for(const item of detail.deliveries||[]){
      const message=mapped.messages.find(row=>row.id===item.delivery.messageId);
      if(message)message.deliveryStatus=item.delivery.status;
    }
    // 服务端算好的回复窗口（截止时间 + 剩余额度）。列表接口不带它，只有详情有，
    // 所以这里跟着详情一起落到会话上，renderMessages 直接渲染。
    mapped.replyWindow=detail.replyWindow;
    conversations[index]=mapped;
    if(String(currentId)===String(id))renderAll();
  }
  async function loadRemoteConversations(){
    const epoch=workspaceEpoch;
    const storeId=workspaceStoreId;
    // 平台管理员的工作台不读客户会话。原因不是权限被拒（他有租户级只读权），而是这个
    // 身份本就不该看客户对话：他不在接待名单里，读到的每一条都是 canReply=false 的
    // 只读会话，回复区因此整块隐藏——留着只会让人以为「能看见却发不出去」。
    if(isPlatformAdminView()){
      conversations.splice(0,conversations.length);
      currentId=null;conversationStatus='active';
      renderAll();
      return;
    }
    const rows=await api.conversations(storeId);
    if(epoch!==workspaceEpoch||!backendConnected||storeId!==workspaceStoreId)return;
    const previous=new Map(conversations.map(item=>[String(item.id),item]));
    const mapped=(rows||[]).map(row=>backendConversationOf(row,previous.get(String(row.id))));
    conversations.splice(0,conversations.length,...mapped);
    const selected=conversations.find(item=>String(item.id)===String(currentId));
    currentId=(selected||conversations.find(item=>item.status==='active')||conversations[0])?.id??null;
    conversationStatus=conversations.find(item=>String(item.id)===String(currentId))?.status||'active';
    renderAll();
    if(currentId!==null)await loadConversationDetail(currentId);
  }
  function stopWorkspaceRealtime(){
    workspaceEpoch++;stopRealtime?.();stopRealtime=null;clearTimeout(refreshTimer);refreshTimer=null;
    clearInterval(deliveryTimer);
    refreshAgain=false;remoteSuggestions.clear();selectedCandidateId=null;selectedCandidateConversation=null;
  }
  function refreshWorkspace(){
    if(!backendConnected)return;
    refreshAgain=true;
    if(refreshRunning||refreshTimer)return;
    refreshTimer=setTimeout(async()=>{
      refreshTimer=null;refreshRunning=true;
      try{
        while(refreshAgain&&backendConnected){refreshAgain=false;await loadRemoteConversations()}
      }catch(error){toast(error.message||'会话同步失败')}
      finally{refreshRunning=false}
    },150);
  }
  async function startWorkspaceRealtime(){
    stopWorkspaceRealtime();
    const epoch=workspaceEpoch;
    const directories=await api.directoryTenants();
    if(epoch!==workspaceEpoch||!backendConnected)return;
    const tenant=backendSession.access?.tenantId||backendSession.access?.member?.tenantId;
    const entry=directories.find(item=>item.tenant.id===tenant)||directories.find(item=>item.tenant.enabled!==false);
    if(!entry)throw new Error('当前账号没有可用的公司范围');
    api.setWorkspaceTenant(entry.tenant.id);workspaceStoreId='';workspaceTenantName=entry.tenant?.name||'';
    el('store-select').innerHTML='<option value="">公司全部门店</option>'+(entry.stores||[]).filter(store=>store.enabled!==false).map(store=>`<option value="${safe(store.id)}">${safe(store.name)}</option>`).join('');
    el('store-select').disabled=false;
    // 同事目录按门店分组显示，所以门店名先存下来；联系人里的分组就是它。
    remoteStores=new Map((entry.stores||[]).map(store=>[store.id,store.name]));
    await loadRemoteConversations();
    if(epoch!==workspaceEpoch||!backendConnected)return;
    // 「我的会话」里客户会话和同事会话排同一个列表，所以同事目录与会话摘要必须在登录时
    // 就拉一次——两个身份都是。等点开联系人栏再读，进门看到的就是一个只有客户会话的列表，
    // 会以为同事一条会话都没有；平台管理员那边更绝对，他的列表里只剩内部会话。
    await refreshTeamDirectory();
    if(epoch!==workspaceEpoch||!backendConnected)return;
    stopRealtime=window.KefuRealtime.subscribe(api,frame=>{
      if(epoch!==workspaceEpoch)return;
      if(frame.event_type==='realtime.ping')return;
      if(frame.event_type==='presence.changed'){
        if(frame.data.member_id===backendSession?.access?.member?.id)updatePresence({accepting:'online',busy:'suspended',away:'suspended',offline:'offline'}[frame.data.status]||'offline');
        return;
      }
      if(frame.event_type==='internal.message.created'){
        onInternalMessageCreated(frame.data);
        return;
      }
      refreshWorkspace();
    },state=>{
      if(epoch!==workspaceEpoch)return;
      el('realtime-status').textContent={connecting:'实时连接中',connected:'实时已连接',reconnecting:'实时重连中',unauthorized:'实时鉴权失效，请重新登录'}[state];
      if(state==='unauthorized'){clearBackendSession();setBackendStatus('登录已失效 · 请重新登录','error');navigate('login');setAuthStatus('实时鉴权失效，请重新登录','error')}
    });
    // Worker 在独立进程写入投递结果；待发送消息需补读，不能仅依赖 API 进程内事件总线。
    deliveryTimer=setInterval(()=>{
      if(el('workspace').classList.contains('active')&&activeConversation()?.messages.some(message=>message.deliveryStatus==='pending'))refreshWorkspace();
    },5000);
  }
  function applyBackendSession(session){
    backendSession=session;
    backendConnected=true;
    const access=session.access||{};
    const account=session.account||{};
    profile.name=access.member?.displayName||account.display_name||account.username||'当前用户';
    // 会话列表用不了 access.member.id 之外的信息；会话详情里的 canTakeOver 只有在
    // 拿到本人 ID 时才有意义。
    selfMemberId=access.member?.id??session.session?.memberId??null;
    profile.phoneRaw=account.phone||'';
    profile.phoneMasked=account.phone?`${account.phone.slice(0,3)}****${account.phone.slice(-4)}`:'未绑定';
    profile.avatarUrl=account.avatar_url||'';
    const mappedRole=frontendRoleOf(access.role);
    clearKnowledgeData();
    el('role-select').disabled=false;
    el('role-select').value=mappedRole;
    el('role-select').onchange();
    // 会话建立后才放出导航入口；角色选择仍锁定为后端下发的角色。
    applyAccessLock();
    el('role-select').disabled=true;
    const storeId=access.storeId||access.authorizedStoreIds?.[0];
    if(storeId)el('store-select').innerHTML=`<option>${safe(storeId)}</option>`;
    else el('store-select').innerHTML='<option>公司全部门店</option>';
    el('store-select').disabled=true;
    renderProfile();
    setBackendStatus(`业务后端已连接 · ${profile.name}`,'connected');
    setAuthStatus(`已登录：${profile.name}`,'ok');
  }
  async function bootstrapBackend(){
    if(!api?.hasSession()){
      clearBackendSession();
      const epoch=knowledgeEpoch;
      try{
        await api.health();
        if(epoch!==knowledgeEpoch)return;
        setBackendStatus('业务后端已就绪 · 请登录','connected');
        setAuthStatus('请输入后端账号和密码');
      }catch(error){
        if(epoch!==knowledgeEpoch)return;
        setBackendStatus('业务后端尚未就绪','error');
        setAuthStatus(error.message||'无法连接业务后端','error');
      }
      applyAccessLock();
      navigate('login');
      return;
    }
    const epoch=knowledgeEpoch;
    try{
      const session=await api.currentSession();
      if(epoch!==knowledgeEpoch||!api.hasSession())return;
      applyBackendSession(session);
      if(session.access?.role==='agent'){
        await api.presence('accepting');
        updatePresence('online');
        await startWorkspaceRealtime();
        navigate('workspace');
        clearInterval(heartbeatTimer);
        heartbeatTimer=setInterval(()=>api.heartbeat().catch(()=>{}),25000);
      }else{
        await startWorkspaceRealtime();
        navigate(session.access?.role==='platform_admin'||session.access?.role==='merchant_admin'?'admin':'account');
      }
    }catch(error){
      stopWorkspaceRealtime();
      clearBackendSession();
      setBackendStatus('业务后端连接失败','error');
      setAuthStatus(error.message||'无法恢复登录，请重新登录','error');
      applyAccessLock();
      navigate('login');
    }
  }
  function showModal(title,text,action,extra='',confirmLabel='确认'){ el('modal-title').textContent=title; el('modal-text').textContent=text; el('modal-extra').innerHTML=extra; el('modal-confirm').textContent=confirmLabel; el('modal-confirm').disabled=false; modalAction=action; el('modal-bg').classList.add('show'); }
  function closeModal(){ el('modal-bg').classList.remove('show'); modalAction=null; }
  el('modal-cancel').onclick=closeModal;
  el('modal-bg').addEventListener('click',e=>{if(e.target===el('modal-bg'))closeModal()});
  el('modal-confirm').onclick=()=>{if(modalAction&&modalAction()===false)return;closeModal()};
  function role(){return el('role-select').value;}
  // 目录维护（改分组、建分组、建群）是管理动作：客服只读，但任何角色都可以
  // 和同事发起一对一内部协作会话。正式鉴权仍需服务端再校验一次。
  function canManageContacts(){return role()!=='agent';}
  function safe(value){return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  // 未登录时侧边导航、演示角色切换和账号卡片都不再提供入口，避免用界面按钮
  // 跳过登录。演示角色只决定页面可见性，不是授权来源；真正的读写仍由后端按
  // Bearer 会话校验。
  function sessionEstablished(){return Boolean(backendConnected)&&Boolean(api?.hasSession());}
  function applyAccessLock(){
    const locked=!sessionEstablished();
    if(locked)document.querySelectorAll('.nav-item').forEach(x=>{x.style.display='none'});
    el('role-select').disabled=locked;
    el('profile-btn').disabled=locked;
  }
  function navigate(view){
    // 登录门禁：离开登录页必须先有真实后端会话，任何入口都走这里收口。
    if(view!=='login'&&!sessionEstablished()){if(booted)toast('请先登录再访问控制台页面');view='login';}
    // 记下这次导航是不是「本来就在登录页」：只有真正切回登录页才需要复位密码显隐。
    // 初始化时 bootstrapBackend 的健康检查、以及被门禁挡回来的点击都会再次调用
    // navigate('login')，若无条件复位，会把用户刚点的「显示密码」在几百毫秒后悄悄收回，
    // 表现就是按钮时灵时不灵。
    const wasOnLogin=el('login').classList.contains('active');
    // 退出后，演示下拉框和旧 DOM 不能继续代表真实账号权限。
    window.ExportPortal?.leave();
    if(view==='exports')window.ExportPortal?.open();
    // 离开商品库时同样收回它的状态：投标与轮询都按 options.active() 收口，不靠
    // 「页面被隐藏」这种看不出来的信号。
    if(view!=='products')window.KefuProductLibrary?.leave();
    // 设置页四种角色都能进，但页面内容按角色收口：渠道接入只有平台侧能写、客服整块
    // 看不到；客服账号由平台侧和管理员维护，客服只读。授权判断仍在服务端。
    const restricted={workspace:['agent','merchant'],admin:['agent','merchant'],review:['platform','super'],tenants:['super'],products:['merchant'],knowledge:['agent','merchant'],phrases:['agent','merchant'],analytics:['merchant'],settings:['agent','merchant','platform','super']};
    if(restricted[view]&&!restricted[view].includes(role())){toast('当前演示角色无权访问此页面');return;}
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===view));
    el('workspace').classList.toggle('active',view==='workspace'); document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===view));
    // 切回登录页时把密码收回明文并清空按钮状态：上一次会话留下的“已显示”不该带到下一次登录。
    if(view==='login'&&!wasOnLogin){secretRevealed=false;syncSecretField()}
    el('account-role').textContent=el('role-select').selectedOptions[0].textContent;
    if(view==='admin')window.AdminPortal?.open();
    if(view==='phrases'){renderPhrasePage();loadPersonalPhrases()}
    if(view==='knowledge')renderKnowledge();
    if(view==='settings')renderSettings();
    // 商品库是结构化目录的**总览 + 导入 + 索引状态**，逐条维护仍只在知识库的
    // SPU / SKU 页签那一处。这里把两页需要的东西一次性交出去：同一份 api、同一套
    // 权限判断（canWriteKnowledge）和同一份公司范围（ensureKnowledgeScope），
    // 所以两页看到的永远是同一个目录、同一套权限，而不是两份各自解释的数据。
    if(view==='products')window.KefuProductLibrary?.open({
      api,
      scope:ensureKnowledgeScope,
      canWrite:canWriteKnowledge,
      session:backendSession,
      active:()=>el('products').classList.contains('active')&&backendConnected&&backendSession===session,
      notify:toast,
      openImport:openImportDialog,
      downloadTemplate:downloadKnowledgeTemplate,
      // 详细维护只有一处入口：点「维护」跳到知识库的 SPU / SKU 页签，并把该 SPU
      // 编码填进搜索框。两页各做一套编辑器，迟早对不上。
      gotoCatalog:code=>{knowledgeEditingId=null;knowledgeTab='catalog';el('knowledge-search').value=code;navigate('knowledge');window.KefuCatalog?.list?.()}
    });
  }
  document.querySelectorAll('.nav-item').forEach(x=>x.onclick=()=>navigate(x.dataset.view));
  document.querySelectorAll('[data-admin-permissions]').forEach(button=>button.onclick=()=>{
    navigate('admin');
    if(role()==='merchant')window.AdminPortal?.showPermissions(button.dataset.adminPermissions);
  });
  el('role-select').onchange=()=>{const r=role(); document.querySelectorAll('.nav-item').forEach(x=>{const v=x.dataset.view; x.style.display=r==='unauth'||(r==='agent'&&!['workspace','admin','knowledge','phrases','exports','settings'].includes(v))||(r==='platform'&&!['review','settings'].includes(v))||(r==='merchant'&&['review','tenants'].includes(v))||(r==='super'&&!['review','tenants','settings'].includes(v))?'none':''}); closeProfileMenu();renderProfile();navigate(r==='platform'?'review':r==='super'?'tenants':r==='unauth'?'login':'workspace');};
  el('role-select').onchange();
  // 初始化完成时还没有后端会话，先锁住界面入口；登录成功后由
  // applyBackendSession 解锁。
  applyAccessLock();
  booted=true;
  el('role-select').addEventListener('change',()=>{closeModal();window.AdminPortal?.refreshAccess()});
  function profileInitial(){return [...profile.name.trim()][0]||'客';}
  /**
   * 头像的统一画法：有图就画图，没有就画姓名首字。
   *
   * 只负责显示。图来自服务端（自己这张来自 /auth/session，同事那张来自内部会话
   * 目录），照样按不可信内容转义后再写进属性；「没有图」是常态而不是异常——从未
   * 上传过头像的人走首字这一支，所以这里不隐藏、不占位、不提示。
   *
   * @param imageUrl - base64 `data:` URL，或空值。
   * @param initial - 没有图片时画的字（一般取姓名首字）。
   */
  function avatarHtml(imageUrl,initial){
    return imageUrl
      ?`<span class="avatar"><img src="${safe(imageUrl)}" alt=""></span>`
      :`<span class="avatar">${safe(String(initial||'?').slice(0,1))}</span>`;
  }
  /**
   * 一条客户会话里「客服」那一边是谁：接待人。
   *
   * 会话行只记 assignedMemberId，消息本身不带发送人，所以「客服说的话」只能按接待
   * 人归属。自己接待就是自己，别人接待就画那位同事的姓名与头像——否则管理员查看同事
   * 的会话时，对方发的话会顶着自己的头像和自己的名字。
   *
   * @returns {{name:string,initial:string,avatarUrl:string|null}} 展示用的接待人。
   */
  function conversationAgent(conversation){
    const memberId=conversation?.assignedMemberId;
    const person=memberId&&memberId!==selfMemberId?remotePeers.find(item=>item.memberId===memberId):null;
    if(person)return {name:person.displayName,initial:[...person.displayName][0]||'客',avatarUrl:person.avatarUrl||null};
    // 还没认领、或接待人不在本租户同事目录里：退回当前账号这张，与改动前一致。
    return {name:profile.name,initial:profileInitial(),avatarUrl:profile.avatarUrl||null};
  }
  function renderProfile(){
    const initial=profileInitial();
    ['profile-rail-initial','profile-menu-initial','agent-avatar-initial'].forEach(id=>{el(id).textContent=initial;el(id).hidden=Boolean(profile.avatarUrl)});
    ['profile-rail-image','profile-menu-image','agent-avatar-image'].forEach(id=>{const image=el(id);image.hidden=!profile.avatarUrl;if(profile.avatarUrl)image.src=profile.avatarUrl;else image.removeAttribute('src')});
    el('profile-display-name').textContent=profile.name;
    el('profile-display-role').textContent=el('role-select').selectedOptions[0].textContent;
    el('profile-display-phone').textContent=profile.phoneMasked;
    el('account-name').textContent=profile.name;
    el('account-phone').textContent=profile.phoneMasked;
    el('agent-name-label').textContent=profile.name;
  }
  function openProfileMenu(){
    el('profile-menu').hidden=false;
    el('profile-btn').setAttribute('aria-expanded','true');
  }
  function closeProfileMenu(restoreFocus=false){
    el('profile-menu').hidden=true;
    el('profile-btn').setAttribute('aria-expanded','false');
    if(restoreFocus)el('profile-btn').focus();
  }
  function openEditProfile(){
    closeProfileMenu();
    showModal('修改个人信息','修改后会同步显示在工作台和账号中心。当前数据仅保存在本次页面会话中。',()=>{
      const name=el('profile-name-input').value.trim();
      const phone=el('profile-phone-input').value.trim();
      const error=el('profile-form-error');
      if(!name){error.textContent='请输入姓名。';return false}
      if(phone&&!/^1\d{10}$/.test(phone)){error.textContent='请输入 11 位手机号，或留空保持原手机号。';return false}
      profile.name=name;
      if(phone){profile.phoneRaw=phone;profile.phoneMasked=`${phone.slice(0,3)}****${phone.slice(-4)}`}
      renderProfile();
      toast('个人信息已更新（本地演示）');
    },`<div class="profile-form"><label for="profile-name-input">姓名</label><input id="profile-name-input" class="field" maxlength="24" value="${safe(profile.name)}"><label for="profile-phone-input">手机号</label><input id="profile-phone-input" class="field" inputmode="numeric" maxlength="11" value="${safe(profile.phoneRaw)}"><p class="profile-form-error" id="profile-form-error" role="alert"></p></div>`,'保存');
    setTimeout(()=>el('profile-name-input').focus());
  }
  /**
   * 把修改密码的失败翻译成可读的原因。
   *
   * 服务端把「当前密码不对」投成 400、把「会话没了」投成 401；账号被临时锁定时
   * 它给的是单独的 `account_locked`，因为那种情况下密码可能是对的，重试才是错的
   * 动作——这一支必须说清楚，否则操作者会以为自己的密码或账号坏了。
   *
   * @param failure - `KefuApi.ApiError`。
   * @returns 给操作者看的一句话。
   */
  function passwordChangeErrorText(failure){
    if(failure?.code==='account_locked')return '账号已被暂时锁定，请约 15 分钟后重试。';
    if(failure?.status===401)return '登录已过期，请重新登录后再修改密码。';
    if(failure?.status===400)return '当前密码不正确，或新密码不符合要求（10–200 个字符，且不能与当前密码相同）。';
    return failure?.message||'修改密码失败，请稍后重试。';
  }
  // 修改密码走 POST /auth/password/change：服务端要当前密码，成功后结束其他设备上的
  // 登录、保留本机这一次（所以提交完不会把自己踢下线）。长度与「不能与当前密码相同」
  // 的前端检查和服务端同一套规则，只为少一次白跑的往返；能不能改仍由服务端判定，
  // 并且服务端会顺手清掉之前累计的失败次数与锁定。
  function openChangePassword(){
    closeProfileMenu();
    showModal('修改密码','修改后其他设备上的登录会退出，本机保持登录。',()=>{
      const current=el('profile-current-password').value;
      const next=el('profile-new-password').value;
      const confirm=el('profile-confirm-password').value;
      const error=el('password-form-error');
      error.textContent='';
      if(!sessionEstablished()){error.textContent='请先登录业务后端再修改密码。';return false}
      if(!current){error.textContent='请输入当前密码。';return false}
      if(next.length<10)error.textContent='新密码至少需要 10 个字符。';
      else if(next.length>200)error.textContent='新密码不能超过 200 个字符。';
      else if(next!==confirm)error.textContent='两次输入的新密码不一致。';
      else if(next===current)error.textContent='新密码不能与当前密码相同。';
      if(error.textContent)return false;
      // 弹窗的确认回调只看同步返回值是不是 false，所以这里必须先同步返回、再让请求
      // 自己跑完：异步回调会让弹窗立刻关掉，校验和失败原因就没地方显示了。
      const button=el('modal-confirm');
      button.disabled=true;button.textContent='正在修改…';
      void api.changePassword(current,next).then(result=>{
        closeModal();
        const revoked=result?.revokedSessions;
        toast(revoked?`密码已修改，其他 ${revoked} 个设备的登录已退出`:'密码已修改');
      }).catch(failure=>{
        error.textContent=passwordChangeErrorText(failure);
        button.disabled=false;button.textContent='确认修改';
      });
      return false;
    },'<div class="profile-form"><label for="profile-current-password">当前密码</label><input id="profile-current-password" class="field" type="password" autocomplete="current-password"><label for="profile-new-password">新密码</label><input id="profile-new-password" class="field" type="password" autocomplete="new-password"><label for="profile-confirm-password">确认新密码</label><input id="profile-confirm-password" class="field" type="password" autocomplete="new-password"><p class="profile-form-error" id="password-form-error" role="alert"></p></div>','确认修改');
    setTimeout(()=>el('profile-current-password').focus());
  }
  async function signOut(){
    closeProfileMenu();
    // 启动撤销请求时已经捕获令牌，界面立即清空，不等待网络响应。
    const revoke=backendConnected?api.logout():Promise.resolve();
    el('auth-submit').disabled=true;
    // clearBackendSession 会停掉心跳与实时订阅、清掉密码框、并收回访问锁。
    clearBackendSession();
    applyAccessLock();
    setBackendStatus('已退出 · 请重新登录');
    setAuthStatus('已退出当前账号');
    navigate('login');
    toast('已退出账号');
    try{await revoke}catch(error){console.warn('退出后端会话失败',error)}finally{el('auth-submit').disabled=false}
  }
  function clearKnowledgeData(){
    knowledgeEpoch++;knowledgeLoaded=false;knowledgeLoading=false;knowledgeScope=null;knowledgeEditingId=null;
    Object.values(knowledgeState).forEach(items=>items.splice(0));
    window.KefuCatalog?.reset();
    window.KefuFaqVariants?.reset();
    resetCatalogSearch();
    el('knowledge-form').reset();el('knowledge-list').innerHTML='';el('knowledge-count').textContent='—';
    el('knowledge-test-result').textContent='';el('knowledge-scope-note').textContent='请登录后查看知识库';
  }
  function clearBackendSession(){
    stopWorkspaceRealtime();clearInterval(heartbeatTimer);backendConnected=false;backendSession=null;api?.clearToken();
    clearKnowledgeData();clearSettingsData();clearRoutingData();conversations.splice(0);currentId=null;replyAttachments.clear();closeModal();
    // 个人短语也是「谁的账号谁看」：退出后作废在途的读取（epoch），并把短语列表复位成演示
    // 数据。上一个账号从服务端读回来的行会随这次复位一起消失，不会在新账号登录前的一瞬间
    // 还挂在列表上；演示模式则拿回 mock 里那两条示例。
    phraseEpoch++;quickPhrases.splice(0,quickPhrases.length,...structuredClone(window.CustomerServiceMock.quickPhrases));
    phraseMatches=[];phraseRange=null;closePhraseSuggestions();
    // 内部会话也是租户数据：换账号必须清掉，否则会把上一个租户的同事和消息留在联系人里。
    remotePeers=[];remoteStores=new Map();remoteThreads=new Map();
    activeDirectId=null;activeGroupChatId=null;queueInternalPeerId=null;setQueueMode('conversations');
    Object.assign(profile,{name:'未登录',phoneRaw:'',phoneMasked:'未登录',avatarUrl:''});
    el('role-select').value='unauth';el('role-select').disabled=true;
    el('store-select').innerHTML='<option>请登录后选择门店</option>';el('store-select').disabled=true;
    el('auth-secret').value='';el('role-select').onchange();
  }
  window.addEventListener('kefu:session-expired',()=>{
    clearBackendSession();setBackendStatus('登录已失效 · 请重新登录','error');setAuthStatus('登录已失效，请重新登录','error');navigate('login');
  });
  el('profile-btn').onclick=()=>el('profile-menu').hidden?openProfileMenu():closeProfileMenu(true);
  el('profile-btn').addEventListener('keydown',event=>{if(event.key==='ArrowUp'){event.preventDefault();openProfileMenu();el('profile-change-avatar').focus()}});
  el('profile-menu').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeProfileMenu(true)}});
  el('profile-change-avatar').onclick=el('profile-avatar-action').onclick=()=>el('profile-avatar-file').click();
  /**
   * 把选中的图片裁成正方形并缩到 192px 以内，返回 data: URL。
   *
   * 服务端只收 PNG / JPG / WebP 且总长不超过 65536 字符的 data: URL，一张手机照片
   * 直接编码会远超这个长度，所以先在浏览器里裁一次、缩一次。这一步不是授权判断：
   * 类型、字节签名和长度仍由服务端校验，这里只是让常见图片能通过。
   *
   * @param file - 用户选中的图片文件。
   * @returns {Promise<string>} 可直接提交的 data: URL。
   */
  function squareAvatarDataUrl(file){
    return new Promise((resolve,reject)=>{
      const objectUrl=URL.createObjectURL(file);
      const image=new Image();
      image.onerror=()=>{URL.revokeObjectURL(objectUrl);reject(new Error('avatar_decode_failed'))};
      image.onload=()=>{
        URL.revokeObjectURL(objectUrl);
        const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
        if(!width||!height){reject(new Error('avatar_decode_failed'));return}
        const side=Math.min(width,height);
        // 从大到小试：192px 对头像已经够用，编码后仍超过服务端上限就再缩一档；
        // 到 96px 还放不下说明这张图不正常，交给调用方提示。
        for(const size of [192,128,96]){
          // 不放大：原图本来就比目标小的时候按原尺寸出图，放大只会得到更大更糊的一份。
          const edge=Math.min(size,side);
          const canvas=document.createElement('canvas');
          canvas.width=edge;canvas.height=edge;
          const context=canvas.getContext('2d');
          if(!context){reject(new Error('avatar_canvas_unavailable'));return}
          context.drawImage(image,Math.round((width-side)/2),Math.round((height-side)/2),side,side,0,0,edge,edge);
          // WebP 最省体积，但浏览器不支持导出 WebP 时 toDataURL 会静默退回 PNG，
          // 而 PNG 照片可能撑爆上限，所以退回时改用同样被服务端接受的 JPEG。
          const webp=canvas.toDataURL('image/webp',0.9);
          const dataUrl=webp.startsWith('data:image/webp')?webp:canvas.toDataURL('image/jpeg',0.9);
          if(!dataUrl.startsWith('data:image/')){reject(new Error('avatar_decode_failed'));return}
          if(dataUrl.length<=65536){resolve(dataUrl);return}
        }
        reject(new Error('avatar_too_large'));
      };
      image.src=objectUrl;
    });
  }
  /** 头像失败提示：服务端只给英文原因，翻成坐席看得懂的一句话。 */
  function avatarErrorMessage(error){
    if(error?.code==='avatar_invalid')return '服务端不接受这张图片，请换一张 PNG、JPG 或 WebP 图片。';
    if(error?.code==='session_revoked'||error?.code==='session_expired')return '登录已失效，请重新登录后再改头像。';
    if(error?.message==='avatar_too_large')return '这张图片太大，请换一张更小的。';
    if(error?.message==='avatar_canvas_unavailable')return '当前浏览器无法处理图片，请换一个浏览器再试。';
    if(error?.message==='avatar_decode_failed')return '这张图片读不出来，请换一张。';
    return error?.message||'头像保存失败，请稍后重试。';
  }
  /**
   * 应用选中的头像。
   *
   * 未登录时没有可写的账号，头像只留在本页（与其余资料一致）；登录后写服务端，
   * 刷新、换设备以及在同事的会话里都看得到——同事看到的是服务端存下的那张图，
   * 不是本页内存里的临时地址。
   *
   * @param file - 用户选中的图片文件。
   */
  async function applyAvatarFile(file){
    if(!backendConnected){
      if(profileAvatarObjectUrl)URL.revokeObjectURL(profileAvatarObjectUrl);
      profileAvatarObjectUrl=URL.createObjectURL(file);
      profile.avatarUrl=profileAvatarObjectUrl;
      renderProfile();
      closeProfileMenu();
      toast('头像已更新（本地演示）');
      return;
    }
    let dataUrl;
    try{
      dataUrl=await squareAvatarDataUrl(file);
    }catch(error){
      toast(avatarErrorMessage(error));
      return;
    }
    try{
      const account=await api.setAvatar(dataUrl);
      // 以服务端存下的值为准：它可能拒绝、可能清空，写死本地这份会让人以为存上了。
      profile.avatarUrl=account?.avatarUrl||'';
    }catch(error){
      toast(avatarErrorMessage(error));
      return;
    }
    renderProfile();
    closeProfileMenu();
    toast('头像已更新，同事在内部会话里会看到');
  }
  el('profile-avatar-file').onchange=event=>{
    const file=event.target.files[0];
    event.target.value='';
    if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('请选择 PNG、JPG 或 WebP 图片');return}
    if(file.size>5*1024*1024){toast('头像文件不能超过 5MB');return}
    void applyAvatarFile(file);
  };
  el('profile-edit-info').onclick=openEditProfile;
  el('profile-change-password').onclick=openChangePassword;
  el('profile-sign-out').onclick=signOut;
  el('account-edit-info').onclick=openEditProfile;
  el('account-change-password').onclick=openChangePassword;
  el('open-login').onclick=signOut;
  el('back-account').onclick=()=>navigate('account');
  document.addEventListener('click',event=>{if(!el('profile-btn').contains(event.target)&&!el('profile-menu').contains(event.target))closeProfileMenu()});
  renderProfile();
  // 登录方式决定密码框是不是真的在收密码：登录与注册都是密码，验证码是明文。
  // 显隐按钮常驻，真正需要隐藏它的只有「这个字段不是密码」这一种情况。
  function syncSecretField(){
    const field=el('auth-secret'),reveal=el('auth-secret-toggle');
    // 登录与注册收的都是密码，只有验证码是明文 —— 那一种情况才没有可显示的内容。
    const revealable=authMode!=='sms';
    field.type=revealable&&!secretRevealed?'password':'text';
    reveal.hidden=!revealable;
    const pressed=revealable&&secretRevealed;
    reveal.setAttribute('aria-pressed',String(pressed));
    const label=pressed?'隐藏密码':'显示密码';
    reveal.setAttribute('aria-label',label);
    reveal.title=label;
  }
  el('auth-secret-toggle').onclick=()=>{secretRevealed=!secretRevealed;syncSecretField();el('auth-secret').focus()};
  document.querySelectorAll('[data-auth]').forEach(x=>x.onclick=()=>{document.querySelectorAll('[data-auth]').forEach(t=>t.classList.toggle('active',t===x));authMode=x.dataset.auth;el('auth-title').textContent=authMode==='register'?'创建账号':'欢迎回来';el('auth-secret').placeholder=authMode==='password'?'密码':authMode==='sms'?'短信验证码':'设置密码';el('auth-submit').textContent=authMode==='register'?'注册并进入账号中心':'登录';
    // 切换登录方式时收回明文并复位按钮，避免“看着像密码框、其实没遮住”。
    secretRevealed=false;syncSecretField();
  });
  syncSecretField();
  el('auth-submit').onclick=async()=>{
    const type=document.querySelector('[data-auth].active')?.dataset.auth;
    if(type!=='password'){setAuthStatus('首轮整合先开放账号密码登录，验证码和注册将在后续接入。','error');return}
    const username=el('auth-username').value.trim(),password=el('auth-secret').value;
    if(!username||!password){setAuthStatus('请输入账号和密码。','error');return}
    el('auth-submit').disabled=true;setAuthStatus('正在登录业务后端…');
    try{
      await api.login(username,password);
      await bootstrapBackend();
      toast('已连接真实业务后端');
    }catch(error){
      // 连续输错会被临时锁定。服务端为此单独给一个 account_locked，因为锁定期间
      // 重试——哪怕密码是对的——只会继续被拒，等待才是该做的事；把这种情况说成
      // 「密码错误」，操作者就会以为账号或密码坏了。
      setAuthStatus(error?.code==='account_locked'
        ?'账号已连续输错密码，被暂时锁定，请约 15 分钟后重试；锁定期间即使密码正确也会被拒绝。'
        :(error.message||'登录失败'),'error');
      setBackendStatus('登录失败','error');
    }finally{el('auth-submit').disabled=false}
  };
  el('auth-secret').addEventListener('keydown',event=>{if(event.key==='Enter')el('auth-submit').click()});
  function activeConversation(){return conversations.find(x=>String(x.id)===String(currentId))}
  // GET /api/v1/conversations: list by tenant, authorized store and status.
  // Reconcile missed WebSocket/SSE events with cursor-based REST pagination.
  // 客户门店 chip：后端会话行给的是 storeId，直接显示出来就是 store-acme-flagship
  // 这种 ID；能查到门店名就显示名字，查不到才退回原值。
  function storeLabelOf(store){return remoteStores.get(store)||store||''}
  // 最后一条消息是客户还是客服发的。列表接口只给会话不带消息方向，所以只有读过
  // 详情的会话知道；不知道就不硬猜，宁可不标。
  function lastSenderLabel(conversation){
    const last=conversation.messages?.at(-1);
    return last?{by:last.by,label:last.by==='agent'?'客服':'客户',name:last.by==='agent'?profile.name:conversation.name}:null;
  }
  function renderConversations(){
    const filter=el('conversation-search').value.trim();
    const list=conversations.filter(x=>x.status===conversationStatus&&(!filter||x.name.includes(filter)||x.preview.includes(filter)));
    if(conversationStatus==='ended')list.sort((a,b)=>(b.endedAt||0)-(a.endedAt||0));
    // 内部会话没有「已结束」，只在处理中列出；列表里和客户会话混在一起。
    const internalChats=internalQueueRows();
    const internal=conversationStatus==='ended'?[]:internalChats
      .filter(item=>!filter||(item.peer?.displayName||'').includes(filter)||item.last.text.includes(filter));
    el('queue-count').textContent=list.length+internal.length;
    // 平台管理员要先知道自己在跟哪家公司的客服说话：他不属于任何公司，后端按他选定的
    // 租户范围返回同事目录，公司名只有这里写出来才看得见。
    el('queue-caption').textContent=isPlatformAdminView()
      ?`平台管理员视角 · ${workspaceTenantName||'当前公司'} · 与客服的内部会话`
      :(conversationStatus==='ended'?'已结束 · 聊天记录可查看':'系统已分配 · 处理中');
    const activeCount=conversations.filter(c=>c.status==='active').length;
    // 同事会话也是待处理项，两个计数都算上，否则标签上的数字和列表里的条数对不上。
    el('active-conversation-count').textContent=activeCount+internalChats.length;
    el('processing-count').textContent=activeCount+internalChats.length;
    el('ended-count').textContent=conversations.filter(c=>c.status==='ended').length;
    document.querySelectorAll('[data-conversation-status]').forEach(button=>{
      const selected=button.dataset.conversationStatus===conversationStatus;
      button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));
    });
    const customerRows=list.map(c=>{
      const sender=lastSenderLabel(c);
      return `<div class="conversation ${String(c.id)===String(currentId)&&!queueInternalPeerId?'active':''}" data-id="${safe(c.id)}"><div class="avatar">${safe(c.initial)}</div><div><div class="conversation-top"><span class="conversation-name">${safe(c.name)}</span><span class="role-chip customer">客户</span><span class="time">${safe(c.time)}</span></div><div class="preview">${sender?`<span class="from ${sender.by}">${sender.label} ${safe(sender.name)}</span>：`:''}${safe(c.preview)}</div><div class="conv-foot"><span class="store-chip">${safe(storeLabelOf(c.store))}</span><span class="pill ${c.status==='ended'?'gray':'blue'}">${c.status==='ended'?'已结束':'接待中'}</span></div></div></div>`;
    }).join('');
    // 同事行：两端不一定是同一个角色——另一端可能是平台管理员——所以标注按对方的实际
    // 角色写。写死「客服」会把平台侧的人说成本公司客服，这是看这行的人最先会误解的地方。
    const internalRows=internal.map(item=>{
      const name=item.peer?.displayName||'同事';
      const peerLabel=roleLabelOf(item.peer?.role||'agent');
      const mine=item.last.mine;
      // 只发了图片/文件、没写文字的消息 body 是空串；预览行照抄 body 就会空一片，
      // 看起来像加载失败。空的时候改成说附件是什么。
      const preview=item.last.text||(item.last.attachment?attachmentSummary(item.last.attachment):'');
      return `<div class="conversation internal ${item.peerId===queueInternalPeerId?'active':''}" data-internal-peer="${safe(item.peerId)}">${avatarHtml(item.peer?.avatarUrl,name)}<div><div class="conversation-top"><span class="conversation-name">${safe(name)}</span><span class="role-chip ${item.peer?.role==='platform_admin'?'platform':'agent'}">${safe(peerLabel)}</span><span class="time">${safe(item.last.time)}</span></div><div class="preview"><span class="from agent">${mine?`我（${safe(roleLabelOf(selfRoleKey()))}）`:`${safe(peerLabel)} ${safe(name)}`}</span>：${safe(preview)}</div><div class="conv-foot"><span class="store-chip">${safe(item.peer?roleLabelOf(item.peer.role)+' · '+storeNameOf(item.peer.storeId):'同事')}</span><span class="pill gray">内部会话</span></div></div></div>`;
    }).join('');
    el('conversations').innerHTML=(customerRows+internalRows)||`<div class="empty">${
      isPlatformAdminView()?'还没有和客服的会话，到「联系人 → 团队」选一位客服开始':'当前没有会话'}</div>`;
    document.querySelectorAll('.conversation[data-id]').forEach(x=>x.onclick=async()=>{queueInternalPeerId=null;currentId=conversations.find(item=>String(item.id)===x.dataset.id)?.id??x.dataset.id;showCustomerConversation();renderAll();if(backendConnected)try{await loadConversationDetail(currentId)}catch(error){toast(error.message)}});
    document.querySelectorAll('.conversation[data-internal-peer]').forEach(x=>x.onclick=()=>{showDirectChat(x.dataset.internalPeer)});
  }
  function showCustomerConversation(){
    el('customer-chat-view').hidden=false;
    el('customer-assist').hidden=false;
    el('group-chat-view').hidden=true;
    el('group-chat-aside').hidden=true;
  }
  // 群聊和同事一对一复用同一块“内部协作”界面：两者都不经过微信客服外发
  // 通道，放在一起可以避免和客户会话混淆。
  function openInternalChat(){
    el('customer-chat-view').hidden=true;
    el('customer-assist').hidden=true;
    el('group-chat-view').hidden=false;
    el('group-chat-aside').hidden=false;
    renderInternalChat();
    renderContacts();
  }
  function showGroupChat(id){
    activeGroupChatId=id;
    activeDirectId=null;
    openInternalChat();
  }
  // 登录后“团队”这一栏的来源换成服务端同事目录：演示名单（陈小雨、李明…）和真实成员表是
  // 两套数据，混着显示会出现“点进去发现对方不存在”的死路。分组同样退回门店，因为演示里的
  // 售前客服 / 售后客服等分组在后端并不存在，编一个出来只会让人以为能维护。
  function storeNameOf(storeId){return storeId?remoteStores.get(storeId)||storeId:'未分配门店'}
  function roleLabelOf(role){return{agent:'客服',platform_admin:'平台管理员',platform_operator:'平台运营',merchant_admin:'商家管理员'}[role]||role||'同事'}
  function remoteTeamMembers(){
    return remotePeers.map(peer=>({
      id:peer.memberId,
      name:peer.displayName,
      initial:String(peer.displayName||'?').slice(0,1),
      // 同事目录里带回来的头像；没上传过就是 null，各处按姓名首字画。
      avatarUrl:peer.avatarUrl||null,
      // 角色留着给内部会话界面用：两端不一定是同一个角色，标注要按实际角色写。
      role:peer.role,
      // 平台管理员不属于任何公司，也没有门店。按门店分组会把他归到「未分配门店」，
      // 看起来像被漏配的同事；他自己成一组，才看得出这条线是发给平台侧的。
      group:peer.role==='platform_admin'?'平台':storeNameOf(peer.storeId),
      detail:`${roleLabelOf(peer.role)} · ${peer.role==='platform_admin'?'平台侧':storeNameOf(peer.storeId)}`,
    }));
  }
  function teamGroups(){
    const groups=[];
    remoteTeamMembers().forEach(person=>{if(!groups.includes(person.group))groups.push(person.group)});
    return groups;
  }
  function teamMembers(){return backendConnected?remoteTeamMembers():contacts.team;}
  function activeGroups(){return contactCategory==='team'&&backendConnected?teamGroups():contactGroups[contactCategory];}
  function activeMembers(){return contactCategory==='team'&&backendConnected?teamMembers():contacts[contactCategory];}
  // 未连后端时这个界面扮演的演示客服是陈小雨。profile.name 在未登录 / 退出后会被清成
  // “未登录”，不能拿它当演示身份，否则本地演示发出去的消息署名会变成“未登录”。
  function selfDisplayName(){return backendConnected?(profile.name||'我'):'陈小雨';}
  // 当前登录者的原始角色（未登录时按演示身份「客服」算）。内部会话这条线上两端不一定是
  // 同一个角色——另一端可能是平台管理员——所以标注要按实际角色写，写死「客服」会把
  // 平台侧的人说成本公司客服。
  function selfRoleKey(){return backendConnected?(backendSession?.access?.role||'agent'):'agent'}
  // 一条内部会话在列表里显示的最后一条消息（只用来取时间和摘要）。
  function contactLastMessage(person){
    if(backendConnected)return remoteThreads.get(person.id)?.lastMessageView||null;
    return (directThreads.get(person.id)||[]).at(-1)||null;
  }
  /** 附件在一行文字位置上的说法。只有附件的消息 text 是空字符串，列表那一行不能因此空着。 */
  function attachmentSummary(attachment){
    return `[${{image:'图片',video:'视频',file:'文件'}[attachment.kind]||'文件'}] ${attachment.name}`;
  }
  /** 服务端消息 -> 渲染视图。气泡方向只看是不是本人发的，与名字无关。 */
  function remoteMessageView(message,peer){
    const mine=message.senderMemberId===selfMemberId;
    const file=message.attachment;
    return{
      id:message.id,
      mine,
      sender:mine?selfDisplayName():(peer?.displayName||'同事'),
      time:formatBackendTime(message.createdAt),
      // 原始时间戳留着排序用：格式化后的 "13:21" 跨天就没法比大小了。
      at:message.createdAt,
      text:message.body,
      // 服务端的附件带的是「怎么读」的签名地址，不是字节；地址有十分钟寿命，
      // 所以每次回读都重新拿一份，不能缓存下来接着用。
      attachment:file?{id:file.id,kind:file.kind,name:file.fileName,url:file.url}:null,
    };
  }
  // 内部会话也进「我的会话」：同事来消息时不该先切到联系人栏才知道。只列真正有过
  // 消息的会话——点开却没说话的会话不是待办，列出来只是噪音。
  function internalQueueRows(){
    if(!backendConnected)return[];
    return [...remoteThreads.entries()]
      .filter(([,entry])=>entry.threadId&&entry.lastMessageView)
      .map(([peerId,entry])=>({peerId,peer:remotePeers.find(item=>item.memberId===peerId)||null,last:entry.lastMessageView}))
      .sort((a,b)=>String(b.last.at||'').localeCompare(String(a.last.at||'')));
  }
  async function loadRemotePeers(){
    try{
      const list=await api.internalPeers();
      if(Array.isArray(list))remotePeers=list;
    }catch(error){
      // 同事目录拉不到不影响客户会话，但要让人知道“联系人里没有同事”是故障而不是没人。
      remotePeers=[];
      toast(error.message||'同事目录加载失败');
    }
  }
  /** 拉取本人参与过的会话，用来在联系人列表上补出最后一条消息的时间。 */
  async function loadRemoteThreads(){
    const list=await api.internalThreads();
    if(!Array.isArray(list))return;
    list.forEach(entry=>{
      const peer=entry?.peer;
      if(!peer?.memberId)return;
      const existing=remoteThreads.get(peer.memberId);
      remoteThreads.set(peer.memberId,{
        threadId:entry.thread?.id||existing?.threadId||null,
        messages:existing?.messages||[],
        lastMessageView:entry.lastMessage?remoteMessageView(entry.lastMessage,peer):(existing?.lastMessageView||null),
      });
      // 有会话的这个人，目录必须认识：列表里那一行的名字与角色标注、点开后的会话窗口，
      // 都靠在目录里找得到他。目录可能比会话旧——本机跑的是旧构建、后端刚加的人、
      // 对方刚被停用——少了他这条会话就会显示成没有名字的「同事」，点开也是空白。
      // 这里已经拿到了服务端给的名字，补进目录就能显示、能点开。
      // 只在目录里没有时补：目录答得上来就以目录为准，不让会话数据盖掉它。
      if(!remotePeers.some(item=>item.memberId===peer.memberId))remotePeers=remotePeers.concat([peer]);
    });
  }
  // 每次拉取的序号：先发的请求可能后到，用序号丢弃过期结果，避免同事目录被旧响应覆盖。
  let teamDirectoryEpoch=0;
  async function refreshTeamDirectory(){
    const epoch=++teamDirectoryEpoch;
    await loadRemotePeers();
    if(epoch!==teamDirectoryEpoch)return;
    try{
      await loadRemoteThreads();
    }catch(error){
      toast(error.message||'内部会话摘要加载失败');
    }
    if(epoch!==teamDirectoryEpoch)return;
    renderContacts();
    renderConversations();
    // 客户会话的客服气泡画的是接待人那张脸，而接待人是谁要等这份目录。登录时客户会话
    // 先画出来、目录后到（见 bootWorkspace 的顺序），所以这里必须重画一次消息区：不重
    // 画的话，别人接待的会话会一直顶着自己的头像，直到手动点开另一条会话为止。
    renderMessages();
  }
  /** 回读一条会话的全文。服务端只给 member_id 和 body，名字与气泡方向在这里补。 */
  async function loadInternalMessages(personId){
    const entry=remoteThreads.get(personId);
    if(!entry?.threadId)return;
    const list=await api.internalMessages(entry.threadId);
    if(!Array.isArray(list))return;
    const peer=remotePeers.find(item=>item.memberId===personId)||null;
    entry.messages=list.map(message=>remoteMessageView(message,peer));
    entry.lastMessageView=entry.messages.at(-1)||null;
  }
  async function showDirectChat(personId){
    const person=teamMembers().find(item=>item.id===personId);
    if(!person)return;
    activeDirectId=personId;
    activeGroupChatId=null;
    queueInternalPeerId=personId;
    openInternalChat();
    renderConversations();
    if(!backendConnected)return;
    try{
      // 会话 ID 由服务端按两人推导，谁先开口都是同一个，所以两边打开的是同一条。
      const view=await api.internalOpenThread(personId);
      const existing=remoteThreads.get(personId);
      remoteThreads.set(personId,{
        threadId:view?.thread?.id||existing?.threadId||null,
        messages:existing?.messages||[],
        lastMessageView:existing?.lastMessageView||null,
      });
      await loadInternalMessages(personId);
    }catch(error){
      toast(error.message||'无法打开与同事的内部会话');
    }
    // 读取期间用户可能已经点到别人身上，别把旧会话画回新窗口。
    if(activeDirectId!==personId)return;
    renderInternalChat();
    renderContacts();
    renderConversations();
  }
  // 实时事件只说“这条会话有新消息”，不带正文：内容必须回读 REST，权限也在那一次读取里再判一次。
  function onInternalMessageCreated(data){
    const peerId=String(data?.sender_member_id||'');
    if(!peerId||peerId===selfMemberId)return;
    const entry=remoteThreads.get(peerId);
    if(entry?.threadId&&entry.threadId!==data.thread_id)return;
    // 正开着这条会话就不打扰；否则必须提示一句，否则消息落在没打开的会话里，
    // 界面上一点动静都没有，看起来就像“收不到”。
    const openHere=activeDirectId===peerId&&el('group-chat-view')&&!el('group-chat-view').hidden;
    const peerName=remotePeers.find(peer=>peer.memberId===peerId)?.displayName||'同事';
    if(!entry?.threadId){
      // 还没打开过和这个人的会话：只把摘要刷新出来，全文等点进去再读。
      // 不因为「目录里暂时没有这个人」就丢掉通知：一条会话本身就是「有这位同事」的证据，
      // 回读会话列表会把他补进目录（见 loadRemoteThreads）。丢掉的后果是消息静默消失，
      // 比显示成「同事」更难排查。
      loadRemoteThreads().then(()=>{renderContacts();renderConversations()}).catch(()=>{});
      toast(`${peerName} 给你发了内部消息`);
      return;
    }
    loadInternalMessages(peerId).then(()=>{
      renderContacts();
      // 「我的会话」里也有这条同事会话，摘要和排序都要跟着变。
      renderConversations();
      if(activeDirectId===peerId)renderInternalChat();
    }).catch(()=>{});
    if(!openHere)toast(`${peerName} 给你发了内部消息`);
  }
  function activeContact(){return teamMembers().find(item=>item.id===activeDirectId)||null;}
  function setQueueMode(mode){
    const showContacts=mode==='contacts';
    el('conversation-panel').hidden=showContacts;
    el('contacts-panel').hidden=!showContacts;
    el('conversation-search').hidden=showContacts;
    el('contact-search').hidden=!showContacts;
    el('queue-title').textContent=showContacts?'联系人':'会话工作台';
    document.querySelectorAll('[data-queue-mode]').forEach(button=>{
      const active=button.dataset.queueMode===mode;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    });
    if(showContacts){
      // 每次进联系人补一次同事目录：别人刚发的消息、刚入职或停用的同事，只有重读才知道。
      if(contactCategory==='team'&&backendConnected)refreshTeamDirectory();
      if(contactCategory==='groupChats'&&activeGroupChatId)showGroupChat(activeGroupChatId);
      else if(contactCategory==='team'&&activeDirectId)showDirectChat(activeDirectId);
      else renderContacts();
    }else if(queueInternalPeerId&&backendConnected&&remoteThreads.has(queueInternalPeerId)){
      // 客户会话与同事会话共用「我的会话」列表：上一条打开的是同事就保持原样，
      // 切回来时把人顶到别的会话上会让人以为消息丢了。
      void showDirectChat(queueInternalPeerId);
    }else{
      queueInternalPeerId=null;
      if(activeConversation()?.status!==conversationStatus)currentId=conversations.find(c=>c.status===conversationStatus)?.id??null;
      showCustomerConversation();
      renderAll();
    }
  }
  // TODO(API): Internal groups and colleague 1:1 threads both require
  // tenant-scoped membership, history and real-time events. Neither may reuse
  // the external customer send endpoint.
  function renderInternalChat(){
    const person=activeContact();
    const group=person?null:groupChats.find(item=>item.id===activeGroupChatId);
    if(!person&&!group)return;
    const messages=person?(backendConnected?(remoteThreads.get(person.id)?.messages||[]):(directThreads.get(person.id)||[])):group.messages;
    if(person){
      el('group-chat-title').textContent=person.name;
      el('group-chat-subtitle').textContent=`${person.detail} · 一对一内部会话`;
      el('group-chat-member-count').textContent='2 人';
      el('group-chat-members').innerHTML=[{name:selfDisplayName(),detail:'我 · '+roleLabelOf(selfRoleKey()),avatarUrl:profile.avatarUrl},{name:person.name,detail:person.detail,avatarUrl:person.avatarUrl}].map(member=>`<div class="group-member">${avatarHtml(member.avatarUrl,member.name)}<span><strong>${safe(member.name)}</strong><small>${safe(member.detail)}</small></span></div>`).join('');
      el('group-chat-note').textContent='此处是与同事的一对一内部沟通，消息不会发送到微信客服客户。';
      el('group-chat-aside-title').textContent='会话信息';
      el('group-chat-member-label').textContent='会话成员';
      // 这里原有的那句说明（关于成员资格、以及同租户其他同事只收到通知看不到内容）按要求删掉了：
      // 一对一这一栏因此没有文字，整段收起，切回群聊时再放出来。接口与权限一个字没动，
      // 删掉的是界面上的说法，后端行为不变。
      el('group-chat-aside-note').textContent='';
      el('group-chat-aside-note').hidden=true;
      el('group-composer-label').textContent='发送给 '+person.name;
      el('group-chat-send').textContent='发送 ↗';
      el('group-chat-reply').placeholder='输入给'+person.name+'的消息…';
      el('group-chat-reply').setAttribute('aria-label','发送给'+person.name+'的内部消息');
    }else{
      el('group-chat-title').textContent=group.name;
      el('group-chat-subtitle').textContent=`${group.detail} · ${group.members.length} 位成员`;
      el('group-chat-member-count').textContent=`${group.members.length} 人`;
      el('group-chat-members').innerHTML=group.members.map(name=>`<div class="group-member">${avatarHtml(null,name)}<span><strong>${safe(name)}</strong><small>${name==='陈小雨'?'我 · 客服':'团队成员'}</small></span></div>`).join('');
      el('group-chat-note').textContent=backendConnected
        ?'群聊尚未接入服务端：登录状态下这里仍是本地演示，消息不会发出去，也不会到同事那里。'
        :'此处是团队内部群聊演示，消息不会发送到微信客服客户。';
      el('group-chat-aside-title').textContent='群聊信息';
      el('group-chat-member-label').textContent='群成员';
      el('group-chat-aside-note').hidden=false;
      el('group-chat-aside-note').textContent=backendConnected
        ?'群成员与消息目前只保存在本次页面会话中。本轮只接通了同事一对一：群聊仍需服务端提供群权限、消息历史与实时通知。'
        :'群聊、成员和消息目前保存在本次页面会话中。正式接入时需要服务端提供群权限、消息历史与实时通知。';
      el('group-composer-label').textContent='发送到内部群聊';
      el('group-chat-send').textContent='发送群消息 ↗';
      el('group-chat-reply').placeholder='输入群消息…';
      el('group-chat-reply').setAttribute('aria-label','发送到内部群聊的消息');
    }
    const dayLabel=person?'今天 · 内部会话':'今天 · 内部协作';
    const emptyText=person?`还没有和${person.name}的会话，发条消息开始协作。`:'群聊已创建，发送第一条消息开始协作。';
    // 这条线上两端不一定都是客服：另一端可能是平台管理员。标注按实际角色写，
    // 否则平台侧的发言会被标成「客服」，看的人会以为对方是本公司客服。
    const peerRole=person?(person.role||'agent'):'agent';
    const sideRole=mine=>{
      const role=mine?selfRoleKey():peerRole;
      return{key:role==='platform_admin'?'platform':'agent',label:roleLabelOf(role)};
    };
    el('group-chat-messages').innerHTML=`<div class="day">${safe(dayLabel)}</div>`+(messages.length?messages.map(message=>{
      const mine=message.mine??(message.sender===selfDisplayName());
      const role=sideRole(mine);
      // 自己这条用自己的头像，对方那条用同事目录里的头像；群里（本地演示）没有同事
      // 目录可取，两边都退回姓名首字。
      const senderAvatar=mine?profile.avatarUrl:(person?.avatarUrl||null);
      return `<div class="message ${mine?'agent':''}">${avatarHtml(senderAvatar,message.sender)}<div class="message-content"><div class="message-meta"><span class="msg-role ${role.key}">${safe(role.label)}</span>${safe(message.sender)} · ${safe(message.time)}</div><div class="bubble"></div></div></div>`;
    }).join(''):`<div class="empty">${safe(emptyText)}</div>`);
    // 标明这条线里两边都是同事：同一块界面既可能显示客户消息也可能显示同事消息，
    // 不标就看不出这条消息会不会发到客户那里。
    // 这条线是「一对一且已登录」才真的发得出去：群聊仍是本地演示。工具栏右边那枚标签
    // 说的就是这件事，别让人以为给同事发的消息都到了服务端。
    el('group-composer-pill').textContent=(person&&backendConnected)?'已接通后端':'仅本地演示';
    el('group-chat-messages').querySelectorAll('.bubble').forEach((bubble,index)=>{
      bubble.textContent=messages[index].text;
    });
    // 附件两种来源共用这一套画法：登录状态下来自服务端（地址是十分钟寿命的签名链接，
    // 每次回读重发一份），未登录时来自本地草稿。图片直接显示、视频给播放器、
    // 其余给下载链接——与客户会话同一套渲染。文件一律走下载而不是内嵌打开：
    // 内嵌会把对方传来的内容当成本站页面运行。
    el('group-chat-messages').querySelectorAll('.bubble').forEach((bubble,index)=>{
      const attachment=messages[index].attachment;
      if(!attachment)return;
      if(attachment.kind==='image'){
        const image=document.createElement('img');image.src=attachment.url;image.alt=attachment.name;image.className='message-image';bubble.append(image);
      }else if(attachment.kind==='video'){
        const video=document.createElement('video');video.src=attachment.url;video.controls=true;video.preload='metadata';video.className='message-video';video.setAttribute('aria-label',attachment.name);bubble.append(video);
      }else{
        const link=document.createElement('a');link.href=attachment.url;link.download=attachment.name;link.textContent='下载文件：'+attachment.name;link.className='message-file';bubble.append(link);
      }
    });
    // 草稿附件跟着当前打开的对象走：切到另一位同事时不能留下上一条的附件。
    renderInternalAttachment();
    el('group-chat-messages').scrollTop=el('group-chat-messages').scrollHeight;
  }
  // 买家联系人上记的是“当时那条会话”的 ID。登录后会话列表会被真实后端数据替换
  // （见 loadRemoteConversations），演示数据里的 ID 可能已经不存在，所以先按 ID 找，
  // 再按客户名兜底；都找不到时由调用方给出提示。
  function findBuyerConversation(person){
    if(!person)return null;
    return conversations.find(item=>String(item.id)===String(person.conversationId))
      ||conversations.find(item=>item.name===person.name)
      ||null;
  }
  // TODO(API): Fetch team and buyer directories by tenant and authorized store.
  // 一个分组此刻该展开还是收起。用户的点击最优先，两个集合就是他的两次表态；
  // 只有从没点过的分组才走默认值，否则「默认展开」会把点击结果原样覆盖掉。
  function isContactGroupOpen(category,group,searching){
    const key=category+':'+group;
    if(expandedContactGroups.has(key))return true;
    if(collapsedContactGroups.has(key))return false;
    // 搜索时全部展开：命中的成员就那么几个，再折一层就看不到搜到了什么。
    // 登录后的团队一栏是门店分组，也默认展开（见下方注释）。
    return searching||(category==='team'&&backendConnected);
  }
  // Group membership must be stored server-side; these mutable arrays are demo data.
  function renderContacts(){
    const category=contactCategory;
    const term=el('contact-search').value.trim();
    el('add-contact-group').textContent=category==='groupChats'?'＋ 新建群聊':'＋ 新建分组';
    el('contact-search').placeholder=category==='groupChats'?'搜索群聊或成员':'搜索姓名或分组';
    // 维护分组和建群是管理动作，客服角色不提供入口。
    // 后端同事目录的分组是门店，不是可维护的分组，所以登录后团队一栏不提供新建入口。
    el('add-contact-group').hidden=category==='blacklist'||!canManageContacts()||(category==='team'&&backendConnected);
    document.querySelectorAll('[data-contact-category]').forEach(button=>button.classList.toggle('active',button.dataset.contactCategory===category));
    if(category==='groupChats'){
      const visible=groupChats.filter(group=>group.name.includes(term)||group.members.some(name=>name.includes(term)));
      el('contacts-list').innerHTML=visible.length?visible.map(group=>{
        const last=group.messages.at(-1);
        return `<button class="group-chat-entry ${group.id===activeGroupChatId?'active':''}" type="button" data-group-chat-id="${safe(group.id)}"><span class="group-chat-icon">群</span><span class="group-chat-entry-text"><strong>${safe(group.name)}</strong><small>${safe(last?last.sender+'：'+last.text:group.detail)}</small><em>${group.members.length} 位成员</em></span><span class="group-chat-entry-time">${safe(last?.time||'')}</span></button>`;
      }).join(''):'<div class="contact-empty">没有找到群聊。可点击右上角新建群聊。</div>';
      document.querySelectorAll('[data-group-chat-id]').forEach(button=>button.onclick=()=>showGroupChat(button.dataset.groupChatId));
      return;
    }
    if(category==='blacklist'){
      el('contacts-list').innerHTML='<div class="contact-empty">暂无黑名单联系人。此栏目仅展示界面，名单操作需后端权限支持。</div>';
      return;
    }
    // 登录后团队一栏来自服务端同事目录；买家分组仍是演示数据（第一轮不接）。
    const groups=activeGroups();
    const members=activeMembers();
    const visibleGroups=groups.filter(group=>group.includes(term)||members.some(person=>person.group===group&&(person.name.includes(term)||person.detail.includes(term))));
    el('contacts-list').innerHTML=visibleGroups.length?visibleGroups.map(group=>{
      const grouped=members.filter(person=>person.group===group);
      const visible=term&&!group.includes(term)?grouped.filter(person=>person.name.includes(term)||person.detail.includes(term)):grouped;
      // 后端同事目录按门店分组，默认展开：同事本来就少，再折一层就没人看得到。
      const open=isContactGroupOpen(category,group,Boolean(term));
      return `<section class="contact-group"><button class="contact-group-toggle" type="button" data-group="${safe(group)}" aria-expanded="${open}"><span class="contact-group-arrow">▶</span>${safe(group)}<span class="contact-group-count">${grouped.length}</span></button><div class="contact-group-body" ${open?'':'hidden'}>${visible.length?visible.map(person=>{
        // 同事行：有内部会话的显示最后一条消息时间，当前打开的高亮并标记给读屏。
        const lastMessage=category==='team'?contactLastMessage(person):null;
        // 后端同事目录的分组就是门店，不是可维护的分组，所以行内不出现分组维护入口。
        const selected=category==='team'&&person.id===activeDirectId;
        return `<div class="contact-entry${selected?' active':''}"><button class="contact-entry-main" type="button" data-contact-id="${safe(person.id)}"${selected?' aria-current="true"':''}>${avatarHtml(person.avatarUrl,person.initial)}<span class="contact-entry-text"><span class="contact-entry-name">${safe(person.name)}</span><span class="contact-entry-detail">${safe(person.detail)}</span></span></button>${lastMessage?.time?`<span class="time">${safe(lastMessage.time)}</span>`:''}${canManageContacts()&&!(category==='team'&&backendConnected)?`<button class="contact-more" type="button" data-contact-more="${safe(person.id)}" aria-label="管理 ${safe(person.name)} 的分组">⋯</button>`:''}</div>`;
      }).join(''):'<div class="contact-empty">暂无联系人</div>'}</div></section>`;
    }).join(''):'<div class="contact-empty">没有找到匹配的联系人或分组</div>';
    document.querySelectorAll('.contact-group-toggle').forEach(button=>button.onclick=()=>{
      const key=category+':'+button.dataset.group;
      // 按此刻画面上的状态取反，而不是看集合里有没有：从没点过的门店分组
      // 不在任何集合里，但它是展开的，点一下就该收起。
      const open=isContactGroupOpen(category,button.dataset.group,Boolean(term));
      if(open){expandedContactGroups.delete(key);collapsedContactGroups.add(key);}
      else{collapsedContactGroups.delete(key);expandedContactGroups.add(key);}
      renderContacts();
    });
    document.querySelectorAll('[data-contact-id]').forEach(button=>button.onclick=async()=>{
      const person=members.find(item=>item.id===button.dataset.contactId);
      if(category==='buyers'){
        const conversation=findBuyerConversation(person);
        // 找不到就明确告知：静默失败会让“点不进去”变成无法排查的问题。
        if(!conversation){toast((person?.name||'该买家')+'当前没有可打开的会话');return}
        currentId=conversation.id;
        conversationStatus=conversation.status;
        setQueueMode('conversations');
        renderAll();
        if(backendConnected)try{await loadConversationDetail(currentId)}catch(error){toast(error.message)}
      }else if(category==='team'){
        // 同事：点名字直接进入一对一内部会话，不走分组维护弹窗。
        showDirectChat(person.id);
      }else openContactEditor(person);
    });
    document.querySelectorAll('[data-contact-more]').forEach(button=>button.onclick=()=>{
      openContactEditor(members.find(item=>item.id===button.dataset.contactMore));
    });
  }
  function openContactEditor(person){
    // 分组维护属于管理动作：客服即使通过其它入口触发也要被拦下。
    if(!canManageContacts()){toast('当前角色无权维护联系人分组');return}
    const options=contactGroups[contactCategory].map(group=>`<option value="${safe(group)}" ${group===person.group?'selected':''}>${safe(group)}</option>`).join('');
    showModal(person.name+' · 联系人分组',person.detail,()=>{
      const nextGroup=el('contact-target-group').value;
      person.group=nextGroup;
      // 刚把这个人移进去，就是要看见他：拉开这一组，并清掉之前可能按下的收起。
      expandedContactGroups.add(contactCategory+':'+nextGroup);
      collapsedContactGroups.delete(contactCategory+':'+nextGroup);
      renderContacts();
      toast(person.name+' 已移至「'+nextGroup+'」（模拟）');
    },`<label for="contact-target-group" class="setting-title">所属分组</label><select id="contact-target-group" class="field" style="margin-top:7px">${options}</select>`);
  }
  function renderMessages(){ const c=activeConversation();
    const chat=el('customer-chat-view');
    chat.querySelector('.chat-header').hidden=!c;
    chat.querySelector('.notice').hidden=!c||c.status==='ended';
    chat.querySelector('.composer').hidden=!c||c.status==='ended'||c.canReply===false;
    el('messages').hidden=!c;
    el('conversation-empty').hidden=!!c;
    // 平台管理员这块位置永远没有客户会话可选中。空着只会让人以为会话没加载出来，
    // 所以说明白这一栏为什么是空的、该去哪里开工。
    el('conversation-empty').textContent=isPlatformAdminView()
      ?'平台管理员不显示客户会话；请从左侧「联系人 → 团队」选择一位客服开始内部会话。'
      :'当前分类暂无会话';
    el('conversation-ended-note').hidden=!c||c.status!=='ended';
    if(!el('group-chat-view').hidden)el('customer-assist').hidden=true;
    else el('customer-assist').hidden=!c;
    if(!c){el('messages').innerHTML='';el('send-btn').disabled=true;renderReplyWindow(null);return}
    renderReplyWindow(c);
    const storeLabel=backendConnected?c.store:`青禾生活${c.store}`;
    el('chat-name').innerHTML=`${safe(c.name)} <span class="pill ${c.status==='ended'?'gray':'blue'}" id="chat-status">${c.status==='ended'?'已结束':'接待中'}</span>`; el('chat-subtitle').textContent=`企业微信客服 · ${storeLabel} · ${c.status==='ended'?'会话已结束':c.canReply===false?'只读会话':'接待人 '+profile.name}`;
    const deliveryLabels={pending:'等待渠道发送',sent:'渠道已发送',failed:'渠道发送失败',unknown:'渠道结果未知'};
    // 客服那一侧的头像与署名都按接待人写（见 conversationAgent）：这条会话记的是「谁在
    // 接待」，消息行不带发送人。客户那一侧没有头像可取，仍画首字。
    const agent=conversationAgent(c);
    el('messages').innerHTML='<div class="day">会话记录</div>'+c.messages.map(m=>`<div class="message ${m.by==='agent'?'agent':''}">${m.by==='agent'?avatarHtml(agent.avatarUrl,agent.initial):avatarHtml(null,c.initial)}<div class="message-content"><div class="message-meta"><span class="msg-role ${m.by}">${m.by==='agent'?'客服':'客户'}</span>${m.by==='agent'?safe(agent.name):safe(c.name)} · ${m.time}${m.source?' · '+safe(m.source):''}${m.deliveryStatus?' · '+safe(deliveryLabels[m.deliveryStatus]||m.deliveryStatus):''}</div><div class="bubble"></div></div></div>`).join('');
    el('messages').querySelectorAll('.message .bubble').forEach((x,i)=>{
      // 有媒体的消息不写这段文字。渠道的媒体消息本身不带说明文字，服务端记下的那份
      // 内容是按类型推出来的：图片/视频是平台占位符，文档干脆就是文件名。它给的是
      // 不渲染媒体的地方（列表预览、导出记录）读的一份文本，气泡里已经有图、有播放器、
      // 有下载链接了，再写一遍就是「[图片消息]」压着一张图，或者文件名旁边又写一次文件名。
      if(c.messages[i].attachment)return;
      x.textContent=c.messages[i].text;
    });
    el('messages').querySelectorAll('.message .bubble').forEach((bubble,index)=>{
      const attachment=c.messages[index].attachment;
      if(!attachment)return;
      if(attachment.kind==='image'){
        const image=document.createElement('img');image.src=attachment.url;image.alt=attachment.name;image.className='message-image';bubble.append(image);
      }else if(attachment.kind==='video'){
        const video=document.createElement('video');video.src=attachment.url;video.controls=true;video.preload='metadata';video.className='message-video';video.setAttribute('aria-label',attachment.name);bubble.append(video);
      }else{
        const link=document.createElement('a');link.href=attachment.url;link.download=attachment.name;link.textContent='下载文件：'+attachment.name;link.className='message-file';bubble.append(link);
      }
    });
    renderAttachment();
    el('messages').scrollTop=el('messages').scrollHeight; el('send-btn').disabled=c.status==='ended'||presenceState==='offline'||c.canReply===false;
    el('close-btn').hidden=c.status==='ended';
    // 转交只在服务端确实允许的动作上出现：正在接待的会话由当前接待人转移；接待人
    // 已下线的会话由管理员或同店铺坐席接手后再转移——后者就是会话详情返回的
    // canTakeOver（平台规则 mayTakeOverClaim 的读法，前端不自己推）。待接入（尚未
    // 认领）和已结束会话本就没有转移动作，按钮不出现。前端只收口入口，转交能否
    // 成立仍由服务端在提交时判定；被拒绝时提示服务端给出的说明。
    const canTransfer=backendConnected
      ?c.rawStatus==='claimed'&&(c.assignedMemberId===selfMemberId||c.canTakeOver===true)
      :c.status==='active';
    el('transfer-btn').hidden=!canTransfer;
    el('assignment-history-btn').hidden=!backendConnected;
    // 导出对话记录导的是后端那条会话，所以要真有后端会话才给入口：演示数据里的会话
    // 没有服务端 id，点进去只会得到「不在导出范围内」。
    el('export-conversation-btn').hidden=!backendConnected;
    el('close-btn').hidden=c.status==='ended'||backendConnected&&c.canReply!==true&&!c.canTakeOver;
  }

  // Candidate responses come from POST /retrieval/suggestions: the server classifies the
  // intent, searches the 话术库 first (a hit is returned and no model is asked), and only
  // falls back to the 商品库 plus generation. The candidate id, the recall evidence, the
  // score and every degradation reason travel on the set, so this panel renders facts
  // instead of guessing why the list is empty.
  function renderCandidates(){
    const c=activeConversation();
    if(!c||c.status==='ended'){
      currentSuggestions=[];
      el('candidate-label').textContent='暂无候选回复';el('candidate-status').textContent='已结束';
      el('candidate-detail').disabled=true;el('product-section').style.display='none';
      el('candidates').innerHTML='<div class="footnote">历史会话仅供查看聊天记录。</div>';return;
    }
    if(backendConnected){
      renderRemoteCandidates(c);
      return;
    }
    // The switch pauses AI suggestions only; manual replies, shortcuts and
    // product context stay available so customer service can continue.
    if(!assistEnabled){
      currentSuggestions=[];
      el('candidate-label').textContent='AI 辅助已暂停';
      el('candidate-status').textContent='已暂停';
      el('candidate-detail').disabled=true;
      el('product-section').style.display=[1,4].includes(c.id)?'':'none';
      el('candidates').innerHTML='<div class="footnote">可继续手动回复或使用快捷短语。点击顶部「开启辅助」恢复候选话术。</div>';
      return;
    }
    el('candidate-detail').disabled=false;
    currentSuggestions=c.id===2?[{title:'FAQ 标准答案',text:'您好，商品通常会在付款后 48 小时内发出，具体发货时间请以商品页面与订单通知为准。',source:'店铺 FAQ · 发货时间'}]:c.id===4?[{title:'商品资料提示',text:'这款商品有米白色规格。库存信息可能发生变化，请您打开商品链接查看当前可选规格，或稍等我为您人工核实。',source:'商品规格快照 · 库存需人工核实'}]:c.id===3||c.id===5?[]:suggestions;
    el('candidate-label').textContent=currentSuggestions.length?currentSuggestions.length+' 条候选回复':'暂无可靠候选';
    el('candidate-status').textContent=currentSuggestions.length?'已完成检索':'请人工处理';
    el('product-section').style.display=[1,4].includes(c.id)?'':'none';
    el('candidates').innerHTML=currentSuggestions.length?candidateCardsHtml(currentSuggestions):'<div class="footnote">知识库未命中可靠内容，请客服手动回复或使用快捷短语。</div>';
    bindCandidateUse();
  }
  // 候选卡片与「选用」绑定由两个分支共用（演示数据 / 服务端 set）：坐席看到的卡片行为必须
  // 一致，唯一差别是服务端候选带 candidateId，采纳时一路送到发送接口作为来源追溯。
  function candidateCardsHtml(list){
    return list.map((s,i)=>`<div class="candidate"><div class="candidate-top"><span class="candidate-title">${i+1}. ${safe(s.title)}</span><span class="pill ${i===0?'blue':'gray'}">${i===0?'优先':'备选'}</span></div><p>${safe(s.text)}</p><div class="candidate-bottom"><span class="source" title="${safe(s.source)}">${safe(s.source)}</span><button class="use-btn" data-index="${i}">选用 ↗</button></div></div>`).join('');
  }
  function bindCandidateUse(){
    document.querySelectorAll('.use-btn').forEach(b=>b.onclick=()=>{
      const i=Number(b.dataset.index);
      el('reply').value=currentSuggestions[i].text;
      selectedSuggestion=i;
      originalSuggestion=currentSuggestions[i].text;
      selectedCandidateId=currentSuggestions[i].candidateId||'';
      el('reply-hint').textContent='已选用第 '+(i+1)+' 条候选 · 可编辑后发送';
      el('reply').focus();
      toast('候选回复已填入编辑区');
    });
  }
  // 服务端稳定原因码 → 坐席能读懂的一句话。这张表就是「为什么没有候选」的答案，新增原因码时
  // 前端要跟着补，否则面板只能把原始码摆给坐席看。
  const SUGGESTION_REASON_TEXT={
    chitchat_no_retrieval:'客户只是寒暄，未做检索。',
    no_generation_provider:'未配置生成模型，只显示检索到的内容。',
    generation_unavailable:'生成模型调用失败，已退回检索结果。',
    semantic_recall_unavailable:'向量检索未运行（未配置嵌入模型），本次只用了关键词检索。',
    no_knowledge_match:'话术库与商品库都没有命中。',
    empty_query:'这条客户消息没有可检索的文字（可能是语音或图片）。',
    content_blocked:'部分候选命中违禁词，已被内容安全拦截。',
  };
  const SUGGESTION_KIND_TEXT={shortcut:'快捷话术',faq:'店铺 FAQ',product:'商品资料'};
  const SUGGESTION_ORIGIN_TEXT={script:'话术库命中（未生成）',catalogue:'商品库命中（未生成）',generated:'AI 生成',none:'无候选'};
  function reasonTexts(reasons){return (reasons||[]).map(code=>SUGGESTION_REASON_TEXT[code]||('服务端原因：'+code))}
  // 「检索依据」弹窗：真实会话渲染服务端写下来的那一份证据，而不是另一段示例文案。
  function suggestionDetailSummary(set){
    if(!set)return '';
    return '意图：'+(set.intent==='chitchat'?'闲聊':'询问')
      +' · 来源：'+(SUGGESTION_ORIGIN_TEXT[set.origin]||set.origin)
      +' · 生成器：'+(set.provider==='deepseek'?'大模型':'检索与规则');
  }
  function suggestionDetailText(set){
    if(!set)return '';
    const rows=(set.candidates||[]).map(candidate=>{
      const modes=(candidate.recall?.modes||[]).map(mode=>mode==='semantic'?'向量':'关键词').join('+');
      const evidence=candidate.recall?('召回第 '+candidate.recall.rank+' 名（'+modes+'）'):'仅词面匹配';
      return '<div>· '+safe(SUGGESTION_KIND_TEXT[candidate.kind]||candidate.kind)+'「'+safe(candidate.title)+'」<br>　来源：'+safe(candidate.sourceId)+' · 依据：'+safe(evidence)+' · 词面分 '+(Number(candidate.score)||0)+'</div>';
    }).join('');
    const reasons=reasonTexts(set.fallbackReasons).map(text=>'<div>· '+safe(text)+'</div>').join('');
    return '<div class="review-card" style="font-size:12px">'+(rows||'<div>本次没有任何候选。</div>')+(reasons?'<div style="margin-top:8px">降级说明：</div>'+reasons:'')+'</div>';
  }
  function candidateReason(code){return {no_generation_provider:'未配置生成模型，使用知识库检索回复',no_knowledge_match:'知识库未命中',empty_query:'暂无客户问题',semantic_recall_unavailable:'语义检索不可用，使用关键词检索',generation_provider_failed:'生成模型失败，使用知识库检索回复',safety_blocked:'候选因内容安全规则被过滤'}[code]||code}
  function renderRemoteCandidates(c){
    const latest=c.messages.filter(message=>message.direction==='inbound').at(-1);
    const key=latest?.id||'';
    let state=remoteSuggestions.get(c.id);
    el('product-section').style.display='none';el('candidate-detail').disabled=true;
    currentSuggestions=[];
    if(!assistEnabled||!latest||c.canReply!==true){
      el('candidate-label').textContent=!assistEnabled?'AI 辅助已暂停':'暂无候选回复';
      el('candidate-status').textContent='等待';
      el('candidates').innerHTML='<div class="footnote">'+(!assistEnabled?'开启辅助后获取候选。':c.canReply!==true?'当前会话只读。':'等待客户发来问题。')+'</div>';return;
    }
    if(!state||state.key!==key){
      state={key,loading:true};remoteSuggestions.set(c.id,state);
      const epoch=workspaceEpoch;
      api.suggestions(c.id).then(set=>{
        if(epoch!==workspaceEpoch||remoteSuggestions.get(c.id)!==state)return;
        state.set=set;state.loading=false;
        if(String(currentId)===String(c.id))renderCandidates();
      }).catch(error=>{
        if(epoch!==workspaceEpoch||remoteSuggestions.get(c.id)!==state)return;
        state.error=error.message;state.loading=false;
        if(String(currentId)===String(c.id))renderCandidates();
      });
    }
    el('candidate-label').textContent=state.loading?'正在获取候选':state.error?'候选获取失败':`${state.set.candidates.length} 条候选回复`;
    el('candidate-status').textContent=state.loading?'检索中':state.set?.provider==='deepseek'?'模型生成':'知识库检索';
    if(state.loading){el('candidates').innerHTML='<div class="footnote">正在检索当前公司的知识库…</div>';return}
    el('candidate-detail').disabled=!state.set;
    const reasons=(state.set?.fallbackReasons||[]).map(candidateReason).join('；');
    currentSuggestions=(state.set?.candidates||[]).map(item=>({...item,text:item.content,source:`${item.kind} · ${item.title} · 评分 ${Number(item.score).toFixed(3)}`}));
    el('candidates').innerHTML=`<div class="footnote">${safe(state.error||reasons||'候选来自后端，请人工确认后发送。')}</div>`+currentSuggestions.map((item,index)=>`<div class="candidate"><div class="candidate-top"><span class="candidate-title">${index+1}. ${safe(item.title)}</span></div><p>${safe(item.text)}</p><div class="candidate-bottom"><span class="source" title="${safe(item.sourceId)}">${safe(item.source)}</span><button class="use-btn" data-index="${index}">选用 ↗</button></div></div>`).join('')+`<button class="btn" id="refresh-candidates">重新获取候选</button>`;
    el('refresh-candidates').onclick=()=>{remoteSuggestions.delete(c.id);renderCandidates()};
    el('candidates').querySelectorAll('.use-btn').forEach(button=>button.onclick=()=>{
      const index=Number(button.dataset.index),item=currentSuggestions[index];
      if(String(currentId)!==String(c.id))return;
      el('reply').value=item.text;selectedSuggestion=index;originalSuggestion=item.text;
      // 后端的候选标识是持久化的 suggestion set ID，单条来源另由详情保留。
      selectedCandidateId=state.set.id;selectedCandidateConversation=c.id;
      el('reply-hint').textContent='已选用候选 · 可编辑后发送';el('reply').focus();
    });
  }
  // Dashboard values are illustrative. In production the server supplies
  // scoped KPI values and metric availability for the selected store and date.
  // 接了后端就没有「今天」这个事实可用：这里拿到的是全量会话列表、时间是 HH:MM，
  // 「非昨天」恒为真，数出来必然是会话总数——那是编一个数字。按约定留白，等后端给统计。
  function renderOverviewMetrics(){
    el('today-served').textContent=backendConnected?'—':conversations.filter(c=>c.time!=='昨天').length;
  }
  function renderAll(){renderConversations();renderMessages();renderCandidates();renderOverviewMetrics();}
  el('conversation-search').oninput=renderConversations;
  document.querySelectorAll('[data-conversation-status]').forEach(button=>button.onclick=()=>{
    conversationStatus=button.dataset.conversationStatus;
    el('conversation-search').value='';
    if(activeConversation()?.status!==conversationStatus){
      currentId=conversations.filter(c=>c.status===conversationStatus).sort((a,b)=>(b.endedAt||0)-(a.endedAt||0))[0]?.id??null;
    }
    setQueueMode('conversations');
  });
  document.querySelectorAll('[data-queue-mode]').forEach(button=>button.onclick=()=>setQueueMode(button.dataset.queueMode));
  document.querySelectorAll('[data-contact-category]').forEach(button=>button.onclick=()=>{
    contactCategory=button.dataset.contactCategory;
    el('contact-search').value='';
    // 进入团队栏时补一次同事目录和会话摘要：登录后新同事入职、别的窗口刚发过消息，
    // 都只有重新读服务端才知道。
    if(contactCategory==='team'&&backendConnected)refreshTeamDirectory();
    if(contactCategory==='groupChats'&&activeGroupChatId)showGroupChat(activeGroupChatId);
    else if(contactCategory==='team'&&activeDirectId)showDirectChat(activeDirectId);
    else{showCustomerConversation();renderContacts();}
  });
  el('contact-search').oninput=renderContacts;
  el('add-contact-group').onclick=()=>{
    // 新建分组/新建群聊都是目录维护动作，客服角色只能读和发起一对一会话。
    if(!canManageContacts()){toast('当前角色无权维护联系人分组');return}
    if(contactCategory==='groupChats'){
      const memberOptions=contacts.team.filter(person=>person.name!=='陈小雨').map(person=>`<label class="group-member-option"><input type="checkbox" name="new-group-member" value="${safe(person.name)}"> ${safe(person.name)} <span>${safe(person.group)}</span></label>`).join('');
      showModal('新建内部群聊','选择参与协作的团队成员。当前仅在本次页面会话中保存。',()=>{
        const name=el('new-group-chat-name').value.trim();
        const selected=[...document.querySelectorAll('input[name="new-group-member"]:checked')].map(input=>input.value);
        if(!name){toast('请输入群聊名称');return false}
        if(groupChats.some(group=>group.name===name)){toast('群聊名称已存在');return false}
        if(!selected.length){toast('请至少选择一位团队成员');return false}
        const group={id:'group-'+Date.now(),name,detail:'青禾生活 · 内部协作',members:['陈小雨',...selected],messages:[]};
        groupChats.unshift(group);
        el('contact-search').value='';
        showGroupChat(group.id);
        toast('已创建群聊「'+name+'」（模拟）');
      },`<input id="new-group-chat-name" class="field" maxlength="24" placeholder="例如：售后协作群"><div class="group-member-options"><div class="setting-title">选择成员（陈小雨将自动加入）</div>${memberOptions}</div>`);
      return;
    }
    showModal('新建联系人分组','创建后可将当前租户可见的联系人移入此分组。',()=>{
      const name=el('new-contact-group-name').value.trim();
      if(!name){toast('请输入分组名称');return false}
      if(contactGroups[contactCategory].includes(name)){toast('该分组已存在');return false}
      contactGroups[contactCategory].push(name);
      expandedContactGroups.add(contactCategory+':'+name);
      collapsedContactGroups.delete(contactCategory+':'+name);
      renderContacts();
      toast('已创建分组「'+name+'」（模拟）');
    },'<input id="new-contact-group-name" class="field" maxlength="24" placeholder="例如：售前客服">');
  };
  async function sendInternalMessage(){
    const person=activeContact();
    const group=person?null:groupChats.find(item=>item.id===activeGroupChatId);
    const input=el('group-chat-reply');
    const text=input.value.trim();
    // 草稿按「当前打开的对象」存，键在等待期间可能已经变了（用户切了同事），
    // 所以取一次记住，成功或失败都按这个键清理，别动到别人的草稿。
    const attachmentKey=internalTargetKey();
    const attachment=internalAttachments.get(attachmentKey);
    if(!person&&!group)return;
    if(!text&&!attachment){toast(person?'请输入消息内容，或添加图片 / 视频 / 文件':'请输入群消息，或添加图片 / 视频 / 文件');return}
    if(person&&backendConnected){
      const entry=remoteThreads.get(person.id);
      if(!entry?.threadId){toast('内部会话还没建立，请重新点开这位同事');return}
      if(attachment?.uploading){toast('附件还在上传，请稍候再发送');return}
      // 只有拿到服务端草稿 ID 的附件才算数——上传失败的草稿已经被撤掉，所以走到这里
      // 却还没有 ID，说明状态不对，宁可让人重选，也不发一条没有附件的「带附件消息」。
      if(attachment&&!attachment.id){toast('附件没有上传成功，请重新选择文件');return}
      // 先清空再发：发失败会把原文放回去，不让人以为消息已经出去了。
      input.value='';
      try{
        const sent=await api.internalSend(entry.threadId,text,attachment?.id);
        const peer=remotePeers.find(item=>item.memberId===person.id)||null;
        const view=remoteMessageView(sent,peer);
        entry.messages.push(view);
        entry.lastMessageView=view;
        // 附件已经挂在消息上，本地那份预览就没用了，连同它的对象地址一起清掉，
        // 否则下一条消息会重复带上同一个文件。
        if(attachment)URL.revokeObjectURL(attachment.url);
        internalAttachments.delete(attachmentKey);
        renderInternalAttachment();
        renderInternalChat();
        renderContacts();
        renderConversations();
      }catch(error){
        input.value=text;
        toast([error.message,...(error.details||[])].filter(Boolean).join('；')||'内部消息发送失败');
      }
      return;
    }
    const message={sender:selfDisplayName(),time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),text,mine:true,attachment};
    if(person)directThreads.set(person.id,[...(directThreads.get(person.id)||[]),message]);
    else group.messages.push(message);
    // 附件已经进了这条消息，草稿要清掉，否则下一条会重复带上同一个文件。
    if(attachment)internalAttachments.delete(attachmentKey);
    input.value='';
    renderInternalChat();
    renderContacts();
    toast(person?`已发送给${person.name}（本地演示）`:'群消息已加入本地演示');
  }
  el('group-chat-send').onclick=sendInternalMessage;
  el('group-chat-reply').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendInternalMessage()}});
  // POST /api/v1/messages/send: send final edited text with Idempotency-Key.
  // HTTP success only means the local message/send task exists. Delivery status
  // must arrive in a later event and be rendered separately in the real app.
  async function send(){
    const text=el('reply').value.trim(),c=activeConversation(),attachment=replyAttachments.get(currentId);
    if(!c){toast('请先选择会话');return}
    if(presenceState==='offline'){toast('离线状态无法发送客服消息');return}
    if(!text&&!attachment){toast('请先输入回复内容或添加附件');return}
    if(c.status==='ended'){toast('该会话已结束');return}
    if(c.canReply===false){toast('当前会话为只读，不能发送消息');return}
    if(backendConnected){
      // 附件和文字不能一起发。渠道的媒体消息只有一个媒体位、没有说明文字，服务端因此
      // 不接受媒体请求里的文字——所以这里不是「先发附件、文字下次再说」，而是让坐席
      // 自己挑一个，免得打了半天的字被静默丢掉。
      if(attachment&&text){toast('附件消息不能同时带文字，请分两条发送');return}
      // 服务端返回的窗口说这条发不出去时不提交。判决本来就在服务端（Worker 的发送闸门，
      // 拒收会记下可见的降级原因），这里只是把它念给坐席听——不再像原型那样自己数一个
      // 写死的额度。前端据此拦下提交，不是前端拥有这条规则。
      const windowView=replyWindowView(c.replyWindow);
      if(windowView&&!windowView.open){toast(windowView.toast||'当前不能发送外发消息');return}
      // 草稿是按会话存的，发送要花时间，期间坐席可能已经换到别的会话：认领成功/失败都要
      // 按发出时那个会话清，不能按「现在选中的是谁」清。
      const attachmentKey=currentId;
      const backendSource=attachment?'manual_typed':selectedSuggestion<0?'manual_typed':text===originalSuggestion?'direct_candidate':'edited_send';
      el('send-btn').disabled=true;
      try{
        if(attachment){
          // 上传和发送是服务端同一次请求里的两步（平台素材句柄会过期，中间不能停在
          // 浏览器里），所以这里只等一个结果：成功意味着字节已经到了平台那边。
          attachment.sending=true;renderAttachment();
          await api.sendMediaMessage(c.backendId,attachment.file,backendSource);
          // 发出去了就把草稿连同本地预览地址一起撤掉。留着它，坐席下次点发送会把同一份
          // 文件再传一遍，服务端那边就是两条消息。
          URL.revokeObjectURL(attachment.url);
          replyAttachments.delete(attachmentKey);
          renderAttachment();
        }else{
          const candidateId=selectedSuggestion>=0&&String(selectedCandidateConversation)===String(c.id)?selectedCandidateId:null;
          await api.sendMessage(c.backendId,text,candidateId?backendSource:'manual_typed',candidateId);
          if(String(currentId)===String(c.id)&&el('reply').value.trim()===text){
            el('reply').value='';selectedSuggestion=-1;originalSuggestion='';selectedCandidateId=null;selectedCandidateConversation=null;
            el('reply-hint').textContent='Enter 发送 · Shift+Enter 换行';
          }
        }
        await loadRemoteConversations();
        // 这一条刚花掉一个窗口额度，提醒上的数字得跟着走：重新读一次详情，而不是在
        // 浏览器里自减（自减出来的数字与服务端对不上，正是这次要改掉的毛病）。
        await loadConversationDetail(c.backendId);
        toast(attachment?'附件已写入后端发送队列':'消息已写入后端发送队列');
      }catch(error){
        // 拒绝的原因在 details 里（英文领域说明，如「这个格式不支持」），error.message
        // 是状态文本，单念它等于什么都没说——和内部会话附件上传同一种读法。
        if(attachment){attachment.sending=false;renderAttachment()}
        toast([error.message,...(error.details||[])].filter(Boolean).join('；')||'消息发送失败');
      }
      finally{renderMessages()}
      return;
    }
    if(Number(el('budget').textContent)<=0){toast('当前外发额度已用完，请等待客户再次发来消息');return}
    const source=selectedSuggestion<0?'手打':text===originalSuggestion?'直接采纳':'编辑后发送';
    c.messages.push({by:'agent',time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),text,source,attachment});
    replyAttachments.delete(currentId);
    c.preview=text||`[${{image:'图片',video:'视频',file:'文件'}[attachment.kind]}]`;
    c.time='刚刚';el('reply').value='';selectedSuggestion=-1;originalSuggestion='';selectedCandidateId='';el('reply-hint').textContent='Enter 发送 · Shift+Enter 换行';
    const budget=el('budget');budget.textContent=Math.max(0,Number(budget.textContent)-1);
    renderAll();toast('已创建发送任务 · '+source+'（模拟）');
  }
  el('send-btn').onclick=()=>{closePhraseSuggestions();send()};
  el('reply').addEventListener('keydown',e=>{
    // 中文输入法确认候选时不能选短语或触发发送。
    if(e.isComposing||replyComposing||e.keyCode===229)return;
    if(!el('phrase-suggestions').hidden){
      if(e.key==='Escape'){e.preventDefault();closePhraseSuggestions();return}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        e.preventDefault();phraseIndex=(phraseIndex+(e.key==='ArrowDown'?1:phraseMatches.length-1))%phraseMatches.length;renderPhraseOptions();return;
      }
      if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();choosePhrase(phraseIndex);return}
    }
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}
  });
  function closePhraseSuggestions(){
    el('phrase-suggestions').hidden=true;
    el('reply').removeAttribute('aria-activedescendant');
    phraseMatches=[];phraseRange=null;
  }
  function highlightPhrase(value,query){
    const index=value.toLowerCase().indexOf(query.toLowerCase());
    return index<0?safe(value):safe(value.slice(0,index))+'<mark>'+safe(value.slice(index,index+query.length))+'</mark>'+safe(value.slice(index+query.length));
  }
  // 联想只从「我看得到的那几份」里挑（visiblePhrases 已按登录成员过滤个人短语），
  // 这是纯同步的本地匹配，所以没有需要丢弃的过期响应——短语集合的异步读取在
  // loadPersonalPhrases 里由 epoch + 会话身份守卫，读回来之后这里同步取用。
  // TODO(API): 这一层匹配仍在浏览器里做（短语量级小）；如果服务端要做短语检索，
  // 命中口径需要与这段表达式对齐，否则联想结果会与页面列出的不一致。
  function updatePhraseSuggestions(){
    const reply=el('reply');
    if(replyComposing||document.activeElement!==reply||reply.selectionStart!==reply.selectionEnd){closePhraseSuggestions();return}
    const before=reply.value.slice(0,reply.selectionStart);
    const token=before.match(/[^\s，。！？、；：,.!?;:]+$/)?.[0]||'';
    if(!token||token.length>30){closePhraseSuggestions();return}
    const query=token.toLowerCase();
    phraseMatches=visiblePhrases().filter(phrase=>phrase.enabled!==false&&[phrase.title,phrase.text,...(phrase.keywords||[])].some(value=>value.toLowerCase().includes(query)))
      .sort((a,b)=>(b.scope==='个人')-(a.scope==='个人')).slice(0,8);
    if(!phraseMatches.length){closePhraseSuggestions();return}
    phraseRange={start:before.length-token.length,end:before.length,query:token};phraseIndex=0;
    el('phrase-suggestions').hidden=false;
    renderPhraseOptions();
  }
  function renderPhraseOptions(){
    el('phrase-options').innerHTML=phraseMatches.map((phrase,index)=>`<button class="phrase-option" id="phrase-option-${index}" type="button" role="option" tabindex="-1" aria-selected="${index===phraseIndex}" data-phrase-index="${index}"><span class="phrase-scope">${safe(phrase.scope)}</span><span class="phrase-copy"><span class="phrase-title">${highlightPhrase(phrase.title,phraseRange.query)}</span><span class="phrase-preview">${highlightPhrase(phrase.text,phraseRange.query)}</span></span></button>`).join('');
    el('phrase-match-count').textContent=phraseMatches.length+' 条匹配';
    el('reply').setAttribute('aria-activedescendant','phrase-option-'+phraseIndex);
    el('phrase-options').querySelectorAll('button').forEach(button=>{
      button.onmousedown=event=>event.preventDefault();
      button.onclick=()=>choosePhrase(Number(button.dataset.phraseIndex));
    });
    el('phrase-option-'+phraseIndex).scrollIntoView({block:'nearest'});
  }
  function choosePhrase(index){
    const phrase=phraseMatches[index];
    if(!phrase||!phraseRange)return;
    // 仅替换光标前的匹配词，保留草稿其他段落；选中后仍由客服确认发送。
    el('reply').setRangeText(phrase.text,phraseRange.start,phraseRange.end,'end');
    selectedSuggestion=-1;originalSuggestion='';selectedCandidateId='';
    phrase.useCount=(phrase.useCount||0)+1;
    el('reply-hint').textContent='已填入快捷短语 · 可编辑后发送';
    closePhraseSuggestions();el('reply').focus();
  }
  el('reply').addEventListener('input',updatePhraseSuggestions);
  el('reply').addEventListener('click',updatePhraseSuggestions);
  el('reply').addEventListener('keyup',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))updatePhraseSuggestions()});
  el('reply').addEventListener('blur',closePhraseSuggestions);
  el('reply').addEventListener('compositionstart',()=>{replyComposing=true;closePhraseSuggestions()});
  el('reply').addEventListener('compositionend',()=>{replyComposing=false;updatePhraseSuggestions()});
  el('reply').addEventListener('input',()=>{if(selectedSuggestion>=0)el('reply-hint').textContent=el('reply').value===originalSuggestion?'直接采纳候选':'已编辑候选，发送后计为编辑后发送'});
  // TODO(API): 由服务端自动分配新会话；结束和转接仍需 state_version 防并发冲突。
  el('close-btn').onclick=async()=>{
    const c=activeConversation();
    if(!c||c.status!=='active')return;
    if(backendConnected){
      el('close-btn').disabled=true;
      try{
        await api.closeConversation(c.backendId,c.version);
        await loadRemoteConversations();
        toast('会话已由后端结束');
      }catch(error){toast(error.message||'结束会话失败')}
      finally{el('close-btn').disabled=false}
      return;
    }
    c.status='ended';
    c.endedAt=Date.now();
    // 结束会话保留历史消息；有待处理会话时继续接待，否则显示刚结束的会话。
    const next=conversations.find(item=>item.status==='active');
    conversationStatus=next?'active':'ended';currentId=next?.id??c.id;
    renderAll();
    toast('会话已移至“已结束”（模拟）');
  };
  el('transfer-btn').onclick=async()=>{
    if(!backendConnected){showModal('转接会话','选择当前店铺在线的客服。',()=>toast('已转接给 李明（模拟）'),'<select class="field"><option>李明 · 在线接单</option></select>');return}
    const c=activeConversation(),epoch=workspaceEpoch;
    if(!c)return;
    try{
      const targets=await api.transferTargets(c.id);
      if(epoch!==workspaceEpoch||String(currentId)!==String(c.id))return;
      if(!targets.length){toast('暂无在线接单的其他客服');return}
      showModal('转接会话','选择公司内在线接单的客服。后端会再次校验接待资格与会话版本。',()=>{
        const targetId=el('transfer-target').value;
        el('modal-confirm').disabled=true;
        void api.transferConversation(c.id,c.version,targetId).then(async()=>{
          closeModal();await loadRemoteConversations();toast('会话转接已完成');
        }).catch(error=>{
          el('modal-confirm').disabled=false;toast(error.status===409?'会话或客服状态已变化，请刷新后重试':error.message);
          refreshWorkspace();
        });
        return false;
      },`<label for="transfer-target">接收客服</label><select id="transfer-target" class="field">${targets.map(target=>`<option value="${safe(target.memberId)}">${safe(target.displayName)} · 在线接单 · ${target.inProgressCount} 个会话</option>`).join('')}</select>`,'确认转接');
    }catch(error){toast(error.message||'无法读取转接名单')}
  };
  // 会话里的「导出对话记录」不自己生成文件：导出是后台任务（Worker 读库、写产物），
  // 一个按钮当场下载会让人以为同步就完成了。这里只把这条会话带过去，创建与下载都
  // 留在数据导出页。
  el('export-conversation-btn').onclick=()=>{
    const c=activeConversation();
    if(!backendConnected||!c)return;
    window.ExportPortal?.prefill({scope:'conversation',conversationId:c.id});
    navigate('exports');
    toast('已选中当前会话，点「创建导出任务」生成对话记录');
  };
  el('assignment-history-btn').onclick=async()=>{
    const c=activeConversation(),epoch=workspaceEpoch;if(!backendConnected||!c)return;
    try{
      const [rows,directories]=await Promise.all([api.assignments(c.id),api.directoryTenants()]);
      if(epoch!==workspaceEpoch||String(currentId)!==String(c.id))return;
      const members=directories.flatMap(entry=>entry.members||[]);
      const name=id=>members.find(member=>member.id===id)?.displayName||id||'未分配';
      const actions={auto_assign:'自动分配',claim:'接手',return:'退回',transfer:'转接',close:'结束'};
      showModal('会话分配历史','按时间倒序展示服务端记录，包含成功和失败的尝试。',()=>{},rows.length?`<div class="assignment-history">${rows.map(row=>`<div class="review-card"><strong>${safe(actions[row.action]||row.action)} · ${safe({succeeded:'成功',failed:'失败',success:'成功',refused:'拒绝'}[row.result]||row.result)}</strong><p>${safe(name(row.fromMemberId))} → ${safe(name(row.toMemberId))}</p><small>${safe(new Date(row.createdAt).toLocaleString('zh-CN'))} · 版本 ${row.stateVersionBefore} → ${row.stateVersionAfter??'未改变'}${row.reasonCode?' · '+safe(row.reasonCode):''}</small></div>`).join('')}</div>`:'暂无分配记录','关闭');
    }catch(error){toast(error.message||'分配历史读取失败')}
  };
  // 个人短语的归属人：登录后是会话证明的那位成员，演示模式（没有后端会话）下是演示客服。
  // 这个值只用来决定「哪些行该画出来」。真正的隔离在服务端的 member_id 条件里
  // （见 /personal-phrases）：客户端连 owner 都传不过去，服务端也不认请求体里的这个字段。
  // 所以这里错了顶多是自己看到不该看的演示数据，不会让请求越权。
  const DEMO_PHRASE_OWNER='demo-agent';
  function phraseOwnerId(){
    return backendConnected?(backendSession?.access?.member?.id??null):DEMO_PHRASE_OWNER;
  }
  // 团队短语仍是租户级演示数据（接后端的是「知识库 → 公司快捷话术」那一块），个人短语只认本人：
  // 别人的个人短语不进列表、不进联想、不进工作台右侧的选用面板，连 id 都搜不到。
  function visiblePhrases(){
    const owner=phraseOwnerId();
    return quickPhrases.filter(phrase=>phrase.scope!=='个人'||phrase.ownerId===owner);
  }
  /** 按 id 找一条自己看得到的短语；别人的 id 找不到，行内按钮拿不到别人的行。 */
  function phraseById(id){return visiblePhrases().find(phrase=>phrase.id===id)}
  /** 把服务端的一行个人短语译成页面用的形状；`backend` 标记它写回走接口而不是内存。 */
  function backendPhraseOf(row){
    return {id:row.id,scope:'个人',ownerId:row.memberId,category:row.category||'',title:row.title,
      keywords:[...(row.keywords||[])],text:row.text,enabled:row.enabled!==false,useCount:0,backend:true};
  }
  /**
   * 读回本人的个人短语。
   *
   * 服务端这一趟返回的就是本人的全部个人短语，所以是整份替换而不是逐条合并：合并会把上一次
   * 登录、甚至别的账号留下的行永远留在页面里。演示模式没有后端会话，直接不发请求——那时
   * 列表就是 mock 里的两条示例。
   */
  function loadPersonalPhrases(){
    if(!backendConnected)return;
    const epoch=++phraseEpoch,session=backendSession,owner=phraseOwnerId();
    void api.personalPhrases().then(rows=>{
      if(epoch!==phraseEpoch||session!==backendSession||!backendConnected)return;
      const keep=quickPhrases.filter(phrase=>phrase.scope!=='个人'||phrase.ownerId!==owner);
      quickPhrases.splice(0,quickPhrases.length,...keep,...rows.map(backendPhraseOf));
      renderPhrasePage();renderPhraseAside();closePhraseSuggestions();
    }).catch(error=>{
      if(epoch!==phraseEpoch)return;
      toast(error.message||'个人短语读取失败');
    });
  }
  function phraseCategory(phrase){
    if(phrase.category)return phrase.category;
    if(/视频|安装/.test(phrase.title))return '使用教程';
    if(/物流|发货/.test(phrase.title))return '物流';
    if(/规格|商品/.test(phrase.title))return '商品咨询';
    if(/售后/.test(phrase.title))return '售后';
    return '常用回复';
  }
  // 个人短语只有本人可改（平台管理员也不例外——它是客服自己的工作笔记，不是租户数据）；
  // 团队短语仍按角色收口。服务端对个人短语也只认会话里的成员，不为管理员开例外。
  function canManagePhrase(phrase){
    return phrase.scope==='个人'?phrase.ownerId===phraseOwnerId():role()==='merchant';
  }
  function insertPhrase(phrase){
    if(!activeConversation()||activeConversation().status!=='active'){
      toast('请先选择处理中的会话');return;
    }
    insertReplyText(phrase.text);
    closePhraseSuggestions();
    selectedSuggestion=-1;originalSuggestion='';selectedCandidateId='';
    phrase.useCount=(phrase.useCount||0)+1;
    el('reply-hint').textContent=`已插入${phrase.scope}短语 · 可编辑后发送`;
    renderPhrasePage();renderPhraseAside();
    toast(`${phrase.scope}短语已填入回复框`);
  }
  function renderPhrasePage(){
    const scope=phrasePageScope,manageable=scope==='个人'||role()==='merchant';
    const scoped=visiblePhrases().filter(phrase=>phrase.scope===scope);
    const categories=[...new Set(scoped.map(phraseCategory))];
    const select=el('phrase-category'),previous=select.value;
    select.innerHTML='<option value="">全部分类</option>'+categories.map(category=>`<option value="${safe(category)}">${safe(category)}</option>`).join('');
    select.value=categories.includes(previous)?previous:'';
    const query=el('phrase-search').value.trim().toLowerCase(),category=select.value;
    const shown=scoped.filter(phrase=>(!category||phraseCategory(phrase)===category)&&(!query||[phrase.title,phrase.text,...(phrase.keywords||[])].some(value=>value.toLowerCase().includes(query))));
    el('phrase-rows').innerHTML=shown.length?shown.map(phrase=>`<tr><td><strong>${safe(phrase.title)}</strong></td><td><div class="phrase-row-preview" title="${safe(phrase.text)}">${safe(phrase.text)}</div></td><td>${safe(phraseCategory(phrase))}</td><td>${safe(phrase.scope)}</td><td><span class="pill ${phrase.enabled===false?'gray':'green'}">${phrase.enabled===false?'已停用':'已启用'}</span></td><td><div class="phrase-row-actions">${manageable?`<button class="small-link" type="button" data-phrase-edit="${safe(phrase.id)}">编辑</button><button class="small-link" type="button" data-phrase-toggle="${safe(phrase.id)}">${phrase.enabled===false?'启用':'停用'}</button>`:'<span class="assist-sub">只读</span>'}</div></td></tr>`).join(''):'<tr><td colspan="6" class="empty">当前分类暂无匹配短语</td></tr>';
    el('add-phrase').hidden=!manageable;
    el('add-phrase').textContent=`＋ 新建${scope}短语`;
    el('phrase-scope-note').textContent=scope==='个人'?'仅自己可见和编辑':manageable?'团队成员可用 · 管理员维护':'团队成员可用 · 仅管理员可修改';
    document.querySelectorAll('[data-phrase-page-scope]').forEach(button=>{const active=button.dataset.phrasePageScope===scope;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});
    el('phrase-rows').querySelectorAll('[data-phrase-edit]').forEach(button=>button.onclick=()=>openPhraseEditor(phraseById(button.dataset.phraseEdit)));
    el('phrase-rows').querySelectorAll('[data-phrase-toggle]').forEach(button=>button.onclick=()=>{
      const phrase=phraseById(button.dataset.phraseToggle);
      if(!phrase||!canManagePhrase(phrase))return;
      const next=phrase.enabled===false;
      // 接后端后个人短语的启停也写服务端：只改本地会让刷新后的状态和刚看到的不一样。
      if(phrase.backend&&backendConnected){
        const session=backendSession,epoch=phraseEpoch;
        void api.updatePersonalPhrase(phrase.id,{enabled:next}).then(()=>{
          if(epoch!==phraseEpoch||session!==backendSession||!backendConnected)return;
          phrase.enabled=next;
          renderPhrasePage();renderPhraseAside();closePhraseSuggestions();
          toast(`${phrase.title}已${next?'启用':'停用'}`);
        }).catch(error=>toast(error.message||'短语启停失败'));
        return;
      }
      phrase.enabled=next;
      renderPhrasePage();renderPhraseAside();closePhraseSuggestions();
      toast(`${phrase.title}已${phrase.enabled?'启用':'停用'}（本地演示）`);
    });
  }
  function renderPhraseAside(){
    const scope=phraseAsideScope,query=el('phrase-aside-search').value.trim().toLowerCase();
    const shown=visiblePhrases().filter(phrase=>phrase.scope===scope&&phrase.enabled!==false&&(!query||[phrase.title,phrase.text,...(phrase.keywords||[])].some(value=>value.toLowerCase().includes(query))));
    const grouped=new Map();shown.forEach(phrase=>{const category=phraseCategory(phrase);if(!grouped.has(category))grouped.set(category,[]);grouped.get(category).push(phrase)});
    el('phrase-aside-list').innerHTML=grouped.size?[...grouped].map(([category,items])=>`<details open><summary>${safe(category)} · ${items.length}</summary>${items.map(phrase=>`<button class="phrase-aside-item" type="button" data-phrase-insert="${safe(phrase.id)}" title="${safe(phrase.text)}"><strong>${safe(phrase.title)}</strong><span>${safe(phrase.text)}</span></button>`).join('')}</details>`).join(''):'<div class="empty">暂无匹配短语，可新增个人短语。</div>';
    document.querySelectorAll('[data-phrase-aside-scope]').forEach(button=>{const active=button.dataset.phraseAsideScope===scope;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});
    el('phrase-aside-add').hidden=scope==='团队'&&role()!=='merchant';
    el('phrase-aside-list').querySelectorAll('[data-phrase-insert]').forEach(button=>button.onclick=()=>insertPhrase(phraseById(button.dataset.phraseInsert)));
  }
  // 个人短语已接后端：读写走 /personal-phrases，归属由服务端按会话证明的成员决定（见
  // loadPersonalPhrases 与 openPhraseEditor）。团队短语仍是页面内原型——租户级的「公司快捷
  // 话术」在知识库那块接的是 /knowledge/shortcuts，这一页的「团队」页签还没接到那里。
  function openPhraseEditor(phrase=null,scope=phrase?.scope||phrasePageScope){
    if(phrase&&!canManagePhrase(phrase)||scope==='团队'&&role()!=='merchant'){
      toast('暂无权限修改团队短语');return;
    }
    const fields=`<div class="phrase-form"><label class="setting-title" for="phrase-title-field">标题</label><input id="phrase-title-field" class="field" maxlength="60" value="${safe(phrase?.title||'')}" placeholder="例如：发货说明"><label class="setting-title" for="phrase-category-field">分类</label><input id="phrase-category-field" class="field" maxlength="30" value="${safe(phrase?phraseCategory(phrase):'')}" placeholder="例如：售后"><label class="setting-title" for="phrase-keywords-field">关键词（用逗号分隔）</label><input id="phrase-keywords-field" class="field" value="${safe(phrase?.keywords?.join('，')||'')}" placeholder="例如：视频，安装"><label class="setting-title" for="phrase-text-field">回复内容</label><textarea id="phrase-text-field" class="field" maxlength="2000" placeholder="输入短语内容">${safe(phrase?.text||'')}</textarea><p id="phrase-form-error" class="phrase-form-error" role="alert"></p></div>`;
    showModal(`${phrase?'编辑':'新建'}${scope}短语`,scope==='个人'?'个人短语只有自己可见。':'团队短语对企业成员开放。',()=>{
      const title=el('phrase-title-field').value.trim(),text=el('phrase-text-field').value.trim(),category=el('phrase-category-field').value.trim()||'未分类';
      if(!title||!text){el('phrase-form-error').textContent='请填写标题和回复内容';return false}
      const keywords=el('phrase-keywords-field').value.split(/[，,]/).map(item=>item.trim()).filter(Boolean);
      // 个人短语在接后端后写服务端一行，归属由服务端按会话里的成员决定——请求体里没有 owner，
      // 前端也传不过去。按转接那条同样的做法：先禁用确认按钮，等结果回来再关弹窗，
      // 请求失败就把弹窗留在原地让人改。
      if(scope==='个人'&&backendConnected){
        const session=backendSession,epoch=phraseEpoch;
        el('modal-confirm').disabled=true;
        const request=phrase&&phrase.backend
          ?api.updatePersonalPhrase(phrase.id,{title,text,category,keywords})
          :api.createPersonalPhrase({title,text,category,keywords});
        void request.then(()=>{
          if(session!==backendSession||!backendConnected)return;
          phrasePageScope=scope;phraseAsideScope=scope;
          closeModal();
          loadPersonalPhrases();
          toast(`个人短语已${phrase?'更新':'新增'}`);
        }).catch(error=>{
          if(session!==backendSession||!backendConnected)return;
          el('modal-confirm').disabled=false;
          el('phrase-form-error').textContent=[error.message,...(error.details||[])].filter(Boolean).join('；')||'保存失败';
        });
        return false;
      }
      if(phrase)Object.assign(phrase,{title,text,category,keywords});
      else quickPhrases.unshift({id:`phrase-local-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,scope,ownerId:scope==='个人'?phraseOwnerId():null,title,text,category,keywords,enabled:true,useCount:0});
      phrasePageScope=scope;phraseAsideScope=scope;
      renderPhrasePage();renderPhraseAside();closePhraseSuggestions();
      toast(`${scope}短语已${phrase?'更新':'新增'}（本地演示）`);
    },fields,'保存短语');
    el('phrase-title-field').focus();
  }
  function setAssistView(next){
    assistView=next;el('assist-ai-panel').hidden=next!=='ai';el('assist-phrase-panel').hidden=next!=='phrases';el('candidate-status').hidden=next!=='ai';
    document.querySelectorAll('[data-assist-view]').forEach(button=>{const active=button.dataset.assistView===next;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});
    if(next==='phrases')renderPhraseAside();
  }
  document.querySelectorAll('[data-assist-view]').forEach(button=>button.onclick=()=>setAssistView(button.dataset.assistView));
  document.querySelectorAll('[data-phrase-page-scope]').forEach(button=>button.onclick=()=>{phrasePageScope=button.dataset.phrasePageScope;el('phrase-category').value='';renderPhrasePage()});
  document.querySelectorAll('[data-phrase-aside-scope]').forEach(button=>button.onclick=()=>{phraseAsideScope=button.dataset.phraseAsideScope;renderPhraseAside()});
  el('phrase-search').oninput=renderPhrasePage;el('phrase-category').onchange=renderPhrasePage;
  el('phrase-aside-search').oninput=renderPhraseAside;
  el('phrase-aside-add').onclick=()=>openPhraseEditor(null,phraseAsideScope);
  el('phrase-aside-manage').onclick=()=>{phrasePageScope=phraseAsideScope;navigate('phrases')};
  el('add-phrase').onclick=()=>openPhraseEditor(null,phrasePageScope);
  el('shortcut-btn').onclick=()=>{
    const available=visiblePhrases().filter(phrase=>phrase.enabled!==false);
    const options=['个人','团队'].map(scope=>`<optgroup label="${scope}">${available.filter(phrase=>phrase.scope===scope).map(phrase=>`<option value="${safe(phrase.id)}">${safe(phrase.title)} · ${safe(phraseCategory(phrase))}</option>`).join('')}</optgroup>`).join('');
    showModal('插入快捷短语','选择个人或团队短语，填入后仍可编辑。',()=>{
      const phrase=phraseById(el('shortcut-choice').value);
      if(phrase)insertPhrase(phrase);
    },`<select id="shortcut-choice" class="field">${options}</select><p class="footnote">可在右侧“快捷短语”中搜索、分组查看与管理。</p>`,'插入草稿');
  };
  el('product-btn').onclick=el('insert-link').onclick=()=>{el('reply').value+=(el('reply').value?'\n':'')+'商品详情：https://shop.example.com/products/thermos-500';el('reply').focus();toast('已插入示例商品链接')};
  /** 在光标处插入文字。客户回复框和内部消息框共用，只有目标输入框不同。 */
  function insertTextAtCursor(textareaId,text){
    const input=el(textareaId);
    input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  function insertReplyText(text){insertTextAtCursor('reply',text)}
  const emojiOptions=['😊','😄','😉','🥰','👍','👌','🙏','🤝','❤️','🎉','🌹','☕'];
  // 客户会话与内部会话共用同一组表情和同一段插入逻辑。表情就是文本：插进输入框后随消息
  // 一起发出去，接口不需要认识它——这一点和下面那几个附件按钮不一样，那两个现在发不出去。
  const emojiControls=[];
  function closeEmoji(){emojiControls.forEach(control=>{el(control.picker).hidden=true;el(control.button).setAttribute('aria-expanded','false')})}
  function setupEmoji(buttonId,pickerId,textareaId){
    const picker=el(pickerId);
    picker.innerHTML=emojiOptions.map(emoji=>`<button type="button" aria-label="插入表情 ${emoji}">${emoji}</button>`).join('');
    picker.querySelectorAll('button').forEach(item=>item.onclick=()=>{insertTextAtCursor(textareaId,item.textContent);closeEmoji()});
    // 开一个之前先关掉另一个：两个面板同时浮着会挡住输入框，也看不出表情会插到哪里去。
    el(buttonId).onclick=()=>{const open=picker.hidden;closeEmoji();picker.hidden=!open;el(buttonId).setAttribute('aria-expanded',String(open))};
    emojiControls.push({button:buttonId,picker:pickerId});
  }
  setupEmoji('emoji-btn','emoji-picker','reply');
  setupEmoji('group-emoji-btn','group-emoji-picker','group-chat-reply');
  document.addEventListener('click',event=>{if(!event.target.closest('.emoji-control'))closeEmoji()});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeEmoji()});
  function renderAttachment(){
    const attachment=replyAttachments.get(currentId);
    el('reply-attachment').hidden=!attachment;
    const image=el('reply-attachment-image'),icon=el('reply-attachment-icon');
    image.hidden=!attachment||attachment.kind!=='image';
    icon.hidden=!attachment||attachment.kind==='image';
    if(attachment?.kind==='image')image.src=attachment.url;
    else image.removeAttribute('src');
    icon.textContent=attachment?.kind==='video'?'▶':'▤';
    // 预览用本地对象地址，点了发送就立刻显示；但上传要花时间，得说清还没到服务端，
    // 否则这一会儿会被读成「已经发出去了」。
    el('reply-attachment-name').textContent=attachment?`${{image:'图片',video:'视频',file:'文件'}[attachment.kind]}：${attachment.name}${attachment.sending?'（发送中…）':''}`:'';
  }
  // 客户会话附件按服务端那套判：能发什么、能有多大，都以内容类型为准，不看坐席点的是
  // 哪个按钮——按钮只决定打开哪一个文件选择器。渠道的媒体消息没有说明文字，一条消息的
  // 媒体本身就是全部内容，所以服务端判的就是内容类型。这份预检不是替服务端把关（它还会
  // 再判一次，它的判决才算），而是为了让坐席在还没离开选择器时就听见「这个不行」，
  // 而不是上传完等回来一句关于渠道的英文说明。清单与上限同 packages/core 的
  // OUTBOUND_MEDIA_{IMAGE,VIDEO}_TYPES 与 OUTBOUND_MEDIA_MAX_BYTES。
  const REPLY_IMAGE_TYPES=['image/png','image/jpeg','image/gif'];
  const REPLY_VIDEO_TYPES=['video/mp4'];
  const REPLY_MEDIA_MAX_MB={image:10,video:10,file:20};
  const REPLY_MEDIA_LABEL={image:'图片',video:'视频',file:'文件'};
  function attachReplyFile(file,conversationId=currentId){
    if(!file)return;
    const label=REPLY_MEDIA_LABEL;
    if(!file.name.trim()){toast('这个文件没有文件名，请重命名后再选择');return}
    const mimeType=(file.type||'').split(';')[0].trim().toLowerCase();
    // 声明成图片或视频却不在清单里的，拒绝而不是降级成普通文件：供应商不接受 WebP 图片，
    // 静默把它变成「下载文件」比明说一句「这个格式不支持」更让人困惑。
    const kind=REPLY_IMAGE_TYPES.includes(mimeType)?'image'
      :REPLY_VIDEO_TYPES.includes(mimeType)?'video'
      :mimeType.startsWith('image/')||mimeType.startsWith('video/')?null
      :'file';
    if(kind===null){toast('这个图片或视频格式不支持，请换 PNG、JPEG、GIF 图片或 MP4 视频');return}
    const limit=REPLY_MEDIA_MAX_MB[kind];
    if(file.size>limit*1024*1024){toast(`请选择小于 ${limit} MB 的${label[kind]}`);return}
    const previous=replyAttachments.get(conversationId);
    if(previous)URL.revokeObjectURL(previous.url);
    // File 对象本身留在草稿里：发送时要把字节交出去，只留预览地址的话点发送时就没有
    // 东西可上传了。
    replyAttachments.set(conversationId,{kind,name:file.name,url:URL.createObjectURL(file),file,sending:false});
    if(conversationId===currentId)renderAttachment();
    toast(`${label[kind]}已加入草稿，确认后点击发送`);
  }
  el('image-btn').onclick=()=>el('reply-image-file').click();
  el('video-btn').onclick=()=>el('reply-video-file').click();
  el('file-btn').onclick=()=>el('reply-document-file').click();
  ['reply-image-file','reply-video-file','reply-document-file'].forEach(id=>{
    el(id).onchange=event=>{attachReplyFile(event.target.files[0]);event.target.value=''};
  });
  el('remove-attachment').onclick=()=>{
    const attachment=replyAttachments.get(currentId);
    // 正在发送的草稿不给撤：这一份字节已经在路上了，撤掉只会留下一个「我按了发送但
    // 界面上什么都没有」的时刻，而消息其实会照发。
    if(attachment?.sending){toast('附件正在发送，请稍候');return}
    if(attachment)URL.revokeObjectURL(attachment.url);
    replyAttachments.delete(currentId);renderAttachment();
  };
  function internalTargetKey(){return activeDirectId?'direct:'+activeDirectId:activeGroupChatId?'group:'+activeGroupChatId:''}
  function renderInternalAttachment(){
    const attachment=internalAttachments.get(internalTargetKey());
    el('group-attachment').hidden=!attachment;
    const image=el('group-attachment-image'),icon=el('group-attachment-icon');
    image.hidden=!attachment||attachment.kind!=='image';
    icon.hidden=!attachment||attachment.kind==='image';
    if(attachment?.kind==='image')image.src=attachment.url;
    else image.removeAttribute('src');
    icon.textContent=attachment?.kind==='video'?'▶':'▤';
    // 预览用本地对象地址，上传同时就显示，不必等网络回来；但要说清还没到服务端，
    // 否则「已加入草稿」会被读成「已经发出去了」。
    el('group-attachment-name').textContent=attachment?`${{image:'图片',video:'视频',file:'文件'}[attachment.kind]}：${attachment.name}${attachment.uploading?'（上传中…）':''}`:'';
  }
  // 登录状态下附件是真的要上传的：字节先进对象存储，换回一个草稿 ID，发送时随消息
  // 一起认领。所以这里是异步的，并且失败必须把草稿撤掉——留着一个没有 ID 的草稿，
  // 发送时会被服务端以「附件不存在或已发送」拒绝，而用户以为文件早就选好了。
  // 未登录时仍是本地演示：只留一个本地预览地址，发送也不出本机。
  async function attachInternalFile(file,kind){
    if(!file)return;
    const key=internalTargetKey();
    if(!key)return;
    if(kind==='image'&&!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)){toast('请选择 PNG、JPEG、WebP 或 GIF 图片');return}
    if(kind==='video'&&!file.type.startsWith('video/')){toast('请选择视频文件');return}
    const limit=kind==='image'?5:kind==='video'?50:20;
    if(file.size>limit*1024*1024){toast(`请选择小于 ${limit} MB 的${{image:'图片',video:'视频',file:'文件'}[kind]}`);return}
    const previous=internalAttachments.get(key);
    if(previous)URL.revokeObjectURL(previous.url);
    const label=`${{image:'图片',video:'视频',file:'文件'}[kind]}`;
    // 本地地址只用于预览：真正读到字节的是上传之后服务端给的签名地址。
    const draft={kind,name:file.name,url:URL.createObjectURL(file),id:null,uploading:false};
    internalAttachments.set(key,draft);
    if(!backendConnected){
      renderInternalAttachment();
      toast(`${label}已加入草稿，确认后点击发送（本地演示）`);
      return;
    }
    const entry=remoteThreads.get(activeDirectId);
    if(!entry?.threadId){
      // 上传要按会话查成员资格，没有会话就无从上传；留在草稿里只会让人白点一次发送。
      URL.revokeObjectURL(draft.url);
      internalAttachments.delete(key);
      renderInternalAttachment();
      toast('内部会话还没建立，请重新点开这位同事');
      return;
    }
    draft.uploading=true;
    renderInternalAttachment();
    toast(`${label}上传中…`);
    // 上传要花时间，期间用户可能换了同事、撤了草稿、或又选了一个文件。用上传开始时的
    // 会话键认领结果：草稿还在原处才认，否则这份字节直接放弃，不塞进别人的会话里。
    const targetKey=key;
    const stale=()=>internalAttachments.get(targetKey)!==draft;
    try{
      const stored=await api.internalUploadAttachment(entry.threadId,file);
      if(stale())return;
      // 名称与类型以服务端为准：它按内容类型重新判定过 kind，可能把客户端当成视频的
      // 文件判成普通文件（不能内嵌播放），预览也就该按普通文件显示。
      draft.id=stored?.id||null;
      draft.kind=stored?.kind||kind;
      draft.name=stored?.fileName||file.name;
      draft.uploading=false;
      renderInternalAttachment();
      toast(`${label}已就绪，点击发送`);
    }catch(error){
      if(!stale()){
        URL.revokeObjectURL(draft.url);
        internalAttachments.delete(targetKey);
        renderInternalAttachment();
      }
      toast([error.message,...(error.details||[])].filter(Boolean).join('；')||'附件上传失败，请重试');
    }
  }
  el('group-image-btn').onclick=()=>el('group-image-file').click();
  el('group-video-btn').onclick=()=>el('group-video-file').click();
  el('group-file-btn').onclick=()=>el('group-document-file').click();
  [['group-image-file','image'],['group-video-file','video'],['group-document-file','file']].forEach(([id,kind])=>{
    el(id).onchange=event=>{
      attachInternalFile(event.target.files[0],kind).catch(error=>toast(error.message||'附件处理失败'));
      event.target.value='';
    };
  });
  el('group-remove-attachment').onclick=()=>{
    const key=internalTargetKey();
    const attachment=internalAttachments.get(key);
    if(attachment)URL.revokeObjectURL(attachment.url);
    internalAttachments.delete(key);renderInternalAttachment();
    // 撤掉的是本地草稿。已经上传到服务端的那份字节留着：没有删除接口，而且它还没挂到
    // 任何消息上，只有发送时才会被认领；这类没有归属的对象要靠桶里的清理任务回收。
  };
  function pasteReplyImage(event){
    const file=[...(event.clipboardData?.files||[])].find(item=>item.type.startsWith('image/'));
    if(file){event.preventDefault();attachReplyFile(file);if(event.target.id==='screenshot-paste')closeModal()}
  }
  el('reply').addEventListener('paste',pasteReplyImage);
  el('screenshot-btn').onclick=()=>{
    showModal('截图','按 Win + Shift + S 选择截图区域，返回后在下方按 Ctrl + V。图片将加入回复草稿。',()=>{},'<textarea id="screenshot-paste" class="field" aria-label="粘贴截图" placeholder="在这里粘贴截图…"></textarea>');
    el('screenshot-paste').addEventListener('paste',pasteReplyImage);
    el('screenshot-paste').focus();
  };
  // 邀请只回填草稿；真实下单链接、商品可用状态需由后端返回。
  el('invite-order-btn').onclick=()=>showModal('邀请下单','确认商品后，将邀请内容加入回复框。',()=>{
    insertReplyText('您可以通过商品链接选择规格并下单：\nhttps://shop.example.com/products/thermos-500');
    toast('下单邀请已填入，请确认后发送（示例链接）');
  },'<div class="product-card"><div class="product-image">☕</div><div><div class="product-name">轻享保温杯 · 500ml</div><div class="product-detail">黑色 / 米白色</div><div class="footnote">演示商品链接</div></div></div>');
  el('candidate-detail').onclick=async()=>{
    if(!backendConnected){showModal('本次候选的检索依据','当前为界面示例数据。',()=>{},'<div class="review-card">命中商品：轻享保温杯 500ml</div>');return}
    const c=activeConversation(),state=remoteSuggestions.get(c?.id),epoch=workspaceEpoch;if(!state?.set)return;
    try{
      const set=await api.suggestionDetail(state.set.id);
      if(epoch!==workspaceEpoch||String(currentId)!==String(c.id))return;
      showModal('候选来源与检索依据',suggestionDetailSummary(set),()=>{},suggestionDetailText(set),'关闭');
    }catch(error){toast(error.message||'候选详情读取失败')}
  };
  // TODO(API): Persist presence per authorized store. Only "online" participates
  // in automatic assignment. "exit" is a separate sign-out action, not a state.
  function closeStatusMenu(restoreFocus=false){
    el('status-menu').hidden=true;
    el('status-trigger').setAttribute('aria-expanded','false');
    if(restoreFocus)el('status-trigger').focus();
  }
  function openStatusMenu(){
    el('status-menu').hidden=false;
    el('status-trigger').setAttribute('aria-expanded','true');
    el('status-menu').querySelector('[aria-checked="true"]').focus();
  }
  function updatePresence(state){
    presenceState=state;
    const labels={online:'在线',suspended:'挂起',offline:'离线'};
    const notes={suspended:'挂起：保留当前会话，暂停接入新客户',offline:'离线：停止接待和发送客服消息'};
    el('presence-control').dataset.state=state;
    el('status-label').textContent=labels[state];
    el('status-trigger').setAttribute('aria-label','客服接待状态：'+labels[state]);
    el('agent-presence-note').hidden=state==='online';
    el('agent-presence-note').textContent=notes[state]||'';
    document.querySelectorAll('[data-presence][role="menuitemradio"]').forEach(option=>option.setAttribute('aria-checked',String(option.dataset.presence===state)));
    renderMessages();
  }
  el('status-trigger').onclick=()=>el('status-menu').hidden?openStatusMenu():closeStatusMenu();
  el('status-trigger').addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();openStatusMenu()}});
  el('status-menu').addEventListener('keydown',event=>{
    const options=[...el('status-menu').querySelectorAll('.status-option')];
    const index=options.indexOf(document.activeElement);
    if(event.key==='Escape'){event.preventDefault();closeStatusMenu(true)}
    else if(event.key==='Tab')closeStatusMenu();
    else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      const current=index<0?(event.key==='ArrowDown'?-1:0):index;
      options[(current+(event.key==='ArrowDown'?1:options.length-1))%options.length].focus();
    }
  });
  document.querySelectorAll('.status-option').forEach(option=>option.onclick=async()=>{
    closeStatusMenu();
    if(option.dataset.presence==='exit'){
      signOut();
      return;
    }
    updatePresence(option.dataset.presence);
    el('status-trigger').focus();
    if(backendConnected){
      const backendPresence={online:'accepting',suspended:'away',offline:'offline'}[option.dataset.presence];
      try{await api.presence(backendPresence);toast('客服状态已同步到后端：'+el('status-label').textContent)}
      catch(error){toast(error.message||'客服状态同步失败')}
    }else toast('客服状态已切换为 '+el('status-label').textContent+'（模拟）');
  });
  document.addEventListener('click',event=>{if(!el('presence-control').contains(event.target))closeStatusMenu()});
  updatePresence('online');
  // TODO(API): Store the AI-assistance preference for this seat. Toggling it
  // must not stop incoming messages or block manual customer replies.
  el('assist-toggle').onclick=()=>{
    assistEnabled=!assistEnabled;
    el('assist-toggle').setAttribute('aria-pressed',String(assistEnabled));
    el('assist-toggle').textContent=assistEnabled?'◉ 停止辅助':'○ 开启辅助';
    renderCandidates();
    toast(assistEnabled?'AI 辅助已开启':'AI 辅助已暂停，仍可人工回复');
  };
  el('overview-toggle').onclick=()=>{
    const expanded=el('overview-toggle').getAttribute('aria-expanded')==='true';
    el('overview-toggle').setAttribute('aria-expanded',String(!expanded));
    el('overview-toggle').innerHTML=expanded?'展开 <span aria-hidden="true">⌄</span>':'收起 <span aria-hidden="true">⌄</span>';
    el('overview-details').hidden=expanded;
  };
  el('store-select').onchange=()=>{
    if(backendConnected){workspaceStoreId=el('store-select').value;currentId=null;remoteSuggestions.clear();refreshWorkspace();return}
    toast('已选择 '+el('store-select').selectedOptions[0].textContent+'；原型展示固定示例数据');
  };

  const knowledgeMeta={
    catalog:{singular:'SPU / SKU',add:'创建 SPU',search:'搜索 SPU 编码、标题、卖点或公共属性'},
    products:{singular:'商品',add:'录入商品',search:'搜索商品名称、SKU 或描述'},
    faqs:{singular:'常见问题',add:'录入常见问题',search:'搜索问题、答案或标签'},
    shortcuts:{singular:'快捷话术',add:'录入快捷话术',search:'搜索代码、标题或话术内容'},
  };
  function canWriteKnowledge(){return backendConnected&&role()==='merchant'&&['merchant_admin','platform_admin'].includes(backendSession?.access?.role)}
  function knowledgeItems(){return knowledgeState[knowledgeTab]||[]}
  function knowledgeStoreName(storeId){return knowledgeScope?.stores?.find(store=>store.id===storeId)?.name||storeId||'公司通用'}
  function knowledgeDate(value){
    const date=new Date(value);
    return Number.isNaN(date.valueOf())?'—':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  }
  function knowledgeText(item){
    if(knowledgeTab==='products')return [item.sku,item.title,item.description].join(' ');
    if(knowledgeTab==='faqs')return [item.question,item.answer,...(item.tags||[])].join(' ');
    return [item.code,item.title,item.content,item.intentCode||''].join(' ');
  }
  function knowledgeRow(item,editable){
    const action=`<div class="knowledge-row-actions"><button class="small-link" type="button" data-knowledge-open="${safe(item.id)}">${editable?'编辑':'查看'}</button>${editable?`<button class="small-link" type="button" data-knowledge-toggle="${safe(item.id)}">${item.enabled?'停用':'启用'}</button>`:''}</div>`;
    const status=`<span class="pill ${item.enabled?'green':'gray'}">${item.enabled?'已启用':'已停用'}</span>`;
    if(knowledgeTab==='products')return `<tr class="${item.id===knowledgeEditingId?'knowledge-row-selected':''}"><td><span class="knowledge-table-main">${safe(item.title)}</span><span class="knowledge-table-sub">${safe(item.description||'暂无描述')}</span></td><td>${safe(item.sku)}</td><td>${safe(knowledgeStoreName(item.storeId))}</td><td>${status}</td><td>${safe(knowledgeDate(item.updatedAt))}</td><td>${action}</td></tr>`;
    if(knowledgeTab==='faqs')return `<tr class="${item.id===knowledgeEditingId?'knowledge-row-selected':''}"><td><span class="knowledge-table-main">${safe(item.question)}</span><span class="knowledge-table-sub">${safe(item.answer)}</span></td><td>${safe((item.tags||[]).join('、')||'未分类')}</td><td>${safe(knowledgeStoreName(item.storeId))}</td><td>${status}</td><td>${safe(knowledgeDate(item.updatedAt))}</td><td>${action}</td></tr>`;
    return `<tr class="${item.id===knowledgeEditingId?'knowledge-row-selected':''}"><td><span class="knowledge-table-main">${safe(item.title)}</span><span class="knowledge-table-sub">${safe(item.content)}</span></td><td>${safe(item.code)}</td><td>${safe(item.scopeType==='tenant'?'公司通用':knowledgeStoreName(item.storeId))}</td><td>${status}</td><td>${safe(knowledgeDate(item.updatedAt))}</td><td>${action}</td></tr>`;
  }
  // 「商品」页签的搜索要连结构化商品库一起搜：导入写进的是 `product_spus` / `product_skus`，
  // 而这一页读的是旧的手工条目表，人在这里搜不到就会以为没导进来。目录数据 catalog.js
  // 里也有一份，但那份只在「SPU / SKU」页签加载、带自己的时序；这里按需另读一次存成
  // 快照，好过为了在列表里标个来源去改另一个模块的加载与隔离逻辑。
  const CATALOG_MATCH_LIMIT=20,catalogShelf={on_shelf:'上架',off_shelf:'下架',unknown:'未知'};
  let catalogSearchState='idle',catalogSearchRows=[],catalogSearchError='';
  // 匹配口径只有一份实现（catalog.js 暴露的 window.KefuSpuSearchText），「SPU / SKU」
  // 「知识库 → 商品」和「商品库」三处共用；各写一份正是上一版漂移的原因——商品库那份
  // 曾经漏掉公共属性，同一个词在两个页面给出不同命中。
  const catalogSearchText = spu => window.KefuSpuSearchText(spu);
  /** 导入、退出或换账号之后必须重读，否则搜到的还是旧目录。 */
  function resetCatalogSearch(){catalogSearchState='idle';catalogSearchRows=[];catalogSearchError=''}
  async function loadCatalogSearch(epoch,session){
    catalogSearchState='loading';
    try{
      const scope=await ensureKnowledgeScope();
      const rows=await api.catalogSpus(scope.tenantId);
      // 期间退出登录或换了账号：这份目录不属于现在这个人，丢掉。
      if(epoch!==knowledgeEpoch||session!==backendSession||!backendConnected)return;
      catalogSearchRows=rows||[];catalogSearchState='ready';
    }catch(error){
      if(epoch!==knowledgeEpoch)return;
      catalogSearchState='error';catalogSearchError=error.message||'商品库读取失败';
    }
  }
  function renderCatalogMatches(query,manualCount){
    const area=el('knowledge-catalog-matches');if(!area)return;
    if(catalogSearchState==='idle'||catalogSearchState==='loading'){
      area.innerHTML='<p class="knowledge-match-note">正在一起搜「SPU / SKU」里的商品库…</p>';
      if(catalogSearchState==='idle'){
        const epoch=knowledgeEpoch,session=backendSession;
        void loadCatalogSearch(epoch,session).then(()=>{
          // 读完只重画列表：等待期间搜索词或页签可能已经变了，变了就不动。
          if(epoch===knowledgeEpoch&&session===backendSession&&knowledgeTab==='products'&&el('knowledge-search').value.trim().toLowerCase()===query)renderKnowledgeList();
        });
      }
      return;
    }
    if(catalogSearchState==='error'){
      area.innerHTML=`<p class="knowledge-match-note">商品库目录这次没读出来（${safe(catalogSearchError)}），搜索只覆盖上面的手工条目。切换页签或稍后重试即可。</p>`;
      return;
    }
    // 这里**不套用上面的状态筛选**：那组选项说的是知识条目的启用 / 停用，而导入的商品
    // 没有这个状态（ERP 原表里没有上下架，导入后一律是「未知」）。按「已停用＝下架」去
    // 套会把 1,500 多个导入商品在选「已启用」时整批藏起来——正好又变成「搜不到导入的
    // 商品」。所以筛选只管手工条目，商品库命中一律列全，上架状态见行里的那一列。
    const hits=catalogSearchRows.filter(spu=>catalogSearchText(spu).includes(query));
    if(!hits.length){
      area.innerHTML=manualCount?'':'<div class="empty">手工条目和商品库里都没有匹配</div>';
      return;
    }
    el('knowledge-count').textContent=`${manualCount} 条手工 + ${hits.length} 条商品库`;
    const visible=hits.slice(0,CATALOG_MATCH_LIMIT);
    area.innerHTML=`<p class="knowledge-match-note">以下 <b>${hits.length}</b> 条来自「SPU / SKU」的结构化商品库（导入的商品都在这里，逐条编辑也在那一页；上面的状态筛选只作用于手工条目）。上架状态为「未知」的，是 ERP 原表里没有上下架信息。${hits.length>visible.length?`这里显示前 ${visible.length} 条。`:''}</p>
      <div class="knowledge-table-wrap"><table class="table knowledge-table"><thead><tr><th>商品（来自商品库）</th><th>SPU 编码</th><th>归属门店</th><th>上架状态</th><th>资料更新</th><th>操作</th></tr></thead><tbody>${visible.map(spu=>`<tr><td><span class="knowledge-table-main">${safe(spu.title)}</span><span class="knowledge-table-sub">${safe(spu.productCode)}</span></td><td>${safe(spu.productCode)}</td><td>${safe(knowledgeStoreName(spu.storeId))}</td><td><span class="pill ${spu.shelfStatus==='on_shelf'?'green':spu.shelfStatus==='off_shelf'?'gray':'blue'}">${safe(catalogShelf[spu.shelfStatus]||spu.shelfStatus)}</span></td><td>${safe(knowledgeDate(spu.updatedAt))}</td><td><button class="small-link" type="button" data-knowledge-catalog-open="${safe(spu.productCode)}">去维护</button></td></tr>`).join('')}</tbody></table></div>
      ${hits.length>visible.length?`<p class="footnote">还有 ${hits.length-visible.length} 条没显示。<button class="small-link" type="button" data-knowledge-catalog-all>去「SPU / SKU」页签看全部</button></p>`:''}`;
    const jump=()=>{knowledgeEditingId=null;knowledgeTab='catalog';renderKnowledge()};
    area.querySelectorAll('[data-knowledge-catalog-open]').forEach(button=>button.onclick=()=>{el('knowledge-search').value=button.dataset.knowledgeCatalogOpen;jump()});
    area.querySelector('[data-knowledge-catalog-all]')?.addEventListener('click',jump);
  }
  function renderKnowledgeList(){
    if(knowledgeTab==='catalog'){window.KefuCatalog.list();return}
    if(!knowledgeLoaded){
      el('knowledge-count').textContent='—';
      el('knowledge-list').innerHTML=`<div class="empty">${knowledgeLoading?'正在从业务后端读取知识库…':'等待读取知识库'}</div>`;
      return;
    }
    const query=el('knowledge-search').value.trim().toLowerCase(),status=el('knowledge-status-filter').value;
    const shown=knowledgeItems().filter(item=>(status==='all'||(status==='enabled')===Boolean(item.enabled))&&(!query||knowledgeText(item).toLowerCase().includes(query)));
    el('knowledge-count').textContent=`${shown.length} / ${knowledgeItems().length} 条`;
    const headings=knowledgeTab==='products'?['商品','SKU','归属门店','状态','更新时间','操作']:knowledgeTab==='faqs'?['标准问题 / 答案','标签','归属门店','状态','更新时间','操作']:['快捷话术','代码','适用范围','状态','更新时间','操作'];
    // 「商品」页签是手工录入的知识条目（旧商品表），导入进来的是结构化目录（SPU / SKU），
    // 两套数据分开存。有搜索词时把商品库的命中并到下面一起显示，否则人在这里搜不到
    // 刚导入的商品，只会以为没导进来——这一页只负责认出来，编辑仍在「SPU / SKU」。
    const catalogBlock=knowledgeTab==='products'&&query?'<div id="knowledge-catalog-matches" class="knowledge-catalog-matches"></div>':'';
    el('knowledge-list').innerHTML=(shown.length?`<div class="knowledge-table-wrap"><table class="table knowledge-table"><thead><tr>${headings.map(value=>`<th>${value}</th>`).join('')}</tr></thead><tbody>${shown.map(item=>knowledgeRow(item,canWriteKnowledge())).join('')}</tbody></table></div>`:'')+catalogBlock+(shown.length||catalogBlock?'':'<div class="empty">当前条件下没有知识条目</div>');
    el('knowledge-list').querySelectorAll('[data-knowledge-open]').forEach(button=>button.onclick=()=>openKnowledgeItem(button.dataset.knowledgeOpen));
    el('knowledge-list').querySelectorAll('[data-knowledge-toggle]').forEach(button=>button.onclick=()=>toggleKnowledgeItem(button.dataset.knowledgeToggle,button));
    if(catalogBlock)renderCatalogMatches(query,shown.length);
  }
  function configureKnowledgeForm(){
    if(knowledgeTab==='faqs'){
      const session=backendSession,epoch=knowledgeEpoch,faqId=knowledgeEditingId;
      window.KefuFaqVariants?.render({api,scope:ensureKnowledgeScope,canWrite:canWriteKnowledge,session,faq:knowledgeState.faqs.find(item=>item.id===faqId)||null,active:()=>knowledgeTab==='faqs'&&knowledgeEditingId===faqId&&backendConnected&&backendSession===session&&knowledgeEpoch===epoch,notify:toast});
    }else window.KefuFaqVariants?.reset();
    el('knowledge-form').hidden=knowledgeTab==='catalog';
    el('catalog-editor').hidden=knowledgeTab!=='catalog';
    if(knowledgeTab==='catalog')return;
    const editable=canWriteKnowledge(),meta=knowledgeMeta[knowledgeTab];
    el('knowledge-product-fields').hidden=knowledgeTab!=='products';
    el('knowledge-faq-fields').hidden=knowledgeTab!=='faqs';
    el('knowledge-shortcut-fields').hidden=knowledgeTab!=='shortcuts';
    el('knowledge-form-title').textContent=`${editable?(knowledgeEditingId?'编辑':'录入'):'查看'}${meta.singular}`;
    el('knowledge-form').querySelectorAll('input,textarea').forEach(field=>field.disabled=!editable);
    el('knowledge-save').hidden=!editable;
    el('knowledge-save').textContent=knowledgeEditingId?'保存修改':'保存';
    el('knowledge-form-reset').hidden=!editable;
    el('knowledge-form-help').textContent=editable?(knowledgeEditingId?'正在编辑已有条目；停用操作可在左侧列表完成。':'填写后保存到当前公司的业务知识库。'):(knowledgeEditingId?'当前为只读查看，知识内容由管理员维护。':'选择左侧条目查看完整内容；客服没有修改权限。');
  }
  function fillKnowledgeForm(item){
    knowledgeEditingId=item?.id||null;
    el('knowledge-form').reset();
    if(item&&knowledgeTab==='products'){
      el('knowledge-product-sku').value=item.sku||'';
      el('knowledge-product-title').value=item.title||'';
      el('knowledge-product-description').value=item.description||'';
    }else if(item&&knowledgeTab==='faqs'){
      el('knowledge-faq-question').value=item.question||'';
      el('knowledge-faq-answer').value=item.answer||'';
      el('knowledge-faq-tags').value=(item.tags||[]).join('，');
    }else if(item&&knowledgeTab==='shortcuts'){
      el('knowledge-shortcut-code').value=item.code||'';
      el('knowledge-shortcut-title').value=item.title||'';
      el('knowledge-shortcut-content').value=item.content||'';
    }
    el('knowledge-form-error').textContent='';configureKnowledgeForm();renderKnowledgeList();
  }
  function resetKnowledgeForm(){if(knowledgeTab==='catalog'){window.KefuCatalog.newSpu();return}fillKnowledgeForm(null)}
  function openKnowledgeItem(id){
    const item=knowledgeItems().find(entry=>String(entry.id)===String(id));
    if(item)fillKnowledgeForm(item);
  }
  // 当前账号的公司范围（公司、门店列表）。知识库与设置页用的是同一份范围，
  // 只在这里解析一次；label 只影响报错文案。
  async function ensureKnowledgeScope(label='知识库'){
    if(knowledgeScope)return knowledgeScope;
    const epoch=knowledgeEpoch,session=backendSession;
    const directories=await api.directoryTenants();
    if(epoch!==knowledgeEpoch||session!==backendSession||!backendConnected)throw new Error(`登录状态已变化，请重新进入${label}`);
    const accessTenant=backendSession?.access?.tenantId||backendSession?.access?.member?.tenantId;
    const entry=(directories||[]).find(item=>item.tenant.id===accessTenant)||(directories||[]).find(item=>item.tenant.enabled!==false)||(directories||[])[0];
    if(!entry)throw new Error(`当前账号没有可访问的公司${label}`);
    const defaultStore=(entry.stores||[]).find(store=>store.enabled!==false)||(entry.stores||[])[0]||null;
    knowledgeScope={tenantId:entry.tenant.id,tenantName:entry.tenant.name,storeId:defaultStore?.id||null,storeName:defaultStore?.name||'',stores:entry.stores||[]};
    return knowledgeScope;
  }
  async function loadKnowledgeData(force=false){
    if(!backendConnected||knowledgeLoading||knowledgeLoaded&&!force)return;
    const epoch=knowledgeEpoch,session=backendSession;
    knowledgeLoading=true;knowledgeLoaded=false;renderKnowledgeList();
    el('knowledge-scope-note').className='knowledge-scope-note';
    el('knowledge-scope-note').textContent='正在从业务后端读取公司知识库…';
    try{
      const scope=await ensureKnowledgeScope();
      const [products,faqs,shortcuts]=await Promise.all([api.knowledgeProducts(scope.tenantId),api.knowledgeFaqs(scope.tenantId),api.knowledgeShortcuts(scope.tenantId)]);
      if(epoch!==knowledgeEpoch||session!==backendSession||!backendConnected)return;
      knowledgeState.products.splice(0,knowledgeState.products.length,...(products||[]));
      knowledgeState.faqs.splice(0,knowledgeState.faqs.length,...(faqs||[]));
      knowledgeState.shortcuts.splice(0,knowledgeState.shortcuts.length,...(shortcuts||[]));
      knowledgeLoaded=true;
      const permission=canWriteKnowledge()?'管理员可新增、编辑、启停和导入':'客服只读，可查看、搜索和测试';
      if(knowledgeTab!=='catalog')el('knowledge-scope-note').textContent=`${scope.tenantName} · ${scope.stores.length} 个门店 · ${permission}`;
      if(!knowledgeEditingId)resetKnowledgeForm();else renderKnowledgeList();
    }catch(error){
      if(epoch!==knowledgeEpoch||session!==backendSession||!backendConnected)return;
      el('knowledge-scope-note').className='knowledge-scope-note error';
      el('knowledge-scope-note').textContent=error.message||'知识库读取失败';
      el('knowledge-list').innerHTML='<div class="empty">知识库暂时无法读取，请确认后端与账号范围。</div>';
    }finally{if(epoch===knowledgeEpoch){knowledgeLoading=false;if(knowledgeLoaded)renderKnowledgeList()}}
  }
  function renderKnowledge(){
    if(!backendConnected){navigate('login');return}
    const editable=canWriteKnowledge(),meta=knowledgeMeta[knowledgeTab];
    el('knowledge-access-badge').textContent=editable?'管理员 · 可维护':'客服 · 只读';
    el('knowledge-access-badge').className=`knowledge-access-badge${editable?'':' readonly'}`;
    el('knowledge-add').hidden=!editable;
    el('knowledge-add').disabled=false;
    el('knowledge-form-reset').disabled=false;
    el('knowledge-add').textContent=`＋ ${meta.add}`;
    // 导入写的是结构化目录（`product_spus` / `product_skus`），结果只出现在
    // 「SPU / SKU」页签。入口留在「商品」页签时，导入成功后的样子就是「列表里什么
    // 都没多」——数据其实在另一个页签。所以按钮跟着结果走：只在这一页签出现，
    // 「商品」页签改为给一句话把人指过来。
    el('knowledge-import').hidden=!editable||knowledgeTab!=='catalog';
    el('knowledge-download-template').hidden=!editable||knowledgeTab!=='catalog';
    el('knowledge-search').placeholder=meta.search;
    document.querySelectorAll('[data-knowledge-tab]').forEach(button=>{const active=button.dataset.knowledgeTab===knowledgeTab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active))});
    configureKnowledgeForm();renderKnowledgeList();
    el('knowledge-test-question').closest('.knowledge-test-panel').hidden=knowledgeTab==='catalog';
    if(knowledgeTab==='catalog'){
      const session=backendSession;
      window.KefuCatalog.render({api,scope:ensureKnowledgeScope,canWrite:canWriteKnowledge,session,active:()=>knowledgeTab==='catalog'&&backendConnected&&backendSession===session,notify:toast});
      return;
    }
    if(knowledgeLoaded&&knowledgeScope){
      el('knowledge-scope-note').className='knowledge-scope-note';
      el('knowledge-scope-note').textContent=`${knowledgeScope.tenantName} · ${knowledgeScope.stores.length} 个门店 · ${editable?'管理员可新增、编辑、启停和导入':'客服只读，可查看、搜索和测试'}`;
    }
    if(backendConnected&&!knowledgeLoaded&&!knowledgeLoading)void loadKnowledgeData();
  }
  async function saveKnowledgeItem(event){
    event.preventDefault();
    if(!canWriteKnowledge())return;
    const epoch=knowledgeEpoch,session=backendSession,tab=knowledgeTab;
    const current=knowledgeItems().find(item=>item.id===knowledgeEditingId);
    let input;
    if(knowledgeTab==='products')input={sku:el('knowledge-product-sku').value.trim(),title:el('knowledge-product-title').value.trim(),description:el('knowledge-product-description').value.trim()};
    else if(knowledgeTab==='faqs')input={question:el('knowledge-faq-question').value.trim(),answer:el('knowledge-faq-answer').value.trim(),tags:el('knowledge-faq-tags').value.split(/[，,]/).map(value=>value.trim()).filter(Boolean)};
    else input={code:el('knowledge-shortcut-code').value.trim(),title:el('knowledge-shortcut-title').value.trim(),content:el('knowledge-shortcut-content').value.trim()};
    const required=knowledgeTab==='products'?[input.sku,input.title]:knowledgeTab==='faqs'?[input.question,input.answer]:[input.code,input.title,input.content];
    if(required.some(value=>!value)){el('knowledge-form-error').textContent='请填写所有必填内容。';return}
    el('knowledge-form-error').textContent='';
    const saveButton=el('knowledge-save');saveButton.disabled=true;saveButton.textContent='正在保存…';
    try{
      const scope=await ensureKnowledgeScope();
      if(epoch!==knowledgeEpoch||session!==backendSession||!canWriteKnowledge())return;
      if(tab!=='shortcuts'&&!scope.storeId)throw new Error('公司下没有可用门店，无法保存。');
      let saved;
      if(tab==='products')saved=current?await api.updateKnowledgeProduct(scope.tenantId,current.id,input):await api.createKnowledgeProduct(scope.tenantId,{storeId:scope.storeId,...input});
      else if(tab==='faqs')saved=current?await api.updateKnowledgeFaq(scope.tenantId,current.id,input):await api.createKnowledgeFaq(scope.tenantId,{storeId:scope.storeId,...input});
      else saved=current?await api.updateKnowledgeShortcut(scope.tenantId,current.id,input):await api.createKnowledgeShortcut(scope.tenantId,{storeId:null,...input});
      if(epoch!==knowledgeEpoch||session!==backendSession||!backendConnected)return;
      const items=knowledgeState[tab],index=items.findIndex(item=>item.id===saved.id);
      if(index>=0)items.splice(index,1,saved);else items.unshift(saved);
      if(tab===knowledgeTab)fillKnowledgeForm(saved);
      toast(`${knowledgeMeta[tab].singular}已${current?'更新':'保存'}到业务后端`);
    }catch(error){if(epoch===knowledgeEpoch&&session===backendSession&&tab===knowledgeTab)el('knowledge-form-error').textContent=[error.message,...(error.details||[])].filter(Boolean).join('；')||'保存失败'}
    finally{if(epoch===knowledgeEpoch){saveButton.disabled=false;configureKnowledgeForm()}}
  }
  async function toggleKnowledgeItem(id,button){
    if(!canWriteKnowledge())return;
    const epoch=knowledgeEpoch,session=backendSession,tab=knowledgeTab;
    const item=knowledgeItems().find(entry=>String(entry.id)===String(id));
    if(!item)return;
    button.disabled=true;
    try{
      const tenantId=(await ensureKnowledgeScope()).tenantId,patch={enabled:!item.enabled};
      if(epoch!==knowledgeEpoch||session!==backendSession||!canWriteKnowledge())return;
      const updated=tab==='products'?await api.updateKnowledgeProduct(tenantId,item.id,patch):tab==='faqs'?await api.updateKnowledgeFaq(tenantId,item.id,patch):await api.updateKnowledgeShortcut(tenantId,item.id,patch);
      if(epoch!==knowledgeEpoch||session!==backendSession||!backendConnected)return;
      // await 期间这份列表可能已经被整体重读过，这时 findIndex 返回 -1；直接 splice 会拿
      // 这条更新覆盖数组的最后一个元素（静默改错数据）。找不到就只刷新界面，列表以下一次
      // 读取为准——与 saveKnowledgeItem 里那条同样的写法。
      const items=knowledgeState[tab],index=items.findIndex(entry=>entry.id===item.id);
      if(index>=0)items.splice(index,1,updated);
      if(tab===knowledgeTab){if(knowledgeEditingId===item.id)fillKnowledgeForm(updated);else renderKnowledgeList()}
      toast(`${knowledgeMeta[tab].singular}已${updated.enabled?'启用':'停用'}`);
    }catch(error){toast(error.message||'状态更新失败')}finally{button.disabled=false}
  }
  function downloadKnowledgeTemplate(){
    const csv='\ufeff商品编码,商品标题,SKU 编码,主图链接,SKU 属性\r\n'
      +'DEMO-001,示例商品（单规格）,DEMO-001-S,,\r\n'
      +'DEMO-002,示例商品（两色）,DEMO-002-BLACK,https://example.com/demo-002.png,"{""颜色"":""黑色"",""尺寸"":""均码""}"\r\n'
      +'DEMO-002,示例商品（两色）,DEMO-002-WHITE,,"{""颜色"":""白色"",""尺寸"":""均码""}"\r\n';
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='商品导入模板.csv';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),0);
    toast('模板已下载：商品编码相同的行是同一个款式，SKU 属性写 JSON');
  }
  // ── 商品导入：文件从哪来、表头怎么认、结果落在哪 ────────────────────────────
  //
  // 导入写的是**结构化目录**（`product_spus` / `product_skus`），落点在「SPU / SKU」
  // 页签，而不是「商品」页签那张手工录入表。界面上必须把这个落点说清楚：入口和结果
  // 在同一页签，导入完成后再把页面带过去——否则「导入成功」的下一眼就是一张什么都没
  // 变的列表。
  //
  // 模板里的列名必须逐字落在服务端别名表上：`商品标题` 认，写成 `标题` 就成了未知列，
  // 于是「缺少必填列 title」整批拒绝。模板自己是第一个会踩这个坑的文件。
  //
  // 模板不带 `类目编码`：类目要先在目录里存在（不存在时那一行进不来），给一列现成答案
  // 更容易让人以为随便填个名字就行。
  /**
   * 导入文件用哪套表头。
   *
   * `template` 是我们自己发的模板、或按我们的字段名整理过的分片，表头就是字段名，
   * 服务端别名表直接认；`erp` 是商家 ERP 的导出原表，同名两列在两边含义不同——
   * 「商品编码」在 ERP 里是规格级、在我们的模型里是商品级——只能靠 mapping 明说
   * 「哪一列是什么」。猜是有代价的：猜错不是报错，而是整列数据挂到错的字段上，回执里
   * 看不出来（2026-10-08 那批数据一开始被拆成几千个款式就是这么来的）。
   *
   * `图片` / `修改时间` 在 ERP 原表里是可选列：映射里写了一个这份文件没有的列名，
   * 预览会整批拒绝并指名那一列，所以它们交给对话框里的勾选框，不写死在预设里。
   */
  const knowledgeImportLayouts={
    template:{label:'本系统模板 / 已整理文件',mapping:null},
    erp:{label:'ERP 导出原表',mapping:{product_code:'款式编码',sku_code:'商品编码',title:'商品名称',main_image_url:'图片',source_updated_at:'修改时间'}}
  };
  const knowledgeImportDialog=`<div class="knowledge-import-layouts" role="radiogroup" aria-label="文件表头来源">
      <label class="knowledge-import-layout"><input type="radio" name="knowledge-import-layout" value="template" checked><span><b>本系统模板 / 已整理文件</b>表头就是「商品编码 / 商品标题 / SKU 编码」这些字段名，直接认。</span></label>
      <label class="knowledge-import-layout"><input type="radio" name="knowledge-import-layout" value="erp"><span><b>ERP 导出原表</b>款式编码＝款式（SPU），商品编码＝商品（SKU）。<b>颜色、规格、售价、分类不会随原表导入</b>——列映射是一列对一个字段，这几列进不了 SKU 规格；要带这些字段，先用 <code>scripts/prepare-real-catalog.cjs</code> 把原表整理成分片再上传。</span></label>
    </div>
    <label class="knowledge-import-file" for="knowledge-import-file">文件（CSV 或 XLSX，单个文件数据行不超过 5000 行）</label>
    <input class="field" id="knowledge-import-file" type="file" accept=".csv,.xlsx">
    <fieldset class="knowledge-import-optional" id="knowledge-import-optional" hidden><legend>ERP 原表里的可选列</legend>
      <label><input type="checkbox" id="knowledge-import-image" checked> 这份文件有「图片」列，用作款式主图</label>
      <label><input type="checkbox" id="knowledge-import-updated" checked> 这份文件有「修改时间」列，用作来源更新时间</label>
    </fieldset>`;
  /** 对话框里选中的表头来源与可选列，合成真正发给服务端的 mapping。 */
  function knowledgeImportChoice(){
    const layout=knowledgeImportLayouts[document.querySelector('input[name="knowledge-import-layout"]:checked')?.value]||knowledgeImportLayouts.template;
    if(!layout.mapping)return {label:layout.label,mapping:null};
    const mapping={...layout.mapping};
    if(el('knowledge-import-image')&&!el('knowledge-import-image').checked)delete mapping.main_image_url;
    if(el('knowledge-import-updated')&&!el('knowledge-import-updated').checked)delete mapping.source_updated_at;
    return {label:layout.label,mapping};
  }
  function openImportDialog(){
    if(!canWriteKnowledge()){toast('当前账号只读，不能导入商品');return}
    showModal('导入商品','先选文件，再做一次只读检查：检查只报数、不写库，确认之后才真正导入。导入写入结构化商品目录，完成后进入索引队列。',()=>{
      const file=el('knowledge-import-file')?.files?.[0];
      // 返回 false 把对话框留在原地：「没选文件」不该看起来像已经提交过了。
      if(!file){toast('请先选择 CSV 或 XLSX 文件');return false}
      void previewKnowledgeImport(file,knowledgeImportChoice());
    },knowledgeImportDialog,'检查文件');
    const optional=el('knowledge-import-optional');
    document.querySelectorAll('input[name="knowledge-import-layout"]').forEach(input=>{
      input.onchange=()=>{optional.hidden=!knowledgeImportLayouts[input.value]?.mapping};
    });
  }
  async function previewKnowledgeImport(file,choice){
    if(!canWriteKnowledge()||!file)return;
    if(!/\.(csv|xlsx)$/i.test(file.name)){toast('仅支持 CSV 或 XLSX 文件');return}
    try{
      toast('正在检查导入文件…');
      const scope=await ensureKnowledgeScope();
      if(!scope.storeId)throw new Error('公司下没有可用门店，无法导入');
      const layout=choice||knowledgeImportLayouts.template;
      const preview=await api.previewKnowledgeImport(scope.tenantId,scope.storeId,file,layout.mapping),summary=preview.summary;
      // 检查期间可能已经退出登录或换了账号，那时这份结果不属于当前这个人。
      if(!canWriteKnowledge())return;
      const issues=(preview.issues||[]).slice(0,6);
      const extra=`<div class="knowledge-import-summary"><div><strong>${summary.totalRows}</strong><span>文件数据行</span></div><div><strong>${summary.previewRowCount}</strong><span>可导入行</span></div><div><strong>${summary.failedRowCount}</strong><span>需修复行</span></div></div>${issues.length?`<div class="knowledge-import-issues">${issues.map(issue=>`第 ${issue.rowNumber||'—'} 行：${safe(issue.message)}`).join('<br>')}</div>`:'<div class="footnote">文件检查通过，没有发现阻塞问题。</div>'}`;
      showModal('确认批量导入',`文件：${file.name}（表头按「${layout.label}」读）。导入会写入 ${scope.storeName||'默认门店'}，有问题的行不会写入。`,()=>{void applyKnowledgeImport(file,layout);},extra,`导入 ${summary.previewRowCount} 行`);
    }catch(error){toast([error.message,...(error.details||[])].filter(Boolean).join('；')||'导入文件检查失败')}
  }
  async function applyKnowledgeImport(file,choice){
    try{
      const scope=await ensureKnowledgeScope();
      if(!canWriteKnowledge())return;
      const layout=choice||knowledgeImportLayouts.template;
      const receipt=await api.applyKnowledgeImport(scope.tenantId,scope.storeId,file,layout.mapping),summary=receipt.summary;
      toast(`导入完成：成功 ${summary.successRows} 行，新增 ${summary.createdSpuCount} 个商品，失败 ${summary.rejectedRowCount+summary.unreadableRowCount} 行`);
      // 把页面带到结果那一页：切到「SPU / SKU」页签、清掉搜索框里可能残留的过滤词，
      // 再让两处列表各自重新读一次。从商品库页发起时不抢页面（那里本来就在看这个
      // 目录），由商品库自己刷新。
      knowledgeEditingId=null;knowledgeTab='catalog';
      window.KefuCatalog?.invalidate?.();
      // 这一页页签上的搜索也缓存了一份目录快照，导入之后它同样过期了。
      resetCatalogSearch();
      if(el('knowledge').classList.contains('active')){el('knowledge-search').value='';renderKnowledge();window.KefuCatalog?.refresh?.()}
      window.KefuProductLibrary?.refresh?.();
    }catch(error){toast([error.message,...(error.details||[])].filter(Boolean).join('；')||'商品导入失败')}
  }
  function testKnowledge(){
    const query=el('knowledge-test-question').value.trim(),result=el('knowledge-test-result');
    result.classList.add('show');
    if(!query){result.textContent='请先输入一个客户问题。';return}
    if(!knowledgeLoaded){result.textContent='知识库仍在加载，请稍后再试。';return}
    const normalized=query.toLowerCase().replace(/\s+/g,''),chars=[...new Set(normalized.replace(/[，。？！,.?!]/g,''))];
    const candidates=[...knowledgeState.products.map(item=>({type:'商品',title:item.title,body:item.description,raw:[item.title,item.sku,item.description].join(' '),enabled:item.enabled})),...knowledgeState.faqs.map(item=>({type:'常见问题',title:item.question,body:item.answer,raw:[item.question,item.answer,...(item.tags||[])].join(' '),enabled:item.enabled})),...knowledgeState.shortcuts.map(item=>({type:'快捷话术',title:item.title,body:item.content,raw:[item.code,item.title,item.content].join(' '),enabled:item.enabled}))].filter(item=>item.enabled).map(item=>{const raw=item.raw.toLowerCase().replace(/\s+/g,'');return {...item,score:(raw.includes(normalized)?50:0)+chars.reduce((sum,char)=>sum+(raw.includes(char)?1:0),0)}}).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
    result.innerHTML=candidates.length?candidates.map((item,index)=>`<div${index?' style="margin-top:8px;padding-top:8px;border-top:1px solid #e0e8f2"':''}><strong>${safe(item.type)} · ${safe(item.title)}</strong><br>${safe(item.body||'暂无补充说明')}</div>`).join(''):'没有找到明显匹配的已启用知识，请换一个更具体的问题。';
  }
  document.querySelectorAll('[data-knowledge-tab]').forEach(button=>button.onclick=()=>{knowledgeTab=button.dataset.knowledgeTab;knowledgeEditingId=null;el('knowledge-form').reset();el('knowledge-search').value='';renderKnowledge()});
  el('knowledge-search').oninput=renderKnowledgeList;
  el('knowledge-status-filter').onchange=renderKnowledgeList;
  el('knowledge-add').onclick=resetKnowledgeForm;
  el('knowledge-form-reset').onclick=resetKnowledgeForm;
  el('knowledge-form').onsubmit=saveKnowledgeItem;
  el('knowledge-download-template').onclick=downloadKnowledgeTemplate;
  el('knowledge-import').onclick=openImportDialog;
  // 导入对话框与模板下载只有这一份实现：知识库页和商品库页共用它，两页因此不会各自
  // 长出一套「导入」（表头识别、落点、权限收口只写一次）。商品库页用的是 navigate 时经
  // ctx.openImport / ctx.downloadTemplate 传进去的这两个函数，不再另设全局入口。
  el('knowledge-test').onclick=testKnowledge;
  el('knowledge-test-question').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();testKnowledge()}};
  // ── 设置页：企业微信渠道连接与客服账号 ────────────────────────────────
  // 这一页服务平台管理员（配置渠道、维护账号）与客服（只读看连接状态和名单）。
  // 写凭据、建成员、停用账号都是服务端按角色和租户再校验的动作，前端只把服务端
  // 的结论显示出来，不把授权判断搬到浏览器。
  let settingsEpoch=0,settingsLoading=false,settingsLoaded=false,settingsChannel=null,
      settingsMembers=null,settingsAccounts=null,settingsStores=[],settingsTenantId=null,
      settingsTenantName='',settingsCallbackPath='';

  // 三种角色在这一页各自能做什么。渠道凭据写入后端限平台超级管理员，客服账号的
  // 读写后端按公司范围放开给管理员；真正的拒绝仍在服务端。
  //
  // 真登录后必须比对**后端下发的角色**，不能只看演示下拉：frontendRoleOf 把
  // platform_admin 和 merchant_admin 一起归成 merchant（导航与工作台按公司口径走），
  // 于是真平台超级管理员进这一页会落到 merchant 分支，看到的是只读表单、提交按钮还
  // 被隐藏——上线后渠道连接就成了摆设。演示角色只在前端未登录时兜底。
  function settingsRole(){
    const backend=backendConnected?backendSession?.access?.role:null;
    if(backend)return backend==='platform_admin'?'platform':backend==='merchant_admin'?'merchant':'agent';
    const value=role();
    return value==='super'||value==='platform'?'platform':value==='merchant'?'merchant':'agent';
  }
  /** 渠道接入是平台侧的事：客服整块看不到。 */
  function canSeeChannelSettings(){return settingsRole()!=='agent';}
  /** 只有平台侧能提交凭据，管理员看得到参数名但改不了。 */
  function canWriteChannel(){return settingsRole()==='platform';}
  /** 客服账号名单与启停：平台侧和管理员都能用，客服只读。 */
  function canManageMembers(){return settingsRole()!=='agent';}
  /** 分流比例只有平台侧能改：其他角色看得到当前比例但改不了，服务端还会再挡一次。 */
  function canWriteRouting(){return settingsRole()==='platform';}
  function settingsRoleLabel(value){return {platform_admin:'平台管理员',merchant_admin:'管理员',agent:'客服'}[value]||value||'—';}
  function settingsAccountLabel(value){return {active:'正常',pending:'待审批',disabled:'已停用'}[value]||value||'—';}
  function settingsTransportLabel(mode){return {real:'真实企业微信',mock:'本地模拟',none:'未绑定传输'}[mode]||mode||'—';}
  function settingsCredentialLabel(source){return {console:'控制台填写',environment:'服务器环境变量',none:'无'}[source]||source||'—';}
  function settingsInstant(value){const date=new Date(value);return value&&!Number.isNaN(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'—';}

  function clearSettingsData(){
    settingsEpoch++;settingsLoading=false;settingsLoaded=false;
    settingsChannel=null;settingsMembers=null;settingsAccounts=null;
    settingsStores=[];settingsTenantId=null;settingsTenantName='';settingsCallbackPath='';
    el('settings-channel-form').reset();
    el('settings-channel-error').textContent='';
    el('settings-wecom-selfcheck-result').textContent='';
    el('settings-channel-state').className='pill gray';el('settings-channel-state').textContent='未读取';
    el('settings-channel-desc').textContent='请登录后查看渠道状态';
    el('settings-member-body').innerHTML='<tr><td colspan="6" class="empty">请登录后查看客服账号</td></tr>';
  }

  function renderSettingsChannel(){
    const state=el('settings-channel-state'),desc=el('settings-channel-desc');
    if(!settingsChannel){state.className='pill gray';state.textContent='未读取';return}
    if(settingsChannel.error){
      state.className='pill orange';state.textContent='读取失败';
      desc.textContent=settingsChannel.error.message||'渠道状态读取失败';
      return;
    }
    const overview=settingsChannel.overview||{};
    const provider=(overview.providers||[]).find(item=>item.provider==='wecom')||null;
    const verdict=overview.credentialVerdict||null;
    if(provider&&provider.callbackVerifyPath)settingsCallbackPath=provider.callbackVerifyPath;
    // 只有真实传输并且真的拿到过 token 才算已连接；其余一律说未连通，不猜测。
    const connected=Boolean(provider&&provider.mode==='real'&&provider.realTransportConnected);
    state.className=`pill ${connected?'green':'orange'}`;
    state.textContent=connected?'已连接':provider?'未连通':'未配置';
    const parts=[`运行模式：${settingsTransportLabel(provider&&provider.mode)}`];
    if(provider)parts.push(`凭据来源：${settingsCredentialLabel(provider.credentialSource)}`);
    parts.push(`绑定客服账号：${(overview.bindings||[]).length} 个`);
    if(verdict)parts.push(`上次验证：${verdict.connected?'成功':'失败'}（${settingsInstant(verdict.verifiedAt)}）`);
    let text=`${settingsTenantName?`${settingsTenantName} · `:''}${parts.join(' · ')}`;
    if(verdict&&!verdict.connected&&verdict.verifiedError)text+=`。失败原因：${verdict.verifiedError}`;
    const lastError=provider&&provider.lastConnectionError;
    if(lastError&&lastError.message)text+=`。最近错误：${lastError.message}${lastError.at?`（${settingsInstant(lastError.at)}）`:''}`;
    // 上线排查要靠这句：后端只说「缺哪些变量」，前端把它翻出来，免得运维对着
    // 五个空输入框猜是表单没填还是部署没配。
    // （这里原先还有一句「当前部署绑定的是本地模拟传输……需要 WECOM_TRANSPORT 设为 real
    // 后重启」，2026-10-08 按用户要求删掉，不再显示。）
    const missing=provider&&provider.missingCredentials;
    if(!connected&&Array.isArray(missing)&&missing.length)text+=`。部署侧缺少配置：${missing.join('、')}。`;
    desc.textContent=text;
  }

  function renderSettingsMembers(){
    const body=el('settings-member-body'),editable=canManageMembers();
    if(!settingsMembers){
      // 读不到名单有两种原因，说清是哪一种：客服本来就不该读，还是平台管理员这次没读到。
      body.innerHTML=`<tr><td colspan="6" class="empty">${editable?'客服账号暂时无法读取。':'客服账号由平台管理员或管理员维护，当前账号只读。'}</td></tr>`;
      return;
    }
    if(!settingsMembers.length){
      body.innerHTML='<tr><td colspan="6" class="empty">这家公司还没有客服账号。</td></tr>';
      return;
    }
    const accounts=settingsAccounts||[];
    body.innerHTML=settingsMembers.map(member=>{
      const account=accounts.find(item=>String(item.memberId)===String(member.id))||null;
      const store=settingsStores.find(item=>item.id===member.storeId);
      const isSelf=String(member.id)===String(selfMemberId);
      const accountNote=!account
        ?'<br><span class="settings-member-self">未绑定登录账号</span>'
        :account.status!=='active'?`<br><span class="settings-member-self">登录账号：${safe(settingsAccountLabel(account.status))}</span>`:'';
      const action=editable&&!isSelf
        ?`<button class="small-link" type="button" data-member-toggle="${safe(member.id)}" data-member-enabled="${member.enabled?'true':'false'}">${member.enabled?'禁用':'启用'}</button>`
        :isSelf?'<span class="settings-member-self">不能停用自己</span>':'—';
      return `<tr><td>${safe(member.username||'—')}</td><td><strong>${safe(member.displayName)}</strong>${isSelf?' <span class="settings-member-self">本人</span>':''}</td><td id="settings-role-${safe(member.id)}">${safe(settingsRoleLabel(member.role))}</td><td>${safe(store?store.name:'未分配门店')}</td><td><span class="pill ${member.enabled?'green':'gray'}">${member.enabled?'已启用':'已禁用'}</span>${accountNote}</td><td><div class="settings-member-actions">${action}</div></td></tr>`;
    }).join('');
    body.querySelectorAll('[data-member-toggle]').forEach(button=>{button.onclick=()=>toggleSettingsMember(button)});
  }

  /** 客服显示名：名单还没读到时退回成员 id，免得整行看起来是空的。 */
  /**
   * 从成员名单里取显示名。
   *
   * 分流面板与设置页读的是同一份服务端成员目录，两处共用这一段：同一个 memberId
   * 在两个页面上必须显示成同一个名字。名单没读到就退回 memberId，不编一个名字。
   */
  function memberNameOf(members,memberId){
    const member=(members||[]).find(item=>String(item.id)===String(memberId));
    return member?(member.displayName||member.username||memberId):String(memberId);
  }

  /** 服务端报的接单状态，翻成界面上的说法。 */
  function settingsAvailabilityLabel(status){
    return {accepting:'在线接单',busy:'忙碌',away:'离开',offline:'离线'}[status]||status||'—';
  }

  function renderSettings(){
    if(!backendConnected){navigate('login');return}
    const bucket=settingsRole(),writeChannel=canWriteChannel(),manageMembers=canManageMembers();
    el('settings-access-badge').textContent=bucket==='platform'?'平台管理员 · 可维护':bucket==='merchant'?'管理员 · 渠道只读':'客服 · 只读';
    el('settings-access-badge').className=`knowledge-access-badge${bucket==='platform'?'':' readonly'}`;
    // 客服看不到渠道接入这一整块；管理员能看到状态和参数名，但写入由平台侧执行。
    el('settings-channel-panel').hidden=!canSeeChannelSettings();
    el('settings-channel-note').textContent=writeChannel
      ?'以下五项从企业微信后台读出后填入，保存时后端会立即用它们换取 access_token，并回报真实连接结果。凭据属部署级配置，写入需要平台超级管理员账号。'
      :'凭据属部署级配置，写入由平台超级管理员执行。这里的参数名和回调地址供核对，当前账号只读。';
    ['settings-wecom-corp','settings-wecom-open-kfid','settings-wecom-secret','settings-wecom-token','settings-wecom-aes'].forEach(id=>{el(id).disabled=!writeChannel});
    el('settings-channel-save').hidden=!writeChannel;
    // 自检会让服务器对外发一次请求，入口只给能写这份凭据的平台超级管理员：
    // 对只读角色整块藏掉，连说明一起，免得留下一句「可以点自检」却没有按钮。
    el('settings-wecom-selfcheck-field').hidden=!writeChannel;
    el('settings-wecom-selfcheck-help').hidden=!writeChannel;
    el('settings-wecom-selfcheck').hidden=!writeChannel;
    el('settings-wecom-selfcheck-result').hidden=!writeChannel;
    el('settings-member-add').hidden=!manageMembers;
    // 只在还没读到数据时铺默认说明，免得把 loadSettings 写下的失败原因覆盖掉。
    if(!settingsLoaded)el('settings-member-note').textContent=manageMembers
      ?'只有「已启用」的账号参与自动分配；停用会同时停掉排班和登录，进行中的会话不受影响。'
      :'客服账号由平台管理员或管理员维护；当前账号只读。';
    renderSettingsChannel();renderSettingsMembers();
    // 回调地址要在企业微信后台一字不差地登记，所以用后端报的路径，别在浏览器里再抄
    // 一份契约：部署换了前缀，抄的那一份会让签名校验一直失败。放在读完之后再写，
    // 免得先用兜底路径铺一遍再被覆盖。
    el('settings-wecom-callback').value=`${location.origin}${settingsCallbackPath||'/api/v1/channels/wecom/callback'}`;
    // 自检框默认跟着上面这个地址，但只在空着时铺：真正要自检的可能是另一个公网
    // 地址（内网打开控制台、或前面挂了网关），铺过一次就不要再盖掉操作者改的值。
    const selfCheckUrl=el('settings-wecom-selfcheck-url');
    if(!selfCheckUrl.value)selfCheckUrl.value=el('settings-wecom-callback').value;
    if(!settingsLoaded&&!settingsLoading)void loadSettings();
  }

  async function loadSettings(force=false){
    if(!backendConnected||settingsLoading||(settingsLoaded&&!force))return;
    const epoch=settingsEpoch,session=backendSession;
    settingsLoading=true;settingsLoaded=false;
    el('settings-channel-state').className='pill gray';el('settings-channel-state').textContent='读取中…';
    try{
      const scope=await ensureKnowledgeScope('设置');
      if(epoch!==settingsEpoch||session!==backendSession||!backendConnected)return;
      settingsStores=scope.stores||[];settingsTenantId=scope.tenantId;settingsTenantName=scope.tenantName||'';
      // 客服账号名单是管理动作，只读角色不去读它：空跑一次 403 只会把页面弄脏。
      // 渠道状态任何登录成员都能读，客服也该看得到。
      const canReadMembers=canManageMembers(),canReadChannel=canSeeChannelSettings();
      const [channel,members,accounts]=await Promise.allSettled([
        canReadChannel?api.channelsOverview(scope.tenantId):Promise.resolve(null),
        canReadMembers?api.adminMembers(scope.tenantId):Promise.resolve(null),
        canReadMembers?api.adminAccounts(scope.tenantId):Promise.resolve(null),
      ]);
      if(epoch!==settingsEpoch||session!==backendSession||!backendConnected)return;
      settingsChannel=canReadChannel&&channel.status==='fulfilled'?{overview:channel.value||null}:canReadChannel?{error:channel.reason}:null;
      settingsMembers=canReadMembers&&members.status==='fulfilled'?(Array.isArray(members.value)?members.value:[]):null;
      settingsAccounts=canReadMembers&&accounts.status==='fulfilled'?(Array.isArray(accounts.value)?accounts.value:[]):null;
      settingsLoaded=true;
      renderSettingsChannel();renderSettingsMembers();
      el('settings-member-note').textContent=!canReadMembers
        ?'客服账号由平台管理员或管理员维护；当前账号只读。'
        :settingsMembers
          ?'只有「已启用」的账号参与自动分配；停用会同时停掉排班和登录，进行中的会话不受影响。'
          :`客服名单读取失败：${(members.reason&&members.reason.message)||'服务端拒绝了这次读取'}。${settingsReadFailureHint(members.reason)}`;
    }catch(error){
      if(epoch!==settingsEpoch||session!==backendSession||!backendConnected)return;
      settingsChannel={error};settingsMembers=null;
      renderSettingsChannel();renderSettingsMembers();
      el('settings-member-note').textContent=error.message||'设置读取失败';
    }finally{if(epoch===settingsEpoch)settingsLoading=false}
  }

  /**
   * 把「读取失败」里最容易被误读的一种说清楚。
   *
   * 403 不是「这家公司没有客服账号」：服务端对**不可用的登录身份**一律这样拒绝，
   * 账号被临时锁定或停用都会落到这里。页面只有这句小字能说明原因，不说清楚，
   * 看到的就是「客服账号看不到了」——像是数据丢了，其实是身份被拒。前端不做判断，
   * 只按后端的 code 翻译（`forbidden` 是本平台拒绝的统一 code）。
   */
  function settingsReadFailureHint(error){
    const code=error&&error.code;
    // 两种拒绝在接口上是同一个 code，只能合成一句说：服务端的错误信封只原样透出
    // KNOWN_ERROR_CODES 里的 code（见 apps/api/src/http/all-exceptions.filter.ts），
    // access_denied（账号被停用／临时锁定）与 pending_config（未绑定成员、所属公司
    // 被停用）都不在其中，到了浏览器统一是 403 的 `forbidden` / `Forbidden`。
    if(code==='forbidden'||code==='access_denied'||code==='pending_config')return '当前登录身份被后端拒绝：账号可能被停用或临时锁定，也可能还没绑定成员／所属公司被停用；重新登录后仍然如此，请让平台管理员检查账号状态。';
    return '';
  }

  function toggleSettingsMember(button){
    if(!canManageMembers())return;
    const memberId=button.dataset.memberToggle,enabled=button.dataset.memberEnabled!=='true';
    const member=(settingsMembers||[]).find(item=>String(item.id)===String(memberId));
    const account=(settingsAccounts||[]).find(item=>String(item.memberId)===String(memberId))||null;
    if(!member)return;
    const verb=enabled?'启用':'禁用';
    showModal(`${verb}客服账号`,
      `${verb}「${member.displayName}」（${member.username}）后，${enabled?'可以重新登录并参与会话分配。':'不能再登录，已登录的会话会被注销，也不再被分配新会话；进行中的会话不受影响。'}`,
      ()=>{
        el('modal-confirm').disabled=true;
        void (async()=>{
          try{
            await api.setMemberEnabled(settingsTenantId,memberId,enabled);
          }catch(error){
            el('modal-confirm').disabled=false;toast(error.message||`${verb}失败`);return;
          }
          // 成员管排班、账号管登录：两件事都做才叫「停用这个客服账号」。
          let accountError=null;
          if(account){try{await api.setAccountDisabled(settingsTenantId,account.id,!enabled)}catch(error){accountError=error}}
          closeModal();await loadSettings(true);
          toast(accountError?`已${verb}排班，但登录账号未同步：${accountError.message}`:`已${verb} ${member.displayName}`);
        })();
        return false;
      },
      '<p class="footnote">停用不是删除：账号、排班和历史记录都保留，随时可以重新启用。</p>',
      `确认${verb}`);
  }

  el('settings-channel-refresh').onclick=()=>{if(backendConnected)void loadSettings(true)};

  // ── 管理员中心：员工分流（分单比例） ─────────────────────────────────
  // 这块面板原来在设置页叫「会话分流」，2026-10-08 整块并进管理员中心的「员工分流」，
  // 设置页那一块删掉——分单比例只留一处入口，免得两页各改一半、口径分叉。
  //
  // 面板**显示与否**由管理员中心的权限模块决定（admin.js 的 canAccess('routing')）；
  // **能不能改**由后端下发的角色决定（canWriteRouting）。客服连「有人按比例分单」这件
  // 事都不必知道，所以没权限时这一块既不渲染、也不去读：一次必然 403 的读只会把页面
  // 弄脏。真正的拒绝仍在服务端（assertTenantAdmin）。
  //
  // 三条写法和原来一样，都是刻意的：占比照输入框算、不回服务端（回服务端算会让「还没
  // 保存的值」看起来像「已经保存了」）；保存只提交画出来的那几行（服务端按名单更新，
  // 没提交的保持原值）；保存失败不清掉已读到的数据（清掉之后页面看起来像「没有分流
  // 设置」，操作者会以为是自己把设置弄没了）。
  let routingEpoch=0,routingLoading=false,routingLoaded=false,routingTenantId=null,
      routingMembers=null,routingPolicy=null,routingError='';

  function clearRoutingData(){
    routingEpoch++;routingLoading=false;routingLoaded=false;
    routingTenantId=null;routingMembers=null;routingPolicy=null;routingError='';
    const error=el('admin-routing-error');
    if(error)error.textContent='';
  }

  /**
   * 按当前输入框里的权重重算「实际占比」。
   *
   * 只把「已启用」员工的权重算进分母：停用的员工不接新会话，算进去会让每个在线员工
   * 的占比看起来比实际小。这一列直接照输入框算，不读回服务端——每次按键都发一次请求
   * 既慢，又会让没保存的值看起来像已经保存了。
   */
  function recomputeRoutingShares(){
    const seats=(routingPolicy&&routingPolicy.seats)||[];
    const inputs=new Map([...document.querySelectorAll('[data-routing-weight]')].map(input=>[String(input.dataset.routingWeight),Number(input.value)]));
    const shares=new Map([...document.querySelectorAll('[data-routing-share]')].map(cell=>[String(cell.dataset.routingShare),cell]));
    const weightOf=seat=>{const typed=inputs.get(String(seat.memberId));return typed===undefined?seat.weight:typed};
    let total=0;
    for(const seat of seats){const weight=weightOf(seat);if(seat.enabled&&Number.isFinite(weight)&&weight>0)total+=weight}
    for(const seat of seats){
      const cell=shares.get(String(seat.memberId));
      if(!cell)continue;
      const weight=weightOf(seat);
      cell.textContent=total>0&&seat.enabled&&Number.isFinite(weight)&&weight>0?`${(weight/total*100).toFixed(1)}%`:'—';
    }
  }

  /**
   * 员工分流：每个员工的权重、当前在手会话数，以及按权重折算的实际占比。
   *
   * 权重是相对比例，所以只显示「占多少」，不要求加起来等于 100：填 6 和 4 与填
   * 60 和 40 是同一套策略，页面不该让人以为必须凑整。已停用的员工不参与自动分配
   * （服务端按启用状态判定），权重仍然保留，重新启用即恢复。
   */
  function renderRouting(){
    const body=el('admin-routing-body'),editable=canWriteRouting();
    const state=el('admin-routing-state'),desc=el('admin-routing-desc'),button=el('admin-routing-save');
    button.hidden=!editable;button.disabled=false;button.textContent='保存分流比例';
    el('admin-routing-error').textContent=routingError||'';
    if(!backendConnected){
      state.className='pill gray';state.textContent='未读取';
      desc.textContent='请登录后查看分流设置。';
      body.innerHTML='<tr><td colspan="5" class="admin-muted">请登录后查看分流设置</td></tr>';
      return;
    }
    if(!routingPolicy){
      state.className='pill gray';state.textContent='未读取';
      desc.textContent=routingError?'分流设置读取失败':'正在读取分流设置…';
      body.innerHTML='<tr><td colspan="5" class="admin-muted">会话分流设置暂时无法读取。</td></tr>';
      return;
    }
    const seats=routingPolicy.seats||[];
    let total=0;
    for(const seat of seats){if(seat.enabled&&seat.weight>0)total+=seat.weight}
    state.className=`pill ${total>0?'green':'gray'}`;
    state.textContent=total>0?'已启用':'无人接单';
    desc.textContent=total>0
      ?'新会话按上面的权重分给「在线接单」的员工：谁的在手会话数 ÷ 权重最小，就分给谁。'
      :'所有员工的权重都是 0（或都已停用）：新会话不会自动分配，只给客户发一条离线回复。';
    if(!seats.length){
      body.innerHTML='<tr><td colspan="5" class="admin-muted">这家公司还没有客服账号。</td></tr>';
      return;
    }
    body.innerHTML=seats.map(seat=>{
      const name=memberNameOf(routingMembers,seat.memberId);
      const status=!seat.enabled?'已停用':seat.live?settingsAvailabilityLabel(seat.status):'离线';
      const share=total>0&&seat.enabled&&seat.weight>0?`${(seat.weight/total*100).toFixed(1)}%`:'—';
      const input=editable&&seat.enabled
        ?`<input class="field admin-routing-weight" type="number" min="0" max="1000" step="1" inputmode="numeric" data-routing-weight="${safe(seat.memberId)}" value="${safe(String(seat.weight))}" aria-label="${safe(name)}的分流权重">`
        :`<span class="admin-routing-fixed">${safe(String(seat.weight))}</span>`;
      const note=seat.configured
        ?`<br><span class="admin-routing-self">上次修改：${safe(settingsInstant(seat.updatedAt))}${seat.updatedBy?` · ${safe(memberNameOf(routingMembers,seat.updatedBy))}`:''}</span>`
        :'<br><span class="admin-routing-self">默认权重（未单独设置）</span>';
      return `<tr><td><strong>${safe(name)}</strong></td><td><span class="pill ${seat.enabled&&seat.live?'green':'gray'}">${safe(status)}</span></td><td>${safe(String(seat.inProgressCount))}</td><td>${input}${note}</td><td data-routing-share="${safe(seat.memberId)}">${safe(share)}</td></tr>`;
    }).join('');
    body.querySelectorAll('[data-routing-weight]').forEach(input=>{input.oninput=()=>recomputeRoutingShares()});
  }

  /**
   * 读员工分流的席位表。
   *
   * 成员名单和比例一起读：比例里只有 memberId，界面要显示姓名，而这份名单就是管理员
   * 自己那份（服务端成员目录）——两者的读取规则相同（都是 assertTenantAdmin），一起读
   * 不会多开一个权限口子。读不到就照实说读不到，不铺一份空表让人以为「还没设置」。
   */
  async function loadRouting(force=false){
    if(!backendConnected||routingLoading||(routingLoaded&&!force))return;
    const epoch=routingEpoch,session=backendSession;
    routingLoading=true;routingLoaded=false;
    renderRouting();
    try{
      const scope=await ensureKnowledgeScope('员工分流');
      if(epoch!==routingEpoch||session!==backendSession||!backendConnected)return;
      const [members,policy]=await Promise.allSettled([
        api.adminMembers(scope.tenantId),
        api.conversationRouting(scope.tenantId),
      ]);
      if(epoch!==routingEpoch||session!==backendSession||!backendConnected)return;
      routingTenantId=scope.tenantId;
      routingMembers=members.status==='fulfilled'&&Array.isArray(members.value)?members.value:null;
      routingPolicy=policy.status==='fulfilled'?policy.value||null:null;
      routingError=policy.status==='fulfilled'
        ?''
        :`分流比例读取失败：${(policy.reason&&policy.reason.message)||'服务端拒绝了这次读取'}。`;
      routingLoaded=true;
      renderRouting();
      // 概览里「可参与接待」那一格用的是同一份事实：读到了要让概览跟着改口。
      window.AdminPortal?.refreshOverview?.();
    }catch(error){
      if(epoch!==routingEpoch||session!==backendSession||!backendConnected)return;
      routingMembers=null;routingPolicy=null;routingError=error.message||'分流设置读取失败';
      renderRouting();
    }finally{if(epoch===routingEpoch)routingLoading=false}
  }

  /**
   * 提交分流比例。
   *
   * 只提交界面上画出来的那几名员工：服务端按名单更新，没画出来的（例如将来分页之外
   * 的人）保持原值，所以这里传数组而不是整表替换。权重在浏览器里先按「0 或正整数」
   * 挡一道，服务端还会再挡一次——前端这道只是为了少跑一趟。
   *
   * @returns 改动过的席位（姓名、旧值、新值），供管理员中心写操作日志；没有改动时为空数组；
   * 输入没通过前端校验、或根本没读到这一家公司的席位时返回 `null`（什么都没发生，别当成
   * 「没有变化」去提示）。
   * @throws 保存失败时抛出（原因已写在面板的 #admin-routing-error 上），让调用方别当成功。
   */
  async function saveRouting(){
    if(!backendConnected||!routingTenantId)return null;
    const error=el('admin-routing-error'),button=el('admin-routing-save');
    const weights=[...document.querySelectorAll('[data-routing-weight]')].map(input=>({
      member_id:String(input.dataset.routingWeight),
      weight:Number(input.value),
    }));
    if(weights.some(entry=>!Number.isInteger(entry.weight)||entry.weight<0)){
      error.textContent='权重只能填 0 或正整数。';
      return null;
    }
    const before=new Map(((routingPolicy&&routingPolicy.seats)||[]).map(seat=>[String(seat.memberId),seat.weight]));
    const changed=weights.filter(entry=>before.has(entry.member_id)&&before.get(entry.member_id)!==entry.weight)
      .map(entry=>({memberId:entry.member_id,name:memberNameOf(routingMembers,entry.member_id),from:before.get(entry.member_id),weight:entry.weight}));
    // 一个数字都没改就不发这一趟：服务端只会把同样的值写回去，而「保存成功」的提示
    // 会让人以为发生了什么。
    if(!changed.length){error.textContent='';return []}
    const epoch=routingEpoch,session=backendSession,label=button.textContent;
    button.disabled=true;button.textContent='正在保存…';error.textContent='';
    try{
      const saved=await api.saveConversationRouting(routingTenantId,weights);
      if(epoch!==routingEpoch||session!==backendSession||!backendConnected)return [];
      routingPolicy=saved;routingError='';
      renderRouting();
      window.AdminPortal?.refreshOverview?.();
      return changed;
    }catch(failure){
      if(epoch!==routingEpoch||session!==backendSession||!backendConnected)return [];
      // 保存失败只改这一行的错误提示，不把已读到的比例清掉：清掉之后页面看起来
      // 像「没有分流设置」，操作者会以为自己的改动把设置弄没了。
      routingError=`保存失败：${(failure&&failure.message)||'服务端拒绝了这次保存'}`;
      renderRouting();
      throw failure;
    }finally{button.disabled=false;button.textContent=label}
  }

  window.RoutingPortal={
    /** 管理员中心打开、或切到「员工分流」时调用：先画已有的事实，再按需去读。 */
    open(){
      renderRouting();
      if(!backendConnected||routingLoading||routingLoaded)return;
      void loadRouting();
    },
    /** 退出登录时调用：分单比例是别人公司的数据，不能留在页面上。 */
    leave:clearRoutingData,
    /** 「刷新」按钮：连已读过的一起重读。 */
    refresh(){if(backendConnected)void loadRouting(true)},
    /** 「保存」按钮：返回改动过的席位，失败时抛出。 */
    save:saveRouting,
    /**
     * 概览那一格要用的当前事实。没读到就返回 null，让调用方照实显示「—」，
     * 而不是拿演示数据顶上——那一格和这张表必须是同一个数。
     */
    summary(){
      if(!routingPolicy)return null;
      const seats=routingPolicy.seats||[];
      const participating=seats.filter(seat=>seat.enabled&&seat.weight>0);
      return {total:seats.length,participating:participating.length,online:participating.filter(seat=>seat.live).length};
    },
  };
  el('admin-routing-refresh').onclick=()=>window.RoutingPortal.refresh();

  el('settings-channel-form').onsubmit=event=>{
    event.preventDefault();
    if(!canWriteChannel())return;
    const values={
      corp_id:el('settings-wecom-corp').value.trim(),
      open_kfid:el('settings-wecom-open-kfid').value.trim(),
      kf_secret:el('settings-wecom-secret').value.trim(),
      callback_token:el('settings-wecom-token').value.trim(),
      aes_key:el('settings-wecom-aes').value.trim(),
    };
    const labels={corp_id:'企业 ID',open_kfid:'客服账号 ID',kf_secret:'微信客服 Secret',callback_token:'回调 Token',aes_key:'回调 EncodingAESKey'};
    const missing=Object.keys(values).filter(key=>!values[key]).map(key=>labels[key]);
    if(missing.length){el('settings-channel-error').textContent=`请先填写：${missing.join('、')}。`;return}
    el('settings-channel-error').textContent='';
    const button=el('settings-channel-save');button.disabled=true;button.textContent='正在连接…';
    void api.connectWecom(settingsTenantId,values).then(verdict=>{
      // 密钥不回显：提交后清空密文字段，别让它留在输入框里被旁人看到或误复制。
      el('settings-wecom-secret').value='';el('settings-wecom-aes').value='';
      const connected=Boolean(verdict&&verdict.connected);
      el('settings-channel-error').textContent=connected?'':(verdict&&verdict.verifiedError)||'凭据已保存，但这次没能连上企业微信。';
      toast(connected?'企业微信已连接':'凭据已保存，未能连通');
      return loadSettings(true);
    }).catch(error=>{
      el('settings-channel-error').textContent=[error.message,...(error.details||[])].filter(Boolean).join('；')||'连接失败';
    }).finally(()=>{button.disabled=false;button.textContent='保存并连接'});
  };
  el('settings-wecom-selfcheck').onclick=()=>{void runWecomSelfCheck()};
  // 自检框在这个表单里，回车默认会提交「保存并连接」——那是另一件事。回车就按
  // 眼前的意图走：自检这个地址。
  el('settings-wecom-selfcheck-url').addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();void runWecomSelfCheck()}
  });

  /** 把一句自检结论写进结果行，并按结果切换颜色与无障碍角色。 */
  function setSelfCheckResult(text,tone){
    const node=el('settings-wecom-selfcheck-result');
    node.textContent=text;
    node.className=tone==='ok'?'settings-form-ok':tone==='error'?'settings-form-error':'settings-form-help';
    node.setAttribute('role',tone==='error'?'alert':'status');
  }

  /**
   * 把服务端的自检结论翻成一句中文。
   *
   * 服务端只说事实（哪个阶段、看到了什么），措辞由界面负责——同一份结论以后要
   * 出现在别处时，各端自己组织句子。detail 是平台自己的英文描述，原样附在后面，
   * 免得把「地址不通」和「凭据不对」这类关键信息翻译时丢掉。
   */
  function selfCheckSentence(verdict){
    if(!verdict)return '自检没有返回结果，请重试。';
    const stage={
      transport:'这个部署绑定的是本地模拟传输，没有真实的企业微信握手可校验。',
      url:'这个地址本身没法自检。',
      credentials:'这个部署还没有可用的企业微信凭据。',
      request:'请求没能送出去或没等到响应。',
      status:'地址有响应，但状态码不是企业微信认可的 200。',
      plaintext:'地址有响应，但返回的内容不是它收到的明文。',
      ok:'通过：该地址按企业微信的方式回应了握手，用的就是当前生效的这组凭据。',
    }[verdict.stage]||'未知结果。';
    const where=verdict.probed_url?`（${verdict.probed_url}）`:'';
    const reason=verdict.detail?`${verdict.ok?'':'原因：'}${verdict.detail}`:'';
    return `${verdict.ok?'✓':'✗'} ${stage}${where}${reason}`;
  }

  async function runWecomSelfCheck(){
    if(!canWriteChannel())return;
    const button=el('settings-wecom-selfcheck');
    const url=el('settings-wecom-selfcheck-url').value.trim();
    if(!url){setSelfCheckResult('请先填写要自检的公网回调 URL。','error');return}
    button.disabled=true;button.textContent='正在自检…';
    // 先说清这一步会慢：服务端要真的请求一次外部地址，最多等 5 秒。
    setSelfCheckResult('正在按企业微信的方式请求这个地址，最多等 5 秒…','pending');
    try{
      const verdict=await api.selfCheckWecomCallback(settingsTenantId,url);
      setSelfCheckResult(selfCheckSentence(verdict),verdict&&verdict.ok?'ok':'error');
    }catch(error){
      setSelfCheckResult([error&&error.message,...((error&&error.details)||[])].filter(Boolean).join('；')||'自检请求失败','error');
    }finally{button.disabled=false;button.textContent='自检回调地址'}
  }

  el('settings-member-add').onclick=()=>{
    if(!canManageMembers())return;
    const storeOptions=['<option value="">不分配门店</option>',...settingsStores.filter(store=>store.enabled!==false).map(store=>`<option value="${safe(store.id)}">${safe(store.name)}</option>`)].join('');
    const extra=`<div class="settings-form-grid">
      <div class="settings-field"><label for="settings-new-username">登录账号</label><input id="settings-new-username" class="field" autocomplete="off" spellcheck="false" placeholder="例如 wangyifan"></div>
      <div class="settings-field"><label for="settings-new-display">显示名</label><input id="settings-new-display" class="field" placeholder="会话里显示的名字"></div>
      <div class="settings-field"><label for="settings-new-role">角色</label><select id="settings-new-role" class="field"><option value="agent">客服</option><option value="platform_admin">平台管理员</option></select></div>
      <div class="settings-field"><label for="settings-new-store">所属门店</label><select id="settings-new-store" class="field">${storeOptions}</select></div>
      <div class="settings-field"><label for="settings-new-password">初始密码</label><input id="settings-new-password" class="field" type="password" autocomplete="new-password" placeholder="至少 8 位"></div>
    </div><p class="settings-form-error" id="settings-new-error" role="alert"></p>`;
    showModal('新建客服账号',
      '账号建好后，本人用这里的登录账号和初始密码登录客服工作台。初始密码只在这里设置一次，请通过可靠方式交给本人并要求其尽快修改。',
      ()=>{
        const username=el('settings-new-username').value.trim();
        const displayName=el('settings-new-display').value.trim();
        const password=el('settings-new-password').value;
        const roleValue=el('settings-new-role').value;
        const storeId=el('settings-new-store').value;
        const error=el('settings-new-error');
        if(!username||!displayName){error.textContent='请填写登录账号和显示名。';return false}
        if(password.length<8){error.textContent='初始密码至少 8 位。';return false}
        error.textContent='';
        el('modal-confirm').disabled=true;
        // 建一个能登录的客服账号要走三步：成员（排班席位）、账号（登录与密码）、
        // 绑定。中途失败必须说清停在哪一步，否则对方会以为账号已经能用了。
        void (async()=>{
          let member=null;
          try{
            member=await api.createMember(settingsTenantId,{store_id:storeId||null,role:roleValue,username,display_name:displayName,enabled:true});
          }catch(err){
            el('modal-confirm').disabled=false;error.textContent=`成员创建失败：${err.message||'服务端拒绝了这次创建'}`;return;
          }
          let account=null;
          try{
            account=await api.createAccount(settingsTenantId,{username,display_name:displayName,password});
          }catch(err){
            el('modal-confirm').disabled=false;error.textContent=`成员已创建，但登录账号创建失败：${err.message||''}。请修正后重新新建。`;void loadSettings(true);return;
          }
          try{
            await api.linkMemberAccount(settingsTenantId,member.id,account.id);
          }catch(err){
            el('modal-confirm').disabled=false;error.textContent=`成员和账号都已创建，但绑定失败：${err.message||''}。请在员工管理中处理这条待绑定账号。`;void loadSettings(true);return;
          }
          closeModal();toast(`已创建客服账号 ${displayName}`);
          await loadSettings(true);
        })();
        return false;
      },
      extra,'创建并启用');
  };
  // 商品库页的两个入口（导入 / 模板）由 `src/products.js` 绑定到与知识库页同一份
  // 实现上（见 openImportDialog），这里不再另接一套演示弹窗。
  document.querySelectorAll('[data-demo]').forEach(x=>x.onclick=()=>toast(x.dataset.demo+' · 此处为界面演示'));
  // Platform-only review action. Backend must verify reviewer permissions and
  // persist an audit trail before adding approved text to the tenant phrase pool.
  el('approve-review').onclick=()=>{el('review-list').innerHTML='<div class="empty">该条话术已审核通过（模拟）</div>';toast('审核通过，已加入对应租户话术库（模拟）')};
  el('edit-review').onclick=()=>showModal('编辑后通过','修改候选话术后入库。',()=>{el('review-list').innerHTML='<div class="empty">该条话术已编辑并通过（模拟）</div>';toast('编辑后通过（模拟）')},'<textarea class="field" style="height:90px">这款 500ml 保温杯有黑色和米白色两种颜色，您可以打开商品链接查看款式详情。</textarea>');
  el('reject-review').onclick=()=>showModal('拒绝话术','请填写拒绝原因，便于追踪。',()=>{el('review-list').innerHTML='<div class="empty">该条话术已拒绝（模拟）</div>';toast('审核已拒绝（模拟）')},'<input class="field" placeholder="拒绝原因">');
  renderPhrasePage();
  renderPhraseAside();
  renderAll();
  renderContacts();
  bootstrapBackend();
