-- Migration: Add user_id column to referral_partners for auth-scoped queries
-- Date: 2026-03-09
-- 
-- Column usage rule:
-- - user_id: Auth-scoped queries (e.g., "show me MY referral partners")
--   Example: .eq("user_id", authUser.id) in list/fetch actions
-- - agent_id: Business joins (commission splits, reporting, analytics)
--   Example: JOIN to agents for production stats
--
-- Never use user_id for business logic. Never use agent_id for auth-gated row access.

-- Step 1: Add user_id column to referral_partners
ALTER TABLE public.referral_partners
ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Step 2: Create index for efficient auth-scoped queries
CREATE INDEX IF NOT EXISTS idx_referral_partners_user_id 
ON public.referral_partners(user_id);

-- Step 3: Add comment documenting the column usage
COMMENT ON COLUMN public.referral_partners.user_id IS 
'Auth user ID for auth-scoped queries. Use for "show me MY referral partners" queries. For business logic/joins, use agent_id instead.';

COMMENT ON COLUMN public.referral_partners.agent_id IS 
'Agent ID for business joins (commission splits, reporting, analytics). Never use for auth-gated row access - use user_id instead.';
