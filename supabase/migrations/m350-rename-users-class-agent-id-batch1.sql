-- m350 — THE NAME WAS THE BUG (batch 1 of 5).
--
-- 195 columns in this schema are called agent_id. 175 FK agents(id); 20 FK
-- users(id). Same name, two incompatible meanings, and the classes never
-- overlap, so reading one as the other never degrades — it silently matches
-- nothing, or the foreign key rejects the write and a discarded error reports
-- success. Four passes of guards fixed twenty-odd instances without ending the
-- class, because the mistake is reasonable: the column is called agent_id.
--
-- Every table here is empty (pre-rollout), so there is no data risk. The risk
-- is entirely in the code, which is why the batches are small enough that each
-- rename lands in one commit with every caller it has.
--
-- RLS policies and FK constraints follow the rename automatically — Postgres
-- stores them as parsed trees, not text. conversation_logs' two policies read
-- `agent_id = auth.uid()`, which is itself independent proof of the class.
-- Applied live and verified before commit.

ALTER TABLE public.pattern_adoptions RENAME COLUMN agent_id TO agent_user_id;
ALTER TABLE public.podcast_auto_runs RENAME COLUMN agent_id TO agent_user_id;
ALTER TABLE public.studio_sessions   RENAME COLUMN agent_id TO agent_user_id;
ALTER TABLE public.conversation_logs RENAME COLUMN agent_id TO agent_user_id;

-- Constraint names too, so the next reader is not told "agent_id" by a name the
-- column no longer has. PostgREST embed hints reference these by name; the one
-- affected hint is updated in the same commit.
ALTER TABLE public.pattern_adoptions RENAME CONSTRAINT pattern_adoptions_agent_id_fkey TO pattern_adoptions_agent_user_id_fkey;
ALTER TABLE public.podcast_auto_runs RENAME CONSTRAINT podcast_auto_runs_agent_id_fkey TO podcast_auto_runs_agent_user_id_fkey;
ALTER TABLE public.studio_sessions   RENAME CONSTRAINT studio_sessions_agent_id_fkey   TO studio_sessions_agent_user_id_fkey;
ALTER TABLE public.conversation_logs RENAME CONSTRAINT conversation_logs_agent_id_fkey TO conversation_logs_agent_user_id_fkey;

COMMENT ON COLUMN public.pattern_adoptions.agent_user_id IS 'FKs users(id) — the auth user, NOT agents(id). Renamed from agent_id in m350.';
COMMENT ON COLUMN public.podcast_auto_runs.agent_user_id IS 'FKs users(id) — the auth user, NOT agents(id). Renamed from agent_id in m350.';
COMMENT ON COLUMN public.studio_sessions.agent_user_id   IS 'FKs users(id) — the auth user, NOT agents(id). Renamed from agent_id in m350.';
COMMENT ON COLUMN public.conversation_logs.agent_user_id IS 'FKs users(id) — the auth user, NOT agents(id). Renamed from agent_id in m350.';
