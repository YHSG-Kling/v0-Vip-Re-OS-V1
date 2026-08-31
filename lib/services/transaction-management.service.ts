

import { createClient } from "@/lib/supabase/server"
import { isValidUUID, validateTransaction } from "@/lib/validations"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
// TRANSACTION_TYPES was imported here and never used — this service only
// updates, reads and archives, so it never sees a type. Its live reader is
// lib/validations/index.ts (validateTransaction), which is where the type
// vocabulary is now enforced.
// Repointed (§6, 2026-08-31, lane M4): this used to validate against the
// scaffolding copy in lib/constants/index.ts (7 values: it refused the live
// states qualifying/clear_to_close/funded/lost/archived and admitted
// withdrawn/expired, which the DB CHECK refuses — every such update would
// validate here and then die at the column). THE vocabulary is the m291
// CHECK-backed list below; the constants copy is deleted with a tombstone.
import { TRANSACTION_STATUSES } from "@/lib/transactions/transaction-status"
import { revalidatePath } from "next/cache"

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

    // validateTransaction (lib/validations/index.ts) collects every id problem
    // instead of stopping at the first, and is the shared spelling of the check
    // this function was doing by hand. It was imported into this file under its
    // deleted alias `validateTransactionData` and never called.
    const idCheck = validateTransaction({ agent_id: params.agentId })
    if (!idCheck.valid) {
      throw new ValidationError(idCheck.errors.join("; "))
    }

    // STATUS IS CHECKED AGAINST THE VOCABULARY, not written through.
    // `updates.status` is a bare `string` that reaches `.update()` unexamined
    // via the `...params.updates` spread below, so a typo — or a caller using
    // the transaction STAGE vocabulary by mistake — silently parked the row in
    // a status no reader matches and no pipeline view lists. TRANSACTION_STATUSES
    // (lib/transactions/transaction-status.ts) is the CHECK-backed list every
    // one of those readers filters on.
    if (
      params.updates.status !== undefined &&
      !(TRANSACTION_STATUSES as readonly string[]).includes(params.updates.status)
    ) {
      throw new ValidationError(`Invalid transaction status: ${params.updates.status}`)
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

    // transactions → contacts carries THREE FKs (transactions_contact_id_fkey,
    // transactions_buyer_contact_id_fkey, transactions_seller_contact_id_fkey), so the
    // bare `contacts(*)` was ambiguous and PostgREST refused the ENTIRE request
    // (PGRST201) — every caller of this function got a thrown/handled error or an
    // empty transaction, never the detail record.
    // Named contact_id: this is the deal's client record, the party the detail view
    // means by "the client on this transaction"; buyer_/seller_contact_id are the
    // per-side links and would blank out whenever the client sits on the other side.
    // transactions → listings is a SINGLE FK (transactions_listing_id_fkey) and needs
    // no hint. Embeds name the columns consumers read (no `*` in an embed, #214).
    const { data, error } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts!transactions_contact_id_fkey(id, first_name, last_name, email, phone),
        listings(id, address, city, state, list_price, status),
        transaction_milestones(id, milestone_name, status, target_date, completed_at),
        transaction_documents(id, doc_label, doc_type, status, created_at),
        commission_distributions(id, distribution_type, calculated_amount, agent_id, status)
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
      // Same three-FK ambiguity as getTransactionDetails above: without the hint
      // PostgREST refused the whole list read (PGRST201) and supabase-js resolved it,
      // so an agent's transaction list came back empty rather than erroring.
      // contact_id = the client on the deal. transactions → listings is a single FK.
      .select(`
        *,
        contacts!transactions_contact_id_fkey(id, first_name, last_name, email),
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
