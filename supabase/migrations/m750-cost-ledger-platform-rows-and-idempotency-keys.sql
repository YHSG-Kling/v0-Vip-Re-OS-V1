-- ── APPLIED LIVE 2026-10-08 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m750 — COST / USAGE COMPLETENESS: platform rows on the vendor ledger + one charge per idempotency key
-- (wave 139, lane 139C). Owner (wave 139): "Scraping, behaviour monitoring, social/brand listening and
-- other operational intelligence are PLATFORM-COVERED parts of the SaaS (never charged to the tenant
-- separately); they still book usage/cost on the platform ledger." … "PROOFS: paid calls book once; a
-- retry cannot double-book."
--
-- SURVIVORS (no new table, no new column — LAW 1/2):
--   · vendor_usage_tracking — THE platform vendor ledger (lib/vendor-governance/usage-logger.ts
--     logVendorUsage, the one writer; meterVendorSpend the one gateway). Live (measured 2026-10-08):
--     0 rows, brokerage_id NOT NULL, no unique key beyond the PK, request_metadata jsonb.
--   · ai_tool_usage — the AI cost ledger (CLAUDE.md §5). m668 already gave it platform rows; its
--     context_json is TEXT holding compact JSON (23 rows, all JSON, none keyed — measured 2026-10-08).
--
-- WHAT THE CODE NEEDS (and how it degrades until this is applied):
--   PART 1 — a TENANT-LESS vendor row is legal only as a DECLARED platform row: brokerage_id becomes
--     nullable and a CHECK requires request_metadata.platform_paid = true when it is NULL (the flag
--     rides the jsonb the writer already stamps — no column, so no schema-cache change). Tenant rows
--     write unchanged before AND after; a platform row before this is applied is refused (23502) and
--     logVendorUsage RETURNS the refusal (never swallowed). Readers: usage-logger.ts's idempotency and
--     replay lookups pin platform rows with `.is('brokerage_id', null).eq('request_metadata->>platform_paid','true')`.
--   PART 2 — the idempotency keys the two writers already stamp (request_metadata.idempotency_key,
--     context_json.idempotency_key) become UNIQUE per tenant (or per platform). The writers look the key
--     up first; the index is what makes "a retry cannot double-book" hold under a RACE — the second
--     insert gets 23505, which both writers read as "already booked", not as a failure. Partial: rows
--     without a key are untouched (the replay fingerprint still covers vendor rows).
--
-- Apply ONE statement per execute_sql call (wave 108 lesson); PART 1 before PART 2.

-- ── PART 1: platform rows (vendor_usage_tracking) ───────────────────────────────────────────────
ALTER TABLE public.vendor_usage_tracking
  ALTER COLUMN brokerage_id DROP NOT NULL;

ALTER TABLE public.vendor_usage_tracking
  DROP CONSTRAINT IF EXISTS vendor_usage_tracking_platform_rows_are_declared,
  ADD CONSTRAINT vendor_usage_tracking_platform_rows_are_declared
    -- COALESCE: a CHECK that evaluates to NULL PASSES — a missing flag must read as false, not unknown.
    CHECK (brokerage_id IS NOT NULL OR COALESCE((request_metadata ->> 'platform_paid') = 'true', false));

-- ── PART 2: one charge per idempotency key (both ledgers) ────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS vendor_usage_tracking_idempotency_key_uq
  ON public.vendor_usage_tracking (COALESCE(brokerage_id::text, 'platform'), (request_metadata ->> 'idempotency_key'))
  WHERE request_metadata ? 'idempotency_key';

-- context_json is TEXT: the cast is IMMUTABLE (jsonb_in, provolatile 'i' — checked live) and the
-- partial predicate limits it to keyed rows, so a non-JSON legacy row can never break the build.
CREATE UNIQUE INDEX IF NOT EXISTS ai_tool_usage_idempotency_key_uq
  ON public.ai_tool_usage (COALESCE(brokerage_id::text, 'platform'), ((context_json::jsonb) ->> 'idempotency_key'))
  WHERE context_json LIKE '%"idempotency_key"%';
