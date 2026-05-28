-- =====================================================
-- MIGRATION 053: contact_notes + photo_enhancement_jobs +
--                photo_ordering_rules + ai_usage_log
-- =====================================================
-- Four smaller missing tables that each back a discrete feature.
--   • contact_notes ← app/actions/crm.ts:173 (timeline read)
--   • photo_enhancement_jobs ← app/actions/photo-management.ts:104
--   • photo_ordering_rules ← app/actions/photo-management.ts:410
--   • ai_usage_log ← app/actions/ai-listing-intake.ts:144 (per-event;
--     monthly rollup ai_usage_monthly is separate downstream)
-- =====================================================

-- ─── contact_notes ───────────────────────────────────────────────────────────
-- Free-text notes attached to a contact. Author can be the agent OR
-- (later) a contact-portal user, so author is the auth.uid().
CREATE TABLE IF NOT EXISTS public.contact_notes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  author_user_id  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  body            TEXT        NOT NULL,
  is_private      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact_created
  ON public.contact_notes (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_notes_brokerage
  ON public.contact_notes (brokerage_id) WHERE brokerage_id IS NOT NULL;

-- Auto-denormalize brokerage_id from contact on insert
CREATE OR REPLACE FUNCTION public.contact_notes_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contact_notes_set_brokerage_trg ON public.contact_notes;
CREATE TRIGGER contact_notes_set_brokerage_trg BEFORE INSERT ON public.contact_notes
  FOR EACH ROW EXECUTE FUNCTION public.contact_notes_set_brokerage();

ALTER TABLE public.contact_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_notes_select ON public.contact_notes FOR SELECT
  USING (
    public.is_platform_admin()
    OR public.has_brokerage_access(brokerage_id)
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_notes.contact_id AND c.contact_user_id = auth.uid()
        AND NOT contact_notes.is_private
    )
  );
CREATE POLICY contact_notes_insert ON public.contact_notes FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (
      brokerage_id IS NULL OR brokerage_id = public.current_user_brokerage_id()
    )
  );
CREATE POLICY contact_notes_update ON public.contact_notes FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (author_user_id = auth.uid())
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (author_user_id = auth.uid())
    OR (public.is_brokerage_admin() AND brokerage_id = public.current_user_brokerage_id())
  );
CREATE POLICY contact_notes_delete ON public.contact_notes FOR DELETE
  USING (
    public.is_platform_admin()
    OR (author_user_id = auth.uid())
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  );

-- ─── photo_enhancement_jobs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.photo_enhancement_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id          UUID        NOT NULL REFERENCES public.listing_photos(id) ON DELETE CASCADE,
  agent_id          UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  brokerage_id      UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  original_url      TEXT,
  enhanced_url      TEXT,
  enhancement_type  TEXT,
  status            TEXT        NOT NULL DEFAULT 'processing',
  error_message     TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT photo_enhancement_jobs_status_check CHECK (status IN (
    'queued','processing','completed','failed','cancelled'
  ))
);
CREATE INDEX IF NOT EXISTS idx_photo_enhancement_jobs_photo ON public.photo_enhancement_jobs (photo_id);
CREATE INDEX IF NOT EXISTS idx_photo_enhancement_jobs_agent ON public.photo_enhancement_jobs (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_photo_enhancement_jobs_status ON public.photo_enhancement_jobs (status) WHERE status IN ('queued','processing');

ALTER TABLE public.photo_enhancement_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY photo_enhancement_jobs_select ON public.photo_enhancement_jobs FOR SELECT
  USING (
    public.is_platform_admin()
    OR (brokerage_id IS NULL)
    OR public.has_brokerage_access(brokerage_id)
    OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())
  );
CREATE POLICY photo_enhancement_jobs_insert ON public.photo_enhancement_jobs FOR INSERT
  WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role() OR public.is_agent_role());
CREATE POLICY photo_enhancement_jobs_update ON public.photo_enhancement_jobs FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())
    OR (public.is_lead_visible_role() AND (brokerage_id IS NULL OR public.has_brokerage_access(brokerage_id)))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())
    OR public.is_lead_visible_role()
  );
CREATE POLICY photo_enhancement_jobs_delete ON public.photo_enhancement_jobs FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── photo_ordering_rules ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.photo_ordering_rules (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                 UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id             UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  rule_name                TEXT        NOT NULL,
  room_sequence            TEXT[]      NOT NULL DEFAULT '{}',
  prioritize_high_quality  BOOLEAN     NOT NULL DEFAULT TRUE,
  is_active                BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_photo_ordering_rules_agent ON public.photo_ordering_rules (agent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_photo_ordering_rules_active
  ON public.photo_ordering_rules (agent_id) WHERE is_active = TRUE;

-- Auto-denormalize brokerage_id from agent
CREATE OR REPLACE FUNCTION public.photo_ordering_rules_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS photo_ordering_rules_set_brokerage_trg ON public.photo_ordering_rules;
CREATE TRIGGER photo_ordering_rules_set_brokerage_trg BEFORE INSERT ON public.photo_ordering_rules
  FOR EACH ROW EXECUTE FUNCTION public.photo_ordering_rules_set_brokerage();

ALTER TABLE public.photo_ordering_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY photo_ordering_rules_select ON public.photo_ordering_rules FOR SELECT
  USING (
    public.is_platform_admin()
    OR public.has_brokerage_access(brokerage_id)
    OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())
  );
CREATE POLICY photo_ordering_rules_insert ON public.photo_ordering_rules FOR INSERT
  WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_lead_visible_role());
CREATE POLICY photo_ordering_rules_update ON public.photo_ordering_rules FOR UPDATE
  USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_brokerage_admin());
CREATE POLICY photo_ordering_rules_delete ON public.photo_ordering_rules FOR DELETE
  USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── ai_usage_log ────────────────────────────────────────────────────────────
-- Per-event AI usage tracking. Rolls up into ai_usage_monthly (existing
-- aggregate table) downstream.
CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  action_type   TEXT        NOT NULL,
  model         TEXT,
  input_data    JSONB,
  output_data   JSONB,
  tokens_used   INTEGER,
  cost_cents    INTEGER,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_agent_created ON public.ai_usage_log (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_brokerage_created ON public.ai_usage_log (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_action ON public.ai_usage_log (action_type);

CREATE OR REPLACE FUNCTION public.ai_usage_log_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_usage_log_set_brokerage_trg ON public.ai_usage_log;
CREATE TRIGGER ai_usage_log_set_brokerage_trg BEFORE INSERT ON public.ai_usage_log
  FOR EACH ROW EXECUTE FUNCTION public.ai_usage_log_set_brokerage();

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_log_select ON public.ai_usage_log FOR SELECT
  USING (
    public.is_platform_admin()
    OR (brokerage_id IS NULL)
    OR public.has_brokerage_access(brokerage_id)
    OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())
  );
CREATE POLICY ai_usage_log_insert ON public.ai_usage_log FOR INSERT
  WITH CHECK (TRUE); -- AI flows write from many actor contexts incl. cron/webhook
CREATE POLICY ai_usage_log_update ON public.ai_usage_log FOR UPDATE
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY ai_usage_log_delete ON public.ai_usage_log FOR DELETE
  USING (public.is_platform_admin());
