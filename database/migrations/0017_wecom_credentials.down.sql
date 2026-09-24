-- 回滚 0017：删掉凭证表。
--
-- 这一步是有损的，写在这里是为了回滚的人知道自己在丢什么：凭证只有这一份，
-- 删掉之后服务端会回落到 `.env` 里那一组（如果还配着），否则 real 模式会变成
-- 「已请求但未配置」，控制台的渠道页会如实说缺哪几个变量。绑定行、会话、消息
-- 都不受影响 —— 这张表里没有别的东西再存一份。

DROP INDEX IF EXISTS wecom_channel_credentials_updated_idx;

DROP TABLE IF EXISTS wecom_channel_credentials;
