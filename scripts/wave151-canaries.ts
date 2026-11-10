#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fixtures and fake clients, the repo's proof idiom */
/**
 * scripts/wave151-canaries.ts — `npx tsx --conditions=react-server scripts/wave151-canaries.ts`
 *                                (wave 151, lane 151L — closing; key: test:wave151-canaries, chained LAST in `guard`)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DIRECTIVE'S REQUIRED CANARIES ("REQUIRED CANARIES AND PROOFS"), one canary per bullet GROUP — SaaS hierarchy ·
 * Access · Acquisition · Intelligence · Property and buyers · Communications and media · Transaction/finance · Legal
 * agreements and tenant integrations · Creative differentiation and learning · Engineering. Run on the INTEGRATED tree
 * (batch 1 + batch 2 + this lane). Every canary drives the lanes' REAL exported survivors on memSupabase with injected
 * provider seams (never a re-implementation), carries BOTH halves of a measurement (CLAUDE.md §2 — the built behaviour
 * holds on a well-formed input AND the forbidden outcome is refused / absent / counted), names its POSITIVE CONTROL (the
 * finder still sees the defect it was written for) and publishes its BLIND SPOT (the live-only part no in-memory run can
 * observe). A canary passes only when both halves pass.
 *
 * REUSE BY IMPORT (the brief): where a bullet is already covered by one of the wave-150 canaries (scripts/wave150-canaries.ts,
 * lane 150J2), that canary is RUN HERE BY IMPORT and named in the group's `reuses` — never rewritten. The wave-150 file exports
 * its roster and its seam (registerHooks on import: `server-only`, `next/cache`, the kernel emit, the service / session client
 * pointed at the hand-in client and at NOTHING by default) and runs its own main() only when it is the entry script.
 *
 * HONEST STATES: a capability a lane recorded as owner-held, sandbox-only, PARTIAL or WAITING_EXTERNAL is asserted AS THAT
 * STATE (the refusal, the dormant adapter, the held re-read, the draft banner) and marked "honest-state" — never a pass that
 * pretends it is live. Nothing here is a production-live statement (C42: CI green is never production-live).
 *
 * BLIND SPOTS (published beside every number): memSupabase enforces no CHECK / FK / RLS / storage policy / trigger; Supabase
 * Auth, Stripe, Twilio, Lob, Meta, Google, RentCast, Exa, BatchData, Tracerfy, DataZapp and Vercel are never called (each is a
 * stub or an injected seam); every model is scripted; React / HTTP routes are read as stripped source, not rendered or invoked;
 * the storage.objects policies (OWNER-SQL §F/§G/§M.1) and the four seed accounts (§I) are owner work no canary can see.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { WAVE150_CANARIES, withSvc, quiet, backgroundRejections, type Verdict } from "./wave150-canaries"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { LIVE_TABLES } from "./live-tables"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

const ROOT = process.cwd()
const raw = (p: string): string => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const code = (p: string): string => stripComments(raw(p))
/** Identifiers only — comments AND string contents blanked (a word inside prose is a mention, not wiring). */
const ident = (p: string): string => blankStrings(stripComments(raw(p)))
const rows = (c: MemClient | any, t: string): any[] => ((c as any).tables[t] ?? []) as any[]
const fnSlice = (src: string, head: string): string => { const i = src.indexOf(head); if (i < 0) return ""; const j = src.indexOf("\n}\n", i); return src.slice(i, j < 0 ? undefined : j) }
const before = (s: string, a: string, b: string): boolean => { const i = s.indexOf(a), j = s.indexOf(b); return i >= 0 && j >= 0 && i < j }
const w150 = (n: number) => { const c = WAVE150_CANARIES.find((x) => x.n === n); if (!c) throw new Error(`wave-150 canary ${n} is not in the imported roster`); return c }
/** Named halves: a red names the check that failed (evidence, not a bare boolean). */
const halves = (pos: Array<[string, boolean]>, neg: Array<[string, boolean]>) => ({ positive: pos.every(([, b]) => b), negative: neg.every(([, b]) => b), failing: [...pos, ...neg].filter(([, b]) => !b).map(([n]) => n) })
/** The wave-150 seam records every kernel emit (the stubbed emitKernelEvent) — the audit events a survivor writes land here, not in memSupabase. */
const seamEvents = (): unknown[] => ((globalThis as any).__W150?.events ?? []) as unknown[]

const NOW = new Date("2026-11-10T12:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()
const A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "bbbbbbbb-0000-4000-8000-00000000000b"
const V1 = "eeeeeeee-0000-4000-8000-0000000000v1", LS = "dddddddd-0000-4000-8000-00000000ls01", LS_O = "dddddddd-0000-4000-8000-00000000ls02"
const STORAGE = "https://x.supabase.co/storage/v1/object/public/listing-media"
const photo = (tenant: string, listing: string, name: string) => `${STORAGE}/${tenant}/${listing}/${name}`

interface Group { n: number; group: string; bullets: readonly string[]; reuses: ReadonlyArray<{ n: number; covers: string }>; positiveControl: string; blindSpot: string; run: () => Promise<Verdict> }
const GROUPS: Group[] = []
const canary = (g: Group) => GROUPS.push(g)

/** The access world — ONE tenant with an agent, a team lead and their team, a second tenant, a photographer with a confirmed listing booking. */
function accessWorld(): MemClient {
  return memSupabase({
    brokerages: [{ id: A, name: "Alpha Realty", plan_tier: "brokerage" }, { id: B, name: "Beta Realty", plan_tier: "brokerage" }],
    users: [
      { id: "u-a1", brokerage_id: A, user_type: "agent", location_id: null }, { id: "u-a2", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-tl", brokerage_id: A, user_type: "team_lead", location_id: null }, { id: "u-contact", brokerage_id: A, user_type: "contact", location_id: null },
      { id: "u-vendor", brokerage_id: A, user_type: "vendor", location_id: null }, { id: "u-ph", brokerage_id: A, user_type: "vendor", location_id: null },
      { id: "u-bb", brokerage_id: B, user_type: "broker", location_id: null },
    ],
    teams: [{ id: "t1", brokerage_id: A, name: "Harbor Team", team_lead_id: "u-tl", location_id: null, deleted_at: null, status: "active" }],
    agents: [
      { id: "ag-a1", user_id: "u-a1", brokerage_id: A, team_id: "t1" }, { id: "ag-a2", user_id: "u-a2", brokerage_id: A, team_id: null }, { id: "ag-tl", user_id: "u-tl", brokerage_id: A, team_id: "t1" },
    ],
    team_members: [], user_role_assignments: [],
    contacts: [
      { id: "c-a1", brokerage_id: A, agent_id: "ag-a1", team_id: "t1", location_id: null, first_name: "Ann", last_name: "Smith", email: "ann@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-a2", brokerage_id: A, agent_id: "ag-a2", team_id: null, location_id: null, first_name: "Anna", last_name: "Jones", email: "anna@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-b", brokerage_id: B, agent_id: null, team_id: null, location_id: null, first_name: "Ann", last_name: "Other", email: "ann@b.test", phone: null, city: "Dallas", deleted_at: null },
    ],
    leads: [
      { id: "l-pool", brokerage_id: A, agent_id: null, first_name: "Annie", last_name: "Pool", email: "pool@x.test", phone: null, city: "Austin", lead_stage: "new" },
      { id: "l-a1", brokerage_id: A, agent_id: "ag-a1", first_name: "Annabel", last_name: "Mine", email: "mine@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
    ],
    listings: [
      { id: LS, brokerage_id: A, agent_id: "ag-a1", team_id: null, location_id: null, address: "1 Lens Ln", city: "Austin", state: "TX", zip: "78702", status: "coming_soon", mls_number: "M7", deleted_at: null, photos: [] },
      { id: LS_O, brokerage_id: A, agent_id: "ag-a2", team_id: null, location_id: null, address: "2 Other St", city: "Austin", state: "TX", zip: "78703", status: "active", mls_number: "M8", deleted_at: null, photos: [] },
    ],
    transactions: [],
    vendors: [{ id: V1, brokerage_id: A, category: "photographer", name: "Lens & Light", access_level: "transaction_only" }],
    vendor_bookings: [{ id: "bk-ok", vendor_id: V1, brokerage_id: A, listing_id: LS, transaction_id: null, status: "confirmed", approval_status: null, service_type: "photography" }],
    listing_media: [], notifications: [], agent_action_ledger: [],
  })
}

/** The movement world (lane 151E's shape): one contact, every table the door touches, the C9 idempotency modelled. */
function movementWorld(): MemClient {
  return memSupabase({
    contacts: [{ id: "c1", brokerage_id: A, contact_type: "seller", agent_id: null, zip_code: "78701", deleted_at: null, opted_out_at: null, timeline: null, equity_estimate: 150000, home_owner_status: "owner", metadata: null, enrichment_profile: null }],
    movement_signals: [], agent_action_ledger: [], ai_predictions: [], listings: [], transactions: [], leads: [], raw_scraped_leads: [], buyer_financial_profiles: [], ai_tool_usage: [], vendor_spend: [],
  } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } })
}
const movementDeps = (respondCalls: unknown[][] = []) => ({
  now: NOW, windowDays: 180,
  decide: (async () => { throw new Error("no model in a canary") }) as never,
  publish: (async () => ({ ok: true })) as never,
  respond: (async (...a: unknown[]) => { respondCalls.push(a); return { action: "recorded" } }) as never,
  routeToAgent: (async () => true) as never,
  notifyAdmins: (async () => 0) as never,
})

/** The moment helpers (the wave-150 canary 6 shape — the same survivors, the same observation vocabulary). */
async function momentKit() {
  const mm = await import("../lib/intent/moving-moments")
  const od = await import("../lib/intent/opportunity-discovery")
  let seq = 0
  const o = (sourceKey: string, relevance: string, confidence: string, extra: Record<string, unknown> = {}) => ({ id: `o${++seq}`, sourceKey, relevance, confidence, identity: "record_key", observedAt: daysAgo(3), outreach: "consent_gated", rights: "first_party", ...extra }) as any
  const buyerObs = () => [o("fp_inbound_stated", "relocation", "reported", { intents: ["home_purchase"], side: "buyer" }), o("fp_saved_homes", "property_event", "verified")]
  const moment = (obs: any[], facts: Record<string, unknown> = {}): any => mm.buildMovingMoment(od.readOpportunities(obs, { now: NOW }), obs, { subjectIsPerson: true, ...facts } as never, { now: NOW })
  return { mm, od, o, buyerObs, moment }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 — SaaS hierarchy
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 1, group: "SaaS hierarchy",
  bullets: ["solo-agent tenant onboarding", "independent team with assigned users/seats", "brokerage office with teams and agents", "multi-location brokerage with cross-office membership and isolation", "seat count obeys the subscribed tier", "brokerage adoption with explicit permission and no duplicate billing"],
  reuses: [{ n: 1, covers: "solo (staff + self), team, brokerage and two same-name locations all provision; a string name never merges (adoption needs the subject's own consent — the roster canary brokerage-adoption, test:canaries, covers the billing handoff)" }],
  positiveControl: "the band is READ from the catalogue (TIER_SEAT_BANDS): the verdict's bandLimit equals the catalogue number, and the catalogue orders solo < team < brokerage",
  blindSpot: "Supabase Auth invites and Stripe proration are injected seams; RLS on organization_members is not exercised; the seat gate's live catalogue read (seatGate → catalog_unreadable fails closed) is the lane proof test:subscriber-provisioning J9, not this canary",
  run: async () => {
    const trm = await import("../lib/kernel/tier-role-matrix")
    const pc = await import("../lib/billing/plan-catalog")
    const band = pc.TIER_SEAT_BANDS
    const under = trm.seatDecision("team", (band.team ?? 0) - 1), over = trm.seatDecision("team", band.team ?? 0), multi = trm.seatDecision("multi_location", 500)
    const noPrice = !/\$\s?\d|price|usd/i.test(JSON.stringify(over))
    return {
      positive: under.withinLimit && under.bandLimit === band.team && multi.withinLimit && multi.bandLimit === null && (band.solo_agent ?? 0) < (band.team ?? 0) && (band.team ?? 0) < (band.brokerage ?? 0),
      negative: !over.withinLimit && over.upgradeTo === "brokerage" && over.upgradeSeats === band.brokerage && over.limit === band.team && noPrice,
      detail: JSON.stringify({ under: { withinLimit: under.withinLimit, bandLimit: under.bandLimit }, over: { withinLimit: over.withinLimit, upgradeTo: over.upgradeTo, upgradeSeats: over.upgradeSeats, limit: over.limit }, multi: { withinLimit: multi.withinLimit, bandLimit: multi.bandLimit } }),
      note: `bands solo ${band.solo_agent} · team ${band.team} · brokerage ${band.brokerage} · multi ${band.multi_location ?? "∞"}; the producer past the band is refused and told the next tier, no price`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — Access
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 2, group: "Access",
  bullets: ["agents do not see the raw Lead queue", "team leaders see only authorized team Contacts", "contacts see their own portal data", "vendors see assigned records only", "assigned photographer can upload approved listing photos", "lender is a vendor specialization", "cross-tenant/global-search reads refuse unauthorized data"],
  reuses: [{ n: 2, covers: "cross-tenant / cross-location isolation negative-tested (search autocomplete, contacts, raw leads, offices, seat views)" }],
  positiveControl: "teamContactOrFilter({ kind: 'none' }) is an IMPOSSIBLE filter (never 'no filter'); a brokerage scope is null; a foreign tenant's listing folder and a missing attestation are each refused by name by the delivery writer",
  blindSpot: "memSupabase has NO RLS: m963 / m964 / m965 are judged from their policy text by test:access-matrix against the 2026-11-09 live catalogue; the storage.objects RESTRICTIVE rows for listing-media (OWNER-SQL §M.1) are owner SQL and NOT applied — the PUT itself is still ungated at storage; the vendor jobs page and the review UI are not rendered",
  run: async () => {
    const lv = await import("../lib/auth/lead-visibility")
    const search = await import("../lib/search/scoped-record-search")
    const photos = await import("../lib/listings/owner-photo-upload")
    const lender = await import("../lib/kernel/lender-linkage")
    const db = accessWorld()
    const agentVis: any = await lv.resolveLeadVisibility(db as never, { userId: "u-a1", userType: "agent", platformRole: null, brokerageId: A } as never)
    const agentNoQueue = !agentVis.allowed || !["platform", "brokerage", "tenant"].includes(String(agentVis.scope?.kind ?? ""))
    const tl: any = await lv.resolveTeamLeadContactScope(db as never, { userId: "u-tl", brokerageId: A })
    const filter = tl.ok ? lv.teamContactOrFilter(tl.scope) : null
    const hitIds = (r: any): string[] => (r && r.ok ? Object.values(r).flatMap((v: any) => (Array.isArray(v) ? v.map((h: any) => String(h.id)) : [])) : [])
    const tlSearch: any = await quiet(() => search.searchScopedRecords(db as never, { userId: "u-tl", brokerageId: A, userType: "team_lead", platformRole: null }, "Ann"))
    const tlIds = hitIds(tlSearch)
    const contactSearch: any = await quiet(() => search.searchScopedRecords(db as never, { userId: "u-contact", brokerageId: A, userType: "contact", platformRole: null }, "Ann"))
    const vendorSearch: any = await quiet(() => search.searchScopedRecords(db as never, { userId: "u-vendor", brokerageId: A, userType: "vendor", platformRole: null }, "Ann"))
    const att = { accepted: true, version: (photos as any).PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION }
    const delivered: any = await quiet(() => photos.recordPhotographerDelivery(db as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS, "front.jpg")], attestation: att }))
    const media = rows(db, "listing_media")
    const foreign: any = await quiet(() => photos.recordPhotographerDelivery(db as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(B, LS, "x.jpg")], attestation: att }))
    const otherListing: any = await quiet(() => photos.recordPhotographerDelivery(db as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_O, "x.jpg")], attestation: att }))
    const noAtt: any = await quiet(() => photos.recordPhotographerDelivery(db as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS, "y.jpg")], attestation: null }))
    const userTypes = (CHECK_VOCABULARIES as any).users?.user_type as string[]
    const m965 = raw("supabase/migrations/m965-vendor-seats-read-only-their-assigned-work.sql")
    // The team lead is a LEAD-DESK seat (LEAD_DESK_USER_TYPES): its lead read is the lead rule's (team scope + the unassigned pool) and is
    // not asserted here — the bullet is CONTACTS. The contacts it sees are its team's only.
    const h = halves([
      ["team-lead scope is the led team + its agents", tl.ok && tl.scope.kind === "team" && tl.scope.teamIds.includes("t1") && tl.scope.agentIds.includes("ag-a1") && !!filter && /t1/.test(filter) && /ag-a1/.test(filter)],
      ["the team lead's search finds its team's contact", tlSearch?.ok === true && tlIds.includes("c-a1")],
      ["the assigned photographer's delivery is recorded for review with provenance", delivered?.ok === true && media.length === 1 && media[0].photo_source === "vendor_delivery" && media[0].is_approved === false && media[0].uploaded_by === "u-ph"],
      ["lender is a vendor category", lender.isLenderVendorCategory("lender") && (lender.LENDER_BENCH_CATEGORIES as readonly string[]).includes("refinance_lender")],
    ], [
      ["an agent is refused the lead queue", agentNoQueue],
      ["the team lead never sees the off-team contact or the foreign tenant's", !tlIds.includes("c-a2") && !tlIds.includes("c-b")],
      ["a contact seat and a vendor seat are refused the search", contactSearch?.ok === false && vendorSearch?.ok === false],
      ["the team filter excludes the off-team agent; 'none' is impossible, 'brokerage' is null (positive control)", !filter?.includes("ag-a2") && lv.teamContactOrFilter({ kind: "none", brokerageId: A }) !== null && lv.teamContactOrFilter({ kind: "brokerage", brokerageId: A, via: "tenant_principal" }) === null],
      ["a foreign folder, another listing's folder and a missing attestation are refused by name; nothing extra recorded", foreign?.ok === false && foreign.refusal === "path" && otherListing?.ok === false && otherListing.refusal === "path" && noAtt?.ok === false && noAtt.refusal === "attestation" && media.length === 1],
      ["no lender user type anywhere: the live CHECK and the resolver", !lender.isLenderVendorCategory("photographer") && Array.isArray(userTypes) && !userTypes.includes("lender") && userTypes.includes("vendor")],
      ["m965 narrows vendor reads to assigned work (the lender rail's vendor_assignments)", /vendor_has_transaction_access/.test(m965) && /vendor_assignments/.test(m965)],
    ])
    return {
      ...h,
      detail: JSON.stringify({ failing: h.failing, agentVis, tl, filter, tlIds, contactSearch: contactSearch?.ok, vendorSearch: vendorSearch?.ok, delivered, foreign: foreign?.refusal, otherListing: otherListing?.refusal, noAtt: noAtt?.refusal, media: media.map((m) => ({ s: m.photo_source, a: m.is_approved })) }).slice(0, 1800),
      note: `agent: ${agentVis.allowed ? `allowed, scope ${agentVis.scope?.kind}` : `refused (${agentVis.reason ?? agentVis.status})`}; team lead sees contacts ${tlIds.filter((i) => i.startsWith("c-")).join(", ") || "none"} (its lead-desk lead read is the lead rule's); photographer delivery recorded for review (is_approved false); users.user_type CHECK has no 'lender'`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — Acquisition
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 3, group: "Acquisition",
  bullets: ["fresh eligible provider records enter one RawData door", "stale observations are handled by their actual age/type", "existing duplicates do not create new people", "Exa discovered candidate uses grounded identity and source evidence", "provider unavailability does not corrupt the pipeline", "acquisition scoped to the tenant's territories and ordinary subscription capability", "platform acquisition spend capped and recorded; no per-lead fee", "pre-pull and ingress dedup prevent duplicate expense and assignment"],
  reuses: [{ n: 3, covers: "ten replayed acquisition events → ONE observation through THE ONE producer; ≤ 1 paid lookup; per-tenant research" }, { n: 4, covers: "verified owner may become a Lead; anonymous article → topic only; consented form → ONE Contact" }],
  positiveControl: "the same dedup plan against EMPTY known sets buys every candidate and publishes judgedAgainst = 0 (a dedup against nothing is not a dedup); the identifier finder sees a planted perLeadFee",
  blindSpot: "no provider is called (BatchData / Exa / Tracerfy keys are deleted at import); env presence is INJECTED facts, never read; the owner has NOT set the platform caps, so every platform-paid pull refuses by design today; the territory budget is a fixture number",
  run: async () => {
    const fr = await import("../lib/lead-pipeline/freshness")
    const dd = await import("../lib/lead-pipeline/pre-pull-dedup")
    const sid = await import("../lib/identity/subject-identity")
    const sdp = await import("../lib/lead-pipeline/source-discovery-planner")
    const pp = await import("../lib/lead-pipeline/pooled-pull")
    const caps = await import("../lib/vendor-governance/platform-acquisition-caps")
    const con = await import("../lib/acquisition-plays/contract")
    const nowMs = NOW.getTime()
    const old = fr.evaluateFreshness({ source: "reddit_relocation", signalAt: daysAgo(7 * 365), observedAt: NOW.toISOString(), now: nowMs } as never)
    const fresh = fr.evaluateFreshness({ source: "reddit_relocation", signalAt: daysAgo(3), observedAt: NOW.toISOString(), now: nowMs } as never)
    const deed = fr.evaluateFreshness({ source: "batchdata_motivated", intentSignals: ["deed_transfer"], subjectKind: "property", signalAt: daysAgo(400), observedAt: NOW.toISOString(), now: nowMs } as never)
    const owner = fr.evaluateFreshness({ source: "batchdata_motivated", signalAt: daysAgo(2000), observedAt: NOW.toISOString(), lastVerifiedAt: daysAgo(10), now: nowMs } as never)
    const knownKeys = sid.subjectIdentityKeys({ email: "known@x.test", phone: null, apn: null, countyFips: null, propertyAddress: null, zip: null, ownerName: null, lastName: null, mailingAddress: null, state: null } as never)
    const known = { sourceRecordIds: new Set(["batchdata_motivated|r1"]), personKeys: new Set(knownKeys), propertyKeys: new Set<string>(), priorProviderResults: new Map(), scope: { brokerageId: A, includesPlatformPool: false } }
    const empty = { sourceRecordIds: new Set<string>(), personKeys: new Set<string>(), propertyKeys: new Set<string>(), priorProviderResults: new Map(), scope: { brokerageId: A, includesPlatformPool: false } }
    const candidates = [
      { ref: "seen", source: "batchdata_motivated", sourceRecordId: "r1", email: "seen@x.test" },
      { ref: "person", source: "batchdata_motivated", sourceRecordId: "r2", email: "known@x.test" },
      { ref: "new", source: "batchdata_motivated", sourceRecordId: "r3", email: "new@x.test" },
    ]
    const plan = dd.planPrePullDedup(candidates as never, known as never, { lookupKind: "person", now: NOW })
    const control = dd.planPrePullDedup(candidates as never, empty as never, { lookupKind: "person", now: NOW })
    const facts = { vendor: "batchdata", configured: false, credentialNames: ["BATCHDATA_API_KEY"], activation: "dormant_survivor", survivorDoors: "owner_confirmation_pending", monthlyBudgetUsd: 100, remainingBudgetUsd: 100 }
    const closed = sdp.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: A, plans: [], platform: facts as never, tenant: null, now: NOW })
    const open = sdp.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: A, plans: [], platform: { ...facts, configured: true } as never, tenant: null, now: NOW })
    const exhausted = sdp.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: A, plans: [], platform: pp.withTerritoryBudget({ ...facts, configured: true } as never, { monthly_budget_usd: 50, spend_this_month: 50 }), tenant: null, now: NOW })
    const noCaps = caps.decidePlatformAcquisitionSpend({ caps: null, platformSpentMonthUsd: 0, tenantSpentMonthUsd: 0, wantUsd: 5 })
    // per_pull 50 so the PER-TENANT cap is the binding ceiling in the arithmetic below (per_pull binds at 10 — lane proof test:spend-backpressure)
    const capsRow = { monthly_usd: 100, per_tenant_monthly_usd: 20, per_pull_usd: 50, set_by: "owner", set_at: daysAgo(1) }
    const withinCaps = caps.decidePlatformAcquisitionSpend({ caps: capsRow, platformSpentMonthUsd: 10, tenantSpentMonthUsd: 2, wantUsd: 5 })
    const ledger = [{ brokerage_id: A, total_cost: 3, request_metadata: { system_source: "lead_scraping" }, created_at: daysAgo(2) }, { brokerage_id: B, total_cost: 1, request_metadata: { system_source: "lead_scraping" }, created_at: daysAgo(2) }]
    const perTenant = caps.platformCapRemainingFromLedger(capsRow, ledger, A)
    const otherTenant = caps.platformCapRemainingFromLedger(capsRow, ledger, B)
    const feeIdents = ident("lib/vendor-governance/platform-acquisition-caps.ts") + ident("lib/providers/tenant-provider-connections.ts") + ident("lib/lead-pipeline/source-discovery-planner.ts")
    const FEE = /per_?lead_?(fee|charge|price)|qualified_lead_release|platform_sourced_leads_opt_in/i
    const grounded = con.personCandidateProblem({ statement: { firstPerson: true, requestsAgentContact: true, quote: "Looking for an agent in Pace — email me at a@b.co" }, identity: { basis: "published_contact", email: "a@b.co" }, rights: { publishedContactPermitted: true, sourceClass: "classifieds" } as never, publishedAt: daysAgo(5) }, NOW)
    const forum = con.personCandidateProblem({ statement: { firstPerson: true, requestsAgentContact: true, quote: "DM me, looking for a realtor" }, identity: { basis: "published_contact", email: "a@b.co" }, rights: { publishedContactPermitted: false, sourceClass: "forum" } as never, publishedAt: daysAgo(5) }, NOW)
    const nameOnly = con.personCandidateProblem({ statement: { firstPerson: true, requestsAgentContact: true, quote: "need an agent" }, identity: { basis: "name_only", name: "J. Doe" }, rights: { publishedContactPermitted: true, sourceClass: "classifieds" } as never, publishedAt: daysAgo(5) }, NOW)
    const third = con.personCandidateProblem({ statement: { firstPerson: false, requestsAgentContact: true, quote: "my neighbor wants an agent" }, identity: { basis: "published_contact", email: "a@b.co" }, rights: { publishedContactPermitted: true, sourceClass: "classifieds" } as never, publishedAt: daysAgo(5) }, NOW)
    const h = halves([
      ["a 3-day post is fresh; an owner record ages from its verification", fresh.verdict === "fresh" && !fresh.hold && owner.verdict === "fresh" && owner.anchor === "last_verified_at"],
      ["pre-pull dedup buys only the unknown person (known source id + known person skipped)", plan.buy.map((c) => c.ref).join() === "new" && plan.byReason.known_source_id === 1 && plan.byReason.known_person === 1 && plan.judgedAgainst.personKeys === knownKeys.length],
      ["a configured, licensed platform provider within budget opens the door with NO plan line", open.allowed && open.door === "platform_provider" && open.paid && typeof open.planId === "string"],
      ["caps: a want within every cap proceeds; each tenant reads ITS remainder from one ledger", withinCaps.action === "proceed" && perTenant.remainingUsd === 17 && otherTenant.remainingUsd === 19],
      ["a first-person request with a published contact point on a permitted page may become a person", grounded === null],
    ], [
      ["a 7-year-old post is stale (held, never intent); an old deed is HISTORY (kept, held)", old.hold && old.verdict === "stale" && !old.intentFresh && deed.propertyHistory && deed.verdict === "history" && deed.hold && deed.signalClass === "ownership_transfer"],
      ["an unconfigured provider → unavailable, naming the env NAME and never a value", !closed.allowed && closed.door === "unavailable" && /BATCHDATA_API_KEY/.test(closed.reason) && !/[A-Za-z0-9]{32,}/.test(closed.reason)],
      ["an exhausted territory budget refuses", !exhausted.allowed && /budget/i.test(exhausted.reason)],
      ["null caps → refuse + escalate; no per-lead fee identifier anywhere (finder sees a planted one)", noCaps.action === "refuse" && noCaps.escalate && !FEE.test(feeIdents) && FEE.test("const perLeadFee = 1")],
      ["(positive control) empty known sets buy everything and publish judgedAgainst 0", control.buy.length === 3 && control.judgedAgainst.personKeys === 0],
      ["a forum poster, a name-only join and a third party's mention never become a person", forum !== null && /terms/.test(forum) && nameOnly !== null && third !== null],
    ])
    return {
      ...h,
      detail: JSON.stringify({ failing: h.failing, old: old.verdict, deed: [deed.verdict, deed.signalClass], owner: [owner.verdict, owner.anchor], plan: plan.byReason, control: control.byReason, closed: closed.reason, open: [open.door, open.allowed, open.planId], exhausted: exhausted.reason, noCaps: noCaps.action, perTenant: perTenant.remainingUsd, otherTenant: otherTenant.remainingUsd, grounded, forum, nameOnly, third }).slice(0, 1800),
      note: `freshness: 7-year post ${old.verdict}, old deed ${deed.verdict} (history, kept), owner record anchored on ${owner.anchor}; pre-pull dedup bought 1 of 3; the door: unconfigured → unavailable naming the env NAME only, configured → platform_provider, exhausted budget → refused; caps null → refuse; per tenant $${perTenant.remainingUsd} vs $${otherTenant.remainingUsd}`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 — Intelligence
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 4, group: "Intelligence",
  bullets: ["contact type does not invent intent", "a person's own statements take priority over speculative enrichment", "provider scores retain actual semantics", "the decision window contains evidence and uncertainty", "refinance / relocation / buying / selling signals reach the correct manager/arbiter", "no automatic intrusive outreach on sensitive inferred circumstances"],
  reuses: [{ n: 6, covers: "desire without feasibility ≠ ready; a documented lease end narrows the window; anonymous topic predicts nobody; mixed evidence → UNKNOWN" }],
  positiveControl: "the identifier finder sees `facts.contactType` on a specimen; the SAME negative with basis 'observed' and older than the positives does NOT contradict (rule 3), so the person-stated contradiction is the rule, not the age",
  blindSpot: "the model is never called (the decision seam throws; the frame is read structurally); calibration has no cohort past 50 validated outcomes, so no probability exists anywhere to compare; the live memory ledger (contacts.metadata.context_spine.facts) is a fixture here",
  run: async () => {
    const { mm, od, o, buyerObs, moment } = await momentKit()
    const mv = await import("../lib/intent/movement-signals")
    const arb = await import("../lib/ai-isa/followup-arbiter")
    const momentIdents = ident("lib/intent/moving-moments.ts")
    // Rule 7: the positives here are PROVIDER / inferred (an enrichment reading), so the person's older "staying put" is the newest word
    // the PERSON spoke. A verified first-party action (a saved home) would itself be the person's newer statement — a different case.
    const providerObs = () => [o("po_online_real_estate_activity", "property_event", "inferred", { intents: ["home_sale"], side: "seller" })]
    const stay = moment(providerObs(), { statedSide: "seller", negative: [{ key: "stay_put", why: "we're staying put", at: daysAgo(40), source: "memory_ledger:person_words", basis: "person_stated" }] })
    const observedOld = moment(providerObs(), { statedSide: "seller", negative: [{ key: "declined", why: "an old decline", at: daysAgo(40), source: "movement_signals:x", basis: "observed" }] })
    const scored = moment(buyerObs(), { statedSide: "buyer", vendorScores: [{ provider: "batchdata", field: "salePropensity", value: 92 }] })
    const plain = moment(buyerObs(), { statedSide: "buyer" })
    const ready = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", inventory: "available", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    const f = ready.forecast
    const dims = Object.keys(ready.dimensions ?? {}).sort().join()
    const classes = mm.EVIDENCE_CLASSES as readonly string[]
    const db = movementWorld()
    const respondCalls: unknown[][] = []
    const r1: any = await withSvc(db, () => quiet(() => mv.reassessExistingContact(db as never, { brokerageId: A, contactId: "c1", change: { kind: "valuation_request", referenceId: "v1", summary: "asked what their home is worth", at: daysAgo(1) } }, movementDeps(respondCalls) as never)))
    const msCode = code("lib/intent/movement-signals.ts"), arbCode = code("lib/ai-isa/followup-arbiter.ts")
    const briefs = JSON.stringify(mm.readinessPlays(ready, od.opportunityMenu(od.readOpportunities(buyerObs(), { now: NOW }), { persona: null } as never), od.readOpportunities(buyerObs(), { now: NOW })))
    const h = halves([
      ["the person's own older 'staying put' contradicts a newer provider positive → window UNKNOWN, named as their own words", stay.decision_window.window === "unknown" && /own words/.test(stay.decision_window.why)],
      ["the forecast carries counted evidence classes, uncertainty, timestamps and an UNPUBLISHED calibration", !!f && f.state === "window" && typeof f.evidenceClasses.verified_intent === "number" && f.calibration.published === false && !!f.uncertainty && !!f.sourceTimestamps.newestPositive],
      ["five dimensions, each with an evidence class", dims === "confidence,desire,expectation,feasibility,timing" && Object.values(ready.dimensions).every((d: any) => classes.includes(d.evidenceClass) || d.evidenceClass === "none")],
      ["refinance / moving / buying / selling types reach the ONE responder; refinance → a lender introduction (RESPA)", ["refinance_opportunity", "moving_intent", "buying_intent", "home_sale_interest"].every((t) => msCode.includes(t)) && /RESPA/i.test(arbCode)],
      ["an existing contact's change is reassessed on the SAME contact", ["reassessed", "recorded_no_decision"].includes(r1?.status) && r1.newLeadCreated === false && r1.providerCalls === 0 && rows(db, "movement_signals").length === 1],
    ], [
      ["contact_type feeds nothing in the moment (finder sees a specimen)", !/contact_type|contactType/.test(momentIdents) && /contact_type|contactType/.test("facts.contactType ?? row.contact_type")],
      ["(positive control) the SAME negative as an OBSERVED record older than the positive is history, not the person's words", !/own words/.test(observedOld.decision_window.why)],
      ["a vendor score moves no dimension LEVEL or class, is labelled in its own unit and carries probability null", JSON.stringify(Object.values(scored.dimensions).map((d: any) => [d.dimension, d.level, d.evidenceClass])) === JSON.stringify(Object.values(plain.dimensions).map((d: any) => [d.dimension, d.level, d.evidenceClass])) && scored.vendor_scores?.length === 1 && scored.vendor_scores[0].probability === null && /BatchRank|vendor scale/i.test(scored.vendor_scores[0].unit ?? scored.vendor_scores[0].label ?? "") && !/"probability":\s*0?\.\d/.test(JSON.stringify(scored))],
      ["the arbiter's brief in words: a sensitive inferred life event is never named; no default cadence or drip", /sensitive inferred life event/i.test(arb.ARBITER_SYSTEM) && /no default cadence|NO default cadence/i.test(arb.ARBITER_SYSTEM)],
      ["the outward play briefs (lane proof test:readiness-dimensions §H holds the never-mention rule on an eligible brief); here a non-held subject yields NO eligible outreach play", /not_eligible/.test(briefs) && !/"status":"eligible","why":"[^"]*","brief":"[^"]*(score|probability)/i.test(briefs)],
      ["no Lead, no raw row from an existing contact's change", rows(db, "leads").length === 0 && rows(db, "raw_scraped_leads").length === 0],
    ])
    return {
      ...h,
      detail: JSON.stringify({ failing: h.failing, stay: stay.decision_window, observedOld: observedOld.decision_window, forecast: f ? { state: f.state, verdict: f.verdict, classes: f.evidenceClasses, calibration: f.calibration } : null, dims, r1: { status: r1?.status, reason: r1?.reason, newLeadCreated: r1?.newLeadCreated, providerCalls: r1?.providerCalls }, respondCalls: respondCalls.length, briefs: briefs.slice(0, 300) }).slice(0, 2200),
      note: `the person's "staying put" → window ${stay.decision_window.window}; a vendor score moves no dimension and carries probability null; forecast ${f?.state} / ${f?.verdict}, calibration published ${f?.calibration.published}; an existing contact's change → ${r1?.status} on the SAME contact (0 leads, 0 provider calls)`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 — Property and buyers
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 5, group: "Property and buyers",
  bullets: ["RentCast sold-property records and market listing trends are distinguished", "IDX/MLS and RentCast results are correctly labeled", "saved-home alerts use actual change data", "family collaboration only shares selected homes", "buyer selects own lot/acreage requirements"],
  reuses: [{ n: 7, covers: "2-acre + 25-minute buyer: only licensed active homes proving both, or a kind shortage; family feedback scoped to the shared home, never a lead" }, { n: 17, covers: "ZIP trend labels LISTING asking prices; one shared provider read per authorized refresh" }],
  positiveControl: "a FIRST read of a saved home is a BASELINE (no alert); the same state swept again announces nothing; rentcastPriceBasis('listing_records') is last_list_price (the collapse the directive names is refused by the table itself)",
  blindSpot: "RentCast, the capability rail and the arbiter's model are injected (the tenant-listing source needs no provider); the IDX saved-home re-read is HELD by name (no listing-by-id read exists in lib/idxbroker-client.ts — lane 150Z row 78); the daily cron tick is not fired here",
  run: async () => {
    const mc = await import("../lib/market-reports/contract")
    const ls = await import("../lib/property/listing-source")
    const els = await import("../lib/property/external-listings-search")
    const watch = await import("../lib/property-alerts/saved-home-watch")
    const ts = await import("../lib/kernel/tenant-scope")
    const BUYER = "33333333-3333-4333-8333-333333333333", AG = "66666666-6666-4666-8666-666666666666", AGU = "55555555-5555-4555-8555-555555555555"
    const says = (optionId: string) => async () => ({ optionId, channel: null, format: null, waitHours: null, rationale: `The evidence supports ${optionId} for this buyer right now.`, evidence: ["moment"], confidence: 0.9 })
    const seed = (listingPrice: number | null, prev: { status: string; price: number } | null) => memSupabase({
      brokerages: [{ id: A, name: "Lone Star Realty", state: "TX" }], brokerage_settings: [],
      contacts: [{ id: BUYER, brokerage_id: A, first_name: "Dana", last_name: "Reyes", email: "dana@example.com", agent_id: AG, last_contacted_at: daysAgo(5) }],
      agents: [{ id: AG, brokerage_id: A, user_id: AGU }],
      listings: listingPrice === null ? [] : [{ id: "L1", brokerage_id: A, status: "active", lifecycle_stage: null, list_price: listingPrice, mls_number: "A1", deleted_at: null }],
      saved_properties: [{ id: "sp", brokerage_id: A, contact_id: BUYER, listing_id: "L1", source: "brokerage_listing", property_address: "12 Elm St", city: "Frisco", list_price: prev?.price ?? 500000, dismissed: false,
        last_verified_at: prev ? daysAgo(1) : null, last_verified_status: prev?.status ?? null, last_verified_price: prev?.price ?? null, last_verified_mls_number: prev ? "A1" : null, last_verified_source: prev ? "tenant_listing" : null, verification_hold: null }],
      acquisition_plans: [], vendor_usage_tracking: [], agent_action_ledger: [], lifecycle_events: [], manager_signals: [], notifications: [], activities: [], tasks: [],
    }, { stampCreatedAt: true, uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    const deps = { now: NOW, unitUsd: 0.074, decide: says("written_note") as never }
    // The audit event (SAVED_HOME_ALERT_EVENT) is emitted through the kernel emit, which the seam STUBS and records — read it there.
    const alertEvents = () => seamEvents().filter((e) => JSON.stringify(e).includes(watch.SAVED_HOME_ALERT_EVENT))
    const ev0 = alertEvents().length
    const first = seed(500000, null)
    const s1 = await quiet(() => watch.watchSavedHomes(first as never, ts.tenantScope(A, "canary"), deps))
    const ev1 = alertEvents().length
    const drop = seed(480000, { status: "active", price: 500000 })
    const s2 = await quiet(() => watch.watchSavedHomes(drop as never, ts.tenantScope(A, "canary"), deps))
    const ev2 = alertEvents()
    const s3 = await quiet(() => watch.watchSavedHomes(drop as never, ts.tenantScope(A, "canary"), { ...deps, now: new Date(NOW.getTime() + 86_400_000) }))
    const ev3 = alertEvents().length
    const elsCode = code("lib/property/external-listings-search.ts")
    const h = halves([
      ["RentCast sold records = recorded sales; listing statistics / listing records = asking prices (ONE table, ONE basis rule)", mc.rentcastPriceBasis("sold_records") === "recorded_sale" && mc.rentcastPriceBasis("property_record") === "recorded_sale" && (mc.RENTCAST_DATA_TYPES as any).sold_records.closedSaleEvidence === true && mc.rentcastPriceBasis("listing_records") === "last_list_price" && mc.rentcastPriceBasis("listing_statistics") === "last_list_price"],
      ["IDX exclusive when connected, RentCast the non-IDX tier, in-house first; every external row labelled (an IDX row idx_feed / feed_active, a RentCast row the table's listing_records kind / provider_reported)", ls.resolveListingSource({ hasIdx: true, hasRentcast: true }) === "idx" && ls.resolveListingSource({ hasIdx: false, hasRentcast: true }) === "rentcast" && els.BUYER_LISTING_SOURCE_ORDER[0] === "tenant_listing" && /dataType:\s*RENTCAST_DATA_TYPES\.listing_records\.kind/.test(elsCode) && /verifiedStatus:\s*"provider_reported"/.test(elsCode) && /dataType:\s*"idx_feed"/.test(elsCode) && /verifiedStatus:\s*"feed_active"/.test(elsCode)],
      ["a 500k → 480k drop on a saved tenant listing is ONE price_drop announced once, keyed by the new price", s2.changesTotal === 1 && Object.keys(s2.changes)[0] === "price_drop" && ev2.length - ev1 === 1 && JSON.stringify(ev2[ev2.length - 1]).includes("price_drop:480000")],
    ], [
      ["RentCast is never a photo source", Object.values(mc.RENTCAST_DATA_TYPES).every((t: any) => t.photoRights === false) && ls.resolveListingSource({ hasIdx: false, hasRentcast: false }) === "none"],
      ["(positive control) the FIRST read is a baseline — nothing announced", s1.changesTotal === 0 && ev1 === ev0],
      ["the same state swept again announces nothing (no duplicate)", s3.changesTotal === 0 && ev3 === ev2.length],
    ])
    return {
      ...h,
      detail: JSON.stringify({ failing: h.failing, s1: s1.changesTotal, s2: [s2.changesTotal, s2.changes], events: [ev0, ev1, ev2.length, ev3], last: ev2[ev2.length - 1] ?? null, s3: s3.changesTotal }).slice(0, 1600),
      note: `RentCast: sold_records → recorded_sale, listing_* → last_list_price, photos never; IDX exclusive over RentCast; a 500k → 480k drop announced ONCE (digest price_drop:480000), the first read a baseline, the same state again silent`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 — Communications and media
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 6, group: "Communications and media",
  bullets: ["tenant-branded direct mail uses the tenant's return address", "separate Lob formats use correct templates", "AI copy uses the sender's settings/voice from the start", "every promised lead magnet is delivered or enters a verified recovery path", "media approvals and publication are evidence-backed"],
  reuses: [{ n: 13, covers: "Lob format ids never alias; tenant brand as data; preview + per-piece status; no live spend" }, { n: 10, covers: "lead magnet: deliverable before page/form/funnel; creator users.id + brand kept; consent + unsubscribe in one place" }],
  positiveControl: "the layout scanner catches a planted saved Lob address id; a sender address WITHOUT CASS verification is refused by name; the sender with no writing sample gets settings-only voice and the explicit 'No writing sample' line (never the other agent's words)",
  blindSpot: "no Lob call (LOB_* keys deleted at import; the four global HTML layouts and LOB_TEST_API_KEY are WAITING_EXTERNAL by name); the model is never called — the brief's ORDER in the prompt is read from stripped source; a magnet's email / SMS delivery is Supabase-Auth / provider live-only",
  run: async () => {
    const cass = await import("../lib/providers/mailing-cass-gate")
    const pt = await import("../lib/direct-mail/piece-type")
    const bv = await import("../lib/kernel/brand-voice")
    const photos = await import("../lib/listings/owner-photo-upload")
    const good = { name: "Alder Realty LLC", line1: "12 Peachtree St", line2: null, city: "Atlanta", state: "GA", zip: "30303", source: "tenant_return_address", addressId: null, verification: { method: "lob_cass", verifiedAt: daysAgo(1), deliverability: "deliverable" } }
    const ok: any = cass.decideSenderAddress(good as never)
    const missing: any = cass.decideSenderAddress(null)
    const platform: any = cass.decideSenderAddress("adr_platform_0123456789", { platformLobAddressId: "adr_platform_0123456789" })
    const unverified: any = cass.decideSenderAddress({ ...good, verification: undefined } as never)
    const env = { LOB_LETTER_TEMPLATE_ID: "tmpl_letter", LOB_PERSONAL_LETTER_TEMPLATE_ID: "tmpl_note", LOB_POSTCARD_FRONT_TEMPLATE_ID: "tmpl_front", LOB_POSTCARD_BACK_TEMPLATE_ID: "tmpl_back" }
    const routes = ["letter", "personal_letter", "postcard"].map((f) => JSON.stringify((pt as any).routeMailFormat(f, env)))
    const planted = pt.layoutContentViolations("Return to adr_abcdefghijklmnop — 123 Platform Way")
    const clean = pt.layoutContentViolations("{{sender_legal_identity}} — {{recipient_first_name}}")
    const B1 = "11111111-1111-4111-8111-111111111111", U1 = "aaaaaaaa-0000-4000-8000-000000000001", A1 = "aaaaaaaa-0000-4000-8000-00000000a001", U2 = "bbbbbbbb-0000-4000-8000-000000000002", A2 = "bbbbbbbb-0000-4000-8000-00000000a002"
    const vdb = memSupabase({
      brokerages: [{ id: B1, name: "Harbor & Pine Homes", city: "Pace", state: "FL" }],
      brand_voice_profile: [
        { id: "bv-base", brokerage_id: B1, agent_id: null, team_id: null, tone: "warm", formality_level: "conversational", preferred_words: ["neighbors", "the long game"], prohibited_words: ["guaranteed"], key_brand_messages: [], tagline: "Calm advice, local roots", mission_statement: null, tone_examples: null, writing_style_notes: null, custom_instructions: null, content_guidelines: null, brand_personality: null, style: null, target_audience: null },
        { id: "bv-a1", brokerage_id: B1, agent_id: A1, team_id: null, tone: "direct", formality_level: null, preferred_words: ["straight talk", "your block"], prohibited_words: [], key_brand_messages: [], tagline: "Straight talk about your block", mission_statement: null, tone_examples: ["I'll tell you what your block is doing, not what you want to hear."], writing_style_notes: null, custom_instructions: null, content_guidelines: null, brand_personality: null, style: null, target_audience: null },
      ],
      users: [{ id: U1, first_name: "Jane", last_name: "Rivera", email_signature: "<p>Jane Rivera · 555-0100</p>", team_id: null }, { id: U2, first_name: "Marcus", last_name: "Lee", email_signature: null, team_id: null }],
      agents: [{ id: A1, user_id: U1, brokerage_id: B1, team_id: null, bio: "Fifteen years on the west side of Pace.", specializations: ["waterfront"], languages: ["English"], license_number: "SL123", license_state: "FL" }, { id: A2, user_id: U2, brokerage_id: B1, team_id: null, bio: null, specializations: [], languages: [], license_number: "SL456", license_state: "FL" }],
      teams: [], brokerage_brand_settings: [{ brokerage_id: B1, tagline: "Calm advice, local roots", email_signature_html: "<p>Harbor &amp; Pine Homes · Pace, FL</p>" }], ai_identity_profiles: [], farm_territories: [], distribution_finals: [], notifications: [],
    }, { uuidIds: true })
    const b1 = await bv.loadSenderVoiceBrief(vdb as never, { brokerageId: B1, agentUserId: U1 }, { cache: false, now: NOW })
    const b2 = await bv.loadSenderVoiceBrief(vdb as never, { brokerageId: B1, agentUserId: U2 }, { cache: false, now: NOW })
    const r1 = bv.renderSenderVoiceBrief(b1), r2 = bv.renderSenderVoiceBrief(b2)
    const engine = code("lib/kernel/ai-copy.ts")
    const postcardIds = [...new Set(routes[2].match(/tmpl_\w+/g) ?? [])]
    const db = accessWorld()
    await quiet(() => photos.recordPhotographerDelivery(db as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS, "front.jpg")], attestation: { accepted: true, version: (photos as any).PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION } }))
    const media = rows(db, "listing_media"), notes = rows(db, "notifications")
    const h = halves([
      ["a CASS-verified tenant address passes the sender gate as the inline `from`", ok.ok === true && ok.from.address_line1 === "12 Peachtree St" && ok.source === "tenant_return_address"],
      ["three Lob formats route to three distinct templates; the postcard's front and back differ; the layout library is structure only", new Set(routes).size === 3 && postcardIds.length >= 2 && Object.keys(pt.MAIL_LAYOUT_LIBRARY).length >= 4],
      ["two senders → two versioned briefs; the brief carries the sender's own tagline and words", /Straight talk/.test(r1) && /your block/i.test(r1) && b1.version !== b2.version && /^v1:[0-9a-f]{12}$/.test(b1.version)],
      ["the copy engine's system prompt LEADS with the sender brief (before the audience brief and the rules) and stamps voiceSource", /\[senderVoice \? renderSenderVoiceBrief\(senderVoice\) : null, audience/.test(engine) && /voiceSource/.test(engine)],
      ["a photographer's delivery waits for review and the agent is told (evidence)", media.length === 1 && media[0].is_approved === false && media[0].ownership_attested_by === "u-ph" && notes.length >= 1],
    ], [
      ["a missing, a platform (saved Lob id) and an unverified sender address are refused BY NAME, nothing substituted", missing.ok === false && platform.ok === false && platform.code === "platform_address" && unverified.ok === false && unverified.code === "unverified"],
      ["(positive control) the layout scanner catches a planted Lob id and passes a merge-variable-only layout", planted.length >= 1 && clean.length === 0],
      ["the sender with no sample gets settings-only voice — never the other agent's words — and the explicit no-sample line", !/Straight talk/.test(r2) && /No writing sample/i.test(r2)],
    ])
    return {
      ...h,
      detail: JSON.stringify({ failing: h.failing, ok: ok.ok, missing: missing.code, platform: platform.code, unverified: unverified.code, planted, routes: routes.map((r) => r.slice(0, 160)), postcardIds, b1: b1.version, b2: b2.version, r1: r1.slice(0, 240), r2: r2.slice(0, 240), media: media.length, notes: notes.length }).slice(0, 2200),
      note: `sender: a verified tenant address passes, the platform's Lob id / a missing / an unverified address are refused by name; three Lob routes distinct; two senders → two versioned briefs; the photographer's delivery waits for review (is_approved false) and the agent is notified (evidence)`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 7 — Transaction / finance
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 7, group: "Transaction/finance",
  bullets: ["an executed addendum updates the governing transaction terms", "a CDA-enabled brokerage follows the CDA process", "a CDA-disabled brokerage closes without a CDA", "agent/team compensation matches signed agreements", "actual payout status is not fabricated", "on-or-before closing terms do not create unnecessary amendments"],
  reuses: [{ n: 14, covers: "'on or before' allows an earlier close without an addendum; actual tracked apart; executed addenda govern; payouts re-read from the ledger, never fabricated" }],
  positiveControl: "the NAIVE fold (no unresolvedTieSources) picks a version-number winner for two same-instant contradicting addenda — the invented precedence the rule exists to refuse; a fixed 'on' day DOES need an executed amendment to close earlier",
  blindSpot: "the e-sign envelope, title's settlement upload and the live trigger (m986) are not exercised; the CDA page and the closing-proof card are not rendered; the commission engine's waterfall is the lane proof (test:cda-closing-flow), not this canary",
  run: async () => {
    const gtr = await import("../lib/offers/governing-terms-rule")
    const cda = await import("../lib/transactions/cda-closing-policy")
    const cd = await import("../lib/transactions/closing-dates")
    const V = (versionNo: number, source: string, executedAt: string, terms: Record<string, unknown>) => ({ versionNo, source, executedAt, terms })
    const rank = (s: string) => (s === "contract" ? 0 : 1)
    const base = [V(1, "contract", daysAgo(10), { price: 500000 }), V(2, "addendum", daysAgo(5), { price: 495000 })]
    const gov = gtr.foldTermsByPrecedence(base as never, ["price"], rank)
    const tied = [...base, V(3, "addendum", daysAgo(5), { price: 490000 })]
    const unresolved = gtr.foldTermsByPrecedence(tied as never, ["price"], rank, { unresolvedTieSources: ["addendum"] })
    const naive = gtr.foldTermsByPrecedence(tied as never, ["price"], rank)
    const cdaMode = cda.resolveCdaMode({ offersCda: true }), noCda = cda.resolveCdaMode({ offersCda: false })
    const tx = { status: "closed", close_date: "2026-11-01", actual_close_date: "2026-11-01", compliance_passed_at: daysAgo(3) }
    const noReceipt = cda.noCdaClosingProof({ cdaMode: noCda, transaction: tx, finalSettlement: null, commissions: [{ id: "ac1", status: "approved", deposit_received_at: null, deposit_received_by: null }], openBlockingCompliance: 0, lifetimeHoldOpen: true } as never)
    const receipt = cda.noCdaClosingProof({ cdaMode: noCda, transaction: tx, finalSettlement: { documentId: "doc-cd", uploadedAt: daysAgo(1), uploadedBy: "u-title", uploadedByType: "vendor" }, commissions: [{ id: "ac1", status: "approved", deposit_received_at: daysAgo(1), deposit_received_by: "u-fin" }], openBlockingCompliance: 0, lifetimeHoldOpen: true } as never)
    const facts = { contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", financing_type: "conventional", property_state: "FL", status: "under_contract" }
    const earlier = cd.assessClosingDateChange(facts as never, { date: "2026-12-10", kind: "anticipated" })
    const later = cd.assessClosingDateChange(facts as never, { date: "2026-12-20", kind: "anticipated" })
    const fixed = cd.assessClosingDateChange({ ...facts, contract_closing_terms: "on" } as never, { date: "2026-12-10", kind: "anticipated" })
    return {
      positive: gov.won.price?.value === 495000 && gov.won.price?.version.source === "addendum" && gov.conflicts.length === 1
        && cdaMode.mode === "cda" && cdaMode.cdaRequired && cdaMode.blocksClosing === false && noCda.mode === "no_cda" && noCda.cdaRequired === false && noCda.blocksClosing === false
        && receipt.fundsReceived === true && receipt.receipt.status === "recorded" && receipt.settlement.status === "on_file" && receipt.blocksClosing === false
        && earlier.direction === "earlier" && earlier.requiresExecutedAmendment === false && earlier.amendmentBasis === "none",
      negative: unresolved.won.price === undefined && unresolved.unresolved.length === 1 && unresolved.unresolved[0].reason === "same_effective_instant"
        && naive.won.price?.value === 490000
        && noReceipt.closed === true && noReceipt.fundsReceived === false && noReceipt.payout.state === "held_funds_not_received" && noReceipt.missing.length >= 1
        && later.requiresExecutedAmendment === true && fixed.requiresExecutedAmendment === true && fixed.amendmentBasis === "contract_fixed_day",
      detail: JSON.stringify({ gov: gov.won.price?.value, unresolved: unresolved.unresolved, naive: naive.won.price?.value, noReceipt: { funds: noReceipt.fundsReceived, payout: noReceipt.payout.state, missing: noReceipt.missing }, receipt: { funds: receipt.fundsReceived, status: receipt.receipt.status }, earlier: [earlier.direction, earlier.requiresExecutedAmendment, earlier.amendmentBasis], later: later.requiresExecutedAmendment, fixed: fixed.amendmentBasis }).slice(0, 1400),
      note: `addendum governs (495,000; original kept as a conflict); two same-instant addenda → UNRESOLVED (the naive fold would have invented 490,000); CDA mode never blocks a close; a closed deal with no recorded receipt reads funds NOT received, payout ${noReceipt.payout.state}; on-or-before earlier close needs no amendment, a fixed day does`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 8 — Legal agreements and tenant integrations
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 8, group: "Legal agreements and tenant integrations",
  bullets: ["substantive platform legal drafts and packets delivered as reviewable files with unresolved variables and counsel sign-off visible", "subscriber contracting entity/signatory and immutable accepted-version audit; an office seat cannot sign as a brokerage", "draft legal content cannot be activated as approved; consumer marketing consent stays separate", "platform-owned vs tenant-owned credential scopes distinct, tested with two tenants", "a tenant connects a supported own-account provider through Settings without a membership / tier change", "source rights, territory, cost payer, connector health, signed webhook, rotation and disconnect proven", "unsupported or unlicensed provider returns actionable honest status; no fabricated ingestion"],
  reuses: [{ n: 9, covers: "enrichment honours approved source / territory / rights; no false 50k paid call; unknown license blocks activation only" }],
  positiveControl: "a CLEAN approved body activates (templateActivationRefusal null) — so the draft banner is what refuses; the secret redactor sees the planted bearer token; a matching webhook secret verifies 'ok' — so the mismatch is the compare, not a broken verifier",
  blindSpot: "counsel has approved NOTHING (every packet is a DRAFT by its banner — honest-state); the two-tenant vault isolation on the REAL encrypted rows is the roster canary tenant-provider-connections (test:canaries) and lane 151F's guard, not re-run here; a tenant's real BatchData token and the live wallet read are WAITING_EXTERNAL by name; no provider is called",
  run: async () => {
    const L = await import("../lib/legal/subscription-agreement")
    const tpc = await import("../lib/providers/tenant-provider-connections")
    const packets = existsSync(join(ROOT, "docs/legal")) ? readdirSync(join(ROOT, "docs/legal")).filter((f) => /^PACKET-\d/.test(f) && f.endsWith(".md")) : []
    const texts = packets.map((f) => raw(`docs/legal/${f}`))
    const review = raw("docs/operations/LEGAL-REVIEW-PACKET.md")
    const draftRefusal = texts.length ? L.templateActivationRefusal({ approval_status: "approved", body_text: texts[0], content_sha256: "x" }) : "no packets"
    const cleanActivates = L.templateActivationRefusal({ approval_status: "approved", body_text: "A clean approved agreement body.", content_sha256: "abc" })
    const unapproved = L.templateActivationRefusal({ approval_status: "draft", body_text: "A clean body.", content_sha256: "abc" })
    const B1 = "b1", M1 = "m1"
    const sdb = memSupabase({
      brokerages: [{ id: B1, name: "Gulf Shore Brokerage", dba: "Gulf Shore", license_number: "CQ1234", license_state: "FL", plan_tier: "brokerage" }, { id: M1, name: "Coastal Realty", dba: null, license_number: "CQ9000", license_state: "FL", plan_tier: "multi_location" }],
      users: [
        { id: "owner", brokerage_id: B1, user_type: "broker_owner", email: "owner@gulf.test", location_id: null }, { id: "agent", brokerage_id: B1, user_type: "agent", email: "agent@gulf.test", location_id: null },
        { id: "headA", brokerage_id: M1, user_type: "broker", email: "head.a@coastal.test", location_id: "LA" }, { id: "ownerM", brokerage_id: M1, user_type: "broker_owner", email: "owner@coastal.test", location_id: null },
      ],
      user_role_assignments: [], teams: [{ id: "b1t2", brokerage_id: B1, team_lead_id: "owner", location_id: "L1", deleted_at: null }],
      locations: [{ id: "L1", brokerage_id: B1, status: "active", managing_broker_user_id: null }, { id: "LA", brokerage_id: M1, status: "active", managing_broker_user_id: null }, { id: "LB", brokerage_id: M1, status: "active", managing_broker_user_id: null }],
      organization_members: [{ id: "om1", brokerage_id: M1, user_id: "headA", scope_kind: "location", location_id: "LA", team_id: null, access_level: "leadership", revoked_at: null }, { id: "om2", brokerage_id: M1, user_id: "ownerM", scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null }],
      platform_contract_templates: [], tenant_contract_signatures: [], notifications: [], subscriptions: [],
    })
    const who = (id: string) => { const u = rows(sdb, "users").find((r) => r.id === id); return { user_type: u.user_type, brokerage_id: u.brokerage_id } }
    const owner: any = await quiet(() => L.assessSignatoryAuthority(sdb as never, "owner", who("owner")))
    const agent: any = await quiet(() => L.assessSignatoryAuthority(sdb as never, "agent", who("agent")))
    const headA: any = await quiet(() => L.assessSignatoryAuthority(sdb as never, "headA", who("headA")))
    const ownerM: any = await quiet(() => L.assessSignatoryAuthority(sdb as never, "ownerM", who("ownerM")))
    const legalIdents = ident("lib/legal/subscription-agreement.ts")
    const capability = (tpc.TENANT_ACQUISITION_PROVIDERS as any).batchdata?.capabilities?.[0]
    const agreementInput = { scopes: [capability], license_acknowledged: true, retention_days: 365, ai_processing_permitted: true, redistribution: "prohibited", cost_payer: "tenant", accepted_by_user_id: "u" }
    const goodAgreement = tpc.validateProviderAgreement("batchdata", agreementInput, { userId: "u", now: NOW })
    const badAgreement = tpc.validateProviderAgreement("batchdata", { scopes: ["x"] }, { userId: "u" })
    const healthyCfg = { agreement: goodAgreement.ok ? goodAgreement.agreement : agreementInput, territory: { zips: ["32571"] }, frequency: "weekly", rate_limit_per_day: 0, webhook_secret: "enc:v1:x", account_label: "own", cost_payer: "tenant", coverage: "tenant_paid", connected_via: "settings_lead_sources", sandbox: false, disconnected_at: null, last_health: { kind: "wallet_balance", status: "ok", at: daysAgo(0), detail: null } }
    const healthy = tpc.deriveTenantProviderConnectionState("batchdata", { exists: true, isActive: true, testStatus: "pass", hasApiKey: true, config: healthyCfg as never })
    const sandbox = tpc.deriveTenantProviderConnectionState("batchdata", { exists: true, isActive: true, testStatus: "pass", hasApiKey: true, config: { ...healthyCfg, sandbox: true } as never })
    const revoked = tpc.deriveTenantProviderConnectionState("batchdata", { exists: true, isActive: true, testStatus: "pass", hasApiKey: true, config: { ...healthyCfg, last_health: { kind: "wallet_balance", status: "auth_failed", at: daysAgo(0), detail: null } } as never })
    const unsupported = tpc.deriveTenantProviderConnectionState("tracerfy", null)
    const unconfigured = tpc.deriveTenantProviderConnectionState("batchdata", null)
    const secretOk = tpc.verifyTenantWebhookSecret("s3cr3t-abcdef-0123", "s3cr3t-abcdef-0123"), secretBad = tpc.verifyTenantWebhookSecret("s3cr3t-abcdef-0123", "nope"), secretNone = tpc.verifyTenantWebhookSecret(null, "x")
    const token = "abcdefghijklmnopqrstuvwxyz0123"
    const redacted = tpc.redactProviderSecrets(`401 from BatchData: Bearer ${token} rejected`)
    const patch = tpc.tenantProviderDisconnectPatch({ agreement: { scopes: [capability] } } as never, NOW)
    const actionIdents = ident("app/actions/tenant-connections.ts")
    const h = halves([
      ["the packets are reviewable DRAFT files: banner, Version line, [[variables]]; the review packet carries the sign-off sheet", packets.length >= 4 && texts.every((t) => L.isDraftMarked(t) && /Version:/.test(t) && /\[\[[A-Z_]+\]\]/.test(t)) && /sign-off/i.test(review) && /DRAFT/.test(review)],
      ["(positive control) a clean approved body activates", cleanActivates === null],
      ["the books seat signs a one-office brokerage; the organization's leadership signs a multi-location one", owner?.ok && owner.authority.authorized && ownerM?.ok && ownerM.authority.authorized && ownerM.authority.multiLocation],
      ["a complete own-account connection with a verified health read is healthy and may ingest; the agreement validates; the tenant pays", healthy.state === "healthy" && healthy.mayIngest && goodAgreement.ok && (tpc.TENANT_ACQUISITION_PROVIDERS as any).batchdata.pricing.payer === "tenant"],
      ["the signed push door verifies its secret; a disconnect writes a patch", secretOk === "ok" && Object.keys(patch).length >= 1],
    ], [
      ["a draft-bannered body cannot activate; an unapproved body cannot activate", typeof draftRefusal === "string" && /draft/i.test(draftRefusal) && typeof unapproved === "string"],
      ["an agent seat and an office head cannot sign for the brokerage (refused by name)", agent?.ok && !agent.authority.authorized && headA?.ok && !headA.authority.authorized && /leadership/i.test(headA.authority.refusal ?? "")],
      ["consumer consent stays separate: the agreement module names no consent identifier (finder sees a specimen)", !/consent/i.test(legalIdents) && /consent/i.test("captureConsentedContact(")],
      ["tracerfy → unsupported with an actionable next step; an unconnected batchdata → unconfigured; a sandbox token → sandbox (never a production source); a refused token → revoked", unsupported.state === "unsupported" && !unsupported.mayIngest && !!unsupported.actionable && unconfigured.state === "unconfigured" && !unconfigured.mayIngest && sandbox.state === "sandbox" && revoked.state === "revoked" && !revoked.mayIngest],
      ["an agreement without the license attestation or with a foreign scope is refused naming both", !badAgreement.ok && badAgreement.problems.some((p) => /license_acknowledged/.test(p)) && badAgreement.problems.some((p) => /scopes/.test(p))],
      ["a wrong / absent webhook secret never verifies; a bearer token never survives redaction (finder sees it)", secretBad === "mismatch" && secretNone === "no_secret_configured" && !redacted.includes(token) && `Bearer ${token}`.includes(token)],
      ["the connect door touches no tier / subscription / Stripe identifier", !/plan_tier|subscription_tier|stripe/i.test(actionIdents)],
    ])
    return {
      ...h,
      detail: JSON.stringify({ failing: h.failing, packets, draftRefusal: String(draftRefusal).slice(0, 120), owner: owner?.authority?.authorized, agent: agent?.authority?.refusal, headA: headA?.authority?.refusal, ownerM: ownerM?.authority?.authorized, healthy: [healthy.state, healthy.reason], sandbox: sandbox.state, revoked: revoked.state, unsupported: [unsupported.state, unsupported.actionable], unconfigured: unconfigured.state, badAgreement: badAgreement.ok ? "ok" : badAgreement.problems, goodAgreement: goodAgreement.ok ? "ok" : goodAgreement.problems, secret: [secretOk, secretBad, secretNone], redacted, patch }).slice(0, 2200),
      note: `${packets.length} packets, every one DRAFT-bannered with a Version line and [[variables]]; counsel sign-off: NOT given (honest-state); a draft body cannot activate, a clean approved one can; an office head cannot sign for a multi-location brokerage, the organization's leadership can; batchdata own-account → ${healthy.state} / sandbox → ${sandbox.state} / refused token → ${revoked.state}; tracerfy → ${unsupported.state}; unconnected → ${unconfigured.state}; secrets redacted`,
      state: "honest-state",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 9 — Creative differentiation and learning
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 9, group: "Creative differentiation and learning",
  bullets: ["four or more early-opportunity plays with research-to-decision evidence and negative tests", "public employer/permit/military market events never create named-person Leads", "an existing Contact's evolving behavior triggers a helpful arbiter evaluation without a duplicate Lead", "contrary / newer evidence suppresses stale acquisition", "desire / expectation / feasibility / timing stored with separate evidence, not a magic seller percentage", "outcome learning closes the loop without inventing success rates"],
  reuses: [{ n: 8, covers: "market signal → attributed idea / guide, never an invented person or an identified anonymous account" }],
  positiveControl: "contrary evidence OLDER than the theory's latest positive is IGNORED (history, verdict none); 60 validated outcomes DO publish a rate — so the 10-sample refusal is the floor, not a broken calibrator; a replayed change reads 'replayed', never a second record",
  blindSpot: "the plays run against Exa only with EXA_API_KEY (deleted here): the cards' research-to-decision facets and negative controls are READ, their executions are lane 151D's proof (test:early-opportunity-plays, 96 checks); the arbiter's model is never called; no cohort has 50 validated outcomes live, so no published rate exists to compare",
  run: async () => {
    const con = await import("../lib/acquisition-plays/contract")
    const ne = await import("../lib/acquisition-plays/negative-evidence")
    const sl = await import("../lib/intelligence/strategy-learning")
    const mv = await import("../lib/intent/movement-signals")
    const { mm, buyerObs, moment } = await momentKit()
    const cards = Object.entries(con.PLAY_CARDS as Record<string, any>)
    const complete = cards.filter(([, c]) => { const j = JSON.stringify(c); return Array.isArray(c.endsIn) && c.endsIn.length >= 1 && typeof c.negativeControl === "string" && /arbiter_decision/.test(j) && /outcome_attribution/.test(j) && /failure_recovery/.test(j) && /evidence/.test(j) })
    const news = con.personCandidateProblem({ statement: { firstPerson: false, requestsAgentContact: false, quote: "Acme opens a 400-job plant" }, identity: { basis: "name_only", name: "J. Exec" }, rights: { publishedContactPermitted: false, sourceClass: "news" } as never, publishedAt: daysAgo(1) }, NOW)
    const corridor = (con.PLAY_CARDS as any).moving_corridor_radar
    const db = movementWorld()
    const change = { kind: "saved_home_shift", referenceId: "s1", summary: "saved three homes in a new city", at: daysAgo(1) }
    const r1: any = await withSvc(db, () => quiet(() => mv.reassessExistingContact(db as never, { brokerageId: A, contactId: "c1", change } as never, movementDeps() as never)))
    const r2: any = await withSvc(db, () => quiet(() => mv.reassessExistingContact(db as never, { brokerageId: A, contactId: "c1", change } as never, movementDeps() as never)))
    const theory = { subject: { type: "contact", id: "c1" }, side: "seller", latestPositiveAt: daysAgo(10) }
    const sold = ne.assessNegativeEvidence(theory as never, [{ kind: "recorded_sale", at: daysAgo(2), confidence: "verified", source: "county_recorder" }] as never, NOW)
    const older = ne.assessNegativeEvidence(theory as never, [{ kind: "recorded_sale", at: daysAgo(30), confidence: "verified", source: "county_recorder" }] as never, NOW)
    const inferred = ne.assessNegativeEvidence(theory as never, [{ kind: "active_listing_other_agent", at: daysAgo(2), confidence: "inferred", source: "page" }] as never, NOW)
    const ready = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", inventory: "available", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    const dims = ready.dimensions ?? {}
    const classes = mm.EVIDENCE_CLASSES as readonly string[]
    const few = sl.calibrateDecisionWindows(Array.from({ length: 10 }, () => ({ forecast: "31_90", validated: true, hit: true, kind: "validated" })))
    const enough = sl.calibrateDecisionWindows(Array.from({ length: 60 }, (_, i) => ({ forecast: "31_90", validated: true, hit: i % 2 === 0, kind: "validated" })))
    const early = sl.calibrateDecisionWindows([{ forecast: "31_90", validated: false, hit: false, kind: "no_move_early" }])
    return {
      positive: complete.length >= 4 && ["reassessed", "recorded_no_decision"].includes(r1?.status) && r1.newLeadCreated === false && r1.providerCalls === 0 && rows(db, "movement_signals").length === 1
        && sold.verdict === "stop" && sold.acquisition === "stop" && sold.outcome === "moved" && sold.evidenceClass === "stale_contradicted"
        && Object.keys(dims).length === 5 && Object.values(dims).every((d: any) => classes.includes(d.evidenceClass) || d.evidenceClass === "none") && Object.values(dims).every((d: any) => typeof d.why === "string" && Array.isArray(d.sourceTimestamps))
        && enough.byWindow["31_90"]?.published === true && typeof enough.byWindow["31_90"]?.rate === "number",
      negative: news !== null && /no person|NO person|never/i.test(String(corridor?.negativeControl ?? "")) && con.nameOnlyJoinProblem("name_only") !== null
        && r2?.status === "replayed" && rows(db, "leads").length === 0 && rows(db, "raw_scraped_leads").length === 0
        && older.verdict === "none" && older.ignored.length === 1 && inferred.verdict === "verify"
        && !/"probability":\s*0?\.\d/.test(JSON.stringify(ready)) && !/seller_percentage|sellerPercentage/.test(JSON.stringify(ready))
        && few.byWindow["31_90"]?.published === false && few.byWindow["31_90"]?.rate === null && early.earlyNegatives === 1,
      detail: JSON.stringify({ plays: cards.map(([k]) => k), complete: complete.length, news, r1: r1?.status, r2: r2?.status, sold: [sold.verdict, sold.outcome], older: older.verdict, inferred: inferred.verdict, dims: Object.fromEntries(Object.entries(dims).map(([k, d]: any) => [k, d.evidenceClass])), few: few.byWindow, enough: enough.byWindow["31_90"]?.rate }).slice(0, 1600),
      note: `${complete.length} of ${cards.length} play cards carry research-to-decision facets + a negative control; a news page never yields a person; the SAME contact reassessed once and replayed once (0 leads); a verified sale NEWER than the theory stops acquisition, an older one is history; 10 validated outcomes publish no rate, 60 do`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 10 — Engineering
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 10, group: "Engineering",
  bullets: ["A2P begins at number creation when required", "invites send immediately with safe recovery", "platform-owned provider errors do not leak secrets", "tenant support queues remain isolated", "self-healing resolves authorized reversible failures", "the natural-language command center includes Transactions", "consented Contact capture and suppression work", "the full manager/action/evidence loop closes", "UI actions have genuine results", "provider-ready vs provider-unconfigured states are honest"],
  reuses: [{ n: 16, covers: "A2P on number creation; invites immediate; failures seen within minutes; manager → human support with tenant-safe words" }, { n: 4, covers: "consented form → ONE Contact, invite immediate; STOP / suppression on the capture door" }, { n: 12, covers: "immediate portal welcome; two-way channels; no invented intervals; a failed send is a staff action at the event" }],
  positiveControl: "the support census finder sees a specimen read with no tenant predicate; the ledger's second identical claim is a REPLAY (one row, the run body executed once) — so the loop's evidence is the row, not the call",
  blindSpot: "self-healing's reversible playbooks are the roster canary self-healing (test:canaries) and test:self-healing — named, not re-run; UI actions are censused by test:ui-wiring-census / test:no-orphan-actions (stripped source), never clicked; no Twilio / Supabase Auth call; the command center's model is scripted elsewhere",
  run: async () => {
    const nav = await import("../app/config/navigation-config")
    const al = await import("../lib/kernel/action-ledger")
    const tpc = await import("../lib/providers/tenant-provider-connections")
    const sdp = await import("../lib/lead-pipeline/source-discovery-planner")
    const TRANSACTIONS_HREF = /(^|\/)(dashboard\/transactions|transaction\/deals|lender\/transactions)(\/|\?|$)/
    const walk = (v: any, out: any[] = []): any[] => { if (Array.isArray(v)) for (const x of v) walk(x, out); else if (v && typeof v === "object") { if (typeof v.href === "string") out.push(v); for (const k of Object.keys(v)) if (k !== "icon") walk(v[k], out) } return out }
    const has = (role: string) => walk((nav.NAVIGATION_BY_ROLE as any)[role]).some((i) => i.id === "transactions" || TRANSACTIONS_HREF.test(i.href))
    const headerSrc = raw("app/components/layout/header.tsx")
    const token = "abcdefghijklmnopqrstuvwxyz0123"
    const failure = tpc.classifyTenantProviderFailure({ httpStatus: 401, message: `Bearer ${token} rejected` }, "BatchData")
    const triage = code("lib/support/ticket-triage.ts")
    const reads = [...triage.matchAll(/\.from\("support_tickets"\)/g)].map((m) => triage.slice(m.index!, m.index! + 400))
    const pinned = reads.every((r) => /brokerage_id/.test(r))
    const db = memSupabase({ agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    const ctx = { brokerageId: A, action: "canary.evidence.loop", actor: { type: "system" }, subject: { type: "canary", id: "c1" }, idempotencyKey: "canary-151L-loop-1", reasonCode: "UNSPECIFIED" }
    let runs = 0
    const first = await quiet(() => al.withActionLedger(ctx as never, async () => { runs++; return "sent" }, { settle: () => ({ status: "executed", outcome: "sent" }), replay: () => "replayed" }, { client: db as never }))
    const second = await quiet(() => al.withActionLedger(ctx as never, async () => { runs++; return "sent" }, { settle: () => ({ status: "executed", outcome: "sent" }), replay: () => "replayed" }, { client: db as never }))
    const ledger = rows(db, "agent_action_ledger")
    const unconfigured = tpc.deriveTenantProviderConnectionState("batchdata", null)
    const closed = sdp.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: A, plans: [], platform: { vendor: "batchdata", configured: false, credentialNames: ["BATCHDATA_API_KEY"], activation: "dormant_survivor", survivorDoors: "owner_confirmation_pending", monthlyBudgetUsd: 100, remainingBudgetUsd: 100 } as never, tenant: null, now: NOW })
    return {
      positive: ["agent", "broker", "admin", "team_lead", "tc"].every(has) && /findTransactionsNavItem/.test(headerSrc) && /dashboard\\\/transactions\|transaction\\\/deals\|lender\\\/transactions/.test(headerSrc)
        && first === "sent" && runs === 1 && ledger.length === 1 && ledger[0].status === "executed"
        && unconfigured.state === "unconfigured" && !!unconfigured.actionable && closed.door === "unavailable" && /BATCHDATA_API_KEY/.test(closed.reason),
      negative: !has("contact") && !has("vendor") && !JSON.stringify(failure).includes(token) && `Bearer ${token}`.includes(token)
        && reads.length >= 1 && pinned && !/brokerage_id/.test('.from("support_tickets").select("*").eq("id", id)')
        && second === "replayed" && runs === 1 && ledger.length === 1
        && !/[A-Za-z0-9]{24,}/.test(closed.reason) && !/[A-Za-z0-9]{24,}/.test(unconfigured.reason + (unconfigured.actionable ?? "")),
      detail: JSON.stringify({ nav: ["agent", "broker", "admin", "team_lead", "tc", "contact", "vendor"].map((r) => [r, has(r)]), failure, supportReads: reads.length, pinned, first, second, runs, ledger: ledger.map((r) => [r.action, r.status]), unconfigured: unconfigured.state, closed: closed.reason }).slice(0, 1400),
      note: `Transactions in the sidebar for agent / broker / admin / team lead / TC, none for contact / vendor; a 401 classified without its token; ${reads.length} support_tickets reads all tenant-pinned; the ledger: one claim, one row (${ledger[0]?.status}), a replay on the second call; unconfigured provider → ${unconfigured.state} with an actionable next step, no value printed`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// THE RUN — the ten groups, then every wave-150 canary a group reuses, BY IMPORT
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" WAVE 151 canaries (in-memory) — the directive's REQUIRED CANARIES in ten groups, each POSITIVE + NEGATIVE + positive control + blind spot")
  console.log("══════════════════════════════════════════════════════════════")
  let passed = 0, failed = 0
  const failures: string[] = []
  for (const g of GROUPS.sort((a, b) => a.n - b.n)) {
    let v: Verdict
    try { v = await g.run() } catch (e) { v = { positive: false, negative: false, detail: `THREW: ${(e as Error)?.stack ?? String(e)}` } }
    const ok = v.positive && v.negative
    if (ok) passed++; else { failed++; failures.push(`${g.n}. ${g.group}`) }
    console.log(`\n ${ok ? "✓" : "✗"} ${String(g.n).padStart(2)}. ${g.group} — positive ${v.positive ? "✓" : "✗"} · negative ${v.negative ? "✓" : "✗"}${ok ? ` · ${v.state ?? "built"}` : ""}`)
    console.log(`      bullets: ${g.bullets.join(" · ")}`)
    console.log(`      reuses (by import): ${g.reuses.map((r) => `wave-150 #${r.n} — ${r.covers}`).join("; ") || "none"}`)
    console.log(`      positive control: ${g.positiveControl}`)
    console.log(`      blind spot: ${g.blindSpot}`)
    if (v.note) console.log(`      note: ${v.note}`)
    if (!ok) console.log(`      evidence: ${String(v.detail ?? "").slice(0, 2400)}`)
  }
  const reused = [...new Set(GROUPS.flatMap((g) => g.reuses.map((r) => r.n)))].sort((a, b) => a - b)
  console.log("\n──────────────────────────────────────────────────────────────")
  console.log(` reused wave-150 canaries, run here by import (${reused.length}): ${reused.map((n) => `#${n}`).join(" ")}`)
  let reusedPassed = 0, reusedFailed = 0
  for (const n of reused) {
    const c = w150(n)
    let v: Verdict
    try { v = await c.run() } catch (e) { v = { positive: false, negative: false, detail: `THREW: ${(e as Error)?.message ?? String(e)}` } }
    const ok = v.positive && v.negative
    if (ok) reusedPassed++; else { reusedFailed++; failures.push(`wave-150 #${n} "${c.title}"`) }
    console.log(` ${ok ? "✓" : "✗"} wave-150 #${String(n).padStart(2)} "${c.title}"${ok ? ` · ${v.state ?? "built"}` : ` — ${String(v.detail ?? "").slice(0, 400)}`}`)
  }
  console.log(` measured: background echo rejections ${backgroundRejections.length} · live tables ${LIVE_TABLES.length} · snapshot tables ${Object.keys(SCHEMA_SNAPSHOT).length}`)
  console.log(" blind spots: memSupabase has no CHECK/FK/RLS/storage policy/trigger · Supabase Auth, Stripe, Twilio, Lob, Meta, Google, RentCast, Exa, BatchData,")
  console.log("   Tracerfy, DataZapp and Vercel are never called · every model is scripted · routes and React are read as stripped source · counsel approval,")
  console.log("   the storage.objects policies and the seed accounts are owner work · an honest-state pass asserts the recorded refusal / draft / hold, never an upgrade")
  if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(` RESULT: canaries ${passed + reusedPassed} passed, ${failed + reusedFailed} failed (${GROUPS.length} required groups + ${reused.length} reused wave-150 canaries)`)
  console.log(failed + reusedFailed === 0 ? "WAVE151_CANARIES_PASS" : "WAVE151_CANARIES_FAIL")
  process.exit(failed + reusedFailed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); console.log("WAVE151_CANARIES_FAIL"); process.exit(1) })
