#!/usr/bin/env tsx
/**
 * scripts/section-render-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — animated CMA section + on-demand drip trigger harness.
 *
 *   Layer 2 (live, gated): seed a CMA report + comparables + a listing
 *   presentation, materialize the drip (which auto-renders the CMA section),
 *   and assert the CMA section carries a queued CMAReel render whose input_props
 *   are SELLER-SAFE (no suggested-price leak). Also proves the
 *   'start_prelisting_drip' marketing-agent action type is accepted (the
 *   Command-Center trigger). Self-cleans via FK cascade + explicit deletes.
 *
 * Run:  npx tsx scripts/section-render-simulator.ts   (npm run test:section-render)
 */
import { findSuggestedPriceLeaks } from "../lib/cma/customer-facing-guard"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Section render simulator (animated CMA section + drip trigger)")
  console.log("══════════════════════════════════════════════════")

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log("\n RESULT: 0 passed, 0 failed (skipped — no DB credentials)")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { materializePresentationSections } = await import("../lib/listing-presentation/section-drip")
  const svc = createServiceClient()
  const TAG = `__secrender_${Date.now()}__`
  const cleanup: Array<{ table: string; col: string; val: string }> = []
  let renderId: string | null = null

  try {
    const { data: contact } = await svc.from("contacts").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).single()
    const { data: usr } = await svc.from("users").select("id").limit(1).single()
    // cma_reports.agent_id FK-references agents(id) (not users).
    const { data: agentRow } = await svc.from("agents").select("id").limit(1).single()
    if (!contact || !usr || !agentRow) { console.log("  ⏭  Skipped — need a contact + user + agent."); return }
    const brokerageId = (contact as any).brokerage_id
    const contactId = (contact as any).id

    // Seed a CMA report + comparables for this seller.
    const { data: cma, error: cErr } = await svc.from("cma_reports").insert({
      contact_id: contactId, agent_id: (agentRow as any).id, property_address: `${TAG} 742 Evergreen Ter`,
    }).select("id").single()
    check("seed cma_report", !cErr && !!cma, cErr?.message)
    if (!cma) throw new Error("cma seed failed")
    cleanup.push({ table: "cma_reports", col: "id", val: (cma as any).id })
    await svc.from("cma_comparables").insert([
      { cma_id: (cma as any).id, address: "501 N Riverwalk", sale_price: 640000, days_on_market: 18 },
      { cma_id: (cma as any).id, address: "1245 Bay Rd", sale_price: 658000, days_on_market: 12 },
    ])

    // Seed the presentation for this contact.
    const { data: pres } = await svc.from("listing_presentations").insert({
      brokerage_id: brokerageId, contact_id: contactId, state: "FL", property_address: `${TAG} 742 Evergreen Ter`,
      built_at: new Date().toISOString(), appointment_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      cma_mid_value: 675000, cma_narrative: "Strong market.", net_sheet: {}, marketing_plan: {}, slide_deck: { slides: [] }, status: "ready",
    }).select("id").single()
    if (!pres) throw new Error("presentation seed failed")
    const presId = (pres as any).id
    cleanup.push({ table: "listing_presentations", col: "id", val: presId })

    // Materialize sections — auto-renders the CMA section.
    const mat = await materializePresentationSections(presId, svc)
    check("materialize schedules the sections", mat.ok && mat.inserted > 0, mat.error)

    // Every section should now carry an animated render.
    const { data: allSections } = await svc.from("presentation_sections")
      .select("section_key, render_id").eq("presentation_id", presId)
    const secs = (allSections ?? []) as Array<{ section_key: string; render_id: string | null }>
    const withRender = secs.filter((s) => !!s.render_id)
    check("most sections got an animated render attached", withRender.length >= 5, `${withRender.length}/${secs.length}`)
    for (const s of withRender) cleanup.push({ table: "remotion_composition_renders", col: "id", val: s.render_id! })

    // CMA section → seller-safe CMAReel.
    const cmaSection = secs.find((s) => s.section_key === "cma")
    check("CMA section rendered", !!cmaSection?.render_id)
    renderId = cmaSection?.render_id ?? null
    if (renderId) {
      const { data: render } = await svc.from("remotion_composition_renders")
        .select("composition_id, render_status, input_props").eq("id", renderId).single()
      check("CMA section render targets CMAReel + queued", (render as any)?.composition_id === "CMAReel" && (render as any)?.render_status === "queued")
      const props = (render as any)?.input_props ?? {}
      check("CMA section render is SELLER-SAFE (no price leak)", findSuggestedPriceLeaks(props).length === 0, JSON.stringify(findSuggestedPriceLeaks(props)))
      check("CMA section render omits the subject value bar", Array.isArray(props.comps) && props.comps.every((c: any) => c.isSubject !== true))
    }

    // A non-CMA section → branded ListingSectionReel.
    const introSection = secs.find((s) => s.section_key === "intro")
    if (introSection?.render_id) {
      const { data: introRender } = await svc.from("remotion_composition_renders")
        .select("composition_id, input_props").eq("id", introSection.render_id).single()
      check("intro section render targets ListingSectionReel", (introRender as any)?.composition_id === "ListingSectionReel")
      check("intro section carries 'why us' brand copy", Array.isArray((introRender as any)?.input_props?.bullets) && (introRender as any).input_props.bullets.length > 0)
    }

    // #4 — the Command-Center on-demand trigger action type is accepted.
    const { data: action, error: aErr } = await svc.from("marketing_agent_actions").insert({
      brokerage_id: brokerageId, action_type: "start_prelisting_drip",
      action_input: { presentation_id: presId }, rationale: `${TAG} trigger`, status: "proposed",
    }).select("id").single()
    check("'start_prelisting_drip' action type accepted (Command-Center trigger)", !aErr && !!action, aErr?.message)
    if (action) cleanup.push({ table: "marketing_agent_actions", col: "id", val: (action as any).id })
  } finally {
    if (renderId) { try { await svc.from("remotion_composition_renders").delete().eq("id", renderId) } catch { /* noop */ } }
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq(c.col, c.val) } catch { /* noop */ }
    }
    const { count } = await svc.from("cma_reports").select("id", { count: "exact", head: true }).like("property_address", `${TAG}%`)
    check("cleanup verified — 0 test CMA reports remain", (count ?? 0) === 0)
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Animated CMA section + drip trigger verified (seller-safe)")
}
main().catch((e) => { console.error(e); process.exit(1) })
