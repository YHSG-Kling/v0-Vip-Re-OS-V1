#!/usr/bin/env tsx
/**
 * scripts/product-content-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM SOCIAL SELF-MARKETING — the platform uses the marketing muscle to market
 * VIP AGENTS ITSELF on the company channels. Honest product story (differentiators,
 * no fabricated stats), channel-shaped (X ≤ 280), gated drafts draft → approved →
 * posted (permalink required), worked by the platform MARKETING role.
 *
 * Layer 1 (pure): composeProductPost per channel (X length cap; linkedin long-form;
 *   CTA → /get-started; no invented numbers); buildWeeklyProductCalendar is
 *   deterministic (explicit start date, 7 posts rotating channels × angles);
 *   canTransitionDraft (posted requires approved + permalink; terminal states).
 * Layer 2 (source): actions marketing-gated + audited; generation idempotent per
 *   (channel, date); board wired on /superadmin/growth.
 * Layer 3 (live, gated): insert draft → approve → posted w/ permalink → cleanup==0.
 *
 * Run: npx tsx scripts/product-content-simulator.ts   (npm run test:product-content)
 */
import {
  composeProductPost, buildWeeklyProductCalendar, canTransitionDraft,
  PRODUCT_CHANNELS, PRODUCT_ANGLES, X_MAX_CHARS,
} from "../lib/platform/product-content"
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
  console.log(" ✅ Product content verified — honest channel-shaped drafts, gated lifecycle, marketing-owned")
  console.log(" PRODUCT_CONTENT_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Product content (platform social self-marketing) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure composer + calendar + lifecycle]")
  for (const ch of PRODUCT_CHANNELS) {
    const p = composeProductPost(ch, "ai_team")
    check(`${ch}: post composes with CTA + hashtags`, /get-started/.test(p.content) && p.hashtags.length > 0)
  }
  check("X post respects the 280-char cap", composeProductPost("x", "lead_to_lifetime").content.length <= X_MAX_CHARS)
  check("copy is HONEST — no fabricated percentage/claim numbers in any angle",
    Object.keys(PRODUCT_ANGLES).every((a) => !/\d+%|\d+x/i.test(composeProductPost("linkedin", a).content)))
  check("unknown angle falls back to ai_team (never throws)", composeProductPost("facebook", "nope").angle === "ai_team")

  const cal = buildWeeklyProductCalendar("2026-07-06")
  check("calendar: 7 deterministic posts rotating channels, dated from the start date",
    cal.length === 7 && cal[0].scheduledFor === "2026-07-06" && cal[6].scheduledFor === "2026-07-12" &&
    new Set(cal.map((c) => c.channel)).size === PRODUCT_CHANNELS.length)
  check("calendar: bad date throws (no silent garbage)", (() => { try { buildWeeklyProductCalendar("nope"); return false } catch { return true } })())

  check("lifecycle: draft→approved ok; draft→posted blocked; approved→posted needs permalink",
    canTransitionDraft("draft", "approved").ok && !canTransitionDraft("draft", "posted").ok &&
    !canTransitionDraft("approved", "posted", "").ok && canTransitionDraft("approved", "posted", "https://x.com/p/1").ok)
  check("posted/discarded are terminal", !canTransitionDraft("posted", "approved").ok && !canTransitionDraft("discarded", "draft").ok)

  console.log("\n[Layer 2 · gating + wiring]")
  const actSrc = readFileSync(join(process.cwd(), "app/actions/superadmin/platform-content.ts"), "utf8")
  check("actions marketing-gated (capability map) + audited + idempotent per (channel, date)",
    /platformStaffCan\(role, "marketing"\)/.test(actSrc) && /superadmin_audit_log/.test(actSrc) && /eq\("scheduled_for", post\.scheduledFor\)/.test(actSrc))
  const pageSrc = readFileSync(join(process.cwd(), "app/dashboard/superadmin/growth/page.tsx"), "utf8")
  check("content board wired on the growth page", /ProductContentBoard/.test(pageSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live drafts]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `ProdContent${Date.now()}`

  console.log("\n[Layer 3 · live drafts]")
  try {
    const post = composeProductPost("linkedin", "command_center")
    const { data: d, error } = await svc.from("platform_social_drafts").insert({
      channel: post.channel, angle: post.angle, content: `${TAG} ${post.content}`, hashtags: post.hashtags,
      scheduled_for: "2099-01-01", status: "draft",
    }).select("id").single()
    if (error) { check("insert draft", false, error.message); report(); return }
    const id = (d as any).id
    check("draft inserted", !!id)

    await svc.from("platform_social_drafts").update({ status: "approved" }).eq("id", id)
    await svc.from("platform_social_drafts").update({ status: "posted", permalink: "https://linkedin.com/posts/test" }).eq("id", id)
    const { data: after } = await svc.from("platform_social_drafts").select("status, permalink").eq("id", id).single()
    check("lifecycle persisted (posted + permalink)", (after as any).status === "posted" && !!(after as any).permalink)
  } finally {
    await svc.from("platform_social_drafts").delete().like("content", `${TAG}%`)
    const { count } = await svc.from("platform_social_drafts").select("id", { count: "exact", head: true }).like("content", `${TAG}%`)
    check("cleanup verified — 0 seeded drafts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
