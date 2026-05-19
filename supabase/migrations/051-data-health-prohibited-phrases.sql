-- =====================================================
-- MIGRATION 051: data_health_scans + data_health_logs + prohibited_phrases
-- =====================================================
-- All three back compliance/quality features that silently failed
-- because the tables didn't exist.
--
-- data_health_scans / data_health_logs: app/actions/data-health.ts
-- runs a "hygiene scan" against contacts (email/phone/name validation),
-- creates a parent scan row and one log row per finding. The dashboard
-- reads both.
--
-- prohibited_phrases: compliance rules used by ai-chat.ts and
-- compliance-monitoring.ts. seed-compliance-rules.ts upserts a curated
-- list. Platform-wide table (rules apply across all brokerages — same
-- governance everywhere).
-- =====================================================

-- ─── data_health_scans ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_health_scans (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id           UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  scan_type              TEXT        NOT NULL DEFAULT 'full',
  status                 TEXT        NOT NULL DEFAULT 'running',
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  total_records_scanned  INTEGER     NOT NULL DEFAULT 0,
  issues_found           INTEGER     NOT NULL DEFAULT 0,
  metadata               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT data_health_scans_status_check CHECK (status IN (
    'running','completed','failed','cancelled'
  ))
);
CREATE INDEX IF NOT EXISTS idx_data_health_scans_brokerage_started
  ON public.data_health_scans (brokerage_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_health_scans_status
  ON public.data_health_scans (status) WHERE status IN ('running','failed');

ALTER TABLE public.data_health_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_health_scans_select ON public.data_health_scans FOR SELECT
  USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY data_health_scans_insert ON public.data_health_scans FOR INSERT
  WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY data_health_scans_update ON public.data_health_scans FOR UPDATE
  USING (public.is_platform_admin() OR (brokerage_id IS NULL AND public.is_lead_visible_role()) OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY data_health_scans_delete ON public.data_health_scans FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── data_health_logs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_health_logs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id             UUID        NOT NULL REFERENCES public.data_health_scans(id) ON DELETE CASCADE,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  entity_type         TEXT        NOT NULL,
  entity_id           UUID        NOT NULL,
  contact_id          UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  validation_status   TEXT        NOT NULL,
  validation_reason   TEXT,
  field_name          TEXT,
  current_value       TEXT,
  severity            TEXT,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_health_logs_scan ON public.data_health_logs (scan_id);
CREATE INDEX IF NOT EXISTS idx_data_health_logs_contact ON public.data_health_logs (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_health_logs_status ON public.data_health_logs (validation_status, severity);

-- Auto-denormalize brokerage_id from parent scan
CREATE OR REPLACE FUNCTION public.data_health_logs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.data_health_scans WHERE id = NEW.scan_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS data_health_logs_set_brokerage_trg ON public.data_health_logs;
CREATE TRIGGER data_health_logs_set_brokerage_trg BEFORE INSERT ON public.data_health_logs
  FOR EACH ROW EXECUTE FUNCTION public.data_health_logs_set_brokerage();

ALTER TABLE public.data_health_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_health_logs_select ON public.data_health_logs FOR SELECT
  USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY data_health_logs_insert ON public.data_health_logs FOR INSERT
  WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY data_health_logs_update ON public.data_health_logs FOR UPDATE
  USING (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY data_health_logs_delete ON public.data_health_logs FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── prohibited_phrases ──────────────────────────────────────────────────────
-- Platform-wide compliance rules. UNIQUE on phrase (the upsert key used
-- by seed-compliance-rules.ts).
CREATE TABLE IF NOT EXISTS public.prohibited_phrases (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase          TEXT        NOT NULL UNIQUE,
  phrase_pattern  TEXT,
  category        TEXT,
  severity        TEXT        NOT NULL DEFAULT 'warning',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prohibited_phrases_severity_check CHECK (severity IN ('info','warning','critical'))
);
CREATE INDEX IF NOT EXISTS idx_prohibited_phrases_active ON public.prohibited_phrases (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_prohibited_phrases_category ON public.prohibited_phrases (category) WHERE category IS NOT NULL;

ALTER TABLE public.prohibited_phrases ENABLE ROW LEVEL SECURITY;
-- Everyone authenticated reads (compliance rules are not tenant-secret).
CREATE POLICY prohibited_phrases_select ON public.prohibited_phrases FOR SELECT
  USING (TRUE);
-- Only platform admin writes (these are platform-governance rules).
CREATE POLICY prohibited_phrases_insert ON public.prohibited_phrases FOR INSERT
  WITH CHECK (public.is_platform_admin());
CREATE POLICY prohibited_phrases_update ON public.prohibited_phrases FOR UPDATE
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY prohibited_phrases_delete ON public.prohibited_phrases FOR DELETE
  USING (public.is_platform_admin());
