// lib/format/math.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE clamp (§1/§6, 2026-09-08, lane CC — duplicates round 2). Five
// private copies lived across the repo — two byte-equivalent (no default
// bounds, required min/max) and three sharing a different, byte-equivalent
// signature among THEMSELVES (defaulting to a 0–100 score range, the shape
// every score-band composer in this repo wants). Both groups are merged onto
// this one arithmetic; the 0–100-default group keeps its own local call
// signature as a thin wrapper (see each tombstone) so no caller of the
// 1-arg/2-arg form had to change, while the actual `min(max(...))` math now
// lives in exactly one place.
//
// PURE LEAF — no imports.

/** Clamp `n` into `[min, max]`. Required bounds — see lib/format/math.ts's
 *  header for the 0–100-default variants this does NOT force a signature
 *  change on. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
