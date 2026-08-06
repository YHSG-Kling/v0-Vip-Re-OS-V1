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
  readVendorInsurance,
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

  // ── m376 · INSURANCE VERIFICATION POSTURE ───────────────────────────────
  // The four states a human must be able to tell apart on the bench, plus the
  // two "we do not know" states that must NEVER be rounded to a verdict.
  console.log("\n[readVendorInsurance · pure — the posture a broker reads]")
  const coi = (expiryDays: number) => ({
    insurance: {
      carrier: "Acme Mutual", policy_number: "GL-1", coverage_amount: 1_000_000,
      effective_date: "2026-01-01", expiry: iso(expiryDays),
      verified_at: "2026-06-01T00:00:00.000Z", verified_by: "00000000-0000-0000-0000-000000000000",
    },
  })
  check("no credential bag at all → never (not 'verified', not 'expired')",
    readVendorInsurance(null, NOW).posture === "never")
  check("bag with no insurance key → never",
    readVendorInsurance({ license: { expiry: iso(400) } }, NOW).posture === "never")
  check("expiry 400d out → verified", readVendorInsurance(coi(400), NOW).posture === "verified")
  check("expiry 45d out → expiring (inside the widest reminder window)",
    readVendorInsurance(coi(45), NOW).posture === "expiring")
  check("expiry 3d out → expiring", readVendorInsurance(coi(3), NOW).posture === "expiring")
  check("expiry 1d PAST → expired", readVendorInsurance(coi(-1), NOW).posture === "expired")
  check("a certificate with NO expiry → no_expiry, never 'verified'",
    readVendorInsurance({ insurance: { carrier: "Acme Mutual" } }, NOW).posture === "no_expiry")
  // THE EXACT HAZARD m376's date CHECK exists to stop. Date.parse returns NaN
  // for these, daysUntil returns null, and the posture is "no_expiry" — which is
  // honest for a reader but is ALSO what evaluateCredential reads as "nothing to
  // act on". A lapsed vendor stored this way would never be suspended, so the
  // fix has to be at the database, not here.
  check("an UNPARSEABLE expiry → no_expiry, never 'verified'",
    readVendorInsurance({ insurance: { expiry: "soon" } }, NOW).posture === "no_expiry" &&
    readVendorInsurance({ insurance: { expiry: "" } }, NOW).posture === "no_expiry")
  // Note the near-miss: "12/31/2025" IS parseable by V8 (US ordering), so it
  // reads as expired rather than unknown — but a locale that reads it as
  // 12 Mar would disagree. m376 refuses it at the column so the ambiguity is
  // never stored in the first place.
  check("an AMBIGUOUS locale date is refused by the column, not relied on here",
    /12\/31\/2025/.test(src("supabase/migrations/m376-vendor-insurance-verification.sql")))
  check("the certificate fields are carried through for display",
    readVendorInsurance(coi(400), NOW).carrier === "Acme Mutual" &&
    readVendorInsurance(coi(400), NOW).coverageAmount === 1_000_000 &&
    readVendorInsurance(coi(400), NOW).policyNumber === "GL-1")
  check("the detail line always names the DATE the verdict came from",
    readVendorInsurance(coi(-1), NOW).detail.includes(iso(-1)))
  check("a certificate nobody confirmed says so out loud",
    readVendorInsurance({ insurance: { expiry: iso(400) } }, NOW).detail.includes("Never confirmed"))
  // The posture and the automation must agree about a lapse — one screen saying
  // "insured" while the nightly sweep suspends the vendor is the drift class.
  check("posture 'expired' and evaluateVendorCompliance.shouldSuspend agree",
    readVendorInsurance(coi(-1), NOW).posture === "expired" &&
    evaluateVendorCompliance(coi(-1) as any, NOW).shouldSuspend)
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
  // m376 — the full certificate of insurance, and the surface it reaches.
  check("recordVendorInsuranceAction is admin-gated and brokerage-scoped on BOTH the read and the write",
    /recordVendorInsuranceAction/.test(act) && /requireAdmin\(\)/.test(act) &&
    (act.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length >= 2)
  check("…it NEVER fabricates a verdict — the status is computed from the row it read back",
    /\.select\("id, compliance_credentials"\)/.test(act) &&
    /readVendorInsurance\(\(saved as any\)\.compliance_credentials/.test(act))
  check("…every supabase call in it destructures its error",
    /const \{ data: vendor, error: readErr \}/.test(act) && /if \(readErr\)/.test(act) &&
    /const \{ data: saved, error: writeErr \}/.test(act) && /if \(writeErr\)/.test(act))
  check("…it stamps verified_by from the SESSION user (users.id), never a substituted id space",
    /verified_by: userId/.test(act))
  check("…and it does not silently reactivate a suspended vendor",
    !/status: "active"/.test(act.slice(act.indexOf("recordVendorInsuranceAction"))))
  const dir = src("app/dashboard/vendors/vendor-directory-client.tsx")
  check("the vendor directory records insurance via the action and READS the outcome",
    /recordVendorInsuranceAction\(/.test(dir) && /if \(!result\.success\)/.test(dir) && /setInsuranceError\(result\.error\)/.test(dir))
  check("the vendor list distinguishes verified / expiring / expired / never on every card",
    /readVendorInsurance\(vendor\.compliance_credentials/.test(dir) && /INSURANCE_BADGE\[insurance\.posture\]/.test(dir))
  check("…and the page actually selects the column the badge reads",
    /compliance_credentials/.test(src("app/dashboard/vendors/page.tsx")))
  check("the approval queue shows the posture and surfaces a refusal",
    /readVendorInsurance\(v\.compliance_credentials/.test(ui) && /errors\[v\.id\]/.test(ui) && /catch \(e\)/.test(ui))
  const mig = src("supabase/migrations/m376-vendor-insurance-verification.sql")
  check("m376 pins the credential vocabulary so a typo cannot downgrade a hard suspend",
    /vendors_compliance_credentials_shape/.test(mig) && /'license' - 'insurance' - 'certification' - 'bond'/.test(mig))
  check("m376 forces every stored date to be parseable", /\^\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(mig))
  check("m376 RAISEs if it did not achieve its goal", /RAISE EXCEPTION 'm376 FAILED/.test(mig))
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
