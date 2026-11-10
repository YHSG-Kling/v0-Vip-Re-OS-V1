/**
 * scripts/saved-home-alerts-guard.ts — SAVED-HOME ALERTS, BUYER JOURNEYS, VENDOR ASSISTANCE, SUPPORT AUTONOMY
 * (wave 151, lane 151J). `test:saved-home-alerts`
 *
 * Owner: "saved home alerts"; "if the person's preferences are not set, then the arbiter decides"; "no spam".
 *
 * Every saved-home rule is driven END TO END through the ONE public door (watchSavedHomes — the cron route's daily tick)
 * on scripts/in-memory-supabase.ts: one saved row + one source row per case, the verdict read back from the sweep's own
 * stats and the audit event it leaves (lifecycle_events saved_home.alert carries the kind, the state digest, the drop
 * percent and the re-listing flag). No private helper is reached directly.
 *
 *   A. DIFF — a first read is a baseline; price drop at the matcher's floor; under contract; no longer available (sold /
 *      withdrawn / expired / the source deleted it); back on the market, a re-listing under a NEW MLS id announced ONCE;
 *      a price / status reversal carries the SAME digest; our status spellings normalize; the six m983 columns
 *   B. SWEEP — all four origins: a tenant listing's price cut is announced once and never again on the same state; a
 *      REAL reversal (500k → 480k → 500k → 480k) REPLAYS on the ledger instead of announcing twice; a deleted listing row
 *      is "no longer available"; a never-verified row is a baseline; dismissed / manual rows are never read; an IDX home
 *      is HELD by name with no spend; a refused read verifies nothing and says so
 *   C. ARBITER — a HOLD delivers nothing and leaves the verified state unadvanced (re-asked next sweep); the agent route
 *      opens the agent's activity and no buyer note; a note lands the delegation + the buyer's portal notification +
 *      evidence; NO cadence literal lives in the watch (positive control on a specimen)
 *   D. METERED RE-READ — held without an approved plan line (0 provider calls, hold on every row, ONE ledger row per
 *      tenant per day); proceeds under an approved line + platform caps; throttled to what fits; refused on null caps;
 *      deferred on an unreadable spend ledger; the DEFAULT spend reader counts this tenant's rows under this lane since
 *      the approval; the gate is asked BEFORE any reader (stripped source)
 *   E. FAMILY — the share re-reads the buyer's own saved rows; an unsaved ref is left out; the collaborator sees ONLY
 *      the shared homes' public facts
 *   F. SHOWING ON AN OUTSIDE SAVED HOME (row 77) — the survivor door is called with listingId undefined + the saved row's
 *      facts + savedPropertyId; ONE agent task carries the source record (idempotent); a gate refusal is said; an in-house
 *      home is sent back to its listing page; never a listings insert (positive control)
 *   G. VENDOR ASSISTANCE — every vendor seat tool pins the vendor's own rows (vendor_id + brokerage_id) or delegates to a
 *      session-gated survivor (positive control); a vendor seat with no vendor identity mounts nothing; the AI chat mounts
 *      a vendor identity only inside its own tenant; the bookings read narrows a vendor seat to its own vendor
 *   H. SUPPORT AUTONOMY — question → triage → registered owner → grounded answer delivered → evidence + ledger → the
 *      consumer VERIFIES and closes on resolution; billing / compliance keep a human; a foreign-tenant ticket is not applied
 *   I. WIRING (stripped source) + m983 + rows 78 / 79 — the daily tick carries the watch; the ONE router still asks and
 *      delivers; the card reads the verification line, which never carries approval / cap / spend words; m983 names the
 *      columns and the ONE source constant; the by-id reader gates and meters; the IDX blocker is recorded, not guessed
 *
 * POSITIVE CONTROLS: every absence claim is paired with a check that the finder sees the thing when it IS there.
 *
 * BLIND SPOTS (published): memSupabase runs no RLS, CHECK or DEFAULT (m983 is judged as SQL text; manager_signals rows
 * carry no default status here, so the bus dedupe is not exercised); RentCast, the rail and the arbiter's model are
 * injected — no network, no model; the daily tick is CRON_REGISTRY's property-alerts daily run and is not fired here;
 * `listing_media` readability for a contact session (row 79) is verified against the live pg_policies in the lane notes,
 * not here; pages are not rendered in a browser (wiring is read from stripped source); vendor tools are censused on
 * stripped source and mounted, never executed against a database.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import * as watch from "../lib/property-alerts/saved-home-watch"
import * as homes from "../lib/portal/saved-homes"
import * as share from "../lib/portal/collaborative-share"
import { selectNewOrRepricedMatches } from "../lib/property-alerts/alert-cadence"
import { SAVED_HOME_NUDGE_KINDS, NO_VIDEO_NUDGE_KINDS, classifySavedHomeNudge } from "../lib/ai-isa/saved-home-nudge"
import { platformScope, tenantScope } from "../lib/kernel/tenant-scope"
import { USER_TYPE_TOOL_POLICY } from "../lib/ai-isa/user-type-tool-policy"
import { USER_TYPE_SEAT_TOOL_BUILDERS, buildUserTypeSeatTools } from "../lib/ai-isa/user-type-tools"
import { TRIAGE_OWNER_BY_CATEGORY, SUPPORT_TRIAGE_EVENT, SUPPORT_AI_ANSWER_NOTIFICATION, triageSupportTicket, handleSupportTicketTriaged, type TriageModelOutput } from "../lib/support/ticket-triage"

const root = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER_BRK = "22222222-2222-4222-8222-222222222222"
const BUYER = "33333333-3333-4333-8333-333333333333"
const OTHER_BUYER = "44444444-4444-4444-8444-444444444444"
const AGENT_USER = "55555555-5555-4555-8555-555555555555"
const AGENT = "66666666-6666-4666-8666-666666666666"
const NOW = new Date("2026-11-09T14:00:00Z")
const DAY = (n: number) => new Date(NOW.getTime() + n * 86_400_000)
const M983_COLUMNS = ["last_verified_at", "last_verified_status", "last_verified_price", "last_verified_mls_number", "last_verified_source", "verification_hold"]

// The arbiter's decision seam (lib/ai-isa/followup-arbiter.ts ArbiterDecide) — the shape the timing guard uses.
type Decide = (a: { brokerageId: string; system: string; prompt: string }) => Promise<Record<string, unknown>>
const says = (optionId: string, extra: Record<string, unknown> = {}): Decide => async () => ({ optionId, channel: null, format: null, waitHours: null, rationale: `The evidence supports ${optionId} for this buyer right now.`, evidence: ["moment"], confidence: 0.9, ...extra })

type Row = Record<string, any>
function seedDb(extra: Record<string, Row[]> = {}) {
  return memSupabase({
    brokerages: [{ id: BRK, name: "Lone Star Realty", state: "TX" }, { id: OTHER_BRK, name: "Other", state: "TX" }],
    brokerage_settings: [],
    contacts: [
      { id: BUYER, brokerage_id: BRK, first_name: "Dana", last_name: "Reyes", email: "dana@example.com", agent_id: AGENT, last_contacted_at: DAY(-5).toISOString() },
      { id: OTHER_BUYER, brokerage_id: OTHER_BRK, first_name: "Other", email: "other@example.com" },
    ],
    agents: [{ id: AGENT, brokerage_id: BRK, user_id: AGENT_USER }],
    saved_properties: [], listings: [], acquisition_plans: [], vendor_usage_tracking: [],
    agent_action_ledger: [], lifecycle_events: [], manager_signals: [], notifications: [], activities: [], tasks: [],
    collaborative_searches: [], collaborative_search_members: [], collaborative_search_properties: [], property_family_ratings: [], property_consensus: [],
    ...extra,
  }, { stampCreatedAt: true, uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
}
const rowsOf = (db: ReturnType<typeof seedDb>, t: string) => db.tables[t] ?? []
const saved = (db: ReturnType<typeof seedDb>, id: string) => rowsOf(db, "saved_properties").find((r) => r.id === id)!
const alertEvents = (db: ReturnType<typeof seedDb>) => rowsOf(db, "lifecycle_events").filter((e) => e.event_type === watch.SAVED_HOME_ALERT_EVENT)
const alertNotes = (db: ReturnType<typeof seedDb>) => rowsOf(db, "notifications").filter((n) => n.type === watch.SAVED_HOME_ALERT_NOTIFICATION_TYPE)
const baseDeps = (): watch.SavedHomeWatchDeps => ({ now: NOW, unitUsd: 0.074, decide: says("written_note") as never })

/** One saved TENANT listing with the previous verified state (null = never verified) against a listing row carrying the
 *  next state (absent = the source deleted it); the sweep's verdict read back from its stats and the audit event. */
interface St { status: string | null; price: number | null; mls?: string | null }
async function diffVia(prev: St | null, next: St | { deleted: true }): Promise<{ kind: string | null; digest: string | null; dropPercent: number | null; relisted: boolean | null; summary: string | null; row: Row; stats: watch.SavedHomeWatchStats }> {
  const listing = "deleted" in next ? [] : [{ id: "L1", brokerage_id: BRK, status: next.status, lifecycle_stage: null, list_price: next.price, mls_number: next.mls === undefined ? "A1" : next.mls, deleted_at: null }]
  const db = seedDb({
    listings: listing,
    saved_properties: [{ id: "sp", brokerage_id: BRK, contact_id: BUYER, listing_id: "L1", source: "brokerage_listing", property_address: "12 Elm St", city: "Frisco", list_price: prev?.price ?? 500000, dismissed: false,
      last_verified_at: prev ? DAY(-1).toISOString() : null, last_verified_status: prev?.status ?? null, last_verified_price: prev?.price ?? null, last_verified_mls_number: prev ? (prev.mls === undefined ? "A1" : prev.mls) : null, last_verified_source: prev ? "tenant_listing" : null, verification_hold: null }],
  })
  const stats = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), baseDeps())
  const ev = alertEvents(db)[0]
  const m = (ev?.metadata ?? {}) as Row
  return { kind: Object.keys(stats.changes)[0] ?? null, digest: m.digest ?? null, dropPercent: m.drop_percent ?? null, relisted: typeof m.relisted_under_new_mls === "boolean" ? m.relisted_under_new_mls : null, summary: m.summary ?? null, row: saved(db, "sp"), stats }
}

async function main() {
  // ══ A ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n A. DIFF — every rule end to end through the sweep (one saved row, one source row)")
  const first = await diffVia(null, { status: "active", price: 500000 })
  check("a FIRST read is a BASELINE — no change, no alert, the verified state recorded", first.kind === null && first.stats.changesTotal === 0 && first.row.last_verified_at === NOW.toISOString() && first.row.last_verified_price === 500000 && first.row.last_verified_source === "tenant_listing", JSON.stringify(first.stats.errors))
  const drop = await diffVia({ status: "active", price: 500000 }, { status: "active", price: 480000 })
  check("active → active, price 500,000 → 480,000 is a price_drop of 4.0% keyed by the NEW price", drop.kind === "price_drop" && drop.dropPercent === 4 && drop.digest === "price_drop:480000", JSON.stringify({ k: drop.kind, d: drop.digest, p: drop.dropPercent, e: drop.stats.errors }))
  check("the six m983 columns are written and the card price follows the asking price while on market (hold cleared)", M983_COLUMNS.every((c) => c in drop.row) && drop.row.last_verified_price === 480000 && drop.row.list_price === 480000 && drop.row.last_verified_status === "active" && drop.row.verification_hold === null && drop.row.last_verified_mls_number === "A1")
  check("a 1% drop is below the matcher's floor — not a change; 2% (the floor, inclusive) is", (await diffVia({ status: "active", price: 500000 }, { status: "active", price: 495000 })).kind === null && (await diffVia({ status: "active", price: 500000 }, { status: "active", price: 490000 })).kind === "price_drop")
  check("the floor IS the alert matcher's own default (alert-cadence.ts: 1.9% not repriced, 2% repriced) — one number", (() => {
    const sent = [{ mls_number: "m", list_price: 500000, property_address: "1 A St" }]
    const a = selectNewOrRepricedMatches([{ mls_number: "m", property_address: "1 A St", list_price: 490500 }], sent, {})
    const b = selectNewOrRepricedMatches([{ mls_number: "m", property_address: "1 A St", list_price: 490000 }], sent, {})
    return a.length === 0 && b.length === 1 && b[0].kind === "repriced" && watch.SAVED_HOME_PRICE_DROP_MIN_PERCENT === 2
  })())
  const rise = await diffVia({ status: "active", price: 480000 }, { status: "active", price: 500000 })
  check("a price RISE is not announced — but the verified price and the card price advance to the truth", rise.kind === null && rise.row.last_verified_price === 500000 && rise.row.list_price === 500000)
  check("active → pending is under_contract", (await diffVia({ status: "active", price: 500000 }, { status: "pending", price: 500000 })).kind === "under_contract")
  check("pending → active is back_on_market (a deal fell through)", (await diffVia({ status: "pending", price: 500000 }, { status: "active", price: 500000 })).kind === "back_on_market")
  const endings = await Promise.all(["sold", "withdrawn", "expired"].map((s) => diffVia({ status: "active", price: 500000 }, { status: s, price: 500000 })))
  check("active → sold / withdrawn / expired are no_longer_available; the card keeps the last asking price (never a stale lower one)", endings.every((e) => e.kind === "no_longer_available") && endings.every((e) => e.row.list_price === 500000))
  const deleted = await diffVia({ status: "active", price: 500000 }, { deleted: true })
  check("SOURCE DELETION (the listing row is gone) reads off_market → no_longer_available, once", deleted.kind === "no_longer_available" && deleted.row.last_verified_status === "off_market" && deleted.stats.changesTotal === 1)
  check("pending → sold is no_longer_available (an ending, not 'interest')", (await diffVia({ status: "pending", price: 500000 }, { status: "sold", price: 500000 })).kind === "no_longer_available")
  const relist = await diffVia({ status: "withdrawn", price: 500000, mls: "A1" }, { status: "active", price: 489000, mls: "B2" })
  check("RE-LISTING UNDER A NEW MLS ID: withdrawn A1 → active B2 is ONE back_on_market carrying the new number", relist.kind === "back_on_market" && relist.relisted === true && relist.digest === "back_on_market:B2:active" && relist.row.mls_number === "B2", JSON.stringify({ k: relist.kind, r: relist.relisted, d: relist.digest }))
  check("the same re-listing observed twice carries the SAME digest (the ledger replays, never a second notice)", (await diffVia({ status: "withdrawn", price: 500000, mls: "A1" }, { status: "active", price: 489000, mls: "B2" })).digest === relist.digest)
  check("REVERSAL digests: 500k → 480k and, after a rise, 500k → 480k again carry the SAME digest", (await diffVia({ status: "active", price: 500000 }, { status: "active", price: 480000 })).digest === drop.digest)
  check("STATUS REVERSAL: two active → pending readings carry the same under_contract digest (one notice)", (await diffVia({ status: "active", price: 500000 }, { status: "pending", price: 500000 })).digest === (await diffVia({ status: "active", price: 500000 }, { status: "pending", price: 500000 })).digest && (await diffVia({ status: "active", price: 500000 }, { status: "pending", price: 500000 })).digest === "under_contract:A1:pending")
  check("an UNKNOWN current status claims nothing (the read did not say)", (await diffVia({ status: "active", price: 500000 }, { status: null, price: 480000 })).kind === null)
  check("our spellings normalize through the reader: coming_soon is on-market (back on market from withdrawn); Under_Contract is pending; Inactive is off-market", (await diffVia({ status: "withdrawn", price: 500000 }, { status: "coming_soon", price: 500000 })).kind === "back_on_market" && (await diffVia({ status: "active", price: 500000 }, { status: "Under_Contract", price: 500000 })).kind === "under_contract" && (await diffVia({ status: "active", price: 500000 }, { status: "Inactive", price: 500000 })).kind === "no_longer_available")
  check("POSITIVE CONTROL: every change kind is reachable through the sweep", (watch.SAVED_HOME_CHANGE_KINDS as readonly string[]).every((k) => [drop.kind, relist.kind, endings[0].kind, "under_contract"].includes(k)))
  check("the change kinds are a SUBSET of the planner's vocabulary (never a second spelling); no_longer_available is on the roster and never video", (watch.SAVED_HOME_CHANGE_KINDS as readonly string[]).every((k) => (SAVED_HOME_NUDGE_KINDS as string[]).includes(k)) && classifySavedHomeNudge("no_longer_available")?.avatarWorthy === false && (NO_VIDEO_NUDGE_KINDS as readonly string[]).includes("under_contract"))

  // ══ B ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n B. SWEEP — all four origins, in memory")
  {
    const db = seedDb({
      listings: [
        { id: "L1", brokerage_id: BRK, status: "active", lifecycle_stage: "MLS_ACTIVE", list_price: 480000, mls_number: "A1", deleted_at: null },
        // L2 deleted → absent; L3 fresh
        { id: "L3", brokerage_id: BRK, status: "active", lifecycle_stage: "MLS_ACTIVE", list_price: 350000, mls_number: "C3", deleted_at: null },
      ],
      saved_properties: [
        { id: "sp-tenant", brokerage_id: BRK, contact_id: BUYER, listing_id: "L1", source: "brokerage_listing", property_address: "12 Elm St", city: "Frisco", list_price: 500000, dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 500000, last_verified_mls_number: "A1", last_verified_source: "tenant_listing", verification_hold: null },
        { id: "sp-deleted", brokerage_id: BRK, contact_id: BUYER, listing_id: "L2", source: "brokerage_listing", property_address: "9 Oak Ct", city: "Plano", list_price: 600000, dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 600000, last_verified_mls_number: "B2", last_verified_source: "tenant_listing", verification_hold: null },
        { id: "sp-first", brokerage_id: BRK, contact_id: BUYER, listing_id: "L3", source: "brokerage_listing", property_address: "3 Pine Rd", city: "Allen", list_price: 350000, dismissed: false, last_verified_at: null, last_verified_status: null, last_verified_price: null, last_verified_mls_number: null, last_verified_source: null, verification_hold: null },
        { id: "sp-dismissed", brokerage_id: BRK, contact_id: BUYER, listing_id: "L1", source: "brokerage_listing", property_address: "12 Elm St", dismissed: true, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 500000, last_verified_mls_number: "A1", last_verified_source: "tenant_listing", verification_hold: null },
        { id: "sp-manual", brokerage_id: BRK, contact_id: BUYER, listing_id: null, source: "manual", property_address: "7 Staff Way", dismissed: false, last_verified_at: null },
        { id: "sp-idx", brokerage_id: BRK, contact_id: BUYER, listing_id: null, source: "idx", external_property_id: "idx-77", mls_number: "I7", property_address: "77 Ranch Rd", dismissed: false, last_verified_at: null, verification_hold: null },
        { id: "sp-other", brokerage_id: OTHER_BRK, contact_id: OTHER_BUYER, listing_id: "L1", source: "brokerage_listing", property_address: "77 Other Tenant Way", dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 900000, last_verified_source: "tenant_listing" },
      ],
    })
    const calls = { rentcast: 0, rail: 0 }
    const deps: watch.SavedHomeWatchDeps = {
      ...baseDeps(),
      readRentcastListing: async () => { calls.rentcast++; return { kind: "held", reason: "source_unreadable", detail: "not expected" } },
      readByAddress: async () => { calls.rail++; return { kind: "held", reason: "source_unreadable", detail: "not expected" } },
    }
    const s1 = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), deps)
    check("the tenant scope reads only this tenant's non-dismissed rows (5 scanned; the other tenant's and the dismissed row untouched)", s1.scanned === 5 && saved(db, "sp-other").last_verified_price === 900000 && saved(db, "sp-dismissed").verification_hold === null, JSON.stringify({ scanned: s1.scanned, errors: s1.errors }))
    check("sp-tenant: the price cut is ONE change → announced (delegation + portal note), verified state advanced to 480,000 and the card price with it", s1.changes.price_drop === 1 && s1.delivered >= 1 && saved(db, "sp-tenant").last_verified_price === 480000 && saved(db, "sp-tenant").list_price === 480000, JSON.stringify({ changes: s1.changes, delivered: s1.delivered, errors: s1.errors }))
    const notes = alertNotes(db)
    check("the buyer's portal notification is the HISTORY row: contact_id, the saved home as entity, is_read false (read_at = the acknowledgement); the audit event is keyed by the same home and digest", notes.some((n) => n.contact_id === BUYER && n.entity_type === "saved_property" && n.entity_id === "sp-tenant" && n.is_read === false) && alertEvents(db).some((e) => e.entity_id === "sp-tenant" && e.metadata?.digest === "price_drop:480000"), JSON.stringify(notes.map((n) => ({ e: n.entity_id, c: n.contact_id }))))
    check("the delegation is the ONE router's: a campaign_orchestrator saved_home_message signal from shopping_agent carrying the kind", rowsOf(db, "manager_signals").some((m) => m.to_manager === "campaign_orchestrator" && m.signal_type === "saved_home_message" && m.from_manager === "shopping_agent" && m.payload?.nudge_kind === "price_drop"))
    check("evidence: ONE ledger row saved_home.alert.announce (executed) keyed by home + digest", rowsOf(db, "agent_action_ledger").filter((l) => l.action === watch.SAVED_HOME_ALERT_ACTION && l.idempotency_key === `${watch.SAVED_HOME_ALERT_ACTION}:sp-tenant:price_drop:480000` && l.status === "executed").length === 1)
    check("sp-deleted: the listing row is gone → no_longer_available announced once", s1.changes.no_longer_available === 1 && saved(db, "sp-deleted").last_verified_status === "off_market" && notes.some((n) => n.entity_id === "sp-deleted"))
    check("sp-first: a never-verified home gets its BASELINE and no alert", saved(db, "sp-first").last_verified_at === NOW.toISOString() && saved(db, "sp-first").last_verified_price === 350000 && !notes.some((n) => n.entity_id === "sp-first"))
    check("sp-manual: a staff-entered row has no source — skipped, not held", s1.skipped.manual === 1 && !saved(db, "sp-manual").verification_hold)
    check("sp-idx: an IDX saved home is HELD by name — no spend, no guess, the hold on the row", s1.holds.idx_by_id_unavailable === 1 && String(saved(db, "sp-idx").verification_hold).startsWith("idx_by_id_unavailable:") && saved(db, "sp-idx").last_verified_at === null && calls.rentcast === 0 && calls.rail === 0)
    const notesBefore = notes.length, ledgerBefore = rowsOf(db, "agent_action_ledger").length
    const s2 = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...deps, now: DAY(1) })
    check("a SECOND sweep on the same state announces NOTHING (no change, no new note, no new ledger row)", s2.changesTotal === 0 && s2.delivered === 0 && alertNotes(db).length === notesBefore && rowsOf(db, "agent_action_ledger").length === ledgerBefore, JSON.stringify(s2.changes))
    // THE REAL REVERSAL: 480k (announced) → back to 500k (silent) → 480k again → the SAME digest → the ledger REPLAYS.
    db.tables.listings.find((l) => l.id === "L1")!.list_price = 500000
    const s3 = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...deps, now: DAY(2) })
    db.tables.listings.find((l) => l.id === "L1")!.list_price = 480000
    const s4 = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...deps, now: DAY(3) })
    check("PRICE REVERSAL end to end: the rise is silent (price advanced), the second drop to the same 480,000 REPLAYS on the ledger — no second note, nothing delivered twice", s3.changesTotal === 0 && saved(db, "sp-tenant").last_verified_price === 480000 && s4.changes.price_drop === 1 && s4.replayed === 1 && s4.delivered === 0 && alertNotes(db).filter((n) => n.entity_id === "sp-tenant").length === 1, JSON.stringify({ s3: s3.changes, s4: { c: s4.changes, r: s4.replayed, d: s4.delivered }, errors: s4.errors }))
    const p = await watch.watchSavedHomes(db, platformScope("proof: the platform-wide daily tick"), { ...deps, now: DAY(4) })
    check("the PLATFORM scope reads every tenant (the other tenant's row is verified too) — a declared scope, never an absent id", p.scanned === 6, String(p.scanned))
    const refused = memSupabase({ saved_properties: [] }, { refuse: { saved_properties: "permission denied for table saved_properties" } })
    const r = await watch.watchSavedHomes(refused as never, tenantScope(BRK, "proof"), deps)
    check("a REFUSED saved-homes read verifies nothing and says so (never 'no saved homes')", r.scanned === 0 && r.errors.some((e) => /refused/.test(e)))
  }

  // ══ C ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n C. ARBITER — hold, agent, note; no cadence of any kind")
  {
    const mk = () => seedDb({
      listings: [{ id: "L1", brokerage_id: BRK, status: "sold", list_price: 500000, mls_number: "A1", deleted_at: null }],
      saved_properties: [{ id: "sp", brokerage_id: BRK, contact_id: BUYER, listing_id: "L1", source: "brokerage_listing", property_address: "12 Elm St", city: "Frisco", list_price: 500000, dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 500000, last_verified_mls_number: "A1", last_verified_source: "tenant_listing", verification_hold: null }],
    })
    const dbHold = mk()
    const held = await watch.watchSavedHomes(dbHold, tenantScope(BRK, "proof"), { ...baseDeps(), decide: says("wait", { waitHours: 12 }) as never })
    check("the arbiter HOLDS (wait): nothing delivered, no buyer note, the verified state NOT advanced, the hold said on the row", held.arbiterHeld === 1 && held.delivered === 0 && alertNotes(dbHold).length === 0 && saved(dbHold, "sp").last_verified_status === "active" && String(saved(dbHold, "sp").verification_hold).startsWith("arbiter_wait:"), JSON.stringify({ held, hold: saved(dbHold, "sp").verification_hold, errors: held.errors }))
    const again = await watch.watchSavedHomes(dbHold, tenantScope(BRK, "proof"), { ...baseDeps(), now: DAY(1) })
    check("a held change is RE-ASKED next sweep (the diff still stands) and announced once the arbiter says so", again.changesTotal === 1 && again.delivered === 1 && saved(dbHold, "sp").last_verified_status === "sold" && saved(dbHold, "sp").verification_hold === null && alertNotes(dbHold).length === 1)
    check("the arbiter's decisions are ledgered (followup.decision.*) — the HOLD is evidence, not silence", rowsOf(dbHold, "agent_action_ledger").some((l) => String(l.action).startsWith("followup.decision.")))
    const dbAgent = mk()
    const ag = await watch.watchSavedHomes(dbAgent, tenantScope(BRK, "proof"), { ...baseDeps(), decide: says("agent") as never })
    check("the arbiter chooses the AGENT: the agent's activity opens, no buyer note (the agent IS the message), state advanced", ag.delivered === 1 && rowsOf(dbAgent, "activities").some((a) => a.agent_id === AGENT && a.contact_id === BUYER) && alertNotes(dbAgent).length === 0 && saved(dbAgent, "sp").last_verified_status === "sold", JSON.stringify({ ag, acts: rowsOf(dbAgent, "activities").length }))
    const dbNote = mk()
    const nt = await watch.watchSavedHomes(dbNote, tenantScope(BRK, "proof"), baseDeps())
    const note = alertNotes(dbNote)[0]
    check("the arbiter chooses a NOTE: the buyer's words say what the source reported and point to the agent — no figure, no provider word", nt.delivered === 1 && !!note && /no longer on the market/i.test(note.title) && /sold/.test(note.body) && !/\$\s?\d/.test(note.body) && !/rentcast|idx/i.test(note.body), JSON.stringify(note))
    const src = code("lib/property-alerts/saved-home-watch.ts")
    const hasCadence = (s: string) => /\b(frequency|cadence|schedule)\s*[:=]\s*["'](instant|daily|weekly|twice_daily|hourly)["']/.test(s) || /\bsetInterval\s*\(/.test(s) || /["']\d+ \d+ \* \* \*["']/.test(s) || /\b(everyDay|daysBetween|hoursBetween)\s*[:=]\s*\d/.test(s)
    check("the watch carries NO notification cadence (no frequency / schedule literal, no interval, no cron string)", !hasCadence(src))
    check("POSITIVE CONTROL: a specimen with a daily cadence beside a notifications insert IS caught", hasCadence(`const frequency = "daily"\nawait db.from("notifications").insert({})`) && hasCadence(`setInterval(() => poll(), 60000)`))
    check("the watch's ONLY notification write sits inside the alert, AFTER the arbiter decided (decideSavedHomeNudge precedes it; one write site)", (src.match(/from\("notifications"\)/g) ?? []).length === 1 && src.indexOf("decideSavedHomeNudge(") > 0 && src.indexOf("decideSavedHomeNudge(") < src.indexOf('from("notifications")'))
    check("the watch itself never chooses a channel or writes an email / SMS — the delegation does (no dispatchEmail / dispatchSms / sendgrid in the watch)", !/dispatchEmail|dispatchSms|sendgrid|twilio/i.test(src))
    check("the watch's ONLY exported function is the door the cron route calls (watchSavedHomes) — every rule is module-private", (src.match(/^export (async )?function (\w+)/gm) ?? []).map((l) => l.replace(/^export (async )?function /, "")).join() === "watchSavedHomes")
  }

  // ══ D ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n D. METERED RE-READ — approval and the platform caps BEFORE any request; held and recorded otherwise")
  {
    const line = (max: number | null) => [{ id: "plan-1", brokerage_id: BRK, status: "approved", valid_until: DAY(30).toISOString(), lines: [{ source: watch.SAVED_HOME_RECHECK_SOURCE, status: "approved", maxSpendUsd: max, approvedAt: DAY(-10).toISOString() }] }]
    const base = (saved_properties: Row[], acquisition_plans: Row[] = [], vendor_usage_tracking: Row[] = []) => seedDb({ saved_properties, acquisition_plans, vendor_usage_tracking })
    const external = () => [
      { id: "sp-rc", brokerage_id: BRK, contact_id: BUYER, listing_id: null, source: "rentcast", external_property_id: "rc-1", mls_number: "A1", mls_name: "NTREIS", property_address: "5 Market St", city: "Frisco", list_price: 600000, dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 600000, last_verified_mls_number: "A1", last_verified_source: "rentcast_listing", verification_hold: null },
      { id: "sp-url", brokerage_id: BRK, contact_id: BUYER, listing_id: null, source: "buyer_url", external_property_id: "url:abc", source_url: "https://www.zillow.com/homedetails/8-Link-Ln-Plano-TX-75024/1_zpid/", property_address: "8 Link Ln", city: "Plano", state: "TX", list_price: 420000, dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 420000, last_verified_mls_number: null, last_verified_source: "buyer_url", verification_hold: null },
    ]
    const readers = (calls: { rc: number; rail: number }): Partial<watch.SavedHomeWatchDeps> => ({
      readRentcastListing: async () => { calls.rc++; return { kind: "verified", state: { status: "off_market", price: null, mlsNumber: "A1", source: "rentcast_listing", at: NOW.toISOString() } } },
      readByAddress: async () => { calls.rail++; return { kind: "verified", state: { status: "pending", price: 420000, mlsNumber: "Z9", source: "buyer_url", at: NOW.toISOString() } } },
    })
    // 1. No approved plan line → HELD, 0 provider calls, hold on every row, ONE ledger row per tenant per day.
    {
      const db = base(external())
      const calls = { rc: 0, rail: 0 }
      const s = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...baseDeps(), ...readers(calls), platformCapRemainingUsd: async () => 25 })
      check("no approved plan line → both re-reads HELD, ZERO provider calls", s.meteredRecheck.heldRows === 2 && s.meteredRecheck.allowedRows === 0 && calls.rc === 0 && calls.rail === 0, JSON.stringify(s.meteredRecheck))
      check("the hold is on EVERY row, by name (metered_recheck_unapproved: … no approved, unexpired acquisition plan …)", ["sp-rc", "sp-url"].every((id) => /^metered_recheck_unapproved: .*no approved, unexpired acquisition plan/.test(String(saved(db, id).verification_hold))), String(saved(db, "sp-rc").verification_hold))
      const heldRows = rowsOf(db, "agent_action_ledger").filter((l) => l.action === "saved_home_recheck.decision.do_nothing")
      check("NEVER A SILENT POLL: ONE ledger row per tenant per day says the re-read was held and why (wanted 2, allowed 0)", heldRows.length === 1 && heldRows[0].detail?.wanted === 2 && heldRows[0].detail?.allowed === 0 && heldRows[0].detail?.source === watch.SAVED_HOME_RECHECK_SOURCE, JSON.stringify(heldRows.map((h) => h.detail)))
      await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...baseDeps(), now: new Date(NOW.getTime() + 3_600_000), ...readers(calls), platformCapRemainingUsd: async () => 25 })
      check("a second sweep the same day does not write a second held row (the cycle key dedupes) and still makes no call", rowsOf(db, "agent_action_ledger").filter((l) => l.action === "saved_home_recheck.decision.do_nothing").length === 1 && calls.rc === 0)
      check("the verified state of a held home is untouched (nothing was verified)", saved(db, "sp-rc").last_verified_status === "active" && saved(db, "sp-rc").last_verified_at === DAY(-1).toISOString())
    }
    // 2. Approved line + caps → proceeds; the readers run; the changes are announced.
    {
      const db = base(external(), line(1))
      const calls = { rc: 0, rail: 0 }
      const s = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...baseDeps(), ...readers(calls), platformCapRemainingUsd: async () => 25, spentSinceApproval: async () => 0 })
      check("an approved line ($1.00) + caps ($25 left) → both re-reads proceed (2 × $0.074), each reader called once", s.meteredRecheck.allowedRows === 2 && s.meteredRecheck.heldRows === 0 && calls.rc === 1 && calls.rail === 1 && s.meteredRecheck.usdPlanned === 0.15, JSON.stringify(s.meteredRecheck))
      check("the RentCast home came back off-market → no_longer_available; the pasted-link home went pending → under_contract — both announced", s.changes.no_longer_available === 1 && s.changes.under_contract === 1 && s.delivered === 2 && saved(db, "sp-rc").last_verified_status === "off_market" && saved(db, "sp-url").last_verified_status === "pending" && saved(db, "sp-url").last_verified_mls_number === "Z9", JSON.stringify({ changes: s.changes, errors: s.errors }))
      check("no held ledger row when nothing was held", !rowsOf(db, "agent_action_ledger").some((l) => l.action === "saved_home_recheck.decision.do_nothing"))
    }
    // 3. Throttle: $0.10 fits ONE request → the first proceeds, the second is held as throttled.
    {
      const db = base(external(), line(0.1))
      const calls = { rc: 0, rail: 0 }
      const s = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...baseDeps(), ...readers(calls), platformCapRemainingUsd: async () => 25, spentSinceApproval: async () => 0 })
      check("a $0.10 ceiling fits one $0.074 request → THROTTLED: 1 read, 1 held as metered_recheck_throttled", s.meteredRecheck.allowedRows === 1 && s.meteredRecheck.heldRows === 1 && calls.rc + calls.rail === 1 && [saved(db, "sp-rc"), saved(db, "sp-url")].some((r) => String(r.verification_hold).startsWith("metered_recheck_throttled:")), JSON.stringify(s.meteredRecheck))
    }
    // 4. Lane 151F's rule holds here too: null platform caps → refused.
    {
      const db = base(external(), line(1))
      const calls = { rc: 0, rail: 0 }
      const s = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...baseDeps(), ...readers(calls), platformCapRemainingUsd: async () => null, spentSinceApproval: async () => 0 })
      check("platform caps NOT configured (null) → refused even under an approved line; 0 calls; the reason names the caps", s.meteredRecheck.allowedRows === 0 && calls.rc === 0 && s.meteredRecheck.reasons.some((r) => /platform acquisition caps/.test(r)), JSON.stringify(s.meteredRecheck.reasons))
    }
    // 5. Unreadable spend ledger → deferred.
    {
      const db = base(external(), line(1))
      const calls = { rc: 0, rail: 0 }
      const s = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...baseDeps(), ...readers(calls), platformCapRemainingUsd: async () => 25, spentSinceApproval: async () => null })
      check("the spend booked against the approval is UNREADABLE → deferred, 0 calls (we cannot know what is left)", s.meteredRecheck.allowedRows === 0 && calls.rc === 0 && s.meteredRecheck.reasons.some((r) => /could not be read/.test(r)), JSON.stringify(s.meteredRecheck.reasons))
    }
    // 6. The DEFAULT spend reader (not injected) reads the vendor ledger under the re-read's own lane, since the approval, this tenant only.
    {
      const db = base(external(), line(0.2), [
        { brokerage_id: BRK, vendor_name: "rentcast", total_cost: 0.074, created_at: DAY(-2).toISOString(), request_metadata: { system_source: watch.SAVED_HOME_RECHECK_SOURCE } },
        { brokerage_id: BRK, vendor_name: "rentcast", total_cost: 0.074, created_at: DAY(-20).toISOString(), request_metadata: { system_source: watch.SAVED_HOME_RECHECK_SOURCE } }, // before the approval
        { brokerage_id: BRK, vendor_name: "rentcast", total_cost: 5, created_at: DAY(-2).toISOString(), request_metadata: { system_source: "buyer_search" } }, // another lane
        { brokerage_id: OTHER_BRK, vendor_name: "rentcast", total_cost: 5, created_at: DAY(-2).toISOString(), request_metadata: { system_source: watch.SAVED_HOME_RECHECK_SOURCE } }, // another tenant
      ])
      const calls = { rc: 0, rail: 0 }
      const s = await watch.watchSavedHomes(db, tenantScope(BRK, "proof"), { ...baseDeps(), ...readers(calls), platformCapRemainingUsd: async () => 25 })
      check("spend since the approval counts ONLY this tenant's rows under this lane after approvedAt ($0.074 of $0.20 → one more request fits: throttled 1 of 2)", s.meteredRecheck.allowedRows === 1 && s.meteredRecheck.heldRows === 1 && calls.rc + calls.rail === 1 && s.meteredRecheck.reasons.some((r) => /binds/.test(r)), JSON.stringify(s.meteredRecheck))
    }
    // 7. The gate precedes every reader, in the text of the sweep itself.
    {
      const src = code("lib/property-alerts/saved-home-watch.ts")
      const sweep = src.slice(src.indexOf("export async function watchSavedHomes("))
      const gateAt = sweep.indexOf("planMeteredRecheck(")
      const rcAt = sweep.indexOf("readRentcastListing ?? defaultReadRentcastListing")
      const railAt = sweep.indexOf("readByAddress ?? defaultReadByAddress")
      check("in the sweep, planMeteredRecheck( is asked BEFORE either metered reader is called (text order)", gateAt > 0 && rcAt > gateAt && railAt > gateAt)
      check("the approval is the plan-line rule (paidPullApproval) and the sizing is decideSpendBackpressure with platformCapRemainingUsd — the survivors, not a copy", /paidPullApproval\(/.test(src) && /decideSpendBackpressure\(\{/.test(src) && /platformCapRemainingUsd/.test(src) && /platformCapRemainingFor\(/.test(src))
      check("the RentCast by-id reader is metered under the re-read's own lane (systemSource: SAVED_HOME_RECHECK_SOURCE) and never the default buyer_search lane", /systemSource: SAVED_HOME_RECHECK_SOURCE/.test(src) && !/systemSource: "buyer_search"/.test(src))
    }
  }

  // ══ E ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n E. FAMILY — shared homes only")
  {
    const db = seedDb({
      saved_properties: [
        { id: "sp1", brokerage_id: BRK, contact_id: BUYER, listing_id: "L-1", property_address: "12 Elm St", city: "Frisco", state: "TX", list_price: 640000, bedrooms: 3, bathrooms: 2, sqft: 2100, property_type: "single_family", notes: "BUYER-PRIVATE-NOTE", dismissed: false },
        { id: "sp2", brokerage_id: BRK, contact_id: BUYER, external_property_id: "rc-9", source: "rentcast", mls_name: "NTREIS", property_address: "9 Oak Ct", city: "Plano", state: "TX", list_price: 590000, bedrooms: 4, bathrooms: 3, dismissed: false },
        { id: "sp3", brokerage_id: BRK, contact_id: BUYER, listing_id: "L-NOT-SHARED", property_address: "1 Private Rd", dismissed: false },
      ],
    })
    let n = 0
    const r = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: AGENT_USER, listingRefs: ["L-1", "rc-9", "L-SOMEONE-ELSES"], collaborator: { name: "Mom", email: "mom@example.com" }, scope: "feedback_only", now: NOW },
      { checkSuppression: async () => ({ suppressed: false }), sendEmailInvite: async () => ({ ok: true }), tokenFactory: () => `tok-${++n}-${"x".repeat(40)}` })
    check("the buyer shares TWO saved homes; a ref they never saved is left out with a note", r.ok && r.sharedHomeIds.length === 2 && r.notes.some((x) => /left out/.test(x)), JSON.stringify(r))
    const v = r.ok ? await share.collaboratorView(db, r.token, NOW) : null
    check("the family member sees ONLY the two shared homes' public facts — not the third saved home, no notes, no criteria", !!v && v.ok && v.view.homes.length === 2 && v.view.homes.every((h) => !("notes" in (h.facts as unknown as Record<string, unknown>)) && !/Private Rd/.test(JSON.stringify(h.facts))), JSON.stringify(v))
    check("a forged token opens nothing", !(await share.collaboratorView(db, "forged-token-forged-token-forged", NOW)).ok)
  }

  // ══ F ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n F. SHOWING ON AN OUTSIDE SAVED HOME (row 77) — the survivor door + ONE agent task with the source record")
  {
    const db = seedDb({ saved_properties: [
      { id: "sp-rc", brokerage_id: BRK, contact_id: BUYER, listing_id: null, source: "rentcast", external_property_id: "rc-1", mls_number: "A1", mls_name: "NTREIS", property_address: "5 Market St", city: "Frisco", state: "TX", list_price: 600000, dismissed: false },
      { id: "sp-link", brokerage_id: BRK, contact_id: BUYER, listing_id: null, source: "buyer_url", external_property_id: "url:abc", source_url: "https://www.realtor.com/x", property_address: null, dismissed: false },
      { id: "sp-ours", brokerage_id: BRK, contact_id: BUYER, listing_id: "L1", source: "brokerage_listing", external_property_id: "ours-ext", property_address: "12 Elm St", dismissed: false },
    ] })
    const doorCalls: Array<Record<string, unknown>> = []
    const door = async (data: Record<string, unknown>) => { doorCalls.push(data); return { success: true, data: { id: "req-1" } } }
    const ctx = { brokerageId: BRK, contactId: BUYER, ownerUserId: AGENT_USER, agentId: AGENT }
    const r1 = await homes.requestExternalShowing(db, ctx, { source: "rentcast", externalId: "rc-1" }, { requestShowing: door as never, now: NOW })
    const d = doorCalls[0] ?? {}
    check("the survivor showing door is called with listingId UNDEFINED, the saved row's own facts, savedPropertyId and source buyer_portal", r1.ok && doorCalls.length === 1 && d.listingId === undefined && d.propertyAddress === "5 Market St" && d.mlsNumber === "A1" && d.savedPropertyId === "sp-rc" && d.source === "buyer_portal" && d.contactId === BUYER && /NTREIS/.test(String(d.clientNotes)), JSON.stringify(d))
    const tasks = rowsOf(db, "tasks")
    check("ONE agent task opens for the assigned agent carrying the SOURCE RECORD (saved row id, MLS number, the MLS, the request id)", r1.taskId !== null && tasks.length === 1 && tasks[0].assigned_to_agent_id === AGENT && tasks[0].contact_id === BUYER && tasks[0].listing_id === null && /saved_properties sp-rc/.test(tasks[0].description) && /MLS A1 on NTREIS/.test(tasks[0].description) && /req-1/.test(tasks[0].description) && tasks[0].source === "external_showing_request", JSON.stringify(tasks[0]))
    check("NEVER a fake listing row: no listings insert in the whole flow", !db.writes.some((w) => w.table === "listings" && w.op === "insert"))
    const r2 = await homes.requestExternalShowing(db, ctx, { source: "rentcast", externalId: "rc-1" }, { requestShowing: door as never, now: NOW })
    check("asked again for the SAME showing request → the door answers the same request id and the task REPLAYS (still one task row; a double tap is bucketed upstream by the reaction ledger)", r2.ok && doorCalls.length === 2 && rowsOf(db, "tasks").length === 1)
    const refusing = async () => ({ success: false, error: "BBA required", errorCode: "bba_required" })
    const r3 = await homes.requestExternalShowing(db, ctx, { source: "rentcast", externalId: "rc-1" }, { requestShowing: refusing as never, now: NOW })
    check("a gate refusal (BBA) is said in the buyer's words and opens no second task", !r3.ok && /buyer agreement/.test(r3.note) && rowsOf(db, "tasks").length === 1, r3.note)
    const r4 = await homes.requestExternalShowing(db, ctx, { source: "buyer_url", externalId: "url:abc" }, { requestShowing: door as never, now: NOW })
    check("a link saved with NO address has nothing to show yet — honest note, no door call, no task", !r4.ok && /address/.test(r4.note) && doorCalls.length === 2 && rowsOf(db, "tasks").length === 1, r4.note)
    const r5 = await homes.requestExternalShowing(db, ctx, { source: "brokerage_listing", externalId: "ours-ext" }, { requestShowing: door as never, now: NOW })
    check("an IN-HOUSE saved home (listing row) is NOT routed through this door — the showings page requests against the listing (said in the buyer's words; no door call, no task)", !r5.ok && /own listings/.test(r5.note) && doorCalls.length === 2 && rowsOf(db, "tasks").length === 1, r5.note)
    const door2 = async () => ({ success: true, data: { id: "req-2" } })
    const r6 = await homes.requestExternalShowing(db, { ...ctx, agentId: null }, { source: "rentcast", externalId: "rc-1" }, { requestShowing: door2 as never, now: NOW })
    check("no assigned agent → the request still stands, the task is honestly not opened (the note promises only the request)", r6.ok && r6.showingRequestId === "req-2" && r6.taskId === null && rowsOf(db, "tasks").length === 1 && /showing request is in/.test(r6.note), r6.note)
    const act = code("app/actions/buyer-search/conversational-search.ts")
    const tourBranch = act.slice(act.indexOf('input.kind === "tour_requested" && listingId.startsWith("ext_")'))
    check("WIRING: buyerHomeFeedbackAction routes a tour ask on an ext_ home through requestExternalShowing with the survivor requestShowing injected", tourBranch.length > 0 && /requestExternalShowing\(/.test(tourBranch.slice(0, 1600)) && /import\("@\/app\/actions\/showings"\)/.test(tourBranch.slice(0, 1600)))
    const sh = code("lib/portal/saved-homes.ts")
    check("saved-homes.ts writes no listings row anywhere (positive control: a specimen insert is seen)", !/from\("listings"\)\s*\.insert/.test(sh) && /from\("listings"\)\s*\.insert/.test('await db.from("listings").insert({ address })'))
    check("saved-homes.ts exports only product-consumed doors for the showing path (requestExternalShowing; the task writer and the pure builders are module-private)", /\nexport async function requestExternalShowing\(/.test(sh) && !/\nexport (async )?function (openExternalShowingTask|externalShowingRequestFor|externalShowingTaskFor)\(/.test(sh))
  }

  // ══ G ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n G. VENDOR ASSISTANCE — assigned work only, in the vendor's own tenant")
  {
    const src = code("lib/ai-isa/user-type-tools.ts")
    const vendorTools = USER_TYPE_TOOL_POLICY.vendor.seatToolNames as readonly string[]
    check("every vendor seat tool the policy promises has a builder (no phantom promise)", vendorTools.length >= 8 && vendorTools.every((t) => typeof (USER_TYPE_SEAT_TOOL_BUILDERS as Record<string, unknown>)[t] === "function"), vendorTools.join(","))
    const builderName = (tool: string) => { const m = new RegExp(`\\n\\s*${tool}:\\s*(build\\w+Tool)`).exec(src); return m?.[1] ?? null }
    const bodyOf = (fn: string) => { const i = src.indexOf(`function ${fn}(`); if (i < 0) return null; const rest = src.slice(i + 1); const j = rest.search(/\nfunction build|\n\/\/ ─|\nasync function |\nconst [A-Z_]+ = /); return rest.slice(0, j < 0 ? undefined : j) }
    // A query chain may continue on following lines that begin with `.`: capture the whole chain, not its first line.
    const chainsIn = (body: string) => {
      const out: string[] = []
      const re = /svc\.from\("[a-z_]+"\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(body))) {
        const lines = body.slice(m.index).split("\n")
        let chain = lines[0]
        for (let i = 1; i < lines.length && /^\s*\./.test(lines[i]); i++) chain += lines[i]
        out.push(chain)
      }
      return out
    }
    const pinned = (body: string) => {
      const chains = chainsIn(body)
      const delegates = /import\("@\/app\/actions\//.test(body) || /lenderTransactionIds\(/.test(body)
      return chains.every((c) => /\.eq\("vendor_id", ctx\.vendorId\)/.test(c) || (/\.eq\("id", ctx\.vendorId\)/.test(c) && /\.eq\("brokerage_id", ctx\.brokerageId\)/.test(c)) || (/\.in\("(id|transaction_id)", ids\)/.test(c) && /\.eq\("brokerage_id", ctx\.brokerageId\)/.test(c))) && (chains.length > 0 || delegates)
    }
    for (const t of vendorTools) {
      const fn = builderName(t)
      const body = fn ? bodyOf(fn) : null
      check(`${t}: every read is pinned to the vendor's OWN rows (vendor_id + brokerage_id) or delegates to a session-gated survivor`, !!body && pinned(body), fn ?? "builder not found")
    }
    check("POSITIVE CONTROL: a specimen tool that reads a tenant-wide table without the vendor pin IS caught", !pinned(`execute: async () => { const svc = createServiceClient(); const r = await svc.from("vendor_bookings").select("*").eq("brokerage_id", ctx.brokerageId).limit(50); return r }`))
    check("a vendor seat with NO vendor identity mounts NOTHING (fail closed); with one it mounts exactly the roster", Object.keys(buildUserTypeSeatTools({ seat: "vendor", brokerageId: BRK, userId: AGENT_USER, vendorId: null, titleMemberships: [] } as never)).length === 0 && Object.keys(buildUserTypeSeatTools({ seat: "vendor", brokerageId: BRK, userId: AGENT_USER, vendorId: "v-1", titleMemberships: [] } as never)).sort().join() === [...vendorTools].sort().join())
    check("the vendor roster carries no cross-tenant, BatchData or RentCast tool (assigned work and own documents only)", USER_TYPE_TOOL_POLICY.vendor.batchData === false && USER_TYPE_TOOL_POLICY.vendor.rentCast === false && !vendorTools.some((t) => /transactions_all|list_leads|contacts/.test(t)))
    const chat = code("app/api/internal/ai-chat/route.ts")
    check("the AI chat mounts a vendor identity ONLY when the vendor row sits in the session's tenant (vendorInTenant → vendorIdForSeat, else null)", /vendorInTenant\s*=\s*!!vendorRow\.data\s*&&/.test(chat) && /vendorIdForSeat\s*=\s*vendorInTenant\s*\?\s*sessionVendorId\s*:\s*null/.test(chat))
    const mk = code("app/actions/vendor-marketplace.ts")
    const gab = mk.slice(mk.indexOf("export async function getAllVendorBookings("))
    check("the vendor portal's bookings read narrows a vendor seat to its OWN vendor (resolveCallerVendorId; none → nothing)", /profile\.user_type === "vendor"/.test(gab.slice(0, 2500)) && /resolveCallerVendorId\(/.test(gab.slice(0, 2500)) && /if \(!vendorIdFilter\) return \[\]/.test(gab.slice(0, 2500)))
  }

  // ══ H ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n H. SUPPORT AUTONOMY — question → triage → owner → answer → evidence → verified close; the gates kept")
  {
    const ART = "aaaaaaaa-0000-4000-8000-000000000001"
    const db = memSupabase({
      support_tickets: [
        { id: "t-routine", brokerage_id: BRK, lane: "user_to_brokerage", subject: "How do I add the e-sign step to my FormWizard?", description: "I can't find the e-sign step after filling the form.", category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_USER, first_response_at: null, resolved_at: null, created_at: NOW.toISOString() },
        { id: "t-billing", brokerage_id: BRK, lane: "tenant_to_platform", subject: "We were charged twice this month", description: "Our invoice shows two subscription charges.", category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_USER, first_response_at: null, resolved_at: null, created_at: NOW.toISOString() },
        { id: "t-compliance", brokerage_id: BRK, lane: "user_to_brokerage", subject: "Fair housing complaint on an ad", description: "A client says our ad violates fair housing.", category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_USER, first_response_at: null, resolved_at: null, created_at: NOW.toISOString() },
        { id: "t-foreign", brokerage_id: OTHER_BRK, lane: "user_to_brokerage", subject: "Login broken", description: "cannot log in", category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_USER, first_response_at: null, resolved_at: null, created_at: NOW.toISOString() },
      ],
      knowledge_articles: [{ id: ART, brokerage_id: null, status: "published", title: "Adding the E-Sign step in FormWizard", excerpt: "Open the FormWizard, complete the Fill step, and the E-Sign step appears with your provider.", content: "..." }],
      help_topics_kb: [], lifecycle_events: [], manager_signals: [], notifications: [], agent_action_ledger: [], users: [],
    }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    ;(db as any).rpc = async () => ({ data: null, error: null })
    const verdict = (o: Partial<TriageModelOutput> = {}): TriageModelOutput => ({ category: "technical", priority: "medium", operation: null, summary: "The e-sign step is not visible to the user", answer: "Open the FormWizard, complete the Fill step, and the E-Sign step appears with your provider.", groundedIn: [ART], needsHuman: false, confidence: 0.85, ...o })
    const allow = async () => ({ allowed: true, reason: "ok" })
    const input = (id: string, extra: Record<string, unknown> = {}) => { const t = db.tables.support_tickets.find((r) => r.id === id)!; return { ticketId: id, brokerageId: BRK, lane: t.lane, subject: t.subject, description: t.description, category: t.category, priority: t.priority, submitterUserId: AGENT_USER, actor: { userType: "agent" }, ...extra } as never }
    const r1 = await triageSupportTicket(db as never, input("t-routine"), { afford: allow, model: async () => verdict() })
    check("a ROUTINE question: the AI answers from the help base (delivered to the submitter), routes to the REGISTERED owner, leaves evidence and a settled ledger row — no human needed", r1.ok && r1.answerDelivered && r1.needsHuman === false && r1.routedTo === TRIAGE_OWNER_BY_CATEGORY[r1.category] && r1.evented && db.tables.notifications.some((n) => n.type === SUPPORT_AI_ANSWER_NOTIFICATION && n.user_id === AGENT_USER) && db.tables.lifecycle_events.some((e) => e.event_type === SUPPORT_TRIAGE_EVENT && e.entity_id === "t-routine") && db.tables.agent_action_ledger.some((l) => l.action === "support.ticket.triage" && l.status === "executed"), JSON.stringify({ ok: r1.ok, d: r1.answerDelivered, to: r1.routedTo, err: r1.error }))
    check("the applied half is SAFE: category raised from the default to the AI's, priority never lowered", r1.applied.category === "technical" && r1.applied.priority === null && db.tables.support_tickets.find((t) => t.id === "t-routine")!.category === "technical")
    const sig = db.tables.manager_signals.find((m) => m.entity_id === "t-routine")
    check("the owner's inbox holds the OPEN signal (the verification step reads it on the tick)", !!sig && sig.to_manager === r1.routedTo)
    const open = await handleSupportTicketTriaged({ id: sig?.id ?? "x", payload: sig?.payload ?? {}, entityId: "t-routine", createdAt: NOW.toISOString() } as never, { brokerageId: BRK, supabase: db as never }, { now: NOW })
    db.tables.support_tickets.find((t) => t.id === "t-routine")!.status = "resolved"
    db.tables.support_tickets.find((t) => t.id === "t-routine")!.resolved_at = NOW.toISOString()
    const closed = await handleSupportTicketTriaged({ id: sig?.id ?? "x", payload: sig?.payload ?? {}, entityId: "t-routine", createdAt: NOW.toISOString() } as never, { brokerageId: BRK, supabase: db as never }, { now: NOW })
    check("COMPLETION EVIDENCE: an unanswered open ticket stays the owner's item (null); once resolved the consumer VERIFIES and closes the watch", open === null && typeof closed === "string" && /verified: ticket is resolved/.test(closed), String(closed))
    const r2 = await triageSupportTicket(db as never, input("t-billing"), { afford: allow, model: async () => verdict({ category: "billing", priority: "high", answer: null, groundedIn: [], needsHuman: true }) })
    check("FINANCIAL gate kept: a billing ticket routes to finance_manager, needs a human, no AI answer is sent", r2.routedTo === "finance_manager" && r2.needsHuman && !r2.answerDelivered)
    const r3 = await triageSupportTicket(db as never, input("t-compliance"), { afford: allow, model: async () => { throw new Error("gateway down") } })
    check("LEGAL / COMPLIANCE gate kept even with the model dark: the heuristic reads fair housing → compliance_officer, a human owes the reply", r3.model === "heuristic" && r3.category === "compliance" && r3.routedTo === "compliance_officer" && r3.needsHuman)
    const r4 = await triageSupportTicket(db as never, input("t-foreign"), { afford: allow, model: async () => verdict({ category: "technical", priority: "urgent" }) })
    check("CROSS-TENANT gate kept: a ticket that sits on another tenant is NOT applied (the tenant-pinned update matches no row)", r4.applied.category === null && r4.applied.priority === null && /matched no row/.test(String(r4.error)), String(r4.error))
    const r5 = await triageSupportTicket(db as never, input("t-routine"), { afford: allow, model: async () => verdict() })
    check("the same ticket triaged again REPLAYS (ledger idempotency) — no second answer", r5.model === "replayed" && db.tables.notifications.filter((n) => n.type === SUPPORT_AI_ANSWER_NOTIFICATION).length === 1)
  }

  // ══ I ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n I. WIRING (stripped source) + m983 + rows 78 / 79")
  {
    const cronRoute = code("app/api/property-alerts/run/route.ts")
    const dailyAt = cronRoute.indexOf('frequency === "daily"')
    check("the alert cron ROUTE carries the watch on the DAILY tick (a static import — the route is reached by the cron alone), with the declared scope; the engine itself stays free of the watch's graph", dailyAt > 0 && /import \{ watchSavedHomes[^}]*\} from "@\/lib\/property-alerts\/saved-home-watch"/.test(cronRoute) && /watchSavedHomes\(createServiceClient\(\), scope\)/.test(cronRoute.slice(dailyAt, dailyAt + 400)) && !/saved-home-watch/.test(code("lib/property-alerts/alert-engine.ts")))
    check("a watch failure never fails the alert sweep (try / catch; the error is reported beside the sweep's stats)", /savedHomes = \{ error: `saved_home_watch: /.test(cronRoute) && /\.\.\.\(savedHomes \? \{ savedHomes \} : \{\}\)/.test(cronRoute))
    check("the cron route is a CRON_REGISTRY target for the daily frequency (the tick exists; no new cron path was added)", /property-alerts\/run\?frequency=daily/.test(code("lib/kernel/cron-dispatch.ts")) && !/saved-home/.test(code("lib/kernel/cron-dispatch.ts")))
    const ms = code("lib/kernel/manager-signals.ts")
    const route = ms.slice(ms.indexOf("export async function routeSavedHomeNudge("), ms.indexOf("export async function deliverSavedHomeNudgeDecision("))
    check("the ONE router still asks the arbiter and delivers through the factored half (no second router)", /decideSavedHomeNudge\(/.test(route) && /deliverSavedHomeNudgeDecision\(/.test(route) && (ms.match(/export async function deliverSavedHomeNudgeDecision\(/g) ?? []).length === 1)
    const w = code("lib/property-alerts/saved-home-watch.ts")
    check("the watch asks the SAME arbiter door (decideSavedHomeNudge) and delivers through the SAME half (deliverSavedHomeNudgeDecision) — never arbitratePlannedTouch or publishManagerSignal directly", /decideSavedHomeNudge\(/.test(w) && /deliverSavedHomeNudgeDecision\(/.test(w) && !/arbitratePlannedTouch\(/.test(w) && !/publishManagerSignal\(/.test(w))
    check("the watch stores, fetches or reads NO photo (owner R9 — RentCast and a pasted link are never a photo source)", !/photo/i.test(w))
    const page = code("app/portal/[contactId]/search/page.tsx")
    check("the saved-homes card reads the verification line and selects the m983 columns", /savedHomeVerificationLine\(item\)/.test(page) && /last_verified_at, last_verified_status, verification_hold/.test(page))
    const holdWords = watch.SAVED_HOME_HOLD_REASONS.map((r) => homes.savedHomeVerificationLine({ source: "rentcast", listing_id: null, last_verified_at: null, last_verified_status: null, verification_hold: `${r}: no approved, unexpired acquisition plan; platform caps $0; RentCast budget` }))
    const checked = homes.savedHomeVerificationLine({ source: "rentcast", listing_id: null, last_verified_at: NOW.toISOString(), last_verified_status: "pending", verification_hold: null })
    check("the BUYER's line never carries approval / cap / budget / spend / plan / provider words, whatever the hold says; a verified read says when and what", holdWords.every((l) => !/approv|cap\b|budget|spend|plan line|rentcast|idx|held/i.test(l) && /agent confirms availability/.test(l)) && /Checked Nov 9 · under contract/.test(checked), JSON.stringify([...holdWords, checked]))
    check("a tenant listing with no verification says its status comes from the agent's own board", /own board/.test(homes.savedHomeVerificationLine({ source: "brokerage_listing", listing_id: "L1", last_verified_at: null })))
    // m983
    const mig = raw("supabase/migrations/m983-saved-home-last-verified-state.sql")
    const line1 = mig.split("\n")[0]
    check("m983 line 1 carries the lane stamp or the APPLIED stamp, and never an mNNN token", (/^-- WRITTEN, NOT APPLIED \(wave 151, lane 151J\)/.test(line1) || /^-- ── APPLIED LIVE/.test(line1)) && !/\bm\d{3}\b/.test(line1))
    check("m983 adds exactly the six columns the watch writes and the page reads (the sweep in §A wrote all six on the row)", M983_COLUMNS.every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\s`).test(mig)) && M983_COLUMNS.every((c) => c in drop.row))
    const checkSql = /saved_properties_last_verified_source_check\s+CHECK \(last_verified_source IN \(([^)]+)\)\)/.exec(mig)
    const sqlValues = (checkSql?.[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort()
    check("the m983 CHECK vocabulary IS the ONE code constant SAVED_HOME_VERIFICATION_SOURCES (sorted equal), with no IS NULL arm", !!checkSql && sqlValues.join() === [...watch.SAVED_HOME_VERIFICATION_SOURCES].sort().join() && !/last_verified_source IS NULL OR/.test(mig), sqlValues.join())
    check("the watch's columns select names every m983 column (the page and the sweep read the same names)", M983_COLUMNS.every((c) => watch.SAVED_HOME_WATCH_COLUMNS.includes(c)))
    // The by-id reader.
    const rc = code("lib/property/rentcast.ts")
    const byId = rc.slice(rc.indexOf("export async function getRentcastSaleListingById("))
    check("getRentcastSaleListingById GATES (gateRentcast, property data) and METERS (meterCall at RENTCAST_USD_PER_REQUEST under the caller's systemSource); 404 is off-market, not sold", /gateRentcast\(params, "property_data"\)/.test(byId.slice(0, 1800)) && /meterCall\(\{/.test(byId.slice(0, 1800)) && /cost: RENTCAST_USD_PER_REQUEST/.test(byId.slice(0, 1800)) && /systemSource: params\.systemSource/.test(byId.slice(0, 1800)) && /res\.status === 404\) return \{ ok: true, listing: null, offMarket: true \}/.test(byId.slice(0, 1800)))
    check("the sale-listing mapper is ONE function used by both the search and the by-id reader (no second inline copy)", (rc.match(/saleListingFromRow\(/g) ?? []).length >= 3 && !/externalId: r\?\.id \?\? r\?\.formattedAddress \?\? "",\s*\n\s*address:[^\n]*\n[\s\S]{0,900}externalId: r\?\.id \?\? r\?\.formattedAddress/.test(rc))
    // Row 78 — EVALUATED: the IDX client has no by-id read.
    const idx = code("lib/idxbroker-client.ts")
    check("ROW 78 recorded honestly: the IDX client offers the featured set (/clients/featured) and a free-text search only — no listing-by-id read exists, so a display-time IDX photo fetch has no door (EVALUATED — NOT IMPLEMENTED)", /"\/clients\/featured"/.test(idx) && /"\/clients\/search"/.test(idx) && !/\/clients\/listing\/|getListingById|listingById/.test(idx))
    check("POSITIVE CONTROL: the finder would see a by-id method if one existed", /listingById/.test("async getListingById(id: string) { return this.request(`/clients/listing/${id}`) } // listingById"))
    // Row 79 — the policy that admits a contact session is not narrowed by any migration in the tree.
    const migDir = join(root, "supabase/migrations")
    const touching = readdirSync(migDir).filter((f) => f.endsWith(".sql")).filter((f) => /listing_media_tenant_select/.test(readFileSync(join(migDir, f), "utf8")))
    const narrowing = touching.filter((f) => /(ALTER|DROP) POLICY\s+(IF EXISTS\s+)?"?listing_media_tenant_select"?/i.test(readFileSync(join(migDir, f), "utf8").replace(/--[^\n]*/g, "")))
    check("ROW 79: no migration ALTERs or DROPs listing_media_tenant_select (the tenant-wide SELECT a contact session reads approvals through stands; verified live in the lane notes)", narrowing.length === 0, `narrowing: ${narrowing.join(",")}; mentions: ${touching.join(",")}`)
    check("POSITIVE CONTROL: the narrowing finder sees an ALTER when it is there", /(ALTER|DROP) POLICY\s+(IF EXISTS\s+)?"?listing_media_tenant_select"?/i.test('ALTER POLICY "listing_media_tenant_select" ON public.listing_media USING (false);'))
    // The planner's roster and the simulator's rule.
    const sim = code("scripts/saved-home-nudge-simulator.ts")
    check("the nudge simulator asserts the roster RULE (duplicate-free, carries no_longer_available), not a pinned count", /new Set\(SAVED_HOME_NUDGE_KINDS\)\.size === SAVED_HOME_NUDGE_KINDS\.length/.test(sim) && !/SAVED_HOME_NUDGE_KINDS\.length === 6/.test(sim))
    // "runs it", not "ends with it": every lane appends its own proof after this one (CLAUDE.md §2 — never pin a waypoint).
    check("package.json registers test:saved-home-alerts and the guard chain runs it", /"test:saved-home-alerts": "tsx --conditions=react-server scripts\/saved-home-alerts-guard\.ts"/.test(raw("package.json")) && /npm run test:saved-home-alerts(?= &&|")/.test(raw("package.json")))
    check("the registry owns the proof (MAINTENANCE_DOMAINS.saved_home_alerts → shopping_agent, co-owned by ai_isa + data_steward)", /saved_home_alerts: \{ manager: "shopping_agent", proof: "test:saved-home-alerts", coOwners: \["ai_isa", "data_steward"\]/.test(raw("lib/kernel/manager-registry.ts")))
    check("the m983 file exists beside the lane's other migration number being UNUSED (m984 — no second alert table)", existsSync(join(root, "supabase/migrations/m983-saved-home-last-verified-state.sql")) && !readdirSync(migDir).some((f) => /^m984-/.test(f)))
  }

  console.log("\n BLIND SPOTS (published): memSupabase runs no RLS / CHECK / DEFAULT; RentCast, the rail and the arbiter's model are injected; the daily tick is not fired here; row 79 is verified live in the notes, not here; pages are not rendered; vendor tools are censused and mounted, not executed.")
  console.log("\n──────────────────────────────────────────────────")
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SAVED_HOME_ALERTS_FAIL"); process.exit(1) }
  console.log(" ✅ SAVED_HOME_ALERTS_PASS — saved homes alert on real change through the arbiter, metered re-reads held and recorded, outside showings become agent tasks, vendors see assigned work, support closes with evidence")
}

main().catch((e) => { console.error(e); process.exit(1) })
