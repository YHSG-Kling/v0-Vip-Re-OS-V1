'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { createClient } from '@/lib/supabase/server'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { KernelEvent } from '@/lib/kernel/events'
import { getAgentContext } from '@/lib/identity/get-agent-context'

// ─── processImportRows ────────────────────────────────────────────────────────

export async function processImportRows(params: {
  brokerageId?: string  // ignored — derived from session
  agentUserId?: string | null  // ignored — derived from session
  importId: string
  rows: Record<string, unknown>[]
}): Promise<{ created: number; merged: number; failed: number }> {
  // Auth gate — was previously trusting caller-supplied brokerageId, letting
  // any signed-in user bulk-create contacts in any brokerage.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { created: 0, merged: 0, failed: params.rows.length }
  }
  const brokerageId = ctx.brokerageId
  const agentUserId = ctx.userId

  const supabase = createServiceClient()

  // Verify the import row belongs to caller's brokerage
  const { data: importRow } = await supabase
    .from('lead_imports')
    .select('brokerage_id')
    .eq('id', params.importId)
    .maybeSingle()
  if (!importRow || importRow.brokerage_id !== brokerageId) {
    return { created: 0, merged: 0, failed: params.rows.length }
  }

  let created = 0
  let merged = 0
  let failed = 0
  const errorDetails: { row: number; error: string }[] = []

  for (let i = 0; i < params.rows.length; i++) {
    const r = params.rows[i]
    try {
      const { action } = await captureContact({
        brokerageId: brokerageId,
        agentUserId: agentUserId,
        source: 'import',
        first_name: typeof r.first_name === 'string' ? r.first_name : null,
        last_name: typeof r.last_name === 'string' ? r.last_name : null,
        email: typeof r.email === 'string' ? r.email : null,
        phone: typeof r.phone === 'string' ? r.phone : null,
        tcpa_consent: !!r.tcpa_consent,
        tcpa_consent_date: r.tcpa_consent ? new Date().toISOString() : null,
        rawPayload: r,
      })
      if (action === 'created') created++
      else merged++
    } catch (err) {
      failed++
      errorDetails.push({
        row: i + 1,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await supabase
    .from('lead_imports')
    .update({
      created_count: created,
      merged_count: merged,
      failed_count: failed,
      error_details: errorDetails.length > 0 ? errorDetails : null,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', params.importId)
    .eq('brokerage_id', brokerageId)

  await supabase.from('lifecycle_events').insert({
    brokerage_id: brokerageId,
    entity_type: 'lead_import',
    entity_id: params.importId,
    event_type: KernelEvent.LEAD_IMPORT_COMPLETED,
    actor_user_id: agentUserId,
    metadata: {
      created,
      merged,
      failed,
      total: params.rows.length,
    },
  })

  return { created, merged, failed }
}

// ─── createImportRecord ────────────────────────────────────────────────────────

export async function createImportRecord(params: {
  fileName: string
  totalRows: number
  fieldMap: Record<string, string>
}): Promise<{ importId: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) throw new Error('Unauthorized')

  const { agentId, brokerageId } = await getAgentContext()

  const serviceClient = createServiceClient()
  const { data, error } = await serviceClient
    .from('lead_imports')
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      file_name: params.fileName,
      total_rows: params.totalRows,
      field_map: params.fieldMap,
      created_count: 0,
      merged_count: 0,
      skipped_count: 0,
      failed_count: 0,
      status: 'processing',
    })
    .select('id')
    .single()

  if (error || !data) throw new Error(`Failed to create import record: ${error?.message}`)

  return { importId: data.id }
}

// ─── runImport ────────────────────────────────────────────────────────────────

export async function runImport(params: {
  importId: string
  rows: Record<string, unknown>[]
  fieldMap: Record<string, string>
}): Promise<{ created: number; merged: number; failed: number }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) throw new Error('Unauthorized')

  const { brokerageId } = await getAgentContext()
  if (!brokerageId) throw new Error("Missing brokerage context")

  // Remap rows using the user-defined field map
  const remapped = params.rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [csvCol, field] of Object.entries(params.fieldMap)) {
      if (field) out[field] = row[csvCol] ?? null
    }
    return out
  })

  return processImportRows({
    brokerageId,
    agentUserId: user.id,
    importId: params.importId,
    rows: remapped,
  })
}

// ─── listImports ──────────────────────────────────────────────────────────────

export async function listImports(): Promise<{
  id: string
  file_name: string
  status: string
  total_rows: number
  created_count: number
  merged_count: number
  failed_count: number
  created_at: string
  completed_at: string | null
}[]> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) throw new Error('Unauthorized')

  const { brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from('lead_imports')
    .select('id, file_name, status, total_rows, created_count, merged_count, failed_count, created_at, completed_at')
    .eq('brokerage_id', brokerageId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(`Failed to list imports: ${error.message}`)
  return data ?? []
}
