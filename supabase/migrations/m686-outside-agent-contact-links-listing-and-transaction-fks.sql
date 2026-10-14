-- ── APPLIED LIVE 2026-10-02 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m686 — outside_agent_contact_links.listing_id and .transaction_id get their parents (wave 95).
-- The table (scripts/1001-outside-agents.sql) carried both columns without foreign keys; the wave-94
-- outside-offer path (lib/offers/outside-agent-record.ts) now writes them, so the orphaned-children
-- census flagged two parent links nothing enforces. Live read 2026-10-02: 0 rows, both columns uuid.
-- ON DELETE SET NULL: a removed listing or deal leaves the agent ↔ client link, minus the pointer.
ALTER TABLE public.outside_agent_contact_links
  DROP CONSTRAINT IF EXISTS outside_agent_contact_links_listing_id_fkey,
  DROP CONSTRAINT IF EXISTS outside_agent_contact_links_transaction_id_fkey;
ALTER TABLE public.outside_agent_contact_links
  ADD CONSTRAINT outside_agent_contact_links_listing_id_fkey
    FOREIGN KEY (listing_id) REFERENCES public.listings(id) ON DELETE SET NULL,
  ADD CONSTRAINT outside_agent_contact_links_transaction_id_fkey
    FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;
