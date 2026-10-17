-- Internal attachments: the pictures, videos and documents colleagues send
-- each other.
--
-- A table of its own rather than columns on `internal_messages`, and the row is
-- created by the *upload* rather than by the send. That order is the design: by
-- the time a message names an attachment, the bytes are already in the object
-- store, so a message either points at a file that exists or at nothing at all.
-- The transcript can never show a file that was promised and never written.
--
-- `message_id` is the claim. It stays NULL while the attachment is a draft the
-- sender may still remove, and it is set to the message that named it exactly
-- once — inside that message's own transaction, with `WHERE message_id IS NULL`
-- — which is what stops one upload from being attached to two messages, or the
-- same draft from being sent twice by a double-click. The partial unique index
-- states the other half of that rule where the database can enforce it: a
-- message carries at most one attachment, which is what the message view's
-- single `attachment` field means.
--
-- ON DELETE CASCADE on `message_id`, because an attachment whose message is
-- gone is not a draft anybody can still send — it is rubbish, and the object
-- store's own key namespace can enumerate whatever bytes outlive it.

CREATE TABLE IF NOT EXISTS internal_attachments (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id           TEXT NOT NULL REFERENCES internal_threads(id) ON DELETE CASCADE,
  uploader_member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- Derived from the content type at upload, never taken from the client. It
  -- decides which size limit applied and whether the bytes may ever be served
  -- inline: only image and video are, and only from a closed allowlist of
  -- types. Everything else is downloaded as an opaque file.
  kind                TEXT NOT NULL CHECK (kind IN ('image', 'video', 'file')),
  file_name           TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  byte_size           INTEGER NOT NULL CHECK (byte_size > 0),
  -- The object storage key. Recorded rather than derived from the id, so a
  -- change of key scheme cannot orphan the rows written under the old one.
  object_key          TEXT NOT NULL,
  message_id          TEXT REFERENCES internal_messages(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL
);

-- "the attachment of this message", which is the only lookup the read and the
-- serve paths make, and at the same time the one-attachment-per-message rule.
CREATE UNIQUE INDEX IF NOT EXISTS internal_attachments_message_idx
  ON internal_attachments (message_id) WHERE message_id IS NOT NULL;
