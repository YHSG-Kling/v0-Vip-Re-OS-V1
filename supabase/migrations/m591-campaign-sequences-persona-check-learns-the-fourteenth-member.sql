-- m591 — campaign_sequences.persona learns 'investor' (the m589 vocabulary,
--        applied to the SECOND column that carries it)
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-08-31.
-- Verified after: campaign_sequences_persona_check lists fourteen values
-- including 'investor'; check-vocabularies regenerated the same session (§3).
-- (Was WRITTEN-NOT-APPLIED, lane M1 — updated per §2, a waypoint string must
-- not survive its own moment.)
--
-- WHY THIS EXISTS. m589 (APPLIED) widened contacts_contact_persona_check to
-- fourteen values on the owner ruling "investor is a persona and not a contact
-- type" — but the SAME vocabulary lives on a second column,
-- campaign_sequences.persona, whose CHECK still lists thirteen (verified in the
-- regenerated scripts/check-vocabularies.ts, 2026-08-31: campaign_sequences
-- persona has no 'investor'). One vocabulary, two columns (§6):
-- scripts/contact-vocabulary-guard.ts asserts "contacts.contact_persona and
-- campaign_sequences.persona are the SAME vocabulary" and is HONESTLY RED until
-- this lands — as is the campaign-auto-enroll simulator's same-vocabulary check.
-- Without it, a brokerage can hold an investor CONTACT (m589) but the database
-- refuses an investor-keyed CAMPAIGN SEQUENCE (23514), so the persona can never
-- get the persona-specific drip the auto-enroll ladder exists to select.
--
-- LIVE MEASUREMENTS THE INTEGRATOR MUST RE-VERIFY BEFORE APPLYING:
--
--   1. The CHECK this migration replaces (expected: NULL-or-thirteen —
--      first_time, relocated, luxury, fsbo, probate, upsize, downsize,
--      military, divorce, senior, expired, foreclosure, other):
--
--        select pg_get_constraintdef(oid)
--          from pg_constraint
--         where conrelid = 'public.campaign_sequences'::regclass
--           and conname  = 'campaign_sequences_persona_check';
--
--   2. No row can be stranded by a WIDENING, but state the census anyway (§2):
--
--        select persona, count(*) from public.campaign_sequences
--         group by persona order by 2 desc;
--
-- This migration only WIDENS — every existing row satisfies the new constraint
-- by construction — so no UPDATE step and no NOT VALID dance is needed (the
-- same shape as m589).
--
-- AFTER APPLYING: regenerate scripts/check-vocabularies.ts from the live
-- extract (§3), which turns the two red guard checks green with no code change
-- — lib/campaigns/contact-sources.ts CAMPAIGN_PERSONAS already carries the
-- fourteen members.
--
-- AFTER-APPLY VERIFICATION:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.campaign_sequences'::regclass
--      and conname='campaign_sequences_persona_check';
--   → must list fourteen values including 'investor'.

BEGIN;

ALTER TABLE public.campaign_sequences DROP CONSTRAINT campaign_sequences_persona_check;

ALTER TABLE public.campaign_sequences
  ADD CONSTRAINT campaign_sequences_persona_check
  CHECK (persona IS NULL OR persona IN (
    'first_time', 'relocated', 'luxury', 'fsbo', 'probate',
    'upsize', 'downsize', 'military', 'divorce', 'senior',
    'expired', 'foreclosure', 'investor', 'other'
  ));

COMMIT;
