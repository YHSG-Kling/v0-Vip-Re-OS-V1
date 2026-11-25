#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-last-guard.ts   (npm run test:ledger-receipts-last)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 155, LANE 155R21 — the last rows that kept `test:os-coverage-ledger` red at a9e0def4 (the frozen baseline is prune-only,
 * so each closes only by what the code does), plus the integrator's four P0 extension rows.
 *   A. never frozen, missing evidence (8): /api/voice/end-call · /api/voice/twilio/recording · the reactor's disclosure check
 *      on document_received / document_uploaded · calendar updateAppointment / cancelAppointment /
 *      createDeadlineEventsFromMilestones · open-house monitorCompetingEvents (which also had NO gate).
 *   B. widened public doors (2): submitDataSubjectRequestAction · recordTosAcceptanceAction — decidePublicDoor BEFORE the write.
 *   C. P0 outside the frozen P0 list (2): /api/onboarding/training/progress · /api/track/identify.
 *   EXT (integrator): startSubscriptionCheckout · /api/embed/session/end · submitFeedback (decision) · validateListingTransition
 *      (a census disagreement: NO receipt is added — held below as "writes nothing on its own path").
 *
 * PART A — STATIC (comment- and string-blanked source, CLAUDE.md §2): each row's own span reaches its receipt door with its
 *   three-segment action and NO cycle / idempotencyKey; each public door calls decidePublicDoor( BEFORE its first write; the
 *   gated export resolves the session BEFORE its receipt and pins the tenant on the read and the write; the reactor asks the
 *   autonomy gate BEFORE the model-backed check; the DSAR tenant never comes from the body; the signup form READS the
 *   acceptance result. Positive controls: a tombstone naming a door is not a call; a `cycle` is caught; a door evaluated after
 *   the write is caught; a body-tenant precedence is caught.
 * PART B — DRIVEN (in-memory, SIMULATED; scripts/canaries/_harness.ts; Twilio, Stripe and the minute meter are COUNTED stubs —
 *   no provider, no model, no network): two calls → two receipts (the no-key canary) with actor / tenant / subject / risk class;
 *   a refused write settles failed; a sessionless caller is refused with no write and no receipt; a provider callback's tenant
 *   is the matched row's; a privacy request's tenant is the matched user's even when the body names another brokerage.
 * RED AT a9e0def4: none of these rows reached a receipt door; monitorCompetingEvents wrote for any caller; the DSAR door took
 *   the body's tenant; the two public doors had no decision; the signup form ignored a refused acceptance.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import { stubModule, setSvc, canaryClient, setSessionUser } from "./canaries/_harness"

const ROOT = process.cwd()
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (f: string) => readFileSync(join(ROOT, f), "utf8")
const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const DOOR_RE = /\b(?:ledgerSessionAction|withActionLedger|ledgered)\s*(?:<[^()]*>)?\s*\(/

/** The span of a function (exported or not) in a blanked text, to the next top-level declaration. */
function spanOf(text: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/\n(?:export\s|async\s+function\s|function\s|const\s|interface\s|type\s)/)
  return text.slice(m.index, m.index + m[0].length + (next < 0 ? rest.length : next))
}
/** [code span (strings blanked), literal span (comments blanked)] — a code token is searched in the first, a name in the second. */
function spans(src: string, name: string): [string, string] | null {
  const nc = blankComments(src), code = blankStrings(nc)
  const a = spanOf(code, name), b = spanOf(nc, name)
  return a && b ? [a, b] : null
}
function judge(src: string, name: string, action: string): string[] {
  const s = spans(src, name)
  if (!s) return [`function ${name} not found`]
  const out: string[] = []
  if (!DOOR_RE.test(s[0])) out.push("reaches no receipt door")
  if (!NAME_RE.test(action) || (!s[1].includes(`"${action}"`) && !s[1].includes(`'${action}'`))) out.push(`does not name ${action}`)
  if (/\b(?:cycle|idempotencyKey)\s*:/.test(s[0])) out.push("passes cycle / idempotencyKey")
  return out
}
/** The first index of a write (`.insert(` / `.upsert(` / `.update(`) in a code span, or -1. */
const firstWrite = (code: string) => code.search(/\.(?:insert|upsert|update)\s*\(/)
const decidesBeforeWrite = (code: string) => { const d = code.search(/\bdecidePublicDoor\s*\(/), w = firstWrite(code); return d >= 0 && (w < 0 || d < w) }

const ROWS: Array<[string, string, string]> = [
  ["app/actions/ai-calendar-management.ts", "updateAppointment", "calendar.appointment.reschedule"],
  ["app/actions/ai-calendar-management.ts", "cancelAppointment", "calendar.appointment.cancel"],
  ["app/actions/ai-calendar-management.ts", "createDeadlineEventsFromMilestones", "calendar.deadline_event.create"],
  ["app/actions/open-house-automation.ts", "monitorCompetingEvents", "marketing.open_house_competition.scan"],
  ["app/actions/privacy/data-subject-requests.ts", "submitDataSubjectRequestAction", "privacy.data_subject_request.submit"],
  ["app/api/voice/end-call/route.ts", "POST", "voice.call.end"],
  ["app/api/voice/twilio/recording/route.ts", "POST", "voice.call_recording.store"],
  ["app/api/onboarding/training/progress/route.ts", "POST", "training.video.complete"],
  ["app/api/track/identify/route.ts", "POST", "marketing.website_visitor.identify"],
  ["app/actions/billing.ts", "startSubscriptionCheckout", "billing.subscription_checkout.start"],
  ["app/api/embed/session/end/route.ts", "POST", "billing.live_agent_minutes.book"],
]

function partA(): void {
  console.log("\nPART A — static (stripped source)")
  check("control: a tombstone naming a door is not a call", judge(`export async function f() {\n  // ledgerSessionAction({ action: "a.b.c" })\n  return 1\n}\n`, "f", "a.b.c").includes("reaches no receipt door"))
  check("control: a cycle is caught", judge(`export async function f() {\n  return withActionLedger({ action: "a.b.c", cycle: "x" }, run, h)\n}\n`, "f", "a.b.c").includes("passes cycle / idempotencyKey"))
  check("control: a clean span passes", judge(`export async function f() {\n  return ledgerSessionAction({ action: "a.b.c" }, run)\n}\n`, "f", "a.b.c").length === 0)
  check("control: a door evaluated AFTER the write is caught; before it passes", !decidesBeforeWrite(`svc.from(x).insert({}); await decidePublicDoor({})`) && decidesBeforeWrite(`await decidePublicDoor({}); svc.from(x).insert({})`))
  for (const [file, fn, action] of ROWS) {
    const p = judge(read(file), fn, action)
    check(`${file}#${fn} → one receipt '${action}', no key`, p.length === 0, p.join("; "))
  }
  // The reactor block (no named function — the block is located by its own action name).
  const reactor = blankComments(read("lib/kernel/event-reactor.ts"))
  const at = reactor.indexOf(`"compliance.disclosure_check.run"`)
  const block = at < 0 ? "" : blankStrings(reactor.slice(Math.max(0, at - 6000), at + 200))
  check("reactor: the disclosure check asks the autonomy gate BEFORE the model-backed check and is receipted once", at >= 0 && /autonomyDecision\s*\(/.test(block) && block.search(/autonomyDecision\s*\(/) < block.search(/runDisclosureComplianceCheck\s*\(/) && /withActionLedger\s*<void>\s*\(/.test(block) && /if\s*\(\s*!discDecision\.allow\s*\)\s*return/.test(block))
  // Public doors decide before the write.
  for (const [file, fn] of [["app/actions/privacy/data-subject-requests.ts", "submitDataSubjectRequestAction"], ["app/actions/public/tos-acceptance.ts", "recordTosAcceptanceAction"], ["app/actions/open-house-automation.ts", "submitFeedback"]] as const) {
    const s = spans(read(file), fn)
    check(`${fn}: decidePublicDoor( runs BEFORE the first write`, !!s && decidesBeforeWrite(s[0]))
  }
  // The gate added to monitorCompetingEvents.
  const [mce, mceLit] = spans(read("app/actions/open-house-automation.ts"), "monitorCompetingEvents") ?? ["", ""]
  // The order is judged on the code span; the tenant predicate names a column (a string literal), so it is counted on the literal span.
  check("monitorCompetingEvents: the session is resolved and refused BEFORE the receipt; read and write pinned to the session tenant",
    mce.search(/getAgentContext\s*\(/) >= 0 && mce.search(/getAgentContext\s*\(/) < mce.search(/\bledgered\s*\(/) && (mceLit.match(/\.eq\(\s*"brokerage_id"\s*,\s*competitionTenant\s*\)/g) ?? []).length >= 2)
  // The DSAR tenant.
  const bodyTenant = (code: string) => /input\.brokerageId\s*\?\?/.test(code)
  const dsar = spans(read("app/actions/privacy/data-subject-requests.ts"), "submitDataSubjectRequestAction")?.[0] ?? "input.brokerageId ??"
  check("DSAR: the tenant is never the body's (control: the old precedence is caught)", !bodyTenant(dsar) && bodyTenant("const b = input.brokerageId ?? matchUser?.brokerage_id"))
  // The signup form reads the acceptance result.
  const form = blankStrings(blankComments(read("app/get-started/trial-funnel-form.tsx")))
  check("signup: a refused ToS acceptance stops the funnel before signupBrokerageAction", /if\s*\(\s*!tosRecorded\.ok\s*\)/.test(form) && form.search(/!tosRecorded\.ok/) < form.search(/signupBrokerageAction\s*\(/))
  // EXT 4 — validateListingTransition writes nothing on its own path (the census disagreement): no write token in its span, and the
  // only listing-agreement-terms member its readiness path names is the reader.
  const vlt = spans(read("app/actions/listing-lifecycle-core.ts"), "validateListingTransition")?.[0] ?? ".insert("
  const rc = blankStrings(blankComments(read("lib/listing-lifecycle/readiness-checker.ts")))
  check("validateListingTransition: no write on its own span; the readiness path writes nothing (positive control: a planted insert is seen)",
    firstWrite(vlt) < 0 && firstWrite(rc) < 0 && firstWrite(`svc.from(x).insert({})`) >= 0)
  check("validateListingTransition: the readiness path calls ONLY the terms reader (governingListingAgreementTerms), never the two writers",
    /governingListingAgreementTerms\s*\(/.test(rc) && !/recordListingAgreementAmendment\s*\(|recordOriginalListingAgreementTerms\s*\(/.test(rc))
  check("no receipt was added to validateListingTransition (a census disagreement is not closed by a receipt)", !DOOR_RE.test(vlt))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — seams installed before any route / action module is imported.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
for (const k of ["TWILIO_AUTH_TOKEN", "STRIPE_SECRET_KEY", "AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[k]
const SEAM = globalThis as unknown as { __R21: { hangups: number; stripeCustomers: number; stripeSessions: number; meter: number; events: number; sigOk: boolean } }
SEAM.__R21 = { hangups: 0, stripeCustomers: 0, stripeSessions: 0, meter: 0, events: 0, sigOk: true }
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
stubModule("next/headers", "export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }); export const headers = async () => new Headers({ 'x-forwarded-for': globalThis.__R21ip ?? '203.0.113.9' })")
stubModule("@/lib/voice/twilio-outbound", "export async function endOutboundAiCall() { globalThis.__R21.hangups++; return { ok: true } }")
stubModule("@/lib/voice/twilio-voice", "export async function resolveInboundContext(svc, n) { return n === '+15550000001' ? { brokerageId: globalThis.__R21B, authToken: 'stub' } : null }; export function validateTwilioSignature() { return globalThis.__R21.sigOk }")
stubModule("@/lib/did/live-session-metering", "export async function endLiveAgentSession(id, s) { globalThis.__R21.meter++; return { ok: true, minutesBilled: s / 60 } }")
stubModule("@/lib/kernel", "export const KernelEvent = new Proxy({}, { get: (_, k) => String(k).toLowerCase() }); export async function processKernelEvent() { globalThis.__R21.events++; return { ok: true } }")

const B = "b1550000-0000-4000-8000-0000000000a1", B2 = "b2550000-0000-4000-8000-0000000000a1"
const U = "a1550000-0000-4000-8000-0000000000a1", A = "a2550000-0000-4000-8000-0000000000a1"
const E = "e1550000-0000-4000-8000-0000000000a1", T = "71550000-0000-4000-8000-0000000000a1", M = "31550000-0000-4000-8000-0000000000a1"
const V = "51550000-0000-4000-8000-0000000000a1", C = "c1550000-0000-4000-8000-0000000000a1", S = "61550000-0000-4000-8000-0000000000a1"
;(globalThis as Record<string, unknown>).__R21B = B
function seed(extra: Record<string, Record<string, unknown>[]> = {}): Record<string, Record<string, unknown>[]> {
  return {
    brokerages: [{ id: B, name: "R21 Realty", email: "office@wave140-canary.test" }, { id: B2, name: "Other Realty" }],
    users: [{ id: U, brokerage_id: B, user_type: "broker_owner", platform_role: null, email: "owner@wave140-canary.test", first_name: "Rae", last_name: "Lane" }],
    agents: [{ id: A, user_id: U, brokerage_id: B }],
    agent_action_ledger: [], ...extra,
  }
}
const ledger = (svc: { tables: Record<string, Record<string, unknown>[]> }, action: string) => (svc.tables.agent_action_ledger ?? []).filter((r) => r.action === action)
const settle = async (p: () => Promise<unknown>): Promise<unknown> => { try { return await p() } catch (e) { return { thrown: (e as Error).message } } }
const userShape = (r: Record<string, unknown>, risk: string, subject: string | null) => r.actor_type === "user" && r.actor_user_id === U && r.brokerage_id === B && r.risk_class === risk && !r.idempotency_key && (subject === null || r.subject_id === subject)
const jsonReq = (url: string, body: unknown, ip = "198.51.100.7") => new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) })

async function partB(): Promise<void> {
  console.log("\nPART B — driven (in-memory, SIMULATED)")
  // ── calendar: reschedule / cancel / deadlines ──
  const cal = await import(join(ROOT, "app/actions/ai-calendar-management.ts"))
  {
    const svc = canaryClient(seed({ calendar_events: [{ id: E, brokerage_id: B, entity_id: C, entity_type: "contact", event_type: "showing", start_at: "2027-01-01T10:00:00Z", end_at: "2027-01-01T11:00:00Z", metadata: { title: "Tour" } }] }))
    setSvc(svc); setSessionUser(svc, U)
    const r1 = await settle(() => cal.updateAppointment(E, { start_time: "2027-01-02T10:00:00Z" })); await settle(() => cal.updateAppointment(E, { start_time: "2027-01-03T10:00:00Z" }))
    const rs = ledger(svc, "calendar.appointment.reschedule")
    check("updateAppointment ×2 → TWO receipts, both executed (no key: the second call ran)", rs.length === 2 && rs.every((r) => userShape(r, "LOW_RISK_WRITE", E) && r.status === "executed"), `${rs.length} ${JSON.stringify(r1).slice(0, 160)}`)
    await settle(() => cal.cancelAppointment(E, "client asked")); await settle(() => cal.cancelAppointment(E))
    const cs = ledger(svc, "calendar.appointment.cancel")
    check("cancelAppointment ×2 → TWO receipts, executed, metadata merged (title kept)", cs.length === 2 && cs.every((r) => userShape(r, "LOW_RISK_WRITE", E) && r.status === "executed") && (svc.tables.calendar_events[0].metadata as Record<string, unknown>).title === "Tour", `${cs.length}`)
    const other = await settle(() => cal.updateAppointment("e9550000-0000-4000-8000-0000000000a1", { start_time: "2027-01-02T10:00:00Z" }))
    const after = ledger(svc, "calendar.appointment.reschedule")
    check("a zero-row reschedule returns a refusal and its receipt settles failed (never executed)", (other as { success?: boolean }).success === false && after.length === 3 && after[2].status === "failed", after.map((r) => r.status).join(","))
    const bad = canaryClient(seed({ calendar_events: [{ id: E, brokerage_id: B, entity_id: C, entity_type: "contact", event_type: "showing", start_at: "x", end_at: "y", metadata: {} }] }), { missingColumns: { calendar_events: ["start_at"] } })
    setSvc(bad); setSessionUser(bad, U)
    await settle(() => cal.updateAppointment(E, { start_time: "2027-01-02T10:00:00Z" }))
    const bf = ledger(bad, "calendar.appointment.reschedule")
    check("a refused write (absent column) settles failed", bf.length === 1 && bf[0].status === "failed", bf.map((r) => `${r.status}/${r.outcome}`).join(","))
    const anon = canaryClient(seed({ calendar_events: [{ id: E, brokerage_id: B, metadata: {} }] })); setSvc(anon); setSessionUser(anon, null)
    const ar = await settle(() => cal.cancelAppointment(E))
    check("NEGATIVE: a sessionless cancel is refused with no write and no receipt", (ar as { success?: boolean }).success === false && (anon.tables.agent_action_ledger ?? []).length === 0 && !(anon.tables.calendar_events[0].metadata as Record<string, unknown>).cancelled)
    const ds = canaryClient(seed({ transaction_milestones: [{ id: M, transaction_id: T, brokerage_id: B, status: "pending", title: "Inspection", milestone_type: "inspection", target_date: "2027-02-01", description: null }], calendar_events: [] }))
    setSvc(ds); setSessionUser(ds, U)
    await settle(() => cal.createDeadlineEventsFromMilestones({ transactionId: T })); await settle(() => cal.createDeadlineEventsFromMilestones({ transactionId: T }))
    const dr = ledger(ds, "calendar.deadline_event.create")
    check("createDeadlineEventsFromMilestones ×2 → TWO receipts on the transaction, ONE event (the probe is the run's own idempotency)", dr.length === 2 && dr.every((r) => userShape(r, "LOW_RISK_WRITE", T) && r.status === "executed") && ds.tables.calendar_events.length === 1, `${dr.length} events=${ds.tables.calendar_events.length}`)
  }
  // ── open house: the competition scan's gate, and the feedback door ──
  const oh = await import(join(ROOT, "app/actions/open-house-automation.ts"))
  {
    const ev = (id: string, b: string, st: string, en: string) => ({ id, brokerage_id: b, event_date: "2027-03-01", start_time: st, end_time: en, listing_id: null })
    const svc = canaryClient(seed({ open_house_events: [ev(E, B, "10:00", "12:00"), ev("e2550000-0000-4000-8000-0000000000a1", B, "11:00", "13:00"), ev("e3550000-0000-4000-8000-0000000000a1", B2, "10:00", "12:00")], listings: [] }))
    setSvc(svc); setSessionUser(svc, null)
    const anon = await settle(() => oh.monitorCompetingEvents(E))
    check("NEGATIVE (red at the base): a sessionless competition scan is refused — nothing written, no receipt", (anon as { error?: string }).error === "Not authenticated" && !svc.tables.open_house_events[0].competing_events_data && (svc.tables.agent_action_ledger ?? []).length === 0)
    setSessionUser(svc, U)
    await settle(() => oh.monitorCompetingEvents(E)); const r2 = await settle(() => oh.monitorCompetingEvents(E))
    const rs = ledger(svc, "marketing.open_house_competition.scan")
    check("monitorCompetingEvents ×2 (signed in) → TWO receipts; the scan stays inside the tenant (1 same-tenant overlap, never the other tenant's)", rs.length === 2 && rs.every((r) => userShape(r, "LOW_RISK_WRITE", E) && r.status === "executed") && (r2 as { same_time_conflicts?: number }).same_time_conflicts === 1, `${rs.length} ${JSON.stringify(r2).slice(0, 140)}`)
    const other = canaryClient(seed({ open_house_events: [ev(E, B2, "10:00", "12:00")] })); setSvc(other); setSessionUser(other, U)
    const cross = await settle(() => oh.monitorCompetingEvents(E))
    check("NEGATIVE: another tenant's event id is 'not found' and is not written", (cross as { error?: string }).error === "Event not found" && !other.tables.open_house_events[0].competing_events_data)

    const fb = canaryClient(seed({ open_house_attendees: [{ id: V, event_id: E, brokerage_id: B, contact_id: null, ai_lead_score: 0, working_with_agent: false }], open_house_events: [ev(E, B, "10:00", "12:00")], open_house_feedback: [] }))
    setSvc(fb); setSessionUser(fb, null)
    ;(globalThis as Record<string, unknown>).__R21ip = "203.0.113.21"
    const ok = await settle(() => oh.submitFeedback({ attendeeId: V, overallRating: 5 }))
    check("submitFeedback: the door proves the tenant from the attendee row and the feedback is stored under it", (ok as { success?: boolean }).success === true && fb.tables.open_house_feedback.length === 1 && fb.tables.open_house_feedback[0].brokerage_id === B, JSON.stringify(ok).slice(0, 160))
    const none = await settle(() => oh.submitFeedback({ attendeeId: "59550000-0000-4000-8000-0000000000a1", overallRating: 5 }))
    check("NEGATIVE: an unknown attendee is refused by the door with nothing written", (none as { error?: string }).error === "Attendee not found" && fb.tables.open_house_feedback.length === 1)
    let limited: unknown = null
    for (let i = 0; i < 12; i++) limited = await settle(() => oh.submitFeedback({ attendeeId: V, overallRating: 4 }))
    check("NEGATIVE: past the per-connection cap the door refuses honestly and writes nothing more", /Too many submissions/.test(String((limited as { error?: string }).error)) && fb.tables.open_house_feedback.length <= 11, `rows=${fb.tables.open_house_feedback.length}`)
  }
  // ── privacy request and ToS acceptance (public doors) ──
  {
    const dsar = await import(join(ROOT, "app/actions/privacy/data-subject-requests.ts"))
    const svc = canaryClient(seed({ contacts: [], data_subject_requests: [] })); setSvc(svc); setSessionUser(svc, null)
    ;(globalThis as Record<string, unknown>).__R21ip = "203.0.113.31"
    const r = await settle(() => dsar.submitDataSubjectRequestAction({ requestType: "export", subjectEmail: "owner@wave140-canary.test", brokerageId: B2 }))
    const rows = ledger(svc, "privacy.data_subject_request.submit")
    check("DSAR (matched user): ONE LEGAL receipt, actor system, tenant = the matched user's — the body's other brokerage is ignored (red at the base)",
      (r as { ok?: boolean }).ok === true && rows.length === 1 && rows[0].actor_type === "system" && rows[0].brokerage_id === B && rows[0].risk_class === "LEGAL" && rows[0].status === "executed" && svc.tables.data_subject_requests[0].brokerage_id === B, `${JSON.stringify(r).slice(0, 120)} ${JSON.stringify(rows[0] ?? {}).slice(0, 200)}`)
    const r2 = await settle(() => dsar.submitDataSubjectRequestAction({ requestType: "delete", subjectEmail: "stranger@wave140-canary.test", brokerageId: B2 }))
    check("DSAR (no match): the request is still recorded (its own row is the legal record), with NO tenant and no invented ledger row",
      (r2 as { ok?: boolean }).ok === true && svc.tables.data_subject_requests.length === 2 && svc.tables.data_subject_requests[1].brokerage_id === null && ledger(svc, "privacy.data_subject_request.submit").length === 1)
    let last: unknown = null
    for (let i = 0; i < 6; i++) last = await settle(() => dsar.submitDataSubjectRequestAction({ requestType: "access", subjectEmail: "owner@wave140-canary.test" }))
    check("DSAR door: past the cap the person is told it was NOT submitted (never a silent drop)", (last as { ok?: boolean; error?: string }).ok === false && /NOT submitted/.test(String((last as { error?: string }).error)))
    const tos = await import(join(ROOT, "app/actions/public/tos-acceptance.ts"))
    const ts = canaryClient(seed({ platform_tos_acceptances: [] })); setSvc(ts)
    ;(globalThis as Record<string, unknown>).__R21ip = "203.0.113.41"
    const t1 = await settle(() => tos.recordTosAcceptanceAction({ email: "new@wave140-canary.test", version: "2026-07-01" }))
    let tl: unknown = null
    for (let i = 0; i < 11; i++) tl = await settle(() => tos.recordTosAcceptanceAction({ email: `n${i}@wave140-canary.test`, version: "2026-07-01" }))
    check("ToS door: an acceptance is recorded; past the cap the refusal says it was NOT recorded and nothing more is written",
      (t1 as { ok?: boolean }).ok === true && (tl as { ok?: boolean }).ok === false && /NOT recorded/.test(String((tl as { error?: string }).error)) && ts.tables.platform_tos_acceptances.length === 10, `rows=${ts.tables.platform_tos_acceptances.length}`)
  }
  // ── voice: the agent's hang-up (session) and the recording callback (provider) ──
  {
    const end = await import(join(ROOT, "app/api/voice/end-call/route.ts"))
    const svc = canaryClient(seed({ voice_calls: [{ id: S, brokerage_id: B, vendor_call_id: "CA1", status: "in_progress" }] })); setSvc(svc); setSessionUser(svc, U)
    const h0 = SEAM.__R21.hangups
    await settle(() => end.POST(new Request("http://canary.test/api/voice/end-call?callId=CA1", { method: "POST" }) as never)); await settle(() => end.POST(new Request("http://canary.test/api/voice/end-call?callId=CA1", { method: "POST" }) as never))
    const rs = ledger(svc, "voice.call.end")
    check("end-call ×2 → TWO COMMUNICATION receipts on the voice_calls row; the hang-up seam was reached twice (counted)", rs.length === 2 && rs.every((r) => userShape(r, "COMMUNICATION", S) && r.status === "executed") && SEAM.__R21.hangups - h0 === 2 && svc.tables.voice_calls[0].status === "completed", `${rs.length}`)
    const rec = await import(join(ROOT, "app/api/voice/twilio/recording/route.ts"))
    const vs = canaryClient(seed({ voice_calls: [{ id: S, brokerage_id: B, vendor_call_id: "CA2", recording_url: null }] })); setSvc(vs)
    const form = () => { const f = new FormData(); f.set("To", "+15550000001"); f.set("From", "+15551112222"); f.set("CallSid", "CA2"); f.set("RecordingSid", "RE1"); f.set("RecordingStatus", "completed"); f.set("RecordingDuration", "12"); f.set("RecordingUrl", "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1"); return new Request("http://canary.test/api/voice/twilio/recording", { method: "POST", body: f }) }
    await settle(() => rec.POST(form() as never)); await settle(() => rec.POST(form() as never))
    const rr = ledger(vs, "voice.call_recording.store")
    check("recording callback ×2 → TWO receipts (actor system, tenant = the signed number's): stored once, the retry settles skipped",
      rr.length === 2 && rr.every((r) => r.actor_type === "system" && r.brokerage_id === B && !r.idempotency_key) && rr[0].status === "executed" && rr[1].status === "skipped" && !!vs.tables.voice_calls[0].recording_url, rr.map((r) => `${r.status}/${r.outcome}`).join(",") + ` url=${!!vs.tables.voice_calls[0].recording_url}`)
    SEAM.__R21.sigOk = false
    await settle(() => rec.POST(form() as never)); SEAM.__R21.sigOk = true
    check("NEGATIVE: a wrongly signed callback leaves no receipt", ledger(vs, "voice.call_recording.store").length === 2)
  }
  // ── the visitor identification, the training completion, the embed minutes ──
  {
    const idr = await import(join(ROOT, "app/api/track/identify/route.ts"))
    const svc = canaryClient(seed({ website_visitors: [{ id: V, session_id: "sess-1", brokerage_id: B, lead_id: null, contact_id: null }], contacts: [{ id: C, brokerage_id: B, email: "client@wave140-canary.test" }], leads: [] }))
    setSvc(svc)
    await settle(() => idr.POST(jsonReq("http://canary.test/api/track/identify", { sessionId: "sess-1", email: "client@wave140-canary.test" }) as never))
    await settle(() => idr.POST(jsonReq("http://canary.test/api/track/identify", { sessionId: "sess-1", email: "client@wave140-canary.test" }) as never))
    const rs = ledger(svc, "marketing.website_visitor.identify")
    check("track/identify → ONE receipt (actor system, tenant = the visitor row's, subject the visitor); the second beacon is already linked and records nothing; no Lead id in the receipt",
      rs.length === 1 && rs[0].actor_type === "system" && rs[0].brokerage_id === B && rs[0].subject_id === V && rs[0].status === "executed" && svc.tables.website_visitors[0].contact_id === C && !JSON.stringify(rs[0]).includes("lead_id\":\""), JSON.stringify(rs[0] ?? {}).slice(0, 200))
    const tr = await import(join(ROOT, "app/api/onboarding/training/progress/route.ts"))
    // An AGENT seat (getAgentContext resolves agents.id only for agent-type users; the route refuses a seat with no agents row).
    const ts = canaryClient(seed({ users: [{ id: U, brokerage_id: B, user_type: "agent", platform_role: null, email: "agent@wave140-canary.test", first_name: "Rae", last_name: "Lane" }], video_completion_tracking: [], training_videos: [{ id: M, brokerage_id: null, is_required: false, duration_seconds: 10 /* wave 156 (156K): a 10-second video — completion is credited from the server's own elapsed time (creditWatchProgress), so the 5.1 s wait below is a real 90% */ }] })); setSvc(ts); setSessionUser(ts, U)
    const p1 = await settle(async () => { const r = await tr.POST(jsonReq("http://canary.test/api/onboarding/training/progress", { videoId: M, positionSeconds: 10, percentWatched: 40 }) as never); return (r as Response).json() })
    check("training progress: a position save below completion leaves NO receipt (telemetry)", ledger(ts, "training.video.complete").length === 0 && ts.tables.video_completion_tracking.length === 1, JSON.stringify(p1).slice(0, 200))
    await new Promise((r) => setTimeout(r, 5100))
    await settle(() => tr.POST(jsonReq("http://canary.test/api/onboarding/training/progress", { videoId: M, positionSeconds: 300, percentWatched: 95 }) as never))
    const tc = ledger(ts, "training.video.complete")
    check("training progress: the COMPLETING save leaves ONE receipt (session user, tenant, the video)", tc.length === 1 && userShape(tc[0], "LOW_RISK_WRITE", M) && tc[0].status === "executed" && ts.tables.video_completion_tracking[0].completed === true, `${tc.length}`)
    const emb = await import(join(ROOT, "app/api/embed/session/end/route.ts"))
    const es = canaryClient(seed({ live_agent_sessions: [{ id: S, brokerage_id: B, status: "active", started_at: new Date(Date.now() - 600_000).toISOString() }] })); setSvc(es)
    const m0 = SEAM.__R21.meter
    await settle(() => emb.POST(jsonReq("http://canary.test/api/embed/session/end", { liveSessionId: S, seconds: 7200 }, "198.51.100.61") as never))
    const er = ledger(es, "billing.live_agent_minutes.book")
    check("embed end → ONE FINANCIAL receipt (actor system, tenant = the session row's), billed seconds clamped to the elapsed time, meter seam reached once",
      er.length === 1 && er[0].actor_type === "system" && er[0].brokerage_id === B && er[0].risk_class === "FINANCIAL" && SEAM.__R21.meter - m0 === 1 && Number((er[0].detail as Record<string, unknown>)?.billed_seconds) <= 660, JSON.stringify(er[0] ?? {}).slice(0, 220))
    es.tables.live_agent_sessions[0].status = "closed"
    await settle(() => emb.POST(jsonReq("http://canary.test/api/embed/session/end", { liveSessionId: S, seconds: 60 }, "198.51.100.61") as never))
    check("NEGATIVE: a closed session is refused by the door — no booking, no receipt", ledger(es, "billing.live_agent_minutes.book").length === 1 && SEAM.__R21.meter - m0 === 1)
  }
}

const BLIND = [
  "The in-memory client models no RLS and no NOT NULL; the live agent_action_ledger CHECKs (action pattern, reason codes, actor FK) are held by test:action-ledger §14, not here.",
  "startSubscriptionCheckout and the reactor's disclosure block are held STATICALLY (the Stripe and model doors are not driven here; the checkout's refusals precede the claim by reading).",
  "The public-door caps are per-process in-memory windows (lib/security/public-rate-limit.ts) — a multi-instance deploy multiplies them; unchanged by this lane.",
  "validateListingTransition stays open in the census by design (a census disagreement — notes); this guard only holds that it writes nothing on its own path.",
]

async function main(): Promise<void> {
  partA()
  await partB()
  console.log("\nBLIND SPOTS"); for (const b of BLIND) console.log(`  · ${b}`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); console.log("❌ LEDGER_RECEIPTS_LAST_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_LAST_PASS — every row reaches one receipt per act with no key; the public doors decide before the write; refusals are honest")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
