-- m125 — widen listing_promo_videos.status to include 'remotion_pending'.
-- Wave 11 produced a D-ID talking-head for listing_promo videos. The correct
-- format is a Remotion-rendered property reel — until that ships, the reactor
-- parks new triggers at 'remotion_pending' so no D-ID dollars go to the wrong
-- format. Ledger, compliance-cleared script, and listing facts stay available
-- for the Remotion build to consume.

alter table public.listing_promo_videos
  drop constraint if exists listing_promo_videos_status_check;

alter table public.listing_promo_videos
  add constraint listing_promo_videos_status_check
  check (status in (
    'queued',
    'remotion_pending',
    'rendering',
    'social_drafted',
    'failed',
    'suppressed'
  ));

comment on column public.listing_promo_videos.status is
  'queued → remotion_pending (Wave 12 park) → rendering → social_drafted; failed/suppressed are terminal. Will return to a single queued→rendering flow once Remotion ships.';
