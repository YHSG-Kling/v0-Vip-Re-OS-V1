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
 * m303 gave vendor_directory a real vendor_id FK so the two tables could be
 * joined instead of guessed at by (name, category). m304 widened the bench onto
 * the directory's 38-value taxonomy, so they shared ONE vocabulary and 32 trades
 * became bookable for the first time.
 *
 * m355 FINISHED IT: the two tables are one. Keeping a second row per vendor and
 * reconciling it was itself the drift — the reconciler was a symptom. The six
 * curation columns moved onto `vendors`, vendor_directory was dropped, and the
 * placement invoice's vendor_id (which had been a directory id, invisible to the
 * vendor's own invoice page and unjoinable on the platform console) was remapped
 * and given the FK that makes the class impossible.
 *
 * So the assertions below check the SAME properties against ONE table. What was
 * "the curated branch reads the directory and the fallback reads the bench" is
 * now "there is one read". The behavioural delta is recorded honestly in the
 * resolver: the old fallback ignored visible_in_portal; there is no fallback now,
 * so a hidden vendor is hidden for every brokerage.
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

console.log("\n── ONE VENDOR SYSTEM (m355) ──")
{
  const mig = raw("supabase/migrations/m355-one-vendor-system.sql")
  check("the placement columns move onto the vendor row",
    ["preferred", "display_priority", "visible_in_portal", "audience_tags", "stage_tags", "team_id"]
      .every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`).test(mig)))
  check("…curation is folded onto the bench row before anything is dropped",
    /UPDATE vendors v[\s\S]*?FROM vendor_directory d[\s\S]*?WHERE d\.vendor_id = v\.id/.test(mig))
  check("…an ORPHAN curation row becomes 'pending', never 'active'",
    /WHERE d\.vendor_id IS NULL/.test(mig) && /d\.notes, 'pending'/.test(mig))
  check("…the money tables are remapped off the directory id",
    /UPDATE vendor_invoices i[\s\S]*?SET vendor_id = d\.vendor_id/.test(mig)
    && /UPDATE vendor_earnings e[\s\S]*?SET vendor_id = d\.vendor_id/.test(mig)
    && /UPDATE vendor_payouts p[\s\S]*?SET vendor_id = d\.vendor_id/.test(mig))
  check("…and the FK that makes the identity mix-up impossible is added",
    /vendor_invoices_vendor_id_fkey[\s\S]*?REFERENCES vendors\(id\)/.test(mig))
  check("the second table is dropped WITHOUT cascade (a silent dependency must fail loudly)",
    /DROP TABLE vendor_directory;/.test(mig) && !/DROP TABLE vendor_directory CASCADE/.test(mig))
  check("a GLOBAL vendor cannot be sold placement — one tenant's purchase must not move every tenant's portal",
    /vendors_global_not_curated/.test(mig))
  check("…and tenant writes stop crossing into global rows",
    /CREATE POLICY vendors_tenant_update[\s\S]*?USING \(brokerage_id = current_user_brokerage_id\(\)\)/.test(mig))

  const snap = raw("scripts/schema-snapshot.ts")
  check("the snapshot no longer tracks a second vendor table", !/^  vendor_directory: \[/m.test(snap))
  const m = snap.match(/^  vendors: \[(.*?)\],$/m)
  check("…and vendors carries the placement columns (the drift guard sees them)",
    !!m && ["preferred", "display_priority", "visible_in_portal", "audience_tags", "stage_tags", "team_id"]
      .every((c) => m[1].includes(`"${c}"`)))
}

console.log("\n── the resolver reads the curation it documents ──")
{
  const r = src("lib/vendor-marketplace/resolve-contact-vendors.ts")
  check("it reads the ONE vendor table", /from\("vendors"\)/.test(r))
  check("…and there is no second one left to fork on", !/vendor_directory/.test(r))
  check("…only surfacing vendors the broker still approves", /\.eq\("status", "active"\)/.test(r))
  check("portal visibility is honoured — a hidden vendor stays hidden, with no fallback that ignores it",
    /\.neq\("visible_in_portal", false\)/.test(r))

  // The original bug was not a missing query — it was five hardcoded literals.
  check("preferred is read from the row, not hardcoded null",
    /preferred:\s*r\.preferred/.test(r))
  check("audience_tags / stage_tags come from the row, not []",
    /audience_tags:\s*Array\.isArray\(r\.audience_tags\)/.test(r)
    && /stage_tags:\s*Array\.isArray\(r\.stage_tags\)/.test(r))
  check("display_priority comes from the row", /display_priority:\s*r\.display_priority/.test(r))

  // Booking FKs to vendors(id) — now the only vendor id there is.
  check("the returned id is the vendors id, so portal booking still works",
    /id:\s*r\.id as string/.test(r))
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
  check("…on the vendor row itself — there is no curation row to mint or reconcile",
    /\.from\("vendors"\)/.test(pp) && !/vendor_directory/.test(pp)
    && !/ensureDirectoryEntryForVendor/.test(pp))

  // THE IDENTITY FIX. The placement invoice used to anchor on a directory id in
  // a column every other writer fills with a vendors.id.
  check("the placement invoice anchors on the VENDOR id, like every other invoice",
    /vendor_id: vendorId,/.test(pp))
  // billed_to is not decoration: markInvoicePaid mints a vendor_earnings PAYOUT
  // CLAIM for any invoice whose billed_to is not 'vendor'. Money here flows
  // vendor -> brokerage, so the default would have credited the vendor with
  // money they owed us.
  check("…and declares the vendor as the billed party, so no payout claim is minted",
    /billed_to: "vendor"/.test(pp))
}

console.log("\n── ONE TAXONOMY, ONE TABLE (m304 widened it, m355 made it singular) ──")
{
  // The bench admitted 6 Title-Case values while the directory described 38
  // lowercase ones. `vendors` is the FK target of vendor_bookings, so a trade the
  // bench could not SPELL was a trade the platform could not BOOK — the
  // marketplace was capped at six trades by a CHECK nobody had revisited. m304
  // widened the bench to the directory's taxonomy verbatim.
  const bench = CHECK_VOCABULARIES.vendors?.category ?? []
  check("the taxonomy is known", bench.length === 38)
  // Asserted as ABSENCE, not equality: `?? []` on a removed key would make an
  // equality check pass vacuously — a false green is worse than no check.
  check("there is no second vendor trade taxonomy to drift from",
    (CHECK_VOCABULARIES as any).vendor_directory === undefined)
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
  // There is no cross-table join left to be spelling-dependent — the row is one row.
  check("the resolver needs no join at all now",
    !/!inner\(/.test(src("lib/vendor-marketplace/resolve-contact-vendors.ts")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VENDOR_PLACEMENT_DELIVERY_FAIL"); process.exit(1) }
console.log(" ✅ VENDOR_PLACEMENT_DELIVERY_PASS — paid placement reaches the consumer")
