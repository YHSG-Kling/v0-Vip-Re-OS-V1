-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m741 — A REAL LAST-VISIT TIMESTAMP (wave 137, lane 137F). Owner ("approve all", wave 108 items):
-- "a real last-visit timestamp column + writer is approved". Lane 108D's exceptions-first interface read
-- "since your last visit" as the viewer's LAST LEDGER ACTION (a proxy); this column is the real thing.
--
-- Code (already written, depends on THIS migration):
--   · WRITER lib/kernel/exceptions-first.ts recordDashboardVisit — called by
--     app/dashboard/admin/command-center/page.tsx with the SESSION user (users.id = auth uid), tenant-pinned,
--     AFTER loadCommandCenter has read the previous visit; `.select()` counts the one row.
--   · READER lib/kernel/exceptions-first.ts loadExceptionsFirst — reads users.last_dashboard_visit_at for the
--     viewer first (window source "last_visit"); before the first visit, or while this migration is NOT
--     applied (the read is refused → logged), it falls back to the ledger proxy (source "last_action").
--     Nothing breaks before the apply; the page's write is refused and logged.
--
-- Narrowest table: public.users — one row per seat, the row the session already resolves (no per-user
-- settings table carries every seat: user_profiles is optional per user).
--
-- No CHECK is added (no vocabulary cache to regenerate). After the apply, regenerate the schema caches
-- (scripts/schema-snapshot.ts) so the column is known to the schema guards.
--
-- PART 1 (column) — additive, nullable, idempotent; no row changes.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_dashboard_visit_at timestamptz;

COMMENT ON COLUMN public.users.last_dashboard_visit_at IS
  'Last Command Center (dashboard) visit by this user — written by lib/kernel/exceptions-first.ts recordDashboardVisit from the session; read as "since your last visit" (wave 137, m741).';

-- PART 2 (indexes / triggers) — none: the column is read by primary key (users.id) only.
