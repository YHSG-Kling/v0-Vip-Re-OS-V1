-- ============================================================================
-- Migration 1049 — Realign to actual intent:
--   * Customer "education" is milestone/stage-gated with prereqs (NOT a
--     5-step welcome wizard). Drops the customer_onboarding table I shipped
--     in Sprint 10 — wrong shape, no data to migrate, pre-prod.
--   * Adds gating columns (prerequisite_module_ids, gated_until_milestone,
--     milestone_key) to learning_modules so the customer's /learn feed
--     can hard-gate lessons by milestone/prereq.
--   * Adds 'pending_review' + 'rejected' to learning_modules.status so AI-
--     generated content awaits admin approval instead of auto-publishing.
--   * Adds target_role[] to onboarding_steps so TC / compliance / team_lead
--     / admin get role-specific curricula (vs. the current shared agent
--     curriculum).
--   * Adds brokerages.about_text, brokerages.bio_text, teams.bio_text so
--     AI-generated education can be flavored with the brokerage/team voice.
--   * Adds brokerage_id + team_id to brand_voice_profile (fixes the
--     schema/code mismatch the audit caught — code queries those columns
--     but they didn't exist).
-- ============================================================================

BEGIN;

-- 1. Drop the wrong-shape customer_onboarding from Sprint 10.
--    Customer "onboarding" was never the right framing — what they need is
--    milestone-gated education driven by the existing portal-stream
--    projector + learning_modules.stage_tags. The welcome panel concept
--    was a buyer-tilted vanity wizard.
DROP TABLE IF EXISTS customer_onboarding CASCADE;

-- 2. Lesson gating on learning_modules
ALTER TABLE learning_modules
  ADD COLUMN IF NOT EXISTS prerequisite_module_ids uuid[]   NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS gated_until_milestone   text,                                -- contact must reach this milestone before lesson unlocks
  ADD COLUMN IF NOT EXISTS milestone_key           text;                                -- the milestone this lesson teaches (for "milestone-relevant" sorting + gating)

CREATE INDEX IF NOT EXISTS idx_lm_milestone_key
  ON learning_modules(brokerage_id, milestone_key, status)
  WHERE status='published';
CREATE INDEX IF NOT EXISTS idx_lm_gated_until_milestone
  ON learning_modules(brokerage_id, gated_until_milestone)
  WHERE gated_until_milestone IS NOT NULL;

-- 3. AI-approval status (pending_review + rejected) on learning_modules
ALTER TABLE learning_modules DROP CONSTRAINT IF EXISTS learning_modules_status_check;
ALTER TABLE learning_modules ADD CONSTRAINT learning_modules_status_check
  CHECK (status IN ('draft','pending_review','published','archived','rejected'));

-- 4. Track who approved + when (for AI-generated content audit trail)
ALTER TABLE learning_modules
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

CREATE INDEX IF NOT EXISTS idx_lm_pending_review
  ON learning_modules(brokerage_id, created_at DESC)
  WHERE status='pending_review';

-- 5. Role-specific staff onboarding curricula
ALTER TABLE onboarding_steps
  ADD COLUMN IF NOT EXISTS target_role text[];     -- ['agent'], ['tc'], ['compliance_officer','team_lead'], ['admin']

CREATE INDEX IF NOT EXISTS idx_os_target_role
  ON onboarding_steps USING gin(target_role);

-- 6. Brokerage about + bio fields (for AI education context)
ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS about_text text,
  ADD COLUMN IF NOT EXISTS bio_text   text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams') THEN
    BEGIN
      ALTER TABLE teams ADD COLUMN IF NOT EXISTS bio_text text;
    EXCEPTION WHEN duplicate_column THEN NULL; END;
  END IF;
END$$;

-- 7. Fix the brand_voice_profile schema/code mismatch (code queries these
--    columns; they didn't exist).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='brand_voice_profile') THEN
    BEGIN
      ALTER TABLE brand_voice_profile
        ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES brokerages(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS team_id      uuid REFERENCES teams(id)      ON DELETE SET NULL;
    EXCEPTION WHEN undefined_table THEN NULL; END;
    CREATE INDEX IF NOT EXISTS idx_bv_brokerage ON brand_voice_profile(brokerage_id);
    CREATE INDEX IF NOT EXISTS idx_bv_team      ON brand_voice_profile(team_id);
  END IF;
END$$;

COMMIT;
