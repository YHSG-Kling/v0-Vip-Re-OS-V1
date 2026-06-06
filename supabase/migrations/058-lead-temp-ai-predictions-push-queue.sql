-- =====================================================
-- MIGRATION 058: lead_temperature column + ai_predictions +
--                push_notification_queue
-- =====================================================
-- Three drift fixes surfaced by the parallel-agent column-drift audit:
--
-- 1. lead_temperature column missing on leads + contacts (15+ callers
--    across ai-chat / ai-predictions / LeadInsightsPanel / ChatInterface /
--    ChatSessionsList all read or write it).
--
-- 2. ai_predictions table missing — distinct from pattern_predictions
--    (which has prediction_label/predicted_event/predicted_within_days)
--    and ai_insights (insight_title/insight_description/actionable_steps).
--    Caller (app/actions/ai-predictions.ts:255, 1748) writes prediction_
--    type/entity_type/entity_id/prediction_value(jsonb)/confidence_score/
--    prediction_factors/model_version — needs its own table.
--
-- 3. push_notification_queue table missing — lib/transactions/
--    notification-service.ts:233 writes per-recipient push payloads
--    (user_id/brokerage_id/title/body/data/status). Distinct from
--    notification_queue (which is a tiny delivery-scheduling table
--    keyed by notification_id+scheduled_for) and notifications
--    (which lacks the `data` jsonb column callers populate).
-- =====================================================

-- ─── leads.lead_temperature + contacts.lead_temperature ──────────────────────
-- Values mirror communication_audit_log.lead_temperature_check
-- (hot|warm|cold).
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lead_temperature TEXT;
ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_lead_temperature_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_lead_temperature_check
  CHECK (lead_temperature IS NULL OR lead_temperature IN ('hot','warm','cold'));

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lead_temperature TEXT;
ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_lead_temperature_check;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_lead_temperature_check
  CHECK (lead_temperature IS NULL OR lead_temperature IN ('hot','warm','cold'));

CREATE INDEX IF NOT EXISTS idx_leads_lead_temperature
  ON public.leads (brokerage_id, lead_temperature)
  WHERE lead_temperature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_lead_temperature
  ON public.contacts (brokerage_id, lead_temperature)
  WHERE lead_temperature IS NOT NULL;

-- ─── ai_predictions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_predictions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  prediction_type     TEXT        NOT NULL,
  entity_type         TEXT        NOT NULL,
  entity_id           UUID        NOT NULL,
  prediction_value    JSONB,
  confidence_score    NUMERIC(5,4),
  prediction_factors  JSONB,
  model_version       TEXT,
  outcome_date        DATE,
  actual_outcome      JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_predictions_entity ON public.ai_predictions (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ai_predictions_type_created ON public.ai_predictions (prediction_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_predictions_brokerage ON public.ai_predictions (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;

-- Auto-denormalize brokerage_id from the entity when entity_type is
-- one of the brokerage-scoped kinds we already know how to look up.
CREATE OR REPLACE FUNCTION public.ai_predictions_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.entity_type = 'lead' THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.entity_id;
    ELSIF NEW.entity_type = 'contact' THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.entity_id;
    ELSIF NEW.entity_type = 'transaction' THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.entity_id;
    ELSIF NEW.entity_type = 'agent' THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.entity_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_predictions_set_brokerage_trg ON public.ai_predictions;
CREATE TRIGGER ai_predictions_set_brokerage_trg BEFORE INSERT ON public.ai_predictions
  FOR EACH ROW EXECUTE FUNCTION public.ai_predictions_set_brokerage();

ALTER TABLE public.ai_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_predictions_select ON public.ai_predictions FOR SELECT
  USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ai_predictions_insert ON public.ai_predictions FOR INSERT
  WITH CHECK (TRUE); -- AI flows write from many contexts incl. cron
CREATE POLICY ai_predictions_update ON public.ai_predictions FOR UPDATE
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id))
  WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ai_predictions_delete ON public.ai_predictions FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── push_notification_queue ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_notification_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id    UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  body            TEXT,
  data            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'pending',
  delivered_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT push_notification_queue_status_check CHECK (status IN (
    'pending','delivering','delivered','failed','cancelled'
  ))
);
CREATE INDEX IF NOT EXISTS idx_push_notification_queue_user_pending
  ON public.push_notification_queue (user_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_push_notification_queue_brokerage
  ON public.push_notification_queue (brokerage_id, created_at DESC);

ALTER TABLE public.push_notification_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_notification_queue_select ON public.push_notification_queue FOR SELECT
  USING (
    public.is_platform_admin()
    OR public.has_brokerage_access(brokerage_id)
    OR (user_id = auth.uid())
  );
CREATE POLICY push_notification_queue_insert ON public.push_notification_queue FOR INSERT
  WITH CHECK (TRUE); -- system writers (cron / transaction events) need open insert
CREATE POLICY push_notification_queue_update ON public.push_notification_queue FOR UPDATE
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id))
  WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY push_notification_queue_delete ON public.push_notification_queue FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
