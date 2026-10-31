/**
 * scripts/completion-tracking-guard.ts — test:completion-tracking (wave 147, lane 147G; run with --conditions=react-server).
 *
 * OWNER RULINGS 13 + 14 (2026-10-31): "the managers need to make sure that arbiter completes not relying on crons to do so";
 * "self healing should handle the os not just the connections". CONTRACT C14: every arbiter / manager decision opens a
 * completion (what, owner manager, due, evidence expected) closed by evidence (delivery outcome, provider ack, human action);
 * stalls are detected by the manager supervision loop driven by events + durable retry; cron only reconciles what events
 * missed and says so in the ledger (recovered_by: "cron").
 *
 *   A · vocabulary = m904's CHECKs (derived)              B · the detection catalogue — owners re-derived from the registry
 *   C · event-driven open / evidence / close              D · stall → the self-healing engine → recovered (event / timer)
 *   E · stall → a person, the Exception Center, closed by the person's evidence      F · the hard stop (never re-run blind)
 *   G · cron is recovery only, and stamped                H · the OS-health detector (orphaned completion, dead loop)
 *   I · support tickets (read only)                       J · the boundary + the durable timer + the page graph (stripped)
 *
 * In-memory database, no network. Every refusal has a POSITIVE CONTROL (CLAUDE.md §2). Blind spots printed at the end.
 */
import { readFileSync } from "node:fs"
import { memSupabase, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))

const B1 = "11111111-1111-4111-8111-111111111111"
const B2 = "22222222-2222-4222-8222-222222222222"
const C1 = "c1c1c1c1-0000-4000-8000-000000000001"
const U1 = "a2a2a2a2-0000-4000-8000-000000000002"
const T1 = "71717171-0000-4000-8000-000000000001"
const NOW = new Date()
/** The subject the self-healing engine writes for a completion incident (lib/kernel/self-healing.ts engineTools: os_health:<detector>:<subjectKey>). */
const incSubject = (id: string) => `os_health:stalled_completions:completion:${id}`
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()
const ahead = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString()

function world(extra: Record<string, Row[]> = {}) {
  return memSupabase({
    brokerages: [{ id: B1, ai_isa_system_user_id: null }], manager_completions: [], agent_action_ledger: [], self_heal_events: [], notifications: [],
    outcome_reconciliations: [], ai_message_drafts: [], messages: [], support_tickets: [], brokerage_settings: [], platform_settings: [], connector_healing_proposals: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { manager_completions: [["idempotency_key"]], agent_action_ledger: [["idempotency_key"]] } })
}

async function main() {
  const ct = await import("../lib/kernel/completion-tracking")
  const reg = await import("../lib/kernel/manager-registry")
  const sh = await import("../lib/kernel/self-healing")
  const osh = await import("../lib/kernel/os-health")
  const { composeExceptionCenter } = await import("../lib/kernel/exception-center")

  const engine = { emit: async () => ({ error: null }), propose: async () => ({ id: "proposal-1", error: null }) }
  const scheduled: Array<{ completionId: string; checkAt: string }> = []
  const schedule = async (c: { completionId: string; checkAt: string }) => { scheduled.push(c); return { scheduled: true } }
  const open = (db: ReturnType<typeof world>, over: Partial<Parameters<typeof ct.openCompletion>[1]> = {}) => ct.openCompletion(db as never, {
    brokerageId: B1, kind: "inbound_response", ownerManager: "ai_isa", subject: { type: "contact", id: C1 }, sourceRef: "inbound:m-1",
    what: "Answer the sms that arrived", stage: "awaiting_decision", expectedEvidence: ["decision"], dueAt: ahead(15),
    context: { record_id: "m-1", channel: "sms", conversation_id: "conv-1", agent_user_id: U1 }, ...over,
  }, { schedule })
  const exceptionsOpen = (db: ReturnType<typeof world>) => composeExceptionCenter(db.tables.self_heal_events.map((r) => ({ id: r.id, subject: r.subject, action: r.action ?? null, outcome: r.outcome, detail: r.detail ?? null, createdAt: r.created_at ?? new Date().toISOString() }))).open

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("A · the vocabulary is m904's CHECKs, read from the migration (derived, never restated)")
  {
    const sql = raw("supabase/migrations/m904-manager-completions.sql")
    const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    const inList = (constraint: string) => [...(new RegExp(`${constraint}\\s*CHECK\\s*\\(([^;]*?)\\)\\s*,?\\n`, "s").exec(body)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    const same = (a: readonly string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify(b)
    check("line 1 is the lane stamp or the integrator's APPLIED stamp (the rule, not a waypoint)", /^-- (WRITTEN, NOT APPLIED \(wave 147, lane 147G\)|── APPLIED LIVE )/.test(sql))
    check("kinds / stages / statuses / detections / recovery sources in code == the CHECKs m904 writes",
      same(ct.COMPLETION_KINDS, inList("manager_completions_kind_check")) && same(ct.COMPLETION_STAGES, inList("manager_completions_stage_check")) && same(ct.COMPLETION_STATUSES, inList("manager_completions_status_check"))
        && same(ct.COMPLETION_DETECTION_KEYS, inList("manager_completions_detection_check")) && same(ct.RECOVERY_SOURCES, inList("manager_completions_recovered_by_check")),
      JSON.stringify({ kinds: inList("manager_completions_kind_check"), det: inList("manager_completions_detection_check") }))
    const managers = Object.keys(reg.MANAGERS).sort()
    check(`the owner CHECK and COMPLETION_OWNERS are exactly the registered managers (${managers.length}, derived from MANAGERS)`, same(ct.COMPLETION_OWNERS, managers) && same(ct.COMPLETION_OWNERS, inList("manager_completions_owner_manager_check")))
    check("tenant-scoped, RLS on, writes revoked from the session roles, unique idempotency key", /brokerage_id\s+uuid NOT NULL REFERENCES public\.brokerages\(id\) ON DELETE CASCADE/.test(body) && /ENABLE ROW LEVEL SECURITY/.test(body) && /REVOKE INSERT, UPDATE, DELETE ON public\.manager_completions FROM anon, authenticated/.test(body) && /UNIQUE \(idempotency_key\)/.test(body))
    check("POSITIVE CONTROL: the CHECK reader fails on an absent constraint", inList("manager_completions_no_such_check").length === 0)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("B · the detection catalogue (ruling 13) — each with its owning manager from the registry and a safe remediation")
  {
    const want = ["stalled_decision", "missing_provider_ack", "broken_integration", "unresolved_ticket", "failed_delivery", "incomplete_follow_up"]
    check("all six detections the ruling names are catalogued", JSON.stringify([...ct.COMPLETION_DETECTION_KEYS].sort()) === JSON.stringify([...want].sort()))
    const derive = (o: { registry: string; key: string }) => o.registry === "MAINTENANCE_DOMAINS" ? (reg.MAINTENANCE_DOMAINS as Record<string, { manager: string }>)[o.key]?.manager : (reg.TABLE_MANAGER as Record<string, string>)[o.key]
    const problems = (cat: Record<string, { owner: string; ownerFrom: { registry: string; key: string } }>) => Object.entries(cat).filter(([, d]) => derive(d.ownerFrom) !== d.owner).map(([k, d]) => `${k}: ${d.owner} ≠ ${d.ownerFrom.registry}[${d.ownerFrom.key}] (${derive(d.ownerFrom) ?? "none"})`)
    check("every owner is DERIVED: it equals the registry entry it names (MAINTENANCE_DOMAINS / TABLE_MANAGER)", problems(ct.COMPLETION_DETECTIONS as never).length === 0, problems(ct.COMPLETION_DETECTIONS as never).join("; "))
    check("POSITIVE CONTROL: a mis-owned fixture is caught", problems({ ...(ct.COMPLETION_DETECTIONS as never as Record<string, never>), failed_delivery: { owner: "finance_manager", ownerFrom: { registry: "MAINTENANCE_DOMAINS", key: "inbound_communication" } } } as never).length === 1)
    const declared = new Set(sh.DOMAIN_PLAYBOOKS.completions as readonly string[])
    check("every remediation is a playbook the self-healing engine DECLARES for the completions domain", Object.values(ct.COMPLETION_DETECTIONS).every((d) => declared.has(d.playbook)))
    const FORBIDDEN = /\b(refund|charge|payment|payout|invoice|permission|grant access|role change|deploy|commit|migrat\w*|edit (the )?code)\b/i
    check("no remediation's authority names money, a permission, a deploy or a code edit; every one states its human boundary", Object.values(ct.COMPLETION_DETECTIONS).every((d) => !FORBIDDEN.test(d.withinAuthority) && d.humanBoundary.length > 20))
    check("POSITIVE CONTROL: the forbidden-authority finder fires on a specimen", FORBIDDEN.test("issue a refund and change the role"))
    check("the engine's completions domain never re-sends: no send / requeue / failover playbook is declared there", !["requeue", "failover", "re_enqueue_webhook", "re_render"].some((k) => declared.has(k)) && declared.has("redrive_completion") && declared.has("close_on_evidence"))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("C · event-driven: the event opens it, evidence moves / closes it, the durable timer is armed at each due")
  {
    const db = world()
    scheduled.length = 0
    const o1 = await open(db)
    const o2 = await open(db)
    check("opened ONCE per (tenant, kind, source) — a second caller gets the same completion", o1.ok && o2.ok && o2.duplicate === true && o1.ok && o2.ok && o1.completion.id === o2.completion.id && db.tables.manager_completions.length === 1)
    check("the durable timer is armed at the due time when it opens", scheduled.length === 1 && o1.ok && scheduled[0].checkAt === o1.completion.due_at)
    const bad = await ct.openCompletion(db as never, { brokerageId: B1, kind: "inbound_response", ownerManager: "nobody" as never, subject: { type: "contact" }, sourceRef: "x", what: "x", stage: "awaiting_decision", expectedEvidence: ["decision"], dueAt: ahead(5) }, { schedule })
    const untenanted = await ct.openCompletion(db as never, { brokerageId: "", kind: "inbound_response", ownerManager: "ai_isa", subject: { type: "contact" }, sourceRef: "y", what: "y", stage: "awaiting_decision", expectedEvidence: ["decision"], dueAt: ahead(5) }, { schedule })
    check("an owner that is not a registered manager, or no tenant, is refused (fail closed)", !bad.ok && /registered manager/.test(bad.ok ? "" : bad.reason) && !untenanted.ok)
    const id = o1.ok ? o1.completion.id : ""
    const e1 = await ct.recordCompletionEvidence(db as never, { brokerageId: B1, completionId: id, evidence: { kind: "decision", at: NOW.toISOString(), source: "agent_action_ledger", ref: "k", outcome: "reply_sent" }, advanceTo: { stage: "awaiting_delivery", expected: ["delivery_outcome"], dueAt: ahead(360), providerRef: "SM-1" } }, { schedule })
    check("the decision is evidence: the completion ADVANCES to its next waiting stage and the timer is re-armed (no clock decided anything)", e1.ok && e1.closed === false && e1.ok && e1.completion.stage === "awaiting_delivery" && e1.completion.provider_ref === "SM-1" && scheduled.length === 2)
    const e2 = await ct.recordCompletionEvidence(db as never, { brokerageId: B1, providerRef: "SM-1", evidence: { kind: "delivery_outcome", at: NOW.toISOString(), source: "outcome_reconciliations", outcome: "delivered" } }, { schedule })
    const row = db.tables.manager_completions[0]
    check("the delivery outcome (found by the provider's reference) CLOSES it; the evidence trail holds both", e2.ok && e2.closed === true && row.status === "closed" && row.closed_by === "delivery_outcome" && row.evidence.length === 2 && !!row.closed_at)
    const e3 = await ct.recordCompletionEvidence(db as never, { brokerageId: B1, completionId: id, evidence: { kind: "human_action", at: NOW.toISOString(), source: "x" } }, { schedule })
    check("evidence on a CLOSED completion changes nothing (idempotent)", e3.ok && e3.duplicate === true && db.tables.manager_completions[0].evidence.length === 2)
    const foreign = await ct.recordCompletionEvidence(db as never, { brokerageId: B2, completionId: id, evidence: { kind: "human_action", at: NOW.toISOString(), source: "x" } }, { schedule })
    check("TENANCY: another tenant cannot touch it (reads not found)", !foreign.ok)
    const supNone = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "event" })
    check("POSITIVE CONTROL: supervising a closed completion is a no-op", supNone.verdict === "closed")
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("D · a STALL → the self-healing engine (domain completions) → recovered — on the EVENT / the TIMER, not the cron")
  {
    const db = world({ messages: [{ id: "m-1", brokerage_id: B1, direction: "inbound", conversation_id: "conv-1", contact_id: C1, body: "hi", metadata: { channel: "sms", provider: "twilio" } }] })
    const o = await open(db, { dueAt: ago(5) })
    const id = o.ok ? o.completion.id : ""
    const inside = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: (await open(db, { sourceRef: "inbound:m-2", dueAt: ahead(30), context: { record_id: "m-2", channel: "sms" } })).ok ? db.tables.manager_completions[1].id : "", trigger: "workflow" }, { schedule })
    check("inside its window, no evidence yet → WAITING (the timer looks again at due) — nothing remediated early", inside.verdict === "waiting" && !!inside.nextCheckAt)
    const redriven: string[] = []
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "workflow" }, {
      schedule, engine,
      redrivers: { inbound_response: async (svc, c, trigger) => {
        redriven.push(`${c.id}:${trigger}`)
        await (svc as ReturnType<typeof world>).from("agent_action_ledger").insert({ brokerage_id: B1, action: "inbound.message.respond", status: "skipped", outcome: "reply_proposed", idempotency_key: "inbound-key", detail: { record_id: "m-1" } })
        const r = await ct.recordCompletionEvidence(svc, { brokerageId: B1, completionId: c.id, evidence: { kind: "decision", at: new Date().toISOString(), source: "agent_action_ledger", outcome: "reply_proposed", recoveredBy: trigger === "event" ? null : trigger }, advanceTo: { stage: "awaiting_human", expected: ["human_action"], dueAt: ahead(240) } }, { schedule })
        return { action: r.ok ? "reply_proposed" : "refused", reason: "re-run" }
      } },
    })
    const row = db.tables.manager_completions.find((r) => r.id === id)!
    check("past due with NO decision → stalled_decision → redrive_completion through the engine → the decision is made (recovered on the TIMER's trigger)",
      sup.verdict === "remediated" && sup.detection === "stalled_decision" && redriven.length === 1 && redriven[0].endsWith(":workflow") && row.stage === "awaiting_human" && row.recovered_by === "workflow", JSON.stringify({ v: sup.verdict, r: sup.reason }))
    const remed = db.tables.agent_action_ledger.filter((r) => r.action === "completion.stall.remediate")
    check("LEDGERED and COSTED: completion.stall.remediate (actor = the owner manager, recovered_by = the trigger, cost_usd booked)", remed.length === 1 && remed[0].actor_manager_key === "ai_isa" && remed[0].detail?.recovered_by === "workflow" && remed[0].detail?.playbook === "redrive_completion" && remed[0].cost_usd !== undefined && remed[0].status === "executed")
    check("the engine's own evidence: os_health.stalled_completions.playbook_redrive_completion ledgered + a 'healed' Exception-Center row (nothing left open)",
      db.tables.agent_action_ledger.some((r) => r.action === "os_health.stalled_completions.playbook_redrive_completion" && r.status === "executed") && db.tables.self_heal_events.some((e) => e.outcome === "healed" && e.subject === incSubject(id)) && exceptionsOpen(db).length === 0)
    const supAgain = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "workflow" }, { schedule, engine })
    check("POSITIVE CONTROL: the recovered completion now waits for the person (not re-driven again)", supAgain.verdict === "waiting" && redriven.length === 1)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("E · a STALL that needs a PERSON → told in one sentence, an exception (exceptions-first os_health) → closed by their evidence")
  {
    const db = world()
    const o = await open(db, { stage: "awaiting_human", expectedEvidence: ["human_action"], dueAt: ago(30) })
    const id = o.ok ? o.completion.id : ""
    const told: string[] = []
    const notify = async (_s: unknown, _c: unknown, sentence: string) => { told.push(sentence); return { notified: 1 } }
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "event" }, { schedule, engine, notify })
    check("nobody acted by due → incomplete_follow_up → the person is told once, in ONE neighbourly sentence (what, how late, what to do)",
      sup.verdict === "escalated" && sup.detection === "incomplete_follow_up" && told.length === 1 && /^Heads up — "Answer the sms that arrived" is \d+ minutes past due/.test(told[0]) && /still waiting for someone to pick it up/.test(told[0]), told[0])
    const openEx = exceptionsOpen(db)
    check("the stall is an OPEN exception the Exception Center (and exceptions-first's os_health category) reads", openEx.length === 1 && openEx[0].subject === incSubject(id) && db.tables.manager_completions[0].status === "escalated")
    db.tables.ai_message_drafts.push({ id: "d-1", brokerage_id: B1, source_message_id: "m-1", status: "edited", acted_at: NOW.toISOString() })
    const later = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "event" }, { schedule, engine, notify })
    check("the person acting is the EVIDENCE: the completion closes and the exception closes with it (append-only closer)", later.verdict === "closed" && db.tables.manager_completions[0].closed_by === "human_action" && exceptionsOpen(db).length === 0 && db.tables.self_heal_events.some((e) => e.outcome === "resolved"))
    check("POSITIVE CONTROL: without the evidence it would have stayed open (the exception finder is not blind)", openEx.length === 1)
    // the other human surfaces: a proposal card acted on (a public comment's reply) and the agent's task done
    const dbP = world({ smart_assistant_suggestions: [{ id: "s-1", brokerage_id: B1, status: "accepted", action_payload_json: { kind: "inbound_reply_proposal", message_id: "m-p" } }], activities: [] })
    const oP = await open(dbP, { sourceRef: "inbound:m-p", stage: "awaiting_human", expectedEvidence: ["human_action"], dueAt: ago(10), context: { record_id: "m-p", channel: "social_comment", contact_id: C1 } })
    const sP = await ct.superviseCompletion(dbP as never, { brokerageId: B1, completionId: oP.ok ? oP.completion.id : "", trigger: "event" }, { schedule, engine })
    const dbA = world({ activities: [{ id: "act-1", brokerage_id: B1, contact_id: C1, activity_type: "followup_moment_due", status: "completed", completed_at: NOW.toISOString(), created_at: NOW.toISOString() }] })
    const oA = await open(dbA, { sourceRef: "inbound:m-a", stage: "awaiting_human", expectedEvidence: ["human_action"], dueAt: ago(10), context: { record_id: "m-a", channel: "sms", contact_id: C1 } })
    dbA.tables.manager_completions[0].created_at = ago(60)
    const sA = await ct.superviseCompletion(dbA as never, { brokerageId: B1, completionId: oA.ok ? oA.completion.id : "", trigger: "event" }, { schedule, engine })
    check("a proposal card acted on (smart_assistant_suggestions) and the agent's task completed (activities) are each a person's evidence", sP.verdict === "closed" && dbP.tables.manager_completions[0].evidence.some((e: Row) => e.source === "smart_assistant_suggestions") && sA.verdict === "closed" && dbA.tables.manager_completions[0].evidence.some((e: Row) => e.source === "activities"), JSON.stringify([sP.reason, sA.reason]))
    const dbH = world()
    const oH = await open(dbH, { sourceRef: "inbound:m-h", stage: "awaiting_human", expectedEvidence: ["human_action"], dueAt: ago(180), context: { record_id: "m-h", channel: "sms" } })
    dbH.tables.manager_completions[0].attempts = 2
    const tH: string[] = []
    await ct.superviseCompletion(dbH as never, { brokerageId: B1, completionId: oH.ok ? oH.completion.id : "", trigger: "event" }, { schedule, engine, notify: async (_s, _c, x) => { tH.push(x); return { notified: 1 } } })
    check("the sentence carries the attempts already made and reads in hours when late enough", /3 hours past due/.test(tH[0] ?? "") && /we already tried 2 times/.test(tH[0] ?? ""), tH[0])
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("F · the HARD STOP — a decision still 'in flight' may already have sent: never re-run blind, a person decides")
  {
    // "stale" is derived from the module's own window (STALE_IN_FLIGHT_MINUTES), never pinned here
    const STALE = ct.STALE_IN_FLIGHT_MINUTES
    const db = world({ agent_action_ledger: [{ id: "L-1", brokerage_id: B1, action: "inbound.message.respond", status: "proposed", idempotency_key: "k-1", detail: { record_id: "m-1" }, created_at: ago(STALE + 5), updated_at: ago(STALE + 5) }] })
    const o = await open(db, { dueAt: ago(5) })
    const id = o.ok ? o.completion.id : ""
    const redriven: string[] = []
    const told: string[] = []
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "workflow" }, { schedule, engine, notify: async (_s, _c, x) => { told.push(x); return { notified: 1 } }, redrivers: { inbound_response: async () => { redriven.push("x"); return { action: "reply_sent", reason: "" } } } })
    check("a stale 'proposed' responder row → the redriver is NEVER called; the person is told; the completion is escalated", redriven.length === 0 && told.length === 1 && sup.verdict === "escalated" && db.tables.manager_completions[0].status === "escalated")
    db.tables.agent_action_ledger[0].updated_at = new Date().toISOString(); db.tables.agent_action_ledger[0].created_at = new Date().toISOString()
    const c2 = await open(db, { sourceRef: "inbound:m-1b", dueAt: ago(5) })
    const v = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: c2.ok ? c2.completion.id : "", trigger: "workflow" }, { schedule, engine })
    check("POSITIVE CONTROL: a FRESH in-flight row is 'in flight right now' — not a stall at all", v.verdict === "waiting" && /in flight right now/.test(v.reason), v.reason)

    // the supervisor's own bound — a dead loop ends with a person, never another attempt
    const dbL = world()
    const oL = await open(dbL, { sourceRef: "inbound:m-loop", dueAt: ago(5), context: { record_id: "m-loop", channel: "sms" } })
    dbL.tables.manager_completions[0].attempts = ct.SUPERVISION_ATTEMPT_CAP
    const rL: string[] = [], tL: string[] = []
    const sL = await ct.superviseCompletion(dbL as never, { brokerageId: B1, completionId: oL.ok ? oL.completion.id : "", trigger: "workflow" }, { schedule, engine, notify: async (_s, _c, x) => { tL.push(x); return { notified: 1 } }, redrivers: { inbound_response: async () => { rL.push("x"); return { action: "reply_sent", reason: "" } } } })
    check(`the supervision bound (SUPERVISION_ATTEMPT_CAP = ${ct.SUPERVISION_ATTEMPT_CAP}): past it, no redrive — a person is told and it is escalated (a dead loop never loops)`, rL.length === 0 && tL.length === 1 && sL.verdict === "escalated" && /we already tried/.test(tL[0]))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("G · the CRON is recovery only — it handles what events and the timer missed, and says so")
  {
    const db = world({ outcome_reconciliations: [{ id: "R-1", brokerage_id: B1, channel: "sms", provider_ref: "SM-9", verdict: "confirmed", provider_status: "delivered" }] })
    const missed = await open(db, { sourceRef: "inbound:m-9", stage: "awaiting_delivery", expectedEvidence: ["delivery_outcome"], dueAt: ago(60), providerRef: "SM-9", context: { record_id: "m-9", channel: "sms" } })
    const notDue = await open(db, { sourceRef: "inbound:m-10", stage: "awaiting_delivery", expectedEvidence: ["delivery_outcome"], dueAt: ahead(60), providerRef: "SM-10", context: { record_id: "m-10", channel: "sms" } })
    const rep = await ct.reconcileOpenCompletions(db as never, B1, { now: NOW }, { schedule, engine })
    const m = db.tables.manager_completions.find((r) => r.id === (missed.ok ? missed.completion.id : ""))!
    const n = db.tables.manager_completions.find((r) => r.id === (notDue.ok ? notDue.completion.id : ""))!
    check("the net closes ONLY what is past due (a delivered report the event missed) — stamped recovered_by 'cron' on the row", rep.scanned === 1 && rep.recovered === 1 && m.status === "closed" && m.recovered_by === "cron" && n.status === "open")
    const led = db.tables.agent_action_ledger.filter((r) => r.action === "completion.evidence.reconcile")
    check("…and in the LEDGER (completion.evidence.reconcile, detail.recovered_by = 'cron')", led.length === 1 && led[0].detail?.recovered_by === "cron" && led[0].status === "executed")
    check("POSITIVE CONTROL: the event path never stamps cron (C's close carries no recovered_by)", !db.tables.manager_completions.some((r) => r.recovered_by === "event"))
    const route = code("app/api/cron/manager-signals/route.ts")
    check("the net rides the EXISTING manager-signals tick (no new cron route) and runs before the health sweep", route.indexOf("reconcileOpenCompletions(") > 0 && route.indexOf("reconcileOpenCompletions(") < route.indexOf("runReaperNet(t.id, supabase, { lane: \"health\" })") && !/completion/.test(code("lib/kernel/cron-dispatch.ts")))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("H · self-healing of the OS — the os-health detector for an ORPHANED completion and a DEAD LOOP")
  {
    const db = world({ manager_completions: [
      { id: "11111111-aaaa-4aaa-8aaa-000000000001", brokerage_id: B1, kind: "inbound_response", owner_manager: "ai_isa", stage: "awaiting_decision", status: "open", due_at: ago(90), attempts: 0, last_attempt_at: null, what: "orphan" },
      { id: "11111111-aaaa-4aaa-8aaa-000000000002", brokerage_id: B1, kind: "follow_up", owner_manager: "ai_isa", stage: "awaiting_human", status: "stalled", due_at: ago(90), attempts: 3, last_attempt_at: ago(1), what: "loop" },
      { id: "11111111-aaaa-4aaa-8aaa-000000000003", brokerage_id: B1, kind: "inbound_response", owner_manager: "ai_isa", stage: "awaiting_decision", status: "open", due_at: ago(5), attempts: 0, last_attempt_at: null, what: "fresh" },
      { id: "11111111-aaaa-4aaa-8aaa-000000000004", brokerage_id: B1, kind: "inbound_response", owner_manager: "ai_isa", stage: "awaiting_decision", status: "stalled", due_at: ago(90), attempts: 1, last_attempt_at: ago(2), what: "being worked" },
    ] })
    const incs = await osh.DETECTORS.stalled_completions(db as never, B1, { now: NOW } as never)
    const keys = incs.map((i) => i.subjectKey).sort()
    check("orphaned (past due + grace, nobody attempted) and dead loop (at the cap, still stalled) are incidents; a fresh one and one being worked are not",
      keys.length === 2 && keys[0].endsWith("0001") && keys[1].endsWith("0002") && incs.some((i) => i.evidence.fault === "orphaned_completion") && incs.some((i) => i.evidence.fault === "dead_loop"), JSON.stringify(keys))
    check("each is transient + idempotent with its retry DELEGATED to the completion supervisor's rail (the supervisor never re-runs it itself)", incs.every((i) => i.class === "transient" && i.idempotent && /completion-tracking/.test(i.retryOwner ?? "")) && osh.decideRecovery(incs[0], { priorAttempts: 0 }).action === "retry")
    check("registered end to end: HEALTH_DETECTORS → DETECTOR_DOMAIN 'completions' → DETECTOR_OWNER (manager_completions / cron_manager)", (osh.HEALTH_DETECTORS as readonly string[]).includes("stalled_completions") && sh.DETECTOR_DOMAIN.stalled_completions === "completions" && sh.DETECTOR_OWNER.stalled_completions.table === "manager_completions")
    check("the hard gate still runs first on a completion incident (POSITIVE CONTROL: a money word in the evidence is forbidden)", sh.classifyForbidden({ ...incs[0], evidence: { ...incs[0].evidence, detail: "refund the payment" } }).forbidden && !sh.classifyForbidden(incs[0]).forbidden)
    const unreadable = memSupabase({}, { missingTables: ["manager_completions"] })
    let threw = false
    try { await osh.DETECTORS.stalled_completions(unreadable as never, B1, { now: NOW } as never) } catch { threw = true }
    check("an unreadable completion table makes the detector UNREADABLE (it throws for the supervisor to report) — never 'all clear'", threw)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("I · support tickets — a stall is DETECTED through C14 and handed to its owner (lane 147H owns the loop; READ ONLY)")
  {
    const db = world({ support_tickets: [
      { id: T1, brokerage_id: B1, subject: "Can't log in", priority: "urgent", status: "open", created_at: ago(60 * 24 * 3), first_response_at: null, resolved_at: null, lane: "user_to_brokerage", category: "access" },
      { id: "72727272-0000-4000-8000-000000000002", brokerage_id: B1, subject: "New", priority: "low", status: "open", created_at: ago(5), first_response_at: null, resolved_at: null, lane: "user_to_brokerage", category: "other" },
    ] })
    const w = await ct.watchUnresolvedTickets(db as never, B1, { now: NOW }, { schedule })
    const c = db.tables.manager_completions[0]
    check("a ticket past its SLA (evaluateTicketSla) opens ONE support_ticket completion owned by the registered steward; a fresh ticket opens none", w.opened === 1 && db.tables.manager_completions.length === 1 && c.kind === "support_ticket" && c.owner_manager === "data_steward" && c.subject_id === T1)
    const again = await ct.watchUnresolvedTickets(db as never, B1, { now: NOW }, { schedule })
    check("idempotent per ticket", again.opened === 0 && db.tables.manager_completions.length === 1)
    check("READ ONLY: nothing ever wrote support_tickets", !db.writes.some((x) => x.table === "support_tickets"))
    db.tables.support_tickets[0].status = "resolved"
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: c.id, trigger: "event" }, { schedule, engine })
    check("the ticket's resolution is the evidence that closes it", sup.verdict === "closed" && db.tables.manager_completions[0].closed_by === "ticket_resolution")
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("J · the boundary, the durable timer and the page graph (stripped source)")
  {
    const lib = code("lib/kernel/completion-tracking.ts")
    check("the supervisor never sends, never touches money, permissions, users or code (no dispatcher, no billing / users / role write)",
      !/dispatchSms\(|dispatchEmail\(|sendSMS\(|from\("(users|user_roles|billing_\w+|subscriptions|agent_commissions)"\)/.test(lib))
    check("POSITIVE CONTROL: the scanner sees the module's own completion writes", /from\("manager_completions"\)\.update\(/.test(lib.replace(/\s+/g, "")) || /from\("manager_completions"\)\s*\.update\(/.test(lib))
    const wf = code("workflows/completion-watch-workflow.ts")
    check("the DURABLE TIMER is a Vercel Workflow: 'use workflow' + sleep until due + a 'use step' that runs superviseCompletion with trigger 'workflow', bounded",
      /"use workflow"/.test(wf) && /"use step"/.test(wf) && /await sleep\(when\)/.test(wf) && /trigger: "workflow"/.test(wf) && /MAX_CHECKS/.test(wf))
    check("opening / advancing a completion STARTS that workflow (start(completionWatchWorkflow, …)) — no cron in the path", /start\(completionWatchWorkflow,/.test(lib) && /import\("workflow\/api"\)/.test(lib))
    const pageReach = ["lib/kernel/self-healing.ts", "lib/kernel/os-health.ts"].filter((f) => /import\(["']@\/lib\/kernel\/completion-tracking["']\)|from ["']@\/lib\/kernel\/completion-tracking["']/.test(code(f)))
    check("self-healing and os-health (both reachable from dashboard pages) never import the supervisor — the executors are HANDED to the engine", pageReach.length === 0, pageReach.join(", "))
    check("lib/kernel/completion-tracking.ts has NO static import (every survivor is lazy — a leaf wherever it is reached)", !/^import\s/m.test(lib))
    check("the provider status callback and the inbound chain are the EVENTS that drive it", /onProviderTruth\(/.test(code("app/api/webhooks/twilio-sms-status/route.ts")) && /openCompletion\(/.test(code("lib/communications/inbound-record.ts")) && /recordCompletionEvidence\(/.test(code("lib/communications/inbound-record.ts")))
  }

  console.log("\n  BLIND SPOTS (published, not hidden):")
  console.log("  · the Workflow DevKit runtime (sleep / step retry) is not executed here — the timer is a seam; its body is read from stripped source and the supervisor it calls is driven directly;")
  console.log("  · m904 is WRITTEN, NOT APPLIED — the table is modelled in memory; test:schema-drift lists manager_completions as unguarded and test:manager-governance-change E1 waits for TABLE_MANAGER + LIVE_TABLES until the integrator applies it and lane 147I registers it;")
  console.log("  · only inbound responses (and support tickets past SLA) OPEN completions in this wave; other manager decisions (speed-to-lead, life-change, promised deliverables) are listed for the integrator (notes: Still open);")
  console.log("  · check-vocabulary reads status literals per table it can see; COMPLETION_EXCEPTION_STATUSES is a Set (membership, not a literal comparison) until the vocabulary cache carries manager_completions;")
  console.log("  · the self-healing policy and the healing-proposal writer are the defaults / a stub here (test:healing-policy and test:self-healing own them).")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(`\n ❌ COMPLETION_TRACKING_FAIL — ${failures.join(" | ")}`); process.exit(1) }
  console.log("\n ✅ COMPLETION_TRACKING_PASS — every decision owes a completion; events and the durable timer see it through; the cron only reconciles, and says so")
}

main().catch((e) => { console.error(e); process.exit(1) })
