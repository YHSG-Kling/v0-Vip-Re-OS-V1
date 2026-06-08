#!/usr/bin/env tsx
/**
 * scripts/narration-orchestrator-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — proves the narration pipeline degrades gracefully so a brokerage
 * with NO voice clone and NO avatar still gets a valid, branded video. Tests
 * planSectionNarrationJob across every combination (the decision that makes the
 * no-clone / no-avatar path work). Pure — runs fully in CI.
 *
 *   voice clone + avatar → avatar_narrated
 *   voice clone, no avatar → voice_only
 *   no clone, has avatar  → avatar (D-ID voices the script), but no cloned voiceover
 *   neither               → on_screen_only
 *
 * Run:  npx tsx scripts/narration-orchestrator-simulator.ts   (npm run test:narration-orchestrator)
 */
import { planSectionNarrationJob } from "../lib/listing-presentation/section-narration-orchestrator"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Narration orchestrator simulator (graceful degradation)")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[full — voice clone + avatar]")
  const full = planSectionNarrationJob({ hasScript: true, hasVoiceClone: true, hasAvatarSource: true })
  check("mode = avatar_narrated", full.mode === "avatar_narrated")
  check("voiceover + avatar both on", full.voiceover === true && full.avatar === true)

  console.log("\n[voice clone, NO avatar]")
  const voice = planSectionNarrationJob({ hasScript: true, hasVoiceClone: true, hasAvatarSource: false })
  check("mode = voice_only", voice.mode === "voice_only")
  check("voiceover on, avatar off (static-photo PIP)", voice.voiceover === true && voice.avatar === false)

  console.log("\n[NO clone, NO avatar — the owner's current state]")
  const none = planSectionNarrationJob({ hasScript: true, hasVoiceClone: false, hasAvatarSource: false })
  check("mode = on_screen_only (video still renders)", none.mode === "on_screen_only")
  check("no voiceover, no avatar — degrades cleanly", none.voiceover === false && none.avatar === false)

  console.log("\n[NO clone, HAS avatar — D-ID voices the script]")
  const avatarOnly = planSectionNarrationJob({ hasScript: true, hasVoiceClone: false, hasAvatarSource: true })
  check("avatar on even without a cloned voice", avatarOnly.avatar === true && avatarOnly.mode === "avatar_narrated")
  check("no cloned voiceover when there's no clone", avatarOnly.voiceover === false)

  console.log("\n[no script — nothing to narrate]")
  const noScript = planSectionNarrationJob({ hasScript: false, hasVoiceClone: true, hasAvatarSource: true })
  check("no script → on_screen_only regardless of clone/avatar", noScript.mode === "on_screen_only" && !noScript.voiceover && !noScript.avatar)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Narration degrades gracefully — valid video with or without clone/avatar")
}
main()
