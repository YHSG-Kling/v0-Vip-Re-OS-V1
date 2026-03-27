-- Add missing columns to referrals table
ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS referral_name          text,
  ADD COLUMN IF NOT EXISTS value_estimate         numeric,
  ADD COLUMN IF NOT EXISTS commission_potential    numeric,
  ADD COLUMN IF NOT EXISTS source_contact_name     text,
  ADD COLUMN IF NOT EXISTS referred_by            text,
  ADD COLUMN IF NOT EXISTS converted_at           timestamp with time zone,
  ADD COLUMN IF NOT EXISTS gift_sent              boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS gift_sent_at           timestamp with time zone,
  ADD COLUMN IF NOT EXISTS thank_you_sent         boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS thank_you_sent_at      timestamp with time zone,
  ADD COLUMN IF NOT EXISTS updated_at             timestamp with time zone DEFAULT now();

-- Create review_requests table if it does not exist
CREATE TABLE IF NOT EXISTS review_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  brokerage_id   uuid REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id     uuid REFERENCES contacts(id) ON DELETE SET NULL,
  contact_name   text,
  status         text NOT NULL DEFAULT 'pending',
  platform       text,
  review_url     text,
  sent_at        timestamp with time zone,
  completed_at   timestamp with time zone,
  created_at     timestamp with time zone DEFAULT now(),
  updated_at     timestamp with time zone DEFAULT now()
);

-- Enable RLS on review_requests
ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'review_requests'
      AND policyname = 'review_requests_brokerage_isolation'
  ) THEN
    EXECUTE $p$
      CREATE POLICY review_requests_brokerage_isolation
        ON review_requests FOR ALL
        USING (brokerage_id = (
          SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1
        ))
    $p$;
  END IF;
END $$;
