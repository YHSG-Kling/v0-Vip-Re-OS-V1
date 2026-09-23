#!/usr/bin/env tsx
/**
 * scripts/batchdata-isa-tools-simulator.ts   (npm run test:batchdata-isa-tools)
 *
 * Proves the wave-71/lane-73B BatchData persona tool set — lib/ai-isa/batchdata-
 * isa-tools.ts + lib/ai-isa/persona-tool-policy.ts — WITHOUT spending real API
 * budget, real LLM tokens, or making a single real network call:
 *
 *   [1] Fail closed: no tools when BatchData's MCP token is unresolvable, and
 *       no tools for a tenant-less/conversation-less ctx.
 *   [2] PERSONA ALLOWLISTS (lane 73B — six personas, one policy table):
 *       buyer/seller/investor/renter/relocation/sphere each get EXACTLY the
 *       tool set persona-tool-policy.ts's PERSONA_TOOL_POLICY names — never
 *       more. investor STILL has no skip-trace/owner tool (unchanged ruling);
 *       seller NEVER gets skip-trace (the tool name does not exist in this
 *       registry at all); renter has ZERO BatchData tools of any kind; sphere
 *       gets verify_phone/check_dnc_status/check_tcpa_status ONLY when the
 *       conversation is declared outbound-eligible (fail closed by default).
 *   [3] LANE 79B — NO PROPERTY TOOL IS REGISTERED ANY MORE (owner, wave 79:
 *       "BatchData reserved for platform lead ACQUISITION, skip-trace, DNC"):
 *       the registry carries the DNC purpose only; the page-before-preview
 *       ordering rule went with the page pull it ordered (tombstone in the
 *       module). The property survivor is lib/ai-isa/property-lookup-rail.ts
 *       (scripts/persona-tool-realism-guard.ts proves the ladder).
 *   [4] Budget refusal — PURE decision core (evaluateBudget) + an ACTUAL tool
 *       execute() call (seller persona's verify_address) with the conversation
 *       budget set below one call's cost.
 *   [5] Redaction: owner/equity/contact fields are stripped from every
 *       "property-only" persona's tool rows (buyer/investor/renter/relocation)
 *       — POSITIVE CONTROL: the SAME fixture row read through the "identity"
 *       mapper (seller/sphere) still carries them.
 *   [6] COST-TIER CONSTRICTION (lane 73B, owner verbatim: "if batchdata is
 *       going to be expensive, tools should be constricted."): full → no
 *       restriction; lean (documented default) → preview/count/lookup_
 *       property/verify-prefixed/check_dnc_status/check_tcpa_status survive,
 *       `_page` is cut; off → zero tools. The monthly-spend auto-downgrade
 *       (full → lean once platform BatchData spend reaches the cap) is proved
 *       with an INJECTED ledger reader (no network) and a POSITIVE CONTROL
 *       (healthy spend leaves "full" alone).
 *   [7] resolveToolPersona — the ONE vocabulary-derivation function (§6):
 *       investor persona-column wins over everything, then relocated, then
 *       renter home_owner_status, then seller contact_type, then sphere/
 *       referral_partner/lifetime_customer, default buyer.
 *   [8] Call sites reference the new module — STRIPPED source (CLAUDE.md §2).
 *
 * NO LIVE BATCHDATA CALLS ANYWHERE IN THIS FILE. Every tool this file executes
 * is one whose OWN refusal path (fail-closed unconfigured, budget exceeded, or
 * ordering violated) fires before any network function is ever reached.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"
import {
  batchDataIsaTools,
  evaluateBudget,
  resolveBatchDataIsaBudgetCents,
  resolvePersonaBudgetCents,
} from "../lib/ai-isa/batchdata-isa-tools"
// Lane 79B — the row mappers MOVED to the property tool module (tombstone in
// batchdata-isa-tools.ts); the proof follows the survivor.
import { toInvestorFacingToolRow, toIsaFacingToolRow } from "../lib/ai-isa/property-lookup-tools"
import {
  resolveToolPersona,
  PERSONA_TOOL_POLICY,
  isToolAllowedForPersona,
  resolveConfiguredBatchDataToolTier,
  resolveBatchDataToolMonthlyCapCents,
  evaluateEffectiveBatchDataTier,
  resolveEffectiveBatchDataToolTier,
  isToolAllowedForTier,
  filterToolsByTier,
  type ToolPersona,
} from "../lib/ai-isa/persona-tool-policy"
type BuyBoxMatchRow = Record<string, unknown>

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

const root = process.cwd()
const readBlanked = (rel: string) => blankComments(readFileSync(join(root, rel), "utf8"))

function clearBatchDataEnv() {
  delete process.env.BATCHDATA_MCP_URL
  delete process.env.BATCHDATA_MCP_AUTH
  delete process.env.BATCHDATA_API_KEY
  delete process.env.BATCHDATA_ISA_BUDGET_CENTS
  delete process.env.BATCHDATA_TOOL_TIER
  delete process.env.BATCHDATA_TOOL_MONTHLY_CAP_CENTS
}

// ─── 1. Fail closed — no token, no tenant, no conversation key ───────────────────────────
{
  clearBatchDataEnv()
  const buyerEmpty = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "buyer", conversationKey: "conv-1" })
  ok(Object.keys(buyerEmpty).length === 0, "no tools (buyer persona) when BATCHDATA_MCP_AUTH/BATCHDATA_API_KEY are both unset")
  const investorEmpty = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "investor", conversationKey: "conv-2" })
  ok(Object.keys(investorEmpty).length === 0, "no tools (investor persona) when BatchData's MCP token is unresolvable")

  process.env.BATCHDATA_API_KEY = "test-fake-key-never-used-for-a-real-call"
  const noBrokerage = await batchDataIsaTools({ brokerageId: "", persona: "buyer", conversationKey: "conv-3" })
  ok(Object.keys(noBrokerage).length === 0, "§4: refuses a tenant-less call even with a token present")
  const noConvKey = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "buyer", conversationKey: "" })
  ok(Object.keys(noConvKey).length === 0, "refuses a conversation-less call even with a token present (ordering/budget state needs a key)")
}

// ─── 2. Persona allowlists (lane 73B — six personas, one policy table) ───────────────────
let buyerTools: Record<string, unknown> = {}
let sellerTools: Record<string, unknown> = {}
let investorTools: Record<string, unknown> = {}
let renterTools: Record<string, unknown> = {}
let relocationTools: Record<string, unknown> = {}
let sphereToolsBlocked: Record<string, unknown> = {}
let sphereToolsEligible: Record<string, unknown> = {}
{
  process.env.BATCHDATA_API_KEY = "test-fake-key-never-used-for-a-real-call"
  // Tier defaults to "lean" when unset — pin it to "full" for this section so the
  // PERSONA allowlist (not the tier filter) is what's under test here; tier
  // interaction is proved separately in section 6.
  process.env.BATCHDATA_TOOL_TIER = "full"

  buyerTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "buyer", conversationKey: "conv-buyer-1", contactId: "contact-1" })
  sellerTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "seller", conversationKey: "conv-seller-1", contactId: "contact-2" })
  investorTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "investor", conversationKey: "conv-investor-1" })
  renterTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "renter", conversationKey: "conv-renter-1" })
  relocationTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "relocation", conversationKey: "conv-relocation-1" })
  sphereToolsBlocked = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "sphere", conversationKey: "conv-sphere-1" }) // outboundEligible omitted → false
  sphereToolsEligible = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "sphere", conversationKey: "conv-sphere-2", outboundEligible: true })

  for (const persona of ["buyer", "seller", "investor", "renter", "relocation", "sphere"] as const) {
    ok(persona in PERSONA_TOOL_POLICY, `PERSONA_TOOL_POLICY names a policy for "${persona}"`)
  }
  // Lane 77A — "vendors are not contact type, they are user type" (owner,
  // wave 77): the `vendor` persona lane 76A added is GONE. A vendor SEAT never
  // reaches this customer registry at all (lib/ai-isa/user-type-tool-policy.ts
  // mounts zero BatchData on it), and the registry FAILS CLOSED on the stale
  // persona word — the positive control that an unknown persona gets nothing.
  ok(!("vendor" in PERSONA_TOOL_POLICY), "TOMBSTONE (lane 77A): PERSONA_TOOL_POLICY has NO vendor row — a vendor is a seat, never a persona")
  const staleVendorPersona = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "vendor" as unknown as ToolPersona, conversationKey: "conv-vendor-1", contactId: "contact-9" })
  ok(Object.keys(staleVendorPersona).length === 0, "FAIL CLOSED: the stale 'vendor' persona word gets ZERO BatchData tools (unknown persona → no allowlist, no cap, nothing)")

  const assertExact = (label: string, actual: Record<string, unknown>, expected: readonly string[]) => {
    for (const name of expected) ok(name in actual, `${label}: has ${name}`)
    ok(Object.keys(actual).length === expected.length,
      `${label}: exactly ${expected.length} tools (found ${Object.keys(actual).length}: ${Object.keys(actual).sort().join(", ") || "(none)"})`)
  }

  assertExact("buyer persona", buyerTools, PERSONA_TOOL_POLICY.buyer.batchDataToolNames)
  assertExact("seller persona", sellerTools, PERSONA_TOOL_POLICY.seller.batchDataToolNames)
  assertExact("investor persona", investorTools, PERSONA_TOOL_POLICY.investor.batchDataToolNames)
  assertExact("renter persona", renterTools, PERSONA_TOOL_POLICY.renter.batchDataToolNames)
  assertExact("relocation persona", relocationTools, PERSONA_TOOL_POLICY.relocation.batchDataToolNames)
  assertExact("sphere persona (outboundEligible: true)", sphereToolsEligible, PERSONA_TOOL_POLICY.sphere.batchDataToolNames)

  // ── owner ruling checks, named explicitly (not just "matches the table" —
  // the table itself could drift from the ruling without a lane noticing) ──
  ok(Object.keys(renterTools).length === 0, "RULING: renter persona has NO BatchData tools of any kind (RentCast rentals only)")
  ok(!("lookup_property" in investorTools) && !("verify_address" in investorTools) &&
     !("verify_phone" in investorTools) && !("check_dnc_status" in investorTools) &&
     !("check_tcpa_status" in investorTools) && !("skip_trace_property" in investorTools) &&
     !("reverse_skip_trace" in investorTools),
     "RULING (wave 68/69): investor persona STILL has no skip-trace/owner-contact tool")
  ok(!("skip_trace_property" in sellerTools) && !("reverse_skip_trace" in sellerTools),
     "RULING (owner, wave 73): seller persona NEVER gets skip-trace — they are the owner")
  // RULING SUPERSEDED (owner, wave 75 verbatim): "random batchdata tools" are out of customer
  // care — lookup_property/comparable_property_* could surface a dollar figure mid-conversation,
  // the exact "value over the conversation" the owner ruled against. seller's BatchData
  // allowlist is now EMPTY; lib/ai-isa/capability-catalogue.ts::buildScheduleHomeValueReviewTool
  // (never runs an AVM, only books a callback) is the survivor for "what's my home worth".
  ok(Object.keys(sellerTools).length === 0, "RULING (wave 75): seller persona has NO BatchData tools of any kind — schedule_home_value_review is the survivor")
  ok(!("search_properties_preview" in buyerTools) && !("search_properties_page" in buyerTools),
     "RULING: buyer persona has no direct BatchData property search — RentCast is first, BatchData is comps-only")
  ok(Object.keys(buyerTools).length === 0, "RULING (wave 75): buyer persona has NO BatchData tools of any kind — the capability catalogue covers customer care instead")
  ok(Object.keys(relocationTools).length === 0, "RULING (wave 75): relocation persona has NO BatchData tools of any kind — search_our_listings/send_matching_listings cover area visibility")
  // RULING SUPERSEDED (lane 79B, owner wave 79 verbatim): "tools for the ai agents should not be
  // using batchdata tools if there are less expensive tools to look up properties… BatchData
  // reserved for platform lead ACQUISITION, skip-trace, DNC. Investor persona: property-only
  // (off-market most-likely-to-sell)." The investor's off-market matches now come from OUR OWN
  // CACHE (investor_offmarket_candidates) through lib/ai-isa/property-lookup-tools.ts::
  // buildSearchOffmarketOpportunitiesTool — never a live BatchData pull from inside a chat.
  ok(Object.keys(investorTools).length === 0, "RULING (wave 79): investor persona has NO BatchData tools of any kind — search_offmarket_opportunities (own cache) is the survivor")
  for (const [label, tools] of [["buyer", buyerTools], ["seller", sellerTools], ["investor", investorTools], ["renter", renterTools], ["relocation", relocationTools], ["sphere (eligible)", sphereToolsEligible]] as const) {
    ok(!Object.keys(tools).some((n) => /lookup_property|search_properties|comparable_property|investor_buybox|verify_address/.test(n)),
       `RULING (wave 79): ${label} persona registry carries NO property tool — the rail (lib/ai-isa/property-lookup-rail.ts) is the survivor`)
  }

  // ── sphere: outbound-eligibility gate, fail closed by default ──────────
  ok(Object.keys(sphereToolsBlocked).length === 0,
     "sphere persona: ZERO tools when outboundEligible is omitted (default false — fail closed)")
  ok("verify_phone" in sphereToolsEligible && "check_dnc_status" in sphereToolsEligible && "check_tcpa_status" in sphereToolsEligible,
     "sphere persona: verify_phone/check_dnc_status/check_tcpa_status ONLY once outboundEligible: true")

  delete process.env.BATCHDATA_TOOL_TIER
}

// ─── 3. Lane 79B — the property tools are GONE from the module (stripped source) ────────
{
  const isaSrc = readBlanked("lib/ai-isa/batchdata-isa-tools.ts")
  for (const name of ["lookup_property", "search_properties_preview", "search_properties_count", "search_properties_page", "verify_address", "comparable_property_preview", "comparable_property_count", "investor_buybox_preview", "investor_buybox_count"]) {
    ok(!new RegExp(`registry\\.${name}\\s*=\\s*tool\\(`).test(isaSrc), `stripped batchdata-isa-tools.ts registers NO \`${name}\` tool any more (tombstoned; survivor lib/ai-isa/property-lookup-rail.ts)`)
  }
  ok(/registry\.verify_phone\s*=\s*tool\(/.test(isaSrc) && /registry\.check_dnc_status\s*=\s*tool\(/.test(isaSrc) && /registry\.check_tcpa_status\s*=\s*tool\(/.test(isaSrc),
     "POSITIVE CONTROL: the SAME scan still sees the three DNC-purpose tools that remain registered")
  ok(!/evaluatePageOrder|criteriaKey\(|seenCriteria/.test(isaSrc), "the page-before-preview ordering rule left with the page pull it ordered (no evaluatePageOrder / criteriaKey / seenCriteria token in stripped source)")
  ok(!/from ["']@\/lib\/external\/batchdata-mcp["']/.test(isaSrc) || !/callBatchDataMcp|extractRows|comparablePropertyPreview|investorBuyboxPreview/.test(isaSrc),
     "no property-shaped BatchData MCP wrapper (callBatchDataMcp / extractRows / comparable / buybox) is imported any more — only the phone/DNC wrappers")
}

// ─── 4. Budget refusal ─────────────────────────────────────────────────────────────────────
{
  // (a) PURE decision core
  ok(resolveBatchDataIsaBudgetCents() === 200, "resolveBatchDataIsaBudgetCents: documented default is 200 ($2.00) when unset")
  process.env.BATCHDATA_ISA_BUDGET_CENTS = "50"
  ok(resolveBatchDataIsaBudgetCents() === 50, "resolveBatchDataIsaBudgetCents: honors a valid positive override")
  process.env.BATCHDATA_ISA_BUDGET_CENTS = "-5"
  ok(resolveBatchDataIsaBudgetCents() === 200, "resolveBatchDataIsaBudgetCents: a negative override falls back to the default (fail closed)")
  process.env.BATCHDATA_ISA_BUDGET_CENTS = "not-a-number"
  ok(resolveBatchDataIsaBudgetCents() === 200, "resolveBatchDataIsaBudgetCents: a non-numeric override falls back to the default")
  delete process.env.BATCHDATA_ISA_BUDGET_CENTS

  // resolvePersonaBudgetCents: the tighter of the env ceiling and the persona's OWN cap.
  ok(resolvePersonaBudgetCents("renter") === 0, "resolvePersonaBudgetCents: renter's own cap ($0.00) wins even though the env ceiling defaults to $2.00")
  ok(resolvePersonaBudgetCents("buyer") === 100, "resolvePersonaBudgetCents: buyer's own cap ($1.00) is tighter than the env default")
  process.env.BATCHDATA_ISA_BUDGET_CENTS = "10" // 10¢ — tighter than sphere's own $0.50 cap
  ok(resolvePersonaBudgetCents("sphere") === 10, "resolvePersonaBudgetCents: an env override TIGHTENS a persona's cap, never loosens it")
  delete process.env.BATCHDATA_ISA_BUDGET_CENTS

  const underBudget = evaluateBudget(0, 200, 0.05)
  ok(underBudget === null, "evaluateBudget: allows a call that fits inside the budget")
  const overBudget = evaluateBudget(199, 200, 0.05)
  ok(overBudget !== null && overBudget.success === false, "evaluateBudget: refuses a call that would push spend over the budget")
  ok(/\$1\.99 of \$2\.00/.test(overBudget?.error ?? ""), "evaluateBudget: refusal message names the actual spent/budget figures")

  // (b) ACTUAL tool call — sphere persona's verify_phone, budget set to 1¢ (verify_phone
  // costs MCP_TOOL_CALL_COST_USD, well over 1¢). NO NETWORK ATTEMPT: budgetRefusal is
  // checked FIRST in every execute(), before callBatchDataMcp is ever reached.
  // (RULING wave 75 superseded seller's own BatchData allowlist to EMPTY — see section 3 —
  // so sphere is now the persona with a non-empty allowlist AND no outbound network need to
  // fake; outboundEligible: true is required or sphere's tools do not register at all.)
  process.env.BATCHDATA_API_KEY = "test-fake-key-never-used-for-a-real-call"
  process.env.BATCHDATA_ISA_BUDGET_CENTS = "1"
  process.env.BATCHDATA_TOOL_TIER = "full"
  const budgetSphereTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "sphere", conversationKey: "conv-budget-1", outboundEligible: true })
  const verifyPhoneTool = budgetSphereTools.verify_phone as { execute: (args: any) => Promise<any> } | undefined
  ok(!!verifyPhoneTool, "sphere persona (outbound-eligible) exposes verify_phone to call")
  if (verifyPhoneTool) {
    const result = await verifyPhoneTool.execute({ phone: "5125551234" })
    ok(result.success === false, "verify_phone.execute: refused when the conversation's $0.01 budget can't cover the call")
    ok(/budget/i.test(result.error ?? ""), "verify_phone.execute: refusal names the budget, not a network/config error")
  }
  delete process.env.BATCHDATA_ISA_BUDGET_CENTS
  delete process.env.BATCHDATA_TOOL_TIER
}

// ─── 5. Redaction — property-only personas strip owner fields; identity personas keep them ─
{
  const fixture: BuyBoxMatchRow = {
    address: { street: "456 Off Market Ln", city: "Round Rock", state: "TX", zip: "78664" },
    owner: { fullName: "Jane Landlord", phone: "5125559876", email: "jane@example.com" },
    owner_name: "Jane Landlord",
    owner_phone: "5125559876",
    owner_email: "jane@example.com",
    owner_mailing_address: "1 PO Box, Elsewhere TX",
    equity_percent: 62,
    valuation: { estimatedValue: 341000 },
    building: { bedroomCount: 3, bathroomCount: 2, propertyType: "Single Family" },
    quickLists: ["tired-landlord", "absentee-owner"],
  }

  const investorRow = toInvestorFacingToolRow(fixture)
  ok(!("owner" in investorRow) && !("owner_name" in investorRow) && !("owner_phone" in investorRow) && !("owner_email" in investorRow) && !("owner_mailing_address" in investorRow) && !("equity_percent" in investorRow),
     "toInvestorFacingToolRow: no owner/equity/contact key survives on the property-only row")
  ok(investorRow.address === "456 Off Market Ln" && investorRow.city === "Round Rock" && investorRow.estimatedValue === 341000 && investorRow.beds === 3 && investorRow.baths === 2 && investorRow.propertyType === "Single Family",
     "toInvestorFacingToolRow: property fields (address/city/estimatedValue/beds/baths/propertyType) DO survive")
  ok(investorRow.likelihoodBand === "medium" && investorRow.likelihoodBandSource === "signal-based",
     `toInvestorFacingToolRow: likelihoodBand derived from quicklists via deriveLikelihoodBand (tired-landlord → medium); got ${investorRow.likelihoodBand}/${investorRow.likelihoodBandSource}`)

  // POSITIVE CONTROL — the SAME fixture read through the identity mapper still carries
  // every owner/equity field, proving the property-only test above isn't passing because
  // nothing strips anything for anyone.
  const identityRow = toIsaFacingToolRow(fixture) as any
  ok(identityRow.owner_name === "Jane Landlord" && identityRow.owner_phone === "5125559876" && identityRow.owner_email === "jane@example.com" && identityRow.equity_percent === 62,
     "positive control: toIsaFacingToolRow (identity) KEEPS owner_name/owner_phone/owner_email/equity_percent on the SAME fixture row")

  // Every "property-only" persona in the policy table routes through the SAME redaction —
  // asserted against the table itself so a future persona addition cannot silently default
  // to "identity" and leak owner data.
  for (const persona of Object.keys(PERSONA_TOOL_POLICY) as ToolPersona[]) {
    const expectRedacted = ["buyer", "investor", "renter", "relocation"].includes(persona)
    ok(PERSONA_TOOL_POLICY[persona].redaction === (expectRedacted ? "property-only" : "identity"),
       `PERSONA_TOOL_POLICY.${persona}.redaction is ${expectRedacted ? "property-only" : "identity"}`)
  }
}

// ─── 6. Cost-tier constriction (lane 73B) ──────────────────────────────────────────────────
{
  delete process.env.BATCHDATA_TOOL_TIER
  ok(resolveConfiguredBatchDataToolTier() === "lean", "resolveConfiguredBatchDataToolTier: documented default is \"lean\" when unset")
  process.env.BATCHDATA_TOOL_TIER = "full"
  ok(resolveConfiguredBatchDataToolTier() === "full", "resolveConfiguredBatchDataToolTier: honors a valid \"full\" override")
  process.env.BATCHDATA_TOOL_TIER = "OFF"
  ok(resolveConfiguredBatchDataToolTier() === "off", "resolveConfiguredBatchDataToolTier: case-insensitive")
  process.env.BATCHDATA_TOOL_TIER = "bogus"
  ok(resolveConfiguredBatchDataToolTier() === "lean", "resolveConfiguredBatchDataToolTier: an invalid value falls back to \"lean\" (fail closed), never \"full\"")
  delete process.env.BATCHDATA_TOOL_TIER

  ok(resolveBatchDataToolMonthlyCapCents() === 50_000, "resolveBatchDataToolMonthlyCapCents: documented default is $500.00 when unset")
  process.env.BATCHDATA_TOOL_MONTHLY_CAP_CENTS = "10000"
  ok(resolveBatchDataToolMonthlyCapCents() === 10_000, "resolveBatchDataToolMonthlyCapCents: honors a valid override")
  delete process.env.BATCHDATA_TOOL_MONTHLY_CAP_CENTS

  // isToolAllowedForTier / filterToolsByTier
  ok(isToolAllowedForTier("search_properties_page", "full"), "isToolAllowedForTier: full allows a _page tool")
  ok(!isToolAllowedForTier("search_properties_page", "lean"), "isToolAllowedForTier: lean CUTS a _page tool")
  ok(isToolAllowedForTier("search_properties_preview", "lean"), "isToolAllowedForTier: lean KEEPS a _preview tool")
  ok(isToolAllowedForTier("comparable_property_count", "lean"), "isToolAllowedForTier: lean KEEPS a _count tool")
  ok(isToolAllowedForTier("lookup_property", "lean"), "isToolAllowedForTier: lean KEEPS lookup_property")
  ok(isToolAllowedForTier("verify_address", "lean"), "isToolAllowedForTier: lean KEEPS a verify-prefixed tool")
  ok(isToolAllowedForTier("check_dnc_status", "lean") && isToolAllowedForTier("check_tcpa_status", "lean"),
     "isToolAllowedForTier: lean KEEPS check_dnc_status/check_tcpa_status")
  ok(!isToolAllowedForTier("skip_trace_property", "lean"), "isToolAllowedForTier: lean CUTS a skip-trace-shaped tool name (generic over any registry, incl. the staff copilot's)")
  ok(!isToolAllowedForTier("anything", "off"), "isToolAllowedForTier: off allows nothing")

  const sampleRegistry = { lookup_property: 1, search_properties_page: 2, comparable_property_preview: 3, skip_trace_property: 4 }
  ok(Object.keys(filterToolsByTier(sampleRegistry, "full")).length === 4, "filterToolsByTier: full is a no-op")
  const leaned = filterToolsByTier(sampleRegistry, "lean")
  ok("lookup_property" in leaned && "comparable_property_preview" in leaned && !("search_properties_page" in leaned) && !("skip_trace_property" in leaned),
     "filterToolsByTier: lean keeps lookup_property/comparable_property_preview, cuts search_properties_page/skip_trace_property")
  ok(Object.keys(filterToolsByTier(sampleRegistry, "off")).length === 0, "filterToolsByTier: off returns {}")

  // evaluateEffectiveBatchDataTier — the PURE auto-downgrade rule
  ok(evaluateEffectiveBatchDataTier("full", 0, 50_000) === "full", "evaluateEffectiveBatchDataTier: full stays full when spend is well under the cap (POSITIVE CONTROL — a healthy ledger does not downgrade)")
  ok(evaluateEffectiveBatchDataTier("full", 50_000, 50_000) === "lean", "evaluateEffectiveBatchDataTier: full → lean once spend REACHES the cap")
  ok(evaluateEffectiveBatchDataTier("full", 99_999, 50_000) === "lean", "evaluateEffectiveBatchDataTier: full → lean when spend EXCEEDS the cap")
  ok(evaluateEffectiveBatchDataTier("lean", 99_999, 50_000) === "lean", "evaluateEffectiveBatchDataTier: lean stays lean over the cap (never auto-drops to off)")
  ok(evaluateEffectiveBatchDataTier("off", 0, 50_000) === "off", "evaluateEffectiveBatchDataTier: an explicit off is never overridden by a healthy ledger")
  ok(evaluateEffectiveBatchDataTier("off", 99_999, 50_000) === "off", "evaluateEffectiveBatchDataTier: an explicit off is never overridden by an over-cap ledger either")

  // resolveEffectiveBatchDataToolTier — composed I/O wrapper, INJECTED reader (no network)
  delete process.env.BATCHDATA_TOOL_TIER
  delete process.env.BATCHDATA_TOOL_MONTHLY_CAP_CENTS
  const healthyTier = await resolveEffectiveBatchDataToolTier({ readSpendCents: async () => 100 })
  ok(healthyTier === "lean", "resolveEffectiveBatchDataToolTier: default configured tier is \"lean\" regardless of spend (documented default)")
  process.env.BATCHDATA_TOOL_TIER = "full"
  const overCapTier = await resolveEffectiveBatchDataToolTier({ readSpendCents: async () => 50_000 })
  ok(overCapTier === "lean", "MONTHLY CAP TRIPS TO LEAN: configured \"full\" + injected spend AT the $500 default cap → effective tier is \"lean\"")
  const underCapTier = await resolveEffectiveBatchDataToolTier({ readSpendCents: async () => 100 })
  ok(underCapTier === "full", "POSITIVE CONTROL: configured \"full\" + injected spend well under the cap → effective tier stays \"full\" (the downgrade is not unconditional)")
  process.env.BATCHDATA_TOOL_TIER = "off"
  const offNeverReadsSpend = await resolveEffectiveBatchDataToolTier({ readSpendCents: async () => { throw new Error("must not be called when configured tier is off") } })
  ok(offNeverReadsSpend === "off", "resolveEffectiveBatchDataToolTier: configured \"off\" short-circuits before even reading spend")
  delete process.env.BATCHDATA_TOOL_TIER

  // The composed function feeding INTO batchDataIsaTools's own registry — an ACTUAL
  // registry build under a "lean"-forcing spend, proving the tier reaches the tool map
  // batchDataIsaTools returns, not just the standalone pure functions above.
  process.env.BATCHDATA_API_KEY = "test-fake-key-never-used-for-a-real-call"
  process.env.BATCHDATA_TOOL_TIER = "off"
  // Lane 79B: sphere (outbound-eligible) is now the ONLY persona with a non-empty allowlist.
  const offTierTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "sphere", conversationKey: "conv-tier-off", outboundEligible: true })
  ok(Object.keys(offTierTools).length === 0, "batchDataIsaTools: \"off\" tier returns ZERO tools even for the outbound-eligible sphere persona, the one persona with a non-empty allowlist")
  process.env.BATCHDATA_TOOL_TIER = "lean"
  const leanTierTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "sphere", conversationKey: "conv-tier-lean", outboundEligible: true })
  ok(Object.keys(leanTierTools).sort().join(",") === "check_dnc_status,check_tcpa_status,verify_phone", "POSITIVE CONTROL: the documented default \"lean\" tier still mounts the three DNC-purpose tools for an outbound-eligible sphere contact")
  delete process.env.BATCHDATA_TOOL_TIER
}

// ─── 7. resolveToolPersona — the ONE vocabulary-derivation function ───────────────────────
{
  ok(resolveToolPersona({ contactPersona: "investor" }) === "investor", "resolveToolPersona: contact_persona 'investor' wins")
  ok(resolveToolPersona({ contactPersona: "investor", contactType: "seller" }) === "investor", "resolveToolPersona: 'investor' persona wins even over contact_type 'seller' (m589's own priority)")
  ok(resolveToolPersona({ contactPersona: "relocated" }) === "relocation", "resolveToolPersona: contact_persona 'relocated' → relocation")
  ok(resolveToolPersona({ homeOwnerStatus: "renter" }) === "renter", "resolveToolPersona: home_owner_status 'renter' → renter")
  ok(resolveToolPersona({ contactType: "seller" }) === "seller", "resolveToolPersona: contact_type 'seller' → seller")
  ok(resolveToolPersona({ contactType: "sphere" }) === "sphere", "resolveToolPersona: contact_type 'sphere' → sphere")
  ok(resolveToolPersona({ contactType: "referral_partner" }) === "sphere", "resolveToolPersona: contact_type 'referral_partner' → sphere")
  ok(resolveToolPersona({ contactType: "lifetime_customer" }) === "sphere", "resolveToolPersona: contact_type 'lifetime_customer' → sphere (wave 47's own CLOSED→sphere_of_influence ruling)")
  ok(resolveToolPersona({ contactType: "buyer" }) === "buyer", "resolveToolPersona: contact_type 'buyer' → buyer")
  ok(resolveToolPersona({ contactType: "vendor" }) === "sphere", "resolveToolPersona: contact_type 'vendor' → sphere (lane 77A — a CRM record about a vendor is a business relationship; never the buyer default, never a persona of its own)")
  ok(resolveToolPersona({}) === "buyer", "resolveToolPersona: an unknown/empty row defaults to buyer (same posture as lib/campaigns/contact-sources.ts)")
  ok(resolveToolPersona({ contactType: "both" }) === "buyer", "resolveToolPersona: contact_type 'both' falls to the buyer default")
  ok(resolveToolPersona({ contactType: "SELLER" }) === "seller", "resolveToolPersona: case-insensitive on contact_type")
}

// ─── 8. Call sites reference the new module — STRIPPED source (blankComments) ─────────────
{
  const inboundEmail = readBlanked("app/actions/ai-isa/handle-inbound-email.ts")
  ok(/import\s*\{\s*batchDataIsaTools\s*\}\s*from\s*['"]@\/lib\/ai-isa\/batchdata-isa-tools['"]/.test(inboundEmail),
     "app/actions/ai-isa/handle-inbound-email.ts: imports batchDataIsaTools (the ISA's real generateText call site)")
  ok(/import\s*\{\s*resolveToolPersona/.test(inboundEmail),
     "app/actions/ai-isa/handle-inbound-email.ts: imports resolveToolPersona (lane 73B)")
  ok(/persona:\s*toolPersona/.test(inboundEmail), "app/actions/ai-isa/handle-inbound-email.ts: builds the tools with the DERIVED persona, not a literal")
  // Lane 74B: the free/batchData/rentCast spread now routes through
  // selectToolsForPersona (cost-ranked order + need-based BatchData drop —
  // persona-tool-policy.ts) before it reaches generateText, so the LITERAL
  // 4-way spread this assertion used to pin no longer appears verbatim.
  // Re-anchored on the two real facts: the SAME three registries feed the
  // ONE selector call, and the selector's result is what generateText's
  // tools: actually receives (never a rival merge).
  ok(/selectToolsForPersona\(\{\s*\.\.\.freeTools,\s*\.\.\.batchDataTools,\s*\.\.\.rentCastTools\s*\}\)/.test(inboundEmail),
     "app/actions/ai-isa/handle-inbound-email.ts: free + batchData + rentCast tools flow through the ONE cost-ranked selector (lane 74B)")
  ok(/tools:\s*\{\s*\.\.\.isaTools,\s*\.\.\.propertyAndFreeTools\s*\}/.test(inboundEmail),
     "app/actions/ai-isa/handle-inbound-email.ts: generateText receives the CRM tools + the selector's cost-ranked output, not a hand-merged map")

  const customLlm = readBlanked("app/api/did/custom-llm/route.ts")
  ok(/import\s*\{\s*resolveToolPersona/.test(customLlm), "app/api/did/custom-llm/route.ts: imports resolveToolPersona (lane 73B)")
  ok(/const toolPersona = resolveToolPersona\(/.test(customLlm), "app/api/did/custom-llm/route.ts: derives persona via resolveToolPersona from the resolved contact's context, never a request body")
  // Lane 74B: same cost-ranked selector re-anchor as the inbound-email check above.
  ok(/tools:\s*selectToolsForPersona\(\{\s*\.\.\.freeTools,\s*\.\.\.batchDataTools,\s*\.\.\.rentCastTools\s*\}\)/.test(customLlm),
     "app/api/did/custom-llm/route.ts: passes free + batchData + rentCast tools through the cost-ranked selector into streamTextRouted (lane 74B)")

  // POSITIVE CONTROL for the stripped-source read itself — a comment-only mention must NOT
  // count. blankComments should have erased this fixture's // line, so the regex below finds
  // nothing in it (proves blankComments is actually running, not a no-op).
  const commentOnlyFixture = blankComments(`// import { batchDataIsaTools } from "@/lib/ai-isa/batchdata-isa-tools"\nexport const x = 1`)
  ok(!/import\s*\{\s*batchDataIsaTools\s*\}/.test(commentOnlyFixture),
     "positive control: blankComments erases a comment-only import mention, so it cannot count as a live wire")
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
