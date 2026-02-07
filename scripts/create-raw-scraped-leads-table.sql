-- Create raw_scraped_leads table if it doesn't exist
CREATE TABLE IF NOT EXISTS raw_scraped_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id),
  source text NOT NULL,
  raw_data jsonb NOT NULL,
  processing_status text DEFAULT 'pending',
  error_message text,
  lead_id uuid REFERENCES leads(id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  processed_at timestamp with time zone
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_brokerage_id ON raw_scraped_leads(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_status ON raw_scraped_leads(processing_status);
CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_source ON raw_scraped_leads(source);
CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_created_at ON raw_scraped_leads(created_at DESC);

-- Enable RLS
ALTER TABLE raw_scraped_leads ENABLE ROW LEVEL SECURITY;

-- Policy: Brokers and admins can view their brokerage's raw leads
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'raw_scraped_leads' AND policyname = 'Brokers and admins view raw leads'
  ) THEN
    CREATE POLICY "Brokers and admins view raw leads"
      ON raw_scraped_leads
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND role IN ('admin', 'broker')
        )
        OR
        EXISTS (
          SELECT 1 FROM agents 
          WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Policy: System can insert raw leads
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'raw_scraped_leads' AND policyname = 'System insert raw leads'
  ) THEN
    CREATE POLICY "System insert raw leads"
      ON raw_scraped_leads
      FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

-- Policy: System can update raw leads
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'raw_scraped_leads' AND policyname = 'System update raw leads'
  ) THEN
    CREATE POLICY "System update raw leads"
      ON raw_scraped_leads
      FOR UPDATE
      USING (true);
  END IF;
END $$;
