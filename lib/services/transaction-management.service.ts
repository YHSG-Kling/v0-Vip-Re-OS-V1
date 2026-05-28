

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
        target_date: new Date().toISOString(),
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
        commission_distributions(*)
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
        status: "archived",
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

    // NOTE: Commission Engine 8.0 owns real calculation. This stores the stub.
    await supabase.from("commission_distributions").insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      distribution_type: "brokerage",
      calculation_type: "percent",
      calculation_value: params.commissionRate || 0,
      calculated_amount: 0, // placeholder until Engine 8.0 wires real calculation
      source_of_funds: "brokerage",
      cap_applied: false,
      calculation_version: 1,
      status: "pending",
    })

    return {
      success: true,
      commission: {
        gross: grossCommission,
        agent: agentSplit,
        brokerage: brokerageSplit,
        rate: params.commissionRate,
      },
    }
  } catch (error) {
    return handleError(error, "calculateTransactionCommission")
  }
}
