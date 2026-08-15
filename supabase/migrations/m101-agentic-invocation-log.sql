-- m101-agentic-invocation-log.sql
-- Audit + continued-learning log for the Agentic API: one row per INVOKE (REST + MCP)
-- decision and outcome. Written by the invoke/MCP routes via the service role.
-- Applied live via Supabase MCP; committed here for reproducibility.

CREATE TABLE IF NOT EXISTS public.agentic_invocation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability text NOT NULL,
  kind text NOT NULL,                 -- vendor | app | connected
  verb text,
  decision text NOT NULL,             -- execute | requires_confirmation | unauthorized | invalid_input | blocked | not_connected | executed | no_executor | error
  outcome text NOT NULL,              -- executed | planned | denied | error
  brokerage_id uuid,
  caller_via text,                    -- token | session
  authorized boolean,
  duration_ms int,
  error text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agentic_invocation_log_capability_idx ON public.agentic_invocation_log (capability, created_at DESC);
CREATE INDEX IF NOT EXISTS agentic_invocation_log_brokerage_idx ON public.agentic_invocation_log (brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agentic_invocation_log_decision_idx ON public.agentic_invocation_log (decision, created_at DESC);

ALTER TABLE public.agentic_invocation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agentic_invocation_log_select ON public.agentic_invocation_log;
CREATE POLICY agentic_invocation_log_select ON public.agentic_invocation_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND (
          u.user_type = 'superadmin'
          OR u.platform_role IN ('superadmin','support')
          OR u.brokerage_id = agentic_invocation_log.brokerage_id
        )
    )
  );

COMMENT ON TABLE public.agentic_invocation_log IS
  'Audit + continued-learning log: one row per Agentic API invocation (REST + MCP). Service-role writes. RLS: platform staff all, brokerage own.';
