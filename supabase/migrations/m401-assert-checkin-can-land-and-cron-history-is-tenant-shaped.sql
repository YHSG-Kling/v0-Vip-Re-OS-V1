-- m401 — the assertion half of m400, and the reason it is a separate file.
--
-- A `raise` rolls back its whole transaction. Asserting inside m400 would undo
-- the DROP NOT NULL and the policy rewrite along with the failure, leaving the
-- database exactly as broken as before with a red migration as the only
-- difference. Split, m400 COMMITs and this fails afterwards on the genuine
-- remainder. Same reason m399 is split from m398, m397 from m396, m393 from
-- m392.
--
-- EVERY ASSERTION BELOW QUERIES THE CATALOG FOR THE CONSTRUCT, never a policy
-- name's spelling. A gate that keys on `polname = 'cron_health_snapshot_admin_
-- select'` is a spelling test wearing a security label: rename the policy and it
-- goes green over the identical hole. So these ask pg_attribute what the column
-- allows and pg_policy what the EXPRESSION says.

DO $$
DECLARE
  v_notnull   boolean;
  v_fk        integer;
  v_writes    text;
  v_select    integer;
  v_badsel    text;
  v_tenant    integer;
  v_bad       text;
BEGIN

  -- ═════════════════════════════════════════════════════════════════════════
  -- A1 — the open-house kiosk check-in can physically land a row.
  -- ═════════════════════════════════════════════════════════════════════════
  --
  -- Asserted on the COLUMN, not on the migration having run. `contact_id NOT
  -- NULL` is what refused every walk-in check-in with 23502; the public kiosk
  -- writer has no contact to give it and, by product decision, must not invent
  -- one (convertAttendeeToContact creates it later and refuses to run when this
  -- column is already set).
  SELECT a.attnotnull INTO v_notnull
  FROM pg_attribute a
  WHERE a.attrelid = 'public.open_house_attendees'::regclass
    AND a.attname  = 'contact_id'
    AND a.attnum > 0 AND NOT a.attisdropped;

  IF v_notnull IS NULL THEN
    RAISE EXCEPTION
      'A1 FAILED: open_house_attendees.contact_id does not exist. The column the '
      'kiosk check-in and convertAttendeeToContact both depend on is gone.';
  END IF;

  IF v_notnull THEN
    RAISE EXCEPTION
      'A1 FAILED: open_house_attendees.contact_id is NOT NULL again. Every '
      'walk-in check-in through app/actions/seller-open-house.ts:checkInAttendee '
      'is refused 23502 — the public open-house kiosk is dead. If a contact is '
      'now genuinely resolved before insert, say so in DDL in its own migration '
      'and update this assertion deliberately; do not satisfy it by deleting '
      'this file.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- A2 — …and the referential guarantee was not traded away to get there.
  -- ═════════════════════════════════════════════════════════════════════════
  --
  -- Dropping the FOREIGN KEY instead of the NOT NULL would also make check-in
  -- "work", and would pass A1, while letting an attendee point at a contact that
  -- does not exist. NULLABLE-BUT-REFERENTIAL is the shape m400 chose; this pins
  -- the half A1 cannot see.
  SELECT count(*) INTO v_fk
  FROM pg_constraint c
  WHERE c.conrelid = 'public.open_house_attendees'::regclass
    AND c.contype  = 'f'
    AND c.confrelid = 'public.contacts'::regclass
    AND (SELECT a.attname
         FROM pg_attribute a
         WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) = 'contact_id';

  IF v_fk = 0 THEN
    RAISE EXCEPTION
      'A2 FAILED: open_house_attendees.contact_id no longer has a FOREIGN KEY to '
      'contacts(id). m400 made the column NULLABLE, not unconstrained — a '
      'stamped value must still be a real contact.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- A3 — cron_health_snapshot is READ-ONLY to every non-bypassing role.
  -- ═════════════════════════════════════════════════════════════════════════
  --
  -- The defect m400 closed: one FOR ALL policy meant any broker or team_lead of
  -- any tenant could blank a failing cron's record or delete the platform's
  -- entire cron ledger. Asserted as the ABSENCE OF A WRITE-CAPABLE POLICY,
  -- role-blind and name-blind: polcmd 'a' (INSERT), 'w' (UPDATE), 'd' (DELETE)
  -- or '*' (ALL) are all the same grant in different spellings. Writers are
  -- service-role clients, which bypass RLS and need no policy.
  SELECT string_agg(p.polname || ' (cmd=' || p.polcmd || ')', ', ')
    INTO v_writes
  FROM pg_policy p
  WHERE p.polrelid = 'public.cron_health_snapshot'::regclass
    AND p.polcmd IN ('a', 'w', 'd', '*');

  IF v_writes IS NOT NULL THEN
    RAISE EXCEPTION
      'A3 FAILED: cron_health_snapshot has write-capable policies: %. This table '
      'is platform infrastructure with no brokerage_id, and a write grant here '
      'lets any broker forge or erase the platform cron ledger. Its only writer '
      'is lib/kernel/cron-logging.ts on a SERVICE client, which bypasses RLS and '
      'needs no policy.', v_writes;
  END IF;

  -- …and it did not become read-only by becoming unreadable. A table with RLS on
  -- and zero policies passes the check above for the wrong reason: the cron
  -- health console would render empty for everyone.
  SELECT count(*) INTO v_select
  FROM pg_policy p
  WHERE p.polrelid = 'public.cron_health_snapshot'::regclass
    AND p.polcmd = 'r';

  IF v_select = 0 THEN
    RAISE EXCEPTION
      'A3 FAILED: cron_health_snapshot has no SELECT policy at all. Writes being '
      'refused is the goal; reads being refused makes /dashboard/admin/cron-health '
      'render empty for every role, which is the "absence of measurement read as '
      'health" failure this tree exists to prevent.';
  END IF;

  -- A SELECT policy that reaches `anon` would publish platform operational state
  -- — including cron names and failure text — to logged-out callers.
  SELECT string_agg(p.polname, ', ') INTO v_badsel
  FROM pg_policy p
  WHERE p.polrelid = 'public.cron_health_snapshot'::regclass
    AND p.polcmd = 'r'
    AND (p.polroles = '{0}'::oid[] OR 0 = ANY(p.polroles)
         OR EXISTS (SELECT 1 FROM pg_roles r
                    WHERE r.oid = ANY(p.polroles) AND r.rolname = 'anon'));

  IF v_badsel IS NOT NULL THEN
    RAISE EXCEPTION
      'A3 FAILED: cron_health_snapshot SELECT policy % is granted to PUBLIC or '
      'anon. Platform cron names, timings and failure text must not be readable '
      'by a logged-out caller.', v_badsel;
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- A4 — cron_execution_logs still carries the tenant-shaped SELECT policy the
  --      two platform readers were rewritten to MATCH.
  -- ═════════════════════════════════════════════════════════════════════════
  --
  -- `app/actions/pl-truth-engine.ts:getCronHealth` and
  -- `lib/kernel/scraping.ts:loadScrapingDiagnostics` both read this ledger on a
  -- SERVICE client, so RLS is bypassed and their `.or("brokerage_id.is.null,
  -- brokerage_id.eq.<caller>")` predicate IS the boundary. They were written to
  -- compute exactly what this policy computes, so that a session-client reader
  -- and a service-client reader can never disagree about who owns a cron run.
  -- If this policy is ever narrowed to a bare `brokerage_id =
  -- current_user_brokerage_id()`, those two readers become STRICTLY WIDER than
  -- the policy they claim to mirror, and the comments in both files become lies.
  --
  -- Asserted on the EXPRESSION: it must consult `brokerage_id`, and it must
  -- still admit the untenanted row. The NULL disjunct is not incidental — every
  -- row this ledger currently receives is untenanted (all 130
  -- createCronRunContextAction call sites pass no brokerage_id; the two direct
  -- writers stamp an explicit `brokerage_id: null`), so a policy that drops it
  -- makes the cron health page blank rather than safe.
  SELECT count(*) INTO v_tenant
  FROM pg_policy p
  WHERE p.polrelid = 'public.cron_execution_logs'::regclass
    AND p.polcmd = 'r'
    AND pg_get_expr(p.polqual, p.polrelid) LIKE '%brokerage_id%'
    AND pg_get_expr(p.polqual, p.polrelid) LIKE '%brokerage_id IS NULL%';

  IF v_tenant = 0 THEN
    RAISE EXCEPTION
      'A4 FAILED: cron_execution_logs has no SELECT policy that both consults '
      'brokerage_id and admits the untenanted (brokerage_id IS NULL) platform '
      'sweep. The two service-client readers of this ledger were written to '
      'mirror that exact shape; if the policy changed, change them in the same '
      'wave rather than letting them drift wider than the policy.';
  END IF;

  -- And no SELECT policy on this ledger may reach anon: cron job names and
  -- failure messages are operational detail about the platform and its tenants.
  SELECT string_agg(p.polname, ', ') INTO v_bad
  FROM pg_policy p
  WHERE p.polrelid = 'public.cron_execution_logs'::regclass
    AND p.polcmd = 'r'
    AND (p.polroles = '{0}'::oid[] OR 0 = ANY(p.polroles)
         OR EXISTS (SELECT 1 FROM pg_roles r
                    WHERE r.oid = ANY(p.polroles) AND r.rolname = 'anon'));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'A4 FAILED: cron_execution_logs SELECT policy % is granted to PUBLIC or '
      'anon.', v_bad;
  END IF;

  RAISE NOTICE 'm401 OK — A1 attendee contact_id nullable, A2 FK intact, A3 cron_health_snapshot read-only + not anon, A4 cron_execution_logs tenant-shaped + not anon.';
END $$;
