import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { milestoneJourneyFor } from "@/lib/transactions/milestone-catalog"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { runPipelineSimple } from "@/lib/ai"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

// ============================================
// HELPERS
// ============================================

/**
 * Normalize ZIP codes to standard formats:
 * - "12345" → "12345" (5-digit unchanged)
 * - "12345 6789" → "12345-6789" (9-digit with space)
 * - "123456789" → "12345-6789" (9-digit without separator)
 */
function normalizeZip(zip?: string): string | undefined {
  if (!zip) return undefined
  const cleaned = zip.replace(/\s+/g, '').replace(/[^0-9]/g, '')
  if (cleaned.length === 5) return cleaned
  if (cleaned.length === 9) return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`
  return zip.trim()
}

// ============================================
// TRANSACTION CRUD
// ============================================

export async function getTransactions(filters?: {
  status?: string
  agent_id?: string
  agentId?: string
  brokerage_id?: string
}) {
  const agentIdValue = filters?.agent_id || filters?.agentId
  const supabase = await createClient()

  let query = supabase
    .from("transactions")
    .select(`
      *,
      transaction_milestones(*),
      transaction_participants(*),
      transaction_deadlines(*)
    `)
    .order("created_at", { ascending: false })

  if (filters?.status) query = query.eq("status", filters.status)
  if (agentIdValue) query = query.eq("agent_id", agentIdValue)
  if (filters?.brokerage_id) query = query.eq("brokerage_id", filters.brokerage_id)

  const { data, error } = await query
  if (error) {
    console.error("Error fetching transactions:", error)
    return { success: false, error: error.message }
  }
  return { success: true, data }
}

export async function getTransactionById(transactionId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transactions")
    .select(`
      *,
      transaction_milestones(*),
      transaction_participants(*),
      transaction_lenders(*),
      transaction_title_escrow(*),
      transaction_inspections(*),
      transaction_vendor_services(*),
      transaction_documents(*),
      transaction_timeline(*),
      transaction_deadlines(*),
      transaction_commissions(*),
      transaction_repair_negotiations(*)
    `)
    .eq("id", transactionId)
    .single()

  if (error) {
    console.error("Error fetching transaction:", error)
    return { success: false, error: error.message }
  }
  return { success: true, data }
}

export async function createTransaction(transactionData: {
  property_address: string
  property_city?: string
  property_state?: string // 2-letter US state code, e.g. "FL", "CA", "TX"
  property_zip?: string
  transaction_type: "purchase" | "sale" | "lease" | "dual"
  status?: string
  contract_price?: number
  listing_price?: number
  client_name?: string
  client_email?: string
  client_phone?: string
  agent_id?: string
  brokerage_id?: string
  contact_id?: string
  close_date?: string
  notes?: string
  commissionPercentage?: number
}) {
  const supabase = await createClient()

  // Map the UI/legacy input contract onto live schema columns. The old code
  // spread the input directly, which wrote columns that don't exist
  // (transaction_type, contract_price, client_email, listing_price, notes),
  // used an invalid status ("new"), and omitted the NOT NULL deal_name — so the
  // insert always failed. deal_type CHECK is {buyer,seller,dual}.
  const DEAL_TYPE_MAP: Record<string, "buyer" | "seller" | "dual"> = {
    purchase: "buyer",
    sale: "seller",
    lease: "dual",
    dual: "dual",
  }
  const { data, error } = await supabase
    .from("transactions")
    .insert({
      brokerage_id:          transactionData.brokerage_id ?? null,
      agent_id:              transactionData.agent_id ?? null,
      contact_id:            transactionData.contact_id ?? null,  // primary client (hangs off a contact)
      deal_name:             transactionData.property_address, // NOT NULL
      deal_type:             DEAL_TYPE_MAP[transactionData.transaction_type] ?? "dual",
      status:                transactionData.status || "active",
      property_address:      transactionData.property_address,
      property_city:         transactionData.property_city ?? null,
      property_state:        transactionData.property_state ?? null,
      property_zip:          normalizeZip(transactionData.property_zip),
      purchase_price:        transactionData.contract_price ?? transactionData.listing_price ?? null,
      close_date:            transactionData.close_date ?? null,
      client_name:           transactionData.client_name ?? null,
      commission_percentage: transactionData.commissionPercentage ?? null,
    })
    .select()
    .single()

  if (error) {
    console.error("Error creating transaction:", error)
    return { success: false, error: error.message }
  }

  if (data) {
    await generateMilestones(data.id, transactionData.transaction_type)

    if (transactionData.commissionPercentage != null) {
      const { data: userData } = await supabase.auth.getUser()
      const { data: profile } = await supabase
        .from("users")
        .select("brokerage_id")
        .eq("id", userData.user?.id)
        .single()

      if (profile?.brokerage_id) {
        await transitionLifecycle({
          brokerageId: profile.brokerage_id,
          entityType:  "transaction",
          entityId:    data.id,
          fromState:   "active",
          toState:     "commission_overridden",
          actorUserId: userData.user?.id ?? '',
          actorRole:   "broker",
          eventType:   "commission.overridden",
          metadata:    { commission_percentage: transactionData.commissionPercentage, resolved_from: "deal_override" },
        })
      }
    }
  }

  revalidatePath("/dashboard/transactions")
  return { success: true, data }
}

export async function updateTransaction(
  transactionId: string,
  updates: Partial<{
    property_address: string
    property_city: string
    property_state: string
    property_zip: string
    transaction_type: string
    status: string
    contract_price: number
    listing_price: number
    client_name: string
    client_email: string
    client_phone: string
    agent_id: string
    contract_date: string
    close_date: string
    notes: string
    commissionPercentage: number
  }>,
) {
  const supabase = await createClient()

  const updatePayload: any = { ...updates, updated_at: new Date().toISOString() }
  if (updates.commissionPercentage !== undefined) {
    updatePayload.commission_percentage = updates.commissionPercentage
    delete updatePayload.commissionPercentage
  }
  if (updates.property_zip !== undefined) {
    updatePayload.property_zip = normalizeZip(updates.property_zip)
  }

  const { data, error } = await supabase
    .from("transactions")
    .update(updatePayload)
    .eq("id", transactionId)
    .select()
    .single()

  if (error) {
    console.error("Error updating transaction:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(transactionId, "transaction_updated", "Transaction details updated")
  revalidatePath("/dashboard/transactions")
  revalidatePath(`/dashboard/transactions/${transactionId}`)
  return { success: true, data }
}

// ============================================
// MILESTONES
// ============================================

export async function generateMilestones(transactionId: string, transactionType: string) {
  const supabase = await createClient()

  // Build the journey from the SINGLE canonical catalog (milestone-catalog.ts), so a
  // directly-created transaction gets the SAME canonical identities, display names, and
  // curated visibility as one created via the offer→transaction bridge. milestone_type
  // carries the stable identity (drives education/reporting/calendar); milestone_name is
  // the human label; is_client_visible is the curated default (agent-overridable).
  const journey = milestoneJourneyFor(transactionType)
  const milestonesWithTransactionId = journey.map((m) => ({
    transaction_id: transactionId,
    milestone_name: m.name,
    milestone_type: m.id,
    is_client_visible: m.clientVisible,
    status: "pending",
  }))

  const { error } = await supabase.from("transaction_milestones").insert(milestonesWithTransactionId)
  if (error) {
    console.error("Error generating milestones:", error)
    return { success: false, error: error.message }
  }
  return { success: true }
}

export async function completeMilestone(milestoneId: string, completedBy?: string, notes?: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("transaction_milestones")
    .update({ status: "completed", completed_at: new Date().toISOString(), completed_by: completedBy, notes })
    .eq("id", milestoneId)
    .select("*, transactions(id)")
    .single()

  if (error) {
    console.error("Error completing milestone:", error)
    return { success: false, error: error.message }
  }

  if (data?.transactions?.id) {
    await addTimelineEntry(data.transactions.id, "milestone_completed", `Milestone "${data.milestone_name}" completed`)
    revalidatePath(`/dashboard/transactions/${data.transactions.id}`)
  }

  revalidatePath("/dashboard/transactions")
  return { success: true, data }
}

export async function getTransactionMilestones(transactionId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_milestones")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("target_date", { ascending: true })

  if (error) {
    console.error("Error getting milestones:", error)
    return { success: false, error: error.message }
  }
  return { success: true, milestones: data || [] }
}

export async function updateMilestone(
  milestoneId: string,
  updates: Partial<{ status: string; target_date: string; notes: string; assigned_to: string }>,
) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_milestones")
    .update(updates)
    .eq("id", milestoneId)
    .select()
    .single()

  if (error) {
    console.error("Error updating milestone:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/dashboard/transactions")
  return { success: true, data }
}

export async function getClosingChecklist(transactionId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("closing_checklist_items")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("sequence", { ascending: true })

  if (error) {
    console.error("Error getting checklist:", error)
    return { success: false, error: error.message }
  }
  return { success: true, items: data || [] }
}

export async function updateChecklistItem(itemId: string, completed: boolean) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("closing_checklist_items")
    .update({ completed, completed_at: completed ? new Date().toISOString() : null })
    .eq("id", itemId)
    .select()
    .single()

  if (error) {
    console.error("Error updating checklist item:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// PARTICIPANTS
// ============================================

export async function addParticipant(participantData: {
  transaction_id: string
  role: string
  name: string
  company?: string
  email?: string
  phone?: string
  license_number?: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase.from("transaction_participants").insert(participantData).select().single()

  if (error) {
    console.error("Error adding participant:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(
    participantData.transaction_id,
    "participant_added",
    `${participantData.role} "${participantData.name}" added to transaction`,
  )

  revalidatePath("/transactions")
  return { success: true, data }
}

export async function updateParticipant(
  participantId: string,
  updates: Partial<{
    role: string; name: string; company: string; email: string
    phone: string; license_number: string; notes: string
  }>,
) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_participants")
    .update(updates)
    .eq("id", participantId)
    .select()
    .single()

  if (error) {
    console.error("Error updating participant:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function removeParticipant(participantId: string) {
  const supabase = await createClient()
  const { error } = await supabase.from("transaction_participants").delete().eq("id", participantId)

  if (error) {
    console.error("Error removing participant:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true }
}

// ============================================
// LENDERS
// ============================================

export async function addLender(lenderData: {
  transaction_id: string
  lender_name: string
  loan_officer_name?: string
  loan_officer_email?: string
  loan_officer_phone?: string
  loan_type?: string
  loan_amount?: number
  interest_rate?: number
  loan_term_years?: number
  pre_approval_date?: string
  pre_approval_amount?: number
  appraisal_ordered_date?: string
  appraisal_completed_date?: string
  appraisal_value?: number
  underwriting_status?: string
  clear_to_close_date?: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase.from("transaction_lenders").insert(lenderData).select().single()

  if (error) {
    console.error("Error adding lender:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(lenderData.transaction_id, "lender_added", `Lender "${lenderData.lender_name}" added`)
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function updateLender(
  lenderId: string,
  updates: Partial<{
    lender_name: string; loan_officer_name: string; loan_officer_email: string
    loan_officer_phone: string; loan_type: string; loan_amount: number
    interest_rate: number; loan_term_years: number; pre_approval_date: string
    pre_approval_amount: number; appraisal_ordered_date: string
    appraisal_completed_date: string; appraisal_value: number
    underwriting_status: string; clear_to_close_date: string; notes: string
  }>,
) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_lenders")
    .update(updates)
    .eq("id", lenderId)
    .select()
    .single()

  if (error) {
    console.error("Error updating lender:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// TITLE & ESCROW
// ============================================

export async function addTitleEscrow(data: {
  transaction_id: string
  title_company_name: string
  title_officer_name?: string
  title_officer_email?: string
  title_officer_phone?: string
  escrow_company_name?: string
  escrow_officer_name?: string
  escrow_officer_email?: string
  escrow_officer_phone?: string
  escrow_number?: string
  title_search_ordered_date?: string
  title_search_completed_date?: string
  title_commitment_date?: string
  title_issues?: string
  earnest_money_amount?: number
  earnest_money_held_by?: string
  earnest_money_received_date?: string
  closing_scheduled_date?: string
  closing_location?: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data: result, error } = await supabase.from("transaction_title_escrow").insert(data).select().single()

  if (error) {
    console.error("Error adding title/escrow:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(data.transaction_id, "title_escrow_added", `Title company "${data.title_company_name}" assigned`)
  revalidatePath("/transactions")
  return { success: true, data: result }
}

export async function updateTitleEscrow(titleEscrowId: string, updates: Record<string, unknown>) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_title_escrow")
    .update(updates)
    .eq("id", titleEscrowId)
    .select()
    .single()

  if (error) {
    console.error("Error updating title/escrow:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// INSPECTIONS
// ============================================

export async function scheduleInspection(inspectionData: {
  transaction_id: string
  inspection_type: string
  inspector_name?: string
  inspector_company?: string
  inspector_email?: string
  inspector_phone?: string
  scheduled_date?: string
  cost?: number
  notes?: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_inspections")
    .insert({ ...inspectionData, status: "scheduled" })
    .select()
    .single()

  if (error) {
    console.error("Error scheduling inspection:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(
    inspectionData.transaction_id,
    "inspection_scheduled",
    `${inspectionData.inspection_type} inspection scheduled`,
  )
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function updateInspection(
  inspectionId: string,
  updates: Partial<{
    status: string; scheduled_date: string; completed_date: string
    inspector_name: string; inspector_company: string; inspector_email: string
    inspector_phone: string; cost: number
    report_url: string; issues_found: string; notes: string
  }>,
) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_inspections")
    .update(updates)
    .eq("id", inspectionId)
    .select()
    .single()

  if (error) {
    console.error("Error updating inspection:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function completeInspection(inspectionId: string, reportUrl?: string, issuesFound?: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_inspections")
    .update({
      // "report received" is a status value, not a boolean column.
      status: reportUrl ? "report_received" : "completed",
      completed_date: new Date().toISOString().split("T")[0], // DATE column
      report_url: reportUrl,
      issues_found: issuesFound,
    })
    .eq("id", inspectionId)
    .select("*, transactions(id)")
    .single()

  if (error) {
    console.error("Error completing inspection:", error)
    return { success: false, error: error.message }
  }

  if (data?.transactions?.id) {
    await addTimelineEntry(data.transactions.id, "inspection_completed", `${data.inspection_type} inspection completed`)

    // Fan-out to buyer + seller + lender + title portals — the event was
    // previously only logged to the timeline. Use MILESTONE_COMPLETED with
    // milestone_name='inspection_completed' since the enum doesn't have a
    // dedicated INSPECTION_COMPLETED event yet.
    try {
      const supabaseSvc = await createClient()
      const { data: { user } } = await supabaseSvc.auth.getUser()
      const { data: tx } = await supabaseSvc
        .from("transactions")
        .select("brokerage_id")
        .eq("id", data.transactions.id)
        .maybeSingle()
      if (tx?.brokerage_id && user?.id) {
        const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
        const { KernelEvent } = await import("@/lib/kernel/events")
        await emitTransactionEvent({
          event:        KernelEvent.MILESTONE_COMPLETED,
          brokerageId:  tx.brokerage_id,
          entityId:     data.transactions.id,
          actorUserId:  user.id,
          metadata: {
            milestone_name:    "inspection_completed",
            inspection_type:   data.inspection_type,
            report_received:   !!reportUrl,
            issues_found:      issuesFound ?? null,
          },
        })
      }
    } catch (err) {
      console.error("[completeInspection] fan-out failed (non-blocking)", err)
    }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// VENDOR SERVICES
// ============================================

export async function orderVendorService(serviceData: {
  transaction_id: string
  service_type: string
  vendor_name: string
  vendor_email?: string
  vendor_phone?: string
  cost?: number
  scheduled_date?: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_vendor_services")
    .insert({ ...serviceData, status: "ordered" })
    .select()
    .single()

  if (error) {
    console.error("Error ordering vendor service:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(
    serviceData.transaction_id,
    "vendor_service_ordered",
    `${serviceData.service_type} ordered from ${serviceData.vendor_name}`,
  )
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function updateVendorService(
  serviceId: string,
  updates: Partial<{ status: string; scheduled_date: string; completed_date: string; cost: number; paid: boolean; notes: string }>,
) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_vendor_services")
    .update(updates)
    .eq("id", serviceId)
    .select()
    .single()

  if (error) {
    console.error("Error updating vendor service:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// DOCUMENTS
// ============================================

export async function addTransactionDocument(docData: {
  transaction_id: string
  document_type: string
  document_name: string
  file_url?: string
  file_size?: number
  uploaded_by?: string
  requires_signature?: boolean
  notes?: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_documents")
    .insert({ ...docData, status: "pending" })
    .select()
    .single()

  if (error) {
    console.error("Error adding document:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(docData.transaction_id, "document_uploaded", `Document "${docData.document_name}" uploaded`)
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function updateDocumentStatus(documentId: string, status: string, signedAt?: string) {
  const supabase = await createClient()
  const updates: Record<string, unknown> = { status }
  if (signedAt) updates.signed_at = signedAt

  const { data, error } = await supabase
    .from("transaction_documents")
    .update(updates)
    .eq("id", documentId)
    .select()
    .single()

  if (error) {
    console.error("Error updating document status:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// TIMELINE
// ============================================

export async function addTimelineEntry(
  transactionId: string,
  activityType: string,
  description: string,
  performedBy?: string,
  metadata?: Record<string, unknown>,
) {
  const supabase = await createClient()
  const { error } = await supabase.from("transaction_timeline").insert({
    transaction_id: transactionId,
    activity_type: activityType,
    description,
    performed_by: performedBy,
    metadata,
  })
  if (error) console.error("Error adding timeline entry:", error)
}

export async function getTransactionTimeline(transactionId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_timeline")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Error fetching timeline:", error)
    return { success: false, error: error.message }
  }
  return { success: true, data }
}

// ============================================
// DEADLINES
// ============================================

export async function addDeadline(deadlineData: {
  transaction_id: string
  deadline_type: string
  notes: string
  deadline_date: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_deadlines")
    .insert({
      transaction_id: deadlineData.transaction_id,
      deadline_type: deadlineData.deadline_type,
      notes: deadlineData.notes,
      deadline_date: deadlineData.deadline_date,
      status: "pending",
    })
    .select()
    .single()

  if (error) {
    console.error("Error adding deadline:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(
    deadlineData.transaction_id,
    "deadline_added",
    `Deadline "${deadlineData.notes}" added for ${deadlineData.deadline_date}`,
  )
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function updateDeadline(
  deadlineId: string,
  updates: Partial<{ status: string; deadline_date: string; notes: string; completed_at: string }>,
) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_deadlines")
    .update(updates)
    .eq("id", deadlineId)
    .select()
    .single()

  if (error) {
    console.error("Error updating deadline:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function completeDeadline(deadlineId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_deadlines")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", deadlineId)
    .select("*, transactions(id)")
    .single()

  if (error) {
    console.error("Error completing deadline:", error)
    return { success: false, error: error.message }
  }

  if (data?.transactions?.id) {
    await addTimelineEntry(data.transactions.id, "deadline_completed", `Deadline "${data.notes}" completed`)
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function getUpcomingDeadlines(agentId?: string, days = 7) {
  const supabase = await createClient()
  const futureDate = new Date()
  futureDate.setDate(futureDate.getDate() + days)

  let query = supabase
    .from("transaction_deadlines")
    .select("*, transactions(*)")
    .eq("status", "pending")
    .lte("deadline_date", futureDate.toISOString())
    .order("deadline_date", { ascending: true })

  if (agentId) query = query.eq("transactions.agent_id", agentId)

  const { data, error } = await query
  if (error) {
    console.error("Error fetching deadlines:", error)
    return { success: false, error: error.message }
  }
  return { success: true, data }
}

// ============================================
// COMMISSIONS
// ============================================

export async function addCommission(commissionData: {
  transaction_id: string
  recipient_type: string
  recipient_name: string
  recipient_id?: string
  commission_type: string
  rate_percentage?: number
  flat_amount?: number
  calculated_amount?: number
  split_percentage?: number
  notes?: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_commissions")
    .insert({ ...commissionData, status: "pending" })
    .select()
    .single()

  if (error) {
    console.error("Error adding commission:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function calculateCommissions(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select("*, transaction_commissions(*)")
    .eq("id", transactionId)
    .single()

  if (!transaction) return { success: false, error: "Transaction not found" }

  // Commission Engine 8.0 — fetch async data before the sync map
  const grossCommission = transaction.estimated_commission ?? 0
  const hasPercentComm = transaction.transaction_commissions?.some(
    (c: { rate_percentage?: number }) => c.rate_percentage,
  )

  let profile: { split_percent?: number; transaction_fee_value?: number; structure_type?: string; royalty_percent?: number } | null = null
  let capData: { cap_paid_to_date?: number; cap_amount?: number; is_capped?: boolean } | null = null

  if (hasPercentComm && transaction.agent_id) {
    const [profileResult, capResult] = await Promise.all([
      supabase
        .from("agent_commission_profiles")
        .select("split_percent, transaction_fee_value, structure_type, royalty_percent")
        .eq("agent_id", transaction.agent_id)
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("agent_cap_tracking")
        .select("cap_paid_to_date, cap_amount, is_capped")
        .eq("agent_id", transaction.agent_id)
        .maybeSingle(),
    ])
    profile = profileResult.data
    capData = capResult.data
  }

  const updatedCommissions =
    transaction.transaction_commissions?.map(
      (comm: { id: string; rate_percentage?: number; flat_amount?: number; split_percentage?: number }) => {
        let amount = comm.flat_amount || 0
        if (comm.rate_percentage) {
          const effectiveSplit = capData?.is_capped ? 100 : (profile?.split_percent ?? comm.split_percentage ?? 70)
          const brokerageFee = capData?.is_capped ? 0 : grossCommission * ((100 - effectiveSplit) / 100)
          const transactionFee = profile?.transaction_fee_value ?? 0
          const agentNet = grossCommission - brokerageFee - transactionFee
          amount = agentNet
        }
        if (comm.split_percentage) amount = amount * (comm.split_percentage / 100)
        return { id: comm.id, calculated_amount: amount }
      },
    ) || []

  // Run all async side-effects after the sync map
  if (hasPercentComm && transaction.agent_id) {
    const effectiveSplit = capData?.is_capped ? 100 : (profile?.split_percent ?? 70)
    const brokerageFee = capData?.is_capped ? 0 : grossCommission * ((100 - effectiveSplit) / 100)
    const transactionFee = profile?.transaction_fee_value ?? 0
    const agentNet = grossCommission - brokerageFee - transactionFee

    const distributions: Record<string, unknown>[] = [
      {
        transaction_id: transaction.id,
        brokerage_id: transaction.brokerage_id,
        agent_id: transaction.agent_id,
        distribution_type: "agent",
        calculation_type: "percent",
        calculation_value: effectiveSplit,
        calculated_amount: agentNet,
        source_of_funds: "brokerage",
        cap_applied: capData?.is_capped ?? false,
        status: "pending",
      },
    ]
    if (brokerageFee > 0) {
      distributions.push({
        transaction_id: transaction.id,
        brokerage_id: transaction.brokerage_id,
        distribution_type: "brokerage",
        calculation_type: "percent",
        calculation_value: 100 - effectiveSplit,
        calculated_amount: brokerageFee,
        source_of_funds: "brokerage",
        cap_applied: false,
        status: "pending",
      })
    }
    if (transactionFee > 0) {
      distributions.push({
        transaction_id: transaction.id,
        brokerage_id: transaction.brokerage_id,
        agent_id: transaction.agent_id,
        distribution_type: "fee",
        calculation_type: "flat",
        calculation_value: transactionFee,
        calculated_amount: transactionFee,
        source_of_funds: "agent",
        status: "pending",
      })
    }

    // Check for existing distributions, then write all side-effects in parallel
    const { data: existing } = await supabase
      .from("commission_distributions")
      .select("id")
      .eq("transaction_id", transaction.id)
      .limit(1)

    const writes: Promise<unknown>[] = []

    if (!existing || existing.length === 0) {
      writes.push(
        (async () => {
          try {
            return await supabase.from("commission_distributions").insert(distributions)
          } catch (err: unknown) {
            // Silent fail - commission logging should not block transaction
          }
        })()
      )
    }

    if (!capData?.is_capped && brokerageFee > 0) {
      const newPaid = (capData?.cap_paid_to_date ?? 0) + brokerageFee
      const nowCapped = newPaid >= (capData?.cap_amount ?? 999999)
      writes.push(
        (async () => {
          try {
            return await supabase
              .from("agent_cap_tracking")
              .update({ cap_paid_to_date: newPaid, is_capped: nowCapped })
              .eq("agent_id", transaction.agent_id)
          } catch (err: unknown) {
            // Silent fail - cap tracking should not block transaction
          }
        })()
      )
    }

    writes.push(
      Promise.resolve(
        supabase
          .from("agent_earnings")
          .upsert(
            {
              agent_id: transaction.agent_id,
              brokerage_id: transaction.brokerage_id,
              period_type: "ytd",
              period_label: `${new Date().getFullYear()}`,
              gross_commission: grossCommission,
              agent_net: agentNet,
              brokerage_net: brokerageFee,
              total_fees: transactionFee,
              transaction_count: 1,
            },
            { onConflict: "agent_id,period_type,period_label" },
          )
      )
    )

    await Promise.all(writes)
  }

  for (const comm of updatedCommissions) {
    await supabase
      .from("transaction_commissions")
      .update({ calculated_amount: comm.calculated_amount })
      .eq("id", comm.id)
  }

  revalidatePath("/transactions")
  return { success: true, data: updatedCommissions }
}

export async function markCommissionPaid(commissionId: string, paidDate: string, checkNumber?: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_commissions")
    .update({ status: "paid", paid_date: paidDate, check_number: checkNumber })
    .eq("id", commissionId)
    .select()
    .single()

  if (error) {
    console.error("Error marking commission paid:", error)
    return { success: false, error: error.message }
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// REPAIR NEGOTIATIONS
// ============================================

export async function submitRepairRequest(requestData: {
  transaction_id: string
  requested_by: "buyer" | "seller"
  item_description: string
  estimated_cost?: number
  priority?: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_repair_negotiations")
    .insert({ ...requestData, status: "requested" })
    .select()
    .single()

  if (error) {
    console.error("Error submitting repair request:", error)
    return { success: false, error: error.message }
  }

  await addTimelineEntry(
    requestData.transaction_id,
    "repair_requested",
    `Repair request submitted: ${requestData.item_description}`,
  )
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function respondToRepairRequest(
  requestId: string,
  response: "accepted" | "rejected" | "counter",
  counterOffer?: number,
  notes?: string,
) {
  const supabase = await createClient()
  // Map response → status CHECK (requested|countered|approved|rejected|withdrawn|completed).
  const RESPONSE_STATUS: Record<"accepted" | "rejected" | "counter", string> = {
    accepted: "approved",
    rejected: "rejected",
    counter: "countered",
  }
  const updates: Record<string, unknown> = {
    status: RESPONSE_STATUS[response],
    response_note: notes,
    responded_at: new Date().toISOString(),
    // counter offer goes into estimated_cost (the only numeric offer column).
    ...(response === "counter" && counterOffer !== undefined ? { estimated_cost: counterOffer } : {}),
  }

  const { data, error } = await supabase
    .from("transaction_repair_negotiations")
    .update(updates)
    .eq("id", requestId)
    .select("*, transactions(id)")
    .single()

  if (error) {
    console.error("Error responding to repair request:", error)
    return { success: false, error: error.message }
  }

  if (data?.transactions?.id) {
    await addTimelineEntry(data.transactions.id, "repair_response", `Repair request ${response}: ${data.item_description}`)
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

export async function finalizeRepairNegotiation(
  requestId: string,
  resolution: "repair" | "credit" | "as_is",
  finalAmount?: number,
) {
  const supabase = await createClient()
  // Map resolution → status CHECK; finalAmount→actual_cost; persist the
  // resolution detail in notes (no resolution/final_amount/resolved_at columns).
  const RESOLUTION_STATUS: Record<"repair" | "credit" | "as_is", string> = {
    repair: "completed",
    credit: "approved",
    as_is: "rejected",
  }
  const { data, error } = await supabase
    .from("transaction_repair_negotiations")
    .update({
      status: RESOLUTION_STATUS[resolution] ?? "completed",
      actual_cost: finalAmount ?? null,
      responded_at: new Date().toISOString(),
      notes: `Resolved: ${resolution}${finalAmount != null ? ` ($${finalAmount})` : ""}`,
    })
    .eq("id", requestId)
    .select("*, transactions(id)")
    .single()

  if (error) {
    console.error("Error finalizing repair negotiation:", error)
    return { success: false, error: error.message }
  }

  if (data?.transactions?.id) {
    await addTimelineEntry(
      data.transactions.id,
      "repair_resolved",
      `Repair negotiation resolved: ${resolution} - $${finalAmount || 0}`,
    )
  }
  revalidatePath("/transactions")
  return { success: true, data }
}

// ============================================
// DASHBOARD STATS
// ============================================

export async function getTransactionStats(agentId?: string) {
  const supabase = await createClient()

  let activeQuery = supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .in("status", ["new", "negotiation", "under_contract", "inspection", "financing"])
  if (agentId) activeQuery = activeQuery.eq("agent_id", agentId)
  const { count: activeCount } = await activeQuery

  const { count: pendingDocsCount } = await supabase
    .from("transaction_documents")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")

  const today = new Date().toISOString().split("T")[0]
  const { count: tasksToday } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("due_date", today)
    .eq("status", "pending")

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  const endOfMonth = new Date(startOfMonth)
  endOfMonth.setMonth(endOfMonth.getMonth() + 1)

  const { count: closingThisMonth } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("status", "closing")
    .gte("close_date", startOfMonth.toISOString())
    .lt("close_date", endOfMonth.toISOString())

  return {
    activeCount: activeCount || 0,
    pendingDocsCount: pendingDocsCount || 0,
    tasksToday: tasksToday || 0,
    closingThisMonth: closingThisMonth || 0,
  }
}

export async function getPendingDocuments(transactionId?: string, limit = 20) {
  const supabase = await createClient()
  let query = supabase
    .from("transaction_documents")
    .select("*, transactions(id, property_address)")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (transactionId) query = query.eq("transaction_id", transactionId)

  const { data, error } = await query
  if (error) {
    console.error("Error fetching pending documents:", error)
    return []
  }

  return (
    data?.map((doc) => ({
      id: doc.id,
      type: doc.document_type || doc.name,
      transaction: doc.transactions?.property_address || "Unknown",
      dueDate: doc.due_date || "Not set",
      priority: doc.priority || "medium",
    })) || []
  )
}

export async function generateClientTimeline(transactionId: string, transactionType: string, financingType: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase.from("transactions").select("*").eq("id", transactionId).single()
  if (!transaction) return { success: false }

  const timelinePrompt = `Generate realistic transaction timeline:

Transaction Type: ${transactionType}
Financing: ${financingType}
Closing Date: ${transaction.close_date || "TBD"}

Create milestones for ${transactionType === "buyer_side" ? "BUYER" : "SELLER"}:

Each milestone needs:
- name (client-friendly)
- target_date
- what_happens
- why_it_matters
- typical_duration_days
- potential_delays
- client_actions

Be realistic. Don't overpromise.

Return JSON array of milestones.`

    const timeline = JSON.parse(await runPipelineSimple(timelinePrompt, { feature: "transaction_timeline" }))

  if (timeline.data?.milestones) {
    for (const milestone of timeline.data.milestones) {
      await supabase.from("transaction_milestones").insert({
        transaction_id: transactionId,
        milestone_name: milestone.name,
        milestone_type: milestone.type || "date_driven",
        target_date: milestone.target_date,
        status: "pending", // CHECK: pending|completed|overdue|cancelled
        is_client_visible: true,
      })
    }
  }

  return { success: true, milestones: timeline.data?.milestones || [] }
}

export async function generateCostBreakdown(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase.from("transactions").select("*").eq("id", transactionId).single()
  if (!transaction) return { success: false }

  const isSeller = transaction.deal_type === "seller"

  const costPrompt = `Generate transparent cost breakdown for ${isSeller ? "SELLER" : "BUYER"}:

Sale Price: $${transaction.contract_price || 0}
${isSeller ? "" : `Down Payment: $${transaction.down_payment_amount || 0}`}

Calculate ALL costs:
${
  isSeller
    ? `
- Commission (6% - be transparent about who earns what)
- Title insurance
- Escrow fees
- Transfer tax
- Pro-rated property taxes
- HOA fees
- Repairs/concessions

Calculate NET PROCEEDS.
`
    : `
- Down payment
- Earnest money
- Lender fees
- Appraisal
- Inspection
- Title insurance
- Escrow fees
- Homeowners insurance
- Prepaid interest
- HOA transfer

Calculate CASH NEEDED AT CLOSING.
`
}

Be 100% transparent. Explain each cost.

Return JSON with detailed breakdown.`

    const costs = JSON.parse(await runPipelineSimple(costPrompt, { feature: "transaction_costs" }))

  if (costs.data) {
    for (const [costType, costData] of Object.entries(costs.data.costs || {})) {
      const cost: any = costData
      await supabase.from("cost_breakdown_tracking").insert({
        transaction_id: transactionId,
        cost_category: isSeller ? "seller_closing" : "buyer_closing",
        item_name: costType,
        estimated_amount: cost.amount || cost.total || cost,
        party: isSeller ? "seller" : "buyer", // CHECK: buyer|seller
        status: "estimated",
      })
    }
  }

  return { success: true, breakdown: costs.data }
}

export async function generateStatusUpdate(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`*, transaction_milestones(*), transaction_lenders(*)`)
    .eq("id", transactionId)
    .single()

  if (!transaction) return { success: false }

  const recentMilestones = transaction.transaction_milestones?.filter((m: any) => m.status === "completed").slice(-3)
  const upcomingMilestones = transaction.transaction_milestones?.filter((m: any) => m.status === "upcoming").slice(0, 3)

  const updatePrompt = `Generate client-friendly status update:

Current Stage: ${transaction.current_stage}
Days in Stage: ${transaction.days_in_current_stage || 0}
Recent Completed: ${recentMilestones?.map((m: any) => m.milestone_name).join(", ")}
Upcoming: ${upcomingMilestones?.map((m: any) => m.milestone_name).join(", ")}

Write 2-3 sentences:
1. Current status clearly
2. Next steps expectations
3. Address delays honestly or reassure if on track
4. Action needed if applicable

Tone: Honest, reassuring, specific (no vague language)`

    const update = JSON.parse(await runPipelineSimple(updatePrompt, { feature: "transaction_update" }))

  if (update.data?.update) {
    await supabase.from("client_friendly_updates").insert({
      transaction_id: transactionId,
      update_text: update.data.update,
      update_type: "status_change",
      ai_generated: true,
      tone: "informative",
      sent_via: "portal",
    })
    return { success: true, update: update.data.update }
  }

  return { success: false }
}

export async function generateSmartChecklist(transactionId: string, stage: string) {
  const supabase = await createClient()

  const checklistPrompt = `Generate smart checklist for transaction stage: ${stage}

Create tasks for:
- Agent responsibilities
- Client responsibilities
- Vendor coordination
- Document requirements
- Deadline tracking

Each task:
- task_name
- task_description
- assigned_to_role (client|agent|lender|title|vendor)
- priority (low|medium|high|critical)
- due_date_offset (days from now)
- client_visible (boolean)
- help_content

Return JSON array of tasks.`

    const checklist = JSON.parse(await runPipelineSimple(checklistPrompt, { feature: "transaction_checklist" }))

  if (checklist.data?.tasks) {
    const { data: checklistRecord } = await supabase
      .from("smart_checklists")
      .insert({
        transaction_id: transactionId,
        checklist_type: "stage_specific",
        total_items: checklist.data.tasks.length,
        completed_items: 0,
        percent_complete: 0,
        auto_generated: true,
      })
      .select()
      .single()

    if (checklistRecord) {
      for (const task of checklist.data.tasks) {
        // task_items links to the transaction via checklist_id → smart_checklists,
        // not a direct transaction_id. Real columns: title/description/assigned_to/
        // completed (no status/client_visible).
        await supabase.from("task_items").insert({
          checklist_id: checklistRecord.id,
          title: task.task_name,
          description: task.task_description,
          assigned_to: task.assigned_to_role,
          priority: task.priority,
          completed: false,
        })
      }
    }
  }

  return { success: true }
}

export async function detectTransactionIssues(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`*, transaction_milestones(*), transaction_lenders(*)`)
    .eq("id", transactionId)
    .single()

  if (!transaction) return { success: false }

  const overdueMilestones = transaction.transaction_milestones?.filter(
    (m: any) => m.status !== "completed" && new Date(m.target_date) < new Date(),
  )

  // task_items has no direct FK to transactions — it links via
  // checklist_id → smart_checklists.transaction_id. Fetch through the checklists.
  const { data: txChecklists } = await supabase
    .from("smart_checklists")
    .select("id")
    .eq("transaction_id", transactionId)
  const checklistIds = (txChecklists || []).map((c: any) => c.id)
  let overdueTasks: any[] = []
  if (checklistIds.length > 0) {
    const { data: tasks } = await supabase
      .from("task_items")
      .select("completed, due_date")
      .in("checklist_id", checklistIds)
    overdueTasks = (tasks || []).filter(
      (t: any) => !t.completed && t.due_date && new Date(t.due_date) < new Date(),
    )
  }

  const issuePrompt = `Analyze transaction health:

Days in Current Stage: ${transaction.days_in_current_stage || 0}
Overdue Milestones: ${overdueMilestones?.length || 0}
Overdue Tasks: ${overdueTasks?.length || 0}
Financing Status: ${transaction.transaction_lenders?.[0]?.underwriting_status || "unknown"}

Detect issues:
- Timeline delays
- Communication gaps
- Documentation problems
- Financing risks
- Coordination issues

Return:
{
  "health_score": 85,
  "health_status": "healthy|at_risk|critical",
  "red_flags": [],
  "warning_signs": [],
  "recommendations": [],
  "requires_intervention": false
}`

    const analysis = JSON.parse(await runPipelineSimple(issuePrompt, { feature: "transaction_issue_analysis" }))

  if (analysis.data) {
    await supabase.from("transaction_health_factors").insert({
      transaction_id: transactionId,
      factor_type: "comprehensive",
      factor_score: analysis.data.health_score || 100,
      red_flags: analysis.data.red_flags || [],
      warning_signs: analysis.data.warning_signs || [],
      recommendations: analysis.data.recommendations || [],
    })

    await supabase
      .from("transactions")
      .update({
        health_score: analysis.data.health_score || 100,
        health_status: analysis.data.health_status || "healthy",
      })
      .eq("id", transactionId)

    if (analysis.data.requires_intervention) {
      await supabase.from("proactive_interventions").insert({
        transaction_id: transactionId,
        issue_detected: analysis.data.red_flags?.[0] || "Health score declined",
        severity: analysis.data.health_status === "critical" ? "critical" : "medium",
        ai_recommendation: analysis.data.recommendations?.[0] || "Review transaction status",
        resolved: false,
        client_impacted: true,
      })
    }
  }

  return { success: true, analysis: analysis.data }
}

// ============================================
// EDUCATIONAL CONTENT DELIVERY
// ============================================

/**
 * Deliver stage-appropriate education to the contact tied to this transaction.
 *
 * Post-1042: instead of writing to the dropped `educational_moments` table,
 * this resolves a published `learning_modules` row tagged with the matching
 * stage_tag and creates a `learning_assignments` row for the buyer/seller
 * contact. The customer portal feed surfaces it from there.
 */
export async function deliverEducationalContent(transactionId: string, stage: string) {
  const supabase = await createClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, brokerage_id, buyer_contact_id, seller_contact_id, contact_id")
    .eq("id", transactionId)
    .maybeSingle()
  if (!transaction) throw new Error("Transaction not found")

  const contactId =
    (transaction.buyer_contact_id as string | null) ??
    (transaction.seller_contact_id as string | null) ??
    (transaction.contact_id as string | null)
  if (!contactId)            return { success: false, message: "No contact tied to transaction" }
  if (!transaction.brokerage_id) return { success: false, message: "No brokerage on transaction" }

  // Map the legacy stage string to learning_modules.stage_tags vocabulary.
  const stageTags: Record<string, string[]> = {
    offer:           ["offer_accepted", "offer_submitted"],
    inspection:      ["inspection_scheduled", "inspection_period"],
    appraisal:       ["appraisal_ordered", "appraisal", "appraisal_completed"],
    clear_to_close:  ["clear_to_close_received", "closing_prep"],
  }
  const tags = stageTags[stage] ?? [stage]

  const { data: candidates } = await supabase
    .from("learning_modules")
    .select("id, title")
    .eq("brokerage_id", transaction.brokerage_id)
    .eq("status", "published")
    .overlaps("stage_tags", tags)
    .order("display_priority", { ascending: false })
    .limit(1)

  const moduleRow = (candidates ?? [])[0] as { id: string; title: string } | undefined
  if (!moduleRow) return { success: false, message: `No learning module published for stage ${stage}` }

  const { data: existing } = await supabase
    .from("learning_assignments")
    .select("id")
    .eq("contact_id", contactId)
    .eq("module_id", moduleRow.id)
    .maybeSingle()
  if (existing) return { success: false, message: "Content already delivered" }

  await supabase.from("learning_assignments").insert({
    brokerage_id:    transaction.brokerage_id,
    module_id:       moduleRow.id,
    contact_id:      contactId,
    signal_source:   `stage:${stage}`,
    signal_metadata: { transaction_id: transactionId, stage },
    priority_score:  70,
    status:          "open",
  })

  return { success: true, content: moduleRow, message: `Educational content delivered for ${stage} stage` }
}

// ============================================
// TRANSACTION HEALTH MONITORING
// ============================================

export async function monitorTransactionHealth(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`*, transaction_milestones(*), communications(*)`)
    .eq("id", transactionId)
    .maybeSingle()

  if (!transaction) throw new Error("Transaction not found")

  const milestones = transaction.transaction_milestones || []
  const communications = transaction.communications || []

  const onTrackCount = milestones.filter(
    (m: any) => m.status === "completed" || new Date(m.target_date) > new Date(),
  ).length
  const delayedCount = milestones.filter(
    (m: any) => m.status !== "completed" && new Date(m.target_date) < new Date(),
  ).length

  const lastClientComm = communications
    .filter((c: any) => c.direction === "inbound")
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

  const daysUntilClose = transaction.close_date
    ? Math.ceil((new Date(transaction.close_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0

  const prompt = `Analyze transaction health and predict potential issues:

TRANSACTION DATA:
- Current Stage: ${transaction.status}
- Days Until Close: ${daysUntilClose}

TIMELINE STATUS:
- Milestones on track: ${onTrackCount}
- Milestones delayed: ${delayedCount}

COMMUNICATION PATTERNS:
- Last client response: ${lastClientComm ? new Date(lastClientComm.created_at).toLocaleDateString() : "None"}

Calculate health scores (0-100):
{
  "overall_health": 85,
  "timeline_health": 90,
  "communication_health": 80,
  "documentation_health": 85,
  "financing_health": 90,
  "risk_factors": [],
  "recommendations": [],
  "predicted_close_date": "${transaction.close_date}",
  "confidence_in_closing": "high",
  "client_notification_needed": false,
  "broker_escalation_needed": false
}`

  try {
    const health = JSON.parse(await runPipelineSimple(prompt, { feature: "transaction_health" }))
    if (!health.data) throw new Error("Health analysis failed")

    await supabase
      .from("transactions")
      .update({
        health_score: health.data.overall_health,
        health_status:
          health.data.overall_health < 50 ? "critical" : health.data.overall_health < 75 ? "at_risk" : "healthy",
      })
      .eq("id", transactionId)

    await supabase.from("transaction_health_factors").insert({
      transaction_id: transactionId,
      factor_type: "comprehensive",
      factor_score: health.data.overall_health,
      red_flags: health.data.risk_factors,
      recommendations: health.data.recommendations,
    })

    return { success: true, health: health.data }
  } catch (error) {
    throw new Error("Health monitoring failed")
  }
}

// ============================================
// DELAY DETECTION & EARLY WARNING
// ============================================

export async function detectTransactionDelays(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`*, transaction_milestones(*), tasks(*)`)
    .eq("id", transactionId)
    .maybeSingle()

  if (!transaction) throw new Error("Transaction not found")

  const delays: any[] = []

  for (const milestone of transaction.transaction_milestones || []) {
    if (new Date(milestone.target_date) < new Date() && milestone.status !== "completed") {
      const daysOverdue = Math.ceil(
        (Date.now() - new Date(milestone.target_date).getTime()) / (1000 * 60 * 60 * 24),
      )
      delays.push({
        type: "milestone_overdue",
        item: milestone.milestone_name,
        days_overdue: daysOverdue,
        responsible_party: milestone.responsible_party,
      })
    }
  }

  for (const task of transaction.tasks || []) {
    if (task.due_date && new Date(task.due_date) < new Date() && task.status !== "completed") {
      const daysOverdue = Math.ceil((Date.now() - new Date(task.due_date).getTime()) / (1000 * 60 * 60 * 24))
      delays.push({ type: "task_overdue", item: task.title, days_overdue: daysOverdue, assigned_to: task.assigned_to })
    }
  }

  if (delays.length === 0) return { success: true, delays: [], impact: null }

  const prompt = `Analyze the impact of these delays on closing date:

Target Close Date: ${transaction.close_date}
Current Delays: ${JSON.stringify(delays)}

{
  "will_delay_closing": false,
  "estimated_new_close_date": null,
  "days_delayed": 0,
  "critical_path_affected": false,
  "client_communication_needed": false,
  "recommended_client_message": "",
  "action_items": []
}`

    const impact = JSON.parse(await runPipelineSimple(prompt, { feature: "transaction_impact" }))

  if (impact.data?.client_communication_needed) {
    await supabase.from("timeline_transparency").insert({
      transaction_id: transactionId,
      delays,
      reason_for_delays: impact.data.action_items,
      impact_on_closing: impact.data.days_delayed,
      communicated_to_client: true,
    })
  }

  return { success: true, delays, impact: impact.data }
}

// ============================================
// CELEBRATION MOMENTS
// ============================================

export async function celebrateMilestone(transactionId: string, milestone: string) {
  const supabase = await createClient()

  const celebrations: Record<string, any> = {
    offer_accepted: { message: "Your offer was accepted! This is a huge step. Here's what happens next...", tone: "excited" },
    inspection_passed: { message: "Great news! The inspection went well. No major issues found. Moving forward!", tone: "reassuring" },
    appraisal_at_value: { message: "Excellent! The appraisal came in at value. This clears a major hurdle.", tone: "positive" },
    clear_to_close: { message: "Clear to Close! Your lender has approved everything. Closing date confirmed!", tone: "celebratory" },
    closed: { message: "Congratulations! The house is officially yours! Welcome home!", tone: "triumphant" },
  }

  const celebration = celebrations[milestone]
  if (!celebration) return { success: false, message: "No celebration for this milestone" }

  await supabase.from("client_friendly_updates").insert({
    transaction_id: transactionId,
    update_text: celebration.message,
    update_type: "celebration",
    tone: celebration.tone,
  })

  return { success: true, celebration, message: "Celebration moment recorded" }
}

// ============================================
// CLIENT PORTAL DASHBOARD DATA
// ============================================

export async function loadClientDashboard(transactionId: string, contactId?: string) {
  const supabase = await createClient()
  
  // Fetch transaction with full relationships - specify which foreign key to use
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`*, contacts!transactions_contact_id_fkey(*), agents(*)`)
    .eq("id", transactionId)
    .single()
  
  if (!transaction) throw new Error("Transaction not found")
  if (contactId && transaction.contact_id !== contactId) {
    throw new Error("Unauthorized: Transaction does not belong to this contact")
  }
  
  const persona = transaction.contacts?.contact_persona || (transaction.deal_type === "seller" ? "seller" : "buyer")

  // The contact whose portal feed we're reading. Post-1042, learning
  // assignments are keyed off contact_id, so resolve it once up front.
  const portalContactId: string | null =
    (transaction.buyer_contact_id as string | null) ??
    (transaction.seller_contact_id as string | null) ??
    (transaction.contact_id as string | null) ??
    null

  // Fetch all client-visible data in parallel from real tables
  const [
    milestones,
    clientFriendlyUpdates,
    transparencyUpdates,
    educationalMoments,
    timelineTransparency,
    titleEscrow,
    closingChecklist,
    teamContacts,
    requestedDocuments,
    health,
  ] = await Promise.all([
    // Client-visible milestones
    supabase
      .from("transaction_milestones")
      .select("id, milestone_name, target_date, status, completed_at, notes")
      .eq("transaction_id", transactionId)
      .order("target_date", { ascending: true })
      .then(r => r.data || []),
    // Client-friendly updates
    supabase
      .from("client_friendly_updates")
      .select("id, update_text, update_type, tone, created_at, read_at")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })
      .limit(15)
      .then(r => r.data || []),
    // Transparency updates
    supabase
      .from("transparency_updates")
      .select("id, title, plain_language_summary, stage, responsible_party, responsible_party_name, next_step, next_step_date, created_at")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(r => r.data || []),
    // Educational moments — post-1042, sourced from learning_assignments
    // joined with learning_modules. transaction_id is recorded in
    // signal_metadata when deliverEducationalContent() seeds the assignment.
    portalContactId
      ? supabase
          .from("learning_assignments")
          .select("id, signal_metadata, status, viewed_at, completed_at, created_at, module:module_id(title, body, channels)")
          .eq("contact_id", portalContactId)
          .contains("signal_metadata", { transaction_id: transactionId })
          .order("created_at", { ascending: false })
          .limit(5)
          .then(r => r.data || [])
      : Promise.resolve([]),
    // Timeline transparency (delays)
    supabase
      .from("timeline_transparency")
      .select("id, delays, reason_for_delays, impact_on_closing, communicated_to_client, created_at")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })
      .limit(3)
      .then(r => r.data || []),
    // Title/Escrow - earnest money status only
    supabase
      .from("transaction_title_escrow")
      .select("earnest_money_amount, earnest_money_held_by, earnest_money_received_date")
      .eq("transaction_id", transactionId)
      .maybeSingle()
      .then(r => r.data),
    // Closing checklist - required items summary only
    supabase
      .from("closing_checklist_items")
      .select("id, item_name, category, completed, required")
      .eq("transaction_id", transactionId)
      .eq("required", true)
      .order("sequence", { ascending: true })
      .then(r => r.data || []),
    // Team contacts from participants
    supabase
      .from("transaction_participants")
      .select("id, role, name, company, email, phone")
      .eq("transaction_id", transactionId)
      .then(r => r.data || []),
    // Requested documents
    supabase
      .from("transaction_documents")
      .select("id, doc_label, doc_type, status, created_at")
      .eq("transaction_id", transactionId)
      .eq("status", "requested")
      .order("created_at", { ascending: false })
      .then(r => r.data || []),
    // Transaction health
    getTransactionHealth(transactionId),
  ])
  
  const personaConfig = getPersonaConfig(persona, transaction.deal_type || "buyer")
  
  // Calculate progress from milestones
  const completedMilestones = milestones.filter((m: any) => m.status === "completed").length
  const progressPercent = Math.round((completedMilestones / Math.max(milestones.length, 1)) * 100)
  
  // Combine updates from multiple sources
  const combinedUpdates = [
    ...clientFriendlyUpdates.map((u: any) => ({
      id: u.id,
      text: u.update_text,
      type: u.update_type,
      timestamp: u.created_at,
      icon: getUpdateIcon(u.update_type),
      source: "friendly_update",
    })),
    ...transparencyUpdates.map((u: any) => ({
      id: u.id,
      text: u.plain_language_summary || u.title,
      type: "info",
      timestamp: u.created_at,
      icon: "info",
      source: "transparency",
      nextStep: u.next_step,
      nextStepDate: u.next_step_date,
    })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 15)
  
  // Format earnest money status (no sensitive financial data)
  const earnestMoneyStatus = titleEscrow ? {
    received: !!titleEscrow.earnest_money_received_date,
    heldBy: titleEscrow.earnest_money_held_by || "Escrow",
    receivedDate: titleEscrow.earnest_money_received_date,
  } : null
  
  // Closing checklist summary (required items only)
  const checklistSummary = {
    totalRequired: closingChecklist.length,
    completed: closingChecklist.filter((i: any) => i.completed).length,
    pendingItems: closingChecklist.filter((i: any) => !i.completed).map((i: any) => ({
      id: i.id,
      name: i.item_name,
      category: i.category,
    })),
  }
  
  // Format timeline delays for client
  const delayInfo = timelineTransparency.length > 0 ? {
    hasDelays: timelineTransparency.some((t: any) => t.delays?.length > 0),
    impactOnClosing: timelineTransparency[0]?.impact_on_closing || 0,
    reasons: timelineTransparency[0]?.reason_for_delays || [],
  } : null
  
  return {
    persona,
    personaConfig,
    hero: {
      property_address: transaction.property_address,
      current_stage_display: friendlyStageName(transaction.stage || transaction.status, persona),
      status_message: await generateFriendlyStatusMessage(transaction, persona),
      progress_percent: progressPercent,
      health_indicator: health.overall_health >= 75 ? "on_track" : "needs_attention",
      days_until_closing: calculateDaysUntil(transaction.close_date),
      persona_theme: personaConfig.theme,
    },
    timeline: milestones.map((m: any) => ({
      id: m.id,
      name: m.milestone_name,
      date: m.target_date,
      status: m.status,
      icon: getMilestoneIcon(m.milestone_name),
      description: m.notes || getDefaultMilestoneDescription(m.milestone_name),
    })),
    next_actions: requestedDocuments.slice(0, 5).map((d: any) => ({
      id: d.id,
      task: `Submit: ${d.doc_label || d.doc_type}`,
      due_date: null,
      priority: "high",
      help_url: null,
    })),
    earnestMoney: earnestMoneyStatus,
    checklistSummary,
    delayInfo,
    updates: combinedUpdates,
    team: teamContacts.map((p: any) => ({
      id: p.id,
      role: p.role,
      name: p.name,
      company: p.company,
      email: p.email,
      phone: p.phone,
    })),
    educationalContent: educationalMoments.length > 0
      ? (() => {
          // Supabase join returns module as an array; pick the first row.
          const first  = educationalMoments[0] as { module?: Array<{ title?: string; body?: string | null; channels?: string[] | null }> | { title?: string; body?: string | null; channels?: string[] | null } | null; viewed_at?: string | null }
          const mod    = Array.isArray(first.module) ? first.module[0] : first.module
          return {
            title:  mod?.title ?? "",
            content: mod?.body ?? "",
            type:   (mod?.channels ?? [])[0] ?? "article",
            isRead: !!first.viewed_at,
          }
        })()
      : getPersonaEducation(persona, transaction.stage || transaction.status),
    personaTools: getPersonaSpecificTools(persona),
    contactAgent: {
      message: "Have questions? Your agent is here to help.",
      action: "Contact Your Agent",
    },
  }
  }

function getDefaultMilestoneDescription(milestoneName: string): string {
  const descriptions: Record<string, string> = {
    "Offer Submitted": "Your offer has been submitted to the seller.",
    "Offer Accepted": "Congratulations! The seller has accepted your offer.",
    "Earnest Money Deposited": "Your earnest money deposit has been received.",
    "Home Inspection Scheduled": "The home inspection has been scheduled.",
    "Home Inspection Complete": "The inspection is complete and the report is ready.",
    "Repair Negotiations Complete": "Repair negotiations have been finalized.",
    "Appraisal Ordered": "The appraisal has been ordered by your lender.",
    "Appraisal Complete": "The appraisal has been completed.",
    "Loan Approved": "Your loan has been approved.",
    "Title Search Complete": "The title search has been completed.",
    "Final Walkthrough": "Time for your final walkthrough before closing.",
    "Closing Documents Signed": "All closing documents have been signed.",
    "Funds Transferred": "Funds have been transferred.",
    "Keys Received": "You've received the keys to your new home!",
    "Listing Agreement Signed": "The listing agreement has been signed.",
    "Property Listed": "Your property is now listed on the market.",
    "Offer Received": "You've received an offer on your property.",
    "Title Clear": "Title is clear and ready for closing.",
    "Closing Scheduled": "Your closing date has been scheduled.",
    "Funds Received": "Funds have been received from the sale.",
    "Keys Delivered": "Keys have been delivered to the new owner.",
  }
  return descriptions[milestoneName] || "This milestone is in progress."
}

// ============================================
// AGENT DASHBOARD
// ============================================

export async function loadAgentDashboard() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: agent } = await supabase
    .from("agents")
    .select("*, profiles!inner(brokerage_id)")
    .eq("user_id", user.id)
    .maybeSingle()

  // agent_id is agents.id, not users.id. For non-agent users there is no agent
  // row → return empty rather than filtering by a users.id (which never matches).
  const agentId = agent?.id ?? null
  const brokerageId = agent?.profiles?.brokerage_id
  if (!brokerageId) throw new Error("Agent brokerage not found")

  const { data: transactions } = agentId
    ? await supabase
        .from("transactions")
        .select(`*, contacts!transactions_contact_id_fkey(*), listings(*)`)
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false })
    : { data: [] as any[] }

  const pipeline = await calculatePipeline(transactions || [], brokerageId)
  const atRiskDeals = identifyAtRiskDeals(transactions || [])
  const upcomingMilestones = agentId ? await getUpcomingMilestones(agentId) : []

  return { agentId, pipeline, atRiskDeals, upcomingMilestones, transactions: transactions || [] }
}

export async function getAgentTransactionKanban() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: agent } = await supabase.from("agents").select("*").eq("user_id", user.id).maybeSingle()
  // agent_id is agents.id; non-agent users have no agent row → empty board.
  const agentId = agent?.id ?? null

  const { data: transactions } = agentId
    ? await supabase
        .from("transactions")
        .select(`*, contacts!transactions_contact_id_fkey(*), listings(*)`)
        .eq("agent_id", agentId)
        .neq("status", "closed")
        .order("created_at", { ascending: false })
    : { data: [] as any[] }

  return {
    lead: { title: "Leads", deals: transactions?.filter((t) => t.status === "lead" || !t.status) || [], color: "gray" },
    offer: { title: "Active Offers", deals: transactions?.filter((t) => t.status === "offer" || t.status === "negotiation") || [], color: "blue" },
    contract: {
      title: "Under Contract",
      deals: transactions?.filter((t) => t.status === "inspection" || t.status === "appraisal" || t.status === "financing") || [],
      color: "yellow",
    },
    closing: { title: "Closing Soon", deals: transactions?.filter((t) => t.status === "clear_to_close") || [], color: "green" },
  }
}

export async function updateTransactionStage(transactionId: string, targetStage: string, reason?: string) {
  // Kernel OS: requireWriteContext — resolves userId, brokerageId, userType via canonical chain
  const { requireWriteContext } = await import("@/lib/kernel")
  try {
    const ctx = await requireWriteContext()
    if (!ctx) return { success: false, error: "Not authenticated" }

    const { TransactionOrchestrator } = await import("@/lib/transactions/transaction-orchestrator")
    const orchestrator = new TransactionOrchestrator({
      transactionId,
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
      userRole: ctx.userType, // userType is already canonical — never use .role
    })

    const result = await orchestrator.advanceToStage(targetStage as any, reason)
    if (result.success) revalidatePath("/transactions")
    return result
  } catch (err) {
    return { success: false, error: "Not authenticated" }
  }
}

export async function getClientTasks(transactionId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("tasks")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("due_date", { ascending: true })
  return data || []
}

export async function autoProgressMilestone(transactionId: string, completedMilestone: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select("*, contacts(*)")
    .eq("id", transactionId)
    .single()

  if (!transaction) return { success: false }

  const persona = transaction.contacts?.contact_persona || "buyer"

  await supabase
    .from("transaction_milestones")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("transaction_id", transactionId)
    .eq("milestone_name", completedMilestone)

  await celebrateMilestone(transactionId, completedMilestone.toLowerCase().replace(/ /g, "_"))

  const nextStage = getNextStage(completedMilestone, persona)
  if (nextStage) await deliverEducationalContent(transactionId, nextStage)

  return { success: true, nextStage }
}

// ============================================
// PRIVATE HELPERS
// ============================================

async function getClientTimeline(transactionId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("transaction_milestones")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("target_date", { ascending: true })
  return data || []
}

async function getCostBreakdown(transactionId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("transaction_cost_breakdown")
    .select("*")
    .eq("transaction_id", transactionId)
    .maybeSingle()
  return data || {}
}

async function getRecentUpdates(transactionId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("client_friendly_updates")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("created_at", { ascending: false })
    .limit(10)
  return data || []
}

async function getTransactionHealth(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select("health_score")
    .eq("id", transactionId)
    .single()
  return { overall_health: transaction?.health_score || 75 }
}

async function getTeamContacts(transactionId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("transaction_participants")
    .select("*, agents(*)")
    .eq("transaction_id", transactionId)
  return data || []
}

async function calculatePipeline(transactions: any[], brokerageId: string) {
  const stages = {
    prospecting: transactions.filter((t) => t.status === "lead" || t.status === "prospecting"),
    active_offer: transactions.filter((t) => t.status === "offer" || t.status === "negotiation"),
    under_contract: transactions.filter(
      (t) => t.status === "inspection" || t.status === "appraisal" || t.status === "financing",
    ),
    closing_soon: transactions.filter((t) => t.status === "clear_to_close"),
    closed: transactions.filter((t) => t.status === "closed"),
  }

  const totalValue = transactions.reduce((sum, t) => sum + (t.purchase_price || 0), 0)
  const commissionStructure = await getDefaultCommissionStructure(brokerageId)
  const estimatedCommission = totalValue * commissionStructure.agentBuyerSideRate

  return {
    stages,
    totalDeals: transactions.length,
    totalValue,
    estimatedCommission,
    conversionRate: stages.closed.length / Math.max(transactions.length, 1),
  }
}

function identifyAtRiskDeals(transactions: any[]) {
  const today = new Date()
  return transactions
    .filter((t) => {
      if (t.status === "closed") return false
      const closingDate = t.close_date ? new Date(t.close_date) : null
      const daysTilClosing = closingDate
        ? Math.ceil((closingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        : 999
      const hasExpiredContingency = t.inspection_contingency_date && new Date(t.inspection_contingency_date) < today
      const closingSoon = daysTilClosing < 7 && daysTilClosing > 0
      const lowHealthScore = (t.health_score || 100) < 60
      return hasExpiredContingency || closingSoon || lowHealthScore
    })
    .map((t) => ({ ...t, riskFactors: getRiskFactors(t), priority: calculateRiskPriority(t) }))
    .sort((a, b) => b.priority - a.priority)
}

function getRiskFactors(transaction: any): string[] {
  const factors: string[] = []
  const today = new Date()
  if (transaction.inspection_contingency_date && new Date(transaction.inspection_contingency_date) < today)
    factors.push("Inspection contingency expired")
  if (transaction.financing_contingency_date && new Date(transaction.financing_contingency_date) < today)
    factors.push("Financing contingency expired")
  if (transaction.close_date) {
    const daysTilClosing = Math.ceil(
      (new Date(transaction.close_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    )
    if (daysTilClosing < 7 && daysTilClosing > 0) factors.push(`Closing in ${daysTilClosing} days`)
  }
  if ((transaction.health_score || 100) < 60) factors.push("Low health score")
  return factors
}

function calculateRiskPriority(transaction: any): number {
  let priority = 0
  if ((transaction.health_score || 100) < 40) priority += 50
  else if ((transaction.health_score || 100) < 60) priority += 30
  if (transaction.close_date) {
    const daysTilClosing = Math.ceil(
      (new Date(transaction.close_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    )
    if (daysTilClosing < 3) priority += 40
    else if (daysTilClosing < 7) priority += 20
  }
  const purchasePrice = transaction.purchase_price || 0
  if (purchasePrice > 1000000) priority += 20
  else if (purchasePrice > 500000) priority += 10
  return priority
}

async function getUpcomingMilestones(agentId: string) {
  const supabase = await createClient()
  
  // Get milestones first
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, transaction_id, status, target_date")
    .eq("status", "pending")
    .gte("target_date", new Date().toISOString())
    .order("target_date", { ascending: true })
    .limit(10)

  if (!milestones || milestones.length === 0) return []

  // Get transactions for these milestones
  const transactionIds = milestones.map(m => m.transaction_id).filter(Boolean)
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, agent_id, property_address, contact_id")
    .in("id", transactionIds)
    .eq("agent_id", agentId)

  if (!transactions || transactions.length === 0) return []

  // Get contacts
  const contactIds = transactions.map(t => t.contact_id).filter(Boolean)
  let contactMap = new Map()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds)
    contactMap = new Map(contacts?.map(c => [c.id, { name: `${c.first_name} ${c.last_name}` }]) || [])
  }

  const transactionMap = new Map(transactions.map(t => [t.id, t]))

  // Merge data
  return milestones
    .filter(m => transactionMap.has(m.transaction_id))
    .map(m => {
      const transaction = transactionMap.get(m.transaction_id)!
      return {
        ...m,
        transactions: {
          agent_id: transaction.agent_id,
          property_address: transaction.property_address,
          contacts: contactMap.get(transaction.contact_id) || { name: "Unknown" }
        }
      }
    })
}

function getNextStage(currentMilestone: string, persona: string): string | null {
  const buyerFlow = ["offer", "inspection", "appraisal", "financing", "clear_to_close", "closed"]
  const sellerFlow = ["listing", "offer", "negotiation", "inspection", "appraisal", "clear_to_close", "closed"]
  const flow = persona.includes("seller") ? sellerFlow : buyerFlow
  const currentIndex = flow.findIndex((stage) => currentMilestone.toLowerCase().includes(stage))
  return currentIndex >= 0 && currentIndex < flow.length - 1 ? flow[currentIndex + 1] : null
}

function getPersonaConfig(persona: string, transactionType: string) {
  const configs: Record<string, any> = {
    first_time_buyer: { theme: "buyer", primaryColor: "blue", title: "Your Home Buying Journey", icon: "home", welcomeMessage: "We're here to guide you through every step of buying your first home!" },
    luxury_buyer: { theme: "luxury", primaryColor: "purple", title: "Luxury Property Acquisition", icon: "crown", welcomeMessage: "White-glove service for your premium property purchase." },
    motivated_seller: { theme: "seller", primaryColor: "green", title: "Fast-Track Home Sale", icon: "trending-up", welcomeMessage: "Let's get your home sold quickly and for top dollar." },
    investor: { theme: "investor", primaryColor: "amber", title: "Investment Property Acquisition", icon: "bar-chart", welcomeMessage: "Data-driven insights for your investment portfolio." },
    relocating: { theme: "relocation", primaryColor: "teal", title: "Relocation Concierge", icon: "map", welcomeMessage: "Making your move to a new city seamless." },
  }
  return (
    configs[persona] ||
    (transactionType === "sale"
      ? { theme: "seller", primaryColor: "green", title: "Your Home Selling Journey", icon: "home", welcomeMessage: "Let's sell your home for the best price." }
      : { theme: "buyer", primaryColor: "blue", title: "Your Home Buying Journey", icon: "home", welcomeMessage: "Welcome to your home buying journey!" })
  )
}

function getPersonaSpecificTools(persona: string) {
  const tools: Record<string, any[]> = {
    first_time_buyer: [
      { name: "Affordability Calculator", url: "/tools/affordability", icon: "calculator" },
      { name: "Mortgage Comparison", url: "/tools/mortgage", icon: "percent" },
      { name: "Neighborhood Guide", url: "/tools/neighborhoods", icon: "map" },
      { name: "First-Time Buyer Guide", url: "/resources/first-time", icon: "book" },
    ],
    motivated_seller: [
      { name: "Home Value Estimator", url: "/home-value", icon: "dollar-sign" },
      { name: "Seller Net Calculator", url: "/tools/seller-net", icon: "calculator" },
      { name: "Staging Checklist", url: "/resources/staging", icon: "check-square" },
      { name: "Market Timeline", url: "/tools/market-timeline", icon: "clock" },
    ],
    investor: [
      { name: "ROI Calculator", url: "/tools/roi", icon: "trending-up" },
      { name: "Cash Flow Analyzer", url: "/tools/cash-flow", icon: "dollar-sign" },
      { name: "Market Analysis", url: "/tools/market-analysis", icon: "bar-chart" },
      { name: "Rental Comps", url: "/tools/rental-comps", icon: "home" },
    ],
    relocating: [
      { name: "City Comparison", url: "/tools/city-compare", icon: "map" },
      { name: "School District Finder", url: "/tools/schools", icon: "graduation-cap" },
      { name: "Commute Calculator", url: "/tools/commute", icon: "navigation" },
      { name: "Moving Checklist", url: "/resources/moving", icon: "truck" },
    ],
  }
  return tools[persona] || [
    { name: "Market Data", url: "/tools/market", icon: "bar-chart" },
    { name: "Mortgage Calculator", url: "/tools/mortgage", icon: "calculator" },
  ]
}

function getPersonaEducation(persona: string, stage: string) {
  const education: Record<string, Record<string, any>> = {
    first_time_buyer: {
      offer: { title: "Understanding Your Offer", content: "Learn what happens after your offer is submitted.", videoUrl: "/education/first-time-buyer-offer.mp4", checklist: ["Review offer terms with your agent", "Prepare earnest money deposit", "Stay available for calls", "Avoid major purchases or new credit"] },
      inspection: { title: "Home Inspection 101", content: "What to expect during your home inspection.", videoUrl: "/education/inspection-guide.mp4", checklist: ["Attend the inspection if possible", "Ask inspector questions", "Review the full report carefully", "Discuss repair requests with your agent"] },
      appraisal: { title: "Understanding Appraisals", content: "How appraisals work and what happens if the value comes in low.", videoUrl: "/education/appraisal-explained.mp4", checklist: ["Appraiser will visit the home", "Keep property accessible", "Wait 1-2 weeks for report", "Review results with your agent"] },
      financing: { title: "Final Loan Steps", content: "What your lender needs and how to stay on track.", videoUrl: "/education/loan-processing.mp4", checklist: ["Provide all requested documents promptly", "Don't change jobs or income", "Avoid opening new credit accounts", "Stay in close contact with your lender"] },
    },
    motivated_seller: {
      listing: { title: "Maximizing Your Sale", content: "Quick wins to prepare your home for a fast, profitable sale.", videoUrl: "/education/fast-sale-tips.mp4", checklist: ["Declutter and depersonalize all rooms", "Deep clean entire home", "Make minor repairs and touch-ups", "Professional photos scheduled"] },
      negotiation: { title: "Negotiation Strategies", content: "How to evaluate offers and negotiate the best deal.", videoUrl: "/education/seller-negotiation.mp4", checklist: ["Review all offers thoroughly", "Check buyer pre-approval letters", "Consider terms beyond just price", "Respond to offers promptly"] },
      inspection: { title: "Buyer Inspection Period", content: "What buyers look for and how to handle repair requests.", videoUrl: "/education/seller-inspection.mp4", checklist: ["Keep home clean and accessible", "Make property available for inspection", "Review buyer's inspection report", "Negotiate repairs fairly"] },
    },
    investor: {
      due_diligence: { title: "Investment Property Analysis", content: "Key metrics to validate your investment thesis.", videoUrl: "/education/investor-due-diligence.mp4", checklist: ["Review comparable rental rates", "Analyze cash-on-cash return", "Inspect property thoroughly", "Verify seller's income/expense statements"] },
      closing: { title: "Investor Closing Checklist", content: "Tax considerations and entity setup.", videoUrl: "/education/investor-closing.mp4", checklist: ["Confirm LLC or entity setup complete", "Review 1031 exchange requirements", "Coordinate with CPA on tax strategy", "Have property management company lined up"] },
    },
    luxury_buyer: {
      offer: { title: "Luxury Property Negotiations", content: "Strategic considerations for high-value property purchases.", videoUrl: "/education/luxury-offer-strategy.mp4", checklist: ["Review property disclosure carefully", "Consider additional inspections", "Verify HOA rules and fees", "Evaluate resale potential"] },
    },
    military_buyer: {
      offer: { title: "VA Loan Offer Process", content: "Using your VA benefits effectively in the offer process.", videoUrl: "/education/va-loan-offers.mp4", checklist: ["Ensure VA funding fee is addressed", "Confirm seller accepts VA financing", "Have COE ready for lender", "Discuss PCS timeline with agent"] },
    },
  }
  return education[persona]?.[stage] || null
}

function friendlyStageName(status: string, persona: string): string {
  const buyerStages: Record<string, string> = { offer: "Offer Submitted", inspection: "Home Inspection", appraisal: "Appraisal", financing: "Loan Processing", clear_to_close: "Clear to Close", closed: "Welcome Home!" }
  const sellerStages: Record<string, string> = { listing: "Active Listing", offer: "Offer Received", negotiation: "Negotiating Terms", inspection: "Buyer Inspection", appraisal: "Appraisal", clear_to_close: "Clear to Close", closed: "Sold!" }
  const isSeller = persona.includes("seller") || status === "listing"
  return isSeller ? sellerStages[status] || status : buyerStages[status] || status
}

async function generateFriendlyStatusMessage(transaction: any, persona: string): Promise<string> {
  const isSeller = persona.includes("seller") || transaction.transaction_type === "sale"
  const buyerMessages: Record<string, string> = { offer: "Your offer has been submitted! We're waiting to hear back from the seller.", inspection: "Time for the home inspection. We'll make sure everything looks good.", appraisal: "The appraiser is evaluating the home's value for your lender.", financing: "Your loan is being processed. Almost there!", clear_to_close: "You're cleared to close! Final walkthrough coming up.", closed: "Congratulations! The house is officially yours!" }
  const sellerMessages: Record<string, string> = { listing: "Your home is live! We're marketing it to qualified buyers.", offer: "Great news! You've received an offer. Let's review it together.", negotiation: "We're negotiating the best terms for you.", inspection: "The buyer is inspecting the property. This is normal.", appraisal: "The appraisal is in progress. Fingers crossed!", clear_to_close: "You're cleared to close! Almost time to celebrate.", closed: "Congratulations! Your home is sold!" }
  return isSeller
    ? sellerMessages[transaction.status] || "Your listing is progressing smoothly."
    : buyerMessages[transaction.status] || "Your transaction is progressing smoothly."
}

function calculateOverallProgress(transaction: any, timeline: any[]): number {
  const completed = timeline.filter((m) => m.status === "completed").length
  return Math.round((completed / Math.max(timeline.length, 1)) * 100)
}

function calculateDaysUntil(closingDate: string): number {
  if (!closingDate) return 0
  return Math.ceil((new Date(closingDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

function getMilestoneIcon(milestoneName: string): string {
  const icons: Record<string, string> = { "Offer Accepted": "check-circle", "Home Inspection": "search", Appraisal: "dollar-sign", "Loan Processing": "file-text", "Clear to Close": "check-square", Closing: "home" }
  return icons[milestoneName] || "circle"
}

function getUpdateIcon(updateType: string): string {
  const icons: Record<string, string> = { celebration: "party-popper", urgent: "alert-triangle", info: "info", milestone: "flag" }
  return icons[updateType] || "bell"
}
