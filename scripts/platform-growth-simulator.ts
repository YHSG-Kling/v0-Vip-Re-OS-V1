#!/usr/bin/env tsx
/**
 * scripts/platform-growth-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM SELF-MARKETING — the platform markets VIP Agents ITSELF (the AI OS
 * transforming real estate) to prospective customers, owned by the platform
 * MARKETING role. Public hand-raise → funnel → gated pitch/advance → conversion.
 *
 * Layer 1 (pure): validateProspectInput (email required, role normalized);
 *   rollupGrowthFunnel (counts, conversion + activation rates); composeProspectOutreach
 *   (tier-aware product pitch, no fabricated claims).
 * Layer 2 (source): capture is PUBLIC (no staff gate) but idempotent by email; the
 *   funnel/advance/pitch are gated to platform marketing staff (platformStaffCan
 *   'marketing') + audited; the get-started page calls capture; the growth board is
 *   gated.
 * Layer 3 (live, gated): capture a prospect → the roster lists it + the funnel
 *   counts it → advance to trial → the funnel activation reflects it → cleanup==0.
 *
 * Run: npx tsx scripts/platform-growth-simulator.ts   (npm run test:platform-growth)
 */
import { validateProspectInput, rollupGrowthFunnel, composeProspectOutreach } from "../lib/platform/growth-funnel"
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
  console.log(" ✅ Platform self-marketing verified — public capture, gated funnel, tier-aware product pitch")
  console.log(" PLATFORM_GROWTH_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Platform growth (self-marketing) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure funnel + pitch]")
  const v = validateProspectInput({ email: " Broker@CO.com ", name: " Dana ", roleInterest: "brokerage", company: "Acme" })
  check("valid prospect normalizes (email lowered, role kept)", v.ok && v.value.email === "broker@co.com" && v.value.roleInterest === "brokerage")
  check("bad email → error", !validateProspectInput({ email: "nope" }).ok)
  check("unknown role → normalized to 'unknown'", (() => { const r = validateProspectInput({ email: "a@b.co", roleInterest: "ceo" }); return r.ok && r.value.roleInterest === "unknown" })())

  const funnel = rollupGrowthFunnel([
    { status: "new" }, { status: "new" }, { status: "contacted" }, { status: "trial" }, { status: "converted" }, { status: "lost" },
  ])
  check("funnel counts by status", funnel.total === 6 && funnel.byStatus.new === 2 && funnel.byStatus.converted === 1 && funnel.byStatus.lost === 1)
  check("conversion = converted / (total − lost) = 1/5 = 20%", Math.round(funnel.conversionRate * 100) === 20)
  check("activation = (trial + converted) / total = 2/6 ≈ 33%", Math.round(funnel.activationRate * 100) === 33)
  check("empty funnel → 0 rates (no divide-by-zero)", (() => { const f = rollupGrowthFunnel([]); return f.conversionRate === 0 && f.activationRate === 0 })())

  const pitch = composeProspectOutreach({ name: "Dana Broker", roleInterest: "brokerage", company: "Acme" })
  check("pitch is the product's own story (AI TEAM, one command center, voice admin), tier-aware, personalized",
    /AI TEAM/.test(pitch.body) && /command center/.test(pitch.body) && /voice admin/.test(pitch.body) && /Acme/.test(pitch.body) && /Hi Dana,/.test(pitch.body))

  console.log("\n[Layer 2 · public capture, gated funnel wiring]")
  const actionSrc = readFileSync(join(process.cwd(), "app/actions/superadmin/platform-growth.ts"), "utf8")
  check("capture is PUBLIC (no staff gate) + idempotent by email",
    /export async function capturePlatformProspectAction/.test(actionSrc) && /onConflict: "email"/.test(actionSrc) && !/capturePlatformProspectAction[\s\S]{0,200}requireMarketingStaff/.test(actionSrc))
  check("funnel/advance/pitch gated to platform MARKETING staff (capability map) + audited",
    /requireMarketingStaff/.test(actionSrc) && /platformStaffCan\(role, "marketing"\)/.test(actionSrc) && /superadmin_audit_log/.test(actionSrc))
  const formSrc = readFileSync(join(process.cwd(), "app/get-started/get-started-form.tsx"), "utf8")
  check("the public get-started page calls capture (top-of-funnel front door)", /capturePlatformProspectAction\(/.test(formSrc))
  const pageSrc = readFileSync(join(process.cwd(), "app/dashboard/superadmin/growth/page.tsx"), "utf8")
  check("growth board is gated by platformStaffCan('marketing')", /platformStaffCan\(role, "marketing"\)/.test(pageSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live funnel]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const email = `growthprobe_${Date.now()}@probe.local`.toLowerCase()

  console.log("\n[Layer 3 · live funnel]")
  try {
    const { data: p, error } = await svc.from("platform_prospects").insert({
      name: "Growth Probe", email, company: "Probe RE", role_interest: "brokerage", source: "get_started", status: "new",
    }).select("id").single()
    if (error) { check("capture prospect", false, error.message); report(); return }
    const id = (p as any).id
    check("prospect captured (status new, no brokerage yet)", !!id)

    const { data: listed } = await svc.from("platform_prospects").select("status, role_interest").eq("id", id).single()
    check("prospect is listable + role-tagged", (listed as any).status === "new" && (listed as any).role_interest === "brokerage")

    await svc.from("platform_prospects").update({ status: "trial", contacted_at: new Date().toISOString() }).eq("id", id)
    const { data: rows } = await svc.from("platform_prospects").select("status").in("status", ["trial"]).eq("id", id)
    const f = rollupGrowthFunnel((rows ?? []) as any)
    check("advanced to trial → funnel activation reflects it", f.byStatus.trial === 1 && f.activationRate === 1)
  } finally {
    try { await svc.from("platform_prospects").delete().eq("email", email) } catch { /* noop */ }
    const { count } = await svc.from("platform_prospects").select("id", { count: "exact", head: true }).eq("email", email)
    check("cleanup verified — 0 seeded prospects remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
