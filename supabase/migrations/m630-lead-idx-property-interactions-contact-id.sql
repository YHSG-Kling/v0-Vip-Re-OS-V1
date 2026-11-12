-- m630-lead-idx-property-interactions-contact-id.sql
-- ── APPLIED LIVE 2026-09-15 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m630_lead_idx_property_interactions_contact_id) ──
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT (wave 64C, lead-scraping audit lane): `lead_idx_property_interactions`
-- has exactly ONE entity column — `lead_id UUID REFERENCES leads(id)`
-- (scripts/320-create-leads-intelligence-system.sql:187) — but its only writer,
-- app/actions/lead-intelligence.ts::syncIDXBrokerActivity, is reached
-- EXCLUSIVELY through enrichLeadData(leadId), which resolves `leadId` against
-- `contacts` and throws when it is absent (`.from("contacts").select("*")...
-- .single()`, same file, ~L765). So every id this writer has ever held is
-- proven to be a contacts.id, and there was no column to put it in that a
-- `leads(id)` foreign key would accept — the write was removed rather than
-- filed under the wrong entity class (tombstone + full account in
-- syncIDXBrokerActivity's own header, same file).
--
-- SAME SHAPE AS m517 (motivated_seller_signals: "a signal table with one
-- entity column cannot hold a contact"). This migration does the identical
-- thing for this table: add `contact_id`, require exactly one of
-- (lead_id, contact_id), validate NOT VALID so it cannot fail on live data.
--
-- Measured live intent (not re-verified by this lane — no DB creds; the
-- integrator should confirm before applying, same as m517's own live count):
-- syncIDXBrokerActivity's write was REMOVED specifically because it had
-- nowhere honest to go, so the table is expected to hold 0 rows produced by
-- this writer. If any row exists with `lead_id` actually pointing at a
-- `leads.id` from a different, working writer, this migration does not touch
-- it — it only ADDS a column and a shape constraint.
--
-- ADDITIVE AND SAFE. No column is dropped, no data is rewritten.

ALTER TABLE public.lead_idx_property_interactions
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.lead_idx_property_interactions.contact_id IS
  'The CONTACT this IDX Broker property-activity row is about, when it is about a contact (the only class syncIDXBrokerActivity has ever resolved — see app/actions/lead-intelligence.ts). Exactly one of (lead_id, contact_id) is set — see lead_idx_property_interactions_one_entity. References contacts(id), not contacts.contact_id (CLAUDE.md §3).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lead_idx_property_interactions_one_entity'
       AND conrelid = 'public.lead_idx_property_interactions'::regclass
  ) THEN
    ALTER TABLE public.lead_idx_property_interactions
      ADD CONSTRAINT lead_idx_property_interactions_one_entity
      CHECK ((lead_id IS NOT NULL) <> (contact_id IS NOT NULL))
      NOT VALID;
  END IF;
END $$;

-- Validate only if nothing already stored would fail. If existing rows have
-- BOTH columns null (lead_id was nullable and this writer never populated it
-- successfully — see header), this RAISES A NOTICE naming the count and
-- leaves the constraint NOT VALID rather than aborting the migration.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM public.lead_idx_property_interactions
   WHERE (lead_id IS NOT NULL) = (contact_id IS NOT NULL);
  IF offending = 0 THEN
    ALTER TABLE public.lead_idx_property_interactions
      VALIDATE CONSTRAINT lead_idx_property_interactions_one_entity;
  ELSE
    RAISE NOTICE 'lead_idx_property_interactions_one_entity left NOT VALID — % existing row(s) violate exactly-one-entity', offending;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lead_idx_property_interactions_contact_id
  ON public.lead_idx_property_interactions (contact_id)
  WHERE contact_id IS NOT NULL;
