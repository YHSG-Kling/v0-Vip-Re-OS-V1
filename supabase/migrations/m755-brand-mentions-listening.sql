-- ── APPLIED LIVE 2026-10-08 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m755 — brand_mentions (wave 139H: BRAND24 CONCEPTS — social / brand listening on the
-- competitive-intel survivors). Writer + reader: lib/competitive-intel/brand-listening.ts
-- (runBrandListeningPass writes; loadBrandListeningReading reads for
-- app/dashboard/campaigns/competitive/page.tsx). TABLE_MANAGER campaign_orchestrator.
--
-- WHY A NEW TABLE (orphan doctrine §1.2 — audited against the live schema 2026-10-08, no
-- table named *mention* / *listen* / *sentiment* exists, and none of the near fits holds a mention):
--   · competitor_content — a RIVAL's own creative (competitor_id → competitor_profiles); our own
--     brand / agents / listings are not competitors, and its readers render every row as rival content.
--   · social_intelligence — LEAD-INTENT posts (ai_intent_score, urgency_level) read by the lead
--     intelligence rail; a brand mention there would surface as a buyer/seller lead.
--   · ai_search_citation_observations — one row per AI-answer per platform, FK'd to ai_video_projects.
-- subject_id is deliberately polymorphic (brokerages / agents / teams / listings id; NULL for a
-- competitor NAME from the watch list or a keyword), the same shape manager_signals.entity_id has.
--
-- Until applied: the cron's insert is refused and reported in the run's errors (never swallowed);
-- the Competitive Monitor card shows the refusal. After applying: regenerate schema-snapshot,
-- live-tables, the FK map AND scripts/check-vocabularies.ts (two new CHECKs below).
--
-- PART 1 — table (apply first).
CREATE TABLE IF NOT EXISTS public.brand_mentions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  subject_kind       text        NOT NULL
    CONSTRAINT brand_mentions_subject_kind_check
    CHECK (subject_kind IN ('brokerage', 'agent', 'team', 'listing', 'competitor', 'keyword')),
  subject_id         uuid        NULL,
  subject_label      text        NOT NULL,
  url                text        NOT NULL,
  -- scheme-less host + path with tracking params dropped — the dedup key.
  url_key            text        NOT NULL,
  source             text        NOT NULL,
  provider           text        NOT NULL,
  author             text        NULL,
  title              text        NULL,
  excerpt            text        NULL,
  published_at       timestamptz NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  -- RELATIVE reach index 0..100 from the search engine's own relevance score — never an audience size.
  reach_estimate     integer     NULL CHECK (reach_estimate IS NULL OR (reach_estimate BETWEEN 0 AND 100)),
  names_us           boolean     NOT NULL DEFAULT false,
  competitors_named  text[]      NULL,
  sentiment          text        NULL
    CONSTRAINT brand_mentions_sentiment_check
    CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative', 'mixed')),
  sentiment_score    numeric     NULL CHECK (sentiment_score IS NULL OR (sentiment_score BETWEEN -1 AND 1)),
  topics             text[]      NOT NULL DEFAULT '{}',
  compliance_flag    boolean     NOT NULL DEFAULT false,
  compliance_reason  text        NULL,
  -- NULL = not yet scored (the next pass retries); set when the sentiment call wrote the row.
  scored_at          timestamptz NULL
);

COMMENT ON TABLE public.brand_mentions IS
  'Wave 139H: public web/social mentions of a tenant''s brokerage, agents, teams, listings, watched competitors and keywords (brand listening, platform-covered). Writer/reader: lib/competitive-intel/brand-listening.ts.';

-- PART 2 — indexes + RLS (apply after part 1).
CREATE UNIQUE INDEX IF NOT EXISTS brand_mentions_tenant_url_key_uidx
  ON public.brand_mentions (brokerage_id, url_key);
CREATE INDEX IF NOT EXISTS brand_mentions_tenant_captured_idx
  ON public.brand_mentions (brokerage_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS brand_mentions_tenant_unscored_idx
  ON public.brand_mentions (brokerage_id, captured_at DESC) WHERE scored_at IS NULL;

ALTER TABLE public.brand_mentions ENABLE ROW LEVEL SECURITY;

-- Tenant members read their own brokerage's mentions; writes come only through the service role
-- (the cron) — no INSERT/UPDATE/DELETE policy for authenticated.
CREATE POLICY brand_mentions_tenant_read ON public.brand_mentions
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.brand_mentions FROM authenticated, anon;
GRANT SELECT ON public.brand_mentions TO authenticated;
