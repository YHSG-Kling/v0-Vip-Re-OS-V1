/**
 * lib/recruiting/recruiting-pitch-limits.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE definition of how long a brokerage's recruiting pitch may be, shared by
 * the editor (app/dashboard/recruiting-roi/recruiting-pitch-panel.tsx, which
 * caps the textarea) and the writer (app/actions/settings/recruiting-pitch.ts,
 * which refuses anything longer). Two copies of the number would let the form
 * accept text the action then rejects.
 *
 * It lives HERE rather than in the action because that file carries "use server":
 * every export in one is a public HTTP endpoint and must be async (CLAUDE.md §4),
 * so a plain constant cannot live there. Client-safe on purpose — no imports.
 */

/** Long enough to be a real pitch, short enough to render as a landing-page hero. */
export const RECRUITING_PITCH_MAX = 2000
