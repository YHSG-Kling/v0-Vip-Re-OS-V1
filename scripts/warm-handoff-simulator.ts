#!/usr/bin/env tsx
/**
 * scripts/warm-handoff-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE WARM HANDOFF — when a portal conversation needs a human, the agent is pulled in WITH
 * the full brief (transcript + context spine + 11-manager team brief + ISA background), so the
 * client never repeats themselves and the agent isn't blind.
 *
 * Layer 1 (pure): the suggested-focus derivation + brief assembly (no fabrication).
 * Layer 2 (live, gated): seeds a contact + portal chat + spine, runs runWarmHandoff, and asserts
 *   the brief (with the transcript) is persisted to the contact and the agent gets a notification.
 *   Seeds reverse-deleted. No mocks.
 *
 * Run: npx tsx scripts/warm-handoff-simulator.ts   (npm run test:warm-handoff)
 */
import { composeHandoffBrief, deriveSuggestedFocus, type HandoffParts } from "../lib/kernel/warm-handoff"

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
  console.log(" ✅ Warm handoff verified — the human walks in with the full picture, nothing repeated.")
  console.log(" WARM_HANDOFF_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Warm-handoff simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · suggested focus + brief assembly]")
  check("'I want to cancel' → retention focus", /retention/i.test(deriveSuggestedFocus("I want to cancel", null, null)))
  check("'I'll sue' → legal-sensitive focus", /legal/i.test(deriveSuggestedFocus("I'll sue you", null, null)))
  check("'I'm scared' → emotional focus", /empathy|emotional/i.test(deriveSuggestedFocus("I'm scared", null, null)))
  check("open commitment is picked up when nothing urgent", /open commitment/i.test(deriveSuggestedFocus("hi", "neutral", "send the disclosures")))
  check("negative sentiment (no trigger) → cooling focus", /cooling/i.test(deriveSuggestedFocus(null, "negative", null)))
  check("benign → default 'answer + confirm next step'", /next step/i.test(deriveSuggestedFocus("thanks!", "positive", null)))

  const parts: HandoffParts = {
    contactName: "Jordan Lee", triggerMessage: "I want to back out of the deal",
    spineSummary: "Wants a 3-bed under $600k; nervous about rates.", preferences: ["3-bed", "under $600k"],
    openNextStep: "review the inspection report", sentiment: "negative",
    teamLines: [{ manager: "ai_isa", line: "high propensity, last call positive" }, { manager: "deal_coordinator", line: "appraisal due Friday" }],
    transcript: Array.from({ length: 15 }, (_, i) => ({ who: i % 2 ? "assistant" : "user", text: `msg ${i}` })),
    isaBackground: "Relocating for work, 60-day timeline.",
  }
  const brief = composeHandoffBrief(parts)
  check("brief headline names the client", brief.headline.includes("Jordan Lee"))
  check("brief carries what the client just said", brief.clientSays === "I want to back out of the deal")
  check("brief focus is retention (they're backing out)", /retention/i.test(brief.suggestedFocus))
  check("brief carries the team's knowledge (no re-asking)", brief.teamKnows.length === 2)
  check("transcript is trimmed to the recent tail (≤12)", brief.recentTranscript.length === 12)
  check("ISA background + preferences conserved", brief.isaBackground === "Relocating for work, 60-day timeline." && brief.whatTheyWant.length === 2)
  const empty = composeHandoffBrief({ contactName: null, triggerMessage: null, spineSummary: null, preferences: [], openNextStep: null, sentiment: null, teamLines: [], transcript: [], isaBackground: null })
  check("no fabrication — empty parts stay empty", empty.clientSays === null && empty.teamKnows.length === 0 && empty.isaBackground === null)

  console.log("\n[Layer 2 · live: brief persisted + agent notified]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runWarmHandoff } = await import("../lib/kernel/warm-handoff-runner")
  const supabase = createServiceClient()

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id, user_id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()

  const { data: contact } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, agent_id: (agent as any).id, first_name: "ZZWarm", last_name: `Handoff${stamp}`,
    email: `zz-warm-${stamp}@example.com`, contact_type: "buyer", source: "test",
    metadata: { context_spine: { summary: "Nervous first-time buyer.", preferences: ["2-bed"], sentiment: "negative", openNextStep: "review disclosures" } },
  }).select("id").single()
  const contactId = (contact as any)?.id

  let sessionId: string | null = null
  try {
    const { data: session } = await supabase.from("chat_sessions").insert({
      contact_id: contactId, brokerage_id: brokerageId, source: "portal", status: "active",
    }).select("id").single().then(r => r, () => ({ data: null }))
    sessionId = (session as any)?.id ?? null
    if (sessionId) {
      await supabase.from("chat_messages").insert([
        { session_id: sessionId, role: "user", content: "I'm worried about the rate." },
        { session_id: sessionId, role: "assistant", content: "I hear you — let's look at options." },
      ]).then(() => {}, () => {})
    }

    const r = await runWarmHandoff(contactId, { triggerMessage: "I want to back out" }, supabase)
    check("runWarmHandoff succeeded", r.ok === true, r.reason)

    const { data: after } = await supabase.from("contacts").select("metadata").eq("id", contactId).single()
    const wh = (after as any)?.metadata?.warm_handoff
    check("brief persisted on the contact", !!wh && typeof wh.headline === "string")
    check("brief focus reflects the back-out trigger (retention)", /retention/i.test(wh?.suggestedFocus ?? ""))
    if (sessionId) check("the client's words are captured (no repeating)", (wh?.recentTranscript?.length ?? 0) >= 2, `len=${wh?.recentTranscript?.length}`)

    const { count: notifs } = await supabase.from("notifications").select("id", { count: "exact", head: true })
      .eq("entity_id", contactId).eq("type", "warm_handoff")
    check("agent got a warm_handoff notification", (notifs ?? 0) >= 1)
  } finally {
    await supabase.from("notifications").delete().eq("entity_id", contactId).eq("type", "warm_handoff").then(() => {}, () => {})
    if (sessionId) {
      await supabase.from("chat_messages").delete().eq("session_id", sessionId).then(() => {}, () => {})
      await supabase.from("chat_sessions").delete().eq("id", sessionId).then(() => {}, () => {})
    }
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
