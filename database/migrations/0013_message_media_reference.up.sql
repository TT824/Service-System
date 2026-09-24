-- 0013_message_media_reference (up)
-- ---------------------------------------------------------------------------
-- Give a message somewhere to record that its picture is stored somewhere.
--
-- Until now a customer's image reached the platform as a message whose
-- `content` was the string `[图片消息]` and whose bytes were dropped on the
-- floor by the inbound path. That is a placeholder for a fact, and it is the
-- best that could be done without object storage — but it is not the fact, and
-- an agent looking at a customer's photo cannot answer from it. This migration
-- adds the reference; the pipeline that fills it is the same change's other
-- half.
--
-- Three columns rather than one JSON blob, because the readers each need a
-- different one and none of them wants to parse:
--
--   * **`media_key`** — the object store key, built by
--     `mediaObjectKey(tenantId, messageId)` in the API. **NULL is the whole
--     degrade signal**: no key means nothing was stored, and the transcript
--     falls back to the placeholder it shows today. This column is also what
--     makes the reference self-describing at the row level — a message either
--     has an object behind it or it does not, and no reader has to consult the
--     store to find out.
--   * **`media_mime`** — what the provider said the bytes were, carried from
--     the download so that a reader knows whether this is a picture without a
--     round trip to the store, and without re-deriving it from the file's
--     leading bytes.
--   * **`media_bytes`** — the size, so the console can reserve the image's box
--     before it has loaded. That is a layout-shift fix, not bookkeeping: a
--     transcript that grows a 400-pixel-tall bubble after the fact moves the
--     message the reader was about to click.
--
-- What this migration deliberately does not do:
--
--   * **No `NOT NULL`, no default.** A message without media is the ordinary
--     case (every text message, every voice note, every picture the platform
--     failed to fetch), and it has to stay cheap. There is no value of these
--     columns that could stand for "not applicable" — NULL already says it.
--   * **No vocabulary check on `media_mime`.** The provider's content type is
--     reported, not vetted. A closed set here would reject a legitimate type
--     the day a customer sends one, and the pipeline already refuses anything
--     it has no business storing (size, and message type).
--   * **No `BIGINT`.** `media_bytes` describes an object the write path caps at
--     2 MB, which `INTEGER` holds with three orders of magnitude to spare.
--   * **No index.** The only lookup is by message id, which is the primary key,
--     and there is no query in this slice that scans for messages *by* their
--     media. Adding one now would be an index maintained for a reader that does
--     not exist.
--   * **No change to `message_type`'s CHECK or to any existing row.** An image
--     message stays an image message; the columns are additive and every row
--     that exists today is NULL in all three, which is the truth about it.
--
-- The three columns are one fact split in three, so the CHECK below keeps a
-- half-written row from existing: a key with no type or no size is a state no
-- reader handles, and the step that writes them writes them together.
-- ---------------------------------------------------------------------------

ALTER TABLE messages
  ADD COLUMN media_key TEXT,
  ADD COLUMN media_mime TEXT,
  ADD COLUMN media_bytes INTEGER;

ALTER TABLE messages
  ADD CONSTRAINT messages_media_reference_check
  CHECK (
    (media_key IS NULL) = (media_mime IS NULL)
    AND (media_key IS NULL) = (media_bytes IS NULL)
  );
