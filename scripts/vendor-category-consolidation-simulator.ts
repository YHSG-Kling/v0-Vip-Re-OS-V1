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
  VENDOR_CATEGORY_LABELS,
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
  check(`the snapshot carries the widened taxonomy (${live.length})`, live.length === 38)
  check("every category the module declares is admitted",
    VENDOR_CATEGORIES.every((c) => live.includes(c)))
  check("every category the CHECK admits is declared",
    live.every((c) => (VENDOR_CATEGORIES as readonly string[]).includes(c)))
  // m304 made the bench and directory taxonomies equal; m355 removed the second
  // table entirely, so the property to prove is that no second one came back.
  // `?? []` would have made the old equality check pass VACUOUSLY once the
  // directory key disappeared — a false green — so this asserts absence directly.
  check("there is no second vendor category vocabulary to drift from (m355)",
    (CHECK_VOCABULARIES as any).vendor_directory === undefined)
  check("the title category is the single token 'title'",
    VENDOR_CATEGORY_TITLE === "title" && live.includes("title"))
  check("the lender category is 'lender'",
    VENDOR_CATEGORY_LENDER === "lender" && live.includes("lender"))
  check("every label maps to a real category and vice versa",
    Object.keys(VENDOR_CATEGORY_LABELS).length === VENDOR_CATEGORIES.length &&
    VENDOR_CATEGORIES.every((c) => !!VENDOR_CATEGORY_LABELS[c]))
  check("the bench set is the transaction-side trades a STAGE can demand",
    BENCH_VENDOR_CATEGORIES.every((c) => (VENDOR_CATEGORIES as readonly string[]).includes(c)) &&
    !(BENCH_VENDOR_CATEGORIES as readonly string[]).includes("other") &&
    BENCH_VENDOR_CATEGORIES.length < VENDOR_CATEGORIES.length)
}

console.log("\n── case still matters — it just points the other way now ──")
{
  // Before m304 the column was Title Case and lowercase queries matched nothing.
  // The vocabulary is lowercase_snake now, so the trap is inverted: a surviving
  // Title-Case literal is the one that would match zero rows forever.
  check("'lender' is a category", isVendorCategory("lender"))
  check("'Lender' is NOT — the legacy spelling is refused", !isVendorCategory("Lender"))
  check("'Title Company' is NOT", !isVendorCategory("Title Company"))
  check("'title' is", isVendorCategory("title"))
  check("null is not", !isVendorCategory(null))
  check("'' is not", !isVendorCategory(""))

  check("toVendorCategory repairs the legacy 'Lender'", toVendorCategory("Lender") === "lender")
  check("toVendorCategory repairs the legacy 'Title Company'",
    toVendorCategory("Title Company") === "title")
  check("toVendorCategory repairs 'escrow'", toVendorCategory("escrow") === "title")
  check("toVendorCategory repairs 'mortgage'", toVendorCategory("mortgage") === "lender")
  check("toVendorCategory is case- and space-tolerant",
    toVendorCategory("  TITLE COMPANY ") === "title")
  check("the widened trades now resolve instead of returning null",
    toVendorCategory("plumber") === "plumber" && toVendorCategory("photographer") === "photographer")
  check("a space/hyphen spelling snaps to the snake token",
    toVendorCategory("Pest Control") === "pest_control" && toVendorCategory("smart-home") === "smart_home")
  check("it still refuses to guess at something unknown",
    toVendorCategory("astrologer") === null)
  check("toVendorCategory on empty input is null", toVendorCategory("") === null && toVendorCategory(null) === null)
  check("everything it returns is a value the column accepts",
    ["Lender", "Title Company", "escrow", "mortgage", "stager", "other", "plumber", "Pest Control"]
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
      !/"lender"\s*\|\s*"inspector"\s*\|\s*"title"/.test(s))
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
    ["Senior Loan Officer, NMLS #12345", "lender"],
    ["Certified Home Inspector", "inspector"],
    ["Escrow Officer, Lone Star Title", "title"],
    ["Licensed General Contractor", "contractor"],
    // Staging outranks interior design — this card is a stager who also decorates.
    ["Home Staging & Interior Design", "stager"],
    // Every one of these is a STEM that a trailing \b used to reject, so the card
    // fell through to the CRM contact path instead of the vendor book.
    //
    // They now file on the trade they NAME rather than on the nearest of six
    // values. Until m304 the column admitted six categories, so a photographer, a
    // landscaper and an electrician had nowhere to go: the first two were swept
    // into "other" and the electrician into "contractor". The information was on
    // the card and the OS threw it away. This is the payoff of the widen — the
    // bench is bookable by trade, not merely spellable.
    ["Real Estate Photographer", "photographer"],
    ["Landscaping & Grounds", "landscaping"],
    ["Roofing Specialist", "roofer"],
    ["Master Electrician", "electrician"],
    ["Interior Designer", "interior_design"],
    // Generic enough that only the family fits.
    ["Kitchen Remodeling", "contractor"],
    // Still genuinely "other": the taxonomy has no appraiser token, and pretending
    // otherwise would be worse than an honest catch-all.
    ["Certified Residential Appraiser", "other"],
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
