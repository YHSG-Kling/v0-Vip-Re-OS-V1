-- m400 — two structural corrections behind the open-house check-in and the
-- cron health console. THIS FILE ONLY CHANGES THINGS; every assertion about it
-- lives in m401, because a `raise` rolls back its own transaction and an
-- assertion that fails here would revert the very fix it was checking.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — `open_house_attendees.contact_id`: NOT NULL contradicts the
--          lifecycle the application actually implements.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The column is `uuid NOT NULL` with NO default, and the table has NO trigger
-- (verified against pg_attribute / pg_trigger on the live database, not read off
-- a migration file — six migrations in this tree were recently found never to
-- have been applied).
--
-- The public kiosk check-in, `app/actions/seller-open-house.ts:checkInAttendee`,
-- captures a walk-in visitor who by definition is NOT yet a contact: it is an
-- unauthenticated endpoint that takes a name and an optional email. It sends no
-- `contact_id`, so EVERY call it has ever made was refused:
--
--     SQLSTATE 23502: null value in column "contact_id" of relation
--     "open_house_attendees" violates not-null constraint
--
-- Proven by execution against this database in a rolled-back transaction, not
-- inferred from the schema. That writer DOES destructure `error`, so the refusal
-- surfaced honestly as `{ success: false }` rather than being reported as a
-- success — the kiosk has been visibly, totally broken rather than quietly
-- losing rows. (Its dead twin at
-- `app/actions/open-house-automation.ts:checkInAttendee` does NOT destructure and
-- returned `{ success: true, data: null }` over the same refusal; it has no
-- callers, and a prior wave already annotated it and deferred the product
-- decision to this one.)
--
-- ── WHY NULLABLE IS THE FIX, AND STAMPING A CONTACT IS NOT ─────────────────
--
-- The obvious-looking alternative — have the kiosk resolve or create a contact
-- and stamp it — is WRONG here, and the tree says so in two places:
--
--   1. `app/actions/seller-open-house.ts:convertAttendeeToContact` exists for
--      exactly this transition and GUARDS ON THE COLUMN BEING NULL:
--          if (attendee.contact_id) return { error: "Already converted to contact" }
--      It is wired to a live button (app/dashboard/listings/[id]/open-house/
--      tabs/event-day-tab.tsx). Stamping a contact at check-in would make that
--      guard fire on every attendee and permanently disable the conversion
--      surface — trading a refused insert for a dead feature.
--   2. Auto-creating a `contacts` row from unauthenticated kiosk input is a
--      spam and data-quality vector, and is a product decision that belongs to
--      the owner, not to a NOT NULL constraint that nobody chose deliberately.
--
-- Both designs already coexist in the tree and BOTH remain correct after this
-- change: `app/api/open-house/attend/route.ts` and `lib/kernel/open-house.ts`
-- resolve a contact first and still stamp `contact_id`; the kiosk and the
-- automation writer leave it NULL until conversion. Nullable is the only shape
-- that admits both.
--
-- The FOREIGN KEY is deliberately LEFT IN PLACE. `contact_id` still REFERENCES
-- contacts(id) ON DELETE CASCADE, so a stamped value is still guaranteed to
-- point at a real contact; only the requirement that one exist AT INSERT TIME is
-- lifted. m401 asserts the FK survived — dropping the constraint instead of the
-- NOT NULL would satisfy a naive "check-in works now" test while silently
-- allowing an attendee to reference a contact that does not exist.
--
-- Live row count at the time of writing: 0 attendees, so there is nothing to
-- backfill and no existing row changes meaning.

ALTER TABLE public.open_house_attendees
  ALTER COLUMN contact_id DROP NOT NULL;

COMMENT ON COLUMN public.open_house_attendees.contact_id IS
  'The contact this attendee was converted into, or NULL if they have not been '
  'converted yet. NULLABLE ON PURPOSE (m400): the public kiosk check-in '
  '(app/actions/seller-open-house.ts:checkInAttendee) captures walk-in visitors '
  'who are not contacts yet, and convertAttendeeToContact fills this in later — '
  'it refuses to run when this column is already set. Do not restore NOT NULL '
  'without first giving the kiosk a contact to point at.';

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — `cron_health_snapshot`: a platform-wide table any broker could
--          REWRITE.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This table carries NO `brokerage_id` column and is upserted `onConflict:
-- "cron_name"` by lib/kernel/cron-logging.ts — one row per cron name, shared by
-- the entire platform. That is correct for what it is: all 130
-- `createCronRunContextAction` call sites in this tree are platform-wide sweeps
-- that iterate every brokerage, so per-cron latest state is genuinely platform
-- infrastructure and is NOT tenant data. This migration does not try to tenant
-- it, because there is no tenant to give it.
--
-- The defect is the ACCESS MODE, not the shape. Its single policy is:
--
--     chs_admin_all   FOR ALL   TO PUBLIC
--       USING (current_user_type() = ANY (ARRAY['broker','broker_admin',
--                                               'admin','superadmin','team_lead']))
--
-- FOR ALL with a USING and NO WITH CHECK means that expression is used as the
-- INSERT check too. So any broker or team_lead — of ANY tenant — could INSERT,
-- UPDATE or DELETE rows in the platform's cron health ledger: blank the record
-- of a failing job, forge a green status for a cron that has never run, or
-- delete all 64 rows. Nothing in the application needs that. Every writer of
-- this table is `lib/kernel/cron-logging.ts` on a SERVICE client
-- (recordCronSuccess / recordCronFailure), and service_role bypasses RLS
-- entirely, so removing the authenticated write grant costs the application
-- nothing and is not a behaviour change for any code path that exists.
--
-- Reads stay exactly as wide as they were, deliberately: the same five roles
-- keep SELECT. A broker legitimately needs to know that the platform's
-- daily-briefing job is stale, because it is the platform they run on. What a
-- broker must NOT read is `last_error_message` — free text copied from whichever
-- run failed most recently, which `recordCronFailure` writes for ANY cron
-- including a tenant-scoped one. That column cannot be gated by RLS (RLS filters
-- rows, not columns) so it is withheld in the reader,
-- `app/actions/pl-truth-engine.ts:getCronHealth`, which returns
-- `error_message_redacted: true` so the surface renders "withheld" instead of a
-- null that reads like "this cron has not failed".

DROP POLICY IF EXISTS chs_admin_all ON public.cron_health_snapshot;

CREATE POLICY cron_health_snapshot_admin_select
  ON public.cron_health_snapshot
  FOR SELECT
  TO authenticated
  USING (
    current_user_type() = ANY (ARRAY[
      'broker'::text, 'broker_admin'::text, 'admin'::text,
      'superadmin'::text, 'team_lead'::text
    ])
  );

-- No INSERT / UPDATE / DELETE policy is created ON PURPOSE. With RLS enabled and
-- no permissive policy for a command, that command is refused for every
-- non-bypassing role. The only writers are service-role clients, which bypass
-- RLS. m401 asserts this absence, because "we forgot to add a write policy" and
-- "writes are deliberately service-role-only" look identical in the catalog and
-- only one of them survives a well-meaning future migration.

COMMENT ON TABLE public.cron_health_snapshot IS
  'Latest state per cron NAME, platform-wide. Deliberately has no brokerage_id: '
  'every cron in this tree is a platform sweep, and the row is keyed on '
  'cron_name alone. Readable by broker/broker_admin/admin/superadmin/team_lead; '
  'writable ONLY by service-role clients (m400) — lib/kernel/cron-logging.ts is '
  'the sole writer. last_error_message is free text that may describe another '
  'tenant''s run and is withheld from non-platform-admins by '
  'app/actions/pl-truth-engine.ts:getCronHealth.';
