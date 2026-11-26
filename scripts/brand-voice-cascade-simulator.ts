// scripts/brand-voice-cascade-simulator.ts   (npm run test:brand-voice-cascade)
// ─────────────────────────────────────────────────────────────────────────────
// BRAND VOICE CASCADE — proves the AI pipeline resolves brand VOICE the same way
// resolveBrandContext resolves brand SETTINGS: the brokerage voice is ALWAYS the
// base (content pulls from the tenant of record), then the TEAM and AGENT voices
// overlay. The bug: resolveBrandVoice read only brokerages.brand_voice_profile, so
// a team's/agent's own voice never applied. brand_voice_profile is scoped by
// brokerage_id / team_id / agent_id (scripts 524 + 1049).
//
// WAVE 151 (lane 151I) — THE READS MOVED TO THE SURVIVOR, THE RULE DID NOT. pipeline.ts's private three-row read was a
// second spelling of the ONE cascade (LAW 2); it now delegates to lib/kernel/brand-voice.ts loadSenderVoiceBrief
// (resolveBrandVoiceCore — the same base → team → agent reads, tenant-pinned, read for their errors) and renders the
// versioned sender-voice brief. The three read assertions therefore read the SURVIVOR's source (stripped — a tombstone is
// not a read); the pipeline-side assertions (scope object, cache key, call-site threading, inline override, service
// client) are unchanged, and a new one proves the delegation is real and not a comment.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const p = readFileSync(join(process.cwd(), "lib/ai/pipeline.ts"), "utf8")
const pCode = stripComments(p)
const bv = stripComments(readFileSync(join(process.cwd(), "lib/kernel/brand-voice.ts"), "utf8"))

console.log("\n── resolveBrandVoice cascades brokerage → team → agent ──")
check("takes a scope object with brokerageId + teamId + agentId (not brokerageId alone)",
  /resolveBrandVoice\(\s*scope:\s*\{\s*brokerageId[^}]*teamId[^}]*agentId/.test(p))
check("the pipeline DELEGATES to the ONE reader (loadSenderVoiceBrief) and no longer reads brand_voice_profile itself (stripped source)",
  /loadSenderVoiceBrief\(\s*supabase as never,\s*\{\s*brokerageId:\s*scope\.brokerageId,\s*teamId:\s*scope\.teamId/.test(pCode) && !/\.from\(\s*["']brand_voice_profile["']\s*\)/.test(pCode))
check("the SURVIVOR reads the brokerage BASE voice (team_id null, agent_id null), tenant-pinned",
  bv.includes('.eq("brokerage_id", brokerageId)') && bv.includes('.is("team_id", null)') && bv.includes('.is("agent_id", null)'))
check("the SURVIVOR overlays the TEAM voice when a team is present (and labels it as the team overlay)",
  bv.includes('.eq("team_id", teamId)') && /team overlay/.test(bv))
check("the SURVIVOR overlays the AGENT voice when an agent is present (crossed via agents.user_id, labelled the agent overlay)",
  bv.includes('.eq("agent_id", agentId)') && bv.includes('.eq("user_id", actorUserId)') && /agent overlay/.test(bv))
check("the brokerage base is always labeled as the base the content pulls from (the rendered brief's provenance line)",
  /brokerage base/i.test(bv))
check("cache key includes team + agent so scoped voices aren't cross-served",
  /`\$\{scope\.brokerageId\}:\$\{scope\.teamId \?\? ""\}:\$\{scope\.agentId \?\? ""\}`/.test(p))
check("the call site threads metadata.teamId + metadata.agentId into the resolver",
  /resolveBrandVoice\(\s*\{\s*brokerageId:\s*request\.metadata\.brokerageId,\s*teamId:\s*request\.metadata\.teamId,\s*agentId:\s*request\.metadata\.agentId/.test(p))
check("inline override still short-circuits the cascade",
  p.includes("brandVoiceOverride?.inlineBrandVoice"))
check("resolves via the SERVICE client so RLS can't drop the brokerage-base + team tiers (VADE fix)",
  /const supabase = createServiceClient\(\)/.test(p) && p.includes('import { createServiceClient } from "@/lib/supabase/service"'))

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ BRAND_VOICE_CASCADE_FAIL"); process.exit(1) }
console.log(" ✅ BRAND_VOICE_CASCADE_PASS — brokerage base + team + agent, like brand settings")
