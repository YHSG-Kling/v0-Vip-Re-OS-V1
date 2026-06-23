// lib/transactions/deal-vendor-targets.ts
//
// Pure (no server-only): which deal vendor(s) a set of failing health components should notify.
// Lives apart from deal-vendor-notify.ts (which imports the low-level B2B sender and is therefore
// server-only) so simulators and pure callers can reuse the routing without the send chain.

export type DealVendorRole = "lender" | "title" | "escrow"

/** Dedupe window — one notice per (deal, vendor) within this many days. */
export const VENDOR_NOTIFY_DEDUPE_DAYS = 3

/** PURE: which vendor(s) a set of failing health components should notify. */
export function vendorTargets(categories: string[]): DealVendorRole[] {
  const roles = new Set<DealVendorRole>()
  for (const c of categories) {
    if (c === "LENDER") roles.add("lender")
    if (c === "TITLE") roles.add("title")
    if (c === "EARNEST_MONEY") roles.add("escrow") // earnest money is held by escrow / title
  }
  return Array.from(roles)
}
