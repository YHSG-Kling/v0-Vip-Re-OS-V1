-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m575_…`. It was one of TWENTY files in this directory whose header said
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

-- m575-the-revenue-share-mark-enabled-a-payout-the-brokerage-never-described.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE REVENUE-SHARE DISTRIBUTION MODEL — settings the platform READS, not assumes.
--
-- WRITTEN 2026-08-27, NOT APPLIED (integrator applies; lanes only write).
-- After applying: regenerate the schema caches (schema-snapshot.ts,
-- schema-fk-map.ts) AND the vocabulary cache (check-vocabularies.ts) — this
-- migration adds CHECK constraints (CLAUDE.md §3).
--
-- OWNER RULING (2026-08-27, verbatim): "revenue share mark should not be
-- created with any assumption of how it gets configured so the settings should
-- be telling the platform how the revenue share gets distributed whether it is
-- a portion of the income or the brokerage pays the share as a flat fee or %
-- and duration. platform should not make assumption even with referrals."
--
-- WHAT WAS ASSUMED BEFORE THIS MIGRATION:
--   · app/api/recruiting/provision-agent/route.ts stamped every new downline
--     edge with a HARDCODED revenue_share_percent: 5 and source_of_funds:
--     'brokerage' — the platform inventing the brokerage's plan.
--   · The waterfall (lib/commission/waterfall/09-revenue-share.ts) could only
--     compute PERCENT shares — flat-fee revenue share had no representation —
--     and ignored effective_from/effective_to entirely, so duration existed as
--     columns with no enforcement.
--
-- THE MODEL (brokerage-level; per-edge terms already live on agent_relationships):
--   SOURCE   — whose money funds the share: a portion of the AGENT's income, or
--              the BROKERAGE pays it. Vocabulary = agent_relationships.
--              source_of_funds's live CHECK ('agent','brokerage') — ONE
--              vocabulary (§6), no second spelling.
--   RATE     — 'percent' (of the agent's rolling net, the base the waterfall
--              already uses) or 'flat' (cents PER TRANSACTION — the waterfall
--              runs once per closing; there is no monthly period engine in the
--              commission rail, so "per period" has no runner and 'flat' means
--              per closing). Vocabulary = the repo's rate-type pair
--              ('percent','flat' — commission_distributions.calculation_type).
--   DURATION — months a NEW relationship's share runs. The model sets the
--              DEFAULT stamped onto new edges (effective_to = effective_from +
--              N months); it does NOT retroactively rewrite existing edges —
--              an edge's stamped window is its record, like referral_payouts.
--              fee_percent survives a later terms change (m573 precedent).
--              0 = indefinite, an EXPLICIT choice. NULL = unconfigured.
--
-- FAIL-CLOSED: every model column is NULL by default. NULL = unconfigured, and
-- an unconfigured model means the revenue_share_enabled mark ALONE pays nothing:
-- the waterfall's step 09 no-ops (empty distributions, skip reason recorded)
-- and the relationship-creation writer plants NO edge — nothing is invented.
--
-- BACKFILL only where the model is demonstrably IN FORCE (the m264/m574
-- precedent): a brokerage with active percent-bearing edges gets a model
-- TRANSCRIBED from those edges — rate 'percent', the modal source_of_funds,
-- the modal percent, duration 0 (indefinite — those edges' effective_to IS
-- null today; transcription, not assumption) — so existing payouts don't stop
-- the day this applies.

-- 1) The brokerage-level distribution model.
alter table public.brokerages
  add column if not exists revenue_share_source_of_funds text;
alter table public.brokerages
  add column if not exists revenue_share_rate_type text;
alter table public.brokerages
  add column if not exists revenue_share_default_percent numeric;
alter table public.brokerages
  add column if not exists revenue_share_flat_cents integer;
alter table public.brokerages
  add column if not exists revenue_share_duration_months integer;

alter table public.brokerages
  drop constraint if exists brokerages_revenue_share_source_of_funds_check;
alter table public.brokerages
  add constraint brokerages_revenue_share_source_of_funds_check
  check (revenue_share_source_of_funds is null or revenue_share_source_of_funds in ('agent', 'brokerage'));

alter table public.brokerages
  drop constraint if exists brokerages_revenue_share_rate_type_check;
alter table public.brokerages
  add constraint brokerages_revenue_share_rate_type_check
  check (revenue_share_rate_type is null or revenue_share_rate_type in ('percent', 'flat'));

alter table public.brokerages
  drop constraint if exists brokerages_revenue_share_default_percent_check;
alter table public.brokerages
  add constraint brokerages_revenue_share_default_percent_check
  check (revenue_share_default_percent is null or (revenue_share_default_percent > 0 and revenue_share_default_percent <= 100));

alter table public.brokerages
  drop constraint if exists brokerages_revenue_share_flat_cents_check;
alter table public.brokerages
  add constraint brokerages_revenue_share_flat_cents_check
  check (revenue_share_flat_cents is null or revenue_share_flat_cents > 0);

alter table public.brokerages
  drop constraint if exists brokerages_revenue_share_duration_months_check;
alter table public.brokerages
  add constraint brokerages_revenue_share_duration_months_check
  check (revenue_share_duration_months is null or revenue_share_duration_months >= 0);

comment on column public.brokerages.revenue_share_source_of_funds is
  'Distribution model SOURCE: whose money funds the share — ''agent'' (a portion of the agent''s income) or ''brokerage'' (the brokerage pays it). Same vocabulary as agent_relationships.source_of_funds (§6). NULL = unconfigured → no share is paid and no edge is planted (fail-closed). Written only by setRevenueShareDistributionModel (app/actions/settings/revenue-share-setting.ts).';
comment on column public.brokerages.revenue_share_rate_type is
  'Distribution model RATE TYPE: ''percent'' (of the agent''s rolling net) or ''flat'' (cents per closing — the waterfall runs per transaction). NULL = unconfigured (fail-closed). One writer: setRevenueShareDistributionModel.';
comment on column public.brokerages.revenue_share_default_percent is
  'When rate_type=''percent'': the default share % stamped onto NEW agent_relationships edges (replaces the hardcoded 5 the provisioning route used to invent). Existing edges keep their stamped percent.';
comment on column public.brokerages.revenue_share_flat_cents is
  'When rate_type=''flat'': the flat share in cents PER CLOSING stamped onto NEW edges (agent_relationships.revenue_share_flat_cents).';
comment on column public.brokerages.revenue_share_duration_months is
  'Distribution model DURATION: months a NEW relationship''s share runs (effective_to = effective_from + N months on new edges). 0 = indefinite (an EXPLICIT choice). NULL = unconfigured (fail-closed). Never rewrites existing edges.';

-- 2) The per-edge flat rate — the edge is the record of ITS terms (percent OR
--    flat cents), stamped from the model at creation so a later model change is
--    never retroactive (the m573 fee_percent denormalization precedent).
alter table public.agent_relationships
  add column if not exists revenue_share_flat_cents integer;

alter table public.agent_relationships
  drop constraint if exists agent_relationships_revenue_share_flat_cents_check;
alter table public.agent_relationships
  add constraint agent_relationships_revenue_share_flat_cents_check
  check (revenue_share_flat_cents is null or revenue_share_flat_cents > 0);

comment on column public.agent_relationships.revenue_share_flat_cents is
  'Flat share in cents per closing for this edge (stamped from the brokerage model at creation; NULL on percent-era edges, which carry revenue_share_percent instead). The waterfall reads the EDGE''s terms; the brokerage model gates whether anything is paid at all.';

-- 3) Backfill: transcribe the model already in force. Only brokerages that
--    BOTH enabled revenue share AND have active percent-bearing edges — the
--    m264 backfill population — get a model, and every value is read off those
--    edges, not invented. Idempotent (only fills NULLs).
update public.brokerages b
set revenue_share_rate_type = 'percent',
    revenue_share_source_of_funds = (
      select r.source_of_funds from public.agent_relationships r
      where r.brokerage_id = b.id and r.is_active = true and coalesce(r.revenue_share_percent, 0) > 0
        and r.source_of_funds in ('agent', 'brokerage')
      group by r.source_of_funds order by count(*) desc, r.source_of_funds limit 1
    ),
    revenue_share_default_percent = (
      select r.revenue_share_percent from public.agent_relationships r
      where r.brokerage_id = b.id and r.is_active = true and coalesce(r.revenue_share_percent, 0) > 0
      group by r.revenue_share_percent order by count(*) desc, r.revenue_share_percent limit 1
    ),
    -- 0 = indefinite: those edges' effective_to IS NULL live today. This is a
    -- transcription of the terms in force, not a platform default — a NEW
    -- configuration (the settings panel) requires duration to be chosen.
    revenue_share_duration_months = 0
where b.revenue_share_enabled = true
  and b.revenue_share_rate_type is null
  and exists (
    select 1 from public.agent_relationships r
    where r.brokerage_id = b.id and r.is_active = true and coalesce(r.revenue_share_percent, 0) > 0
      and r.source_of_funds in ('agent', 'brokerage')
  );
