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

/**
 * Ordered neutralizations. Each entry rewrites a protected-class STEERING phrase into a neutral,
 * fact-based equivalent (or removes it). Order matters — more specific phrases first.
 */
const NEUTRALIZATIONS: Array<{ re: RegExp; to: string; label: string }> = [
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

  // ── Schools as a familial-status proxy (steering) ──
  { re: /\b(top-rated|top|great|good|excellent|highly[- ]rated)\s+school district\b/gi, to: "great location", label: "schools-proxy" },
  { re: /\bschool district\b/gi, to: "location", label: "schools-proxy" },
  { re: /\b(top-rated|top|great|good|excellent|highly[- ]rated)\s+schools\b/gi, to: "great location", label: "schools-proxy" },

  // ── Safety/crime as a proxy ──
  { re: /\b(very |extremely )?safe neighborhood\b/gi, to: "neighborhood", label: "safety-proxy" },
  { re: /\b(very |extremely )?safe area\b/gi, to: "area", label: "safety-proxy" },
  { re: /\bcrime[- ]free\b/gi, to: "", label: "safety-proxy" },

  // ── Age (seniors / retirees) ──
  { re: /\bperfect for (seniors|retirees)\b/gi, to: "low-maintenance", label: "age" },
  { re: /\bsenior[- ]friendly\b/gi, to: "low-maintenance", label: "age" },
  { re: /\bempty[- ]nesters?\b/gi, to: "", label: "age" },

  // ── Religion / national origin proxies ──
  { re: /\bwalking distance to (church|churches|synagogue|mosque|temple)\b/gi, to: "a walkable location", label: "religion" },
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
export function scanFairHousing(text: string): FairHousingScan {
  if (!text || !text.trim()) return { clean: text ?? "", flagged: [] }
  let out = text
  const flagged: string[] = []
  for (const { re, to, label } of NEUTRALIZATIONS) {
    if (re.test(out)) {
      flagged.push(label)
      out = out.replace(re, to)
    }
  }
  return { clean: flagged.length ? tidy(out) : text, flagged: Array.from(new Set(flagged)) }
}

/** Convenience: the cleaned string only. Pure. */
export function sanitizeFairHousing(text: string): string {
  return scanFairHousing(text).clean
}

/** Sanitize a whole buyer-facing match explanation (headline + bullets + narrative + CTA). Pure. */
export function sanitizeExplanation<T extends { headline: string; bullets: string[]; narrative: string; callToAction: string }>(exp: T): T {
  return {
    ...exp,
    headline: sanitizeFairHousing(exp.headline),
    bullets: (exp.bullets ?? []).map(sanitizeFairHousing).filter((b) => b.trim().length > 0),
    narrative: sanitizeFairHousing(exp.narrative),
    callToAction: sanitizeFairHousing(exp.callToAction),
  }
}
