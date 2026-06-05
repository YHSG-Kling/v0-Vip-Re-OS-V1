-- m155 — direct-mail variant tracking + multi-armed bandit foundation.
--
-- Wave 36 — the differentiator. No incumbent (MoxiWorks, kvCORE,
-- BoomTown, Lofty, Real Geeks) treats direct-mail design as anything
-- but a static template. This commit ships the data model that turns
-- every postcard send into a learning event the AI can act on next
-- cycle.
--
-- THREE DESIGN DIMENSIONS we track per send:
--   composition_id  Which Remotion comp (PostcardFront4x6 v1 / v2 /
--                   PostcardFront6x9 v1 / etc.) rendered the piece
--   copy_style      Which prompt template was used to draft the copy
--                   ("direct-fact" / "question-hook" / "social-proof" /
--                   "scarcity-soft" / etc.) — the prompt template id
--                   from a future copy_styles table; for now we just
--                   store the style key
--   layout_variant  Position of headline/body/CTA/QR. Same composition
--                   can have variant_a / variant_b layouts in code.
--
-- Plus the cohort dimensions: persona × use_kind × postcard_size.
-- Together (composition × copy_style × layout × persona × use_kind ×
-- size) gives us the bandit's arm space.
--
-- Each direct_mail_campaigns row gets a variant FK pointing to which
-- arm fired. Scan attribution flows through the existing qr_code_id +
-- qr_scan_events chain so we don't need new join plumbing.
--
-- ── m155.1: direct_mail_variants — the arm catalog
--    One row per (composition, copy_style, layout, persona, use_kind,
--    size) combination. Created on-demand by the bandit selector the
--    first time it considers an arm; never deleted (arms can be
--    deprecated via is_active=false instead so historical data stays
--    queryable).
create table if not exists public.direct_mail_variants (
  id              uuid primary key default gen_random_uuid(),
  brokerage_id    uuid references public.brokerages(id) on delete cascade,
  -- null brokerage_id = platform-wide variant available to every tenant
  composition_id  text not null,
  copy_style      text not null,
  layout_variant  text not null default 'default',
  persona         text not null,
  use_kind        text not null check (use_kind in ('farm_mail', 'welcome_kit', 'sphere_outreach', 'lifecycle', 'pre_listing_kit')),
  postcard_size   text not null check (postcard_size in ('4x6', '6x9')),
  is_active       boolean default true,
  created_at      timestamptz default now(),
  unique (brokerage_id, composition_id, copy_style, layout_variant, persona, use_kind, postcard_size)
);

create index if not exists idx_direct_mail_variants_active
  on public.direct_mail_variants (brokerage_id, persona, use_kind, postcard_size)
  where is_active = true;

-- ── m155.2: direct_mail_variant_outcomes — per-arm performance ledger
--    Per (variant, brokerage) row that gets UPDATEd as scans + leads
--    accrue. Computed once daily by an aggregator; the bandit reads
--    only this table (one row per arm, fast).
--
--    Bandit math (Thompson sampling, Beta(α, β)):
--      α = scans_count + 1     (positive observations)
--      β = sends_count - scans_count + 1  (negative observations)
--    Sample a posterior probability per arm, pick the arm with highest
--    sample. Cold arms (scans_count=0) start with Beta(1, sends_count+1)
--    which gives them probability ~0.5 ± noise — natural exploration
--    without an explicit ε-greedy schedule.
create table if not exists public.direct_mail_variant_outcomes (
  id                uuid primary key default gen_random_uuid(),
  variant_id        uuid not null references public.direct_mail_variants(id) on delete cascade,
  brokerage_id      uuid not null references public.brokerages(id) on delete cascade,
  sends_count       integer not null default 0,
  scans_count       integer not null default 0,
  leads_count       integer not null default 0,  -- when a contact converts post-scan
  cost_spent_cents  bigint  not null default 0,
  last_send_at      timestamptz,
  last_scan_at      timestamptz,
  updated_at        timestamptz default now(),
  unique (variant_id, brokerage_id)
);

create index if not exists idx_direct_mail_variant_outcomes_brokerage
  on public.direct_mail_variant_outcomes (brokerage_id, scans_count desc);

-- ── m155.3: direct_mail_campaigns gets a variant FK
--    Stamped by the orchestrator at dispatch time so the aggregator
--    can join campaigns → qr_scan_events → contacts → back to the
--    variant.
alter table public.direct_mail_campaigns
  add column if not exists variant_id uuid;

alter table public.direct_mail_campaigns
  drop constraint if exists direct_mail_campaigns_variant_id_fkey;
alter table public.direct_mail_campaigns
  add constraint direct_mail_campaigns_variant_id_fkey
  foreign key (variant_id)
  references public.direct_mail_variants(id)
  on delete set null;

create index if not exists idx_direct_mail_campaigns_variant
  on public.direct_mail_campaigns (variant_id)
  where variant_id is not null;

comment on table public.direct_mail_variants         is 'Wave 36: A/B test arm catalog — (composition × copy_style × layout × persona × use_kind × size). The bandit selects an arm per dispatch; outcomes feed the per-arm performance ledger.';
comment on table public.direct_mail_variant_outcomes is 'Wave 36: per-(variant, brokerage) performance ledger the Thompson-sampling bandit reads to pick the next arm. Updated daily by the aggregator.';
comment on column public.direct_mail_campaigns.variant_id is 'Wave 36: which A/B arm rendered this piece. Null for legacy pre-bandit sends.';
