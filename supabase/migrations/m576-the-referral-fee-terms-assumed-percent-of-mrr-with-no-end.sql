-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m576_…`. It was one of TWENTY files in this directory whose header said
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

-- m576-the-referral-fee-terms-assumed-percent-of-mrr-with-no-end.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- SUBSCRIBER-REFERRAL FEE TERMS: BASIS + DURATION join the rate's one home.
--
-- WRITTEN 2026-08-27, NOT APPLIED (integrator applies; lanes only write).
-- After applying: regenerate the schema caches (schema-snapshot.ts,
-- schema-fk-map.ts) AND the vocabulary cache (check-vocabularies.ts) — this
-- migration adds CHECK constraints (CLAUDE.md §3).
--
-- OWNER RULING (2026-08-27, verbatim): "platform should not make assumption
-- even with referrals."
--
-- WHAT WAS ASSUMED BEFORE THIS MIGRATION: m573 gave the fee RATE a home
-- (platform_settings.referral_fee_percent) but the BASIS (percent of the
-- referred tenant's MRR) and the DURATION (forever — staff could post every
-- month with no end) were baked into code and UI copy. The growth card's
-- header literally said "% of the referred tenant's MRR" as the only possible
-- shape.
--
-- THE FULL TERMS (all on the platform_settings singleton row, beside the m573
-- rate — ONE home, §6):
--   BASIS    — 'percent' (of the referred tenant's MRR, the m573 shape) or
--              'flat' (a flat amount per conversion). Vocabulary = the repo's
--              rate-type pair ('percent','flat'), the same spelling every other
--              rate-type CHECK uses (§6).
--   FLAT     — referral_fee_flat_cents, the flat amount when basis='flat'.
--   DURATION — referral_fee_duration_months: how many months of MRR the fee
--              runs, anchored on the FIRST posted (non-void) period for the
--              prospect. 1 = a one-time fee. 0 = indefinite — an EXPLICIT
--              choice, never a default. NULL = unconfigured.
--
-- FAIL-CLOSED: every new column is NULL by default — no DB default, because a
-- default here would be the platform assuming again. Unconfigured basis/
-- duration fall back to the CODE default (lib/platform/subscriber-referrals.ts
-- REFERRAL_FEE_BASIS_DEFAULT / REFERRAL_FEE_DURATION_MONTHS_DEFAULT) ONLY via
-- getReferralFeeTerms, which REPORTS the source of every field
-- (platform_settings vs default_constant) — the m573 source-reporting pattern
-- extended, never forked. The code default duration is 12 months, deliberately
-- BOUNDED: indefinite must be chosen, never inherited.
--
-- ENFORCEMENT: lib/platform/referral-payouts.ts::postReferralPayout reads the
-- full terms and REFUSES a posting for a month beyond the configured duration
-- (reason 'beyond_duration', naming the term and where it came from).
--
-- 1) The terms' new fields, beside the m573 rate.
alter table public.platform_settings
  add column if not exists referral_fee_basis text;
alter table public.platform_settings
  add column if not exists referral_fee_flat_cents integer;
alter table public.platform_settings
  add column if not exists referral_fee_duration_months integer;

alter table public.platform_settings
  drop constraint if exists platform_settings_referral_fee_basis_check;
alter table public.platform_settings
  add constraint platform_settings_referral_fee_basis_check
  check (referral_fee_basis is null or referral_fee_basis in ('percent', 'flat'));

alter table public.platform_settings
  drop constraint if exists platform_settings_referral_fee_flat_cents_check;
alter table public.platform_settings
  add constraint platform_settings_referral_fee_flat_cents_check
  check (referral_fee_flat_cents is null or referral_fee_flat_cents > 0);

alter table public.platform_settings
  drop constraint if exists platform_settings_referral_fee_duration_months_check;
alter table public.platform_settings
  add constraint platform_settings_referral_fee_duration_months_check
  check (referral_fee_duration_months is null or referral_fee_duration_months >= 0);

comment on column public.platform_settings.referral_fee_basis is
  'Referral-fee BASIS: ''percent'' (of the referred tenant''s MRR) or ''flat'' (flat amount per conversion). NULL = unconfigured → code default (''percent''), used ONLY through getReferralFeeTerms which reports the source. Part of the terms'' one home (§6, m573).';
comment on column public.platform_settings.referral_fee_flat_cents is
  'Flat referral fee in cents (used when referral_fee_basis=''flat''). A flat basis without this amount is treated as unconfigured (fail-closed to the reported code default).';
comment on column public.platform_settings.referral_fee_duration_months is
  'How many months of MRR the referral fee runs, anchored on the first posted period per prospect. 1 = one-time. 0 = indefinite (EXPLICIT choice only — never a default). NULL = unconfigured → bounded code default (12), reported as default_constant. postReferralPayout refuses postings beyond this term.';

-- 2) Denormalize the basis onto each posting, like m573''s fee_percent — the
--    ledger row is the record of the terms it was posted UNDER, surviving any
--    later terms change. NULL = legacy percent-era rows.
alter table public.referral_payouts
  add column if not exists basis text;

alter table public.referral_payouts
  drop constraint if exists referral_payouts_basis_check;
alter table public.referral_payouts
  add constraint referral_payouts_basis_check
  check (basis is null or basis in ('percent', 'flat'));

comment on column public.referral_payouts.basis is
  'The fee basis this payout was posted under (''percent'' of MRR / ''flat'' per conversion), stamped at post time by postReferralPayout. NULL = posted before m576 (percent era).';
