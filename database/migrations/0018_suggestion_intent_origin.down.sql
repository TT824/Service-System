-- 0018_suggestion_intent_origin (down)
-- ---------------------------------------------------------------------------
-- Drop the two columns this migration added, and nothing else.
--
-- No data is destroyed that the up file can restore: `intent` and `origin` are
-- facts *about* a set that the set's own candidates, provider and fallback
-- reasons already carry in weaker form, and the up file's backfill recomputes
-- them from exactly those columns. A rollback therefore loses the precision —
-- a chitchat set's emptiness becomes indistinguishable from a failed search
-- again — and loses nothing that was ever the only copy of something.
--
-- The constraints go with the columns; they are dropped by name first so a
-- database that has the columns but not the constraints still rolls back.
-- ---------------------------------------------------------------------------

ALTER TABLE suggestion_sets
  DROP CONSTRAINT IF EXISTS suggestion_sets_intent_check;

ALTER TABLE suggestion_sets
  DROP CONSTRAINT IF EXISTS suggestion_sets_origin_check;

ALTER TABLE suggestion_sets
  DROP COLUMN IF EXISTS intent;

ALTER TABLE suggestion_sets
  DROP COLUMN IF EXISTS origin;
