-- 0005_platform_admin_member_invariant (down)
-- ---------------------------------------------------------------------------
-- Revert to the member role/tenant rule migration `0002` declared: the strict
-- one this migration added is dropped first, and the original weak one is
-- declared second, so the table is never without the rule it had before.
--
-- Order is what makes the revert safe to run: the strict rule is a strict
-- subset of the original, so a database that satisfied it satisfies the
-- original as well and no existing row has to change. Dropping and adding in
-- the other order would briefly refuse rows the original accepts.
--
-- The restored constraint is deliberately declared unnamed, exactly as `0002`
-- declared it; the matching `up` file finds it by its definition rather than by
-- a generated name.
-- ---------------------------------------------------------------------------

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_platform_admin_tenant_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'members'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%platform_admin%'
       AND pg_get_constraintdef(oid) LIKE '%tenant_id IS NOT NULL%'
  ) THEN
    ALTER TABLE members ADD CHECK (role = 'platform_admin' OR tenant_id IS NOT NULL);
  END IF;
END $$;
