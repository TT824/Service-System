-- 0015_user_account_avatar (up)
-- ---------------------------------------------------------------------------
-- Gives an account a face.
--
-- The console shows an avatar next to the operator's own name, and until now it
-- had nothing to show but the first letter of the display name. This column is
-- where the picture an operator picks for themselves is kept.
--
-- It holds the image itself as a base64 `data:` URL, not a pointer to one. That
-- is the deliberate choice here, and the reason is what the alternative would
-- have cost: the avatar travels inside the `/auth/session` payload, which is the
-- call the console makes to decide what to render at all. A URL to object
-- storage would put a second service between an operator and their own picture
-- (one that can be down while the console is up), give the URL a lifetime that
-- has to outlive every session that carries it, and leave an object behind on
-- every change of mind. What a bucket buys is size, and size is what the CHECK
-- below refuses to be surprised by.
--
-- The bound is length, and it is the same number the domain enforces
-- (`AVATAR_MAX_DATA_URL_LENGTH`): 65536 base64 characters is just under 48 KiB
-- of image, several times what a 96-pixel WebP or PNG needs, and still small
-- enough that one account stays a rounding error in the payload it rides in.
-- The constraint is written here as a backstop rather than as the rule — the
-- rule is in `packages/core/src/auth/avatar.ts`, where it can say *why* a value
-- was refused. All this row can do is refuse to become an unbounded row.
--
-- `LIKE 'data:image/%'` is the cheap half of that: it keeps the column from
-- becoming a place to park arbitrary text. It is not an allow-list of media
-- types — PostgreSQL cannot see which media types the platform accepts, and
-- `image/svg+xml` is exactly the string this pattern would let through. The
-- allow-list is the domain's, and the domain is what validates every write.

ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Guarded by a lookup because `ADD CONSTRAINT` has no `IF NOT EXISTS` form.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_accounts_avatar_url_check'
  ) THEN
    ALTER TABLE user_accounts ADD CONSTRAINT user_accounts_avatar_url_check
      CHECK (
        avatar_url IS NULL
        OR (avatar_url LIKE 'data:image/%' AND length(avatar_url) <= 65536)
      );
  END IF;
END $$;
