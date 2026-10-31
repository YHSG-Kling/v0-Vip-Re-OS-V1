-- ── APPLIED LIVE 2026-10-19 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — two calls: columns + CHECK, then comments/backfill/indexes (the DROP CONSTRAINT IF EXISTS clause was omitted: the constraint did not exist) ──
--
-- m789 — business_card_scans: TYPED ENTITY LINKAGE (wave 142, lane 142D).
--
-- Owner, verbatim (2026-10-18): "why is the business card being saved as a contactid? it depends on what
-- type of person it is — user type they are vendor, contact or agent. before scanning, the user chooses
-- which type and then scans. these types of mislabeling keeps happening … we have user types and contact
-- types."
--
-- THE DEFECT AT THE DOMAIN LAYER: business_card_scans carried ONE typed entity link, `contact_id`
-- (FK contacts). A card routed to the vendor book or the recruiting pipeline was linked only through
-- jsonb keys the action wrote into extracted_data (`routed_to`, `vendor_id`, `recruit_id`) — invisible to
-- the FK map, to every reader that selects columns, and to the review surface, which therefore rendered a
-- "Contact" column for every scan. The row literally said "a contact or nothing".
--
-- THE FIX: one typed link per domain entity, each with its FK, and ONE column that names which entity the
-- scan became (or that it became none — a sphere / unclassified card is a scan row on purpose):
--   · vendor_id          uuid → vendors(id)   (a VENDOR card — the vendor bench, pending verification)
--   · recruit_id         uuid → recruits(id)  (an AGENT card — a recruiting prospect, never a CRM contact)
--   · routed_entity_type text CHECK IN ('contact','vendor','recruit','none')
-- contact_id stays exactly as it is (the contact / potential_contact route). Writers:
-- app/actions/business-card/business-card-actions.ts routeClassifiedCard; reader: getRecentScans → the
-- review surface's "Record" column. The jsonb keys are kept for one wave as the backfill source below and
-- for older readers; they are no longer the only truth.
--
-- Applicable in two small parts (wave 98 rule). Idempotent. Non-destructive (ADD COLUMN IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS + ADD inside one ALTER — the shape the MCP applies).

-- ── PART 1 — columns, FKs, CHECK ───────────────────────────────────────────────────────────────
ALTER TABLE public.business_card_scans
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES public.vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recruit_id uuid REFERENCES public.recruits(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS routed_entity_type text;

ALTER TABLE public.business_card_scans
  DROP CONSTRAINT IF EXISTS business_card_scans_routed_entity_type_check,
  ADD CONSTRAINT business_card_scans_routed_entity_type_check
    CHECK (routed_entity_type IS NULL OR routed_entity_type IN ('contact', 'vendor', 'recruit', 'none'));

COMMENT ON COLUMN public.business_card_scans.vendor_id IS 'm789 (wave 142D): the vendors row a VENDOR card became — typed, never a jsonb key';
COMMENT ON COLUMN public.business_card_scans.recruit_id IS 'm789 (wave 142D): the recruits row an AGENT card became — a recruiting prospect, never a CRM contact';
COMMENT ON COLUMN public.business_card_scans.routed_entity_type IS 'm789 (wave 142D): which domain entity the scan became — contact | vendor | recruit | none (sphere / unclassified stay a scan row on purpose)';

-- ── PART 2 — backfill from the jsonb keys the action wrote until now, then indexes ────────────
-- Only a jsonb id that still resolves to a live row is promoted (a deleted vendor stays unlinked, never a
-- dangling FK); every other scan is classified from what it already carries.
UPDATE public.business_card_scans s
   SET vendor_id = (s.extracted_data->>'vendor_id')::uuid,
       routed_entity_type = 'vendor'
 WHERE s.routed_entity_type IS NULL
   AND s.extracted_data->>'routed_to' = 'vendor'
   AND (s.extracted_data->>'vendor_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   AND EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = (s.extracted_data->>'vendor_id')::uuid);

UPDATE public.business_card_scans s
   SET recruit_id = (s.extracted_data->>'recruit_id')::uuid,
       routed_entity_type = 'recruit'
 WHERE s.routed_entity_type IS NULL
   AND s.extracted_data->>'routed_to' = 'recruit'
   AND (s.extracted_data->>'recruit_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   AND EXISTS (SELECT 1 FROM public.recruits r WHERE r.id = (s.extracted_data->>'recruit_id')::uuid);

UPDATE public.business_card_scans
   SET routed_entity_type = 'contact'
 WHERE routed_entity_type IS NULL AND contact_id IS NOT NULL;

UPDATE public.business_card_scans
   SET routed_entity_type = 'none'
 WHERE routed_entity_type IS NULL
   AND review_status = 'approved'
   AND card_subject_type IN ('sphere', 'unknown');

CREATE INDEX IF NOT EXISTS business_card_scans_vendor_id_idx ON public.business_card_scans (vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_card_scans_recruit_id_idx ON public.business_card_scans (recruit_id) WHERE recruit_id IS NOT NULL;

-- After applying: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and
-- scripts/check-vocabularies.ts from the live JSON (CLAUDE.md §3) — the new CHECK must reach the vocabulary cache.
