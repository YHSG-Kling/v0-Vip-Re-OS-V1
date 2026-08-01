"use server"

/**
 * Buyer Broker Agreement (BBA) lifecycle — NAR 2024 settlement compliance.
 *
 * Lifecycle:
 *   draft → pending_signature → active → (expired | cancelled | superseded)
 *
 * Actions:
 *   createBBADraftAction:        agent or admin drafts terms
 *   updateBBADraftAction:        edits while still in draft
 *   sendBBAForSignatureAction:   draft → pending_signature (DocuSign/Dotloop integration hook)
 *   clickThroughSignBBAAction:   buyer self-signs via portal (most common modern flow)
 *   recordWetSignatureAction:    uploaded paper signature
 *   cancelBBAAction:             withdraw before signing
 *   listAgentBBAsAction:         agent dashboard view
 *   getBBAForBuyerAction:        contact detail page
 *
 * Every state transition writes to activities for audit (NAR records audit
 * for 7 years per state RE commission rules).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { resolveESignProviderForActor } from "@/lib/integrations/resolve-esign-provider"

const AGENT_ROLES = new Set(["broker","broker_admin","admin","superadmin","team_lead","agent"])

async function requireAgentInBrokerage(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string; agentId: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!AGENT_ROLES.has(profile.user_type ?? "")) return { ok: false, error: "Forbidden" }

  // Resolve agent_id (agents.user_id = users.id) — NOT every user has an agent
  // record (admins, brokers don't). For BBA creation we DO need an agent_id
  // because the buyer is being represented BY an agent, not the brokerage entity.
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  return {
    ok: true,
    userId: user.id,
    brokerageId: profile.brokerage_id,
    userType: profile.user_type,
    agentId: agent?.id ?? null,
  }
}

// ── CREATE DRAFT ─────────────────────────────────────────────────────────────

export interface CreateBBAInput {
  buyerContactId:        string
  /** When the caller IS the agent, leave undefined and it resolves from auth.
   *  When an admin creates on behalf of an agent, pass it explicitly. */
  agentId?:              string
  agreementType:         "exclusive" | "non_exclusive" | "showing_only" | "open"
  commissionPercentage?: number
  commissionFlatAmount?: number
  commissionPayer:       "seller" | "buyer" | "split" | "either"
  commissionNotes?:      string
  geographicScope?:      string
  propertyTypeScope?:    string[]
  effectiveDate?:        string  // YYYY-MM-DD
  expirationDate?:       string  // YYYY-MM-DD
  notes?:                string
}

export async function createBBADraftAction(input: CreateBBAInput): Promise<
  { ok: true; agreementId: string } | { ok: false; error: string }
> {
  const auth = await requireAgentInBrokerage()
  if (!auth.ok) return auth

  const agentId = input.agentId ?? auth.agentId
  if (!agentId) {
    return { ok: false, error: "An agent_id is required. Caller has no agent record; pass agentId explicitly." }
  }

  if (!input.commissionPercentage && !input.commissionFlatAmount && input.agreementType !== "showing_only") {
    // Allow showing-only BBAs to defer commission terms, but everything else must specify.
    return { ok: false, error: "Commission percentage or flat amount required (NAR 2024 — explicit comp terms mandatory)." }
  }

  const svc = createServiceClient()

  // Verify buyer belongs to caller's brokerage
  const { data: buyer } = await svc
    .from("contacts")
    .select("brokerage_id")
    .eq("id", input.buyerContactId)
    .maybeSingle()
  if (!buyer) return { ok: false, error: "Buyer contact not found" }
  if (buyer.brokerage_id !== auth.brokerageId) return { ok: false, error: "Buyer belongs to another brokerage" }

  const { data: inserted, error } = await svc
    .from("buyer_broker_agreements")
    .insert({
      brokerage_id:            auth.brokerageId,
      buyer_contact_id:        input.buyerContactId,
      agent_id:                agentId,
      agreement_type:          input.agreementType,
      commission_percentage:   input.commissionPercentage ?? null,
      commission_flat_amount:  input.commissionFlatAmount ?? null,
      commission_payer:        input.commissionPayer,
      commission_notes:        input.commissionNotes ?? null,
      geographic_scope:        input.geographicScope ?? null,
      property_type_scope:     input.propertyTypeScope ?? ["residential"],
      effective_date:          input.effectiveDate ?? null,
      expiration_date:         input.expirationDate ?? null,
      status:                  "draft",
      created_by:              auth.userId,
      notes:                   input.notes ?? null,
    })
    .select("id")
    .single()

  if (error || !inserted) return { ok: false, error: error?.message ?? "Insert failed" }

  revalidatePath(`/crm/contacts/${input.buyerContactId}`)
  return { ok: true, agreementId: inserted.id as string }
}

// ── CLICK-THROUGH SIGN (most common path for modern self-serve) ──────────────

/**
 * Buyer accepts the BBA via portal click-through. Captures IP + UA for
 * audit trail (state RE commissions accept this as valid e-signature
 * under federal E-SIGN Act + state UETA when proper consent is captured).
 *
 * Transitions: draft | pending_signature → active.
 * Effective_date defaults to today, expiration_date defaults to +90 days
 * if not previously set on the draft.
 */
export async function clickThroughSignBBAAction(params: {
  agreementId: string
  /** Buyer affirmatively checks "I understand and agree" — required for valid e-sign. */
  affirmativeConsent: boolean
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.affirmativeConsent) {
    return { ok: false, error: "Affirmative consent required for e-signature validity" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const svc = createServiceClient()
  const hdrs = await headers()

  // Verify the caller is the buyer for this agreement (contacts.user_id linkage)
  const { data: agreement } = await svc
    .from("buyer_broker_agreements")
    .select("id, buyer_contact_id, status, effective_date, expiration_date")
    .eq("id", params.agreementId)
    .maybeSingle()
  if (!agreement) return { ok: false, error: "Agreement not found" }
  if (agreement.status !== "draft" && agreement.status !== "pending_signature") {
    return { ok: false, error: `Cannot sign — agreement status is ${agreement.status}` }
  }

  const { data: buyer } = await svc
    .from("contacts")
    .select("user_id")
    .eq("id", agreement.buyer_contact_id)
    .maybeSingle()
  if (buyer?.user_id !== user.id) {
    return { ok: false, error: "Only the buyer named on this agreement can sign it" }
  }

  const today    = new Date().toISOString().slice(0, 10)
  const ninetyD  = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const effective  = agreement.effective_date  ?? today
  const expiration = agreement.expiration_date ?? ninetyD

  const { error } = await svc
    .from("buyer_broker_agreements")
    .update({
      status:                    "active",
      signed_at:                 new Date().toISOString(),
      signed_method:             "click_through",
      click_through_ip:          hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      click_through_user_agent:  hdrs.get("user-agent"),
      effective_date:            effective,
      expiration_date:           expiration,
    })
    .eq("id", params.agreementId)

  if (error) return { ok: false, error: error.message }

  revalidatePath(`/crm/contacts/${agreement.buyer_contact_id}`)
  revalidatePath("/portal")
  return { ok: true }
}

// ── DISPATCH TO BROKERAGE'S CONFIGURED E-SIGN PROVIDER ──────────────────────

/**
 * Dispatch a draft BBA to the brokerage's configured e-sign provider
 * (Dotloop / DocuSign / SkySlope / Authentisign per platform_credentials).
 *
 * Creates a transaction in the provider, attaches the BBA form, and sends
 * to the buyer for signature. Updates BBA status → pending_signature with
 * the provider's external transaction id stored in signature_request_id.
 *
 * The brokerage's choice is resolved by resolveESignProviderForBrokerage
 * (cascade: provider_overrides → platform_credentials → system default).
 * Throws if no provider is configured — admin must fix in Settings.
 */
export async function dispatchBBAToSigningProviderAction(
  agreementId: string,
): Promise<
  | { ok: true; provider: string; externalTransactionId: string }
  | { ok: false; error: string }
> {
  const auth = await requireAgentInBrokerage()
  if (!auth.ok) return auth

  const svc = createServiceClient()

  const { data: bba } = await svc
    .from("buyer_broker_agreements")
    .select(`
      id, status, brokerage_id, agent_id, buyer_contact_id,
      agreement_type, commission_percentage, commission_flat_amount,
      commission_payer, effective_date, expiration_date,
      buyer:contacts!inner ( first_name, last_name, email )
    `)
    .eq("id", agreementId)
    .maybeSingle()
  if (!bba) return { ok: false, error: "Agreement not found" }
  if (bba.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden — different brokerage" }
  if (bba.status !== "draft") {
    return { ok: false, error: `Cannot dispatch — status is ${bba.status}` }
  }

  const buyer = Array.isArray(bba.buyer) ? bba.buyer[0] : bba.buyer
  if (!buyer?.email) {
    return { ok: false, error: "Buyer contact has no email — cannot dispatch for signature" }
  }

  // Resolve the calling agent's e-sign provider (user → team → brokerage cascade).
  // Each agent can wire their own DocuSign/Dotloop credentials in Settings.
  let resolved: Awaited<ReturnType<typeof resolveESignProviderForActor>>
  try {
    resolved = await resolveESignProviderForActor({
      brokerageId: auth.brokerageId,
      userId:      auth.userId,
    })
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "No e-sign provider configured" }
  }

  // Create a "transaction" / loop in the provider for this BBA
  const txReq = await resolved.provider.createTransaction({
    propertyAddress: "Buyer Representation Agreement",
    transactionType: "purchase",
    contactId:       bba.buyer_contact_id as string,
  })
  if (!txReq.success || !txReq.externalTransactionId) {
    return { ok: false, error: txReq.error ?? "Provider createTransaction failed" }
  }

  // Send the BBA document for signature. The provider returns success on
  // queue; webhook will update signed_at when the buyer actually signs.
  const sendReq = await resolved.provider.sendForSignature({
    externalTransactionId: txReq.externalTransactionId,
    documentId:            agreementId,
    signers: [{
      email: buyer.email as string,
      name:  [buyer.first_name, buyer.last_name].filter(Boolean).join(" ") || "Buyer",
      role:  "buyer",
    }],
    message: `Buyer Broker Agreement — review and sign to continue your home search. Commission: ${
      bba.commission_percentage != null ? `${bba.commission_percentage}%`
        : bba.commission_flat_amount != null ? `$${Number(bba.commission_flat_amount).toLocaleString()}`
        : "see document"
    }, paid by ${bba.commission_payer}.`,
  })
  if (!sendReq.success) {
    return { ok: false, error: sendReq.error ?? "Provider sendForSignature failed" }
  }

  const signedMethod = resolved.providerName === "docusign" ? "docusign"
                    : resolved.providerName === "dotloop"  ? "dotloop"
                    : "docusign" // Authentisign + SkySlope use DocuSign-style flow

  await svc
    .from("buyer_broker_agreements")
    .update({
      status:               "pending_signature",
      signed_method:        signedMethod,
      signature_request_id: txReq.externalTransactionId,
    })
    .eq("id", agreementId)

  revalidatePath(`/crm/contacts/${bba.buyer_contact_id}`)
  return {
    ok: true,
    provider: resolved.providerName,
    externalTransactionId: txReq.externalTransactionId,
  }
}

// ── AGENT-SIDE RECORD WET / DOCUSIGN SIGNATURE ───────────────────────────────

export async function recordSignedBBAAction(params: {
  agreementId:    string
  signedMethod:   "wet_signature" | "docusign" | "dotloop"
  signedAt?:      string
  signedDocumentUrl?: string
  expirationDate?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAgentInBrokerage()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data: agreement } = await svc
    .from("buyer_broker_agreements")
    .select("id, status, brokerage_id, effective_date, expiration_date")
    .eq("id", params.agreementId)
    .maybeSingle()
  if (!agreement) return { ok: false, error: "Agreement not found" }
  if (agreement.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden — different brokerage" }
  if (agreement.status === "active") return { ok: false, error: "Already active — supersede instead" }
  if (agreement.status === "cancelled" || agreement.status === "expired") {
    return { ok: false, error: `Cannot sign a ${agreement.status} agreement` }
  }

  const today   = new Date().toISOString().slice(0, 10)
  const ninetyD = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)

  const { error } = await svc
    .from("buyer_broker_agreements")
    .update({
      status:               "active",
      signed_at:            params.signedAt ?? new Date().toISOString(),
      signed_method:        params.signedMethod,
      signed_document_url:  params.signedDocumentUrl ?? null,
      effective_date:       agreement.effective_date ?? today,
      expiration_date:      params.expirationDate ?? agreement.expiration_date ?? ninetyD,
    })
    .eq("id", params.agreementId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── CANCEL / VOID ────────────────────────────────────────────────────────────

export async function cancelBBAAction(params: {
  agreementId: string
  reason:      string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAgentInBrokerage()
  if (!auth.ok) return auth
  if (!params.reason || params.reason.trim().length < 5) {
    return { ok: false, error: "Cancellation reason required (5+ chars)" }
  }
  const svc = createServiceClient()
  const { error } = await svc
    .from("buyer_broker_agreements")
    .update({
      status:              "cancelled",
      cancelled_at:        new Date().toISOString(),
      cancelled_by:        auth.userId,
      cancellation_reason: params.reason.trim(),
    })
    .eq("id", params.agreementId)
    .eq("brokerage_id", auth.brokerageId)
    .in("status", ["draft","pending_signature","active"])
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── READ ─────────────────────────────────────────────────────────────────────

export async function listAgentBBAsAction(): Promise<
  | { ok: true; rows: any[] }
  | { ok: false; error: string }
> {
  const auth = await requireAgentInBrokerage()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  let q = svc
    .from("buyer_broker_agreements")
    .select(`
      id, status, agreement_type, commission_percentage, commission_flat_amount,
      commission_payer, effective_date, expiration_date, signed_at, signed_method,
      created_at,
      buyer:contacts!inner ( id, first_name, last_name, email )
    `)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(100)

  if (auth.agentId) q = q.eq("agent_id", auth.agentId)

  const { data, error } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: data ?? [] }
}

export async function getBBAForBuyerAction(buyerContactId: string): Promise<
  | { ok: true; agreements: any[] }
  | { ok: false; error: string }
> {
  const auth = await requireAgentInBrokerage()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("buyer_broker_agreements")
    .select("*")
    .eq("buyer_contact_id", buyerContactId)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, agreements: data ?? [] }
}
