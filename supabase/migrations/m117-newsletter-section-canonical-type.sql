-- m117 — canonical newsletter section taxonomy.
-- Consolidates 4 parallel section vocabularies (Track A "intro/tips/listings…",
-- Insider Edit "hook/events/civic/deal/eats", Template Builder "real_estate_tip/
-- market_update/local_news/agent_feature/property_highlight", Legacy AI Writer
-- "hero/featured_listings/market_update/tips/testimonial/cta/custom") into one
-- enum-grade vocabulary the publisher cron + assembler + UI tabs share.

alter table public.newsletter_sections
  add column if not exists section_type text;

alter table public.newsletter_sections
  drop constraint if exists newsletter_sections_section_type_check;

alter table public.newsletter_sections
  add constraint newsletter_sections_section_type_check
  check (section_type is null or section_type in (
    'agent_intro',
    'market_update',
    'new_listings',
    'property_highlight',
    'local_news',
    'local_event',
    'neighborhood_spotlight',
    'mortgage_rates',
    'tips',
    'testimonial',
    'community_eats',
    'cta',
    'custom'
  ));

create index if not exists idx_newsletter_sections_section_type
  on public.newsletter_sections (newsletter_id, section_type);

comment on column public.newsletter_sections.section_type is
  'Canonical section taxonomy (m117). Generators write these values; the publisher uses them for default ordering when order_index is unset, and the assembler uses them to pick rendering hints.';
