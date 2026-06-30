"use server"

// CDA TEMPLATE FIELD actions — wire the pure resolver (lib/transactions/cda-template-fields)
// to real data so each brokerage's OWN CDA form auto-fills from the live commission
// waterfall + the transaction, with the agent filling only the agent-input fields.

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { revalidatePath } from "next/cache"
import {
  resolveCdaTemplateFields,
  cdaWaterfallContext,
  type CdaFieldDef,
  type CdaFieldResolution,
} from "@/lib/transactions/cda-template-fields"

const FIELD_ADMIN_ROLES = new Set(["compliance_officer", "broker", "broker_admin", "admin", "superadmin"])

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
    .select("field_key, label, source, source_key, field_type, static_value, required, display_order")
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
  }))
  if (rows.length > 0) {
    const { error } = await supabase.from("brokerage_cda_template_fields").insert(rows)
    if (error) return { success: false, error: error.message }
  }
  return { success: true, count: rows.length }
}
