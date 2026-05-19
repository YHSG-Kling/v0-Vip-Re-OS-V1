-- Showing / Tour / Saved-Properties — canonical flow alignment
--
-- Aligns the schema to support the actual buyer + listing showing flow:
--
--   1. Buyer (or buyer agent) requests a showing for either:
--        a) An in-house listing → showing_requests.listing_id set
--        b) An external property (Rentcast/IDX/MLS) → listing_id NULL +
--           denormalized property fields + listing-agent contact info
--
--   2. Buyer agent groups showing requests into a Tour:
--        - Provides start_address + start_time
--        - AI computes optimal route, drive times, total duration
--        - AI generates a report with per-stop listing-agent contact info
--        - Report sent to agent (portal + email)
--        - Agent edits/approves → final report sent to buyer (portal + email)
--        - Calendar events created for each confirmed stop
--
--   3. Saved properties (buyer's "interested in" list) can come from
--      brokerage listings OR Rentcast OR the agent's IDX provider OR raw MLS
--      lookup, and we need to track the source.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. SHOWING_REQUESTS — make external-property friendly
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE showing_requests
  ALTER COLUMN listing_id DROP NOT NULL;

ALTER TABLE showing_requests
  ADD COLUMN IF NOT EXISTS property_address     TEXT,
  ADD COLUMN IF NOT EXISTS property_city        TEXT,
  ADD COLUMN IF NOT EXISTS property_state       TEXT,
  ADD COLUMN IF NOT EXISTS property_zip         TEXT,
  ADD COLUMN IF NOT EXISTS mls_number           TEXT,
  ADD COLUMN IF NOT EXISTS list_price           NUMERIC,
  ADD COLUMN IF NOT EXISTS primary_photo_url    TEXT,
  ADD COLUMN IF NOT EXISTS listing_agent_name   TEXT,
  ADD COLUMN IF NOT EXISTS listing_agent_phone  TEXT,
  ADD COLUMN IF NOT EXISTS listing_agent_email  TEXT,
  ADD COLUMN IF NOT EXISTS listing_agent_company TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT
    CHECK (source IN ('buyer_portal','agent_input','tour_planner','message','external_agent') OR source IS NULL),
  ADD COLUMN IF NOT EXISTS saved_property_id    UUID REFERENCES saved_properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tour_id              UUID REFERENCES tours(id) ON DELETE SET NULL;

-- Sanity check: at least one of (listing_id, property_address) must be set
ALTER TABLE showing_requests
  ADD CONSTRAINT showing_requests_has_property_check
  CHECK (listing_id IS NOT NULL OR property_address IS NOT NULL)
  NOT VALID;

CREATE INDEX IF NOT EXISTS idx_showing_requests_tour ON showing_requests(tour_id) WHERE tour_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_showing_requests_saved ON showing_requests(saved_property_id) WHERE saved_property_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. TOURS — add start address, start time, totals, approval, report send
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE tours
  ADD COLUMN IF NOT EXISTS start_address              TEXT,
  ADD COLUMN IF NOT EXISTS start_time                 TIME,
  ADD COLUMN IF NOT EXISTS total_duration_minutes     INTEGER,
  ADD COLUMN IF NOT EXISTS total_drive_time_minutes   INTEGER,
  ADD COLUMN IF NOT EXISTS agent_approved_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_approved_by          UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS report_sent_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS report_sent_via            TEXT[],
  ADD COLUMN IF NOT EXISTS report_url                 TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. SAVED_PROPERTIES — track source (brokerage / rentcast / idx / mls)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE saved_properties
  ADD COLUMN IF NOT EXISTS source TEXT
    CHECK (source IN ('brokerage_listing','rentcast','idx','mls','manual') OR source IS NULL),
  ADD COLUMN IF NOT EXISTS external_property_id  TEXT,
  ADD COLUMN IF NOT EXISTS listing_url           TEXT;

-- Backfill: rows that have a listing_id are brokerage listings.
UPDATE saved_properties
   SET source = 'brokerage_listing'
 WHERE source IS NULL AND listing_id IS NOT NULL;

-- Rows without a listing_id but with a property_address are external — leave
-- source NULL until the writer attributes it. Don't guess.
