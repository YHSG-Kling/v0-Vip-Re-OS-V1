-- ============================================================================
-- Sprint 7 — Knowledge & Growth Router
-- ============================================================================
--
-- The 91 tables across education / marketing / onboarding are siloed. This
-- migration adds the kernel substrate that composes them into one
-- continuous, persona+stage+generational-cohort+performance-routed stream
-- per actor (agent / TC / compliance_officer / team_lead / customer).
--
-- Three changes:
--   1. Add 'team_lead' to users.user_type CHECK so we can route to that
--      role (currently allowed: broker / admin / agent / vendor / lender /
--      TC / compliance_officer / contact).
--   2. Create learning_modules — the canonical, multi-channel-ready record.
--      One row authored by a broker/admin/agent. The publisher fans it out
--      to any subset of (article / video / podcast / newsletter / blog /
--      quiz) channels.
--   3. Create learning_module_channel_publications — maps module → channel
--      → external row id. Keeps schema additive (no edits to the 10 child
--      tables) and lets the router know what was actually published where.
--   4. Create learning_assignments — per-actor next-best-item with source
--      signal (which gap drove this assignment).
--
-- The customer-side kernel (lib/portal/resolve-education-context.ts) is
-- unchanged at the schema layer — generational_cohort is derived from
-- contacts.date_of_birth, not stored. ageSeg already lives there.
-- ============================================================================

BEGIN;

-- 1. Add team_lead to user_type CHECK ----------------------------------------
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_user_type_check;
ALTER TABLE users
  ADD CONSTRAINT users_user_type_check
  CHECK (user_type = ANY (ARRAY[
    'broker','admin','agent','vendor','lender','TC',
    'compliance_officer','contact',
    'team_lead'      -- added Sprint 7
  ]));

-- 2. learning_modules --------------------------------------------------------
-- Canonical authoring record. One row authored once, published to N channels.
CREATE TABLE IF NOT EXISTS learning_modules (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id         uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  team_id              uuid        REFERENCES teams(id)               ON DELETE SET NULL,
  authored_by          uuid        REFERENCES users(id)               ON DELETE SET NULL,

  -- Core content
  title                text        NOT NULL,
  summary              text,
  body                 text,                          -- markdown body
  cover_image_url      text,
  estimated_minutes    int,

  -- Audience routing (intersect against actor context in code)
  -- Examples: 'agent','tc','compliance_officer','team_lead','customer',
  -- persona values ('first_time_buyer','investor','downsizer','expired','fsbo'…),
  -- generational ('gen_z','millennial','gen_x','boomer','silent'),
  -- age_seg ('18-30','30-50','50-65','65+').
  -- Empty array = show to everyone.
  audience_roles       text[]      NOT NULL DEFAULT '{}'::text[],
  audience_personas    text[]      NOT NULL DEFAULT '{}'::text[],
  audience_generations text[]      NOT NULL DEFAULT '{}'::text[],
  audience_age_segs    text[]      NOT NULL DEFAULT '{}'::text[],

  -- Stage routing (matches buyer_stage / portal_view / lifecycle / milestone)
  stage_tags           text[]      NOT NULL DEFAULT '{}'::text[],

  -- Performance-gap routing (for agents): which gaps does this module address?
  -- Examples: 'low_close_rate','long_dom','missed_repair_copilot',
  -- 'no_sphere_touchpoints','low_ai_isa_adoption'.
  gap_tags             text[]      NOT NULL DEFAULT '{}'::text[],

  -- Publishing
  status               text        NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','published','archived')),
  published_at         timestamptz,

  -- Available channels — which the author intends to publish to
  channels             text[]      NOT NULL DEFAULT '{}'::text[],
  /* channels values: 'article' / 'video' / 'podcast' / 'newsletter' /
     'blog' / 'quiz' / 'email' / 'social' */

  -- Quiz attached?
  quiz_questions       jsonb,                         -- [{q, choices[], correct_idx, explainer}]

  display_priority     int         NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lm_brokerage_status
  ON learning_modules(brokerage_id, status, display_priority DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_lm_audience_roles ON learning_modules USING gin(audience_roles);
CREATE INDEX IF NOT EXISTS idx_lm_audience_personas ON learning_modules USING gin(audience_personas);
CREATE INDEX IF NOT EXISTS idx_lm_audience_generations ON learning_modules USING gin(audience_generations);
CREATE INDEX IF NOT EXISTS idx_lm_audience_age_segs ON learning_modules USING gin(audience_age_segs);
CREATE INDEX IF NOT EXISTS idx_lm_stage_tags ON learning_modules USING gin(stage_tags);
CREATE INDEX IF NOT EXISTS idx_lm_gap_tags ON learning_modules USING gin(gap_tags);
CREATE INDEX IF NOT EXISTS idx_lm_channels ON learning_modules USING gin(channels);

ALTER TABLE learning_modules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lm_service_all ON learning_modules;
CREATE POLICY lm_service_all ON learning_modules FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS lm_tenant_select ON learning_modules;
CREATE POLICY lm_tenant_select ON learning_modules FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS lm_admin_write ON learning_modules;
CREATE POLICY lm_admin_write ON learning_modules FOR ALL
  USING (brokerage_id = current_user_brokerage_id()
         AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'))
  WITH CHECK (brokerage_id = current_user_brokerage_id()
              AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'));

-- 3. learning_module_channel_publications -----------------------------------
-- Maps a module to its fan-out per channel. The publisher writes one row
-- per channel-target combination. external_id points back to the child
-- table's row (training_videos.id / knowledge_articles.id / etc.).
CREATE TABLE IF NOT EXISTS learning_module_channel_publications (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id            uuid        NOT NULL REFERENCES learning_modules(id) ON DELETE CASCADE,
  brokerage_id         uuid        NOT NULL REFERENCES brokerages(id)       ON DELETE CASCADE,
  channel              text        NOT NULL CHECK (channel IN (
                                     'article','video','podcast','newsletter',
                                     'blog','quiz','email','social','portal_lesson'
                                   )),
  external_id          uuid,                       -- FK into the channel-specific table
  external_table       text,                       -- which table external_id refers to
  external_url         text,                       -- public consumption link
  status               text        NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','published','failed','revoked')),
  error_message        text,
  published_at         timestamptz,
  metrics              jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- views / completions / engagement
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE(module_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_lmcp_module ON learning_module_channel_publications(module_id);
CREATE INDEX IF NOT EXISTS idx_lmcp_brokerage_channel
  ON learning_module_channel_publications(brokerage_id, channel, status);

ALTER TABLE learning_module_channel_publications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lmcp_service_all ON learning_module_channel_publications;
CREATE POLICY lmcp_service_all ON learning_module_channel_publications FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS lmcp_tenant_select ON learning_module_channel_publications;
CREATE POLICY lmcp_tenant_select ON learning_module_channel_publications FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

-- 4. learning_assignments ----------------------------------------------------
-- Per-actor next-best-item with source signal that drove the assignment.
-- One row = "this actor should learn this module next, because of X gap".
-- Resolved into UI cards on the agent dashboard / customer portal feed.
CREATE TABLE IF NOT EXISTS learning_assignments (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id         uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  module_id            uuid        NOT NULL REFERENCES learning_modules(id) ON DELETE CASCADE,

  -- Exactly ONE of these is set per row
  agent_user_id        uuid        REFERENCES users(id)    ON DELETE CASCADE,
  staff_user_id        uuid        REFERENCES users(id)    ON DELETE CASCADE,
  contact_id           uuid        REFERENCES contacts(id) ON DELETE CASCADE,

  -- Why this assignment surfaced (drives UI explainer + analytics)
  signal_source        text        NOT NULL,    -- 'gap:low_close_rate' / 'milestone:inspection_scheduled' / 'persona:first_time_buyer' / 'cohort:millennial' / 'onboarding:day_30' / etc.
  signal_metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  priority_score       int         NOT NULL DEFAULT 50,
  due_at               timestamptz,                       -- when this matters by

  -- Outcome
  status               text        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','viewed','completed','dismissed','superseded')),
  viewed_at            timestamptz,
  completed_at         timestamptz,
  dismissed_at         timestamptz,
  quiz_score           int,                               -- 0..100 if module had a quiz

  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Exactly-one-target constraint
  CONSTRAINT la_one_target_only CHECK (
    (CASE WHEN agent_user_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN staff_user_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN contact_id    IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_la_agent_open
  ON learning_assignments(agent_user_id, status, priority_score DESC)
  WHERE agent_user_id IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_la_staff_open
  ON learning_assignments(staff_user_id, status, priority_score DESC)
  WHERE staff_user_id IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_la_contact_open
  ON learning_assignments(contact_id, status, priority_score DESC)
  WHERE contact_id IS NOT NULL AND status = 'open';

ALTER TABLE learning_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS la_service_all ON learning_assignments;
CREATE POLICY la_service_all ON learning_assignments FOR ALL USING (true) WITH CHECK (true);

-- Agents see their own assignments. Staff (TC/compliance/team_lead) see theirs.
-- Customers see theirs through the portal contact identity (contacts.user_id).
DROP POLICY IF EXISTS la_agent_self ON learning_assignments;
CREATE POLICY la_agent_self ON learning_assignments FOR SELECT
  USING (
    (agent_user_id = auth.uid()) OR
    (staff_user_id = auth.uid()) OR
    (contact_id IN (SELECT id FROM contacts WHERE user_id = auth.uid())) OR
    -- broker/admin can see all in their brokerage
    (brokerage_id = current_user_brokerage_id()
       AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'))
  );

DROP POLICY IF EXISTS la_self_update ON learning_assignments;
CREATE POLICY la_self_update ON learning_assignments FOR UPDATE
  USING (
    (agent_user_id = auth.uid()) OR
    (staff_user_id = auth.uid()) OR
    (contact_id IN (SELECT id FROM contacts WHERE user_id = auth.uid()))
  );

COMMIT;
