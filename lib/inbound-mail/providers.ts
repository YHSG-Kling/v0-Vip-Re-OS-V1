/**
 * lib/inbound-mail/providers.ts
 *
 * Email-provider-aware inbound webhook helpers. The active provider is
 * detected from the request headers (each provider sends a distinctive
 * signature header) and verified using that provider's secret. This
 * mirrors the agent's brokerage settings — whichever email provider the
 * brokerage configured for sending also handles their inbound.
 *
 * Supported providers (matches platform_credentials.platform values for
 * email): postmark | sendgrid | mailgun | resend.
 *
 * Each provider parser exposes:
 *   - verify(rawBody, headers): boolean   — HMAC / signature check
 *   - parse(rawBody): ParsedEmail | null  — sender / recipient / subject /
 *                                            attachments[] in a normalized
 *                                            shape downstream code uses.
 *
 * Env vars (one per provider; the brokerage tells their provider to forward
 * to /api/webhooks/inbound-mail and we accept any of the four):
 *   POSTMARK_INBOUND_WEBHOOK_SECRET
 *   SENDGRID_INBOUND_WEBHOOK_VERIFY_KEY   (ECDSA public key, PEM)
 *   MAILGUN_WEBHOOK_SIGNING_KEY
 *   RESEND_WEBHOOK_SECRET
 *
 * For a brokerage that ONLY uses one provider, only that env var needs
 * to be set; requests with unknown signature headers are rejected 401.
 */

import { createHmac, timingSafeEqual, createVerify } from "crypto"

export type InboundEmailProvider = "postmark" | "sendgrid" | "mailgun" | "resend"

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

// ─── Detection ──────────────────────────────────────────────────────────────

export function detectInboundProvider(headers: Headers): InboundEmailProvider | null {
  if (headers.get("x-postmark-webhook-signature")) return "postmark"
  if (headers.get("x-twilio-email-event-webhook-signature") || headers.get("x-sg-webhook-signature")) return "sendgrid"
  if (headers.get("x-mailgun-signature-256") || headers.get("x-mailgun-signature")) return "mailgun"
  if (headers.get("svix-signature") || headers.get("resend-signature")) return "resend"
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

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export function verifyInbound(provider: InboundEmailProvider, rawBody: string, headers: Headers): boolean {
  switch (provider) {
    case "postmark": return verifyPostmark(rawBody, headers)
    case "sendgrid": return verifySendgrid(rawBody, headers)
    case "mailgun":  return verifyMailgun(rawBody, headers)
    case "resend":   return verifyResend(rawBody, headers)
  }
}

export function parseInbound(provider: InboundEmailProvider, rawBody: string): ParsedInboundEmail | null {
  switch (provider) {
    case "postmark": return parsePostmark(rawBody)
    case "sendgrid": return parseSendgrid(rawBody)
    case "mailgun":  return parseMailgun(rawBody)
    case "resend":   return parseResend(rawBody)
  }
}
