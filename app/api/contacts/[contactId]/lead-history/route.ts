import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { assertCanActOnContact } from "@/lib/auth/contact-access"

export const dynamic = "force-dynamic"

// GET /api/contacts/[contactId]/lead-history
//
// Owner ruling (2026-09-08, restating CLAUDE.md §5): "agents can't claim leads
// because they can only see contacts (with access to leads history)." This is
// the ONE route that answers "what did this contact's lead-era history look
// like" for an agent who may never read `leads` itself (migration 034).
//
// FOUR SECTIONS, each a different re-pointing story:
//
//  1. LINEAGE (unchanged) — `contact_lead_history` (migration 039, widened by
//     m613 for campaign/intake fields). SECURITY INVOKER over the caller's own
//     RLS-scoped client, so this section needs no gate of its own — a caller
//     who cannot see the contact gets zero rows here already.
//
//  2. RE-POINTED HISTORY (activities / communication_audit_log / isa_outreach_log)
//     — these three carry `contact_id` and are stamped by
//     lib/contact-promotion/history-carry.ts on conversion (activities is the
//     ONE exception: lead-era rows are filed `entity_type:'lead',
//     entity_id:<leadId>` per lib/kernel/manager-registry.ts's wave-26 note —
//     "leads are NOT contacts... contact_id honestly null" — so activities is
//     read BOTH ways: by `contact_id` for the post-conversion trail and by
//     `entity_type='lead' AND entity_id IN (this contact's lead ids)` for the
//     pre-conversion one).
//
//  3. ASSIGNMENT HISTORY (assignment_log) — lead_id ONLY (no contact_id column
//     on this table: verified against scripts/schema-snapshot.ts), so there is
//     no re-point to read by contact_id at all. Reached the only way possible:
//     resolve this contact's lead ids from section 1's own rows, then read
//     assignment_log by `lead_id IN (...)`.
//
// WHY THE SERVICE CLIENT, GATED FIRST (CLAUDE.md §4 — "Gate first, then use
// the service client"): `assignment_log` carries no RLS policy at all
// (verified — no `CREATE POLICY ... ON assignment_log` anywhere in
// supabase/migrations), so a cookie/RLS client here would be either silently
// empty (RLS enabled, no policy = deny-all) or a cross-tenant read (RLS never
// enabled on it) depending on a fact this route must not have to guess.
// `assertCanActOnContact(contactId, { intent: "read" })` is the canonical
// per-contact gate (lib/auth/contact-access.ts) — agent-owns-contact or
// same-brokerage staff, fail-closed on anything else — and every service-client
// read below is ADDITIONALLY pinned to `contact.brokerage_id`, so a gate bug
// would still not cross a tenant boundary.
//
// WHAT IS DELIBERATELY NOT SELECTED: `activities.metadata` (can carry raw
// vendor/scrape payloads), `assignment_log.rule_id` (an internal routing-rule
// key, not a fact about this person), and nothing from `leads` beyond what the
// view already exposes — no `raw_record_id`, no `enrichment_profile`, no other
// agent's leads (every read below is pinned to `contactId`'s OWN lead ids).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { contactId } = await params

  const { data, error } = await supabase
    .from("contact_lead_history")
    .select("*")
    .eq("contact_id", contactId)
    .order("lead_created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const lineage = data ?? []
  const leadIds = [...new Set(lineage.map((r: any) => r.lead_id).filter((v: unknown): v is string => typeof v === "string" && v.length > 0))]

  // Section 2/3 gate. A caller the view already silently emptied for (RLS) is
  // refused here too, EXPLICITLY, rather than served activities/assignment
  // rows off a service client with no per-row gate underneath it.
  const access = await assertCanActOnContact(contactId, { intent: "read" })
  if (!access.ok) {
    // The lineage section still answers — it is RLS-safe on its own. Only the
    // service-client sections are withheld, and the reason is named.
    return NextResponse.json({
      success: true,
      history: lineage,
      activities: [],
      communications: [],
      outreach: [],
      assignments: [],
      extendedError: access.error,
    })
  }

  const brokerageId = access.contact.brokerage_id
  const svc = createServiceClient()

  const leadIdList = leadIds.length > 0 ? `(${leadIds.join(",")})` : null

  const [activitiesRes, communicationsRes, outreachRes, assignmentsRes] = await Promise.all([
    svc
      .from("activities")
      .select("id, activity_type, title, description, status, created_at, completed_at, outcome, channel, contact_id, entity_type, entity_id")
      .eq("brokerage_id", brokerageId)
      .or(
        leadIdList
          ? `contact_id.eq.${contactId},and(entity_type.eq.lead,entity_id.in.${leadIdList})`
          : `contact_id.eq.${contactId}`,
      )
      .order("created_at", { ascending: false })
      .limit(50),
    svc
      .from("communication_audit_log")
      .select("id, communication_type, channel, subject, body_snippet, sent_at, created_at, compliance_passed, was_approved_content, lead_temperature, lead_id")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    svc
      .from("isa_outreach_log")
      .select("id, channel, subject, body_snippet, status, sent_at, opened_at, replied_at, created_at, them_first_score")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    leadIds.length > 0
      ? svc
          .from("assignment_log")
          .select("id, lead_id, assignment_method, routing_reason, claimed, claimed_at, score_at_assignment, created_at")
          .eq("brokerage_id", brokerageId)
          .in("lead_id", leadIds)
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ])

  const extendedError =
    activitiesRes.error?.message ||
    communicationsRes.error?.message ||
    outreachRes.error?.message ||
    assignmentsRes.error?.message ||
    null

  return NextResponse.json({
    success: true,
    history: lineage,
    activities: activitiesRes.data ?? [],
    communications: communicationsRes.data ?? [],
    outreach: outreachRes.data ?? [],
    assignments: assignmentsRes.data ?? [],
    extendedError,
  })
}
