'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS local data utility. */
/**
 * 本地工作台演示数据。默认预览，--apply 才写入。
 * 只插入会话、历史消息及分配记录；没有渠道回调、发送窗口、外发任务或模拟提权。
 * 固定 ID 便于追溯；已有演示会话整组跳过，不覆盖操作人员后续回复、转接和结束。
 */
const path = require('node:path');
const { Client } = require('pg');
require('dotenv').config({path:path.resolve(__dirname, '../../.env'), quiet:true});

const TENANT = 'tenant-acme', STORE = 'store-acme-flagship', MEMBER = 'u-t1-agent-2';
const PREFIX = 'demo-workspace-v1';
const scenarios = [
  {key:'lin', name:'林女士', minutes:0, messages:[
    ['inbound','【本地演示，非真实客户】您好，我想了解云集轻暖羽绒服。'],
    ['outbound','您好，欢迎咨询。您想了解款式、颜色还是保暖效果？'],
    ['inbound','连帽中长款，想买黑色的。'],
    ['outbound','这款资料中有黑色可选；具体库存请以商品页面为准。'],
    ['inbound','云集轻暖羽绒服 90白鸭绒 连帽中长款的充绒量、尺码和发货时间是什么？'],
  ]},
  {key:'zhou', name:'周先生', minutes:10, messages:[
    ['inbound','【本地演示，非真实客户】云集羽绒服轻薄短款可以收纳吗？'],
    ['outbound','资料说明这款可以折叠收纳成小包，方便携带。'],
    ['inbound','平常穿 L 码。'],
    ['inbound','云集羽绒服 轻薄短款 可收纳有哪些尺码、颜色，多久发货？'],
  ]},
  {key:'liu', name:'刘女士', minutes:20, transferred:true, messages:[
    ['inbound','【本地演示，非真实客户】我想给孩子买一件羽绒服。'],
    ['outbound','您好，已由客服小蓝继续为您服务。'],
    ['inbound','孩子 8 岁，身高 130 厘米。'],
    ['inbound','云集儿童羽绒服 加厚款的尺码和颜色有哪些？'],
  ]},
  {key:'wu', name:'吴先生', minutes:30, messages:[
    ['inbound','【本地演示，非真实客户】您好，我想了解长款羽绒服。'],
    ['outbound','您好，请问您想了解哪一款？'],
    ['inbound','情侣款，冬天穿的。'],
    ['inbound','云集羽绒服 情侣款 长款过膝有哪些尺码、颜色，什么时候发货？'],
  ]},
  {key:'zhao', name:'赵女士', minutes:1440, closed:true, messages:[
    ['inbound','【本地演示，非真实客户】请问云集纯棉圆领T恤有什么颜色？'],
    ['outbound','商品资料中的颜色为白色、黑色和灰色；规格与库存请以商品页面为准。'],
    ['inbound','好的，谢谢，已经了解了。'],
    ['outbound','不客气，祝您购物愉快。'],
  ]},
];
const at = ms => new Date(ms).toISOString();

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('用法：node database/scripts/seed-workspace-demo.cjs [--apply]');
  if (process.env.APP_ENV !== 'local') throw new Error('演示数据仅允许 APP_ENV=local');
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('演示数据只允许写入本机 PostgreSQL');
  const apply = args.includes('--apply'), client = new Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('seed-workspace-demo-v1'))");
    const member = (await client.query('SELECT tenant_id,store_id,role,enabled FROM members WHERE id=$1', [MEMBER])).rows[0];
    const store = (await client.query('SELECT tenant_id,enabled FROM stores WHERE id=$1', [STORE])).rows[0];
    if (!member?.enabled || member.role !== 'agent' || member.tenant_id !== TENANT || member.store_id !== STORE || !store?.enabled || store.tenant_id !== TENANT) throw new Error('演示客服或门店范围与预期不一致');
    const existing = (await client.query('SELECT id,tenant_id,store_id,external_customer_id FROM conversations WHERE id=ANY($1::text[])', [scenarios.map(s => `${PREFIX}-${s.key}`)])).rows;
    for (const row of existing) {
      if (row.tenant_id !== TENANT || row.store_id !== STORE || row.external_customer_id !== row.id.replace(PREFIX, `${PREFIX}-customer`)) throw new Error('固定演示 ID 已被其他数据使用，停止写入');
    }
    const pending = scenarios.filter(s => !existing.some(row => row.id === `${PREFIX}-${s.key}`));
    console.log(`${apply ? '写入' : '预览'}：${pending.length} 条新演示会话；${existing.length} 条已存在，不覆盖。`);
    if (!apply) { await client.query('ROLLBACK'); return; }
    const now = Date.now(); let messages = 0, assignments = 0;
    for (const scenario of pending) {
      const id = `${PREFIX}-${scenario.key}`, customerId = `${PREFIX}-customer-${scenario.key}`;
      const last = now - scenario.minutes * 60000, start = last - (scenario.messages.length - 1) * 60000;
      const version = scenario.transferred || scenario.closed ? 3 : 2;
      await client.query(`INSERT INTO conversations
        (id,tenant_id,store_id,channel,external_customer_id,external_conversation_id,title,status,version,assigned_member_id,
         opened_at,last_message_at,closed_at,created_at,first_response_started_at,assigned_at,first_reply_at)
        VALUES ($1,$2,$3,'wecom',$4,$1,$5,$6,$7,$8,$9,$10,$11,$9,$9,$12,$13)`,
        [id,TENANT,STORE,customerId,`${scenario.name}（演示）`,scenario.closed ? 'closed' : 'claimed',version,MEMBER,
          at(start),at(last),scenario.closed ? at(last + 1000) : null,at(start + (scenario.transferred ? 30000 : 10000)),at(start + 60000)]);
      for (let i = 0; i < scenario.messages.length; i++) {
        const [direction, content] = scenario.messages[i], messageId = `${id}-message-${i + 1}`;
        await client.query(`INSERT INTO messages
          (id,tenant_id,store_id,conversation_id,channel,direction,source,message_type,content,dedup_key,review_eligible,review_state,created_at)
          VALUES ($1,$2,$3,$4,'wecom',$5,$6,'text',$7,$1,false,'none',$8)`,
          [messageId,TENANT,STORE,id,direction,direction === 'outbound' ? 'manual_typed' : null,content,at(start + i * 60000)]);
        messages++;
      }
      await client.query(`INSERT INTO conversation_assignments
        (id,tenant_id,store_id,conversation_id,action,result,from_member_id,to_member_id,state_version_before,state_version_after,created_at)
        VALUES ($1,$2,$3,$4,'auto_assign','success',null,$5,1,2,$6)`,
        [`${id}-assignment-1`,TENANT,STORE,id,scenario.transferred ? 'u-t1-agent-1' : MEMBER,at(start + 10000)]);
      assignments++;
      if (scenario.transferred) {
        await client.query(`INSERT INTO conversation_assignments
          (id,tenant_id,store_id,conversation_id,action,result,from_member_id,to_member_id,state_version_before,state_version_after,created_at)
          VALUES ($1,$2,$3,$4,'transfer','success','u-t1-agent-1',$5,2,3,$6)`,
          [`${id}-assignment-2`,TENANT,STORE,id,MEMBER,at(start + 30000)]);
        assignments++;
      }
    }
    await client.query('COMMIT');
    console.log(`完成：${pending.length} 条会话、${messages} 条历史消息、${assignments} 条模拟分配记录。未创建发送窗口和外发任务。`);
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { await client.end(); }
}
main().catch(error => { console.error(`演示数据：${error.message}`); process.exitCode=1; });
