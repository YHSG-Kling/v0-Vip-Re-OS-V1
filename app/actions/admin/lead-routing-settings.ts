"use server"

/**
 * app/actions/admin/lead-routing-settings.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The brokerage's DEFAULT assignment method — an admin/broker decision.
 *
 * Per-rule methods live on assignment_rules. This is the one that decides every
 * new contact and newly converted lead that NO rule matches, which in practice
 * is most of them. It was hardcoded capacity-based load balancing in both
 * routers, so the method deciding the majority of assignments was the only one
 * the admin could not set (m305).
 *
 * The value is validated against the routing module before it reaches the
 * column. brokerages.default_assignment_method is CHECK-constrained, so an
 * invalid value would be rejected by Postgres — but a raw constraint string is
 * not an answer, and a discarded error is worse: supabase-js RESOLVES a rejected
 * write, so ignoring the result makes a refused save indistinguishable from a
 * successful one.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { revalidatePath } from "next/cache"
import { isRuleType, RULE_TYPE_LABELS, type RuleType } from "@/lib/lead-assignment/rule-matcher"

/** Broker + admin only — the same gate the Settings page itself applies. */
async function requireRoutingAdmin(): Promise<
  { ok: true; brokerageId: string } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Not authenticated" }
  const type = ctx.userType ?? ctx.role ?? ""
  if (!["broker", "admin"].includes(type)) {
    return { ok: false, error: "Only a broker or an admin can change how leads are assigned." }
  }
  return { ok: true, brokerageId: ctx.brokerageId }
}

export async function getDefaultAssignmentMethod(): Promise<{
  method: RuleType
  error?: string
}> {
  const gate = await requireRoutingAdmin()
  if (!gate.ok) return { method: "load_balance", error: gate.error }

  const service = createServiceClient()
  const { data, error } = await service
    .from("brokerages")
    .select("default_assignment_method")
    .eq("id", gate.brokerageId)
    .maybeSingle()

  if (error) return { method: "load_balance", error: error.message }
  const m = (data as { default_assignment_method?: string } | null)?.default_assignment_method
  return { method: isRuleType(m) ? m : "load_balance" }
}

export async function setDefaultAssignmentMethod(
  method: string,
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireRoutingAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  if (!isRuleType(method)) {
    return {
      success: false,
      error: `"${method}" is not an assignment method. Choose one of: ${Object.values(RULE_TYPE_LABELS).join(", ")}.`,
    }
  }

  const service = createServiceClient()
  // The error is READ, not discarded. A rejected write that looks successful is
  // the defect class this repo keeps finding.
  const { error } = await service
    .from("brokerages")
    .update({ default_assignment_method: method, updated_at: new Date().toISOString() })
    .eq("id", gate.brokerageId)

  if (error) return { success: false, error: error.message }

  revalidatePath("/dashboard/settings")
  revalidatePath("/dashboard/admin/assignment-rules")
  return { success: true }
}
