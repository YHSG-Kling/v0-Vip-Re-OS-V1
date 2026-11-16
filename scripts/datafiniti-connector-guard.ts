#!/usr/bin/env tsx
/**
 * scripts/datafiniti-connector-guard.ts — test:datafiniti-connector (wave 153, lane 153M; owner ruling B1).
 *
 * Drives the REAL Datafiniti People Data connector (lib/external/datafiniti-client.ts) and its RawData producer
 * (lib/lead-pipeline/datafiniti-people-producer.ts) through the injected transport seam with ZERO network, and the REAL
 * ingestRawSourceBatch over the in-memory database, then holds the registries to the honest state. Nothing is bought,
 * no key exists, no live call is made: every result here is CODE-CERTIFIED (simulated); LIVE-VERIFIED is none.
 *
 *   A  typed query builder — no free text reaches `query` (injection refused), quoting, empty / geo-only refused
 *   B  documented-schema fixture mapping incl. SPARSE rows; work location never a property address; provenance kept
 *   C  failures — count books nothing and returns no records; quota (no retry); 429 retried; free 5xx bounded retry; paid 5xx
 *      never blind-retried; 401 classified with the token redacted
 *   D  two-tenant key isolation — tenant A's key never serves B; no platform fallback either way
 *   E  rights missing → not activated (zero transport calls); tenant door derives pending_owner_licensing
 *   F  charge once — a replayed request makes no paid call and books nothing; a download resume books nothing and
 *      re-ingests as replays (no duplicate RawData)
 *   G  outcome unknown (B10) — reconciled first: not charged → re-sent once; charged → booked, never re-sent; unreadable → held
 *   H  person / property collision — two owners of one property stay two people; a held Contact's person is not re-written
 *   I  stale source date held before ingest
 *   J  no outreach — the producer and the client import no sender and write no Contact (positive control included)
 *   K  registry truth — matrix / scorecard / adapter / tenancy / catalogue / source rights / price row / m949 / package.json
 *   L  economics — published figures with their dates (derived from the scorecard, never re-typed)
 * Every absence assertion carries a positive control (CLAUDE.md §2).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import "./canaries/_harness"
import { stripComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => blankStrings(stripComments(read(p)))

const NOW = new Date("2026-11-16T12:00:00.000Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const TOKEN_A = "tenantAtokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const TOKEN_B = "tenantBtokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const TOKEN_P = "platformTokenPPPPPPPPPPPPPPPPPPPPPPPPPPPPP"

// ── documented-schema fixtures (field names from docs.datafiniti.co/docs/people-data-schema, values synthetic) ──────────
const full = (over: Record<string, unknown> = {}) => ({
  id: "df-person-1", keys: ["danawhitfieldexampleorg"],
  firstName: "Dana", lastName: "Whitfield", middleName: "A",
  personalEmails: ["dana.whitfield@example.org"], emails: ["d.whitfield@example.net"], professionalEmails: ["dana@work.example.com"], primaryEmail: "dana@work.example.com",
  phoneNumbers: [{ number: "+1 850-555-0100", type: "Land Line", lastDateSeen: daysAgo(400) }, { number: "+1 850-555-0142", type: "Mobile", lastDateSeen: daysAgo(20) }],
  phoneNumberHighScoreMobile: "+1 850-555-0142", phoneNumberHighScoreMobileScore: 90, tcpa: false,
  address: "1125 Lancaster Avenue", city: "Pensacola", province: "FL", postalCode: "32501", country: "US",
  businessName: "Example Works", jobTitle: "Engineer",
  mostRecentPropertyPurchaseDate: daysAgo(900), mostRecentPropertyPurchaseKey: "us/fl/pensacola/12palafoxst",
  propertiesOwnedHistory: [{ propertyKey: "us/fl/pensacola/12palafoxst", datePurchased: daysAgo(900) }],
  dateAdded: daysAgo(2000), dateUpdated: daysAgo(10),
  sourceURLs: ["https://datafiniti.co", "https://records.example.gov/deed/123"], domains: ["datafiniti.co"],
  ...over,
})

type Req = { method: string; path: string; body?: any; token: string; brokerageId: string | null; headers?: Record<string, string> }
function fakeTransport(script: (req: Req, n: number) => { status: number | null; data: unknown; headers?: Record<string, string> }) {
  const calls: Req[] = []
  const transport = async (req: Req) => { calls.push(req); const r = script(req, calls.length); return { status: r.status, data: r.data, error: r.status && r.status < 300 ? null : "err", headers: r.headers ?? {} } }
  return { calls, transport: transport as never }
}
const ACCOUNT = (creditsUsed = 0) => ({ role: "user", people_credits_used: creditsUsed, plan_ids: ["people-1k-99"], features: [{ name: "people:search", enabledFields: ["view", "download"] }, { name: "people:paginate", enabledFields: ["view"] }], overages_enabled: false, overage_limit: 100, disabled_code: 0, first_name: "Holder", email: "holder@example.com", customer_id: "cus_x" })
const noSleep = async () => {}

async function main() {
  const dc = await import("../lib/external/datafiniti-client")
  const pr = await import("../lib/lead-pipeline/datafiniti-people-producer")
  const { PROVIDER_ACTIVATION } = await import("../lib/ai-isa/property-lookup-rail")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
  const tp = await import("../lib/providers/tenant-provider-connections")

  // ─── A ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nA — the typed query builder (no free text from agent prose reaches `query`)")
  {
    const ok = dc.buildDatafinitiPeopleQuery({ firstName: "Dana", lastName: "O'Neil", postalCode: "32501", province: "fl", updatedSince: "2026-01-01" })
    check("POSITIVE CONTROL: typed filters build a quoted AND query", ok.ok && ok.query === `firstName:"Dana" AND lastName:"O'Neil" AND province:FL AND postalCode:"32501" AND dateUpdated:[2026-01-01 TO *]`, ok.ok ? ok.query : ok.problems.join("; "))
    const inj = dc.buildDatafinitiPeopleQuery({ lastName: 'Smith" OR country:*' } as never)
    const extra = dc.buildDatafinitiPeopleQuery({ lastName: "Smith", query: "keys:*" } as never)
    const empty = dc.buildDatafinitiPeopleQuery({})
    const geoOnly = dc.buildDatafinitiPeopleQuery({ country: "US", province: "TX" })
    check("an injected quote / operator in a name is refused (never escaped into a live clause)", !inj.ok)
    check("an undeclared key (`query`) is refused — free text cannot ride an extra field", !extra.ok && /not a declared filter/.test(extra.ok ? "" : extra.problems.join()))
    check("an empty filter set (match everything) and a country / state-only set are refused", !empty.ok && !geoOnly.ok)
    const email = dc.buildDatafinitiPeopleQuery({ email: "Dana.Whitfield@Example.org" })
    check("an email is lower-cased and quoted on the documented `emails` field", email.ok && email.query === `emails:"dana.whitfield@example.org"`)
  }

  // ─── B ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nB — documented-schema fixture mapping (sparse rows honoured; provenance and source dates kept)")
  const ctx = { retrievedAt: NOW.toISOString(), now: NOW, queryDigest: "q1" }
  {
    const m = pr.mapDatafinitiPerson(full() as never, ctx)
    const r = m.record!
    check("a full documented record is WRITTEN with name, the high-score mobile phone and the PERSONAL email", m.outcome === "written" && r.firstName === "Dana" && r.phone === "+1 850-555-0142" && r.email === "dana.whitfield@example.org", JSON.stringify({ o: m.outcome, why: m.why }))
    check("work location is labelled work and NEVER written as a property or mailing address (the raw work address IS present — positive control)", r.propertyAddress === null && r.mailingAddress === null && r.city === "Pensacola" && /work_location/.test(String((r.envelope?.evidence as any)?.geography_basis)) && (r.rawPayload as any).address === "1125 Lancaster Avenue")
    check("owner ↔ property only through the vendor's property key (subject owner, external id kept)", r.envelope?.subjectKind === "owner" && r.envelope?.externalIds?.datafiniti_property_key === "us/fl/pensacola/12palafoxst" && m.propertyKeys.length === 1)
    check("per-field provenance keeps the vendor field and its own date (phone lastDateSeen, dateUpdated)", m.provenance.some((p) => p.field === "phone" && p.vendorField === "phoneNumberHighScoreMobile" && p.seenAt === daysAgo(20)) && m.provenance.some((p) => p.field === "email" && p.vendorField === "personalEmails"))
    check("intent stays unknown — no seller probability, no play; paid person data flagged; datafiniti.co partner URL is not a proof URL", r.intentType === "unknown" && r.motivationScore === null && r.paidPersonData === true && (r.envelope?.proofUrls ?? []).join() === "https://records.example.gov/deed/123")
    check("professional / primary (work) emails are withheld from the personal channel and counted", (r.envelope?.evidence as any)?.professional_emails_withheld === 2 && r.email !== "dana@work.example.com")
    const sparse = pr.mapDatafinitiPerson({ id: "df-sparse", firstName: "Lee", lastName: "Park", emails: ["lee.park@example.org"], dateUpdated: daysAgo(5) } as never, ctx)
    check("SPARSE: name + email only, no property link, answers no held candidate → ungrounded (not a raw lead)", sparse.outcome === "ungrounded" && sparse.record === null)
    const sparseHeld = pr.mapDatafinitiPerson({ id: "df-sparse", firstName: "Lee", lastName: "Park", emails: ["lee.park@example.org"], dateUpdated: daysAgo(5) } as never, { ...ctx, answersHeldCandidate: "raw-77" })
    check("SPARSE but answering a HELD candidate → written; missing fields stay missing (no phone, no geography invented)", sparseHeld.outcome === "written" && sparseHeld.record!.phone === null && sparseHeld.record!.city === null && sparseHeld.record!.state === null)
    const tcpaOnly = pr.mapDatafinitiPerson(full({ tcpa: true, personalEmails: [], emails: [] }) as never, ctx)
    const tcpaEmail = pr.mapDatafinitiPerson(full({ tcpa: true }) as never, ctx)
    check("a TCPA-litigator record's phones are suppressed: phones only → ungrounded; with an email → written WITHOUT a phone", tcpaOnly.outcome === "ungrounded" && tcpaEmail.outcome === "written" && tcpaEmail.record!.phone === null && (tcpaEmail.record!.envelope?.evidence as any)?.phones_suppressed === true)
    check("a deceased record is refused; a record with no id or key is refused (a replay could not be anchored)", pr.mapDatafinitiPerson(full({ deceased: true }) as never, ctx).outcome === "refused" && pr.mapDatafinitiPerson(full({ id: undefined, keys: [] }) as never, ctx).outcome === "refused")
    const dep = pr.mapDatafinitiPerson(full({ propertiesOwnedHistory: [], mostRecentPropertyPurchaseKey: undefined, propertiesOwned: ["us/fl/pensacola/9baylenst"] }) as never, ctx)
    check("the DEPRECATED propertiesOwned is read only as a fallback key list and named as deprecated", dep.outcome === "written" && dep.provenance.some((p) => /deprecated/.test(p.vendorField)))
  }

  // ─── C ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nC — documented failures, quota, 429 / 500, invalid token")
  const env = { DATAFINITI_API_TOKEN: TOKEN_P }
  const P = { owner: "platform" as const }
  {
    const t = fakeTransport(() => ({ status: 200, data: { num_found: 1234, total_cost: 0, records: [full()] } }))
    const c = await dc.countDatafinitiPeople(P, { lastName: "Whitfield", postalCode: "32501" }, { transport: t.transport, env })
    check("count: num_records 0 is sent, the count comes back, a stray record is DROPPED (a count never delivers contacts), cost 0", c.ok && c.numFound === 1234 && c.costCredits === 0 && c.anomalies.length === 1 && t.calls[0].body.num_records === 0 && !("records" in (c as object)))
    const qt = fakeTransport(() => ({ status: 400, data: { errors: ["`num_records` requested will exceed credit allotment for plan."] } }))
    const q = await dc.searchDatafinitiPeople(P, { filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 5 }, { transport: qt.transport, env, sleep: noSleep })
    check("quota: the documented 400 'exceed credit allotment' → kind quota, ONE attempt (never retried)", !q.ok && q.kind === "quota" && q.attempts === 1 && qt.calls.length === 1)
    const rl = fakeTransport((_r, n) => (n === 1 ? { status: 429, data: { error: "Too Many Requests" }, headers: { "retry-after": "0" } } : { status: 200, data: { num_found: 1, total_cost: 1, records: [full()] } }))
    const s429 = await dc.searchDatafinitiPeople(P, { filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1 }, { transport: rl.transport, env, sleep: noSleep })
    check("429 on a PAID search is retried (a refusal processed nothing) and succeeds on attempt 2", s429.ok && s429.attempts === 2 && rl.calls.length === 2)
    const f5 = fakeTransport(() => ({ status: 503, data: { error: "unavailable" } }))
    const a5 = await dc.getDatafinitiAccountHealth(P, { transport: f5.transport, env, sleep: noSleep, maxRetries: 2 })
    check("5xx on a FREE read retries with a bound (3 attempts) and then reports server_error", !a5.ok && a5.kind === "server_error" && a5.attempts === 3 && f5.calls.length === 3)
    const p5 = fakeTransport(() => ({ status: 500, data: { error: "boom" } }))
    const s5 = await dc.searchDatafinitiPeople(P, { filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1 }, { transport: p5.transport, env, sleep: noSleep })
    check("5xx on a PAID search is OUTCOME UNKNOWN and NOT retried here (a retry could charge twice)", !s5.ok && s5.kind === "outcome_unknown" && p5.calls.length === 1)
    const bad = fakeTransport(() => ({ status: 401, data: { message: `invalid token Bearer ${TOKEN_P}` } }))
    const s401 = await dc.getDatafinitiAccountHealth(P, { transport: bad.transport, env, sleep: noSleep })
    check("invalid token: 401 → auth_failed, no retry, and the token never appears in the message", !s401.ok && s401.kind === "auth_failed" && s401.attempts === 1 && !s401.message.includes(TOKEN_P) && /redacted/.test(s401.message))
    const free = fakeTransport(() => ({ status: 200, data: { num_found: 1, total_cost: null, records: [full()] } }))
    const nc = await dc.searchDatafinitiPeople(P, { filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1 }, { transport: free.transport, env })
    check("a response with no total_cost reads cost UNKNOWN (null) — never a guessed $0", nc.ok && nc.totalCostCredits === null)
    check("the search cap is the documented 10 for a non-download (11 refused before any call)", !(await dc.searchDatafinitiPeople(P, { filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 11 }, { transport: free.transport, env })).ok && free.calls.length === 1)
    const acct = await dc.getDatafinitiAccountHealth(P, { transport: fakeTransport(() => ({ status: 200, data: ACCOUNT(7) })).transport, env })
    check("account health maps the documented fields; the 'people-1k-99' plan resolves to the published $99 / 1K tier ($0.099); the holder's name / email / customer id are never read", acct.ok && acct.peopleCreditsUsed === 7 && acct.unit.basis === "published_tier" && acct.unit.unitUsd === 0.099 && acct.peopleSearch.download && !JSON.stringify(acct).includes("holder@example.com") && !JSON.stringify(acct).includes("cus_x"))
    check("an unmatched plan id falls to the published CEILING ($0.19), never $0", dc.datafinitiUnitUsdForPlan(["people-custom-enterprise"]).unitUsd === 0.19 && dc.datafinitiUnitUsdForPlan(["people-custom-enterprise"]).basis === "published_ceiling")
    const st = fakeTransport(() => ({ status: 200, data: `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"status\\":\\"completed\\",\\"results\\":[\\"https://files.example.com/a.json\\"]}"}]}}\n\n` }))
    const ds = await dc.datafinitiDownloadStatus(P, "4242", { transport: st.transport, env })
    check("download status reads the documented MCP df_download_status over an event stream: completed + its result link", ds.ok && ds.status === "completed" && ds.links.join() === "https://files.example.com/a.json" && st.calls[0].path === "/mcp" && st.calls[0].body.params.name === "df_download_status")
    const odd = await dc.datafinitiDownloadStatus(P, "4242", { transport: fakeTransport(() => ({ status: 200, data: { jsonrpc: "2.0", id: 1, result: { structuredContent: { status: "almost" } } } })).transport, env })
    check("an undocumented download status is SHAPE DRIFT, never guessed", !odd.ok && odd.kind === "shape_drift")
  }

  // ─── D ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nD — two-tenant key isolation (no cross-tenant use, no platform fallback)")
  {
    const t = fakeTransport(() => ({ status: 200, data: ACCOUNT(0) }))
    await dc.getDatafinitiAccountHealth({ owner: "tenant", brokerageId: A, connectionId: "cA", token: TOKEN_A }, { transport: t.transport, env })
    await dc.getDatafinitiAccountHealth({ owner: "tenant", brokerageId: B, connectionId: "cB", token: TOKEN_B }, { transport: t.transport, env })
    await dc.getDatafinitiAccountHealth(P, { transport: t.transport, env })
    check("POSITIVE CONTROL: the spy saw three calls, each with its own owner's token and tenant scope", t.calls.length === 3 && t.calls[0].token === TOKEN_A && t.calls[0].brokerageId === A && t.calls[1].token === TOKEN_B && t.calls[1].brokerageId === B && t.calls[2].token === TOKEN_P && t.calls[2].brokerageId === null)
    const none = fakeTransport(() => ({ status: 200, data: ACCOUNT(0) }))
    const noTok = await dc.getDatafinitiAccountHealth({ owner: "tenant", brokerageId: A, connectionId: "cA", token: null }, { transport: none.transport, env })
    check("a tenant connection with NO token is refused — the platform token (configured in env) is never substituted; zero calls", !noTok.ok && noTok.kind === "not_configured" && none.calls.length === 0)
    const noEnv = await dc.getDatafinitiAccountHealth(P, { transport: none.transport, env: {} })
    check("the platform route with no env token is refused — a tenant token is never borrowed; zero calls", !noEnv.ok && noEnv.kind === "not_configured" && none.calls.length === 0)
    const ACTIVE = { ...PROVIDER_ACTIVATION.datafiniti, state: "active" as const }
    const healthy = { state: "healthy" as const, reason: "verified", actionable: null, mayIngest: true }
    const cross = await pr.runDatafinitiPeoplePull({ brokerageId: B, route: "tenant", tenantConnection: { id: "cA", brokerageId: A, token: TOKEN_A, verdict: healthy }, mode: "search", filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1, requestId: "r", territory: { city: null, state: "FL", zip_codes: [] }, now: NOW },
      { activation: ACTIVE, client: { transport: none.transport, env }, loadKnown: async () => null, loadPlans: async () => [], chargeBooked: async () => false, ingest: async () => { throw new Error("never") }, book: async () => true })
    check("tenant B cannot pull with tenant A's connection — refused at rights before any call", !cross.ok && cross.stage === "rights" && /another tenant/.test(cross.refused ?? "") && none.calls.length === 0)
  }

  // shared in-memory producer harness (the REAL ingestRawSourceBatch)
  const mkDb = () => memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [], vendor_usage_tracking: [], ingress_dead_letters: [] } as never, { unique: { raw_scraped_leads: [["idempotency_key"]] } } as never) as any
  const ACTIVE = { ...PROVIDER_ACTIVATION.datafiniti, state: "active" as const }
  const PLATFORM_DOOR = { vendor: "datafiniti", configured: true, credentialNames: ["DATAFINITI_API_TOKEN"], activation: "active" as const, monthlyBudgetUsd: 50, remainingBudgetUsd: 50 }
  const TERR = { city: "Pensacola", state: "FL", zip_codes: ["32501"] }
  const harness = (db: any, opts: { contactEmails?: string[] } = {}) => {
    const booked: any[] = []
    const keys = new Set<string>()
    const deps = (transport: unknown) => ({
      activation: ACTIVE, client: { transport: transport as never, env, sleep: noSleep },
      loadKnown: async () => {
        const rows = (db.tables?.raw_scraped_leads ?? db._tables?.raw_scraped_leads ?? []) as any[]
        const rawRows = (await db.from("raw_scraped_leads").select("source, source_record_id, email")).data ?? rows
        return {
          sourceRecordIds: new Set<string>((rawRows as any[]).map((r) => `${String(r.source).toLowerCase()}|${r.source_record_id}`)),
          personKeys: new Set<string>([...(opts.contactEmails ?? []).map((e) => `email:${e}`)]),
          propertyKeys: new Set<string>(), priorProviderResults: new Map(), scope: { brokerageId: A, includesPlatformPool: false },
        }
      },
      loadPlans: async () => [],
      platformDoor: PLATFORM_DOOR,
      chargeBooked: async (k: string) => keys.has(k),
      ingest: (p: any) => ingestRawSourceBatch({ ...p, client: db }),
      book: async (i: any) => { if (i.idempotencyKey && keys.has(i.idempotencyKey)) return false; keys.add(i.idempotencyKey); booked.push(i); return true },
    })
    return { booked, keys, deps }
  }
  const rawCount = async (db: any) => ((await db.from("raw_scraped_leads").select("id")).data ?? []).length
  const searchScript = (records: unknown[], credits: number | null) => (req: Req) =>
    req.path === "/account" ? { status: 200, data: ACCOUNT(0) }
    : req.body?.num_records === 0 ? { status: 200, data: { num_found: records.length } }
    : { status: 200, data: { num_found: records.length, total_cost: credits, records } }

  // ─── E ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nE — rights missing → not activated")
  {
    const db = mkDb()
    const h = harness(db)
    const t = fakeTransport(searchScript([full()], 1))
    const d = { ...h.deps(t.transport), activation: undefined }
    const r = await pr.runDatafinitiPeoplePull({ brokerageId: A, route: "platform", mode: "search", filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1, requestId: "e1", territory: TERR, now: NOW }, d as never)
    check("the REAL activation (dormant_pending_rights) refuses at rights — ZERO transport calls (not even the free reads), nothing booked", !r.ok && r.stage === "rights" && t.calls.length === 0 && h.booked.length === 0 && PROVIDER_ACTIVATION.datafiniti.state === "dormant_pending_rights")
    const r2 = await pr.runDatafinitiPeoplePull({ brokerageId: A, route: "platform", mode: "search", filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1, requestId: "e1", territory: TERR, now: NOW }, h.deps(t.transport) as never)
    check("POSITIVE CONTROL: the same pull with a SIMULATED post-decision activation passes rights and calls the vendor", r2.ok && t.calls.length > 0, JSON.stringify({ stage: r2.stage, refused: r2.refused }))
    const facts = { exists: true, isActive: true, testStatus: "pass" as const, hasApiKey: true, config: null }
    const v = tp.deriveTenantProviderConnectionState("datafiniti", facts as never)
    check("the tenant door derives pending_owner_licensing today (transport built, rights pending) — mayIngest false", v.state === "pending_owner_licensing" && v.mayIngest === false)
    const unlicensed = await pr.runDatafinitiPeoplePull({ brokerageId: A, route: "tenant", tenantConnection: { id: "cA", brokerageId: A, token: TOKEN_A, verdict: v }, mode: "search", filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1, requestId: "e2", territory: TERR, now: NOW }, h.deps(t.transport) as never)
    check("a tenant pull on a pending_owner_licensing connection is refused at rights even with the activation simulated", !unlicensed.ok && unlicensed.stage === "rights" && /pending_owner_licensing/.test(unlicensed.refused ?? ""))
    const noGate = await pr.runDatafinitiPeoplePull({ brokerageId: A, route: "platform", mode: "search", filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1, requestId: "e3", territory: TERR, now: NOW }, { ...h.deps(t.transport), platformDoor: { ...PLATFORM_DOOR, configured: false } } as never)
    check("the paid-pull gate still holds after rights: an unconfigured platform door with no plan line refuses before the paid call", !noGate.ok && noGate.stage === "spend_gate" && noGate.paidCalls === 0)
  }

  // ─── F ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nF — credits charged once; replay / pagination / download resume create no duplicate RawData and no second charge")
  {
    const db = mkDb()
    const h = harness(db)
    const recs = [full(), full({ id: "df-person-2", keys: ["k2"], firstName: "Sam", lastName: "Ortiz", personalEmails: ["sam.ortiz@example.org"], phoneNumberHighScoreMobile: "+1 850-555-0177", mostRecentPropertyPurchaseKey: "us/fl/pensacola/40garden", propertiesOwnedHistory: [{ propertyKey: "us/fl/pensacola/40garden", datePurchased: daysAgo(300) }] })]
    const t = fakeTransport(searchScript(recs, 2))
    const in1 = { brokerageId: A, route: "platform" as const, mode: "search" as const, filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 5, requestId: "plan-7:pensacola:2026-11", territory: TERR, now: NOW }
    const r1 = await pr.runDatafinitiPeoplePull(in1, h.deps(t.transport) as never)
    const paidCalls1 = t.calls.filter((c) => c.path === "/people/search" && c.body?.num_records > 0).length
    check("first pull: count first (0 credits), ONE paid search, 2 rows into THE RawData door, ONE booking of 2 credits × $0.099", r1.ok && paidCalls1 === 1 && (await rawCount(db)) === 2 && h.booked.length === 1 && h.booked[0].unitCount === 2 && h.booked[0].cost === 0.198 && h.booked[0].coverage === "platform_covered" && h.booked[0].vendorName === "datafiniti", JSON.stringify({ r1: { stage: r1.stage, refused: r1.refused, ingested: r1.ingested }, booked: h.booked }).slice(0, 400))
    check("the count preview went first and books nothing (a count is never a purchase)", t.calls.findIndex((c) => c.body?.num_records === 0) < t.calls.findIndex((c) => c.body?.num_records > 0) && r1.preview?.count === 2 && r1.preview?.identityFabricated === false)
    const rows = (await db.from("raw_scraped_leads").select("source, source_rights, source_licence, subject_kind, brokerage_id")).data as any[]
    check("rows ride source datafiniti_people under licensed_vendor / datafiniti_terms_not_read, owned by the tenant, subject owner", rows.every((r) => r.source === "datafiniti_people" && r.source_rights === "licensed_vendor" && r.source_licence === "datafiniti_terms_not_read" && r.brokerage_id === A && r.subject_kind === "owner"), JSON.stringify(rows[0]))
    const r2 = await pr.runDatafinitiPeoplePull(in1, h.deps(t.transport) as never)
    const paidCalls2 = t.calls.filter((c) => c.path === "/people/search" && c.body?.num_records > 0).length
    check("REPLAY of the same request: no paid call, no new booking, no new RawData", r2.ok && r2.replayedCharge && paidCalls2 === 1 && h.booked.length === 1 && (await rawCount(db)) === 2)
    const r3 = await pr.runDatafinitiPeoplePull({ ...in1, requestId: "plan-7:pensacola:2026-12" }, h.deps(t.transport) as never)
    check("a NEW purchase returning the same people is deduplicated at ingress — no duplicate RawData (2 rows), its own single booking", r3.ok && r3.ingressDuplicates === 2 && (await rawCount(db)) === 2 && h.booked.length === 2)
    // Download lifecycle: start (charged once) → resume (no charge) → completed → ingest; resume again → replays only.
    const db2 = mkDb()
    const h2 = harness(db2)
    let statusNow = "running"
    const dl = fakeTransport((req) =>
      req.path === "/account" ? { status: 200, data: ACCOUNT(0) }
      : req.path === "/mcp" ? { status: 200, data: { jsonrpc: "2.0", id: 1, result: { structuredContent: { status: statusNow, results: ["https://files.example.com/dl-4242.json"] } } } }
      : req.body?.num_records === 0 ? { status: 200, data: { num_found: 2 } }
      : { status: 200, data: { num_found: 2, total_cost: 2, records: [], download_id: 4242 } })
    const files = { fetchDownloadFile: async () => recs as never }
    const dIn = { brokerageId: A, route: "platform" as const, mode: "download" as const, filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 2, requestId: "dl-1", territory: TERR, now: NOW }
    const s1 = await pr.runDatafinitiPeoplePull(dIn, { ...h2.deps(dl.transport), ...files } as never)
    check("download START: one paid call, booked once (2 credits), download_id checkpoint returned, still running → pending (no rows yet)", s1.stage === "download_pending" && s1.downloadId === "4242" && h2.booked.length === 1 && s1.paidCalls === 1 && (await rawCount(db2)) === 0, JSON.stringify({ s: s1.stage, r: s1.refused, b: h2.booked.length }))
    statusNow = "completed"
    const s2 = await pr.runDatafinitiPeoplePull({ ...dIn, resumeDownloadId: "4242" }, { ...h2.deps(dl.transport), ...files } as never)
    check("RESUME (completed): no paid call, no booking, the result file lands 2 rows", s2.ok && s2.paidCalls === 0 && h2.booked.length === 1 && (await rawCount(db2)) === 2)
    const s3 = await pr.runDatafinitiPeoplePull({ ...dIn, resumeDownloadId: "4242" }, { ...h2.deps(dl.transport), ...files } as never)
    check("RESUME AGAIN (download replay): no charge, no duplicate RawData", s3.ok && s3.paidCalls === 0 && h2.booked.length === 1 && (await rawCount(db2)) === 2)
    const startAgain = await pr.runDatafinitiPeoplePull(dIn, { ...h2.deps(dl.transport), ...files } as never)
    check("a replayed download START (same request) is refused by the charge-once key — no second start", startAgain.replayedCharge && h2.booked.length === 1 && dl.calls.filter((c) => c.body?.download === true).length === 1)
    // A 0-record search books nothing (documented: 0 found → 0 credits).
    const db3 = mkDb(); const h3 = harness(db3)
    const zero = await pr.runDatafinitiPeoplePull({ ...in1, requestId: "z" }, h3.deps(fakeTransport(searchScript([], 0)).transport) as never)
    check("count 0 → nothing bought, nothing booked, no paid call", zero.ok && zero.paidCalls === 0 && h3.booked.length === 0)
  }

  // ─── G ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nG — outcome unknown (owner B10): reconcile first, never a blind duplicate")
  {
    const runWith = async (afterCredits: number | "unreadable") => {
      const db = mkDb(); const h = harness(db)
      let searches = 0, accounts = 0
      const t = fakeTransport((req) => {
        if (req.path === "/account") { accounts++; return accounts === 1 ? { status: 200, data: ACCOUNT(10) } : afterCredits === "unreadable" ? { status: 401, data: { error: "x" } } : { status: 200, data: ACCOUNT(afterCredits) } }
        if (req.body?.num_records === 0) return { status: 200, data: { num_found: 1 } }
        searches++
        return searches === 1 ? { status: 500, data: { error: "boom" } } : { status: 200, data: { num_found: 1, total_cost: 1, records: [full()] } }
      })
      const r = await pr.runDatafinitiPeoplePull({ brokerageId: A, route: "platform", mode: "search", filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 1, requestId: `g-${afterCredits}`, territory: TERR, now: NOW }, h.deps(t.transport) as never)
      return { r, searches, booked: h.booked, rows: await rawCount(db) }
    }
    const notCharged = await runWith(10)
    check("NOT charged (credits unchanged): re-sent ONCE automatically, records ingested, booked once", notCharged.r.ok && notCharged.searches === 2 && notCharged.r.outcomeUnknown?.resent === true && notCharged.booked.length === 1 && notCharged.rows === 1, JSON.stringify({ s: notCharged.r.stage, ref: notCharged.r.refused }))
    const charged = await runWith(11)
    check("CHARGED (credits moved by 1): booked once from the reconcile, NOT re-sent (a re-send would charge again)", !charged.r.ok && charged.searches === 1 && charged.r.outcomeUnknown?.charged === true && charged.booked.length === 1 && charged.booked[0].metadata?.note === "outcome_unknown_reconciled")
    const unreadable = await runWith("unreadable")
    check("account UNREADABLE: held — not re-sent, nothing booked", !unreadable.r.ok && unreadable.searches === 1 && unreadable.r.outcomeUnknown?.charged === null && unreadable.booked.length === 0)
  }

  // ─── H ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nH — person / property collision")
  {
    const db = mkDb(); const h = harness(db, { contactEmails: ["held.contact@example.org"] })
    const coOwner = full({ id: "df-co", keys: ["kco"], firstName: "Riley", lastName: "Whitfield", personalEmails: ["riley.w@example.org"], phoneNumberHighScoreMobile: "+1 850-555-0199" })
    const heldContact = full({ id: "df-held", keys: ["kh"], firstName: "Jordan", lastName: "Held", personalEmails: ["held.contact@example.org"], phoneNumberHighScoreMobile: "+1 850-555-0188" })
    const r = await pr.runDatafinitiPeoplePull({ brokerageId: A, route: "platform", mode: "search", filters: { lastName: "Whitfield", postalCode: "32501" }, numRecords: 3, requestId: "h1", territory: TERR, now: NOW }, h.deps(fakeTransport(searchScript([full(), coOwner, heldContact], 3)).transport) as never)
    const rows = (await db.from("raw_scraped_leads").select("source_record_id")).data as any[]
    check("two owners of ONE property key stay TWO people (both written, never merged)", rows.some((x) => x.source_record_id === "df-person-1") && rows.some((x) => x.source_record_id === "df-co"))
    check("a person who is already this tenant's Contact (email key) is skipped at ingress — not re-written, never merged into the Contact", r.ingressDuplicates === 1 && !rows.some((x) => x.source_record_id === "df-held"))
    const lk = fakeTransport(searchScript([full()], 1))
    const look = await pr.runDatafinitiPeoplePull({ brokerageId: A, route: "platform", mode: "lookup", lookups: [{ candidate: { ref: "raw-1", source: "craigslist_fsbo", email: "held.contact@example.org" }, filters: { email: "held.contact@example.org" } }], numRecords: 1, requestId: "h2", territory: TERR, now: NOW }, h.deps(lk.transport) as never)
    check("LOOKUP of a held person is deduplicated BEFORE the paid pull — zero vendor calls", look.ok && look.prePull?.skipped === 1 && lk.calls.length === 0)
  }

  // ─── I ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nI — source freshness")
  {
    const stale = pr.mapDatafinitiPerson(full({ dateUpdated: daysAgo(3 * 365) }) as never, ctx)
    const fresh = pr.mapDatafinitiPerson(full({ dateUpdated: daysAgo(30) }) as never, ctx)
    check("a record whose dateUpdated is past the owner_profile_pull stale window (365 d) is HELD, never written", stale.outcome === "stale" && stale.record === null)
    check("POSITIVE CONTROL: the same record updated 30 days ago is written", fresh.outcome === "written")
    check("no dateUpdated → ungrounded (recency cannot be judged)", pr.mapDatafinitiPerson(full({ dateUpdated: undefined }) as never, ctx).outcome === "ungrounded")
  }

  // ─── J ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nJ — no outreach without the gate (the connector cannot send and cannot write a Contact)")
  {
    // A sender is a CALL to a send function, an IMPORT of a messaging vendor / module, or a contacts-table access — a local
    // variable that happens to share a vendor's name (the producer's own `resend` re-send step) is none of these.
    const SENDER = /\b(sendSms|sendEmail|sendMessage|dispatchOutreach|enqueueOutreach|startSequence|sendTemplated)\s*\(|from\s+["'`][^"'`]*\b(twilio|sendgrid|resend|messaging|outreach|sequences|sms)\b[^"'`]*["'`]|import\(\s*["'`][^"'`]*\b(twilio|sendgrid|resend|messaging|outreach|sequences|sms)\b[^"'`]*["'`]|from\(\s*["'`]contacts["'`]\s*\)/
    const files = ["lib/external/datafiniti-client.ts", "lib/lead-pipeline/datafiniti-people-producer.ts"]
    const raw = files.map((f) => stripComments(read(f))).join("\n")
    const hits = files.flatMap((f) => (stripComments(read(f)).match(new RegExp(SENDER.source, "g")) ?? []).map((m) => `${f}: ${m}`))
    check("the client and producer call no sender, import no messaging vendor / outreach module and touch no contacts table (stripped source)", hits.length === 0, hits.join(" | "))
    check("POSITIVE CONTROL: the finder sees a planted send call, a planted vendor import, a planted dynamic import and a planted contacts write",
      SENDER.test(`await sendSms(to)`) && SENDER.test(`import { Resend } from "resend"`) && SENDER.test(`await import("@/lib/messaging/send")`) && SENDER.test(`svc.from("contacts").insert(x)`) && !SENDER.test(`const resend = async () => {}`) && raw.length > 1000)
    check("the producer's only writes are the injected RawData door and the injected ledger booking", /deps\.ingest\(/.test(raw) && /deps\.book\(/.test(raw) && !/\.insert\(|\.upsert\(|\.update\(/.test(code("lib/lead-pipeline/datafiniti-people-producer.ts")))
  }

  // ─── K ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nK — registry truth (simulated / awaiting license — NEVER ready)")
  {
    const cm = await import("../lib/providers/provider-capability-matrix")
    const row = cm.providerCapabilityMatrix().find((r) => r.provider === "datafiniti")!
    check("capability matrix: transport + RawData producer + mapper + free-count anchors, proof test:datafiniti-connector", !!row && row.transport?.symbol === "searchDatafinitiPeople" && row.producer.door === "rawdata" && row.mapping.anchor?.symbol === "mapDatafinitiPerson" && row.preview.kind === "free_estimate" && row.proofScript === "test:datafiniti-connector")
    check("both routes read AWAITING LICENSE (rights pending) — never simulated-as-ready, never ready", row.states.platform === "awaiting_license" && row.states.tenant === "awaiting_license" && !/ready/.test(row.honestState.replace(/awaiting/g, "")), row.honestState)
    const notReady = cm.providerCapabilityMatrix().filter((r) => r.states.platform === "ready" || r.states.tenant === "ready")
    check("POSITIVE CONTROL for the state reader: no matrix row reads ready (no live evidence anywhere) and the reader DOES see awaiting_license", notReady.length === 0 && cm.providerCapabilityMatrix().some((r) => r.states.platform === "awaiting_license"))
    const sc = await import("../lib/providers/provider-scorecard")
    const v = sc.activationVerdict("datafiniti")
    check("scorecard: dormant_pending_rights, WAITING_LICENSE, may NOT activate (rights not_read, no contract), offline test allowed", PROVIDER_ACTIVATION.datafiniti.state === "dormant_pending_rights" && sc.PROVIDER_RECOMMENDATION.datafiniti.tier === "WAITING_LICENSE" && !v.mayActivate && v.offlineTestAllowed && v.blockers.some((b) => /rights/.test(b)))
    const fieldRows = sc.PROVIDER_FIELD_SCORECARD.filter((r) => r.provider === "datafiniti")
    const { DATAFINITI_PEOPLE_CEILING_UNIT_USD, VENDOR_PRICING, vendorPriceState } = await import("../lib/vendor-governance/cost-normalizer")
    check("scorecard field rows price per record at the published ceiling (the constant, not a second number) and the count is free", fieldRows.length >= 3 && fieldRows.filter((r) => r.unit === "per_record").every((r) => r.unitUsd === DATAFINITI_PEOPLE_CEILING_UNIT_USD) && fieldRows.some((r) => r.field === "preview_count" && r.unitUsd === 0))
    check("the price row is VARIABLE with its dated source (never fixed, never $0)", vendorPriceState("datafiniti") === "variable" && VENDOR_PRICING.datafiniti.costPerUnit === DATAFINITI_PEOPLE_CEILING_UNIT_USD && /read 2026-11-16/.test(VENDOR_PRICING.datafiniti.priceSource ?? ""))
    const pa = await import("../lib/kernel/provider-adapters")
    const ad = pa.deriveProviderAdapters().adapters.find((a) => a.provider === "datafiniti")
    check("adapter declared and reached through the connector gateway (callConnector site), platform env credential by NAME", !!ad && ad.route.paths.includes("connector_gateway") && ad.credential.envVars.includes("DATAFINITI_API_TOKEN") && ad.api.version === "v4" && pa.validateProviderAdapter(ad).length === 0, ad ? pa.validateProviderAdapter(ad).join("; ") : "no adapter")
    const tm = await import("../lib/providers/tenancy-matrix")
    const ten = tm.PROVIDER_TENANCY.find((t) => t.provider === "datafiniti")
    check("tenancy: platform_metered + tenant_optional_key, env by name", !!ten && ten.models.join() === "platform_metered,tenant_optional_key" && ten.envVars.join() === "DATAFINITI_API_TOKEN")
    const cat = tp.TENANT_ACQUISITION_PROVIDERS.datafiniti
    check("Integrations catalogue: transport_built, api_key only (documented token field — no generic API field), free account read, no push door", !!cat && cat.adapter.state === "transport_built" && cat.transports.join() === "api_key" && cat.fields.some((f) => f.key === "apiKey" && f.secret) && cat.healthCheck.kind === "free_account_read" && cat.webhook === null && /\btoken\b/.test(code(cat.adapter.module)))
    const sim = await import("../lib/lead-pipeline/source-intent-map")
    const rights = sim.sourceRightsFor("datafiniti_people")
    check("source datafiniti_people: licensed_vendor under datafiniti_terms_not_read, vendor datafiniti, paid person data, intent unknown, not a default market source", rights.rights === "licensed_vendor" && rights.licence === "datafiniti_terms_not_read" && rights.vendor === "datafiniti" && sim.SOURCE_PAID_PERSON_DATA.datafiniti_people === true && sim.getSourceSemantics("datafiniti_people").intentType === "unknown" && !sim.DEFAULT_MARKET_SOURCES.includes("datafiniti_people" as never))
    // m949 — the RULE: its CHECK = the live vocabulary (generated cache) + 'datafiniti'; line 1 is the lane stamp OR applied.
    const cache = read("scripts/check-vocabularies.ts")
    const live = (cache.slice(cache.indexOf("  platform_credentials: {")).match(/platform: \[([^\]]*)\]/)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? []
    const m949 = read("supabase/migrations/m949-tenant-owned-datafiniti-credential-door.sql")
    const m949Values = [...new Set((m949.slice(m949.indexOf("ADD CONSTRAINT platform_credentials_platform_check")).match(/'([a-z0-9_]+)'/g) ?? []).map((s) => s.slice(1, -1)))]
    const want = [...new Set([...live, "datafiniti"])].sort()
    check(`m949 keeps every live platform value (${live.length}) and adds datafiniti — set equality, never a hand count`, live.length > 50 && m949Values.slice().sort().join() === want.join(), JSON.stringify({ missing: want.filter((x) => !m949Values.includes(x)), extra: m949Values.filter((x) => !want.includes(x)) }))
    check("POSITIVE CONTROL: a migration missing one live value is caught", want.filter((x) => x !== "idxbroker").join() !== want.join())
    const l1 = m949.split("\n")[0]
    check("m949 line 1 is the lane stamp or an APPLIED LIVE stamp (the rule, not the waypoint)", l1 === "-- WRITTEN, NOT APPLIED (wave 153, lane 153M) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL" || l1.startsWith("-- ── APPLIED LIVE "))
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    check("package.json registers test:datafiniti-connector and the guard chain runs it", /datafiniti-connector-guard/.test(pkg.scripts["test:datafiniti-connector"] ?? "") && /npm run test:datafiniti-connector(?= &&|$)/.test(pkg.scripts.guard))
    const tokenLeak = /DATAFINITI_API_TOKEN\s*=\s*["'`][A-Za-z0-9]/.test(read("lib/external/datafiniti-client.ts")) || /console\.(log|info|warn|error)\([^)]*token/i.test(code("lib/external/datafiniti-client.ts"))
    check("no token value in source and no token logged", !tokenLeak)
  }

  // ─── L ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nL — economics (published figures with their sources — derived from the scorecard, never re-typed)")
  {
    const sc = await import("../lib/providers/provider-scorecard")
    const cmp = ["datafiniti", "versium", "batchdata", "rentcast", "tracerfy", "datazapp", "peopledata"] as const
    for (const p of cmp) {
      const rows = sc.PROVIDER_FIELD_SCORECARD.filter((r) => r.provider === p && (r.field === "owner_phone" || r.field === "owner_email" || r.field === "property_facts"))
      const line = rows.map((r) => `${r.field} ${r.unitUsd === null ? "UNKNOWN" : `$${r.unitUsd}`}/${r.unit.replace("per_", "")}`).join(", ") || "no contact / property field row"
      console.log(`    ${p.padEnd(11)} ${PROVIDER_ACTIVATION[p].state.padEnd(22)} ${line}`)
    }
    const { DATAFINITI_PEOPLE_PUBLISHED_PLANS } = await import("../lib/vendor-governance/cost-normalizer")
    console.log(`    datafiniti published plans (datafiniti.co/data/people-data, read 2026-11-16): ${DATAFINITI_PEOPLE_PUBLISHED_PLANS.map((t) => `${t.records}/mo $${t.monthlyUsd} ($${(t.monthlyUsd / t.records).toFixed(4)}/record)`).join(" · ")}`)
    console.log("    NOTE: Datafiniti charges per record RETURNED (a match or not); Versium / Tracerfy charge per MATCH (a miss is free) — the per-unit numbers are not like-for-like. The 50k plan is a public indicative price, not a platform quote.")
    check("the comparison covers every provider the directive names, each from its scorecard row", cmp.every((p) => sc.PROVIDER_FIELD_SCORECARD.some((r) => r.provider === p)))
  }

  console.log("\nCERTIFICATION")
  console.log("  code-certified (offline, injected transport + in-memory database): query builder, mapper, count, search, download start / status / resume, account health, failures, isolation, rights gate, charge-once, outcome-unknown reconcile, RawData ingest, registries")
  console.log("  live-verified: NONE — no Datafiniti account, no token, no live call (owner-held: licensing decision; license-held: SaaS / storage / AI / outreach rights)")
  console.log(`\nDATAFINITI CONNECTOR — RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log("❌ DATAFINITI_CONNECTOR_FAIL"); process.exit(1) }
  console.log("✅ DATAFINITI_CONNECTOR_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
