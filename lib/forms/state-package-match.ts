/**
 * lib/forms/state-package-match.ts — PURE: the state's form PACKAGE against the agent's library.
 *
 * The owner's ask: "the real estate agent can pull local form packages for listing agreements,
 * offers, etc." The package DEFINITION already exists — lib/state-forms/registry.ts (all 50
 * states + DC, offer and listing bundles: required forms, addenda, agency disclosure) — and the
 * FILES exist in the brokerage/team/agent library the FormWizard lists. Nothing joined them, so
 * the agent picked forms one by one with no idea what their state requires. This joins them:
 * each required form is matched to a library file by name (token overlap, never a guess across
 * states), and what is NOT in the library is named so the agent knows to add it or use the
 * provider's library.
 */

const STOP = new Set(["the", "a", "an", "of", "and", "to", "for", "or", "in", "on", "form", "pdf", "docx", "residential", "real", "estate"])

/** PURE: the comparable tokens of a form name or file name.
 */
function formTokens(name: string, stateCode?: string | null): string[] {
  const sc = (stateCode ?? "").toLowerCase()
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && t !== sc)
}

export interface PackageMatch<F> {
  required: string
  kind: "required" | "agency" | "addendum"
  file: F | null
  score: number
}

/**
 * PURE: match each package form to the best library file. A match needs ≥ 60% of the package
 * form's tokens present in the file name (or the file carrying every token of a short form
 * code like "RPA"). Each file is used once.
 */
export function matchStatePackage<F extends { name: string }>(
  pkg: { required: string[]; addenda: string[]; brokerageRepresentation: string },
  files: F[],
  stateCode?: string | null,
): PackageMatch<F>[] {
  const used = new Set<number>()
  const wanted: Array<{ name: string; kind: PackageMatch<F>["kind"] }> = [
    ...pkg.required.map((n) => ({ name: n, kind: "required" as const })),
    ...(pkg.brokerageRepresentation && !pkg.required.includes(pkg.brokerageRepresentation)
      ? [{ name: pkg.brokerageRepresentation, kind: "agency" as const }] : []),
    ...pkg.addenda.map((n) => ({ name: n, kind: "addendum" as const })),
  ]
  const fileTokens = files.map((f) => new Set(formTokens(f.name, stateCode)))
  return wanted.map((w) => {
    const need = formTokens(w.name, stateCode)
    let best = -1, bestScore = 0
    fileTokens.forEach((ft, i) => {
      if (used.has(i) || need.length === 0) return
      const hit = need.filter((t) => ft.has(t)).length
      const score = hit / need.length
      if (score > bestScore) { bestScore = score; best = i }
    })
    if (best >= 0 && bestScore >= 0.6) {
      used.add(best)
      return { required: w.name, kind: w.kind, file: files[best], score: bestScore }
    }
    return { required: w.name, kind: w.kind, file: null, score: bestScore }
  })
}
