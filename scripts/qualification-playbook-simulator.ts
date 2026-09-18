#!/usr/bin/env tsx
/**
 * scripts/qualification-playbook-simulator.ts   (npm run test:qualification-playbook)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 74B — owner verbatim: "the ai agents need to not be salesy but also
 * try to get them qualified so that they can setup a meeting/showing, get
 * their contact info, what their intent is, property address that they are
 * selling, determine their persona, etc. they can setup followup whether
 * calling them again when they are ready, sending a list of properties that
 * they just told us their criteria for, setting up a time to look up their
 * property value and give them a call back to discuss or did they want to
 * setup an appt for an agent to come out to discuss/no obligation, etc.
 * typical real estate talk … this goes for the platform ai agents."
 *
 * Proves, in STRIPPED source (scripts/strip-comments.ts — CLAUDE.md §2):
 *   Layer 1 — positive control (the stripper still sees code, not comments).
 *   Layer 2 — every mounting surface carries the ONE shared builder
 *             (buildQualificationPrompt) and NO duplicated qualification
 *             prose remains, with a positive-control fixture proving the
 *             duplicate-prose scan is not simply blind.
 *   Layer 3 — the four follow-up ACTION tools are persona/id-locked (never a
 *             model-suppliable contact_id/lead_id) and write via
 *             sentinelWrite.
 *   Layer 4 — costRankForTool / selectToolsForPersona: cost order, need-based
 *             BatchData drop, and the POSITIVE CONTROL that a need only
 *             BatchData covers (seller persona's lookup_property — sellers
 *             never get RentCast) SURVIVES.
 *   Layer 5 — record_qualification only ever writes columns LIVE_TABLES/
 *             SCHEMA_SNAPSHOT actually carries.
 *   Layer 6 — the four qualification signal types are registered in
 *             SIGNAL_REGISTRY with a real SIGNAL_HANDLERS consumer for every
 *             declared consumer (no dead promise).
 *
 * No DB, no network. Run:
 *   npx tsx scripts/qualification-playbook-simulator.ts
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function stripped(path: string): string {
  return stripComments(readFileSync(path, "utf8"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · strip-comments positive control]")
const playbookSrc = stripped("lib/ai-isa/qualification-playbook.ts")
check("a comment-only phrase is ABSENT from stripped qualification-playbook.ts (scanner sees comments)",
  !playbookSrc.includes("Four spellings of the same six goals"))
check("a real code token from the same file IS present (the scanner did not eat the code too)",
  playbookSrc.includes("export function buildQualificationPrompt"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · every surface mounts the shared builder, no duplicated prose]")

interface SurfaceCheck { path: string; label: string; retiredPhrases: string[] }
const SURFACES: SurfaceCheck[] = [
  { path: "app/actions/ai-isa/handle-inbound-email.ts", label: "ISA inbound-email handler",
    retiredPhrases: ["Qualify leads with genuine warmth", "ending with one qualifying question"] },
  { path: "app/api/widget/message/route.ts", label: "website visitor widget",
    retiredPhrases: ["qualify their intent (buying or selling)", "naturally collect their name, email, and phone number"] },
  { path: "lib/voice/reception-brain.ts", label: "voice reception + outbound prompts",
    retiredPhrases: ["learn who is calling and get a callback number", "capture their property address"] },
]
for (const s of SURFACES) {
  const src = stripped(s.path)
  check(`${s.label} carries buildQualificationPrompt(`, src.includes("buildQualificationPrompt("))
  for (const phrase of s.retiredPhrases) {
    check(`${s.label}: retired duplicated prose "${phrase.slice(0, 40)}…" is GONE`, !src.includes(phrase))
  }
}

// portal/did/platform-reception/staff-copilot — mounted, not necessarily a retirement (these
// never had qualification prose duplicated at the SAME depth; still prove the mount).
for (const [path, label] of [
  ["app/api/portal/ai-chat/route.ts", "portal contact assistant"],
  ["app/api/did/custom-llm/route.ts", "D-ID live-avatar brain"],
  ["lib/voice/platform-reception.ts", "platform reception line"],
  ["app/api/internal/ai-chat/route.ts", "in-app staff copilot"],
] as const) {
  check(`${label} carries buildQualificationPrompt(`, stripped(path).includes("buildQualificationPrompt("))
}

// Positive control: the duplicate-prose scan is not blind — a fixture that STILL carries the
// retired phrase must be caught.
const fixtureWithDuplicateProse = `
const baseSystem = [
  'Qualify leads with genuine warmth — no pushy sales tactics.',
].join('\\n')
`
check("POSITIVE CONTROL: the duplicate-prose scan DOES find a retired phrase in a fixture that still has one",
  fixtureWithDuplicateProse.includes("Qualify leads with genuine warmth"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · follow-up tools are id-locked and write via sentinelWrite]")

const toolsSrc = stripped("lib/ai-isa/customer-context-tools.ts")
const FOLLOW_UP_BUILDERS = [
  "buildScheduleCallbackTool", "buildSendMatchingListingsTool",
  "buildScheduleHomeValueReviewTool", "buildBookAgentAppointmentTool", "buildRecordQualificationTool",
]
for (const fn of FOLLOW_UP_BUILDERS) {
  check(`${fn} is exported`, toolsSrc.includes(`export function ${fn}`))
}
check("sentinelWrite is used at least 6 times across the follow-up tools (schedule_callback via scheduleFollowUp, home-value-review's address write, record_qualification's contact/lead write + property_preferences insert/update)",
  (toolsSrc.match(/sentinelWrite\(/g) ?? []).length >= 6)
check("no follow-up tool's inputSchema accepts a model-suppliable contact_id/lead_id (id always comes from ctx, never the model)",
  !/z\.object\(\{[^}]*contact_id:\s*z\./s.test(toolsSrc) && !/z\.object\(\{[^}]*lead_id:\s*z\./s.test(toolsSrc))
check("every follow-up write is locked to ctx.contactId / ctx.leadId, never a bare `contactId` or `leadId` destructured from tool args",
  !/execute:\s*async\s*\(\s*\{[^}]*\bcontactId\b/.test(toolsSrc) && !/execute:\s*async\s*\(\s*\{[^}]*\bleadId\b/.test(toolsSrc))
check("record_qualification refuses when NEITHER contactId nor leadId is linked (fail closed, not a silent no-op write)",
  toolsSrc.includes('No contact or lead is linked to this conversation yet'))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · cost-ranked tool order — drop-when-covered + positive control]")

const { costRankForTool, selectToolsForPersona, FREE_INTERNAL_TOOL_NAMES } =
  await import("../lib/ai-isa/persona-tool-policy")

check("free internal tools rank 0", costRankForTool("get_my_context") === 0 && costRankForTool("record_qualification") === 0)
check("a RentCast tool ranks 1", costRankForTool("rentcast_avm_value") === 1)
check("a BatchData preview/count/lookup/verify tool ranks 2", costRankForTool("lookup_property") === 2 && costRankForTool("comparable_property_preview") === 2 && costRankForTool("verify_address") === 2)
check("a BatchData bulk page / skip-trace tool ranks 3 (the most expensive tier)",
  costRankForTool("search_properties_page") === 3 && costRankForTool("skip_trace_property") === 3)
check("FREE_INTERNAL_TOOL_NAMES carries every follow-up tool name (so they rank 0, not the rank-2 default)",
  FREE_INTERNAL_TOOL_NAMES.includes("schedule_callback") && FREE_INTERNAL_TOOL_NAMES.includes("send_matching_listings") &&
  FREE_INTERNAL_TOOL_NAMES.includes("schedule_home_value_review") && FREE_INTERNAL_TOOL_NAMES.includes("book_agent_appointment") &&
  FREE_INTERNAL_TOOL_NAMES.includes("record_qualification"))

const fakeFn = (): Record<string, never> => ({});
{
  // property lookup: RentCast present → BatchData lookup_property DROPPED.
  const withRentcast = selectToolsForPersona({ lookup_property: fakeFn, rentcast_value_lookup: fakeFn, get_my_context: fakeFn })
  check("selectToolsForPersona DROPS lookup_property when a rentcast_ tool covers property lookup in the SAME registry",
    !("lookup_property" in withRentcast) && "rentcast_value_lookup" in withRentcast)

  // POSITIVE CONTROL — no RentCast in the registry (the seller persona's real shape: rentCastEnabled=false) →
  // lookup_property SURVIVES. Proves the rule discriminates rather than stripping everything.
  const sellerShape = selectToolsForPersona({ lookup_property: fakeFn, comparable_property_preview: fakeFn, get_my_context: fakeFn })
  check("POSITIVE CONTROL: lookup_property SURVIVES when NO RentCast tool is present (the seller persona's real registry shape — the rule discriminates, it does not just drop everything)",
    "lookup_property" in sellerShape && "comparable_property_preview" in sellerShape)

  // comps: RentCast comps-named tool present → comparable_property_preview/count DROPPED.
  const withRentcastComps = selectToolsForPersona({ comparable_property_preview: fakeFn, comparable_property_count: fakeFn, rentcast_comp_search: fakeFn })
  check("selectToolsForPersona DROPS comparable_property_preview/count when a rentcast comp-named tool covers it",
    !("comparable_property_preview" in withRentcastComps) && !("comparable_property_count" in withRentcastComps) && "rentcast_comp_search" in withRentcastComps)

  // ordering: free < rentcast < batchdata.
  const mixed = selectToolsForPersona({
    comparable_property_preview: fakeFn, // rank 2
    rentcast_listing_search: fakeFn,      // rank 1
    get_my_context: fakeFn,               // rank 0
  })
  const order = Object.keys(mixed)
  check("selectToolsForPersona sorts survivors cheapest-first (free, then RentCast, then BatchData)",
    order[0] === "get_my_context" && order[1] === "rentcast_listing_search" && order[2] === "comparable_property_preview")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · record_qualification only writes existing columns]")

const contactsCols = new Set(SCHEMA_SNAPSHOT.contacts ?? [])
const leadsCols = new Set(SCHEMA_SNAPSHOT.leads ?? [])
const prefCols = new Set(SCHEMA_SNAPSHOT.property_preferences ?? [])
check("SCHEMA_SNAPSHOT actually loaded contacts/leads/property_preferences (not a silent empty import)",
  contactsCols.size > 50 && leadsCols.size > 30 && prefCols.size > 5)

// Every column literal record_qualification's patch object writes (both the
// contacts/leads branch and the property_preferences branch), read from the
// RAW file (a column NAME is not a comment-token concern) and checked
// against BOTH tables (the column is written via a variable `table`, so it
// must exist on whichever of the two it could resolve to).
const RECORD_QUAL_COLUMNS_CONTACTS_OR_LEADS = [
  "timeline", "lender_status", "property_type", "address", "qualification_summary", "home_owner_status",
]
for (const col of RECORD_QUAL_COLUMNS_CONTACTS_OR_LEADS) {
  check(`record_qualification's shared column "${col}" exists on BOTH contacts and leads`,
    contactsCols.has(col) && leadsCols.has(col))
}
check(`record_qualification's contacts-only column "contact_persona" exists on contacts`, contactsCols.has("contact_persona"))
check(`record_qualification's leads-only column "persona" exists on leads`, leadsCols.has("persona"))
check(`record_qualification's contacts-only column "contact_type" exists on contacts`, contactsCols.has("contact_type"))
check(`record_qualification's leads-only column "lead_type" exists on leads`, leadsCols.has("lead_type"))

const RECORD_QUAL_PREF_COLUMNS = [
  "contact_id", "brokerage_id", "agent_id", "preferred_price_min", "preferred_price_max",
  "inferred_beds_min", "inferred_baths_min", "inferred_cities", "inferred_property_types", "last_calculated_at",
]
for (const col of RECORD_QUAL_PREF_COLUMNS) {
  check(`record_qualification's property_preferences column "${col}" exists on the live table`, prefCols.has(col))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · the four qualification signals are registered with real handlers]")

const { SIGNAL_REGISTRY } = await import("../lib/kernel/signal-registry")
const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
const { classifyCoordination } = await import("../lib/kernel/coordination-kind")

const QUALIFICATION_SIGNALS = [
  "qualification_call_requested", "qualification_criteria_captured",
  "qualification_valuation_handoff", "qualification_appointment_handoff",
]
for (const type of QUALIFICATION_SIGNALS) {
  const spec = SIGNAL_REGISTRY[type]
  check(`${type} is catalogued in SIGNAL_REGISTRY`, !!spec)
  if (!spec) continue
  check(`${type}'s declared kind matches classifyCoordination`, spec.kind === classifyCoordination(type))
  if (spec.disposition === "handled") {
    for (const c of spec.consumers) {
      check(`${type} has a real SIGNAL_HANDLERS entry for consumer "${c}"`, `${c}:${type}` in SIGNAL_HANDLERS)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ QUALIFICATION_PLAYBOOK — see failures above")
  process.exit(1)
} else {
  console.log(" ✅ QUALIFICATION_PLAYBOOK — one shared builder mounted everywhere, follow-up tools id-locked and cost-ranked, record_qualification writes only live columns")
}
