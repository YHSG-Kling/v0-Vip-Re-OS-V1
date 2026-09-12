-- m291-transaction-deal-ladder.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER-STATED DEAL PROCESS (transactions, not listings):
--
--   under contract → pending → clear to close → closed / sold → funded
--
-- transactions.status admitted lead | qualifying | active | under_contract |
-- closing | closed | lost | archived. Three of the five states an agent actually
-- chases were unrepresentable:
--
--   pending         contingencies cleared — the deal is off inspection/financing risk
--   clear_to_close  the lender issued CTC — docs to title, figures final
--   funded          the loan disbursed and the money moved
--
-- `closed` and `funded` are not the same day and not the same risk: the agent is
-- paid at funded, which is precisely why the commission ledger cares.
--
-- `closing` is retired. It is a scheduling word, not a milestone — it cannot say
-- whether the lender has signed off — and it is what five surfaces hand-rolled as
-- ["under_contract", "closing"] to mean "a live deal", silently missing the two
-- states in between. It maps onto clear_to_close.
--
-- The coordinator's status colour map already had `case "pending"` and
-- `case "clear_to_close"` branches: the UI was written against this process
-- before the column could store it.
--
-- Order matters — the data moves BEFORE the new constraint lands, or the row
-- still reading 'closing' would be rejected by it.

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;

UPDATE public.transactions SET status = 'clear_to_close' WHERE status = 'closing';

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check CHECK (
    status = ANY (ARRAY[
      'lead',
      'qualifying',
      'active',
      'under_contract',   -- contingencies live
      'pending',          -- m291: contingencies cleared
      'clear_to_close',   -- m291: lender CTC issued (replaces 'closing')
      'closed',           -- signed and recorded
      'funded',           -- m291: loan disbursed — the agent is paid here
      'lost',
      'archived'
    ])
  );
