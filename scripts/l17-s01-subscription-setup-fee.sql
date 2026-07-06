-- l17-s01-subscription-setup-fee.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a one-time SETUP FEE to the tier catalog so checkout can collect it on the
-- first invoice (Stripe subscription-mode add_invoice_items) alongside the monthly
-- plan. Part of closing the commercial money loop (see lib/billing/subscription-activation.ts).
-- Idempotent + safe (default 0 → existing tiers charge no setup fee until configured).

ALTER TABLE public.subscription_tiers
  ADD COLUMN IF NOT EXISTS setup_fee_cents INTEGER NOT NULL DEFAULT 0;
