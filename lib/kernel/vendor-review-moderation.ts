// lib/kernel/vendor-review-moderation.ts
//
// VENDOR REVIEW-AS-A-PRODUCT (sphere_of_influence) — the depth the marketplace's review system was
// missing. vendor_reviews was a 7-column stub (rating + text); this adds the governance a real review
// system needs, all PURE + server-enforced:
//   · VERIFICATION — a review counts as verified ONLY when the reviewer was a party to the referenced
//     transaction (buyer/seller/agent) or booking (requester / on-behalf client). The client can never
//     self-assert it — verificationMethod is computed server-side from the real relationship.
//   · WEIGHTING — verified reviews weigh 1.5×, unverified 1.0× in the vendor's average (a verified voice
//     counts more than an anonymous one).
//   · MODERATION — a review auto-approves only when it clears every rule (rating ≥ 3, sane length, no
//     profanity/PII/competitor mention, aged account); otherwise it lands in the human queue.
// Pure + honest; no fabricated signals. The service wiring (submit/respond/flag/moderate) lives in the
// vendor-marketplace actions; this module is the testable brain.

export const MIN_BODY = 50
export const MAX_BODY = 2000
export const MIN_ACCOUNT_AGE_DAYS = 7
export const VERIFIED_WEIGHT = 1.5
export const UNVERIFIED_WEIGHT = 1.0
/** Community flags at or above this move a review to `under_review`. */
export const FLAG_UNDER_REVIEW = 3

export type ModerationStatus = "pending" | "approved" | "rejected" | "under_review"
export type VerificationMethod = "transaction_party" | "booking_party" | "unverified"

// ─── Verification (server-enforced; client cannot self-assert) ─────────────────

export interface TxnParties { buyerId?: string | null; sellerId?: string | null; agentId?: string | null; buyerContactId?: string | null; contactId?: string | null }
export interface BookingParties { requestedBy?: string | null; onBehalfOf?: string | null; contactId?: string | null }

/**
 * PURE: the verification method for a review. The reviewer must be a real party to the referenced
 * transaction or booking; otherwise the review is unverified (still allowed, but not weighted or badged).
 */
export function verificationMethod(input: {
  reviewerUserId: string | null
  reviewerContactId?: string | null
  transaction?: TxnParties | null
  booking?: BookingParties | null
}): { method: VerificationMethod; isVerified: boolean } {
  const uid = input.reviewerUserId
  const cid = input.reviewerContactId ?? null
  const t = input.transaction
  if (t && uid && [t.buyerId, t.sellerId, t.agentId].filter(Boolean).includes(uid)) return { method: "transaction_party", isVerified: true }
  if (t && cid && [t.buyerContactId, t.contactId].filter(Boolean).includes(cid)) return { method: "transaction_party", isVerified: true }
  const b = input.booking
  if (b && uid && [b.requestedBy, b.onBehalfOf].filter(Boolean).includes(uid)) return { method: "booking_party", isVerified: true }
  if (b && cid && [b.onBehalfOf, b.contactId].filter(Boolean).includes(cid)) return { method: "booking_party", isVerified: true }
  return { method: "unverified", isVerified: false }
}

// ─── Weighted average (verified voices count more) ─────────────────────────────

export interface WeightableReview { rating: number | null; isVerified: boolean }

/**
 * PURE: the vendor's weighted review average — verified reviews at 1.5×, unverified at 1.0×. Returns the
 * weighted average (2dp), the total moderated review count, and the verified count (badge input). Only
 * finite ratings 1..5 are counted; empty input → null average.
 */
export function weightedReviewAverage(reviews: WeightableReview[]): { avg: number | null; count: number; verifiedCount: number } {
  let wsum = 0, w = 0, count = 0, verified = 0
  for (const r of reviews) {
    const rating = Number(r.rating)
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) continue
    const weight = r.isVerified ? VERIFIED_WEIGHT : UNVERIFIED_WEIGHT
    wsum += rating * weight; w += weight; count += 1
    if (r.isVerified) verified += 1
  }
  return { avg: w > 0 ? Math.round((wsum / w) * 100) / 100 : null, count, verifiedCount: verified }
}

// ─── Moderation screen ─────────────────────────────────────────────────────────

// Deliberately small, high-precision lists — the goal is to ROUTE to a human, not to be a content filter.
const PROFANITY = ["fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick"]
const PII_PATTERNS: RegExp[] = [
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,               // email
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone
  /\b\d{3}-\d{2}-\d{4}\b/,                       // SSN
]

export interface ScreenInput {
  rating: number
  body: string | null | undefined
  accountAgeDays: number | null
  /** Vendor/company names other than the reviewed vendor — a competitor mention routes to a human. */
  competitorNames?: string[]
}

export interface ScreenResult {
  autoApprove: boolean
  moderationStatus: ModerationStatus
  reasons: string[]
}

/**
 * PURE: decide whether a review auto-approves or goes to the human queue. Auto-approve ONLY when it clears
 * every rule; ANY trip routes to `pending` (manual). Honest: missing account age is treated as unknown →
 * routed to human (never auto-approve on an unknown-age account), never fabricated as either pass or fail.
 */
export function screenReview(input: ScreenInput): ScreenResult {
  const reasons: string[] = []
  const body = (input.body ?? "").trim()
  const lower = body.toLowerCase()

  if (input.rating <= 1) reasons.push("one_star_needs_review")
  if (body.length < MIN_BODY) reasons.push("too_short")
  if (body.length > MAX_BODY) reasons.push("too_long")
  if (PROFANITY.some((w) => new RegExp(`\\b${w}`, "i").test(lower))) reasons.push("profanity")
  if (PII_PATTERNS.some((re) => re.test(body))) reasons.push("pii")
  if ((input.competitorNames ?? []).some((n) => n && n.trim().length > 2 && lower.includes(n.trim().toLowerCase()))) reasons.push("competitor_mention")
  if (input.accountAgeDays == null || input.accountAgeDays < MIN_ACCOUNT_AGE_DAYS) reasons.push("account_too_new")

  const autoApprove = reasons.length === 0
  return { autoApprove, moderationStatus: autoApprove ? "approved" : "pending", reasons }
}

/** PURE: apply a community flag count → new moderation status (3+ flags forces a human re-review). */
export function moderationAfterFlag(currentStatus: ModerationStatus, flagCount: number): ModerationStatus {
  if (currentStatus === "rejected") return "rejected"           // a rejected review stays rejected
  if (flagCount >= FLAG_UNDER_REVIEW) return "under_review"
  return currentStatus
}
