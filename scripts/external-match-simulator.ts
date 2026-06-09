#!/usr/bin/env tsx
/**
 * scripts/external-match-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 63 — proves the COMPLIANT external (RentCast/IDX) market-match layer:
 *   • buildExternalReferenceRow NEVER stores a photo, keeps source attribution + the
 *     TTL marker (the RentCast/MLS display-only invariant), and
 *   • purgeStaleExternalReferences removes stale system references but NEVER touches a
 *     user-saved favorite.
 *
 *   Layer 1 — pure: the compliance shape of an external reference row.
 *   Layer 2 — live (gated): seed a STALE system ref + match, a FRESH system ref, and a
 *     USER favorite → purge removes only the stale system ref (+ its match); cleanup.
 *
 * NOTE: the RentCast/IDX HTTP search itself runs only in the deployed env (egress) — its
 * client conforms to the RentCast /listings/sale spec; here we test what we persist + purge.
 *
 * Run: npx tsx scripts/external-match-simulator.ts  (npm run test:external-match)
 */
import { buildExternalReferenceRow, MARKET_WATCH_REF_MARKER } from "../lib/buyer-search/external-match"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildExternalReferenceRow — the compliance shape]")
  const row = buildExternalReferenceRow(
    { externalId: "RC123", source: "rentcast", address: "9 Elm Ave", city: "Austin", state: "TX", price: 525000, bedrooms: 4, bathrooms: 3, listingUrl: "https://rentcast/x" },
    { brokerageId: "b1", contactId: "c1", userId: "u1", fitScore: 88 },
  )
  check("photo is NEVER stored (display-only / re-fetch)", row.primary_photo_url === null)
  check("keeps source attribution", row.source === "rentcast")
  check("keeps the external id + listing_url", row.external_property_id === "RC123" && row.listing_url === "https://rentcast/x")
  check("stores the factual snapshot only", row.property_address === "9 Elm Ave" && row.list_price === 525000 && row.bedrooms === 4)
  check("marked as a system reference (TTL-purged)", row.notes === MARKET_WATCH_REF_MARKER)
  check("carries the fit score", row.ai_match_score === 88)
}

async function testLive() {
  console.log("\n[Layer 2 · live TTL purge — stale refs go, favorites stay]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { purgeStaleExternalReferences } = await import("../lib/buyer-search/external-match")
  const svc = createServiceClient()
  const TAG = `__em_${Date.now()}__`
  let buyerId: string | null = null
  const created: string[] = []
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: anyUser } = await svc.from("users").select("id").limit(1).maybeSingle()
    if (!brk || !anyUser) { console.log("  ⏭  Skipped — no brokerage/user."); return }
    const brokerageId = (brk as { id: string }).id
    const userId = (anyUser as { id: string }).id

    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Buyer`, last_name: "Test", email: `${TAG}b@example.com`, contact_type: "buyer",
    }).select("id").maybeSingle()
    buyerId = (c as { id: string } | null)?.id ?? null
    if (!buyerId) { console.log("  ⏭  contact seed failed — skipped"); return }

    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() // 10 days old
    const ins = async (notes: string, savedAt: string, addr: string) => {
      const { data } = await svc.from("saved_properties").insert({
        brokerage_id: brokerageId, contact_id: buyerId, user_id: userId, source: "rentcast",
        external_property_id: `${TAG}${addr}`, property_address: `${TAG} ${addr}`, primary_photo_url: null, notes, saved_at: savedAt,
      }).select("id").maybeSingle()
      const id = (data as { id: string } | null)?.id ?? null
      if (id) created.push(id)
      return id
    }
    const staleRef = await ins(MARKET_WATCH_REF_MARKER, old, "Stale")
    const freshRef = await ins(MARKET_WATCH_REF_MARKER, new Date().toISOString(), "Fresh")
    const favorite = await ins("buyer loved this one", old, "Favorite") // user favorite, also old
    // A property_match pointing at the stale ref (must be purged with it).
    if (staleRef) await svc.from("property_matches").insert({ brokerage_id: brokerageId, contact_id: buyerId, property_id: staleRef, match_score: 80, ai_generated: false })

    const res = await purgeStaleExternalReferences(svc)
    check("purge reports ≥1 removed", res.purged >= 1, `purged=${res.purged}`)

    const stillThere = async (id: string | null) => {
      if (!id) return false
      const { data } = await svc.from("saved_properties").select("id").eq("id", id).maybeSingle()
      return !!data
    }
    check("STALE system reference is purged", !(await stillThere(staleRef)))
    check("FRESH system reference is kept", await stillThere(freshRef))
    check("USER favorite is NEVER purged (even when old)", await stillThere(favorite))
    const { count: matchLeft } = await svc.from("property_matches").select("id", { count: "exact", head: true }).eq("property_id", staleRef ?? "")
    check("the stale ref's property_match is purged too", (matchLeft ?? 0) === 0)
  } finally {
    if (buyerId) {
      try { await svc.from("property_matches").delete().eq("contact_id", buyerId) } catch {}
      try { await svc.from("saved_properties").delete().eq("contact_id", buyerId) } catch {}
      try { await svc.from("contacts").delete().eq("id", buyerId) } catch {}
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Compliant external (RentCast/IDX) market-match simulator")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ External matches: photos never stored, attributed, short-TTL; favorites untouched")
}
main().catch((e) => { console.error(e); process.exit(1) })
