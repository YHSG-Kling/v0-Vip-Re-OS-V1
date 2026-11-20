-- m610 — TWO TEXT "USER ID" COLUMNS BECOME REAL KEYS (2026-09-07)
--
-- Owner: "complete the building and editing for owner decisions … owners
-- decision is build and fix." Three columns were carried as "text user-id under
-- RLS" since wave 34 (m608 could not retype saved_properties.user_id because
-- policy sp_agent_own depends on it — SQLSTATE 0A000). Measured live before this
-- migration: all three hold ZERO rows, so no value can fail the cast or the FK.
--
--   saved_properties.user_id    text → uuid, FK users(id) ON DELETE CASCADE.
--       Written by app/crm/contacts/[contactId]/search/search-client.tsx:327 with
--       auth user.id; policy sp_agent_own compared `user_id = auth.uid()::text` —
--       recreated below WITHOUT the cast (same predicate, real type).
--   agent_commissions.approved_by text → uuid, FK users(id) ON DELETE SET NULL.
--       Written by lib/commission/reconcile-tracking.ts:97 with the approving
--       user's id; SET NULL because a departed approver must not delete a
--       commission row — the approval stays, the pointer clears.
--   journey_states.user_id      STAYS TEXT, ON PURPOSE. It is not a user id: the
--       live UNIQUE(user_id) plus lib/kernel/dual-intent-linker.ts key ONE row
--       per (contact, side) as `${contactId}:buyer` / `${contactId}:seller`
--       (see its header, lines 22-25). A uuid cast would destroy the design;
--       the column is misnamed, not mistyped, and renaming it is a §6 decision
--       for the next wave that touches both writers.
--
-- APPLIED 2026-09-07 to hrvaqgvukzxfskkcrwbt by the integrator; the FK cache
-- (scripts/schema-fk-map.ts) and the orphaned-child baseline were regenerated
-- from the live database in the same wave.
BEGIN;

DROP POLICY IF EXISTS sp_agent_own ON public.saved_properties;
ALTER TABLE public.saved_properties
  ALTER COLUMN user_id TYPE uuid USING NULLIF(user_id, '')::uuid;
ALTER TABLE public.saved_properties
  DROP CONSTRAINT IF EXISTS saved_properties_user_id_fkey;
ALTER TABLE public.saved_properties
  ADD CONSTRAINT saved_properties_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
CREATE POLICY sp_agent_own ON public.saved_properties
  FOR ALL TO public
  USING (
    user_id = auth.uid()
    OR contact_id IN (
      SELECT c.id FROM public.contacts c
      JOIN public.agents a ON a.id = c.agent_id
      WHERE a.user_id = auth.uid()
    )
  )
  WITH CHECK (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS saved_properties_user_id_idx ON public.saved_properties(user_id);

ALTER TABLE public.agent_commissions
  ALTER COLUMN approved_by TYPE uuid USING NULLIF(approved_by, '')::uuid;
ALTER TABLE public.agent_commissions
  DROP CONSTRAINT IF EXISTS agent_commissions_approved_by_fkey;
ALTER TABLE public.agent_commissions
  ADD CONSTRAINT agent_commissions_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

COMMIT;
