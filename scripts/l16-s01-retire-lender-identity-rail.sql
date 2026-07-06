-- l16-s01-retire-lender-identity-rail.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- LENDERS ARE VENDORS. Retire the dead lender-identity rail now that lender
-- participation runs entirely on the vendor rail (vendors.category='Lender' +
-- vendor_assignments + transaction_lenders):
--   • transactions.lender_id  (FK → lender_portal_users; 0 rows ever set live)
--   • lender_portal_users      (per-(user,transaction) grant; superseded by
--                               vendor_assignments)
-- No commission/reporting/financial rollup referenced transactions.lender_id, and
-- all reads were repointed to the vendor rail before this drop. transaction_lenders
-- (the alive financing capability) is untouched.
--
-- Idempotent + safe: guarded with IF EXISTS.

DROP INDEX IF EXISTS public.idx_transactions_lender_id;
ALTER TABLE public.transactions DROP COLUMN IF EXISTS lender_id;
DROP TABLE IF EXISTS public.lender_portal_users CASCADE;

-- NOTE: the users.user_type CHECK still permits 'lender' (legacy rows exist). A
-- lender is now provisioned as a vendor (user_type='vendor', category 'Lender');
-- migrating any residual 'lender' users onto the vendor rail is a separate data task.
