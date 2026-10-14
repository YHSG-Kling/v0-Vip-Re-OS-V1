-- m351 — batch 2 of 5. See m350 for why the name was the bug.
-- Applied live and verified before commit. All four tables empty (pre-rollout).
ALTER TABLE public.podcast_templates            RENAME COLUMN agent_id TO agent_user_id;
ALTER TABLE public.revenue_protection_snapshots RENAME COLUMN agent_id TO agent_user_id;
ALTER TABLE public.newsletter_video_renders     RENAME COLUMN agent_id TO agent_user_id;
ALTER TABLE public.income_forecast_snapshots    RENAME COLUMN agent_id TO agent_user_id;

ALTER TABLE public.podcast_templates            RENAME CONSTRAINT podcast_templates_agent_id_fkey            TO podcast_templates_agent_user_id_fkey;
ALTER TABLE public.revenue_protection_snapshots RENAME CONSTRAINT revenue_protection_snapshots_agent_id_fkey TO revenue_protection_snapshots_agent_user_id_fkey;
ALTER TABLE public.newsletter_video_renders     RENAME CONSTRAINT newsletter_video_renders_agent_id_fkey     TO newsletter_video_renders_agent_user_id_fkey;
ALTER TABLE public.income_forecast_snapshots    RENAME CONSTRAINT income_forecast_snapshots_agent_id_fkey    TO income_forecast_snapshots_agent_user_id_fkey;

COMMENT ON COLUMN public.podcast_templates.agent_user_id            IS 'FKs users(id) — the auth user, NOT agents(id). Renamed from agent_id in m351.';
COMMENT ON COLUMN public.revenue_protection_snapshots.agent_user_id IS 'FKs users(id) — NULL means the brokerage-wide snapshot. Renamed from agent_id in m351.';
COMMENT ON COLUMN public.newsletter_video_renders.agent_user_id     IS 'FKs users(id) — the auth user, NOT agents(id). Renamed from agent_id in m351.';
COMMENT ON COLUMN public.income_forecast_snapshots.agent_user_id    IS 'FKs users(id) — the auth user, NOT agents(id). Renamed from agent_id in m351.';
