#!/usr/bin/env tsx
/**
 * scripts/winback-personalization-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves WIN-BACK PERSONALIZATION — a dormant win-back video's ElevenLabs/D-ID script is fed the
 * contact's persona + their last positive moment (the home anniversary) so it reads one-to-one. A
 * past client with an anniversary on file anchors on "N years since you got the keys"; everyone else
 * gets a warm reconnect with NO fabricated milestone; protected-class signals NEVER become facts.
 * Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/winback-personalization-simulator.ts   (npm run test:winback-personalization)
 */
import { winbackPersonalization } from "../lib/intelligence/winback-personalization"

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
  console.log(" ✅ Win-back personalization verified — persona + last positive moment feed the script; FH-safe.")
  console.log(" WINBACK_PERSONALIZATION_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Win-back personalization simulator")
  console.log("══════════════════════════════════════════════════\n")

  const now = "2026-06-16T00:00:00Z"

  // Past client with a home anniversary → anchored on the years-since-keys positive moment.
  const past = winbackPersonalization({ firstName: "Pat", contactType: "past_client", homeAnniversary: "2023-06-01T00:00:00Z", city: "Austin", now })
  check("past client → past_client persona, named", past.persona.audience === "past_client" && past.persona.name === "Pat")
  check("anchors on the home anniversary (last positive moment)", past.hasPositiveMoment && past.facts.some((f) => /3 years since they got the keys/.test(f)), JSON.stringify(past.facts))
  check("surfaces the first name + city as facts", past.facts.some((f) => /First name: Pat/.test(f)) && past.facts.some((f) => /Austin/.test(f)))
  check("always carries the warm reconnect intent", past.facts.some((f) => /genuine check-in/.test(f)))

  // Fresh past client (closed within the year) → the 'this past year' phrasing, not 'N years'.
  const fresh = winbackPersonalization({ firstName: "Dana", contactType: "repeat_client", homeAnniversary: "2026-02-01T00:00:00Z", city: null, now })
  check("anniversary within the year → 'within the past year' (no negative/zero years)", fresh.hasPositiveMoment && fresh.facts.some((f) => /within the past year/.test(f)) && !fresh.facts.some((f) => /-?0 years/.test(f)), JSON.stringify(fresh.facts))

  // Non-past-client, no anniversary → warm reconnect, NO fabricated milestone.
  const lead = winbackPersonalization({ firstName: "Sam", contactType: "buyer_lead", homeAnniversary: null, city: "Denver", now })
  check("no anniversary → no positive-moment claim fabricated", !lead.hasPositiveMoment && !lead.facts.some((f) => /keys|milestone|year/.test(f)), JSON.stringify(lead.facts))
  check("still personalizes name + city + reconnect intent", lead.facts.some((f) => /First name: Sam/.test(f)) && lead.facts.some((f) => /Denver/.test(f)) && lead.facts.some((f) => /check-in/.test(f)))

  // Fair Housing — protected-class signals never appear (we never even take them as input, and the
  // emitted facts carry nothing about age/family/income/marital status).
  const allFacts = [...past.facts, ...fresh.facts, ...lead.facts].join(" ").toLowerCase()
  check("no protected-class language leaks into the facts", !/(family|families|kids|children|age|retire|married|single|income|religio|race|disab)/.test(allFacts), allFacts)

  // Missing name is tolerated (no "First name:" line, persona.name null).
  const anon = winbackPersonalization({ firstName: null, contactType: "past_client", homeAnniversary: null, city: null, now })
  check("missing name → graceful (no empty 'First name:' fact)", anon.persona.name === null && !anon.facts.some((f) => /^First name:/.test(f)) && anon.facts.length >= 1)

  report()
}

main()
