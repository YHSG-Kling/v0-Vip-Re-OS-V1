"use server"

// CDA TEMPLATE FIELD actions — wire the pure resolver (lib/transactions/cda-template-fields)
// to real data so the agent FILLS IN each brokerage's OWN CDA form. No autofill of the money:
// the commission/split/net fields start blank (the agent types them; the computed waterfall value
// is kept as the AI's `expected` audit baseline). Objective transaction facts + static template
// constants still pre-fill. The generated PDF carries what the agent entered — never auto-authored money.

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { revalidatePath } from "next/cache"
import {
  resolveCdaTemplateFields,
  cdaWaterfallContext,
  type CdaFieldDef,
  type CdaFieldResolution,
} from "@/lib/transactions/cda-template-fields"
import { aiClassifyCdaFields, type SuggestedBinding } from "@/lib/transactions/cda-field-classifier"
import { listPdfFields } from "@/lib/forms/pdf-form-fill"

// SCOPE LADDER (kept inline — admits compliance_officer): 'superadmin' removed
// — dead as users.user_type (0 live rows); broker_owner added — storable seat
// with CDA (finance) authority per m472.
const FIELD_ADMIN_ROLES = new Set(["compliance_officer", "broker", "broker_owner", "broker_admin", "admin"])

// Build the resolve context for a CDA from the waterfall + the transaction.
async function buildContext(
  supabase: Awaited<ReturnType<typeof createClient>>,
  cda: { transaction_id: string; brokerage_id: string; gross_commission: number | null; agent_net: number | null; brokerage_net: number | null; field_values?: Record<string, unknown> | null },
) {
  const [{ data: dists }, { data: txn }] = await Promise.all([
    supabase.from("commission_distributions").select("distribution_type, calculated_amount").eq("transaction_id", cda.transaction_id),
    supabase.from("transactions").select("property_address, close_date, estimated_close_date, purchase_price, agent_id").eq("id", cda.transaction_id).maybeSingle(),
  ])
  const waterfall = cdaWaterfallContext({
    gross_commission: cda.gross_commission, agent_net: cda.agent_net, brokerage_net: cda.brokerage_net,
    distributions: (dists ?? []) as Array<{ distribution_type?: string | null; calculated_amount?: number | null }>,
  })
  const transaction: Record<string, string | number | null> = {
    property_address: (txn as { property_address?: string | null } | null)?.property_address ?? null,
    close_date: (txn as { close_date?: string | null; estimated_close_date?: string | null } | null)?.close_date
      ?? (txn as { estimated_close_date?: string | null } | null)?.estimated_close_date ?? null,
    sale_price: (txn as { purchase_price?: number | null } | null)?.purchase_price ?? null,
  }
  // Persisted agent inputs (only the agent_input fields are kept across loads).
  const agentInputs = ((cda.field_values ?? {}) as { agent_inputs?: Record<string, string> }).agent_inputs ?? {}
  return { waterfall, transaction, agentInputs }
}

async function loadDefs(supabase: Awaited<ReturnType<typeof createClient>>, templateId: string | null): Promise<CdaFieldDef[]> {
  if (!templateId) return []
  const { data } = await supabase
    .from("brokerage_cda_template_fields")
    .select("field_key, label, source, source_key, field_type, static_value, required, display_order, pdf_field")
    .eq("template_id", templateId)
    .order("display_order", { ascending: true })
  return (data ?? []) as CdaFieldDef[]
}

/** Resolve a CDA's brokerage form fields against the live waterfall + transaction. */
export async function getCdaFormFieldsAction(input: { cdaId: string }): Promise<
  { success: true; resolution: CdaFieldResolution; hasTemplate: boolean } | { success: false; error: string }
> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, cda_template_id, gross_commission, agent_net, brokerage_net, field_values")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) return { success: false, error: "not_found" }

  const defs = await loadDefs(supabase, (cda as { cda_template_id?: string | null }).cda_template_id ?? null)
  const ctx = await buildContext(supabase, cda as any)
  const resolution = resolveCdaTemplateFields(defs, ctx)
  return { success: true, resolution, hasTemplate: defs.length > 0 }
}

/** Agent fills the agent-input fields; re-resolve and persist field_values. */
export async function saveCdaFieldInputsAction(input: { cdaId: string; agentInputs: Record<string, string> }): Promise<
  { success: true; resolution: CdaFieldResolution } | { success: false; error: string }
> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, cda_template_id, gross_commission, agent_net, brokerage_net, field_values")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) return { success: false, error: "not_found" }

  const defs = await loadDefs(supabase, (cda as { cda_template_id?: string | null }).cda_template_id ?? null)
  const ctx = await buildContext(supabase, cda as any)
  ctx.agentInputs = { ...ctx.agentInputs, ...input.agentInputs }
  const resolution = resolveCdaTemplateFields(defs, ctx)

  // Persist: the resolved values (for rendering/audit) + the raw agent inputs (re-editable).
  const valuesByKey: Record<string, string> = {}
  for (const f of resolution.fields) valuesByKey[f.field_key] = f.formatted
  await supabase
    .from("closing_disclosure_agreement")
    .update({ field_values: { resolved: valuesByKey, agent_inputs: ctx.agentInputs }, updated_at: new Date().toISOString() })
    .eq("id", cda.id)

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  return { success: true, resolution }
}

/**
 * AUTO-BIND (the autonomous-AI step): extract a CDA template PDF's AcroForm fields
 * and classify each into a SUGGESTED binding (waterfall / transaction / agent_input /
 * static) for the broker to confirm. Suggestions are NOT persisted here — the broker
 * reviews + edits, then saves via saveCdaTemplateFieldDefsAction. Honest: if the PDF
 * has no fillable fields, returns hasAcroForm:false (nothing invented).
 */
export async function autoBindCdaTemplateAction(input: { templateId: string }): Promise<
  | { success: true; suggestions: SuggestedBinding[]; hasAcroForm: boolean; pdfFieldCount: number }
  | { success: false; error: string }
> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }
  if (!FIELD_ADMIN_ROLES.has(auth.userType)) return { success: false, error: "forbidden" }

  const { data: template } = await supabase
    .from("brokerage_cda_templates")
    .select("id, brokerage_id, pdf_url")
    .eq("id", input.templateId)
    .maybeSingle()
  if (!template || template.brokerage_id !== auth.brokerageId) return { success: false, error: "not_found" }
  if (!template.pdf_url) return { success: false, error: "no_pdf" }

  // Fetch the uploaded PDF bytes (Vercel Blob public URL) and read its AcroForm fields.
  let fieldNames: string[]
  try {
    const res = await fetch(template.pdf_url)
    if (!res.ok) return { success: false, error: `pdf_fetch_failed_${res.status}` }
    const bytes = new Uint8Array(await res.arrayBuffer())
    fieldNames = await listPdfFields(bytes)
  } catch (e) {
    return { success: false, error: e instanceof Error ? `pdf_read_failed: ${e.message}` : "pdf_read_failed" }
  }

  if (fieldNames.length === 0) {
    return { success: true, suggestions: [], hasAcroForm: false, pdfFieldCount: 0 }
  }

  const suggestions = await aiClassifyCdaFields(fieldNames)
  return { success: true, suggestions, hasAcroForm: true, pdfFieldCount: fieldNames.length }
}

/** Load a template's current field bindings (for the mapping editor). */
export async function getCdaTemplateFieldDefsAction(input: { templateId: string }): Promise<
  { success: true; fields: CdaFieldDef[] } | { success: false; error: string }
> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const { data: template } = await supabase
    .from("brokerage_cda_templates")
    .select("id, brokerage_id")
    .eq("id", input.templateId)
    .maybeSingle()
  if (!template || template.brokerage_id !== auth.brokerageId) return { success: false, error: "not_found" }

  const fields = await loadDefs(supabase, input.templateId)
  return { success: true, fields }
}

/** Brokerage admin defines (replaces) a template's field bindings. */
export async function saveCdaTemplateFieldDefsAction(input: {
  templateId: string
  fields: Array<CdaFieldDef>
}): Promise<{ success: true; count: number } | { success: false; error: string }> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }
  if (!FIELD_ADMIN_ROLES.has(auth.userType)) return { success: false, error: "forbidden" }

  const { data: template } = await supabase
    .from("brokerage_cda_templates")
    .select("id, brokerage_id")
    .eq("id", input.templateId)
    .maybeSingle()
  if (!template || template.brokerage_id !== auth.brokerageId) return { success: false, error: "not_found" }

  // Replace the template's field set atomically-ish (delete + insert).
  await supabase.from("brokerage_cda_template_fields").delete().eq("template_id", input.templateId)
  const rows = input.fields.map((f, i) => ({
    brokerage_id: auth.brokerageId,
    template_id: input.templateId,
    field_key: f.field_key,
    label: f.label ?? null,
    source: f.source,
    source_key: f.source_key ?? null,
    field_type: f.field_type,
    static_value: f.static_value ?? null,
    required: !!f.required,
    display_order: f.display_order ?? i,
    pdf_field: f.pdf_field ?? null,
  }))
  if (rows.length > 0) {
    const { error } = await supabase.from("brokerage_cda_template_fields").insert(rows)
    if (error) return { success: false, error: error.message }
  }
  return { success: true, count: rows.length }
}

/**
 * GENERATE the filled CDA PDF — the real artifact. Resolve the brokerage form fields (money
 * fields carry the AGENT'S entered values, never an auto-filled waterfall number; facts/static
 * pre-fill), then write those values onto the brokerage's actual CDA PDF (its AcroForm fields,
 * targeted by name) and store the filled PDF on the CDA so it can be e-signed and delivered to
 * title. Grounded: only fields with a real AcroForm target + a non-empty resolved value are
 * written (buildCdaFillValues) — a money field the agent left blank is skipped, never invented.
 */
export async function generateFilledCdaPdfAction(input: { cdaId: string }): Promise<
  | { success: true; url: string; filled: number; skipped: string[]; unmapped: string[] }
  | { success: false; error: string }
> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, cda_template_id, gross_commission, agent_net, brokerage_net, field_values")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) return { success: false, error: "not_found" }

  const templateId = (cda as { cda_template_id?: string | null }).cda_template_id ?? null
  if (!templateId) return { success: false, error: "no_template" }

  const { data: template } = await supabase
    .from("brokerage_cda_templates")
    .select("id, brokerage_id, pdf_url")
    .eq("id", templateId)
    .maybeSingle()
  if (!template || template.brokerage_id !== auth.brokerageId) return { success: false, error: "template_not_found" }
  if (!template.pdf_url) return { success: false, error: "no_pdf" }

  // Resolve the form against the live waterfall + transaction.
  const defs = await loadDefs(supabase, templateId)
  if (defs.length === 0) return { success: false, error: "no_field_bindings" }
  const ctx = await buildContext(supabase, cda as any)
  const resolution = resolveCdaTemplateFields(defs, ctx)

  const { buildCdaFillValues } = await import("@/lib/transactions/cda-pdf-fill")
  const { fillPdfForm } = await import("@/lib/forms/pdf-form-fill")
  const { uploadBufferToBucket } = await import("@/lib/storage/buckets")

  const plan = buildCdaFillValues(resolution.fields)
  if (plan.values.length === 0) return { success: false, error: "nothing_to_fill" }

  // Fetch the brokerage template PDF + write the resolved values onto its AcroForm fields.
  let filledBytes: Uint8Array
  let filled: number
  let skipped: string[]
  try {
    const res = await fetch(template.pdf_url)
    if (!res.ok) return { success: false, error: `pdf_fetch_failed_${res.status}` }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const result = await fillPdfForm(bytes, plan.values, { flatten: false })
    filledBytes = result.bytes
    filled = result.filled.length
    skipped = result.skipped
  } catch (e) {
    return { success: false, error: e instanceof Error ? `pdf_fill_failed: ${e.message}` : "pdf_fill_failed" }
  }

  // Store the filled PDF in Supabase Storage (platform buckets) + record it on the CDA.
  const stored = await uploadBufferToBucket({
    bucket: "cda-filled",
    path: `${cda.id}-${cda.transaction_id}-${crypto.randomUUID()}.pdf`,
    buffer: Buffer.from(filledBytes),
    contentType: "application/pdf",
    // The follow-up the previous comment promised. A FILLED closing-disclosure
    // agreement carries the commission split — a brokerage financial, and
    // commission is off agent-facing display entirely (CLAUDE.md §5). It was
    // being stored `public: true`, i.e. at a permanent unauthenticated URL that
    // was then persisted to closing_disclosure_agreement.generated_pdf_url.
    public: false,
  })
  if (!stored.ok) return { success: false, error: `pdf_store_failed: ${stored.error}` }
  const url: string = stored.url

  await supabase
    .from("closing_disclosure_agreement")
    .update({ generated_pdf_url: url, generated_pdf_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", cda.id)

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  return { success: true, url, filled, skipped, unmapped: plan.unmapped }
}
