"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("id, transaction_id, brokerage_id, vendor_id, status")
    .eq("id", params.bookingId)
    .maybeSingle()
  if (!booking) return { success: false, error: "Booking not found" }
  if (booking.vendor_id !== params.vendorId) {
    return { success: false, error: "Not authorized for this booking" }
  }
  if (booking.status !== "pending") {
    return { success: false, error: `Cannot accept — status is ${booking.status}` }
  }

  const updatePayload: Record<string, unknown> = { status: "scheduled" }
  if (params.scheduledDate) updatePayload.scheduled_date = params.scheduledDate

  const { error } = await supabase
    .from("vendor_bookings")
    .update(updatePayload)
    .eq("id", params.bookingId)
    .eq("vendor_id", params.vendorId)

  if (error) return { success: false, error: error.message }

  if (booking.transaction_id) {
    try {
      const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
      await emitTransactionEvent({
        event:       KernelEvent.VENDOR_BOOKING_CREATED,
        brokerageId: booking.brokerage_id,
        entityId:    booking.transaction_id,
        actorUserId: user.id,
        metadata: {
          booking_id:        params.bookingId,
          vendor_id:         params.vendorId,
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("id, transaction_id, brokerage_id, vendor_id, status")
    .eq("id", params.bookingId)
    .maybeSingle()
  if (!booking) return { success: false, error: "Booking not found" }
  if (booking.vendor_id !== params.vendorId) {
    return { success: false, error: "Not authorized for this booking" }
  }
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
    .eq("vendor_id", params.vendorId)

  if (error) return { success: false, error: error.message }

  if (booking.transaction_id) {
    try {
      const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
      await emitTransactionEvent({
        event:       KernelEvent.VENDOR_BOOKING_CREATED,
        brokerageId: booking.brokerage_id,
        entityId:    booking.transaction_id,
        actorUserId: user.id,
        metadata: {
          booking_id:        params.bookingId,
          vendor_id:         params.vendorId,
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

export async function getVendorJobs(vendorId: string) {
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
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })

  if (error) throw error
  return jobs || []
}

export async function updateVendorJobStatus(data: {
  jobId: string
  vendorId: string
  status: string
}) {
  const supabase = await createClient()

  const { data: job, error: updateError } = await supabase
    .from("vendor_jobs")
    .update({
      status: data.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.jobId)
    .eq("vendor_id", data.vendorId)
    .select()
    .maybeSingle()

  if (updateError) throw updateError

  // If job is completed, also update the parent assignment
  if (data.status === "completed") {
    await supabase
      .from("vendor_assignments")
      .update({
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.assignment_id)
  }

  return job
}


export async function addVendorJobNote(data: {
  jobId: string
  vendorId: string
  note: string
}) {
  const supabase = await createClient()

  const { data: job, error } = await supabase
    .from("vendor_jobs")
    .update({
      vendor_notes: data.note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.jobId)
    .eq("vendor_id", data.vendorId)
    .select()
    .maybeSingle()

  if (error) throw error

  // Emit kernel event - get brokerage from vendor
  const { data: vendorData } = await supabase.from("vendors").select("brokerage_id").eq("id", data.vendorId).maybeSingle()
  await supabase.from("lifecycle_events").insert({
    brokerage_id: vendorData?.brokerage_id,
    event_type: KernelEvent.PORTAL_MODULE_VIEWED,
    entity_type: "vendor_job",
    entity_id: data.jobId,
    metadata: {
      vendor_id: data.vendorId,
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
  const supabase = await createClient()

  const { data: job, error } = await supabase
    .from("vendor_jobs")
    .update({
      cost_actual: data.costActual,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.jobId)
    .eq("vendor_id", data.vendorId)
    .select()
    .maybeSingle()

  if (error) throw error
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
  const supabase = await createClient()

  // Create document record — use correct transaction_documents schema
  const { data: document, error: docError } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      doc_type: data.documentType,
      doc_label: data.fileName,
      status: "uploaded",
      uploaded_by: data.vendorId,
    })
    .select()
    .maybeSingle()

  if (docError) throw docError

  // Emit kernel event - get brokerage from transaction
  const { data: txnDoc } = await supabase.from("transactions").select("brokerage_id").eq("id", data.transactionId).maybeSingle()
  await supabase.from("lifecycle_events").insert({
    brokerage_id: txnDoc?.brokerage_id,
    event_type: KernelEvent.DOCUMENT_UPLOADED,
    entity_type: "vendor_job_document",
    entity_id: document.id,
    metadata: {
      job_id: data.jobId,
      vendor_id: data.vendorId,
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
  const supabase = await createClient()

  // Create message routing to agent
  const { error: msgError } = await supabase
    .from("client_portal_messages")
    .insert({
      transaction_id: data.transactionId,
      direction: "inbound",
      body: `[Vendor Message] ${data.message}`,
      created_at: new Date().toISOString(),
      metadata: {
        from_vendor_id: data.vendorId,
        from_job_id: data.jobId,
      },
    })

  if (msgError) throw msgError

  // Emit kernel event - get brokerage from transaction
  const { data: txnMsg } = await supabase.from("transactions").select("brokerage_id").eq("id", data.transactionId).maybeSingle()
  await supabase.from("lifecycle_events").insert({
    brokerage_id: txnMsg?.brokerage_id,
    event_type: KernelEvent.MESSAGE_CREATED,
    entity_type: "vendor_message",
    entity_id: data.jobId,
    metadata: {
      vendor_id: data.vendorId,
      transaction_id: data.transactionId,
    },
    created_at: new Date().toISOString(),
  })

  return { success: true }
}
