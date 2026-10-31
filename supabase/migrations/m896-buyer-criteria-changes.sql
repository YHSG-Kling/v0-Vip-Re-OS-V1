-- WRITTEN, NOT APPLIED (wave 147, lane 147C) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m896 — buyer_criteria_changes: EVERY CHANGE TO A BUYER'S SEARCH, WITH THE REASON THEY CAN ACCEPT OR UNDO
-- (wave 147, lane 147C — owner ruling 16, contract C10: "feedback (saved / dismissed / toured / corrected) updates the
-- criteria with a reason"; brief requirement 3: "update criteria with a stated reason the buyer can edit or reject").
--
-- WHY A NEW TABLE (orphan doctrine §1.2, audited against scripts/schema-snapshot.ts at 4d527cc3):
--   · buyer_behavior_log is the RAW SIGNAL log (signal_type, list_price, city, …) the learner averages; it has no field,
--     previous value, proposed value, reason, decision or decider. A change is a CONSEQUENCE of signals, not a signal.
--   · property_preferences holds ONE current row per contact (m895 adds provenance); it cannot hold history or an open
--     proposal waiting for the buyer.
--   · agent_client_messages is the staff approval rail for OUTBOUND drafts; the approver here is the BUYER, about their own
--     criteria. activities is a timeline with no decision state.
--   · agent_action_ledger records that a write happened (who / why / idempotency) and is append-only evidence — the
--     ledger rows (buyer_search.criteria.update / buyer_search.criteria_change.decide) point at these rows by subject; they
--     are not a substitute for an open proposal the buyer can still answer.
--
-- Lifecycle: applied (already in the criteria — undo allowed) / proposed (waits for the buyer) → accepted | rejected;
-- superseded when a later change to the same field replaces an open proposal. A value the buyer REJECTED is never proposed
-- again (lib/buyer-search/conversational-search.ts learnFromBehaviour reads the rejected rows).
--
-- Writer: lib/buyer-search/buyer-criteria.ts recordCriteriaChanges / settleCriteriaChange, called only from
-- app/actions/buyer-search/conversational-search.ts under requireContactAccess + withActionLedger. Readers: the same module's
-- loadCriteriaChanges (the buyer's portal on any device; the agent's view through the tenant read policy).
-- Service-role writes only; tenant members read their own brokerage's rows.
--
-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts (3 FKs below) and
-- scripts/check-vocabularies.ts (field, provenance, trigger, status, channel); TABLE_MANAGER 'buyer_criteria_changes' ->
-- shopping_agent (lane 147I, listed in the lane-147C notes).

CREATE TABLE IF NOT EXISTS public.buyer_criteria_changes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- contacts.id (the PK) — never contacts.contact_id (CLAUDE.md §3)
  contact_id          uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  field               text        NOT NULL
    CONSTRAINT buyer_criteria_changes_field_check
    CHECK (field IN ('minPrice', 'maxPrice', 'minBeds', 'minBaths', 'cities', 'zipCodes', 'propertyTypes',
                     'mustHaveFeatures', 'dealBreakers', 'listingType', 'lifestyle')),
  previous_value      jsonb       NULL,
  proposed_value      jsonb       NULL,
  provenance          text        NOT NULL
    CONSTRAINT buyer_criteria_changes_provenance_check CHECK (provenance IN ('said', 'inferred', 'default')),
  trigger             text        NOT NULL
    CONSTRAINT buyer_criteria_changes_trigger_check
    CHECK (trigger IN ('stated', 'corrected', 'feedback', 'saved', 'dismissed', 'toured', 'priority_change')),
  -- the sentence the buyer reads ("You said …" / "You saved 2 homes above your $600k limit …") — never empty
  reason              text        NOT NULL CHECK (length(btrim(reason)) > 0),
  evidence            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status              text        NOT NULL DEFAULT 'proposed'
    CONSTRAINT buyer_criteria_changes_status_check
    CHECK (status IN ('proposed', 'applied', 'accepted', 'rejected', 'superseded')),
  channel             text        NOT NULL DEFAULT 'portal'
    CONSTRAINT buyer_criteria_changes_channel_check
    CHECK (channel IN ('portal', 'mobile', 'email', 'sms', 'voice', 'ai_chat', 'agent', 'system')),
  -- users.id class (the portal user / staff user who acted) — never agents.id (CLAUDE.md §3)
  created_by_user_id  uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decided_by_user_id  uuid        NULL,
  decided_at          timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- a decision names when it was made
  CONSTRAINT buyer_criteria_changes_decided_shape
    CHECK (status NOT IN ('accepted', 'rejected') OR decided_at IS NOT NULL)
);

COMMENT ON TABLE public.buyer_criteria_changes IS
  'Wave 147C (owner ruling 16, contract C10): every change to a buyer''s saved criteria — field, previous → proposed value, provenance (said|inferred|default), what triggered it, the reason the buyer reads, and their decision (accept / undo). Writer: lib/buyer-search/buyer-criteria.ts; doors: app/actions/buyer-search/conversational-search.ts.';

CREATE INDEX IF NOT EXISTS buyer_criteria_changes_contact_idx
  ON public.buyer_criteria_changes (brokerage_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS buyer_criteria_changes_open_idx
  ON public.buyer_criteria_changes (brokerage_id, contact_id, field)
  WHERE status IN ('proposed', 'applied');

ALTER TABLE public.buyer_criteria_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY buyer_criteria_changes_tenant_read ON public.buyer_criteria_changes
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.buyer_criteria_changes FROM authenticated, anon;
GRANT SELECT ON public.buyer_criteria_changes TO authenticated;

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.buyer_criteria_changes'::regclass ORDER BY 1;
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.buyer_criteria_changes'::regclass;
--   SELECT count(*) FROM public.buyer_criteria_changes;   -- 0 on first apply (no backfill: no history existed to backfill)
