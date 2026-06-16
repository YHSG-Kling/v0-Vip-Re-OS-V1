// lib/intelligence/winback-personalization.ts
//
// WIN-BACK PERSONALIZATION (pure). A dormant win-back video lands only when it feels one-to-one —
// "Hey Pat, it's been three years since you got the keys on Maple St — you crossed my mind today."
// This turns a contact's REAL relationship facts (their name, that they're a past client, their home
// anniversary, their city) into a persona + a short list of grounded, Fair-Housing-safe facts the
// ElevenLabs/D-ID script may use. The persona + the "last positive moment" (the close anniversary)
// are exactly what the Video Director feeds generatePersonaCopy so the hook is personal, not generic.
//
// Fair Housing: only the relationship's OWN transaction facts (a home anniversary, the city they're
// in) and first name are surfaced — NEVER protected-class signals (age, family, income, marital
// status). Those may TIME outreach upstream but never become copy facts. Pure (no I/O), unit-tested.

import type { CopyPersona } from "@/lib/kernel/ai-copy"

export interface WinbackContactFacts {
  firstName: string | null
  contactType: string | null
  /** ISO date of their home close/purchase anniversary — the warm anchor for a past client. */
  homeAnniversary: string | null
  city: string | null
  /** evaluation clock (testable); defaults to now. */
  now?: string
}

export interface WinbackPersonalization {
  persona: CopyPersona
  /** Grounded, Fair-Housing-safe facts the win-back script may use (no fabrication). */
  facts: string[]
  /** True when a concrete positive moment (a home anniversary) anchors the note. */
  hasPositiveMoment: boolean
}

const DAY = 86_400_000

function yearsSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.floor((nowMs - t) / (365 * DAY))
}

/** Whether a contact_type marks a relationship we'd anchor on a home anniversary. */
function isPastClient(contactType: string | null): boolean {
  return /past|closed|sphere|repeat|client/.test((contactType ?? "").toLowerCase())
}

/**
 * Build the persona + the grounded "last positive moment" facts for a dormant win-back. Pure.
 *
 * The home anniversary is the emotional anchor: for a past client we say how long it's been since
 * they got the keys; everyone else gets a warm "we've worked together before" reconnect with no
 * fabricated milestone. The first name and city personalize without touching anything protected.
 */
export function winbackPersonalization(input: WinbackContactFacts): WinbackPersonalization {
  const nowMs = new Date(input.now ?? new Date().toISOString()).getTime()
  const name = (input.firstName ?? "").trim() || null
  const pastClient = isPastClient(input.contactType)
  const years = yearsSince(input.homeAnniversary, nowMs)
  const hasPositiveMoment = pastClient && years !== null

  const persona: CopyPersona = {
    name,
    audience: pastClient ? "past_client" : (input.contactType ?? "audience"),
    situation: pastClient
      ? "a past client we helped into their home, out of touch for a while — reconnect warmly"
      : "someone we've worked with before, out of touch for a while — reconnect warmly",
  }

  const facts: string[] = []
  if (name) facts.push(`First name: ${name}`)
  if (hasPositiveMoment) {
    facts.push(
      years! <= 0
        ? "They closed on their home within the past year — a fresh, happy milestone to celebrate."
        : `It has been ${years} year${years === 1 ? "" : "s"} since they got the keys to their home.`,
    )
  }
  if (input.city && input.city.trim()) facts.push(`They're in ${input.city.trim()}.`)
  // The always-true intent so the script has a warm reason even with no anniversary on file.
  facts.push("Reconnecting personally after time apart — no pitch, just a genuine check-in.")

  return { persona, facts, hasPositiveMoment }
}
