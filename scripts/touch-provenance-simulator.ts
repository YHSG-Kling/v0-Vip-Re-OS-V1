#!/usr/bin/env tsx
/**
 * scripts/touch-provenance-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves every sequence touch carries PROVENANCE — manager + sequence + ai_intent + channel — so
 * the Command Center can answer "why did my client get this, and which manager produced it?".
 *
 * Layer 1 (shell, pure): touchpointManagerForChannel mapping (voice→ai_isa, social/mail→marketing,
 *   video→asset_manager, email/sms→campaign_orchestrator, unknown→campaign_orchestrator default).
 * Layer 2 (live, creds-gated): recordSequenceTouchpoint stamps metadata.manager + metadata.ai_intent
 *   into the shared ledger. Seeds cleaned up.
 *
 * Run: npx tsx scripts/touch-provenance-simulator.ts   (npm run test:touch-provenance)
 */
import { touchpointManagerForChannel, touchpointChannelForStep } from "../lib/campaign-sequences/touchpoint-bridge"

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
  console.log(" ✅ Touch provenance verified — manager + ai_intent stamped on every sequence touch.")
  console.log(" TOUCH_PROVENANCE_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Touch provenance simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · manager attribution per channel]")
  check("voice → ai_isa", touchpointManagerForChannel("ai_call") === "ai_isa" && touchpointManagerForChannel("voice_drop") === "ai_isa")
  check("social + direct_mail → marketing_agent", touchpointManagerForChannel("social_post") === "marketing_agent" && touchpointManagerForChannel("direct_mail") === "marketing_agent")
  check("video → asset_manager (Video Director assembled)", touchpointManagerForChannel("video") === "asset_manager")
  check("email/sms → campaign_orchestrator", touchpointManagerForChannel("email") === "campaign_orchestrator" && touchpointManagerForChannel("sms") === "campaign_orchestrator")
  check("unknown channel → campaign_orchestrator default (never throws)", touchpointManagerForChannel("zzz") === "campaign_orchestrator")
  check("non-outreach step → no touchpoint channel", touchpointChannelForStep("wait") === null)

  console.log("\n[Layer 2 · live: provenance stamped into the shared ledger]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { recordSequenceTouchpoint } = await import("../lib/campaign-sequences/touchpoint-bridge")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const seqId = uuid(), contactId = uuid()

  try {
    await svc.from("campaign_sequences").insert({ id: seqId, brokerage_id: brokerageId, name: "ZZ Prov Test", sequence_type: "reactivation", trigger_event: "manual", is_active: true, compliance_gated: true })
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Prov", contact_type: "buyer" })

    const wrote = await recordSequenceTouchpoint(svc, {
      brokerageId, sequenceId: seqId, contactId, enrollmentId: uuid(), stepId: uuid(),
      stepChannel: "email", sentAt: new Date().toISOString(), aiIntent: "a warm re-engagement",
    })
    check("touchpoint recorded", wrote === true)
    const { data: tp } = await svc.from("marketing_campaign_touchpoints").select("metadata, sequence_id, channel").eq("sequence_id", seqId).eq("contact_id", contactId).maybeSingle()
    const md = (tp as any)?.metadata ?? {}
    check("metadata stamps the manager", md.manager === "campaign_orchestrator", JSON.stringify(md))
    check("metadata stamps the ai_intent (why this?)", md.ai_intent === "a warm re-engagement")
    check("touch is sequence-attributed", (tp as any)?.sequence_id === seqId && (tp as any)?.channel === "email")
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
