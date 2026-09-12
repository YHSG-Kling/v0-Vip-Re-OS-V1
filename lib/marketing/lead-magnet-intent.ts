// lib/marketing/lead-magnet-intent.ts
//
// LEAD-MAGNET INTENT (pure) — which side of the business does a magnet conversion signal, and which
// manager should pick it up? A home-value or seller guide is SELLER intent (Listing Concierge); a buyer
// guide / listing alert / open-house RSVP is BUYER intent (Shopping Agent). The kernel uses this to (a)
// stamp the new contact's intent so determinePortalView shows the right portal + education, and (b) hand
// the lead to the right manager on the bus. Pure (no I/O), unit-tested directly.

import type { ManagerKey } from "@/lib/kernel/manager-registry"

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `MagnetType` deleted — a union no
// caller ever carried. classifyMagnetIntent below deliberately takes a plain
// string (magnet types arrive from stored rows and form payloads) and its
// switch is the one live spelling of the vocabulary, with unknowns routed to
// "unknown" instead of refused.

export type MagnetIntent = "buyer" | "seller" | "unknown"

export interface MagnetIntentRouting {
  intent: MagnetIntent
  /** the manager who should pick up this lead (null for unknown intent). */
  manager: ManagerKey | null
  /** the contact_type to stamp so the portal view + education match (null = leave as-is). */
  contactType: "buyer" | "seller" | null
  /** true when this magnet is the strongest INBOUND seller signal (a home-value request) — gets the
   *  stronger precise-CMA handoff rather than the generic routing. */
  isHomeValue: boolean
}

/**
 * PURE + total. Map a magnet type → its intent + owning manager + portal contact_type.
 *   · home_valuation                 → seller (Listing Concierge), strongest inbound seller signal.
 *   · seller_guide / market_report   → seller (Listing Concierge).
 *   · buyer_guide / listing_alert / open_house → buyer (Shopping Agent).
 *   · generic_form                   → unknown (no routing, no portal stamp).
 */
export function classifyMagnetIntent(magnetType: string): MagnetIntentRouting {
  switch (magnetType) {
    case "home_valuation":
      return { intent: "seller", manager: "listing_concierge", contactType: "seller", isHomeValue: true }
    case "seller_guide":
    case "market_report":
      return { intent: "seller", manager: "listing_concierge", contactType: "seller", isHomeValue: false }
    case "buyer_guide":
    case "listing_alert":
    case "open_house":
      return { intent: "buyer", manager: "shopping_agent", contactType: "buyer", isHomeValue: false }
    default:
      return { intent: "unknown", manager: null, contactType: null, isHomeValue: false }
  }
}
