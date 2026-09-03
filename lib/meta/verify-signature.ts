/**
 * lib/meta/verify-signature.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE META WEBHOOK VERIFIER — subscription handshake + payload signature —
 * for every route Meta's Graph API webhooks deliver to: Messenger/Instagram
 * DMs (app/api/webhooks/meta-dm), Lead Ads (app/api/webhooks/meta-leadgen) and
 * WhatsApp Cloud API (app/api/webhooks/whatsapp).
 *
 * WHY ONE MODULE. Before this file the verifier lived in meta-dm only; the
 * lead-gen route minted tcpa_consent=true CONTACTS from an unauthenticated POST
 * body, and the WhatsApp route filed unauthenticated messages into the CRM.
 * Same app, same secret, same header, three routes, one verifier. The handshake
 * token had THREE spellings across the three routes (§6):
 *
 *     META_WEBHOOK_VERIFY_TOKEN   meta-dm (first), meta-leadgen (only)
 *     META_VERIFY_TOKEN           meta-dm + whatsapp fallback — the DELETED
 *                                 first-generation Messenger route's var
 *                                 (tombstone in meta-dm's header)
 *     WHATSAPP_VERIFY_TOKEN       whatsapp (first)
 *
 * SURVIVOR: META_WEBHOOK_VERIFY_TOKEN. It is what the adjudicated survivor of
 * the meta/meta-dm pair reads first, the only name the lead-gen route ever
 * read, the name lib/providers/webhook-contract.ts publishes to platform staff
 * and scripts/doc-kernel-simulator.ts asserts — and it is the RIGHT name: one
 * Meta app has one webhook verify token (the value is chosen by us and pasted
 * into each product's Webhooks/Configuration console field, so one value
 * serves Messenger, IG, Lead Ads and WhatsApp alike). The other two are
 * ACCEPTED AS FALLBACKS — a console already configured against either keeps
 * verifying — and `resolveMetaVerifyToken()` reports which name answered, so a
 * deploy can see it is still on a deprecated spelling.
 *
 * PROTOCOL (researched 2026-08-27, developers.facebook.com → Webhooks →
 * "Verification Requests" and "Validating payloads"; Graph API v25.0 current,
 * both mechanisms version-independent):
 *   · GET  hub.mode=subscribe & hub.verify_token & hub.challenge → echo the
 *     challenge with 200 when the token matches.
 *   · POST carries X-Hub-Signature-256: "sha256=" + hex(HMAC-SHA256(raw body,
 *     App Secret)). The signature is over the EXACT bytes Meta sent — a route
 *     must `await req.text()` ONCE and JSON.parse that string; `req.json()`
 *     consumes the body and re-serialisation would not round-trip.
 *   WhatsApp Cloud API webhooks are Graph API webhooks and sign identically.
 *
 * FAIL CLOSED (CLAUDE.md §4), and the two refusals are DIFFERENT statuses on
 * purpose:
 *   · App Secret UNSET → 503. This deploy cannot verify anyone; nothing may be
 *     ingested. 503 (not a silent 200) makes the misconfiguration VISIBLE in
 *     the Meta App Dashboard's webhook delivery log, and Meta's retry
 *     schedule re-delivers once the secret is set. Previously meta-dm acked
 *     200 and ingested nothing — which dropped every DM forever with no signal
 *     anywhere; a "checked and fine" that nobody had checked.
 *   · Signature MISSING/MALFORMED/MISMATCHED → 401. That is a forger, not Meta
 *     (Meta always signs), so there is no retry obligation.
 *
 * PURE + server-safe: imports only node:crypto. No supabase, no server-only.
 */
import { createHmac, timingSafeEqual } from "crypto"

/** The ONE handshake-token env name (survivor — see the header). */
export const META_VERIFY_TOKEN_ENV = "META_WEBHOOK_VERIFY_TOKEN"
/** Accepted, documented fallbacks — a console configured against either keeps working. */
export const META_VERIFY_TOKEN_FALLBACK_ENVS = ["META_VERIFY_TOKEN", "WHATSAPP_VERIFY_TOKEN"] as const

/** The App Secret env pair — the same pair lib/social/token-refresh.ts uses. */
export const META_APP_SECRET_ENV = "META_APP_SECRET"
export const META_APP_SECRET_FALLBACK_ENV = "FACEBOOK_APP_SECRET"

/**
 * Resolve the handshake token, survivor first. Returns which env name answered
 * so a route (or a posture check) can log a deploy still on a fallback spelling.
 *
 * Each env is read with a DOTTED literal, deliberately: scripts/webhook-contract-guard.ts
 * (and any human grep) finds a secret by `process.env.NAME`, and a loop over
 * `process.env[name]` would make every one of these names invisible to it.
 */
export function resolveMetaVerifyToken(): { token: string; source: string } | null {
  const candidates: Array<[string, string | undefined]> = [
    [META_VERIFY_TOKEN_ENV, process.env.META_WEBHOOK_VERIFY_TOKEN],
    [META_VERIFY_TOKEN_FALLBACK_ENVS[0], process.env.META_VERIFY_TOKEN],
    [META_VERIFY_TOKEN_FALLBACK_ENVS[1], process.env.WHATSAPP_VERIFY_TOKEN],
  ]
  for (const [name, v] of candidates) {
    if (v && v.trim().length > 0) return { token: v, source: name }
  }
  return null
}

/** The App Secret, survivor first. Null = this deploy cannot verify payloads. */
export function resolveMetaAppSecret(): string | null {
  const v = process.env.META_APP_SECRET ?? process.env.FACEBOOK_APP_SECRET
  return v && v.trim().length > 0 ? v : null
}

/** Lowercase hex HMAC-SHA256 of `message` keyed by `secret`. */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf-8").digest("hex")
}

/**
 * Constant-time equality of two hex digests. Returns false on ANY malformed
 * input (odd length, non-hex, length mismatch) rather than throwing — a
 * verifier that throws on a crafted header is a verifier that can be crashed.
 */
export function safeHexEqual(expectedHex: string, actualHex: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(expectedHex) || !/^[0-9a-fA-F]+$/.test(actualHex)) return false
  if (expectedHex.length % 2 !== 0 || actualHex.length % 2 !== 0) return false
  try {
    const a = Buffer.from(expectedHex, "hex")
    const b = Buffer.from(actualHex, "hex")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export type MetaSignatureVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string }

/**
 * Verify X-Hub-Signature-256 over the RAW body. The verdict carries the HTTP
 * status the route must answer with — the policy lives here, once, so the
 * three routes cannot drift into three policies.
 */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null | undefined): MetaSignatureVerdict {
  const secret = resolveMetaAppSecret()
  if (!secret) {
    return { ok: false, status: 503, reason: `Meta webhook not configured: ${META_APP_SECRET_ENV} is unset — payloads cannot be verified` }
  }
  const header = (signatureHeader ?? "").trim()
  if (!header.startsWith("sha256=")) return { ok: false, status: 401, reason: "invalid signature" }
  const expected = hmacSha256Hex(secret, rawBody)
  const actual = header.slice("sha256=".length)
  return safeHexEqual(expected, actual) ? { ok: true } : { ok: false, status: 401, reason: "invalid signature" }
}

/**
 * Meta's GET subscription handshake — the one spelling for all three routes.
 *   · token unset          → 404 "not configured" (honest: nothing to verify
 *                            against; merged from meta-dm, the survivor)
 *   · mode/token/challenge → 200 with the challenge echoed verbatim
 *   · anything else        → 403
 */
export function metaSubscriptionHandshake(req: Request): Response {
  const resolved = resolveMetaVerifyToken()
  if (!resolved) return new Response("Meta webhook not configured", { status: 404 })
  const url = new URL(req.url)
  const mode = url.searchParams.get("hub.mode")
  const verify = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  if (mode === "subscribe" && verify && verify === resolved.token && challenge) {
    return new Response(challenge, { status: 200 })
  }
  return new Response("Verification failed", { status: 403 })
}
