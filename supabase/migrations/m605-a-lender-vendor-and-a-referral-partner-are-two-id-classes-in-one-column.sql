-- supabase/migrations/m605-a-lender-vendor-and-a-referral-partner-are-two-id-classes-in-one-column.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- ✅ APPLIED LIVE 2026-09-04 to hrvaqgvukzxfskkcrwbt by the integrator.
--    (CLAUDE.md §3: lanes write migrations, the integrator applies them.)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─── THE DEFECT: ONE COLUMN, TWO ID CLASSES, TWO PANELS ─────────────────────
--
-- `buyer_financial_profiles.lender_referred_partner_id` FKs
-- `referral_partners` (scripts/schema-fk-map.ts). TWO different surfaces write
-- and read it, and they do not agree on what an id in it means:
--
--   app/crm/contacts/[contactId]/components/financial-verification-panel.tsx
--     lists loadMortgageBrokers() → referral_partners rows filtered
--     partner_type='mortgage_broker' AND agent_id = the AGENT'S OWN agents.id.
--     It passes `partnerId: partner.id` — a referral_partners id. CORRECT.
--
--   app/crm/components/financial-verification-panel.tsx
--     lists getBrokerageLenders() → `vendors` rows whose category is on
--     LENDER_BENCH_CATEGORIES — the BROKERAGE'S lender bench. It passes
--     `partnerId: selectedLender.id`, a vendors.id, into the same parameter,
--     AND reads the column straight back into its vendor picker at :108.
--     Every write from that panel is a 23503 that loses the WHOLE statement
--     (PGRST/Postgres refuses the row, not the column), so the introduction is
--     recorded in `credit_partner_referrals` and an `activities` row while the
--     buyer's own profile keeps no lender at all — and on reload the picker
--     restores nothing.
--
-- IT HAS NEVER FIRED IN ANGER because the tables are empty pre-rollout:
-- buyer_financial_profiles 0 rows, referral_partners 0 rows,
-- credit_partner_referrals 0 rows, measured 2026-09-04. So there is no data to
-- repair — only a shape to fix before the first real use.
--
-- ─── THESE ARE NOT DUPLICATES. BOTH RAILS ARE REAL (§1, §6) ─────────────────
--
-- The tempting reading is "two spellings of a lender, merge them". They are not:
--
--   vendors (category lender / refinance_lender)  — the BROKERAGE'S bench. One
--     per brokerage, shared by every agent, gated by
--     lib/kernel/portal-auth.ts#requireLenderVendorActor, and since the owner's
--     2026-09-04 ruling ("lender is not a user type, it is a vendor category")
--     this is where lender IDENTITY lives.
--   referral_partners (partner_type mortgage_broker) — an INDIVIDUAL AGENT'S
--     own referral list, scoped `.eq('agent_id', ctx.agentId)`, which is why
--     loadMortgageBrokers refuses outright for a seat with no agent profile
--     ("Lender referrals are kept per agent").
--
-- A brokerage bench and an agent's personal rolodex are different business
-- objects with different tenancy. §6 forbids two spellings of ONE idea, not two
-- ideas — so the fix is the missing COLUMN (§1.2 BUILD), not a merge.
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--
-- `lender_referred_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL`,
-- so each rail writes and reads its own id class. Nullable, with no default and
-- no backfill: the column that exists means "we introduced this buyer to a
-- lender on the brokerage's bench", and NULL means we did not. A vendor row
-- being deleted must not delete a buyer's financial profile, hence SET NULL
-- rather than CASCADE — the referral history survives in
-- credit_partner_referrals either way.
--
-- The two columns are deliberately NOT mutually exclusive by constraint. A buyer
-- can be introduced to the brokerage's bench lender AND to their agent's own
-- mortgage broker; recording both is information, and a CHECK forbidding it
-- would refuse a legitimate second introduction with a constraint violation the
-- surface would report as a failed referral.

begin;

ALTER TABLE public.buyer_financial_profiles
  ADD COLUMN IF NOT EXISTS lender_referred_vendor_id uuid
    REFERENCES public.vendors(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.buyer_financial_profiles.lender_referred_vendor_id IS
  'The BROKERAGE-BENCH lender this buyer was introduced to — vendors.id, whose category is on LENDER_BENCH_CATEGORIES (lender / refinance_lender). Its sibling lender_referred_partner_id is a referral_partners id: an INDIVIDUAL AGENT''S own mortgage-broker rolodex, scoped per agents.id. Two different business objects with two different tenancies, so two columns; before m605 the brokerage-bench panel wrote a vendors.id into the referral_partners FK and every one of those writes was a 23503 that lost the whole statement. NULL means no introduction on that rail — the two are independent and a buyer may legitimately have both.';

-- Partial index: the lookup is always "which buyers did we send to this lender",
-- and the overwhelming majority of rows will carry NULL here.
CREATE INDEX IF NOT EXISTS idx_buyer_financial_profiles_lender_vendor
  ON public.buyer_financial_profiles (lender_referred_vendor_id)
  WHERE lender_referred_vendor_id IS NOT NULL;

-- ─── VERIFY, RATHER THAN HOPE (CLAUDE.md §7) ───────────────────────────────
DO $$
DECLARE
  v_fk_target text;
  v_partner_fk text;
BEGIN
  -- The new column points at vendors …
  SELECT ccu.table_name INTO v_fk_target
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name  = 'buyer_financial_profiles'
    AND kcu.column_name = 'lender_referred_vendor_id'
  LIMIT 1;

  IF v_fk_target IS DISTINCT FROM 'vendors' THEN
    RAISE EXCEPTION 'lender_referred_vendor_id must FK vendors, found %', coalesce(v_fk_target, '(no FK at all)');
  END IF;

  -- … and the OLD column still points at referral_partners. This is the
  -- POSITIVE CONTROL for the probe above: it proves the FK reader can see a
  -- DIFFERENT target on the same table, so its verdict on the new column is
  -- evidence rather than a query that returns whatever it is asked about.
  SELECT ccu.table_name INTO v_partner_fk
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name  = 'buyer_financial_profiles'
    AND kcu.column_name = 'lender_referred_partner_id'
  LIMIT 1;

  IF v_partner_fk IS DISTINCT FROM 'referral_partners' THEN
    RAISE EXCEPTION 'POSITIVE CONTROL FAILED — lender_referred_partner_id should still FK referral_partners, found %',
      coalesce(v_partner_fk, '(none)');
  END IF;

  RAISE NOTICE 'buyer_financial_profiles now carries both id classes, each pointing at its own table';
END $$;

commit;
