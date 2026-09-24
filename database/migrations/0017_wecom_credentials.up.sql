-- 企业微信接入凭证：把「填了就能连」从 .env 搬进库里。
--
-- 2026-09-22：控制台的渠道接入页要能真的连上企业微信 —— 操作者在前端填五项、
-- 点「连接」，服务端拿这份凭证真去换一次 access_token。今天这五项只能从环境变量
-- 读，而环境变量是**进程启动时解析一次**的：前端就算把值发上来，不重启进程也不会
-- 生效（`RealWecomAdapter` 与 `WecomTokenProvider` 都在构造时吃一份快照）。要让它
-- 生效，凭证必须落在一个**两个进程都读得到、且能改**的地方，那就是这个库：
-- API 发消息、Worker 拉取与投递，用的是同一份 token。
--
-- 为什么另开一张表，而不是给 `wecom_channel_bindings` 加三列：
-- `channel-reliability.ts` 对绑定表的原话是「绑定里没有第五个字段，绑定里任何一项
-- 都不是凭证」。那张表的读者里有控制台（`GET /channels` 的 `bindings`），而这三列
-- 的唯一读者应该是服务端的凭证来源 —— 凭证不是绑定的一部分，就不该能从「读绑定」
-- 的那条路上被取出来。放在这里，泄漏面是构造出来的零，而不是每次查询都要记得投影。
--
-- 键是 `binding_id`：凭证属于一个**已绑定的客服账号**（`corp_id` + `open_kfid`）。
-- 没有绑定行的凭证是收不到消息的凭证（回调解析不出租户与门店），所以写入的次序是
-- 「先有绑定、再挂凭证」，而删掉绑定连凭证一起删 —— 一行 `CASCADE` 说完这件事。
--
-- 三列都是密文级：`kf_secret` 用来换 access_token，`callback_token` 用来校验回调
-- 签名，`aes_key` 用来解回调体。落库是明文，和今天写在 `.env` 里同一台机器、
-- 同一个暴露级别；要加密得再引入一个「钥匙」环境变量，那是一个独立的决定，
-- 不在这张表里假装已经做了。

CREATE TABLE IF NOT EXISTS wecom_channel_credentials (
  binding_id     TEXT PRIMARY KEY REFERENCES wecom_channel_bindings (id) ON DELETE CASCADE,
  kf_secret      TEXT NOT NULL,
  callback_token TEXT NOT NULL,
  -- 企业微信控制台发的是固定 43 位的 EncodingAESKey；长度的判据在 core 的
  -- `wecomCredentialProblems` 里（一份），这里不重复成一个 CHECK —— 长度错了要
  -- 能**存下来并说清错在哪**，而不是让写库这一步炸成 500。
  aes_key        TEXT NOT NULL,
  -- 最后一次真去换 token 的结论。一个事实两半：验过就有时间，失败就有原因；
  -- 从没验过就是两个 NULL。写入一组新凭证会把它们清空 —— 结论属于被验的那一组
  -- 值，换了值之后旧的「验过」不再是对这组值的结论。
  verified_at    TIMESTAMPTZ,
  verified_error TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  -- 谁填的。**故意没有外键**：这是全库唯一一处指向 `user_accounts` 的引用，而
  -- `database.integration.spec.ts` 有一条用例要把 0003/0004 的 down 文件跑一遍
  -- （「认证迁移能按依赖顺序回滚、不留残余」）。有了这个外键，`DROP TABLE
  -- user_accounts` 就会因为「还有别的对象依赖它」而失败 —— 那条用例当场变红
  -- （09-22 实测）。要么改那条用例（让认证迁移的可回滚性从此依赖于之后每一张
  -- 新表），要么这里不建约束；选了后者。代价：账号行真被删掉之后，这一列可能留着
  -- 一个指不到人的 id。它**只写不读**（端口里没有这一项，界面也没有），所以这个代价
  -- 落空。想重新加约束的人先去看那条用例。
  updated_by     TEXT,
  CONSTRAINT wecom_channel_credentials_verified_check
    CHECK (verified_error IS NULL OR verified_at IS NOT NULL)
);

-- 「这台部署现在连着哪个客服账号」是凭证来源每次刷新都要问的问题：它按
-- `updated_at` 取最新的一行，所以给它一条顺着扫的索引，而不是每轮都排序全表。
CREATE INDEX IF NOT EXISTS wecom_channel_credentials_updated_idx
  ON wecom_channel_credentials (updated_at DESC, binding_id);
