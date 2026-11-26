"use server"

// app/actions/phone-test-call.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PHONE TEST FEATURE, GATED ON BUSINESS REGISTRATION (wave 81, lane 81D —
// owner: "automatic registering business after phone number purchase/port
// over so can use the phone/test feature").
//
// Two exports, both public HTTP endpoints (CLAUDE.md §4), both gated FIRST on
// the brokerage finance-admin roster (the same tier carrier registration and
// number purchase use) with the tenant from the SESSION:
//   getPhoneTestReadinessAction  — READ: is the tenant's line registered enough
//                                  to test? (10DLC campaign approved for local
//                                  numbers; toll-free verified for 8xx) — the
//                                  reason when not.
//   placePhoneTestCallAction     — WRITE: FAIL CLOSED on readiness, then dial
//                                  the broker's own phone through the ONE
//                                  outbound lane (lib/voice/twilio-outbound.ts
//                                  placeOutboundAiCall — its gate stack runs:
//                                  suppression, TCPA quiet hours, budget).
//
// Nothing here fabricates a call row or a "registered" state.

import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { loadA2pState, assessPhoneTestReadiness, type PhoneTestReadiness } from "@/lib/voice/a2p-registration"

async function requireBrokerCtx(mode: "read" | "write"): Promise<{ ok: true; brokerageId: string; userId: string } | { ok: false; error: string }> {
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) return { ok: false, error: "Only broker / admin can run the phone test" }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId }
}

async function loadReadiness(svc: any, brokerageId: string): Promise<PhoneTestReadiness & { numbers: string[] }> {
  const [{ state }, { data: numbers, error }] = await Promise.all([
    loadA2pState(svc, brokerageId),
    svc.from("tenant_phone_numbers").select("phone_number").eq("brokerage_id", brokerageId).eq("is_active", true).limit(20),
  ])
  // A refused read is NOT "no numbers" — fail closed with the refusal named.
  if (error) return { ready: false, lanes: [], reason: `Could not read your phone numbers (${error.message}) — the test is refused until the read succeeds.`, numbers: [] }
  const rows = ((numbers ?? []) as Array<{ phone_number: string }>)
  return { ...assessPhoneTestReadiness(state, rows), numbers: rows.map((n) => n.phone_number) }
}

export async function getPhoneTestReadinessAction(): Promise<{ ok: true; readiness: PhoneTestReadiness & { numbers: string[] } } | { ok: false; error: string }> {
  const auth = await requireBrokerCtx("read")
  if (!auth.ok) return auth
  const svc = createServiceClient()
  return { ok: true, readiness: await loadReadiness(svc, auth.brokerageId) }
}

/** Dial the broker's OWN phone as a live test of the line. Refused, with the
 *  reason, until business registration is complete for every lane the
 *  tenant's numbers need. */
export async function placePhoneTestCallAction(input: { toNumber: string }): Promise<{ ok: true; callSid: string; fromNumber: string } | { ok: false; error: string; readiness?: PhoneTestReadiness }> {
  const auth = await requireBrokerCtx("write")
  if (!auth.ok) return { ok: false, error: auth.error }
  const digits = String(input?.toNumber ?? "").replace(/\D/g, "")
  if (digits.length < 10 || digits.length > 15) return { ok: false, error: "Enter the phone number to ring (your own mobile is the usual test)." }
  const toNumber = digits.length === 10 ? `+1${digits}` : `+${digits}`

  const svc = createServiceClient()
  const readiness = await loadReadiness(svc, auth.brokerageId)
  if (!readiness.ready) return { ok: false, error: `REFUSED: ${readiness.reason}`, readiness }

  const { placeOutboundAiCall } = await import("@/lib/voice/twilio-outbound")
  const r = await placeOutboundAiCall(svc, {
    toNumber,
    contactId: null,
    brokerageId: auth.brokerageId,
    agentUserId: auth.userId,
    initiatedBy: auth.userId,
    objective: "Phone line test: confirm the number rings and the AI receptionist answers in the brokerage's voice.",
    firstMessage: "Hi — this is your AI receptionist calling on a test of your new business line. Everything is working. Have a great day.",
    transactional: true,
    humanApproved: true,
    systemSource: "phone_test_call",
  })
  if (!r.ok) return { ok: false, error: r.blockReason ? `${r.error} (${r.blockReason})` : r.error, readiness }
  return { ok: true, callSid: r.callSid, fromNumber: r.fromNumber }
}
