

import { createClient } from "@/lib/supabase/server"
import { isValidUUID, validateTransactionData } from "@/lib/validations"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
import { TRANSACTION_TYPES, TRANSACTION_STATUSES } from "@/lib/constants"
import { revalidatePath } from "next/cache"
import { getDefaultCommissionStructure } from "@/lib/brokerage"

/**
 * Unified Transaction Management Service
 * Consolidates transaction CRUD operations from multiple files
 */

export interface CreateTransactionParams {
  agentId: string
  contactId?: string
  propertyId?: string
  transactionType: string
  listingPrice?: number
  offerPrice?: number
  status?: string
  metadata?: any
}

export interface UpdateTransactionParams {
  transactionId: string
  agentId: string
  updates: {
    status?: string
    stage?: string
    listingPrice?: number
    offerPrice?: number
    closingDate?: string
    metadata?: any
  }
}

/**
 * Create a new transaction
 */
export async function createTransaction(params: CreateTransactionParams) {
  try {
    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    if (params.contactId && !isValidUUID(params.contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    if (params.propertyId && !isValidUUID(params.propertyId)) {
      throw new ValidationError("Invalid property ID")
    }

    // Validate transaction type
    const validTypes = Object.values(TRANSACTION_TYPES)
    if (!validTypes.includes(params.transactionType)) {
      throw new ValidationError(`Invalid transaction type. Must be one of: ${validTypes.join(", ")}`)
    }

    const supabase = await createClient()

    const transactionData = {
      agent_id: params.agentId,
      contact_id: params.contactId || null,
      property_id: params.propertyId || null,
      transaction_type: params.transactionType,
      listing_price: params.listingPrice || null,
      offer_price: params.offerPrice || null,
      status: params.status || TRANSACTION_STATUSES.ACTIVE,
      stage: "Pre-Listing",
      metadata: params.metadata || {},
      created_at: new Date().toISOString(),
    }

    const { data, error } = await supabase.from("transactions").insert(transactionData).select().single()

    if (error) throw error

    // Create initial milestone
    await supabase.from("transaction_milestones").insert({
      transaction_id: data.id,
      milestone_type: "created",
      milestone_date: new Date().toISOString(),
      status: "completed",
      notes: "Transaction created",
    })

    revalidatePath("/dashboard/transactions")
    revalidatePath(`/transactions/${data.id}`)

    console.log("[v0] Transaction created:", data.id)
    return { success: true, transaction: data }
  } catch (error) {
    return handleError(error, "createTransaction")
  }
}

/**
 * Update an existing transaction
 */
export async function updateTransaction(params: UpdateTransactionParams) {
  try {
    if (!isValidUUID(params.transactionId)) {
      throw new ValidationError("Invalid transaction ID")
    }

    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    const supabase = await createClient()

    // Verify ownership
    const { data: existing } = await supabase
      .from("transactions")
      .select("id, agent_id")
      .eq("id", params.transactionId)
      .single()

    if (!existing) {
      throw new NotFoundError("Transaction not found")
    }

    if (existing.agent_id !== params.agentId) {
      throw new ValidationError("Unauthorized to update this transaction")
    }

    const updateData = {
      ...params.updates,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from("transactions")
      .update(updateData)
      .eq("id", params.transactionId)
      .select()
      .single()

    if (error) throw error

    // Log stage change if status changed
    if (params.updates.status) {
      await supabase.from("transaction_milestones").insert({
        transaction_id: params.transactionId,
        milestone_type: "status_change",
        milestone_date: new Date().toISOString(),
        status: "completed",
        notes: `Status changed to ${params.updates.status}`,
      })
    }

    revalidatePath("/dashboard/transactions")
    revalidatePath(`/transactions/${params.transactionId}`)

    console.log("[v0] Transaction updated:", params.transactionId)
    return { success: true, transaction: data }
  } catch (error) {
    return handleError(error, "updateTransaction")
  }
}

/**
 * Get transaction with all related data
 */
export async function getTransactionDetails(transactionId: string, agentId: string) {
  try {
    if (!isValidUUID(transactionId)) {
      throw new ValidationError("Invalid transaction ID")
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts(*),
        listings(*),
        transaction_milestones(*),
        transaction_documents(*),
        commission_splits(*)
      `)
      .eq("id", transactionId)
      .single()

    if (error) throw error

    if (!data) {
      throw new NotFoundError("Transaction not found")
    }

    // Verify access
    if (data.agent_id !== agentId && !isValidUUID(agentId)) {
      throw new ValidationError("Unauthorized access")
    }

    return { success: true, transaction: data }
  } catch (error) {
    return handleError(error, "getTransactionDetails")
  }
}

/**
 * Get all transactions for an agent
 */
export async function getAgentTransactions(agentId: string, filters?: {
  status?: string
  transactionType?: string
  limit?: number
}) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: true, transactions: [] }
    }

    const supabase = await createClient()

    let query = supabase
      .from("transactions")
      .select(`
        *,
        contacts(id, first_name, last_name, email),
        listings(id, address, city, listing_price)
      `)
      .eq("agent_id", agentId)

    if (filters?.status) {
      query = query.eq("status", filters.status)
    }

    if (filters?.transactionType) {
      query = query.eq("transaction_type", filters.transactionType)
    }

    if (filters?.limit) {
      query = query.limit(filters.limit)
    }

    const { data, error } = await query.order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, transactions: data || [] }
  } catch (error) {
    return handleError(error, "getAgentTransactions")
  }
}

/**
 * Archive/delete a transaction (soft delete)
 */
export async function archiveTransaction(transactionId: string, agentId: string) {
  try {
    if (!isValidUUID(transactionId)) {
      throw new ValidationError("Invalid transaction ID")
    }

    const supabase = await createClient()

    // Verify ownership
    const { data: existing } = await supabase
      .from("transactions")
      .select("id, agent_id")
      .eq("id", transactionId)
      .single()

    if (!existing) {
      throw new NotFoundError("Transaction not found")
    }

    if (existing.agent_id !== agentId) {
      throw new ValidationError("Unauthorized to archive this transaction")
    }

    const { error } = await supabase
      .from("transactions")
      .update({
        status: TRANSACTION_STATUSES.ARCHIVED,
        archived_at: new Date().toISOString(),
      })
      .eq("id", transactionId)

    if (error) throw error

    revalidatePath("/dashboard/transactions")

    return { success: true }
  } catch (error) {
    return handleError(error, "archiveTransaction")
  }
}

/**
 * Calculate commission for a transaction
 */
export async function calculateTransactionCommission(params: {
  transactionId: string
  salePrice: number
  brokerageId: string
  commissionRate?: number
}) {
  try {
    const supabase = await createClient()

    // Commission Engine 8.0 will own this calculation.
    // getDefaultCommissionStructure() provides rates — multiplication happens in engine only.
    // TODO: wire calculateCommission({ transactionId, brokerageId, agentId }) here.
    const grossCommission = 0
    const agentSplit = 0
    const brokerageSplit = 0

    // Store commission calculation
    await supabase.from("commission_splits").insert({
      transaction_id: params.transactionId,
      gross_commission: grossCommission,
      agent_commission: agentSplit,
      brokerage_commission: brokerageSplit,
      commission_rate: commissionRate,
      calculated_at: new Date().toISOString(),
    })

    return {
      success: true,
      commission: {
        gross: grossCommission,
        agent: agentSplit,
        brokerage: brokerageSplit,
        rate: commissionRate,
      },
    }
  } catch (error) {
    return handleError(error, "calculateTransactionCommission")
  }
}
