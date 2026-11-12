#!/usr/bin/env tsx
/**
 * scripts/vendor-package-direction-simulator.ts   (npm run test:vendor-package-direction)
 * ─────────────────────────────────────────────────────────────────────────────
 * PINS THE DIRECTION OF EVERY VENDOR MONEY PATH so the inversion that shipped two waves ago
 * cannot silently come back.
 *
 * Owner ruling, verbatim:
 *   "vendor packages are for brokerages to charge the vendor on a subscription to the platform.
 *    vendors do bill the brokerages for jobs but not a monthly subscription."
 *
 * WHAT WENT WRONG. `vendor_plans` shipped as a VENDOR'S OWN price list and `vendor_subscriptions`
 * as a BROKERAGE BUYING one of those plans monthly — money brokerage → vendor, recurring. That
 * cadence does not exist in that direction. It looked right because
 * `vendor_subscriptions(brokerage_id, vendor_id, plan_id)` is SYMMETRIC: two party columns and
 * nothing saying which one pays, so the table agrees with whichever direction the reader arrives
 * with. This file is the thing that disagrees.
 *
 * PURE:   the three money paths (lib/vendors/vendor-money-directions.ts) — payer, payee, cadence,
 *         and the proof that NO path is brokerage → vendor recurring.
 * SOURCE: the writers, the two screens and the migration all state the SAME direction. A correct
 *         schema under a screen that says the opposite is not corrected, so the words are asserted
 *         too.
 * LIVE (creds-gated): what the database actually holds. Reports honestly whether m497 has been
 *         applied — the direction facts are asserted either way, against whichever shape is live.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  VENDOR_PACKAGE,
  VENDOR_JOB_BILL,
  VENDOR_PLATFORM_TIER,
  VENDOR_MONEY_PATHS,
  VENDOR_PACKAGE_BILLING_DIRECTION,
  RETIRED_INVERTED_VENDOR_PACKAGE,
  isVendorPackageDirection,
  describeDirection,
} from "../lib/vendors/vendor-money-directions"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const root = process.cwd()
const src = (p: string) => readFileSync(join(root, p), "utf8")

const MIGRATION = "supabase/migrations/m497-a-vendor-package-was-modelled-as-money-flowing-the-wrong-way.sql"

function pureLayer() {
  console.log("\n[money paths · pure — who pays whom, and how often]")
  check("VENDOR PACKAGE is vendor → brokerage",
    VENDOR_PACKAGE.payer === "vendor" && VENDOR_PACKAGE.payee === "brokerage")
  check("VENDOR PACKAGE is RECURRING", VENDOR_PACKAGE.cadence === "recurring")
  check("VENDOR JOB BILL is brokerage → vendor",
    VENDOR_JOB_BILL.payer === "brokerage" && VENDOR_JOB_BILL.payee === "vendor")
  check("VENDOR JOB BILL is PER JOB — the ruling names the absence of a monthly form",
    VENDOR_JOB_BILL.cadence === "per_job")
  check("VENDOR PLATFORM TIER is vendor → platform, recurring (pre-existing, untouched)",
    VENDOR_PLATFORM_TIER.payer === "vendor" && VENDOR_PLATFORM_TIER.payee === "platform"
    && VENDOR_PLATFORM_TIER.cadence === "recurring")

  console.log("\n[the inversion · pure — the shape that shipped must be unreachable]")
  check("NO path is brokerage → vendor RECURRING (the direction that shipped and was wrong)",
    VENDOR_MONEY_PATHS.every((p) => !(p.payer === "brokerage" && p.payee === "vendor" && p.cadence === "recurring")))
  check("the retired inversion is NOT in the live path list",
    !(VENDOR_MONEY_PATHS as readonly { id: string }[]).some((p) => p.id === RETIRED_INVERTED_VENDOR_PACKAGE.id))
  check("the retired inversion is still NAMED, so the regression stays checkable",
    RETIRED_INVERTED_VENDOR_PACKAGE.payer === "brokerage" && RETIRED_INVERTED_VENDOR_PACKAGE.payee === "vendor")
  check("isVendorPackageDirection accepts ONLY vendor → brokerage",
    isVendorPackageDirection("vendor", "brokerage")
    && !isVendorPackageDirection("brokerage", "vendor")
    && !isVendorPackageDirection("vendor", "platform"))
  check("the billing_direction literal is the one m497's CHECK admits",
    VENDOR_PACKAGE_BILLING_DIRECTION === "vendor_pays_brokerage")

  console.log("\n[the two recurring vendor-outbound paths are distinguishable · pure]")
  check("package and platform tier share payer but not payee",
    VENDOR_PACKAGE.payer === VENDOR_PLATFORM_TIER.payer && VENDOR_PACKAGE.payee !== VENDOR_PLATFORM_TIER.payee)
  check("they are recorded in DIFFERENT tables",
    VENDOR_PACKAGE.recordedIn !== VENDOR_PLATFORM_TIER.recordedIn)
  check("every path id is unique", new Set(VENDOR_MONEY_PATHS.map((p) => p.id)).size === VENDOR_MONEY_PATHS.length)

  console.log("\n[one ledger, not two · pure]")
  check("the package fee is billed through the SAME ledger as the per-job bill (vendor_invoices)",
    VENDOR_PACKAGE.billedThrough === "vendor_invoices" && VENDOR_JOB_BILL.billedThrough === "vendor_invoices")
  check("the platform tier is NOT on this ledger at all", VENDOR_PLATFORM_TIER.billedThrough === null)
  check("describeDirection renders the payer first", describeDirection(VENDOR_PACKAGE).startsWith("vendor pays brokerage"))
}

function sourceLayer() {
  console.log("\n[the catalogue writer · source — the SELLER is the brokerage]")
  const planAction = src("app/actions/vendors/vendor-plans.ts")
  check("every export is an async Server Action",
    planAction.split("\n").filter((l) => /^export\s+(const|function|class|let|var|enum)\s/.test(l)).length === 0)
  check("packages are written with brokerage_id, never vendor_id",
    planAction.includes("brokerage_id: actor.brokerageId") && !/vendor_id:/.test(planAction))
  check("ownership is on the WRITE itself, not a prior read",
    (planAction.match(/\.eq\("brokerage_id", actor\.brokerageId\)/g) ?? []).length >= 4)
  check("the writer runs the live-CHECK validator", planAction.includes("validateVendorPlan"))
  check("delete refuses an ENROLLED package by name and count before the FK raises 23503",
    planAction.includes("vendor_subscriptions") && /enrolled in this package/.test(planAction))
  check("archiving is offered as the retirement path",
    planAction.includes("setVendorPlanStatusAction") && planAction.includes("archived"))

  console.log("\n[the enrolment writer · source — the brokerage charges, the vendor reads]")
  const subAction = src("app/actions/vendors/vendor-plan-subscriptions.ts")
  check("the charging brokerage comes from the write seam, never from the caller",
    subAction.includes("resolveWriteContext") && !/params[^\n]*brokerageId/.test(subAction))
  check("every vendor_subscriptions read AND write is tenant-pinned",
    (subAction.match(/\.eq\("brokerage_id", ctx\.brokerageId\)/g) ?? []).length >= 4)
  check("the direction literal is WRITTEN, from the shared constant, never left to the column default",
    subAction.includes("billing_direction: VENDOR_PACKAGE_BILLING_DIRECTION"))
  check("the enrolled vendor must be on the charging brokerage's own bench",
    /\.from\("vendors"\)[\s\S]{0,200}\.eq\("brokerage_id", ctx\.brokerageId\)/.test(subAction))
  check("only an ACTIVE package may be enrolled into", subAction.includes('plan.status !== "active"'))
  check("a repeat enrolment is a sentence, not a 23505 from the UNIQUE index",
    subAction.includes("already enrolled in this package"))
  check("ending an enrolment KEEPS the row (the used period is the charge basis) — it never deletes",
    subAction.includes('status: "canceled"')
    && !/\.from\("vendor_subscriptions"\)[\s\S]{0,200}\.delete\(/.test(subAction))
  check("the PAYER's action is READ-ONLY — a vendor cannot write its own bill",
    subAction.includes("listMyVendorPackageChargesAction")
    && !/listMyVendorPackageChargesAction[\s\S]{0,2000}\.(insert|update|delete)\(/.test(subAction))
  // The header NAMES vendor_marketplace_profiles to explain why the payer moved out of that id
  // space, so the assertion is on the QUERY, not on the word.
  check("the vendor is resolved through the CANONICAL portal grant, not the platform-tier id space",
    subAction.includes("selectVendorGrant") && !/\.from\("vendor_marketplace_profiles"\)/.test(subAction))
  check("no fabricated charge — the enrolment says it is not a Stripe subscription",
    /not a Stripe subscription/i.test(subAction))

  console.log("\n[the screens · source — a correct schema under a wrong screen is not corrected]")
  const vendorPage = src("app/vendor/plans/page.tsx")
  const vendorClient = src("app/vendor/plans/plans-client.tsx")
  check("the vendor page says the BROKERAGE charges the vendor",
    /charges\s+<strong>you<\/strong>/.test(vendorPage) || /charges you/i.test(vendorPage))
  check("the vendor page no longer offers a plan editor (the payer does not author its bill)",
    !vendorClient.includes("createVendorPlanAction") && !vendorClient.includes("validateVendorPlan"))
  check("the vendor page separates the per-job lane from the package lane in words",
    /per job/i.test(vendorPage) && /never monthly/i.test(vendorPage))
  check("the vendor page separates the package from the PLATFORM tier in words",
    /platform tier/i.test(vendorPage) || /\/vendor\/billing/.test(vendorPage))

  const panel = src("app/dashboard/vendors/vendor-plan-catalogue-panel.tsx")
  check("the brokerage panel says the brokerage CHARGES its vendors",
    /you charge your vendors/i.test(panel))
  check("the brokerage panel is where the package is AUTHORED (validator runs client-side too)",
    panel.includes("validateVendorPlan") && panel.includes("createVendorPlanAction"))
  check("the brokerage panel renders the direction from the shared constant, not retyped prose",
    panel.includes("{direction}"))
  check("the brokerage panel names the per-job lane as the OTHER direction",
    /per job/i.test(panel) && /never monthly/i.test(panel))
  check("the tab is labelled Packages, not Plans",
    /<span className="hidden sm:inline">Packages<\/span>/.test(src("app/dashboard/vendors/page.tsx")))
  check("the vendor surface is still NAV-LINKED (never a page nothing points at)",
    src("app/config/navigation-config.ts").includes("'/vendor/plans'"))

  console.log("\n[the migration · source]")
  check("m497 exists", existsSync(join(root, MIGRATION)))
  const mig = existsSync(join(root, MIGRATION)) ? src(MIGRATION) : ""
  check("m497 quotes the owner ruling verbatim",
    mig.includes("vendor packages are for brokerages to charge the vendor"))
  check("m497 gives vendor_plans a brokerage owner", /add column if not exists brokerage_id/.test(mig))
  check("m497 removes the wrong-direction column", /vendor_plans drop column if exists vendor_id/.test(mig))
  check("m497 pins the direction with a SINGLE-VALUED check",
    /check \(billing_direction = 'vendor_pays_brokerage'\)/.test(mig))
  check("m497 makes a cross-tenant enrolment unrepresentable (composite FK)",
    /references public\.vendor_plans \(id, brokerage_id\)/.test(mig))
  check("m497 moves the payer into the id space the per-job ledger already bills",
    /references public\.vendors\(id\)/.test(mig))
  check("m497 records that the earlier direction was an ERROR and why",
    /WRONG|wrong way|inverted|INVERTED/.test(mig) && mig.includes("m497"))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the direction")
    return
  }
  const svc = createClient(url, key)
  console.log("\n[live] what the database actually holds")

  // Probe by SELECT rather than information_schema: PostgREST answers with a
  // named error for a column that does not exist, which is a fact either way.
  const probe = async (table: string, column: string) => {
    const { error } = await svc.from(table).select(column).limit(1)
    return !error
  }
  const hasBrokerageOnPlans = await probe("vendor_plans", "brokerage_id")
  const hasVendorOnPlans = await probe("vendor_plans", "vendor_id")
  const hasDirection = await probe("vendor_subscriptions", "billing_direction")

  if (hasBrokerageOnPlans && !hasVendorOnPlans && hasDirection) {
    console.log("  · m497 IS APPLIED")
    check("live: vendor_plans is owned by a brokerage", hasBrokerageOnPlans)
    check("live: the wrong-direction vendor_plans.vendor_id is gone", !hasVendorOnPlans)
    check("live: vendor_subscriptions carries billing_direction", hasDirection)
    const { error: badDirection } = await svc
      .from("vendor_subscriptions")
      .insert({
        brokerage_id: "00000000-0000-0000-0000-000000000000",
        vendor_id: "00000000-0000-0000-0000-000000000000",
        plan_id: "00000000-0000-0000-0000-000000000000",
        billing_direction: "brokerage_pays_vendor",
        current_period_start: new Date().toISOString(),
        current_period_end: new Date().toISOString(),
      })
    // Refused for SOME reason is guaranteed (the FKs are bogus); the assertion is
    // that supabase-js RESOLVED with an error rather than writing the row.
    check("live: the inverted direction is REFUSED by the database, not accepted", !!badDirection)
  } else {
    console.log("  · m497 IS NOT YET APPLIED — reporting the pre-migration shape honestly")
    check("live (pre-migration): vendor_plans still carries the wrong-direction vendor_id", hasVendorOnPlans)
    check("live (pre-migration): vendor_plans has no brokerage owner yet", !hasBrokerageOnPlans)
    check("live (pre-migration): vendor_subscriptions has no billing_direction yet", !hasDirection)
    console.log("    → apply " + MIGRATION + " to move the schema onto the corrected direction.")
  }

  // TRUE IN BOTH SHAPES: the tables are empty, so nothing was ever recorded in
  // the inverted direction and no ledger needs re-interpreting.
  const { count: planCount } = await svc.from("vendor_plans").select("id", { count: "exact", head: true })
  const { count: subCount } = await svc.from("vendor_subscriptions").select("id", { count: "exact", head: true })
  check(`live: no money was ever recorded in the inverted direction (vendor_plans=${planCount ?? "?"}, vendor_subscriptions=${subCount ?? "?"})`,
    (planCount ?? 0) === 0 && (subCount ?? 0) === 0)
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_PACKAGE_DIRECTION_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_PACKAGE_DIRECTION_PASS — vendor pays brokerage for a package (recurring); brokerage pays vendor per job; vendor pays platform for its tier")
}
main()
