// lib/testimonials/testimonial-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE validation + shaping for an IN-APP client testimonial (text OR video) captured on the lifetime
// portal. A newly-closed client can leave a few written words or a short video the agent uses in
// marketing (a video testimonial becomes a Director reel via the Asset Manager). Captured = is_published
// false until the agent approves it. No I/O — unit-testable.

export type TestimonialKind = "text" | "video"

export interface TestimonialSubmission {
  kind: TestimonialKind
  /** the written testimonial (required for kind 'text'). */
  body?: string | null
  /** the uploaded video URL (required for kind 'video'). */
  videoUrl?: string | null
}

export interface TestimonialValidation {
  ok: boolean
  reason?: string
  /** trimmed/clamped text body to persist (text kind only). */
  cleanBody?: string | null
}

const MAX_BODY = 1500
const MIN_BODY = 8

/** PURE. Validate a testimonial submission. Text needs real words; video needs a URL. */
export function validateTestimonialSubmission(s: TestimonialSubmission): TestimonialValidation {
  if (s.kind === "text") {
    const body = (s.body ?? "").trim()
    if (body.length < MIN_BODY) return { ok: false, reason: "Please share a few words about your experience." }
    return { ok: true, cleanBody: body.slice(0, MAX_BODY) }
  }
  if (s.kind === "video") {
    const url = (s.videoUrl ?? "").trim()
    if (!url) return { ok: false, reason: "No video was uploaded." }
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "Invalid video URL." }
    return { ok: true, cleanBody: null }
  }
  return { ok: false, reason: "Unknown testimonial kind." }
}
