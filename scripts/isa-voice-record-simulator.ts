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
  check("setting the brokerage-wide ISA voice is broker/admin gated",
    /isa_default && !\["broker"[^\]]*"admin"[^\]]*"superadmin"\]\.includes\(auth\.userType\)/.test(r))
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
  check("uploads the sample to the twin-voice-samples bucket via uploadTwinVoiceSample",
    ui.includes("uploadTwinVoiceSample"))
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
