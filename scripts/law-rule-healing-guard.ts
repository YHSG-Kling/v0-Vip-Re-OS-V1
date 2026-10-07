#!/usr/bin/env tsx
/**
 * scripts/law-rule-healing-guard.ts   (npm run test:law-rule-healing) — no network, no DB (in-memory client + seams).
 *
 * WAVE 138 (lane 138C) — LAW-RULE SELF-HEALING + the compliance / coaching capabilities.
 * Owner: compliance_officer. Co-owners named in prose: data_steward (state_protected_classes, the rows the loop
 * writes, and the jurisdiction reads) and recruiting_manager (the agent_coaching_assign capability).
 *
 * WHAT IT ASSERTS (the RULE, never a waypoint):
 *   A  the registry: every code rule declares jurisdiction, primary citations, scope, strictness and an
 *      implementing file that exists; a state row projects with defaults; verification evidence overlays.
 *   B  jurisdictions are DERIVED from tenant rows (brokerage / territory / license states), never listed —
 *      the two modules carry no quoted state code in stripped source (NEGATIVE CONTROL: a planted one is
 *      caught) and both sit in the location-literal census.
 *   C  gap + staleness detection (missing scope; never-verified / old rule stale; POSITIVE CONTROL: a fresh one is not).
 *   D  citations required: an uncited draft is refused at draft AND at resolution; only .gov / .us count.
 *   E  STRICTER-ONLY auto-enable in WARN mode (POSITIVE CONTROL) — the written row is warn / law_rule_healing,
 *      cited, with evidence; ledgered (compliance.law_rule.enable, COMPLIANCE_NOTICE); audit event; research metered.
 *   F  a LOOSENING, a MONEY touch and an AMBIGUOUS draft each become a law_rule proposal (a human) — never a write.
 *   G  the research cost cap and the entitlement gate hold (fail closed); an unreadable registry drafts nothing.
 *   H  no model-authored text reaches a licensed appraiser: the law-rule modules and the two capability workers
 *      import no model helper and touch no vendor table (NEGATIVE CONTROL planted); the appraiser rule still refuses.
 *   I  the proposal kernel: law_rule is owner-level, an uncited draft FAILS evaluation, a manager never promotes it,
 *      a human admin may; approval writes ENFORCE through applyLawRuleProposal; a code-gate loosening is refused.
 *   J  the new capabilities are OWNED and DELEGABLE: registry + owner + worker, the strategy gaps closed, the
 *      latest CHECK definer holds every capability key (derived), voice-withheld, coaching worker tenant-scoped.
 *   K  wiring + registration: the weekly cron runs the loop; its cron owner is compliance_officer; package chain
 *      membership; MAINTENANCE_DOMAINS owner + co-owners in prose.
 *
 * BLIND SPOTS (published): the research rail is faked (no live search is proven here); the evaluator's warn branch
 * is asserted on stripped source (state-fair-housing.ts is server-only); the coaching worker's happy path runs the
 * adaptive development cycle, proven by test:adaptive-development, not re-run here.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import {
  CODE_LAW_RULES, LAW_RULE_SCOPES, FEDERAL_JURISDICTION, LAW_RULE_STALE_DAYS, buildLawRuleRegistry,
  deriveTenantJurisdictions, detectLawRuleGaps, isPrimarySourceUrl, draftLawRule, resolveLawRuleDraft, type LawRuleDraft,
} from "../lib/compliance-rules/law-rule-registry"
import { runLawRuleHealing, applyLawRuleProposal } from "../lib/kernel/law-rule-healing"
// The ledger's action grammar (domain.entity.action) — the names the loop writes and its registry reads back.
const LAW_RULE_ACTION = { verify: "compliance.law_rule.verify", enable: "compliance.law_rule.enable", propose: "compliance.law_rule.propose" } as const
import { PROPOSAL_SUBJECT_KINDS, PROPOSERS, PROPOSAL_AUTHORITY, OWNER_AUTHORITY_LEVEL, evaluateImprovement, promotionDecision } from "../lib/kernel/improvement-proposals"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "../lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { DELEGATION_WORKERS } from "../lib/kernel/manager-delegation"
import { PLATFORM_STRATEGY_LIBRARY } from "../lib/kernel/strategy-library"
import { VOICE_WITHHELD } from "../lib/voice-admin/kernel-command-surface"
import { modelAuthoredToVendorVerdict } from "../lib/vendors/appraiser-independence"
import { MAINTENANCE_DOMAINS, CRON_MANAGER } from "../lib/kernel/manager-registry"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

// ── the in-memory client (select / eq / in / is / order / limit / insert / update / maybeSingle) ──
type Row = Record<string, any>
function mem(tables: Record<string, Row[]>, refuse: Set<string> = new Set()) {
  let seq = 0
  const writes: Array<{ table: string; op: string; payload: any }> = []
  function from(table: string) {
    const rows = (tables[table] ??= [])
    const filters: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" = "select", payload: any = null, lim = Infinity
    const exec = async (): Promise<{ data: any; error: any }> => {
      if (refuse.has(table)) return { data: null, error: { message: `refused ${table}` } }
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: `row-${++seq}`, ...p }))
        rows.push(...list); writes.push({ table, op, payload }); return { data: list, error: null }
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      if (op === "update") { for (const r of hit) Object.assign(r, payload); writes.push({ table, op, payload }); return { data: hit.map((r) => ({ id: r.id })), error: null } }
      return { data: hit.slice(0, lim), error: null }
    }
    const api: any = {
      select: () => api, order: () => api, limit: (n: number) => { lim = n; return api },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return api },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return api },
      insert: (p: unknown) => { op = "insert"; payload = p; return api },
      update: (p: unknown) => { op = "update"; payload = p; return api },
      maybeSingle: async () => { const r = await exec(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } },
      then: (res: any, rej: any) => exec().then(res, rej),
    }
    return api
  }
  return { from, tables, writes }
}

// Fixture jurisdiction codes are DELIBERATELY not real states (the rule is derivation, not a list).
const J1 = "QX", J2 = "QY"
const BROKERAGE = "b-1"
const GOV = (p: string) => `https://legislature.example.gov/${p}`

function seams(opts: { hits: (query: string) => Array<{ title: string; url: string; snippet: string }>; afford?: boolean; budgetUsd?: number; maxCalls?: number }) {
  const ledgered: any[] = [], emitted: any[] = [], metered: any[] = [], proposals: any[] = []
  return {
    ledgered, emitted, metered, proposals,
    deps: {
      now: new Date("2026-10-07T12:00:00Z"),
      budgetUsd: opts.budgetUsd, maxCalls: opts.maxCalls,
      afford: async () => ({ allowed: opts.afford !== false, reason: opts.afford === false ? "past_due" : "ok" }),
      search: async ({ query }: { query: string }) => ({ answer: null, hits: opts.hits(query), provider: "tavily", cost: 0.01 }),
      meter: async (i: any) => { metered.push(i); return true },
      propose: async (_svc: unknown, i: any) => { proposals.push(i); return { ok: true, id: `prop-${proposals.length}`, existing: false } },
      ledger: (async (ctx: any, run: () => Promise<any>, hooks: any) => { const r = await run(); ledgered.push({ ctx, settle: hooks.settle(r) }); return r }) as any,
      emit: async (i: any) => { emitted.push(i); return { inserted: true } },
    },
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Law-rule self-healing + compliance / coaching capabilities")
  console.log("══════════════════════════════════════════════════")

  console.log("\nA. the registry")
  check("A1 every code rule declares jurisdiction, ≥1 PRIMARY citation, a known scope, strictness and an existing implementing file",
    CODE_LAW_RULES.length > 0 && CODE_LAW_RULES.every((r) => r.jurisdiction === FEDERAL_JURISDICTION && r.citations.length > 0 && r.citations.every((c) => isPrimarySourceUrl(c.url)) && (LAW_RULE_SCOPES as readonly string[]).includes(r.scope) && !!r.strictness && existsSync(join(ROOT, r.file))),
    CODE_LAW_RULES.filter((r) => !existsSync(join(ROOT, r.file))).map((r) => r.file).join(", "))
  const projected = buildLawRuleRegistry([{ id: "s1", state_code: J1.toLowerCase(), protected_class: "source of income", regulation_reference: "Code §1" }]).find((r) => r.rowId === "s1")!
  check("A2 a pre-m744 state row projects with honest defaults (advertising / enforce / seed / never verified)", projected.jurisdiction === J1 && projected.scope === "advertising" && projected.enforcement === "enforce" && projected.provenance === "seed" && projected.lastVerifiedAt === null && projected.citations.length === 1)
  const withVer = buildLawRuleRegistry([], { "us.advertising.x": "2026-01-01T00:00:00Z", [CODE_LAW_RULES[0].key]: "2026-09-01T00:00:00Z" })
  check("A3 ledger verification evidence overlays a rule's last verified", withVer.find((r) => r.key === CODE_LAW_RULES[0].key)?.lastVerifiedAt === "2026-09-01T00:00:00Z")

  console.log("\nB. jurisdictions are derived, never listed")
  const derived = deriveTenantJurisdictions({ brokerageState: J1.toLowerCase(), territoryStates: [J2, null, "", "not-a-state"], licenseStates: [J1] })
  check("B1 federal + every two-letter state the tenant's own rows name (deduped, sorted, junk dropped)", JSON.stringify(derived) === JSON.stringify([FEDERAL_JURISDICTION, J1, J2]), JSON.stringify(derived))
  check("B2 a tenant with no state data operates under federal law only", JSON.stringify(deriveTenantJurisdictions({})) === JSON.stringify([FEDERAL_JURISDICTION]))
  const QUOTED_CODE = /["'`](A[LKZR]|C[AOT]|DE|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|DC)["'`]/
  const MODS = ["lib/compliance-rules/law-rule-registry.ts", "lib/kernel/law-rule-healing.ts"]
  const leaks = MODS.filter((m) => QUOTED_CODE.test(stripComments(src(m))))
  check("B3 neither law-rule module carries a quoted state code (stripped source)", leaks.length === 0, leaks.join(", "))
  check("B4 NEGATIVE CONTROL — a planted quoted state code IS caught", QUOTED_CODE.test(stripComments(src(MODS[0]) + `\nconst x = "TX"\n`)))
  const census = stripComments(src("scripts/location-literal-census-guard.ts"))
  check("B5 both modules sit in the location-literal census (test:location-literal-census holds them to zero)", MODS.every((m) => census.includes(`"${m}"`)))
  const heal = stripComments(src("lib/kernel/law-rule-healing.ts"))
  check("B6 the loader reads the tenant's own state, active territories and license states", /from\("brokerages"\)\.select\("state"\)/.test(heal) && /from\("farm_territories"\)\.select\("state"\)/.test(heal) && /from\("agent_licenses"\)\.select\("license_state"\)/.test(heal))

  console.log("\nC. gap + staleness detection")
  const now = new Date("2026-10-07T12:00:00Z")
  const fresh = new Date(now.getTime() - 10 * 86_400_000).toISOString()
  const old = new Date(now.getTime() - (LAW_RULE_STALE_DAYS + 5) * 86_400_000).toISOString()
  const reg = buildLawRuleRegistry([
    { id: "r1", state_code: J1, protected_class: "marital status", regulation_reference: "Code §2", last_verified_at: old },
    { id: "r2", state_code: J1, protected_class: "ancestry", regulation_reference: "Code §3", last_verified_at: fresh },
  ], Object.fromEntries(CODE_LAW_RULES.map((r) => [r.key, fresh])))
  const gaps = detectLawRuleGaps(reg, [FEDERAL_JURISDICTION, J1], now)
  check("C1 a state with only advertising rows is MISSING licensing / agency / disclosures", ["licensing", "agency", "disclosures"].every((s) => gaps.some((g) => g.kind === "missing" && g.jurisdiction === J1 && g.scope === s)) && !gaps.some((g) => g.kind === "missing" && g.jurisdiction === J1 && g.scope === "advertising"))
  check("C2 a rule verified longer ago than the window is STALE", gaps.some((g) => g.kind === "stale" && g.ruleKey === "qx.advertising.marital_status"))
  check("C3 POSITIVE CONTROL — a freshly verified rule is NOT stale; verified federal code rules raise nothing", !gaps.some((g) => g.ruleKey === "qx.advertising.ancestry") && !gaps.some((g) => g.jurisdiction === FEDERAL_JURISDICTION))

  console.log("\nD. citations are required")
  const blog = [{ title: "A blog", url: "https://realestate-blog.com/post", snippet: "source of income is protected" }]
  const uncited = draftLawRule({ kind: "missing", jurisdiction: J2, scope: "advertising", why: "" }, blog, reg)
  check("D1 a draft from non-primary hits is REFUSED as uncited", !uncited.ok && uncited.reason === "uncited")
  const fake: LawRuleDraft = { key: "qy.advertising.age", jurisdiction: J2, scope: "advertising", name: "age", change: "add", patterns: [], citations: [], effectiveDate: null, executable: true, touchesMoney: false, evidence: "" }
  check("D2 resolution refuses a draft with no citation (even if it were otherwise stricter)", resolveLawRuleDraft(fake, reg).route === "refused")
  check("D3 only government publishers are primary (.gov / .us); commentary is not", isPrimarySourceUrl(GOV("x")) && isPrimarySourceUrl("https://www.ecfr.gov/x") && isPrimarySourceUrl("https://legis.state.example.us/x") && !isPrimarySourceUrl("https://law.example.com/x") && !isPrimarySourceUrl("javascript:alert(1)") && !isPrimarySourceUrl(null))

  console.log("\nE. stricter-only → auto-enable in WARN mode (positive control)")
  {
    // The federal code rules carry fresh verification memory in the LEDGER (the reader under test), so the one
    // research call this pass allows lands on the state's missing advertising scope.
    const verified = CODE_LAW_RULES.map((r) => ({ brokerage_id: BROKERAGE, action: LAW_RULE_ACTION.verify, status: "executed", subject_ref: r.key, created_at: "2026-10-01T00:00:00Z" }))
    const svc = mem({ brokerages: [{ id: BROKERAGE, state: J1 }], farm_territories: [], agent_licenses: [], state_protected_classes: [], agent_action_ledger: verified })
    const s = seams({ hits: (q) => q.includes(`state ${J1}`) && q.includes("advertising") ? [{ title: "Housing discrimination statute", url: GOV("housing"), snippet: "It is unlawful to discriminate because of source of income. Effective January 1, 2026." }] : [] , maxCalls: 1 })
    const r = await runLawRuleHealing(svc, BROKERAGE, s.deps as any)
    const row = svc.tables.state_protected_classes[0]
    check("E1 the missing advertising rule is drafted from the primary text and written", r.enabledWarn.length === 1 && !!row && row.protected_class === "source of income", JSON.stringify(r.status))
    check("E2 the written row is WARN mode, provenance law_rule_healing, cited, dated literally, with evidence", row?.enforcement_mode === "warn" && row?.provenance === "law_rule_healing" && Array.isArray(row?.source_citations) && row.source_citations[0]?.url === GOV("housing") && row?.effective_date === "2026-01-01" && !!row?.evidence?.query)
    const led = s.ledgered.find((l) => l.ctx.action === LAW_RULE_ACTION.enable)
    check("E3 ledgered: compliance.law_rule.enable by compliance_officer, COMPLIANCE_NOTICE, executed with the research cost", !!led && led.ctx.actor.managerKey === "compliance_officer" && led.ctx.reasonCode === "COMPLIANCE_NOTICE" && led.settle.status === "executed" && led.settle.costUsd === 0.01)
    check("E4 an audit kernel event names the row; the research spend is METERED to the tenant", s.emitted.some((e) => e.event === "law_rule.auto_enabled_warn" && e.auditOnly === true && e.entityId === row?.id) && s.metered.length === 1 && s.metered[0].brokerageId === BROKERAGE && s.metered[0].systemSource === "law_rule_healing")
    check("E5 nothing was proposed (a stricter-only addition needs no human) and the row never enforces", s.proposals.length === 0 && svc.tables.state_protected_classes.every((x) => x.provenance !== "law_rule_healing" || x.enforcement_mode === "warn"))
    const fh = stripComments(src("lib/compliance-rules/state-fair-housing.ts"))
    const warnBranch = /enforcement_mode === "warn"/.test(fh) && /warn \? "low"/.test(fh)
    check("E6 the evaluator flags a warn row at LOW severity (review, never fail) — stripped source", warnBranch)
    check("E7 NEGATIVE CONTROL — the same check fails when the warn cap is removed", !(/warn \? "low"/.test(fh.replace(/warn \? "low"/g, `warn ? "high"`))))
  }

  console.log("\nF. loosening / money / ambiguous → the compliance officer (a human)")
  {
    const svc = mem({ brokerages: [{ id: BROKERAGE, state: J1 }], farm_territories: [], agent_licenses: [], agent_action_ledger: [],
      state_protected_classes: [{ id: "old-1", state_code: J1, protected_class: "marital status", regulation_reference: "Code §2", is_active: true, last_verified_at: null }] })
    const s = seams({ maxCalls: 20, budgetUsd: 1, hits: (q) => {
      if (q.includes("United States federal") && q.includes("wire fraud")) return [{ title: "Safeguards rule", url: "https://www.ecfr.gov/part-314", snippet: "Firms must verify wire payment instructions before releasing escrow funds." }]
      if (q.includes(`state ${J1}`) && q.includes("license law")) return [{ title: "License law", url: GOV("license"), snippet: "Advertising must include the brokerage name." }]
      if (q.includes(`state ${J1}`) && q.includes("advertising")) return [{ title: "Marital status amendment", url: GOV("marital"), snippet: "The marital status provision was repealed." }]
      return []
    } })
    const r = await runLawRuleHealing(svc, BROKERAGE, s.deps as any)
    const by = (pred: (p: any) => boolean) => s.proposals.find(pred)
    check("F1 a LOOSENING (repealed) becomes a law_rule proposal, direction looser — the row is NOT deactivated", !!by((p) => p.subjectKind === "law_rule" && p.proposer === "law_rule_healing" && p.proposedChange.direction === "looser") && svc.tables.state_protected_classes[0].is_active === true)
    check("F2 a MONEY touch (wire / escrow) goes to the human", !!by((p) => p.proposedChange.draft.touchesMoney === true))
    check("F3 an AMBIGUOUS (non-executable) licensing rule goes to the human", !!by((p) => p.proposedChange.draft.scope === "licensing" && p.proposedChange.direction === "ambiguous"))
    check("F4 nothing was auto-enabled on this pass (no stricter-only executable draft), every proposal cites a primary source", r.enabledWarn.length === 0 && s.proposals.length >= 3 && s.proposals.every((p) => p.evidenceRefs.length > 0 && p.evidenceRefs.every((c: any) => isPrimarySourceUrl(c.url))))
    check("F5 each proposal is ledgered compliance.law_rule.propose", s.ledgered.filter((l) => l.ctx.action === LAW_RULE_ACTION.propose).length === s.proposals.length)
  }

  console.log("\nG. cost cap, entitlement, fail closed")
  {
    const base = () => mem({ brokerages: [{ id: BROKERAGE, state: J1 }], farm_territories: [], agent_licenses: [], state_protected_classes: [], agent_action_ledger: [] })
    const s1 = seams({ budgetUsd: 0.02, maxCalls: 50, hits: () => [] })
    const r1 = await runLawRuleHealing(base(), BROKERAGE, s1.deps as any)
    check("G1 the per-pass research budget caps the calls ($0.02 → 2 researched) and the rest are reported", r1.researched === 2 && r1.refused.some((x) => /budget/.test(x.why)), `${r1.researched}`)
    const s2 = seams({ afford: false, hits: () => [] })
    const r2 = await runLawRuleHealing(base(), BROKERAGE, s2.deps as any)
    check("G2 a tenant not entitled researches NOTHING (fail closed) and says why", r2.researched === 0 && /not entitled/.test(r2.status))
    const s3 = seams({ hits: () => [] })
    const r3 = await runLawRuleHealing(mem({ brokerages: [{ id: BROKERAGE, state: J1 }], farm_territories: [], agent_licenses: [], agent_action_ledger: [] }, new Set(["state_protected_classes"])), BROKERAGE, s3.deps as any)
    check("G3 an unreadable registry drafts nothing (fail closed)", r3.researched === 0 && /fail closed/.test(r3.status))
  }

  console.log("\nH. no model-authored text reaches a licensed appraiser")
  const MODEL = /@\/lib\/ai\/(generate|models)|\bgenerateText\b|\bstreamText\b|\bgenerateObject\b/
  const VENDOR = /from\("vendor[a-z_]*"\)|vendor_messages/
  const workers = stripComments(src("lib/kernel/manager-delegation.ts"))
  const wBlock = workers.slice(workers.indexOf("compliance_review: async"), workers.indexOf("export async function workDelegation"))
  const hSrc = [...MODS.map((m) => blankStrings(stripComments(src(m)))), wBlock]
  check("H1 the law-rule modules and the two capability workers import no model helper and touch no vendor table", hSrc.every((t) => !MODEL.test(t) && !VENDOR.test(t)) && wBlock.length > 100)
  check("H2 NEGATIVE CONTROL — a planted model import / vendor write IS caught", MODEL.test(`import { generateText } from "ai"`) && VENDOR.test(`svc.from("vendor_messages")`))
  check("H3 the appraiser rule still refuses model-authored text to an appraiser", modelAuthoredToVendorVerdict({ resolved: true, vendorCategories: ["appraiser"] }).ok === false)

  console.log("\nI. the proposal kernel")
  check("I1 law_rule / law_rule_healing are in the vocabularies and law_rule is owner-level (a human)", (PROPOSAL_SUBJECT_KINDS as readonly string[]).includes("law_rule") && (PROPOSERS as readonly string[]).includes("law_rule_healing") && PROPOSAL_AUTHORITY.law_rule === OWNER_AUTHORITY_LEVEL)
  const evUncited = await evaluateImprovement(null as any, { brokerage_id: BROKERAGE, subject_kind: "law_rule", subject_key: "law_rule:x", proposed_change: { draft: { citations: [{ url: "https://blog.com" }], change: "add" } } } as any)
  const evCited = await evaluateImprovement(null as any, { brokerage_id: BROKERAGE, subject_kind: "law_rule", subject_key: "law_rule:x", proposed_change: { draft: { citations: [{ url: GOV("a") }], change: "add" }, direction: "ambiguous" } } as any)
  check("I2 evaluation FAILS a non-primary-cited draft and leaves a cited one to the human (inconclusive)", evUncited.verdict === "fail" && evCited.verdict === "inconclusive")
  const asManager = promotionDecision({ status: "APPROVED", verdict: "inconclusive", authorityRequired: OWNER_AUTHORITY_LEVEL, actor: { type: "manager", managerKey: "compliance_officer" } as any, gate: { actorAuthority: 5 } as any })
  const asAdmin = promotionDecision({ status: "APPROVED", verdict: "inconclusive", authorityRequired: OWNER_AUTHORITY_LEVEL, actor: { type: "user", userId: "u", isTenantAdmin: true } as any })
  check("I3 a manager never promotes a law rule; a human on the admin roster may", !asManager.allow && asAdmin.allow)
  {
    const svc = mem({ state_protected_classes: [] })
    const draft: LawRuleDraft = { ...fake, citations: [{ title: "Code", url: GOV("c") }] }
    const w = await applyLawRuleProposal(svc, BROKERAGE, draft, "promote")
    const row = svc.tables.state_protected_classes[0]
    check("I4 an approved executable add lands in ENFORCE mode stamped compliance_officer", w.writer === "state_protected_classes.insert" && row?.enforcement_mode === "enforce" && row?.provenance === "compliance_officer")
    let threw = ""
    try { await applyLawRuleProposal(svc, BROKERAGE, { ...draft, change: "loosen", targetKey: CODE_LAW_RULES[0].key, targetRowId: undefined }, "promote") } catch (e) { threw = (e as Error).message }
    check("I5 a loosened CODE gate is never auto-applied — the approval is the review", /approval is the review/.test(threw))
  }

  console.log("\nJ. the new capabilities are owned and delegable")
  const NEW: Array<[AppCapability, string]> = [["compliance_review", "compliance_officer"], ["agent_coaching_assign", "recruiting_manager"]]
  check("J1 both are catalogue keys with their owners and a delegation worker each", NEW.every(([c, m]) => !!APP_CAPABILITY_REGISTRY[c] && CAPABILITY_MANAGER[c] === m && typeof DELEGATION_WORKERS[c] === "function"))
  check("J2 compliance_review is READ-ONLY (mutates false); coaching mutates (a learning assignment)", APP_CAPABILITY_REGISTRY.compliance_review.mutates === false && APP_CAPABILITY_REGISTRY.agent_coaching_assign.mutates === true)
  const strat = (k: string) => PLATFORM_STRATEGY_LIBRARY.find((s: any) => s.key === k) as any
  check("J3 the two 137E strategies now NAME the capabilities on their owners' steps — no gap left on those steps",
    strat("compliance_first_marketing")?.steps.some((x: any) => x.manager === "compliance_officer" && x.capabilities.includes("compliance_review") && !x.gap)
    && strat("agent_development_retention")?.steps.some((x: any) => x.manager === "recruiting_manager" && x.capabilities.includes("agent_coaching_assign") && !x.gap))
  const dir = join(ROOT, "supabase/migrations")
  const files = readdirSync(dir).filter((f) => /^m\d+.*\.sql$/.test(f)).sort((a, b) => Number(a.slice(1).split("-")[0]) - Number(b.slice(1).split("-")[0]))
  const latest = (re: RegExp) => { let hit: RegExpExecArray | null = null; for (const f of files) { const m = re.exec(stripComments(readFileSync(join(dir, f), "utf8"))); if (m) hit = m } return hit }
  const capCheck = latest(/manager_delegations_requested_capability_check\s*CHECK \(requested_capability IN \(([^)]*)\)/)
  const capList = capCheck ? [...capCheck[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  check("J4 the LATEST requested_capability CHECK definer holds EVERY catalogue key (derived superset)", (Object.keys(APP_CAPABILITY_REGISTRY) as string[]).every((k) => capList.includes(k)), (Object.keys(APP_CAPABILITY_REGISTRY)).filter((k) => !capList.includes(k)).join(", "))
  const notSelf = latest(/manager_delegations_not_self_check\s*CHECK \(([\s\S]*?)\);/)
  check("J5 the latest not-self CHECK admits the owners' work orders for both", !!notSelf && NEW.every(([c]) => notSelf[1].includes(`'${c}'`)))
  const sk = latest(/improvement_proposals_subject_kind_check\s*CHECK \(subject_kind IN \(([^)]*)\)/), pr = latest(/improvement_proposals_proposer_check\s*CHECK \(proposer IN \(([^)]*)\)/)
  check("J6 the latest improvement_proposals CHECK definers equal the code constants (superset rule)", !!sk && !!pr && JSON.stringify([...sk[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) === JSON.stringify([...PROPOSAL_SUBJECT_KINDS]) && JSON.stringify([...pr[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) === JSON.stringify([...PROPOSERS]))
  check("J7 both are voice-WITHHELD (worked only from an accepted delegation)", NEW.every(([c]) => (VOICE_WITHHELD as readonly string[]).includes(c)))
  {
    const svc = mem({ agents: [{ id: "a-other", user_id: "u2", brokerage_id: "b-2" }] })
    const r = await DELEGATION_WORKERS.agent_coaching_assign!(svc as any, { brokerage_id: BROKERAGE, input_entities: { agentId: "a-other" } } as any, { userId: null })
    const none = await DELEGATION_WORKERS.compliance_review!(svc as any, { brokerage_id: BROKERAGE, input_entities: {} } as any, { userId: null })
    check("J8 the coaching worker reads the agent WITH the delegation's tenant — another tenant's agent is not found", !r.ok && /not found in this brokerage/.test((r as any).reason))
    check("J9 the review worker refuses an empty ask (nothing reviewed blind)", !none.ok)
  }

  console.log("\nK. wiring + registration")
  const cron = stripComments(src("app/api/cron/regulatory-watcher/route.ts"))
  check("K1 the weekly regulatory cron runs the law-rule loop per tenant", /runLawRuleHealing\(supabase, b\.id\)/.test(cron))
  check("K2 the cron's owner is compliance_officer", CRON_MANAGER["/api/cron/regulatory-watcher"] === "compliance_officer")
  const ip = stripComments(src("lib/kernel/improvement-proposals.ts"))
  check("K3 an approved law_rule proposal is applied through applyLawRuleProposal (the human-gated door)", /case "law_rule": \{[\s\S]{0,400}applyLawRuleProposal/.test(ip))
  const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> }
  check("K4 package.json registers test:law-rule-healing and the guard chain runs it (membership, never a position)", !!pkg.scripts["test:law-rule-healing"] && new RegExp("npm run test:law-rule-healing(\\s|&|$)").test(pkg.scripts.guard))
  const dom = (MAINTENANCE_DOMAINS as Record<string, any>).law_rule_healing
  check("K5 MAINTENANCE_DOMAINS.law_rule_healing — owner compliance_officer, co-owners named in its prose", !!dom && dom.manager === "compliance_officer" && dom.proof === "test:law-rule-healing" && (dom.coOwners ?? []).every((c: string) => dom.what.includes(c)) && (dom.coOwners ?? []).length === 2)

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
