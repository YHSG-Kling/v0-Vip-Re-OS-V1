-- Add logo_url to teams table so team-level branding can override brokerage logo
ALTER TABLE teams ADD COLUMN IF NOT EXISTS logo_url TEXT;
