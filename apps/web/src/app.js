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
  const quickPhrases=structuredClone(window.CustomerServiceMock.quickPhrases);
  let phrasePageScope='个人',phraseAsideScope='个人',assistView='ai';
  let knowledgeTab='products',knowledgeLoaded=false,knowledgeLoading=false,knowledgeEditingId=null;
  let knowledgeScope=null,knowledgeEpoch=0;
  const knowledgeState={products:[],faqs:[],shortcuts:[]};
  let phraseMatches=[], phraseIndex=0, phraseRange=null, replyComposing=false;
  const groupChats = JSON.parse(JSON.stringify(window.CustomerServiceMock.groupChats));
  let currentId=1, selectedSuggestion=-1, originalSuggestion='', modalAction=null, currentSuggestions=suggestions, assistEnabled=true, presenceState='online';
  let contactCategory='team', activeGroupChatId=null;
  let conversationStatus='active';
  const profile={name:'陈小雨',phoneRaw:'13800002068',phoneMasked:'138****2068',avatarUrl:''};
  let backendSession=null,backendConnected=false,heartbeatTimer=null;
  let stopRealtime=null,refreshTimer=null,deliveryTimer=null,refreshRunning=false,refreshAgain=false,workspaceEpoch=0,workspaceStoreId='';
  let selectedCandidateId=null,selectedCandidateConversation=null;
  const remoteSuggestions=new Map();
  let profileAvatarObjectUrl='';
  const expandedContactGroups=new Set(['team:售前客服','buyers:重点客户']);
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
  // 单公司部署中，后端 platform_admin 与 merchant_admin 都是前端的公司管理员。
  // 前端不再把 platform_admin 降到只可见租户/审核页的“超级管理员”壳层。
  function frontendRoleOf(role){return role==='platform_admin'||role==='merchant_admin'?'merchant':'agent'}
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
    };
  }
  function backendMessageOf(message){
    const sourceLabels={manual_typed:'手打',direct_candidate:'直接采纳',edited_send:'编辑后发送',welcome:'欢迎语',offline_auto_reply:'离线回复',other:'其他'};
    return {
      id:message.id,
      direction:message.direction,
      by:message.direction==='outbound'?'agent':'customer',
      time:formatBackendTime(message.createdAt),
      text:message.content||`[${message.messageType||'消息'}]`,
      source:message.source?sourceLabels[message.source]||message.source:'',
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
    mapped.messages=(detail.messages||[]).map(backendMessageOf);
    mapped.preview=mapped.messages.at(-1)?.text||mapped.preview;
    mapped.canReply=detail.canReply;
    mapped.canTakeOver=detail.canTakeOver;
    for(const item of detail.deliveries||[]){
      const message=mapped.messages.find(row=>row.id===item.delivery.messageId);
      if(message)message.deliveryStatus=item.delivery.status;
    }
    conversations[index]=mapped;
    if(String(currentId)===String(id))renderAll();
  }
  async function loadRemoteConversations(){
    const epoch=workspaceEpoch;
    const storeId=workspaceStoreId;
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
    api.setWorkspaceTenant(entry.tenant.id);workspaceStoreId='';
    el('store-select').innerHTML='<option value="">公司全部门店</option>'+(entry.stores||[]).filter(store=>store.enabled!==false).map(store=>`<option value="${safe(store.id)}">${safe(store.name)}</option>`).join('');
    el('store-select').disabled=false;
    await loadRemoteConversations();
    if(epoch!==workspaceEpoch||!backendConnected)return;
    stopRealtime=window.KefuRealtime.subscribe(api,frame=>{
      if(epoch!==workspaceEpoch)return;
      if(frame.event_type==='realtime.ping')return;
      if(frame.event_type==='presence.changed'){
        if(frame.data.member_id===backendSession?.access?.member?.id)updatePresence({accepting:'online',busy:'suspended',away:'suspended',offline:'offline'}[frame.data.status]||'offline');
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
    profile.phoneRaw=account.phone||'';
    profile.phoneMasked=account.phone?`${account.phone.slice(0,3)}****${account.phone.slice(-4)}`:'未绑定';
    profile.avatarUrl=account.avatar_url||'';
    const mappedRole=frontendRoleOf(access.role);
    clearKnowledgeData();
    el('role-select').disabled=false;
    el('role-select').value=mappedRole;
    el('role-select').onchange();
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
      navigate('login');
    }
  }
  function showModal(title,text,action,extra='',confirmLabel='确认'){ el('modal-title').textContent=title; el('modal-text').textContent=text; el('modal-extra').innerHTML=extra; el('modal-confirm').textContent=confirmLabel; el('modal-confirm').disabled=false; modalAction=action; el('modal-bg').classList.add('show'); }
  function closeModal(){ el('modal-bg').classList.remove('show'); modalAction=null; }
  el('modal-cancel').onclick=closeModal;
  el('modal-bg').addEventListener('click',e=>{if(e.target===el('modal-bg'))closeModal()});
  el('modal-confirm').onclick=()=>{if(modalAction&&modalAction()===false)return;closeModal()};
  function role(){return el('role-select').value;}
  function safe(value){return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  function navigate(view){
    // 退出后，演示下拉框和旧 DOM 不能继续代表真实账号权限。
    if(!backendConnected&&!['login','account'].includes(view))view='login';
    window.ExportPortal?.leave();
    if(view==='exports')window.ExportPortal?.open();
    const restricted={workspace:['agent','merchant'],admin:['agent','merchant'],review:['platform','super'],tenants:['super'],products:['merchant'],knowledge:['agent','merchant'],phrases:['agent','merchant'],analytics:['merchant'],settings:['merchant']};
    if(restricted[view]&&!restricted[view].includes(role())){toast('当前演示角色无权访问此页面');return;}
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===view));
    el('workspace').classList.toggle('active',view==='workspace'); document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===view));
    el('account-role').textContent=el('role-select').selectedOptions[0].textContent;
    if(view==='admin')window.AdminPortal?.open();
    if(view==='phrases')renderPhrasePage();
    if(view==='knowledge')renderKnowledge();
  }
  document.querySelectorAll('.nav-item').forEach(x=>x.onclick=()=>navigate(x.dataset.view));
  document.querySelectorAll('[data-admin-permissions]').forEach(button=>button.onclick=()=>{
    navigate('admin');
    if(role()==='merchant')window.AdminPortal?.showPermissions(button.dataset.adminPermissions);
  });
  el('role-select').onchange=()=>{const r=role(); document.querySelectorAll('.nav-item').forEach(x=>{const v=x.dataset.view; x.style.display=r==='unauth'||(r==='agent'&&!['workspace','admin','knowledge','phrases','exports'].includes(v))||(r==='platform'&&v!=='review')||(r==='merchant'&&['review','tenants'].includes(v))||(r==='super'&&!['review','tenants'].includes(v))?'none':''}); closeProfileMenu();renderProfile();navigate(r==='platform'?'review':r==='super'?'tenants':r==='unauth'?'login':'workspace');};
  el('role-select').onchange();
  el('role-select').addEventListener('change',()=>{closeModal();window.AdminPortal?.refreshAccess()});
  function profileInitial(){return [...profile.name.trim()][0]||'客';}
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
  function openChangePassword(){
    closeProfileMenu();
    showModal('修改密码','提交前会在前端检查密码格式。正式修改需要接入账号服务。',()=>{
      const current=el('profile-current-password').value;
      const next=el('profile-new-password').value;
      const confirm=el('profile-confirm-password').value;
      const error=el('password-form-error');
      if(!current){error.textContent='请输入当前密码。';return false}
      if(next.length<8){error.textContent='新密码至少需要 8 个字符。';return false}
      if(next!==confirm){error.textContent='两次输入的新密码不一致。';return false}
      toast('密码格式已校验，等待接入账号服务');
    },'<div class="profile-form"><label for="profile-current-password">当前密码</label><input id="profile-current-password" class="field" type="password" autocomplete="current-password"><label for="profile-new-password">新密码</label><input id="profile-new-password" class="field" type="password" autocomplete="new-password"><label for="profile-confirm-password">确认新密码</label><input id="profile-confirm-password" class="field" type="password" autocomplete="new-password"><p class="profile-form-error" id="password-form-error" role="alert"></p></div>','确认修改');
    setTimeout(()=>el('profile-current-password').focus());
  }
  async function signOut(){
    closeProfileMenu();
    // 启动撤销请求时已经捕获令牌，界面立即清空，不等待网络响应。
    const revoke=backendConnected?api.logout():Promise.resolve();
    el('auth-submit').disabled=true;
    clearBackendSession();
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
    el('knowledge-form').reset();el('knowledge-list').innerHTML='';el('knowledge-count').textContent='—';
    el('knowledge-test-result').textContent='';el('knowledge-scope-note').textContent='请登录后查看知识库';
  }
  function clearBackendSession(){
    stopWorkspaceRealtime();clearInterval(heartbeatTimer);backendConnected=false;backendSession=null;api?.clearToken();
    clearKnowledgeData();conversations.splice(0);currentId=null;replyAttachments.clear();closeModal();
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
  el('profile-avatar-file').onchange=event=>{
    const file=event.target.files[0];
    if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('请选择 PNG、JPG 或 WebP 图片');event.target.value='';return}
    if(file.size>5*1024*1024){toast('头像文件不能超过 5MB');event.target.value='';return}
    if(profileAvatarObjectUrl)URL.revokeObjectURL(profileAvatarObjectUrl);
    profileAvatarObjectUrl=URL.createObjectURL(file);
    profile.avatarUrl=profileAvatarObjectUrl;
    renderProfile();
    closeProfileMenu();
    toast('头像已更新（本地演示）');
    event.target.value='';
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
  document.querySelectorAll('[data-auth]').forEach(x=>x.onclick=()=>{document.querySelectorAll('[data-auth]').forEach(t=>t.classList.toggle('active',t===x));const type=x.dataset.auth;el('auth-title').textContent=type==='register'?'创建账号':'欢迎回来';el('auth-secret').type=type==='password'?'password':'text';el('auth-secret').placeholder=type==='password'?'密码':type==='sms'?'短信验证码':'设置密码';el('auth-submit').textContent=type==='register'?'注册并进入账号中心':'登录';});
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
      setAuthStatus(error.message||'登录失败','error');
      setBackendStatus('登录失败','error');
    }finally{el('auth-submit').disabled=false}
  };
  el('auth-secret').addEventListener('keydown',event=>{if(event.key==='Enter')el('auth-submit').click()});
  function activeConversation(){return conversations.find(x=>String(x.id)===String(currentId))}
  // GET /api/v1/conversations: list by tenant, authorized store and status.
  // Reconcile missed WebSocket/SSE events with cursor-based REST pagination.
  function renderConversations(){
    const filter=el('conversation-search').value.trim(); const list=conversations.filter(x=>x.status===conversationStatus&&(!filter||x.name.includes(filter)||x.preview.includes(filter)));
    if(conversationStatus==='ended')list.sort((a,b)=>(b.endedAt||0)-(a.endedAt||0));
    el('queue-count').textContent=list.length; el('queue-caption').textContent=conversationStatus==='ended'?'已结束 · 聊天记录可查看':'系统已分配 · 处理中';
    el('active-conversation-count').textContent=conversations.filter(c=>c.status==='active').length;
    el('processing-count').textContent=conversations.filter(c=>c.status==='active').length;
    el('ended-count').textContent=conversations.filter(c=>c.status==='ended').length;
    document.querySelectorAll('[data-conversation-status]').forEach(button=>{
      const selected=button.dataset.conversationStatus===conversationStatus;
      button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));
    });
    el('conversations').innerHTML=list.length?list.map(c=>`<div class="conversation ${String(c.id)===String(currentId)?'active':''}" data-id="${safe(c.id)}"><div class="avatar">${safe(c.initial)}</div><div><div class="conversation-top"><span class="conversation-name">${safe(c.name)}</span><span class="time">${safe(c.time)}</span></div><div class="preview">${safe(c.preview)}</div><div class="conv-foot"><span class="store-chip">${safe(c.store)}</span><span class="pill ${c.status==='ended'?'gray':'blue'}">${c.status==='ended'?'已结束':'接待中'}</span></div></div></div>`).join(''):'<div class="empty">当前没有会话</div>';
    document.querySelectorAll('.conversation').forEach(x=>x.onclick=async()=>{currentId=conversations.find(item=>String(item.id)===x.dataset.id)?.id??x.dataset.id;showCustomerConversation();renderAll();if(backendConnected)try{await loadConversationDetail(currentId)}catch(error){toast(error.message)}});
  }
  function showCustomerConversation(){
    el('customer-chat-view').hidden=false;
    el('customer-assist').hidden=false;
    el('group-chat-view').hidden=true;
    el('group-chat-aside').hidden=true;
  }
  function showGroupChat(id){
    activeGroupChatId=id;
    el('customer-chat-view').hidden=true;
    el('customer-assist').hidden=true;
    el('group-chat-view').hidden=false;
    el('group-chat-aside').hidden=false;
    renderGroupChat();
    renderContacts();
  }
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
      if(contactCategory==='groupChats'&&activeGroupChatId)showGroupChat(activeGroupChatId);
      else renderContacts();
    }else{
      if(activeConversation()?.status!==conversationStatus)currentId=conversations.find(c=>c.status===conversationStatus)?.id??null;
      showCustomerConversation();
      renderAll();
    }
  }
  // TODO(API): Internal groups require tenant-scoped membership, history and
  // real-time events. They must never use the external customer send endpoint.
  function renderGroupChat(){
    const group=groupChats.find(item=>item.id===activeGroupChatId);
    if(!group)return;
    el('group-chat-title').textContent=group.name;
    el('group-chat-subtitle').textContent=`${group.detail} · ${group.members.length} 位成员`;
    el('group-chat-member-count').textContent=`${group.members.length} 人`;
    el('group-chat-members').innerHTML=group.members.map(name=>`<div class="group-member"><span class="avatar">${safe(name.slice(0,1))}</span><span><strong>${safe(name)}</strong><small>${name==='陈小雨'?'我 · 客服':'团队成员'}</small></span></div>`).join('');
    el('group-chat-messages').innerHTML='<div class="day">今天 · 内部协作</div>'+(group.messages.length?group.messages.map(message=>`<div class="message ${message.sender==='陈小雨'?'agent':''}"><div class="avatar">${safe(message.sender.slice(0,1))}</div><div class="message-content"><div class="message-meta">${safe(message.sender)} · ${safe(message.time)}</div><div class="bubble"></div></div></div>`).join(''):'<div class="empty">群聊已创建，发送第一条消息开始协作。</div>');
    el('group-chat-messages').querySelectorAll('.bubble').forEach((bubble,index)=>bubble.textContent=group.messages[index].text);
    el('group-chat-messages').scrollTop=el('group-chat-messages').scrollHeight;
  }
  // TODO(API): Fetch team and buyer directories by tenant and authorized store.
  // Group membership must be stored server-side; these mutable arrays are demo data.
  function renderContacts(){
    const category=contactCategory;
    const term=el('contact-search').value.trim();
    el('add-contact-group').textContent=category==='groupChats'?'＋ 新建群聊':'＋ 新建分组';
    el('contact-search').placeholder=category==='groupChats'?'搜索群聊或成员':'搜索姓名或分组';
    el('add-contact-group').hidden=category==='blacklist';
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
    const groups=contactGroups[category];
    const members=contacts[category];
    const visibleGroups=groups.filter(group=>group.includes(term)||members.some(person=>person.group===group&&(person.name.includes(term)||person.detail.includes(term))));
    el('contacts-list').innerHTML=visibleGroups.length?visibleGroups.map(group=>{
      const grouped=members.filter(person=>person.group===group);
      const visible=term&&!group.includes(term)?grouped.filter(person=>person.name.includes(term)||person.detail.includes(term)):grouped;
      const key=category+':'+group;
      const open=Boolean(term)||expandedContactGroups.has(key);
      return `<section class="contact-group"><button class="contact-group-toggle" type="button" data-group="${safe(group)}" aria-expanded="${open}"><span class="contact-group-arrow">▶</span>${safe(group)}<span class="contact-group-count">${grouped.length}</span></button><div class="contact-group-body" ${open?'':'hidden'}>${visible.length?visible.map(person=>`<div class="contact-entry"><button class="contact-entry-main" type="button" data-contact-id="${safe(person.id)}"><span class="avatar">${safe(person.initial)}</span><span class="contact-entry-text"><span class="contact-entry-name">${safe(person.name)}</span><span class="contact-entry-detail">${safe(person.detail)}</span></span></button><button class="contact-more" type="button" data-contact-more="${safe(person.id)}" aria-label="管理 ${safe(person.name)} 的分组">⋯</button></div>`).join(''):'<div class="contact-empty">暂无联系人</div>'}</div></section>`;
    }).join(''):'<div class="contact-empty">没有找到匹配的联系人或分组</div>';
    document.querySelectorAll('.contact-group-toggle').forEach(button=>button.onclick=()=>{
      const key=category+':'+button.dataset.group;
      if(expandedContactGroups.has(key))expandedContactGroups.delete(key);else expandedContactGroups.add(key);
      renderContacts();
    });
    document.querySelectorAll('[data-contact-id]').forEach(button=>button.onclick=()=>{
      const person=members.find(item=>item.id===button.dataset.contactId);
      if(category==='buyers'&&person.conversationId){
        const conversation=conversations.find(item=>item.id===person.conversationId);
        currentId=conversation.id;
        conversationStatus=conversation.status;
        setQueueMode('conversations');
        renderAll();
      }else openContactEditor(person);
    });
    document.querySelectorAll('[data-contact-more]').forEach(button=>button.onclick=()=>{
      openContactEditor(members.find(item=>item.id===button.dataset.contactMore));
    });
  }
  function openContactEditor(person){
    const options=contactGroups[contactCategory].map(group=>`<option value="${safe(group)}" ${group===person.group?'selected':''}>${safe(group)}</option>`).join('');
    showModal(person.name+' · 联系人分组',person.detail,()=>{
      const nextGroup=el('contact-target-group').value;
      person.group=nextGroup;
      expandedContactGroups.add(contactCategory+':'+nextGroup);
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
    el('conversation-ended-note').hidden=!c||c.status!=='ended';
    if(!el('group-chat-view').hidden)el('customer-assist').hidden=true;
    else el('customer-assist').hidden=!c;
    if(!c){el('messages').innerHTML='';el('send-btn').disabled=true;return}
    const storeLabel=backendConnected?c.store:`青禾生活${c.store}`;
    el('chat-name').innerHTML=`${safe(c.name)} <span class="pill ${c.status==='ended'?'gray':'blue'}" id="chat-status">${c.status==='ended'?'已结束':'接待中'}</span>`; el('chat-subtitle').textContent=`企业微信客服 · ${storeLabel} · ${c.status==='ended'?'会话已结束':c.canReply===false?'只读会话':'接待人 '+profile.name}`;
    const deliveryLabels={pending:'等待渠道发送',sent:'渠道已发送',failed:'渠道发送失败',unknown:'渠道结果未知'};
    el('messages').innerHTML='<div class="day">会话记录</div>'+c.messages.map(m=>`<div class="message ${m.by==='agent'?'agent':''}"><div class="avatar">${m.by==='agent'?safe(profileInitial()):safe(c.initial)}</div><div class="message-content"><div class="message-meta">${m.by==='agent'?safe(profile.name):safe(c.name)} · ${m.time}${m.source?' · '+safe(m.source):''}${m.deliveryStatus?' · '+safe(deliveryLabels[m.deliveryStatus]||m.deliveryStatus):''}</div><div class="bubble"></div></div></div>`).join('');
    el('messages').querySelectorAll('.message .bubble').forEach((x,i)=>x.textContent=c.messages[i].text);
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
    el('transfer-btn').hidden=c.status==='ended'||backendConnected&&(c.rawStatus!=='claimed'||c.canReply!==true&&!c.canTakeOver);
    el('assignment-history-btn').hidden=!backendConnected;
    el('close-btn').hidden=c.status==='ended'||backendConnected&&c.canReply!==true&&!c.canTakeOver;
  }
  // Candidate response source is returned asynchronously after message intake.
  // Preserve candidate ID, source chunks, score and degradation reason in the API.
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
    el('candidates').innerHTML=currentSuggestions.length?currentSuggestions.map((s,i)=>`<div class="candidate"><div class="candidate-top"><span class="candidate-title">${i+1}. ${safe(s.title)}</span><span class="pill ${i===0?'blue':'gray'}">${i===0?'优先':'备选'}</span></div><p>${safe(s.text)}</p><div class="candidate-bottom"><span class="source" title="${safe(s.source)}">${safe(s.source)}</span><button class="use-btn" data-index="${i}">选用 ↗</button></div></div>`).join(''):'<div class="footnote">知识库未命中可靠内容，请客服手动回复或使用快捷短语。</div>';
    document.querySelectorAll('.use-btn').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.index);el('reply').value=currentSuggestions[i].text;selectedSuggestion=i;originalSuggestion=currentSuggestions[i].text;el('reply-hint').textContent='已选用第 '+(i+1)+' 条候选 · 可编辑后发送';el('reply').focus();toast('候选回复已填入编辑区')});
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
  function renderOverviewMetrics(){
    el('today-served').textContent=conversations.filter(c=>c.time!=='昨天').length;
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
    if(contactCategory==='groupChats'&&activeGroupChatId)showGroupChat(activeGroupChatId);
    else{showCustomerConversation();renderContacts();}
  });
  el('contact-search').oninput=renderContacts;
  el('add-contact-group').onclick=()=>{
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
      renderContacts();
      toast('已创建分组「'+name+'」（模拟）');
    },'<input id="new-contact-group-name" class="field" maxlength="24" placeholder="例如：售前客服">');
  };
  function sendGroupMessage(){
    const group=groupChats.find(item=>item.id===activeGroupChatId);
    const text=el('group-chat-reply').value.trim();
    if(!group)return;
    if(!text){toast('请输入群消息');return}
    group.messages.push({sender:'陈小雨',time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),text});
    el('group-chat-reply').value='';
    renderGroupChat();
    renderContacts();
    toast('群消息已加入本地演示');
  }
  el('group-chat-send').onclick=sendGroupMessage;
  el('group-chat-reply').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendGroupMessage()}});
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
      if(attachment){toast('首轮整合尚未开放真实附件发送，请先发送文字');return}
      if(!text){toast('请输入回复内容');return}
      const backendSource=selectedSuggestion<0?'manual_typed':text===originalSuggestion?'direct_candidate':'edited_send';
      el('send-btn').disabled=true;
      try{
        const candidateId=selectedSuggestion>=0&&String(selectedCandidateConversation)===String(c.id)?selectedCandidateId:null;
        await api.sendMessage(c.backendId,text,candidateId?backendSource:'manual_typed',candidateId);
        if(String(currentId)===String(c.id)&&el('reply').value.trim()===text){
          el('reply').value='';selectedSuggestion=-1;originalSuggestion='';selectedCandidateId=null;selectedCandidateConversation=null;
          el('reply-hint').textContent='Enter 发送 · Shift+Enter 换行';
        }
        await loadRemoteConversations();
        toast('消息已写入后端发送队列');
      }catch(error){toast(error.message||'消息发送失败')}
      finally{renderMessages()}
      return;
    }
    if(Number(el('budget').textContent)<=0){toast('当前外发额度已用完，请等待客户再次发来消息');return}
    const source=selectedSuggestion<0?'手打':text===originalSuggestion?'直接采纳':'编辑后发送';
    c.messages.push({by:'agent',time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),text,source,attachment});
    replyAttachments.delete(currentId);
    c.preview=text||`[${{image:'图片',video:'视频',file:'文件'}[attachment.kind]}]`;
    c.time='刚刚';el('reply').value='';selectedSuggestion=-1;originalSuggestion='';el('reply-hint').textContent='Enter 发送 · Shift+Enter 换行';
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
  // TODO(API): 用有权限的启用短语做联想；异步检索需丢弃已过期的关键词响应。
  function updatePhraseSuggestions(){
    const reply=el('reply');
    if(replyComposing||document.activeElement!==reply||reply.selectionStart!==reply.selectionEnd){closePhraseSuggestions();return}
    const before=reply.value.slice(0,reply.selectionStart);
    const token=before.match(/[^\s，。！？、；：,.!?;:]+$/)?.[0]||'';
    if(!token||token.length>30){closePhraseSuggestions();return}
    const query=token.toLowerCase();
    phraseMatches=quickPhrases.filter(phrase=>phrase.enabled!==false&&[phrase.title,phrase.text,...(phrase.keywords||[])].some(value=>value.toLowerCase().includes(query)))
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
    selectedSuggestion=-1;originalSuggestion='';
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
  function phraseCategory(phrase){
    if(phrase.category)return phrase.category;
    if(/视频|安装/.test(phrase.title))return '使用教程';
    if(/物流|发货/.test(phrase.title))return '物流';
    if(/规格|商品/.test(phrase.title))return '商品咨询';
    if(/售后/.test(phrase.title))return '售后';
    return '常用回复';
  }
  function canManagePhrase(phrase){return phrase.scope==='个人'||role()==='merchant'}
  function insertPhrase(phrase){
    if(!activeConversation()||activeConversation().status!=='active'){
      toast('请先选择处理中的会话');return;
    }
    insertReplyText(phrase.text);
    closePhraseSuggestions();
    selectedSuggestion=-1;originalSuggestion='';
    phrase.useCount=(phrase.useCount||0)+1;
    el('reply-hint').textContent=`已插入${phrase.scope}短语 · 可编辑后发送`;
    renderPhrasePage();renderPhraseAside();
    toast(`${phrase.scope}短语已填入回复框`);
  }
  function renderPhrasePage(){
    const scope=phrasePageScope,manageable=scope==='个人'||role()==='merchant';
    const scoped=quickPhrases.filter(phrase=>phrase.scope===scope);
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
    el('phrase-rows').querySelectorAll('[data-phrase-edit]').forEach(button=>button.onclick=()=>openPhraseEditor(quickPhrases.find(phrase=>phrase.id===button.dataset.phraseEdit)));
    el('phrase-rows').querySelectorAll('[data-phrase-toggle]').forEach(button=>button.onclick=()=>{
      const phrase=quickPhrases.find(item=>item.id===button.dataset.phraseToggle);
      if(!phrase||!canManagePhrase(phrase))return;
      phrase.enabled=phrase.enabled===false;
      renderPhrasePage();renderPhraseAside();closePhraseSuggestions();
      toast(`${phrase.title}已${phrase.enabled?'启用':'停用'}（本地演示）`);
    });
  }
  function renderPhraseAside(){
    const scope=phraseAsideScope,query=el('phrase-aside-search').value.trim().toLowerCase();
    const shown=quickPhrases.filter(phrase=>phrase.scope===scope&&phrase.enabled!==false&&(!query||[phrase.title,phrase.text,...(phrase.keywords||[])].some(value=>value.toLowerCase().includes(query))));
    const grouped=new Map();shown.forEach(phrase=>{const category=phraseCategory(phrase);if(!grouped.has(category))grouped.set(category,[]);grouped.get(category).push(phrase)});
    el('phrase-aside-list').innerHTML=grouped.size?[...grouped].map(([category,items])=>`<details open><summary>${safe(category)} · ${items.length}</summary>${items.map(phrase=>`<button class="phrase-aside-item" type="button" data-phrase-insert="${safe(phrase.id)}" title="${safe(phrase.text)}"><strong>${safe(phrase.title)}</strong><span>${safe(phrase.text)}</span></button>`).join('')}</details>`).join(''):'<div class="empty">暂无匹配短语，可新增个人短语。</div>';
    document.querySelectorAll('[data-phrase-aside-scope]').forEach(button=>{const active=button.dataset.phraseAsideScope===scope;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});
    el('phrase-aside-add').hidden=scope==='团队'&&role()!=='merchant';
    el('phrase-aside-list').querySelectorAll('[data-phrase-insert]').forEach(button=>button.onclick=()=>insertPhrase(quickPhrases.find(phrase=>phrase.id===button.dataset.phraseInsert)));
  }
  // TODO(API): 团队短语按租户授权读取，个人短语按登录员工隔离；写入需版本与权限校验。
  function openPhraseEditor(phrase=null,scope=phrase?.scope||phrasePageScope){
    if(phrase&&!canManagePhrase(phrase)||scope==='团队'&&role()!=='merchant'){
      toast('暂无权限修改团队短语');return;
    }
    const fields=`<div class="phrase-form"><label class="setting-title" for="phrase-title-field">标题</label><input id="phrase-title-field" class="field" maxlength="60" value="${safe(phrase?.title||'')}" placeholder="例如：发货说明"><label class="setting-title" for="phrase-category-field">分类</label><input id="phrase-category-field" class="field" maxlength="30" value="${safe(phrase?phraseCategory(phrase):'')}" placeholder="例如：售后"><label class="setting-title" for="phrase-keywords-field">关键词（用逗号分隔）</label><input id="phrase-keywords-field" class="field" value="${safe(phrase?.keywords?.join('，')||'')}" placeholder="例如：视频，安装"><label class="setting-title" for="phrase-text-field">回复内容</label><textarea id="phrase-text-field" class="field" maxlength="2000" placeholder="输入短语内容">${safe(phrase?.text||'')}</textarea><p id="phrase-form-error" class="phrase-form-error" role="alert"></p></div>`;
    showModal(`${phrase?'编辑':'新建'}${scope}短语`,scope==='个人'?'个人短语只有自己可见。':'团队短语对企业成员开放。',()=>{
      const title=el('phrase-title-field').value.trim(),text=el('phrase-text-field').value.trim(),category=el('phrase-category-field').value.trim()||'未分类';
      if(!title||!text){el('phrase-form-error').textContent='请填写标题和回复内容';return false}
      const keywords=el('phrase-keywords-field').value.split(/[，,]/).map(item=>item.trim()).filter(Boolean);
      if(phrase)Object.assign(phrase,{title,text,category,keywords});
      else quickPhrases.unshift({id:`phrase-local-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,scope,ownerId:scope==='个人'?'demo-agent':null,title,text,category,keywords,enabled:true,useCount:0});
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
    const available=quickPhrases.filter(phrase=>phrase.enabled!==false);
    const options=['个人','团队'].map(scope=>`<optgroup label="${scope}">${available.filter(phrase=>phrase.scope===scope).map(phrase=>`<option value="${safe(phrase.id)}">${safe(phrase.title)} · ${safe(phraseCategory(phrase))}</option>`).join('')}</optgroup>`).join('');
    showModal('插入快捷短语','选择个人或团队短语，填入后仍可编辑。',()=>{
      const phrase=quickPhrases.find(item=>item.id===el('shortcut-choice').value);
      if(phrase)insertPhrase(phrase);
    },`<select id="shortcut-choice" class="field">${options}</select><p class="footnote">可在右侧“快捷短语”中搜索、分组查看与管理。</p>`,'插入草稿');
  };
  el('product-btn').onclick=el('insert-link').onclick=()=>{el('reply').value+=(el('reply').value?'\n':'')+'商品详情：https://shop.example.com/products/thermos-500';el('reply').focus();toast('已插入示例商品链接')};
  function insertReplyText(text){
    const reply=el('reply');
    reply.setRangeText(text,reply.selectionStart,reply.selectionEnd,'end');
    reply.dispatchEvent(new Event('input'));
    reply.focus();
  }
  const emojiOptions=['😊','😄','😉','🥰','👍','👌','🙏','🤝','❤️','🎉','🌹','☕'];
  el('emoji-picker').innerHTML=emojiOptions.map(emoji=>`<button type="button" aria-label="插入表情 ${emoji}">${emoji}</button>`).join('');
  function closeEmoji(){el('emoji-picker').hidden=true;el('emoji-btn').setAttribute('aria-expanded','false')}
  el('emoji-btn').onclick=()=>{const open=el('emoji-picker').hidden;el('emoji-picker').hidden=!open;el('emoji-btn').setAttribute('aria-expanded',String(open))};
  el('emoji-picker').querySelectorAll('button').forEach(button=>button.onclick=()=>{insertReplyText(button.textContent);closeEmoji()});
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
    el('reply-attachment-name').textContent=attachment?`${{image:'图片',video:'视频',file:'文件'}[attachment.kind]}：${attachment.name}`:'';
  }
  // TODO(API): 正式发送前上传媒体并取得媒体 ID；服务端和渠道共同校验文件类型、大小与可发送状态。
  function attachReplyFile(file,kind,conversationId=currentId){
    if(!file)return;
    if(kind==='image'&&!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)){toast('请选择 PNG、JPEG、WebP 或 GIF 图片');return}
    if(kind==='video'&&!file.type.startsWith('video/')){toast('请选择视频文件');return}
    const limit=kind==='image'?5:kind==='video'?50:20;
    if(file.size>limit*1024*1024){toast(`请选择小于 ${limit} MB 的${{image:'图片',video:'视频',file:'文件'}[kind]}`);return}
    const previous=replyAttachments.get(conversationId);
    if(previous)URL.revokeObjectURL(previous.url);
    replyAttachments.set(conversationId,{kind,name:file.name,url:URL.createObjectURL(file)});
    if(conversationId===currentId)renderAttachment();
    toast(`${{image:'图片',video:'视频',file:'文件'}[kind]}已加入草稿，确认后点击发送`);
  }
  el('image-btn').onclick=()=>el('reply-image-file').click();
  el('video-btn').onclick=()=>el('reply-video-file').click();
  el('file-btn').onclick=()=>el('reply-document-file').click();
  [['reply-image-file','image'],['reply-video-file','video'],['reply-document-file','file']].forEach(([id,kind])=>{
    el(id).onchange=event=>{attachReplyFile(event.target.files[0],kind);event.target.value=''};
  });
  el('remove-attachment').onclick=()=>{
    const attachment=replyAttachments.get(currentId);
    if(attachment)URL.revokeObjectURL(attachment.url);
    replyAttachments.delete(currentId);renderAttachment();
  };
  function pasteReplyImage(event){
    const file=[...(event.clipboardData?.files||[])].find(item=>item.type.startsWith('image/'));
    if(file){event.preventDefault();attachReplyFile(file,'image');if(event.target.id==='screenshot-paste')closeModal()}
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
      showModal('候选来源与检索依据',`生成方式：${set.provider==='deepseek'?'模型生成':'知识库检索'}；${(set.fallbackReasons||[]).map(candidateReason).join('；')||'无降级'}。`,()=>{},`<div class="assignment-history">${set.candidates.map(item=>`<div class="review-card"><strong>${safe(item.title)}</strong><p>${safe(item.content)}</p><small>来源：${safe(item.kind)} / ${safe(item.sourceId)} · 评分 ${safe(item.score)}<br>公司 ${safe(item.tenantId)} · 门店 ${safe(item.storeId)}</small></div>`).join('')||'暂无候选'}</div>`,'关闭');
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
    el('knowledge-list').innerHTML=shown.length?`<div class="knowledge-table-wrap"><table class="table knowledge-table"><thead><tr>${headings.map(value=>`<th>${value}</th>`).join('')}</tr></thead><tbody>${shown.map(item=>knowledgeRow(item,canWriteKnowledge())).join('')}</tbody></table></div>`:'<div class="empty">当前条件下没有知识条目</div>';
    el('knowledge-list').querySelectorAll('[data-knowledge-open]').forEach(button=>button.onclick=()=>openKnowledgeItem(button.dataset.knowledgeOpen));
    el('knowledge-list').querySelectorAll('[data-knowledge-toggle]').forEach(button=>button.onclick=()=>toggleKnowledgeItem(button.dataset.knowledgeToggle,button));
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
  async function ensureKnowledgeScope(){
    if(knowledgeScope)return knowledgeScope;
    const epoch=knowledgeEpoch,session=backendSession;
    const directories=await api.directoryTenants();
    if(epoch!==knowledgeEpoch||session!==backendSession||!backendConnected)throw new Error('登录状态已变化，请重新进入知识库');
    const accessTenant=backendSession?.access?.tenantId||backendSession?.access?.member?.tenantId;
    const entry=(directories||[]).find(item=>item.tenant.id===accessTenant)||(directories||[]).find(item=>item.tenant.enabled!==false)||(directories||[])[0];
    if(!entry)throw new Error('当前账号没有可访问的公司知识库');
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
    el('knowledge-import').hidden=!editable||knowledgeTab!=='products';
    el('knowledge-download-template').hidden=!editable||knowledgeTab!=='products';
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
      const items=knowledgeState[tab],index=items.findIndex(entry=>entry.id===item.id);items.splice(index,1,updated);
      if(tab===knowledgeTab){if(knowledgeEditingId===item.id)fillKnowledgeForm(updated);else renderKnowledgeList()}
      toast(`${knowledgeMeta[tab].singular}已${updated.enabled?'启用':'停用'}`);
    }catch(error){toast(error.message||'状态更新失败')}finally{button.disabled=false}
  }
  function downloadKnowledgeTemplate(){
    const csv='\ufeff商品编码,标题,SKU 编码\r\nDEMO-001,示例商品,DEMO-001-BLACK\r\n';
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='商品导入模板.csv';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),0);toast('商品导入模板已下载');
  }
  async function previewKnowledgeImport(file){
    if(!canWriteKnowledge()||!file)return;
    if(!/\.(csv|xlsx)$/i.test(file.name)){toast('仅支持 CSV 或 XLSX 文件');return}
    try{
      toast('正在检查导入文件…');
      const scope=await ensureKnowledgeScope();
      if(!scope.storeId)throw new Error('公司下没有可用门店，无法导入');
      const preview=await api.previewKnowledgeImport(scope.tenantId,scope.storeId,file),summary=preview.summary;
      const issues=(preview.issues||[]).slice(0,6);
      const extra=`<div class="knowledge-import-summary"><div><strong>${summary.totalRows}</strong><span>文件数据行</span></div><div><strong>${summary.previewRowCount}</strong><span>可导入行</span></div><div><strong>${summary.failedRowCount}</strong><span>需修复行</span></div></div>${issues.length?`<div class="knowledge-import-issues">${issues.map(issue=>`第 ${issue.rowNumber||'—'} 行：${safe(issue.message)}`).join('<br>')}</div>`:'<div class="footnote">文件检查通过，没有发现阻塞问题。</div>'}`;
      showModal('确认批量导入',`文件：${file.name}。导入会写入 ${scope.storeName||'默认门店'}，有问题的行不会写入。`,()=>{void applyKnowledgeImport(file);},extra,`导入 ${summary.previewRowCount} 行`);
    }catch(error){toast([error.message,...(error.details||[])].filter(Boolean).join('；')||'导入文件检查失败')}
    finally{el('knowledge-file-input').value=''}
  }
  async function applyKnowledgeImport(file){
    try{
      const scope=await ensureKnowledgeScope();
      const receipt=await api.applyKnowledgeImport(scope.tenantId,scope.storeId,file),summary=receipt.summary;
      toast(`导入完成：成功 ${summary.successRows} 行，新增 ${summary.createdSpuCount} 个商品，失败 ${summary.rejectedRowCount+summary.unreadableRowCount} 行`);
      await loadKnowledgeData(true);
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
  el('knowledge-import').onclick=()=>el('knowledge-file-input').click();
  el('knowledge-file-input').onchange=event=>void previewKnowledgeImport(event.target.files[0]);
  el('knowledge-test').onclick=testKnowledge;
  el('knowledge-test-question').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();testKnowledge()}};
  // Product import: upload Excel/CSV, then poll an asynchronous cleaning/index job.
  el('import-products').onclick=()=>showModal('导入商品','选择 Excel 或 CSV 文件后，系统会检查字段并异步建立索引。本原型只展示界面流程。',()=>toast('已创建演示导入任务'),'<input class="field" type="file" accept=".xlsx,.xls,.csv">');
  el('download-template').onclick=()=>toast('导入模板将在正式版本提供');
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
