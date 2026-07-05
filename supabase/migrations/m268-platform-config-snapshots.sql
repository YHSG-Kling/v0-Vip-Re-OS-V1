-- m268-platform-config-snapshots.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- TENANT CONFIG SNAPSHOTS (GoHighLevel-style templates). Platform staff capture a
-- tenant's CONFIG — branding (colors/font/logo/typography), brand voice, and feature
-- enablement — as a reusable template, then apply it to new/selected tenants in one
-- click. Turns the control plane into a repeatable onboarding engine: spin up a fully
-- branded, entitled brokerage instantly.
--
-- SECURITY: a snapshot is a BRAND/CONFIG template, NEVER a credential transfer. The
-- capture layer uses explicit field allow-lists (lib/platform/config-snapshots.ts) so
-- secrets (smtp_password, *_api_key, from_email…) can never be copied between tenants.

create table if not exists public.platform_config_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  source_brokerage_id uuid references public.brokerages(id) on delete set null,
  captured_by         uuid not null references public.users(id),
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Platform-sensitive templates: RLS on, no policies → service-role (staff actions) only.
alter table public.platform_config_snapshots enable row level security;
