-- m222 — GEO auto-publish columns on ai_video_projects.
--
-- ai_video_projects is the CANONICAL reel record (carries video_url,
-- thumbnail_url=VideoCoverThumb OG image, compliance_status, approval_status,
-- status='completed' set by poll-did-videos / render-just-listed). Until now the
-- public /v/[slug] GEO page only served remotion_composition_renders rows, and
-- those carry NO compliance/approval data to gate a public broadcast page on.
--
-- These columns let a COMPLIANT + BROKER-APPROVED completed reel become a public,
-- AI-search-citable /v/[slug] page through the same publishVideoLanding helper the
-- Asset Manager publish_video_page action uses — idempotent per reel (public_slug
-- minted once, is_published flag flipped once). Mirrors the existing
-- remotion_composition_renders publish columns exactly so the page / llms.txt /
-- sitemap read both tables uniformly.

alter table public.ai_video_projects
  add column if not exists public_slug  text,
  add column if not exists is_published boolean not null default false,
  add column if not exists published_at timestamptz;

-- Slug is globally unique across published reels (the /v/[slug] resolver keys on it).
create unique index if not exists ai_video_projects_public_slug_key
  on public.ai_video_projects (public_slug)
  where public_slug is not null;

-- The auto-publish sweep scans for completed + compliance-passed + broker-approved
-- + not-yet-published reels; partial index keeps that scan cheap.
create index if not exists ai_video_projects_autopublish_idx
  on public.ai_video_projects (brokerage_id)
  where is_published = false
    and status = 'completed'
    and compliance_status = 'passed'
    and approval_status = 'approved';
