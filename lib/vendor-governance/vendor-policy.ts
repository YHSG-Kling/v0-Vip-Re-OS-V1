// lib/vendor-governance/vendor-policy.ts
// Downgrade ladder — the cap throttles COST, not CAPABILITY. When a brokerage is over
// its monthly vendor budget, a vendor with a free alternative DEGRADES to that free
// path (the product keeps working at $0) instead of hard-pausing. Only vendors with
// no free equivalent (rendered video) hard-BLOCK.
//
// Pure — no I/O — so the policy is unit-tested deterministically.

export type VendorAction = "allow" | "degrade" | "block"

export interface VendorPolicy {
  /** Free alternative the caller can route to when over budget. */
  freeAlternative: string | null
}

// Keyed by the canonical vendor name recorded in vendor_usage_tracking.
export const VENDOR_POLICY: Record<string, VendorPolicy> = {
  // Video rendering — no free equivalent. Hard-block over budget.
  did:    { freeAlternative: null },
  heygen: { freeAlternative: null },
  // Voice TTS — degrade to the browser SpeechSynthesis API (free, on-device).
  elevenlabs: { freeAlternative: "browser_tts" },
  // Outbound AI voice calls — no free equivalent; the ISA layer reroutes to a
  // cheaper channel (SMS/email) on block, so treat as block here.
  vapi: { freeAlternative: null },
  // Property valuation / comps — degrade to the free Perplexity + OSINT AVM tiers.
  rentcast: { freeAlternative: "perplexity_osint_avm" },
}

/**
 * Resolve what to do for a vendor call given whether the brokerage is over budget.
 *   under budget          → "allow"
 *   over budget + free alt → "degrade" (use the free path; product keeps working)
 *   over budget, no alt    → "block"
 * Unknown vendors default to block when over budget (conservative — protect spend).
 */
export function resolveVendorAction(vendor: string, overBudget: boolean): VendorAction {
  if (!overBudget) return "allow"
  return VENDOR_POLICY[vendor]?.freeAlternative ? "degrade" : "block"
}

/** The free fallback path name for a vendor, or null. */
export function freeAlternativeFor(vendor: string): string | null {
  return VENDOR_POLICY[vendor]?.freeAlternative ?? null
}
