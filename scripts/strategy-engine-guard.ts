#!/usr/bin/env tsx
/**
 * scripts/strategy-engine-guard.ts   (npm run test:strategy-engine) — wave 107, lane 107E.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STRATEGY ENGINE + PLATFORM STRATEGY LIBRARY — in-memory client, no network. Proves
 * lib/kernel/strategy-library.ts (pure) + lib/kernel/strategy-engine.ts (runtime):
 *   A. the owner's eight seeds compose ONLY existing things: MANAGERS keys, APP_CAPABILITY_REGISTRY keys owned by
 *      the step's manager (CAPABILITY_MANAGER), playbook refs that resolve to real exports / CHECK vocabularies,
 *      RoiLedger outcome keys, STANDARD_TIMELINES buckets, the fatigue risk vocabulary; a step with no capability
 *      NAMES its gap; Seller Equity runs in the owner's order. Positive control: a mutated seed is caught.
 *   B. eligibility is deterministic and fails closed on an unknown fact (whenKnown aside); ranking is deterministic
 *   C. activation → a MISSION (approval per authority) + one 105A delegation per step capability another manager
 *      owns; idempotent; the mission controller resolves owner + bench from the strategy evidence
 *   D. the platform version is immutable (digest, frozen object, drift refused, m725 trigger) and the tenant
 *      adaptation (policy + history) is RECORDED on the activation; re-activation supersedes
 *   E. tenant isolation — another tenant's activations / missions are invisible
 *   F. wiring (stripped source — a tombstone is not a call site) + registration
 * Rules asserted, not waypoints: vocabularies are derived from their sources; no migration-state pin.
 */
import { readFileSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import {
  PLATFORM_STRATEGY_LIBRARY, OWNER_SEED_STRATEGY_KEYS, KERNEL_PLAY_REFS, STRATEGY_EVIDENCE_KIND,
  participatingManagers, strategyCapabilities, strategyGaps, platformStrategy, strategyDigest, evaluateEligibility,
  adaptStrategy, rankStrategies, factsFromContactRow, strategyOwnershipOf, HISTORY_MIN_SAMPLE,
  OS_DOMAINS, STRATEGY_DOMAINS, PLATFORM_STRATEGY_LIBRARY_EDITION,
  type StrategyDefinition, type StrategyCandidate, type StrategyHistory, type OsDomain,
} from "../lib/kernel/strategy-library"
import { PLATFORM_SKILL_EXAMPLES, PLATFORM_SKILL_EXAMPLE_REJECTS } from "../lib/kernel/platform-skill-examples"
type PlatformSkillExample = (typeof PLATFORM_SKILL_EXAMPLES)[number]
import { SKILL_RUN_RECEIPT_SCHEMA, SKILL_EVALUATORS, builtinSkill, validateSkillDeclaration } from "../lib/kernel/skill-registry"
/** The SAME gate the examples module applies at load (its stripped source is asserted to compose exactly these). */
const examineExample = (e: { declaration: Parameters<typeof validateSkillDeclaration>[0] }): string[] => [
  ...(builtinSkill(e.declaration.name) ? [`name_reserved_by_builtin:${e.declaration.name}`] : []),
  ...validateSkillDeclaration(e.declaration, { knownEvaluationSuites: new Set(Object.keys(SKILL_EVALUATORS)) }).errors,
]
import {
  selectStrategies, activateStrategy, activateLibraryStrategy, listStrategyLibrary, registerStrategyLearningSeam,
  type StrategyEngineDeps,
} from "../lib/kernel/strategy-engine"
import { MANAGERS, MAINTENANCE_DOMAINS, TABLE_MANAGER } from "../lib/kernel/manager-registry"
import { APP_CAPABILITY_REGISTRY } from "../lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { CREATIVE_PLAYBOOKS } from "../lib/marketing/creative-playbooks"
import { QUALIFICATION_GOALS } from "../lib/ai-isa/qualification-playbook"
import { EXPERIENCE_KINDS } from "../lib/ai-isa/lead-action-plan"
import { STANDARD_TIMELINES } from "../constants/crm-standards"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { MISSION_TYPES, type MissionDeps, type MissionRow } from "../lib/kernel/missions"
import { resolveOwnership } from "../lib/kernel/mission-controller"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import type { DelegationDeps } from "../lib/kernel/manager-delegation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client (manager-delegation-guard's) ──────────────────────────
type Row = Record<string, any>
function memClient(tables: Record<string, Row[]> = {}) {
  const t = (name: string) => (tables[name] ??= [])
  return {
    tables,
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" | "update" | "delete" = "select"
      let payload: Row | Row[] | null = null
      let limitN: number | null = null
      const run = (): { data: any; error: any } => {
        if (op === "insert") {
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...structuredClone(r) }))
          for (const r of rows) {
            if (table === "missions") Object.assign(r, { spent_usd: r.spent_usd ?? 0, spent_tokens: r.spent_tokens ?? 0, blockers: r.blockers ?? [], evidence: r.evidence ?? [], progress: r.progress ?? {}, actions: r.actions ?? [], outcomes: r.outcomes ?? [], state_changed_at: r.state_changed_at ?? r.created_at })
            if (table === "manager_delegations") Object.assign(r, { spent_usd: 0, spent_tokens: 0, evidence: [], result: null, state_changed_at: r.created_at, completed_at: null })
            if (table === "strategy_activations") Object.assign(r, { deactivated_at: r.deactivated_at ?? null })
            t(table).push(r)
          }
          return { data: rows.map((r) => structuredClone(r)), error: null }
        }
        const hits = t(table).filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of hits) Object.assign(r, structuredClone(payload)); return { data: hits.map((r) => structuredClone(r)), error: null } }
        if (op === "delete") { tables[table] = t(table).filter((r) => !hits.includes(r)); return { data: hits, error: null } }
        return { data: (limitN ? hits.slice(0, limitN) : hits).map((r) => structuredClone(r)), error: null }
      }
      const b: any = {
        select: () => b, order: () => b, not: () => b, is: () => b, or: () => b, gte: () => b, lte: () => b, lt: () => b, neq: () => b,
        limit: (n: number) => { limitN = n; return b },
        insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b },
        update: (p: Row) => { op = "update"; payload = p; return b },
        delete: () => { op = "delete"; return b },
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b },
        single: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        maybeSingle: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

function seams(over: { authority?: number } = {}) {
  const ledger: any[] = [], mLedger: any[] = [], dLedger: any[] = [], signals: any[] = []
  const mission: MissionDeps = {
    afford: async () => ({ allowed: true, reason: "active" }),
    authority: async () => (over.authority ?? 6) as any,
    ledger: async (ctx) => { mLedger.push(ctx); return `ml-${mLedger.length}` },
    emit: async () => {}, signal: async (s) => { signals.push(s) },
  }
  const delegation: DelegationDeps = {
    afford: async () => ({ allowed: true, reason: "active" }),
    authority: async () => (over.authority ?? 6) as any,
    ledger: async (ctx) => { dLedger.push(ctx); return `dl-${dLedger.length}` },
    emit: async () => {}, signal: async (s) => { signals.push(s) }, mission,
  }
  const deps: StrategyEngineDeps = { ledger: async (ctx) => { ledger.push(ctx) }, mission, delegation }
  return { deps, ledger, mLedger, dLedger, signals }
}

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const U1 = "33333333-3333-4333-8333-333333333333"

/** The composition rule, applied to any definition (the proof's own validator — mutated controls below). */
function compositionErrors(s: StrategyDefinition): string[] {
  const errs: string[] = []
  const creative = new Set(CREATIVE_PLAYBOOKS.map((p) => p.key)), goals = new Set(QUALIFICATION_GOALS.map((g) => g.key))
  const personas = new Set(CHECK_VOCABULARIES.campaign_sequences?.persona ?? []), seqTypes = new Set(CHECK_VOCABULARIES.campaign_sequences?.sequence_type ?? [])
  const momentUnion = /export type StrategyMoment\s*=\s*([^\n]+)/.exec(src("lib/kernel/strategy-session.ts"))?.[1] ?? ""
  const moments = new Set([...momentUnion.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))
  const roiBody = /export interface RoiLedger \{([\s\S]*?)\n\}/.exec(src("lib/intelligence/roi-ledger.ts"))?.[1] ?? ""
  const roiNumeric = new Set([...roiBody.matchAll(/^\s+(\w+)\??:\s*number\b/gm)].map((m) => m[1]))
  const riskUnion = /export type FatigueRiskLevel\s*=\s*([^\n]+)/.exec(src("lib/fatigue/fatigue-display.ts"))?.[1] ?? ""
  const risks = new Set([...riskUnion.matchAll(/"([a-z]+)"/g)].map((m) => m[1]))
  if (!(s.ownerManager in MANAGERS)) errs.push(`owner ${s.ownerManager} not a MANAGERS key`)
  if (!participatingManagers(s).includes(s.ownerManager)) errs.push(`owner ${s.ownerManager} not among the steps`)
  if (!(MISSION_TYPES as readonly string[]).includes(s.missionType)) errs.push(`missionType ${s.missionType}`)
  for (const [i, st] of s.steps.entries()) {
    if (!(st.manager in MANAGERS)) errs.push(`step ${i + 1} manager ${st.manager}`)
    if (st.capabilities.length === 0 && !st.gap) errs.push(`step ${i + 1} has no capability and names no gap`)
    for (const c of st.capabilities) {
      if (!(c in APP_CAPABILITY_REGISTRY)) errs.push(`step ${i + 1} capability ${c} not in the catalogue`)
      else if (CAPABILITY_MANAGER[c] !== st.manager) errs.push(`step ${i + 1} capability ${c} owned by ${CAPABILITY_MANAGER[c]}, not ${st.manager}`)
    }
    for (const p of st.playbooks) {
      const ok = p.kind === "creative_playbook" ? creative.has(p.key) : p.kind === "qualification_goal" ? goals.has(p.key)
        : p.kind === "sequence_persona" ? personas.has(p.key) : p.kind === "sequence_type" ? seqTypes.has(p.key)
        : p.kind === "strategy_session" ? moments.has(p.key) : p.kind === "experience" ? (EXPERIENCE_KINDS as readonly string[]).includes(p.key)
        : p.kind === "kernel_play" ? (() => { const r = (KERNEL_PLAY_REFS as Record<string, { file: string; door: string }>)[p.key]; return !!r && existsSync(r.file) && new RegExp(`export\\s+(async\\s+)?function\\s+${r.door}\\b`).test(src(r.file)) })()
        : false
      if (!ok) errs.push(`step ${i + 1} playbook ${p.kind}:${p.key} does not resolve`)
    }
  }
  for (const m of s.outcomeMetrics) if (!roiNumeric.has(m)) errs.push(`outcome metric ${m} not a numeric RoiLedger key`)
  for (const b of s.timing.timelineBuckets ?? []) if (!(STANDARD_TIMELINES as readonly string[]).includes(b)) errs.push(`timeline ${b}`)
  if (!risks.has(s.fatigue.maxContactRisk)) errs.push(`fatigue risk ${s.fatigue.maxContactRisk}`)
  if (!(s.authority.recommended >= 0 && s.authority.recommended <= 6)) errs.push("authority rung")
  return errs
}

function candidate(def: StrategyDefinition, over: Parameters<typeof adaptStrategy>[1] = null, activationId: string | null = "act-1"): StrategyCandidate {
  return { definition: def, adaptation: adaptStrategy(def, over, null), activationId }
}

async function main() {
  console.log("\nA. the eight seeds compose only existing capabilities / playbooks")
  {
    const keys = [...new Set(PLATFORM_STRATEGY_LIBRARY.map((s) => s.key))]
    check("A1 the owner's eight are in the platform library", OWNER_SEED_STRATEGY_KEYS.every((k) => keys.includes(k)) && OWNER_SEED_STRATEGY_KEYS.length === 8)
    for (const k of OWNER_SEED_STRATEGY_KEYS) {
      const s = platformStrategy(k)!
      const errs = compositionErrors(s)
      check(`A2 ${k} composes only existing managers / owned capabilities / resolving playbooks / RoiLedger metrics`, errs.length === 0, errs.join("; "))
    }
    const se = platformStrategy("seller_equity")!
    check("A3 Seller Equity runs in the owner's order: data_steward → ai_isa → campaign_orchestrator → asset_manager → listing_concierge → finance_manager",
      participatingManagers(se).join(">") === ["data_steward", "ai_isa", "campaign_orchestrator", "asset_manager", "listing_concierge", "finance_manager"].join(">"))
    const gaps = PLATFORM_STRATEGY_LIBRARY.flatMap((s) => strategyGaps(s).map((g) => `${s.key}:${g.manager}`))
    // A4 asserts the RULE (every step either names catalogue keys its manager owns or names its gap — never
    // invented), not the waypoint "these three gaps exist": wave 108 BUILT them (owner-approved).
    const ownedStep = (s: StrategyDefinition, key: string, manager: string, cap: string) => s.key === key && s.steps.some((x) => x.manager === manager && x.capabilities.includes(cap as any) && !x.gap)
    check("A4 every gap is NAMED, never invented — and the three owner-approved gaps (wave 108) now name catalogue keys their managers own: recruit_outreach, ad_campaign_launch, lender_preapproval_handoff",
      PLATFORM_STRATEGY_LIBRARY.every((s) => s.steps.every((x) => x.capabilities.length > 0 || !!x.gap))
      && ownedStep(platformStrategy("recruiting")!, "recruiting", "recruiting_manager", "recruit_outreach")
      && ownedStep(platformStrategy("listing_launch")!, "listing_launch", "ads_manager", "ad_campaign_launch")
      && ownedStep(platformStrategy("first_time_buyer")!, "first_time_buyer", "shopping_agent", "lender_preapproval_handoff")
      && !gaps.some((g) => ["recruiting:recruiting_manager", "listing_launch:ads_manager", "first_time_buyer:shopping_agent"].includes(g)), gaps.join(", "))
    check("A4b a strategy whose steps CHANGED carries a new version (the published platform version is immutable): the three are v2", ["recruiting", "listing_launch", "first_time_buyer"].every((k) => platformStrategy(k)!.version >= 2))
    // positive controls — the validator recognises each defect it was written for
    const mutCap = { ...se, steps: [{ ...se.steps[1], capabilities: ["cma_generate"] }] } as unknown as StrategyDefinition
    const mutInvented = { ...se, steps: [{ ...se.steps[0], capabilities: ["teleport_buyer"] }] } as unknown as StrategyDefinition
    const mutPlaybook = { ...se, steps: [{ ...se.steps[2], playbooks: [{ kind: "creative_playbook", key: "no_such_play" }] }] } as unknown as StrategyDefinition
    const mutGapless = { ...se, steps: [{ manager: "ads_manager", capabilities: [], purpose: "x", playbooks: [] }] } as unknown as StrategyDefinition
    const mutMetric = { ...se, outcomeMetrics: ["vibes"] } as unknown as StrategyDefinition
    check("A5 (control) a capability owned by another manager is caught", compositionErrors(mutCap).some((e) => /owned by listing_concierge, not ai_isa/.test(e)))
    check("A6 (control) an invented capability is caught", compositionErrors(mutInvented).some((e) => /not in the catalogue/.test(e)))
    check("A7 (control) an unresolvable playbook ref is caught", compositionErrors(mutPlaybook).some((e) => /does not resolve/.test(e)))
    check("A8 (control) a capability-less step with no named gap is caught", compositionErrors(mutGapless).some((e) => /names no gap/.test(e)))
    check("A9 (control) an outcome metric outside RoiLedger is caught", compositionErrors(mutMetric).some((e) => /not a numeric RoiLedger key/.test(e)))
    check("A10 every capability any seed uses is a catalogue key (strategyCapabilities ⊆ APP_CAPABILITY_REGISTRY)", PLATFORM_STRATEGY_LIBRARY.every((s) => strategyCapabilities(s).every((c) => c in APP_CAPABILITY_REGISTRY)))
  }

  console.log("\nB. eligibility deterministic, fails closed; ranking deterministic")
  {
    const exp = platformStrategy("expired_listing")!, se = platformStrategy("seller_equity")!, sr = platformStrategy("sphere_reactivation")!
    const f = { subject_type: "contact" as const, persona: "expired", dnc: false }
    const v1 = evaluateEligibility(exp, f), v2 = evaluateEligibility(exp, f)
    check("B1 same facts → same verdict (deterministic)", JSON.stringify(v1) === JSON.stringify(v2) && v1.eligible)
    check("B2 DNC → ineligible", !evaluateEligibility(exp, { ...f, dnc: true }).eligible)
    const unk = evaluateEligibility(sr, { subject_type: "contact", is_past_client: true })
    check("B3 an UNKNOWN required fact fails closed and is reported (months_since_last_touch)", !unk.eligible && unk.unknown.includes("months_since_last_touch"))
    check("B4 a whenKnown clause passes on an unknown fact (equity verified by the Data Steward step) but a KNOWN low value fails", evaluateEligibility(se, { subject_type: "contact" }).eligible && !evaluateEligibility(se, { subject_type: "contact", equity_pct: 10 }).eligible)
    check("B5 an adapted threshold is applied (equity floor 25 refuses 22, base 20 admits it)", evaluateEligibility(se, { subject_type: "contact", equity_pct: 22 }).eligible && !evaluateEligibility(se, { subject_type: "contact", equity_pct: 22 }, { equity_floor_pct: 25 }).eligible)
    check("B6 wrong subject type → ineligible (listing_launch on a contact)", !evaluateEligibility(platformStrategy("listing_launch")!, { subject_type: "contact", listing_status: "active" }).eligible)
    const cands = OWNER_SEED_STRATEGY_KEYS.map((k) => candidate(platformStrategy(k)!))
    const facts = factsFromContactRow({ contact_type: "lifetime_customer", contact_persona: null, dnc_status: false, last_contacted_at: new Date(Date.now() - 300 * 86_400_000).toISOString(), home_owner_status: "owner" })
    const r1 = rankStrategies(cands, facts), r2 = rankStrategies([...cands].reverse(), facts)
    check("B7 ranking is deterministic (input order irrelevant) and only eligible strategies rank", r1.map((r) => r.definition.key).join(",") === r2.map((r) => r.definition.key).join(",") && r1.length > 0 && r1.every((r) => r.eligibility.eligible), r1.map((r) => r.definition.key).join(","))
    check("B8 a past client quiet 10 months ranks Seller Equity (priority 70) above Sphere Reactivation (60)", r1[0]?.definition.key === "seller_equity" && r1.some((r) => r.definition.key === "sphere_reactivation"))
    const learned = rankStrategies(cands, facts, { performance: { sphere_reactivation: { score: 1, sample: HISTORY_MIN_SAMPLE, source: "test" } } })
    check("B9 learned performance (n ≥ HISTORY_MIN_SAMPLE) re-ranks; a thin sample does not", learned[0]?.definition.key === "sphere_reactivation" && rankStrategies(cands, facts, { performance: { sphere_reactivation: { score: 1, sample: 3, source: "test" } } })[0]?.definition.key === "seller_equity")
    check("B10 manager filter: the ISA only sees strategies it participates in", rankStrategies(cands, facts, { manager: "ai_isa" }).every((r) => participatingManagers(r.definition).includes("ai_isa")))
    check("B11 brokerage scope (facts null) lists active strategies and says eligibility is per subject", rankStrategies(cands, null, { manager: "campaign_orchestrator" }).every((r) => r.eligibility.unknown.some((u) => /brokerage scope/.test(u))))
  }

  console.log("\nC. activation → mission + delegations")
  {
    const c = memClient(), s = seams()
    const se = platformStrategy("seller_equity")!
    c.tables.strategy_activations = [{ id: "act-se", brokerage_id: T1, strategy_key: "seller_equity", version: se.version, tier: "platform", library_id: "lib-1", status: "active", adaptation: adaptStrategy(se, null, null), adapted_from_digest: strategyDigest(se), activated_by: U1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deactivated_at: null }]
    const sel = await selectStrategies({ brokerageId: T1, manager: "ai_isa", facts: { subject_type: "contact", homeowner: true, dnc: false } }, c as any)
    // The default learning reader IS lib/intelligence/strategy-learning.ts (wired at integration); against this in-memory
    // client it returns no learned rows or refuses — either way the status is STATED, never a silent 0 (rule, not waypoint).
    check("C1 selectStrategies returns the tenant's ACTIVE strategy and STATES its learning status (learned | unlearned | refused — a non-learned status carries its reason)", sel.ranked[0]?.definition.key === "seller_equity" && ["learned", "unlearned", "refused"].includes(sel.learning) && (sel.learning === "learned" || !!sel.learningReason), `${sel.learning}: ${sel.learningReason}`)
    check("C1b wiring: the engine's DEFAULT learning reader is strategy-learning.ts strategyLearningForSelection (lazy import), and that reader reads tenantStrategyStats + the published strategy_conversion cells", /import\("@\/lib\/intelligence\/strategy-learning"\)\)\.strategyLearningForSelection/.test(stripComments(readFileSync("lib/kernel/strategy-engine.ts", "utf8"))) && /tenantStrategyStats\(client[\s\S]{0,400}strategy_conversion/.test(stripComments(readFileSync("lib/intelligence/strategy-learning.ts", "utf8"))))
    const act = await activateStrategy({ brokerageId: T1, candidate: sel.ranked[0], subject: { type: "contact", id: "c-1" } }, c as any, s.deps)
    check("C2 activation creates a MISSION owned by the strategy's owner with its participating managers", act.ok && act.mission.owner_manager === "listing_concierge" && ["data_steward", "ai_isa", "campaign_orchestrator", "asset_manager", "finance_manager"].every((m) => act.mission.participating_managers.includes(m as any)), act.ok ? JSON.stringify(act.mission.participating_managers) : act.reason)
    check("C3 within authority → ACTIVE (needs rung ≤ min(ceiling, recommended))", act.ok && act.mission.state === "ACTIVE" && !act.needsApproval)
    const dels = c.tables.manager_delegations ?? []
    check("C4 one 105A delegation per step capability another manager owns (owner's own steps excluded), each to the capability's owner", act.ok && act.delegations.every((d) => d.ok) && dels.length === 5 && dels.every((d) => d.requesting_manager === "listing_concierge" && CAPABILITY_MANAGER[d.requested_capability as keyof typeof CAPABILITY_MANAGER] === d.assigned_manager && d.mission_id === (act.ok ? act.mission.id : "")), JSON.stringify(act.ok ? act.delegations : act))
    const m = (c.tables.missions ?? [])[0]
    const ev = (m?.evidence ?? []).find((e: Row) => e.kind === STRATEGY_EVIDENCE_KIND)
    check("C5 the mission's evidence snapshots the strategy (ref, owner, managers, capabilities, digest)", !!ev && ev.ref === "seller_equity@v1" && ev.owner === "listing_concierge" && ev.digest === strategyDigest(se))
    check("C6 the activation is a ledger row naming the strategy (detail.strategy {key, version, tier} — the 107F attribution key)", s.ledger.some((l) => l.action === "strategy.activate" && l.detail.strategy.key === "seller_equity" && l.detail.strategy.version === 1 && l.detail.strategy.tier === "platform"))
    const again = await activateStrategy({ brokerageId: T1, candidate: sel.ranked[0], subject: { type: "contact", id: "c-1" } }, c as any, s.deps)
    check("C7 idempotent per (subject, strategy): a second activation returns the running mission, no new mission / delegations", again.ok && again.duplicate && (c.tables.missions ?? []).length === 1 && (c.tables.manager_delegations ?? []).length === 5)
    const own = resolveOwnership(m as MissionRow)
    check("C8 the mission controller (105B) resolves owner + bench from the strategy evidence (no owner_mismatch)", own.expected === "listing_concierge" && own.basis.startsWith("strategy seller_equity@v1") && ["data_steward", "ai_isa", "asset_manager", "finance_manager"].every((k) => own.participants.has(k as any)))
    check("C9 (control) a mission WITHOUT strategy evidence falls back to the registry derivation", resolveOwnership({ ...(m as MissionRow), evidence: [] }).basis.startsWith("mission_type campaign"))
    // approval per authority
    const c2 = memClient(), s2 = seams()
    const rec = await activateStrategy({ brokerageId: T1, candidate: candidate(platformStrategy("recruiting")!), subject: { type: "territory", id: "north" } }, c2 as any, s2.deps)
    check("C10 a strategy whose authority says 'always' waits for a human (APPROVAL_REQUIRED)", rec.ok && rec.mission.state === "APPROVAL_REQUIRED" && rec.needsApproval)
    const c3 = memClient(), s3 = seams({ authority: 1 })
    const low = await activateStrategy({ brokerageId: T1, candidate: candidate(platformStrategy("sphere_reactivation")!), subject: { type: "contact", id: "c-9" } }, c3 as any, s3.deps)
    check("C11 the owner's ladder ceiling below the needed rung → APPROVAL_REQUIRED, the communicating steps DEFERRED (recorded, not requested)", low.ok && low.mission.state === "APPROVAL_REQUIRED" && low.deferred.length > 0 && low.deferred.every((d) => /needs rung 3 > ceiling 1/.test(d.why)), JSON.stringify(low))
    const bad = await activateStrategy({ brokerageId: T1, candidate: candidate(platformStrategy("listing_launch")!), subject: { type: "contact", id: "c-1" } }, memClient() as any, seams().deps)
    check("C12 a subject type the strategy does not serve is refused", !bad.ok && /subject_type_not_eligible/.test(bad.reason))
    // WAVE 108 — the approved capabilities are WIRED into the steps that named them as gaps.
    const c4 = memClient(), s4 = seams()
    const ftb = await activateStrategy({ brokerageId: T1, candidate: candidate(platformStrategy("first_time_buyer")!), subject: { type: "contact", id: "c-ftb" } }, c4 as any, s4.deps)
    const ftbDel = (c4.tables.manager_delegations ?? []).filter((d: any) => d.requested_capability === "lender_preapproval_handoff")
    check("C13 First-Time Buyer v2 files the lender pre-approval handoff as the owner's WORK ORDER (shopping_agent → itself, inside the mission, carrying the buyer contact); the owner's non-worker steps stay the mission itself",
      ftb.ok && ftbDel.length === 1 && ftbDel[0].requesting_manager === "shopping_agent" && ftbDel[0].assigned_manager === "shopping_agent" && ftbDel[0].mission_id === ftb.mission.id && ftbDel[0].input_entities?.contactId === "c-ftb"
      && !(c4.tables.manager_delegations ?? []).some((d: any) => d.requested_capability === "appointment_schedule"), JSON.stringify(ftb.ok ? ftb.delegations : ftb))
    const c5 = memClient(), s5 = seams()
    const ll = await activateStrategy({ brokerageId: T1, candidate: candidate(platformStrategy("listing_launch")!), subject: { type: "listing", id: "l-1" } }, c5 as any, s5.deps)
    const adDel = (c5.tables.manager_delegations ?? []).filter((d: any) => d.requested_capability === "ad_campaign_launch")
    check("C14 Listing Launch v2 delegates the ad draft to the ads_manager (ad_campaign_launch) — a delegation, not a gap", ll.ok && adDel.length === 1 && adDel[0].assigned_manager === "ads_manager" && adDel[0].requesting_manager === "listing_concierge", JSON.stringify(ll.ok ? ll.delegations : ll))
  }

  console.log("\nD. platform version immutable; tenant adaptation recorded")
  {
    const se = platformStrategy("seller_equity")!
    const d0 = strategyDigest(se)
    let threw = false
    try { (se.budget as { usd: number }).usd = 1 } catch { threw = true }
    check("D1 a published platform version is frozen (mutation refused) and its digest is stable", (threw || se.budget.usd !== 1) && strategyDigest(se) === d0 && Object.isFrozen(se.steps[0]))
    const c = memClient({ brokerage_settings: [{ brokerage_id: T1, settings: { strategy_overrides: { seller_equity: { budgetUsd: 80, cadenceDays: 10 } } } }] }), s = seams()
    registerStrategyLearningSeam(async (b, keys) => ({
      performance: {}, benchmarks: Object.fromEntries(keys.map((k) => [k, { conversionRate: 0.1, sample: 500 }])),
      history: (b === T1 ? { seller_equity: { sample: 40, conversionRate: 0.05, benchmarkRate: 0.1 } } : {}) as Record<string, StrategyHistory>,
    }))
    const a1 = await activateLibraryStrategy({ brokerageId: T1, key: "seller_equity", actorUserId: U1 }, c as any, s.deps)
    const lib = (c.tables.strategy_library ?? [])
    check("D2 activation PUBLISHES the platform version to strategy_library (tier platform, no tenant, digest of the code version)", lib.length === 1 && lib[0].tier === "platform" && lib[0].brokerage_id === null && lib[0].definition_digest === d0)
    const ch = a1.ok ? a1.activation.adaptation.changes : []
    check("D3 tenant POLICY overrides budget / timing and tenant HISTORY moves the eligibility threshold — every change recorded with its source",
      a1.ok && a1.activation.adaptation.budget.usd === 80 && a1.activation.adaptation.timing.cadenceDays === 10 && a1.activation.adaptation.thresholds.equity_floor_pct === 25
      && ch.some((x) => x.source === "tenant_policy" && x.field === "budget.usd") && ch.some((x) => x.source === "tenant_history" && x.field === "threshold.equity_floor_pct"), JSON.stringify(ch))
    check("D4 the platform version itself is unchanged by the adaptation (same digest, same budget)", strategyDigest(platformStrategy("seller_equity")!) === d0 && platformStrategy("seller_equity")!.budget.usd === 60 && a1.ok && a1.activation.adapted_from_digest === d0)
    check("D5 the tenant activation is ledgered as a human request naming the strategy", s.ledger.some((l) => l.action === "strategy.library.activate" && l.reasonCode === "HUMAN_REQUESTED" && l.detail.strategy.key === "seller_equity"))
    const a2 = await activateLibraryStrategy({ brokerageId: T1, key: "seller_equity", actorUserId: U1 }, c as any, s.deps)
    check("D6 re-activating the same version with the same adaptation is a duplicate (no second row)", a2.ok && a2.duplicate && (c.tables.strategy_activations ?? []).length === 1)
    c.tables.brokerage_settings[0].settings.strategy_overrides.seller_equity.budgetUsd = 90
    const a3 = await activateLibraryStrategy({ brokerageId: T1, key: "seller_equity", actorUserId: U1 }, c as any, s.deps)
    const rows = c.tables.strategy_activations ?? []
    check("D7 a changed policy re-activation SUPERSEDES the previous activation (counted), one active row remains", a3.ok && a3.superseded === 1 && rows.filter((r) => r.status === "active").length === 1 && rows.filter((r) => r.status === "superseded").length === 1)
    lib[0].definition_digest = "fnv1a:tampered"
    const drift = await activateLibraryStrategy({ brokerageId: T1, key: "seller_equity", actorUserId: U1 }, c as any, s.deps)
    check("D8 (control) a library row whose digest drifted from the code version is REFUSED", !drift.ok && /platform_version_drift/.test(drift.reason))
    lib[0].definition_digest = d0
    const listed = await listStrategyLibrary(T1, c as any)
    const card = listed.entries.find((e) => e.key === "seller_equity")
    check("D9b the library card carries each strategy's OS domains and the library edition (137E breadth)", listed.edition >= 3 && listed.entries.every((e) => e.domains.length > 0))
    check("D9 the library card reads version, benchmark (seam), recommended authority and the recorded adaptation", !!card && card.label === "VIPAgents Seller Equity v1" && card.benchmark?.conversionRate === 0.1 && card.recommendedAuthority === 3 && (card.activation?.changes.length ?? 0) > 0 && listed.learning === "learned")
    const mig = readFileSync("supabase/migrations/m725-strategy-library-and-activations.sql", "utf8")
    check("D10 m725: platform rows readable by all tenants, tenant rows own only, writes revoked, one active activation per key, published version immutable by trigger",
      /USING \(tier = 'platform' OR is_platform_admin\(\) OR has_brokerage_access\(brokerage_id\)\)/.test(mig) && /REVOKE INSERT, UPDATE, DELETE ON public\.strategy_library\s+FROM anon, authenticated/.test(mig)
      && /uq_strategy_activations_one_active[\s\S]{0,120}WHERE status = 'active'/.test(mig) && /BEFORE UPDATE OR DELETE ON public\.strategy_library/.test(mig) && /a published version is immutable/.test(mig))
    const tierCheck = /strategy_library_tier_check CHECK \(tier IN \(([^)]*)\)\)/.exec(mig)
    check("D11 the tier CHECK and STRATEGY_TIERS are one vocabulary (derived)", !!tierCheck && [...tierCheck[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).join(",") === "platform,tenant")
  }

  console.log("\nE. tenant isolation")
  {
    const c = memClient(), s = seams()
    const se = platformStrategy("seller_equity")!
    c.tables.strategy_activations = [{ id: "act-t1", brokerage_id: T1, strategy_key: "seller_equity", version: 1, tier: "platform", library_id: "l", status: "active", adaptation: adaptStrategy(se, null, null), adapted_from_digest: strategyDigest(se), activated_by: U1, created_at: "", updated_at: "", deactivated_at: null }]
    const t2 = await selectStrategies({ brokerageId: T2, facts: { subject_type: "contact" } }, c as any)
    const t1 = await selectStrategies({ brokerageId: T1, facts: { subject_type: "contact" } }, c as any)
    check("E1 another tenant's activations are invisible (T2 selects nothing; T1 positive control selects its own)", t2.ranked.length === 0 && t1.ranked.length === 1)
    await activateStrategy({ brokerageId: T1, candidate: t1.ranked[0], subject: { type: "contact", id: "c-1" } }, c as any, s.deps)
    const dup = await activateStrategy({ brokerageId: T2, candidate: t1.ranked[0], subject: { type: "contact", id: "c-1" } }, c as any, s.deps)
    check("E2 T1's running mission on a subject id does not dedupe T2's (missions read tenant-pinned)", dup.ok && !dup.duplicate && dup.mission.brokerage_id === T2)
    const none = await selectStrategies({ brokerageId: "", facts: null }, c as any)
    check("E3 no tenant → refused, never 'all tenants'", none.readRefused === "no tenant" && none.ranked.length === 0)
    check("E4 the facts reader takes nothing tenant-shaped from the row (no brokerage_id in StrategyFacts)", !("brokerage_id" in factsFromContactRow({ brokerage_id: T2, contact_type: "buyer" })))
  }

  console.log("\nG. BREADTH (wave 137E) — every OS domain has ≥ 1 platform strategy and ≥ 1 platform skill example")
  {
    const keys = [...new Set(PLATFORM_STRATEGY_LIBRARY.map((s) => s.key))]
    const bad = keys.map((k) => ({ k, errs: compositionErrors(platformStrategy(k)!) })).filter((x) => x.errs.length)
    check(`G1 EVERY library strategy (${keys.length}, not only the seeds) composes only existing managers / owned capabilities / resolving playbooks / RoiLedger metrics`, bad.length === 0, JSON.stringify(bad))
    check("G2 every library strategy is domain-tagged BESIDE its definition (STRATEGY_DOMAINS ⊆ OS_DOMAINS), and every tag names a real strategy",
      keys.every((k) => (STRATEGY_DOMAINS[k] ?? []).length > 0 && STRATEGY_DOMAINS[k].every((d) => (OS_DOMAINS as readonly string[]).includes(d))) && Object.keys(STRATEGY_DOMAINS).every((k) => keys.includes(k)), keys.filter((k) => !(STRATEGY_DOMAINS[k] ?? []).length).join(","))
    const census = (stratTags: Record<string, readonly string[]>, examples: readonly { domains: readonly string[] }[]) =>
      Object.fromEntries(OS_DOMAINS.map((d) => [d, { strategies: Object.entries(stratTags).filter(([, ds]) => ds.includes(d)).map(([k]) => k), skills: examples.filter((e) => e.domains.includes(d)).length }]))
    const c = census(STRATEGY_DOMAINS, PLATFORM_SKILL_EXAMPLES)
    const uncovered = OS_DOMAINS.filter((d) => c[d].strategies.length === 0 || c[d].skills === 0)
    console.log(`     census (domain: strategies / skill examples) — ${OS_DOMAINS.map((d) => `${d}: ${c[d].strategies.length}/${c[d].skills}`).join(" · ")}`)
    check(`G3 domain census: all ${OS_DOMAINS.length} OS domains carry ≥ 1 platform strategy AND ≥ 1 platform skill example`, uncovered.length === 0, uncovered.join(", "))
    const seedOnly = Object.fromEntries(Object.entries(STRATEGY_DOMAINS).filter(([k]) => (OWNER_SEED_STRATEGY_KEYS as readonly string[]).includes(k)))
    const seedHoles = OS_DOMAINS.filter((d) => census(seedOnly, []).hasOwnProperty(d) && census(seedOnly, [])[d].strategies.length === 0)
    check("G4 (POSITIVE CONTROL) the census recognises the defect it was written for: the owner's eight seeds alone, with no skill examples, leave domains uncovered", seedHoles.length > 0 && OS_DOMAINS.every((d) => census(seedOnly, [])[d].skills === 0), seedHoles.join(", "))
    check("G5 the library edition is bumped for the breadth release (≥ 3) and no published key changed version under it (the eight seeds keep their versions)", PLATFORM_STRATEGY_LIBRARY_EDITION >= 3 && ["expired_listing", "fsbo", "seller_equity", "sphere_reactivation", "past_client_referral"].every((k) => platformStrategy(k)!.version === 1) && ["first_time_buyer", "listing_launch", "recruiting"].every((k) => platformStrategy(k)!.version === 2))
    check("G6 every published (key, version) is unique — a change is a NEW version, never an edited one", new Set(PLATFORM_STRATEGY_LIBRARY.map((s) => `${s.key}@${s.version}`)).size === PLATFORM_STRATEGY_LIBRARY.length)
    check("G7 no strategy hard-codes a market (marketSuitability is a vocabulary, never a city / state / territory name)", PLATFORM_STRATEGY_LIBRARY.every((s) => s.marketSuitability.every((m) => /^(any|balanced|buyer_market|sellers_market|appreciating|affordable|growth)$/.test(m))))
    const ta = platformStrategy("transaction_to_close")!, bso = platformStrategy("buyer_search_to_offer")!
    check("G8 owner rulings hold in the breadth strategies: a buyer tours only as a CONTACT (buyer_search_to_offer serves contacts only); the transaction strategy is owned by the deal_coordinator", JSON.stringify(bso.eligibility.subjectTypes) === JSON.stringify(["contact"]) && ta.ownerManager === "deal_coordinator" && ta.missionType === "transaction")
    const cand = candidate(bso)
    check("G9 a breadth strategy selects deterministically on contact facts (a touring buyer contact is eligible; a seller is not)", rankStrategies([cand], factsFromContactRow({ contact_type: "buyer", buyer_stage: "BUYER_TOURING", dnc_status: false })).length === 1 && rankStrategies([cand], factsFromContactRow({ contact_type: "seller", buyer_stage: "BUYER_TOURING", dnc_status: false })).length === 0)
    const ca = memClient(), sa = seams()
    const ttc = await activateStrategy({ brokerageId: T1, candidate: candidate(ta), subject: { type: "contact", id: "c-ttc" } }, ca as any, sa.deps)
    check("G10 activation of a breadth strategy → a mission owned by deal_coordinator + one delegation per capability another manager owns (portal, gift, finance)",
      ttc.ok && ttc.mission.owner_manager === "deal_coordinator" && (ca.tables.manager_delegations ?? []).length === 3 && (ca.tables.manager_delegations ?? []).every((d: Row) => CAPABILITY_MANAGER[d.requested_capability as keyof typeof CAPABILITY_MANAGER] === d.assigned_manager), JSON.stringify(ttc.ok ? ttc.delegations : ttc))

    // skill examples — validated at load by the CURRENT validateSkillDeclaration + the platform evaluator
    check(`G11 every platform skill example passed the load-time gate (${PLATFORM_SKILL_EXAMPLES.length} offered, 0 rejected)`, PLATFORM_SKILL_EXAMPLES.length >= OS_DOMAINS.length && PLATFORM_SKILL_EXAMPLE_REJECTS.length === 0, JSON.stringify(PLATFORM_SKILL_EXAMPLE_REJECTS))
    check("G12 each example names its manager, capabilities it owns, risk, authority, cost, entitlement and the marketplace evaluation suite; outputs are the kernel receipt; ≥ 1 domain source skill",
      PLATFORM_SKILL_EXAMPLES.every((e) => e.declaration.manager_owner in MANAGERS && e.declaration.required_capabilities.every((c) => CAPABILITY_MANAGER[c] === e.declaration.manager_owner) && !!e.declaration.risk_class && Number.isInteger(e.declaration.authority_requirement) && !!e.declaration.cost_estimate && !!e.declaration.tenant_entitlement && e.declaration.evaluation_suite === "skill_eval:contract_v1" && JSON.stringify(e.declaration.outputs) === JSON.stringify(SKILL_RUN_RECEIPT_SCHEMA) && e.domainSources.length > 0))
    const base = PLATFORM_SKILL_EXAMPLES[0]
    const mut = (patch: Partial<PlatformSkillExample["declaration"]>): PlatformSkillExample => ({ ...base, declaration: { ...base.declaration, ...patch } as PlatformSkillExample["declaration"] })
    check("G13 (POSITIVE CONTROLS) the load-time gate refuses: a capability another manager owns, an authority above the risk band, an understated risk, a builtin's reserved name, a non-marketplace evaluation suite",
      examineExample(mut({ required_capabilities: ["cma_generate"] })).some((e) => e.startsWith("capability_not_owned"))
      && examineExample(mut({ authority_requirement: 5 })).some((e) => e.startsWith("authority_exceeds_risk_class"))
      && examineExample(mut({ risk_class: "READ", authority_requirement: 0 })).some((e) => e.startsWith("risk_understated"))
      && examineExample(mut({ name: "appointment_schedule" })).some((e) => e.startsWith("name_reserved_by_builtin"))
      && examineExample(mut({ evaluation_suite: "test:capability-contract" })).some((e) => e.startsWith("unknown_evaluation_suite")))
    const exSrc = src("lib/kernel/platform-skill-examples.ts")
    check("G13b the examples module's load-time gate composes exactly that gate (builtin name refusal + validateSkillDeclaration over the marketplace suites + the platform evaluator) and EXCLUDES a failing candidate", /builtinSkill\(e\.declaration\.name\)/.test(exSrc) && /validateSkillDeclaration\(e\.declaration, \{ knownEvaluationSuites: new Set\(Object\.keys\(SKILL_EVALUATORS\)\) \}\)/.test(exSrc) && /SKILL_EVALUATORS\[e\.declaration\.evaluation_suite\]/.test(exSrc) && /examined\.filter\(\(x\) => x\.errors\.length === 0\)/.test(exSrc))
    check("G14 the examples are names unique and never auto-published: the module writes no row (no .from( in its stripped source)", new Set(PLATFORM_SKILL_EXAMPLES.map((e) => e.declaration.name)).size === PLATFORM_SKILL_EXAMPLES.length && !/\.from\(/.test(src("lib/kernel/platform-skill-examples.ts")))
    const door = src("app/actions/platform-skill-examples.ts"), panel = src("app/components/skills/skill-marketplace-panel.tsx")
    check("G15 WIRED: a staff-gated 'use server' door returns the examples (+ rejects); the platform panel loads them and submits one as a PLATFORM listing through the gated intake (submitThirdPartySkill … publisherKind)",
      /^"use server"/.test(door.trim()) && /requirePlatformStaff\(\)[\s\S]{0,120}if \(!staff\.ok\) return/.test(door) && /PLATFORM_SKILL_EXAMPLES\.map\(/.test(door) && !/export async function \w+\([^)]+\)/.test(door)
      && /await getPlatformSkillExamples\(\)/.test(panel) && /submitThirdPartySkill\(decl, publisherName, publisherKind[,)]/.test(panel) && /setPublisherKind\("platform"\)/.test(panel))
    const domainsOf = (d: OsDomain) => PLATFORM_SKILL_EXAMPLES.filter((e) => e.domains.includes(d)).map((e) => e.declaration.name)
    check("G16 the listing-centric gap is closed for the owner's named domains (buyers, investors, sphere, recruiting, transactions, lenders, portals each have their own example)", (["buyers", "investors", "sphere_lifetime", "recruiting_retention", "transactions_closing", "lenders_vendors", "portals"] as OsDomain[]).every((d) => domainsOf(d).length > 0))
  }

  console.log("\nF. wiring + registration")
  {
    const isa = src("app/actions/ai-isa/engage-contact.ts")
    check("F1 the ISA engage path selects + activates (selectStrategies( … activateStrategy(, manager ai_isa)", /selectStrategies\(\{ brokerageId, manager: 'ai_isa'/.test(isa) && isa.includes("activateStrategy("))
    check("F2 the Campaign Orchestrator's plan step selects (selectStrategies( in the kickoff)", /selectStrategies\(\{ brokerageId: params\.brokerageId, manager: "campaign_orchestrator"/.test(src("lib/agents/campaign-orchestrator.ts")))
    check("F3 the mission controller reads the strategy evidence (strategyOwnershipOf( in resolveOwnership)", /strategyOwnershipOf\(m\.evidence\)/.test(src("lib/kernel/mission-controller.ts")))
    check("F4 the Manager Trust page mounts the library card; the doors are tenant-admin + session tenant", /<StrategyLibraryPanel \/>/.test(src("app/dashboard/admin/manager-trust/page.tsx")) && /requireCallerTenant\(\)/.test(src("app/actions/admin/strategy-library.ts")) && /isTenantAdminGrantRole\(/.test(src("app/actions/admin/strategy-library.ts")) && /activateLibraryStrategyFormAction/.test(src("app/dashboard/admin/manager-trust/strategy-library-panel.tsx")))
    check("F5 the 'use server' doors take no brokerage argument (tenant from the session)", !/export async function \w+\([^)]*brokerage/i.test(src("app/actions/admin/strategy-library.ts")))
    check("F6 strategy_overrides is registered tenant policy (versioned)", TENANT_POLICY_SETTINGS_KEYS.strategy_overrides?.store === "brokerage_settings.settings")
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
    check("F7 package.json test:strategy-engine → this guard, on the chain (membership, not position)", pkg.scripts["test:strategy-engine"] === "tsx scripts/strategy-engine-guard.ts" && /npm run test:strategy-engine(\s|&|$)/.test(pkg.scripts.guard))
    const d = MAINTENANCE_DOMAINS.strategy_engine
    check("F8 MAINTENANCE_DOMAINS owns it (campaign_orchestrator; co-owners data_steward + compliance_officer named in prose)", d?.manager === "campaign_orchestrator" && d.proof === "test:strategy-engine" && JSON.stringify(d.coOwners) === JSON.stringify(["data_steward", "compliance_officer"]) && d.what.includes("data_steward") && d.what.includes("compliance_officer"))
    check("F9 TABLE_MANAGER: strategy_library + strategy_activations → campaign_orchestrator", TABLE_MANAGER.strategy_library === "campaign_orchestrator" && TABLE_MANAGER.strategy_activations === "campaign_orchestrator")
    check("F10 strategyOwnershipOf reads only the strategy kind (a working_context row is not a strategy)", strategyOwnershipOf([{ kind: "working_context", ref: "x", owner: "ai_isa", managers: [] }]) === null)
    const fixture = stripComments(`// TOMBSTONE: selectStrategies( used to be called here\nconst x = 1\n/* activateStrategy( */`)
    check("F11 (control) a tombstone naming a door is NOT read as a call site", !fixture.includes("selectStrategies(") && !fixture.includes("activateStrategy(") && fixture.includes("const x = 1"))
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(" BLIND SPOTS (137E breadth): domain tags are declared beside each strategy / example, not inferred; compliance and education strategies carry NAMED gaps (compliance_officer owns no catalogue capability; agent coaching has none) — the census counts a strategy with a named gap as coverage; skill examples are offered as templates, their marketplace submission / approval runs only on the live page.")
  console.log(" BLIND SPOTS: in-memory client (no RLS, no CHECK, no immutability trigger — m725 holds those live once applied; the migration text is asserted); the real ledger / emit / signal / authority / entitlement seams are injected (their survivors have their own proofs); the ISA / orchestrator / controller wires are asserted by stripped source; the 107F learning seam is a test double here; tenant-tier strategies have a reader and a table but no authoring surface.")
  if (fail > 0) { console.log(" ❌ STRATEGY_ENGINE_FAIL"); process.exit(1) }
  console.log(" ✅ STRATEGY_ENGINE_PASS — managers select reusable strategies composed only of existing capabilities; a selection becomes a mission + delegations; the platform version stays immutable and the tenant's adaptation is recorded")
}
main().catch((e) => { console.error(e); process.exit(1) })
