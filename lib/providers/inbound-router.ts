/**
 * INBOUND MESSAGE ROUTER (Provider-Routed)
 * lib/providers/inbound-router.ts
 *
 * 1) Detects provider from request headers/body
 * 2) Validates provider signature (401 on failure)
 * 3) Normalises payload to canonical InboundMessage
 * 4) Resolves brokerage scope
 *
 * Intentionally has NO database side effects — all persistence happens in
 * app/api/providers/inbound/route.ts after normalisation.
 */

import crypto from "crypto"

// ─── CANONICAL PAYLOAD ────────────────────────────────────────────────────────

export type InboundProviderType =
  | "sendgrid"
  | "postmark"
  | "mailgun"
  | "twilio"
  | string

export type InboundMessage = {
  brokerageId: string
  providerType: InboundProviderType
  messageId: string | null
  fromEmail: string | null
  fromPhone: string | null
  subject: string | null
  text: string | null
  raw: unknown
}

// ─── SIGNATURE VALIDATORS ─────────────────────────────────────────────────────

/**
 * SendGrid Event Webhook — HMAC-SHA256 over timestamp + payload.
 * Docs: https://docs.sendgrid.com/for-developers/tracking-events/getting-started-event-webhook-security-features
 */
function verifySendGrid(body: string, headers: Headers): boolean {
  const secret = process.env.SENDGRID_WEBHOOK_SECRET
  if (!secret) return false
  const timestamp = headers.get("x-twilio-email-event-webhook-timestamp") ?? ""
  const signature = headers.get("x-twilio-email-event-webhook-signature") ?? ""
  if (!timestamp || !signature) return false
  const payload = timestamp + body
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

/**
 * Postmark — compare shared X-Postmark-Signature secret header.
 */
function verifyPostmark(headers: Headers): boolean {
  const secret = process.env.POSTMARK_WEBHOOK_SECRET
  if (!secret) return false
  const token = headers.get("x-postmark-signature") ?? headers.get("x-postmark-token") ?? ""
  return crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(token))
}

/**
 * Mailgun — HMAC-SHA256 over timestamp + token.
 * Docs: https://documentation.mailgun.com/en/latest/user_manual.html#webhooks
 */
function verifyMailgun(body: Record<string, unknown>): boolean {
  const secret = process.env.MAILGUN_WEBHOOK_SECRET
  if (!secret) return false
  const sig = body["signature"] as Record<string, string> | undefined
  if (!sig) return false
  const { timestamp, token, signature } = sig
  if (!timestamp || !token || !signature) return false
  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + token)
    .digest("hex")
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

/**
 * Twilio — HMAC-SHA1 of full URL + sorted params.
 */
function verifyTwilio(rawUrl: string, params: Record<string, string>, headers: Headers): boolean {
  const secret = process.env.TWILIO_AUTH_TOKEN
  if (!secret) return false
  const twilioSig = headers.get("x-twilio-signature") ?? ""
  if (!twilioSig) return false
  const sortedKeys = Object.keys(params).sort()
  let str = rawUrl
  for (const key of sortedKeys) {
    str += key + (params[key] ?? "")
  }
  const expected = crypto
    .createHmac("sha1", secret)
    .update(Buffer.from(str, "utf-8"))
    .digest("base64")
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(twilioSig))
}

// ─── PROVIDER DETECTION ───────────────────────────────────────────────────────

function detectProvider(headers: Headers): InboundProviderType | null {
  if (headers.get("x-twilio-email-event-webhook-signature")) return "sendgrid"
  if (headers.get("x-postmark-signature") ?? headers.get("x-postmark-token")) return "postmark"
  if (headers.get("x-twilio-signature")) return "twilio"
  // Mailgun signature is embedded in body — detected during parse
  return null
}

// ─── BROKERAGE RESOLVER ───────────────────────────────────────────────────────

/**
 * Brokerage is resolved in priority order:
 *  1. `brokerage_id` query param (provider webhook URL configured per-brokerage)
 *  2. `brokerage_id` in parsed body
 *  3. Subdomain: `<brokerageSlug>.app.domain.com` → looked up by caller
 */
function resolveBrokerageId(
  url: URL,
  body: Record<string, unknown>
): string | null {
  const fromQuery = url.searchParams.get("brokerage_id")
  if (fromQuery) return fromQuery
  const fromBody = body["brokerage_id"] ?? body["brokerageId"]
  if (typeof fromBody === "string" && fromBody.length > 0) return fromBody
  return null
}

// ─── NORMALIZERS ──────────────────────────────────────────────────────────────

function normalizeSendGrid(
  payload: unknown[],
  brokerageId: string
): InboundMessage {
  // SendGrid posts an array; take the first inbound item
  const event = (payload[0] ?? {}) as Record<string, unknown>
  return {
    brokerageId,
    providerType: "sendgrid",
    messageId: (event["sg_message_id"] as string | null) ?? null,
    fromEmail: (event["from"] as string | null) ?? null,
    fromPhone: null,
    subject: (event["subject"] as string | null) ?? null,
    text: (event["text"] as string | null) ?? null,
    raw: payload,
  }
}

function normalizePostmark(
  body: Record<string, unknown>,
  brokerageId: string
): InboundMessage {
  return {
    brokerageId,
    providerType: "postmark",
    messageId: (body["MessageID"] as string | null) ?? null,
    fromEmail: (body["From"] as string | null) ?? null,
    fromPhone: null,
    subject: (body["Subject"] as string | null) ?? null,
    text: (body["TextBody"] as string | null) ?? null,
    raw: body,
  }
}

function normalizeMailgun(
  body: Record<string, unknown>,
  brokerageId: string
): InboundMessage {
  const eventData = (body["event-data"] as Record<string, unknown>) ?? body
  return {
    brokerageId,
    providerType: "mailgun",
    messageId: (eventData["id"] as string | null) ?? null,
    fromEmail: (eventData["sender"] as string | null) ?? null,
    fromPhone: null,
    subject: ((eventData["message"] as Record<string, unknown>)?.["headers"] as Record<string, unknown>)?.["subject"] as string | null ?? null,
    text: (eventData["stripped-text"] as string | null) ?? null,
    raw: body,
  }
}

function normalizeTwilio(
  body: Record<string, unknown>,
  brokerageId: string
): InboundMessage {
  return {
    brokerageId,
    providerType: "twilio",
    messageId: (body["MessageSid"] as string | null) ?? null,
    fromEmail: null,
    fromPhone: (body["From"] as string | null) ?? null,
    subject: null,
    text: (body["Body"] as string | null) ?? null,
    raw: body,
  }
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

export type NormalizeResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; status: 400 | 401; reason: string }

export async function normalizeInbound(req: Request): Promise<NormalizeResult> {
  const url = new URL(req.url)
  const contentType = req.headers.get("content-type") ?? ""

  // Clone before reading — body can only be consumed once
  const rawBody = await req.text()

  // ── Detect provider ──────────────────────────────────────────────────────────
  let provider = detectProvider(req.headers)

  // Parse body (needed for Mailgun signature which lives inside the body)
  let parsedBody: Record<string, unknown> = {}
  let parsedArray: unknown[] = []

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody)
      if (Array.isArray(parsed)) {
        parsedArray = parsed
      } else {
        parsedBody = parsed as Record<string, unknown>
      }
    } catch {
      return { ok: false, status: 400, reason: "Invalid JSON body" }
    }
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const params = new URLSearchParams(rawBody)
    params.forEach((v, k) => { parsedBody[k] = v })
  }

  // Mailgun: detected by presence of nested signature in body
  if (!provider && typeof parsedBody["signature"] === "object") {
    provider = "mailgun"
  }

  if (!provider) {
    return { ok: false, status: 400, reason: "Unknown provider — cannot detect from headers/body" }
  }

  // ── Validate signature ───────────────────────────────────────────────────────
  let sigValid = false
  if (provider === "sendgrid") {
    sigValid = verifySendGrid(rawBody, req.headers)
  } else if (provider === "postmark") {
    sigValid = verifyPostmark(req.headers)
  } else if (provider === "mailgun") {
    sigValid = verifyMailgun(parsedBody)
  } else if (provider === "twilio") {
    // Twilio needs sorted POST params
    const formParams: Record<string, string> = {}
    Object.entries(parsedBody).forEach(([k, v]) => {
      if (typeof v === "string") formParams[k] = v
    })
    sigValid = verifyTwilio(req.url, formParams, req.headers)
  }

  // Allow dev bypass via env flag — never in production
  const devBypass =
    process.env.NODE_ENV !== "production" &&
    process.env.INBOUND_SKIP_SIG_VERIFY === "true"

  if (!sigValid && !devBypass) {
    return { ok: false, status: 401, reason: `Invalid ${provider} signature` }
  }

  // ── Resolve brokerage ────────────────────────────────────────────────────────
  const effectiveBody =
    provider === "sendgrid" && parsedArray.length > 0
      ? ((parsedArray[0] as Record<string, unknown>) ?? {})
      : parsedBody

  const brokerageId = resolveBrokerageId(url, effectiveBody)
  if (!brokerageId) {
    return {
      ok: false,
      status: 400,
      reason: "Cannot resolve brokerage_id — include it as a query param or in the body",
    }
  }

  // ── Normalize ────────────────────────────────────────────────────────────────
  let message: InboundMessage

  if (provider === "sendgrid") {
    message = normalizeSendGrid(parsedArray.length > 0 ? parsedArray : [parsedBody], brokerageId)
  } else if (provider === "postmark") {
    message = normalizePostmark(parsedBody, brokerageId)
  } else if (provider === "mailgun") {
    message = normalizeMailgun(parsedBody, brokerageId)
  } else if (provider === "twilio") {
    message = normalizeTwilio(parsedBody, brokerageId)
  } else {
    // Unknown but detected — best effort with raw body
    message = {
      brokerageId,
      providerType: provider,
      messageId: null,
      fromEmail: null,
      fromPhone: null,
      subject: null,
      text: null,
      raw: parsedBody,
    }
  }

  return { ok: true, message }
}
