-- Migration: Add offer_id to transactions + transaction milestone template tables
-- Required by: app/actions/buyer-offer/handle-offer-response.ts offer-accepted shell creation

-- 1. Add offer_id to transactions (FK to offers.id)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS offer_id uuid REFERENCES offers(id) ON DELETE SET NULL;

-- 2. Add missing columns to transaction_milestones to support template seeding
ALTER TABLE transaction_milestones
  ADD COLUMN IF NOT EXISTS title          text,
  ADD COLUMN IF NOT EXISTS description    text,
  ADD COLUMN IF NOT EXISTS milestone_type text,
  ADD COLUMN IF NOT EXISTS target_date    date;

-- 3. Create transaction_milestone_templates (brokerage-level templates)
CREATE TABLE IF NOT EXISTS transaction_milestone_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE transaction_milestone_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tmt_brokerage_isolation" ON transaction_milestone_templates
  FOR ALL USING (brokerage_id = (
    SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1
  ));

-- 4. Create milestone_template_items (line items belonging to a template)
CREATE TABLE IF NOT EXISTS milestone_template_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         uuid NOT NULL REFERENCES transaction_milestone_templates(id) ON DELETE CASCADE,
  title               text NOT NULL,
  description         text,
  milestone_type      text,
  days_from_contract  integer,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE milestone_template_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mti_brokerage_isolation" ON milestone_template_items
  FOR ALL USING (
    template_id IN (
      SELECT id FROM transaction_milestone_templates
      WHERE brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1
      )
    )
  );
