-- ============================================================================
-- Migration 1027 — Workflow OS schema reconciliation
--
-- Companion to 1026. Adds tables + columns the Sprint A-E adapters require
-- that were missing from the actual production schema (audited via MCP).
--
-- Scope:
--   1. NEW TABLES owned by the Workflow OS:
--        - workflow_webhook_events  (Sprint E webhook entry log)
--        - listing_landing_pages    (Sprint C landing page generation)
--        - buyer_tours              (Sprint A schedule_tour adapter)
--        - newsletter_sends         (Sprint C per-contact newsletter queue)
--        - newsletter_templates     (referenced by newsletter adapter + UI)
--        - documents                (referenced by draft_document, avm_cma)
--   2. EXTENDED existing tables — add columns the adapters write:
--        - tasks            +source +source_enrollment_id +assignee_type
--        - sequence_enrollments +trigger_metadata
--        - brokerages       +did_avatar_url +did_actor_id
--        - listings         +listing_agent_email +listing_agent_name
--                           (only if not already populated via join)
--   3. NO destructive changes — every ALTER uses IF NOT EXISTS / IF NOT EXISTS.
--
-- This migration is idempotent and safe to re-run.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. NEW TABLE — workflow_webhook_events
--    Logs every external trigger fired through /api/workflow/trigger.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_webhook_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid        REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id    uuid        REFERENCES contacts(id)   ON DELETE SET NULL,
  event_type    text        NOT NULL,
  source        text        NOT NULL,                 -- 'ghl' | 'idx' | 'qr' | 'email_provider' | 'webhook'
  payload       jsonb       NOT NULL DEFAULT '{}',
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_webhook_events_brokerage_event
  ON workflow_webhook_events(brokerage_id, event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_webhook_events_contact
  ON workflow_webhook_events(contact_id);

ALTER TABLE workflow_webhook_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='workflow_webhook_events' AND policyname='service_role_workflow_webhook_events') THEN
    CREATE POLICY "service_role_workflow_webhook_events"
      ON workflow_webhook_events FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. NEW TABLE — listing_landing_pages
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listing_landing_pages (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id    uuid        REFERENCES contacts(id)  ON DELETE SET NULL,
  listing_id    uuid        REFERENCES listings(id)  ON DELETE SET NULL,
  template_id   uuid,
  slug          text        UNIQUE NOT NULL,
  content       jsonb       NOT NULL DEFAULT '{}',   -- { headline, subheadline, body }
  status        text        NOT NULL DEFAULT 'draft' -- 'draft' | 'published' | 'archived'
                CHECK (status IN ('draft','published','pending','archived')),
  view_count    integer     NOT NULL DEFAULT 0,
  lead_count    integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_landing_pages_slug ON listing_landing_pages(slug);
CREATE INDEX IF NOT EXISTS idx_listing_landing_pages_brokerage ON listing_landing_pages(brokerage_id);

ALTER TABLE listing_landing_pages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='listing_landing_pages' AND policyname='service_role_listing_landing_pages') THEN
    CREATE POLICY "service_role_listing_landing_pages"
      ON listing_landing_pages FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. NEW TABLE — buyer_tours
--    Multi-stop property tours scheduled for buyer contacts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS buyer_tours (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id      uuid        REFERENCES contacts(id)            ON DELETE SET NULL,
  agent_id        uuid        REFERENCES agents(id)              ON DELETE SET NULL,
  tour_date       timestamptz NOT NULL,
  start_address   text,
  property_ids    uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  stop_count      integer     NOT NULL DEFAULT 0,
  status          text        NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  source          text,                                          -- 'workflow_sequence' | 'manual'
  route_summary   jsonb,                                          -- optimized stops + drive times
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buyer_tours_contact ON buyer_tours(contact_id);
CREATE INDEX IF NOT EXISTS idx_buyer_tours_brokerage ON buyer_tours(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_buyer_tours_date ON buyer_tours(tour_date);

ALTER TABLE buyer_tours ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='buyer_tours' AND policyname='service_role_buyer_tours') THEN
    CREATE POLICY "service_role_buyer_tours"
      ON buyer_tours FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. NEW TABLE — newsletter_sends
--    Per-contact newsletter delivery records (separate from campaign-wide sends).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS newsletter_sends (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id    uuid        NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  template_id   uuid,
  campaign_id   uuid,                              -- optional link to newsletter_campaigns
  subject       text        NOT NULL,
  status        text        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sent','failed','bounced','opened','clicked')),
  provider_message_id text,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  opened_at     timestamptz,
  clicked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_newsletter_sends_contact ON newsletter_sends(contact_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_brokerage_status ON newsletter_sends(brokerage_id, status);

ALTER TABLE newsletter_sends ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='newsletter_sends' AND policyname='service_role_newsletter_sends') THEN
    CREATE POLICY "service_role_newsletter_sends"
      ON newsletter_sends FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. NEW TABLE — newsletter_templates
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS newsletter_templates (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid        REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id      uuid        REFERENCES agents(id)     ON DELETE SET NULL,
  team_id       uuid,
  name          text        NOT NULL,
  subject_line  text,
  preheader_text text,
  content       jsonb       NOT NULL DEFAULT '{}',   -- ordered sections
  scope         text        NOT NULL DEFAULT 'agent' -- 'brokerage' | 'team' | 'agent'
                CHECK (scope IN ('brokerage','team','agent')),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_templates_brokerage ON newsletter_templates(brokerage_id);

ALTER TABLE newsletter_templates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='newsletter_templates' AND policyname='service_role_newsletter_templates') THEN
    CREATE POLICY "service_role_newsletter_templates"
      ON newsletter_templates FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. NEW TABLE — documents
--    Generic document storage referenced by draft_document, avm_cma, and the
--    Document Center UI. Distinct from existing transaction_documents (which
--    is transaction-scoped) and from contract-specific tables.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id      uuid        REFERENCES contacts(id)            ON DELETE SET NULL,
  transaction_id  uuid        REFERENCES transactions(id)        ON DELETE SET NULL,
  listing_id      uuid        REFERENCES listings(id)            ON DELETE SET NULL,
  template_id     uuid,
  document_type   text        NOT NULL,
  status          text        NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','draft_ready','generating','review','complete','archived')),
  content         text,                                          -- AI-drafted body
  storage_url     text,                                          -- Vercel Blob URL when finalized
  state_code      text,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_brokerage_type ON documents(brokerage_id, document_type);
CREATE INDEX IF NOT EXISTS idx_documents_contact ON documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_documents_transaction ON documents(transaction_id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='documents' AND policyname='service_role_documents') THEN
    CREATE POLICY "service_role_documents"
      ON documents FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. EXTEND tasks — add Workflow OS provenance + assignee role columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source                text,    -- 'workflow_sequence' | 'manual' | 'kernel_event' | etc.
  ADD COLUMN IF NOT EXISTS source_enrollment_id  uuid,
  ADD COLUMN IF NOT EXISTS assignee_type         text;    -- 'agent' | 'tc' | 'lender' | 'vendor' | 'compliance_officer' | 'staff'

CREATE INDEX IF NOT EXISTS idx_tasks_source_enrollment ON tasks(source_enrollment_id) WHERE source_enrollment_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. EXTEND sequence_enrollments — trigger metadata for webhook origin tracing
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS trigger_metadata jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. EXTEND brokerages — D-ID default presenter config
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS did_avatar_url  text,
  ADD COLUMN IF NOT EXISTS did_actor_id    text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. EXTEND listings — listing_agent contact info for showing requests
--     (only used as a fallback when the agent join can't be resolved)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS listing_agent_email text,
  ADD COLUMN IF NOT EXISTS listing_agent_name  text;

COMMIT;
