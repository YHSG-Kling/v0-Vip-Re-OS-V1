-- l41-s01-contact-memory-vector-recall.sql
-- CONTACT MEMORY — per-entity vector recall corpus (contact/transaction/listing).
-- This table + the contact_memory_recall RPC existed in the LIVE database but were
-- never captured in a repo migration (code-only). This reconciles that drift so
-- the infra is reproducible on a fresh DB. Idempotent + additive; matches the
-- live definitions exactly (verified against the live schema). The embeddings are
-- produced by the ONE canonical embedder (openai/text-embedding-3-small, 1536d,
-- via the Vercel AI Gateway) — the same pipeline the knowledge base uses.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.contact_memory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid NOT NULL,
  entity_type   text NOT NULL CHECK (entity_type = ANY (ARRAY['contact','transaction','listing'])),
  entity_id     uuid NOT NULL,
  memory_kind   text NOT NULL CHECK (memory_kind = ANY (ARRAY[
                  'transparency_update','portal_message','agent_note','showing_feedback',
                  'persona_signal','preference','bba_event','agent_message'])),
  content       text NOT NULL,
  embedding     extensions.vector(1536),
  source_table  text,
  source_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

-- Entity-scoped lookup (the recall RPC restricts the IVFFlat probe to this subset).
CREATE INDEX IF NOT EXISTS idx_contact_memory_entity
  ON public.contact_memory USING btree (brokerage_id, entity_type, entity_id)
  WHERE (archived_at IS NULL);

-- Cosine-distance ANN index for vector recall.
CREATE INDEX IF NOT EXISTS idx_contact_memory_embedding
  ON public.contact_memory USING ivfflat (embedding extensions.vector_cosine_ops) WITH (lists = '100');

ALTER TABLE public.contact_memory ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_memory' AND policyname = 'contact_memory_brokerage_read') THEN
    CREATE POLICY contact_memory_brokerage_read ON public.contact_memory
      FOR SELECT USING (brokerage_id = current_user_brokerage_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_memory' AND policyname = 'contact_memory_platform_admin') THEN
    CREATE POLICY contact_memory_platform_admin ON public.contact_memory
      FOR ALL USING (is_platform_admin());
  END IF;
END $$;

-- Entity-scoped vector recall. Brokerage + entity filter is NON-NEGOTIABLE — never
-- search across brokerages. similarity = 1 - cosine_distance.
CREATE OR REPLACE FUNCTION public.contact_memory_recall(
  p_brokerage_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_query_embedding extensions.vector,
  p_k integer,
  p_memory_kinds text[]
)
RETURNS TABLE(id uuid, memory_kind text, content text, created_at timestamptz, similarity double precision, metadata jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT
    m.id,
    m.memory_kind,
    m.content,
    m.created_at,
    1 - (m.embedding OPERATOR(extensions.<=>) p_query_embedding) AS similarity,
    m.metadata
  FROM public.contact_memory m
  WHERE m.brokerage_id = p_brokerage_id
    AND m.entity_type  = p_entity_type
    AND m.entity_id    = p_entity_id
    AND m.archived_at IS NULL
    AND m.embedding IS NOT NULL
    AND (p_memory_kinds IS NULL OR m.memory_kind = ANY(p_memory_kinds))
  ORDER BY m.embedding OPERATOR(extensions.<=>) p_query_embedding
  LIMIT GREATEST(1, LEAST(20, p_k));
$function$;
