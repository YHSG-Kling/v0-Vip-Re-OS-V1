// lib/buyer-search/fair-housing.ts
//
// FAIR-HOUSING SANITIZER (pure) — buyer-facing property copy must never steer on a protected class.
// The Fair Housing Act + NAR Code of Ethics prohibit marketing that signals a preference based on
// familial status (kids/family/schools-as-proxy), age (seniors/retirees), or other protected classes
// (race, religion, disability, national origin). Competitors get sued for exactly this; our whole
// differentiator is compliance built into the rail. This strips/neutralizes protected-class steering
// from any string we GENERATE for a buyer (search match explanations, headlines, CTAs) — a last-line
// guard that runs regardless of how upstream copy was produced. Pure (no I/O), unit-tested directly.
//
// It does NOT censor a buyer's own words (a buyer may search "near good schools"); it only cleans the
// copy WE author and show. Property facts (beds, baths, price, sqft, single-story) are never protected
// and pass through untouched.

export interface FairHousingScan {
  clean: string
  /** the protected-class phrases that were neutralized (for audit/logging). */
  flagged: string[]
}

export interface FairHousingOpts {
  /**
   * Set true ONLY when the property is a verified housing-for-older-persons (55+/62+) community — the
   * Fair Housing Act's age exemption. When true, age language (55+, senior, active-adult) is permitted
   * and left intact; otherwise it is neutralized. Default false (the safe default).
   */
  seniorCommunity?: boolean
}

/**
 * ALWAYS-neutralized steering — illegal regardless of context. Note what is DELIBERATELY allowed:
 *   · factual PROXIMITY ("near schools", "close to work", "minutes to downtown") is legal and untouched;
 *   · NAMING a neighborhood is legal and untouched;
 *   · only the protected-class STEERING (familial-status marketing, safety/crime proxies, and quality
 *     adjectives that editorialize schools into a familial-status signal) is removed.
 */
const ALWAYS: Array<{ re: RegExp; to: string; label: string }> = [
  // ── Familial status (the most common real-estate FHA trap) ──
  { re: /\byour family['’]s [a-z ]*?needs\b/gi, to: "your needs", label: "familial-status" },
  { re: /\b(your |a )?growing family\b/gi, to: "your needs", label: "familial-status" },
  { re: /\bsee it in person with your family\b/gi, to: "see it in person", label: "familial-status" },
  { re: /\bwith your family\b/gi, to: "", label: "familial-status" },
  { re: /\bfor your family\b/gi, to: "for you", label: "familial-status" },
  { re: /\bfamily[- ]friendly\b/gi, to: "well-located", label: "familial-status" },
  { re: /\b(perfect|great|ideal) for families\b/gi, to: "well-located", label: "familial-status" },
  { re: /\bkid[- ]friendly\b/gi, to: "well-located", label: "familial-status" },
  { re: /\bchild[- ]friendly\b/gi, to: "well-located", label: "familial-status" },
  { re: /\bperfect for (kids|children)\b/gi, to: "well-located", label: "familial-status" },

  // ── Schools: factual proximity is fine; strip only the editorializing QUALITY adjective, keep the
  //    noun so "near the school district" / "close to schools" survives. ──
  { re: /\b(top[- ]rated|top|great|good|excellent|highly[- ]rated|best)\s+(school district|schools?)\b/gi, to: "$2", label: "schools-quality" },

  // ── Safety/crime as a proxy (explicitly not allowed) ──
  { re: /\b(very |extremely )?safe neighborhood\b/gi, to: "neighborhood", label: "safety-proxy" },
  { re: /\b(very |extremely )?safe area\b/gi, to: "area", label: "safety-proxy" },
  { re: /\bcrime[- ]free\b/gi, to: "", label: "safety-proxy" },

  // ── Religion / national origin proxies ──
  { re: /\bwalking distance to (church|churches|synagogue|mosque|temple)\b/gi, to: "a walkable location", label: "religion" },
]

/** Age steering — neutralized UNLESS the property is a verified 55+ community (FHA age exemption). */
const AGE: Array<{ re: RegExp; to: string; label: string }> = [
  { re: /\bperfect for (seniors|retirees)\b/gi, to: "low-maintenance", label: "age" },
  { re: /\bsenior[- ]friendly\b/gi, to: "low-maintenance", label: "age" },
  { re: /\bempty[- ]nesters?\b/gi, to: "", label: "age" },
]

/** Tidy whitespace/punctuation left behind by removals, and fix capitalization. Pure. */
function tidy(s: string): string {
  return s
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;]+/, "")
    .trim()
    // Capitalize the first letter of each sentence we may have disturbed.
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())
}

/**
 * Neutralize protected-class steering in a single string. Pure + total. Returns the cleaned text plus
 * the labels of what was flagged (for an honest audit trail). Empty/whitespace → unchanged.
 */
export function scanFairHousing(text: string, opts: FairHousingOpts = {}): FairHousingScan {
  if (!text || !text.trim()) return { clean: text ?? "", flagged: [] }
  let out = text
  const flagged: string[] = []
  const rules = opts.seniorCommunity ? ALWAYS : [...ALWAYS, ...AGE]
  for (const { re, to, label } of rules) {
    if (re.test(out)) {
      flagged.push(label)
      out = out.replace(re, to)
    }
  }
  return { clean: flagged.length ? tidy(out) : text, flagged: Array.from(new Set(flagged)) }
}

/** Convenience: the cleaned string only. Pure. */
export function sanitizeFairHousing(text: string, opts: FairHousingOpts = {}): string {
  return scanFairHousing(text, opts).clean
}

/** Sanitize a whole buyer-facing match explanation (headline + bullets + narrative + CTA). Pure. */
export function sanitizeExplanation<T extends { headline: string; bullets: string[]; narrative: string; callToAction: string }>(exp: T, opts: FairHousingOpts = {}): T {
  return {
    ...exp,
    headline: sanitizeFairHousing(exp.headline, opts),
    bullets: (exp.bullets ?? []).map((b) => sanitizeFairHousing(b, opts)).filter((b) => b.trim().length > 0),
    narrative: sanitizeFairHousing(exp.narrative, opts),
    callToAction: sanitizeFairHousing(exp.callToAction, opts),
  }
}
