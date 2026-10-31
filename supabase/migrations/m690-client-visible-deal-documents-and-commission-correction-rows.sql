-- ── APPLIED LIVE 2026-10-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — part 1 (columns, CHECKs) as m690a apply_migration; part 2 (indexes incl. corrected_by, client-upload trigger) via execute_sql with lock_timeout; corrected_by FK users ON DELETE SET NULL and adjusts_distribution_id ON DELETE CASCADE added by the integrator ──
--
-- m690 — two owner rulings (wave 98, 2026-10-03), apply in TWO parts (PART 1 columns/constraints,
-- PART 2 index + trigger). Live read 2026-10-03 (lane 98A): transaction_documents 0 rows, no
-- visibility column (columns: … metadata, notes, uploaded_by uuid, uploaded_by_type text …);
-- commission_distributions 0 rows, no entry-type / adjusts column, CHECK calculated_amount >= 0.
--
-- (1) CLIENT-VISIBLE DEAL DOCUMENTS ("yes and the docs they uploaded"). A portal client sees a deal
--     document only when staff marked it client_visible, or when the client uploaded it themselves
--     (uploaded_by = their own user). Default FALSE: deny by default. The deny-by-type list (CDA /
--     commission / disbursement / internal) is CODE — lib/kernel/portal.ts isClientHiddenDealDocType —
--     and wins over the flag. Writers: the staff toggle (app/actions/transactions.ts
--     setDocumentClientVisibility) and, for a row a client uploads, the trigger in PART 2.
--
-- (2) COMMISSION CORRECTION ("yes build commission correction screen"). m689 made a POSTED (paid)
--     commission_distributions row append-only; a correction is a NEW row: entry_type 'reversal'
--     (negates the entry's current net) or 'adjustment' (the signed delta to a corrected amount),
--     linked to the original by adjusts_distribution_id, with a required reason. Only a correction
--     row may carry a negative amount. Writer: lib/kernel/financial.ts correctCommissionDistribution
--     (finance-admin gate, session tenant). No FK to users on corrected_by on purpose: an audit stamp
--     must survive the user's deletion and must not add a users child to the FK ledgers.
--
-- Code depending on it (same lane): app/portal/[contactId]/documents/page.tsx, app/actions/portal-seller.ts
-- getSellerDocuments, app/actions/documents.ts getDocumentWithAnalysis (read client_visible — until
-- PART 1 is applied those reads are REFUSED 42703 and the portal shows no deal documents: fail closed);
-- correctCommissionDistribution (PGRST204 refusal until applied — the action reports it).

-- ════ PART 1 — columns + constraints ═══════════════════════════════════════════════════════════

ALTER TABLE public.transaction_documents
  ADD COLUMN IF NOT EXISTS client_visible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.transaction_documents.client_visible IS
  'Staff marked this deal document visible in the client portal (wave 98). Deny by default; the code deny-list (lib/kernel/portal.ts isClientHiddenDealDocType) wins over it.';

ALTER TABLE public.commission_distributions
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'entry',
  ADD COLUMN IF NOT EXISTS adjusts_distribution_id uuid REFERENCES public.commission_distributions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS correction_reason text,
  ADD COLUMN IF NOT EXISTS corrected_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.commission_distributions
  DROP CONSTRAINT IF EXISTS commission_distributions_entry_type_check;
ALTER TABLE public.commission_distributions
  ADD CONSTRAINT commission_distributions_entry_type_check
  CHECK (entry_type = ANY (ARRAY['entry'::text, 'reversal'::text, 'adjustment'::text]));

ALTER TABLE public.commission_distributions
  DROP CONSTRAINT IF EXISTS commission_distributions_correction_shape_check;
ALTER TABLE public.commission_distributions
  ADD CONSTRAINT commission_distributions_correction_shape_check
  CHECK (
    (entry_type = 'entry' AND adjusts_distribution_id IS NULL)
    OR (entry_type <> 'entry'
        AND adjusts_distribution_id IS NOT NULL
        AND adjusts_distribution_id <> id
        AND correction_reason IS NOT NULL
        AND length(btrim(correction_reason)) > 0)
  );

-- Only a correction row may be negative (a reversal / a downward adjustment).
ALTER TABLE public.commission_distributions
  DROP CONSTRAINT IF EXISTS commission_distributions_calculated_amount_check;
ALTER TABLE public.commission_distributions
  ADD CONSTRAINT commission_distributions_calculated_amount_check
  CHECK (calculated_amount >= (0)::numeric OR entry_type <> 'entry');

-- ════ PART 2 — index + trigger ══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS commission_distributions_adjusts_distribution_id_idx
  ON public.commission_distributions (adjusts_distribution_id)
  WHERE adjusts_distribution_id IS NOT NULL;

-- A document the CLIENT uploaded is theirs to see: stamp client_visible on insert.
CREATE OR REPLACE FUNCTION public.transaction_document_client_upload_is_visible()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.uploaded_by_type = 'client' THEN
    NEW.client_visible := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transaction_document_client_upload_is_visible ON public.transaction_documents;
CREATE TRIGGER transaction_document_client_upload_is_visible
  BEFORE INSERT ON public.transaction_documents
  FOR EACH ROW EXECUTE FUNCTION public.transaction_document_client_upload_is_visible();
