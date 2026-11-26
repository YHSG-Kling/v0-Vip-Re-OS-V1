-- ── APPLIED LIVE 2026-11-11 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 152, lane 152F ──
--
-- m953 — THE REQUESTED-SIGNATURES DOOR FOR A PROPOSED ADDENDUM HAS A HOME ON THE EXISTING REQUEST TABLE (wave 152, lane 152F).
--
-- Owner (verbatim, wave 152): "the requested signatures on a proposed addendum door needs to be built as it says not implemented."
--
-- AUDIT FIRST (CLAUDE.md §1 — extend the survivor, never a second request table):
--   · public.signature_requests IS the transaction-scoped e-sign request record: provider_envelope_id (idx_signature_requests_envelope),
--     all_parties + signing_order (jsonb), sent_at / expires_at / completed_at, request_status. Its readers already do the right thing
--     for an addendum out for signature: lib/transactions/final-compliance-check.ts counts an OPEN request (pending / sent /
--     partially_signed) on the transaction as a closing blocker; lib/kernel/os-health.ts flags one past its expiry as a stuck workflow;
--     lib/kernel/ingress-continuity.ts does not park a webhook whose envelope it holds; lib/esign-webhooks/finalize-packet.ts completes
--     it by envelope. Live rows: 0 (read 2026-11-11), no trigger on the table.
--   · public.contract_term_versions (m797, m986) IS the proposed addendum: source addendum | amendment, status `proposed`; m986 freezes
--     an EXECUTED row only, so a proposal stays editable until it is closed. The executed record is written by the ONE recorder,
--     lib/offers/governing-terms.ts recordContractTermsVersion — this migration adds nothing to that table.
--   · MISSING, and nothing else can hold it:
--       (1) WHICH proposed version a request asks signatures for — no column links a request to a contract term version, so a
--           provider completion could not find the addendum it executes (a jsonb path in another table's evidence is neither an FK
--           nor tenant-checkable, and cannot carry a uniqueness rule);
--       (2) the request's own evidence — which vendor carried the envelope (the poll and the void must reach THAT account), the packet
--           fingerprint at send, the delivered / viewed instants, the provider's failure or void reason, and the signed copy's
--           sha256 pinned at its first authenticated retrieval (an altered copy offered later is refused against it);
--       (3) two outcomes the vocabulary cannot say: a party DECLINED (a terminal provider outcome, not a withdrawal), and the request
--           FAILED (our dispatch was refused, or the provider could not deliver) — today either would have to be written as
--           `cancelled` (a lie about who stopped it) or left `pending` (a lie that it is still going).
--
-- WHAT THIS ADDS (additive only; 0 live rows):
--   1. signature_requests.contract_term_version_id uuid → contract_term_versions(id) ON DELETE SET NULL (+ index).
--   2. signature_requests.evidence jsonb NOT NULL DEFAULT '{}' — the request's record (shape owned by lib/esign/addendum-signature-request.ts).
--   3. ONE LIVE REQUEST PER PROPOSED VERSION, held by the database: a partial unique index over the open statuses. The door CLAIMS this
--      row before it calls the provider, so a replayed or double-clicked send is refused 23505 and returns the request already out —
--      never a second envelope. A failed / declined / expired / cancelled request leaves the index and a new one may be made.
--   4. request_status admits 'declined' and 'failed'. The CHECK is RENAMED to the <table>_<column>_check convention
--      (signature_requests_status_check → signature_requests_request_status_check) so test:check-vocabulary reads the queued values of
--      this WRITTEN-NOT-APPLIED file. ONE code constant is the source of the vocabulary:
--      lib/esign/addendum-signature-rules.ts SIGNATURE_REQUEST_STATUSES.
--      Deliberately NOT added — kept on the survivor's own spelling (CLAUDE.md §6, the packet-states.ts precedent): the provider's
--      "voided" is this table's `cancelled`; "delivered" / "viewed" stay `sent` with the instant stamped in `evidence` (every open-status
--      reader — final-compliance-check, os-health, the client portal — keeps matching the request without learning a new word).
--
-- PRE-CHECK (read-only; expect 0 / 0):
--   SELECT count(*) FROM public.signature_requests WHERE request_status NOT IN ('pending','sent','partially_signed','completed','cancelled','expired');
--   SELECT count(*) FROM pg_constraint WHERE conname = 'signature_requests_request_status_check';
--
-- ROLLBACK (only while no row carries the new values / column):
--   DROP INDEX public.signature_requests_one_live_per_version_uidx;            -- owner SQL (DROP INDEX)
--   DROP INDEX public.signature_requests_contract_term_version_idx;            -- owner SQL (DROP INDEX)
--   ALTER TABLE public.signature_requests DROP CONSTRAINT signature_requests_request_status_check;
--   ALTER TABLE public.signature_requests ADD CONSTRAINT signature_requests_status_check
--     CHECK (request_status IN ('pending','sent','partially_signed','completed','cancelled','expired'));
--   ALTER TABLE public.signature_requests DROP COLUMN evidence, DROP COLUMN contract_term_version_id;   -- owner SQL (DROP COLUMN)
--
-- After apply: regenerate schema-snapshot.ts, schema-fk-map.ts and check-vocabularies.ts (CLAUDE.md §3).

-- ══ PART A — the linkage and the request's evidence ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS contract_term_version_id uuid NULL REFERENCES public.contract_term_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.signature_requests.contract_term_version_id IS
  'm953 (wave 152, lane 152F): the PROPOSED addendum / amendment (contract_term_versions, status proposed) this request asks signatures for. Completion records the executed version through lib/offers/governing-terms.ts recordContractTermsVersion — never by editing this link.';
COMMENT ON COLUMN public.signature_requests.evidence IS
  'm953 (wave 152, lane 152F): the request''s own record — provider, packet fingerprint at send, delivered / viewed instants, failure / void reason, the signed copy''s sha256 pinned at first authenticated retrieval, the executed version it became. Shape: lib/esign/addendum-signature-request.ts.';

CREATE INDEX IF NOT EXISTS signature_requests_contract_term_version_idx
  ON public.signature_requests (contract_term_version_id) WHERE contract_term_version_id IS NOT NULL;

-- ══ PART B — one live request per proposed version (the replay guard) ═══════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS signature_requests_one_live_per_version_uidx
  ON public.signature_requests (contract_term_version_id)
  WHERE contract_term_version_id IS NOT NULL AND request_status IN ('pending', 'sent', 'partially_signed');

-- ══ PART C — the vocabulary: + declined, + failed (renamed to the <table>_<column>_check convention) ═══════════════════════════
ALTER TABLE public.signature_requests DROP CONSTRAINT IF EXISTS signature_requests_status_check;
ALTER TABLE public.signature_requests DROP CONSTRAINT IF EXISTS signature_requests_request_status_check;
ALTER TABLE public.signature_requests
  ADD CONSTRAINT signature_requests_request_status_check
  CHECK (request_status IN ('pending', 'sent', 'partially_signed', 'completed', 'cancelled', 'expired', 'declined', 'failed'));

-- READ-BACK (after apply):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'signature_requests' AND column_name IN ('contract_term_version_id', 'evidence');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.signature_requests'::regclass AND contype IN ('c', 'f');
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'signature_requests' AND indexname LIKE 'signature_requests_%version%';
