-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145H ──
--
-- m869 — A TEAM'S REQUIRED-DOCUMENT CHECKLIST FOLLOWS THE TEAM (owner ruling 21, 2026-10-27)
--
-- "Teams required document checklist should follow the team." The adoption rail (lib/kernel/brokerage-transfer.ts)
-- moves a team into an adopting brokerage with the SAME id, and its form packets follow it (wave 144I). Its
-- brokerage_required_documents rules did not: policy stays with the archived source (lane 144I Still open 4).
-- lib/compliance/team-checklist-carry.ts COPIES the team's rules into the adopting brokerage as team rules and leaves
-- the source rows untouched (historical policy evidence — a closed deal's checklist fingerprint names them).
--
-- THIS MIGRATION gives the copy its provenance and makes it idempotent:
--   · carried_from_rule_id — the origin rule (in the source tenant) a carried rule was copied from. ON DELETE SET NULL:
--     the copy is the target's own rule and survives its origin. RLS is unchanged — a member of the target can read
--     the id, never the origin row (brokerage_required_documents RLS pins brokerage_id).
--   · carried_at — when.
--   · brd_carried_once — one copy per (target, scope, team, origin): a re-run of the carry is a counted no-op.
--   · brd_carried_from_rule_idx — the FK's referencing-side index (ON DELETE SET NULL scans it).
--
-- MEASURED BEFORE WRITING (scripts/schema-snapshot.ts, scripts/schema-fk-map.ts, 2026-10-27): brokerage_required_documents
-- has no carried_* column; its FKs are approved_by / created_by → users, brokerage_id → brokerages, template_form_id →
-- brokerage_form_library. Live: 7 rows (lane 144A, 2026-10-25), none team-scoped.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (+2 columns) and scripts/schema-fk-map.ts
-- (brokerage_required_documents.carried_from_rule_id → brokerage_required_documents). No CHECK is added.

ALTER TABLE public.brokerage_required_documents
  ADD COLUMN IF NOT EXISTS carried_from_rule_id uuid REFERENCES public.brokerage_required_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS carried_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS brd_carried_once
  ON public.brokerage_required_documents (brokerage_id, scope_type, scope_id, carried_from_rule_id)
  WHERE carried_from_rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS brd_carried_from_rule_idx
  ON public.brokerage_required_documents (carried_from_rule_id)
  WHERE carried_from_rule_id IS NOT NULL;

COMMENT ON COLUMN public.brokerage_required_documents.carried_from_rule_id IS
  'm869 (owner ruling 21): the origin rule a TEAM rule was copied from when the team joined this brokerage (lib/compliance/team-checklist-carry.ts). The origin row stays in its own tenant as history; this copy can tighten, never loosen, this brokerage''s own rules (lib/compliance/required-documents.ts).';
COMMENT ON COLUMN public.brokerage_required_documents.carried_at IS
  'm869: when the team''s rule was carried into this brokerage.';

-- VERIFY (read-only, after applying):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'brokerage_required_documents' AND column_name IN ('carried_from_rule_id','carried_at');
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'brokerage_required_documents' AND indexname IN ('brd_carried_once','brd_carried_from_rule_idx');
--   SELECT conname, confrelid::regclass FROM pg_constraint WHERE conrelid = 'public.brokerage_required_documents'::regclass AND contype = 'f';
