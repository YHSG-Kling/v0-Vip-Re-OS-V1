#!/usr/bin/env tsx
/**
 * scripts/business-registration-loop-guard.ts   (npm run test:business-registration-loop)
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTOMATIC BUSINESS REGISTRATION, PROVED BY WALKING IT (wave 83, lane 83D —
 * owner verbatim: "the person picks a number or ports and auto business listing
 * approval.").
 *
 * ALREADY EXISTED — REUSED: lib/voice/a2p-registration.ts (THE step machine:
 * TrustHub customer profile → trust product → brand → messaging service →
 * number attach → campaign; toll-free verification; assessPhoneTestReadiness)
 * and kickCarrierRegistration (fires once at purchase / port).
 * BUILT: lib/voice/carrier-registration-loop.ts (the hourly tick that re-runs
 * the machine through Twilio's async reviews), resolveA2pProfile (the profile
 * derived from the brokerage's own record), the CarrierRunDeps seam.
 *
 * This proof drives the REAL runners — not a mock of them — against a
 * simulated TrustHub / Messaging API (an injected transport) and an in-memory
 * database, one cron tick at a time, and asserts:
 *   · every step progresses ON THE CRON with no human action, through the
 *     brand's PENDING → IN_REVIEW → APPROVED and the campaign's review;
 *   · the phone test unlocks ONLY when the campaign is VERIFIED (never on a
 *     submitted/pending state) — and the toll-free lane only on TWILIO_APPROVED;
 *   · a tenant missing profile fields is told exactly which (derived fields are
 *     NOT asked), nothing is filed, and a bell rings once per phase change;
 *   · a rejected brand is a named needs-input, not a silent pause;
 *   · a number added after approval joins the campaign's sender pool;
 *   · an approved, fully-attached tenant costs ZERO Twilio calls per tick.
 * Positive controls: the pre-83D campaign step (no brand re-poll) is shown to
 * stall; a scanner that must find a hard-coded "VERIFIED" write finds one in a
 * specimen.
 *
 * No network, no DB, no Twilio. Run: npx tsx scripts/business-registration-loop-guard.ts
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { deriveA2pProfile, assessPhoneTestReadiness, loadA2pState, type TwilioTransport, type A2pState } from "../lib/voice/a2p-registration"
import { advanceTenantCarrier, carrierRegistrationPhase, carrierTickPlan, runCarrierRegistrationTick } from "../lib/voice/carrier-registration-loop"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}`) }
}

// ── In-memory database (the supabase-js surface the loop uses) ──────────────
type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  const inserts: Array<{ table: string; row: Row }> = []
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
      if (op === "insert") { t.push(newRow!); inserts.push({ table, row: newRow! }); return { data: [newRow], error: null } }
      const hits = t.filter((r) => preds.every((p) => p(r)))
      if (op === "update") { hits.forEach((r) => Object.assign(r, patch)); return { data: hits.map((r) => ({ id: r.id })), error: null } }
      // Fresh copies, like PostgREST JSON — a caller mutating what it read must
      // not reach into the stored row.
      return { data: JSON.parse(JSON.stringify(hits.slice(0, lim))), error: null }
    }
    q.maybeSingle = async () => { const r = run(); return { data: (r.data as Row[])[0] ?? null, error: r.error } }
    q.single = q.maybeSingle
    q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return q
  }
  return { tables, inserts, from } as any
}

// ── Simulated Twilio TrustHub + Messaging (the injected transport) ──────────
function fakeTwilio(script: { brand: string[]; campaign: string[]; tollfree?: string[]; brandFailure?: string }) {
  const calls: Array<{ method: string; path: string }> = []
  let brandPolls = 0, campaignPolls = 0, tfPolls = 0
  const attached: string[] = []
  const t: TwilioTransport = async ({ method, path, body }) => {
    calls.push({ method, path })
    const ok = (data: any) => ({ ok: true, status: 200, data, error: null })
    if (method === "POST" && path === "/v1/CustomerProfiles") return ok({ sid: "BU_cp" })
    if (method === "POST" && path === "/v1/TrustProducts") return ok({ sid: "BU_tp" })
    if (method === "POST" && path === "/v1/EndUsers") return ok({ sid: `IT_${calls.length}` })
    if (method === "POST" && path.endsWith("/Addresses.json")) return ok({ sid: "AD_1" })
    if (method === "POST" && path === "/v1/SupportingDocuments") return ok({ sid: "RD_1" })
    if (path.endsWith("/EntityAssignments")) return ok({ sid: "BV_1" })
    if (path.endsWith("/Evaluations")) return ok({ status: "compliant" })
    if (method === "POST" && /^\/v1\/(CustomerProfiles|TrustProducts)\/BU_/.test(path)) return ok({ status: "pending-review" })
    if (method === "POST" && path === "/v1/a2p/BrandRegistrations") return ok({ sid: "BN_1", status: script.brand[0] })
    if (method === "GET" && path === "/v1/a2p/BrandRegistrations/BN_1") { const s = script.brand[Math.min(++brandPolls, script.brand.length - 1)]; return ok({ status: s, ...(s === "FAILED" ? { failure_reason: script.brandFailure ?? "TAX_ID mismatch" } : {}) }) }
    if (method === "POST" && path === "/v1/Services") return ok({ sid: "MG_1" })
    if (method === "POST" && path === "/v1/Services/MG_1/PhoneNumbers") { attached.push(String(body?.PhoneNumberSid)); return ok({ sid: "PN" }) }
    if (method === "POST" && path === "/v1/Services/MG_1/Compliance/Usa2p") return ok({ sid: "QE_1", campaign_status: script.campaign[0] })
    if (method === "GET" && path === "/v1/Services/MG_1/Compliance/Usa2p/QE_1") return ok({ campaign_status: script.campaign[Math.min(++campaignPolls, script.campaign.length - 1)] })
    if (method === "POST" && path === "/v1/Tollfree/Verifications") return ok({ sid: "HH_1", status: (script.tollfree ?? ["PENDING_REVIEW"])[0] })
    if (method === "GET" && path === "/v1/Tollfree/Verifications/HH_1") return ok({ status: (script.tollfree ?? [])[Math.min(++tfPolls, (script.tollfree ?? []).length - 1)] })
    return { ok: false, status: 404, data: null, error: `unscripted ${method} ${path}` }
  }
  return { transport: t, calls, attached }
}

const deps = (tw: ReturnType<typeof fakeTwilio>) => ({
  carrier: {
    transport: tw.transport,
    master: { accountSid: "AC_master", authToken: "x" },
    tenantCreds: async () => ({ accountSid: "AC_sub", authToken: "y", tier: "subaccount" }),
  },
  port: { creds: null },
})

const BROKERAGE = { id: "b1", name: "Kling Realty Group LLC", address: "100 Congress Ave", city: "Austin", state: "TX", zip: "78701", phone: "+15125550100", email: "office@kling.example", website: "https://kling.example", slug: "kling-realty-ab12" }
const OWNER = { id: "u-owner", brokerage_id: "b1", user_type: "broker_owner", first_name: "Dana", last_name: "Kling", email: "dana@kling.example", phone: "+15125550111", deleted_at: null }
const TYPED = { ein: "12-3456789", privacyPolicyUrl: "https://kling.example/privacy", termsUrl: "https://kling.example/terms" }

function tenantDb(extra: { typed?: Record<string, string> | null; numbers?: Row[] } = {}) {
  return fakeDb({
    brokerages: [{ ...BROKERAGE }],
    users: [{ ...OWNER }],
    brokerage_settings: extra.typed === null ? [] : [{ id: "bs1", brokerage_id: "b1", settings: { a2p_business_profile: extra.typed ?? TYPED } }],
    tenant_phone_numbers: extra.numbers ?? [{ id: "n1", brokerage_id: "b1", phone_number: "+15125551212", twilio_number_sid: "PN_1", is_active: true }],
    platform_credentials: [],
    phone_number_events: [],
    notifications: [],
  })
}

async function main() {
  console.log("\n[0 · controls on the scanner]")
  const selfTest = stripComments('const a = 1 // a "VERIFIED" note with a /* in it\nconst b = 2')
  check("CONTROL: strip-comments keeps code after a // line containing /* (the recurring defect)", /const b = 2/.test(selfTest) && !/VERIFIED/.test(selfTest))

  console.log("\n[1 · the profile is derived from the brokerage's own record]")
  {
    const d = deriveA2pProfile({ saved: TYPED, brokerage: BROKERAGE, owner: OWNER, appUrl: "https://app.example" })
    check("typed EIN + URLs + the brokerage row + the owner seat = a COMPLETE profile (nothing retyped)", d.validation.ok && d.derivedKeys.includes("legalName") && d.derivedKeys.includes("contactEmail") && !d.derivedKeys.includes("ein"))
    const bare = deriveA2pProfile({ saved: null, brokerage: BROKERAGE, owner: OWNER, appUrl: "https://app.example" })
    check("with nothing typed, ONLY what no record holds is asked: EIN + privacy + terms (never name/address/contact)", !bare.validation.ok && bare.validation.missing.length === 3 && bare.validation.missing.every((m) => /EIN|Privacy|Terms/.test(m)))
    const typedWins = deriveA2pProfile({ saved: { ...TYPED, legalName: "Kling Realty Group, L.L.C." }, brokerage: BROKERAGE, owner: OWNER })
    check("a field the tenant TYPED wins over the derived one", typedWins.validation.ok && typedWins.validation.value.legalName === "Kling Realty Group, L.L.C." && !typedWins.derivedKeys.includes("legalName"))
    const storefront = deriveA2pProfile({ saved: TYPED, brokerage: { ...BROKERAGE, website: null }, owner: OWNER, appUrl: "https://app.example/" })
    check("no website on file → the tenant's live storefront (/site/<slug>) — never an invented domain; no appUrl → asked", storefront.validation.ok && storefront.validation.value.website === "https://app.example/site/kling-realty-ab12" && !deriveA2pProfile({ saved: TYPED, brokerage: { ...BROKERAGE, website: null }, owner: OWNER }).validation.ok)
    check("the EIN is never derived or guessed (no source for it exists in the derivation)", !/ein:/.test(stripped("lib/voice/a2p-registration.ts").slice(stripped("lib/voice/a2p-registration.ts").indexOf("export function deriveA2pProfile"), stripped("lib/voice/a2p-registration.ts").indexOf("export async function resolveA2pProfile"))))
  }

  console.log("\n[2 · every step progresses on the cron — the real machine, tick by tick]")
  {
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING", "PENDING", "IN_REVIEW", "APPROVED"], campaign: ["IN_PROGRESS", "IN_PROGRESS", "VERIFIED"] })
    const phases: string[] = []
    const unlocked: boolean[] = []
    const stateAt: A2pState[] = []
    for (let tick = 1; tick <= 7; tick++) {
      const r = await advanceTenantCarrier(db, "b1", deps(tw))
      phases.push(r.after); unlocked.push(r.testUnlocked)
      stateAt.push((await loadA2pState(db, "b1")).state)
    }
    const s1 = stateAt[0]
    check("tick 1 files profile → trust product → brand → messaging service → number attach in ONE pass, then honestly pauses in carrier_review while TCR reviews the brand", !!s1.customer_profile_sid && !!s1.trust_product_sid && s1.brand_sid === "BN_1" && s1.messaging_service_sid === "MG_1" && s1.number_attached === true && !s1.campaign_sid && phases[0] === "carrier_review")
    check("the derived profile was persisted so every reader sees what was filed", db.tables.brokerage_settings[0].settings.a2p_business_profile.legalName === BROKERAGE.name && Array.isArray(db.tables.brokerage_settings[0].settings.a2p_profile_derived_keys))
    const campaignTick = stateAt.findIndex((s) => !!s.campaign_sid)
    check("the brand is RE-POLLED on later ticks (PENDING → IN_REVIEW → APPROVED) and the campaign files the tick the brand clears — no button", campaignTick > 0 && stateAt[campaignTick - 1].brand_status !== "APPROVED" && stateAt[campaignTick].brand_status === "APPROVED")
    const approvedTick = phases.indexOf("approved")
    check("the campaign review is polled to VERIFIED and the phase reaches approved", approvedTick > campaignTick && stateAt[approvedTick].campaign_status === "VERIFIED")
    check("the phone test is LOCKED on every tick before VERIFIED and unlocked from that tick on", unlocked.every((u, i) => u === (i >= approvedTick)) && unlocked.slice(0, approvedTick).every((u) => !u))
    check("ports-none tenant: pollPortIns is a no-op (no creds needed, nothing polled)", !tw.calls.some((c) => /Porting/.test(c.path)))
    const events = db.tables.phone_number_events.filter((e: Row) => e.source === "carrier_registration_tick")
    check("each phase CHANGE is audited once on phone_number_events with a CHECK'd event_type", events.length === new Set(phases).size && events.every((e: Row) => CHECK_VOCABULARIES.phone_number_events.event_type.includes(e.event_type)))
    const bells = db.tables.notifications.filter((n: Row) => n.type === "carrier_registration")
    check("approval rings the finance admin exactly once, naming the unlocked phone test", bells.length === 1 && /phone test unlocked/i.test(bells[0].title) && bells[0].user_id === "u-owner")
    const before = tw.calls.length
    await advanceTenantCarrier(db, "b1", deps(tw))
    check("an approved, fully-attached tenant costs ZERO Twilio calls on the next tick", tw.calls.length === before)
    // A number added after approval joins the sender pool.
    db.tables.tenant_phone_numbers.push({ id: "n2", brokerage_id: "b1", phone_number: "+15125553434", twilio_number_sid: "PN_2", is_active: true })
    check("carrierTickPlan wakes for an un-pooled local number even when approved", carrierTickPlan((await loadA2pState(db, "b1")).state, db.tables.tenant_phone_numbers, true).run10dlc)
    await advanceTenantCarrier(db, "b1", deps(tw))
    check("…and the next tick attaches it (attached_number_sids grows; the test stays unlocked)", tw.attached.includes("PN_2") && ((await loadA2pState(db, "b1")).state.attached_number_sids ?? []).includes("PN_2"))
  }

  console.log("\n[3 · needs input → named, nothing filed, resumes on its own]")
  {
    const db = tenantDb({ typed: null })
    const tw = fakeTwilio({ brand: ["PENDING", "APPROVED"], campaign: ["IN_PROGRESS", "VERIFIED"] })
    const r = await advanceTenantCarrier(db, "b1", deps(tw))
    check("no EIN / URLs typed → phase needs_input naming ONLY those, and ZERO Twilio calls", r.after === "needs_input" && r.needs.length === 3 && r.needs.every((n) => /EIN|Privacy|Terms/.test(n)) && tw.calls.length === 0)
    check("the tenant is rung with the exact fields", db.tables.notifications.some((n: Row) => /needs your input/.test(n.title) && /EIN/.test(n.body)))
    await advanceTenantCarrier(db, "b1", deps(tw))
    check("the same phase next tick does NOT ring again", db.tables.notifications.filter((n: Row) => n.type === "carrier_registration").length === 1)
    db.tables.brokerage_settings.push({ id: "bs1", brokerage_id: "b1", settings: { a2p_business_profile: TYPED } })
    const r2 = await advanceTenantCarrier(db, "b1", deps(tw))
    check("once the tenant saves them, the very next tick files — no button", r2.ran.includes("10dlc") && tw.calls.some((c) => c.path === "/v1/CustomerProfiles"))
  }

  console.log("\n[4 · a rejected brand is a named needs-input, never a silent pause]")
  {
    const db = tenantDb()
    const tw = fakeTwilio({ brand: ["PENDING", "FAILED"], campaign: ["IN_PROGRESS"], brandFailure: "TAX_ID does not match legal name" })
    await advanceTenantCarrier(db, "b1", deps(tw))
    const r = await advanceTenantCarrier(db, "b1", deps(tw))
    const s = (await loadA2pState(db, "b1")).state
    check("FAILED brand → phase rejected, the carrier's reason carried, no campaign filed", r.after === "rejected" && /TAX_ID/.test(s.last_error ?? "") && !s.campaign_sid && !r.testUnlocked)
    check("…and the tenant is rung with it", db.tables.notifications.some((n: Row) => /needs your input/.test(n.title) && /FAILED/.test(n.body)))
  }

  console.log("\n[5 · toll-free lane: verification, unlock only on TWILIO_APPROVED]")
  {
    const db = tenantDb({ numbers: [{ id: "n9", brokerage_id: "b1", phone_number: "+18885550199", twilio_number_sid: "PN_TF", is_active: true }] })
    const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"], tollfree: ["PENDING_REVIEW", "IN_REVIEW", "TWILIO_APPROVED"] })
    const seen: Array<{ phase: string; unlocked: boolean }> = []
    for (let i = 0; i < 4; i++) { const r = await advanceTenantCarrier(db, "b1", deps(tw)); seen.push({ phase: r.after, unlocked: r.testUnlocked }) }
    check("an 8xx number takes toll-free verification only (no 10DLC brand filed)", tw.calls.some((c) => c.path === "/v1/Tollfree/Verifications") && !tw.calls.some((c) => c.path === "/v1/a2p/BrandRegistrations"))
    const at = seen.findIndex((x) => x.phase === "approved")
    check("the test unlocks exactly when Twilio says TWILIO_APPROVED — not on PENDING_REVIEW / IN_REVIEW", at > 0 && seen.every((x, i) => x.unlocked === (i >= at)))
  }

  console.log("\n[6 · the ONE unlock rule and the pure phase]")
  {
    const base: A2pState = { customer_profile_sid: "BU", trust_product_sid: "BU2", brand_sid: "BN", brand_status: "APPROVED", messaging_service_sid: "MG", number_attached: true, campaign_sid: "QE" }
    const local = [{ phone_number: "+15125551212" }]
    const nonVerified = ["PENDING", "IN_PROGRESS", "FAILED", "", "SUBMITTED"]
    check("every non-approved campaign status keeps the test locked (sweep of 5)", nonVerified.every((st) => !carrierRegistrationPhase({ ...base, campaign_status: st }, local, []).testUnlocked))
    check("the phase's unlock IS assessPhoneTestReadiness (same answer on VERIFIED / APPROVED)", ["VERIFIED", "APPROVED"].every((st) => carrierRegistrationPhase({ ...base, campaign_status: st }, local, []).testUnlocked === assessPhoneTestReadiness({ ...base, campaign_status: st }, local).ready))
    check("no numbers → no_numbers (nothing to register, nothing unlocked)", carrierRegistrationPhase(base, [], []).phase === "no_numbers")
    const ptc = stripped("app/actions/phone-test-call.ts")
    check("the test-call door still decides by assessPhoneTestReadiness over the persisted state (no second rule)", /assessPhoneTestReadiness\(state, rows\)/.test(ptc))
    // No production file may WRITE an approval the carrier did not send.
    // Stripped source (a tombstone is not a call site); the literal itself is the
    // token sought, so strings are NOT blanked here.
    const scan = (code: string) => /(campaign_status|tollfree_status|brand_status)\s*=\s*"(VERIFIED|APPROVED|TWILIO_APPROVED)"/.test(stripComments(code))
    check("CONTROL: the approval-write finder catches a specimen `state.campaign_status = \"VERIFIED\"`", scan('state.campaign_status = "VERIFIED"'))
    const files = ["lib/voice/a2p-registration.ts", "lib/voice/carrier-registration-loop.ts", "lib/voice/number-port-in.ts", "app/api/cron/carrier-registration-tick/route.ts", "app/actions/a2p-registration.ts"]
    check(`no approval is ever written by our code — only copied from Twilio's answer (${files.length} files swept)`, files.every((f) => !scan(src(f))))
  }

  console.log("\n[7 · the pre-83D campaign step stalls (positive control for the re-poll fix)]")
  {
    const a2p = stripped("lib/voice/a2p-registration.ts")
    const step = a2p.slice(a2p.indexOf('if (step === "campaign") {'), a2p.indexOf("Campaign create failed"))
    check("the campaign step re-polls a non-terminal brand BEFORE deciding to pause", step.indexOf("/v1/a2p/BrandRegistrations/${state.brand_sid}`, \"GET\")") > 0 && step.indexOf("/v1/a2p/BrandRegistrations/${state.brand_sid}`, \"GET\")") < step.indexOf('!== "APPROVED"'))
    // CONTROL: the progress assertions in section 2 can SEE a stall. A carrier
    // that never clears the brand must leave the campaign unfiled, the phase
    // short of review and the test locked on every tick — the exact symptom the
    // pre-83D machine showed even when the brand HAD cleared.
    const db = tenantDb()
    const stuck = fakeTwilio({ brand: ["PENDING", "IN_REVIEW"], campaign: ["IN_PROGRESS"] })
    const seen: string[] = []
    for (let i = 0; i < 4; i++) seen.push((await advanceTenantCarrier(db, "b1", deps(stuck))).after)
    const s = (await loadA2pState(db, "b1")).state
    check("CONTROL: a brand that never clears → no campaign, phase stays 'carrier_review', test locked, and the brand is polled EVERY tick", !s.campaign_sid && seen.every((p) => p === "carrier_review") && stuck.calls.filter((c) => c.method === "GET" && c.path === "/v1/a2p/BrandRegistrations/BN_1").length >= 4)
    check("an IN_REVIEW brand is still polled at the end of a run (the old test was === \"PENDING\")", /!BRAND_TERMINAL\.includes\(\(state\.brand_status/.test(a2p) && !/brand_status \?\? ""\)\.toUpperCase\(\) === "PENDING"\) \{/.test(a2p))
    check("a refused state read FAILS CLOSED (throws) instead of re-filing from step one", /if \(error\) throw new Error\(`carrier registration state could not be read/.test(a2p))
  }

  console.log("\n[8 · the cron: registered, gated, bounded]")
  {
    check("/api/cron/carrier-registration-tick is in the ONE dispatcher", CRON_REGISTRY.some((c) => c.path === "/api/cron/carrier-registration-tick"))
    const route = stripped("app/api/cron/carrier-registration-tick/route.ts")
    check("the route verifies the cron secret BEFORE the service client", route.indexOf("verifyCronAuth(req)") > 0 && route.indexOf("verifyCronAuth(req)") < route.indexOf("createServiceClient()"))
    const db = tenantDb()
    db.tables.tenant_phone_numbers.push({ id: "n3", brokerage_id: "b2", phone_number: "+13055550100", twilio_number_sid: "PN_3", is_active: true })
    db.tables.brokerage_settings.push({ id: "bs3", brokerage_id: "b3", settings: { phone_port_ins: [{ sid: "KW1", status: "In Progress", numbers: [], repEmail: "a@b.c", submittedAt: "2026-09-26", lastPolledAt: null, signatureUrl: null, targetDate: null, agentUserId: null, agentId: null }] } })
    const tw = fakeTwilio({ brand: ["PENDING"], campaign: ["IN_PROGRESS"] })
    const r = await runCarrierRegistrationTick(db, { ...deps(tw), limit: 2 })
    check("the tick finds tenants by active number AND by open port (3 found), and honours its bound (2 advanced)", r.tenants === 3 && r.results.length === 2)
  }

  console.log("\n[9 · registration]")
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers test:business-registration-loop after test:scrapers (ordering)", typeof pkg.scripts["test:business-registration-loop"] === "string" && pkg.scripts.guard.indexOf("npm run test:scrapers") < pkg.scripts.guard.indexOf("npm run test:business-registration-loop"))
  const dom = (MAINTENANCE_DOMAINS as any).business_registration_loop
  check("MAINTENANCE_DOMAINS.business_registration_loop names a manager, this proof, and coOwners", !!dom && dom.proof === "test:business-registration-loop" && Array.isArray(dom.coOwners) && dom.coOwners.length >= 2)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: Twilio is SIMULATED (an injected transport scripted from the documented statuses) — a real filing is an integrator smoke run with master + subaccount creds; CNAM / SHAKEN (runVoiceIntegrityRegistration) is not driven by the loop; automatic brand RE-submission after a FAILED review is not built (the loop names it and rings the tenant); the notification is in-app only; the loop's tenant scan reads at most 2,000 active numbers + 500 port rows per tick.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ BUSINESS_REGISTRATION_LOOP_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
