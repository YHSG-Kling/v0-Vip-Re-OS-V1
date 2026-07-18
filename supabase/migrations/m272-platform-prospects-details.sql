-- m272-platform-prospects-details.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ASSISTED-SALE TOOLKIT — platform_prospects gains a details jsonb column:
--   details.demo_request  → { preferred_times, requested_at } from the public
--                           /demo booking form (source 'demo_request')
--   details.proposal      → the AI-authored per-prospect proposal (sections +
--                           DB-driven recommended tier + generated_at), rendered
--                           on the growth board with copy-to-clipboard.
-- Idempotent.

alter table public.platform_prospects
  add column if not exists details jsonb not null default '{}'::jsonb;

comment on column public.platform_prospects.details is
  'Assisted-sale artifacts: demo_request (preferred times from /demo), proposal (AI-authored proposal doc).';
