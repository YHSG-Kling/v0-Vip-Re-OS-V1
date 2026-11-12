-- =====================================================
-- MIGRATION m619: offer_intents
-- =====================================================
-- APPLIED to hrvaqgvukzxfskkcrwbt on 2026-09-10 by the integrator (measured
-- first: offer_intents absent; all seven RLS helper functions present, incl.
-- public.is_brokerage_admin()).
--
-- OWNER RULING (2026-09-10): "when a buyer in their portal hits submit an
-- offer on one of our listings, there is notification to agent that their
-- buyer wants to submit an offer, the buyer doesn't have access to the
-- proper forms to start an offer."
--
-- The portal's "submit an offer" control (app/portal/[contactId]/properties/
-- [propertyId]/BuyerOfferToolsCard.tsx "Help me make an offer" ->
-- app/actions/buyer-offer-tools.ts requestOfferHelp) records the buyer's
-- INTENT, never a real offer: no price, no terms, no forms, no prefill, no
-- e-sign. A real Offer is created ONLY by staff, through the agent-side
-- wizard (app/crm/contacts/[contactId]/offers/new), which runs the
-- financial-verification + lifecycle-eligibility + pending-limit gates that
-- an intent row must NOT bypass.
--
-- WHY A NEW TABLE, NOT A NEW `offers.status` VALUE. `offers.status` carries
-- no live CHECK constraint (scripts/check-vocabularies.ts, generated
-- 2026-09-10, confirmed empty for this column) so a new status string would
-- not need this migration to be *accepted* -- but an intent is not an offer:
-- it has no offer_price, no financing_type, no contingencies, and writing a
-- placeholder offers row would either fabricate a $0 price (the exact
-- fiction app/portal/[contactId]/offers/page.tsx's own header comment
-- refuses) or collide with checkPendingOfferLimit / checkDuplicateOffer,
-- which scan `offers` assuming every row is a real, priced offer. A
-- dedicated table keeps "the buyer asked" and "the buyer has a binding
-- offer" as two honestly different facts, bridged by `offer_id` once the
-- agent's wizard creates the real row.
--
-- STATUS is intentionally NOT CHECK-constrained to the same rigor as a real
-- offer -- this is an internal signal row with exactly four states an
-- agent or the kernel ever writes.
-- =====================================================

CREATE TABLE IF NOT EXISTS public.offer_intents (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id        UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  -- Populated ONLY when the property is one of OUR OWN listings
  -- (listings.brokerage_id = this row's brokerage_id) -- NULL for an
  -- external/IDX/off-platform property, exactly like offers.listing_id.
  listing_id        UUID        REFERENCES public.listings(id) ON DELETE SET NULL,
  -- The buyer's assigned agent at the moment the intent was recorded
  -- (contacts.agent_id snapshot) -- the task/notification target.
  agent_id          UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  property_address  TEXT,
  status            TEXT        NOT NULL DEFAULT 'requested'
                                 CHECK (status IN ('requested', 'acknowledged', 'converted', 'dismissed')),
  source            TEXT        NOT NULL DEFAULT 'buyer_portal',
  -- Bridged once the agent's wizard turns this intent into a real offer.
  offer_id          UUID        REFERENCES public.offers(id) ON DELETE SET NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at   TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_offer_intents_contact_created
  ON public.offer_intents (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offer_intents_brokerage_status
  ON public.offer_intents (brokerage_id, status);
CREATE INDEX IF NOT EXISTS idx_offer_intents_listing
  ON public.offer_intents (listing_id) WHERE listing_id IS NOT NULL;
-- One OPEN ('requested') intent per (contact, listing) -- the same
-- idempotency shape as an open offer. A NULL listing_id (external
-- property) is deliberately NOT covered by this partial unique index;
-- app/actions/buyer-offer-tools.ts dedupes the external case in code
-- against (contact_id, property_address), the same way
-- produceOfferStrategyBrief already dedupes the accelerator brief.
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_intents_open_per_listing
  ON public.offer_intents (contact_id, listing_id)
  WHERE status = 'requested' AND listing_id IS NOT NULL;

ALTER TABLE public.offer_intents ENABLE ROW LEVEL SECURITY;

-- SELECT: platform admin; brokerage staff with lead-visible access; the
-- assigned agent; the contact (self-portal user) -- same shape as
-- 047-client-portal-activity.sql's policy on the sibling portal-write table.
CREATE POLICY offer_intents_select ON public.offer_intents
  FOR SELECT
  USING (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id))
    OR (
      public.is_agent_role()
      AND agent_id IS NOT NULL
      AND agent_id = public.current_user_agent_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = offer_intents.contact_id
        AND c.contact_user_id = auth.uid()
    )
  );

-- INSERT: the contact recording their own intent, or brokerage staff on
-- their own tenant. The kernel's service-role writer bypasses RLS entirely,
-- same as every other portal-write table in this codebase (§4 pattern).
CREATE POLICY offer_intents_insert ON public.offer_intents
  FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (
      brokerage_id = public.current_user_brokerage_id()
      AND EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.id = offer_intents.contact_id
          AND c.brokerage_id = offer_intents.brokerage_id
      )
    )
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = offer_intents.contact_id
        AND c.contact_user_id = auth.uid()
    )
  );

-- UPDATE (acknowledge / convert / dismiss): platform + brokerage admins,
-- and the assigned agent acting on their own buyer's intent.
CREATE POLICY offer_intents_update ON public.offer_intents
  FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
    OR (
      public.is_agent_role()
      AND agent_id IS NOT NULL
      AND agent_id = public.current_user_agent_id()
    )
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
    OR (
      public.is_agent_role()
      AND agent_id IS NOT NULL
      AND agent_id = public.current_user_agent_id()
    )
  );

CREATE POLICY offer_intents_delete ON public.offer_intents
  FOR DELETE
  USING (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  );

-- scripts/live-tables.ts, scripts/schema-snapshot.ts, scripts/schema-fk-map.ts
-- and scripts/check-vocabularies.ts were regenerated from live JSON after
-- application (CLAUDE.md §3).
