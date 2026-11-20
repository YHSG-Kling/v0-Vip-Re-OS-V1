// scripts/isa-voice-record-simulator.ts   (npm run test:isa-voice-record)
// ─────────────────────────────────────────────────────────────────────────────
// ISA VOICE — RECORD A SAMPLE → CLONE → SET AS ISA VOICE (the named gap: "isa
// voice settings no way to record voice sample"). The ISA voice card was
// selection-only (premade voices). This wires the EXISTING clone rig — the shared
// browser VoiceRecorder, the twin-voice-samples upload, and the real ElevenLabs
// /voices/add route — into the ISA voice surface, saving the clone as the
// brokerage's default ISA voice. Reuse, not a parallel path.

import { readFileSync } from "node:fs"
import { join } from "node:path"
// The roster the route gates on, asked of the SAME predicate — so this proof
// cannot agree with a rule the route does not use.
import { isAdminOrBroker } from "../lib/auth/resolve-user-role"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the clone route gained an ISA-default target (broker-gated) ──")
{
  const r = src("app/api/elevenlabs/voice-clone/route.ts")
  check("accepts isa_default and requires one of profile_id/twin_id/isa_default",
    r.includes("isa_default") && r.includes("profile_id (legacy), twin_id (Twin Studio), or isa_default"))
  // PINNED TO THE GATE, NOT TO ITS SPELLING.
  //
  // This was a regex over the literal role array `["broker","broker_admin",
  // "admin","superadmin"]`. Repointing the gate onto the ONE shared tenant-admin
  // roster (owner ruling: "having more than one vocab over the same function or
  // feature is dangerous") turned it red on an improvement — the shared roster
  // ADMITS broker_owner, whom the literal refused, so the person who owns the
  // brokerage could not set their own brokerage's ISA voice; and it drops a
  // `superadmin` user_type branch that MEASURED live matches zero rows. Worse,
  // the old regex would have stayed GREEN through a real regression: change
  // `!includes` to `includes` and it still matches.
  check("setting the brokerage-wide ISA voice is gated on the shared tenant-admin roster",
    /if\s*\(\s*isa_default\s*&&\s*!isAdminOrBroker\s*\(\s*\{\s*user_type/.test(r))
  check("...and the gate REFUSES rather than falling through (403, not a warning)",
    /isa_default && !isAdminOrBroker[\s\S]{0,200}?status:\s*403/.test(r))
  check("...and that roster is IMPORTED, not re-declared here",
    /import\s*\{[^}]*isAdminOrBroker[^}]*\}\s*from\s*"@\/lib\/auth\/resolve-user-role"/.test(r))
  check("...and it admits the brokerage's own roles, broker_owner included, while refusing an agent",
    ["broker", "broker_owner", "admin"].every((t) => isAdminOrBroker({ user_type: t })) &&
    !isAdminOrBroker({ user_type: "agent" }) && !isAdminOrBroker({ user_type: "isa" }))
  check("saves the clone as brokerages.default_isa_voice_id",
    r.includes('.from("brokerages")') && r.includes("default_isa_voice_id: elevenlabs_voice_id"))
  check("still a REAL clone — POST /v1/voices/add, no faked id",
    r.includes("/voices/add") && r.includes("elData.voice_id"))
  check("honest not-configured: 503 when ELEVENLABS_API_KEY is missing",
    r.includes("ElevenLabs API key not configured") && r.includes("503"))
  check("metered as a voice clone (isa_default_voice feature)",
    r.includes("logMediaUsage") && r.includes('"isa_default_voice"'))
}

console.log("\n── the ISA voice settings surface can now RECORD → clone ──")
{
  const ui = src("app/dashboard/admin/phone-settings/phone-settings-client.tsx")
  check("reuses the EXISTING shared VoiceRecorder (no new recorder built)",
    ui.includes('from "@/app/dashboard/settings/twin-studio/components/voice-recorder"') && ui.includes("<VoiceRecorder"))
  check("uploads via the BROKERAGE-scoped voice upload (works for a pure admin with no agents row)",
    ui.includes("uploadBrokerageVoiceSample"))
  check("POSTs the sample to the clone route with isa_default",
    ui.includes('"/api/elevenlabs/voice-clone"') && ui.includes("isa_default: true"))
  check("on success sets the recorded clone as the ISA voice",
    ui.includes("defaultIsaVoiceId: data.elevenlabs_voice_id"))
  check("surfaces the honest 'ElevenLabs not configured' path (503)",
    ui.includes("res.status === 503") && /ElevenLabs isn.t configured/.test(ui))
  check("a 'Record a custom voice' affordance is rendered",
    ui.includes("Record a custom voice"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ ISA_VOICE_RECORD_FAIL"); process.exit(1) }
console.log(" ✅ ISA_VOICE_RECORD_PASS — record a sample → real ElevenLabs clone → saved as the ISA voice")
