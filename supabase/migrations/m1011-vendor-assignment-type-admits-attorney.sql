-- m1011 — A CLOSING ATTORNEY JOINS A DEAL AS AN ATTORNEY, NOT AS "OTHER" (wave 156, lane 156D round 2 — APPLIED LIVE 2026-11-25 via Supabase MCP (project hrvaqgvukzxfskkcrwbt)).
--
-- CLAUDE.md §6, one vocabulary per function. vendors.category has admitted 'attorney' since m304, but
-- vendor_assignments.assignment_type (the deal-ledger subset) never did, so an attorney vendor assigned to a deal had to be
-- typed 'other' — and nothing downstream could tell counsel from a handyman. This EXTENDS the live CHECK by exactly one value,
-- spelled as the vendor category spells it. The counsel role and whom they represent stay on transaction_participants (m1010).
--
-- Live definition read 2026-11-25 (project hrvaqgvukzxfskkcrwbt, pg_constraint):
--   CHECK ((assignment_type = ANY (ARRAY['inspector','lender','title','stager','photographer','cleaner','contractor','mover','insurance','other'])))
-- New definition: the same ten values plus 'attorney'. Strictly wider — every existing row still satisfies it. Additive.
--
-- Readers / writers: app/actions/vendors-kernel.ts VENDOR_ASSIGNMENT_TYPES (the action's gate) and
-- app/dashboard/vendors/vendor-directory-client.tsx (the picker) gain 'attorney'; lib/application/transactions.ts
-- recordClosingParty types an on-platform attorney's assignment 'attorney'. After applying, regenerate scripts/check-vocabularies.ts.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vendor_assignments_assignment_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''attorney''%'
  ) THEN
    ALTER TABLE public.vendor_assignments DROP CONSTRAINT IF EXISTS vendor_assignments_assignment_type_check;
    ALTER TABLE public.vendor_assignments ADD CONSTRAINT vendor_assignments_assignment_type_check
      CHECK (assignment_type = ANY (ARRAY['inspector','lender','title','stager','photographer','cleaner','contractor','mover','insurance','other','attorney']));
  END IF;
END $$;

-- READBACK: SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'vendor_assignments_assignment_type_check';
-- ROLLBACK (only if no row uses 'attorney'): re-add the ten-value CHECK above.
