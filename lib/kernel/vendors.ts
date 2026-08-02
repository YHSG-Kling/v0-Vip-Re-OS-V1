// lib/kernel/vendors.ts
//
// CANONICAL Vendor / Partner kernel commands.
// ALL vendor record creation, assignment, status transitions, and
// deliverable attachment must flow through these commands.
//
// Kernel Ownership Rules:
//   - `vendors`         = marketplace table (global + brokerage-specific)
//   - curation/placement (preferred, display_priority, visible_in_portal,
//     audience_tags, stage_tags, team_id) are COLUMNS on `vendors` since m355.
//     They were a separate `vendor_directory` table; two rows per vendor is
//     what the drift was.
//   - `vendor_bookings` = listing-level and contact-level assignments
//   - `vendor_assignments` + `vendor_jobs` = transaction-level assignments
//   - Every state transition emits a KernelEvent via lifecycle_events
//   - No direct DB writes from UI components or action files
//
// Explicit Commands:
//   1. loadVendorWorkspace      — read-only workspace for the vendors page
//   2. createVendorRecord       — create in `vendors` (marketplace)
//   3. updateVendorRecord       — update fields in `vendors`
//   4. assignVendorToListing    — write vendor_bookings with listing_id
//   5. assignVendorToTransaction— write vendor_assignments + vendor_jobs
//   6. updateVendorBookingStatus— status transitions on vendor_bookings
//   7. attachVendorDeliverable  — write client_documents (doc_type=vendor_deliverable)
//   8. loadPartnerDirectory     — read-only partner / preferred vendor workspace
//
// Explicit Rules:
//   - vendor_bookings.status transitions: booked→confirmed→completed | any→cancelled|no_show
//   - the placement flags are written ONLY by lib/vendors/premium-placement.ts
//     (sold + paid) — never as a side effect of ordinary vendor edits here
//   - vendor_assignments.assigned_by_agent_id is FK to agents.id (not users.id)
//   - attachVendorDeliverable requires the booking to exist and belong to the brokerage
//   - createVendorRecord enforces case-insensitive name uniqueness per brokerage
//
// Tables written:
//   vendors, vendor_bookings, vendor_assignments, vendor_jobs,
//   client_documents, lifecycle_events
//
// Tables read (read-only):
//   vendors, vendor_bookings, vendor_assignments,
//   vendor_ratings, referral_partners, listings, transactions

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { sendEmail } from "@/lib/providers/messaging"
import {
  toVendorCategory,
  VENDOR_CATEGORIES,
  VENDOR_CATEGORY_LABELS,
} from "@/lib/kernel/vendor-categories"

// ─── STATUS TRANSITION GRAPH ─────────────────────────────────────────────────
// Allowed booking status transitions. Any→cancelled and any→no_show are always
// permitted. Forward-only transitions are enforced for the lifecycle path.

const BOOKING_STATUS_TRANSITIONS: Record<string, string[]> = {
  booked:    ["confirmed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],                          // terminal — no further transitions
  cancelled: [],                          // terminal
  no_show:   [],                          // terminal
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface VendorActorContext {
  brokerageId: string
  agentUserId: string   // supabase auth user id (users.id)
  agentId?:    string   // agents.id — resolved lazily inside commands when needed
}

export interface KernelVendorResult<T = void> {
  success:  boolean
  data?:    T
  error?:   string
}

// loadVendorWorkspace output
export interface VendorWorkspaceData {
  vendors:         VendorRow[]
  assignments:     VendorAssignmentRow[]
  recentBookings:  VendorBookingRow[]
  directory:       VendorDirectoryRow[]
  pendingRatings:  VendorBookingRow[]
}

export interface VendorRow {
  id:           string
  name:         string
  email:        string | null
  phone:        string | null
  website:      string | null
  category:     string | null
  notes:        string | null
  rating:       number | null
  brokerage_id: string | null
}

export interface VendorDirectoryRow {
  id:           string
  name:         string
  category:     string | null
  phone:        string | null
  email:        string | null
  website:      string | null
  notes:        string | null
  rating:       number | null
  brokerage_id: string
}

export interface VendorBookingRow {
  id:             string
  vendor_id:      string
  transaction_id: string | null
  listing_id:     string | null
  contact_id:     string | null
  brokerage_id:   string
  service_type:   string
  scheduled_date: string | null
  cost:           number | null
  status:         string
  booked_by:      string | null
  completed_at:   string | null
  agent_rating:   number | null
  notes:          string | null
  vendors?:       { id: string; name: string; category: string | null; rating: number | null }
  transactions?:  { id: string; property_address: string } | null
}

export interface VendorAssignmentRow {
  id:                   string
  vendor_id:            string
  transaction_id:       string | null
  brokerage_id:         string
  assigned_by_agent_id: string | null
  assignment_type:      string
  scheduled_date:       string | null
  completed_date:       string | null
  notes:                string | null
  status:               string
  vendors?:             { id: string; name: string; category: string | null }
  transactions?:        { id: string; property_address: string } | null
}

// Input types for each command
export interface LoadVendorWorkspaceInput {
  brokerageId:  string
  agentUserId:  string
  limit?:       number   // default 100
}

export interface CreateVendorRecordInput {
  brokerageId:  string
  agentUserId:  string
  name:         string
  category?:    string
  phone?:       string
  email?:       string
  website?:     string
  notes?:       string
}

export interface UpdateVendorRecordInput {
  vendorId:     string
  brokerageId:  string
  agentUserId:  string
  patch: Partial<{
    name:     string
    category: string
    phone:    string
    email:    string
    website:  string
    notes:    string
    rating:   number
  }>
}

export interface AssignVendorToListingInput {
  vendorId:      string
  listingId:     string
  brokerageId:   string
  agentUserId:   string
  serviceType:   string
  scheduledDate?: string
  cost?:          number
  notes?:         string
}

export interface AssignVendorToTransactionInput {
  vendorId:       string
  transactionId:  string
  brokerageId:    string
  agentUserId:    string
  assignmentType: string
  scheduledDate?: string
  notes?:         string
}

export interface UpdateVendorBookingStatusInput {
  bookingId:    string
  brokerageId:  string
  agentUserId:  string
  toStatus:     "booked" | "confirmed" | "completed" | "cancelled" | "no_show"
  notes?:       string
}

export interface AttachVendorDeliverableInput {
  bookingId:    string
  vendorId:     string
  brokerageId:  string
  agentUserId:  string
  documentUrl:  string
  description:  string
  fileName?:    string
}

export interface LoadPartnerDirectoryInput {
  brokerageId:  string
  agentUserId:  string
}

export interface PartnerDirectoryData {
  directory:         VendorDirectoryRow[]
  preferredVendors:  VendorRow[]
  referralPartners:  ReferralPartnerRow[]
}

export interface ReferralPartnerRow {
  id:             string
  brokerage_id:   string
  partner_name:   string
  partner_type:   string | null
  contact_name:   string | null
  contact_email:  string | null
  contact_phone:  string | null
  status:         boolean | null
  notes:          string | null
}

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

/** Resolve agents.id from users.id — used for assigned_by_agent_id FK */
async function resolveAgentId(
  supabase: ReturnType<typeof createServiceClient>,
  agentUserId: string,
  brokerageId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", agentUserId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  return data?.id ?? null
}

/** Write a lifecycle_events row for the given event */
async function emitLifecycleEvent(
  supabase: ReturnType<typeof createServiceClient>,
  params: {
    brokerageId:  string
    actorUserId:  string
    entityType:   string
    entityId:     string
    event:        KernelEvent
    metadata?:    Record<string, unknown>
  }
) {
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  params.brokerageId,
    actor_user_id: params.actorUserId,
    entity_type:   params.entityType,
    entity_id:     params.entityId,
    event_type:    params.event,
    metadata:      params.metadata ?? {},
    created_at:    new Date().toISOString(),
  })
}

// ─── COMMAND 1: loadVendorWorkspace ──────────────────────────────────────────
//
// Reads vendors, assignments, bookings, directory, pending ratings for the page.
// READ-ONLY — no writes.
//
// UI Behavior: Called from page.tsx RSC to hydrate VendorDirectoryClient.
// Acceptance: Returns { vendors[], assignments[], recentBookings[], directory[], pendingRatings[] }

export async function loadVendorWorkspace(
  input: LoadVendorWorkspaceInput
): Promise<KernelVendorResult<VendorWorkspaceData>> {
  const { brokerageId, agentUserId, limit = 100 } = input
  const supabase = createServiceClient()

  const [
    vendorsRes,
    assignmentsRes,
    bookingsRes,
    directoryRes,
    pendingRes,
  ] = await Promise.all([
    supabase
      .from("vendors")
      .select("id, name, email, phone, website, category, notes, rating, brokerage_id")
      .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
      .order("rating", { ascending: false, nullsFirst: false })
      .limit(limit),
    supabase
      .from("vendor_assignments")
      .select(`
        id, vendor_id, transaction_id, brokerage_id, assigned_by_agent_id,
        assignment_type, scheduled_date, completed_date, notes, status,
        vendors ( id, name, category ),
        transactions ( id, property_address )
      `)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("vendor_bookings")
      .select(`
        id, vendor_id, transaction_id, listing_id, contact_id, brokerage_id,
        service_type, scheduled_date, cost, status, booked_by, completed_at,
        agent_rating, notes,
        vendors ( id, name, category, rating ),
        transactions ( id, property_address )
      `)
      .eq("brokerage_id", brokerageId)
      .order("booked_at", { ascending: false })
      .limit(50),
    // ONE vendor table since m355 — curation lives on these rows.
    supabase
      .from("vendors")
      .select("id, name, category, phone, email, website, notes, rating, brokerage_id")
      .eq("brokerage_id", brokerageId)
      .order("rating", { ascending: false, nullsFirst: false }),
    supabase
      .from("vendor_bookings")
      .select(`
        id, vendor_id, transaction_id, listing_id, brokerage_id,
        service_type, scheduled_date, cost, status, completed_at,
        agent_rating, notes,
        vendors ( id, name, category, rating ),
        transactions ( id, property_address )
      `)
      .eq("brokerage_id", brokerageId)
      .eq("status", "completed")
      .is("agent_rating", null)
      .order("completed_at", { ascending: false })
      .limit(20),
  ])

  return {
    success: true,
    data: {
      vendors:        (vendorsRes.data ?? []) as VendorRow[],
      assignments:    (assignmentsRes.data ?? []) as unknown as VendorAssignmentRow[],
      recentBookings: (bookingsRes.data ?? []) as unknown as VendorBookingRow[],
      directory:      (directoryRes.data ?? []) as VendorDirectoryRow[],
      pendingRatings: (pendingRes.data ?? []) as unknown as VendorBookingRow[],
    },
  }
}

// ─── COMMAND 2: createVendorRecord ───────────────────────────────────────────
//
// Creates a new vendor in the `vendors` marketplace table.
// Rule: name + brokerage_id must not duplicate an existing active vendor (case-insensitive).
// Writes: vendors, lifecycle_events (VENDOR_RECORD_CREATED)
//
// UI Behavior: Called from "New Vendor" dialog on the Marketplace tab.
// Acceptance: { success, data: { vendorId } } on success; { success: false, error } on duplicate or DB error.

export async function createVendorRecord(
  input: CreateVendorRecordInput
): Promise<KernelVendorResult<{ vendorId: string }>> {
  const { brokerageId, agentUserId, name, category, phone, email, website, notes } = input
  if (!name.trim()) return { success: false, error: "Vendor name is required." }

  const supabase = createServiceClient()

  // Rule: case-insensitive name dedup per brokerage
  const { data: existing } = await supabase
    .from("vendors")
    .select("id, name")
    .eq("brokerage_id", brokerageId)
    .ilike("name", name.trim())
    .maybeSingle()

  if (existing) {
    return {
      success: false,
      error: `A vendor named "${existing.name}" already exists in your directory.`,
    }
  }

  // vendors.category is CHECK-constrained. Normalising here — rather than letting
  // the raw string reach the INSERT — is what turns "violates check constraint
  // vendors_category_check" into a sentence a broker can act on. toVendorCategory
  // accepts the legacy Title-Case spellings and the space/hyphen forms an import
  // or an AI extraction produces, and returns null rather than guessing.
  const resolvedCategory = category?.trim() ? toVendorCategory(category) : null
  if (category?.trim() && !resolvedCategory) {
    return {
      success: false,
      error: `"${category.trim()}" is not a service type we recognise. Choose one of: ${VENDOR_CATEGORIES.map((c) => VENDOR_CATEGORY_LABELS[c]).join(", ")}.`,
    }
  }

  const { data: vendor, error: insertError } = await supabase
    .from("vendors")
    .insert({
      brokerage_id: brokerageId,
      name:         name.trim(),
      category:     resolvedCategory,
      phone:        phone?.trim() ?? null,
      email:        email?.trim() ?? null,
      website:      website?.trim() ?? null,
      notes:        notes?.trim() ?? null,
    })
    .select("id")
    .single()

  if (insertError || !vendor) {
    return { success: false, error: insertError?.message ?? "Failed to create vendor." }
  }

  await emitLifecycleEvent(supabase, {
    brokerageId,
    actorUserId:  agentUserId,
    entityType:   "vendor",
    entityId:     vendor.id,
    event:        KernelEvent.VENDOR_RECORD_CREATED,
    metadata:     { name, category },
  })

  return { success: true, data: { vendorId: vendor.id } }
}

// ─── COMMAND 3: updateVendorRecord ───────────────────────────────────────────
//
// Updates fields on an existing vendor in the `vendors` table.
// Rule: vendorId must belong to brokerageId (ownership check).
// Writes: vendors, lifecycle_events (VENDOR_RECORD_UPDATED)
//
// UI Behavior: Called from the vendor detail edit form.
// Acceptance: { success } on success; { success: false, error } on ownership failure.

export async function updateVendorRecord(
  input: UpdateVendorRecordInput
): Promise<KernelVendorResult> {
  const { vendorId, brokerageId, agentUserId, patch } = input
  const supabase = createServiceClient()

  // Ownership check
  const { data: existing } = await supabase
    .from("vendors")
    .select("id")
    .eq("id", vendorId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!existing) {
    return { success: false, error: "Vendor not found or access denied." }
  }

  // Same CHECK, same honest refusal as the create path — a blind spread would
  // otherwise put any string a caller passed straight into a constrained column.
  const nextPatch = { ...patch }
  if (typeof nextPatch.category === "string") {
    const resolved = toVendorCategory(nextPatch.category)
    if (!resolved) {
      return {
        success: false,
        error: `"${nextPatch.category}" is not a service type we recognise. Choose one of: ${VENDOR_CATEGORIES.map((c) => VENDOR_CATEGORY_LABELS[c]).join(", ")}.`,
      }
    }
    nextPatch.category = resolved
  }

  const { error } = await supabase
    .from("vendors")
    .update(nextPatch)
    .eq("id", vendorId)
    .eq("brokerage_id", brokerageId)

  if (error) return { success: false, error: error.message }

  await emitLifecycleEvent(supabase, {
    brokerageId,
    actorUserId:  agentUserId,
    entityType:   "vendor",
    entityId:     vendorId,
    event:        KernelEvent.VENDOR_RECORD_UPDATED,
    metadata:     { updatedFields: Object.keys(patch) },
  })

  return { success: true }
}

// ─── COMMAND 4: assignVendorToListing ────────────────────────────────────────
//
// Creates a vendor_bookings row with listing_id set.
// Rule: listing must belong to brokerageId; vendor must be accessible.
// Writes: vendor_bookings, lifecycle_events (VENDOR_ASSIGNED_TO_LISTING)
//
// UI Behavior: Called from VendorManagerPanel context="listing" or the booking dialog
//              when a listingId is passed instead of a transactionId.
// Acceptance: { success, data: { bookingId } }

export async function assignVendorToListing(
  input: AssignVendorToListingInput
): Promise<KernelVendorResult<{ bookingId: string }>> {
  const { vendorId, listingId, brokerageId, agentUserId, serviceType, scheduledDate, cost, notes } = input
  const supabase = createServiceClient()

  // Verify listing ownership
  const { data: listing } = await supabase
    .from("listings")
    .select("id, address")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!listing) {
    return { success: false, error: "Listing not found or access denied." }
  }

  // Verify vendor accessibility (brokerage-specific or global)
  const { data: vendor } = await supabase
    .from("vendors")
    .select("id, name, email")
    .eq("id", vendorId)
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .maybeSingle()

  if (!vendor) {
    return { success: false, error: "Vendor not found or not accessible to this brokerage." }
  }

  const { data: booking, error: insertError } = await supabase
    .from("vendor_bookings")
    .insert({
      vendor_id:      vendorId,
      listing_id:     listingId,
      brokerage_id:   brokerageId,
      service_type:   serviceType,
      scheduled_date: scheduledDate ?? null,
      cost:           cost ?? null,
      notes:          notes ?? null,
      status:         "booked",
      booked_by:      agentUserId,
      booked_at:      new Date().toISOString(),
    })
    .select("id")
    .single()

  if (insertError || !booking) {
    return { success: false, error: insertError?.message ?? "Failed to create booking." }
  }

  await emitLifecycleEvent(supabase, {
    brokerageId,
    actorUserId:  agentUserId,
    entityType:   "vendor_booking",
    entityId:     booking.id,
    event:        KernelEvent.VENDOR_ASSIGNED_TO_LISTING,
    metadata:     { vendorId, listingId, serviceType },
  })

  // Fetch agent contact info for email
  const { data: agentProfile } = await supabase
    .from("users")
    .select("first_name, last_name, email, phone")
    .eq("id", agentUserId)
    .maybeSingle()

  // Best-effort vendor notification email
  if (vendor.email) {
    const propertyAddress = (listing as any).address ?? "the property"
    const scheduledStr = scheduledDate
      ? new Date(scheduledDate).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
      : "TBD — the agent will confirm timing shortly"
    const agentName = `${(agentProfile as any)?.first_name ?? ""} ${(agentProfile as any)?.last_name ?? ""}`.trim() || "the agent"
    const agentEmail = (agentProfile as any)?.email ?? ""
    const agentPhone = (agentProfile as any)?.phone ?? ""
    sendEmail({
      to: vendor.email,
      subject: `New Job Booked: ${serviceType} at ${propertyAddress}`,
      html: `
        <p>Hello ${vendor.name},</p>
        <p>You have been booked for a new job. Here are the details:</p>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><td style="padding:6px 0;font-weight:600;width:140px">Service</td><td>${serviceType}</td></tr>
          <tr><td style="padding:6px 0;font-weight:600">Property</td><td>${propertyAddress}</td></tr>
          <tr><td style="padding:6px 0;font-weight:600">Scheduled Date</td><td>${scheduledStr}</td></tr>
          ${notes ? `<tr><td style="padding:6px 0;font-weight:600;vertical-align:top">Notes</td><td>${notes}</td></tr>` : ""}
          <tr><td colspan="2" style="padding-top:12px;border-top:1px solid #eee"></td></tr>
          <tr><td style="padding:6px 0;font-weight:600">Booking Agent</td><td>${agentName}</td></tr>
          ${agentPhone ? `<tr><td style="padding:6px 0;font-weight:600">Agent Phone</td><td>${agentPhone}</td></tr>` : ""}
          ${agentEmail ? `<tr><td style="padding:6px 0;font-weight:600">Agent Email</td><td>${agentEmail}</td></tr>` : ""}
        </table>
        <p>Please confirm your availability by replying to this email.</p>
        <p style="color:#666;font-size:12px">Booking ID: ${booking.id}</p>
      `,
    }).catch(() => null)
  }

  return { success: true, data: { bookingId: booking.id } }
}

// ─── COMMAND 5: assignVendorToTransaction ────────────────────────────────────
//
// Creates vendor_assignments + vendor_jobs rows for a transaction.
// Rule: transaction must belong to brokerageId; vendor must be accessible.
// Writes: vendor_assignments, vendor_jobs, lifecycle_events (VENDOR_ASSIGNED_TO_TRANSACTION)
//
// UI Behavior: Called from VendorManagerPanel context="transaction" or the booking dialog
//              when a transactionId is selected.
// Acceptance: { success, data: { assignmentId, jobId } }

export async function assignVendorToTransaction(
  input: AssignVendorToTransactionInput
): Promise<KernelVendorResult<{ assignmentId: string; jobId: string }>> {
  const {
    vendorId, transactionId, brokerageId, agentUserId,
    assignmentType, scheduledDate, notes,
  } = input
  const supabase = createServiceClient()

  // Verify transaction ownership
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!transaction) {
    return { success: false, error: "Transaction not found or access denied." }
  }

  // Verify vendor accessibility
  const { data: vendor } = await supabase
    .from("vendors")
    .select("id, name, email")
    .eq("id", vendorId)
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .maybeSingle()

  if (!vendor) {
    return { success: false, error: "Vendor not found or not accessible to this brokerage." }
  }

  // Resolve agents.id from users.id for the FK constraint
  const agentId = await resolveAgentId(supabase, agentUserId, brokerageId)

  const { data: assignment, error: assignError } = await supabase
    .from("vendor_assignments")
    .insert({
      vendor_id:            vendorId,
      transaction_id:       transactionId,
      brokerage_id:         brokerageId,
      assigned_by_agent_id: agentId,
      assignment_type:      assignmentType,
      scheduled_date:       scheduledDate ?? null,
      notes:                notes ?? null,
      status:               "pending",
    })
    .select("id")
    .single()

  if (assignError || !assignment) {
    return { success: false, error: assignError?.message ?? "Failed to create assignment." }
  }

  const { data: job, error: jobError } = await supabase
    .from("vendor_jobs")
    .insert({
      assignment_id:  assignment.id,
      vendor_id:      vendorId,
      transaction_id: transactionId,
      status:         "pending",
      job_title:      `${assignmentType} — ${transaction.property_address}`,
      agent_notes:    notes ?? null,
    })
    .select("id")
    .single()

  if (jobError || !job) {
    return { success: false, error: jobError?.message ?? "Failed to create vendor job." }
  }

  await emitLifecycleEvent(supabase, {
    brokerageId,
    actorUserId:  agentUserId,
    entityType:   "vendor_assignment",
    entityId:     assignment.id,
    event:        KernelEvent.VENDOR_ASSIGNED_TO_TRANSACTION,
    metadata:     { vendorId, transactionId, assignmentType, jobId: job.id },
  })

  // DELIBERATIVE EMITTER (round 36, transaction_vendor_selection): a vendor was just
  // picked for a transaction job — the Deal Coordinator raises the governed second-look
  // referral INTO the vendor steward's domain so the pick is ARGUED (deadline/schedule
  // fit on a live closing vs what the ratings ledger actually says about this vendor),
  // with grounded positions + one bounded rebuttal round + a stated resolution on the
  // manager-trust surface. Deduped per job; best-effort — never blocks the booking.
  try {
    const { raiseReferralDeduped } = await import("@/lib/managers/cross-referral")
    await raiseReferralDeduped({
      brokerageId,
      fromManager: "deal_coordinator",
      toManager: "data_steward",
      collabDomain: "transaction_vendor_selection",
      ask: `${vendor.name} was assigned for "${assignmentType}" at ${transaction.property_address}. ` +
        `Argue the pick: the deal side's deadline/schedule fit vs the vendor book's rated track record — is this the right vendor for this job?`,
      entityType: "transaction",
      entityId: transactionId,
      payload: { vendor_id: vendorId, assignment_type: assignmentType },
      dedupe: { vendor_job_id: job.id },
    })
  } catch (err) {
    console.error("[assignVendorToTransaction] deliberative referral failed (non-blocking):", err)
  }

  // Fetch agent contact info for email
  const { data: agentProfileTxn } = await supabase
    .from("users")
    .select("first_name, last_name, email, phone")
    .eq("id", agentUserId)
    .maybeSingle()

  // Best-effort vendor notification email
  if (vendor.email) {
    const scheduledStr = scheduledDate
      ? new Date(scheduledDate).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
      : "TBD — the agent will confirm timing shortly"
    const agentName = `${(agentProfileTxn as any)?.first_name ?? ""} ${(agentProfileTxn as any)?.last_name ?? ""}`.trim() || "the agent"
    const agentEmail = (agentProfileTxn as any)?.email ?? ""
    const agentPhone = (agentProfileTxn as any)?.phone ?? ""
    sendEmail({
      to: vendor.email,
      subject: `New Job Assignment: ${assignmentType} at ${transaction.property_address}`,
      html: `
        <p>Hello ${vendor.name},</p>
        <p>You have been assigned to a transaction. Here are the details:</p>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><td style="padding:6px 0;font-weight:600;width:160px">Assignment Type</td><td>${assignmentType}</td></tr>
          <tr><td style="padding:6px 0;font-weight:600">Property Address</td><td>${transaction.property_address}</td></tr>
          <tr><td style="padding:6px 0;font-weight:600">Scheduled Date</td><td>${scheduledStr}</td></tr>
          ${notes ? `<tr><td style="padding:6px 0;font-weight:600;vertical-align:top">Notes</td><td>${notes}</td></tr>` : ""}
          <tr><td colspan="2" style="padding-top:12px;border-top:1px solid #eee"></td></tr>
          <tr><td style="padding:6px 0;font-weight:600">Assigning Agent</td><td>${agentName}</td></tr>
          ${agentPhone ? `<tr><td style="padding:6px 0;font-weight:600">Agent Phone</td><td>${agentPhone}</td></tr>` : ""}
          ${agentEmail ? `<tr><td style="padding:6px 0;font-weight:600">Agent Email</td><td>${agentEmail}</td></tr>` : ""}
        </table>
        <p>Please reply to this email to confirm your availability.</p>
        <p style="color:#666;font-size:12px">Assignment ID: ${assignment.id} | Job ID: ${job.id}</p>
      `,
    }).catch(() => null)
  }

  return { success: true, data: { assignmentId: assignment.id, jobId: job.id } }
}

// ─── COMMAND 6: updateVendorBookingStatus ────────────────────────────────────
//
// Transitions a vendor_bookings.status field.
// Rule: enforces BOOKING_STATUS_TRANSITIONS graph — no backward or invalid transitions.
//       When toStatus = "completed", sets completed_at timestamp.
//       Emits VENDOR_BOOKING_COMPLETED when terminal completed state reached.
// Writes: vendor_bookings, lifecycle_events
//
// UI Behavior: Called from vendor-bookings-panel status dropdown or VendorManagerPanel CTA.
// Acceptance: { success } on valid transition; { success: false, error } on invalid transition.

export async function updateVendorBookingStatus(
  input: UpdateVendorBookingStatusInput
): Promise<KernelVendorResult> {
  const { bookingId, brokerageId, agentUserId, toStatus, notes } = input
  const supabase = createServiceClient()

  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("id, status, vendor_id, service_type")
    .eq("id", bookingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!booking) {
    return { success: false, error: "Booking not found or access denied." }
  }

  // Enforce transition graph
  const allowed = BOOKING_STATUS_TRANSITIONS[booking.status] ?? []
  if (!allowed.includes(toStatus)) {
    return {
      success: false,
      error: `Invalid status transition: ${booking.status} → ${toStatus}. Allowed: ${allowed.join(", ") || "none (terminal state)"}`,
    }
  }

  const updatePayload: Record<string, unknown> = { status: toStatus }
  if (notes) updatePayload.notes = notes
  if (toStatus === "completed") updatePayload.completed_at = new Date().toISOString()

  const { error } = await supabase
    .from("vendor_bookings")
    .update(updatePayload)
    .eq("id", bookingId)
    .eq("brokerage_id", brokerageId)

  if (error) return { success: false, error: error.message }

  const event = toStatus === "completed"
    ? KernelEvent.VENDOR_BOOKING_COMPLETED
    : KernelEvent.VENDOR_BOOKING_CREATED   // reuse for non-terminal transitions

  await emitLifecycleEvent(supabase, {
    brokerageId,
    actorUserId:  agentUserId,
    entityType:   "vendor_booking",
    entityId:     bookingId,
    event,
    metadata:     { fromStatus: booking.status, toStatus, serviceType: booking.service_type },
  })

  return { success: true }
}

// ─── COMMAND 7: attachVendorDeliverable ──────────────────────────────────────
//
// Attaches a vendor deliverable document to a booking via client_documents.
// Rule: bookingId must exist and belong to brokerageId before writing.
// Writes: client_documents (doc_type = 'vendor_deliverable'), lifecycle_events (VENDOR_DELIVERABLE_ATTACHED)
//
// UI Behavior: "Attach Deliverable" button per booking on the Deliverables tab.
// Acceptance: { success } on success; { success: false, error } if booking not found.

export async function attachVendorDeliverable(
  input: AttachVendorDeliverableInput
): Promise<KernelVendorResult<{ documentId: string }>> {
  const { bookingId, vendorId, brokerageId, agentUserId, documentUrl, description, fileName } = input
  const supabase = createServiceClient()

  // Verify booking ownership
  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("id, vendor_id, transaction_id, listing_id, service_type")
    .eq("id", bookingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!booking) {
    return { success: false, error: "Booking not found or access denied." }
  }

  const { data: doc, error: insertError } = await supabase
    .from("client_documents")
    .insert({
      brokerage_id:  brokerageId,
      uploaded_by:   agentUserId,
      document_type: "vendor_deliverable",
      document_name: fileName ?? description,
      document_url:  documentUrl,
      notes:         description,
      // Link to the booking's transaction or listing if available
      transaction_id: booking.transaction_id ?? null,
      listing_id:     booking.listing_id ?? null,
      metadata: {
        vendor_booking_id: bookingId,
        vendor_id:         vendorId,
        service_type:      booking.service_type,
      },
    })
    .select("id")
    .single()

  if (insertError || !doc) {
    return { success: false, error: insertError?.message ?? "Failed to attach deliverable." }
  }

  await emitLifecycleEvent(supabase, {
    brokerageId,
    actorUserId:  agentUserId,
    entityType:   "vendor_booking",
    entityId:     bookingId,
    event:        KernelEvent.VENDOR_DELIVERABLE_ATTACHED,
    metadata:     { documentId: doc.id, vendorId, description, fileName },
  })

  return { success: true, data: { documentId: doc.id } }
}

// ─── COMMAND 8: loadPartnerDirectory ─────────────────────────────────────────
//
// Read-only workspace loader for the Partner Directory page.
// Returns curated brokerage directory, preferred vendors, and referral partners.
// READ-ONLY — no writes.
//
// UI Behavior: Called from the partners page RSC to hydrate the OS panels.
// Acceptance: { success, data: { directory[], preferredVendors[], referralPartners[] } }

export async function loadPartnerDirectory(
  input: LoadPartnerDirectoryInput
): Promise<KernelVendorResult<PartnerDirectoryData>> {
  const { brokerageId } = input
  const supabase = createServiceClient()

  const [directoryRes, preferredRes, referralRes] = await Promise.all([
    // ONE vendor table since m355 — curation lives on these rows.
    supabase
      .from("vendors")
      .select("id, name, category, phone, email, website, notes, rating, brokerage_id")
      .eq("brokerage_id", brokerageId)
      .order("rating", { ascending: false, nullsFirst: false }),
    supabase
      .from("vendors")
      .select("id, name, email, phone, website, category, notes, rating, brokerage_id")
      .eq("brokerage_id", brokerageId)
      .order("rating", { ascending: false, nullsFirst: false })
      .limit(50),
    supabase
      .from("referral_partners")
      // No contact_name/contact_email/contact_phone/status columns: name→company_name,
      // email/phone are flat, status→active (boolean). Aliased to preserve the row shape.
      .select("id, brokerage_id, partner_name, partner_type, contact_name:company_name, contact_email:email, contact_phone:phone, status:active, notes")
      .eq("brokerage_id", brokerageId)
      .order("partner_name"),
  ])

  return {
    success: true,
    data: {
      directory:        (directoryRes.data ?? []) as VendorDirectoryRow[],
      preferredVendors: (preferredRes.data ?? []) as VendorRow[],
      referralPartners: (referralRes.data ?? []) as ReferralPartnerRow[],
    },
  }
}
