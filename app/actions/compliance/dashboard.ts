"use server"

/**
 * Broker / compliance_manager / compliance_officer / TC dashboard data layer.
 *
 * Returns everything the compliance dashboard surfaces:
 *   - Open compliance flags across all the brokerage's deals
 *   - Offers where required-docs audit currently has blocking misses
 *   - Offers where the packet scanner reported blockers
 *   - "Ready for compliance" queue (offers with ready_for_compliance_at IS NOT NULL
 *     but compliance_passed_at IS NULL — agent has submitted, awaiting TC review)
 *   - Recent EM-receipt + deadline issues
 *
 * Access: caller's CANONICAL role must be one of {broker, admin, superadmin,
 * compliance_officer, tc} in the brokerage. Legacy spellings (broker_admin,
 * compliance_manager, TC, transaction_coordinator) resolve through
 * toCanonicalRole rather than being listed here.
 *
 * ── THE CLOSED LOOP ──────────────────────────────────────────────────────────
 * This surface reads `status='open'`, so a flag that closes drops out of the
 * queue on its own. That was only ever half of honest: nothing could close one,
 * so the queue was write-only and its count meant "everything ever flagged",
 * not "everything still outstanding".
 *
 * Now that lib/compliance/offer-flag-resolution.ts can close them, this file
 * also reports the CLEARED side — who cleared what, when, and why — so the loop
 * is visible rather than items merely vanishing, and it exposes
 * `resolveComplianceFlagAction` so a compliance officer or TC can clear a flag
 * they have satisfied by hand.
 *
 * Clearing a flag is NOT a way past the gate. `submitOfferToCompliance` re-runs
 * the required-documents audit and the packet scan from scratch on every attempt
 * and never consults this ledger; the flags are the WORK QUEUE the owner's step 4
 * describes ("the missing piece is sent to the tc and agent"), not the gate's
 * evidence. A flag cleared without the fix simply comes back on the next submit.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { toCanonicalRole, type CanonicalRole } from "@/lib/security/types"
import {
  OFFER_COMPLIANCE_FLAG_EVENT,
  FLAG_STATUS_OPEN,
  FLAG_STATUS_RESOLVED,
  complianceFlagKey,
  resolveOfferComplianceFlags,
} from "@/lib/compliance/offer-flag-resolution"

export interface DashboardItem {
  kind:           "flag" | "missing_required" | "packet_blocker" | "awaiting_review" | "em_receipt"
  offer_id:       string | null
  transaction_id: string | null
  contact_id:     string | null
  title:          string
  detail:         string
  severity:       "low" | "medium" | "high" | "critical"
  raised_at:      string
  /** Present on `kind:'flag'` only — the stable identity of the miss, and the
   *  handle resolveComplianceFlagAction takes. */
  flag_key:       string | null
  /** How many resubmissions this same miss has survived (0 = raised once). */
  reflag_count:   number
}

/** A flag that has been CLEARED — the visible other half of the loop. */
export interface ResolvedFlagItem {
  offer_id:    string | null
  contact_id:  string | null
  title:       string
  reason:      string
  resolved_at: string
  /** users.id of whoever cleared it, resolved to a display name when available. */
  resolved_by: string | null
  resolved_by_name: string | null
}

export interface ComplianceDashboard {
  brokerage_id:    string
  generated_at:    string
  totals: {
    open_flags:       number
    awaiting_review:  number
    missing_required: number
    /** Flags cleared in the last 7 days. */
    cleared_recent:   number
  }
  items: DashboardItem[]
  recently_cleared: ResolvedFlagItem[]
  error?: string
}

// CANONICAL roles. The raw user_type is canonicalized before the check rather
// than this list being widened to every spelling — the previous list carried
// "TC", and live rows store 'tc' (the CHECK does not even permit 'TC'), so a
// transaction coordinator was refused their own compliance dashboard. It also
// listed broker_admin and compliance_manager, which are legacy aliases, not
// legal user_type values; toCanonicalRole maps both.
// SCOPE LADDER (kept inline — admits tc/compliance_officer): 'superadmin'
// removed. It is compared against toCanonicalRole(users.user_type), and the
// only raw spellings that canonicalize to it ('superadmin'/'super_admin') are
// stored by 0 live rows — the platform superadmin is user_type='admin' and is
// admitted via 'admin'. (broker_owner canonicalizes to 'broker', so it already passes.)
const ACCESS_ROLES: CanonicalRole[] = [
  "broker", "admin", "compliance_officer", "tc",
]

/** Not exported — a "use server" module may only export async functions. */
function emptyDashboard(brokerageId: string, error: string): ComplianceDashboard {
  return {
    brokerage_id: brokerageId,
    generated_at: new Date().toISOString(),
    totals: { open_flags: 0, awaiting_review: 0, missing_required: 0, cleared_recent: 0 },
    items: [],
    recently_cleared: [],
    error,
  }
}

export async function getComplianceDashboard(): Promise<ComplianceDashboard> {
  const supabase = await createClient()

  // Auth + role gate
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return emptyDashboard("", "Unauthorized")
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return emptyDashboard("", "No brokerage")
  const callerRole = toCanonicalRole(profile.user_type as string | null)
  if (!callerRole || !ACCESS_ROLES.includes(callerRole)) {
    return emptyDashboard(profile.brokerage_id as string, "Not authorized for compliance dashboard")
  }

  const brokerageId = profile.brokerage_id as string
  const items: DashboardItem[] = []

  // 1) Open compliance flag activities (last 30 days, status='open').
  //
  // STILL `status='open'`, and that filter is now load-bearing rather than
  // decorative: a flag cleared by resolveOfferComplianceFlags flips to 'resolved'
  // and leaves this list on the next read, so "open flags" finally means
  // outstanding work instead of everything ever raised.
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const { data: flags, error: flagsError } = await supabase
    .from("activities")
    .select("id, title, description, notes, metadata, priority, created_at, contact_id")
    .eq("brokerage_id", brokerageId)
    .eq("activity_type", OFFER_COMPLIANCE_FLAG_EVENT)
    .eq("status", FLAG_STATUS_OPEN)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(100)

  // Pre-rollout these tables are EMPTY, so an empty list can never be read as
  // health — but a REFUSED read rendering as "no compliance items right now" is a
  // different and worse lie, and supabase-js resolves it identically.
  if (flagsError) {
    return emptyDashboard(brokerageId, `Could not read the compliance flag ledger: ${flagsError.message}`)
  }

  for (const f of flags ?? []) {
    let parsedNotes: any = {}
    try { parsedNotes = f.notes ? JSON.parse(f.notes) : {} } catch { /* ignore */ }
    const meta = (f.metadata ?? {}) as Record<string, any>
    const offerId = (parsedNotes.offer_id ?? meta.offer_id) ?? null
    const severityRaw = String(meta.severity ?? f.priority ?? "medium").toLowerCase()
    const severity: DashboardItem["severity"] =
      severityRaw === "critical" ? "critical"
      : severityRaw === "high"   ? "high"
      : severityRaw === "low"    ? "low" : "medium"
    items.push({
      kind:          "flag",
      offer_id:       offerId,
      transaction_id: null,
      // flag-compliance.ts populates activities.contact_id from the OFFER row, so
      // the "open offer" deep link has the contact segment it needs. It used to be
      // hardcoded null, which rendered /crm/contacts//offers/<id> — a dead link.
      contact_id:     (f.contact_id as string | null) ?? null,
      title:          String(f.title ?? "Compliance flag"),
      detail:         String(f.description ?? ""),
      severity,
      raised_at:      f.created_at as string,
      // Rows written before flag_key existed are recomputed from the same pure
      // function the writer uses, so the resolve control works on legacy flags too.
      flag_key:       typeof meta.flag_key === "string" && meta.flag_key
                        ? meta.flag_key
                        : complianceFlagKey({ flagType: meta.flagType, title: f.title as string | null }),
      reflag_count:   Number(meta.reflag_count ?? 0),
    })
  }

  // 2) Offers awaiting compliance review (agent submitted, TC hasn't approved)
  const { data: awaiting } = await supabase
    .from("offers")
    .select("id, contact_id, transaction_id, property_address, ready_for_compliance_at")
    .eq("brokerage_id", brokerageId)
    .not("ready_for_compliance_at", "is", null)
    .is("compliance_passed_at", null)
    .order("ready_for_compliance_at", { ascending: false })
    .limit(50)
  for (const o of awaiting ?? []) {
    items.push({
      kind:           "awaiting_review",
      offer_id:       o.id as string,
      transaction_id: (o.transaction_id as string | null) ?? null,
      contact_id:     (o.contact_id as string | null) ?? null,
      title:          `Awaiting TC review: ${o.property_address ?? "offer"}`,
      detail:         `Agent submitted to compliance. Confirm executed contract is on file + advance.`,
      severity:       "medium",
      raised_at:      o.ready_for_compliance_at as string,
      flag_key:       null,
      reflag_count:   0,
    })
  }

  // 3) EM-receipt watcher findings — offers past contract day 3 with no receipt
  // (the cron flags these as activities; we surface them here too for visibility)
  const emCutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  const { data: emCandidates } = await supabase
    .from("offers")
    .select("id, contact_id, transaction_id, property_address, earnest_money, compliance_passed_at")
    .eq("brokerage_id", brokerageId)
    .eq("status", "accepted")
    .not("compliance_passed_at", "is", null)
    .lte("compliance_passed_at", emCutoff)
    .not("transaction_id", "is", null)
    .limit(50)
  for (const o of emCandidates ?? []) {
    // Skip when receipt is on file
    const { count } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("classification", "earnest_money_receipt")
      .or(`contact_id.eq.${o.contact_id},metadata->>linked_offer_id.eq.${o.id}`)
    if ((count ?? 0) > 0) continue
    items.push({
      kind:           "em_receipt",
      offer_id:       o.id as string,
      transaction_id: (o.transaction_id as string | null) ?? null,
      contact_id:     (o.contact_id as string | null) ?? null,
      title:          `Earnest money receipt missing: ${o.property_address ?? "offer"}`,
      detail:         `Offer accepted ${o.compliance_passed_at?.slice(0, 10)}, no earnest_money_receipt on file.`,
      severity:       "high",
      raised_at:      o.compliance_passed_at as string,
      flag_key:       null,
      reflag_count:   0,
    })
  }

  // 4) THE CLOSED HALF — flags cleared in the last 7 days, with WHO and WHEN.
  //    Without this the loop closes invisibly: items would simply stop appearing
  //    and a TC could not tell "the document arrived" from "the queue is broken".
  const clearedCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const recently_cleared: ResolvedFlagItem[] = []
  const { data: cleared, error: clearedError } = await supabase
    .from("activities")
    .select("title, metadata, completed_at, updated_at, contact_id")
    .eq("brokerage_id", brokerageId)
    .eq("activity_type", OFFER_COMPLIANCE_FLAG_EVENT)
    .eq("status", FLAG_STATUS_RESOLVED)
    .gte("completed_at", clearedCutoff)
    .order("completed_at", { ascending: false })
    .limit(50)
  if (clearedError) {
    console.error("[compliance-dashboard] cleared-flag read failed:", clearedError.message)
  }

  // Resolve the actors to names in ONE query — users.id, never agents.id.
  const actorIds = Array.from(new Set(
    (cleared ?? [])
      .map(c => (c.metadata as any)?.resolved_by)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  ))
  const actorNames = new Map<string, string>()
  if (actorIds.length > 0) {
    // `users` has first_name / last_name / email — there is no full_name column.
    const { data: actors, error: actorsError } = await supabase
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", actorIds)
    if (actorsError) {
      console.error("[compliance-dashboard] actor name lookup failed:", actorsError.message)
    }
    for (const a of actors ?? []) {
      const named = [a.first_name, a.last_name].filter(Boolean).join(" ").trim()
      const label = named || (a.email as string | null) || null
      if (a.id && label) actorNames.set(a.id as string, label)
    }
  }

  for (const c of cleared ?? []) {
    const meta = (c.metadata ?? {}) as Record<string, any>
    const by = typeof meta.resolved_by === "string" ? meta.resolved_by : null
    recently_cleared.push({
      offer_id:    (meta.offer_id as string | null) ?? null,
      contact_id:  (c.contact_id as string | null) ?? null,
      title:       String(c.title ?? "Compliance flag"),
      reason:      String(meta.resolution_reason ?? "Cleared"),
      resolved_at: String(meta.resolved_at ?? c.completed_at ?? c.updated_at ?? ""),
      resolved_by: by,
      resolved_by_name: by ? (actorNames.get(by) ?? null) : null,
    })
  }

  return {
    brokerage_id: brokerageId,
    generated_at: new Date().toISOString(),
    totals: {
      open_flags:       items.filter(i => i.kind === "flag").length,
      awaiting_review:  items.filter(i => i.kind === "awaiting_review").length,
      missing_required: items.filter(i => i.kind === "em_receipt").length,
      cleared_recent:   recently_cleared.length,
    },
    items,
    recently_cleared,
  }
}

export interface ResolveComplianceFlagResult {
  success: boolean
  resolved_count: number
  error?: string
}

/**
 * Clear one compliance flag by its stable key, on behalf of the signed-in
 * compliance officer / TC / broker.
 *
 * This is the human half of the owner's step 4: the TC chased the missing piece,
 * saw it land, and marks the item satisfied. The automated half —
 * a passing submit sweeping the whole set — is the same underlying resolver,
 * called from the submit path.
 *
 * TENANT + ROLE are both re-checked here rather than trusted from the page: every
 * export of a "use server" module is an RPC endpoint any authenticated session
 * can call. The offer is re-read to confirm it belongs to the caller's brokerage
 * before the service client (RLS bypassed) touches anything.
 */
export async function resolveComplianceFlagAction(params: {
  offerId: string
  flagKey: string
  note?: string
}): Promise<ResolveComplianceFlagResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, resolved_count: 0, error: "Unauthorized" }

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return { success: false, resolved_count: 0, error: "No brokerage" }

  const callerRole = toCanonicalRole(profile.user_type as string | null)
  if (!callerRole || !ACCESS_ROLES.includes(callerRole)) {
    return { success: false, resolved_count: 0, error: "Not authorized to clear compliance flags" }
  }

  if (!params.flagKey) return { success: false, resolved_count: 0, error: "Missing flag key" }

  const brokerageId = profile.brokerage_id as string

  // The offer must be IN this brokerage. `error` is destructured because
  // supabase-js resolves a refused read, and "refused" must not render as
  // "no such offer" on a path that is about to bypass RLS.
  const svc = createServiceClient()
  const { data: offer, error: offerError } = await svc
    .from("offers")
    .select("id, brokerage_id")
    .eq("id", params.offerId)
    .maybeSingle()
  if (offerError) return { success: false, resolved_count: 0, error: `Could not read the offer: ${offerError.message}` }
  if (!offer) return { success: false, resolved_count: 0, error: "Offer not found" }
  if (offer.brokerage_id !== brokerageId) return { success: false, resolved_count: 0, error: "Forbidden" }

  const result = await resolveOfferComplianceFlags({
    offerId:     params.offerId,
    brokerageId,
    actorUserId: user.id,
    reason:      params.note?.trim()
      ? `Cleared by ${callerRole}: ${params.note.trim()}`
      : `Cleared by ${callerRole} from the compliance queue — the missing piece was supplied.`,
    flagKeys:    [params.flagKey],
    client:      svc,
  })

  if (!result.success) {
    return { success: false, resolved_count: result.resolved_count, error: result.error }
  }

  revalidatePath("/dashboard/compliance/queue")
  return { success: true, resolved_count: result.resolved_count }
}
