-- WRITTEN, NOT APPLIED (wave 146, lane 146F) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m883 — lead_magnet_promises: THE PROMISE LEDGER. Every lead-magnet request that promised an asset (a guide, a book, a
-- report, an agent-prepared home value) is recorded with what was promised, to whom, on what consent, through which
-- channel, every attempt, every failure and the final evidence (wave 146, lane 146F — owner ruling 10, 2026-10-29: "The
-- arbiter needs to make sure that any deliverables that were promised from the lead magnet are delivered"; contract C4).
--
-- WHY A NEW TABLE (orphan doctrine §1.2, audited against the live schema 2026-10-29 — to_regclass is null, form_submissions
-- has 0 rows, activities has 0 lead_magnet_delivered rows):
--   · form_submissions records the REQUEST (submission_data, consent, source) and has no column for the promised asset, its
--     version, the delivery channel, attempts, failure or evidence; widening it would put a delivery state machine on a
--     capture log every form (not only lead magnets) writes.
--   · activities ('lead_magnet_delivered', lib/marketing/lead-magnet-delivery-runner.ts) was written when the deliverable COPY
--     was PREPARED — before anything was sent — so it recorded "delivered" for a guide whose PDF never rendered and for an
--     email nobody sent. It stays the AI ISA's timeline line, now written only AFTER a verified delivery.
--   · outcome_reconciliations proves a provider SEND (channel + provider_ref); it knows nothing of the promise behind it. The
--     promise row carries the dispatch's provider ref in `evidence` so the two join.
-- One request never produces two deliveries: UNIQUE (submission_id), plus the writer reuses an open / delivered promise for
-- the same (form, contact) inside its request window, plus the email rides the action ledger cycle `lead_magnet_promise:<id>`.
--
-- Writer + readers: lib/lead-magnets/promised-deliverables.ts (recordPromisedDeliverable / deliverPromised /
-- undeliveredPromisesFor / sweepUndeliveredPromises / attestPromiseDelivered). Service-role writes only; tenant members read
-- their own brokerage's rows (the lead-magnet workspace's Promises panel; the arbiter reads through the service client).
--
-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts (6 FKs below) and
-- scripts/check-vocabularies.ts (asset_kind, consent_basis, fulfilment, status, delivered_via), and add TABLE_MANAGER
-- 'lead_magnet_promises' -> campaign_orchestrator (lane 146I).

CREATE TABLE IF NOT EXISTS public.lead_magnet_promises (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- the source: which magnet / form, which request, which campaign brought them
  form_id          uuid        NULL REFERENCES public.lead_capture_forms(id) ON DELETE SET NULL,
  submission_id    uuid        NULL REFERENCES public.form_submissions(id) ON DELETE SET NULL,
  campaign_id      uuid        NULL REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  attribution      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- the recipient's canonical identity (contacts.id — the PK, never contacts.contact_id; and the resolved person)
  contact_id       uuid        NULL REFERENCES public.contacts(id) ON DELETE SET NULL,
  person_id        uuid        NULL REFERENCES public.person_identities(id) ON DELETE SET NULL,
  -- what was promised
  magnet_type      text        NOT NULL,
  asset_kind       text        NOT NULL
    CONSTRAINT lead_magnet_promises_asset_kind_check
    CHECK (asset_kind IN ('guide', 'book', 'report', 'valuation', 'checklist', 'video')),
  asset_title      text        NULL,
  -- the asset that was (or will be) delivered and its version: { table, id, url, document_id, version, approval_basis }
  asset_ref        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  asset_version    text        NULL,
  -- who fulfils it: the system rail (a guide / book / report it can produce and verify) or a person (an agent-prepared CMA)
  fulfilment       text        NOT NULL DEFAULT 'system'
    CONSTRAINT lead_magnet_promises_fulfilment_check CHECK (fulfilment IN ('system', 'human')),
  -- the consent the request carried: the person asked for the asset on the form (email delivery of what they requested);
  -- a TCPA phone consent is recorded beside it when the form collected one
  consent_basis    text        NOT NULL
    CONSTRAINT lead_magnet_promises_consent_basis_check
    CHECK (consent_basis IN ('requested_by_form', 'requested_with_tcpa_consent')),
  channels         text[]      NOT NULL DEFAULT '{}',
  status           text        NOT NULL DEFAULT 'promised'
    CONSTRAINT lead_magnet_promises_status_check
    CHECK (status IN ('promised', 'delivering', 'asset_missing', 'awaiting_human', 'failed', 'delivered', 'cancelled')),
  due_at           timestamptz NOT NULL DEFAULT now(),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at  timestamptz NULL,
  next_attempt_at  timestamptz NULL,
  last_error       text        NULL,
  delivered_at     timestamptz NULL,
  delivered_via    text        NULL
    CONSTRAINT lead_magnet_promises_delivered_via_check
    CHECK (delivered_via IS NULL OR delivered_via IN ('email', 'portal', 'email_and_portal', 'human_attested')),
  -- the final evidence: provider message id, portal card id, the asset url that went out, the attesting user
  evidence         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  escalated_at     timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- ONE request, ONE promise (a retried / double-posted capture of the same submission reuses it)
  CONSTRAINT lead_magnet_promises_submission_unique UNIQUE (submission_id),
  -- "delivered" is never a bare flag: it names when, through what, and the asset that went out
  CONSTRAINT lead_magnet_promises_delivered_shape
    CHECK (status <> 'delivered' OR (delivered_at IS NOT NULL AND delivered_via IS NOT NULL AND evidence ? 'asset_url'))
);

COMMENT ON TABLE public.lead_magnet_promises IS
  'Wave 146 (146F, owner ruling 10, contract C4): every lead-magnet request that promised an asset — source form/campaign, recipient (contact + person), the promised asset + version, consent basis, channel, status, attempts, failure and the final delivery evidence. Never "delivered" without the asset. Writer: lib/lead-magnets/promised-deliverables.ts.';

CREATE INDEX IF NOT EXISTS lead_magnet_promises_open_idx
  ON public.lead_magnet_promises (brokerage_id, status, due_at)
  WHERE status NOT IN ('delivered', 'cancelled');
CREATE INDEX IF NOT EXISTS lead_magnet_promises_contact_idx
  ON public.lead_magnet_promises (brokerage_id, contact_id, form_id, created_at DESC);

ALTER TABLE public.lead_magnet_promises ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_magnet_promises_tenant_read ON public.lead_magnet_promises
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.lead_magnet_promises FROM authenticated, anon;
GRANT SELECT ON public.lead_magnet_promises TO authenticated;

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.lead_magnet_promises'::regclass ORDER BY 1;
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.lead_magnet_promises'::regclass;
--   SELECT count(*) FROM public.lead_magnet_promises;   -- 0 on first apply (no backfill: 0 live submissions 2026-10-29)
