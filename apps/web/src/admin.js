/**
 * 企业管理员中心的界面交互。所有变更只保存在当前页面内存。
 * TODO(API): 正式版本必须在服务端按租户、店铺、角色和具体权限校验每次读写。
 */
(() => {
  const source=window.AdminMock;
  const staff=structuredClone(source.staff);
  const records=source.chatRecords;
  const modules=source.permissionModules;
  const moduleIds=modules.map(item=>item.id);
  const byId=id=>document.getElementById(id);
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money=value=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',maximumFractionDigits:0}).format(value);
  const periodNames={day:'本日',week:'本周',month:'本月'};
  const metrics={
    accepted:{label:'接单量',format:value=>`${value} 单`},
    payers:{label:'付款人数',format:value=>`${value} 人`},
    revenue:{label:'付款金额',format:money},
    responseSeconds:{label:'平均响应时长',format:value=>`${value} 秒`},
    satisfaction:{label:'满意度',format:value=>`${value.toFixed(1)}%`},
    reply3m:{label:'3 分钟回复率',format:value=>`${value.toFixed(1)}%`}
  };
  let period='day', currentView='overview', permissionStaffId=staff[0].id;
  let permissionDraft=new Set(staff[0].permissions);
  const routingDraft=new Map(staff.map(item=>[item.id,item.routing]));
  const audit=[];
  const permissionRequests=new Set();

  // 演示客服对应陈小雨；正式身份与模块权限必须由服务端返回。
  function canAccess(module){
    return role()==='merchant'||(role()==='agent'&&employee('chen').permissions.includes(module));
  }
  function requireAccess(module){
    if(canAccess(module))return true;
    const name=modules.find(item=>item.id===module)?.name||'此功能';
    const pending=permissionRequests.has(module);
    showModal('暂无权限',pending?`您已申请“${name}”权限，请等待企业管理员处理。`:`您暂无“${name}”权限，可向企业管理员申请授权。`,()=>{
      // TODO(API): 创建授权申请并返回 pending；申请本身不授予权限。
      permissionRequests.add(module);
      notify('授权申请已记录（本地演示，待接入审批服务）');
    },'',pending?'已申请，待审批':'申请授权');
    byId('modal-confirm').disabled=pending;
    return false;
  }

  function notify(message){
    const element=byId('toast');
    element.textContent=message;
    element.classList.add('show');
    clearTimeout(window.toastTimer);
    window.toastTimer=setTimeout(()=>element.classList.remove('show'),2600);
  }
  function employee(id){return staff.find(item=>item.id===id)}
  function card(label,value,note){return `<div class="admin-stat-card"><span class="admin-stat-label">${escape(label)}</span><strong>${escape(value)}</strong><small>${escape(note)}</small></div>`}
  function addAudit(action,target){
    audit.unshift({time:new Date().toLocaleString('zh-CN',{hour12:false}),action,target});
    renderAudit();
  }
  function switchView(next){
    if(next!=='overview'&&!requireAccess(next))return;
    currentView=next;
    document.querySelectorAll('.admin-subnav [data-admin-view]').forEach(button=>button.classList.toggle('active',button.dataset.adminView===next));
    document.querySelectorAll('.admin-view').forEach(panel=>panel.hidden=panel.id!==`admin-view-${next}`);
    if(next==='overview')renderOverview();
    if(next==='staff')renderStaff();
    if(next==='compare')renderCompare();
    if(next==='permissions')renderPermissions();
    if(next==='routing')renderRouting();
    if(next==='records')renderRecords();
    if(next==='audit')renderAudit();
  }
  function renderOverview(){
    if(!canAccess('compare')&&!canAccess('routing')){
      byId('admin-overview-stats').innerHTML='';
      byId('admin-overview-stats').hidden=true;
      return;
    }
    byId('admin-overview-stats').hidden=false;
    const values=staff.map(item=>item.metrics[period]);
    const total=key=>values.reduce((sum,item)=>sum+item[key],0);
    const receiving=staff.filter(item=>item.routing&&item.presence==='在线').length;
    byId('admin-overview-stats').innerHTML=[...(canAccess('compare')?[
      card('接待员工',`${staff.length} 人`,'当前租户可见成员'),
      card(`${periodNames[period]}接单量`,`${total('accepted')} 单`,'系统分配并进入接待'),
      card(`${periodNames[period]}付款金额`,money(total('revenue')),'订单系统接入后核算')]:[]),
      ...(canAccess('routing')?[card('可参与接待',`${receiving} 人`,'已启用分流且当前在线')]:[])
    ].join('');
  }
  function renderStaff(){
    if(!canAccess('staff'))return;
    const item=employee(byId('admin-staff-select').value)||staff[0];
    const values=item.metrics[period];
    byId('admin-staff-summary').innerHTML=Object.entries(metrics).map(([key,metric])=>
      card(metric.label,metric.format(values[key]),`${periodNames[period]} · ${item.name}${key==='revenue'||key==='payers'?' · 演示归因':''}`)
    ).join('');
  }
  function renderCompare(){
    if(!canAccess('compare'))return;
    const key=byId('admin-compare-metric').value;
    const metric=metrics[key];
    const max=Math.max(...staff.map(item=>item.metrics[period][key]),1);
    byId('admin-chart-title').textContent=`${periodNames[period]}${metric.label}对比`;
    byId('admin-chart').innerHTML=staff.map(item=>{
      const value=item.metrics[period][key];
      const width=Math.max(2,value/max*100);
      return `<div class="admin-chart-row"><span class="admin-chart-name">${escape(item.name)}</span><span class="admin-chart-track"><span class="admin-chart-bar" style="width:${width.toFixed(1)}%"></span></span><span class="admin-chart-value">${escape(metric.format(value))}</span></div>`;
    }).join('');
    byId('admin-compare-rows').innerHTML=staff.map(item=>{
      const values=item.metrics[period];
      return `<tr><td><strong>${escape(item.name)}</strong></td><td>${values.accepted}</td><td>${values.payers}</td><td>${escape(money(values.revenue))}</td><td>${values.responseSeconds} 秒</td><td>${values.satisfaction.toFixed(1)}%</td><td>${values.reply3m.toFixed(1)}%</td></tr>`;
    }).join('');
  }
  function renderPermissions(){
    if(!canAccess('permissions'))return;
    const item=employee(permissionStaffId);
    permissionDraft=new Set(item.permissions);
    byId('admin-permission-staff').value=item.id;
    byId('admin-permission-name').textContent=item.name;
    byId('admin-permission-role').textContent=`当前身份：${item.role} · 可访问店铺：${item.stores}`;
    byId('admin-permission-options').innerHTML=`<label class="admin-permission-option full"><input id="admin-permission-all" type="checkbox" ${moduleIds.every(id=>permissionDraft.has(id))?'checked':''}><span><strong>全部管理员权限</strong><small>开放以下所有管理功能</small></span></label>`+
      modules.map(module=>`<label class="admin-permission-option"><input type="checkbox" data-permission-id="${escape(module.id)}" ${permissionDraft.has(module.id)?'checked':''}><span><strong>${escape(module.name)}</strong><small>${escape(module.description)}</small></span></label>`).join('');
    byId('admin-permission-all').onchange=event=>{
      permissionDraft=event.target.checked?new Set(moduleIds):new Set();
      byId('admin-permission-options').querySelectorAll('[data-permission-id]').forEach(input=>input.checked=event.target.checked);
    };
    byId('admin-permission-options').querySelectorAll('[data-permission-id]').forEach(input=>input.onchange=()=>{
      if(input.checked)permissionDraft.add(input.dataset.permissionId);
      else permissionDraft.delete(input.dataset.permissionId);
      byId('admin-permission-all').checked=moduleIds.every(id=>permissionDraft.has(id));
    });
  }
  function savePermissions(){
    if(!requireAccess('permissions'))return;
    const item=employee(permissionStaffId);
    const fullCount=staff.filter(member=>moduleIds.every(id=>member.permissions.includes(id))).length;
    const wasFull=moduleIds.every(id=>item.permissions.includes(id));
    const willBeFull=moduleIds.every(id=>permissionDraft.has(id));
    if(wasFull&&!willBeFull&&fullCount===1){notify('至少保留一位完整管理员');return}
    item.permissions=moduleIds.filter(id=>permissionDraft.has(id));
    item.role=willBeFull?'管理员':item.permissions.length?'部分授权':'客服';
    document.querySelectorAll('#admin-staff-select option,#admin-permission-staff option,#admin-record-staff option').forEach(option=>{
      if(option.value===item.id)option.textContent=`${item.name} · ${item.role}`;
    });
    const settingsRole=byId(`settings-role-${item.id}`);
    if(settingsRole)settingsRole.textContent=item.role;
    addAudit('修改员工权限',`${item.name} · ${item.role}`);
    if(item.id==='chen')item.permissions.forEach(module=>permissionRequests.delete(module));
    refreshAccess();
    if(canAccess('permissions'))switchView('permissions');
    notify('员工权限已保存（仅本地演示）');
  }
  function renderRouting(){
    if(!canAccess('routing'))return;
    byId('admin-routing-rows').innerHTML=staff.map(item=>`<tr><td><strong>${escape(item.name)}</strong></td><td>${escape(item.stores)}</td><td>${escape(item.presence)}</td><td><label><input type="checkbox" data-routing-id="${escape(item.id)}" ${routingDraft.get(item.id)?'checked':''}> 参与自动接待</label></td></tr>`).join('');
    byId('admin-routing-rows').querySelectorAll('[data-routing-id]').forEach(input=>input.onchange=()=>routingDraft.set(input.dataset.routingId,input.checked));
  }
  function saveRouting(){
    if(!requireAccess('routing'))return;
    const changes=staff.filter(item=>item.routing!==routingDraft.get(item.id));
    if(!changes.length){notify('分流资格没有变化');return}
    changes.forEach(item=>{
      item.routing=routingDraft.get(item.id);
      addAudit('修改分流资格',`${item.name} · ${item.routing?'参与':'暂停'}自动接待`);
    });
    renderOverview();
    notify('分流资格已保存（仅本地演示）');
  }
  function renderRecords(){
    if(!canAccess('records'))return;
    const term=byId('admin-record-search').value.trim().toLowerCase();
    const staffId=byId('admin-record-staff').value;
    const filtered=records.filter(record=>{
      const name=employee(record.staffId)?.name||'';
      return (staffId==='all'||record.staffId===staffId)&&(!term||[record.customer,name,record.id,...record.messages.map(message=>message.text)].some(value=>value.toLowerCase().includes(term)));
    });
    byId('admin-record-rows').innerHTML=filtered.length?filtered.map(record=>`<tr><td><strong>${escape(record.customer)}</strong></td><td>${escape(employee(record.staffId)?.name||'—')}</td><td>${escape(record.store)}</td><td>${escape(record.time)}</td><td>${escape(record.status)}</td><td><button class="small-link" type="button" data-record-id="${escape(record.id)}">查看消息</button></td></tr>`).join(''):'<tr><td colspan="6" class="admin-muted">没有匹配的聊天记录</td></tr>';
    byId('admin-record-rows').querySelectorAll('[data-record-id]').forEach(button=>button.onclick=()=>showRecord(button.dataset.recordId));
    byId('admin-record-detail').hidden=true;
  }
  function showRecord(id){
    if(!requireAccess('records'))return;
    const record=records.find(item=>item.id===id);
    if(!record)return;
    byId('admin-record-detail').innerHTML=`<h3><span>${escape(record.customer)} · ${escape(employee(record.staffId)?.name||'—')} · ${escape(record.time)}</span><button class="small-link" id="admin-close-record" type="button">关闭</button></h3>`+
      record.messages.map(message=>`<div class="admin-record-message"><strong>${message.by==='staff'?'客服':'客户'}</strong><p>${escape(message.text)}</p></div>`).join('');
    byId('admin-record-detail').hidden=false;
    byId('admin-close-record').onclick=()=>byId('admin-record-detail').hidden=true;
    byId('admin-record-detail').scrollIntoView({block:'nearest'});
  }
  function renderAudit(){
    if(!canAccess('audit'))return;
    byId('admin-audit-rows').innerHTML=audit.length?audit.map(item=>`<div class="admin-audit-item"><span><strong>${escape(item.action)}</strong> · ${escape(item.target)}</span><span>${escape(item.time)}</span></div>`).join(''):'<div class="admin-muted">本次页面会话暂无权限或分流变更。</div>';
  }
  function renderAll(){renderOverview();renderStaff();renderCompare();renderAudit()}
  function refreshAccess(){
    // 角色切换时清空未授权内容，避免残留上一个角色的员工数据或聊天记录。
    const content={staff:['admin-staff-summary'],compare:['admin-chart','admin-compare-rows'],permissions:['admin-permission-name','admin-permission-role','admin-permission-options'],routing:['admin-routing-rows'],records:['admin-record-rows','admin-record-detail'],audit:['admin-audit-rows']};
    Object.entries(content).forEach(([module,ids])=>{if(!canAccess(module))ids.forEach(id=>byId(id).innerHTML='')});
    const options=staff.map(item=>`<option value="${escape(item.id)}">${escape(item.name)} · ${escape(item.role)}</option>`).join('');
    byId('admin-staff-select').innerHTML=canAccess('staff')?options:'';
    byId('admin-permission-staff').innerHTML=canAccess('permissions')?options:'';
    byId('admin-record-staff').innerHTML=canAccess('records')?'<option value="all">全部员工</option>'+options:'';
    byId('admin-filter-bar').hidden=!canAccess('staff')&&!canAccess('compare');
    byId('admin').querySelectorAll('.admin-tool-card').forEach(button=>{
      const allowed=canAccess(button.dataset.adminView);
      button.classList.toggle('requires-permission',!allowed);
      button.querySelector('.admin-tool-arrow').textContent=allowed?'→':'需授权';
    });
    renderAll();switchView('overview');
  }
  byId('admin-period').onchange=event=>{period=event.target.value;renderAll()};
  byId('admin-staff-select').onchange=renderStaff;
  byId('admin-compare-metric').onchange=renderCompare;
  byId('admin-permission-staff').onchange=event=>{permissionStaffId=event.target.value;renderPermissions()};
  byId('admin-save-permissions').onclick=savePermissions;
  byId('admin-save-routing').onclick=saveRouting;
  byId('admin-record-search').oninput=renderRecords;
  byId('admin-record-staff').onchange=renderRecords;
  byId('admin').querySelectorAll('[data-admin-view]').forEach(button=>button.onclick=()=>switchView(button.dataset.adminView));
  window.AdminPortal={
    open:refreshAccess,
    refreshAccess,
    showPermissions:id=>{if(employee(id))permissionStaffId=id;switchView('permissions')}
  };
})();
