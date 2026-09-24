-- 0012_suggestion_generation_provider (down)
-- ---------------------------------------------------------------------------
-- Narrow `suggestion_sets.provider` back to the single value `0002` permitted.
--
-- This is the one migration in the set whose reverse **destroys rows**, so the
-- reason is written down rather than assumed. The constraint cannot be narrowed
-- while a row holding `'deepseek'` exists, and there are exactly three ways out:
--
--   * **Rewrite those rows to `'none'`.** Rejected. `provider` is a claim about
--     who wrote the candidates, and this would make every model-written set
--     assert it came from the deterministic engine. That is a silent lie in a
--     column whose whole purpose is to be believed — the same failure mode the
--     embedding provider refuses an echoed model name for.
--   * **Refuse to run while such a row exists.** Rejected. A rollback that
--     cannot complete is not a rollback; it would leave the deployment on
--     `0012` with a hand-written UPDATE as the only way forward, and the person
--     running it at that moment is the least able to decide what to delete.
--   * **Delete those rows.** Taken. A suggestion set is derived state: it is
--     produced from a conversation's question plus knowledge that is not touched
--     here, and re-asking regenerates it. No source row is deleted, no message
--     is deleted, and no conversation is affected — the same reading `0011`'s
--     down migration takes of the index tables.
--
-- Rows already written as `'none'` — every row that predates `0012` — are left
-- exactly as they are; only sets a generation provider wrote are removed.
--
-- The constraint is dropped before the DELETE so the statement cannot trip over
-- the very constraint it is about to replace, and re-added by the same name
-- `0012`'s up used, so the two directions land on the same schema.
-- ---------------------------------------------------------------------------

ALTER TABLE suggestion_sets
  DROP CONSTRAINT IF EXISTS suggestion_sets_provider_check;

DELETE FROM suggestion_sets WHERE provider <> 'none';

ALTER TABLE suggestion_sets
  ADD CONSTRAINT suggestion_sets_provider_check
  CHECK (provider IN ('none'));
