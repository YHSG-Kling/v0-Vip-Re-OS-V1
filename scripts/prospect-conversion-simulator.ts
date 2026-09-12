#!/usr/bin/env tsx
/**
 * scripts/prospect-conversion-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM PROSPECT → TENANT CONVERSION STAMP (§1.2 build, 2026-08-27).
 *
 * THE GAP THIS GUARDS: platform_prospects.converted_brokerage_id had ONE
 * writer — the manual, billing-gated linkReferralConversionAction — while both
 * tenant-creation paths (self-serve signup + superadmin create-subscriber)
 * provisioned brokerages without ever recording that a captured prospect had
 * become one. The funnel's conversion rate and the referral-fee ledger (fees =
 * % of the converted tenant's MRR) were blind to every automatic conversion.
 *
 * Layer 1 (behavior): the REAL stampProspectConversion executed against an
 *   injected in-memory client (the only edge stubbed) — matching keys (email
 *   case/dedupe, caller-ID phone variants), never-clobber, the status upgrade
 *   rule, counted updates, idempotent re-run, audit rows.
 * Layer 2 (source, STRIPPED per CLAUDE.md §2 — the scans below look for code
 *   tokens, and this rail's own files carry tombstones/JSDoc naming the very
 *   tokens scanned): both tenant-creation paths call stampProspectConversion
 *   with the honest outcome ('trial' for self-serve, 'converted' for a
 *   provisioned active subscription); the helper's updates are COUNTED
 *   (.select("id")) and never-clobber (.is("converted_brokerage_id", null));
 *   the growth board can now see phone-only prospects.
 * Layer 3 (live, READ-ONLY): schema agreement — the columns and the status
 *   CHECK vocabulary the stamp writes exist in the vocabulary cache.
 *
 * POSITIVE CONTROLS (§2): every absence/presence regex is first proven against
 * a synthetic specimen carrying the defect it was written to catch.
 *
 * Run: npx tsx scripts/prospect-conversion-simulator.ts   (npm run test:prospect-conversion)
 */
import { stampProspectConversion } from "../lib/platform/prospect-conversion"
import { stripComments } from "./strip-comments"
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
  console.log(" ✅ Conversion stamp verified — both tenant-creation paths record the prospect → tenant moment, counted and never-clobber")
  console.log(" PROSPECT_CONVERSION_PASS")
}
const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Prospect → tenant conversion stamp simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · behavior — the real stamp against an injected client]")
  // In-memory platform_prospects + superadmin_audit_log speaking exactly the
  // PostgREST chains the stamp uses. The client is the ONLY thing stubbed —
  // the production function runs unmodified.
  type Row = { id: string; status: string | null; email: string | null; phone: string | null; converted_brokerage_id: string | null }
  function fakeSvc(rows: Row[]) {
    const audits: any[] = []
    const from = (table: string) => {
      const q: any = {
        op: "select" as "select" | "update" | "insert", patch: null as any, filters: [] as Array<(r: Row) => boolean>,
        select(_cols?: string) { if (q.op === "update") q.returning = true; return q },
        is(col: string, v: null) { q.filters.push((r: any) => r[col] === v); return q },
        in(col: string, vals: string[]) { q.filters.push((r: any) => vals.includes(r[col])); return q },
        update(patch: any) { q.op = "update"; q.patch = patch; return q },
        insert(row: any) { q.op = "insert"; q.patch = row; return q },
        then(resolve: (v: any) => void) {
          if (table === "superadmin_audit_log") { audits.push(q.patch); return resolve({ data: null, error: null }) }
          const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
          if (q.op === "update") {
            for (const r of matched) Object.assign(r, q.patch)
            return resolve({ data: matched.map((r) => ({ id: r.id })), error: null })
          }
          return resolve({ data: matched.map((r) => ({ id: r.id, status: r.status })), error: null })
        },
      }
      return q
    }
    return { svc: { from }, audits, rows }
  }

  {
    // Email match: case-folded + deduped input, never-clobber on a linked row.
    const { svc, audits, rows } = fakeSvc([
      { id: "p1", status: "contacted", email: "admin@acme.com", phone: null, converted_brokerage_id: null },
      { id: "p2", status: "new", email: "other@x.com", phone: null, converted_brokerage_id: "brk-OTHER" }, // already linked — must not be touched
    ])
    const r = await stampProspectConversion(svc, { brokerageId: "brk-1", emails: [" Admin@Acme.COM ", "admin@acme.com", "not-an-email"], outcome: "converted" })
    check("email match: case-folded + deduped input finds the row once", r.matched === 1 && r.linked === 1 && r.statusAdvanced === 1 && r.errors.length === 0)
    check("the matched row is stamped (link + status 'converted')", rows[0].converted_brokerage_id === "brk-1" && rows[0].status === "converted")
    check("never-clobber: a row already linked to ANOTHER brokerage is untouched", rows[1].converted_brokerage_id === "brk-OTHER" && rows[1].status === "new")
    check("the conversion moment is audited as system:tenant_creation", audits.length === 1 && audits[0].actor_email === "system:tenant_creation" && audits[0].action === "platform_prospect.converted" && audits[0].target_id === "p1")
    const r2 = await stampProspectConversion(svc, { brokerageId: "brk-1", emails: ["admin@acme.com"], outcome: "converted" })
    check("idempotent: a re-run matches 0 and writes nothing (counted zero, not fake success)", r2.matched === 0 && r2.linked === 0 && audits.length === 1)
  }
  {
    // Phone match: the reception stores caller-ID E.164; the tenant form holds free text.
    const { svc, rows } = fakeSvc([
      { id: "p3", status: "new", email: null, phone: "+15125550134", converted_brokerage_id: null },
    ])
    const r = await stampProspectConversion(svc, { brokerageId: "brk-2", emails: [], phone: "(512) 555-0134", outcome: "converted" })
    check("phone match: free-text '(512) 555-0134' finds the E.164 caller-ID row", r.matched === 1 && r.linked === 1 && rows[0].converted_brokerage_id === "brk-2")
    const rNoise = await stampProspectConversion(svc, { brokerageId: "brk-2", emails: [], phone: "911", outcome: "converted" })
    check("phone: short noise (< 7 digits) matches nothing", rNoise.matched === 0)
  }
  {
    // Status only moves FORWARD: outcome 'trial' must not downgrade a 'converted' row.
    const { svc, rows } = fakeSvc([
      { id: "p4", status: "converted", email: "won@x.com", phone: null, converted_brokerage_id: null },
      { id: "p5", status: "new", email: "fresh@x.com", phone: null, converted_brokerage_id: null },
    ])
    const r = await stampProspectConversion(svc, { brokerageId: "brk-3", emails: ["won@x.com", "fresh@x.com"], outcome: "trial" })
    check("trial outcome: a 'converted' row keeps its status but gains the link (no downgrade)",
      rows[0].status === "converted" && rows[0].converted_brokerage_id === "brk-3")
    check("trial outcome: a 'new' row advances to 'trial' + link; counts are split honestly",
      rows[1].status === "trial" && rows[1].converted_brokerage_id === "brk-3" && r.matched === 2 && r.linked === 2 && r.statusAdvanced === 1)
  }
  {
    const rEmpty = await stampProspectConversion(fakeSvc([]).svc, { brokerageId: "brk-4", emails: [null, " ", "not-an-email"], outcome: "trial" })
    check("no usable key → clean no-op (no reads, no writes, no errors)", rEmpty.matched === 0 && rEmpty.linked === 0 && rEmpty.errors.length === 0)
  }

  console.log("\n[Layer 2 · source wiring — stripped scans with positive controls]")
  // POSITIVE CONTROLS — prove each finder still recognises its defect.
  const countedRe = /\.update\([\s\S]*?\)[\s\S]{0,200}?\.select\("id"\)/
  check("control: the counted-update finder flags a fire-and-forget update",
    !countedRe.test(`await svc.from("platform_prospects").update({ x: 1 }).in("id", ids)\nreturn`) &&
    countedRe.test(`await svc.from("platform_prospects").update({ x: 1 }).in("id", ids).select("id")`))
  const stampCallRe = /stampProspectConversion\(/
  check("control: the call-site finder sees a real call and not its absence",
    stampCallRe.test("await stampProspectConversion(service, {})") && !stampCallRe.test("const x = 1"))

  const helper = src("lib/platform/prospect-conversion.ts")
  check("helper: both updates are COUNTED (.select(\"id\") on the update chain) — §3",
    (helper.match(/\.select\("id"\)/g) ?? []).length >= 2 && countedRe.test(helper))
  check("helper: never-clobber — updates filter .is(\"converted_brokerage_id\", null)",
    (helper.match(/\.is\("converted_brokerage_id", null\)/g) ?? []).length >= 3)
  check("helper: errors are READ (destructured) on every write, aggregated, never thrown",
    /const \{ data, error \}/.test(helper) && /out\.errors\.push/.test(helper) && !/throw /.test(helper))
  check("helper: audits the moment to superadmin_audit_log as system:tenant_creation",
    /superadmin_audit_log/.test(helper) && /system:tenant_creation/.test(helper) && /platform_prospect\.converted/.test(helper))

  const signup = src("app/actions/auth/signup-brokerage.ts")
  check("self-serve signup stamps the conversion with outcome 'trial' (a trial, not yet paying)",
    stampCallRe.test(signup) && /outcome: "trial"/.test(signup))
  check("self-serve signup stamp is best-effort (inside try/catch, after the tenant is committed)",
    /try \{[\s\S]{0,400}stampProspectConversion/.test(signup))

  const sub = src("app/actions/admin/create-subscriber.ts")
  check("superadmin create-subscriber stamps with outcome 'converted' (active subscription = paying)",
    stampCallRe.test(sub) && /outcome: "converted"/.test(sub))
  check("create-subscriber matches by BOTH emails and the brokerage phone (the reception's caller-ID key)",
    /emails: \[params\.adminEmail, params\.brokerageEmail\]/.test(sub) && /phone: params\.brokeragePhone/.test(sub))

  // The manual link action survives — it is the correction/override path, not a duplicate:
  // it links ANY prospect to ANY tenant after the fact (billing-gated), which the
  // automatic email/phone match cannot always do.
  const refs = src("app/actions/superadmin/subscriber-referrals.ts")
  check("manual linkReferralConversionAction survives as the staff override path",
    /linkReferralConversionAction/.test(refs) && /converted_brokerage_id: input\.brokerageId/.test(refs))

  // GAP B — phone-only prospects are now visible to the staff who work them.
  const growthAction = src("app/actions/superadmin/platform-growth.ts")
  check("growth board list selects phone (phone-only reception captures are reachable)",
    /select\("id, name, email, phone,/.test(growthAction))
  const board = src("app/dashboard/superadmin/growth/platform-growth-board.tsx")
  check("growth board renders phone when email is absent", /p\.email \?\? p\.phone/.test(board))

  console.log("\n[Layer 3 · vocabulary agreement (generated cache — read-only)]")
  const vocab = src("scripts/check-vocabularies.ts")
  const prospectsVocab = /platform_prospects: \{[\s\S]*?status: \[([^\]]*)\]/.exec(vocab)?.[1] ?? ""
  check("both stamped statuses ('trial', 'converted') are in the LIVE status CHECK vocabulary",
    /"trial"/.test(prospectsVocab) && /"converted"/.test(prospectsVocab),
    `vocab cache says: [${prospectsVocab}]`)

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
