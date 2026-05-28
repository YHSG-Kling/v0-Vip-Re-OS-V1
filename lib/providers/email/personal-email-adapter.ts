/**
 * lib/providers/email/personal-email-adapter.ts
 *
 * Sends email through the AGENT'S PERSONAL Gmail or Outlook account using
 * their OAuth tokens. Falls through to caller (typically SendGrid) when no
 * personal token is available.
 *
 * Use case: agent-to-contact email should appear to come from the agent's
 * actual mailbox (sarah@kw.com) instead of platform noreply, so contacts
 * can reply naturally and threads stay intact in the agent's mailbox too.
 *
 * Token refresh: each provider's refresh_token is used to mint a new
 * access_token when the cached one is expired. Updated tokens are saved
 * back to agent_api_credentials.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type PersonalProvider = "gmail" | "outlook"

export interface SendPersonalEmailInput {
  agentUserId: string
  to: string
  subject: string
  htmlBody: string
  textBody?: string
  replyToMessageId?: string  // Gmail thread ID or Outlook conversation ID for threading
  cc?: string[]
  bcc?: string[]
}

export interface SendPersonalEmailResult {
  success: boolean
  provider?: PersonalProvider
  messageId?: string
  threadId?: string
  fromAddress?: string
  /** When success=false and reason='no_personal_account', caller should fall back to SendGrid */
  reason?:
    | "no_personal_account"
    | "token_refresh_failed"
    | "send_failed"
    | "invalid_input"
    | "unknown"
  error?: string
}

// ─── Top-level dispatcher ────────────────────────────────────────────────────

/**
 * Try sending via the agent's personal Gmail or Outlook. If neither is
 * connected, returns success: false with reason='no_personal_account' so
 * the caller can fall back to SendGrid.
 */
export async function sendPersonalEmail(
  input: SendPersonalEmailInput
): Promise<SendPersonalEmailResult> {
  if (!input.to || !input.subject || !input.htmlBody) {
    return { success: false, reason: "invalid_input", error: "to/subject/htmlBody required" }
  }

  const cred = await loadActivePersonalCred(input.agentUserId)
  if (!cred) {
    return { success: false, reason: "no_personal_account" }
  }

  // Refresh token if expired
  const accessToken = await ensureFreshAccessToken(cred)
  if (!accessToken) {
    return { success: false, reason: "token_refresh_failed" }
  }

  if (cred.service_name === "gmail") {
    return await sendViaGmail({ accessToken, fromAddress: cred.email, ...input })
  }
  if (cred.service_name === "outlook") {
    return await sendViaOutlook({ accessToken, fromAddress: cred.email, ...input })
  }

  return { success: false, reason: "no_personal_account" }
}

// ─── Credential lookup ───────────────────────────────────────────────────────

/**
 * Shared accessor: resolve a FRESH OAuth access token for the agent's connected
 * Google/Microsoft account (refreshing + persisting if expired). Reused by the
 * calendar provider so calendar + email share ONE token per provider connection.
 */
export async function getFreshPersonalToken(
  agentUserId: string,
): Promise<{ provider: PersonalProvider; accessToken: string; email: string | null } | null> {
  const cred = await loadActivePersonalCred(agentUserId)
  if (!cred) return null
  const accessToken = await ensureFreshAccessToken(cred)
  if (!accessToken) return null
  return { provider: cred.service_name, accessToken, email: cred.email }
}

interface PersonalCred {
  id: string
  service_name: "gmail" | "outlook"
  access_token: string | null
  refresh_token: string | null
  token_expires_at: string | null
  email: string | null
}

async function loadActivePersonalCred(agentUserId: string): Promise<PersonalCred | null> {
  const svc = createServiceClient()

  // First resolve the agent record (agent_api_credentials uses agent_id, not user_id)
  const { data: agent } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", agentUserId)
    .maybeSingle()
  if (!agent?.id) return null

  const { data: creds } = await svc
    .from("agent_api_credentials")
    .select("id, service_name, access_token, refresh_token, token_expires_at, config")
    .eq("agent_id", agent.id)
    .in("service_name", ["gmail", "outlook"])
    .eq("is_active", true)

  if (!creds?.length) return null

  // Prefer Gmail when both exist; agent can disable one if they want a specific path
  const ordered = creds.sort((a: any, b: any) => (a.service_name === "gmail" ? -1 : 1))
  const c: any = ordered[0]
  return {
    id: c.id,
    service_name: c.service_name,
    access_token: c.access_token,
    refresh_token: c.refresh_token,
    token_expires_at: c.token_expires_at,
    email: c.config?.email ?? null,
  }
}

// ─── Token refresh ───────────────────────────────────────────────────────────

async function ensureFreshAccessToken(cred: PersonalCred): Promise<string | null> {
  if (!cred.access_token) return null

  // If token isn't expired (with 60s buffer), return it as-is
  if (cred.token_expires_at) {
    const expiresAt = new Date(cred.token_expires_at).getTime()
    if (expiresAt - Date.now() > 60_000) return cred.access_token
  } else {
    return cred.access_token
  }

  if (!cred.refresh_token) return null

  const refreshed =
    cred.service_name === "gmail"
      ? await refreshGoogle(cred.refresh_token)
      : await refreshMicrosoft(cred.refresh_token)
  if (!refreshed) return null

  // Save back the new token
  const svc = createServiceClient()
  await svc
    .from("agent_api_credentials")
    .update({
      access_token: refreshed.accessToken,
      token_expires_at: new Date(Date.now() + refreshed.expiresInSec * 1000).toISOString(),
    })
    .eq("id", cred.id)

  return refreshed.accessToken
}

async function refreshGoogle(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number } | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return { accessToken: data.access_token, expiresInSec: data.expires_in ?? 3600 }
  } catch {
    return null
  }
}

async function refreshMicrosoft(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number } | null> {
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  try {
    const res = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access",
        }),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    return { accessToken: data.access_token, expiresInSec: data.expires_in ?? 3600 }
  } catch {
    return null
  }
}

// ─── Gmail send (RFC 5322 + base64url) ───────────────────────────────────────

async function sendViaGmail(args: {
  accessToken: string
  fromAddress: string | null
  to: string
  subject: string
  htmlBody: string
  textBody?: string
  cc?: string[]
  bcc?: string[]
  replyToMessageId?: string
}): Promise<SendPersonalEmailResult> {
  const raw = buildRfc5322({
    from: args.fromAddress ?? "me",
    to: args.to,
    subject: args.subject,
    htmlBody: args.htmlBody,
    textBody: args.textBody,
    cc: args.cc,
    bcc: args.bcc,
    inReplyTo: args.replyToMessageId,
  })
  // base64url encode for Gmail API
  const encoded = Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

  try {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: encoded,
        ...(args.replyToMessageId ? { threadId: args.replyToMessageId } : {}),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return {
        success: false,
        provider: "gmail",
        reason: "send_failed",
        error: `Gmail (${res.status}): ${body}`,
      }
    }
    const data = await res.json()
    return {
      success: true,
      provider: "gmail",
      messageId: data.id,
      threadId: data.threadId,
      fromAddress: args.fromAddress ?? undefined,
    }
  } catch (err: any) {
    return { success: false, provider: "gmail", reason: "send_failed", error: err?.message ?? "Network error" }
  }
}

// ─── Outlook send (Microsoft Graph) ──────────────────────────────────────────

async function sendViaOutlook(args: {
  accessToken: string
  fromAddress: string | null
  to: string
  subject: string
  htmlBody: string
  textBody?: string
  cc?: string[]
  bcc?: string[]
  replyToMessageId?: string
}): Promise<SendPersonalEmailResult> {
  const message = {
    subject: args.subject,
    body: { contentType: "HTML", content: args.htmlBody },
    toRecipients: [{ emailAddress: { address: args.to } }],
    ccRecipients: (args.cc ?? []).map((a) => ({ emailAddress: { address: a } })),
    bccRecipients: (args.bcc ?? []).map((a) => ({ emailAddress: { address: a } })),
  }

  try {
    // For replies, use Graph's reply endpoint to keep threading
    if (args.replyToMessageId) {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${args.replyToMessageId}/reply`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message, comment: "" }),
        }
      )
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        return {
          success: false,
          provider: "outlook",
          reason: "send_failed",
          error: `Outlook reply (${res.status}): ${body}`,
        }
      }
      return { success: true, provider: "outlook", fromAddress: args.fromAddress ?? undefined }
    }

    // Regular send
    const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return {
        success: false,
        provider: "outlook",
        reason: "send_failed",
        error: `Outlook (${res.status}): ${body}`,
      }
    }
    return { success: true, provider: "outlook", fromAddress: args.fromAddress ?? undefined }
  } catch (err: any) {
    return { success: false, provider: "outlook", reason: "send_failed", error: err?.message ?? "Network error" }
  }
}

// ─── RFC 5322 message builder (used by Gmail) ────────────────────────────────

function buildRfc5322(args: {
  from: string
  to: string
  subject: string
  htmlBody: string
  textBody?: string
  cc?: string[]
  bcc?: string[]
  inReplyTo?: string
}): string {
  const boundary = `--vip${Date.now().toString(36)}`
  const headers: string[] = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodeRfc2047(args.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  if (args.cc?.length) headers.push(`Cc: ${args.cc.join(", ")}`)
  if (args.bcc?.length) headers.push(`Bcc: ${args.bcc.join(", ")}`)
  if (args.inReplyTo) headers.push(`In-Reply-To: <${args.inReplyTo}>`)

  const text = args.textBody ?? stripHtml(args.htmlBody)
  const body = [
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    args.htmlBody,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n")

  return headers.join("\r\n") + "\r\n" + body
}

function encodeRfc2047(s: string): string {
  // Encode subject lines containing non-ASCII characters
  if (/^[\x20-\x7E]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
