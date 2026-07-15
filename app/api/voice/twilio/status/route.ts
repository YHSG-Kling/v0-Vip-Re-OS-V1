import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, validateTwilioSignature } from "@/lib/voice/twilio-voice"
import { isPlatformNumber } from "@/lib/voice/platform-reception"

export const dynamic = "force-dynamic"

/**
 * TWILIO VOICE — STATUS CALLBACK. The ledger-closer: when a caller hangs up
 * mid-<Gather> no turn webhook ever fires, so without this the session row
 * would sit "in_progress" forever. Twilio posts the terminal CallStatus here;
 * any still-open row for that CallSid is closed with the real duration.
 * Scope-aware: the platform's own line closes platform_reception_calls; every
 * tenant leg (inbound OR outbound) closes voice_calls.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const callSid = params.CallSid ?? ""
  const callStatus = (params.CallStatus ?? "").toLowerCase()
  const duration = Number.parseInt(params.CallDuration ?? "", 10)
  const terminal = ["completed", "busy", "no-answer", "failed", "canceled"].includes(callStatus)
  if (!callSid || !terminal) return NextResponse.json({ ok: true, ignored: true })

  const svc = createServiceClient()
  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twilio/status`
  const signature = request.headers.get("x-twilio-signature")

  // ── PLATFORM SCOPE ──────────────────────────────────────────────────────────
  const to = params.To ?? ""
  const from = params.From ?? ""
  if (isPlatformNumber(to, process.env.TWILIO_PHONE_NUMBER) || isPlatformNumber(from, process.env.TWILIO_PHONE_NUMBER)) {
    const token = process.env.TWILIO_AUTH_TOKEN
    if (!token || !validateTwilioSignature(token, url, params, signature)) {
      return new NextResponse("invalid signature", { status: 403 })
    }
    await svc.from("platform_reception_calls")
      .update({ status: "completed", ended_at: new Date().toISOString(), outcome: callStatus === "completed" ? undefined : callStatus })
      .eq("call_sid", callSid).eq("status", "in_progress")
      .then(undefined, () => {})
    return NextResponse.json({ ok: true })
  }

  // ── TENANT SCOPES — the tenant owns either end of the leg ───────────────────
  const ctx = (await resolveInboundContext(svc, to)) ?? (await resolveInboundContext(svc, from))
  if (!ctx) return NextResponse.json({ ok: true, unmatched: true })
  if (!validateTwilioSignature(ctx.authToken, url, params, signature)) {
    return new NextResponse("invalid signature", { status: 403 })
  }

  const patch: Record<string, unknown> = { ended_at: new Date().toISOString() }
  if (Number.isFinite(duration)) patch.duration_seconds = duration
  // A never-connected outbound leg records WHY (busy / no-answer / failed).
  if (callStatus !== "completed") patch.outcome = callStatus.replace("-", "_")
  patch.status = "completed"

  // .select() returns the transitioned rows — the hook below fires ONLY when
  // THIS callback actually closed the row (no double-fire with the turn-route
  // hangup path, which closes the row first on a normal goodbye).
  const { data: closed } = await svc.from("voice_calls").update(patch)
    .eq("vapi_call_id", callSid).in("status", ["initiated", "in_progress"])
    .select("id, lead_id")
    .then((r: any) => r, () => ({ data: null }))

  // A LEAD's call that ended mid-conversation still gets intent-classified:
  // positive direction converts the lead to a contact (canonical handoff).
  const leadRow = (closed ?? []).find((r: any) => r.lead_id)
  if (leadRow && callStatus === "completed") {
    try {
      const { routeLeadCallIntent } = await import("@/lib/ai-isa/lead-call-intent")
      await routeLeadCallIntent(svc, leadRow.id)
    } catch { /* best-effort — never 500 a Twilio callback */ }
  }
  return NextResponse.json({ ok: true })
}
