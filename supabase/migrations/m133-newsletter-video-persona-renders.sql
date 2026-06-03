-- m133 — per-persona newsletter video thumbnail + intro-overlay renders.
--
-- Wave 22 (a + b). The weekly newsletter video is ONE Remotion render per
-- campaign embedded in every recipient's email (cost-bounded: $0.30 ÷ N,
-- locked in by Wave 15). What changes now: each recipient sees a
-- PERSONA-THEMED THUMBNAIL in the inbox preview + a PERSONA-SPECIFIC TEXT
-- OVERLAY on the first 3 seconds of the video. The main render — agent's
-- ElevenLabs voice + Remotion market-beat composition — stays universal.
--
-- The persona renders are produced as a post-pass on the existing render
-- endpoint after the main MP4 is in storage. Each persona gets:
--   · a still PNG thumbnail (Remotion renderStill on the new
--     NewsletterDigestThumb composition), 1200×630 Open-Graph card ratio
--     for inbox preview compatibility, persona hook text + agent photo
--   · a composite MP4 (ffmpeg drawtext overlay on the first 3s of the
--     main render), persona-specific opening line burned over the video
--
-- publish-newsletters reads the (campaign, recipient_persona) row at send
-- time and embeds the recipient-matching composite + thumbnail. Recipients
-- whose persona has no completed row fall back to the universal main
-- render + a brand-default thumbnail.
--
-- The ledger is sibling to newsletter_video_renders (not a column on it)
-- because (campaign × persona) is 1-to-many — five distinct personas in
-- one brokerage's audience = five rows for one campaign — and a sibling
-- table keeps the deferral semantics clean (Wave 21 composition gate sees
-- per-persona status, not a json blob to parse).

create table if not exists public.newsletter_video_persona_renders (
  id                          uuid primary key default gen_random_uuid(),
  newsletter_video_render_id  uuid not null references public.newsletter_video_renders(id) on delete cascade,
  newsletter_campaign_id      uuid not null references public.newsletter_campaigns(id) on delete cascade,
  brokerage_id                uuid not null references public.brokerages(id) on delete cascade,
  persona                     text not null,
  composite_video_url         text,
  thumbnail_url               text,
  status                      text not null default 'queued'
                              check (status in ('queued','rendering','completed','failed','skipped')),
  failure_reason              text,
  created_at                  timestamptz not null default now(),
  completed_at                timestamptz,
  unique (newsletter_campaign_id, persona)
);

create index if not exists idx_newsletter_video_persona_renders_campaign
  on public.newsletter_video_persona_renders (newsletter_campaign_id);

create index if not exists idx_newsletter_video_persona_renders_brokerage_recent
  on public.newsletter_video_persona_renders (brokerage_id, created_at desc);

alter table public.newsletter_video_persona_renders enable row level security;

-- Service role only — populated by the render endpoint, read by publish-
-- newsletters at send time. No user-facing surface reads this table directly;
-- the per-recipient lookup happens server-side in the cron.
create policy "service_role_full" on public.newsletter_video_persona_renders
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
