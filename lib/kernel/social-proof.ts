/**
 * lib/kernel/social-proof.ts
 *
 * CONCERN-MATCHED SOCIAL PROOF (client concierge list #25) — "when the OS
 * detects specific worries (timing, pricing, schools, resale), it surfaces
 * one or two relevant testimonials rather than a generic review blast."
 * The proof is REAL: published agent_reviews rows (is_published=true,
 * rating >= 4) — never a fabricated quote, never an unpublished one. The
 * portal AI chat mines the client's question for a concern family and, on
 * a match, hands the model ONE grounded testimonial line it may weave in.
 * Zero matching reviews = zero social proof (honest silence beats a
 * generic blast). PURE; marketing_agent owns reputation. NOT server-only.
 */

const CONCERN_FAMILIES: Array<{ key: string; pattern: RegExp }> = [
  { key: "timing", pattern: /\b(how long|timeline|too slow|taking forever|when will|weeks|months|fast enough)\b/ },
  { key: "pricing", pattern: /\b(overpric|too expensive|worth it|lowball|price right|priced|afford)\b/ },
  { key: "schools", pattern: /\b(school|district|kids will go)\b/ },
  { key: "resale", pattern: /\b(resale|sell it later|hold its value|appreciate|investment)\b/ },
  { key: "first_time", pattern: /\b(first home|first time|never done this|new to this|nervous)\b/ },
  { key: "process", pattern: /\b(overwhelm|stress|complicated|confus|scared|anxious|worried)\b/ },
]

/** PURE: which concern family (if any) is this client voicing? */
export function mineClientConcern(text: string): string | null {
  const t = (text ?? "").toLowerCase()
  for (const fam of CONCERN_FAMILIES) if (fam.pattern.test(t)) return fam.key
  return null
}

export interface PublishedReview {
  reviewText: string | null
  rating: number | null
  reviewerName: string | null
}

/** the concern must actually appear in the review for it to be RELEVANT proof. */
const REVIEW_MATCH: Record<string, RegExp> = {
  timing: /\b(fast|quick|days|smooth|on time|no delays|right on schedule)\b/,
  pricing: /\b(price|value|over asking|full ask|worth|negotiat)\b/,
  schools: /\b(school|district|family|kids)\b/,
  resale: /\b(value|investment|equity|appreciat)\b/,
  first_time: /\b(first|new to|walked us|explained|patient|every step)\b/,
  process: /\b(easy|smooth|stress|calm|took care|handled everything|every step)\b/,
}

/** PURE: one grounded testimonial line for the concern, or honest null.
 *  Only published, high-rated, genuinely-relevant reviews qualify. */
export function pickSocialProof(concern: string, reviews: PublishedReview[]): string | null {
  const matcher = REVIEW_MATCH[concern]
  if (!matcher) return null
  for (const r of reviews) {
    const text = (r.reviewText ?? "").trim()
    if (!text || (r.rating ?? 0) < 4) continue
    if (!matcher.test(text.toLowerCase())) continue
    const snippet = text.length > 220 ? `${text.slice(0, 217)}...` : text
    const name = (r.reviewerName ?? "").trim() || "A past client"
    return `${name} (verified review): "${snippet}"`
  }
  return null
}
