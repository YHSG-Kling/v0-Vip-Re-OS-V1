/**
 * SMS provider adapters — real HTTP implementations for the providers a
 * brokerage can select. NO stubs: each adapter either talks to its real API
 * or returns a configuration error pointing the admin at Settings.
 *
 * Adapters share a uniform interface so sendSMS() can swap them based on
 * the brokerage's provider_overrides + platform_credentials.
 */

import "server-only"

export interface SMSAdapterResult {
  success: boolean
  messageId?: string
  status?: string
  error?: string
  /** Provider name that handled the send. */
  provider: string
}

export interface SMSAdapterInput {
  to:      string
  from?:   string   // overrides default sender (e.g. brokerage-specific shortcode)
  message: string
}

export interface SMSProviderCredentials {
  /** Twilio: ACCOUNT_SID / Telnyx: API_KEY / Bandwidth: ACCOUNT_ID */
  apiKey:        string
  /** Twilio: AUTH_TOKEN / Telnyx: (unused) / Bandwidth: API_USERNAME */
  apiSecret?:    string
  /** Default From number for this credential. */
  fromNumber?:   string
  /** Provider-specific extras stored in platform_credentials.config */
  config?:       Record<string, unknown>
}

// ─── TWILIO ──────────────────────────────────────────────────────────────────

export async function sendViaTwilio(
  input: SMSAdapterInput,
  creds: SMSProviderCredentials,
): Promise<SMSAdapterResult> {
  const accountSid = creds.apiKey
  const authToken  = creds.apiSecret
  const fromNumber = input.from ?? creds.fromNumber

  if (!accountSid || !authToken || !fromNumber) {
    return {
      success: false,
      provider: "twilio",
      error: "Twilio credentials incomplete. Set Account SID, Auth Token, and From number in Settings → Integrations.",
    }
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: input.to,
        From: fromNumber,
        Body: input.message,
      }),
    }
  )
  const data = await res.json()
  if (!res.ok) {
    return { success: false, provider: "twilio", error: data.message ?? `Twilio API error (${res.status})` }
  }
  return { success: true, provider: "twilio", messageId: data.sid, status: data.status }
}

// ─── TELNYX ──────────────────────────────────────────────────────────────────

export async function sendViaTelnyx(
  input: SMSAdapterInput,
  creds: SMSProviderCredentials,
): Promise<SMSAdapterResult> {
  const apiKey         = creds.apiKey
  const fromNumber     = input.from ?? creds.fromNumber
  const messagingProfileId = (creds.config?.messaging_profile_id as string | undefined)

  if (!apiKey || (!fromNumber && !messagingProfileId)) {
    return {
      success: false,
      provider: "telnyx",
      error: "Telnyx credentials incomplete. Set API key and either a From number or Messaging Profile ID in Settings → Integrations.",
    }
  }

  const body: Record<string, unknown> = {
    to:   input.to,
    text: input.message,
  }
  if (fromNumber)         body.from = fromNumber
  if (messagingProfileId) body.messaging_profile_id = messagingProfileId

  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    return { success: false, provider: "telnyx", error: data?.errors?.[0]?.detail ?? `Telnyx API error (${res.status})` }
  }
  return {
    success: true,
    provider: "telnyx",
    messageId: data?.data?.id,
    status:    data?.data?.status,
  }
}

// ─── BANDWIDTH ───────────────────────────────────────────────────────────────

export async function sendViaBandwidth(
  input: SMSAdapterInput,
  creds: SMSProviderCredentials,
): Promise<SMSAdapterResult> {
  const accountId   = creds.apiKey                                         // Bandwidth Account ID
  const username    = (creds.config?.api_username as string | undefined)   // API user (separate from account)
  const password    = creds.apiSecret                                      // API password
  const applicationId = (creds.config?.application_id as string | undefined)
  const fromNumber  = input.from ?? creds.fromNumber

  if (!accountId || !username || !password || !applicationId || !fromNumber) {
    return {
      success: false,
      provider: "bandwidth",
      error: "Bandwidth credentials incomplete. Set Account ID, API user/password, Application ID, and From number in Settings → Integrations.",
    }
  }

  const res = await fetch(
    `https://messaging.bandwidth.com/api/v2/users/${accountId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        applicationId,
        to: [input.to],
        from: fromNumber,
        text: input.message,
      }),
    }
  )
  const data = await res.json()
  if (!res.ok) {
    return { success: false, provider: "bandwidth", error: data?.message ?? `Bandwidth API error (${res.status})` }
  }
  return {
    success: true,
    provider: "bandwidth",
    messageId: data?.id,
    status:    "queued",
  }
}

// ─── ADAPTER REGISTRY ────────────────────────────────────────────────────────

export type SupportedSMSProvider = "twilio" | "telnyx" | "bandwidth"

export const SMS_ADAPTERS: Record<
  SupportedSMSProvider,
  (input: SMSAdapterInput, creds: SMSProviderCredentials) => Promise<SMSAdapterResult>
> = {
  twilio:    sendViaTwilio,
  telnyx:    sendViaTelnyx,
  bandwidth: sendViaBandwidth,
}

export function isSupportedSMSProvider(name: string): name is SupportedSMSProvider {
  return name in SMS_ADAPTERS
}
