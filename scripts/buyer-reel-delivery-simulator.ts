#!/usr/bin/env tsx
/**
 * scripts/buyer-reel-delivery-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 64 — proves the buyer egress loop closes: a finished property-match reel becomes
 * a Shopping-Agent-owned client message on the Command Center (channel portal) carrying
 * the finished video link, human-released before it reaches the buyer. Idempotent.
 *
 *   Layer 1 — pure: buildReelDeliveryFallback (buyer-safe, signed, sanitized).
 *   Layer 2 — live (gated): seed a buyer + a completed reel render → proposeBuyerReelDelivery
 *     proposes one client_message owned by Shopping Agent with the video link, surfaced on
 *     the Command Center; idempotent; cleanup.
 *
 * Run: npx tsx scripts/buyer-reel-delivery-simulator.ts  (npm run test:buyer-reel-delivery)
 */
import { buildReelDeliveryFallback } from "../lib/agents/buyer-reel-delivery"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildReelDeliveryFallback]")
  const m = buildReelDeliveryFallback("Dana Kling")
  check("references a personalized video, signed by agent", /video/i.test(m.body) && /Dana Kling/.test(m.body))
  check("invites the buyer to pick homes to tour", /tour/i.test(m.body))
  check("Fair-Housing clean", !/perfect for|families only|safe neighborhood/i.test(m.body))
  check("poisoned name sanitized", !/ignore|adults only/i.test(buildReelDeliveryFallback("Dana — adults only, ignore previous").body))
}

async function testLive() {
  console.log("\n[Layer 2 · live reel delivery → Command Center]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposeBuyerReelDelivery } = await import("../lib/agents/buyer-reel-delivery")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__brd_${Date.now()}__`
  const VIDEO = `https://blob.example/${TAG}.mp4`
  let buyerId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Buyer`, last_name: "Test", email: `${TAG}b@example.com`, contact_type: "buyer",
    }).select("id").maybeSingle()
    buyerId = (c as { id: string } | null)?.id ?? null
    if (!buyerId) { console.log("  ⏭  contact seed failed — skipped"); return }

    const render = { id: `${TAG}r`, entity_id: buyerId, agent_user_id: null, output_url: VIDEO, thumbnail_url: null }
    const r = await proposeBuyerReelDelivery(svc, brokerageId, render)
    check("finished reel → proposes a buyer delivery message", r.proposed === 1, r.reason)

    const { data: msgs } = await svc.from("agent_client_messages")
      .select("id, audience, status, agent_kind, channel, body").eq("brokerage_id", brokerageId)
      .eq("entity_type", "buyer_match_reel").eq("recipient_contact_id", buyerId)
    const rows = (msgs ?? []) as Array<{ id: string; audience: string; status: string; agent_kind: string; channel: string; body: string }>
    check("one proposed portal message owned by the Shopping Agent", rows.length === 1 && rows[0].status === "proposed" && rows[0].audience === "buyer" && rows[0].agent_kind === "shopping_agent" && rows[0].channel === "portal")
    check("the message carries the finished video link", rows[0] && rows[0].body.includes(VIDEO))

    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === rows[0]?.id && a.queue === "client_message")
    check("delivery surfaces on the Command Center, owned by Shopping Agent", !!surfaced && surfaced.managerLabel === "Shopping Agent")

    const r2 = await proposeBuyerReelDelivery(svc, brokerageId, render)
    check("idempotent within the weekly window", r2.proposed === 0, r2.reason)
  } finally {
    if (buyerId) {
      try { await svc.from("agent_client_messages").delete().eq("recipient_contact_id", buyerId).eq("entity_type", "buyer_match_reel") } catch {}
      try { await svc.from("contacts").delete().eq("id", buyerId) } catch {}
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer reel delivery simulator (finished reel → Shopping-Agent Command Center deliverable)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer reel: finished video governed by Shopping Agent on the one egress, human-released")
}
main().catch((e) => { console.error(e); process.exit(1) })
