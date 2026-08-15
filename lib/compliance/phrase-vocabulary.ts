/**
 * lib/compliance/phrase-vocabulary.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VOCABULARY AND THE COMPILE CHECK FOR `prohibited_phrases`, in ONE place.
 *
 * Pure — no DB, no session. Imported by BOTH the server action
 * (app/actions/compliance-phrases.ts) and the settings panel
 * (app/dashboard/settings/components/prohibited-phrases-panel.tsx), so the
 * choices the screen offers cannot drift from the values the column accepts.
 * Same shape as lib/lead-assignment/rule-matcher, which serves the lead-routing
 * action/panel pair for exactly this reason.
 *
 * TWO THINGS THIS FILE EXISTS TO PREVENT:
 *
 * 1. A SEVERITY THE COLUMN REJECTS. `prohibited_phrases_severity_check` is live
 *    and admits only {info, warning, critical}. A free-text severity field would
 *    hand the user a 23514 from Postgres as their error message. Worse, the two
 *    vocabularies that meet in the scanner do NOT intersect on the value that
 *    decides pass/fail: lib/application/compliance-monitoring.ts grades
 *    {info, warning, blocking} and maps critical → blocking. So `critical` is
 *    the ONLY stored value that actually stops content, and the labels below say
 *    that out loud rather than leaving a broker to discover it from a scan that
 *    found their word and cleared the copy anyway.
 *
 * 2. A PATTERN THAT DOES NOT COMPILE. The scanner builds
 *      new RegExp(phrase.phrase_pattern || phrase.phrase, "gi")
 *    inside the loop over the whole catalogue, and deliberately does not catch —
 *    a scan that cannot compile its own catalogue must fail loudly rather than
 *    skip a phrase and report the content clean. That is correct there, and it
 *    means ONE bad row taken from a settings form takes down EVERY scan for
 *    EVERY tenant that reads the row, not just its own phrase.
 *
 *    Note the fallback: with no pattern, the PHRASE ITSELF is compiled as a
 *    regex. So `**reduced**` or `50% off (limited)` are just as lethal as a bad
 *    pattern. validateEffectivePhrasePattern therefore checks what the scanner
 *    will ACTUALLY compile, not just the optional pattern field.
 */

/** The live CHECK constraint, verbatim. */
export const PHRASE_SEVERITIES = ["info", "warning", "critical"] as const

export type PhraseSeverity = (typeof PHRASE_SEVERITIES)[number]

export function isPhraseSeverity(value: unknown): value is PhraseSeverity {
  return typeof value === "string" && (PHRASE_SEVERITIES as readonly string[]).includes(value)
}

/** Short label for a picker. */
export const PHRASE_SEVERITY_LABELS: Record<PhraseSeverity, string> = {
  info: "Info — note it only",
  warning: "Warning — flag for review",
  critical: "Critical — block the content",
}

/** What the severity DOES, stated in terms of the scan's actual behaviour. */
export const PHRASE_SEVERITY_HELP: Record<PhraseSeverity, string> = {
  info:
    "The phrase is recorded on the scan result and shown to the agent. It does not " +
    "hold the content back.",
  warning:
    "The phrase is listed as an issue for a reviewer to read. It still does not hold " +
    "the content back — only Critical does that.",
  critical:
    "The only severity that makes content FAIL the scan. The compose-time gate maps " +
    "Critical to blocking, so content containing this phrase cannot be reported " +
    "compliant. Use it for anything you will not let leave the brokerage.",
}

/**
 * Categories already in the catalogue, plus the one a brokerage's own words
 * normally belong to. `category` is nullable with no CHECK and no vocabulary
 * baseline, so this list is a convenience, not a constraint — but it keeps a
 * tenant's rows grouping alongside the federal ones on the screens that render
 * `issue.category` (app/components/compliance/FairHousingScanner.tsx).
 */
export const PHRASE_CATEGORIES = [
  "brokerage_policy",
  "fair_housing",
  "marketing",
  "respa",
  "udaap",
  "them_first",
] as const

export type PhraseCategory = (typeof PHRASE_CATEGORIES)[number]

export const PHRASE_CATEGORY_LABELS: Record<PhraseCategory, string> = {
  brokerage_policy: "Brokerage policy",
  fair_housing: "Fair Housing",
  marketing: "Marketing claims",
  respa: "RESPA",
  udaap: "UDAAP",
  them_first: "Client-first language",
}

/** What the default severity should be for a word a brokerage adds by hand. */
export const DEFAULT_PHRASE_SEVERITY: PhraseSeverity = "warning"
export const DEFAULT_PHRASE_CATEGORY: PhraseCategory = "brokerage_policy"

export type PatternCheck =
  | { ok: true; effectivePattern: string; usedFallback: boolean }
  | { ok: false; error: string }

/**
 * Compile exactly what lib/application/compliance-monitoring.ts:scanForProhibitedPhrases
 * will compile — `phrase_pattern || phrase`, flags "gi" — and report the failure in
 * words a broker can act on.
 *
 * Called on every add and every update BEFORE the row reaches the database. A row
 * that fails here is refused; a row that passes here cannot be the row that aborts
 * a scan.
 */
export function validateEffectivePhrasePattern(
  phrase: string,
  phrasePattern?: string | null,
): PatternCheck {
  const trimmedPhrase = phrase.trim()
  const trimmedPattern = phrasePattern?.trim() || null
  const effective = trimmedPattern || trimmedPhrase

  if (!effective) {
    return { ok: false, error: "A phrase is required — there is nothing for the scan to look for." }
  }

  try {
    // Same construction and flags as the scanner. If this throws there, the whole
    // scan aborts; if it throws here, one save is refused and nothing else breaks.
    new RegExp(effective, "gi")
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: trimmedPattern
        ? `That match pattern is not a valid regular expression (${detail}). ` +
          "Fix the pattern, or clear it and let the scan match the phrase itself."
        : `The phrase "${trimmedPhrase}" contains regular-expression characters that do not ` +
          `compile (${detail}). With no match pattern set, the scan compiles the phrase itself ` +
          "as a pattern. Escape the special characters (\\ before each), or supply a valid " +
          "match pattern.",
    }
  }

  return { ok: true, effectivePattern: effective, usedFallback: !trimmedPattern }
}
