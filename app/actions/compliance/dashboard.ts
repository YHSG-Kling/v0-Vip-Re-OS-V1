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
 */

import { createClient } from "@/lib/supabase/server"
import { toCanonicalRole, type CanonicalRole } from "@/lib/security/types"

export interface DashboardItem {
  kind:           "flag" | "missing_required" | "packet_blocker" | "awaiting_review" | "em_receipt"
  offer_id:       string | null
  transaction_id: string | null
  contact_id:     string | null
  title:          string
  detail:         string
  severity:       "low" | "medium" | "high" | "critical"
  raised_at:      string
}

export interface ComplianceDashboard {
  brokerage_id:    string
  generated_at:    string
  totals: {
    open_flags:       number
    awaiting_review:  number
    missing_required: number
  }
  items: DashboardItem[]
  error?: string
}

// CANONICAL roles. The raw user_type is canonicalized before the check rather
// than this list being widened to every spelling — the previous list carried
// "TC", and live rows store 'tc' (the CHECK does not even permit 'TC'), so a
// transaction coordinator was refused their own compliance dashboard. It also
// listed broker_admin and compliance_manager, which are legacy aliases, not
// legal user_type values; toCanonicalRole maps both.
const ACCESS_ROLES: CanonicalRole[] = [
  "broker", "admin", "superadmin", "compliance_officer", "tc",
]

export async function getComplianceDashboard(): Promise<ComplianceDashboard> {
  const supabase = await createClient()

  // Auth + role gate
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { brokerage_id: "", generated_at: new Date().toISOString(), totals: { open_flags: 0, awaiting_review: 0, missing_required: 0 }, items: [], error: "Unauthorized" }
  }
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) {
    return { brokerage_id: "", generated_at: new Date().toISOString(), totals: { open_flags: 0, awaiting_review: 0, missing_required: 0 }, items: [], error: "No brokerage" }
  }
  const callerRole = toCanonicalRole(profile.user_type as string | null)
  if (!callerRole || !ACCESS_ROLES.includes(callerRole)) {
    return { brokerage_id: profile.brokerage_id as string, generated_at: new Date().toISOString(), totals: { open_flags: 0, awaiting_review: 0, missing_required: 0 }, items: [], error: "Not authorized for compliance dashboard" }
  }

  const brokerageId = profile.brokerage_id as string
  const items: DashboardItem[] = []

  // 1) Open compliance flag activities (last 30 days, status='open')
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const { data: flags } = await supabase
    .from("activities")
    .select("title, description, notes, metadata, priority, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("activity_type", "buyer.offer.compliance.flagged")
    .eq("status", "open")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(100)

  for (const f of flags ?? []) {
    let parsedNotes: any = {}
    try { parsedNotes = f.notes ? JSON.parse(f.notes) : {} } catch { /* ignore */ }
    const offerId = (parsedNotes.offer_id ?? (f.metadata as any)?.offer_id) ?? null
    const severityRaw = String((f.metadata as any)?.severity ?? f.priority ?? "medium").toLowerCase()
    const severity: DashboardItem["severity"] =
      severityRaw === "critical" ? "critical"
      : severityRaw === "high"   ? "high"
      : severityRaw === "low"    ? "low" : "medium"
    items.push({
      kind:          "flag",
      offer_id:       offerId,
      transaction_id: null,
      contact_id:     null,
      title:          String(f.title ?? "Compliance flag"),
      detail:         String(f.description ?? ""),
      severity,
      raised_at:      f.created_at as string,
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
    })
  }

  return {
    brokerage_id: brokerageId,
    generated_at: new Date().toISOString(),
    totals: {
      open_flags:       items.filter(i => i.kind === "flag").length,
      awaiting_review:  items.filter(i => i.kind === "awaiting_review").length,
      missing_required: items.filter(i => i.kind === "em_receipt").length,
    },
    items,
  }
}
