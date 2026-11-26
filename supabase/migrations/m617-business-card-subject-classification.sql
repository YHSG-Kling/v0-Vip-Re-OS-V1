-- m617-business-card-subject-classification.sql
-- APPLIED to hrvaqgvukzxfskkcrwbt on 2026-09-10 by the integrator (measured first: none of the four columns existed).
--
-- Owner ruling, 2026-09-10 (wave 48), verbatim: "the kernel events scanned business
-- card shouldn't be assumed contact since it is a business card from an event,
-- sphere of influence/other agent/potential contact so should be a userid user
-- type and card reader or agents notes can determine."
--
-- Today business_card_scans (scripts/schema-snapshot.ts:151) carries no
-- classification of WHO the card belongs to — every viable scan either became a
-- vendors row, a recruits row, or fell through to a contacts row by default (the
-- exact "assumed contact" the ruling forbids). This adds the columns that carry
-- the classification ON THE SCAN ROW so it survives independent of which
-- downstream table (if any) the card routed to.
--
-- UNTIL THIS IS APPLIED: lib/contacts/card-classifier.ts (classifyCardSubject) and
-- app/actions/business-card/business-card-actions.ts already compute and USE this
-- classification for routing (see lib/kernel/event-reactor.ts's BUSINESS_CARD_APPROVED
-- block), but the values ride inside the ALREADY-LIVE `extracted_data` jsonb column
-- (keys card_subject_type / subject_user_id / subject_notes / classified_by) rather
-- than these typed columns — the established pattern this file already used for
-- routed_to/vendor_id/recruit_id. Once this migration is applied, a follow-up lane
-- should move the writes from the jsonb keys onto these typed columns and backfill.

ALTER TABLE business_card_scans
  ADD COLUMN IF NOT EXISTS card_subject_type text
    CHECK (card_subject_type IN ('sphere', 'agent', 'potential_contact', 'contact', 'vendor', 'unknown')),
  ADD COLUMN IF NOT EXISTS subject_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS subject_notes text,
  -- which determination tier decided card_subject_type — 'reader' | 'notes' |
  -- 'match' | 'picker' | 'default' (lib/contacts/card-classifier.ts's `source`).
  ADD COLUMN IF NOT EXISTS classified_by text
    CHECK (classified_by IN ('reader', 'notes', 'match', 'picker', 'default'));

CREATE INDEX IF NOT EXISTS idx_business_card_scans_subject_user_id
  ON business_card_scans (subject_user_id) WHERE subject_user_id IS NOT NULL;

COMMENT ON COLUMN business_card_scans.card_subject_type IS
  'Who the scanned card belongs to (owner ruling 2026-09-10) — sphere/agent/potential_contact/contact/vendor/unknown. Drives routing in lib/kernel/event-reactor.ts on BUSINESS_CARD_APPROVED. NEVER auto-create a contacts row unless this is contact or potential_contact.';
COMMENT ON COLUMN business_card_scans.subject_user_id IS
  'users.id when the card subject is an existing platform user (e.g. a matched agent) — set only by the existing-match determination tier, never guessed.';
