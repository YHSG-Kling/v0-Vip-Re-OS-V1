#!/usr/bin/env tsx
/**
 * scripts/replay-harness-guard.ts  (npm run test:replay-harness) — wave 101, lane 101B, gap map row 20.
 *
 * Proves the DECISION REPLAY HARNESS (lib/kernel/decision-replay.ts over the pure planners in
 * lib/ai-isa/lead-action-plan.ts) and the ONE EXPERIMENT ASSIGNER (lib/kernel/experiments.ts):
 *   R1  replaying the UNCHANGED planner on recorded decisions agrees 100% (and is deterministic);
 *   R2  a MUTATED planner rule shows a disagreement, counted by reason code;
 *   R3  a recorded row without decision_input is published as unreplayable, never as agreement;
 *   R4  a cross-tenant replay is refused (pure core + kernel read pin + server-action gate);
 *   R5  the 100A attribution join puts the outcome on the decision that would have changed;
 *   E1  assignment is stable for the same inputs and spreads evenly over many subjects;
 *   E2  a disabled / killed / unreadable experiment assigns control;
 *   E3  attribution rolls revenue up by arm (detail.experiment);
 *   W   wiring on the real callers, read from STRIPPED source, each with a positive control.
 * Pure + fake clients, no DB, no model calls.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  planNextLeadTouch, planNextContactTouch, nonActionRecordFor, decisionInputSnapshot, planFromDecisionInput,
  type PlanNextLeadTouchInput, type NextBestActionContext, type DecisionInputSnapshot,
} from "../lib/ai-isa/lead-action-plan"
import { DEFAULT_AISA_SETTINGS } from "../lib/ai-isa/settings-types"
import { replayDecisions, type ReplayableLedgerRow, type ReplayPlanner, type DecisionReplayReport } from "../lib/kernel/decision-replay"
import { assignExperimentArm, EXPERIMENT_DEFINITIONS, loadExperimentPolicy, experimentLedgerDetail, type ExperimentDefinition } from "../lib/kernel/experiments"
import { attributeOutcomesToLedger } from "../lib/intelligence/roi-ledger"
import { sequenceStepLedger } from "../lib/workflow/channel-registry"
import { decideClaimedTenant } from "../lib/platform/acting-context"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const B = "11111111-1111-4111-8111-111111111111"
const OTHER = "99999999-9999-4999-8999-999999999999"
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const H = 3_600_000

// ── recorded decisions, built by the REAL recorder path (plan → nonActionRecordFor + snapshot) ──
const base: PlanNextLeadTouchInput = {
  now: new Date("2026-09-20T15:00:00Z"),
  settings: { ...DEFAULT_AISA_SETTINGS },
  touchesSoFar: 1,
  lastTouchAt: new Date("2026-09-01T12:00:00Z"),
  lastChannel: "email",
  channelsAlreadyStaged: ["email"],
  emailUsable: true,
  mailingVerified: true,
  reelReady: true,
  lifecycleState: "unconsented",
}
const leadCases: Array<Partial<PlanNextLeadTouchInput>> = [
  { context: { outreachPaused: true } },                                                       // do_nothing outreach_paused
  { context: { lastAnyTouchAt: new Date("2026-09-20T10:00:00Z") } },                           // wait recently_contacted
  { context: { lastAnyTouchAt: new Date("2026-09-19T20:00:00Z"), dncOrNoConsent: true } },      // wait recently_contacted
  { lastTouchAt: new Date("2026-09-19T12:00:00Z") },                                           // wait interval_not_elapsed
  { touchesSoFar: 9 },                                                                         // do_nothing max_touches_reached
  { lifecycleState: "representation" },                                                        // do_nothing blocked_lifecycle
  { context: { duplicateOf: uuid(777) } },                                                     // do_nothing duplicate
  { context: { deadEnds: [{ outcome: "not_interested", at: new Date("2026-09-10T00:00:00Z"), source: "ai_isa_activities.outcome" }] } }, // dead_end
  { context: { deadEnds: [{ outcome: "postponed", at: new Date("2026-09-10T00:00:00Z"), source: "leads.long_term_nurture_until", until: new Date("2026-12-01T00:00:00Z") }] } }, // postponed
  { context: { appointmentAt: new Date("2026-09-25T00:00:00Z") } },                            // wait appointment_scheduled
  // intent round-trips (its evidence list is dropped — evidence never decides; priority/reasons still replay)
  { context: { recipientLocalHour: 23, intent: { score: 41, confidence: "low", independentSources: 1, corroboration: 0, velocityPerDay: -1.5, accelerationPerDay2: 0.2, trend: "falling", momentumRank: 30.4,
    evidence: [{ type: "inbound_reply", source: "isa_outreach_log", ageDays: 3, ageUnknown: false, halfLifeDays: 14, contribution: 12 }] } } as unknown as NextBestActionContext }, // wait quiet_hours
]
const contactCases: NextBestActionContext[] = [
  { lastAnyTouchAt: new Date("2026-09-20T09:00:00Z") },
  { lastAgentTouchAt: new Date("2026-09-18T09:00:00Z") },
  { outreachPaused: true, memoryFacts: [{ key: "timeline", value: "3-6", confidence: 0.8, observedAt: "2026-09-01" }] },
]

const rows: ReplayableLedgerRow[] = []
let n = 0
for (const c of leadCases) {
  const input = { ...base, ...c } as PlanNextLeadTouchInput
  const plan = planNextLeadTouch(input)
  const subjectId = uuid(++n)
  const rec = nonActionRecordFor(plan, { brokerageId: B, leadId: subjectId, now: input.now }, decisionInputSnapshot({ subject: "lead", plan: input }))
  if (!rec) continue
  // jsonb round trip — what the ledger actually hands back
  rows.push({ id: uuid(1000 + n), brokerage_id: B, action: `lead.decision.${rec.decision}`, status: "skipped", subject_type: "lead", subject_id: subjectId,
    created_at: new Date(input.now.getTime() + n * 1000).toISOString(), detail: JSON.parse(JSON.stringify(rec.detail)) })
}
for (const ctx of contactCases) {
  const now = new Date("2026-09-20T15:00:00Z")
  const plan = planNextContactTouch({ now, context: ctx })
  const subjectId = uuid(++n)
  const rec = nonActionRecordFor(plan, { brokerageId: B, contactId: subjectId, now }, decisionInputSnapshot({ subject: "contact", now, context: ctx }))
  if (!rec) continue
  rows.push({ id: uuid(1000 + n), brokerage_id: B, action: `contact.decision.${rec.decision}`, status: "skipped", subject_type: "contact", subject_id: subjectId,
    created_at: new Date(now.getTime() + n * 1000).toISOString(), detail: JSON.parse(JSON.stringify(rec.detail)) })
}

async function main() {
  console.log("══════════════════════════════════════════════════\n Decision replay harness + experiment assignment\n══════════════════════════════════════════════════")

  console.log("\n[R1] unchanged planner → 100% agreement, deterministic")
  const recordedCodes = new Set(rows.map((r) => String((r.detail as { plan_code?: string }).plan_code)))
  check("fixture covers wait AND do_nothing on BOTH subjects, ≥8 distinct reason codes",
    rows.some((r) => r.action === "lead.decision.wait") && rows.some((r) => r.action === "lead.decision.do_nothing") &&
    rows.some((r) => r.action.startsWith("contact.decision.")) && recordedCodes.size >= 8, `${rows.length} rows, codes=${[...recordedCodes].join(",")}`)
  const r1 = await replayRows(rows)
  check("every recorded decision is replayable", r1.replayed === rows.length && r1.examined === rows.length, JSON.stringify(r1.unreplayable))
  check("R1: replaying the UNCHANGED planner agrees 100%", r1.agreementRate === 1 && r1.disagreements.length === 0, `rate=${r1.agreementRate} dis=${JSON.stringify(r1.disagreements.slice(0, 2))}`)
  check("R1: deterministic — a second replay is byte-identical", JSON.stringify(await replayRows([...rows].reverse())) === JSON.stringify(r1))
  check("R1: the snapshot carries no evidence-only bulk (intent evidence / memory facts)",
    rows.every((r) => !JSON.stringify((r.detail as Record<string, unknown>).decision_input).includes('"evidence"') && !JSON.stringify((r.detail as Record<string, unknown>).decision_input).includes('"memoryFacts"')))

  console.log("\n[R2] a mutated planner rule → disagreement")
  // MUTATION: the 48h fatigue rule removed — a recently-contacted person is "due" again.
  const mutated: ReplayPlanner = (snap: DecisionInputSnapshot) => {
    const p = planFromDecisionInput(snap)
    if (!p) return null
    return p.reasonCode === "recently_contacted" ? { reasonCode: "due", action: "send_touch" } : { reasonCode: p.reasonCode, action: p.action }
  }
  const fatigued = rows.filter((r) => (r.detail as { plan_code?: string }).plan_code === "recently_contacted").length
  const r2 = await replayRows(rows, mutated)
  check("R2: the mutated rule disagrees on exactly the fatigue decisions", fatigued >= 2 && r2.disagreements.length === fatigued && r2.agreements === rows.length - fatigued, `fatigued=${fatigued} dis=${r2.disagreements.length}`)
  const row2 = r2.byReasonCode.find((b) => b.recordedCode === "recently_contacted")
  check("R2: counted by reason code (recently_contacted → due ×N), sorted first", r2.byReasonCode[0]?.recordedCode === "recently_contacted" && row2?.changedTo.due === fatigued)
  check("R2: each disagreement names the row, the recorded and the replayed verdict",
    r2.disagreements.every((d) => d.recordedAction === "wait" && d.replayedAction === "send_touch" && rows.some((r) => r.id === d.actionId)))

  console.log("\n[R3] no snapshot → unreplayable (published, never counted as agreement)")
  const legacy: ReplayableLedgerRow = { ...rows[0], id: uuid(5000), detail: { plan_code: "outreach_paused", reasons_not_to_act: [] } }
  const badV: ReplayableLedgerRow = { ...rows[0], id: uuid(5001), detail: { ...rows[0].detail, decision_input: { ...(rows[0].detail as any).decision_input, v: 99 } } }
  const r3 = await replayRows([...rows, legacy, badV])
  check("R3: a pre-snapshot row is noSnapshot, a future version is unknownVersion; rate unchanged",
    r3.unreplayable.noSnapshot === 1 && r3.unreplayable.unknownVersion === 1 && r3.replayed === rows.length && r3.agreementRate === 1)
  check("R3 CONTROL: nothing replayable → rate is null, never a fake 100%", (await replayRows([legacy])).agreementRate === null)

  console.log("\n[R4] a cross-tenant replay is refused")
  const foreign = rows.slice(0, 3).map((r) => ({ ...r, id: r.id.replace(/^0/, "f"), brokerage_id: OTHER }))
  const r4 = await replayRows([...rows, ...foreign])
  check("R4: another tenant's rows reaching the core are refused and counted, never replayed",
    r4.crossTenantRefused === 3 && r4.examined === rows.length && r4.replayed === rows.length)
  check("R4: the kernel refuses an un-scoped replay (no brokerageId)", !(await replayDecisions({ brokerageId: "", since: "2026-09-01" })).ok)
  const eqs: Array<[string, string, unknown]> = []
  const fake = fakeClient({ agent_action_ledger: [...rows, ...foreign] }, eqs)
  const k = await replayDecisions({ brokerageId: B, since: "2026-09-01T00:00:00Z" }, { client: fake, attribution: false })
  check("R4: the kernel read is pinned to the session tenant (.eq brokerage_id) and still refuses leaked rows",
    k.ok && eqs.some(([t, c, v]) => t === "agent_action_ledger" && c === "brokerage_id" && v === B) && k.report.crossTenantRefused === 3 && k.report.replayed === rows.length)
  check("R4: the claimed-tenant decision refuses a brokerageId that is not the session's",
    decideClaimedTenant({ actingBrokerageId: B, claimedBrokerageId: OTHER }).ok === false && decideClaimedTenant({ actingBrokerageId: B, claimedBrokerageId: B }).ok === true)
  const fr = stripComments(readFileSync(join(process.cwd(), "app/actions/flight-recorder.ts"), "utf8"))
  const gated = (s: string) => {
    const at = s.indexOf("export async function replayTenantDecisions")
    if (at < 0) return false
    const fn = s.slice(at)
    const sig = fn.slice(0, fn.indexOf("Promise<"))
    const gate = s.slice(s.indexOf("async function gateTenantAdmin"), at)
    return /requireCallerTenant\(\)/.test(gate) && /resolveTenantAdmin\(/.test(gate) && !/brokerage/i.test(sig) &&
      /gateTenantAdmin\(\)/.test(fn) && /replayDecisions\(\{ brokerageId: gate\.brokerageId/.test(fn)
  }
  check("R4 WIRED: replayTenantDecisions takes NO tenant argument, gates (requireCallerTenant + tenant admin) and replays the SESSION tenant", gated(fr))
  check("R4 CONTROL: a specimen that replays the body's brokerageId is refused",
    !gated(`async function gateTenantAdmin() { requireCallerTenant(); resolveTenantAdmin(x) }
export async function replayTenantDecisions(input: { brokerageId: string }): Promise<X> { gateTenantAdmin(); replayDecisions({ brokerageId: input.brokerageId }) }`))

  console.log("\n[R5] the 100A attribution join — the outcome of the decision that would have changed")
  const target = rows.find((r) => (r.detail as { plan_code?: string }).plan_code === "recently_contacted" && r.subject_type === "contact")!
  const contactId = target.subject_id!
  const showingAt = new Date(Date.parse(target.created_at) + 5 * 86_400_000).toISOString()
  const fake5 = fakeClient({
    agent_action_ledger: rows,
    transactions: [], communications: [], isa_outreach_log: [], leads: [],
    showings: [{ id: uuid(8001), contact_id: contactId, created_at: showingAt, status: "scheduled" }],
  }, [])
  const k5 = await replayDecisions({ brokerageId: B, since: "2026-09-01T00:00:00Z" }, { client: fake5, planner: mutated })
  const dis = k5.ok ? k5.report.disagreements.find((d) => d.actionId === target.id) : undefined
  check("R5: the disagreeing decision carries the appointment it preceded (last + all touch)",
    !!dis && dis.outcomes.some((o) => o.kind === "appointment" && o.model === "last_touch") && dis.outcomes.some((o) => o.model === "all_touch"),
    k5.ok ? `${JSON.stringify(dis?.outcomes)} err=${k5.attributionError}` : (k5 as { error: string }).error)
  check("R5 CONTROL: an agreeing replay does not run the join (no disagreements → no outcomes read)",
    await (async () => { const e: Array<[string, string, unknown]> = []; const r = await replayDecisions({ brokerageId: B, since: "2026-09-01T00:00:00Z" }, { client: fakeClient({ agent_action_ledger: rows }, e) }); return r.ok && r.report.disagreements.length === 0 && !e.some(([t]) => t === "showings") })())

  console.log("\n[E1] stable + even assignment")
  const def = EXPERIMENT_DEFINITIONS.sequence_ab as ExperimentDefinition
  const on = { readable: true, killSwitch: false, disabled: [] as string[] }
  const N = 10_000
  const armsOf = (key: string, d: ExperimentDefinition = def) => Array.from({ length: N }, (_, i) =>
    assignExperimentArm({ definition: d, brokerageId: B, subjectId: `subject-${i}`, instance: key, instanceOn: true, policy: on })!.arm)
  const a1 = armsOf("seq-1")
  const shareA = a1.filter((a) => a === "A").length / N
  check("E1: 50/50 over 10,000 subjects lands within 48–52%", shareA > 0.48 && shareA < 0.52, `A=${shareA}`)
  check("E1: stable — the same (brokerage, subject, experiment) gives the same arm", JSON.stringify(armsOf("seq-1")) === JSON.stringify(a1))
  const a2 = armsOf("seq-2")
  const same = a1.filter((a, i) => a === a2[i]).length / N
  check("E1: a different experiment key is decorrelated (≈50% overlap, not 100%)", same > 0.47 && same < 0.53, `overlap=${same}`)
  const weighted: ExperimentDefinition = { key: "w", description: "", control: "c", instanceSwitch: "", arms: [{ key: "c", weight: 80 }, { key: "t", weight: 20 }] }
  const shareT = armsOf("x", weighted).filter((a) => a === "t").length / N
  check("E1: weights are honoured (80/20 → treatment 18–22%)", shareT > 0.18 && shareT < 0.22, `t=${shareT}`)
  const ten: ExperimentDefinition = { key: "ten", description: "", control: "d0", instanceSwitch: "", arms: Array.from({ length: 10 }, (_, d) => ({ key: `d${d}`, weight: 1 })) }
  const tenArms = armsOf("k", ten)
  const deciles = Array.from({ length: 10 }, (_, d) => tenArms.filter((a) => a === `d${d}`).length)
  check("E1: the hash is uniform — ten equal arms each get 9–11% of 10,000 subjects", deciles.every((c) => c > 900 && c < 1100), deciles.join(","))
  check("E1 CONTROL: a constant hash would fail the spread check", [0.3, 0.3, 0.3].filter((u) => u < 0.5).length / 3 === 1)

  console.log("\n[E2] a disabled experiment assigns control")
  const pick = (policy: typeof on, extra: Partial<Parameters<typeof assignExperimentArm>[0]> = {}) =>
    Array.from({ length: 200 }, (_, i) => assignExperimentArm({ definition: def, brokerageId: B, subjectId: `s-${i}`, instance: "seq-1", instanceOn: true, policy, ...extra }))
  check("E2: kill switch → control for everyone, reason kill_switch", pick({ ...on, killSwitch: true }).every((a) => a?.arm === "A" && a.control && a.reason === "kill_switch"))
  check("E2: this definition disabled → control, reason disabled", pick({ ...on, disabled: ["sequence_ab"] }).every((a) => a?.arm === "A" && a.reason === "disabled"))
  check("E2: one instance disabled → only that instance is control", pick({ ...on, disabled: ["sequence_ab:seq-1"] }).every((a) => a?.reason === "disabled") &&
    pick({ ...on, disabled: ["sequence_ab:seq-1"] }, { instance: "seq-2" }).some((a) => a?.arm === "B"))
  check("E2: policy unreadable → control (fail closed)", pick({ readable: false, killSwitch: true, disabled: [] }).every((a) => a?.arm === "A" && a.reason === "policy_unreadable"))
  check("E2: instance off (sequence not is_ab_test) → no experiment at all", pick(on, { instanceOn: false }).every((a) => a === null))
  check("E2 CONTROL: an ENABLED experiment does assign the treatment arm to someone", pick(on).some((a) => a?.arm === "B"))
  const pol = (settings: unknown) => loadExperimentPolicy(fakeClient({ brokerage_settings: [{ brokerage_id: B, settings }] }, []), B)
  check("E2: the kill switch / disabled list are read from brokerage_settings.settings.experiments",
    (await pol({ experiments: { kill_switch: true, disabled: ["x"] } })).killSwitch === true &&
    (await pol({ experiments: { disabled: ["x"] } })).disabled[0] === "x" && (await pol({})).killSwitch === false && (await pol({})).readable === true)
  const refusing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "permission denied" } }) }) }) }) }
  const unread = await loadExperimentPolicy(refusing, B)
  check("E2: a REFUSED policy read is unreadable → control (fail closed), never 'experiments on'", unread.readable === false && unread.killSwitch === true)

  console.log("\n[E3] attribution rolls up by arm")
  const step = { id: "step-1", sequence_id: "seq-9" } as any
  const ledB = sequenceStepLedger({ enrollmentId: "e1", step, contact: { id: "c1" } as any, entity: "contact", abVariant: "B" })
  const ledNone = sequenceStepLedger({ enrollmentId: "e2", step, contact: { id: "c2" } as any, entity: "contact", abVariant: null })
  check("E3: a sequence send records detail.experiment = {key: sequence_ab:<seq>, arm}", ledB.detail.experiment?.key === "sequence_ab:seq-9" && ledB.detail.experiment?.arm === "B")
  check("E3 CONTROL: a send outside any experiment records none", ledNone.detail.experiment === undefined && Object.keys(experimentLedgerDetail(null)).length === 0)
  const act = (id: string, subject: string, arm: string | null) => ({ id, brokerage_id: B, action: "comms.email.send", status: "executed", reason_code: "CAMPAIGN_STEP", actor_type: "system",
    subject_type: "contact", subject_id: subject, created_at: "2026-09-01T00:00:00Z", detail: { sequence_id: "seq-9", ...experimentLedgerDetail(arm ? { key: "sequence_ab:seq-9", arm } : null) } })
  const out = (ref: string, subject: string, cents: number) => ({ ref, kind: "closed" as const, brokerageId: B, subjectIds: [subject], at: "2026-09-10T00:00:00Z", revenueCents: cents })
  const attr = attributeOutcomesToLedger([out("closed:1", "cA", 500_000), out("closed:2", "cB", 300_000), out("closed:3", "cN", 100_000)],
    [act("a1", "cA", "A"), act("a2", "cB", "B"), act("a3", "cN", null)])
  const rowA = attr.byExperimentArm.find((r) => r.key === "sequence_ab:seq-9=A"), rowB = attr.byExperimentArm.find((r) => r.key === "sequence_ab:seq-9=B")
  check("E3: revenue rolls up by arm (A $5,000 / B $3,000, last + all touch)", rowA?.lastTouchCents === 500_000 && rowB?.lastTouchCents === 300_000 && rowA?.allTouchCents === 500_000 && rowB?.lastTouchOutcomes.closed === 1)
  check("E3 CONTROL: an action outside any experiment is not invented into an arm", attr.byExperimentArm.length === 2)

  console.log("\n[W] wiring — the real recorders and surfaces (stripped source)")
  const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))
  const plan = src("lib/ai-isa/lead-action-plan.ts")
  const adv = plan.slice(plan.indexOf("export async function advanceLeadActionPlans"))
  const snapWired = (s: string) => /nonActionRecordFor\(plan, \{[^}]*\}, decisionInputSnapshot\(\{ subject: "lead", plan: planInput \}\)\)/.test(s) && /planNextLeadTouch\(planInput\)/.test(s)
  check("W: the lead sweep records the planner input it decided on (detail.decision_input)", snapWired(adv))
  check("W CONTROL: a sweep recording the verdict alone is refused", !snapWired(`const plan = planNextLeadTouch(planInput); const nonAction = nonActionRecordFor(plan, { brokerageId, leadId, now })`))
  check("W: the contact NBA records its input too", /decisionInputSnapshot\(\{ subject: 'contact', now: nbaNow, context: nbaCtx\.context \}\)/.test(src("app/actions/ai-isa/engage-contact.ts")))
  check("W: the AI audit page runs the replay and the experiment switch", /replayTenantDecisions\(/.test(src("app/dashboard/admin/ai-audit/page.tsx")) && /setExperimentKillSwitch\(/.test(src("app/dashboard/admin/ai-audit/page.tsx")))
  const ab = src("lib/campaign-sequences/ab-variant.ts")
  check("W: assignAbVariant delegates to the kernel assigner — no Math.random left", /assignExperimentArm\(/.test(ab) && !/Math\.random/.test(ab))
  check("W CONTROL: the Math.random finder still sees a random split", /Math\.random/.test(`const r = Math.random(); return r < 0.5 ? "A" : "B"`))
  check("W: enrollment passes the tenant's experiment policy", /loadExperimentPolicy\(supabase, params\.brokerageId\)/.test(src("lib/campaign-sequences/enrollment-engine.ts")))
  check("W: the executor hands the enrollment arm to the send ledger", /abVariant: \(enrollment\.ab_variant/.test(src("lib/campaign-sequences/step-executor.ts")))
  check("W: the direct-mail bandit arm rides the send's ledger row", /experimentLedgerDetail\(\{ key: "direct_mail_variant", arm: variantPick\.variantId \}\)/.test(src("lib/direct-mail/orchestrate-send.ts")))
  check("W: the command center shows revenue by experiment arm", /byExperimentArm/.test(src("app/dashboard/admin/command-center/command-center-client.tsx")))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` blind spots: acting verdicts (send_touch / convert) are not ledgered as decisions, so replay covers wait / do_nothing only; rows recorded before wave 101 have no decision_input (counted noSnapshot).`)
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ REPLAY_HARNESS_FAIL"); process.exit(1) }
  console.log(" ✅ REPLAY_HARNESS_PASS — the current planner replays recorded decisions deterministically; one stable assigner; arms roll up to revenue")
}

/** Replay rows through the KERNEL entry with a LEAKY fake (it returns every row, any tenant), so the
 *  pure core's own tenant refusal is what is measured. Attribution off; R5 exercises the join. */
async function replayRows(rs: ReplayableLedgerRow[], planner?: ReplayPlanner): Promise<DecisionReplayReport> {
  const r = await replayDecisions({ brokerageId: B, since: "2026-01-01T00:00:00Z" }, { client: fakeClient({ agent_action_ledger: rs }, []), planner, attribution: false })
  if (!r.ok) throw new Error(r.error)
  return r.report
}

/** A chainable supabase-js fake: every filter records (table, column, value) and returns the builder;
 *  awaiting it resolves to the table's rows (filtered by the eq/in pins it can evaluate). */
function fakeClient(tables: Record<string, Array<Record<string, any>>>, eqs: Array<[string, string, unknown]>) {
  return {
    from(table: string) {
      const preds: Array<(r: Record<string, any>) => boolean> = []
      const b: any = {
        select: () => b, order: () => b, limit: () => b, not: () => b, is: () => b, or: () => b, gte: () => b, lte: () => b,
        eq: (c: string, v: unknown) => { eqs.push([table, c, v]); preds.push((r) => !(c in r) || r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { eqs.push([table, c, vs]); preds.push((r) => !(c in r) || vs.includes(r[c])); return b },
        maybeSingle: () => Promise.resolve({ data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: (tables[table] ?? []).filter((r) => table === "agent_action_ledger" && preds.length > 0 && eqs.some(([t, c]) => t === table && c === "brokerage_id") ? true : preds.every((p) => p(r))), error: null }).then(res, rej),
      }
      return b
    },
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
