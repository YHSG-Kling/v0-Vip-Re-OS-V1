-- =====================================================
-- MIGRATION 041: Close admin cross-brokerage leak on
-- contacts / listings / transactions
-- =====================================================
-- Audit (PR #41 follow-up) found nine policies that grant any user
-- with user_type IN ('admin','super_admin') read/write access to
-- contacts, listings, and transactions across ALL brokerages:
--
--   contacts.admin_delete_contacts
--   contacts.admin_insert_contacts
--   contacts.admin_read_all_contacts
--   contacts.admin_update_contacts
--   listings.admin_delete_listings
--   listings.admin_insert_listings
--   listings.admin_read_all_listings
--   listings.admin_update_listings
--   transactions.admins_view_all_transactions
--
-- Today every active 'admin' user is a brokerage admin (per the
-- migration 036 CHECK list); 'super_admin' was a legacy value that
-- no row carries. So in practice these policies let brokerage
-- admins read every brokerage's data — the same class of bug we
-- already fixed for `leads`.
--
-- Fix: drop the legacy policies and replace with platform-admin-only
-- cross-tenant policies that use public.is_platform_admin().
-- Brokerage admins remain covered by the existing
-- broker_*_brokerage_* policies (which already scope to
-- brokerage_id = current_user_brokerage_id()).
-- =====================================================

-- contacts
DROP POLICY IF EXISTS admin_read_all_contacts  ON public.contacts;
DROP POLICY IF EXISTS admin_insert_contacts    ON public.contacts;
DROP POLICY IF EXISTS admin_update_contacts    ON public.contacts;
DROP POLICY IF EXISTS admin_delete_contacts    ON public.contacts;

CREATE POLICY platform_admin_read_contacts  ON public.contacts FOR SELECT USING (public.is_platform_admin());
CREATE POLICY platform_admin_insert_contacts ON public.contacts FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY platform_admin_update_contacts ON public.contacts FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY platform_admin_delete_contacts ON public.contacts FOR DELETE USING (public.is_platform_admin());

-- listings
DROP POLICY IF EXISTS admin_read_all_listings ON public.listings;
DROP POLICY IF EXISTS admin_insert_listings   ON public.listings;
DROP POLICY IF EXISTS admin_update_listings   ON public.listings;
DROP POLICY IF EXISTS admin_delete_listings   ON public.listings;

CREATE POLICY platform_admin_read_listings  ON public.listings FOR SELECT USING (public.is_platform_admin());
CREATE POLICY platform_admin_insert_listings ON public.listings FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY platform_admin_update_listings ON public.listings FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY platform_admin_delete_listings ON public.listings FOR DELETE USING (public.is_platform_admin());

-- transactions (SELECT-only legacy policy)
DROP POLICY IF EXISTS admins_view_all_transactions ON public.transactions;

CREATE POLICY platform_admin_view_transactions ON public.transactions FOR SELECT USING (public.is_platform_admin());
