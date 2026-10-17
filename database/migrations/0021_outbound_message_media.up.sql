-- 0021_outbound_message_media (up)
-- ---------------------------------------------------------------------------
-- What a seat sends *to* a customer when it is not words: a picture, a clip, a
-- document.
--
-- Two changes, one subject. `message_type` learns the two words the provider
-- already had — `video` and `file` — and `messages` learns two more columns:
-- the name of the media, and the provider's own handle for it. Nothing else is
-- added: no attachment table, no draft, no claim.
--
-- **Why there is no staging table here, when `0020` has one.** The two look like
-- the same problem and are not. A colleague's attachment is uploaded *before*
-- the message that names it exists, because the console sends it in two steps —
-- pick, then send — and because the bytes are the platform's own business from
-- end to end. A customer-facing attachment is the opposite in both respects:
-- the upload happens *inside* the send, and it is not really an upload to us at
-- all. The provider requires its own copy — WeCom will not accept a message that
-- names a `media_id` it has never been given, and the provider's temporary media
-- expires in three days, so a `media_id` obtained at picking time could be dead
-- by the time the seat presses send. So the run is:
--
--   1. validate the file against the channel's limits,
--   2. upload the bytes to the provider, which answers with a `media_id`,
--   3. write the message row — naming that `media_id`, and writing our own copy
--      of the bytes to object storage under `media_object_key`,
--   4. hand the row to the outbox.
--
-- Step 3 is the only moment a row exists, and by then every fact it records is
-- already true. There is no window in which a message promises a file nobody
-- has, which is the property `0020`'s two-step ordering was built to protect —
-- reached here by not needing the first step at all.
--
-- **Why the vocabulary lives on the CHECK rather than in a column of its own.**
-- `image` was already a `message_type`; a sent picture and a received picture
-- are the same kind of thing and a transcript renders them the same way. Giving
-- outbound media its own kind column would make "what is this message" a
-- question with two answers that have to be kept in step.
--
-- **Why `provider_media_id` is on the message and not only in flight.** The
-- worker that retries a failed delivery has no adapter of its own and no access
-- to object storage — `media-storage.ts` says so in as many words ("the worker
-- and the console never touch stored media"). A retry can only re-send what the
-- row already says, so the handle has to be written where the row is.
--
-- **Why `media_name`.** `media_mime` says how to treat the bytes and `media_key`
-- says where they are, but neither says what the file was *called*, and for a
-- document and a clip that name is the message: `报价单-2026-10.xlsx` is what
-- the customer sees on the bubble and what the seat sees when the transcript
-- comes back a week later. NULL for an inbound picture, where the provider gives
-- us no name of its own.
--
-- Only the outbound path fills the last two. An inbound picture keeps exactly
-- the three columns `0013` gave it: the provider's `media_id` it arrived with is
-- not recorded, because it expires in three days and we have already downloaded
-- the bytes it pointed at.
-- ---------------------------------------------------------------------------

-- The vocabulary check is widened rather than replaced by name, because a
-- column CHECK written inline in `0002` was named by PostgreSQL and by nothing
-- else. Dropping it by a guessed name with IF EXISTS would either fail loudly
-- (harmless) or, if the guess were wrong in the other direction, leave the
-- narrow check in place while a second one was added — and then every image and
-- file would still be refused with a migration that reported success. Finding
-- it by what it constrains cannot be wrong that way.
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
  CHECK (message_type IN ('text', 'image', 'video', 'file', 'link'));

ALTER TABLE messages
  ADD COLUMN media_name TEXT,
  ADD COLUMN provider_media_id TEXT;

-- One fact split five ways, so the rule "all of it or none of it" grows by two.
-- A name with no object behind it and a provider handle with no media are both
-- states no reader handles, and the step that writes them writes them together:
-- a document's name arrives with the document, and a `media_id` is obtained
-- immediately before the row that records it.
--
-- `0013`'s own check is left exactly as it was and this one is added beside it.
-- Rewriting it would have meant dropping a constraint that already holds, for a
-- statement that reads better only in the diff.
ALTER TABLE messages
  ADD CONSTRAINT messages_media_naming_check
  CHECK (
    (media_name IS NULL OR media_key IS NOT NULL)
    AND (provider_media_id IS NULL OR media_key IS NOT NULL)
  );
