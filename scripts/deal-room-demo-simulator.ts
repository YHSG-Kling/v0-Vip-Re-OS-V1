// scripts/deal-room-demo-simulator.ts   (npm run test:deal-room-demo)
// ─────────────────────────────────────────────────────────────────────────────
// THE DEAL ROOM DEMO — proves the staged showcase seeder without a database:
//
// PURE:   fixed ids are deterministic, live in entity blocks ≥ 9001 (can never
//         collide with the round-21 demo dataset's blocks 1–7), and every row
//         the story plan inserts carries a demo marker (hasDealRoomMarker —
//         the write-shape contract). The demo-day guard recognizes round-21
//         rows and story-derived rows, and flags anything unmarked. The
//         teardown order is FK-safe (children before parents). The runbook has
//         a presenter note on every step, the flagship line verbatim, and
//         every deep link resolves to a real route on disk.
// SOURCE: the seeder refuses non-demo tenants (is_demo re-check before any
//         write), runs the demo-day guard BEFORE wiping/writing, raises the
//         deliberation through the REAL rails (raiseCrossManagerReferral +
//         consumeManagerSignals → runDeliberation — no forked engine, never a
//         hand-written payload.deliberation), and the superadmin actions are
//         capability-gated with audit rows.

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  DEAL_ROOM_TAG,
  DEAL_ROOM_PROVENANCE,
  DEAL_ROOM_IDS,
  DEAL_ROOM_STALL_LISTING_ID,
  DEAL_ROOM_GUARD_TABLES,
  DEAL_ROOM_TEARDOWN_ORDER,
  DEAL_ROOM_FLAGSHIP_NOTE,
  ROUND21_DEMO_TAG,
  dealRoomUuid,
  isDealRoomId,
  isDemoFixedId,
  hasDealRoomMarker,
  isRecognizedDemoRow,
  buildDealRoomStoryPlan,
  buildDealRoomRunbook,
} from "../lib/platform/deal-room-demo"
import { isDeliberativeDomain } from "../lib/managers/deliberation"
import { validateReferral } from "../lib/managers/cross-referral"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const LIB = "lib/platform/deal-room-demo.ts"
const ACTION = "app/actions/superadmin/deal-room-demo.ts"
const PAGE = "app/dashboard/superadmin/demo-room/page.tsx"
const CLIENT = "app/dashboard/superadmin/demo-room/demo-room-client.tsx"

console.log("\n── PURE: deterministic marked ids ──")
{
  check("dealRoomUuid is deterministic", dealRoomUuid(9001, 1) === dealRoomUuid(9001, 1))
  check("dealRoomUuid refuses the round-21 entity range (< 9001)", (() => {
    try { dealRoomUuid(3, 1); return false } catch { return true }
  })())
  const all = [DEAL_ROOM_IDS.market, DEAL_ROOM_IDS.raw, ...DEAL_ROOM_IDS.saves, DEAL_ROOM_IDS.offer,
    DEAL_ROOM_IDS.calendarEvent, DEAL_ROOM_IDS.voiceCall, DEAL_ROOM_IDS.callAnalysis, DEAL_ROOM_IDS.recap]
  check("every fixed story id is a deal-room id (block ≥ 9001) — the id IS a marker", all.every(isDealRoomId))
  check("no fixed story id can collide with a round-21 id (blocks 1–7)",
    all.every((id) => !/^dde00000-0000-4000-a000-000[1-7]/.test(id)))
  check("all fixed ids are unique", new Set(all).size === all.length)
  check("the stall listing id is the round-21 demoUuid(3,1) fixture (listing #1)",
    DEAL_ROOM_STALL_LISTING_ID === "dde00000-0000-4000-a000-000300000001" && isDemoFixedId(DEAL_ROOM_STALL_LISTING_ID))
  check("round-21 fixture ids are recognized as demo ids but NOT as deal-room ids",
    isDemoFixedId(DEAL_ROOM_STALL_LISTING_ID) && !isDealRoomId(DEAL_ROOM_STALL_LISTING_ID))
}

console.log("\n── PURE: the story plan — a marker on EVERY seeded row (write-shape) ──")
{
  const input = {
    brokerageId: "b-1", agentId: "agent-1", ownerUserId: "user-1",
    stallListing: { id: DEAL_ROOM_STALL_LISTING_ID, address: "1200 Showcase Blvd" },
    buyerContactIds: ["c-1", "c-2", "c-3"],
    now: new Date("2026-07-20T12:00:00Z"),
  }
  const plan = buildDealRoomStoryPlan(input)
  const rows: Array<[string, Record<string, unknown>]> = [
    ["market", plan.market], ["raw", plan.raw],
    ...plan.saves.map((s, i) => [`saves[${i}]`, s] as [string, Record<string, unknown>]),
    ["offer", plan.offer], ["calendarEvent", plan.calendarEvent],
    ["voiceCall", plan.voiceCall], ["callAnalysis", plan.callAnalysis], ["recapCard", plan.recapCard],
  ]
  for (const [name, row] of rows) {
    check(`plan.${name} carries a demo marker`, hasDealRoomMarker(row))
    check(`plan.${name} is scoped to the demo brokerage`, row.brokerage_id === "b-1")
  }
  check("the referral payload carries the marker (the ledger row is marked too)",
    (plan.referralPayload as { demo_marker?: string }).demo_marker === DEAL_ROOM_TAG)
  check("the referral ask names the marker (visible on the governance surface)",
    plan.referralAsk.includes(DEAL_ROOM_TAG))
  check("the synthetic transcript declares its provenance in the artifact itself",
    String(plan.voiceCall.transcription).startsWith(`[${DEAL_ROOM_TAG}] SYNTHETIC TRANSCRIPT`))
  check("the transcript has Caller: lines (the voice-intel analyzable shape)",
    /(^|\n)Caller:/.test(String(plan.voiceCall.transcription)))
  check("the staged analysis is provenance-labeled (analyzed_by)",
    plan.callAnalysis.analyzed_by === DEAL_ROOM_PROVENANCE)
  check("the recap card is the portal's real meeting_recap shape",
    plan.recapCard.update_type === "meeting_recap" && plan.recapCard.is_visible_to_client === true)
  check("the recap metadata carries demo provenance",
    (plan.recapCard.metadata as { demo_marker?: string; staged_by?: string }).demo_marker === DEAL_ROOM_TAG &&
    (plan.recapCard.metadata as { staged_by?: string }).staged_by === DEAL_ROOM_PROVENANCE)
  check("the fictional prospect uses the reserved-domain idiom (never a deliverable address)",
    String(plan.raw.email).endsWith(".example.com"))

  // Idempotency: the same input converges to the same plan (fixed ids, fixed content).
  const again = buildDealRoomStoryPlan(input)
  check("the plan is deterministic — a re-seed converges (idempotency by fixed ids)",
    JSON.stringify(plan) === JSON.stringify(again))
  check("demand evidence rides the round-21 buyer contacts + the round-21 listing (its own seeded facts)",
    plan.saves.every((s) => s.listing_id === DEAL_ROOM_STALL_LISTING_ID) &&
    plan.saves[0].contact_id === "c-1" && plan.offer.listing_id === DEAL_ROOM_STALL_LISTING_ID)
}

console.log("\n── PURE: the demo-day guard (never clobbers) ──")
{
  const none = new Set<string>()
  check("a round-21 fixed-id row is recognized (guard never trips on the canonical dataset)",
    isRecognizedDemoRow({ id: DEAL_ROOM_STALL_LISTING_ID }, none))
  check("a round-21 tagged row is recognized (tags idiom)",
    isRecognizedDemoRow({ id: "random-id", tags: [ROUND21_DEMO_TAG] }, none))
  check("a round-21 noted row is recognized (notes idiom)",
    isRecognizedDemoRow({ id: "random-id", notes: `[${ROUND21_DEMO_TAG}] something` }, none))
  check("a deal-room marked row is recognized",
    isRecognizedDemoRow({ id: "random-id", tags: [DEAL_ROOM_TAG] }, none))
  check("a rail-minted row keyed to a known story entity is recognized (derived ids)",
    isRecognizedDemoRow({ id: "random-id", contact_id: "story-contact" }, new Set(["story-contact"])))
  check("an UNMARKED real-looking row is NOT recognized → the guard refuses",
    !isRecognizedDemoRow({ id: "5f0e0d0c-1111-4222-8333-444455556666", first_name: "Real", last_name: "Person" }, none))
  check("guard scans the human-data tables the story touches",
    ["leads", "contacts", "listings", "raw_scraped_leads", "saved_properties", "offers", "calendar_events", "voice_calls", "transparency_updates"]
      .every((t) => (DEAL_ROOM_GUARD_TABLES as readonly string[]).includes(t)))
}

console.log("\n── PURE: teardown order is FK-safe (children before parents) ──")
{
  const order = DEAL_ROOM_TEARDOWN_ORDER as readonly string[]
  const before = (a: string, b: string) => order.indexOf(a) !== -1 && order.indexOf(b) !== -1 && order.indexOf(a) < order.indexOf(b)
  check("call_analyses before voice_calls (voice_call_id FK)", before("call_analyses", "voice_calls"))
  check("messages before conversations", before("messages", "conversations"))
  check("raw_scraped_leads before leads (raw.lead_id FK)", before("raw_scraped_leads", "leads"))
  check("leads before contacts (leads.contact_id FK)", before("leads", "contacts"))
  check("assignment_log / ai_isa ledgers before leads",
    before("assignment_log", "leads") && before("ai_isa_qualifications", "leads") && before("lead_deduplication_log", "leads"))
  check("portal artifacts before contacts",
    before("transparency_updates", "contacts") && before("portal_contact_invites", "contacts"))
  check("saved_properties + offers before contacts (round-21 contact FKs)",
    before("saved_properties", "contacts") && before("offers", "contacts"))
  check("the market goes last (everything hangs off the story)", order[order.length - 1] === "lead_scraping_markets")
}

console.log("\n── PURE: the deliberation travels a REAL declared deliberative edge ──")
{
  check("listing_demand_bridge is a deliberative collaboration domain (registry)",
    isDeliberativeDomain("listing_demand_bridge"))
  const valid = validateReferral({
    fromManager: "listing_concierge" as never,
    toManager: "shopping_agent" as never,
    collabDomain: "listing_demand_bridge",
  })
  check("listing_concierge → shopping_agent is a declared edge of the domain", valid.ok === true)
}

console.log("\n── PURE: the presenter runbook ──")
{
  const steps = buildDealRoomRunbook({ leadId: "lead-1", contactId: "contact-1" })
  check("seven ordered steps (enter tenant + six beats)", steps.length === 7 && steps.every((s, i) => s.n === i))
  check("EVERY step carries a one-line presenter note", steps.every((s) => s.note.trim().length > 20))
  check("the flagship line is present verbatim ('" + DEAL_ROOM_FLAGSHIP_NOTE + "')",
    steps.some((s) => s.note.includes(DEAL_ROOM_FLAGSHIP_NOTE)))
  check("beats declare their rail honestly (real / gateway / staged)",
    steps.filter((s) => s.rail === "real").length >= 3 &&
    steps.some((s) => s.rail === "gateway") &&
    steps.filter((s) => s.rail === "staged").length === 2)

  // Deep links resolve to REAL routes on disk (no new render surfaces).
  const routeFile = (href: string): string | null => {
    const map: Array<[RegExp, string]> = [
      [/^\/leads\/[^/]+$/, "app/leads/[leadId]/page.tsx"],
      [/^\/leads$/, "app/leads/page.tsx"],
      [/^\/dashboard\/isa$/, "app/dashboard/isa/page.tsx"],
      [/^\/crm\/contacts\/[^/]+$/, "app/crm/contacts/[contactId]/page.tsx"],
      [/^\/dashboard\/admin\/manager-trust$/, "app/dashboard/admin/manager-trust/page.tsx"],
      [/^\/dashboard\/meetings\/[^/]+$/, "app/dashboard/meetings/[eventId]/page.tsx"],
      [/^\/portal\/[^/]+$/, "app/portal/[contactId]/page.tsx"],
    ]
    for (const [re, file] of map) if (re.test(href)) return file
    return null
  }
  for (const s of steps) {
    if (!s.href) continue
    const file = routeFile(s.href)
    check(`deep link ${s.href} maps to a real route`, !!file && existsSync(join(process.cwd(), file)),
      file ? `missing ${file}` : "unmapped route")
  }
  // Without staged ids the runbook still deep-links the surfaces that exist.
  const bare = buildDealRoomRunbook({ leadId: null, contactId: null })
  check("unseeded runbook falls back to the /leads list (never a dead deep link)",
    bare.find((s) => s.n === 1)?.href === "/leads")
}

console.log("\n── SOURCE: demo-tenant-only refusal + guard before any write ──")
{
  const lib = src(LIB)
  check("hard tenant guard exists and re-checks is_demo against the DB",
    lib.includes("assertDealRoomDemoTenant") && lib.includes('.eq("is_demo", true)'))
  check("the refusal is explicit", lib.includes("REFUSED") && lib.includes("is not the flagged demo tenant"))
  const seedBody = lib.slice(lib.indexOf("export async function seedDealRoomDemo"))
  const guardIdx = seedBody.indexOf("scanDemoTenantForRealActivity")
  const tenantIdx = seedBody.indexOf("assertDealRoomDemoTenant")
  const firstWrite = seedBody.indexOf(".insert(")
  const baselineIdx = seedBody.indexOf("seedDemoData")
  check("seed re-checks the demo flag BEFORE any write", tenantIdx !== -1 && firstWrite !== -1 && tenantIdx < firstWrite)
  check("the demo-day guard runs BEFORE the baseline wipe and BEFORE any insert",
    guardIdx !== -1 && guardIdx < baselineIdx && guardIdx < firstWrite)
  check("seed is idempotent — it tears its own previous story down first",
    seedBody.indexOf("teardownDealRoomStory") !== -1 && seedBody.indexOf("teardownDealRoomStory") < baselineIdx)
  check("provisioning + baseline ride the CANONICAL round-21 module (no forked provisioning)",
    seedBody.includes('import("@/lib/platform/demo-tenant")') && seedBody.includes("ensureDemoTenant"))
  check("teardown re-checks the demo flag too",
    lib.slice(lib.indexOf("export async function teardownDealRoomStory")).includes("assertDealRoomDemoTenant"))
  check("teardown residue-sweeps every predicate and fails on survivors",
    lib.includes("RESIDUE SWEEP") && lib.includes("report.residue.length === 0"))
}

console.log("\n── SOURCE: the deliberation uses the REAL rails (no fork) ──")
{
  const lib = src(LIB)
  check("referral raised via raiseCrossManagerReferral (lib/managers/cross-referral)",
    lib.includes('import("@/lib/managers/cross-referral")') && lib.includes("raiseCrossManagerReferral("))
  check("consumed via the REAL handler path (consumeManagerSignals → handleCrossManagerReferral → runDeliberation)",
    lib.includes('import("@/lib/kernel/manager-signals")') && lib.includes("consumeManagerSignals("))
  check("the record is read back with the production parser (parseDeliberation)",
    lib.includes("parseDeliberation"))
  check("the seeder NEVER hand-writes a deliberation record (no forked engine — it only READS the ledger)",
    !lib.includes("payload.deliberation =") && !lib.includes("DeliberationEngine") &&
    !/from\("manager_signals"\)\s*\.?\s*update/.test(lib) && !/payload:\s*\{[^}]*deliberation/.test(lib) &&
    !/status:\s*"resolved"/.test(lib))
  check("the domain is the registry's listing_demand_bridge",
    lib.includes('collabDomain: "listing_demand_bridge"'))
  check("gateway honesty — key presence is reported and a missing key records the ledger's honest 'unavailable'",
    lib.includes("AI_GATEWAY_API_KEY") && lib.includes("never canned arguments") && /unavailable/i.test(lib))
  check("real-rail rows minted by the pipeline are STAMPED with the marker (post-hoc marking, not forking)",
    lib.includes(`tags: [DEAL_ROOM_TAG]`) && lib.includes("processRawRecord"))
  check("qualification beats run the real kernel handlers",
    lib.includes("handleISAQualificationStarted") && lib.includes("handleConsentReceived") && lib.includes("recordAiIsaOutcome"))
}

console.log("\n── SOURCE: superadmin actions + the presenter surface ──")
{
  const action = src(ACTION)
  check("actions are 'use server' and capability-gated on 'tenants'",
    action.startsWith('"use server"') && action.includes('requirePlatformCapability("tenants")'))
  check("mutations require WRITE access",
    action.includes('requirePlatformCapability("tenants", { requireWrite: true })'))
  check("every mutation writes a superadmin_audit_log row (success AND failure)",
    action.includes("superadmin_audit_log") && action.includes("deal_room_demo.seeded") &&
    action.includes("deal_room_demo.seed_failed") && action.includes("deal_room_demo.teardown"))

  const page = src(PAGE)
  check("the page renders the PURE runbook (no duplicated step list to drift)",
    page.includes("buildDealRoomRunbook") && page.includes("getDealRoomDemoStatus"))
  const client = src(CLIENT)
  check("seed + teardown buttons call the gated actions",
    client.includes("seedDealRoomDemoAction") && client.includes("teardownDealRoomDemoAction"))
  check("the presenter can enter the demo tenant through audited impersonation",
    client.includes("enterTenantAction"))
  check("the surface states the guard posture to the presenter",
    client.includes("never clobbers") || client.includes("marked rows only"))
}

console.log("\n──────────────────────────────────────────────")
console.log(`RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("❌ DEAL_ROOM_DEMO_FAIL")
  process.exit(1)
}
console.log("✅ DEAL_ROOM_DEMO_PASS — staged showcase seeder proven: demo-tenant-only, marked everywhere, idempotent, FK-safe teardown, real-rail deliberation, presenter runbook deep-links real surfaces")
process.exit(0)
