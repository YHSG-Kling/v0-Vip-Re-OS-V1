/**
 * lib/branding/formality.ts — THE formality vocabulary (CLAUDE.md §6: one spelling per idea).
 * PURE (no I/O) so client components, server actions and prompt builders all import it.
 *
 * Live CHECKs (identical on both tables, scripts/check-vocabularies.ts):
 *   brand_voice_profile.formality_level   ∈ formal | semi_formal | casual
 *   ai_identity_profiles.formality_level  ∈ formal | semi_formal | casual
 *
 * Wave 93 (lane 93D) live walk: the onboarding brand wizard defaulted to "semi-formal" (hyphen)
 * and the website-widget settings to "conversational" — neither is admitted, so the brand-voice
 * save (23514 brand_voice_profile_formality_level_check) and the widget assistant save were
 * refused for every user who kept the default. Writers now normalize through this module and
 * refuse an unknown value out loud instead of handing Postgres a value it will reject.
 */
export const FORMALITY_LEVELS = ["formal", "semi_formal", "casual"] as const
export type FormalityLevel = (typeof FORMALITY_LEVELS)[number]

export const FORMALITY_LABELS: Record<FormalityLevel, string> = {
  formal: "Formal",
  semi_formal: "Semi-Formal",
  casual: "Casual",
}

/** Legacy spellings that shipped in UI literals → the canonical value. */
const LEGACY: Record<string, FormalityLevel> = {
  "semi-formal": "semi_formal",
  semiformal: "semi_formal",
  "semi formal": "semi_formal",
  conversational: "casual",
}

/** Canonical value, or null when the input is not a formality level at all (caller refuses). */
export function normalizeFormalityLevel(value: string | null | undefined): FormalityLevel | null {
  if (value == null) return null
  const v = String(value).trim().toLowerCase()
  if ((FORMALITY_LEVELS as readonly string[]).includes(v)) return v as FormalityLevel
  return LEGACY[v] ?? null
}
