-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149A ──
--
-- m935 — OWNER RULING 3 (2026-11-03): contact INTENT is buyer, seller or both — nothing else. "Intent is more the contact
-- persona's situation." `prospect` is a PLATFORM person (a potential VIPAgents subscriber — public.platform_prospects), never a
-- tenant lead type; the tenant acquisition ladder is raw lead → lead → contact (raw_scraped_leads → leads → contacts), so `lead`
-- is a TABLE, not a contact's type.
--
-- contacts.contact_type keeps the three INTENTS (buyer, seller, both) and the five RELATIONSHIP classes that are not intent
-- (lifetime_customer, sphere, vendor, referral_partner, other). 'lead' and 'prospect' leave the CHECK. A contact whose intent is
-- not yet known is contact_type NULL (the column is nullable, no default — read live 2026-11-03).
--
-- Live read before writing (2026-11-03, read-only):
--   contacts_contact_type_check = CHECK (contact_type = ANY (ARRAY['lead','prospect','lifetime_customer','sphere','vendor',
--     'referral_partner','buyer','seller','both','other']))
--   census: buyer 2, lifetime_customer 1, seller 1 — 0 rows on 'lead' / 'prospect' (the backfill below matches nothing today).
--   leads: 0 rows. campaign_sequences_contact_type_check already admits only buyer / seller / both / lifetime_customer (unchanged).
--
-- ORDER: apply AFTER lane 149A's writers land (they stop writing 'lead' / 'prospect'), and after the Outside-lane writer
-- lib/open-house/event-attendance.ts:170 + lib/open-house/event-registry.ts:68 (lane F) — until then a registration with no
-- stated intent would write 'prospect' and be refused (23514). lane 149A's notes list it.
--
-- After applying: regenerate scripts/check-vocabularies.ts (contacts.contact_type loses 'lead' and 'prospect').

BEGIN;

-- 1. BACKFILL — the intent a linked lead states, else NULL (never a guessed side).
UPDATE public.contacts c
   SET contact_type = l.lead_type
  FROM public.leads l
 WHERE l.contact_id = c.id
   AND l.brokerage_id = c.brokerage_id
   AND c.contact_type IN ('lead', 'prospect')
   AND l.lead_type IN ('buyer', 'seller', 'both');

UPDATE public.contacts
   SET contact_type = NULL
 WHERE contact_type IN ('lead', 'prospect');

-- 2. THE CHECK — three intents + five relationship classes.
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_contact_type_check;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_contact_type_check
  CHECK (contact_type = ANY (ARRAY['buyer'::text, 'seller'::text, 'both'::text,
                                   'lifetime_customer'::text, 'sphere'::text, 'vendor'::text, 'referral_partner'::text, 'other'::text]));

COMMENT ON COLUMN public.contacts.contact_type IS
  'Contact INTENT (buyer | seller | both) or a RELATIONSHIP class that is not intent (lifetime_customer | sphere | vendor | referral_partner | other); NULL = intent not yet known. Owner ruling 3 (2026-11-03, m935): lead and prospect are not contact types. The situation is contacts.contact_persona.';

COMMIT;

-- VERIFY (expect 0):  SELECT count(*) FROM public.contacts WHERE contact_type IN ('lead','prospect');
-- VERIFY (expect the 8-value CHECK): SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'contacts_contact_type_check';
--
-- ROLLBACK (only on a new owner ruling): re-add 'lead','prospect' to the ARRAY above. The backfilled rows are not restored
-- (none existed at writing).
