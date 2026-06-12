-- m223 — AI-SEARCH CITATION MONITOR observations table.
--
-- The natural pair to the m222 GEO auto-publish reel pages: m222 makes every
-- broker-approved reel a public /v/[slug] page so AI search engines CAN cite it.
-- This table records whether they ACTUALLY DO — one row per
-- (published reel page, AI-search platform, observation day): did the AI/search
-- answer for the agent's brand+listing query reference OUR /v/[slug] URL or brand?
--
-- No existing table fits: geo has only the m222 publish columns on
-- ai_video_projects (no visibility/scan/audit table anywhere in the schema —
-- grep for geo_audit/brand_mention/ai_visibility/citation finds none). A reel's
-- publish columns describe the EGRESS (we put it on the web); this describes the
-- INGRESS observation (an AI engine cited it back) — a distinct, time-series fact
-- that must not overwrite the reel row. So a dedicated observations table, mirroring
-- m222 style (tenant-scoped, partial/unique indexes, honest defaults).
--
-- HONESTY is first-class: `outcome` is a CHECK-constrained vocabulary
--   'cited'       — the AI/search answer referenced our /v/[slug] URL or brand
--   'not_cited'   — the search ran but did NOT reference us
--   'not_checked' — the external search rail was unavailable (no creds / no provider);
--                   we record the HONEST gap rather than fabricate a citation or a miss.
-- The score never invents a hit: a 'not_checked' row contributes nothing to the
-- numerator AND nothing to the checked denominator.

create table if not exists public.ai_search_citation_observations (
  id              uuid primary key default gen_random_uuid(),
  brokerage_id    uuid not null references public.brokerages(id) on delete cascade,
  -- The published reel this observation is about. ai_video_projects is the
  -- canonical reel record carrying public_slug (m222). Cascade so deleting a reel
  -- clears its observations (the simulator's reverse-delete relies on this).
  project_id      uuid not null references public.ai_video_projects(id) on delete cascade,
  -- Denormalized slug at observation time — the /v/[slug] page the query targeted.
  public_slug     text not null,
  -- AI-search platform observed (the geo-platform-optimizer vocabulary):
  --   'google_ai_overviews' | 'chatgpt' | 'perplexity' | 'gemini' | 'bing_copilot'
  platform        text not null,
  -- The exact brand+listing query issued to the external rail (audit / reproducibility).
  query           text not null,
  -- 'cited' | 'not_cited' | 'not_checked' (see header).
  outcome         text not null,
  -- When outcome='cited': which of OUR urls the answer referenced (the matched /v/[slug] or brand url).
  cited_url       text,
  -- The web-search provider that actually answered ('tavily' | 'exa' | 'none'); 'none' ⇒ not_checked.
  provider        text,
  -- The observation DAY (UTC date) — idempotency key component (one row per page×platform×day).
  observed_on     date not null default (now() at time zone 'utc')::date,
  observed_at     timestamptz not null default now(),

  constraint ai_search_citation_outcome_chk
    check (outcome in ('cited', 'not_cited', 'not_checked')),
  constraint ai_search_citation_platform_chk
    check (platform in ('google_ai_overviews', 'chatgpt', 'perplexity', 'gemini', 'bing_copilot'))
);

-- Idempotency fence: at most ONE observation per (project, platform, day). A
-- rerun of the monitor on the same day UPSERTs this row rather than appending —
-- the score reflects the LATEST observation for the day, never inflated by reruns.
create unique index if not exists ai_search_citation_obs_daily_key
  on public.ai_search_citation_observations (project_id, platform, observed_on);

-- The score/read path scans a brokerage's recent observations cheaply.
create index if not exists ai_search_citation_obs_brokerage_idx
  on public.ai_search_citation_observations (brokerage_id, observed_on desc);

-- Tenant-isolation. Service-role (the monitor runner + cron) bypasses RLS; this
-- denies direct anon/authed cross-tenant reads, matching the app's posture.
alter table public.ai_search_citation_observations enable row level security;
