-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151B ──
--
-- L5 = S4 (lane 150BAA finding; docs/operations/OWNER-SQL.md §L L5; OWNER DECISION, wave 151 directive §151B "Contacts
-- see only their own permitted portal information. Vendors see only the Contacts, listings, transactions, assignments and
-- documents specifically authorized for their assigned work.").
--
-- MEASURED LIVE 2026-11-09 (pg_policies):
--   users.users_same_brokerage_select USING (is_platform_staff() OR (id = auth.uid()) OR (brokerage_id = current_user_brokerage_id()))
--   → every seat of a tenant — the 4 contact seats and the 4 vendor seats included (users census: contact 4/4 with
--   brokerage_id, vendor 4/4) — reads EVERY users row of that tenant: email, phone, password_hash, platform_role …
--
-- THE CODE'S CONTRACT, CENSUSED FIRST (every `.from("users")` under app/portal, app/vendor, lib/portal, lib/vendors):
--   · a contact or vendor seat reads its OWN row (app/portal/page.tsx, app/portal/vendor/page.tsx, app/portal/[contactId]/layout.tsx);
--   · a contact reads its ASSIGNED AGENT's display row — first_name, last_name, email — through the session client
--     (app/portal/[contactId]/help/page.tsx:37, app/portal/[contactId]/messages/page.tsx:93 — both keyed on
--     contacts.agent_id → agents.user_id); app/portal/listing-plan/[id]/page.tsx:251 and the seller ShareMyHomeCard read the
--     presenting / pushing agent's name the same way and degrade in words when the row is not readable;
--   · every other portal / vendor read of another person's row runs on the SERVICE client behind its own gate
--     (lib/portal/portal-clients-read.ts, lib/portal/require-contact-access.ts, lib/vendors/vendor-platform-identity.ts,
--     app/vendor/** via requireVendorActor / user_role_assignments).
--
-- THE RULE: platform staff; the caller's own row; tenant STAFF seats read the tenant's rows; a NON-staff seat reads, inside its
-- own tenant, only the agent rows its own records point at — a contact's assigned agent (contacts.contact_user_id = auth.uid()
-- → agents.user_id; the same join public.is_own_agent_user_id() already encodes for notifications), and a vendor seat's
-- booking / assigning agents (vendor_bookings.booked_by, vendor_assignments.assigned_by_agent_id → agents.user_id). Never the
-- roster, never another contact, never another vendor.
--
-- MCP-applicable: ALTER POLICY only (one statement). Roles unchanged ({authenticated}).

ALTER POLICY users_same_brokerage_select ON public.users
  USING (
    public.is_platform_staff()
    OR (id = auth.uid())
    OR ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat())
    OR (
      (brokerage_id = public.current_user_brokerage_id())
      AND (
        -- a contact seat: the agent assigned to its own contact row(s)
        public.is_own_agent_user_id(id)
        -- a vendor seat: the people who booked or assigned its vendor company
        OR id IN (
          SELECT vb.booked_by FROM public.vendor_bookings vb
           WHERE vb.booked_by IS NOT NULL
             AND vb.vendor_id IN (SELECT ura.vendor_id FROM public.user_role_assignments ura
                                   WHERE ura.user_id = auth.uid() AND ura.vendor_id IS NOT NULL)
        )
        OR id IN (
          SELECT a.user_id FROM public.vendor_assignments va
            JOIN public.agents a ON a.id = va.assigned_by_agent_id
           WHERE va.vendor_id IN (SELECT ura.vendor_id FROM public.user_role_assignments ura
                                   WHERE ura.user_id = auth.uid() AND ura.vendor_id IS NOT NULL)
        )
      )
    )
  );

-- READ-BACK (integrator, after apply):
--   SELECT regexp_replace(qual, '\s+', ' ', 'g') FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_same_brokerage_select';
--   → names is_tenant_staff_seat() and is_own_agent_user_id(); the bare tenant arm is gone.
-- PROBE (read-only, rolled back): as a seeded contact seat (set_config request.jwt.claims → sub = the contact's users.id),
--   SELECT count(*) FROM public.users;  → 2 (own row + the assigned agent's row), not the tenant's roster.
