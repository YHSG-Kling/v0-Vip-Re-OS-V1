-- m264 — Brokerage revenue-share opt-in setting.
--
-- Not every brokerage offers agent-to-agent (downline) revenue share — it's a broker choice. This adds
-- the explicit setting so the commission waterfall's revenue-share step (09-revenue-share) and the
-- command-center revenue-share board only run when the brokerage offers it. Backfilled true for any
-- brokerage that ALREADY has active revenue-share relationships, so existing payouts don't regress.

alter table public.brokerages
  add column if not exists revenue_share_enabled boolean not null default false;

update public.brokerages b
set revenue_share_enabled = true
where exists (
  select 1 from public.agent_relationships r
  where r.brokerage_id = b.id and r.is_active = true and coalesce(r.revenue_share_percent, 0) > 0
);
