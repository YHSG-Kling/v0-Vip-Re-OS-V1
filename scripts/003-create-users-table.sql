-- Create users table in Supabase for internal users and contacts
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  user_type TEXT NOT NULL CHECK (user_type IN ('broker', 'admin', 'agent', 'vendor', 'lender', 'TC', 'compliance_officer', 'contact')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  brokerage TEXT,
  role TEXT,
  created_by UUID REFERENCES users(id),
  is_contact BOOLEAN DEFAULT false,
  contact_type TEXT,
  contact_persona TEXT,
  username TEXT UNIQUE,
  password_hash TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);

-- Create index on user_type and is_contact for faster queries
CREATE INDEX idx_users_user_type ON users(user_type);
CREATE INDEX idx_users_is_contact ON users(is_contact);
CREATE INDEX idx_users_created_by ON users(created_by);
CREATE INDEX idx_users_email ON users(email);

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Admins/Brokers can see all users
CREATE POLICY "Admins and Brokers see all users" ON users
  FOR SELECT
  USING (
    auth.jwt() ->> 'user_type' IN ('admin', 'broker')
  );

-- RLS Policy: Agents can see users assigned to them and contacts they created
CREATE POLICY "Agents see their contacts" ON users
  FOR SELECT
  USING (
    auth.jwt() ->> 'user_type' = 'agent'
    AND (
      created_by = auth.uid()
      OR is_contact = true
    )
  );

-- RLS Policy: Contacts can only see their own user record
CREATE POLICY "Contacts see themselves" ON users
  FOR SELECT
  USING (
    auth.jwt() ->> 'user_type' = 'contact'
    AND id = auth.uid()
  );
