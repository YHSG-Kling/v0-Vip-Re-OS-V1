/**
 * lib/inbound-mail/oauth-fetchers.ts
 *
 * Gmail + Outlook inbound fetchers. These providers don't send the email
 * payload to your webhook (the way Postmark/SendGrid/Mailgun/Resend do).
 * Instead:
 *
 *   Gmail (per-user OAuth + Pub/Sub):
 *     - User authorizes via Google OAuth (gmail.readonly scope).
 *     - We register a Gmail "watch" on their inbox pointing at a Pub/Sub topic.
 *     - When mail arrives, Gmail publishes a notification containing the
 *       user's email + the historyId.
 *     - Our webhook gets the Pub/Sub push → we look up the user's stored
 *       OAuth tokens → call gmail/users.history.list since historyId →
 *       for each new message, fetch attachments and route through
 *       uploadDocument.
 *
 *   Outlook (per-user Microsoft Graph):
 *     - User authorizes via Microsoft Graph OAuth (Mail.Read scope).
 *     - We POST /subscriptions { resource: /me/mailFolders/Inbox/messages,
 *       changeType: created, notificationUrl: /api/webhooks/inbound-mail,
 *       clientState: <random UUID we keep> }.
 *     - When mail arrives, Graph POSTs us a notification with the
 *       subscription id + clientState + resource path.
 *     - We validate clientState matches the credential we stored, fetch
 *       the message + attachments via Graph API.
 *
 * Token storage: platform_credentials carries:
 *   - access_token   (Gmail/Outlook OAuth access token)
 *   - refresh_token  (long-lived refresh — exchange when access expires)
 *   - token_expires_at  (timestamp; if past, refresh first)
 *   - account_id     (the user's email — what we matched on)
 *   - config         (jsonb: gmail history_id / outlook subscription_id /
 *                     subscription_expires_at / subscription_client_state)
 *
 * This file ONLY makes the network calls — it doesn't handle the consent
 * flow / subscription-create flow (those live in
 * app/api/integrations/oauth/[provider] alongside the rest of the OAuth
 * onboarding). When a brokerage admin wires Gmail/Outlook in Settings →
 * Integrations, that flow stores the tokens + sets the watch/subscription.
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import type { ParsedInboundEmail, InboundAttachment } from "./providers"
import type { ResolvedInboundProvider } from "./resolve-user-provider"
import { googleOAuthClient, microsoftOAuthClient } from "@/lib/env/aliases"

// ─── Token refresh ──────────────────────────────────────────────────────────

async function refreshGmailToken(credential: ResolvedInboundProvider): Promise<string | null> {
  const refreshToken = credential.refresh_token
  if (!refreshToken) return null
  // ONE SPELLING (§6): GOOGLE_CLIENT_ID/SECRET via lib/env/aliases.ts.
  const { clientId, clientSecret } = googleOAuthClient()
  if (!clientId || !clientSecret) return null

  const res = await callConnector<{ access_token?: string }>({
    connector: "google-oauth", baseUrl: "https://oauth2.googleapis.com", path: "/token", method: "POST",
    auth: { style: "none" }, bodyType: "form",
    body: {
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    },
  })
  if (!res.ok) return null
  return res.data?.access_token ?? null
}

async function refreshOutlookToken(credential: ResolvedInboundProvider): Promise<string | null> {
  const refreshToken = credential.refresh_token
  if (!refreshToken) return null
  const { clientId, clientSecret } = microsoftOAuthClient()
  const tenantId     = process.env.MICROSOFT_TENANT_ID ?? "common"
  if (!clientId || !clientSecret) return null

  const res = await callConnector<{ access_token?: string }>({
    connector: "microsoft-oauth", baseUrl: "https://login.microsoftonline.com",
    path: `/${tenantId}/oauth2/v2.0/token`, method: "POST",
    auth: { style: "none" }, bodyType: "form",
    body: {
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
      scope:         "https://graph.microsoft.com/Mail.Read offline_access",
    },
  })
  if (!res.ok) return null
  return res.data?.access_token ?? null
}

// ─── Gmail fetcher ──────────────────────────────────────────────────────────

/**
 * Pull new messages from the user's Gmail since the previously-stored
 * historyId. The Pub/Sub notification gives us the user's email + the
 * NEW historyId — we list all changes since the PREVIOUS historyId
 * (stored in credential.config.history_id), then fetch each new message
 * with attachments.
 */
export async function fetchGmailMessagesSinceHistory(params: {
  credential: ResolvedInboundProvider
  newHistoryId: string
}): Promise<ParsedInboundEmail[]> {
  let maybeToken = params.credential.access_token
  if (!maybeToken) maybeToken = await refreshGmailToken(params.credential)
  if (!maybeToken) return []
  const token: string = maybeToken

  const lastHistoryId = (params.credential.config as any)?.history_id ?? null

  // 1) List history since the last seen id
  const historyRes = await callConnector<{ history?: any[] }>({
    connector: "gmail", baseUrl: "https://gmail.googleapis.com", path: "/gmail/v1/users/me/history", method: "GET",
    query: { historyTypes: "messageAdded", ...(lastHistoryId ? { startHistoryId: String(lastHistoryId) } : {}) },
    auth: { style: "bearer", token },
  })
  if (!historyRes.ok) return []
  const history = historyRes.data ?? {}
  const messageIds: string[] = []
  for (const h of history.history ?? []) {
    for (const m of (h.messagesAdded ?? [])) {
      if (m.message?.id) messageIds.push(m.message.id)
    }
  }
  if (messageIds.length === 0) return []

  const emails: ParsedInboundEmail[] = []
  for (const id of messageIds) {
    const msgRes = await callConnector<any>({
      connector: "gmail", baseUrl: "https://gmail.googleapis.com", path: `/gmail/v1/users/me/messages/${id}`, method: "GET",
      query: { format: "full" }, auth: { style: "bearer", token },
    })
    if (!msgRes.ok) continue
    const msg = msgRes.data ?? {}
    const headers = new Map<string, string>(
      (msg.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), String(h.value)]),
    )
    const fromEmail = extractEmail(headers.get("from") ?? "")
    const toEmail   = extractEmail(headers.get("to")   ?? "")
    const subject   = headers.get("subject") ?? ""

    // Collect attachments + their bytes
    const attachments: InboundAttachment[] = []
    async function walk(part: any) {
      if (!part) return
      if (part.filename && part.body?.attachmentId) {
        const attRes = await callConnector<{ data?: string }>({
          connector: "gmail", baseUrl: "https://gmail.googleapis.com",
          path: `/gmail/v1/users/me/messages/${id}/attachments/${part.body.attachmentId}`, method: "GET",
          auth: { style: "bearer", token },
        })
        if (attRes.ok) {
          const a = attRes.data ?? {}
          attachments.push({
            fileName:   part.filename,
            mime:       part.mimeType ?? "application/octet-stream",
            contentB64: (a.data ?? "").replace(/-/g, "+").replace(/_/g, "/"),  // urlsafe → base64
          })
        }
      }
      for (const sub of (part.parts ?? [])) await walk(sub)
    }
    await walk(msg.payload)

    emails.push({
      provider:   "gmail",
      fromEmail,
      toEmail,
      subject,
      bodyText:   (msg.snippet ?? "").toString(),
      attachments,
    })
  }

  return emails
}

// ─── Outlook fetcher ────────────────────────────────────────────────────────

export async function fetchOutlookMessage(params: {
  credential:    ResolvedInboundProvider
  resourceUrl:   string   // e.g. "Users('uid')/Messages('mid')" from the Graph notification
}): Promise<ParsedInboundEmail | null> {
  let token = params.credential.access_token
  if (!token) token = await refreshOutlookToken(params.credential)
  if (!token) return null

  const res = await callConnector<any>({
    connector: "outlook", baseUrl: "https://graph.microsoft.com", path: `/v1.0/${params.resourceUrl}`, method: "GET",
    query: { "$expand": "attachments" }, auth: { style: "bearer", token },
  })
  if (!res.ok) return null
  const msg = res.data ?? {}

  const fromEmail = (msg.from?.emailAddress?.address ?? "").toString().toLowerCase().trim()
  const toEmail   = (msg.toRecipients?.[0]?.emailAddress?.address ?? "").toString().toLowerCase().trim()
  const attachments: InboundAttachment[] = (msg.attachments ?? [])
    .filter((a: any) => a["@odata.type"] === "#microsoft.graph.fileAttachment")
    .map((a: any) => ({
      fileName:   a.name ?? "attachment",
      mime:       a.contentType ?? "application/octet-stream",
      contentB64: a.contentBytes ?? "",
    }))

  return {
    provider:   "outlook",
    fromEmail,
    toEmail,
    subject:    (msg.subject ?? "").toString().trim(),
    bodyText:   (msg.bodyPreview ?? "").toString(),
    attachments,
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function extractEmail(raw: string): string {
  // "Name <addr@host>" → "addr@host"; "addr@host" → "addr@host"
  const m = raw.match(/<([^>]+)>/)
  return (m ? m[1] : raw).toLowerCase().trim()
}
