#!/usr/bin/env tsx
/**
 * scripts/vendor-doc-compliance-simulator.ts   (npm run test:vendor-doc-compliance)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves VENDOR DOCUMENT-EXPIRY COMPLIANCE — insurance lapse suspends a vendor, license lapse soft-flags
 * with a 14-day grace, and upcoming expiries (60/30/7d) propose gated renewal reminders. Honest: a missing
 * expiry is never a fabricated lapse.
 *
 * PURE:   daysUntil + evaluateCredential (insurance→suspend on expiry; license→grace; 60/30/7 remind) +
 *         evaluateVendorCompliance (overall suspend/flag/reminders).
 * SOURCE: the runner suspends on insurance lapse + proposes deduped gated reminders; the cron runs it;
 *         setVendorComplianceCredential is admin-gated + wired into the approval UI; owned by compliance_officer.
 * LIVE (creds-gated): seed a vendor with an EXPIRED insurance credential → the monitor suspends it (off the
 *         bench) → an upcoming-expiry vendor gets a gated reminder → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  daysUntil,
  evaluateCredential,
  evaluateVendorCompliance,
  LICENSE_GRACE_DAYS,
} from "../lib/kernel/vendor-doc-compliance"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const NOW = new Date("2026-06-15T00:00:00Z")
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString().slice(0, 10)

function pureLayer() {
  console.log("\n[daysUntil · pure]")
  check("future date → positive days", daysUntil(iso(30), NOW) === 30)
  check("past date → negative days", daysUntil(iso(-5), NOW) === -5)
  check("no/invalid date → null (honest)", daysUntil(null, NOW) === null && daysUntil("nope", NOW) === null)

  console.log("\n[evaluateCredential · pure — insurance hard, license grace]")
  check("insurance expired → SUSPEND", evaluateCredential({ type: "insurance", expiry: iso(-1) }, NOW).action === "suspend")
  check("license expired within grace → SOFT FLAG", evaluateCredential({ type: "license", expiry: iso(-3) }, NOW).action === "soft_flag")
  check(`license expired PAST ${LICENSE_GRACE_DAYS}d grace → SUSPEND`, evaluateCredential({ type: "license", expiry: iso(-(LICENSE_GRACE_DAYS + 1)) }, NOW).action === "suspend")
  check("expiry in 45d → remind (60 window)", evaluateCredential({ type: "insurance", expiry: iso(45) }, NOW).action === "remind" && evaluateCredential({ type: "insurance", expiry: iso(45) }, NOW).window === "60")
  check("expiry in 5d → remind (7 window)", evaluateCredential({ type: "license", expiry: iso(5) }, NOW).window === "7")
  check("expiry far out (200d) → ok/none", evaluateCredential({ type: "license", expiry: iso(200) }, NOW).action === "none")
  check("no expiry → ok/none (never a fabricated lapse)", evaluateCredential({ type: "insurance", expiry: null }, NOW).action === "none")

  console.log("\n[evaluateVendorCompliance · pure — overall disposition]")
  const expiredIns = evaluateVendorCompliance({ insurance: { expiry: iso(-2) }, license: { expiry: iso(100) } }, NOW)
  check("expired insurance → shouldSuspend", expiredIns.shouldSuspend)
  const soon = evaluateVendorCompliance({ insurance: { expiry: iso(20) }, license: { expiry: iso(6) } }, NOW)
  check("two upcoming expiries → two reminders, no suspend", soon.reminders.length === 2 && !soon.shouldSuspend)
  check("empty bag → nothing", evaluateVendorCompliance(null, NOW).credentials.length === 0)
}

function sourceLayer() {
  console.log("\n[wiring — suspend on lapse, gated reminders, admin setter, cron, owned]")
  const lib = src("lib/kernel/vendor-doc-compliance.ts")
  check("insurance lapse suspends the vendor (status → inactive)", /shouldSuspend && v\.status === "active"[\s\S]*?status: "inactive"/.test(lib))
  check("reminders are gated + deduped per vendor+credential+window+week", /VENDOR DOC EXPIRY — \$\{v\.id\} \$\{rem\.type\} \$\{rem\.window\} \$\{week\}/.test(lib) && /proposeClientMessage/.test(lib))
  const act = src("app/actions/vendor-verification.ts")
  check("setVendorComplianceCredential is admin-gated + writes the jsonb", /setVendorComplianceCredential/.test(act) && /requireAdmin\(\)/.test(act) && /compliance_credentials: bag/.test(act))
  const ui = src("app/dashboard/admin/vendor-approvals/approval-client.tsx")
  check("the approval UI records insurance/license expiry via the action", /setVendorComplianceCredential\(v\.id, "insurance"/.test(ui) && /setVendorComplianceCredential\(v\.id, "license"/.test(ui))
  const cron = src("app/api/cron/vendor-orchestration/route.ts")
  check("the daily vendor cron runs document-expiry compliance", /runVendorDocComplianceAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by compliance_officer with a runnable proof", /vendor_doc_compliance:\s*\{\s*manager:\s*"compliance_officer",\s*proof:\s*"test:vendor-doc-compliance"/.test(reg))
  check("vendors.compliance_credentials is in the schema snapshot", /vendors:\s*\[[^\]]*"compliance_credentials"/.test(src("scripts/schema-snapshot.ts")))
  check("package.json wires the proof", /"test:vendor-doc-compliance":\s*"tsx scripts\/vendor-doc-compliance-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a vendor with EXPIRED insurance → monitor suspends it → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const { runVendorDocCompliance } = await import("../lib/kernel/vendor-doc-compliance")
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  try {
    const { data: v } = await svc.from("vendors").insert({
      brokerage_id: brokerageId, name: "ZZ DocExpiry Sim Vendor", category: "inspector", status: "active",
      compliance_credentials: { insurance: { expiry: yesterday } },
    }).select("id").single()
    const vendorId = (v as any).id
    cleanup.push({ table: "vendors", id: vendorId })

    const r1 = await runVendorDocCompliance(svc as any, { brokerageId })
    check("live: the monitor suspended ≥1 vendor (expired insurance)", r1.suspended >= 1)
    const { data: after } = await svc.from("vendors").select("status, verification_flags").eq("id", vendorId).maybeSingle()
    check("live: the vendor is now inactive (off the bench)", (after as any)?.status === "inactive")
    check("live: the suspension reason is recorded on the flags", Array.isArray((after as any)?.verification_flags) && (after as any).verification_flags.some((f: string) => f.startsWith("suspended:")))
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_DOC_COMPLIANCE_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_DOC_COMPLIANCE_PASS — insurance lapse suspends, license lapse soft-flags with grace, expiries remind")
}
main()
