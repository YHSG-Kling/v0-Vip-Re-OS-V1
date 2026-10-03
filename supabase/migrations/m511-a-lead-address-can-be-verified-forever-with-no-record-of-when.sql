-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m511_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m511 — A LEAD'S ADDRESS CAN BE "VERIFIED" FOREVER, WITH NO RECORD OF WHEN.
--
-- NOT APPLIED BY THIS LANE. Lanes write migrations; the integrator applies them.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- The owner's wave-14 conversion ruling makes `leads.mailing_address_verified`
-- load-bearing: "the gate approves only if there is a first name and last name
-- and email and/or phone number and/or a mailing address verified." The gate now
-- enforces it (lib/lead-pipeline/canonical-lead-eligibility.ts) and a real writer
-- now sets it (lib/lead-pipeline/promotion-address-verification.ts, which buys one
-- Lob US-verification when the address is a record's only possible anchor).
--
-- But the leads table records only the VERDICT, never WHEN it was reached.
-- `contacts` already carries the pair — m146 added both
-- `contacts.mailing_address_verified` and `contacts.mailing_address_verified_at`,
-- and its own comment states the rule the timestamp is FOR:
--
--     'last Lob verification timestamp; re-verify after 12 months. Wave 36.'
--
-- `leads` got the flag and not the clock. So a lead verified once is verified
-- forever: nothing can express "this verdict is two years old", nothing can
-- expire it, and the 12-month re-verification rule the sibling table states
-- cannot be evaluated on the table where the promotion gate actually reads. That
-- is the same shape as a flag with no honest writer, one step later — an honest
-- writer whose output has no expiry.
--
-- This is ADDITIVE and nullable: every existing row keeps whatever it has, and a
-- NULL means exactly "we have no timestamp for this verdict", which is the truth
-- for every row written before this column existed. Nothing is backfilled — a
-- fabricated verification date would be worse than none.
--
-- ── WHAT TO CHANGE AFTER APPLYING ────────────────────────────────────────────
-- Only after this lands may writers stamp it:
--   · lib/lead-pipeline/promotion-address-verification.ts — add
--     mailing_address_verified_at to the persisted patch for the `leads` table.
--   · app/actions/lead-quick-actions.ts:verifyLeadAddressAction — stamp it
--     alongside mailing_address_verified + mailing_address_source, exactly as the
--     contact twin in app/actions/contact-quick-actions.ts now does.
-- Until then those writers must NOT name the column: PGRST204 refuses the WHOLE
-- update, not just the unknown field, and a refused update would silently leave
-- the verified flag unwritten.

alter table public.leads
  add column if not exists mailing_address_verified_at timestamptz;

comment on column public.leads.mailing_address_verified_at is
  'Last Lob US-verification timestamp for mailing_address; re-verify after 12 months. Mirrors contacts.mailing_address_verified_at (m146). NULL = no timestamp on record, never "unverified" — read mailing_address_verified for the verdict. Wave 14.';

-- Finding stale verdicts is the whole point of the column, so index for it.
create index if not exists idx_leads_mailing_verified_at
  on public.leads (mailing_address_verified_at)
  where mailing_address_verified = true;
