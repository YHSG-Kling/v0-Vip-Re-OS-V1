#!/usr/bin/env tsx
/**
 * scripts/ai-tools-hub-honesty-simulator.ts   (tsx scripts/ai-tools-hub-honesty-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AI TOOLKIT'S LEDGER — WHAT A TOOL IS ALLOWED TO SAY IT PRODUCED, AND WHAT
 * IT IS ALLOWED TO SAY IT SPENT.
 *
 * Ten tools in app/actions/ai-tools-hub.ts were one-line stubs of this shape:
 *
 *     async function generatePropertyDescription(propertyData, userId) {
 *       return { description: "AI-generated property description", tokensUsed: 500 }
 *     }
 *
 * TWO DEFECTS, and the second is the one that mattered.
 *
 *   (1) A user who pressed the button was shown a fixed sentence presented as
 *       AI output.
 *
 *   (2) `executeAITool` read `result.tokensUsed` and wrote it to
 *       `ai_tool_usage.tokens_used` AS A SUCCESSFUL RUN. That table is the
 *       platform's AI cost ledger — lib/finance/usage-metering.ts folds it into
 *       `meter_readings.ai_tokens` per brokerage, and the per-tier overage
 *       projection is built on the same rows. A function that spent nothing and
 *       reported 500 tokens was not an unfinished feature. It was a fabricated
 *       meter reading inside a billing record, and it was indistinguishable
 *       from a real one to every reader downstream.
 *
 * THE FOUR CLAIMS THIS PROOF STANDS OVER
 *
 *   P1  NO TOOL RETURNS A HARDCODED OUTPUT STRING on a successful path. A
 *       string literal may only leave this hub as a REFUSAL — and a refusal is
 *       ledgered as a failure, so it can never be mistaken for a produced
 *       artifact.
 *
 *   P2  NO LEDGER FIGURE IS A LITERAL. Every non-zero `tokens_used` this hub
 *       writes is traced to counts the provider returned on the response of a
 *       call this hub itself made. Change what the provider reports and the
 *       ledger changes with it.
 *
 *   P3  A TOOL THAT DID NOT CALL A MODEL BOOKS ZERO, and a tool that REFUSED is
 *       ledgered with success=false rather than as a successful run. Zero also
 *       covers the routed tools whose survivor already wrote its own
 *       ai_tool_usage row for the same call — booking it twice would overstate
 *       the tenant's AI meter, so the hub records 0 and names where the spend
 *       landed.
 *
 *   P4  EVERY OUTBOUND-COPY GENERATOR REACHES THE COMPLIANCE GATE. Listing
 *       copy, social posts, emails, message drafts and talk tracks pass through
 *       evaluateOutbound — directly here, or inside the survivor they route to
 *       — and a gate that cannot run FAILS CLOSED.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 * TWO LAYERS, and the first one is the one that matters.
 *
 *   BEHAVIOUR — the REAL `executeAITool` is executed. Only the lane's EDGES are
 *   stubbed (the Supabase client, the routed model call, the compliance gate,
 *   the session context, and each survivor this hub routes to) via
 *   `registerHooks`, dispatching through globalThis so one cached module graph
 *   can be re-aimed per scenario. What is asserted is THE ROW THE PRODUCTION
 *   FUNCTION ACTUALLY WRITES TO ai_tool_usage — not what its source looks like.
 *
 *   CONSTRUCT — the small number of facts a behaviour test cannot see: that no
 *   numeric literal is bound to a token field anywhere in the file, that the
 *   two survivors this hub delegates outbound copy to run evaluateOutbound
 *   themselves, and that the routed AI helpers carry the provider's counts back
 *   out at all.
 *
 * ── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
 * Each control writes one defect class back into the real file and re-runs the
 * WHOLE proof IN A CHILD PROCESS — a fresh module graph, because these are
 * runtime assertions and a patched file cannot be re-imported into a cached
 * one. The patch is verified to have applied (a find-string that silently stops
 * matching is theatre), the child is required to EXIT NON-ZERO, and the file is
 * restored and re-verified by sha256.
 *
 * ── WHAT THIS PROOF DELIBERATELY ONLY WARNS ABOUT ───────────────────────────
 * Three tools (document_checklist, deadline_calculator, document_explainer) are
 * NOT built. They are held to P1-P3 like everything else — they refuse, book
 * zero, and ledger as failures — but the missing capability is reported as a
 * ⚠ FINDING rather than a failure, because building them is a product decision
 * outside this lane. Same for the four pre-existing tools whose model lane
 * neither returns its usage nor ledgers it: their spend is invisible, that is
 * named here, and it is not this change's to fix silently.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { registerHooks } from "node:module"
import { spawnSync } from "node:child_process"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const CHILD = process.env.AITH_SIM_CHILD === "1"
const ASSERT_ONLY = CHILD || process.argv.includes("--assert-only")

const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")
/** Comment-stripped source. LOAD-BEARING: this hub quotes its own old stubs in
 *  its headers, so a raw-source scan would accuse the fix of being the defect. */
const code = (p: string) => stripComments(raw(p))

const F = {
  hub: "app/actions/ai-tools-hub.ts",
  social: "app/actions/social/generate-social-post.ts",
  models: "lib/ai/models.ts",
  generate: "lib/ai/generate.ts",
  smart: "lib/inbox/smart-replies.ts",
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
const G = () => (globalThis as any).__AITH

const STUBS: Record<string, string> = {
  "@/lib/supabase/server":
    "export const createClient = (...a) => globalThis.__AITH.createClient(...a)",
  "@/lib/ai/models":
    "export const generateTextRouted = (...a) => globalThis.__AITH.generateTextRouted(...a)",
  "@/lib/ai/cost-tracking":
    "export const calculateCost = (...a) => globalThis.__AITH.calculateCost(...a)",
  "@/lib/identity/get-agent-context":
    "export const getAgentContext = (...a) => globalThis.__AITH.getAgentContext(...a)",
  "@/lib/kernel/compliance":
    "export const evaluateOutbound = (...a) => globalThis.__AITH.evaluateOutbound(...a)",
  "@/app/actions/ai-content-generation":
    "export const generateListingDescription = (...a) => globalThis.__AITH.generateListingDescription(...a)",
  "@/app/actions/social/generate-social-post":
    "export const generateContextualDraft = (...a) => globalThis.__AITH.generateContextualDraft(...a);" +
    "export const generateSocialPostContent = (...a) => globalThis.__AITH.generateSocialPostContent(...a)",
  "@/lib/inbox/smart-replies":
    "export const generateSmartReplies = (...a) => globalThis.__AITH.generateSmartReplies(...a)",
  "@/lib/kernel/reporting":
    "export const generateTeamPerformanceReport = (...a) => globalThis.__AITH.generateTeamPerformanceReport(...a)",
  "@/app/actions/ai-predictions":
    "export const predictMarketShift = (...a) => globalThis.__AITH.predictMarketShift(...a)",
  "@/lib/offers/closing-cost-accuracy":
    "export const parseMoney = (v) => globalThis.__AITH.parseMoney(v)",
  "@/app/actions/calculators":
    "export const calculateAffordability = (...a) => globalThis.__AITH.calculateAffordability(...a)",
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
  tool_name: string
  success: boolean
  tokens_used: number
  model_used: string | null
  cost_cents: number
  output_text: string
  feature: string | null
}

interface World {
  ctx: any
  /** What the stubbed provider reports back for a call this hub makes itself. */
  modelUsage: { inputTokens: number; outputTokens: number; totalTokens: number; model: string }
  modelText: string
  modelCalls: number
  gate: { allowed: boolean; violations: string[] }
  gateCalls: any[]
  listing: any
  draft: any
  social: any
  smart: any
  teamReport: any
  market: any
  ledger: LedgerRow[]
}

let W: World

const SESSION_USER = "11111111-1111-1111-1111-111111111111"
const SESSION_AGENT = "22222222-2222-2222-2222-222222222222"
const SESSION_BROKERAGE = "33333333-3333-3333-3333-333333333333"
/** What a browser might claim it is. Nothing may ever be filed under this. */
const BROWSER_CLAIMED_USER = "99999999-9999-9999-9999-999999999999"

function newWorld(over: Partial<World> = {}): World {
  return {
    ctx: {
      isAuthenticated: true,
      userId: SESSION_USER,
      agentId: SESSION_AGENT,
      brokerageId: SESSION_BROKERAGE,
      teamId: null,
      userType: "broker",
      role: "broker",
    },
    modelUsage: { inputTokens: 123, outputTokens: 45, totalTokens: 168, model: "claude-haiku" },
    modelText: "A real model reply about the client's concern and what you gain by addressing it.",
    modelCalls: 0,
    gate: { allowed: true, violations: [] },
    gateCalls: [],
    listing: {
      success: true,
      data: { headline: "Room to grow", medium_description: "You get a kitchen built for the way you cook." },
    },
    draft: { success: true, draft: "Here is what you asked for.", usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120, estimated: false } },
    social: {
      success: true,
      data: { content: "Your next chapter starts here.", hashtags: ["OakPark"], hook: "h", cta: "c", estimated_engagement: "high" },
      usage: { inputTokens: 200, outputTokens: 60, totalTokens: 260, estimated: false },
    },
    smart: {
      replies: [
        { intent: "affirm", body: "Got it — you will hear from me today." },
        { intent: "clarify", body: "What matters most to you right now?" },
        { intent: "soft_hold", body: "Let me check and come back to you." },
      ],
      usage: { modelCalled: true, inputTokens: 70, outputTokens: 20, totalTokens: 90, estimated: false },
    },
    teamReport: {
      success: true,
      data: { teams: [{ id: "t1", team_name: "North", total_revenue: 400000, goal_amount: 500000, attainment_pct: 80, agent_count: 0 }] },
    },
    market: { success: true, prediction: { prediction: { direction: "shifting_to_buyer" } } },
    ledger: [],
    ...over,
  }
}

/** Chainable PostgREST-shaped stub: every builder method returns itself, and it
 *  is thenable so `await`ing anywhere in the chain resolves { data, error }. */
function chain(result: any): any {
  const obj: any = {
    then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
  }
  for (const m of [
    "select", "eq", "in", "is", "or", "not", "gte", "lte", "gt", "lt", "order",
    "limit", "range", "textSearch", "maybeSingle", "single", "update", "delete", "upsert",
  ]) obj[m] = () => obj
  return obj
}

;(globalThis as any).__AITH = {
  createClient: async () => ({
    from(table: string) {
      if (table === "ai_tool_usage") {
        return { insert: (row: LedgerRow) => { W.ledger.push(row); return Promise.resolve({ error: null }) } }
      }
      return chain({ data: [], error: null })
    },
    auth: { getUser: async () => ({ data: { user: { id: SESSION_USER } } }) },
  }),
  generateTextRouted: async (_req: any) => {
    W.modelCalls++
    return { text: W.modelText, usage: W.modelUsage }
  },
  // The REAL pricing function is not needed to prove honesty, only that the
  // booked cost is a function of the booked tokens.
  calculateCost: (_model: string, i: number, o: number) => Math.ceil((i + o) / 10),
  getAgentContext: async () => W.ctx,
  evaluateOutbound: async (p: any) => {
    W.gateCalls.push(p)
    return { allowed: W.gate.allowed, violations: W.gate.violations }
  },
  generateListingDescription: async () => W.listing,
  generateContextualDraft: async () => W.draft,
  generateSocialPostContent: async () => W.social,
  generateSmartReplies: async () => W.smart,
  generateTeamPerformanceReport: async () => W.teamReport,
  predictMarketShift: async () => W.market,
  parseMoney: (v: any) => (typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, "")) || null),
  calculateAffordability: async () => ({
    maxHomePrice: 0, downPayment: 0, loanAmount: 0,
    monthlyBreakdown: { total: 0, principal_interest: 0, property_tax: 0, insurance: 0, pmi: 0, hoa: 0 },
    hiddenCosts: { closing_costs: 0, maintenance_budget: 0, utilities_estimate: 0 },
    recommendations: [],
  }),
}

type Hub = { executeAITool: (t: string, u: string, ut: string, p: any) => Promise<any> }
let hub: Hub

/** Run one tool against a fresh world and return the ledger row it wrote. */
async function run(
  toolName: string,
  params: any,
  shape: Partial<World> = {},
): Promise<{ res: any; row: LedgerRow | undefined; world: World }> {
  W = newWorld(shape)
  const res = await hub.executeAITool(toolName, BROWSER_CLAIMED_USER, "broker", params)
  return { res, row: W.ledger[0], world: W }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. BEHAVIOUR — the row the production executor actually writes
// ─────────────────────────────────────────────────────────────────────────────
async function behaviourLayer(): Promise<void> {
  if (!CHILD) console.log("1. BEHAVIOUR — what executeAITool writes to ai_tool_usage")

  hub = (await import(pathToFileURL(join(ROOT, F.hub)).href)) as unknown as Hub

  // ── P2: a measured run books the counts the provider returned ────────────
  const built = await run("objection_handler", { objection: "Your commission is too high.", context: "First-time buyer" })
  check("objection_handler: a built tool calls the model exactly once", built.world.modelCalls === 1,
    `modelCalls=${built.world.modelCalls}`)
  check("objection_handler: the ledger books the provider's own counts (123+45)",
    built.row?.tokens_used === 168, `tokens_used=${built.row?.tokens_used}`)
  check("objection_handler: the ledger names the model the provider served",
    built.row?.model_used === "claude-haiku", `model_used=${built.row?.model_used}`)
  check("objection_handler: cost is priced off the booked tokens, not left at zero",
    (built.row?.cost_cents ?? 0) > 0, `cost_cents=${built.row?.cost_cents}`)
  check("objection_handler: ledgered as a successful run", built.row?.success === true)
  check("objection_handler: the output is the model's text, not a canned string",
    typeof built.res?.result === "string" && built.res.result.includes("what you gain"),
    JSON.stringify(built.res?.result)?.slice(0, 80))

  // THE FIGURE FOLLOWS THE PROVIDER. A constant cannot do this.
  const moved = await run(
    "objection_handler",
    { objection: "Your commission is too high." },
    { modelUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, model: "gpt-4o-mini" } },
  )
  check("the ledger figure MOVES when the provider reports different counts (7+3)",
    moved.row?.tokens_used === 10, `tokens_used=${moved.row?.tokens_used}`)
  check("the ledger model MOVES when a different model serves the call",
    moved.row?.model_used === "gpt-4o-mini", `model_used=${moved.row?.model_used}`)

  // ── P3: a refusal is a refusal ───────────────────────────────────────────
  const blank = await run("objection_handler", { objection: "   " })
  check("a tool with nothing to work on does not call a model", blank.world.modelCalls === 0)
  check("a refusal books ZERO tokens", blank.row?.tokens_used === 0, `tokens_used=${blank.row?.tokens_used}`)
  check("a refusal books no model and no cost",
    blank.row?.model_used === null && blank.row?.cost_cents === 0)
  check("a refusal is ledgered as success=false, NOT as a successful run", blank.row?.success === false,
    `success=${blank.row?.success}`)
  check("a refusal reaches the caller as an error the panel can show",
    blank.res?.success === false && typeof blank.res?.error === "string" && blank.res.error.length > 0)

  // ── P4: a compliance block is a refusal, and the copy is withheld ────────
  const blocked = await run(
    "objection_handler",
    { objection: "Is this a good area for families like mine?" },
    { gate: { allowed: false, violations: ["FairHousing: familial status"] } },
  )
  check("compliance-blocked copy is ledgered as success=false", blocked.row?.success === false)
  check("compliance-blocked copy is NOT returned to the caller",
    !String(blocked.res?.result ?? "").includes("what you gain"))
  check("compliance-blocked copy books zero tokens on this row", blocked.row?.tokens_used === 0)

  // ── P3: routed tools do not double-book the survivor's spend ─────────────
  const listing = await run("property_description", { address: "12 Oak St", features: "4 bed, pool", tone: "family" })
  check("property_description: routed to the survivor, so the hub calls no model itself",
    listing.world.modelCalls === 0)
  check("property_description: books ZERO — the survivor already ledgered this call",
    listing.row?.tokens_used === 0, `tokens_used=${listing.row?.tokens_used}`)
  check("property_description: ledgered as a successful run", listing.row?.success === true)
  check("property_description: returns the survivor's copy", String(listing.res?.result).includes("built for the way you cook"))
  check("property_description: the copy went through the compliance gate",
    listing.world.gateCalls.length === 1 &&
      String(listing.world.gateCalls[0]?.content).includes("built for the way you cook"),
    `gateCalls=${listing.world.gateCalls.length}`)
  check("property_description: the gate is asked under the SESSION brokerage",
    listing.world.gateCalls[0]?.actorContext?.brokerageId === SESSION_BROKERAGE)

  // ── P2: a survivor that reports its usage has that usage booked here ─────
  const social = await run("social_post", { platform: "instagram", contentType: "just-listed", context: "4 bed in Oak Park" })
  check("social_post: books the survivor's REPORTED counts (200+60)",
    social.row?.tokens_used === 260, `tokens_used=${social.row?.tokens_used}`)
  const socialMoved = await run(
    "social_post",
    { platform: "instagram", context: "4 bed in Oak Park" },
    { social: { success: true, data: { content: "c", hashtags: [] }, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false } } },
  )
  check("social_post: that figure MOVES with the survivor's report (1+2)",
    socialMoved.row?.tokens_used === 3, `tokens_used=${socialMoved.row?.tokens_used}`)

  const email = await run("email_composer", { emailType: "follow-up", recipient: "John", context: "Toured 3 homes" })
  check("email_composer: books the survivor's REPORTED counts (90+30)",
    email.row?.tokens_used === 120, `tokens_used=${email.row?.tokens_used}`)
  check("email_composer: returns the survivor's draft", String(email.res?.result).includes("what you asked for"))

  // ── P3: a tool that genuinely called no model books zero ─────────────────
  const canned = await run(
    "smart_reply",
    { lastMessage: "Can we see it Saturday?", relationshipType: "active-buyer" },
    {
      smart: {
        replies: [{ intent: "affirm", body: "Yes — Saturday works." }],
        usage: { modelCalled: false, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false },
      },
    },
  )
  check("smart_reply: the canned-fallback path (no model called) books ZERO",
    canned.row?.tokens_used === 0 && canned.row?.model_used === null,
    `tokens_used=${canned.row?.tokens_used}`)
  check("smart_reply: a run with no model call is still a SUCCESSFUL run", canned.row?.success === true)

  const smart = await run("smart_reply", { lastMessage: "Can we see it Saturday?", relationshipType: "active-buyer" })
  check("smart_reply: when the model DID run, its counts are booked (70+20)",
    smart.row?.tokens_used === 90, `tokens_used=${smart.row?.tokens_used}`)
  check("smart_reply: the draft reply went through the compliance gate",
    smart.world.gateCalls.length === 1)

  // ── P3: an empty data set is an answer, not a prompt ─────────────────────
  const emptyTeams = await run(
    "team_performance_analyzer",
    { timePeriod: "this-month", focusArea: "conversion" },
    { teamReport: { success: true, data: { teams: [] } } },
  )
  check("team_performance_analyzer: an empty roll-up calls no model", emptyTeams.world.modelCalls === 0)
  check("team_performance_analyzer: an empty roll-up books ZERO and stays a success",
    emptyTeams.row?.tokens_used === 0 && emptyTeams.row?.success === true)

  const teams = await run("team_performance_analyzer", { timePeriod: "this-month", focusArea: "conversion" })
  check("team_performance_analyzer: a real roll-up books the provider's counts",
    teams.row?.tokens_used === 168, `tokens_used=${teams.row?.tokens_used}`)

  // ── P3: the three unbuilt tools refuse instead of inventing ──────────────
  for (const t of ["document_checklist", "deadline_calculator", "document_explainer"]) {
    const r = await run(t, { transactionType: "purchase", state: "CA", contractDate: "2026-03-15", documentType: "Purchase Agreement" })
    check(`${t}: an unbuilt tool books ZERO tokens`, r.row?.tokens_used === 0, `tokens_used=${r.row?.tokens_used}`)
    check(`${t}: an unbuilt tool is ledgered as success=false, not as a run`, r.row?.success === false,
      `success=${r.row?.success}`)
    check(`${t}: an unbuilt tool calls no model`, r.world.modelCalls === 0)
  }

  const unknown = await run("no_such_tool", {})
  check("an unknown tool id is ledgered as a failure with zero tokens",
    unknown.row?.success === false && unknown.row?.tokens_used === 0)

  // ── TENANT: never from the argument list ─────────────────────────────────
  check("the ledger row is filed under the SESSION user, not the id the browser sent",
    built.row?.user_id === SESSION_USER, `user_id=${built.row?.user_id}`)
  check("the ledger row carries the SESSION brokerage",
    built.row?.brokerage_id === SESSION_BROKERAGE, `brokerage_id=${built.row?.brokerage_id}`)

  const anon = await run("objection_handler", { objection: "x" }, { ctx: { isAuthenticated: false, userId: "" } })
  check("an unauthenticated caller is refused before any model call and writes no ledger row",
    anon.world.modelCalls === 0 && anon.world.ledger.length === 0 && anon.res?.success === false)

  // ── P4: the gate FAILS CLOSED when it cannot run ─────────────────────────
  const noTenant = await run(
    "objection_handler",
    { objection: "Your commission is too high." },
    {
      ctx: {
        isAuthenticated: true, userId: SESSION_USER, agentId: SESSION_AGENT,
        brokerageId: null, teamId: null, userType: "agent", role: "agent",
      },
    },
  )
  check("copy generated with no tenant to check it against is REFUSED, not returned",
    noTenant.row?.success === false && !String(noTenant.res?.result ?? "").includes("what you gain"),
    `success=${noTenant.row?.success}`)

  // ── NO ROW ANYWHERE CARRIES A FIGURE NOBODY REPORTED ─────────────────────
  // Every tokens_used observed above is either 0 or a total some stub reported.
  const REPORTED = new Set([0, 168, 10, 260, 3, 120, 90])
  const observed = [built, moved, blank, blocked, listing, social, socialMoved, email, canned, smart, emptyTeams, teams, unknown, noTenant]
    .map((r) => r.row?.tokens_used ?? 0)
  check("no ledger row carries a token figure that no stub ever reported",
    observed.every((n) => REPORTED.has(n)), `observed=${[...new Set(observed)].join(",")}`)
  check("none of the fabricated stub constants (500/400/300/350/250/600/700/200/150) reach the ledger",
    observed.every((n) => ![500, 400, 300, 350, 250, 600, 700, 200, 150].includes(n)),
    `observed=${[...new Set(observed)].join(",")}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CONSTRUCT — what a behaviour test cannot see
// ─────────────────────────────────────────────────────────────────────────────

/** Body of a top-level function, brace-matched, skipping braces inside a
 *  generic return-type annotation (`): Promise<{ … }> {`). */
function bodyOf(src: string, name: string): string {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src)
  if (!m) return ""
  let i = m.index + m[0].length - 1
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) break }
  }
  let angle = 0
  let open = -1
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if (c === "<") angle++
    else if (c === ">") angle--
    else if (c === "{" && angle <= 0) { open = j; break }
  }
  if (open < 0) return ""
  let d = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") d++
    else if (src[j] === "}") { d--; if (d === 0) return src.slice(open, j + 1) }
  }
  return ""
}

/**
 * The seven tools this lane owns, how each is meant to get its output, and
 * where its compliance gate lives.
 *
 * `gate: "internal"` is claimed exactly once, and the claim is narrow:
 * team_performance_analyzer produces a broker-facing reading of the
 * brokerage's OWN team roll-up. Nothing it returns is addressed to a
 * client or published, so evaluateOutbound — a gate about what may be SENT —
 * has no subject. Every other tool's output is something a client will read
 * or hear, and every one of those is gated.
 */
const OWNED: Array<{ fn: string; via: "model" | "survivor"; gate: "here" | "survivor" | "internal" }> = [
  { fn: "generatePropertyDescription", via: "survivor", gate: "here" },
  { fn: "composeEmail",                via: "survivor", gate: "survivor" },
  { fn: "generateSocialPost",          via: "survivor", gate: "survivor" },
  { fn: "handleObjection",             via: "model",    gate: "here" },
  { fn: "generateSmartReply",          via: "survivor", gate: "here" },
  { fn: "analyzeTeamPerformance",      via: "model",    gate: "internal" },
  { fn: "predictMarketTrends",         via: "survivor", gate: "survivor" },
]

/** Every `return { … }` object literal inside a function body, brace-matched. */
function returnBlocks(body: string): string[] {
  const out: string[] = []
  const re = /return\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const open = m.index + m[0].length - 1
    let d = 0
    for (let j = open; j < body.length; j++) {
      if (body[j] === "{") d++
      else if (body[j] === "}") { d--; if (d === 0) { out.push(body.slice(open, j + 1)); break } }
    }
  }
  return out
}

function constructLayer(): void {
  if (!CHILD) console.log("\n2. CONSTRUCT — the source facts behaviour cannot reach")

  const hub = code(F.hub)

  // P2 — no literal may ever be bound to a token field, anywhere in this file.
  check("no `tokensUsed` field survives anywhere in the hub", !/\btokensUsed\b/.test(hub))
  check("no numeric literal is bound to a token field in the hub",
    !/\b(tokens_used|tokensUsed|inputTokens|outputTokens|totalTokens)\s*:\s*-?\d/.test(hub),
    (hub.match(/\b(tokens_used|tokensUsed|inputTokens|outputTokens|totalTokens)\s*:\s*-?\d[^\n]*/) ?? [])[0])
  check("the ledger's tokens_used is derived from the measured counts and nothing else",
    /const ledgerTokens = measured === null \? 0 : measured\.inputTokens \+ measured\.outputTokens/.test(hub) &&
      /tokens_used: ledgerTokens,/.test(hub))
  check("the ledger's model and cost are null/0 unless a measured call produced them",
    /const ledgerModel = measured === null \? null : measured\.model/.test(hub) &&
      /const ledgerCostCents =\s*\n?\s*measured === null \? 0 : calculateCost\(/.test(hub))
  check("the only measured counts in the hub are read off a usage object",
    /inputTokens: usage\.inputTokens/.test(hub) && /outputTokens: usage\.outputTokens/.test(hub))

  // P1 — no canned output string on a success path.
  check("no `return { <field>: \"<literal>\" }` stub shape remains in the hub",
    !/return\s*\{\s*[A-Za-z_$][\w$]*\s*:\s*["'][^"']*["']\s*\}/.test(hub),
    (hub.match(/return\s*\{\s*[A-Za-z_$][\w$]*\s*:\s*["'][^"']*["']\s*\}/) ?? [])[0])
  for (const { fn, via } of OWNED) {
    const body = bodyOf(hub, fn)
    check(`${fn}: found in the hub`, body.length > 0)
    check(`${fn}: its output comes from ${via === "model" ? "a model call" : "a survivor"}, never a literal`,
      via === "model" ? /runHubModel\(/.test(body) : /await import\(/.test(body))
    // THE RULE, precisely: a string literal may leave this hub as a tool's
    // output ONLY on a run that books nothing. That covers a refusal and a
    // "there is genuinely no data" answer, and it excludes the stub shape the
    // whole change exists to kill — a canned sentence returned alongside a
    // token count, indistinguishable downstream from real AI output that was
    // paid for.
    // A template literal carrying `${…}` is assembled from real values and is
    // not a canned sentence — only a fixed, uninterpolated literal is.
    const CANNED_OUTPUT = /output:\s*(?:"[^"]*"|'[^']*'|`[^`$]*`)/
    const cannedPaidReturn = returnBlocks(body).find(
      (b) => CANNED_OUTPUT.test(b) && !/measured:\s*false/.test(b) && !/tokens:\s*NOT_BUILT_TOKENS/.test(b),
    )
    check(`${fn}: no string literal is returned as output on a run that books tokens`,
      cannedPaidReturn === undefined,
      cannedPaidReturn?.replace(/\s+/g, " ").slice(0, 120))
  }

  // P3 — refusal semantics.
  check("refuse() marks the run as a refusal", /reason: "refused"/.test(bodyOf(hub, "refuse")))
  check("the executor derives success from the refusal, not from a constant",
    /const refused = run\.tokens\.measured === false && run\.tokens\.reason === "refused"/.test(hub) &&
      /const success = !refused/.test(hub))
  check("the unbuilt tools ledger as refusals rather than as successful runs",
    /NOT_BUILT_TOKENS = \{[\s\S]{0,200}?reason: "refused"/.test(hub))
  check("deal_health_monitor is booked as a no-model-call run",
    /reason: "no_model_call", detail: "pure scoring over transactions/.test(hub))

  // P4 — every outbound-copy generator reaches evaluateOutbound.
  check("the hub imports the real compliance gate", /import \{ evaluateOutbound \} from "@\/lib\/kernel\/compliance"/.test(hub))
  check("gateOutboundCopy calls evaluateOutbound", /evaluateOutbound\(\{/.test(bodyOf(hub, "gateOutboundCopy")))
  check("gateOutboundCopy FAILS CLOSED when there is no tenant to check against",
    /if \(!ctx\.brokerageId\) \{\s*return \{ allowed: false/.test(bodyOf(hub, "gateOutboundCopy")))
  for (const { fn, gate } of OWNED) {
    const body = bodyOf(hub, fn)
    if (gate === "here") {
      check(`${fn}: reaches the compliance gate in this file`, /gateOutboundCopy\(/.test(body))
    } else if (gate === "survivor") {
      check(`${fn}: delegates to a survivor that runs the gate itself`, /await import\(/.test(body))
    } else {
      // The one internal tool. Asserted from the other side: it must produce
      // nothing addressed to a client — no contact, no recipient, no channel —
      // so that "internal" cannot quietly become "outbound" without this
      // failing.
      check(`${fn}: is internal analytics and addresses no recipient`,
        !/contactName|recipient|messageType|contact:/.test(body))
    }
  }
  const socialSrc = code(F.social)
  check("the social/email survivor runs evaluateOutbound on what it generates",
    (socialSrc.match(/evaluateOutbound\(\{/g) ?? []).length >= 2)

  // TENANT — never from the argument list.
  const exec = bodyOf(hub, "executeAITool")
  check("executeAITool resolves identity from the session", /getAgentContext\(\)/.test(exec))
  check("executeAITool never reads the caller-supplied user id",
    !/_callerSuppliedUserId/.test(exec),
    (exec.match(/[^\n]*_callerSuppliedUserId[^\n]*/) ?? [])[0])

  // The routed helpers must actually carry the provider's counts back out —
  // without this there is no honest figure for the hub to book.
  const models = code(F.models)
  check("generateTextRouted returns the provider's usage to its caller",
    /totalTokens: inputTokens \+ outputTokens, model: modelUsed/.test(models))
  check("generateObjectRouted returns the provider's usage to its caller",
    (models.match(/totalTokens: inputTokens \+ outputTokens, model: modelUsed/g) ?? []).length === 2)
  const gen = code(F.generate)
  check("the generateObject shim returns the provider's usage to its caller",
    /usage: readUsage\(usage, promptForEstimate\)/.test(gen))
  const smartSrc = code(F.smart)
  check("the smart-reply survivor reports whether it called a model at all",
    /modelCalled: false/.test(smartSrc) && /modelCalled: true/.test(smartSrc))
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. FINDINGS — real, reported, and not this change's to fix silently
// ─────────────────────────────────────────────────────────────────────────────
function findingsLayer(): void {
  console.log("\n3. FINDINGS")
  const hub = code(F.hub)

  const unmeasured = (hub.match(/unmeasuredLane\(/g) ?? []).length - 1 // minus the helper's own definition
  if (unmeasured > 0) {
    finding(
      "pre-existing tools spend tokens nobody books",
      `${unmeasured} dispatch arm(s) marked lane_reports_no_usage — explainTerm, compareProperties, runAffordabilityTool and ` +
      `researchNeighborhood call generateTextRouted with no brokerageId, so logAIUsage never fires and the spend ` +
      `appears on no ledger at all. They book 0 here — honest, but the spend is still invisible. Fix: give each a ` +
      `tenant so the routed lane ledgers it.`,
    )
  }
  if (/reason: "booked_by_survivor"/.test(hub)) {
    finding(
      "two token provenances, by design",
      "a tool the hub runs itself books on the hub's own ai_tool_usage row; a tool routed to a survivor that " +
      "already calls logAIUsage books 0 there. Both are honest, neither double-bills, but a reader of " +
      "ai_tool_usage must join tool rows to 'ai_model' rows to see a routed tool's cost.",
    )
  }
  if (/model: lane === "generateSocialPostContent"/.test(hub)) {
    finding(
      "model_used is the PINNED model, not the served one",
      "the generateObject shim and generateObjectRouted do not report which of primary/fallback served the call, " +
      "so social_post, email_composer and smart_reply ledger the model their lane pins. The TOKENS are real; the " +
      "model label can be wrong on a fallback. Fix: carry modelUsed out of those two helpers as well.",
    )
  }
  finding(
    "three tools remain unbuilt",
    "document_checklist, deadline_calculator and document_explainer refuse honestly and book zero, but the AI " +
    "Toolkit still advertises them. deadline_calculator must NOT be built as a model call — " +
    "lib/transactions/milestone-catalog.ts and contingency-deadlines.ts already own contract dates.",
  )
  finding(
    "neighborhood_research receives undefined",
    "the dispatch reads params.address while the form collects neighborhood/city/state, so the tool has always " +
    "analysed `undefined`. Left untouched: researchNeighborhood is a real implementation and is another lane's.",
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. NEGATIVE CONTROLS — a check that cannot fail proves nothing
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
    const runChild = spawnSync("npx", ["tsx", "scripts/ai-tools-hub-honesty-simulator.ts", "--assert-only"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, AITH_SIM_CHILD: "1" },
    })
    wentRed = runChild.status !== 0
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
  if (!CHILD) console.log("AI TOOLS HUB HONESTY — canned output, and fabricated meter readings\n")

  await behaviourLayer()
  constructLayer()
  if (!CHILD) findingsLayer()

  if (!ASSERT_ONLY) {
    console.log("\n4. NEGATIVE CONTROLS")

    // 1. THE HEADLINE: an unmeasured run given a number of its own.
    controlled("a fabricated constant standing in for an unmeasured run", {
      file: F.hub,
      find: "const ledgerTokens = measured === null ? 0 :",
      replace: "const ledgerTokens = measured === null ? 500 :",
    })

    // 2. The stub's other half: a canned string returned as AI output.
    controlled("a canned string returned as a tool's output", {
      file: F.hub,
      find: `  return { output: text, feature: "playbook_response", tokens }`,
      replace: `  return { output: "AI-generated objection handler", feature: "playbook_response", tokens }`,
    })

    // 3. A token count invented at the point of measurement.
    controlled("a literal token count written where the provider's count belongs", {
      file: F.hub,
      find: `      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,`,
      replace: `      inputTokens: 500,
      outputTokens: 0,`,
    })

    // 4. A refusal ledgered as a successful run — the billing-record defect.
    controlled("a refusal ledgered as a successful run", {
      file: F.hub,
      find: "const success = !refused",
      replace: "const success = true",
    })

    // 5. The unbuilt tools promoted back to successful runs.
    controlled("an unbuilt tool ledgered as a run that happened", {
      file: F.hub,
      find: `  reason: "refused" as const,
  detail: "tool not implemented — no model call, nothing spent",`,
      replace: `  reason: "no_model_call" as const,
  detail: "tool not implemented — no model call, nothing spent",`,
    })

    // 6. Outbound copy shipped without reaching the fair-housing gate.
    controlled("listing copy returned without reaching the compliance gate", {
      file: F.hub,
      find: `  const gate = await gateOutboundCopy(ctx, copy, "social")`,
      replace: `  const gate = { allowed: true, violations: [] as string[] }`,
    })

    // 7. The gate failing OPEN when it cannot run.
    controlled("the compliance gate failing open when there is no tenant", {
      file: F.hub,
      find: `    return { allowed: false, violations: ["No brokerage on this session`,
      replace: `    return { allowed: true, violations: ["No brokerage on this session`,
    })

    // 8. The tenant taken from the browser again.
    controlled("the run filed under the user id the browser claimed", {
      file: F.hub,
      find: "  const userId = ctx.userId",
      replace: "  const userId = _callerSuppliedUserId",
    })

    // 9. The routed helper going back to discarding the provider's counts.
    controlled("generateTextRouted discarding the provider's usage again", {
      file: F.models,
      find: `    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, model: modelUsed },
  }
}

/**
 * AIFairUseError`,
      replace: `    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: modelUsed },
  }
}

/**
 * AIFairUseError`,
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
    console.log("❌ AI_TOOLS_HUB_HONESTY_FAIL")
    process.exit(1)
  }
  console.log(
    `RESULT: PASSED (${pass} assertions) — no tool in the AI Toolkit returns a canned string as AI output, ` +
    `every token figure written to ai_tool_usage is read off a provider response or is structurally zero with a ` +
    `named reason, a tool that refused is ledgered as a refusal rather than a run, and every outbound-copy ` +
    `generator reaches evaluateOutbound with a gate that fails closed`,
  )
  console.log("✅ AI_TOOLS_HUB_HONESTY_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
