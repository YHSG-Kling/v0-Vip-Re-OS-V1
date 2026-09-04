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
import { join, relative } from "node:path"
// The shared walker (scripts/runtime-roots.ts:81) — never a private readdirSync
// copy; there were 82 of those and the survivor is this one.
import { walkTs } from "./runtime-roots"
// LENDERS ARE VENDORS — the survivor module for the owner's 2026-09-04 ruling.
import { isLenderVendorCategory, LENDER_BENCH_CATEGORIES } from "../lib/kernel/lender-linkage"
import {
  VENDOR_CATEGORIES,
  VENDOR_CATEGORY_LABELS,
  VENDOR_CATEGORY_SYNONYMS,
  BENCH_VENDOR_CATEGORIES,
  VENDOR_CATEGORY_LENDER,
  VENDOR_CATEGORY_TITLE,
  benchCategoryFilter,
  isVendorCategory,
  toVendorCategory,
} from "../lib/kernel/vendor-categories"
import { VENDOR_CATEGORIES as RANKING_VENDOR_CATEGORIES } from "../lib/marketing/vendor-ranking"
import { STAGE_VENDOR_NEEDS } from "../lib/kernel/vendor-coverage-forecast"
import { classifyCardTarget } from "../lib/contacts/card-classifier"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))
const ROOT = process.cwd()

console.log("\n── the module matches the live CHECK, exactly ──")
{
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  // DERIVED, NOT PINNED (CLAUDE.md §2). This read `live.length === 38` and went
  // red the day m554 added `appraiser` — not because anything broke, but because
  // the taxonomy legitimately grew and a hardcoded count could only ever be true
  // between two migrations. The RULE is that the cache and the module hold the
  // SAME list, which the two checks below already prove element by element; all
  // this one has to add is that the list is not EMPTY, since `?? []` would make
  // both of those pass vacuously against a missing key.
  check(`the snapshot carries the widened taxonomy (${live.length})`,
    live.length > 0 && live.length === VENDOR_CATEGORIES.length)
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
    // WAS "other", AND THAT WAS HONEST UNTIL m554. This fixture used to read
    // `"other"` with the note "the taxonomy has no appraiser token, and pretending
    // otherwise would be worse than an honest catch-all" — true then, false the
    // moment the owner ruled that an appraiser is a vendor type. The count that
    // moved is one card, in the direction of MORE information kept.
    ["Certified Residential Appraiser", "appraiser"],
    // The negative half of that pair: the stem must not swallow a card that only
    // MENTIONS an appraisal in passing while naming a different trade. `lender`
    // sits above `appraiser`, so a lender who orders appraisals still files as a
    // lender rather than being re-trade-d by one word.
    ["Mortgage Loan Officer — appraisal coordination", "lender"],
  ]
  for (const [title, expected] of cards) {
    const cls = classifyCardTarget({ title, company: null })
    check(`a card reading "${title}" files as ${expected}`,
      cls.target === "vendor" && cls.category === expected && isVendorCategory(cls.category))
  }
  check("a fellow agent's card is never filed as a vendor",
    classifyCardTarget({ title: "REALTOR®, Broker Associate", company: null }).category === null)
}

// ═════════════════════════════════════════════════════════════════════════════
// m561 — "consolodate service types" (owner ruling).
//
// A SECOND taxonomy called "service type" ran alongside vendors.category in four
// places, and the join between them was a SUBSTRING MATCH. Both halves of that
// were broken and both are proved below, two-sided:
//
//   MISSES     — `.ilike("category", '%${serviceType}%')` with serviceType from
//                getVendorRecommendations' ten-value union matched NOTHING for
//                eight of the ten. Measured live against vendors_category_check
//                on project hrvaqgvukzxfskkcrwbt, 2026-08-25.
//   OVER-MATCHES — `%lender%` also returns every `refinance_lender`. That is not
//                a hypothetical about a future `title_agent`: it is true of the
//                vocabulary as it stands today, and is DERIVED below rather than
//                pinned to that pair.
//
// Every assertion here derives its number from the LIVE vocabulary cache or from
// the module, never from a hardcoded count — the previous section's own comment
// records what pinning `=== 38` cost when m554 legitimately grew the list.
// ═════════════════════════════════════════════════════════════════════════════

/** Postgres `category ILIKE '%needle%'`, modelled over a vocabulary. Every token
 *  in this vocabulary is ASCII lowercase_snake, so `includes` is exact. */
const ilikeMatches = (needle: string, vocab: readonly string[]) =>
  vocab.filter((c) => c.toLowerCase().includes(needle.toLowerCase()))

/** The ten values the AI action's `serviceType` union used to admit — quoted
 *  from the deleted union so this stays a record of the defect, not a guess. */
const RETIRED_AI_SERVICE_TYPES = [
  "photography", "staging", "inspection", "appraisal", "cleaning",
  "landscaping", "repairs", "moving", "title", "escrow",
] as const

console.log("\n── m561 · the eight service types that could never match ──")
{
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  check("the live vocabulary cache is not empty (denominator for everything below)",
    live.length > 0)

  // POSITIVE CONTROL ON THE FINDER (CLAUDE.md §2). A broken `ilikeMatches` and a
  // repaired vocabulary both report zero, so prove the model still SEES matches
  // where matches exist — including the over-match that is the whole reason
  // `.ilike` was wrong.
  check("positive control · ilikeMatches still finds an exact member ('landscaping')",
    ilikeMatches("landscaping", live).length === 1)
  check("positive control · ilikeMatches still finds the OVER-match ('lender' also hits refinance_lender)",
    ilikeMatches("lender", live).length === 2 &&
    ilikeMatches("lender", live).includes("refinance_lender"))

  const dead = RETIRED_AI_SERVICE_TYPES.filter((s) => ilikeMatches(s, live).length === 0)
  const alive = RETIRED_AI_SERVICE_TYPES.filter((s) => ilikeMatches(s, live).length > 0)
  check(`the old union was ${dead.length}/${RETIRED_AI_SERVICE_TYPES.length} dead under ILIKE — ${dead.join(", ")}`,
    dead.length === 8 && alive.length === 2 &&
    alive.includes("landscaping") && alive.includes("title"))

  // …and every one of them now RESOLVES, which is the other side of the control:
  // a consolidation that merely deleted the union would show the same zero.
  for (const s of RETIRED_AI_SERVICE_TYPES) {
    const c = toVendorCategory(s)
    check(`'${s}' now resolves to a live member (${c})`,
      c !== null && live.includes(c))
  }
  check("escrow resolves to title — the ruling, not a coincidence",
    toVendorCategory("escrow") === VENDOR_CATEGORY_TITLE)
}

console.log("\n── m561 · the synonym table is a merge record, not a second vocabulary ──")
{
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  const keys = Object.keys(VENDOR_CATEGORY_SYNONYMS)
  check(`the synonym table is populated (${keys.length} retired spellings)`, keys.length > 0)
  check("every synonym RESOLVES TO a value the live CHECK admits",
    keys.every((k) => live.includes(VENDOR_CATEGORY_SYNONYMS[k])))
  // The trap this stops: a "synonym" that is itself a member would shadow a real
  // trade and silently re-file it as something else. Exact-match runs first in
  // toVendorCategory, so this can only ever be dead weight — but dead weight
  // that LOOKS like a redirect is how a taxonomy grows a second spelling again.
  check("no synonym key is itself a member of the vocabulary",
    keys.every((k) => !(live as readonly string[]).includes(k)))
  check("every synonym key is already flattened (lowercase, alphanumeric only)",
    keys.every((k) => k === k.toLowerCase().replace(/[^a-z0-9]/g, "")))
  // §1.1 — the merge happened ONTO the survivor. If a retired picker's value
  // does not resolve here, the delete happened before the merge.
  check("the retired Title-Case picker values all survive the merge",
    ["Photography", "Staging", "Inspection", "Appraisal", "Cleaning",
     "Landscaping", "Repairs", "Moving", "Title", "Escrow", "Other"]
      .every((s) => isVendorCategory(toVendorCategory(s) as string)))
  // m562 — `surveyor` WAS the honest loss, asserted here so it could not be
  // quietly "fixed" by a fold. The owner ruled it a category instead, so the
  // assertion now runs in the other direction. THE RULE IS UNCHANGED and is what
  // is actually being tested: a real trade resolves to ITSELF and is never
  // aliased onto a neighbour. Derived from the live vocabulary cache rather than
  // pinned to the word "surveyor", so this cannot rot the way the old form did
  // (CLAUDE.md §2 — do not pin an assertion to a waypoint).
  check("'surveyor' is a MEMBER and resolves to itself, not onto a neighbour",
    (live as readonly string[]).includes("surveyor") &&
    toVendorCategory("surveyor") === "surveyor" &&
    !Object.keys(VENDOR_CATEGORY_SYNONYMS).includes("surveyor"))
  // POSITIVE CONTROL on the line above: a value that is genuinely not a trade
  // must STILL resolve to null. If the fold ban had been "fixed" by making
  // toVendorCategory permissive, this goes red.
  check("a genuine non-trade still resolves to null (the fold ban still bites)",
    toVendorCategory("astrologer") === null && toVendorCategory("locksmith") === null)
}

console.log("\n── m561 · benchCategoryFilter refuses; it never matches loosely ──")
{
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  check("every live member passes the filter unchanged",
    live.length > 0 && live.every((c) => {
      const r = benchCategoryFilter(c)
      return r.ok && r.category === c
    }))
  check("every retired spelling passes the filter, normalized",
    Object.keys(VENDOR_CATEGORY_SYNONYMS).every((k) => {
      const r = benchCategoryFilter(k)
      return r.ok && r.category === VENDOR_CATEGORY_SYNONYMS[k]
    }))
  // `surveyor` was in this list until m562 made it a member; it moved to the
  // ADMITTED assertions above rather than being deleted, so the count of proven
  // refusals did not silently drop by one (CLAUDE.md §2 — a count that moves is
  // the finding). `locksmith` replaces it as the live example of a real trade
  // the taxonomy still has no token for.
  for (const bad of ["locksmith", "astrologer", "", "   ", "%", "titl"]) {
    const r = benchCategoryFilter(bad)
    check(`'${bad}' is REFUSED rather than turned into a query that cannot match`, !r.ok)
  }
  check("null / undefined are refused", !benchCategoryFilter(null).ok && !benchCategoryFilter(undefined).ok)
  const refusal = benchCategoryFilter("locksmith")
  check("the refusal names the trade the caller asked for",
    !refusal.ok && refusal.error.includes("locksmith"))
  // m562 — the value that USED to be refused here is now accepted, and the
  // filter must return it exactly rather than falling back to a LIKE or to
  // `other`. This is the assertion that would have caught a "fix" that widened
  // the CHECK but left the module behind.
  const surveyed = benchCategoryFilter("surveyor")
  check("'surveyor' now passes the filter and comes back exactly",
    surveyed.ok && surveyed.category === "surveyor")
  // A LIKE would have matched 'titl' against 'title'. Exact equality does not —
  // and this is the assertion that would go red if someone reverted to ilike.
  check("a PREFIX of a real member does not resolve ('titl' ↛ 'title')",
    !benchCategoryFilter("titl").ok)
}

console.log("\n── m561 · the substring join is gone from every bench read ──")
{
  // DENOMINATOR AND EXCLUSIONS, published beside the number (CLAUDE.md §2).
  // A repo-wide sweep of stripped app/ and lib/ sources found SEVEN
  // `category ILIKE '%…%'` bench filters. Six are asserted gone below. The
  // seventh is DELIBERATELY EXCLUDED and is not a lapse:
  //
  //   app/dashboard/transactions/[id]/page.tsx — .ilike("category", "%lender%")
  //
  // That one is not the bench-trade join. It is the LENDER IDENTITY set, and it
  // has to keep matching `refinance_lender`, because
  // lib/kernel/lender-linkage.ts :: isLenderVendorCategory deliberately does
  // (`c.includes("lender")`) — that is how a refinance lender reaches their own
  // portal. Narrowing the picker to `.eq("category","lender")` would make a
  // vendor the identity predicate RECOGNISES impossible to pick, which is a new
  // §6 defect, not a fix. It belongs to lender-linkage's lane. UNRESOLVED, and
  // named here so the six below are an honest six out of seven rather than an
  // unqualified "none left".
  // Stripped source (CLAUDE.md §2 — a tombstone is not a call site). Every file
  // below carries a tombstone that QUOTES the old `.ilike("category", …)`, so a
  // raw scan would accuse the fix of being the defect.
  const readers: Array<[string, string]> = [
    ["app/actions/vendor-marketplace.ts", src("app/actions/vendor-marketplace.ts")],
    ["app/actions/ai-vendor-management.ts", src("app/actions/ai-vendor-management.ts")],
  ]
  const ILIKE_CATEGORY = /\.ilike\(\s*["']category["']/
  const OR_ILIKE_CATEGORY = /category\.ilike\./

  for (const [name, s] of readers) {
    check(`${name} no longer filters the bench with .ilike("category", …)`,
      !ILIKE_CATEGORY.test(s))
    check(`${name} no longer builds an OR of category.ilike.% conditions`,
      !OR_ILIKE_CATEGORY.test(s))
    check(`${name} routes its service type through benchCategoryFilter`,
      /benchCategoryFilter\(/.test(s))
  }

  // POSITIVE CONTROL — an absence assertion with no proof of sight is a clean
  // bill of health from a blind guard. Both finders must still recognise the
  // exact code they were written for.
  check("positive control · the ILIKE finder still recognises the deleted call",
    ILIKE_CATEGORY.test(`.ilike("category", \`%\${params.serviceType}%\`)`) &&
    ILIKE_CATEGORY.test(`.ilike('category', '%x%')`))
  check("positive control · the OR finder still recognises the deleted condition",
    OR_ILIKE_CATEGORY.test("serviceTypes.map(st => `category.ilike.%${st}%`)"))
  // …and the finders must not fire on an unrelated ilike, or they would force
  // every future name search to be rewritten to satisfy a guard about categories.
  check("negative control · the finders ignore .ilike(\"name\", …)",
    !ILIKE_CATEGORY.test(`.ilike("name", \`%\${filters.name}%\`)`))
}

console.log("\n── m561 · a closed vocabulary cannot be searched with a substring ──")
{
  // DERIVED, NOT PINNED. The rule is "some member is a strict substring of
  // another member, therefore %x% is unsafe over this vocabulary" — not "lender
  // and refinance_lender". Adding or removing a trade cannot make this assertion
  // wrong for the wrong reason; it names whichever pairs are live today.
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  const collisions = live.flatMap((a) =>
    live.filter((b) => b !== a && b.includes(a)).map((b) => `${a}⊂${b}`))
  check(`at least one member is a strict substring of another — ${collisions.join(", ") || "(none)"}`,
    live.length > 0 && collisions.length > 0)
  check("…and an exact match is immune to every one of them",
    collisions.length > 0 && live.every((c) => {
      const r = benchCategoryFilter(c)
      return r.ok && r.category === c
    }))
}

console.log("\n── m561 · no gpt-4o call against an empty bench (CLAUDE.md §5) ──")
{
  const s = src("app/actions/ai-vendor-management.ts")
  const iFilter = s.indexOf("benchCategoryFilter(params.serviceType)")
  // Anchored on the REFUSAL, not on the variable name. The error identifier of
  // this read is deliberately `benchErr` and not `vendorsErr`, because
  // scripts/appraiser-bench-simulator.ts's M4 control mutates the FIRST
  // `const { data: vendors, error: vendorsErr }` in this file and means the one
  // in coordinateVendors — a second copy of that name up here silently stole the
  // mutation and made that control pass about a site it never touched. Anchoring
  // here on a name is how that class of collision spreads.
  const iRefusedRead = s.indexOf('"Could not read your vendor bench."')
  const iEmptyBench = s.indexOf("vendors.length === 0")
  const iModel = s.indexOf("generateObject({")
  check("all four positions were found (a -1 would make the ordering vacuous)",
    iFilter > 0 && iRefusedRead > 0 && iEmptyBench > 0 && iModel > 0)
  check("an unplaceable service type refuses BEFORE the bench is even read",
    iFilter < iRefusedRead)
  check("a REFUSED bench read refuses before the model call (supabase-js resolves refusals)",
    iRefusedRead < iModel)
  check("an EMPTY bench refuses before the model call",
    iEmptyBench < iModel)
  // The two are distinguishable — a refusal and an empty bench are different
  // situations and collapsing them is how "nobody checked" reads as "checked".
  check("the refused read and the empty bench are separate branches",
    iRefusedRead < iEmptyBench)
}

console.log("\n── m561 · the drifted second copy of the vocabulary is gone ──")
{
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  const rank = src("lib/marketing/vendor-ranking.ts")
  check("lib/marketing/vendor-ranking.ts no longer declares its own array",
    !/export const VENDOR_CATEGORIES\s*=\s*\[/.test(rank))
  check("…it re-exports the survivor instead",
    /export \{[\s\S]*?VENDOR_CATEGORIES[\s\S]*?\} from "@\/lib\/kernel\/vendor-categories"/.test(rank))
  // The real proof is at RUNTIME, not in the text: the two names must be the
  // same list. This is the assertion that was FALSE before m561 — that copy held
  // 38 values and had missed `appraiser` since m554.
  check(`the re-export is the same list as the survivor (${RANKING_VENDOR_CATEGORIES.length})`,
    RANKING_VENDOR_CATEGORIES.length === VENDOR_CATEGORIES.length &&
    VENDOR_CATEGORIES.every((c, i) => RANKING_VENDOR_CATEGORIES[i] === c))
  check("…and it matches the live CHECK, which is what the old copy stopped doing",
    live.length > 0 && live.length === RANKING_VENDOR_CATEGORIES.length &&
    (RANKING_VENDOR_CATEGORIES as readonly string[]).every((c) => live.includes(c)))
  // POSITIVE CONTROL for the drift the old copy actually had.
  check("positive control · 'appraiser' is in the live CHECK and in the re-export",
    live.includes("appraiser") &&
    (RANKING_VENDOR_CATEGORIES as readonly string[]).includes("appraiser"))
  // The marketing service-type map is a DIFFERENT vocabulary and stays that way.
  check("the package service types are still not vendor categories (two axes, one join)",
    !/professional_photos/.test(String(VENDOR_CATEGORIES)))
}

console.log("\n── m561 · both booking pickers author the CHECK, not a list of their own ──")
{
  const pickers = [
    "app/components/dashboard/listings/lifecycle/vendor-booking-button.tsx",
    "app/components/transactions/VendorBookingSection.tsx",
  ]
  const OWN_LIST = /const SERVICE_TYPES\s*=\s*\[/
  for (const p of pickers) {
    const s = src(p)
    check(`${p} carries no SERVICE_TYPES list of its own`, !OWN_LIST.test(s))
    check(`${p} renders the one control`, /<VendorCategorySelect/.test(s))
  }
  check("positive control · the SERVICE_TYPES finder still recognises the deleted list",
    OWN_LIST.test('const SERVICE_TYPES = [\n  "inspector", "appraiser",\n]'))
  // The one control is built from the groups, and the palette guard already
  // proves the groups partition VENDOR_CATEGORIES — so this only has to prove
  // the picker did not go back to spelling values itself.
  const one = src("app/components/vendors/vendor-category-select.tsx")
  check("the one control still reads VENDOR_CATEGORY_GROUPS",
    /VENDOR_CATEGORY_GROUPS/.test(one) && !OWN_LIST.test(one))
}

console.log("\n── owner ruling (2026-09-04) · LENDER IS A VENDOR CATEGORY, NOT A USER TYPE ──")
{
  // OWNER, verbatim: "lender is not a user type, it is a vendor category."
  //
  // WHY THIS BLOCK IS HERE AND NOT IN A ROLE GUARD. The two spellings of "this
  // person is a lender" were `vendors.category='lender'` and
  // `users.user_type='lender'`, and the survivor is the category — so the rule
  // belongs beside the category vocabulary it is a statement about. It also has
  // to run: scripts/role-vocabulary-guard.ts and scripts/seat-display-simulator.ts
  // are BOTH absent from `npm run guard` (measured — package.json `guard` does not
  // name test:role-vocabulary or test:seat-display), while test:vendor-categories
  // is in the chain. A proof nobody runs is not a proof.
  //
  // WHAT IT COST, so the rule is not read as tidiness: public.transactions has
  // five SELECT policies and the external-partner one is
  // `current_user_type() = 'vendor' AND vendor_has_transaction_access(id)`. A user
  // typed 'lender' matched NONE of them, and supabase-js RESOLVES a refusal, so
  // app/lender/pipeline/page.tsx rendered "0 active loans" for every lender,
  // forever, with no error anywhere.

  const liveUserTypes = CHECK_VOCABULARIES.users?.user_type ?? []
  const liveCategories = CHECK_VOCABULARIES.vendors?.category ?? []
  check("the two vocabularies are both readable (denominator for everything below)",
    liveUserTypes.length > 0 && liveCategories.length > 0)

  // ── 1 · THE SURVIVOR IS ONE MODULE, AND IT AGREES WITH THE LIVE CHECK ──────
  // DERIVED, NOT PINNED (CLAUDE.md §2): the assertion is "every member of the
  // lender bench is a value vendors.category can actually hold, and the in-memory
  // predicate accepts each of them" — not "lender and refinance_lender". Adding a
  // lender-ish trade to the taxonomy cannot make this wrong for the wrong reason.
  const bench = [...LENDER_BENCH_CATEGORIES]
  check(`the lender bench is non-empty and every member is a live vendors.category (${bench.length})`,
    bench.length > 0 && bench.every((c) => liveCategories.includes(c)))
  check("…and the in-memory predicate accepts every member of the filter list",
    bench.every((c) => isLenderVendorCategory(c)))
  check("…and the two do not disagree the other way: the predicate's own constant is on the bench",
    (bench as readonly string[]).includes(VENDOR_CATEGORY_LENDER))
  // NEGATIVE CONTROL — a predicate that says yes to everything proves nothing.
  check("negative control · the lender predicate refuses a non-lender trade",
    !isLenderVendorCategory("stager") && !isLenderVendorCategory("inspector") && !isLenderVendorCategory(""))

  // ── 2 · NOTHING RESOLVES LENDER-NESS FROM users.user_type ─────────────────
  // The rule the ruling makes enforceable. Three finders, because the duplicate
  // appeared in three shapes: a Postgres filter, an in-memory comparison, and a
  // membership array.
  //
  // STRIPPED SOURCE ONLY (CLAUDE.md §2). Every site repaired for this ruling
  // carries a tombstone that QUOTES the defect verbatim — buyer-financial.ts:512
  // quotes `.eq("user_type", "lender")` and resolve-user-role.ts:72 quotes
  // `user_type === 'lender'` — so a raw scan would accuse the fix of being the
  // defect and stay red forever while the tree was correct.
  const EQ_USER_TYPE_LENDER = /\.(?:eq|neq)\(\s*["']user_type["']\s*,\s*["']lender["']\s*\)/
  const CMP_USER_TYPE_LENDER = /(?:user_?[tT]ype)\s*[=!]==\s*["']lender["']|["']lender["']\s*[=!]==\s*(?:user_?[tT]ype)/
  const IN_USER_TYPE_LENDER = /\.in\(\s*["']user_type["']\s*,\s*\[[^\]]*["']lender["']/

  const offenders: string[] = []
  const scanned = [...walkTs(join(ROOT, "app")), ...walkTs(join(ROOT, "lib"))]
  for (const abs of scanned) {
    const rel = relative(ROOT, abs).replace(/\\/g, "/")
    const s = stripComments(readFileSync(abs, "utf8"))
    if (EQ_USER_TYPE_LENDER.test(s)) offenders.push(`${rel}: .eq("user_type","lender")`)
    if (CMP_USER_TYPE_LENDER.test(s)) offenders.push(`${rel}: user_type === "lender"`)
    if (IN_USER_TYPE_LENDER.test(s)) offenders.push(`${rel}: .in("user_type", […"lender"…])`)
  }
  // BLIND SPOTS, PUBLISHED BESIDE THE NUMBER (CLAUDE.md §2): app/ and lib/ only.
  // scripts/ is excluded (simulators quote the defect as fixture text) and so is
  // the SQL corpus; a `.rpc()` or a DB trigger comparing user_type is invisible to
  // any source scan and is covered instead by check 5's CHECK-overlap rule.
  console.log(`  · ${scanned.length} files scanned (app/ + lib/, stripped; scripts/ and SQL excluded)`)
  check(`no source resolves lender-ness from users.user_type (${offenders.length})`,
    offenders.length === 0)
  if (offenders.length) offenders.slice(0, 8).forEach((o) => console.log(`      ${o}`))

  // POSITIVE CONTROLS — an absence claim with a broken finder is a blind guard
  // reporting a clean bill of health. Each finder must still recognise the exact
  // code it was written to catch (these three strings are the real prior code).
  check("positive control · the filter finder still recognises the removed getBrokerageLenders read",
    EQ_USER_TYPE_LENDER.test(`.eq("user_type", "lender")`))
  check("positive control · the comparison finder still recognises the removed gate",
    CMP_USER_TYPE_LENDER.test(`if (!user || (userType !== 'lender' && userType !== 'vendor')) {`))
  check("positive control · the membership finder still recognises an .in() roster",
    IN_USER_TYPE_LENDER.test(`.in("user_type", ["lender", "vendor"])`))
  // NEGATIVE CONTROLS — the finders must not fire on the SURVIVOR, or the ruling
  // would forbid the very thing it mandates.
  check("negative control · the finders ignore the vendor-category spelling",
    !EQ_USER_TYPE_LENDER.test(`.eq("category", "lender")`) &&
    !CMP_USER_TYPE_LENDER.test(`category === "lender"`) &&
    !IN_USER_TYPE_LENDER.test(`.in("category", ["lender", "refinance_lender"])`))

  // ── 3 · THE LENDER SURFACES RESOLVE THROUGH THE VENDOR RECORD ─────────────
  // The half that BUILDS the missing reader, not just deletes the writer.
  {
    const pipeline = src("app/lender/pipeline/page.tsx")
    check("the loan pipeline resolves the caller's lender VENDOR from the session",
      /lenderVendorForUser\(/.test(pipeline))
    // THE ORIGINAL DEFECT: an unfiltered read of `transactions`. The assertion is
    // the presence of the assignment filter, because "0 active loans" and "every
    // deal in the database, refused by RLS" render identically.
    check("…and scopes the read to that vendor's ASSIGNED transactions",
      /lenderVendorTransactionIds\(/.test(pipeline) && /\.in\(\s*['"]id['"]/.test(pipeline))
    check("…and READS the error, so a refusal cannot render as an empty pipeline (§3)",
      /const \{ data: transactions, error \}/.test(pipeline) && /if \(error\)/.test(pipeline))

    const extList = src("app/(external-portal)/lender/transactions/page.tsx")
    check("the external lender transaction list gates on the vendor record, not userType",
      /lenderVendorForUser\(/.test(extList) && !/toCanonicalRole\(/.test(extList))

    const multiParty = src("lib/buyer-execution/multi-party-updates.ts")
    check("the lender financial-verification gate resolves the lender vendor",
      /lenderVendorForUser\(/.test(multiParty))

    const buyerFin = src("app/actions/buyer-financial.ts")
    check("the brokerage lender picker reads the vendor bench",
      /\.from\(\s*["']vendors["']\s*\)/.test(buyerFin) && /LENDER_BENCH_CATEGORIES/.test(buyerFin))
  }

  // ── 4 · NO CREATION PATH CAN MINT THE DRIFT AGAIN ─────────────────────────
  // Deleting the rows without closing the writers is a repair with a leak.
  {
    const writers: Array<[string, RegExp]> = [
      ["lib/kernel/users.ts (UserDomainRole — the provisioning vocabulary)", /\|\s*["']lender["']/],
      ["lib/auth/resolve-user-role.ts (UserRole — the users.user_type column vocabulary)", /\|\s*["']lender["']/],
      ["app/actions/superadmin/tenant-users.ts (TENANT_CREATABLE_ROLES — the one override path)", /["']lender["']/],
      ["app/dashboard/admin/users/[userId]/user-edit-form.tsx (USER_TYPE_OPTIONS — writes user_type)", /value:\s*["']lender["']/],
    ]
    for (const [label, re] of writers) {
      const path = label.split(" (")[0]
      check(`${label} no longer offers 'lender'`, !re.test(src(path)))
    }
    check("positive control · the union finder still recognises a union member",
      /\|\s*["']lender["']/.test(`  | "vendor"\n  | "lender"\n  | "admin"`))
    check("positive control · the option finder still recognises a <Select> option",
      /value:\s*["']lender["']/.test(`  { value: "lender", label: "Lender" },`))
  }

  // ── 5 · THE COLUMN VOCABULARIES DO NOT OVERLAP, OR THE OVERLAP IS ACCOUNTED FOR ─
  // THE RULE, WITH THE NUMBER DERIVED (CLAUDE.md §2 — never pin to a waypoint).
  // "A value may not be both a users.user_type and a vendors.category" is the
  // ruling generalised. It is not asserted as a bare zero, because the migration
  // that makes it zero is WRITTEN, NOT APPLIED (lanes write, the integrator
  // applies) — a guard pinned to the post-migration count would be red on a
  // correct tree today and would have to be edited again tomorrow, which is the
  // waypoint trap. Instead every overlapping value must be NAMED by SQL in the
  // tree that removes it from users_user_type_check. When the integrator applies
  // it and regenerates the cache the overlap becomes empty and this passes
  // vacuously — the assertion never changes.
  {
    const overlap = liveUserTypes.filter((t) => liveCategories.includes(t))
    const migration = (() => {
      try { return readFileSync(join(ROOT, "scripts/lender-is-not-a-user-type.sql"), "utf8") }
      catch { return "" }
    })()
    // The rebuilt CHECK's value list, extracted once. An empty string here makes
    // every value unaccounted rather than every value accounted — the direction
    // that fails loudly if the migration is deleted or renamed.
    const rebuiltCheck =
      migration.match(/ADD CONSTRAINT users_user_type_check CHECK \(([\s\S]*?)\);/)?.[1] ?? ""
    const accounted = (v: string) =>
      // BOTH halves, or it is not a repair: the drifted rows are repointed AND the
      // value is absent from the CHECK the migration rebuilds.
      rebuiltCheck.length > 0 &&
      new RegExp(`UPDATE public\\.users SET user_type = '[a-z_]+' WHERE user_type = '${v}'`).test(migration) &&
      !rebuiltCheck.includes(`'${v}'`)
    const unaccounted = overlap.filter((v) => !accounted(v))
    console.log(`  · users.user_type ∩ vendors.category = [${overlap.join(", ") || "none"}]`)
    check(`every value that is BOTH a user_type and a vendor category is removed by SQL in the tree (${unaccounted.length} unaccounted)`,
      unaccounted.length === 0)
    if (unaccounted.length) console.log(`      unaccounted: ${unaccounted.join(", ")}`)

    // POSITIVE CONTROL — the accounting must be able to say NO. A value that no
    // migration mentions must come back unaccounted, or this check is a blind
    // "everything is fine" that would pass with an empty file.
    check("positive control · a fabricated overlap value is NOT accounted for",
      !accounted("stager"))
    check("positive control · the migration is present and does both halves",
      /UPDATE public\.users SET user_type = 'vendor'/.test(migration) &&
      /ADD CONSTRAINT users_user_type_check/.test(migration))
    check("…and it is honest that it has not been applied",
      /WRITTEN, NOT APPLIED/.test(migration))
  }

  // ── 6 · THE BOUNDARY OF THE RULING, PINNED SO IT IS NOT OVER-APPLIED ──────
  // 'lender' stays a CANONICAL ROLE. The seat is 'vendor'; the PERMISSIONS are
  // still spelled 'lender', and user_role_assignments.role carries that value with
  // the vendor_id that links the person to their lender vendor (that column has no
  // CHECK). This is the same asymmetry 'title_agent' has had since m307, and
  // scripts/role-vocabulary-guard.ts:66-72 states it from the other side. Asserted
  // POSITIVELY so a later sweep cannot "finish the job" by deleting the half the
  // ruling deliberately keeps.
  {
    const secTypes = src("lib/security/types.ts")
    check("'lender' is STILL a canonical role (the permission vocabulary is not the seat vocabulary)",
      /\|\s*['"]lender['"]/.test(secTypes))
    check("…exactly as 'title_agent' has been since m307, which is the precedent",
      /\|\s*['"]title_agent['"]/.test(secTypes))
    check("…and vendor_assignments.assignment_type still carries 'lender' (which lane a vendor works)",
      (CHECK_VOCABULARIES.vendor_assignments?.assignment_type ?? []).includes("lender"))
  }
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VENDOR_CATEGORY_FAIL"); process.exit(1) }
console.log(" ✅ VENDOR_CATEGORY_PASS — one spelling, and the partner panels can see their own bench")
