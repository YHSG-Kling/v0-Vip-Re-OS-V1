/**
 * SMS provider adapters — real HTTP implementations for the providers a
 * brokerage can select. NO stubs: each adapter either talks to its real API
 * or returns a configuration error pointing the admin at Settings.
 *
 * Adapters share a uniform interface so sendSMS() can swap them based on
 * the brokerage's provider_overrides + platform_credentials.
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

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

  const res = await callConnector<{ sid?: string; status?: string }>({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
    method: "POST",
    auth: { style: "basic", username: accountSid, password: authToken },
    bodyType: "form",
    body: { To: input.to, From: fromNumber, Body: input.message },
  })
  if (!res.ok) {
    return { success: false, provider: "twilio", error: res.error ?? `Twilio API error (${res.status})` }
  }
  return { success: true, provider: "twilio", messageId: res.data?.sid, status: res.data?.status }
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

  const res = await callConnector<{ data?: { id?: string; status?: string } }>({
    connector: "telnyx",
    baseUrl: "https://api.telnyx.com",
    path: "/v2/messages",
    method: "POST",
    auth: { style: "bearer", token: apiKey },
    body,
  })
  if (!res.ok) {
    return { success: false, provider: "telnyx", error: res.error ?? `Telnyx API error (${res.status})` }
  }
  return {
    success: true,
    provider: "telnyx",
    messageId: res.data?.data?.id,
    status:    res.data?.data?.status,
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

  const res = await callConnector<{ id?: string }>({
    connector: "bandwidth",
    baseUrl: "https://messaging.bandwidth.com",
    path: `/api/v2/users/${accountId}/messages`,
    method: "POST",
    auth: { style: "basic", username, password },
    body: {
      applicationId,
      to: [input.to],
      from: fromNumber,
      text: input.message,
    },
  })
  if (!res.ok) {
    return { success: false, provider: "bandwidth", error: res.error ?? `Bandwidth API error (${res.status})` }
  }
  return {
    success: true,
    provider: "bandwidth",
    messageId: res.data?.id,
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
