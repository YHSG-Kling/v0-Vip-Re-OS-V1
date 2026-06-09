-- m188: consolidate the audience_type vocabulary to ONE set.
-- The drift was a true duplicate: 'contact_list' and 'custom' both mean "a list of
-- CRM contacts uploaded as a custom audience." Merge contact_list → custom and drop
-- it from the CHECK. The remaining types are distinct segments (website_visitors,
-- listing_visitors, portal_visitors, etc. are genuinely different audiences), and
-- 'lookalike' is kept (its seed is the lookalike_seed_audience_id column).

update public.facebook_custom_audiences set audience_type = 'custom' where audience_type = 'contact_list';

alter table public.facebook_custom_audiences
  drop constraint if exists facebook_custom_audiences_audience_type_check;
alter table public.facebook_custom_audiences
  add constraint facebook_custom_audiences_audience_type_check check (audience_type = any (array[
    'custom','lookalike','website_visitors','engagement',
    'listing_visitors','video_viewers','newsletter_openers','portal_visitors','persona_segment'
  ]));
