#!/usr/bin/env tsx
/**
 * scripts/voice-buyer-search-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the spoken admin can SEARCH FOR A BUYER — "find the Hendersons a 3-bed under 500k in Austin".
 * The buyer-search core existed but was unreachable from the cockpit; now find_properties is a
 * registered, governance-clean voice tool dispatched through the shared team-command dispatcher.
 *
 * Layer 1 (pure): the tool is registered, read-only, passes voice-coverage; the dispatcher claims it.
 * Layer 2 (live, creds-gated): seed a buyer + a matching listing, dispatch find_properties, assert a
 * spoken match; reverse-delete; cleanup count == 0.
 *
 * Run: npx tsx scripts/voice-buyer-search-simulator.ts   (npm run test:voice-buyer-search)
 */
import { voiceTools } from "../lib/voice/tool-registry"
import { voiceCoverageViolations } from "../lib/voice/voice-coverage"
import { isTeamCommand, BUYER_COMMANDS, dispatchTeamCommand } from "../lib/voice/team-commands"

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
  console.log(" ✅ Voice buyer-search wired — the spoken admin can search inventory + the market for a buyer.")
  console.log(" VOICE_BUYER_SEARCH_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Voice buyer-search simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · registered + governance-clean + dispatchable]")
  const tool = voiceTools["find_properties"]
  check("find_properties is registered", !!tool)
  check("it is read-only (lookup, not outbound, not telco)", !!tool && tool.category === "lookup" && !tool.is_outbound && !tool.is_telco_initiating)
  check("authority is agent_or_isa (not open to anyone)", tool?.authority === "agent_or_isa")
  check("voice-coverage still ZERO violations with the new tool", voiceCoverageViolations().length === 0)
  check("dispatcher claims find_properties (isTeamCommand)", isTeamCommand("find_properties") && BUYER_COMMANDS.has("find_properties"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log("\n[Layer 2 · live spoken search]")
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a brokerage."); return report() }
  const brokerageId = (brk as any).id
  const { data: agent } = await svc.from("agents").select("user_id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
  const agentUserId = (agent as any)?.user_id ?? "00000000-0000-0000-0000-0000000000aa"

  const cleanup: Array<{ table: string; id: string }> = []
  let contactId = ""
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZVoice", last_name: `Buyer-${Date.now()}`,
      email: `zz-vbs-${Date.now()}@example.com`, contact_type: "buyer",
    }).select("id").single()
    contactId = (c as any).id; cleanup.push({ table: "contacts", id: contactId })

    const { data: l } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: "9 Voice Way", city: "Austin", state: "TX", zip: "78701",
      list_price: 460000, bedrooms: 3, bathrooms: 2, sqft: 1800, property_type: "single_family", status: "active",
    }).select("id").single()
    cleanup.push({ table: "listings", id: (l as any).id })

    const r = await dispatchTeamCommand("find_properties",
      { contact_id: contactId, query: "3 bedroom 2 bath house in Austin under 500k" },
      { brokerageId, agentUserId, firstName: "Test" }, svc)
    check("find_properties dispatch returns ok", r.ok === true, JSON.stringify(r))
    check("spoken answer reads back a match count", /\bI found \d+ match/i.test(r.spoken), r.spoken)
    check("data carries a result count ≥ 1", ((r.data as any)?.count ?? 0) >= 1, JSON.stringify(r.data))

    // Missing buyer → asks for the name (no silent failure).
    const noWho = await dispatchTeamCommand("find_properties", { query: "3 bed in Austin" }, { brokerageId, agentUserId, firstName: "Test" }, svc)
    check("no buyer named → asks who it's for", noWho.ok === false && /who/i.test(noWho.spoken))
  } finally {
    // logSignals may write buyer_search rows keyed by contact — clear by contact then the seeds.
    await svc.from("buyer_search_signals").delete().eq("contact_id", contactId || "none").then(() => {}, () => {})
    await svc.from("property_search_logs").delete().eq("contact_id", contactId || "none").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId || "none")
    check("cleanup: seeded contact removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
