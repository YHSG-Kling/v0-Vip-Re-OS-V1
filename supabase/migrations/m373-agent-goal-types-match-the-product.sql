-- m373 — four of the six buttons on the live goals page wrote a value the CHECK refuses
--
-- app/dashboard/goals/goals-client.tsx offers six goal types:
--   transactions, gci, listings_taken, buyer_clients,
--   referrals_generated, reviews_requested
--
-- agent_goals_goal_type_check admitted:
--   gross_commission, transactions_closed, listings_taken, buyer_clients,
--   new_contacts, conversion_rate, avg_days_to_close
--
-- Only listings_taken and buyer_clients appear in both. Setting any of the other
-- four on the shipped page was refused with SQLSTATE 23514. This is the classic
-- shape on this project: a name that says one thing while the value means
-- another, with nothing failing loudly enough to notice.
--
-- TWO DIFFERENT PROBLEMS, FIXED TWO DIFFERENT WAYS.
--
-- 'transactions' and 'gci' are SPELLING drift — the constraint already has the
-- concepts under the names transactions_closed and gross_commission. Those are
-- corrected in code onto the canonical spellings; no migration needed, and the
-- constraint is left alone so the canonical names stay the only ones.
--
-- 'referrals_generated' and 'reviews_requested' are MISSING CAPABILITY, not
-- drift. There is no synonym for them in the constraint, and the product is
-- already doing the work: syncGoalCurrentValues computes both from real tables
-- (referrals and review_requests) on every run, then writes them to goal rows
-- the database refuses to hold. The standing rule is that an unfinished
-- capability is work to FINISH, not to delete — deleting the two buttons would
-- have thrown away a measurement the OS already performs. So the vocabulary
-- grows to match the product.
--
-- Nothing is removed. new_contacts, conversion_rate and avg_days_to_close stay
-- admitted even though no surface offers them yet; they are storable targets a
-- later screen can expose, and dropping them would be exactly the kind of quiet
-- capability loss this project has been correcting.
--
-- Verified before writing: agent_goals holds 0 rows, so widening the CHECK
-- cannot invalidate existing data.

ALTER TABLE public.agent_goals
  DROP CONSTRAINT IF EXISTS agent_goals_goal_type_check;

ALTER TABLE public.agent_goals
  ADD CONSTRAINT agent_goals_goal_type_check
  CHECK (goal_type = ANY (ARRAY[
    'gross_commission'::text,
    'transactions_closed'::text,
    'listings_taken'::text,
    'buyer_clients'::text,
    'new_contacts'::text,
    'conversion_rate'::text,
    'avg_days_to_close'::text,
    'referrals_generated'::text,
    'reviews_requested'::text
  ]));
