"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// Auth gate — write actions in this file stamp brokerage_id / agent_user_id
// onto lifecycle_events and listing-stage mutations. Without a session-derived
// identity, callers could forge those fields.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// ─── ROUTING: detect ShowingTime config ──────────────────────────────────────

export async function resolveShowingMode(params: {
  listingId: string
  agentUserId: string
  brokerageId: string
  teamId?: string | null
}): Promise<{ mode: "showingtime" | "manual"; credentialId?: string }> {
  // Unified ownership cascade (agent → team → brokerage → platform, legacy fallback) so a
  // ShowingTime connection from the Connection Center resolves at any tier — including TEAM,
  // which the old agent/brokerage-only read skipped.
  const conn = await resolveScopedConnection("showingtime", {
    agentUserId: params.agentUserId,
    teamId: params.teamId ?? null,
    brokerageId: params.brokerageId,
  })
  if (conn) return { mode: "showingtime", credentialId: conn.credentialId }

  return { mode: "manual" }
}

// ─── SHOWINGTIME MODE: sync ───────────────────────────────────────────────────

export async function syncShowingTimeShowings(params: {
  listingId: string
  brokerageId?: string  // ignored — derived from session
  credentialId: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.listingId)) return { success: false, error: "Invalid listing ID" }

  const supabase = await createClient()

  // Verify listing belongs to caller's brokerage
  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", params.listingId)
    .maybeSingle()
  if (!listing || listing.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  // Verify credential belongs to caller's brokerage too
  const { data: cred } = await supabase
    .from("platform_credentials")
    .select("api_key, api_url, account_id, brokerage_id")
    .eq("id", params.credentialId)
    .single()

  if (!cred?.api_key) return { success: false, error: "ShowingTime credentials not configured" }
  if (cred.brokerage_id && cred.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const baseUrl = cred.api_url || "https://api.showingtime.com/v1"
  const resp = await callConnector<{ showings?: any[] }>({
    connector: "showingtime", baseUrl, path: "/showings", method: "GET",
    query: { listing_id: params.listingId }, auth: { style: "bearer", token: cred.api_key },
  })

  if (!resp.ok) return { success: false, error: `ShowingTime API error: ${resp.status}` }

  const stShowings: any[] = resp.data?.showings ?? []

  // NOT NULL + FK reality: showings.contact_id/agent_id must be REAL rows —
  // the old zero-uuid fallback FK-failed every sync row that lacked one. The
  // honest fallback is the LISTING's own parties (the showing is on their home).
  const { data: fallbackListing } = await supabase
    .from("listings").select("seller_contact_id, contact_id, agent_id")
    .eq("id", params.listingId).maybeSingle()
  const fallbackContactId = (fallbackListing as any)?.seller_contact_id ?? (fallbackListing as any)?.contact_id ?? null
  const fallbackAgentId = (fallbackListing as any)?.agent_id ?? null

  let skippedNoParty = 0
  let skippedForeignShowingId = 0
  let failedWrite = 0
  for (const s of stShowings) {
    const rowContactId = s.contactId ?? fallbackContactId
    const rowAgentId = s.agentId ?? fallbackAgentId
    if (!rowContactId || !rowAgentId) { skippedNoParty++; continue } // honest skip — never a fake FK ref

    // showingtime_id is UNIQUE across the whole table, but a ShowingTime id is only
    // unique within a ShowingTime ACCOUNT. Two brokerages on different accounts can
    // legitimately produce the same id, and this upsert conflicts on it — which
    // repointed the other tenant's showing row (listing_id, contact_id, agent_id) to
    // this caller's listing. Refuse rather than repoint; an external id is not proof
    // of ownership.
    const { data: existing } = await supabase
      .from("showings")
      .select("id, brokerage_id")
      .eq("showingtime_id", s.id)
      .maybeSingle()
    const existingBrokerageId = (existing as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
    if (existingBrokerageId && existingBrokerageId !== auth.brokerageId) {
      skippedForeignShowingId++
      continue
    }

    // STAMP THE TENANT THE GUARD JUST VALIDATED. The skip above only fires when
    // `existing.brokerage_id` is NON-NULL and foreign — a row this very loop
    // wrote unstamped comes back with brokerage_id = NULL, `existingBrokerageId`
    // is null, and the guard falls through and repoints it. So the missing stamp
    // was not merely invisible to readers, it was disarming the cross-account
    // showingtime_id defense that sits directly above it. Stamping makes the
    // guard self-reinforcing: every row this loop writes is one the next pass
    // can adjudicate.
    //
    // The value is the LISTING's own brokerage_id, resolved through the record
    // (app/actions/open-house.ts:481-498) — a showing is filed against
    // `listing_id`, so it belongs to whoever owns that home. It is provably
    // equal to auth.brokerageId here because the check at line 74 returns
    // Forbidden otherwise; taking it from the record keeps the write correct if
    // that check is ever loosened, and it is the same value the guard compares.
    const { error: upsertErr } = await supabase
      .from("showings")
      .upsert(
        {
          listing_id: params.listingId,
          brokerage_id: listing.brokerage_id,
          showingtime_id: s.id,
          scheduled_at: s.scheduledAt,
          scheduled_date: s.date,
          scheduled_time: s.time,
          duration_minutes: s.durationMinutes ?? 30,
          buyer_agent_name: s.buyerAgent?.name ?? null,
          buyer_agent_email: s.buyerAgent?.email ?? null,
          buyer_agent_phone: s.buyerAgent?.phone ?? null,
          status: s.status ?? "scheduled",
          sync_source: "showingtime",
          synced_at: new Date().toISOString(),
          // Required NOT NULL columns — real rows only (see fallback above)
          contact_id: rowContactId,
          agent_id:   rowAgentId,
        },
        { onConflict: "showingtime_id", ignoreDuplicates: false }
      )

    // supabase-js RESOLVES a refused write, so the previous bare `await` counted
    // every row as synced whether or not it landed — "permission denied" and
    // "wrote the row" were the same value. Count the misses instead of
    // reporting a sync that did not happen.
    if (upsertErr) {
      console.error("[syncShowingTimeShowings] upsert failed for showingtime_id", s.id, upsertErr.message)
      failedWrite++
    }
  }

  revalidatePath(`/dashboard/listings/${params.listingId}/showings`)
  return {
    success: true,
    synced: stShowings.length - skippedNoParty - skippedForeignShowingId - failedWrite,
    skippedNoParty,
    skippedForeignShowingId,
    failedWrite,
  }
}

// ─── SHOWINGTIME MODE: per-showing actions ────────────────────────────────────

export async function showingTimeConfirm(params: { showingId: string; credentialId: string }) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const { data: cred } = await supabase
    .from("platform_credentials")
    .select("api_key, api_url, brokerage_id")
    .eq("id", params.credentialId)
    .single()

  if (!cred?.api_key) return { success: false, error: "ShowingTime credentials not configured" }
  if (cred.brokerage_id && cred.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  // Verify showing belongs to caller's brokerage via listing
  const { data: showing } = await supabase
    .from("showings")
    .select("showingtime_id, listing_id, listings!inner(brokerage_id)")
    .eq("id", params.showingId)
    .single()

  if (!showing?.showingtime_id) return { success: false, error: "No ShowingTime reference on this showing" }
  const showingBrokerageId = (showing.listings as any)?.brokerage_id
  if (showingBrokerageId !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const baseUrl = cred.api_url || "https://api.showingtime.com/v1"
  const resp = await callConnector({
    connector: "showingtime", baseUrl, path: `/showings/${showing.showingtime_id}/confirm`, method: "POST",
    auth: { style: "bearer", token: cred.api_key }, body: {},
  })

  if (!resp.ok) return { success: false, error: `ShowingTime confirm failed: ${resp.status}` }

  await supabase
    .from("showings")
    .update({ status: "confirmed", updated_at: new Date().toISOString() })
    .eq("id", params.showingId)

  return { success: true }
}

export async function showingTimeReschedule(params: {
  showingId: string
  credentialId: string
  proposedTimes: string[]
  reason: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const { data: cred } = await supabase
    .from("platform_credentials")
    .select("api_key, api_url, brokerage_id")
    .eq("id", params.credentialId)
    .single()

  if (!cred?.api_key) return { success: false, error: "ShowingTime credentials not configured" }
  if (cred.brokerage_id && cred.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const { data: showing } = await supabase
    .from("showings")
    .select("showingtime_id, listing_id, listings!inner(brokerage_id)")
    .eq("id", params.showingId)
    .single()

  if (!showing?.showingtime_id) return { success: false, error: "No ShowingTime reference" }
  const showingBrokerageId = (showing.listings as any)?.brokerage_id
  if (showingBrokerageId !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const baseUrl = cred.api_url || "https://api.showingtime.com/v1"
  const resp = await callConnector({
    connector: "showingtime", baseUrl, path: `/showings/${showing.showingtime_id}/reschedule`, method: "POST",
    auth: { style: "bearer", token: cred.api_key },
    body: { proposed_times: params.proposedTimes, reason: params.reason },
  })

  if (!resp.ok) return { success: false, error: `ShowingTime reschedule failed: ${resp.status}` }

  await supabase
    .from("showings")
    .update({ status: "rescheduled", updated_at: new Date().toISOString() })
    .eq("id", params.showingId)

  return { success: true }
}

export async function showingTimeDecline(params: {
  showingId: string
  credentialId: string
  reason: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!params.reason?.trim()) return { success: false, error: "Decline reason is required" }

  const supabase = await createClient()
  const { data: cred } = await supabase
    .from("platform_credentials")
    .select("api_key, api_url, brokerage_id")
    .eq("id", params.credentialId)
    .single()

  if (!cred?.api_key) return { success: false, error: "ShowingTime credentials not configured" }
  if (cred.brokerage_id && cred.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const { data: showing } = await supabase
    .from("showings")
    .select("showingtime_id, listing_id, listings!inner(brokerage_id)")
    .eq("id", params.showingId)
    .single()

  if (!showing?.showingtime_id) return { success: false, error: "No ShowingTime reference" }
  const showingBrokerageId = (showing.listings as any)?.brokerage_id
  if (showingBrokerageId !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const baseUrl = cred.api_url || "https://api.showingtime.com/v1"
  const resp = await callConnector({
    connector: "showingtime", baseUrl, path: `/showings/${showing.showingtime_id}/decline`, method: "POST",
    auth: { style: "bearer", token: cred.api_key }, body: { reason: params.reason },
  })

  if (!resp.ok) return { success: false, error: `ShowingTime decline failed: ${resp.status}` }

  await supabase
    .from("showings")
    .update({ status: "cancelled", notes: params.reason, updated_at: new Date().toISOString() })
    .eq("id", params.showingId)

  return { success: true }
}

// ─── MANUAL MODE — Section 1: Request Approval ───────────────────────────────

/** Load pending showing_requests for a listing */
export async function getShowingRequests(listingId: string) {
  if (!isValidUUID(listingId)) return { success: false, error: "Invalid listing ID", requests: [] }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("showing_requests")
    .select("*")
    .eq("listing_id", listingId)
    .eq("status", "pending")
    .order("requested_date", { ascending: true })

  if (error) return { success: false, error: error.message, requests: [] }
  return { success: true, requests: data ?? [] }
}

/** Load confirmed showings for a listing */
export async function getListingShowings(listingId: string) {
  if (!isValidUUID(listingId)) return { success: false, error: "Invalid listing ID", showings: [] }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("showings")
    .select("*, showing_feedback(id, ai_summary, presentation_rating, cleanliness_rating, overall_impression, buyer_interest_level, sentiment_score)")
    .eq("listing_id", listingId)
    .order("scheduled_at", { ascending: false })

  if (error) return { success: false, error: error.message, showings: [] }
  return { success: true, showings: data ?? [] }
}

/** Approve a showing request: UPDATE request + INSERT showing */
export async function approveShowingRequest(params: {
  requestId: string
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentUserId?: string  // ignored — derived from session
  contactId?: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.requestId) || !isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  // Verify listing belongs to caller's brokerage
  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", params.listingId)
    .maybeSingle()
  if (!listing || listing.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const { data: req, error: reqErr } = await supabase
    .from("showing_requests")
    .select("*")
    .eq("id", params.requestId)
    .single()

  if (reqErr || !req) return { success: false, error: "Showing request not found" }

  // UPDATE showing_requests.
  // This used to be a bare `await` with NO error check and no `.select()`, so a
  // refused or zero-row update was invisible — and the code below then went on
  // to INSERT a real `showings` row and fire SHOWING_SCHEDULED for an approval
  // that was never recorded. The seller's approval is the load-bearing fact
  // here; if it did not land, nothing after it may happen. (This hardening was
  // ported from app/actions/showings.ts:updateShowingStatus before that
  // duplicate was deleted — wave 4 slice 2.)
  const { data: approvedRows, error: approveErr } = await supabase
    .from("showing_requests")
    .update({
      seller_approved: true,
      seller_approved_at: new Date().toISOString(),
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.requestId)
    .select("id")

  if (approveErr) return { success: false, error: approveErr.message }
  if (!approvedRows || approvedRows.length === 0) {
    return { success: false, error: "Showing request not found, or you do not have access to it." }
  }

  // Compose scheduled_at from date + start_time
  const scheduledAt = new Date(
    `${req.requested_date}T${req.requested_start_time}`
  ).toISOString()

  // showings.contact_id is NOT NULL + FKs contacts — when the request carries
  // no contact (an outside buyer's agent), the listing's own seller is the
  // honest deal-context party. Refuse rather than fake a ref.
  const { data: approveListing } = await supabase
    .from("listings").select("seller_contact_id, contact_id")
    .eq("id", params.listingId).maybeSingle()
  const fallbackSellerContactId = (approveListing as any)?.seller_contact_id ?? (approveListing as any)?.contact_id ?? null
  if (!params.contactId && !req.contact_id && !fallbackSellerContactId) {
    return { success: false, error: "This listing has no client on record yet — add the seller before approving showings." }
  }
  // showings.agent_id is also NOT NULL + FKs agents — honest refusal for non-agent seats.
  const approverAgentId = await resolveAgentId(supabase as any, auth.userId)
  if (!approverAgentId) {
    return { success: false, error: "Your account has no agent profile — showings belong to an agent seat." }
  }

  // INSERT showings — agent from session, not params
  //
  // brokerage_id from the LISTING record, resolved above at line 364 and proven
  // to equal auth.brokerageId by the Forbidden guard at line 369. The showing is
  // filed against `listing_id`, so the listing's tenant is the row's tenant —
  // the record-resolved answer argued at app/actions/open-house.ts:481-498. This
  // insert stamped nothing, while the sibling writers of this same table
  // (tour-planner.ts:376, ai-showing-management.ts:346) both stamp it; the rows
  // it produced were the ones no .eq("brokerage_id", …) reader could ever see.
  //
  // agent_id stays `approverAgentId`: agents(id), a disjoint id space from
  // brokerages(id) — never bridge the two.
  const { data: showing, error: showErr } = await supabase
    .from("showings")
    .insert({
      listing_id:         params.listingId,
      brokerage_id:       listing.brokerage_id,
      contact_id:         params.contactId ?? req.contact_id ?? fallbackSellerContactId, // real party or refuse — never a fake FK ref
      agent_id:           approverAgentId, // agents(id) — resolved + refused above when absent
      scheduled_at:       scheduledAt,
      scheduled_date:     req.requested_date,
      scheduled_time:     req.requested_start_time,
      duration_minutes:   30,
      buyer_agent_name:   req.buyer_agent_name,
      buyer_agent_email:  req.buyer_agent_email,
      buyer_agent_phone:  req.buyer_agent_phone,
      status:             "confirmed",
      sync_source:        "manual",
    })
    .select("id")
    .single()

  if (showErr) return { success: false, error: showErr.message }

  // UPDATE converted_showing_id on request
  await supabase
    .from("showing_requests")
    .update({ converted_showing_id: showing.id })
    .eq("id", params.requestId)

  // Kernel sub-event — brokerage_id / actor from session, not params
  await supabase.from("lifecycle_events").insert({
    brokerage_id:   auth.brokerageId,
    entity_type:    "listing_stage_machine",
    entity_id:      params.listingId,
    event_type:     "listing.showing.confirmed",
    actor_user_id:  auth.userId,
    metadata: { showing_id: showing.id, request_id: params.requestId },
  })

  await processKernelEvent({
    event:      KernelEvent.SHOWING_SCHEDULED,
    brokerageId: auth.brokerageId,
    entityType: "listing_stage_machine",
    entityId:   params.listingId,
  }).catch(() => {})

  revalidatePath(`/dashboard/listings/${params.listingId}/showings`)
  return { success: true, showingId: showing.id }
}

/** Suggest different time: UPDATE alternative_times on showing_request */
export async function suggestAlternativeTime(params: {
  requestId: string
  listingId: string
  proposedTimes: Array<{ date: string; start_time: string; end_time: string }>
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.requestId)) return { success: false, error: "Invalid request ID" }

  const supabase = await createClient()

  // Verify the request's listing belongs to caller's brokerage
  const { data: req } = await supabase
    .from("showing_requests")
    .select("listing_id, listings!inner(brokerage_id)")
    .eq("id", params.requestId)
    .maybeSingle()
  if (!req) return { success: false, error: "Request not found" }
  if ((req.listings as any)?.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const { data: rescheduledRows, error } = await supabase
    .from("showing_requests")
    .update({
      alternative_times: params.proposedTimes,
      // Ported from the deleted app/actions/showings.ts:updateShowingStatus
      // (wave 4 slice 2). Proposing new times used to write ONLY the
      // alternative_times array and leave status = 'pending', so the request
      // stayed in the "awaiting your decision" queue that getShowingRequests
      // builds (`.eq("status","pending")`) and the agent was asked to decide on
      // it again on every visit. 'needs_reschedule' is live-verified against
      // showing_requests_status_check.
      status:            "needs_reschedule",
      updated_at:        new Date().toISOString(),
    })
    .eq("id", params.requestId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!rescheduledRows || rescheduledRows.length === 0) {
    return { success: false, error: "Showing request not found, or you do not have access to it." }
  }

  revalidatePath(`/dashboard/listings/${params.listingId}/showings`)
  return { success: true }
}

/** Deny a showing request */
export async function denyShowingRequest(params: {
  requestId: string
  listingId: string
  reason?: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.requestId)) return { success: false, error: "Invalid request ID" }

  const supabase = await createClient()

  // Verify the request's listing belongs to caller's brokerage
  const { data: req } = await supabase
    .from("showing_requests")
    .select("listing_id, listings!inner(brokerage_id)")
    .eq("id", params.requestId)
    .maybeSingle()
  if (!req) return { success: false, error: "Request not found" }
  if ((req.listings as any)?.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  // `.select("id")` + a zero-row refusal, ported from the deleted
  // app/actions/showings.ts:updateShowingStatus. Without it an update RLS
  // refused came back with error === null and was reported as { success: true }
  // — the agent was told the request was denied when nothing was written.
  const { data: deniedRows, error } = await supabase
    .from("showing_requests")
    .update({
      status:       "denied",
      seller_notes: params.reason ?? null,
      updated_at:   new Date().toISOString(),
    })
    .eq("id", params.requestId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!deniedRows || deniedRows.length === 0) {
    return { success: false, error: "Showing request not found, or you do not have access to it." }
  }

  revalidatePath(`/dashboard/listings/${params.listingId}/showings`)
  return { success: true }
}

/** Mark showing completed + create feedback_request + feedback rows */
export async function markShowingCompleted(params: {
  showingId: string
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentUserId?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.showingId)) return { success: false, error: "Invalid showing ID" }

  const supabase = await createClient()

  const { data: showing } = await supabase
    .from("showings")
    .select("buyer_agent_email, buyer_agent_name, listing_id, listings!inner(brokerage_id)")
    .eq("id", params.showingId)
    .single()

  if (!showing) return { success: false, error: "Showing not found" }
  if ((showing.listings as any)?.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  // UPDATE showings.status
  await supabase
    .from("showings")
    .update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", params.showingId)

  // INSERT showing_feedback_requests — brokerage from session
  const { data: feedbackReq } = await supabase
    .from("showing_feedback_requests")
    .insert({
      brokerage_id: auth.brokerageId,
      showing_id:   params.showingId,
      sent_to_email: showing?.buyer_agent_email ?? null,
      sent_at:      new Date().toISOString(),
    })
    .select("id, feedback_token")
    .single()

  if (!feedbackReq) return { success: false, error: "Failed to create feedback request" }

  // INSERT showing_feedback stub with same token
  await supabase
    .from("showing_feedback")
    .insert({
      brokerage_id:   auth.brokerageId,
      showing_id:     params.showingId,
      feedback_token: feedbackReq.feedback_token,
      request_id:     feedbackReq.id,
    })

  // Direct lifecycle_events insert — session-derived identity
  await supabase.from("lifecycle_events").insert({
    brokerage_id:   auth.brokerageId,
    entity_type:    "listing_stage_machine",
    entity_id:      params.listingId,
    event_type:     "listing.showing.completed",
    actor_user_id:  auth.userId,
    metadata: { showing_id: params.showingId, feedback_token: feedbackReq.feedback_token },
  })

  // Kernel notification (non-blocking)
  await processKernelEvent({
    event:       KernelEvent.SHOWING_FEEDBACK_RECEIVED,
    brokerageId: auth.brokerageId,
    entityType:  "listing_stage_machine",
    entityId:    params.listingId,
  }).catch(() => {})

  revalidatePath(`/dashboard/listings/${params.listingId}/showings`)
  return { success: true, feedbackToken: feedbackReq.feedback_token }
}

// ─── Section 2: Analytics ─────────────────────────────────────────────────────

export async function getShowingAnalytics(listingId: string) {
  if (!isValidUUID(listingId)) return null

  const supabase = await createClient()
  const { data } = await supabase
    .from("showing_analytics")
    .select("*")
    .eq("listing_id", listingId)
    .maybeSingle()

  return data
}

export async function getShowingFeedbackCards(listingId: string) {
  if (!isValidUUID(listingId)) return []

  const supabase = await createClient()
  const { data } = await supabase
    .from("showing_feedback")
    .select(`
      id, created_at, ai_summary,
      presentation_rating, cleanliness_rating, price_opinion,
      meets_buyer_needs, offer_interest, overall_impression,
      buyer_interest_level, sentiment_score,
      submitted_by_agent_name, submitted_by_agent_email,
      showings!inner(listing_id, scheduled_at, buyer_agent_name)
    `)
    .eq("showings.listing_id", listingId)
    .order("created_at", { ascending: false })

  return data ?? []
}
