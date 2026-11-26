-- m309 — the OUTCOME RECONCILIATION ledger: what we claimed vs what the provider says.
-- ─────────────────────────────────────────────────────────────────────────────
-- Applied live. The audit that produced it:
--
--   email        RECONCILED already — the SendGrid Event Webhook updates
--                messages.status with exact sg_message_id correlation.
--   video render RECONCILED already — the poll-did-avatars cron reads provider_status.
--   SMS          NOT reconciled. dispatchSms returned success on Twilio's "queued"
--                and DISCARDED the returned status; no StatusCallback was registered
--                and no webhook existed, so a carrier rejection (bad number, landline,
--                blocked, spam-filtered) was never learned and every SMS read as sent.
--   direct mail  NOT reconciled. lob_order_id IS stored on the campaign by five
--                writers, and nothing ever read Lob's tracking — so a re-routed or
--                returned-to-sender piece read as sent, for good.
--
-- This is a truthfulness failure, not a missing feature: an autonomous team whose
-- proxy ("I wrote sent") drifts from its true objective ("the client received it")
-- is textbook reward misalignment, and the broker cannot see it because both look
-- identical in the database.

CREATE TABLE IF NOT EXISTS outcome_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,

  channel text NOT NULL CHECK (channel = ANY (ARRAY['email','sms','direct_mail','social','video'])),
  -- The provider's own id. The correlation key, and why a claim can be proven at all.
  provider_ref text,
  -- What the OS recorded, and when.
  claimed_status text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  -- What the provider said, verbatim, plus its payload for the audit trail.
  provider_status text,
  provider_reported_at timestamptz,
  provider_detail jsonb,

  verdict text NOT NULL DEFAULT 'pending'
    CHECK (verdict = ANY (ARRAY['confirmed','contradicted','pending','unverifiable'])),
  truth_source text,
  explanation text,

  -- Which record made the claim, so a contradiction is traceable to the touch.
  entity_type text,
  entity_id uuid,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id uuid,
  -- The manager accountable for the claim (manager_registry key).
  claimed_by_manager text,
  -- Set when a contradiction has been escalated, so it escalates once.
  escalated_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ONE row per provider reference per channel: a status callback fires repeatedly
-- (queued → sent → delivered) and each must UPDATE the same row, not append a
-- second opinion. Partial so rows without a provider_ref are still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS outcome_reconciliations_ref_key
  ON outcome_reconciliations (channel, provider_ref)
  WHERE provider_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS outcome_reconciliations_brokerage_verdict
  ON outcome_reconciliations (brokerage_id, verdict);
CREATE INDEX IF NOT EXISTS outcome_reconciliations_pending
  ON outcome_reconciliations (verdict, claimed_at) WHERE verdict = 'pending';

ALTER TABLE outcome_reconciliations ENABLE ROW LEVEL SECURITY;

-- Tenant staff read their own; only the service role writes (webhooks + crons).
CREATE POLICY outcome_reconciliations_select ON outcome_reconciliations
  FOR SELECT USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE outcome_reconciliations IS
  'What the OS CLAIMED happened vs what the provider SAYS happened, per touch. verdict: confirmed (proven) / contradicted (we asserted something that did not happen — escalated to the claiming manager) / pending (handed over, provider has not reported — NOT confirmation) / unverifiable (the lane has no truth source, said out loud). See lib/outcomes/reconciliation.ts for the per-lane truth sources.';
