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
import { mintContractDocumentUrl } from "@/lib/storage/platform-contract-document"

// The bucket this lane's document arm lives in — read from the ONE upload
// registry (lib/storage/signed-upload-url.ts#UPLOAD_PURPOSES) rather than
// re-spelled here, so a bucket change on the writer's side cannot silently
// leave this reader minting against the wrong bucket (§6).

// Per-render, NOT persisted: sign-on-read (lib/storage/signed-doc-url.ts's own
// documented end-state) rather than a long-lived link stored on a column. Short
// enough that a copied link is useless within the hour, long enough to survive
// a slow page load.

// mintContractDocumentUrl moved to lib/storage/platform-contract-document.ts
// (2026-09-07): the tenant sign lane must hold NO service client so m481's RLS
// stays the second, database-enforced gate on the agreement INSERT
// (scripts/contract-lanes-simulator.ts); the platform-owned document's
// sign-on-read link is minted behind that module instead, after the tenant
// gate here has already run.

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
  /**
   * A short-lived signed GET url for `template.body_storage_path`, minted fresh
   * on every read (never persisted) — the document-arm renderer named in the
   * ruling comment above `template`. null whenever there is no template, the
   * template has an inline body_text instead, there is no storage path, or the
   * mint failed (fail closed: a minting failure is a missing document, not a
   * thrown error the card has to handle).
   */
  documentUrl: string | null
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
  // ── THE LANE NOW EXISTS (2026-09-07, owner ruling: "complete the building and
  // editing for owner decisions … owners decision is build and fix") ──────────
  // Superseded below: this used to say the storage-path arm had no renderer and
  // was kept only so the signing gate could refuse honestly. It now has both.
  //
  // THE RULING. m481 gives this table two body arms and requires exactly that at
  // least one is present:
  //     check (body_text is not null or body_storage_path is not null)
  // THE WRITER: app/actions/superadmin/subscription-contracts.ts's
  // planPlatformContractDocumentUploadAction (mints a signed PUT via the one
  // upload registry, lib/storage/signed-upload-url.ts#UPLOAD_PURPOSES
  // .platform_contract_document) and attachPlatformContractDocumentAction (records
  // the resulting path on body_storage_path, superadmin-gated, path validated
  // against the purpose's own prefix). THE RENDERER is right here: whenever
  // `body_text` is absent and `body_storage_path` is present, this action mints a
  // short-lived signed GET url (CONTRACT_DOCUMENT_VIEW_TTL_SECONDS, sign-on-read
  // rather than a persisted link) and returns it as `documentUrl` — the tenant
  // card renders it as an "Open the agreement (PDF)" link. The signing gate below
  // (signSubscriptionAgreementAction) now refuses ONLY when NEITHER arm renders:
  // no body_text AND no signed url could be minted for body_storage_path.
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
    return { ok: true, view: { template: null, signature: null, awaitingSignature: false, documentUrl: null } }
  }

  const { data: signature, error: sigErr } = await supabase
    .from("tenant_contract_signatures")
    .select("id, signed_name, signed_at, template_version, signature")
    .eq("brokerage_id", caller.brokerage_id)
    .eq("template_id", (template as { id: string }).id)
    .maybeSingle()
  if (sigErr) return { ok: false, error: `Could not read your signature record: ${sigErr.message}` }

  const tpl = template as { body_text: string | null; body_storage_path: string | null }
  // Only mint when body_text is absent — a template with inline text needs no
  // link, and minting one nobody will render would be wasted work on every read.
  const documentUrl = tpl.body_text?.trim() ? null : await mintContractDocumentUrl(tpl.body_storage_path)

  return {
    ok: true,
    view: {
      template: template as SubscriptionAgreementView["template"],
      signature: (signature as SubscriptionAgreementView["signature"]) ?? null,
      awaitingSignature: !signature,
      documentUrl,
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

  // ── A DOCUMENT NOBODY CAN READ IS NOT SIGNABLE HERE (built 2026-09-07) ──────
  // The in-app record rail's whole honesty claim is that the signer read what is
  // on screen (see this file's header), so this refuses UNLESS at least one arm
  // actually renders: inline body_text, or a signed url this call can mint for
  // body_storage_path (mintContractDocumentUrl — the same renderer
  // getSubscriptionAgreementAction uses, so "can this be shown" is answered
  // identically on both the read and the write path). Fail closed (§4): a mint
  // failure here reads as "no document", not as a thrown error.
  const body = template as { body_text: string | null; body_storage_path: string | null }
  const hasInlineText = !!body.body_text?.trim()
  const documentUrl = hasInlineText ? null : await mintContractDocumentUrl(body.body_storage_path)
  if (!hasInlineText && !documentUrl) {
    return {
      ok: false,
      error: body.body_storage_path
        ? "This agreement is a stored document, and a viewable link for it could not be created right now — reload and try again, or contact platform support."
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
