-- l42-s01-avatar-rehosted-url.sql   (applied live via apply_migration)
-- ─────────────────────────────────────────────────────────────────────────────
-- Self-hosted avatar image URL. Owner contract: once D-ID finishes an avatar,
-- the poll cron (app/api/cron/poll-did-avatars) downloads the finished preview
-- and re-hosts it in the twin-avatars Supabase bucket; the bucket URL (NOT the
-- D-ID id) is what the profile displays, so the avatar survives D-ID CDN expiry.
-- did_avatar_id is kept only because clip generation still references the id.
alter table public.agent_avatar_assets  add column if not exists avatar_url text;
alter table public.agent_voice_profiles add column if not exists avatar_url text;
