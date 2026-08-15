-- =====================================================
-- MIGRATION 059: prospects + prospect_context +
--                generated_content + tool_usage_sessions +
--                required_disclosures
-- =====================================================
-- Five more missing tables verified from real caller shapes:
--   • app/api/prospects/route.ts            (prospects)
--   • app/api/prospects/[id]/context/...    (prospect_context)
--   • app/api/generate/{text,social,
--     newsletter,email}/route.ts            (generated_content)
--   • app/actions/calculators.ts            (tool_usage_sessions)
--   • lib/seed-compliance-rules.ts          (required_disclosures)
--
-- Tenancy note: the prospects API routes are auth-gated but NOT yet
-- brokerage-filtered. brokerage_id is added as NULLABLE so we don't
-- break the existing routes; the routes' missing brokerage filter is
-- a follow-up code fix tracked separately. RLS still enforces
-- per-brokerage isolation when brokerage_id is set.
-- =====================================================

-- ─── prospects ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prospects (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id      UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  source        TEXT,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prospects_brokerage ON public.prospects (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prospects_email ON public.prospects (email) WHERE email IS NOT NULL;
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
CREATE POLICY prospects_select ON public.prospects FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY prospects_insert ON public.prospects FOR INSERT WITH CHECK (TRUE);
CREATE POLICY prospects_update ON public.prospects FOR UPDATE USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY prospects_delete ON public.prospects FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── prospect_context ────────────────────────────────────────────────────────
-- UPSERT keyed by prospect_id — one context row per prospect.
CREATE TABLE IF NOT EXISTS public.prospect_context (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id   UUID        NOT NULL UNIQUE REFERENCES public.prospects(id) ON DELETE CASCADE,
  emotion       TEXT,
  situation     TEXT,
  pain_point    TEXT,
  timeline      TEXT,
  life_context  TEXT,
  what_helps    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.prospect_context ENABLE ROW LEVEL SECURITY;
CREATE POLICY prospect_context_select ON public.prospect_context FOR SELECT USING (
  public.is_platform_admin()
  OR EXISTS (SELECT 1 FROM public.prospects p WHERE p.id = prospect_context.prospect_id
             AND (p.brokerage_id IS NULL OR public.has_brokerage_access(p.brokerage_id)))
);
CREATE POLICY prospect_context_insert ON public.prospect_context FOR INSERT WITH CHECK (TRUE);
CREATE POLICY prospect_context_update ON public.prospect_context FOR UPDATE USING (
  public.is_platform_admin()
  OR EXISTS (SELECT 1 FROM public.prospects p WHERE p.id = prospect_context.prospect_id
             AND (p.brokerage_id IS NULL OR public.has_brokerage_access(p.brokerage_id)))
) WITH CHECK (TRUE);
CREATE POLICY prospect_context_delete ON public.prospect_context FOR DELETE USING (public.is_platform_admin());

-- ─── generated_content ───────────────────────────────────────────────────────
-- AI-generated content cache (text / email / newsletter / social).
-- Distinct from content_templates (re-usable templates) and from
-- ai_generated_content (which already exists for a different feature).
CREATE TABLE IF NOT EXISTS public.generated_content (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id          UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  prospect_id       UUID        REFERENCES public.prospects(id) ON DELETE SET NULL,
  contact_id        UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  content_type      TEXT        NOT NULL,
  content           TEXT,
  quality_score     NUMERIC(5,4),
  them_percentage   NUMERIC(5,2),
  agent_percentage  NUMERIC(5,2),
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generated_content_prospect ON public.generated_content (prospect_id, created_at DESC) WHERE prospect_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_content_brokerage ON public.generated_content (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_content_type ON public.generated_content (content_type);

CREATE OR REPLACE FUNCTION public.generated_content_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.prospect_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.prospects WHERE id = NEW.prospect_id;
    ELSIF NEW.contact_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    ELSIF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS generated_content_set_brokerage_trg ON public.generated_content;
CREATE TRIGGER generated_content_set_brokerage_trg BEFORE INSERT ON public.generated_content
  FOR EACH ROW EXECUTE FUNCTION public.generated_content_set_brokerage();

ALTER TABLE public.generated_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY generated_content_select ON public.generated_content FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY generated_content_insert ON public.generated_content FOR INSERT WITH CHECK (TRUE);
CREATE POLICY generated_content_update ON public.generated_content FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY generated_content_delete ON public.generated_content FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── tool_usage_sessions ─────────────────────────────────────────────────────
-- Anonymous (visitor_id-keyed) usage telemetry for public-facing
-- calculator/widget tools. No agent_id or brokerage_id by design.
CREATE TABLE IF NOT EXISTS public.tool_usage_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name           TEXT        NOT NULL,
  visitor_id          TEXT,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE SET NULL,
  session_data_json   JSONB,
  time_spent_seconds  INTEGER     NOT NULL DEFAULT 0,
  timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_usage_sessions_tool ON public.tool_usage_sessions (tool_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tool_usage_sessions_visitor ON public.tool_usage_sessions (visitor_id) WHERE visitor_id IS NOT NULL;

ALTER TABLE public.tool_usage_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_usage_sessions_select ON public.tool_usage_sessions FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY tool_usage_sessions_insert ON public.tool_usage_sessions FOR INSERT WITH CHECK (TRUE);
CREATE POLICY tool_usage_sessions_update ON public.tool_usage_sessions FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY tool_usage_sessions_delete ON public.tool_usage_sessions FOR DELETE USING (public.is_platform_admin());

-- ─── required_disclosures ────────────────────────────────────────────────────
-- Platform-wide compliance catalog. UNIQUE on disclosure_type (the
-- upsert key used by seed-compliance-rules.ts).
CREATE TABLE IF NOT EXISTS public.required_disclosures (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_type          TEXT        NOT NULL UNIQUE,
  disclosure_text          TEXT        NOT NULL,
  required_for_channels    TEXT[]      NOT NULL DEFAULT '{}',
  required_for_states      TEXT[],
  placement_requirement    TEXT,
  is_active                BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_required_disclosures_active ON public.required_disclosures (is_active) WHERE is_active = TRUE;

ALTER TABLE public.required_disclosures ENABLE ROW LEVEL SECURITY;
CREATE POLICY required_disclosures_select ON public.required_disclosures FOR SELECT USING (TRUE);
CREATE POLICY required_disclosures_insert ON public.required_disclosures FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY required_disclosures_update ON public.required_disclosures FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY required_disclosures_delete ON public.required_disclosures FOR DELETE USING (public.is_platform_admin());
