import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

// ─── GET PROVIDER CONNECTION STATUS ──────────────────────────────────────────
export async function getProviderConnectionStatus(brokerageId: string) {
  const supabase = await createClient()

  const { data: credentials } = await supabase
    .from("integration_credentials")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .in("provider_name", ["quickbooks", "xero"])

  const quickbooks = credentials?.find((c) => c.provider_name === "quickbooks")
  const xero = credentials?.find((c) => c.provider_name === "xero")

  // Get last sync for each provider
  const { data: lastSyncs } = await supabase
    .from("accounting_sync_log")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .in("provider", ["quickbooks", "xero"])
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(2)

  const qbLastSync = lastSyncs?.find((s) => s.provider === "quickbooks")
  const xeroLastSync = lastSyncs?.find((s) => s.provider === "xero")

  return {
    quickbooks: {
      connected: quickbooks?.is_active ?? false,
      companyName: quickbooks?.webhook_url ?? null, // Using webhook_url as company name storage
      lastSyncedAt: qbLastSync?.completed_at ?? null,
      credentialId: quickbooks?.id ?? null,
    },
    xero: {
      connected: xero?.is_active ?? false,
      companyName: xero?.webhook_url ?? null,
      lastSyncedAt: xeroLastSync?.completed_at ?? null,
      credentialId: xero?.id ?? null,
    },
  }
}

// ─── DISCONNECT PROVIDER ─────────────────────────────────────────────────────
export async function disconnectProvider(data: {
  provider: "quickbooks" | "xero"
  brokerageId: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Verify user has broker/admin role
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile || !["broker", "admin"].includes(profile.user_type ?? profile.role ?? "")) {
    throw new Error("Unauthorized: broker or admin role required")
  }

  // Deactivate the credential
  const { error } = await supabase
    .from("integration_credentials")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("brokerage_id", data.brokerageId)
    .eq("provider_name", data.provider)

  if (error) throw error

  // Log kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id: data.brokerageId,
    event_type: KernelEvent.INTEGRATION_DEACTIVATED,
    entity_type: "integration_credentials",
    entity_id: data.brokerageId,
    actor_user_id: user.id,
    metadata: {
      provider: data.provider,
      disconnected_by: user.id,
    },
    created_at: new Date().toISOString(),
  })

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}

// ─── GET SYNC HISTORY ────────────────────────────────────────────────────────
export async function getSyncHistory(data: {
  brokerageId: string
  provider?: string
  status?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("accounting_sync_log")
    .select("*", { count: "exact" })
    .eq("brokerage_id", data.brokerageId)
    .order("started_at", { ascending: false })

  if (data.provider) {
    query = query.eq("provider", data.provider)
  }

  if (data.status) {
    query = query.eq("status", data.status)
  }

  if (data.dateFrom) {
    query = query.gte("started_at", data.dateFrom)
  }

  if (data.dateTo) {
    query = query.lte("started_at", data.dateTo)
  }

  query = query.range(data.offset ?? 0, (data.offset ?? 0) + (data.limit ?? 20) - 1)

  const { data: logs, count, error } = await query

  if (error) throw error

  return { logs: logs || [], count: count ?? 0 }
}

// ─── GET SYNC ERRORS ─────────────────────────────────────────────────────────
export async function getSyncErrors(data: {
  brokerageId: string
  syncLogId?: string
  limit?: number
  offset?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("sync_errors")
    .select("*", { count: "exact" })
    .eq("brokerage_id", data.brokerageId)
    .order("created_at", { ascending: false })

  if (data.syncLogId) {
    query = query.eq("sync_log_id", data.syncLogId)
  }

  query = query.range(data.offset ?? 0, (data.offset ?? 0) + (data.limit ?? 50) - 1)

  const { data: errors, count, error } = await query

  if (error) throw error

  return { errors: errors || [], count: count ?? 0 }
}

// ─── RETRY SYNC ERROR ────────────────────────────────────────────────────────
export async function retrySyncError(data: {
  errorId: string
  brokerageId: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Get the error details
  const { data: errorRecord, error: fetchError } = await supabase
    .from("sync_errors")
    .select("*")
    .eq("id", data.errorId)
    .eq("brokerage_id", data.brokerageId)
    .single()

  if (fetchError || !errorRecord) throw new Error("Error record not found")

  // Delete the error (mark as retried by removing from table)
  const { error: deleteError } = await supabase
    .from("sync_errors")
    .delete()
    .eq("id", data.errorId)

  if (deleteError) throw deleteError

  // Log that we're re-queuing this record
  await supabase.from("lifecycle_events").insert({
    brokerage_id: data.brokerageId,
    event_type: KernelEvent.SYSTEM_SYNC_TRIGGERED,
    entity_type: "sync_errors",
    entity_id: data.errorId,
    actor_user_id: user.id,
    metadata: {
      record_type: errorRecord.record_type,
      record_id: errorRecord.record_id,
      retried_by: user.id,
    },
    created_at: new Date().toISOString(),
  })

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}

// ─── GET TAX CATEGORIES ──────────────────────────────────────────────────────
export async function getTaxCategories(brokerageId: string) {
  const supabase = await createClient()

  const { data: categories, error } = await supabase
    .from("tax_categories")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("category_name", { ascending: true })

  if (error) throw error

  return categories || []
}

// ─── UPDATE TAX CATEGORY ──────────────────────────────��──────────────────────
export async function updateTaxCategory(data: {
  categoryId: string
  brokerageId: string
  taxCode?: string
  providerAccountId?: string
  isActive?: boolean
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const updates: Record<string, unknown> = {}
  if (data.taxCode !== undefined) updates.tax_code = data.taxCode
  if (data.providerAccountId !== undefined) updates.provider_account_id = data.providerAccountId
  if (data.isActive !== undefined) updates.is_active = data.isActive

  const { error } = await supabase
    .from("tax_categories")
    .update(updates)
    .eq("id", data.categoryId)
    .eq("brokerage_id", data.brokerageId)

  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}

// ─── CREATE TAX CATEGORY ─────────────────────────────────────────────────────
export async function createTaxCategory(data: {
  brokerageId: string
  categoryName: string
  taxCode?: string
  providerAccountId?: string
  appliesTo?: string[]
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: category, error } = await supabase
    .from("tax_categories")
    .insert({
      brokerage_id: data.brokerageId,
      category_name: data.categoryName,
      tax_code: data.taxCode,
      provider_account_id: data.providerAccountId,
      applies_to: data.appliesTo || [],
      is_active: true,
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return category
}

// ─── CLEAR RESOLVED ERRORS ───────────────────────────────────────────────────
export async function clearResolvedErrors(brokerageId: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Delete all errors for this brokerage (they can retry individually if needed)
  const { error } = await supabase
    .from("sync_errors")
    .delete()
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}
