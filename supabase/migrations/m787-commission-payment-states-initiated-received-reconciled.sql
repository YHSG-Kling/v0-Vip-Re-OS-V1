-- ── APPLIED LIVE 2026-10-19 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — one batched call (the MCP accepts ALTER TABLE … DROP CONSTRAINT) ──
--
-- m787 — COMMISSION PAYMENT STATES: initiated · received (the agent's attestation) · reconciled
-- (wave 142, lane 142C). Owner verbatim (2026-10-18): "Track: expected · preliminary · approved/final ·
-- payment_initiated · payment_recorded · payment_received/verified · reconciled/settled. Manual agent
-- receipt confirmation = attestation (amount, date, payer, method, evidence). QuickBooks match only
-- against the ACTUAL connected integration. Corrections = linked adjustment/reversal entries."
--
-- AUDITED AT HEAD fec8b6a95: agent_commissions.status is CHECKed to pending | approved | paid | disputed
-- (COMMISSION_LEDGER_STATUSES, lib/commission/ledger-sync.ts) and is MIRRORED onto commission_splits and
-- the seven-year deal stamp transaction_commissions by lib/kernel/financial.ts. Widening that status
-- would fork three mirrors and every finance proof; the owner's seven states are instead DERIVED (pure
-- deriveCommissionPaymentState, lib/commission/ledger-sync.ts) from status + the timestamps the row
-- already carries (deposit_received_at, paid_at, quickbooks_synced_at) + the three stamps this
-- migration adds. The status vocabulary is unchanged; the ledger stays append-only on
-- commission_distributions (m689); corrections stay adjustment/reversal rows (m690).
--
--   payment_initiated_at        — the brokerage issued the payout instruction (check cut / direct
--                                 deposit submitted); stamped by lib/kernel/financial.ts
--                                 initiateCommissionPayout, and by markCommissionPaid when the broker
--                                 records the payout in one step (initiation and record coincide)
--   payment_received_at / _by / — the AGENT's attestation that the money arrived (amount, date, payer,
--   payment_received_attestation  method, reference, evidence url, whether the amount matches the ledger
--                                 net) — lib/kernel/financial.ts attestCommissionReceived; the agent
--                                 who owns the row, or a finance admin on their behalf
--   reconciled_at / _by / _via / — the payout reconciled against the ACTUAL connected accounting
--   reconciled_reference          integration ('quickbooks' requires the row's quickbooks_synced_at —
--                                 the export the integration confirmed; a bookkeeping entry is not
--                                 verified funds) or a manual bank/statement reference ('manual') —
--                                 lib/kernel/financial.ts reconcileCommissionPayment, finance admin
--
-- READERS: deriveCommissionPaymentState (the finance commissions page badge, the agent's own commissions
-- panel), lib/kernel/financial.ts (gates: initiate needs approved; attest/reconcile need paid).
-- FKs: both *_by columns reference users(id) (a *_by uuid without its FK is an orphaned child).
--
-- PART 1 (columns + CHECK) — additive, nullable, idempotent; no row changes.
ALTER TABLE public.agent_commissions
  ADD COLUMN IF NOT EXISTS payment_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_received_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_received_attestation jsonb,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reconciled_via text,
  ADD COLUMN IF NOT EXISTS reconciled_reference text;

ALTER TABLE public.agent_commissions
  DROP CONSTRAINT IF EXISTS agent_commissions_reconciled_via_check,
  ADD CONSTRAINT agent_commissions_reconciled_via_check
    CHECK (reconciled_via IN ('manual', 'quickbooks'));

COMMENT ON COLUMN public.agent_commissions.payment_initiated_at IS
  'The brokerage issued the payout instruction (check / direct deposit) — initiateCommissionPayout, or markCommissionPaid when recorded in one step (m787, wave 142).';
COMMENT ON COLUMN public.agent_commissions.payment_received_at IS
  'The agent attested the payment arrived (payment_received_attestation carries amount / date / payer / method / reference) — attestCommissionReceived (m787).';
COMMENT ON COLUMN public.agent_commissions.payment_received_attestation IS
  '{ amount, received_at, payer, method, reference, evidence_url, attested_by, attested_at, amount_matches_ledger } — the agent''s receipt attestation (m787).';
COMMENT ON COLUMN public.agent_commissions.reconciled_at IS
  'The payout reconciled: via quickbooks (requires quickbooks_synced_at — the ACTUAL connected integration) or manual (a bank/statement reference) — reconcileCommissionPayment (m787).';
COMMENT ON COLUMN public.agent_commissions.reconciled_via IS 'quickbooks | manual (m787).';

-- PART 2 (indexes) — the finance sweeps read by brokerage + status; the new stamps are read per row.
-- None added.
