#!/usr/bin/env tsx
/**
 * scripts/platform-gaps-simulator.ts — the last control-plane gaps: revenue
 * TREND (pure MRR/churn rollup over paid invoices), ToS acceptance (required
 * checkbox, versioned durable record, idempotent), and the reel's optional
 * platform-screenshot Ken Burns layer (image-backed engagement, honest fallback).
 */
import { rollupRevenueAnalytics } from "../lib/platform/revenue-analytics"
import { composeProductVideoSpec } from "../lib/platform/product-content"
import { readFileSync } from "node:fs"
import { join } from "node:path"
let passed = 0, failed = 0
const failures: string[] = []
function check(n: string, c: boolean, d?: string) { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; failures.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
function report() { console.log(`\n RESULT: ${passed} passed, ${failed} failed`); if (failed) { failures.forEach(f => console.log(`   - ${f}`)); process.exit(1) } console.log(" ✅ PLATFORM_GAPS_PASS") }
async function main() {
  const now = new Date("2026-07-15T00:00:00Z")
  const inv = [
    { amount_cents: 10000, status: "paid", paid_at: "2026-07-02T00:00:00Z", invoice_date: "2026-07-02" },
    { amount_cents: 5000, status: "paid", paid_at: "2026-06-10T00:00:00Z", invoice_date: "2026-06-10" },
    { amount_cents: 9999, status: "open", paid_at: null, invoice_date: "2026-07-03" },
  ]
  const subs = [{ status: "active", cancelled_at: null }, { status: "trialing", cancelled_at: null }, { status: "cancelled", cancelled_at: "2026-06-01T00:00:00Z" }]
  const r = rollupRevenueAnalytics(inv, subs, 6, now)
  check("MRR = collected money this month (open invoices EXCLUDED)", r.currentMrrCents === 10000)
  check("MoM growth = (100-50)/50 = 100%", Math.round(r.momGrowth * 100) === 100)
  check("6 months bucketed, oldest→newest", r.months.length === 6 && r.months[5].month === "2026-07" && r.months[4].paidCents === 5000)
  check("churn = 1 cancelled / (1 active + 1 cancelled) = 50%; counts right", Math.round(r.churnRate * 100) === 50 && r.activeCount === 1 && r.trialingCount === 1)
  check("empty inputs → zeroed, no divide-by-zero", (() => { const e = rollupRevenueAnalytics([], [], 3, now); return e.currentMrrCents === 0 && e.churnRate === 0 && e.months.length === 3 })())

  const subsPage = readFileSync(join(process.cwd(), "app/dashboard/superadmin/subscriptions/page.tsx"), "utf8")
  check("revenue trend rendered on the subscriptions page", /loadRevenueAnalytics/.test(subsPage) && /Revenue trend/.test(subsPage))
  const signup = readFileSync(join(process.cwd(), "app/signup/signup-form.tsx"), "utf8")
  check("signup REQUIRES ToS checkbox + records acceptance of the CURRENT version before provisioning",
    /tosAccepted/.test(signup) && /recordTosAcceptanceAction/.test(signup) && /getCurrentTosVersionAction/.test(signup) && /disabled=\{isPending \|\| !tosAccepted\}/.test(signup))
  const tosAct = readFileSync(join(process.cwd(), "app/actions/public/tos-acceptance.ts"), "utf8")
  check("acceptance is idempotent per (email, version) + captures IP/UA", /onConflict: "email,tos_version"/.test(tosAct) && /x-forwarded-for/.test(tosAct))
  const reel = readFileSync(join(process.cwd(), "remotion/ProductPromoReel.tsx"), "utf8")
  check("reel: optional Ken Burns platform-screenshot slideshow with honest grid fallback",
    /imageUrls\?/.test(reel) && /KenBurnsShot/.test(reel) && /\(imageUrls \?\? \[\]\)\.length > 0/.test(reel))
  const spec = composeProductVideoSpec("ai_team", "vertical", undefined, null, ["https://cdn.example.com/shot1.png"])
  check("video spec threads imageUrls into the composition props", (spec.inputProps as any).imageUrls?.length === 1)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  live skipped (no creds)"); report(); return }
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const email = `tosprobe_${Date.now()}@probe.local`
  try {
    await svc.from("platform_tos_acceptances").upsert({ email, tos_version: "vTEST" }, { onConflict: "email,tos_version" })
    await svc.from("platform_tos_acceptances").upsert({ email, tos_version: "vTEST" }, { onConflict: "email,tos_version" })
    const { count } = await svc.from("platform_tos_acceptances").select("id", { count: "exact", head: true }).eq("email", email)
    check("live: acceptance recorded ONCE despite double-submit (idempotent)", count === 1)
  } finally {
    await svc.from("platform_tos_acceptances").delete().eq("email", email)
    const { count } = await svc.from("platform_tos_acceptances").select("id", { count: "exact", head: true }).eq("email", email)
    check("cleanup — 0 rows remain", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
