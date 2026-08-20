#!/usr/bin/env tsx
/**
 * scripts/ai-tools-hub-tenanted-spend-simulator.ts
 *   (tsx scripts/ai-tools-hub-tenanted-spend-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHOSE BILL IT IS, WHICH MODEL SERVED IT, AND WHETHER THE TOOL WAS EVEN GIVEN
 * THE FIELDS ITS OWN FORM COLLECTS.
 *
 * Wave 12 made app/actions/ai-tools-hub.ts stop INVENTING token figures: a
 * `ToolTokens` union with no arm that lets a tool name a number of its own. It
 * also handed back four findings that the union made visible but did not close.
 * This proof stands over those four.
 *
 *   F1  FOUR TOOLS SPENT TOKENS NOBODY BOOKED. explainTerm, compareProperties,
 *       runAffordabilityTool and researchNeighborhood called generateTextRouted
 *       with no identity at all. generateTextRouted calls logAIUsage only when
 *       it is handed a brokerageId, so their spend landed on NO ai_tool_usage
 *       row anywhere — absent from meter_readings.ai_tokens, from the per-tier
 *       overage projection, from every cost roll-up. And checkAIFairUse reads a
 *       missing brokerageId as "background job → uncapped", so the same four
 *       buttons also spent the tenant's included AI allowance without being
 *       counted against it. Unbilled AND uncapped.
 *
 *       CLOSED BY GIVING THEM THE SESSION'S TENANT — and then the ledger has to
 *       decide who books the figure, because two rows for one call would make
 *       the brokerage's meter read double. The rule proved below: with a tenant
 *       the routed lane ledgers and this hub books 0; with no tenant nothing
 *       else ledgered and this hub books the measured counts itself. Exactly
 *       one row carries the spend, either way.
 *
 *   F2  model_used WAS THE PINNED MODEL, NOT THE SERVED ONE. The hub decided
 *       what to write in a billing record by comparing the SURVIVOR'S NAME to a
 *       string — `lane === "generateSocialPostContent" ? "claude-sonnet" :
 *       "gpt-4o-mini"` — and stamped "claude-sonnet" on every Smart Reply row
 *       even though that lane routes with a gpt-4o FALLBACK that serves
 *       whenever the primary throws. The tokens were real; the label was an
 *       assertion about another file. It is not cosmetic: cost_cents is priced
 *       off the label, and claude-sonnet bills $3/$15 per 1M against gpt-4o's
 *       $2.50/$10 and gpt-4o-mini's $0.15/$0.60 — a 20x spread on the same
 *       counts, on rows the overage projection is derived from.
 *
 *       CLOSED by carrying the SERVED model out of the two model boundaries
 *       that had it and dropped it (lib/ai/generate.ts's generateObject shim,
 *       lib/inbox/smart-replies.ts over generateObjectRouted's RoutedUsage).
 *       A lane that reports counts it CANNOT attribute books zero rather than
 *       being priced against a guess — m508 refuses a row that claims tokens
 *       without naming the model that produced them.
 *
 *   F3  TOOLS WERE HANDED `undefined`. The dispatch read `params.address` while
 *       the Neighborhood Research card renders neighborhood/city/state, so that
 *       tool analysed the string "undefined" on every run since it shipped —
 *       and paid for the answer. The same defect was sitting on a SECOND tool
 *       nobody had named: Explain This renders one input called `concept` and
 *       the dispatch read `params.term`.
 *
 *   F4  A BARE OBJECT INTO A `Record<string, string>`. Fixed in wave 12 at the
 *       dispatch boundary; VERIFIED here rather than redone — every tool that
 *       produces a structure is asserted to reach the panel as text.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 *   BEHAVIOUR — the REAL `executeAITool` runs. Only the lane's EDGES are
 *   stubbed (Supabase, the routed model call, the compliance gate, the session,
 *   each survivor) through globalThis, so what is asserted is THE ROW THE
 *   PRODUCTION FUNCTION WRITES TO ai_tool_usage and THE REQUEST IT HANDED THE
 *   ROUTING LAYER — not what the source looks like.
 *
 *   UNIT — modelIdentityFor is imported from the REAL lib/ai/models.ts (by file
 *   URL, so the specifier stub does not shadow it) and exercised directly,
 *   including the case it must refuse: two AIModel names sharing one gateway
 *   model id.
 *
 *   CONSTRUCT — the handful of facts behaviour cannot see: that
 *   generateTextRouted ledgers exactly when it is given a tenant, that
 *   checkAIFairUse is uncapped without one, and that the two model boundaries
 *   report the model they called instead of one named locally.
 *
 * ── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
 * Each control writes one defect class back into the real file and re-runs the
 * WHOLE proof IN A CHILD PROCESS. The patch is verified to have applied, the
 * child is required to EXIT NON-ZERO, and the file is restored and re-verified
 * by sha256.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { registerHooks } from "node:module"
import { spawnSync } from "node:child_process"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const CHILD = process.env.AITH_TENANT_SIM_CHILD === "1"
const ASSERT_ONLY = CHILD || process.argv.includes("--assert-only")

const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")
/** Comment-stripped source. LOAD-BEARING: these files quote the defects they
 *  fixed in their own headers, so a raw-source scan would accuse the fix. */
const code = (p: string) => stripComments(raw(p))

const F = {
  hub: "app/actions/ai-tools-hub.ts",
  models: "lib/ai/models.ts",
  generate: "lib/ai/generate.ts",
  smart: "lib/inbox/smart-replies.ts",
  fairUse: "lib/ai/fair-use.ts",
  client: "app/dashboard/ai-tools/ai-tools-client.tsx",
}

let pass = 0
const failures: string[] = []
const findings: string[] = []
function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
  return ok
}
function finding(name: string, detail: string): void {
  findings.push(`${name} — ${detail}`)
  console.log(`  ⚠ FINDING ${name}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE INTERCEPTION — so the REAL executeAITool runs
// ─────────────────────────────────────────────────────────────────────────────
const STUBS: Record<string, string> = {
  // ── the hub's own edges ──────────────────────────────────────────────────
  "@/lib/supabase/server":
    "export const createClient = (...a) => globalThis.__AITT.createClient(...a)",
  "@/lib/supabase/service":
    "export const createServiceClient = (...a) => globalThis.__AITT.createClient(...a)",
  "@/lib/ai/models":
    "export const generateTextRouted = (...a) => globalThis.__AITT.generateTextRouted(...a)",
  "@/lib/ai/cost-tracking":
    "export const calculateCost = (...a) => globalThis.__AITT.calculateCost(...a)",
  "@/lib/identity/get-agent-context":
    "export const getAgentContext = (...a) => globalThis.__AITT.getAgentContext(...a)",
  "@/lib/kernel/compliance":
    "export const evaluateOutbound = (...a) => globalThis.__AITT.evaluateOutbound(...a)",
  "@/app/actions/ai-content-generation":
    "export const generateListingDescription = (...a) => globalThis.__AITT.generateListingDescription(...a)",
  "@/app/actions/social/generate-social-post":
    "export const generateContextualDraft = (...a) => globalThis.__AITT.generateContextualDraft(...a);" +
    "export const generateSocialPostContent = (...a) => globalThis.__AITT.generateSocialPostContent(...a)",
  "@/lib/inbox/smart-replies":
    "export const generateSmartReplies = (...a) => globalThis.__AITT.generateSmartReplies(...a)",
  "@/lib/kernel/reporting":
    "export const generateTeamPerformanceReport = (...a) => globalThis.__AITT.generateTeamPerformanceReport(...a)",
  "@/app/actions/ai-predictions":
    "export const predictMarketShift = (...a) => globalThis.__AITT.predictMarketShift(...a)",
  "@/lib/offers/closing-cost-accuracy":
    "export const parseMoney = (v) => globalThis.__AITT.parseMoney(v)",
  "@/app/actions/calculators":
    "export const calculateAffordability = (...a) => globalThis.__AITT.calculateAffordability(...a)",
  // ── what the REAL lib/ai/models.ts needs, for the modelIdentityFor unit ──
  // resolve-model is deliberately NOT stubbed: alias resolution is part of what
  // modelIdentityFor is being asked to get right.
  "@/lib/compliance-rules": "export const evaluateContentCompliance = async () => ({ compliance_status: 'pass' })",
  "@/lib/them-first": "export const validateThemFirstContent = async () => ({ passed: true, score: 1 })",
  "@/lib/kernel/ai-model": "export const resolveAIModel = async () => 'claude-sonnet'",
  "@/lib/usage/check-cap": "export const checkUsageCap = async () => ({ allowed: true, used: 0, limit: -1 })",
}

registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true }
    const stub = STUBS[spec]
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// THE WORLD each scenario configures
// ─────────────────────────────────────────────────────────────────────────────
interface LedgerRow {
  brokerage_id: string | null
  user_id: string
  agent_id: string | null
  tool_name: string
  success: boolean
  tokens_used: number
  model_used: string | null
  cost_cents: number
  output_text: string
  feature: string | null
}

/** Exactly what the hub handed the routing layer. The whole of F1 lives here:
 *  generateTextRouted ledgers and caps on the identity in this object. */
interface RoutedCall {
  feature?: string
  prompt?: string
  userId?: string
  brokerageId?: string | null
  agentId?: string
}

interface World {
  ctx: any
  routed: RoutedCall[]
  /** What the stubbed provider reports for a call the hub makes itself. */
  routedUsage: { inputTokens: number; outputTokens: number; totalTokens: number; model: string }
  routedText: string
  /** Set to make the routed lane refuse the way a tripped fair-use cap does. */
  routedThrows: string | null
  gate: { allowed: boolean; violations: string[] }
  saved: any[]
  smart: any
  social: any
  draft: any
  ledger: LedgerRow[]
}

let W: World

const SESSION_USER = "11111111-1111-1111-1111-111111111111"
const SESSION_AGENT = "22222222-2222-2222-2222-222222222222"
const SESSION_BROKERAGE = "33333333-3333-3333-3333-333333333333"
/** What a browser might claim it is. Nothing may ever be billed to this. */
const BROWSER_CLAIMED_USER = "99999999-9999-9999-9999-999999999999"

function newWorld(over: Partial<World> = {}): World {
  return {
    ctx: {
      isAuthenticated: true,
      userId: SESSION_USER,
      agentId: SESSION_AGENT,
      brokerageId: SESSION_BROKERAGE,
      teamId: null,
      userType: "agent",
      role: "agent",
    },
    routed: [],
    routedUsage: { inputTokens: 640, outputTokens: 210, totalTokens: 850, model: "perplexity-sonar-pro" },
    routedText: "Schools, walkability and the last twelve months of inventory, read off live sources.",
    routedThrows: null,
    gate: { allowed: true, violations: [] },
    saved: [],
    smart: {
      replies: [{ intent: "affirm", body: "Yes — Saturday works." }],
      usage: { modelCalled: true, inputTokens: 70, outputTokens: 20, totalTokens: 90, estimated: false, model: "claude-sonnet" },
    },
    social: {
      success: true,
      data: { content: "Your next chapter starts here.", hashtags: ["OakPark"] },
      usage: { inputTokens: 200, outputTokens: 60, totalTokens: 260, estimated: false, model: "claude-sonnet" },
    },
    draft: {
      success: true,
      draft: "Here is what you asked for.",
      usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120, estimated: false, model: "gpt-4o-mini" },
    },
    ledger: [],
    ...over,
  }
}

/** Chainable PostgREST-shaped stub; thenable so `await` anywhere resolves. */
function chain(result: any): any {
  const obj: any = { then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }
  for (const m of [
    "select", "eq", "in", "is", "or", "not", "gte", "lte", "gt", "lt", "order",
    "limit", "range", "textSearch", "maybeSingle", "single", "update", "delete", "upsert",
  ]) obj[m] = () => obj
  return obj
}

/** The REAL pricing, so a wrong model label shows up as a wrong cost. Only the
 *  three models these lanes can serve are needed; anything else is a bug. */
const PRICE: Record<string, { input: number; output: number }> = {
  "claude-sonnet":        { input: 3.0,  output: 15.0 },
  "claude-haiku":         { input: 0.25, output: 1.25 },
  "gpt-4o":               { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":          { input: 0.15, output: 0.6 },
  "perplexity-sonar-pro": { input: 3.0,  output: 15.0 },
}

/** What lib/ai/cost-tracking.ts::calculateCost would charge — cents, rounded up. */
function priceOf(model: string, input: number, output: number): number {
  const p = PRICE[model]
  if (!p) return 0
  return Math.ceil(((input / 1_000_000) * p.input + (output / 1_000_000) * p.output) * 100)
}

;(globalThis as any).__AITT = {
  createClient: async () => ({
    from(table: string) {
      if (table === "ai_tool_usage") {
        return { insert: (row: LedgerRow) => { W.ledger.push(row); return Promise.resolve({ error: null }) } }
      }
      if (table === "saved_properties") return chain({ data: W.saved, error: null })
      return chain({ data: [], error: null })
    },
    auth: { getUser: async () => ({ data: { user: { id: SESSION_USER } } }) },
  }),
  generateTextRouted: async (req: RoutedCall) => {
    W.routed.push(req)
    // A tripped fair-use cap surfaces exactly this way — generateTextRouted
    // throws from its pre-flight, before any provider call.
    if (W.routedThrows) throw new Error(W.routedThrows)
    return { text: W.routedText, usage: W.routedUsage }
  },
  calculateCost: (model: string, i: number, o: number) => priceOf(model, i, o),
  getAgentContext: async () => W.ctx,
  evaluateOutbound: async () => ({ allowed: W.gate.allowed, violations: W.gate.violations }),
  generateListingDescription: async () => ({ success: true, data: { headline: "h", medium_description: "d" } }),
  generateContextualDraft: async () => W.draft,
  generateSocialPostContent: async () => W.social,
  generateSmartReplies: async () => W.smart,
  generateTeamPerformanceReport: async () => ({ success: true, data: { teams: [] } }),
  predictMarketShift: async () => ({ success: true, prediction: {} }),
  parseMoney: (v: any) => (typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, "")) || null),
  calculateAffordability: async () => ({
    maxHomePrice: 480000, downPayment: 50000, loanAmount: 430000,
    monthlyBreakdown: { total: 3300, principal_interest: 2700, property_tax: 400, insurance: 120, pmi: 80, hoa: 0 },
    hiddenCosts: { closing_costs: 14000, maintenance_budget: 400, utilities_estimate: 260 },
    recommendations: [],
  }),
}

type Hub = { executeAITool: (t: string, u: string, ut: string, p: any) => Promise<any> }
let hub: Hub

async function run(
  toolName: string,
  params: any,
  shape: Partial<World> = {},
): Promise<{ res: any; row: LedgerRow | undefined; call: RoutedCall | undefined; world: World }> {
  W = newWorld(shape)
  const res = await hub.executeAITool(toolName, BROWSER_CLAIMED_USER, "buyer", params)
  return { res, row: W.ledger[0], call: W.routed[0], world: W }
}

/** A session with a user but no brokerage — a real state (setup incomplete). */
const NO_TENANT_CTX = {
  isAuthenticated: true, userId: SESSION_USER, agentId: SESSION_AGENT,
  brokerageId: null, teamId: null, userType: "buyer", role: "agent",
}

/** The four tools this finding is about, with the form fields their own card
 *  renders — read off app/dashboard/ai-tools/ai-tools-client.tsx, not invented. */
const EDUCATION_TOOLS: Array<{ tool: string; params: any; lane: string }> = [
  { tool: "explain_this", lane: "explainTerm", params: { concept: "What is a 1031 exchange?" } },
  { tool: "property_comparison", lane: "compareProperties", params: { property1: "123 Main St", property2: "456 Oak Ave", buyerCriteria: "3 bed" } },
  { tool: "affordability_calculator", lane: "runAffordabilityTool", params: { income: "$120,000", debt: "$500", downPayment: "$50,000", rate: "6.5%" } },
  { tool: "neighborhood_research", lane: "researchNeighborhood", params: { neighborhood: "Capitol Hill", city: "Denver", state: "CO" } },
]

// ─────────────────────────────────────────────────────────────────────────────
// 1. F1 — WHOSE BILL IT IS
// ─────────────────────────────────────────────────────────────────────────────
async function tenantLayer(): Promise<void> {
  if (!CHILD) console.log("1. F1 — the four tools that spent tokens nobody booked")

  for (const { tool, params, lane } of EDUCATION_TOOLS) {
    const r = await run(tool, params)

    // THE FIX ITSELF: the routed lane is handed the tenant, which is the only
    // thing that makes logAIUsage fire and checkAIFairUse cap.
    check(`${tool}: the routed call carries the SESSION brokerage (${lane} → logAIUsage fires)`,
      r.call?.brokerageId === SESSION_BROKERAGE, `brokerageId=${String(r.call?.brokerageId)}`)
    check(`${tool}: the routed call carries the SESSION user, not the id the browser sent`,
      r.call?.userId === SESSION_USER, `userId=${String(r.call?.userId)}`)
    check(`${tool}: the routed call carries the SESSION agent`,
      r.call?.agentId === SESSION_AGENT, `agentId=${String(r.call?.agentId)}`)

    // AND THEN EXACTLY ONE ROW CARRIES IT. The routed lane wrote one; this row
    // books 0 rather than putting the same call on the meter twice.
    check(`${tool}: the hub's own row books ZERO — the routed lane already ledgered this call`,
      r.row?.tokens_used === 0, `tokens_used=${r.row?.tokens_used}`)
    check(`${tool}: a row that books nothing names no model and costs nothing`,
      r.row?.model_used === null && r.row?.cost_cents === 0,
      `model_used=${String(r.row?.model_used)} cost_cents=${r.row?.cost_cents}`)
    check(`${tool}: ledgered as a successful run`, r.row?.success === true, `success=${r.row?.success}`)
    check(`${tool}: the row is filed under the SESSION user and brokerage`,
      r.row?.user_id === SESSION_USER && r.row?.brokerage_id === SESSION_BROKERAGE)
    // F4, verified rather than redone: the panel takes a string.
    check(`${tool}: the result reaches the panel as text, never a bare object`,
      typeof r.res?.result === "string" && !r.res.result.includes("[object Object]"),
      typeof r.res?.result)
  }

  // ── NO TENANT ON THE SESSION: nothing else ledgered, so this row must ──────
  const noTenant = await run("neighborhood_research",
    { neighborhood: "Capitol Hill", city: "Denver", state: "CO" }, { ctx: NO_TENANT_CTX })
  check("no brokerage on the session: the routed lane is told so and ledgers nothing",
    noTenant.call?.brokerageId === null, `brokerageId=${String(noTenant.call?.brokerageId)}`)
  check("no brokerage on the session: the hub books the measured counts ITSELF (640+210)",
    noTenant.row?.tokens_used === 850, `tokens_used=${noTenant.row?.tokens_used}`)
  check("no brokerage on the session: the row names the model that served",
    noTenant.row?.model_used === "perplexity-sonar-pro", `model_used=${String(noTenant.row?.model_used)}`)
  check("no brokerage on the session: cost is priced off the booked tokens",
    (noTenant.row?.cost_cents ?? 0) > 0, `cost_cents=${noTenant.row?.cost_cents}`)

  // THE FIGURE FOLLOWS THE PROVIDER. A constant cannot do this.
  const moved = await run("neighborhood_research",
    { neighborhood: "Capitol Hill", city: "Denver", state: "CO" },
    { ctx: NO_TENANT_CTX, routedUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, model: "claude-sonnet" } })
  check("the booked figure MOVES when the provider reports different counts (7+3)",
    moved.row?.tokens_used === 10, `tokens_used=${moved.row?.tokens_used}`)
  check("the booked model MOVES when a different model serves the call",
    moved.row?.model_used === "claude-sonnet", `model_used=${String(moved.row?.model_used)}`)
  // The cost is a function of BOTH — the counts the provider reported and the
  // model that reported them. Priced here with the real per-1M rates rather
  // than compared to a constant.
  check("the booked cost is exactly what that model and those counts price to",
    noTenant.row?.cost_cents === priceOf("perplexity-sonar-pro", 640, 210) &&
      moved.row?.cost_cents === priceOf("claude-sonnet", 7, 3),
    `booked=${noTenant.row?.cost_cents}/${moved.row?.cost_cents} expected=${priceOf("perplexity-sonar-pro", 640, 210)}/${priceOf("claude-sonnet", 7, 3)}`)

  // ── THE CAP CAN NOW REFUSE THESE TOOLS, AND A REFUSAL IS NOT A RUN ────────
  const capped = await run("neighborhood_research",
    { neighborhood: "Capitol Hill", city: "Denver", state: "CO" },
    { routedThrows: "AI fair-use limit reached for this billing period." })
  check("a tripped fair-use cap is ledgered as success=false, not as a run",
    capped.row?.success === false, `success=${capped.row?.success}`)
  check("a tripped fair-use cap books ZERO tokens and no model",
    capped.row?.tokens_used === 0 && capped.row?.model_used === null)
  check("a tripped fair-use cap reaches the caller with its reason",
    capped.res?.success === false && String(capped.res?.error ?? "").includes("fair-use"),
    JSON.stringify(capped.res?.error)?.slice(0, 80))

  // The routing table has a row named after this tool, and it is now ridden.
  const routedFeature = await run("neighborhood_research", { neighborhood: "Capitol Hill", city: "Denver", state: "CO" })
  check("neighborhood_research rides its OWN routing row (the one model with web access)",
    routedFeature.call?.feature === "neighborhood_research", `feature=${String(routedFeature.call?.feature)}`)
  check("the ledger row records the routing key the run actually rode",
    routedFeature.row?.feature === "neighborhood_research", `feature=${String(routedFeature.row?.feature)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. F3 — THE FIELDS THE FORM ACTUALLY COLLECTS
// ─────────────────────────────────────────────────────────────────────────────
async function fieldsLayer(): Promise<void> {
  if (!CHILD) console.log("\n2. F3 — the tools that were handed `undefined`")

  const hood = await run("neighborhood_research", { neighborhood: "Capitol Hill", city: "Denver", state: "CO" })
  check("neighborhood_research: the prompt names the place the FORM collected",
    (hood.call?.prompt ?? "").includes("Capitol Hill, Denver, CO"),
    (hood.call?.prompt ?? "").slice(0, 120))
  check("neighborhood_research: the word `undefined` never reaches the model",
    !(hood.call?.prompt ?? "").includes("undefined"))

  const hoodPartial = await run("neighborhood_research", { city: "Denver", state: "CO" })
  check("neighborhood_research: a partly-filled form researches what was given",
    (hoodPartial.call?.prompt ?? "").includes("Denver, CO") && !(hoodPartial.call?.prompt ?? "").includes("undefined"))

  const hoodBlank = await run("neighborhood_research", {})
  check("neighborhood_research: an empty form REFUSES instead of researching nothing",
    hoodBlank.row?.success === false && hoodBlank.world.routed.length === 0,
    `success=${hoodBlank.row?.success} routedCalls=${hoodBlank.world.routed.length}`)
  check("neighborhood_research: that refusal books zero", hoodBlank.row?.tokens_used === 0)

  const explain = await run("explain_this", { concept: "What is a 1031 exchange?" })
  check("explain_this: the prompt names the concept the FORM collected (`concept`, not `term`)",
    (explain.call?.prompt ?? "").includes("1031 exchange"), (explain.call?.prompt ?? "").slice(0, 120))
  check("explain_this: the word `undefined` never reaches the model",
    !(explain.call?.prompt ?? "").includes("undefined"))
  check("explain_this: no empty `Additional context:` line is sent when the card has no context box",
    !(explain.call?.prompt ?? "").includes("Additional context: undefined"))

  const explainBlank = await run("explain_this", {})
  check("explain_this: an empty form REFUSES instead of explaining nothing",
    explainBlank.row?.success === false && explainBlank.world.routed.length === 0,
    `success=${explainBlank.row?.success} routedCalls=${explainBlank.world.routed.length}`)

  // The affordability tool's unreadable-input path is a refusal, not a run.
  const unreadable = await run("affordability_calculator", { income: "a lot", debt: "", downPayment: "", rate: "" })
  check("affordability_calculator: unreadable inputs REFUSE and call no model",
    unreadable.row?.success === false && unreadable.world.routed.length === 0,
    `success=${unreadable.row?.success} routedCalls=${unreadable.world.routed.length}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. F2 — WHICH MODEL SERVED IT
// ─────────────────────────────────────────────────────────────────────────────
async function servedModelLayer(): Promise<void> {
  if (!CHILD) console.log("\n3. F2 — model_used is the SERVED model, not the pinned one")

  const smartParams = { lastMessage: "Can we see it Saturday?", relationshipType: "active-buyer" }

  const primary = await run("smart_reply", smartParams)
  check("smart_reply: the row names the model the lane says served it (primary)",
    primary.row?.model_used === "claude-sonnet", `model_used=${String(primary.row?.model_used)}`)

  // THE ONE THAT USED TO BE WRONG. smart_reply_generation routes claude-sonnet
  // with a gpt-4o fallback; the hub stamped "claude-sonnet" on both. The counts
  // here are a long inbound thread (the generator carries recentThread), which
  // is where the mislabelling actually costs money — at 70 tokens the two
  // models round to the same cent and the defect is invisible.
  const smartReply = (model: string) => ({
    replies: [{ intent: "affirm", body: "Yes — Saturday works." }],
    usage: { modelCalled: true, inputTokens: 20_000, outputTokens: 400, totalTokens: 20_400, estimated: false, model },
  })
  const longPrimary = await run("smart_reply", smartParams, { smart: smartReply("claude-sonnet") })
  const fellBack = await run("smart_reply", smartParams, { smart: smartReply("gpt-4o") })
  check("smart_reply: when the FALLBACK served, the row names the fallback",
    fellBack.row?.model_used === "gpt-4o", `model_used=${String(fellBack.row?.model_used)}`)
  check("smart_reply: the counts are identical across primary and fallback",
    longPrimary.row?.tokens_used === 20_400 && fellBack.row?.tokens_used === 20_400)
  check("smart_reply: and the COST differs, because the label prices the tokens",
    (longPrimary.row?.cost_cents ?? 0) !== (fellBack.row?.cost_cents ?? 0),
    `primary=${longPrimary.row?.cost_cents} fallback=${fellBack.row?.cost_cents}`)
  check("smart_reply: each cost is exactly what its own model prices those counts at",
    longPrimary.row?.cost_cents === priceOf("claude-sonnet", 20_000, 400) &&
      fellBack.row?.cost_cents === priceOf("gpt-4o", 20_000, 400))

  // A lane that reports counts it cannot attribute books ZERO — m508 refuses a
  // row that claims tokens with no model, and inventing one to satisfy it is
  // the defect this whole file exists to stop.
  const unattributed = await run("smart_reply", smartParams, {
    smart: {
      replies: [{ intent: "affirm", body: "Yes — Saturday works." }],
      usage: { modelCalled: true, inputTokens: 70, outputTokens: 20, totalTokens: 90, estimated: false, model: null },
    },
  })
  check("smart_reply: counts with no model to name book ZERO rather than a guessed label",
    unattributed.row?.tokens_used === 0 && unattributed.row?.model_used === null,
    `tokens_used=${unattributed.row?.tokens_used} model_used=${String(unattributed.row?.model_used)}`)

  // social_post and email_composer ride the generateObject shim, which has no
  // fallback — so the label is right today either way. What changed is WHERE it
  // comes from: the lane's report, not a comparison against the lane's name.
  const social = await run("social_post", { platform: "instagram", context: "4 bed in Oak Park" })
  check("social_post: the row names the model the survivor reports",
    social.row?.model_used === "claude-sonnet", `model_used=${String(social.row?.model_used)}`)
  const socialRepinned = await run("social_post", { platform: "instagram", context: "4 bed in Oak Park" }, {
    social: {
      success: true, data: { content: "c", hashtags: [] },
      usage: { inputTokens: 200, outputTokens: 60, totalTokens: 260, estimated: false, model: "gpt-4o" },
    },
  })
  check("social_post: re-pin the survivor's model and the LEDGER FOLLOWS — no name comparison left",
    socialRepinned.row?.model_used === "gpt-4o", `model_used=${String(socialRepinned.row?.model_used)}`)
  check("social_post: the counts are still the survivor's own (200+60)",
    social.row?.tokens_used === 260 && socialRepinned.row?.tokens_used === 260)

  const email = await run("email_composer", { emailType: "follow-up", recipient: "John", context: "Toured 3 homes" })
  check("email_composer: the row names the model the survivor reports",
    email.row?.model_used === "gpt-4o-mini", `model_used=${String(email.row?.model_used)}`)
  const emailRepinned = await run("email_composer", { emailType: "follow-up", context: "Toured 3 homes" }, {
    draft: {
      success: true, draft: "d",
      usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120, estimated: false, model: "claude-sonnet" },
    },
  })
  check("email_composer: re-pin the survivor's model and the LEDGER FOLLOWS",
    emailRepinned.row?.model_used === "claude-sonnet", `model_used=${String(emailRepinned.row?.model_used)}`)

  const unnamedSocial = await run("social_post", { platform: "instagram", context: "4 bed in Oak Park" }, {
    social: {
      success: true, data: { content: "c", hashtags: [] },
      usage: { inputTokens: 200, outputTokens: 60, totalTokens: 260, estimated: false, model: null },
    },
  })
  check("social_post: a survivor that cannot name its model books ZERO, not a priced guess",
    unnamedSocial.row?.tokens_used === 0 && unnamedSocial.row?.model_used === null,
    `tokens_used=${unnamedSocial.row?.tokens_used}`)

  // NO ROW ANYWHERE CARRIES TOKENS WITHOUT A MODEL — the m508 invariant, held
  // by the application over every row this proof produced.
  const rows = [primary, fellBack, unattributed, social, socialRepinned, email, emailRepinned, unnamedSocial]
    .map((r) => r.row)
  check("m508, held in the application: no row claims tokens without naming a model",
    rows.every((r) => (r?.tokens_used ?? 0) === 0 || !!r?.model_used),
    JSON.stringify(rows.find((r) => (r?.tokens_used ?? 0) !== 0 && !r?.model_used)))
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. UNIT — modelIdentityFor, from the REAL lib/ai/models.ts
// ─────────────────────────────────────────────────────────────────────────────
async function identityLayer(): Promise<void> {
  if (!CHILD) console.log("\n4. UNIT — turning a gateway model string back into a billing identity")

  // By FILE URL, so the "@/lib/ai/models" specifier stub above does not shadow
  // the real module. Its own imports still resolve through the stubs.
  const mod: any = await import(pathToFileURL(join(ROOT, F.models)).href)
  const idFor = mod.modelIdentityFor

  check("modelIdentityFor exists and is a function", typeof idFor === "function")
  if (typeof idFor !== "function") return

  check("a canonical gateway string resolves to its billing identity",
    idFor("anthropic/claude-sonnet-4-20250514") === "claude-sonnet", String(idFor("anthropic/claude-sonnet-4-20250514")))
  check("a short alias resolves through resolve-model to the same identity",
    idFor("claude-sonnet") === "claude-sonnet", String(idFor("claude-sonnet")))
  check("the email lane's pinned model resolves",
    idFor("openai/gpt-4o-mini") === "gpt-4o-mini", String(idFor("openai/gpt-4o-mini")))
  check("an already-built provider instance cannot be named, and says so with null",
    idFor({ specificationVersion: "v2" }) === null, String(idFor({ specificationVersion: "v2" })))
  check("an unknown model string is null, never a nearest guess",
    idFor("openai/gpt-9-imaginary") === null, String(idFor("openai/gpt-9-imaginary")))
  // gemini-pro and gemini-flash BOTH map to google/gemini-2.0-flash-exp in
  // MODEL_CONFIG and price 16x apart. Choosing either would be inventing the
  // tenant's cost, so the reverse lookup refuses.
  check("an AMBIGUOUS model id (two identities, 16x apart in price) refuses rather than picking",
    idFor("google/gemini-2.0-flash-exp") === null, String(idFor("google/gemini-2.0-flash-exp")))
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CONSTRUCT — what behaviour cannot reach
// ─────────────────────────────────────────────────────────────────────────────
function constructLayer(): void {
  if (!CHILD) console.log("\n5. CONSTRUCT — the source facts behind the behaviour")

  const hub = code(F.hub)
  const models = code(F.models)
  const gen = code(F.generate)
  const smart = code(F.smart)
  const fairUse = code(F.fairUse)
  const client = code(F.client)

  // F1 — the tenant is the thing that makes the routed lane ledger AND cap.
  check("generateTextRouted ledgers ONLY when it is given a tenant (both routed lanes)",
    (models.match(/if \(request\.brokerageId\) \{\s*await logAIUsage\(\{/g) ?? []).length === 2,
    `matches=${(models.match(/if \(request\.brokerageId\) \{\s*await logAIUsage\(\{/g) ?? []).length}`)
  check("checkAIFairUse treats a missing tenant as uncapped — which is why the gap was silent",
    /if \(!params\.brokerageId \|\| params\.bypass\) \{/.test(fairUse))
  check("all four education tools now hand the routed lane the session tenant",
    (hub.match(/brokerageId: tenant\.brokerageId/g) ?? []).length === 4,
    `matches=${(hub.match(/brokerageId: tenant\.brokerageId/g) ?? []).length}`)
  check("the tenant is built from the session context and from nothing else",
    /function tenantOf\(ctx: AgentContext\): HubTenant \{\s*return \{ userId: ctx\.userId, brokerageId: ctx\.brokerageId, agentId: ctx\.agentId \}/.test(hub))
  check("no education tool passes a model of its own any more (generateTextRouted ignored it anyway)",
    !/model: "openai\/gpt-4o-mini"/.test(hub), (hub.match(/[^\n]*model: "openai[^\n]*/) ?? [])[0])
  check("the double-book guard is the tenant, not a per-tool decision",
    /function routedTokens\(/.test(hub) && /if \(tenant\.brokerageId\) \{/.test(hub))

  // F2 — the served model is carried, not named locally.
  check("the generateObject shim reports the model it called",
    /usage: readUsage\(usage, promptForEstimate, servedModel\)/.test(gen) &&
      /const servedModel = modelIdentityFor\(model\)/.test(gen))
  check("GeneratedUsage carries the served model to its callers",
    /model: AIModel \| null/.test(gen))
  check("the smart-reply survivor carries the ROUTED model out instead of naming one",
    /model: usage\.model,/.test(smart) && !/model: "claude-/.test(smart),
    (smart.match(/[^\n]*model: "claude-[^\n]*/) ?? [])[0])
  check("generateObjectRouted already reported which of primary/fallback served",
    /modelUsed {4}= fallback/.test(models) && /model: modelUsed \}/.test(models))
  check("the hub no longer decides model_used by comparing a survivor's NAME",
    !/model: lane === /.test(hub), (hub.match(/[^\n]*model: lane === [^\n]*/) ?? [])[0])
  check("every measured arm in the hub reads its model off a usage object",
    (hub.match(/measured: true,\s*\n\s*inputTokens: usage\.(inputTokens|model)/g) ?? []).length >= 2 ||
      (hub.match(/model: usage\.model,/g) ?? []).length >= 2,
    `matches=${(hub.match(/model: usage\.model,/g) ?? []).length}`)
  check("no measured arm binds a model NAME as a literal",
    !/measured: true,[\s\S]{0,220}?model: "/.test(hub),
    (hub.match(/measured: true,[\s\S]{0,220}?model: "[^"]*"/) ?? [])[0]?.replace(/\s+/g, " "))

  // F3 — the dispatch reads the names the card renders.
  check("the Neighborhood Research card still renders neighborhood/city/state",
    /name: "neighborhood"/.test(client) && /name: "city"/.test(client) && /name: "state"/.test(client))
  check("the Explain This card still renders a single input named `concept`",
    /id: "explain_this"/.test(client) && /name: "concept"/.test(client))
  check("the dispatch reads those field names",
    /field\(params\.neighborhood\)/.test(hub) && /field\(params\.concept\)/.test(hub))
  check("neither tool can reach a model with nothing to work on",
    /if \(!place\) \{/.test(hub) && /if \(!concept\) return refuse\(/.test(hub))

  // F4 — verified, not redone: ToolRun.output is a string and every structured
  // result goes through toPanelText on its way to the panel.
  check("ToolRun.output is typed as a string", /output: string/.test(hub))
  check("every structured tool result is serialised at the boundary",
    (hub.match(/toPanelText\(/g) ?? []).length >= 5,
    `toPanelText calls=${(hub.match(/toPanelText\(/g) ?? []).length}`)
  check("the panel's own store is still Record<string, string>",
    /toolResults, setToolResults\] = useState<Record<string, string>>/.test(client))

  // TENANT — never from the argument list.
  check("executeAITool still resolves identity from the session only",
    /const ctx = await getAgentContext\(\)/.test(hub) && /const brokerageId = ctx\.brokerageId/.test(hub))
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. FINDINGS — found here, not fixed here
// ─────────────────────────────────────────────────────────────────────────────
function findingsLayer(): void {
  console.log("\n6. FINDINGS")
  const hub = code(F.hub)

  if (/function runHubModel\(/.test(hub) && !/brokerageId/.test(hub.split("function runHubModel(")[1]?.slice(0, 600) ?? "")) {
    finding(
      "the hub's own model calls are still outside the tenant's fair-use cap",
      "runHubModel deliberately omits brokerageId so the hub can book the counts on its own row — correct for the " +
      "INVOICE rail (ai_tool_usage → meter_readings.ai_tokens), but checkAIFairUse reads a missing brokerageId as " +
      "'background job → uncapped', so objection_handler and team_performance_analyzer spend the tenant's included " +
      "allowance without being counted against it. Closing it means either passing the tenant and booking 0 (as the " +
      "four education tools now do) or bumping usage_counters from the hub's own insert.",
    )
  }
  finding(
    "the hub's own ai_tool_usage insert bumps no counter but the invoice one",
    "logAIUsage writes the row AND increment_ai_usage_monthly AND usage_counters.ai_tokens_monthly AND " +
    "billing_usage.ai_calls. executeAITool's direct insert writes only the row, so a run the hub books itself " +
    "(no tenant on the session, or a hub-owned model call) reaches meter_readings but never the fair-use counter " +
    "or the ai_calls meter. Same table, two writers, different completeness.",
  )
  finding(
    "three client-education tools ride the 'unspecified' routing row",
    "AI_TASK_ROUTING has no key for client education, property comparison or an affordability narrative, so " +
    "explainTerm, compareProperties and runAffordabilityTool ledger feature='unspecified'. Left alone " +
    "deliberately: adding routing rows changes which model serves them, which is a product decision. " +
    "researchNeighborhood is the exception — a row named neighborhood_research already existed and it now rides it.",
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. NEGATIVE CONTROLS — a check that cannot fail proves nothing
// ─────────────────────────────────────────────────────────────────────────────
interface Control { file: string; find: string; replace: string }

function controlled(label: string, c: Control): void {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)
  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY; proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }
  writeFileSync(join(ROOT, c.file), after)
  let wentRed = false
  try {
    const child = spawnSync("npx", ["tsx", "scripts/ai-tools-hub-tenanted-spend-simulator.ts", "--assert-only"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, AITH_TENANT_SIM_CHILD: "1" },
    })
    wentRed = child.status !== 0
  } finally {
    writeFileSync(join(ROOT, c.file), before)
    if (sha(c.file) !== beforeSha) {
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      failures.push(`FAILED TO RESTORE ${c.file}`)
      return
    }
  }
  console.log(wentRed
    ? `  ✓ NEGATIVE CONTROL ${label} — went RED as required`
    : `  ✗ NEGATIVE CONTROL ${label} — STAYED GREEN with the defect present`)
  if (!wentRed) failures.push(`negative control stayed green: ${label}`)
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!CHILD) console.log("AI TOOLS HUB — whose bill it is, which model served it, and what the tool was handed\n")

  hub = (await import(pathToFileURL(join(ROOT, F.hub)).href)) as unknown as Hub

  await tenantLayer()
  await fieldsLayer()
  await servedModelLayer()
  await identityLayer()
  constructLayer()
  if (!CHILD) findingsLayer()

  if (!ASSERT_ONLY) {
    console.log("\n7. NEGATIVE CONTROLS")

    // F1.1 — the tenant taken back off the routed call: unbilled, uncapped again.
    controlled("a routed education-tool call made with no tenant again", {
      file: F.hub,
      find: `    userId: tenant.userId,
    brokerageId: tenant.brokerageId,
    agentId: tenant.agentId ?? undefined,
  })

  return {
    output: toPanelText({
      term,`,
      replace: `    userId: tenant.userId,
    brokerageId: null,
    agentId: tenant.agentId ?? undefined,
  })

  return {
    output: toPanelText({
      term,`,
    })

    // F1.2 — the same call booked twice: once by the routed lane, once here.
    controlled("the routed lane's spend booked a second time on the hub's row", {
      file: F.hub,
      find: "  if (tenant.brokerageId) {",
      replace: "  if (false) {",
    })

    // F2.1 — the pinned model asserted back over the served one.
    controlled("model_used stamped from the survivor's name instead of its report", {
      file: F.hub,
      find: `priced against a guess\`,
    }
  }
  return {
    measured: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    model: usage.model,`,
      replace: `priced against a guess\`,
    }
  }
  return {
    measured: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    model: lane === "generateSocialPostContent" ? "claude-sonnet" : "gpt-4o-mini",`,
    })

    // F2.1b — the same defect on the tool the hub runs itself.
    controlled("an education tool's row stamped with a model name instead of the served one", {
      file: F.hub,
      find: `  return {
    measured: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    model: usage.model,
  }
}`,
      replace: `  return {
    measured: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    model: "claude-sonnet",
  }
}`,
    })

    // F2.2 — tokens booked against a model nobody could name (m508's defect).
    controlled("tokens booked with no model to attribute them to", {
      file: F.hub,
      find: `  if (!usage.model) {
    return {
      measured: false,
      reason: "lane_reports_no_usage",
      detail: \`generateSmartReplies reported`,
      replace: `  if (false) {
    return {
      measured: false,
      reason: "lane_reports_no_usage",
      detail: \`generateSmartReplies reported`,
    })

    // F2.3 — the shim going back to not naming the model it called.
    controlled("the generateObject shim discarding the model it called", {
      file: F.generate,
      find: "usage: readUsage(usage, promptForEstimate, servedModel),",
      replace: "usage: readUsage(usage, promptForEstimate, null),",
    })

    // F2.4 — the smart-reply lane naming a model instead of reporting one.
    controlled("the smart-reply lane naming its pinned model instead of the served one", {
      file: F.smart,
      find: "        model: usage.model,",
      replace: '        model: "claude-sonnet",',
    })

    // F3.1 — the dispatch reading a field the card does not render.
    controlled("neighborhood_research reading a field the form does not collect", {
      file: F.hub,
      find: `        [field(params.neighborhood), field(params.city), field(params.state)].filter(Boolean).join(", ")`,
      replace: `        ""`,
    })

    // F3.2 — the same defect on the second tool.
    controlled("explain_this reading params.term again", {
      file: F.hub,
      find: "const concept = field(params.concept) ?? field(params.term)",
      replace: "const concept = field(params.term)",
    })

    // F1.3 — the tenant taken from the browser rather than the session.
    controlled("the tenant read off the session's user id replaced by the browser's claim", {
      file: F.hub,
      find: "  return { userId: ctx.userId, brokerageId: ctx.brokerageId, agentId: ctx.agentId }",
      replace: "  return { userId: ctx.userId, brokerageId: null, agentId: ctx.agentId }",
    })
  }

  if (findings.length && !CHILD) {
    console.log(`\nFINDINGS (${findings.length}) — reported, not failed:`)
    for (const f of findings) console.log(`  ⚠ ${f}`)
  }

  console.log("")
  if (failures.length) {
    console.log(`RESULT: FAILED (${failures.length} of ${pass + failures.length} assertions)`)
    for (const f of failures) console.log(`  · ${f}`)
    console.log("❌ AI_TOOLS_HUB_TENANTED_SPEND_FAIL")
    process.exit(1)
  }
  console.log(
    `RESULT: PASSED (${pass} assertions) — every AI Toolkit tool's spend lands on exactly one ai_tool_usage row ` +
    `against the session's tenant, the model on that row is the one the lane says served the call rather than the ` +
    `one it pins, counts that cannot be attributed to a model book zero instead of being priced against a guess, ` +
    `and no tool reaches a model with a field its own form never collected`,
  )
  console.log("✅ AI_TOOLS_HUB_TENANTED_SPEND_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
