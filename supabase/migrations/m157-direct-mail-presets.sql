-- m157 — saved campaign preset library (Wave 36 final item).
--
-- Admin builds a fixed mailer (locked composition + locked copy +
-- locked size) that subsequent dispatches invoke verbatim, bypassing
-- the bandit for high-stakes one-off sends — anniversary blast,
-- listing-launch flagship piece, agent-relocation announcement.
--
-- The compliance gate runs ONCE at preset save time; the resulting
-- compliance_event_id is stamped on the preset so the audit trail
-- survives every future dispatch from the preset without re-running
-- the AI gate. (Re-validate compliance only when the copy changes.)
--
-- Why presets sit alongside the bandit, not replace it:
--   · Bandit IS production for high-volume continuous flows (farm
--     mail, sphere, lifecycle) — it explores + converges over weeks
--   · Presets ARE production for high-stakes one-offs — the admin
--     wants exact-control, the audit needs reproducibility, and the
--     creative is hand-tuned beyond what the AI prompt would output
--
-- direct_mail_presets:
--   name              human label ("Just-Sold Flagship", "Anniversary
--                                   Blast", "Relocation Announcement")
--   piece_type        'postcard' | 'letter' — Lob piece kind
--   postcard_size     '4x6' | '6x9' (null when piece_type='letter')
--   composition_id    Remotion comp id when piece_type='postcard'
--                     (PostcardFront4x6 / PostcardFront6x9)
--   locked_headline / locked_body / locked_cta — postcard copy
--   locked_letter_greeting / locked_letter_body / locked_letter_signoff
--   status_badge      optional "JUST SOLD" etc. for 6x9 hero
--   property_photo_url optional — when set, the hero photo on 6x9
--   fallback_template_id Lob template used if render fails
--   compliance_event_id FK to compliance_events row that gated the
--                       locked copy at save time
--   is_active         soft-deactivate without losing audit history
--
-- Tenant-scoped — preset rows are always (brokerage_id NOT NULL).
-- No platform-wide presets; the catalog is per-brokerage by design
-- (these are HAND-TUNED pieces specific to the broker's branding).

create table if not exists public.direct_mail_presets (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  name                     text not null,
  piece_type               text not null check (piece_type in ('postcard', 'letter')),
  postcard_size            text check (postcard_size is null or postcard_size in ('4x6', '6x9')),
  composition_id           text,
  -- Postcard copy
  locked_headline          text,
  locked_body              text,
  locked_cta               text,
  status_badge             text,
  property_photo_url       text,
  pull_quote               text,
  -- Letter copy
  locked_letter_greeting   text,
  locked_letter_body       text,
  locked_letter_signoff    text,
  -- Routing + audit
  fallback_template_id     text,
  compliance_event_id      uuid references public.compliance_events(id) on delete set null,
  is_active                boolean default true,
  created_by               uuid,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_direct_mail_presets_active
  on public.direct_mail_presets (brokerage_id)
  where is_active = true;

-- Stamp on dispatched campaigns so the analytics view + audit query
-- can answer "which preset shipped this piece?" in O(1).
alter table public.direct_mail_campaigns
  add column if not exists preset_id uuid;

alter table public.direct_mail_campaigns
  drop constraint if exists direct_mail_campaigns_preset_id_fkey;
alter table public.direct_mail_campaigns
  add constraint direct_mail_campaigns_preset_id_fkey
  foreign key (preset_id)
  references public.direct_mail_presets(id)
  on delete set null;

create index if not exists idx_direct_mail_campaigns_preset
  on public.direct_mail_campaigns (preset_id)
  where preset_id is not null;

comment on table public.direct_mail_presets is 'Wave 36: hand-tuned campaign presets that bypass the bandit. Compliance gate runs once at save time; preset_id stamped on every dispatched campaign for audit.';
comment on column public.direct_mail_campaigns.preset_id is 'Wave 36: which preset shipped this piece (null for bandit-driven dispatches).';
