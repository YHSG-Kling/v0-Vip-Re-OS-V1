-- m631-lead-idx-property-interactions-lead-fk.sql
-- ── APPLIED LIVE 2026-09-15 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m631_lead_idx_property_interactions_lead_fk) ──
-- ─────────────────────────────────────────────────────────────────────────────
-- WAVE 64 (lead-scraping audit, integrator). scripts/orphaned-child-census.ts
-- OC1 flagged lead_idx_property_interactions.lead_id the moment m630 made the
-- table dual-keyed: the column always MEANT leads(id) (every writer in
-- app/actions/lead-intelligence.ts, and the m630 exactly-one CHECK pairs it
-- with contact_id → contacts(id)) but the live table carried only TWO foreign
-- keys (brokerage_id, contact_id) — measured live before this ran: 0 rows,
-- 0 orphan lead_id values. ON DELETE RESTRICT matches m628's nine sibling
-- scraping-child links (no request-serving DELETE FROM leads exists).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lead_idx_property_interactions_lead_id_fkey'
       AND conrelid = 'public.lead_idx_property_interactions'::regclass
  ) THEN
    ALTER TABLE public.lead_idx_property_interactions
      ADD CONSTRAINT lead_idx_property_interactions_lead_id_fkey
      FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE RESTRICT;
  END IF;
END $$;
