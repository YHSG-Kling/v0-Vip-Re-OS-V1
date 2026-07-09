// scripts/session-rails-simulator.ts   (npm run test:session-rails)
// ─────────────────────────────────────────────────────────────────────────────
// THE MANAGER-COVERAGE PROOF for the operational rails shipped this cycle:
// signature-chase, overnight digest, board packet (PDF + GCI attribution),
// and listing propensity. Three layers: (1) each rail's PURE brain matrix,
// (2) every rail's cron is REGISTERED on the dispatcher and its route file
// exists, (3) every rail is OWNED by a manager in the registry with THIS
// runnable proof — "all managers are working their crons" as CI, not a claim.

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { classifySignatureStall, composeChaseLine, chaseTag } from "../lib/kernel/signature-chase"
import { composeOvernightDigest } from "../lib/kernel/overnight-digest"
import { composeBoardPacketMarkdown } from "../lib/kernel/board-packet"
import { buildBoardPacketReelProps, BOARD_PACKET_REEL_COMPOSITION } from "../lib/kernel/board-packet-reel"
import { scoreListingPropensity, composePropensityBrief, PROPENSITY_BRIEF_THRESHOLD } from "../lib/kernel/listing-propensity"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const check = (n: string, ok: boolean, d?: string) => { if (ok) { passed++; console.log(`  ✓ ${n}`) } else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: signature chase ──")
{
  const now = new Date("2026-07-08T12:00:00Z")
  check("48h/96h boundaries: fresh none → 72h nudge → 108h escalate",
    classifySignatureStall({ esign_status: "sent", sent_at: "2026-07-07T12:00:00Z" }, now) === "none"
    && classifySignatureStall({ esign_status: "sent", sent_at: "2026-07-05T12:00:00Z" }, now) === "nudge"
    && classifySignatureStall({ esign_status: "sent", sent_at: "2026-07-04T00:00:00Z" }, now) === "escalate")
  check("terminal + undated NEVER chase (no fabricated stalls)",
    classifySignatureStall({ esign_status: "fully_signed", sent_at: "2026-07-01T00:00:00Z" }, now) === "none"
    && classifySignatureStall({ esign_status: "declined", sent_at: "2026-07-01T00:00:00Z" }, now) === "none"
    && classifySignatureStall({ esign_status: "sent" }, now) === "none")
  check("deal docs chase via signature_status 'pending' + created_at anchor",
    classifySignatureStall({ signature_status: "pending", created_at: "2026-07-05T00:00:00Z" }, now) === "nudge")
  check("chase lines name the doc + the next move; the dedupe tag is per row+tier",
    composeChaseLine("Purchase Agreement", "sent", "escalate", 100).includes("phone call")
    && composeChaseLine("listing agreement", "pending", "nudge", 60).includes("personal nudge")
    && chaseTag("contract_signatures", "abc", "nudge") === "[SIG_CHASE:nudge] [contract_signatures:abc]")
}

console.log("\n── PURE: overnight digest ──")
{
  const busy = composeOvernightDigest({ callsAnswered: 3, bookings: 1, rsvps: 2, sellerLeads: 1, hotCallbacks: 1, textsReceived: 4 })
  check("busy night narrated with action lines (CMA waiting, callbacks queued)",
    busy.includes("answered 3 calls") && busy.includes("booked 1 appointment")
    && busy.includes("what their home is worth") && busy.includes("same-day callback"))
  check("silent night → empty (never pads)",
    composeOvernightDigest({ callsAnswered: 0, bookings: 0, rsvps: 0, sellerLeads: 0, hotCallbacks: 0, textsReceived: 0 }) === "")
}

console.log("\n── PURE: board packet ──")
{
  const md = composeBoardPacketMarkdown({
    brokerageName: "X", monthLabel: "June 2026", newContacts: 1, activeListings: 1,
    closedCount: 2, closedVolumeCents: 100000000, showings: 1, openHouses: 1,
    aiCallsAnswered: 1, aiOutboundConnects: 1, aiBookings: 1, draftsUsed: 1,
    optOutsHonored: 1, attributedGciCents: 41200000, attributedDeals: 2,
  })
  check("packet carries production + the AI team's measured month + the GCI-attribution retention line",
    md.includes("$1,000,000") && md.includes("Marketing-attributed closed volume") && md.includes("412,000") && md.includes("compliance is a feature"))
  check("delivered as PDF (owner rule) — pdf-lib renderer wired in the runner",
    src("lib/kernel/board-packet.ts").includes("renderBoardPacketPdf") && src("lib/kernel/board-packet.ts").includes('"application/pdf"'))
}

console.log("\n── PURE: board packet as VIDEO (the AI team presents the month) ──")
{
  const FULL = {
    brokerageName: "X", monthLabel: "June 2026", newContacts: 1, activeListings: 1,
    closedCount: 2, closedVolumeCents: 100000000, showings: 1, openHouses: 1,
    aiCallsAnswered: 12, aiOutboundConnects: 1, aiBookings: 3, draftsUsed: 4,
    optOutsHonored: 1, attributedGciCents: 41200000, attributedDeals: 2,
  }
  const props = buildBoardPacketReelProps(FULL)
  check("KEEP-ONE: the video reuses the PartnersMeetingReel composition (no second Remotion surface)",
    BOARD_PACKET_REEL_COMPOSITION === "PartnersMeetingReel")
  check("the ATTRIBUTION RECEIPT is a finance card + spoken in the narration (measured, not claimed)",
    props.cards.some((c) => c.kind === "finance" && c.label.includes("ATTRIBUTED") && c.sub!.includes("receipts"))
    && props.narration!.includes("attribution engine, not claimed"))
  check("earned cards only: a busy month earns team+finance+compliance; an empty month earns NONE",
    props.cards.length === 6 && props.cards.some((c) => c.kind === "compliance")
    && buildBoardPacketReelProps({ ...FULL, closedCount: 0, closedVolumeCents: 0, aiCallsAnswered: 0, aiBookings: 0, draftsUsed: 0, optOutsHonored: 0, attributedGciCents: 0, attributedDeals: 0 }).cards.length === 0)
  check("the runner QUEUES the reel with the PDF; the deliver phase sweeps completed renders",
    src("lib/kernel/board-packet.ts").includes("queueBoardPacketReel")
    && src("app/api/cron/board-packet/route.ts").includes("deliverBoardPacketReels")
    && src("lib/kernel/cron-dispatch.ts").includes("board-packet?phase=deliver"))
}

console.log("\n── PURE: listing propensity ──")
{
  const hot = scoreListingPropensity({ homeValueChecks90d: 2, latestEstimatedEquity: 250000, sellIntentCalls90d: 1, sellerHandRaises90d: 1, equityTouches90d: 0, isAlreadySeller: false })
  check("hot homeowner scores past the brief threshold with traceable reasons",
    hot.score >= PROPENSITY_BRIEF_THRESHOLD && hot.reasons.length >= 3 && hot.reasons.some((r) => r.includes("equity")))
  check("no signals → 0; active sellers excluded (worked by listing plays, not scored)",
    scoreListingPropensity({ homeValueChecks90d: 0, latestEstimatedEquity: null, sellIntentCalls90d: 0, sellerHandRaises90d: 0, equityTouches90d: 0, isAlreadySeller: false }).score === 0
    && scoreListingPropensity({ homeValueChecks90d: 5, latestEstimatedEquity: 500000, sellIntentCalls90d: 2, sellerHandRaises90d: 1, equityTouches90d: 1, isAlreadySeller: true }).score === 0)
  check("the weekly brief names homeowners + hands to the Listing Concierge; empty → empty",
    composePropensityBrief([{ name: "Dana K", score: 95, reasons: ["checked value", "equity"] }]).includes("ready to list")
    && composePropensityBrief([]) === "")
  check("the runner reads the REAL timestamp column (generated_at — the drift guard caught created_at)",
    src("lib/kernel/listing-propensity.ts").includes("generated_at") && !src("lib/kernel/listing-propensity.ts").includes('gte("created_at", since).limit(1000)'))
}

console.log("\n── KEEP-ONE: recruiting depth already has its single brains ──")
{
  // A 'recruiting depth' pass nearly shipped a SECOND recruit ranker and a
  // SECOND flight-risk scorer. The investigation found both already exist and
  // are richer — these checks make that consolidation a CI invariant.
  check("recruit PRIORITY has ONE brain: the switch-propensity scout, riding the weekly recruit-outreach cron",
    existsSync(join(process.cwd(), "lib/recruiting/switch-propensity.ts"))
    && src("app/api/cron/recruit-outreach/route.ts").includes("runSwitchPropensityScoutAll")
    && !existsSync(join(process.cwd(), "lib/kernel/recruit-retention.ts")))
  check("agent RETENTION has ONE brain: the retention radar, riding the daily compliance-monitoring cron",
    existsSync(join(process.cwd(), "lib/recruiting/retention-score.ts"))
    && src("app/api/cron/compliance-monitoring/route.ts").includes("runRetentionRadarAll"))
  check("both recruiting brains are registry-owned by the recruiting_manager",
    /retention_radar/.test(src("lib/kernel/manager-registry.ts")) && /switch_propensity/.test(src("lib/kernel/manager-registry.ts")))
}

console.log("\n── MANAGER COVERAGE: every rail owned, scheduled, and real ──")
{
  const RAILS: Array<{ domain: string; manager: string; cron: string }> = [
    { domain: "signature_chase", manager: "deal_coordinator", cron: "/api/cron/signature-chase" },
    { domain: "overnight_digest", manager: "ai_isa", cron: "/api/cron/overnight-digest" },
    { domain: "board_packet", manager: "finance_manager", cron: "/api/cron/board-packet" },
    { domain: "listing_propensity", manager: "listing_concierge", cron: "/api/cron/listing-propensity" },
    { domain: "voice_intelligence_sweep", manager: "ai_isa", cron: "/api/cron/voice-call-analysis" },
  ]
  const dispatch = src("lib/kernel/cron-dispatch.ts")
  for (const r of RAILS) {
    const d = (MAINTENANCE_DOMAINS as any)[r.domain]
    check(`${r.domain}: owned by ${r.manager} + cron registered + route file exists`,
      d?.manager === r.manager && dispatch.includes(`"${r.cron}"`)
      && existsSync(join(process.cwd(), `app${r.cron}/route.ts`)))
  }
  check("every registry proof for these rails is THIS runnable simulator (no phantom proofs)",
    ["signature_chase", "overnight_digest", "board_packet", "listing_propensity"]
      .every((k) => (MAINTENANCE_DOMAINS as any)[k]?.proof === "test:session-rails"))
  check("package.json wires the proof", /"test:session-rails":/.test(src("package.json")))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ SESSION_RAILS_FAIL"); process.exit(1) }
console.log(" ✅ SESSION_RAILS_PASS — every rail owned by its manager, scheduled on the dispatcher, and proven pure")
