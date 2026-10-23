-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m702 — relationship_edges admits `referral_partner` as an edge endpoint (wave 102.1, lane 102F;
-- ruling R7: "Partner-rail lender referrals get lender_for edges: ADD entity type referral_partner
-- to relationship_edges' CHECKs — additive widening only, never a rewrite").
--
-- WHY. connectBuyerToLender (app/actions/buyer-financial.ts) has TWO rails (m605): the brokerage's
-- lender BENCH (a vendors.id → `vendor` endpoint, edge written since m698) and an agent's PARTNER
-- rolodex (referral_partners.id). A partner reaches a vendor identity only through
-- referral_partners.vendor_id, so a partner-rail referral whose partner has no vendor row left NO
-- lender_for edge (102B's open item). The partner directory stays the system of record for the
-- partner; the graph only needs to be allowed to point at it.
--
-- ADDITIVE: the two entity-type CHECKs are re-stated with ONE more value each. Nothing else on the
-- table changes — no row, no index, no policy. The TS mirror is RELATIONSHIP_ENTITY_TYPES
-- (lib/kernel/relationship-graph.ts); scripts/relationship-graph-guard.ts holds m698 ∪ m702 equal
-- to it and asserts this file only WIDENS m698's lists.
--
-- Apply in TWO parts (wave 98 rule): PART A (from-side CHECK), PART B (to-side CHECK). AFTER
-- APPLYING: regenerate the vocabulary cache (scripts/check-vocabularies.ts — two CHECKs widen) and
-- restamp this header's line 1 the way m698's is stamped (one provenance line, dated).

-- ══════════════════════════════ PART A — from_entity_type ══════════════════════════════

ALTER TABLE public.relationship_edges
  DROP CONSTRAINT IF EXISTS relationship_edges_from_entity_type_check;
ALTER TABLE public.relationship_edges
  ADD CONSTRAINT relationship_edges_from_entity_type_check
    CHECK (from_entity_type IN ('contact', 'lead', 'listing', 'transaction', 'agent', 'vendor', 'outside_agent', 'household', 'referral_partner'));

-- ══════════════════════════════ PART B — to_entity_type ══════════════════════════════

ALTER TABLE public.relationship_edges
  DROP CONSTRAINT IF EXISTS relationship_edges_to_entity_type_check;
ALTER TABLE public.relationship_edges
  ADD CONSTRAINT relationship_edges_to_entity_type_check
    CHECK (to_entity_type IN ('contact', 'lead', 'listing', 'transaction', 'agent', 'vendor', 'outside_agent', 'household', 'referral_partner'));

COMMENT ON COLUMN public.relationship_edges.from_entity_type IS
  'Endpoint entity type (m698; m702 adds referral_partner = referral_partners.id, the partner-rail lender a lender_for edge names when the partner has no vendor identity).';
