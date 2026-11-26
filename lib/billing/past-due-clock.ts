// lib/billing/past-due-clock.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PAST-DUE CLOCK — the three PURE pieces both dunning and the paywall read:
// the grace length, the day count, and the episode anchor. Moved here VERBATIM
// from lib/billing/dunning.ts (wave 100D) so the paywall can read them WITHOUT
// importing dunning's effectful sweep. dunning.ts imports and re-exports all
// three, so it stays the one place its importers ask; nothing is restated.
//
// WHY A SEPARATE LEAF (build graph, not style): proxy.ts — the request-boundary
// entry, compiled as its OWN webpack compilation — imports
// lib/billing/billing-access.ts, which imported these from ./dunning. dunning's
// runDunningSweep lazy-imports @/lib/providers/messaging, and webpack compiles a
// lazy import() just as it compiles a static one. Measured at 08282ad6c with a
// first-party import-graph walk (static + dynamic edges): that one edge took the
// proxy entry from 4 first-party modules (5fdebe24e) to 827 — the whole kernel,
// video, transactions and AI-ISA graphs recompiled into the proxy bundle — and
// CI's `next build --webpack` began aborting with "Ineffective mark-compacts
// near heap limit". This module imports only @/lib/format/dates, so the
// paywall's dependency on the clock costs two modules, not 822.
//
// Keep it a LEAF: no import here may reach providers, kernel, or supabase.

import { daysBetween as dateDaysBetween } from "@/lib/format/dates"

/**
 * THE PAST-DUE GRACE WINDOW — one number, two readers (wave 99A, §6).
 *
 * The ladder below already PROMISED this rule in its copy: step 3 ("One week past
 * due — access is restricted … Sign-ins now route to the billing page") is the
 * moment access stops, and steps 1–2 promise nothing of the kind. The paywall
 * (lib/billing/billing-access.ts resolveBillingAccess) used to refuse a past_due
 * tenant on day 0, contradicting the email it sent the same day. Both now read
 * this constant: step 3 fires AT it and the resolver refuses AFTER it.
 * ("The ladder" is lib/billing/dunning.ts DUNNING_LADDER.)
 */
export const PAST_DUE_GRACE_DAYS = 7

// TOMBSTONE (§1.1, 2026-09-08): the day-diff arithmetic lived here; survivor
// lib/format/dates.ts:daysBetween. The never-negative clamp is dunning's own
// policy (a past-due episode can't have negative days-late), not shared date
// math, so it stays as a thin wrapper around the survivor.
/** PURE: whole days between two ISO timestamps (floored, never negative). */
export function daysBetween(fromIso: string, nowIso: string): number {
  return Math.max(0, dateDaysBetween(fromIso, nowIso, { round: "floor" }))
}

/**
 * PURE: the anchor a past-due episode ages from — the oldest OPEN invoice's
 * date, else the subscription's own updated_at (status flip time). Events
 * older than the anchor belong to a PREVIOUS episode and don't dedupe this one.
 */
export function episodeAnchor(
  sub: { updated_at: string | null },
  openInvoices: Array<{ invoice_date: string | null; due_date: string | null }>,
): string | null {
  const dates = openInvoices.map((i) => i.due_date ?? i.invoice_date).filter(Boolean) as string[]
  if (dates.length > 0) return dates.sort()[0]
  return sub.updated_at ?? null
}
