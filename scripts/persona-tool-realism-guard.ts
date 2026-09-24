#!/usr/bin/env tsx
/**
 * scripts/persona-tool-realism-guard.ts   (npm run test:persona-tool-realism)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 79B — owner verbatim (wave 79): "the persona tools I believe are not
 * realistic as far as the questions or info that they would be looking for.
 * we created these batchdata tools that are not necessarily a good choice for
 * a tool and are basically the only provider tools that are built… tools for
 * the ai agents should not be using batchdata tools if there are less
 * expensive tools to look up properties but the ai agents need to not be
 * salesy but also try to get them qualified…"
 *
 * Proves, with NO network and NO database:
 *   Layer 0 — strip-comments positive control (CLAUDE.md §2).
 *   Layer 1 — every ToolPersona has a realistic QUESTION model: asks, an
 *             infoNeeded set drawn ONLY from QUALIFICATION_GOALS keys, a
 *             ladder (≥ 3 rungs, value first, offer last), and ≥ 2 of the
 *             owner's five follow-up offers, every offer a registered
 *             catalogue capability. Seller + sphere carry the value-review
 *             callback whose own description says the AGENT states the number.
 *   Layer 2 — every UserTypeSeat has asks + followUps (≥ 2), each followUp
 *             naming a registered seat tool / customer capability / draft_ai_
 *             reply, and seatPromptBlock renders them.
 *   Layer 3 — the platform prospect model: producers_count + preferred_path
 *             goals, a guide of the same shape, every offer a registered
 *             PLATFORM_PROSPECT_TOOL_NAMES tool, the callback exit registered
 *             and the follow-up ladder standing down on details.callback.
 *   Layer 4 — NO PERSONA TOOL FILE IMPORTS BATCHDATA (blankStrings so a
 *             description cannot false-match) + positive-control fixture;
 *             PERSONA_TOOL_POLICY names no property tool for any persona.
 *   Layer 5 — the property rail (injected rungs): cache short-circuits;
 *             RentCast reached only when cheaper rungs miss; BatchData NEVER
 *             for a conversation even when the policy allows it; BatchData
 *             DOES run for acquisition under an allowing policy (positive
 *             control); "off"/no-opt-in refuse; a customer never sees a
 *             valuation; rung costs are monotone cheapest-first.
 *   Layer 6 — registration: package.json script + guard ordering after
 *             test:scrapers + MAINTENANCE_DOMAINS entry.
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (path: string) => stripComments(readFileSync(path, "utf8"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 0 · strip-comments positive control]")
const railSrc = stripped("lib/ai-isa/property-lookup-rail.ts")
check("a comment-only phrase is ABSENT from stripped property-lookup-rail.ts", !railSrc.includes("THE ONE PROPERTY-LOOKUP RAIL"))
check("a real code token from the same file IS present", railSrc.includes("export async function lookupPropertyForConversation"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · every persona has a realistic question model]")
const { TOOL_PERSONAS, PERSONA_TOOL_POLICY, FREE_INTERNAL_TOOL_NAMES, costRankForTool } = await import("../lib/ai-isa/persona-tool-policy")
const { PERSONA_QUESTION_GUIDE, QUALIFICATION_GOALS, QUALIFICATION_FOLLOW_UP_MENU, OWNER_FOLLOW_UP_OFFERS, PLATFORM_PROSPECT_QUESTION_GUIDE, PLATFORM_QUALIFICATION_GOALS, PLATFORM_EXIT_MENU, buildQualificationPrompt } = await import("../lib/ai-isa/qualification-playbook")
const { CAPABILITY_CATALOGUE, CAPABILITY_IDS } = await import("../lib/ai-isa/capability-catalogue")

const goalKeys = new Set(QUALIFICATION_GOALS.map((g) => g.key))
const catalogueIds = new Set(CAPABILITY_IDS as readonly string[])
const menuTools = new Set(QUALIFICATION_FOLLOW_UP_MENU.map((o) => o.tool))
check("denominator: six ToolPersonas and ≥ 9 qualification goals loaded", TOOL_PERSONAS.length === 6 && goalKeys.size >= 9)
check("OWNER_FOLLOW_UP_OFFERS names the owner's five follow-ups and every one is a menu tool",
  OWNER_FOLLOW_UP_OFFERS.length === 5 && OWNER_FOLLOW_UP_OFFERS.every((t) => menuTools.has(t)))
check("PERSONA_QUESTION_GUIDE keys equal TOOL_PERSONAS exactly", Object.keys(PERSONA_QUESTION_GUIDE).sort().join(",") === [...TOOL_PERSONAS].sort().join(","))
for (const persona of TOOL_PERSONAS) {
  const g = PERSONA_QUESTION_GUIDE[persona]
  const badInfo = g.infoNeeded.filter((k) => !goalKeys.has(k))
  const badOffers = g.offers.filter((t) => !catalogueIds.has(t))
  const ownerOffers = g.offers.filter((t) => OWNER_FOLLOW_UP_OFFERS.includes(t))
  check(`${persona}: asks ≥ 4, ladder ≥ 3 rungs, infoNeeded ≥ 3 and ⊆ QUALIFICATION_GOALS keys`,
    g.asks.length >= 4 && g.ladder.length >= 3 && g.infoNeeded.length >= 3 && badInfo.length === 0, badInfo.join(","))
  check(`${persona}: every offer is a registered catalogue capability`, badOffers.length === 0, badOffers.join(","))
  check(`${persona}: draws ≥ 2 of the owner's five follow-ups (callback / matching listings / value review / listing appt / showing)`, ownerOffers.length >= 2, ownerOffers.join(","))
  check(`${persona}: infoNeeded always includes contact_info + intent + follow_up_preference (the hand-off triad)`,
    ["contact_info", "intent", "follow_up_preference"].every((k) => g.infoNeeded.includes(k)))
  check(`${persona}: the ladder's LAST rung is the offer and its FIRST rung gives value before asking`,
    /offer/i.test(g.ladder[g.ladder.length - 1]) && /answer|open with|lead with|value/i.test(g.ladder[0]))
  check(`${persona}: no ladder rung manufactures urgency or quotes a value`, !g.ladder.some((r) => /act now|limited time|today only|worth \$|\$\d/i.test(r)))
}
// The two personas whose "what's it worth" ask must NEVER produce a number.
const hvr = CAPABILITY_CATALOGUE.find((c) => c.id === "schedule_home_value_review")
check("seller + sphere offer schedule_home_value_review, whose own catalogue entry says the AGENT states the number, never the AI",
  PERSONA_QUESTION_GUIDE.seller.offers.includes("schedule_home_value_review") && PERSONA_QUESTION_GUIDE.sphere.offers.includes("schedule_home_value_review")
  && !!hvr && /AGENT states the number, never the AI/.test(hvr.usefulFor))
check("seller offers the no-obligation listing appointment and its ladder speaks the '≥ a week out, no obligation' choice",
  PERSONA_QUESTION_GUIDE.seller.offers.includes("book_listing_appointment") && /no obligation/.test(PERSONA_QUESTION_GUIDE.seller.ladder.join(" ")))
check("investor offers search_offmarket_opportunities (own cache, property-only) and stays off the value review / explainer / vendor bench",
  PERSONA_QUESTION_GUIDE.investor.offers.includes("search_offmarket_opportunities") && !PERSONA_QUESTION_GUIDE.investor.offers.some((t) => ["schedule_home_value_review", "send_explainer_video", "request_vendor_referral"].includes(t)))
check("buyer / renter / relocation / investor offer send_matching_listings (the 'list of properties matching the criteria they just told us')",
  (["buyer", "renter", "relocation", "investor"] as const).every((p) => PERSONA_QUESTION_GUIDE[p].offers.includes("send_matching_listings")))
check("every persona offers schedule_callback (call them again when THEY are ready)", TOOL_PERSONAS.every((p) => PERSONA_QUESTION_GUIDE[p].offers.includes("schedule_callback")))
for (const persona of TOOL_PERSONAS) {
  const prompt = buildQualificationPrompt({ persona, surface: "widget" })
  check(`${persona}: the routed prompt renders the ladder, the infoNeeded line and the offers (data → prompt)`,
    prompt.includes("THE LADDER") && prompt.includes("record_qualification should hold") && PERSONA_QUESTION_GUIDE[persona].offers.every((t) => prompt.includes(t)))
}
check("POSITIVE CONTROL: a guide with an off-vocabulary infoNeeded key IS caught by the same predicate", ["contact_info", "budget_30_60_90"].filter((k) => !goalKeys.has(k)).length === 1)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · every seat has asks + follow-up offers naming registered tools]")
const { USER_TYPE_SEATS, USER_TYPE_TOOL_POLICY, seatPromptBlock } = await import("../lib/ai-isa/user-type-tool-policy")
const { USER_TYPE_SEAT_TOOL_BUILDERS } = await import("../lib/ai-isa/user-type-tools")
const seatBuilders = new Set(Object.keys(USER_TYPE_SEAT_TOOL_BUILDERS))
const TOOL_TOKEN = /\b[a-z]+(?:_[a-z]+)+\b/g
for (const seat of USER_TYPE_SEATS) {
  const p = USER_TYPE_TOOL_POLICY[seat]
  check(`${seat}: asks ≥ 2 and followUps ≥ 2`, p.asks.length >= 2 && p.followUps.length >= 2)
  const allowed = new Set<string>([...seatBuilders, "draft_ai_reply", ...(p.customerPersonaToolsForContact ? [...catalogueIds, "find_listing_appointment_slots"] : [])])
  const named = [...new Set(p.followUps.flatMap((f) => f.match(TOOL_TOKEN) ?? []))].filter((t) => t.includes("_") && (seatBuilders.has(t) || catalogueIds.has(t) || t === "draft_ai_reply" || t === "find_listing_appointment_slots" || /^(get|send|update|respond|flag|list|schedule|book|lookup|find|search)_/.test(t)))
  const unknown = named.filter((t) => !allowed.has(t))
  check(`${seat}: every tool a followUp names is registered for that seat (seat builder / customer bundle when it may act for a contact / draft_ai_reply)`, named.length >= 1 && unknown.length === 0, unknown.join(","))
  check(`${seat}: seatPromptBlock renders the follow-up menu`, seatPromptBlock(seat).includes("WHAT TO OFFER NEXT"))
}
check("partner seats (vendor/lender/title) never name a customer capability or a property tool in their follow-ups",
  (["vendor", "lender", "title"] as const).every((s) => !USER_TYPE_TOOL_POLICY[s].followUps.some((f) => /send_matching_listings|schedule_home_value_review|lookup_property_facts|search_offmarket/.test(f))))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · platform prospects — the same non-salesy standard]")
const { PLATFORM_PROSPECT_TOOL_NAMES, platformExitMenuMatchesTools } = await import("../lib/platform/prospect-agent-tools")
const { PROSPECT_PREFERRED_PATHS, normalizeProspectQualification } = await import("../lib/platform/prospect-capture")
const platformGoalKeys = new Set(PLATFORM_QUALIFICATION_GOALS.map((g) => g.key))
check("PLATFORM_QUALIFICATION_GOALS carries size_seats + producers_count (wave-79: producing seats are the priced unit) + current_tools + pain + timeline + preferred_path",
  ["size_seats", "producers_count", "current_tools", "pain", "timeline", "preferred_path"].every((k) => platformGoalKeys.has(k)))
const pg = PLATFORM_PROSPECT_QUESTION_GUIDE
check("the platform guide has asks ≥ 6, a ladder ≥ 4, infoNeeded ⊆ platform goal keys ∪ contact_info",
  pg.asks.length >= 6 && pg.ladder.length >= 4 && pg.infoNeeded.every((k) => platformGoalKeys.has(k) || k === "contact_info"))
check("the platform guide's asks cover size, producers, current stack, pain, timeline bucket and the demo/trial/paid/callback path",
  /how many agents/.test(pg.asks.join(" ")) && /produce/.test(pg.asks.join(" ")) && /use today/.test(pg.asks.join(" ")) && /solve/.test(pg.asks.join(" ")) && /1-3, 3-6, 6-12/.test(pg.asks.join(" ")) && /see it live, try it themselves, start now, or a callback/.test(pg.asks.join(" ")))
check("every platform offer is a registered PLATFORM_PROSPECT_TOOL_NAMES tool, and the exit menu still matches the bundle",
  pg.offers.every((t) => (PLATFORM_PROSPECT_TOOL_NAMES as readonly string[]).includes(t)) && platformExitMenuMatchesTools())
check("the platform offers include the callback-when-ready exit AND the demo / signup / start / human exits (the owner's follow-up set, platform edition)",
  ["schedule_prospect_callback", "book_demo_appointment", "send_signup_link", "start_subscription", "request_human_handoff"].every((t) => pg.offers.includes(t)) && PLATFORM_EXIT_MENU.some((o) => o.tool === "schedule_prospect_callback"))
const platformPrompt = buildQualificationPrompt({ surface: "platform_reception" })
check("the platform_reception prompt renders the prospect ladder and never the real-estate goal list",
  platformPrompt.includes("THE LADDER") && platformPrompt.includes("save_prospect should hold") && !platformPrompt.includes("Property they're selling"))
check("PROSPECT_PREFERRED_PATHS = demo / trial / paid / callback / undecided and normalizeProspectQualification keeps producers_count + preferred_path, drops an off-vocabulary path",
  [...PROSPECT_PREFERRED_PATHS].sort().join(",") === "callback,demo,paid,trial,undecided"
  && normalizeProspectQualification({ producers_count: 7.4, preferred_path: "trial" }).producers_count === 7
  && normalizeProspectQualification({ preferred_path: "trial" }).preferred_path === "trial"
  && !("preferred_path" in normalizeProspectQualification({ preferred_path: "webinar" as never })))
const toolsSrc = stripped("lib/platform/prospect-agent-tools.ts")
const followupSrc = stripped("lib/platform/prospect-followup.ts")
const captureSrc = stripped("lib/platform/prospect-capture.ts")
check("schedule_prospect_callback is registered as tool({…}) and writes through the ONE prospect writer (markProspectCallback in prospect-capture.ts)",
  /schedule_prospect_callback:\s*tool\(\{/.test(toolsSrc) && /markProspectCallback\(svc,/.test(toolsSrc) && /export async function markProspectCallback/.test(captureSrc))
check("save_prospect's schema carries producers_count and preferred_path", /producers_count:\s*z\.number\(\)/.test(toolsSrc) && /preferred_path:\s*z\.enum\(PROSPECT_PREFERRED_PATHS\)/.test(toolsSrc))
check("both follow-up ladder rungs stand down on details.callback IN THE QUERY (a prospect who asked for a callback is scheduled, never chased)",
  (followupSrc.match(/\.is\("details->callback",\s*null\)/g) ?? []).length === 2)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · no persona tool imports BatchData; the policy names no property tool]")
const PERSONA_TOOL_FILES = [
  "lib/ai-isa/capability-catalogue.ts",
  "lib/ai-isa/customer-context-tools.ts",
  "lib/ai-isa/property-lookup-tools.ts",
  "lib/ai-isa/qualification-playbook.ts",
  "lib/ai-isa/persona-tool-policy.ts",
  "lib/ai-isa/user-type-tools.ts",
]
const BATCHDATA_IMPORT = /from\s*["']@\/lib\/external\/batchdata-[a-z-]+["']|import\(["']@\/lib\/external\/batchdata-[a-z-]+["']\)/
for (const f of PERSONA_TOOL_FILES) {
  const src = blankStrings(stripped(f))
  const raw = stripped(f)
  check(`${f}: imports NO lib/external/batchdata-* module (static or dynamic)`, !BATCHDATA_IMPORT.test(raw))
  // CALL shapes only — persona-tool-policy.ts legitimately NAMES skip_trace_property
  // inside its cost-rank regex (a classifier, not a call).
  check(`${f}: no BatchData / skip-trace CALL in stripped+blanked source`, !/callBatchDataMcp\(|batchDataPreferMcp\(|skipTrace\w*\(|enrichPropertyWithBatchData\(/.test(src))
}
check("POSITIVE CONTROL: the same import scan DOES flag a fixture importing batchdata-mcp",
  BATCHDATA_IMPORT.test(`import { callBatchDataMcp } from "@/lib/external/batchdata-mcp"`) && BATCHDATA_IMPORT.test(`const m = await import("@/lib/external/batchdata-mcp")`))
const PROPERTY_TOOL_NAME = /lookup_property$|search_properties|comparable_property|investor_buybox|verify_address/
for (const persona of TOOL_PERSONAS) {
  check(`PERSONA_TOOL_POLICY.${persona}.batchDataToolNames names NO property tool`, !PERSONA_TOOL_POLICY[persona].batchDataToolNames.some((n) => PROPERTY_TOOL_NAME.test(n)))
}
check("sphere is the ONLY persona with any BatchData tool name, and those are the DNC purpose (verify_phone / check_dnc_status / check_tcpa_status)",
  TOOL_PERSONAS.every((p) => p === "sphere" ? PERSONA_TOOL_POLICY[p].batchDataToolNames.slice().sort().join(",") === "check_dnc_status,check_tcpa_status,verify_phone" : PERSONA_TOOL_POLICY[p].batchDataToolNames.length === 0))
check("POSITIVE CONTROL: the property-tool name scan DOES flag the retired names", PROPERTY_TOOL_NAME.test("search_properties_preview") && PROPERTY_TOOL_NAME.test("lookup_property"))
check("lookup_property_facts + search_offmarket_opportunities are FREE-ranked (rank 0) and catalogued",
  FREE_INTERNAL_TOOL_NAMES.includes("lookup_property_facts") && FREE_INTERNAL_TOOL_NAMES.includes("search_offmarket_opportunities")
  && costRankForTool("lookup_property_facts") === 0 && catalogueIds.has("lookup_property_facts") && catalogueIds.has("search_offmarket_opportunities"))
const cctSrc = stripped("lib/ai-isa/customer-context-tools.ts")
check("buildCustomerFreeTools mounts lookup_property_facts (identity-optional) and search_offmarket_opportunities (contact-gated, persona-gated via isCapabilityEnabled)",
  /out\.lookup_property_facts = buildLookupPropertyFactsTool\(/.test(cctSrc) && /isCapabilityEnabled\("search_offmarket_opportunities", ctx\.persona, disabled\)/.test(cctSrc) && /contactId: ctx\.contactId \}\)/.test(cctSrc))
check("the off-market tool reads investor_offmarket_candidates pinned to BOTH brokerage_id and the ctx contact, and redacts through toInvestorFacingCandidates",
  /\.from\("investor_offmarket_candidates"\)[\s\S]{0,300}?\.eq\("brokerage_id", ctx\.brokerageId\)[\s\S]{0,80}?\.eq\("contact_id", ctx\.contactId\)/.test(stripped("lib/ai-isa/property-lookup-tools.ts")) && /toInvestorFacingCandidates\(/.test(stripped("lib/ai-isa/property-lookup-tools.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · the property rail — cheapest first, BatchData only for acquisition under policy]")
const rail = await import("../lib/ai-isa/property-lookup-rail")
const { lookupPropertyForConversation, isBatchDataRungAllowed, redactFactsForAudience, PROPERTY_LOOKUP_RUNG_ORDER, PROPERTY_LOOKUP_RUNG_COST_USD, BATCHDATA_ELIGIBLE_PURPOSES } = rail
type Facts = import("../lib/ai-isa/property-lookup-rail").PropertyLookupFacts
type Rung = import("../lib/ai-isa/property-lookup-rail").PropertyLookupRung
const facts = (source: Rung, extra: Partial<Facts> = {}): Facts => ({
  address: "123 Main St", city: "Austin", state: "TX", zip: "78701", beds: 3, baths: 2, sqft: 1800, yearBuilt: 1998, lotSize: null,
  propertyType: "single_family", listingStatus: null, listPrice: null, estimatedValue: 450000, taxAssessedValue: 390000,
  // lat / lon / isEstimate: the listing_intake fields lane 80B merged onto the facts (enrichment-chain.ts → rail).
  mlsNumber: null, listingUrl: null, lat: null, lon: null, isEstimate: false, source, sourceNote: "fixture", ...extra,
})
const calls: Rung[] = []
const rungs = (hits: Partial<Record<Rung, boolean>>) => Object.fromEntries(PROPERTY_LOOKUP_RUNG_ORDER.map((r) => [r, async () => { calls.push(r); return hits[r] ? facts(r) : null }])) as Record<Rung, () => Promise<Facts | null>>
const req = (purpose: import("../lib/ai-isa/property-lookup-rail").PropertyLookupPurpose, audience: "customer" | "staff" = "customer") =>
  ({ brokerageId: "b-1", purpose, audience, address: { street: "123 Main St", city: "Austin", state: "TX", zip: "78701" } })
const ALLOW = { batchDataTier: "lean" as const, batchDataOptedIn: true }
const NO_OPT_IN = { batchDataTier: "lean" as const, batchDataOptedIn: false }
const OFF = { batchDataTier: "off" as const, batchDataOptedIn: true }

check("rung order is cache → tenant_idx → rentcast → public_records → batchdata and the documented cost is non-decreasing up to public records (BatchData is per-record priced beyond the sample)",
  PROPERTY_LOOKUP_RUNG_ORDER.join(",") === "cache,tenant_idx,rentcast,public_records,batchdata"
  && PROPERTY_LOOKUP_RUNG_COST_USD.cache === 0 && PROPERTY_LOOKUP_RUNG_COST_USD.tenant_idx === 0 && PROPERTY_LOOKUP_RUNG_COST_USD.rentcast > 0 && PROPERTY_LOOKUP_RUNG_COST_USD.public_records > 0)
// Re-anchored lane 81B: 'valuation' (the wave-70 staff comps/AVM lane) joined the carve-out
// through the ONE gate; a conversation or a listing intake still never reaches BatchData.
check("BATCHDATA_ELIGIBLE_PURPOSES = acquisition / skip_trace / dnc / valuation — never conversation or listing_intake",
  [...BATCHDATA_ELIGIBLE_PURPOSES].sort().join(",") === "acquisition,dnc,skip_trace,valuation")
check("isBatchDataRungAllowed: conversation → false even under an allowing policy; acquisition → true only with tier≠off AND opt-in",
  !isBatchDataRungAllowed("conversation", ALLOW) && !isBatchDataRungAllowed("listing_intake", ALLOW)
  && isBatchDataRungAllowed("acquisition", ALLOW) && !isBatchDataRungAllowed("acquisition", NO_OPT_IN) && !isBatchDataRungAllowed("acquisition", OFF))

{ // cache hit short-circuits — nothing paid runs
  calls.length = 0
  const r = await lookupPropertyForConversation(req("conversation"), { rungs: rungs({ cache: true }), policy: ALLOW })
  check("cache hit: found from the cache and NO other rung ran (rungsTried = [cache])", r.found && r.facts?.source === "cache" && calls.join(",") === "cache" && r.rungsTried.join(",") === "cache")
}
{ // cache + idx miss → rentcast answers
  calls.length = 0
  const r = await lookupPropertyForConversation(req("conversation"), { rungs: rungs({ rentcast: true }), policy: ALLOW })
  check("cache + tenant IDX miss → RentCast answers, public records and BatchData never run", r.found && r.facts?.source === "rentcast" && calls.join(",") === "cache,tenant_idx,rentcast")
}
{ // everything misses for a CONVERSATION — BatchData is SKIPPED even though policy allows and the rung would answer
  calls.length = 0
  const r = await lookupPropertyForConversation(req("conversation"), { rungs: rungs({ batchdata: true }), policy: ALLOW })
  check("conversation purpose: BatchData NEVER runs even when the policy allows it and it would have answered (not found; skipped reason names the purpose)",
    !r.found && !calls.includes("batchdata") && r.skipped.some((s) => s.rung === "batchdata" && /reserved for acquisition/.test(s.reason)))
}
{ // POSITIVE CONTROL — acquisition + allowing policy → BatchData runs last and answers
  calls.length = 0
  const r = await lookupPropertyForConversation(req("acquisition", "staff"), { rungs: rungs({ batchdata: true }), policy: ALLOW })
  check("POSITIVE CONTROL: acquisition purpose under an allowing policy reaches BatchData LAST and answers from it",
    r.found && r.facts?.source === "batchdata" && calls.join(",") === "cache,tenant_idx,rentcast,public_records,batchdata")
}
{ // acquisition but no opt-in / tier off → refused
  calls.length = 0
  const a = await lookupPropertyForConversation(req("acquisition", "staff"), { rungs: rungs({ batchdata: true }), policy: NO_OPT_IN })
  const b = await lookupPropertyForConversation(req("acquisition", "staff"), { rungs: rungs({ batchdata: true }), policy: OFF })
  check("acquisition WITHOUT the platform-staff opt-in, or with tier off → BatchData never runs (fail closed, reason named)",
    !a.found && !b.found && !calls.includes("batchdata") && a.skipped.some((s) => /opted/.test(s.reason)) && b.skipped.some((s) => /tier is off/.test(s.reason)))
}
{ // audience redaction
  const cust = await lookupPropertyForConversation(req("conversation", "customer"), { rungs: rungs({ cache: true }), policy: ALLOW })
  const staff = await lookupPropertyForConversation(req("conversation", "staff"), { rungs: rungs({ cache: true }), policy: ALLOW })
  check("a CUSTOMER audience never receives estimatedValue / taxAssessedValue; the STAFF audience keeps them (positive control) — the home-value review callback stays the only number path",
    cust.facts?.estimatedValue === null && cust.facts?.taxAssessedValue === null && cust.facts?.beds === 3 && staff.facts?.estimatedValue === 450000)
  const red = redactFactsForAudience(facts("cache", { listPrice: 425000 }), "customer")
  check("redactFactsForAudience keeps the public listPrice of a listing while stripping valuation-shaped figures", red.listPrice === 425000 && red.estimatedValue === null)
}
{ // a throwing rung never fails the lookup — the ladder continues
  calls.length = 0
  const r = await lookupPropertyForConversation(req("conversation"), {
    rungs: { ...rungs({ public_records: true }), tenant_idx: async () => { calls.push("tenant_idx"); throw new Error("idx dark") } }, policy: ALLOW,
  })
  check("a dark rung (tenant IDX throws) is recorded as skipped and the ladder continues to the next paid rung", r.found && r.facts?.source === "public_records" && r.skipped.some((s) => s.rung === "tenant_idx"))
}
{ // §4 fail closed
  const r = await lookupPropertyForConversation({ ...req("conversation"), brokerageId: "" }, { rungs: rungs({ cache: true }), policy: ALLOW })
  check("a tenant-less request runs NO rung at all (§4)", !r.found && r.rungsTried.length === 0)
}
check("the rail's batchdata rung is reachable ONLY behind isBatchDataRungAllowed in stripped source (one guarded call site)",
  (railSrc.match(/isBatchDataRungAllowed\(req\.purpose, policy\)/g) ?? []).length === 1 && /if \(rung === "batchdata"\)/.test(railSrc))
check("the rail's paid rungs ride EXISTING survivors (searchRentcastSaleListings / lookupPropertyByAddress / batchDataPreferMcp / meterVendorSpend) — no second provider client",
  /searchRentcastSaleListings\(/.test(railSrc) && /lookupPropertyByAddress\(/.test(railSrc) && /batchDataPreferMcp/.test(railSrc) && /meterVendorSpend\(/.test(railSrc) && !/fetch\(/.test(railSrc))
check("the persona tool calls the rail with purpose 'conversation' and audience 'customer' — never a purpose the model can choose",
  /purpose: "conversation",\s*audience: "customer"/.test(stripped("lib/ai-isa/property-lookup-tools.ts")) && !/purpose: z\./.test(stripped("lib/ai-isa/property-lookup-tools.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · registration]")
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
check("package.json registers test:persona-tool-realism → this file", pkg.scripts["test:persona-tool-realism"] === "tsx scripts/persona-tool-realism-guard.ts")
const guardLine = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers (wave 79 ruling: new proofs append after test:scrapers)",
  guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:persona-tool-realism") > guardLine.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS.persona_tool_realism names this proof under ai_isa",
  MAINTENANCE_DOMAINS.persona_tool_realism?.proof === "test:persona-tool-realism" && MAINTENANCE_DOMAINS.persona_tool_realism?.manager === "ai_isa")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ PERSONA_TOOL_REALISM — see failures above")
  process.exit(1)
} else {
  console.log(" ✅ PERSONA_TOOL_REALISM — every persona, seat and platform prospect has a realistic question model with the owner's follow-ups; no persona tool touches BatchData; the property rail is cheapest-first and BatchData is acquisition/skip-trace/DNC only")
}
