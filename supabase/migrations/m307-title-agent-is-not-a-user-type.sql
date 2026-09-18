-- m307 — 'title_agent' is a VENDOR, not a user type.
-- ─────────────────────────────────────────────────────────────────────────────
-- users.user_type admitted 'title_agent'. A title agent is not a kind of OS user
-- — it is a settlement-service VENDOR, and the vendor taxonomy already has the
-- right home for one: vendors.category = 'title' (VENDOR_CATEGORY_TITLE, the
-- 38-value taxonomy m304 unified across vendors and vendor_directory, and the
-- token lib/compliance/vendor-respa.ts normalises toward when it classifies a
-- settlement-service provider for RESPA).
--
-- Leaving it admitted invites the drift: a title company gets created as a USER
-- with user_type='title_agent' instead of a vendor row, and then it is invisible
-- to the vendor bench, the title pipeline panel, the RESPA disclosure resolver
-- and vendor_bookings — every surface that knows how to work with a title
-- company reads `vendors`, not `users`.
--
-- SAFE: verified zero rows carry it before applying. Nothing to migrate.
--
-- 'support' stays: it IS a real platform/OS user type (platform staff), already
-- admitted here and now present in the UserDomainRole union too. Like superadmin
-- it never consumes a tenant seat.

DO $$
DECLARE offending int;
BEGIN
  SELECT count(*) INTO offending FROM users WHERE user_type = 'title_agent';
  IF offending > 0 THEN
    RAISE EXCEPTION 'm307 aborted: % users still carry user_type=title_agent. Convert them to vendors (category=title) first.', offending;
  END IF;
END $$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;

ALTER TABLE users ADD CONSTRAINT users_user_type_check CHECK (
  user_type = ANY (ARRAY[
    'admin', 'agent', 'broker', 'broker_owner', 'compliance_officer', 'contact',
    'isa', 'lender', 'superadmin', 'support', 'system', 'tc', 'team_lead', 'vendor'
  ])
);

COMMENT ON COLUMN users.user_type IS
  'The user''s PRIMARY type. A user may hold additional roles in user_role_assignments — permissions consider both, and a seat counts the PERSON once regardless of how many roles they hold (lib/kernel/seat-usage.ts). ''title_agent'' was removed in m307: a title company is a VENDOR (vendors.category=''title''), not an OS user, and admitting it here let one be created where no vendor surface could see it.';
