"use server"

// app/actions/forms-kernel.ts
// ═══════════════════════════════════════════════════════════════════════════════
// FORMS KERNEL SERVER ACTIONS — thin wrappers only.
// No business logic here. All logic lives in lib/kernel/forms.ts.
// All calls are guarded by session auth; brokerage_id is resolved server-side.
// ═══════════════════════════════════════════════════════════════════════════════

import { createClient } from "@/lib/supabase/server"
import {
  resolveTransactionFormsProvider,
  loadAvailableTransactionForms,
  prefillFormWithContext,
  saveFormDraft,
  loadFormDraft,
  launchEsignEnvelope,
  syncEsignDocuments,
  recordBuyerPropertyAction,
  loadBuyerSavedProperties,
  type FormContextType,
  type BuyerPropertyInterestLevel,
} from "@/lib/kernel/forms"

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function resolveActorContext() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser()
  if (authErr || !user) return null

  const { data: agent } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!agent) return null
  return { user_id: user.id, agent_id: agent.id, brokerage_id: agent.brokerage_id }
}

// ─── ACTION: resolveFormsProvider ────────────────────────────────────────────

export async function resolveFormsProviderAction() {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  return resolveTransactionFormsProvider({ brokerage_id: ctx.brokerage_id })
}

// ─── ACTION: loadAvailableForms ──────────────────────────────────────────────

export async function loadAvailableFormsAction(input: {
  context_type: FormContextType
  state?: string
}) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  return loadAvailableTransactionForms({
    brokerage_id: ctx.brokerage_id,
    context_type: input.context_type,
    state:        input.state,
  })
}

// ─── ACTION: prefillForm ─────────────────────────────────────────────────────

export async function prefillFormAction(input: {
  form_name:    string
  context_type: FormContextType
  context_id:   string
}) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  return prefillFormWithContext({
    form_name:    input.form_name,
    context_type: input.context_type,
    context_id:   input.context_id,
    brokerage_id: ctx.brokerage_id,
  })
}

// ─── ACTION: saveFormDraft ───────────────────────────────────────────────────

export async function saveFormDraftAction(input: {
  form_name:    string
  context_type: FormContextType
  context_id:   string
  field_values: Record<string, any>
}) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  return saveFormDraft({
    brokerage_id: ctx.brokerage_id,
    agent_id:     ctx.agent_id,
    form_name:    input.form_name,
    context_type: input.context_type,
    context_id:   input.context_id,
    field_values: input.field_values,
  })
}

// ─── ACTION: loadFormDraft ───────────────────────────────────────────────────

export async function loadFormDraftAction(input: {
  form_name:  string
  context_id: string
}) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  return loadFormDraft({
    brokerage_id: ctx.brokerage_id,
    agent_id:     ctx.agent_id,
    form_name:    input.form_name,
    context_id:   input.context_id,
  })
}

// ─── ACTION: launchEsign ─────────────────────────────────────────────────────

export async function launchEsignAction(input: {
  form_submission_id:      string
  external_transaction_id: string
  signers: Array<{ name: string; email: string; role: string }>
  message?: string
}) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  return launchEsignEnvelope({
    brokerage_id:            ctx.brokerage_id,
    agent_id:                ctx.agent_id,
    form_submission_id:      input.form_submission_id,
    external_transaction_id: input.external_transaction_id,
    signers:                 input.signers,
    message:                 input.message,
  })
}

// ─── (REMOVED) getEsignStatusAction ─────────────────────────────────────────
//
// DELETED as an exact duplicate. The signature-status capability lives entirely
// in lib/kernel/forms.ts:getEsignStatus; this action was a pass-through that
// resolved the actor (session -> agents.brokerage_id) and delegated. The SAME
// kernel function is already reached, with the SAME actor resolution, by
//   app/api/esign/status/[transactionId]/route.ts:GET
// which is the wired path: app/components/forms/EsignStatusTracker.tsx polls it
// via SWR and is mounted at app/portal/[contactId]/offers/page.tsx. The route is
// the more complete copy — identical inputs plus HTTP status semantics (401/403/
// 500) and a live polling contract. Nothing had to be ported: the deleted body
// held no logic of its own, only the delegating call.

// ─── ACTION: syncEsignDocs ───────────────────────────────────────────────────
//
// DELIBERATELY LEFT UNWIRED. lib/kernel/forms.ts:syncEsignDocuments FETCHES the
// provider's document list and explicitly "does NOT write to DB". The wired,
// strictly more complete writer is
//   lib/transactions/sync-from-provider.ts:syncTransactionDocumentsFromProvider
// (+ syncAllForContact), reached from app/portal/[contactId]/documents/page.tsx:
// same provider.syncDocuments call, plus idempotent upsert into
// transaction_documents on (transaction_id, provider_source,
// external_document_id), a staleness throttle, and a last_provider_sync_at stamp.
// This wrapper is NOT deleted: it carries one capability the survivor lacks —
// listing_id scoping, for pre-contract listing packets that have no transaction
// row — and moving that capability onto the survivor means editing
// lib/transactions/sync-from-provider.ts, which is outside this pass's file set.
// An unproven port is not a port, so it stays, hardened and unwired.

export async function syncEsignDocsAction(input: {
  external_transaction_id: string
  contact_id:              string
  transaction_id?:         string
  listing_id?:             string
}) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  return syncEsignDocuments({
    brokerage_id:            ctx.brokerage_id,
    external_transaction_id: input.external_transaction_id,
    contact_id:              input.contact_id,
    transaction_id:          input.transaction_id,
    listing_id:              input.listing_id,
  })
}

// ─── ACTION: recordPropertyAction (buyer portal server action) ───────────────
// This is safe to call from a buyer portal route because contact_id is validated
// server-side against the session's portal access token.

export async function recordPropertyActionAction(input: {
  contact_id:     string
  listing_id:     string
  interest_level: BuyerPropertyInterestLevel
  notes?:         string
}) {
  // For portal actions we still need a brokerage context; resolve via contact
  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id, agent_id")
    .eq("id", input.contact_id)
    .maybeSingle()

  if (!contact) return { success: false, error: "Contact not found" }

  return recordBuyerPropertyAction({
    contact_id:     input.contact_id,
    listing_id:     input.listing_id,
    interest_level: input.interest_level,
    notes:          input.notes,
    brokerage_id:   contact.brokerage_id,
    agent_id:       contact.agent_id ?? "",
  })
}

// ─── ACTION: getFormFields ───────────────────────────────────────────────────
// Returns the field_schema for a specific form template.
// Falls back to category-based defaults when field_schema is empty.

export interface FormFieldDef {
  key: string
  label: string
  type: "text" | "email" | "tel" | "number" | "date" | "textarea"
  section: string
  required?: boolean
  placeholder?: string
}

const CATEGORY_DEFAULT_FIELDS: Record<string, FormFieldDef[]> = {
  purchase_agreement: [
    { key: "property_address", label: "Property Address", type: "text", section: "Property", required: true, placeholder: "123 Main St" },
    { key: "city", label: "City", type: "text", section: "Property", required: true },
    { key: "state", label: "State", type: "text", section: "Property", required: true },
    { key: "zip_code", label: "ZIP Code", type: "text", section: "Property" },
    { key: "mls_number", label: "MLS Number", type: "text", section: "Property" },
    { key: "purchase_price", label: "Purchase Price", type: "number", section: "Financial Terms", required: true, placeholder: "500000" },
    { key: "earnest_money", label: "Earnest Money", type: "number", section: "Financial Terms" },
    { key: "closing_date", label: "Closing Date", type: "date", section: "Financial Terms" },
    { key: "commission_rate", label: "Commission Rate (%)", type: "number", section: "Financial Terms" },
    { key: "buyer_name", label: "Buyer Name", type: "text", section: "Parties", required: true },
    { key: "buyer_email", label: "Buyer Email", type: "email", section: "Parties" },
    { key: "seller_name", label: "Seller Name", type: "text", section: "Parties", required: true },
    { key: "seller_email", label: "Seller Email", type: "email", section: "Parties" },
  ],
  listing_agreement: [
    { key: "property_address", label: "Property Address", type: "text", section: "Property", required: true },
    { key: "city", label: "City", type: "text", section: "Property", required: true },
    { key: "state", label: "State", type: "text", section: "Property" },
    { key: "zip_code", label: "ZIP Code", type: "text", section: "Property" },
    { key: "list_price", label: "List Price", type: "number", section: "Financial Terms", required: true },
    { key: "listing_start_date", label: "Listing Start Date", type: "date", section: "Financial Terms" },
    { key: "listing_expiration_date", label: "Expiration Date", type: "date", section: "Financial Terms" },
    { key: "commission_rate", label: "Commission Rate (%)", type: "number", section: "Financial Terms" },
    { key: "seller_name", label: "Seller Name", type: "text", section: "Parties", required: true },
    { key: "seller_email", label: "Seller Email", type: "email", section: "Parties" },
    { key: "seller_phone", label: "Seller Phone", type: "tel", section: "Parties" },
  ],
  disclosure: [
    { key: "property_address", label: "Property Address", type: "text", section: "Property", required: true },
    { key: "seller_name", label: "Seller Name", type: "text", section: "Parties", required: true },
    { key: "seller_email", label: "Seller Email", type: "email", section: "Parties" },
    { key: "disclosure_date", label: "Disclosure Date", type: "date", section: "Details" },
    { key: "notes", label: "Additional Notes", type: "textarea", section: "Details" },
  ],
}

export async function getFormFieldsAction(formId: string): Promise<{
  success: boolean
  fields?: FormFieldDef[]
  error?: string
}> {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Unauthorized" }

  const supabase = await createClient()
  const { data: form } = await supabase
    .from("brokerage_forms")
    .select("field_schema, form_category")
    .eq("id", formId)
    .or(`brokerage_id.eq.${ctx.brokerage_id},brokerage_id.is.null`)
    .maybeSingle()

  // The agent-visible template list merges broker-uploaded library forms
  // (brokerage_form_library) alongside brokerage_forms, so a form id may point
  // at either table. If it isn't a brokerage_forms row, resolve it from the
  // library — otherwise those forms hang forever on "Loading form fields…".
  if (!form) {
    const { data: libForm } = await supabase
      .from("brokerage_form_library")
      .select("field_schema, packet_type")
      .eq("id", formId)
      .or(`brokerage_id.eq.${ctx.brokerage_id},brokerage_id.is.null`)
      .maybeSingle()

    if (!libForm) return { success: false, error: "Form not found" }

    // Library forms store field_schema as a text[] of field-LABEL strings
    // (what the admin PDF-upload captures), not FormFieldDef objects. Lift each
    // label into a real FormFieldDef so the renderer gets the shape it expects.
    const libLabels = (libForm.field_schema as unknown as string[] | null) ?? []
    const libFields: FormFieldDef[] = libLabels
      .filter((l) => typeof l === "string" && l.trim().length > 0)
      .map((label): FormFieldDef => ({
        key: label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
        label: label.trim(),
        type: "text",
        section: "Fields",
      }))
    if (libFields.length > 0) {
      return { success: true, fields: libFields }
    }
    const libCategory = (libForm.packet_type ?? "").toLowerCase().replace(/\s+/g, "_")
    const libDefaults = CATEGORY_DEFAULT_FIELDS[libCategory] ?? CATEGORY_DEFAULT_FIELDS.purchase_agreement
    return { success: true, fields: libDefaults }
  }

  const schema = form.field_schema as FormFieldDef[] | null
  if (schema && Array.isArray(schema) && schema.length > 0) {
    return { success: true, fields: schema }
  }

  // Fallback to category defaults
  const category = (form.form_category ?? "").toLowerCase().replace(/\s+/g, "_")
  const defaults = CATEGORY_DEFAULT_FIELDS[category] ?? CATEGORY_DEFAULT_FIELDS.purchase_agreement
  return { success: true, fields: defaults }
}

// ─── ACTION: loadBuyerProperties ────────────────────────────────────────────

export async function loadBuyerPropertiesAction(input: {
  contact_id:       string
  include_dismissed?: boolean
  limit?:           number
  offset?:          number
}) {
  return loadBuyerSavedProperties({
    contact_id:       input.contact_id,
    include_dismissed: input.include_dismissed,
    limit:            input.limit,
    offset:           input.offset,
  })
}
