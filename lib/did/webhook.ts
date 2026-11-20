// lib/did/webhook.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE INBOUND HALF OF THE D-ID CONTRACT.
//
// ── D-ID PUBLISHES NO WEBHOOK SIGNATURE. SAID PLAINLY, BECAUSE IT DECIDES ────
// The published API reference (docs.d-id.com, v4.2.1) describes the outbound
// field and nothing more:
//
//     webhook: { type: string, format: uri,
//                description: "HTTPS webhook URL for completion notification." }
//
// and its `securitySchemes` block lists only basicAuth, bearerAuth and
// clientKeyAuth — all of them for CALLING D-ID, none for verifying anything
// D-ID sends us. Their /docs/webhooks page is empty and /reference/webhooks
// does not resolve. There is no HMAC header, no signing secret, no timestamp
// scheme. Third-party integration guides assert "most platforms include an HMAC
// signature"; that is a generic statement about other platforms and it is NOT a
// D-ID fact, so it is not implemented here as though it were. Inventing a
// verification scheme that the provider does not implement would be worse than
// having none: it would read as verified.
//
// WHAT WE DO INSTEAD, and why it is enough for this payload:
//   1. A SHARED SECRET travels in the callback URL we mint (?secret=…), matched
//      against DID_WEBHOOK_SECRET — the same pattern sendgrid-events,
//      lob-events and twilio-sms-status already use in this codebase. Unset
//      secret = 404, never a silently-open endpoint.
//   2. NOTHING IN THE BODY IS TRUSTED AS A RESULT. The body is used only to
//      identify WHICH job finished; the outcome is then applied from that
//      payload's status only after the job id has been matched to a row WE
//      created. A forged body can therefore, at worst, tell us about a job we
//      already own — it cannot mint one.
//   3. CORRELATION IS ON user_data, the field D-ID designed for it, carrying
//      `asset:<uuid>` from buildExpressAvatarRequest and echoed back verbatim.
//
// PURE — parsing and URL minting only. No I/O, so the guard can exercise it.

import { siteUrl } from "@/lib/platform/site-url"
import { assetIdFromUserData, classifyDidStatus, type DidStatusClass } from "./contract"

/** Where D-ID should post completions, or null when it cannot be built.
 *
 *  Null is a real answer, not a failure: without a public origin or a secret we
 *  must NOT register a callback D-ID will post into the void, and
 *  buildExpressAvatarRequest already drops a missing/non-https webhook so the
 *  job still runs and the poll cron still finishes it. */
export function didWebhookUrl(): string | null {
  const secret = (process.env.DID_WEBHOOK_SECRET ?? "").trim()
  if (!secret) return null
  const origin = siteUrl()
  // The schema pattern requires https. A localhost dev origin is unreachable
  // from D-ID anyway, so it is dropped here rather than rejected on submit.
  if (!origin || !/^https:\/\//.test(origin)) return null
  return `${origin}/api/webhooks/did?secret=${encodeURIComponent(secret)}`
}

export interface ParsedDidWebhook {
  /** The provider's job id (avt_… for a scene avatar, tlk_/clp_/exp_ otherwise). */
  jobId: string | null
  /** D-ID's `object` discriminator, lowercased, when present. */
  objectType: string | null
  status: string | null
  statusClass: DidStatusClass
  /** The echoed correlation string. */
  userData: string | null
  /** Our agent_avatar_assets.id, parsed out of user_data. */
  assetId: string | null
  /** True when this payload is about an instant/express avatar rather than a render. */
  isAvatar: boolean
}

/** Wrapper keys seen in the wild. D-ID's envelope is not published beyond
 *  "completion notification", so the bare object is assumed and a single level
 *  of nesting is tolerated rather than guessed at further. */
const NESTED_KEYS = ["data", "payload", "body", "object_data"] as const

function unwrap(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {}
  const top = body as Record<string, unknown>
  if (typeof top.status === "string" || typeof top.id === "string") return top
  for (const k of NESTED_KEYS) {
    const inner = top[k]
    if (inner && typeof inner === "object") return inner as Record<string, unknown>
  }
  return top
}

/**
 * Read a D-ID completion notification.
 *
 * Deliberately total — it never throws and never guesses. Missing fields come
 * back null and the caller ignores the delivery with a stated reason, because
 * a webhook we cannot understand must not be turned into a status we cannot
 * defend.
 */
export function parseDidWebhook(body: unknown): ParsedDidWebhook {
  const b = unwrap(body)
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null

  const jobId = str(b.id) ?? str(b.avatar_id) ?? str(b.talk_id)
  const objectType = (str(b.object) ?? "").toLowerCase() || null
  const status = str(b.status)
  const userData = str(b.user_data)

  // Two independent tells, because either one alone has a gap: `object` is
  // "scene_avatar" on the avatar family but is not guaranteed present on every
  // delivery, and the avt_ prefix is stable but is an observed convention
  // rather than a documented one.
  const isAvatar =
    (objectType !== null && objectType.includes("avatar")) ||
    (jobId !== null && jobId.startsWith("avt_"))

  return {
    jobId,
    objectType,
    status,
    statusClass: classifyDidStatus(status),
    userData,
    assetId: assetIdFromUserData(userData),
    isAvatar,
  }
}

/**
 * Constant-time-ish secret comparison.
 *
 * Not defending against a serious timing attack on a 200-byte HTTP handler
 * behind a CDN — it is here so the comparison is not the weakest visible link,
 * and because a plain === on a secret invites the next reader to assume the
 * check was never meant to be careful.
 */
export function secretMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
