-- 0003_auth_identity (down)
-- ---------------------------------------------------------------------------
-- Revert the identity foundation added by 0003, in reverse dependency order:
-- child tables first, then the composite foreign-key targets they relied on.
--
-- The composite constraints are dropped after every table that referenced them
-- is gone, so the down file is valid on its own and after 0004 has already been
-- reverted.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS member_store_scopes;
DROP TABLE IF EXISTS member_user_links;
DROP TABLE IF EXISTS user_identities;
DROP TABLE IF EXISTS user_accounts;

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_tenant_id_id_key;
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_tenant_id_id_key;
