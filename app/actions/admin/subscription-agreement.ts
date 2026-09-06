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
    /** The attestation record itself — `{ method, typed_name, signed_at }`, written
     *  by signSubscriptionAgreementAction below. Projected because the tenant card
     *  already reads it structurally and asked for it in writing
     *  (app/dashboard/admin/billing/subscription-agreement-card.tsx, the SEAM note
     *  above readAttestationMethod): a typed name is what the signer keyed in, this
     *  is how the agreement was EXECUTED, and the tenant is entitled to their own
     *  record of it. Unknown shapes render as no method, never as "verified".
     *  OPTIONAL on purpose: the card builds an optimistic signature object of its
     *  own the moment a signer submits, and that one has no stored jsonb yet —
     *  making the field required would break that construction (measured: tsc
     *  TS2345 at subscription-agreement-card.tsx:72). Absent and null both mean
     *  "no attestation record to show", which is what the card already renders. */
    signature?: Record<string, unknown> | null
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
  //
  // ── KEEP, WITH THE REASON (lane W3, 2026-09-01) ────────────────────────────
  // `body_storage_path` reaches NO PIXEL: the tenant card renders
  // `template.body_text` only (app/dashboard/admin/billing/
  // subscription-agreement-card.tsx:131-134). It is kept anyway, and it is not an
  // inert projection, because it is READ — by the signing gate below.
  //
  // THE RULING. m481 gives this table two body arms and requires exactly that at
  // least one is present:
  //     check (body_text is not null or body_storage_path is not null)
  // In-app authoring writes the body_text arm and only that arm
  // (app/actions/superadmin/subscription-contracts.ts:127-135 update, :144-153
  // insert), so a NULL here is not a missing value — it is the ordinary state of
  // a contract that was typed rather than uploaded. The storage-path arm exists
  // for a future uploaded-document lane, and until that lane also brings a
  // renderer, a document-only template is a contract this surface CANNOT SHOW.
  // Selecting the column is what lets `signSubscriptionAgreementAction` tell that
  // case apart and refuse instead of collecting a signature on a blank screen —
  // see the fail-closed branch there. Live evidence 2026-09-01
  // (hrvaqgvukzxfskkcrwbt): `platform_contract_templates` holds zero rows, so no
  // signing flow in production changes shape.
  //
  // RE-CONFIRMED w26 (lane C8), against a census that flagged body_storage_path as a
  // read with no writer: NOT A DEFECT, ruling unchanged. THE READER IS
  // signSubscriptionAgreementAction's fail-closed branch in this file (see
  // `body.body_storage_path` below, in the `if (!body.body_text?.trim())` guard) —
  // it is what distinguishes "a stored document this screen cannot display" from
  // "no readable body at all" and refuses instead of collecting a signature on a
  // blank screen. The other reader is app/actions/superadmin/subscription-contracts.ts:74.
  // The writer is absent BY RULING, not by omission: in-app authoring fills the
  // body_text arm and m481's CHECK requires exactly one of the two.
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
    .select("id, signed_name, signed_at, template_version, signature")
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
  // The two body arms are read as well: a signature is an attestation that the
  // signer READ the contract, so what is on screen is part of the gate.
  const { data: template, error: tplErr } = await supabase
    .from("platform_contract_templates")
    .select("id, version, is_active, body_text, body_storage_path")
    .eq("id", input.templateId)
    .eq("contract_type", "subscription_agreement")
    .maybeSingle()
  if (tplErr) return { ok: false, error: `Could not load the agreement: ${tplErr.message}` }
  if (!template || !(template as { is_active: boolean }).is_active) {
    return { ok: false, error: "This agreement is no longer the active version — reload and sign the current one" }
  }

  // ── A DOCUMENT NOBODY CAN READ IS NOT SIGNABLE HERE (lane W3, 2026-09-01) ───
  // m481 admits a template whose body is a STORAGE PATH rather than inline text,
  // and this surface has no renderer for one: the tenant card shows `body_text`
  // and nothing else, so a document-only template would put the "Type your full
  // legal name to sign" box under a BLANK contract. The in-app record rail's
  // whole honesty claim is that the signer read what is on screen (see this
  // file's header), so this refuses rather than collecting an attestation to
  // something never displayed. Fail closed (§4): when the storage-path arm
  // finally gets its renderer, this branch is what tells that lane it is done.
  const body = template as { body_text: string | null; body_storage_path: string | null }
  if (!body.body_text?.trim()) {
    return {
      ok: false,
      error: body.body_storage_path
        ? "This agreement is a stored document, and this screen can only display an inline agreement — it cannot be signed here until the document is shown to you. Contact platform support."
        : "This agreement has no readable body yet — nothing can be signed until the platform publishes its text.",
    }
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
