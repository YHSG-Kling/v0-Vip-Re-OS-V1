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
import { createClient } from "@/lib/supabase/server"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { getAgentContext } from "@/lib/identity"
import { revalidatePath } from "next/cache"
import { isRuleType, RULE_TYPE_LABELS, type RuleType } from "@/lib/lead-assignment/rule-matcher"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import {
  MAILBOX_OWNER_PREFERENCE_DEFAULT,
  MAILBOX_OWNER_PREFERENCE_KEY,
  mailboxOwnerPreferenceFromSettings,
} from "@/lib/lead-assignment/mailbox-owner-preference"

/**
 * May this caller change how the brokerage's leads are assigned?
 *
 * The inline ["broker","admin"] this replaces was one of 46 spellings of the same
 * question, and it was the narrowest of them: it refused broker_owner — the person
 * who OWNS the brokerage — and team_lead, whom the owner's ruling names admin-class.
 *
 * resolveTenantAdmin rather than the sync predicate, because lead routing is
 * brokerage-wide configuration and this action is already async: a user holding an
 * `admin` GRANT on this brokerage administers it, which is what
 * public.is_brokerage_admin() has decided since m466. The SESSION client is used on
 * purpose — RLS still applies underneath, and user_role_assignments_select_own is
 * what lets a caller read their own grants.
 */
async function requireRoutingAdmin(): Promise<
  { ok: true; brokerageId: string } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { ok: false, error: "Not authenticated" }

  const supabase = await createClient()
  const admin = await resolveTenantAdmin(supabase, ctx.userId, {
    user_type: ctx.userType,
    brokerage_id: ctx.brokerageId,
  })
  // supabase-js RESOLVES a refused query. Reporting that as the ordinary refusal
  // below would tell an administrator they are not one, during an outage.
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin) {
    return { ok: false, error: "Only a broker, an admin or a team lead can change how leads are assigned." }
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

// ─── MAILBOX-OWNER SWITCH — RESTORED AS AN OPTION (wave 88, lane 88A) ─────────────
// Owner, verbatim: "We do also need the mailbox switch back for another option." Lane 87A had retired
// these two doors (lane 86A2 built them); they are back, reshaped onto what 87A left: DEFAULT ON (the
// owner's wave-87 direction — "it should lead back to the agent" — stays the default), switchable OFF
// by the same admins who set the default method (requireRoutingAdmin above; tenant from the SESSION).
// Stored in the EXISTING jsonb brokerage_settings.settings.lead_routing.prefer_mailbox_owner — no
// migration — and WRITTEN only through the one settings writer (lib/settings/brokerage-settings-merge.ts,
// merge-by-key with a version check). The rung that honours it: lib/lead-assignment/
// mailbox-owner-preference.ts decideMailboxOwnerPreference (via tier-routing.ts resolveTierRouting).

export async function getMailboxOwnerPreference(): Promise<{ enabled: boolean; error?: string }> {
  const gate = await requireRoutingAdmin()
  if (!gate.ok) return { enabled: MAILBOX_OWNER_PREFERENCE_DEFAULT, error: gate.error }
  const { data, error } = await createServiceClient()
    .from("brokerage_settings")
    .select("settings")
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  if (error) return { enabled: MAILBOX_OWNER_PREFERENCE_DEFAULT, error: `Could not read the lead-routing settings: ${error.message}` }
  return { enabled: mailboxOwnerPreferenceFromSettings((data as { settings?: unknown } | null)?.settings) }
}

export async function setMailboxOwnerPreference(
  enabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireRoutingAdmin()
  if (!gate.ok) return { success: false, error: gate.error }
  if (typeof enabled !== "boolean") return { success: false, error: "The mailbox-owner switch is either on or off." }

  // Merged BY KEY through the one settings writer: every other settings key (and every other
  // lead_routing key) survives a concurrent save; the row is created if absent.
  const write = await mergeBrokerageSettings(createServiceClient(), gate.brokerageId, (settings) => {
    const current = settings.lead_routing
    const prior = (current && typeof current === "object" ? current : {}) as Record<string, unknown>
    return { lead_routing: { ...prior, [MAILBOX_OWNER_PREFERENCE_KEY]: enabled } }
  })
  if (!write.ok) return { success: false, error: `Could not save the mailbox-owner switch: ${write.error}` }

  revalidatePath("/dashboard/settings")
  revalidatePath("/dashboard/admin/assignment-rules")
  return { success: true }
}
