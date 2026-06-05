-- m156 — smart photo selection + per-piece compliance audit link.
--
-- Wave 36, two small schema enhancements:
--
-- ── 1) listing_photos.is_hero
--    listing_photos currently sorts by order_index for the "hero" photo
--    decision. That's a reasonable default but agents often upload
--    exterior shots first (curb appeal), and an exterior-only hero on
--    a 6x9 postcard reads boring vs an interior glamour shot. The
--    is_hero flag lets the agent / AI photo-curation step explicitly
--    flag the postcard hero, independent of MLS ordering.
--
--    Partial unique index: at most one is_hero=true row per listing
--    so the reactor's query always returns a single deterministic pick.
--
-- ── 2) direct_mail_campaigns.compliance_event_id
--    compliance_events already carries (entity_type, entity_id) so it
--    CAN be linked to a campaign — but the back-reference (from
--    campaign → its compliance event) was missing, making the
--    "show me every gate result for this piece" query a backward
--    scan. Adding the FK lets us answer that query in O(1) and
--    surface "Fair Housing check: passed" on the campaign's row in
--    the admin dashboard without a separate join.

alter table public.listing_photos
  add column if not exists is_hero boolean default false;

create unique index if not exists uq_listing_photos_one_hero_per_listing
  on public.listing_photos (listing_id)
  where is_hero = true;

alter table public.direct_mail_campaigns
  add column if not exists compliance_event_id uuid;

alter table public.direct_mail_campaigns
  drop constraint if exists direct_mail_campaigns_compliance_event_id_fkey;
alter table public.direct_mail_campaigns
  add constraint direct_mail_campaigns_compliance_event_id_fkey
  foreign key (compliance_event_id)
  references public.compliance_events(id)
  on delete set null;

comment on column public.listing_photos.is_hero is 'Wave 36: explicit hero flag for direct-mail postcard photo selection. Overrides order_index=0 when set. At most one per listing (partial unique index).';
comment on column public.direct_mail_campaigns.compliance_event_id is 'Wave 36: FK to compliance_events row that gated this piece. Lets the admin dashboard show gate result per-piece in O(1) without a back-scan join.';
