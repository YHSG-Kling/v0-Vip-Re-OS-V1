-- m095: scope compliance_alerts INSERT to the caller's brokerage
-- ca_insert allowed any (public) role to insert with WITH CHECK (true), so a
-- caller could forge compliance alerts for any brokerage. All writers now either
-- run under the service role (the compliance cron, which bypasses RLS) or are
-- authenticated user actions that stamp brokerage_id (monitorTRIDComplianceService
-- from the transaction, analyzeFairHousingRiskService from the contact), so we can
-- require brokerage access — matching the ca_select policy's access function.

DROP POLICY IF EXISTS ca_insert ON public.compliance_alerts;
CREATE POLICY ca_insert ON public.compliance_alerts
  FOR INSERT TO public
  WITH CHECK (is_platform_admin() OR has_brokerage_access(brokerage_id));
