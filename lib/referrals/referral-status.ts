/**
 * lib/referrals/referral-status.ts
 *
 * THE ONE REFERRAL STATUS VOCABULARY.
 *
 * `referrals.status` is CHECK-constrained. Verified live against pg_constraint:
 *
 *   referrals_status_check → received | contacted | qualified | assigned |
 *                            under_contract | closed | lost
 *
 * Four surfaces each carried their own idea of that list, and they disagreed:
 *
 *   app/dashboard/referrals/components/os/referral-pipeline-panel.tsx
 *     STATUSES = ["new","contacted","qualified","converted","closed"]
 *     — `new` and `converted` are in NO constraint. Picking either from the
 *       dropdown sent an UPDATE the database refused, and both call sites
 *       (`referrals-os-client.tsx`, `pipeline-os-client.tsx`) awaited it with
 *       `status as any` and no catch, so the stage change simply died. Two of
 *       the five offered stages could never be set.
 *
 *   app/dashboard/agent/referrals/page.tsx
 *     PIPELINE_STAGES had 5 of the 7 — no `assigned`, no `lost`. A referral in
 *     either state matched no column and rendered nowhere at all.
 *
 *   app/referrals/pipeline/page.tsx
 *     had the full 7 in its colour/icon maps, and was the only surface that did.
 *
 *   app/actions/multi-persona.ts:trackReferral
 *     carried the full 7 in its parameter type — and had zero callers.
 *
 * The rule this module exists to enforce: a picker stores a VALUE and shows a
 * LABEL, and the value set is the constraint's, not the designer's. Adding a
 * member here without the matching migration produces a value the database
 * rejects.
 */

export type ReferralStatus =
  | "received"
  | "contacted"
  | "qualified"
  | "assigned"
  | "under_contract"
  | "closed"
  | "lost"

export type ReferralStatusMeta = {
  value: ReferralStatus
  label: string
  /** Tailwind classes for a badge. Every value has one — see the note above about
   *  colours reserved for states that cannot occur. */
  badgeClass: string
  /** No further stage transition is expected from here. */
  terminal: boolean
}

/**
 * Pipeline order, left to right. `lost` sits last because it is an exit, not a
 * stage — but it IS storable and a referral can land there, so it must be
 * offered and it must render.
 */
export const REFERRAL_STATUSES: ReferralStatusMeta[] = [
  { value: "received",       label: "Received",       badgeClass: "bg-blue-100 text-blue-700",       terminal: false },
  { value: "contacted",      label: "Contacted",      badgeClass: "bg-purple-100 text-purple-700",   terminal: false },
  { value: "qualified",      label: "Qualified",      badgeClass: "bg-green-100 text-green-700",     terminal: false },
  { value: "assigned",       label: "Assigned",       badgeClass: "bg-indigo-100 text-indigo-700",   terminal: false },
  { value: "under_contract", label: "Under Contract", badgeClass: "bg-orange-100 text-orange-700",   terminal: false },
  { value: "closed",         label: "Closed",         badgeClass: "bg-emerald-100 text-emerald-700", terminal: true  },
  { value: "lost",           label: "Lost",           badgeClass: "bg-red-100 text-red-700",         terminal: true  },
]

/** Where a referral lands when nobody says otherwise. */
export const DEFAULT_REFERRAL_STATUS: ReferralStatus = "received"

export function isReferralStatus(v: string): v is ReferralStatus {
  return REFERRAL_STATUSES.some((s) => s.value === v)
}

export function referralStatusLabel(v: string | null | undefined): string {
  if (!v) return "—"
  return REFERRAL_STATUSES.find((s) => s.value === v)?.label ?? v
}

export function referralStatusBadgeClass(v: string | null | undefined): string {
  return (
    REFERRAL_STATUSES.find((s) => s.value === v)?.badgeClass ??
    "bg-muted text-muted-foreground"
  )
}

/**
 * The states that count as "this referral produced business". Used by the ROI
 * summaries — `converted` was never a status, so any count keyed on it was zero.
 */
export const REFERRAL_STATUSES_CONVERTED: ReferralStatus[] = ["under_contract", "closed"]

// ─── THE STAGE GRAPH ─────────────────────────────────────────────────────────
//
// MOVED HERE (§6 one vocabulary per function, BURN-C 2026-09-04) from
// lib/kernel/reputation.ts, where it sat as a private const beside a private
// REFERRAL_TERMINAL_WON. Two modules held the referral stage vocabulary: this
// one owned the VALUES and the labels, that one owned which value may follow
// which — so the picker and the rule that judges the picker could drift, and
// nothing would have caught it. The graph belongs beside the values it is
// written in.
//
// The list above is the live CHECK constraint (referrals_status_check), so any
// transition named here is storable by construction.

/** Which statuses may legally follow a given one. */
export const REFERRAL_STATUS_TRANSITIONS: Record<ReferralStatus, ReferralStatus[]> = {
  received:       ["contacted", "qualified", "lost"],
  contacted:      ["qualified", "lost"],
  qualified:      ["assigned", "lost"],
  assigned:       ["under_contract", "lost"],
  under_contract: ["closed", "lost"],
  closed:         [],
  lost:           ["contacted"], // a lost referral can be re-opened
}

/**
 * The status that means the referral produced a closed deal.
 *
 * DERIVED, not typed a second time (CLAUDE.md §2 — do not pin an assertion to a
 * waypoint): it is the terminal member that also counts as converted, so
 * inserting a stage or re-labelling one moves this with it instead of leaving a
 * hardcoded string behind that is quietly wrong. `lost` is terminal too and is
 * excluded because it is not in REFERRAL_STATUSES_CONVERTED.
 */
export const REFERRAL_TERMINAL_WON: ReferralStatus =
  REFERRAL_STATUSES.find((s) => s.terminal && REFERRAL_STATUSES_CONVERTED.includes(s.value))!.value

/**
 * PURE — may this referral move from `from` to `to`?
 *
 * Returns the allowed set alongside the verdict so a caller can tell the agent
 * what IS possible rather than only that they were refused. An unknown `from`
 * yields an empty allowed set and a false verdict: fail closed (§4).
 */
export function canAdvanceReferral(
  from: string,
  to: string,
): { ok: boolean; allowed: ReferralStatus[] } {
  const allowed = (isReferralStatus(from) ? REFERRAL_STATUS_TRANSITIONS[from] : []) ?? []
  return { ok: isReferralStatus(to) && allowed.includes(to), allowed }
}
