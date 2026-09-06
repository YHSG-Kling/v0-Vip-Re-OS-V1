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
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { decryptSecret } from "@/lib/security/secret-crypto"
import { googleOAuthClient, microsoftOAuthClient } from "@/lib/env/aliases"

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
  /** When set, send from this OWNER's connected mailbox (vendor/contact/team/brokerage) instead of
   *  resolving the agent's personal account by agentUserId. */
  owner?: EmailOwner
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

  const cred = input.owner
    ? await loadOwnerEmailCred(input.owner)
    : await loadActivePersonalCred(input.agentUserId)
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
  owner?: EmailOwner,
): Promise<{ provider: PersonalProvider; accessToken: string; email: string | null } | null> {
  const cred = owner ? await loadOwnerEmailCred(owner) : await loadActivePersonalCred(agentUserId)
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
  /** Which table the cred came from — token refresh writes back to the same place. */
  source: "agent_api_credentials" | "platform_credentials"
}

/** An owner scope (vendor/contact/agent/team/brokerage) whose connected mailbox to use. */
export type EmailOwner = { ownerType: string; ownerId: string }

async function loadActivePersonalCred(agentUserId: string): Promise<PersonalCred | null> {
  const svc = createServiceClient()

  // Agent path: agent_api_credentials uses agent_id, not user_id.
  const { data: agent } = await svc.from("agents").select("id").eq("user_id", agentUserId).maybeSingle()
  if (agent?.id) {
    const { data: creds } = await svc
      .from("agent_api_credentials")
      .select("id, service_name, access_token, refresh_token, token_expires_at, config")
      .eq("agent_id", agent.id)
      .in("service_name", ["gmail", "outlook"])
      .eq("is_active", true)
    if (creds?.length) {
      const ordered = creds.sort((a: any, b: any) => (a.service_name === "gmail" ? -1 : 1))
      const c: any = ordered[0]
      // decryptSecret is backward-compatible: a plaintext token passes through unchanged, an
      // at-rest-encrypted token is transparently decrypted — so this read is safe before/after
      // the credential-encryption rollout (lib/security/secret-crypto.ts).
      return { id: c.id, service_name: c.service_name, access_token: decryptSecret(c.access_token), refresh_token: decryptSecret(c.refresh_token), token_expires_at: c.token_expires_at, email: c.config?.email ?? null, source: "agent_api_credentials" }
    }
  }

  // Fallback: owner-scoped mailbox stored in platform_credentials at AGENT scope (owner_id = userId).
  return loadOwnerEmailCred({ ownerType: "agent", ownerId: agentUserId })
}

/**
 * Owner-scoped mailbox loader — reads the connected gmail/outlook from platform_credentials by
 * (owner_type, owner_id). This is what lets a VENDOR or CONTACT (no agents row) use their OWN
 * connected mailbox; agent/team/brokerage owner scopes resolve here too.
 */
export async function loadOwnerEmailCred(owner: EmailOwner): Promise<PersonalCred | null> {
  const svc = createServiceClient()
  const { data: rows } = await svc
    .from("platform_credentials")
    .select("id, platform, access_token, refresh_token, token_expires_at, config")
    .eq("owner_type", owner.ownerType)
    .eq("owner_id", owner.ownerId)
    .in("platform", ["gmail", "outlook"])
    .eq("is_active", true)
  if (!rows?.length) return null
  const ordered = rows.sort((a: any, b: any) => (a.platform === "gmail" ? -1 : 1))
  const c: any = ordered[0]
  return {
    id: c.id,
    service_name: c.platform,
    access_token: c.access_token,
    refresh_token: c.refresh_token,
    token_expires_at: c.token_expires_at,
    email: (c.config?.email as string) ?? null,
    source: "platform_credentials",
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

  // Save the new token back to whichever table the cred came from.
  const svc = createServiceClient()
  await svc
    .from(cred.source)
    .update({
      access_token: refreshed.accessToken,
      token_expires_at: new Date(Date.now() + refreshed.expiresInSec * 1000).toISOString(),
    })
    .eq("id", cred.id)

  return refreshed.accessToken
}

async function refreshGoogle(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number } | null> {
  // ONE SPELLING (§6): GOOGLE_CLIENT_ID/SECRET via lib/env/aliases.ts.
  const { clientId, clientSecret } = googleOAuthClient()
  if (!clientId || !clientSecret) return null

  const res = await callConnector<{ access_token?: string; expires_in?: number }>({
    connector: "google-oauth", baseUrl: "https://oauth2.googleapis.com", path: "/token", method: "POST",
    auth: { style: "none" }, bodyType: "form",
    body: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
  })
  if (!res.ok || !res.data?.access_token) return null
  return { accessToken: res.data.access_token, expiresInSec: res.data.expires_in ?? 3600 }
}

// ── THE MICROSOFT REFRESH SCOPE, AND WHY IT IS TWO STRINGS AND NOT ONE ────────────────────
// Microsoft NARROWS a refreshed access token to the scopes REQUESTED at the token endpoint —
// unlike Google, whose refresh (refreshGoogle above) sends no `scope` at all and therefore
// returns the full consented set. This function requested Mail.Send + Mail.ReadWrite only, so
// every refreshed Microsoft token silently LOST Calendars.ReadWrite even though the consent
// granted it (app/api/integrations/oauth/[provider]/route.ts:62-68 requests offline_access,
// User.Read, Calendars.ReadWrite, Mail.Send, Mail.ReadWrite).
//
// The consequence was invisible because the FIRST token — the one minted by the OAuth callback
// — does carry calendar scope: an Outlook calendar write worked for about an hour after
// connecting and returned 403 from then on, for the whole life of the connection. Two live
// callers were affected: lib/providers/calendar/personal-calendar.ts (Graph /me/events for
// per-agent bookings) and, as of w27, lib/providers/calendar/outlook-calendar-sync-adapter.ts.
//
// FIXED BY WIDENING, WITH A FALLBACK RATHER THAN A BET. Asking for a scope that was never
// consented makes Microsoft refuse the ENTIRE token request (AADSTS65001), which would turn a
// degraded calendar into a dead MAILBOX for any connection made before Calendars.ReadWrite
// joined the consent list. So the wide request is tried first and the historical mail-only
// request is the fallback: a modern connection gains calendar scope, a legacy one behaves
// exactly as it did before, and neither can be broken by this change.
const MS_REFRESH_SCOPES_WITH_CALENDAR =
  "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite"
const MS_REFRESH_SCOPES_MAIL_ONLY =
  "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite"

async function refreshMicrosoft(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number } | null> {
  const { clientId, clientSecret } = microsoftOAuthClient()
  if (!clientId || !clientSecret) return null

  const attempt = async (scope: string) => {
    const res = await callConnector<{ access_token?: string; expires_in?: number }>({
      connector: "microsoft-oauth", baseUrl: "https://login.microsoftonline.com",
      path: "/common/oauth2/v2.0/token", method: "POST",
      auth: { style: "none" }, bodyType: "form",
      body: {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      },
    })
    // callConnector resolves refusals rather than throwing, so the result is read, not assumed.
    if (!res.ok || !res.data?.access_token) return null
    return { accessToken: res.data.access_token, expiresInSec: res.data.expires_in ?? 3600 }
  }

  return (await attempt(MS_REFRESH_SCOPES_WITH_CALENDAR)) ?? (await attempt(MS_REFRESH_SCOPES_MAIL_ONLY))
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

  const res = await callConnector<{ id?: string; threadId?: string }>({
    connector: "gmail", baseUrl: "https://gmail.googleapis.com", path: "/gmail/v1/users/me/messages/send", method: "POST",
    auth: { style: "bearer", token: args.accessToken },
    body: {
      raw: encoded,
      ...(args.replyToMessageId ? { threadId: args.replyToMessageId } : {}),
    },
  })
  if (!res.ok) {
    return {
      success: false,
      provider: "gmail",
      reason: "send_failed",
      error: `Gmail (${res.status}): ${res.error ?? ""}`,
    }
  }
  return {
    success: true,
    provider: "gmail",
    messageId: res.data?.id,
    threadId: res.data?.threadId,
    fromAddress: args.fromAddress ?? undefined,
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

  // For replies, use Graph's reply endpoint to keep threading
  if (args.replyToMessageId) {
    const res = await callConnector({
      connector: "outlook", baseUrl: "https://graph.microsoft.com",
      path: `/v1.0/me/messages/${args.replyToMessageId}/reply`, method: "POST",
      auth: { style: "bearer", token: args.accessToken },
      body: { message, comment: "" },
    })
    if (!res.ok) {
      return {
        success: false,
        provider: "outlook",
        reason: "send_failed",
        error: `Outlook reply (${res.status}): ${res.error ?? ""}`,
      }
    }
    return { success: true, provider: "outlook", fromAddress: args.fromAddress ?? undefined }
  }

  // Regular send
  const res = await callConnector({
    connector: "outlook", baseUrl: "https://graph.microsoft.com", path: "/v1.0/me/sendMail", method: "POST",
    auth: { style: "bearer", token: args.accessToken },
    body: { message, saveToSentItems: true },
  })
  if (!res.ok) {
    return {
      success: false,
      provider: "outlook",
      reason: "send_failed",
      error: `Outlook (${res.status}): ${res.error ?? ""}`,
    }
  }
  return { success: true, provider: "outlook", fromAddress: args.fromAddress ?? undefined }
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
