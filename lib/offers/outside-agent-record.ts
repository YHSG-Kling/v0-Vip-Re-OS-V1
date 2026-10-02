// lib/offers/outside-agent-record.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE OUTSIDE (COOPERATING) BUYER'S AGENT — a RECORD, not a seat, not a lead.
//
// Owner, wave 94 (verbatim): "an outside offer will most likely come into the
// listing agents email from an outside buyers agent who we need to create a
// record for this outside agent since they will be copied on notifications of
// the accepted/counter offer and any activity on the transaction etc."
//
// THE SURVIVOR IS THE TABLE THAT ALREADY EXISTED. `public.outside_agents` and
// `public.outside_agent_contact_links` were created by scripts/1001-outside-agents.sql
// ("REALTORS® from OTHER brokerages … NOT contacts in the CRM sense — a distinct
// entity … linked to contacts, e.g. 'this buyer's representing agent is Bob from
// XYZ Realty'") and had ZERO writers and ZERO readers in app/ and lib/ (live:
// 0 rows in both, 2026-10-02). A reader-less, writer-less table the owner now
// asks for is CLAUDE.md §1 case 2: no duplicate exists, so the missing halves are
// BUILT here — nothing about it is a second path:
//   · it is NOT a `users` seat (an outside agent never signs in);
//   · it is NOT a `contacts` row (they are not our client and not a lead — a
//     contact would enrol them in nurture, invite them to a portal and count
//     them in the agent's book);
//   · it is NOT a vendor (CLAUDE.md §4: vendor categories are lenders/title).
//
// WHAT LIVES HERE
//   · the PURE half — parse the agent out of the inbound email, merge without
//     overwriting, and decide which deal moments copy them (a proof runs these
//     with no database);
//   · the I/O half — create-or-reuse the record (keyed by brokerage + email),
//     link it to the buyer the offer names, resolve it from any offer in a
//     counter chain or from the transaction, and copy it BY EMAIL.
//
// CHANNEL RULE: the cooperating agent is a B2B professional on the file, so the
// copy is a TRANSACTIONAL EMAIL through the one governed egress
// (lib/providers/dispatch.ts:dispatchEmail). Never SMS, never voice — there is
// no consent for either and nothing here can reach them.
//
// Not server-only on purpose: the pure functions are driven by
// scripts/inbound-offer-lane-simulator.ts; every database touch is behind an
// injected client.

import type { SupabaseClient } from "@supabase/supabase-js"
import { KernelEvent } from "@/lib/kernel/events"
import { momentForType } from "@/lib/notifications/notification-moments"
import { splitPersonName } from "@/lib/platform/prospect-conversion"

/** offers.metadata key carrying the outside_agents.id of the buyer's cooperating agent. */
export const OUTSIDE_AGENT_ID_KEY = "outside_agent_id"
/** outside_agent_contact_links.link_role for the agent representing the buyer on an offer. */
export const OUTSIDE_AGENT_BUYER_LINK_ROLE = "cooperating_buyer_agent"
/** outside_agents.source when the record was born from an inbound email. */
export const OUTSIDE_AGENT_SOURCE_INBOUND_EMAIL = "inbound_email"
/** contacts.source on the intake record of a buyer another brokerage represents. */
export const OUTSIDE_BUYER_INTAKE_SOURCE = "outside_offer_intake"
/** activities.activity_type of one cooperating-agent copy (the dedupe ledger). */
export const OUTSIDE_AGENT_COPIED_ACTIVITY = "outside_agent_copied"

type Svc = SupabaseClient

export interface OutsideAgentFields {
  fullName:      string | null
  firstName:     string | null
  lastName:      string | null
  email:         string | null
  phone:         string | null
  brokerageName: string | null
  licenseNumber: string | null
}

// ─── PURE: read the agent off the email ─────────────────────────────────────

const SIGN_OFF_RE = /^(thanks|thank you|many thanks|best|best regards|kind regards|warm regards|regards|sincerely|cheers|warmly|respectfully|all the best)[\s,!.]*$/i
const BROKERAGE_RE = /\b(realty|real estate|realtors?|properties|brokerage|homes|group|associates|sotheby'?s|keller williams|re\/?max|coldwell|compass|exp|century 21|berkshire|douglas elliman|redfin|howard hanna|weichert|corcoran|engel)\b/i
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/
const LICENSE_RE = /\b(?:lic(?:ense)?\.?|licence)\s*(?:no\.?|number|#)?\s*:?\s*#?\s*([A-Z]{0,3}\d{4,10})\b/i
const NAME_LINE_RE = /^[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]*){1,3}$/

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").replace(/\s+/g, " ").trim()
  return t ? t : null
}

// TOMBSTONE (§1/§6): this module's own splitPersonName was a second spelling of
// lib/platform/prospect-conversion.ts splitPersonName — merged onto that survivor
// (couple-aware: "Nadia and Omar Park" → first "Nadia and Omar", last "Park") and
// deleted. Absent parts come back "" there; `|| null` below keeps columns NULL.

/** Ten digits for the indexed phone_digits column (a plain column on outside_agents, not GENERATED). */
export function phoneDigits(phone: string | null): string | null {
  const d = (phone ?? "").replace(/\D/g, "")
  if (d.length < 10) return null
  return d.slice(-10)
}

/**
 * The outside agent as the EMAIL describes them. Name precedence: the From
 * display name (the provider's own header), then the signature block. Phone,
 * brokerage and licence come from the signature block (the lines after the
 * sign-off), falling back to the whole body for the phone only. Nothing is
 * invented: an absent field is null, and `email` is the sender address.
 */
export function parseOutsideAgentFromEmail(input: {
  fromEmail: string | null
  fromName?: string | null
  bodyText:  string | null
}): OutsideAgentFields {
  const email = clean(input.fromEmail)?.toLowerCase() ?? null
  const lines = (input.bodyText ?? "").split(/\r?\n/).map((l) => l.trim())
  const signOff = lines.findIndex((l) => SIGN_OFF_RE.test(l))
  const sig = signOff >= 0 ? lines.slice(signOff + 1, signOff + 9).filter(Boolean) : []

  const displayName = clean(input.fromName)
  const usableDisplay = displayName && !displayName.includes("@") ? displayName : null
  const sigName = sig.find((l) => NAME_LINE_RE.test(l) && !BROKERAGE_RE.test(l)) ?? null
  const fullName = usableDisplay ?? clean(sigName)

  const brokerageName = clean(sig.find((l) => BROKERAGE_RE.test(l) && !l.includes("@") && !PHONE_RE.test(l)) ?? null)
  const phoneMatch = sig.map((l) => l.match(PHONE_RE)).find(Boolean) ?? (input.bodyText ?? "").match(PHONE_RE)
  const phone = phoneMatch ? `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}` : null
  const licenseMatch = (sig.join("\n") || (input.bodyText ?? "")).match(LICENSE_RE)

  const { first, last } = splitPersonName(fullName)
  return {
    fullName, firstName: first || null, lastName: last || null, email, phone,
    brokerageName, licenseNumber: licenseMatch ? licenseMatch[1].toUpperCase() : null,
  }
}

/**
 * Overlay a second reading (the AI's extraction of the contract) onto the
 * email's reading. FILL-ONLY: a field the email already established is never
 * replaced by the model's — the email header is the sender's own word.
 */
export function overlayOutsideAgentFields(base: OutsideAgentFields, extra: Partial<OutsideAgentFields>): OutsideAgentFields {
  const out = { ...base }
  for (const k of Object.keys(out) as Array<keyof OutsideAgentFields>) {
    if (!out[k] && clean(extra[k] as string | null)) out[k] = clean(extra[k] as string | null)
  }
  if (out.fullName && (!out.firstName || !out.lastName)) {
    const s = splitPersonName(out.fullName)
    out.firstName ??= s.first || null
    out.lastName  ??= s.last || null
  }
  if (out.email) out.email = out.email.toLowerCase()
  return out
}

/** The outside_agents columns a stored row is missing and `incoming` can fill. Never overwrites. */
export function outsideAgentFillPatch(
  existing: Record<string, unknown>,
  incoming: OutsideAgentFields,
): Record<string, string> {
  const want: Record<string, string | null> = {
    full_name:              incoming.fullName,
    first_name:             incoming.firstName,
    last_name:              incoming.lastName,
    phone:                  incoming.phone,
    phone_digits:           phoneDigits(incoming.phone),
    outside_brokerage_name: incoming.brokerageName,
    license_number:         incoming.licenseNumber,
  }
  const patch: Record<string, string> = {}
  for (const [col, v] of Object.entries(want)) {
    const cur = existing[col]
    if (v && (cur === null || cur === undefined || String(cur).trim() === "")) patch[col] = v
  }
  return patch
}

/**
 * The intake buyer named on an emailed offer, from the agent's message — "my
 * buyers, Mia and Theo Park", "on behalf of my client Ana Ruiz". Null when the
 * message does not name them (the AI read of the contract fills it later).
 */
export function parseBuyerNameFromEmail(bodyText: string | null): string | null {
  const t = (bodyText ?? "").replace(/\s+/g, " ")
  const m = t.match(/\b(?:my|our)\s+(?:buyers?|clients?)\s*,?\s+([A-Z][a-z'’-]+(?:\s+(?:and|&)\s+[A-Z][a-z'’-]+)?\s+[A-Z][a-z'’-]+)/)
    ?? t.match(/\bon behalf of (?:my (?:buyers?|clients?)\s*,?\s*)?([A-Z][a-z'’-]+(?:\s+(?:and|&)\s+[A-Z][a-z'’-]+)?\s+[A-Z][a-z'’-]+)/)
  return m ? clean(m[1]) : null
}

/**
 * The contract's buyer list as ONE intake name, in the shape the email names a
 * couple: ["Nadia Park", "Omar Park"] → "Nadia and Omar Park". Two surnames →
 * the first (primary) buyer only; the full list stays in offers.ai_extracted_data.
 */
export function buyerNamesAsOne(names: ReadonlyArray<string | null | undefined> | null | undefined): string | null {
  const list = (names ?? []).map((n) => clean(n)).filter((n): n is string => !!n)
  if (list.length === 0) return null
  if (list.length === 1) return list[0]!
  const split = list.map((n) => n.split(" "))
  const surname = split[0]!.length > 1 ? split[0]![split[0]!.length - 1]! : null
  const shared = surname && split.length === 2 && split.every((p) => p.length === 2 && p[1] === surname)
  return shared ? `${split[0]![0]} and ${split[1]![0]} ${surname}` : list[0]!
}

// ─── PURE: which deal moments copy the cooperating agent ────────────────────

/**
 * A MOMENT, not an event. Several kernel events describe one real-world moment
 * (TRANSACTION_CLOSED and DEAL_CLOSED, emitted together by closeTransactionCommand;
 * a stage change to `closed` in the same breath), and the owner's wave-94 ruling
 * is ONE notification per person per moment. The dedupe ledger keys on the
 * moment, so the second spelling of the same moment is a no-op.
 */
export type CooperatingAgentMoment =
  | "counter" | "rejected" | "inspection" | "appraisal" | "financing"
  | "earnest_money" | "milestone" | "stage" | "closing_scheduled" | "closed"

/**
 * THE MOMENT VOCABULARY IS LANE 94A's, NOT A SECOND ONE (§6):
 * lib/notifications/notification-moments.ts NOTIFICATION_MOMENTS groups the
 * spellings of "under contract" and of "closed". Both are read through its
 * momentForType:
 *   · UNDER CONTRACT (the accept) is NOT copied here, deliberately. It belongs to
 *     lib/notifications/notify-helpers.ts notifyTransactionParties — the terms
 *     packet the offer→deal bridge sends to every outside professional on the
 *     roster the moment the transaction exists. With the cooperating agent on that
 *     roster (lib/transactions/participant-populator.ts reads this record), a copy
 *     here would be the duplicate the wave-94 ruling forbids.
 *   · CLOSED is one copy, whichever spelling arrives first.
 * Only the moments 94A's alert ledger does not group are listed below.
 */
export const COOPERATING_AGENT_COPY_EVENTS: Readonly<Partial<Record<string, CooperatingAgentMoment>>> = {
  [KernelEvent.OFFER_COUNTER_SENT]:       "counter",
  [KernelEvent.OFFER_REJECTED]:           "rejected",
  [KernelEvent.INSPECTION_COMPLETED]:     "inspection",
  [KernelEvent.APPRAISAL_COMPLETED]:      "appraisal",
  [KernelEvent.FINANCING_CLEAR_TO_CLOSE]: "financing",
  [KernelEvent.EARNEST_MONEY_RECEIVED]:   "earnest_money",
  [KernelEvent.MILESTONE_COMPLETED]:      "milestone",
  [KernelEvent.TRANSACTION_STAGE_CHANGED]:"stage",
  [KernelEvent.CLOSING_SCHEDULED]:        "closing_scheduled",
}

/**
 * The moment an event copies the cooperating agent on, and the key that makes
 * the copy idempotent — or null when this event is not a copy moment (including
 * every under-contract spelling, owned by the parties packet).
 */
export function cooperatingAgentCopyPlan(event: string, metadata: Record<string, unknown> | null | undefined, entityId: string):
  { moment: CooperatingAgentMoment; copyKey: string } | null {
  const shared = momentForType(event)
  if (shared === "under_contract") return null
  let moment: CooperatingAgentMoment | undefined = shared === "closed" ? "closed" : COOPERATING_AGENT_COPY_EVENTS[event]
  if (!moment) return null
  const md = metadata ?? {}
  const toStage = String(md.to_stage ?? md.new_stage ?? "").toLowerCase()
  if (moment === "stage") {
    if (/closed/.test(toStage)) moment = "closed"
    else if (/under_contract|contract/.test(toStage)) return null // the accept moment
  }
  const detail =
    moment === "milestone" ? String(md.milestone_name ?? md.milestone_id ?? "").toLowerCase()
    : moment === "stage"   ? toStage
    : moment === "counter" ? entityId
    : ""
  return { moment, copyKey: detail ? `${moment}:${detail}` : moment }
}

const MOMENT_SUBJECT: Record<CooperatingAgentMoment, string> = {
  counter:           "Counter offer",
  rejected:          "Offer response",
  inspection:        "Inspection completed",
  appraisal:         "Appraisal completed",
  financing:         "Clear to close",
  earnest_money:     "Earnest money received",
  milestone:         "Milestone completed",
  stage:             "Transaction update",
  closing_scheduled: "Closing scheduled",
  closed:            "Closed",
}

/** Subject + plain text for one copy. No commission, no seller financials — terms the other side already holds.
 *  @proofSeam exported so scripts/inbound-offer-lane-simulator.ts (W94·H7) asserts the copy carries no commission or seller net without sending; used in-file by copyCooperatingAgentOnDealMoment. */
export function composeCooperatingAgentCopy(input: {
  moment:          CooperatingAgentMoment
  propertyAddress: string | null
  agentName:       string | null
  metadata:        Record<string, unknown> | null | undefined
  listingAgentName?: string | null
}): { subject: string; text: string } {
  const md = input.metadata ?? {}
  const where = input.propertyAddress ?? "the property"
  const lines: string[] = []
  if (input.moment === "counter") {
    const price = Number(md.counter_price ?? NaN)
    lines.push(`The seller has countered your buyer's offer on ${where}.`)
    if (Number.isFinite(price) && price > 0) lines.push(`Counter price: $${Math.round(price).toLocaleString("en-US")}.`)
    if (md.response_deadline) lines.push(`Please respond by ${String(md.response_deadline).slice(0, 16).replace("T", " ")}.`)
    lines.push("The listing agent will send the signed counter paperwork separately.")
  } else if (input.moment === "rejected") {
    lines.push(`The seller has responded to your buyer's offer on ${where}: it was not accepted.`)
  } else if (input.moment === "milestone") {
    lines.push(`${String(md.milestone_name ?? "A milestone")} is complete on ${where}.`)
  } else if (input.moment === "stage") {
    lines.push(`The transaction on ${where} moved to ${String(md.to_stage ?? "its next stage").replace(/_/g, " ")}.`)
  } else if (input.moment === "closed") {
    lines.push(`The transaction on ${where} has closed. Thank you for working with us.`)
  } else {
    lines.push(`${MOMENT_SUBJECT[input.moment]} on ${where}.`)
  }
  const greeting = input.agentName ? `Hi ${splitPersonName(input.agentName).first},` : "Hello,"
  const sign = input.listingAgentName ? `\n\n${input.listingAgentName}\nListing agent` : ""
  return {
    subject: `${MOMENT_SUBJECT[input.moment]} — ${where}`,
    text: `${greeting}\n\n${lines.join(" ")}\n\nYou are receiving this as the cooperating buyer's agent on this file.${sign}`,
  }
}

// ─── I/O: create or reuse the record ────────────────────────────────────────

export interface UpsertOutsideAgentResult {
  ok:       boolean
  id:       string | null
  created:  boolean
  /** Columns filled on an EXISTING record (never overwritten). */
  filled:   string[]
  error:    string | null
}

/**
 * Create-or-reuse by (brokerage, email). The address is the identity: without
 * one the agent cannot be copied, so the record is refused rather than written
 * as a nameless row nobody can reach. Every read and write destructures its
 * error (CLAUDE.md §3) and the reuse path fills blanks only.
 */
export async function upsertOutsideAgentRecord(
  svc: Svc,
  params: { brokerageId: string; fields: OutsideAgentFields; source: string; notes?: string | null },
): Promise<UpsertOutsideAgentResult> {
  const email = params.fields.email?.toLowerCase().trim() || null
  if (!email) return { ok: false, id: null, created: false, filled: [], error: "no email address — an outside agent with no address cannot be copied" }

  const { data: found, error: readErr } = await svc
    .from("outside_agents")
    .select("id, full_name, first_name, last_name, phone, phone_digits, outside_brokerage_name, license_number")
    .eq("brokerage_id", params.brokerageId)
    .eq("email", email)
    .order("created_at", { ascending: true })
    .limit(1)
  if (readErr) return { ok: false, id: null, created: false, filled: [], error: `outside agent lookup refused: ${readErr.message}` }

  const existing = ((found ?? []) as Array<Record<string, unknown>>)[0]
  if (existing) {
    const patch = outsideAgentFillPatch(existing, params.fields)
    const keys = Object.keys(patch)
    if (keys.length > 0) {
      const { data: upd, error: updErr } = await svc
        .from("outside_agents")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", existing.id as string)
        .eq("brokerage_id", params.brokerageId)
        .select("id")
      if (updErr) return { ok: true, id: existing.id as string, created: false, filled: [], error: `fill-in refused: ${updErr.message}` }
      if ((upd ?? []).length === 0) return { ok: true, id: existing.id as string, created: false, filled: [], error: "fill-in matched no row" }
    }
    return { ok: true, id: existing.id as string, created: false, filled: keys, error: null }
  }

  const f = params.fields
  const { data: ins, error: insErr } = await svc
    .from("outside_agents")
    .insert({
      brokerage_id:           params.brokerageId,
      full_name:              f.fullName,
      first_name:             f.firstName,
      last_name:              f.lastName,
      email,
      phone:                  f.phone,
      phone_digits:           phoneDigits(f.phone),
      outside_brokerage_name: f.brokerageName,
      license_number:         f.licenseNumber,
      source:                 params.source,
      notes:                  params.notes ?? null,
    })
    .select("id")
    .single()
  if (insErr || !ins) return { ok: false, id: null, created: false, filled: [], error: `outside agent not created: ${insErr?.message ?? "no row returned"}` }
  return { ok: true, id: (ins as { id: string }).id, created: true, filled: [], error: null }
}

/** Link the record to the buyer it represents (idempotent on the table's own unique key). */
export async function linkOutsideAgentToBuyer(
  svc: Svc,
  params: { brokerageId: string; outsideAgentId: string; contactId: string; listingId?: string | null },
): Promise<{ ok: boolean; linked: boolean; error: string | null }> {
  const { data: have, error: readErr } = await svc
    .from("outside_agent_contact_links")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("outside_agent_id", params.outsideAgentId)
    .eq("contact_id", params.contactId)
    .eq("link_role", OUTSIDE_AGENT_BUYER_LINK_ROLE)
    .limit(1)
  if (readErr) return { ok: false, linked: false, error: `link lookup refused: ${readErr.message}` }
  if ((have ?? []).length > 0) return { ok: true, linked: false, error: null }
  const { error: insErr } = await svc.from("outside_agent_contact_links").insert({
    brokerage_id:       params.brokerageId,
    outside_agent_id:   params.outsideAgentId,
    contact_id:         params.contactId,
    link_role:          OUTSIDE_AGENT_BUYER_LINK_ROLE,
    listing_id:         params.listingId ?? null,
  })
  if (insErr) return { ok: false, linked: false, error: `link not written: ${insErr.message}` }
  return { ok: true, linked: true, error: null }
}

/** contacts.metadata key: the outside_agents.id of the agent who represents this (outside) buyer. */
export const REPRESENTED_BY_OUTSIDE_AGENT_KEY = "represented_by_outside_agent_id"

/**
 * IS THIS CONTACT ANOTHER BROKERAGE'S CLIENT? (owner, wave 94: "the outside buyer
 * is the outside agent's client, not ours"). Read from the two marks the outside
 * path writes — contacts.metadata.represented_by_outside_agent_id (or the intake
 * source) and an outside_agent_contact_links row as cooperating_buyer_agent — so
 * every client rail (the automatic portal invite and welcome in
 * lib/kernel/crm.ts createContactManually first) can SKIP them.
 *
 * FAILS CLOSED: a refused read answers `represented: true` with the reason. An
 * invite sent to someone another brokerage represents goes around their agent and
 * cannot be taken back; an invite held back from our own client is reported and
 * can be sent by hand.
 */
export async function readOutsideRepresentation(
  db: Svc,
  params: { brokerageId: string; contactId: string },
): Promise<{ represented: boolean; outsideAgentId: string | null; reason: string }> {
  const { data: c, error: cErr } = await db
    .from("contacts").select("source, metadata")
    .eq("id", params.contactId).eq("brokerage_id", params.brokerageId).maybeSingle()
  if (cErr) return { represented: true, outsideAgentId: null, reason: `representation read refused (${cErr.message}) — treated as represented` }
  const md = (((c as { metadata?: Record<string, unknown> | null } | null)?.metadata) ?? {}) as Record<string, unknown>
  const marked = (md[REPRESENTED_BY_OUTSIDE_AGENT_KEY] as string | null) ?? null
  if (marked || (c as { source?: string | null } | null)?.source === OUTSIDE_BUYER_INTAKE_SOURCE) {
    return { represented: true, outsideAgentId: marked, reason: "represented_by_outside_agent" }
  }
  const { data: links, error: lErr } = await db
    .from("outside_agent_contact_links").select("outside_agent_id")
    .eq("brokerage_id", params.brokerageId).eq("contact_id", params.contactId)
    .eq("link_role", OUTSIDE_AGENT_BUYER_LINK_ROLE).limit(1)
  if (lErr) return { represented: true, outsideAgentId: null, reason: `representation link read refused (${lErr.message}) — treated as represented` }
  const linked = ((links ?? []) as Array<{ outside_agent_id: string }>)[0]?.outside_agent_id ?? null
  return linked
    ? { represented: true, outsideAgentId: linked, reason: "represented_by_outside_agent" }
    : { represented: false, outsideAgentId: null, reason: "ours" }
}

export interface OutsideAgentRow {
  id: string
  full_name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  outside_brokerage_name: string | null
  license_number: string | null
}

/**
 * The cooperating agent on a deal, from ANY offer in its counter chain or from
 * the transaction. A counter is a new `offers` row (lib/kernel/offers.ts
 * issueCounterOffer, the one counter writer) that carries only `parent_offer_id`, so the record is found
 * by walking UP the chain to the offer the email created. Bounded walk; every
 * read is tenant-filtered and its refusal is reported, never read as "none".
 */
export async function resolveOutsideAgentForDeal(
  svc: Svc,
  params: { brokerageId: string; offerId?: string | null; transactionId?: string | null },
): Promise<{ agent: OutsideAgentRow | null; offerId: string | null; error: string | null }> {
  let offerId = params.offerId ?? null
  if (!offerId && params.transactionId) {
    const { data: tx, error } = await svc
      .from("transactions").select("offer_id")
      .eq("id", params.transactionId).eq("brokerage_id", params.brokerageId).maybeSingle()
    if (error) return { agent: null, offerId: null, error: `transaction read refused: ${error.message}` }
    offerId = ((tx as { offer_id: string | null } | null)?.offer_id) ?? null
  }
  let outsideAgentId: string | null = null
  let cursor = offerId
  for (let hop = 0; cursor && hop < 8 && !outsideAgentId; hop++) {
    const { data: o, error } = await svc
      .from("offers").select("id, parent_offer_id, metadata")
      .eq("id", cursor).eq("brokerage_id", params.brokerageId).maybeSingle()
    if (error) return { agent: null, offerId, error: `offer read refused: ${error.message}` }
    if (!o) break
    const md = ((o as { metadata: Record<string, unknown> | null }).metadata ?? {}) as Record<string, unknown>
    outsideAgentId = (md[OUTSIDE_AGENT_ID_KEY] as string | null) ?? null
    cursor = (o as { parent_offer_id: string | null }).parent_offer_id
  }
  if (!outsideAgentId) return { agent: null, offerId, error: null }
  const { data: a, error } = await svc
    .from("outside_agents")
    .select("id, full_name, first_name, last_name, email, phone, outside_brokerage_name, license_number")
    .eq("id", outsideAgentId).eq("brokerage_id", params.brokerageId).maybeSingle()
  if (error) return { agent: null, offerId, error: `outside agent read refused: ${error.message}` }
  return { agent: (a as OutsideAgentRow | null) ?? null, offerId, error: null }
}

export interface CopyResult {
  copied:   boolean
  skipped?: "not_a_copy_moment" | "no_outside_agent" | "no_email" | "already_copied" | "no_deal_anchor"
  moment?:  CooperatingAgentMoment
  email?:   string
  error?:   string
}

/**
 * COPY THE COOPERATING AGENT ON A DEAL MOMENT — by email, once per moment.
 * Called from the kernel reactor (lib/kernel/event-reactor.ts), the one place
 * every emitted deal event passes, so a new emitter is covered without a new
 * call site. FAILS CLOSED on its dedupe read: a refused read skips the send
 * rather than risk telling the other side twice.
 */
export async function copyCooperatingAgentOnDealMoment(
  svc: Svc,
  params: {
    brokerageId:    string
    event:          string
    entityType:     string
    entityId:       string
    transactionId?: string | null
    metadata?:      Record<string, unknown> | null
  },
): Promise<CopyResult> {
  const plan = cooperatingAgentCopyPlan(params.event, params.metadata, params.entityId)
  if (!plan) return { copied: false, skipped: "not_a_copy_moment" }

  const transactionId = params.transactionId ?? (params.entityType === "transaction" ? params.entityId : null)
  const offerId = params.entityType === "offer" ? params.entityId : null
  if (!transactionId && !offerId) return { copied: false, skipped: "no_deal_anchor", moment: plan.moment }

  const found = await resolveOutsideAgentForDeal(svc, { brokerageId: params.brokerageId, offerId, transactionId })
  if (found.error) return { copied: false, moment: plan.moment, error: found.error }
  if (!found.agent) return { copied: false, skipped: "no_outside_agent", moment: plan.moment }
  const email = found.agent.email?.trim().toLowerCase()
  if (!email) return { copied: false, skipped: "no_email", moment: plan.moment }

  // The anchor the dedupe ledger keys on: the transaction once there is one,
  // else the ROOT offer of the chain (so two counters on one chain are two keys
  // only because their ids differ — see cooperatingAgentCopyPlan).
  const anchorType = transactionId ? "transaction" : "offer"
  const anchorId = (transactionId ?? found.offerId ?? offerId) as string
  const { data: prior, error: priorErr } = await svc
    .from("activities")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("activity_type", OUTSIDE_AGENT_COPIED_ACTIVITY)
    .eq("entity_id", anchorId)
    .filter("metadata->>copy_key", "eq", plan.copyKey)
    .filter("metadata->>email", "eq", email)
    .limit(1)
  if (priorErr) return { copied: false, moment: plan.moment, error: `dedupe read refused (${priorErr.message}) — copy skipped` }
  if ((prior ?? []).length > 0) return { copied: false, skipped: "already_copied", moment: plan.moment, email }

  // The property, for the subject line — read off the deal, never guessed.
  let propertyAddress: string | null = null
  let listingId: string | null = null
  if (transactionId) {
    const { data: tx } = await svc.from("transactions").select("property_address, listing_id")
      .eq("id", transactionId).eq("brokerage_id", params.brokerageId).maybeSingle()
    propertyAddress = ((tx as any)?.property_address as string | null) ?? null
    listingId = ((tx as any)?.listing_id as string | null) ?? null
  }
  if (!propertyAddress && (offerId ?? found.offerId)) {
    const { data: o } = await svc.from("offers").select("listing_id, property_address")
      .eq("id", (offerId ?? found.offerId) as string).eq("brokerage_id", params.brokerageId).maybeSingle()
    listingId ??= ((o as any)?.listing_id as string | null) ?? null
    propertyAddress = ((o as any)?.property_address as string | null) ?? null
  }
  // The LISTING AGENT is the sender of record: dispatchEmail runs the signature
  // waterfall off agentId (user → team → brokerage), so the outside agent sees the
  // listing agent's name and signature and replies to the person on the deal —
  // not to an unsigned brokerage notice.
  let listingAgentId: string | null = null
  if (listingId) {
    const { data: l } = await svc.from("listings").select("address, agent_id")
      .eq("id", listingId).eq("brokerage_id", params.brokerageId).maybeSingle()
    propertyAddress ??= ((l as any)?.address as string | null) ?? null
    listingAgentId = ((l as any)?.agent_id as string | null) ?? null
  }

  const msg = composeCooperatingAgentCopy({
    moment: plan.moment,
    propertyAddress,
    agentName: found.agent.full_name ?? ([found.agent.first_name, found.agent.last_name].filter(Boolean).join(" ") || null),
    metadata: params.metadata,
  })
  const { dispatchEmail } = await import("@/lib/providers/dispatch")
  const sent = await dispatchEmail({
    brokerageId:    params.brokerageId,
    ...(listingAgentId ? { agentId: listingAgentId } : {}),
    to:             email,
    subject:        msg.subject,
    html:           `<p>${msg.text.split("\n\n").map((p) => p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>")).join("</p><p>")}</p>`,
    text:           msg.text,
    channelPurpose: "transactional",
    systemSource:   "cooperating_agent_copy_transactional",
    metadata:       { event: params.event, moment: plan.moment, outside_agent_id: found.agent.id, [anchorType + "_id"]: anchorId },
  })
  if (!sent?.success) return { copied: false, moment: plan.moment, email, error: `email not sent: ${sent?.error ?? "unknown"}` }

  // The ledger row IS the dedupe key. Written only after the gate accepted the
  // send; a refused write is reported — a retry could then copy twice, and the
  // caller must be able to see that.
  const now = new Date().toISOString()
  const { error: logErr } = await svc.from("activities").insert({
    brokerage_id:   params.brokerageId,
    entity_type:    anchorType,
    entity_id:      anchorId,
    transaction_id: transactionId,
    listing_id:     listingId,
    activity_type:  OUTSIDE_AGENT_COPIED_ACTIVITY,
    title:          `${msg.subject} — cooperating agent copied`,
    description:    `${found.agent.full_name ?? email} (${found.agent.outside_brokerage_name ?? "outside brokerage"}) was copied by email.`,
    status:         "completed",
    channel:        "email",
    completed_at:   now,
    metadata:       { copy_key: plan.copyKey, moment: plan.moment, email, outside_agent_id: found.agent.id, event: params.event },
  })
  if (logErr) return { copied: true, moment: plan.moment, email, error: `sent, but the copy ledger row was refused (${logErr.message}) — a retry may copy twice` }
  return { copied: true, moment: plan.moment, email }
}
