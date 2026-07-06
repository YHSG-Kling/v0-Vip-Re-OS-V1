-- l21-s02-platform-social-drafts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PLATFORM SOCIAL SELF-MARKETING — the platform's own gated content pipeline for
-- marketing VIP Agents on the company channels. Tenant social is brokerage-scoped
-- (social_media_accounts.brokerage_id NOT NULL), so product content lives here.
-- draft → approved → posted (permalink recorded); worked by the marketing role.

CREATE TABLE IF NOT EXISTS public.platform_social_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel = ANY (ARRAY['linkedin','instagram','facebook','x']::text[])),
  angle text NOT NULL,
  content text NOT NULL,
  hashtags text,
  status text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY['draft','approved','posted','discarded']::text[])),
  scheduled_for date,
  permalink text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
