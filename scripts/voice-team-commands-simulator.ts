#!/usr/bin/env tsx
/**
 * scripts/voice-team-commands-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AI-TEAM BULLPEN is now available to the spoken voice admin: the read-only team
 * commands (team_query / area_query / morning_standup) are registered in the voice tool-registry
 * with the right authority + zero compliance gates, and a shared dispatcher routes them to the
 * SAME kernel backends the internal voice route uses (no duplicated logic / no drift).
 *
 * Layer 1 (pure, always runs): registry gating invariants (authority + gates) — the
 *   compliance-critical contract the ElevenLabs Conv AI dispatcher enforces.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated): dispatchTeamCommand('team_query') against a
 *   real seeded contact returns a spoken answer. Seed reverse-deleted (cleanup == 0). No mocks.
 *
 * Run: npx tsx scripts/voice-team-commands-simulator.ts   (npm run test:voice-team)
 */
import { voiceTools, gatesFor, authorityAllows } from "../lib/voice/tool-registry"

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
  console.log(" ✅ Voice bullpen verified — the spoken admin can query the AI team, gated correctly.")
  console.log(" VOICE_TEAM_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Voice team-commands simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · registry gating invariants]")
  for (const t of ["team_query", "area_query", "morning_standup"]) {
    check(`${t} is registered as a voice tool`, !!voiceTools[t])
    check(`${t} is read-only (no compliance gates)`, gatesFor(t).length === 0)
    check(`${t} is not outbound / not NAR-regulated`, voiceTools[t]?.is_outbound === false && voiceTools[t]?.is_nar_regulated === false)
  }
  check("team_query / area_query allow agent OR isa", authorityAllows("team_query", "agent") && authorityAllows("team_query", "isa") && authorityAllows("area_query", "isa"))
  check("morning_standup is agent-only (ISA cannot run the agent's standup)", authorityAllows("morning_standup", "agent") === true && authorityAllows("morning_standup", "isa") === false)
  check("unknown tool is denied", authorityAllows("not_a_tool", "agent") === false)

  console.log("\n[Layer 2 · live: dispatcher → kernel backend → spoken answer]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { dispatchTeamCommand, isTeamCommand } = await import("../lib/voice/team-commands")
  const supabase = createServiceClient()

  check("isTeamCommand recognizes the bullpen", isTeamCommand("team_query") && isTeamCommand("morning_standup") && !isTeamCommand("lookup_contact"))

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id, user_id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()

  const { data: contact } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, agent_id: (agent as any).id,
    first_name: "ZZTeam", last_name: `Buyer${stamp}`, email: `zz-team-${stamp}@example.com`,
    contact_type: "buyer", source: "listing_landing_page",
  }).select("id").single()
  const contactId = (contact as any)?.id

  try {
    const r = await dispatchTeamCommand(
      "team_query",
      { person_query: `ZZTeam Buyer${stamp}` },
      { brokerageId, agentUserId: (agent as any).user_id ?? brokerageId },
      supabase,
    )
    check("team_query returns ok with a non-empty spoken answer", r.ok === true && typeof r.spoken === "string" && r.spoken.length > 0, JSON.stringify(r).slice(0, 120))
    check("team_query resolved the seeded contact", (r.data?.contactId ?? null) === contactId)
  } finally {
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
