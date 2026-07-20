/**
 * lib/vendors/w9-vocab.ts — the PURE, client-safe half of the vendor W-9
 * module (owner round 43): vocabulary, types, and the derivation/dedupe
 * predicates. ZERO IO and zero server imports so the portal's "use client"
 * W-9 card can import labels/types without dragging the dispatch rail
 * (lob/require, service client) into the client bundle.
 *
 * lib/vendors/w9.ts re-exports everything here and adds the IO layer
 * (reads + the governed reminder) — server code keeps importing from
 * "@/lib/vendors/w9"; client components import from this module.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export type W9Status = "missing" | "on_file" | "expired"
export const W9_STATUSES: readonly W9Status[] = ["missing", "on_file", "expired"]

/** W-9 line-3 federal tax classification. */
export type W9BusinessType =
  | "individual_sole_proprietor"
  | "c_corporation"
  | "s_corporation"
  | "partnership"
  | "trust_estate"
  | "llc"
  | "other"

export const W9_BUSINESS_TYPES: readonly W9BusinessType[] = [
  "individual_sole_proprietor", "c_corporation", "s_corporation",
  "partnership", "trust_estate", "llc", "other",
]

export const W9_BUSINESS_TYPE_LABELS: Record<W9BusinessType, string> = {
  individual_sole_proprietor: "Individual / sole proprietor or single-member LLC",
  c_corporation: "C corporation",
  s_corporation: "S corporation",
  partnership: "Partnership",
  trust_estate: "Trust / estate",
  llc: "LLC (taxed as C corp, S corp, or partnership)",
  other: "Other",
}

/** TIN TYPE only — EIN vs SSN. The TIN itself is never captured or stored. */
export type W9TinType = "ein" | "ssn"
export const W9_TIN_TYPES: readonly W9TinType[] = ["ein", "ssn"]

/** Reminder dedupe period — at most one W-9 chase email per vendor per period. */
export const W9_REMINDER_PERIOD_DAYS = 30

// ─── Record shape ────────────────────────────────────────────────────────────

export interface VendorW9Record {
  status: W9Status                    // as stored (pre-derivation)
  legalName: string | null
  businessType: W9BusinessType | null
  tinType: W9TinType | null
  signatureDate: string | null        // yyyy-mm-dd
  documentUrl: string | null          // the certified PDF (client-documents rail)
  clientDocumentId: string | null
  vendorNameAtFiling: string | null   // vendors.name snapshot at upload
  reminderLastSentAt: string | null   // ISO — dedupe anchor
}

export interface VendorW9Read {
  record: VendorW9Record | null
  /** Derived against the CURRENT vendors.name — the honest status. */
  status: W9Status
  vendorName: string | null
}

// ─── PURE predicates ─────────────────────────────────────────────────────────

/**
 * Derive the honest W-9 status. No record (or no filed doc) ⇒ 'missing'.
 * Filed but the vendor's legal name has since changed ⇒ 'expired' — the
 * certification on file no longer matches the payee identity the tenant
 * pays under. Comparison is trimmed + case-insensitive so cosmetic edits
 * never fabricate an expiry.
 */
export function deriveW9Status(
  record: Pick<VendorW9Record, "status" | "vendorNameAtFiling"> | null | undefined,
  currentVendorName?: string | null,
): W9Status {
  if (!record || record.status === "missing") return "missing"
  if (record.status === "expired") return "expired"
  // status 'on_file' — check the legal-identity snapshot.
  const filed = (record.vendorNameAtFiling ?? "").trim().toLowerCase()
  const current = (currentVendorName ?? "").trim().toLowerCase()
  if (filed && current && filed !== current) return "expired"
  return "on_file"
}

/**
 * SOFT gate: never blocks — returns the honest warning line for a lane to
 * surface (payouts + invoice issuance), or null when the W-9 is on file.
 */
export function w9SoftGateWarning(status: W9Status): string | null {
  if (status === "on_file") return null
  return status === "expired"
    ? "W-9 on file no longer matches this vendor's legal name — an updated W-9 is needed for accurate 1099 reporting."
    : "W-9 not on file for this vendor — 1099 reporting needs a completed W-9 (TIN certification). Payments still proceed."
}

/**
 * Reminder dedupe (pure): send only when the W-9 is NOT on file AND no
 * reminder went out within the period. An unparseable timestamp counts as
 * never-sent (honest: better one extra nudge than a silent never).
 */
export function shouldSendW9Reminder(args: {
  status: W9Status
  reminderLastSentAt: string | null
  now?: Date
  periodDays?: number
}): boolean {
  if (args.status === "on_file") return false
  if (!args.reminderLastSentAt) return true
  const last = Date.parse(args.reminderLastSentAt)
  if (Number.isNaN(last)) return true
  const period = (args.periodDays ?? W9_REMINDER_PERIOD_DAYS) * 86_400_000
  return (args.now ?? new Date()).getTime() - last >= period
}
