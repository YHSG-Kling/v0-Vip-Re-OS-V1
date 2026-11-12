-- ── LIVE READ RECORD 2026-11-04 (wave 149 integrator; Supabase MCP, project hrvaqgvukzxfskkcrwbt) — NOT A MIGRATION, NOT APPLIED BY ANYONE ──
--
-- The THIRTEEN row-level-security policies below are LIVE on the database and every one of them CALLS
-- public.portal_member_searches(). They were created before supabase/migrations/ tracked this feature
-- (no migration file carries them; m471 / m482 only MENTION the function in prose), so the only place the
-- binding "portal_member_searches() ← these policies" had ever been written down was pg_policies itself.
-- m938 (wave 149, lane 149B — APPLIED LIVE 2026-11-03) re-defined the function to admit only OWNERS, which
-- made it a function supabase/migrations DEFINES — and scripts/hidden-wire-census.ts then saw a defined
-- function with no recorded SQL caller (category d). The caller exists; it was unrecorded. This file is the
-- record, read from pg_policies (qual / with_check verbatim as pg_get_expr prints them), in the same posture as
-- the wave-93 out-of-band record of the on_auth_user_created trigger: the census reads scripts/*.sql for CALL
-- sites, never for declarations. Re-read 2026-11-04 with:
--   SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies
--    WHERE qual ILIKE '%portal_member_searches%' OR with_check ILIKE '%portal_member_searches%' ORDER BY 1, 2;
-- Behaviour today: an invited family member never reaches these rows through a JWT — portal_member_searches()
-- returns only the searches the signed-in CONTACT owns (m938); collaborators read their shared homes through the
-- hashed-token door (lib/portal/collaborative-share.ts, C28). Tenant staff are admitted by the user_brokerage_ids()
-- arm. Nothing here is to be run; it is what IS.

-- collaborative_searches
CREATE POLICY portal_read_collaborative_searches ON public.collaborative_searches FOR SELECT TO authenticated
  USING (id IN (SELECT portal_member_searches() AS portal_member_searches));

-- collaborative_search_members
CREATE POLICY member_read_cs_members ON public.collaborative_search_members FOR SELECT TO authenticated
  USING ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_members.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_update_cs_members ON public.collaborative_search_members FOR UPDATE TO authenticated
  USING ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_members.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))))
  WITH CHECK ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_members.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_write_cs_members ON public.collaborative_search_members FOR INSERT TO authenticated
  WITH CHECK ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_members.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));

-- collaborative_search_properties
CREATE POLICY member_read_cs_properties ON public.collaborative_search_properties FOR SELECT TO authenticated
  USING ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_properties.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_update_cs_properties ON public.collaborative_search_properties FOR UPDATE TO authenticated
  USING ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_properties.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))))
  WITH CHECK ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_properties.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_write_cs_properties ON public.collaborative_search_properties FOR INSERT TO authenticated
  WITH CHECK ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = collaborative_search_properties.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));

-- property_consensus
CREATE POLICY member_read_property_consensus ON public.property_consensus FOR SELECT TO authenticated
  USING ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_consensus.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_update_property_consensus ON public.property_consensus FOR UPDATE TO authenticated
  USING ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_consensus.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))))
  WITH CHECK ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_consensus.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_write_property_consensus ON public.property_consensus FOR INSERT TO authenticated
  WITH CHECK ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_consensus.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));

-- property_family_ratings (the member arm is further pinned to the member's own e-mail)
CREATE POLICY member_read_family_ratings ON public.property_family_ratings FOR SELECT TO authenticated
  USING ((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_family_ratings.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_update_family_ratings ON public.property_family_ratings FOR UPDATE TO authenticated
  USING (((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) AND (lower(member_email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text)))) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_family_ratings.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))))
  WITH CHECK (((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) AND (lower(member_email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text)))) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_family_ratings.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
CREATE POLICY member_write_family_ratings ON public.property_family_ratings FOR INSERT TO authenticated
  WITH CHECK (((collaborative_search_id IN (SELECT portal_member_searches() AS portal_member_searches)) AND (lower(member_email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text)))) OR (EXISTS (SELECT 1 FROM collaborative_searches s WHERE s.id = property_family_ratings.collaborative_search_id AND s.brokerage_id IN (SELECT user_brokerage_ids() AS user_brokerage_ids))));
