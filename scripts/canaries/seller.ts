/**
 * scripts/canaries/seller.ts — SELLER canary:
 *   contact → property → listing journey
 * through lib/kernel/listings.ts createListingRecord (the one listing writer) and
 * lib/kernel/seller-listing-timeline.ts computeSellerListingTimeline (the bucketed
 * seller timeline — CLAUDE.md §5: buckets, never 30/60/90).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Seller: contact → property → listing journey")
  const B = uuid(), U = uuid(), AG = uuid(), CT = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-seller` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, is_active: true }],
    contacts: [{ id: CT, brokerage_id: B, agent_id: AG, first_name: "Sam", last_name: "Canary", email: `sam@${CANARY_EMAIL_DOMAIN}`, contact_type: "seller", notes: CANARY_TAG }],
  })
  setSvc(svc)
  c.step("contact: a seller contact owned by the tenant's agent exists", !!svc.tables.contacts?.find((x) => x.id === CT && x.contact_type === "seller"), "")
  const { createListingRecord } = await import("../../lib/kernel/listings")
  const r = await createListingRecord({ agentId: AG, sellerContactId: CT, brokerageId: B, address: "100 Canary Ln", city: "Austin", state: "TX", zip: "78701", listPrice: 450000, bedrooms: 3, bathrooms: 2, sqft: 1800, propertyType: "single_family" })
  const listing = r.success ? ((r as unknown as { listing: Record<string, unknown> }).listing ?? null) : null
  c.step("property: createListingRecord writes the listing against THIS tenant + seller", r.success && !!listing && listing.brokerage_id === B && listing.seller_contact_id === CT, r.success ? `listing ${String(listing?.id)} status ${String(listing?.status)}` : (r.error ?? "failed"))
  const bad = await createListingRecord({ agentId: AG, sellerContactId: "not-a-uuid", brokerageId: B, address: "x", city: "y", state: "TX", zip: "1" })
  c.step("POSITIVE CONTROL: an invalid seller id is refused before any write", !bad.success, (bad as { error?: string }).error ?? "written")
  const { computeSellerListingTimeline } = await import("../../lib/kernel/seller-listing-timeline")
  // The seller's time-to-list reading from the signals the contact carries (quick lists, intent,
  // motivation, source) — a CLASS + a window with real reasons, never a fabricated date.
  const tl = computeSellerListingTimeline({ tags: ["relocation", "fsbo", "seller_intent"], tenureYears: 8, equityPct: 40 })
  c.step("listing journey: the seller timeline resolves a listing class + window from real signals (reasons given, none fabricated)", tl.listingClass !== "unknown" && tl.predictedDaysToList !== null && tl.reasons.length > 0, `${tl.listingClass} ${tl.windowDaysLow}-${tl.windowDaysHigh}d: ${tl.reasons.join("; ")}`.slice(0, 160))
  const none = computeSellerListingTimeline({ tags: [] })
  c.step("POSITIVE CONTROL: no time-bound signal → unknown with NO predicted days (nothing invented)", none.listingClass === "unknown" && none.predictedDaysToList === null, "")
  const evidence = (svc.tables.lifecycle_events ?? []).length + (svc.tables.activities ?? []).length + (svc.tables.listing_status_history ?? []).length
  c.step("evidence: the listing creation left a lifecycle/activity row", evidence > 0, `rows=${evidence}`)
  c.blind("MLS syndication, listing media and the pre-listing release gate are their own proofs (mls-syndication, listing-media-consolidation, prelisting-release-gate); this canary stops at the listing record + timeline.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
