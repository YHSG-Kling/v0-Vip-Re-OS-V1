#!/usr/bin/env tsx
/**
 * scripts/platform-brand-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM BRAND KIT + TOPIC POOL + ATTRIBUTION. The app's NAME is still being
 * decided → it lives in platform_settings.product_brand (like tenants get their
 * brand cascade), every self-marketing surface resolves it, CTAs carry UTMs so
 * the funnel attributes channel × angle, and reels/posts pull from a watched-topic
 * pool (competitor buzz / trends) that humans curate.
 *
 * Layer 1 (pure): resolveProductBrand (defaults, clamps, hex/url validation);
 *   brandCta (UTM attribution); validateTopic; topicToAngle (honest — speaks to
 *   the conversation, proof is about OUR architecture, never disparages);
 *   brand-threaded composers (post/calendar/video) + topic-infused calendar.
 * Layer 2 (source): no hardcoded product name left in composers/reel/pages (all
 *   resolve brand); reel takes brand.name/tagline + ctaDomain props; calendar/video
 *   actions load brand + consume topics (marked used); get-started captures UTMs.
 * Layer 3 (live): brand jsonb round-trip on platform_settings + topic lifecycle
 *   (new → used) + restore/cleanup == 0.
 */
import { resolveProductBrand, brandCta, validateTopic, topicToAngle, DEFAULT_PRODUCT_BRAND } from "../lib/platform/product-brand"
import { composeProductPost, buildWeeklyProductCalendar, composeProductVideoSpec } from "../lib/platform/product-content"
import { composeProspectOutreach } from "../lib/platform/growth-funnel"
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
  console.log(" ✅ Brand kit + topic pool verified — configurable name everywhere, attributed CTAs, honest topic angles")
  console.log(" PLATFORM_BRAND_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Platform brand + topic pool simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure brand + topics + attribution]")
  const b = resolveProductBrand({ name: "  Nova OS  ", tagline: "x", primaryColor: "#101010", accentColor: "nope", ctaUrl: "https://nova.ai/" })
  check("brand resolves: trims name, keeps valid hex, rejects bad hex → default, strips trailing slash",
    b.name === "Nova OS" && b.primaryColor === "#101010" && b.accentColor === DEFAULT_PRODUCT_BRAND.accentColor && b.ctaUrl === "https://nova.ai")
  check("empty brand → full defaults", resolveProductBrand(null).name === DEFAULT_PRODUCT_BRAND.name)
  check("brandCta carries UTM attribution (channel × angle)",
    brandCta(b, "linkedin", "ai_team") === "https://nova.ai/get-started?utm_source=linkedin&utm_campaign=ai_team")
  check("validateTopic: short topic rejected; source normalized",
    !validateTopic({ source: "x", topic: "short" }).ok && (() => { const v = validateTopic({ source: "weird", topic: "MoxiWorks launched a new AI feature" }); return v.ok && v.value.source === "manual" })())
  const ta = topicToAngle("AI listing tools", b)
  check("topicToAngle is HONEST: speaks to the topic, proof is about OUR architecture + brand name, no disparagement",
    /AI listing tools/.test(ta.hook) && /accountable AI TEAM/.test(ta.proof) && /Nova OS/.test(ta.proof) && !/worse|bad|fail/i.test(ta.proof))

  const post = composeProductPost("linkedin", "ai_team", b)
  check("post is brand-driven: name + attributed CTA (no hardcoded product name)",
    /Nova OS/.test(post.content) && /utm_source=linkedin/.test(post.content) && !/VIP Agents/.test(post.content))
  const cal = buildWeeklyProductCalendar("2026-07-06", b, ["Competitor X shipped a chatbot"])
  check("calendar weaves topics into odd days (topic angle) while even days stay evergreen",
    cal[1].angle === "topic" && /Competitor X shipped a chatbot/.test(cal[1].content) && cal[0].angle !== "topic")
  const spec = composeProductVideoSpec("ai_team", "vertical", b, "Portal lead quality debate")
  check("topic-driven VIDEO: hook speaks to the topic, brand name/tagline + ctaDomain in inputProps",
    /Portal lead quality debate/.test(spec.inputProps.hook) && spec.inputProps.brand.name === "Nova OS" && spec.inputProps.ctaDomain === "nova.ai/get-started")
  const pitch = composeProspectOutreach({ name: "Dana", brandName: "Nova OS" })
  check("prospect pitch uses the configured name", /Nova OS/.test(pitch.body) && !/VIP Agents/.test(pitch.body))

  console.log("\n[Layer 2 · de-hardcoded wiring]")
  const reelSrc = readFileSync(join(process.cwd(), "remotion/ProductPromoReel.tsx"), "utf8")
  check("reel takes brand.name/tagline + ctaDomain props (hardcoded name is only a fallback)",
    /brand\?\.name/.test(reelSrc) && /brand\?\.tagline/.test(reelSrc) && /ctaDomain/.test(reelSrc))
  check("reel visuals reflect the OS: command-center grid + manager HANDOFF animation + capability chips",
    /HandoffLane/.test(reelSrc) && /Listing Concierge/.test(reelSrc) && /CapabilityChip/.test(reelSrc) && /COMMAND CENTER/.test(reelSrc))
  const contentAct = readFileSync(join(process.cwd(), "app/actions/superadmin/platform-content.ts"), "utf8")
  check("calendar/video actions load the brand + consume topics (marked used)",
    /loadProductBrand/.test(contentAct) && /platform_content_topics/.test(contentAct) && /status: "used"/.test(contentAct))
  const brandAct = readFileSync(join(process.cwd(), "app/actions/superadmin/platform-brand.ts"), "utf8")
  check("brand + topics actions marketing-gated + audited; harvest is creds-gated (honest not-configured)",
    /platformStaffCan\(role, "marketing"\)/.test(brandAct) && /TAVILY_API_KEY/.test(brandAct) && /not configured/i.test(brandAct))
  const gsSrc = readFileSync(join(process.cwd(), "app/get-started/page.tsx"), "utf8")
  check("get-started is brand-driven + captures UTMs into the prospect source",
    /loadProductBrand/.test(gsSrc) && /utm_source/.test(gsSrc) && /brand\.name/.test(gsSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 3 · live] ⏭  Skipped — no SUPABASE creds."); report(); return }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadProductBrand } = await import("../lib/platform/product-brand")
  const svc = createServiceClient()
  const TAG = `BrandProbe${Date.now()}`
  try {
    const { data: row } = await svc.from("platform_settings").select("id, product_brand").limit(1).maybeSingle()
    const orig = (row as any)?.product_brand ?? {}
    if (row) {
      await svc.from("platform_settings").update({ product_brand: { ...orig, name: TAG } }).eq("id", (row as any).id)
      const after = await loadProductBrand(svc)
      check("live: brand name round-trips through platform_settings", after.name === TAG)
      await svc.from("platform_settings").update({ product_brand: orig }).eq("id", (row as any).id)
      const restored = await loadProductBrand(svc)
      check("live: original brand restored", restored.name !== TAG)
    } else { check("platform_settings singleton exists", false) }

    const { data: t } = await svc.from("platform_content_topics").insert({ topic: `${TAG} competitor launch buzz`, source: "competitor", status: "new" }).select("id").single()
    await svc.from("platform_content_topics").update({ status: "used", used_at: new Date().toISOString() }).eq("id", (t as any).id)
    const { data: tAfter } = await svc.from("platform_content_topics").select("status").eq("id", (t as any).id).single()
    check("live: topic lifecycle new → used", (tAfter as any).status === "used")
  } finally {
    await svc.from("platform_content_topics").delete().like("topic", `${TAG}%`)
    const { count } = await svc.from("platform_content_topics").select("id", { count: "exact", head: true }).like("topic", `${TAG}%`)
    check("cleanup verified — 0 seeded topics remain", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
