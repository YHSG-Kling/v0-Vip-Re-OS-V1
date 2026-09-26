-- m531a — contacts.contact_persona HELD TWO CONTACT **TYPES**, AND ONE ROW SAID
--         'new' ABOUT A CLIENT WHO CLOSED FOURTEEN MONTHS AGO.
--
-- APPLICATION STATUS: APPLIED, 2026-08-23, by the integrator, BEFORE m531 (this
-- file is m531's precondition — m531 refuses while this residue exists).
--
-- VERIFIED LIVE AFTER APPLYING:
--     contacts whose contact_persona held a contact TYPE ........ 2 → 0
--     Robert Chen ..... persona 'listing_seller' → 'relocated';
--                       contact_type 'seller' UNTOUCHED (the type was already
--                       recorded there, so nothing was lost)
--     James Rodriguez . persona 'past_client' → NULL; contact_type 'both' →
--                       'lifetime_customer'; lifecycle_state 'new' →
--                       'lifetime_customer' — that last one was not cosmetic:
--                       lib/agents/sphere-agent.ts finds lifetime customers BY
--                       lifecycle_state, so 'new' hid this contact from the
--                       sphere and anniversary rail entirely.
--     contacts total ............................................ 4 (unchanged;
--                       this migration moves values between columns, it does
--                       not add or remove people)
--
-- THE PRECONDITION m531 REFUSES WITHOUT. m531's step 2 RAISES on any residue it
-- cannot normalise, and names the owner's call (a) or (b). This file executes
-- (a), which is the option m531's own header recommends on the evidence.
--
-- ── THE OWNER'S RULING, VERBATIM (2026-08-23) ───────────────────────────────
--
--   "you can create your own testing data and then remove after you are done
--    because what is currenlty in the live db is incorrectly labeled and
--    structurally incorrect. lifetime and active seller are contact type not
--    persona. persona is more the situation that the contact or lead is in. the
--    data in the live db is old demo data and doesn't mean anything in todays
--    structure."
--
-- So the axis is settled: contact_type carries WHAT THEY ARE, contact_persona
-- carries WHAT SITUATION THEY ARE IN, or NULL. Two live rows had a type in the
-- persona column.
--
-- ── THE COLUMN CAN ALREADY HOLD IT — MEASURED, NOT ASSUMED ──────────────────
--
--   contacts_contact_type_check admits, live today:
--     lead, prospect, client, lifetime, lifetime_customer, past_client, sphere,
--     vendor, referral_partner, investor, buyer, seller, both, other
--
-- No schema change is owed. The information simply belongs one column over.
--
-- ── ROW 1 · Robert Chen (50000000-…-0002) ───────────────────────────────────
--
--   BEFORE  contact_type='seller'  contact_persona='listing_seller'
--   AFTER   contact_type='seller'  contact_persona='relocated'
--
--   `listing_seller` = "is a seller" + "has a listing with us". BOTH halves are
--   already in the database and NEITHER is in the persona column:
--     · "is a seller"      → contact_type='seller', already correct, untouched.
--     · "has a listing"    → MEASURED: listings e0000000-…-0001, status 'active',
--                            seller_contact_id = this contact's id. That is a
--                            listings ROW, not a contacts string, and it is
--                            exactly what SourceRule 'active_sellers' joins on
--                            (lib/ads/audience-source-rules.ts: contact_type in
--                            SELLER_CONTACT_TYPES + listings.status active).
--   So clearing `listing_seller` deletes NOTHING (CLAUDE.md §1) — every fact it
--   asserted is independently stored and independently queried.
--
--   The persona is not left NULL, because this row DOES name a situation, in its
--   own notes field: "Listing at 742 Evergreen Terrace. Motivated — relocating
--   for work." `relocated` is a member of the canonical Persona union
--   (lib/kernel/types.ts, CAMPAIGN_PERSONAS, campaign_sequences_persona_check),
--   and "relocating for work" is precisely the situation it names. This is read
--   off the row, not invented for it. NULL was the conservative alternative and
--   is a one-word revert if the owner prefers it.
--
-- ── ROW 2 · James Rodriguez (50000000-…-0004) ───────────────────────────────
--
--   BEFORE  contact_type='both'              contact_persona='past_client'
--           lifecycle_state='new'
--   AFTER   contact_type='lifetime_customer' contact_persona=NULL
--           lifecycle_state='lifetime_customer'
--
--   (a) THE TYPE. `past_client` is a lifetime relationship — the owner named it:
--       "lifetime … [is] contact type not persona". It moves to contact_type.
--
--       WHICH SPELLING: `lifetime_customer`, not `past_client` and not
--       `lifetime`, all three of which the CHECK admits (CLAUDE.md §6 — the
--       CHECK carries three spellings of one idea; this file picks the one with
--       the WRITER rather than adding a fourth). The writer is
--       lib/kernel/transactions.ts:1278, which sets contact_type='lifetime_customer'
--       when a deal closes; lib/contact-types.ts declares
--       LIFETIME_CUSTOMER_TYPE = 'lifetime_customer' as "the canonical value
--       going forward" and isLifetimeCustomerType() reads the other three as
--       legacy aliases. Reader side is unaffected either way —
--       LIFETIME_CONTACT_TYPES (lib/kernel/returning-customer.ts), which
--       SourceRule 'lifetime_customers' narrows on, contains all of them.
--
--       WHAT HAPPENS TO 'both': it is DISPLACED, and it was never supported.
--       contact_type is single-valued and cannot hold "buyer+seller" and
--       "lifetime" at once. MEASURED: this contact has ZERO transactions and
--       ZERO listings — nothing in the database corroborates the buyer-and-seller
--       claim. What IS corroborated is the lifetime claim, by the row's own
--       notes: "Closed 14 months ago. Home at 2205 Oak St. Equity est. $47K
--       since purchase." The unsupported label yields to the supported one.
--
--   (b) THE CONTRADICTION. lifecycle_state='new' on a client who closed fourteen
--       months ago is a defect in its own right, and it is not cosmetic: it is
--       the column lib/agents/sphere-agent.ts reads to find lifetime customers
--       ("pulls every lifetime customer — contacts with
--       lifecycle_state='lifetime_customer'"), and the demo seeder
--       lib/platform/demo-tenant.ts writes exactly that value for its two past
--       clients. So 'new' did not merely look wrong; it hid this contact from
--       the sphere/anniversary rail entirely. Corrected to the value its writer
--       and its reader agree on.
--
-- ── THE OTHER TWO ROWS ARE NOT TOUCHED HERE ─────────────────────────────────
-- first_time_buyer → first_time and luxury_buyer → luxury are ALIASES of
-- canonical personas, not types. m531 step 1 normalises them and this file
-- deliberately does not duplicate that (§6: one place, not two).
--
-- ── AFTER THIS, m531 STOPS REFUSING ─────────────────────────────────────────
-- Residue after this file: none. m531 may then be applied.

BEGIN;

-- ── 1 · Robert Chen — the type stays where it already was; the persona becomes
--        the situation the row itself names.
UPDATE public.contacts
   SET contact_persona = 'relocated',
       updated_at      = now()
 WHERE id              = '50000000-0000-0000-0000-000000000002'
   AND contact_persona = 'listing_seller';

-- ── 2 · James Rodriguez — the lifetime fact moves INTO contact_type, the
--        persona empties (no situation is named on this row), and the
--        lifecycle_state stops contradicting it.
UPDATE public.contacts
   SET contact_type    = 'lifetime_customer',
       contact_persona = NULL,
       lifecycle_state = 'lifetime_customer',
       updated_at      = now()
 WHERE id              = '50000000-0000-0000-0000-000000000004'
   AND contact_persona = 'past_client';

-- ── 3 · POSTCONDITIONS. Assert every claim above, including a POSITIVE CONTROL
--        (§2): "0 rows off-canon" reads identically to "the query is broken", so
--        the canon list is proven to still reject something.
DO $$
DECLARE
  v_robert   public.contacts%ROWTYPE;
  v_james    public.contacts%ROWTYPE;
  v_residue  integer;
  v_control  integer;
BEGIN
  SELECT * INTO v_robert FROM public.contacts WHERE id = '50000000-0000-0000-0000-000000000002';
  SELECT * INTO v_james  FROM public.contacts WHERE id = '50000000-0000-0000-0000-000000000004';

  IF v_robert.contact_type IS DISTINCT FROM 'seller' THEN
    RAISE EXCEPTION 'm531a: Robert Chen contact_type moved — expected seller, got %', v_robert.contact_type;
  END IF;
  IF v_robert.contact_persona IS DISTINCT FROM 'relocated' THEN
    RAISE EXCEPTION 'm531a: Robert Chen contact_persona expected relocated, got %', v_robert.contact_persona;
  END IF;
  IF v_james.contact_type IS DISTINCT FROM 'lifetime_customer' THEN
    RAISE EXCEPTION 'm531a: James Rodriguez contact_type expected lifetime_customer, got %', v_james.contact_type;
  END IF;
  IF v_james.contact_persona IS NOT NULL THEN
    RAISE EXCEPTION 'm531a: James Rodriguez contact_persona expected NULL, got %', v_james.contact_persona;
  END IF;
  IF v_james.lifecycle_state IS DISTINCT FROM 'lifetime_customer' THEN
    RAISE EXCEPTION 'm531a: James Rodriguez lifecycle_state expected lifetime_customer, got %', v_james.lifecycle_state;
  END IF;

  -- No contact TYPE may remain in the persona column.
  SELECT count(*) INTO v_residue
    FROM public.contacts
   WHERE contact_persona IN ('listing_seller','past_client','lifetime','lifetime_customer','seller','buyer','both');
  IF v_residue > 0 THEN
    RAISE EXCEPTION 'm531a: % contact row(s) still carry a contact TYPE in contact_persona', v_residue;
  END IF;

  -- POSITIVE CONTROL for the residue finder: the same predicate, asked about a
  -- value that IS present, must return non-zero. If this comes back 0 the finder
  -- is blind and the assertion above proved nothing.
  SELECT count(*) INTO v_control
    FROM public.contacts
   WHERE contact_persona IN ('relocated','first_time_buyer','luxury_buyer');
  IF v_control = 0 THEN
    RAISE EXCEPTION 'm531a: POSITIVE CONTROL FAILED — the residue finder matches nothing at all, so its 0 is meaningless';
  END IF;

  RAISE NOTICE 'm531a OK — contact types are in contact_type, persona holds a situation or NULL (control matched % row(s)).', v_control;
END $$;

COMMIT;
