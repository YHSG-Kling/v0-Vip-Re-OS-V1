-- m116 — widen deconflict_suppression_log.channel for broadcast lanes.
-- The De-Conflict Engine now serves two lanes (1:1 + 1:many); the broadcast
-- frequency cap lives on the same audit table but adds channel values for
-- newsletter / social_post / blog / ad sends.

alter table public.deconflict_suppression_log
  drop constraint if exists deconflict_suppression_log_channel_check;

alter table public.deconflict_suppression_log
  add constraint deconflict_suppression_log_channel_check
  check (channel in (
    'email','sms','phone','mail','video',
    'newsletter','social_post','blog','ad'
  ));

comment on column public.deconflict_suppression_log.channel is
  '5 1:1 lanes (email/sms/phone/mail/video) + 4 1:many broadcast lanes (newsletter/social_post/blog/ad).';
