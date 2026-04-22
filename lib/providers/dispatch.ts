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

import { resolveProvider } from "@/lib/kernel/providers"
import {
  sendEmail as messagingSendEmail,
  sendSMS as messagingSendSMS,
  placeCall as messagingPlaceCall,
} from "@/lib/providers/messaging"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { assembleEmail } from "@/lib/kernel/communications/assemble-email"
import { evaluateOutboundCompliance } from "@/lib/kernel/communication-compliance"
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

export interface DispatchDirectMailParams extends DispatchActorContext {
  recipientName: string
  mailingAddress: string
  mailingAddress2?: string
  city: string
  state: string
  zip: string
  templateId: string
  mergeVars?: Record<string, string>
  metadata?: Record<string, unknown>
}

export async function dispatchDirectMail(
  params: DispatchDirectMailParams
): Promise<DispatchResult> {
  const { providerKey } = await resolveProvider({
    providerType: "direct_mail",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })
  // providerKey will always be 'lob' until a superadmin override exists

  // NOTE: Lob API integration is intentionally stubbed here.
  // Feature code calls dispatchDirectMail — the provider stub throws if Lob keys
  // are not configured, keeping the contract clean without hardcoding in feature code.
  const lobApiKey = process.env.LOB_API_KEY
  if (!lobApiKey) {
    const result: DispatchResult = {
      success: false,
      providerKey,
      error: "Direct mail provider (Lob) not configured. Add LOB_API_KEY to environment variables.",
    }
    return result
  }

  // Lob Letters API — stub implementation (to be fleshed out when Lob is live)
  const response = await fetch("https://api.lob.com/v1/letters", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${lobApiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: {
        name: params.recipientName,
        address_line1: params.mailingAddress,
        ...(params.mailingAddress2 ? { address_line2: params.mailingAddress2 } : {}),
        address_city: params.city,
        address_state: params.state,
        address_zip: params.zip,
        address_country: "US",
      },
      from: process.env.LOB_RETURN_ADDRESS_ID ?? undefined,
      file: params.templateId,
      merge_variables: params.mergeVars ?? {},
      color: false,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    return { success: false, providerKey, error: `Lob API error: ${body}` }
  }

  const data = (await response.json()) as { id?: string }

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "pieces_mailed",
    unitCount: 1,
    estimatedCost: 1.2, // Lob letter ~$1.20/piece
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      lob_letter_id: data.id,
      template_id: params.templateId,
      provider_key: providerKey,
      ...(params.metadata ?? {}),
    },
  })

  return { success: true, providerKey, messageId: data.id }
}

// ─── VIDEO (superadmin-controlled, system-only) ───────────────────────────────
// video is SYSTEM_ONLY — resolveProvider always returns 'heygen'.

export interface DispatchVideoParams extends DispatchActorContext {
  /** HeyGen template / avatar ID */
  templateId: string
  recipientEmail: string
  recipientName?: string
  scriptVars?: Record<string, string>
  metadata?: Record<string, unknown>
}

export async function dispatchVideo(params: DispatchVideoParams): Promise<DispatchResult> {
  const { providerKey } = await resolveProvider({
    providerType: "video",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })
  // providerKey will always be 'heygen' until a superadmin override exists

  const heygenApiKey = process.env.HEYGEN_API_KEY
  if (!heygenApiKey) {
    return {
      success: false,
      providerKey,
      error: "Video provider (HeyGen) not configured. Add HEYGEN_API_KEY to environment variables.",
    }
  }

  // HeyGen Video Generation API
  const response = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": heygenApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template_id: params.templateId,
      variables: params.scriptVars ?? {},
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    return { success: false, providerKey, error: `HeyGen API error: ${body}` }
  }

  const data = (await response.json()) as { video_id?: string }

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "video_renders",
    unitCount: 1,
    estimatedCost: 0.5, // HeyGen ~$0.50/render estimate
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
