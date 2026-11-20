/**
 * lib/kernel/relationship-graph.ts — THE RELATIONSHIP GRAPH (wave 102, lane 102B; m698;
 * OS-CONSTITUTION LAW 1/2/5). Layer 3 of the intelligence graph: Person • Household • Property •
 * Relationship • Opportunity, on top of the EXISTING entities (contacts, leads, listings,
 * transactions, users-as-agents, vendors, outside_agents). No lead/contact migration.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT HERE: the facts. Every survivor stays the system of record for what it records —
 *   agent_relationships              the revenue-share SPONSOR TREE (agents.id ↔ agents.id, depth, terms)
 *   outside_agent_contact_links      an outside buyer's agent ↔ the buyer contact it represents
 *   transaction_participants         the per-deal ROSTER (names / emails / phones, no ids)
 *   referrals / referral_partners /  who sent whom (referrer_contact_id, referring_agent_id, partner_id),
 *     referral_sources               the fee and the partner directory
 *   document_folders.related_contact_id   the contact a folder is about
 *   buyer_financial_profiles.lender_referred_partner_id / _vendor_id   the buyer's lender introduction
 *   contacts.vendor_id               the vendor bridge column (m595) — "this contact HOLDS a vendor seat";
 *                                    written since wave 103 (lane 103D) by lib/kernel/vendor-seat-contact.ts
 *                                    at seat activation (link only); vendor_bookings stays the
 *                                    vendor↔contact BOOKING fact. vendorSeatCorroboration below reads the
 *                                    seat's own vendor_for edges as corroboration of the seat.
 *   lib/intelligence/relationship-health.ts   a PURE score of how alive one client relationship is
 *   lib/enrichment/household-financials.ts    marital status / income / net worth as CONTACT COLUMNS
 *   lib/kernel/referral-radar.ts              life-event detection on past clients
 *
 * WHAT IS HERE: the ONE typed edge store (relationship_edges, m698) and its ONE writer
 * (upsertRelationship — idempotent on UNIQUE (brokerage, from, to, type)), the two readers
 * (neighbors, household) and the DERIVATIONS the survivor writers call after their own write lands:
 *   transaction close      → bought_from / sold_to / owns / previously_owned   (lib/kernel/transactions.ts)
 *   transaction roster     → represented_by (buyer/seller → their agent)       (lib/transactions/participant-populator.ts)
 *   outside-agent link     → represented_by (buyer → outside_agent)            (lib/offers/outside-agent-record.ts)
 *   referral writers       → referred_by                                       (lib/referrals/referral-record.ts, agent-referral.ts)
 *   lender referral        → lender_for (vendor → contact)                     (app/actions/buyer-financial.ts)
 *   vendor booking         → vendor_for (vendor → contact)                     (app/actions/contact-vendor-booking.ts)
 *   sponsor tree           → sponsor_of (sponsor user → recruit user)          (app/api/recruiting/provision-agent/route.ts)
 *   household enrichment   → spouse_partner / household_member                 (lib/enrichment/household-financials.ts,
 *                            (marital status + same mailing address)            contact-enrichment-core.ts)
 *   WAVE 102.1 (lane 102F — closing 102B's "no deriving writer" items):
 *   close / roster         → co_buyer (a second buyer-side contact on the deal:  (lib/kernel/transactions.ts,
 *                            transactions.contact_id on a buyer deal, or a       lib/transactions/participant-populator.ts)
 *                            buyer / co_buyer roster row whose email is a contact)
 *   BatchData owner data   → co_owner (the OTHER owner name on the contact's     (lib/lead-pipeline/enrichment-orchestrator.ts,
 *                            home, matched to a contact of the tenant in the      property_records.batchdata.owner_names)
 *                            same zip; confidence on the edge)
 *   residence signal       → occupies (the contact's mailing address IS a        (lib/enrichment/contact-enrichment-core.ts,
 *                            listing the tenant holds; renters from the            lib/lead-pipeline/rental-graduation-sourcer.ts)
 *                            rental-graduation sourcer carry the renter signal)
 *   partner-rail lender    → lender_for (referral_partner → contact) — R7, m702  (app/actions/buyer-financial.ts)
 *   weekly cron (R3)       → backfillTransactionCloseEdges: the closes that       (app/api/cron/source-conversion-learning/route.ts)
 *                            predate m698 heal through the ONE derivation
 *
 * DETERMINISTIC: no model call, no clock read inside a planner (observed_at is passed in), symmetric
 * relations stored ONCE with a fixed orientation (lower id → higher id), neighbors sorted.
 * Tenant from the caller's EXISTING context (never a request body). Every read/write destructures
 * `{ data, error }`. Not server-only: simulator-driven with an injected client.
 *
 * Before m698 is applied every write resolves 42P01 / PGRST205 → `{ ok: false, degraded: true }`
 * and every reader answers "no graph yet" as an EMPTY graph with `degraded: true` — never as a
 * refusal (a reader that fails closed on a missing table would take its survivor surface down).
 *
 * LANE 102A COORDINATION: edges key on contact / lead ids today. When the person identity layer
 * lands, `contact` / `lead` endpoints on person↔person edges (spouse_partner, household_member,
 * co_buyer, co_owner, referred_by, bought_from, sold_to) should resolve to the person id — the
 * `household` entity type is reserved for that layer.
 *
 * ═══ WAVE 105 (lane 105D; m715 — APPLIED LIVE 2026-10-06) ═══
 * THE REAL KNOWLEDGE GRAPH ON POSTGRES — the SAME table, the SAME writer, a traversal; no graph database.
 *
 * THE EDGE CONTRACT (owner vocabulary → live columns; no column rename):
 *   source      = evidence.source      REQUIRED by the writer (which survivor proved it)
 *   confidence  = evidence.confidence  REQUIRED by the writer, 0..1 (m698's CHECK bounds it)
 *   valid_from  = effective_from       (date | null = since always known)      → EdgeInput.effectiveFrom
 *   valid_to    = effective_to         (date | null = still in force)          → EdgeInput.effectiveTo
 *   evidence    = evidence jsonb       ({source, confidence, observed_at} and nothing else is contractual)
 *   tenant      = brokerage_id         (from the caller's SESSION context, never a request body)
 *
 * `opportunity` IS NOT AN ENTITY TYPE (one vocabulary, §6): an opportunity is the lead or contact row
 * in a buying/selling cycle, so has_opportunity (contact → lead) and owns_opportunity (agent → lead |
 * contact) point AT that row. `competency` and `household` have no table of their own: their ids are
 * DETERMINISTIC (entityIdForKey — sha1 of "<kind>|<key>" laid out as a v5-shaped uuid), so two writers
 * name the same node without a registry. `agent` endpoints stay USERS ids (§3).
 *
 * DERIVATIONS ADDED, each a small call inside the EXISTING writer (never a new pipeline):
 *   member_of_team           → deriveTeamMembershipEdge   lib/kernel/users.ts assignUserToTeam,
 *                                                         app/actions/admin/agent-profile.ts, team-members.ts (roster)
 *   serves_territory         → backfillAgentStructureEdges on the weekly cron (farm_territories.agent_id has
 *                              NO server-side writer — the admin page writes it client-side — so the survivor
 *                              TABLE is read and healed, the R3 pattern; member_of_team heals there too)
 *   recruited_by + earns_residual → planRecruitEdges       app/api/recruiting/provision-agent/route.ts
 *   has_competency           → planCompetencyEdges        lib/learning-router/resolve-agent-learning-context.ts
 *                              (the learning router's ONE scoreCompetency load; threshold = COMPETENCY_GAP_SCORE,
 *                              confidence from the profile's evidence gate)
 *   completed_education      → deriveEducationCompletedEdge  app/actions/academy-learning.ts (agent quiz pass),
 *                              lib/kernel/education.ts recordCompletion (a contact's client education)
 *   owns_opportunity         → deriveOpportunityOwnership  app/actions/leads.ts handOffToHumanAgent (lead),
 *                              app/actions/contact-reassignment.ts (contact + its leads; the old owner's edge CLOSES)
 *   has_opportunity          → planOpportunityEdges        lib/campaigns/enroll-in-sequence.ts (contact + lead named)
 *   interacted_with_campaign → deriveCampaignInteraction  lib/marketing/touchpoint-recorder.ts (single + bulk)
 *   belongs_to_household     → planHouseholdEdges (102F's derivation, extended): one household node per
 *                              (tenant, address cluster of ≥ 2 contacts)
 *
 * TRAVERSAL: traverse (BFS over neighbors, depth ≤ 3, tenant-scoped, validity window honoured at `at`,
 * cycle-safe, bounded fan-out, confidence multiplied along the path) + rankPaths (pure). SEAM for the
 * context compiler (105C — export only): RELATIONSHIP_GRAPH_SEAM / graphContextFor. READERS: the contact
 * brief (agentVisibleEdges — no lead endpoint reaches an agent surface, §5), the agent scorecard (graph
 * counts), the command center (countRelationships beside the twin).
 */
import { createHash } from "node:crypto"

// ── The vocabulary (mirrored by m698's CHECKs — scripts/relationship-graph-guard.ts holds them equal) ──

/** @proofSeam scripts/relationship-graph-guard.ts asserts this list equals m698's CHECK + m702's additive widening
 *  (one vocabulary, §6). `referral_partner` (referral_partners.id — R7, m702) is the partner-rail lender a
 *  buyer_financial_profiles.lender_referred_partner_id names when the partner has no vendor identity. */
export const RELATIONSHIP_ENTITY_TYPES = [
  "contact", "lead", "listing", "transaction", "agent", "vendor", "outside_agent", "household", "referral_partner",
  // m715 (wave 105, 105D) — additive: team = teams.id, territory = farm_territories.id, campaign =
  // marketing_campaigns.id, competency = entityIdForKey("competency", skill), education_module = learning_modules.id
  "team", "territory", "campaign", "competency", "education_module",
] as const
export type RelationshipEntityType = (typeof RELATIONSHIP_ENTITY_TYPES)[number]

/** @proofSeam scripts/relationship-graph-guard.ts asserts this list equals m698's CHECK ∪ m715's additive widening (one vocabulary, §6). */
export const RELATIONSHIP_TYPES = [
  "spouse_partner", "household_member", "co_buyer", "co_owner",
  "owns", "occupies", "previously_owned",
  "referred_by", "represented_by", "lender_for", "vendor_for", "sponsor_of",
  "bought_from", "sold_to",
  // m715 (wave 105, 105D) — additive
  "belongs_to_household", "has_opportunity", "interacted_with_campaign",
  "member_of_team", "serves_territory", "recruited_by", "has_competency", "completed_education", "earns_residual", "owns_opportunity",
] as const
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

/** The person↔person types a household is DERIVED from (symmetric; stored once, lower id first).
 *  @proofSeam scripts/relationship-graph-guard.ts asserts household() reads exactly these. */
export const HOUSEHOLD_RELATIONSHIP_TYPES = ["spouse_partner", "household_member", "co_buyer", "co_owner"] as const
export type HouseholdRelationshipType = (typeof HOUSEHOLD_RELATIONSHIP_TYPES)[number]

const SYMMETRIC_TYPES: ReadonlySet<string> = new Set(HOUSEHOLD_RELATIONSHIP_TYPES)

export interface EntityRef { type: RelationshipEntityType; id: string }

export interface RelationshipEvidence {
  /** WHERE the fact was read — the survivor writer (e.g. "transaction_close", "household_financials"). */
  source: string
  /** HOW sure, 0..1. */
  confidence: number
  /** WHEN it was observed (ISO). */
  observed_at: string
}

export interface RelationshipEdge {
  id: string
  brokerage_id: string
  from_entity_type: RelationshipEntityType
  from_entity_id: string
  to_entity_type: RelationshipEntityType
  to_entity_id: string
  relationship_type: RelationshipType
  evidence: RelationshipEvidence
  effective_from: string | null
  effective_to: string | null
  created_by: string | null
}

export interface EdgeInput {
  from: EntityRef
  to: EntityRef
  type: RelationshipType
  evidence: RelationshipEvidence
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export type UpsertRelationshipResult =
  | { ok: true; id: string; created: boolean; updated: boolean }
  | { ok: false; error: string; degraded: boolean }

type Svc = { from: (table: string) => any }

// The table name is a LITERAL at every call site (wave 98 lesson: a write through a table-name
// constant is invisible to opposite-missing / readerless-writes / the census guards).

/** 42P01 / PGRST205 — the table is not there (m698 is live since 2026-10-05; older environments degrade). */
function isMissingTable(err: { code?: string; message?: string } | null | undefined): boolean {
  const code = err?.code ?? ""
  const msg = (err?.message ?? "").toLowerCase()
  return code === "42P01" || code === "PGRST205" || msg.includes("does not exist") || msg.includes("could not find the table")
}

function isEntityType(v: unknown): v is RelationshipEntityType {
  return typeof v === "string" && (RELATIONSHIP_ENTITY_TYPES as readonly string[]).includes(v)
}
function isRelationshipType(v: unknown): v is RelationshipType {
  return typeof v === "string" && (RELATIONSHIP_TYPES as readonly string[]).includes(v)
}

function clampConfidence(c: number): number {
  if (!Number.isFinite(c)) return 0
  return Math.min(1, Math.max(0, Math.round(c * 100) / 100))
}

/** PURE — the stored orientation of a symmetric edge: lower id first, so (a,b) and (b,a) are ONE row. */
function orientEdge(input: EdgeInput): EdgeInput {
  if (!SYMMETRIC_TYPES.has(input.type)) return input
  const a = `${input.from.type}:${input.from.id}`
  const b = `${input.to.type}:${input.to.id}`
  return a <= b ? input : { ...input, from: input.to, to: input.from }
}

/** PURE — why an edge cannot be written (null = valid). */
function validateEdgeInput(input: EdgeInput): string | null {
  if (!isEntityType(input.from?.type)) return `unknown from entity type ${String(input.from?.type)}`
  if (!isEntityType(input.to?.type)) return `unknown to entity type ${String(input.to?.type)}`
  if (!input.from?.id || !input.to?.id) return "an edge needs both endpoint ids"
  if (!isRelationshipType(input.type)) return `unknown relationship type ${String(input.type)}`
  if (input.from.type === input.to.type && input.from.id === input.to.id) return "an entity cannot relate to itself"
  if (!input.evidence?.source) return "evidence.source is required"
  // m715 contract: confidence is REQUIRED (a number) — an absent confidence used to clamp to 0 silently.
  if (typeof input.evidence?.confidence !== "number" || !Number.isFinite(input.evidence.confidence)) return "evidence.confidence is required (0..1)"
  if (!input.evidence?.observed_at) return "evidence.observed_at is required"
  return null
}

/**
 * PURE — a DETERMINISTIC uuid for an entity that has no table of its own (`competency`, `household`):
 * sha1 of "<kind>|<key>" laid out as a v5-shaped uuid (version nibble 5, RFC variant). The same key
 * always names the same node, so two writers meet without a registry. Byte-stable across runs.
 * @proofSeam scripts/relationship-graph-guard.ts asserts determinism, shape and key sensitivity.
 */
export function entityIdForKey(kind: "competency" | "household", key: string): string {
  const h = createHash("sha1").update(`relationship-graph|${kind}|${key}`).digest("hex").slice(0, 32).split("")
  h[12] = "5"
  h[16] = ["8", "9", "a", "b"][parseInt(h[16], 16) & 3]
  const s = h.join("")
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

// ── The ONE writer ──────────────────────────────────────────────────────────────────────────────

/**
 * Idempotent on UNIQUE (brokerage, from, to, type). An existing edge is re-read, never duplicated;
 * its evidence is replaced only when the incoming confidence is at least as high (newest evidence
 * of equal or better quality wins), and an effective window is filled, never cleared.
 */
export async function upsertRelationship(
  svc: Svc,
  input: EdgeInput & { brokerageId: string; createdBy?: string | null },
): Promise<UpsertRelationshipResult> {
  if (!input.brokerageId) return { ok: false, error: "tenant scope required", degraded: false }
  const invalid = validateEdgeInput(input)
  if (invalid) return { ok: false, error: invalid, degraded: false }
  const e = orientEdge(input)
  const evidence: RelationshipEvidence = {
    source: e.evidence.source,
    confidence: clampConfidence(e.evidence.confidence),
    observed_at: e.evidence.observed_at,
  }

  const { data: existing, error: readErr } = await svc
    .from("relationship_edges")
    .select("id, evidence, effective_from, effective_to")
    .eq("brokerage_id", input.brokerageId)
    .eq("from_entity_type", e.from.type).eq("from_entity_id", e.from.id)
    .eq("to_entity_type", e.to.type).eq("to_entity_id", e.to.id)
    .eq("relationship_type", e.type)
    .limit(1)
  if (readErr) return { ok: false, error: `edge read refused: ${readErr.message}`, degraded: isMissingTable(readErr) }

  const row = (existing ?? [])[0] as { id: string; evidence: Partial<RelationshipEvidence> | null; effective_from: string | null; effective_to: string | null } | undefined
  if (row) {
    const patch: Record<string, unknown> = {}
    const haveConf = clampConfidence(Number(row.evidence?.confidence ?? 0))
    if (evidence.confidence >= haveConf) patch.evidence = evidence
    if (e.effectiveFrom && !row.effective_from) patch.effective_from = e.effectiveFrom
    if (e.effectiveTo && !row.effective_to) patch.effective_to = e.effectiveTo
    if (Object.keys(patch).length === 0) return { ok: true, id: row.id, created: false, updated: false }
    const { error: updErr } = await svc.from("relationship_edges").update(patch).eq("id", row.id).eq("brokerage_id", input.brokerageId)
    if (updErr) return { ok: false, error: `edge update refused: ${updErr.message}`, degraded: isMissingTable(updErr) }
    return { ok: true, id: row.id, created: false, updated: true }
  }

  const { data: ins, error: insErr } = await svc
    .from("relationship_edges")
    .insert({
      brokerage_id: input.brokerageId,
      from_entity_type: e.from.type, from_entity_id: e.from.id,
      to_entity_type: e.to.type, to_entity_id: e.to.id,
      relationship_type: e.type,
      evidence,
      effective_from: e.effectiveFrom ?? null,
      effective_to: e.effectiveTo ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single()
  if (insErr) {
    // A concurrent writer landed the same key (23505): it exists — re-read, never duplicate.
    if (insErr.code === "23505") {
      const { data: again, error: againErr } = await svc
        .from("relationship_edges").select("id")
        .eq("brokerage_id", input.brokerageId)
        .eq("from_entity_type", e.from.type).eq("from_entity_id", e.from.id)
        .eq("to_entity_type", e.to.type).eq("to_entity_id", e.to.id)
        .eq("relationship_type", e.type).limit(1)
      const id = (again ?? [])[0]?.id as string | undefined
      if (!againErr && id) return { ok: true, id, created: false, updated: false }
    }
    return { ok: false, error: `edge insert refused: ${insErr.message}`, degraded: isMissingTable(insErr) }
  }
  return { ok: true, id: (ins as { id: string }).id, created: true, updated: false }
}

/** Write a planned batch; the survivor's own write has already landed, so a miss is reported, never thrown. */
export async function upsertRelationships(
  svc: Svc,
  brokerageId: string,
  edges: EdgeInput[],
  createdBy?: string | null,
): Promise<{ written: number; existing: number; errors: string[]; degraded: boolean }> {
  const out = { written: 0, existing: 0, errors: [] as string[], degraded: false }
  for (const edge of edges) {
    const r = await upsertRelationship(svc, { ...edge, brokerageId, createdBy })
    if (r.ok) { if (r.created) out.written++; else out.existing++ }
    else { out.errors.push(`${edge.type} ${edge.from.type}:${edge.from.id} → ${edge.to.type}:${edge.to.id}: ${r.error}`); if (r.degraded) out.degraded = true }
  }
  return out
}

// ── The readers ──────────────────────────────────────────────────────────────────────────────────

export interface NeighborsResult {
  ok: boolean
  edges: RelationshipEdge[]
  /** The table is not there yet (m698 unapplied): an EMPTY graph, not a refusal. */
  degraded: boolean
  error: string | null
}

/**
 * Every edge touching `entity` in this tenant, optionally narrowed by type and direction.
 * Sorted (type, from, to) so two reads of the same graph are byte-equal.
 */
export async function neighbors(
  svc: Svc,
  input: { brokerageId: string; entity: EntityRef; types?: readonly RelationshipType[]; direction?: "out" | "in" | "both" },
): Promise<NeighborsResult> {
  if (!input.brokerageId) return { ok: false, edges: [], degraded: false, error: "tenant scope required" }
  const direction = input.direction ?? "both"
  const cols = "id, brokerage_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type, evidence, effective_from, effective_to, created_by"
  const build = (side: "from" | "to") => {
    let q = svc.from("relationship_edges").select(cols)
      .eq("brokerage_id", input.brokerageId)
      .eq(`${side}_entity_type`, input.entity.type)
      .eq(`${side}_entity_id`, input.entity.id)
    if (input.types && input.types.length > 0) q = q.in("relationship_type", [...input.types])
    return q.limit(500)
  }
  const reads: Array<Promise<{ data: unknown[] | null; error: { code?: string; message: string } | null }>> = []
  if (direction !== "in") reads.push(build("from"))
  if (direction !== "out") reads.push(build("to"))
  const results = await Promise.all(reads)
  const refused = results.find((r) => r.error)?.error ?? null
  if (refused) {
    if (isMissingTable(refused)) return { ok: true, edges: [], degraded: true, error: null }
    return { ok: false, edges: [], degraded: false, error: `edge read refused: ${refused.message}` }
  }
  const seen = new Set<string>()
  const edges: RelationshipEdge[] = []
  for (const r of results) for (const row of (r.data ?? []) as RelationshipEdge[]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    edges.push(row)
  }
  edges.sort((a, b) =>
    a.relationship_type.localeCompare(b.relationship_type)
    || a.from_entity_id.localeCompare(b.from_entity_id)
    || a.to_entity_id.localeCompare(b.to_entity_id))
  return { ok: true, edges, degraded: false, error: null }
}

export interface HouseholdMember { contactId: string; type: HouseholdRelationshipType; confidence: number }

/**
 * The contacts one hop from `contactId` over the household types (spouse / household member /
 * co-buyer / co-owner). Sorted by confidence desc, then id. The subject is never a member of itself.
 */
export async function household(
  svc: Svc,
  input: { brokerageId: string; contactId: string },
): Promise<{ ok: boolean; members: HouseholdMember[]; degraded: boolean; error: string | null }> {
  const res = await neighbors(svc, {
    brokerageId: input.brokerageId,
    entity: { type: "contact", id: input.contactId },
    types: HOUSEHOLD_RELATIONSHIP_TYPES,
  })
  if (!res.ok) return { ok: false, members: [], degraded: res.degraded, error: res.error }
  const byId = new Map<string, HouseholdMember>()
  for (const e of res.edges) {
    const subjectIsFrom = e.from_entity_type === "contact" && e.from_entity_id === input.contactId
    const otherType = subjectIsFrom ? e.to_entity_type : e.from_entity_type
    const otherId = subjectIsFrom ? e.to_entity_id : e.from_entity_id
    if (otherType !== "contact" || otherId === input.contactId) continue
    const conf = clampConfidence(Number(e.evidence?.confidence ?? 0))
    const have = byId.get(otherId)
    if (!have || conf > have.confidence) byId.set(otherId, { contactId: otherId, type: e.relationship_type as HouseholdRelationshipType, confidence: conf })
  }
  const members = [...byId.values()].sort((a, b) => b.confidence - a.confidence || a.contactId.localeCompare(b.contactId))
  return { ok: true, members, degraded: res.degraded, error: null }
}

// ── Derivations at the survivor writers ──────────────────────────────────────────────────────────

/**
 * PURE — the edges a CLOSED transaction proves: the buyer bought from the seller, the seller sold to
 * the buyer, the buyer now OWNS the home (from the close date) and the seller PREVIOUSLY owned it
 * (until the close date). Four edges when buyer, seller and listing are all known; the agents on the
 * deal are the roster's business (planRosterEdges).
 * @proofSeam scripts/relationship-graph-guard.ts asserts the four edges on the pure planner directly.
 */
export function planTransactionCloseEdges(input: {
  transactionId: string
  buyerContactId?: string | null
  sellerContactId?: string | null
  listingId?: string | null
  /** 102F — the OTHER buyer-side contacts on the deal (coBuyerContactIds / resolveCoBuyerContactIds). */
  coBuyerContactIds?: readonly string[] | null
  closeDate: string
  observedAt: string
}): EdgeInput[] {
  const evidence: RelationshipEvidence = { source: "transaction_close", confidence: 1, observed_at: input.observedAt }
  const out: EdgeInput[] = []
  const buyer = input.buyerContactId ? { type: "contact" as const, id: input.buyerContactId } : null
  const seller = input.sellerContactId && input.sellerContactId !== input.buyerContactId ? { type: "contact" as const, id: input.sellerContactId } : null
  const listing = input.listingId ? { type: "listing" as const, id: input.listingId } : null
  if (buyer && seller) {
    out.push({ from: buyer, to: seller, type: "bought_from", evidence, effectiveFrom: input.closeDate })
    out.push({ from: seller, to: buyer, type: "sold_to", evidence, effectiveFrom: input.closeDate })
  }
  if (buyer && listing) out.push({ from: buyer, to: listing, type: "owns", evidence, effectiveFrom: input.closeDate })
  if (seller && listing) out.push({ from: seller, to: listing, type: "previously_owned", evidence, effectiveTo: input.closeDate })
  // 102F — co-buyers: each is a co_buyer of the buyer (and of each other), and owns the home too.
  // Never the seller, never the buyer twice; sorted so the plan is byte-stable.
  const coBuyers = [...new Set((input.coBuyerContactIds ?? []).filter((id): id is string => !!id && id !== input.buyerContactId && id !== input.sellerContactId))].sort()
  const coEvidence: RelationshipEvidence = { source: "transaction_close", confidence: 0.9, observed_at: input.observedAt }
  const buyerSide = [...(buyer ? [buyer.id] : []), ...coBuyers]
  for (let i = 0; i < buyerSide.length; i++) {
    for (let j = i + 1; j < buyerSide.length; j++) {
      out.push(orientEdge({ from: { type: "contact", id: buyerSide[i] }, to: { type: "contact", id: buyerSide[j] }, type: "co_buyer", evidence: coEvidence, effectiveFrom: input.closeDate }))
    }
  }
  if (listing) for (const id of coBuyers) out.push({ from: { type: "contact", id }, to: listing, type: "owns", evidence: coEvidence, effectiveFrom: input.closeDate })
  return out
}

/**
 * PURE — the second buyer-side contact a transaction ROW itself names: `contacts.contact_id` (the
 * deal's client) on a BUYER deal, when it is neither the buyer nor the seller. On a seller / dual
 * deal the client column is the seller's side (or ambiguous) and names nobody here.
 * @proofSeam scripts/relationship-graph-guard.ts asserts the rule on the pure function.
 */
export function coBuyerContactIdsFromTransactionRow(tx: {
  deal_type?: string | null
  contact_id?: string | null
  buyer_contact_id?: string | null
  seller_contact_id?: string | null
}): string[] {
  if (tx.deal_type !== "buyer") return []
  const c = tx.contact_id
  if (!c || c === tx.buyer_contact_id || c === tx.seller_contact_id) return []
  return [c]
}

/**
 * The buyer-side contacts on a deal besides the buyer: the row's own second contact (above) plus
 * every roster row (transaction_participants) in a buyer role whose email is a CONTACT of this
 * tenant. The roster holds names and emails, never ids (lib/transactions/participant-populator.ts),
 * so the match is by email, lower-cased. A refused read contributes nothing and says so.
 */
export async function resolveCoBuyerContactIds(
  svc: Svc,
  input: { brokerageId: string; transactionId: string; tx: { deal_type?: string | null; contact_id?: string | null; buyer_contact_id?: string | null; seller_contact_id?: string | null } },
): Promise<{ ids: string[]; errors: string[] }> {
  const ids = new Set<string>(coBuyerContactIdsFromTransactionRow(input.tx))
  const errors: string[] = []
  const { data: roster, error: rosterErr } = await svc.from("transaction_participants").select("role, email")
    .eq("brokerage_id", input.brokerageId).eq("transaction_id", input.transactionId).in("role", ["buyer", "co_buyer"]).limit(20)
  if (rosterErr) errors.push(`roster read refused: ${rosterErr.message}`)
  const emails = [...new Set(((roster ?? []) as Array<{ email?: string | null }>).map((r) => (r.email ?? "").toString().trim().toLowerCase()).filter(Boolean))]
  if (emails.length > 0) {
    const { data: matched, error: matchErr } = await svc.from("contacts").select("id, email").eq("brokerage_id", input.brokerageId).in("email", emails).limit(20)
    if (matchErr) errors.push(`roster contact match refused: ${matchErr.message}`)
    for (const c of (matched ?? []) as Array<{ id: string; email?: string | null }>) {
      if (emails.includes((c.email ?? "").toString().trim().toLowerCase())) ids.add(c.id)
    }
  }
  const out = [...ids].filter((id) => id !== input.tx.buyer_contact_id && id !== input.tx.seller_contact_id).sort()
  return { ids: out, errors }
}

export async function deriveTransactionCloseEdges(
  svc: Svc,
  input: { brokerageId: string; transactionId: string; buyerContactId?: string | null; sellerContactId?: string | null; listingId?: string | null; coBuyerContactIds?: readonly string[] | null; closeDate: string; actorUserId?: string | null; now?: Date },
) {
  const observedAt = (input.now ?? new Date()).toISOString()
  const planned = planTransactionCloseEdges({ ...input, observedAt })
  const r = await upsertRelationships(svc, input.brokerageId, planned, input.actorUserId ?? null)
  return { ...r, planned: planned.length }
}

/** PURE — the stored key of a planned edge (orientation applied), for set membership. */
function edgeKey(e: { from: EntityRef; to: EntityRef; type: RelationshipType }): string {
  const o = orientEdge({ ...e, evidence: { source: "", confidence: 0, observed_at: "" } })
  return `${o.from.type}:${o.from.id}|${o.to.type}:${o.to.id}|${o.type}`
}

const CLOSE_EDGE_TYPES: readonly RelationshipType[] = ["bought_from", "sold_to", "owns", "previously_owned", "co_buyer"]
const CLOSE_BACKFILL_BATCH = 200

/**
 * R3 (wave 102.1) — SELF-HEALING BACKFILL of the closes that predate m698, on the existing weekly
 * learning cron, through the ONE derivation (never raw SQL). Bounded: the newest `limit` closed
 * transactions of the tenant; a close whose planned edges ALL exist is healed and costs no write;
 * the rest go through deriveTransactionCloseEdges (idempotent on the UNIQUE key). The roster is
 * read only for a close that still needs edges. Returns the summary the cron ledgers.
 */
export async function backfillTransactionCloseEdges(
  svc: Svc,
  input: { brokerageId: string; limit?: number; now?: Date },
): Promise<{ scanned: number; healed: number; derived: number; written: number; existing: number; errors: string[]; degraded: boolean }> {
  const out = { scanned: 0, healed: 0, derived: 0, written: 0, existing: 0, errors: [] as string[], degraded: false }
  if (!input.brokerageId) { out.errors.push("tenant scope required"); return out }
  const limit = Math.max(1, Math.min(input.limit ?? CLOSE_BACKFILL_BATCH, 1000))
  const { data: closed, error: txErr } = await svc.from("transactions")
    .select("id, listing_id, buyer_contact_id, seller_contact_id, contact_id, deal_type, close_date, agent_id")
    .eq("brokerage_id", input.brokerageId).in("status", ["closed", "funded"]).not("close_date", "is", null)
    .order("close_date", { ascending: false }).limit(limit)
  if (txErr) { out.errors.push(`closed transactions read refused: ${txErr.message}`); return out }
  const rows = (closed ?? []) as Array<{ id: string; listing_id: string | null; buyer_contact_id: string | null; seller_contact_id: string | null; contact_id: string | null; deal_type: string | null; close_date: string; agent_id: string | null }>
  out.scanned = rows.length
  if (rows.length === 0) return out
  const { data: edges, error: edgeErr } = await svc.from("relationship_edges")
    .select("from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type")
    .eq("brokerage_id", input.brokerageId).in("relationship_type", [...CLOSE_EDGE_TYPES]).limit(5000)
  if (edgeErr) {
    if (isMissingTable(edgeErr)) { out.degraded = true; out.errors.push("relationship_edges unreachable — nothing healed"); return out }
    out.errors.push(`edge read refused: ${edgeErr.message}`); return out
  }
  const have = new Set(((edges ?? []) as Array<{ from_entity_type: RelationshipEntityType; from_entity_id: string; to_entity_type: RelationshipEntityType; to_entity_id: string; relationship_type: RelationshipType }>)
    .map((e) => edgeKey({ from: { type: e.from_entity_type, id: e.from_entity_id }, to: { type: e.to_entity_type, id: e.to_entity_id }, type: e.relationship_type })))
  const observedAt = (input.now ?? new Date()).toISOString()
  for (const tx of rows) {
    const closeDate = String(tx.close_date).slice(0, 10)
    const rowCoBuyers = coBuyerContactIdsFromTransactionRow(tx)
    const planned = planTransactionCloseEdges({ transactionId: tx.id, buyerContactId: tx.buyer_contact_id, sellerContactId: tx.seller_contact_id, listingId: tx.listing_id, coBuyerContactIds: rowCoBuyers, closeDate, observedAt })
    if (planned.length === 0 || planned.every((e) => have.has(edgeKey(e)))) { out.healed++; continue }
    const co = await resolveCoBuyerContactIds(svc, { brokerageId: input.brokerageId, transactionId: tx.id, tx })
    out.errors.push(...co.errors.map((e) => `${tx.id}: ${e}`))
    const r = await deriveTransactionCloseEdges(svc, { brokerageId: input.brokerageId, transactionId: tx.id, buyerContactId: tx.buyer_contact_id, sellerContactId: tx.seller_contact_id, listingId: tx.listing_id, coBuyerContactIds: co.ids, closeDate, actorUserId: null, now: input.now })
    out.derived++; out.written += r.written; out.existing += r.existing
    out.errors.push(...r.errors.map((e) => `${tx.id}: ${e}`))
    if (r.degraded) out.degraded = true
  }
  return out
}

/** PURE — the roster says who REPRESENTS whom: buyer → buyer's agent, seller → listing agent. */
export function planRosterEdges(input: {
  buyerContactId?: string | null
  buyerAgent?: { type: "agent" | "outside_agent"; id: string } | null
  sellerContactId?: string | null
  sellerAgentUserId?: string | null
  observedAt: string
}): EdgeInput[] {
  const evidence: RelationshipEvidence = { source: "transaction_roster", confidence: 0.9, observed_at: input.observedAt }
  const out: EdgeInput[] = []
  if (input.buyerContactId && input.buyerAgent?.id) {
    out.push({ from: { type: "contact", id: input.buyerContactId }, to: { type: input.buyerAgent.type, id: input.buyerAgent.id }, type: "represented_by", evidence })
  }
  if (input.sellerContactId && input.sellerAgentUserId) {
    out.push({ from: { type: "contact", id: input.sellerContactId }, to: { type: "agent", id: input.sellerAgentUserId }, type: "represented_by", evidence })
  }
  return out
}

// ── Household derivation (marital status + same mailing address) ─────────────────────────────────

export interface HouseholdCandidateRow {
  id: string
  address?: string | null
  zip_code?: string | null
  mailing_address?: string | null
  mailing_zip?: string | null
  marital_status?: string | null
}

const PARTNERED_STATUSES: ReadonlySet<string> = new Set(["married", "partnered", "domestic_partner", "domestic_partnership", "civil_union", "cohabiting"])

/** PURE — the address key two contacts must share: normalised street line + zip (both required). */
function householdAddressKey(c: HouseholdCandidateRow): string | null {
  const street = (c.mailing_address ?? c.address ?? "").toString().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
  const zip = (c.mailing_zip ?? c.zip_code ?? "").toString().trim().slice(0, 5)
  if (!street || zip.length < 5) return null
  return `${street}|${zip}`
}

function isPartnered(status: string | null | undefined): boolean {
  return PARTNERED_STATUSES.has((status ?? "").toString().trim().toLowerCase())
}

/**
 * PURE — the household edges one contact's enrichment proves against the other contacts at the
 * same mailing address: spouse_partner when either side's marital status says partnered
 * (confidence 0.8 when both do, 0.7 when one does), household_member on address alone (0.5).
 * Symmetric, stored once (orientEdge). Deterministic: candidates are taken in id order.
 * @proofSeam scripts/relationship-graph-guard.ts asserts the planner on two contacts at one address.
 */
export function planHouseholdEdges(subject: HouseholdCandidateRow, others: readonly HouseholdCandidateRow[], observedAt: string, household?: { brokerageId: string }): EdgeInput[] {
  const key = householdAddressKey(subject)
  if (!key) return []
  const out: EdgeInput[] = []
  const sorted = [...others].filter((o) => o.id !== subject.id).sort((a, b) => a.id.localeCompare(b.id))
  const members: string[] = []
  for (const other of sorted) {
    if (householdAddressKey(other) !== key) continue
    members.push(other.id)
    const both = isPartnered(subject.marital_status) && isPartnered(other.marital_status)
    const one = isPartnered(subject.marital_status) || isPartnered(other.marital_status)
    const type: HouseholdRelationshipType = one ? "spouse_partner" : "household_member"
    const confidence = both ? 0.8 : one ? 0.7 : 0.5
    out.push(orientEdge({
      from: { type: "contact", id: subject.id },
      to: { type: "contact", id: other.id },
      type,
      evidence: { source: "household_financials", confidence, observed_at: observedAt },
    }))
  }
  // m715 — THE HOUSEHOLD NODE: one per (tenant, address cluster), only when the cluster has ≥ 2 contacts
  // (a lone contact at an address is not a household fact worth a node). Deterministic id from the
  // tenant + the normalised address key; every member (subject included) belongs_to_household at 0.6
  // (address alone — the person↔person edge above carries the marital evidence).
  if (household?.brokerageId && members.length > 0) {
    const node = { type: "household" as const, id: householdNodeId(household.brokerageId, key) }
    for (const id of [subject.id, ...members].sort()) {
      out.push({ from: { type: "contact", id }, to: node, type: "belongs_to_household", evidence: { source: "household_financials", confidence: 0.6, observed_at: observedAt } })
    }
  }
  return out
}

/** PURE — the household node for a tenant + normalised address key (street|zip). */
export function householdNodeId(brokerageId: string, addressKey: string): string {
  return entityIdForKey("household", `${brokerageId}|${addressKey}`)
}

/**
 * After a household/marital write lands on a contact: read the contact's address + marital status,
 * the other contacts of the SAME tenant sharing its zip, and upsert the planned edges. Tenant comes
 * from the caller's existing context. Never throws; a refused read is reported.
 */
export async function deriveHouseholdEdges(
  svc: Svc,
  input: { brokerageId: string; contactId: string; now?: Date },
): Promise<{ planned: number; written: number; existing: number; errors: string[]; degraded: boolean }> {
  const observedAt = (input.now ?? new Date()).toISOString()
  const cols = "id, address, zip_code, mailing_address, mailing_zip, marital_status"
  const { data: subject, error: subjErr } = await svc.from("contacts").select(cols)
    .eq("brokerage_id", input.brokerageId).eq("id", input.contactId).maybeSingle()
  if (subjErr) return { planned: 0, written: 0, existing: 0, errors: [`household subject read refused: ${subjErr.message}`], degraded: false }
  if (!subject) return { planned: 0, written: 0, existing: 0, errors: [], degraded: false }
  const key = householdAddressKey(subject as HouseholdCandidateRow)
  if (!key) return { planned: 0, written: 0, existing: 0, errors: [], degraded: false }
  const zip = key.split("|")[1]
  const { data: others, error: othersErr } = await svc.from("contacts").select(cols)
    .eq("brokerage_id", input.brokerageId).or(`mailing_zip.eq.${zip},zip_code.eq.${zip}`).limit(200)
  if (othersErr) return { planned: 0, written: 0, existing: 0, errors: [`household candidates read refused: ${othersErr.message}`], degraded: false }
  const planned = planHouseholdEdges(subject as HouseholdCandidateRow, (others ?? []) as HouseholdCandidateRow[], observedAt, { brokerageId: input.brokerageId })
  const r = await upsertRelationships(svc, input.brokerageId, planned, null)
  return { planned: planned.length, ...r }
}

// ── Co-owner derivation (the OTHER owner name on the contact's home, BatchData owner data) ───────

export interface CoOwnerCandidateRow extends HouseholdCandidateRow {
  first_name?: string | null
  last_name?: string | null
}

/** PURE — a person name reduced to its sorted word set ("SMITH JOHN A" == "John A. Smith"), initials dropped. */
function nameKey(...parts: Array<string | null | undefined>): string {
  const words = parts.filter((p): p is string => !!p).join(" ").toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((w) => w.length > 1)
  return [...new Set(words)].sort().join(" ")
}

/**
 * PURE — the co_owner edges the property's OWNER NAMES prove: every owner name that is not the
 * subject's own, matched to a contact of the tenant (same name words) among the candidates (the
 * caller bounds them to the subject's zip — co-owners live at the home). Confidence 0.75: a public
 * record's name plus the same zip, never a verified identity. Symmetric, stored once. Deterministic.
 * @proofSeam scripts/relationship-graph-guard.ts asserts the planner on an owner pair.
 */
export function planCoOwnerEdges(subject: CoOwnerCandidateRow, ownerNames: readonly string[], candidates: readonly CoOwnerCandidateRow[], observedAt: string): EdgeInput[] {
  const self = nameKey(subject.first_name, subject.last_name)
  const others = [...new Set(ownerNames.map((n) => nameKey(n)).filter((k) => k && k !== self))]
  if (others.length === 0) return []
  const out: EdgeInput[] = []
  const sorted = [...candidates].filter((c) => c.id !== subject.id).sort((a, b) => a.id.localeCompare(b.id))
  for (const c of sorted) {
    const k = nameKey(c.first_name, c.last_name)
    if (!k || !others.includes(k)) continue
    out.push(orientEdge({
      from: { type: "contact", id: subject.id },
      to: { type: "contact", id: c.id },
      type: "co_owner",
      evidence: { source: "batchdata_owner_names", confidence: 0.75, observed_at: observedAt },
    }))
  }
  return out
}

/**
 * After BatchData's property datasets land on a contact (owner names in property_records.batchdata):
 * match the other owner names to the tenant's contacts in the subject's zip and upsert co_owner.
 * Tenant from the caller's existing context. Never throws; a refused read is reported.
 */
export async function deriveCoOwnerEdges(
  svc: Svc,
  input: { brokerageId: string; contactId: string; ownerNames: readonly string[]; now?: Date },
): Promise<{ planned: number; written: number; existing: number; errors: string[]; degraded: boolean }> {
  const none = { planned: 0, written: 0, existing: 0, errors: [] as string[], degraded: false }
  if (!input.ownerNames || input.ownerNames.length < 2) return none
  const observedAt = (input.now ?? new Date()).toISOString()
  const cols = "id, first_name, last_name, address, zip_code, mailing_address, mailing_zip"
  const { data: subject, error: subjErr } = await svc.from("contacts").select(cols).eq("brokerage_id", input.brokerageId).eq("id", input.contactId).maybeSingle()
  if (subjErr) return { ...none, errors: [`co-owner subject read refused: ${subjErr.message}`] }
  if (!subject) return none
  const key = householdAddressKey(subject as HouseholdCandidateRow)
  if (!key) return none
  const zip = key.split("|")[1]
  const { data: others, error: othersErr } = await svc.from("contacts").select(cols)
    .eq("brokerage_id", input.brokerageId).or(`mailing_zip.eq.${zip},zip_code.eq.${zip}`).limit(200)
  if (othersErr) return { ...none, errors: [`co-owner candidates read refused: ${othersErr.message}`] }
  const planned = planCoOwnerEdges(subject as CoOwnerCandidateRow, input.ownerNames, (others ?? []) as CoOwnerCandidateRow[], observedAt)
  const r = await upsertRelationships(svc, input.brokerageId, planned, null)
  return { planned: planned.length, ...r }
}

// ── Occupancy derivation (the contact's mailing address IS a listing the tenant holds) ───────────

export interface OccupancyListingRow { id: string; address?: string | null; zip?: string | null }

/**
 * PURE — occupies edges: the contact's (mailing) address, normalised the household way, equals a
 * listing's address in the same zip. Confidence 0.7 with a residence signal on the contact
 * (home_owner_status renter / owner — the rental-graduation sourcer's renters), 0.6 on address alone.
 * Deterministic: listings taken in id order.
 * @proofSeam scripts/relationship-graph-guard.ts asserts the planner on a listing at the contact's address.
 */
export function planOccupancyEdges(
  subject: HouseholdCandidateRow & { home_owner_status?: string | null },
  listings: readonly OccupancyListingRow[],
  observedAt: string,
  source: string,
): EdgeInput[] {
  const key = householdAddressKey(subject)
  if (!key) return []
  const status = (subject.home_owner_status ?? "").toString().trim().toLowerCase()
  const confidence = status === "renter" || status === "owner" ? 0.7 : 0.6
  const out: EdgeInput[] = []
  for (const l of [...listings].sort((a, b) => a.id.localeCompare(b.id))) {
    if (householdAddressKey({ id: l.id, address: l.address, zip_code: l.zip }) !== key) continue
    out.push({ from: { type: "contact", id: subject.id }, to: { type: "listing", id: l.id }, type: "occupies", evidence: { source, confidence, observed_at: observedAt } })
  }
  return out
}

/**
 * After an address (or a residence signal) lands on a contact: read its address, the tenant's
 * listings in that zip, and upsert `occupies`. `source` names the survivor writer (e.g.
 * "contact_enrichment", "rental_graduation"). Never throws; a refused read is reported.
 */
export async function deriveOccupancyEdges(
  svc: Svc,
  input: { brokerageId: string; contactId: string; source: string; now?: Date },
): Promise<{ planned: number; written: number; existing: number; errors: string[]; degraded: boolean }> {
  const none = { planned: 0, written: 0, existing: 0, errors: [] as string[], degraded: false }
  const observedAt = (input.now ?? new Date()).toISOString()
  const { data: subject, error: subjErr } = await svc.from("contacts").select("id, address, zip_code, mailing_address, mailing_zip, home_owner_status")
    .eq("brokerage_id", input.brokerageId).eq("id", input.contactId).maybeSingle()
  if (subjErr) return { ...none, errors: [`occupancy subject read refused: ${subjErr.message}`] }
  if (!subject) return none
  const key = householdAddressKey(subject as HouseholdCandidateRow)
  if (!key) return none
  const zip = key.split("|")[1]
  const { data: listings, error: listErr } = await svc.from("listings").select("id, address, zip")
    .eq("brokerage_id", input.brokerageId).eq("zip", zip).is("deleted_at", null).limit(200)
  if (listErr) return { ...none, errors: [`occupancy listings read refused: ${listErr.message}`] }
  const planned = planOccupancyEdges(subject as HouseholdCandidateRow, (listings ?? []) as OccupancyListingRow[], observedAt, input.source)
  const r = await upsertRelationships(svc, input.brokerageId, planned, null)
  return { planned: planned.length, ...r }
}

// ── Reader helpers for the surfaces ──────────────────────────────────────────────────────────────

/** The contact's represented_by edges that point at an OUTSIDE agent — "never touch another brokerage's client". */
export function representedByOutsideAgent(edges: readonly RelationshipEdge[], contactId: string): RelationshipEdge | null {
  return edges.find((e) => e.relationship_type === "represented_by" && e.from_entity_type === "contact" && e.from_entity_id === contactId && e.to_entity_type === "outside_agent") ?? null
}

/** PURE — one human line per edge for a brief / talking point, from the contact's point of view. */
export function describeEdge(e: RelationshipEdge, contactId: string): string {
  const outbound = e.from_entity_type === "contact" && e.from_entity_id === contactId
  const other = outbound ? `${e.to_entity_type} ${e.to_entity_id.slice(0, 8)}` : `${e.from_entity_type} ${e.from_entity_id.slice(0, 8)}`
  const label: Record<RelationshipType, [string, string]> = {
    spouse_partner: ["spouse/partner of", "spouse/partner of"],
    household_member: ["household member with", "household member with"],
    co_buyer: ["co-buyer with", "co-buyer with"],
    co_owner: ["co-owner with", "co-owner with"],
    owns: ["owns", "owned by"],
    occupies: ["occupies", "occupied by"],
    previously_owned: ["previously owned", "previously owned by"],
    referred_by: ["referred by", "referred"],
    represented_by: ["represented by", "represents"],
    lender_for: ["lender for", "lender:"],
    vendor_for: ["vendor for", "vendor:"],
    sponsor_of: ["sponsor of", "sponsored by"],
    bought_from: ["bought from", "sold to"],
    sold_to: ["sold to", "bought from"],
    // m715
    belongs_to_household: ["belongs to household", "household of"],
    has_opportunity: ["has opportunity", "opportunity of"],
    interacted_with_campaign: ["interacted with campaign", "campaign reached"],
    member_of_team: ["member of team", "team of"],
    serves_territory: ["serves territory", "territory served by"],
    recruited_by: ["recruited by", "recruited"],
    has_competency: ["has competency", "competency of"],
    completed_education: ["completed", "completed by"],
    earns_residual: ["earns residual from", "pays residual to"],
    owns_opportunity: ["owns opportunity", "opportunity owned by"],
  }
  const [out, inn] = label[e.relationship_type]
  const conf = Math.round(clampConfidence(Number(e.evidence?.confidence ?? 0)) * 100)
  return `${outbound ? out : inn} ${other} (${e.evidence?.source ?? "unknown"}, ${conf}%)`
}

/**
 * PURE — a contact that HOLDS a vendor seat (contacts.vendor_id, written by
 * lib/kernel/vendor-seat-contact.ts at seat activation — wave 103, lane 103D): the seat's own
 * `vendor_for` edges (vendor → the contacts it served, derived at createVendorBooking) CORROBORATE
 * the seat. Reads the edges the caller fetched for the VENDOR entity; a contact with no seat, or
 * edges of another vendor, corroborate nothing.
 * @proofSeam scripts/relationship-graph-guard.ts executes the rule directly.
 */
export function vendorSeatCorroboration(edges: readonly RelationshipEdge[], contactVendorId: string | null | undefined): { corroborated: boolean; served: string[]; edges: RelationshipEdge[] } {
  if (!contactVendorId) return { corroborated: false, served: [], edges: [] }
  const own = edges.filter((e) => e.relationship_type === "vendor_for" && e.from_entity_type === "vendor" && e.from_entity_id === contactVendorId)
  const served = [...new Set(own.filter((e) => e.to_entity_type === "contact").map((e) => e.to_entity_id))].sort()
  return { corroborated: own.length > 0, served, edges: own }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WAVE 105 (lane 105D; m715) — traversal, the agent/person derivations, the structure backfill, seams
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** PURE — `${type}:${id}` for set membership / path keys. */
function refKey(r: { type: string; id: string }): string { return `${r.type}:${r.id}` }

/**
 * PURE — is the edge in force at `at` (YYYY-MM-DD)? valid_from = effective_from (null = always),
 * valid_to = effective_to (null = still in force). Date strings compare lexically.
 * @proofSeam scripts/relationship-graph-guard.ts asserts the window at its four edges.
 */
export function edgeValidAt(e: Pick<RelationshipEdge, "effective_from" | "effective_to">, at: string): boolean {
  const day = at.slice(0, 10)
  if (e.effective_from && String(e.effective_from).slice(0, 10) > day) return false
  if (e.effective_to && String(e.effective_to).slice(0, 10) < day) return false
  return true
}

/** PURE — the endpoint of `e` that is not `self` (null when `self` is on neither side). */
export function otherEndpoint(e: RelationshipEdge, self: EntityRef): EntityRef | null {
  if (e.from_entity_type === self.type && e.from_entity_id === self.id) return { type: e.to_entity_type, id: e.to_entity_id }
  if (e.to_entity_type === self.type && e.to_entity_id === self.id) return { type: e.from_entity_type, id: e.from_entity_id }
  return null
}

/**
 * PURE — §5: agents see CONTACTS only. No edge with a `lead` endpoint reaches an agent-facing surface
 * (the contact brief, the NBA context). The lead desk reads the unfiltered graph.
 * @proofSeam scripts/relationship-graph-guard.ts asserts a lead-endpoint edge is dropped and a contact edge kept.
 */
export function agentVisibleEdges<T extends Pick<RelationshipEdge, "from_entity_type" | "to_entity_type">>(edges: readonly T[]): T[] {
  return edges.filter((e) => e.from_entity_type !== "lead" && e.to_entity_type !== "lead")
}

export interface TraversalNode {
  entity: EntityRef
  /** Hops from the start (0 = the start itself). */
  depth: number
  /** Product of the edge confidences along the BEST path found (1 at the start). */
  confidence: number
  /** Edge ids along that path, start → node. */
  path: string[]
  /** The relationship type of the LAST hop (null at the start). */
  via: RelationshipType | null
}

export interface TraversalResult {
  ok: boolean
  start: EntityRef
  nodes: TraversalNode[]
  edges: RelationshipEdge[]
  /** The table is not there yet (m698 unapplied): an EMPTY graph, not a refusal. */
  degraded: boolean
  /** A fan-out or node cap was hit — the frontier beyond it was not read. */
  truncated: boolean
  error: string | null
}

export const TRAVERSE_MAX_DEPTH = 3
const TRAVERSE_DEFAULT_FANOUT = 25
const TRAVERSE_DEFAULT_MAX_NODES = 200

/**
 * BFS over relationship_edges from `start`, tenant-scoped, depth ≤ TRAVERSE_MAX_DEPTH, honouring the
 * validity window at `at` (default today), cycle-safe (a node is visited once; a better-confidence
 * path to an already-visited node updates its confidence but never re-expands it), bounded fan-out
 * per node and a node cap (truncated = true when either bites), confidence multiplied along the path.
 * Deterministic: neighbors are sorted, expansion order is sorted. Reads through `neighbors` only.
 */
export async function traverse(
  svc: Svc,
  input: { brokerageId: string; start: EntityRef; depth?: number; types?: readonly RelationshipType[]; at?: string; maxFanOut?: number; maxNodes?: number },
): Promise<TraversalResult> {
  const base: TraversalResult = { ok: true, start: input.start, nodes: [], edges: [], degraded: false, truncated: false, error: null }
  if (!input.brokerageId) return { ...base, ok: false, error: "tenant scope required" }
  if (!input.start?.type || !input.start?.id) return { ...base, ok: false, error: "a start entity is required" }
  const depth = Math.max(0, Math.min(input.depth ?? TRAVERSE_MAX_DEPTH, TRAVERSE_MAX_DEPTH))
  const at = (input.at ?? new Date().toISOString()).slice(0, 10)
  const fanOut = Math.max(1, input.maxFanOut ?? TRAVERSE_DEFAULT_FANOUT)
  const maxNodes = Math.max(1, input.maxNodes ?? TRAVERSE_DEFAULT_MAX_NODES)

  const seen = new Map<string, TraversalNode>()
  const edgeById = new Map<string, RelationshipEdge>()
  const startNode: TraversalNode = { entity: input.start, depth: 0, confidence: 1, path: [], via: null }
  seen.set(refKey(input.start), startNode)
  let frontier: TraversalNode[] = [startNode]
  let truncated = false, degraded = false

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: TraversalNode[] = []
    for (const node of frontier) {
      const res = await neighbors(svc, { brokerageId: input.brokerageId, entity: node.entity, types: input.types })
      if (!res.ok) return { ...base, ok: false, error: res.error, nodes: [...seen.values()], edges: [...edgeById.values()] }
      if (res.degraded) degraded = true
      const live = res.edges.filter((e) => edgeValidAt(e, at))
      if (live.length > fanOut) truncated = true
      for (const e of live.slice(0, fanOut)) {
        const other = otherEndpoint(e, node.entity)
        if (!other) continue
        edgeById.set(e.id, e)
        const conf = Math.round(node.confidence * clampConfidence(Number(e.evidence?.confidence ?? 0)) * 1000) / 1000
        const key = refKey(other)
        const have = seen.get(key)
        if (have) {
          if (conf > have.confidence && have.depth >= node.depth + 1) { have.confidence = conf; have.path = [...node.path, e.id]; have.via = e.relationship_type }
          continue
        }
        if (seen.size >= maxNodes) { truncated = true; continue }
        const made: TraversalNode = { entity: other, depth: node.depth + 1, confidence: conf, path: [...node.path, e.id], via: e.relationship_type }
        seen.set(key, made)
        next.push(made)
      }
    }
    frontier = next.sort((a, b) => refKey(a.entity).localeCompare(refKey(b.entity)))
  }
  const nodes = [...seen.values()].sort((a, b) => a.depth - b.depth || b.confidence - a.confidence || refKey(a.entity).localeCompare(refKey(b.entity)))
  const edges = [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { ok: true, start: input.start, nodes, edges, degraded, truncated, error: null }
}

/**
 * PURE — rank traversal nodes (paths): highest confidence first, then fewest hops, then a stable key.
 * The start node (depth 0) is excluded; `limit` bounds the answer.
 * @proofSeam scripts/relationship-graph-guard.ts asserts the ordering on a fixture.
 */
export function rankPaths(nodes: readonly TraversalNode[], limit = 20): TraversalNode[] {
  return nodes.filter((n) => n.depth > 0)
    .sort((a, b) => b.confidence - a.confidence || a.depth - b.depth || refKey(a.entity).localeCompare(refKey(b.entity)))
    .slice(0, Math.max(0, limit))
}

/**
 * Close an edge's validity window: effective_to (valid_to) is set to `effectiveTo` when the edge
 * exists and is still open (or ends later). Never deletes — the fact that the relationship held is
 * evidence. Returns how many rows matched (0 = no such open edge; the caller decides whether that matters).
 */
export async function endRelationship(
  svc: Svc,
  input: { brokerageId: string; from: EntityRef; to: EntityRef; type: RelationshipType; effectiveTo: string },
): Promise<{ ok: boolean; matched: number; error: string | null; degraded: boolean }> {
  if (!input.brokerageId) return { ok: false, matched: 0, error: "tenant scope required", degraded: false }
  const e = orientEdge({ from: input.from, to: input.to, type: input.type, evidence: { source: "", confidence: 0, observed_at: "" } })
  const day = input.effectiveTo.slice(0, 10)
  const { data, error } = await svc.from("relationship_edges")
    .update({ effective_to: day })
    .eq("brokerage_id", input.brokerageId)
    .eq("from_entity_type", e.from.type).eq("from_entity_id", e.from.id)
    .eq("to_entity_type", e.to.type).eq("to_entity_id", e.to.id)
    .eq("relationship_type", e.type)
    .or(`effective_to.is.null,effective_to.gte.${day}`)
    .select("id")
  if (error) return { ok: false, matched: 0, error: `edge close refused: ${error.message}`, degraded: isMissingTable(error) }
  return { ok: true, matched: (data ?? []).length, error: null, degraded: false }
}

/** agents.id → users.id (the graph's `agent` endpoint, §3). A refused or empty read is reported as null. */
export async function agentUserIdFor(svc: Svc, brokerageId: string, agentsId: string): Promise<{ userId: string | null; error: string | null }> {
  if (!agentsId) return { userId: null, error: null }
  const { data, error } = await svc.from("agents").select("user_id").eq("id", agentsId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { userId: null, error: `agent user read refused: ${error.message}` }
  return { userId: ((data as { user_id?: string | null } | null)?.user_id as string | null) ?? null, error: null }
}

type DeriveSummary = { planned: number; written: number; existing: number; errors: string[]; degraded: boolean }
const noneDerived = (): DeriveSummary => ({ planned: 0, written: 0, existing: 0, errors: [], degraded: false })

// ── member_of_team ───────────────────────────────────────────────────────────────────────────────

/**
 * After a team assignment lands (users.team_id / agents.team_id / a team_members roster row): the
 * agent (USERS id — resolved from agents.id when that is what the writer holds) is member_of_team.
 * `source` names the writer ("users.assignUserToTeam", "agent_profile", "team_members"). A roster row
 * carries the terms, so it is the stronger evidence (0.95); a plain assignment column is 0.9.
 */
export async function deriveTeamMembershipEdge(
  svc: Svc,
  input: { brokerageId: string; teamId: string; agentUserId?: string | null; agentsId?: string | null; source: string; effectiveFrom?: string | null; actorUserId?: string | null; now?: Date },
): Promise<DeriveSummary> {
  const out = noneDerived()
  if (!input.teamId) return out
  let userId = input.agentUserId ?? null
  if (!userId && input.agentsId) {
    const r = await agentUserIdFor(svc, input.brokerageId, input.agentsId)
    if (r.error) { out.errors.push(r.error); return out }
    userId = r.userId
  }
  if (!userId) return out
  const observedAt = (input.now ?? new Date()).toISOString()
  const planned: EdgeInput[] = [{
    from: { type: "agent", id: userId }, to: { type: "team", id: input.teamId }, type: "member_of_team",
    evidence: { source: input.source, confidence: input.source === "team_members" ? 0.95 : 0.9, observed_at: observedAt },
    effectiveFrom: input.effectiveFrom ?? null,
  }]
  const r = await upsertRelationships(svc, input.brokerageId, planned, input.actorUserId ?? null)
  return { planned: planned.length, ...r }
}

// ── recruited_by + earns_residual (recruit → agent provisioning) ────────────────────────────────

/**
 * PURE — what provisioning a recruit proves: the new agent was recruited_by the recruiter (always,
 * recruits.recruiter_agent_id, 1.0) and, when the revenue-share tree edge was planted, the sponsor
 * earns_residual from the recruit (agent_relationships, 1.0, from the provisioning day).
 * @proofSeam scripts/relationship-graph-guard.ts asserts both shapes and the no-residual case.
 */
export function planRecruitEdges(input: { recruitUserId: string; recruiterUserId: string; residualPlanted: boolean; observedAt: string; provisionedOn?: string | null }): EdgeInput[] {
  if (!input.recruitUserId || !input.recruiterUserId || input.recruitUserId === input.recruiterUserId) return []
  const out: EdgeInput[] = [{
    from: { type: "agent", id: input.recruitUserId }, to: { type: "agent", id: input.recruiterUserId }, type: "recruited_by",
    evidence: { source: "recruits.recruiter_agent_id", confidence: 1, observed_at: input.observedAt }, effectiveFrom: input.provisionedOn ?? null,
  }]
  if (input.residualPlanted) out.push({
    from: { type: "agent", id: input.recruiterUserId }, to: { type: "agent", id: input.recruitUserId }, type: "earns_residual",
    evidence: { source: "agent_relationships", confidence: 1, observed_at: input.observedAt }, effectiveFrom: input.provisionedOn ?? null,
  })
  return out
}

// ── has_competency (the learning router's scoreCompetency load) ─────────────────────────────────

export interface CompetencySkillReading { skill: string; score: number | null; confidence: "none" | "low" | "high" }

/**
 * PURE — the competencies an agent HAS: every scored skill at or above `threshold` (the caller passes
 * COMPETENCY_GAP_SCORE so the graph and the curriculum router agree on one bar). Edge confidence comes
 * from the profile's own evidence gate: high → 0.9, low → 0.6; an unproven (null) skill is never an
 * edge. The competency node id is deterministic from the skill key.
 * @proofSeam scripts/relationship-graph-guard.ts asserts threshold, confidence mapping and the null case.
 */
export function planCompetencyEdges(agentUserId: string, skills: readonly CompetencySkillReading[], opts: { threshold: number; observedAt: string }): EdgeInput[] {
  if (!agentUserId) return []
  const out: EdgeInput[] = []
  for (const s of [...skills].sort((a, b) => a.skill.localeCompare(b.skill))) {
    if (s.score == null || s.confidence === "none" || s.score < opts.threshold) continue
    out.push({
      from: { type: "agent", id: agentUserId }, to: { type: "competency", id: entityIdForKey("competency", s.skill) }, type: "has_competency",
      evidence: { source: "scoreCompetency", confidence: s.confidence === "high" ? 0.9 : 0.6, observed_at: opts.observedAt },
    })
  }
  return out
}

export async function deriveCompetencyEdges(
  svc: Svc,
  input: { brokerageId: string; agentUserId: string; skills: readonly CompetencySkillReading[]; threshold: number; now?: Date },
): Promise<DeriveSummary> {
  const planned = planCompetencyEdges(input.agentUserId, input.skills, { threshold: input.threshold, observedAt: (input.now ?? new Date()).toISOString() })
  if (planned.length === 0) return noneDerived()
  const r = await upsertRelationships(svc, input.brokerageId, planned, null)
  return { planned: planned.length, ...r }
}

// ── completed_education ──────────────────────────────────────────────────────────────────────────

/**
 * After a learning_assignments row reaches `completed` (an agent's quiz pass, a contact's client
 * education): learner → education_module (learning_modules.id), valid from the completion day.
 * `source` names the writer ("academy_quiz_pass", "client_education").
 */
export async function deriveEducationCompletedEdge(
  svc: Svc,
  input: { brokerageId: string; learner: { type: "agent" | "contact"; id: string }; moduleId: string; source: string; completedAt?: string | null; actorUserId?: string | null; now?: Date },
): Promise<DeriveSummary> {
  if (!input.learner?.id || !input.moduleId) return noneDerived()
  const observedAt = (input.now ?? new Date()).toISOString()
  const planned: EdgeInput[] = [{
    from: input.learner, to: { type: "education_module", id: input.moduleId }, type: "completed_education",
    evidence: { source: input.source, confidence: 1, observed_at: observedAt }, effectiveFrom: (input.completedAt ?? observedAt).slice(0, 10),
  }]
  const r = await upsertRelationships(svc, input.brokerageId, planned, input.actorUserId ?? null)
  return { planned: planned.length, ...r }
}

// ── owns_opportunity (lead hand-off / contact ownership) ─────────────────────────────────────────

/**
 * After an ownership column lands (leads.agent_id / contacts.agent_id — both agents.id): the new owner
 * (USERS id) owns_opportunity from today; the previous owner's edge, when known, is CLOSED (valid_to =
 * today) — never deleted. A null new owner (released to the ISA) only closes.
 */
export async function deriveOpportunityOwnership(
  svc: Svc,
  input: { brokerageId: string; opportunity: { type: "lead" | "contact"; id: string }; toAgentsId: string | null; fromAgentsId?: string | null; source: string; actorUserId?: string | null; now?: Date },
): Promise<DeriveSummary & { closed: number }> {
  const out = { ...noneDerived(), closed: 0 }
  if (!input.opportunity?.id) return out
  const now = input.now ?? new Date()
  const day = now.toISOString().slice(0, 10)
  if (input.fromAgentsId && input.fromAgentsId !== input.toAgentsId) {
    const prev = await agentUserIdFor(svc, input.brokerageId, input.fromAgentsId)
    if (prev.error) out.errors.push(prev.error)
    else if (prev.userId) {
      const c = await endRelationship(svc, { brokerageId: input.brokerageId, from: { type: "agent", id: prev.userId }, to: input.opportunity, type: "owns_opportunity", effectiveTo: day })
      if (!c.ok && c.error) { out.errors.push(c.error); if (c.degraded) out.degraded = true }
      out.closed += c.matched
    }
  }
  if (!input.toAgentsId) return out
  const next = await agentUserIdFor(svc, input.brokerageId, input.toAgentsId)
  if (next.error) { out.errors.push(next.error); return out }
  if (!next.userId) return out
  const planned: EdgeInput[] = [{
    from: { type: "agent", id: next.userId }, to: input.opportunity, type: "owns_opportunity",
    evidence: { source: input.source, confidence: 1, observed_at: now.toISOString() }, effectiveFrom: day,
  }]
  const r = await upsertRelationships(svc, input.brokerageId, planned, input.actorUserId ?? null)
  return { ...out, planned: planned.length, written: r.written, existing: r.existing, errors: [...out.errors, ...r.errors], degraded: out.degraded || r.degraded }
}

// ── has_opportunity (a contact's lead row in a cycle) + interacted_with_campaign ─────────────────

/**
 * PURE — a sequence enrollment that names BOTH a contact and a lead proves the contact has_opportunity
 * (the lead row is the person's cycle record). One without both proves nothing here.
 * @proofSeam scripts/relationship-graph-guard.ts asserts the pair and the half cases.
 */
export function planOpportunityEdges(input: { contactId?: string | null; leadId?: string | null; source: string; observedAt: string }): EdgeInput[] {
  if (!input.contactId || !input.leadId) return []
  return [{ from: { type: "contact", id: input.contactId }, to: { type: "lead", id: input.leadId }, type: "has_opportunity", evidence: { source: input.source, confidence: 0.8, observed_at: input.observedAt } }]
}

/**
 * After campaign touchpoints land (marketing_campaign_touchpoints): each contact interacted_with_campaign
 * (marketing_campaigns.id). A touchpoint is a delivery fact, not a reply: 0.7. Bounded to 500 contacts.
 */
export async function deriveCampaignInteraction(
  svc: Svc,
  input: { brokerageId: string; campaignId: string; contactIds: readonly string[]; source: string; now?: Date },
): Promise<DeriveSummary> {
  if (!input.campaignId) return noneDerived()
  const observedAt = (input.now ?? new Date()).toISOString()
  const ids = [...new Set(input.contactIds.filter(Boolean))].sort().slice(0, 500)
  const planned: EdgeInput[] = ids.map((id) => ({ from: { type: "contact" as const, id }, to: { type: "campaign" as const, id: input.campaignId }, type: "interacted_with_campaign" as const, evidence: { source: input.source, confidence: 0.7, observed_at: observedAt } }))
  if (planned.length === 0) return noneDerived()
  const r = await upsertRelationships(svc, input.brokerageId, planned, null)
  return { planned: planned.length, ...r }
}

// ── serves_territory + member_of_team: the structure backfill (weekly cron, R3 pattern) ──────────

/**
 * SELF-HEALING BACKFILL of the agent-structure edges from their survivor TABLES, on the existing weekly
 * learning cron beside backfillTransactionCloseEdges. farm_territories.agent_id has NO server-side
 * writer (the admin page writes it from the browser), so the only honest derivation reads the table;
 * agents.team_id is healed the same way (the assignment writers derive at write time, this closes the
 * rows that predate m715). Idempotent on the UNIQUE key; bounded; a refused read is reported.
 */
export async function backfillAgentStructureEdges(
  svc: Svc,
  input: { brokerageId: string; limit?: number; now?: Date },
): Promise<{ scanned: number; planned: number; written: number; existing: number; errors: string[]; degraded: boolean }> {
  const out = { scanned: 0, planned: 0, written: 0, existing: 0, errors: [] as string[], degraded: false }
  if (!input.brokerageId) { out.errors.push("tenant scope required"); return out }
  const limit = Math.max(1, Math.min(input.limit ?? 500, 2000))
  const observedAt = (input.now ?? new Date()).toISOString()
  const { data: agents, error: agentErr } = await svc.from("agents").select("id, user_id, team_id").eq("brokerage_id", input.brokerageId).eq("is_active", true).limit(limit)
  if (agentErr) { out.errors.push(`agents read refused: ${agentErr.message}`); return out }
  const rows = (agents ?? []) as Array<{ id: string; user_id: string | null; team_id: string | null }>
  const userByAgent = new Map(rows.filter((a) => a.user_id).map((a) => [a.id, a.user_id as string]))
  const planned: EdgeInput[] = []
  for (const a of [...rows].sort((x, y) => x.id.localeCompare(y.id))) {
    if (a.user_id && a.team_id) planned.push({ from: { type: "agent", id: a.user_id }, to: { type: "team", id: a.team_id }, type: "member_of_team", evidence: { source: "agents.team_id", confidence: 0.9, observed_at: observedAt } })
  }
  const { data: terr, error: terrErr } = await svc.from("farm_territories").select("id, agent_id").eq("brokerage_id", input.brokerageId).eq("is_active", true).not("agent_id", "is", null).limit(limit)
  if (terrErr) out.errors.push(`farm_territories read refused: ${terrErr.message}`)
  for (const t of ([...((terr ?? []) as Array<{ id: string; agent_id: string | null }>)]).sort((x, y) => x.id.localeCompare(y.id))) {
    const userId = t.agent_id ? userByAgent.get(t.agent_id) : null
    if (userId) planned.push({ from: { type: "agent", id: userId }, to: { type: "territory", id: t.id }, type: "serves_territory", evidence: { source: "farm_territories.agent_id", confidence: 0.9, observed_at: observedAt } })
  }
  out.scanned = rows.length + ((terr ?? []) as unknown[]).length
  out.planned = planned.length
  if (planned.length === 0) return out
  const r = await upsertRelationships(svc, input.brokerageId, planned, null)
  out.written = r.written; out.existing = r.existing; out.errors.push(...r.errors); out.degraded = r.degraded
  return out
}

// ── Readers for the surfaces (scorecard counts, command center, the 105C context seam) ──────────

/** How many edges this tenant holds (the command center's "relationships" figure beside the twin). */
export async function countRelationships(svc: Svc, input: { brokerageId: string }): Promise<{ count: number; degraded: boolean; error: string | null }> {
  if (!input.brokerageId) return { count: 0, degraded: false, error: "tenant scope required" }
  const { count, error } = await svc.from("relationship_edges").select("id", { count: "exact", head: true }).eq("brokerage_id", input.brokerageId)
  if (error) return isMissingTable(error) ? { count: 0, degraded: true, error: null } : { count: 0, degraded: false, error: `edge count refused: ${error.message}` }
  return { count: count ?? 0, degraded: false, error: null }
}

export const AGENT_STRUCTURE_TYPES: readonly RelationshipType[] = ["member_of_team", "serves_territory", "has_competency", "completed_education", "owns_opportunity", "recruited_by", "earns_residual", "sponsor_of"]

/** PURE — per agent (USERS id), how many edges of each structure type point out of it. */
export function agentGraphCounts(edges: readonly RelationshipEdge[], agentUserId: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of edges) {
    if (e.from_entity_type !== "agent" || e.from_entity_id !== agentUserId) continue
    out[e.relationship_type] = (out[e.relationship_type] ?? 0) + 1
  }
  return out
}

/** The structure edges of a roster of agents (USERS ids) in one read, for the scorecard. */
export async function agentStructureEdges(svc: Svc, input: { brokerageId: string; agentUserIds: readonly string[] }): Promise<NeighborsResult> {
  if (!input.brokerageId) return { ok: false, edges: [], degraded: false, error: "tenant scope required" }
  const ids = [...new Set(input.agentUserIds.filter(Boolean))]
  if (ids.length === 0) return { ok: true, edges: [], degraded: false, error: null }
  const { data, error } = await svc.from("relationship_edges")
    .select("id, brokerage_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type, evidence, effective_from, effective_to, created_by")
    .eq("brokerage_id", input.brokerageId).eq("from_entity_type", "agent").in("from_entity_id", ids).in("relationship_type", [...AGENT_STRUCTURE_TYPES]).limit(5000)
  if (error) return isMissingTable(error) ? { ok: true, edges: [], degraded: true, error: null } : { ok: false, edges: [], degraded: false, error: `edge read refused: ${error.message}` }
  return { ok: true, edges: (data ?? []) as RelationshipEdge[], degraded: false, error: null }
}

export interface GraphContext {
  ok: boolean
  /** One compact human line per ranked node, from the start entity's point of view. */
  lines: string[]
  nodes: TraversalNode[]
  degraded: boolean
  truncated: boolean
  error: string | null
}

/**
 * THE SEAM FOR THE CONTEXT COMPILER (105C) — export only; 105C imports it, this lane never edits
 * 105C's file. A compact, ranked, agent-safe (`agentSafe`: lead endpoints dropped, §5) view of what
 * is related to `entity` up to `depth` hops at `at`. Lines are bounded by `limit`.
 */
export async function graphContextFor(
  svc: Svc,
  input: { brokerageId: string; entity: EntityRef; depth?: number; at?: string; types?: readonly RelationshipType[]; limit?: number; agentSafe?: boolean },
): Promise<GraphContext> {
  const t = await traverse(svc, { brokerageId: input.brokerageId, start: input.entity, depth: input.depth ?? 2, at: input.at, types: input.types })
  if (!t.ok) return { ok: false, lines: [], nodes: [], degraded: t.degraded, truncated: t.truncated, error: t.error }
  const edgeById = new Map(t.edges.map((e) => [e.id, e]))
  const visible = input.agentSafe === false ? t.nodes : t.nodes.filter((n) => n.entity.type !== "lead" && n.path.every((id) => { const e = edgeById.get(id); return !e || (e.from_entity_type !== "lead" && e.to_entity_type !== "lead") }))
  const ranked = rankPaths(visible, input.limit ?? 12)
  const lines = ranked.map((n) => `${n.entity.type} ${n.entity.id.slice(0, 8)} — ${n.via ?? "?"} (${n.depth} hop${n.depth === 1 ? "" : "s"}, ${Math.round(n.confidence * 100)}%)`)
  return { ok: true, lines, nodes: ranked, degraded: t.degraded, truncated: t.truncated, error: null }
}

/** The named seam object 105C's compiler reads (neighbors / traverse / graphContextFor) — nothing else is contractual. */
export const RELATIONSHIP_GRAPH_SEAM = { neighbors, traverse, graphContextFor, rankPaths, agentVisibleEdges } as const
