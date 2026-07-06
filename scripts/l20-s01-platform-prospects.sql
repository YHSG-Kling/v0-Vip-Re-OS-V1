-- l20-s01-platform-prospects.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PLATFORM SELF-MARKETING — the platform's own top-of-funnel. platform_prospects
-- captures people who raise their hand for VIP Agents itself (distinct from a
-- tenant's contacts). Public capture is idempotent by email; the funnel is worked
-- by the platform marketing role. Idempotent.

CREATE TABLE IF NOT EXISTS public.platform_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  email text NOT NULL UNIQUE,
  company text,
  role_interest text NOT NULL DEFAULT 'unknown'
    CHECK (role_interest = ANY (ARRAY['solo_agent','team','brokerage','multi_location','unknown']::text[])),
  source text NOT NULL DEFAULT 'organic',
  status text NOT NULL DEFAULT 'new'
    CHECK (status = ANY (ARRAY['new','contacted','trial','converted','lost']::text[])),
  interest_note text,
  converted_brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL,
  contacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_prospects_status ON public.platform_prospects(status);
