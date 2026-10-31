-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m736 — TENANT OUTBOUND WEBHOOKS: secret rotation overlap, per-attempt delivery ledger,
-- consecutive-failure auto-disable, and the DB half of delivery idempotency (wave 137B).
--
-- Survivor extended (no new table): tenant_webhook_subscriptions / tenant_webhook_deliveries,
-- written by lib/platform/tenant-webhooks.ts (the drain) and app/actions/tenant-webhooks.ts
-- (the tenant-admin door). Every new column is read and written by that code in a SEPARATE,
-- error-read query, so the rail keeps delivering before this file is applied (degraded:
-- single-secret, no attempt log, no auto-disable); rotateWebhookSecret REFUSES until it is.
--
-- Two parts (apply in order). Part 2 builds a UNIQUE index — if it fails on existing duplicate
-- rows, run the pre-check below, resolve, and re-run part 2:
--   SELECT subscription_id, event_type, payload->>'id' AS event_id, count(*)
--     FROM public.tenant_webhook_deliveries
--    GROUP BY 1, 2, 3 HAVING count(*) > 1;

-- ── Part 1 — columns ──────────────────────────────────────────────────────────

ALTER TABLE public.tenant_webhook_subscriptions
  ADD COLUMN IF NOT EXISTS consecutive_failures       integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS previous_secret            text,
  ADD COLUMN IF NOT EXISTS previous_secret_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS secret_rotated_at          timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_at                timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_reason            text;

COMMENT ON COLUMN public.tenant_webhook_subscriptions.consecutive_failures IS
  'Consecutive DEAD deliveries with no 2xx in between (reset on success / resume). The drain auto-disables at WEBHOOK_AUTO_DISABLE_CONSECUTIVE_DEAD with no success in the quiet window (lib/platform/tenant-webhooks-core.ts shouldAutoDisableWebhook).';
COMMENT ON COLUMN public.tenant_webhook_subscriptions.previous_secret IS
  'The signing secret before the last rotation. Still signs (second v1=) and authorises the inbound trigger door until previous_secret_expires_at (activeWebhookSecrets).';
COMMENT ON COLUMN public.tenant_webhook_subscriptions.disabled_reason IS
  'Why the subscription is off: "auto: …" when the drain switched it off (evidence: agent_action_ledger action webhook.subscription.auto_disable + lifecycle_events webhook_subscription_auto_disabled), or "paused by tenant admin".';

ALTER TABLE public.tenant_webhook_deliveries
  ADD COLUMN IF NOT EXISTS attempt_log jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.tenant_webhook_deliveries.attempt_log IS
  'Per-attempt delivery ledger: [{attempt, at, outcome, http_status, duration_ms, error, idempotency_key}], newest 20 kept (appendWebhookAttempt).';

-- ── Part 2 — idempotency, enforced by the database ───────────────────────────
-- One delivery per (subscription, external event, internal event id). The application dedupes by
-- read first (planWebhookEnqueue); this index closes the race between two concurrent enqueues —
-- the loser gets 23505 and counts it as a refused duplicate.

CREATE UNIQUE INDEX IF NOT EXISTS tenant_webhook_deliveries_idempotency_uidx
  ON public.tenant_webhook_deliveries (subscription_id, event_type, ((payload->>'id')));
