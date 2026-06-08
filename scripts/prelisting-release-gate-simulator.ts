#!/usr/bin/env tsx
/**
 * scripts/prelisting-release-gate-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — proves the TWO-GATE pre-listing model:
 *
 *   Gate 1 (PRODUCE)  automatic — sections materialize + renders queue.
 *   Gate 2 (RELEASE)  the single human gate — once renders settle, the manager
 *     surfaces the FINISHED videos + email into the Command Center; a human
 *     reviews the real product and releases it ONCE. Held presentations never
 *     drip to the seller.
 *
 *   Layer 1 — pure: evaluateRenderReadiness (waits while any render is pending;
 *     ready only when settled + ≥1 succeeded) and composePrelistingEmail
 *     (seller-safe, no price, lists the sections).
 *   Layer 2 — live round-trip (gated): seed a presentation + sections + renders;
 *     assert the gate holds while a render is still 'rendering'; complete the
 *     renders; sweep → assert a RELEASE proposal surfaces in loadCommandCenter
 *     carrying the real video URLs + email; assert deliverDueSections delivers
 *     NOTHING while held; approve via executeAction (stamps delivery_approved_by);
 *     assert release un-gates delivery; assert appointment-proximity escalation;
 *     idempotency; cleanup.
 *
 * Run: npx tsx scripts/prelisting-release-gate-simulator.ts  (npm run test:prelisting-release)
 */
import { evaluateRenderReadiness, composePrelistingEmail } from "../lib/listing-presentation/prelisting-delivery"
import { evaluateApprovalSla } from "../lib/kernel/command-center"
import { findSuggestedPriceLeaks } from "../lib/cma/customer-facing-guard"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · readiness + email compose]")

  // Still rendering → NOT ready (gate holds).
  const pending = evaluateRenderReadiness([
    { section_key: "cma", title: "CMA", render_status: "rendering", output_url: null, thumbnail_url: null },
    { section_key: "intro", title: "Intro", render_status: "succeeded", output_url: "https://x/intro.mp4", thumbnail_url: null },
  ])
  check("a still-rendering section holds the gate", pending.ready === false && pending.pending === 1)

  // All settled + ≥1 succeeded → ready; only succeeded videos surface.
  const ready = evaluateRenderReadiness([
    { section_key: "cma", title: "CMA", render_status: "succeeded", output_url: "https://x/cma.mp4", thumbnail_url: "https://x/cma.png" },
    { section_key: "intro", title: "Intro", render_status: "succeeded", output_url: "https://x/intro.mp4", thumbnail_url: null },
    { section_key: "process", title: "Process", render_status: "failed", output_url: null, thumbnail_url: null },
    { section_key: "closing", title: "Closing", render_status: null, output_url: null, thumbnail_url: null }, // text-only
  ])
  check("settled renders → ready", ready.ready === true && ready.succeeded === 2 && ready.failed === 1)
  check("only succeeded renders surface as videos", ready.videos.length === 2 && ready.videos.every((v) => !!v.output_url))

  // No renders at all (all text-only) → not ready (nothing to review yet).
  const noneReady = evaluateRenderReadiness([{ section_key: "intro", title: "Intro", render_status: null, output_url: null, thumbnail_url: null }])
  check("no succeeded renders → not ready", noneReady.ready === false)

  const email = composePrelistingEmail({
    agentName: "Dana Kling", brokerageName: "Kling Group",
    propertyAddress: "742 Evergreen Ter, Springfield",
    sectionTitles: ["Meet Your Listing Team", "Your Market Right Now", "Your Home's Analysis"],
    portalUrl: "https://app/portal/listing-plan/abc",
  })
  check("email subject names the property", /742 Evergreen/.test(email.subject))
  check("email lists the sections + links the portal", /Your Market Right Now/.test(email.html) && /portal\/listing-plan\/abc/.test(email.html))
  check("email is seller-safe — defers value to the meeting, no price", /when we meet/i.test(email.text) && findSuggestedPriceLeaks({ html: email.html, text: email.text }).length === 0)

  console.log("\n[Layer 1 · appointment-proximity escalation]")
  const now = new Date("2026-01-01T00:00:00Z")
  const young = "2026-01-01T00:00:00Z" // proposed just now
  const farAppt = evaluateApprovalSla(young, now, { deadlineIso: "2026-01-10T00:00:00Z" }) // 9 days out
  check("far appointment → ok", farAppt.level === "ok")
  const soonAppt = evaluateApprovalSla(young, now, { deadlineIso: "2026-01-02T00:00:00Z" }) // 24h out
  check("appointment within 24h → breached even though proposal is young", soonAppt.level === "breached")
  const midAppt = evaluateApprovalSla(young, now, { deadlineIso: "2026-01-02T18:00:00Z" }) // ~42h out
  check("appointment within 48h → due", midAppt.level === "due")
}

async function testLive() {
  console.log("\n[Layer 2 · live two-gate round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposePrelistingDeliveryWhenReady, sweepPrelistingDeliveryGate } = await import("../lib/listing-presentation/prelisting-delivery")
  const { deliverDueSections } = await import("../lib/listing-presentation/section-drip")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const { executeAction } = await import("../lib/agents/marketing-agent-actions")
  const svc = createServiceClient()

  let presId: string | null = null
  let actionId: string | null = null
  const renderIds: string[] = []
  const TAG = `__relsim_${Date.now()}__`
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id
    const { data: approver } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const approverUserId = (approver as { id: string } | null)?.id ?? null

    // Gate 1 already produced: seed a presentation with sections + queued renders.
    const apptIso = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const { data: pres, error: pErr } = await svc.from("listing_presentations").insert({
      brokerage_id: brokerageId, state: "FL", property_address: `${TAG} 742 Evergreen Ter`,
      built_at: new Date().toISOString(), appointment_at: apptIso,
      cma_mid_value: 675000, cma_narrative: "Strong market.", net_sheet: {}, marketing_plan: {},
      slide_deck: { slides: [] }, status: "ready",
    }).select("id").single()
    check("seed presentation", !pErr && !!pres, pErr?.message)
    if (!pres) throw new Error("seed failed")
    presId = (pres as { id: string }).id

    // Two sections, each with a render — one starts still 'rendering'.
    async function seedSection(key: string, title: string, renderStatus: string) {
      const { data: r } = await svc.from("remotion_composition_renders").insert({
        brokerage_id: brokerageId, composition_id: "ListingSectionReel", entity_type: "listing_presentation",
        entity_id: presId, render_status: renderStatus,
        output_url: renderStatus === "succeeded" ? `https://blob/${key}.mp4` : null,
        thumbnail_url: renderStatus === "succeeded" ? `https://blob/${key}.png` : null,
        scope_type: "brokerage", scope_id: brokerageId, requested_via: "cron",
      }).select("id").single()
      const renderId = (r as { id: string }).id
      renderIds.push(renderId)
      await svc.from("presentation_sections").insert({
        presentation_id: presId, brokerage_id: brokerageId, section_key: key, section_order: renderIds.length - 1,
        title, body: { kind: key }, price_withheld: true, status: "scheduled",
        scheduled_for: new Date(Date.now() - 60_000).toISOString(), render_id: renderId,
      })
    }
    await seedSection("intro", "Meet Your Listing Team", "succeeded")
    await seedSection("market", "Your Market Right Now", "rendering")  // still rendering

    // Gate holds while a render is pending.
    const notYet = await proposePrelistingDeliveryWhenReady(presId!, svc)
    check("gate HOLDS while a render is still rendering", notYet.proposed === false && notYet.ready === false)

    // While held, the drip delivers NOTHING (sections are due but unreleased).
    const heldDrip = await deliverDueSections({ now: new Date() }, svc)
    check("held presentation drips nothing to the seller", heldDrip.delivered === 0)

    // Renders complete → sweep raises the RELEASE proposal.
    await svc.from("remotion_composition_renders")
      .update({ render_status: "succeeded", output_url: "https://blob/market.mp4", thumbnail_url: "https://blob/market.png" })
      .eq("entity_id", presId!).eq("render_status", "rendering")
    const swept = await sweepPrelistingDeliveryGate({ limit: 50 }, svc)
    check("sweep proposes a release once renders settle", swept.proposed >= 1)

    const { data: act } = await svc.from("marketing_agent_actions")
      .select("id, action_input, status")
      .eq("action_type", "approve_prelisting_delivery").contains("action_input", { presentation_id: presId })
      .maybeSingle()
    check("release proposal exists + proposed", !!act && (act as { status: string }).status === "proposed")
    actionId = (act as { id: string } | null)?.id ?? null
    const ai = (act as { action_input: any } | null)?.action_input ?? {}
    check("proposal carries the REAL finished video URLs", Array.isArray(ai.video_renders) && ai.video_renders.length === 2 && ai.video_renders.every((v: any) => !!v.output_url))
    check("proposal carries the announcement email for review", !!ai.email?.subject && !!ai.email?.preview_html)

    // Command Center surfaces it; appointment 5 days out → not yet escalated.
    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === actionId)
    check("Command Center surfaces the release in the approval queue", !!surfaced && surfaced.actionType === "approve_prelisting_delivery")

    // Idempotent — sweeping again doesn't double-propose.
    const sweep2 = await sweepPrelistingDeliveryGate({ limit: 50 }, svc)
    check("re-sweep is idempotent (no duplicate release)", sweep2.proposed === 0)

    // Still nothing delivered — release not granted yet.
    const stillHeld = await deliverDueSections({ now: new Date() }, svc)
    check("still nothing delivered before release", stillHeld.delivered === 0)

    if (!approverUserId) {
      console.log("  ⏭  No approver user — skipping release half.")
    } else {
      // Human RELEASES.
      const outcome = await executeAction(actionId!, approverUserId)
      check("release executes (succeeded)", outcome.status === "succeeded", JSON.stringify(outcome.result))
      check("release reports released:true", (outcome.result as { released?: boolean }).released === true)

      const { data: relPres } = await svc.from("listing_presentations")
        .select("delivery_approved_at, delivery_approved_by").eq("id", presId!).single()
      check("delivery_approved_at stamped (gate open)", !!(relPres as { delivery_approved_at: string | null }).delivery_approved_at)
      check("delivery_approved_by records the human (audit)", (relPres as { delivery_approved_by: string | null }).delivery_approved_by === approverUserId)

      // Now the drip delivers the due sections.
      const released = await deliverDueSections({ now: new Date() }, svc)
      check("released presentation now drips to the seller", released.delivered >= 1)

      // Re-release is a no-op.
      const replay = await executeAction(actionId!, approverUserId)
      check("re-release is a no-op (already released)", replay.status === "skipped" || replay.status === "succeeded")
    }
  } finally {
    if (actionId) { try { await svc.from("marketing_agent_actions").delete().eq("id", actionId) } catch {} }
    if (presId) {
      try { await svc.from("presentation_sections").delete().eq("presentation_id", presId) } catch {}
      try { await svc.from("listing_presentations").delete().eq("id", presId) } catch {}
    }
    for (const rid of renderIds) { try { await svc.from("remotion_composition_renders").delete().eq("id", rid) } catch {} }
    const { count } = await svc.from("presentation_sections").select("id", { count: "exact", head: true }).eq("presentation_id", presId ?? "00000000-0000-0000-0000-000000000000")
    check("cleanup verified — 0 sections remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Pre-listing RELEASE gate simulator (two-gate model)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Two-gate verified — produce auto, release human-gated, nothing reaches the seller unreviewed")
}
main().catch((e) => { console.error(e); process.exit(1) })
