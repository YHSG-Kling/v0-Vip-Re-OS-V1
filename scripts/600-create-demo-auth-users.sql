-- ============================================================================
-- CREATE DEMO USERS IN SUPABASE AUTH  
-- Purpose: Set passwords for existing demo users so they can use password auth
-- These users already exist in public.users, we're just enabling password login
-- ============================================================================

-- NOTE: This script updates existing auth.users records that were created
-- when the users signed up. It sets their password to 'DEMO_USER'

-- Update existing auth users with password
UPDATE auth.users
SET 
  encrypted_password = crypt('DEMO_USER', gen_salt('bf')),
  email_confirmed_at = COALESCE(email_confirmed_at, now()),
  updated_at = now()
WHERE email IN (
  'agent1@vipos.com',
  'agent2@vipos.com', 
  'teamlead@vipos.com',
  'broker@vipos.com',
  'admin@vipos.com',
  'tc@vipos.com',
  'compliance@vipos.com',
  'buyer_ftb@vipos.com',
  'buyer_luxury@vipos.com',
  'buyer_relocating@vipos.com',
  'seller_motivated@vipos.com',
  'seller_downsizing@vipos.com',
  'investor_commercial@vipos.com',
  'investor_residential@vipos.com',
  'lender@vipos.com',
  'title@vipos.com',
  'inspector@vipos.com',
  'appraiser@vipos.com',
  'escrow@vipos.com',
  'vendor@vipos.com'
);
