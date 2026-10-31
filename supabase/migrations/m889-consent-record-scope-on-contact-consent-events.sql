-- ── APPLIED LIVE 2026-10-31 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 147, lane 147A ──
--
-- m889 — THE CONSENT RECORD CARRIES ITS SCOPE (wave 147, lane 147A; owner ruling 1, 2026-10-31, contract C8).
--
-- OWNER RULING, verbatim: "When a person enters their info on a form, etc. there is a consent box so these need to go in as a
-- contact not a lead." The consented submission lands on the canonical Contact (lib/contact-pipeline/contact-capture.ts
-- captureConsentedContact) and "the consent wording, timestamp, source, channel, permitted purposes and tenant are recorded".
--
-- SURVIVOR, EXTENDED — NOT A NEW TABLE (LAW 1). public.contact_consent_events is the consent ledger every consent writer already
-- uses (lib/kernel/compliance/require-contact-consent.ts persistContactConsent — THE one writer, the lead-magnet kernel, the ad-lead
-- intake, the widget, the unsubscribe route, the TCPA panel) and every consent reader reads (customer-360, person-timeline,
-- behavioral_signals.consent_event_id FK, m706). Before this migration a row held the wording and a boolean only: it could not say
-- WHICH version of the wording was shown, WHAT the person agreed to be contacted about, on WHICH channels, from WHICH page, on WHAT
-- evidence, or which earlier consent a later preference change replaced. These columns are that record.
--
--   consent_text_hash     sha256 of the whitespace-normalised wording (lib/kernel/compliance/require-contact-consent.ts
--                         consentTextHash) — two rows that showed the same words carry the same hash whatever the version label.
--   consent_text_version  the door's own label for the wording it displayed (e.g. 'qr_landing:2026-10'); NULL when unrecorded.
--   purposes              what the person agreed to be contacted ABOUT — CONSENT_PURPOSES (one vocabulary, CHECKed below).
--   channels              the channels the wording itself names — CONSENT_CHANNELS (CHECKed below). A channel the wording does not
--                         name is NOT on the record (no inference from "communications").
--   source_url            the page / door the consent was captured on.
--   evidence              the evidence pointer (ip, user agent, form / submission / session / QR id, the intake channel).
--   idempotency_key       one consent per (tenant, identity, consent evidence) — captureConsentedContact derives it; a webhook /
--                         browser retry re-reads the same row instead of writing a second consent.
--   person_id             the person_identities row the capture resolved to (lib/kernel/person-identity.ts), when one anchored.
--   captured_at           when the person gave it (created_at is when the row was written).
--   supersedes_id         the earlier consent row (same contact / lead, same consent_type) this row replaces — a later preference
--                         change (an opt-out, a re-consent) REFERENCES the consent it changes.
--
-- Every column is NULLABLE or DEFAULTED, so every existing writer (which names none of them) keeps working unchanged — PGRST204
-- cannot refuse a writer that does not name a new column. The writer degrades loudly (scopeStored: false) when the columns are
-- absent, so the code may ship before this is applied.
--
-- ROLLBACK (owner SQL editor): DROP INDEX IF EXISTS public.contact_consent_events_tenant_idempotency_uq;
--   DROP INDEX IF EXISTS public.idx_contact_consent_events_contact_type_recent;
--   ALTER TABLE public.contact_consent_events DROP COLUMN IF EXISTS consent_text_hash, DROP COLUMN IF EXISTS consent_text_version,
--     DROP COLUMN IF EXISTS purposes, DROP COLUMN IF EXISTS channels, DROP COLUMN IF EXISTS source_url, DROP COLUMN IF EXISTS evidence,
--     DROP COLUMN IF EXISTS idempotency_key, DROP COLUMN IF EXISTS person_id, DROP COLUMN IF EXISTS captured_at,
--     DROP COLUMN IF EXISTS supersedes_id;
--
-- CACHES THE INTEGRATOR REGENERATES: schema-snapshot (10 columns), schema-fk-map (person_id → person_identities,
-- supersedes_id → contact_consent_events). check-vocabularies: the two CHECKs are array-containment (`<@`), not the
-- single-column `= ANY` shape the cache captures — the code constants CONSENT_PURPOSES / CONSENT_CHANNELS are the vocabulary and
-- scripts/consented-intake-guard.ts holds them equal to the lists below.

ALTER TABLE public.contact_consent_events
  ADD COLUMN IF NOT EXISTS consent_text_hash    text,
  ADD COLUMN IF NOT EXISTS consent_text_version text,
  ADD COLUMN IF NOT EXISTS purposes             text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS channels             text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS source_url           text,
  ADD COLUMN IF NOT EXISTS evidence             jsonb  NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key      text,
  ADD COLUMN IF NOT EXISTS person_id            uuid REFERENCES public.person_identities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS captured_at          timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_id        uuid REFERENCES public.contact_consent_events(id) ON DELETE SET NULL;

ALTER TABLE public.contact_consent_events DROP CONSTRAINT IF EXISTS contact_consent_events_purposes_check;
ALTER TABLE public.contact_consent_events ADD CONSTRAINT contact_consent_events_purposes_check CHECK (purposes <@ ARRAY[
  'real_estate_services', 'requested_information', 'property_inquiry', 'home_valuation', 'equity_review',
  'market_updates', 'listing_alerts', 'event_followup'
]::text[]);

ALTER TABLE public.contact_consent_events DROP CONSTRAINT IF EXISTS contact_consent_events_channels_check;
ALTER TABLE public.contact_consent_events ADD CONSTRAINT contact_consent_events_channels_check CHECK (channels <@ ARRAY[
  'sms', 'voice', 'email', 'direct_mail'
]::text[]);

-- One consent per (tenant, identity, consent evidence). Partial: every pre-existing row has no key.
CREATE UNIQUE INDEX IF NOT EXISTS contact_consent_events_tenant_idempotency_uq
  ON public.contact_consent_events (brokerage_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The scope reader (consentScopeFor) and the supersedes lookup read "this contact's newest row of this type".
CREATE INDEX IF NOT EXISTS idx_contact_consent_events_contact_type_recent
  ON public.contact_consent_events (brokerage_id, contact_id, consent_type, created_at DESC);

COMMENT ON COLUMN public.contact_consent_events.purposes IS
  'Wave 147 (147A, C8): what the person agreed to be contacted about — CONSENT_PURPOSES in lib/kernel/compliance/require-contact-consent.ts.';
COMMENT ON COLUMN public.contact_consent_events.channels IS
  'Wave 147 (147A, C8): the channels the consent WORDING names (sms / voice / email / direct_mail) — never inferred from generic wording.';
COMMENT ON COLUMN public.contact_consent_events.supersedes_id IS
  'Wave 147 (147A, C8): the earlier consent row (same party, same consent_type) a later preference change replaces.';
