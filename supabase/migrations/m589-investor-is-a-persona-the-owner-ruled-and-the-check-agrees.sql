-- m589 — investor is a PERSONA (owner ruling), and the CHECK now agrees
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-08-31, in the
-- same session that wrote it. Verified AFTER applying (bottom of file).
--
-- THE RULING, verbatim: "one thing to note that investor is a persona and not a
-- contact type."
--
-- The wave-19 persona rekey aligned code onto the live 13-value
-- contacts_contact_persona_check and, finding no 'investor' member, ruled it
-- lived on contact_type. The owner has overruled: an investor is a SITUATION a
-- person is in (what persona means here — how you talk to them, which lessons
-- and copy fit), not which side of a transaction they are on. This migration
-- adds the fourteenth member; code-side, the Persona union, the roster, the
-- label maps, the campaign machinery and the portal translator's
-- investor-tuned copy are restored in the same change set, each pinned by the
-- Record<Persona, …> keying that fails compile when a member has no wording.
--
-- MOTIVATED_SELLER IS DELIBERATELY NOT ADDED, with the owner's invitation to
-- suggest better taken up: "motivated" is INTENT, and the scraping pipeline
-- already carries it as the signal it is (motivated_seller_signals,
-- motivation_type) — untouched here, per the standing lead-scraping fence. When
-- a scraped motivated seller becomes a contact, the vocabulary already says WHY
-- they are motivated (probate, divorce, foreclosure, expired, fsbo, senior) and
-- lead_temperature says how urgently; a 'motivated_seller' persona would
-- duplicate five existing personas and flatten the signal into a label.
--
-- LIVE MEASUREMENTS BEFORE APPLYING (2026-08-31):
--   · contacts_contact_persona_check: NULL-or-13-values (first_time, relocated,
--     luxury, fsbo, probate, upsize, downsize, military, divorce, senior,
--     expired, foreclosure, other) — 'investor' absent.
--   · contact_persona live rows: NULL:1, luxury:1, relocated:1, first_time:1 —
--     nothing to backfill; this migration only WIDENS, so no UPDATE step and no
--     NOT VALID dance is needed (every existing row already satisfies the new
--     constraint by construction).
--   · contact_type live rows: buyer:2, lifetime_customer:1, seller:1 — ZERO
--     'investor' rows, so the other half of the ruling ("not a contact type")
--     strands no data; retiring 'investor' from the contact_type CHECK and
--     roster is adjudicated separately with its own reader survey.
--
-- AFTER-APPLY VERIFICATION:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.contacts'::regclass
--      and conname='contacts_contact_persona_check';
--   → must list fourteen values including 'investor'.

BEGIN;

ALTER TABLE public.contacts DROP CONSTRAINT contacts_contact_persona_check;

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_contact_persona_check
  CHECK (contact_persona IS NULL OR contact_persona IN (
    'first_time', 'relocated', 'luxury', 'fsbo', 'probate',
    'upsize', 'downsize', 'military', 'divorce', 'senior',
    'expired', 'foreclosure', 'investor', 'other'
  ));

COMMIT;

-- MEASURED AFTER APPLYING (2026-08-31, hrvaqgvukzxfskkcrwbt):
--   CHECK (((contact_persona IS NULL) OR (contact_persona = ANY (ARRAY[
--     'first_time','relocated','luxury','fsbo','probate','upsize','downsize',
--     'military','divorce','senior','expired','foreclosure','investor','other']))))
