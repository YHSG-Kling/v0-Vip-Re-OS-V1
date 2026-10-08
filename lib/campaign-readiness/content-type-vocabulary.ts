// lib/campaign-readiness/content-type-vocabulary.ts
//
// PURE content-type converters, extracted OUT of
// app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts (wave 57,
// Task C) — a "use server" file may only export async functions
// (scripts/use-server-export-guard.ts §4), and these two are deliberately
// synchronous, no-I/O string mappers. Living here lets any client component
// import them directly (no Server Action round trip for a pure switch), and
// lets ad-os-actions.ts's own async exports keep using them too.
//
// toGateContentType(toReadinessContentType(x)) converts an arbitrary
// caller-supplied string all the way to runComplianceGate's narrower
// vocabulary in one composable step.

import type { ContentType as ReadinessContentType } from "@/lib/campaign-readiness/readiness-evaluator"

/** Readiness ContentType vocabulary (lib/campaign-readiness/readiness-evaluator). */
const READINESS_CONTENT_TYPES = [
  "email", "sms", "social_post", "ad", "newsletter", "blog_post",
  "listing_description", "video_script", "direct_mail", "image_prompt",
] as const

export function toReadinessContentType(value: string): ReadinessContentType {
  if ((READINESS_CONTENT_TYPES as readonly string[]).includes(value)) {
    return value as ReadinessContentType
  }
  // Predictor vocabulary → readiness vocabulary
  if (value === "ad_creative") return "ad"
  return "social_post"
}

/** Compliance content_type vocabulary accepted by runComplianceGate
 *  (lib/kernel/marketing/real-estate-compliance-gate.ts). */
export function toGateContentType(
  value: ReadinessContentType
): "social_post" | "ad" | "listing_remarks" | "comment_reply" | "newsletter" | "blog" {
  switch (value) {
    case "ad": return "ad"
    case "newsletter":
    case "email": return "newsletter"
    case "blog_post": return "blog"
    case "listing_description": return "listing_remarks"
    default: return "social_post"
  }
}
