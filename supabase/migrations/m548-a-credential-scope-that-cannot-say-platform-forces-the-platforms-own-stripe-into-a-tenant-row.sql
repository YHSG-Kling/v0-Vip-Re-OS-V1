-- m548 — a credential scope that cannot say "platform" forces the platform's own
--        Stripe into a tenant-shaped row.
--
-- OWNER RULING (verbatim): "the stripe account will be per tenant and platform so
-- no configuration should be hardcoded."
--
-- `platform_credentials` is already the per-scope credential store, and its
-- OWNER-scope column already admits the full ownership vocabulary:
--
--   platform_credentials_owner_type_check
--     CHECK (owner_type IS NULL OR owner_type = ANY
--            (ARRAY['platform','brokerage','team','agent','vendor','contact']))
--
-- The older `scope` column beside it does not:
--
--   platform_credentials_scope_check
--     CHECK (scope = ANY (ARRAY['brokerage','team','agent']))
--
-- So the store can record WHO owns a credential and cannot record that the owner
-- is the PLATFORM. Both halves are written together — see
-- app/actions/connections/connection-center.ts :: startStripeConnect, which sets
-- owner_type from the actor's scope and then folds everything that is not agent
-- or team down to `scope: 'brokerage'`. A platform-owned Stripe credential
-- written through that path lands labelled as a brokerage's.
--
-- That is a money defect, not a labelling one. lib/billing/resolve-stripe-account.ts
-- refuses to charge a tenant's Stripe account for platform billing and refuses to
-- charge the platform's account for a tenant's money; both refusals key off the
-- resolved OWNER. A platform row that has to spell itself 'brokerage' is exactly
-- the ambiguity those refusals exist to remove.
--
-- ADDITIVE AND SAFE. This widens a CHECK; it rejects nothing that was previously
-- accepted. `platform_credentials` holds 0 rows as of 2026-08-24 (project
-- hrvaqgvukzxfskkcrwbt), so there is nothing to backfill and no row to re-label.
--
-- NOT FIXED HERE, AND STATED SO IT IS NOT MISTAKEN FOR DONE: `scope` and
-- `owner_type` are two spellings of one idea (CLAUDE.md §6). `owner_type` is the
-- canonical one — it is what lib/connections/scope.ts cascades over and what
-- lib/connections/resolve-scoped.ts reads. Retiring `scope` onto it is a separate
-- migration with its own writer sweep; this one only stops the older column from
-- making the newer one lie.

ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_scope_check;

ALTER TABLE public.platform_credentials
  ADD CONSTRAINT platform_credentials_scope_check
  CHECK (scope = ANY (ARRAY['platform'::text, 'brokerage'::text, 'team'::text, 'agent'::text]));

COMMENT ON COLUMN public.platform_credentials.scope IS
  'Legacy owner label. Admits platform|brokerage|team|agent (m548 added platform). The canonical owner is (owner_type, owner_id) — see lib/connections/scope.ts.';
