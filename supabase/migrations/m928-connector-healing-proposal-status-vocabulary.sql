-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148I ──
--
-- m928 — connector_healing_proposals.status: ONE VOCABULARY, ENFORCED, WITH C25's REVERSAL (owner ruling 15, 2026-11-01:
-- "some coding self healing is acceptable as long as it doesn't break the rest of the OS such as configuration change of a
-- provider if there was a change in the connection method").
--
-- WHAT WAS THERE (live 2026-11-01): the column has NO CHECK. The writers spell pending (the healer / the one proposal writer),
-- applied (the auto-applier, approveProposalAction) and rejected (rejectProposalAction); the healing console also styled a
-- `superseded` no writer ever produced. 0 live rows.
--
-- C25 (lib/kernel/provider-config-healing.ts) makes a configuration self-heal REVERSIBLE: a version that fails its test (the
-- one retry under it — lib/agentic-os/connector-healer.ts healProviderFailure) or that a person takes back
-- (app/actions/superadmin/connector-healing.ts revertProposalAction) flips applied → `reverted`; egress then falls back to the
-- newest still-applied version (lib/agentic-os/connector-gateway.ts loadAppliedAlternate reads status = 'applied'). The row
-- and its evidence stay (append-only history: every version, why it was applied, why it was taken back).
--
-- AFTER APPLYING: regenerate scripts/check-vocabularies.ts (connector_healing_proposals.status) — code mirror:
-- lib/kernel/provider-config-healing.ts HEALING_PROPOSAL_STATUSES (scripts/self-healing-guard.ts section J holds the two equal).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.connector_healing_proposals WHERE status IS NULL OR status <> ALL (ARRAY['pending', 'applied', 'rejected', 'reverted'])) THEN
    RAISE EXCEPTION 'm928: connector_healing_proposals holds a status outside (pending, applied, rejected, reverted) — inspect before constraining';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_healing_proposals_status_check') THEN
    ALTER TABLE public.connector_healing_proposals ADD CONSTRAINT connector_healing_proposals_status_check
      CHECK (status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'reverted'::text]));
  END IF;
END $$;

-- VERIFY:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'connector_healing_proposals_status_check';
-- ROLLBACK:
--   alter table public.connector_healing_proposals drop constraint if exists connector_healing_proposals_status_check;
