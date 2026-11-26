"use server"

/**
 * The gated door onto lib/ai-isa/qualification-evaluator.ts for the ISA console.
 *
 * WHY (integrator, 2026-09-03, CLAUDE.md §4 + §5). The evaluator carried a
 * module-level "use server" and the console client imported it directly, so
 * `evaluateLeadQualification(leadId)` was a public HTTP endpoint that evaluated
 * — and persisted signals for — ANY lead id, the tenant taken from the lead
 * row rather than from the caller. Leads belong to the brokerage; a caller may
 * only re-evaluate a lead of their own tenant. The evaluator is `server-only`
 * now and its other caller (handle-inbound-email, itself a gated action) stays
 * in-process. This door proves the lead is the caller's before delegating.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requireCaller } from "@/lib/auth/require-caller"
import { isValidUUID } from "@/lib/validations"
import { evaluateLeadQualification as evaluate } from "@/lib/ai-isa/qualification-evaluator"
import type { QualificationSignals } from "@/lib/ai-isa/qualification-core"

export async function evaluateLeadQualificationAction(
  leadId: string,
): Promise<{ success: true; signals: QualificationSignals } | { success: false; error: string }> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (!isValidUUID(leadId)) return { success: false, error: "Invalid lead id" }

  // Tenant pin BEFORE the evaluator runs: a lead outside the caller's brokerage
  // reads as not found, never as "evaluated". Counted read, error read (§3).
  const svc = createServiceClient()
  const { data: lead, error } = await svc
    .from("leads")
    .select("id")
    .eq("id", leadId)
    .eq("brokerage_id", caller.brokerageId)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!lead) return { success: false, error: "Lead not found in your brokerage" }

  try {
    const signals = await evaluate(leadId)
    return { success: true, signals }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
