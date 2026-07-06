-- l18-s01-plan-catalog-columns.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Make subscription_tiers the single source of truth for tier COPY (not just price):
-- a blurb, marketing bullets, and a highlight flag, edited by superadmin from
-- /dashboard/superadmin/plans. Signup reads these; nothing is hardcoded.
-- Idempotent + safe. (`features` jsonb stays the feature-FLAG map; marketing_bullets
-- is the separate display list.)

ALTER TABLE public.subscription_tiers ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.subscription_tiers ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.subscription_tiers ADD COLUMN IF NOT EXISTS marketing_bullets JSONB NOT NULL DEFAULT '[]'::jsonb;
