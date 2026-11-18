#!/usr/bin/env tsx
/**
 * scripts/events-and-circles-guard.ts — `npm run test:events-and-circles` (wave 154, lane 154G3; directive G8 + G9, ruling R8).
 *
 * ALL SIMULATED: a recording in-memory database (below), the REAL topic intake (lib/content-intel/topic-intake.ts
 * intakeTopicIdeas / reevaluateRemovedTopicSource), the REAL newsletter grounding reader (local-intel loadLocalFacts) and the
 * REAL arbiter door (lib/ai-isa/followup-arbiter.ts arbitrateFollowUp) with an injected model reply. No provider, no network,
 * no live database. The action ledger is a recording fake (withActionLedger is proven elsewhere).
 *
 *   E  LOCAL EVENTS — typed source rights; an unconfigured transport returns nothing and is counted; a verified relevant event
 *      enters the pool with factual provenance, as a NEWSLETTER candidate (loadLocalFacts reads it) AND as other creative
 *      types; the arbiter chooses (files one approval item) or declines (files none); syndication is deduplicated; every
 *      verification refusal is counted and stores nothing; a cancellation / reschedule retires the topics, removes the fact
 *      from the newsletter grounding and HOLDS derived drafts (a sent one is counted, not pretended unsent); no RSVP / person
 *      row is written; two tenants' rows carry only their own brand owner; a vanished listing reads STALE.
 *   C  CIRCLES — the evidence rule (and its two constants pinned to their sources); the privacy strip; membership read live
 *      (member sees, non-member / removed member / other tenant / departed producer see nothing); the arbiter per member
 *      (ignore hides, hold blocks adaptation, non-attributable evidence never reaches the model); adaptation is an ORIGINAL
 *      topic owned by the member; revoke ends future access but keeps history; expiry withholds; no figure, campaign id or
 *      producer identity crosses.
 *   S  STATIC — no direct content_topic_bank insert in the lane's modules (STRIPPED source, positive control); the migration's
 *      first line; the guard chain.
 * Each absence claim has a POSITIVE CONTROL (CLAUDE.md §2). Summary: `RESULT: N passed, M failed`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { LIVE_TABLES } from "./live-tables"
import * as LE from "@/lib/newsletter/local-events"
import * as CT from "@/lib/marketing/circle-tactics"
import { intakeTopicIdeas, reevaluateRemovedTopicSource, personalDataProblem, rewordedNearCopyProblem } from "@/lib/content-intel/topic-intake"
import { loadLocalFacts } from "@/lib/content-intel/local-intel"
import { arbitrateFollowUp } from "@/lib/ai-isa/followup-arbiter"
import { platformFollowupPolicy } from "@/lib/ai-isa/followup-policy"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const ROOT = process.cwd()

// ── A recording in-memory database (the supabase-js subset these modules use; resolves refusals like supabase-js) ──────
type Row = Record<string, any>
function path(row: Row, col: string): any {
  const parts = col.split(/->>|->/)
  let v: any = row[parts[0]]
  for (const p of parts.slice(1)) { if (v == null || typeof v !== "object") return undefined; v = v[p] }
  return col.includes("->>") && v != null && typeof v !== "string" ? String(v) : v
}
function contains(hay: any, needle: any): boolean {
  if (Array.isArray(needle)) return Array.isArray(hay) && needle.every((n) => hay.some((h: any) => contains(h, n)))
  if (needle && typeof needle === "object") return !!hay && typeof hay === "object" && Object.entries(needle).every(([k, v]) => contains(hay[k], v))
  return hay === needle
}
function makeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  const writes: Array<{ table: string; op: string; n: number }> = []
  let seq = 0
  const db = {
    tables, writes,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" | "update" = "select", payload: any = null, lim = Infinity, single = false
      const rows = () => (tables[table] ??= [])
      const q: any = {
        select() { return q }, insert(p: any) { op = "insert"; payload = p; return q }, update(p: any) { op = "update"; payload = p; return q },
        eq(c: string, v: any) { filters.push((r) => path(r, c) === v); return q }, neq(c: string, v: any) { filters.push((r) => path(r, c) !== v); return q },
        in(c: string, vs: any[]) { filters.push((r) => vs.includes(path(r, c))); return q }, is(c: string, v: any) { filters.push((r) => (path(r, c) ?? null) === v); return q },
        not(c: string, o: string, v: any) { filters.push((r) => o === "is" ? (path(r, c) ?? null) !== v : path(r, c) !== v); return q },
        gt(c: string, v: any) { filters.push((r) => String(path(r, c) ?? "") > String(v)); return q }, gte(c: string, v: any) { filters.push((r) => String(path(r, c) ?? "") >= String(v)); return q },
        contains(c: string, v: any) { filters.push((r) => contains(path(r, c), v)); return q }, overlaps(c: string, v: any[]) { filters.push((r) => Array.isArray(path(r, c)) && v.some((x) => path(r, c).includes(x))); return q },
        or(expr: string) { const terms = expr.split(",").map((t) => t.split(".")); filters.push((r) => terms.some(([c, o, ...rest]) => o === "eq" && String(path(r, c)) === rest.join("."))); return q },
        order() { return q }, limit(n: number) { lim = n; return q }, maybeSingle() { single = true; return q },
        then(res: (v: any) => void, rej?: (e: any) => void) {
          try {
            if (op === "insert") {
              const list = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: p.id ?? `${table}-${++seq}`, ...JSON.parse(JSON.stringify(p)) }))
              rows().push(...list); writes.push({ table, op, n: list.length })
              return Promise.resolve({ data: list.map((r: Row) => ({ ...r })), error: null }).then(res, rej)
            }
            const hit = rows().filter((r) => filters.every((f) => f(r)))
            if (op === "update") { for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(payload))); writes.push({ table, op, n: hit.length }); return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(res, rej) }
            const out = hit.slice(0, lim).map((r) => JSON.parse(JSON.stringify(r)))
            return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null }).then(res, rej)
          } catch (e) { return Promise.resolve({ data: null, error: { message: String(e) } }).then(res, rej) }
        },
      }
      return q
    },
  }
  return db
}
type Db = ReturnType<typeof makeDb>

const ledgerCalls: string[] = []
const ledger = async <T,>(c: { action: string }, run: () => Promise<T>) => { ledgerCalls.push(c.action); return run() }
const policy = platformFollowupPolicy()
function reply(optionId: string, channel: string | null = null) { return async () => ({ optionId, channel, format: null, waitHours: optionId === "decline" || optionId.startsWith("hold") || optionId.startsWith("ignore") ? 24 : null, rationale: `Chose ${optionId} for this audience.`, evidence: ["moment"], confidence: 0.8 }) }

const NOW = new Date("2026-11-18T15:00:00Z")
const A = "brk-a", B = "brk-b"
const src = (over: Partial<LE.EventSource> = {}): LE.EventSource => ({ id: "src-lib", brokerageId: A, label: "Springfield Public Library", sourceClass: "library_calendar", access: "publisher_syndication_feed", url: "https://library.springfield.gov/events.ics", rights: { termsNote: "public calendar feed offered for syndication", recordedBy: "u-admin", recordedAt: "2026-11-01T00:00:00Z", licenseRef: null }, territory: { city: "Springfield", state: "IL", zip: null }, lastRunAt: null, ...over })
const ev = (over: Partial<LE.RawEvent> = {}): LE.RawEvent => ({ sourceEventKey: "uid-fair", url: "https://library.springfield.gov/events/fall-book-fair", title: "Fall Book Fair", location: { kind: "physical", venue: "Main Library", city: "Springfield", state: "IL", zip: "62701", virtualUrl: null }, start: { date: "2026-11-28", time: "10:00", timeZone: "America/Chicago" }, end: null, status: "scheduled", ...over })
const inTerritory = async () => (a: { city: string | null }) => a.city === "Springfield"
const noScreen = async () => (t: string) => /church|crime|school rating/i.test(t) ? "excluded_topic:steering" : null
const seedSources = (brokerageId: string) => [{ id: `sys-${brokerageId}`, brokerage_id: brokerageId, source_type: "manual", is_active: true, label: "system", source_config: { system_writer: "topic_intake" } }]
type PassDeps = NonNullable<Parameters<typeof LE.runLocalEventsPass>[2]>
const eventDeps = (over: PassDeps = {}): PassDeps => ({ now: NOW, intake: intakeTopicIdeas as never, retire: reevaluateRemovedTopicSource as never, ledger: ledger as never, inTerritory, screen: noScreen, arbiter: arbitrateFollowUp, decide: reply("what_to_know_reel", "social"), policy, transports: {}, ...over })

async function main() {
  console.log("E — local events (SIMULATED)")
  // E1 source rights
  check("E1a a public library calendar feed with recorded terms is authorized as public_read_reworded", (() => { const r = LE.authorizeEventSource(src()); return r.ok && r.rights === "public_read_reworded" })())
  const refusals = [
    LE.authorizeEventSource(src({ access: "web_page_scrape" })), LE.authorizeEventSource(src({ sourceClass: "licensed_event_feed", access: "licensed_api" })),
    LE.authorizeEventSource(src({ access: "licensed_api" })), LE.authorizeEventSource(src({ rights: { termsNote: null, recordedBy: null, recordedAt: null, licenseRef: null } })),
  ].map((r) => (r.ok ? "ok" : r.reason))
  check("E1b a page scrape, a licensed feed with no LICENSE, a class / access mismatch and unrecorded rights are each refused", JSON.stringify(refusals) === JSON.stringify(["access_not_authorized", "license_not_on_record", "access_not_authorized_for_class:library_calendar", "rights_not_recorded"]), JSON.stringify(refusals))

  // E2 unconfigured transport + counted transport
  {
    const db = makeDb({ content_topic_sources: [...seedSources(A),
      { id: "src-lic", brokerage_id: A, label: "Licensed feed", source_type: "manual", is_active: true, source_config: { local_event_source: { class: "licensed_event_feed", access: "licensed_api", license_ref: "LIC-1", terms_note: "contract", rights_recorded_at: "2026-11-01" } } },
      { id: "src-lib", brokerage_id: A, label: "Springfield Public Library", source_type: "rss", is_active: true, last_run_at: null, source_config: { feed_url: "https://library.springfield.gov/events.ics", local_event_source: { class: "library_calendar", access: "publisher_syndication_feed", terms_note: "public feed", rights_recorded_at: "2026-11-01", territory: { city: "Springfield", state: "IL" } } } }] })
    let feedCalls = 0
    const r = await LE.runLocalEventsPass(db as never, A, eventDeps({ markRun: true, transports: { publisher_syndication_feed: async () => { feedCalls++; return { ok: true, events: [ev()] } } } }))
    check("E2a an unconfigured transport (licensed_api — none contracted) says so and returns nothing", r.unconfigured.some((u) => u.sourceId === "src-lic" && /no transport configured/.test(u.reason)), JSON.stringify(r.unconfigured))
    check("E2b the configured transport is called exactly once and counted", feedCalls === 1 && r.transportCalls.publisher_syndication_feed === 1 && !("licensed_api" in r.transportCalls), JSON.stringify(r.transportCalls))
    check("E2c the run mark is the pass's own time, only on the source that answered, and ledgered", db.tables.content_topic_sources.find((x) => x.id === "src-lib")?.last_run_at === NOW.toISOString() && !db.tables.content_topic_sources.find((x) => x.id === "src-lic")?.last_run_at && ledgerCalls.includes("marketing.local_events.pass"))

    // E3 verified event → pool with provenance, newsletter candidate + other types
    const rows = db.tables.content_topic_bank ?? []
    const listing = rows.find((x) => x.raw_data?.dedup_key?.endsWith("fmt:newsletter_listing"))
    const others = rows.filter((x) => x.raw_data?.local_event && !x.raw_data.dedup_key.endsWith("fmt:newsletter_listing"))
    check("E3a the verified event entered content_topic_bank through the ONE intake (rows carry raw_data.intake)", r.verified === 1 && r.inserted >= 2 && rows.every((x) => x.raw_data?.intake?.source_kind === "local_event"), `verified=${r.verified} inserted=${r.inserted}`)
    check("E3b factual provenance: source URL, source class, official date, time + zone, venue, last verified", !!listing && listing.raw_data.provenance[0].source_url === ev().url && listing.raw_data.local_event.source_class === "library_calendar" && listing.raw_data.local_event.start_date === "2026-11-28" && listing.raw_data.local_event.time_zone === "America/Chicago" && listing.raw_data.local_event.venue === "Main Library" && listing.raw_data.local_event.last_verified_at === NOW.toISOString())
    const facts = await loadLocalFacts(db as never, A, { now: NOW })
    check("E3c it is a NEWSLETTER candidate: the newsletter writer's own grounding reader (loadLocalFacts) returns it", facts.facts.some((f) => f.topicId === listing?.id && f.eventStart === "2026-11-28"), JSON.stringify(facts))
    check("E3d …and appears as other creative types (reel, roundup, guides, resource page) — one row each, the fact on the listing only", others.length >= 4 && others.some((x) => x.categories.includes("event_format:what_to_know_reel")) && others.every((x) => !x.categories.includes("local_intel")), `others=${others.length}`)
    check("E3e a neutral listing yields NO invitation and its brief says no sponsorship is implied", !rows.some((x) => x.categories.includes("event_format:tenant_invitation")) && /NEUTRAL COMMUNITY LISTING/.test(listing?.value_angle ?? ""))
    check("E3f no source wording stored (no description field anywhere in the rows)", !JSON.stringify(rows).includes("\"description\""))
    // E7 arbiter
    const items = db.tables.approval_items ?? []
    check("E7a the arbiter (real door, injected model) chose a channel: one PENDING local_campaign_idea on the listing row", r.decisions.length === 1 && r.decisions[0].optionId === "what_to_know_reel" && r.decisions[0].channel === "social" && items.length === 1 && items[0].item_id === listing?.id && items[0].status === "pending", JSON.stringify(r.decisions))
    check("E7b the decision is ledgered", ledgerCalls.includes("marketing.local_event_opportunity.decide"))

    // E8 cancellation → correction through lineage
    db.tables.newsletter_campaigns = [{ id: "nl-1", brokerage_id: A, status: "scheduled", approval_status: "approved" }, { id: "nl-2", brokerage_id: A, status: "sent", approval_status: "approved" }]
    db.tables.social_posts = [{ id: "sp-1", brokerage_id: A, status: "scheduled", approval_status: "approved" }]
    db.tables.content_topic_uses = [{ brokerage_id: A, topic_id: listing!.id, asset_type: "newsletter_campaign", asset_id: "nl-1" }, { brokerage_id: A, topic_id: listing!.id, asset_type: "newsletter_campaign", asset_id: "nl-2" }, { brokerage_id: A, topic_id: others[0].id, asset_type: "social_post", asset_id: "sp-1" }]
    // positive control first: with no correction the scheduled newsletter still carries the obsolete event (the defect at base)
    check("E8-control without a correction the derived newsletter is still 'scheduled' + 'approved' (what would have sent wrong at base)", db.tables.newsletter_campaigns[0].status === "scheduled")
    const r2 = await LE.runLocalEventsPass(db as never, A, eventDeps({ transports: { publisher_syndication_feed: async () => ({ ok: true, events: [ev({ status: "canceled", title: "" })] }) } }))
    const after = db.tables.content_topic_bank.filter((x) => x.raw_data?.local_event?.source_event_key === "src-lib:uid-fair")
    check("E8a the cancellation was detected from the feed and corrected once", r2.corrections === 1 && r2.dropped.canceled === 1, JSON.stringify(r2))
    check("E8b every topic of the event is retired from the pool (status 'rejected') and its local_fact removed", after.length >= 5 && after.every((x) => x.status === "rejected" && x.raw_data.local_fact === null && x.raw_data.local_event.status === "canceled"), JSON.stringify(after.map((x) => x.status)))
    const facts2 = await loadLocalFacts(db as never, A, { now: NOW })
    check("E8c the newsletter writer's grounding no longer names the canceled event", !facts2.facts.some((f) => f.topicId === listing!.id))
    check("E8d the queued newsletter is HELD (deferred + pending_review, reason recorded) and the queued social post is back to draft + pending", db.tables.newsletter_campaigns[0].status === "deferred" && db.tables.newsletter_campaigns[0].approval_status === "pending_review" && /event_canceled/.test(db.tables.newsletter_campaigns[0].defer_reason) && db.tables.social_posts[0].status === "draft" && db.tables.social_posts[0].approval_status === "pending")
    check("E8e an already-sent newsletter is counted, never pretended unsent", db.tables.newsletter_campaigns[1].status === "sent")
    check("E8f the correction is ledgered", ledgerCalls.includes("marketing.local_event.correct"))
  }

  // E8g reschedule: old identity retired + held, new identity intaken with the new date
  {
    const db = makeDb({ content_topic_sources: seedSources(A) })
    await LE.runLocalEventsPass(db as never, A, eventDeps({ extraEvents: [{ source: src(), events: [ev()] }], onlyExtra: true }))
    const oldListing = db.tables.content_topic_bank.find((x) => x.raw_data.dedup_key.endsWith("fmt:newsletter_listing"))!
    db.tables.social_posts = [{ id: "sp-9", brokerage_id: A, status: "scheduled", approval_status: "approved" }]
    db.tables.content_topic_uses = [{ brokerage_id: A, topic_id: oldListing.id, asset_type: "social_post", asset_id: "sp-9" }]
    const r = await LE.runLocalEventsPass(db as never, A, eventDeps({ extraEvents: [{ source: src(), events: [ev({ start: { date: "2026-12-05", time: "10:00", timeZone: "America/Chicago" } })] }], onlyExtra: true }))
    const live = db.tables.content_topic_bank.filter((x) => x.status === "fresh" && x.raw_data.local_event?.start_date === "2026-12-05")
    check("E8g a reschedule retires the old date's topics, holds their draft, and intakes the event at its new date", r.corrections === 1 && oldListing.status === "stale" && db.tables.social_posts[0].status === "draft" && live.length >= 5, `corr=${r.corrections} old=${oldListing.status} live=${live.length}`)
    const r3 = await LE.runLocalEventsPass(db as never, A, eventDeps({ extraEvents: [{ source: src(), events: [ev({ start: { date: "2026-12-05", time: "10:00", timeZone: "America/Chicago" } })] }], onlyExtra: true }))
    check("E8h re-reading the rescheduled event changes nothing (no second correction)", r3.corrections === 0 && r3.inserted === 0, JSON.stringify({ c: r3.corrections, i: r3.inserted }))
  }

  // E5 verification refusals, E6 syndication dedup, E12 time zone, E7c decline
  {
    const db = makeDb({ content_topic_sources: seedSources(A) })
    const bad = [
      ev({ sourceEventKey: "k1", start: { date: null, time: null, timeZone: null } }), ev({ sourceEventKey: "k2", location: { kind: "unknown", venue: null, city: null, state: null, zip: null, virtualUrl: null } }),
      ev({ sourceEventKey: "k3", location: { kind: "physical", venue: "Hall", city: "Shelbyville", state: "IL", zip: null, virtualUrl: null } }), ev({ sourceEventKey: "k4", status: "canceled" }),
      ev({ sourceEventKey: "k5", start: { date: "2026-10-01", time: null, timeZone: null } }), ev({ sourceEventKey: "k6", title: "Church picnic at First Church" }), ev({ sourceEventKey: "k7", url: null }),
    ]
    const r = await LE.runLocalEventsPass(db as never, A, eventDeps({ extraEvents: [{ source: src(), events: bad }], onlyExtra: true }))
    check("E5 unverified date / location, outside territory, canceled, past, steering topic and a missing event URL are each refused, counted, and store NOTHING", r.verified === 0 && (db.tables.content_topic_bank ?? []).length === 0 && ["unverified_date", "unverified_location", "outside_territory", "canceled", "past", "excluded_topic:steering", "no_event_url"].every((k) => r.dropped[k] === 1), JSON.stringify(r.dropped))

    const chamber = src({ id: "src-chamber", label: "Springfield Chamber", sourceClass: "chamber_of_commerce", url: "https://springfieldchamber.org/cal.ics" })
    const r2 = await LE.runLocalEventsPass(db as never, A, eventDeps({ decide: reply("decline"), extraEvents: [{ source: src(), events: [ev()] }, { source: chamber, events: [ev({ sourceEventKey: "ch-77", url: "https://springfieldchamber.org/e/77", title: "The Fall Book Fair" })] }], onlyExtra: true }))
    const listings = db.tables.content_topic_bank.filter((x) => x.raw_data.dedup_key.endsWith("fmt:newsletter_listing"))
    check("E6 the same event syndicated by the library AND the chamber is ONE row per format, with two provenance observations", listings.length === 1 && listings[0].raw_data.independent_observations === 2 && r2.inserted === 6 && r2.merged === 6, `listings=${listings.length} obs=${listings[0]?.raw_data.independent_observations} ins=${r2.inserted} mer=${r2.merged}`)
    check("E7c the arbiter may DECLINE: no approval item is filed", r2.decisions.length === 1 && r2.decisions[0].optionId === "decline" && (db.tables.approval_items ?? []).length === 0, JSON.stringify(r2.decisions))
    const r12 = await LE.runLocalEventsPass(db as never, A, eventDeps({ decide: reply("decline"), extraEvents: [{ source: src(), events: [ev({ sourceEventKey: "k12", url: "https://library.springfield.gov/events/evening-talk", title: "Evening Author Talk", start: { date: "2026-11-30", time: "18:30", timeZone: null } })] }], onlyExtra: true }))
    const talk = db.tables.content_topic_bank.find((x) => x.raw_data.local_event?.source_event_key === "src-lib:k12")
    check("E12 a time with no time zone is dropped (the date stands, with a note); a zoned time is kept", r12.verified === 1 && !!talk && talk.raw_data.local_event.start_time === null && /without a time zone/.test(talk.raw_data.local_event.time_note ?? "") && listings[0].raw_data.local_event.time_zone === "America/Chicago")
  }

  // E4 hosted → invitation; E9 no person; E10 two tenants
  {
    const db = makeDb({ content_topic_sources: [...seedSources(A), ...seedSources(B)] })
    const tenantSrcA = LE.tenantEventSource(A, "Acme Realty", "u-a", NOW)
    const rA = await LE.runLocalEventsPass(db as never, A, eventDeps({ extraEvents: [{ source: tenantSrcA, events: [ev({ sourceEventKey: "own-1", url: "https://acmerealty.com/events/homebuyer-night", title: "Homebuyer Night", hostedByTenant: true })] }, { source: src(), events: [ev()] }], onlyExtra: true }))
    const rB = await LE.runLocalEventsPass(db as never, B, eventDeps({ extraEvents: [{ source: src({ brokerageId: B }), events: [ev()] }], onlyExtra: true }))
    const rowsA = db.tables.content_topic_bank.filter((x) => x.brokerage_id === A), rowsB = db.tables.content_topic_bank.filter((x) => x.brokerage_id === B)
    check("E4 a tenant-HOSTED event yields a tenant_invitation (rights own_content); the public event does not", rowsA.some((x) => x.categories.includes("event_format:tenant_invitation") && x.raw_data.intake.rights === "own_content") && !rowsB.some((x) => x.categories.includes("event_format:tenant_invitation")))
    check("E10a two tenants each hold their OWN rows for the same public event (no shared row)", rowsA.length > 0 && rowsB.length > 0 && rowsA.every((x) => x.raw_data.brand_owner_brokerage_id === A) && rowsB.every((x) => x.raw_data.brand_owner_brokerage_id === B), `A=${rowsA.length} B=${rowsB.length} ${rA.errors.join(";")} ${rB.errors.join(";")}`)
    check("E10b tenant B's rows carry nothing of tenant A (no id, no brand name, no A-only event)", !JSON.stringify(rowsB).includes(A) && !JSON.stringify(rowsB).includes("Acme Realty") && !JSON.stringify(rowsB).includes("Homebuyer Night"))
    const personTables = ["contacts", "leads", "raw_leads", "raw_data", "event_attendance_evidence", "open_house_registrations", "event_registrations"]
    const allWrites = db.writes.map((w) => w.table)
    check("E9 no RSVP, attendee, Contact or Lead is written by any event path", !allWrites.some((t) => personTables.includes(t)) && !/rsvp|attendee|registrant/i.test(JSON.stringify(db.tables.content_topic_bank)), [...new Set(allWrites)].join(","))
    const planted = makeDb(); await planted.from("contacts").insert({ id: "c1" })
    check("E9-control the write recorder DOES see a planted Contact insert", planted.writes.some((w) => w.table === "contacts"))
  }

  // E11 stale listing
  {
    const db = makeDb({ content_topic_sources: [...seedSources(A), { id: "src-lib", brokerage_id: A, label: "Springfield Public Library", source_type: "rss", is_active: true, last_run_at: null, source_config: { local_event_source: { class: "library_calendar", access: "publisher_syndication_feed" } } }] })
    await LE.runLocalEventsPass(db as never, A, eventDeps({ extraEvents: [{ source: src(), events: [ev()] }], onlyExtra: true }))
    const fresh = await LE.loadEventOpportunities(db as never, A, { now: NOW })
    db.tables.content_topic_sources[1].last_run_at = new Date(NOW.getTime() + 86_400_000).toISOString()
    const later = await LE.loadEventOpportunities(db as never, A, { now: NOW })
    check("E11 a listing re-verified in the latest pass is current; once its source ran without it, it reads STALE", fresh.rows.length >= 5 && fresh.rows.every((x) => !x.stale) && later.rows.every((x) => x.stale), `${fresh.rows.length}/${later.rows.filter((x) => x.stale).length}`)
  }

  {
    const feedRow = { id: "src-feed", brokerage_id: A, label: "Springfield Parks", source_type: "rss", is_active: true, last_run_at: null, source_config: { feed_url: "https://parks.springfield.gov/cal.ics", local_event_source: { class: "parks_calendar", access: "publisher_syndication_feed", terms_note: "public feed", rights_recorded_at: "2026-11-01", territory: { city: "Springfield", state: "IL" } } } }
    const ics = (cancelled: boolean) => ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a1", ...(cancelled ? ["STATUS:CANCELLED"] : []), "DTSTART;TZID=America/Chicago:20261128T100000", "SUMMARY:Holiday Lights Walk", "LOCATION:Washington Park", "END:VEVENT", "END:VCALENDAR"].join("\r\n")
    const fetched: string[] = []
    const fetchText = (cancelled: boolean, robots = "User-agent: *\nAllow: /") => async (url: string) => { fetched.push(url); return { ok: true, status: 200, text: url.endsWith("/robots.txt") ? robots : ics(cancelled) } }
    const db = makeDb({ content_topic_sources: [...seedSources(A), feedRow] })
    const p1 = await LE.runLocalEventsPass(db as never, A, eventDeps({ transports: undefined, fetchText: fetchText(false), decide: reply("decline") }))
    const walk = (db.tables.content_topic_bank ?? []).find((x) => x.raw_data.local_event?.source_event_key === "src-feed:a1")
    check("E13a the DEFAULT syndication transport reads robots.txt first, then the feed (injected fetch, 2 calls), and keeps the DTSTART zone + time parseIcsEvents drops", p1.verified === 1 && fetched.length === 2 && fetched[0].endsWith("/robots.txt") && walk?.raw_data.local_event.time_zone === "America/Chicago" && walk?.raw_data.local_event.start_time === "10:00", JSON.stringify({ v: p1.verified, fetched, e: p1.errors }))
    const p2 = await LE.runLocalEventsPass(db as never, A, eventDeps({ transports: undefined, fetchText: fetchText(true), decide: reply("decline") }))
    check("E13b a STATUS:CANCELLED in the feed (skipped by parseIcsEvents at base) is detected and corrects the stored event", p2.corrections === 1 && db.tables.content_topic_bank.filter((x) => x.raw_data.local_event?.source_event_key === "src-feed:a1").every((x) => x.status === "rejected"), JSON.stringify({ c: p2.corrections, d: p2.dropped }))
    const p3 = await LE.runLocalEventsPass(makeDb({ content_topic_sources: [...seedSources(A), feedRow] }) as never, A, eventDeps({ transports: undefined, fetchText: fetchText(false, "User-agent: *\nDisallow: /") }))
    check("E13c a feed whose robots.txt disallows us is not read (unconfigured: robots_disallowed, nothing stored)", p3.verified === 0 && p3.unconfigured.some((u) => u.reason === "robots_disallowed"), JSON.stringify(p3.unconfigured))
  }

  console.log("C — top-producer learning in circles (SIMULATED)")
  const P = "u-producer", M1 = "u-member1", M2 = "u-member2", X = "u-outsider", OT = "u-other-tenant"
  const campaigns: CT.CampaignOutcome[] = [
    { campaignId: "camp-t1", type: "video", agentUserId: P, contactsReached: 40, appointments: 6 },
    { campaignId: "camp-b1", type: "video", agentUserId: P, contactsReached: 50, appointments: 2 }, { campaignId: "camp-b2", type: "video", agentUserId: P, contactsReached: 30, appointments: 1 },
    { campaignId: "camp-b3", type: "video", agentUserId: P, contactsReached: 45, appointments: 2 }, { campaignId: "camp-other", type: "video", agentUserId: "u-someone", contactsReached: 500, appointments: 1 },
  ]
  {
    const roi = stripComments(readFileSync(join(ROOT, "lib/intelligence/roi-ledger.ts"), "utf8"))
    const sl = stripComments(readFileSync(join(ROOT, "lib/kernel/strategy-library.ts"), "utf8"))
    check("C2 the rule's numbers are the repo's own: ROI_MIN_COMPARABLE, HISTORY_MIN_SAMPLE and the reader's 90-day window match their sources", new RegExp(`const ROI_MIN_COMPARABLE = ${CT.ROI_MIN_COMPARABLE_CAMPAIGNS}\\b`).test(roi) && new RegExp(`generateRoiLedger\\([^)]*periodDays = ${CT.EVIDENCE_WINDOW_DAYS}\\b`).test(roi) && /export const HISTORY_MIN_SAMPLE = \d+/.test(sl))
  }

  const circleSeed = () => ({
    teams: [{ id: "team-1", brokerage_id: A, deleted_at: null, name: "North" }, { id: "team-2", brokerage_id: A, deleted_at: null, name: "South" }, { id: "team-b", brokerage_id: B, deleted_at: null, name: "Other" }],
    agents: [{ id: "ag-p", user_id: P, brokerage_id: A, is_active: true }, { id: "ag-m1", user_id: M1, brokerage_id: A, is_active: true }, { id: "ag-m2", user_id: M2, brokerage_id: A, is_active: true }, { id: "ag-x", user_id: X, brokerage_id: A, is_active: true }, { id: "ag-ot", user_id: OT, brokerage_id: B, is_active: true }],
    team_members: [{ team_id: "team-1", brokerage_id: A, agent_id: "ag-p", is_active: true, effective_to: null }, { team_id: "team-1", brokerage_id: A, agent_id: "ag-m1", is_active: true, effective_to: null }, { team_id: "team-1", brokerage_id: A, agent_id: "ag-m2", is_active: true, effective_to: null }, { team_id: "team-2", brokerage_id: A, agent_id: "ag-x", is_active: true, effective_to: null }, { team_id: "team-b", brokerage_id: B, agent_id: "ag-ot", is_active: true, effective_to: null }],
    farm_territories: [{ brokerage_id: A, agent_id: "ag-p", city: "Springfield", state: "IL", is_active: true }, { brokerage_id: A, agent_id: "ag-m1", city: "Springfield", state: "IL", is_active: true }, { brokerage_id: A, agent_id: "ag-m2", city: "Peoria", state: "IL", is_active: true }],
    agent_mentor_relationships: [], content_topic_sources: seedSources(A),
  })
  const decideCalls: string[] = []
  const perMember = async (a: { prompt: string }) => { decideCalls.push(a.prompt); const peoria = /member market: Peoria/.test(a.prompt); return { optionId: peoria ? "ignore_different_audience" : "recommend_adaptation", channel: peoria ? null : "in_app", format: null, waitHours: peoria ? 24 : null, rationale: peoria ? "Different market." : "Fits once localized.", evidence: ["moment"], confidence: 0.8 } }
  const circleDeps = (db: Db, over: Partial<CT.CircleDeps> = {}): CT.CircleDeps => ({ now: NOW, ledger: ledger as never, intake: intakeTopicIdeas as never, screens: { personalData: personalDataProblem, nearCopy: rewordedNearCopyProblem }, arbiter: arbitrateFollowUp, decide: perMember, policy, roi: async () => ({ ok: true, complete: true, campaigns }), ...over })
  const method = "Open with a consumer question, answer it in a short FAQ video, add a timely local fact, close personally"
  const shareInput: CT.ShareInput = { circle: { kind: "team", teamId: "team-1" }, method, components: ["consumer_question_first_hook", "short_video_faq", "timely_hyperlocal_fact", "personal_close"], explanation: "Viewers stay for the answer.", sourceKind: "producer_outcome", tacticCampaignIds: ["camp-t1"] }
  {
    // C1 / C3 drive the PUBLIC door (shareCircleTactic) — the classifier and the strip are module-private.
    const qualityOf = async (cs: CT.CampaignOutcome[], ids: string[]) => { const db = makeDb(circleSeed()); const r = await CT.shareCircleTactic(db as never, { userId: P, brokerageId: A }, { ...shareInput, tacticCampaignIds: ids }, circleDeps(db, { decide: reply("recommend_adaptation", "in_app"), roi: async () => ({ ok: true, complete: true, campaigns: cs }) })); return r.ok ? r.quality : r.reason }
    check("C1a attributable_comparable needs ≥ HISTORY_MIN_SAMPLE reached, ≥ 3 comparable own campaigns, and a higher rate", (await qualityOf(campaigns, ["camp-t1"])) === "attributable_comparable")
    const shortfalls = [await qualityOf(campaigns.map((c) => c.campaignId === "camp-t1" ? { ...c, contactsReached: 12 } : c), ["camp-t1"]), await qualityOf(campaigns.filter((c) => c.campaignId !== "camp-b3"), ["camp-t1"]), await qualityOf(campaigns.map((c) => c.campaignId === "camp-t1" ? { ...c, appointments: 0 } : c), ["camp-t1"]), await qualityOf(campaigns, ["camp-gone"]), await qualityOf(campaigns, ["camp-other"])]
    check("C1b each shortfall is LABELED: small sample · thin cohort · no lift · outside the window · someone else's campaign", JSON.stringify(shortfalls) === JSON.stringify(["insufficient_sample", "no_comparable_cohort", "no_measured_lift", "outdated", "outdated"]), JSON.stringify(shortfalls))
    const tryShare = async (over: Partial<CT.ShareInput>) => { const db = makeDb(circleSeed()); const r = await CT.shareCircleTactic(db as never, { userId: P, brokerageId: A }, { ...shareInput, ...over }, circleDeps(db, { decide: reply("recommend_adaptation", "in_app") })); return r.ok ? "ok" : r.reason }
    check("C3a a generalized method passes the strip", (await tryShare({})) === "ok")
    const bads = await Promise.all(["see https://mysite.com/video", "it drove $12k in GCI", "a 38% lift", "call 555-201-3344", "email me jo@x.com", "credit @jo.realtor", "we booked 14 appointments"].map((m) => tryShare({ method: `Question-first FAQ video; ${m}` })))
    const cap = "Wondering what your home is worth this spring in Springfield? Here is the one number that matters most"
    const copy = await tryShare({ method: cap, caption: cap }), unknown = await tryShare({ components: ["made_up"] })
    check("C3b a link, money, a percentage, a phone, an email, a handle, an exact count, the producer's own caption and an unknown component are REFUSED before anything is stored", bads.every((b) => b.startsWith("brief_refused:")) && copy === "brief_refused:method:caption_copy" && unknown === "brief_refused:unknown_component", JSON.stringify([...bads, copy, unknown]))
  }
  {
    const db = makeDb(circleSeed())
    const s = await CT.shareCircleTactic(db as never, { userId: P, brokerageId: A }, shareInput, circleDeps(db))
    check("C4a a verified opted-in producer shares to their EXISTING team circle (evidence measured by the ROI reader)", s.ok && s.quality === "attributable_comparable" && s.sourceLabel === "measured_by_roi_reader" && db.tables.circle_tactic_shares.length === 1, JSON.stringify(s))
    check("C4b the arbiter's door decided each member individually (real arbitrateFollowUp, injected model)", s.ok && s.evaluated === 2 && s.offered === 1 && decideCalls.length === 2, JSON.stringify(s))
    const notMember = await CT.shareCircleTactic(db as never, { userId: X, brokerageId: A }, shareInput, circleDeps(db))
    const foreignTeam = await CT.shareCircleTactic(db as never, { userId: P, brokerageId: A }, { ...shareInput, circle: { kind: "team", teamId: "team-b" } }, circleDeps(db))
    check("C4c a non-member cannot share to the team; another tenant's team is refused", !notMember.ok && notMember.reason === "producer_not_a_member_of_circle" && !foreignTeam.ok && foreignTeam.reason === "team_not_in_tenant")
    const v1 = await CT.listCircleTacticsForViewer(db as never, { userId: M1, brokerageId: A }, { now: NOW })
    const v2 = await CT.listCircleTacticsForViewer(db as never, { userId: M2, brokerageId: A }, { now: NOW })
    const vx = await CT.listCircleTacticsForViewer(db as never, { userId: X, brokerageId: A }, { now: NOW })
    const vot = await CT.listCircleTacticsForViewer(db as never, { userId: OT, brokerageId: B }, { now: NOW })
    check("C5a a team member sees the method with its evidence quality and the arbiter's decision", v1.visible.length === 1 && v1.visible[0].decision === "recommend_adaptation" && v1.visible[0].evidenceQuality === "attributable_comparable")
    check("C5b the arbiter IGNORED it for the member in a different market: they are not shown it (never copied to every member)", v2.visible.length === 0)
    check("C5c a non-member of the team and another tenant's user see NOTHING", vx.visible.length === 0 && vot.visible.length === 0 && vot.mine.length === 0)
    const stored = JSON.stringify(db.tables.circle_tactic_shares)
    const view = JSON.stringify(v1.visible)
    check("C7 no raw data crosses: no campaign id, no reach / appointment figure, no producer identity in the view, no caption", !/camp-t1|camp-b\d/.test(stored) && !/\b(40|50|30|45|6)\b/.test(JSON.stringify(db.tables.circle_tactic_shares[0].brief)) && !view.includes(P) && !/"(contactsReached|appointments|revenue|earned)"/.test(stored))
    check("C7-control the figure scan DOES see a planted figure", /\b(40|50|30|45|6)\b/.test(JSON.stringify({ reached: 40 })))
    const ad = await CT.adaptCircleTactic(db as never, { userId: M1, brokerageId: A }, String(s.ok && s.shareId), circleDeps(db))
    const topic = (db.tables.content_topic_bank ?? []).find((x) => x.id === ad.topicId)
    check("C9a the member adapts it in THEIR voice: a NEW topic in the one pool, brand-owned by the member, carrying no producer identity", ad.ok && !!topic && topic.raw_data.brand_owner_user_id === M1 && topic.raw_data.circle_adaptation.for_agent_user_id === M1 && !JSON.stringify(topic).includes(P) && topic.raw_data.intake.source_kind === "circle_tactic", JSON.stringify(ad))
    const ad2 = await CT.adaptCircleTactic(db as never, { userId: M1, brokerageId: A }, String(s.ok && s.shareId), circleDeps(db))
    check("C9b adapting twice returns the same topic (one adaptation per member)", ad2.ok && ad2.topicId === ad.topicId && db.tables.content_topic_bank.filter((x) => x.raw_data?.circle_adaptation).length === 1)
    const adx = await CT.adaptCircleTactic(db as never, { userId: X, brokerageId: A }, String(s.ok && s.shareId), circleDeps(db))
    check("C5d a non-member cannot adapt it", !adx.ok && adx.reason === "not_visible_to_you")
    db.tables.agents.push({ id: "ag-m3", user_id: "u-member3", brokerage_id: A, is_active: true }); db.tables.team_members.push({ team_id: "team-1", brokerage_id: A, agent_id: "ag-m3", is_active: true, effective_to: null })
    const late = await CT.listCircleTacticsForViewer(db as never, { userId: "u-member3", brokerageId: A }, { now: NOW })
    const ev3 = await CT.evaluateCircleTacticForMe(db as never, { userId: "u-member3", brokerageId: A }, String(s.ok && s.shareId), circleDeps(db))
    check("C5g a member who joined after the share sees it undecided, asks, and gets the arbiter's own decision (ledgered)", late.visible.length === 1 && late.visible[0].decision === null && ev3.ok && ev3.decision === "recommend_adaptation" && ledgerCalls.includes("marketing.circle_tactic.evaluate"), JSON.stringify(ev3))
    // membership revoked
    db.tables.team_members.find((m) => m.agent_id === "ag-m1")!.is_active = false
    const vRevoked = await CT.listCircleTacticsForViewer(db as never, { userId: M1, brokerageId: A }, { now: NOW })
    check("C5e a member removed from the team sees nothing on the very next read", vRevoked.visible.length === 0)
    db.tables.team_members.find((m) => m.agent_id === "ag-m1")!.is_active = true
    db.tables.team_members.find((m) => m.agent_id === "ag-p")!.effective_to = "2026-11-01T00:00:00Z"
    const vDeparted = await CT.listCircleTacticsForViewer(db as never, { userId: M1, brokerageId: A }, { now: NOW })
    check("C5f a producer who left the team takes the share with them (members see nothing)", vDeparted.visible.length === 0)
    db.tables.team_members.find((m) => m.agent_id === "ag-p")!.effective_to = null
    // expiry
    const vLater = await CT.listCircleTacticsForViewer(db as never, { userId: M1, brokerageId: A }, { now: new Date(NOW.getTime() + 91 * 86_400_000) })
    check("C11 past its evidence window the share is withheld (and reads 'expired' to its producer)", vLater.visible.length === 0 && (await CT.listCircleTacticsForViewer(db as never, { userId: P, brokerageId: A }, { now: new Date(NOW.getTime() + 91 * 86_400_000) })).mine[0]?.status === "expired")
    // revoke
    const notMine = await CT.revokeCircleTactic(db as never, { userId: M1, brokerageId: A }, String(s.ok && s.shareId), circleDeps(db))
    const rv = await CT.revokeCircleTactic(db as never, { userId: P, brokerageId: A }, String(s.ok && s.shareId), circleDeps(db))
    const vAfter = await CT.listCircleTacticsForViewer(db as never, { userId: M1, brokerageId: A }, { now: NOW })
    check("C6a only the producer can opt out; after opting out no member sees it", !notMine.ok && rv.ok && vAfter.visible.length === 0)
    check("C6b opting out did not undo attributed history: the member's adapted topic is still in the pool", db.tables.content_topic_bank.some((x) => x.id === ad.topicId && x.status === "fresh"))
    check("C6c share / adapt / revoke are each ledgered", ["marketing.circle_tactic.share", "marketing.circle_tactic.adapt", "marketing.circle_tactic.revoke"].every((a) => ledgerCalls.includes(a)))
  }
  {
    const db = makeDb(circleSeed())
    const before = decideCalls.length
    const thin = await CT.shareCircleTactic(db as never, { userId: P, brokerageId: A }, { ...shareInput, claimedTitle: "Top Producer 2026", tacticCampaignIds: ["camp-gone"] }, circleDeps(db))
    const v = await CT.listCircleTacticsForViewer(db as never, { userId: M1, brokerageId: A }, { now: NOW })
    const ad = await CT.adaptCircleTactic(db as never, { userId: M1, brokerageId: A }, String(thin.ok && thin.shareId), circleDeps(db))
    check("C10a outdated evidence + a self-entered title: labeled 'outdated' / 'self_entered_title', HELD for every member without asking the model", thin.ok && thin.quality === "outdated" && thin.sourceLabel === "self_entered_title" && v.visible[0]?.decision === "hold_for_evidence" && decideCalls.length === before, JSON.stringify(thin))
    check("C12 a held method cannot be adapted (never offered as proven)", !ad.ok && ad.reason === "arbiter_decided:hold_for_evidence")
    const comp = await CT.shareCircleTactic(db as never, { userId: P, brokerageId: A }, { ...shareInput, method: "Answer one local buying question per week in a carousel with a checklist", components: ["checklist_format", "consumer_question_first_hook"], sourceKind: "competitor_public_idea", tacticCampaignIds: [] }, circleDeps(db, { roi: async () => { throw new Error("the ROI reader must not be read for a competitor idea") } }))
    check("C10b a competitor's public idea is labeled an idea with UNKNOWN conversions (no ROI read)", comp.ok && comp.quality === "idea_unknown_conversions" && comp.sourceLabel === "competitor_public_idea", JSON.stringify(comp))
  }

  console.log("S — static (stripped source)")
  const lanes = ["lib/newsletter/local-events.ts", "lib/marketing/circle-tactics.ts", "app/actions/events-and-circles.ts"]
  const directInsert = /\.from\(\s*["'`]content_topic_bank["'`]\s*\)\s*\.(insert|upsert)\(/
  check("S1 no direct insert into content_topic_bank in the lane's modules (the ONE intake only)", lanes.every((f) => !directInsert.test(stripComments(readFileSync(join(ROOT, f), "utf8")))))
  check("S1-control the finder DOES see a direct insert specimen", directInsert.test(`db.from("content_topic_bank").insert({})`))
  const noEgress = /\bfetch\s*\(|callConnector\s*(?:<[^>]*>)?\(/g
  check("S2 the circle module makes no network call; the events module's only egress is the syndication transport (connector gateway)", !noEgress.test(blankStrings(stripComments(readFileSync(join(ROOT, "lib/marketing/circle-tactics.ts"), "utf8")))) && (blankStrings(stripComments(readFileSync(join(ROOT, "lib/newsletter/local-events.ts"), "utf8"))).match(noEgress) ?? []).length === 1)
  check("S2-control the egress finder DOES see a generic call specimen", ("x = callConnector<string>({})".match(noEgress) ?? []).length === 1)
  // The RULE, not a waypoint: the file states exactly one status on line 1, and that status agrees with the live table
  // cache (a header saying "applied" about a table the database does not have, or the reverse, is the defect).
  const m973Line1 = readFileSync(join(ROOT, "supabase/migrations/m973-circle-tactic-shares.sql"), "utf8").split("\n")[0]
  const m973SaysApplied = /APPLIED LIVE \d{4}-\d{2}-\d{2}/.test(m973Line1)
  const m973SaysWritten = m973Line1.startsWith("-- WRITTEN, NOT APPLIED")
  check("S3 m973 states one status on line 1 and it agrees with the live table cache", m973SaysApplied !== m973SaysWritten && m973SaysApplied === LIVE_TABLES.includes("circle_tactic_shares"))
  check("S3-control the status reader tells the two headers apart", /APPLIED LIVE \d{4}-\d{2}-\d{2}/.test("-- ── APPLIED LIVE 2026-01-01 via x") && !/APPLIED LIVE \d{4}-\d{2}-\d{2}/.test("-- WRITTEN, NOT APPLIED (wave 1)"))
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  check("S4 test:events-and-circles is registered and on the guard chain", typeof pkg.scripts["test:events-and-circles"] === "string" && String(pkg.scripts.guard).includes("npm run test:events-and-circles"))

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
