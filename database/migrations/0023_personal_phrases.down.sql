-- 0023_personal_phrases (down)
-- ---------------------------------------------------------------------------
-- Drops the 个人快捷短语 table. `shortcuts`, `faqs` and the knowledge tables are
-- untouched, so a rollback loses only the phrases each agent wrote for
-- themselves — the replies they type by hand still send, and the tenant's shared
-- phrases still resolve exactly as `0010` left them.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS personal_phrases;
