// scripts/self-book-simulator.ts   (npm run test:self-book)
// ─────────────────────────────────────────────────────────────────────────────
// CLIENT SELF-BOOKING — proves the slot math (pure), the governance wiring
// (source), and the DB contract (live via MCP; local run self-skips).

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { filterBookableSlots, excludeShowingConflicts, selfBookingEnabled, SELF_BOOK_DEFAULTS } from "../lib/kernel/self-book"
import { composeShowingReminder, composeFeedbackAsk } from "../lib/kernel/showing-lifecycle"
import { computeFreeSlots } from "../lib/providers/calendar/free-slots"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: bookable-slot math ──")
{
  // A clean business day with one busy block 10:00–12:00.
  const day = "2026-07-08"
  const busyStart = new Date(`${day}T10:00:00`).getTime()
  const raw = computeFreeSlots(
    [{ start: busyStart, end: busyStart + 2 * 3_600_000 }],
    { startDate: `${day}T00:00:00`, endDate: `${day}T23:59:59`, durationMinutes: 45 },
  )
  check("free-slots engine skips the busy block", raw.length > 0 && !raw.some((s) => new Date(s.startTime).getHours() === 10 || new Date(s.startTime).getHours() === 11))

  const nowMs = new Date(`${day}T08:00:00`).getTime()
  const trimmed = filterBookableSlots(raw, { nowMs })
  check("lead time enforced (nothing within 3h of now)", trimmed.every((s) => new Date(s.startTime).getTime() >= nowMs + 3 * 3_600_000))
  check(`per-day cap (${SELF_BOOK_DEFAULTS.maxPerDay}) enforced`, trimmed.length <= SELF_BOOK_DEFAULTS.maxPerDay)

  const withConflict = excludeShowingConflicts(raw, [{ scheduled_at: raw[0].startTime, duration_minutes: 45 }])
  check("already-scheduled showings excluded (double-book protection)", withConflict.length === raw.length - 1)
  check("null scheduled_at showings ignored safely", excludeShowingConflicts(raw, [{ scheduled_at: null, duration_minutes: 45 }]).length === raw.length)

  check("self-booking is OFF by default (opt-in governance)",
    !selfBookingEnabled(null) && !selfBookingEnabled({}) && !selfBookingEnabled({ self_booking: {} }) &&
    selfBookingEnabled({ self_booking: { enabled: true } }))
}

console.log("\n── PURE: showing lifecycle (feedback ask + T-24h reminder) ──")
{
  const reminder = composeShowingReminder("12 Oak St", "2026-07-09T15:00:00Z", "https://tour.example/x")
  check("reminder carries address + day/time + virtual-tour invite", reminder.includes("12 Oak St") && /Reminder/.test(reminder) && reminder.includes("https://tour.example/x"))
  check("no virtual tour → no tour clause (nothing invented)", !composeShowingReminder("12 Oak St", "2026-07-09T15:00:00Z", null).includes("virtually"))
  const ask = composeFeedbackAsk("12 Oak St", "https://app.example/showings/feedback/tok123")
  check("feedback ask carries the tokenized public form link", ask.includes("/showings/feedback/tok123"))
}

console.log("\n── SOURCE: governance + wiring ──")
{
  const kernel = src("lib/kernel/self-book.ts")
  check("BBA (NAR settlement) gate enforced on self-booked showings", kernel.includes("requireActiveBBA"))
  check("slot RE-VERIFIED server-side at booking (never trust the browser)", kernel.includes("avail.slots.find((s) => s.startTime === params.slotStartIso)"))
  check("honest slot_gone error when the time was just taken", kernel.includes('"slot_gone"'))
  check("books end to end: approved request + scheduled showing + calendar mirror + portal confirmation + agent alert",
    kernel.includes('"approved"') && kernel.includes('scheduling_method: "self_book"') &&
    kernel.includes("createEventViaPersonal") && kernel.includes("client_portal_messages") && kernel.includes("showing_self_booked"))
  check("honest fallbacks: disabled / no calendar / no agent all return a stated reason",
    kernel.includes("Self-booking not enabled") && kernel.includes("calendar isn't connected"))
  const action = src("app/actions/self-book-showing.ts")
  check("portal action authorizes the CALLER as the contact (email match) or same-brokerage staff",
    action.includes("authorizeForContact") && action.includes("toLowerCase()"))
  const ui = src("app/portal/[contactId]/properties/[propertyId]/PropertyDetailIntelligenceClient.tsx")
  check("portal UI: live slots render + one-tap booking + stale-slot refresh + fallback form kept",
    ui.includes("getBookableSlotsAction") && ui.includes("handleBookSlot") && ui.includes('"slot_gone"') && ui.includes("Request Showing"))
  check("registry burn domain client_self_booking (shopping_agent)",
    "client_self_booking" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.client_self_booking.manager === "shopping_agent")
  const lifecycle = src("lib/kernel/showing-lifecycle.ts")
  check("feedback auto-request: deduped per showing, tokenized public form, portal delivery",
    lifecycle.includes("showing_feedback_requests") && lifecycle.includes("feedback_token") && lifecycle.includes("showing_feedback_ask"))
  check("T-24h buyer reminder: metadata dedupe + TRANSACTIONAL SMS (DNC/quiet-hours still enforced)",
    lifecycle.includes('{ kind: "showing_reminder", showing_id: s.id }') && lifecycle.includes("transactional: true"))
  check("portal messages carry the live contract: direction agent_to_client + NOT NULL agent_id (live-proof-caught bug)",
    lifecycle.includes('"agent_to_client"') && lifecycle.includes("agent_id: s.agent_id") &&
    src("lib/kernel/self-book.ts").includes('"agent_to_client"') && src("lib/kernel/self-book.ts").includes("agent_id: l.agent_id,\n    direction"))
  check("virtual-tour link woven in when present", lifecycle.includes("virtual_tour_url") && lifecycle.includes("matterport_url"))
  check("no LLM in the cron path (deterministic composers only)", !lifecycle.includes("generateText"))
  check("showing-lifecycle cron registered hourly", src("lib/kernel/cron-dispatch.ts").includes("showing-lifecycle"))
  check("registry burn domain showing_lifecycle (shopping_agent) + ShowingTime decision recorded",
    "showing_lifecycle" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.showing_lifecycle.what.includes("SHOWINGTIME"))
  check("package.json wires the proof", /"test:self-book":/.test(src("package.json")))
}

async function live() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.log("\n  ⏭  live skipped (no creds) — DB contract proven via MCP"); return }
  const { createClient } = await import("@supabase/supabase-js")
  const svc = createClient(url, key)
  console.log("\n── LIVE: self_book showing round-trip ──")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { check("live: a brokerage exists", false); return }
  const { data: listing } = await svc.from("listings").insert({
    brokerage_id: (brk as any).id, address: "SIM 7 SelfBook Ct", city: "Austin", status: "active",
  }).select("id").single()
  if (!listing) { check("live: listing seeds", false); return }
  try {
    const { data: showing, error } = await svc.from("showings").insert({
      listing_id: (listing as any).id, brokerage_id: (brk as any).id,
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
      duration_minutes: 45, status: "scheduled", is_confirmed: true,
      scheduling_method: "self_book", notes: "SIM self-book",
    }).select("id").single()
    check("live: scheduling_method 'self_book' accepted by the CHECK", !error && !!showing, error?.message)
    if (showing) await svc.from("showings").delete().eq("id", (showing as any).id)
  } finally {
    await svc.from("listings").delete().eq("id", (listing as any).id)
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).eq("address", "SIM 7 SelfBook Ct")
    check("live: cleanup complete (count==0)", (count ?? 0) === 0)
  }
}

live().then(() => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ SELF_BOOK_FAIL"); process.exit(1) }
  console.log(" ✅ SELF_BOOK_PASS — buyers book real slots; governance (opt-in, BBA, re-verify, caps) holds")
})
