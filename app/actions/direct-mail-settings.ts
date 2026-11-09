"use server"

/**
 * app/actions/direct-mail-settings.ts
 *
 * Wave 36 — server actions for the Direct Mail Settings page.
 * Two concerns: brokerage-level farm-mail config + per-tenant
 * competitor watchlist CRUD.
 *
 * All actions gated through resolvePolicyScopeAccess so a brokerage
 * admin can only edit their own row + their own watchlist. No
 * cross-tenant writes possible.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { appendTenantPolicyVersion, FARM_MAIL_POLICY_KEY, farmMailPolicyValue } from "@/lib/kernel/tenant-policy"
import { senderAddressShapeRefusal, decideSenderAddress } from "@/lib/providers/mailing-cass-gate"
import { pickSenderAddressRow, senderAddressFromRow, type SenderAddressRow } from "@/lib/direct-mail/piece-type"

export interface FarmMailConfig {
  farm_mail_enabled:        boolean
  farm_mail_max_per_week:   number | null
  lob_fallback_template_id: string | null
}

/** What the Settings page shows about the tenant's SENDER address (wave 151, lane 151H): the rows, and which one a
 *  brokerage-direct send would use today (or why none would — the refusal the send would raise). */
export interface SenderAddressSettings {
  rows: SenderAddressRow[]
  effective: { source: string; line: string; verified: boolean } | null
  refusal: string | null
  /** LOB_API_KEY is configured (by NAME only): a saved address can be CASS-verified now. */
  canVerify: boolean
}

export interface CompetitorWatchlistEntry {
  id:                  string
  competitor_name:     string
  facebook_page_id:    string | null
  google_advertiser_id: string | null
  watch_zip_codes:     string[] | null
  min_engagement_score: number | null
  is_active:           boolean
}

/** Read the brokerage's current farm-mail config + competitor watchlist + sender addresses. */
export async function getDirectMailSettings(): Promise<{
  success:  true
  config:   FarmMailConfig
  watchlist: CompetitorWatchlistEntry[]
  sender:   SenderAddressSettings
} | { success: false; error: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  const brokerageId = access.brokerageScopeId

  const [brokerageR, watchlistR, senderR] = await Promise.all([
    svc.from("brokerages")
      .select("farm_mail_enabled, farm_mail_max_per_week, lob_fallback_template_id")
      .eq("id", brokerageId)
      .maybeSingle(),
    svc.from("competitor_brokerages")
      .select("id, competitor_name, facebook_page_id, google_advertiser_id, watch_zip_codes, min_engagement_score, is_active")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false }),
    svc.from("direct_mail_sender_addresses")
      .select("id, brokerage_id, scope_type, scope_id, label, name, line1, line2, city, state, zip, cass_deliverability, cass_verified_at, approved_by_user_id, approved_at, is_default, status")
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .order("created_at", { ascending: false }),
  ])

  const config = (brokerageR.data ?? {
    farm_mail_enabled: false,
    farm_mail_max_per_week: null,
    lob_fallback_template_id: null,
  }) as FarmMailConfig
  const watchlist = (watchlistR.data ?? []) as CompetitorWatchlistEntry[]

  // Wave 151 (151H): the tenant's sender addresses and which one a brokerage-direct send resolves to TODAY, judged by the
  // same gate the dispatcher uses — so the page tells the admin exactly what a send would say. A refused read (m980 not yet
  // applied) is said, never read as "no addresses".
  if (senderR.error) console.error(`[direct-mail-settings] sender addresses read refused: ${senderR.error.message}`)
  const rows = (senderR.error ? [] : (senderR.data ?? [])) as SenderAddressRow[]
  const picked = pickSenderAddressRow(rows, { brokerageId })
  const decision = decideSenderAddress(picked ? senderAddressFromRow(picked.row, picked.source) : null, { platformLobAddressId: process.env.LOB_RETURN_ADDRESS_ID })
  const sender: SenderAddressSettings = {
    rows,
    effective: decision.ok ? { source: decision.source, line: `${decision.from.name} · ${decision.from.address_line1}, ${decision.from.address_city}, ${decision.from.address_state} ${decision.from.address_zip}`, verified: !!decision.evidence.verifiedAt } : null,
    refusal: decision.ok ? null : (senderR.error ? `sender addresses could not be read (${senderR.error.message})` : `${decision.code}: ${decision.reason}`),
    canVerify: !!process.env.LOB_API_KEY,
  }

  return { success: true, config, watchlist, sender }
}

// ─── SENDER (RETURN) ADDRESSES — wave 151, lane 151H ─────────────────────────
// Owner: "the rendered pieces should not use the platform return address". The tenant configures its own return address(es)
// here: one default for the tenant, optionally one per team or per sending user ("another address expressly approved for the
// actual sender"). Each is CASS-verified once (Lob US verification — the same adapter the recipient gate uses; metered) and
// APPROVED by a tenant admin before any piece carries it. The tenant comes from the policy scope (the session), never the body.

export interface SenderAddressInput {
  id?: string | null
  scope_type: "brokerage" | "team" | "user"
  /** teams.id or users.id for team / user scope; ignored for brokerage scope (the tenant is the session's). */
  scope_id?: string | null
  label?: string | null
  name: string
  line1: string
  line2?: string | null
  city: string
  state: string
  zip: string
}

/** Save (insert or update) a sender address for a scope in the caller's tenant, verifying it with Lob when a key is present. */
export async function saveSenderAddress(input: SenderAddressInput): Promise<{ success: true; row: SenderAddressRow; verified: boolean; deliverability: string | null } | { success: false; error: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) return { success: false, error: "Brokerage admin scope required" }
  const caller = await requireCallerTenant()
  if (!caller.ok) return { success: false, error: caller.error }
  const brokerageId = access.brokerageScopeId

  const shape = senderAddressShapeRefusal({ name: input.name, line1: input.line1, line2: input.line2 ?? null, city: input.city, state: input.state, zip: input.zip }, { platformLobAddressId: process.env.LOB_RETURN_ADDRESS_ID })
  if (shape) return { success: false, error: shape.reason }

  const svc = createServiceClient()
  // Scope ownership: a team or user scope must belong to THIS tenant (never a body-supplied id across tenants).
  let scopeId = brokerageId
  if (input.scope_type === "team") {
    if (!input.scope_id) return { success: false, error: "A team scope needs the team's id" }
    const { data: t, error } = await svc.from("teams").select("id").eq("id", input.scope_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { success: false, error: `Could not verify the team: ${error.message}` }
    if (!t) return { success: false, error: "That team is not in your brokerage" }
    scopeId = input.scope_id
  } else if (input.scope_type === "user") {
    if (!input.scope_id) return { success: false, error: "A user scope needs the sending user's id (users.id)" }
    const { data: u, error } = await svc.from("users").select("id").eq("id", input.scope_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { success: false, error: `Could not verify the user: ${error.message}` }
    if (!u) return { success: false, error: "That user is not in your brokerage — the scope takes a users id, not an agents id" }
    scopeId = input.scope_id
  }

  // CASS once, at save time (the recipient gate's own adapter; the verification is metered like every Lob verify).
  let cass: { deliverability: string | null; at: string } | null = null
  let line1 = input.line1.trim(), city = input.city.trim(), state = input.state.trim().toUpperCase(), zip = input.zip.trim()
  try {
    const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
    const { data: lob, cost } = await verifyAddressViaLob({ primary_line: line1, secondary_line: input.line2?.trim() || undefined, city, state, zip_code: zip, recipient: input.name.trim() })
    if (cost > 0) {
      try {
        const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
        await meterVendorSpend({ vendorName: "lob", usageType: "address_verify", cost, brokerageId, systemSource: "direct_mail_sender_settings", metadata: { purpose: "sender_return_address", result: lob?.deliverability ?? "unavailable" } })
      } catch { /* metering never breaks the save */ }
    }
    if (lob) {
      cass = { deliverability: lob.deliverability, at: new Date().toISOString() }
      if (lob.standardized?.primary_line) line1 = lob.standardized.primary_line
      if (lob.standardized?.city) city = lob.standardized.city
      if (lob.standardized?.state) state = lob.standardized.state
      if (lob.standardized?.zip_code) zip = lob.standardized.zip_code
    }
  } catch (e) {
    console.error(`[direct-mail-settings] sender address verification threw: ${(e as Error)?.message ?? String(e)}`)
  }

  const row = {
    brokerage_id: brokerageId, scope_type: input.scope_type, scope_id: scopeId, label: input.label?.trim() || null,
    name: input.name.trim(), line1, line2: input.line2?.trim() || null, city, state, zip,
    cass_deliverability: cass?.deliverability ?? null, cass_verified_at: cass?.at ?? null, cass_source: cass ? "lob_cass" : null,
    // Any change un-approves: the admin approves what was verified, not what was typed before.
    approved_by_user_id: null, approved_at: null,
    status: "active", updated_at: new Date().toISOString(),
  }
  // The policy history's "previous" (LAW 5): the row as it stood before this save — null for a new address.
  let previous: SenderAddressRow | null = null
  if (input.id) {
    const { data: prior, error: priorErr } = await svc.from("direct_mail_sender_addresses").select(SENDER_ADDRESS_COLUMNS).eq("id", input.id).eq("brokerage_id", brokerageId).maybeSingle()
    if (priorErr) return { success: false, error: `Could not read the address being changed: ${priorErr.message}` }
    if (!prior) return { success: false, error: "That address is not in your brokerage" }
    previous = prior as SenderAddressRow
  }
  const q = input.id
    ? svc.from("direct_mail_sender_addresses").update(row).eq("id", input.id).eq("brokerage_id", brokerageId)
    : svc.from("direct_mail_sender_addresses").insert({ ...row, created_by_user_id: caller.userId })
  const { data, error } = await q.select(SENDER_ADDRESS_COLUMNS).maybeSingle()
  if (error) return { success: false, error: error.code === "PGRST204" || /does not exist/.test(error.message) ? `The sender-address table is not applied yet (m980): ${error.message}` : error.message }
  if (!data) return { success: false, error: "The sender address was not saved (no row returned — a refused tenant predicate, not a success)" }
  // LAW 5 — the tenant's return address is operating policy: one version per change, who and why (lib/kernel/tenant-policy.ts).
  const v = await appendTenantPolicyVersion(svc, {
    brokerageId, policyKey: SENDER_ADDRESS_POLICY_KEY,
    value: senderAddressPolicyValue(data as SenderAddressRow), previous: senderAddressPolicyValue(previous),
    actor: { type: "user", userId: caller.userId, reason: input.id ? "direct-mail sender address changed (approval cleared)" : "direct-mail sender address added" },
  })
  if (!v.ok) console.error(`[direct-mail-settings] sender-address policy version not recorded: ${v.error}`)
  revalidatePath("/settings/direct-mail")
  return { success: true, row: data as SenderAddressRow, verified: !!cass, deliverability: cass?.deliverability ?? null }
}

/** The columns every sender-address read selects (one list, so a read-back and a policy value never disagree). */
const SENDER_ADDRESS_COLUMNS = "id, brokerage_id, scope_type, scope_id, label, name, line1, line2, city, state, zip, cass_deliverability, cass_verified_at, approved_by_user_id, approved_at, is_default, status"

/** The registered tenant policy key (lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS). */
const SENDER_ADDRESS_POLICY_KEY = "direct_mail_sender_address"

/** PURE — the policy value a sender-address row is versioned as (the address, its scope, its CASS verdict, its approver). */
function senderAddressPolicyValue(row: SenderAddressRow | null): Record<string, unknown> | null {
  if (!row) return null
  return {
    id: row.id, scope_type: row.scope_type, scope_id: row.scope_id, label: row.label ?? null,
    name: row.name, line1: row.line1, line2: row.line2 ?? null, city: row.city, state: row.state, zip: row.zip,
    cass_deliverability: row.cass_deliverability ?? null, approved_by_user_id: row.approved_by_user_id ?? null, approved_at: row.approved_at ?? null,
    is_default: row.is_default ?? false, status: row.status,
  }
}

/** Approve a VERIFIED, deliverable sender address for its scope. Approval is the evidence a piece may carry it. */
export async function approveSenderAddress(id: string): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) return { success: false, error: "Brokerage admin scope required" }
  const caller = await requireCallerTenant()
  if (!caller.ok) return { success: false, error: caller.error }
  const svc = createServiceClient()
  const { data: row, error: readErr } = await svc.from("direct_mail_sender_addresses")
    .select("id, brokerage_id, scope_type, scope_id, label, name, line1, line2, city, state, zip, cass_deliverability, cass_verified_at, approved_by_user_id, approved_at, is_default, status")
    .eq("id", id).eq("brokerage_id", access.brokerageScopeId).maybeSingle()
  if (readErr) return { success: false, error: `Could not read the address: ${readErr.message}` }
  if (!row) return { success: false, error: "That address is not in your brokerage" }
  // The same gate the dispatcher applies — an address that would be refused at send time cannot be approved.
  const decision = decideSenderAddress(senderAddressFromRow(row as SenderAddressRow, "tenant_return_address"), { platformLobAddressId: process.env.LOB_RETURN_ADDRESS_ID })
  if (!decision.ok) return { success: false, error: `Not approved — ${decision.reason}` }
  const { data, error } = await svc.from("direct_mail_sender_addresses")
    .update({ approved_by_user_id: caller.userId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).eq("brokerage_id", access.brokerageScopeId).select(SENDER_ADDRESS_COLUMNS)
  if (error) return { success: false, error: error.message }
  if (!Array.isArray(data) || data.length === 0) return { success: false, error: "No row was approved (refused tenant predicate)" }
  // LAW 5 — the approval is the evidence a piece may carry this address under; versioned with its approver.
  const v = await appendTenantPolicyVersion(svc, {
    brokerageId: access.brokerageScopeId, policyKey: SENDER_ADDRESS_POLICY_KEY,
    value: senderAddressPolicyValue(data[0] as SenderAddressRow), previous: senderAddressPolicyValue(row as SenderAddressRow),
    actor: { type: "user", userId: caller.userId, reason: "direct-mail sender address approved (CASS-verified, deliverable)" },
  })
  if (!v.ok) console.error(`[direct-mail-settings] sender-address policy version not recorded: ${v.error}`)
  revalidatePath("/settings/direct-mail")
  return { success: true }
}

/** Make an approved address the default for its scope (one default per scope — the partial unique index holds it). */
export async function setDefaultSenderAddress(id: string): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) return { success: false, error: "Brokerage admin scope required" }
  const svc = createServiceClient()
  const { data: row, error: readErr } = await svc.from("direct_mail_sender_addresses").select("id, scope_type, scope_id, approved_at").eq("id", id).eq("brokerage_id", access.brokerageScopeId).maybeSingle()
  if (readErr) return { success: false, error: `Could not read the address: ${readErr.message}` }
  if (!row) return { success: false, error: "That address is not in your brokerage" }
  if (!(row as { approved_at: string | null }).approved_at) return { success: false, error: "Approve the address before making it the default" }
  const r = row as { scope_type: string; scope_id: string }
  const { error: clearErr } = await svc.from("direct_mail_sender_addresses").update({ is_default: false }).eq("brokerage_id", access.brokerageScopeId).eq("scope_type", r.scope_type).eq("scope_id", r.scope_id).eq("is_default", true)
  if (clearErr) return { success: false, error: clearErr.message }
  const { data, error } = await svc.from("direct_mail_sender_addresses").update({ is_default: true, updated_at: new Date().toISOString() }).eq("id", id).eq("brokerage_id", access.brokerageScopeId).select("id")
  if (error) return { success: false, error: error.message }
  if (!Array.isArray(data) || data.length === 0) return { success: false, error: "No row was updated (refused tenant predicate)" }
  revalidatePath("/settings/direct-mail")
  return { success: true }
}

/** Retire an address (soft: the audit trail of pieces that carried it survives). */
export async function retireSenderAddress(id: string): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) return { success: false, error: "Brokerage admin scope required" }
  const svc = createServiceClient()
  const { data, error } = await svc.from("direct_mail_sender_addresses").update({ status: "retired", is_default: false, updated_at: new Date().toISOString() }).eq("id", id).eq("brokerage_id", access.brokerageScopeId).select("id")
  if (error) return { success: false, error: error.message }
  if (!Array.isArray(data) || data.length === 0) return { success: false, error: "No row was retired (refused tenant predicate, or already gone)" }
  revalidatePath("/settings/direct-mail")
  return { success: true }
}

export async function saveFarmMailConfig(input: {
  farm_mail_enabled:        boolean
  farm_mail_max_per_week:   number | null
  lob_fallback_template_id: string | null
}): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }

  // Validate: if enabling, must have a fallback template
  if (input.farm_mail_enabled && !input.lob_fallback_template_id?.trim()) {
    return {
      success: false,
      error: "A Lob fallback template id is required to enable farm mail (it's the safety net when the AI copy gate fails).",
    }
  }
  // Cap sanity: 1-200 contacts per agent per week
  const cap = input.farm_mail_max_per_week
  if (cap !== null && (cap < 1 || cap > 200)) {
    return { success: false, error: "Max per week must be between 1 and 200 contacts." }
  }

  // 102D — the version's actor is the SESSION user (requireCallerTenant; the scope gate above
  // carries no userId). Farm mail is a communication limit: tenant operating policy, versioned.
  const caller = await requireCallerTenant()
  if (!caller.ok) return { success: false, error: caller.error }

  const svc = createServiceClient()
  const { data: before, error: beforeErr } = await svc.from("brokerages")
    .select("farm_mail_enabled, farm_mail_max_per_week, lob_fallback_template_id")
    .eq("id", access.brokerageScopeId)
    .maybeSingle()
  if (beforeErr) return { success: false, error: `Current farm-mail config could not be read: ${beforeErr.message}` }
  const next = {
    farm_mail_enabled:        input.farm_mail_enabled,
    farm_mail_max_per_week:   input.farm_mail_max_per_week,
    lob_fallback_template_id: input.lob_fallback_template_id?.trim() || null,
  }
  const { error } = await svc.from("brokerages")
    .update(next)
    .eq("id", access.brokerageScopeId)
  if (error) return { success: false, error: error.message }
  const v = await appendTenantPolicyVersion(svc, {
    brokerageId: access.brokerageScopeId, policyKey: FARM_MAIL_POLICY_KEY,
    value: farmMailPolicyValue(next), previous: farmMailPolicyValue(before as Record<string, unknown> | null),
    actor: { type: "user", userId: caller.userId, reason: "farm mail config saved" },
  })
  if (!v.ok) console.error(`[direct-mail-settings] policy version not recorded: ${v.error}`)

  revalidatePath("/settings/direct-mail")
  return { success: true }
}

export async function addCompetitorToWatchlist(input: {
  competitor_name:      string
  facebook_page_id?:    string | null
  google_advertiser_id?: string | null
  watch_zip_codes?:     string[] | null
  min_engagement_score?: number | null
}): Promise<{ success: boolean; entryId?: string; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const name = input.competitor_name.trim()
  if (!name) return { success: false, error: "Competitor name required" }
  if (input.min_engagement_score !== undefined && input.min_engagement_score !== null) {
    if (input.min_engagement_score < 0 || input.min_engagement_score > 100) {
      return { success: false, error: "Engagement score threshold must be 0-100." }
    }
  }

  const svc = createServiceClient()
  const { data, error } = await svc.from("competitor_brokerages")
    .insert({
      brokerage_id:         access.brokerageScopeId,
      competitor_name:      name,
      facebook_page_id:     input.facebook_page_id?.trim() || null,
      google_advertiser_id: input.google_advertiser_id?.trim() || null,
      watch_zip_codes:      input.watch_zip_codes ?? null,
      min_engagement_score: input.min_engagement_score ?? null,
      is_active:            true,
    })
    .select("id")
    .single()
  if (error) {
    // unique (brokerage_id, competitor_name) → friendly message
    if (error.code === "23505") {
      return { success: false, error: `"${name}" is already on the watchlist.` }
    }
    return { success: false, error: error.message }
  }

  revalidatePath("/settings/direct-mail")
  return { success: true, entryId: data.id as string }
}

export async function removeCompetitorFromWatchlist(entryId: string): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  // Soft-delete via is_active=false so the audit trail (which ads
  // came from which watchlist row) survives. Promoter only reads
  // is_active=true rows so the entry stops sourcing new ads
  // immediately.
  const { error } = await svc.from("competitor_brokerages")
    .update({ is_active: false })
    .eq("id", entryId)
    .eq("brokerage_id", access.brokerageScopeId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/direct-mail")
  return { success: true }
}
