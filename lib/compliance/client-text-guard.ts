/**
 * lib/compliance/client-text-guard.ts
 *
 * Wave 54/56 — the SINGLE source of truth for "is this text safe to show a client".
 * Pure, no imports — shared by the client-facing producers AND the autonomous-manager
 * eval harness so the control and the audit can't drift.
 *
 * REAL-ESTATE-AWARE (Wave 56 correction): real estate is territory- and team-specific.
 * A listing ad NEEDS the real city/ZIP (it's how buyers find the home) and the agent's
 * name IS the sign-off (so the client knows the message is from THEIR agent). Many
 * legitimate place + person names also contain a token that, in isolation, looks like a
 * protected class — e.g. an agent named "Christian", a city "Christiansburg" or
 * "Kingdom City", a team "Family First Realty". Blunt single-token blocking would strip
 * these and corrupt legitimate marketing. So the rule is:
 *   • Fair-Housing violation = an unambiguous STEERING PHRASE (multi-word) — never a bare
 *     proper-noun token. This is what HUD/the FHA actually polices in ad COPY.
 *   • Injected directives (OWASP LLM-01) are always stripped.
 *   • A factual proper-noun field (city/ZIP, agent sign-off) is PRESERVED — only its
 *     injected tail is removed; it's rejected only if a real steering phrase remains.
 */

// Unambiguous protected-class / steering PHRASES under the Fair Housing Act (42 U.S.C.
// §3604) + HUD advertising guidance. Multi-word so a bare proper-noun token (a city or an
// agent's name) is never a false positive — only an actual steering claim trips it.
export const FAIR_HOUSING_VIOLATION =
  /\b(perfect for (?:a )?(?:famil|coupl|christ|jewish|muslim|young|growing|retired|single)|ideal for (?:a )?(?:famil|coupl|christ|young|growing)|family[- ]friendly|families only|kid[- ]friendly|child(?:ren)?[- ]friendly|no (?:kids|children)|children welcome|adults?[- ]only|empty[- ]nesters?|safe neighborhood|good schools|great schools|excellent schools|christian (?:community|families|neighborhood)|church[- ]going|jewish (?:community|neighborhood)|exclusive (?:community|neighborhood)|mother[- ]in[- ]law (?:suite)?|bachelor pad|able[- ]bodied|walking distance to (?:a )?(?:church|synagogue|mosque|temple)|near (?:churches|synagogues|mosques)|integrated (?:community|neighborhood)|traditional famil)\b/i

// Prompt-injection / instruction-override markers (OWASP LLM-01) that must never ride a data field.
export const INJECTION_PATTERN =
  /\b(ignore (?:all|the|previous|prior) (?:instructions|prompts?)|disregard (?:all|the|previous)|system prompt|you are now|act as|write ['"])/i

/** True when assembled client-facing COPY contains an unambiguous steering phrase. */
export function hasFairHousingViolation(text: string): boolean {
  return FAIR_HOUSING_VIOLATION.test(text)
}

/**
 * Sanitize a FACTUAL proper-noun field (a listing's city/ZIP, an agent's display name)
 * before weaving it into client-facing copy. Real-estate-aware: it PRESERVES the
 * legitimate proper noun (the city you're marketing, the agent signing off) and only:
 *   1. strips an appended injected directive (keeping the legit leading portion), and
 *   2. rejects (→ null, caller falls back to a neutral default) when an unambiguous
 *      steering phrase remains.
 * A bare city/ZIP or a name like "Christian Mendoza" passes through untouched.
 */
export function sanitizeProperNoun(raw: string | null | undefined, maxLen = 60): string | null {
  if (!raw) return null
  let s = String(raw).replace(/\s+/g, " ").trim()
  // Keep only the portion before any injected directive ("Springfield — IGNORE …" → "Springfield").
  const inj = s.search(INJECTION_PATTERN)
  if (inj >= 0) s = s.slice(0, inj)
  // Injection bait often quotes the steering copy; drop a quoted tail.
  s = s.replace(/["'].*$/s, "")
  // Trim dangling clause separators / punctuation, then cap length.
  s = s.replace(/[\s,;:—–|-]+$/u, "").trim().slice(0, maxLen).trim()
  if (!s) return null
  if (FAIR_HOUSING_VIOLATION.test(s)) return null  // a real steering phrase survived → unsafe
  return s
}
