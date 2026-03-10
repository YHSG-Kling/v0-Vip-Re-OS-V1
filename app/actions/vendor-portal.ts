import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

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
    .single()

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
    .single()

  if (error) throw error

  // Emit kernel event
  await supabase.from("kernel_event_log").insert({
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
    .single()

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

  // Create document record
  const { data: document, error: docError } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      document_type: data.documentType,
      file_name: data.fileName,
      vendor_id: data.vendorId,
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (docError) throw docError

  // Emit kernel event
  await supabase.from("kernel_event_log").insert({
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

  // Emit kernel event
  await supabase.from("kernel_event_log").insert({
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
