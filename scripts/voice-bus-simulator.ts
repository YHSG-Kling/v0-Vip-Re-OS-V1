#!/usr/bin/env tsx
/**
 * scripts/voice-bus-simulator.ts   (npm run test:voice-bus)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the ElevenLabs voice admin joins the ONE COMMAND CENTER: every spoken ACTING
 * tool (create_task / log_activity / send_portal_message) surfaces on the manager-signals
 * "managers talking" feed as an attributed entry, instead of running as silent CRUD.
 *
 *   PURE: ownerManagerForVoiceAction (each tool → its owning manager) + voiceBusRoute
 *         (owner records it with the Data Steward; from !== to always, so the bus accepts
 *         the route) — validated against validSignalRoute + the real MANAGERS registry.
 *
 * The publish itself is best-effort I/O; the testable core is the routing. No mocks.
 */
import { ownerManagerForVoiceAction, voiceBusRoute, type VoiceActionTool } from "../lib/voice/voice-bus"
import { validSignalRoute } from "../lib/kernel/manager-signals"
import { MANAGERS } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  const tools: VoiceActionTool[] = ["create_task", "log_activity", "send_portal_message"]

  console.log("\n[each voice action maps to a real owning manager]")
  for (const t of tools) {
    const owner = ownerManagerForVoiceAction(t)
    check(`${t} → ${owner} (a registered manager)`, owner in MANAGERS)
  }
  check("create_task → deal_coordinator", ownerManagerForVoiceAction("create_task") === "deal_coordinator")
  check("log_activity → ai_isa", ownerManagerForVoiceAction("log_activity") === "ai_isa")
  check("send_portal_message → campaign_orchestrator", ownerManagerForVoiceAction("send_portal_message") === "campaign_orchestrator")

  console.log("\n[the bus route is always valid — from !== to, both registered]")
  for (const t of tools) {
    const { from, to } = voiceBusRoute(ownerManagerForVoiceAction(t))
    check(`${t}: ${from} → ${to} is a valid bus route`, validSignalRoute(from, to))
    check(`${t}: records with the Data Steward`, to === "data_steward")
  }

  console.log("\n[owner == data_steward edge case → routes to deal_coordinator, never self]")
  const r = voiceBusRoute("data_steward")
  check("data_steward owner → to deal_coordinator (from !== to)", r.from === "data_steward" && r.to === "deal_coordinator" && validSignalRoute(r.from, r.to))

  console.log("\n[the voice_action signal type is catalogued (signal-integrity)]")
  check("voice_action registered as feed_only/update (no orphan, no dead handler)",
    SIGNAL_REGISTRY.voice_action?.disposition === "feed_only" && SIGNAL_REGISTRY.voice_action?.kind === "update" && SIGNAL_REGISTRY.voice_action?.consumers.length === 0)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VOICE_BUS_FAIL"); process.exit(1) }
  console.log(" ✅ VOICE_BUS_PASS — every spoken action surfaces on the managers-talking feed, attributed + accountable")
}
main()
