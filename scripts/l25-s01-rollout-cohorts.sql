-- l25-s01-rollout-cohorts.sql — percentage feature rollouts (deterministic
-- per-tenant cohorts; resolveEntitlement step 4). 100 = fully rolled out.
ALTER TABLE public.feature_flags ADD COLUMN IF NOT EXISTS rollout_percentage integer NOT NULL DEFAULT 100
  CHECK (rollout_percentage BETWEEN 0 AND 100);
