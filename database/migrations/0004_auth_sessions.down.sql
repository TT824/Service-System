-- 0004_auth_sessions (down)
-- ---------------------------------------------------------------------------
-- Revert the authentication runtime tables. `auth_sessions` references both
-- `trusted_devices` and `user_accounts`, so it is dropped first and the
-- remaining tables keep no dependency on each other.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS trusted_devices;
DROP TABLE IF EXISTS otp_challenges;
