// lib/format/html.ts
// THE THREE HTML-ESCAPE FORMATTERS (§6 — one vocabulary per function). Nine
// private `escapeHtml` copies lived across the repo, in three DIFFERENT
// entity sets — found by scripts/duplicate-function-census.ts's SAME BODY
// pass (round 3, 2026-09-09). Each set is kept as its own export rather than
// merged onto the widest one: narrowing a caller's escaping to only what it
// actually emits is deliberate where the body is known not to contain a
// quote or apostrophe, and widening it silently would be an unreviewed
// behavior change at nine call sites for a merge whose only job is dedup.
//
// PURE LEAF — no imports, importable on either side of the Remotion/kernel
// bundling wall (see lib/format/ordinal.ts).

/**
 * Escapes &, <, >, ", ' — the full HTML/attribute-safe entity set. Survivor
 * for two byte-identical copies: app/actions/ai-newsletter.ts:3 and
 * app/crm/components/os/buyer-match-panel.tsx:35.
 */
export function escapeHtmlFull(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Escapes &, <, >, " — no apostrophe. Survivor for FIVE byte-identical
 * copies: app/actions/team-branding.ts:542, app/api/podcast/widget/route.ts:109,
 * lib/home-value/report-email.ts:77, lib/kernel/client-welcome.ts:431,
 * lib/kernel/newsletter/assemble.ts:169.
 */
export function escapeHtmlBasic(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Escapes &, <, > only — no quote entities. Survivor for two byte-identical
 * copies: lib/campaign-sequences/render-step.ts:233 and
 * lib/showings/dispatchers.ts:357.
 */
export function escapeHtmlMinimal(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
