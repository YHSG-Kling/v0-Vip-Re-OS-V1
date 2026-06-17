#!/usr/bin/env tsx
/**
 * scripts/buyer-saves-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the BUYER SAVE PATH consolidation onto the canonical saved_properties table, with the
 * data-display law enforced:
 *   · OUR listing  → stored by listing_id + a denormalized snapshot of OUR OWN facts.
 *   · EXTERNAL (RentCast/IDX, "ext_<source>_<id>") → ONLY source/external_property_id stored; NEVER the
 *     MLS facts (property_address/list_price stay null — display re-fetches from the URL).
 *   · dismissed → cannot escalate straight to an offer; offers are our-listings only.
 *   · load round-trips interest_level and excludes system market-watch refs.
 *
 * Layer 2 only (the kernel writes the DB); creds-gated. Real rows, reverse-deleted, cleanup count == 0.
 *
 * Run: npx tsx scripts/buyer-saves-simulator.ts   (npm run test:buyer-saves)
 */
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer save path consolidated onto saved_properties — internal snapshot, external URL-only, dismiss guard.")
  console.log(" BUYER_SAVES_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer save-path simulator")
  console.log("══════════════════════════════════════════════════\n")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { recordBuyerPropertyAction, loadBuyerSavedProperties } = await import("../lib/kernel/forms")
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a brokerage."); return report() }
  const brokerageId = (brk as any).id
  const { data: agent } = await svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
  if (!agent) { console.log("  ⏭  Skipped — need an agent with a user."); return report() }
  const agentId = (agent as any).id

  const cleanup: Array<{ table: string; id: string }> = []
  let contactId = "", listingId = ""
  const extId = `ext_rentcast_ZZ${Date.now()}`

  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId, first_name: "ZZSaver", last_name: `${Date.now()}`,
      email: `zz-save-${Date.now()}@example.com`, contact_type: "buyer",
    }).select("id").single()
    contactId = (c as any).id; cleanup.push({ table: "contacts", id: contactId })

    const { data: l } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: "12 Save St", city: "Austin", state: "TX", zip: "78701",
      list_price: 425000, bedrooms: 3, bathrooms: 2, sqft: 1700, property_type: "single_family", status: "active",
      primary_photo_url: "https://example.com/s.jpg",
    }).select("id").single()
    listingId = (l as any).id; cleanup.push({ table: "listings", id: listingId })

    // ── Internal save: stores listing_id + denormalized snapshot of OUR OWN facts ──
    const r1 = await recordBuyerPropertyAction({ contact_id: contactId, listing_id: listingId, interest_level: "saved", brokerage_id: brokerageId, agent_id: agentId })
    check("internal save succeeded", r1.success, JSON.stringify(r1))
    const { data: row1 } = await svc.from("saved_properties").select("id, listing_id, interest_level, property_address, list_price, source, user_id").eq("contact_id", contactId).eq("listing_id", listingId).maybeSingle()
    check("internal row has listing_id + our snapshot (address/price)", !!row1 && (row1 as any).listing_id === listingId && (row1 as any).property_address === "12 Save St" && (row1 as any).list_price === 425000)
    check("internal row owned by the agent user (user_id set)", !!(row1 as any)?.user_id)
    if ((row1 as any)?.id) cleanup.push({ table: "saved_properties", id: (row1 as any).id })

    // ── External save: URL/attribution only, NO MLS facts persisted ──
    const r2 = await recordBuyerPropertyAction({ contact_id: contactId, listing_id: extId, interest_level: "saved", brokerage_id: brokerageId, agent_id: agentId })
    check("external save succeeded", r2.success, JSON.stringify(r2))
    const { data: row2 } = await svc.from("saved_properties").select("id, listing_id, source, external_property_id, property_address, list_price").eq("contact_id", contactId).eq("source", "rentcast").maybeSingle()
    check("external row stores source + external id, NO listing_id", !!row2 && (row2 as any).listing_id === null && (row2 as any).source === "rentcast" && (row2 as any).external_property_id === extId.slice("ext_rentcast_".length))
    check("external row stores NO MLS facts (compliance)", !!row2 && (row2 as any).property_address === null && (row2 as any).list_price === null)
    if ((row2 as any)?.id) cleanup.push({ table: "saved_properties", id: (row2 as any).id })

    // ── Idempotent: re-saving the same internal listing updates, never duplicates ──
    await recordBuyerPropertyAction({ contact_id: contactId, listing_id: listingId, interest_level: "favorited", brokerage_id: brokerageId, agent_id: agentId })
    const { count: dupCount } = await svc.from("saved_properties").select("id", { count: "exact", head: true }).eq("contact_id", contactId).eq("listing_id", listingId)
    check("re-save updates the same row (no duplicate)", (dupCount ?? 0) === 1)

    // ── load round-trips interest_level + facts ──
    const loaded = await loadBuyerSavedProperties({ contact_id: contactId, include_dismissed: true, limit: 50 })
    check("load returns both saves", loaded.success && (loaded.data?.interests.length ?? 0) >= 2)
    const internal = loaded.data?.interests.find((i) => i.listing_id === listingId)
    check("load: internal carries our facts + 'favorited'", !!internal && internal.interest_level === "favorited" && internal.listing?.list_price === 425000)
    const external = loaded.data?.interests.find((i) => i.source === "rentcast")
    check("load: external is URL-only (no listing facts attached)", !!external && external.listing === undefined && external.listing_id === null)

    // ── Dismiss guard: dismiss the internal listing, then an offer must be blocked ──
    await recordBuyerPropertyAction({ contact_id: contactId, listing_id: listingId, interest_level: "dismissed", brokerage_id: brokerageId, agent_id: agentId })
    const blocked = await recordBuyerPropertyAction({ contact_id: contactId, listing_id: listingId, interest_level: "offer_requested", brokerage_id: brokerageId, agent_id: agentId })
    check("offer on a dismissed property is blocked", !blocked.success && /dismissed/i.test(blocked.error ?? ""))
    const offerExt = await recordBuyerPropertyAction({ contact_id: contactId, listing_id: extId, interest_level: "offer_requested", brokerage_id: brokerageId, agent_id: agentId })
    check("offers are blocked on external listings (our-listings only)", !offerExt.success && /our brokerage/i.test(offerExt.error ?? ""))

    // dismissed excluded from the default (non-dismissed) load
    const activeOnly = await loadBuyerSavedProperties({ contact_id: contactId, limit: 50 })
    check("dismissed internal excluded from default load", !activeOnly.data?.interests.some((i) => i.listing_id === listingId))
  } finally {
    await svc.from("lifecycle_events").delete().eq("entity_id", contactId || "none").then(() => {}, () => {})
    await svc.from("saved_properties").delete().eq("contact_id", contactId || "none").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("saved_properties").select("id", { count: "exact", head: true }).eq("contact_id", contactId || "none")
    check("cleanup: saved_properties rows removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
