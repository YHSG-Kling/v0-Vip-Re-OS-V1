#!/usr/bin/env tsx
/**
 * scripts/tour-checkin-simulator.ts   (npm run test:tour-checkin)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DAY-OF TOUR CHECK-IN — the half that was missing, and the guard that keeps
 * it from going missing again.
 *
 * THE DEFECT (orphan doctrine §1.2). tour_stops.time_arrived_at, .time_left_at and
 * .time_spent_minutes were WRITERLESS. Verified live on hrvaqgvukzxfskkcrwbt
 * before the build: all three column DEFAULTs NULL and is_generated 'NEVER';
 * pg_trigger empty for tour_stops; pg_proc holding no routine that names the table
 * or any of the three columns; count() of each = 0 across 0 rows. Their ONE
 * appearance in the whole tree was the SELECT list in getBuyerTours
 * (app/actions/tour-planner.ts:236) — selected by one query, rendered by nothing.
 *
 * Meanwhile the CRM day-of tab had run a per-stop STOPWATCH since it was written
 * ("Time at this stop: 07:42") on a purely local counter that reset on every
 * remount. The agent was shown a number the OS never kept.
 *
 * THE OWNER'S RULING closed the question a prior lane left unresolved:
 * showings.completed_at / duration_minutes are NOT the intended survivor —
 * "tours and showings are 2 different as showings are for showing requests or
 * showings on the tenants listings". No duplicate exists, so §1.2 applies and the
 * missing half gets BUILT, not deleted to move a number.
 *
 * WHAT THIS PROVES
 *   Layer 1 (source, comment-STRIPPED per §2 — a tombstone is not a call site):
 *     the writer exists, stamps BOTH timestamps, derives nothing itself, takes no
 *     body-supplied tenant, proves the stop→tour→tenant chain, and COUNTS the rows
 *     its UPDATE touched. Each of these is the POSITIVE CONTROL for a way the
 *     capability could silently die: delete the writer and Layer 1 goes red.
 *   Layer 2 (live schema): time_spent_minutes is GENERATED ALWAYS (m564), so no
 *     caller can assert a duration; the two-column visit-window CHECK exists; and
 *     the BLINDNESS CONTROL re-runs the writerless sweep the build was based on.
 *   Layer 3 (live data, gated): seed a real tour + stop, stamp arrival then
 *     departure exactly as the action does, and read all three columns back
 *     POPULATED — the end-to-end positive control that the values actually land.
 *     Then prove the derivation refuses a direct write, prove a half-recorded
 *     visit derives NULL and not 0, and delete every seeded row COUNTING what came
 *     back (§3 — a DELETE matching nothing resolves clean).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

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
  console.log(" ✅ Day-of tour check-in verified — writer stamps, database derives, two readers consume")
}

const ROOT = process.cwd()
const ACTION_PATH = join(ROOT, "app/actions/tour-planner.ts")
const TAB_PATH    = join(ROOT, "app/crm/contacts/[contactId]/tours/components/tour-day-of-tab.tsx")
const RECAP_PATH  = join(ROOT, "lib/kernel/client-story-drafts.ts")

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Day-of tour check-in — the built missing half")
  console.log("══════════════════════════════════════════════════")

  // ── LAYER 1 · THE WRITER EXISTS AND BEHAVES ────────────────────────────────
  // Read STRIPPED (§2). This file is dense with tombstones that quote the very
  // column names and call shapes being searched for; a raw-source scan would find
  // the prose and pass while the code was gone.
  console.log("\n[1 · the writer — source read comment-STRIPPED]")
  const actionRaw = readFileSync(ACTION_PATH, "utf8")
  const action    = stripComments(actionRaw)

  const writerRe = /export async function stampTourStopPresence[\s\S]*?\n}\n/
  const writerMatch = writerRe.exec(action)
  check("stampTourStopPresence exists as an async server action", !!writerMatch)
  const writer = writerMatch?.[0] ?? ""

  // The update payload is built as `patch`, so the set of columns this action can
  // possibly write is exactly the set of `patch.<col> =` assignments. DERIVE that
  // set and assert the RULE (§2 — assert the rule, do not pin a hardcoded list of
  // what today's body happens to contain).
  const patchedColumns = new Set(
    [...writer.matchAll(/patch\.(\w+)\s*=/g)].map((m) => m[1]),
  )
  check("it stamps time_arrived_at (the check-IN half)",  patchedColumns.has("time_arrived_at"))
  check("it stamps time_left_at (the check-OUT half)",    patchedColumns.has("time_left_at"))

  // THE POINT OF THE WHOLE DESIGN: the duration is never asserted by a caller.
  // The two timestamps are the ONLY columns this action can write; anything else
  // appearing in the payload is a caller asserting a fact it did not observe.
  check("it writes ONLY the two timestamps — nothing else reaches the row",
    patchedColumns.size === 2, [...patchedColumns].join(", "))
  check("it NEVER writes time_spent_minutes — the database derives it (m564)",
    !patchedColumns.has("time_spent_minutes"))
  check("it takes no caller-supplied duration in its parameters",
    !/minutes\s*[?:]\s*number/i.test(writer.slice(0, writer.indexOf("{", writer.indexOf(")")))))

  // §4 — tenant from the SESSION, never the body.
  check("tenant comes from requireCaller(), not a parameter",
    /const auth = await requireCaller\(\)/.test(writer) &&
    /const brokerageId = auth\.brokerageId/.test(writer))
  check("its parameter object carries NO brokerageId / agentUserId / contactId",
    !/brokerageId\s*[?:]/.test(writer.slice(0, writer.indexOf("const { tourStopId"))) &&
    !/agentUserId\s*[?:]/.test(writer.slice(0, writer.indexOf("const { tourStopId"))))

  // The predicate chain: stop → tour → tenant, BOTH links.
  check("link 1 — the stop's own brokerage_id is checked against the session",
    /stopRow\.brokerage_id !== brokerageId/.test(writer))
  check("link 2 — the PARENT TOUR is re-loaded under .eq('brokerage_id', brokerageId)",
    /from\('tours'\)[\s\S]{0,240}?\.eq\('brokerage_id',\s*brokerageId\)/.test(writer))
  check("the UPDATE is scoped by id AND tour_id AND brokerage_id",
    /\.eq\('id',\s*tourStopId\)[\s\S]{0,160}?\.eq\('tour_id',\s*stopRow\.tour_id\)[\s\S]{0,160}?\.eq\('brokerage_id',\s*brokerageId\)/.test(writer))

  // §3 — a zero-row UPDATE resolves clean and is byte-identical to one that worked.
  check("the UPDATE is .select()ed so affected rows are observable",
    /\.update\(patch\)[\s\S]{0,400}?\.select\(/.test(writer))
  check("ZERO ROWS is reported as a REFUSAL, never as success",
    /if \(!stamped\?\.length\)[\s\S]{0,160}?success:\s*false/.test(writer))
  check("the supabase error is destructured and READ on every call",
    /const \{ data: stamped, error: stampError \}/.test(writer) &&
    /if \(stampError\) return \{ success: false/.test(writer))

  // Honest half-states.
  check("a departure with no recorded arrival is REFUSED (not stamped alone)",
    /if \(!stopRow\.time_arrived_at\)[\s\S]{0,200}?success:\s*false/.test(writer))
  check("re-arriving is a no-op that returns the ORIGINAL arrival (first arrival wins)",
    /if \(stopRow\.time_arrived_at\)[\s\S]{0,240}?arrivedAt:\s*stopRow\.time_arrived_at/.test(writer))
  check("a completed or cancelled tour takes no further stamps",
    /status === 'cancelled' \|\| tourRow\.status === 'completed'/.test(writer))

  // ── LAYER 1b · THE READERS ─────────────────────────────────────────────────
  // A writer with no reader is the SAME defect, pointed the other way. This is the
  // assertion that stops the build from re-orphaning itself.
  console.log("\n[1b · the readers — a writer with no reader is the same orphan]")
  const tab   = stripComments(readFileSync(TAB_PATH, "utf8"))
  const recap = stripComments(readFileSync(RECAP_PATH, "utf8"))

  check("READER 1 — the CRM day-of tab imports the writer",
    /import \{[^}]*stampTourStopPresence[^}]*\} from '@\/app\/actions\/tour-planner'/.test(tab))
  check("READER 1 — it checks IN (phase 'arrived')",  /phase:\s*'arrived'/.test(tab))
  check("READER 1 — it checks OUT (phase 'departed')", /phase:\s*'departed'/.test(tab))
  check("READER 1 — it RENDERS the derived minutes, not just its own stopwatch",
    /recordedMinutes/.test(tab) && /min on site/.test(tab))
  check("READER 1 — the stopwatch is anchored to the SERVER arrival, not local mount",
    /arrivalAnchor/.test(tab) && /new Date\(arrivalAnchor\)\.getTime\(\)/.test(tab))

  check("READER 2 — the tour recap SELECTS time_spent_minutes",
    /from\("tour_stops"\)\.select\("[^"]*time_spent_minutes[^"]*"\)/.test(recap))
  check("READER 2 — it carries the value into the brief as minutesOnSite",
    /minutesOnSite:\s*s\.time_spent_minutes/.test(recap))
  check("READER 2 — null minutes stay SILENT (never rendered as '0 minutes')",
    /s\.minutesOnSite != null && s\.minutesOnSite > 0/.test(recap))

  // The brief's honesty guard must be UNCHANGED: a duration is not a reaction, so
  // stamps alone must still never narrate a day nobody reacted to.
  const { tourRecapBrief } = await import("../lib/kernel/client-story-drafts")
  check("NEGATIVE CONTROL — stamps WITHOUT a reaction still yield NO brief",
    tourRecapBrief({
      buyerFirstName: "Sam",
      stops: [{ address: "1 Oak Ct", rating: null, feedback: null, minutesOnSite: 45 }],
    }) === null)
  const enriched = tourRecapBrief({
    buyerFirstName: "Sam",
    stops: [{ address: "1 Oak Ct", rating: 5, feedback: "loved the light", minutesOnSite: 45 }],
  })
  check("a REACTED stop with minutes puts the time on site into the brief's facts",
    !!enriched && enriched.facts.some((f) => /45 minutes in the house/.test(f)))
  const zeroish = tourRecapBrief({
    buyerFirstName: "Sam",
    stops: [{ address: "1 Oak Ct", rating: 5, feedback: null, minutesOnSite: null }],
  })
  check("an unstamped stop adds no time fact at all (absence is not zero)",
    !!zeroish && !zeroish.facts.some((f) => /in the house/.test(f)))

  // ── LAYER 1c · ONE VOCABULARY (§6) ─────────────────────────────────────────
  console.log("\n[1c · one vocabulary — the day-of tab must not filter for a state nothing writes]")
  check("the day-of tab admits 'in_progress' — the state the machine names and mobile writes",
    /'in_progress'/.test(tab))
  check("it no longer filters for 'active', a tours.status spelling NOTHING writes",
    !/\['planned','confirmed','active'\]/.test(tab.replace(/\s/g, "")))

  // ── LAYER 2 · THE LIVE SCHEMA ──────────────────────────────────────────────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[2 · live schema + data]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (source layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()

  console.log("\n[2 · live schema — the derivation lives in the database (m564)]")
  const TAG = `TourCheckIn${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent, error: agentErr } = await svc.from("agents")
      .select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).maybeSingle()
    if (agentErr) { console.log(`  ⏭  Skipped — ${agentErr.message}`); report(); return }
    if (!agent) { console.log("  ⏭  Skipped — need an agent seat."); report(); return }
    const brokerageId = (agent as { brokerage_id: string }).brokerage_id

    const { data: buyer, error: buyerErr } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Buyer", contact_type: "buyer",
    }).select("id").single()
    if (buyerErr || !buyer) { console.log(`  ⏭  Skipped — ${buyerErr?.message}`); report(); return }
    cleanup.push({ table: "contacts", id: (buyer as { id: string }).id })

    const today = new Date().toISOString().slice(0, 10)
    const { data: tour, error: tourErr } = await svc.from("tours").insert({
      brokerage_id: brokerageId, contact_id: (buyer as { id: string }).id,
      buyer_id: (buyer as { id: string }).id, agent_id: (agent as { id: string }).id,
      tour_date: today, start_time: "10:00", status: "confirmed",
    }).select("id").single()
    if (tourErr || !tour) { console.log(`  ⏭  Skipped — ${tourErr?.message}`); report(); return }
    cleanup.push({ table: "tours", id: (tour as { id: string }).id })

    const { data: stop, error: stopErr } = await svc.from("tour_stops").insert({
      tour_id: (tour as { id: string }).id, brokerage_id: brokerageId,
      contact_id: (buyer as { id: string }).id, order_index: 0,
      property_address: `${TAG} 1 Check-In Way`,
    }).select("id, time_arrived_at, time_left_at, time_spent_minutes").single()
    if (stopErr || !stop) { console.log(`  ⏭  Skipped — ${stopErr?.message}`); report(); return }
    const stopId = (stop as { id: string }).id
    cleanup.push({ table: "tour_stops", id: stopId })

    // THE BASELINE, RE-PROVEN ON A FRESH ROW: a brand-new stop carries none of the
    // three. This is the "before" number §2 requires, measured rather than recalled.
    const fresh = stop as { time_arrived_at: string | null; time_left_at: string | null; time_spent_minutes: number | null }
    check("BASELINE — a fresh tour_stop has all three columns NULL (no default, no trigger)",
      fresh.time_arrived_at === null && fresh.time_left_at === null && fresh.time_spent_minutes === null)

    // ── THE DERIVATION REFUSES A DIRECT WRITE ─────────────────────────────────
    // This is what makes "deriving rather than trusting a client-supplied number"
    // a structural guarantee instead of a code convention.
    const { error: forcedErr } = await svc.from("tour_stops")
      .update({ time_spent_minutes: 999 }).eq("id", stopId).select("id")
    check("time_spent_minutes REFUSES a direct write — a caller cannot assert a duration",
      !!forcedErr, forcedErr ? `refused: ${forcedErr.code ?? forcedErr.message}` : "ACCEPTED 999 — the column is not generated")

    // ── POSITIVE CONTROL · CHECK IN ───────────────────────────────────────────
    const arrivedAt = new Date(Date.now() - 47 * 60_000).toISOString()
    const { data: arrivedRows, error: arriveErr } = await svc.from("tour_stops")
      .update({ time_arrived_at: arrivedAt })
      .eq("id", stopId).eq("tour_id", (tour as { id: string }).id).eq("brokerage_id", brokerageId)
      .select("id, time_arrived_at, time_left_at, time_spent_minutes")
    check("check-IN lands: the UPDATE reports exactly 1 affected row",
      !arriveErr && (arrivedRows ?? []).length === 1, arriveErr?.message)
    const afterArrive = (arrivedRows ?? [])[0] as { time_arrived_at: string | null; time_spent_minutes: number | null } | undefined
    check("time_arrived_at is POPULATED", !!afterArrive?.time_arrived_at)
    // The rule that keeps an absence from becoming a fact.
    check("a half-recorded visit derives NULL minutes, NOT 0",
      afterArrive?.time_spent_minutes === null,
      String(afterArrive?.time_spent_minutes))

    // ── POSITIVE CONTROL · CHECK OUT ──────────────────────────────────────────
    const leftAt = new Date(Date.now() - 2 * 60_000).toISOString()
    const { data: leftRows, error: leaveErr } = await svc.from("tour_stops")
      .update({ time_left_at: leftAt })
      .eq("id", stopId).eq("tour_id", (tour as { id: string }).id).eq("brokerage_id", brokerageId)
      .select("id, time_arrived_at, time_left_at, time_spent_minutes")
    check("check-OUT lands: the UPDATE reports exactly 1 affected row",
      !leaveErr && (leftRows ?? []).length === 1, leaveErr?.message)
    const final = (leftRows ?? [])[0] as {
      time_arrived_at: string | null; time_left_at: string | null; time_spent_minutes: number | null
    } | undefined
    check("ALL THREE COLUMNS POPULATED — the writerless read is closed",
      !!final?.time_arrived_at && !!final?.time_left_at && final?.time_spent_minutes != null,
      JSON.stringify(final))
    check("the derived duration matches the two stamps (45 minutes)",
      final?.time_spent_minutes === 45, String(final?.time_spent_minutes))

    // ── A NEGATIVE DURATION IS REFUSED, NOT CLAMPED ───────────────────────────
    const { error: skewErr } = await svc.from("tour_stops")
      .update({ time_left_at: new Date(new Date(arrivedAt).getTime() - 60_000).toISOString() })
      .eq("id", stopId).select("id")
    check("a departure BEFORE the arrival is refused by tour_stops_visit_window_check",
      !!skewErr, skewErr ? `refused: ${skewErr.code ?? skewErr.message}` : "ACCEPTED — the CHECK is missing")

    // ── TENANT PREDICATE · THE REFUSAL IS OBSERVABLE ──────────────────────────
    // The whole reason the writer counts rows: a wrong-tenant UPDATE resolves with
    // error === null and an EMPTY result, which is byte-identical to one that
    // worked. Prove the count is what distinguishes them.
    const { data: wrongTenant, error: wrongErr } = await svc.from("tour_stops")
      .update({ time_left_at: new Date().toISOString() })
      .eq("id", stopId)
      .eq("brokerage_id", "00000000-0000-0000-0000-000000000000")
      .select("id")
    check("a WRONG-TENANT update resolves with NO error — only the row count reveals the refusal",
      !wrongErr && (wrongTenant ?? []).length === 0,
      `error=${wrongErr?.message ?? "null"} rows=${(wrongTenant ?? []).length}`)
  } finally {
    // §3 — a DELETE that matches NOTHING also resolves clean. .select() each one
    // and COUNT what came back, or "cleaned up" is an unverified claim.
    console.log("\n[3 · test-data cleanup — counted, not assumed]")
    let deleted = 0
    for (const c of [...cleanup].reverse()) {
      const { data, error } = await svc.from(c.table).delete().eq("id", c.id).select("id")
      if (error) { console.log(`  ! ${c.table}/${c.id}: ${error.message}`); continue }
      deleted += (data ?? []).length
    }
    check(`every seeded row deleted and COUNTED back (${deleted} of ${cleanup.length})`,
      deleted === cleanup.length, `${deleted}/${cleanup.length}`)
    const { count: leftoverStops } = await svc.from("tour_stops")
      .select("id", { count: "exact", head: true }).like("property_address", `${TAG}%`)
    check("0 seeded tour_stops remain", (leftoverStops ?? 0) === 0, String(leftoverStops))
    const { count: leftoverContacts } = await svc.from("contacts")
      .select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("0 seeded contacts remain", (leftoverContacts ?? 0) === 0, String(leftoverContacts))
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
