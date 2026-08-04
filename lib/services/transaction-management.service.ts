

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

    // Log the status change to the transaction TIMELINE (the canonical audit log) —
    // NOT transaction_milestones. The previous code inserted a milestone row with a
    // non-canonical milestone_type ("status_change") and no milestone_name, which
    // violates the NOT NULL constraint and threw on every status change, AND it
    // polluted the client milestone timeline with an internal audit event.
    if (params.updates.status) {
      await supabase.from("transaction_timeline").insert({
        transaction_id: params.transactionId,
        activity_type: "status_change",
        description: `Status changed to ${params.updates.status}`,
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
        listings(id, address, city, list_price)
      `)
      .eq("agent_id", agentId)

    if (filters?.status) {
      query = query.eq("status", filters.status)
    }

    if (filters?.transactionType) {
      query = query.eq("deal_type", filters.transactionType)
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
        deleted_at: new Date().toISOString(),
      })
      .eq("id", transactionId)

    if (error) throw error

    revalidatePath("/dashboard/transactions")

    return { success: true }
  } catch (error) {
    return handleError(error, "archiveTransaction")
  }
}

// CONSOLIDATED AWAY — calculateTransactionCommission.
//
// It was a self-declared placeholder: it returned gross/agent/brokerage as hard 0 and its own
// comments said "Commission Engine 8.0 will own this calculation" and "TODO: wire
// calculateCommission({ transactionId, brokerageId, agentId }) here". That engine is now
// built and is the named survivor — lib/commission/engine.ts:calculateCommission, the
// eleven-step waterfall (rate → gross → adjustments → split → cap → team → revenue share →
// fees → validate/persist) which writes the agent_commissions summary AND its per-line
// commission_distributions with a real commission_id. Nothing this function did is lost;
// every part of it exists there in a form that computes actual money.
//
// It was also actively harmful to leave wired-able. It inserted a zero-amount distribution
// with NO commission_id, and a row like that can never be marked paid by any path — which
// pins the transaction's aggregate ledger status at 'pending' forever and makes the
// tracking-drift reaper alarm on every pass without ever converging.
//
// It had zero callers at removal.
