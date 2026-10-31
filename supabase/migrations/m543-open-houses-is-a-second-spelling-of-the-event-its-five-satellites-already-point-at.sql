-- m543 — `open_houses` IS A SECOND SPELLING OF THE EVENT ITS FIVE SATELLITES ALREADY POINT AT
--
-- APPLICATION STATUS
-- APPLIED 2026-08-23 hrvaqgvukzxfskkcrwbt.
--
-- Owner ruling, verbatim: "consolodate open house".
--
-- CLAUDE.md §6 — one vocabulary per function. Seven tables carry the prefix
-- `open_house`, but only ONE thing is doubled: the EVENT. The other five are
-- satellites of it and are NOT duplicates of each other, so they are untouched:
--
--     open_house_attendees      who showed up
--     open_house_feedback       what they said
--     open_house_invitations    who was asked
--     open_house_rsvp_tracking  who answered
--     open_house_analytics      what it produced
--
-- ══ WHICH SPELLING SURVIVES, ON EVIDENCE ═════════════════════════════════════
--
-- The survivor was NOT chosen by name. Four independent measurements, all taken
-- against hrvaqgvukzxfskkcrwbt and the tree at this commit, agree:
--
--   1. FK TOPOLOGY — decisive. All FIVE satellites FK to `open_house_events`.
--      `open_houses` has ZERO children.
--
--          SELECT src.relname AS child, tgt.relname AS parent
--          FROM pg_constraint con
--          JOIN pg_class src ON src.oid = con.conrelid
--          JOIN pg_class tgt ON tgt.oid = con.confrelid
--          WHERE con.contype = 'f' AND tgt.relname IN ('open_houses','open_house_events');
--
--        → open_house_analytics.event_id      → open_house_events
--          open_house_attendees.event_id      → open_house_events
--          open_house_feedback.event_id       → open_house_events
--          open_house_invitations.event_id    → open_house_events
--          open_house_rsvp_tracking.event_id  → open_house_events
--          (nothing whatsoever → open_houses)
--
--      Retiring the satellites' own parent would have meant re-pointing five
--      foreign keys. Retiring `open_houses` re-points none.
--
--   2. CODE WEIGHT — 10:1. Counted with scripts/strip-comments.ts over
--      `git ls-files '*.ts' '*.tsx'` (5,373 files — the denominator), counting only
--      REAL `.from("…")` call sites, so a table named in a COMMENT or in a test
--      SPECIMEN STRING cannot inflate either side:
--
--          BEFORE          AFTER      (the count that moved IS the finding, §2)
--          open_house_events  61  →   67   (+6: the re-pointed sites landed here)
--          open_houses         6  →    0   (−6: every reader/writer moved off)
--
--      The two numbers move by the same 6, in opposite directions, which is what
--      a re-point looks like when nothing was dropped on the way.
--
--      MEASUREMENT NOTE, recorded because it cost a wrong number once: the first
--      version of the guard counted 2 surviving `open_houses` call sites that do
--      not exist. Both were fixture text inside a TEMPLATE LITERAL in a sibling
--      lane's scripts/listing-archive-simulator.ts — a specimen fed to that file's
--      own scanner. The guard now requires the `.from(` TOKEN to survive
--      blankStrings (a real call is code; a specimen is template content), and
--      carries a two-sided control proving it still counts a real call while
--      ignoring both a specimen and a comment.
--
--   3. REACH — `open_house_events` is the spelling on the surfaces that are
--      unreferenced BY DESIGN (§1) and therefore cannot simply be re-pointed away:
--        · app/api/cron/open-house-followup/route.ts
--        · app/api/cron/open-house-reminder/route.ts
--        · app/api/open-house/attend/route.ts            (public check-in)
--        · app/open-house/[eventId]/rsvp/[invitationId]  (public RSVP)
--        · app/open-house/feedback/[attendeeId]          (public feedback)
--      `open_houses` appears on none of them.
--
--   4. IT IS ALREADY THE DECLARED SURVIVOR ELSEWHERE — lib/dashboard/data-survivors.ts
--      names `app/actions/open-house.ts:getOpenHouses` as the survivor for the
--      `open_houses` DASHBOARD DATA TYPE, and that function reads
--      `open_house_events` (app/actions/open-house.ts:111). The registry had
--      already picked this side; the table had not caught up.
--
--   COUNTER-EVIDENCE, stated rather than buried: `open_houses` carried the RICHER
--   column set (33 vs 21 after m542). That is the ONE dimension it won, and it is
--   the dimension a merge can fix — which is what §1 orders done FIRST, and what
--   the ALTERs below do. Column count is a mergeable difference; five foreign
--   keys, five public routes and 61 call sites are not.
--
--   SURVIVOR: public.open_house_events
--   RETIRED:  public.open_houses
--
-- ══ DATA SAFETY, MEASURED ════════════════════════════════════════════════════
--
--   SELECT (SELECT count(*) FROM public.open_houses)      AS open_houses,
--          (SELECT count(*) FROM public.open_house_events) AS open_house_events,
--          (SELECT count(*) FROM public.contacts)          AS positive_control;
--     → open_houses 0, open_house_events 0, positive_control 4
--
--   The positive control is there because a counter that reports 0 for a table
--   that IS empty and a counter that is broken read identically. `contacts`
--   returning 4 proves the counter counts.
--
--   Both event tables being EMPTY is what makes this a schema consolidation with
--   NO data migration: there are no rows to copy, and no rows that a copy could
--   silently drop.
--
-- ══ WHAT IS MERGED ONTO THE SURVIVOR, AND WHAT IS DELIBERATELY NOT ═══════════
--
-- MERGED (13 columns the survivor lacked and that carry a capability it had no
-- spelling for). Each is additive and nullable, so no existing writer of
-- `open_house_events` is affected:
--
--     title                 property_address      timezone
--     scheduled_at          ai_recommended_time   optimal_timing_score
--     allow_walkins         check_in_url          is_published
--     published_at          updated_at            cancelled_at
--     cancellation_reason
--
-- NOT MERGED — 7 columns that are SECOND SPELLINGS of something the survivor
-- already has. Copying these would import the very defect §6 exists to end, so
-- each is named here with the survivor's existing spelling instead:
--
--     require_rsvp            → open_house_events.registration_required
--     qr_code_url             → open_house_events.qr_code_id → qr_codes(id)
--     qr_code_data            → open_house_events.qr_code_id → qr_codes(id)
--     total_invitations_sent  → count(open_house_invitations WHERE event_id = …)
--     total_rsvps             → count(open_house_rsvp_tracking WHERE event_id = …)
--     total_check_ins         → count(open_house_attendees WHERE event_id = …)
--     total_leads_generated   → open_house_analytics (the metrics satellite)
--
--   The four `total_*` counters are denormalised copies of rows that already
--   exist in the four satellites. A cached count with no writer is how a
--   dashboard comes to disagree with the list underneath it.
--
-- NOT MERGED, ALREADY RESOLVED BY ANOTHER LANE: `open_houses.property_id`. The
--   owner ruled property ids are outside `listings`; m542 (APPLIED 2026-08-23,
--   the same day) dropped the column and its FK. It was present when this lane
--   began measuring and absent by the time this migration was written — verified
--   live, not assumed. It is therefore neither merged nor mourned here.
--
-- ══ THE ONE VOCABULARY DECISION ══════════════════════════════════════════════
--
-- The two tables spoke two status vocabularies:
--
--     open_house_events.status  CHECK  scheduled | marketing | active | completed | cancelled
--     open_houses.status        (no CHECK at all)  DEFAULT 'draft'
--
-- lib/kernel/launch-war-room.ts stages the first open house as a DRAFT WITH NO
-- DATE on purpose — its own comment says "never a fabricated event_date", because
-- the system cannot know the agent's chosen date. The survivor's vocabulary has
-- no word for that state, and 'scheduled' would be a lie about a row with no
-- date on it.
--
-- So the vocabulary is WIDENED BY EXACTLY ONE VALUE — 'draft' — and the dateless
-- state is then PINNED to it by a new CHECK, which is an invariant NEITHER table
-- had before:
--
--     event_date IS NOT NULL OR status = 'draft'
--
-- A draft may have no date. Anything that claims to be scheduled, marketing,
-- active, completed or cancelled MUST carry one. Widening `event_date` to
-- nullable without this constraint would have been a straight loss of rigour;
-- with it, the survivor is stricter than either table it replaces.
--
-- THREE COPIES OF THIS VOCABULARY EXIST AND MUST MOVE TOGETHER (the note at
-- scripts/doc-kernel-simulator.ts:3086 says so, having paid for it once):
--     1. the live CHECK                     — widened below
--     2. scripts/doc-kernel-simulator.ts    — inline PASS-6 table, updated in this commit
--     3. scripts/check-vocabularies.ts      — GENERATED CACHE. NOT hand-edited (§3).
--                                             REGENERATION IS OWED TO THE INTEGRATOR.
--
-- ══ WHY `open_houses` IS LOCKED HERE RATHER THAN DROPPED ═════════════════════
--
-- The DROP is deliberately NOT in this migration, and the reason is a blocker
-- this lane cannot clear rather than a preference:
--
--   lib/kernel/listing-archive.ts:234 names `open_houses` in LISTING_DELETE_PLAN's
--   detach list. That file is owned by another lane and is out of this lane's
--   scope. Dropping the table underneath a delete plan that still enumerates it
--   turns every listing deletion into a "relation does not exist" error — a
--   production regression traded for a tidier table count, which §1 forbids
--   ("deleting to move a number is forbidden").
--
-- What this migration CAN do without touching that file, it does: the table is
-- made unwritable and unreadable to every client role, and carries a COMMENT
-- naming its survivor, so it cannot silently accrue a single new row while the
-- drop waits. Note the service role bypasses RLS by design, which is why the
-- GRANTs are revoked as well rather than relying on policies alone.
--
--   DROP OWED TO THE INTEGRATOR, in this order:
--     1. lib/kernel/listing-archive.ts — remove the `open_houses` detach entry
--        (its sibling `open_houses.property_id` entry at :169 is ALREADY stale,
--        m542 dropped that column)
--     2. DROP TABLE public.open_houses;
--     3. regenerate schema-snapshot.ts, schema-fk-map.ts, live-tables.ts,
--        check-vocabularies.ts
--
-- ══ VERIFICATION ═════════════════════════════════════════════════════════════
--
--   npm run test:open-house-consolidation
--
--   Carries two-sided controls: every "X is gone" assertion is paired with a
--   "…and the same finder still sees Y, which is there" assertion, because a
--   broken finder and a clean tree both report zero (§2).
--
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. MERGE ONTO THE SURVIVOR (§1: merge FIRST, retire after) ───────────────

ALTER TABLE public.open_house_events
  ADD COLUMN IF NOT EXISTS title                VARCHAR(255),
  ADD COLUMN IF NOT EXISTS property_address     TEXT,
  ADD COLUMN IF NOT EXISTS timezone             VARCHAR(64)  DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS scheduled_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_recommended_time  BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS optimal_timing_score NUMERIC,
  ADD COLUMN IF NOT EXISTS allow_walkins        BOOLEAN      DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS check_in_url         TEXT,
  ADD COLUMN IF NOT EXISTS is_published         BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS published_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ  DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason  TEXT;

COMMENT ON COLUMN public.open_house_events.title IS
  'Merged from the retired public.open_houses by m543. Read by lib/kernel/campaign-center.ts, written by lib/kernel/launch-war-room.ts.';
COMMENT ON COLUMN public.open_house_events.property_address IS
  'Merged from the retired public.open_houses by m543. The address as staged, for a draft that has no listing join yet.';
COMMENT ON COLUMN public.open_house_events.is_published IS
  'Merged from the retired public.open_houses by m543. A staged draft is unpublished; publishing is the agent''s act, never the system''s.';

-- ── 2. ONE STATUS VOCABULARY (§6), WIDENED BY EXACTLY ONE REAL STATE ─────────

ALTER TABLE public.open_house_events
  DROP CONSTRAINT IF EXISTS open_house_events_status_check;

ALTER TABLE public.open_house_events
  ADD CONSTRAINT open_house_events_status_check
  CHECK (status IN ('draft','scheduled','marketing','active','completed','cancelled'));

-- ── 3. THE DATELESS DRAFT, MADE LEGAL AND THEN FENCED IN ─────────────────────
--
-- Relaxing NOT NULL alone would let ANY status carry a null date. The CHECK
-- immediately below is what keeps that from being a loss: only a draft may.

ALTER TABLE public.open_house_events
  ALTER COLUMN event_date DROP NOT NULL;

ALTER TABLE public.open_house_events
  DROP CONSTRAINT IF EXISTS open_house_events_dateless_only_when_draft;

ALTER TABLE public.open_house_events
  ADD CONSTRAINT open_house_events_dateless_only_when_draft
  CHECK (event_date IS NOT NULL OR status = 'draft');

COMMENT ON CONSTRAINT open_house_events_dateless_only_when_draft ON public.open_house_events IS
  'm543. A staged draft legitimately has no date yet (lib/kernel/launch-war-room.ts refuses to fabricate one). Every other status must carry a date.';

-- ── 4. THE INDEXES THE RETIRED TABLE HAD AND THE SURVIVOR DID NOT ────────────
--
-- open_houses carried four; open_house_events carried only its primary key.
-- Losing them in a consolidation would make the survivor slower than the
-- duplicate it replaces.

CREATE INDEX IF NOT EXISTS idx_open_house_events_agent      ON public.open_house_events (agent_id);
CREATE INDEX IF NOT EXISTS idx_open_house_events_event_date ON public.open_house_events (event_date);
CREATE INDEX IF NOT EXISTS idx_open_house_events_listing    ON public.open_house_events (listing_id);
CREATE INDEX IF NOT EXISTS idx_open_house_events_status     ON public.open_house_events (status);
CREATE INDEX IF NOT EXISTS idx_open_house_events_brokerage  ON public.open_house_events (brokerage_id);

-- ── 5. RETIRE THE DUPLICATE (tombstone + lock; DROP owed, see header) ────────

COMMENT ON TABLE public.open_houses IS
  'RETIRED by m543 — SECOND SPELLING of public.open_house_events, which is the survivor. '
  'All five satellites (open_house_attendees, open_house_feedback, open_house_invitations, '
  'open_house_rsvp_tracking, open_house_analytics) FK to open_house_events; this table has no '
  'children, and every one of its former readers/writers was re-pointed in the same commit: '
  'lib/kernel/campaign-center.ts:61, lib/kernel/launch-war-room.ts:235,237, '
  'lib/video/director-content.ts:564, scripts/deal-play-simulator.ts:187, '
  'scripts/launch-war-room-simulator.ts:30. '
  'NOT YET DROPPED because lib/kernel/listing-archive.ts:234 still enumerates it in '
  'LISTING_DELETE_PLAN and that file belongs to another lane; dropping it first would break '
  'every listing deletion. Access is revoked below so it cannot gain a row while the drop waits.';

REVOKE ALL ON public.open_houses FROM anon, authenticated;

-- THE FIRST APPLY OF THIS MIGRATION GOT THIS WRONG, AND THE POST-APPLY READ
-- CAUGHT IT. Adding the deny-all below is NOT sufficient on its own: this table
-- already carried four PERMISSIVE tenant policies (open_houses_tenant_select /
-- _insert / _update / _delete), and PERMISSIVE policies are OR'd — so the
-- deny-all denied nothing and every seat still read the retired table. That is
-- precisely the shape lib/kernel/manager-registry.ts:1062 already records having
-- paid for once: "PERMISSIVE policies are OR'd, so the sibling never constrained
-- the broken one and the wider policy always won."
--
-- A retired table has no tenant lane at all, so the four are dropped and the
-- deny-all is left as the ONLY policy on it. Verified after applying:
--
--     SELECT tablename, policyname, permissive FROM pg_policies
--     WHERE tablename IN ('open_houses','demo_persona_contacts');
--       → exactly one row per table, both the deny-all
--     (positive control: the same query over open_house_events still returns
--      its four tenant policies, so the finder is not simply blind)

DROP POLICY IF EXISTS open_houses_tenant_select ON public.open_houses;
DROP POLICY IF EXISTS open_houses_tenant_insert ON public.open_houses;
DROP POLICY IF EXISTS open_houses_tenant_update ON public.open_houses;
DROP POLICY IF EXISTS open_houses_tenant_delete ON public.open_houses;

DROP POLICY IF EXISTS open_houses_retired_deny_all ON public.open_houses;
ALTER TABLE public.open_houses ENABLE ROW LEVEL SECURITY;
CREATE POLICY open_houses_retired_deny_all ON public.open_houses
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

-- ── 6. demo_persona_contacts — ORPHAN, §1 BRANCH 3 ───────────────────────────
--
-- Owner ruling, verbatim: "demo persona contacts".
--
-- MEASURED, not assumed:
--   · 0 rows live.
--   · 0 `.from("demo_persona_contacts")` sites in the tree — counted with
--     scripts/strip-comments.ts over `git ls-files '*.ts' '*.tsx'`. The six
--     surviving textual mentions are all PROSE OR REGISTRY, not access:
--       lib/kernel/manager-registry.ts:1062   (narrative inside a `what:` string)
--       lib/kernel/manager-registry.ts:1217   (table→owner registry key)
--       scripts/child-tenant-scope-simulator.ts:92 (a documented exemption)
--       scripts/agent-fk-columns.ts:345, scripts/live-tables.ts:297,
--       scripts/schema-fk-map.ts:354         (all three GENERATED CACHES)
--   · 0 DB-side writers. §3 warns a column written only by an .rpc(), a trigger
--     or a backfill reads as writerless without being writerless, so all three
--     were checked in the catalogue, WITH A POSITIVE CONTROL:
--
--       WITH fn AS (SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
--                   JOIN pg_namespace n ON n.oid = p.pronamespace
--                   WHERE n.nspname='public' AND p.prokind IN ('f','p'))
--       SELECT count(*) FROM fn WHERE def ~* '\mdemo_persona_contacts\M';   → 0
--       SELECT count(*) FROM fn WHERE def ~* '\mcontacts\M';                → 27
--
--     27 is the positive control: the finder demonstrably still finds a table
--     that IS named in function bodies. Views and triggers: 0 by the same query
--     shape. So the absence is measured, not merely unobserved.
--
-- REACHABILITY PROVEN BEFORE PROPOSING DELETION (§1 — "unreferenced is not dead"):
--   · vercel.json declares exactly ONE cron, /api/cron/dispatch. Neither it nor
--     lib/kernel/cron-dispatch.ts mentions this table (0 hits).
--   · No API route exists under any *demo* or *persona* path.
--   · No same-origin `${baseUrl}/api/…` self-call names it.
--   · It is not a webhook or provider callback target.
--
-- WHY THIS IS BRANCH 3 (functionality already lives elsewhere) AND NOT BRANCH 2
-- (build the missing half):
--
--   The table is a persona→demo-contact lookup. BOTH halves of that capability
--   already exist, in code, better:
--
--     · THE PERSONA VOCABULARY lives in lib/portal/persona-config.ts — the same
--       16 persona keys the seed scripts wanted to store as rows
--       (first_time_buyer, military_buyer, luxury_seller, investor, probate, …),
--       held in a reviewed, versioned file instead of an unwritten table.
--     · THE DEMO-SEED CAPABILITY lives in scripts/demo-seed-and-run.ts
--       (`npm run demo:seed-run`), which builds a TAGGED, fully-linked,
--       self-cleaning seed plan and needs no lookup table at all.
--
--   And the would-be writers are not merely unused, they are BROKEN: both
--   scripts/350-create-demo-contacts-for-personas.sql:488 and
--   scripts/351-create-demo-contacts-simple.sql:219 INSERT the columns
--   `display_name` and `description`, which THIS TABLE HAS NEVER HAD — the live
--   shape came from supabase/migrations/062-long-tail-batch-3.sql:195 and is
--   (id, persona, contact_id, created_at). Either script would error on contact
--   with the live schema. Building the "missing" reader would have meant wiring a
--   surface to a table whose only two writers cannot run.
--
--   Neither seed script is invoked by any npm script, CI job or cron; both are
--   cited in the tree only as PROVENANCE COMMENTS for demo contact data
--   (constants/crm-standards.ts:107, lib/lifecycle/offer-lifecycle.ts:226,
--   supabase/migrations/m487…:56).
--
-- Same blocker as above, for the same reason: this table is enumerated in the
-- child-tenant-scope census (scripts/child-tenant-scope-simulator.ts:92) and in
-- three generated caches, so it is LOCKED AND TOMBSTONED here and the DROP is
-- owed to the integrator together with a cache regeneration.

COMMENT ON TABLE public.demo_persona_contacts IS
  'RETIRED by m543 — ORPHAN (0 rows, 0 .from() sites, 0 DB-side writers, unreachable from cron/webhook/self-call). '
  'It is a persona→demo-contact lookup whose functionality ALREADY LIVES ELSEWHERE: the persona vocabulary in '
  'lib/portal/persona-config.ts (the same 16 keys, in reviewed code rather than unwritten rows), and the demo-seed '
  'capability in scripts/demo-seed-and-run.ts (npm run demo:seed-run), which builds a tagged self-cleaning plan and '
  'needs no lookup table. Its only two would-be writers — scripts/350-create-demo-contacts-for-personas.sql:488 and '
  'scripts/351-create-demo-contacts-simple.sql:219 — INSERT display_name/description, columns this table has never '
  'had, so both error against the live shape from supabase/migrations/062-long-tail-batch-3.sql:195. '
  'It is also the ONLY one of the 88 lifecycle children with no brokerage_id, so it can never be tenant-scoped. '
  'DROP owed to the integrator with a regeneration of live-tables.ts / schema-fk-map.ts / agent-fk-columns.ts.';

REVOKE ALL ON public.demo_persona_contacts FROM anon, authenticated;

DROP POLICY IF EXISTS dpc_select ON public.demo_persona_contacts;
DROP POLICY IF EXISTS dpc_insert ON public.demo_persona_contacts;
DROP POLICY IF EXISTS dpc_update ON public.demo_persona_contacts;
DROP POLICY IF EXISTS dpc_delete ON public.demo_persona_contacts;
DROP POLICY IF EXISTS demo_persona_contacts_retired_deny_all ON public.demo_persona_contacts;

ALTER TABLE public.demo_persona_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY demo_persona_contacts_retired_deny_all ON public.demo_persona_contacts
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

-- Closes a finding m471 recorded and left open: "demo_persona_contacts and
-- marketing_stats readable by every authenticated seat" (manager-registry.ts:1062).
-- The dpc_select policy dropped above was that world-read.

COMMIT;

-- ══ POST-APPLY VERIFICATION, RUN LIVE ════════════════════════════════════════
--
--   -- the merge landed (expect 13)
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='open_house_events'
--     AND column_name IN ('title','property_address','timezone','scheduled_at',
--       'ai_recommended_time','optimal_timing_score','allow_walkins','check_in_url',
--       'is_published','published_at','updated_at','cancelled_at','cancellation_reason');
--
--   -- the vocabulary is one, and admits the draft (expect 6 values incl. draft)
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname='open_house_events_status_check';
--
--   -- the dateless draft is fenced (expect the CHECK to exist)
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname='open_house_events_dateless_only_when_draft';
--
--   -- the retired tables are locked (expect deny-all only)
--   SELECT tablename, policyname, qual FROM pg_policies
--   WHERE tablename IN ('open_houses','demo_persona_contacts');
