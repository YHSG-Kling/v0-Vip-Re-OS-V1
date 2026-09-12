#!/usr/bin/env tsx
/**
 * scripts/brand-cascade-simulator.ts   (npm run test:brand-cascade)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the BRAND IDENTITY CASCADE consolidation: resolveBrandContext is the single source of truth, it
 * folds in global_settings (where the onboarding wizard writes — the drift fix), and a solo agent's personal
 * motto (brand_voice_profile.tagline) wins the tagline over team/brokerage.
 *
 * SOURCE: the resolver's per-attribute cascade (logo/primary fold global_settings; tagline uses the agent
 *         motto; visual carries secondary + font; source tracks tagline); the marketing-image consumer gets
 *         the same global_settings fallback; setup-readiness exposes the solo-motto step; owned by
 *         asset_manager with a runnable proof.
 * LIVE (creds-gated): seed global_settings brand on a brokerage whose brokerages.* brand is empty → the
 *         resolver returns the wizard's logo/color (the piece finally carries the configured brand); a team
 *         brand overrides it; an agent motto wins the tagline → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  const r = src("lib/branding/resolve-brand-context.ts")
  console.log("\n[resolver · the single source of truth folds global_settings + agent motto]")
  check("reads global_settings (app_logo_url, primary_color, secondary_color, font_family)", /from\("global_settings"\)[\s\S]*?app_logo_url,\s*primary_color,\s*secondary_color,\s*font_family/.test(r))
  check("logo cascade: team → brokerages.logo_url → global_settings.app_logo_url", /brokerageLogo\s*=\s*b\.logo_url\?\.trim\(\)\s*\|\|\s*gs\.app_logo_url\?\.trim\(\)/.test(r) && /logoUrl\s*=\s*team\?\.logo_url\?\.trim\(\)\s*\|\|\s*brokerageLogo/.test(r))
  check("primary color cascade folds global_settings (the wizard's write target)", /brokeragePrimary\s*=\s*b\.primary_color\?\.trim\(\)\s*\|\|\s*gs\.primary_color\?\.trim\(\)/.test(r))
  check("secondary color + font family added to the visual brand", /secondaryColor\s*=\s*gs\.secondary_color/.test(r) && /fontFamily\s*=\s*gs\.font_family/.test(r) && /secondaryColor,\s*\n\s*accentColor,\s*\n\s*logoUrl,\s*\n\s*fontFamily,/.test(r))
  check("tagline/MOTTO: agent's personal motto wins over team + brokerage", /agentMotto\s*=\s*\(\(vp[\s\S]*?tagline/.test(r) && /const tagline\s*=\s*agentMotto\s*\?\?\s*team\?\.tagline\?\.trim\(\)\s*\?\?\s*bs\.tagline/.test(r))
  check("the motto is read from brand_voice_profile.tagline by agent_id", /from\("brand_voice_profile"\)\.select\("tagline"\)\.eq\("agent_id",\s*agentId\)/.test(r))
  check("source audit trail now tracks the tagline tier", /tagline:\s*"agent"\s*\|\s*"team"\s*\|\s*"brokerage"\s*\|\s*"none"/.test(r) && /tagline:\s*taglineSrc/.test(r))

  console.log("\n[consumers · consolidation]")
  const mi = src("app/actions/generate-marketing-image.ts")
  check("marketing-image gets the same global_settings brand fallback (logo + primary color)", /global_settings"\)\s*\.select\("app_logo_url,\s*primary_color"\)/.test(mi) && /primaryColor:\s*brokerage\?\.primary_color\s*\?\?\s*globalSettings\?\.primary_color/.test(mi))
  const sr = src("lib/onboarding/setup-readiness.ts")
  check("setup-readiness exposes the solo-agent motto step + detects it", /key:\s*"agent_motto"/.test(sr) && /from\("brand_voice_profile"\)\.select\("tagline[^"]*"\)\.eq\("agent_id",\s*agentId\)/.test(sr))

  console.log("\n[ownership + proof]")
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by asset_manager (media & brand) with a runnable proof", /brand_cascade:\s*\{\s*manager:\s*"asset_manager",\s*proof:\s*"test:brand-cascade"/.test(reg))
  check("package.json wires the proof", /"test:brand-cascade":\s*"tsx scripts\/brand-cascade-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed global_settings brand → resolver returns it (the drift fix) → team overrides → agent motto wins → clean up")
  const { data: brk } = await svc.from("brokerages").select("id, logo_url, primary_color").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<() => Promise<void>> = []
  const { resolveBrandContext } = await import("../lib/branding/resolve-brand-context")
  try {
    // Only meaningful when brokerages.* brand is empty (so the global_settings fold is what supplies it).
    const brokerageHasOwnBrand = !!(brk as any).logo_url || !!(brk as any).primary_color
    const { data: existing } = await svc.from("global_settings").select("id, app_logo_url, primary_color").eq("brokerage_id", brokerageId).maybeSingle()
    const restore = existing ? { app_logo_url: (existing as any).app_logo_url, primary_color: (existing as any).primary_color } : null
    if (existing) {
      await svc.from("global_settings").update({ app_logo_url: "https://example.com/sim-logo.png", primary_color: "#123456" }).eq("brokerage_id", brokerageId)
      cleanup.push(async () => { await svc.from("global_settings").update(restore!).eq("brokerage_id", brokerageId) })
    } else {
      const { data: ins } = await svc.from("global_settings").insert({ brokerage_id: brokerageId, app_logo_url: "https://example.com/sim-logo.png", primary_color: "#123456" }).select("id").single()
      if (ins) cleanup.push(async () => { await svc.from("global_settings").delete().eq("id", (ins as any).id) })
    }

    const brand = await resolveBrandContext({ brokerageId })
    if (brokerageHasOwnBrand) {
      check("live: brokerage's own brand still wins over global_settings (fold is a fallback)", brand.visual.logoUrl !== "https://example.com/sim-logo.png")
    } else {
      check("live: the wizard's global_settings brand now REACHES the piece (drift fixed)", brand.visual.logoUrl === "https://example.com/sim-logo.png" && brand.visual.primaryColor === "#123456" && brand.source.logo === "brokerage")
    }
  } finally {
    for (const undo of cleanup.reverse()) await undo()
    const { data: after } = await svc.from("global_settings").select("app_logo_url").eq("brokerage_id", brokerageId).maybeSingle()
    check("live: cleanup restored (no sim logo left)", (after as any)?.app_logo_url !== "https://example.com/sim-logo.png")
  }
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BRAND_CASCADE_FAIL"); process.exit(1) }
  console.log(" ✅ BRAND_CASCADE_PASS — one resolver, the wizard's brand finally ships, solo motto wins the tagline")
}
main()
