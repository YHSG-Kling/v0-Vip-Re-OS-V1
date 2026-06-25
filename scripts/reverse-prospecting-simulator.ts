#!/usr/bin/env tsx
/**
 * scripts/reverse-prospecting-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REVERSE PROSPECTING ENGINE harness — inventory becomes instant buyer demand.
 *
 * Layer 1 (pure, no creds): scoreBuyerMatch (reuses the market-watch scorer — in-budget +
 *   beds + city clears the bar; over-budget disqualifies); composeMatchNote (deterministic
 *   fallback names ONLY the listing facts — address, beds, price — no fabrication).
 * Layer 2 (live, gated on SUPABASE_SERVICE_ROLE_KEY): seed ONE fresh listing + 2 matching
 *   buyers (each with a property_preferences row that fits), run runReverseProspecting with
 *   an INJECTED copyGenerator (returns persona-tailored text, no LLM spend); assert a buyer
 *   note was PROPOSED into the gate per buyer (audience 'buyer', shopping_agent, tagged
 *   'REVERSE PROSPECTING') AND each buyer was queued to the AI ISA on the bus; assert the
 *   second pass is a no-op (idempotent). SELF-CLEANS every seeded row (tracked, reversed,
 *   verified 0 remain). Unique TAG per run.
 *
 * Run: npx tsx scripts/reverse-prospecting-simulator.ts  (npm run test:reverse-prospecting)
 */
import {
  scoreBuyerMatch,
  composeMatchNote,
  runReverseProspecting,
  REVERSE_PROSPECTING_TAG,
} from "../lib/kernel/reverse-prospecting"
import type { BuyerCriteria } from "../lib/buyer-search/buyer-criteria"
import type { CopyGenerator } from "../lib/kernel/ai-copy"

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
  console.log(" ✅ Reverse Prospecting verified — inventory → demand, all gated")
}

const baseCriteria = (over: Partial<BuyerCriteria> = {}): BuyerCriteria => ({
  minPrice: null, maxPrice: 600_000, minBeds: 3, minBaths: null,
  cities: ["Testville"], zipCodes: [], propertyTypes: [], mustHaveFeatures: [],
  dealBreakers: [], confidenceScore: 0.8, ...over,
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Reverse Prospecting simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · score + compose]")
  const fit = { list_price: 550_000, bedrooms: 4, bathrooms: 3, city: "Testville" }
  check("in-budget + enough beds + matching city → clears the one-to-one bar (≥70)",
    scoreBuyerMatch(baseCriteria(), fit) >= 70)
  check("over-budget listing → disqualified (0)",
    scoreBuyerMatch(baseCriteria({ maxPrice: 400_000 }), fit) === 0)
  check("too few beds → disqualified (0)",
    scoreBuyerMatch(baseCriteria({ minBeds: 5 }), fit) === 0)
  const note = composeMatchNote(
    { id: "x", address: "12 Cedar Court", city: "Testville", list_price: 550_000, bedrooms: 4, bathrooms: 3 },
    "Jordan",
  )
  check("fallback note names the buyer, the address, beds + price (no fabrication)",
    note.body.includes("Jordan") && note.body.includes("12 Cedar Court") &&
    note.body.includes("4-bed") && note.body.includes("$550,000"))
  check("fallback note offers a showing, no pressure", note.body.toLowerCase().includes("private showing"))

  // The call candidate hand-off to the AI ISA is now CONSUMED, not orphaned on the feed.
  {
    const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
    check("AI ISA consumes the reverse-prospecting call candidate (no longer a flat feed-only signal)",
      typeof SIGNAL_HANDLERS["ai_isa:reverse_prospecting_call_candidate"] === "function")
  }

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live reverse prospecting]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `RevP${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent with a brokerage."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // A fresh (active) listing matching the seeded buyers' criteria.
    const { data: lst } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 12 Cedar Court`, city: `${TAG}ville`,
      status: "active", agent_id: (agent as any).id,
      list_price: 550_000, bedrooms: 4, bathrooms: 3,
    }).select("id").single()
    cleanup.push({ table: "listings", id: (lst as any).id })
    const listingId = (lst as any).id

    // Two buyers, each with a fitting property_preferences row.
    const buyerIds: string[] = []
    for (const [i, first] of [[0, "Jordan"], [1, "Riley"]] as Array<[number, string]>) {
      const { data: c } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: `${TAG}${first}`, last_name: "Buyer",
        contact_type: "buyer", buyer_stage: "BUYER_SEARCHING",
        contact_persona: i === 0 ? "first-time buyer" : "move-up buyer",
      }).select("id").single()
      const cid = (c as any).id
      buyerIds.push(cid)
      cleanup.push({ table: "contacts", id: cid })
      const { data: pp } = await svc.from("property_preferences").insert({
        brokerage_id: brokerageId, contact_id: cid,
        preferred_price_max: 600_000, inferred_beds_min: 3,
        inferred_cities: [`${TAG}ville`], confidence_score: 0.9,
      }).select("id").single()
      cleanup.push({ table: "property_preferences", id: (pp as any).id })
    }

    // A non-matching buyer (over-budget criteria) — must NOT get a note.
    const { data: cNo } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Casey`, last_name: "Buyer",
      contact_type: "buyer", buyer_stage: "BUYER_SEARCHING",
    }).select("id").single()
    const noMatchId = (cNo as any).id
    cleanup.push({ table: "contacts", id: noMatchId })
    const { data: ppNo } = await svc.from("property_preferences").insert({
      brokerage_id: brokerageId, contact_id: noMatchId,
      preferred_price_max: 300_000, inferred_beds_min: 3, inferred_cities: [`${TAG}ville`],
    }).select("id").single()
    cleanup.push({ table: "property_preferences", id: (ppNo as any).id })

    // Injected copy generator — persona-tailored, no LLM spend.
    const copyGenerator: CopyGenerator = async (req) => ({
      subject: "A home just came up for you",
      body: `Tailored for the ${req.persona.situation ?? "buyer"}: ${req.facts[0]}. Worth a private look — reply and I'll arrange it.`,
    })

    const r1 = await runReverseProspecting(brokerageId, { copyGenerator }, svc)
    check("reverse prospecting: convened (1 fresh listing, 2 matched buyers, 2 notes, 2 ISA queued)",
      r1.listings >= 1 && r1.matches >= 2 && r1.notesProposed >= 2 && r1.isaQueued >= 2)

    // Shopping Agent: a persona-aware buyer note PER matched buyer, gated.
    const { data: notes } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, recipient_contact_id, body, rationale, channel")
      .eq("entity_type", "listing").eq("entity_id", listingId)
      .ilike("rationale", `${REVERSE_PROSPECTING_TAG}%`)
    const noteRows = (notes ?? []) as any[]
    for (const n of noteRows) cleanup.push({ table: "agent_client_messages", id: n.id })
    // approval-needed notifications spawned by proposeClientMessage's real-time gate.
    for (const n of noteRows) {
      const { data: nt } = await svc.from("notifications").select("id")
        .eq("entity_id", n.id).eq("entity_type", "agent_client_message").limit(3)
      for (const x of (nt ?? []) as any[]) cleanup.push({ table: "notifications", id: x.id })
    }
    const recipients = new Set(noteRows.map((n) => n.recipient_contact_id))
    check("Shopping Agent: ONE buyer note per matched buyer (audience 'buyer', shopping_agent, portal, proposed)",
      noteRows.length === 2 &&
      noteRows.every((n) => n.status === "proposed" && n.audience === "buyer" && n.agent_kind === "shopping_agent" && n.channel === "portal") &&
      buyerIds.every((id) => recipients.has(id)))
    check("Shopping Agent: persona-aware copy used (the injected generator's text landed, not the fallback)",
      noteRows.every((n) => (n.body ?? "").includes("Tailored for the")))
    check("non-matching (over-budget) buyer got NO note", !recipients.has(noMatchId))

    // AI ISA: each matched buyer queued as a call candidate on the bus.
    const { data: sigs } = await svc.from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, contact_id, entity_id, payload")
      .eq("brokerage_id", brokerageId).eq("to_manager", "ai_isa")
      .eq("signal_type", "reverse_prospecting_call_candidate")
      .in("contact_id", buyerIds)
    const sigRows = (sigs ?? []) as any[]
    for (const s of sigRows) cleanup.push({ table: "manager_signals", id: s.id })
    check("AI ISA: each matched buyer queued as a call candidate (from shopping_agent → ai_isa, carries the listing)",
      sigRows.length === 2 &&
      sigRows.every((s) => s.from_manager === "shopping_agent" && (s.payload?.listing_id === listingId)) &&
      buyerIds.every((id) => sigRows.some((s) => s.contact_id === id)))

    // Idempotency — the second pass proposes NOTHING new (notes already exist for the pairs).
    const r2 = await runReverseProspecting(brokerageId, { copyGenerator }, svc)
    check("idempotency: second pass proposes no new buyer notes", r2.notesProposed === 0)
    const { count: noteCount } = await svc.from("agent_client_messages")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", listingId).ilike("rationale", `${REVERSE_PROSPECTING_TAG}%`)
    check("idempotency: still exactly 2 buyer notes after the second pass", (noteCount ?? 0) === 2)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified — 0 seeded listings remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
