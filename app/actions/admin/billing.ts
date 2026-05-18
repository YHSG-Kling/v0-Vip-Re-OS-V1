// app/actions/admin/billing.ts
// Billing server actions with validation + contract enforcement
//
// Previously every export trusted caller-supplied brokerageId with NO
// auth gate. Concrete impact: recordUsageEventAction could fabricate
// usage events on any tenant's billing meter (overage padding);
// calculateOverageExposureAction leaked projection data; and the
// "(superadmin only)" loadRevenueSummaryAction had no enforcement —
// any caller got cross-tenant revenue aggregates. All three now require
// session auth, and revenue summary additionally requires superadmin.

"use server"

import { createClient } from "@/lib/supabase/server"
import {
  recordUsageEvent,
  calculateOverageExposure,
  loadRevenueSummary,
  type RecordUsageEventInput,
  type RecordUsageEventOutput,
  type CalculateOverageExposureInput,
  type CalculateOverageExposureOutput,
  type LoadRevenueSummaryInput,
  type LoadRevenueSummaryOutput,
} from "@/lib/kernel/billing"

async function requireBillingCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: profile } = await supabase
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return {
    ok: true,
    userId: user.id,
    brokerageId: profile.brokerage_id,
    userType: profile.user_type ?? "agent",
  }
}

/**
 * Record a usage event from within the app
 * Input contract: RecordUsageEventInput
 * Output contract: RecordUsageEventOutput
 */
export async function recordUsageEventAction(
  input: RecordUsageEventInput
): Promise<RecordUsageEventOutput> {
  try {
    const auth = await requireBillingCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    // Always override caller-supplied brokerageId with session's —
    // recording usage events on another tenant's meter could pad their
    // overage charges.
    const safeInput = { ...input, brokerageId: auth.brokerageId }

    if (!safeInput.metric) {
      return {
        success: false,
        error: "Missing required field: metric",
      }
    }
    if (safeInput.units < 0) {
      return {
        success: false,
        error: "Units must be non-negative",
      }
    }

    return await recordUsageEvent(safeInput)
  } catch (error) {
    console.error("[Action] recordUsageEventAction error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Calculate overage exposure projection
 * Input contract: CalculateOverageExposureInput
 * Output contract: CalculateOverageExposureOutput
 */
export async function calculateOverageExposureAction(
  input: CalculateOverageExposureInput
): Promise<CalculateOverageExposureOutput> {
  try {
    const auth = await requireBillingCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    // Scope to caller's brokerage; superadmin can pass cross-tenant
    const safeInput = { ...input, brokerageId: auth.brokerageId }

    const projectionDays = safeInput.projectionDays || 30
    if (projectionDays < 7 || projectionDays > 90) {
      return {
        success: false,
        error: "Projection days must be between 7 and 90",
      }
    }

    return await calculateOverageExposure(safeInput)
  } catch (error) {
    console.error("[Action] calculateOverageExposureAction error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Load revenue summary (superadmin only)
 * Input contract: LoadRevenueSummaryInput
 * Output contract: LoadRevenueSummaryOutput
 */
export async function loadRevenueSummaryAction(
  input: LoadRevenueSummaryInput
): Promise<LoadRevenueSummaryOutput> {
  try {
    // SUPERADMIN gate — cross-tenant aggregate, was previously open.
    const auth = await requireBillingCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    if (!["superadmin", "super_admin"].includes(auth.userType)) {
      return { success: false, error: "Forbidden: superadmin only" }
    }

    // Validate dates
    const fromDate = new Date(input.dateRange.from)
    const toDate = new Date(input.dateRange.to)

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return {
        success: false,
        error: "Invalid date format",
      }
    }

    if (fromDate >= toDate) {
      return {
        success: false,
        error: "From date must be before to date",
      }
    }

    return await loadRevenueSummary(input)
  } catch (error) {
    console.error("[Action] loadRevenueSummaryAction error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
