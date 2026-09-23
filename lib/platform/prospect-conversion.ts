// lib/platform/prospect-conversion.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM PROSPECT → SUBSCRIBER. Two halves, one module:
//
// (1) THE STAMP — stampProspectConversion (§1.2 build, 2026-08-27): the
//     missing writer of platform_prospects.converted_brokerage_id. Called by
//     the ONE tenant-creation core (lib/kernel/tenant-creation.ts) AFTER the
//     tenant is committed, so EVERY door — self-serve signup, the staff
//     provisioning door, and the conversion below — links a captured prospect
//     to the tenant it became. Matches by email (the web idempotency key), by
//     phone (the reception's caller-ID key — digit variants tried) and, since
//     lane 77B, by prospect id (the conversion path already holds the row).
//     Per CLAUDE.md §3 every UPDATE is COUNTED via .select("id") — a stamp
//     that matched nothing is reported as zero, never as success — and errors
//     are read, aggregated and returned.
//
//     IDEMPOTENT + NEVER-CLOBBER: only rows with converted_brokerage_id IS
//     NULL are touched (a manual link to another brokerage is a staff decision
//     this automatic path must not overwrite; a re-run is a clean zero).
//     Status is only upgraded — a row already 'converted' keeps that status
//     when the new tenant is merely trialing (it still gains the link).
//
//     OUTCOME VOCABULARY (PROSPECT_STATUSES, lib/platform/growth-funnel.ts):
//       'trial'     — a trial (no payment yet)
//       'converted' — an active subscription
//     The trial → converted advance when a trial starts paying stays with the
//     billing rail / growth board (the Stripe webhook is another lane's
//     surface).
//
// (2) THE CONVERSION — convertProspectToSubscriber (lane 77B, owner verbatim:
//     "when a real estate subscriber wants to purchase the platform
//     subscription there needs to be an easy way to convert a prospect to a
//     subscriber or a new subscriber that isn't a prospect … agenticos using
//     autonomous ai methodology with humans when warranted"). From ONE
//     platform_prospects row: the tenant facts are DERIVED from what the
//     assistant already learned (company → brokerage name, the qualification
//     seat count → tier band, territory → onboarding market suggestion),
//     the tenant is created through the SAME core every other door uses, the
//     row is stamped (status trial/converted + converted_brokerage_id — the
//     cold follow-up ladder reads only new|contacted, so it stops here), a
//     pending demo hold is released (a confirmed demo is kept and becomes the
//     onboarding session), the onboarding journey is kicked off by the core
//     (SUBSCRIPTION_CREATED + the onboarding library + the agent_onboarding
//     row provisionTenantOwner writes for a solo/team owner), and a HUMAN
//     platform-staff task is raised ONLY when warranted — enterprise size,
//     custom pricing, or a migration from another CRM — never as a default.
//
//     HUMANS WHEN WARRANTED, SPELLED OUT: the prospect can say yes on the
//     call/chat and be a subscriber before the conversation ends (a 14-day
//     trial, no card, sign-in link in their inbox — the same shape the
//     /get-started form produces). When one of the warranted conditions holds
//     the assistant does NOT self-serve the conversion; it reports the reason
//     so the surface hands off to a person, and a staff conversion from the
//     growth board proceeds WITH the white-glove task attached.
//
//     STRIPE: never touched here. An active subscription's Stripe customer is
//     created by the staff door (app/actions/admin/create-subscriber.ts) and a
//     card is collected in-app by the tenant admin through the ONE checkout
//     survivor (app/actions/billing.ts::startSubscriptionCheckout, session-
//     gated) — or, for a PAID ACTIVATION (wave 78A), through the HOSTED twin
//     of that checkout minted by the core (lib/billing/subscription-
//     activation.ts::createActivationCheckout: plan + the tier's setup fee,
//     access when it clears). This module only carries the URL back. A public
//     chat/voice surface still never takes a card itself.
//
//     IDENTITY (CLAUDE.md §4): the new brokerage id comes back from the core,
//     never from a request body; a platform_prospects.id is never passed as a
//     contactId/leadId anywhere in this module.

import type { TenantCreationInput, TenantCreationResult, CanonicalTier, SetupFeeWaiver } from "@/lib/kernel/tenant-creation"
import { CANONICAL_TIERS, tierForSeatCount, seatCountAboveEveryBand } from "@/lib/billing/plan-catalog"

export type ConversionOutcome = "trial" | "converted"

export interface ProspectConversionInput {
  brokerageId: string
  /** Every email that could identify the prospect (admin + brokerage). */
  emails: Array<string | null | undefined>
  /** Optional phone (free text — digit variants are matched against the E.164 caller-ID key). */
  phone?: string | null
  /** platform_prospects.id values the caller already holds (the conversion path). */
  prospectIds?: string[]
  outcome: ConversionOutcome
}

export interface ProspectConversionResult {
  /** Unconverted prospect rows that matched by email/phone/id. */
  matched: number
  /** Rows that received converted_brokerage_id (counted from the update's returning set). */
  linked: number
  /** Rows whose status advanced to the outcome (never a downgrade). */
  statusAdvanced: number
  errors: string[]
}

/** PURE: normalize candidate emails — lowercase, trimmed, unique, non-empty.
 *  Internal — proven through stampProspectConversion (test:prospect-conversion
 *  drives it with an injected client), not exported for nobody. */
function normalizeConversionEmails(emails: Array<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const e of emails) {
    const v = (e ?? "").trim().toLowerCase()
    if (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) out.add(v)
  }
  return Array.from(out)
}

/** PURE: phone variants to try against the caller-ID key (raw, digits, +digits, +1digits).
 *  Internal — proven through stampProspectConversion, same as above. */
function phoneMatchVariants(phone: string | null | undefined): string[] {
  const raw = (phone ?? "").trim()
  if (!raw) return []
  const digits = raw.replace(/\D/g, "")
  if (digits.length < 7) return [] // too short to be a dialable line — don't match noise
  const out = new Set<string>([raw, digits, `+${digits}`])
  if (digits.length === 10) out.add(`+1${digits}`) // US caller-ID arrives E.164 with country code
  return Array.from(out)
}

/**
 * Stamp the conversion moment: prospect rows matching this new tenant's
 * email(s)/phone/id get converted_brokerage_id (+ a status upgrade). Counted,
 * idempotent, never clobbers an existing link. Errors are returned, not thrown.
 */
export async function stampProspectConversion(svc: any, input: ProspectConversionInput): Promise<ProspectConversionResult> {
  const out: ProspectConversionResult = { matched: 0, linked: 0, statusAdvanced: 0, errors: [] }
  const emails = normalizeConversionEmails(input.emails)
  const phones = phoneMatchVariants(input.phone)
  const prospectIds = Array.from(new Set((input.prospectIds ?? []).filter((id) => typeof id === "string" && id.trim())))
  if (emails.length === 0 && phones.length === 0 && prospectIds.length === 0) return out
  if (!input.brokerageId) { out.errors.push("no brokerageId"); return out }

  // 1) Find unconverted candidates. Keyed reads instead of one .or() —
  //    PostgREST or-trees with in-lists are easy to malform silently, and all
  //    three columns are uniquely indexed, so exact reads are cheap and provable.
  const ids = new Map<string, { status: string | null }>()
  if (emails.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .select("id, status").is("converted_brokerage_id", null).in("email", emails)
    if (error) out.errors.push(`email match read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; status: string | null }>) ids.set(r.id, { status: r.status })
  }
  if (phones.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .select("id, status").is("converted_brokerage_id", null).in("phone", phones)
    if (error) out.errors.push(`phone match read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; status: string | null }>) ids.set(r.id, { status: r.status })
  }
  if (prospectIds.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .select("id, status").is("converted_brokerage_id", null).in("id", prospectIds)
    if (error) out.errors.push(`id match read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; status: string | null }>) ids.set(r.id, { status: r.status })
  }
  out.matched = ids.size
  if (ids.size === 0) return out

  const nowIso = new Date().toISOString()
  // 2) Partition: status only moves FORWARD. A row already 'converted' never
  //    drops to 'trial' — it gets the link only.
  const linkOnly: string[] = []
  const full: string[] = []
  for (const [id, row] of ids) {
    if (input.outcome === "trial" && row.status === "converted") linkOnly.push(id)
    else full.push(id)
  }

  // 3) COUNTED updates (§3: a DELETE/UPDATE that matches nothing also resolves —
  //    .select("id") and count what came back; zero here means the row was
  //    converted by a concurrent writer between read and write, which is fine,
  //    but it is REPORTED as zero, not assumed).
  if (full.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .update({ converted_brokerage_id: input.brokerageId, status: input.outcome, updated_at: nowIso })
      .in("id", full).is("converted_brokerage_id", null)
      .select("id")
    if (error) out.errors.push(`stamp update: ${error.message}`)
    else { out.linked += (data ?? []).length; out.statusAdvanced += (data ?? []).length }
  }
  if (linkOnly.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .update({ converted_brokerage_id: input.brokerageId, updated_at: nowIso })
      .in("id", linkOnly).is("converted_brokerage_id", null)
      .select("id")
    if (error) out.errors.push(`link-only update: ${error.message}`)
    else out.linked += (data ?? []).length
  }

  // 4) Audit the conversion moment — same trail the manual link and the
  //    follow-up sweep write to. Checked (error read), one row per prospect.
  for (const id of [...full, ...linkOnly]) {
    const { error } = await svc.from("superadmin_audit_log").insert({
      actor_user_id: null, actor_email: "system:tenant_creation",
      action: "platform_prospect.converted", target_type: "platform_prospect", target_id: id,
      details: { brokerage_id: input.brokerageId, outcome: input.outcome, matched_by: { emails, phones: phones.length > 0, ids: prospectIds.length > 0 } },
    })
    if (error) out.errors.push(`audit ${id}: ${error.message}`)
  }

  return out
}

// ═════════════════════════════════════════════════════════════════════════════
// (2) THE CONVERSION — pure derivation first, then the orchestration
// ═════════════════════════════════════════════════════════════════════════════

export interface ProspectRowForConversion {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  company: string | null
  role_interest: string | null
  status: string | null
  converted_brokerage_id: string | null
  details: Record<string, unknown> | null
}

export interface ProspectTenantFacts {
  brokerageName: string
  adminFirstName: string
  adminLastName: string
  adminEmail: string
  brokeragePhone: string | null
  tier: CanonicalTier
  sizeSeats: number | null
  territory: string | null
  currentTools: string | null
}

/**
 * PURE: the plan a prospect's SHAPE fits, when they did not name one. A
 * declared role_interest that is already a canonical tier wins; otherwise the
 * seat count they gave picks the band.
 *
 * TOMBSTONE (wave 78A): this file carried its OWN band table —
 * `TIER_SEAT_BANDS = solo ≤1 / team ≤15 / brokerage ≤75 / multi ∞` — which
 * contradicted the seat caps the gate enforces and so quoted a prospect with
 * 3 agents the Team plan while the plan they were sold seated fewer.
 * DELETED; survivor: lib/billing/plan-catalog.ts TIER_SEAT_BANDS +
 * tierForSeatCount (the ONE derivation — 2 / 10 / 30 / custom since wave
 * 79A). multi_location is reached by declaration (several offices) OR by a
 * seat count above every capped band, which is exactly the enterprise
 * conversation conversionHumanReasons hands to a person.
 */
const CANONICAL_TIER_SET: ReadonlySet<string> = new Set(CANONICAL_TIERS)

export function tierForProspect(roleInterest: string | null | undefined, sizeSeats: number | null | undefined): CanonicalTier {
  const declared = (roleInterest ?? "").trim()
  if (CANONICAL_TIER_SET.has(declared)) return declared as CanonicalTier
  return tierForSeatCount(sizeSeats)
}

/** PURE: "Dana Lee" → { first: "Dana", last: "Lee" }; a single token has an empty last name. */
export function splitPersonName(name: string | null | undefined): { first: string; last: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: "", last: "" }
  return { first: parts[0]!, last: parts.slice(1).join(" ") }
}

function qualificationOf(row: Pick<ProspectRowForConversion, "details">): Record<string, unknown> {
  const q = (row.details?.qualification ?? null) as Record<string, unknown> | null
  return q && typeof q === "object" ? q : {}
}

/**
 * PURE: the tenant facts a prospect row already carries. Overrides are what
 * the conversation / the rep supplied on top (a corrected email, the plan they
 * chose). Fails closed on a missing email or name — the sign-in link has to go
 * somewhere and the owner row needs a first name.
 */
export function deriveProspectTenantFacts(
  row: ProspectRowForConversion,
  overrides: { tier?: string | null; email?: string | null; name?: string | null; company?: string | null } = {},
): { ok: true; facts: ProspectTenantFacts } | { ok: false; error: string } {
  const email = ((overrides.email ?? row.email) ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "A valid work email is required to create the account — ask for it." }
  const { first, last } = splitPersonName(overrides.name ?? row.name)
  if (!first) return { ok: false, error: "The prospect's name is required to create the account — ask for it." }
  const q = qualificationOf(row)
  const sizeSeats = typeof q.size_seats === "number" && Number.isFinite(q.size_seats) && q.size_seats > 0 ? Math.round(q.size_seats) : null
  const company = ((overrides.company ?? row.company) ?? "").trim()
    || (typeof q.brokerage_name === "string" ? q.brokerage_name.trim() : "")
    || `${first}${last ? ` ${last}` : ""} Real Estate`
  const declaredTier = (overrides.tier ?? "").trim()
  const tier = CANONICAL_TIER_SET.has(declaredTier) ? (declaredTier as CanonicalTier) : tierForProspect(row.role_interest, sizeSeats)
  return {
    ok: true,
    facts: {
      brokerageName: company.slice(0, 160),
      adminFirstName: first.slice(0, 80),
      adminLastName: last.slice(0, 80),
      adminEmail: email.slice(0, 200),
      brokeragePhone: (row.phone ?? "").trim() || null,
      tier,
      sizeSeats,
      territory: typeof q.territory === "string" && q.territory.trim() ? q.territory.trim().slice(0, 300) : null,
      currentTools: typeof q.current_tools === "string" && q.current_tools.trim() ? q.current_tools.trim().slice(0, 300) : null,
    },
  }
}

// ── Humans when warranted ────────────────────────────────────────────────────

export type ConversionHumanReason = "enterprise_size" | "custom_pricing" | "crm_migration"

/** Seats at or above this are an enterprise deal — contract, rollout plan, a
 *  person. DERIVED from the bands (the first count no capped tier seats —
 *  31 while brokerage is 30), never retyped, so it moves with TIER_SEAT_BANDS. */
export const ENTERPRISE_SEAT_FLOOR = seatCountAboveEveryBand()

/** "What they use today" answers that are NOT a CRM to migrate from. */
export const NO_CRM_PATTERN = /\b(none|nothing|no crm|not? (yet|really)|spreadsheets?|excel|google sheets?|paper|notes? app|my phone|memory)\b/i

/** Words in a handoff reason that mean "they want a price that isn't the catalog". */
export const CUSTOM_PRICING_PATTERN = /\b(custom pric|discount|negotiat|contract|enterprise (pric|plan|deal)|volume pric|quote|bulk)\w*/i

/**
 * PURE: which warranted conditions hold. Empty = fully autonomous conversion.
 * Each reason is a REAL operational need, not a hedge: an enterprise rollout
 * needs a contract and a rollout plan; custom pricing is a commercial decision
 * no model may make (CLAUDE.md §5 — pricing is never invented); a CRM
 * migration is white-glove data import work the platform team performs.
 */
export function conversionHumanReasons(input: {
  tier: CanonicalTier
  sizeSeats: number | null
  currentTools: string | null
  customPricingRequested?: boolean
  handoffReason?: string | null
}): ConversionHumanReason[] {
  const out: ConversionHumanReason[] = []
  if (input.tier === "multi_location" || (input.sizeSeats ?? 0) >= ENTERPRISE_SEAT_FLOOR) out.push("enterprise_size")
  if (input.customPricingRequested === true || CUSTOM_PRICING_PATTERN.test(input.handoffReason ?? "")) out.push("custom_pricing")
  const tools = (input.currentTools ?? "").trim()
  if (tools && !NO_CRM_PATTERN.test(tools)) out.push("crm_migration")
  return out
}

export const HUMAN_REASON_LABEL: Record<ConversionHumanReason, string> = {
  enterprise_size: "enterprise size — contract and rollout plan",
  custom_pricing: "custom pricing requested — a commercial decision",
  crm_migration: "migration from their current CRM — white-glove data import",
}

// ── The orchestration ────────────────────────────────────────────────────────

export type ConversionActor =
  /** A platform_role staffer converting from the growth board (audited by name). */
  | { kind: "platform_staff"; userId: string; email: string }
  /** The prospect saying yes on a platform AI surface (chat / voice / live agent). */
  | { kind: "prospect_self"; channel: string }

/**
 * trial  — 14 days, no card (the prospect's choice, or the default)
 * paid   — ACTIVATE NOW (wave 78A): the tenant is created and a hosted checkout
 *          for the plan + the tier's one-time setup fee is minted and returned;
 *          access opens when it clears. The prospect's stated choice drives
 *          trial vs paid. A setup-fee waiver rides only a platform_staff actor
 *          and is audited by the core.
 * active — staff-provisioned, invoiced outside checkout (enterprise/contract).
 */
export type ConversionBilling =
  | { mode: "trial"; trialDays?: number }
  | { mode: "paid"; billingCycle: "monthly" | "annual"; setupFeeWaiver?: SetupFeeWaiver | null }
  | { mode: "active"; billingCycle: "monthly" | "annual" }

export interface ConvertProspectInput {
  prospectId: string
  actor: ConversionActor
  /** The plan they chose; omitted → derived from their shape (tierForProspect). */
  tier?: string | null
  billing: ConversionBilling
  /** Corrections the conversation supplied on top of the row. */
  email?: string | null
  name?: string | null
  company?: string | null
  /** They asked for a price that is not the catalog — a person decides. */
  customPricingRequested?: boolean
}

export type DemoDisposition = "none" | "hold_released" | "hold_release_failed" | "kept_as_onboarding"

export type ConvertProspectResult =
  | { ok: true; alreadyConverted: true; brokerageId: string }
  | {
      ok: true; alreadyConverted: false
      brokerageId: string; userId: string; tier: CanonicalTier
      inviteSent: boolean; inviteError?: string
      trialEndsAt: string | null
      /** Paid activation: the hosted checkout to send / open; null on a trial or when Stripe refused (see checkoutError). */
      checkoutUrl: string | null
      checkoutError?: string
      /** Paid activation: the one-time setup fee the checkout carries (0 when waived or none on the tier). */
      setupFeeCents: number | null
      setupFeeWaived: boolean
      humanReasons: ConversionHumanReason[]; staffNotified: number
      demoDisposition: DemoDisposition
      prospectLinked: number
    }
  | { ok: false; error: string; needsHuman?: ConversionHumanReason[] }

/** @proofSeam — production callers never pass this; the simulator injects the
 *  tenant-creation core and the staff bell so the orchestration is proven
 *  without a database or a mail send. */
export interface ConversionDeps {
  provisionTenant?: (svc: any, input: TenantCreationInput) => Promise<TenantCreationResult>
  notifyStaff?: (svc: any, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
}

/**
 * Convert ONE prospect into a subscriber. Every read/write destructures
 * `{ data, error }` (CLAUDE.md §3). Idempotent: a row already linked to a
 * brokerage returns that brokerage rather than provisioning twice.
 */
export async function convertProspectToSubscriber(svc: any, input: ConvertProspectInput, deps: ConversionDeps = {}): Promise<ConvertProspectResult> {
  const { data: rowData, error: rowErr } = await svc.from("platform_prospects")
    .select("id, name, email, phone, company, role_interest, status, converted_brokerage_id, details")
    .eq("id", input.prospectId).maybeSingle()
  if (rowErr) return { ok: false, error: `Prospect read refused: ${rowErr.message}` }
  const row = (rowData ?? null) as ProspectRowForConversion | null
  if (!row) return { ok: false, error: "Prospect not found" }
  if (row.converted_brokerage_id) return { ok: true, alreadyConverted: true, brokerageId: row.converted_brokerage_id }

  const derived = deriveProspectTenantFacts(row, { tier: input.tier, email: input.email, name: input.name, company: input.company })
  if (!derived.ok) return { ok: false, error: derived.error }
  const facts = derived.facts

  const handoff = (row.details?.human_handoff ?? null) as { reason?: string | null } | null
  const humanReasons = conversionHumanReasons({
    tier: facts.tier, sizeSeats: facts.sizeSeats, currentTools: facts.currentTools,
    customPricingRequested: input.customPricingRequested, handoffReason: handoff?.reason ?? null,
  })

  // THE ACTOR RULE. A prospect converts THEMSELVES into a trial OR a paid
  // activation — their stated choice (wave 78A: "not all converts … are going
  // to enroll in the trial"). No card is ever taken on a chat/voice surface:
  // the paid path mints a HOSTED checkout the prospect completes themselves.
  // A prospect can never (a) self-provision an 'active' row — that is staff
  // vouching for an invoice outside checkout — nor (b) waive their own setup
  // fee. Staff convert any shape and carry the white-glove task.
  if (input.actor.kind === "prospect_self") {
    if (input.billing.mode === "active") {
      return { ok: false, error: "A prospect can start a trial or activate with the plan's checkout on this surface; an invoiced active subscription is provisioned by platform staff." }
    }
    if (input.billing.mode === "paid" && input.billing.setupFeeWaiver) {
      return { ok: false, error: "The setup fee can be waived only by platform staff — it cannot be self-granted." }
    }
    if (humanReasons.length > 0) {
      return { ok: false, error: `This one needs a person: ${humanReasons.map((r) => HUMAN_REASON_LABEL[r]).join("; ")}. Use request_human_handoff.`, needsHuman: humanReasons }
    }
  }

  const provision = deps.provisionTenant ?? (await import("@/lib/kernel/tenant-creation")).createTenantCore
  const created = await provision(svc, {
    brokerageName: facts.brokerageName,
    adminEmail: facts.adminEmail,
    adminFirstName: facts.adminFirstName,
    adminLastName: facts.adminLastName,
    tier: facts.tier,
    brokeragePhone: facts.brokeragePhone,
    signupSource: input.actor.kind === "platform_staff" ? "superadmin" : "self_serve",
    billing: input.billing,
    callerUserId: input.actor.kind === "platform_staff" ? input.actor.userId : null,
    prospect: { prospectIds: [row.id], emails: [row.email], phone: row.phone },
  })
  if (!created.ok || !created.brokerageId || !created.userId) {
    return { ok: false, error: created.error ?? "Tenant creation failed" }
  }
  const brokerageId = created.brokerageId

  // Territory → the onboarding market SUGGESTION (the same billing_metadata
  // carry-bag /get-started uses for a searched zip; merge, never replace; no
  // market or claim is ever created from it).
  if (facts.territory) {
    const { data: bmRow, error: bmErr } = await svc.from("brokerages").select("billing_metadata").eq("id", brokerageId).maybeSingle()
    if (bmErr) console.warn("[prospect-conversion] billing_metadata read refused:", bmErr.message)
    else {
      const existing = (bmRow as { billing_metadata?: unknown } | null)?.billing_metadata
      const bm = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {}
      const intent = bm.signup_intent && typeof bm.signup_intent === "object" ? (bm.signup_intent as Record<string, unknown>) : {}
      const { error: bmWriteErr } = await svc.from("brokerages").update({
        billing_metadata: { ...bm, signup_intent: { ...intent, territory_text: facts.territory, captured_at: new Date().toISOString(), source: "platform_prospect_conversion" } },
        updated_at: new Date().toISOString(),
      }).eq("id", brokerageId)
      if (bmWriteErr) console.warn("[prospect-conversion] territory suggestion write refused:", bmWriteErr.message)
    }
  }

  // Demo close-out. A PENDING hold (the rep never confirmed) is released — the
  // prospect converted without it; a CONFIRMED demo stays on the calendar and
  // becomes the onboarding session (the ICS the customer already holds is
  // still right).
  let demoDisposition: DemoDisposition = "none"
  const demo = (row.details?.demo_appointment ?? null) as { calendar_event_id?: string; status?: string } | null
  if (demo?.calendar_event_id && demo.status === "pending_rep_confirmation") {
    // calendar_events carries NO updated_at column (scripts/schema-snapshot.ts
    // — the schema-drift guard caught the first draft naming one: PGRST204
    // refuses the WHOLE update, CLAUDE.md §3). Status only, counted.
    const { data: cancelled, error: cancelErr } = await svc.from("calendar_events")
      .update({ status: "cancelled" })
      .eq("id", demo.calendar_event_id).eq("event_type", "demo_appointment")
      .select("id")
    if (cancelErr) { console.warn("[prospect-conversion] demo hold release refused:", cancelErr.message); demoDisposition = "hold_release_failed" }
    else demoDisposition = ((cancelled ?? []) as unknown[]).length === 1 ? "hold_released" : "hold_release_failed"
  } else if (demo?.calendar_event_id && demo.status === "confirmed") {
    demoDisposition = "kept_as_onboarding"
  }

  // The white-glove task — ONLY when warranted. A platform_role staff bell
  // (never user_type='superadmin'), entity = the NEW BROKERAGE (the work is
  // on the tenant now, not the prospect row).
  let staffNotified = 0
  if (humanReasons.length > 0) {
    const notify = deps.notifyStaff ?? (async (client: any, n: Parameters<NonNullable<ConversionDeps["notifyStaff"]>>[1]) => {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      return notifyPlatformStaff(client as never, n)
    })
    staffNotified = await notify(svc, {
      type: "platform_subscriber_white_glove",
      title: "New subscriber needs a person",
      body: `${facts.brokerageName} (${facts.adminEmail}) just became a ${facts.tier.replace(/_/g, " ")} ${input.billing.mode === "trial" ? "trial" : input.billing.mode === "paid" ? "paid activation (checkout sent)" : "subscriber"}: ${humanReasons.map((r) => HUMAN_REASON_LABEL[r]).join("; ")}. See the tenant in the god console.`,
      entityType: "brokerage", entityId: brokerageId, priority: "high",
    }).catch((e: unknown) => { console.warn("[prospect-conversion] staff bell failed:", (e as Error)?.message); return 0 })
  }

  // The conversion record on the prospect row (details.conversion) + the demo
  // stamp — ONE stamp writer (lib/platform/prospect-capture.ts).
  const { markProspectConverted } = await import("@/lib/platform/prospect-capture")
  await markProspectConverted(svc, {
    prospectId: row.id, brokerageId,
    actorLabel: input.actor.kind === "platform_staff" ? `staff:${input.actor.email}` : `self:${input.actor.channel}`,
    billingMode: input.billing.mode, tier: facts.tier,
    humanReasons, staffNotified, demoDisposition,
  })

  // Audit — by name for staff, by channel for a self-conversion.
  const { error: auditErr } = await svc.from("superadmin_audit_log").insert({
    actor_user_id: input.actor.kind === "platform_staff" ? input.actor.userId : null,
    actor_email: input.actor.kind === "platform_staff" ? input.actor.email : `system:prospect_conversion:${input.actor.channel}`,
    action: "platform_prospect.converted_to_subscriber", target_type: "platform_prospect", target_id: row.id,
    details: {
      brokerage_id: brokerageId, tier: facts.tier, billing_mode: input.billing.mode, human_reasons: humanReasons, staff_notified: staffNotified, demo: demoDisposition, prospect_linked: created.prospectStamp?.linked ?? 0,
      // The money facts of a paid activation, on the same audit line: what the
      // checkout carries and whether staff waived the fee (the waiver itself
      // is a separate audited row, subscription.setup_fee_waived, by the core).
      ...(input.billing.mode === "paid" ? { checkout_created: !!created.checkoutUrl, checkout_error: created.checkoutError ?? null, setup_fee_cents: created.setupFeeCents ?? null, setup_fee_waived: created.setupFeeWaived === true } : {}),
    },
  })
  if (auditErr) console.warn("[prospect-conversion] audit insert refused:", auditErr.message)

  return {
    ok: true, alreadyConverted: false,
    brokerageId, userId: created.userId, tier: facts.tier,
    inviteSent: created.inviteSent === true, inviteError: created.inviteError,
    trialEndsAt: created.trialEndsAt ?? null,
    checkoutUrl: created.checkoutUrl ?? null, checkoutError: created.checkoutError,
    setupFeeCents: created.setupFeeCents ?? null, setupFeeWaived: created.setupFeeWaived === true,
    humanReasons, staffNotified, demoDisposition,
    prospectLinked: created.prospectStamp?.linked ?? 0,
  }
}
