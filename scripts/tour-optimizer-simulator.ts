#!/usr/bin/env tsx
/**
 * scripts/tour-optimizer-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUYER TOUR DAY OPTIMIZER harness — the Shopping Agent's two missing
 * buyer-tour moves: (1) route sequencing, (2) same-day recap card.
 *
 * Layer 1 (pure): sequenceStopsByDriveTime orders a known set of coordinates
 *   nearest-neighbor + drive estimates are monotonic with distance; a stop with
 *   NO coordinates keeps its order with a NULL drive (honest degradation);
 *   composeTourRecap counts loved/liked/maybe/no from REAL ratings + builds a
 *   neutral, Fair-Housing-safe body; tourRecapSignature is stable.
 * Layer 2 (live, gated): seed a real contact + tour (status 'planned') + 3
 *   tour_stops; run optimizeTourRoute with injected real coordinates → assert
 *   order_index + drive minutes written to tour_stops, tours.total_drive_time_minutes
 *   set, a showing_routes row persisted with an optimization_score; flip the tour
 *   to 'completed' with real ratings, run pushTourRecap TWICE → assert exactly ONE
 *   visible tour_recap card (idempotent) + tours.report_sent_at set; then DELETE
 *   every seeded row in reverse and verify cleanup count == 0.
 *
 * Run: npx tsx scripts/tour-optimizer-simulator.ts  (npm run test:tour-optimizer)
 */
import {
  sequenceStopsByDriveTime,
  composeTourRecap,
  tourRecapSignature,
  haversineMiles,
  estimateDriveMinutes,
  totalEstimatedDriveMinutes,
  type GeoStop,
  type RecapStopRating,
} from "../lib/kernel/tour-optimizer"

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
  console.log(" ✅ Tour Day Optimizer verified — nearest-neighbor route + honest degradation + rating-based recap + portal value card")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Tour Day Optimizer simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · sequencing + degradation + recap]")

  // A known set of points. Origin near A; B is a bit further; C is far. A→B→C is the
  // nearest-neighbor order regardless of input order.
  const A = { lat: 40.0000, lng: -74.0000 } // ~origin
  const B = { lat: 40.0500, lng: -74.0000 } // ~3.45 mi north of A
  const C = { lat: 40.3000, lng: -74.0000 } // ~20.7 mi north of A
  const origin = { lat: 39.9900, lng: -74.0000 } // just south of A

  // Feed them OUT of order (C, A, B) — the optimizer must reorder to A, B, C.
  const stops: GeoStop[] = [
    { id: "C", order_index: 0, lat: C.lat, lng: C.lng },
    { id: "A", order_index: 1, lat: A.lat, lng: A.lng },
    { id: "B", order_index: 2, lat: B.lat, lng: B.lng },
  ]
  const seq = sequenceStopsByDriveTime(stops, origin)
  check("nearest-neighbor orders A→B→C from origin (was fed C,A,B)",
    seq.map((s) => s.id).join("") === "ABC", `got ${seq.map((s) => s.id).join("")}`)
  check("order_index re-indexed 0,1,2", seq.map((s) => s.order_index).join("") === "012")
  check("every sequenced stop carries a drive estimate from its predecessor (incl. origin→A)",
    seq.every((s) => s.driveMinutes != null && s.driveMinutes >= 0))

  // Drive estimates monotonic with distance: leg origin→A is shorter than A→B is shorter than B→C.
  const legOA = seq[0].driveMinutes!
  const legAB = seq[1].driveMinutes!
  const legBC = seq[2].driveMinutes!
  check("drive estimates monotonic with distance (origin→A < A→B < B→C)",
    legOA < legAB && legAB < legBC, `got ${legOA}, ${legAB}, ${legBC}`)

  // estimateDriveMinutes is monotonic and uses the documented 30mph estimate.
  check("estimateDriveMinutes monotonic with miles", estimateDriveMinutes(2) < estimateDriveMinutes(10))
  check("estimateDriveMinutes: 30 miles @ 30mph ≈ 60 min", estimateDriveMinutes(30) === 60)
  check("haversine A→C ≈ 20.7 mi", Math.abs(haversineMiles(A, C) - 20.7) < 0.5, `got ${haversineMiles(A, C).toFixed(2)}`)
  check("total estimated drive = sum of legs", totalEstimatedDriveMinutes(seq) === legOA + legAB + legBC)

  // DEGRADATION — a stop with NO coordinates keeps its order, gets a NULL drive (no fabrication).
  const mixed: GeoStop[] = [
    { id: "A", order_index: 0, lat: A.lat, lng: A.lng },
    { id: "X", order_index: 1, lat: null, lng: null }, // no coordinates
    { id: "B", order_index: 2, lat: B.lat, lng: B.lng },
  ]
  const mixedSeq = sequenceStopsByDriveTime(mixed, origin)
  const xStop = mixedSeq.find((s) => s.id === "X")!
  check("un-geocoded stop kept (appended after sequenced stops), NULL drive, sequenced=false",
    xStop.driveMinutes === null && xStop.sequenced === false)
  check("geocoded stops A,B still sequenced with real drives",
    mixedSeq.filter((s) => s.sequenced).map((s) => s.id).sort().join("") === "AB" &&
    mixedSeq.filter((s) => s.sequenced).every((s) => s.driveMinutes != null))
  check("un-geocoded stop is LAST in the re-indexed order",
    mixedSeq[mixedSeq.length - 1].id === "X")

  // Empty / single edge cases.
  check("empty input → empty output", sequenceStopsByDriveTime([], origin).length === 0)
  const single = sequenceStopsByDriveTime([{ id: "A", order_index: 0, lat: A.lat, lng: A.lng }], null)
  check("single stop, no origin → null drive (nothing to measure from)", single[0].driveMinutes === null)

  // composeTourRecap — counts from REAL ratings only.
  const ratings: RecapStopRating[] = [
    { propertyAddress: "10 Oak St", interestLevel: "love_it", note: "great light" },
    { propertyAddress: "22 Pine Ave", interestLevel: "love_it" },
    { propertyAddress: "5 Birch Rd", interestLevel: "like_it" },
    { propertyAddress: "9 Elm Ct", interestLevel: "maybe" },
    { propertyAddress: "44 Cedar Ln", interestLevel: "no" },
    { propertyAddress: "7 Maple Way", interestLevel: null }, // unrated — excluded from per-home
  ]
  const recap = composeTourRecap(ratings, { buyerFirstName: "Dana" })
  check("recap counts loved=2", recap.loved === 2)
  check("recap counts liked=1", recap.liked === 1)
  check("recap counts maybe=1, no=1", recap.maybe === 1 && recap.no === 1)
  check("recap rated=5 of total=6 (unrated excluded from rated)", recap.rated === 5 && recap.total === 6)
  check("recap per-home only lists RATED homes (5 lines, no unrated)",
    recap.perHome.length === 5 && !recap.perHome.some((l) => l.includes("Maple")))
  check("recap body greets the buyer + states the loved count", recap.body.includes("Dana") && recap.body.includes("2 you loved"))
  check("recap next step is warm + neutral (no protected-class/steering language)",
    /loved/i.test(recap.nextStep) && !/family|families|safe neighborhood|retire/i.test(recap.nextStep))
  check("recap note quoted from real feedback", recap.perHome.some((l) => l.includes("great light")))

  // No-loved / no-rating edges.
  const allNo = composeTourRecap([{ propertyAddress: "1 A St", interestLevel: "no" }], {})
  check("recap with zero loved/liked still produces a body + neutral next step",
    allNo.body.length > 0 && allNo.nextStep.length > 0 && allNo.loved === 0)
  check("tourRecapSignature stable", tourRecapSignature("abc") === "tour_recap:abc")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live tour optimizer]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { optimizeTourRoute, pushTourRecap } = await import("../lib/kernel/tour-optimizer")
  const svc = createServiceClient()
  const TAG = `TourOpt${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Buyer is a CONTACT (has a portal).
    const { data: buyer } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Buyer", contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (buyer as any).id })

    // A PLANNED tour — not yet optimized (total_drive_time_minutes NULL).
    const today = new Date().toISOString().slice(0, 10)
    const { data: tour } = await svc.from("tours").insert({
      brokerage_id: brokerageId, contact_id: (buyer as any).id, buyer_id: (buyer as any).id,
      agent_id: (agent as any).user_id, tour_date: today, start_time: "10:00", status: "planned",
    }).select("id").single()
    cleanup.push({ table: "tours", id: (tour as any).id })

    // 3 stops fed OUT of nearest-neighbor order (far, near, mid). Coordinates supplied via
    // the injectable resolveCoords seam (no coordinate columns on this schema).
    const stopCoords: Record<string, { lat: number; lng: number }> = {}
    const stopRows = [
      { addr: `${TAG} 300 Far St`, order: 0, lat: 40.3000, lng: -74.0000 },   // far
      { addr: `${TAG} 1 Near St`, order: 1, lat: 40.0000, lng: -74.0000 },    // near
      { addr: `${TAG} 50 Mid Ave`, order: 2, lat: 40.0500, lng: -74.0000 },   // mid
    ]
    const stopIds: string[] = []
    for (const s of stopRows) {
      const { data: ts } = await svc.from("tour_stops").insert({
        tour_id: (tour as any).id, brokerage_id: brokerageId, contact_id: (buyer as any).id,
        order_index: s.order, property_address: s.addr,
      }).select("id").single()
      cleanup.push({ table: "tour_stops", id: (ts as any).id })
      stopIds.push((ts as any).id)
      stopCoords[(ts as any).id] = { lat: s.lat, lng: s.lng }
    }

    // Run the optimizer with injected real coordinates.
    const r1 = await optimizeTourRoute((tour as any).id, svc, {
      resolveCoords: (row: any) => stopCoords[row.id] ?? null,
    })
    check("optimizeTourRoute ran ok + sequenced all 3 stops",
      r1.ok && r1.stopsTotal === 3 && r1.stopsSequenced === 3, JSON.stringify(r1))

    // Re-read stops — assert order written: Near(40.00)→Mid(40.05)→Far(40.30).
    const { data: afterStops } = await svc.from("tour_stops")
      .select("id, order_index, property_address, drive_time_from_prev_minutes")
      .eq("tour_id", (tour as any).id).order("order_index", { ascending: true })
    const ordered = (afterStops ?? []) as any[]
    check("tour_stops re-ordered nearest-neighbor (Near, Mid, Far)",
      ordered[0]?.property_address.includes("Near St") &&
      ordered[1]?.property_address.includes("Mid Ave") &&
      ordered[2]?.property_address.includes("Far St"),
      ordered.map((s) => s.property_address).join(" | "))
    check("drive_time_from_prev_minutes written (later legs >= earlier; monotonic with distance)",
      ordered[1]?.drive_time_from_prev_minutes != null &&
      ordered[2]?.drive_time_from_prev_minutes != null &&
      ordered[2].drive_time_from_prev_minutes >= ordered[1].drive_time_from_prev_minutes)

    // tours.total_drive_time_minutes set (the idempotency stamp + agent number).
    const { data: tourAfter } = await svc.from("tours")
      .select("total_drive_time_minutes").eq("id", (tour as any).id).single()
    check("tours.total_drive_time_minutes stamped", (tourAfter as any)?.total_drive_time_minutes != null && (tourAfter as any).total_drive_time_minutes > 0)

    // showing_routes audit row persisted with an optimization_score.
    const { data: routes } = await svc.from("showing_routes")
      .select("id, showings, optimization_score, total_duration, estimated_miles")
      .eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(20)
    const routeRow = ((routes ?? []) as any[]).find((rr) => rr?.showings?.tour_id === (tour as any).id)
    if (routeRow) cleanup.push({ table: "showing_routes", id: routeRow.id })
    check("showing_routes row persisted with optimization_score + total_duration",
      !!routeRow && routeRow.optimization_score != null && routeRow.total_duration != null)

    // IDEMPOTENCY — second optimize is a no-op (total_drive_time_minutes already set).
    const r1b = await optimizeTourRoute((tour as any).id, svc, {
      resolveCoords: (row: any) => stopCoords[row.id] ?? null,
    })
    check("optimizeTourRoute idempotent: second pass skips (already_optimized)", r1b.reason === "already_optimized")

    // ── RECAP — flip tour to completed with REAL ratings, then push the recap twice.
    const interest = ["love_it", "like_it", "no"] // for Near, Mid, Far after reorder
    for (let i = 0; i < ordered.length; i++) {
      await svc.from("tour_stops")
        .update({ buyer_interest_level: interest[i], buyer_note: i === 0 ? "favorite" : null })
        .eq("id", ordered[i].id)
    }
    await svc.from("tours").update({ status: "completed" }).eq("id", (tour as any).id)

    const rec1 = await pushTourRecap((tour as any).id, svc, { copyGenerator: async () => null })
    check("pushTourRecap pushed a card (loved=1, liked=1, total=3)",
      rec1.ok && rec1.pushed && rec1.loved === 1 && rec1.liked === 1 && rec1.total === 3, JSON.stringify(rec1))

    // Second pass — idempotent (report_sent_at now set → already_reported).
    const rec2 = await pushTourRecap((tour as any).id, svc, { copyGenerator: async () => null })
    check("pushTourRecap idempotent: second pass skips (already_reported)", rec2.reason === "already_reported")

    // Exactly ONE visible tour_recap card for this buyer.
    const { data: cards } = await svc.from("transparency_updates")
      .select("id, contact_id, update_type, is_visible_to_client, title, metadata")
      .eq("contact_id", (buyer as any).id).eq("update_type", "tour_recap")
    for (const c of (cards ?? []) as any[]) cleanup.push({ table: "transparency_updates", id: c.id })
    check("exactly ONE visible tour_recap card (idempotent per contact/day)",
      (cards ?? []).length === 1 && (cards as any[])[0]?.is_visible_to_client === true)
    check("recap card metadata names loved/liked counts + the tour",
      (cards as any[])[0]?.metadata?.loved === 1 && (cards as any[])[0]?.metadata?.liked === 1 &&
      (cards as any[])[0]?.metadata?.tour_id === (tour as any).id)

    // tours.report_sent_at + report_url stamped.
    const { data: tourFinal } = await svc.from("tours")
      .select("report_sent_at, report_url").eq("id", (tour as any).id).single()
    check("tours.report_sent_at + report_url (portal deep-link) stamped",
      (tourFinal as any)?.report_sent_at != null &&
      ((tourFinal as any)?.report_url ?? "").includes(`/portal/${(buyer as any).id}/showings`))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("tour_stops").select("id", { count: "exact", head: true }).like("property_address", `${TAG}%`)
    check("cleanup verified — 0 seeded tour_stops remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
