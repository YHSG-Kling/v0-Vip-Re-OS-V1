#!/usr/bin/env tsx
/**
 * scripts/vendor-placement-delivery-simulator.ts (npm run test:vendor-placement-delivery)
 * ─────────────────────────────────────────────────────────────────────────────
 * A VENDOR PAID FOR PLACEMENT AND THE PLACEMENT NEVER APPEARED.
 *
 * lib/vendors/premium-placement.ts is a MONETIZATION path: a brokerage charges a
 * vendor for featured placement (offer → vendor_invoices → mark paid → flip the
 * vendor_directory row preferred + display_priority + visible_in_portal →
 * nightly sweep un-features it when the paid term lapses). Its header says those
 * flags are "surfaced on the Vendors page Preferred tab / contact portal".
 *
 * They were not. A previous burn-down called vendor_directory a "writer-less
 * legacy twin" and repointed the consumer-facing readers onto `vendors`, which
 * has none of those columns. premium-placement IS its writer, so that premise
 * was false — and lib/vendor-marketplace/resolve-contact-vendors.ts ended up
 * carrying the full vendor_directory docstring above a body that read `vendors`
 * and hardcoded every curation field:
 *
 *     preferred: null, audience_tags: [], stage_tags: [],
 *     display_priority: null, visible_in_portal: true
 *
 * Four things went quiet at once:
 *   1. REVENUE     — paid placement collected, flipped, swept, never rendered.
 *   2. COMPLIANCE  — resolveVendorDisclosure() picks the RESPA notice from
 *                    `preferred`; permanently false means the preferred_general
 *                    disclosure (business-relationship transparency for a
 *                    NON-regulated featured vendor) could never fire. Settlement
 *                    categories were unaffected — that branch keys on category.
 *   3. CURATION    — audience_tags/stage_tags stubbed to [] match EVERYTHING, so
 *                    persona + lifecycle targeting did nothing.
 *   4. VISIBILITY  — visible_in_portal stubbed true: a broker could not hide a
 *                    vendor from clients at all.
 *
 * m303 gives vendor_directory a real vendor_id FK so the two tables can be
 * joined instead of guessed at by (name, category) — a match that could never be
 * reliable anyway, because the two category CHECKs disagreed. m304 then widened
 * the bench onto the directory's 38-value taxonomy, so they now share ONE
 * vocabulary and 32 trades became bookable for the first time.
 *
 * VERIFIED LIVE against seeded rows: two curated stagers (one paid+preferred at
 * rating 3.0, one hidden) plus one uncurated 5.0 vendor. The paid vendor
 * surfaced, outranked the higher-rated non-paid vendor, the hidden row was
 * excluded, and preferred=true reached the disclosure resolver. Probe rows
 * deleted; both tables back to their prior counts.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
const src = (p: string) => raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

console.log("══════════════════════════════════════════════════")
console.log(" Vendor placement delivery — what was paid for is what is shown")
console.log("══════════════════════════════════════════════════")

console.log("\n── the two tables are linked for real (m303) ──")
{
  const mig = raw("supabase/migrations/m303-vendor-directory-fk.sql")
  check("the migration adds the FK", /ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES vendors\(id\)/.test(mig))
  check("…and back-fills existing rows once, rather than matching on every read",
    /UPDATE vendor_directory d[\s\S]*?SET vendor_id = v\.id/.test(mig))
  check("…and stops one bench vendor being curated twice per brokerage",
    /CREATE UNIQUE INDEX[\s\S]*?ux_vendor_directory_brokerage_vendor/.test(mig))
  const snap = raw("scripts/schema-snapshot.ts")
  const m = snap.match(/^  vendor_directory: \[(.*?)\],$/m)
  check("the snapshot tracks vendor_id (the drift guard sees it)", !!m && m[1].includes('"vendor_id"'))
}

console.log("\n── the resolver reads the curation it documents ──")
{
  const r = src("lib/vendor-marketplace/resolve-contact-vendors.ts")
  check("it reads vendor_directory", /from\("vendor_directory"\)/.test(r))
  check("…joined to the bench through the FK", /vendors!inner\(/.test(r) && /\.not\("vendor_id", "is", null\)/.test(r))
  check("…and only surfaces vendors the broker still approves", /\.eq\("vendors\.status", "active"\)/.test(r))
  check("portal visibility is honoured — a hidden vendor stays hidden",
    /\.neq\("visible_in_portal", false\)/.test(r))

  // The bug was not a missing query — it was these five literals.
  check("preferred is no longer hardcoded null in the curated path",
    !/preferred:\s*null,\s*\n\s*team_id/.test(r))
  check("audience_tags / stage_tags come from the row, not []",
    /audience_tags:\s*Array\.isArray\(d\.audience_tags\)/.test(r)
    && /stage_tags:\s*Array\.isArray\(d\.stage_tags\)/.test(r))
  check("display_priority comes from the row", /display_priority:\s*d\.display_priority/.test(r))

  // Booking FKs to vendors(id); a directory id here would break it.
  check("the returned id is the BENCH id, so portal booking still works",
    /id:\s*v\.id as string/.test(r))

  check("an uncurated brokerage still gets its approved bench (honest fallback)",
    /from\("vendors"\)/.test(r) && /\.eq\("status", "active"\)/.test(r))
}

console.log("\n── one resolver, so the two portal surfaces cannot disagree ──")
{
  const pl = src("app/actions/portal-lifetime.ts")
  check("the lifetime toolkit routes through the shared resolver",
    /resolveContactVendors/.test(pl))
  check("…and no longer runs its own vendors query for portal vendors",
    !/from\("vendors"\)[\s\S]{0,200}?\.eq\("status", "active"\)[\s\S]{0,200}?order\("rating"/.test(pl))
  const pv = src("app/portal/[contactId]/vendors/page.tsx")
  check("the portal vendors page uses the same resolver", /resolveContactVendors/.test(pv))
}

console.log("\n── the compliance input is real again ──")
{
  const respa = src("lib/compliance/vendor-respa.ts")
  check("the disclosure resolver still keys preferred_general off `preferred`",
    /if \(input\.preferred\)[\s\S]{0,120}?type: "preferred_general"/.test(respa))
  check("…and a REGULATED category discloses regardless of the flag (unchanged)",
    /if \(regulated\)[\s\S]{0,120}?type: "preferred_settlement"/.test(respa))
  const pv = src("app/portal/[contactId]/vendors/page.tsx")
  check("the portal passes the resolved preferred through", /preferred: !!v\.preferred/.test(pv))
}

console.log("\n── the paid path still writes what the reader now reads ──")
{
  const pp = src("lib/vendors/premium-placement.ts")
  check("markPlacementPaid flips preferred + display_priority + visible_in_portal",
    /preferred: true/.test(pp) && /display_priority: PLACEMENT_DISPLAY_PRIORITY/.test(pp) && /visible_in_portal: true/.test(pp))
  check("the expiry sweep un-features a lapsed term",
    /update\(\{ preferred: false, display_priority: 0 \}\)/.test(pp))
}

console.log("\n── ONE TAXONOMY, BOTH TABLES (m304) ──")
{
  // The bench admitted 6 Title-Case values while the directory described 38
  // lowercase ones. `vendors` is the FK target of vendor_bookings, so a trade the
  // bench could not SPELL was a trade the platform could not BOOK — the
  // marketplace was capped at six trades by a CHECK nobody had revisited. m304
  // widened the bench to the directory's taxonomy verbatim.
  const bench = CHECK_VOCABULARIES.vendors?.category ?? []
  const dir = CHECK_VOCABULARIES.vendor_directory?.category ?? []
  check("both vocabularies are known", bench.length > 0 && dir.length > 0)
  check(`they are now the SAME ${bench.length}-value taxonomy`,
    bench.length === dir.length && bench.every((b) => dir.includes(b)))
  check("the long tail a lifetime client actually asks for is bookable",
    ["photographer", "landscaping", "hvac", "plumber", "roofer", "solar", "tax_pro"]
      .every((c) => bench.includes(c)))

  // THE CASE TRAP. This module's own header records the last time this
  // vocabulary moved: three panels queried lowercase against a Title-Case column
  // and matched zero rows forever. TypeScript cannot catch it — the argument to
  // .eq() is a plain string — so it is checked here instead.
  const CATEGORY_QUERY_FILES = [
    "lib/agents/brokerage-context.ts", "lib/kernel/financing-pit-stop.ts",
    "lib/kernel/fire-drills.ts", "app/title/dashboard/page.tsx",
    "app/dashboard/partners/components/os/lender-status-panel.tsx",
    "app/dashboard/partners/components/os/title-pipeline-panel.tsx",
  ]
  for (const f of CATEGORY_QUERY_FILES) {
    check(`${f}: no hardcoded Title-Case category literal`,
      !/category["']\s*,\s*["'][A-Z]/.test(src(f)))
  }
  check("the FK keeps the join independent of category spelling anyway",
    /vendors!inner\(/.test(src("lib/vendor-marketplace/resolve-contact-vendors.ts")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VENDOR_PLACEMENT_DELIVERY_FAIL"); process.exit(1) }
console.log(" ✅ VENDOR_PLACEMENT_DELIVERY_PASS — paid placement reaches the consumer")
