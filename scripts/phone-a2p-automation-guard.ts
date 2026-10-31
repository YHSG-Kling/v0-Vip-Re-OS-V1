#!/usr/bin/env tsx
/**
 * scripts/phone-a2p-automation-guard.ts   (npm run test:phone-a2p-automation)
 * ─────────────────────────────────────────────────────────────────────────────
 * PHONE → A2P AUTOMATION, CERTIFIED BY WALKING IT (wave 140, lane 140G).
 *
 * ALREADY EXISTED — REUSED: lib/voice/number-provisioning.ts (provision →
 * ownership → webhook bind → kickCarrierRegistration), lib/voice/
 * a2p-registration.ts (THE step machine; isTollFreeNumber decides the lane;
 * every status is Twilio's own), lib/voice/carrier-registration-loop.ts (the
 * hourly tick + CarrierPhase, the ONE phase vocabulary).
 * BUILT (140G): classifyCarrierFailure + haltVerdict (a credential / compliance
 * refusal halts automatic retry), CarrierPhase `halted`, the tenant's four UI
 * states derived from the phase, and syncA2pStatus — the ONE status sync the
 * readiness repair calls, with its readiness verdict.
 *
 * This proof drives the REAL runners against a simulated Twilio (an injected
 * transport) and an in-memory database and asserts:
 *   1. provisioning starts registration automatically (behaviour + source order);
 *   2. status moves ONLY on provider confirmation (never written by our code);
 *   3. the four UI states derive from stored status — every phase maps to one;
 *   4. the sync is idempotent (approved = zero calls; in review = polls only,
 *      never a second filing; the state is byte-identical between syncs);
 *   5. a credential failure → ACTION_REQUIRED with the provider's reason, ZERO
 *      calls on later ticks / syncs, exactly one retry on a human resume; a
 *      compliance refusal halts until the profile changes; a 503 (control) is
 *      retried on the next tick.
 * No network, no DB, no Twilio. Run: npx tsx scripts/phone-a2p-automation-guard.ts
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import {
  classifyCarrierFailure, haltVerdict, profileFingerprint, kickCarrierRegistration, loadA2pState, isTollFreeNumber, deriveA2pProfile,
  type TwilioTransport, type A2pState,
} from "../lib/voice/a2p-registration"
import { advanceTenantCarrier, carrierRegistrationPhase, carrierTickPlan, syncA2pStatus, type CarrierPhase } from "../lib/voice/carrier-registration-loop"
import { BUSINESS_REGISTRATION_SETTINGS_KEY } from "../lib/branding/business-registration"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── In-memory database (the supabase-js surface the loop uses). Writers COUNT
// rows (CLAUDE.md §3): update()/insert() + .select() return the matched rows.
type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" = "select"
    let patch: Row | null = null
    let newRow: Row | null = null
    let lim = Infinity
    const q: any = {}
    q.select = () => q
    q.order = () => q
    q.limit = (n: number) => { lim = n; return q }
    q.eq = (k: string, v: any) => { preds.push((r) => r[k] === v); return q }
    q.in = (k: string, vs: any[]) => { preds.push((r) => vs.includes(r[k])); return q }
    q.is = (k: string, v: any) => { preds.push((r) => (v === null ? r[k] == null : r[k] === v)); return q }
    q.not = (k: string, _op: string, v: any) => {
      if (k.includes("->")) { const [c, key] = k.split("->"); preds.push((r) => r[c]?.[key] != null) }
      else preds.push((r) => (v === null ? r[k] != null : r[k] !== v))
      return q
    }
    q.insert = (row: Row) => { op = "insert"; newRow = { id: `${table}-${++seq}`, ...row }; return q }
    q.update = (p: Row) => { op = "update"; patch = p; return q }
    const run = () => {
      const t = (tables[table] ??= [])
      if (op === "insert") { t.push(newRow!); return { data: [newRow], error: null } }
      const hits = t.filter((r) => preds.every((p) => p(r)))
      if (op === "update") { hits.forEach((r) => Object.assign(r, patch)); return { data: hits.map((r) => ({ id: r.id })), error: null } }
      return { data: JSON.parse(JSON.stringify(hits.slice(0, lim))), error: null }
    }
    q.maybeSingle = async () => { const r = run(); return { data: (r.data as Row[])[0] ?? null, error: r.error } }
    q.single = q.maybeSingle
    q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return q
  }
  return { tables, from } as any
}

// ── Simulated Twilio TrustHub + Messaging (the injected transport) ──────────
type Script = { brand: string[]; campaign: string[]; tollfree?: string[]; refuse?: { path: RegExp; status: number; error: string; times?: number }; evalStatus?: string }
function fakeTwilio(script: Script) {
  const calls: Array<{ method: string; path: string }> = []
  let brandPolls = 0, campaignPolls = 0, tfPolls = 0, refused = 0
  const t: TwilioTransport = async ({ method, path }) => {
    calls.push({ method, path })
    const ok = (data: any) => ({ ok: true, status: 200, data, error: null })
    if (script.refuse && script.refuse.path.test(path) && (script.refuse.times === undefined || refused < script.refuse.times)) { refused++; return { ok: false, status: script.refuse.status, data: null, error: script.refuse.error } }
    if (method === "POST" && path === "/v1/CustomerProfiles") return ok({ sid: "BU_cp" })
    if (method === "POST" && path === "/v1/TrustProducts") return ok({ sid: "BU_tp" })
    if (method === "POST" && path === "/v1/EndUsers") return ok({ sid: `IT_${calls.length}` })
    if (method === "POST" && path.endsWith("/Addresses.json")) return ok({ sid: "AD_1" })
    if (method === "POST" && path === "/v1/SupportingDocuments") return ok({ sid: "RD_1" })
    if (path.endsWith("/EntityAssignments")) return ok({ sid: "BV_1" })
    if (path.endsWith("/Evaluations")) return ok({ status: script.evalStatus ?? "compliant" })
    if (method === "POST" && /^\/v1\/(CustomerProfiles|TrustProducts)\/BU_/.test(path)) return ok({ status: "pending-review" })
    if (method === "POST" && path === "/v1/a2p/BrandRegistrations") return ok({ sid: "BN_1", status: script.brand[0] })
    if (method === "GET" && path === "/v1/a2p/BrandRegistrations/BN_1") return ok({ status: script.brand[Math.min(++brandPolls, script.brand.length - 1)] })
    if (method === "POST" && path === "/v1/Services") return ok({ sid: "MG_1" })
    if (method === "POST" && path === "/v1/Services/MG_1/PhoneNumbers") return ok({ sid: "PN" })
    if (method === "POST" && path === "/v1/Services/MG_1/Compliance/Usa2p") return ok({ sid: "QE_1", campaign_status: script.campaign[0] })
    if (method === "GET" && path === "/v1/Services/MG_1/Compliance/Usa2p/QE_1") return ok({ campaign_status: script.campaign[Math.min(++campaignPolls, script.campaign.length - 1)] })
    if (method === "POST" && path === "/v1/Tollfree/Verifications") return ok({ sid: "HH_1", status: (script.tollfree ?? ["PENDING_REVIEW"])[0] })
    if (method === "GET" && path === "/v1/Tollfree/Verifications/HH_1") return ok({ status: (script.tollfree ?? [])[Math.min(++tfPolls, (script.tollfree ?? []).length - 1)] })
    return { ok: false, status: 404, data: null, error: `unscripted ${method} ${path}` }
  }
  const posts = () => calls.filter((c) => c.method === "POST").length
  return { transport: t, calls, posts }
}

const deps = (tw: ReturnType<typeof fakeTwilio>, numbersAllowed: boolean | null = true) => ({
  carrier: { transport: tw.transport, master: { accountSid: "AC_master", authToken: "x" }, tenantCreds: async () => ({ accountSid: "AC_sub", authToken: "y", tier: "subaccount" }) },
  port: { creds: null },
  numbersAllowed: async () => numbersAllowed,
})

const BROKERAGE = { id: "b1", name: "Kling Realty Group LLC", address: "100 Congress Ave", city: "Austin", state: "TX", zip: "78701", phone: "+15125550100", email: "office@kling.example", website: "https://kling.example", slug: "kling-realty-ab12" }
const OWNER = { id: "u-owner", brokerage_id: "b1", user_type: "broker_owner", first_name: "Dana", last_name: "Kling", email: "dana@kling.example", phone: "+15125550111", deleted_at: null }
const TYPED = { ein: "123456789", businessType: "Limited Liability Corporation", privacyPolicyUrl: "https://kling.example/privacy", termsUrl: "https://kling.example/terms" }

function tenantDb(extra: { typed?: Record<string, string> | null; numbers?: Row[] } = {}) {
  return fakeDb({
    brokerages: [{ ...BROKERAGE }],
    users: [{ ...OWNER }],
    brokerage_settings: extra.typed === null ? [] : [{ id: "bs1", brokerage_id: "b1", settings: { [BUSINESS_REGISTRATION_SETTINGS_KEY]: extra.typed ?? TYPED } }],
    tenant_phone_numbers: extra.numbers ?? [{ id: "n1", brokerage_id: "b1", phone_number: "+15125551212", twilio_number_sid: "PN_1", is_active: true, scope_type: "brokerage" }],
    platform_credentials: [],
    phone_number_events: [],
    notifications: [],
  })
}
const stateOf = async (db: any) => (await loadA2pState(db, "b1")).state
const strip = (s: A2pState) => { const { updated_at: _u, ...rest } = s; return JSON.stringify(rest) }

async function main() {
  console.log("\n[0 · controls on the scanner]")
  const selfTest = stripComments('const a = 1 // a "VERIFIED" note with a /* in it\nconst b = 2')
  check("CONTROL: strip-comments keeps code after a // line containing /* (the recurring defect)", /const b = 2/.test(selfTest) && !/VERIFIED/.test(selfTest))

  console.log("\n[1 · NUMBER PROVISIONED → OWNERSHIP → CONFIG → A2P REQUIREMENT → REGISTRATION STARTED AUTOMATICALLY]")
  {
    const np = stripped("lib/voice/number-provisioning.ts")
    const i = (s: string) => np.indexOf(s)
    check("provisionNumber: allowance gate → purchase → tenant_phone_numbers row (tenant + scope ownership) → webhook bind → kickCarrierRegistration, in that order",
      i("evaluateTenantNumberProvisioning") > -1 && i("evaluateTenantNumberProvisioning") < i("purchaseIncomingPhoneNumber(") && i("purchaseIncomingPhoneNumber(") < i('.from("tenant_phone_numbers")') && i("bindNumberToTwilioLane(svc, numberRowId)") > i('.from("tenant_phone_numbers")') && i('kickCarrierRegistration(svc, { brokerageId: params.brokerageId, phoneNumber: targetNumber, trigger: "purchased" })') > i("bindNumberToTwilioLane(svc, numberRowId)"))
    check("OWNERSHIP is written on the row the live schema holds (tenant_phone_numbers brokerage_id + scope_type + agent_user_id — both the purchase and the attach insert)", (np.match(/brokerage_id: params\.brokerageId,\s*\n\s*scope_type: params\.scopeType/g) ?? []).length === 2 && (np.match(/agent_user_id: params\.scopeType === "agent" \? params\.agentUserId/g) ?? []).length === 2)
    check("a ported / BYO number takes the SAME path (attachOwnedNumber → kickCarrierRegistration with its trigger)", /kickCarrierRegistration\(svc, \{ brokerageId: params\.brokerageId, phoneNumber: cleaned, trigger: params\.source === "ported_in" \? "ported_in" : "manually_added" \}\)/.test(np))
    check("A2P REQUIREMENT DECIDED per number by the ONE rule: local → 10DLC, 8xx → toll-free verification", !isTollFreeNumber("+15125551212") && isTollFreeNumber("+18885550100") && /isTollFreeNumber\(args\.phoneNumber\) \? "tollfree" : "10dlc"/.test(stripped("lib/voice/a2p-registration.ts")))
    // Behaviour: the kickoff FILES the moment a local number lands.
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"] })
    const k = await kickCarrierRegistration(db, { brokerageId: "b1", phoneNumber: "+15125551212", trigger: "purchased", deps: deps(tw).carrier })
    const s = await stateOf(db)
    check("kickoff after purchase files the TrustHub profile → trust product → brand → service → attach with no human (10dlc lane)", k.kicked && k.lane === "10dlc" && !!s.customer_profile_sid && s.brand_sid === "BN_1" && s.number_attached === true && tw.calls.some((c) => c.path === "/v1/CustomerProfiles"))
    check("…audited on phone_number_events with source a2p_auto_kickoff", db.tables.phone_number_events.some((e: Row) => e.source === "a2p_auto_kickoff" && /kicked/.test(e.notes)))
    const probe = await syncA2pStatus(db, "b1", { deps: deps(tw), probeOnly: true })
    check("STATUS TRACKED: the stored state reads PENDING_REGISTRATION (brand under review) right after the kickoff", probe.uiState === "PENDING_REGISTRATION" && probe.phase === "carrier_review")
  }

  console.log("\n[2 · status moves ONLY on provider confirmation]")
  {
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING", "PENDING", "PENDING", "APPROVED"], campaign: ["IN_PROGRESS", "IN_PROGRESS", "VERIFIED"] })
    const seen: Array<{ ui: string; campaign: string | undefined }> = []
    for (let i = 0; i < 8; i++) { const r = await advanceTenantCarrier(db, "b1", deps(tw)); seen.push({ ui: r.uiState, campaign: (await stateOf(db)).campaign_status }) }
    const firstAvail = seen.findIndex((x) => x.ui === "AVAILABLE")
    check("AVAILABLE appears only on the tick Twilio reports VERIFIED — every earlier tick is PENDING_REGISTRATION", firstAvail > 1 && seen.slice(0, firstAvail).every((x) => x.ui === "PENDING_REGISTRATION") && seen[firstAvail].campaign === "VERIFIED", JSON.stringify(seen))
    const n0 = tw.calls.length
    const again = await advanceTenantCarrier(db, "b1", deps(tw))
    check("after approval the state stays AVAILABLE and the next tick costs ZERO provider calls", again.uiState === "AVAILABLE" && tw.calls.length === n0)
    // No production file may WRITE an approval the carrier did not send.
    const scan = (code: string) => /(campaign_status|tollfree_status|brand_status)\s*=\s*"(VERIFIED|APPROVED|TWILIO_APPROVED)"/.test(stripComments(code))
    check("CONTROL: the approval-write finder catches a specimen", scan('state.campaign_status = "VERIFIED"'))
    const files = ["lib/voice/a2p-registration.ts", "lib/voice/carrier-registration-loop.ts", "lib/voice/number-port-in.ts", "lib/voice/number-provisioning.ts", "app/api/cron/carrier-registration-tick/route.ts", "app/actions/a2p-registration.ts", "app/actions/superadmin/a2p-verify.ts"]
    check(`no approval is ever written by our code — only copied from Twilio's answer (${files.length} files, comments stripped)`, files.every((f) => !scan(src(f))))
    check("the tenant-facing status is derived (tenantA2pUiState) — the four states are never persisted as a second status", !/uiState\s*:/.test(stripped("lib/voice/a2p-registration.ts")) && /function tenantA2pUiState\(phase: CarrierPhase/.test(stripped("lib/voice/carrier-registration-loop.ts")))
  }

  console.log("\n[3 · the FOUR UI states derive from the stored status — every phase maps to exactly one]")
  {
    const base: A2pState = { customer_profile_sid: "BU", trust_product_sid: "BU2", brand_sid: "BN", brand_status: "APPROVED", messaging_service_sid: "MG", number_attached: true, campaign_sid: "QE", campaign_status: "IN_PROGRESS" }
    const local = [{ id: "n1", brokerage_id: "b1", phone_number: "+15125551212", twilio_number_sid: "PN_1", is_active: true }]
    const cases: Array<{ name: string; state: A2pState; numbers: Row[]; typed?: Record<string, string> | null; phase: CarrierPhase; ui: string }> = [
      { name: "approved → AVAILABLE", state: { ...base, campaign_status: "VERIFIED" }, numbers: local, phase: "approved", ui: "AVAILABLE" },
      { name: "carrier_review → PENDING_REGISTRATION", state: base, numbers: local, phase: "carrier_review", ui: "PENDING_REGISTRATION" },
      { name: "filing with the profile already submitted → PENDING_REGISTRATION", state: { customer_profile_sid: "BU", last_error: "Trust product create failed: 503", last_error_class: "transient" }, numbers: local, phase: "filing", ui: "PENDING_REGISTRATION" },
      { name: "filing with NOTHING filed yet (unregistered number) → RESTRICTED", state: {}, numbers: local, phase: "filing", ui: "RESTRICTED" },
      { name: "no_numbers → RESTRICTED", state: {}, numbers: [], phase: "no_numbers", ui: "RESTRICTED" },
      { name: "needs_input → ACTION_REQUIRED", state: {}, numbers: local, typed: null, phase: "needs_input", ui: "ACTION_REQUIRED" },
      { name: "rejected (brand FAILED) → ACTION_REQUIRED", state: { ...base, brand_status: "FAILED", campaign_sid: undefined, last_error: "TAX_ID mismatch" }, numbers: local, phase: "rejected", ui: "ACTION_REQUIRED" },
      { name: "halted (credential) → ACTION_REQUIRED with the provider's reason", state: { last_error: "Customer profile create failed: HTTP 401 Authenticate", last_error_class: "credential", halted_at: "2026-10-11T00:00:00.000Z" }, numbers: local, phase: "halted", ui: "ACTION_REQUIRED" },
    ]
    const seenPhases = new Set<CarrierPhase>()
    for (const c of cases) {
      const db = tenantDb({ typed: c.typed, numbers: c.numbers })
      db.tables.platform_credentials.push({ id: "pc1", brokerage_id: "b1", platform: "twilio_a2p", is_active: true, config: c.state })
      const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"] })
      const r = await syncA2pStatus(db, "b1", { deps: deps(tw), probeOnly: true })
      seenPhases.add(r.phase)
      check(`${c.name} (probe: zero provider calls)`, r.phase === c.phase && r.uiState === c.ui && tw.calls.length === 0 && (c.phase !== "halted" || /401|Authenticate/.test(r.reason)), `${r.phase}/${r.uiState}: ${r.reason}`)
    }
    const ALL: CarrierPhase[] = ["no_numbers", "needs_input", "filing", "carrier_review", "approved", "rejected", "halted"]
    check("every CarrierPhase was exercised and each landed in one of the four states (exhaustive)", ALL.every((p) => seenPhases.has(p)))
    check("the pure phase still answers the same for the halted state (one vocabulary, no second rule)", carrierRegistrationPhase({ last_error: "x", last_error_class: "credential", halted_at: "2026-10-11T00:00:00.000Z" }, [{ phone_number: "+15125551212" }], []).phase === "halted")
    const card = stripped("app/dashboard/admin/phone-settings/a2p-card.tsx")
    const action = stripped("app/actions/a2p-registration.ts")
    check("the tenant card renders uiState / uiLabel from the action, and the action reads them from syncA2pStatus (probeOnly)", /r\.status\.uiState/.test(card) && /UI_STATE_CLASS\[uiState\]/.test(card) && /syncA2pStatus\(svc, auth\.brokerageId, \{ probeOnly: true \}\)/.test(action) && /syncA2pStatus\(svc, auth\.brokerageId, \{ resume: true \}\)/.test(action))
    check("the cron summary reports ACTION_REQUIRED by the same derived state", /x\.uiState === "ACTION_REQUIRED"/.test(stripped("app/api/cron/carrier-registration-tick/route.ts")))
  }

  console.log("\n[4 · the sync is idempotent]")
  let reviewRequired: boolean | null = null // the required flag of a filed review, compared against the no-number verdict in [6]
  {
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING", "PENDING", "PENDING"], campaign: ["IN_PROGRESS"] })
    const r1 = await syncA2pStatus(db, "b1", { deps: deps(tw) })
    const posts1 = tw.posts()
    const s1 = strip(await stateOf(db))
    const r2 = await syncA2pStatus(db, "b1", { deps: deps(tw) })
    const r3 = await syncA2pStatus(db, "b1", { deps: deps(tw) })
    const s3 = strip(await stateOf(db))
    check("first sync files (POSTs); the second and third make ZERO new POSTs — a review in flight is polled (GET), never re-filed", posts1 > 0 && tw.posts() === posts1 && tw.calls.filter((c) => c.method === "GET").length >= 2, `posts ${posts1} → ${tw.posts()}`)
    check("the stored state is identical between syncs (updated_at aside) and the view is the same", s1 === s3 && r1.uiState === r2.uiState && r2.uiState === r3.uiState && r3.uiState === "PENDING_REGISTRATION")
    check("exactly ONE twilio_a2p state row exists after three syncs (no duplicate filings on retry)", db.tables.platform_credentials.filter((r: Row) => r.platform === "twilio_a2p").length === 1)
    reviewRequired = r3.readiness.required
    check("the readiness verdict for a review in flight is WAITING_EXTERNAL and REQUIRED (compliance_officer owns it; not READY until the carrier answers)", r3.readiness.status === "WAITING_EXTERNAL" && r3.readiness.required === true && r3.readiness.owner === "compliance_officer")
    // Approved tenant: a sync is free.
    const db2 = tenantDb()
    const tw2 = fakeTwilio({ brand: ["APPROVED"], campaign: ["VERIFIED"] })
    await syncA2pStatus(db2, "b1", { deps: deps(tw2) })
    const n = tw2.calls.length
    const a = await syncA2pStatus(db2, "b1", { deps: deps(tw2) })
    const b = await syncA2pStatus(db2, "b1", { deps: deps(tw2) })
    check("an approved, pooled tenant: two more syncs cost ZERO provider calls, AVAILABLE, readiness PASS", tw2.calls.length === n && a.uiState === "AVAILABLE" && b.readiness.status === "PASS" && b.testUnlocked)
  }

  console.log("\n[5 · a credential failure → ACTION REQUIRED, never retried silently]")
  {
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"], refuse: { path: /^\/v1\/CustomerProfiles$/, status: 401, error: "HTTP 401 Authenticate: invalid credentials" } })
    const r1 = await advanceTenantCarrier(db, "b1", deps(tw))
    const s1 = await stateOf(db)
    check("a 401 from the provider is classified credential, the halt is stamped, the phase is halted and the tenant state is ACTION_REQUIRED", s1.last_error_class === "credential" && !!s1.halted_at && r1.after === "halted" && r1.uiState === "ACTION_REQUIRED")
    check("…with the PROVIDER's reason on the state, not an invented one", /401|Authenticate/.test(s1.last_error ?? ""))
    check("…and rung ONCE with that reason", db.tables.notifications.filter((n: Row) => n.type === "carrier_registration").length === 1 && /401|Authenticate/.test(db.tables.notifications[0].body))
    const n1 = tw.calls.length
    for (let i = 0; i < 3; i++) await advanceTenantCarrier(db, "b1", deps(tw))
    check("the next THREE hourly ticks make ZERO provider calls (never retried silently) and ring nothing more", tw.calls.length === n1 && db.tables.notifications.length === 1)
    const probe = await syncA2pStatus(db, "b1", { deps: deps(tw) })
    check("syncA2pStatus (the readiness repair) REFUSES to run while halted: ok=false, zero calls, readiness BLOCKED owned by platform (credentials are the platform's)", !probe.ok && tw.calls.length === n1 && probe.halted?.class === "credential" && probe.readiness.status === "BLOCKED" && probe.readiness.owner === "platform")
    check("carrierTickPlan is the halt's pure gate (no runs) — and a different profile fingerprint does NOT lift a credential halt", !carrierTickPlan(s1, db.tables.tenant_phone_numbers, true, "other").run10dlc && haltVerdict(s1, "other").halted)
    // The tenant's own edit does not resume a credential halt; a human resume does — exactly once.
    const resumed = await syncA2pStatus(db, "b1", { deps: deps(tw), resume: true })
    check("a HUMAN resume retries exactly once (one new provider call), is refused again by the still-broken credentials, and re-halts", tw.calls.length === n1 + 1 && !resumed.ok && resumed.halted?.class === "credential")
    // Credentials fixed → the next human resume files through.
    const fixed = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"] })
    const after = await syncA2pStatus(db, "b1", { deps: deps(fixed), resume: true })
    check("once the credentials work, the resume files and the halt clears (PENDING_REGISTRATION)", after.halted === null && after.uiState === "PENDING_REGISTRATION" && !!(await stateOf(db)).customer_profile_sid)
  }
  {
    // Compliance: TrustHub says the profile is not compliant → halted until the profile CHANGES.
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"], evalStatus: "noncompliant" })
    await advanceTenantCarrier(db, "b1", deps(tw))
    const s = await stateOf(db)
    check("a TrustHub 'not compliant' evaluation is classified compliance and halts (no hourly re-mint of a profile shell)", s.last_error_class === "compliance" && !!s.halted_at && s.halted_profile_fingerprint === profileFingerprint(deriveA2pProfile({ registration: TYPED, brokerage: BROKERAGE, owner: OWNER, appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null }).draft))
    const n = tw.calls.length
    await advanceTenantCarrier(db, "b1", deps(tw))
    check("…the next tick makes ZERO calls while the profile is unchanged", tw.calls.length === n)
    db.tables.brokerage_settings[0].settings[BUSINESS_REGISTRATION_SETTINGS_KEY] = { ...TYPED, businessType: "Corporation" }
    const ok = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"] })
    const r = await advanceTenantCarrier(db, "b1", deps(ok))
    check("the tenant correcting the registration (fingerprint changes) lifts the compliance halt on the next tick — it files again", r.ran.includes("10dlc") && ok.calls.some((c) => c.path === "/v1/CustomerProfiles") && !(await stateOf(db)).halted_at)
  }
  {
    // CONTROL: a transient 503 is NOT a halt — the next tick retries.
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"], refuse: { path: /^\/v1\/CustomerProfiles$/, status: 503, error: "HTTP 503" , times: 1 } })
    const r1 = await advanceTenantCarrier(db, "b1", deps(tw))
    const s1 = await stateOf(db)
    const n = tw.calls.length
    const r2 = await advanceTenantCarrier(db, "b1", deps(tw))
    check("CONTROL: a 503 is classified transient, nothing halts (PENDING/RESTRICTED, never ACTION_REQUIRED), and the next tick retries and files", s1.last_error_class === "transient" && !s1.halted_at && r1.uiState !== "ACTION_REQUIRED" && tw.calls.length > n && !!(await stateOf(db)).customer_profile_sid && r2.after === "carrier_review")
    check("classification table: 401/403 → credential · 'not compliant' → compliance · 400 → compliance · 429/503/network → transient · missing profile → input",
      classifyCarrierFailure({ status: 403, error: "forbidden" }, "x") === "credential" && classifyCarrierFailure({ status: 200, error: null }, "Customer profile not compliant — (Twilio: noncompliant)") === "compliance" && classifyCarrierFailure({ status: 400, error: "30796 stock fields" }, "x") === "compliance" && classifyCarrierFailure({ status: 429, error: "rate" }, "x") === "transient" && classifyCarrierFailure({ status: 503, error: null }, "x") === "transient" && classifyCarrierFailure({ status: null, error: "ECONNRESET" }, "x") === "transient" && classifyCarrierFailure({ status: null, error: null }, "Business profile incomplete — missing: EIN") === "input" && classifyCarrierFailure({ status: null, error: null }, "Twilio master account not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN)") === "credential")
  }

  console.log("\n[6 · readiness rule for a tenant with no number: WAITING_EXTERNAL / NOT_APPLICABLE, never BLOCKED]")
  {
    const db = tenantDb({ numbers: [] })
    const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"] })
    const a = await syncA2pStatus(db, "b1", { deps: deps(tw, true) })
    const b = await syncA2pStatus(db, "b1", { deps: deps(tw, false) })
    const c = await syncA2pStatus(db, "b1", { deps: deps(tw, null) })
    check("no number + plan admits numbers → WAITING_EXTERNAL with required:false (RESTRICTED to the tenant; 'never a blocker' IS the flag the contract's READY rule reads), zero provider calls", a.readiness.status === "WAITING_EXTERNAL" && a.readiness.required === false && a.uiState === "RESTRICTED" && a.phase === "no_numbers" && tw.calls.length === 0)
    check("no number + plan admits NO number → NOT_APPLICABLE (not required)", b.readiness.status === "NOT_APPLICABLE" && !b.readiness.required)
    check("an unknown plan read (null) is WAITING_EXTERNAL, required:false — a refused read never reads as not-applicable, never BLOCKED, never a blocker", c.readiness.status === "WAITING_EXTERNAL" && c.readiness.required === false)
    // THE RULE (not a waypoint): of the two WAITING_EXTERNAL verdicts, only the one the carrier owes an answer on is required.
    check("CONTROL: a filed review ([4]) is the required:true WAITING_EXTERNAL and a missing number the required:false one — the flag alone tells them apart", reviewRequired === true && a.readiness.required === false)
    check("the rule is written beside the sync for lane 140B/K (READINESS HOOK + never BLOCKED)", /READINESS HOOK \(integrator\)/.test(src("lib/voice/carrier-registration-loop.ts")) && /NEVER BLOCKED/.test(src("lib/voice/carrier-registration-loop.ts")))
  }

  console.log("\n[6b · the platform sentinel's stall detector reads the failure CLASS (wave 140P; this lane's outside-lane finding)]")
  {
    const { assessA2pStall, A2P_FAILED_STALL_DAYS } = await import("../lib/platform/provider-posture")
    const now = new Date("2026-10-11T12:00:00Z")
    const old = new Date(now.getTime() - (A2P_FAILED_STALL_DAYS + 1) * 86_400_000).toISOString()
    const base = { customer_profile_sid: "BU1", last_error: "HTTP 503 from Twilio", updated_at: old } as any
    const transient = assessA2pStall({ ...base, last_error_class: "transient" }, old, now)
    const credential = assessA2pStall({ ...base, last_error_class: "credential" }, old, now)
    const legacy = assessA2pStall(base, old, now)
    check("a TRANSIENT last_error is not a failed registration: no 'failed … not re-run' stall (the next tick retries it); a CREDENTIAL class is, and names its class; a legacy row with no class still counts", !/failed/.test(transient.reason ?? "") && credential.stalled && /failed \(credential\)/.test(credential.reason ?? "") && legacy.stalled && /^failed \d+d ago/.test(legacy.reason ?? ""))
    check("CONTROL: the detector still fires on a FAILED brand status regardless of class", assessA2pStall({ ...base, last_error: undefined, brand_sid: "BN1", brand_status: "FAILED" }, old, now).stalled)
  }

  console.log("\n[7 · registration]")
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers test:phone-a2p-automation and the guard chain runs it (membership, not position)", typeof pkg.scripts["test:phone-a2p-automation"] === "string" && new RegExp("npm run test:phone-a2p-automation(\\s|&|$)").test(pkg.scripts.guard))
  const dom = (MAINTENANCE_DOMAINS as any).phone_a2p_automation
  check("MAINTENANCE_DOMAINS.phone_a2p_automation names a manager, this proof, and coOwners", !!dom && dom.proof === "test:phone-a2p-automation" && Array.isArray(dom.coOwners) && dom.coOwners.length >= 2)
  check("no migration: the phase + halt live in the twilio_a2p jsonb (no CHECK), so m761 is unused by design", !/m761/.test(src("lib/voice/carrier-registration-loop.ts")) && !/m761/.test(src("lib/voice/a2p-registration.ts")))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: Twilio is SIMULATED (an injected transport) — a real filing is an integrator smoke run; the halt's platform-side resume is the mock-verify door (no dedicated 'resume' button on the superadmin A2P board); a credential halt is surfaced to platform staff only through the sentinel's A2P stall detector (last_error) and the tenant's bell; CNAM / SHAKEN is outside the sync; a FAILED brand still costs one poll per tick (pre-existing).")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ PHONE_A2P_AUTOMATION_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
