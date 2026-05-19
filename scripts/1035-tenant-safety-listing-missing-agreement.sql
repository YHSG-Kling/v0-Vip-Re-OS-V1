-- ============================================================================
-- Tenant Safety — add 'listing_missing_agreement' finding type
-- ============================================================================
--
-- The canonical listing creation flow is: a listing_agreement passes
-- compliance (signatures + initials complete) → the listings row is
-- automatically created. Therefore every listings row should have a
-- paired listing_agreements row containing the agent/seller-contracted
-- commission rate.
--
-- If the Revenue Protection scorer encounters a listing WITHOUT a
-- matching listing_agreement, that's a compliance / data-integrity
-- violation worth surfacing in the admin tenant safety findings panel.
-- ============================================================================

ALTER TABLE tenant_safety_findings
  DROP CONSTRAINT IF EXISTS tenant_safety_findings_finding_type_check;

ALTER TABLE tenant_safety_findings
  ADD CONSTRAINT tenant_safety_findings_finding_type_check
  CHECK (finding_type IN (
    'rows_missing_brokerage_id',
    'table_missing_brokerage_id',
    'table_missing_rls_policy',
    'cross_tenant_join_risk',
    'listing_missing_agreement'
  ));
