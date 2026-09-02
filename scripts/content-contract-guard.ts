/**
 * scripts/content-contract-guard.ts
 *
 * test:content-contract — NO COMPOSITION CAN RENDER SAMPLE DATA AS FACT.
 *
 * WHY THIS EXISTS. Remotion MERGES inputProps over a composition's
 * defaultProps. Every composition in remotion/Root.tsx declares defaultProps so
 * the Studio preview renders, and those defaults are plausible sample data. A
 * producer that stages input_props WITHOUT a composition's content props does
 * not therefore render a blank video — it renders a confident, wrong one, and
 * the render reports success. That is what the Video Director did for every
 * situation kind it served: it staged bookends, a QR, a music mood and b-roll,
 * and not one fact about the subject, so an equity report reached a past client
 * quoting $600,000 against $500,000 paid.
 *
 * Threading the props fixes the producers that exist today. It cannot stop the
 * next producer that forgets, or the next composition that adds a content prop
 * nobody knows to supply, because the failure is silent and looks like success.
 * So "which props are a claim" is declared next to the composition
 * (lib/remotion/content-contract.ts) and CHECKED here — the same move
 * test:remotion-setup made for geometry.
 *
 * THE TEETH is section 4: every defaultProp that CARRIES A VALUE must be
 * classified as either required (a claim) or cosmetic (chrome). There is no
 * third, silent category — a new prop with a sample value fails this guard
 * until somebody decides which it is.
 *
 * Reads Root.tsx as text. No Remotion import, no bundling, no DB.
 */
import { readFileSync } from "node:fs"
import { LIVE_TABLES } from "./live-tables"
import { blankComments, stripComments } from "./strip-comments"
import { CONTENT_CONTRACT, isSupplied, missingContentProps, describeMissingContent } from "../lib/remotion/content-contract"
import { explainerDiagramSpec } from "../lib/charts/explainer-diagram"
import {
  listingReelProps, justSoldProps, comingSoonProps, openHouseProps,
  marketUpdateProps, neighborhoodProps, testimonialProps, equityProps,
  formatTimeWindow, compactMoney, brandBlock, type DirectorIdentity,
} from "../lib/video/director-content"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const src = (p: string) => readFileSync(p, "utf8")
/**
 * Source with comments stripped — an assertion must target CODE, never prose.
 *
 * WAS: `.replace(/\/\*[\s\S]*?\*\//g, "")` then a line filter that dropped only
 * lines whose TRIM STARTS WITH `//`. Two failures in one expression, and they
 * point in OPPOSITE directions, which is why neither showed up as an error:
 *
 *   UNDER-READ — a `/` + `*` inside a `//` comment opens a block comment for the
 *     first regex, which then runs to the next `*` + `/` ANYWHERE below, deleting
 *     every line between, code included. This is the exact mechanism that hid the
 *     dead `video_assets` insert in the (now deleted) video-scripts approve route
 *     for its whole life.
 *   OVER-READ — a TRAILING comment (`foo() // resolveDirectorContentProps(...)`)
 *     survives the line filter entirely, so an `includes()` assertion can be
 *     satisfied by PROSE ABOUT the code instead of the code. Measured on this
 *     guard's own inputs: lib/video/video-director.ts kept 625 non-whitespace
 *     characters of commentary that a correct stripper removes, and sections 8
 *     and 9 assert with `includes()` over exactly that file.
 *
 * NOW: the one correct scanner (scripts/strip-comments.ts) — a single
 * left-to-right pass that tracks string/template/comment state, so neither
 * failure is expressible.
 */
const code = (p: string) => stripComments(src(p))

// ─────────────────────────────────────────────────────────────────────────────
// Parse remotion/Root.tsx → per-composition top-level defaultProps + whether
// each carries a value.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedProp { key: string; valued: boolean }

/** A literal that means "nothing was said" — safe to leave unclassified. */
const NEUTRAL = /^(null|undefined|\[\]|\{\}|""|''|``|false|0)$/

/**
 * Root.tsx → per-composition top-level defaultProps.
 *
 * ── WHY THE FIRST LINE IS `blankComments` ───────────────────────────────────
 *
 * `splitTopLevel` below is a character scanner over the raw defaultProps body,
 * and it had no idea comments existed. Two consequences, both SILENT, and both
 * of which make section 4 — "the teeth" — stop having teeth:
 *
 *   1. A PROP PRECEDED BY A COMMENT IS DROPPED. The comma-split hands
 *      `\n // the seller's own figure\n estimatedValue: 812000` to a regex
 *      anchored `^([A-Za-z0-9_]+)\s*:` — it starts with `/`, so there is no
 *      match and the prop is simply not returned. An unclassified sample value
 *      that a reader documented with a comment is thereby EXEMPTED from the very
 *      check that exists to catch it: the more carefully a prop is annotated,
 *      the less likely it is to be audited.
 *   2. AN APOSTROPHE SWALLOWS THE REST OF THE COMPOSITION. `'` in prose
 *      ("the seller's", "don't") puts the scanner into `inStr = "'"`, and it
 *      stays there until another `'` appears — so every top-level comma until
 *      then is consumed and every prop after it vanishes into one unparseable
 *      part. One possessive in one comment silently un-audits a whole
 *      composition's defaults.
 *
 * `blankComments` (scripts/strip-comments.ts) replaces comment bodies with
 * SPACES, so character offsets — which `parseDefaultProps` depends on for its
 * brace balancing and `indexOf` arithmetic — are preserved exactly. It is
 * applied ONCE here, to the whole source, rather than being re-derived per
 * block: `<Composition` can appear inside a comment too.
 *
 * Do NOT replace this with a regex stripper. The naive block-first idiom is what
 * this repo keeps re-learning: a `/` + `*` inside a `//` comment opens a block
 * that runs to the next `*` + `/` and deletes the code in between.
 */
export function parseDefaultProps(rootSrcRaw: string): Record<string, ParsedProp[]> {
  const rootSrc = blankComments(rootSrcRaw)
  const out: Record<string, ParsedProp[]> = {}
  for (const block of rootSrc.split(/<Composition/).slice(1)) {
    const id = block.match(/id="([A-Za-z0-9_]+)"/)?.[1]
    if (!id) continue
    const at = block.indexOf("defaultProps={{")
    if (at < 0) { out[id] = []; continue }
    // Balance braces from the outer `{` of `={{` so nested objects survive.
    const start = at + "defaultProps={".length
    let depth = 0, end = start
    for (let i = start; i < block.length; i++) {
      const c = block[i]
      if (c === "{") depth++
      else if (c === "}") { depth--; if (depth === 0) { end = i; break } }
    }
    out[id] = splitTopLevel(block.slice(start + 1, end))
  }
  return out
}

/**
 * Split an object body on TOP-LEVEL commas, respecting nesting and strings.
 *
 * ESCAPES ARE TRACKED. Without `\` handling, `teaser: 'Chef\'s kitchen'` reads
 * the escaped apostrophe as the CLOSING quote, and everything after it — the
 * rest of that value plus every prop below — is scanned in the wrong mode and
 * lost. Same failure shape as the comment-apostrophe bug above, one layer down:
 * the guard would report ✓ over props it never saw. Root.tsx carries no escaped
 * quote in a defaultProps body today, which is exactly why this stayed invisible.
 */
function splitTopLevel(body: string): ParsedProp[] {
  const parts: string[] = []
  let depth = 0, cur = "", inStr: string | null = null, escaped = false
  for (const c of body) {
    if (inStr) {
      cur += c
      if (escaped) { escaped = false; continue }
      if (c === "\\") { escaped = true; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; cur += c; continue }
    if (c === "{" || c === "[" || c === "(") depth++
    if (c === "}" || c === "]" || c === ")") depth--
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue }
    cur += c
  }
  parts.push(cur)
  const props: ParsedProp[] = []
  for (const p of parts) {
    const m = p.trim().match(/^([A-Za-z0-9_]+)\s*:\s*([\s\S]*)$/)
    if (!m) continue
    // Comments are already SPACES by the time a body reaches here (see
    // parseDefaultProps) — this scanner deliberately knows nothing about them.
    const key = m[1]
    const value = m[2].trim().replace(/\s+as\s+const$/, "").trim()
    props.push({ key, valued: !NEUTRAL.test(value) })
  }
  return props
}

const rootSrc = src("remotion/Root.tsx")
const parsed = parseDefaultProps(rootSrc)

console.log("\n═══ 1. The parser ═══")
{
  const sample = parseDefaultProps(`
    <Composition id="Demo" defaultProps={{
      address: "123 Main",
      imageUrls: [],
      nested: { a: 1, b: "x" },
      flag: false,
    }} />`)
  const keys = sample.Demo?.map((p) => p.key) ?? []
  ok("reads every top-level key, nesting included", JSON.stringify(keys) === JSON.stringify(["address", "imageUrls", "nested", "flag"]), keys.join(","))
  ok("a sample string COUNTS as carrying a value", sample.Demo[0].valued)
  ok("an empty array does NOT — the producer said nothing", !sample.Demo[1].valued)
  ok("a populated nested object DOES", sample.Demo[2].valued)
  ok("false is a real answer, not a placeholder", !sample.Demo[3].valued)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. THE NEGATIVE CONTROLS FOR THE PARSER ITSELF.
//
// Section 4 is the teeth of this guard, and its bite is exactly the set of props
// the parser can SEE. A prop the parser drops is a prop that can carry sample
// data forever without anyone classifying it — the guard reports ✓ and means
// "I did not look". These four assertions are the ones that fail the moment
// parseDefaultProps stops blanking comments first.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 1b. Comments cannot hide a prop from the teeth (negative controls) ═══")
{
  const commented = parseDefaultProps(`
    <Composition id="Demo" defaultProps={{
      // the address we print on the card
      address: "123 Main",
      /* the seller's own figure, read back from the trigger */
      estimatedValue: 812000,
      plain: "x",
    }} />`)
  const keys = (commented.Demo ?? []).map((p) => p.key)
  ok("a prop preceded by a LINE comment is still seen — annotating a prop must\n    not exempt it from classification",
    keys.includes("address"), keys.join(",") || "(none)")
  ok("a prop preceded by a BLOCK comment is still seen",
    keys.includes("estimatedValue"), keys.join(",") || "(none)")
  ok("...and both still count as CARRYING A VALUE, so section 4 can demand a verdict",
    (commented.Demo ?? []).filter((p) => p.key === "address" || p.key === "estimatedValue").every((p) => p.valued))

  // The apostrophe control. One possessive in one comment used to put the
  // character scanner into an unterminated string and swallow every top-level
  // comma after it — every prop below the comment disappeared at once.
  const apostrophe = parseDefaultProps(`
    <Composition id="Apos" defaultProps={{
      first: "a",
      // the client's equity, don't recompute it
      estimatedEquity: 268900,
      purchasePrice: 640000,
      quote: "she priced it honestly",
    }} />`)
  const aKeys = (apostrophe.Apos ?? []).map((p) => p.key)
  ok("an APOSTROPHE in a comment does not swallow the rest of the composition —\n    every prop below it is still audited",
    aKeys.includes("estimatedEquity") && aKeys.includes("purchasePrice") && aKeys.includes("quote"),
    aKeys.join(",") || "(none)")

  // A `'` inside a real string value must STILL behave like a string delimiter —
  // blanking comments must not have blunted the scanner's actual job.
  const strings = parseDefaultProps(`
    <Composition id="Str" defaultProps={{
      teaser: 'Chef\\'s kitchen, pool, boat slip',
      price: "$899,000",
    }} />`)
  ok("...while a quote inside a real STRING value is still string content",
    (strings.Str ?? []).map((p) => p.key).join(",") === "teaser,price",
    (strings.Str ?? []).map((p) => p.key).join(",") || "(none)")

  // And the OTHER half of the fix: `code()` must not leave prose behind for an
  // includes() assertion to match. Sections 8-10 assert over these files.
  const director = code("lib/video/video-director.ts")
  ok("code() removes TRAILING comments too, so a section-8/9 assertion can never\n    be satisfied by commentary about the code instead of the code",
    !/\/\/[^\n]*[A-Za-z]{6}/.test(director))
  ok("...and section 10 scans a Root.tsx with no comment text left to hide a\n    fabricated sample phone number behind",
    !/\/\/[^\n]*[A-Za-z]{6}/.test(code("remotion/Root.tsx")))
}

console.log("\n═══ 2. Every composition is classified ═══")
{
  const rootIds = Object.keys(parsed).sort()
  const contractIds = Object.keys(CONTENT_CONTRACT).sort()
  const unclassified = rootIds.filter((id) => !CONTENT_CONTRACT[id])
  const orphaned = contractIds.filter((id) => !parsed[id])
  ok(`Root.tsx registers ${rootIds.length} compositions`, rootIds.length >= 33)
  ok("every composition Remotion can render declares a content contract — an\n    unclassified one is a composition nothing can prove will not fabricate",
    unclassified.length === 0, unclassified.join(", "))
  ok("no contract names a composition that does not exist", orphaned.length === 0, orphaned.join(", "))
}

console.log("\n═══ 3. No contract names a prop the composition does not have ═══")
{
  const bad: string[] = []
  for (const [id, contract] of Object.entries(CONTENT_CONTRACT)) {
    const declared = new Set((parsed[id] ?? []).map((p) => p.key))
    if (declared.size === 0) continue
    for (const k of [...contract.required, ...contract.cosmetic]) {
      // The shared CHROME list is applied to every composition; a chrome prop
      // that a given composition simply does not take is not a defect.
      if (!declared.has(k) && contract.required.includes(k)) bad.push(`${id}.${k}`)
    }
  }
  ok("every REQUIRED prop is a real prop of that composition — a typo here would\n    make the contract permanently unsatisfiable and refuse every render",
    bad.length === 0, bad.slice(0, 8).join(", "))
}

console.log("\n═══ 4. Every prop that carries a value was CLASSIFIED (the teeth) ═══")
{
  const unclassified: string[] = []
  for (const [id, props] of Object.entries(parsed)) {
    const contract = CONTENT_CONTRACT[id]
    if (!contract) continue
    const known = new Set([...contract.required, ...contract.cosmetic])
    for (const p of props) {
      if (p.valued && !known.has(p.key)) unclassified.push(`${id}.${p.key}`)
    }
  }
  ok("no prop carries sample data without somebody deciding whether it is a CLAIM\n    or CHROME — this is what stops the next composition reopening the hole",
    unclassified.length === 0, unclassified.slice(0, 10).join(", "))
}

console.log("\n═══ 5. The claims that must never default ═══")
{
  // Spot-checks on the findings that motivated the build, so a future edit that
  // quietly demotes one of them to cosmetic fails loudly here.
  const mustBeRequired: Array<[string, string]> = [
    ["EquityReportReel", "estimatedValue"],
    ["EquityReportReel", "purchasePrice"],
    ["EquityReportReel", "estimatedEquity"],
    ["TestimonialReel", "quote"],
    ["TestimonialReel", "clientName"],
    ["TestimonialReel", "stars"],
    ["OpenHouseAnnounceReel", "dateLabel"],
    ["OpenHouseAnnounceReel", "timeLabel"],
    ["JustListedReelSquare", "price"],
    ["JustListedReelSquare", "address"],
    ["JustSoldReelSquare", "soldPrice"],
    ["MarketUpdateReel", "stats"],
    ["CMAReel", "comps"],
    ["ListingFlyer", "statusLine"],
    ["VideoCoverThumb", "seoHint"],
    ["NewsletterDigestVideo", "marketBeat"],
    ["PostcardFront4x6", "body"],
  ]
  const demoted = mustBeRequired.filter(([id, k]) => !CONTENT_CONTRACT[id]?.required.includes(k))
  ok("the financial, endorsement, event-time and market claims are all REQUIRED",
    demoted.length === 0, demoted.map(([i, k]) => `${i}.${k}`).join(", "))

  ok("ProductPromoReel requires nothing — its defaults ARE the product's own\n    approved marketing copy, not a stand-in for a tenant's facts",
    CONTENT_CONTRACT.ProductPromoReel.required.length === 0)
  ok("...and it says so", /PRODUCT_ANGLES|approved marketing copy/.test(CONTENT_CONTRACT.ProductPromoReel.why))

  ok("every contract explains itself to the next reader",
    Object.values(CONTENT_CONTRACT).every((c) => c.why.trim().length >= 40))
}

console.log("\n═══ 6. isSupplied cannot be satisfied by a blank ═══")
{
  ok("null is not supplied", !isSupplied(null))
  ok("undefined is not supplied", !isSupplied(undefined))
  ok("an empty string is not supplied", !isSupplied(""))
  ok("whitespace is not supplied", !isSupplied("   "))

  // A CONTAINER OF NOTHING IS NOTHING (lane RM1, 2026-09-02). The defect that
  // motivated this: `daysOnMarket: { values: [], labels: [] }` — the shape the
  // CMA builder emits when no comp reports days-on-market — passed isSupplied
  // because it is a non-empty OBJECT, and remotion/CMAReel.tsx:95 then rendered a
  // bar chart with no bars (its Math.min over an empty array is -Infinity). The
  // rule is now recursive: an object or array is supplied only if SOME member
  // is. These are the positive controls that keep it so, plus the arm that
  // proves it does not over-refuse — one live member is enough.
  ok("an object whose members are all empty is NOT supplied (the CMA no-DOM shape)",
    !isSupplied({ values: [], labels: [] }))
  ok("an array of empty arrays is NOT supplied", !isSupplied([[], []]))
  ok("an object of nulls and blanks is NOT supplied", !isSupplied({ a: null, b: "", c: "  " }))
  ok("nested emptiness is NOT supplied", !isSupplied({ series: { values: [], labels: [] } }))
  ok("...but ONE live member is enough — no false refusal",
    isSupplied({ values: [42], labels: [] }) && isSupplied([[], [1]]) && isSupplied({ a: null, b: "x" }))
  ok("...and a plain number or non-blank string is still supplied", isSupplied(0) && isSupplied("x"))
  ok("an empty array is not supplied — a reel with no cards states nothing", !isSupplied([]))
  ok("an empty object is not supplied", !isSupplied({}))
  ok("ZERO is supplied — zero appreciation is a real answer", isSupplied(0))
  ok("FALSE is supplied — hasData:false is a real answer", isSupplied(false))
  ok("a populated array is supplied", isSupplied([1]))
}

console.log("\n═══ 7. The refusal is real, and it names the props ═══")
{
  const equityChrome = { qrCodeDataUrl: "data:...", qrCaption: "Scan", music_mood: "warm" }
  const missing = missingContentProps("EquityReportReel", equityChrome)
  ok("the Director's OLD payload is refused for EquityReportReel", missing.length > 0)
  ok("...and the refusal names the equity numbers, not a generic error",
    missing.includes("estimatedValue") && missing.includes("purchasePrice") && missing.includes("estimatedEquity"),
    missing.join(","))

  const full = {
    ...equityChrome, agentName: "Dana Reyes", address: "44 Bay Rd, Naples, FL",
    estimatedValue: 812000, purchasePrice: 640000, appreciation: 172000,
    appreciationPct: 26.9, estimatedEquity: 268000, yearsHeld: 4,
  }
  ok("a fully-resolved payload passes", missingContentProps("EquityReportReel", full).length === 0)

  // zero must not read as absent — a client whose home has not appreciated
  // still deserves the honest video.
  const zeroed = { ...full, appreciation: 0, appreciationPct: 0 }
  ok("ZERO appreciation still renders — the honest video, not a refusal",
    missingContentProps("EquityReportReel", zeroed).length === 0)

  ok("a testimonial with no quote is refused",
    missingContentProps("TestimonialReel", { agentName: "A", clientName: "B", stars: 5 }).includes("quote"))

  ok("an unknown composition is NOT refused — a missing declaration is caught at\n    build time by section 2, and refusing at runtime would turn it into an outage",
    missingContentProps("SomeCompositionNobodyDeclared", {}).length === 0)

  const sentence = describeMissingContent("EquityReportReel", missing)
  ok("the sentence a manager reads names the composition and the props",
    sentence.includes("EquityReportReel") && sentence.includes("estimatedValue") && sentence.includes("refused"))
}

console.log("\n═══ 8. Both enforcement points are wired ═══")
{
  const route = code("app/api/internal/remotion/render-composition/route.ts")
  ok("render-composition imports the contract", route.includes('from "@/lib/remotion/content-contract"'))
  ok("...and refuses before it renders", route.includes("missingContentProps(row.composition_id, row.input_props)"))
  ok("...as CANCELLED, not failed — nothing broke, the render was not renderable",
    /missingContent\.length > 0[\s\S]{0,400}status: "cancelled"/.test(route))
  // The refusal must come before the cache probe, or a refused render could
  // key or serve an artifact.
  const gateAt = route.indexOf("missingContentProps(row.composition_id")
  const probeAt = route.indexOf("probeRenderCache(")
  ok("...and BEFORE the cache probe, so a refusal never keys or serves an artifact",
    gateAt > 0 && probeAt > gateAt)

  const director = code("lib/video/video-director.ts")
  ok("commissionVideo resolves real content props", director.includes("resolveDirectorContentProps("))
  ok("...stages them into input_props", /input_props:\s*\{\s*\.\.\.contentProps/.test(director))
  ok("...and BLOCKS the commission when they could not be established",
    director.includes("missingContentProps(format.compositionId, contentProps)")
    && /missing\.length > 0[\s\S]{0,300}status: "blocked"/.test(director))
}

console.log("\n═══ 9. The Director resolves from ROWS, never from invention ═══")
{
  const dc = code("lib/video/director-content.ts")
  // `open_houses` STOOD IN THIS LIST AND IS NOW `open_house_events`. m543 chose the
  // survivor on evidence (all five satellites FK to it, 61 call sites against 6)
  // and m547 dropped the retired spelling, so the Director was correctly
  // re-pointed — and this assertion, which names the table it must read, went red
  // for the re-point. The point of the check is unchanged: the Director resolves
  // video facts from LIVE ROWS rather than inventing them, and a fabricated fact
  // about a real person's home is what section 9 exists to prevent. Only the
  // table's name moved.
  //
  // Named against LIVE_TABLES rather than left as a bare literal, so this list
  // cannot quietly come to name a table that no longer exists — which is exactly
  // how it would have failed the NEXT time instead of this one.
  const MUST_READ = ["listings", "open_house_events", "market_data", "neighborhood_reports", "agent_reviews", "transactions"]
  for (const table of MUST_READ) {
    ok(`reads ${table}`, dc.includes(`from("${table}")`))
  }
  ok("CONTROL — every table this section demands is one the live database still has,\n    so a retired name cannot sit here reading as enforced",
    MUST_READ.every((t) => (LIVE_TABLES as readonly string[]).includes(t)))
  ok("the equity numbers are READ BACK from the trigger's facts, never recomputed —\n    a second implementation could disagree with the trigger about a client's equity",
    dc.includes("estimatedEquity") && !/estimatedValue\s*-\s*purchasePrice/.test(dc))
  ok("a failed read returns the base props so the CONTRACT refuses, rather than\n    substituting anything", /catch\s*\{\s*return base/.test(dc.replace(/\s+/g, " ").replace(/ /g, "")) || dc.includes("return base"))
  ok("the explainer copy comes from the one gated author, not a canned fallback",
    dc.includes("authorExplainerContent(") && dc.includes("if (!authored.ok) return"))
  ok("the ANIMATED explainer's diagram comes from the one deterministic spec module\n    (lib/charts/explainer-diagram), not a second implementation",
    dc.includes("explainerDiagramSpec("))
}

console.log("\n═══ 10. The sample contact details are gone from the print pieces ═══")
{
  // Brand blocks are classified COSMETIC, so unlike the content props these
  // defaults REMAIN reachable on a real render — a fabricated phone number and
  // state licence number would have been printed onto a mailed postcard.
  const root = code("remotion/Root.tsx")
  ok("no sample phone number survives in the composition defaults", !/\(555\)\s*\d{3}-\d{4}/.test(root))
  ok("no sample licence number survives", !/CA License #/.test(root))
  ok("no sample website wordmark survives", !/yourbrokerage\.com/.test(root))
}

// ─────────────────────────────────────────────────────────────────────────────
// 11–13. THE RESOLVER, against rows the LIVE database actually returned.
//
// The literals below are the exact JSON production returned for the m317 test
// fixtures (a listing, its open house, a market_data snapshot, a published
// agent_reviews row and a neighborhood_reports row), captured and then deleted.
// Hand-authored shapes would have proved nothing: the first cut of
// director-content.ts passed market_data.dom_trend straight into the stat card's
// delta line, and only the live CHECK constraint revealed that the column is an
// ENUM (decreasing|stable|increasing) — so the card would have printed the
// literal word "decreasing" where it shows "-3 days vs Sept".
// ─────────────────────────────────────────────────────────────────────────────
const LIVE = {
  listing: {"address":"812 Sunset Harbour Dr","city":"Naples","state":"FL","list_price":899000,"sold_price":915000,"bedrooms":4,"bathrooms":3,"sqft":2840,"property_type":"single_family","public_remarks":"Chef's kitchen with quartz island. Saltwater pool and lanai. Deeded boat slip.","photos":["https://example.invalid/m317-a.jpg","https://example.invalid/m317-b.jpg"],"primary_photo_url":"https://example.invalid/m317-hero.jpg","listing_date":"2026-05-04","sold_date":"2026-06-18","go_live_date":"2026-05-04","lifecycle_stage":"MLS_ACTIVE"},
  openHouse: {"property_address":"812 Sunset Harbour Dr","description":"Waterfront four-bedroom with a deeded boat slip. Coffee and pastries from the corner bakery.","event_date":"2026-08-08","start_time":"11:00:00","end_time":"13:30:00"},
  market: {"market_area":"Naples","city":"Naples","data_date":"2026-07-01","median_sale_price":742500,"avg_days_on_market":19,"active_listings":141,"price_trend_pct_30d":-1.8,"dom_trend":"decreasing"},
  review: {"review_text":"She priced it honestly when two other agents told us what we wanted to hear, and it sold in three weeks over ask.","reviewer_name":"Marisol T.","rating":5,"created_at":"2026-06-25 00:00:00+00","kind":"seller"},
  hood: {"neighborhood_name":"Sunset Harbour","city":"Naples","median_home_price":768000,"walk_score":64,"avg_days_on_market":21,"ai_summary":"A boating neighbourhood where inventory turns faster than the county average. Buyers here trade square footage for water access."},
}

const identity: DirectorIdentity = {
  agentName: "Dana Reyes", agentPhone: "(239) 555-0184", agentPhotoUrl: null,
  brokerageName: "Harbour & Co.", primaryColor: "#0F172A", accentColor: "#F59E0B", logoUrl: null,
}
const chrome: Record<string, unknown> = { brand: brandBlock(identity) }

/** What commissionVideo staged BEFORE m317: chrome, and not one fact. */
const OLD_DIRECTOR_PAYLOAD = {
  intro: { brand: true, hook: "Just Listed" },
  outro: { brand: true, agentContact: true },
  qrCodeDataUrl: "data:image/png;base64,iVBOR", qrCaption: "Scan to tour",
  mlsClean: false, music_mood: "upbeat",
}

console.log("\n═══ 11. The Director's OLD payload is refused by every composition it served ═══")
{
  const served = [
    "JustListedReelSquare", "JustListedReelHorizontal", "JustSoldReelSquare",
    "OpenHouseAnnounceReel", "ComingSoonReel", "MarketUpdateReel",
    "NeighborhoodSpotlightReel", "TestimonialReel", "EquityReportReel",
    "PhotoWalkthroughReel", "AgentExplainerReel", "AgentTalkingHeadReel",
    "ExplainerAnimReel",
  ]
  const rendered = served.filter((c) => missingContentProps(c, OLD_DIRECTOR_PAYLOAD).length === 0)
  ok(`all ${served.length} compositions the Director commissions now refuse the\n    chrome-only payload that used to render sample data as a client's facts`,
    rendered.length === 0, rendered.join(", "))
}

console.log("\n═══ 12. The LIVE rows satisfy the contracts ═══")
{
  const l = { ...chrome, ...listingReelProps(LIVE.listing, "Just Listed") }
  ok("JustListedReelSquare passes on a real listing row",
    missingContentProps("JustListedReelSquare", l).length === 0,
    missingContentProps("JustListedReelSquare", l).join(","))
  ok("...the row's address, price and facts — not 123 Main Street at $625,000",
    l.address === "812 Sunset Harbour Dr" && l.price === "$899,000"
    && l.bedrooms === "4" && l.bathrooms === "3" && l.sqft === "2,840")

  const s = { ...chrome, ...justSoldProps(LIVE.listing, "2026-07-31T00:00:00Z") }
  ok("JustSoldReelSquare passes", missingContentProps("JustSoldReelSquare", s).length === 0)
  ok("...days-on-market computed from the row's OWN dates (May 4 → Jun 18 = 45),\n    never the sample's 7", s.daysOnMarket === 45, String(s.daysOnMarket))

  const cs = { ...chrome, ...comingSoonProps(LIVE.listing, identity) }
  ok("ComingSoonReel passes", missingContentProps("ComingSoonReel", cs).length === 0,
    missingContentProps("ComingSoonReel", cs).join(","))
  ok("...the teaser is the listing's own beds plus its first real remark",
    String(cs.teaser).startsWith("4 BD · 3 BA ·") && String(cs.teaser).includes("Chef's kitchen"))

  const oh = { ...chrome, ...openHouseProps(LIVE.openHouse, LIVE.listing, identity) }
  ok("OpenHouseAnnounceReel passes", missingContentProps("OpenHouseAnnounceReel", oh).length === 0,
    missingContentProps("OpenHouseAnnounceReel", oh).join(","))
  ok("...the EVENT's date and window, not 'This Saturday, 12:00 - 2:00 PM' —\n    the default that would send a buyer to a house on the wrong day",
    oh.dateLabel === "Saturday, August 8" && oh.timeLabel === "11:00 AM - 1:30 PM",
    `${oh.dateLabel} / ${oh.timeLabel}`)

  const m = { ...chrome, ...marketUpdateProps(LIVE.market, identity) }
  const stats = m.stats as Array<Record<string, unknown>>
  ok("MarketUpdateReel passes", missingContentProps("MarketUpdateReel", m).length === 0,
    missingContentProps("MarketUpdateReel", m).join(","))
  ok("...three cards EARNED from the row, at the row's own figures", stats.length === 3 && stats[0].value === "$743K")
  ok("...dom_trend's ENUM became a human line — the live CHECK is what caught\n    this; the raw column would have printed the word \"decreasing\"",
    stats[1].delta === "selling faster" && stats[1].direction === "down_good", JSON.stringify(stats[1]))
  ok("...and a FALLING median reads as bad news for a seller, not a hardcoded arrow",
    stats[0].direction === "down_bad", String(stats[0].direction))

  const n = { ...chrome, ...neighborhoodProps(LIVE.hood, identity) }
  ok("NeighborhoodSpotlightReel passes", missingContentProps("NeighborhoodSpotlightReel", n).length === 0)
  ok("...the tagline is the report's OWN stored summary, not re-drafted",
    String(n.tagline).startsWith("A boating neighbourhood"))

  const t = { ...chrome, ...testimonialProps(LIVE.review, identity) }
  ok("TestimonialReel passes", missingContentProps("TestimonialReel", t).length === 0,
    missingContentProps("TestimonialReel", t).join(","))
  ok("...the real review, the real reviewer, the row's own rating and date —\n    never a five-star quote from 'Jamie, Brickell'",
    String(t.quote).startsWith("She priced it honestly") && t.clientName === "Marisol T."
    && t.stars === 5 && t.clientRole === "Seller" && t.closingLabel === "Reviewed Jun 2026")
}

// ─────────────────────────────────────────────────────────────────────────────
// 12b. THE POSITIVE CONTROL FOR THE FIXTURES THEMSELVES.
//
// WHY THIS EXISTS, and it is the §2 lesson pointed at this guard's own inputs.
// Every fixture above supplies a phone — `identity.agentPhone` is
// "(239) 555-0184" and nothing in sections 11-13 can ever hand a composition an
// empty one. So the guard's entire body of evidence about `agentPhone` is
// evidence about a value that is always present, and TWO live producer defects
// (an empty agentPhone staged into compositions that REQUIRE it) sat under it
// for months reporting ✓. A fixture that cannot be empty cannot detect an
// empty-prop defect: it is the "0 found" that means "I did not look".
//
// So the blanks are supplied deliberately here, and the rule is DERIVED rather
// than typed: every composition whose contract REQUIRES agentPhone must refuse a
// blank one, and every composition that requires `highlights` must refuse an
// empty list. Add a ninth composition that requires a phone and it is covered
// with nobody editing this section; retire one and the list shrinks on its own.
// A hardcoded roster of composition names here would be the waypoint pin §2
// forbids — true on the day it was written and quietly stale after.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 12b. A BLANK is not a value — the empty-prop positive control ═══")
{
  /** Every required prop supplied with a plausible value, then the blanks under test. */
  const filled = (id: string, overrides: Record<string, unknown>): Record<string, unknown> => {
    const p: Record<string, unknown> = {}
    for (const k of CONTENT_CONTRACT[id].required) p[k] = "supplied"
    return { ...p, ...overrides }
  }

  const requiresPhone = Object.entries(CONTENT_CONTRACT)
    .filter(([, c]) => c.required.includes("agentPhone")).map(([id]) => id).sort()
  const requiresHighlights = Object.entries(CONTENT_CONTRACT)
    .filter(([, c]) => c.required.includes("highlights")).map(([id]) => id).sort()

  // THE CONTROL ON THE CONTROL. If the filler did not actually satisfy the
  // contract, every assertion below would report the prop as missing for the
  // wrong reason and prove nothing about blanks at all.
  const fillerLeaks = [...requiresPhone, ...requiresHighlights]
    .filter((id) => missingContentProps(id, filled(id, {})).length > 0)
  ok("CONTROL: the filler satisfies every required prop, so anything reported below\n    is caused by the BLANK and not by a thin payload",
    fillerLeaks.length === 0, fillerLeaks.join(", "))

  const phoneMisses = requiresPhone.filter((id) => {
    const missing = missingContentProps(id, filled(id, { agentPhone: "" }))
    return !(missing.length === 1 && missing[0] === "agentPhone")
  })
  ok(`an EMPTY agentPhone is refused by all ${requiresPhone.length} compositions that require one\n    (${requiresPhone.join(", ")}) — the exact live defect the always-populated fixture\n    could never have seen`,
    requiresPhone.length > 0 && phoneMisses.length === 0, phoneMisses.join(", "))

  const wsMisses = requiresPhone.filter((id) => !missingContentProps(id, filled(id, { agentPhone: "   " })).includes("agentPhone"))
  ok("...and so is a WHITESPACE phone — a producer that stages `\" \"` has still said nothing",
    wsMisses.length === 0, wsMisses.join(", "))

  const nullMisses = requiresPhone.filter((id) => !missingContentProps(id, filled(id, { agentPhone: null })).includes("agentPhone"))
  ok("...and so is a NULL one, which is what a users row with no phone actually yields",
    nullMisses.length === 0, nullMisses.join(", "))

  const hlMisses = requiresHighlights.filter((id) => {
    const missing = missingContentProps(id, filled(id, { highlights: [] }))
    return !(missing.length === 1 && missing[0] === "highlights")
  })
  ok(`an EMPTY highlights array is refused by all ${requiresHighlights.length} compositions that require it\n    (${requiresHighlights.join(", ")}) — a flyer with no bullet points states nothing`,
    requiresHighlights.length > 0 && hlMisses.length === 0, hlMisses.join(", "))

  // The BEHAVIOUR the refusal rests on, asserted directly so that loosening
  // isSupplied — the one edit that would make every assertion above pass while
  // meaning nothing — fails here as well as in section 6.
  ok("the refusal rests on isSupplied: \"\" and [] are NOT supplied…",
    !isSupplied("") && !isSupplied("   ") && !isSupplied([]))
  ok("...while 0 and false still ARE — a strictness fix must not start refusing\n    honest zeroes",
    isSupplied(0) && isSupplied(false))

  // AND THROUGH THE REAL PRODUCERS, not just a synthetic payload. This is the
  // shape the live defect actually had: the identity resolved with no phone, the
  // producer passed it straight through, and the composition printed its Studio
  // sample number instead. Same LIVE row, same producer, one blank field.
  const noPhone: DirectorIdentity = { ...identity, agentPhone: "" }
  const blankChrome: Record<string, unknown> = { brand: brandBlock(noPhone) }
  const mNoPhone = { ...blankChrome, ...marketUpdateProps(LIVE.market, noPhone) }
  ok("a real producer handed an identity with NO phone is refused by the contract —\n    it does not quietly print the composition's sample number",
    missingContentProps("MarketUpdateReel", mNoPhone).includes("agentPhone"),
    missingContentProps("MarketUpdateReel", mNoPhone).join(",") || "(nothing missing)")
  const nNoPhone = { ...blankChrome, ...neighborhoodProps(LIVE.hood, noPhone) }
  ok("...the neighborhood spotlight likewise",
    missingContentProps("NeighborhoodSpotlightReel", nNoPhone).includes("agentPhone"),
    missingContentProps("NeighborhoodSpotlightReel", nNoPhone).join(",") || "(nothing missing)")
  // NEGATIVE HALF: the same producers with the POPULATED identity must NOT be
  // refused, or the two assertions above would pass for the wrong reason.
  ok("CONTROL: with the phone present, both producers pass — the refusal tracks the\n    blank field and nothing else",
    !missingContentProps("MarketUpdateReel", { ...chrome, ...marketUpdateProps(LIVE.market, identity) }).includes("agentPhone")
    && !missingContentProps("NeighborhoodSpotlightReel", { ...chrome, ...neighborhoodProps(LIVE.hood, identity) }).includes("agentPhone"))
}

console.log("\n═══ 13. The equity reel — the case that started this ═══")
{
  // equity-trigger's REAL dispatch shape (lib/kernel/equity-trigger.ts).
  const facts = {
    estimatedValue: 812400, purchasePrice: 640000, appreciation: 172400,
    appreciationPct: 26.9375, estimatedEquity: 268900, yearsHeld: 4,
    source: "equity_trigger",
  }
  const p = { ...chrome, ...equityProps(facts, "812 Sunset Harbour Dr, Naples, FL", identity) }
  ok("EquityReportReel passes on the trigger's own RentCast-backed numbers",
    missingContentProps("EquityReportReel", p).length === 0,
    missingContentProps("EquityReportReel", p).join(","))
  ok("...$812,400 estimated and $640,000 paid — NOT the sample's $600,000/$500,000",
    p.estimatedValue === 812400 && p.purchasePrice === 640000)
  ok("...$268,900 equity — NOT the sample's $206,000", p.estimatedEquity === 268900)
  ok("...the percentage is ROUNDED for display, not recomputed from the other two",
    p.appreciationPct === 26.9)

  const thin = { ...chrome, ...equityProps({ yearsHeld: 4 }, "812 Sunset Harbour Dr", identity) }
  const missing = missingContentProps("EquityReportReel", thin)
  ok("a commission whose valuation could NOT be established is refused", missing.length > 0)
  ok("...naming the numbers, so a human knows what to establish",
    missing.includes("estimatedValue") && missing.includes("purchasePrice"), missing.join(","))
}

console.log("\n═══ 13b. The animated explainer — the spec's payload satisfies the contract ═══")
{
  // The Director's ExplainerAnimReel case (lib/video/director-content.ts) stages
  // exactly this shape: title/caption/hasData from the spec, diagram from
  // spec.data, agentName from the identity. Proven here PURELY — the same
  // mapping, no DB — so the case and the contract cannot drift apart silently.
  const spec = explainerDiagramSpec(undefined, {
    topic: "equity_over_time", purchasePrice: "$500,000", downPaymentPct: "20", rate: "6.5%",
  })
  const p = {
    ...chrome, agentName: identity.agentName,
    title: spec.title, caption: spec.caption, hasData: spec.hasData,
    ...(spec.hasData && spec.data ? { diagram: spec.data } : {}),
  }
  ok("ExplainerAnimReel passes on a spec computed from the caller's own facts",
    missingContentProps("ExplainerAnimReel", p).length === 0,
    missingContentProps("ExplainerAnimReel", p).join(","))
  ok("...and the diagram is the spec's real amortization, not the Studio sample",
    (p as { diagram?: { kind?: string; startLoan?: number } }).diagram?.kind === "equity_over_time"
    && (p as { diagram?: { startLoan?: number } }).diagram?.startLoan === 400000)

  // The HONEST no-data path: the spec refuses to compute, the case leaves
  // `diagram` absent, and the contract refuses the commission naming it.
  const thinSpec = explainerDiagramSpec(undefined, { topic: "equity_over_time" })
  ok("a topic whose facts cannot support the math comes back hasData:false with a reason",
    thinSpec.hasData === false && !!thinSpec.reason)
  const thin = {
    ...chrome, agentName: identity.agentName,
    title: thinSpec.title, caption: thinSpec.caption, hasData: thinSpec.hasData,
  }
  const missingThin = missingContentProps("ExplainerAnimReel", thin)
  ok("...and the commission is refused naming `diagram` — never rendered from\n    the sample equity curve", missingThin.length === 1 && missingThin[0] === "diagram",
    missingThin.join(","))
}

console.log("\n═══ 14. Time and money formatting cannot guess ═══")
{
  ok("a window inside one half-day collapses the meridiem", formatTimeWindow("12:00:00", "14:00:00") === "12:00 - 2:00 PM")
  ok("a window CROSSING noon states both — unambiguous beats short",
    formatTimeWindow("11:00:00", "13:30:00") === "11:00 AM - 1:30 PM")
  ok("a HALF-known window is null, so the contract refuses the reel rather than\n    announcing an open house with one real time and one invented one",
    formatTimeWindow("11:00:00", null) === null)
  ok("an unparseable time is null, never guessed", formatTimeWindow("later", "13:00") === null)
  ok("money below a thousand is not compacted into nonsense", compactMoney(640) === "$640")
  ok("a million reads as a million", compactMoney(1_250_000) === "$1.3M")
}

console.log(`\n${"═".repeat(70)}`)
console.log(`CONTENT CONTRACT — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nAdding a composition prop with a sample value? Decide whether it is a CLAIM")
  console.log("about a real property/person/market (required) or chrome (cosmetic), and say")
  console.log("which in lib/remotion/content-contract.ts. There is no third option.")
  process.exit(1)
}
console.log("No composition can render its Studio sample data as a client's facts.")
