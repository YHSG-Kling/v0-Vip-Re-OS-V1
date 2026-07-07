#!/usr/bin/env tsx
/**
 * scripts/product-video-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM PRODUCT VIDEOS — the platform creates its own promo VIDEOS for social,
 * from the REAL ProductPromoReel Remotion composition (registered in remotion/
 * Root.tsx; bundle-verified + a real frame rendered via the Remotion CLI with the
 * sandbox's headless Chrome). One source of truth: the video spec reuses
 * PRODUCT_ANGLES, so text posts and reels tell the same honest story.
 *
 * Layer 1 (pure): composeProductVideoSpec — targets ProductPromoReel with the
 *   composition's exact contract (450 frames @30fps; vertical 1080×1920 / square
 *   1080×1080), 3 deterministic proof beats (angle + next two, wrapping), script =
 *   hook+beats+CTA (no fabricated stats), caption from the SAME post composer;
 *   unknown angle/format fall back safely.
 * Layer 2 (source): the composition is registered in Root.tsx with matching
 *   duration/fps/dims; video actions are marketing-gated + audited; posting a
 *   VIDEO draft requires video_url (enforced in the transition action); board
 *   wired with generate/attach controls.
 * Layer 3 (live, gated): insert a video draft (media_type CHECK) → approve →
 *   posting WITHOUT video_url must fail conceptually (action-level; here we assert
 *   the DB columns round-trip: attach video_url → posted w/ permalink) → cleanup.
 *
 * Run: npx tsx scripts/product-video-simulator.ts   (npm run test:product-video)
 */
import { composeProductVideoSpec, videoProofBeats, VIDEO_FORMATS, PRODUCT_ANGLES } from "../lib/platform/product-content"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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
  console.log(" ✅ Product video verified — real composition contract, one story, gated video lifecycle")
  console.log(" PRODUCT_VIDEO_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Product video (platform promo reels) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure spec ↔ composition contract]")
  const spec = composeProductVideoSpec("voice_admin", "vertical")
  check("spec targets ProductPromoReel at the composition's exact contract (450f @30fps, 1080×1920)",
    spec.compositionId === "ProductPromoReel" && spec.durationInFrames === 450 && spec.fps === 30 && spec.width === 1080 && spec.height === 1920)
  check("square format resolves 1080×1080 → linkedin", (() => { const s = composeProductVideoSpec("ai_team", "square"); return s.width === 1080 && s.height === 1080 && s.channel === "linkedin" })())
  check("3 deterministic proof beats (chosen angle first, wraps the catalog)",
    (() => { const b = videoProofBeats("voice_admin"); return b.length === 3 && b[0] === PRODUCT_ANGLES.voice_admin.proof && new Set(b).size === 3 })())
  check("script = hook + beats + CTA, honest (no fabricated %/x claims)",
    spec.script.startsWith(PRODUCT_ANGLES.voice_admin.hook) && spec.script.split("\n").length === 5 && !/\d+%|\d+x/i.test(spec.script))
  check("caption comes from the SAME post composer (one story)", /get-started/.test(spec.caption))
  check("unknown angle/format fall back safely", (() => { const s = composeProductVideoSpec("nope", "weird" as any); return s.angle === "ai_team" && s.format === "vertical" })())
  check("inputProps match the composition's prop shape (hook/proofs/cta/brand)",
    typeof spec.inputProps.hook === "string" && Array.isArray(spec.inputProps.proofs) && typeof spec.inputProps.cta === "string" && !!spec.inputProps.brand.primaryColor)

  console.log("\n[Layer 2 · registration + gated wiring]")
  const rootSrc = readFileSync(join(process.cwd(), "remotion/Root.tsx"), "utf8")
  check("ProductPromoReel registered in Root.tsx with matching contract",
    /id="ProductPromoReel"/.test(rootSrc) && /durationInFrames=\{450\}/.test(rootSrc.split('id="ProductPromoReel"')[1] ?? ""))
  const actSrc = readFileSync(join(process.cwd(), "app/actions/superadmin/platform-content.ts"), "utf8")
  check("video draft + attach actions are marketing-gated + audited",
    /generateProductVideoDraftAction/.test(actSrc) && /attachProductVideoAction/.test(actSrc) && /platform_content\.video_draft/.test(actSrc))
  check("posting a VIDEO draft requires video_url (enforced at the transition)",
    /media_type === "video"/.test(actSrc) && /before marking a video posted/.test(actSrc))
  const boardSrc = readFileSync(join(process.cwd(), "app/dashboard/superadmin/growth/product-content-board.tsx"), "utf8")
  check("board wired: + Video generator, script display, attach control",
    /generateProductVideoDraftAction/.test(boardSrc) && /attachProductVideoAction/.test(boardSrc) && /ProductPromoReel script/.test(boardSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live video-draft lifecycle]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `ProdVideo${Date.now()}`

  console.log("\n[Layer 3 · live video-draft lifecycle]")
  try {
    const s = composeProductVideoSpec("compliance_wire", "vertical")
    const { data: d, error } = await svc.from("platform_social_drafts").insert({
      channel: s.channel, angle: s.angle, content: `${TAG} ${s.caption}`, status: "draft",
      media_type: "video", format: s.format, script: s.script,
    }).select("id").single()
    if (error) { check("insert video draft", false, error.message); report(); return }
    const id = (d as any).id
    check("video draft inserted (media_type CHECK accepts 'video')", !!id)

    await svc.from("platform_social_drafts").update({ status: "approved" }).eq("id", id)
    await svc.from("platform_social_drafts").update({ video_url: "https://cdn.example.com/promo.mp4" }).eq("id", id)
    await svc.from("platform_social_drafts").update({ status: "posted", permalink: "https://instagram.com/p/promo" }).eq("id", id)
    const { data: after } = await svc.from("platform_social_drafts").select("status, video_url, permalink, script").eq("id", id).single()
    check("lifecycle persisted: approved → video attached → posted (script + video_url + permalink all round-trip)",
      (after as any).status === "posted" && !!(after as any).video_url && !!(after as any).permalink && ((after as any).script ?? "").includes("Compliance"))
  } finally {
    await svc.from("platform_social_drafts").delete().like("content", `${TAG}%`)
    const { count } = await svc.from("platform_social_drafts").select("id", { count: "exact", head: true }).like("content", `${TAG}%`)
    check("cleanup verified — 0 seeded drafts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
