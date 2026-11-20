#!/usr/bin/env tsx
/**
 * scripts/twin-studio-setup-simulator.ts   (npm run test:twin-studio-setup)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AI AVATAR + VOICE SETUP IS DISCOVERABLE. Twin Studio (D-ID avatar +
 * ElevenLabs voice clone) was only reachable from the Video-tools nav + a few
 * fallback prompts. The owner wants it on the MAIN SETTINGS and part of
 * ONBOARDING, with a fallback link when not set up. Proves: (1) a derived
 * critical-setup onboarding item detects avatar+voice from the real signals;
 * (2) the settings hub surfaces it; (3) the pure checker behaves.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CRITICAL_SETUP_ITEMS } from "../lib/onboarding/critical-setup"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── onboarding: a derived avatar+voice setup item (no staleable step) ──")
{
  const item = CRITICAL_SETUP_ITEMS.find((i) => i.key === "agent_twin")
  check("an 'agent_twin' critical-setup item exists for the agent", !!item && item.role === "agent")
  check("it links to Twin Studio as the fallback setup surface", item?.settingHref === "/dashboard/settings/twin-studio")
  // The checker is pure over the facts — exhaust it.
  check("checker true only when the twin is configured",
    item?.checker({ agent: { twinConfigured: true } as any } as any) === true &&
    item?.checker({ agent: { twinConfigured: false } as any } as any) === false &&
    item?.checker({} as any) === false)

  const cs = src("lib/onboarding/critical-setup.ts")
  check("twinConfigured is a fact on the agent slice", /twinConfigured:\s*boolean/.test(cs))
  check("it's derived from the REAL signals (agent_voice_profiles + agents.voice_id/avatar_id)",
    cs.includes("agent_voice_profiles") && /elevenlabs_voice_id/.test(cs) && /did_avatar_id/.test(cs) &&
    /a\.voice_id/.test(cs) && /a\.avatar_id/.test(cs))
  check("both a voice AND an avatar are required to count as set up",
    /const hasVoice[\s\S]*?const hasAvatar[\s\S]*?return hasVoice && hasAvatar/.test(cs))
}

console.log("\n── main settings surfaces the avatar+voice setup ──")
{
  const sidebar = src("app/components/settings/SettingsSidebar.tsx")
  check("the settings sidebar has an 'AI Avatar & Voice' entry → twin-studio",
    sidebar.includes("AI Avatar & Voice") && sidebar.includes("/dashboard/settings/twin-studio"))
  const page = src("app/settings/page.tsx")
  check("the settings hub has an 'AI Avatar & Voice' card → twin-studio",
    page.includes("AI Avatar & Voice") && page.includes("/dashboard/settings/twin-studio"))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ TWIN_STUDIO_SETUP_FAIL"); process.exit(1) }
console.log(" ✅ TWIN_STUDIO_SETUP_PASS — avatar+voice setup is on Settings + onboarding, detected from real signals")
