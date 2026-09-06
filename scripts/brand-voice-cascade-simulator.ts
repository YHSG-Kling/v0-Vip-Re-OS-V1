// scripts/brand-voice-cascade-simulator.ts   (npm run test:brand-voice-cascade)
// ─────────────────────────────────────────────────────────────────────────────
// BRAND VOICE CASCADE — proves the AI pipeline resolves brand VOICE the same way
// resolveBrandContext resolves brand SETTINGS: the brokerage voice is ALWAYS the
// base (content pulls from the tenant of record), then the TEAM and AGENT voices
// overlay. The bug: resolveBrandVoice read only brokerages.brand_voice_profile, so
// a team's/agent's own voice never applied. brand_voice_profile is scoped by
// brokerage_id / team_id / agent_id (scripts 524 + 1049).

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const p = readFileSync(join(process.cwd(), "lib/ai/pipeline.ts"), "utf8")

console.log("\n── resolveBrandVoice cascades brokerage → team → agent ──")
check("takes a scope object with brokerageId + teamId + agentId (not brokerageId alone)",
  /resolveBrandVoice\(\s*scope:\s*\{\s*brokerageId[^}]*teamId[^}]*agentId/.test(p))
check("reads the brokerage BASE voice (team_id null, agent_id null)",
  p.includes('.eq("brokerage_id", scope.brokerageId)') && p.includes('.is("team_id", null)') && p.includes('.is("agent_id", null)'))
check("overlays the TEAM voice when a team is present",
  p.includes('.eq("team_id", scope.teamId)') && p.includes("TEAM VOICE OVERLAY"))
check("overlays the AGENT voice when an agent is present",
  p.includes('.eq("agent_id", scope.agentId)') && p.includes("AGENT VOICE OVERLAY"))
check("the brokerage base is always labeled as the base the content pulls from",
  /brokerage base/i.test(p))
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
