-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m698 — THE RELATIONSHIP GRAPH (wave 102, lane 102B; owner: "Intelligence Graph … Relationship
-- graph. NO destructive Lead/Contact migration"; OS-CONSTITUTION LAW 1/2/5).
--
-- EVALUATED FIRST (the survivors stay the system of record for their OWN facts — nothing here
-- replaces them): agent_relationships (the revenue-share sponsor tree, agents↔agents),
-- outside_agent_contact_links (an outside buyer's agent ↔ the buyer they represent),
-- transaction_participants (the per-deal roster, names/emails, no ids), referrals /
-- referral_partners / referral_sources (who sent whom, the fee, the partner),
-- document_folders.related_contact_id (a folder's subject), buyer_financial_profiles
-- .lender_referred_partner_id / .lender_referred_vendor_id (the buyer's lender introduction),
-- contacts.vendor_id (the vendor bridge column — m595 — which NO code writes today),
-- lib/intelligence/relationship-health.ts (a pure score of how alive one client relationship is),
-- lib/enrichment/household-financials.ts (marital status / income / net worth AS CONTACT COLUMNS),
-- lib/kernel/referral-radar.ts (life-event detection on past clients). Each records ONE kind of
-- fact on its own shape; none can answer "who is related to whom, how, since when, on what
-- evidence" across kinds — a buyer's spouse, the home a seller used to own, the agent who
-- represents a contact, the vendor serving them. NO person↔person / person↔property edge table
-- existed (the integrator's census). This is the missing half (§1 case 2): ONE tenant-scoped typed
-- edge table, DERIVED at the survivor writers by lib/kernel/relationship-graph.ts.
--
-- · One vocabulary (§6): from/to entity types and relationship_type are CHECKed here and mirrored
--   by RELATIONSHIP_ENTITY_TYPES / RELATIONSHIP_TYPES in lib/kernel/relationship-graph.ts —
--   scripts/relationship-graph-guard.ts asserts the two lists are byte-equal.
--   `listing` is the property entity (listings.id); `agent` is a USERS id (agents.id and users.id
--   are disjoint, §3); `outside_agent` is outside_agents.id; `household` is reserved for the person
--   layer (lane 102A) — today a household is DERIVED from spouse_partner / household_member /
--   co_buyer / co_owner edges, never stored.
-- · evidence jsonb: { source, confidence (0..1), observed_at } — WHERE the fact was read, HOW sure,
--   WHEN. An upsert keeps the higher-confidence evidence (lib/kernel/relationship-graph.ts).
-- · UNIQUE (brokerage, from, to, type): upsertRelationship is idempotent on it.
-- · Writes are service-role only (no INSERT/UPDATE/DELETE policy): edges are derived by the kernel
--   from survivor writes, never typed by a session. Reads are tenant-scoped (has_brokerage_access)
--   or platform staff. Agents see contacts only (§5): no reader hands a lead edge to an agent surface.
--
-- Until applied every edge write resolves 42P01 / PGRST205: the survivor write has already landed,
-- the lost edge is reported `{ ok: false, degraded: true }` and every reader treats "no graph yet"
-- as an empty graph (never as a refusal).
--
-- Apply in TWO parts (wave 98 rule): PART A (table + CHECKs + RLS), then PART B (indexes +
-- updated_at trigger). AFTER APPLYING: regenerate the vocabulary cache (three CHECKs), the schema
-- snapshot, LIVE_TABLES and the FK map (two new FKs).

-- ══════════════════════════════ PART A — table, CHECKs, RLS ══════════════════════════════

CREATE TABLE IF NOT EXISTS public.relationship_edges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  from_entity_type  text NOT NULL,
  from_entity_id    uuid NOT NULL,
  to_entity_type    text NOT NULL,
  to_entity_id      uuid NOT NULL,
  relationship_type text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from    date,
  effective_to      date,
  created_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relationship_edges_unique_edge_key
    UNIQUE (brokerage_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type),
  CONSTRAINT relationship_edges_from_entity_type_check
    CHECK (from_entity_type IN ('contact', 'lead', 'listing', 'transaction', 'agent', 'vendor', 'outside_agent', 'household')),
  CONSTRAINT relationship_edges_to_entity_type_check
    CHECK (to_entity_type IN ('contact', 'lead', 'listing', 'transaction', 'agent', 'vendor', 'outside_agent', 'household')),
  CONSTRAINT relationship_edges_relationship_type_check
    CHECK (relationship_type IN ('spouse_partner', 'household_member', 'co_buyer', 'co_owner', 'owns', 'occupies', 'previously_owned', 'referred_by', 'represented_by', 'lender_for', 'vendor_for', 'sponsor_of', 'bought_from', 'sold_to')),
  CONSTRAINT relationship_edges_not_self_check
    CHECK (NOT (from_entity_type = to_entity_type AND from_entity_id = to_entity_id)),
  CONSTRAINT relationship_edges_effective_window_check
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CONSTRAINT relationship_edges_evidence_confidence_check
    CHECK (
      NOT (evidence ? 'confidence')
      OR (jsonb_typeof(evidence -> 'confidence') = 'number'
          AND (evidence ->> 'confidence')::numeric >= 0
          AND (evidence ->> 'confidence')::numeric <= 1)
    )
);

ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.relationship_edges FROM anon, authenticated;

DROP POLICY IF EXISTS relationship_edges_select ON public.relationship_edges;
CREATE POLICY relationship_edges_select ON public.relationship_edges
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.relationship_edges IS
  'Tenant-scoped typed relationship graph (wave 102, m698): one edge per (brokerage, from, to, type), DERIVED by lib/kernel/relationship-graph.ts at the survivor writers (transaction close/roster, outside-agent link, referrals, lender referral, vendor booking, sponsor tree, household enrichment). Survivor tables remain the system of record for their own facts.';

-- ══════════════════════════════ PART B — indexes, updated_at ══════════════════════════════

CREATE INDEX IF NOT EXISTS idx_relationship_edges_from
  ON public.relationship_edges (brokerage_id, from_entity_type, from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationship_edges_to
  ON public.relationship_edges (brokerage_id, to_entity_type, to_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationship_edges_type
  ON public.relationship_edges (brokerage_id, relationship_type);

CREATE OR REPLACE FUNCTION public.relationship_edges_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relationship_edges_touch_updated_at ON public.relationship_edges;
CREATE TRIGGER relationship_edges_touch_updated_at
  BEFORE UPDATE ON public.relationship_edges
  FOR EACH ROW EXECUTE FUNCTION public.relationship_edges_touch_updated_at();
