#!/usr/bin/env tsx
/**
 * scripts/idle-hands-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * IDLE-HANDS INITIATIVE harness — managers fill silence with governed work.
 *
 * Layer 1 (pure): the idle rule — a manager with open proposals takes NO initiative
 *   (never piles onto a backlog).
 * Layer 2 (live, gated): seed a brokerage moment — a stale active listing with no
 *   social touch, a deal closed last week with no just_sold reel (injected promo
 *   dispatcher = the vendor seam), a contact missing a phone, and a cooling
 *   high-propensity lead — run runIdleHands and assert each manager's move landed
 *   on its OWN rail (social pending approval, reel dispatched policy-ON, enrichment
 *   queued, re-engage PRE-DRAFTED proposed NOT approved), then prove idempotency
 *   (second pass does nothing) and the idle rule live (a busy sphere skips). Self-cleans.
 *
 * Run: npx tsx scripts/idle-hands-simulator.ts  (npm run test:idle-hands)
 */
import { isManagerIdle, seasonalPlayFor, runIdleHands } from "../lib/kernel/idle-hands"
import type { PromoDispatcher } from "../lib/kernel/voice-delegation"

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
  console.log(" ✅ Idle-hands initiative verified — silence filled, backlogs respected")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Idle-hands initiative simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · the idle rule]")
  check("no open proposals → idle (initiative allowed)", isManagerIdle({}, "marketing_agent"))
  check("open proposals → BUSY (no initiative onto a backlog)", !isManagerIdle({ marketing_agent: 2 }, "marketing_agent"))
  check("another manager's backlog doesn't block this one", isManagerIdle({ sphere_of_influence: 5 }, "marketing_agent"))
  check("seasonal plays: every month maps to a season, named by year",
    seasonalPlayFor(3, 2026).name === "Spring Sellers 2026" && seasonalPlayFor(6, 2026).name === "Summer Movers 2026"
    && seasonalPlayFor(8, 2026).name === "Fall Market Reset 2026" && seasonalPlayFor(11, 2026).name === "Year-End Gratitude 2026"
    && seasonalPlayFor(0, 2027).name === "Year-End Gratitude 2027")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live initiative]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Idle${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    // Stale active listing (8 days old, no social touch).
    const { data: lst } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 7 Aspen Way`, city: `${TAG}ville`, status: "active",
      created_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "listings", id: (lst as any).id })
    // Closed deal last week, listing has no just_sold reel.
    const { data: soldLst } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 9 Sold St`, city: `${TAG}ville`, status: "sold",
    }).select("id").single()
    cleanup.push({ table: "listings", id: (soldLst as any).id })
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 9 Sold St`, status: "closed",
      close_date: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
      listing_id: (soldLst as any).id, agent_id: (agent as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })
    // Contact missing a phone (self-healing target) — also the cooling lead.
    const { data: gap } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Gap", last_name: TAG, contact_type: "buyer",
      agent_id: agentUserId, email: `gap.${Date.now()}@example.test`, intent_score: 95, engagement_score: 88,
      last_contacted_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (gap as any).id })

    // Injected promo dispatcher — the vendor seam (no render spend); asserts policy-ON.
    const dispatches: any[] = []
    const promoDispatcher: PromoDispatcher = async (d) => { dispatches.push(d); return { ok: true, status: "remotion_pending" } }

    const r1 = await runIdleHands(brokerageId, { promoDispatcher }, svc)

    // Marketing: social draft pending approval on the existing gate.
    const { data: sp } = await svc.from("social_posts").select("id, approval_status, status, post_brief")
      .eq("listing_id", (lst as any).id).maybeSingle()
    if (sp) cleanup.push({ table: "social_posts", id: (sp as any).id })
    check("Marketing: stale listing got a social DRAFT (pending approval, never published)",
      r1.socialDrafts >= 1 && (sp as any)?.approval_status === "pending" && (sp as any)?.status === "draft")
    check("Marketing: the brief records the initiative", ((sp as any)?.post_brief ?? "").includes("IDLE HANDS"))

    // Asset: just_sold reel dispatched on the canonical rail with policy ON.
    check("Asset: just_sold reel dispatched for the recent closing", r1.justSoldReels >= 1 && dispatches.length >= 1)
    check("Asset: automatic initiative NEVER bypasses policy (bypassPolicy=false)",
      dispatches.every((d) => d.bypassPolicy === false && d.eventType === "just_sold"))

    // Data Steward: enrichment queued for the missing phone.
    const { data: eq } = await svc.from("contact_enrichment_queue").select("id, status, source")
      .eq("contact_id", (gap as any).id).eq("source", "idle_hands").maybeSingle()
    if (eq) cleanup.push({ table: "contact_enrichment_queue", id: (eq as any).id })
    check("Data Steward: self-healing enrichment queued (source=idle_hands)", r1.enrichmentsQueued >= 1 && (eq as any)?.status === "pending")

    // AI ISA: re-engage PRE-DRAFTED — proposed, NOT approved (auto-draft, not auto-send).
    const { data: pd } = await svc.from("agent_client_messages").select("id, status, approved_by, rationale")
      .eq("recipient_contact_id", (gap as any).id).ilike("rationale", "IDLE HANDS%").maybeSingle()
    if (pd) cleanup.push({ table: "agent_client_messages", id: (pd as any).id })
    if (pd) {
      const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (pd as any).id).eq("type", "approval_needed").maybeSingle()
      if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
    }
    check("AI ISA: cooling lead PRE-DRAFTED (proposed, no approver — auto-draft ≠ auto-send)",
      r1.reengagePredrafts >= 1 && (pd as any)?.status === "proposed" && (pd as any)?.approved_by === null)

    // Idempotency: a second pass takes no duplicate initiative... and the idle rule
    // now BLOCKS ai_isa + sphere (their proposals are pending) — silence was filled.
    const r2 = await runIdleHands(brokerageId, { promoDispatcher }, svc)
    check("idempotency + idle rule: second pass drafts nothing new",
      r2.socialDrafts === 0 && r2.justSoldReels === 0 && r2.enrichmentsQueued === 0 && r2.reengagePredrafts === 0)
    check("idle rule live: AI ISA now BUSY (its own pre-draft pends) → skipped",
      r2.skippedBusy.includes("ai_isa"))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("last_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
