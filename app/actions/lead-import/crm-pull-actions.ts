"use server"

// app/actions/lead-import/crm-pull-actions.ts — "bring your database with you":
// pull contacts from the tenant's OLD CRM (Follow Up Boss / Lofty / HubSpot /
// GoHighLevel) through the SAME gated import pipeline as a CSV upload. The
// vendor pull is just another row source — processImportRows applies the field
// steward (unknowns → notes), the Data Steward enum normalizer, and
// captureContact; consent flags are NEVER imported as true. The AI managers'
// automations stay clean by construction.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { pullCrmPage, CRM_IMPORT_PROVIDERS, type CrmImportProvider } from "@/lib/crm/import-pull"
import { createImportRecord, processImportRows } from "./import-actions"

const ADMIN_TYPES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead", "agent"])
const MAX_PAGES_PER_RUN = 40 // 40 × 100 = 4,000 contacts per run; resumable, honestly reported

async function requireCtx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return null
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return null
  return ctx
}

/** Save the tenant's old-CRM credential (platform_credentials, their key). */
export async function setCrmImportCredentialAction(input: {
  provider: CrmImportProvider
  apiKey: string
  apiUrl?: string
  locationId?: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireCtx()
  if (!ctx) return { ok: false, error: "Unauthorized" }
  if (!CRM_IMPORT_PROVIDERS.includes(input.provider)) return { ok: false, error: "Unknown provider" }
  const apiKey = input.apiKey?.trim()
  if (!apiKey || apiKey.length < 10) return { ok: false, error: "That doesn't look like a valid API key" }

  const svc = createServiceClient()
  const { data: existing } = await svc.from("platform_credentials").select("id")
    .eq("brokerage_id", ctx.brokerageId).eq("platform", input.provider).maybeSingle()
  const row = {
    brokerage_id: ctx.brokerageId, platform: input.provider,
    api_key: apiKey, api_url: input.apiUrl?.trim() || null,
    config: input.locationId ? { location_id: input.locationId.trim() } : {},
    owner_type: "brokerage", owner_id: ctx.brokerageId, is_active: true,
  }
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as any).id)
    : await svc.from("platform_credentials").insert(row)
  return error ? { ok: false, error: error.message } : { ok: true }
}

export interface CrmImportRunResult {
  ok: boolean
  error?: string
  created: number
  merged: number
  failed: number
  pagesPulled: number
  /** Non-null → more contacts remain; run again to continue from here. */
  nextCursor: string | null
  importId?: string
}

/** Pull the tenant's old CRM through the gated pipeline. Resumable via cursor. */
export async function runCrmImportAction(input: {
  provider: CrmImportProvider
  cursor?: string | null
}): Promise<CrmImportRunResult> {
  const zero = { created: 0, merged: 0, failed: 0, pagesPulled: 0, nextCursor: null }
  const ctx = await requireCtx()
  if (!ctx) return { ok: false, error: "Unauthorized", ...zero }
  if (!CRM_IMPORT_PROVIDERS.includes(input.provider)) return { ok: false, error: "Unknown provider", ...zero }

  const svc = createServiceClient()
  const { data: cred } = await svc.from("platform_credentials")
    .select("api_key, api_url, config")
    .eq("brokerage_id", ctx.brokerageId).eq("platform", input.provider).eq("is_active", true).maybeSingle()
  if (!(cred as any)?.api_key) {
    return { ok: false, error: `${input.provider} isn't connected yet — save your API key first.`, ...zero }
  }

  const { importId } = await createImportRecord({
    fileName: `crm-pull:${input.provider}`,
    totalRows: 0, // unknown up front — the ledger counts as pages land
    fieldMap: {},
  })

  let cursor: string | null = input.cursor ?? null
  let created = 0, merged = 0, failed = 0, pages = 0
  while (pages < MAX_PAGES_PER_RUN) {
    const page = await pullCrmPage(input.provider, {
      apiKey: (cred as any).api_key,
      apiUrl: (cred as any).api_url,
      locationId: (cred as any).config?.location_id ?? null,
    }, cursor)
    if (page.error) {
      return { ok: pages > 0, error: page.error, created, merged, failed, pagesPulled: pages, nextCursor: cursor, importId }
    }
    if (page.rows.length > 0) {
      // THE GATE: same pipeline as a CSV upload — field steward, enum
      // normalizer, captureContact dedupe. Nothing lands ungated.
      const r = await processImportRows({ importId, rows: page.rows })
      created += r.created; merged += r.merged; failed += r.failed
    }
    pages += 1
    cursor = page.nextCursor
    if (!cursor) break
  }

  await svc.from("lead_imports").update({
    status: cursor ? "processing" : "completed",
    total_rows: created + merged + failed,
  }).eq("id", importId).then(undefined, () => {})

  return { ok: true, created, merged, failed, pagesPulled: pages, nextCursor: cursor, importId }
}

/** Which providers have a saved credential (for the import UI). */
export async function getCrmImportStatusAction(): Promise<{ ok: boolean; connected: string[] }> {
  const ctx = await requireCtx()
  if (!ctx) return { ok: false, connected: [] }
  const svc = createServiceClient()
  const { data } = await svc.from("platform_credentials").select("platform")
    .eq("brokerage_id", ctx.brokerageId).in("platform", CRM_IMPORT_PROVIDERS as unknown as string[]).eq("is_active", true)
  return { ok: true, connected: ((data ?? []) as any[]).map((r) => r.platform) }
}
