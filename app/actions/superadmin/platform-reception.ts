"use server"

// app/actions/superadmin/platform-reception.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM-LINE AI RECEPTION — bind + status. The platform's own number
// (TWILIO_PHONE_NUMBER, master account) gets its VoiceUrl pointed at the shared
// Twilio-native inbound webhook, so the SAME conversational engine that answers
// tenant lines answers the app's own line (sell honestly, capture prospects,
// route support). Providers-capability-gated + audited. Honest failures when
// the master account or app URL isn't configured — nothing is faked.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"

async function requireProviders(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "providers")) return { ok: false, error: "Forbidden — platform providers access required" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient(); const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_reception", target_id: "platform_line",
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-reception audit] failed:", err) }
}

/**
 * Point the PLATFORM's own number at the Twilio-native reception lane:
 * look up the number's SID on the MASTER account, set its VoiceUrl to
 * /api/voice/twilio/inbound. Idempotent — safe to re-run after env changes.
 */
export async function bindPlatformReceptionAction(): Promise<{ ok: true; phoneNumber: string } | { ok: false; error: string }> {
  const auth = await requireProviders()
  if (!auth.ok) return auth

  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER
  if (!accountSid || !authToken) return { ok: false, error: "Twilio master account not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) — nothing was changed." }
  if (!phoneNumber) return { ok: false, error: "TWILIO_PHONE_NUMBER not set — the platform has no line to bind." }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not set — can't register the webhook URL." }
  const voiceUrl = `${appUrl.replace(/\/$/, "")}/api/voice/twilio/inbound`

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const lookup = await callConnector({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    method: "GET",
    query: { PhoneNumber: phoneNumber },
    auth: { style: "basic", username: accountSid, password: authToken },
  })
  if (!lookup.ok) return { ok: false, error: `Twilio number lookup failed (${lookup.status ?? "—"}): ${lookup.error ?? "unknown"}` }
  const sid = (lookup.data as any)?.incoming_phone_numbers?.[0]?.sid
  if (!sid) return { ok: false, error: `The master account doesn't own ${phoneNumber} — check TWILIO_PHONE_NUMBER.` }

  const bind = await callConnector({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${sid}.json`,
    method: "POST",
    bodyType: "form",
    body: {
      VoiceUrl: voiceUrl, VoiceMethod: "POST",
      // Closes any platform_reception_calls row a mid-call hangup left open.
      StatusCallback: `${appUrl.replace(/\/$/, "")}/api/voice/twilio/status`, StatusCallbackMethod: "POST",
    },
    auth: { style: "basic", username: accountSid, password: authToken },
  })
  if (!bind.ok) return { ok: false, error: `Twilio VoiceUrl update failed (${bind.status ?? "—"}): ${bind.error ?? "unknown"}` }

  await audit(auth.userId, auth.email, "platform_reception.bound", { phoneNumber, voiceUrl })
  return { ok: true, phoneNumber }
}

/** The platform line's recent reception activity — calls + captured prospects. */
export async function listPlatformReceptionCallsAction(): Promise<{ ok: true; calls: any[] } | { ok: false; error: string }> {
  const auth = await requireProviders()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_reception_calls")
    .select("id, call_sid, phone_from, status, outcome, transcript, prospect_id, started_at, ended_at")
    .order("started_at", { ascending: false }).limit(200)
  if (error) return { ok: false, error: error.message }
  return { ok: true, calls: data ?? [] }
}
