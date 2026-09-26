// lib/voice/number-port-in.ts
// ─────────────────────────────────────────────────────────────────────────────
// PORT AN EXISTING NUMBER IN (wave 83, lane 83D — owner verbatim: "the person
// picks a number or ports and auto business listing approval.").
//
// ALREADY EXISTED — REUSED, never rebuilt:
//   · lib/voice/number-provisioning.ts — THE provisioning core. A completed
//     port lands through attachOwnedNumber (collision guard → ownership proof
//     on the SDK → tenant_phone_numbers row → webhook bind → phone_number_events
//     'ported_in' → kickCarrierRegistration), the same sequence the human
//     manuallyAddAgentPhone door runs. Nothing here writes a number row itself.
//   · lib/providers/twilio/client.ts — THE Twilio SDK adapter; 83D taught it the
//     Porting API (checkPortability, createPortInRequest, fetchPortInRequest)
//     and the one non-SDK call, the utility-bill upload (no SDK resource).
//   · lib/voice/twilio-tenancy.ts — the ONE credential resolver; the port lands
//     in the tenant's own subaccount (ensureTenantSubaccount first).
//   · lib/billing/phone-plan-resolve.ts — the plan allowance gates a port the
//     same way it gates a purchase (a ported number is an active number).
//
// Before this file a "port-in" was only a label on the BYO card: the number had
// to have ALREADY been ported into the brokerage's Twilio account by someone,
// somewhere. Now the tenant files the request here: Twilio builds the Letter of
// Authorization from these fields and e-mails it to the authorized
// representative; the cron (lib/voice/carrier-registration-loop.ts) polls the
// request by its OWN sid and lands each number the moment it completes.
//
// Contract (twilio.com/docs/phone-numbers/port-in, 2026-09-26): US landline and
// mobile only (NOT toll-free); ≤1,000 numbers per request; a utility bill
// (≤30 days old) uploaded first via the Documents API; target date ≥ 7 days out;
// mobile numbers need the losing carrier's PIN + account number; the LOA must
// be signed within 30 days or the request cancels itself.
//
// Storage: brokerage_settings.settings.phone_port_ins (jsonb array, newest
// first, capped) — an existing column, so no migration; the A2P state jsonb is
// deliberately NOT reused (its runner re-saves a snapshot it loaded earlier and
// would clobber a port filed mid-run).

import { isTollFreeNumber } from "@/lib/voice/a2p-registration"

// ── Vocabulary (Twilio's own statuses, normalised) ──────────────────────────

/** Port-in REQUEST statuses: In Review · Waiting for Signature · In Progress ·
 *  Action Required · Completed · Canceling · Canceled. */
const PORT_REQUEST_TERMINAL = ["completed", "canceled"] as const
/** Per-NUMBER statuses: In Review · Waiting for Signature · Port Submitted ·
 *  Port Pending · Port Rejected · Completed · Canceling · Canceled. */
const NUMBER_DONE = ["completed"] as const
const NUMBER_REJECTED = ["port_rejected", "rejected"] as const

/** PURE: "Waiting for Signature" / "waiting-for-signature" → waiting_for_signature. */
export function normalizePortStatus(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
}

/** US ports must be requested at least 7 days out (Twilio). */
export const PORT_MIN_LEAD_DAYS = 7
const PORT_MAX_NUMBERS_PER_REQUEST = 20 // a brokerage's lines — Twilio's own cap is 1,000
const MAX_RECORDS = 20

// ── The request the tenant fills in ─────────────────────────────────────────

export interface PortInInput {
  phoneNumbers: string[]
  /** Losing-carrier PIN per number (E.164 key) — mandatory for US mobile numbers. */
  pins?: Record<string, string>
  customerName: string
  customerType: "Business" | "Individual"
  accountNumber?: string
  accountTelephoneNumber?: string
  authorizedRepresentative: string
  authorizedRepresentativeEmail: string
  street: string
  street2?: string
  city: string
  state: string
  zip: string
  /** YYYY-MM-DD; default = the first weekday ≥ PORT_MIN_LEAD_DAYS + 3 out. */
  targetPortInDate?: string
}

/** The LOA fields the Business registration branding setting can pre-fill. */
export type PortInRegistrationPrefill = Pick<PortInInput, "customerName" | "authorizedRepresentative" | "authorizedRepresentativeEmail" | "street" | "street2" | "city" | "state" | "zip">

/**
 * PURE (wave 84D — owner: "add the registration info needed for registration
 * in as a branding setting so that info is pulled for registration."): the LOA
 * details the port form can take from the brokerage's Business registration
 * (the derived profile draft — lib/voice/a2p-registration.ts deriveA2pProfile,
 * read through lib/branding/business-registration.ts, the ONE reader). The EIN
 * is never part of it.
 */
export function portInPrefillFromRegistration(draft: Record<string, string> | null | undefined): Partial<PortInRegistrationPrefill> {
  const d = draft ?? {}
  const t = (k: string) => (typeof d[k] === "string" ? d[k].trim() : "")
  const rep = [t("contactFirstName"), t("contactLastName")].filter(Boolean).join(" ")
  const out: Partial<PortInRegistrationPrefill> = {}
  if (t("legalName")) out.customerName = t("legalName")
  if (rep) out.authorizedRepresentative = rep
  if (t("contactEmail")) out.authorizedRepresentativeEmail = t("contactEmail")
  if (t("street")) out.street = t("street")
  if (t("street2")) out.street2 = t("street2")
  if (t("city")) out.city = t("city")
  if (t("region")) out.state = t("region")
  if (t("postalCode")) out.zip = t("postalCode")
  return out
}

/** PURE: what the person TYPED wins field by field (the LOA must match the
 *  LOSING carrier's record, which can differ from the IRS one); every blank is
 *  pulled from the registration prefill. Only what neither holds stays missing. */
export function fillPortInFromRegistration(typed: Partial<PortInInput>, prefill: Partial<PortInRegistrationPrefill>): Partial<PortInInput> {
  const out: Partial<PortInInput> = { ...typed }
  for (const [k, v] of Object.entries(prefill) as Array<[keyof PortInRegistrationPrefill, string]>) {
    const cur = out[k]
    if ((typeof cur !== "string" || !cur.trim()) && v) (out as Record<string, unknown>)[k] = v
  }
  return out
}

export interface PortabilityVerdict {
  phoneNumber: string
  portable: boolean
  pinAndAccountNumberRequired: boolean
  notPortableReason: string | null
}

function e164(raw: string): string | null {
  const d = String(raw ?? "").replace(/\D/g, "")
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d
  return ten.length === 10 && /^[2-9]\d\d[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null
}

function isoDay(d: Date): string { return d.toISOString().slice(0, 10) }

/** PURE: the default target date — MIN_LEAD + 3 days of slack, rolled off a weekend. */
export function defaultPortDate(today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + PORT_MIN_LEAD_DAYS + 3))
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return isoDay(d)
}

export type PortInValidation =
  | { ok: true; value: Omit<PortInInput, "phoneNumbers" | "targetPortInDate"> & { phoneNumbers: string[]; targetPortInDate: string } }
  | { ok: false; missing: string[] }

/**
 * PURE, FAIL-CLOSED: everything the LOA needs, named when absent. Portability
 * verdicts (from checkPortability) are folded in: a non-portable number is
 * refused with Twilio's reason; a number whose carrier demands PIN + account
 * number cannot be filed without both.
 */
export function validatePortInInput(raw: Partial<PortInInput> | null | undefined, ctx: { today: Date; portability?: PortabilityVerdict[] } ): PortInValidation {
  const r = raw ?? {}
  const t = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const missing: string[] = []
  const numbers: string[] = []
  for (const n of Array.isArray(r.phoneNumbers) ? r.phoneNumbers : []) {
    if (!t(n)) continue
    const e = e164(n)
    if (!e) { missing.push(`"${t(n)}" is not a valid US phone number`); continue }
    if (isTollFreeNumber(e)) { missing.push(`${e} is toll-free — Twilio's port-in API covers local and mobile numbers only; toll-free ports go through Twilio support`); continue }
    if (!numbers.includes(e)) numbers.push(e)
  }
  if (numbers.length === 0 && !missing.some((m) => /valid US|toll-free/.test(m))) missing.push("At least one phone number to port")
  if (numbers.length > PORT_MAX_NUMBERS_PER_REQUEST) missing.push(`At most ${PORT_MAX_NUMBERS_PER_REQUEST} numbers per request`)
  if (!t(r.customerName)) missing.push("Account holder name exactly as your current carrier has it")
  const customerType = r.customerType === "Individual" ? "Individual" : r.customerType === "Business" ? "Business" : null
  if (!customerType) missing.push("Account type (Business or Individual)")
  if (!t(r.authorizedRepresentative)) missing.push("Authorized representative (the person who signs the LOA)")
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t(r.authorizedRepresentativeEmail))) missing.push("Authorized representative e-mail (the LOA is sent there for signature)")
  if (!t(r.street)) missing.push("Service address street (as on the carrier bill)")
  if (!t(r.city)) missing.push("Service address city")
  if (!t(r.state)) missing.push("Service address state")
  if (!/^\d{5}$/.test(t(r.zip).slice(0, 5)) ) missing.push("Service address ZIP (5 digits)")

  for (const v of ctx.portability ?? []) {
    if (!numbers.includes(v.phoneNumber)) continue
    if (!v.portable) missing.push(`${v.phoneNumber} cannot be ported to Twilio${v.notPortableReason ? `: ${v.notPortableReason}` : ""}`)
    if (v.pinAndAccountNumberRequired) {
      if (!t(r.accountNumber)) missing.push(`${v.phoneNumber}: the current carrier requires the account number`)
      if (!t(r.pins?.[v.phoneNumber])) missing.push(`${v.phoneNumber}: the current carrier requires the port-out PIN`)
    }
  }

  const earliest = new Date(Date.UTC(ctx.today.getUTCFullYear(), ctx.today.getUTCMonth(), ctx.today.getUTCDate() + PORT_MIN_LEAD_DAYS))
  let target = t(r.targetPortInDate)
  if (target) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target) || Number.isNaN(Date.parse(`${target}T00:00:00Z`))) missing.push("Target port date must be YYYY-MM-DD")
    else if (Date.parse(`${target}T00:00:00Z`) < earliest.getTime()) missing.push(`Target port date must be on or after ${isoDay(earliest)} (US ports need ${PORT_MIN_LEAD_DAYS} days)`)
  } else target = defaultPortDate(ctx.today)

  if (missing.length) return { ok: false, missing }
  const pins: Record<string, string> = {}
  for (const n of numbers) if (t(r.pins?.[n])) pins[n] = t(r.pins?.[n])
  return {
    ok: true,
    value: {
      phoneNumbers: numbers, pins,
      customerName: t(r.customerName).slice(0, 120), customerType: customerType!,
      accountNumber: t(r.accountNumber) || undefined, accountTelephoneNumber: e164(t(r.accountTelephoneNumber)) ?? undefined,
      authorizedRepresentative: t(r.authorizedRepresentative).slice(0, 120), authorizedRepresentativeEmail: t(r.authorizedRepresentativeEmail).slice(0, 160),
      street: t(r.street).slice(0, 120), street2: t(r.street2) || undefined, city: t(r.city).slice(0, 60), state: t(r.state).slice(0, 30), zip: t(r.zip).slice(0, 5),
      targetPortInDate: target,
    },
  }
}

// ── The persisted record + what the tenant is told ──────────────────────────

export interface PortInNumberRecord {
  phone: string
  status: string
  rejection: string | null
  portDate: string | null
  /** true once attachOwnedNumber put the number on the tenant's AI lane. */
  landed: boolean
  landError?: string | null
  rejectionLogged?: boolean
}

export interface PortInRecord {
  sid: string
  status: string
  numbers: PortInNumberRecord[]
  signatureUrl: string | null
  targetDate: string | null
  repEmail: string
  submittedAt: string
  lastPolledAt: string | null
  /** users.id of the agent the number lands on (null → brokerage inventory). */
  agentUserId: string | null
  agentId: string | null
  error?: string | null
}

export type PortPhase = "in_review" | "waiting_for_signature" | "in_progress" | "action_required" | "landing" | "completed" | "canceled"

/** PURE: is there anything left for the cron to do on this record? */
export function portInNeedsPolling(r: PortInRecord): boolean {
  const st = normalizePortStatus(r.status)
  if (!(PORT_REQUEST_TERMINAL as readonly string[]).includes(st)) return true
  // A completed request whose numbers have not all landed keeps the cron busy.
  return st === "completed" && r.numbers.some((n) => (NUMBER_DONE as readonly string[]).includes(normalizePortStatus(n.status)) && !n.landed)
}

/** PURE: the status line + the ONE next step, per Twilio's own status table. */
export function describePortIn(r: PortInRecord): { phase: PortPhase; headline: string; nextStep: string } {
  const st = normalizePortStatus(r.status)
  const rejected = r.numbers.filter((n) => (NUMBER_REJECTED as readonly string[]).includes(normalizePortStatus(n.status)))
  const nums = r.numbers.map((n) => n.phone).join(", ")
  if (st === "canceled" || st === "canceling") return { phase: "canceled", headline: `Port ${st === "canceling" ? "being canceled" : "canceled"} (${nums}).`, nextStep: "Nothing moved. Submit a new request once the details are corrected." }
  if (st === "action_required" || rejected.length) {
    return { phase: "action_required", headline: `Your current carrier rejected ${rejected.map((n) => n.phone).join(", ") || nums}.`, nextStep: `Fix and resubmit: ${rejected.map((n) => n.rejection).filter(Boolean).join(" · ") || "see the rejection reason"} (name, address, account number and PIN must match the carrier's record exactly).` }
  }
  if (st === "completed") {
    const pending = r.numbers.filter((n) => normalizePortStatus(n.status) === "completed" && !n.landed)
    if (pending.length) return { phase: "landing", headline: `Ported — connecting ${pending.map((n) => n.phone).join(", ")} to your AI line.`, nextStep: pending.some((n) => n.landError) ? `Connecting failed: ${pending.map((n) => n.landError).filter(Boolean).join(" · ")} — it retries every hour.` : "Automatic — business registration starts the moment it lands." }
    return { phase: "completed", headline: `Ported and live: ${nums}.`, nextStep: "Business registration started automatically — see Carrier registration below." }
  }
  if (st === "waiting_for_signature") return { phase: "waiting_for_signature", headline: `Waiting for the Letter of Authorization to be signed (sent to ${r.repEmail}).`, nextStep: `Sign it within 30 days${r.signatureUrl ? ` at ${r.signatureUrl}` : " from the e-mail Twilio sent"} — otherwise the request cancels itself.` }
  if (st === "in_progress") return { phase: "in_progress", headline: `Submitted to your current carrier${r.targetDate ? ` — target port date ${r.targetDate}` : ""}.`, nextStep: "Keep your current service active until the port completes; cancelling it early kills the port." }
  return { phase: "in_review", headline: `Twilio is reviewing the port request (${nums}).`, nextStep: "Nothing to do — it moves on its own; watch for the signature e-mail." }
}

// ── Persistence (brokerage_settings.settings.phone_port_ins) ─────────────────

export async function loadPortIns(svc: any, brokerageId: string): Promise<{ ok: true; rowId: string | null; settings: Record<string, any>; records: PortInRecord[] } | { ok: false; error: string }> {
  const { data, error } = await svc.from("brokerage_settings").select("id, settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `port-in records could not be read (${error.message})` }
  const settings = ((data as any)?.settings ?? {}) as Record<string, any>
  return { ok: true, rowId: (data as any)?.id ?? null, settings, records: Array.isArray(settings.phone_port_ins) ? settings.phone_port_ins : [] }
}

/** Read-modify-write on the CURRENT settings (re-read here, never a stale copy). */
async function savePortIns(svc: any, brokerageId: string, mutate: (records: PortInRecord[]) => PortInRecord[]): Promise<{ ok: true; records: PortInRecord[] } | { ok: false; error: string }> {
  const cur = await loadPortIns(svc, brokerageId)
  if (!cur.ok) return cur
  const records = mutate(cur.records).slice(0, MAX_RECORDS)
  const settings = { ...cur.settings, phone_port_ins: records }
  const write = cur.rowId
    ? await svc.from("brokerage_settings").update({ settings, updated_at: new Date().toISOString() }).eq("id", cur.rowId).eq("brokerage_id", brokerageId).select("id")
    : await svc.from("brokerage_settings").insert({ brokerage_id: brokerageId, settings }).select("id")
  if (write?.error) return { ok: false, error: `port-in record NOT saved (${write.error.message})` }
  if (cur.rowId && Array.isArray(write?.data) && write.data.length === 0) return { ok: false, error: "port-in record NOT saved (the settings row matched nothing)" }
  return { ok: true, records }
}

// ── Submit (tenant door) ─────────────────────────────────────────────────────

type Adapter = typeof import("@/lib/providers/twilio/client")
export interface PortInDeps {
  creds?: { accountSid: string; authToken: string } | null
  adapter?: Pick<Adapter, "checkPortability" | "createPortInRequest" | "fetchPortInRequest" | "uploadPortingUtilityBill">
  attach?: typeof import("@/lib/voice/number-provisioning")["attachOwnedNumber"]
  allowance?: (svc: any, brokerageId: string) => Promise<{ allowed: boolean; reason?: string | null }>
  now?: Date
}

async function portCreds(svc: any, brokerageId: string, deps?: PortInDeps) {
  if (deps && "creds" in deps) return deps.creds ?? null
  const { ensureTenantSubaccount, resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  // The port lands in the tenant's OWN subaccount (A2P files from there).
  try { await ensureTenantSubaccount(svc, brokerageId) } catch { /* falls through to existing creds */ }
  return resolveTenantTwilioCreds(svc, brokerageId)
}

/** Portability for each number — READ only (nothing filed). */
export async function checkNumbersPortable(svc: any, brokerageId: string, phoneNumbers: string[], deps?: PortInDeps): Promise<{ ok: true; verdicts: PortabilityVerdict[] } | { ok: false; error: string }> {
  const creds = await portCreds(svc, brokerageId, deps)
  if (!creds) return { ok: false, error: "Telephony isn't connected yet — portability can't be checked (nothing was filed)." }
  const adapter = deps?.adapter ?? (await import("@/lib/providers/twilio/client"))
  const verdicts: PortabilityVerdict[] = []
  for (const raw of phoneNumbers.slice(0, PORT_MAX_NUMBERS_PER_REQUEST)) {
    const n = e164(raw)
    if (!n || isTollFreeNumber(n)) continue
    const r = await adapter.checkPortability(creds as any, n)
    // Fail CLOSED: an unanswered check is never "portable".
    if (!r.ok || !r.data) return { ok: false, error: `Portability check failed for ${n} (${r.status ?? "—"}): ${r.error ?? "no answer"} — nothing was filed.` }
    verdicts.push({ phoneNumber: n, portable: r.data.portable, pinAndAccountNumberRequired: r.data.pinAndAccountNumberRequired, notPortableReason: r.data.notPortableReason })
  }
  return { ok: true, verdicts }
}

export type SubmitPortInResult =
  | { ok: true; record: PortInRecord; status: ReturnType<typeof describePortIn> }
  | { ok: false; error: string; missing?: string[] }

/**
 * File the port: allowance gate → creds → portability (fail closed) → validate
 * → utility bill upload → PortIn create → persist. Every refusal names why.
 */
export async function submitPortIn(
  svc: any, brokerageId: string,
  input: Partial<PortInInput>,
  utilityBill: { name: string; type: string; bytes: ArrayBuffer } | null,
  opts: { agentUserId?: string | null; agentId?: string | null; deps?: PortInDeps } = {},
): Promise<SubmitPortInResult> {
  const deps = opts.deps
  const now = deps?.now ?? new Date()

  // A ported number is an ACTIVE number — the plan allowance gates it exactly
  // like a purchase (bundle → metered overage → hard cap).
  const allowance = deps?.allowance ?? (async (s: any, b: string) => (await import("@/lib/billing/phone-plan-resolve")).evaluateTenantNumberProvisioning(s, b))
  const verdict = await allowance(svc, brokerageId)
  if (!verdict.allowed) return { ok: false, error: verdict.reason ?? "Your plan's active-number limit has been reached — nothing was filed" }

  const creds = await portCreds(svc, brokerageId, deps)
  if (!creds) return { ok: false, error: "Telephony isn't connected yet, so a port can't be filed — nothing was filed." }

  const pre = validatePortInInput(input, { today: now })
  if (!pre.ok) return { ok: false, error: "The port request is incomplete", missing: pre.missing }
  const portable = await checkNumbersPortable(svc, brokerageId, pre.value.phoneNumbers, { ...deps, creds })
  if (!portable.ok) return { ok: false, error: portable.error }
  const v = validatePortInInput(input, { today: now, portability: portable.verdicts })
  if (!v.ok) return { ok: false, error: "The port request is incomplete", missing: v.missing }

  if (!utilityBill || utilityBill.bytes.byteLength === 0) return { ok: false, error: "The port request is incomplete", missing: ["A recent utility bill / carrier invoice (PDF or image, ≤30 days old, ≤10 MB) showing the account holder and service address"] }
  if (utilityBill.bytes.byteLength > 10 * 1024 * 1024) return { ok: false, error: "The utility bill must be 10 MB or smaller" }

  const adapter = deps?.adapter ?? (await import("@/lib/providers/twilio/client"))
  const doc = await adapter.uploadPortingUtilityBill(creds as any, utilityBill)
  if (!doc.ok || !doc.data) return { ok: false, error: `Utility bill upload refused (${doc.status ?? "—"}): ${doc.error ?? "unknown"} — nothing was filed.` }

  const val = v.value
  const created = await adapter.createPortInRequest(creds as any, {
    accountSid: creds.accountSid,
    documentSids: [doc.data.sid],
    phoneNumbers: val.phoneNumbers.map((n) => ({ phoneNumber: n, ...(val.pins?.[n] ? { pin: val.pins[n] } : {}) })),
    losingCarrier: {
      customerName: val.customerName, customerType: val.customerType,
      accountNumber: val.accountNumber, accountTelephoneNumber: val.accountTelephoneNumber,
      authorizedRepresentative: val.authorizedRepresentative, authorizedRepresentativeEmail: val.authorizedRepresentativeEmail,
      address: { street: val.street, street2: val.street2, city: val.city, state: val.state, zip: val.zip },
    },
    notificationEmails: [val.authorizedRepresentativeEmail],
    targetPortInDate: val.targetPortInDate,
  })
  if (!created.ok || !created.data) return { ok: false, error: `Twilio refused the port request (${created.status ?? "—"}): ${created.error ?? "unknown"}` }

  const record: PortInRecord = {
    sid: created.data.sid,
    status: created.data.status || "In Review",
    numbers: val.phoneNumbers.map((phone) => {
      const hit = created.data!.numbers.find((n) => n.phoneNumber === phone)
      return { phone, status: hit?.status ?? "In Review", rejection: hit?.rejectionReason ?? null, portDate: hit?.portDate ?? null, landed: false }
    }),
    signatureUrl: created.data.signatureRequestUrl,
    targetDate: created.data.targetPortInDate ?? val.targetPortInDate,
    repEmail: val.authorizedRepresentativeEmail,
    submittedAt: now.toISOString(),
    lastPolledAt: null,
    agentUserId: opts.agentUserId ?? null,
    agentId: opts.agentId ?? null,
    error: null,
  }
  const saved = await savePortIns(svc, brokerageId, (rs) => [record, ...rs.filter((r) => r.sid !== record.sid)])
  // The request IS filed at Twilio — a failed local save is reported, never hidden.
  if (!saved.ok) return { ok: false, error: `The port was FILED with Twilio (request ${record.sid}) but the local record did not save: ${saved.error}. Support can re-link it; do not file it twice.` }
  return { ok: true, record, status: describePortIn(record) }
}

// ── Poll (the cron) ─────────────────────────────────────────────────────────

export interface PortPollSummary {
  polled: number
  landed: string[]
  rejected: string[]
  errors: string[]
  records: PortInRecord[]
}

/**
 * Advance every open port for one tenant: fetch by the request's OWN sid,
 * record statuses, LAND each completed number through attachOwnedNumber (which
 * kicks business registration), and audit a carrier rejection once.
 */
export async function pollPortIns(svc: any, brokerageId: string, deps?: PortInDeps): Promise<PortPollSummary> {
  const out: PortPollSummary = { polled: 0, landed: [], rejected: [], errors: [], records: [] }
  const cur = await loadPortIns(svc, brokerageId)
  if (!cur.ok) { out.errors.push(cur.error); return out }
  const open = cur.records.filter(portInNeedsPolling)
  if (!open.length) { out.records = cur.records; return out }
  const creds = await portCreds(svc, brokerageId, deps)
  if (!creds) { out.errors.push("telephony not connected — port status not polled"); out.records = cur.records; return out }
  const adapter = deps?.adapter ?? (await import("@/lib/providers/twilio/client"))
  const attach = deps?.attach ?? (await import("@/lib/voice/number-provisioning")).attachOwnedNumber
  const now = (deps?.now ?? new Date()).toISOString()
  const updated = new Map<string, PortInRecord>()

  for (const rec of open) {
    const r = { ...rec, numbers: rec.numbers.map((n) => ({ ...n })) }
    const fetched = await adapter.fetchPortInRequest(creds as any, rec.sid)
    out.polled++
    if (!fetched.ok || !fetched.data) {
      r.error = `status poll failed (${fetched.status ?? "—"}): ${fetched.error ?? "unknown"}`
      out.errors.push(`${rec.sid}: ${r.error}`)
    } else {
      r.status = fetched.data.status || r.status
      r.signatureUrl = fetched.data.signatureRequestUrl ?? r.signatureUrl
      r.targetDate = fetched.data.targetPortInDate ?? r.targetDate
      r.error = null
      for (const n of r.numbers) {
        const hit = fetched.data.numbers.find((x) => x.phoneNumber === n.phone)
        if (hit) { n.status = hit.status ?? n.status; n.rejection = hit.rejectionReason ?? n.rejection; n.portDate = hit.portDate ?? n.portDate }
      }
    }
    r.lastPolledAt = now

    for (const n of r.numbers) {
      const ns = normalizePortStatus(n.status)
      if ((NUMBER_DONE as readonly string[]).includes(ns) && !n.landed) {
        const landed = await attach(svc, {
          brokerageId, phoneNumber: n.phone,
          scopeType: r.agentUserId ? "agent" : "brokerage",
          agentUserId: r.agentUserId, agentId: r.agentId,
          source: "ported_in", eventSource: "port_in_cron",
        })
        // Idempotent: a number this tenant already has active IS landed.
        if (landed.ok || /already active on your account/.test(landed.error)) { n.landed = true; n.landError = null; out.landed.push(n.phone) }
        else { n.landError = landed.error.slice(0, 300); out.errors.push(`${n.phone}: ${landed.error}`) }
      }
      if ((NUMBER_REJECTED as readonly string[]).includes(ns) && !n.rejectionLogged) {
        const { logPhoneNumberEvent } = await import("@/lib/voice/number-provisioning")
        await logPhoneNumberEvent(svc, { brokerageId, phoneNumber: n.phone, eventType: "failed", source: "port_in_cron", notes: `port-in ${rec.sid} rejected by the losing carrier: ${n.rejection ?? "no reason given"}`.slice(0, 500) })
        n.rejectionLogged = true
        out.rejected.push(n.phone)
      }
    }
    updated.set(r.sid, r)
  }

  const saved = await savePortIns(svc, brokerageId, (rs) => rs.map((x) => updated.get(x.sid) ?? x))
  if (!saved.ok) { out.errors.push(saved.error); out.records = cur.records.map((x) => updated.get(x.sid) ?? x); return out }
  out.records = saved.records
  return out
}
