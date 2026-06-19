#!/usr/bin/env tsx
/**
 * scripts/command-bar-simulator.ts  (npm run test:command-bar) — no DB, no AI, no mocks.
 *
 * Proves the deterministic NL→team-command parser (lib/voice/parse-team-command.ts) — the floor
 * under the Command Center "command your team" bar and the voice fallback. Every case maps typed
 * text to the SAME { name, params } that dispatchTeamCommand already routes; ambiguous text must
 * return null (acting verbs never fire on a guess). Also asserts every parsed name is a real
 * TEAM_COMMAND, so the parser can't emit a command the dispatcher won't accept (no drift).
 */
import { parseTeamCommandText } from "../lib/voice/parse-team-command"
import { TEAM_COMMANDS } from "../lib/voice/team-command-names"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

type Case = { text: string; name: string | null; check?: (p: Record<string, unknown>) => boolean }
const CASES: Case[] = [
  // morning standup
  { text: "What should I do today?", name: "morning_standup" },
  { text: "what's on my plate", name: "morning_standup" },
  { text: "give me the standup", name: "morning_standup" },
  // standup action (acting verb + ordinal)
  { text: "knock out number two", name: "standup_action", check: (p) => p.ordinal === 2 },
  { text: "handle item 1", name: "standup_action", check: (p) => p.ordinal === 1 },
  { text: "do the third one", name: "standup_action", check: (p) => p.ordinal === 3 },
  // team query (about a person)
  { text: "what do you know about the Hendersons", name: "team_query", check: (p) => p.person_query === "Hendersons" },
  { text: "where do we stand on Jane Rivera", name: "team_query", check: (p) => p.person_query === "Jane Rivera" },
  { text: "catch me up on the Smith deal", name: "team_query", check: (p) => /Smith/.test(String(p.person_query)) },
  // area query (about a place)
  { text: "anything happening near 44 Birch?", name: "area_query", check: (p) => p.area_query === "44 Birch" },
  { text: "what's going on around downtown Austin", name: "area_query", check: (p) => /downtown Austin/i.test(String(p.area_query)) },
  // voice follow-up (acting; consent re-checked downstream)
  { text: "send the Hendersons a follow-up", name: "voice_followup", check: (p) => p.person_query === "Hendersons" },
  { text: "follow up with Jane saying I'll call her tomorrow", name: "voice_followup", check: (p) => p.person_query === "Jane" && /call her tomorrow/i.test(String(p.dictation)) },
  // start marketing (acting)
  { text: "start marketing for the Hendersons", name: "start_marketing", check: (p) => p.person_query === "Hendersons" },
  // cut promo (Remotion + D-ID rail; Fair Housing pre-flight downstream)
  { text: "cut a reel for 44 Birch", name: "cut_promo", check: (p) => p.address_query === "44 Birch" },
  { text: "make a promo video of 12 Oak Street", name: "cut_promo", check: (p) => /12 Oak Street/i.test(String(p.address_query)) },
  // find properties (buyer search)
  { text: "find the Hendersons a 3-bed under 500k in Austin", name: "find_properties", check: (p) => p.person_query === "Hendersons" && /3-bed/.test(String(p.query)) },
  // ambiguous / chit-chat → null (never mis-route, especially acting verbs)
  { text: "hello", name: null },
  { text: "thanks team", name: null },
  { text: "what's the weather", name: null },
  { text: "do it", name: null }, // acting verb but no ordinal → must NOT become standup_action
]

console.log("\n[NL → team-command parser]")
for (const c of CASES) {
  const r = parseTeamCommandText(c.text)
  const gotName = r?.name ?? null
  const nameOk = gotName === c.name
  const paramsOk = c.name === null ? true : (r != null && (!c.check || c.check(r.params)))
  const realCmd = r == null || TEAM_COMMANDS.has(r.name)
  check(`"${c.text}" → ${c.name ?? "null"}`, nameOk && paramsOk && realCmd,
    !nameOk ? `got ${gotName}` : !paramsOk ? `params mismatch: ${JSON.stringify(r?.params)}` : !realCmd ? `not a real TEAM_COMMAND: ${r?.name}` : undefined)
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ COMMAND_BAR_PARSER_PASS — text and voice share one dispatch; ambiguous input never mis-routes")
