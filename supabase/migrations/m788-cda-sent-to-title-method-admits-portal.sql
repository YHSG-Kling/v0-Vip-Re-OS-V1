-- ── APPLIED LIVE 2026-10-19 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — one batched call (the MCP accepts ALTER TABLE … DROP CONSTRAINT) ──
--
-- m788 — THE SIGNED CDA DELIVERED TO THE TITLE PORTAL INBOX IS A RECORDED DELIVERY METHOD
-- (wave 142, lane 142C). Owner verbatim (2026-10-18): "Delivery: title on the Deal Team → authorized
-- title portal inbox with evidence; title outside → existing configured outbound email (GHL/SMTP already
-- configured; no SMTP server) with tracked status; never duplicate delivery on retry."
--
-- AUDITED AT HEAD fec8b6a95: closing_disclosure_agreement.sent_to_title_method is CHECKed to
-- docusign | dotloop | email | manual (scripts/check-vocabularies.ts:457). The portal route — the
-- signed CDA placed in the title company's portal (a transaction_documents row the title portal lists)
-- plus the bell to the title user's account — had no value to record under, so
-- app/actions/cda-portal.ts sendCdaToTitleAction could only record an email. This widens the CHECK by
-- ONE value; nothing is renamed and no row changes.
--
-- WRITER: app/actions/cda-portal.ts sendCdaToTitleAction (method 'portal' when lib/transactions/
-- cda-closing-policy.ts cdaDeliveryRoute resolves the title company to a title_company_users row for
-- the transaction). Until this file is applied the write is refused (23514), the action READS the
-- refusal and reports delivery_not_recorded — never a silent success.
-- READERS: the CDA record (getCdaForTransactionAction), the compliance queue, the delivery reaper.
--
-- PART 1 (CHECK) — one ALTER, atomic.
ALTER TABLE public.closing_disclosure_agreement
  DROP CONSTRAINT IF EXISTS closing_disclosure_agreement_sent_to_title_method_check,
  ADD CONSTRAINT closing_disclosure_agreement_sent_to_title_method_check
    CHECK (sent_to_title_method IN ('docusign', 'dotloop', 'email', 'manual', 'portal'));

COMMENT ON COLUMN public.closing_disclosure_agreement.sent_to_title_method IS
  'docusign | dotloop | email | manual | portal — how the signed CDA reached title; portal = the title company''s portal inbox (title on the deal team), m788 wave 142.';

-- PART 2 (indexes / triggers) — none.
