-- l54-s02: the packet ↔ envelope linkage. The provider webhooks arrive with an
-- envelope/loop id; signature_requests had no column to match it, so a signed
-- envelope could never complete its packet (the Sign button lingered on signed
-- docs until expiry). contract_signatures already carries provider_envelope_id.
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS provider_envelope_id text;
CREATE INDEX IF NOT EXISTS idx_signature_requests_envelope ON signature_requests (provider_envelope_id) WHERE provider_envelope_id IS NOT NULL;
