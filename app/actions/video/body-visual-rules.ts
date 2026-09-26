"use server"

// app/actions/video/body-visual-rules.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE HUMAN HALF of the learned body-visual rules (wave 80 integration; owner:
// "if there is any changes to the registry rule for the purpose allowable
// autonomous ai can learn"). The loop (lib/video/format-learning.ts
// runBodyVisualRuleLearning, on the daily brokerage-intelligence mine) applies
// bounded rule changes and tells the humans through the manager-signal rail;
// these two doors let the tenant's admin SEE what was learned and REVERT it.
// Tenant from the SESSION (requireTenantAdminOrSoloOwner), never the body;
// the ledger is append-only, so a revert stamps the entry and raises
// body_visual_rule_reverted — nothing is erased.
import { createServiceClient } from "@/lib/supabase/service"
import { requireTenantAdminOrSoloOwner } from "@/lib/auth/require-caller"
import type { BodyVisualRuleOverride } from "@/lib/video/body-visual-model"
import { listBodyVisualRuleOverrides, revertBodyVisualRuleOverride } from "@/lib/video/body-visual-rule-ledger"

export async function listBodyVisualRulesAction(): Promise<{ ok: true; overrides: BodyVisualRuleOverride[] } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  try {
    return { ok: true, overrides: await listBodyVisualRuleOverrides(auth.brokerageId, createServiceClient()) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "learned rules could not be read" }
  }
}

export async function revertBodyVisualRuleAction(input: { overrideId: string; reason: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const overrideId = typeof input?.overrideId === "string" ? input.overrideId.trim() : ""
  const reason = typeof input?.reason === "string" && input.reason.trim() ? input.reason.trim() : "reverted by the brokerage admin"
  if (!overrideId) return { ok: false, error: "overrideId required" }
  const r = await revertBodyVisualRuleOverride(auth.brokerageId, overrideId, reason, createServiceClient())
  return r.ok ? { ok: true } : { ok: false, error: r.reason }
}
