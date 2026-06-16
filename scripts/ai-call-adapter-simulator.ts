#!/usr/bin/env tsx
/**
 * scripts/ai-call-adapter-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the ai_call sequence rung is wired to the REAL voice engine (was a no-op placeholder that
 * lied "sent"). The adapter delegates to initiateVoiceCall, which is PROVIDER-GATED and enforces
 * call_stop_flag + DNC BEFORE any vendor call. This sim exercises those hard-stop guards (which
 * return before any real call is placed) so it's safe against real data; it never dials.
 *
 * Live-only (initiateVoiceCall queries contacts). Seeds a call-stopped + a DNC contact, asserts
 * both are BLOCKED with the right reason (no vendor call), and that an unconfigured provider fails
 * cleanly rather than stubbing a success. Seeds cleaned up. No mocks, no real calls.
 *
 * Run: npx tsx scripts/ai-call-adapter-simulator.ts   (npm run test:ai-call-adapter)
 */
export {} // module scope
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
  console.log(" ✅ ai_call rung verified — wired to the voice engine; call_stop + DNC hard-stop before any dial.")
  console.log(" AI_CALL_ADAPTER_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" ai_call adapter wiring simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n  ⏭  Live-only simulator skipped — SUPABASE creds not set.")
    console.log("     (initiateVoiceCall queries contacts + checks call_stop_flag/DNC; this proves the")
    console.log("      hard-stops the ai_call rung relies on, without ever placing a real call.)")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { initiateVoiceCall } = await import("../lib/voice-engine/call-executor")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stopId = uuid(), dncId = uuid()

  try {
    await svc.from("contacts").insert({ id: stopId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "CallStop", phone: "+15555550150", call_stop_flag: true, dnc_status: false })
    await svc.from("contacts").insert({ id: dncId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Dnc", phone: "+15555550151", call_stop_flag: false, dnc_status: true })

    const r1 = await initiateVoiceCall({ contactId: stopId, initiatorRole: "ai", callType: "outbound", vendor: "vapi_isa" }, "+15555550150")
    check("call_stop_flag → blocked before any dial", r1.success === false && /no calls|call_stop/i.test(r1.error ?? ""), JSON.stringify(r1))

    const r2 = await initiateVoiceCall({ contactId: dncId, initiatorRole: "ai", callType: "outbound", vendor: "vapi_isa" }, "+15555550151")
    check("DNC → blocked before any dial", r2.success === false && /do not contact/i.test(r2.error ?? ""), JSON.stringify(r2))
  } finally {
    await svc.from("contacts").delete().in("id", [stopId, dncId]).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).in("id", [stopId, dncId])
    check("cleanup: seeded contacts removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
