-- 0023_personal_phrases (up)
-- ---------------------------------------------------------------------------
-- 个人快捷短语: the canned replies one agent keeps for themselves.
--
-- One table is added, and nothing else:
--
--   * `personal_phrases` is one row per phrase, owned by exactly one member of
--     one tenant.
--
-- ## Why this is not a `shortcuts` row with a different owner
--
-- `shortcuts` (`0002`, extended by `0010`) is tenant knowledge: 本店发货时效 is
-- the same answer whoever gives it, which is why it carries a `code` other rows
-- can point at, an intent, a scope and a store. A personal phrase is a working
-- note — 欢迎语 in one's own words — that no other seat may read, so it has no
-- scope to set, nobody to share it with and no reason to be addressed by a code.
-- Folding the two together would give one table a `member_id` that is
-- meaningless on half its rows and a `code` that is meaningless on the other
-- half.
--
-- ## The owner is a column, never a filter from the request
--
-- `member_id` is `NOT NULL REFERENCES members(id)`. The API takes it from the
-- authenticated session and puts it in the `WHERE` clause of every read, so the
-- isolation is the storage layer's rather than a comparison each handler has to
-- remember to make. A row that is not the caller's is never selected.
--
-- `ON DELETE CASCADE`, unlike `conversation_routing_weights.updated_by`: a
-- routing weight is deployment policy that outlives the administrator who chose
-- it, while a personal phrase with no owner is a note addressed to nobody and
-- would be readable by no one. Deleting the member deletes it.
--
-- ## No version column, no delete
--
-- The same concurrency story as `shortcuts`: phrases are edited by the one
-- person who can see them, so a lost update needs that person editing from two
-- devices within one round trip. There is no `state_version` here and no DELETE
-- — `enabled = FALSE` retires a phrase, and a retired phrase is still the
-- agent's to bring back.
--
-- ## Keyword search
--
-- `keywords` is a `TEXT[]` because it is read whole and matched in the
-- application, exactly like `faqs.tags`: the words are a few short strings per
-- row, and a normalized child table would buy nothing the phrase list needs.
-- The `NOT NULL DEFAULT '{}'` is what lets a phrase be created with no
-- keywords at all.
--
-- Forward-only and additive: no existing table, column or row is touched. Every
-- statement is guarded, so the file is also safe to re-run by hand.
--
-- Secret handling: a phrase is text an agent wrote for themselves. No column
-- here holds a credential or a customer's data.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS personal_phrases (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- The display grouping the phrases page filters by. Free text, not an enum:
  -- agents invent their own buckets (售前 / 跟进 / 退换货) and the taxonomy is
  -- per person, so validating it against a fixed list would only cost them.
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  keywords    TEXT[] NOT NULL DEFAULT '{}',
  text        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);

-- "my phrases, newest first" is the only list query there is. The trailing
-- `id DESC` of that query is not in the index; it only breaks ties between rows
-- written in the same millisecond, so the sort never falls back to reading more
-- than this range.
CREATE INDEX IF NOT EXISTS personal_phrases_tenant_member_created_idx
  ON personal_phrases (tenant_id, member_id, created_at DESC);
