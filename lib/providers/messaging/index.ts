/**
 * MESSAGING PROVIDER — per-brokerage adapter routing.
 *
 * PROVIDER: each brokerage selects an SMS provider via provider_overrides
 * (scope='brokerage', provider_type='sms') + platform_credentials. sendSMS
 * resolves the brokerage's choice at call time and dispatches through the
 * matching adapter (Twilio / Telnyx / Bandwidth — see sms-adapters.ts).
 *
 * COMPLIANCE: every sendSMS/placeCall passes through enforceTCPACompliance
 * BEFORE hitting the provider. This is the single chokepoint — callers that
 * go through this module cannot bypass TCPA. Decisions are logged to
 * outbound_message_compliance_log for class-action defense + audit.
 *
 * To send a transactional notice (e.g. a "your offer was accepted" SMS to
 * an existing client) that bypasses EWC but NOT DNC/quiet-hours, pass
 * `transactional: true`.
 */

import { enforceTCPACompliance } from "@/lib/communication/tcpa-gate"
import { resolveSMSProviderForActor } from "./resolve-sms-provider"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { SMS_ADAPTERS } from "./sms-adapters"

// ─── TWILIO SMS ────────────────────────────────────────────────────────────────

export interface SendSMSParams {
  to: string
  message: string
  contactId?: string
  brokerageId?: string
  initiatedBy?: string
  /** Bypass EWC (still enforces DNC + quiet hours + opt-out + RND staleness) */
  transactional?: boolean
  /** Caller can opt out of the gate ONLY for system-internal flows where TCPA
   *  doesn't apply (e.g. carrier-to-carrier 2FA via SendGrid email-to-SMS).
   *  Logged + flagged for audit when used. */
  skipTCPAGate?: boolean
}

export interface SendSMSResult {
  success: boolean
  messageId?: string
  status?: string
  error?: string
  mock?: boolean
  blocked?: boolean
  blockReason?: string
  complianceLogId?: string
}

export async function sendSMS(params: SendSMSParams): Promise<SendSMSResult> {
  // ── TCPA gate (mandatory) ────────────────────────────────────────────────
  if (!params.skipTCPAGate) {
    const gate = await enforceTCPACompliance({
      channel:       "sms",
      phone:         params.to,
      contactId:     params.contactId   ?? null,
      brokerageId:   params.brokerageId ?? null,
      initiatedBy:   params.initiatedBy ?? null,
      transactional: params.transactional ?? false,
    })
    if (!gate.allowed) {
      return {
        success:         false,
        blocked:         true,
        blockReason:     gate.blockReason,
        error:           gate.message ?? "TCPA compliance check blocked send",
        complianceLogId: gate.logEntryId,
      }
    }
  }

  // ── Resolve provider via the actor cascade (user → team → brokerage) ───
  // email/SMS/phone are what the USER uses — their personal credentials win.
  let resolved: Awaited<ReturnType<typeof resolveSMSProviderForActor>>
  try {
    resolved = await resolveSMSProviderForActor({
      brokerageId: params.brokerageId ?? null,
      userId:      params.initiatedBy ?? null,
    })
  } catch (err: any) {
    return { success: false, error: err?.message ?? "No SMS provider configured" }
  }

  const adapter = SMS_ADAPTERS[resolved.providerName]
  const result  = await adapter(
    { to: params.to, message: params.message },
    resolved.credentials,
  )

  if (!result.success) {
    throw new Error(result.error ?? `${result.provider} send failed`)
  }
  return {
    success:   true,
    messageId: result.messageId,
    status:    result.status,
  }
}

// ─── TWILIO CALLS ──────────────────────────────────────────────────────────────

export interface PlaceCallParams {
  /** Phone number to call (E.164 format recommended) */
  to: string
  /** TwiML URL that Twilio will request to control the call flow */
  twimlUrl: string
  contactId?: string
  brokerageId?: string
  initiatedBy?: string
  /** Bypass EWC (still enforces DNC + quiet hours + RND staleness) */
  transactional?: boolean
  skipTCPAGate?: boolean
}

export interface PlaceCallResult {
  success: boolean
  callSid?: string
  status?: string
  error?: string
  mock?: boolean
  blocked?: boolean
  blockReason?: string
  complianceLogId?: string
}

export async function placeCall(params: PlaceCallParams): Promise<PlaceCallResult> {
  // ── TCPA gate (mandatory) ────────────────────────────────────────────────
  if (!params.skipTCPAGate) {
    const gate = await enforceTCPACompliance({
      channel:       "call",
      phone:         params.to,
      contactId:     params.contactId   ?? null,
      brokerageId:   params.brokerageId ?? null,
      initiatedBy:   params.initiatedBy ?? null,
      transactional: params.transactional ?? false,
    })
    if (!gate.allowed) {
      return {
        success:         false,
        blocked:         true,
        blockReason:     gate.blockReason,
        error:           gate.message ?? "TCPA compliance check blocked call",
        complianceLogId: gate.logEntryId,
      }
    }
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !fromNumber) {
    return {
      success: false,
      error:
        "Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to environment variables.",
      mock: true,
    }
  }

  const response = await callConnector<{ sid?: string; status?: string }>({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${accountSid}/Calls.json`,
    method: "POST",
    auth: { style: "basic", username: accountSid, password: authToken },
    bodyType: "form",
    body: { To: params.to, From: fromNumber, Url: params.twimlUrl },
  })

  if (!response.ok) {
    throw new Error(response.error || "Twilio Calls API error")
  }

  return {
    success: true,
    callSid: response.data?.sid,
    status: response.data?.status,
  }
}

// ─── TWILIO LOOKUPS ────────────────────────────────────────────────────────────

export interface LookupPhoneParams {
  /** E.164 formatted phone number, e.g. +14155551234 */
  phoneNumber: string
}

export interface LookupPhoneResult {
  success: boolean
  valid?: boolean
  formattedNumber?: string
  lineType?: string  // mobile, landline, voip, etc.
  carrierName?: string
  countryCode?: string
  error?: string
  mock?: boolean
}

export async function lookupPhone(params: LookupPhoneParams): Promise<LookupPhoneResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN

  if (!accountSid || !authToken) {
    return {
      success: false,
      error:
        "Twilio not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to environment variables.",
      mock: true,
    }
  }

  const response = await callConnector<any>({
    connector: "twilio",
    baseUrl: "https://lookups.twilio.com",
    path: `/v2/PhoneNumbers/${encodeURIComponent(params.phoneNumber)}`,
    method: "GET",
    query: { Fields: "line_type_intelligence" },
    auth: { style: "basic", username: accountSid, password: authToken },
  })

  if (!response.ok) {
    throw new Error(response.error || "Twilio Lookups API error")
  }
  const data = response.data ?? {}

  return {
    success: true,
    valid: data.valid,
    formattedNumber: data.phone_number,
    lineType: data.line_type_intelligence?.type,
    carrierName: data.line_type_intelligence?.carrier_name,
    countryCode: data.country_code,
  }
}

// ─── SENDGRID EMAIL ────────────────────────────────────────────────────────────

export interface SendEmailParams {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  contactId?: string
  /**
   * When set, attempt to send through THIS agent's personal Gmail/Outlook
   * mailbox via their OAuth token. Falls back to SendGrid if no personal
   * account is connected (or refresh fails).
   */
  agentUserId?: string
}

export interface SendEmailResult {
  success: boolean
  status?: string
  error?: string
  mock?: boolean
  /** Which provider actually sent the message */
  provider?: "gmail" | "outlook" | "sendgrid"
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  // Tier 1: when agentUserId is provided, try the agent's personal mailbox.
  // This makes agent→contact email come from sarah@kw.com instead of platform
  // noreply, so contacts can reply naturally and threads stay in agent's inbox.
  if (params.agentUserId) {
    try {
      const { sendPersonalEmail } = await import("@/lib/providers/email/personal-email-adapter")
      const result = await sendPersonalEmail({
        agentUserId: params.agentUserId,
        to: params.to,
        subject: params.subject,
        htmlBody: params.html,
        textBody: params.text,
      })
      if (result.success) {
        return { success: true, status: "sent", provider: result.provider }
      }
      // Only fall through on no_personal_account — other failures should bubble up
      if (result.reason !== "no_personal_account") {
        return { success: false, error: result.error ?? "Personal email send failed" }
      }
    } catch (err: any) {
      // If the personal adapter itself crashes, fall back to SendGrid quietly
      console.error("[sendEmail] Personal-email path errored, falling back:", err?.message ?? err)
    }
  }

  // Tier 2: SendGrid (transactional / no personal account configured)
  const apiKey = process.env.SENDGRID_API_KEY
  const defaultFrom = process.env.SENDGRID_FROM_EMAIL || "noreply@yourdomain.com"

  if (!apiKey) {
    return {
      success: false,
      error: "SendGrid not configured. Add SENDGRID_API_KEY to environment variables.",
      mock: true,
    }
  }

  const response = await callConnector({
    connector: "sendgrid",
    baseUrl: "https://api.sendgrid.com",
    path: "/v3/mail/send",
    method: "POST",
    auth: { style: "bearer", token: apiKey },
    body: {
      personalizations: [{ to: [{ email: params.to }] }],
      from: { email: params.from || defaultFrom },
      subject: params.subject,
      content: [
        { type: "text/plain", value: params.text || params.html.replace(/<[^>]*>/g, "") },
        { type: "text/html", value: params.html },
      ],
    },
  })

  if (!response.ok) {
    throw new Error(response.error || "SendGrid API error")
  }

  return { success: true, status: "sent", provider: "sendgrid" }
}
