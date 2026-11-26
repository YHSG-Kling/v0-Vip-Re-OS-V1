-- ── APPLIED LIVE 2026-10-01 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m679 — brokerages.billing_metadata stops carrying a SECOND subscription status
-- and a SECOND trial end (lane 92A, wave 92; the wave-91 walkthrough's P2 item).
--
-- THE DEFECT (measured live by lane 91D on a fresh trial tenant): the column
-- DEFAULT, written by scripts/120-create-usage-tracking-billing.sql, is
--     {"stripe_customer_id":null,"stripe_subscription_id":null,"billing_email":null,
--      "billing_cycle":"monthly","trial_ends_at":null,"subscription_status":"active"}
-- so EVERY brokerage inserted without an explicit bag was born saying
-- subscription_status "active" with no trial end, while its subscriptions row
-- (lib/kernel/tenant-creation.ts buildSubscriptionRow) says 'trialing' with a
-- trial_end. Two answers to one question is a §6 defect.
--
-- WHICH ONE IS TRUE: subscriptions.status / trial_end (read by
-- lib/billing/billing-access.ts, the paywall) and brokerages.trial_ends_at. The two
-- bag keys have NO reader: a comment-stripped scan of app/ lib/ hooks/ contexts/
-- finds no read of billing_metadata.subscription_status or .trial_ends_at, and the
-- only supabase/migrations mentions of billing_metadata are prose (m472's comment,
-- m660's COMMENT ON text) — no function, view or policy reads a key of it. (Repo
-- files only; the integrator should re-run
--   select proname from pg_proc where prosrc ilike '%billing_metadata%';
-- live before applying, and expect 0 rows.)
-- So they are deleted, not mirrored — a mirror would drift again the first time the
-- Stripe webhook flips the subscription to 'active'.
--
-- THE CODE HALF ships without this migration: both brokerage inserts
-- (lib/kernel/tenant-creation.ts createTenantCore — the convertProspectToSubscriber,
-- self-serve signup and staff-door path — and the brokerage-of-one self-heal in
-- app/actions/onboarding/ensure-agent-brokerage.ts) now write billing_metadata: {}
-- explicitly. This migration fixes the DEFAULT for any other writer and cleans the
-- rows already born with the wrong answer.
--
-- The other default keys (stripe_customer_id, stripe_subscription_id, billing_email,
-- billing_cycle) are dropped from the DEFAULT for the same reason (each duplicates a
-- subscriptions / brokerages column and the default value is a placeholder, not a
-- fact) but are NOT stripped from existing rows: lib/onboarding/critical-setup.ts
-- reads billing_metadata.stripe_customer_id, and a non-null value someone wrote there
-- must not be destroyed by a cleanup.
--
-- After apply: no CHECK changes, no column changes — nothing to regenerate.

begin;

alter table public.brokerages
  alter column billing_metadata set default '{}'::jsonb;

do $$
declare
  v_before  integer;
  v_cleaned integer;
  v_after   integer;
begin
  select count(*) into v_before
    from public.brokerages
   where billing_metadata ? 'subscription_status'
      or billing_metadata ? 'trial_ends_at';

  with cleaned as (
    update public.brokerages
       set billing_metadata = (billing_metadata - 'subscription_status') - 'trial_ends_at'
     where billing_metadata ? 'subscription_status'
        or billing_metadata ? 'trial_ends_at'
    returning id
  )
  select count(*) into v_cleaned from cleaned;

  select count(*) into v_after
    from public.brokerages
   where billing_metadata ? 'subscription_status'
      or billing_metadata ? 'trial_ends_at';

  -- COUNTED (§3): an update that matched fewer rows than it should have is a failure,
  -- not a quiet success.
  if v_cleaned <> v_before or v_after <> 0 then
    raise exception 'm679: expected to clean % rows, cleaned %, % still carry the keys', v_before, v_cleaned, v_after;
  end if;
  raise notice 'm679: % brokerages rows no longer carry a second subscription_status / trial_ends_at', v_cleaned;
end $$;

commit;
