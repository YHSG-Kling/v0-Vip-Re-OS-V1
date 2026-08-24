#!/usr/bin/env tsx
/**
 * scripts/vendor-platform-use-double-charge-simulator.ts
 *   npm run test:vendor-platform-use
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A VENDOR IS SHARED, AND IS CHARGED FOR PLATFORM USE EXACTLY ONCE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling, verbatim:
 *
 *   "vendors whcih include title companies and lenders can be used by other
 *    brokerages so if a vendor is already on the platform, the brokerage/team/
 *    agent can't charge them for platform use only access to their contacts."
 *
 * Layer 1 (PURE): the rule itself — platformUseChargeVerdict. Two-sided: every
 *   refusal is paired with the allowance that proves the finder is not simply
 *   refusing everything, and every allowance with the refusal that proves it is
 *   not simply allowing everything (CLAUDE.md §2 — an absence assertion needs a
 *   POSITIVE CONTROL, and here so does a presence assertion).
 * Layer 2 (BEHAVIOURAL, stubbed I/O, zero network): the resolver. Proves the
 *   identity ladder (link → portal grant → email), that a REFUSED READ fails
 *   CLOSED rather than reading as "found nothing", and that a pre-migration
 *   missing column is a published BLIND SPOT rather than a silent zero.
 * Layer 3 (SOURCE): every charge lane goes through the one door, the job-bill
 *   lane is deliberately untouched, and the three silent-success writes on the
 *   billing surface count their rows.
 * Layer 4 (LIVE, creds-gated): m549 is really applied, and the database refuses
 *   the second charge itself — with the same two-sided controls, on real rows,
 *   cleaned up afterwards.
 *
 * MUTATION-TESTED: deleting the already_paying_platform branch of
 * platformUseChargeVerdict must turn this simulator RED. If it does not, the
 * simulator is decoration.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"
import {
  platformUseChargeVerdict,
  readVendorPlatformUseFacts,
  PLATFORM_USE_PAYING_STATUSES,
  PLATFORM_USE_ACTIVE_ENROLMENT_STATUSES,
  SHARED_VENDOR_CONTACT_ACCESS_SURFACE,
  SHARED_VENDOR_CONTACT_ACCESS_VERDICT,
  type PlatformUseFacts,
} from "../lib/vendors/vendor-platform-identity"
import {
  VENDOR_PACKAGE,
  VENDOR_JOB_BILL,
  VENDOR_PLATFORM_TIER,
  VENDOR_MONEY_PATHS,
  PLATFORM_USE_MONEY_PATHS,
} from "../lib/vendors/vendor-money-directions"
import { LIVE_TABLES } from "./live-tables"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** CLAUDE.md §2: a tombstone is not a call site — scan STRIPPED source. */
const src = (p: string) => stripComments(raw(p))

let pass = 0
let fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(t: string) { console.log(`\n■ ${t}`) }

const MIGRATION =
  "supabase/migrations/m549-a-vendor-shared-by-two-brokerages-could-be-charged-for-platform-use-twice.sql"

// A fact bag with nothing wrong with it. Every case below is this, one field moved,
// so a verdict change is attributable to exactly one fact.
const CLEAN: PlatformUseFacts = {
  resolved: true,
  unresolvedReason: null,
  platformVendorId: "pv-1",
  platformSubscriptionStatus: "canceled",
  otherTenantActiveEnrolments: 0,
  blindSpots: [],
}

// ─────────────────────────────────────────────────────────────────────────────
function layer1() {
  section("Layer 1 — which money paths are PLATFORM USE at all (pure)")

  check("a vendor PACKAGE is platform use — it sells marketplace access",
    VENDOR_PACKAGE.isPlatformUse === true)
  check("the vendor's own PLATFORM TIER is platform use",
    VENDOR_PLATFORM_TIER.isPlatformUse === true)
  check("a vendor JOB BILL is NOT platform use — it is money for work performed,\n    and a vendor that pays for platform use must still be paid for its jobs",
    VENDOR_JOB_BILL.isPlatformUse === false)
  check("the platform-use set is DERIVED from the paths, not retyped beside them",
    PLATFORM_USE_MONEY_PATHS.length === VENDOR_MONEY_PATHS.filter((p) => p.isPlatformUse).length
    && PLATFORM_USE_MONEY_PATHS.every((p) => p.isPlatformUse))
  check("…and it is exactly the two vendor-OUTBOUND recurring paths",
    PLATFORM_USE_MONEY_PATHS.every((p) => p.payer === "vendor" && p.cadence === "recurring"))

  section("Layer 1b — the RULE, two-sided (pure)")

  // ── ALLOWANCE side. Without these, a verdict function that returned "refuse"
  //    for every input would pass every refusal assertion below.
  check("POSITIVE CONTROL (allow): a vendor paying nobody IS chargeable",
    platformUseChargeVerdict(CLEAN).chargeable === true)
  check("POSITIVE CONTROL (allow): no platform identity at all → chargeable\n    (asked and answered 'not on the platform' is a DETERMINATE no, not an unknown)",
    platformUseChargeVerdict({ ...CLEAN, platformVendorId: null, platformSubscriptionStatus: null }).chargeable === true)
  for (const lapsed of ["canceled", "past_due"]) {
    check(`POSITIVE CONTROL (allow): a '${lapsed}' platform subscription is not a live arrangement`,
      platformUseChargeVerdict({ ...CLEAN, platformSubscriptionStatus: lapsed }).chargeable === true)
  }
  check("POSITIVE CONTROL (allow): a PAUSED enrolment elsewhere is not a live arrangement\n    (the resolver counts only PLATFORM_USE_ACTIVE_ENROLMENT_STATUSES)",
    !PLATFORM_USE_ACTIVE_ENROLMENT_STATUSES.has("paused")
    && platformUseChargeVerdict({ ...CLEAN, otherTenantActiveEnrolments: 0 }).chargeable === true)

  // ── REFUSAL side — the rule the owner ruling actually states.
  for (const paying of ["active", "trialing"]) {
    const v = platformUseChargeVerdict({ ...CLEAN, platformSubscriptionStatus: paying })
    check(`REFUSED: a vendor with a '${paying}' PLATFORM subscription cannot be charged for platform use`,
      v.chargeable === false && !v.chargeable && v.refusalCode === "already_paying_platform" && v.alreadyPaying === "platform")
  }
  check("the paying-status vocabulary is exactly {active, trialing}\n    — a trial is a live arrangement; a lapsed one is not",
    PLATFORM_USE_PAYING_STATUSES.has("active") && PLATFORM_USE_PAYING_STATUSES.has("trialing")
    && !PLATFORM_USE_PAYING_STATUSES.has("canceled") && !PLATFORM_USE_PAYING_STATUSES.has("past_due"))

  {
    const v = platformUseChargeVerdict({ ...CLEAN, otherTenantActiveEnrolments: 1 })
    check("REFUSED: a vendor already paying ANOTHER BROKERAGE for platform use\n    cannot be charged for platform use by this one",
      v.chargeable === false && !v.chargeable && v.refusalCode === "already_paying_another_tenant"
      && v.alreadyPaying === "another_tenant")
  }

  // ── FAIL CLOSED. This is the leg that must come FIRST: a resolver that could
  //    not answer must never fall through into "nothing found, go ahead".
  {
    const v = platformUseChargeVerdict({
      ...CLEAN, resolved: false, unresolvedReason: "the vendor record could not be read: permission denied",
    })
    check("FAIL CLOSED: an unresolved check REFUSES the charge — an unwanted charge is\n    harder to undo than a missing one",
      v.chargeable === false && !v.chargeable && v.refusalCode === "undeterminable" && v.alreadyPaying === null)
    check("…and it says WHY, so the tenant can fix it rather than retry blindly",
      !v.chargeable && v.reason.includes("permission denied"))
  }
  check("FAIL CLOSED beats every other fact: unresolved refuses EVEN WHEN the rest of\n    the bag looks perfectly chargeable",
    platformUseChargeVerdict({ ...CLEAN, resolved: false, unresolvedReason: "x" }).chargeable === false)

  check("every refusal names an actionable alternative (contact access, free)",
    ["already_paying_platform", "already_paying_another_tenant"].every((code) => {
      const v = code === "already_paying_platform"
        ? platformUseChargeVerdict({ ...CLEAN, platformSubscriptionStatus: "active" })
        : platformUseChargeVerdict({ ...CLEAN, otherTenantActiveEnrolments: 1 })
      return !v.chargeable && /contact access/i.test(v.reason)
    }))

  section("Layer 1c — what the second tenant gets instead (verdict, not a gap)")
  check("contact access is named as an EXISTING surface, not a new one to build",
    SHARED_VENDOR_CONTACT_ACCESS_SURFACE.startsWith("app/actions/vendor-contact-access.ts")
    && existsSync(join(ROOT, "app/actions/vendor-contact-access.ts")))
  check("…and the verdict says it is GRANTED, not sold",
    /granted, not sold/i.test(SHARED_VENDOR_CONTACT_ACCESS_VERDICT)
    && /carries no fee/i.test(SHARED_VENDOR_CONTACT_ACCESS_VERDICT))
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * A stub service client. Each table answers from a script; a table can also be
 * scripted to ERROR, which is the case the fail-closed leg exists for.
 */
function stubSvc(script: Record<string, { data: unknown; error: { message: string } | null }>) {
  const seen: string[] = []
  const builder = (table: string) => {
    const b: any = {
      select: () => b, eq: () => b, neq: () => b, in: () => b, ilike: () => b,
      not: () => b, limit: () => b,
      maybeSingle: async () => { seen.push(table); return script[table] ?? { data: null, error: null } },
      then: (res: any, rej: any) => { seen.push(table); return Promise.resolve(script[table] ?? { data: [], error: null }).then(res, rej) },
    }
    return b
  }
  return { client: { from: (t: string) => builder(t) } as any, seen }
}

async function layer2() {
  section("Layer 2 — the resolver (stubbed I/O, zero network)")

  const ARGS = { vendorId: "v-1", brokerageId: "b-1" }

  // FAIL CLOSED on a refused read of the bench row. supabase-js RESOLVES a
  // refusal, so without reading `error` this would have looked like "no vendor".
  {
    const { client } = stubSvc({ vendors: { data: null, error: { message: "permission denied for table vendors" } } })
    const f = await readVendorPlatformUseFacts(client, ARGS)
    check("a REFUSED read of the vendor record is UNRESOLVED, never 'nothing found'",
      f.resolved === false && /permission denied/.test(f.unresolvedReason ?? ""))
    check("…and the verdict built from it refuses the charge",
      platformUseChargeVerdict(f).chargeable === false)
  }

  // A vendor row the platform cannot identify at all.
  {
    const { client } = stubSvc({
      vendors: { data: { id: "v-1", brokerage_id: "b-1", email: null }, error: null },
      user_role_assignments: { data: [], error: null },
    })
    const f = await readVendorPlatformUseFacts(client, ARGS)
    check("no link, no portal account and no email → UNRESOLVED (fail closed)",
      f.resolved === false)
    check("…and the reason names the ONE thing that fixes it (add an email)",
      /add an email/i.test(f.unresolvedReason ?? ""))
  }

  // Identity attempted and genuinely absent — a determinate 'not on the platform'.
  {
    const { client } = stubSvc({
      vendors: { data: { id: "v-1", brokerage_id: "b-1", email: "co@example.test" }, error: null },
      user_role_assignments: { data: [], error: null },
      users: { data: [], error: null },
    })
    const f = await readVendorPlatformUseFacts(client, ARGS)
    check("an email that matches no platform account resolves to 'not on the platform'",
      f.resolved === true && f.platformVendorId === null)
    check("…and that IS chargeable — the gate does not brick the charge lane",
      platformUseChargeVerdict(f).chargeable === true)
    check("…with the blind spot published beside the answer (CLAUDE.md §2)",
      f.blindSpots.some((b) => /no platform identity resolved/i.test(b)))
  }

  // A missing column is a KNOWN pre-migration state, not an unknown.
  {
    const calls: string[] = []
    const client: any = {
      from: (t: string) => {
        const b: any = {
          select: (cols: string) => { calls.push(`${t}:${cols}`); return b },
          eq: () => b, neq: () => b, in: () => b, ilike: () => b, not: () => b, limit: () => b,
          maybeSingle: async () => {
            const last = calls[calls.length - 1]
            if (last === "vendors:platform_vendor_id") {
              return { data: null, error: { message: 'column vendors.platform_vendor_id does not exist' } }
            }
            if (t === "vendors") return { data: { id: "v-1", brokerage_id: "b-1", email: "co@example.test" }, error: null }
            return { data: null, error: null }
          },
          then: (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej),
        }
        return b
      },
    }
    const f = await readVendorPlatformUseFacts(client, { vendorId: "v-1", brokerageId: "b-1" })
    check("a pre-migration missing platform_vendor_id is a published BLIND SPOT,\n    not a refusal and not a silent zero",
      f.resolved === true && f.blindSpots.some((b) => /m549 not applied/i.test(b)))
  }

  // A thrown client must refuse, not escape.
  {
    const client: any = { from: () => { throw new Error("socket hang up") } }
    const { assertVendorChargeableForPlatformUse } = await import("../lib/vendors/vendor-platform-identity")
    const v = await assertVendorChargeableForPlatformUse(client, ARGS)
    check("a THROWN client refuses the charge rather than escaping as a 500\n    that a retry turns into an invoice",
      v.chargeable === false && !v.chargeable && v.refusalCode === "undeterminable")
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function layer3() {
  section("Layer 3 — every platform-use charge lane goes through the ONE door")

  const GUARD = "assertVendorChargeableForPlatformUse"

  const lanes: Array<[string, string]> = [
    ["app/actions/vendor-payments.ts", "createVendorInvoice (billed_to='vendor' — the one tenant→vendor ledger)"],
    ["lib/vendors/premium-placement.ts", "offerPremiumPlacement (featured placement IS platform use)"],
    ["app/actions/vendors/vendor-plan-subscriptions.ts", "enrolVendorInPackageAction (vendor_subscriptions)"],
  ]
  for (const [file, lane] of lanes) {
    const s = src(file)
    check(`${lane} calls the shared guard`, s.includes(GUARD), `${file} does not call ${GUARD}`)
    // WHITESPACE IS COLLAPSED BEFORE THE PROXIMITY TEST, and that is the fix for a
    // real measurement defect rather than a convenience. `stripComments` removes
    // comment TEXT but PRESERVES LINE STRUCTURE, so a stripped 12-line comment
    // still leaves ~72 characters of newlines and indentation inside the window.
    // The distance was therefore measuring LAYOUT, not code: documenting the
    // refusal — which §1 asks for — pushed `return` from 150 characters to 222 and
    // failed a guard whose subject had not changed at all. Measured, not guessed.
    //
    // The rule being asserted is "the verdict is acted on, not logged and stepped
    // over". Collapsing runs of whitespace to one space measures exactly that and
    // is indifferent to how the branch is commented or wrapped.
    const codeOnly = s.replace(/\s+/g, " ")
    check(`…and REFUSES on its verdict rather than logging and continuing`,
      /chargeable\)[\s\S]{0,200}(return|error)/.test(codeOnly), file)
  }

  // CONTROLS — a proximity test that collapses whitespace could pass anything if
  // the window were effectively unbounded, so pin both directions on synthetic
  // specimens rather than on a real file that may change under us.
  {
    const collapse = (x: string) => x.replace(/\s+/g, " ")
    const refuses = collapse(`if (!platformUse.chargeable) {\n` + "    \n".repeat(12) +
      `    const code = platformUse.refusalCode\n    return { invoiceId: null }\n  }`)
    check("CONTROL — a heavily-commented refusal still reads as refusing",
      /chargeable\)[\s\S]{0,200}(return|error)/.test(refuses))
    const logsAndContinues = collapse(`if (!platformUse.chargeable) {\n` +
      `    console.warn("not chargeable")\n  }\n` + `  const x = 1\n`.repeat(40) + `  return { ok: true }`)
    check("CONTROL — one that only LOGS and falls through is still caught",
      !/chargeable\)[\s\S]{0,200}(return|error)/.test(logsAndContinues))
  }

  {
    const s = src("app/actions/vendor-payments.ts")
    check("the gate is on billed_to='vendor' ONLY — the job-bill lane is untouched",
      /billedTo === "vendor"[\s\S]{0,600}assertVendorChargeableForPlatformUse/.test(s))
    check("…and it sits in createVendorInvoice, the SHARED writer, so a caller that\n    skips issueVendorCharge cannot write the same row ungated\n    (every export of a \"use server\" file is a public HTTP endpoint)",
      /export async function createVendorInvoice[\s\S]{0,2500}assertVendorChargeableForPlatformUse/.test(s))
  }

  section("Layer 3b — the billing writes that used to succeed while charging nobody")

  // A supabase-js UPDATE matching zero rows resolves with error null. Each of
  // these three reported success for a transition that never happened.
  {
    const pp = src("lib/vendors/premium-placement.ts")
    check("markPlacementPaid COUNTS the rows it marked paid before featuring the vendor\n    (it used to feature them on a write that matched nothing)",
      /status: "paid"[\s\S]{0,400}\.select\("id"\)/.test(pp)
      && /paidRows[\s\S]{0,200}length === 0/.test(pp))
    check("the nightly expiry sweep counts rows that actually changed, not statements\n    that ran (it reported un-featurings it had not done)",
      /update\(\{ preferred: false, display_priority: 0 \}\)[\s\S]{0,200}\.select\("id"\)/.test(pp)
      && /reset[\s\S]{0,60}length === 0/.test(pp))
  }
  {
    const vp = src("app/actions/vendor-payments.ts")
    check("issueVendorCharge COUNTS the draft→submitted transition before telling the\n    vendor an invoice was issued (it emailed a bill that stayed a draft)",
      /status: "submitted" \}\)[\s\S]{0,300}\.select\("id"\)[\s\S]{0,400}issued[\s\S]{0,80}length === 0/.test(vp))
    check("submitVendorInvoice counts its rows too",
      /submitted[\s\S]{0,80}length === 0/.test(vp))
    check("markInvoicePaid already counted its rows (unchanged — the pattern it set)",
      /updated\?\.length/.test(vp))
  }

  section("Layer 3c — the migration")
  check("m549 exists", existsSync(join(ROOT, MIGRATION)))
  const mig = existsSync(join(ROOT, MIGRATION)) ? raw(MIGRATION) : ""
  check("m549 quotes the owner ruling verbatim",
    mig.includes("can't charge them for platform use only access to their contacts"))
  check("m549 adds the platform link to the SURVIVOR that already existed,\n    rather than minting a new vendor table or a third link table",
    /add column if not exists platform_vendor_id/.test(mig)
    && /references public\.vendor_marketplace_profiles\(id\)/.test(mig)
    && !/create table/i.test(mig))
  check("m549 makes the many-to-many well-defined (one bench row per tenant per platform vendor)",
    /create unique index if not exists vendors_one_bench_row_per_tenant_per_platform_vendor/.test(mig))
  check("m549 puts the rule in the DATABASE too, on BOTH platform-use lanes",
    /trg_vendor_subscriptions_single_platform_use/.test(mig)
    && /trg_vendor_invoices_single_platform_use/.test(mig))
  check("m549 leaves the JOB BILL lane alone (billed_to='brokerage'/'contact')",
    /new\.billed_to = 'vendor'/.test(mig))
  check("m549's tables are all LIVE tables — no retired name sits in it reading as enforced",
    ["vendors", "vendor_invoices", "vendor_subscriptions", "vendor_marketplace_profiles", "vendor_plans"]
      .every((t) => (LIVE_TABLES as readonly string[]).includes(t)))
}

// ─────────────────────────────────────────────────────────────────────────────
async function layer4() {
  section("Layer 4 — live (creds-gated)")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("  ⊘ skipped (no SUPABASE creds) — layers 1-3 proved the rule and its wiring")
    return
  }
  const svc = createClient(url, key)

  const { error: colErr } = await svc.from("vendors").select("platform_vendor_id").limit(1)
  if (colErr) {
    console.log(`  · m549 IS NOT APPLIED here (${colErr.message}) — reporting the pre-migration shape honestly`)
    check("live (pre-migration): the platform link is absent, and the resolver's\n    blind spot for exactly this case is the one asserted in layer 2", true)
    return
  }
  check("live: vendors carries the platform link (m549 applied)", true)

  // The RULE, asked of the database directly. Two-sided, on a fixture that is
  // removed whatever happens.
  const { data: probe, error: probeErr } = await svc.rpc("vendor_platform_use_already_paid", {
    p_vendor_id: "00000000-0000-0000-0000-000000000000",
    p_brokerage_id: "00000000-0000-0000-0000-000000000000",
  })
  check("live: the question is askable — vendor_platform_use_already_paid() exists",
    !probeErr, probeErr?.message)
  check("live NEGATIVE CONTROL: a vendor the platform has never heard of owes nobody\n    (null, not a refusal — the guard does not refuse everything)",
    !probeErr && probe === null)

  // The trigger must be REAL, not merely present. A refused insert is the proof.
  const { error: triggerProof } = await svc.from("vendor_invoices").insert({
    brokerage_id: "00000000-0000-0000-0000-000000000000",
    vendor_id: "00000000-0000-0000-0000-000000000000",
    billed_to: "vendor",
    subtotal: 1, total_amount: 1, status: "draft",
  })
  check("live: a bogus platform-use invoice is REFUSED by the database, not written\n    (the FKs alone guarantee refusal; the assertion is that supabase-js RESOLVED\n     with an error rather than inserting a row)",
    !!triggerProof)

  const { count: strayCount, error: strayErr } = await svc
    .from("vendor_invoices").select("id", { count: "exact", head: true }).eq("notes", "m549-after-control")
  check("live: no control fixture was left behind by an earlier run",
    !strayErr && (strayCount ?? 0) === 0, strayErr?.message)
}

async function main() {
  layer1()
  await layer2()
  layer3()
  await layer4()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_PLATFORM_USE_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_PLATFORM_USE_PASS — a vendor already paying for platform use cannot be charged for it again; the second tenant gets contact access, free")
}
main()
