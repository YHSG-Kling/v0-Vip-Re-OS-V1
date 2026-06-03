-- m132 — newsletter composition completion gate.
--
-- Wave 21. The publish-newsletters cron previously sent on the contract
--   approval_status='approved' AND status='scheduled' AND send_date <= now()
-- and treated the video render + section decomposition as "best effort." If
-- the Remotion render didn't finish before send_date the campaign went out
-- flat with no video, and if section decomposition failed silently every
-- recipient got the same un-segmented body — the marketing agent had zero
-- signal that the campaign degraded.
--
-- Wave 21 introduces a pre-publish COMPOSITION GATE that defers any
-- campaign whose final assembled form isn't ready, and records WHY in a
-- single textual column the agent's observability surfaces can read.
-- The gate runs after the broadcast-cap check and before the claim step,
-- so a deferred campaign stays eligible for the next hourly tick (or for
-- the agent to inspect, re-queue, or override).
--
-- The column is plain TEXT — short structured strings the gate writes
-- (e.g. "video_render:failed", "video_render:pending_past_send_date",
-- "sections_missing", "final_compliance:fair_housing"). Querying for
-- 'recently deferred' campaigns becomes a single WHERE clause for the
-- agent's marketing snapshot and for the admin observability page.

alter table public.newsletter_campaigns
  add column if not exists defer_reason text;

create index if not exists idx_newsletter_campaigns_deferred_recent
  on public.newsletter_campaigns (brokerage_id, send_date desc)
  where status = 'deferred';
