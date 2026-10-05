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
  let knowledgeScope=null;
  const knowledgeState={products:[],faqs:[],shortcuts:[]};
  let phraseMatches=[], phraseIndex=0, phraseRange=null, replyComposing=false;
  // 登录方式与密码显隐：navigate() 在初始化早期就会走到登录页，所以这两个状态和其他
  // 顶层状态放在一起声明，避免被后面的 let 声明挡住（TDZ）。
  let authMode='password',secretRevealed=false;
  const groupChats = JSON.parse(JSON.stringify(window.CustomerServiceMock.groupChats));
  // 同事一对一内部会话：按联系人 id 归类，和客户会话、群聊分开保存，避免误发。
  const directThreads=new Map(Object.entries(JSON.parse(JSON.stringify(window.CustomerServiceMock.directThreads||{}))));
  let currentId=1, selectedSuggestion=-1, originalSuggestion='', modalAction=null, currentSuggestions=suggestions, assistEnabled=true, presenceState='online';
  // 真实会话的候选来自服务端一次算完的 set（POST /retrieval/suggestions）。这几个变量只记
  // 「哪个会话的、哪一次请求的」结果，候选本身不在这里拼：意图、检索和降级原因都是服务端的
  // 事实，浏览器复刻一遍就会两边漂移。
  let suggestionSet=null, suggestionFor=null, suggestionLoading=false, suggestionError='', suggestionRequestId=0, selectedCandidateId='';
  let contactCategory='team', activeGroupChatId=null, activeDirectId=null;
  let conversationStatus='active';
  const profile={name:'陈小雨',phoneRaw:'13800002068',phoneMasked:'138****2068',avatarUrl:''};
  let backendSession=null,backendConnected=false,heartbeatTimer=null;
  // 登录后服务端下发的本人成员 ID：用于判断某条会话是不是自己在接待（能转移的对象），
  // 与角色无关，也不参与鉴权，只决定按钮显不显示。
  let selfMemberId=null;
  // 首帧的默认路由由初始化流程自己走完，不弹“请先登录”提示；此后才算用户操作。
  let booted=false;
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
  function backendConversationOf(row,previous){
    const name=row.title||row.externalCustomerId||'未命名客户';
    return {
      id:row.id,
      backendId:row.id,
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
  function backendMessageOf(message){
    const sourceLabels={manual_typed:'手打',direct_candidate:'直接采纳',edited_send:'编辑后发送',welcome:'欢迎语',offline_auto_reply:'离线回复',other:'其他'};
    return {
      id:message.id,
      by:message.direction==='outbound'?'agent':'customer',
      time:formatBackendTime(message.createdAt),
      text:message.content||`[${message.messageType||'消息'}]`,
      source:message.source?sourceLabels[message.source]||message.source:'',
    };
  }
  async function loadConversationDetail(id){
    if(!backendConnected||!id)return;
    const detail=await api.conversation(id);
    const index=conversations.findIndex(item=>String(item.id)===String(id));
    if(index<0)return;
    const mapped=backendConversationOf(detail.conversation,conversations[index]);
    mapped.messages=(detail.messages||[]).map(backendMessageOf);
    mapped.preview=mapped.messages.at(-1)?.text||mapped.preview;
    mapped.canReply=detail.canReply;
    mapped.canTakeOver=detail.canTakeOver;
    // 服务端算好的回复窗口（截止时间 + 剩余额度）。列表接口不带它，只有详情有，
    // 所以这里跟着详情一起落到会话上，renderMessages 直接渲染。
    mapped.replyWindow=detail.replyWindow;
    conversations[index]=mapped;
    currentId=mapped.id;
    renderAll();
  }
  async function loadRemoteConversations(){
    const rows=await api.conversations();
    const previous=new Map(conversations.map(item=>[String(item.id),item]));
    const mapped=(rows||[]).map(row=>backendConversationOf(row,previous.get(String(row.id))));
    conversations.splice(0,conversations.length,...mapped);
    const selected=conversations.find(item=>String(item.id)===String(currentId));
    currentId=(selected||conversations.find(item=>item.status==='active')||conversations[0])?.id??null;
    conversationStatus=conversations.find(item=>String(item.id)===String(currentId))?.status||'active';
    renderAll();
    if(currentId!==null)await loadConversationDetail(currentId);
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
    knowledgeLoaded=false;knowledgeScope=null;knowledgeEditingId=null;
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
      try{
        await api.health();
        setBackendStatus('业务后端已就绪 · 请登录','connected');
        setAuthStatus('请输入后端账号和密码');
      }catch(error){
        setBackendStatus('业务后端尚未就绪','error');
        setAuthStatus(error.message||'无法连接业务后端','error');
      }
      applyAccessLock();
      navigate('login');
      return;
    }
    try{
      const session=await api.currentSession();
      applyBackendSession(session);
      if(session.access?.role==='agent'){
        await api.presence('accepting');
        updatePresence('online');
        await loadRemoteConversations();
        navigate('workspace');
        clearInterval(heartbeatTimer);
        heartbeatTimer=setInterval(()=>api.heartbeat().catch(()=>{}),25000);
      }else{
        navigate(session.access?.role==='platform_admin'||session.access?.role==='merchant_admin'?'admin':'account');
      }
    }catch(error){
      backendConnected=false;
      api.clearToken();
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
    const restricted={workspace:['agent','merchant'],admin:['agent','merchant'],review:['platform','super'],tenants:['super'],products:['merchant'],knowledge:['agent','merchant'],phrases:['agent','merchant'],analytics:['merchant'],settings:['merchant']};
    if(restricted[view]&&!restricted[view].includes(role())){toast('当前演示角色无权访问此页面');return;}
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===view));
    el('workspace').classList.toggle('active',view==='workspace'); document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===view));
    // 切回登录页时把密码收回明文并清空按钮状态：上一次会话留下的“已显示”不该带到下一次登录。
    if(view==='login'&&!wasOnLogin){secretRevealed=false;syncSecretField()}
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
  el('role-select').onchange=()=>{const r=role(); document.querySelectorAll('.nav-item').forEach(x=>{const v=x.dataset.view; x.style.display=(r==='agent'&&!['workspace','admin','knowledge','phrases'].includes(v))||(r==='platform'&&v!=='review')||(r==='merchant'&&['review','tenants'].includes(v))||(r==='super'&&!['review','tenants'].includes(v))?'none':''}); closeProfileMenu();renderProfile();navigate(r==='platform'?'review':r==='super'?'tenants':'workspace');toast('已切换演示角色：'+el('role-select').selectedOptions[0].textContent);};
  el('role-select').onchange();
  // 初始化完成时还没有后端会话，先锁住界面入口；登录成功后由
  // applyBackendSession 解锁。
  applyAccessLock();
  booted=true;
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
    clearInterval(heartbeatTimer);
    if(backendConnected){
      try{await api.logout()}catch(error){console.warn('退出后端会话失败',error)}
    }
    backendConnected=false;backendSession=null;
    // 退出时清掉密码框：显隐按钮是常驻的，留在框里的密码一次点击就能看到。
    // 只在退出这一刻清（不在 navigate 里清），避免误点导航把正在输入的密码清空。
    el('auth-secret').value='';
    applyAccessLock();
    setBackendStatus('已退出 · 请重新登录');
    setAuthStatus('已退出当前账号');
    navigate('login');
    toast('已退出账号');
  }
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
  function showDirectChat(personId){
    const person=contacts.team.find(item=>item.id===personId);
    if(!person)return;
    activeDirectId=personId;
    activeGroupChatId=null;
    openInternalChat();
  }
  function activeContact(){return contacts.team.find(item=>item.id===activeDirectId)||null;}
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
      else if(contactCategory==='team'&&activeDirectId)showDirectChat(activeDirectId);
      else renderContacts();
    }else{
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
    const messages=person?(directThreads.get(person.id)||[]):group.messages;
    if(person){
      el('group-chat-title').textContent=person.name;
      el('group-chat-subtitle').textContent=`${person.detail} · 一对一内部会话`;
      el('group-chat-member-count').textContent='2 人';
      el('group-chat-members').innerHTML=[{name:'陈小雨',detail:'我 · 客服'},{name:person.name,detail:person.group}].map(member=>`<div class="group-member"><span class="avatar">${safe(member.name.slice(0,1))}</span><span><strong>${safe(member.name)}</strong><small>${safe(member.detail)}</small></span></div>`).join('');
      el('group-chat-note').textContent='此处是与同事的一对一内部沟通演示，消息不会发送到微信客服客户。';
      el('group-chat-aside-title').textContent='会话信息';
      el('group-chat-member-label').textContent='会话成员';
      el('group-chat-aside-note').textContent='一对一内部会话属于界面原型：消息只保存在本次页面会话中，正式版本需要服务端提供成员权限、消息历史与实时通知。';
      el('group-composer-label').textContent='发送给 '+person.name;
      el('group-chat-send').textContent='发送 ↗';
      el('group-chat-reply').placeholder='输入给'+person.name+'的消息…';
      el('group-chat-reply').setAttribute('aria-label','发送给'+person.name+'的内部消息');
    }else{
      el('group-chat-title').textContent=group.name;
      el('group-chat-subtitle').textContent=`${group.detail} · ${group.members.length} 位成员`;
      el('group-chat-member-count').textContent=`${group.members.length} 人`;
      el('group-chat-members').innerHTML=group.members.map(name=>`<div class="group-member"><span class="avatar">${safe(name.slice(0,1))}</span><span><strong>${safe(name)}</strong><small>${name==='陈小雨'?'我 · 客服':'团队成员'}</small></span></div>`).join('');
      el('group-chat-note').textContent='此处是团队内部群聊演示，消息不会发送到微信客服客户。';
      el('group-chat-aside-title').textContent='群聊信息';
      el('group-chat-member-label').textContent='群成员';
      el('group-chat-aside-note').textContent='群聊、成员和消息目前保存在本次页面会话中。正式接入时需要服务端提供群权限、消息历史与实时通知。';
      el('group-composer-label').textContent='发送到内部群聊';
      el('group-chat-send').textContent='发送群消息 ↗';
      el('group-chat-reply').placeholder='输入群消息…';
      el('group-chat-reply').setAttribute('aria-label','发送到内部群聊的消息');
    }
    const dayLabel=person?'今天 · 内部会话':'今天 · 内部协作';
    const emptyText=person?`还没有和${person.name}的会话，发条消息开始协作。`:'群聊已创建，发送第一条消息开始协作。';
    el('group-chat-messages').innerHTML=`<div class="day">${safe(dayLabel)}</div>`+(messages.length?messages.map(message=>`<div class="message ${message.sender==='陈小雨'?'agent':''}"><div class="avatar">${safe(message.sender.slice(0,1))}</div><div class="message-content"><div class="message-meta">${safe(message.sender)} · ${safe(message.time)}</div><div class="bubble"></div></div></div>`).join(''):`<div class="empty">${safe(emptyText)}</div>`);
    el('group-chat-messages').querySelectorAll('.bubble').forEach((bubble,index)=>bubble.textContent=messages[index].text);
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
  // Group membership must be stored server-side; these mutable arrays are demo data.
  function renderContacts(){
    const category=contactCategory;
    const term=el('contact-search').value.trim();
    el('add-contact-group').textContent=category==='groupChats'?'＋ 新建群聊':'＋ 新建分组';
    el('contact-search').placeholder=category==='groupChats'?'搜索群聊或成员':'搜索姓名或分组';
    // 维护分组和建群是管理动作，客服角色不提供入口。
    el('add-contact-group').hidden=category==='blacklist'||!canManageContacts();
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
      return `<section class="contact-group"><button class="contact-group-toggle" type="button" data-group="${safe(group)}" aria-expanded="${open}"><span class="contact-group-arrow">▶</span>${safe(group)}<span class="contact-group-count">${grouped.length}</span></button><div class="contact-group-body" ${open?'':'hidden'}>${visible.length?visible.map(person=>{
        // 同事行：有内部会话的显示最后一条消息时间，当前打开的高亮并标记给读屏。
        const thread=category==='team'?directThreads.get(person.id):null;
        const lastMessage=thread?.at(-1);
        const selected=category==='team'&&person.id===activeDirectId;
        return `<div class="contact-entry${selected?' active':''}"><button class="contact-entry-main" type="button" data-contact-id="${safe(person.id)}"${selected?' aria-current="true"':''}><span class="avatar">${safe(person.initial)}</span><span class="contact-entry-text"><span class="contact-entry-name">${safe(person.name)}</span><span class="contact-entry-detail">${safe(person.detail)}</span></span></button>${lastMessage?`<span class="time">${safe(lastMessage.time)}</span>`:''}${canManageContacts()?`<button class="contact-more" type="button" data-contact-more="${safe(person.id)}" aria-label="管理 ${safe(person.name)} 的分组">⋯</button>`:''}</div>`;
      }).join(''):'<div class="contact-empty">暂无联系人</div>'}</div></section>`;
    }).join(''):'<div class="contact-empty">没有找到匹配的联系人或分组</div>';
    document.querySelectorAll('.contact-group-toggle').forEach(button=>button.onclick=()=>{
      const key=category+':'+button.dataset.group;
      if(expandedContactGroups.has(key))expandedContactGroups.delete(key);else expandedContactGroups.add(key);
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
    if(!c){el('messages').innerHTML='';el('send-btn').disabled=true;renderReplyWindow(null);return}
    renderReplyWindow(c);
    const storeLabel=backendConnected?c.store:`青禾生活${c.store}`;
    el('chat-name').innerHTML=`${safe(c.name)} <span class="pill ${c.status==='ended'?'gray':'blue'}" id="chat-status">${c.status==='ended'?'已结束':'接待中'}</span>`; el('chat-subtitle').textContent=`企业微信客服 · ${storeLabel} · ${c.status==='ended'?'会话已结束':c.canReply===false?'只读会话':'接待人 '+profile.name}`;
    el('messages').innerHTML='<div class="day">会话记录</div>'+c.messages.map(m=>`<div class="message ${m.by==='agent'?'agent':''}"><div class="avatar">${m.by==='agent'?safe(profileInitial()):safe(c.initial)}</div><div class="message-content"><div class="message-meta">${m.by==='agent'?safe(profile.name):safe(c.name)} · ${m.time}${m.source?' · '+safe(m.source):''}</div><div class="bubble"></div></div></div>`).join('');
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
    // 转交只在服务端确实允许的动作上出现：正在接待的会话由当前接待人转移；接待人
    // 已下线的会话由管理员或同店铺坐席接手后再转移——后者就是会话详情返回的
    // canTakeOver（平台规则 mayTakeOverClaim 的读法，前端不自己推）。待接入（尚未
    // 认领）和已结束会话本就没有转移动作，按钮不出现。前端只收口入口，转交能否
    // 成立仍由服务端在提交时判定；被拒绝时提示服务端给出的说明。
    const canTransfer=backendConnected
      ?c.rawStatus==='claimed'&&(c.assignedMemberId===selfMemberId||c.canTakeOver===true)
      :c.status==='active';
    el('transfer-btn').hidden=!canTransfer;
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
      suggestionSet=null;suggestionFor=null;suggestionError='';
      el('candidate-label').textContent='暂无候选回复';el('candidate-status').textContent='已结束';
      el('candidate-detail').disabled=true;el('product-section').style.display='none';
      el('candidates').innerHTML='<div class="footnote">历史会话仅供查看聊天记录。</div>';return;
    }
    if(backendConnected){
      // 真实会话的候选一律由服务端算（含意图识别与话术库优先），这里只负责渲染与重试。
      renderBackendCandidates();
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
  // 状态胶囊的文案与颜色一起给：绿色的「已完成检索」配在请求失败或闲聊上就是一句假话。
  function setCandidateStatus(text,tone){const node=el('candidate-status');node.textContent=text;node.className='pill '+(tone||'gray')}
  // 「检索依据」弹窗：真实会话渲染服务端写下来的那一份证据，而不是另一段示例文案。
  function suggestionDetailSummary(){
    if(!suggestionSet)return '';
    return '意图：'+(suggestionSet.intent==='chitchat'?'闲聊':'询问')
      +' · 来源：'+(SUGGESTION_ORIGIN_TEXT[suggestionSet.origin]||suggestionSet.origin)
      +' · 生成器：'+(suggestionSet.provider==='deepseek'?'大模型':'检索与规则');
  }
  function suggestionDetailText(){
    if(!suggestionSet)return '';
    const rows=(suggestionSet.candidates||[]).map(candidate=>{
      const modes=(candidate.recall?.modes||[]).map(mode=>mode==='semantic'?'向量':'关键词').join('+');
      const evidence=candidate.recall?('召回第 '+candidate.recall.rank+' 名（'+modes+'）'):'仅词面匹配';
      return '<div>· '+safe(SUGGESTION_KIND_TEXT[candidate.kind]||candidate.kind)+'「'+safe(candidate.title)+'」<br>　依据：'+safe(evidence)+' · 词面分 '+(Number(candidate.score)||0)+'</div>';
    }).join('');
    const reasons=reasonTexts(suggestionSet.fallbackReasons).map(text=>'<div>· '+safe(text)+'</div>').join('');
    return '<div class="review-card" style="font-size:12px">'+(rows||'<div>本次没有任何候选。</div>')+(reasons?'<div style="margin-top:8px">降级说明：</div>'+reasons:'')+'</div>';
  }
  // 真实会话的候选。一次请求换一个 set，然后只渲染它：会话换了或上一轮失败才重新拉一次，
  // 重复渲染复用同一个 set，否则每次 renderAll 都会打一次检索并写一条 suggestion_sets。
  function renderBackendCandidates(){
    const c=activeConversation();
    if(!c)return;
    const key=c.backendId||c.id;
    if(suggestionFor!==key&&!suggestionLoading)loadSuggestions(c,key);
    el('product-section').style.display='none';
    el('candidate-detail').disabled=!suggestionSet;
    if(suggestionLoading&&suggestionFor!==key){
      currentSuggestions=[];
      el('candidate-label').textContent='正在检索…';
      setCandidateStatus('检索中','gray');
      el('candidates').innerHTML='<div class="footnote">正在做意图识别与检索（话术库优先，其次商品库）…</div>';
      return;
    }
    if(suggestionError){
      currentSuggestions=[];
      el('candidate-label').textContent='候选获取失败';
      setCandidateStatus('请求失败','gray');
      el('candidates').innerHTML='<div class="footnote">'+safe(suggestionError)+' <button class="small-link" id="candidate-retry">重试</button></div>';
      const retry=el('candidate-retry');
      if(retry)retry.onclick=()=>{suggestionFor=null;suggestionError='';renderBackendCandidates()};
      return;
    }
    const set=suggestionSet;
    if(!set||!suggestionFor){
      currentSuggestions=[];
      el('candidate-label').textContent='暂无候选回复';
      setCandidateStatus('','gray');
      el('candidates').innerHTML='';
      return;
    }
    const reasons=reasonTexts(set.fallbackReasons);
    if(set.intent==='chitchat'){
      // 闲聊不检索是设计而不是失败，面板必须把这句话说出来，否则坐席会以为检索坏了。
      currentSuggestions=[];
      el('candidate-label').textContent='闲聊，无需检索';
      setCandidateStatus('闲聊','gray');
      el('candidates').innerHTML='<div class="footnote">'+safe(reasons[0]||'客户只是寒暄，未做检索。')+'可继续手动回复或使用快捷短语。</div>';
      return;
    }
    currentSuggestions=(set.candidates||[]).map(candidate=>({
      title:candidate.title,
      text:candidate.content,
      source:(SUGGESTION_KIND_TEXT[candidate.kind]||candidate.kind)+' · 词面分 '+(Number(candidate.score)||0),
      // 回传的引用就是这条候选的知识来源 id：候选里没有第二个 id。
      candidateId:candidate.sourceId,
    }));
    el('candidate-label').textContent=currentSuggestions.length?currentSuggestions.length+' 条候选回复':'暂无可靠候选';
    setCandidateStatus(SUGGESTION_ORIGIN_TEXT[set.origin]||set.origin,set.origin==='script'||set.origin==='generated'?'blue':'gray');
    const reasonBlock=reasons.length?'<div class="footnote" style="margin-top:8px;line-height:1.7">'+reasons.map(safe).join('<br>')+'</div>':'';
    el('candidates').innerHTML=(currentSuggestions.length?candidateCardsHtml(currentSuggestions):'<div class="footnote">话术库与商品库都没有命中可靠内容，请手动回复或使用快捷短语。</div>')+reasonBlock;
    bindCandidateUse();
  }
  async function loadSuggestions(c,key){
    suggestionLoading=true;
    suggestionError='';
    const requestId=++suggestionRequestId;
    try{
      const set=await api.suggest(c.backendId||key);
      if(requestId!==suggestionRequestId)return;   // 会话已经切走，这次结果作废
      suggestionSet=set;
      suggestionFor=key;
    }catch(error){
      if(requestId!==suggestionRequestId)return;
      // 失败的这一次也算「问过这个会话了」：否则渲染一发现没记住 key 就会立刻重发，把一次
      // 报错变成一串请求。重试由坐席点按钮触发（它把 key 清掉）。
      suggestionSet=null;
      suggestionFor=key;
      suggestionError=error.message||'候选请求失败';
    }finally{
      if(requestId===suggestionRequestId){
        suggestionLoading=false;
        renderCandidates();
      }
    }
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
      renderContacts();
      toast('已创建分组「'+name+'」（模拟）');
    },'<input id="new-contact-group-name" class="field" maxlength="24" placeholder="例如：售前客服">');
  };
  function sendInternalMessage(){
    const person=activeContact();
    const group=person?null:groupChats.find(item=>item.id===activeGroupChatId);
    const input=el('group-chat-reply');
    const text=input.value.trim();
    if(!person&&!group)return;
    if(!text){toast(person?'请输入消息内容':'请输入群消息');return}
    const message={sender:'陈小雨',time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),text};
    if(person)directThreads.set(person.id,[...(directThreads.get(person.id)||[]),message]);
    else group.messages.push(message);
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
      if(attachment){toast('首轮整合尚未开放真实附件发送，请先发送文字');return}
      if(!text){toast('请输入回复内容');return}
      // 服务端返回的窗口说这条发不出去时不提交。判决本来就在服务端（Worker 的发送闸门，
      // 拒收会记下可见的降级原因），这里只是把它念给坐席听——不再像原型那样自己数一个
      // 写死的额度。前端据此拦下提交，不是前端拥有这条规则。
      const windowView=replyWindowView(c.replyWindow);
      if(windowView&&!windowView.open){toast(windowView.toast||'当前不能发送外发消息');return}
      const backendSource=selectedSuggestion<0?'manual_typed':text===originalSuggestion?'direct_candidate':'edited_send';
      el('send-btn').disabled=true;
      try{
        // candidateId 只在这条回复确实来自一条候选时带上：服务端用它把「这条消息出自哪条
        // 候选」记进来源追溯（采纳率口径），编辑后发送也仍然是那条候选的起点。
        await api.sendMessage(c.backendId,text,backendSource,selectedSuggestion<0?'':selectedCandidateId);
        el('reply').value='';selectedSuggestion=-1;originalSuggestion='';selectedCandidateId='';
        // 会话往前走了，候选不该停在上一轮的 set 上：清掉记忆，下一次渲染重新问服务端。
        suggestionSet=null;suggestionFor=null;
        el('reply-hint').textContent='Enter 发送 · Shift+Enter 换行';
        await loadRemoteConversations();
        // 这一条刚花掉一个窗口额度，提醒上的数字得跟着走：重新读一次详情，而不是在
        // 浏览器里自减（自减出来的数字与服务端对不上，正是这次要改掉的毛病）。
        await loadConversationDetail(c.backendId);
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
  // 转交是「立即改派」：平台规则只允许 claimed 会话转交（packages/core 的
  // transferConversation），目标必须是同一租户内在线且可接单的坐席，且不能转给
  // 自己。可转交名单由后端按转交路由自己的判定返回（GET .../transfer-targets），
  // 所以这里不会出现「选项能选、确认必被拒」的情况。
  //
  // 确认按钮的既有约定是「动作同步返回 false 就保持弹窗打开、由动作自己负责关闭」，
  // 所以提交写成同步函数，请求在内部的异步流程里跑：弹窗一直开到服务端答复，转交
  // 失败（目标已离线、版本冲突）时选择还在，客服可以重试或取消，而不是被静默关掉。
  function submitTransfer(){
    const c=activeConversation();
    const select=el('transfer-target');
    if(!c||!select)return false;
    const toMemberId=select.value;
    if(!toMemberId){toast('请选择要转交的同事');return false}
    const name=select.options[select.selectedIndex]?.textContent?.split(' · ')[0]||toMemberId;
    el('modal-confirm').disabled=true;
    (async()=>{
      try{
        await api.transferConversation(c.backendId,toMemberId,c.version);
        closeModal();
        await loadRemoteConversations();
        toast(`会话已转交给 ${name}`);
      }catch(error){toast(error.message||'转交失败，会话仍归当前客服')}
      finally{el('modal-confirm').disabled=false}
    })();
    return false;
  }
  async function openTransferDialog(){
    const c=activeConversation();
    if(!c||c.status!=='active')return;
    if(!backendConnected){
      showModal('转接会话','选择当前店铺在线的客服。转接失败时会话仍归当前客服。',()=>toast('已转接给 李明（模拟）'),'<select class="field"><option>李明 · 在线接单</option><option>赵萌 · 在线接单</option></select>','确认转接');
      return;
    }
    el('transfer-btn').disabled=true;
    try{
      const targets=await api.transferTargets(c.backendId);
      if(!targets.length){toast('当前没有在线且可接单的同事，稍后再试或结束会话');return}
      // 手头会话数是「最少负载优先」的派单口径，客服据此判断转给谁更合适。
      const options=targets.map(target=>`<option value="${safe(target.memberId)}">${safe(target.displayName)} · 手头 ${target.inProgressCount} 个会话</option>`).join('');
      showModal('转交会话','转交后会话立即改派给对方接待，不回到公共池。转交失败时会话仍归当前客服。',submitTransfer,`<label for="transfer-target" class="setting-title">转交给</label><select id="transfer-target" class="field" style="margin-top:7px">${options}</select>`,'确认转交');
    }catch(error){toast(error.message||'暂时无法获取可转交的同事')}
    finally{el('transfer-btn').disabled=false}
  }
  el('transfer-btn').onclick=openTransferDialog;
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
    selectedSuggestion=-1;originalSuggestion='';selectedCandidateId='';
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
  el('candidate-detail').onclick=()=>{
    // 真实会话显示服务端写下来的那一份依据（意图、来源、每条候选的召回名次与词面分、降级
    // 原因）；演示会话继续显示示例，因为演示数据里没有真实的检索过程可讲。
    if(backendConnected&&suggestionSet){showModal('本次候选的检索依据',suggestionDetailSummary(),()=>{},suggestionDetailText());return}
    showModal('本次候选的检索依据','系统优先在当前店铺检索已锁定商品，再参考商品规格、核心卖点与相关 FAQ。当前为界面示例数据。',()=>{},'<div class="review-card" style="font-size:12px">命中商品：轻享保温杯 500ml<br>规格片段：黑色 / 米白色<br>卖点片段：双层真空结构<br>检索状态：已完成</div>');
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
    toast(assistEnabled?'AI 辅助已开启（模拟）':'AI 辅助已暂停，仍可人工回复（模拟）');
  };
  el('overview-toggle').onclick=()=>{
    const expanded=el('overview-toggle').getAttribute('aria-expanded')==='true';
    el('overview-toggle').setAttribute('aria-expanded',String(!expanded));
    el('overview-toggle').innerHTML=expanded?'展开 <span aria-hidden="true">⌄</span>':'收起 <span aria-hidden="true">⌄</span>';
    el('overview-details').hidden=expanded;
  };
  el('store-select').onchange=()=>toast('已选择 '+el('store-select').selectedOptions[0].textContent+'；原型展示固定示例数据');

  const knowledgeMeta={
    products:{singular:'商品',add:'录入商品',search:'搜索商品名称、SKU 或描述'},
    faqs:{singular:'常见问题',add:'录入常见问题',search:'搜索问题、答案或标签'},
    shortcuts:{singular:'快捷话术',add:'录入快捷话术',search:'搜索代码、标题或话术内容'},
  };
  function canWriteKnowledge(){return role()==='merchant'&&['merchant_admin','platform_admin'].includes(backendSession?.access?.role)}
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
  function resetKnowledgeForm(){fillKnowledgeForm(null)}
  function openKnowledgeItem(id){
    const item=knowledgeItems().find(entry=>String(entry.id)===String(id));
    if(item)fillKnowledgeForm(item);
  }
  async function ensureKnowledgeScope(){
    if(knowledgeScope)return knowledgeScope;
    const directories=await api.directoryTenants();
    const accessTenant=backendSession?.access?.tenantId||backendSession?.access?.member?.tenantId;
    const entry=(directories||[]).find(item=>item.tenant.id===accessTenant)||(directories||[]).find(item=>item.tenant.enabled!==false)||(directories||[])[0];
    if(!entry)throw new Error('当前账号没有可访问的公司知识库');
    const defaultStore=(entry.stores||[]).find(store=>store.enabled!==false)||(entry.stores||[])[0]||null;
    knowledgeScope={tenantId:entry.tenant.id,tenantName:entry.tenant.name,storeId:defaultStore?.id||null,storeName:defaultStore?.name||'',stores:entry.stores||[]};
    return knowledgeScope;
  }
  async function loadKnowledgeData(force=false){
    if(knowledgeLoading||knowledgeLoaded&&!force)return;
    knowledgeLoading=true;knowledgeLoaded=false;renderKnowledgeList();
    el('knowledge-scope-note').className='knowledge-scope-note';
    el('knowledge-scope-note').textContent='正在从业务后端读取公司知识库…';
    try{
      const scope=await ensureKnowledgeScope();
      const [products,faqs,shortcuts]=await Promise.all([api.knowledgeProducts(scope.tenantId),api.knowledgeFaqs(scope.tenantId),api.knowledgeShortcuts(scope.tenantId)]);
      knowledgeState.products.splice(0,knowledgeState.products.length,...(products||[]));
      knowledgeState.faqs.splice(0,knowledgeState.faqs.length,...(faqs||[]));
      knowledgeState.shortcuts.splice(0,knowledgeState.shortcuts.length,...(shortcuts||[]));
      knowledgeLoaded=true;
      const permission=canWriteKnowledge()?'管理员可新增、编辑、启停和导入':'客服只读，可查看、搜索和测试';
      el('knowledge-scope-note').textContent=`${scope.tenantName} · ${scope.stores.length} 个门店 · ${permission}`;
      if(!knowledgeEditingId)resetKnowledgeForm();else renderKnowledgeList();
    }catch(error){
      el('knowledge-scope-note').className='knowledge-scope-note error';
      el('knowledge-scope-note').textContent=error.message||'知识库读取失败';
      el('knowledge-list').innerHTML='<div class="empty">知识库暂时无法读取，请确认后端与账号范围。</div>';
    }finally{knowledgeLoading=false;if(knowledgeLoaded)renderKnowledgeList()}
  }
  function renderKnowledge(){
    const editable=canWriteKnowledge(),meta=knowledgeMeta[knowledgeTab];
    el('knowledge-access-badge').textContent=editable?'管理员 · 可维护':'客服 · 只读';
    el('knowledge-access-badge').className=`knowledge-access-badge${editable?'':' readonly'}`;
    el('knowledge-add').hidden=!editable;
    el('knowledge-add').textContent=`＋ ${meta.add}`;
    el('knowledge-import').hidden=!editable||knowledgeTab!=='products';
    el('knowledge-download-template').hidden=!editable||knowledgeTab!=='products';
    el('knowledge-search').placeholder=meta.search;
    document.querySelectorAll('[data-knowledge-tab]').forEach(button=>{const active=button.dataset.knowledgeTab===knowledgeTab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active))});
    configureKnowledgeForm();renderKnowledgeList();
    if(backendConnected&&!knowledgeLoaded&&!knowledgeLoading)void loadKnowledgeData();
  }
  async function saveKnowledgeItem(event){
    event.preventDefault();
    if(!canWriteKnowledge())return;
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
      if(knowledgeTab!=='shortcuts'&&!scope.storeId)throw new Error('公司下没有可用门店，无法保存。');
      let saved;
      if(knowledgeTab==='products')saved=current?await api.updateKnowledgeProduct(scope.tenantId,current.id,input):await api.createKnowledgeProduct(scope.tenantId,{storeId:scope.storeId,...input});
      else if(knowledgeTab==='faqs')saved=current?await api.updateKnowledgeFaq(scope.tenantId,current.id,input):await api.createKnowledgeFaq(scope.tenantId,{storeId:scope.storeId,...input});
      else saved=current?await api.updateKnowledgeShortcut(scope.tenantId,current.id,input):await api.createKnowledgeShortcut(scope.tenantId,{storeId:null,...input});
      const index=knowledgeItems().findIndex(item=>item.id===saved.id);
      if(index>=0)knowledgeItems().splice(index,1,saved);else knowledgeItems().unshift(saved);
      fillKnowledgeForm(saved);
      toast(`${knowledgeMeta[knowledgeTab].singular}已${current?'更新':'保存'}到业务后端`);
    }catch(error){el('knowledge-form-error').textContent=[error.message,...(error.details||[])].filter(Boolean).join('；')||'保存失败'}
    finally{saveButton.disabled=false;configureKnowledgeForm()}
  }
  async function toggleKnowledgeItem(id,button){
    if(!canWriteKnowledge())return;
    const item=knowledgeItems().find(entry=>String(entry.id)===String(id));
    if(!item)return;
    button.disabled=true;
    try{
      const tenantId=(await ensureKnowledgeScope()).tenantId,patch={enabled:!item.enabled};
      const updated=knowledgeTab==='products'?await api.updateKnowledgeProduct(tenantId,item.id,patch):knowledgeTab==='faqs'?await api.updateKnowledgeFaq(tenantId,item.id,patch):await api.updateKnowledgeShortcut(tenantId,item.id,patch);
      const index=knowledgeItems().findIndex(entry=>entry.id===item.id);knowledgeItems().splice(index,1,updated);
      if(knowledgeEditingId===item.id)fillKnowledgeForm(updated);else renderKnowledgeList();
      toast(`${knowledgeMeta[knowledgeTab].singular}已${updated.enabled?'启用':'停用'}`);
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
