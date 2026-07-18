// lib/platform/tenant-import.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT DATA IMPORT — the inbound mirror of lib/platform/tenant-export.ts and
// the GHL-parity white-glove migration lever: platform staff land a new
// subscriber's CSV book of business (contacts, optionally draft listings)
// directly into the TARGET tenant from the god console.
//
// Anchoring rules (verified against the live schema snapshot + kernel writers):
//   - contacts.agent_id / listings.agent_id store agents.id — NOT users.id
//     (lib/kernel/crm.ts header, lib/lead-assignment/contact-assignment.ts,
//     migration 111). The default owner is the tenant's owner agents row:
//     earliest-created ACTIVE agents row for the brokerage (the same row the
//     solo_agent shortcut in resolveAgentForContact picks).
//   - Every inserted row is stamped with the TARGET brokerage_id.
//   - contacts.status/lifecycle stay on DB defaults (kernel-managed state
//     machines a foreign CRM must not fight); tcpa_consent is NEVER imported
//     as true (consent is earned on our rail, not claimed by a CSV).
//   - listings land as status:'draft' (valid per listings_status_check —
//     scripts/update-listings-status-check.sql, applied live).
//
// Honesty rules: per-row errors carry the source file line number; a failed
// batch is retried row-by-row so one bad row never silently sinks 199 good
// ones; dedupe skips are counted, never silently swallowed.

import {
  parseContactsCsv, parseListingsCsv, type CsvRowError,
} from "@/lib/platform/tenant-import-parser"

export {
  parseContactsCsv, parseListingsCsv,
  type CsvRowError, type ParsedContactRow, type ParsedListingRow,
  type ParseContactsCsvResult, type ParseListingsCsvResult,
} from "@/lib/platform/tenant-import-parser"

const BATCH_SIZE = 200
const DEDUPE_PAGE = 1000
const DEDUPE_MAX_PAGES = 200 // 200k existing contacts scanned for dedupe, hard bound

export type ImportDedupeMode = "email_phone" | "none"

export interface TenantImportResult {
  ok: boolean
  /** Fatal, pre-insert failure (brokerage missing, no agent, unusable CSV). */
  error?: string
  inserted: number
  skippedDuplicates: number
  /** Per-row problems — parse rejections AND insert failures, by file line. */
  errors: CsvRowError[]
  /** Total data rows found in the CSV (inserted + skipped + errored = this). */
  totalDataRows: number
  /** agents.id every imported row was anchored to (when resolution succeeded). */
  agentId?: string
}

// ─── Shared resolution helpers ───────────────────────────────────────────────

/** Verify the target brokerage exists. Returns an error string or null. */
async function verifyBrokerage(svc: any, brokerageId: string): Promise<string | null> {
  const { data, error } = await svc.from("brokerages").select("id").eq("id", brokerageId).maybeSingle()
  if (error) return `Brokerage lookup failed: ${error.message}`
  if (!data) return "Brokerage not found"
  return null
}

/**
 * Resolve the agents.id every imported row is anchored to. An explicit agentId
 * is verified to belong to the TARGET brokerage (cross-tenant anchoring is
 * refused, not trusted); otherwise the tenant's owner agents row — the
 * earliest-created active agent — is used, falling back to the earliest agent
 * of any status for tenants provisioned but not yet activated.
 */
async function resolveImportAgent(
  svc: any, brokerageId: string, agentId?: string | null,
): Promise<{ agentId?: string; error?: string }> {
  if (agentId) {
    const { data, error } = await svc
      .from("agents").select("id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { error: `Agent lookup failed: ${error.message}` }
    if (!data) return { error: "agentId does not belong to the target brokerage" }
    return { agentId: data.id as string }
  }
  const { data: active, error: activeErr } = await svc
    .from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true)
    .order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (activeErr) return { error: `Agent lookup failed: ${activeErr.message}` }
  if (active?.id) return { agentId: active.id as string }
  const { data: anyAgent, error: anyErr } = await svc
    .from("agents").select("id").eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (anyErr) return { error: `Agent lookup failed: ${anyErr.message}` }
  if (anyAgent?.id) return { agentId: anyAgent.id as string }
  return { error: "Tenant has no agents row to anchor imported records to — provision the owner's agent profile first" }
}

/**
 * Insert rows in batches with per-batch {error} checks. A failed batch is
 * retried ROW BY ROW so exactly the offending rows are reported (by file line)
 * and every good row still lands. Returns inserted count + per-row errors.
 */
async function insertInBatches(
  svc: any, table: string, payloads: { line: number; payload: Record<string, unknown> }[],
): Promise<{ inserted: number; errors: CsvRowError[] }> {
  let inserted = 0
  const errors: CsvRowError[] = []
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE)
    const { error } = await svc.from(table).insert(batch.map((b) => b.payload))
    if (!error) { inserted += batch.length; continue }
    // Batch failed — isolate the offenders so good rows are never lost with them.
    for (const row of batch) {
      const { error: rowErr } = await svc.from(table).insert(row.payload)
      if (rowErr) errors.push({ line: row.line, problem: `Insert failed: ${rowErr.message}` })
      else inserted += 1
    }
  }
  return { inserted, errors }
}

// ─── Contacts import ─────────────────────────────────────────────────────────

/**
 * Import a CSV of contacts into the TARGET brokerage.
 *  - dedupe 'email_phone': skips rows whose normalized email OR phone digits
 *    match an existing (non-deleted) contact of the tenant — or an earlier row
 *    in the same file. 'none' imports everything that parses.
 *  - Every row: brokerage_id = target, agent_id = resolved owner agent,
 *    source = 'import' (CSV's own source value preserved as source_subtype),
 *    metadata = { imported_at, imported_by }.
 */
export async function importContacts(params: {
  svc: any
  brokerageId: string
  agentId?: string | null
  csvText: string
  dedupe: ImportDedupeMode
  /** users.id of the platform actor — stamped into metadata.imported_by. */
  importedBy?: string | null
}): Promise<TenantImportResult> {
  const { svc, brokerageId } = params
  const parsed = parseContactsCsv(params.csvText)
  const base: TenantImportResult = {
    ok: false, inserted: 0, skippedDuplicates: 0,
    errors: [...parsed.errors], totalDataRows: parsed.totalDataRows,
  }
  if (parsed.rows.length === 0) {
    return { ...base, error: parsed.errors.length > 0 ? "No importable rows in CSV" : "CSV has no data rows" }
  }

  const brkErr = await verifyBrokerage(svc, brokerageId)
  if (brkErr) return { ...base, error: brkErr }

  const agent = await resolveImportAgent(svc, brokerageId, params.agentId)
  if (!agent.agentId) return { ...base, error: agent.error }

  // Existing-tenant dedupe keys (email + phone digits), paged with {error} checks.
  const seenEmails = new Set<string>()
  const seenPhones = new Set<string>()
  if (params.dedupe === "email_phone") {
    for (let page = 0; page < DEDUPE_MAX_PAGES; page++) {
      const { data, error } = await svc
        .from("contacts").select("email, phone_digits")
        .eq("brokerage_id", brokerageId).is("deleted_at", null)
        .range(page * DEDUPE_PAGE, page * DEDUPE_PAGE + DEDUPE_PAGE - 1)
      if (error) return { ...base, error: `Existing-contact scan failed: ${error.message}` }
      for (const c of (data ?? []) as { email: string | null; phone_digits: string | null }[]) {
        if (c.email) seenEmails.add(c.email.trim().toLowerCase())
        if (c.phone_digits) seenPhones.add(c.phone_digits)
      }
      if ((data ?? []).length < DEDUPE_PAGE) break
    }
  }

  const now = new Date().toISOString()
  const metadata = { imported_at: now, imported_by: params.importedBy ?? null }
  let skippedDuplicates = 0
  const payloads: { line: number; payload: Record<string, unknown> }[] = []

  for (const r of parsed.rows) {
    if (params.dedupe === "email_phone") {
      const dupEmail = r.email !== null && seenEmails.has(r.email)
      const dupPhone = r.phoneDigits !== null && seenPhones.has(r.phoneDigits)
      if (dupEmail || dupPhone) { skippedDuplicates += 1; continue }
      // In-file dedupe: later rows repeating this row's identity are skips too.
      if (r.email) seenEmails.add(r.email)
      if (r.phoneDigits) seenPhones.add(r.phoneDigits)
    }
    payloads.push({
      line: r.line,
      payload: {
        brokerage_id: brokerageId,          // tenant anchor — the TARGET brokerage
        agent_id: agent.agentId,            // agents.id (owner agent), NOT users.id
        first_name: r.firstName ?? "",      // NOT NULL live — empty, never fabricated
        last_name: r.lastName,
        email: r.email,
        phone: r.phone,
        phone_digits: r.phoneDigits,
        address: r.address,
        city: r.city,
        state: r.state,
        zip_code: r.zip,
        source: "import",
        source_subtype: r.source,           // the old CRM's own source label, preserved
        notes: r.notes,
        tags: r.tags,
        tcpa_consent: false,                // a CSV's consent claim is not our proof
        metadata,
        created_at: now,
        updated_at: now,
      },
    })
  }

  if (payloads.length === 0) {
    return { ...base, ok: true, skippedDuplicates, agentId: agent.agentId }
  }

  const { inserted, errors: insertErrors } = await insertInBatches(svc, "contacts", payloads)
  return {
    ok: true, inserted, skippedDuplicates,
    errors: [...parsed.errors, ...insertErrors].sort((a, b) => a.line - b.line),
    totalDataRows: parsed.totalDataRows, agentId: agent.agentId,
  }
}

// ─── Listings import (minimal draft shape) ───────────────────────────────────

/**
 * Import a CSV of listings as DRAFTS into the TARGET brokerage. Minimal shape
 * only — address (NOT NULL) / city / state / zip / list_price / listing_date /
 * mls_number, status:'draft', created_via:'import'. No lifecycle_stage is set
 * (the m239 trigger + kernel own the state machine from draft onward).
 */
export async function importListings(params: {
  svc: any
  brokerageId: string
  agentId?: string | null
  csvText: string
  importedBy?: string | null
}): Promise<TenantImportResult> {
  const { svc, brokerageId } = params
  const parsed = parseListingsCsv(params.csvText)
  const base: TenantImportResult = {
    ok: false, inserted: 0, skippedDuplicates: 0,
    errors: [...parsed.errors], totalDataRows: parsed.totalDataRows,
  }
  if (parsed.rows.length === 0) {
    return { ...base, error: parsed.errors.length > 0 ? "No importable rows in CSV" : "CSV has no data rows" }
  }

  const brkErr = await verifyBrokerage(svc, brokerageId)
  if (brkErr) return { ...base, error: brkErr }

  const agent = await resolveImportAgent(svc, brokerageId, params.agentId)
  if (!agent.agentId) return { ...base, error: agent.error }

  const now = new Date().toISOString()
  const metadata = { imported_at: now, imported_by: params.importedBy ?? null }
  const payloads = parsed.rows.map((r) => ({
    line: r.line,
    payload: {
      brokerage_id: brokerageId,            // tenant anchor — the TARGET brokerage
      agent_id: agent.agentId,              // agents.id, same FK class as contacts
      address: r.address,
      city: r.city,
      state: r.state,
      zip: r.zip,
      list_price: r.listPrice,
      listing_date: r.listingDate,
      mls_number: r.mlsNumber,
      status: "draft",                      // valid per listings_status_check
      created_via: "import",
      metadata,
      created_at: now,
      updated_at: now,
    } as Record<string, unknown>,
  }))

  const { inserted, errors: insertErrors } = await insertInBatches(svc, "listings", payloads)
  return {
    ok: true, inserted, skippedDuplicates: 0,
    errors: [...parsed.errors, ...insertErrors].sort((a, b) => a.line - b.line),
    totalDataRows: parsed.totalDataRows, agentId: agent.agentId,
  }
}
