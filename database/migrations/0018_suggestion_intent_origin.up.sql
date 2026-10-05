-- 0018_suggestion_intent_origin (up)
-- ---------------------------------------------------------------------------
-- Record *why* a suggestion set holds what it holds: what the message was read
-- as, and what the candidates actually are.
--
-- Both facts are added because the workspace's assist panel gained an intent
-- gate and a retrieval-first rule, and each of them makes a set that the
-- existing columns cannot explain:
--
--   * A `chitchat` set is empty **by design** — nothing was retrieved, nothing
--     was generated. `candidates = '[]'` alone cannot say that; it reads exactly
--     like a failed search waiting for an operator to investigate. `intent`
--     records the reading, and `chitchat_no_retrieval` on the set's
--     `fallback_reasons` records that the emptiness was the decision.
--   * A 话术库 hit is returned *instead of* asking a model, so a deployment with
--     a configured provider records `provider = 'none'` on a set it deliberately
--     did not generate for. `origin` separates that from the other two ways to
--     reach the same columns: the 商品库 answering from the tenant's own data,
--     and a model having written the text (`provider = 'deepseek'`).
--
-- `intent` is not derivable from anything already stored, so it is a new column
-- rather than a reason string: the classification rule (see
-- `packages/core/src/platform/intent.ts`) is free to change, and a set has to
-- keep saying what *it* was classified as, not what today's rule would say.
--
-- Three things this migration deliberately does not do:
--
--   * **No existing row is left NULL.** The columns are added nullable, filled,
--     and only then made NOT NULL — so the file works on a table with rows,
--     which `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` would too, but the
--     backfill below is where the truth of those rows is decided, and it is worth
--     reading. Historical rows were written before either rule existed, and the
--     reading is: every one of them went through retrieval (`intent =
--     'question'`), and their candidates came from a shortcut/FAQ, from the
--     catalogue, or from nowhere at all.
--   * **No value is invented for a row whose candidates say what it was.** The
--     `origin` backfill reads the persisted candidates rather than assuming
--     `'catalogue'`: a set every one of whose candidates is a shortcut or a FAQ
--     reached that state by the same rule this migration exists for, and it would
--     be a lie to file it under the catalogue.
--   * **No default change that a writer may rely on silently.** Both columns keep
--     a default so the table stays writable by an older binary during a
--     rolling deploy, and the API's repository still passes both explicitly —
--     the same choice `PlatformRepository.createSuggestionSet` makes about
--     `provider` (see `CreateSuggestionSetRecord`).
--
-- Constraint names are the ones PostgreSQL generates for these inline CHECKs;
-- dropped by name with `IF EXISTS` so the file is idempotent against a database
-- whose constraints were already created by hand, exactly as `0012` is.
-- ---------------------------------------------------------------------------

ALTER TABLE suggestion_sets
  ADD COLUMN IF NOT EXISTS intent TEXT;

ALTER TABLE suggestion_sets
  ADD COLUMN IF NOT EXISTS origin TEXT;

-- Every set written before this migration was retrieved for: there was no
-- chitchat branch to skip it.
UPDATE suggestion_sets
SET intent = 'question'
WHERE intent IS NULL;

-- What the candidates themselves say: none, all 话术库, or the catalogue.
UPDATE suggestion_sets
SET origin = CASE
  WHEN jsonb_array_length(candidates) = 0 THEN 'none'
  WHEN NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(candidates) AS candidate
    WHERE candidate ->> 'kind' NOT IN ('faq', 'shortcut')
  ) THEN 'script'
  ELSE 'catalogue'
END
WHERE origin IS NULL;

ALTER TABLE suggestion_sets
  ALTER COLUMN intent SET DEFAULT 'question';

ALTER TABLE suggestion_sets
  ALTER COLUMN origin SET DEFAULT 'none';

ALTER TABLE suggestion_sets
  ALTER COLUMN intent SET NOT NULL;

ALTER TABLE suggestion_sets
  ALTER COLUMN origin SET NOT NULL;

ALTER TABLE suggestion_sets
  DROP CONSTRAINT IF EXISTS suggestion_sets_intent_check;

ALTER TABLE suggestion_sets
  ADD CONSTRAINT suggestion_sets_intent_check
  CHECK (intent IN ('chitchat', 'question'));

ALTER TABLE suggestion_sets
  DROP CONSTRAINT IF EXISTS suggestion_sets_origin_check;

ALTER TABLE suggestion_sets
  ADD CONSTRAINT suggestion_sets_origin_check
  CHECK (origin IN ('script', 'catalogue', 'generated', 'none'));
