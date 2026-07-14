-- l54-s01: THE SIGNING INVITE HAS A HOME (owner rule: the Sign button only
-- appears when an ACTIVE packet exists, and clicking it goes to the invite).
-- Providers return a signing URL transiently (send-for-esign adapter output)
-- but nothing persisted it — the portal had no way to route a signer to
-- their envelope. Nullable by design: email-only providers leave it null and
-- the UI falls back to "check your email" guidance on the SAME packet card.
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signing_url text;
ALTER TABLE contract_signatures ADD COLUMN IF NOT EXISTS signing_url text;
