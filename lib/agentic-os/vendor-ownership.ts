// lib/agentic-os/vendor-ownership.ts
// OWNERSHIP is the axis that decides HOW a vendor is gated:
//
//   • platform        — the PLATFORM holds the API key and pays the bill. Usage is
//                        gated by the per-brokerage platform vendor BUDGET (the
//                        kill-switch + metering + downgrade ladder). The brokerage
//                        never sees the vendor name or the cost. Lob (direct mail),
//                        the scrapers, enrichment, AVM, voice, and video all live here.
//
//   • user_connected  — the BROKERAGE connects its OWN account (QuickBooks, Stripe,
//                        email, phone, IDX, social, calendar, podcast syndicator,
//                        ShowingTime, transaction/e-sign). The brokerage pays the
//                        vendor directly, so the platform budget does NOT gate these.
//                        The gate is whether the account is CONNECTED (a live row in
//                        agent_api_credentials / platform_credentials /
//                        integration_credentials, resolved by connection-manager).
//
// Pure — no I/O — so the classification is unit-tested deterministically.

export type VendorOwnership = "platform" | "user_connected"

/** Vendors whose key/cost the PLATFORM owns — gated by the per-brokerage budget.
 *  Stripe + QuickBooks are platform-operated: the platform runs its own accounts and
 *  offers payments/accounting to every subscriber (subscribers do NOT connect their own). */
// TOMBSTONE (wave 145, lane 145D — owner ruling 13: "We no longer use vapi …"): the two DECOMMISSIONED vendors
// (lib/platform/provider-posture.ts DECOMMISSIONED_PROVIDERS) left this set. Listing them here was not history, it was
// a resurrection: lib/agentic-os/resolve-connectivity.ts scanConnectivity renders EVERY member as a live
// "platform_managed" connector, so the connectivity report counted a retired voice-AI vendor and the retired avatar
// vendor as managed connections. Their classification is UNCHANGED — vendorOwnership() defaults an unknown vendor to
// "platform", so historical vendor_usage_tracking rows still classify exactly as before; their rates stay in
// lib/vendor-governance/meter-vendor.ts and cost-normalizer.ts (never delete a rate).
export const PLATFORM_VENDORS = new Set<string>([
  "perplexity", "osint", "rentcast", "peopledata", "exa", "tavily",
  "apify_social", "apify", "batchdata", "zenrows", "zyte",
  "did", "elevenlabs", "browser_tts", "cma_aggregate",
  "lob",                          // direct mail — platform-owned
  "stripe", "quickbooks", "plaid", // financial — platform-operated, offered to all subscribers
])

/** Vendors the BROKERAGE connects from its own account — gated by connection presence.
 *  Names are the CANONICAL provider names understood by connection-manager. */
// Canonical provider names match the live credential stores (platform_credentials CHECK +
// agent_api_credentials.service_name + integration_credentials.provider_name) so the
// connectivity scan and connection gate recognize every name a connection may be stored under.
export const USER_CONNECTED_VENDORS = new Set<string>([
  "idxbroker",                                                   // IDX / MLS listings
  "gohighlevel", "lofty", "followupboss", "hubspot",             // CRM sync-out (egress)
  "sendgrid", "gmail", "outlook", "resend", "postmark", "mailgun", // email
  "twilio", "telnyx", "bandwidth", "plivo", "sinch",             // phone + SMS
  "nylas", "google_calendar",                                    // calendar (Google products etc.)
  "dotloop", "docusign", "skyslope", "authentisign",
  "brokermint", "formsimplicity",                                // transaction / e-sign
  "showingtime",                                                 // showings
  "meta", "facebook", "instagram", "linkedin", "twitter",
  "tiktok", "youtube", "pinterest", "buffer",                    // social accounts
  "podcast_syndicator",                                          // podcast distribution
  // Ad accounts (wave 145, lane 145D — owner ruling 13: "ads = meta, google ads, tv via vibe, chatgpt ads"). The
  // tenant connects its own ad account and pays its own ad spend (provider-adapters: ledger "tenant_account"). None of
  // the three was named by any source the readiness registry derives from, so getBrokerageProviderReadiness had NO row
  // for them and the arbiter's ads check could only ever see Meta (lib/providers/channel-provider-matrix.ts).
  "google_ads", "vibe", "openai_ads",
])

/** Classify a vendor. Unknown vendors default to `platform` (conservative — anything
 *  the platform might pay for is budget-gated until explicitly declared user-connected). */
export function vendorOwnership(vendor: string): VendorOwnership {
  return USER_CONNECTED_VENDORS.has(vendor) ? "user_connected" : "platform"
}

// CENSUS NOTE: the two predicates below are proof-only (scripts/scraper-simulator.ts:791-795
// pins the classification). Product readers use the SETS directly (resolve-connectivity.ts:141,
// provider-posture.ts:741-742) and the two manifests stamp ownership by construction
// (app-capability-registry.ts) — there is no inline duplicate of the classifier to merge.
/** @proofSeam see CENSUS NOTE above */
export function isPlatformVendor(vendor: string): boolean {
  return vendorOwnership(vendor) === "platform"
}

/** @proofSeam see CENSUS NOTE above */
export function isUserConnectedVendor(vendor: string): boolean {
  return vendorOwnership(vendor) === "user_connected"
}
