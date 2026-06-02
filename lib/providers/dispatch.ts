/**
 * OUTBOUND DISPATCH LAYER
 * lib/providers/dispatch.ts
 *
 * Single entry point for all outbound comms: email, SMS, phone, direct mail, video.
 * Provider selection is always resolved via kernel/providers.ts cascade:
 *   user → team → brokerage → superadmin → system default
 * Never hardcode a provider name in feature code — use these dispatchers.
 *
 * direct_mail and video are SYSTEM_ONLY: superadmin-controlled, no per-brokerage override.
 * SMS and phone are supported via the existing Twilio messaging provider.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const LobSDK = require("lob")

import { resolveProvider } from "@/lib/kernel/providers"
import {
  sendEmail as messagingSendEmail,
  sendSMS as messagingSendSMS,
  placeCall as messagingPlaceCall,
} from "@/lib/providers/messaging"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { assembleEmail } from "@/lib/kernel/communications/assemble-email"
import { evaluateOutboundCompliance } from "@/lib/kernel/communication-compliance"
import { checkSuppression } from "@/lib/kernel/compliance/check-suppression"
import { evaluateDeconflict, type DeconflictChannel } from "@/lib/kernel/deconflict"
import { createServiceClient } from "@/lib/supabase/service"

// ─── SHARED TYPES ─────────────────────────────────────────────────────────────

interface DispatchActorContext {
  /** The brokerage this dispatch is billed / scoped to (always required) */
  brokerageId: string
  /** The user initiating the dispatch (for provider override cascade) */
  userId?: string
  /** The team for provider override cascade */
  teamId?: string
  /** Source system for vendor usage attribution, e.g. 'ai_isa', 'campaign' */
  systemSource?: string
  /**
   * Lead ID for cost attribution. Use this when the recipient is a lead record.
   * Prefer contactId when the recipient is a promoted contact record.
   * Internally, contactId takes precedence over leadId for assembleEmail().
   */
  leadId?: string
  /**
   * Contact ID for cost attribution. Use this when the recipient is a contacts
   * record (post-promotion). Takes precedence over leadId inside dispatch.
   */
  contactId?: string
  agentId?: string
}

interface DispatchResult {
  success: boolean
  providerKey: string
  messageId?: string
  error?: string
}

// ─── De-Conflict helper — single chokepoint for over-touch suppression ──────
// Runs the De-Conflict Engine and converts a suppression decision into a
// DispatchResult that callers can return as-is. Every call writes an audit
// row to deconflict_suppression_log (m113) regardless of outcome.
async function deconflictGate(args: {
  brokerageId:   string
  channel:       DeconflictChannel
  contactId?:    string | null
  recipientEmail?: string | null
  recipientPhone?: string | null
  systemSource?: string
}): Promise<DispatchResult | null> {
  if (!args.contactId && !args.recipientEmail && !args.recipientPhone) return null
  const d = await evaluateDeconflict(args)
  if (d.allowed) return null
  return {
    success:     false,
    providerKey: "deconflict_gate",
    error:       `Outbound deferred: ${d.reason}`,
  }
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────

export interface DispatchEmailParams extends DispatchActorContext {
  from: string
  to: string
  subject: string
  html: string
  text?: string
  /**
   * Override the channelPurpose passed to assembleEmail().
   * When omitted, purpose is inferred from systemSource.
   * Always set this explicitly when the caller knows the intent.
   */
  channelPurpose?: 'conversation' | 'campaign' | 'update' | 'transactional'
  metadata?: Record<string, unknown>
}

export async function dispatchEmail(params: DispatchEmailParams): Promise<DispatchResult> {
  // ── COMPLIANCE GATE: Check if contact is eligible for outbound ───────────────
  if (params.contactId || params.leadId) {
    const supabase = await createServiceClient()
    const recipientId = params.contactId || params.leadId
    const table = params.contactId ? "contacts" : "leads"

    // Final straggler gate (1/2): comprehensive suppression check — contact flags
    // (email_unsubscribed + legacy email_opt_out) AND contact_suppression_list,
    // brokerage-scoped. The contact-flag-only gate below misses list-only entries.
    const suppression = await checkSuppression({
      brokerageId: params.brokerageId,
      contactId: params.contactId ?? null,
      email: params.to ?? null,
      phone: null,
      channel: "email",
    })
    if (suppression.suppressed) {
      console.warn(`[Dispatch] Email blocked for ${recipientId}: ${suppression.reason}`)
      return {
        success: false,
        providerKey: "compliance_gate",
        error: `Outbound blocked: ${suppression.reason}`,
      }
    }

    const { data: recipient, error: recipientError } = await supabase
      .from(table)
      .select("*")
      .eq("id", recipientId)
      .maybeSingle()

    if (!recipientError && recipient) {
      const complianceResult = await evaluateOutboundCompliance({
        contact: recipient,
        channel: "email",
        content: params.subject,
        actorContext: {
          brokerageId: params.brokerageId,
          actorType: params.systemSource?.includes("ai_isa") ? "ai_isa" : "system",
          userId: params.userId,
        },
      })

      if (!complianceResult.allowed) {
        console.warn(
          `[Dispatch] Email blocked for ${recipientId}: ${complianceResult.primaryReason}`
        )
        return {
          success: false,
          providerKey: "compliance_gate",
          error: `Outbound blocked: ${complianceResult.primaryReason}`,
        }
      }
    }

    // ── De-Conflict gate (over-touch suppression) ────────────────────────────
    const deferred = await deconflictGate({
      brokerageId:    params.brokerageId,
      channel:        "email",
      contactId:      params.contactId ?? null,
      recipientEmail: params.to ?? null,
      systemSource:   params.systemSource,
    })
    if (deferred) return deferred
  }

  const { providerKey } = await resolveProvider({
    providerType: "email",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })

  // ── Kernel OS: assemble body → signature → unsubscribe → legal ─────────────
  // Prefer an explicit channelPurpose from the caller; fall back to systemSource inference.
  const channelPurpose: 'conversation' | 'campaign' | 'update' | 'transactional' =
    params.channelPurpose ??
    (params.systemSource?.includes("campaign")        ? "campaign"
    : params.systemSource?.includes("nurture")        ? "update"
    : params.systemSource?.includes("transactional")  ? "transactional"
    : "conversation")

  // contactId takes precedence over leadId — contacts are promoted leads and
  // the signature/unsubscribe lookup keys off the contacts table.
  const recipientId = params.contactId ?? params.leadId ?? null

  const assembled = await assembleEmail({
    bodyHtml:       params.html ?? "",
    bodyText:       params.text,
    userId:         params.agentId ?? params.userId ?? params.brokerageId ?? "",
    brokerageId:    params.brokerageId,
    contactId:      recipientId,
    channelPurpose,
  }).catch(() => ({
    html:                 params.html ?? "",
    text:                 params.text ?? "",
    signatureIncluded:    false,
    unsubscribeIncluded:  false,
    disclosuresIncluded:  false,
  }))

  let result: DispatchResult

  if (providerKey === "sendgrid") {
    const raw = await messagingSendEmail({
      from:    params.from,
      to:      params.to,
      subject: params.subject,
      html:    assembled.html,
      text:    assembled.text,
    })
    result = {
      success: raw.success,
      providerKey,
      error: raw.error,
    }
  } else {
    // Future: SMTP relay via global_settings (smtp_host / smtp_port / smtp_username / smtp_password)
    // For now fall through to sendgrid default until SMTP relay is wired
    const raw = await messagingSendEmail({
      from:    params.from,
      to:      params.to,
      subject: params.subject,
      html:    assembled.html,
      text:    assembled.text,
    })
    result = {
      success: raw.success,
      providerKey,
      error: raw.error,
    }
  }

  // Record usage — fire and forget (non-blocking)
  void logVendorUsage({
    vendorName: providerKey,
    usageType: "emails",
    unitCount: 1,
    estimatedCost: 0.001,
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId ?? params.contactId,
    metadata: {
      to: params.to,
      subject: params.subject,
      provider_key: providerKey,
      contact_id: params.contactId,
      ...(params.metadata ?? {}),
    },
  })

  return result
}

// ─── SMS ──────────────────────────────────────────────────────────────────────

export interface DispatchSmsParams extends DispatchActorContext {
  to: string
  message: string
  metadata?: Record<string, unknown>
}

export async function dispatchSms(params: DispatchSmsParams): Promise<DispatchResult> {
  // ── COMPLIANCE GATE: Check if contact is eligible for SMS ──────────────────
  if (params.contactId || params.leadId) {
    const supabase = await createServiceClient()
    const recipientId = params.contactId || params.leadId
    const table = params.contactId ? "contacts" : "leads"

    // Final straggler gate (1/2): comprehensive suppression check — contact flags
    // (sms_unsubscribed + legacy sms_opt_out) AND contact_suppression_list,
    // brokerage-scoped. The contact-flag-only gate below misses list-only entries.
    const suppression = await checkSuppression({
      brokerageId: params.brokerageId,
      contactId: params.contactId ?? null,
      email: null,
      phone: params.to ?? null,
      channel: "sms",
    })
    if (suppression.suppressed) {
      console.warn(`[Dispatch] SMS blocked for ${recipientId}: ${suppression.reason}`)
      return {
        success: false,
        providerKey: "compliance_gate",
        error: `Outbound blocked: ${suppression.reason}`,
      }
    }

    const { data: recipient, error: recipientError } = await supabase
      .from(table)
      .select("*")
      .eq("id", recipientId)
      .maybeSingle()

    if (!recipientError && recipient) {
      const complianceResult = await evaluateOutboundCompliance({
        contact: recipient,
        channel: "sms",
        content: params.message,
        actorContext: {
          brokerageId: params.brokerageId,
          actorType: params.systemSource?.includes("ai_isa") ? "ai_isa" : "system",
          userId: params.userId,
        },
      })

      if (!complianceResult.allowed) {
        console.warn(
          `[Dispatch] SMS blocked for ${recipientId}: ${complianceResult.primaryReason}`
        )
        return {
          success: false,
          providerKey: "compliance_gate",
          error: `Outbound blocked: ${complianceResult.primaryReason}`,
        }
      }
    }

    // ── De-Conflict gate (over-touch suppression) ────────────────────────────
    const deferred = await deconflictGate({
      brokerageId:    params.brokerageId,
      channel:        "sms",
      contactId:      params.contactId ?? null,
      recipientPhone: params.to ?? null,
      systemSource:   params.systemSource,
    })
    if (deferred) return deferred
  }

  const { providerKey } = await resolveProvider({
    providerType: "sms",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })

  // Only Twilio is supported for SMS today
  const raw = await messagingSendSMS({
    to: params.to,
    message: params.message,
  })

  const result: DispatchResult = {
    success: raw.success,
    providerKey,
    messageId: raw.messageId,
    error: raw.error,
  }

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "sms_messages",
    unitCount: 1,
    estimatedCost: 0.0075, // Twilio SMS ~$0.0075/segment
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      to: params.to,
      provider_key: providerKey,
      ...(params.metadata ?? {}),
    },
  })

  return result
}

// ─── PHONE (outbound call) ────────────────────────────────────────────────────

export interface DispatchPhoneParams extends DispatchActorContext {
  to: string
  /** TwiML URL that controls the call flow */
  twimlUrl: string
  metadata?: Record<string, unknown>
}

export async function dispatchPhone(params: DispatchPhoneParams): Promise<DispatchResult> {
  // ── COMPLIANCE GATE: Check if contact is eligible for phone calls ───────────
  if (params.contactId || params.leadId) {
    const supabase = await createServiceClient()
    const recipientId = params.contactId || params.leadId
    const table = params.contactId ? "contacts" : "leads"

    // Final straggler gate (1/2): comprehensive suppression check — contact flags
    // (dnc_status / call_stop_flag) AND contact_suppression_list, brokerage-scoped.
    // The contact-flag-only gate below misses list-only entries.
    const suppression = await checkSuppression({
      brokerageId: params.brokerageId,
      contactId: params.contactId ?? null,
      email: null,
      phone: params.to ?? null,
      channel: "phone",
    })
    if (suppression.suppressed) {
      console.warn(`[Dispatch] Phone call blocked for ${recipientId}: ${suppression.reason}`)
      return {
        success: false,
        providerKey: "compliance_gate",
        error: `Outbound blocked: ${suppression.reason}`,
      }
    }

    const { data: recipient, error: recipientError } = await supabase
      .from(table)
      .select("*")
      .eq("id", recipientId)
      .maybeSingle()

    if (!recipientError && recipient) {
      const complianceResult = await evaluateOutboundCompliance({
        contact: recipient,
        channel: "phone",
        content: "Outbound call",
        actorContext: {
          brokerageId: params.brokerageId,
          actorType: params.systemSource?.includes("ai_isa") ? "ai_isa" : "system",
          userId: params.userId,
        },
      })

      if (!complianceResult.allowed) {
        console.warn(
          `[Dispatch] Phone call blocked for ${recipientId}: ${complianceResult.primaryReason}`
        )
        return {
          success: false,
          providerKey: "compliance_gate",
          error: `Outbound blocked: ${complianceResult.primaryReason}`,
        }
      }
    }

    // ── De-Conflict gate (over-touch suppression) ────────────────────────────
    const deferred = await deconflictGate({
      brokerageId:    params.brokerageId,
      channel:        "phone",
      contactId:      params.contactId ?? null,
      recipientPhone: params.to ?? null,
      systemSource:   params.systemSource,
    })
    if (deferred) return deferred
  }

  const { providerKey } = await resolveProvider({
    providerType: "phone",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })

  const raw = await messagingPlaceCall({
    to: params.to,
    twimlUrl: params.twimlUrl,
  })

  const result: DispatchResult = {
    success: raw.success,
    providerKey,
    messageId: raw.callSid,
    error: raw.error,
  }

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "minutes",
    unitCount: 1,
    estimatedCost: 0.013, // Twilio Voice ~$0.013/min
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      to: params.to,
      provider_key: providerKey,
      ...(params.metadata ?? {}),
    },
  })

  return result
}

// ─── DIRECT MAIL (superadmin-controlled, system-only) ────────────────────────
// direct_mail is SYSTEM_ONLY in kernel/providers.ts — resolveProvider always
// returns the system default (lob) and ignores per-brokerage overrides.

export type DirectMailPieceType = "letter" | "postcard" | "self_mailer"

export interface DispatchDirectMailParams extends DispatchActorContext {
  recipientName: string
  mailingAddress: string
  mailingAddress2?: string
  city: string
  state: string
  zip: string
  /** Lob template id. For letters/self-mailers this is the document; for postcards it is the FRONT. */
  templateId: string
  /** Postcard BACK template id (defaults to env LOB_POSTCARD_BACK_ID or the front). */
  backTemplateId?: string
  /** Mail piece type — Lob supports more than letters. Defaults to "letter". */
  pieceType?: DirectMailPieceType
  /** Postcard size: "4x6" | "6x9" | "6x11" (default "4x6"). Letters ignore this. */
  size?: string
  /** Color print (default false for letters, true for postcards). */
  color?: boolean
  mergeVars?: Record<string, string>
  metadata?: Record<string, unknown>
}

export async function dispatchDirectMail(
  params: DispatchDirectMailParams
): Promise<DispatchResult> {
  // ── De-Conflict gate (over-touch suppression) ────────────────────────────
  // Lob postcards/letters land in mailboxes — physical touches count too.
  // The default policy caps 1 piece / 30 days per contact.
  if (params.contactId) {
    const deferred = await deconflictGate({
      brokerageId:  params.brokerageId,
      channel:      "mail",
      contactId:    params.contactId,
      systemSource: params.systemSource,
    })
    if (deferred) return deferred
  }

  const { providerKey } = await resolveProvider({
    providerType: "direct_mail",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })
  // providerKey will always be 'lob' until a superadmin override exists

  // Real Lob integration (letters / postcards / self-mailers). Feature code calls
  // dispatchDirectMail; if Lob keys are absent it returns a clean unconfigured error.
  const lobApiKey = process.env.LOB_API_KEY
  if (!lobApiKey) {
    const result: DispatchResult = {
      success: false,
      providerKey,
      error: "Direct mail provider (Lob) not configured. Add LOB_API_KEY to environment variables.",
    }
    return result
  }

  const lob = LobSDK(lobApiKey)
  const pieceType: DirectMailPieceType = params.pieceType ?? "letter"
  const to = {
    name: params.recipientName,
    address_line1: params.mailingAddress,
    ...(params.mailingAddress2 ? { address_line2: params.mailingAddress2 } : {}),
    address_city: params.city,
    address_state: params.state,
    address_zip: params.zip,
    address_country: "US",
  }
  const from = process.env.LOB_RETURN_ADDRESS_ID
  const mergeVars = params.mergeVars ?? {}

  // Approx Lob per-piece cost by type (telemetry only; reconciled against Lob invoices).
  const COST: Record<DirectMailPieceType, number> = { letter: 1.2, postcard: 0.78, self_mailer: 1.05 }

  let data: { id?: string }
  try {
    if (pieceType === "postcard") {
      data = await lob.postcards.create({
        to,
        from,
        front: params.templateId,
        back: params.backTemplateId ?? process.env.LOB_POSTCARD_BACK_ID ?? params.templateId,
        size: params.size ?? "4x6",
        merge_variables: mergeVars,
      })
    } else if (pieceType === "self_mailer") {
      data = await lob.selfMailers.create({
        to,
        from,
        inside: params.templateId,
        outside: params.backTemplateId ?? params.templateId,
        size: params.size ?? "6x18_bifold",
        merge_variables: mergeVars,
        color: params.color ?? true,
      })
    } else {
      data = await lob.letters.create({
        to,
        from,
        file: params.templateId,
        merge_variables: mergeVars,
        color: params.color ?? false,
      })
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, providerKey, error: `Lob API error: ${msg}` }
  }

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "pieces_mailed",
    unitCount: 1,
    estimatedCost: COST[pieceType],
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      lob_id: data.id,
      piece_type: pieceType,
      template_id: params.templateId,
      provider_key: providerKey,
      ...(params.metadata ?? {}),
    },
  })

  return { success: true, providerKey, messageId: data.id }
}

// ─── VIDEO (superadmin-controlled, system-only) ───────────────────────────────
// video is SYSTEM_ONLY. Platform-locked vendor: D-ID + ElevenLabs (per kernel-OS
// plan FIX 0C.6) — agent's own avatar (did_photo_url / did_video_url) + cloned
// voice (elevenlabs_voice_id) from agent_voice_profiles. Falls back to HeyGen
// only when getPlatformVideoProvider() returns 'heygen' (superadmin override).

export interface DispatchVideoParams extends DispatchActorContext {
  /** D-ID path: rendered narration script (the avatar reads this).
   *  HeyGen path: HeyGen template_id. */
  templateId: string
  recipientEmail: string
  recipientName?: string
  scriptVars?: Record<string, string>
  metadata?: Record<string, unknown>
}

export async function dispatchVideo(params: DispatchVideoParams): Promise<DispatchResult> {
  // ── De-Conflict gate (over-touch suppression) ────────────────────────────
  // D-ID renders are expensive AND avatar-video saturation hurts engagement;
  // default policy caps 1 video / 21 days per contact.
  if (params.contactId) {
    const deferred = await deconflictGate({
      brokerageId:  params.brokerageId,
      channel:      "video",
      contactId:    params.contactId,
      systemSource: params.systemSource,
    })
    if (deferred) return deferred
  }

  const { providerKey } = await resolveProvider({
    providerType: "video",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })

  // Platform-level video provider preference. Default per kernel-OS plan = "did" (D-ID + ElevenLabs).
  const { getPlatformVideoProvider } = await import("@/app/actions/settings/global-settings-actions")
  const platformProvider = await getPlatformVideoProvider().catch(() => "did" as const)

  if (platformProvider === "did") {
    return dispatchVideoViaDID({ params, providerKey })
  }

  return dispatchVideoViaHeyGen({ params, providerKey })
}

// ─── D-ID + ElevenLabs path (default per plan) ────────────────────────────────
async function dispatchVideoViaDID({
  params,
  providerKey,
}: {
  params: DispatchVideoParams
  providerKey: string
}): Promise<DispatchResult> {
  const didApiKey = process.env.DID_API_KEY
  const elApiKey = process.env.ELEVENLABS_API_KEY

  if (!didApiKey || !elApiKey) {
    return {
      success: false,
      providerKey,
      error:
        "Video provider (D-ID + ElevenLabs) not configured. Set DID_API_KEY and ELEVENLABS_API_KEY in the platform Settings → Providers page.",
    }
  }

  // Resolve agent's D-ID + ElevenLabs identity profile.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()

  const agentUserId = params.userId ?? params.agentId
  if (!agentUserId) {
    return { success: false, providerKey, error: "Cannot generate video — agent ID missing" }
  }

  const { data: didProfile } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url, default_expression, expression_intensity")
    .eq("agent_id", agentUserId)
    .maybeSingle()

  if (!didProfile?.elevenlabs_voice_id) {
    return {
      success: false,
      providerKey,
      error: "Voice clone not set up. The agent must complete Settings → Voice & Avatar before videos can be generated.",
    }
  }

  const sourceUrl = didProfile.did_video_url ?? didProfile.did_photo_url
  if (!sourceUrl) {
    return {
      success: false,
      providerKey,
      error: "Avatar not set up. The agent must upload a headshot or video clip in Settings → Voice & Avatar.",
    }
  }

  const isVideoSource = !!didProfile.did_video_url

  // Render the script with template variables filled in.
  const renderedScript = (params.scriptVars ? Object.entries(params.scriptVars) : []).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v ?? "")),
    String(params.templateId ?? "")
  ) || JSON.stringify(params.scriptVars ?? {})

  // ─── 1. Generate audio via ElevenLabs TTS ───────────────────────────────────
  const ttsRes = await callConnector<Buffer>({
    connector: "elevenlabs",
    baseUrl: "https://api.elevenlabs.io",
    path: `/v1/text-to-speech/${didProfile.elevenlabs_voice_id}`,
    method: "POST",
    auth: { style: "header", name: "xi-api-key", value: elApiKey },
    headers: { Accept: "audio/mpeg" },
    responseType: "arraybuffer",
    body: { text: renderedScript, model_id: "eleven_multilingual_v2" },
  })

  if (!ttsRes.ok || !ttsRes.data) {
    return { success: false, providerKey: "did", error: `ElevenLabs TTS error: ${ttsRes.error ?? `HTTP ${ttsRes.status}`}` }
  }

  // For D-ID we need a hosted audio URL — write to Supabase storage.
  const audioPath = `isa-videos/${agentUserId}/${Date.now()}.mp3`
  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(audioPath, new Uint8Array(ttsRes.data), { contentType: "audio/mpeg", upsert: false })
  if (uploadError) {
    return { success: false, providerKey: "did", error: `Failed to host audio: ${uploadError.message}` }
  }
  const { data: pub } = supabase.storage.from("media").getPublicUrl(audioPath)
  const audioUrl = pub.publicUrl

  // ─── 2. Submit to D-ID ──────────────────────────────────────────────────────
  // driver_expressions controls facial affect — without it the avatar reads
  // monotone, which is the #1 reason talking-head videos feel "uncanny" in
  // real-estate marketing. Default is a warm "happy" at 0.7 intensity (per
  // m112); per-agent override is read from agent_voice_profiles.
  const expression = (didProfile as { default_expression?: string }).default_expression ?? "happy"
  const intensity  = Number((didProfile as { expression_intensity?: number }).expression_intensity ?? 0.7)
  const driverExpressions = {
    expressions: [{ start_frame: 0, expression, intensity }],
  }

  const didPayload = isVideoSource
    ? {
        source_url: sourceUrl,
        script: { type: "audio", audio_url: audioUrl },
        config: { stitch: true, result_format: "mp4", driver_expressions: driverExpressions },
      }
    : {
        source_url: sourceUrl,
        script: { type: "audio", audio_url: audioUrl },
        driver_url: "bank://natural",
        config: { stitch: true, result_format: "mp4", fluent: true, pad_audio: 0.0, driver_expressions: driverExpressions },
      }

  const didRes = await callConnector<{ id?: string }>({
    connector: "did",
    baseUrl: "https://api.d-id.com",
    path: isVideoSource ? "/clips" : "/talks",
    method: "POST",
    auth: { style: "basic", username: didApiKey, password: "" },
    body: didPayload,
  })

  if (!didRes.ok) {
    return { success: false, providerKey: "did", error: `D-ID API error: ${didRes.error ?? `HTTP ${didRes.status}`}` }
  }

  const didData = didRes.data ?? {}

  void logVendorUsage({
    vendorName: "did",
    usageType: "video_renders",
    unitCount: 1,
    estimatedCost: 0.3, // D-ID + ElevenLabs ~$0.30/render combined
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      did_talk_id: didData.id,
      mode: isVideoSource ? "clip" : "talk",
      recipient_email: params.recipientEmail,
      provider_key: "did",
      ...(params.metadata ?? {}),
    },
  })

  return { success: true, providerKey: "did", messageId: didData.id }
}

// ─── HeyGen path (legacy / opt-in) ────────────────────────────────────────────
async function dispatchVideoViaHeyGen({
  params,
  providerKey,
}: {
  params: DispatchVideoParams
  providerKey: string
}): Promise<DispatchResult> {
  const heygenApiKey = process.env.HEYGEN_API_KEY
  if (!heygenApiKey) {
    return {
      success: false,
      providerKey,
      error: "Video provider (HeyGen) not configured. Add HEYGEN_API_KEY to environment variables.",
    }
  }

  const response = await callConnector<{ video_id?: string }>({
    connector: "heygen",
    baseUrl: "https://api.heygen.com",
    path: "/v2/video/generate",
    method: "POST",
    auth: { style: "header", name: "X-Api-Key", value: heygenApiKey },
    body: { template_id: params.templateId, variables: params.scriptVars ?? {} },
  })

  if (!response.ok) {
    return { success: false, providerKey, error: `HeyGen API error: ${response.error ?? `HTTP ${response.status}`}` }
  }

  const data = response.data ?? {}

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "video_renders",
    unitCount: 1,
    estimatedCost: 0.5,
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      heygen_video_id: data.video_id,
      template_id: params.templateId,
      recipient_email: params.recipientEmail,
      provider_key: providerKey,
      ...(params.metadata ?? {}),
    },
  })

  return { success: true, providerKey, messageId: data.video_id }
}
