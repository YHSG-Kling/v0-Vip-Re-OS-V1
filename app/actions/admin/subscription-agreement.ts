"use server"

// app/actions/admin/subscription-agreement.ts
// ─────────────────────────────────────────────────────────────────────────────
// LANE 1 (m481), TENANT HALF — the brokerage SIGNS the platform-authored
// subscription agreement, in-app (owner ruling: "platform contracts for tenants
// has to be written in order for the tenant to sign for their subscription").
//
// The signing mechanism is the IN-APP record rail (the same honesty rule as the
// transaction-document signature ledger and markContractSignedManually): the
// tenant admin reads the contract body on screen, types their name, and the
// row in tenant_contract_signatures IS the signature. NO e-sign provider is
// involved and none is simulated — this repo refuses fake provider sends.
//
// Identity is server-resolved end to end: the brokerage is the CALLER's
// brokerage (never a parameter), the signer is the session user. The insert
// goes through the AUTHED client on purpose, so m481's RLS lane
// (is_brokerage_admin() AND the tenant pin) is a second, database-enforced
// gate rather than a bypassed one.

import { createClient } from "@/lib/supabase/server"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"

export interface SubscriptionAgreementView {
  template: {
    id: string
    name: string
    body_text: string | null
    body_storage_path: string | null
    version: number
  } | null
  signature: {
    id: string
    signed_name: string
    signed_at: string
    template_version: number | null
  } | null
  /** True when an active agreement exists and this brokerage has not signed it. */
  awaitingSignature: boolean
}

// ─── What the tenant sees on the billing/activation surface ──────────────────

export async function getSubscriptionAgreementAction(): Promise<
  { ok: true; view: SubscriptionAgreementView } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false, error: "Unauthorized" }

  const { data: caller, error: callerErr } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (callerErr) return { ok: false, error: `Could not resolve your account: ${callerErr.message}` }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on this account" }

  // The ACTIVE subscription agreement (RLS lets any signed-in tenant seat read
  // active templates — a tenant must be able to read what they are asked to sign).
  const { data: template, error: tplErr } = await supabase
    .from("platform_contract_templates")
    .select("id, name, body_text, body_storage_path, version")
    .eq("contract_type", "subscription_agreement")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (tplErr) return { ok: false, error: `Could not load the subscription agreement: ${tplErr.message}` }

  if (!template) {
    // Nothing authored yet — honestly nothing to sign (never invent a contract).
    return { ok: true, view: { template: null, signature: null, awaitingSignature: false } }
  }

  const { data: signature, error: sigErr } = await supabase
    .from("tenant_contract_signatures")
    .select("id, signed_name, signed_at, template_version")
    .eq("brokerage_id", caller.brokerage_id)
    .eq("template_id", (template as { id: string }).id)
    .maybeSingle()
  if (sigErr) return { ok: false, error: `Could not read your signature record: ${sigErr.message}` }

  return {
    ok: true,
    view: {
      template: template as SubscriptionAgreementView["template"],
      signature: (signature as SubscriptionAgreementView["signature"]) ?? null,
      awaitingSignature: !signature,
    },
  }
}

// ─── The tenant admin signs ──────────────────────────────────────────────────

export async function signSubscriptionAgreementAction(input: {
  templateId: string
  /** The name the signer types — the in-app equivalent of the signature line. */
  signedName: string
}): Promise<{ ok: true; signatureId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false, error: "Unauthorized" }

  const signedName = (input.signedName ?? "").trim()
  if (!signedName) return { ok: false, error: "Type your full name to sign" }

  const { data: caller, error: callerErr } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (callerErr) return { ok: false, error: `Could not resolve your account: ${callerErr.message}` }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on this account" }

  // Signing binds the BROKERAGE — only its admin seats may do that. Guards a
  // WRITE → resolveTenantAdmin (both halves: user_type AND a tenant role grant),
  // the same predicate m481's RLS applies as is_brokerage_admin().
  const adminResult = await resolveTenantAdmin(supabase, user.id, caller)
  if (!adminResult.ok) return { ok: false, error: adminResult.error }
  if (!adminResult.isTenantAdmin) {
    return { ok: false, error: "Only your brokerage's admins can sign the subscription agreement" }
  }

  // The template must be the ACTIVE agreement — a retired version is not on offer.
  const { data: template, error: tplErr } = await supabase
    .from("platform_contract_templates")
    .select("id, version, is_active")
    .eq("id", input.templateId)
    .eq("contract_type", "subscription_agreement")
    .maybeSingle()
  if (tplErr) return { ok: false, error: `Could not load the agreement: ${tplErr.message}` }
  if (!template || !(template as { is_active: boolean }).is_active) {
    return { ok: false, error: "This agreement is no longer the active version — reload and sign the current one" }
  }

  // Already signed? The record is immutable — say so instead of failing on the
  // unique constraint.
  const { data: existing, error: existErr } = await supabase
    .from("tenant_contract_signatures")
    .select("id")
    .eq("brokerage_id", caller.brokerage_id)
    .eq("template_id", input.templateId)
    .maybeSingle()
  if (existErr) return { ok: false, error: `Could not check for an existing signature: ${existErr.message}` }
  if (existing) return { ok: true, signatureId: (existing as { id: string }).id }

  // AUTHED insert — RLS (is_brokerage_admin + tenant pin) is the database gate.
  // brokerage_id is the CALLER's, signed_by is the session user: server-resolved.
  const { data: inserted, error: insErr } = await supabase
    .from("tenant_contract_signatures")
    .insert({
      brokerage_id: caller.brokerage_id,
      template_id: input.templateId,
      template_version: (template as { version: number }).version,
      signed_by: user.id,
      signed_name: signedName,
      signature: {
        method: "in_app_click_to_sign",
        typed_name: signedName,
        signed_at: new Date().toISOString(),
      },
    })
    .select("id")
    .single()
  if (insErr) return { ok: false, error: `Signature was not recorded: ${insErr.message}` }
  if (!inserted) return { ok: false, error: "Signature was not recorded — you may not have permission to sign for this brokerage" }

  return { ok: true, signatureId: (inserted as { id: string }).id }
}
