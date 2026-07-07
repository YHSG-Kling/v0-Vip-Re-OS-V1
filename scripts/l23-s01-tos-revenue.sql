-- l23-s01-tos-revenue.sql — ToS acceptance tracking (who accepted which terms
-- version, when, from where) + the current version on the platform singleton.
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS tos_version text NOT NULL DEFAULT '2026-07-01';
CREATE TABLE IF NOT EXISTS public.platform_tos_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  tos_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  UNIQUE (email, tos_version)
);
