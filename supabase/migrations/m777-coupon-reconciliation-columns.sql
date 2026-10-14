-- ── APPLIED LIVE 2026-10-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m777 — COUPON / PROMOTION-CODE RECONCILIATION COLUMNS (wave 141, lane 141H). Owner (wave 141,
-- COUPONS, binding): "code → Stripe validation → eligibility → application → invoice/checkout →
-- INTERNAL RECONCILIATION. No independent discount math." The ledger learns from Stripe — what
-- Stripe discounted on each invoice and which redemptions Stripe actually applied — so the
-- platform's coupon ledger and invoice ledger reconcile to Stripe's amounts, never the reverse.
--
-- Code (already written, depends on THIS migration; every write is SEPARATE from the row it
-- annotates, so until this is applied the UPDATE is refused entirely (PGRST204) and LOGGED — the
-- invoice row and the subscription row are untouched by the refusal):
--   · WRITER app/api/billing/webhook/route.ts invoice.paid → billing_invoices.discount_cents from
--     Stripe's own invoice.total_discount_amounts (lib/billing/discount-codes.ts invoiceDiscountCents);
--     amount_cents stays Stripe's amount_paid (already discounted) — this column is shown BESIDE it.
--     READER app/settings/billing/invoice-history-table.tsx (tenant invoice history, via
--     app/actions/billing.ts getInvoiceHistory select *).
--   · WRITER app/api/billing/webhook/route.ts customer.subscription.created/updated →
--     platform_coupon_redemptions.stripe_discount_id + stripe_applied_at when the Stripe subscription
--     carries a discount whose coupon is a platform coupon (lib/billing/discount-codes.ts
--     stampCouponStripeApplication). READER app/actions/superadmin/coupons.ts listCouponsAction
--     (stripe_applied_redemptions per coupon, rendered on app/dashboard/superadmin/coupons/coupons-manager.tsx).
--
-- Narrowest tables: billing_invoices (one row per Stripe invoice; the discount is an invoice fact)
-- and platform_coupon_redemptions (one row per coupon × tenant; "Stripe applied it" is a fact of
-- that redemption). No new table, no new vocabulary, no CHECK (no vocabulary cache to regenerate).
-- After the apply, regenerate the schema caches (scripts/schema-snapshot.ts) so the columns are
-- known to the schema guards.
--
-- PART 1 (columns) — additive, nullable, idempotent; no row changes.
ALTER TABLE public.billing_invoices ADD COLUMN IF NOT EXISTS discount_cents integer;
ALTER TABLE public.platform_coupon_redemptions ADD COLUMN IF NOT EXISTS stripe_discount_id text;
ALTER TABLE public.platform_coupon_redemptions ADD COLUMN IF NOT EXISTS stripe_applied_at timestamptz;

COMMENT ON COLUMN public.billing_invoices.discount_cents IS
  'Discount Stripe applied on this invoice (sum of invoice.total_discount_amounts), written by the billing webhook invoice.paid; amount_cents is already the discounted amount_paid (wave 141H, m777).';
COMMENT ON COLUMN public.platform_coupon_redemptions.stripe_discount_id IS
  'Stripe discount id (di_…) the billing webhook saw on the tenant subscription for this coupon — reconciliation stamp (wave 141H, m777).';
COMMENT ON COLUMN public.platform_coupon_redemptions.stripe_applied_at IS
  'When the billing webhook first saw Stripe carrying this coupon on the tenant subscription (wave 141H, m777).';

-- PART 2 (indexes / triggers) — none: both tables are read by their existing keys
-- (billing_invoices.stripe_invoice_id; platform_coupon_redemptions (coupon_id, brokerage_id)).
