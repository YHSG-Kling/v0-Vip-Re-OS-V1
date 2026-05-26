-- m100-connector-health-log.sql
-- Connectivity API Agent health history. One row per connector probe / connectivity scan,
-- written by the connector-health cron (service role). The attention rows (expired /
-- expiring_soon / auth_failed / shape_drift) are the superadmin alert feed.
-- Applied live via Supabase MCP; committed here for reproducibility.

CREATE TABLE IF NOT EXISTS public.connector_health_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  provider text NOT NULL,
  transport text NOT NULL,
  status text NOT NULL,
  drifted boolean NOT NULL DEFAULT false,
  http_status int,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connector_health_log_brokerage_provider_idx
  ON public.connector_health_log (brokerage_id, provider, checked_at DESC);
CREATE INDEX IF NOT EXISTS connector_health_log_attention_idx
  ON public.connector_health_log (checked_at DESC)
  WHERE drifted OR status IN ('expired','expiring_soon','auth_failed','shape_drift');

ALTER TABLE public.connector_health_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connector_health_log_select ON public.connector_health_log;
CREATE POLICY connector_health_log_select ON public.connector_health_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND (
          u.user_type = 'superadmin'
          OR u.platform_role IN ('superadmin','support')
          OR u.brokerage_id = connector_health_log.brokerage_id
        )
    )
  );

COMMENT ON TABLE public.connector_health_log IS
  'Connectivity API Agent health history: one row per connector probe / connectivity scan. Written by the connector-health cron (service role). RLS: platform staff read all, brokerage reads its own.';
