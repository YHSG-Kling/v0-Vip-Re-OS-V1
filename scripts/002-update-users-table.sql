-- Update users table to support contact users
DO $$
BEGIN
  -- Add user_type if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='user_type') THEN
    ALTER TABLE users ADD COLUMN user_type TEXT DEFAULT 'agent' CHECK (user_type IN ('broker', 'admin', 'agent', 'vendor', 'lender', 'TC', 'compliance_officer', 'contact'));
  END IF;

  -- Add created_by if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='created_by') THEN
    ALTER TABLE users ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  -- Add is_contact if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_contact') THEN
    ALTER TABLE users ADD COLUMN is_contact BOOLEAN DEFAULT FALSE;
  END IF;

  -- Add contact_type if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='contact_type') THEN
    ALTER TABLE users ADD COLUMN contact_type TEXT;
  END IF;

  -- Add contact_persona if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='contact_persona') THEN
    ALTER TABLE users ADD COLUMN contact_persona TEXT;
  END IF;
END$$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_users_user_type ON users(user_type);
CREATE INDEX IF NOT EXISTS idx_users_is_contact ON users(is_contact);
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);
