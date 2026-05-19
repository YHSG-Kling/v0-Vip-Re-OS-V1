-- Migration 1005: Application-code-compat columns
-- Adds columns the application code references but the original schema didn't
-- have. Each ADD COLUMN is IF NOT EXISTS so this is safe to re-run.

-- contacts: metadata for social-DM PSIDs (Meta, Instagram, LinkedIn) +
-- lifecycle_state for journey tracking + user_id for portal account linking +
-- ai_isa_enabled toggle (CRM contact card)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_isa_enabled BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_metadata ON contacts USING GIN (metadata);

-- activities: agent_user_id (who performed it), metadata (structured payload),
-- scheduled_for (time-deferred activities — drip touchpoints, scheduled videos)
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS agent_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_activities_agent_user_id ON activities(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_activities_scheduled_for
  ON activities(scheduled_for) WHERE scheduled_for IS NOT NULL;

-- client_documents: ai_metadata stores compliance scan results +
-- contract extraction output for the Document Center
ALTER TABLE client_documents
  ADD COLUMN IF NOT EXISTS ai_metadata JSONB DEFAULT '{}'::jsonb;

-- agents: photo_url for branded surfaces (home value page header),
-- voice_id + avatar_id for chapter video generation (DID + ElevenLabs)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS photo_url TEXT,
  ADD COLUMN IF NOT EXISTS voice_id TEXT,
  ADD COLUMN IF NOT EXISTS avatar_id TEXT;

-- vendor_marketplace_profiles: revenue_share_percent (platform fee on payouts),
-- api_key (vendor-side API access)
ALTER TABLE vendor_marketplace_profiles
  ADD COLUMN IF NOT EXISTS revenue_share_percent NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS api_key TEXT;

-- users: phone (used by branded home-value page header to surface agent's
-- direct number)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- listings: metadata for tracking auto-creation source + created_via flag +
-- expiration_date + commission_rate (extracted from listing agreement)
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_via TEXT,
  ADD COLUMN IF NOT EXISTS expiration_date DATE,
  ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2);

-- video_projects table — referenced by chapter video generator. Workers
-- consume rows where status='queued' and update them as they progress.
CREATE TABLE IF NOT EXISTS video_projects (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,
  listing_id         UUID REFERENCES listings(id) ON DELETE SET NULL,
  project_type       TEXT,
  title              TEXT,
  script             TEXT,
  script_metadata    JSONB DEFAULT '{}'::jsonb,
  voice_id           TEXT,
  avatar_id          TEXT,
  provider           TEXT,
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','generating','ready','published','failed')),
  duration_seconds   INTEGER,
  output_url         TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_projects_status ON video_projects(status);
CREATE INDEX IF NOT EXISTS idx_video_projects_brokerage ON video_projects(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_video_projects_contact ON video_projects(contact_id);
ALTER TABLE video_projects ENABLE ROW LEVEL SECURITY;
