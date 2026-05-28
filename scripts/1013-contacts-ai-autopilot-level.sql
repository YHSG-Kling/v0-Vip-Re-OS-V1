-- Unified AI Pilot — single source of truth for contact AI engagement.
--
-- Replaces the split between contacts.ai_isa_enabled (boolean) and the
-- ai_autopilot_plans table that never reliably synced. Going forward:
--   - Off          → no AI activity
--   - Conservative → light cadence, agent-approved nurture only
--   - Moderate     → standard nurture + reply drafts
--   - Aggressive   → full autopilot incl. AI ISA outreach
--
-- ai_isa_enabled is now derived (level != 'off') for legacy callers.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ai_autopilot_level TEXT
    NOT NULL DEFAULT 'off'
    CHECK (ai_autopilot_level IN ('off','conservative','moderate','aggressive'));

CREATE INDEX IF NOT EXISTS idx_contacts_ai_autopilot_level
  ON contacts(ai_autopilot_level)
  WHERE ai_autopilot_level <> 'off';

-- Backfill: any contact with the legacy boolean ON gets 'moderate' level
UPDATE contacts
   SET ai_autopilot_level = 'moderate'
 WHERE ai_isa_enabled = true
   AND ai_autopilot_level = 'off';
