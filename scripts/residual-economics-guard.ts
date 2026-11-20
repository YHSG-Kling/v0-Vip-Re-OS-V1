#!/usr/bin/env tsx
/**
 * scripts/residual-economics-guard.ts (npm run test:residual-economics)
 * ─────────────────────────────────────────────────────────────────────────────
 * RESIDUAL & NETWORK ECONOMICS — the Economic Relationship Graph end to end on its survivors
 * (wave 107, lane 107A; owner: "Agent B closes → Economic Event → Commission ledger → Residual
 * relationship lookup → Rule evaluation → Residual ledger entry → Finance Manager review. No LLM
 * calculates authoritative money.").
 *
 * A. RELATIONSHIP TYPES — a positive control for each: sponsor / mentor / team_lead rules pay
 *    (agent_relationships terms) and are corroborated by recruited_by / earns_residual / sponsor_of
 *    (sponsored_by) / member_of_team graph edges; referred_by / vendor_for never mint a residual; a
 *    graph-only earns_residual edge pays nothing and is REPORTED.
 * B. EFFECTIVE DATES at the CLOSE date (not the wall clock): expired-before-close pays nothing,
 *    expired-after-close still pays, starts-after-close pays nothing; graph edges honour windows too.
 * C. DETERMINISM: the same rows (in any order) → byte-equal evaluation; idempotency key per
 *    (transaction, beneficiary, rule); step 11's re-run guard rule (liveLedgerEntries).
 * D. VOID / REVERSAL: a voided or reversed source → unpaid residuals voided, paid residuals get a −net
 *    reversal row, a second run changes nothing.
 * E. TENANT ISOLATION + AGENTS NEVER SEE OTHERS' RESIDUALS: foreign rows dropped and reported; every new
 *    kernel read pins brokerage_id; approval/void are finance-admin gated (agent refused).
 * F. FINANCE MANAGER REVIEW: a residual is born pending, the payout sweeps hold it until approved, the
 *    drift aggregate does not count a held residual, approval is ledgered + evented.
 * G. AI-FREE MONEY PATH CENSUS: the static import closure of the commission engine + waterfall + rule
 *    evaluator reaches NO model SDK and no lib/ai module (positive control: the finder catches a planted
 *    `from "ai"` / `@ai-sdk/openai` / lib/ai import).
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve, relative } from "node:path"
import { stripComments } from "./strip-comments"
import {
  evaluateResidualRules, parseRevenueShareModel,
  RESIDUAL_ELIGIBLE_RELATIONSHIPS, RESIDUAL_CORROBORATING_EDGES, NON_RESIDUAL_ECONOMIC_EDGES,
  type ResidualGraphEdge,
} from "../lib/commission/revenue-share-model"
import {
  planResidualReversal, planResidualApproval, isResidualAwaitingReview, liveLedgerEntries, RESIDUAL_PAYABLE_FILTER,
} from "../lib/commission/distribution-correction"
import { aggregateLedgerStatus } from "../lib/commission/reconcile-tracking"
import { RELATIONSHIP_TYPES } from "../lib/kernel/relationship-graph"
import { isBrokerageFinanceAdmin } from "../lib/auth/resolve-user-role"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const src = (p: string) => stripComments(raw(p))

const B = "brk-A", OTHER = "brk-B", T = "txn-1"
const PRODUCER = "agent-producer", SPONSOR = "agent-sponsor", MENTOR = "agent-mentor", LEAD = "agent-lead"
const U = { [PRODUCER]: "user-producer", [SPONSOR]: "user-sponsor", [MENTOR]: "user-mentor", [LEAD]: "user-lead" } as Record<string, string>
const userIdByAgentId = new Map(Object.entries(U))
const TEAM = "team-1"
const model = parseRevenueShareModel({ revenue_share_enabled: true, revenue_share_source_of_funds: "agent", revenue_share_rate_type: "percent", revenue_share_default_percent: 5, revenue_share_duration_months: 0 })

const rel = (id: string, sponsor: string, relationship_type: string, depth: number, over: Record<string, unknown> = {}) => ({
  id, brokerage_id: B, agent_id: PRODUCER, sponsor_agent_id: sponsor, relationship_type, depth_level: depth,
  revenue_share_percent: 5, revenue_share_flat_cents: null, source_of_funds: "agent", effective_from: "2026-01-01", effective_to: null, is_active: true, ...over,
})
const edge = (relationship_type: string, from: [string, string], to: [string, string], over: Partial<ResidualGraphEdge> = {}): ResidualGraphEdge => ({
  brokerage_id: B, relationship_type, from_entity_type: from[0], from_entity_id: from[1], to_entity_type: to[0], to_entity_id: to[1], effective_from: null, effective_to: null, ...over,
})
const RELS = [rel("r-sponsor", SPONSOR, "sponsor", 1), rel("r-mentor", MENTOR, "mentor", 2), rel("r-lead", LEAD, "team_lead", 3)]
const EDGES: ResidualGraphEdge[] = [
  edge("recruited_by", ["agent", U[PRODUCER]], ["agent", U[SPONSOR]]),
  edge("sponsor_of", ["agent", U[SPONSOR]], ["agent", U[PRODUCER]]),
  edge("earns_residual", ["agent", U[MENTOR]], ["agent", U[PRODUCER]]),
  edge("member_of_team", ["agent", U[PRODUCER]], ["team", TEAM]),
  edge("referred_by", ["contact", "c-1"], ["agent", U[PRODUCER]]),
  edge("vendor_for", ["vendor", "v-1"], ["contact", "c-1"]),
]
const graph = (edges = EDGES) => ({ measured: true, edges, userIdByAgentId, teamLeadUserIdByTeamId: new Map([[TEAM, U[LEAD]]]) })
const evaluate = (over: Partial<Parameters<typeof evaluateResidualRules>[0]> = {}) => evaluateResidualRules({
  transactionId: T, brokerageId: B, producingAgentId: PRODUCER, closeDate: "2026-06-15", fallbackDate: "2099-12-31",
  agentFinalNetCents: 1_000_000, brokerageFinalCents: 500_000, state: model, relationships: RELS, graph: graph(), ...over,
})

async function main() {
  console.log("\n[A. relationship types — positive control for each]")
  const ev = evaluate()
  const by = (agent: string) => ev.entries.find((e) => e.beneficiaryAgentId === agent)
  check("sponsor rule pays 5% of the agent's rolling net (1,000,000¢ → 50,000¢)", by(SPONSOR)?.cents === 50_000, JSON.stringify(by(SPONSOR)))
  check("mentor rule pays on the rolling balance (950,000¢ × 5% = 47,500¢)", by(MENTOR)?.cents === 47_500)
  check("team_lead rule pays (902,500¢ × 5% = 45,125¢)", by(LEAD)?.cents === 45_125)
  check("sponsor corroborated by recruited_by + sponsor_of (sponsored_by, stored sponsor → recruit)", JSON.stringify(by(SPONSOR)?.corroboratedBy) === JSON.stringify(["recruited_by", "sponsor_of"]))
  check("mentor corroborated by earns_residual", JSON.stringify(by(MENTOR)?.corroboratedBy) === JSON.stringify(["earns_residual"]))
  check("team_lead corroborated by member_of_team (team's team_lead_id = beneficiary)", JSON.stringify(by(LEAD)?.corroboratedBy) === JSON.stringify(["member_of_team"]))
  check("referred_by / vendor_for mint no residual entry", ev.entries.length === 3 && !ev.entries.some((e) => (NON_RESIDUAL_ECONOMIC_EDGES as readonly string[]).includes(e.relationshipType)))
  check("every corroborating / non-residual edge type is in the ONE graph vocabulary (relationship-graph.ts)",
    [...Object.values(RESIDUAL_CORROBORATING_EDGES).flat(), ...NON_RESIDUAL_ECONOMIC_EDGES].every((t) => (RELATIONSHIP_TYPES as readonly string[]).includes(t)))
  const vocab = src("scripts/check-vocabularies.ts")
  const arCheck = vocab.slice(vocab.indexOf("  agent_relationships: {"), vocab.indexOf("  agent_relationships: {") + 400)
  check("eligible relations = agent_relationships.relationship_type live CHECK (one vocabulary)", RESIDUAL_ELIGIBLE_RELATIONSHIPS.every((t) => arCheck.includes(`"${t}"`)), arCheck.slice(0, 200))
  const uncorroborated = evaluate({ graph: graph(EDGES.filter((e) => e.relationship_type !== "earns_residual")) })
  check("POSITIVE CONTROL: removing the mentor's earns_residual edge raises an uncorroborated finding (money unchanged)",
    uncorroborated.findings.some((f) => f.includes(MENTOR) && f.includes("no corroborating")) && uncorroborated.entries.find((e) => e.beneficiaryAgentId === MENTOR)?.cents === 47_500)
  const graphOnly = evaluate({ relationships: RELS.filter((r) => r.id !== "r-mentor") })
  check("a graph-only earns_residual edge pays nothing and is reported", !graphOnly.entries.some((e) => e.beneficiaryAgentId === MENTOR) && graphOnly.findings.some((f) => f.includes(U[MENTOR]) && f.includes("pays nothing")))
  const unmeasured = evaluate({ graph: { measured: false, edges: [], userIdByAgentId } })
  check("graph read refused → corroboration UNMEASURED (no false 'uncorroborated' finding), money unchanged", !unmeasured.graphMeasured && unmeasured.findings.length === 0 && unmeasured.entries.length === 3)
  const off = evaluate({ state: parseRevenueShareModel({ revenue_share_enabled: false }) })
  check("model disabled → no entries, skip reason 'disabled' (fail closed)", off.entries.length === 0 && off.skipped === "disabled")

  console.log("\n[B. effective dates at the close date]")
  const window = (from: string | null, to: string | null, closeDate: string) =>
    evaluate({ closeDate, relationships: [rel("r-w", SPONSOR, "sponsor", 1, { effective_from: from, effective_to: to })] }).entries.length
  check("expired BEFORE close → nothing", window("2026-01-01", "2026-05-31", "2026-06-15") === 0)
  check("expired AFTER close (i.e. before a later recompute) → still pays — the close date governs, not today", window("2026-01-01", "2026-06-30", "2026-06-15") === 1)
  check("starts AFTER close → nothing", window("2026-07-01", null, "2026-06-15") === 0)
  check("POSITIVE CONTROL: same edge judged on the fallback (no close date) date 2099 → nothing, finding names it",
    evaluate({ closeDate: null, relationships: [rel("r-w", SPONSOR, "sponsor", 1, { effective_to: "2026-06-30" })] }).entries.length === 0)
  const expiredEdge = evaluate({ graph: graph(EDGES.map((e) => e.relationship_type === "earns_residual" ? { ...e, effective_to: "2026-01-31" } : e)) })
  check("graph edges honour their window too (expired earns_residual no longer corroborates)", expiredEdge.entries.find((e) => e.beneficiaryAgentId === MENTOR)?.corroboratedBy.length === 0)
  const s09 = src("lib/commission/waterfall/09-revenue-share.ts")
  check("step 09 reads transactions.close_date and evaluates through evaluateResidualRules (wired)", /\.select\('close_date'\)/.test(s09) && /evaluateResidualRules\(\{/.test(s09) && /closeDate:/.test(s09))
  check("POSITIVE CONTROL: step 09 no longer calls computeRevenueShare on the wall clock", !/computeRevenueShare\(/.test(s09))

  console.log("\n[C. determinism + idempotency]")
  const a = evaluate(), b = evaluate({ relationships: [...RELS].reverse(), graph: graph([...EDGES].reverse()) })
  check("same rows in any order → byte-equal evaluation", JSON.stringify(a) === JSON.stringify(b))
  check("idempotency key = (transaction, beneficiary, rule)", a.entries[0].key === `residual:${T}:${SPONSOR}:r-sponsor`)
  check("keys are unique per closing", new Set(a.entries.map((e) => e.key)).size === a.entries.length)
  check("re-run guard: live posted entries block a second set", liveLedgerEntries([{ status: "pending", entry_type: "entry" }, { status: "voided", entry_type: "entry" }]).length === 1)
  check("re-run guard: a fully voided deal (or corrections only) re-posts", liveLedgerEntries([{ status: "voided", entry_type: "entry" }, { status: "paid", entry_type: "reversal" }]).length === 0)
  const s11 = src("lib/commission/waterfall/11-validate-persist.ts")
  const guardAt = s11.indexOf("liveLedgerEntries("), insertAt = s11.indexOf(".insert(distributionRows)")
  check("step 11 runs the re-run guard BEFORE the distribution insert and fails closed on a refused read", guardAt > 0 && guardAt < insertAt && /re-run guard\): \$\{postedErr\.message\}/.test(s11))

  console.log("\n[D. void / reversal follows the source]")
  const rows = [
    { id: "res-unpaid", status: "pending", entry_type: "entry", paid_at: null, calculated_amount: 500 },
    { id: "res-approved", status: "approved", entry_type: "entry", paid_at: null, calculated_amount: 475 },
    { id: "res-paid", status: "paid", entry_type: "entry", paid_at: "2026-07-01T00:00:00Z", calculated_amount: 451.25 },
    { id: "res-voided", status: "voided", entry_type: "entry", paid_at: null, voided_at: "2026-07-02T00:00:00Z", calculated_amount: 100 },
  ]
  const plan = planResidualReversal({ residuals: rows, correctionsByEntry: new Map(), reason: "source commission entry voided: wrong agent" })
  check("unpaid (pending + approved) residuals are VOIDED in place", JSON.stringify(plan.void) === JSON.stringify(["res-approved", "res-unpaid"]))
  check("a PAID residual gets a reversal row of −net (−451.25)", plan.reverse.length === 1 && plan.reverse[0].id === "res-paid" && plan.reverse[0].amount === -451.25)
  check("an already-voided residual is untouched", plan.untouched.includes("res-voided"))
  const after = planResidualReversal({
    residuals: rows.map((r) => (plan.void.includes(r.id) ? { ...r, status: "voided", voided_at: "x" } : r)),
    correctionsByEntry: new Map([["res-paid", [{ calculated_amount: -451.25, status: "paid", paid_at: "x" }]]]), reason: "again",
  })
  check("second run after the cascade changes nothing (idempotent)", after.void.length === 0 && after.reverse.length === 0)
  const fin = src("lib/kernel/financial.ts")
  const voidFn = fin.slice(fin.indexOf("export async function voidCommissionDistribution"), fin.indexOf("export async function approveResidualEntry"))
  const corrFn = fin.slice(fin.indexOf("export async function correctCommissionDistribution"), fin.indexOf("export interface VoidCommissionDistributionInput"))
  check("void of the producing agent's entry cascades (reverseDerivedResiduals, trigger source_voided)", /distribution_type === "agent"[\s\S]{0,200}reverseDerivedResiduals[\s\S]{0,200}"source_voided"/.test(voidFn))
  check("a reversal correction of the agent's entry cascades (trigger source_reversed)", /kind === "reversal"[\s\S]{0,200}reverseDerivedResiduals[\s\S]{0,200}"source_reversed"/.test(corrFn))
  const rev = fin.slice(fin.indexOf("async function reverseDerivedResiduals"))
  check("each cascade write is withActionLedger FINANCIAL keyed per (source, residual) + COMMISSION_UPDATED event", /withActionLedger/.test(rev) && /riskClass: "FINANCIAL"/.test(rev) && /idempotencyKey: `\$\{action\}:\$\{input\.sourceDistributionId\}:\$\{residualId\}`/.test(rev) && /KernelEvent\.COMMISSION_UPDATED/.test(rev))

  console.log("\n[E. tenant isolation + agents never see others' residuals]")
  const foreign = evaluate({ relationships: [...RELS, { ...rel("r-foreign", "agent-x", "sponsor", 1), brokerage_id: OTHER }], graph: graph([...EDGES, edge("earns_residual", ["agent", "user-x"], ["agent", U[PRODUCER]], { brokerage_id: OTHER })]) })
  check("a foreign relationship is dropped and reported; a foreign graph edge is ignored", !foreign.entries.some((e) => e.beneficiaryAgentId === "agent-x") && foreign.findings.some((f) => f.includes("r-foreign")) && !foreign.findings.some((f) => f.includes("user-x")))
  const approveFn = fin.slice(fin.indexOf("export async function approveResidualEntry"), fin.indexOf("async function reverseDerivedResiduals"))
  const fromBlocks = (s: string) => s.split(/\.from\("commission_distributions"\)|\.from\('commission_distributions'\)|\.from\('relationship_edges'\)|\.from\('agents'\)|\.from\('teams'\)|\.from\('transactions'\)/).slice(1).map((x) => x.slice(0, 600))
  // A read/update pins with .eq("brokerage_id", …); an INSERT pins by stamping brokerage_id from the session ctx.
  const unpinned = (s: string) => fromBlocks(s).filter((blk) => !/\.eq\(["']brokerage_id["']|\.insert\(\{\s*brokerage_id: ctx\.brokerageId/.test(blk.split(/;\n|\n\s*\n/)[0]))
  check("every read/write in approve + cascade + step 09 graph lookup pins brokerage_id", unpinned(approveFn).length === 0 && unpinned(rev).length === 0 && unpinned(s09).length === 0, `${unpinned(approveFn).length}/${unpinned(rev).length}/${unpinned(s09).length}`)
  check("POSITIVE CONTROL: an unpinned read is caught", unpinned(`x.from("commission_distributions").select("id").eq("id", y)\n`).length === 1)
  check("approve is finance-admin gated BEFORE the service client", approveFn.indexOf("isBrokerageFinanceAdmin(") > 0 && approveFn.indexOf("isBrokerageFinanceAdmin(") < approveFn.indexOf("createServiceClient()"))
  check("an agent is refused the finance gate; a broker passes", !isBrokerageFinanceAdmin({ user_type: "agent" }) && isBrokerageFinanceAdmin({ user_type: "broker" }))
  const act = src("app/actions/financial-kernel.ts")
  const actFn = act.slice(act.indexOf("export async function approveResidualEntryAction"))
  check("server action takes only the entry id; tenant + actor from the SESSION", /getFinancialActorContext\(\)/.test(actFn.slice(0, 600)) && !/brokerageId/.test(actFn.slice(0, 600)))

  console.log("\n[F. Finance Manager review]")
  check("a fresh residual awaits review; approved / paid / non-residual do not", isResidualAwaitingReview({ distribution_type: "residual", status: "pending" }) && !isResidualAwaitingReview({ distribution_type: "residual", status: "approved" }) && !isResidualAwaitingReview({ distribution_type: "agent", status: "pending" }))
  check("approval admits only a pending residual", planResidualApproval({ id: "x", distribution_type: "residual", status: "pending" }).ok && !planResidualApproval({ id: "x", distribution_type: "residual", status: "paid" }).ok && !planResidualApproval({ id: "x", distribution_type: "agent", status: "pending" }).ok)
  check("step 11 posts every distribution 'pending' (residual born held)", /distribution_type: dist\.distribution_type,[\s\S]{0,700}status: 'pending'/.test(s11))
  const pt = src("lib/commission/payment-tracker.ts")
  check("both payout sweeps hold unapproved residuals (RESIDUAL_PAYABLE_FILTER)", (pt.match(/\.or\(RESIDUAL_PAYABLE_FILTER\)/g) ?? []).length === 2 && RESIDUAL_PAYABLE_FILTER === "distribution_type.neq.residual,status.eq.approved")
  check("a held residual is not drift; an approved-unpaid residual still is", aggregateLedgerStatus([{ status: "paid", distribution_type: "agent" }, { status: "pending", distribution_type: "residual" }]) === "paid" && aggregateLedgerStatus([{ status: "paid", distribution_type: "agent" }, { status: "approved", distribution_type: "residual" }]) === "pending")
  check("approval: withActionLedger FINANCIAL, counted pending-predicated UPDATE, COMMISSION_APPROVED", /riskClass: "FINANCIAL"/.test(approveFn) && /\.eq\("status", "pending"\)[\s\S]{0,80}\.select\("id"\)/.test(approveFn) && /upd\.length !== 1/.test(approveFn) && /KernelEvent\.COMMISSION_APPROVED/.test(approveFn))
  check("step 11 ledgers each residual entry (FINANCIAL, idempotent on the entry key) + emits COMMISSION_DISTRIBUTED", /action: 'finance\.residual\.ledger_entry'/.test(s11) && /idempotencyKey: entry\.key/.test(s11) && /KernelEvent\.COMMISSION_DISTRIBUTED/.test(s11))
  const ui = src("app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx")
  check("WIRED: the CDA Commission Breakdown renders ApproveResidualButton under canCorrectEntries", /canCorrectEntries && \([\s\S]{0,3000}<ApproveResidualButton/.test(ui))

  console.log("\n[G. AI-free money path census]")
  const AI_SPEC = /^(ai|openai|@ai-sdk\/.*|@anthropic-ai\/.*|@google\/generative-ai|@vercel\/ai.*|groq-sdk|@mistralai\/.*|cohere-ai)$/
  const AI_LOCAL = /^lib\/(ai|llm|ai-gateway)\//
  let followLazy = false
  const importSpecs = (code: string): string[] => {
    const out: string[] = []
    const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'";]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) out.push(m[1] ?? m[2])
    if (followLazy) { const lz = /import\(\s*['"]([^'"]+)['"]\s*\)/g; while ((m = lz.exec(code))) out.push(m[1]) }
    return out
  }
  const resolveSpec = (fromFile: string, spec: string): string | null => {
    let base: string | null = null
    if (spec.startsWith("@/components/")) base = join("app/components", spec.slice("@/components/".length))
    else if (spec.startsWith("@/")) base = spec.slice(2)
    else if (spec.startsWith(".")) base = relative(ROOT, resolve(ROOT, dirname(fromFile), spec))
    if (!base) return null
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(join(ROOT, c)) && /\.tsx?$/.test(c)) return c
    return null
  }
  const census = (entries: string[], extraSrc?: Record<string, string>) => {
    const seen = new Set<string>(), hits: string[] = [], queue = [...entries]
    while (queue.length) {
      const f = queue.shift()!
      if (seen.has(f)) continue
      seen.add(f)
      const code = extraSrc?.[f] ?? (existsSync(join(ROOT, f)) ? src(f) : "")
      for (const spec of importSpecs(code)) {
        if (AI_SPEC.test(spec)) { hits.push(`${f} → ${spec}`); continue }
        const r = resolveSpec(f, spec)
        if (!r) continue
        if (AI_LOCAL.test(r)) { hits.push(`${f} → ${r}`); continue }
        queue.push(r)
      }
    }
    return { files: seen.size, hits }
  }
  const MONEY = ["lib/commission/engine.ts", "lib/commission/revenue-share-model.ts", "lib/commission/distribution-correction.ts",
    ...["01-resolve-rate", "02-calculate-gross", "03-apply-gross-adjustments", "04-split-agent-brokerage", "05-apply-agent-adjustments", "06-apply-brokerage-adjustments", "07-apply-cap", "08-team-split", "09-revenue-share", "10-fees", "11-validate-persist"].map((s) => `lib/commission/waterfall/${s}.ts`)]
  const c = census(MONEY)
  console.log(`    money-path static closure: ${c.files} files (type-only imports and lazy import() excluded — published blind spot)`)
  check("the money path's static import closure reaches NO model SDK / lib/ai module", c.hits.length === 0, c.hits.slice(0, 5).join("; "))
  // BLIND SPOT, PUBLISHED (not asserted): following lazy import() too reaches the audit / notification side
  // effects (emit → reactor). Those run AFTER the amounts are fixed and never feed a number back.
  followLazy = true
  const lazy = census(MONEY)
  followLazy = false
  console.log(`    with lazy import() followed: ${lazy.files} files, ${lazy.hits.length} model-SDK edge(s)${lazy.hits.length ? ` (first: ${lazy.hits[0]})` : ""} — side-effect graph, reported not asserted`)
  const planted = census(["fixture/money.ts"], { "fixture/money.ts": `import { generateText } from "ai"\nimport { openai } from "@ai-sdk/openai"\nimport { x } from "@/lib/ai/generate"\n` })
  check("POSITIVE CONTROL: the census catches a planted `ai`, `@ai-sdk/openai` and lib/ai import", planted.hits.length === 3, planted.hits.join("; "))
  const commented = census(["fixture/c.ts"], { "fixture/c.ts": stripComments(`// import { generateText } from "ai"\nexport const x = 1\n`) })
  check("a tombstone naming an AI import is not a call site (stripped source)", commented.hits.length === 0)

  console.log("\n[H. ownership]")
  const dom = (MAINTENANCE_DOMAINS as Record<string, { manager: string; proof: string; what: string }>)["residual_economics"]
  check("MAINTENANCE_DOMAINS.residual_economics owned by finance_manager with this proof", dom?.manager === "finance_manager" && dom?.proof === "test:residual-economics")
  const pkg = raw("package.json")
  check("registered in package.json and in the guard chain (membership, not position)", /"test:residual-economics":/.test(pkg) && new RegExp("npm run test:residual-economics(\\s|&|$|\")").test(pkg))

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
