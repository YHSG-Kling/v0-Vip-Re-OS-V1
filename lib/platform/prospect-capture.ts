// lib/platform/prospect-capture.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE platform_prospects WRITER (lane 76B — owner verbatim, wave 76: "need
// to be sure the platform 'potential' customers are being saved/created as
// 'potential' subscribers and if they do decide to setup a demo or want to
// purchase a subscription we have a way for the agents to create a demo
// appointment or given a way to either sign up online or with a human.").
//
// Before this lane three surfaces each spelled their own upsert:
//   · lib/voice/platform-reception.ts::capturePhoneProspect  (email, else phone)
//   · app/actions/superadmin/platform-growth.ts::capturePlatformProspectAction
//     (email only — a phone-only caller could never be matched by the web form)
//   · app/actions/superadmin/platform-growth.ts::requestPlatformDemoAction
//     (email + a details merge the other two did not do, so a phone caller's
//     later web demo request could clobber nothing and merge nothing)
// Three writers, three merge rules (CLAUDE.md §6). This module is the SURVIVOR
// all three now delegate to — tombstones at each caller. It also owns the
// OUTCOME stamps (demo scheduled / signup link sent / human handoff) so every
// exit the AI agent offers lands on the SAME row the follow-up sweep and the
// growth board read.
//
// IDENTITY: a platform prospect is NOT a contact and NOT a lead — its id never
// flows into a contactId/leadId slot anywhere (dispatch, calendar_events
// entity fields, activities). The demo appointment carries
// entity_type='platform_prospect' for exactly that reason.
//
// KEYS (in order): prospectId (a row the caller already resolved server-side —
// platform_reception_calls.prospect_id) → email (the web idempotency key,
// UNIQUE) → phone (caller-ID; unique index, l32-s01) → insert. A repeat
// hand-raise UPDATES, never duplicates, and never clobbers a known fact with a
// null (a phone caller who gave no company keeps the company the web form had).

import { PROSPECT_ROLES, PROSPECT_STATUSES, type ProspectStatus } from "@/lib/platform/growth-funnel"

/** Timeline buckets — the SAME spelling as the live contacts/leads timeline
 *  CHECK (scripts/check-vocabularies.ts: 1-3_months / 3-6_months / 6-12_months …,
 *  CLAUDE.md §5: buckets, never 30/60/90). One vocabulary across tenant and
 *  platform qualification. */
export const PROSPECT_TIMELINE_BUCKETS = [
  "immediate", "1-3_months", "3-6_months", "6-12_months", "12+_months", "researching",
] as const
export type ProspectTimelineBucket = (typeof PROSPECT_TIMELINE_BUCKETS)[number]

/** What the AI agent learns about a PLATFORM prospect (the software buyer's
 *  qualification — not a home buyer's). Stored under details.qualification. */
export interface ProspectQualification {
  brokerage_name?: string | null
  /** Seats / agent count they run. */
  size_seats?: number | null
  /** Lane 79B — of those, the PRODUCING agents (wave 79 seat ruling: the
   *  priced unit; staff/admin seats ride free). */
  producers_count?: number | null
  /** Their role at the business (broker-owner, team lead, ops, agent …). */
  role_title?: string | null
  current_tools?: string | null
  pain?: string | null
  timeline?: ProspectTimelineBucket | null
  /** Markets / territory they work. */
  territory?: string | null
  /** Lane 79B — "what would be most helpful next", in the prospect's own choice. */
  preferred_path?: ProspectPreferredPath | null
}

/** Lane 79B — the prospect's own "what next" choice (never a forced one). */
export const PROSPECT_PREFERRED_PATHS = ["demo", "trial", "paid", "callback", "undecided"] as const
export type ProspectPreferredPath = (typeof PROSPECT_PREFERRED_PATHS)[number]

export interface UpsertPlatformProspectInput {
  prospectId?: string | null
  email?: string | null
  phone?: string | null
  name?: string | null
  company?: string | null
  roleInterest?: string | null
  /** Channel attribution — 'phone:reception', 'web:prospect_chat', 'demo_request', 'get_started', … */
  source: string
  note?: string | null
  qualification?: ProspectQualification | null
  /** Extra details keys to MERGE (never replace) — e.g. demo_request. */
  detailsPatch?: Record<string, unknown> | null
}

export interface UpsertPlatformProspectResult {
  id: string
  created: boolean
  email: string | null
  phone: string | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** PURE: normalize an email key (lowercase, trimmed) or null when invalid. */
export function normalizeProspectEmail(email: string | null | undefined): string | null {
  const v = (email ?? "").trim().toLowerCase()
  return EMAIL_RE.test(v) ? v.slice(0, 200) : null
}

/** PURE: normalize a qualification blob — drops empty strings, clamps the
 *  timeline to the bucket vocabulary (an off-vocabulary timeline is dropped,
 *  never stored as a seventh spelling). */
export function normalizeProspectQualification(q: ProspectQualification | null | undefined): ProspectQualification {
  if (!q) return {}
  const out: ProspectQualification = {}
  const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)
  if (str(q.brokerage_name)) out.brokerage_name = str(q.brokerage_name, 160)
  if (typeof q.size_seats === "number" && Number.isFinite(q.size_seats) && q.size_seats > 0) out.size_seats = Math.round(q.size_seats)
  if (typeof q.producers_count === "number" && Number.isFinite(q.producers_count) && q.producers_count > 0) out.producers_count = Math.round(q.producers_count)
  if (q.preferred_path && (PROSPECT_PREFERRED_PATHS as readonly string[]).includes(q.preferred_path)) out.preferred_path = q.preferred_path
  if (str(q.role_title)) out.role_title = str(q.role_title, 120)
  if (str(q.current_tools)) out.current_tools = str(q.current_tools)
  if (str(q.pain)) out.pain = str(q.pain, 600)
  if (q.timeline && (PROSPECT_TIMELINE_BUCKETS as readonly string[]).includes(q.timeline)) out.timeline = q.timeline
  if (str(q.territory)) out.territory = str(q.territory)
  return out
}

/** PURE: the column patch — only fields the caller actually gave, so a repeat
 *  touch never nulls a known fact. */
export function buildProspectColumnPatch(input: UpsertPlatformProspectInput): Record<string, unknown> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.name?.trim()) patch.name = input.name.trim().slice(0, 120)
  if (input.company?.trim()) patch.company = input.company.trim().slice(0, 160)
  const role = (input.roleInterest ?? "").trim()
  if (role && (PROSPECT_ROLES as readonly string[]).includes(role)) patch.role_interest = role
  if (input.note?.trim()) patch.interest_note = input.note.trim().slice(0, 600)
  if (input.source?.trim()) patch.source = input.source.trim().slice(0, 80)
  return patch
}

/** PURE: merge details — existing keys survive; qualification merges key-wise. */
export function mergeProspectDetails(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
  qualification: ProspectQualification | null | undefined,
): Record<string, unknown> {
  const base = { ...(existing ?? {}) }
  const merged: Record<string, unknown> = { ...base, ...(patch ?? {}) }
  const q = normalizeProspectQualification(qualification)
  if (Object.keys(q).length > 0) {
    merged.qualification = { ...((base.qualification as Record<string, unknown>) ?? {}), ...q }
  }
  return merged
}

interface ExistingProspectRow { id: string; email: string | null; phone: string | null; details: Record<string, unknown> | null }

/** First key that finds a row wins (id → email → phone); a refused read is
 *  logged and the next key is tried — never silently treated as "no row". */
async function findExistingProspect(svc: any, lookups: Array<[string, string]>): Promise<ExistingProspectRow | null> {
  for (const [col, val] of lookups) {
    const { data, error } = await svc.from("platform_prospects")
      .select("id, email, phone, details").eq(col, val).maybeSingle()
    if (error) { console.error(`[prospect-capture] read by ${col} refused:`, error.message); continue }
    if (data) return data as ExistingProspectRow
  }
  return null
}

/**
 * Upsert a platform prospect. Every read/write destructures `{ data, error }`
 * and reads the error (CLAUDE.md §3 — supabase-js RESOLVES refusals). Returns
 * null only when the row could neither be found nor created.
 */
export async function upsertPlatformProspect(svc: any, input: UpsertPlatformProspectInput): Promise<UpsertPlatformProspectResult | null> {
  const email = normalizeProspectEmail(input.email)
  const phone = (input.phone ?? "").trim().slice(0, 30) || null
  if (!input.prospectId && !email && !phone) return null

  // ── 1) find the existing row: id → email → phone ──────────────────────────
  const lookups: Array<[string, string]> = []
  if (input.prospectId) lookups.push(["id", input.prospectId])
  if (email) lookups.push(["email", email])
  if (phone) lookups.push(["phone", phone])
  const existing = await findExistingProspect(svc, lookups)

  const columns = buildProspectColumnPatch(input)

  if (existing) {
    // First-touch attribution survives: `source` is set on insert only, so a
    // web signer who later phones in still reports the channel that found them.
    const { source: _firstTouchSource, ...repeatTouchColumns } = columns
    void _firstTouchSource
    const patch: Record<string, unknown> = {
      ...repeatTouchColumns,
      details: mergeProspectDetails(existing.details, input.detailsPatch, input.qualification),
    }
    // Fill an identity the row was missing (a phone caller who now gave their
    // email, or a web signer who later called in). Never overwrite a present
    // one — the unique indexes make a collision a different row, not a merge.
    if (email && !existing.email) patch.email = email
    if (phone && !existing.phone) patch.phone = phone
    const { data, error } = await svc.from("platform_prospects").update(patch).eq("id", existing.id).select("id, email, phone")
    if (error) {
      console.error("[prospect-capture] update refused:", error.message)
      return { id: existing.id, created: false, email: existing.email, phone: existing.phone }
    }
    const row = ((data ?? []) as Array<{ id: string; email: string | null; phone: string | null }>)[0]
    return { id: existing.id, created: false, email: row?.email ?? existing.email, phone: row?.phone ?? existing.phone }
  }

  // ── 2) insert ─────────────────────────────────────────────────────────────
  const { data, error } = await svc.from("platform_prospects").insert({
    email, phone,
    role_interest: (columns.role_interest as string | undefined) ?? "unknown",
    source: (columns.source as string | undefined) ?? "organic",
    name: (columns.name as string | undefined) ?? null,
    company: (columns.company as string | undefined) ?? null,
    interest_note: (columns.interest_note as string | undefined) ?? null,
    details: mergeProspectDetails(null, input.detailsPatch, input.qualification),
    updated_at: columns.updated_at,
  }).select("id, email, phone").single()
  if (error || !data) {
    console.error("[prospect-capture] insert refused:", error?.message ?? "no row")
    return null
  }
  const row = data as { id: string; email: string | null; phone: string | null }
  return { id: row.id, created: true, email: row.email, phone: row.phone }
}

// ── OUTCOME STAMPS — the three exits, on the SAME row ───────────────────────

/** details.demo_appointment shape (also what the growth board renders). */
export interface ProspectDemoStamp {
  calendar_event_id: string
  start_at: string
  end_at: string
  rep_user_id: string
  status: "pending_rep_confirmation" | "confirmed" | "cancelled"
  booked_at: string
  confirmed_at?: string | null
}

/** Advance status only FORWARD along PROSPECT_STATUSES (a 'trial' row that
 *  books a demo keeps 'trial'). PURE. */
export function advanceProspectStatus(current: string | null | undefined, target: ProspectStatus): ProspectStatus {
  const order = PROSPECT_STATUSES as readonly string[]
  const cur = current && order.includes(current) ? current : "new"
  if (cur === "lost") return "lost"
  return order.indexOf(cur) >= order.indexOf(target) ? (cur as ProspectStatus) : target
}

async function readProspectForStamp(svc: any, prospectId: string): Promise<{ status: string | null; details: Record<string, unknown> | null } | null> {
  const { data, error } = await svc.from("platform_prospects").select("status, details").eq("id", prospectId).maybeSingle()
  if (error) { console.error("[prospect-capture] stamp read refused:", error.message); return null }
  return (data as { status: string | null; details: Record<string, unknown> | null } | null) ?? null
}

/** COUNTED update (§3): returns true only when exactly this row was written. */
async function stampProspect(svc: any, prospectId: string, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await svc.from("platform_prospects")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", prospectId).select("id")
  if (error) { console.error("[prospect-capture] stamp refused:", error.message); return false }
  return ((data ?? []) as unknown[]).length === 1
}

/** A demo was booked (pending the rep's confirmation) → status 'demo_scheduled'
 *  (m654) + details.demo_appointment. The follow-up sweep never reads that
 *  status, so cold nudges stop here; the reminder cadence takes over. */
export async function markProspectDemoScheduled(svc: any, input: {
  prospectId: string; calendarEventId: string; startAt: string; endAt: string; repUserId: string
}): Promise<boolean> {
  const row = await readProspectForStamp(svc, input.prospectId)
  if (!row) return false
  const stamp: ProspectDemoStamp = {
    calendar_event_id: input.calendarEventId, start_at: input.startAt, end_at: input.endAt,
    rep_user_id: input.repUserId, status: "pending_rep_confirmation", booked_at: new Date().toISOString(),
  }
  return stampProspect(svc, input.prospectId, {
    status: advanceProspectStatus(row.status, "demo_scheduled"),
    details: { ...(row.details ?? {}), demo_appointment: stamp },
  })
}

/** The rep confirmed → details.demo_appointment.status 'confirmed'. */
export async function markProspectDemoConfirmed(svc: any, input: { prospectId: string; calendarEventId: string }): Promise<boolean> {
  const row = await readProspectForStamp(svc, input.prospectId)
  if (!row) return false
  const current = (row.details?.demo_appointment as ProspectDemoStamp | undefined) ?? null
  if (!current || current.calendar_event_id !== input.calendarEventId) return false
  return stampProspect(svc, input.prospectId, {
    details: { ...(row.details ?? {}), demo_appointment: { ...current, status: "confirmed", confirmed_at: new Date().toISOString() } },
  })
}

/** A signup link went out → details.signup_link (channel + url + when). */
export async function markProspectSignupLinkSent(svc: any, input: { prospectId: string; channel: "sms" | "email"; url: string }): Promise<boolean> {
  const row = await readProspectForStamp(svc, input.prospectId)
  if (!row) return false
  return stampProspect(svc, input.prospectId, {
    status: advanceProspectStatus(row.status, "contacted"),
    contacted_at: new Date().toISOString(),
    details: { ...(row.details ?? {}), signup_link: { channel: input.channel, url: input.url, sent_at: new Date().toISOString() } },
  })
}

/** details.human_handoff shape. */
export interface ProspectHandoffStamp {
  requested_at: string
  reason: string | null
  best_time: string | null
  channel: string
  status: "open" | "done"
  staff_notified: number
}

/** The prospect asked for a HUMAN → details.human_handoff (open) + status at
 *  least 'contacted'. The follow-up sweep filters `details->human_handoff IS
 *  NULL`, so an open handoff silences the cold ladder while a person works it. */
export async function markProspectHandoff(svc: any, input: {
  prospectId: string; reason?: string | null; bestTime?: string | null; channel: string; staffNotified: number
}): Promise<boolean> {
  const row = await readProspectForStamp(svc, input.prospectId)
  if (!row) return false
  const stamp: ProspectHandoffStamp = {
    requested_at: new Date().toISOString(),
    reason: (input.reason ?? "").trim().slice(0, 300) || null,
    best_time: (input.bestTime ?? "").trim().slice(0, 120) || null,
    channel: input.channel, status: "open", staff_notified: input.staffNotified,
  }
  return stampProspect(svc, input.prospectId, {
    status: advanceProspectStatus(row.status, "contacted"),
    contacted_at: new Date().toISOString(),
    details: { ...(row.details ?? {}), human_handoff: stamp },
  })
}

/** Lane 79B — details.callback: the prospect asked to be called back when
 *  THEY are ready. Read by lib/platform/prospect-followup.ts (both rungs
 *  stand down while it is set) and the growth board. */
export interface ProspectCallbackStamp {
  requested_at: string
  /** When they said, in their words ("after Q1", "next Tuesday morning"). */
  when: string | null
  reason: string | null
  channel: string
}

export async function markProspectCallback(svc: any, input: {
  prospectId: string; when?: string | null; reason?: string | null; channel: string
}): Promise<boolean> {
  const row = await readProspectForStamp(svc, input.prospectId)
  if (!row) return false
  const stamp: ProspectCallbackStamp = {
    requested_at: new Date().toISOString(),
    when: (input.when ?? "").trim().slice(0, 120) || null,
    reason: (input.reason ?? "").trim().slice(0, 300) || null,
    channel: input.channel,
  }
  return stampProspect(svc, input.prospectId, {
    status: advanceProspectStatus(row.status, "contacted"),
    contacted_at: new Date().toISOString(),
    details: { ...(row.details ?? {}), callback: stamp },
  })
}

/** details.conversion shape (lane 77B) — the moment a prospect became a
 *  subscriber, as the growth board reads it. status + converted_brokerage_id
 *  themselves are written by lib/platform/prospect-conversion.ts::
 *  stampProspectConversion (called by the tenant-creation core); this is the
 *  narrative half beside it. */
export interface ProspectConversionStamp {
  converted_at: string
  brokerage_id: string
  /** "staff:<email>" or "self:<channel>" — who said yes / who clicked. */
  actor: string
  /** trial · paid (wave 78A — checkout with the setup fee, access on payment) · active (staff-invoiced) */
  billing_mode: "trial" | "paid" | "active"
  tier: string
  human_reasons: string[]
  staff_notified: number
  demo: "none" | "hold_released" | "hold_release_failed" | "kept_as_onboarding"
}

/** The prospect became a subscriber → details.conversion, an OPEN human
 *  handoff is closed (a person is now on the tenant, not the prospect), and
 *  the demo stamp records what happened to the hold. Status is NOT touched
 *  here — stampProspectConversion owns it. */
export async function markProspectConverted(svc: any, input: {
  prospectId: string; brokerageId: string; actorLabel: string
  /** trial (no card) · paid (checkout with the setup fee, access on payment) ·
   *  active (staff-provisioned, invoiced outside checkout) */
  billingMode: "trial" | "paid" | "active"; tier: string
  humanReasons: string[]; staffNotified: number
  demoDisposition: ProspectConversionStamp["demo"]
}): Promise<boolean> {
  const row = await readProspectForStamp(svc, input.prospectId)
  if (!row) return false
  const details: Record<string, unknown> = { ...(row.details ?? {}) }
  const conversion: ProspectConversionStamp = {
    converted_at: new Date().toISOString(), brokerage_id: input.brokerageId, actor: input.actorLabel,
    billing_mode: input.billingMode, tier: input.tier, human_reasons: input.humanReasons,
    staff_notified: input.staffNotified, demo: input.demoDisposition,
  }
  details.conversion = conversion
  const handoff = details.human_handoff as ProspectHandoffStamp | undefined
  if (handoff && handoff.status === "open") details.human_handoff = { ...handoff, status: "done" }
  const demo = details.demo_appointment as ProspectDemoStamp | undefined
  if (demo && input.demoDisposition === "hold_released") details.demo_appointment = { ...demo, status: "cancelled" }
  return stampProspect(svc, input.prospectId, { details })
}
