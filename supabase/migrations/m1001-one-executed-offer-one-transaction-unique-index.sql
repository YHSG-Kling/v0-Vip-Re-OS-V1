-- m1001 — ONE EXECUTED CONTRACT BECOMES ONE TRANSACTION, ATOMICALLY (wave 156, lane 156B). WRITTEN, NOT APPLIED — the
-- integrator applies additive migrations.
--
-- INTENT. The offer → transaction bridge (lib/transactions/offer-bridge.ts createTransactionFromOffer) refused a second
-- transaction for one contract only by READING first (the creation gate's governing-packet check: "this contract already
-- became transaction …"). A read cannot see a racing twin: two deliveries of the same e-sign completion webhook, or the
-- webhook and the agent's click at the same moment, both read "no transaction yet" and both insert. This index makes the
-- database the arbiter: the second INSERT is refused with 23505, and the bridge reads back the winner and reports it as a
-- replay instead of creating, or claiming, a second deal. The idempotency unit is (tenant, offer id); a counter-offer or a
-- re-executed contract is a new offers row, so (tenant, head offer id) is (tenant, contract version).
--
-- ADDITIVE AND SAFE TO APPLY: a new partial unique index, nothing dropped or rewritten. Measured live 2026-11-25 on
-- hrvaqgvukzxfskkcrwbt: transactions 2 rows, 0 with offer_id, 0 duplicate (brokerage_id, offer_id) groups — the build
-- cannot fail on existing data. Soft-deleted rows (deleted_at set) are outside the index, so a voided deal does not block
-- the contract's legitimate re-creation through the gate. Manual / listing-intake rows carry no offer_id and are untouched.
--
-- ROLLBACK: DROP INDEX IF EXISTS public.transactions_one_per_offer_uq;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_per_offer_uq
  ON public.transactions (brokerage_id, offer_id)
  WHERE offer_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX public.transactions_one_per_offer_uq IS
  'wave 156 (156B): one executed offer (tenant, head offer id) creates at most one live transaction; the bridge reads the winner back on 23505.';
