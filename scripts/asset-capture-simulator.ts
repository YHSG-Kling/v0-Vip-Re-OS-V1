#!/usr/bin/env tsx
/**
 * scripts/asset-capture-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — proves every finished render is captured into the reusable
 * marketing_assets library (so charts / section videos / avatar clips / b-roll
 * can be repurposed across social, email, listing promo, and ads). Drives the
 * REAL captureRenderAsMarketingAsset against the live schema; idempotent;
 * self-cleans. Gated on SUPABASE_SERVICE_ROLE_KEY.
 *
 * Run:  npx tsx scripts/asset-capture-simulator.ts   (npm run test:asset-capture)
 */
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Reusable marketing-asset capture simulator")
  console.log("══════════════════════════════════════════════════")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log("\n RESULT: 0 passed, 0 failed (skipped — no DB credentials)")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { captureRenderAsMarketingAsset } = await import("../lib/marketing/capture-render-asset")
  const svc = createServiceClient()
  const TAG = `__capsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: usr } = await svc.from("users").select("id").limit(1).single()
    if (!brk || !usr) { console.log("  ⏭  Skipped — need a brokerage + user."); return }
    const url = `https://example.test/${TAG}out.mp4`

    // A SUCCEEDED render → should be captured.
    const { data: render } = await svc.from("remotion_composition_renders").insert({
      brokerage_id: (brk as any).id, composition_id: "CMAReel", agent_user_id: (usr as any).id,
      used_did_avatar: true, used_voiceover: false, render_status: "succeeded", output_url: url,
      input_props: { sectionKey: "market" }, scope_type: "agent", scope_id: (usr as any).id,
      requested_via: "cron", is_published: false, entity_type: "listing_presentation",
    }).select("id").single()
    if (!render) throw new Error("render seed failed")
    cleanup.push({ table: "remotion_composition_renders", id: (render as any).id })

    const res = await captureRenderAsMarketingAsset((render as any).id, svc)
    check("succeeded render is captured", res.ok === true, res.ok ? "" : res.skipped)
    if (!res.ok) throw new Error(res.skipped)
    cleanup.push({ table: "marketing_assets", id: res.assetId })

    const { data: asset } = await svc.from("marketing_assets")
      .select("asset_type, asset_url, tags, source_table, source_id, visibility_scope").eq("id", res.assetId).single()
    check("captured as a reusable video asset", (asset as any)?.asset_type === "video")
    check("asset_url points at the render output", (asset as any)?.asset_url === url)
    check("tagged 'reusable' + composition + avatar", Array.isArray((asset as any)?.tags) && (asset as any).tags.includes("reusable") && (asset as any).tags.includes("CMAReel") && (asset as any).tags.includes("avatar"))
    check("links back to the source render", (asset as any)?.source_table === "remotion_composition_renders" && (asset as any)?.source_id === (render as any).id)
    check("visibility scope carried from the render", (asset as any)?.visibility_scope === "agent")

    // Idempotency — second call returns the same asset, no duplicate.
    const again = await captureRenderAsMarketingAsset((render as any).id, svc)
    check("capture is idempotent (same asset, no duplicate)", again.ok === true && again.ok && again.assetId === res.assetId)
    const { count } = await svc.from("marketing_assets").select("id", { count: "exact", head: true })
      .eq("source_table", "remotion_composition_renders").eq("source_id", (render as any).id)
    check("exactly one asset row for the render", (count ?? 0) === 1)

    // A NOT-yet-finished render is skipped.
    const { data: queued } = await svc.from("remotion_composition_renders").insert({
      brokerage_id: (brk as any).id, composition_id: "CMAReel", used_did_avatar: false, used_voiceover: false,
      render_status: "queued", input_props: {}, scope_type: "agent", requested_via: "cron", is_published: false,
    }).select("id").single()
    if (queued) {
      cleanup.push({ table: "remotion_composition_renders", id: (queued as any).id })
      const skip = await captureRenderAsMarketingAsset((queued as any).id, svc)
      check("unfinished render is NOT captured", skip.ok === false)
    }
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("remotion_composition_renders").select("id", { count: "exact", head: true }).like("output_url", `%${TAG}%`)
    check("cleanup verified — 0 test renders remain", (count ?? 0) === 0)
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Render → reusable marketing asset verified (idempotent, cleaned up)")
}
main().catch((e) => { console.error(e); process.exit(1) })
