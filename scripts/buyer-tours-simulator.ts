#!/usr/bin/env tsx
/**
 * scripts/buyer-tours-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUYER TOURS — THE LANE IS `tours` + `tour_stops`, AND IT IS WIRED END-TO-END.
 *
 * Owner ruling: an orphan with no caller, no writer, and no duplicate is a
 * feature to BUILD — buyer tours was the named example. This harness proves the
 * built lane, complementing scripts/tour-optimizer-simulator.ts (which
 * exercises the kernel itself, pure + live-seeded). This file proves the
 * WIRING — that every surface in the create→optimize→confirm→dispatch chain
 * calls the real kernel and the real dispatch lane, IMPORT-PINNED to the
 * canonical modules rather than name-spelled lookalikes:
 *
 *   1. CREATE    — the CRM plan tab calls createTourPlan (tours + tour_stops +
 *                  showings writer), and no longer stamps a zero drive total
 *                  that marked every UI tour "already optimized" to the kernel.
 *   2. OPTIMIZE  — the optimizeTourRoute ACTION delegates to
 *                  lib/kernel/tour-optimizer (haversine + Nominatim + honest
 *                  degradation), not the retired LLM-guess + `stops * 8`
 *                  fabrication; the workflow schedule_tour adapter pins the
 *                  KERNEL module (an action gated on a session is a no-op in a
 *                  sessionless workflow run).
 *   3. CONFIRM   — the confirm tab keeps a 'scheduling' tour visible (the
 *                  finalize step was unreachable: "Schedule Showings" flipped
 *                  planned→scheduling and the tab's filter dropped it).
 *   4. DISPATCH  — scheduleTourStops routes every stop through
 *                  dispatchStopScheduling (app/actions/dispatch-showing.ts →
 *                  lib/showings/dispatchers.ts), never a duplicate scheduler,
 *                  and reports sent vs drafted honestly.
 *   5. PORTAL    — the buyer's page reads tours through getPortalBuyerTours,
 *                  which is requireContactAccess-gated (isContactSelf pattern),
 *                  contact-scoped, error-destructured, and omits other-brokerage
 *                  listing-agent contact fields (owner ruling #185).
 *   6. NO TWIN   — no runtime code path reads or writes `buyer_tours`; the
 *                  only lane is `tours`/`tour_stops` (m480 drops the twin).
 *
 * Source assertions are COMMENT-MASKED (an import spelled in prose must not
 * pass) and NEGATIVE-CONTROLLED (each matcher is proven to fail on a fixture
 * built to violate it). The kernel is also runtime-import-pinned: the module
 * the action names is imported here and its sequencer is executed on known
 * coordinates.
 *
 * Run: npx tsx scripts/buyer-tours-simulator.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

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
  console.log(" ✅ Buyer-tours lane verified — create→optimize→confirm→dispatch on the real kernel + dispatch lane, portal contact-self-scoped, no buyer_tours twin in any code path")
}

// ── comment stripping ────────────────────────────────────────────────────────
// Delimiters are BUILT, never typed literally, so this file can scan itself
// without a literal `/*` swallowing the rest of the source.
const SLASH = String.fromCharCode(47)
const STAR = String.fromCharCode(42)
const BLOCK_COMMENT = new RegExp(SLASH + "\\" + STAR + "[\\s\\S]*?\\" + STAR + SLASH, "g")
const LINE_COMMENT = new RegExp("(^|[^:])" + SLASH + SLASH + ".*$", "gm")
function stripComments(source: string): string {
  // Line comments keep the leading char they matched (so `https://` survives via [^:]).
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "$1")
}

function masked(relPath: string): string {
  return stripComments(readFileSync(join(root, relPath), "utf8"))
}

/** Slice one exported function's body out of a masked source (up to the next export). */
function fnSlice(maskedSrc: string, fnName: string): string {
  const start = maskedSrc.indexOf(`export async function ${fnName}`)
  if (start < 0) return ""
  const next = maskedSrc.indexOf("\nexport ", start + 1)
  return maskedSrc.slice(start, next < 0 ? undefined : next)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer-tours lane simulator (wiring + import pins)")
  console.log("══════════════════════════════════════════════════")

  // ── [0] Negative controls — every matcher must FAIL on a violating fixture ──
  console.log("\n[0 · negative controls — the matchers can fail]")
  const KERNEL_SPEC = "@/lib/kernel/tour-optimizer"
  const importPinned = (src: string, spec: string) =>
    new RegExp(`(from\\s*["']${spec}["']|import\\(\\s*["']${spec}["']\\s*\\))`).test(src)

  const commentOnlyFixture = stripComments(
    [SLASH + SLASH + ` uses import("${KERNEL_SPEC}") — but only in prose`,
     `export async function optimizeTourRoute() { return null }`].join("\n"),
  )
  check("comment-mask control: kernel import spelled ONLY in a comment does NOT pass",
    !importPinned(commentOnlyFixture, KERNEL_SPEC))
  const realImportFixture = stripComments(
    `const m = await import("${KERNEL_SPEC}")\n` + SLASH + SLASH + " real code\n",
  )
  check("comment-mask control: a real (uncommented) kernel import DOES pass",
    importPinned(realImportFixture, KERNEL_SPEC))

  const buyerToursRead = /\.\s*from\s*\(\s*["'`]buyer_tours["'`]\s*\)/
  check("buyer_tours scanner control: a fixture .from(\"buyer_tours\") IS caught",
    buyerToursRead.test(`await supabase.from("buyer_tours").insert({})`))
  check("buyer_tours scanner control: the string as a UI label is NOT a table access",
    !buyerToursRead.test(`source: "buyer_tours",`))

  // ── [1] CREATE — CRM plan tab → createTourPlan on tours/tour_stops ──────────
  console.log("\n[1 · create — CRM plan tab pins the canonical tour writer]")
  const planTab = masked("app/crm/contacts/[contactId]/tours/components/tour-plan-tab.tsx")
  check("plan tab imports createTourPlan from @/app/actions/tour-planner",
    /import\s*\{[^}]*createTourPlan[^}]*\}\s*from\s*['"]@\/app\/actions\/tour-planner['"]/.test(planTab))
  const tourPlanner = masked("app/actions/tour-planner.ts")
  const createSlice = fnSlice(tourPlanner, "createTourPlan")
  check("createTourPlan writes tours AND tour_stops (the canonical pair)",
    /\.from\(['"]tours['"]\)/.test(createSlice) && /\.from\(['"]tour_stops['"]\)/.test(createSlice))
  check("createTourPlan also inserts showings rows for listing-backed stops",
    /\.from\(['"]showings['"]\)/.test(createSlice))
  check("plan tab no longer stamps a 0 drive total (the kernel's idempotency stamp)",
    /totalDriveTimeMinutes:\s*totalDriveMins\s*>\s*0\s*\?\s*totalDriveMins\s*:\s*undefined/.test(planTab))
  check("plan tab no longer calls a browser-side LLM for routing (fabrication lane removed)",
    !/generateText/.test(planTab))

  // ── [2] OPTIMIZE — action + adapter pin the KERNEL optimizer ────────────────
  console.log("\n[2 · optimize — the real kernel, import-pinned]")
  const showingMgmt = masked("app/actions/ai-showing-management.ts")
  const optimizeSlice = fnSlice(showingMgmt, "optimizeTourRoute")
  check("optimizeTourRoute ACTION exists", optimizeSlice.length > 0)
  check("optimizeTourRoute action import-pins the kernel module",
    importPinned(optimizeSlice, KERNEL_SPEC))
  check("optimizeTourRoute action no longer asks an LLM to guess the order",
    !/generateText/.test(optimizeSlice))
  check("optimizeTourRoute action no longer fabricates drive time (stops * 8)",
    !/\*\s*8\b/.test(optimizeSlice))
  check("optimizeTourRoute action is session-gated + tenant-pinned",
    /getAgentContext\(\)/.test(optimizeSlice) && /brokerage_id\s*!==\s*ctx\.brokerageId/.test(optimizeSlice))
  check("optimizeTourRoute action destructures the tour read's error",
    /\{\s*data:\s*tour,\s*error:\s*tourError\s*\}/.test(optimizeSlice))

  const adapter = masked("lib/workflow/adapters/schedule-tour.ts")
  check("schedule_tour workflow adapter import-pins the KERNEL (not the session-gated action)",
    importPinned(adapter, KERNEL_SPEC) && !/@\/app\/actions\/ai-showing-management/.test(adapter))
  check("schedule_tour adapter writes the canonical pair (tours + tour_stops), enriched from saved_properties",
    /\.from\(['"]tours['"]\)/.test(adapter) && /\.from\(['"]tour_stops['"]\)/.test(adapter) &&
    /\.from\(['"]saved_properties['"]\)/.test(adapter))

  const confirmTab = masked("app/crm/contacts/[contactId]/tours/components/tour-confirm-tab.tsx")
  check("confirm tab's Optimize Route pins the same action module",
    /import\s*\{[^}]*optimizeTourRoute[^}]*\}\s*from\s*['"]@\/app\/actions\/ai-showing-management['"]/.test(confirmTab))

  // Runtime import-pin: the module the action names is imported HERE and its
  // sequencer executed on known coordinates — the pin is to behavior, not to a
  // name. (The kernel is deliberately not server-only for exactly this reason.)
  const kernel = await import("../lib/kernel/tour-optimizer")
  check("kernel module loads and exposes optimizeTourRoute + runTourOptimizer",
    typeof kernel.optimizeTourRoute === "function" && typeof kernel.runTourOptimizer === "function")
  const seq = kernel.sequenceStopsByDriveTime(
    [
      { id: "C", order_index: 0, lat: 40.30, lng: -74.0 },
      { id: "A", order_index: 1, lat: 40.00, lng: -74.0 },
      { id: "B", order_index: 2, lat: 40.05, lng: -74.0 },
    ],
    { lat: 39.99, lng: -74.0 },
  )
  check("pinned kernel really sequences nearest-neighbor (C,A,B → A,B,C)",
    seq.map((s) => s.id).join("") === "ABC")
  check("pinned kernel degrades honestly — un-geocoded stop keeps NULL drive",
    kernel.sequenceStopsByDriveTime([{ id: "X", order_index: 0, lat: null, lng: null }], null)[0].driveMinutes === null)

  // ── [3] CONFIRM — the finalize step is reachable ───────────────────────────
  console.log("\n[3 · confirm — scheduling tours stay visible; finalize is the canonical lock-in]")
  check("confirm tab keeps 'scheduling' tours listed (finalize step reachable)",
    /\[\s*['"]planned['"]\s*,\s*['"]scheduling['"]\s*,\s*['"]confirmed['"]\s*\]/.test(confirmTab))
  check("confirm tab pins confirm/finalize to @/app/actions/tour-planner",
    /import\s*\{[^}]*finalizeTour[^}]*\}\s*from\s*['"]@\/app\/actions\/tour-planner['"]/.test(confirmTab))
  const finalizeSlice = fnSlice(tourPlanner, "finalizeTour")
  check("finalizeTour stamps agent approval + report_sent_at and writes calendar_events",
    /agent_approved_at/.test(finalizeSlice) && /report_sent_at/.test(finalizeSlice) &&
    /\.from\(['"]calendar_events['"]\)/.test(finalizeSlice))

  // ── [4] DISPATCH — stops go out through the real dispatch lane ─────────────
  console.log("\n[4 · dispatch — the existing showing-dispatch lane, never a duplicate]")
  check("tour-planner imports dispatchStopScheduling from @/app/actions/dispatch-showing",
    /import\s*\{\s*dispatchStopScheduling\s*\}\s*from\s*['"]@\/app\/actions\/dispatch-showing['"]/.test(tourPlanner))
  const scheduleSlice = fnSlice(tourPlanner, "scheduleTourStops")
  check("scheduleTourStops calls dispatchStopScheduling per stop (no bespoke sender)",
    /dispatchStopScheduling\(\s*\{\s*tourStopId:\s*stop\.id/.test(scheduleSlice))
  check("scheduleTourStops reports refusals as refusals (a refused stop fails the call)",
    /success:\s*false/.test(scheduleSlice) && /Dispatch refused/.test(scheduleSlice))
  check("scheduleTourStops counts sent vs drafted honestly (no 'contacted' fiction)",
    /res\.sent/.test(scheduleSlice) && /drafted/.test(scheduleSlice))
  const dispatchShowing = masked("app/actions/dispatch-showing.ts")
  check("dispatch-showing pins the canonical channel dispatchers (lib/showings/dispatchers)",
    /from\s*["']@\/lib\/showings\/dispatchers["']/.test(dispatchShowing) &&
    /dispatchViaShowingTime/.test(dispatchShowing) && /dispatchViaSms/.test(dispatchShowing) &&
    /dispatchViaEmail/.test(dispatchShowing))
  check("confirm tab's per-stop send pins the SAME dispatch action",
    /import\s*\{\s*dispatchStopScheduling\s*\}\s*from\s*['"]@\/app\/actions\/dispatch-showing['"]/.test(confirmTab))

  // ── [5] PORTAL — buyer sees their own tour, contact-self-scoped ────────────
  console.log("\n[5 · portal — contact-self-scoped reader (owner ruling #185)]")
  const portalPage = masked("app/portal/[contactId]/showings/page.tsx")
  check("portal showings page pins getPortalBuyerTours from @/app/actions/portal-tours",
    /import\s*\{\s*getPortalBuyerTours\s*\}\s*from\s*["']@\/app\/actions\/portal-tours["']/.test(portalPage) &&
    /getPortalBuyerTours\(contactId\)/.test(portalPage))
  check("portal page no longer reads tours with the RLS client (the silently-refused path)",
    !/from\(["']tours["']\)/.test(portalPage))
  check("portal page surfaces a failed tour read as a refusal, not an empty list",
    /toursResult\.success/.test(portalPage))
  const portalTours = masked("app/actions/portal-tours.ts")
  check("portal reader pins requireContactAccess (the shared isContactSelf gate)",
    /import\s*\{\s*requireContactAccess\s*\}\s*from\s*["']@\/lib\/portal\/require-contact-access["']/.test(portalTours) &&
    /await requireContactAccess\(contactId\)/.test(portalTours))
  check("portal reader refuses before reading when the gate refuses",
    /if\s*\(!access\.ok\)\s*return\s*\{\s*success:\s*false/.test(portalTours))
  check("portal reader scopes to the contact's own rows + the gate-resolved tenant",
    /\.eq\(["']contact_id["'],\s*contactId\)/.test(portalTours) &&
    /\.eq\(["']brokerage_id["'],\s*access\.brokerageId\)/.test(portalTours))
  check("portal reader destructures the read error and reports refusal as refusal",
    /\{\s*data,\s*error\s*\}/.test(portalTours) && /if\s*\(error\)\s*return\s*\{\s*success:\s*false/.test(portalTours))
  check("portal reader omits listing-agent contact fields + door codes (buyer never sees them)",
    !/listing_agent_/.test(portalTours) && !/access_code/.test(portalTours))
  const gate = masked("lib/portal/require-contact-access.ts")
  check("the pinned gate really is the isContactSelf pattern (contact_user_id / email / accepted invite)",
    /isContactSelf/.test(gate) && /contact_user_id\s*===\s*authUser\.id/.test(gate) &&
    /portal_contact_invites/.test(gate))

  // ── [6] NO TWIN — nothing reads or writes buyer_tours ──────────────────────
  console.log("\n[6 · no code path touches the buyer_tours twin]")
  const roots = ["app", "lib", "components", "hooks", "services", "workflows"]
  const offenders: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const n of entries) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = join(dir, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(n)) {
        const src = stripComments(readFileSync(p, "utf8"))
        if (buyerToursRead.test(src)) offenders.push(relative(root, p))
      }
    }
  }
  for (const r of roots) walk(join(root, r))
  check("zero .from(\"buyer_tours\") accesses across app/lib/components/hooks/services/workflows",
    offenders.length === 0, offenders.join(", "))
  check("m480 migration exists, is row-count-guarded, and refuses a populated table",
    (() => {
      const m = readFileSync(join(root, "supabase/migrations/m480-buyer-tours-was-a-twin-and-the-real-lane-is-tours.sql"), "utf8")
      return /count\(\*\)\s+from\s+public\.buyer_tours/i.test(m) &&
             /raise exception/i.test(m) && /drop table public\.buyer_tours/i.test(m)
    })())

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
