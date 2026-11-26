/**
 * lib/lead-intelligence/visitor-link-decision.ts — THE rule that decides whether a website visit may be linked to a
 * record the tenant already holds (wave 156, lane 156F; owner: "the anonymous visitor sometimes can be identified using
 * a provider, and if you can't do it, we don't need to include it").
 *
 * A visit is linked to a Contact or Lead ONLY on a first-party act — the visitor typed an email or phone into the
 * tenant's own form (app/api/track/identify/route.ts) or ticked a consented capture (visitor-email-capture.ts) — and
 * ONLY when that act points at exactly one person. Nothing here infers anyone from an IP address, a device, a
 * geolocation or a vendor's identity graph: no such input exists in the signature, by design.
 *
 * PURE (no network, no database) — the two doors that link call it, and scripts/wave156-f-visitor-truth-guard.ts
 * drives it and both doors.
 */

/** What one identifier the visitor supplied resolved to, inside ONE tenant. */
export interface IdentifierLookup {
  /** The row ids that identifier matched (the caller reads at most two — two is already "more than one"). */
  ids: string[]
  /** The read was refused (supabase-js RESOLVES refusals — CLAUDE.md §3). */
  refused: boolean
}

export type VisitorLinkVerdict =
  | { link: true; id: string }
  | { link: false; reason: "no_match" | "ambiguous_identifier" | "identifiers_disagree" | "lookup_refused" }

/**
 * Link only a CERTAIN match:
 *   · a refused read anywhere → nothing (fail closed — "could not check" is not "no one");
 *   · an identifier that matches two or more rows (a household phone, a shared inbox) → nothing;
 *   · identifiers that resolve to DIFFERENT rows (one person's email, another's phone) → nothing;
 *   · every identifier that matched names the same single row → that row.
 * An identifier that matched nobody does not veto one that matched exactly one (the visitor may have typed a new
 * phone number beside a known email).
 */
export function decideVisitorLink(lookups: IdentifierLookup[]): VisitorLinkVerdict {
  if (lookups.some((l) => l.refused)) return { link: false, reason: "lookup_refused" }
  const matched = lookups.filter((l) => l.ids.length > 0)
  if (matched.length === 0) return { link: false, reason: "no_match" }
  if (matched.some((l) => new Set(l.ids).size > 1)) return { link: false, reason: "ambiguous_identifier" }
  const distinct = new Set(matched.map((l) => l.ids[0]))
  if (distinct.size > 1) return { link: false, reason: "identifiers_disagree" }
  return { link: true, id: matched[0].ids[0] }
}
