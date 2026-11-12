-- =====================================================
-- MIGRATION m627: live-agent face-render provider (D-ID → Simli seam)
-- ── APPLIED LIVE 2026-09-14 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m627_live_agent_face_provider) ──
-- =====================================================
--
-- WAVE 62 — owner ruling (2026-09-14, verbatim): "building Simli as a backup
-- makes more sense than HeyGen." lib/live-agent/face-render.ts is the seam;
-- D-ID Express v4 stays PRIMARY, Simli is fail-over only, then same-brain
-- text chat (wave 60's existing fail-over). This migration adds the TWO
-- columns the seam needs and nothing else:
--
--   1. agent_avatar_assets.simli_face_id — cached on the SAME twin/profile
--      row did_agent_id/did_avatar_id already live on (§1: one identity row
--      per agent, not a second table per provider). Written by
--      lib/providers/simli/faces.ts::ensureSimliFaceForAgent, gated on the
--      SAME verified-consent row (agent_did_consents) the D-ID video twin
--      requires — never a fresh likeness without it.
--
--   2. brokerage_settings.live_agent_face_provider_order — the ONE settings
--      source resolveFaceRenderProvider({brokerageId}) reads
--      (lib/live-agent/face-render.ts). brokerage_settings is where the
--      OTHER tenant-configured-provider columns already live (esign_provider,
--      idx_api_key, ghl_api_key — CLAUDE.md's own "tenant's transaction/
--      e-sign provider comes from SETTINGS" precedent, wave 47), so this
--      follows that table rather than opening a new one. DEFAULT
--      ARRAY['did','simli'] — D-ID primary, Simli backup, matching the ruling
--      above; a brokerage that wants Simli disabled entirely sets
--      ARRAY['did'] (fail-over skips a provider not present in the list).
--
-- No CHECK constraint on either column, matching m624's own `provider TEXT
-- NOT NULL DEFAULT 'did'` (no CHECK) — the vocabulary is enforced in code
-- (lib/live-agent/face-render.ts's FaceRenderProvider = "did" | "simli") and
-- proved against it by scripts/face-render-seam-simulator.ts, not by a DB
-- CHECK that would need its own migration every time a provider is added.
-- =====================================================

ALTER TABLE public.agent_avatar_assets
  ADD COLUMN IF NOT EXISTS simli_face_id TEXT;

ALTER TABLE public.brokerage_settings
  ADD COLUMN IF NOT EXISTS live_agent_face_provider_order TEXT[]
    NOT NULL DEFAULT ARRAY['did', 'simli'];

-- scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and
-- scripts/check-vocabularies.ts must be regenerated from live JSON after
-- application (CLAUDE.md §3) so agent_avatar_assets and brokerage_settings'
-- column lists include the two new columns.
