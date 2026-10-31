-- ── APPLIED LIVE 2026-10-31 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 147, integrator ──
-- m890 — outside_agent_contact_links.created_by_user_id gets the FOREIGN KEY the database was never given.
--
-- Orphaned-children census OC1 (wave 147): a parent-shaped column with no FK is a link the database cannot refuse — a deleted
-- actor would leave a dangling uuid. The column names the staff user who recorded the link (lane 147Z's broker-open kiosk
-- writes it when a visiting agent signs in); it is an ACTOR pointer, so ON DELETE SET NULL (the link survives, the author
-- is forgotten) — never a tenant anchor, so OC2's rule does not apply. Live state when written: 0 rows, 0 orphan actor rows.
ALTER TABLE public.outside_agent_contact_links
  ADD CONSTRAINT outside_agent_contact_links_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
