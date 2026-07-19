#!/usr/bin/env tsx
/**
 * scripts/intelligence-report-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the MONTHLY INTELLIGENCE REPORT composer (lib/kernel/intelligence-report.ts)
 * — the pure fold behind the owner page AND the board packet's "AI Team
 * Intelligence" section (one implementation, two surfaces):
 *
 *   1. WINDOW MATH — monthWindow / priorMonthKey / lastMonthKeys (UTC, exclusive end).
 *   2. HONEST OMISSION — a loop with no data this month is OMITTED, never zero-padded;
 *      an all-quiet month composes an EMPTY report.
 *   3. DELTAS — month-over-month count deltas and the approval-rate arc.
 *   4. HEADLINE SELECTION — "74%→86% — your edits are teaching the team" vs the dip
 *      copy vs the no-baseline copy; trust's losses-down / zero-loss / lossy variants;
 *      autonomy's earned-this-month vs in-force variants.
 *   5. BOARD PACKET FUSION — composeBoardPacketMarkdown renders the same sections
 *      when present and omits the block entirely when absent.
 *
 * Pure Layer 1 only — no DB. Run: npx tsx scripts/intelligence-report-simulator.ts
 */
import {
  approvalRatePct,
  composeIntelligenceReport,
  countDelta,
  describeGrantShape,
  lastMonthKeys,
  monthWindow,
  priorMonthKey,
  type IntelligenceFacts,
} from "../lib/kernel/intelligence-report"
import { composeBoardPacketMarkdown, type BoardPacketData } from "../lib/kernel/board-packet"
import type { DraftQuality } from "../lib/kernel/draft-quality"

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
  console.log(" ✅ Intelligence report verified — honest omission, real deltas, earned headlines.")
  console.log(" INTELLIGENCE_REPORT_PASS")
  process.exit(0)
}

const quietDrafts: DraftQuality = { drafted: 0, accepted: 0, dismissed: 0, pending: 0, sentUntouched: 0, avgEditPct: null }
const draftsQ = (drafted: number, accepted: number, untouched: number, avgEditPct: number | null): DraftQuality =>
  ({ drafted, accepted, dismissed: 0, pending: drafted - accepted, sentUntouched: untouched, avgEditPct })

const quietActivity = { callsAnswered: 0, appointmentsBooked: 0, draftsProduced: 0, dealsAdvanced: 0, signalsRaised: 0 }
const quietFacts = (): IntelligenceFacts => ({
  monthKey: "2026-06",
  monthLabel: "June 2026",
  priorMonthLabel: "May 2026",
  drafts: { current: { ...quietDrafts }, prior: { ...quietDrafts } },
  autonomy: { grantedShapes: [], declined: 0, totalGrants: [] },
  attribution: { current: { attributedGciCents: 0, attributedDeals: 0 }, prior: { attributedGciCents: 0, attributedDeals: 0 } },
  sellerReach: { current: { visits: 0, leads: 0 }, prior: { visits: 0, leads: 0 } },
  activity: { current: { ...quietActivity }, prior: { ...quietActivity } },
  trust: { writeLosses: 0, priorWriteLosses: 0, healed: 0, escalated: 0 },
  promoters: { quotes: [] },
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Intelligence report simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · month-window math]")
  const w = monthWindow("2026-06")
  check("window start is the UTC first instant", w.startIso === "2026-06-01T00:00:00.000Z")
  check("window end is EXCLUSIVE (first instant of next month)", w.endIso === "2026-07-01T00:00:00.000Z")
  check("window label is owner-readable", w.label === "June 2026")
  check("prior month key", priorMonthKey("2026-06") === "2026-05")
  check("prior month key crosses the year boundary", priorMonthKey("2026-01") === "2025-12")
  const keys = lastMonthKeys(6, new Date(Date.UTC(2026, 6, 18))) // July 18, 2026
  check("last-6 keys, newest first", keys[0] === "2026-07" && keys[5] === "2026-02" && keys.length === 6)
  let threw = false
  try { monthWindow("June 2026") } catch { threw = true }
  check("bad month key throws (never a silent wrong window)", threw)

  console.log("\n[Layer 1 · honest omission — no zero-padding, ever]")
  const empty = composeIntelligenceReport(quietFacts())
  check("all-quiet month composes an EMPTY report", empty.empty && empty.sections.length === 0)
  const oneLoop = quietFacts()
  oneLoop.attribution.current = { attributedGciCents: 12_500_00, attributedDeals: 1 }
  const oneReport = composeIntelligenceReport(oneLoop)
  check("only the earned section renders", oneReport.sections.length === 1 && oneReport.sections[0].id === "attribution")
  check("draft section omitted when nothing drafted", !oneReport.sections.some((s) => s.id === "draft_quality"))
  check("trust omitted with no history at all", !oneReport.sections.some((s) => s.id === "trust"))
  const priorOnlyDrafts = quietFacts()
  priorOnlyDrafts.drafts.prior = draftsQ(10, 8, 5, 10)
  check("prior-month-only drafts do NOT render a section (no data THIS month)",
    !composeIntelligenceReport(priorOnlyDrafts).sections.some((s) => s.id === "draft_quality"))

  console.log("\n[Layer 1 · deltas]")
  check("countDelta up", countDelta(12, 8) === "↑ 4 vs last month")
  check("countDelta down", countDelta(3, 7) === "↓ 4 vs last month")
  check("countDelta even", countDelta(5, 5) === "even with last month")
  check("countDelta with no baseline month is null (never an invented delta)", countDelta(9, 0) === null)
  check("approval rate math", approvalRatePct(draftsQ(50, 43, 20, 8)) === 86)
  check("approval rate null when nothing drafted", approvalRatePct(quietDrafts) === null)

  console.log("\n[Layer 1 · headline selection — draft flywheel]")
  const improving = quietFacts()
  improving.drafts.current = draftsQ(50, 43, 30, 6)   // 86%
  improving.drafts.prior = draftsQ(38, 28, 12, 14)    // 74%
  const impSection = composeIntelligenceReport(improving).sections.find((s) => s.id === "draft_quality")!
  check("improving month names the arc 74%→86%", impSection.headline.includes("74%→86%"))
  check("…and credits the owner's edits", /your edits are teaching the team/.test(impSection.headline))
  check("avg-edit line carries the falling-edit delta", impSection.lines.some((l) => l.label.includes("Average edit") && l.delta === "↓ from 14% last month"))
  const dipping = quietFacts()
  dipping.drafts.current = draftsQ(40, 24, 10, 12)    // 60%
  dipping.drafts.prior = draftsQ(38, 28, 12, 9)       // 74%
  const dipSection = composeIntelligenceReport(dipping).sections.find((s) => s.id === "draft_quality")!
  check("dipping month is honest (74%→60%), never spun", dipSection.headline.includes("74%→60%") && /dipped/.test(dipSection.headline))
  const firstMonth = quietFacts()
  firstMonth.drafts.current = draftsQ(14, 9, 6, 11)
  const firstSection = composeIntelligenceReport(firstMonth).sections.find((s) => s.id === "draft_quality")!
  check("no-baseline month states the counts, no invented rate arc", /drafted 14 replies/.test(firstSection.headline) && !/%→/.test(firstSection.headline))

  console.log("\n[Layer 1 · headline selection — earned autonomy]")
  const earned = quietFacts()
  earned.autonomy = {
    grantedShapes: ["deadline_correction:closing_date"],
    declined: 1,
    totalGrants: ["deadline_correction:closing_date", "deadline_propose:inspection", "social_post:market_update"],
  }
  const autSection = composeIntelligenceReport(earned).sections.find((s) => s.id === "earned_autonomy")!
  check("earned-this-month headline counts the new grant + total in force", /1 new autonomy grant/.test(autSection.headline) && /3 moves now run/.test(autSection.headline))
  check("grant shape reads in plain language", autSection.lines.some((l) => l.value === "correct the closing date deadline from scanned documents"))
  check("declined proposals stay visible (honesty)", autSection.lines.some((l) => /declined/i.test(l.label) && l.value.startsWith("1")))
  const inForceOnly = quietFacts()
  inForceOnly.autonomy = { grantedShapes: [], declined: 0, totalGrants: ["deadline_propose:appraisal"] }
  const inForceSection = composeIntelligenceReport(inForceOnly).sections.find((s) => s.id === "earned_autonomy")!
  check("in-force-only month uses the standing-grants headline", /1 earned-autonomy grant in force/.test(inForceSection.headline))
  check("shape describer covers marketing shapes", describeGrantShape("social_post:just_listed") === "publish just listed social posts")

  console.log("\n[Layer 1 · headline selection — activity + attribution]")
  const busy = quietFacts()
  busy.activity.current = { callsAnswered: 31, appointmentsBooked: 4, draftsProduced: 0, dealsAdvanced: 0, signalsRaised: 0 }
  busy.activity.prior = { ...quietActivity, callsAnswered: 20 }
  const actSection = composeIntelligenceReport(busy).sections.find((s) => s.id === "activity")!
  check("activity headline narrates only the nonzero work", /31 calls answered \(4 booked live\)/.test(actSection.headline) && !/deal/.test(actSection.headline) && !/draft/.test(actSection.headline))
  check("activity lines omit metrics with no data either month", !actSection.lines.some((l) => /Deals advanced/.test(l.label)))
  check("activity call delta is real", actSection.lines.find((l) => /Inbound calls/.test(l.label))?.delta === "↑ 11 vs last month")
  const attr = quietFacts()
  attr.attribution.current = { attributedGciCents: 84_000_000, attributedDeals: 3 }
  attr.attribution.prior = { attributedGciCents: 52_000_000, attributedDeals: 2 }
  const attrSection = composeIntelligenceReport(attr).sections.find((s) => s.id === "attribution")!
  check("attribution headline: measured, not claimed", /\$840K closed volume/.test(attrSection.headline) && /measured by the attribution engine/.test(attrSection.headline))
  check("attribution volume line carries prior-month money delta", attrSection.lines.some((l) => l.delta === "↑ from $520K last month"))

  console.log("\n[Layer 1 · seller-driven reach — earned distribution]")
  const reach = quietFacts()
  reach.sellerReach.current = { visits: 41, leads: 3 }
  reach.sellerReach.prior = { visits: 22, leads: 1 }
  const reachSection = composeIntelligenceReport(reach).sections.find((s) => s.id === "seller_reach")!
  check("seller-reach section renders when a seller's share drove visits", !!reachSection)
  check("headline counts the visits and the showing conversions", /41 visits/.test(reachSection.headline) && /3 asked for a showing/.test(reachSection.headline))
  check("headline names it as unpaid distribution", /didn't pay for/.test(reachSection.headline))
  check("visits line carries the month-over-month delta", reachSection.lines.find((l) => /Seller-shared visits/.test(l.label))?.delta === "↑ 19 vs last month")
  check("showing-conversion line present with its own delta", reachSection.lines.some((l) => /requested a showing/.test(l.label) && l.value === "3" && l.delta === "↑ 2 vs last month"))
  const reachNoLeads = quietFacts()
  reachNoLeads.sellerReach.current = { visits: 8, leads: 0 }
  const reachNoLeadsSection = composeIntelligenceReport(reachNoLeads).sections.find((s) => s.id === "seller_reach")!
  check("visits-but-no-leads month uses the reach-only headline (never narrates a zero)", /reach you didn't pay for/.test(reachNoLeadsSection.headline) && !/showing/.test(reachNoLeadsSection.headline))
  check("conversion line omitted when neither month had a lead", !reachNoLeadsSection.lines.some((l) => /requested a showing/.test(l.label)))
  check("seller-reach section OMITTED when no seller-driven visits this month (never zero-padded)",
    !composeIntelligenceReport(quietFacts()).sections.some((s) => s.id === "seller_reach"))
  const reachPriorOnly = quietFacts()
  reachPriorOnly.sellerReach.prior = { visits: 15, leads: 2 }
  check("prior-month-only seller reach does NOT render (no data THIS month)",
    !composeIntelligenceReport(reachPriorOnly).sections.some((s) => s.id === "seller_reach"))
  check("all-quiet month stays EMPTY with the sellerReach field present",
    composeIntelligenceReport(quietFacts()).empty)

  console.log("\n[Layer 1 · headline selection — trust]")
  const healthier = quietFacts()
  healthier.trust = { writeLosses: 1, priorWriteLosses: 6, healed: 4, escalated: 0 }
  const trustDown = composeIntelligenceReport(healthier).sections.find((s) => s.id === "trust")!
  check("losses-down month leads with the 6→1 trend", /6→1/.test(trustDown.headline) && /healthier/.test(trustDown.headline))
  const clean = quietFacts()
  clean.trust = { writeLosses: 0, priorWriteLosses: 0, healed: 7, escalated: 0 }
  const trustClean = composeIntelligenceReport(clean).sections.find((s) => s.id === "trust")!
  check("clean month: self-healed with zero losses", /7 breaks self-healed/.test(trustClean.headline) && /zero data losses/.test(trustClean.headline))
  const lossy = quietFacts()
  lossy.trust = { writeLosses: 5, priorWriteLosses: 0, healed: 0, escalated: 0 }
  const trustLossy = composeIntelligenceReport(lossy).sections.find((s) => s.id === "trust")!
  check("lossy month is named, not hidden", /5 write losses/.test(trustLossy.headline) && /named, not hidden/.test(trustLossy.headline))
  const zeroAfterLossy = quietFacts()
  zeroAfterLossy.trust = { writeLosses: 0, priorWriteLosses: 4, healed: 0, escalated: 0 }
  const trustZero = composeIntelligenceReport(zeroAfterLossy).sections.find((s) => s.id === "trust")
  check("zero-loss month AFTER a lossy month still renders (the trend IS data)", !!trustZero && /4→0/.test(trustZero.headline))

  console.log("\n[Layer 1 · promoter quotes — the team's own words]")
  const withQuotes = quietFacts()
  withQuotes.promoters = { quotes: ["The AI receptionist books showings while I sleep.", "Best money we spend every month."] }
  const quotesReport = composeIntelligenceReport(withQuotes)
  const quotesSection = quotesReport.sections.find((s) => s.id === "promoter_quotes")
  check("promoter section renders when verbatims exist", !!quotesSection)
  check("headline counts the promoters (9+ scorers)", /2 of your own team scored the platform 9\+/.test(quotesSection?.headline ?? ""))
  check("each verbatim renders as its own quoted line", quotesSection?.lines.length === 2
    && quotesSection.lines.every((l) => l.label === "In their words" && l.delta === null)
    && quotesSection.lines.some((l) => l.value === "“The AI receptionist books showings while I sleep.”"))
  const oneQuote = quietFacts()
  oneQuote.promoters = { quotes: ["Loving it."] }
  const oneQuoteSection = composeIntelligenceReport(oneQuote).sections.find((s) => s.id === "promoter_quotes")!
  check("single promoter gets the singular headline", /One of your own team scored the platform 9\+/.test(oneQuoteSection.headline))
  check("promoter section OMITTED when no verbatims this month (never zero-padded)",
    !composeIntelligenceReport(quietFacts()).sections.some((s) => s.id === "promoter_quotes"))
  const blankQuotes = quietFacts()
  blankQuotes.promoters = { quotes: ["   ", ""] }
  check("whitespace-only verbatims never render a section",
    !composeIntelligenceReport(blankQuotes).sections.some((s) => s.id === "promoter_quotes"))
  const quotesPlusOther = quietFacts()
  quotesPlusOther.attribution.current = { attributedGciCents: 1_000_00, attributedDeals: 1 }
  check("month with other data but no verbatims still omits the promoter section",
    !composeIntelligenceReport(quotesPlusOther).sections.some((s) => s.id === "promoter_quotes"))
  check("all-quiet month stays EMPTY with the promoters field present",
    composeIntelligenceReport(quietFacts()).empty)

  console.log("\n[Layer 1 · board-packet fusion — one composer, two surfaces]")
  const packetBase: BoardPacketData = {
    brokerageName: "Kling Group", monthLabel: "June 2026",
    newContacts: 12, activeListings: 5, closedCount: 2, closedVolumeCents: 90_000_000,
    showings: 9, openHouses: 1, aiCallsAnswered: 31, aiOutboundConnects: 6, aiBookings: 4,
    draftsUsed: 9, optOutsHonored: 1, attributedGciCents: 84_000_000, attributedDeals: 3,
  }
  const withIntel = composeBoardPacketMarkdown({ ...packetBase, intelligence: composeIntelligenceReport(improving).sections })
  check("packet renders the AI Team Intelligence block", /## AI Team Intelligence/.test(withIntel))
  check("packet carries the composer's exact headline (no second formula)", withIntel.includes("74%→86%"))
  const withoutIntel = composeBoardPacketMarkdown(packetBase)
  check("packet with no intelligence sections omits the block entirely", !/AI Team Intelligence/.test(withoutIntel))
  const reachPacket = composeBoardPacketMarkdown({ ...packetBase, intelligence: composeIntelligenceReport(reach).sections })
  check("packet renders the seller-driven reach section through the same composer (no second surface)",
    reachPacket.includes("**Seller-driven reach — earned distribution**") && reachPacket.includes("3 asked for a showing"))
  const withQuotesPacket = composeBoardPacketMarkdown({ ...packetBase, intelligence: composeIntelligenceReport(withQuotes).sections })
  check("packet carries the promoter verbatims as quoted sub-bullets",
    withQuotesPacket.includes("  - “Best money we spend every month.”"))
  check("packet without verbatims carries no quote sub-bullets", !withIntel.includes("  - “"))

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
