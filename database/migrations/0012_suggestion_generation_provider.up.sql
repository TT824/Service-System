-- 0012_suggestion_generation_provider (up)
-- ---------------------------------------------------------------------------
-- Widen `suggestion_sets.provider` from one permitted value to two.
--
-- `0002` wrote the column as `TEXT NOT NULL DEFAULT 'none' CHECK (provider IN
-- ('none'))`, a constraint with exactly one value in it. That was correct while
-- the deterministic engine was the only thing that could write a set, and it is
-- the reason the column exists at all: it records *which* generator produced a
-- set's candidates, and a set whose candidates came from a model is a different
-- object from one scored out of the tenant's own knowledge. Now that a
-- generation provider exists (M4), the constraint has to admit it — and it stays
-- a closed set rather than becoming free text, so a typo in an INSERT fails
-- loudly instead of writing a provider nothing can interpret.
--
-- Three things this migration deliberately does not do:
--
--   * **No column is added or dropped.** The model that answered is *not*
--     stored; the provider is. That is the same choice `0002` made about the
--     recall legs' scores — the vocabulary a client reads is stable, and the
--     detail lives in the log line — and it is what keeps this migration from
--     having to guess at a model-name format the API is free to rewrite
--     (`deepseek-chat` is answered by `deepseek-flash`; measured 2026-09-18).
--   * **No existing row is touched.** Every row in the table today is `'none'`,
--     which the widened constraint still admits, so this is a widening in the
--     strict sense: the set of accepted values only grows.
--   * **No default changes.** `'none'` remains the default, so an INSERT that
--     says nothing about the provider keeps meaning "the deterministic engine".
--     A writer that used a model has to say so.
--
-- The constraint is dropped by name rather than by a guess: `suggestion_sets_
-- provider_check` is what PostgreSQL generated for `0002`'s inline CHECK, read
-- off the development database with `pg_get_constraintdef` before this file was
-- written. `IF EXISTS` is not defensive habit here — it is what makes the file
-- idempotent against a database whose constraint was already recreated by hand.
-- ---------------------------------------------------------------------------

ALTER TABLE suggestion_sets
  DROP CONSTRAINT IF EXISTS suggestion_sets_provider_check;

ALTER TABLE suggestion_sets
  ADD CONSTRAINT suggestion_sets_provider_check
  CHECK (provider IN ('none', 'deepseek'));
