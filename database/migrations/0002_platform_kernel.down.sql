-- 0002_platform_kernel (down)
-- ---------------------------------------------------------------------------
-- Drop the platform kernel data model in reverse dependency order.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS retention_policies;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS approved_phrases;
DROP TABLE IF EXISTS review_policy;
DROP TABLE IF EXISTS suggestion_sets;
DROP TABLE IF EXISTS shortcuts;
DROP TABLE IF EXISTS faqs;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS stores;
DROP TABLE IF EXISTS tenants;
