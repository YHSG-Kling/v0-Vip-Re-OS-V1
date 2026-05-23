-- m094: scope fair_housing_logs INSERT to the caller's brokerage
-- Previously fhl_insert allowed any (public) role to insert with WITH CHECK (true),
-- so a caller could forge fair-housing audit rows for any brokerage (or NULL).
-- The sole writer (analyzeFairHousingRiskService) now stamps brokerage_id from
-- the contact/agent and runs under the authenticated user, so we can require
-- brokerage access — matching the existing fhl_select policy.
--
-- NOTE: compliance_alerts / compliance_flags INSERT are intentionally NOT tightened
-- here. Their cron writer (app/api/cron/compliance-monitoring) uses an anon server
-- client (no user session), so a brokerage-access WITH CHECK would block it. That
-- needs the cron moved to a service-role client first (tracked separately).

DROP POLICY IF EXISTS fhl_insert ON public.fair_housing_logs;
CREATE POLICY fhl_insert ON public.fair_housing_logs
  FOR INSERT TO public
  WITH CHECK (is_platform_admin() OR has_brokerage_access(brokerage_id));
