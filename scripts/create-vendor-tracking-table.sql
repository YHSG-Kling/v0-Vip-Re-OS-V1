-- Create vendor_usage_tracking table for tracking API costs
CREATE TABLE IF NOT EXISTS vendor_usage_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name text NOT NULL,
  usage_type text NOT NULL,
  units_used integer NOT NULL,
  cost_per_unit numeric NOT NULL,
  total_cost numeric NOT NULL,
  lead_id uuid REFERENCES leads(id),
  brokerage_id uuid REFERENCES brokerages(id) NOT NULL,
  agent_id uuid REFERENCES agents(id),
  request_metadata jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX idx_vendor_tracking_vendor ON vendor_usage_tracking(vendor_name);
CREATE INDEX idx_vendor_tracking_brokerage ON vendor_usage_tracking(brokerage_id);
CREATE INDEX idx_vendor_tracking_created ON vendor_usage_tracking(created_at DESC);
CREATE INDEX idx_vendor_tracking_lead ON vendor_usage_tracking(lead_id);

-- Enable RLS
ALTER TABLE vendor_usage_tracking ENABLE ROW LEVEL SECURITY;

-- Policy: Brokers and admins can view vendor usage
CREATE POLICY "Brokers and admins view vendor usage"
  ON vendor_usage_tracking
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE id = auth.uid() 
      AND role IN ('admin', 'broker')
    )
    OR
    agent_id IN (
      SELECT id FROM agents WHERE user_id = auth.uid()
    )
  );

-- Policy: Service role can insert
CREATE POLICY "Service role can insert vendor usage"
  ON vendor_usage_tracking
  FOR INSERT
  WITH CHECK (true);
