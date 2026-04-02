// app/actions/admin/billing.ts
// Billing server actions with validation + contract enforcement

"use server"

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

/**
 * Record a usage event from within the app
 * Input contract: RecordUsageEventInput
 * Output contract: RecordUsageEventOutput
 */
export async function recordUsageEventAction(
  input: RecordUsageEventInput
): Promise<RecordUsageEventOutput> {
  try {
    // Validate input
    if (!input.brokerageId || !input.metric) {
      return {
        success: false,
        error: "Missing required fields: brokerageId, metric",
      }
    }

    if (input.units < 0) {
      return {
        success: false,
        error: "Units must be non-negative",
      }
    }

    // Call kernel command
    const result = await recordUsageEvent(input)

    return result
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
    // Validate input
    if (!input.brokerageId) {
      return {
        success: false,
        error: "Missing required field: brokerageId",
      }
    }

    const projectionDays = input.projectionDays || 30
    if (projectionDays < 7 || projectionDays > 90) {
      return {
        success: false,
        error: "Projection days must be between 7 and 90",
      }
    }

    // Call kernel command
    const result = await calculateOverageExposure(input)

    return result
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

    // Call kernel command
    const result = await loadRevenueSummary(input)

    return result
  } catch (error) {
    console.error("[Action] loadRevenueSummaryAction error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
