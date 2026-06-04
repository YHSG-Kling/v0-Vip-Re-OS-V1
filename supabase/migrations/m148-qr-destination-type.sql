-- m148 — semantic destination_type on qr_codes (Wave 36 QR router).
--
-- Before this commit qr_codes had `purpose` (free-form text used as a
-- filter on the listing UI: "general", "campaign", "listing", etc.) and
-- target_url (the actual redirect). That's enough to send a scanner to
-- the right page, but it loses the SEMANTIC of where they're going —
-- and the marketing-agent / analytics dashboards need that semantic to
-- compare "podcast QRs convert at X" vs "video-tour QRs convert at Y".
--
-- destination_type captures the SEMANTIC. target_url remains the
-- runtime URL. The router (app/api/qr/scan/route.ts) reads target_url
-- as today; analytics reads destination_type. The two can drift only
-- under operator error, which is easy to spot in the listing UI.
--
-- Canonical enum aligns with the surfaces Remotion can populate:
--   - landing_page       — generic landing template (current default)
--   - video_avatar_tour  — D-ID/HeyGen avatar tour of a listing
--   - cma_form           — CMA intake form (seller capture)
--   - listing_detail     — public listing detail page (live MLS feed)
--   - book_meeting       — direct-to-calendar booking link
--   - podcast_episode    — a podcast episode card with audio player
--   - anniversary_video  — anniversary/milestone celebration Remotion comp
--   - other              — fallback for surfaces we haven't enumerated yet
--
-- destination_type is nullable so existing rows aren't churned; future
-- writers should always set it.

alter table public.qr_codes
  add column if not exists destination_type text;

alter table public.qr_codes
  drop constraint if exists qr_codes_destination_type_check;
alter table public.qr_codes
  add constraint qr_codes_destination_type_check
  check (destination_type is null or destination_type in (
    'landing_page',
    'video_avatar_tour',
    'cma_form',
    'listing_detail',
    'book_meeting',
    'podcast_episode',
    'anniversary_video',
    'other'
  ));

create index if not exists idx_qr_codes_destination_type
  on public.qr_codes (brokerage_id, destination_type);

comment on column public.qr_codes.destination_type is 'Wave 36 canonical destination semantic. target_url remains the runtime redirect; this column lets analytics aggregate scans by destination kind.';
