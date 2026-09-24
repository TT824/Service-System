/**
 * 管理员中心演示数据。付款、满意度与响应指标只用于界面评审。
 * TODO(API): 接入后由服务端按 tenant_id、store_id、员工和日期返回有权限的数据。
 */
window.AdminMock = {
  permissionModules: [
    {id:'staff',name:'员工数据',description:'查看单个员工的服务指标'},
    {id:'compare',name:'员工对比',description:'查看团队对比图表与明细'},
    {id:'records',name:'聊天记录',description:'查看授权店铺内脱敏会话'},
    {id:'permissions',name:'权限管理',description:'修改其他员工的管理权限'},
    {id:'routing',name:'员工分流',description:'设置自动接待参与资格'},
    {id:'audit',name:'操作日志',description:'查看管理配置的变更记录'}
  ],
  staff: [
    {id:'chen',name:'陈小雨',role:'客服',stores:'旗舰店、家居店',presence:'在线',routing:true,permissions:[],metrics:{
      day:{accepted:26,payers:8,revenue:1960,responseSeconds:42,satisfaction:96.4,reply3m:94.2},
      week:{accepted:148,payers:42,revenue:11280,responseSeconds:46,satisfaction:95.8,reply3m:93.6},
      month:{accepted:612,payers:169,revenue:48100,responseSeconds:49,satisfaction:95.3,reply3m:92.8}
    }},
    {id:'wang',name:'王一帆',role:'客服',stores:'旗舰店',presence:'在线',routing:true,permissions:[],metrics:{
      day:{accepted:22,payers:7,revenue:1680,responseSeconds:51,satisfaction:94.8,reply3m:91.6},
      week:{accepted:131,payers:36,revenue:9720,responseSeconds:54,satisfaction:94.2,reply3m:90.8},
      month:{accepted:548,payers:148,revenue:40700,responseSeconds:57,satisfaction:93.9,reply3m:90.2}
    }},
    {id:'li',name:'李明',role:'客服',stores:'旗舰店',presence:'挂起',routing:true,permissions:[],metrics:{
      day:{accepted:19,payers:5,revenue:1240,responseSeconds:58,satisfaction:93.2,reply3m:89.4},
      week:{accepted:112,payers:30,revenue:8060,responseSeconds:61,satisfaction:93.8,reply3m:88.9},
      month:{accepted:478,payers:123,revenue:34500,responseSeconds:62,satisfaction:93.4,reply3m:88.2}
    }},
    {id:'zhao',name:'赵萌',role:'客服',stores:'家居店',presence:'在线',routing:true,permissions:['records'],metrics:{
      day:{accepted:24,payers:9,revenue:2180,responseSeconds:39,satisfaction:97.1,reply3m:96.2},
      week:{accepted:137,payers:43,revenue:11940,responseSeconds:43,satisfaction:96.5,reply3m:95.1},
      month:{accepted:583,payers:176,revenue:50300,responseSeconds:45,satisfaction:96.1,reply3m:94.8}
    }},
    {id:'zhou',name:'周宁',role:'管理员',stores:'旗舰店、家居店',presence:'在线',routing:false,permissions:['staff','compare','records','permissions','routing','audit'],metrics:{
      day:{accepted:8,payers:2,revenue:520,responseSeconds:64,satisfaction:95.0,reply3m:90.0},
      week:{accepted:46,payers:11,revenue:2860,responseSeconds:68,satisfaction:94.6,reply3m:89.6},
      month:{accepted:196,payers:48,revenue:12800,responseSeconds:70,satisfaction:94.4,reply3m:89.1}
    }}
  ],
  chatRecords: [
    {id:'R-2401',customer:'林*',staffId:'chen',store:'旗舰店',time:'09-22 09:36',status:'接待中',messages:[{by:'customer',text:'请问这款保温杯有黑色吗？'},{by:'staff',text:'有的，500ml 这款有黑色可选。'},{by:'customer',text:'保温效果怎么样？'}]},
    {id:'R-2402',customer:'周*',staffId:'wang',store:'旗舰店',time:'09-22 09:32',status:'接待中',messages:[{by:'customer',text:'发货一般需要多久？'},{by:'staff',text:'具体时间请以商品页面与订单通知为准，我也可以帮您核实。'}]},
    {id:'R-2403',customer:'刘*',staffId:'zhao',store:'家居店',time:'09-22 09:21',status:'接待中',messages:[{by:'customer',text:'有适合送礼的包装吗？'},{by:'staff',text:'我帮您确认一下包装规格，请稍等。'}]},
    {id:'R-2398',customer:'赵*',staffId:'li',store:'旗舰店',time:'09-21 17:26',status:'已结束',messages:[{by:'customer',text:'米白色还有吗？'},{by:'staff',text:'库存可能变动，请以商品页面实时显示为准。'},{by:'customer',text:'谢谢，已经了解了。'}]}
  ]
};
