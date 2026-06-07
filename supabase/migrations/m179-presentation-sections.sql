-- m179 — Wave 39: presentation_sections (seller-facing pre-listing drip).
--
-- The full listing presentation (CMA mixed in) is split into ordered SECTIONS
-- that drip to the SELLER via email + portal on a schedule BEFORE the listing
-- appointment — selling the relationship + the market ahead of the meeting.
--
-- HARD RULE: every customer-facing section is seller-safe (price_withheld) — a
-- suggested list price is NEVER shown; the CMA section presents market context
-- only and defers valuation to the in-person meeting.
--
-- Each section may carry a Remotion render (render_id) so the section is an
-- animated, narrated video. RLS mirrors listing_presentations exactly.

create table if not exists public.presentation_sections (
  id              uuid primary key default gen_random_uuid(),
  presentation_id uuid not null references public.listing_presentations(id) on delete cascade,
  brokerage_id    uuid not null,
  contact_id      uuid,
  section_key     text not null,
  section_order   integer not null,
  title           text,
  body            jsonb not null default '{}'::jsonb,
  render_id       uuid references public.remotion_composition_renders(id) on delete set null,
  channel         text not null default 'both'
                    check (channel = any (array['email','portal','both'])),
  price_withheld  boolean not null default true,
  status          text not null default 'pending'
                    check (status = any (array['pending','scheduled','delivered','viewed','failed'])),
  scheduled_for   timestamptz,
  delivered_at    timestamptz,
  viewed_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (presentation_id, section_key)
);

create index if not exists idx_presentation_sections_due
  on public.presentation_sections (scheduled_for)
  where status = 'scheduled';
create index if not exists idx_presentation_sections_contact
  on public.presentation_sections (contact_id);

alter table public.presentation_sections enable row level security;

create policy presentation_sections_tenant_select on public.presentation_sections
  for select using ((brokerage_id is null) or (brokerage_id = current_user_brokerage_id()));
create policy presentation_sections_tenant_insert on public.presentation_sections
  for insert with check (true);
create policy presentation_sections_tenant_update on public.presentation_sections
  for update using ((brokerage_id is null) or (brokerage_id = current_user_brokerage_id()));
create policy presentation_sections_tenant_delete on public.presentation_sections
  for delete using ((brokerage_id is null) or (brokerage_id = current_user_brokerage_id()));
create policy service_role_presentation_sections on public.presentation_sections
  for all to service_role using (true);
