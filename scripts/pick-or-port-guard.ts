#!/usr/bin/env tsx
/**
 * scripts/pick-or-port-guard.ts   (npm run test:pick-or-port)
 * ─────────────────────────────────────────────────────────────────────────────
 * PICK A LOCAL NUMBER OR PORT YOURS (wave 83, lane 83D — owner verbatim: "the
 * person picks a number or ports and auto business listing approval."; earlier:
 * "build non toll free provisioning and selection numbers which will most
 * likely be area codes that start with their location.").
 *
 * ALREADY EXISTED — REUSED: the PICK path (lib/voice/local-number-search.ts
 * ladder, lib/voice/number-provisioning.ts suggestLocalNumbers + provisionNumber,
 * the "Add a Number" picker), manuallyAddAgentPhone's guards (now the ONE core
 * attachOwnedNumber), the Twilio SDK adapter, the plan allowance, the free
 * geocoder (lib/external/nominatim-geocode.ts geocodeOne).
 * BUILT: the PORT path (lib/voice/number-port-in.ts + the adapter's Porting API
 * + app/actions/phone-port-in.ts + the Pick-or-Port card), completed ports
 * LANDED by the cron through attachOwnedNumber (→ business registration), and
 * office coordinates → distance for the nearby-number search.
 *
 * No network, no DB, no Twilio: pure functions, injected adapters, an
 * in-memory database, stripped source. Run: npx tsx scripts/pick-or-port-guard.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import {
  validatePortInInput, describePortIn, defaultPortDate, normalizePortStatus, portInNeedsPolling, submitPortIn, pollPortIns,
  PORT_MIN_LEAD_DAYS, type PortInRecord, type PortInDeps,
} from "../lib/voice/number-port-in"
import { planLocalNumberSearch, runLocalNumberSearch, distanceMiles } from "../lib/voice/local-number-search"
import { suggestLocalNumbers } from "../lib/voice/number-provisioning"
import { advanceTenantCarrier } from "../lib/voice/carrier-registration-loop"
import { loadA2pState, type TwilioTransport } from "../lib/voice/a2p-registration"

delete process.env.TWILIO_ACCOUNT_SID
delete process.env.TWILIO_AUTH_TOKEN

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}`) }
}

type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" = "select"
    let patch: Row | null = null
    let newRow: Row | null = null
    const q: any = {}
    for (const m of ["select", "order", "limit"]) q[m] = () => q
    q.eq = (k: string, v: any) => { preds.push((r) => r[k] === v); return q }
    q.in = (k: string, vs: any[]) => { preds.push((r) => vs.includes(r[k])); return q }
    q.is = (k: string, v: any) => { preds.push((r) => (v === null ? r[k] == null : r[k] === v)); return q }
    q.not = (k: string, _o: string, v: any) => {
      if (k.includes("->")) { const [c, key] = k.split("->"); preds.push((r) => r[c]?.[key] != null) } else preds.push((r) => (v === null ? r[k] != null : r[k] !== v))
      return q
    }
    q.insert = (row: Row) => { op = "insert"; newRow = { id: `${table}-${++seq}`, ...row }; return q }
    q.update = (p: Row) => { op = "update"; patch = p; return q }
    const run = () => {
      const t = (tables[table] ??= [])
      if (op === "insert") { t.push(newRow!); return { data: [JSON.parse(JSON.stringify(newRow))], error: null } }
      const hits = t.filter((r) => preds.every((p) => p(r)))
      if (op === "update") { hits.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(patch)))); return { data: hits.map((r) => ({ id: r.id })), error: null } }
      return { data: JSON.parse(JSON.stringify(hits)), error: null }
    }
    q.maybeSingle = async () => { const r = run(); return { data: (r.data as Row[])[0] ?? null, error: r.error } }
    q.single = q.maybeSingle
    q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return q
  }
  return { tables, from } as any
}

const TODAY = new Date("2026-09-26T15:00:00Z") // a Saturday
const GOOD = {
  phoneNumbers: ["(512) 555-1212"], customerName: "Kling Realty Group LLC", customerType: "Business" as const,
  accountNumber: "ACCT-99", accountTelephoneNumber: "5125551212",
  authorizedRepresentative: "Dana Kling", authorizedRepresentativeEmail: "dana@kling.example",
  street: "100 Congress Ave", city: "Austin", state: "TX", zip: "78701",
}
const BILL = { name: "bill.pdf", type: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 bill").buffer as ArrayBuffer }

function adapterStub(opts: { portable?: boolean; pinRequired?: boolean; createFails?: boolean; statuses?: Array<{ status: string; numbers: Array<{ phoneNumber: string; status: string; rejectionReason?: string | null }> }> } = {}) {
  const calls: string[] = []
  let polls = 0
  const adapter: NonNullable<PortInDeps["adapter"]> = {
    checkPortability: async (_c, n) => { calls.push(`portability:${n}`); return { ok: true, status: 200, error: null, data: { phoneNumber: n, portable: opts.portable !== false, pinAndAccountNumberRequired: !!opts.pinRequired, notPortableReason: opts.portable === false ? "Number is with an unsupported carrier" : null, numberType: "LOCAL" } } },
    uploadPortingUtilityBill: async () => { calls.push("upload"); return { ok: true, status: 201, error: null, data: { sid: "RD_bill", status: "PENDING_REVIEW" } } },
    createPortInRequest: async (_c, input) => {
      calls.push(`create:${input.documentSids.join(",")}:${input.accountSid}`)
      if (opts.createFails) return { ok: false, status: 400, data: null, error: "Invalid documents" }
      return { ok: true, status: 201, error: null, data: { sid: "KW_1", status: "In Review", signatureRequestUrl: null, targetPortInDate: input.targetPortInDate ?? null, numbers: input.phoneNumbers.map((n) => ({ phoneNumber: n.phoneNumber, status: "In Review", portable: true, rejectionReason: null, portDate: null })) } }
    },
    fetchPortInRequest: async (_c, sid) => {
      calls.push(`fetch:${sid}`)
      const st = (opts.statuses ?? [])[Math.min(polls++, (opts.statuses ?? []).length - 1)]
      if (!st) return { ok: false, status: 404, data: null, error: "no script" }
      return { ok: true, status: 200, error: null, data: { sid, status: st.status, signatureRequestUrl: "https://sign.example/KW_1", targetPortInDate: "2026-10-07", numbers: st.numbers.map((n) => ({ phoneNumber: n.phoneNumber, status: n.status, portable: true, rejectionReason: n.rejectionReason ?? null, portDate: null })) } }
    },
  }
  return { adapter, calls }
}

async function main() {
  console.log("\n[0 · scanner controls]")
  const bareFetch = /(?<![.\w])fetch\(/
  check("CONTROL: the bare-fetch finder catches a specimen `await fetch(\"https://x\")` and ignores an SDK `.fetch()`", bareFetch.test('await fetch("https://x")') && !bareFetch.test("client.numbers.v1.portingPortIns(sid).fetch()"))

  console.log("\n[1 · the port request — every LOA field named when missing (pure)]")
  {
    const ok = validatePortInInput(GOOD, { today: TODAY })
    check("a complete request validates; the number is normalised to E.164", ok.ok && ok.value.phoneNumbers[0] === "+15125551212")
    const d = ok.ok ? ok.value.targetPortInDate : ""
    const lead = (Date.parse(`${d}T00:00:00Z`) - Date.UTC(2026, 8, 26)) / 86400000
    check(`the default port date is ≥ ${PORT_MIN_LEAD_DAYS} days out and never a weekend`, lead >= PORT_MIN_LEAD_DAYS && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && defaultPortDate(TODAY) === d)
    const empty = validatePortInInput({}, { today: TODAY })
    check("an empty request names every LOA field (number, holder, type, signer, e-mail, street, city, state, ZIP)", !empty.ok && empty.missing.length === 9)
    const tf = validatePortInInput({ ...GOOD, phoneNumbers: ["+18885550100"] }, { today: TODAY })
    check("a toll-free number is refused WITH the reason (Twilio's port-in API covers local + mobile only)", !tf.ok && tf.missing.some((m) => /toll-free/.test(m) && /support/.test(m)))
    const soon = validatePortInInput({ ...GOOD, targetPortInDate: "2026-09-28" }, { today: TODAY })
    check("a target date under 7 days is refused naming the earliest allowed date", !soon.ok && soon.missing.some((m) => /on or after 2026-10-03/.test(m)))
    const notPortable = validatePortInInput(GOOD, { today: TODAY, portability: [{ phoneNumber: "+15125551212", portable: false, pinAndAccountNumberRequired: false, notPortableReason: "unsupported carrier" }] })
    check("a non-portable number is refused with Twilio's reason", !notPortable.ok && notPortable.missing.some((m) => /cannot be ported to Twilio: unsupported carrier/.test(m)))
    const mobile = validatePortInInput({ ...GOOD, accountNumber: "" }, { today: TODAY, portability: [{ phoneNumber: "+15125551212", portable: true, pinAndAccountNumberRequired: true, notPortableReason: null }] })
    check("a mobile number whose carrier demands PIN + account number cannot be filed without both", !mobile.ok && mobile.missing.some((m) => /account number/.test(m)) && mobile.missing.some((m) => /PIN/.test(m)))
    const withPin = validatePortInInput({ ...GOOD, pins: { "+15125551212": "4321" } }, { today: TODAY, portability: [{ phoneNumber: "+15125551212", portable: true, pinAndAccountNumberRequired: true, notPortableReason: null }] })
    check("…and files once both are present", withPin.ok && withPin.value.pins?.["+15125551212"] === "4321")
  }

  console.log("\n[2 · status + next step, per Twilio's status table (pure)]")
  {
    const base: PortInRecord = { sid: "KW_1", status: "In Review", numbers: [{ phone: "+15125551212", status: "In Review", rejection: null, portDate: null, landed: false }], signatureUrl: null, targetDate: "2026-10-07", repEmail: "dana@kling.example", submittedAt: "", lastPolledAt: null, agentUserId: null, agentId: null }
    check("normalizePortStatus: 'Waiting for Signature' → waiting_for_signature", normalizePortStatus("Waiting for Signature") === "waiting_for_signature" && normalizePortStatus("port-rejected") === "port_rejected")
    const sig = describePortIn({ ...base, status: "Waiting for Signature", signatureUrl: "https://sign.example" })
    check("waiting for signature → names the signer's e-mail, the link and the 30-day auto-cancel", sig.phase === "waiting_for_signature" && /dana@kling\.example/.test(sig.headline) && /30 days/.test(sig.nextStep) && /sign\.example/.test(sig.nextStep))
    const prog = describePortIn({ ...base, status: "In Progress" })
    check("in progress → the target date + 'keep your current service active'", prog.phase === "in_progress" && /2026-10-07/.test(prog.headline) && /Keep your current service active/.test(prog.nextStep))
    const rej = describePortIn({ ...base, status: "Action Required", numbers: [{ ...base.numbers[0], status: "Port Rejected", rejection: "Invalid PIN" }] })
    check("action required → names the rejected number and the carrier's reason", rej.phase === "action_required" && /\+15125551212/.test(rej.headline) && /Invalid PIN/.test(rej.nextStep))
    const landing = describePortIn({ ...base, status: "Completed", numbers: [{ ...base.numbers[0], status: "Completed" }] })
    check("completed but not yet on the AI line → 'landing' (the cron still has work)", landing.phase === "landing" && portInNeedsPolling({ ...base, status: "Completed", numbers: [{ ...base.numbers[0], status: "Completed" }] }))
    const done = { ...base, status: "Completed", numbers: [{ ...base.numbers[0], status: "Completed", landed: true }] }
    check("completed AND landed → completed, and the cron stops polling it", describePortIn(done).phase === "completed" && !portInNeedsPolling(done) && !portInNeedsPolling({ ...base, status: "Canceled" }))
  }

  console.log("\n[3 · submit: gate order, fail closed, the record persisted]")
  {
    const db = fakeDb({ brokerage_settings: [{ id: "bs1", brokerage_id: "b1", settings: { a2p_business_profile: { legalName: "Kling" } } }] })
    const denied = adapterStub()
    const capped = await submitPortIn(db, "b1", GOOD, BILL, { deps: { creds: { accountSid: "AC_sub", authToken: "t" }, adapter: denied.adapter, allowance: async () => ({ allowed: false, reason: "Your plan's hard cap of 3 numbers is reached" }), now: TODAY } })
    check("the plan allowance gates a port like a purchase — refused BEFORE any carrier call", !capped.ok && /hard cap/.test(capped.error) && denied.calls.length === 0)
    const noCreds = await submitPortIn(db, "b1", GOOD, BILL, { deps: { creds: null, adapter: denied.adapter, allowance: async () => ({ allowed: true }), now: TODAY } })
    check("no telephony → refused, nothing filed", !noCreds.ok && /nothing was filed/.test(noCreds.error) && denied.calls.length === 0)
    const np = adapterStub({ portable: false })
    const r1 = await submitPortIn(db, "b1", GOOD, BILL, { deps: { creds: { accountSid: "AC_sub", authToken: "t" }, adapter: np.adapter, allowance: async () => ({ allowed: true }), now: TODAY } })
    check("not portable → refused before the bill is uploaded", !r1.ok && (r1.missing ?? []).some((m) => /cannot be ported/.test(m)) && !np.calls.includes("upload"))
    const nb = adapterStub()
    const r2 = await submitPortIn(db, "b1", GOOD, null, { deps: { creds: { accountSid: "AC_sub", authToken: "t" }, adapter: nb.adapter, allowance: async () => ({ allowed: true }), now: TODAY } })
    check("no utility bill → named as missing, nothing uploaded or created", !r2.ok && (r2.missing ?? []).some((m) => /utility bill/.test(m)) && !nb.calls.some((c) => c === "upload" || c.startsWith("create")))
    const cf = adapterStub({ createFails: true })
    const r3 = await submitPortIn(db, "b1", GOOD, BILL, { deps: { creds: { accountSid: "AC_sub", authToken: "t" }, adapter: cf.adapter, allowance: async () => ({ allowed: true }), now: TODAY } })
    check("Twilio refuses the request → the refusal is shown and NO record is written", !r3.ok && /Invalid documents/.test(r3.error) && !db.tables.brokerage_settings[0].settings.phone_port_ins)
    const good = adapterStub()
    const r4 = await submitPortIn(db, "b1", GOOD, BILL, { agentUserId: "u-agent", agentId: "a-1", deps: { creds: { accountSid: "AC_sub", authToken: "t" }, adapter: good.adapter, allowance: async () => ({ allowed: true }), now: TODAY } })
    check("happy path: portability → bill upload → create (into the tenant's OWN account, with the bill's document SID)", r4.ok && good.calls.join("|") === "portability:+15125551212|upload|create:RD_bill:AC_sub")
    const stored = db.tables.brokerage_settings[0].settings
    check("the record lands in brokerage_settings.settings.phone_port_ins WITHOUT clobbering the business profile", Array.isArray(stored.phone_port_ins) && stored.phone_port_ins[0].sid === "KW_1" && stored.phone_port_ins[0].agentUserId === "u-agent" && stored.a2p_business_profile?.legalName === "Kling")
    check("the tenant is told the status + the one next step", r4.ok && r4.status.phase === "in_review" && /Nothing to do/.test(r4.status.nextStep))
  }

  console.log("\n[4 · the cron: poll by the request's own sid, LAND completed numbers, then register]")
  {
    const db = fakeDb({
      brokerages: [{ id: "b1", name: "Kling Realty Group LLC", address: "100 Congress Ave", city: "Austin", state: "TX", zip: "78701", phone: "+15125550100", email: "o@k.example", website: "https://kling.example", slug: "kling" }],
      users: [{ id: "u-owner", brokerage_id: "b1", user_type: "broker_owner", first_name: "Dana", last_name: "Kling", email: "dana@kling.example", phone: "+15125550111", deleted_at: null }],
      brokerage_settings: [{ id: "bs1", brokerage_id: "b1", settings: {
        a2p_business_profile: { ein: "123456789", privacyPolicyUrl: "https://kling.example/privacy", termsUrl: "https://kling.example/terms" },
        phone_port_ins: [{ sid: "KW_1", status: "In Review", numbers: [{ phone: "+15125551212", status: "In Review", rejection: null, portDate: null, landed: false }, { phone: "+15125559999", status: "In Review", rejection: null, portDate: null, landed: false }], signatureUrl: null, targetDate: "2026-10-07", repEmail: "dana@kling.example", submittedAt: "2026-09-26", lastPolledAt: null, agentUserId: null, agentId: null }],
      } }],
      tenant_phone_numbers: [], platform_credentials: [], phone_number_events: [], notifications: [],
    })
    const stub = adapterStub({ statuses: [
      { status: "Waiting for Signature", numbers: [{ phoneNumber: "+15125551212", status: "Waiting for Signature" }, { phoneNumber: "+15125559999", status: "Waiting for Signature" }] },
      { status: "Action Required", numbers: [{ phoneNumber: "+15125551212", status: "Completed" }, { phoneNumber: "+15125559999", status: "Port Rejected", rejectionReason: "Invalid Account Number" }] },
    ] })
    const attachCalls: any[] = []
    const attach: NonNullable<PortInDeps["attach"]> = async (svc: any, p: any) => {
      attachCalls.push(p)
      svc.tables.tenant_phone_numbers.push({ id: `n${attachCalls.length}`, brokerage_id: p.brokerageId, phone_number: p.phoneNumber, twilio_number_sid: "PN_ported", is_active: true, number_source: "ported" })
      return { ok: true as const, phoneNumber: p.phoneNumber, twilioSid: "PN_ported", numberRowId: "n1", bound: true }
    }
    const portDeps: PortInDeps = { creds: { accountSid: "AC_sub", authToken: "t" }, adapter: stub.adapter, attach, now: TODAY }
    const p1 = await pollPortIns(db, "b1", portDeps)
    const rec1 = db.tables.brokerage_settings[0].settings.phone_port_ins[0]
    check("tick 1: polled by its OWN sid, status recorded (Waiting for Signature + the signing link), nothing landed", p1.polled === 1 && stub.calls.includes("fetch:KW_1") && rec1.status === "Waiting for Signature" && rec1.signatureUrl === "https://sign.example/KW_1" && attachCalls.length === 0)
    // Tick 2 through the WHOLE loop: the port lands, then registration files in the same pass.
    const calls: string[] = []
    const transport: TwilioTransport = async ({ method, path }) => {
      calls.push(`${method} ${path}`)
      const ok = (data: any) => ({ ok: true, status: 200, data, error: null })
      if (path.endsWith("/Evaluations")) return ok({ status: "compliant" })
      if (method === "POST" && path === "/v1/a2p/BrandRegistrations") return ok({ sid: "BN_1", status: "PENDING" })
      if (method === "GET" && path.startsWith("/v1/a2p/BrandRegistrations/")) return ok({ status: "PENDING" })
      if (method === "POST" && path === "/v1/Services") return ok({ sid: "MG_1" })
      return ok({ sid: `X${calls.length}` })
    }
    const r = await advanceTenantCarrier(db, "b1", { port: portDeps, carrier: { transport, master: { accountSid: "AC_master", authToken: "m" }, tenantCreds: async () => ({ accountSid: "AC_sub", authToken: "t", tier: "subaccount" }) } })
    check("tick 2: the completed number is LANDED through attachOwnedNumber (brokerage scope, source ported_in, the cron as source)", attachCalls.length === 1 && attachCalls[0].phoneNumber === "+15125551212" && attachCalls[0].scopeType === "brokerage" && attachCalls[0].source === "ported_in" && attachCalls[0].eventSource === "port_in_cron" && r.ported.includes("+15125551212"))
    const st = (await loadA2pState(db, "b1")).state
    check("…and business registration files IN THE SAME TICK from the brokerage profile — no human (brand filed, number pooled)", r.ran.includes("10dlc") && st.brand_sid === "BN_1" && (st.attached_number_sids ?? []).length === 1 && calls.includes("POST /v1/CustomerProfiles"))
    const rejectedEvents = db.tables.phone_number_events.filter((e: Row) => e.source === "port_in_cron" && e.event_type === "failed")
    check("the carrier's rejection of the second number is audited ONCE with its reason (CHECK'd event_type)", rejectedEvents.length === 1 && /Invalid Account Number/.test(rejectedEvents[0].notes) && CHECK_VOCABULARIES.phone_number_events.event_type.includes("failed"))
    await pollPortIns(db, "b1", portDeps)
    check("idempotent: the next poll neither re-lands the number nor re-audits the rejection", attachCalls.length === 1 && db.tables.phone_number_events.filter((e: Row) => e.source === "port_in_cron").length === 1)
    check("the phone test is still LOCKED (the campaign is not approved yet) — landing a number unlocks nothing by itself", r.testUnlocked === false)
  }

  console.log("\n[5 · the landing core is the human door's core — one sequence]")
  {
    const np = stripped("lib/voice/number-provisioning.ts")
    const core = np.slice(np.indexOf("export async function attachOwnedNumber("), np.indexOf("export type ReleaseNumberResult"))
    const order = ['.eq("phone_digits", digits)', "findIncomingPhoneNumber(creds, cleaned)", '.from("tenant_phone_numbers")\n    .insert(', "bindNumberToTwilioLane(svc, numberRowId)", "await logPhoneNumberEvent(svc, {", "kickCarrierRegistration(svc, {"]
    const idx = order.map((t) => core.indexOf(t))
    check("attachOwnedNumber: collision → SDK ownership proof → row → bind → audit → registration kickoff, in that order", idx.every((i) => i > 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]))
    check("a refused collision read FAILS CLOSED; the SID comes from Twilio's answer", /if \(collisionErr\) return \{ ok: false/.test(core) && /twilio_number_sid: verifiedSid/.test(core))
    const pp = stripped("app/actions/phone-provisioning.ts")
    check("manuallyAddAgentPhone runs the same core (no second copy of the guards)", /await attachOwnedNumber\(svc, \{/.test(pp) && !/IncomingPhoneNumbers\.json/.test(pp) && !/verifyNumberOwnedByTenant\(/.test(pp))
    const pin = stripped("lib/voice/number-port-in.ts")
    check("the port cron lands through attachOwnedNumber by default and never inserts a number row itself", /\(await import\("@\/lib\/voice\/number-provisioning"\)\)\.attachOwnedNumber/.test(pin) && !/from\("tenant_phone_numbers"\)/.test(pin))
    check("number_source 'ported' is a live CHECK value", CHECK_VOCABULARIES.tenant_phone_numbers.number_source.includes("ported"))
  }

  console.log("\n[6 · the SDK adapter — Porting API through twilio-node, one documented exception]")
  {
    const client = stripped("lib/providers/twilio/client.ts")
    check("port-in create / fetch and portability go through the SDK (numbers.v1)", /\.numbers\.v1\.portingPortIns\.create\(/.test(client) && /\.numbers\.v1\.portingPortIns\(portInRequestSid\)\.fetch\(\)/.test(client) && /\.numbers\.v1\.portingPortabilities\(e164\)\.fetch\(/.test(client))
    check("the ownership proof is on the SDK (incomingPhoneNumbers.list)", /incomingPhoneNumbers\.list\(\{ phoneNumber: e164, limit: 1 \}\)/.test(client))
    check("NO bare fetch( in the adapter; the ONE non-SDK call (utility-bill upload — twilio-node 6.1.1 ships no Documents resource) runs through an injected fetchImpl", !bareFetch.test(client) && /await fetchImpl\("https:\/\/numbers-upload\.twilio\.com\/v1\/Documents"/.test(client))
    check("the SDK version on disk really has no numbers Documents resource (the exception's premise)", existsSync(join(root, "node_modules/twilio/lib/rest/numbers/v1/portingPortIn.js")) && !existsSync(join(root, "node_modules/twilio/lib/rest/numbers/v1/document.js")) && !existsSync(join(root, "node_modules/twilio/lib/rest/numbers/v1/documents.js")))
  }

  console.log("\n[7 · the doors: session tenant, admin gate first, fail closed]")
  {
    const raw = src("app/actions/phone-port-in.ts")
    const a = stripComments(raw)
    check("'use server' and every export is async", /^"use server"/.test(raw) && !/^export (?!async function|interface|type)/m.test(a))
    const exportsList = [...a.matchAll(/export async function (\w+)/g)].map((m) => m[1])
    check(`every door (${exportsList.length}) gates through requirePortCtx BEFORE the service client`, exportsList.length === 3 && exportsList.every((name) => { const body = a.slice(a.indexOf(`export async function ${name}`)); const end = body.indexOf("\nexport ", 10); const b = end > 0 ? body.slice(0, end) : body; return b.indexOf("requirePortCtx(") > 0 && b.indexOf("requirePortCtx(") < b.indexOf("createServiceClient()") }))
    check("the gate is the brokerage finance-admin roster (the tier that may buy numbers)", /isBrokerageFinanceAdmin\(\{ user_type: ctx\.userType \}\)/.test(a))
    check("the tenant is NEVER read from the form (no brokerageId field)", !/form\.get\("brokerage/i.test(a) && !/brokerageId:\s*str\(/.test(a))
    check("a named agent is tenant-checked before it is trusted", /\.from\("agents"\)\.select\("user_id, brokerage_id"\)\.eq\("id", agentId\)/.test(a) && /brokerage_id !== auth\.brokerageId/.test(a))
  }

  console.log("\n[8 · coordinates: the office is geocoded with the free survivor; distance, never invented]")
  {
    const austin = { latitude: 30.2672, longitude: -97.7431 }, dallas = { latitude: 32.7767, longitude: -96.797 }
    const d = distanceMiles(austin, dallas)
    check("distanceMiles(Austin, Dallas) ≈ 182 mi (haversine), and null when a point is missing", d !== null && Math.abs(d - 182) < 3 && distanceMiles(austin, { latitude: null, longitude: null }) === null && distanceMiles(null, dallas) === null)
    const plan = planLocalNumberSearch({ phone: "+15125550100", city: "Austin", state: "TX", zip: "78701", ...austin })
    check("a geocoded office adds the NearLatLong rung and carries the origin", plan.ok && plan.steps.some((s) => s.rung === "near_lat_long" && s.params.nearLatLong === "30.2672,-97.7431") && !!plan.origin)
    if (plan.ok) {
      const res = await runLocalNumberSearch(plan, async (step) => step.rung === "area_code"
        ? { ok: true, rows: [{ phoneNumber: "+15125550901", locality: "Round Rock", region: "TX", latitude: 30.5083, longitude: -97.6789 }, { phoneNumber: "+15125550902", locality: "Austin", region: "TX", latitude: 30.27, longitude: -97.74 }] }
        : { ok: true, rows: [] }, { limit: 5 })
      check("within a rung, nearest first — and every candidate carries its distance", res.ok && res.candidates[0].phoneNumber === "+15125550902" && res.candidates.every((c) => typeof c.distanceMiles === "number") && res.candidates[0].distanceMiles! < res.candidates[1].distanceMiles!)
    }
    const noGeo = planLocalNumberSearch({ phone: "+15125550100", city: "Austin", state: "TX" })
    check("CONTROL: no coordinates → no NearLatLong rung, no origin (the ladder still works)", noGeo.ok && !noGeo.steps.some((s) => s.rung === "near_lat_long") && noGeo.origin === null)
    const seen: any[] = []
    const svc = fakeDb({ brokerages: [{ id: "b1", phone: "+15125550100", address: "100 Congress Ave", city: "Austin", state: "TX", zip: "78701" }], platform_credentials: [] })
    const r = await suggestLocalNumbers(svc, "b1", { geocode: async (p) => { seen.push(p); return { lat: 30.2672, lng: -97.7431 } } })
    check("suggestLocalNumbers geocodes the brokerage's OWN street address (then refuses honestly without telephony)", seen.length === 1 && seen[0].address === "100 Congress Ave" && seen[0].zip === "78701" && !r.ok && (r as any).notConfigured === true)
    const np = stripped("lib/voice/number-provisioning.ts")
    check("the geocoder is THE survivor (nominatim-geocode geocodeOne) — no second geocoder, no hand-built Census/Nominatim URL here", /import\("@\/lib\/external\/nominatim-geocode"\)\)\.geocodeOne/.test(np) && !/geocoding\.geo\.census\.gov|nominatim\.openstreetmap\.org/.test(np))
    check("only a FOUND point is memoised (a miss or an outage is retried)", /if \(!geocode && p\) officePointMemo\.set\(key, p\)/.test(np))
    const cols = (t: string) => ((SCHEMA_SNAPSHOT as any)[t] ?? []) as string[]
    check("no lat/long column exists on brokerages or locations — so nothing is cached on the row and no migration was written (m666 unused)", !cols("brokerages").some((c) => /(^|_)(lat|latitude|lng|lon|longitude)$/.test(c)) && !cols("locations").some((c) => /(^|_)(lat|latitude|lng|lon|longitude)$/.test(c)) && ["geo_lat", "latitude"].every((c) => /(^|_)(lat|latitude|lng|lon|longitude)$/.test(c)) && cols("brokerages").includes("address"))
  }

  console.log("\n[9 · the surface: one card, pick or port]")
  {
    const card = stripped("app/dashboard/admin/phone-settings/pick-or-port-card.tsx")
    const page = stripped("app/dashboard/admin/phone-settings/page.tsx")
    const client = stripped("app/dashboard/admin/phone-settings/phone-settings-client.tsx")
    check("the card offers both paths and calls the three port doors", /Pick a local number/.test(card) && /Port my number/.test(card) && /submitPortInAction\(fd\)/.test(card) && /getPortInStatusAction\(\)/.test(card) && /checkPortabilityAction\(\{ phoneNumbers \}\)/.test(card))
    check("PICK sends the person to the existing picker (no second picker) — the anchor exists", /getElementById\("pick-a-number"\)/.test(card) && /<Card id="pick-a-number">/.test(client) && !/suggestLocalNumbersAction/.test(card))
    check("the picker shows each number's distance from the office", /c\.distanceMiles\} mi from your office/.test(client))
    check("the phone settings page mounts the card", /<PickOrPortCard agents=\{portInAgents\} \/>/.test(page))
  }

  console.log("\n[10 · registration]")
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers test:pick-or-port after test:scrapers (ordering)", typeof pkg.scripts["test:pick-or-port"] === "string" && pkg.scripts.guard.indexOf("npm run test:scrapers") < pkg.scripts.guard.indexOf("npm run test:pick-or-port"))
  const dom = (MAINTENANCE_DOMAINS as any).pick_or_port
  check("MAINTENANCE_DOMAINS.pick_or_port names a manager, this proof, and coOwners", !!dom && dom.proof === "test:pick-or-port" && Array.isArray(dom.coOwners) && dom.coOwners.length >= 2)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: Twilio's Porting API is exercised through injected adapters scripted from its documented statuses — a real port (and the LOA e-mail) is an integrator smoke run with a real number; the utility-bill upload's multipart shape is asserted by source, not sent; toll-free numbers cannot be ported through this API (named to the tenant); geocoding is Nominatim's free tier (1 req/s) — a miss simply drops the NearLatLong rung; the pick-or-port card is proved by stripped source, not rendered; port records live in brokerage_settings.settings (jsonb), so no FK ties them to tenant_phone_numbers.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ PICK_OR_PORT_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
