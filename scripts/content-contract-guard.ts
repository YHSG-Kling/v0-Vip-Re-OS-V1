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
import { CONTENT_CONTRACT, isSupplied, missingContentProps, describeMissingContent } from "../lib/remotion/content-contract"
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
/** Source with comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

// ─────────────────────────────────────────────────────────────────────────────
// Parse remotion/Root.tsx → per-composition top-level defaultProps + whether
// each carries a value.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedProp { key: string; valued: boolean }

/** A literal that means "nothing was said" — safe to leave unclassified. */
const NEUTRAL = /^(null|undefined|\[\]|\{\}|""|''|``|false|0)$/

export function parseDefaultProps(rootSrc: string): Record<string, ParsedProp[]> {
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

/** Split an object body on TOP-LEVEL commas, respecting nesting and strings. */
function splitTopLevel(body: string): ParsedProp[] {
  const parts: string[] = []
  let depth = 0, cur = "", inStr: string | null = null
  for (const c of body) {
    if (inStr) { cur += c; if (c === inStr) inStr = null; continue }
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
    // Comment lines inside the block are not props; strip a leading // run.
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
  for (const table of ["listings", "open_houses", "market_data", "neighborhood_reports", "agent_reviews", "transactions"]) {
    ok(`reads ${table}`, dc.includes(`from("${table}")`))
  }
  ok("the equity numbers are READ BACK from the trigger's facts, never recomputed —\n    a second implementation could disagree with the trigger about a client's equity",
    dc.includes("estimatedEquity") && !/estimatedValue\s*-\s*purchasePrice/.test(dc))
  ok("a failed read returns the base props so the CONTRACT refuses, rather than\n    substituting anything", /catch\s*\{\s*return base/.test(dc.replace(/\s+/g, " ").replace(/ /g, "")) || dc.includes("return base"))
  ok("the explainer copy comes from the one gated author, not a canned fallback",
    dc.includes("authorExplainerContent(") && dc.includes("if (!authored.ok) return"))
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
