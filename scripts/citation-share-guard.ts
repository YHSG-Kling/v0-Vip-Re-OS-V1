/**
 * scripts/citation-share-guard.ts
 *
 * test:citation-share — THE GEO KPI MUST NOT FLATTER.
 *
 * Two things this guard exists for, both found by auditing the citation monitor
 * before writing anything:
 *
 * 1. THE SAMPLE SIZE WAS INFLATED FIVE-FOLD. The monitor issues ONE web query
 *    per page per day and records FIVE observation rows from it, one per
 *    platform vocabulary — its own comment says they share the underlying
 *    evidence, and the unique index (project_id, platform, observed_on) makes
 *    that by design. scoreCitationVisibility counts ROWS, so the ratio survives
 *    (both sides inflate) but "checked 250 times" really meant 50 answers read.
 *    A confidence number that is 5× the evidence is a fabricated confidence.
 *
 * 2. SHARE OF VOICE DID NOT EXIST. detectOurCitation read the answer, decided
 *    about US, and discarded the rest of the sentence — so the OS could report
 *    a hit rate but never the question a broker actually asks. The rate and the
 *    share can move in OPPOSITE directions, and reporting only the rate
 *    congratulates a broker who is losing.
 *
 * The honesty rules below are the point. Three no-number states mean three
 * different things and must never collapse into one shrug.
 */
import { readFileSync, existsSync } from "node:fs"
import {
  citationShare, collapseToQueries, describeCitationShare, type ShareObservationRow,
} from "../lib/geo/citation-share"
import { detectCompetitorCitations } from "../lib/kernel/ai-search-citation-monitor"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

const PLATFORMS = ["google_ai_overviews", "chatgpt", "perplexity", "gemini", "bing_copilot"]
/** One answer, as the monitor really stores it: five rows sharing one fetch. */
function answer(pageId: string, day: string, outcome: any, competitors: string[] | null = null): ShareObservationRow[] {
  return PLATFORMS.map(() => ({ pageId, observedOn: day, outcome, competitorsCited: competitors }))
}

console.log("\n═══ 1. The unit of evidence is the ANSWER, not the row ═══")
{
  const rows = [...answer("p1", "2026-07-01", "cited"), ...answer("p2", "2026-07-01", "not_cited")]
  ok("ten rows from two answers collapse to two queries", collapseToQueries(rows).size === 2)

  const s = citationShare(rows)
  ok("the published sample size is 2, not 10 — a month of 50 real queries must\n    never report as 250 checks",
    s.queriesChecked === 2, String(s.queriesChecked))
  ok("the rate is still right", s.citationRatePct === 50, String(s.citationRatePct))
  ok("...and our citation count is per ANSWER, not per platform row",
    s.ourCitations === 1, String(s.ourCitations))
}

console.log("\n═══ 2. not_checked never enters a denominator ═══")
{
  const rows = [
    ...answer("p1", "2026-07-01", "cited"),
    ...answer("p2", "2026-07-01", "not_checked"),
    ...answer("p3", "2026-07-01", "not_cited"),
  ]
  const s = citationShare(rows)
  ok("an unreadable answer is excluded from the rate — a monitoring outage is\n    not a citation miss",
    s.queriesChecked === 2 && s.citationRatePct === 50)
  ok("...and is reported separately rather than buried", s.queriesNotChecked === 1)

  const allOut = citationShare(answer("p1", "2026-07-01", "not_checked"))
  ok("an all-outage window yields NULL with a reason, never a 0% that reads as\n    'definitely not cited'",
    allOut.citationRatePct === null && allOut.reason === "not_checked_search_rail_unavailable")
}

console.log("\n═══ 3. The three no-number states stay distinct ═══")
{
  const empty = citationShare([])
  ok("no observations at all", empty.reason === "no_observations" && empty.citationRatePct === null)

  const outage = citationShare(answer("p1", "d", "not_checked"))
  ok("outage is NOT the same as no data", outage.reason === "not_checked_search_rail_unavailable")

  const nobody = citationShare(answer("p1", "d", "not_cited", []))
  ok("read the answers, nobody was named at all", nobody.reason === "no_brokerage_named_in_any_answer")
  ok("...and each says something different to the broker",
    new Set([describeCitationShare(empty), describeCitationShare(outage), describeCitationShare(nobody)]).size === 3)
}

console.log("\n═══ 4. Share of voice is NULL when nobody was named — not zero ═══")
{
  const s = citationShare(answer("p1", "d", "not_cited", []))
  ok("we were not cited and neither was anyone else", s.citationRatePct === 0 && s.ourCitations === 0)
  ok("share of voice is NULL, because 0% would tell the broker a rival beat\n    them when the truth is the category is wide open — the opposite\n    strategic conclusion",
    s.shareOfVoicePct === null)
  ok("...and the sentence says so", /wide open/.test(describeCitationShare(s)))

  const contested = citationShare([
    ...answer("p1", "d1", "cited", ["Compass"]),
    ...answer("p2", "d1", "not_cited", ["Compass", "Redfin"]),
  ])
  ok("with rivals present the share is real: 1 of 4 mentions",
    contested.shareOfVoicePct === 25, String(contested.shareOfVoicePct))
  ok("...and the rate can look BETTER than the share — the exact case a\n    rate-only dashboard would congratulate",
    contested.citationRatePct === 50 && contested.shareOfVoicePct === 25)
}

console.log("\n═══ 5. A competitor counts once per answer, not once per row ═══")
{
  const s = citationShare(answer("p1", "d", "not_cited", ["Compass"]))
  ok("five platform rows naming Compass are ONE mention",
    s.competitorCitations === 1 && s.topCompetitors[0]?.citations === 1)
  ok("...and their share is 100% when we were not named", s.topCompetitors[0]?.sharePct === 100)

  const many = citationShare([
    ...answer("p1", "d1", "cited", ["Compass"]),
    ...answer("p2", "d2", "not_cited", ["Compass"]),
    ...answer("p3", "d3", "not_cited", ["Redfin"]),
  ])
  ok("rivals are ranked by how many answers named them",
    many.topCompetitors[0]?.name === "Compass" && many.topCompetitors[0]?.citations === 2)
}

console.log("\n═══ 6. Competitor detection is conservative ═══")
{
  const targets = [{ name: "Compass Real Estate", domain: "compass.com" }, { name: "KW", domain: null }]
  ok("a domain match counts",
    detectCompetitorCitations("see compass.com for more", targets).includes("Compass Real Estate"))
  ok("a full name match counts",
    detectCompetitorCitations("Compass Real Estate leads the area", targets).includes("Compass Real Estate"))
  ok("a SHORT name is skipped rather than matched inside other words — a false\n    competitor citation understates our own share and sends a broker chasing\n    a rival who was never mentioned",
    !detectCompetitorCitations("the kwikset lock and awkward layout", targets).includes("KW"))
  ok("empty text finds nobody", detectCompetitorCitations("", targets).length === 0)
  ok("no targets finds nobody", detectCompetitorCitations("Compass Real Estate", []).length === 0)
  ok("results are de-duplicated and stable",
    JSON.stringify(detectCompetitorCitations("compass.com and Compass Real Estate", targets))
      === JSON.stringify(["Compass Real Estate"]))
}

console.log("\n═══ 7. The monitor records it from the SAME answer ═══")
{
  const m = code("lib/kernel/ai-search-citation-monitor.ts")
  ok("both passes detect competitors from the already-fetched text — no extra\n    provider call",
    (m.match(/detectCompetitorCitations\(fetched\.text, competitorTargets\)/g) ?? []).length === 2)
  ok("both passes persist it", (m.match(/competitors_cited: competitorsCited/g) ?? []).length === 2)
  ok("NULL when the search never ran — an empty array would claim we looked and\n    found nobody, which is a different and false statement",
    (m.match(/ran \? detectCompetitorCitations\([^)]*\) : null/g) ?? []).length === 2)
  ok("the watch list is loaded ONCE per pass, not per page",
    (m.match(/await loadCompetitorTargets\(supabase, brokerageId\)/g) ?? []).length === 2)
  ok("both competitor tables are merged, so a rival added in one surface is not\n    invisible to the other",
    m.includes('from("competitors")') && m.includes('from("competitor_profiles")'))
  ok("a competitor read failure never breaks the citation monitor — share of\n    voice is an enrichment, our own outcome is the record",
    /catch \{ \/\* enrichment only \*\/ \}/.test(src("lib/kernel/ai-search-citation-monitor.ts")))
}

console.log("\n═══ 8. The surface shows both numbers, and the null honestly ═══")
{
  const card = code("app/dashboard/marketing/seo/citation-share-card.tsx")
  const page = code("app/dashboard/marketing/seo/page.tsx")
  ok("the card is mounted on the GEO tab", page.includes("<CitationShareCard rows={shareRows}"))
  ok("...fed from project_id + observed_on so it can collapse to answers",
    page.includes("project_id") && page.includes("observed_on"))
  ok("...and from the competitor column", page.includes("competitors_cited"))
  ok("both metrics are rendered", card.includes("Citation rate") && card.includes("Share of voice"))
  ok("a null share renders as an em-dash, never as 0%",
    /share\.shareOfVoicePct === null \? "—"/.test(card))
  ok("the unreadable-answer count is surfaced rather than hidden",
    card.includes("share.queriesNotChecked > 0"))
  ok("the sample size shown is ANSWERS READ",
    /of \$\{share\.queriesChecked\} answers read|answers read/.test(card))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`CITATION SHARE — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nThe GEO KPI reports answers READ, not rows written, and never")
  console.log("turns 'nobody was named' into '0% share of voice'.")
  process.exit(1)
}
console.log("Citation share tells a broker the truth, including when the truth is 'we don't know yet'.")
