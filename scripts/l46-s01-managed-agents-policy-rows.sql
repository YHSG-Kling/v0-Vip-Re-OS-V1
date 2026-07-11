-- l46-s01 · MANAGED_AGENTS POLICY ROWS (applied live 2026-07-11 via MCP)
--
-- managed_agents is BOTH the Anthropic-agent identity row (spawn-helper
-- fills anthropic_agent_id when a session is first spawned) AND the
-- per-manager policy surface (config.autonomy_tier — the Trust
-- Scorecard / autonomy-gate; config.doc_kernel_grants — the document
-- kernel's earned-autonomy ratchet). A broker can grant policy BEFORE
-- any Anthropic agent has ever been spawned for that manager, so the
-- identity column must not block a policy-only row. The spawn helper
-- ADOPTS a policy-only row (creates the Anthropic agent, updates the
-- same row) instead of inserting a duplicate — one row per
-- (brokerage, agent_kind), each side filling what it owns.
ALTER TABLE managed_agents ALTER COLUMN anthropic_agent_id DROP NOT NULL;
ALTER TABLE managed_agents ALTER COLUMN model DROP NOT NULL;
