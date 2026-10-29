#!/usr/bin/env tsx
/**
 * scripts/customer-360-guard.ts  (npm run test:customer-360)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 146, LANE 146D — owner rulings 11 and 13, DRIVEN through the real modules on an in-memory database (no network, no model,
 * no vendor), each refusal beside its positive control:
 *
 *   A. RULING 11 / CONTRACT C6 — `customer360For(svc, brokerageId, party)` (lib/enrichment/customer-360.ts) is a READ over the
 *      canonical graph: field-level source / timestamp / confidence / consent / purpose / ownership; honest freshness (a provider
 *      fact is never "real-time"); append ≠ intent (only a stated basis is confirmed); C2 (a converted lead is read as its contact);
 *      tenant-pinned; a refused core read refuses, a refused secondary read degrades and is NAMED; no write, no provider, no
 *      financial column; every selected column exists in the live-schema cache (scripts/schema-snapshot.ts).
 *   B. RULING 11 — THE FIRST-PARTY WATCHER (lib/enrichment/first-party-intent-watcher.ts): a START or RESUMPTION of search / view
 *      or portal engagement after the TENANT's dormancy window → ONE durable consumed-once ledger event carrying the party's
 *      Customer 360 context → the ONE life-change responder (driven for real: lead / contact / lifetime doors); continuing activity,
 *      a first portal visit, an inactive lead and another tenant's rows never route; an unread history is held (fail closed); the
 *      spellings are the responder's own; wired on the 15-minute enrichment-processor tick with no new cron.
 *   C. RULING 13 — protected-class columns are LABELLED by the one classifier and WITHHELD from the outreach view (never rewritten,
 *      never deleted); their absence blocks nothing; the segregated research store is never named or read here.
 *   D. CONTRACT C4 — the signal `lead_magnet_promise_undelivered` is catalogued with the kind the live classifier gives it.
 *
 * Scans read STRIPPED source (scripts/strip-comments.ts) — a tombstone is not a call site. BLIND SPOTS, published: the in-memory
 * client's `.or()` / `.in()` grammar is the subset the kernel uses (real PostgREST is a superset); the cron route is asserted by its
 * stripped call site, not executed; `property_views` keeps one aggregate row per (contact, property), so a repeat view overwrites
 * the prior `last_viewed_at` and an older view of the SAME property is invisible to the dormancy read (stated in the watcher's notes).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, stringLiterals } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const AG = "44444444-4444-4444-8444-444444444444"
const NOW = new Date("2026-10-29T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const LEDGER_UNIQUE = { agent_action_ledger: [["idempotency_key"]] }
const C360 = "lib/enrichment/customer-360.ts"
const WATCH = "lib/enrichment/first-party-intent-watcher.ts"

/** A recording wrapper: every (table, op, select-columns) the module asks for — the proof's window onto what it READS and WRITES. */
function recording(db: ReturnType<typeof memSupabase>) {
  const log: Array<{ table: string; op: string; cols: string | null }> = []
  const proxy = {
    tables: db.tables,
    from(t: string) {
      const q = db.from(t) as any
      for (const op of ["select", "insert", "update", "upsert", "delete"]) {
        const orig = q[op].bind(q)
        q[op] = (arg?: unknown, o?: unknown) => { log.push({ table: t, op, cols: op === "select" && typeof arg === "string" ? arg : null }); return orig(arg, o) }
      }
      return q
    },
  }
  return { proxy, log }
}

const stamp = (source: string, capability: string, retrievedAt: string, purpose: string, matchConfidence: string | null = null) => ({ source, capability, retrievedAt, purpose, matchConfidence, actor: null })

function seed360() {
  return {
    contacts: [
      {
        id: "c-buyer", brokerage_id: B, agent_id: AG, team_id: null, first_name: "Ana", last_name: "Buyer", email: "ana@example.com", phone: "+15125550100",
        address: "1 Main St", city: "Austin", state: "TX", zip_code: "78701", mailing_address: null, contact_type: "buyer", lifecycle_state: "active", buyer_stage: "BUYER_SEARCHING",
        preferred_channel: "sms", preferred_language: "es", timeline: "1-3", budget_max: 650000, tcpa_consent: true, email_opt_out: false, sms_opt_out: false, phone_opt_out: false,
        call_stop_flag: false, direct_mail_opt_out: false, deleted_at: null, last_enriched_at: daysAgo(30), created_at: daysAgo(400),
        gender: "female", marital_status: "married", household_income: "$100k-$150k", age_range: null,
        metadata: { context_spine: { summary: "Last touch 2 days ago (sms outbound): sent 3 matches.", lastTouch: daysAgo(2), sentiment: "positive", interactionCount: 7 } },
        enrichment_profile: {
          captured_at: daysAgo(30), job_start_date: "2026-08-01",
          real_estate_indicators: { provider: "versium", captured_at: daysAgo(200), onlinePresenceRealEstate: true },
          field_provenance: {
            email: stamp("staff", "crm.contact_edit", daysAgo(100), "staff_edit"),
            timeline: stamp("staff", "crm.contact_edit", daysAgo(10), "staff_edit"),
            gender: stamp("versium", "person.enrich_demographic", daysAgo(200), "data_sourcing", "0.8"),
            real_estate_indicators: stamp("versium", "person.enrich_online_presence", daysAgo(200), "enrichment"),
            job_start_date: stamp("peopledata", "person.enrich_profile", daysAgo(30), "enrichment", "0.92"),
          },
        },
      },
      { id: "c-plain", brokerage_id: B, agent_id: AG, first_name: "Pat", last_name: "Plain", email: null, phone: null, contact_type: "seller", lifecycle_state: "active", timeline: "6-12", deleted_at: null, enrichment_profile: null, metadata: {} },
      { id: "c-life", brokerage_id: B, agent_id: AG, first_name: "Lee", last_name: "Past", email: "lee@example.com", contact_type: "lifetime_customer", lifecycle_state: "lifetime_customer", deleted_at: null, enrichment_profile: null, metadata: {} },
      { id: "c-other", brokerage_id: B2, agent_id: AG, first_name: "Other", last_name: "Tenant", email: "o@example.com", contact_type: "buyer", deleted_at: null, enrichment_profile: null, metadata: {} },
    ],
    leads: [
      { id: "l-open", brokerage_id: B, contact_id: null, is_active: true, first_name: "Lo", last_name: "Open", email: "lo@example.com", phone: "+15125550111", preferred_channel: "sms", lead_type: "buyer", timeline: "3-6", tcpa_consent: true, email_opt_out: false, enrichment_profile: null },
      { id: "l-conv", brokerage_id: B, contact_id: "c-buyer", converted_at: daysAgo(300), is_active: true, first_name: "Ana", last_name: "Buyer", email: "ana@example.com", enrichment_profile: null },
    ],
    contact_consent_events: [{ id: "ce1", brokerage_id: B, contact_id: "c-buyer", consent_type: "sms", consented: true, created_at: daysAgo(90), consent_source: "web_form" }],
    saved_properties: [{ id: "sp1", brokerage_id: B, contact_id: "c-buyer", saved_at: daysAgo(3), dismissed: false }],
    property_views: [{ id: "pv1", brokerage_id: B, contact_id: "c-buyer", last_viewed_at: daysAgo(1), view_count: 4 }],
    showings: [{ id: "sh1", brokerage_id: B, contact_id: "c-buyer", scheduled_at: daysAgo(5), status: "completed" }],
    form_submissions: [], client_portal_activity: [], portal_access_logs: [], website_visitors: [], showing_requests: [],
    activities: [{ id: "a1", brokerage_id: B, contact_id: "c-buyer", created_at: daysAgo(2) }],
    agent_client_messages: [{ id: "m1", brokerage_id: B, recipient_contact_id: "c-buyer", sent_at: daysAgo(2) }],
    transactions: [{ id: "tx1", brokerage_id: B, status: "closed", stage: "closed", close_date: "2021-06-01", property_address: "9 Elm", buyer_contact_id: "c-life", seller_contact_id: null, contact_id: "c-life", deleted_at: null, purchase_price: 400000, commission_amount: 12000 }],
    relationship_edges: [], person_identities: [], person_identity_evidence: [],
    signal_reactivations: [
      { id: "sr1", brokerage_id: B, contact_id: "c-buyer", lead_id: null, signal_type: "buying_intent", signal_data: { source: "enrichment:versium", kind: "buying" }, triggered_at: daysAgo(4) },
      { id: "sr2", brokerage_id: B, contact_id: "c-life", lead_id: null, signal_type: "next_move_intent", signal_data: { source: "portal", kind: "moving" }, triggered_at: daysAgo(6) },
    ],
  }
}

async function main() {
  const c360 = await import("../lib/enrichment/customer-360")
  const watcher = await import("../lib/enrichment/first-party-intent-watcher")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const { withActionLedger } = await import("../lib/kernel/action-ledger")
  const { protectedClassReasonFor } = await import("../lib/lead-governance/protected-class-signals")

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ A · CONTRACT C6 — the Customer 360 read: provenance, consent, freshness, append ≠ intent, C2, tenancy ━━━")
  {
    const db = memSupabase(seed360() as never, { uuidIds: true })
    const { proxy, log } = recording(db)
    const r = await quiet(() => c360.customer360For(proxy as never, B, { type: "contact", id: "c-buyer" }, { now: NOW }))
    ok(r.ok === true, "a same-tenant contact reads (ok)", r.ok ? "" : r.reason)
    if (!r.ok) throw new Error("cannot continue section A")
    const v = r.view
    ok(v.party.type === "contact" && v.party.id === "c-buyer" && v.subjectClass === "contact" && v.slices.length === 10, `the party, its class and every slice (${v.subjectClass}, ${v.slices.length} slices)`)
    const email = v.fields["identity.email"]
    ok(!!email && email.value === "ana@example.com" && email.basis === "staff_entered" && email.ownership === "tenant_first_party" && email.source === "staff" && email.observedAt === daysAgo(100) && /email/.test(email.consent ?? ""),
      "FIELD-LEVEL PROVENANCE: a staff-stamped email carries source · basis · ownership · timestamp · its channel's consent", JSON.stringify(email))
    const phone = v.fields["identity.phone"]
    ok(!!phone && phone.basis === "unstamped" && phone.ownership === "unknown" && phone.freshness.mode === "unknown" && phone.observedAt === null,
      "an UNSTAMPED value says so (basis unstamped, ownership unknown, no invented timestamp)", JSON.stringify(phone))
    ok(Object.values(v.fields).every((f) => typeof f.purpose === "string" && f.purpose.length > 0 && !!f.table && !!f.column), "every projected field names its table, column and purpose")
    ok(!!v.consent && v.consent.allowedChannels.includes("sms") && v.consent.allowedChannels.includes("email") && v.consent.voiceReachable === true && v.consent.resolvedChannel === "sms" && v.consent.latestEvent?.type === "sms",
      `CONSENT from the existing resolvers (allowed ${v.consent?.allowedChannels.join("/")}, resolved ${v.consent?.resolvedChannel}, latest event ${v.consent?.latestEvent?.type})`)
    // honest freshness
    const pf = v.providerFacts
    const ore = pf.find((f) => f.key === "online_real_estate_activity")
    const job = pf.find((f) => f.key === "job_change")
    ok(!!ore && ore.freshness.mode === "periodic_provider" && ore.freshness.fresh === false && ore.freshness.windowDays === 180 && v.stale.includes("providerFacts.online_real_estate_activity"),
      "a 200-day-old Versium fact is PERIODIC and STALE against its 180-day window (listed in stale)", JSON.stringify(ore?.freshness))
    ok(!!job && job.freshness.mode === "periodic_provider" && job.freshness.windowDays === 90 && job.freshness.fresh === true, "a 30-day-old PeopleData fact is periodic and fresh against its 90-day window", JSON.stringify(job?.freshness))
    ok(pf.length > 0 && pf.every((f) => f.provider === "first_party" || f.freshness.mode !== "realtime_write"), "NO provider fact is ever labelled real-time")
    ok(!!v.engagement && v.engagement.search.count === 2 && v.engagement.search.freshness.mode === "realtime_write" && v.engagement.tours.count === 1 && v.engagement.portal.count === 0 && v.engagement.portal.unread === false,
      `first-party engagement is REAL-TIME WRITE (search ${v.engagement?.search.count}, tours ${v.engagement?.tours.count}, portal ${v.engagement?.portal.count} read-and-empty)`)
    ok(!!v.communications && v.communications.spineSummary?.startsWith("Last touch") === true && v.communications.lastActivityAt === daysAgo(2) && v.communications.lastOutboundAt === daysAgo(2), "communications: the shared spine + the newest touch / send")
    // append ≠ intent
    const obs = v.intent?.observations ?? []
    const stated = obs.find((o) => o.source === "contacts.timeline")
    const appended = obs.filter((o) => o.basis === "provider_append")
    const firstParty = obs.filter((o) => o.basis === "first_party_action")
    ok(!!stated && stated.confirmed === true && stated.basis === "staff_entered" && stated.playbook === "purchase", "a staff-recorded stated timeline on a buyer is a CONFIRMED purchase intent", JSON.stringify(stated))
    ok(appended.length >= 2 && appended.every((o) => o.confirmed === false), `APPEND ≠ INTENT: ${appended.length} provider observations, none confirmed`)
    const plainView = await quiet(() => c360.customer360For(db as never, B, { type: "contact", id: "c-plain" }, { now: NOW, slices: ["intent"] }))
    const plainStated = plainView.ok ? plainView.view.intent!.observations.find((o) => o.source === "contacts.timeline") : undefined
    ok(!!plainStated && plainStated.basis === "unstamped" && plainStated.confirmed === false && plainStated.playbook === "sale" && plainView.ok && !plainView.view.intent!.confirmed.includes("sale"),
      "(control) the SAME timeline with NO stamp saying who recorded it is observed, NOT confirmed", JSON.stringify(plainStated))
    ok(Object.keys(v.fields).every((k) => protectedClassReasonFor(k.split(".")[1]) === null), "no projected field is a protected-class column (the classifier, applied to every key)")
    ok(firstParty.length >= 2 && firstParty.every((o) => o.confirmed === false), `a first-party action is observed, never confirmed (${firstParty.length})`)
    ok(v.intent!.confirmed.includes("purchase") && !v.intent!.observedNotConfirmed.includes("purchase") && v.intent!.playbooks.every((p) => p.route === "isa_engagement"), `confirmed ${JSON.stringify(v.intent!.confirmed)} / observed ${JSON.stringify(v.intent!.observedNotConfirmed)} — a contact's playbooks route to the ISA's governed engagement`)
    // reads only, columns real
    ok(log.every((l) => l.op === "select"), `the read WRITES NOTHING (${log.length} calls, ops ${[...new Set(log.map((l) => l.op))].join(",")})`)
    // the lead path and the watcher's reads ride the same recorder, so every select shape this lane wrote is checked
    const leadRec = recording(memSupabase(seed360() as never, { uuidIds: true }))
    await quiet(() => c360.customer360For(leadRec.proxy as never, B, { type: "lead", id: "l-open" }, { now: NOW }))
    const watchRec = recording(memSupabase({ ...seed360(), saved_properties: [{ id: "x1", brokerage_id: B, contact_id: "c-buyer", saved_at: hoursAgo(1), dismissed: false }], website_visitors: [{ id: "x2", brokerage_id: B, lead_id: "l-open", contact_id: null, last_seen_at: hoursAgo(1) }], client_portal_activity: [{ id: "x3", brokerage_id: B, contact_id: "c-life", created_at: hoursAgo(1) }] } as never, { uuidIds: true, unique: LEDGER_UNIQUE }))
    await quiet(() => watcher.watchFirstPartyIntent(watchRec.proxy as never, B, { now: NOW }, { respond: (async () => ({ action: "isa_engagement" })) as never, dormancy: { staleDays: 14, lifetimeStaleDays: 60 } }))
    const allLogs = [...log, ...leadRec.log, ...watchRec.log]
    const badCols: string[] = []
    for (const l of allLogs) {
      if (!l.cols || l.table === "agent_action_ledger") continue // the ledger's own selects are action-ledger.ts's, proved by test:action-ledger
      const known = SCHEMA_SNAPSHOT[l.table]
      if (!known) { badCols.push(`${l.table} (not in the cache)`); continue }
      for (const c of l.cols.split(",").map((s) => s.trim()).filter(Boolean)) if (c !== "*" && !known.includes(c)) badCols.push(`${l.table}.${c}`)
    }
    const tablesRead = new Set(allLogs.filter((l) => l.cols).map((l) => l.table))
    ok(badCols.length === 0 && tablesRead.has("leads") && tablesRead.has("website_visitors") && tablesRead.has("client_portal_activity"),
      `every column the 360 (contact + lead) and the watcher select EXISTS in the live-schema cache (${allLogs.filter((l) => l.cols).length} selects over ${tablesRead.size} tables)`, badCols.join(", "))
    ok(SCHEMA_SNAPSHOT.contacts.includes("email") && !SCHEMA_SNAPSHOT.contacts.includes("definitely_not_a_column"), "(control) the cache check sees a real column and refuses an invented one")
    const viewJson = JSON.stringify(v)
    ok(!/purchase_price|commission|400000|12000/.test(viewJson) && v.property!.transactions.length === 0, "NO FINANCIAL value is projected (the deal row's price / commission never reach the view)")
    // C2 — a converted lead is read AS its contact
    const viaLead = await quiet(() => c360.customer360For(db as never, B, { type: "lead", id: "l-conv" }, { now: NOW, slices: ["consent"] }))
    ok(viaLead.ok && viaLead.view.party.type === "contact" && viaLead.view.party.id === "c-buyer" && viaLead.view.requested.type === "lead", "C2: a CONVERTED lead is read as its contact (requested lead, party contact)")
    const open = await quiet(() => c360.customer360For(db as never, B, { type: "lead", id: "l-open" }, { now: NOW, slices: ["consent", "intent"] }))
    ok(open.ok && open.view.party.type === "lead" && open.view.subjectClass === "lead" && open.view.consent!.allowedChannels.every((c) => c === "email" || c === "direct_mail") && open.view.consent!.allowedChannels.includes("email"),
      `an OPEN lead stays a lead — email / direct mail only whatever its stored preference (${open.ok ? open.view.consent?.allowedChannels.join("/") : "?"})`)
    ok(open.ok && open.view.intent!.playbooks.every((p) => p.route === "lead_signal_recorded"), "a lead's playbooks route to the ISA's lead loops")
    const life = await quiet(() => c360.customer360For(db as never, B, { type: "contact", id: "c-life" }, { now: NOW }))
    ok(life.ok && life.view.subjectClass === "lifetime" && life.view.intent!.confirmed.includes("moving") && life.view.intent!.playbooks.every((p) => p.route === "sphere_signal_recorded") && life.view.property!.transactions[0]?.role === "buyer",
      "a lifetime client: the self-directed 'Your Next Move' tap is a CONFIRMED moving intent, routed to the Sphere; its closing reads as the home they bought")
    // tenancy + fail closed
    const foreign = await quiet(() => c360.customer360For(db as never, B, { type: "contact", id: "c-other" }, { now: NOW }))
    ok(!foreign.ok && /not in this brokerage/.test(foreign.reason), "TENANT-PINNED: another tenant's contact is 'not in this brokerage'")
    const ownTenant = await quiet(() => c360.customer360For(db as never, B2, { type: "contact", id: "c-other" }, { now: NOW, slices: ["consent"] }))
    ok(ownTenant.ok, "(control) the same contact reads for its OWN tenant")
    const refusedCore = memSupabase(seed360() as never, { refuse: { contacts: "permission denied for table contacts" } })
    const rc = await quiet(() => c360.customer360For(refusedCore as never, B, { type: "contact", id: "c-buyer" }, { now: NOW }))
    ok(!rc.ok && /contact read refused/.test(rc.reason), "FAIL CLOSED: a refused core read refuses the whole view")
    const refusedSecondary = memSupabase(seed360() as never, { refuse: { signal_reactivations: "permission denied", saved_properties: "permission denied" } })
    const rs = await quiet(() => c360.customer360For(refusedSecondary as never, B, { type: "contact", id: "c-buyer" }, { now: NOW }))
    ok(rs.ok && rs.view.unread.includes("intent") && rs.view.unread.includes("engagement") && rs.view.engagement!.search.unread === true && rs.view.warnings.some((w) => /signal_reactivations unread/.test(w)),
      "a refused SECONDARY read degrades only its slice and is NAMED (unread + warning) — never rendered as empty")
    const missing = await quiet(() => c360.customer360For(db as never, B, { type: "contact", id: "c-missing" }, { now: NOW }))
    ok(!missing.ok, "(control) an unknown id is refused, not invented")
    // no provider, no write path in the module
    const s360 = src(C360)
    const VENDOR = /from\s+["']@\/lib\/(external\/(versium|peopledata|batchdata)|property\/rentcast|avm\/)|\bfetch\s*\(|\.(insert|update|upsert|delete)\s*\(/
    ok(s360.length > 0 && !VENDOR.test(s360), "the 360 module imports no vendor client, calls no fetch and holds no write")
    ok(VENDOR.test('import { x } from "@/lib/external/versium-client"') && VENDOR.test("await svc.from('x').insert({})"), "(control) the scan recognises a vendor import and a write")
    // the playbooks ride the responder's OWN vocabulary
    const expect: Record<string, string> = { moving: "moving", sale: "home_sale", purchase: "buying", refinance: "refinance", equity: "equity", household: "life_event", life_event: "life_event" }
    const kinds = Object.entries(c360.INTENT_PLAYBOOKS).map(([p, x]) => [p, arb.LIFE_CHANGE_SIGNAL_KINDS[x.signalType]] as const)
    ok(Object.keys(c360.INTENT_PLAYBOOKS).length === 7 && kinds.every(([p, k]) => k === expect[p]), `the seven playbooks (${Object.keys(c360.INTENT_PLAYBOOKS).join(", ")}) map onto the responder's LIFE_CHANGE_SIGNAL_KINDS — no new spelling`, JSON.stringify(kinds))
    ok(arb.LIFE_CHANGE_SIGNAL_KINDS["not_a_real_signal_type"] === undefined, "(control) an invented spelling is not in the responder's vocabulary")
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ B · RULING 11 — the first-party watcher: a start / resumption → one durable event → the ONE responder ━━━")
  {
    const seedW = () => ({
      contacts: [
        { id: "w-new", brokerage_id: B, contact_type: "buyer", email: "n@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
        { id: "w-cont", brokerage_id: B, contact_type: "buyer", email: "c@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
        { id: "w-back", brokerage_id: B, contact_type: "buyer", email: "b@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
        { id: "w-portal1", brokerage_id: B, contact_type: "seller", email: "p1@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
        { id: "w-portal2", brokerage_id: B, contact_type: "seller", email: "p2@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
        { id: "w-life", brokerage_id: B, contact_type: "lifetime_customer", email: "l@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
        { id: "w-conv", brokerage_id: B, contact_type: "buyer", email: "v@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
        { id: "w-foreign", brokerage_id: B2, contact_type: "buyer", email: "f@example.com", deleted_at: null, enrichment_profile: null, metadata: {} },
      ],
      leads: [
        { id: "wl-open", brokerage_id: B, contact_id: null, is_active: true, email: "wl@example.com", enrichment_profile: null },
        { id: "wl-conv", brokerage_id: B, contact_id: "w-conv", is_active: true, email: "v@example.com", enrichment_profile: null },
        { id: "wl-dead", brokerage_id: B, contact_id: null, is_active: false, email: "d@example.com", enrichment_profile: null },
      ],
      saved_properties: [
        { id: "s1", brokerage_id: B, contact_id: "w-new", saved_at: hoursAgo(1), dismissed: false },
        { id: "s2", brokerage_id: B, contact_id: "w-cont", saved_at: hoursAgo(2), dismissed: false },
        { id: "s3", brokerage_id: B, contact_id: "w-cont", saved_at: daysAgo(3), dismissed: false },
        { id: "s4", brokerage_id: B, contact_id: "w-back", saved_at: hoursAgo(1), dismissed: false },
        { id: "s5", brokerage_id: B, contact_id: "w-back", saved_at: daysAgo(40), dismissed: false },
        { id: "s6", brokerage_id: B2, contact_id: "w-foreign", saved_at: hoursAgo(1), dismissed: false },
        { id: "s7", brokerage_id: B, contact_id: "w-new", saved_at: hoursAgo(1), dismissed: true },
      ],
      property_views: [],
      website_visitors: [
        { id: "v1", brokerage_id: B, lead_id: "wl-open", contact_id: null, last_seen_at: hoursAgo(1) },
        { id: "v2", brokerage_id: B, lead_id: "wl-conv", contact_id: null, last_seen_at: hoursAgo(1) },
        { id: "v3", brokerage_id: B, lead_id: "wl-dead", contact_id: null, last_seen_at: hoursAgo(1) },
      ],
      client_portal_activity: [
        { id: "cp1", brokerage_id: B, contact_id: "w-portal1", created_at: hoursAgo(1) },
        { id: "cp2", brokerage_id: B, contact_id: "w-portal2", created_at: hoursAgo(1) },
        { id: "cp3", brokerage_id: B, contact_id: "w-portal2", created_at: daysAgo(30) },
        { id: "cp4", brokerage_id: B, contact_id: "w-life", created_at: hoursAgo(1) },
        { id: "cp5", brokerage_id: B, contact_id: "w-life", created_at: daysAgo(30) },
      ],
      portal_access_logs: [], contact_consent_events: [], signal_reactivations: [], agent_action_ledger: [],
    })
    const DORMANCY = { staleDays: 14, lifetimeStaleDays: 60 }
    const calls: Array<{ subject: { type: string; id: string }; signalType: string; source: string }> = []
    const respond: any = async (_svc: unknown, input: any) => { calls.push({ subject: input.subject, signalType: input.signalType, source: input.source }); return { action: input.subject.type === "lead" ? "lead_signal_recorded" : "isa_engagement", subjectClass: input.subject.type, kind: "buying", reason: "proof" } }
    const db = memSupabase(seedW() as never, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const r1 = await quiet(() => watcher.watchFirstPartyIntent(db as never, B, { now: NOW }, { respond, dormancy: DORMANCY }))
    const routedIds = calls.map((c) => `${c.subject.type}:${c.subject.id}:${c.signalType}`).sort()
    ok(routedIds.includes("contact:w-new:search_portal_activity"), "a FIRST save (no prior search activity) is a START → routed as search_portal_activity", JSON.stringify(routedIds))
    ok(routedIds.includes("contact:w-back:search_portal_activity"), "a save after 40 quiet days (> the tenant's 14-day window) is a RESUMPTION → routed")
    ok(!routedIds.some((x) => x.includes("w-cont")) && r1.continuing >= 1, `CONTINUING activity (a save 3 days earlier, inside the window) is NOT routed (continuing ${r1.continuing})`)
    ok(routedIds.includes("contact:w-portal2:portal_activity_resumed") && !routedIds.some((x) => x.includes("w-portal1")) && r1.firstPortalVisit === 1,
      `a portal visit after 30 quiet days RESUMES (portal_activity_resumed); a FIRST portal visit is the welcome journey's (firstPortalVisit ${r1.firstPortalVisit})`)
    ok(!routedIds.some((x) => x.includes("w-life")), "a LIFETIME client inside the tenant's 60-day lifetime window is continuing — the lifetime window, not the contact one")
    ok(routedIds.includes("lead:wl-open:search_portal_activity") && routedIds.includes("contact:w-conv:search_portal_activity") && !routedIds.some((x) => x.includes("wl-dead")),
      "C2: an open lead's site return routes as the LEAD; a converted lead's as its CONTACT; an inactive lead without a contact is out of every domain")
    ok(!routedIds.some((x) => x.includes("w-foreign")) && db.tables.agent_action_ledger.every((l: any) => l.brokerage_id === B), "TENANT-PINNED: another tenant's rows never become a candidate")
    const led = db.tables.agent_action_ledger.filter((l: any) => l.action === "customer360.first_party_action.observed")
    ok(led.length === calls.length && calls.length === r1.routed && r1.routed === 5, `ONE durable ledger event per routed change (${led.length} events, ${r1.routed} routed)`, JSON.stringify(r1))
    const ev = led.find((l: any) => l.subject_id === "w-new" || l.subject_ref === "w-new" || JSON.stringify(l).includes("w-new"))
    const detail = (ev?.detail ?? {}) as Record<string, any>
    ok(!!ev && detail.change === "started" && detail.customer_360?.subject_class === "contact" && Array.isArray(detail.customer_360?.allowed_channels) && detail.freshness?.mode === "realtime_write" && ev.actor_manager_key === "data_steward",
      "the event carries the change, the party's Customer 360 context (C6) and an HONEST freshness (real-time write, read on the tick)", JSON.stringify({ detail, actor: ev?.actor_manager_key }))
    ok(calls.every((c) => arb.LIFE_CHANGE_SIGNAL_KINDS[c.signalType] === "buying" && c.source.startsWith("first_party:")), "the spellings are the responder's OWN (LIFE_CHANGE_SIGNAL_KINDS) and the source names the first-party family")
    const before = calls.length
    const r2 = await quiet(() => watcher.watchFirstPartyIntent(db as never, B, { now: NOW }, { respond, dormancy: DORMANCY }))
    ok(calls.length === before && r2.replayed === 5 && r2.routed === 0, `CONSUMED ONCE: the same tick again replays (replayed ${r2.replayed}), the responder is not called twice`)
    // fail closed on an unread history
    const heldDb = memSupabase(seedW() as never, { uuidIds: true, unique: LEDGER_UNIQUE })
    const heldCalls: unknown[] = []
    const origFrom = heldDb.from.bind(heldDb)
    let savedReads = 0
    ;(heldDb as any).from = (t: string) => {
      if (t === "saved_properties" && ++savedReads > 1) return memSupabase({}, { refuse: { saved_properties: "permission denied" } }).from(t)
      return origFrom(t)
    }
    const rh = await quiet(() => watcher.watchFirstPartyIntent(heldDb as never, B, { now: NOW }, { respond: async (...a: unknown[]) => { heldCalls.push(a); return { action: "isa_engagement" } as never }, dormancy: DORMANCY }))
    ok(rh.refused >= 3 && rh.errors.some((e) => /prior read refused/.test(e)) && !heldCalls.some((a: any) => ["w-new", "w-back", "w-cont"].includes(a[1]?.subject?.id)),
      `FAIL CLOSED: a refused HISTORY read holds those candidates (refused ${rh.refused}) — an unread history is never "dormant"`)
    // the cap
    const capDb = memSupabase(seedW() as never, { uuidIds: true, unique: LEDGER_UNIQUE })
    const rc = await quiet(() => watcher.watchFirstPartyIntent(capDb as never, B, { now: NOW, maxRoutes: 2 }, { respond, dormancy: DORMANCY }))
    ok(rc.routed === 2 && rc.capped === 3, `the per-tick cap holds the rest for the next tick (routed ${rc.routed}, capped ${rc.capped}) — the overlapping cursor keeps them`)
    // the REAL responder, through each door (lead / contact / lifetime), its own ledger on the same client
    const realDb = memSupabase({ ...seedW(), contacts: [...seedW().contacts, { id: "w-life2", brokerage_id: B, contact_type: "lifetime_customer", email: "l2@example.com", deleted_at: null, enrichment_profile: null, metadata: {} }], client_portal_activity: [...seedW().client_portal_activity, { id: "cp6", brokerage_id: B, contact_id: "w-life2", created_at: hoursAgo(1) }, { id: "cp7", brokerage_id: B, contact_id: "w-life2", created_at: daysAgo(90) }] } as never, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const recorded: any[] = [], engaged: any[] = []
    const realRespond: any = (svc: any, input: any) => arb.respondToLifeChangeSignal(svc, input, {
      recordSignal: async (p: any) => { recorded.push(p); return { id: `sig-${recorded.length}` } },
      engage: async (p: any) => { engaged.push(p); return { success: true, channel: "email" } },
      ledger: withActionLedger,
    })
    const rr = await quiet(() => watcher.watchFirstPartyIntent(realDb as never, B, { now: NOW }, { respond: realRespond, dormancy: DORMANCY }))
    ok(rr.routed === 6 && recorded.length === 6 && engaged.length === 4, `the REAL responder answered every routed change (${recorded.length} signals recorded, ${engaged.length} governed engagements)`, JSON.stringify(rr))
    // FINDING (Outside-lane, lane 146B): the responder's own ledger action `life_change.respond` has TWO segments, so the m687
    // pattern (domain.entity.action) refuses it and every answer runs UNLEDGERED — its per-person / signal / day replay never
    // holds in production (the intent-driven-followup guard injects a fake ledger, so it cannot see this). The watcher's
    // consumed-once guarantee therefore rides its OWN three-segment event (asserted above), never the responder's.
    const RESPONDER_ACTION = /action:\s*"([a-z_.]+)",\s*actor:\s*\{\s*type:\s*"manager",\s*managerKey:\s*subjectClass/.exec(src("lib/ai-isa/followup-arbiter.ts"))?.[1] ?? null
    const ACTION_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
    console.log(`  · the responder's ledger action is "${RESPONDER_ACTION}" — ${RESPONDER_ACTION && ACTION_NAME.test(RESPONDER_ACTION) ? "ledgerable" : "NOT ledgerable (domain.entity.action) — Outside-lane fix for lane 146B"}`)
    ok(ACTION_NAME.test("customer360.first_party_action.observed") && !ACTION_NAME.test("life_change.respond"), "(control) the watcher's event name is ledgerable; a two-segment name is not")
    ok(recorded.some((p) => p.leadId === "wl-open" && p.signalType === "search_portal_activity") && !engaged.some((p) => p.contactId === "wl-open"), "LEAD door: the open lead's signal is recorded for the ISA's lead loops — no direct engagement")
    ok(engaged.some((p) => p.contactId === "w-new") && engaged.some((p) => p.contactId === "w-conv"), "CONTACT door: the contact (and the converted lead's contact) reach the governed ISA engagement")
    ok(recorded.some((p) => p.contactId === "w-life2" && p.signalType === "portal_activity_resumed") && !engaged.some((p) => p.contactId === "w-life2"), "LIFETIME door: a lifetime client's resumed portal visit is recorded for the Sphere, not pushed to the ISA")
    // wiring
    const cron = src("app/api/cron/enrichment-processor/route.ts")
    const iFacts = cron.indexOf("watchEnrichmentFactChanges(supabase, brokerage.id)")
    const iFirst = cron.indexOf("watchFirstPartyIntent(supabase, brokerage.id)")
    ok(iFacts > 0 && iFirst > iFacts, "WIRED: the 15-minute enrichment-processor tick runs the first-party watcher right after the provider watcher")
    ok(!/watchFirstPartyIntent\(/.test(stripComments("// watchFirstPartyIntent(supabase, brokerage.id)\nconst x = 1")), "(control) a commented-out call is not read as one")
    const sw = src(WATCH)
    ok(sw.includes("customer360For(") && sw.includes("respondToLifeChangeSignal") && !/from\s+["']@\/lib\/external\//.test(sw) && !/\bfetch\s*\(/.test(sw), "the watcher reads the Customer 360 (C6), answers through the ONE responder, and calls no provider")
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ C · RULING 13 — protected attributes: labelled, withheld from the outreach view, never rewritten, never blocking ━━━")
  {
    const db = memSupabase(seed360() as never, { uuidIds: true })
    const before = JSON.stringify(db.tables.contacts.find((c: any) => c.id === "c-buyer"))
    const r = await quiet(() => c360.customer360For(db as never, B, { type: "contact", id: "c-buyer" }, { now: NOW }))
    if (!r.ok) throw new Error(r.reason)
    const w = r.view.protectedWithheld
    const cols = w.map((x) => x.column).sort()
    ok(JSON.stringify(cols) === JSON.stringify(["gender", "household_income", "marital_status"]), `the PRESENT protected-class columns are named (${cols.join(", ")}); an absent one (age_range null) is not`)
    ok(w.every((x) => x.reason === protectedClassReasonFor(x.column)), "each carries the ONE classifier's reason sentence verbatim")
    ok(w.find((x) => x.column === "gender")?.stampSource === "versium", "a withheld column keeps its provenance stamp (source versium) — labelled, not lost")
    const json = JSON.stringify(r.view.fields) + JSON.stringify(r.view.intent) + JSON.stringify(r.view.providerFacts)
    ok(!/female|married|\$100k/.test(json), "the protected VALUES never reach the outreach-driving view")
    ok(/female/.test(before) && JSON.stringify(db.tables.contacts.find((c: any) => c.id === "c-buyer")) === before, "(control) the values ARE on the record — and the record is byte-identical after the read (never rewritten)")
    ok(protectedClassReasonFor("gender") !== null && protectedClassReasonFor("preferred_channel") === null, "(control) the classifier labels gender and leaves preferred_channel alone")
    const plain = await quiet(() => c360.customer360For(db as never, B, { type: "contact", id: "c-plain" }, { now: NOW }))
    ok(plain.ok && plain.view.protectedWithheld.length === 0 && !plain.view.gaps.some((g) => /gender|marital|age|income|race|religion/.test(g)), "ABSENCE NEVER BLOCKS: a contact with no demographic field reads fine and no protected field is listed as a gap")
    const research = /protected_research_attributes|protected-research-store/
    const lits = [...stringLiterals(raw(C360)), ...stringLiterals(raw(WATCH))].map((l) => (l as any).value ?? String(l))
    ok(!research.test(src(C360)) && !research.test(src(WATCH)) && !lits.some((l) => research.test(l)), "the segregated research store is never named or imported by the 360 or the watcher (code AND string literals)")
    ok(research.test("svc.from('protected_research_attributes')"), "(control) the finder recognises the research table")
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ D · CONTRACT C4 — the undelivered-promise signal is catalogued (lane 146F's name, the registry is 146D's file) ━━━")
  {
    const { SIGNAL_REGISTRY } = await import("../lib/kernel/signal-registry")
    const { classifyCoordination } = await import("../lib/kernel/coordination-kind")
    const spec = SIGNAL_REGISTRY["lead_magnet_promise_undelivered"]
    ok(!!spec, "lead_magnet_promise_undelivered is in SIGNAL_REGISTRY")
    ok(!!spec && spec.kind === classifyCoordination("lead_magnet_promise_undelivered"), `its declared kind matches the live classifier (${spec?.kind} / ${classifyCoordination("lead_magnet_promise_undelivered")})`)
    ok(!!spec && /promise|deliver/i.test(spec.what) && spec.what.length > 40, "its purpose line names the promised deliverable")
    // The RULE, derived (never the waypoint): handled ⇔ a SIGNAL_HANDLERS consumer exists for it — so the row is right before AND after
    // the arbiter's handler lands.
    const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
    const handlerKeys = Object.keys(SIGNAL_HANDLERS).filter((k) => k.endsWith(":lead_magnet_promise_undelivered"))
    ok(!!spec && (handlerKeys.length > 0 ? spec.disposition === "handled" && handlerKeys.every((k) => spec.consumers.includes(k.split(":")[0])) : spec.disposition === "feed_only"),
      `disposition agrees with the bus (${handlerKeys.length} handler(s) → ${spec?.disposition})`)
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ E · RULING 12 — the provider comparison is sourced and its freshness table agrees with the code ━━━")
  {
    const doc = raw("docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md")
    ok(doc.length > 0, "docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md exists")
    const rows = new Map<string, string>()
    for (const line of doc.split("\n")) {
      const m = /^\|\s*([a-z_]+)\s*\|[^|]*\|\s*([a-z_]+)\s*\|/.exec(line)
      if (m) rows.set(m[1], m[2])
    }
    const drift = Object.entries(c360.CUSTOMER_360_SOURCES).filter(([k, s]) => rows.get(k) !== s.mode).map(([k, s]) => `${k}: doc ${rows.get(k) ?? "missing"} vs code ${s.mode}`)
    ok(drift.length === 0, `every CUSTOMER_360_SOURCES row (${Object.keys(c360.CUSTOMER_360_SOURCES).length}) is in the doc's freshness table with the code's mode`, drift.join("; "))
    ok(/\| versium \|[^\n]*\| realtime_write \|/.test("| versium | x | realtime_write | y |") && !/\| versium \|[^\n]*\| periodic_provider \|/.test("| versium | x | realtime_write | y |"), "(control) the table reader sees a row's mode and would catch a provider called real-time")
    for (const v of ["Celebrus", "FullContact", "DealMachine"]) ok(new RegExp(`### 3\\.\\d+ ${v}`).test(doc), `the owner-named provider ${v} has its own section`)
    const sections = doc.split(/\n### /).filter((s) => /^3\.\d/.test(s))
    const unsourced = sections.filter((s) => !/https?:\/\//.test(s)).map((s) => s.split("\n")[0])
    ok(sections.length >= 6 && unsourced.length === 0, `every provider section cites a URL (${sections.length} sections)`, unsourced.join("; "))
    ok(/not published/i.test(doc) && /read on \*\*2026-10-29\*\*/.test(doc), "an unpublished price is said as 'not published'; the read date is stated")
    const pc = raw("docs/commercial/PROVIDER-COST-REPORT.md")
    ok(/## 12\. Customer 360/.test(pc) && pc.includes("CUSTOMER-360-PROVIDER-COMPARISON.md"), "PROVIDER-COST-REPORT.md carries the Customer-360 section and links the comparison")
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ CUSTOMER_360_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
