-- Migration 032: Fix infinite recursion in users_same_brokerage_select policy
--
-- The existing policy referenced public.users inside its own USING clause:
--   (id = auth.uid()) OR (brokerage_id = (
--     SELECT users_1.brokerage_id FROM users users_1
--     WHERE users_1.id = auth.uid() LIMIT 1
--   ))
--
-- When evaluating SELECT on users, the inner subquery triggered RLS on
-- users itself, which triggered the subquery again — infinite recursion.
-- Postgres raises ERROR 42P17 "infinite recursion detected in policy for
-- relation 'users'".
--
-- This breaks any authenticated session that queries users (including
-- transitively via JOINs from contacts/listings/transactions/etc.). Surfaced
-- during a multi-tenant flow test that queried contacts as an authenticated
-- agent — the contacts policy's user_type check joins to users, triggering
-- the recursion.
--
-- Fix: replace the inline subquery with current_user_brokerage_id(), a
-- SECURITY DEFINER function already used by every other tenant-scoped
-- policy in the schema. SECURITY DEFINER runs as the function owner
-- (postgres) and bypasses RLS on the lookup, breaking the recursion.
--
-- Applied: 2026-05-18

DROP POLICY IF EXISTS users_same_brokerage_select ON public.users;
CREATE POLICY users_same_brokerage_select ON public.users
  FOR SELECT
  USING (
    id = auth.uid()
    OR brokerage_id = current_user_brokerage_id()
  );
