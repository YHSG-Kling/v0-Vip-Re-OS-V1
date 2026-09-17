#!/usr/bin/env tsx
/**
 * scripts/batchdata-isa-tools-simulator.ts   (npm run test:batchdata-isa-tools)
 *
 * Proves the wave-71 BatchData ISA/investor tool set — lib/ai-isa/batchdata-isa-tools.ts —
 * WITHOUT spending real API budget, real LLM tokens, or making a single real network call:
 *
 *   [1] Fail closed: no tools when BatchData's MCP token is unresolvable (the SAME
 *       resolver lib/external/batchdata-mcp.ts itself uses — resolveBatchDataToken("mcp"),
 *       never a second invented env var), and no tools for a tenant-less/conversation-less ctx.
 *   [2] Persona sets: the "investor" persona's registry carries NO skip-trace/owner-contact
 *       tool (lookup_property, verify_address, verify_phone, check_dnc_status,
 *       check_tcpa_status are ISA-only; skip_trace_property/reverse_skip_trace never appear
 *       in EITHER registry — the capability does not exist to gate). The "isa" persona
 *       carries no `_page` tool at all (it qualifies one lead's own property context, never
 *       bulk-walks a market). Only "investor" gets search_properties_page.
 *   [3] Page-before-count/preview ordering — tested TWO ways: (a) the PURE decision core
 *       (evaluatePageOrder) proves "seen → allowed" without any I/O; (b) an ACTUAL tool
 *       execute() call proves "never seen → refused before any network attempt" (the
 *       refusal check runs before callBatchDataMcp is ever reached).
 *   [4] Budget refusal — same two-track proof: the PURE decision core (evaluateBudget) plus
 *       an ACTUAL tool execute() call with BATCHDATA_ISA_BUDGET_CENTS set below one call's
 *       cost, proving the refusal fires before any network attempt.
 *   [5] Owner/equity/contact fields are stripped from every investor-persona tool result
 *       (toInvestorFacingToolRow, an ALLOWLIST) — POSITIVE CONTROL: the SAME fixture row
 *       read through the "isa" persona's mapper (toIsaFacingToolRow, the identity function)
 *       still carries them, so the investor test cannot be passing on a mapper that strips
 *       nothing for anyone.
 *   [6] The conversation handler's real call site (app/actions/ai-isa/handle-inbound-email.ts
 *       — lib/ai-isa/conversation-handler.ts itself is a helper-function module with no
 *       generateText/tools call of its own, see its own header) and app/api/did/custom-llm
 *       both reference the new module, read from STRIPPED source (CLAUDE.md §2 —
 *       blankComments, so a comment naming the module never counts as a live import).
 *
 * NO LIVE BATCHDATA CALLS ANYWHERE IN THIS FILE. Every tool this file executes is one whose
 * OWN refusal path (fail-closed unconfigured, budget exceeded, or ordering violated) fires
 * before callBatchDataMcp/comparablePropertyPreview/etc. ever runs — never a stubbed fetch,
 * because there is nothing for this file to reach past the refusal to call.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankComments } from "./strip-comments"
import {
  batchDataIsaTools,
  evaluateBudget,
  evaluatePageOrder,
  resolveBatchDataIsaBudgetCents,
  toInvestorFacingToolRow,
  toIsaFacingToolRow,
  criteriaKey,
} from "../lib/ai-isa/batchdata-isa-tools"
import type { BuyBoxMatchRow } from "../lib/external/batchdata-mcp"

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

const root = process.cwd()
const read = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const readBlanked = (rel: string) => blankComments(readFileSync(join(root, rel), "utf8"))

function clearBatchDataEnv() {
  delete process.env.BATCHDATA_MCP_URL
  delete process.env.BATCHDATA_MCP_AUTH
  delete process.env.BATCHDATA_API_KEY
  delete process.env.BATCHDATA_ISA_BUDGET_CENTS
}

// ─── 1. Fail closed — no token, no tenant, no conversation key ───────────────────────────
{
  clearBatchDataEnv()
  const isaEmpty = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "isa", conversationKey: "conv-1" })
  ok(Object.keys(isaEmpty).length === 0, "no tools (isa persona) when BATCHDATA_MCP_AUTH/BATCHDATA_API_KEY are both unset")
  const investorEmpty = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "investor", conversationKey: "conv-2" })
  ok(Object.keys(investorEmpty).length === 0, "no tools (investor persona) when BatchData's MCP token is unresolvable")

  process.env.BATCHDATA_API_KEY = "test-fake-key-never-used-for-a-real-call"
  const noBrokerage = await batchDataIsaTools({ brokerageId: "", persona: "isa", conversationKey: "conv-3" })
  ok(Object.keys(noBrokerage).length === 0, "§4: refuses a tenant-less call even with a token present")
  const noConvKey = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "isa", conversationKey: "" })
  ok(Object.keys(noConvKey).length === 0, "refuses a conversation-less call even with a token present (ordering/budget state needs a key)")
}

// ─── 2. Persona sets ───────────────────────────────────────────────────────────────────────
let isaTools: Record<string, unknown> = {}
let investorTools: Record<string, unknown> = {}
{
  process.env.BATCHDATA_API_KEY = "test-fake-key-never-used-for-a-real-call"
  isaTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "isa", conversationKey: "conv-isa-1", contactId: "contact-1" })
  investorTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "investor", conversationKey: "conv-investor-1" })

  const ISA_EXPECTED = [
    "lookup_property", "search_properties_preview", "search_properties_count",
    "verify_address", "verify_phone", "check_dnc_status", "check_tcpa_status",
    "comparable_property_preview", "comparable_property_count",
  ]
  for (const name of ISA_EXPECTED) ok(name in isaTools, `isa persona: has ${name}`)
  ok(Object.keys(isaTools).length === ISA_EXPECTED.length, `isa persona: exactly ${ISA_EXPECTED.length} tools (found ${Object.keys(isaTools).length}: ${Object.keys(isaTools).sort().join(", ")})`)

  const INVESTOR_EXPECTED = [
    "search_properties_preview", "search_properties_count", "search_properties_page",
    "comparable_property_preview", "comparable_property_count",
    "investor_buybox_preview", "investor_buybox_count",
  ]
  for (const name of INVESTOR_EXPECTED) ok(name in investorTools, `investor persona: has ${name}`)
  ok(Object.keys(investorTools).length === INVESTOR_EXPECTED.length, `investor persona: exactly ${INVESTOR_EXPECTED.length} tools (found ${Object.keys(investorTools).length}: ${Object.keys(investorTools).sort().join(", ")})`)

  // THE RULING (wave 68/69): investor NEVER gets skip-trace or owner-contact tools.
  const FORBIDDEN_FOR_INVESTOR = [
    "skip_trace_property", "reverse_skip_trace", "lookup_property",
    "verify_address", "verify_phone", "check_dnc_status", "check_tcpa_status",
  ]
  for (const name of FORBIDDEN_FOR_INVESTOR) ok(!(name in investorTools), `investor persona: does NOT have ${name}`)
  // And the isa persona doesn't get the bulk-pull `page` tools either — it qualifies one
  // lead's own context, it never bulk-walks a market.
  ok(!("search_properties_page" in isaTools), "isa persona: does NOT have search_properties_page (no page tool for this persona at all)")
  ok(!("investor_buybox_preview" in isaTools) && !("investor_buybox_count" in isaTools), "isa persona: does NOT have investor_buybox_* (investor-only)")
}

// ─── 3. Page-before-preview/count ordering ─────────────────────────────────────────────────
{
  // (a) PURE decision core
  const criteria = { address: "123 Main St", city: "Austin", state: "TX", zip: "78701" }
  const neverSeen = evaluatePageOrder(new Set(), "search_properties", criteria)
  ok(neverSeen !== null && neverSeen.success === false, "evaluatePageOrder: refuses when criteria never previewed/counted")
  const alreadySeen = evaluatePageOrder(new Set([`search_properties:${criteriaKey(criteria)}`]), "search_properties", criteria)
  ok(alreadySeen === null, "evaluatePageOrder: allows once the SAME criteria was previewed/counted")
  const differentCriteria = evaluatePageOrder(new Set([`search_properties:${criteriaKey(criteria)}`]), "search_properties", { ...criteria, zip: "78702" })
  ok(differentCriteria !== null, "evaluatePageOrder: a DIFFERENT zip is a different criteria — still refused")
  // Case-insensitivity
  const caseVariant = evaluatePageOrder(new Set([`search_properties:${criteriaKey(criteria)}`]), "search_properties", { ...criteria, city: "AUSTIN" })
  ok(caseVariant === null, "evaluatePageOrder: criteria matching is case-insensitive")

  // (b) ACTUAL tool call — never-seen criteria, investor persona, fresh conversation.
  // NO NETWORK ATTEMPT: the ordering refusal returns before callBatchDataMcp is reached.
  const pageTool = investorTools.search_properties_page as { execute: (args: any) => Promise<any> } | undefined
  ok(!!pageTool, "investor persona exposes search_properties_page to call")
  if (pageTool) {
    const result = await pageTool.execute({ address: "999 Never Previewed Ave", city: null, state: null, zip: null, take: null, skip: null })
    ok(result.success === false, "search_properties_page.execute: refused for a criteria never previewed/counted this conversation")
    ok(typeof result.error === "string" && /preview|count/i.test(result.error), "search_properties_page.execute: refusal names the missing preview/count step")
  }
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

  const underBudget = evaluateBudget(0, 200, 0.05)
  ok(underBudget === null, "evaluateBudget: allows a call that fits inside the budget")
  const overBudget = evaluateBudget(199, 200, 0.05)
  ok(overBudget !== null && overBudget.success === false, "evaluateBudget: refuses a call that would push spend over the budget")
  ok(/\$1\.99 of \$2\.00/.test(overBudget?.error ?? ""), "evaluateBudget: refusal message names the actual spent/budget figures")

  // (b) ACTUAL tool call — budget set to 1¢, verify_phone costs 5¢ (MCP_TOOL_CALL_COST_USD).
  // NO NETWORK ATTEMPT: budgetRefusal is checked FIRST in every execute(), before
  // toTenDigits/mcpVerifyPhone are ever reached.
  process.env.BATCHDATA_API_KEY = "test-fake-key-never-used-for-a-real-call"
  process.env.BATCHDATA_ISA_BUDGET_CENTS = "1"
  const budgetIsaTools = await batchDataIsaTools({ brokerageId: "brokerage-1", persona: "isa", conversationKey: "conv-budget-1" })
  const verifyPhoneTool = budgetIsaTools.verify_phone as { execute: (args: any) => Promise<any> } | undefined
  ok(!!verifyPhoneTool, "isa persona exposes verify_phone to call")
  if (verifyPhoneTool) {
    const result = await verifyPhoneTool.execute({ phone: "5125551234" })
    ok(result.success === false, "verify_phone.execute: refused when the conversation's $0.01 budget can't cover a $0.05 call")
    ok(/budget/i.test(result.error ?? ""), "verify_phone.execute: refusal names the budget, not a network/config error")
  }
  delete process.env.BATCHDATA_ISA_BUDGET_CENTS
}

// ─── 5. Investor redaction — owner/equity/contact fields stripped; ISA keeps them ─────────
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
     "toInvestorFacingToolRow: no owner/equity/contact key survives on the investor-facing row")
  ok(investorRow.address === "456 Off Market Ln" && investorRow.city === "Round Rock" && investorRow.estimatedValue === 341000 && investorRow.beds === 3 && investorRow.baths === 2 && investorRow.propertyType === "Single Family",
     "toInvestorFacingToolRow: property fields (address/city/estimatedValue/beds/baths/propertyType) DO survive")
  ok(investorRow.likelihoodBand === "medium" && investorRow.likelihoodBandSource === "signal-based",
     `toInvestorFacingToolRow: likelihoodBand derived from quicklists via deriveLikelihoodBand (tired-landlord → medium); got ${investorRow.likelihoodBand}/${investorRow.likelihoodBandSource}`)

  // POSITIVE CONTROL — the SAME fixture read through the isa (identity) mapper still carries
  // every owner/equity field, proving the investor test above isn't passing because nothing
  // strips anything for anyone.
  const isaRow = toIsaFacingToolRow(fixture) as any
  ok(isaRow.owner_name === "Jane Landlord" && isaRow.owner_phone === "5125559876" && isaRow.owner_email === "jane@example.com" && isaRow.equity_percent === 62,
     "positive control: toIsaFacingToolRow (identity) KEEPS owner_name/owner_phone/owner_email/equity_percent on the SAME fixture row")
}

// ─── 6. Call sites reference the new module — STRIPPED source (blankComments) ─────────────
{
  const inboundEmail = readBlanked("app/actions/ai-isa/handle-inbound-email.ts")
  ok(/import\s*\{\s*batchDataIsaTools\s*\}\s*from\s*['"]@\/lib\/ai-isa\/batchdata-isa-tools['"]/.test(inboundEmail),
     "app/actions/ai-isa/handle-inbound-email.ts: imports batchDataIsaTools (the ISA's real generateText call site — lib/ai-isa/conversation-handler.ts is a helper-function module with no tool-calling generateText/streamText of its own, see its own header comment)")
  ok(/persona:\s*['"]isa['"]/.test(inboundEmail), "app/actions/ai-isa/handle-inbound-email.ts: builds the tools with persona: \"isa\"")
  ok(/\.\.\.isaTools,\s*\.\.\.batchDataTools/.test(inboundEmail), "app/actions/ai-isa/handle-inbound-email.ts: spreads batchDataTools into the SAME tools object generateText receives")

  const customLlm = readBlanked("app/api/did/custom-llm/route.ts")
  ok(/import\s*\{\s*batchDataIsaTools\s*\}\s*from\s*["']@\/lib\/ai-isa\/batchdata-isa-tools["']/.test(customLlm),
     "app/api/did/custom-llm/route.ts: imports batchDataIsaTools")
  ok(/contactPersona\s*===\s*["']investor["']\s*\?\s*["']investor["']\s*:\s*["']isa["']/.test(customLlm),
     "app/api/did/custom-llm/route.ts: derives persona from the resolved contact's contact_persona — investor portal contacts get \"investor\", everyone else gets \"isa\"")
  ok(/tools:\s*batchDataTools/.test(customLlm), "app/api/did/custom-llm/route.ts: passes the built tools into streamTextRouted")

  // POSITIVE CONTROL for the stripped-source read itself — a comment-only mention must NOT
  // count. blankComments should have erased this fixture's // line, so the regex below finds
  // nothing in it (proves blankComments is actually running, not a no-op).
  const commentOnlyFixture = blankComments(`// import { batchDataIsaTools } from "@/lib/ai-isa/batchdata-isa-tools"\nexport const x = 1`)
  ok(!/import\s*\{\s*batchDataIsaTools\s*\}/.test(commentOnlyFixture),
     "positive control: blankComments erases a comment-only import mention, so it cannot count as a live wire")
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
