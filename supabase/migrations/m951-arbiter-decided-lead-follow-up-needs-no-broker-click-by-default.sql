-- ── APPLIED LIVE 2026-11-16 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, integrator (owner ruling B7) ── read back: ai_isa_settings.require_broker_approval column_default false, NOT NULL; 0 rows live
--
-- OWNER RULING (2026-11-16, wave 153 B7): "people when the arbiter decides on follow up, no waiting for human to approve."
--
-- ai_isa_settings.require_broker_approval has been NOT NULL DEFAULT TRUE since migration 061, so a brokerage that never opened
-- the setting had every arbiter-decided lead touch staged for a broker's click. The code default moves with this migration
-- (lib/ai-isa/settings-types.ts DEFAULT_AISA_SETTINGS.require_broker_approval = false): a NEW row is created without the
-- approval requirement; a broker who wants a click turns it ON and that stored TRUE is honoured unchanged.
--
-- CENSUS (live, read-only, 2026-11-16): ai_isa_settings has 0 rows — no existing brokerage's stored choice is touched, and no
-- backfill is needed. NOT a fail-open: an UNREADABLE policy still never sends (lead-action-plan.ts leadAutoSendVerdict), and
-- consent / TCPA / DNC / quiet hours / suppression / the lead's allowed channels stay at the send chokepoints.
--
-- ROLLBACK: ALTER TABLE public.ai_isa_settings ALTER COLUMN require_broker_approval SET DEFAULT true;

ALTER TABLE public.ai_isa_settings ALTER COLUMN require_broker_approval SET DEFAULT false;

COMMENT ON COLUMN public.ai_isa_settings.require_broker_approval IS
  'm951 (wave 153, owner ruling 2026-11-16): TRUE = this owner requires a broker click before the AI ISA sends a lead touch. DEFAULT FALSE — an arbiter-decided routine follow-up needs no human approval unless the broker turns this on. Read by lib/ai-isa/resolve-isa-settings.ts; an unreadable row never sends.';
