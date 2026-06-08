#!/usr/bin/env tsx
/**
 * scripts/section-narration-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — verifies the per-section narration the agent's avatar/voice clone
 * speaks: every section sells the brokerage/agent/team's marketing system, is
 * personalized (agent + area), and is SELLER-SAFE — never states the home's
 * value or any suggested price. Pure — runs fully in CI.
 *
 * Run:  npx tsx scripts/section-narration-simulator.ts   (npm run test:section-narration)
 */
import { buildSectionNarrationScript, NARRATABLE_SECTION_KEYS } from "../lib/listing-presentation/section-narration"
import { findSuggestedPriceLeaks } from "../lib/cma/customer-facing-guard"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const BASE = { brokerageName: "Summit Realty", agentName: "Jane Doe", areaName: "Brickell" }

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Section narration simulator (avatar/voice script)")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[every narratable section]")
  for (const key of NARRATABLE_SECTION_KEYS) {
    const n = buildSectionNarrationScript({ sectionKey: key, ...BASE })
    check(`${key}: has a script + on-screen bullets`, n.script.length > 20 && n.bullets.length > 0)
    check(`${key}: SELLER-SAFE — zero suggested-price leaks`, findSuggestedPriceLeaks({ script: n.script, bullets: n.bullets }).length === 0)
    check(`${key}: contains NO dollar figure (no price to the seller)`, !/\$\s?\d/.test(n.script) && !n.bullets.some((b) => /\$\s?\d/.test(b)))
  }

  console.log("\n[personalization + 'why us' positioning]")
  const intro = buildSectionNarrationScript({ sectionKey: "intro", ...BASE })
  check("intro names the agent + brokerage", intro.script.includes("Jane Doe") && intro.script.includes("Summit Realty"))
  check("intro names the area", intro.script.includes("Brickell"))
  check("intro sells a marketing system no other local agent runs", /no other agent/i.test(intro.script) && /marketing system/i.test(intro.script))

  const marketing = buildSectionNarrationScript({ sectionKey: "marketing", ...BASE })
  check("marketing pitches video + data + reach", /video/i.test(marketing.script) && /(data|reach)/i.test(marketing.script))

  const closing = buildSectionNarrationScript({ sectionKey: "closing", ...BASE })
  check("closing defers the home's value to the meeting", /(meet|person|sit down|our meeting)/i.test(closing.script))

  const cma = buildSectionNarrationScript({ sectionKey: "cma", ...BASE })
  check("CMA narration shows market context but defers the number", /(comparable|market)/i.test(cma.script) && /(meeting|together|in person)/i.test(cma.script))

  console.log("\n[team + fallbacks]")
  const team = buildSectionNarrationScript({ sectionKey: "credibility", ...BASE, teamName: "The Doe Group" })
  check("team name woven in when present", team.script.includes("The Doe Group"))
  const unknown = buildSectionNarrationScript({ sectionKey: "totally_new_kind", ...BASE })
  check("unknown section still yields a safe script", unknown.script.length > 10 && findSuggestedPriceLeaks(unknown).length === 0)
  const noArea = buildSectionNarrationScript({ sectionKey: "intro", brokerageName: "X", agentName: "Y" })
  check("missing area falls back gracefully (no 'undefined')", !/undefined|null/.test(noArea.script))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Narration verified — sells the system, seller-safe, never a price")
}
main()
