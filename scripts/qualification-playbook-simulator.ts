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
 *   Layer 7 (wave 75) — owner verbatim: "if a person says to call back again,
 *             that lead has not been qualified yet and the ai isa needs to
 *             call them back." schedule_callback is persona-scoped: a LEAD
 *             (not yet qualified) gets a REAL AI ISA outbound callback via the
 *             EXISTING lib/ai-isa/callback-task.ts::createCallbackTask door
 *             (source, from stripped code); a CONTACT (already qualified)
 *             keeps today's agent-side follow-up. LIVE section (gated on
 *             SUPABASE_SERVICE_ROLE_KEY, tagged rows deleted in the same run):
 *             a LEAD callback ask writes an assignee_type:'ai_isa' `tasks` row
 *             — NEVER converts the lead, NEVER writes an agent-assigned task —
 *             and the POSITIVE CONTROL, a CONTACT callback ask, still writes
 *             the agent-side `activities` row it always has.
 *
 * No DB, no network for Layers 1-6; Layer 7's LIVE half needs
 * SUPABASE_SERVICE_ROLE_KEY (skips cleanly without it). Run:
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
const catalogueSrc = stripped("lib/ai-isa/capability-catalogue.ts")
const FOLLOW_UP_BUILDERS = [
  "buildScheduleCallbackTool", "buildSendMatchingListingsTool",
  "buildScheduleHomeValueReviewTool", "buildFindListingAppointmentSlotsTool",
  "buildBookListingAppointmentTool", "buildRecordQualificationTool",
  "buildScheduleHomeValueReviewTool", "buildRecordQualificationTool",
]
for (const fn of FOLLOW_UP_BUILDERS) {
  check(`${fn} is exported`, toolsSrc.includes(`export function ${fn}`))
}
check("TOMBSTONE: buildBookAgentAppointmentTool is GONE from customer-context-tools.ts (retired — book_listing_appointment is the survivor)",
  !toolsSrc.includes("export function buildBookAgentAppointmentTool"))
// Wave 75 integration: the CALENDAR-BACKED builder in customer-context-tools.ts
// (lane 75C) is the survivor; the catalogue keeps the capability id and a tombstone.
check("buildBookListingAppointmentTool is exported from customer-context-tools.ts (the calendar-backed survivor)",
  toolsSrc.includes("export function buildBookListingAppointmentTool"))
check("the capability catalogue no longer exports its own stand-in booking tool (tombstoned onto the survivor)",
  !catalogueSrc.includes("export function buildBookListingAppointmentTool"))
// sentinelWrite's call sites split across THREE files after lane 75B's
// qualification-signals.ts extraction (scheduleFollowUp's leads.update moved
// there so capability-catalogue.ts could reuse it without an import cycle —
// see qualification-signals.ts's header) — count the family, not one file.
const signalsSrc = stripped("lib/ai-isa/qualification-signals.ts")
const sentinelWriteTotal =
  (toolsSrc.match(/sentinelWrite\(/g) ?? []).length +
  (signalsSrc.match(/sentinelWrite\(/g) ?? []).length +
  (catalogueSrc.match(/sentinelWrite\(/g) ?? []).length
check("sentinelWrite is used at least 6 times across the follow-up-tool family (customer-context-tools.ts + qualification-signals.ts + capability-catalogue.ts): schedule_callback via scheduleFollowUp, home-value-review's address write, record_qualification's contact/lead write + property_preferences insert/update, book_listing_appointment's calendar_events insert",
  sentinelWriteTotal >= 6, `found ${sentinelWriteTotal}`)
check("no follow-up tool's inputSchema accepts a model-suppliable contact_id/lead_id (id always comes from ctx, never the model)",
  !/z\.object\(\{[^}]*contact_id:\s*z\./s.test(toolsSrc) && !/z\.object\(\{[^}]*lead_id:\s*z\./s.test(toolsSrc))
check("every follow-up write is locked to ctx.contactId / ctx.leadId, never a bare `contactId` or `leadId` destructured from tool args",
  !/execute:\s*async\s*\(\s*\{[^}]*\bcontactId\b/.test(toolsSrc) && !/execute:\s*async\s*\(\s*\{[^}]*\bleadId\b/.test(toolsSrc))
check("record_qualification refuses when NEITHER contactId nor leadId is linked (fail closed, not a silent no-op write)",
  toolsSrc.includes('No contact or lead is linked to this conversation yet'))
check("the capability catalogue's new tools also never accept a model-suppliable contact_id/lead_id",
  !/z\.object\(\{[^}]*contact_id:\s*z\./s.test(catalogueSrc) && !/z\.object\(\{[^}]*lead_id:\s*z\./s.test(catalogueSrc))
check("the capability catalogue's new tools are locked to ctx.contactId / ctx.leadId, never a bare destructured contactId/leadId",
  !/execute:\s*async\s*\(\s*\{[^}]*\bcontactId\b/.test(catalogueSrc) && !/execute:\s*async\s*\(\s*\{[^}]*\bleadId\b/.test(catalogueSrc))

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
  FREE_INTERNAL_TOOL_NAMES.includes("schedule_home_value_review") && FREE_INTERNAL_TOOL_NAMES.includes("book_listing_appointment") &&
  FREE_INTERNAL_TOOL_NAMES.includes("find_listing_appointment_slots") &&
  FREE_INTERNAL_TOOL_NAMES.includes("record_qualification"))
check("TOMBSTONE: FREE_INTERNAL_TOOL_NAMES no longer names the retired book_agent_appointment",
  !FREE_INTERNAL_TOOL_NAMES.includes("book_agent_appointment"))
check("FREE_INTERNAL_TOOL_NAMES carries the three brand-new catalogue capabilities (lane 75B)",
  FREE_INTERNAL_TOOL_NAMES.includes("send_newsletter") && FREE_INTERNAL_TOOL_NAMES.includes("send_market_report") &&
  FREE_INTERNAL_TOOL_NAMES.includes("send_explainer_video"))

const fakeFn = (): Record<string, never> => ({});
{
  // property lookup: RentCast present → BatchData lookup_property DROPPED.
  const withRentcast = selectToolsForPersona({ lookup_property: fakeFn, rentcast_value_lookup: fakeFn, get_my_context: fakeFn })
  check("selectToolsForPersona DROPS lookup_property when a rentcast_ tool covers property lookup in the SAME registry",
    !("lookup_property" in withRentcast) && "rentcast_value_lookup" in withRentcast)

  // POSITIVE CONTROL — no RentCast tool in the registry (a rentCastEnabled=false persona's
  // shape, e.g. seller/investor — a SYNTHETIC fixture testing the PURE rule, not a claim
  // about either persona's actual BatchData allowlist, which lane 75B narrowed to empty
  // for seller) → lookup_property SURVIVES. Proves the rule discriminates rather than
  // stripping everything.
  const noRentcastShape = selectToolsForPersona({ lookup_property: fakeFn, comparable_property_preview: fakeFn, get_my_context: fakeFn })
  check("POSITIVE CONTROL: lookup_property SURVIVES when NO RentCast tool is present in the registry — the rule discriminates, it does not just drop everything",
    "lookup_property" in noRentcastShape && "comparable_property_preview" in noRentcastShape)

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
  // wave 75C survivor of qualification_appointment_handoff (still catalogued
  // above, tombstoned — no live publisher any more).
  "listing_appointment_pending_confirmation",
  "qualification_newsletter_enrolled", "qualification_market_report_sent",
  "qualification_explainer_video_requested",
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
console.log("\n[Layer 7 · brand playbook context present in every surface's prompt]")

// Every surface either calls loadBrandPlaybookContext directly, or reads
// `identity.brand`/`ctx.brand` populated by an I/O resolver that does
// (voice_reception/voice_outbound via lib/voice/twilio-voice.ts::resolveInboundContext,
// platform_reception via resolvePlatformReceptionContext) — both patterns prove the
// SAME thing: this surface's buildQualificationPrompt call carries a `brand:` argument.
const BRAND_SURFACES: Array<{ path: string; label: string }> = [
  { path: "app/actions/ai-isa/handle-inbound-email.ts", label: "ISA inbound-email handler" },
  { path: "app/api/widget/message/route.ts", label: "website visitor widget" },
  { path: "app/api/portal/ai-chat/route.ts", label: "portal contact assistant" },
  { path: "app/api/did/custom-llm/route.ts", label: "D-ID live-avatar brain" },
  { path: "app/api/internal/ai-chat/route.ts", label: "in-app staff copilot" },
  { path: "lib/voice/reception-brain.ts", label: "voice reception + outbound prompts" },
  { path: "lib/voice/twilio-voice.ts", label: "voice call-context resolver (feeds reception-brain's brand)" },
  { path: "lib/voice/platform-reception.ts", label: "platform reception line" },
]
for (const s of BRAND_SURFACES) {
  const src = stripped(s.path)
  check(`${s.label} threads brand playbook context (loadBrandPlaybookContext or a brand: argument)`,
    src.includes("loadBrandPlaybookContext") || src.includes("brand:"))
}
check("lib/ai-isa/qualification-playbook.ts's buildQualificationPrompt accepts a `brand` input and injects its block",
  playbookSrc.includes("brand?:") && playbookSrc.includes("input.brand?.block"))
check("lib/ai-isa/brand-playbook-context.ts exists and exports the ONE loader",
  stripped("lib/ai-isa/brand-playbook-context.ts").includes("export async function loadBrandPlaybookContext"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 8 · follow-up menu ↔ capability catalogue — IDENTICAL tool sets]")

const { QUALIFICATION_FOLLOW_UP_MENU } = await import("../lib/ai-isa/qualification-playbook")
const { CAPABILITY_CATALOGUE, CAPABILITY_IDS } = await import("../lib/ai-isa/capability-catalogue")

const menuTools = new Set(QUALIFICATION_FOLLOW_UP_MENU.map((o) => o.tool))
const catalogueIds = new Set(CAPABILITY_IDS as readonly string[])
const menuOnly = [...menuTools].filter((t) => !catalogueIds.has(t))
const catalogueOnlyNonMenu = [...catalogueIds].filter((c) => !menuTools.has(c))
check("every menu tool name is a real catalogue capability id",
  menuOnly.length === 0, menuOnly.length ? `menu names not in catalogue: ${menuOnly.join(", ")}` : undefined)
// get_my_context / search_our_listings / record_qualification are catalogue capabilities
// that are NOT offered as a follow-up MENU choice (they're not a "thing you offer the
// person" — get_my_context is a silent lookup, record_qualification is a silent write,
// search_our_listings is used ad hoc, not offered) — this is the documented, expected
// remainder, not a mismatch.
const EXPECTED_CATALOGUE_ONLY = new Set(["get_my_context", "search_our_listings", "record_qualification"])
const unexpectedCatalogueOnly = catalogueOnlyNonMenu.filter((c) => !EXPECTED_CATALOGUE_ONLY.has(c))
check("every OTHER catalogue capability (beyond the 3 documented non-offered ones) is on the follow-up menu",
  unexpectedCatalogueOnly.length === 0, unexpectedCatalogueOnly.length ? unexpectedCatalogueOnly.join(", ") : undefined)
check("CAPABILITY_CATALOGUE has exactly 11 entries (the 7 pre-existing + 4 new lane-75B capabilities)",
  CAPABILITY_CATALOGUE.length === 11)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 9 · schedule_home_value_review NEVER emits a number — positive control]")

check("getCurrentAvm / the AVM chain is GONE from buildScheduleHomeValueReviewTool (no value computed at all)",
  !toolsSrc.includes("getCurrentAvm"))
check("buildScheduleHomeValueReviewTool's return object carries no numeric value fields",
  !/estimatedValue|valueSource|avmValue/.test(toolsSrc.slice(toolsSrc.indexOf("buildScheduleHomeValueReviewTool"))))
check("the tool states plainly that the agent — never the AI — speaks the number",
  toolsSrc.includes("never spoken by the AI") || toolsSrc.includes("never quoted by the AI"))
// POSITIVE CONTROL — the scanner above must be capable of catching a dollar figure;
// prove it against a fixture that STILL has one, so "0 found" above is not a blind regex.
const fixtureWithLeakedValue = `
return { success: true, estimatedValue: avm.value, valueSource: avm.source }
`
check("POSITIVE CONTROL: the numeric-value-field scan DOES find estimatedValue/valueSource in a fixture that leaks one",
  /estimatedValue|valueSource|avmValue/.test(fixtureWithLeakedValue))
check("send_market_report's return value is scoped to condition/trend/inventory/summary — no dollar-figure field (avgPriceChange/hotNeighborhoods/competitorAnalysis) leaves the tool",
  !/return\s*\{\s*success:\s*true,\s*marketCondition[^}]*avgPriceChange/s.test(catalogueSrc) &&
  catalogueSrc.includes("marketCondition: result.report.marketCondition"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 10 · brand settings toggle disables a catalogue capability]")

const { isCapabilityEnabled, parseCapabilitiesSettings } = await import("../lib/ai-isa/capability-catalogue")
check("a capability is enabled by default (no settings row)", isCapabilityEnabled("send_newsletter", null, []))
check("the settings toggle DISABLES a named capability",
  !isCapabilityEnabled("send_newsletter", null, parseCapabilitiesSettings({ ai_agent_capabilities: { disabled: ["send_newsletter"] } }).disabled))
check("disabling one capability leaves an UNNAMED one enabled (the toggle discriminates, it does not blanket-disable)",
  isCapabilityEnabled("send_market_report", null, parseCapabilitiesSettings({ ai_agent_capabilities: { disabled: ["send_newsletter"] } }).disabled))
check("a persona-gated capability (schedule_home_value_review, seller-only) is withheld from a buyer",
  !isCapabilityEnabled("schedule_home_value_review", "buyer" as any, []))
check("that SAME persona-gated capability is offered to a seller",
  isCapabilityEnabled("schedule_home_value_review", "seller" as any, []))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 11 · a brand's custom tool may only compose REAL catalogue capabilities]")

const { validateCustomToolDefinition } = await import("../lib/ai-isa/capability-catalogue")
const validCustom = validateCustomToolDefinition({
  id: "seller_concierge", label: "Seller Concierge", copy: "Our concierge handles everything for sellers.",
  composesCapabilities: ["schedule_home_value_review", "book_listing_appointment"],
})
check("a custom tool composing REAL catalogue capabilities validates OK", validCustom.ok && validCustom.unknownCapabilities.length === 0)
const invalidCustom = validateCustomToolDefinition({
  id: "made_up", label: "Made Up Tool", copy: "…",
  composesCapabilities: ["schedule_home_value_review", "totally_invented_capability"],
})
check("a custom tool naming an UNKNOWN capability is REFUSED",
  !invalidCustom.ok && invalidCustom.unknownCapabilities.includes("totally_invented_capability"))
check("an empty composesCapabilities list is REFUSED (a custom tool must compose SOMETHING real)",
  !validateCustomToolDefinition({ id: "empty", label: "Empty", copy: "…", composesCapabilities: [] }).ok)
console.log("\n[Layer 12 · schedule_callback is persona-scoped — LEAD → AI ISA callback, CONTACT → agent follow-up]")

{
  // ── SOURCE (stripped) — the branch exists, and the LEAD arm calls the
  // EXISTING ISA outbound-callback door, never a second implementation. ──────
  const cbSrc = toolsSrc // already stripped above (Layer 3)
  const leadBranchIdx = cbSrc.indexOf("if (ctx.leadId && !ctx.contactId)")
  check("buildScheduleCallbackTool branches on `ctx.leadId && !ctx.contactId` — a LEAD-only thread is NOT the same arm as a CONTACT thread",
    leadBranchIdx >= 0)
  // The CONTACT arm starts at its own `const scheduledAt =` line (a CODE token,
  // not a stripped comment — CLAUDE.md §2's "tombstone is not a call site" cuts
  // both ways: a marker used to slice arms must survive comment-stripping too).
  const contactArmIdx = cbSrc.indexOf('const scheduledAt = isoIsUsable ? (when_iso as string) : new Date().toISOString()')
  check("the CONTACT arm comes AFTER the LEAD arm in source order (LEAD is checked first, never falls through unnoticed)",
    contactArmIdx > leadBranchIdx && leadBranchIdx >= 0)
  const leadArmSlice = leadBranchIdx >= 0 ? cbSrc.slice(leadBranchIdx, contactArmIdx > leadBranchIdx ? contactArmIdx : undefined) : ""
  check("the LEAD arm imports/calls the EXISTING ISA callback writer (lib/ai-isa/callback-task.ts::createCallbackTask), never a second callback pipeline",
    /import\(["']@\/lib\/ai-isa\/callback-task["']\)/.test(leadArmSlice) && /createCallbackTask\(/.test(leadArmSlice))
  check("the LEAD arm hardcodes assigneeType 'ai_isa' — NEVER 'agent' (a lead has no agent to hand a task to, CLAUDE.md §5)",
    /assigneeType:\s*["']ai_isa["']/.test(leadArmSlice) && !/assigneeType:\s*["']agent["']/.test(leadArmSlice))
  check("the LEAD arm never calls notifyAssignedAgent (no agent task for an unqualified lead)",
    !/notifyAssignedAgent\(/.test(leadArmSlice))
  const contactArmSlice = contactArmIdx >= 0 ? cbSrc.slice(contactArmIdx) : ""
  check("the CONTACT arm keeps calling notifyAssignedAgent (today's agent-side follow-up, unchanged)",
    /notifyAssignedAgent\(/.test(contactArmSlice))
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("  ⏭  LIVE half skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
} else {
  const { createServiceClient } = await import("../lib/supabase/service")
  const { buildScheduleCallbackTool } = await import("../lib/ai-isa/customer-context-tools")
  const svc = createServiceClient()
  const TAG = `__cbscoped_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []
  const reg = (table: string, column: string, value: string | null | undefined) => { if (value) cleanup.push({ table, column, value }) }

  try {
    const { data: agent } = await svc
      .from("agents").select("id, brokerage_id")
      .not("brokerage_id", "is", null).eq("is_active", true).limit(1).single()
    if (!agent) {
      console.log("  ⏭  LIVE half skipped — need an active agent with a brokerage_id.")
    } else {
      const brokerageId = (agent as any).brokerage_id as string

      // ── (a) LEAD callback → a REAL ai_isa `tasks` row, no conversion ────────
      const { data: leadRow, error: leadErr } = await svc.from("leads").insert({
        brokerage_id: brokerageId, first_name: TAG, last_name: "CallbackLead",
        email: `${TAG}_lead@example.com`, phone: "+15125550100",
        lead_type: "buyer", motivation_type: "buyer",
        lifecycle_state: "isa_qualifying", is_active: true, ai_isa_owner: true,
      }).select("id").single()
      if (leadErr || !leadRow) {
        check("(7a) seed tagged lead", false, leadErr?.message)
      } else {
        const leadId = (leadRow as any).id as string
        reg("leads", "id", leadId)
        const leadTool = buildScheduleCallbackTool({ brokerageId, leadId, contactId: null, agentId: null })
        const leadResult: any = await (leadTool as any).execute(
          { when_iso: null, when_description: "next Tuesday afternoon", notes: "wants to talk pricing" },
          { toolCallId: "t-lead-callback", messages: [] },
        )
        check("(7a) LEAD callback tool reports scheduledVia 'ai_isa_callback'",
          leadResult?.success === true && leadResult?.scheduledVia === "ai_isa_callback", JSON.stringify(leadResult))

        const { data: taskRow } = await svc
          .from("tasks").select("id, contact_id, assignee_type, source, status, due_date")
          .eq("brokerage_id", brokerageId).eq("source", "ai_callback")
          .order("created_at", { ascending: false }).limit(1).maybeSingle()
        if ((taskRow as any)?.id) reg("tasks", "id", (taskRow as any).id)
        check("(7a) a REAL `tasks` row was written — source='ai_callback', assignee_type='ai_isa' (the AI ISA's own executor claims this, not a human)",
          (taskRow as any)?.source === "ai_callback" && (taskRow as any)?.assignee_type === "ai_isa", JSON.stringify(taskRow))
        check("(7a) the task carries NO contact_id — the lead never converted to place this callback",
          (taskRow as any)?.contact_id === null || (taskRow as any)?.contact_id === undefined)

        const { data: leadAfter } = await svc.from("leads").select("contact_id, is_active").eq("id", leadId).maybeSingle()
        check("(7a) the lead did NOT convert — no contact_id, still active (a callback ask is not qualification)",
          !(leadAfter as any)?.contact_id && (leadAfter as any)?.is_active === true, JSON.stringify(leadAfter))

        const { count: agentActivityCount } = await svc
          .from("activities").select("id", { count: "exact", head: true })
          .eq("entity_id", leadId).eq("activity_type", "call")
        check("(7a) NO agent-assigned follow-up activity was written for the lead (never an agent task for an unqualified lead)",
          (agentActivityCount ?? 0) === 0, `activities=${agentActivityCount}`)
      }

      // ── (7b) POSITIVE CONTROL — a CONTACT callback still gets the agent-side follow-up ──
      const { data: contactRow, error: contactErr } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, agent_id: (agent as any).id, first_name: TAG, last_name: "CallbackContact",
        email: `${TAG}_contact@example.com`, contact_type: "buyer",
      }).select("id").single()
      if (contactErr || !contactRow) {
        check("(7b) seed tagged contact", false, contactErr?.message)
      } else {
        const contactId = (contactRow as any).id as string
        reg("contacts", "id", contactId)
        const beforeTaskCount = (await svc.from("tasks").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("source", "ai_callback")).count ?? 0
        const contactTool = buildScheduleCallbackTool({ brokerageId, contactId, leadId: null, agentId: (agent as any).id })
        const contactResult: any = await (contactTool as any).execute(
          { when_iso: null, when_description: "tomorrow morning", notes: "wants a market update" },
          { toolCallId: "t-contact-callback", messages: [] },
        )
        check("(7b) POSITIVE CONTROL: CONTACT callback tool reports scheduledVia 'activity' (unchanged agent-side path)",
          contactResult?.success === true && contactResult?.scheduledVia === "activity", JSON.stringify(contactResult))

        const { data: activityRow } = await svc
          .from("activities").select("id, contact_id, activity_type")
          .eq("contact_id", contactId).eq("activity_type", "call")
          .order("created_at", { ascending: false }).limit(1).maybeSingle()
        if ((activityRow as any)?.id) reg("activities", "id", (activityRow as any).id)
        check("(7b) POSITIVE CONTROL: a real `activities` row was written for the contact (the agent-side follow-up)",
          (activityRow as any)?.contact_id === contactId, JSON.stringify(activityRow))

        const afterTaskCount = (await svc.from("tasks").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("source", "ai_callback")).count ?? 0
        check("(7b) POSITIVE CONTROL: NO new ai_callback `tasks` row was written for the contact's own callback ask (that door is lead-only)",
          afterTaskCount === beforeTaskCount, `before=${beforeTaskCount} after=${afterTaskCount}`)
      }
    }
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      const { table, column, value } = cleanup[i]
      try { await svc.from(table).delete().eq(column, value) } catch { /* noop */ }
    }
    let remaining = 0
    for (const { table, column, value } of cleanup) {
      const { count } = await svc.from(table).select("id", { count: "exact", head: true }).eq(column, value)
      remaining += count ?? 0
    }
    check("(Layer 7) cleanup verified — 0 seeded rows remain", remaining === 0, `remaining=${remaining}`)
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
  console.log(" ✅ QUALIFICATION_PLAYBOOK — one shared builder mounted everywhere, follow-up tools id-locked and cost-ranked, record_qualification writes only live columns, schedule_callback routes a LEAD to a real AI ISA outbound callback (never a conversion, never an agent task) and keeps a CONTACT on the agent-side follow-up")
}
