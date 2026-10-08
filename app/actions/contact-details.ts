"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { requireCaller } from "@/lib/auth/require-caller"
import { CONTACT_SCOPE_STAFF_USER_TYPES } from "@/lib/portal/require-contact-access"
import { generateAssistantSuggestions } from "@/app/actions/assistant"
import { byPriorityDesc } from "@/lib/kernel/priority-rank"

// Every read in this file is a contact PII surface: contact record itself,
// credit accounts, transactions, message threads, documents, video engagement,
// portal activity. Previously NONE of them verified that the caller had access
// to the contact — any signed-in user could pull this data for any contactId
// they could guess (UUIDs but enumerable from URL leaks, etc.). IDOR across
// every brokerage.
//
// Fix: every function now resolves brokerage_id from the session and verifies
// the contact's brokerage_id matches before returning anything.

/**
 * THE SEATS THIS FILE'S SEVEN ACTIONS SERVE — **DERIVED**, NOT RETYPED (§6).
 *
 * The base is the ONE contact-scope roster, exported from the gate that already
 * owned it (`lib/portal/require-contact-access.ts`). The three extras are added
 * HERE, explicitly, rather than by widening that roster — the vendor-scope.ts
 * pattern that lib/auth/resolve-user-role.ts:213 blesses by name — so the portal
 * gate's behaviour is byte-identical to what it was before this wave, and the
 * widening lives where it is needed and is argued for.
 *
 * ── WHY THESE THREE, AND WHY THIS IS A NARROWING OVERALL ────────────────────
 *
 * The gate this replaces admitted EVERY seat whose `users.brokerage_id` matched
 * the contact's — all fifteen storable user_types. So a roster is only honest if
 * it names the seats that were legitimately using /crm, or the "fix" quietly
 * revokes them. Checked against the LIVE vocabulary cache
 * (`scripts/check-vocabularies.ts` → users.user_type, generated 2026-09-01,
 * fifteen values), the fifteen split three ways:
 *
 *   ADMITTED (9) — tenant staff who work contacts:
 *     agent, team_lead, tc, admin, broker, broker_owner   ← the base roster
 *     broker_admin        a REAL storable seat: the live CHECK now lists it, so
 *                         m530 is applied and CLAUDE.md §4's tenant roster names
 *                         it. The base roster predates that and omits it; adding
 *                         it here is what stops this change from revoking a
 *                         broker admin's own CRM.
 *     isa                 lib/security/permission-matrix.ts:120 grants it
 *                         contacts:create — working contacts IS the seat.
 *     compliance_officer  lib/security/permission-matrix.ts:196 grants it
 *                         contacts:view_all; it is also in
 *                         public.is_lead_visible_role() (033/m518/m530).
 *
 *   (Both citations used to point at lib/auth/permissions.ts, a SECOND
 *   role→capability table deleted in wave 26 with zero callers — tombstone in
 *   lib/auth/index.ts. The survivor grants both seats the same access under the
 *   canonical spelling, so this roster is unchanged by that deletion.)
 *
 *   REFUSED, AND THIS IS THE DEFECT BEING CLOSED (3) — CLAUDE.md §5 names these
 *   three by name: "Contacts, lenders and vendors see no financials — only their
 *   own." Live on hrvaqgvukzxfskkcrwbt: 4 `contact`, 2 `vendor`, 2 `lender`
 *   seats carry a brokerage_id, and every one of them passed the old gate for
 *   EVERY contact in that brokerage.
 *     contact, vendor, lender
 *
 *   REFUSED, DELIBERATELY (3):
 *     system              not a person; the AI ISA runs server-side and does not
 *                         call these actions.
 *     support, superadmin platform staff. They reach a tenant through the
 *                         impersonation seam (§5), which walks the account and
 *                         never exceeds it — not through a role hard-wired into
 *                         a CRM read. (`requireCaller()` refuses a caller with no
 *                         brokerage anyway, and the platform's one superadmin is
 *                         user_type='admin', so nobody real is lost here.)
 *
 * `lib/auth/permissions.ts:32` also grants `lender` contacts:read. That is a
 * DISAGREEMENT with §5, not a licence: it is recorded in the lane report as an
 * adjacent finding, and it does not widen this roster.
 */
const CRM_CONTACT_STAFF_USER_TYPES: ReadonlySet<string> = new Set([
  ...CONTACT_SCOPE_STAFF_USER_TYPES,
  "broker_admin",
  "isa",
  "compliance_officer",
])

/**
 * Fail-closed membership test. A null, undefined or unrecognised `user_type`
 * answers NO — a seat whose role could not be resolved must never be graded as a
 * granted one (§4), and an unresolved role is exactly what a refused `users` read
 * leaves behind.
 */
function isCrmContactStaff(userType: string | null | undefined): boolean {
  return CRM_CONTACT_STAFF_USER_TYPES.has(String(userType ?? "").toLowerCase())
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GATE FOR EVERY CONTACT-PII READ IN THIS FILE — TENANT **AND** ROLE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── WHAT WAS WRONG (wave 26, lane SEC2) ─────────────────────────────────────
 *
 * The tenant half was right and stays right: brokerage comes from the SESSION,
 * never from a parameter (§4). What was missing was the ROLE half — this gate
 * admitted ANY seat whose `users.brokerage_id` matched the contact's. Measured
 * on the production project (hrvaqgvukzxfskkcrwbt): 4 users with
 * `user_type='contact'` carry a brokerage_id, plus 2 `vendor` and 2 `lender`.
 * Every export of a `"use server"` file is a public HTTP endpoint (§4), so a
 * signed-in client, vendor or lender could POST any contactId in their brokerage
 * to these seven actions and receive `select("*")` on that person's contact row,
 * their credit accounts, their transactions, their documents and their whole
 * activity timeline. CLAUDE.md §5: "Contacts, lenders and vendors see no
 * financials — only their own."
 *
 * ── THE RULING: STAFF-ONLY, ALL SEVEN. NO isContactSelf BRANCH. ─────────────
 *
 * The alternative considered was "staff, PLUS a contact reaching their OWN
 * record via `requireContactAccess`'s `isContactSelf`". It is rejected here, and
 * deliberately, for three reasons:
 *
 *   1. §5 puts credit accounts and transactions out of a contact's reach on
 *      their OWN record too — a buyer does not read the brokerage's transaction
 *      row for their own deal out of the agent CRM's endpoint. A gate that
 *      admits self for five actions and refuses it for two would be two gates
 *      wearing one name, which is the §6 defect.
 *   2. NOTHING ASKS FOR IT. The only live call site of any of these seven is
 *      `app/crm/page.tsx:514-518` — the agent-facing CRM. The portal's own
 *      surfaces do not import this module; they go through
 *      `lib/portal/require-contact-access.ts`, which is where the self branch
 *      lives and where it is exercised. Adding a self branch here would be
 *      WIDENING a public endpoint that no surface needs widened.
 *   3. `getContactDetails` is `select("*")` on `contacts` — lead score, owner,
 *      internal notes, enrichment — plus the last ten `conversations`. That is
 *      the agent's working record ABOUT a person, not the person's own record.
 *
 * So: same-brokerage AND a contact-facing staff seat, per
 * `CRM_CONTACT_STAFF_USER_TYPES` above — DERIVED from the one exported roster in
 * lib/portal/require-contact-access.ts, not a third list, and deliberately not
 * TENANT_ADMIN_USER_TYPES, which omits `agent` and `tc` and would lock every
 * agent out of their own CRM.
 *
 * No role GRANT read is needed to reach the same answer as `resolveTenantAdmin`:
 * `agent` is already the floor of this roster, so the live "second seat"
 * (user_type 'agent' holding an 'admin' grant) is admitted by user_type alone.
 *
 * NO PLATFORM-STAFF BYPASS, on purpose. `requireCaller()` refuses a caller with
 * no brokerage of their own, so untenanted platform staff are refused here
 * exactly as they were before this change — support reaches a tenant through the
 * impersonation seam (§5), which walks the account and never exceeds it, not by
 * a role check hard-wired into a CRM read.
 *
 * ── FAIL CLOSED, BRANCH BY BRANCH (§3, §4) ──────────────────────────────────
 *
 * The old body destructured `{ data }` on BOTH reads and dropped both errors.
 * supabase-js RESOLVES a refusal, so an RLS refusal of the caller's own `users`
 * row arrived as "Unauthorized" and a refused `contacts` read arrived as
 * "Contact not found" — a permissions outage reported as a clean negative.
 *
 *   session missing        → "Unauthorized"      (requireCaller: unauthenticated)
 *   users read REFUSED     → the reason, surfaced (requireCaller: unreadable)
 *   caller has no tenant   → the reason, surfaced (requireCaller: no_brokerage)
 *   role unresolved / not
 *     on the roster        → "Forbidden"   — null user_type answers NO, never yes
 *   contacts read REFUSED  → "Access check failed" — NOT "Contact not found"
 *   contact in another
 *     tenant, or untenanted→ "Forbidden"
 */
async function authorizeContactAccess(contactId: string): Promise<
  | { ok: true; brokerageId: string; userType: string | null; contact: { id: string; brokerage_id: string } }
  | { ok: false; error: string }
> {
  // Identity from the SESSION through the ONE survivor (lib/auth/require-caller.ts).
  // It destructures and reads `error` on the auth read AND the users read, and it
  // does NOT default a missing user_type to "agent" — the two properties the
  // hand-rolled gate that stood here lacked.
  const caller = await requireCaller()
  if (!caller.ok) {
    return { ok: false, error: caller.reason === "unauthenticated" ? "Unauthorized" : caller.error }
  }

  // THE CHECK THIS GATE NEVER HAD. A contact / vendor / lender seat stops here.
  if (!isCrmContactStaff(caller.userType)) {
    return { ok: false, error: "Forbidden" }
  }

  // Service client for the ownership read, on purpose: a contact belonging to
  // ANOTHER tenant must come back so the comparison below can REFUSE it. Read
  // through RLS it would come back empty and be reported as "Contact not found",
  // which is a different answer wearing the same shape. Gate first, then the
  // service client (§4) — the role test above has already run.
  const svc = createServiceClient()
  const { data: contact, error: contactErr } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", contactId)
    .maybeSingle()

  // §3 — a refused read RESOLVES. It must not be laundered into "not found".
  if (contactErr) return { ok: false, error: "Access check failed" }
  if (!contact || !contact.brokerage_id) return { ok: false, error: "Contact not found" }
  if (contact.brokerage_id !== caller.brokerageId) return { ok: false, error: "Forbidden" }

  return {
    ok: true,
    brokerageId: caller.brokerageId,
    userType: caller.userType,
    contact: { id: contact.id, brokerage_id: contact.brokerage_id },
  }
}

export async function getContactDetails(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { contact: null, error: gate.error }

  const supabase = await createClient()
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .single()

  if (error) {
    return { contact: null, error: error.message }
  }

  const { data: conversations } = await supabase
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  return {
    contact: {
      ...contact,
      conversations: conversations || []
    },
    error: null
  }
}

export async function getContactCreditAccounts(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { accounts: [], error: gate.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("credit_accounts")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  return { accounts: data || [], error }
}

export async function getContactVideoEngagement(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { videos: [], error: gate.error }

  const supabase = await createClient()
  const { data: events } = await supabase
    .from("video_engagement_events")
    .select("video_asset_id, event_type, timestamp")
    .eq("contact_id", contactId)
    .order("timestamp", { ascending: false })
    .limit(20)

  const assetIds = [...new Set((events ?? []).map((e: any) => e.video_asset_id).filter(Boolean))]
  if (!assetIds.length) return { videos: [], error: null }

  const [{ data: perf }, { data: projects }] = await Promise.all([
    supabase
      .from("video_performance_tracking")
      .select("video_asset_id, total_views, average_completion_rate, last_event_at, brokerage_id")
      .in("video_asset_id", assetIds)
      .eq("brokerage_id", gate.brokerageId),
    supabase
      .from("ai_video_projects")
      .select("id, title, created_at, brokerage_id")
      .in("id", assetIds)
      .eq("brokerage_id", gate.brokerageId),
  ])

  const videos = assetIds.map((id: string) => {
    const p = perf?.find((x: any) => x.video_asset_id === id)
    const proj = projects?.find((x: any) => x.id === id)
    const firstEvent = (events ?? []).find((e: any) => e.video_asset_id === id)
    return {
      id,
      script_title: proj?.title ?? "Video",
      created_at: proj?.created_at ?? firstEvent?.timestamp,
      view_count: p?.total_views ?? 0,
      avg_completion_rate: p?.average_completion_rate ?? 0,
      last_viewed_at: p?.last_event_at ?? null,
    }
  })

  return { videos, error: null }
}

export async function getContactTransactions(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { transactions: [], error: gate.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, contact_id, listing_id, agent_id, property_address, city:property_city, state:property_state, " +
      "purchase_price, sale_price:purchase_price, list_price:purchase_price, status, contract_date, " +
      "closing_date:close_date, earnest_money, transaction_type:deal_type, created_at, updated_at"
    )
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })

  return { transactions: data || [], error }
}

export async function getContactCopilotSuggestions(contactId: string) {
  // Use service client to bypass RLS on smart_assistant_suggestions.
  // Explicit tenant filters (brokerage_id + agent_id) maintain isolation.
  const supabase = createServiceClient()
  const { agentId, brokerageId, userType } = await getAgentContext()

  if (!brokerageId) {
    return { suggestions: [], error: "No brokerage context" }
  }

  // THE ROLE TEST (wave 26, lane SEC2). This action does NOT route through
  // `authorizeContactAccess`, and that is deliberate: it is the one function here
  // that carries the IMPERSONATION seam — `getAgentContext()` resolves the
  // TARGET tenant when platform staff are acting as a brokerage, while
  // `requireCaller()` resolves the real session user and would refuse a
  // legitimate impersonating support seat. So the same roster is applied to the
  // same context this function already trusts for its tenant, rather than a
  // second identity read that would disagree with it.
  //
  // Its prior gate was tenant-only plus "has an agents row", which happened to
  // exclude contact/vendor/lender seats (they have none) — an accident of data,
  // not a decision, and it is not what the empty result SAID. It also fires a
  // model call through generateAssistantSuggestions below, so an ungated seat
  // was a billable one. Refusing by role is explicit and comes first.
  if (!isCrmContactStaff(userType)) {
    return { suggestions: [], error: "Forbidden" }
  }

  // Guard: service client bypasses RLS, so we must filter by agentId when available
  if (!agentId) {
    // Without an agentId we cannot safely scope suggestions — return empty
    return { suggestions: [], error: null }
  }

  // Pre-check that the contact belongs to caller's brokerage.
  // Destructure `error` (wave 4 slice 2): supabase-js RESOLVES a refused query,
  // so a swallowed error read as "not your contact" AND as "no suggestions" —
  // the same empty result. This queue is now rendered on /crm, so an unreadable
  // check must say so rather than showing an agent an empty suggestion list.
  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  if (contactErr) {
    return { suggestions: [], error: contactErr }
  }
  if (!contact || contact.brokerage_id !== brokerageId) {
    return { suggestions: [], error: null }
  }

  // GENERATE-THEN-READ (2026-09-02, closes the last category-C orphan export).
  // generateAssistantSuggestions carried four rule sets against live tables and
  // was called by nothing; lane W4b made it persist through the one suggestion
  // writer, and this page-level trigger is the caller — placed AFTER the
  // ownership pre-check so a foreign contact id never generates anything, and
  // deduped inside the generator so a repeat open costs no model call. Its
  // failure is logged, not returned: a model or write refusal must not blank
  // the rows that already exist for this contact.
  const gen = await generateAssistantSuggestions({ page: "contact_detail", entity_id: contactId, entity_type: "contact" })
  if (gen.error) console.warn(`[contact-details] suggestion generation skipped for ${contactId}: ${gen.error}`)

  let query = supabase
    .from("smart_assistant_suggestions")
    .select("*")
    // contact link is folded into the metadata jsonb (no context_id column)
    .eq("metadata->>contact_id", contactId)
    .eq("status", "pending")
    .eq("brokerage_id", brokerageId)

  query = query.eq("agent_id", agentId)

  // PRIORITY IS TEXT (CHECK low|medium|high) — `ORDER BY priority DESC` sorted
  // it alphabetically, so `medium` led and `high` came LAST, and the `.limit(10)`
  // on the same query dropped the high rows first. Order by created_at in SQL,
  // over-fetch, rank in code (lib/kernel/priority-rank.ts), slice to the
  // original 10.
  const SUGGESTION_LIMIT = 10
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(50)

  const suggestions = [...(data ?? [])].sort(byPriorityDesc).slice(0, SUGGESTION_LIMIT)
  return { suggestions, error }
}

export async function getContactActivity(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { activity: [], error: gate.error }

  const supabase = await createClient()

  // All activity tables are scoped to the verified contact
  // contact_notes was merged in from crm.ts:getContactTimeline (§1 keep-one,
  // lane E2 2026-08-28) — the timeline twin read notes and this one didn't.
  const [conversations, messages, tasks, activities, portalActivity, notes] = await Promise.all([
    supabase
      .from("conversations")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("tasks")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("activities")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    // This is the surface W15-3's unstamped writes were invisible ON: the agent's contact pane.
    // The read itself is correct (session client, so RLS is the tenant bound, filtered to the
    // already-authorized contact) — it is the WRITES that had to start carrying brokerage_id and
    // agent_id for the agent's policy lane to admit their own client's rows.
    // Its error is no longer dropped: supabase-js RESOLVES a refused read, so a refusal used to
    // arrive here as an empty list and render as "this client has done nothing", which is the one
    // conclusion an empty result never licenses.
    // property_id is the COLUMN, and it is the SURVIVOR of a duplicate: the same
    // handle used to be copied into metadata.property_id by every buyer-portal
    // writer. This select is the reader that makes the column live — see the
    // tombstone at app/actions/buyer-offer-tools.ts:recordPortalActivity.
    supabase
      .from("client_portal_activity")
      .select("id, contact_id, activity_type, metadata, property_id, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("contact_notes")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50)
  ])

  const activity = [
    ...(conversations.data || []).map((item: any) => ({
      ...item,
      activity_type: "conversation",
      activity_date: item.created_at
    })),
    ...(messages.data || []).map((item: any) => ({
      ...item,
      activity_type: "message",
      activity_date: item.created_at
    })),
    ...(tasks.data || []).map((item: any) => ({
      ...item,
      activity_type: "task",
      activity_date: item.created_at
    })),
    ...(activities.data || []).map((item: any) => ({
      ...item,
      activity_type: "activity",
      activity_date: item.created_at
    })),
    ...(portalActivity.data || []).map((item: any) => {
      const meta = (item.metadata ?? {}) as Record<string, unknown>
      // WHICH HOME the buyer was working on. Read off the COLUMN; the address
      // label still rides metadata because the column holds only the uuid.
      const propertyId = (item.property_id as string | null) ?? null
      const address = typeof meta.property_address === "string" && meta.property_address ? meta.property_address : null
      const label = address ?? (propertyId ? `property ${propertyId.slice(0, 8)}` : null)
      return {
        ...item,
        activity_type: item.activity_type ?? "portal_view",
        activity_date: item.created_at,
        property_id: propertyId,
        notes: label
          ? `${String(item.activity_type ?? "portal activity").replace(/_/g, " ")} — ${label}`
          : item.metadata
            ? JSON.stringify(item.metadata)
            : "Portal activity",
      }
    }),
    ...(notes.data || []).map((item: any) => ({
      ...item,
      activity_type: "note",
      activity_date: item.created_at
    }))
  ].sort((a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime())

  // `error: null` was hard-coded, so a refused sub-read rendered as a short feed with no warning.
  // Partial is reported as partial: the rows that DID come back are still returned.
  const readErrors = [
    ["conversations", conversations.error], ["messages", messages.error], ["tasks", tasks.error],
    ["activities", activities.error], ["portal activity", portalActivity.error],
    ["notes", notes.error],
  ].filter(([, e]) => e) as Array<[string, { message: string }]>
  if (readErrors.length > 0) {
    for (const [name, e] of readErrors) console.error(`[contact-details] ${name} read refused:`, e.message)
    return { activity, error: `Some activity couldn't be loaded (${readErrors.map(([n]) => n).join(", ")}) — this timeline is incomplete, not empty.` }
  }

  return { activity, error: null }
}

export async function getContactDocuments(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { documents: [], error: gate.error }

  const supabase = await createClient()
  // Contact-keyed docs live on `documents` (transaction_documents has no contact_id
  // and no documents_uploaded_by_fkey).
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })

  return { documents: data || [], error }
}

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getContactInteractions`
// deleted. SURVIVOR: `getContactActivity` (this file, above; wired at
// app/crm/page.tsx:417), whose Promise.all already reads the same
// `conversations` rows for the same verified contact — this was a strict
// subset with nothing to merge. A stripped-source census found zero callers
// outside the app/actions/index.ts barrel, which itself has zero importers.
