-- m187: reconcile the audience_type vocabulary drift.
-- The TS type / fb-audience-templates / ads UI used a GENERIC funnel vocabulary
-- (contact_list, website_visitors, engagement, lookalike, custom) while the live
-- CHECK only allowed a real-estate SEGMENT vocabulary (listing_visitors, … ,
-- persona_segment, custom) — so any audience created from a template/UI would
-- FAIL the CHECK. Widen the CHECK to the union so both work. (Follow-up: collapse
-- to a single vocabulary + data migration.)

alter table public.facebook_custom_audiences
  drop constraint if exists facebook_custom_audiences_audience_type_check;
alter table public.facebook_custom_audiences
  add constraint facebook_custom_audiences_audience_type_check check (audience_type = any (array[
    -- generic funnel vocabulary (templates + UI)
    'contact_list','website_visitors','engagement','lookalike','custom',
    -- real-estate segment vocabulary (original CHECK)
    'listing_visitors','video_viewers','newsletter_openers','portal_visitors','persona_segment'
  ]));
