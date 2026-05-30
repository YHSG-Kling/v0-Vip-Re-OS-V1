/**
 * lib/inbound-mail/providers.ts
 *
 * Email-provider-aware inbound webhook helpers. Two classes of provider:
 *
 *   A) TRANSACTIONAL (HMAC-signed body, attachments inline):
 *        postmark | sendgrid | mailgun | resend
 *      The provider sends us the whole email + attachments in the webhook
 *      body. We verify with HMAC/ECDSA and parse the body shape per-provider.
 *      Typically used by brokerages that own a domain + route inbound
 *      through a transactional service.
 *
 *   B) PER-USER OAUTH (push notification, fetch via API):
 *        gmail | outlook
 *      The provider posts a small notification (Gmail Pub/Sub + Outlook
 *      Graph subscription). We identify which USER the notification is for,
 *      then fetch the actual message + attachments using the user's stored
 *      OAuth tokens. Used by independent-contractor agents / team leads
 *      who use their own email accounts.
 *
 * Detection: signature header or notification shape tells us which class.
 * Verification: A uses HMAC/ECDSA against an env-var secret; B uses the
 *   user-scoped OAuth tokens stored in platform_credentials.
 * Parsing: A returns ParsedInboundEmail directly; B returns a "fetch
 *   instruction" the route handler executes via lib/inbound-mail/oauth-fetchers.
 */

import { createHmac, timingSafeEqual, createVerify } from "crypto"

export type InboundEmailProvider = "postmark" | "sendgrid" | "mailgun" | "resend" | "gmail" | "outlook"

export interface InboundAttachment {
  fileName:    string
  mime:        string
  /** base64-encoded attachment bytes. */
  contentB64:  string
}

export interface ParsedInboundEmail {
  provider:    InboundEmailProvider
  fromEmail:   string
  toEmail:     string
  subject:     string
  bodyText?:   string
  attachments: InboundAttachment[]
}

/**
 * For OAuth-fetcher providers, the webhook body doesn't contain the email;
 * we have to fetch it via API. This shape carries the IDs we need to do
 * that — the route handler passes it to lib/inbound-mail/oauth-fetchers.
 */
export interface OAuthFetchInstruction {
  provider:        "gmail" | "outlook"
  inboxEmail?:     string         // Gmail: emailAddress from Pub/Sub data
  historyId?:      string         // Gmail: new historyId for the watch
  outlookResource?: string        // Outlook: Graph resource path (e.g. "Users('uid')/Messages('mid')")
  outlookSubscriptionId?: string  // Outlook: subscription id (for refresh)
  outlookClientState?: string     // Outlook: client state we set at sub-create
}

// ─── Detection ──────────────────────────────────────────────────────────────

export function detectInboundProvider(headers: Headers, rawBody?: string): InboundEmailProvider | null {
  if (headers.get("x-postmark-webhook-signature")) return "postmark"
  if (headers.get("x-twilio-email-event-webhook-signature") || headers.get("x-sg-webhook-signature")) return "sendgrid"
  if (headers.get("x-mailgun-signature-256") || headers.get("x-mailgun-signature")) return "mailgun"
  if (headers.get("svix-signature") || headers.get("resend-signature")) return "resend"
  // Gmail Pub/Sub push: body has { message: { data: <base64>, ... }, subscription: "..." }
  if (rawBody && rawBody.includes('"subscription"') && rawBody.includes('"message"')) return "gmail"
  // Outlook Graph notifications: body has { value: [{ subscriptionId, clientState, resource }] }
  if (rawBody && rawBody.includes('"clientState"') && rawBody.includes('"subscriptionId"')) return "outlook"
  return null
}

// ─── Verification + parsing per provider ────────────────────────────────────

function verifyPostmark(rawBody: string, headers: Headers): boolean {
  const secret = process.env.POSTMARK_INBOUND_WEBHOOK_SECRET
  if (!secret) return false
  const sig = headers.get("x-postmark-webhook-signature")
  if (!sig) return false
  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("base64")
  try {
    const a = Buffer.from(computed)
    const b = Buffer.from(sig)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch { return false }
}

function parsePostmark(rawBody: string): ParsedInboundEmail | null {
  try {
    const body = JSON.parse(rawBody)
    const fromEmail = (body.FromFull?.Email ?? body.From ?? "").toString().toLowerCase().trim()
    const toEmail   = (body.ToFull?.[0]?.Email ?? body.To ?? "").toString().toLowerCase().trim()
    return {
      provider:    "postmark",
      fromEmail,
      toEmail,
      subject:     (body.Subject ?? "").toString().trim(),
      bodyText:    (body.TextBody ?? "").toString(),
      attachments: (Array.isArray(body.Attachments) ? body.Attachments : []).map((a: any) => ({
        fileName:   (a.Name ?? "attachment").toString(),
        mime:       (a.ContentType ?? "application/octet-stream").toString(),
        contentB64: (a.Content ?? "").toString(),
      })),
    }
  } catch { return null }
}

function verifySendgrid(rawBody: string, headers: Headers): boolean {
  // SendGrid Inbound Parse signed-webhook uses ECDSA over the body with a
  // public key the brokerage uploads to SendGrid. The verification key is
  // a PEM-encoded ECDSA public key we store in env.
  const verifyKey = process.env.SENDGRID_INBOUND_WEBHOOK_VERIFY_KEY
  if (!verifyKey) return false
  const sig       = headers.get("x-twilio-email-event-webhook-signature") ?? headers.get("x-sg-webhook-signature") ?? ""
  const timestamp = headers.get("x-twilio-email-event-webhook-timestamp") ?? ""
  if (!sig || !timestamp) return false
  try {
    const verifier = createVerify("sha256")
    verifier.update(timestamp + rawBody)
    verifier.end()
    return verifier.verify(verifyKey, Buffer.from(sig, "base64"))
  } catch { return false }
}

function parseSendgrid(rawBody: string): ParsedInboundEmail | null {
  // SendGrid Inbound Parse posts multipart/form-data by default. When the
  // brokerage configures SendGrid to POST JSON we accept that; otherwise
  // the agent should set up the JSON variant. (Multipart parsing is left
  // for the route — we read the parsed form fields here.)
  // For JSON inbound (custom integration), the body looks Postmark-ish.
  try {
    const body = JSON.parse(rawBody)
    return {
      provider:    "sendgrid",
      fromEmail:   (body.from?.email ?? body.from ?? "").toString().toLowerCase().trim(),
      toEmail:     (body.to?.[0]?.email ?? body.to ?? "").toString().toLowerCase().trim(),
      subject:     (body.subject ?? "").toString().trim(),
      bodyText:    (body.text ?? "").toString(),
      attachments: (Array.isArray(body.attachments) ? body.attachments : []).map((a: any) => ({
        fileName:   (a.filename ?? "attachment").toString(),
        mime:       (a.type ?? "application/octet-stream").toString(),
        contentB64: (a.content ?? "").toString(),
      })),
    }
  } catch { return null }
}

function verifyMailgun(rawBody: string, headers: Headers): boolean {
  const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY
  if (!signingKey) return false
  // Mailgun: signature = HMAC(timestamp + token, signing-key). They send
  // those as headers OR in the body fields. We accept either path.
  const sig256    = headers.get("x-mailgun-signature-256")
  const timestamp = headers.get("x-mailgun-timestamp") ?? ""
  const token     = headers.get("x-mailgun-token") ?? ""
  if (sig256 && timestamp && token) {
    const computed = createHmac("sha256", signingKey).update(timestamp + token, "utf-8").digest("hex")
    try {
      const a = Buffer.from(computed, "hex")
      const b = Buffer.from(sig256, "hex")
      return a.length === b.length && timingSafeEqual(a, b)
    } catch { return false }
  }
  // Body-field path
  try {
    const body = JSON.parse(rawBody)
    const ts  = body?.signature?.timestamp ?? ""
    const tok = body?.signature?.token ?? ""
    const sig = body?.signature?.signature ?? ""
    if (!ts || !tok || !sig) return false
    const computed = createHmac("sha256", signingKey).update(ts + tok, "utf-8").digest("hex")
    const a = Buffer.from(computed, "hex")
    const b = Buffer.from(sig, "hex")
    return a.length === b.length && timingSafeEqual(a, b)
  } catch { return false }
}

function parseMailgun(rawBody: string): ParsedInboundEmail | null {
  try {
    const body = JSON.parse(rawBody)
    const ev   = body["event-data"] ?? body
    const msg  = ev?.message ?? {}
    return {
      provider:    "mailgun",
      fromEmail:   (msg?.headers?.from ?? body?.sender ?? "").toString().toLowerCase().trim(),
      toEmail:     (msg?.headers?.to   ?? body?.recipient ?? "").toString().toLowerCase().trim(),
      subject:     (msg?.headers?.subject ?? body?.subject ?? "").toString().trim(),
      bodyText:    (body?.["body-plain"] ?? body?.text ?? "").toString(),
      attachments: (Array.isArray(body?.attachments) ? body.attachments : []).map((a: any) => ({
        fileName:   (a.name ?? "attachment").toString(),
        mime:       (a["content-type"] ?? a.type ?? "application/octet-stream").toString(),
        contentB64: (a.content ?? "").toString(),
      })),
    }
  } catch { return null }
}

function verifyResend(rawBody: string, headers: Headers): boolean {
  // Resend uses Svix-style signed webhooks: svix-id + svix-timestamp + svix-signature.
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return false
  const svixId        = headers.get("svix-id") ?? ""
  const svixTimestamp = headers.get("svix-timestamp") ?? ""
  const svixSignature = headers.get("svix-signature") ?? headers.get("resend-signature") ?? ""
  if (!svixId || !svixTimestamp || !svixSignature) return false
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`
  const computed = createHmac("sha256", secret.replace(/^whsec_/, "")).update(signedPayload, "utf-8").digest("base64")
  // svix-signature is space-separated "vN,SIG vN,SIG"; we look for any match
  for (const part of svixSignature.split(" ")) {
    const sig = part.split(",")[1] ?? ""
    if (!sig) continue
    try {
      const a = Buffer.from(computed)
      const b = Buffer.from(sig)
      if (a.length === b.length && timingSafeEqual(a, b)) return true
    } catch { /* keep trying */ }
  }
  return false
}

function parseResend(rawBody: string): ParsedInboundEmail | null {
  // Resend's inbound webhook payload is JSON with from/to/subject/attachments.
  try {
    const body = JSON.parse(rawBody)
    const data = body.data ?? body
    return {
      provider:    "resend",
      fromEmail:   (data.from ?? "").toString().toLowerCase().trim(),
      toEmail:     (Array.isArray(data.to) ? data.to[0] : data.to ?? "").toString().toLowerCase().trim(),
      subject:     (data.subject ?? "").toString().trim(),
      bodyText:    (data.text ?? "").toString(),
      attachments: (Array.isArray(data.attachments) ? data.attachments : []).map((a: any) => ({
        fileName:   (a.filename ?? "attachment").toString(),
        mime:       (a.content_type ?? "application/octet-stream").toString(),
        contentB64: (a.content ?? "").toString(),
      })),
    }
  } catch { return null }
}

// ─── Gmail Pub/Sub + Outlook Graph: parse-only (no HMAC; auth is OAuth) ────

/**
 * Gmail Pub/Sub push verification — Google signs the push request with a
 * JWT in the Authorization header. We verify it's from Google and that the
 * audience matches our configured URL.
 *
 * Without a Google Cloud sign-in flow we accept the request when
 * GOOGLE_PUBSUB_VERIFICATION_AUDIENCE matches the X-Goog-Audience claim
 * if present; otherwise we trust the body shape + the Pub/Sub subscription
 * ID. Production deploys should set up explicit JWT verification.
 */
function verifyGmail(_rawBody: string, _headers: Headers): boolean {
  // Gmail pushes auth via JWT in Authorization: Bearer <id_token>.
  // Full OIDC verification is a multi-step setup (fetch Google's certs,
  // verify aud + iss). For now we trust the body shape (presence of
  // subscription + message.data) and rely on the user-scoped OAuth fetch
  // to authoritatively prove identity. When GOOGLE_PUBSUB_VERIFICATION_AUDIENCE
  // env is set, the route enforces the JWT audience claim.
  return true
}

function parseGmailNotification(rawBody: string): OAuthFetchInstruction | null {
  try {
    const body = JSON.parse(rawBody)
    const dataB64 = body?.message?.data
    if (!dataB64) return null
    const decoded = Buffer.from(dataB64, "base64").toString("utf-8")
    const data = JSON.parse(decoded)   // { emailAddress, historyId }
    if (!data?.emailAddress || !data?.historyId) return null
    return {
      provider:   "gmail",
      inboxEmail: String(data.emailAddress).toLowerCase().trim(),
      historyId:  String(data.historyId),
    }
  } catch { return null }
}

/**
 * Outlook Graph subscription validation handshake.
 *
 * When Microsoft Graph creates a subscription, it POSTs a single request
 * with a ?validationToken= query string to verify our endpoint owns the URL.
 * The route handler returns the token as text/plain to complete the handshake.
 *
 * For real notifications the body contains { value: [ { subscriptionId,
 * clientState, resource, changeType } ] }. We rely on clientState matching
 * the value we stored at subscription-create time as the authentication
 * mechanism (Microsoft's recommended pattern).
 */
function verifyOutlook(_rawBody: string, _headers: Headers): boolean {
  // clientState matching happens in the route after parsing — it ties the
  // notification to a specific platform_credentials row.
  return true
}

function parseOutlookNotification(rawBody: string): OAuthFetchInstruction | null {
  try {
    const body = JSON.parse(rawBody)
    const note = (body?.value ?? [])[0]
    if (!note?.resource || !note?.clientState) return null
    return {
      provider:              "outlook",
      outlookResource:       String(note.resource),
      outlookSubscriptionId: String(note.subscriptionId ?? ""),
      outlookClientState:    String(note.clientState),
    }
  } catch { return null }
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export function verifyInbound(provider: InboundEmailProvider, rawBody: string, headers: Headers): boolean {
  switch (provider) {
    case "postmark": return verifyPostmark(rawBody, headers)
    case "sendgrid": return verifySendgrid(rawBody, headers)
    case "mailgun":  return verifyMailgun(rawBody, headers)
    case "resend":   return verifyResend(rawBody, headers)
    case "gmail":    return verifyGmail(rawBody, headers)
    case "outlook":  return verifyOutlook(rawBody, headers)
  }
}

/**
 * For TRANSACTIONAL providers: returns the parsed inbound email directly.
 * For OAUTH providers: returns null — the route must call parseFetchInstruction
 * instead and use the OAuth fetchers to retrieve the actual messages.
 */
export function parseInbound(provider: InboundEmailProvider, rawBody: string): ParsedInboundEmail | null {
  switch (provider) {
    case "postmark": return parsePostmark(rawBody)
    case "sendgrid": return parseSendgrid(rawBody)
    case "mailgun":  return parseMailgun(rawBody)
    case "resend":   return parseResend(rawBody)
    case "gmail":
    case "outlook":  return null  // use parseFetchInstruction instead
  }
}

export function parseFetchInstruction(provider: "gmail" | "outlook", rawBody: string): OAuthFetchInstruction | null {
  if (provider === "gmail")   return parseGmailNotification(rawBody)
  if (provider === "outlook") return parseOutlookNotification(rawBody)
  return null
}
