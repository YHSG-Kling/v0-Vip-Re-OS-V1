-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148C ──
--
-- m914 — protected_research_attributes: EVERY read is audited with its purpose (owner ruling 1, 2026-11-01).
--
-- OWNER, verbatim: "The admin, platform, agent, team lead, broker, compliance, support, etc. should be able to read." The spec's
-- reading of it: tenant-bound, least privilege, data rights, and an AUDITED PURPOSE PER READ.
--
-- WHAT m864 LEFT: one SELECT policy for `authenticated` — platform staff or a same-tenant compliance_officer may SELECT the table
-- DIRECTLY with their session client. Such a read carries no purpose, no role-class decision, no data-rights or field
-- minimisation, and leaves no ledger row: "nobody recorded why" renders as "nobody read". Widening that policy to the roles the
-- owner named would multiply the unaudited path; the ruling is served the other way round.
--
-- THE ONE READ PATH (lane 148C): lib/enrichment/protected-research-store.ts readProtectedAttributes — the role × purpose matrix
-- (PROTECTED_READ_MATRIX), the session-tenant binding, the assigned / team / tenant / platform scope, data rights and field
-- minimisation per purpose, and `research.protected_attribute.read|refuse` on the action ledger for BOTH outcomes. It runs on the
-- service client after the caller's session gate (the named doors: the right-to-know export, the contact-card door
-- app/actions/contact-persona.ts, and the persona study lib/contacts/persona-builder.ts).
--
-- THIS MIGRATION: retires the direct SELECT policy and the authenticated SELECT grant. RLS stays ENABLED (service role bypasses
-- it; every other role reads nothing directly). No product code reads the table with a session client — the firewall census
-- (scripts/lifetime-signals-guard.ts, scripts/canaries/wave145-signals.ts) holds that only the store names the table.
-- A security CHANGE in the TIGHTENING direction; recorded for the owner's review in the lane notes. Reversible: re-run m864's
-- GRANT + CREATE POLICY block.

DROP POLICY IF EXISTS protected_research_attributes_research_read ON public.protected_research_attributes;
REVOKE SELECT ON public.protected_research_attributes FROM authenticated;

COMMENT ON TABLE public.protected_research_attributes IS
  'Research-only protected attributes (m864). READ ONLY through lib/enrichment/protected-research-store.ts readProtectedAttributes (role x purpose x scope, ledgered both ways — m914, wave 148C); service-role writes only.';

-- VERIFY (after apply):
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.protected_research_attributes'::regclass;           -- → true
--   SELECT count(*) FROM pg_policies WHERE tablename = 'protected_research_attributes';                         -- → 0
--   SELECT has_table_privilege('authenticated', 'public.protected_research_attributes', 'SELECT');              -- → false
-- No schema-cache change (no column / CHECK / FK).
