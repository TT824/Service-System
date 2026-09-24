/**
 * Interface sample data only. Replace this source through the API adapter when
 * connecting to the backend. Do not use it as a source of production facts.
 */
window.CustomerServiceMock = {
  // 快捷短语联想演示；正式数据只返回当前租户和客服有权使用的启用短语。
  quickPhrases: [
    {id:'phrase-1',scope:'团队',title:'商品介绍视频',keywords:['视频','介绍','使用'],text:'您好，您想了解哪款商品的使用视频？请提供商品名称或规格，我帮您查找。'},
    {id:'phrase-2',scope:'团队',title:'安装视频',keywords:['视频','安装','教程'],text:'您好，请发送商品型号或订单中的商品截图，我帮您确认对应的安装视频。'},
    {id:'phrase-3',scope:'团队',title:'视频打不开',keywords:['视频','打不开','播放'],text:'视频暂时无法播放的话，请告诉我出现的提示，我帮您确认其他查看方式。'},
    {id:'phrase-4',scope:'团队',title:'发货时间',keywords:['发货','多久','时间'],text:'您好，商品通常会在付款后 48 小时内发出，具体请以商品页面和订单通知为准。'},
    {id:'phrase-5',scope:'团队',title:'规格确认',keywords:['规格','颜色','型号'],text:'为了准确帮您确认，方便告知具体颜色和规格吗？'},
    {id:'phrase-6',scope:'团队',title:'人工核实',keywords:['核实','稍等'],text:'请您稍等，我正在帮您核实相关信息，确认后马上回复您。'},
    {id:'phrase-7',scope:'团队',title:'物流查询',keywords:['物流','快递','到货'],text:'请提供订单编号，我帮您核实物流进度。'},
    {id:'phrase-8',scope:'团队',title:'售后处理',keywords:['售后','退货','退款'],text:'您好，请描述一下遇到的问题，并提供相关商品照片，我帮您确认处理方式。'},
    {id:'phrase-personal-1',scope:'个人',ownerId:'demo-agent',category:'售前',title:'欢迎咨询',keywords:['欢迎','咨询'],text:'您好，我是陈小雨，很高兴为您服务。请问想了解哪款商品？'},
    {id:'phrase-personal-2',scope:'个人',ownerId:'demo-agent',category:'跟进',title:'稍后回复',keywords:['稍后','核实'],text:'我先帮您核实一下，确认后会在这里回复您，请稍等。'}
  ],
  conversations: [
    {id:1,name:'林女士',initial:'林',status:'active',time:'09:40',preview:'请问这款保温杯有黑色吗？',store:'旗舰店',messages:[{by:'customer',time:'09:36',text:'您好，请问这款保温杯有黑色吗？'},{by:'agent',time:'09:37',text:'有的，请问您看的是 500ml 这款吗？'},{by:'customer',time:'09:40',text:'对，500ml 的。保温效果怎么样？'}]},
    {id:2,name:'周先生',initial:'周',status:'active',time:'09:32',preview:'发货一般需要多久？',store:'旗舰店',messages:[{by:'customer',time:'09:32',text:'发货一般需要多久？'}]},
    {id:3,name:'刘女士',initial:'刘',status:'active',time:'09:21',preview:'有适合送礼的包装吗？',store:'家居店',messages:[{by:'customer',time:'09:21',text:'有适合送礼的包装吗？'}]},
    {id:4,name:'吴先生',initial:'吴',status:'active',time:'09:42',preview:'想问一下米白色有货吗？',store:'旗舰店',messages:[{by:'customer',time:'09:42',text:'想问一下米白色有货吗？'}]},
    {id:5,name:'赵女士',initial:'赵',status:'ended',time:'昨天',preview:'谢谢，已经了解了',store:'旗舰店',messages:[{by:'customer',time:'昨天 17:26',text:'谢谢，已经了解了'}]}
  ],
  suggestions: [
    {title:'推荐 · 信息完整',text:'这款 500ml 保温杯有黑色可选。杯身采用双层真空结构，适合日常通勤使用。您可以打开商品链接查看款式与具体说明。',source:'商品规格 + 核心卖点 · 匹配度 94%'},
    {title:'简洁回复',text:'有的，500ml 款有黑色。保温表现您可以参考商品详情页的说明，我也可以帮您确认具体使用场景。',source:'商品规格 + FAQ · 匹配度 89%'},
    {title:'引导选择',text:'有黑色的 500ml 款哦。您主要是放办公室用，还是通勤随身带？我可以根据用途帮您看哪款更合适。',source:'商品规格 + 相似话术 · 匹配度 86%'}
  ],
  // Contact groups are a UI prototype. Backend membership and buyer visibility
  // must be scoped to the authorized tenant and stores.
  contactGroups: {
    team: ['仓储', '售后客服', '售前客服', '运营', '财务', '未分组成员'],
    buyers: ['重点客户', '最近咨询', '未分组客户'],
    blacklist: []
  },
  contacts: {
    team: [
      {id:'team-1',name:'王一帆',initial:'王',group:'售前客服',detail:'旗舰店 · 在线接单'},
      {id:'team-2',name:'陈小雨',initial:'陈',group:'售前客服',detail:'旗舰店 / 家居店 · 在线接单'},
      {id:'team-3',name:'李明',initial:'李',group:'售后客服',detail:'旗舰店 · 在线'},
      {id:'team-4',name:'赵萌',initial:'赵',group:'售后客服',detail:'家居店 · 在线'},
      {id:'team-5',name:'孙悦',initial:'孙',group:'仓储',detail:'仓储协作'},
      {id:'team-6',name:'周宁',initial:'周',group:'运营',detail:'店铺运营'},
      {id:'team-7',name:'张可',initial:'张',group:'财务',detail:'财务协作'}
    ],
    buyers: [
      {id:'buyer-1',name:'林女士',initial:'林',group:'重点客户',detail:'旗舰店 · 最近咨询 09:40',conversationId:1},
      {id:'buyer-2',name:'周先生',initial:'周',group:'最近咨询',detail:'旗舰店 · 最近咨询 09:32',conversationId:2},
      {id:'buyer-3',name:'刘女士',initial:'刘',group:'最近咨询',detail:'家居店 · 最近咨询 09:21',conversationId:3},
      {id:'buyer-4',name:'吴先生',initial:'吴',group:'未分组客户',detail:'旗舰店 · 系统已分配',conversationId:4},
      {id:'buyer-5',name:'赵女士',initial:'赵',group:'未分组客户',detail:'旗舰店 · 历史会话',conversationId:5}
    ],
    blacklist: []
  },
  // Internal group chat is a local UI demo, separate from external customer messages.
  groupChats: [
    {
      id:'group-1', name:'售前协作群', detail:'旗舰店 · 售前问题协同',
      members:['陈小雨','王一帆','李明','孙悦'],
      messages:[
        {sender:'王一帆',time:'09:24',text:'今天保温杯的颜色咨询比较多，大家统一以商品详情页为准。'},
        {sender:'孙悦',time:'09:27',text:'仓储已收到补货排期，库存变化请先找我核实。'},
        {sender:'陈小雨',time:'09:30',text:'收到，我会在回复前确认最新信息。'}
      ]
    }
  ]
};
