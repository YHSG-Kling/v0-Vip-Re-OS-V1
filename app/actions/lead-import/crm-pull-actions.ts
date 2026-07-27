"use server"

// app/actions/lead-import/crm-pull-actions.ts — WHITE-GLOVE MIGRATION, PLATFORM SIDE.
//
// Pull a subscriber's contacts out of their OLD CRM (Follow Up Boss / Lofty /
// HubSpot / GoHighLevel) and land them in THAT subscriber's tenant.
//
// WHO CAN RUN THIS — platform staff only, never the tenant.
// Pulling is taking someone's book of business out of another system and writing
// it into this one. That is an operation the platform performs FOR a subscriber
// during onboarding, not something a tenant points at itself. The tenant's own
// CRM relationship runs the other direction: app/actions/crm-connect.ts is
// sync-OUT only — the app pushes contact updates to their CRM and nothing syncs
// back in. This file is the inbound counterpart and is gated accordingly.
//
// It previously admitted `agent` and `team_lead` and imported into whatever
// brokerage the CALLER belonged to, while stamping the saved credential
// owner_type 'brokerage' — a role set and an ownership claim that disagreed.
//
// WHERE THE ROWS LAND — the same lane as the CSV white-glove import
// (lib/platform/tenant-import.ts). The vendor pull is just a second row source:
// identical validation, identical owner-agent resolution, identical dedupe
// against the TARGET tenant, and consent is still never imported as true.
// The old path went through processImportRows, which derives the brokerage from
// the CALLER'S session by design — so it could only ever import into the
// operator's own tenant, which is the opposite of what white-glove needs.

import { createServiceClient } from "@/lib/supabase/service"
import { pullCrmPage, CRM_IMPORT_PROVIDERS, type CrmImportProvider } from "@/lib/crm/import-pull"
import { parseContactRecords } from "@/lib/platform/tenant-import-parser"
import { importParsedContacts } from "@/lib/platform/tenant-import"
import { gateStaffAction, auditStaffAction } from "@/lib/platform/staff-action-gate"

const MAX_PAGES_PER_RUN = 40 // 40 × 100 = 4,000 contacts per run; resumable, honestly reported

/** Save a subscriber's old-CRM credential against THEIR brokerage. */
export async function setCrmImportCredentialAction(input: {
  brokerageId: string
  provider: CrmImportProvider
  apiKey: string
  apiUrl?: string
  locationId?: string
}): Promise<{ ok: boolean; error?: string }> {
  const gate = await gateStaffAction("tenants")
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!input.brokerageId) return { ok: false, error: "Target brokerage required" }
  if (!CRM_IMPORT_PROVIDERS.includes(input.provider)) return { ok: false, error: "Unknown provider" }
  const apiKey = input.apiKey?.trim()
  if (!apiKey || apiKey.length < 10) return { ok: false, error: "That doesn't look like a valid API key" }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").eq("id", input.brokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Unknown brokerage" }

  const { data: existing } = await svc.from("platform_credentials").select("id")
    .eq("brokerage_id", input.brokerageId).eq("platform", input.provider).maybeSingle()
  const row = {
    brokerage_id: input.brokerageId, platform: input.provider,
    api_key: apiKey, api_url: input.apiUrl?.trim() || null,
    config: input.locationId ? { location_id: input.locationId.trim() } : {},
    // owner_type/owner_id now describe the SUBSCRIBER whose credential this is,
    // which is what they always claimed and only now reliably are.
    owner_type: "brokerage", owner_id: input.brokerageId, is_active: true,
  }
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as any).id)
    : await svc.from("platform_credentials").insert(row)
  if (error) return { ok: false, error: error.message }

  await auditStaffAction(gate, "crm_import_credential_saved", input.brokerageId, { provider: input.provider })
  return { ok: true }
}

export interface CrmImportRunResult {
  ok: boolean
  error?: string
  created: number
  skippedDuplicates: number
  failed: number
  pagesPulled: number
  /** Non-null → more contacts remain; run again to continue from here. */
  nextCursor: string | null
}

/** Pull a subscriber's old CRM into THEIR tenant. Resumable via cursor. */
export async function runCrmImportAction(input: {
  brokerageId: string
  provider: CrmImportProvider
  cursor?: string | null
}): Promise<CrmImportRunResult> {
  const zero = { created: 0, skippedDuplicates: 0, failed: 0, pagesPulled: 0, nextCursor: null }
  const gate = await gateStaffAction("tenants")
  if (!gate.ok) return { ok: false, error: gate.error, ...zero }
  if (!input.brokerageId) return { ok: false, error: "Target brokerage required", ...zero }
  if (!CRM_IMPORT_PROVIDERS.includes(input.provider)) return { ok: false, error: "Unknown provider", ...zero }

  const svc = createServiceClient()
  const { data: cred } = await svc.from("platform_credentials")
    .select("api_key, api_url, config")
    .eq("brokerage_id", input.brokerageId).eq("platform", input.provider).eq("is_active", true).maybeSingle()
  if (!(cred as any)?.api_key) {
    return { ok: false, error: `${input.provider} isn't connected for this brokerage yet — save their API key first.`, ...zero }
  }

  let cursor: string | null = input.cursor ?? null
  let created = 0, skippedDuplicates = 0, failed = 0, pages = 0
  let pullError: string | undefined

  while (pages < MAX_PAGES_PER_RUN) {
    const page = await pullCrmPage(input.provider, {
      apiKey: (cred as any).api_key,
      apiUrl: (cred as any).api_url,
      locationId: (cred as any).config?.location_id ?? null,
    }, cursor)
    if (page.error) { pullError = page.error; break }

    if (page.rows.length > 0) {
      // Vendor rows are already shaped like that vendor's CSV export, so they run
      // through the SAME header aliases and the SAME row validation as an upload.
      const parsed = parseContactRecords(page.rows)
      const r = await importParsedContacts({
        svc,
        brokerageId: input.brokerageId,
        dedupe: "email_phone",
        importedBy: gate.userId,
        parsed,
        emptyLabel: `${input.provider} page`,
      })
      created += r.inserted
      skippedDuplicates += r.skippedDuplicates
      failed += r.errors.length
      // A page whose rows ALL fail validation (parsed.rows.length === 0 → "No
      // importable rows") is NOT fatal: those failures are already counted in
      // `failed`, and later pages may still hold valid contacts. Aborting here
      // would also strand the run — we break before `cursor = page.nextCursor`,
      // so the returned cursor points back at the same bad page forever.
      // Genuinely fatal errors (brokerage missing, no owner agent, dedupe scan
      // failure) can only arise once there WERE importable rows, so gate on that.
      if (!r.ok && r.error && parsed.rows.length > 0) { pullError = r.error; break }
    }

    pages += 1
    cursor = page.nextCursor
    if (!cursor) break
  }

  await auditStaffAction(gate, "crm_import_run", input.brokerageId, {
    provider: input.provider, created, skippedDuplicates, failed,
    pagesPulled: pages, resumed: Boolean(input.cursor), error: pullError ?? null,
  })

  return {
    ok: pages > 0 || !pullError,
    error: pullError,
    created, skippedDuplicates, failed,
    pagesPulled: pages, nextCursor: cursor,
  }
}

/** Which providers have a saved credential for this subscriber (for the panel). */
export async function getCrmImportStatusAction(
  brokerageId: string,
): Promise<{ ok: boolean; connected: string[] }> {
  const gate = await gateStaffAction("tenants")
  if (!gate.ok || !brokerageId) return { ok: false, connected: [] }
  const svc = createServiceClient()
  const { data } = await svc.from("platform_credentials").select("platform")
    .eq("brokerage_id", brokerageId).in("platform", CRM_IMPORT_PROVIDERS as unknown as string[]).eq("is_active", true)
  return { ok: true, connected: ((data ?? []) as any[]).map((r) => r.platform) }
}
