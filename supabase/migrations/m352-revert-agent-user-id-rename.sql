-- m352 — REVERT m350. The rename was the wrong fix.
--
-- m350 renamed eight users-class `agent_id` columns to `agent_user_id` on the
-- theory that the NAME was the bug. The owner corrected it: this codebase has
-- always had a three-word vocabulary — user_id, agent_id, contact_id — so
-- `agent_user_id` was a THIRD name for a concept that already had one. It added
-- drift while claiming to remove it.
--
-- The audit that should have come first: NONE of the 20 tables has a `user_id`
-- column, and every one of them is an AGENT-scoped business object. Three prove
-- it outright:
--   · property_preferences has (contact_id, agent_id) — the buyer and the agent.
--   · closing_disclosure_agreement has agent_id alongside broker_id,
--     agent_submitted_by and compliance_approved_by: the `_by` columns are the
--     acting users, agent_id is whose CDA it is.
--   · pattern_adoptions has agent_id AND adopted_by — the vocabulary already
--     distinguishes the agent from the admin who pushed the playbook.
--
-- So the vocabulary was never broken. 20 of 195 FOREIGN KEYS point at the wrong
-- table. Re-pointing them to agents(id) makes agent_id mean exactly one thing
-- everywhere; renaming only relabelled the inconsistency and left two meanings.
--
-- This restores the names. The FK re-point follows as its own pass, table by
-- table with its callers, so that step is never half-done.
ALTER TABLE public.pattern_adoptions            RENAME COLUMN agent_user_id TO agent_id;
ALTER TABLE public.podcast_auto_runs            RENAME COLUMN agent_user_id TO agent_id;
ALTER TABLE public.studio_sessions              RENAME COLUMN agent_user_id TO agent_id;
ALTER TABLE public.conversation_logs            RENAME COLUMN agent_user_id TO agent_id;
ALTER TABLE public.podcast_templates            RENAME COLUMN agent_user_id TO agent_id;
ALTER TABLE public.revenue_protection_snapshots RENAME COLUMN agent_user_id TO agent_id;
ALTER TABLE public.newsletter_video_renders     RENAME COLUMN agent_user_id TO agent_id;
ALTER TABLE public.income_forecast_snapshots    RENAME COLUMN agent_user_id TO agent_id;

ALTER TABLE public.pattern_adoptions            RENAME CONSTRAINT pattern_adoptions_agent_user_id_fkey            TO pattern_adoptions_agent_id_fkey;
ALTER TABLE public.podcast_auto_runs            RENAME CONSTRAINT podcast_auto_runs_agent_user_id_fkey            TO podcast_auto_runs_agent_id_fkey;
ALTER TABLE public.studio_sessions              RENAME CONSTRAINT studio_sessions_agent_user_id_fkey              TO studio_sessions_agent_id_fkey;
ALTER TABLE public.conversation_logs            RENAME CONSTRAINT conversation_logs_agent_user_id_fkey            TO conversation_logs_agent_id_fkey;
ALTER TABLE public.podcast_templates            RENAME CONSTRAINT podcast_templates_agent_user_id_fkey            TO podcast_templates_agent_id_fkey;
ALTER TABLE public.revenue_protection_snapshots RENAME CONSTRAINT revenue_protection_snapshots_agent_user_id_fkey TO revenue_protection_snapshots_agent_id_fkey;
ALTER TABLE public.newsletter_video_renders     RENAME CONSTRAINT newsletter_video_renders_agent_user_id_fkey     TO newsletter_video_renders_agent_id_fkey;
ALTER TABLE public.income_forecast_snapshots    RENAME CONSTRAINT income_forecast_snapshots_agent_user_id_fkey    TO income_forecast_snapshots_agent_id_fkey;

COMMENT ON COLUMN public.pattern_adoptions.agent_id            IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
COMMENT ON COLUMN public.podcast_auto_runs.agent_id            IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
COMMENT ON COLUMN public.studio_sessions.agent_id              IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
COMMENT ON COLUMN public.conversation_logs.agent_id            IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
COMMENT ON COLUMN public.podcast_templates.agent_id            IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
COMMENT ON COLUMN public.revenue_protection_snapshots.agent_id IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
COMMENT ON COLUMN public.newsletter_video_renders.agent_id     IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
COMMENT ON COLUMN public.income_forecast_snapshots.agent_id    IS 'Currently FKs users(id) — a known defect. agent_id must mean agents(id); FK re-point pending.';
