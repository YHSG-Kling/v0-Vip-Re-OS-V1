#!/usr/bin/env tsx
/**
 * scripts/closing-testimonial-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 50 — proves the deal-closed AUTO-handoff is DELIVERABLE-gated: when a
 * transaction closes, the system AUTO-proposes a review/testimonial request to
 * BOTH the buyer and the seller (zero agent effort), each landing in the
 * client_message approval gate. The ONLY human gate is the finished message
 * before it reaches the client (consent-enforced on send).
 *
 *   Layer 1 — pure: buildTestimonialMessage (buyer vs seller copy; no price/PII;
 *     signed by the agent).
 *   Layer 2 — live (gated): seed a brokerage + buyer/seller contacts + a closed
 *     transaction → produceClosingTestimonials proposes 2 client messages that
 *     surface in the Command Center client_message queue; idempotent; cleanup.
 *
 * Run: npx tsx scripts/closing-testimonial-simulator.ts  (npm run test:closing-testimonial)
 */
import { buildTestimonialMessage } from "../lib/agents/closing-testimonial-producer"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildTestimonialMessage]")
  const buyer = buildTestimonialMessage("buyer", "Dana Kling")
  const seller = buildTestimonialMessage("seller", "Dana Kling")
  check("buyer copy references finding a home + signed by agent", /finding your new home/.test(buyer.body) && /Dana Kling/.test(buyer.body))
  check("seller copy references selling + signed by agent", /selling your home/.test(seller.body) && /Dana Kling/.test(seller.body))
  check("both ask for a short review", /review/i.test(buyer.body) && /review/i.test(seller.body))
  check("subject is a polite favor ask", /favor/i.test(buyer.subject) && buyer.subject === seller.subject)
  check("no price / dollar figures leaked", !/\$\d/.test(buyer.body + seller.body))
}

async function testLive() {
  console.log("\n[Layer 2 · live deal-closed auto-handoff]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { produceClosingTestimonials } = await import("../lib/agents/closing-testimonial-producer")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__cts_${Date.now()}__`
  let buyerId: string | null = null; let sellerId: string | null = null
  let txnId: string | null = null; let listingId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    const mkContact = async (first: string) => {
      const { data } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: `${TAG}${first}`, last_name: "Test", email: `${TAG}${first}@example.com`,
      }).select("id").maybeSingle()
      return (data as { id: string } | null)?.id ?? null
    }
    buyerId = await mkContact("Buyer")
    sellerId = await mkContact("Seller")
    if (!buyerId || !sellerId) { console.log("  ⏭  contact seed failed — skipped"); return }

    // A minimal listing for the transaction to point at (entity_id of the request).
    const { data: listing } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 18 Sold Ln`, city: "Maple Grove", state: "MN",
      status: "sold", lifecycle_stage: "CLOSED",
    }).select("id").maybeSingle()
    listingId = (listing as { id: string } | null)?.id ?? null
    if (!listingId) { console.log("  ⏭  listing seed failed — skipped"); return }

    const { data: txn, error: tErr } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} closing`, listing_id: listingId,
      buyer_contact_id: buyerId, seller_contact_id: sellerId,
    }).select("id").maybeSingle()
    if (tErr || !txn) { console.log(`  ⏭  transaction seed failed (${tErr?.message}) — skipped`); return }
    txnId = (txn as { id: string }).id

    // AUTO-produce (no proposal step) — one request per party.
    const r = await produceClosingTestimonials(brokerageId, listingId, svc)
    check("deal closed → auto-proposes a testimonial request to buyer + seller", r.proposed === 2, `proposed=${r.proposed}`)

    // Both land in the client_message gate as 'proposed', tied to this listing.
    const { data: msgs } = await svc.from("agent_client_messages")
      .select("id, audience, status, channel, recipient_contact_id, entity_type")
      .eq("brokerage_id", brokerageId).eq("entity_type", "testimonial_request").eq("entity_id", listingId)
    const rows = (msgs ?? []) as Array<{ id: string; audience: string; status: string; channel: string; recipient_contact_id: string }>
    check("two proposed client messages exist (buyer + seller)", rows.length === 2 && rows.every((m) => m.status === "proposed"))
    check("each targets the right party + channel email", rows.some((m) => m.audience === "buyer" && m.recipient_contact_id === buyerId) && rows.some((m) => m.audience === "seller" && m.recipient_contact_id === sellerId) && rows.every((m) => m.channel === "email"))

    // They surface in the ONE Command Center client_message deliverable queue.
    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = rows.filter((m) => cc.pendingActions.find((a) => a.id === m.id && a.queue === "client_message"))
    check("both requests surface in the Command Center client_message queue", surfaced.length === 2)

    // Idempotent — re-firing the close does not duplicate.
    const r2 = await produceClosingTestimonials(brokerageId, listingId, svc)
    check("auto-handoff is idempotent (one request per party/listing)", r2.proposed === 0, `re-proposed=${r2.proposed}`)
  } finally {
    try { await svc.from("agent_client_messages").delete().eq("entity_id", listingId ?? "").eq("entity_type", "testimonial_request") } catch {}
    if (txnId) { try { await svc.from("transactions").delete().eq("id", txnId) } catch {} }
    if (listingId) { try { await svc.from("listings").delete().eq("id", listingId) } catch {} }
    if (buyerId) { try { await svc.from("contacts").delete().eq("id", buyerId) } catch {} }
    if (sellerId) { try { await svc.from("contacts").delete().eq("id", sellerId) } catch {} }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Deal-closed → testimonial AUTO-handoff simulator (deliverable-gated)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Deal-closed: zero agent effort; only the finished testimonial is human-gated")
}
main()
