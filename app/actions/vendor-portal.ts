"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { requireVendorActor, PortalAuthError } from "@/lib/kernel/portal-auth"
import { signedDocUrl } from "@/lib/storage/signed-doc-url"

// ─── Upload helpers (module-private — a "use server" file may only EXPORT
//     async functions, and these are deliberately not endpoints) ─────────────

/**
 * Accept what a browser server-action call can actually carry (base64, or a
 * `data:` URL) as well as raw bytes from a server-to-server caller. Returns
 * null when the payload is unusable rather than throwing, so the caller owns
 * the error message.
 */
function decodeUploadPayload(input: Buffer | Uint8Array | string): Buffer | null {
  if (typeof input !== "string") {
    return Buffer.isBuffer(input) ? input : Buffer.from(input)
  }
  const raw = input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input
  if (!raw) return null
  try {
    const buf = Buffer.from(raw, "base64")
    return buf.length > 0 ? buf : null
  } catch {
    return null
  }
}

/**
 * `fileName` is caller-supplied and becomes part of a storage key. Strip every
 * path separator and traversal segment so an upload cannot be aimed outside
 * its tenant prefix, and keep the name short enough to be a valid key.
 */
function sanitizeStoredFileName(fileName: string): string {
  const base = String(fileName ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop() ?? ""
  const cleaned = base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim()
  return cleaned.slice(0, 120) || "document"
}

function guessContentType(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
  const map: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    heic: "image/heic",
    webp: "image/webp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    txt: "text/plain",
  }
  return map[ext] ?? "application/octet-stream"
}

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
  // LIVE-SCHEMA VOCABULARY (caught by the pilot simulation): vendor_bookings.status
  // CHECK allows booked/confirmed/completed/cancelled/no_show — every creator inserts
  // 'booked'; this gate demanded a 'pending' that can never exist and wrote a
  // 'scheduled' the CHECK rejects, so accept ALWAYS failed. Consolidated: booked → confirmed.
  if (booking.status !== "booked") {
    return { success: false, error: `Cannot accept — status is ${booking.status}` }
  }

  const updatePayload: Record<string, unknown> = { status: "confirmed" }
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
  // Same live-vocabulary fix as accept: a declinable booking is 'booked'.
  if (booking.status !== "booked") {
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

/** 25 MB — a vendor uploads inspection reports and invoices, not video. */
const VENDOR_DOC_MAX_BYTES = 25 * 1024 * 1024

/**
 * Vendor attaches a document to a transaction job.
 *
 * The scope gates here were already correct (vendor actor → job in the
 * vendor's scope → job's assignment links to THIS transaction → transaction in
 * the same brokerage). What was missing was the upload itself.
 *
 * BEFORE (w2s3): `fileData` was accepted and then **never referenced**. The
 * function inserted a `transaction_documents` row with `status: "uploaded"`
 * and left `storage_url` NULL — a record asserting a file exists when no file
 * was ever stored. That is not cosmetic: `lib/transactions/coordination-status.ts`
 * reads `transaction_documents.status`, so the transaction checklist would mark
 * the document as received and the coordination status would advance on a
 * document nobody can open.
 *
 * Now the bytes are actually written to the PRIVATE `transaction-documents`
 * bucket first, and the row is only inserted once the object exists — and if
 * the row insert then fails, the orphaned object is swept.
 */
export async function uploadVendorJobDocument(data: {
  jobId: string
  transactionId: string
  vendorId: string
  documentType: string
  fileName: string
  /** Base64 (optionally a `data:` URL) from a browser caller, or raw bytes server-side. */
  fileData: Buffer | Uint8Array | string
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

  // ─── Store the bytes BEFORE claiming the document exists ──────────────────

  const bytes = decodeUploadPayload(data.fileData)
  if (!bytes || bytes.length === 0) {
    throw new Error("No file content was received")
  }
  if (bytes.length > VENDOR_DOC_MAX_BYTES) {
    throw new Error(`That file is larger than the ${Math.floor(VENDOR_DOC_MAX_BYTES / (1024 * 1024))}MB limit`)
  }

  // `fileName` is caller-supplied and goes into a storage KEY, so strip any
  // path structure — "../../other-tenant/x.pdf" must not escape the prefix.
  const safeName = sanitizeStoredFileName(data.fileName)

  // Tenant + transaction are baked into the prefix so an object can never be
  // written outside the caller's brokerage even if a key were guessed.
  const objectPath = `vendor-jobs/${gate.brokerageId}/${data.transactionId}/${crypto.randomUUID()}-${safeName}`

  // PRIVATE bucket (verified live: storage.buckets.public = false). Vendor job
  // documents are deal files — inspection reports, invoices — and must not be
  // world-readable, so this is deliberately not the public `documents` bucket.
  const { error: uploadError } = await supabase.storage
    .from("transaction-documents")
    .upload(objectPath, bytes, {
      contentType: guessContentType(safeName),
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`The file could not be stored — ${uploadError.message}`)
  }

  const storageUrl = await signedDocUrl(supabase, "transaction-documents", objectPath)

  // Create document record — use correct transaction_documents schema
  const { data: document, error: docError } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      brokerage_id: gate.brokerageId,
      doc_type: data.documentType,
      doc_label: safeName,
      status: "uploaded",
      storage_url: storageUrl || null,
      uploaded_by: gate.userId,
      uploaded_by_type: "vendor",
      uploaded_at: new Date().toISOString(),
      metadata: { job_id: data.jobId, vendor_id: gate.vendorId, storage_path: objectPath },
    })
    .select()
    .maybeSingle()

  // Do not leave an orphaned object behind a failed row — otherwise every
  // retry adds another unreferenced copy of a confidential file.
  if (docError || !document) {
    await supabase.storage.from("transaction-documents").remove([objectPath]).catch(() => {})
    throw docError ?? new Error("The document record could not be created")
  }

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
      direction: "client_to_agent",
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
