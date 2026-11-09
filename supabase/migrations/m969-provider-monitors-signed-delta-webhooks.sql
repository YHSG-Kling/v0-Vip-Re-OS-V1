-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151D ──
--
-- PROVIDER MONITORS — the registry of provider-side monitors (Exa Search Monitors first) that PUSH new results to
-- our signed webhook (app/api/webhooks/exa/route.ts → lib/providers/exa/monitors.ts handleExaWebhookDelivery), so
-- a territory's early-opportunity plays consume monitored DELTAS instead of repeating searches.
--
-- WHY A NEW TABLE (CLAUDE.md §1 — the survivor search, 2026-11-09):
--   · batchdata_smart_search_subscriptions (m633/m635/m637) registers BatchData Smart Search subscriptions: its columns
--     are BatchData-shaped (quicklist, pool_key, pooled, geography_count) and it has no provider column — reusing it for
--     Exa would put a second vendor's ids under a first vendor's name (CLAUDE.md §6, one vocabulary per function).
--   · tenant_webhook_deliveries / the tenant webhook subscriptions are OUTBOUND (we deliver to the tenant's Zap), not a
--     registry of inbound provider monitors.
--   · property_alerts.idx_saved_search_id is a BUYER's IDX saved search, not a provider monitor.
--   · lead_scraping_markets has no jsonb settings column, and a delivery must resolve a monitor id to ONE tenant +
--     territory + play by an indexed lookup, never by scanning every tenant's settings.
--   No survivor holds "a provider's monitor id → the tenant and territory it serves + the sealed secret that verifies
--   its deliveries", so this table is built (orphan doctrine 2).
--
-- WRITER  lib/providers/exa/monitors.ts registerExaMonitor (service client; the tenant is the caller's verified
--         brokerage_id — the lead-scraping territory's owner, never a request body) — INSERT; handleExaWebhookDelivery
--         stamps last_delivery_at / last_delivery_event_id / deliveries after a VERIFIED delivery.
-- READER  handleExaWebhookDelivery (provider + provider_monitor_id → the row that names the tenant, territory, play and
--         the sealed secret); registerExaMonitor (idempotency per tenant × territory × play).
--
-- THE SECRET: Exa returns ONE webhook secret per monitor, once, at creation. It is stored SEALED (lib/security/
-- secret-crypto.ts encryptSecret — AES-256-GCM under SECRETS_ENCRYPTION_KEY; fail-closed: no key → no monitor is
-- created) in webhook_secret_ciphertext and opened only to verify a delivery's signature. secret_env names the env
-- fallback (EXA_WEBHOOK_SECRET) for a monitor created by hand in the provider's dashboard — a NAME, never a value.
--
-- CHECK VOCABULARIES — each has ONE code constant as its source (CLAUDE.md §3, check-vocabulary-guard):
--   provider          → lib/providers/exa/monitors.ts EXA_MONITOR_PROVIDER ('exa' is the only provider today)
--   play_key          → lib/acquisition-plays/contract.ts PLAY_KEYS
--   status            → lib/providers/exa/monitors.ts PROVIDER_MONITOR_STATUSES (Exa's own monitor statuses)
-- FKs: brokerage_id → brokerages (CASCADE — a monitor is the tenant's), market_id → lead_scraping_markets (SET NULL:
--      a deleted territory leaves the row readable so the delivery is acknowledged, not acted on),
--      created_by_user_id → users (SET NULL). users.id, never agents.id (CLAUDE.md §3).
-- After apply: regenerate scripts/schema-snapshot.ts, scripts/check-vocabularies.ts, scripts/live-tables.ts (generated).

CREATE TABLE IF NOT EXISTS public.provider_monitors (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id               uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  market_id                  uuid REFERENCES public.lead_scraping_markets(id) ON DELETE SET NULL,
  provider                   text NOT NULL,
  provider_monitor_id        text NOT NULL,
  play_key                   text NOT NULL,
  status                     text NOT NULL DEFAULT 'active',
  cadence                    text,
  search                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_path               text NOT NULL,
  webhook_secret_ciphertext  text,
  secret_env                 text NOT NULL DEFAULT 'EXA_WEBHOOK_SECRET',
  last_delivery_at           timestamptz,
  last_delivery_event_id     text,
  deliveries                 integer NOT NULL DEFAULT 0,
  created_by_user_id         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_monitors_provider_check
    CHECK (provider IN ('exa')),
  CONSTRAINT provider_monitors_play_key_check
    CHECK (play_key IN ('moving_corridor_radar', 'public_request_assist', 'property_candidate_queue', 'contact_second_window', 'negative_evidence_saver')),
  CONSTRAINT provider_monitors_status_check
    CHECK (status IN ('active', 'paused', 'disabled'))
);

COMMENT ON TABLE public.provider_monitors IS
  'Provider-side monitors (Exa Search Monitors) that push new results to our signed webhook; a delivery resolves (provider, provider_monitor_id) to the tenant, territory and play here — never from the payload. The webhook secret is sealed (secret-crypto); secret_env is a NAME.';

-- A provider's monitor id is unique within that provider (a delivery resolves to exactly one row).
CREATE UNIQUE INDEX IF NOT EXISTS provider_monitors_provider_monitor_uniq
  ON public.provider_monitors (provider, provider_monitor_id);
-- The registration idempotency read (tenant × territory × play, open statuses).
CREATE INDEX IF NOT EXISTS provider_monitors_tenant_market_play_idx
  ON public.provider_monitors (brokerage_id, market_id, play_key, status);

ALTER TABLE public.provider_monitors ENABLE ROW LEVEL SECURITY;

-- Tenant staff read their own monitors (the connections / territory surfaces); writes stay on the service client
-- (registration runs under the territory's verified tenant; the webhook runs sessionless).
DROP POLICY IF EXISTS provider_monitors_tenant_read ON public.provider_monitors;
CREATE POLICY provider_monitors_tenant_read ON public.provider_monitors
  FOR SELECT USING (brokerage_id = public.current_user_brokerage_id());
