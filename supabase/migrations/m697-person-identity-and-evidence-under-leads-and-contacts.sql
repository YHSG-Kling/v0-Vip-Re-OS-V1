-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m697 — THE CANONICAL PERSON IDENTITY / EVIDENCE LAYER UNDER THE EXISTING LEADS AND CONTACTS
-- (wave 102, lane 102A; "Intelligence Graph: canonical Person identity/evidence layer under existing
-- Leads/Contacts … NO destructive Lead/Contact migration"). ADDITIVE ONLY: leads and contacts keep
-- every column, every FK and every reader; nothing here alters either table.
--
-- SURVIVORS EVALUATED FIRST (LAW 1 / LAW 2), none of them a tenant-scoped person key that spans
-- raw record → lead(s) → contact:
--   · leads.contact_id + converted_at (lib/contact-promotion/history-carry.ts; contact_lead_history
--     view) — the lead→contact LINK. Kept as-is; person_identities.canonical_contact_id is stamped
--     from the SAME call (carryLeadHistoryToContact), never from a second converter.
--   · lead_deduplication_log (match_score / match_details / duplicate_of_lead_id / _contact_id) —
--     EVIDENCE of a dedup DECISION per raw row, keyed on raw_record_id with no person id. Kept as the
--     pipeline's decision ledger; every evidence row this lane writes at a dedup decision names the
--     same stage and score (detail.stage / match_score), so the two ledgers agree.
--   · contacts.contact_id — a per-row secondary uuid (unsubscribe / suppression token; lib/kernel/
--     compliance/check-suppression.ts:199). One contact row, one value: it cannot name a raw record
--     or a second lead, so it is NOT the person key.
--   · unified_lead_profile (0 rows; createUnifiedLeadProfile) — a per-contact INTELLIGENCE profile
--     (temperature / intent), not an identity hub. Untouched.
--   · behavioral_signals.unified_profile_id / identified — a visitor→profile pointer; a linked signal
--     is recorded here as entity_type 'behavioral_signal' evidence, the column is untouched.
--
-- WHAT THIS ADDS. ONE person row per tenant per identity-gate key (normalised first + last + EMAIL —
-- the same bar lib/lead-pipeline/canonical-lead-eligibility.ts sets for becoming a lead; phone digits
-- are CORROBORATION, never the key) and an APPEND-ONLY evidence ledger of every entity resolved to
-- that person: which record, by which deterministic method, at what score, from which chokepoint, by
-- whom, when. The ONE writer is lib/kernel/person-identity.ts (resolvePerson / linkPersonEvidence /
-- markPersonConverted); it is called from the EXISTING chokepoints only (pipeline-processor identity
-- gate + dedup decisions, history-carry promotion link, mergeContacts, unknown-sender identification,
-- the open-house kiosk greeting, the public form submit). Readers: personForContact / personForLead
-- (lib/lead-intelligence/person-timeline.ts folds every linked lead/raw row into ONE timeline;
-- lib/contacts/contact-brief.ts shows the identity evidence).
--
-- · identity_key is the normalised 'first|last|email' triple; UNIQUE (brokerage_id, identity_key)
--   — the resolver inserts and, on 23505, re-reads (a concurrent resolver loses honestly).
-- · entity_type / match_method / actor_type are inline CHECKs (one vocabulary per idea, §6);
--   actor_type is the agent_action_ledger vocabulary (m687). lib/kernel/person-identity.ts mirrors
--   the lists as PERSON_ENTITY_TYPES / PERSON_MATCH_METHODS and the proof asserts code == migration.
-- · evidence is UNIQUE (person_id, entity_type, entity_id, match_method): re-running a chokepoint
--   over the same record is idempotent (reported `duplicate: true`, never a second row).
-- · Writes are service-role only (no INSERT/UPDATE/DELETE policy): a session client cannot forge
--   evidence. Reads are tenant-scoped (has_brokerage_access) or platform staff — the same posture
--   as m696.
-- · person_identity_evidence is APPEND-ONLY (the m689/m696 trigger pattern): UPDATE/DELETE refused;
--   a referential action from a deleted parent (brokerage / person CASCADE, users SET NULL) arrives
--   nested in the RI trigger (pg_trigger_depth() > 1) and is let through.
-- · person_identities IS updatable (canonical_contact_id / converted_at / evidence_count /
--   last_seen_at move as evidence lands) — the person row is a pointer, the evidence is the history.
--
-- Until applied every write resolves 42P01 / PGRST205: each chokepoint's primary write still lands
-- (lead, contact, link, merge, greeting, submission) and the missing person link is REPORTED on the
-- call's result / warning, never thrown.
--
-- Apply in TWO parts (wave 98 rule): PART A (tables + CHECKs), then PART B (indexes, trigger, RLS).
-- AFTER APPLYING: regenerate the schema snapshot, LIVE_TABLES, the FK map (five new FKs) and the
-- vocabulary cache (three inline CHECKs).

-- ══════════════════════════════ PART A — tables, CHECKs ══════════════════════════════

CREATE TABLE IF NOT EXISTS public.person_identities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  identity_key          text NOT NULL,
  email_normalized      text NOT NULL,
  first_name_normalized text NOT NULL,
  last_name_normalized  text NOT NULL,
  phone_digits          text,
  canonical_contact_id  uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  converted_at          timestamptz,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  evidence_count        integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_identities_brokerage_identity_key_key UNIQUE (brokerage_id, identity_key),
  CONSTRAINT person_identities_identity_key_format_check
    CHECK (identity_key = first_name_normalized || '|' || last_name_normalized || '|' || email_normalized),
  CONSTRAINT person_identities_email_normalized_check CHECK (email_normalized = lower(btrim(email_normalized)) AND email_normalized <> ''),
  CONSTRAINT person_identities_evidence_count_check CHECK (evidence_count >= 0)
);

CREATE TABLE IF NOT EXISTS public.person_identity_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES public.person_identities(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  match_method  text NOT NULL,
  match_score   numeric(4,3) NOT NULL,
  source        text NOT NULL,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL DEFAULT 'system',
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_identity_evidence_unique_link UNIQUE (person_id, entity_type, entity_id, match_method),
  CONSTRAINT person_identity_evidence_entity_type_check
    CHECK (entity_type IN ('raw_scraped_lead', 'lead', 'contact', 'open_house_attendee', 'form_submission', 'behavioral_signal')),
  CONSTRAINT person_identity_evidence_match_method_check
    CHECK (match_method IN ('identity_gate', 'email_exact', 'phone_corroborated', 'dedup_match', 'promotion_link', 'contact_merge', 'capture_match')),
  CONSTRAINT person_identity_evidence_actor_type_check
    CHECK (actor_type IN ('manager', 'user', 'agent', 'system')),
  CONSTRAINT person_identity_evidence_match_score_check CHECK (match_score >= 0 AND match_score <= 1),
  CONSTRAINT person_identity_evidence_source_format_check CHECK (source ~ '^[a-z][a-z0-9_.-]*$')
);

COMMENT ON TABLE public.person_identities IS
  'ONE row per tenant per identity-gate key (normalised first|last|email). Writer lib/kernel/person-identity.ts resolvePerson / markPersonConverted; readers personForContact / personForLead. Additive under leads/contacts — neither table changes. m697.';
COMMENT ON TABLE public.person_identity_evidence IS
  'Append-only ledger of every entity resolved to a person (raw row, lead, contact, open-house attendee, form submission, behavioral signal): method, score, chokepoint, actor, when. Writer lib/kernel/person-identity.ts linkPersonEvidence. m697.';

-- ══════════════════════════════ PART B — indexes, trigger, RLS ══════════════════════════════

CREATE INDEX IF NOT EXISTS idx_person_identities_brokerage_email
  ON public.person_identities (brokerage_id, email_normalized);
CREATE INDEX IF NOT EXISTS idx_person_identities_canonical_contact
  ON public.person_identities (canonical_contact_id) WHERE canonical_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_person_identity_evidence_person
  ON public.person_identity_evidence (person_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_person_identity_evidence_entity
  ON public.person_identity_evidence (brokerage_id, entity_type, entity_id);

CREATE OR REPLACE FUNCTION public.person_identity_evidence_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Referential actions (cascade from a deleted brokerage or person, set-null from a deleted user)
  -- arrive nested in the RI trigger.
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'person_identity_evidence % is append-only: % refused — a correction is a NEW evidence row', OLD.id, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS person_identity_evidence_append_only ON public.person_identity_evidence;
CREATE TRIGGER person_identity_evidence_append_only
  BEFORE UPDATE OR DELETE ON public.person_identity_evidence
  FOR EACH ROW EXECUTE FUNCTION public.person_identity_evidence_append_only();

ALTER TABLE public.person_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_identity_evidence ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.person_identities FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.person_identity_evidence FROM anon, authenticated;

DROP POLICY IF EXISTS person_identities_select ON public.person_identities;
CREATE POLICY person_identities_select ON public.person_identities
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

DROP POLICY IF EXISTS person_identity_evidence_select ON public.person_identity_evidence;
CREATE POLICY person_identity_evidence_select ON public.person_identity_evidence
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));
