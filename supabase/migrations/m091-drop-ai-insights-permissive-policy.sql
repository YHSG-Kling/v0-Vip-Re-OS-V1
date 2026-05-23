-- m091: remove permissive ai_insights policy that defeats tenant isolation
-- ai_insights had `ai_insights_all` (cmd=ALL, role=authenticated, qual=true,
-- with_check=true) alongside the correct tenant-scoped policies. Postgres
-- OR-combines policies, so the permissive ALL policy let any authenticated user
-- read/write every brokerage's AI insights (the same class of leak migration 041
-- fixed). Dropping it leaves the four ai_insights_tenant_* policies, which scope
-- access to the caller's brokerage.

DROP POLICY IF EXISTS ai_insights_all ON public.ai_insights;
