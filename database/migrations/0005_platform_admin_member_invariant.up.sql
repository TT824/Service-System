-- 0005_platform_admin_member_invariant (up)
-- ---------------------------------------------------------------------------
-- Make the platform administrator identity exact: a `platform_admin` member is
-- platform-level and belongs to no tenant, and every other member belongs to
-- one.
--
-- Migration `0002` declared only half of that rule
-- (`role = 'platform_admin' OR tenant_id IS NOT NULL`), which allowed a
-- platform administrator *inside* a tenant. Such a row resolves to a platform
-- role and a tenant context at the same time, and that is what let a merchant
-- administrator mint platform authority — create or promote an own-tenant
-- member, bind an account to it, and reach the platform-wide account
-- lifecycle.
--
-- The weak constraint `0002` declared is unnamed, so PostgreSQL generated its
-- name (`members_check` on a database this migration was written against). It
-- is found by what it says rather than by guessing that name, so the
-- replacement works whatever the generated name turned out to be. The strict
-- rule is added under an explicit name so it can be dropped again.
--
-- The migration is forward-only and never rewrites `0002`. It fails loudly,
-- leaving the schema and the running application untouched, when a database
-- still holds a row that violates the rule — resolve those rows first by
-- clearing the member's tenant or by giving it the tenant role it actually
-- holds.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  weak_constraint text;
BEGIN
  FOR weak_constraint IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'members'::regclass
       AND contype = 'c'
       AND conname <> 'members_platform_admin_tenant_check'
       AND pg_get_constraintdef(oid) LIKE '%platform_admin%'
       AND pg_get_constraintdef(oid) LIKE '%tenant_id IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE members DROP CONSTRAINT %I', weak_constraint);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'members_platform_admin_tenant_check'
  ) THEN
    ALTER TABLE members ADD CONSTRAINT members_platform_admin_tenant_check
      CHECK (
        (role = 'platform_admin' AND tenant_id IS NULL)
        OR (role <> 'platform_admin' AND tenant_id IS NOT NULL)
      );
  END IF;
END $$;
