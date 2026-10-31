-- WRITTEN, NOT APPLIED (wave 147, lane 147B) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m894 — movement_source_items: the POLL-AND-DIFF WATCHER'S LAST-SEEN DIGEST per watched item (wave 147, lane 147B — owner
-- ruling 3; requirement 3: "raises publishSignal on a material change … exactly once per change").
--
-- One row per (brokerage, watched source, item): the digest of the item's MATERIAL fields the last time the watcher saw it. A poll
-- that finds the same digest touches last_seen_at and raises nothing; a different digest is a CHANGE, raised once — the C9 record's
-- idempotency key is the change (`<item>:<digest>:<observed_at>`, lib/intent/movement-source-watcher.ts: a lost item state replays,
-- never re-raises), and the digest is written only AFTER the raise was recorded (a refused raise is retried next tick, never "seen"
-- without being signalled).
-- last_signal_id points at the movement_signals row the last transition produced.
--
-- WHY A NEW TABLE (audited 2026-10-31): the action ledger's idempotency key alone cannot tell "changed" from "new" from "same" (it
-- knows only keys it has seen, not the previous state of an item), and no survivor stores per-item state for a polled source.
-- to_regclass is null live. Requires m892 (the FK below).
--
-- Writer + reader: lib/intent/movement-source-watcher.ts (supabaseWatchStore.loadItems / saveItem). Service-role only — no tenant
-- read (an item digest means nothing to a person; the evidence lives on movement_signals). After applying: regenerate
-- scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts (2 FKs); TABLE_MANAGER 'movement_source_items' ->
-- data_steward (lane 147I).

CREATE TABLE IF NOT EXISTS public.movement_source_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  source_key       text        NOT NULL,
  item_key         text        NOT NULL,
  digest           text        NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_changed_at  timestamptz NULL,
  last_signal_id   uuid        NULL REFERENCES public.movement_signals(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movement_source_items_unique UNIQUE (brokerage_id, source_key, item_key)
);

COMMENT ON TABLE public.movement_source_items IS
  'Wave 147 (147B, ruling 3): the poll-and-diff watcher''s last-seen digest per watched item — a changed digest is one transition, raised once. Writer lib/intent/movement-source-watcher.ts. Service-role only.';

ALTER TABLE public.movement_source_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.movement_source_items FROM authenticated, anon;

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.movement_source_items'::regclass ORDER BY 1;
--   SELECT count(*) FROM pg_policy WHERE polrelid = 'public.movement_source_items'::regclass;   -- 0 (service-role only)
