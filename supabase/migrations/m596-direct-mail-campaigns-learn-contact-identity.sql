-- m596 — direct_mail_campaigns learns a first-class CONTACT identity
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: WRITTEN, NOT APPLIED. Lanes write migrations; only the integrator
-- applies them (CLAUDE.md §3). After applying: regenerate the schema caches
-- (schema-snapshot / schema-fk-map) and, because a CHECK is added, the
-- vocabulary cache regeneration rule applies to the cache chain as well.
--
-- WHY. `leads.id` and `contacts.id` are DISJOINT id spaces. The AI-ISA direct
-- mail trigger (lib/ai-isa/direct-mail-trigger.ts) is dual-class as of lane W3
-- 2026-09-01: engage-contact (contacts side) was feeding a contacts.id into the
-- leads-only lane, which read `leads`, found nothing, refused — and the caller
-- logged the mail as sent anyway. The code now writes
-- direct_mail_campaigns.contact_id on the contacts arm; this migration gives
-- that column its missing FK and forbids a row that claims BOTH identities.
--
-- MEASURED FROM THE GENERATED LIVE CACHES before writing (2026-09-01; the live
-- DB was not re-queried by this lane — re-verify each preflight when applying):
--   · contact_id ALREADY EXISTS on direct_mail_campaigns —
--     scripts/schema-snapshot.ts:277 (generated from the live schema) lists it,
--     and lib/direct-mail/listing-lifecycle-mail-reactor.ts:345 already writes
--     it / lib/direct-mail/campaign-drain.ts:58-80 already reads it. So the
--     ADD COLUMN below is IF NOT EXISTS and expected to be a no-op.
--   · contact_id has NO foreign key — scripts/schema-fk-map.ts:355 (generated
--     from live FKs) lists direct_mail_campaigns FKs for lead_id (→ leads),
--     brokerage_id, agent_id, created_by, … and NONE for contact_id. The FK is
--     the substantive DDL here.
--   · lead_id nullability could NOT be read from the repo (no local DDL creates
--     it; m491 only proves it exists). Measured by inference: live writers
--     insert rows with lead_id ABSENT and read the error —
--     lib/kernel/farm-play.ts:197 and lib/kernel/marketing-bench.ts:153 insert
--     neither lead_id nor contact_id and count success on error===null — so
--     lead_id behaves as NULLABLE in production. The preflight below verifies
--     that against the catalog and RELAXES it if the inference is wrong, so the
--     migration is correct in either state rather than pinned to a waypoint.
--
-- CHECK SHAPE — "AT MOST ONE", DELIBERATELY NOT "EXACTLY ONE". The lane brief
-- asked for exactly-one, but bulk campaigns legitimately carry NEITHER identity
-- (farm/geographic audiences: lib/kernel/farm-play.ts:197 target_audience
-- 'farm'; lib/kernel/marketing-bench.ts:153; both live writers). An exactly-one
-- CHECK would refuse every bulk campaign insert on the day it applies. The rule
-- that is actually true of this table is: a row may name one person or no
-- person, never two people in two id spaces. Asserted as NOT(both) — §2: assert
-- the RULE, not the waypoint.

BEGIN;

-- ── 0. Preflight: measure, and refuse to run against a shape this file does
--       not describe. ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rows          bigint;
  v_both          bigint;
  v_contact_col   int;
  v_lead_col      int;
  v_lead_nullable text;
  v_orphan_contact bigint;
BEGIN
  SELECT count(*) INTO v_lead_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'direct_mail_campaigns'
    AND column_name = 'lead_id';
  IF v_lead_col <> 1 THEN
    RAISE EXCEPTION 'm596: direct_mail_campaigns has no lead_id — the dual-identity premise does not hold. Re-read before applying.';
  END IF;

  SELECT count(*) INTO v_contact_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'direct_mail_campaigns'
    AND column_name = 'contact_id';

  SELECT is_nullable INTO v_lead_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'direct_mail_campaigns'
    AND column_name = 'lead_id';

  SELECT count(*) INTO v_rows FROM public.direct_mail_campaigns;

  -- Rows that would violate the new CHECK (only possible if contact_id exists).
  IF v_contact_col = 1 THEN
    EXECUTE 'SELECT count(*) FROM public.direct_mail_campaigns WHERE lead_id IS NOT NULL AND contact_id IS NOT NULL'
      INTO v_both;
    -- Rows whose contact_id the new FK would refuse (written while unconstrained).
    EXECUTE 'SELECT count(*) FROM public.direct_mail_campaigns d
             WHERE d.contact_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = d.contact_id)'
      INTO v_orphan_contact;
  ELSE
    v_both := 0;
    v_orphan_contact := 0;
  END IF;

  RAISE NOTICE 'm596 BEFORE: rows=%, contact_id present=% (expected 1 — schema-snapshot already lists it), lead_id is_nullable=% (expected YES by writer inference), rows carrying BOTH identities=% (must be 0), contact_id values with no contacts row=% (must be 0)',
    v_rows, v_contact_col, v_lead_nullable, v_both, v_orphan_contact;

  IF v_both > 0 THEN
    RAISE EXCEPTION 'm596: % rows carry BOTH lead_id and contact_id — adjudicate those rows (which person was actually mailed?) before constraining. Do not delete data to make a constraint fit.', v_both;
  END IF;
  IF v_orphan_contact > 0 THEN
    RAISE EXCEPTION 'm596: % rows carry a contact_id no contacts row matches — written while the column was unconstrained. Adjudicate before adding the FK.', v_orphan_contact;
  END IF;

  -- If the writer inference was wrong and lead_id is NOT NULL, the dual-class
  -- lane is impossible (a contacts-arm row must hold lead_id NULL) — relax it.
  IF v_lead_nullable = 'NO' THEN
    RAISE NOTICE 'm596: lead_id was NOT NULL (inference wrong) — relaxing, the contacts arm requires lead_id NULL';
    ALTER TABLE public.direct_mail_campaigns ALTER COLUMN lead_id DROP NOT NULL;
  END IF;
END $$;

-- ── 1. The column (expected no-op — live snapshot already carries it). ───────
ALTER TABLE public.direct_mail_campaigns
  ADD COLUMN IF NOT EXISTS contact_id uuid;

-- ── 2. The FK the live column is missing (schema-fk-map.ts:355 shows none).
--       ON DELETE SET NULL mirrors direct_mail_recipients/…_responses
--       contact_id FKs and m491's lead_id FKs on the sibling tables. ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.direct_mail_campaigns'::regclass
      AND conname  = 'direct_mail_campaigns_contact_id_fkey'
  ) THEN
    ALTER TABLE public.direct_mail_campaigns
      ADD CONSTRAINT direct_mail_campaigns_contact_id_fkey
      FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 3. One person or no person, never two id spaces on one row. ──────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.direct_mail_campaigns'::regclass
      AND conname  = 'direct_mail_campaigns_one_identity_check'
  ) THEN
    ALTER TABLE public.direct_mail_campaigns
      ADD CONSTRAINT direct_mail_campaigns_one_identity_check
      CHECK (lead_id IS NULL OR contact_id IS NULL);
  END IF;
END $$;

-- ── 4. The read path: the AI-ISA 30-day idempotency window and the campaign
--       drain both key contact_id now — mirror lead_id's partial-index shape
--       (m491:110, "reads go the other way"). ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_direct_mail_campaigns_contact
  ON public.direct_mail_campaigns (contact_id)
  WHERE contact_id IS NOT NULL;

COMMIT;

-- MEASURED AFTER APPLYING: (integrator fills in — expected:
--   · m596 BEFORE notice quoted above with both=0, orphans=0;
--   · direct_mail_campaigns_contact_id_fkey → public.contacts(id);
--   · direct_mail_campaigns_one_identity_check present;
--   then regenerate schema-snapshot / schema-fk-map / vocabulary caches.)
