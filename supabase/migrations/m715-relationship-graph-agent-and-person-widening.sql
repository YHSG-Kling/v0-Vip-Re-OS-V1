-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m715 — relationship_edges widens its three CHECKs ADDITIVELY for the REAL KNOWLEDGE GRAPH on
-- Postgres (wave 105, lane 105D; owner 2026-10-06: "person: household / owns property / has
-- opportunity / referred / represented by / transaction / campaign / vendor; agent: team / territory /
-- recruited by / competency / education / residual / owns opportunities — edges carrying source,
-- confidence, valid_from, valid_to, evidence, tenant — a data model + traversal, no graph database").
--
-- SURVIVOR: relationship_edges (m698, widened once by m702) + lib/kernel/relationship-graph.ts. This is
-- the SAME table, the SAME writer, the SAME readers: the three CHECK lists are re-stated with every
-- existing value in its existing order and new values APPENDED. No row, no index, no policy, no column
-- changes. scripts/relationship-graph-guard.ts asserts the TS mirror equals m698 ∪ m702 ∪ m715 and that
-- this file only widens.
--
-- THE DOCUMENTED EDGE CONTRACT (owner vocabulary → the live columns; no rename, no new column):
--   source      = evidence->>'source'      (REQUIRED by the writer: the survivor table / writer that proved it)
--   confidence  = evidence->>'confidence'  (REQUIRED by the writer, 0..1 — the existing CHECK below bounds it)
--   valid_from  = effective_from           (date; null = since always known)
--   valid_to    = effective_to             (date; null = still in force)
--   evidence    = evidence jsonb           ({source, confidence, observed_at} — nothing else is contractual)
--   tenant      = brokerage_id             (from the caller's SESSION context, never a request body)
--
-- ENTITY TYPES ADDED (what the uuid names):
--   team             teams.id
--   territory        farm_territories.id
--   campaign         marketing_campaigns.id
--   competency       a DETERMINISTIC uuid (v5-shaped, sha1 of "competency|<CompetencySkill key>") — no
--                    competency table exists; the skill key IS the identity (lib/education/skill-freshness.ts
--                    COMPETENCY_SKILLS). relationship-graph.ts entityIdForKey("competency", key).
--   education_module learning_modules.id
--   household        (already admitted by m698, reserved) — NOW WRITTEN: one node per (tenant, address
--                    cluster), id = entityIdForKey("household", "<brokerage_id>|<street|zip key>").
--   `opportunity` is NOT an entity type (decided here, one vocabulary §6): an opportunity IS the lead or
--   contact row in a buying/selling cycle, so has_opportunity / owns_opportunity point AT that lead /
--   contact endpoint. A fourth row type would duplicate what leads / contacts already record.
--
-- RELATIONSHIP TYPES ADDED (from → to):
--   belongs_to_household      contact → household           (household derivation, address cluster ≥ 2)
--   has_opportunity           contact → lead                (the person's open cycle record)
--   interacted_with_campaign  contact | lead → campaign     (marketing_campaign_touchpoints writer)
--   member_of_team            agent → team                  (agents.team_id / users.team_id / team roster)
--   serves_territory          agent → territory             (farm_territories.agent_id, weekly backfill)
--   recruited_by              agent → agent                 (recruits.recruiter_agent_id at provisioning)
--   has_competency            agent → competency            (scoreCompetency ≥ gap threshold, confidence)
--   completed_education       agent | contact → education_module (learning_assignments completed)
--   earns_residual            agent → agent                 (agent_relationships sponsor edge: sponsor earns from recruit)
--   owns_opportunity          agent → lead | contact        (lead hand-off / contact ownership writers)
--   `agent` endpoints remain USERS ids (agents.id and users.id are disjoint, §3; writers cross agents.user_id).
--
-- Apply in TWO parts (wave 98 rule): PART A (the two entity CHECKs), PART B (the relationship CHECK).
-- AFTER APPLYING: regenerate the vocabulary cache (scripts/check-vocabularies.ts — three CHECKs widen)
-- and restamp this header's line 1 the way m698's / m702's are stamped (APPLIED LIVE <date>).

-- ══════════════════════════════ PART A — entity CHECKs ══════════════════════════════

ALTER TABLE public.relationship_edges
  DROP CONSTRAINT IF EXISTS relationship_edges_from_entity_type_check;
ALTER TABLE public.relationship_edges
  ADD CONSTRAINT relationship_edges_from_entity_type_check
    CHECK (from_entity_type IN ('contact', 'lead', 'listing', 'transaction', 'agent', 'vendor', 'outside_agent', 'household', 'referral_partner', 'team', 'territory', 'campaign', 'competency', 'education_module'));

ALTER TABLE public.relationship_edges
  DROP CONSTRAINT IF EXISTS relationship_edges_to_entity_type_check;
ALTER TABLE public.relationship_edges
  ADD CONSTRAINT relationship_edges_to_entity_type_check
    CHECK (to_entity_type IN ('contact', 'lead', 'listing', 'transaction', 'agent', 'vendor', 'outside_agent', 'household', 'referral_partner', 'team', 'territory', 'campaign', 'competency', 'education_module'));

-- ══════════════════════════════ PART B — relationship CHECK ══════════════════════════════

ALTER TABLE public.relationship_edges
  DROP CONSTRAINT IF EXISTS relationship_edges_relationship_type_check;
ALTER TABLE public.relationship_edges
  ADD CONSTRAINT relationship_edges_relationship_type_check
    CHECK (relationship_type IN ('spouse_partner', 'household_member', 'co_buyer', 'co_owner', 'owns', 'occupies', 'previously_owned', 'referred_by', 'represented_by', 'lender_for', 'vendor_for', 'sponsor_of', 'bought_from', 'sold_to', 'belongs_to_household', 'has_opportunity', 'interacted_with_campaign', 'member_of_team', 'serves_territory', 'recruited_by', 'has_competency', 'completed_education', 'earns_residual', 'owns_opportunity'));

COMMENT ON COLUMN public.relationship_edges.evidence IS
  'The edge contract (m715): source = evidence.source (required), confidence = evidence.confidence (required, 0..1), observed_at; valid_from = effective_from, valid_to = effective_to, tenant = brokerage_id. Written only by lib/kernel/relationship-graph.ts upsertRelationship.';
