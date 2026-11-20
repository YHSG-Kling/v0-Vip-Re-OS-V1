-- ── APPLIED LIVE 2026-11-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, integrator (orphaned-children OC1) ──
--
-- document_field_extractions.verified_by_user_id (uuid) was created without the FOREIGN KEY its name promises: the
-- orphaned-children census (OC1 — "add the FOREIGN KEY the database was never given") caught it at the wave-150
-- integration. The verifier is a users.id (never agents.id — CLAUDE.md §3). ON DELETE SET NULL: a verifier who leaves
-- does not unverify the extraction; the fact that a person verified it stays, the pointer clears.
-- Verified live before apply: 0 rows, 0 non-null verifiers, 0 dangling values.

ALTER TABLE public.document_field_extractions
  ADD CONSTRAINT document_field_extractions_verified_by_user_id_fkey
  FOREIGN KEY (verified_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.document_field_extractions.verified_by_user_id IS
  'users.id of the person who verified the extracted field (m994 adds the FK the column was created without).';

-- Read-back:
--   SELECT conname, confrelid::regclass FROM pg_constraint WHERE conname = 'document_field_extractions_verified_by_user_id_fkey';  -- expect 1 row → users
