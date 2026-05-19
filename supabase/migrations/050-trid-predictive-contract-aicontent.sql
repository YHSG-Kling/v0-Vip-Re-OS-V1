-- =====================================================
-- MIGRATION 050: TRID compliance + predictive scoring +
--                contract reviews + AI content audit
-- =====================================================
-- Four missing tables across the compliance, predictive-AI, and
-- admin-audit surfaces. Verified from real caller shapes:
--   • lib/application/compliance-monitoring.ts (trid_timeline)
--   • app/actions/ai-predictions.ts             (predictive_lead_scores)
--   • app/actions/ai-contract-review.ts         (contract_reviews)
--   • app/admin/ai-audit/page.tsx               (ai_content_outputs)
-- =====================================================

-- ─── trid_timeline ───────────────────────────────────────────────────────────
-- TRID = TILA/RESPA Integrated Disclosure. Regulated mortgage timeline
-- with hard deadlines (loan estimate within 3 business days, closing
-- disclosure 3 days before consummation). Brokerage_id is denormalized
-- from the transaction so RLS can run without a join.
CREATE TABLE IF NOT EXISTS public.trid_timeline (
  id                                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id                      UUID        NOT NULL UNIQUE
                                                  REFERENCES public.transactions(id) ON DELETE CASCADE,
  brokerage_id                        UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  loan_application_date               DATE,
  loan_estimate_delivered_date        DATE,
  closing_disclosure_delivered_date   DATE,
  scheduled_close_date                DATE,
  compliance_status                   TEXT        NOT NULL DEFAULT 'in_progress',
  violations                          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trid_timeline_status_check CHECK (compliance_status IN (
    'in_progress','compliant','at_risk','violation','closed'
  ))
);

CREATE INDEX IF NOT EXISTS idx_trid_timeline_brokerage_status
  ON public.trid_timeline (brokerage_id, compliance_status);
CREATE INDEX IF NOT EXISTS idx_trid_timeline_close_date
  ON public.trid_timeline (scheduled_close_date) WHERE scheduled_close_date IS NOT NULL;

-- Trigger to denormalize brokerage_id from transaction on INSERT/UPDATE.
CREATE OR REPLACE FUNCTION public.trid_timeline_set_brokerage()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.transaction_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trid_timeline_set_brokerage_trg ON public.trid_timeline;
CREATE TRIGGER trid_timeline_set_brokerage_trg
  BEFORE INSERT ON public.trid_timeline
  FOR EACH ROW EXECUTE FUNCTION public.trid_timeline_set_brokerage();

ALTER TABLE public.trid_timeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY trid_timeline_select ON public.trid_timeline FOR SELECT
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY trid_timeline_insert ON public.trid_timeline FOR INSERT
  WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY trid_timeline_update ON public.trid_timeline FOR UPDATE
  USING (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY trid_timeline_delete ON public.trid_timeline FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── predictive_lead_scores ──────────────────────────────────────────────────
-- Per-lead AI scoring snapshot. UPSERT path requires UNIQUE on lead_id.
CREATE TABLE IF NOT EXISTS public.predictive_lead_scores (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                     UUID        NOT NULL UNIQUE
                                          REFERENCES public.leads(id) ON DELETE CASCADE,
  brokerage_id                UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  conversion_probability      NUMERIC(5,4),
  predicted_conversion_date   DATE,
  predicted_deal_size         NUMERIC(12,2),
  predicted_timeline_days     INTEGER,
  overall_ai_score            NUMERIC(5,4),
  score_tier                  TEXT,
  recommended_actions         JSONB,
  optimal_contact_time        JSONB,
  best_communication_channel  TEXT,
  personalized_approach       JSONB,
  model_version               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predictive_lead_scores_brokerage
  ON public.predictive_lead_scores (brokerage_id);
CREATE INDEX IF NOT EXISTS idx_predictive_lead_scores_overall
  ON public.predictive_lead_scores (brokerage_id, overall_ai_score DESC NULLS LAST);

-- Auto-denormalize brokerage_id from lead at insert.
CREATE OR REPLACE FUNCTION public.predictive_lead_scores_set_brokerage()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS predictive_lead_scores_set_brokerage_trg ON public.predictive_lead_scores;
CREATE TRIGGER predictive_lead_scores_set_brokerage_trg
  BEFORE INSERT ON public.predictive_lead_scores
  FOR EACH ROW EXECUTE FUNCTION public.predictive_lead_scores_set_brokerage();

ALTER TABLE public.predictive_lead_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY predictive_lead_scores_select ON public.predictive_lead_scores FOR SELECT
  USING (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY predictive_lead_scores_insert ON public.predictive_lead_scores FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_ai_isa_system() AND brokerage_id = public.current_user_brokerage_id())
    OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id())
  );
CREATE POLICY predictive_lead_scores_update ON public.predictive_lead_scores FOR UPDATE
  USING (public.is_platform_admin() OR public.is_ai_isa_system() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY predictive_lead_scores_delete ON public.predictive_lead_scores FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── contract_reviews ────────────────────────────────────────────────────────
-- AI-driven contract review on a specific transaction_documents row.
-- The agent reviewing IS required here (the agent who runs the review).
CREATE TABLE IF NOT EXISTS public.contract_reviews (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID        REFERENCES public.transaction_documents(id) ON DELETE CASCADE,
  transaction_id      UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  brokerage_id        UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id            UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  review_type         TEXT        NOT NULL DEFAULT 'ai_automated',
  overall_score       NUMERIC(5,2),
  overall_assessment  TEXT,
  issues              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  missing_items       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  signature_status    JSONB,
  key_dates           JSONB,
  risk_factors        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  recommendations     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  state               TEXT,
  document_type       TEXT,
  reviewed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contract_reviews_type_check CHECK (review_type IN ('ai_automated','manual'))
);

CREATE INDEX IF NOT EXISTS idx_contract_reviews_doc       ON public.contract_reviews (document_id);
CREATE INDEX IF NOT EXISTS idx_contract_reviews_brokerage ON public.contract_reviews (brokerage_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_reviews_txn       ON public.contract_reviews (transaction_id) WHERE transaction_id IS NOT NULL;

ALTER TABLE public.contract_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_reviews_select ON public.contract_reviews FOR SELECT
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY contract_reviews_insert ON public.contract_reviews FOR INSERT
  WITH CHECK (public.is_platform_admin() OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY contract_reviews_update ON public.contract_reviews FOR UPDATE
  USING (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY contract_reviews_delete ON public.contract_reviews FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── ai_content_outputs ──────────────────────────────────────────────────────
-- Platform-admin AI audit log for AI-generated content compliance review.
-- Read at /app/admin/ai-audit/page.tsx; brokerage_id optional since the
-- admin view is platform-wide but tenant-scoped views may filter on it.
CREATE TABLE IF NOT EXISTS public.ai_content_outputs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id            UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  content_type        TEXT        NOT NULL,
  content             TEXT,
  compliance_approved BOOLEAN,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_content_outputs_created
  ON public.ai_content_outputs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_content_outputs_brokerage_created
  ON public.ai_content_outputs (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_content_outputs_compliance
  ON public.ai_content_outputs (compliance_approved) WHERE compliance_approved IS NOT NULL;

ALTER TABLE public.ai_content_outputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_content_outputs_select ON public.ai_content_outputs FOR SELECT
  USING (
    public.is_platform_admin()
    OR (brokerage_id IS NOT NULL AND public.has_brokerage_access(brokerage_id))
  );
CREATE POLICY ai_content_outputs_insert ON public.ai_content_outputs FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR public.is_ai_isa_system()
    OR (brokerage_id IS NOT NULL AND public.is_lead_visible_role()
        AND brokerage_id = public.current_user_brokerage_id())
  );
CREATE POLICY ai_content_outputs_update ON public.ai_content_outputs FOR UPDATE
  USING (public.is_platform_admin() OR (brokerage_id IS NOT NULL AND public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR (brokerage_id IS NOT NULL AND public.is_brokerage_admin() AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY ai_content_outputs_delete ON public.ai_content_outputs FOR DELETE
  USING (public.is_platform_admin());
