-- m587 — contacts.status: one vocabulary, and a CHECK that finally refuses the rest
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-08-31 (lanes
-- write migrations; only the integrator applies them, CLAUDE.md §3). Verified
-- AFTER applying: contacts_status_check exists with convalidated=true and the
-- eight-member roster below, and the pre-apply data (4 rows, all 'active')
-- passed VALIDATE untouched. The vocabulary cache was regenerated from the
-- live pg_constraint extract the same day — and that regeneration immediately
-- caught lib/brokerage-intelligence/miners.ts comparing status against three
-- values the column can never hold, which is the cache doing its job.
-- This header does not read "WRITTEN, NOT APPLIED" any more on purpose: §2
-- names that string as a waypoint no assertion may pin to, and a file that
-- keeps claiming an intermediate state after it stops being true is how a
-- guard passes only while the repo lies. The integrator
-- MUST regenerate the vocabulary cache (scripts/generate-* → scripts/
-- check-vocabularies.ts) so check-vocabulary-guard can hold code and database
-- in agreement on the new constraint — and the code-side single source,
-- lib/contact-promotion/qualification.ts CONTACT_STATUSES, is written to match
-- this file member-for-member.
--
-- ── LIVE MEASUREMENTS (project hrvaqgvukzxfskkcrwbt) ─────────────────────────
--   · contacts.status carries NO CHECK constraint (verified live 2026-08-29:
--     the ten CHECKs on contacts cover ai_autopilot_level, buyer_stage,
--     contact_persona, contact_type, lead_temperature, lender_status,
--     lifetime_segment, phone_status, referral_potential, timeline — status is
--     not among them). Column DEFAULT is 'new'.
--   · Live data 2026-08-31: 4 rows, all status = 'active'. The UPDATEs below
--     therefore expect to touch 0 rows today — they exist so this migration is
--     correct on ANY data (a §2 waypoint pin to "only 'active' exists" would be
--     false the day an import runs).
--   · No migration backfill, no RPC and no trigger writes contacts.status
--     (grepped supabase/migrations for UPDATE/INSERT on public.contacts and for
--     functions naming it) — the code writers enumerated in qualification.ts
--     are the complete writer set.
--
-- ── THE VOCABULARY (per-value verdicts in qualification.ts's header) ─────────
--   new · contacted · active · nurture · qualified · inactive · archived · deleted
--
-- ── THE MAPPING (kept in lockstep with canonicalContactStatus() in
--    lib/contact-promotion/qualification.ts — change one, change both) ────────
--   'lead'            → 'new'       a lead-magnet capture is a NEW contact; the
--                                   writer (lib/kernel/lead-magnets.ts:439) now
--                                   writes 'new'
--   'nurturing'       → 'nurture'   spelling drift
--   'active_client'   → 'active'    phantom reader spelling (app/actions/copilot.ts)
--   'hot_lead','hot'  → 'active'    heat is a TEMPERATURE (lead_temperature,
--                                   live CHECK cold/hot/warm); the status rows,
--                                   if any exist, were being actively worked.
--                                   lead_temperature is NOT overwritten here: a
--                                   row's existing temperature is real data and
--                                   a status spelling is not evidence hot ever
--                                   held — repointed READERS now ask the column
--                                   that actually carries heat.
--   'closed','sold'   → 'inactive'  done-for-now dormancy
--   'do_not_contact'  → 'inactive'  AND dnc_status = TRUE — the DNC fact lives
--                                   on dnc_status (the compliance hard-block);
--                                   folding the spelling away without setting
--                                   the boolean would DROP a suppression, so the
--                                   boolean is stamped first (§1: merge onto the
--                                   survivor before deleting the duplicate)
--   'appointment_booked','signed_agreement','pre_listing','active_listing',
--   'contingent','pending','lifetime_customer'
--                     → 'active'    the aiMappingService journey ladder: deal/
--                                   journey facts that live on buyer_stage,
--                                   listings.status, transactions and
--                                   contact_type, never contact lifecycle
--   anything else     → 'new'       the column DEFAULT; conservative catch-all
--                                   so VALIDATE cannot be wedged by a value this
--                                   file did not foresee
--
-- ── ORDER OF OPERATIONS (why NOT VALID comes FIRST) ──────────────────────────
-- 1. ADD CONSTRAINT … NOT VALID: Postgres enforces a NOT VALID check on all NEW
--    writes immediately while skipping the existing-row scan — so from this
--    statement on, no concurrent insert can add an out-of-vocabulary row and
--    race the backfill.
-- 2. UPDATE the existing rows onto their survivors (these writes themselves
--    satisfy the new check, so step 1 does not block them).
-- 3. VALIDATE CONSTRAINT: scans existing rows only, takes no exclusive lock
--    worth fearing, and can no longer fail — everything old was mapped in
--    step 2 and everything new was checked since step 1.
-- NULL note: CHECK (status IN (…)) is satisfied by NULL (SQL three-valued
-- logic), so a NULL status remains storable exactly as today; the column
-- default 'new' covers the normal path and no reader treats NULL as a state.

BEGIN;

-- 1 ── refuse new out-of-vocabulary writes before touching any row
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_status_check
  CHECK (status IN (
    'new', 'contacted', 'active', 'nurture', 'qualified',
    'inactive', 'archived', 'deleted'
  )) NOT VALID;

-- 2 ── map existing rows onto their survivors (0 rows expected live today)

-- do_not_contact FIRST, because it also stamps the surviving boolean — the
-- generic catch-alls below would otherwise swallow it and drop the suppression.
UPDATE public.contacts
   SET dnc_status = TRUE, status = 'inactive'
 WHERE status = 'do_not_contact';

UPDATE public.contacts SET status = 'new'      WHERE status = 'lead';
UPDATE public.contacts SET status = 'nurture'  WHERE status = 'nurturing';
UPDATE public.contacts SET status = 'active'
 WHERE status IN ('active_client', 'hot_lead', 'hot', 'appointment_booked',
                  'signed_agreement', 'pre_listing', 'active_listing',
                  'contingent', 'pending', 'lifetime_customer');
UPDATE public.contacts SET status = 'inactive' WHERE status IN ('closed', 'sold');

-- catch-all: anything this file did not foresee lands on the column DEFAULT
-- rather than wedging VALIDATE below. Deliberately LAST.
UPDATE public.contacts
   SET status = 'new'
 WHERE status IS NOT NULL
   AND status NOT IN ('new', 'contacted', 'active', 'nurture', 'qualified',
                      'inactive', 'archived', 'deleted');

-- 3 ── now provably clean: validate against the existing rows
ALTER TABLE public.contacts
  VALIDATE CONSTRAINT contacts_status_check;

COMMIT;
