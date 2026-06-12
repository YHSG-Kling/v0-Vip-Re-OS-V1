#!/usr/bin/env tsx
/**
 * scripts/voice-delegation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE DELEGATION harness — the post-call flow: agent hangs up, speaks, the team
 * executes ON THE EXISTING RAILS (gate + sequences), never around them.
 *
 * Layer 1 (pure): composeFollowUp (dictation wins; default is warm, no pressure);
 *   pickSequence (active only; nurture-type preferred; none → null);
 *   composeOptimizeTourSpoken (new order + ESTIMATE label + honest un-geocoded note);
 *   rankAtRiskDeals + composeClosingsAtRiskSpoken (at_risk before tight, least slack
 *   first; process-only Fair-Housing-safe copy); composeEquityReportSpoken (queued vs
 *   the honest no-valuation / withdrawn / duplicate skips).
 * Layer 2 (live, gated): seed a contact + an active sequence; voiceFollowUp →
 *   gate message proposed AND approved BY THE AGENT (real human id, full audit),
 *   portal channel for a contact with no email; voiceStartMarketing → active
 *   enrollment (enrolled_by = agent), second call refuses to double-enroll;
 *   a WITHDRAWN contact refuses BOTH. NEW VERBS: voiceOptimizeTour → the buyer's
 *   planned tour is reordered by the REAL optimizer (injected coords, no network);
 *   voiceClosingsAtRisk → the seeded under-contract deal surfaces at_risk with its
 *   binding constraint (read-only); voiceSendEquityReport → ONE gated equity proposal
 *   lands in the queue (injected valuation, never autonomous). Self-cleans.
 *
 * Run: npx tsx scripts/voice-delegation-simulator.ts  (npm run test:voice-delegation)
 */
import {
  composeFollowUp, pickSequence, voiceFollowUp, voiceStartMarketing, matchListingByAddress,
  promoEventForStatus, voiceCutPromo, type PromoDispatcher,
  composeOptimizeTourSpoken, voiceOptimizeTour,
  rankAtRiskDeals, composeClosingsAtRiskSpoken, voiceClosingsAtRisk, type AtRiskDeal,
  composeEquityReportSpoken, voiceSendEquityReport,
  normalizeVideoKind, normalizeVideoChannel, composeCommissionSpoken, voiceCommissionVideo,
  type CommissionDispatcher,
} from "../lib/kernel/voice-delegation"

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
  console.log(" ✅ Voice delegation verified — spoken instruction, governed execution")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Voice delegation simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · compose + pick]")
  const dictated = composeFollowUp("Jordan", "Thanks for the call — inspection report comes Tuesday.")
  check("dictation wins verbatim", dictated.body === "Thanks for the call — inspection report comes Tuesday.")
  const dflt = composeFollowUp("Jordan", null)
  check("default follow-up: warm, named, zero pressure", dflt.body.includes("Jordan") && !/buy now|act fast|limited/i.test(dflt.body))
  const seqs = [
    { id: "a", name: "Blast", is_active: true, sequence_type: "promo" },
    { id: "b", name: "Spring Nurture", is_active: true, sequence_type: "nurture" },
    { id: "c", name: "Old", is_active: false, sequence_type: "nurture" },
  ]
  check("pickSequence: nurture-type preferred among ACTIVE", pickSequence(seqs)?.id === "b")
  check("pickSequence: inactive never picked; none active → null", pickSequence([seqs[2]]) === null)

  const listings = [
    { id: "L1", address: "44 Birch Lane" },
    { id: "L2", address: "144 Birch Lane" },
    { id: "L3", address: "44 Maple St" },
  ]
  check("'44 Birch' → 44 Birch Lane (digits exact, street prefix)", matchListingByAddress(listings, "44 Birch")?.id === "L1")
  check("'44 Birch' never grabs 144 Birch (no fuzzy digits)", matchListingByAddress(listings, "144 birch")?.id === "L2")
  check("unknown address → null", matchListingByAddress(listings, "9 Elm") === null)
  check("promo moment follows listing status (sold → just_sold, pending → under_contract)",
    promoEventForStatus("sold") === "just_sold" && promoEventForStatus("pending") === "under_contract" && promoEventForStatus("active") === "just_listed")

  console.log("\n[Layer 1 · optimize-tour spoken]")
  const tourAllPlaced = composeOptimizeTourSpoken({
    buyerName: "the Hendersons",
    stops: [{ address: "1 Near St", sequenced: true }, { address: "50 Mid Ave", sequenced: true }, { address: "300 Far St", sequenced: true }],
    totalDriveMinutes: 42, stopsSequenced: 3, stopsTotal: 3,
  })
  check("optimize-tour: speaks the new running order", tourAllPlaced.includes("1 Near St, then 50 Mid Ave, then 300 Far St"))
  check("optimize-tour: drive time ALWAYS labeled an estimate (never a traffic claim)",
    tourAllPlaced.includes("42 minutes of estimated drive time") && /not live traffic/i.test(tourAllPlaced))
  const tourOneUnplaced = composeOptimizeTourSpoken({
    buyerName: "Jordan",
    stops: [{ address: "1 Near St", sequenced: true }, { address: "50 Mid Ave", sequenced: true }, { address: "PO Box 9", sequenced: false }],
    totalDriveMinutes: 18, stopsSequenced: 2, stopsTotal: 3,
  })
  check("optimize-tour: un-geocoded stop called out HONESTLY by name", tourOneUnplaced.includes("PO Box 9") && tourOneUnplaced.includes("couldn't map"))
  const tourNoneSequenced = composeOptimizeTourSpoken({
    buyerName: "Jordan", stops: [{ address: "PO Box 9", sequenced: false }], totalDriveMinutes: 0, stopsSequenced: 0, stopsTotal: 1,
  })
  check("optimize-tour: no drive sentence when <2 stops sequenced (no fabricated estimate)", !/estimated drive time/.test(tourNoneSequenced))

  console.log("\n[Layer 1 · closings-at-risk spoken]")
  const dealsRaw: AtRiskDeal[] = [
    { transactionId: "t1", dealName: "Ok Deal", severity: "ok", bindingLabel: "Appraisal", slackDays: 10, daysToClosing: 30, closingDate: "2026-07-30" },
    { transactionId: "t2", dealName: "Tight Deal", severity: "tight", bindingLabel: "Loan commitment", slackDays: 2, daysToClosing: 12, closingDate: "2026-06-24" },
    { transactionId: "t3", dealName: "Risky Deal", severity: "at_risk", bindingLabel: "Appraisal", slackDays: -3, daysToClosing: 8, closingDate: "2026-06-20" },
    { transactionId: "t4", dealName: "Risky Less", severity: "at_risk", bindingLabel: "Inspection", slackDays: -1, daysToClosing: 5, closingDate: "2026-06-17" },
  ]
  const ranked = rankAtRiskDeals(dealsRaw)
  check("at-risk rank: at_risk before tight before ok", ranked[0].severity === "at_risk" && ranked[3].severity === "ok")
  check("at-risk rank: within at_risk, least slack (most binding) first", ranked[0].transactionId === "t3" && ranked[1].transactionId === "t4")
  const atRiskSpoken = composeClosingsAtRiskSpoken(ranked, 1)
  check("at-risk: leads with the flagged count (2 at risk, 1 tight)", atRiskSpoken.includes("2 at risk, 1 tight"))
  check("at-risk: names the binding constraint + days of slack/short", atRiskSpoken.includes("binding constraint") && /short of the room|days? of slack/.test(atRiskSpoken))
  check("at-risk: process-only, Fair-Housing-safe (no people, just dates/constraints)", !/buyer|seller|family|client/i.test(atRiskSpoken))
  const clearWeek = composeClosingsAtRiskSpoken([{ ...dealsRaw[0] }], 0)
  check("at-risk: clear week speaks the good news honestly", /none of your under-contract deals are at risk/i.test(clearWeek))

  console.log("\n[Layer 1 · equity-report spoken]")
  const equityQueued = composeEquityReportSpoken({ contactName: "the Garcias", proposed: 1, skippedNoValuation: 0, skippedDuplicate: 0, skippedWithdrawn: 0, anniversariesDetected: 1 })
  check("equity: queued-for-approval confirmation (never an autonomous send)", equityQueued.ok && /waiting in your approval queue/i.test(equityQueued.spoken) && /until you approve/i.test(equityQueued.spoken))
  const equityNoVal = composeEquityReportSpoken({ contactName: "the Garcias", proposed: 0, skippedNoValuation: 1, skippedDuplicate: 0, skippedWithdrawn: 0, anniversariesDetected: 1 })
  check("equity: NO real valuation → honest skip, no estimate sent", !equityNoVal.ok && equityNoVal.skipReason === "no_valuation" && /couldn't get a real valuation/i.test(equityNoVal.spoken))
  const equityNoAnniv = composeEquityReportSpoken({ contactName: "the Garcias", proposed: 0, skippedNoValuation: 0, skippedDuplicate: 0, skippedWithdrawn: 0, anniversariesDetected: 0 })
  check("equity: no anniversary near today → honest skip", !equityNoAnniv.ok && equityNoAnniv.skipReason === "no_anniversary")
  const equityDup = composeEquityReportSpoken({ contactName: "the Garcias", proposed: 0, skippedNoValuation: 0, skippedDuplicate: 1, skippedWithdrawn: 0, anniversariesDetected: 1 })
  check("equity: duplicate this year → no double-draft, spoken honestly", equityDup.ok && /already has this year's/i.test(equityDup.spoken))
  const equityWithdrawn = composeEquityReportSpoken({ contactName: "the Garcias", proposed: 0, skippedNoValuation: 0, skippedDuplicate: 0, skippedWithdrawn: 1, anniversariesDetected: 1 })
  check("equity: withdrawn relationship refused with the reason spoken", !equityWithdrawn.ok && equityWithdrawn.skipReason === "withdrawn" && /withdrawn/i.test(equityWithdrawn.spoken))

  // ── VERB: commission_video — the Video Director takes the spoken command ──
  console.log("\n[Layer 1 · commission video (the Director takes the command)]")
  check("kind: 'market update reel' → market_update", normalizeVideoKind("make a market update reel") === "market_update")
  check("kind: 'home value video' → cma", normalizeVideoKind("cut a home value video for the Smiths") === "cma")
  check("kind: 'explainer about escrow' → explainer", normalizeVideoKind("make an explainer about escrow") === "explainer")
  check("kind: 'neighborhood spotlight' → neighborhood", normalizeVideoKind("a neighborhood spotlight for Oakdale") === "neighborhood")
  check("kind: 'testimonial reel' → testimonial", normalizeVideoKind("cut a testimonial reel") === "testimonial")
  check("kind: 'anniversary equity reel' → anniversary", normalizeVideoKind("make their anniversary equity reel") === "anniversary")
  check("kind: a listing promo phrase → null (routes through cut_promo, no overlap)", normalizeVideoKind("cut a promo reel for 44 Birch") === null)
  check("channel: 'for TikTok' → tiktok", normalizeVideoChannel("make it for tiktok") === "tiktok")
  check("channel: 'on YouTube' → youtube", normalizeVideoChannel("post on youtube") === "youtube")
  check("channel: default → instagram", normalizeVideoChannel("make a market update reel") === "instagram")
  check("spoken: staged describes format + brand intro + QR outro + compliance + approval queue",
    /JustListedReelSquare/.test(composeCommissionSpoken("new_listing", "tiktok", "JustListedReelSquare", "staged")) &&
    /QR/.test(composeCommissionSpoken("market_update", "instagram", "MarketUpdateReel", "staged")) &&
    /approval queue/.test(composeCommissionSpoken("explainer", "tiktok", "AgentExplainerReel", "staged")))
  check("spoken: already_staged → no duplicate render", /no duplicate/i.test(composeCommissionSpoken("cma", "email", "CMAReel", "already_staged")))
  check("spoken: blocked → nothing staged (honest)", /nothing was staged/i.test(composeCommissionSpoken("explainer", "tiktok", "AgentExplainerReel", "blocked")))
  // voiceCommissionVideo through an INJECTED dispatcher (no DB) — the seam the route uses.
  const commissioned = await voiceCommissionVideo({
    brokerageId: "b1", agentUserId: "u1", kind: "market_update", targetChannel: "instagram",
    dispatcher: (async (situation, opts) => {
      if (situation.kind !== "market_update" || !opts.brokerageId) return { ok: false, status: "failed" }
      return { ok: true, status: "staged", compositionId: "MarketUpdateReel" }
    }) as CommissionDispatcher,
  })
  check("voiceCommissionVideo: ok + speaks the directed build via the seam", commissioned.ok && /market update/i.test(commissioned.spoken))
  const commissionedDup = await voiceCommissionVideo({
    brokerageId: "b1", agentUserId: "u1", kind: "cma", targetChannel: "email",
    dispatcher: (async () => ({ ok: true, status: "already_staged", compositionId: "CMAReel" })) as CommissionDispatcher,
  })
  check("voiceCommissionVideo: already_staged is idempotent-ok (no duplicate)", commissionedDup.ok && /no duplicate/i.test(commissionedDup.spoken))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live delegation]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Voicedel${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Call", last_name: TAG, contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const { data: seq } = await svc.from("campaign_sequences").insert({
      brokerage_id: brokerageId, name: `${TAG} Nurture`, sequence_type: "nurture", is_active: true,
      trigger_event: "manual",
    }).select("id").single()
    cleanup.push({ table: "campaign_sequences", id: (seq as any).id })

    // FOLLOW-UP: the spoken instruction is the human approval (no email → portal).
    const f = await voiceFollowUp({ brokerageId, agentUserId, contactId: (con as any).id, dictation: `${TAG} inspection report comes Tuesday.` }, svc)
    if (f.messageId) cleanup.push({ table: "agent_client_messages", id: f.messageId })
    check("follow-up: executed from the voice command", f.ok)
    const { data: msg } = await svc.from("agent_client_messages")
      .select("status, approved_by, channel, body, rationale").eq("id", f.messageId ?? "").single()
    check("follow-up: approved BY THE AGENT (real human id, never forged)", (msg as any).approved_by === agentUserId)
    check("follow-up: dictation carried verbatim through the gate", ((msg as any).body ?? "").includes("inspection report comes Tuesday"))
    check("follow-up: portal channel picked (contact has no clean email)", (msg as any).channel === "portal")
    check("follow-up: rationale records VOICE DELEGATION (audit)", ((msg as any).rationale ?? "").includes("VOICE DELEGATION"))
    const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", f.messageId ?? "").eq("type", "approval_needed").maybeSingle()
    if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
    const { data: tu } = await svc.from("transparency_updates").select("id").eq("contact_id", (con as any).id).limit(5)
    for (const t of (tu ?? []) as any[]) cleanup.push({ table: "transparency_updates", id: t.id })

    // START MARKETING: governed enrollment + idempotency.
    const m1 = await voiceStartMarketing({ brokerageId, agentUserId, contactId: (con as any).id }, svc)
    if (m1.enrollmentId) cleanup.push({ table: "sequence_enrollments", id: m1.enrollmentId })
    check("marketing: enrolled in the active nurture sequence", m1.ok && m1.spoken.includes(`${TAG} Nurture`))
    const { data: enr } = await svc.from("sequence_enrollments").select("enrolled_by, status").eq("id", m1.enrollmentId ?? "").single()
    check("marketing: enrolled_by = the speaking agent, status active", (enr as any).enrolled_by === agentUserId && (enr as any).status === "active")
    const m2 = await voiceStartMarketing({ brokerageId, agentUserId, contactId: (con as any).id }, svc)
    check("marketing: second command refuses to double-enroll", m2.ok && m2.spoken.includes("already running"))

    // CUT A PROMO: the voice command rides the CANONICAL promo rail (injected
    // dispatcher = the vendor seam; asserts the exact dispatch, spends nothing).
    const { data: lst } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 44 Birch Lane`, status: "active",
    }).select("id").single()
    cleanup.push({ table: "listings", id: (lst as any).id })
    const dispatches: any[] = []
    const dispatcher: PromoDispatcher = async (d) => { dispatches.push(d); return { ok: true, status: "remotion_pending" } }
    const p1 = await voiceCutPromo({ brokerageId, agentUserId, addressQuery: `${TAG} 44 Birch`, dispatcher }, svc)
    check("promo: spoken address resolved to the real listing", p1.ok && dispatches.length === 1 && dispatches[0].listingId === (lst as any).id)
    check("promo: manual trigger semantics (bypassPolicy=true, just_listed for an active listing)",
      dispatches[0]?.bypassPolicy === true && dispatches[0]?.eventType === "just_listed")
    check("promo: spoken confirmation names compliance + approval queue", p1.spoken.includes("Fair Housing") && p1.spoken.includes("approval queue"))
    const dupDispatcher: PromoDispatcher = async () => ({ ok: true, status: "already_queued", reason: "duplicate event for this listing" })
    const p2 = await voiceCutPromo({ brokerageId, agentUserId, addressQuery: `${TAG} 44 Birch`, dispatcher: dupDispatcher }, svc)
    check("promo: duplicate render refused, spoken honestly", p2.ok && p2.spoken.includes("already in the pipeline"))
    const p3 = await voiceCutPromo({ brokerageId, agentUserId, addressQuery: "9 Nowhere Blvd Zz", dispatcher }, svc)
    check("promo: unknown address → honest miss, nothing dispatched", !p3.ok && dispatches.length === 1)

    // WITHDRAWN refuses both — the consent chain's promise holds against voice too.
    const { data: gone } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Gone", last_name: TAG, contact_type: "buyer", nurture_status: "withdrawn",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (gone as any).id })
    const fGone = await voiceFollowUp({ brokerageId, agentUserId, contactId: (gone as any).id }, svc)
    const mGone = await voiceStartMarketing({ brokerageId, agentUserId, contactId: (gone as any).id }, svc)
    check("withdrawn: follow-up REFUSED with the reason spoken", !fGone.ok && fGone.spoken.includes("withdrawn"))
    check("withdrawn: marketing REFUSED with the reason spoken", !mGone.ok && mGone.spoken.includes("withdrawn"))

    // ── OPTIMIZE TOUR: the buyer's planned tour is reordered by the REAL optimizer ──
    console.log("\n[Layer 2 · optimize tour]")
    const today = new Date().toISOString().slice(0, 10)
    const { data: tour } = await svc.from("tours").insert({
      brokerage_id: brokerageId, contact_id: (con as any).id, buyer_id: (con as any).id,
      agent_id: agentUserId, tour_date: today, start_time: "10:00", status: "planned",
    }).select("id").single()
    cleanup.push({ table: "tours", id: (tour as any).id })
    // Stops fed OUT of nearest-neighbor order (far, near, mid); coords via the injected seam.
    const stopCoords: Record<string, { lat: number; lng: number }> = {}
    const tourStops = [
      { addr: `${TAG} 300 Far St`, order: 0, lat: 40.3000, lng: -74.0 },
      { addr: `${TAG} 1 Near St`, order: 1, lat: 40.0000, lng: -74.0 },
      { addr: `${TAG} 50 Mid Ave`, order: 2, lat: 40.0500, lng: -74.0 },
    ]
    for (const s of tourStops) {
      const { data: ts } = await svc.from("tour_stops").insert({
        tour_id: (tour as any).id, brokerage_id: brokerageId, contact_id: (con as any).id,
        order_index: s.order, property_address: s.addr,
      }).select("id").single()
      cleanup.push({ table: "tour_stops", id: (ts as any).id })
      stopCoords[(ts as any).id] = { lat: s.lat, lng: s.lng }
    }
    const ot = await voiceOptimizeTour(
      { brokerageId, agentUserId, contactId: (con as any).id, resolveCoords: (row: any) => stopCoords[row.id] ?? null },
      svc,
    )
    // The showing_routes audit row the optimizer persists — clean it up.
    const { data: routes } = await svc.from("showing_routes").select("id").eq("brokerage_id", brokerageId).contains("showings", { tour_id: (tour as any).id })
    for (const rt of (routes ?? []) as any[]) cleanup.push({ table: "showing_routes", id: rt.id })
    check("optimize-tour: ran on the buyer's planned tour, sequenced all 3 stops",
      ot.ok && ot.tourId === (tour as any).id && ot.stopsSequenced === 3, JSON.stringify(ot))
    const { data: afterStops } = await svc.from("tour_stops")
      .select("property_address, order_index").eq("tour_id", (tour as any).id).order("order_index", { ascending: true })
    const orderedAddrs = (afterStops ?? []) as any[]
    check("optimize-tour: REAL effect — stops reordered Near→Mid→Far in the DB",
      orderedAddrs[0]?.property_address.includes("Near St") &&
      orderedAddrs[1]?.property_address.includes("Mid Ave") &&
      orderedAddrs[2]?.property_address.includes("Far St"),
      orderedAddrs.map((s) => s.property_address).join(" | "))
    check("optimize-tour: spoken names the new order + the estimate label", ot.spoken.includes("Near St") && /estimate/i.test(ot.spoken))
    const otAgain = await voiceOptimizeTour({ brokerageId, agentUserId, contactId: (con as any).id, resolveCoords: (row: any) => stopCoords[row.id] ?? null }, svc)
    check("optimize-tour: re-run on an optimized tour is a no-op, spoken honestly", otAgain.ok && /already optimized/i.test(otAgain.spoken))

    // ── CLOSINGS AT RISK: a seeded under-contract deal surfaces at_risk (read-only) ──
    console.log("\n[Layer 2 · closings at risk]")
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
    const { data: riskTxn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 9 Risk Rd`, status: "under_contract",
      property_address: `${TAG} 9 Risk Rd`, contact_id: (con as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (riskTxn as any).id })
    // Closing in 8 days, appraisal dated only 2 days before closing (runway 14) → at_risk.
    const riskMilestones = [
      { milestone_name: "inspection_deadline", target_date: day(-3), status: "completed" },
      { milestone_name: "appraisal_deadline", target_date: day(6), status: "pending" },
      { milestone_name: "financing_deadline", target_date: day(7), status: "pending" },
      { milestone_name: "closing_date", target_date: day(8), status: "pending" },
    ]
    for (const m of riskMilestones) {
      const { data: ms } = await svc.from("transaction_milestones").insert({
        transaction_id: (riskTxn as any).id, brokerage_id: brokerageId,
        milestone_name: m.milestone_name, target_date: m.target_date, status: m.status,
      }).select("id").single()
      cleanup.push({ table: "transaction_milestones", id: (ms as any).id })
    }
    const car = await voiceClosingsAtRisk({ brokerageId }, svc)
    const ourDeal = car.deals.find((d) => d.transactionId === (riskTxn as any).id)
    check("closings-at-risk: REAL effect — the seeded deal returned in the at-risk list",
      car.ok && !!ourDeal, JSON.stringify({ ok: car.ok, found: !!ourDeal, scanned: car.scanned }))
    check("closings-at-risk: the seeded deal reads at_risk with a binding constraint",
      ourDeal?.severity === "at_risk" && !!ourDeal?.bindingLabel, JSON.stringify(ourDeal))
    check("closings-at-risk: spoken names our deal + flags it as at risk", car.spoken.includes(`${TAG} 9 Risk Rd`) && /at risk/i.test(car.spoken))

    // ── SEND EQUITY REPORT: ONE gated proposal in the queue (never autonomous) ──
    console.log("\n[Layer 2 · send equity report]")
    const runNow = new Date()
    const closeIso = new Date(Date.UTC(runNow.getUTCFullYear() - 1, runNow.getUTCMonth(), runNow.getUTCDate())).toISOString().slice(0, 10)
    const equityAddr = `${TAG} 12 Equity Ln`
    const { data: eqTxn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} equity home`, status: "closed", stage: "CLOSED",
      property_address: equityAddr, purchase_price: 500_000, close_date: closeIso,
      buyer_contact_id: (con as any).id, contact_id: (con as any).id, agent_id: (agent as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (eqTxn as any).id })
    const ser = await voiceSendEquityReport(
      {
        brokerageId, contactId: (con as any).id,
        // INJECTED valuation: fixed number for OUR seeded address ONLY; any other address → null.
        valuationFetcher: async (a: { brokerageId: string; address: string }) => a.address === equityAddr ? { value: 600_000, source: "injected" } : null,
        copyGenerator: async () => null, // deterministic fallback (no token spend)
      },
      svc,
    )
    // The gated proposal + its portal card + notification — clean them all up.
    const yearTag = `ANNIVERSARY EQUITY [${runNow.getUTCFullYear()}]`
    const { data: eqMsg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, body").eq("recipient_contact_id", (con as any).id).ilike("rationale", `${yearTag}%`).maybeSingle()
    if (eqMsg) {
      cleanup.push({ table: "agent_client_messages", id: (eqMsg as any).id })
      const { data: eqNotes } = await svc.from("notifications").select("id").eq("entity_id", (eqMsg as any).id)
      for (const n of (eqNotes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    const { data: eqCards } = await svc.from("transparency_updates").select("id").eq("contact_id", (con as any).id).eq("update_type", "equity_report")
    for (const cd of (eqCards ?? []) as any[]) cleanup.push({ table: "transparency_updates", id: cd.id })
    check("equity-report: REAL effect — ONE gated proposal landed for the contact", ser.ok && ser.proposed === true, JSON.stringify(ser))
    check("equity-report: GATED, not autonomous (sphere_of_influence, audience 'agent', status proposed)",
      (eqMsg as any)?.status === "proposed" && (eqMsg as any)?.audience === "agent" && (eqMsg as any)?.agent_kind === "sphere_of_influence")
    check("equity-report: body is the real ready-to-send note (labeled estimate, not an appraisal)",
      ((eqMsg as any)?.body ?? "").includes("not an appraisal"))
    check("equity-report: spoken confirms it's QUEUED FOR APPROVAL, never sent autonomously",
      /approval queue/i.test(ser.spoken) && /until you approve/i.test(ser.spoken))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("last_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
