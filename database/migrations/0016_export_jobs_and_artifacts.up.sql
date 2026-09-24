-- 导出任务，以及它产出的文件。
--
-- 2026-09-22：控制台要一页「导出任务」，四栏是任务 ID、状态、创建时间、开始时间、
-- 完成时间。任务本身不用新建表 —— `jobs` 在 0002 就建好了，`kind`/`status`/
-- `payload`/`result` 正是这件事的形状，而 `status` 的四个取值
-- （`pending` / `running` / `succeeded` / `failed`）一行不改就是控制台要显示的那四个
-- 状态。缺的只有两个时间戳：`created_at` 分不出「排队中」和「正在跑」，而这三栏
-- 存在的全部理由就是这个区别。
--
--   1. `jobs.started_at`     —— Worker 领走它的时刻。NULL 表示还没轮到。
--   2. `jobs.finished_at`    —— 落终态（成功或失败）的时刻。NULL 表示还在跑。
--
-- `jobs` 至今全仓零使用（只有 `packages/core` 的一句类型注释提过它），所以这里
-- 补列是纯加法：没有历史行需要回填，也没有别的读写者要跟着改。
--
-- 生成出来的文件放 `job_artifacts`，不放磁盘、也不放对象存储：
--
--   * **写的人和读的人不是一个进程。** Worker 生成字节，API 送出下载；两个进程
--     唯一的共享物就是这个库。落到某个目录里，就等于要求两者共用一块文件系统
--     （今天确实是同一台机器，但那是部署的巧合，不是这条链的契约）。
--   * **文件没有自己的寿命。** 它属于且只属于一个任务：任务建它、任务删它。
--     `ON DELETE CASCADE` 一行就把这件事说完，而放到磁盘上就得再写一个清理任务，
--     那个任务今天不存在，将来也不会有人记得写。
--   * **它就是行本身的大小。** 一次会话的对话记录是几十 KB 量级；顾客列表受限于
--     这个租户自己的会话数。导出的是已经有了的行，不是新的数据。
--
-- `format` 进主键，因为一个任务同时产出控制台菜单里的两个下载（.xlsx 与对话记录）：
-- 两者是同一次读取的两种排版，不是两次导出。主键也因此顺手挡住「同一任务同一格式
-- 写两遍」——重跑的任务只会覆盖自己上一次的产物。

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

-- 控制台按「本租户最近的任务」列这一页，现有的 (status, created_at) 索引是给
-- 「全平台有哪些待办」用的，方向不对。
CREATE INDEX IF NOT EXISTS jobs_tenant_created_idx ON jobs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_artifacts (
  job_id       TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  -- 下载格式，也是控制台菜单里的两项：表格文件与对话记录。
  format       TEXT NOT NULL CHECK (format IN ('xlsx', 'transcript')),
  file_name    TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        BYTEA NOT NULL,
  byte_count   INTEGER NOT NULL CHECK (byte_count >= 0),
  created_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, format)
);
