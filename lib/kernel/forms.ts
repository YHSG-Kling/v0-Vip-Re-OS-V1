// lib/kernel/forms.ts
// ═══════════════════════════════════════════════════════════════════════════════
// FORMS, E-SIGN, AND SMART PROPERTY WORKFLOW OS
// ═══════════════════════════════════════════════════════════════════════════════
//
// KERNEL OWNERSHIP: This module owns ALL form/esign/property-action logic.
// No direct DB calls from UI. All writes go through these commands.
//
// EXPLICIT RULES:
//  1. Form context is STRICT — listing forms use ONLY listing/seller context.
//     Offer forms use ONLY buyer/offer context. Never cross-pollinate.
//  2. Draft state persists to `form_submissions` with status='draft'.
//     On final submit, status → 'submitted'. On esign launch → 'sent_for_signature'.
//  3. E-sign is TRANSPORT ONLY — the provider module handles API calls.
//     The kernel logs events, updates status, does NOT talk to provider APIs directly.
//  4. Buyer property actions write to `property_interests` (canonical table).
//     interest_level: 'saved' | 'favorited' | 'dismissed' | 'not_interested' | 'offer_requested'
//  5. All mutations emit KernelEvent via lifecycle_events.
//  6. Every command returns KernelFormsResult — never throws to caller.
//
// EXPLICIT ACCEPTANCE CRITERIA:
//  - resolveTransactionFormsProvider → returns provider name or null; never throws
//  - loadAvailableTransactionForms   → returns template list for context type
//  - prefillFormWithContext          → fields ONLY from correct context (listing vs. offer vs. transaction)
//  - saveFormDraft                   → upserts form_submissions with status='draft'
//  - loadFormDraft                   → returns null if no draft; never 404-errors
//  - launchEsignEnvelope             → delegates to provider.sendForSignature, logs event
//  - getEsignStatus                  → returns percentComplete 0–100, signed/total counts
//  - syncEsignDocuments              → delegates to provider.syncDocuments, returns doc list
//  - recordBuyerPropertyAction       → upserts property_interests row for contact
//  - loadBuyerSavedProperties        → returns paginated saved/favorited interests

import { createServiceClient } from "@/lib/supabase/service"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import { KernelEvent } from "./events"

// ─── RESULT TYPE ────────────────────────────────────────────────────────────

export interface KernelFormsResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

// ─── CONTEXT TYPES ──────────────────────────────────────────────────────────

export type FormContextType = "listing" | "offer" | "transaction"

export type BuyerPropertyInterestLevel =
  | "saved"
  | "favorited"
  | "dismissed"
  | "not_interested"
  | "offer_requested"
  | "tour_requested"

export interface FormTemplate {
  id: string
  name: string
  category: string
  form_type: string
  is_required: boolean
  description?: string
  state?: string
}

export interface FormPrefillData {
  form_name: string
  context_type: FormContextType
  fields: Record<string, string | number | boolean | null>
  context_id: string
  prefilled_at: string
}

export interface FormDraft {
  id: string
  form_name: string
  context_type: FormContextType
  context_id: string
  field_values: Record<string, any>
  status: "draft" | "submitted" | "sent_for_signature"
  created_at: string
  updated_at: string
}

export interface EsignStatus {
  total: number
  signed: number
  pending: number
  percentComplete: number
  provider?: string
}

export interface ProviderDocument {
  externalDocumentId: string
  documentName: string
  folderName: string
  isSigned: boolean
  url?: string
  uploadedAt?: string
}

export interface BuyerPropertyInterest {
  id: string
  contact_id: string
  listing_id: string
  interest_level: BuyerPropertyInterestLevel
  notes?: string
  saved_at: string
  listing?: {
    id: string
    address?: string
    property_address?: string
    list_price?: number
    bedrooms?: number
    bathrooms?: number
    primary_photo_url?: string
  }
}

// ─── COMMAND 1: resolveTransactionFormsProvider ──────────────────────────────
//
// Resolves the brokerage's connected forms/transaction provider name.
// Source of truth: platform_credentials table (is_active=true).
// Falls back to "dotloop" if no explicit credential found.
// Rule: provider is a brokerage/team property — NEVER a contact property.

export async function resolveTransactionFormsProvider(input: {
  brokerage_id: string
}): Promise<KernelFormsResult<{ provider_name: string; is_configured: boolean }>> {
  try {
    const supabase = createServiceClient()

    const { data: credential } = await supabase
      .from("platform_credentials")
      .select("platform, account_id, is_active")
      .eq("brokerage_id", input.brokerage_id)
      .in("platform", ["dotloop", "skyslope", "formsimplicity", "brokermint", "authentisign", "docusign"])
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    const provider_name = credential?.platform ?? "dotloop"
    const is_configured = !!credential?.account_id

    return {
      success: true,
      data: { provider_name, is_configured },
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 2: loadAvailableTransactionForms ────────────────────────────────
//
// Returns form templates available for a given context type.
// Listing context → listing agreement, disclosure, seller forms.
// Offer context   → purchase contract, addenda, buyer forms.
// Transaction     → inspection, title, lender, closing forms.
// Source: state_required_forms + brokerage_forms tables (falls back to mock list).

export async function loadAvailableTransactionForms(input: {
  brokerage_id: string
  context_type: FormContextType
  state?: string
}): Promise<KernelFormsResult<{ forms: FormTemplate[] }>> {
  try {
    const supabase = createServiceClient()

    // Source: brokerage_forms table — the canonical home for reusable form templates.
    // client_documents is reserved for contact-owned signed documents ONLY.
    // form_category maps to context_type:
    //   listing     → 'listing', 'disclosure', 'listing_agreement'
    //   offer       → 'offer', 'purchase_contract', 'addendum'
    //   transaction → 'transaction', 'closing', 'title', 'inspection'
    const contextCategories: Record<FormContextType, string[]> = {
      listing:     ["listing", "listing_agreement", "disclosure", "seller_disclosure"],
      offer:       ["offer", "purchase_contract", "addendum", "buyer_form"],
      transaction: ["transaction", "inspection", "title", "closing", "amendment"],
    }

    let query = supabase
      .from("brokerage_forms")
      .select("id, form_name, form_category, form_type, is_required, document_url, state")
      .eq("brokerage_id", input.brokerage_id)
      .eq("is_active", true)
      .in("form_category", contextCategories[input.context_type])
      .order("is_required", { ascending: false })
      .order("form_name")
      .limit(50)

    // Filter by state if provided — also include forms with no state (apply everywhere)
    if (input.state) {
      query = query.or(`state.eq.${input.state.toUpperCase()},state.is.null`)
    }

    const { data: brokerageForms } = await query

    if (brokerageForms && brokerageForms.length > 0) {
      return {
        success: true,
        data: {
          forms: brokerageForms.map((f: any) => ({
            id:          f.id,
            name:        f.form_name,
            category:    f.form_category,
            form_type:   f.form_type ?? f.form_category,
            is_required: f.is_required ?? false,
            description: f.document_url ? "Brokerage library form" : undefined,
            state:       f.state ?? undefined,
          })),
        },
      }
    }

    // Fallback: return context-appropriate defaults so the UI is never empty
    const defaults = getDefaultFormTemplates(input.context_type)
    return { success: true, data: { forms: defaults } }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

function getDefaultFormTemplates(context_type: FormContextType): FormTemplate[] {
  const base: Record<FormContextType, FormTemplate[]> = {
    listing: [
      { id: "listing-agreement", name: "Listing Agreement", category: "listing_agreement", form_type: "listing", is_required: true },
      { id: "seller-disclosure", name: "Seller Disclosure", category: "disclosure", form_type: "listing", is_required: true },
      { id: "lead-paint", name: "Lead Paint Disclosure", category: "disclosure", form_type: "listing", is_required: false },
    ],
    offer: [
      { id: "purchase-contract", name: "Purchase Contract", category: "purchase_contract", form_type: "offer", is_required: true },
      { id: "buyer-rep", name: "Buyer Representation Agreement", category: "buyer", form_type: "offer", is_required: false },
      { id: "addendum-a", name: "General Addendum", category: "addendum", form_type: "offer", is_required: false },
    ],
    transaction: [
      { id: "inspection-addendum", name: "Inspection Contingency Addendum", category: "inspection", form_type: "transaction", is_required: false },
      { id: "title-commitment", name: "Title Commitment", category: "title", form_type: "transaction", is_required: false },
      { id: "closing-disclosure", name: "Closing Disclosure (CD)", category: "closing", form_type: "transaction", is_required: true },
    ],
  }
  return base[context_type]
}

// ─── COMMAND 3: prefillFormWithContext ───────────────────────────────────────
//
// STRICT CONTEXT RULE:
//  - context_type="listing"     → pulls ONLY from listings + seller contact
//  - context_type="offer"       → pulls ONLY from offers + buyer contact
//  - context_type="transaction" → pulls from transactions + both parties
// NO cross-contamination. A listing form NEVER reads buyer data.

export async function prefillFormWithContext(input: {
  form_name: string
  context_type: FormContextType
  context_id: string
  brokerage_id: string
}): Promise<KernelFormsResult<{ prefill: FormPrefillData }>> {
  try {
    const supabase = createServiceClient()
    let fields: Record<string, string | number | boolean | null> = {}

    if (input.context_type === "listing") {
      // Listing context: ONLY listing + seller data
      const { data: listing } = await supabase
        .from("listings")
        .select(`
          id, address, property_address, city, state, zip_code,
          list_price, bedrooms, bathrooms, square_feet, lot_size, year_built,
          property_type, mls_number, agent_id,
          seller_contact_id,
          contacts!seller_contact_id (
            first_name, last_name, email, phone
          )
        `)
        .eq("id", input.context_id)
        .eq("brokerage_id", input.brokerage_id)
        .maybeSingle()

      if (listing) {
        const seller = (listing as any).contacts
        fields = {
          property_address:  listing.address ?? listing.property_address ?? null,
          city:              listing.city ?? null,
          state:             listing.state ?? null,
          zip_code:          listing.zip_code ?? null,
          list_price:        listing.list_price ?? null,
          bedrooms:          listing.bedrooms ?? null,
          bathrooms:         listing.bathrooms ?? null,
          square_feet:       listing.square_feet ?? null,
          lot_size:          listing.lot_size ?? null,
          year_built:        listing.year_built ?? null,
          property_type:     listing.property_type ?? null,
          mls_number:        listing.mls_number ?? null,
          seller_first_name: seller?.first_name ?? null,
          seller_last_name:  seller?.last_name ?? null,
          seller_email:      seller?.email ?? null,
          seller_phone:      seller?.phone ?? null,
        }
      }
    } else if (input.context_type === "offer") {
      // Offer context: ONLY offer + buyer contact data
      const { data: offer } = await supabase
        .from("offers")
        .select(`
          id, offer_price, offer_date, closing_date, earnest_money,
          financing_type, contingencies, contact_id,
          contacts!contact_id (
            first_name, last_name, email, phone
          ),
          listings (
            address, property_address, city, state, zip_code, list_price
          )
        `)
        .eq("id", input.context_id)
        .eq("brokerage_id", input.brokerage_id)
        .maybeSingle()

      if (offer) {
        const buyer   = (offer as any).contacts
        const listing = (offer as any).listings
        fields = {
          offer_price:       offer.offer_price ?? null,
          offer_date:        offer.offer_date ?? null,
          closing_date:      offer.closing_date ?? null,
          earnest_money:     offer.earnest_money ?? null,
          financing_type:    offer.financing_type ?? null,
          contingencies:     offer.contingencies ? JSON.stringify(offer.contingencies) : null,
          buyer_first_name:  buyer?.first_name ?? null,
          buyer_last_name:   buyer?.last_name ?? null,
          buyer_email:       buyer?.email ?? null,
          buyer_phone:       buyer?.phone ?? null,
          property_address:  listing?.address ?? listing?.property_address ?? null,
          city:              listing?.city ?? null,
          state:             listing?.state ?? null,
          zip_code:          listing?.zip_code ?? null,
          list_price:        listing?.list_price ?? null,
        }
      }
    } else if (input.context_type === "transaction") {
      // Transaction context: both parties + transaction data
      const { data: tx } = await supabase
        .from("transactions")
        .select(`
          id, purchase_price, closing_date, status, transaction_type,
          contact_id,
          listing_id,
          contacts!contact_id (
            first_name, last_name, email, phone
          ),
          listings!listing_id (
            address, property_address, city, state, zip_code, mls_number,
            seller_contact_id,
            contacts!seller_contact_id (
              first_name, last_name, email, phone
            )
          )
        `)
        .eq("id", input.context_id)
        .eq("brokerage_id", input.brokerage_id)
        .maybeSingle()

      if (tx) {
        const buyer        = (tx as any).contacts
        const listingData  = (tx as any).listings
        const seller       = listingData?.contacts
        fields = {
          purchase_price:    tx.purchase_price ?? null,
          closing_date:      tx.closing_date ?? null,
          transaction_type:  tx.transaction_type ?? null,
          property_address:  listingData?.address ?? listingData?.property_address ?? null,
          city:              listingData?.city ?? null,
          state:             listingData?.state ?? null,
          zip_code:          listingData?.zip_code ?? null,
          mls_number:        listingData?.mls_number ?? null,
          buyer_first_name:  buyer?.first_name ?? null,
          buyer_last_name:   buyer?.last_name ?? null,
          buyer_email:       buyer?.email ?? null,
          buyer_phone:       buyer?.phone ?? null,
          seller_first_name: seller?.first_name ?? null,
          seller_last_name:  seller?.last_name ?? null,
          seller_email:      seller?.email ?? null,
          seller_phone:      seller?.phone ?? null,
        }
      }
    }

    const prefill: FormPrefillData = {
      form_name:    input.form_name,
      context_type: input.context_type,
      context_id:   input.context_id,
      fields,
      prefilled_at: new Date().toISOString(),
    }

    return { success: true, data: { prefill } }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 4: saveFormDraft ────────────────────────────────────────────────
//
// Persists a form draft to form_submissions with status='draft'.
// Upserts by (context_type, context_id, form_name, brokerage_id, agent_id).
// A draft is not a submission — it emits no external events.

export async function saveFormDraft(input: {
  brokerage_id: string
  agent_id: string
  form_name: string
  context_type: FormContextType
  context_id: string
  field_values: Record<string, any>
}): Promise<KernelFormsResult<{ draft_id: string }>> {
  try {
    const supabase = createServiceClient()

    const { data: existing } = await supabase
      .from("form_submissions")
      .select("id")
      .eq("brokerage_id", input.brokerage_id)
      .eq("agent_id", input.agent_id)
      .eq("form_name", input.form_name)
      .eq("context_id", input.context_id)
      .eq("status", "draft")
      .maybeSingle()

    let draft_id: string

    if (existing?.id) {
      // Update existing draft
      const { error } = await supabase
        .from("form_submissions")
        .update({
          field_values: input.field_values,
          updated_at:   new Date().toISOString(),
        })
        .eq("id", existing.id)

      if (error) throw error
      draft_id = existing.id
    } else {
      // Create new draft
      const { data: newDraft, error } = await supabase
        .from("form_submissions")
        .insert({
          brokerage_id:  input.brokerage_id,
          agent_id:      input.agent_id,
          form_name:     input.form_name,
          context_type:  input.context_type,
          context_id:    input.context_id,
          field_values:  input.field_values,
          status:        "draft",
          created_at:    new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        })
        .select("id")
        .single()

      if (error || !newDraft) throw error ?? new Error("Failed to create draft")
      draft_id = newDraft.id
    }

    return { success: true, data: { draft_id } }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 5: loadFormDraft ────────────────────────────────────────────────
//
// Loads the most recent draft for a given context.
// Returns null data (not an error) if no draft exists.

export async function loadFormDraft(input: {
  brokerage_id: string
  agent_id: string
  form_name: string
  context_id: string
}): Promise<KernelFormsResult<{ draft: FormDraft | null }>> {
  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("form_submissions")
      .select("id, form_name, context_type, context_id, field_values, status, created_at, updated_at")
      .eq("brokerage_id", input.brokerage_id)
      .eq("agent_id", input.agent_id)
      .eq("form_name", input.form_name)
      .eq("context_id", input.context_id)
      .eq("status", "draft")
      .order("updated_at", { ascending: false })
      .maybeSingle()

    if (error) throw error

    const draft: FormDraft | null = data
      ? {
          id:           data.id,
          form_name:    data.form_name,
          context_type: data.context_type as FormContextType,
          context_id:   data.context_id,
          field_values: data.field_values ?? {},
          status:       data.status as FormDraft["status"],
          created_at:   data.created_at,
          updated_at:   data.updated_at,
        }
      : null

    return { success: true, data: { draft } }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 6: launchEsignEnvelope ─────────────────────────────────────────
//
// Routes a form submission to the brokerage's e-sign provider.
// Steps:
//   1. Verify form_submissions record exists and belongs to brokerage
//   2. Resolve provider from platform_credentials
//   3. Delegate to provider.sendForSignature()
//   4. Update form_submissions.status → 'sent_for_signature'
//   5. Emit ESIGN_ENVELOPE_REQUESTED event
//
// Rule: E-sign is TRANSPORT ONLY. Kernel does NOT process signatures.

export async function launchEsignEnvelope(input: {
  brokerage_id: string
  agent_id: string
  form_submission_id: string
  external_transaction_id: string
  signers: Array<{ name: string; email: string; role: string }>
  message?: string
}): Promise<KernelFormsResult<{ envelope_launched: boolean }>> {
  try {
    const supabase = createServiceClient()

    // Verify ownership
    const { data: submission, error: subErr } = await supabase
      .from("form_submissions")
      .select("id, form_name, context_id, status")
      .eq("id", input.form_submission_id)
      .eq("brokerage_id", input.brokerage_id)
      .maybeSingle()

    if (subErr || !submission) {
      return { success: false, error: "Form submission not found or access denied" }
    }

    if (submission.status === "sent_for_signature") {
      return { success: false, error: "Already sent for signature" }
    }

    // Resolve provider
    const providerResult = await resolveTransactionFormsProvider({ brokerage_id: input.brokerage_id })
    const providerName   = providerResult.data?.provider_name ?? "dotloop"
    const provider       = getTransactionProviderByName(providerName)

    // Delegate to provider (transport only)
    const sendResult = await provider.sendForSignature({
      externalTransactionId: input.external_transaction_id,
      documentId:            input.form_submission_id,
      signers:               input.signers,
      message:               input.message,
    })

    if (!sendResult.success) {
      return { success: false, error: sendResult.error ?? "Provider rejected signature request" }
    }

    // Update submission status
    await supabase
      .from("form_submissions")
      .update({
        status:     "sent_for_signature",
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.form_submission_id)

    // Emit event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type:  "form_submission",
        entity_id:    input.form_submission_id,
        event_type:   KernelEvent.ESIGN_ENVELOPE_REQUESTED,
        brokerage_id: input.brokerage_id,
        metadata: {
          agent_id:                 input.agent_id,
          external_transaction_id:  input.external_transaction_id,
          provider:                 providerName,
          signer_count:             input.signers.length,
        },
        created_at: new Date().toISOString(),
      })

    return { success: true, data: { envelope_launched: true } }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 7: getEsignStatus ───────────────────────────────────────────────
//
// Fetches live signature status from the provider.
// Returns percentComplete 0–100 for progress display.
// Falls back to last-known DB status if provider call fails.

export async function getEsignStatus(input: {
  brokerage_id: string
  external_transaction_id: string
}): Promise<KernelFormsResult<EsignStatus>> {
  try {
    const providerResult = await resolveTransactionFormsProvider({ brokerage_id: input.brokerage_id })
    const providerName   = providerResult.data?.provider_name ?? "dotloop"
    const provider       = getTransactionProviderByName(providerName)

    const status = await provider.getSignatureStatus(input.external_transaction_id)

    if (!status.success) {
      return { success: false, error: status.error ?? "Failed to fetch signature status" }
    }

    return {
      success: true,
      data: {
        total:           status.total,
        signed:          status.signed,
        pending:         status.pending,
        percentComplete: status.percentComplete,
        provider:        providerName,
      },
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 8: syncEsignDocuments ──────────────────────────────────────────
//
// Pulls documents from the provider and returns them for display.
// Does NOT write to DB directly — caller persists if needed.
// Provider call is TRANSPORT ONLY.

export async function syncEsignDocuments(input: {
  brokerage_id: string
  external_transaction_id: string
  contact_id: string
  transaction_id?: string
  listing_id?: string
}): Promise<KernelFormsResult<{ documents: ProviderDocument[]; synced_count: number }>> {
  try {
    const providerResult = await resolveTransactionFormsProvider({ brokerage_id: input.brokerage_id })
    const providerName   = providerResult.data?.provider_name ?? "dotloop"
    const provider       = getTransactionProviderByName(providerName)

    const result = await provider.syncDocuments({
      externalTransactionId: input.external_transaction_id,
      contactId:             input.contact_id,
      transactionId:         input.transaction_id,
      listingId:             input.listing_id,
    })

    if (!result.success) {
      return { success: false, error: result.error ?? "Document sync failed" }
    }

    const documents: ProviderDocument[] = (result.documents ?? []).map((d) => ({
      externalDocumentId: d.externalDocumentId,
      documentName:       d.documentName,
      folderName:         d.folderName,
      isSigned:           d.isSigned,
      url:                d.url,
      uploadedAt:         d.uploadedAt,
    }))

    return {
      success: true,
      data: { documents, synced_count: documents.length },
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 9: recordBuyerPropertyAction ───────────────────────────────────
//
// Records a buyer's action on a specific property.
// Uses property_interests table (canonical table for buyer↔property interest).
// Upserts by (contact_id, listing_id) — one record per contact/property pair.
// interest_level transition rules:
//   dismissed + offer_requested → disallowed (guard enforced here)

export async function recordBuyerPropertyAction(input: {
  contact_id: string
  listing_id: string
  interest_level: BuyerPropertyInterestLevel
  notes?: string
  brokerage_id: string
  agent_id: string
}): Promise<KernelFormsResult<{ interest_id: string }>> {
  try {
    const supabase = createServiceClient()

    // Guard: dismissed cannot escalate to offer without going through saved first
    if (input.interest_level === "offer_requested") {
      const { data: existing } = await supabase
        .from("property_interests")
        .select("interest_level")
        .eq("contact_id", input.contact_id)
        .eq("listing_id", input.listing_id)
        .maybeSingle()

      if (existing?.interest_level === "dismissed" || existing?.interest_level === "not_interested") {
        return {
          success: false,
          error: "Cannot request an offer on a dismissed property. Save it first.",
        }
      }
    }

    const { data: upserted, error } = await supabase
      .from("property_interests")
      .upsert(
        {
          contact_id:     input.contact_id,
          listing_id:     input.listing_id,
          interest_level: input.interest_level,
          notes:          input.notes ?? null,
          saved_at:       new Date().toISOString(),
        },
        { onConflict: "contact_id,listing_id" }
      )
      .select("id")
      .single()

    if (error || !upserted) throw error ?? new Error("Failed to record property action")

    // Emit event based on action level
    const eventMap: Partial<Record<BuyerPropertyInterestLevel, KernelEvent>> = {
      saved:          KernelEvent.PROPERTY_MATCH_FOUND,
      favorited:      KernelEvent.PROPERTY_RECOMMENDED,
      offer_requested: KernelEvent.BUYER_OFFER_ELIGIBLE,
    }
    const event = eventMap[input.interest_level]
    if (event) {
      await supabase
        .from("lifecycle_events")
        .insert({
          entity_type:  "contact",
          entity_id:    input.contact_id,
          event_type:   event,
          brokerage_id: input.brokerage_id,
          metadata: {
            listing_id:     input.listing_id,
            interest_level: input.interest_level,
            agent_id:       input.agent_id,
          },
          created_at: new Date().toISOString(),
        })
    }

    return { success: true, data: { interest_id: upserted.id } }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── COMMAND 10: loadBuyerSavedProperties ────────────────────────────────────
//
// Loads paginated list of saved/favorited properties for a buyer.
// Joins to listings for address, price, and photo.
// Excludes dismissed/not_interested unless include_dismissed=true.

export async function loadBuyerSavedProperties(input: {
  contact_id: string
  include_dismissed?: boolean
  limit?: number
  offset?: number
}): Promise<KernelFormsResult<{ interests: BuyerPropertyInterest[]; total_count: number }>> {
  try {
    const supabase = createServiceClient()

    const pageLimit  = Math.min(input.limit ?? 20, 100)
    const pageOffset = input.offset ?? 0

    const levels = input.include_dismissed
      ? ["saved", "favorited", "dismissed", "not_interested", "offer_requested", "tour_requested"]
      : ["saved", "favorited", "offer_requested", "tour_requested"]

    const { data, error, count } = await supabase
      .from("property_interests")
      .select(
        `id, contact_id, listing_id, interest_level, notes, saved_at,
         listings!listing_id (
           id, address, property_address, list_price, bedrooms, bathrooms, primary_photo_url
         )`,
        { count: "exact" }
      )
      .eq("contact_id", input.contact_id)
      .in("interest_level", levels)
      .order("saved_at", { ascending: false })
      .range(pageOffset, pageOffset + pageLimit - 1)

    if (error) throw error

    const interests: BuyerPropertyInterest[] = (data ?? []).map((row: any) => ({
      id:             row.id,
      contact_id:     row.contact_id,
      listing_id:     row.listing_id,
      interest_level: row.interest_level,
      notes:          row.notes,
      saved_at:       row.saved_at,
      listing:        row.listings
        ? {
            id:                row.listings.id,
            address:           row.listings.address,
            property_address:  row.listings.property_address,
            list_price:        row.listings.list_price,
            bedrooms:          row.listings.bedrooms,
            bathrooms:         row.listings.bathrooms,
            primary_photo_url: row.listings.primary_photo_url,
          }
        : undefined,
    }))

    return {
      success: true,
      data: { interests, total_count: count ?? 0 },
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
