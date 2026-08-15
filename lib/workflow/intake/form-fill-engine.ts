/**
 * lib/workflow/intake/form-fill-engine.ts
 *
 * Takes a structured OfferIntake / ListingIntake and produces a filled-forms
 * packet ready for the agent's FormWizard review.
 *
 * Form-source hierarchy (checked in order):
 *   1. Brokerage custom forms folder            (brokerage_form_library table — agent-uploaded)
 *   2. State-association forms                  (lib/state-forms/registry.ts)
 *   3. Transaction provider library             (Dotloop / DocuSign — fetched if connected)
 *
 * For each form, produces:
 *   - The form's identity (name, source, jurisdiction)
 *   - A field-fill map: { fieldName → { value, confidence, sourceField } }
 *   - List of fields that couldn't be filled (agent must complete)
 *
 * The agent then opens this packet in the FormWizard and reviews/finalizes
 * before any signature flow runs.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getStateForms } from "@/lib/state-forms/registry"
import type { OfferIntake } from "./voice-to-offer"
import type { ListingIntake } from "./voice-to-listing"

// ─── Types ──────────────────────────────────────────────────────────────────

export type FormSource = "brokerage" | "state_association" | "transaction_provider"

export interface FilledField {
  fieldName:    string
  value:        unknown
  confidence:   "high" | "medium" | "low" | "agent_override"
  /** Which intake field provided the value (audit trail). */
  sourceField:  string | null
}

export interface FilledForm {
  formId:       string
  formName:     string
  source:       FormSource
  state:        string
  /** True for required-by-state forms; false for optional addenda */
  isRequired:   boolean
  /** Filled fields (success cases) */
  filledFields: FilledField[]
  /** Field names the engine COULDN'T fill — agent must complete in FormWizard */
  unfilled:     Array<{ fieldName: string; reason: string }>
  /** Storage URL of the blank form PDF (or null if not yet cached) */
  formPdfUrl:   string | null
}

export interface FilledOfferPacket {
  packetType:        "offer"
  state:             string
  forms:             FilledForm[]
  brokerageForms:    FilledForm[]
  agentMustComplete: string[]            // global list of fields needing agent input
  audit: {
    source_intake_at:  string
    state_forms_count: number
    brokerage_forms_count: number
    high_confidence_count:   number
    medium_confidence_count: number
    low_confidence_count:    number
  }
}

export interface FilledListingPacket {
  packetType:        "listing"
  state:             string
  forms:             FilledForm[]
  brokerageForms:    FilledForm[]
  agentMustComplete: string[]
  audit: {
    source_intake_at:  string
    state_forms_count: number
    brokerage_forms_count: number
    high_confidence_count:   number
    medium_confidence_count: number
    low_confidence_count:    number
  }
}

// ─── Field-mapping cache (per-form field positions / names) ───────────────
//
// First time a form is used, we don't know which form-field name maps to
// which intake field. This cache lets us learn it once per form and reuse
// forever.
//
// form_field_maps schema (added by migration on demand):
//   form_id text PRIMARY KEY
//   intake_field_to_form_field jsonb     // { "buyerLegalName": "buyer_1_name", ... }
//   updated_at timestamptz

interface FieldMapping {
  intakeField: string
  formField:   string
  confidence:  "high" | "medium" | "low"
}

async function loadFieldMapping(formId: string): Promise<FieldMapping[]> {
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("form_field_maps")
      .select("intake_field_to_form_field")
      .eq("form_id", formId)
      .maybeSingle()
    const map = (data as any)?.intake_field_to_form_field as Record<string, string> | null
    if (!map) return []
    return Object.entries(map).map(([intakeField, formField]) => ({
      intakeField,
      formField,
      confidence: "high" as const,
    }))
  } catch {
    return []
  }
}

// ─── Default field mapping heuristics ──────────────────────────────────────
//
// Until form_field_maps is populated for every state form, use heuristic
// name matching: e.g. intake "buyerLegalName" → form field "buyer_full_name"
// or "purchaser_name" or "buyer_1_name".

const HEURISTIC_PATTERNS: Array<{ intakeField: string; formFieldRegex: RegExp }> = [
  { intakeField: "buyerLegalName",     formFieldRegex: /^(buyer|purchaser).*name/i },
  { intakeField: "coBuyerLegalName",   formFieldRegex: /^(buyer.?2|co.?buyer|spouse).*name/i },
  { intakeField: "sellerLegalName",    formFieldRegex: /^(seller|grantor).*name/i },
  { intakeField: "coSellerLegalName",  formFieldRegex: /^(seller.?2|co.?seller).*name/i },
  { intakeField: "propertyAddress",    formFieldRegex: /^property.*(address|street)/i },
  { intakeField: "propertyCity",       formFieldRegex: /^property.*city/i },
  { intakeField: "propertyState",      formFieldRegex: /^property.*state/i },
  { intakeField: "propertyZip",        formFieldRegex: /^property.*(zip|postal)/i },
  { intakeField: "offerPrice",         formFieldRegex: /^(offer|purchase).*price/i },
  { intakeField: "earnestMoneyAmount", formFieldRegex: /earnest.*money|emd/i },
  { intakeField: "downPaymentPercent", formFieldRegex: /down.*payment/i },
  { intakeField: "financingType",      formFieldRegex: /(financing|loan).*type/i },
  { intakeField: "closeDate",          formFieldRegex: /closing.*date|close.*date/i },
  { intakeField: "inspectionDays",     formFieldRegex: /inspection.*(days|period)/i },
  { intakeField: "appraisalDays",      formFieldRegex: /appraisal.*(days|period)/i },
  { intakeField: "financingDays",      formFieldRegex: /financing.*(days|period)/i },
  { intakeField: "sellerConcessionAmount", formFieldRegex: /(seller.*concession|closing.*credit)/i },
  { intakeField: "listPrice",          formFieldRegex: /list.*price/i },
  { intakeField: "commissionTotalPercent", formFieldRegex: /commission.*(total|percent)/i },
  { intakeField: "listingTermDays",    formFieldRegex: /listing.*(term|period|days)/i },
  { intakeField: "goLiveDate",         formFieldRegex: /go.*live|effective.*date/i },
]

function findIntakeFieldForFormField(formField: string): string | null {
  const normalized = formField.toLowerCase()
  for (const pattern of HEURISTIC_PATTERNS) {
    if (pattern.formFieldRegex.test(normalized)) {
      return pattern.intakeField
    }
  }
  return null
}

// ─── Brokerage form library lookup ─────────────────────────────────────────

async function loadBrokerageForms(input: {
  brokerageId: string
  state:       string
  packetType:  "offer" | "listing"
}): Promise<Array<{ id: string; name: string; pdf_url: string | null; field_schema?: string[] }>> {
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("brokerage_form_library")
      .select("id, name, pdf_url, field_schema")
      .eq("brokerage_id", input.brokerageId)
      .eq("state", input.state)
      .eq("packet_type", input.packetType)
      .eq("is_active", true)
    return data ?? []
  } catch {
    return []                       // table may not exist yet — graceful degrade
  }
}

// ─── Fill engine for OFFER packet ──────────────────────────────────────────

export async function fillOfferPacket(input: {
  intake:      OfferIntake
  brokerageId: string
}): Promise<FilledOfferPacket> {
  const state = input.intake.propertyState.value
  if (!state) throw new Error("Cannot fill offer packet — propertyState missing")

  const stateBundle = getStateForms(state, "offer")

  const stateForms: FilledForm[] = []
  for (const formName of stateBundle.required) {
    stateForms.push(await fillStateAssociationForm({
      formName,
      formNameLower: formName.toLowerCase().replace(/[^a-z0-9]/g, "_"),
      intake: input.intake,
      state,
      isRequired: true,
    }))
  }
  // Addenda are optional — only include if the agent requested them OR the
  // intake's addendaRequested array names them (smart auto-detection).
  const requestedAddenda = (input.intake.addendaRequested.value ?? []) as string[]
  for (const addendumName of stateBundle.addenda) {
    if (requestedAddenda.some(req => addendumName.toLowerCase().includes(req.toLowerCase()))) {
      stateForms.push(await fillStateAssociationForm({
        formName: addendumName,
        formNameLower: addendumName.toLowerCase().replace(/[^a-z0-9]/g, "_"),
        intake: input.intake,
        state,
        isRequired: false,
      }))
    }
  }

  const brokerageRows = await loadBrokerageForms({ brokerageId: input.brokerageId, state, packetType: "offer" })
  const brokerageForms = brokerageRows.map(row => fillBrokerageForm({ row, intake: input.intake, state }))

  const allForms = [...stateForms, ...brokerageForms]
  const counts = countConfidence(allForms)
  const agentMustComplete = collectUnfilledFields(allForms)

  return {
    packetType: "offer",
    state,
    forms: stateForms,
    brokerageForms,
    agentMustComplete,
    audit: {
      source_intake_at: new Date().toISOString(),
      state_forms_count: stateForms.length,
      brokerage_forms_count: brokerageForms.length,
      ...counts,
    },
  }
}

// ─── Fill engine for LISTING packet ────────────────────────────────────────

export async function fillListingPacket(input: {
  intake:      ListingIntake
  brokerageId: string
}): Promise<FilledListingPacket> {
  const state = input.intake.propertyState.value
  if (!state) throw new Error("Cannot fill listing packet — propertyState missing")

  const stateBundle = getStateForms(state, "listing")

  const stateForms: FilledForm[] = []
  for (const formName of stateBundle.required) {
    stateForms.push(await fillStateAssociationForm({
      formName,
      formNameLower: formName.toLowerCase().replace(/[^a-z0-9]/g, "_"),
      intake: input.intake as unknown as OfferIntake,   // shared mapping rules
      state,
      isRequired: true,
    }))
  }

  const brokerageRows = await loadBrokerageForms({ brokerageId: input.brokerageId, state, packetType: "listing" })
  const brokerageForms = brokerageRows.map(row =>
    fillBrokerageForm({ row, intake: input.intake as unknown as OfferIntake, state })
  )

  const allForms = [...stateForms, ...brokerageForms]
  const counts = countConfidence(allForms)
  const agentMustComplete = collectUnfilledFields(allForms)

  return {
    packetType: "listing",
    state,
    forms: stateForms,
    brokerageForms,
    agentMustComplete,
    audit: {
      source_intake_at: new Date().toISOString(),
      state_forms_count: stateForms.length,
      brokerage_forms_count: brokerageForms.length,
      ...counts,
    },
  }
}

// ─── Per-form fillers ──────────────────────────────────────────────────────

async function fillStateAssociationForm(input: {
  formName:      string
  formNameLower: string
  intake:        OfferIntake | ListingIntake
  state:         string
  isRequired:    boolean
}): Promise<FilledForm> {
  // Try to load a learned field mapping for this form
  const learnedMap = await loadFieldMapping(input.formNameLower)

  // Build the filled fields. Without a real PDF schema, we expose every intake
  // field that has a value — the FormWizard handles the visual layout.
  const filledFields: FilledField[] = []
  const unfilled: Array<{ fieldName: string; reason: string }> = []

  const intakeAsMap = input.intake as unknown as Record<string, { value: unknown; confidence: "high"|"medium"|"low"|"missing" }>
  for (const [intakeField, fieldRaw] of Object.entries(intakeAsMap)) {
    if (fieldRaw.value === null || fieldRaw.value === undefined) continue
    if (fieldRaw.confidence === "missing") continue
    const field: { value: unknown; confidence: "high"|"medium"|"low" } = fieldRaw as any

    // Map intake field → form-field name (learned cache OR heuristic OR fallback)
    let formField = learnedMap.find(m => m.intakeField === intakeField)?.formField
    if (!formField) {
      // No learned mapping — use intakeField name itself; FormWizard will surface it
      formField = intakeField
    }

    filledFields.push({
      fieldName: formField,
      value: field.value,
      confidence: field.confidence,                       // narrowed to high|medium|low by the earlier guard
      sourceField: intakeField,
    })
  }

  // For required forms, flag commonly required fields the intake didn't fill
  const requiredCommonFields = ["buyerLegalName", "propertyAddress", "offerPrice", "closeDate"]
  for (const reqField of requiredCommonFields) {
    const exists = filledFields.some(f => f.sourceField === reqField)
    if (!exists && input.isRequired) {
      unfilled.push({ fieldName: reqField, reason: "Required field not provided in intake" })
    }
  }

  return {
    formId:       input.formNameLower,
    formName:     input.formName,
    source:       "state_association",
    state:        input.state,
    isRequired:   input.isRequired,
    filledFields,
    unfilled,
    formPdfUrl:   null,                  // populated when form_field_maps cache has the PDF
  }
}

function fillBrokerageForm(input: {
  row:    { id: string; name: string; pdf_url: string | null; field_schema?: string[] }
  intake: OfferIntake | ListingIntake
  state:  string
}): FilledForm {
  const filledFields: FilledField[] = []
  const unfilled: Array<{ fieldName: string; reason: string }> = []

  const intakeAsMap = input.intake as unknown as Record<string, { value: unknown; confidence: "high"|"medium"|"low"|"missing" }>

  for (const formField of input.row.field_schema ?? []) {
    const intakeField = findIntakeFieldForFormField(formField)
    if (intakeField && intakeAsMap[intakeField]?.value !== null) {
      filledFields.push({
        fieldName: formField,
        value: intakeAsMap[intakeField]!.value,
        confidence: intakeAsMap[intakeField]!.confidence === "missing"
          ? "low" : intakeAsMap[intakeField]!.confidence,
        sourceField: intakeField,
      })
    } else {
      unfilled.push({ fieldName: formField, reason: "No matching intake field" })
    }
  }

  return {
    formId:       input.row.id,
    formName:     input.row.name,
    source:       "brokerage",
    state:        input.state,
    isRequired:   true,
    filledFields,
    unfilled,
    formPdfUrl:   input.row.pdf_url,
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function countConfidence(forms: FilledForm[]) {
  let high = 0, medium = 0, low = 0
  for (const f of forms) {
    for (const ff of f.filledFields) {
      if (ff.confidence === "high")   high++
      if (ff.confidence === "medium") medium++
      if (ff.confidence === "low")    low++
    }
  }
  return {
    high_confidence_count: high,
    medium_confidence_count: medium,
    low_confidence_count: low,
  }
}

function collectUnfilledFields(forms: FilledForm[]): string[] {
  const set = new Set<string>()
  for (const f of forms) {
    for (const u of f.unfilled) set.add(u.fieldName)
  }
  return Array.from(set)
}
