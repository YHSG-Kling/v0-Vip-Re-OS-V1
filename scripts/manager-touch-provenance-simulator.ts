#!/usr/bin/env tsx
/**
 * scripts/manager-touch-provenance-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the provenance-powered standup: per manager, how many touches went out, on which
 * channels, and the distinct intents behind them ("AI team reporting in, with receipts").
 *
 * Layer 1 (shell, pure): aggregateTouchProvenance — groups by metadata.manager, counts, collects
 *   distinct channels + intents, attributes missing manager as 'unattributed', sorts by volume.
 * Layer 2 (live, creds-gated): summarizeManagerTouches reads real touchpoints. Seeds cleaned up.
 *
 * Run: npx tsx scripts/manager-touch-provenance-simulator.ts   (npm run test:touch-provenance-standup)
 */
import { aggregateTouchProvenance } from "../lib/intelligence/manager-touch-provenance"

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
  console.log(" ✅ Provenance standup verified — per-manager touches, channels, and intents (receipts).")
  console.log(" TOUCH_PROVENANCE_STANDUP_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager touch-provenance standup simulator")
  console.log("══════════════════════════════════════════════════\n")

  const rows = [
    { channel: "email", metadata: { manager: "ai_isa", ai_intent: "a warm re-engagement" } },
    { channel: "sms", metadata: { manager: "ai_isa", ai_intent: "a quick text nudge" } },
    { channel: "email", metadata: { manager: "ai_isa", ai_intent: "a warm re-engagement" } }, // dup intent
    { channel: "direct_mail", metadata: { manager: "marketing_agent", ai_intent: "a just-listed postcard" } },
    { channel: "phone", metadata: { manager: null, ai_intent: null } }, // unattributed
  ]
  const agg = aggregateTouchProvenance(rows)
  const isa = agg.find((a) => a.manager === "ai_isa")
  check("groups by manager + counts touches", isa?.touchCount === 3)
  check("collects distinct channels", JSON.stringify(isa?.channels) === JSON.stringify(["email", "sms"]))
  check("collects DISTINCT intents (dedupes)", isa?.sampleIntents.length === 2)
  check("missing manager → 'unattributed'", !!agg.find((a) => a.manager === "unattributed"))
  check("sorted by touch volume (busiest manager first)", agg[0].manager === "ai_isa")
  check("empty input → empty summary", aggregateTouchProvenance([]).length === 0)

  console.log("\n[Layer 2 · live: summarize real touchpoints]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { summarizeManagerTouches } = await import("../lib/intelligence/manager-touch-provenance")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const seqId = uuid(), contactId = uuid()
  try {
    await svc.from("campaign_sequences").insert({ id: seqId, brokerage_id: brokerageId, name: "ZZ Prov Standup", sequence_type: "reactivation", trigger_event: "manual", is_active: true, compliance_gated: true })
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "ProvStandup", contact_type: "buyer" })
    await svc.from("marketing_campaign_touchpoints").insert({ brokerage_id: brokerageId, sequence_id: seqId, contact_id: contactId, channel: "email", status: "sent", sent_at: new Date().toISOString(), source: "sequence", metadata: { manager: "ai_isa", ai_intent: "ZZ re-engage" } })

    const summary = await summarizeManagerTouches(svc, brokerageId, 7)
    // null = the read was REFUSED (§3). It is NOT "no touches" — the standup keys on that
    // distinction to avoid printing zero touches as a fact, so the simulator asserts it too.
    check("read succeeded (null would mean REFUSED, not empty)", summary !== null)
    const isaLive = (summary ?? []).find((s) => s.manager === "ai_isa")
    check("live summary includes the seeded ai_isa touch + intent", !!isaLive && isaLive.touchCount >= 1 && isaLive.sampleIntents.length >= 1, JSON.stringify(isaLive))
  } finally {
    await svc.from("marketing_campaign_touchpoints").delete().eq("sequence_id", seqId).then(() => {}, () => {})
    await svc.from("campaign_sequences").delete().eq("id", seqId).then(() => {}, () => {})
    await svc.from("contacts").delete().eq("id", contactId).then(() => {}, () => {})
    const { count } = await svc.from("marketing_campaign_touchpoints").select("id", { count: "exact", head: true }).eq("sequence_id", seqId)
    check("cleanup: touchpoint removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
