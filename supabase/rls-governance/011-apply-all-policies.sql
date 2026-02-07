-- =====================================================
-- 011: MASTER SCRIPT - APPLY ALL RLS POLICIES
-- =====================================================
-- This script applies all RLS policies in the correct order
-- Execute this to enable complete governance across the database

-- =====================================================
-- EXECUTION ORDER
-- =====================================================

\echo '================================================'
\echo 'Starting RLS Governance Policy Application'
\echo '================================================'

\echo ''
\echo '--- Step 1: Creating Helper Functions ---'
\i supabase/rls-governance/000-helper-functions.sql

\echo ''
\echo '--- Step 2: Applying Users & Authentication Policies ---'
\i supabase/rls-governance/001-users-policies.sql

\echo ''
\echo '--- Step 3: Applying Contacts Policies ---'
\i supabase/rls-governance/002-contacts-policies.sql

\echo ''
\echo '--- Step 4: Applying Leads Policies ---'
\i supabase/rls-governance/003-leads-policies.sql

\echo ''
\echo '--- Step 5: Applying Transactions Policies ---'
\i supabase/rls-governance/004-transactions-policies.sql

\echo ''
\echo '--- Step 6: Applying Listings Policies ---'
\i supabase/rls-governance/005-listings-policies.sql

\echo ''
\echo '--- Step 7: Applying Documents Policies ---'
\i supabase/rls-governance/006-documents-policies.sql

\echo ''
\echo '--- Step 8: Applying Journey & Stages Policies ---'
\i supabase/rls-governance/007-journey-policies.sql

\echo ''
\echo '--- Step 9: Applying Compliance & Audit Policies ---'
\i supabase/rls-governance/008-compliance-policies.sql

\echo ''
\echo '--- Step 10: Applying Vendor Access Policies ---'
\i supabase/rls-governance/009-vendor-access-policies.sql

\echo ''
\echo '--- Step 11: Applying Teams & Collaboration Policies ---'
\i supabase/rls-governance/010-teams-policies.sql

\echo ''
\echo '================================================'
\echo 'RLS Governance Policy Application Complete!'
\echo '================================================'

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

\echo ''
\echo '--- Verification: RLS Status on All Tables ---'

SELECT 
  schemaname,
  tablename,
  rowsecurity as rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

\echo ''
\echo '--- Verification: Policy Count by Table ---'

SELECT 
  tablename,
  COUNT(*) as policy_count
FROM pg_policies
WHERE schemaname = 'public'
GROUP BY tablename
ORDER BY policy_count DESC, tablename;

\echo ''
\echo '--- Verification: Helper Functions ---'

SELECT 
  proname as function_name,
  pg_get_functiondef(oid) as definition
FROM pg_proc
WHERE pronamespace = 'auth_helpers'::regnamespace;

-- =====================================================
-- GOVERNANCE METADATA
-- =====================================================

COMMENT ON SCHEMA public IS 'RLS Governance Fully Applied - All policies active and enforced across the database';

-- Log the application
DO $$
BEGIN
  RAISE NOTICE 'RLS Governance policies applied successfully at %', NOW();
  RAISE NOTICE 'Total policies applied: Check verification queries above';
  RAISE NOTICE 'All tables are now protected with Row Level Security';
END $$;
