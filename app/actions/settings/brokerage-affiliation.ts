"use server"

// app/actions/settings/brokerage-affiliation.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DECLARED AFFILIATION DOOR (wave 141, lane 141A). A solo/team subscriber
// declares the brokerage they are affiliated with — a NAME and optional
// licence / location / reference — on their OWN tenant, for business context.
// It is NOT a tenancy claim: nothing matches it against another tenant (lib/
// kernel/brokerage-identity.ts holds the rule and the writer). An org-tier
// tenant IS a brokerage and has nothing to declare (the card is hidden).
//
// Separate from app/actions/settings/brokerage-identity.ts on purpose: that
// allow-listed writer owns the tenant's OWN identity columns (name, dba,
// licence, address) under the finance-admin policy; this writes one jsonb
// column through the kernel's one writer, gated by the solo-owner-or-admin
// rule (tier parity — a solo seat may carry user_type 'agent').
//
// Every export is a public HTTP endpoint (CLAUDE.md §4): tenant from the
// SESSION, nothing from the body selects a tenant.

import { createServiceClient } from "@/lib/supabase/service"
import { requireTenantAdminOrSoloOwner } from "@/lib/auth/require-caller"
import {
  declareBrokerageAffiliation, readDeclaredAffiliation, isIndependentSubscriberTier,
  type DeclaredAffiliation, type DeclaredAffiliationInput,
} from "@/lib/kernel/brokerage-identity"

export interface AffiliationPanel {
  /** False for an org-tier tenant (it IS the brokerage) — the card renders nothing. */
  applicable: boolean
  planTier: string | null
  affiliation: DeclaredAffiliation | null
  /** m765 not applied yet — the card says the declaration cannot be saved yet, honestly. */
  columnMissing: boolean
}

export async function getBrokerageAffiliationPanelAction(): Promise<{ ok: true; panel: AffiliationPanel } | { ok: false; error: string }> {
  const owner = await requireTenantAdminOrSoloOwner()
  if (!owner.ok) return owner
  const svc = createServiceClient()
  const { data: tenant, error: tErr } = await svc.from("brokerages").select("plan_tier").eq("id", owner.brokerageId).maybeSingle()
  if (tErr) return { ok: false, error: `Could not read your plan: ${tErr.message}` }
  const planTier = (tenant as { plan_tier?: string | null } | null)?.plan_tier ?? null
  if (!isIndependentSubscriberTier(planTier)) return { ok: true, panel: { applicable: false, planTier, affiliation: null, columnMissing: false } }
  const read = await readDeclaredAffiliation(svc, owner.brokerageId)
  if (!read.ok) {
    if (read.columnMissing) return { ok: true, panel: { applicable: true, planTier, affiliation: null, columnMissing: true } }
    return { ok: false, error: `Could not read your declared affiliation: ${read.error}` }
  }
  return { ok: true, panel: { applicable: true, planTier, affiliation: read.affiliation, columnMissing: false } }
}

export async function declareBrokerageAffiliationAction(input: DeclaredAffiliationInput): Promise<{ ok: true; affiliation: DeclaredAffiliation } | { ok: false; error: string }> {
  const owner = await requireTenantAdminOrSoloOwner()
  if (!owner.ok) return owner
  const svc = createServiceClient()
  const { data: tenant, error: tErr } = await svc.from("brokerages").select("plan_tier").eq("id", owner.brokerageId).maybeSingle()
  if (tErr) return { ok: false, error: `Could not read your plan: ${tErr.message}` }
  if (!isIndependentSubscriberTier((tenant as { plan_tier?: string | null } | null)?.plan_tier)) {
    return { ok: false, error: "Your workspace is the brokerage itself — there is no affiliated brokerage to declare." }
  }
  const r = await declareBrokerageAffiliation(svc, owner.brokerageId, (input ?? {}) as DeclaredAffiliationInput & Record<string, unknown>, { userId: owner.userId, source: "settings" })
  if (!r.ok) return { ok: false, error: r.columnMissing ? "Declared affiliations cannot be saved yet — the platform is finishing this feature's rollout. Your workspace is unchanged." : r.error }
  return { ok: true, affiliation: r.affiliation }
}
