#!/usr/bin/env tsx
/**
 * scripts/open-house-lead-routing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves OPEN-HOUSE LEAD ROUTING — the seller-event → buyer-pipeline bridge. Hot, UNREPRESENTED
 * buyers from a Listing Concierge open house are handed to the AI ISA over the bus to qualify,
 * instead of dying as a dashboard count. Represented buyers (already have an agent) are excluded.
 *
 * Layer 1 (shell, pure): the selection (hot by score or interest; skip represented; sorted).
 * Layer 2 (live, creds-gated): publish a real handoff signal → assert it landed to ai_isa with the
 * leads → idempotent per event → clean up.
 *
 * Run: npx tsx scripts/open-house-lead-routing-simulator.ts   (npm run test:open-house-lead-routing)
 */
import { selectOpenHouseHandoffs } from "../lib/intelligence/open-house-lead-routing"

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
  console.log(" ✅ Open-house lead routing verified — hot buyers bridge to the ISA; represented buyers skipped.")
  console.log(" OPEN_HOUSE_LEAD_ROUTING_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Open-house lead routing simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · selection]")
  const attendees = [
    { id: "a1", ai_lead_score: 85, interest_level: "very_interested", name: "Hot Score" },
    { id: "a2", ai_lead_score: 30, interest_level: "ready_to_offer", name: "Hot Interest" }, // low score but hot interest
    { id: "a3", ai_lead_score: 90, interest_level: "ready_to_offer", name: "Represented", has_agent: true }, // excluded
    { id: "a4", ai_lead_score: 20, interest_level: "just_looking", name: "Cold" }, // excluded
  ]
  const hot = selectOpenHouseHandoffs(attendees)
  check("hot by score is selected", hot.some((h) => h.attendeeId === "a1"))
  check("hot by interest (low score) is selected", hot.some((h) => h.attendeeId === "a2"))
  check("a REPRESENTED buyer is excluded (no poaching)", !hot.some((h) => h.attendeeId === "a3"))
  check("a cold attendee is excluded", !hot.some((h) => h.attendeeId === "a4"))
  check("sorted strongest-first", hot[0].score >= hot[hot.length - 1].score)
  check("none hot → empty (honest)", selectOpenHouseHandoffs([{ id: "x", ai_lead_score: 10, interest_level: "just_looking" }]).length === 0)

  // The hand-off is now CONSUMED — the ISA qualifies the hot buyers (no longer a feed-only drop).
  {
    const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
    check("AI ISA consumes the open-house hand-off (hot buyers qualified, not a dashboard count)",
      typeof SIGNAL_HANDLERS["ai_isa:open_house_lead_handoff"] === "function")
  }

  console.log("\n[Layer 2 · live: hand off to the ISA over the bus]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { handoffOpenHouseLeads } = await import("../lib/intelligence/open-house-lead-routing-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const eventId = uuid()
  try {
    const r = await handoffOpenHouseLeads({
      brokerageId, eventId, listingId: uuid(), propertyAddress: "55 Elm St",
      attendees: [
        { id: uuid(), ai_lead_score: 88, interest_level: "very_interested", name: "Casey Hot" },
        { id: uuid(), ai_lead_score: 15, interest_level: "just_looking", name: "Cold" },
      ],
    }, svc)
    check("handed the hot buyer (only) to the ISA", r.handed === 1, JSON.stringify(r))

    const { data: sig } = await svc.from("manager_signals")
      .select("to_manager, signal_type, payload").eq("brokerage_id", brokerageId).eq("entity_id", eventId)
      .eq("signal_type", "open_house_lead_handoff").maybeSingle()
    check("a handoff signal exists to ai_isa carrying the lead", (sig as any)?.to_manager === "ai_isa" && Array.isArray((sig as any)?.payload?.leads) && (sig as any).payload.leads.length === 1, JSON.stringify(sig))

    const again = await handoffOpenHouseLeads({ brokerageId, eventId, attendees: [{ id: uuid(), ai_lead_score: 88, interest_level: "very_interested" }] }, svc)
    check("re-handoff for the same event is idempotent", again.handed === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("entity_id", eventId).eq("signal_type", "open_house_lead_handoff").then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", eventId).eq("signal_type", "open_house_lead_handoff")
    check("cleanup: handoff signals removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
