-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145Z ──
--
-- m872 — A CONTENT-STUDIO IDEA NAMES THE TOPIC IT CAME FROM (owner ruling 22; lane 145I open loop "content_ideas has no topic link")
--
-- Ruling 22: the topic bank (content_topic_bank) feeds EVERY content surface. The content studio's idea board
-- (app/actions/content-studio.ts generateContentIdeas → content_ideas) wrote title / description / content_type and no topic
-- reference, so topic → idea → creative attribution could not join through the studio board (scripts/parent-child-graph-guard.ts
-- arrow content.topic>studio_idea, ABSENT; 125 live rows on 2026-10-27, 0 topic-bank rows).
--
--   · content_ideas.topic_id — the topic-bank row the idea was drawn from. NULL = an idea with no topic behind it (every row
--     written before this, and an idea the model drew from the persona alone). ON DELETE SET NULL: an idea outlives an expired
--     or purged topic; it just stops naming it.
--   · content_ideas_topic_id_idx — the FK's referencing-side index (ON DELETE SET NULL scans it).
--
-- MEASURED BEFORE WRITING (scripts/schema-snapshot.ts, scripts/schema-fk-map.ts, 2026-10-27): content_ideas = brokerage_id,
-- content_type, created_at, created_by, description, id, status, title; no FK onto content_topic_bank. No CHECK is added.
-- RLS is unchanged (content_ideas is tenant-scoped by brokerage_id; the topic it names is the tenant's own or a platform row).
--
-- SAFE IN EITHER ORDER: the studio writer stamps topic_id in its OWN tenant-pinned UPDATE after the insert and treats
-- 42703 / PGRST204 as "m872 not applied" (the idea is kept either way, without its lineage — said in the log).
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (content_ideas +1) and scripts/schema-fk-map.ts
-- (content_ideas.topic_id → content_topic_bank); then re-declare scripts/parent-child-graph-guard.ts arrow content.topic>studio_idea
-- as { kind: "fk", column: "topic_id" } and burn its KNOWN_FINDINGS key.

ALTER TABLE public.content_ideas
  ADD COLUMN IF NOT EXISTS topic_id uuid NULL REFERENCES public.content_topic_bank(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS content_ideas_topic_id_idx ON public.content_ideas (topic_id) WHERE topic_id IS NOT NULL;

COMMENT ON COLUMN public.content_ideas.topic_id IS
  'The topic-bank row this studio idea was drawn from (owner ruling 22 — the topic bank feeds every content surface). Written by app/actions/content-studio.ts generateContentIdeas (wave 145, m872). NULL = no topic behind it.';

-- VERIFY (read back):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'content_ideas' AND column_name = 'topic_id';
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.content_ideas'::regclass AND contype = 'f';
