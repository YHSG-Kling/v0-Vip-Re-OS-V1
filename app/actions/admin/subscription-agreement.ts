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
//
// WAVE 151 (lane 151A — the owner's acceptance ruling), on this same door:
//   · THE SIGNATORY IS THE CORPORATE SUBSCRIBER'S, not any admin seat. The
//     tenant-admin gate stays as the floor (m481 / RLS parity); on top of it
//     lib/legal/subscription-agreement.ts assessSignatoryAuthority requires the
//     seat that may keep the brokerage's books (resolveBrokerageFinanceAdmin —
//     the live is_brokerage_finance_admin() twin, which m959 pins the INSERT
//     policy to) and, in a multi-location brokerage, the organization's
//     leadership grant. A compliance officer, an office head, a team lead inside
//     a brokerage: refused by name.
//   · VERSION + HASH + IMMUTABLE COPY + EVIDENCE: buildAcceptanceRow carries the
//     template's version label and content hash, the accepted text itself, the
//     signatory record (account, typed name and title, the legal entity bound,
//     the authority basis), ip and user agent. A draft or unapproved version is
//     refused (acceptanceRefusal) — the DB's CHECK says the same.
//   · RETRIEVABLE: downloadAcceptedAgreementAction hands back the accepted copy
//     with its hash re-verified (an altered copy is refused, never served).
//   · RE-ACCEPTANCE: the view is "awaiting" whenever the ACTIVE version has no
//     acceptance from this brokerage — a new approved version re-opens it.

import { headers } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { mintContractDocumentUrl } from "@/lib/storage/platform-contract-document"
import {
  assessSignatoryAuthority, acceptanceRefusal, buildAcceptanceRow, readAcceptedCopy,
  type AcceptanceTemplate, type AcceptedCopy,
} from "@/lib/legal/subscription-agreement"

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
    /** The document's own version label (docs/legal header), when recorded. */
    version_label?: string | null
    /** sha256 of the text / document — what an acceptance is pinned to. */
    content_sha256?: string | null
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
    /** wave 151: the version label and content hash the acceptance is pinned to. */
    version_label?: string | null
    content_sha256?: string | null
    /** wave 151: the signatory record (account, typed title, legal entity, authority basis). */
    signatory?: Record<string, unknown> | null
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
  /** wave 151: may the SIGNED-IN user sign for the brokerage? When not, the sentence that says why. */
  canSign: boolean
  signRefusal: string | null
  /** wave 151: the earlier acceptances of this brokerage (superseded versions) — retrievable, newest first. */
  priorAcceptances: Array<{ id: string; signed_name: string; signed_at: string; template_version: number | null; version_label: string | null }>
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
    .select("user_type, brokerage_id")
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
    .select("id, name, body_text, body_storage_path, version, version_label, content_sha256")
    .eq("contract_type", "subscription_agreement")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (tplErr) return { ok: false, error: `Could not load the subscription agreement: ${tplErr.message}` }

  // Every acceptance this brokerage ever made (RLS: its own rows) — the current one and the retrievable history.
  const { data: history, error: sigErr } = await supabase
    .from("tenant_contract_signatures")
    .select("id, template_id, signed_name, signed_at, template_version, signature, version_label, content_sha256, signatory")
    .eq("brokerage_id", caller.brokerage_id)
    .order("signed_at", { ascending: false })
  if (sigErr) return { ok: false, error: `Could not read your signature record: ${sigErr.message}` }
  const acceptances = (history ?? []) as Array<{ id: string; template_id: string; signed_name: string; signed_at: string; template_version: number | null; signature: Record<string, unknown> | null; version_label: string | null; content_sha256: string | null; signatory: Record<string, unknown> | null }>

  // Who may sign — asked once here so the card can say so before the person types a name.
  const authority = await assessSignatoryAuthority(supabase, user.id, caller)
  const canSign = authority.ok && authority.authority.authorized
  const signRefusal = authority.ok ? authority.authority.refusal : authority.error

  if (!template) {
    // Nothing authored yet — honestly nothing to sign (never invent a contract).
    return { ok: true, view: { template: null, signature: null, awaitingSignature: false, documentUrl: null, canSign, signRefusal, priorAcceptances: acceptances.map((a) => ({ id: a.id, signed_name: a.signed_name, signed_at: a.signed_at, template_version: a.template_version, version_label: a.version_label })) } }
  }

  const tplId = (template as { id: string }).id
  const signature = acceptances.find((a) => a.template_id === tplId) ?? null
  const tpl = template as { body_text: string | null; body_storage_path: string | null }
  // Only mint when body_text is absent — a template with inline text needs no
  // link, and minting one nobody will render would be wasted work on every read.
  const documentUrl = tpl.body_text?.trim() ? null : await mintContractDocumentUrl(tpl.body_storage_path)

  return {
    ok: true,
    view: {
      template: template as SubscriptionAgreementView["template"],
      signature: signature ? { id: signature.id, signed_name: signature.signed_name, signed_at: signature.signed_at, template_version: signature.template_version, signature: signature.signature, version_label: signature.version_label, content_sha256: signature.content_sha256, signatory: signature.signatory } : null,
      // RE-ACCEPTANCE: a new active version this brokerage has not accepted leaves it awaiting, whatever it accepted before.
      awaitingSignature: !signature,
      documentUrl,
      canSign,
      signRefusal,
      priorAcceptances: acceptances.filter((a) => a.template_id !== tplId).map((a) => ({ id: a.id, signed_name: a.signed_name, signed_at: a.signed_at, template_version: a.template_version, version_label: a.version_label })),
    },
  }
}

// ─── The tenant's authorized signatory signs ─────────────────────────────────

export async function signSubscriptionAgreementAction(input: {
  templateId: string
  /** The name the signer types — the in-app equivalent of the signature line. */
  signedName: string
  /** The signer's title for the subscriber (e.g. "Broker of Record", "Managing Member") — recorded on the signatory. */
  signedTitle?: string | null
}): Promise<{ ok: true; signatureId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false, error: "Unauthorized" }

  const signedName = (input.signedName ?? "").trim()
  if (!signedName) return { ok: false, error: "Type your full name to sign" }

  const { data: caller, error: callerErr } = await supabase
    .from("users")
    .select("user_type, brokerage_id, email")
    .eq("id", user.id)
    .maybeSingle()
  if (callerErr) return { ok: false, error: `Could not resolve your account: ${callerErr.message}` }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on this account" }

  // Signing binds the BROKERAGE — only its admin seats may do that. Guards a
  // WRITE → resolveTenantAdmin (both halves: user_type AND a tenant role grant),
  // the same predicate m481's RLS applies as is_brokerage_admin(). This is the
  // FLOOR; the corporate signatory rule sits on top of it (wave 151, below).
  const adminResult = await resolveTenantAdmin(supabase, user.id, caller)
  if (!adminResult.ok) return { ok: false, error: adminResult.error }
  if (!adminResult.isTenantAdmin) {
    return { ok: false, error: "Only your brokerage's admins can sign the subscription agreement" }
  }

  // THE CORPORATE SIGNATORY (wave 151, lane 151A): the seat that may keep the
  // brokerage's books, and in a multi-location brokerage its leadership grant.
  // Every refused read refuses (fail closed) — a gate that cannot run does not pass.
  const authority = await assessSignatoryAuthority(supabase, user.id, caller)
  if (!authority.ok) return { ok: false, error: authority.error }
  if (!authority.authority.authorized) return { ok: false, error: authority.authority.refusal ?? "You are not this brokerage's authorized signatory" }

  // The template must be the ACTIVE, APPROVED agreement — a retired version or a
  // draft is not on offer. The two body arms are read as well: a signature is an
  // attestation that the signer READ the contract, so what is on screen is part
  // of the gate.
  const { data: template, error: tplErr } = await supabase
    .from("platform_contract_templates")
    .select("id, version, version_label, content_sha256, approval_status, is_active, body_text, body_storage_path")
    .eq("id", input.templateId)
    .eq("contract_type", "subscription_agreement")
    .maybeSingle()
  if (tplErr) return { ok: false, error: `Could not load the agreement: ${tplErr.message}` }
  const active = (template ?? null) as AcceptanceTemplate | null
  if (!active || !active.is_active) {
    return { ok: false, error: "This agreement is no longer the active version — reload and sign the current one" }
  }
  const notAcceptable = acceptanceRefusal(active)
  if (notAcceptable) return { ok: false, error: notAcceptable }

  // ── A DOCUMENT NOBODY CAN READ IS NOT SIGNABLE HERE (built 2026-09-07) ──────
  // The in-app record rail's whole honesty claim is that the signer read what is
  // on screen (see this file's header), so this refuses UNLESS at least one arm
  // actually renders: inline body_text, or a signed url this call can mint for
  // body_storage_path (mintContractDocumentUrl — the same renderer
  // getSubscriptionAgreementAction uses, so "can this be shown" is answered
  // identically on both the read and the write path). Fail closed (§4): a mint
  // failure here reads as "no document", not as a thrown error.
  const hasInlineText = !!active.body_text?.trim()
  const documentUrl = hasInlineText ? null : await mintContractDocumentUrl(active.body_storage_path)
  if (!hasInlineText && !documentUrl) {
    return {
      ok: false,
      error: active.body_storage_path
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

  // THE LEGAL ENTITY BOUND — the brokerage row as it stands (RLS: the caller's own tenant).
  const { data: entity, error: entityErr } = await supabase
    .from("brokerages")
    .select("name, dba, license_number, license_state")
    .eq("id", caller.brokerage_id)
    .maybeSingle()
  if (entityErr) return { ok: false, error: `Could not read your brokerage's legal identity: ${entityErr.message}` }
  const legal = entity as { name: string | null; dba: string | null; license_number: string | null; license_state: string | null } | null

  const hdrs = await headers()
  const built = buildAcceptanceRow({
    template: active, signedName, signedTitle: input.signedTitle ?? null,
    signer: { id: user.id, email: (caller as { email?: string | null }).email ?? user.email ?? null, userType: caller.user_type ?? null },
    authority: authority.authority,
    legalEntity: legal ? { name: legal.name, dba: legal.dba, licenseNumber: legal.license_number, licenseState: legal.license_state } : null,
    ip: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), userAgent: hdrs.get("user-agent"),
    // The in-app record rail IS the execution method — no provider, nothing simulated (stated by this door, recorded on the row).
    method: "in_app_click_to_sign",
  })
  if (!built.ok) return { ok: false, error: built.error }

  // AUTHED insert — RLS (is_brokerage_finance_admin + tenant pin, m959) is the database gate.
  // brokerage_id is the CALLER's, signed_by is the session user: server-resolved.
  const { data: inserted, error: insErr } = await supabase
    .from("tenant_contract_signatures")
    .insert({
      brokerage_id: caller.brokerage_id,
      template_id: input.templateId,
      signed_by: user.id,
      ...built.row,
    })
    .select("id")
    .single()
  if (insErr) return { ok: false, error: `Signature was not recorded: ${insErr.message}` }
  if (!inserted) return { ok: false, error: "Signature was not recorded — you may not have permission to sign for this brokerage" }

  return { ok: true, signatureId: (inserted as { id: string }).id }
}

// ─── The accepted copy, retrievable (wave 151) ──────────────────────────────

/** Hand the brokerage's own accepted copy back, its hash re-verified. Any tenant admin may read it (reading is not signing). */
export async function downloadAcceptedAgreementAction(input: { signatureId: string }): Promise<{ ok: true; copy: AcceptedCopy } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false, error: "Unauthorized" }
  const signatureId = (input.signatureId ?? "").trim()
  if (!signatureId) return { ok: false, error: "No acceptance record named" }

  const { data: caller, error: callerErr } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (callerErr) return { ok: false, error: `Could not resolve your account: ${callerErr.message}` }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on this account" }

  const adminResult = await resolveTenantAdmin(supabase, user.id, caller)
  if (!adminResult.ok) return { ok: false, error: adminResult.error }
  if (!adminResult.isTenantAdmin) return { ok: false, error: "Only your brokerage's admins can download its agreement" }

  return readAcceptedCopy(supabase, { signatureId, brokerage_id: caller.brokerage_id })
}
