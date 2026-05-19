-- Migration 1000: Vendor invoicing, earnings, payouts + Stripe Connect fields
-- Vendor invoices can be sent TO the brokerage (standard) or TO the contact directly.
-- Stripe Connect is used for vendor payouts: brokerage collects → transfers to vendor.

-- 1. Stripe Connect account on vendor profiles
ALTER TABLE vendor_marketplace_profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payout_method TEXT DEFAULT 'stripe'
    CHECK (payout_method IN ('stripe', 'cash_app', 'check', 'ach', 'manual'));

-- 2. Vendor invoices (proper table — replaces JSON-in-notes workaround)
CREATE TABLE IF NOT EXISTS vendor_invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      UUID REFERENCES brokerages(id),
  vendor_id         UUID,                          -- references vendor_marketplace_profiles.id
  booking_id        UUID REFERENCES vendor_bookings(id) ON DELETE SET NULL,
  transaction_id    UUID REFERENCES transactions(id) ON DELETE SET NULL,
  listing_id        UUID REFERENCES listings(id) ON DELETE SET NULL,
  -- Who receives the invoice (brokerage or direct-to-contact)
  billed_to         TEXT NOT NULL DEFAULT 'brokerage'
    CHECK (billed_to IN ('brokerage', 'contact')),
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,  -- when billed_to = 'contact'
  invoice_number    TEXT,
  invoice_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date          DATE,
  line_items        JSONB DEFAULT '[]',  -- [{description, quantity, unit_price, amount}]
  subtotal          NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_rate          NUMERIC(5,4) DEFAULT 0,
  tax_amount        NUMERIC(10,2) DEFAULT 0,
  total_amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency          TEXT DEFAULT 'usd',
  status            TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'viewed', 'paid', 'overdue', 'cancelled', 'disputed')),
  payment_method    TEXT,
  stripe_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  paid_at           TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_invoices_vendor ON vendor_invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_brokerage ON vendor_invoices(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_booking ON vendor_invoices(booking_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_status ON vendor_invoices(status);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_contact ON vendor_invoices(contact_id);

ALTER TABLE vendor_invoices ENABLE ROW LEVEL SECURITY;

-- 3. Vendor earnings (aggregated view of what each vendor has earned)
CREATE TABLE IF NOT EXISTS vendor_earnings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id      UUID NOT NULL,
  brokerage_id   UUID REFERENCES brokerages(id),
  invoice_id     UUID REFERENCES vendor_invoices(id) ON DELETE CASCADE,
  period_start   DATE,
  period_end     DATE,
  gross_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_fee   NUMERIC(10,2) NOT NULL DEFAULT 0,  -- brokerage rev-share or platform cut
  net_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'available', 'paid_out', 'on_hold')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_earnings_vendor ON vendor_earnings(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_earnings_status ON vendor_earnings(status);

ALTER TABLE vendor_earnings ENABLE ROW LEVEL SECURITY;

-- 4. Vendor payouts (when brokerage sends money to vendor)
CREATE TABLE IF NOT EXISTS vendor_payouts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id               UUID NOT NULL,
  brokerage_id            UUID REFERENCES brokerages(id),
  amount                  NUMERIC(10,2) NOT NULL,
  currency                TEXT DEFAULT 'usd',
  payout_method           TEXT NOT NULL DEFAULT 'stripe',
  stripe_transfer_id      TEXT,   -- Stripe Connect transfer ID
  stripe_payout_id        TEXT,   -- when funds reach vendor's bank
  cash_app_reference      TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  initiated_at            TIMESTAMPTZ DEFAULT NOW(),
  completed_at            TIMESTAMPTZ,
  earnings_ids            UUID[],  -- which vendor_earnings rows this payout covers
  note                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_vendor_payouts_vendor ON vendor_payouts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_status ON vendor_payouts(status);

ALTER TABLE vendor_payouts ENABLE ROW LEVEL SECURITY;

-- 5. Trigger: updated_at on vendor_invoices
CREATE OR REPLACE FUNCTION update_vendor_invoices_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_invoices_updated_at ON vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_updated_at
  BEFORE UPDATE ON vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION update_vendor_invoices_updated_at();
