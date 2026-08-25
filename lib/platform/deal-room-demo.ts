// lib/platform/deal-room-demo.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DEAL ROOM DEMO (round 43, rec 1) — the flagship sales artifact: one
// complete deal story staged on the SANCTIONED demo tenant (the round-21
// brokerages.is_demo = true showcase; lib/platform/demo-tenant.ts) so a
// prospect can watch the AI team run a deal end to end THROUGH THE REAL
// PRODUCT SURFACES — no new render surfaces, only deep links.
//
// THE STORY (each beat labeled real-rail vs honest-staged):
//   1. SCRAPED LEAD  (REAL)   territory market + raw record → the PRODUCTION
//                             pipeline (processRawRecord) promotes it — the
//                             lead is born the way every real lead is born
//                             (unconsented, AI-ISA-owned).
//   2. AI-ISA QUALIFICATION   (REAL) the kernel's own qualification stamps
//                             (handleISAQualificationStarted →
//                             handleConsentReceived → recordAiIsaOutcome
//                             'qualified'), which fires the REAL Engine 2 —
//                             conversion + policy assignment + assignment_log.
//   3. MANAGER DELIBERATION   (REAL, gateway-gated) a genuine cross-manager
//                             referral raised on the listing_demand_bridge
//                             domain against the demo tenant's own seeded
//                             listing + staged demand facts; the REAL
//                             handler/runDeliberation argues it. No gateway
//                             key → the ledger records 'unavailable' honestly
//                             (the production module's own posture) — never
//                             canned arguments.
//   4. ZOOM APPOINTMENT       (HONEST-STAGED) a live provider rail (Zoom)
//                             can't run server-side in a seeder — the beat
//                             seeds the calendar event + a synthetic,
//                             clearly-labeled transcript on the voice_calls
//                             ledger and a call_analyses row stamped
//                             analyzed_by='deal_room_demo' (demo provenance).
//   5. CLIENT RECAP           (HONEST-STAGED) the portal's meeting-recap card
//                             (transparency_updates, update_type
//                             'meeting_recap') — the exact row the approval
//                             rail writes, seeded directly and marked.
//
// HARD RULES:
//   • DEMO TENANT ONLY — every mutating entry point re-checks the target is
//     THE brokerage flagged is_demo = true and REFUSES anything else.
//   • EVERY seeded row carries a demo marker: a deterministic dde00000-…-9xxx
//     id (the demo-tenant fixed-uuid idiom, entity blocks ≥ 9001 so they can
//     never collide with the round-21 dataset's blocks 1–7) AND a visible
//     marker (tags / raw_data.demo_marker / metadata.demo_marker /
//     payload.demo_marker / analyzed_by). Rows minted by the REAL rails
//     (the promoted lead, the converted contact) are stamped with the marker
//     immediately after the rail runs.
//   • DEMO-DAY GUARD — the seeder scans the demo tenant for rows that do NOT
//     carry demo markers (someone typed real-looking data into the demo
//     tenant) and refuses to run rather than clobber them.
//   • IDEMPOTENT — a re-seed tears its own previous story down first
//     (marked rows only), re-runs the canonical round-21 baseline seeder
//     (seedDemoData — already deterministic/idempotent), then replays the
//     story. TEARDOWN deletes in FK order and residue-sweeps every predicate.
//
// NOT server-only (simulator-driven — scripts/deal-room-demo-simulator.ts
// imports the pure planners/markers). Every runtime rail is dynamically
// imported inside the functions that use it; the seeding entry points are
// only ever called from the superadmin server action
// (app/actions/superadmin/deal-room-demo.ts), inside a Next request scope —
// which is what the production pipeline's request-scoped client needs.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ─── Markers ─────────────────────────────────────────────────────────────────

/** The visible marker threaded through every seeded row. */
export const DEAL_ROOM_TAG = "deal-room-demo"
/** Provenance label for staged analysis rows (call_analyses.analyzed_by). */
export const DEAL_ROOM_PROVENANCE = "deal_room_demo"
// TOMBSTONE (orphan doctrine §1.3) — these names are no longer exported: DEAL_ROOM_PROSPECT, DEAL_ROOM_TRANSCRIPT_HEADER.
// Nothing in the product imported them, and no simulator did either; the
// values are live and unchanged, reached through this module's own exported
// functions, which is where callers already get their effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
/** The header line every synthetic transcript opens with — provenance in the artifact itself. */
const DEAL_ROOM_TRANSCRIPT_HEADER =
  "[deal-room-demo] SYNTHETIC TRANSCRIPT — staged showcase meeting on the sanctioned demo tenant; no real client, no real call."

/**
 * Deterministic fixed ids — the demo-tenant.ts demoUuid idiom (same
 * dde00000-0000-4000-a000- prefix) but with entity blocks ≥ 9001, a range the
 * round-21 seeder (blocks 1–7) can never occupy. The id itself is a marker.
 */
export function dealRoomUuid(entity: number, n: number): string {
  if (entity < 9001) throw new Error("deal-room ids live in entity blocks ≥ 9001 (round-21 owns 1–7)")
  return `dde00000-0000-4000-a000-${String(entity).padStart(4, "0")}${String(n).padStart(8, "0")}`
}

/** Every directly-inserted story row's fixed id. */
export const DEAL_ROOM_IDS = {
  market: dealRoomUuid(9001, 1),
  raw: dealRoomUuid(9002, 1),
  saves: [dealRoomUuid(9003, 1), dealRoomUuid(9003, 2), dealRoomUuid(9003, 3)],
  offer: dealRoomUuid(9004, 1),
  calendarEvent: dealRoomUuid(9005, 1),
  voiceCall: dealRoomUuid(9006, 1),
  callAnalysis: dealRoomUuid(9007, 1),
  recap: dealRoomUuid(9008, 1),
} as const

/**
 * The round-21 showcase listing the deliberation argues about — demo-tenant.ts
 * demoUuid(3, 1) ("1200 Showcase Blvd", the active listing). Re-derived here
 * as a literal because demo-tenant.ts is server-only and this module must stay
 * simulator-importable; the seeder re-reads the authoritative row at runtime.
 */
export const DEAL_ROOM_STALL_LISTING_ID = "dde00000-0000-4000-a000-000300000001"

/** PURE: is this a deal-room fixed id (entity block ≥ 9001)? */
export function isDealRoomId(id: unknown): boolean {
  return typeof id === "string" && /^dde00000-0000-4000-a000-9\d{3}\d{8}$/.test(id)
}

/** PURE: is this ANY demo-tenant deterministic id (round-21 or deal-room)? */
export function isDemoFixedId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("dde00000-0000-4000-a000-")
}

/**
 * PURE — the marker contract the simulator locks: a seeded row must carry the
 * demo marker somewhere recognizable. Checked locations: the fixed-id idiom,
 * tags arrays, the demo_marker key on raw_data/metadata/payload, marker text
 * in name/notes/title/rationale/transcription, or the provenance label.
 */
export function hasDealRoomMarker(row: Record<string, unknown>): boolean {
  if (isDealRoomId(row.id)) return true
  const tags = row.tags
  if (Array.isArray(tags) && tags.some((t) => t === DEAL_ROOM_TAG)) return true
  for (const key of ["raw_data", "metadata", "payload"]) {
    const obj = row[key]
    if (obj && typeof obj === "object" && (obj as Record<string, unknown>).demo_marker === DEAL_ROOM_TAG) return true
  }
  for (const key of ["name", "notes", "title", "rationale", "transcription", "transcript", "summary"]) {
    const v = row[key]
    if (typeof v === "string" && (v.includes(DEAL_ROOM_TAG) || v.includes(DEAL_ROOM_PROVENANCE))) return true
  }
  if (row.analyzed_by === DEAL_ROOM_PROVENANCE) return true
  if (row.source === DEAL_ROOM_PROVENANCE) return true
  return false
}

// ─── The pure story plan (every directly-inserted row) ───────────────────────

const DAY = 24 * 60 * 60 * 1000

export interface DealRoomStoryPlanInput {
  brokerageId: string
  /** The demo owner's agents.id (CRM rows hang off it) — null tolerated. */
  agentId: string | null
  /** The demo owner's users.id (calendar_events.agent_user_id). */
  ownerUserId: string | null
  /** The round-21 listing the deliberation argues (id + address, read from the DB). */
  stallListing: { id: string; address: string }
  /** Round-21 buyer contact ids whose saves stage the demand evidence. */
  buyerContactIds: string[]
  now?: Date
}

export interface DealRoomStoryPlan {
  market: Record<string, unknown>
  raw: Record<string, unknown>
  saves: Array<Record<string, unknown>>
  offer: Record<string, unknown>
  referralAsk: string
  referralPayload: Record<string, unknown>
  calendarEvent: Record<string, unknown>
  voiceCall: Record<string, unknown>
  /** call_analyses row minus contact/agent linkage (filled at runtime). */
  callAnalysis: Record<string, unknown>
  /** transparency_updates recap card minus contact linkage (filled at runtime). */
  recapCard: Record<string, unknown>
}

/** The scraped prospect — fictional idiom matching the round-21 dataset
 *  (RFC-2606 reserved domain, 555 phone, obviously-fictional surname). */
const DEAL_ROOM_PROSPECT = {
  firstName: "Jordan",
  lastName: "Demoprospect",
  email: "jordan.demoprospect@demo-showcase.example.com",
  city: "Austin",
  state: "TX",
  zip: "78704",
} as const

/** PURE: the full staged-story plan. Every row satisfies hasDealRoomMarker. */
export function buildDealRoomStoryPlan(input: DealRoomStoryPlanInput): DealRoomStoryPlan {
  const now = input.now ?? new Date()
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()
  const base = { brokerage_id: input.brokerageId }
  const p = DEAL_ROOM_PROSPECT

  const market = {
    ...base,
    id: DEAL_ROOM_IDS.market,
    name: `[${DEAL_ROOM_TAG}] South Austin showcase territory`,
    city: p.city,
    state: p.state,
    zip_codes: [p.zip],
    is_active: true,
  }

  const raw = {
    ...base,
    id: DEAL_ROOM_IDS.raw,
    market_id: DEAL_ROOM_IDS.market,
    source: DEAL_ROOM_PROVENANCE,
    source_origin: "brokerage",
    processing_status: "pending",
    first_name: p.firstName,
    last_name: p.lastName,
    email: p.email,
    city: p.city,
    state: p.state,
    zip_code: p.zip,
    raw_data: {
      demo_marker: DEAL_ROOM_TAG,
      seeded_by: "deal-room-demo",
      lead_type: "buyer",
      note: "staged showcase prospect — promoted through the REAL pipeline",
    },
  }

  // Demand evidence for the deliberation's Shopping-Agent seat — buyer saves
  // (interest high) + one live offer under ask on the stalling listing.
  const saves = input.buyerContactIds.slice(0, 3).map((contactId, i) => ({
    ...base,
    id: DEAL_ROOM_IDS.saves[i],
    contact_id: contactId,
    listing_id: input.stallListing.id,
    interest_level: i === 0 ? "high" : "medium",
    dismissed: false,
    source: DEAL_ROOM_PROVENANCE,
    property_address: input.stallListing.address,
    created_at: iso((3 + i) * DAY),
  }))

  const offer = {
    ...base,
    id: DEAL_ROOM_IDS.offer,
    listing_id: input.stallListing.id,
    contact_id: input.buyerContactIds[0] ?? null,
    offer_price: 552000, // under the $585K ask — the demand side's exhibit A
    status: "submitted",
    submitted_at: iso(2 * DAY),
  }

  const referralAsk =
    `${input.stallListing.address} is heading for a stall (21 days on market, 11 showings, best live offer $552,000 against a ` +
    `$585,000 ask) and the predictor recommends a price conversation. Argue the price move: the seller side's list-price case ` +
    `vs the demand evidence (saves, alerts, live offers). [${DEAL_ROOM_TAG} staged referral — the argument itself is real]`
  const referralPayload = {
    demo_marker: DEAL_ROOM_TAG,
    property_address: input.stallListing.address,
  }

  const calendarEvent = {
    ...base,
    id: DEAL_ROOM_IDS.calendarEvent,
    agent_user_id: input.ownerUserId,
    entity_type: "contact",
    entity_id: null as string | null, // stamped with the converted contact at seed time
    event_type: "buyer_consultation",
    title: `Buyer consultation — ${p.firstName} ${p.lastName} (Zoom)`,
    start_at: iso(1 * DAY),
    end_at: iso(1 * DAY - 30 * 60 * 1000),
    location: "Zoom",
    status: "completed",
    is_system_generated: true,
    metadata: {
      demo_marker: DEAL_ROOM_TAG,
      zoom: {
        // RFC-2606 reserved domain — clearly fictional, never a live meeting.
        meeting_id: "demo-showcase-000-0001",
        join_url: "https://zoom.demo-showcase.example.com/j/demo-showcase-000-0001",
        host_owner_type: "tenant",
        transcript_attached: true,
        transcript_attached_to: "contact",
      },
    },
  }

  const transcript = [
    DEAL_ROOM_TRANSCRIPT_HEADER,
    `Agent: Hi ${p.firstName}, thanks for hopping on. I saw you're pre-approved and looking in South Austin under $550K — tell me what matters most.`,
    `Caller: We need three bedrooms and a home office, and we'd like to be moved in within about sixty days. Pre-approval is with Lone Star Lending.`,
    `Agent: Sixty days is very doable. Are weekends best for touring?`,
    `Caller: Saturdays, yes. And we're curious about that Showcase Blvd house — is there room on price?`,
    `Agent: It's been on the market three weeks with a lot of showings, so it's worth a conversation. I'll line up a Saturday tour and send the disclosure packet tonight.`,
    `Caller: Perfect. Send over anything else near Mueller too.`,
    `Agent: Done — you'll have the tour plan and a curated search by tomorrow morning.`,
  ].join("\n")

  const voiceCall = {
    ...base,
    id: DEAL_ROOM_IDS.voiceCall,
    contact_id: null as string | null, // stamped at seed time
    agent_id: input.agentId,
    direction: "outbound",
    call_type: "zoom_meeting",
    status: "completed",
    started_at: iso(1 * DAY),
    duration_seconds: 26 * 60,
    transcription: transcript,
    vendor_call_id: `zoom:${DEAL_ROOM_TAG}-showcase-meeting`,
  }

  const callAnalysis = {
    ...base,
    id: DEAL_ROOM_IDS.callAnalysis,
    voice_call_id: DEAL_ROOM_IDS.voiceCall,
    contact_id: null as string | null, // stamped at seed time
    agent_id: input.agentId,
    call_type: "outbound",
    call_duration: 26 * 60,
    transcript,
    summary:
      `[${DEAL_ROOM_TAG}] Buyer consultation on Zoom: pre-approved buyer, 60-day timeline, needs 3BR + home office in South ` +
      `Austin under $550K; asked about price room on the Showcase Blvd listing; Saturday tour + curated search agreed.`,
    sentiment: "positive",
    objections: ["price room on Showcase Blvd"],
    urgency_score: 82,
    coaching_score: 90,
    intent_primary: "book Saturday tour",
    key_topics: ["pre-approval", "60-day timeline", "home office", "Showcase Blvd", "Saturday tour"],
    analyzed_at: iso(1 * DAY - 40 * 60 * 1000),
    analyzed_by: DEAL_ROOM_PROVENANCE,
  }

  const recapCard = {
    ...base,
    id: DEAL_ROOM_IDS.recap,
    contact_id: null as string | null, // stamped at seed time
    title: `Meeting recap — your consultation on ${new Date(now.getTime() - DAY).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`,
    plain_language_summary:
      `Great meeting you on Zoom! What we discussed: you're pre-approved with Lone Star Lending, aiming to move within ` +
      `60 days, and you need three bedrooms plus a home office in South Austin under $550K. What happens next: I'm setting ` +
      `up a Saturday tour (including the Showcase Blvd home you asked about) and sending your curated search and the ` +
      `disclosure packet tonight. Questions before then? Just reply here.`,
    message:
      `What we discussed: pre-approval in hand, 60-day timeline, 3BR + home office under $550K in South Austin. ` +
      `What happens next: Saturday tour + curated search and disclosures tonight.`,
    update_type: "meeting_recap",
    is_visible_to_client: true,
    metadata: {
      demo_marker: DEAL_ROOM_TAG,
      audience: "buyer",
      channel: "portal",
      human_approved: true,
      staged_by: DEAL_ROOM_PROVENANCE,
      meeting_voice_call_id: DEAL_ROOM_IDS.voiceCall,
    },
  }

  return { market, raw, saves, offer, referralAsk, referralPayload, calendarEvent, voiceCall, callAnalysis, recapCard }
}

// ─── The demo-day guard (never clobbers) ─────────────────────────────────────

/** The round-21 visible marker (demo-tenant.ts DEMO_TAG) — recognized so the
 *  canonical showcase dataset never trips the guard. */
export const ROUND21_DEMO_TAG = "demo-showcase"

/** Tables the seeder writes (directly or through the rails) that the guard
 *  scans for real-looking rows before ANYTHING is wiped or written. */
export const DEAL_ROOM_GUARD_TABLES = [
  "contacts",
  "leads",
  "listings",
  "transactions",
  "conversations",
  "messages",
  "activities",
  "raw_scraped_leads",
  "lead_scraping_markets",
  "saved_properties",
  "offers",
  "calendar_events",
  "voice_calls",
  "transparency_updates",
] as const

/**
 * PURE: is this row recognizably DEMO data — the round-21 fixed-id/tag idiom,
 * the deal-room marker, or a row derived from a marked story entity
 * (keyed by a known lead/contact id)?
 */
export function isRecognizedDemoRow(
  row: Record<string, unknown>,
  derivedIds: Set<string>,
): boolean {
  if (isDemoFixedId(row.id)) return true
  if (hasDealRoomMarker(row)) return true
  const tags = row.tags
  if (Array.isArray(tags) && tags.some((t) => t === ROUND21_DEMO_TAG)) return true
  for (const key of ["notes", "title", "name", "public_remarks", "body"]) {
    const v = row[key]
    if (typeof v === "string" && v.includes(ROUND21_DEMO_TAG)) return true
  }
  for (const key of ["id", "contact_id", "lead_id", "entity_id", "voice_call_id", "conversation_id", "listing_id"]) {
    const v = row[key]
    if (typeof v === "string" && (derivedIds.has(v) || isDemoFixedId(v))) return true
  }
  return false
}

export interface GuardSuspect {
  table: string
  count: number
  sampleIds: string[]
}

export interface DemoDayGuardResult {
  clean: boolean
  suspects: GuardSuspect[]
}

/** Resolve rows the REAL rails minted for the story (random ids, marked by tag). */
async function resolveDerivedStoryIds(svc: Svc, brokerageId: string): Promise<{
  leadIds: string[]
  contactIds: string[]
  all: Set<string>
}> {
  const leadIds = new Set<string>()
  const contactIds = new Set<string>()
  const { data: taggedLeads } = await svc
    .from("leads").select("id, contact_id").eq("brokerage_id", brokerageId).contains("tags", [DEAL_ROOM_TAG]).limit(50)
  for (const l of (taggedLeads ?? []) as Array<{ id: string; contact_id: string | null }>) {
    leadIds.add(l.id)
    if (l.contact_id) contactIds.add(l.contact_id)
  }
  // Belt: a half-finished previous run may have promoted before stamping — the
  // raw row's lead pointer still finds it.
  const { data: rawRow } = await svc
    .from("raw_scraped_leads").select("lead_id").eq("id", DEAL_ROOM_IDS.raw).eq("brokerage_id", brokerageId).maybeSingle()
  const rawLead = (rawRow as { lead_id: string | null } | null)?.lead_id
  if (rawLead) {
    leadIds.add(rawLead)
    const { data: l } = await svc.from("leads").select("contact_id").eq("id", rawLead).maybeSingle()
    const cid = (l as { contact_id: string | null } | null)?.contact_id
    if (cid) contactIds.add(cid)
  }
  const { data: taggedContacts } = await svc
    .from("contacts").select("id").eq("brokerage_id", brokerageId).contains("tags", [DEAL_ROOM_TAG]).limit(50)
  for (const c of (taggedContacts ?? []) as Array<{ id: string }>) contactIds.add(c.id)
  const all = new Set<string>([...leadIds, ...contactIds, ...(Object.values(DEAL_ROOM_IDS).flat() as string[])])
  return { leadIds: Array.from(leadIds), contactIds: Array.from(contactIds), all }
}

/**
 * THE DEMO-DAY GUARD: scan the demo tenant's guarded tables for rows that are
 * NOT recognizably demo data. Any hit → the seeder refuses (never clobbers a
 * row someone typed into the demo tenant by hand).
 */
export async function scanDemoTenantForRealActivity(
  svc: Svc, brokerageId: string,
): Promise<DemoDayGuardResult> {
  const derived = await resolveDerivedStoryIds(svc, brokerageId)
  const suspects: GuardSuspect[] = []
  for (const table of DEAL_ROOM_GUARD_TABLES) {
    try {
      const { data, error } = await svc.from(table).select("*").eq("brokerage_id", brokerageId).limit(300)
      if (error) continue // a table this schema lacks can hold nothing to clobber
      const rows = (data ?? []) as Array<Record<string, unknown>>
      const bad = rows.filter((r) => !isRecognizedDemoRow(r, derived.all))
      if (bad.length > 0) {
        suspects.push({ table, count: bad.length, sampleIds: bad.slice(0, 3).map((r) => String(r.id ?? "?")) })
      }
    } catch {
      // unreadable table → nothing provable to protect; the per-row write
      // guards (fixed ids + brokerage scoping) still hold.
    }
  }
  return { clean: suspects.length === 0, suspects }
}

// ─── The hard tenant guard ───────────────────────────────────────────────────

/**
 * HARD REFUSAL: the target must be THE brokerage flagged is_demo = true —
 * re-checked against the DB on every mutating entry, never trusted.
 */
export async function assertDealRoomDemoTenant(
  svc: Svc, brokerageId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "No brokerage id" }
  const { data } = await svc
    .from("brokerages").select("id")
    .eq("is_demo", true).is("deleted_at", null)
    .order("created_at", { ascending: true }).limit(1).maybeSingle()
  const demoId = (data as { id: string } | null)?.id ?? null
  if (!demoId) return { ok: false, error: "REFUSED: no demo tenant exists (no brokerage is flagged is_demo = true)" }
  if (demoId !== brokerageId) {
    return { ok: false, error: `REFUSED: brokerage ${brokerageId} is not the flagged demo tenant — the Deal Room demo only ever touches the sanctioned is_demo brokerage` }
  }
  return { ok: true }
}

// ─── Teardown (FK order, marked rows only, residue-swept) ────────────────────

/**
 * The declarative deletion order — children before parents. The simulator
 * locks the FK-critical orderings (call_analyses < voice_calls, messages <
 * conversations, raw_scraped_leads < leads, leads < contacts).
 */
export const DEAL_ROOM_TEARDOWN_ORDER = [
  "call_analyses",
  "voice_calls",
  "calendar_events",
  "transparency_updates",
  "client_portal_messages",
  "portal_contact_invites",
  "sequence_enrollments",
  "saved_properties",
  "offers",
  "messages",
  "conversations",
  "activities",
  "notifications",
  "lifecycle_events",
  "manager_signals",
  "ai_isa_qualifications",
  "ai_isa_activities",
  "ai_isa_calls",
  "agent_handoffs",
  "assignment_log",
  "lead_sla_tracking",
  "lead_deduplication_log",
  "lead_enrichment_queue",
  "raw_scraped_leads",
  "leads",
  "contacts",
  "lead_scraping_markets",
] as const

export interface TeardownReport {
  ok: boolean
  error?: string
  deleted: Record<string, number>
  residue: Array<{ table: string; predicate: string; count: number }>
  errors: string[]
}

/** Tolerant scoped delete — a table/column this schema lacks deletes nothing. */
async function del(
  svc: Svc, report: TeardownReport, table: string,
  apply: (q: any) => any, predicate: string,
): Promise<void> {
  try {
    const { error, count } = await apply(svc.from(table).delete({ count: "exact" }))
    if (error) {
      // Missing table/column reads as "nothing to delete"; a real FK failure
      // surfaces in the residue sweep below.
      if (!/does not exist|relation|column/i.test(error.message)) report.errors.push(`${table} (${predicate}): ${error.message}`)
      return
    }
    report.deleted[`${table} ${predicate}`] = (report.deleted[`${table} ${predicate}`] ?? 0) + (count ?? 0)
  } catch (e) {
    report.errors.push(`${table} (${predicate}): ${e instanceof Error ? e.message : "delete failed"}`)
  }
}

async function sweep(
  svc: Svc, report: TeardownReport, table: string,
  apply: (q: any) => any, predicate: string,
): Promise<void> {
  try {
    const { count, error } = await apply(svc.from(table).select("*", { count: "exact", head: true }))
    if (!error && (count ?? 0) > 0) report.residue.push({ table, predicate, count: count ?? 0 })
  } catch { /* nonexistent table = no residue */ }
}

/**
 * Remove the deal-room STORY — and ONLY it: fixed-id rows, marker-tagged rows,
 * and rows keyed to the story's own lead/contact ids. The round-21 canonical
 * dataset (and anything else) is never touched.
 */
export async function teardownDealRoomStory(svc: Svc, brokerageId: string): Promise<TeardownReport> {
  const report: TeardownReport = { ok: false, deleted: {}, residue: [], errors: [] }
  const guard = await assertDealRoomDemoTenant(svc, brokerageId)
  if (!guard.ok) return { ...report, error: guard.error }

  // Resolve the rail-minted ids BEFORE anything is deleted.
  const derived = await resolveDerivedStoryIds(svc, brokerageId)
  const leadIds = derived.leadIds
  const contactIds = derived.contactIds
  const entityIds = [...leadIds, ...contactIds, DEAL_ROOM_IDS.raw, DEAL_ROOM_IDS.voiceCall, DEAL_ROOM_IDS.calendarEvent]
  const B = (q: any) => q.eq("brokerage_id", brokerageId)

  // The per-table delete plan: [table, apply, predicate, sweepable]. Ordered
  // per DEAL_ROOM_TEARDOWN_ORDER (children first).
  type Step = { table: string; apply: (q: any) => any; predicate: string }
  const steps: Step[] = []
  const add = (table: string, apply: (q: any) => any, predicate: string) => steps.push({ table, apply, predicate })

  add("call_analyses", (q) => B(q).eq("voice_call_id", DEAL_ROOM_IDS.voiceCall), "voice_call_id=story")
  add("call_analyses", (q) => B(q).eq("analyzed_by", DEAL_ROOM_PROVENANCE), "analyzed_by=deal_room_demo")
  add("voice_calls", (q) => B(q).eq("id", DEAL_ROOM_IDS.voiceCall), "id=story")
  add("calendar_events", (q) => B(q).eq("id", DEAL_ROOM_IDS.calendarEvent), "id=story")
  add("transparency_updates", (q) => B(q).eq("id", DEAL_ROOM_IDS.recap), "id=story")
  if (contactIds.length > 0) {
    for (const t of ["transparency_updates", "client_portal_messages", "portal_contact_invites", "sequence_enrollments"])
      add(t, (q) => B(q).in("contact_id", contactIds), "contact_id∈story")
  }
  add("saved_properties", (q) => B(q).in("id", [...DEAL_ROOM_IDS.saves]), "id∈story")
  add("offers", (q) => B(q).eq("id", DEAL_ROOM_IDS.offer), "id=story")
  if (contactIds.length > 0) {
    add("messages", (q) => B(q).in("contact_id", contactIds), "contact_id∈story")
    add("conversations", (q) => B(q).in("contact_id", contactIds), "contact_id∈story")
    add("activities", (q) => B(q).in("contact_id", contactIds), "contact_id∈story")
  }
  if (entityIds.length > 0) {
    add("notifications", (q) => B(q).in("entity_id", entityIds), "entity_id∈story")
    add("lifecycle_events", (q) => B(q).in("entity_id", entityIds), "entity_id∈story")
  }
  // The referral notification/lifecycle rows key on the ROUND-21 listing — only
  // the referral-typed ones are ours to remove.
  add("notifications", (q) => B(q).eq("type", "cross_manager_referral").eq("entity_id", DEAL_ROOM_STALL_LISTING_ID), "referral on stall listing")
  add("manager_signals", (q) => B(q).contains("payload", { demo_marker: DEAL_ROOM_TAG }), "payload.demo_marker")
  if (leadIds.length > 0) {
    for (const t of ["ai_isa_qualifications", "ai_isa_activities", "ai_isa_calls", "agent_handoffs", "assignment_log", "lead_sla_tracking", "lead_deduplication_log", "lead_enrichment_queue"])
      add(t, (q) => B(q).in("lead_id", leadIds), "lead_id∈story")
  }
  add("lead_deduplication_log", (q) => B(q).eq("raw_record_id", DEAL_ROOM_IDS.raw), "raw_record_id=story")
  if (contactIds.length > 0) add("lead_enrichment_queue", (q) => B(q).in("contact_id", contactIds), "contact_id∈story")
  add("raw_scraped_leads", (q) => B(q).eq("id", DEAL_ROOM_IDS.raw), "id=story")
  if (leadIds.length > 0) add("leads", (q) => B(q).in("id", leadIds), "id∈story")
  if (contactIds.length > 0) add("contacts", (q) => B(q).in("id", contactIds), "id∈story")
  add("lead_scraping_markets", (q) => B(q).eq("id", DEAL_ROOM_IDS.market), "id=story")

  for (const s of steps) await del(svc, report, s.table, s.apply, s.predicate)

  // Revert the staged stall facts on the round-21 listing (the row itself stays).
  try {
    await svc.from("listings")
      .update({ showing_count: null })
      .eq("id", DEAL_ROOM_STALL_LISTING_ID).eq("brokerage_id", brokerageId)
  } catch { /* column may not exist — nothing staged then */ }

  // ── RESIDUE SWEEP — every predicate re-counted; any survivor fails the teardown ──
  for (const s of steps) await sweep(svc, report, s.table, s.apply, s.predicate)

  report.ok = report.residue.length === 0 && report.errors.length === 0
  if (!report.ok && !report.error) {
    report.error = report.residue.length > 0
      ? `teardown left residue: ${report.residue.map((r) => `${r.table}(${r.predicate})=${r.count}`).join(", ")}`
      : report.errors[0]
  }
  return report
}

/** The public teardown — resolves the flagged demo tenant itself (never takes an id from the caller). */
export async function teardownDealRoomDemo(): Promise<TeardownReport> {
  const svc = createServiceClient()
  const { data } = await svc.from("brokerages").select("id").eq("is_demo", true).is("deleted_at", null)
    .order("created_at", { ascending: true }).limit(1).maybeSingle()
  const demoId = (data as { id: string } | null)?.id ?? null
  if (!demoId) {
    return { ok: false, error: "REFUSED: no demo tenant exists (nothing to tear down)", deleted: {}, residue: [], errors: [] }
  }
  return teardownDealRoomStory(svc, demoId)
}

// ─── The seeder ──────────────────────────────────────────────────────────────

export interface DealRoomSeedStep {
  beat: string
  rail: "real" | "staged" | "unavailable"
  ok: boolean
  detail: string
}

export interface DealRoomSeedReport {
  ok: boolean
  error?: string
  brokerageId?: string
  steps: DealRoomSeedStep[]
  ids?: {
    leadId: string | null
    contactId: string | null
    listingId: string
    signalId: string | null
    eventId: string
    voiceCallId: string
    recapId: string
  }
  deliberation?: { status: string; winner: string | null; positions: number; rebuttalHeld: boolean } | null
  gatewayConfigured?: boolean
  guardSuspects?: GuardSuspect[]
}

/**
 * Seed the complete Deal Room story on the sanctioned demo tenant. Superadmin
 * server-action only (needs a Next request scope for the production pipeline).
 * Idempotent: tears its own previous story down, re-runs the canonical
 * round-21 baseline (seedDemoData), then replays the story through the rails.
 */
export async function seedDealRoomDemo(): Promise<DealRoomSeedReport> {
  const svc = createServiceClient()
  const steps: DealRoomSeedStep[] = []
  const gatewayConfigured = !!process.env.AI_GATEWAY_API_KEY

  // 1 · The sanctioned tenant — canonical provisioning, then the HARD re-check.
  const demoTenantMod = await import("@/lib/platform/demo-tenant")
  const ensured = await demoTenantMod.ensureDemoTenant()
  if (!ensured.ok || !ensured.brokerage) {
    return { ok: false, error: ensured.error ?? "demo tenant unavailable", steps, gatewayConfigured }
  }
  const brokerageId = ensured.brokerage.id
  const tenantGuard = await assertDealRoomDemoTenant(svc, brokerageId)
  if (!tenantGuard.ok) return { ok: false, error: tenantGuard.error, steps, gatewayConfigured }

  // 2 · DEMO-DAY GUARD — refuse before anything is wiped or written.
  const scan = await scanDemoTenantForRealActivity(svc, brokerageId)
  if (!scan.clean) {
    return {
      ok: false,
      error:
        `REFUSED: the demo tenant holds ${scan.suspects.reduce((s, x) => s + x.count, 0)} row(s) that carry no demo marker ` +
        `(${scan.suspects.map((s) => `${s.table}:${s.count}`).join(", ")}) — the seeder never clobbers real-looking data. ` +
        `Move or delete those rows first.`,
      steps, guardSuspects: scan.suspects, gatewayConfigured,
    }
  }

  // 3 · Idempotency — remove any previous story (marked rows only).
  const td = await teardownDealRoomStory(svc, brokerageId)
  if (!td.ok) return { ok: false, error: `previous-story teardown failed: ${td.error}`, steps, gatewayConfigured }

  // 4 · The canonical round-21 baseline (deterministic wipe + re-seed — its own
  //     hard guard re-checks is_demo internally).
  const baseline = await demoTenantMod.seedDemoData(brokerageId)
  if (!baseline.ok) return { ok: false, error: `baseline seed failed: ${baseline.error}`, steps, gatewayConfigured }
  steps.push({ beat: "stage · canonical showcase baseline (round-21 seeder, deterministic)", rail: "real", ok: true, detail: "wiped + re-seeded through lib/platform/demo-tenant.ts" })

  // 5 · Identities + the round-21 fixture rows the story leans on.
  const [{ data: agentRow }, { data: ownerRow }] = await Promise.all([
    svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    svc.from("users").select("id").eq("brokerage_id", brokerageId).eq("user_type", "admin").order("created_at", { ascending: true }).limit(1).maybeSingle(),
  ])
  const agentId = (agentRow as { id: string } | null)?.id ?? null
  const ownerUserId = (ownerRow as { id: string } | null)?.id ?? (agentRow as { user_id?: string } | null)?.user_id ?? null

  const { data: listingRow } = await svc.from("listings")
    .select("id, address").eq("id", DEAL_ROOM_STALL_LISTING_ID).eq("brokerage_id", brokerageId).maybeSingle()
  if (!listingRow) return { ok: false, error: "baseline listing (1200 Showcase Blvd) missing after seed", steps, gatewayConfigured }
  const stallListing = { id: (listingRow as any).id as string, address: ((listingRow as any).address as string) ?? "1200 Showcase Blvd" }

  const { data: buyerRows } = await svc.from("contacts")
    .select("id").eq("brokerage_id", brokerageId).eq("contact_type", "buyer").contains("tags", [ROUND21_DEMO_TAG])
    .order("created_at", { ascending: true }).limit(3)
  const buyerContactIds = ((buyerRows ?? []) as Array<{ id: string }>).map((r) => r.id)

  const plan = buildDealRoomStoryPlan({ brokerageId, agentId, ownerUserId, stallListing, buyerContactIds })
  const ids: NonNullable<DealRoomSeedReport["ids"]> = {
    leadId: null, contactId: null, listingId: stallListing.id, signalId: null,
    eventId: DEAL_ROOM_IDS.calendarEvent, voiceCallId: DEAL_ROOM_IDS.voiceCall, recapId: DEAL_ROOM_IDS.recap,
  }
  let deliberation: DealRoomSeedReport["deliberation"] = null

  try {
    // ── BEAT 1 · SCRAPED LEAD → REAL PIPELINE PROMOTION ─────────────────────
    {
      const { error: mErr } = await svc.from("lead_scraping_markets").insert(plan.market as never)
      if (mErr) throw new Error(`territory insert failed: ${mErr.message}`)
      const { error: rErr } = await svc.from("raw_scraped_leads").insert(plan.raw as never)
      if (rErr) throw new Error(`raw record insert failed: ${rErr.message}`)

      const { processRawRecord } = await import("@/lib/lead-pipeline")
      const promo = await processRawRecord(DEAL_ROOM_IDS.raw, brokerageId)
      if (!promo.success || promo.action !== "created" || !promo.leadId) {
        throw new Error(`REAL pipeline did not promote: ${JSON.stringify(promo)}`)
      }
      ids.leadId = promo.leadId
      // Stamp the rail-minted row with the demo marker (marking, not forking).
      await svc.from("leads").update({ tags: [DEAL_ROOM_TAG], notes: `[${DEAL_ROOM_TAG}] staged showcase prospect — promoted through the REAL production pipeline (processRawRecord).` }).eq("id", promo.leadId).eq("brokerage_id", brokerageId)
      const { data: born } = await svc.from("leads").select("lifecycle_state, ai_isa_owner").eq("id", promo.leadId).single()
      steps.push({
        beat: "1 · scraped lead → territory match → promotion", rail: "real", ok: true,
        detail: `raw ${DEAL_ROOM_IDS.raw.slice(0, 8)}… promoted to lead ${promo.leadId.slice(0, 8)}… (born ${(born as any)?.lifecycle_state}, AI-ISA owner ${(born as any)?.ai_isa_owner})`,
      })
    }

    // ── BEAT 2 · AI-ISA QUALIFICATION → REAL ENGINE 2 CONVERSION ────────────
    {
      const { handleISAQualificationStarted, handleConsentReceived } = await import("@/lib/kernel/lead-acquisition-handlers")
      await handleISAQualificationStarted({ leadId: ids.leadId!, brokerageId })
      await handleConsentReceived({ leadId: ids.leadId!, brokerageId, consentSource: "form" })
      const { recordAiIsaOutcome } = await import("@/lib/kernel/ai-isa")
      const rec = await recordAiIsaOutcome({
        ctx: { brokerageId, userId: ownerUserId } as never,
        leadId: ids.leadId!,
        outcome: "qualified" as never,
        notes: `[${DEAL_ROOM_TAG}] staged showcase qualification — stamps + Engine 2 are the real kernel`,
      } as never)
      if (!(rec as { success?: boolean }).success) throw new Error(`recordAiIsaOutcome failed: ${(rec as any).error}`)
      const { data: lead } = await svc.from("leads")
        .select("lead_stage, lifecycle_state, contact_id").eq("id", ids.leadId!).single()
      const l = lead as { lead_stage?: string; lifecycle_state?: string; contact_id?: string | null } | null
      if (l?.lead_stage !== "qualified" || !l?.contact_id) {
        throw new Error(`Engine 2 did not convert (stage=${l?.lead_stage}, contact=${l?.contact_id ?? "none"})`)
      }
      ids.contactId = l.contact_id
      await svc.from("contacts").update({ tags: [DEAL_ROOM_TAG, "buyer"] }).eq("id", l.contact_id).eq("brokerage_id", brokerageId)
      const { count: logCount } = await svc.from("assignment_log").select("id", { count: "exact", head: true }).eq("lead_id", ids.leadId!)
      steps.push({
        beat: "2 · AI-ISA qualification → conversion + policy assignment", rail: "real", ok: true,
        detail: `lifecycle ${l.lifecycle_state}; contact ${l.contact_id.slice(0, 8)}… created by the REAL Engine 2; assignment_log rows: ${logCount ?? 0}`,
      })
    }

    // ── BEAT 3 · THE DELIBERATION (real referral; gateway-gated argument) ───
    {
      // Stage the demand evidence the Shopping-Agent seat argues from, plus the
      // seller side's stall facts on the round-21 listing.
      if (plan.saves.length > 0) {
        const { error } = await svc.from("saved_properties").insert(plan.saves as never)
        if (error) steps.push({ beat: "3a · demand evidence (buyer saves)", rail: "staged", ok: false, detail: error.message })
        else steps.push({ beat: "3a · demand evidence (buyer saves on the stalling listing)", rail: "staged", ok: true, detail: `${plan.saves.length} marked saves` })
      }
      const { error: offErr } = await svc.from("offers").insert(plan.offer as never)
      steps.push({
        beat: "3b · demand evidence (live under-ask offer)", rail: "staged", ok: !offErr,
        detail: offErr ? offErr.message : `offer $552,000 vs $585,000 ask (marked)`,
      })
      await svc.from("listings").update({ showing_count: 11 }).eq("id", stallListing.id).eq("brokerage_id", brokerageId)

      const { raiseCrossManagerReferral } = await import("@/lib/managers/cross-referral")
      const raised = await raiseCrossManagerReferral({
        brokerageId,
        fromManager: "listing_concierge",
        toManager: "shopping_agent",
        collabDomain: "listing_demand_bridge",
        ask: plan.referralAsk,
        entityType: "listing",
        entityId: stallListing.id,
        payload: plan.referralPayload,
      }, svc)
      if (!raised.ok || !raised.signalId) throw new Error(`referral refused: ${raised.reason ?? "unknown"}`)
      ids.signalId = raised.signalId

      // Consume through the REAL handler — handleCrossManagerReferral escalates
      // the deliberative domain to runDeliberation (grounded briefs → argued
      // positions → rebuttal round → resolution), persisted on the referral row.
      const { consumeManagerSignals } = await import("@/lib/kernel/manager-signals")
      await consumeManagerSignals({ brokerageId, toManager: "shopping_agent", limit: 10 }, svc)

      const { parseDeliberation } = await import("@/lib/managers/deliberation")
      const { data: sig } = await svc.from("manager_signals").select("payload, status, consumed_action").eq("id", raised.signalId).maybeSingle()
      const record = parseDeliberation((sig as { payload?: Record<string, unknown> } | null)?.payload ?? null)
      if (record) {
        deliberation = { status: record.status, winner: record.winner, positions: record.positions.length, rebuttalHeld: record.rebuttalHeld === true }
      }
      if (record?.status === "resolved") {
        steps.push({
          beat: "3 · manager deliberation on listing_demand_bridge", rail: "real", ok: true,
          detail: `REAL runDeliberation argued it: ${record.positions.length} grounded positions${record.rebuttalHeld ? " + one rebuttal round" : ""}; winner ${record.winner}`,
        })
      } else {
        steps.push({
          beat: "3 · manager deliberation on listing_demand_bridge", rail: "unavailable", ok: true,
          detail: gatewayConfigured
            ? `deliberation recorded '${record?.status ?? "none"}' — ${record ? "the gateway could not resolve an argument; the honest 'unavailable' record is on the referral ledger" : "the referral is on the ledger awaiting consumption"}`
            : "no AI_GATEWAY_API_KEY — the REAL rail recorded 'deliberation unavailable' on the referral ledger (honest posture, never canned arguments)",
        })
      }
    }

    // ── BEAT 4 · THE ZOOM APPOINTMENT (honest-staged, labeled) ──────────────
    {
      const event = { ...plan.calendarEvent, entity_id: ids.contactId }
      const { error: eErr } = await svc.from("calendar_events").insert(event as never)
      if (eErr) throw new Error(`calendar event insert failed: ${eErr.message}`)
      const call = { ...plan.voiceCall, contact_id: ids.contactId }
      const { error: vErr } = await svc.from("voice_calls").insert(call as never)
      if (vErr) throw new Error(`voice_calls insert failed: ${vErr.message}`)
      const analysis = { ...plan.callAnalysis, contact_id: ids.contactId }
      const { error: aErr } = await svc.from("call_analyses").insert(analysis as never)
      if (aErr) throw new Error(`call_analyses insert failed: ${aErr.message}`)
      steps.push({
        beat: "4 · Zoom appointment + transcript intelligence", rail: "staged", ok: true,
        detail: `calendar event + synthetic labeled transcript on the voice ledger + call_analyses (analyzed_by='${DEAL_ROOM_PROVENANCE}') — a live Zoom can't run in a seeder, so this beat is honestly staged`,
      })
    }

    // ── BEAT 5 · THE CLIENT RECAP CARD (honest-staged, labeled) ─────────────
    {
      const recap = { ...plan.recapCard, contact_id: ids.contactId }
      const { error } = await svc.from("transparency_updates").insert(recap as never)
      if (error) throw new Error(`recap card insert failed: ${error.message}`)
      steps.push({
        beat: "5 · client recap card on the portal", rail: "staged", ok: true,
        detail: "the exact transparency_updates row the approval rail writes (update_type 'meeting_recap'), seeded directly with demo provenance in metadata",
      })
    }
  } catch (e) {
    steps.push({ beat: "seed aborted", rail: "real", ok: false, detail: e instanceof Error ? e.message : String(e) })
    return { ok: false, error: e instanceof Error ? e.message : "seed failed", brokerageId, steps, ids, deliberation, gatewayConfigured }
  }

  return { ok: true, brokerageId, steps, ids, deliberation, gatewayConfigured }
}

// ─── Status (read-only, powers the presenter page) ───────────────────────────

export interface DealRoomStatus {
  demoTenant: { id: string; name: string | null; slug: string | null } | null
  gatewayConfigured: boolean
  seeded: boolean
  leadId: string | null
  contactId: string | null
  signalId: string | null
  deliberation: { status: string; winner: string | null; positions: number; rebuttalHeld: boolean } | null
  eventSeeded: boolean
  recapSeeded: boolean
}

export async function getDealRoomDemoStatus(): Promise<DealRoomStatus> {
  const svc = createServiceClient()
  const empty: DealRoomStatus = {
    demoTenant: null, gatewayConfigured: !!process.env.AI_GATEWAY_API_KEY, seeded: false,
    leadId: null, contactId: null, signalId: null, deliberation: null, eventSeeded: false, recapSeeded: false,
  }
  const { data: brk } = await svc.from("brokerages").select("id, name, slug").eq("is_demo", true).is("deleted_at", null)
    .order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (!brk) return empty
  const brokerageId = (brk as { id: string }).id
  const status: DealRoomStatus = { ...empty, demoTenant: brk as DealRoomStatus["demoTenant"] }

  const [{ data: lead }, { data: event }, { data: recap }, { data: sig }] = await Promise.all([
    svc.from("leads").select("id, contact_id").eq("brokerage_id", brokerageId).contains("tags", [DEAL_ROOM_TAG]).limit(1).maybeSingle(),
    svc.from("calendar_events").select("id").eq("id", DEAL_ROOM_IDS.calendarEvent).eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("transparency_updates").select("id").eq("id", DEAL_ROOM_IDS.recap).eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("manager_signals").select("id, payload").eq("brokerage_id", brokerageId)
      .eq("signal_type", "cross_manager_referral").contains("payload", { demo_marker: DEAL_ROOM_TAG })
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  status.leadId = (lead as { id: string } | null)?.id ?? null
  status.contactId = (lead as { contact_id: string | null } | null)?.contact_id ?? null
  if (!status.contactId) {
    const { data: c } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).contains("tags", [DEAL_ROOM_TAG]).limit(1).maybeSingle()
    status.contactId = (c as { id: string } | null)?.id ?? null
  }
  status.eventSeeded = !!event
  status.recapSeeded = !!recap
  status.signalId = (sig as { id: string } | null)?.id ?? null
  if (sig) {
    const { parseDeliberation } = await import("@/lib/managers/deliberation")
    const record = parseDeliberation((sig as { payload?: Record<string, unknown> }).payload ?? null)
    if (record) status.deliberation = { status: record.status, winner: record.winner, positions: record.positions.length, rebuttalHeld: record.rebuttalHeld === true }
  }
  status.seeded = !!(status.leadId && status.contactId && status.eventSeeded && status.recapSeeded)
  return status
}

// ─── The presenter's runbook (pure — the page renders exactly this) ──────────

export interface DealRoomRunbookStep {
  n: number
  title: string
  /** Deep link into the REAL surface where the beat lives (null → a button on the page, e.g. impersonation). */
  href: string | null
  surface: string
  /** The one-line presenter note. */
  note: string
  rail: "real" | "staged" | "gateway"
}

/** The flagship line — the sim locks its presence, word for word. */
export const DEAL_ROOM_FLAGSHIP_NOTE =
  "show the argument — no competitor can render disagreement"

export function buildDealRoomRunbook(ids: {
  leadId: string | null
  contactId: string | null
  eventId?: string
}): DealRoomRunbookStep[] {
  const eventId = ids.eventId ?? DEAL_ROOM_IDS.calendarEvent
  return [
    {
      n: 0,
      title: "Enter the demo tenant",
      href: null,
      surface: "audited impersonation (button below)",
      note: "the demo IS the real product — every link that follows is the live surface a paying tenant uses, deep-linked into the sanctioned demo tenant.",
      rail: "real",
    },
    {
      n: 1,
      title: "The scraped lead lands",
      href: ids.leadId ? `/leads/${ids.leadId}` : "/leads",
      surface: "/leads — the lead pipeline",
      note: "a territory-scraped prospect promoted through the PRODUCTION pipeline — point at the birth state: unconsented, AI-ISA-owned, nothing hand-entered.",
      rail: "real",
    },
    {
      n: 2,
      title: "The AI-ISA qualifies it",
      href: "/dashboard/isa",
      surface: "/dashboard/isa — the AI-ISA console (trail also on the lead record)",
      note: "consent → qualification → outcome: every stamp on the trail was written by the real kernel handlers, not a slideshow.",
      rail: "real",
    },
    {
      n: 3,
      title: "Conversion + policy assignment",
      href: ids.contactId ? `/crm/contacts/${ids.contactId}` : null,
      surface: "/crm/contacts/[contactId] — the converted client",
      note: "Engine 2 converted the lead and routed it by the live assignment policy — the assignment log is the receipt; ask the prospect who does this for them today.",
      rail: "real",
    },
    {
      n: 4,
      title: "The managers argue the price move — live",
      href: "/dashboard/admin/manager-trust",
      surface: "/dashboard/admin/manager-trust — cross-manager referrals",
      note: `${DEAL_ROOM_FLAGSHIP_NOTE}: grounded positions, one bounded rebuttal round, a winner with the stated why, dissent on the record (no gateway key → the ledger honestly says 'unavailable').`,
      rail: "gateway",
    },
    {
      n: 5,
      title: "The Zoom appointment, inside the OS",
      href: `/dashboard/meetings/${eventId}`,
      surface: "/dashboard/meetings/[eventId] — the meeting room",
      note: "the appointment lives IN the OS and its transcript feeds the same intelligence ledger as every call — this meeting is staged and labeled demo-provenance, because a seeder never fakes a live provider.",
      rail: "staged",
    },
    {
      n: 6,
      title: "End as the client — the recap card",
      href: ids.contactId ? `/portal/${ids.contactId}` : null,
      surface: "/portal/[contactId] — the client portal",
      note: "finish the tour as the client sees it: the human-approved meeting-recap card in the brokerage's own voice — transparency as a product feature.",
      rail: "staged",
    },
  ]
}
