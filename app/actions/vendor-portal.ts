"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { requireVendorActor, PortalAuthError } from "@/lib/kernel/portal-auth"

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR BOOKING ACCEPT / DECLINE (Vendor Portal)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Accept a vendor booking — vendor confirms they'll take the job. Fires the
 * canonical VENDOR_BOOKING_CREATED kernel event with accept_or_decline
 * metadata so the agent, buyer, seller, and TC portals all see the status
 * update without polling.
 */
export async function acceptVendorBookingAction(params: {
  bookingId: string
  vendorId:  string
  scheduledDate?: string
}): Promise<{ success: boolean; error?: string }> {
  // Auth gate: verifies auth.user maps to user_role_assignments row that
  // owns the claimed vendorId. Closes the bypass where any vendor user
  // could pass another vendor's id.
  let actor
  try {
    actor = await requireVendorActor(params.vendorId)
  } catch (err) {
    if (err instanceof PortalAuthError) return { success: false, error: err.message }
    throw err
  }

  const supabase = await createClient()
  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("id, transaction_id, brokerage_id, vendor_id, status")
    .eq("id", params.bookingId)
    .eq("vendor_id", actor.vendorId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (!booking) return { success: false, error: "Booking not found in your scope" }
  if (booking.status !== "pending") {
    return { success: false, error: `Cannot accept — status is ${booking.status}` }
  }

  const updatePayload: Record<string, unknown> = { status: "scheduled" }
  if (params.scheduledDate) updatePayload.scheduled_date = params.scheduledDate

  const { error } = await supabase
    .from("vendor_bookings")
    .update(updatePayload)
    .eq("id", params.bookingId)
    .eq("vendor_id", actor.vendorId)

  if (error) return { success: false, error: error.message }

  if (booking.transaction_id) {
    try {
      const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
      await emitTransactionEvent({
        event:       KernelEvent.VENDOR_BOOKING_CREATED,
        brokerageId: actor.brokerageId,
        entityId:    booking.transaction_id,
        actorUserId: actor.userId,
        metadata: {
          booking_id:        params.bookingId,
          vendor_id:         actor.vendorId,
          scheduled_date:    params.scheduledDate ?? null,
          accept_or_decline: "accepted",
        },
      })
    } catch (err) {
      console.error("[acceptVendorBookingAction] fan-out failed (non-blocking)", err)
    }
  }

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/vendor/jobs")
  revalidatePath("/vendor/dashboard")
  return { success: true }
}

/**
 * Decline a vendor booking — vendor passes on the job. Brokerage gets
 * notified so they can route to another vendor.
 */
export async function declineVendorBookingAction(params: {
  bookingId: string
  vendorId:  string
  reason?:   string
}): Promise<{ success: boolean; error?: string }> {
  let actor
  try {
    actor = await requireVendorActor(params.vendorId)
  } catch (err) {
    if (err instanceof PortalAuthError) return { success: false, error: err.message }
    throw err
  }

  const supabase = await createClient()
  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("id, transaction_id, brokerage_id, vendor_id, status")
    .eq("id", params.bookingId)
    .eq("vendor_id", actor.vendorId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (!booking) return { success: false, error: "Booking not found in your scope" }
  if (booking.status !== "pending") {
    return { success: false, error: `Cannot decline — status is ${booking.status}` }
  }

  const { error } = await supabase
    .from("vendor_bookings")
    .update({
      status: "cancelled",
      notes:  params.reason ? `Declined: ${params.reason}` : "Declined by vendor",
    })
    .eq("id", params.bookingId)
    .eq("vendor_id", actor.vendorId)

  if (error) return { success: false, error: error.message }

  if (booking.transaction_id) {
    try {
      const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
      await emitTransactionEvent({
        event:       KernelEvent.VENDOR_BOOKING_CREATED,
        brokerageId: actor.brokerageId,
        entityId:    booking.transaction_id,
        actorUserId: actor.userId,
        metadata: {
          booking_id:        params.bookingId,
          vendor_id:         actor.vendorId,
          accept_or_decline: "declined",
          decline_reason:    params.reason ?? null,
        },
      })
    } catch (err) {
      console.error("[declineVendorBookingAction] fan-out failed (non-blocking)", err)
    }
  }

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/vendor/jobs")
  revalidatePath("/vendor/dashboard")
  return { success: true }
}

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR JOB MANAGEMENT (Vendor Portal)
// ═══════════════════════════════════════════════════════════════════════════

// Helper: auth-gate vendor-side action. Wraps requireVendorActor with
// PortalAuthError -> friendly { success:false } shape.
async function gateVendor(vendorId: string): Promise<
  | { ok: true; userId: string; vendorId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  try {
    const actor = await requireVendorActor(vendorId)
    return { ok: true, ...actor }
  } catch (err) {
    if (err instanceof PortalAuthError) return { ok: false, error: err.message }
    throw err
  }
}

export async function getVendorJobs(vendorId: string) {
  // Auth gate — previously open, so any caller could enumerate any
  // vendor's job book (job titles, costs, agent notes, vendor notes,
  // scheduled dates, transaction property addresses) by passing the
  // vendor id.
  const gate = await gateVendor(vendorId)
  if (!gate.ok) return []

  const supabase = await createClient()

  const { data: jobs, error } = await supabase
    .from("vendor_jobs")
    .select(`
      id,
      assignment_id,
      vendor_id,
      job_title,
      status,
      cost_estimate,
      cost_actual,
      agent_notes,
      vendor_notes,
      created_at,
      updated_at,
      vendor_assignments:assignment_id(
        id,
        transaction_id,
        scheduled_date,
        transactions:transaction_id(id, property_address)
      )
    `)
    .eq("vendor_id", gate.vendorId)
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })

  if (error) throw error
  return jobs || []
}

export async function updateVendorJobStatus(data: {
  jobId: string
  vendorId: string
  status: string
}) {
  const gate = await gateVendor(data.vendorId)
  if (!gate.ok) throw new Error(gate.error)

  const supabase = await createClient()

  const { data: job, error: updateError } = await supabase
    .from("vendor_jobs")
    .update({
      status: data.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.jobId)
    .eq("vendor_id", gate.vendorId)
    .eq("brokerage_id", gate.brokerageId)
    .select()
    .maybeSingle()

  if (updateError) throw updateError
  if (!job) throw new Error("Job not found in your scope")

  // If job is completed, also update the parent assignment — scoped
  if (data.status === "completed" && job.assignment_id) {
    await supabase
      .from("vendor_assignments")
      .update({
        status: "completed",
      })
      .eq("id", job.assignment_id)
      .eq("vendor_id", gate.vendorId)
      .eq("brokerage_id", gate.brokerageId)
  }

  return job
}


export async function addVendorJobNote(data: {
  jobId: string
  vendorId: string
  note: string
}) {
  const gate = await gateVendor(data.vendorId)
  if (!gate.ok) throw new Error(gate.error)

  const supabase = await createClient()

  const { data: job, error } = await supabase
    .from("vendor_jobs")
    .update({
      vendor_notes: data.note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.jobId)
    .eq("vendor_id", gate.vendorId)
    .eq("brokerage_id", gate.brokerageId)
    .select()
    .maybeSingle()

  if (error) throw error
  if (!job) throw new Error("Job not found in your scope")

  // Emit kernel event scoped to verified brokerage
  await supabase.from("lifecycle_events").insert({
    brokerage_id: gate.brokerageId,
    event_type: KernelEvent.PORTAL_MODULE_VIEWED,
    entity_type: "vendor_job",
    entity_id: data.jobId,
    metadata: {
      vendor_id: gate.vendorId,
      action: "note_added",
    },
    created_at: new Date().toISOString(),
  })

  return job
}

export async function updateVendorJobCost(data: {
  jobId: string
  vendorId: string
  costActual: number
}) {
  const gate = await gateVendor(data.vendorId)
  if (!gate.ok) throw new Error(gate.error)

  const supabase = await createClient()

  const { data: job, error } = await supabase
    .from("vendor_jobs")
    .update({
      cost_actual: data.costActual,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.jobId)
    .eq("vendor_id", gate.vendorId)
    .eq("brokerage_id", gate.brokerageId)
    .select()
    .maybeSingle()

  if (error) throw error
  if (!job) throw new Error("Job not found in your scope")
  return job
}

export async function uploadVendorJobDocument(data: {
  jobId: string
  transactionId: string
  vendorId: string
  documentType: string
  fileName: string
  fileData: Buffer | string
}) {
  const gate = await gateVendor(data.vendorId)
  if (!gate.ok) throw new Error(gate.error)

  const supabase = await createClient()

  // Verify the job belongs to this vendor + brokerage AND links to this
  // transaction (via vendor_assignments). Without this, a vendor could
  // upload documents to any transaction in the brokerage.
  const { data: jobRow } = await supabase
    .from("vendor_jobs")
    .select("id, vendor_assignments:assignment_id(transaction_id)")
    .eq("id", data.jobId)
    .eq("vendor_id", gate.vendorId)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  const linkedTransactionId = (jobRow?.vendor_assignments as any)?.transaction_id
  if (!jobRow || linkedTransactionId !== data.transactionId) {
    throw new Error("Job not linked to this transaction in your scope")
  }

  // Also verify the transaction is in the caller's brokerage (defense in depth)
  const { data: txRow } = await supabase
    .from("transactions").select("brokerage_id").eq("id", data.transactionId).maybeSingle()
  if (!txRow || txRow.brokerage_id !== gate.brokerageId) {
    throw new Error("Transaction not in your scope")
  }

  // Create document record — use correct transaction_documents schema
  const { data: document, error: docError } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      brokerage_id: gate.brokerageId,
      doc_type: data.documentType,
      doc_label: data.fileName,
      status: "uploaded",
      uploaded_by: gate.userId,
    })
    .select()
    .maybeSingle()

  if (docError) throw docError

  await supabase.from("lifecycle_events").insert({
    brokerage_id: gate.brokerageId,
    event_type: KernelEvent.DOCUMENT_UPLOADED,
    entity_type: "vendor_job_document",
    entity_id: document.id,
    metadata: {
      job_id: data.jobId,
      vendor_id: gate.vendorId,
      document_type: data.documentType,
    },
    created_at: new Date().toISOString(),
  })

  return document
}

export async function sendVendorMessageToAgent(data: {
  jobId: string
  transactionId: string
  vendorId: string
  message: string
}) {
  const gate = await gateVendor(data.vendorId)
  if (!gate.ok) throw new Error(gate.error)

  const supabase = await createClient()

  // Verify transaction belongs to caller's brokerage AND the vendor has
  // a job linked to this transaction (prevents spamming arbitrary
  // tenants' transaction inboxes).
  const { data: txRow } = await supabase
    .from("transactions").select("brokerage_id").eq("id", data.transactionId).maybeSingle()
  if (!txRow || txRow.brokerage_id !== gate.brokerageId) {
    throw new Error("Transaction not in your scope")
  }
  const { data: jobLink } = await supabase
    .from("vendor_jobs")
    .select("id, vendor_assignments:assignment_id(transaction_id)")
    .eq("id", data.jobId)
    .eq("vendor_id", gate.vendorId)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  if (!jobLink || (jobLink.vendor_assignments as any)?.transaction_id !== data.transactionId) {
    throw new Error("Job not linked to this transaction")
  }

  // Create message routing to agent
  const { error: msgError } = await supabase
    .from("client_portal_messages")
    .insert({
      brokerage_id: gate.brokerageId,
      transaction_id: data.transactionId,
      direction: "inbound",
      body: `[Vendor Message] ${data.message}`,
      created_at: new Date().toISOString(),
      metadata: {
        from_vendor_id: gate.vendorId,
        from_job_id: data.jobId,
      },
    })

  if (msgError) throw msgError

  await supabase.from("lifecycle_events").insert({
    brokerage_id: gate.brokerageId,
    event_type: KernelEvent.MESSAGE_CREATED,
    entity_type: "vendor_message",
    entity_id: data.jobId,
    metadata: {
      vendor_id: gate.vendorId,
      transaction_id: data.transactionId,
    },
    created_at: new Date().toISOString(),
  })

  return { success: true }
}
