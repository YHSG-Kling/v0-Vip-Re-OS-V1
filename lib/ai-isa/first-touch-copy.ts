// lib/ai-isa/first-touch-copy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THEM-FIRST first-touch email copy — cohort-toned + brand-voiced, replacing the
// hardcoded template that ignored both the lead's generation and the brokerage brand.
//
//   • GENERATIONAL TONE — the opener adapts to the lead's cohort (the SAME canonical
//     vocabulary the portal education + adaptive re-engagement use): terse for gen-z,
//     warm/relationship-led for boomer, efficient for gen-x.
//   • BRAND VOICE — the brokerage tagline + the assistant's name/persona carry the
//     brand's voice into the sign-off (it was loaded but never applied).
//
// FAIR HOUSING SAFE BY CONSTRUCTION: tone only — never references race, religion, sex,
// national origin, disability, familial status, or age itself (the first-touch-copy
// simulator asserts this). The evaluateOutbound compliance gate + the brand's
// prohibited-word screen still run downstream before any send.

import type { GenerationalCohort } from "@/lib/kernel/education"

// Cohort-appropriate first-touch OPENER (an introduction tone — distinct from the
// re-engagement follow-up). Style only; no protected-class language.
const COHORT_OPENER: Record<GenerationalCohort, string> = {
  gen_z:      "Saw you were checking out",
  millennial: "I noticed you've been exploring",
  gen_x:      "I see you're looking into",
  boomer:     "Thanks for taking the time to look into",
  silent:     "It's a pleasure to connect with you about",
  unknown:    "I noticed you're exploring",
}

// Cohort-appropriate closing nudge — pace/warmth only.
const COHORT_CLOSE: Record<GenerationalCohort, string> = {
  gen_z:      "Reply whenever — even a one-liner helps.",
  millennial: "Reply anytime and I'll make the next step easy.",
  gen_x:      "Reply when it's convenient and I'll get you what you need.",
  boomer:     "Please feel free to reply whenever the timing feels right — I'm glad to help.",
  silent:     "Please reach out at your convenience; there is no rush at all.",
  unknown:    "Just reply to this email whenever you're ready and I'll take it from there.",
}

export interface FirstTouchCopyInput {
  firstName: string
  cohort: GenerationalCohort
  propertyInterest?: string | null
  timeline?: string | null
  motivationType?: string | null
  budgetMin?: number | null
  budgetMax?: number | null
  /** Assistant name (brand voice's human face) used to sign off. */
  assistantName: string
  personaLabel?: string | null
  /** Brokerage brand tagline — carries the brand voice into the message. */
  brandTagline?: string | null
  /** True when a personalized intro video is embedded below the body. */
  hasVideo?: boolean
}

export interface FirstTouchCopy {
  subject: string
  body: string
}

/** PURE. Compose the cohort-toned, brand-voiced first-touch email. */
export function buildFirstTouchEmail(i: FirstTouchCopyInput): FirstTouchCopy {
  const opener = COHORT_OPENER[i.cohort] ?? COHORT_OPENER.unknown
  const close = COHORT_CLOSE[i.cohort] ?? COHORT_CLOSE.unknown
  const interest = i.propertyInterest?.trim() || "properties in the area"
  const timelinePart = i.timeline?.trim() ? ` with a view to ${i.timeline.trim()}` : ""
  const motivation = i.motivationType?.trim()
    ? `Understanding where you're at, I wanted to share a few insights that fit your situation.`
    : `I wanted to share a few resources that might be useful for you.`
  const budgetPart =
    typeof i.budgetMin === "number" && typeof i.budgetMax === "number"
      ? `Working within $${i.budgetMin.toLocaleString()}–$${i.budgetMax.toLocaleString()}, `
      : ""
  const videoLine = i.hasVideo
    ? "I've put together a short personal video below that walks through exactly how we can help."
    : "I'd love to walk you through exactly how we can help whenever you have a moment."

  const taglineLine = i.brandTagline?.trim() ? `\n${i.brandTagline.trim()}` : ""

  const body = [
    `Hi ${i.firstName},`,
    "",
    `${opener} ${interest}${timelinePart}. ${motivation}`,
    "",
    `${budgetPart}${videoLine}`,
    ...(i.hasVideo ? ["", "[Video will be embedded here]"] : []),
    "",
    `This isn't about pushing you into anything — it's about making sure you have the right information whenever you're ready.`,
    "",
    close,
    "",
    `Best regards,`,
    `${i.assistantName}${i.personaLabel ? `\n${i.personaLabel}` : ""}${taglineLine}`,
  ].join("\n")

  const subject = i.propertyInterest?.trim()
    ? `About your ${i.propertyInterest.trim()} search`
    : `Resources for ${i.firstName}`

  return { subject, body }
}
