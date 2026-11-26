-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m734 — the skill marketplace's ACTOR columns get the FOREIGN KEY m727 never gave them (wave 108
-- integration; orphaned-children OC1 named skill_marketplace_listings.approved_by).
--
-- Both are written by lib/kernel/skill-marketplace.ts from the session's users.id (app/actions/
-- skill-marketplace.ts gate.userId / requirePlatformStaff().userId) — never an agents.id (CLAUDE.md §3:
-- agents.id and users.id are disjoint). ON DELETE SET NULL: a removed person never deletes the
-- marketplace's evidence of what was submitted and approved. Live before: 0 rows, so both validate at once.
ALTER TABLE public.skill_marketplace_listings
  ADD CONSTRAINT skill_marketplace_listings_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT skill_marketplace_listings_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id) ON DELETE SET NULL;
