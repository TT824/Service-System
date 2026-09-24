-- 0013_message_media_reference (down)
-- ---------------------------------------------------------------------------
-- Remove the media reference from `messages`.
--
-- This reverses the schema and nothing else, and the asymmetry is worth stating
-- plainly rather than discovering later: **the stored objects are not deleted,
-- and no SQL could delete them.** Dropping `media_key` forgets which object
-- belonged to which message, so a rollback leaves every picture this deployment
-- had fetched sitting in the `media` bucket with nothing pointing at it.
--
-- That is the accepted cost, for three reasons:
--
--   * **The loss is recoverable in one direction only, and that is the useful
--     direction.** Re-applying the up migration restores the columns, but the
--     keys it would need are gone with the rows — they are not derivable from
--     anything left in the database. The messages themselves survive: their
--     `content` is the same `[图片消息]` placeholder the pre-0013 code wrote, so
--     a rolled-back deployment renders exactly as it did before this change.
--   * **The objects are enumerable.** `mediaObjectKey` namespaces them as
--     `tenants/<tenant>/messages/<message>/`, so the orphans can be listed and
--     swept from the bucket without a database join. A rollback that needs the
--     space has a way to get it; a rollback that does not can leave them.
--   * **Refusing to run instead would be worse.** A down migration that fails
--     while rows have media would strand the deployment on 0013 with a
--     hand-written `UPDATE ... SET media_key = NULL` as the only way back —
--     the same reasoning `0012`'s down migration records for deleting derived
--     rows rather than blocking.
--
-- The constraint goes before the columns that carry it, so the statement cannot
-- depend on the implicit drop order.
-- ---------------------------------------------------------------------------

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_media_reference_check;

ALTER TABLE messages
  DROP COLUMN IF EXISTS media_key,
  DROP COLUMN IF EXISTS media_mime,
  DROP COLUMN IF EXISTS media_bytes;
