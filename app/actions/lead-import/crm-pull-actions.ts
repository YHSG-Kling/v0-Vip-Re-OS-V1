"use server"

// app/actions/lead-import/crm-pull-actions.ts — WHITE-GLOVE MIGRATION, PLATFORM SIDE.
//
// Pull a subscriber's contacts out of their OLD CRM (Follow Up Boss / Lofty /
// GoHighLevel) and land them in THAT subscriber's tenant.
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
//
// THE INBOUND CHAIN (owner, wave 141 — lane 141D): provider data → STAFF
// authorization (platform_role, never a tenant admin, never the legacy
// user_type='superadmin' marker) → EXPLICIT field mapping against the canonical
// registry (lib/kernel/schema-adaptation.ts CRM_CONTACT_INGRESS_CONTRACT, applied
// by the one parser) → PREVIEW (previewCrmImportAction: the mapping table, the
// ignored vendor keys, importable/problem counts, would-be duplicates, a sample —
// a dry run of the real lane, nothing written) → VALIDATION (the parser's
// registry identity rule, per row with its position) → identity/dedup against
// the TARGET tenant → CONTROLLED COMMIT (runCrmImportAction refuses without the
// preview's token, recomputed from the first page it pulls) → only THEN the
// evidence row (lead_imports) and the kernel event (LEAD_IMPORT_COMPLETED) that
// the reactor / workflows pick up. A tenant reaching any of these doors gets
// INBOUND_IMPORT_TENANT_REFUSAL — one clear sentence, never a bare "Forbidden".

import { createServiceClient } from "@/lib/supabase/service"
import {
  pullCrmPage, CRM_IMPORT_PROVIDERS, crmImportPreviewToken, type CrmImportProvider,
} from "@/lib/crm/import-pull"
import { parseContactRecords, type CsvRowError } from "@/lib/platform/tenant-import-parser"
import { importParsedContacts } from "@/lib/platform/tenant-import"
import { gateStaffAction, auditStaffAction, type StaffGate } from "@/lib/platform/staff-action-gate"
import { encryptSecret, decryptSecret } from "@/lib/security/secret-crypto"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

const MAX_PAGES_PER_RUN = 40 // 40 × 100 = 4,000 contacts per run; resumable, honestly reported
const PREVIEW_SAMPLE_ROWS = 5
const PREVIEW_PROBLEMS_SHOWN = 20
const EVIDENCE_ERRORS_KEPT = 50

/**
 * THE TENANT'S ANSWER (owner, wave 141: "A tenant attempting inbound import is REFUSED with a
 * clear sentence"). Tenant-facing copy: names who does run it and where their OWN CRM link
 * lives, and never says "platform-covered".
 */
const INBOUND_IMPORT_TENANT_REFUSAL =
  "Importing from an outside CRM into VIPAgents is run by VIPAgents staff during your onboarding, " +
  "not from your account — ask your onboarding contact to run the migration. Your own CRM " +
  "connection (Settings → Connections) syncs contacts OUT to your CRM only."

const INBOUND_IMPORT_LEGACY_MARKER_REFUSAL =
  "Inbound CRM import requires a platform staff seat recorded in platform_role; a legacy " +
  "user_type marker is not accepted for this operation."

/**
 * THE INBOUND RULE over the ONE staff gate. Every door below calls
 * `inboundImportGate(await gateStaffAction("tenants"))` FIRST — the gate call stays visible in
 * each body (scripts/tenant-scope-guard.ts recognises a platform gate that precedes the target
 * tenant's first service-client use; a wrapper would hide it). gateStaffAction resolves the
 * EFFECTIVE staff role (platform_role wins; the legacy user_type='superadmin' marker still
 * resolves — 0 live rows); this operation is ruled stricter: `platformRole` (the raw column)
 * must be set. A tenant (any user_type, no platform_role) gets the tenant sentence; an
 * unauthenticated caller gets "Unauthenticated". PURE — no second identity read.
 */
function inboundImportGate(gate: StaffGate): StaffGate {
  if (!gate.ok) return { ok: false, error: gate.error === "Unauthenticated" ? gate.error : INBOUND_IMPORT_TENANT_REFUSAL }
  if (!gate.platformRole) return { ok: false, error: INBOUND_IMPORT_LEGACY_MARKER_REFUSAL }
  return gate
}

/** Save a subscriber's old-CRM credential against THEIR brokerage. */
export async function setCrmImportCredentialAction(input: {
  brokerageId: string
  provider: CrmImportProvider
  apiKey: string
  apiUrl?: string
  locationId?: string
}): Promise<{ ok: boolean; error?: string }> {
  const gate = inboundImportGate(await gateStaffAction("tenants"))
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
    api_key: encryptSecret(apiKey), api_url: input.apiUrl?.trim() || null,
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

/** The subscriber's saved credential for one provider, decrypted for a pull. */
async function loadImportCredential(svc: any, brokerageId: string, provider: CrmImportProvider): Promise<
  | { ok: true; id: string; apiKey: string; apiUrl: string | null; locationId: string | null }
  | { ok: false; error: string }
> {
  const { data: cred, error } = await svc.from("platform_credentials")
    .select("id, api_key, api_url, config")
    .eq("brokerage_id", brokerageId).eq("platform", provider).eq("is_active", true).maybeSingle()
  if (error) return { ok: false, error: `Could not read the saved ${provider} credential: ${error.message}` }
  if (!cred?.api_key) {
    return { ok: false, error: `${provider} isn't connected for this brokerage yet — save their API key first.` }
  }
  return {
    ok: true,
    id: cred.id as string,
    apiKey: decryptSecret(cred.api_key) as string,
    apiUrl: (cred.api_url as string | null) ?? null,
    locationId: (cred.config?.location_id as string | undefined) ?? null,
  }
}

export interface CrmImportPreview {
  ok: boolean
  error?: string
  provider: CrmImportProvider
  /** Rows the first page returned (the preview inspects ONE page; the run paginates). */
  pageRows: number
  /** Rows that pass the registry identity rule — what a commit of this page would consider. */
  importable: number
  /** Of the importable rows, how many a commit would SKIP as duplicates of the tenant's book. */
  wouldSkipDuplicates: number
  /** …and how many it would land. */
  wouldInsert: number
  problemCount: number
  /** First PREVIEW_PROBLEMS_SHOWN row problems, by position in the page. */
  problems: CsvRowError[]
  /** THE EXPLICIT MAPPING — vendor/CSV key → canonical registry field. */
  mapping: Array<{ vendorKey: string; canonical: string }>
  /** Vendor keys that map to nothing in the registry (surfaced, never silently dropped). */
  ignoredKeys: string[]
  sample: Array<{ name: string; email: string | null; phone: string | null; cityState: string | null }>
  /** The provider reported another page beyond this one. */
  moreRemain: boolean
  /** Hand this to runCrmImportAction — the commit is refused without it. */
  previewToken: string | null
}

/**
 * PREVIEW — a dry run of the real lane on the first page (nothing written): the mapping
 * table, the ignored vendor keys, the validation outcome per row, the would-be duplicates
 * against the TARGET tenant and a sample, plus the token the commit must carry.
 */
export async function previewCrmImportAction(input: {
  brokerageId: string
  provider: CrmImportProvider
}): Promise<CrmImportPreview> {
  const empty: Omit<CrmImportPreview, "ok" | "error"> = {
    provider: input.provider, pageRows: 0, importable: 0, wouldSkipDuplicates: 0, wouldInsert: 0,
    problemCount: 0, problems: [], mapping: [], ignoredKeys: [], sample: [], moreRemain: false, previewToken: null,
  }
  const gate = inboundImportGate(await gateStaffAction("tenants"))
  if (!gate.ok) return { ok: false, error: gate.error, ...empty }
  if (!input.brokerageId) return { ok: false, error: "Target brokerage required", ...empty }
  if (!CRM_IMPORT_PROVIDERS.includes(input.provider)) return { ok: false, error: "Unknown provider", ...empty }

  const svc = createServiceClient()
  const cred = await loadImportCredential(svc, input.brokerageId, input.provider)
  if (!cred.ok) return { ok: false, error: cred.error, ...empty }

  const page = await pullCrmPage(input.provider, { apiKey: cred.apiKey, apiUrl: cred.apiUrl, locationId: cred.locationId }, null)
  if (page.error) {
    // The staff member sees the provider's own refusal — it is THEIR connection to fix.
    const { error: stampError } = await svc.from("platform_credentials")
      .update({ sync_error: page.error, updated_at: new Date().toISOString() }).eq("id", cred.id)
    if (stampError) console.error(`[crm-pull] preview error stamp on ${input.provider} credential was refused:`, stampError.message)
    return { ok: false, error: page.error, ...empty }
  }

  const parsed = parseContactRecords(page.rows)
  const mapping = Object.entries(parsed.mapping).map(([vendorKey, canonical]) => ({ vendorKey, canonical }))
  const previewToken = crmImportPreviewToken({
    provider: input.provider, brokerageId: input.brokerageId, mapping: parsed.mapping, ignoredKeys: parsed.unmappedHeaders,
  })

  // The dedupe half of the preview runs the SAME lane as the commit, with the insert held back.
  let wouldSkipDuplicates = 0
  let wouldInsert = 0
  let laneError: string | undefined
  if (parsed.rows.length > 0) {
    const dry = await importParsedContacts({
      svc, brokerageId: input.brokerageId, dedupe: "email_phone", importedBy: gate.userId,
      parsed, emptyLabel: `${input.provider} page`, dryRun: true,
    })
    if (!dry.ok && dry.error) laneError = dry.error
    wouldSkipDuplicates = dry.skippedDuplicates
    wouldInsert = dry.wouldInsert ?? 0
  }

  await auditStaffAction(gate, "crm_import_previewed", input.brokerageId, {
    provider: input.provider, pageRows: page.rows.length, importable: parsed.rows.length,
    problems: parsed.errors.length, wouldInsert, wouldSkipDuplicates, ignoredKeys: parsed.unmappedHeaders, previewToken,
  })

  return {
    ok: !laneError,
    error: laneError,
    provider: input.provider,
    pageRows: page.rows.length,
    importable: parsed.rows.length,
    wouldSkipDuplicates,
    wouldInsert,
    problemCount: parsed.errors.length,
    problems: parsed.errors.slice(0, PREVIEW_PROBLEMS_SHOWN),
    mapping,
    ignoredKeys: parsed.unmappedHeaders,
    sample: parsed.rows.slice(0, PREVIEW_SAMPLE_ROWS).map((r) => ({
      name: [r.firstName, r.lastName].filter(Boolean).join(" ") || "(no name)",
      email: r.email, phone: r.phone,
      cityState: [r.city, r.state].filter(Boolean).join(", ") || null,
    })),
    moreRemain: page.nextCursor !== null,
    previewToken,
  }
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
  /** The lead_imports evidence row this committed run wrote (the tenant sees it in their
   *  import history; LEAD_IMPORT_COMPLETED is emitted against it). Null when nothing was committed. */
  evidenceImportId: string | null
}

/**
 * CONTROLLED COMMIT — pull a subscriber's old CRM into THEIR tenant. Resumable via cursor.
 * Refused without the preview's token; the token is recomputed from the first page this run
 * pulls, so a mapping that changed since the preview stops the run before any row lands.
 */
export async function runCrmImportAction(input: {
  brokerageId: string
  provider: CrmImportProvider
  cursor?: string | null
  /** From previewCrmImportAction — binds this commit to the mapping that was previewed. */
  previewToken?: string | null
}): Promise<CrmImportRunResult> {
  const zero = { created: 0, skippedDuplicates: 0, failed: 0, pagesPulled: 0, nextCursor: null, evidenceImportId: null }
  const gate = inboundImportGate(await gateStaffAction("tenants"))
  if (!gate.ok) return { ok: false, error: gate.error, ...zero }
  if (!input.brokerageId) return { ok: false, error: "Target brokerage required", ...zero }
  if (!CRM_IMPORT_PROVIDERS.includes(input.provider)) return { ok: false, error: "Unknown provider", ...zero }
  if (!input.previewToken) {
    return { ok: false, error: "Preview the import first — the commit is bound to the field mapping you reviewed.", ...zero }
  }

  const svc = createServiceClient()
  const cred = await loadImportCredential(svc, input.brokerageId, input.provider)
  if (!cred.ok) return { ok: false, error: cred.error, ...zero }

  let cursor: string | null = input.cursor ?? null
  let created = 0, skippedDuplicates = 0, failed = 0, pages = 0, totalRows = 0
  let pullError: string | undefined
  let ownerAgentId: string | undefined
  let mappingSeen: Record<string, string> = {}
  const rowErrors: CsvRowError[] = []

  while (pages < MAX_PAGES_PER_RUN) {
    const page = await pullCrmPage(input.provider, { apiKey: cred.apiKey, apiUrl: cred.apiUrl, locationId: cred.locationId }, cursor)
    if (page.error) { pullError = page.error; break }

    if (page.rows.length > 0) {
      // Vendor rows are already shaped like that vendor's CSV export, so they run
      // through the SAME header aliases and the SAME row validation as an upload.
      const parsed = parseContactRecords(page.rows)

      // THE CONTROLLED COMMIT: the first page this run sees must map exactly as previewed.
      if (pages === 0) {
        const expected = crmImportPreviewToken({
          provider: input.provider, brokerageId: input.brokerageId, mapping: parsed.mapping, ignoredKeys: parsed.unmappedHeaders,
        })
        if (expected !== input.previewToken) {
          await auditStaffAction(gate, "crm_import_refused_stale_preview", input.brokerageId, { provider: input.provider })
          return {
            ok: false, ...zero,
            error: "The provider's field layout no longer matches the preview you reviewed — preview again before importing.",
          }
        }
        mappingSeen = parsed.mapping
      }

      totalRows += parsed.totalDataRows
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
      if (r.agentId) ownerAgentId = r.agentId
      for (const e of r.errors) if (rowErrors.length < EVIDENCE_ERRORS_KEPT) rowErrors.push({ line: e.line, problem: `page ${pages + 1}: ${e.problem}` })
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

  // STAMP THE CREDENTIAL THIS RUN JUST USED.
  //
  // WHAT WAS BROKEN. `platform_credentials.last_synced_at` and `sync_error` are
  // read by the connected-provider cards (app/dashboard/forms/page.tsx:70 →
  // FormsLibraryClient.tsx:327 "Synced N ago", and the integrations settings
  // surface) and were written by NOBODY — no trigger, no default, no seed on
  // the live table. This run is the one place in the repo where a sync against
  // a stored platform credential actually completes, so it is where the fact
  // becomes known. Without it the card could only ever say "connected", never
  // "connected and last pulled at …", which is the half a broker needs to tell
  // a working integration from a stale one.
  //
  // `sync_error` is written on the SAME line, null on a clean run — a stamp
  // that only ever records success would let a failed pull leave yesterday's
  // error sitting next to today's fresh timestamp.
  {
    const { error: stampError } = await svc.from("platform_credentials")
      .update({
        last_synced_at: new Date().toISOString(),
        sync_error: pullError ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cred.id)
    if (stampError) {
      console.error(`[crm-pull] sync stamp on ${input.provider} credential was refused:`, stampError.message)
    }
  }

  // EVIDENCE, THEN THE EVENT — only after the commit (owner: "controlled commit → only then
  // workflows/triggers fire"). The run writes the SAME lead_imports row the tenant's own CSV
  // import writes (one vocabulary: an import is an import; the tenant sees it in their Import
  // History with the provider named), and emits the SAME kernel event
  // (LEAD_IMPORT_COMPLETED → event-reactor → Data Steward → AI ISA signal). Nothing per
  // contact: a migrated book of 4,000 is not 4,000 "new contact" welcomes — the per-contact
  // automations (welcome, portal invite, enrichment) stay a deliberate owner decision, and the
  // reactor's import handler is the one that already knows an import happened.
  let evidenceImportId: string | null = null
  if (ownerAgentId && (created + skippedDuplicates + failed) > 0) {
    const now = new Date().toISOString()
    const { data: evidence, error: evidenceError } = await svc.from("lead_imports")
      .insert({
        brokerage_id: input.brokerageId,          // tenant anchor — the TARGET brokerage
        agent_id: ownerAgentId,                   // agents.id — the owner agent the rows were anchored to
        file_name: `${input.provider} migration${input.cursor ? " (continued)" : ""}`,
        total_rows: totalRows,
        field_map: mappingSeen,
        created_count: created,
        merged_count: 0,
        skipped_count: skippedDuplicates,
        failed_count: failed,
        error_details: rowErrors.length > 0 ? rowErrors.map((e) => ({ row: e.line, error: e.problem })) : null,
        status: created > 0 || !pullError ? "completed" : "failed",
        created_at: now,
        completed_at: now,
      })
      .select("id")
      .maybeSingle()
    if (evidenceError || !evidence) {
      console.error(`[crm-pull] lead_imports evidence row for ${input.provider} was refused:`, evidenceError?.message ?? "no row")
    } else {
      evidenceImportId = (evidence as { id: string }).id
      await emitKernelEvent({
        brokerageId: input.brokerageId,
        entityType: "lead_import",
        entityId: evidenceImportId,
        event: KernelEvent.LEAD_IMPORT_COMPLETED,
        actorUserId: gate.userId,
        metadata: {
          created, merged: 0, failed, total: totalRows, skippedDuplicates,
          provider: input.provider, source: "crm_pull", resumed: Boolean(input.cursor), pagesPulled: pages,
        },
      })
    }
  }

  await auditStaffAction(gate, "crm_import_run", input.brokerageId, {
    provider: input.provider, created, skippedDuplicates, failed,
    pagesPulled: pages, resumed: Boolean(input.cursor), error: pullError ?? null, evidenceImportId,
  })

  return {
    ok: pages > 0 || !pullError,
    error: pullError,
    created, skippedDuplicates, failed,
    pagesPulled: pages, nextCursor: cursor,
    evidenceImportId,
  }
}

/** Which providers have a saved credential for this subscriber (for the panel). */
export async function getCrmImportStatusAction(
  brokerageId: string,
): Promise<{ ok: boolean; connected: string[] }> {
  const gate = inboundImportGate(await gateStaffAction("tenants"))
  if (!gate.ok || !brokerageId) return { ok: false, connected: [] }
  const svc = createServiceClient()
  const { data } = await svc.from("platform_credentials").select("platform")
    .eq("brokerage_id", brokerageId).in("platform", CRM_IMPORT_PROVIDERS as unknown as string[]).eq("is_active", true)
  return { ok: true, connected: ((data ?? []) as any[]).map((r) => r.platform) }
}
