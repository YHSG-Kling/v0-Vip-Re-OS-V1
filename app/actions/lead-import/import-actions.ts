'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { createClient } from '@/lib/supabase/server'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { routeUnknownToNotes } from '@/lib/data-steward/field-steward'
import { KernelEvent } from '@/lib/kernel/events'
import { getAgentContext } from '@/lib/identity/get-agent-context'

// Common column names from other CRMs' exports (kvCORE, Follow Up Boss, Lofty/Chime,
// BoomTown, Zillow, generic spreadsheets) → our canonical field set. Matching is by the
// exact header AFTER the user's field-map remap, so these cover rows whose fieldMap
// left source-flavored keys in place. Anything that still doesn't match lands in notes.
const IMPORT_FIELD_ALIASES: Record<string, string> = {
  'First Name': 'first_name', firstName: 'first_name', fname: 'first_name',
  'Last Name': 'last_name', lastName: 'last_name', lname: 'last_name',
  'Email Address': 'email', Email: 'email', email_address: 'email',
  Phone: 'phone', 'Phone Number': 'phone', 'Mobile Phone': 'phone', 'Cell Phone': 'phone',
  mobile_phone: 'phone', cell: 'phone',
  'Home Phone': 'phone_secondary', 'Secondary Phone': 'phone_secondary', 'Work Phone': 'phone_secondary',
  Address: 'address', 'Street Address': 'address', street_address: 'address', address1: 'address',
  City: 'city', State: 'state', Province: 'state',
  Zip: 'zip_code', zip: 'zip_code', 'Zip Code': 'zip_code', 'Postal Code': 'zip_code', postal_code: 'zip_code',
  'Mailing Address': 'mailing_address', 'Mailing City': 'mailing_city',
  'Mailing State': 'mailing_state', 'Mailing Zip': 'mailing_zip', 'Mailing Postal Code': 'mailing_zip',
}

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
  // ctx.agentId is agents.id from the auth context — the importer's owner
  // hint. resolveAgentForContact uses it as the precedence-1 ownerAgentId.
  const importerAgentId = ctx.agentId ?? null
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
      // Data Steward ingress rule: known canonical fields map straight to columns,
      // and EVERY unmapped source column is preserved in notes — an import (CSV from
      // another CRM, portal export, …) may never drop a field on the floor. The
      // previous version forwarded only name/email/phone and discarded the rest.
      const { tcpa_consent: _handledConsent, ...routable } = r
      const { mapped, notes } = routeUnknownToNotes(routable, {
        aliases: IMPORT_FIELD_ALIASES,
      })
      const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
      // CSV values are STRINGS — `!!"false"` is true, which would FABRICATE TCPA consent
      // for any non-empty cell. Only an explicit affirmative counts as imported consent.
      const importedConsent = typeof r.tcpa_consent === 'boolean'
        ? r.tcpa_consent
        : ['true', 'yes', 'y', '1'].includes(`${r.tcpa_consent ?? ''}`.trim().toLowerCase())
      const { action } = await captureContact({
        brokerageId: brokerageId,
        ownerAgentId: importerAgentId,
        source: 'import',
        first_name: str(mapped.first_name),
        last_name: str(mapped.last_name),
        email: str(mapped.email),
        phone: str(mapped.phone),
        phone_secondary: str(mapped.phone_secondary),
        address: str(mapped.address),
        city: str(mapped.city),
        state: str(mapped.state),
        zip_code: str(mapped.zip_code),
        mailing_address: str(mapped.mailing_address),
        mailing_city: str(mapped.mailing_city),
        mailing_state: str(mapped.mailing_state),
        mailing_zip: str(mapped.mailing_zip),
        notes: notes || null,
        tcpa_consent: importedConsent,
        tcpa_consent_date: importedConsent ? new Date().toISOString() : null,
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

  // Remap rows using the user-defined field map. Columns the user did NOT map are
  // passed through under their original CSV header — the Data Steward ingress rule
  // routes them into notes downstream, so an import can never silently drop a column
  // (previously unmapped columns were discarded right here).
  const mappedCsvCols = new Set(
    Object.entries(params.fieldMap).filter(([, f]) => !!f).map(([csvCol]) => csvCol),
  )
  const remapped = params.rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [csvCol, field] of Object.entries(params.fieldMap)) {
      if (field) out[field] = row[csvCol] ?? null
    }
    for (const [csvCol, value] of Object.entries(row)) {
      if (!mappedCsvCols.has(csvCol) && !(csvCol in out)) out[csvCol] = value
    }
    return out
  })

  return processImportRows({
    brokerageId,
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
