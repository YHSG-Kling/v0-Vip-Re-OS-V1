-- m115 — newsletter sections gain per-persona targeting + tenant ownership.
-- A section with NULL target_personas renders for every recipient (the brokerage
-- default); a section with target_personas=['investor','first_time_buyer'] only
-- renders when contacts.contact_persona matches. This lets the publisher cron
-- assemble a per-recipient newsletter body from one shared editorial structure.

alter table public.newsletter_sections
  add column if not exists target_personas text[],
  add column if not exists brokerage_id uuid references public.brokerages(id) on delete cascade;

update public.newsletter_sections ns
   set brokerage_id = n.brokerage_id
  from public.newsletters n
 where n.id = ns.newsletter_id
   and ns.brokerage_id is null;

create index if not exists idx_newsletter_sections_brokerage
  on public.newsletter_sections (brokerage_id);
create index if not exists idx_newsletter_sections_newsletter_order
  on public.newsletter_sections (newsletter_id, order_index);

comment on column public.newsletter_sections.target_personas is
  'NULL = render for every recipient. Otherwise match against contacts.contact_persona.';
