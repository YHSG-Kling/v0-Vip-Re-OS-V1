#!/usr/bin/env tsx
/**
 * scripts/parent-child-graph-guard.ts   (npm run test:parent-child-graph — key listed for the integrator,
 * lane 144I; package.json is not edited by lanes)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DIRECTED PARENT/CHILD AUDIT OVER THE FIVE BUSINESS CHAINS (wave 144, lane 144I; owner ruling 18:
 * "managing managers … work together so the agentic OS runs smoothly; they share evidence through the
 * canonical kernel; every workflow exception has an accountable registered owner").
 *
 *   ORG       PLATFORM → BROKERAGE → LOCATION → TEAM → AGENT
 *   PERSON    PERSON → CONTACT / VENDOR / AGENT
 *   DEAL      PROPERTY → LISTING → OFFER → ACCEPTED COUNTER / CONTRACT → TRANSACTION → COMMISSION / CLOSING
 *   MARKETING STRATEGY → CAMPAIGN → ASSET → TOUCHPOINT → OUTCOME
 *   FINANCE   SIGNED AGREEMENT → FINANCIAL RULES → CAP CYCLE → COMMISSION → REVENUE SHARE → PAYMENT
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT (CLAUDE.md §1 — no fourth instrument) ──────────────────────────
 * The whole-repo instruments already exist and are NOT re-implemented here; this guard composes them
 * and adds only the EDGE-level, CHAIN-scoped questions none of them asks:
 *   · a child row that lost its parent (FK-less parent-shaped column, SET NULL erasing parentage,
 *     lifecycle orphans)                       → scripts/orphaned-child-census.ts (OC1–OC4)
 *   · a column written and never read / read and never written (whole repo) → scripts/opposite-missing-census.ts
 *   · a server-action FILE imported by nothing → scripts/orphan-action-guard.ts
 *   · RLS on child tables that carry tenant rows → scripts/child-tenant-scope-simulator.ts (live)
 *   · the knowledge graph (relationship_edges) → scripts/relationship-graph-guard.ts
 *   · ledger-derived money truth               → scripts/economic-graph-guard.ts
 *   · the transfer rail's FK closure           → scripts/brokerage-identity-guard.ts (E2)
 * This file asks, per ARROW of the owner's five chains: is the link REAL in the schema (and of the kind
 * the map says)? does any code WRITE the link column and any code TRAVERSE it? which kernel EVENT
 * witnesses the promotion and does anything emit it? is the same edge stored more than once and, if so,
 * is there ONE resolver? is a materialized copy reconciled? do both ends have an accountable manager,
 * and is the hand-off between two managers a licensed MANAGER_COLLABORATIONS edge? does any action that
 * writes a chain table have no caller? and — the owner's caveat — GRAPH ≠ PERMISSION: no access gate
 * may derive an allow from graph reachability.
 *
 * ── THE MAP IS DECLARED, EVERY READING IS DERIVED ───────────────────────────────────────────────────
 * CHAINS below is the map (which table plays which node, which column carries which arrow). It is never
 * the verdict: each arrow's link kind is RE-DERIVED from the generated FK cache (scripts/schema-fk-map.ts)
 * and the column cache (scripts/schema-snapshot.ts) and the run FAILS when the map disagrees with the
 * schema (a declared FK that is not in the cache, a declared "absent" link that now exists, a table that
 * left LIVE_TABLES). Writers / readers / emitters are found in STRIPPED runtime source
 * (scripts/strip-comments.ts blankComments — a tombstone naming `.from("x").insert(...)` is not a call
 * site, §2) plus the migration SQL (a trigger / backfill writer reads as writerless otherwise, §3).
 *
 * ── FINDINGS ARE A WIRE LIST, RATCHETED BY KEY ──────────────────────────────────────────────────────
 * Every finding has a stable key. KNOWN_FINDINGS holds the ones measured at 967a4866 with their owner
 * (a MANAGERS key) and route (the lane / owner question that closes it). A NEW key FAILS the run; a known
 * key that no longer occurs is printed as BURNED and does NOT fail (asserting a waypoint would turn the
 * guard red the day the work lands — §2). A count that moves is the finding: say which way and why.
 *
 * ── POSITIVE CONTROLS (§2 — a broken finder and a clean tree both report zero) ─────────────────────
 * Each detector is driven on a fixture it MUST flag and a fixture it must NOT flag (a comment-only
 * "writer" is the not-flag control for the writer/reader/emitter finders). A failed control fails the run.
 *
 * ── LIVE ARM ───────────────────────────────────────────────────────────────────────────────────────
 * The structural half runs offline. The row half (cross-tenant links, mirror drift, parent-without-child)
 * is SQL; `--sql` prints every statement. It was run once through the Supabase MCP on LIVE_MEASURED_ON
 * against hrvaqgvukzxfskkcrwbt and the readings are DECLARED below beside their SQL (the OC2 pattern of
 * scripts/orphaned-child-census.ts) — with their denominators, because 0 rows over 2 transactions is weak
 * evidence. Without credentials the run says it did not re-measure; it never folds a green line over rows
 * it did not read.
 *
 * BLIND SPOTS (published beside every number — see the BLIND SPOTS block printed at the end).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import { runtimeFiles } from "./runtime-roots"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { LIVE_TABLES } from "./live-tables"
import { MANAGERS, TABLE_MANAGER, canRefer, type ManagerKey } from "../lib/kernel/manager-registry"
import { EXCEPTION_CATEGORIES } from "../lib/kernel/exceptions-first"

const ROOT = process.cwd()
const SQL_MODE = process.argv.includes("--sql")
const LIST = process.argv.includes("--list")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// THE MAP
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

type LinkSpec =
  /** child.column → parent is a foreign key (derived from SCHEMA_FK_MAP). */
  | { kind: "fk"; column: string }
  /** parent.column → child is a foreign key — the arrow points the other way in the schema. */
  | { kind: "reverse_fk"; column: string }
  /** No FK by design; the link is carried by columns on `holder` and resolved by `via`. The run asserts
   *  the columns exist AND that no FK exists between the two tables (else the map is stale: it is an fk). */
  | { kind: "soft"; holder: "child" | "parent"; columns: string[]; via: string;
      /** A polymorphic link: holder.typeColumn = typeValue identifies the other end. The writer census
       *  then looks for a write of that VALUE, not only of the column. */
      polymorphic?: { typeColumn: string; idColumn: string; typeValue: string } }
  /** The parent is not a row (the platform, a property since m547). */
  | { kind: "root"; why: string }
  /** No link exists. The run asserts none exists in the cache (else the map is stale). */
  | { kind: "absent"; why: string }

interface SymbolRef { file: string; symbol: string }

interface ArrowSpec {
  id: string
  parentNode: string
  childNode: string
  /** null when the parent node is not a table (PLATFORM, PROPERTY). */
  parent: string | null
  child: string
  link: LinkSpec
  /** KernelEvent members that witness this promotion (a member must exist AND be emitted somewhere). */
  events?: string[]
  /** The same edge stored on another table (table.column → the same parent). */
  mirrors?: { table: string; column: string }[]
  /** THE one answer across the mirrors. Required when mirrors exist. */
  resolver?: SymbolRef
  /** parent.column ALSO points at the child (a two-way pointer) and the ONE writer that keeps both. */
  bidirectional?: { column: string; writer: SymbolRef }
  /** A copy of parent truth held on a row (can go stale) and the reconciler that re-derives it. */
  materialized?: { table: string; column: string; truth: string; reconciler: SymbolRef | null }[]
}

interface ChainSpec { key: string; label: string; arrows: ArrowSpec[] }

export const CHAINS: ChainSpec[] = [
  {
    key: "org", label: "PLATFORM → BROKERAGE → LOCATION → TEAM → AGENT",
    arrows: [
      { id: "org.platform>brokerage", parentNode: "PLATFORM", childNode: "BROKERAGE", parent: null, child: "brokerages",
        link: { kind: "root", why: "the platform is not a row: platform staff are users.platform_role (CLAUDE.md §4); a brokerage is the tenant root and carries no parent tenant" } },
      { id: "org.brokerage>location", parentNode: "BROKERAGE", childNode: "LOCATION", parent: "brokerages", child: "locations",
        link: { kind: "fk", column: "brokerage_id" } },
      { id: "org.location>team", parentNode: "LOCATION", childNode: "TEAM", parent: "locations", child: "teams",
        link: { kind: "absent", why: "teams carry no location_id — a team is a mini brokerage (CLAUDE.md §4) anchored on brokerage_id + team_lead_id; agents carry location_id directly. Whether a team belongs to ONE office is an owner question" } },
      { id: "org.brokerage>team", parentNode: "BROKERAGE", childNode: "TEAM", parent: "brokerages", child: "teams",
        link: { kind: "fk", column: "brokerage_id" } },
      { id: "org.team>agent", parentNode: "TEAM", childNode: "AGENT", parent: "teams", child: "agents",
        link: { kind: "fk", column: "team_id" }, events: ["USER_TEAM_ASSIGNED"],
        mirrors: [{ table: "users", column: "team_id" }, { table: "team_members", column: "team_id" }],
        resolver: { file: "lib/kernel/resolve-user-team.ts", symbol: "resolveUserTeam" } },
      { id: "org.location>agent", parentNode: "LOCATION", childNode: "AGENT", parent: "locations", child: "agents",
        link: { kind: "fk", column: "location_id" },
        mirrors: [{ table: "users", column: "location_id" }],
        resolver: { file: "lib/kernel/resolve-user-office.ts", symbol: "resolveUserOffice" } },
      { id: "org.brokerage>agent", parentNode: "BROKERAGE", childNode: "AGENT", parent: "brokerages", child: "agents",
        link: { kind: "fk", column: "brokerage_id" }, events: ["USER_BROKERAGE_ASSIGNED"],
        mirrors: [{ table: "users", column: "brokerage_id" }],
        resolver: { file: "lib/kernel/users.ts", symbol: "assignUserToBrokerage" } },
    ],
  },
  {
    key: "person", label: "PERSON → CONTACT / VENDOR / AGENT",
    arrows: [
      { id: "person.person>contact", parentNode: "PERSON", childNode: "CONTACT", parent: "person_identities", child: "contacts",
        link: { kind: "reverse_fk", column: "canonical_contact_id" } },
      { id: "person.person>evidence", parentNode: "PERSON", childNode: "IDENTITY EVIDENCE", parent: "person_identities", child: "person_identity_evidence",
        link: { kind: "fk", column: "person_id" } },
      { id: "person.vendor>contact", parentNode: "VENDOR", childNode: "CONTACT (a person who IS the vendor)", parent: "vendors", child: "contacts",
        link: { kind: "fk", column: "vendor_id" } },
      { id: "person.vendor>seat", parentNode: "VENDOR", childNode: "VENDOR SEAT (users via user_role_assignments)", parent: "vendors", child: "user_role_assignments",
        link: { kind: "fk", column: "vendor_id" } },
      { id: "person.user>agent", parentNode: "PERSON (the account)", childNode: "AGENT", parent: "users", child: "agents",
        link: { kind: "fk", column: "user_id" } },
      { id: "person.person>agent", parentNode: "PERSON (person_identities)", childNode: "AGENT", parent: "person_identities", child: "agents",
        link: { kind: "absent", why: "the person graph (m697) spans raw/lead/contact/attendee/form/behavioural rows only — PERSON_ENTITY_TYPES names no agent, user or vendor, so an agent who is also a client is two people. Owner question" } },
    ],
  },
  {
    key: "deal", label: "PROPERTY → LISTING → OFFER → ACCEPTED COUNTER / CONTRACT → TRANSACTION → COMMISSION / CLOSING",
    arrows: [
      { id: "deal.property>listing", parentNode: "PROPERTY", childNode: "LISTING", parent: null, child: "listings",
        link: { kind: "root", why: "no canonical property table since m547 dropped `properties`: a property is identified softly — listings.mls_number, an IDX property_id on buyer-side rows, address_key on market caches (three spellings for three sources; the buyer path never assumes the listing is in VIPAgents, ruling 19)" } },
      { id: "deal.listing>agreement", parentNode: "LISTING", childNode: "LISTING AGREEMENT", parent: "listings", child: "listing_agreements",
        link: { kind: "fk", column: "listing_id" }, events: ["LISTING_AGREEMENT_SIGNED"] },
      { id: "deal.listing>offer", parentNode: "LISTING", childNode: "OFFER", parent: "listings", child: "offers",
        link: { kind: "fk", column: "listing_id" }, events: ["OFFER_RECEIVED"] },
      { id: "deal.offer>counter", parentNode: "OFFER", childNode: "COUNTER", parent: "offers", child: "offers",
        link: { kind: "fk", column: "parent_offer_id" }, events: ["OFFER_OS_COUNTERED"] },
      { id: "deal.offer>contract_terms", parentNode: "OFFER / ACCEPTED COUNTER", childNode: "CONTRACT TERMS (executed version)", parent: "offers", child: "contract_term_versions",
        link: { kind: "fk", column: "offer_id" } },
      { id: "deal.contract_terms>transaction", parentNode: "CONTRACT TERMS", childNode: "TRANSACTION", parent: "contract_term_versions", child: "transactions",
        link: { kind: "reverse_fk", column: "transaction_id" } },
      { id: "deal.offer>transaction", parentNode: "OFFER", childNode: "TRANSACTION", parent: "offers", child: "transactions",
        link: { kind: "fk", column: "offer_id" }, events: ["LISTING_UNDER_CONTRACT"],
        bidirectional: { column: "transaction_id", writer: { file: "lib/transactions/offer-bridge.ts", symbol: "createTransactionFromOffer" } } },
      { id: "deal.transaction>distribution", parentNode: "TRANSACTION", childNode: "COMMISSION (waterfall rows)", parent: "transactions", child: "commission_distributions",
        link: { kind: "fk", column: "transaction_id" }, events: ["COMMISSION_CALCULATED"] },
      { id: "deal.transaction>payable", parentNode: "TRANSACTION", childNode: "COMMISSION (payable ledger)", parent: "transactions", child: "agent_commissions",
        link: { kind: "fk", column: "transaction_id" },
        materialized: [{ table: "agent_commissions", column: "net_to_agent", truth: "commission_distributions (the waterfall rows)", reconciler: { file: "lib/commission/reconcile-tracking.ts", symbol: "reconcileSummariesAgainstLedger" } }] },
      { id: "deal.transaction>stamp", parentNode: "TRANSACTION", childNode: "COMMISSION (deal stamp)", parent: "transactions", child: "transaction_commissions",
        link: { kind: "fk", column: "transaction_id" },
        materialized: [{ table: "transaction_commissions", column: "calculated_amount", truth: "agent_commissions (the payable ledger)", reconciler: { file: "lib/commission/ledger-sync.ts", symbol: "syncStampToAgentLedger" } }] },
      { id: "deal.transaction>calc_audit", parentNode: "TRANSACTION", childNode: "COMMISSION (calculation audit)", parent: "transactions", child: "commission_calculations",
        link: { kind: "fk", column: "transaction_id" } },
      { id: "deal.transaction>cda", parentNode: "TRANSACTION", childNode: "CLOSING (CDA)", parent: "transactions", child: "closing_disclosure_agreement",
        link: { kind: "fk", column: "transaction_id" }, events: ["CDA_GENERATED", "CDA_APPROVED"] },
      { id: "deal.transaction>closing_checklist", parentNode: "TRANSACTION", childNode: "CLOSING (checklist)", parent: "transactions", child: "closing_checklist_items",
        link: { kind: "fk", column: "transaction_id" }, events: ["TRANSACTION_CLOSED"] },
    ],
  },
  {
    key: "marketing", label: "STRATEGY → CAMPAIGN → ASSET → TOUCHPOINT → OUTCOME",
    arrows: [
      { id: "marketing.library>activation", parentNode: "STRATEGY (library version)", childNode: "STRATEGY (tenant activation)", parent: "strategy_library", child: "strategy_activations",
        link: { kind: "fk", column: "library_id" } },
      { id: "marketing.activation>mission", parentNode: "STRATEGY (activation)", childNode: "MISSION", parent: "strategy_activations", child: "missions",
        link: { kind: "soft", holder: "child", columns: ["evidence"], via: "lib/kernel/strategy-engine.ts activateStrategy → lib/kernel/missions.ts attachEvidence (kind STRATEGY_EVIDENCE_KIND) + the ledger's detail.strategy {key, version, tier}" } },
      { id: "marketing.strategy>campaign", parentNode: "STRATEGY", childNode: "CAMPAIGN", parent: "strategy_activations", child: "marketing_campaigns",
        link: { kind: "absent", why: "a marketing_campaigns row records no strategy key / version / mission — the Campaign Orchestrator's plan step reads selectStrategies (lib/agents/campaign-orchestrator.ts) but the campaign it creates cannot say which strategy it executes, so strategy → outcome attribution cannot join through campaigns" } },
      { id: "marketing.campaign>asset", parentNode: "CAMPAIGN", childNode: "ASSET", parent: "marketing_campaigns", child: "marketing_assets",
        link: { kind: "fk", column: "campaign_id" } },
      { id: "marketing.campaign>touchpoint", parentNode: "CAMPAIGN", childNode: "TOUCHPOINT", parent: "marketing_campaigns", child: "marketing_campaign_touchpoints",
        link: { kind: "fk", column: "campaign_id" } },
      { id: "marketing.asset>touchpoint", parentNode: "ASSET", childNode: "TOUCHPOINT", parent: "marketing_assets", child: "marketing_campaign_touchpoints",
        link: { kind: "soft", holder: "child", columns: ["external_table", "external_id"], via: "lib/marketing/touchpoint-recorder.ts recordCampaignTouchpointSafe (externalTable / externalId)",
          polymorphic: { typeColumn: "external_table", idColumn: "external_id", typeValue: "marketing_assets" } } },
      { id: "marketing.touchpoint>outcome", parentNode: "TOUCHPOINT", childNode: "OUTCOME (attribution credit)", parent: "marketing_campaign_touchpoints", child: "marketing_attribution_credits",
        link: { kind: "soft", holder: "child", columns: ["campaign_id", "contact_id", "touchpoint_count"], via: "lib/marketing/attribution.ts attributeTransactionSafe folds a deal's touchpoints per (campaign, contact) into credits" } },
    ],
  },
  {
    key: "finance", label: "SIGNED AGREEMENT → FINANCIAL RULES → CAP CYCLE → COMMISSION → REVENUE SHARE → PAYMENT",
    arrows: [
      { id: "finance.signed>terms", parentNode: "SIGNED AGREEMENT", childNode: "FINANCIAL RULES (dated terms)", parent: "contract_signatures", child: "agent_commission_profile_versions",
        link: { kind: "soft", holder: "child", columns: ["agent_id", "effective_from"], via: "lib/commission/agreement-terms.ts — the signed record is READ and cited, never copied (wave 143C)" } },
      { id: "finance.profile>terms", parentNode: "FINANCIAL RULES (current row)", childNode: "FINANCIAL RULES (append-only history)", parent: "agent_commission_profiles", child: "agent_commission_profile_versions",
        link: { kind: "soft", holder: "child", columns: ["agent_id", "terms"], via: "m812 trigger on agent_commission_profiles writes every version (no app writer by design)" } },
      { id: "finance.terms>cap_cycle", parentNode: "FINANCIAL RULES", childNode: "CAP CYCLE (agent)", parent: "agent_commission_profile_versions", child: "agent_cap_tracking",
        link: { kind: "soft", holder: "child", columns: ["agent_id", "cap_amount", "anniversary_start", "anniversary_end"], via: "lib/commission/cap-resolver.ts ensureAgentCapWindow (pickCapAmount + resolveAnniversaryWindow)" },
        materialized: [{ table: "agent_cap_tracking", column: "cap_amount", truth: "the agreement terms in effect for the window", reconciler: { file: "lib/commission/cap-resolver.ts", symbol: "pickCapAmount" } }] },
      { id: "finance.team_terms>team_cap", parentNode: "FINANCIAL RULES (team)", childNode: "CAP CYCLE (team)", parent: "team_commission_profiles", child: "team_cap_tracking",
        link: { kind: "soft", holder: "child", columns: ["team_id", "cap_amount"], via: "lib/commission/cap-resolver.ts ensureTeamCapWindows" } },
      { id: "finance.cap_cycle>commission", parentNode: "CAP CYCLE", childNode: "COMMISSION", parent: "agent_cap_tracking", child: "commission_distributions",
        link: { kind: "soft", holder: "child", columns: ["agent_id", "cap_status", "cap_applied"], via: "the waterfall judges the agent's anniversary window (lib/commission/waterfall/*) and stage 11 adds to cap_paid_to_date" },
        materialized: [{ table: "agent_cap_tracking", column: "cap_paid_to_date", truth: "the sum of cap-eligible brokerage contributions in the anniversary window (commission_distributions)", reconciler: null }] },
      { id: "finance.sponsor>revenue_share", parentNode: "REVENUE SHARE (sponsor edge)", childNode: "COMMISSION (revenue-share rows)", parent: "agent_relationships", child: "commission_distributions",
        link: { kind: "soft", holder: "child", columns: ["agent_id", "distribution_type"], via: "lib/commission/waterfall/09-revenue-share.ts judges agent_relationships on the deal's close_date" } },
      { id: "finance.commission>payment", parentNode: "COMMISSION (waterfall rows)", childNode: "PAYMENT (payable ledger state)", parent: "commission_distributions", child: "agent_commissions",
        link: { kind: "reverse_fk", column: "commission_id" }, events: ["COMMISSION_APPROVED", "COMMISSION_PAID"] },
    ],
  },
]

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// KNOWN FINDINGS AT 967a4866 — the wire list (owner + route). A NEW key fails; a BURNED key is printed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const KNOWN_FINDINGS: Record<string, { owner: ManagerKey; route: string }> = {
  "absent:org.location>team": { owner: "recruiting_manager", route: "OWNER QUESTION — does a team belong to one office? (no migration written: never invent a hierarchy)" },
  "absent:person.person>agent": { owner: "data_steward", route: "OWNER QUESTION — should the person graph span agent / vendor seats (PERSON_ENTITY_TYPES)?" },
  "absent:marketing.strategy>campaign": { owner: "campaign_orchestrator", route: "Outside-lane — campaign creators stamp the strategy ref (lane 144I notes: campaign-orchestrator kickoff)" },
  "edge-never-written:marketing.asset>touchpoint": { owner: "campaign_orchestrator", route: "Outside-lane 144H/144F — no touchpoint writer records external_table='marketing_assets', so which ASSET reached the contact is unrecorded" },
  "unreconciled:finance.cap_cycle>commission:agent_cap_tracking.cap_paid_to_date": { owner: "finance_manager", route: "lane 144D — the cap paid-to-date ledger (ruling 9) needs a re-derivation from commission_distributions" },
  "event-duplicate-vocabulary:deal.offer>counter": { owner: "shopping_agent", route: "§6 — OFFER_COUNTER_SENT / OFFER_ACCEPTED and OFFER_OS_COUNTERED / OFFER_OS_ACCEPTED are two spellings of one promotion (lane 144C notes)" },
  "live:org.team>agent:mirror-drift": { owner: "recruiting_manager", route: "live 2026-10-25: 1 of 5 agents has agents.team_id ≠ users.team_id and no active team_members row — resolveUserTeam decides; the stores were never reconciled" },
  "event-never-emitted:deal.transaction>cda:CDA_GENERATED": { owner: "deal_coordinator", route: "lane 144D (app/actions/cda-portal.ts) — the CDA create/generate writer emits no event; KernelEvent.CDA_GENERATED is a dead member (emit it at the write, or retire it with a tombstone)" },
  "live:org.location>agent:mirror-drift": { owner: "data_steward", route: "live 2026-10-25: 1 of 5 agents has agents.location_id ≠ users.location_id — resolveUserOffice decides" },
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LIVE READINGS — measured through the Supabase MCP, declared with their SQL and denominators.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const LIVE_MEASURED_ON = "2026-10-25"
interface LiveReading { arrow: string; what: string; sql: string; n: number; denominator: string; rule: "zero" | "info" }
const LIVE_READINGS: LiveReading[] = [
  { arrow: "org.team>agent", what: "agents.team_id → team in ANOTHER tenant", rule: "zero", n: 0, denominator: "5 agents, 1 team",
    sql: "select count(*) from agents a join teams t on t.id=a.team_id where a.brokerage_id is distinct from t.brokerage_id" },
  { arrow: "org.location>agent", what: "agents.location_id → location in another tenant", rule: "zero", n: 0, denominator: "5 agents, 1 location",
    sql: "select count(*) from agents a join locations l on l.id=a.location_id where a.brokerage_id is distinct from l.brokerage_id" },
  { arrow: "person.user>agent", what: "agents.user_id → user in another tenant", rule: "zero", n: 0, denominator: "5 agents, 23 users",
    sql: "select count(*) from agents a join users u on u.id=a.user_id where u.brokerage_id is distinct from a.brokerage_id" },
  { arrow: "org.team>agent", what: "MIRROR DRIFT agents.team_id ≠ users.team_id", rule: "info", n: 1, denominator: "5 agents",
    sql: "select count(*) from agents a join users u on u.id=a.user_id where a.team_id is distinct from u.team_id" },
  { arrow: "org.team>agent", what: "agents.team_id set with no active team_members row", rule: "info", n: 1, denominator: "5 agents, 0 team_members rows",
    sql: "select count(*) from agents a where a.team_id is not null and not exists (select 1 from team_members m where m.agent_id=a.id and m.team_id=a.team_id and coalesce(m.is_active,true))" },
  { arrow: "org.location>agent", what: "MIRROR DRIFT agents.location_id ≠ users.location_id", rule: "info", n: 1, denominator: "5 agents",
    sql: "select count(*) from agents a join users u on u.id=a.user_id where a.location_id is distinct from u.location_id" },
  { arrow: "org.brokerage>location", what: "brokerages with no location (parent without child)", rule: "info", n: 1, denominator: "2 brokerages",
    sql: "select count(*) from brokerages b where not exists (select 1 from locations l where l.brokerage_id=b.id)" },
  { arrow: "deal.listing>offer", what: "offers.listing_id → listing in another tenant", rule: "zero", n: 0, denominator: "0 offers, 3 listings",
    sql: "select count(*) from offers x join listings l on l.id=x.listing_id where l.brokerage_id is distinct from x.brokerage_id" },
  { arrow: "deal.offer>transaction", what: "transactions.offer_id and offers.transaction_id disagree", rule: "zero", n: 0, denominator: "2 transactions, 0 offers",
    sql: "select count(*) from transactions t join offers o on o.id=t.offer_id where o.transaction_id is distinct from t.id" },
  { arrow: "deal.transaction>distribution", what: "closed transaction with no commission_distributions (parent without child)", rule: "zero", n: 0, denominator: "2 transactions (clear_to_close, under_contract — none closed: NOT_APPLICABLE, never PASS)",
    sql: "select count(*) from transactions t where t.status in ('closed','completed') and not exists (select 1 from commission_distributions d where d.transaction_id=t.id)" },
  { arrow: "deal.transaction>cda", what: "closed transaction with no CDA", rule: "info", n: 0, denominator: "0 closed transactions (NOT_APPLICABLE); a CDA is required only where the brokerage offers it",
    sql: "select count(*) from transactions t where t.status in ('closed','completed') and not exists (select 1 from closing_disclosure_agreement d where d.transaction_id=t.id)" },
  { arrow: "person.person>contact", what: "contacts with no person_identities row (m697 has no backfill)", rule: "info", n: 4, denominator: "4 contacts, 0 person rows",
    sql: "select count(*) from contacts c where not exists (select 1 from person_identities p where p.canonical_contact_id=c.id)" },
  { arrow: "finance.terms>cap_cycle", what: "agents with no agent_commission_profiles row (financial rules missing)", rule: "info", n: 4, denominator: "5 agents (finance baseline is an onboarding input — nothing is assumed)",
    sql: "select count(*) from agents a where not exists (select 1 from agent_commission_profiles p where p.agent_id=a.id)" },
]

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SOURCE INDEX — stripped runtime source + migration SQL, read once
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const rel = (p: string) => p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p.replace(/^\.\//, "")
const files = runtimeFiles(".").map(rel).sort()
const CODE = new Map<string, string>()
for (const f of files) CODE.set(f, blankComments(readFileSync(join(ROOT, f), "utf8")))

const MIG_DIR = join(ROOT, "supabase/migrations")
const SQL = new Map<string, string>()
for (const f of existsSync(MIG_DIR) ? readdirSync(MIG_DIR).filter((x) => x.endsWith(".sql")).sort() : []) {
  // SQL line comments removed (a header narrative naming a column is not a writer).
  SQL.set(`supabase/migrations/${f}`, readFileSync(join(MIG_DIR, f), "utf8").replace(/--[^\n]*/g, ""))
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const FROM_RE = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g

interface FromHit { file: string; idx: number; window: string }
function indexFromHits(code: Map<string, string>): Map<string, FromHit[]> {
  const out = new Map<string, FromHit[]>()
  for (const [file, src] of code) {
    const hits = [...src.matchAll(FROM_RE)]
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]
      const start = h.index ?? 0
      const nextFrom = i + 1 < hits.length ? (hits[i + 1].index ?? src.length) : src.length
      const window = src.slice(start, Math.min(nextFrom, start + 2400))
      const list = out.get(h[1]) ?? []
      list.push({ file, idx: start, window })
      out.set(h[1], list)
    }
  }
  return out
}
const FROM_INDEX = indexFromHits(CODE)
const lineOf = (file: string, idx: number) => (CODE.get(file) ?? "").slice(0, idx).split("\n").length

// ── WRITER finder: does code write `column` on `table`? ─────────────────────────────────────────────
type Tier = "statement" | "file" | "sql" | "none"
const WRITE_CALL = /\.(insert|upsert|update)\(/
function columnKeyRe(column: string): RegExp {
  // `column:` as an object key, or a shorthand `{ column }` / `, column,` member.
  return new RegExp(`(?:[{,\\s]["']?${esc(column)}["']?\\s*:)|(?:[{,]\\s*${esc(column)}\\s*[,}])`)
}
/** The ARGUMENT of the first .insert( / .upsert( / .update( in a statement window — balanced parentheses,
 *  so a later call's object (an emit's metadata, a log line) is never read as this write's payload. */
function writePayload(window: string): string | null {
  const m = WRITE_CALL.exec(window)
  if (!m) return null
  let i = (m.index ?? 0) + m[0].length, depth = 1
  const start = i
  for (; i < window.length && depth > 0; i++) {
    const c = window[i]
    if (c === "(") depth++
    else if (c === ")") depth--
  }
  return window.slice(start, i - 1)
}
export function findWriters(table: string, column: string, index: Map<string, FromHit[]>, code: Map<string, string>, sql: Map<string, string>): { tier: Tier; where: string[] } {
  const hits = index.get(table) ?? []
  const keyRe = columnKeyRe(column)
  const strong = hits.filter((h) => { const p = writePayload(h.window); return p !== null && keyRe.test(p) })
  if (strong.length) return { tier: "statement", where: [...new Set(strong.map((h) => `${h.file}:${lineOf(h.file, h.idx)}`))] }
  // A payload built in a variable before the call: the file writes the table AND names the column as a key.
  const weak = [...new Set(hits.filter((h) => WRITE_CALL.test(h.window)).map((h) => h.file))].filter((f) => keyRe.test(code.get(f) ?? ""))
  if (weak.length) return { tier: "file", where: weak }
  // Migration SQL: INSERT INTO t (… column …), UPDATE t SET … column =, a trigger NEW.column := / INSERT … SELECT.
  const t = `(?:public\\.)?${esc(table)}`
  const sqlRes = [
    new RegExp(`insert\\s+into\\s+${t}\\s*\\([^)]*\\b${esc(column)}\\b`, "i"),
    new RegExp(`update\\s+${t}\\s+set\\s[^;]*\\b${esc(column)}\\s*=`, "i"),
  ]
  const sqlHits = [...sql.entries()].filter(([, s]) => sqlRes.some((re) => re.test(s))).map(([f]) => f)
  if (sqlHits.length) return { tier: "sql", where: sqlHits }
  return { tier: "none", where: [] }
}

// ── READER finder: does code traverse `column` on `table` (filter on it, select it, or embed across it)? ──
/** A select whose column list is a same-file string CONSTANT (`const COLS = "a, b"` … `.select(COLS)`)
 *  is resolved — the strategy engine reads that way on purpose ("one read shape each"). */
const constCache = new Map<string, Map<string, string>>()
function fileStringConsts(file: string, code: Map<string, string>): Map<string, string> {
  const hit = constCache.get(file)
  if (hit && code === CODE) return hit
  const m = new Map<string, string>()
  for (const x of (code.get(file) ?? "").matchAll(/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'`]([^"'`]*)["'`]/g)) m.set(x[1], x[2])
  if (code === CODE) constCache.set(file, m)
  return m
}
export function findReaders(table: string, column: string, other: string | null, index: Map<string, FromHit[]>, code: Map<string, string> = CODE): string[] {
  const hits = index.get(table) ?? []
  const filterRe = new RegExp(`\\.(eq|in|is|neq|match|contains|filter|not|or)\\(\\s*["'\`][^"'\`]*\\b${esc(column)}\\b`)
  const selectRe = new RegExp(`\\.select\\(\\s*["'\`][^"'\`]*\\b${esc(column)}\\b`)
  const colRe = new RegExp(`\\b${esc(column)}\\b`)
  const out = new Set<string>()
  for (const h of hits) {
    const w = h.window.split(/\.(insert|upsert)\(/)[0]
    let hit = filterRe.test(w) || selectRe.test(w)
    if (!hit) {
      const ident = w.match(/\.select\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/)?.[1]
      const list = ident ? fileStringConsts(h.file, code).get(ident) : undefined
      if (list && colRe.test(list)) hit = true
    }
    if (hit) out.add(`${h.file}:${lineOf(h.file, h.idx)}`)
  }
  // Embed from the other end: .from(other).select("… table(…" / "table!…" / "alias:table(…").
  if (other) {
    const embedRe = new RegExp(`\\.select\\(\\s*["'\`][^"'\`]*(?:[\\s,(:!]|^)${esc(table)}\\s*[(!]`)
    for (const h of index.get(other) ?? []) if (embedRe.test(h.window)) out.add(`${h.file}:${lineOf(h.file, h.idx)}`)
  }
  return [...out].sort()
}

// ── EVENT finder ─────────────────────────────────────────────────────────────────────────────────────
const EVENTS_FILE = "lib/kernel/events.ts"
function parseKernelEvents(src: string): Map<string, string> {
  const m = new Map<string, string>()
  const body = src.split(/export\s+enum\s+KernelEvent\s*\{/)[1]?.split(/\n\}/)[0] ?? ""
  for (const x of body.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*['"]([a-z0-9_.:]+)['"]/gm)) m.set(x[1], x[2])
  return m
}
export function findEmitters(member: string, value: string, code: Map<string, string>): string[] {
  const memberRe = new RegExp(`KernelEvent\\.${esc(member)}\\b`)
  const valueRe = new RegExp(`event\\s*:\\s*["'\`]${esc(value)}["'\`]`)
  return [...code.entries()].filter(([f, s]) => f !== EVENTS_FILE && (memberRe.test(s) || valueRe.test(s))).map(([f]) => f)
}

// ── SYMBOL finder (resolver / reconciler / bidirectional writer exist as real exports) ──────────────
export function symbolExists(ref: SymbolRef, code: Map<string, string>): boolean {
  const s = code.get(ref.file)
  if (!s) return false
  return new RegExp(`export\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+)${esc(ref.symbol)}\\b`).test(s)
}

// ── LINK derivation ────────────────────────────────────────────────────────────────────────────────
type FkMap = Record<string, Record<string, string>>
export function fkColumns(fk: FkMap, from: string, to: string): string[] {
  return Object.entries(fk[from] ?? {}).filter(([, t]) => t === to).map(([c]) => c).sort()
}
export function verifyLink(a: ArrowSpec, fk: FkMap, snap: Record<string, string[]>): string | null {
  const L = a.link
  if (L.kind === "fk") return a.parent && (fk[a.child] ?? {})[L.column] === a.parent ? null : `declared FK ${a.child}.${L.column} → ${a.parent} is not in the FK cache`
  if (L.kind === "reverse_fk") return a.parent && (fk[a.parent] ?? {})[L.column] === a.child ? null : `declared FK ${a.parent}.${L.column} → ${a.child} is not in the FK cache`
  if (L.kind === "root") {
    if (a.parent !== null) return "a root arrow must have no parent table"
    return null
  }
  if (!a.parent) return "non-root arrow without a parent table"
  const anyFk = fkColumns(fk, a.child, a.parent).length + (a.child === a.parent ? 0 : fkColumns(fk, a.parent, a.child).length)
  if (L.kind === "absent") return anyFk === 0 ? null : `declared ABSENT but ${anyFk} FK(s) now link ${a.parent} ↔ ${a.child} — the map is stale`
  // soft
  const holder = L.holder === "child" ? a.child : a.parent
  const missing = L.columns.filter((c) => !(snap[holder] ?? []).includes(c))
  if (missing.length) return `soft link columns missing on ${holder}: ${missing.join(", ")}`
  return anyFk === 0 ? null : `declared SOFT but an FK links ${a.parent} ↔ ${a.child} — the map is stale (make it fk)`
}

// ── PERMISSION ≠ GRAPH scan ────────────────────────────────────────────────────────────────────────
const GRAPH_MODULES = ["@/lib/kernel/relationship-graph", "@/lib/kernel/person-identity", "@/lib/kernel/economic-graph"]
const GATE_PATH = /^lib\/(auth|security)\/|^lib\/kernel\/(portal-auth|tenant-guard|authority[^/]*)\.ts$|^lib\/auth\//
export function graphImportsInGates(code: Map<string, string>): string[] {
  const out: string[] = []
  for (const [f, s] of code) {
    if (!GATE_PATH.test(f)) continue
    for (const g of GRAPH_MODULES) if (new RegExp(`from\\s*["']${esc(g)}["']|import\\(\\s*["']${esc(g)}["']`).test(s)) out.push(`${f} imports ${g}`)
  }
  return out
}

// ── ORPHAN ACTION on a chain table ─────────────────────────────────────────────────────────────────
export function chainWritingActions(tables: Set<string>, code: Map<string, string>): { file: string; name: string; table: string }[] {
  const out: { file: string; name: string; table: string }[] = []
  for (const [f, s] of code) {
    if (!f.startsWith("app/actions/") || !/^\s*["']use server["']/.test(s)) continue
    const fns = [...s.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g)]
    for (let i = 0; i < fns.length; i++) {
      const start = fns[i].index ?? 0
      const end = i + 1 < fns.length ? (fns[i + 1].index ?? s.length) : s.length
      const body = s.slice(start, end)
      for (const h of body.matchAll(FROM_RE)) {
        if (!tables.has(h[1])) continue
        const at = h.index ?? 0
        const next = body.indexOf(".from(", at + 6)
        const stmt = body.slice(at, Math.min(next === -1 ? body.length : next, at + 600))
        if (WRITE_CALL.test(stmt)) { out.push({ file: f, name: fns[i][1], table: h[1] }); break }
      }
    }
  }
  return out
}
/** The name must appear as CODE (an import / call) in another runtime file — string bodies are blanked
 *  (blankStrings), so a narrative string or a log line naming the export is not a caller. */
let NOSTR: Map<string, string> | null = null
export function isReferencedElsewhere(name: string, file: string, code: Map<string, string>): boolean {
  if (!NOSTR || NOSTR.size !== code.size) NOSTR = new Map([...code].map(([f, s]) => [f, blankStrings(s)]))
  const re = new RegExp(`\\b${esc(name)}\\b`, "g")
  for (const [f, s] of NOSTR) {
    const n = (s.match(re) ?? []).length
    // another file naming it, or a SECOND occurrence in its own file (an in-file caller — the export is
    // still a public endpoint, but the action is not orphaned)
    if ((f !== file && n > 0) || (f === file && n > 1)) return true
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// POSITIVE CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log("══════════════════════════════════════════════════════════════════")
console.log(" PARENT / CHILD GRAPH — the five chains, both directions (wave 144, lane 144I)")
console.log("══════════════════════════════════════════════════════════════════")
console.log("\n[positive controls — every finder flags the defect it exists for, and not its look-alike]")
{
  const fx = new Map<string, string>([
    ["lib/x/writer.ts", blankComments(`export async function w(svc){ await svc.from("kid").insert({ parent_id: p, brokerage_id: b }) }`)],
    ["lib/x/tombstone.ts", blankComments(`// TOMBSTONE: svc.from("ghost").insert({ parent_id: p }) moved to lib/x/writer.ts:1\n/* svc.from("ghost").select("id").eq("parent_id", p) */ export const a = 1`)],
    ["lib/x/reader.ts", blankComments(`export async function r(svc){ return svc.from("kid").select("id").eq("parent_id", p) }`)],
    ["lib/x/embed.ts", blankComments(`export async function e(svc){ return svc.from("mom").select("id, kid(id)") }`)],
    ["lib/x/emit.ts", blankComments(`emitKernelEvent({ event: KernelEvent.KID_BORN, brokerageId })`)],
    ["lib/x/emit-comment.ts", blankComments(`// emitKernelEvent({ event: KernelEvent.GHOST_BORN })`)],
    ["lib/auth/bad-gate.ts", blankComments(`import { neighbours } from "@/lib/kernel/relationship-graph"`)],
    ["lib/auth/ok-gate.ts", blankComments(`// we never import "@/lib/kernel/relationship-graph" here`)],
    ["lib/x/const-read.ts", blankComments(`const KID_COLS = "id, lib_id, status"\nexport async function c(svc){ return svc.from("kidc").select(KID_COLS).eq("status", "a") }`)],
    ["app/actions/a.ts", blankComments(`"use server"\nexport async function lonely(){ await svc.from("kid").insert({ parent_id: 1 }) }\nexport async function used(){ await svc.from("kid").update({ parent_id: 2 }) }\nexport async function caller(){ return used() }`)],
  ])
  const idx = indexFromHits(fx)
  const noSql = new Map<string, string>()
  check("CONTROL writer: a real .from(kid).insert({ parent_id }) is a STATEMENT writer", findWriters("kid", "parent_id", idx, fx, noSql).tier === "statement")
  check("CONTROL writer: a TOMBSTONE naming .from(ghost).insert({ parent_id }) is NOT a writer (stripped first, §2)", findWriters("ghost", "parent_id", idx, fx, noSql).tier === "none")
  {
    const f2 = new Map([["lib/x/meta.ts", blankComments(`await svc.from("kid2").update({ status: "won" }).eq("id", i)\nawait transition({ metadata: { parent_id: t } })`)]])
    check("CONTROL writer: a LATER call's object key (an emit's metadata) is not this write's payload", findWriters("kid2", "parent_id", indexFromHits(f2), new Map(), noSql).tier === "none")
  }
  check("CONTROL writer: a trigger-shaped SQL writer is found (§3 — writerless is not writerless)",
    findWriters("ghost", "parent_id", idx, fx, new Map([["m1.sql", "INSERT INTO public.ghost (id, parent_id) SELECT …"]])).tier === "sql")
  check("CONTROL reader: .from(kid).select().eq(parent_id) is a reader", findReaders("kid", "parent_id", null, idx, fx).length === 1)
  check("CONTROL reader: an embed .from(mom).select('kid(id)') is a traversal", findReaders("kid", "zzz", "mom", idx, fx).length === 1)
  check("CONTROL reader: a comment-only read is NOT a reader", findReaders("ghost", "parent_id", null, idx, fx).length === 0)
  check("CONTROL reader: .select(CONST) resolves a same-file column-list constant", findReaders("kidc", "lib_id", null, idx, fx).length === 1 && findReaders("kidc", "nope_id", null, idx, fx).length === 0)
  {
    const acts = chainWritingActions(new Set(["kid"]), fx)
    check("CONTROL orphan action: a \"use server\" export writing a chain table with no caller is caught; one called in-file is not",
      acts.length === 2 && !isReferencedElsewhere("lonely", "app/actions/a.ts", fx) && isReferencedElsewhere("used", "app/actions/a.ts", fx))
    NOSTR = null
  }
  check("CONTROL emitter: KernelEvent.KID_BORN emitted is found", findEmitters("KID_BORN", "kid_born", fx).length === 1)
  check("CONTROL emitter: a commented-out emit is NOT an emitter", findEmitters("GHOST_BORN", "ghost_born", fx).length === 0)
  const fk: FkMap = { kid: { parent_id: "mom" }, mom: { kid_id: "kid" } }
  const snap = { kid: ["id", "parent_id", "tag"], mom: ["id", "kid_id"] }
  const base = { id: "x", parentNode: "M", childNode: "K", parent: "mom", child: "kid" } as const
  check("CONTROL link: a declared FK present in the cache verifies", verifyLink({ ...base, link: { kind: "fk", column: "parent_id" } }, fk, snap) === null)
  check("CONTROL link: a declared FK missing from the cache is caught", verifyLink({ ...base, link: { kind: "fk", column: "nope_id" } }, fk, snap) !== null)
  check("CONTROL link: a declared ABSENT link that exists is caught as a stale map", verifyLink({ ...base, link: { kind: "absent", why: "x" } }, fk, snap) !== null)
  check("CONTROL link: a declared SOFT link over a real FK is caught as a stale map", verifyLink({ ...base, link: { kind: "soft", holder: "child", columns: ["tag"], via: "x" } }, fk, snap) !== null)
  check("CONTROL bidirectional: both directions are derived from the cache", fkColumns(fk, "kid", "mom").length === 1 && fkColumns(fk, "mom", "kid").length === 1)
  check("CONTROL symbol: an exported function is found; an absent one is not",
    symbolExists({ file: "lib/x/writer.ts", symbol: "w" }, fx) && !symbolExists({ file: "lib/x/writer.ts", symbol: "nope" }, fx))
  check("CONTROL permission: an access gate importing the relationship graph is caught; a comment naming it is not",
    graphImportsInGates(fx).length === 1 && graphImportsInGates(fx)[0].startsWith("lib/auth/bad-gate.ts"))
  check("CONTROL owner: canRefer refuses an unlicensed / self pair (the hand-off finder can fail)", canRefer("data_steward", "data_steward") === false && canRefer("data_steward", "not_a_manager") === false)
  check("CONTROL live-tables: a retired table name (open_houses) is NOT live — a stale map would be caught", !LIVE_TABLES.includes("open_houses"))
  const evParse = parseKernelEvents("export enum KernelEvent {\n  A_B = 'a_b',\n  C = \"c\",\n}\n")
  check("CONTROL event parse: enum members and values are parsed", evParse.get("A_B") === "a_b" && evParse.get("C") === "c")
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// THE AUDIT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
interface Finding { key: string; arrow: string; detail: string }
const findings: Finding[] = []
const find = (key: string, arrow: string, detail: string) => findings.push({ key, arrow, detail })

const EVENTS = parseKernelEvents(readFileSync(join(ROOT, EVENTS_FILE), "utf8"))
const live = new Set(LIVE_TABLES)
const allArrows = CHAINS.flatMap((c) => c.arrows)
const chainTables = new Set(allArrows.flatMap((a) => [a.child, ...(a.parent ? [a.parent] : [])]))

console.log("\n[map integrity — the declared map agrees with the generated caches]")
check(`every table the map names is LIVE and in the snapshot (${chainTables.size} tables)`,
  [...chainTables].every((t) => live.has(t) && !!SCHEMA_SNAPSHOT[t]), [...chainTables].filter((t) => !live.has(t) || !SCHEMA_SNAPSHOT[t]).join(", "))
check("arrow ids are unique", new Set(allArrows.map((a) => a.id)).size === allArrows.length)
check(`KernelEvent enum parsed from ${EVENTS_FILE} (${EVENTS.size} members)`, EVENTS.size > 100)
const linkErrors = allArrows.map((a) => [a.id, verifyLink(a, SCHEMA_FK_MAP, SCHEMA_SNAPSHOT)] as const).filter(([, e]) => e !== null)
check(`every arrow's declared link kind is the kind the schema has (${allArrows.length} arrows)`, linkErrors.length === 0, linkErrors.map(([i, e]) => `${i}: ${e}`).join("; "))

let soft = 0, absent = 0, fkCount = 0, root = 0
for (const chain of CHAINS) {
  console.log(`\n[${chain.key}] ${chain.label}`)
  for (const a of chain.arrows) {
    const L = a.link
    const lines: string[] = []
    if (L.kind === "root") { root++; lines.push(`ROOT — ${L.why}`) }
    if (L.kind === "absent") { absent++; find(`absent:${a.id}`, a.id, L.why); lines.push(`ABSENT — ${L.why}`) }

    // ── link holder + column(s) for the writer / reader census
    let holder: string | null = null
    let cols: string[] = []
    let other: string | null = null
    if (L.kind === "fk") { fkCount++; holder = a.child; cols = [L.column]; other = a.parent }
    if (L.kind === "reverse_fk") { fkCount++; holder = a.parent; cols = [L.column]; other = a.child }
    if (L.kind === "soft") { soft++; holder = L.holder === "child" ? a.child : a.parent; cols = L.columns; other = L.holder === "child" ? a.parent : a.child }

    if (holder && a.parent) {
      // all FK columns between the pair, both directions (derived)
      const down = fkColumns(SCHEMA_FK_MAP, a.child, a.parent)
      const up = a.child === a.parent ? [] : fkColumns(SCHEMA_FK_MAP, a.parent, a.child)
      if (L.kind !== "soft") lines.push(`LINK ${L.kind} ${holder}.${cols[0]} · FKs ${a.child}→${a.parent}: [${down.join(", ")}] · ${a.parent}→${a.child}: [${up.join(", ")}]`)
      else lines.push(`SOFT via ${L.via} · columns ${holder}.{${cols.join(", ")}}`)
      if (down.length > 1) lines.push(`MULTI-FK pair (${down.length} roles: ${down.join(", ")}) — an unqualified embed is PGRST201; role columns, not a duplicate`)
      // a two-way pointer must be declared with its ONE writer
      if (L.kind === "fk" && up.length > 0) {
        if (!a.bidirectional) find(`bidirectional-undeclared:${a.id}`, a.id, `${a.parent}.${up.join(",")} also points at ${a.child} — two stores of one edge with no declared writer`)
        else if (!symbolExists(a.bidirectional.writer, CODE)) find(`bidirectional-writer-missing:${a.id}`, a.id, `${a.bidirectional.writer.file}:${a.bidirectional.writer.symbol} not exported`)
        else {
          // The ONE writer keeps both pointers; any OTHER file writing the back-pointer is a second store
          // that can disagree with transactions.offer_id (a two-way pointer with two writers).
          const w = findWriters(a.parent, a.bidirectional.column, FROM_INDEX, CODE, SQL)
          const others = [...new Set(w.where.map((x) => x.replace(/:\d+$/, "")))].filter((f) => f !== a.bidirectional!.writer.file)
          lines.push(`TWO-WAY POINTER ${a.parent}.${a.bidirectional.column} kept by ${a.bidirectional.writer.file}:${a.bidirectional.writer.symbol} · back-pointer writers (${w.tier}): ${w.where.join(", ") || "none"}`)
          if (others.length) find(`bidirectional-second-writer:${a.id}`, a.id, `${a.parent}.${a.bidirectional.column} is also written by ${others.join(", ")} — not the ONE writer that keeps both pointers`)
        }
      }

      // ── WRITER of the link column(s)
      const writeCols = L.kind === "soft" && L.polymorphic ? [] : cols
      for (const c of writeCols) {
        const w = findWriters(holder, c, FROM_INDEX, CODE, SQL)
        lines.push(`WRITER ${holder}.${c}: ${w.tier}${w.where.length ? ` (${w.where.length}: ${w.where.slice(0, 2).join(", ")}${w.where.length > 2 ? ", …" : ""})` : ""}`)
        if (w.tier === "none") find(`edge-never-written:${a.id}:${holder}.${c}`, a.id, `no code or migration writes ${holder}.${c}`)
      }
      if (L.kind === "soft" && L.polymorphic) {
        const p = L.polymorphic
        const valRe = new RegExp(`(?:${esc(p.typeColumn)}|externalTable)\\s*:\\s*["'\`]${esc(p.typeValue)}["'\`]`)
        const writers = [...CODE.entries()].filter(([, s]) => valRe.test(s)).map(([f]) => f)
        lines.push(`POLYMORPHIC ${holder}.${p.typeColumn}='${p.typeValue}' writers: ${writers.length}`)
        if (writers.length === 0) find(`edge-never-written:${a.id}`, a.id, `no writer records ${holder}.${p.typeColumn}='${p.typeValue}' — the edge is never formed`)
      }
      // ── READER (traversal) of the link
      const readers = new Set<string>()
      for (const c of cols) for (const r of findReaders(holder, c, other, FROM_INDEX)) readers.add(r)
      lines.push(`READERS ${readers.size}${readers.size ? ` (${[...readers].slice(0, 2).join(", ")}${readers.size > 2 ? ", …" : ""})` : ""}`)
      if (readers.size === 0) find(`edge-never-read:${a.id}`, a.id, `nothing filters on, selects or embeds ${holder}.{${cols.join(", ")}}`)

      // ── TENANCY
      const pT = (SCHEMA_SNAPSHOT[a.parent] ?? []).includes("brokerage_id")
      const cT = (SCHEMA_SNAPSHOT[a.child] ?? []).includes("brokerage_id")
      lines.push(`TENANCY ${pT && cT ? "REDUNDANT (both rows carry brokerage_id; a single-column FK does not make them agree — the writer must pin both from the SESSION tenant)" : !cT ? "INHERITED (child has no brokerage_id — RLS must join to the parent)" : "child-only"}`)
    }

    // ── EVENTS
    for (const ev of a.events ?? []) {
      const value = EVENTS.get(ev)
      if (!value) { find(`event-missing:${a.id}:${ev}`, a.id, `KernelEvent.${ev} is not in the enum`); lines.push(`EVENT ${ev}: NOT IN ENUM`); continue }
      const em = findEmitters(ev, value, CODE)
      lines.push(`EVENT ${ev}='${value}': ${em.length} emitter file(s)`)
      if (em.length === 0) find(`event-never-emitted:${a.id}:${ev}`, a.id, `KernelEvent.${ev} is never emitted`)
    }
    if (a.id === "deal.offer>counter") {
      // §6: one spelling per promotion — the counter/accept promotion has two event vocabularies.
      const twins = [["OFFER_COUNTER_SENT", "OFFER_OS_COUNTERED"], ["OFFER_ACCEPTED", "OFFER_OS_ACCEPTED"]]
        .filter(([x, y]) => EVENTS.has(x) && EVENTS.has(y) && findEmitters(x, EVENTS.get(x)!, CODE).length > 0 && findEmitters(y, EVENTS.get(y)!, CODE).length > 0)
      if (twins.length) find(`event-duplicate-vocabulary:${a.id}`, a.id, `both spellings emitted: ${twins.map((t) => t.join(" / ")).join("; ")}`)
      lines.push(`EVENT VOCABULARY twins emitted: ${twins.length}`)
    }

    // ── MIRRORS + RESOLVER
    if (a.mirrors?.length && a.parent) {
      const real = a.mirrors.filter((m) => (SCHEMA_FK_MAP[m.table] ?? {})[m.column] === a.parent)
      const fake = a.mirrors.filter((m) => !real.includes(m))
      if (fake.length) find(`mirror-not-in-cache:${a.id}`, a.id, fake.map((m) => `${m.table}.${m.column}`).join(", "))
      const ok = a.resolver ? symbolExists(a.resolver, CODE) : false
      lines.push(`MIRRORS ${real.length + 1} stores of one edge (${[`${a.child}.${(L as { column?: string }).column ?? "?"}`, ...real.map((m) => `${m.table}.${m.column}`)].join(", ")}) · resolver ${a.resolver ? `${a.resolver.file}:${a.resolver.symbol} ${ok ? "exported" : "MISSING"}` : "NONE"}`)
      if (!ok) find(`mirror-without-resolver:${a.id}`, a.id, `the edge is stored ${real.length + 1} times and no ONE resolver exports`)
    }
    // ── MATERIALIZED STATE
    for (const m of a.materialized ?? []) {
      const colOk = (SCHEMA_SNAPSHOT[m.table] ?? []).includes(m.column)
      if (!colOk) find(`materialized-column-missing:${a.id}:${m.table}.${m.column}`, a.id, "the declared materialized column is not in the snapshot")
      const rec = m.reconciler && symbolExists(m.reconciler, CODE)
      lines.push(`MATERIALIZED ${m.table}.${m.column} (truth: ${m.truth}) · reconciler ${m.reconciler ? `${m.reconciler.file}:${m.reconciler.symbol} ${rec ? "exported" : "MISSING"}` : "NONE"}`)
      if (!rec) find(`unreconciled:${a.id}:${m.table}.${m.column}`, a.id, `stale materialized state: ${m.table}.${m.column} has no reconciler re-deriving it from ${m.truth}`)
    }
    // ── OWNERSHIP + LICENSED HAND-OFF
    if (a.parent) {
      const po = TABLE_MANAGER[a.parent], co = TABLE_MANAGER[a.child]
      if (!po || !co) find(`owner-missing:${a.id}`, a.id, `${!po ? a.parent : a.child} has no TABLE_MANAGER owner`)
      else if (po !== co && !canRefer(po, co)) find(`handoff-unlicensed:${a.id}`, a.id, `${po} → ${co} share no MANAGER_COLLABORATIONS domain`)
      lines.push(`OWNERS ${po ?? "∅"} → ${co ?? "∅"}${po && co && po !== co ? ` (hand-off ${canRefer(po, co) ? "licensed" : "UNLICENSED"})` : ""}`)
    } else {
      const co = TABLE_MANAGER[a.child]
      if (!co) find(`owner-missing:${a.id}`, a.id, `${a.child} has no TABLE_MANAGER owner`)
      lines.push(`OWNER ${co ?? "∅"}`)
    }
    console.log(`  ${a.id}  ${a.parentNode} → ${a.childNode}`)
    for (const l of lines) console.log(`      · ${l}`)
  }
}

// ── PERSON graph scope, derived from the vocabulary itself ───────────────────────────────────────────
console.log("\n[person graph scope — derived from PERSON_ENTITY_TYPES]")
{
  const src = CODE.get("lib/kernel/person-identity.ts") ?? ""
  const list = src.match(/export\s+const\s+PERSON_ENTITY_TYPES\s*=\s*\[([^\]]*)\]/)?.[1] ?? ""
  const types = [...list.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1])
  check(`PERSON_ENTITY_TYPES parsed (${types.join(", ")})`, types.length > 0 && types.includes("contact"))
  const spansAgents = types.some((t) => /agent|user|vendor/.test(t))
  console.log(`    the person graph spans agents/users/vendors: ${spansAgents ? "YES" : "NO — person.person>agent stays ABSENT"}`)
  if (spansAgents && KNOWN_FINDINGS["absent:person.person>agent"]) console.log("    (the map's ABSENT person.person>agent is now stale — re-declare it)")
}

// ── EVERY WORKFLOW EXCEPTION HAS AN ACCOUNTABLE REGISTERED OWNER (ruling 18) ───────────────────────────
// The Exceptions-First categories (lib/kernel/exceptions-first.ts) are where a workflow exception surfaces to a
// human. Each must name a REAL manager, and that manager must be the TABLE_MANAGER steward of the table the
// category's reader stands on — the owner is derived from the registry, never picked per category.
const EXCEPTION_STEWARDED_TABLE: Record<string, string> = {
  transaction_at_risk: "deal_health_scores", human_intervention: "tasks", agent_capacity: "agents",
  campaign_overspend: "ad_campaigns", compliance_approval: "compliance_flags", billing_anomaly: "billing_invoices",
  mission_decision: "missions", os_health: "self_heal_events",
}
export function exceptionOwnerProblems(cats: Record<string, { owner?: string }>, stewarded: Record<string, string>): string[] {
  const out: string[] = []
  for (const [k, c] of Object.entries(cats)) {
    if (!c.owner || !(c.owner in MANAGERS)) { out.push(`${k}: no registered owner`); continue }
    const t = stewarded[k]
    if (!t) { out.push(`${k}: no stewarded table declared for the derivation`); continue }
    if (TABLE_MANAGER[t] !== c.owner) out.push(`${k}: owner ${c.owner} ≠ TABLE_MANAGER[${t}] ${TABLE_MANAGER[t] ?? "∅"}`)
  }
  return out
}
console.log("\n[every workflow exception has an accountable registered owner — Exceptions-First categories]")
check("CONTROL: a category with no owner, and one whose owner is not its table's steward, are both caught",
  exceptionOwnerProblems({ a: {}, b: { owner: "ads_manager" } }, { a: "tasks", b: "tasks" }).length === 2)
{
  const probs = exceptionOwnerProblems(EXCEPTION_CATEGORIES as unknown as Record<string, { owner?: string }>, EXCEPTION_STEWARDED_TABLE)
  check(`every Exceptions-First category (${Object.keys(EXCEPTION_CATEGORIES).length}) names a real manager that stewards its reader's table`, probs.length === 0, probs.join("; "))
  console.log(`    ${Object.entries(EXCEPTION_CATEGORIES).map(([k, c]) => `${k} → ${(c as { owner?: string }).owner ?? "∅"}`).join(" · ")}`)
}

// ── GRAPH ≠ PERMISSION ───────────────────────────────────────────────────────────────────────────
console.log("\n[graph ≠ permission inheritance — no access gate derives an allow from graph reachability]")
const gateImports = graphImportsInGates(CODE)
const gateFiles = [...CODE.keys()].filter((f) => GATE_PATH.test(f)).length
check(`no access gate (${gateFiles} files under lib/auth, lib/security, portal-auth / tenant-guard / authority*) imports a graph module (${GRAPH_MODULES.join(", ")})`, gateImports.length === 0, gateImports.join("; "))
console.log("    tenancy in this audit is brokerage_id equality only; reaching a row through the graph is never read as being allowed to see it.")

// ── ORPHAN ACTIONS writing a chain table ────────────────────────────────────────────────────────────
console.log("\n[orphan tool / action — a public server action that writes a chain table and that nothing calls]")
const actions = chainWritingActions(chainTables, CODE)
const orphanActions = actions.filter((x) => !isReferencedElsewhere(x.name, x.file, CODE))
for (const o of orphanActions) find(`orphan-action:${o.file}:${o.name}`, `table:${o.table}`, `"use server" export ${o.name} writes ${o.table} and no other runtime file names it — a public endpoint with no caller`)
console.log(`    ${actions.length} server-action exports write a chain table; ${orphanActions.length} are named by no other runtime file`)

// ── LIVE ARM ─────────────────────────────────────────────────────────────────────────────────────
console.log(`\n[live readings — measured ${LIVE_MEASURED_ON} through the Supabase MCP against hrvaqgvukzxfskkcrwbt]`)
for (const r of LIVE_READINGS) {
  console.log(`    ${String(r.n).padStart(3)}  ${r.arrow}  ${r.what}  (denominator: ${r.denominator})`)
  if (SQL_MODE) console.log(`          SQL: ${r.sql};`)
}
const zeroBroken = LIVE_READINGS.filter((r) => r.rule === "zero" && r.n !== 0)
check("every declared ZERO-rule reading (cross-tenant link / two-way pointer disagreement) read 0 when measured", zeroBroken.length === 0, zeroBroken.map((r) => r.what).join("; "))
for (const r of LIVE_READINGS.filter((x) => x.rule === "info" && x.n > 0 && /MIRROR DRIFT/.test(x.what))) find(`live:${r.arrow}:mirror-drift`, r.arrow, `${r.n} — ${r.what} (${r.denominator})`)
const creds = process.env.SUPABASE_SERVICE_ROLE_KEY && (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
console.log(creds
  ? "    live credentials present — this arm does not re-measure (supabase-js runs no raw SQL); run --sql in the SQL editor. Reported as UNRUN, not clean."
  : "    ⏭  no credentials — NOT re-measured this run. The readings above are the dated declaration; 0 over an empty operational table is NOT_APPLICABLE, never PASS.")

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// RATCHET
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n[findings — keyed wire list]")
const keys = [...new Set(findings.map((f) => f.key))].sort()
const fresh = keys.filter((k) => !(k in KNOWN_FINDINGS))
const burned = Object.keys(KNOWN_FINDINGS).filter((k) => !keys.includes(k))
for (const f of findings) {
  const known = KNOWN_FINDINGS[f.key]
  console.log(`    ${known ? "known" : "NEW  "} ${f.key}\n          ${f.detail}${known ? `\n          owner ${known.owner} · ${known.route}` : ""}`)
}
check("every known finding names a REAL manager as its owner", Object.values(KNOWN_FINDINGS).every((k) => k.owner in MANAGERS))
check(`no NEW parent/child finding (${keys.length} keyed findings, ${Object.keys(KNOWN_FINDINGS).length} known)`, fresh.length === 0, fresh.join(", "))
if (burned.length) console.log(`    ✓ BURNED (closed since the map was written — remove from KNOWN_FINDINGS): ${burned.join(", ")}`)

console.log(`\n[coverage] ${CHAINS.length} chains · ${allArrows.length} arrows (${fkCount} FK, ${soft} soft, ${absent} absent, ${root} root) · ${chainTables.size} tables · ${files.length} runtime files · ${SQL.size} migrations · ${EVENTS.size} kernel events`)
console.log(`
[BLIND SPOTS — published beside the numbers]
  · the MAP is declared: an arrow nobody put in CHAINS is not audited (the owner's five chains, as written in WAVE144 ruling 18 / lane 144I brief);
    likewise a materialized copy or a mirror nobody declared on an arrow is not checked (the derived checks verify what is declared exists);
  · writers: a payload assembled in another module and passed in, a dynamic table name, or an .rpc() is invisible; the
    "file" tier is co-occurrence (the file writes the table and names the column), weaker than "statement";
  · readers: a select('*') followed by in-memory filtering, or a column list built at runtime / imported from another module, is invisible (a same-file string constant IS resolved);
  · SQL writers: INSERT INTO / UPDATE … SET only — a trigger that assigns NEW.<col> or a function body built with EXECUTE is not parsed;
  · tenancy is STRUCTURAL here (which rows carry brokerage_id); the row half is the dated live declaration, and the
    live database has barely been operated (2 transactions, 0 offers, 0 distributions) — those zeros are weak evidence;
  · orphan actions: name-level reference (any other runtime file naming the export) — overcounts callers, so the failure mode is a MISS, never a false accusation;
  · graph ≠ permission scans import edges into lib/auth, lib/security and the named gate files only; a gate elsewhere that inlines a graph query is not seen;
  · events: emission is \`KernelEvent.X\` or \`event: "x"\` in runtime source; a reactor that never handles the event is not checked here (notification-engine's census owns that).`)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ❌ PARENT_CHILD_GRAPH_FAIL")
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(" ✅ PARENT_CHILD_GRAPH_PASS — every chain arrow verified against the caches; no NEW finding")
if (LIST) process.exit(0)
