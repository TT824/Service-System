-- 0015_user_account_avatar (down)
-- ---------------------------------------------------------------------------
-- Drops the account avatar.
--
-- This one really does lose data: the images live in the column, so there is no
-- object left in a bucket to point at afterwards and no way to recover them from
-- anywhere but a backup. Rolling back is choosing to lose every avatar that was
-- uploaded, and the console returns to drawing the first letter of the display
-- name — which is what it did before `0015`, so nothing breaks; it just forgets.

ALTER TABLE user_accounts DROP CONSTRAINT IF EXISTS user_accounts_avatar_url_check;
ALTER TABLE user_accounts DROP COLUMN IF EXISTS avatar_url;
