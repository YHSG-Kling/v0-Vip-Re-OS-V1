-- ============================================================================
-- CREATE DEMO USERS IN SUPABASE AUTH
-- Purpose: Create auth.users entries for all demo users
-- These users can then sign in with password: DEMO_USER
-- ============================================================================

-- Note: This uses Supabase's auth.users table
-- The password 'DEMO_USER' will be hashed by Supabase

-- Insert demo users into auth.users with proper authentication
-- Using Supabase's auth schema functions

-- Agent Users
INSERT INTO auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin,
  role
)
VALUES
  -- Agents
  ('46302517-730d-48e6-b277-03afe2fc2938', 'agent1@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Michael","last_name":"Chen"}', false, 'authenticated'),
  ('e37ca3cc-dac5-4d7f-b325-8ef58cba8032', 'agent2@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Jessica","last_name":"Martinez"}', false, 'authenticated'),
  ('0a76246d-57eb-415b-b3e3-bace5201ff86', 'teamlead@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"David","last_name":"Williams"}', false, 'authenticated'),
  
  -- Broker & Admin
  ('65bb2208-1421-42ab-9e20-23fecff2f727', 'broker@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Sarah","last_name":"Johnson"}', false, 'authenticated'),
  ('6530b0cd-6287-44e2-93d8-954b392f1566', 'admin@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Admin","last_name":"User"}', false, 'authenticated'),
  
  -- Transaction Coordinator & Compliance
  ('db9f09db-0e73-45bd-a826-f7422afccc2c', 'tc@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Tom","last_name":"Wilson"}', false, 'authenticated'),
  ('bbbba622-ba1f-44d9-ae0e-caf6ec4f3ddb', 'compliance@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Lisa","last_name":"Anderson"}', false, 'authenticated'),
  
  -- Buyers
  ('ee2de8d4-990c-4be5-9328-aa41b7b11bcb', 'buyer_ftb@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Emma","last_name":"Thompson"}', false, 'authenticated'),
  ('3e189e9c-7ae5-460e-8135-7f36130ab499', 'buyer_luxury@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Robert","last_name":"Park"}', false, 'authenticated'),
  ('41252bdf-d3ea-4867-a0ad-e72423522eac', 'buyer_relocating@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Jennifer","last_name":"Chen"}', false, 'authenticated'),
  
  -- Sellers
  ('1d1d5a26-2414-442a-a9fd-69fcf7937297', 'seller_motivated@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"James","last_name":"Rodriguez"}', false, 'authenticated'),
  ('825b7369-7a85-45c9-9c26-68bda7f6512e', 'seller_downsizing@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Margaret","last_name":"Douglas"}', false, 'authenticated'),
  
  -- Investors
  ('c90022e4-8c06-4f92-b663-4570b6ed4a39', 'investor_commercial@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"David","last_name":"Lee"}', false, 'authenticated'),
  ('e3fe2b8b-8b5c-47ea-bcc2-c42108ba0260', 'investor_residential@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Patricia","last_name":"Murphy"}', false, 'authenticated'),
  
  -- Vendors
  ('ea12dc98-75ab-472d-b6ba-c2f5e245308a', 'lender@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Kevin","last_name":"Banks"}', false, 'authenticated'),
  ('95055159-7244-466c-b826-b885de83851e', 'title@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Susan","last_name":"Legal"}', false, 'authenticated'),
  ('76db0fd8-5a36-411e-8252-8987d61379d1', 'inspector@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Mark","last_name":"Quality"}', false, 'authenticated'),
  ('ad36cc1c-7c9e-4c5a-95f0-9cf55af0cad5', 'appraiser@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Nancy","last_name":"Value"}', false, 'authenticated'),
  ('42eca4d7-1316-4b30-97d6-64132fabad66', 'escrow@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Richard","last_name":"Escrow"}', false, 'authenticated'),
  ('a06b6c43-fd8b-4dbb-a104-795378a389aa', 'vendor@vipos.com', crypt('DEMO_USER', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"first_name":"Victor","last_name":"Services"}', false, 'authenticated')
ON CONFLICT (id) DO NOTHING;

-- Create identities for each user
INSERT INTO auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  id,
  jsonb_build_object('sub', id::text, 'email', email),
  'email',
  now(),
  now(),
  now()
FROM auth.users
WHERE email LIKE '%@vipos.com'
ON CONFLICT DO NOTHING;
