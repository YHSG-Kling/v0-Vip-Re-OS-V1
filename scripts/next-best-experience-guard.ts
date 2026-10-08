#!/usr/bin/env tsx
/**
 * scripts/next-best-experience-guard.ts   (npm run test:next-best-experience)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ADAPTIVE CUSTOMER JOURNEY — NEXT BEST EXPERIENCE (wave 106, lane 106B).
 *
 * OWNER: "not 'every buyer gets Sequence #4'. PERSON + OPPORTUNITY + BEHAVIOR + MEMORY +
 * TRANSACTION STATE + EDUCATION STATE + FATIGUE + POLICY = NEXT BEST EXPERIENCE".
 *
 * IN-MEMORY, no credentials, no provider. The planner is pure; the loader runs against a
 * recording client; the evidence layer runs against recorder seams (ledger / emit / delegate).
 * Every absence assertion carries its positive control (CLAUDE.md §2); source assertions read
 * STRIPPED source (a tombstone is not a call site).
 *
 * BLIND SPOTS, stated beside the numbers: the live tables are not read here (the loader's
 * column names are asserted against scripts/schema-snapshot.ts, not the database); the
 * delegation seam is a recorder (requestDelegation's own gates are test:manager-delegation's);
 * the compliance hard flag is the CALLER's input — the send-time gate is test:fair-housing-*'s.
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import {
  EXPERIENCE_KINDS, EXPERIENCE_EXECUTORS, isExperienceKind, planNextBestExperience, transactionIsActive,
  contactFacingExperience, FINANCIAL_KEY_PATTERN, experienceReasonCode, loadNextBestExperienceInputs,
  recordAndExecuteExperience, journeyVerdictForEnrollment, EXPERIENCE_CONTACT_COLUMNS,
  type NextBestExperienceInput, type NextBestExperiencePlan,
} from "../lib/ai-isa/lead-action-plan"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { attributeOutcomesToLedger } from "../lib/intelligence/roi-ledger"
import { autoEnrollContact } from "../lib/campaign-sequences/auto-enroll"
import { KernelEvent } from "../lib/kernel/events"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const NOW = new Date("2026-10-06T15:00:00Z")
const base = (over: Partial<NextBestExperienceInput> = {}): NextBestExperienceInput => ({
  now: NOW, subject: "contact",
  nba: { memoryFacts: [] },
  person: { contactType: "buyer", persona: "first_time", hasAssignedAgent: true },
  behavior: { touchpoints7d: 0, lastTouchpointChannel: null, portalEducationViews: 0 },
  transaction: null, education: null, fatigue: { riskLevel: null },
  policy: { complianceHardFlag: false, allowedChannels: ["email", "sms"], autoSendAllowed: true, videoAllowed: true },
  ...over,
})
const intent = (score: number, trend: "rising" | "stable" | "falling" = "rising") =>
  ({ score, trend, velocityPerDay: 2, accelerationPerDay2: 0, confidence: "high", independentSources: 3, momentumRank: score, evidence: [] }) as any

console.log("\n── 1. THE VOCABULARY (§6) ──")
check("EXPERIENCE_KINDS is the owner's ten, spelled once", EXPERIENCE_KINDS.length === 10 && new Set(EXPERIENCE_KINDS).size === 10
  && ["communication", "education", "video", "properties", "appointment", "agent_intervention", "market_update", "portal_task", "document_explanation", "wait"].every((k) => (EXPERIENCE_KINDS as readonly string[]).includes(k)))
check("EXPERIENCE_KINDS is a frozen const (Object.isFrozen — a second spelling cannot be pushed in at runtime)", Object.isFrozen(EXPERIENCE_KINDS))
check("isExperienceKind accepts every kind", EXPERIENCE_KINDS.every(isExperienceKind))
check("isExperienceKind REFUSES a second spelling (positive control)", !isExperienceKind("agent intervention") && !isExperienceKind("nothing") && !isExperienceKind(null))
check("EXPERIENCE_EXECUTORS names an executor for every kind and only those", EXPERIENCE_KINDS.every((k) => !!EXPERIENCE_EXECUTORS[k]) && Object.keys(EXPERIENCE_EXECUTORS).length === EXPERIENCE_KINDS.length)
const SIX = new Set(["ai_isa", "shopping_agent", "listing_concierge", "asset_manager", "campaign_orchestrator", "deal_coordinator"])
check("every executor is one of the owner's six managers", EXPERIENCE_KINDS.every((k) => SIX.has(EXPERIENCE_EXECUTORS[k].manager)))
check("every executor with a catalogue capability OWNS it (CAPABILITY_MANAGER — the delegation seam's own rule)",
  EXPERIENCE_KINDS.every((k) => { const e = EXPERIENCE_EXECUTORS[k]; return e.capability === null || CAPABILITY_MANAGER[e.capability] === e.manager }),
  EXPERIENCE_KINDS.filter((k) => { const e = EXPERIENCE_EXECUTORS[k]; return e.capability !== null && CAPABILITY_MANAGER[e.capability] !== e.manager }).join(","))
check("every experienceReasonCode is in the ledger's m693 vocabulary", (() => {
  const vocab = src("lib/kernel/action-ledger.ts")
  return EXPERIENCE_KINDS.every((k) => vocab.includes(`"${experienceReasonCode(k)}"`))
})())

console.log("\n── 2. EACH INPUT SLICE CONTRIBUTES (and the control: without it, it does not) ──")
{
  const p = planNextBestExperience(base())
  check("baseline (no slice argues): communication — the sequence stays the delivery survivor", p.chosen.kind === "communication")
  check("baseline contributed only policy + floor", p.contributed.sort().join(",") === "floor,policy", p.contributed.join(","))
}
{
  const p = planNextBestExperience(base({ nba: { lastAnyTouchAt: new Date(NOW.getTime() - 3_600_000) } }))
  check("OPPORTUNITY: NBA 48h fatigue window → wait", p.chosen.kind === "wait" && p.nba.reasonCode === "recently_contacted" && p.contributed.includes("opportunity"))
  check("…wait carries the NBA's dueAt", p.chosen.dueAt instanceof Date && p.chosen.dueAt.getTime() > NOW.getTime())
}
{
  const p = planNextBestExperience(base({ nba: { deadEnds: [{ outcome: "do_not_contact", at: null, source: "test" }] } }))
  check("OPPORTUNITY: a terminal dead end → wait (do_nothing), never a touch", p.chosen.kind === "wait" && p.nba.action === "do_nothing")
}
{
  const p = planNextBestExperience(base({ nba: { callbackRequested: true, callbackDueAt: new Date(NOW.getTime() + 7_200_000) } }))
  check("OPPORTUNITY: a pending callback (contact) → wait for the agent's call", p.chosen.kind === "wait" && p.nba.reasonCode === "appointment_scheduled")
}
{
  const p = planNextBestExperience(base({ fatigue: { riskLevel: "critical" }, nba: { intent: intent(90) } }))
  check("FATIGUE: critical fatigue score → wait, even with intent 90 (owner: fatigue → wait)", p.chosen.kind === "wait" && p.contributed.includes("fatigue"))
  const c = planNextBestExperience(base({ fatigue: { riskLevel: "fresh" }, nba: { intent: intent(90) } }))
  check("…control: fresh fatigue does not wait", c.chosen.kind !== "wait")
  const m = planNextBestExperience(base({ fatigue: { riskLevel: "moderate" } }))
  check("…moderate fatigue tempers (communication −10) without blocking", m.chosen.kind === "communication" && m.chosen.score === 20 && m.contributed.includes("fatigue"))
}
{
  const p = planNextBestExperience(base({ policy: { complianceHardFlag: true, allowedChannels: ["email"], autoSendAllowed: true, videoAllowed: true }, nba: { intent: intent(95) } }))
  check("POLICY: hard fair-housing / compliance flag → agent_intervention above everything", p.chosen.kind === "agent_intervention" && p.chosen.score === 100)
  const w = planNextBestExperience(base({ policy: { complianceHardFlag: true, allowedChannels: ["email"], autoSendAllowed: true, videoAllowed: true }, fatigue: { riskLevel: "critical" } }))
  check("…hard flag outranks even the fatigue wait (a human decides)", w.chosen.kind === "agent_intervention")
  const n = planNextBestExperience(base({ policy: { complianceHardFlag: false, allowedChannels: [], autoSendAllowed: false, videoAllowed: true } }))
  check("POLICY: no auto-send / no channel → communication only stages (score 10), still never a send-time bypass", n.chosen.kind === "communication" && n.chosen.score === 10)
}
{
  const tx = { id: "t1", stage: "INSPECTION", status: "under_contract", nextMilestone: { name: "Inspection report", type: "inspection_deadline", targetDate: "2026-10-09", clientVisible: true } }
  const p = planNextBestExperience(base({ transaction: tx }))
  check("TRANSACTION: a document-shaped next milestone → document_explanation", p.chosen.kind === "document_explanation" && p.chosen.manager === "deal_coordinator")
  const q = planNextBestExperience(base({ transaction: { ...tx, nextMilestone: { name: "Schedule final walkthrough", type: "walkthrough", targetDate: null, clientVisible: true } } }))
  check("TRANSACTION: a step-shaped next milestone → portal_task", q.chosen.kind === "portal_task")
  const r = planNextBestExperience(base({ transaction: { ...tx, stage: "CLOSED", status: "closed" } }))
  check("…control: a CLOSED transaction contributes nothing", !r.contributed.includes("transaction") && r.chosen.kind === "communication")
  check("transactionIsActive: the CHECK vocabulary's stages", transactionIsActive({ id: "x", stage: "UNDER_CONTRACT", status: null, nextMilestone: null }) && !transactionIsActive({ id: "x", stage: "LOST", status: "lost", nextMilestone: null }) && !transactionIsActive(null))
}
{
  const p = planNextBestExperience(base({ education: { open: 1, completed: 0, nextModule: { id: "m1", title: "Earnest money, explained", milestoneKey: null } } }))
  check("EDUCATION: an open lesson → education (campaign_orchestrator / education_assign)", p.chosen.kind === "education" && p.chosen.capability === "education_assign")
  const s = planNextBestExperience(base({
    transaction: { id: "t1", stage: "APPRAISAL", status: "under_contract", nextMilestone: { name: "Appraisal", type: "appraisal", targetDate: null, clientVisible: true } },
    education: { open: 1, completed: 2, nextModule: { id: "m2", title: "What an appraisal gap means", milestoneKey: "APPRAISAL" } },
  }))
  check("EDUCATION: a lesson keyed to the deal's stage (72) outranks the document explanation (70)", s.chosen.kind === "education" && s.chosen.score === 72)
  const n = planNextBestExperience(base({ education: { open: 0, completed: 0, nextModule: null } }))
  check("…control: no lesson → education absent", !n.ranked.some((r) => r.kind === "education"))
}
{
  const p = planNextBestExperience(base({ nba: { intent: intent(70) } }))
  check("BEHAVIOR: buyer intent 70 rising → properties (shopping_agent)", p.chosen.kind === "properties" && p.chosen.manager === "shopping_agent" && p.chosen.score === 60)
  const s = planNextBestExperience(base({ nba: { intent: intent(70) }, person: { contactType: "seller", persona: null, hasAssignedAgent: true } }))
  check("BEHAVIOR: seller intent 70 → market_update (listing_concierge / cma_generate)", s.chosen.kind === "market_update" && s.chosen.capability === "cma_generate")
  const f = planNextBestExperience(base({ nba: { intent: intent(70, "falling") } }))
  check("…control: falling intent contributes nothing", !f.contributed.includes("behavior"))
  const t = planNextBestExperience(base({ behavior: { touchpoints7d: 4, lastTouchpointChannel: "email", portalEducationViews: 0 } }))
  check("BEHAVIOR: 4 campaign touchpoints in 7d → the default message is cancelled (30 − 30) → wait wins the floor", t.chosen.kind === "wait" && t.ranked.find((r) => r.kind === "communication")?.score === 0)
  const e = planNextBestExperience(base({ behavior: { touchpoints7d: 4, lastTouchpointChannel: "email", portalEducationViews: 0 }, education: { open: 1, completed: 0, nextModule: { id: "m", title: "x", milestoneKey: null } } }))
  check("…control: a DIFFERENT kind of experience (education) still wins over the cancelled message", e.chosen.kind === "education")
}
{
  const p = planNextBestExperience(base({ person: { contactType: "lifetime", persona: null, hasAssignedAgent: true } }))
  check("PERSON: lifetime → video (asset_manager)", p.chosen.kind === "video" && p.chosen.manager === "asset_manager")
  // WAVE 108: the CANONICAL lifetime spellings (contacts.contact_type 'lifetime_customer' / 'sphere') reach the
  // video too — the old literal matched only retired spellings — and the video is ROUTED THROUGH sphere_of_influence.
  const canon = ["lifetime_customer", "sphere"].map((t) => planNextBestExperience(base({ person: { contactType: t, persona: null, hasAssignedAgent: true } })))
  check("PERSON (wave 108): a canonical lifetime contact (lifetime_customer / sphere) → video, routed via sphere_of_influence (asset_manager renders)", canon.every((x) => x.chosen.kind === "video" && x.chosen.manager === "asset_manager" && x.chosen.via === "sphere_of_influence"))
  check("PERSON (wave 108, control): a buyer contact's video is NOT routed via the Sphere Manager", (() => { const b = planNextBestExperience(base({ person: { contactType: "buyer", persona: null, hasAssignedAgent: true }, memory: [{ key: "channel_preference", value: "video please" }] } as any)); const vid = b.ranked.find((r) => r.kind === "video"); return !vid || vid.via === undefined })())
  const v = planNextBestExperience(base({ person: { contactType: "lifetime", persona: null, hasAssignedAgent: true }, policy: { complianceHardFlag: false, allowedChannels: ["email"], autoSendAllowed: true, videoAllowed: false } }))
  check("…POLICY: video opt-out removes video", v.chosen.kind !== "video" && (v.ranked.find((r) => r.kind === "video")?.score ?? 0) < 0)
  const a = planNextBestExperience(base({ person: { contactType: "buyer", persona: null, hasAssignedAgent: false } }))
  check("PERSON: no assigned agent → agent_intervention weighed (20), communication (30) still wins", a.ranked.some((r) => r.kind === "agent_intervention" && r.score === 20) && a.chosen.kind === "communication")
}
{
  const p = planNextBestExperience(base({ nba: { intent: intent(62), memoryFacts: [{ key: "timeline", value: "1-3 months", confidence: 0.9, observedAt: NOW.toISOString() }, { key: "price_expectation", value: "up to 650000", confidence: 0.8, observedAt: NOW.toISOString() }] } }))
  check("MEMORY: timeline 1-3 + price expectation lift properties (+15)", p.chosen.kind === "properties" && p.chosen.score === 75 && p.contributed.includes("memory"))
  const v = planNextBestExperience(base({ nba: { memoryFacts: [{ key: "channel_preference", value: "video", confidence: 0.9, observedAt: NOW.toISOString() }] } }))
  check("MEMORY: prefers video → video weighed (15)", v.ranked.some((r) => r.kind === "video" && r.score === 15))
}
{
  const p = planNextBestExperience(base({ nba: { intent: intent(70) }, education: { open: 1, completed: 0, nextModule: { id: "m", title: "x", milestoneKey: null } }, transaction: { id: "t", stage: "UNDER_CONTRACT", status: "under_contract", nextMilestone: { name: "Purchase contract", type: "contract", targetDate: null, clientVisible: true } } }))
  check("RANKED: every candidate is listed with its reasons, highest first, ties by vocabulary order", p.ranked.length >= 4 && p.ranked.every((r, i, a) => i === 0 || a[i - 1].score >= r.score) && p.ranked.every((r) => r.reasons.length > 0))
  check("the plan is deterministic (same input → same JSON)", JSON.stringify(planNextBestExperience(base({ nba: { intent: intent(70) } }))) === JSON.stringify(planNextBestExperience(base({ nba: { intent: intent(70) } }))))
}

console.log("\n── 3. NO FINANCIALS TO CONTACTS (§5) ──")
{
  const p = planNextBestExperience(base({ nba: { intent: intent(70) } }))
  const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [k, ...keys(v)]) : [])
  check("the whole plan carries no financial key", !keys(p).some((k) => FINANCIAL_KEY_PATTERN.test(k)), keys(p).filter((k) => FINANCIAL_KEY_PATTERN.test(k)).join(","))
  const cf = contactFacingExperience(p)
  check("contactFacingExperience exposes only kind + dueAt (no reasons, no manager, no scores)", Object.keys(cf).sort().join(",") === "dueAt,experience")
  check("positive control: the pattern catches a cost_usd / commission_amount key", keys({ a: { cost_usd: 1 } }).some((k) => FINANCIAL_KEY_PATTERN.test(k)) && FINANCIAL_KEY_PATTERN.test("commission_amount"))
}

console.log("\n── 4. THE LOADER — every slice through its survivor, tenant-pinned, refusals honest ──")
type Call = { table: string; filters: Record<string, unknown>; op: string[] }
function client(results: Record<string, any[]>, refuse: Record<string, string> = {}) {
  const calls: Call[] = []
  return {
    calls,
    from(table: string) {
      const rec: Call = { table, filters: {}, op: [] }
      calls.push(rec)
      const data = results[table] ?? []
      const err = refuse[table] ? { message: refuse[table], code: "42501" } : null
      const b: any = {
        select() { return b }, order() { return b }, limit() { return b }, gte() { return b }, is() { return b }, not() { return b },
        or(expr: string) { rec.filters.or = expr; return b },
        eq(c: string, v: unknown) { rec.filters[c] = v; return b },
        maybeSingle() { return Promise.resolve(err ? { data: null, error: err } : { data: data[0] ?? null, error: null }) },
        then(res: any, rej?: any) { return Promise.resolve(err ? { data: null, error: err } : { data, error: null }).then(res, rej) },
      }
      return b
    },
  }
}
const contact = { id: "c1", contact_type: "buyer", contact_persona: "first_time", agent_id: "a1", ai_outreach_paused: false, last_contacted_at: null, video_opt_out: false }
{
  const c = client({
    transactions: [{ id: "t1", stage: "INSPECTION", status: "under_contract" }],
    transaction_milestones: [{ milestone_name: "Inspection report", milestone_type: "inspection_deadline", status: "pending", target_date: "2026-10-09", is_client_visible: true }],
    learning_assignments: [{ module_id: "m1", status: "open" }, { module_id: "m0", status: "completed" }],
    learning_modules: [{ id: "m1", title: "Inspection, explained", milestone_key: "INSPECTION" }],
    buyer_fatigue_scores: [{ risk_level: "moderate" }],
    marketing_campaign_touchpoints: [{ channel: "email" }, { channel: "sms" }],
    lifecycle_events: [{ id: "e1" }],
  })
  const r = await loadNextBestExperienceInputs(c, { brokerageId: "b1", contact, humanInitiated: false, now: NOW, preloaded: { nba: { intent: intent(70) } } })
  check("loader: ok with the NBA context preloaded (read ONCE per turn — 105C's rule)", r.ok)
  if (r.ok) {
    check("TRANSACTION slice: active deal + its client-visible pending milestone", r.input.transaction?.stage === "INSPECTION" && r.input.transaction?.nextMilestone?.name === "Inspection report" && r.input.transaction?.nextMilestone?.clientVisible === true)
    check("EDUCATION slice: 1 open / 1 completed, next module with milestone_key", r.input.education?.open === 1 && r.input.education?.completed === 1 && r.input.education?.nextModule?.milestoneKey === "INSPECTION")
    check("FATIGUE slice: the calculator's risk_level", r.input.fatigue.riskLevel === "moderate")
    check("BEHAVIOR slice: 2 touchpoints in 7d (last email), 1 portal education view", r.input.behavior.touchpoints7d === 2 && r.input.behavior.lastTouchpointChannel === "email" && r.input.behavior.portalEducationViews === 1)
    check("PERSON slice: type / persona / assigned agent from the row", r.input.person.contactType === "buyer" && r.input.person.hasAssignedAgent)
    check("POLICY slice: unreadable settings (no credentials here) → published as a blind spot, auto-send OFF", r.input.policy.autoSendAllowed === false && (r.input.blindSpots ?? []).some((s) => s.startsWith("policy:")))
    const plan = planNextBestExperience(r.input)
    check("end to end: education keyed to the deal stage wins (72) over the document explanation (70)", plan.chosen.kind === "education" && plan.ranked.find((x) => x.kind === "document_explanation")?.score === 70)
  }
  const EXEMPT = new Set(["learning_modules"]) // keyed by the tenant-pinned assignment's module_id; modules may be platform-authored (brokerage_id null)
  const unpinned = c.calls.filter((x) => !EXEMPT.has(x.table) && x.filters.brokerage_id !== "b1")
  check("TENANT ISOLATION: every loader read is pinned to brokerage_id (learning_modules exempt, by its assignment)", unpinned.length === 0, unpinned.map((x) => x.table).join(","))
  check("the contact is addressed on both transaction sides (contact_id / buyer_contact_id)", c.calls.some((x) => x.table === "transactions" && String(x.filters.or).includes("buyer_contact_id.eq.c1")))
  for (const t of ["transactions", "transaction_milestones", "learning_assignments", "learning_modules", "buyer_fatigue_scores", "marketing_campaign_touchpoints", "lifecycle_events"]) {
    check(`schema: ${t} is a live table the loader reads`, Array.isArray((SCHEMA_SNAPSHOT as Record<string, string[]>)[t]))
  }
  const cols: Array<[string, string[]]> = [["transactions", ["stage", "status", "contact_id", "buyer_contact_id", "deleted_at"]], ["transaction_milestones", ["milestone_name", "milestone_type", "target_date", "is_client_visible"]], ["learning_assignments", ["module_id", "status", "contact_id"]], ["learning_modules", ["title", "milestone_key"]], ["buyer_fatigue_scores", ["risk_level"]], ["marketing_campaign_touchpoints", ["channel", "contact_id"]]]
  check("schema: every column the loader names exists in the snapshot", cols.every(([t, cs]) => cs.every((col) => (SCHEMA_SNAPSHOT as Record<string, string[]>)[t]?.includes(col))), cols.flatMap(([t, cs]) => cs.filter((col) => !(SCHEMA_SNAPSHOT as Record<string, string[]>)[t]?.includes(col)).map((col) => `${t}.${col}`)).join(","))
  check("schema: EXPERIENCE_CONTACT_COLUMNS all exist on contacts", EXPERIENCE_CONTACT_COLUMNS.split(",").map((s) => s.trim()).every((col) => (SCHEMA_SNAPSHOT as Record<string, string[]>).contacts?.includes(col)))
}
{
  const r = await loadNextBestExperienceInputs(client({}, { transactions: "permission denied" }), { brokerageId: "b1", contact, humanInitiated: false, now: NOW, preloaded: { nba: {} } })
  check("FAIL CLOSED: a refused transactions read refuses the plan (never 'no deal')", !r.ok && /transactions read refused/.test((r as any).error))
  const e = await loadNextBestExperienceInputs(client({}, { buyer_fatigue_scores: "denied", learning_assignments: "denied", marketing_campaign_touchpoints: "denied" }), { brokerageId: "b1", contact, humanInitiated: false, now: NOW, preloaded: { nba: {} } })
  check("EVIDENCE slices refused → the plan still runs, each refusal a published blind spot", e.ok && (e.input.blindSpots ?? []).filter((s) => /^(fatigue|education|behavior):/.test(s)).length === 3, e.ok ? e.input.blindSpots?.join(" | ") : (e as any).error)
}

console.log("\n── 5. EVIDENCE + EXECUTION — withActionLedger + emitKernelEvent + the delegation seam ──")
type Rec = { ledger: any[]; settled: any[]; emits: any[]; delegations: any[] }
function recorders(delegateOk = true): { rec: Rec; deps: Parameters<typeof recordAndExecuteExperience>[2] } {
  const rec: Rec = { ledger: [], settled: [], emits: [], delegations: [] }
  return {
    rec,
    deps: {
      ledger: (async (ctx: any, run: () => Promise<any>, hooks: any) => { rec.ledger.push(ctx); const r = await run(); rec.settled.push(hooks.settle(r)); return r }) as any,
      emit: async (input) => { rec.emits.push(input); return { inserted: true, lifecycleEventId: "le1", fanOutOk: true, error: null } },
      delegate: async (input) => { rec.delegations.push(input); return delegateOk ? { ok: true, delegation: { id: "d1" } } : { ok: false, reason: "entitlement:education_assign:budget" } },
    },
  }
}
{
  const plan = planNextBestExperience(base({ education: { open: 1, completed: 0, nextModule: { id: "m1", title: "x", milestoneKey: null } } }))
  const { rec, deps } = recorders()
  const out = await recordAndExecuteExperience({}, { brokerageId: "b1", contactId: "c1", plan, now: NOW, missionId: "m-9" }, deps)
  check("education → DELEGATED to campaign_orchestrator / education_assign through the 105A seam", out.execution.mode === "delegated" && rec.delegations[0]?.assignedManager === "campaign_orchestrator" && rec.delegations[0]?.capability === "education_assign" && rec.delegations[0]?.requestingManager === "ai_isa")
  check("…the delegation carries the mission and the contact", rec.delegations[0]?.missionId === "m-9" && rec.delegations[0]?.inputEntities?.contact_id === "c1" && rec.delegations[0]?.inputEntities?.experience === "education")
  const l = rec.ledger[0]
  check("LEDGER: journey.experience.education, actor manager ai_isa, subject contact, policy ai_isa_settings", l?.action === "journey.experience.education" && l?.actor?.managerKey === "ai_isa" && l?.subject?.id === "c1" && l?.policyKey === "ai_isa_settings" && l?.brokerageId === "b1")
  check("LEDGER: detail.experience is the vocabulary word the outcome engine reads", l?.detail?.experience === "education" && Array.isArray(l?.detail?.ranked) && l?.detail?.mission_id === "m-9")
  check("LEDGER: idempotent per contact × kind × UTC day (cycle)", l?.cycle === "nbe:education:2026-10-06")
  check("LEDGER: settled 'executed' with the delegation id as outcome", rec.settled[0]?.status === "executed" && rec.settled[0]?.outcome === "delegated:d1")
  check("EVENT: next_best_experience_chosen, auditOnly, on the contact, with the experience + execution", rec.emits[0]?.event === "next_best_experience_chosen" && rec.emits[0]?.auditOnly === true && rec.emits[0]?.entityId === "c1" && rec.emits[0]?.metadata?.experience === "education" && rec.emits[0]?.metadata?.execution === "delegated")
  check("EVENT: the enum carries it (KernelEvent.NEXT_BEST_EXPERIENCE_CHOSEN)", KernelEvent.NEXT_BEST_EXPERIENCE_CHOSEN === "next_best_experience_chosen")
  check("the record reports ledgered + eventEmitted, no warnings", out.ledgered && out.eventEmitted && out.warnings.length === 0, out.warnings.join("; "))
}
{
  const plan = planNextBestExperience(base({ education: { open: 1, completed: 0, nextModule: { id: "m1", title: "x", milestoneKey: null } } }))
  const { rec, deps } = recorders(false)
  const out = await recordAndExecuteExperience({}, { brokerageId: "b1", contactId: "c1", plan, now: NOW }, deps)
  check("DEGRADES HONESTLY: a refused delegation → 'unexecuted' with its reason, ledgered 'skipped' (never pretended)", out.execution.mode === "unexecuted" && (out.execution as any).reason.startsWith("entitlement:") && rec.settled[0]?.status === "skipped" && rec.settled[0]?.error?.startsWith("entitlement:"))
}
{
  const plan = planNextBestExperience(base({ fatigue: { riskLevel: "critical" } }))
  const { rec, deps } = recorders()
  const out = await recordAndExecuteExperience({}, { brokerageId: "b1", contactId: "c1", plan, now: NOW }, deps)
  check("wait → executes nothing, delegates nothing, STILL ledgered (WAIT_COOLDOWN) + audited", out.execution.mode === "none" && rec.delegations.length === 0 && rec.ledger[0]?.reasonCode === "WAIT_COOLDOWN" && rec.settled[0]?.status === "skipped" && rec.emits.length === 1)
}
{
  const plan = planNextBestExperience(base())
  const { rec, deps } = recorders()
  const out = await recordAndExecuteExperience({}, { brokerageId: "b1", contactId: "c1", plan, now: NOW }, deps)
  check("communication → 'caller' (the ISA / the sequence delivers), no delegation, ledgered executed", out.execution.mode === "caller" && rec.delegations.length === 0 && rec.settled[0]?.status === "executed")
}
{
  const plan = planNextBestExperience(base({ nba: { intent: intent(70) } }))
  const { rec, deps } = recorders()
  const out = await recordAndExecuteExperience({}, { brokerageId: "b1", contactId: "c1", plan, now: NOW }, deps)
  check("properties (no catalogue capability yet) → 'unexecuted' naming the shopping agent's own rail — stated, not faked", out.execution.mode === "unexecuted" && (out.execution as any).manager === "shopping_agent" && /own rail/.test((out.execution as any).reason) && rec.delegations.length === 0)
}

console.log("\n── 6. THE ENROLLER CONSULTS THE PLANNER BEFORE ENROLLING ──")
{
  const svc = client({ contacts: [contact] })
  const waitLoad = (async () => ({ ok: true, input: base({ fatigue: { riskLevel: "critical" } }) })) as any
  const { rec, deps } = recorders()
  const v = await journeyVerdictForEnrollment(svc, { brokerageId: "b1", contactId: "c1", now: NOW }, { ...deps, load: waitLoad })
  check("journeyVerdictForEnrollment: wait → proceed:false, LEDGERED as the decision (systemSource sequence_enroller)", !v.proceed && v.experience === "wait" && rec.ledger[0]?.systemSource === "sequence_enroller")
  const okLoad = (async () => ({ ok: true, input: base() })) as any
  const v2 = await journeyVerdictForEnrollment(svc, { brokerageId: "b1", contactId: "c1", now: NOW }, { ...deps, load: okLoad })
  check("…communication → proceed:true (the sequence remains the delivery survivor)", v2.proceed && v2.experience === "communication")
  const v3 = await journeyVerdictForEnrollment(svc, { brokerageId: "b1", contactId: "c1", now: NOW }, { ...deps, load: (async () => ({ ok: false, error: "transactions read refused: x" })) as any })
  check("…unreadable inputs → proceed:false, stated (fail closed)", !v3.proceed && /not enrolling/.test(v3.reason))
  const v4 = await journeyVerdictForEnrollment(client({ contacts: [] }), { brokerageId: "b2", contactId: "c1", now: NOW }, { ...deps, load: okLoad })
  check("TENANT: a contact not in the brokerage is refused before any plan", !v4.proceed && /not in this brokerage/.test(v4.reason))
  check("…the contact read is tenant-pinned", svc.calls.every((x) => x.table !== "contacts" || x.filters.brokerage_id === "b1"))
}
{
  // autoEnrollContact — the source-keyed enroller, with the consult injected.
  function enrollDb(withExisting = false) {
    const calls: Array<{ table: string; payload?: any }> = []
    const q: Record<string, any[][]> = { campaign_sequences: [[{ id: "s1", contact_type: null, persona: null }]], sequence_enrollments: [withExisting ? [{ id: "e1", status: "active" }] : []] }
    return { calls, db: { from(table: string) { const rec = { table, payload: undefined as any }; calls.push(rec); const next = () => (q[table] ?? []).shift() ?? []; const b: any = { select() { return b }, eq() { return b }, in() { return b }, limit() { return b }, insert(p: any) { rec.payload = p; return Promise.resolve({ error: null }) }, maybeSingle() { return Promise.resolve({ data: next()[0] ?? null, error: null }) }, then(res: any) { return Promise.resolve({ data: next(), error: null }).then(res) } }; return b } } }
  }
  const a = enrollDb()
  const r = await autoEnrollContact(a.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller", journey: { consult: async () => ({ proceed: false, experience: "wait", reason: "fatigue risk critical" }) } })
  check("autoEnrollContact: a `wait` verdict OVERRIDES the default sequence (not enrolled, reason journey:wait)", !r.enrolled && /^journey:wait:/.test(r.reason ?? "") && !a.calls.some((c) => c.table === "sequence_enrollments" && c.payload))
  const b = enrollDb()
  const r2 = await autoEnrollContact(b.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller", journey: { consult: async () => ({ proceed: false, experience: "agent_intervention", reason: "hard flag" }) } })
  check("autoEnrollContact: `agent_intervention` overrides too", !r2.enrolled && /^journey:agent_intervention:/.test(r2.reason ?? ""))
  const c = enrollDb()
  const r3 = await autoEnrollContact(c.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller", journey: { consult: async () => ({ proceed: true, experience: "communication", reason: "default" }) } })
  check("autoEnrollContact: `communication` → enrolled (positive control — the gate is not 'refuse everything')", r3.enrolled && c.calls.some((x) => x.table === "sequence_enrollments" && x.payload))
  const d = enrollDb()
  const r4 = await autoEnrollContact(d.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller", journey: null })
  check("autoEnrollContact: journey:null (the caller already ran the planner) skips the consult and enrols", r4.enrolled && !d.calls.some((x) => x.table === "contacts"))
}

console.log("\n── 7. OUTCOME ATTRIBUTION LEARNS WHICH EXPERIENCE CONVERTS ──")
{
  const act = (id: string, detail: Record<string, unknown>, at: string) => ({ id, brokerage_id: "b1", action: "journey.experience.education", status: "executed", reason_code: "NURTURE_TOUCH", actor_type: "manager", actor_manager_key: "ai_isa", system_source: "next_best_experience", subject_type: "contact", subject_id: "c1", created_at: at, detail })
  const outcome = { ref: "appointment:ap1", kind: "appointment" as const, brokerageId: "b1", subjectIds: ["c1"], at: "2026-10-10T00:00:00Z", revenueCents: 0 }
  const r = attributeOutcomesToLedger([outcome], [act("l1", { experience: "education" }, "2026-10-06T00:00:00Z"), act("l2", { experience: "not-a-kind" }, "2026-10-05T00:00:00Z")])
  check("byExperience: the last-touch credit lands on the EXPERIENCE kind (education)", r.byExperience.length === 1 && r.byExperience[0].key === "education" && r.byExperience[0].lastTouchOutcomes.appointment === 1)
  check("positive control: a detail.experience outside EXPERIENCE_KINDS is NOT an experience row", !r.byExperience.some((x) => x.key === "not-a-kind"))
  check("…and the other dimensions are untouched (byManager still credits ai_isa)", r.byManager.some((x) => x.key === "ai_isa"))
}

console.log("\n── 8. WIRED — stripped source (a tombstone is not a call site) ──")
{
  const engage = blankStrings(src("app/actions/ai-isa/engage-contact.ts"))
  check("engage-contact loads the inputs, plans, records + executes AFTER its NBA verdict", /loadNextBestExperienceInputs\(supabase/.test(engage) && /planNextBestExperience\(inputs\.input\)/.test(engage) && /recordAndExecuteExperience\(supabase/.test(engage)
    && engage.indexOf("planNextContactTouch(") < engage.indexOf("planNextBestExperience("))
  check("engage-contact does not send on top of a non-communication experience (autonomous run)", /plan\.chosen\.kind !== .communication. && !humanInitiated/.test(src("app/actions/ai-isa/engage-contact.ts")))
  const ae = src("lib/campaign-sequences/auto-enroll.ts")
  check("auto-enroll consults journeyVerdictForEnrollment BEFORE the sequence_enrollments insert", /journeyVerdictForEnrollment\(c, a\)/.test(ae) && ae.indexOf("journeyVerdictForEnrollment") < ae.indexOf('from("sequence_enrollments").insert'))
  const ef = src("lib/kernel/event-fanout.ts")
  check("event-fanout (the event-keyed enroller) consults the same verdict before its insert", /journeyVerdictForEnrollment\(supabase, \{ brokerageId, contactId \}\)/.test(ef) && ef.indexOf("journeyVerdictForEnrollment") < ef.indexOf('from("sequence_enrollments").insert'))
  check("memory video / anniversary reel / portal task creator accept a PlannerIssuedRequest",
    /request\?: import\("@\/lib\/ai-isa\/lead-action-plan"\)\.PlannerIssuedRequest/.test(readFileSync("lib/video/memory-video.ts", "utf8"))
    && /request\?: import\("@\/lib\/ai-isa\/lead-action-plan"\)\.PlannerIssuedRequest/.test(readFileSync("lib/video/intro-video-reactor.ts", "utf8"))
    && /request\?: import\("@\/lib\/ai-isa\/lead-action-plan"\)\.PlannerIssuedRequest/.test(readFileSync("lib/transactions/milestone-service.ts", "utf8"))
    && /planner_request/.test(src("lib/video/intro-video-reactor.ts")) && /request\.reasons\[0\]/.test(src("lib/video/memory-video.ts")) && /request\.experience/.test(src("lib/transactions/milestone-service.ts")))
  // Wave 107G (106B open loop): the MANUAL enrolment path (enrollment-engine.enrollContact) consults the
  // same verdict — advise for a human (proceeds, verdict returned), hold for an autonomous caller.
  const ee = src("lib/campaign-sequences/enrollment-engine.ts")
  check("enrollContact consults journeyVerdictForEnrollment (contact recipients, when `journey` is requested) BEFORE its sequence_enrollments insert; hold refuses, advise proceeds with the verdict on the result",
    /if \(params\.journey && !isLead\)/.test(ee) && /journeyVerdictForEnrollment\(supabase, \{ brokerageId: params\.brokerageId, contactId: recipientId \}\)/.test(ee)
    && ee.indexOf("journeyVerdictForEnrollment") < ee.indexOf('.from("sequence_enrollments")\n    .insert') && /!v\.proceed && params\.journey === "hold"/.test(ee) && /heldByJourney: true/.test(ee) && /\.\.\.\(journey \? \{ journey \} : \{\}\)/.test(ee))
  const wf = src("app/actions/workflows.ts")
  check("the human manual path (startSmartDrip, enrolledBy = the session user) asks for advice, and the contact card shows it", /enrolledBy: ctx\.userId,\s*journey: "advise",/.test(wf) && /journeyAdvice:/.test(wf) && /result\.journeyAdvice/.test(src("app/crm/contacts/[contactId]/components/smart-drip-card.tsx")))
  check("(control) a commented-out consult is not read as one", !/journeyVerdictForEnrollment\(supabase/.test(stripComments("// journeyVerdictForEnrollment(supabase, { brokerageId })\nconst y = 2")))
  check("properties / document_explanation stay NAMED-unexecuted: no catalogue capability exists for either (CAPABILITY_MANAGER has no property-match / document capability)", EXPERIENCE_EXECUTORS.properties.capability === null && EXPERIENCE_EXECUTORS.document_explanation.capability === null && !Object.keys(CAPABILITY_MANAGER).some((k) => /propert|match|alert|document|explain/.test(k)))
  check("no second planner: planNextBestExperience is defined once, in the NBA survivor", (src("lib/ai-isa/lead-action-plan.ts").match(/export function planNextBestExperience\(/g) ?? []).length === 1)
  const dom = MAINTENANCE_DOMAINS.next_best_experience
  check("MAINTENANCE_DOMAINS.next_best_experience: owner ai_isa, proof test:next-best-experience, co-owners named in prose", !!dom && dom.manager === "ai_isa" && dom.proof === "test:next-best-experience" && (dom.coOwners ?? []).length === 3 && (dom.coOwners ?? []).every((c) => dom.what.includes(c)))
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
  check("package.json: registered and in the guard chain (position is not pinned — CLAUDE.md §2)", pkg.scripts["test:next-best-experience"] === "tsx scripts/next-best-experience-guard.ts" && new RegExp("npm run test:next-best-experience(\\s|&|$)").test(pkg.scripts.guard))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
console.log(" BLIND SPOTS: live tables not read (columns asserted against scripts/schema-snapshot.ts); delegation + ledger + emit are recorder seams (their own gates are test:manager-delegation / test:action-ledger / test:event-flow); the compliance hard flag is the caller's input.")
if (failed > 0) { console.log(` FAILED: ${failures.join(" | ")}`); console.log(" ❌ NEXT_BEST_EXPERIENCE_FAIL"); process.exit(1) }
console.log(" ✅ NEXT_BEST_EXPERIENCE_PASS — the journey chooses the experience; the sequence only delivers it")
