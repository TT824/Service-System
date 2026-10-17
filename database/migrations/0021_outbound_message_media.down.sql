-- 0021_outbound_message_media (down)
-- ---------------------------------------------------------------------------
-- Puts the vocabulary back to `text`, `image`, `link`, and drops the two columns.
--
-- **This rollback refuses to run if any message is a `video` or a `file`**, and
-- the refusal is the point rather than an accident of ordering. Narrowing the
-- CHECK cannot succeed while rows exist that only the wide one allows, and the
-- two ways out are both worse than a failed rollback:
--
--   * deleting those messages destroys customer conversation. They are on the
--     customer's own phone; this database is the only copy the platform has.
--   * rewriting them as `text` keeps the row and quietly changes what happened —
--     a sentence with a document attached becomes a sentence, and the media
--     columns stay behind on a row that says it is a text message.
--
-- A rollback that stops and says what it found leaves the choice with whoever is
-- rolling back. If the intent really is to go back, do it in that order:
--
--   UPDATE messages SET message_type = 'text'
--    WHERE message_type IN ('video', 'file');
--
-- ...and accept that the transcript now describes those messages wrongly.
--
-- The two dropped columns go with it: every stored file name and every provider
-- `media_id` is lost. Neither is recoverable from anywhere else — the object
-- store holds bytes, not names, and a temporary `media_id` is not ours to keep.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  vocabulary_constraint TEXT;
BEGIN
  FOR vocabulary_constraint IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'messages'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%message_type%'
  LOOP
    EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', vocabulary_constraint);
  END LOOP;
END $$;

ALTER TABLE messages
  ADD CONSTRAINT messages_message_type_check
  CHECK (message_type IN ('text', 'image', 'link'));

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_naming_check;

ALTER TABLE messages
  DROP COLUMN IF EXISTS provider_media_id,
  DROP COLUMN IF EXISTS media_name;
