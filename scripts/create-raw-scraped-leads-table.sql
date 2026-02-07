-- Create raw_scraped_leads table if it doesn't exist
CREATE TABLE IF NOT EXISTS raw_scraped_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid REFERENCES brokerages(id) NOT NULL,
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
CREATE POLICY IF NOT EXISTS "Brokers and admins view raw leads"
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

-- Policy: System can insert raw leads
CREATE POLICY IF NOT EXISTS "System insert raw leads"
  ON raw_scraped_leads
  FOR INSERT
  WITH CHECK (true);

-- Policy: System can update raw leads
CREATE POLICY IF NOT EXISTS "System update raw leads"
  ON raw_scraped_leads
  FOR UPDATE
  USING (true);
