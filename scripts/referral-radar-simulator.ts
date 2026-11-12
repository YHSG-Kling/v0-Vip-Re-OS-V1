#!/usr/bin/env tsx
/**
 * scripts/referral-radar-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SPHERE REFERRAL RADAR harness — the Data Steward derives a life-event signal on a
 * PAST client; the Sphere Manager surfaces BOTH a nudge AND a drafted touchpoint.
 *
 * Layer 1 (pure): isPastClient / isWithdrawn gating; detectLifeEvent from contact fields
 *   (fresh life_events jsonb → typed event; equity milestone; referral-primed; no signal
 *   → null, no fabrication); composeReferralTouch (fallback) + composeReferralNudge frame
 *   BOTH outputs.
 * Layer 2 (live, gated): seed a past-client contact carrying a fresh life-event signal,
 *   run runReferralRadar with an injected scraper + copyGenerator (NO real spend), assert
 *   BOTH a nudge notification AND a gated touchpoint exist; a WITHDRAWN past client gets
 *   NEITHER; second pass is idempotent (no new touch). Self-cleans by a unique TAG.
 *
 * Run: npx tsx scripts/referral-radar-simulator.ts  (npm run test:referral-radar)
 */
import {
  isPastClient, isWithdrawn, detectLifeEvent, composeReferralTouch, composeReferralNudge,
  runReferralRadar, type RadarContact, type LifeEventScraper,
} from "../lib/kernel/referral-radar"
import type { CopyGenerator } from "../lib/kernel/ai-copy"

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
  console.log(" ✅ Referral Radar verified — life event → BOTH a nudge AND a gated touchpoint")
}

const now = new Date("2026-06-11T12:00:00Z")
const fresh = new Date(now.getTime() - 5 * 86_400_000).toISOString()
const stale = new Date(now.getTime() - 200 * 86_400_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Referral Radar simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · gating + detection + both-outputs framing]")
  check("isPastClient: canonical lifetime_customer → true", isPastClient({ contact_type: "lifetime_customer", nurture_status: null }))
  check("isPastClient: the RETIRED spelling past_client still reads true (readers stay tolerant)",
    isPastClient({ contact_type: "past_client", nurture_status: null }))
  check("isPastClient: nurture_status closed → true", isPastClient({ contact_type: "buyer", nurture_status: "closed" }))
  check("isPastClient: plain lead → false", !isPastClient({ contact_type: "lead", nurture_status: null }))
  check("isWithdrawn: nurture_status withdrawn → true", isWithdrawn({ nurture_status: "withdrawn" }))

  const baby: RadarContact = { id: "x", first_name: "Jane", contact_type: "lifetime_customer", last_life_event_detected: fresh, life_events: [{ type: "new_baby" }] }
  const evBaby = detectLifeEvent(baby, now)
  check("detect: fresh new_baby signal → new_baby event with angle + client hook",
    evBaby?.type === "new_baby" && !!evBaby?.angle && evBaby!.clientHook.toLowerCase().includes("family"))

  const staleBaby: RadarContact = { id: "x", first_name: "Jane", contact_type: "lifetime_customer", last_life_event_detected: stale, life_events: [{ type: "new_baby" }] }
  check("detect: a STALE life-event stamp does NOT fire the scraped event (no old news)",
    detectLifeEvent(staleBaby, now)?.type !== "new_baby")

  const equity: RadarContact = { id: "x", first_name: "Sam", contact_type: "lifetime_customer", equity_estimate: 320_000 }
  check("detect: equity ≥ milestone → equity_milestone (a real derived number)", detectLifeEvent(equity, now)?.type === "equity_milestone")

  const primed: RadarContact = { id: "x", first_name: "Lee", contact_type: "sphere", referral_score: 88 }
  check("detect: high referral_score → referral_primed", detectLifeEvent(primed, now)?.type === "referral_primed")

  const nothing: RadarContact = { id: "x", first_name: "Pat", contact_type: "lifetime_customer", equity_estimate: 1000, referral_score: 5 }
  check("detect: NO real signal → null (never fabricates an event)", detectLifeEvent(nothing, now) === null)

  const touch = composeReferralTouch("Jane", evBaby!)
  check("touchpoint fallback: warm, names the client, no-pressure referral opener",
    touch.body.includes("Jane") && /refer|friend|family/i.test(touch.body) && /no agenda|no pressure|call away/i.test(touch.body))
  const nudge = composeReferralNudge("Jane Doe", evBaby!)
  check("nudge: tells the agent WHO + WHY + that a draft awaits approval",
    nudge.title.includes("Jane Doe") && /approval queue|waiting/i.test(nudge.body) && nudge.body.includes(evBaby!.label))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live radar]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Radar${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentRowId = (agent as any).id

    // A PAST client carrying a fresh life-event signal (new baby). agent_id FK → agents.id,
    // so resolveResponsibleAgentUserId can reach the agent's users.id for the nudge.
    const { data: pc } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}`, last_name: "PastClient",
      contact_type: "lifetime_customer", agent_id: agentRowId,
      last_life_event_detected: fresh, life_events: [{ type: "new_baby" }],
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (pc as any).id })

    // A WITHDRAWN past client with the SAME fresh signal — must get NEITHER output.
    const { data: wc } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}W`, last_name: "Withdrawn",
      contact_type: "lifetime_customer", nurture_status: "withdrawn", agent_id: agentRowId,
      last_life_event_detected: fresh, life_events: [{ type: "new_baby" }],
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (wc as any).id })

    // Injected seams — no real scraper spend, no token spend.
    const fakeScraper: LifeEventScraper = async () => ({ types: [], detectedAt: fresh })
    const fakeCopy: CopyGenerator = async (reqCopy) =>
      ({ subject: "Congrats from your agent", body: `Persona note for ${reqCopy.persona.name ?? "you"}: thinking of you and happy to help you or anyone you refer.` })

    const r1 = await runReferralRadar(brokerageId, { now, scraper: fakeScraper, copyGenerator: fakeCopy }, svc)
    check("radar: detected ≥1, produced BOTH a nudge AND a touchpoint, skipped the withdrawn",
      r1.detected >= 1 && r1.nudges >= 1 && r1.touchpoints >= 1 && r1.skippedWithdrawn >= 1)

    // BOTH outputs for the past client — (b) the gated touchpoint.
    const { data: tp } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, rationale, body")
      .eq("recipient_contact_id", (pc as any).id).ilike("rationale", "SPHERE RADAR%").maybeSingle()
    if (tp) cleanup.push({ table: "agent_client_messages", id: (tp as any).id })
    check("TOUCHPOINT: proposed into the gate (sphere_of_influence, status 'proposed', persona copy)",
      (tp as any)?.status === "proposed" && (tp as any)?.agent_kind === "sphere_of_influence" && ((tp as any)?.body ?? "").length > 0)

    // (a) the nudge notification to the responsible agent.
    const { data: nudgeRow } = await svc.from("notifications").select("id, type, title, body, contact_id")
      .eq("contact_id", (pc as any).id).eq("type", "referral_radar").maybeSingle()
    if (nudgeRow) cleanup.push({ table: "notifications", id: (nudgeRow as any).id })
    check("NUDGE: notification to the responsible agent (type 'referral_radar', who + why)",
      !!nudgeRow && /Reach out/i.test((nudgeRow as any).title) && /approval queue|waiting/i.test((nudgeRow as any).body))

    // The proposeClientMessage real-time alert also writes an approval_needed notif — clean it.
    if (tp) {
      const { data: rt } = await svc.from("notifications").select("id").eq("entity_id", (tp as any).id).eq("type", "approval_needed").limit(3)
      for (const n of (rt ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }

    // WITHDRAWN gets NEITHER.
    const { data: wTp } = await svc.from("agent_client_messages").select("id")
      .eq("recipient_contact_id", (wc as any).id).ilike("rationale", "SPHERE RADAR%").maybeSingle()
    const { data: wNudge } = await svc.from("notifications").select("id")
      .eq("contact_id", (wc as any).id).eq("type", "referral_radar").maybeSingle()
    check("WITHDRAWN past client: NO touchpoint AND NO nudge (excluded entirely)", !wTp && !wNudge)

    // Idempotency — second pass produces no new touch for the same (contact, event).
    const r2 = await runReferralRadar(brokerageId, { now, scraper: fakeScraper, copyGenerator: fakeCopy }, svc)
    check("idempotency: second pass adds no new touchpoint or nudge for the same event",
      r2.skippedDuplicate >= 1 && r2.touchpoints === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
