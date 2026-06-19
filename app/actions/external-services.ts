"use server"

/**
 * EXTERNAL SERVICES (thin wrappers)
 * All API calls are delegated to lib/providers/*.
 * This file preserves existing function signatures for backward compatibility.
 */

import { dispatchSms, dispatchEmail } from "@/lib/providers/dispatch"
import { createServiceClient } from "@/lib/supabase/service"
import { createTransfer } from "@/lib/providers/payment"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

/** Resolve the brokerage for the consent/de-confliction gate — given, else from the contact. */
async function resolveBrokerageId(contactId?: string, given?: string): Promise<string> {
  if (given) return given
  if (!contactId) return ""
  try {
    const svc = createServiceClient()
    const { data } = await svc.from("contacts").select("brokerage_id").eq("id", contactId).maybeSingle()
    return (data as any)?.brokerage_id ?? ""
  } catch { return "" }
}

// ─── AVATAR / EXPLAINER VIDEO ─────────────────────────────────────────────────
// BUSINESS RULE (platform-locked): the avatar/explainer-video engine is D-ID +
// ElevenLabs ONLY — HeyGen is NOT used. These functions keep their historical
// names for backward-compat with existing callers, but every render goes through
// D-ID. `avatarId` is treated as a D-ID source/actor reference, `voiceId` as the
// ElevenLabs voice id. Brokerage scoping is resolved from the caller's session.
const DID_API_BASE = "https://api.d-id.com"

export async function generateHeyGenVideo(params: {
  avatarId: string
  voiceId: string
  script: string
  contactId?: string
  brokerageId?: string
}) {
  const didApiKey = process.env.DID_API_KEY
  const elApiKey = process.env.ELEVENLABS_API_KEY

  if (!didApiKey || !elApiKey) {
    return {
      success: false,
      error: "Video provider (D-ID + ElevenLabs) not configured. Add DID_API_KEY and ELEVENLABS_API_KEY to environment variables.",
      requiresConfiguration: true,
    }
  }

  try {
    const { generateVideo } = await import("@/lib/did")
    const result = await generateVideo({
      script: params.script,
      voiceId: params.voiceId || undefined,
      // avatarId resolves to a D-ID actor (persistent avatar) or null source.
      actorId: params.avatarId || null,
      brokerageId: params.brokerageId ?? "",
    })

    if (result.status === "error") {
      return { success: false, error: result.note ?? "D-ID render failed" }
    }
    // videoId is the D-ID talk/clip id used for downstream status polling.
    return { success: true, videoId: result.videoId, status: result.status === "done" ? "completed" : "processing" }
  } catch (error: any) {
    console.error("[External Services] D-ID video error:", error)
    return { success: false, error: error.message }
  }
}

export async function getHeyGenVideoStatus(videoId: string) {
  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) {
    return { success: false, error: "D-ID API key not configured" }
  }

  // Poll D-ID /talks/{id}. Clip jobs also resolve through the same id space; the
  // poll-did-videos cron is the canonical async finalizer — this is the sync read.
  const response = await callConnector<{ status?: string; result_url?: string }>({
    connector: "did",
    baseUrl: DID_API_BASE,
    path: `/talks/${videoId}`,
    method: "GET",
    auth: { style: "basic", username: didApiKey, password: "" },
  })

  if (!response.ok || !response.data) {
    return { success: false, error: response.error ?? "D-ID status error" }
  }
  const status = response.data.status === "done" ? "completed" : response.data.status === "error" ? "failed" : "processing"
  return {
    success: true,
    status,
    videoUrl: response.data.result_url,
  }
}

// TWILIO SMS — delegates to lib/providers/messaging
export async function sendTwilioSMS(params: {
  to: string
  message: string
  contactId?: string
  brokerageId?: string
}) {
  try {
    // Route through the gate (consent/opt-out/DNC/quiet-hours/de-confliction) — no raw send.
    const brokerageId = await resolveBrokerageId(params.contactId, params.brokerageId)
    return await dispatchSms({
      brokerageId, to: params.to, message: params.message,
      contactId: params.contactId, systemSource: "external_services",
    })
  } catch (error: any) {
    console.error("[External Services] Twilio error:", error)
    return { success: false, error: error.message }
  }
}

// SENDGRID EMAIL — delegates to lib/providers/messaging
export async function sendSendGridEmail(params: {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  contactId?: string
  brokerageId?: string
}) {
  try {
    // Route through the gate (suppression/consent/de-confliction) — no raw send.
    const brokerageId = await resolveBrokerageId(params.contactId, params.brokerageId)
    return await dispatchEmail({
      brokerageId, to: params.to, subject: params.subject, html: params.html, text: params.text,
      from: params.from ?? (process.env.SENDGRID_FROM_EMAIL || "noreply@yourdomain.com"),
      contactId: params.contactId, channelPurpose: "transactional", systemSource: "external_services",
    })
  } catch (error: any) {
    console.error("[External Services] SendGrid error:", error)
    return { success: false, error: error.message }
  }
}

// STRIPE — delegates to lib/providers/payment
export async function createStripeTransfer(params: {
  amount: number
  destinationAccountId: string
  description?: string
  transactionId?: string
}) {
  try {
    return await createTransfer(params)
  } catch (error: any) {
    console.error("[External Services] Stripe error:", error)
    return { success: false, error: error.message }
  }
}
