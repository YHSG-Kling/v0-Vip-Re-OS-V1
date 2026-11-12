#!/usr/bin/env tsx
/**
 * scripts/a2p-and-invites-guard.ts   (npm run test:a2p-and-invites — in memory, no DB, no network, no Twilio)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 150, LANE 150DAC (directive 150D + canary 16): "A2P starts on number creation; staff and tenant invites are
 * immediate, errors do not remain unseen for a day; recurring provider failure goes to manager then human support
 * with tenant-safe messaging." Support tickets / AI triage trustworthy, tenant-safe errors, staff escalation.
 *
 * ALREADY EXISTED — REUSED (survivors, proven by their own guards; re-asserted here where 150D depends on them):
 *   · lib/voice/number-provisioning.ts → lib/voice/a2p-registration.ts kickCarrierRegistration (THE step machine:
 *     A2P_STEPS customer_profile → trust_product → brand → messaging_service → number_attached → campaign) —
 *     test:phone-a2p-automation drives it against a simulated Twilio;
 *   · lib/kernel/users.ts inviteTenantMember / redispatchInvitation (the invite dispatched IN-REQUEST, result read; a
 *     refused dispatch writes user_invitations status 'failed' and is routed) — test:immediate-operations;
 *   · lib/kernel/immediate-operations.ts reportOperationOutcome + handleOperationFailureEscalated (the evidence row,
 *     the routed signal, the owner's re-verify, the human bell + ONE support ticket);
 *   · lib/support/ticket-triage.ts (AI triage with a deterministic fallback, tenantFacingGate, ensureOperationTicket).
 * BUILT (150DAC):
 *   1. the PURCHASE door now reports the phone_a2p post-condition in-request (before: only the BYO / port-in door did —
 *      a kickoff that threw on a freshly bought number reached a console line and the hourly tick);
 *   2. the ASYNC INVITATION REPAIR — the owner re-sends a failed invitation ONCE on the tick (redispatchInvitation)
 *      before a human is bothered; bounded by the bus's one-open-signal-per-subject dedupe;
 *   3. TENANT-SAFE escalation — the feed sentence and the tenant bell pass tenantFacingGate; a door / readiness reason
 *      that names a provider or database internal falls back to the operation's generic sentence (staff keep detail).
 *
 * BLIND SPOTS (published beside the numbers, §2):
 *   · no live Twilio filing and no purchase: provider approval is hours-to-days async and costs money — the step
 *     machine is test:phone-a2p-automation's (simulated transport); live registration is WAITING_EXTERNAL by name;
 *   · "within minutes" is bounded by the manager-signals tick schedule (derived below), not by a wall-clock run;
 *     the inviter sees the failure IN-REQUEST and the failed row is on Users › Invitations immediately;
 *   · the real Supabase auth invite email is not sent here (the resend is a spy; redispatchInvitation's own reads
 *     and writes are test:immediate-operations').
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { A2P_STEPS, isTollFreeNumber } from "../lib/voice/a2p-registration"
import { reportOperationOutcome, handleOperationFailureEscalated, OPERATION_OWNER, OPERATION_SIGNAL_TYPE } from "../lib/kernel/immediate-operations"
import { tenantFacingGate, classifyTicketHeuristically } from "../lib/support/ticket-triage"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(src(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const B = "33333333-3333-4333-8333-333333333333"
const CALLER = "44444444-4444-4444-8444-444444444444"
const INV = "55555555-5555-4555-8555-555555555555"

async function main() {
  console.log("[1 · A2P STARTS ON NUMBER CREATION — both doors, then the post-condition is reported in-request]")
  {
    const np = stripped("lib/voice/number-provisioning.ts")
    const purchaseKick = np.indexOf('kickCarrierRegistration(svc, { brokerageId: params.brokerageId, phoneNumber: targetNumber, trigger: "purchased" })')
    const purchaseReport = np.indexOf('source: "purchased", bound, registration')
    check("PURCHASE door: kickCarrierRegistration right after the bind, THEN the phone_a2p report (new in 150DAC)", purchaseKick > 0 && purchaseReport > purchaseKick)
    const byoKick = np.search(/kickCarrierRegistration\(svc, \{ brokerageId: params\.brokerageId, phoneNumber: cleaned/)
    const byoReport = np.indexOf("number: cleaned, source: params.source, bound, registration")
    check("BYO / PORT-IN door: the same kickoff, then the SAME reporter (one helper — no second copy)", byoKick > 0 && byoReport > byoKick && (np.match(/reportOperationOutcome\(/g) ?? []).length === 1 && (np.match(/await reportPhoneA2pOutcome\(/g) ?? []).length === 2)
    check("the reporter names the phone_a2p operation and a provider-free tenant sentence", /operation: "phone_a2p"/.test(np) && /business registration for your new number could not start/.test(np) && !/twilio/i.test(np.match(/tenantFacing: p\.registration[^\n]*/)?.[0] ?? "twilio"))
    check("the A2P provider steps, by NAME (Twilio ISV): customer profile → trust product → brand → messaging service → number attach → campaign", JSON.stringify(A2P_STEPS) === JSON.stringify(["customer_profile", "trust_product", "brand", "messaging_service", "number_attached", "campaign"]))
    check("the lane follows the number (local → 10DLC, 8xx → toll-free verification)", !isTollFreeNumber("+15125550100") && isTollFreeNumber("+18335550100"))
    // Configuration by NAME only: no SID / token VALUE anywhere in the A2P files.
    const files = ["lib/voice/a2p-registration.ts", "lib/voice/number-provisioning.ts", "lib/voice/carrier-registration-loop.ts", "lib/providers/twilio/client.ts"]
    const secretShape = /\b(AC|SK)[0-9a-f]{32}\b/
    check("CONTROL: the secret-shape finder flags a forged account SID", secretShape.test(`const sid = "AC${"0".repeat(32)}"`))
    check(`no Twilio SID / token VALUE in the ${files.length} A2P files — env var NAMES only (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)`, files.every((f) => !secretShape.test(src(f))) && /process\.env\.TWILIO_ACCOUNT_SID/.test(stripped("lib/voice/a2p-registration.ts")) && /process\.env\.TWILIO_AUTH_TOKEN/.test(stripped("lib/voice/a2p-registration.ts")))
    // Driven: a kickoff that THREW on a purchase is evidenced + routed to the communications owner NOW.
    const svc = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
    const r = await reportOperationOutcome(svc, { operation: "phone_a2p", brokerageId: B, ok: false, subjectType: "tenant_phone_number", subjectId: INV, evidence: { number_last4: "0100", source: "purchased" }, error: "kickoff threw: ECONNREFUSED", tenantFacing: "business registration for your new number could not start — the OS will retry and tell you if it needs your business profile" })
    const sig = (svc.tables.manager_signals ?? [])[0]
    check("driven: a failed kickoff lands an evidence row AND an open signal to the AI ISA (READINESS_OWNER.communications) in-request", r.evented && !!r.signalId && r.routedTo === OPERATION_OWNER.phone_a2p && sig?.to_manager === "ai_isa" && sig?.signal_type === OPERATION_SIGNAL_TYPE && (sig?.status ?? "open") === "open", JSON.stringify({ r, sig }))
    check("…and the provider's raw error stays in the evidence row, never in the tenant-facing sentence", !/ECONNREFUSED/.test(String(sig?.message ?? "")) && /ECONNREFUSED/.test(JSON.stringify(svc.tables.lifecycle_events ?? [])))
  }

  console.log("\n[2 · INVITES ARE IMMEDIATE; A FAILURE IS SEEN NOW AND REPAIRED ASYNCHRONOUSLY]")
  {
    const users = stripped("lib/kernel/users.ts")
    check("inviteTenantMember dispatches IN-REQUEST and READS the result (inviteUserByEmail → dispatchError → recordInviteDispatchFailure)", /inviteUserByEmail\(/.test(users) && /await recordInviteDispatchFailure\(service, \{ brokerageId, teamId, callerUserId, email/.test(users))
    check("a refused dispatch writes a visible 'failed' row (Users › Invitations) and reports ok:false with the subject user_invitation", /status: "failed"/.test(users) && /subjectType: "user_invitation"/.test(users))
    // The tick that surfaces it: derive the manager-signals cadence from THE schedule (cron-dispatch).
    const row = (CRON_REGISTRY as ReadonlyArray<{ path: string; schedule: string }>).find((c) => c.path === "/api/cron/manager-signals")
    const minutes = row ? row.schedule.split(" ")[0].split(",").map(Number).filter((n) => Number.isFinite(n)) : []
    const gaps = minutes.length > 1 ? minutes.map((m, i) => ((minutes[(i + 1) % minutes.length] - m + 60) % 60) || 60) : [60]
    check(`the owner's tick runs at most every ${Math.max(...gaps)} minutes ("${row?.schedule ?? "missing"}") — a failure reaches a human within minutes, never a day`, !!row && Math.max(...gaps) <= 30)
    // DRIVEN: the async repair.
    const base = { lifecycle_events: [], manager_signals: [], notifications: [] }
    const sigOf = (actor: string | null) => ({ id: "sig-1", entityType: "user_invitation", entityId: INV, payload: { operation: "invitation", subject_type: "user_invitation", subject_id: INV, lifecycle_event_id: "ev-1", tenant_facing: "Invitation delivery did not verify — the invitation email to a@b.co could not be sent — resend it from Users › Invitations", actor_user_id: actor } })
    const calls = { org: 0, staff: 0, ticket: 0, resend: 0, bodies: [] as string[] }
    const spies = (resend: (n: number) => { ok: boolean; dispatched: boolean; status: "pending" | "failed" | null; note?: string; error?: string }) => ({
      notifyOrg: async (_s: unknown, _b: string, n: { body: string }) => { calls.org++; calls.bodies.push(n.body); return 1 },
      notifyStaff: async () => { calls.staff++; return 1 },
      openTicket: async () => { calls.ticket++; return { ticketId: "tk-1", created: true, error: null } },
      redispatchInvitation: async () => { calls.resend++; return resend(calls.resend) },
    })
    const ctx = { brokerageId: B, supabase: memSupabase(base) }
    const ok = await handleOperationFailureEscalated(sigOf(CALLER), ctx, spies(() => ({ ok: true, dispatched: true, status: "pending", note: "Invitation email sent; window re-opened for 7 days." })))
    check("ASYNC REPAIR: the owner re-sends once; a re-send that works closes it with NO human bell and NO ticket", calls.resend === 1 && calls.org === 0 && calls.ticket === 0 && /repaired asynchronously/.test(ok ?? ""), ok ?? "")
    const bad = await handleOperationFailureEscalated(sigOf(CALLER), ctx, spies(() => ({ ok: false, dispatched: false, status: "failed", error: "The invitation email could not be sent: SMTP 421 from provider" })))
    check("still failing → the human rails: tenant admins' bell + ONE support ticket; the staff detail names the provider's error", calls.resend === 2 && calls.org === 1 && calls.ticket === 1 && /SMTP 421/.test(bad ?? ""))
    check("…and the tenant bell carries the tenant sentence, not the provider error", !calls.bodies.some((b) => /SMTP 421/.test(b)) && calls.bodies.some((b) => /resend it from Users › Invitations/.test(b)))
    const accepted = await handleOperationFailureEscalated(sigOf(CALLER), ctx, spies(() => ({ ok: false, dispatched: false, status: null, error: "Already accepted" })))
    check("an invitation already accepted needs no repair and bothers nobody", /already accepted/.test(accepted ?? "") && calls.org === 1)
    const noActor = await handleOperationFailureEscalated(sigOf(null), ctx, spies(() => ({ ok: true, dispatched: true, status: "pending" })))
    check("no attributable actor → no automatic re-send (never an unattributed write); straight to a human", calls.resend === 3 && calls.org === 2 && /escalated to a human/.test(noActor ?? ""), `resend=${calls.resend} org=${calls.org}`)
    // BOUNDED: the re-send's own failure report dedupes onto the still-open signal (one open per subject).
    const bus = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
    const first = await reportOperationOutcome(bus, { operation: "invitation", brokerageId: B, ok: false, subjectType: "user_invitation", subjectId: INV, evidence: {}, error: "x", actorUserId: CALLER })
    // The live column's DEFAULT 'open' (m217 manager_signals.status NOT NULL DEFAULT 'open') — the in-memory client applies no defaults.
    for (const s of (bus.tables.manager_signals ?? []) as any[]) s.status = s.status ?? "open"
    const second = await reportOperationOutcome(bus, { operation: "invitation", brokerageId: B, ok: false, subjectType: "user_invitation", subjectId: INV, evidence: { door: "resend" }, error: "y", actorUserId: CALLER })
    check("BOUNDED: a second failure for the same invitation while the first is open is ONE signal (the repair never loops)", !!first.signalId && first.signalId === second.signalId && (bus.tables.manager_signals ?? []).filter((s: any) => s.status === "open").length === 1)
  }

  console.log("\n[3 · TENANT-SAFE ERRORS AND STAFF ESCALATION — support triage]")
  {
    check("CONTROL: the tenant-facing gate refuses a database code, a key, a price and the platform-pays phrase; passes a plain sentence",
      !tenantFacingGate("refused: PGRST204").ok && !tenantFacingGate("use sk_live_abc123").ok && !tenantFacingGate("it costs $49").ok && !tenantFacingGate("this is platform-covered").ok && tenantFacingGate("Your invitation could not be sent — resend it from Users › Invitations.").ok)
    const svc = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
    await reportOperationOutcome(svc, { operation: "provider_connection", brokerageId: B, ok: false, subjectType: "platform_credentials", subjectId: CALLER, evidence: {}, error: "PGRST204 column missing", tenantFacing: "the write was refused (PGRST204 — column api_key missing)" })
    const msg = String((svc.tables.manager_signals ?? [])[0]?.message ?? "")
    check("a door's tenant sentence that leaks a database internal is REPLACED by the generic sentence on the feed (new in 150DAC)", msg.length > 0 && !/PGRST|api_key/.test(msg) && /Provider connection did not verify/.test(msg), msg)
    const bodies: string[] = [], staff: string[] = []
    const leak = await handleOperationFailureEscalated(
      { id: "s2", entityType: "platform_credentials", entityId: CALLER, payload: { operation: "provider_connection", tenant_facing: "Provider connection did not verify.", platform_visible: true } },
      { brokerageId: B, supabase: svc },
      {
        readiness: async () => ({ ready: false, blockers: ["providerState"], checks: [{ key: "providerState", required: true, status: "FAIL", reason: "platform_credentials read refused: 42501 permission denied" }] as any, repairs: [] }),
        notifyOrg: async (_s, _b, n) => { bodies.push(n.body); return 1 },
        notifyStaff: async (_s, n) => { staff.push(n.body); return 1 },
        openTicket: async () => ({ ticketId: "tk-2", created: true, error: null }),
      },
    )
    check("an escalation whose readiness reason names a database code: the TENANT bell gets the generic sentence, STAFF keep the code", bodies.length === 1 && !/42501/.test(bodies[0]) && staff.some((s) => /42501/.test(s)) && /support ticket tk-2/.test(leak ?? ""), JSON.stringify({ bodies, staff }))
    // The support doors never hand a raw database sentence back to the person (derived over every return).
    // A supabase refusal binding (error / err / xErr); a deterministic policy verdict's own sentence (e.g. the C23
    // decideStatusOverride `.message`) is a human sentence, not a database one, and is not matched.
    const rawReturn = /return\s*\{[^}]*\berror:\s*(?:(?:error|err|[a-z]+Err)\??\.message\b|`[^`]*\$\{(?:error|err|[a-z]+Err)\??\.message\}[^`]*`)/
    check("CONTROL: the raw-error finder flags `return { ok: false, error: error.message }` and a templated one; passes a policy verdict", rawReturn.test("return { ok: false, error: error.message }") && rawReturn.test("return { ok: false, error: `Could not read: ${rErr.message}` }") && !rawReturn.test(`return { ok: false, error: tenantSafeError("x", error.message) }`) && !rawReturn.test("return { ok: false, error: statusChange.message }"))
    const supportReturns = stripped("app/actions/support.ts").split("\n").filter((l) => rawReturn.test(l))
    check(`app/actions/support.ts returns no raw database error to the person (${supportReturns.length} found; refusals logged in full for staff)`, supportReturns.length === 0 && /function tenantSafeError\(/.test(stripped("app/actions/support.ts")), supportReturns.join(" | "))
    const t = classifyTicketHeuristically("My agent never got the invite", "the invitation email never arrived")
    check("support triage reads an invite ticket as the invitation operation (the safe-repair path) — onboarding category", t.operation === "invitation" && t.category === "onboarding")
    const t2 = classifyTicketHeuristically("Texting blocked", "our 10DLC carrier registration is stuck")
    check("…and a texting / A2P ticket as phone_a2p (routed to the communications owner, never a guess)", t2.operation === "phone_a2p")
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(`FAILED: ${failures.join("; ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
