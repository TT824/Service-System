-- 回滚 0016：先删产物表（它引用 jobs），再删索引与两列。
--
-- 导出的文件没有别处再存一份：这个表一删，已经生成过的下载就没了，而 `jobs` 里的
-- 任务行会留在原地、继续显示「成功」——它记录的是「当时生成过」，不是「文件还在」。
-- 这一步是有损的，写在这里是为了回滚的人知道自己在丢什么。

DROP TABLE IF EXISTS job_artifacts;

DROP INDEX IF EXISTS jobs_tenant_created_idx;

ALTER TABLE jobs DROP COLUMN IF EXISTS finished_at;
ALTER TABLE jobs DROP COLUMN IF EXISTS started_at;
