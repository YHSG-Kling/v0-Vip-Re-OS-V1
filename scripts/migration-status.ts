/**
 * scripts/migration-status.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE — a migration file's SELF-STATED status, read from its own header.
 *
 * Extracted from scripts/migration-claim-guard.ts (§6: one header classifier,
 * not a second regex) so a second script can cross-check a migration's status
 * WITHOUT importing migration-claim-guard.ts itself — that file runs its whole
 * guard suite (including a live-credentials ledger check and `process.exit(1)`
 * on failure) at module top level, so importing it from anywhere but its own
 * `npm run test:migration-claim` invocation would execute a second, unwanted
 * copy of that suite as a side effect of the import. This module has none: it
 * is the one pure function both scripts need, with no execution on import.
 *
 * migration-claim-guard.ts re-exports `Claim`/`claimOf` from here so its own
 * `npm run` entry point is unchanged; scripts/hidden-wire-census.ts's (d) ratchet
 * imports directly from here.
 */

/**
 * A migration's stated status, read from its header.
 *
 * THE HEADER ONLY. A migration body legitimately contains the words "not
 * applied" inside an explanatory paragraph about some OTHER migration — the
 * whole reason this repo writes long headers — so a whole-file scan would
 * report prose as a claim. 3000 characters is the measured header budget: the
 * longest real status banner in this tree is under 2200.
 */
const HEADER_BYTES = 3000

export type Claim = "applied" | "not_applied" | "unstated" | "both"

export function claimOf(sql: string): Claim {
  const head = sql.slice(0, HEADER_BYTES)
  // The stale-banner this wave added says BOTH things on purpose — it exists to
  // say "the claim below is wrong" — so it is recognised as a single
  // `applied` claim rather than read as a contradiction.
  if (/THE "NOT APPLIED" CLAIM BELOW IS STALE/.test(head)) return "applied"
  // THE RECOGNISER MUST SEE EVERY SPELLING THE TREE ACTUALLY USES (§2, §6).
  // It began as /APPLIED LIVE|✅ APPLIED/, the two banner forms this guard's own
  // wave had written — and a recogniser scoped to the forms its author happened
  // to write is blind by construction. m601 states its status as
  //   "APPLIED 2026-09-03 by the integrator (MCP apply_migration; postflight: …)"
  // with no "LIVE" and no ✅, so this returned "unstated" and layer 2 could not
  // adjudicate it. The result was the worst possible reading: a guard script said
  // "m601 is WRITTEN, NOT APPLIED" while the migration's own header said applied
  // and the database agreed (verified live 2026-09-05 — 33 remotion_compositions,
  // 14 with requires_voiceover, exactly the postflight the header records), and
  // this guard reported no contradiction because it could not read one side.
  // The third alternative is APPLIED followed by a date, and the `(?!\s*LIVE)`
  // is not needed — "APPLIED LIVE" already matches the first branch.
  // \bNOT APPLIED\b is checked separately below and wins ties via the "both" case,
  // so a header saying "NOT APPLIED" can never be mistaken for one of these.
  const saysApplied = /APPLIED LIVE|✅\s*APPLIED|(?<!NOT )\bAPPLIED\s+\d{4}-\d{2}-\d{2}\b/i.test(head)
  const saysNot = /\bNOT APPLIED\b/i.test(head)
  if (saysApplied && saysNot) return "both"
  if (saysApplied) return "applied"
  if (saysNot) return "not_applied"
  return "unstated"
}
