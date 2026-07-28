#!/usr/bin/env tsx
/**
 * scripts/vendor-category-consolidation-simulator.ts   (npm run test:vendor-categories) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE SPELLING FOR vendors.category.
 *
 * The live CHECK is Title Case, and the title category is TWO WORDS:
 *
 *   CHECK (category = ANY (ARRAY['Contractor','Inspector','Lender',
 *                                'Other','Stager','Title Company']))
 *
 * Three partner-facing surfaces asked for it in lowercase:
 *
 *   app/dashboard/partners/components/os/lender-status-panel.tsx   eq(category,'lender')
 *   app/dashboard/partners/components/os/title-pipeline-panel.tsx  eq(category,'title')
 *   app/title/dashboard/page.tsx                                   eq(category,'title')
 *
 * Postgres compares strings case-sensitively. Measured live with two probe
 * vendors ('Lender' and 'Title Company', both active):
 *
 *   eq(category,'lender')        → 0        eq(category,'Lender')        → 1
 *   eq(category,'title')         → 0        eq(category,'Title Company') → 1
 *
 * So the broker's lender panel reported 0 lenders on a bench that had them, the
 * title pipeline panel reported 0 title companies, and the title partner's OWN
 * dashboard could not confirm its vendor row was a title company — it fell
 * through to the not-a-title-partner branch and showed the visitor nothing.
 *
 * AND THE VOCABULARY WAS COPIED FIVE TIMES, each subtly different — one with five
 * values, one with six, one as a Set, one as a lone constant with a comment
 * claiming the column is free text, one as an inline union in a return type.
 * lib/kernel/vendor-categories.ts is the single copy now, and all five import it.
 */
import { readFileSync } from "node:fs"
import {
  VENDOR_CATEGORIES,
  BENCH_VENDOR_CATEGORIES,
  VENDOR_CATEGORY_LENDER,
  VENDOR_CATEGORY_TITLE,
  isVendorCategory,
  toVendorCategory,
} from "../lib/kernel/vendor-categories"
import { STAGE_VENDOR_NEEDS } from "../lib/kernel/vendor-coverage-forecast"
import { classifyCardTarget } from "../lib/contacts/card-classifier"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

console.log("\n── the module matches the live CHECK, exactly ──")
{
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  check(`the snapshot carries 6 categories (${live.length})`, live.length === 6)
  check("every category the module declares is admitted",
    VENDOR_CATEGORIES.every((c) => live.includes(c)))
  check("every category the CHECK admits is declared",
    live.every((c) => (VENDOR_CATEGORIES as readonly string[]).includes(c)))
  check("the title category is spelled 'Title Company', two words",
    VENDOR_CATEGORY_TITLE === "Title Company" && live.includes("Title Company"))
  check("the lender category is 'Lender', capitalised",
    VENDOR_CATEGORY_LENDER === "Lender" && live.includes("Lender"))
  check("the bench set is the vocabulary minus 'Other'",
    BENCH_VENDOR_CATEGORIES.length === VENDOR_CATEGORIES.length - 1 &&
    BENCH_VENDOR_CATEGORIES.every((c) => (VENDOR_CATEGORIES as readonly string[]).includes(c)) &&
    !(BENCH_VENDOR_CATEGORIES as readonly string[]).includes("Other"))
}

console.log("\n── case matters, and the module says so ──")
{
  check("'Lender' is a category", isVendorCategory("Lender"))
  check("'lender' is NOT — this is the whole bug", !isVendorCategory("lender"))
  check("'title' is NOT", !isVendorCategory("title"))
  check("'Title Company' is", isVendorCategory("Title Company"))
  check("null is not", !isVendorCategory(null))
  check("'' is not", !isVendorCategory(""))

  check("toVendorCategory repairs 'lender'", toVendorCategory("lender") === "Lender")
  check("toVendorCategory repairs 'title' to the two-word value",
    toVendorCategory("title") === "Title Company")
  check("toVendorCategory repairs 'escrow'", toVendorCategory("escrow") === "Title Company")
  check("toVendorCategory repairs 'mortgage'", toVendorCategory("mortgage") === "Lender")
  check("toVendorCategory is case- and space-tolerant on exact names",
    toVendorCategory("  TITLE COMPANY ") === "Title Company")
  check("toVendorCategory refuses to guess rather than mis-file a vendor",
    toVendorCategory("plumber") === null && toVendorCategory("photographer") === null)
  check("toVendorCategory on empty input is null", toVendorCategory("") === null && toVendorCategory(null) === null)
  check("everything it returns is a value the column accepts",
    ["lender", "title", "escrow", "mortgage", "Stager", "Other"]
      .map(toVendorCategory).filter(Boolean).every((c) => isVendorCategory(c as string)))
}

console.log("\n── the three partner surfaces ask in the CHECK's spelling ──")
{
  const lender = src("app/dashboard/partners/components/os/lender-status-panel.tsx")
  check("the lender panel filters on VENDOR_CATEGORY_LENDER",
    /\.eq\("category", VENDOR_CATEGORY_LENDER\)/.test(lender))
  check("the lender panel no longer asks for 'lender'", !/"category", "lender"/.test(lender))

  const title = src("app/dashboard/partners/components/os/title-pipeline-panel.tsx")
  check("the title pipeline panel filters on VENDOR_CATEGORY_TITLE",
    /\.eq\("category", VENDOR_CATEGORY_TITLE\)/.test(title))
  check("the title pipeline panel no longer asks for 'title'", !/"category", "title"/.test(title))

  const partner = src("app/title/dashboard/page.tsx")
  check("the title partner's own dashboard filters on VENDOR_CATEGORY_TITLE",
    /\.eq\('category', VENDOR_CATEGORY_TITLE\)/.test(partner))
  check("it no longer asks for 'title'", !/'category', 'title'/.test(partner))
}

console.log("\n── the five copies of the vocabulary are gone ──")
{
  const copies: Array<[string, RegExp]> = [
    ["lib/kernel/vendor-orchestration.ts", /export type VendorCategory = CanonicalVendorCategory/],
    ["lib/kernel/vendor-coverage-forecast.ts", /export type VendorCategory = BenchVendorCategory/],
    ["lib/kernel/vendor-verification.ts", /new Set<string>\(VENDOR_CATEGORIES\)/],
    ["lib/kernel/lender-linkage.ts", /export const LENDER_VENDOR_CATEGORY = VENDOR_CATEGORY_LENDER/],
    ["lib/contacts/card-classifier.ts", /category: VendorCategory \| null/],
  ]
  for (const [p, re] of copies) {
    const s = src(p)
    check(`${p} imports the one module`, re.test(s))
    check(`${p} carries no inline copy of the six values`,
      !/"Lender"\s*\|\s*"Inspector"\s*\|\s*"Title Company"/.test(s))
  }
  const linkage = src("lib/kernel/lender-linkage.ts")
  check("the stale 'vendors.category is free-text' claim is gone",
    !/free-text/.test(linkage))
}

console.log("\n── downstream consumers still speak the same spelling ──")
{
  const needed = new Set(Object.values(STAGE_VENDOR_NEEDS).flat())
  check(`every category a pipeline stage demands is a real one (${[...needed].join(", ")})`,
    [...needed].every((c) => isVendorCategory(c)))
  check("CLOSING_PREP asks for 'Title Company', not 'title'",
    STAGE_VENDOR_NEEDS.CLOSING_PREP?.[0] === VENDOR_CATEGORY_TITLE)

  // The business-card classifier files a scanned card straight into vendors.category.
  const cards: Array<[string, string]> = [
    ["Senior Loan Officer, NMLS #12345", "Lender"],
    ["Certified Home Inspector", "Inspector"],
    ["Escrow Officer, Lone Star Title", "Title Company"],
    ["Licensed General Contractor", "Contractor"],
    ["Home Staging & Interior Design", "Stager"],
    // Every one of these is a STEM that a trailing \b used to reject, so the card
    // fell through to the CRM contact path instead of the vendor book.
    ["Real Estate Photographer", "Other"],
    ["Landscaping & Grounds", "Other"],
    ["Certified Residential Appraiser", "Other"],
    ["Roofing Specialist", "Contractor"],
    ["Master Electrician", "Contractor"],
    ["Kitchen Remodeling", "Contractor"],
    ["Interior Designer", "Stager"],
  ]
  for (const [title, expected] of cards) {
    const cls = classifyCardTarget({ title, company: null })
    check(`a card reading "${title}" files as ${expected}`,
      cls.target === "vendor" && cls.category === expected && isVendorCategory(cls.category))
  }
  check("a fellow agent's card is never filed as a vendor",
    classifyCardTarget({ title: "REALTOR®, Broker Associate", company: null }).category === null)
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VENDOR_CATEGORY_FAIL"); process.exit(1) }
console.log(" ✅ VENDOR_CATEGORY_PASS — one spelling, and the partner panels can see their own bench")
