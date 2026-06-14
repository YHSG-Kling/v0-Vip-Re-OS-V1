#!/usr/bin/env tsx
/**
 * scripts/client-actor-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE CLIENT BECOMES AN ACTOR: a buyer/seller portal request flows into the SAME manager
 * bench + approval gate the agent uses — gated and compliant. Search/save/ask is OPEN; only the
 * in-person showing is BBA-relevant (NAR 2024); a seller's price change is PROPOSED to the agent,
 * never auto-executed.
 *
 * Layer 1 (pure, always runs): the intent classifier + routing matrix — the compliance contract.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated): a seller's "drop my price" request becomes a
 *   PROPOSED agent_client_message (gated, not sent). Seed reverse-deleted. No mocks.
 *
 * Run: npx tsx scripts/client-actor-simulator.ts   (npm run test:client-actor)
 */
import { classifyClientIntent, routeClientIntent } from "../lib/portal/client-action-router"

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
  console.log(" ✅ Client-as-actor verified — client requests flow to gated manager actions, compliant.")
  console.log(" CLIENT_ACTOR_PASS")
}

function routeFor(msg: string, type: string | null) {
  return routeClientIntent(classifyClientIntent(msg, type), type)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Client-as-actor concierge simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · intent classification + compliance routing]")
  // Showing — BBA-relevant, NOT gated (requestShowing enforces BBA downstream), owned by Shopping Agent.
  const show = routeFor("Can I see 12 Oak Lane this weekend?", "buyer")
  check("buyer 'see 12 Oak this weekend' → create_showing", show.kind === "create_showing")
  check("showing is the ONLY BBA-relevant path", show.bbaRelevant === true && show.manager === "shopping_agent")
  // Search — OPEN, no BBA, no gate.
  const search = routeFor("show me more like 44 Birch", "buyer")
  check("buyer 'show me more like 44 Birch' → open_search", search.kind === "open_search")
  check("search is NOT BBA-relevant and NOT gated (browse is open)", search.bbaRelevant === false && search.gated === false)
  // Seller action — gated proposal to Listing Concierge.
  const sell = routeFor("drop my price to 499", "seller")
  check("seller 'drop my price to 499' → propose_to_agent", sell.kind === "propose_to_agent")
  check("seller action is GATED + owned by Listing Concierge", sell.gated === true && sell.manager === "listing_concierge")
  check("seller action is NOT BBA-relevant (it's a listing change, not a tour)", sell.bbaRelevant === false)
  // Question — advisory only.
  const q = routeFor("how long does closing usually take?", "buyer")
  check("buyer 'how long does closing take' → advisory (no action)", q.kind === "advisory" && q.gated === false)
  // A buyer cannot trigger a seller action (contact-type scoped).
  check("a BUYER saying 'drop the price' does NOT route to a seller action", routeFor("drop the price", "buyer").kind !== "propose_to_agent")

  console.log("\n[Layer 2 · live: a seller portal request becomes a GATED proposal]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { dispatchClientAction } = await import("../lib/portal/client-action-dispatch")
  const supabase = createServiceClient()

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()

  const { data: seller } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, agent_id: (agent as any).id,
    first_name: "ZZSeller", last_name: `Actor${stamp}`, email: `zz-actor-${stamp}@example.com`,
    contact_type: "seller", source: "test",
  }).select("id").single()
  const contactId = (seller as any)?.id

  // Inject a deterministic copy generator (no live model) — proves copy is GENERATED per persona,
  // not hardcoded. A real injected function, not a stub of the system under test.
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  try {
    const r = await dispatchClientAction(
      { brokerageId, contactId, contactType: "seller", message: "Please drop my price to 499", newPrice: 499000, copyGenerator: stampGen },
      supabase,
    )
    check("seller request routed to a gated agent proposal", r.ok === true && r.outcome === "proposed_to_agent", JSON.stringify(r).slice(0, 140))
    check("a proposal id came back", !!r.proposalId)
    check("client-facing reply is GENERATED copy, not hardcoded", (r.spoken ?? "").startsWith("ZZGEN"), r.spoken)

    // The proposal is PROPOSED (in the agent's queue), not sent — human in the loop.
    const { data: prop } = await supabase
      .from("agent_client_messages").select("status, agent_kind, body").eq("id", r.proposalId ?? "none").maybeSingle()
    check("the proposal landed as 'proposed' (gated, not sent)", (prop as any)?.status === "proposed", `status=${(prop as any)?.status}`)
    check("attributed to the Listing Concierge", (prop as any)?.agent_kind === "listing_concierge")
    check("proposal body is GENERATED copy, not hardcoded", String((prop as any)?.body ?? "").startsWith("ZZGEN"))
  } finally {
    await supabase.from("agent_client_messages").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
