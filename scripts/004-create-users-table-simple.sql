-- Run this SQL directly in your Supabase SQL Editor to create the users table
-- Go to: Supabase Dashboard > SQL Editor > New Query > Paste this > Run

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  user_type TEXT NOT NULL CHECK (user_type IN ('broker', 'admin', 'agent', 'vendor', 'lender', 'TC', 'compliance_officer', 'contact')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  brokerage TEXT,
  role TEXT,
  created_by UUID,
  is_contact BOOLEAN DEFAULT false,
  contact_type TEXT,
  contact_persona TEXT,
  username TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_users_user_type ON users(user_type);
CREATE INDEX IF NOT EXISTS idx_users_is_contact ON users(is_contact);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
