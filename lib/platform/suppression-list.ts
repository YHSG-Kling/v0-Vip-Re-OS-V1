/**
 * PLATFORM SUPPRESSION LIST
 *
 * Cross-tenant DNC enforcement. Once a phone or email lands here, NO subscriber
 * may contact this person via any channel. Writes happen on:
 *  - Explicit opt-out detected by ISA ("stop", "do not contact", etc.)
 *  - TCPA violation flagged
 *  - Federal DNC import
 *  - Spam complaint received
 *  - Litigator pattern detected
 *  - Manual super-admin add
 *
 * Reads happen before:
 *  - Engine 1 distribution (won't hand out a suppressed lead)
 *  - Any outbound channel attempt (email/SMS/call/direct mail)
 */

import { createServiceClient } from "@/lib/supabase/service"

type SuppressionReason =
  | "explicit_opt_out"
  | "tcpa_violation"
  | "federal_dnc"
  | "spam_complaint"
  | "litigator"
  | "manual_admin"

function normalizePhoneDigits(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, "")
  if (digits.length < 10) return null
  return digits.slice(-10)
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null
  return String(email).trim().toLowerCase()
}

/** The client a read rides — the service client by default; an in-memory client in a proof (wave 150). */
type PlatformSuppressionClient = { from: (table: string) => any }

/**
 * WAVE 150 (lane 150U — FAIL CLOSED, CLAUDE.md §3/§4). Both readers below were `const { data } = await …`: a REFUSED read
 * resolved to `data: null`, which read as "not on the list", so the distribution engine handed out — and the prospect
 * follow-up and the predictive auto-send contacted — a person the platform had suppressed, on exactly the day the list
 * could not be read. "Nobody checked" must never render as "checked and fine": a refusal answers SUPPRESSED, and says so.
 * (The per-send gate every sender rides is lib/kernel/compliance/check-suppression.ts checkSuppression, which reads this
 * same table with the same normalisation; these two are the tenant-less questions asked BEFORE a tenant is chosen.)
 */
async function platformListHas(column: "phone_digits" | "email", value: string, client?: PlatformSuppressionClient): Promise<boolean> {
  const supabase = client ?? createServiceClient()
  const { data, error } = await supabase
    .from("platform_suppression_list")
    .select("id")
    .eq(column, value)
    .limit(1)
  if (error) {
    console.error(`[platform-suppression] ${column} read refused — answering SUPPRESSED (fail closed): ${error.message}`)
    return true
  }
  return Array.isArray(data) && data.length > 0
}

export async function isPhoneOnSuppressionList(phoneDigits: string, client?: PlatformSuppressionClient): Promise<boolean> {
  const normalized = normalizePhoneDigits(phoneDigits)
  if (!normalized) return false
  return platformListHas("phone_digits", normalized, client)
}

export async function isEmailOnSuppressionList(email: string, client?: PlatformSuppressionClient): Promise<boolean> {
  const normalized = normalizeEmail(email)
  if (!normalized) return false
  return platformListHas("email", normalized, client)
}

/**
 * Add a phone or email (or both) to the cross-tenant suppression list.
 * No-op if already present.
 */
export async function addToSuppressionList(params: {
  phone?: string | null
  email?: string | null
  reason: SuppressionReason
  sourceLeadId?: string | null
  sourceContactId?: string | null
  sourceBrokerageId?: string | null
  addedByUserId?: string | null
  notes?: string | null
}): Promise<{ added: boolean; reason: string }> {
  const supabase = createServiceClient()
  const phoneDigits = normalizePhoneDigits(params.phone)
  const email = normalizeEmail(params.email)

  if (!phoneDigits && !email) {
    return { added: false, reason: "no_identifier" }
  }

  // Use upsert via insert; rely on unique partial indexes to dedupe
  const inserts: Array<Record<string, unknown>> = []

  if (phoneDigits) {
    inserts.push({
      phone_digits: phoneDigits,
      reason: params.reason,
      source_lead_id: params.sourceLeadId ?? null,
      source_contact_id: params.sourceContactId ?? null,
      source_brokerage_id: params.sourceBrokerageId ?? null,
      added_by_user_id: params.addedByUserId ?? null,
      notes: params.notes ?? null,
    })
  }
  if (email) {
    inserts.push({
      email,
      reason: params.reason,
      source_lead_id: params.sourceLeadId ?? null,
      source_contact_id: params.sourceContactId ?? null,
      source_brokerage_id: params.sourceBrokerageId ?? null,
      added_by_user_id: params.addedByUserId ?? null,
      notes: params.notes ?? null,
    })
  }

  for (const row of inserts) {
    const { error: suppressErr } = await supabase.from("platform_suppression_list").insert(row).select().single()
    // A unique violation means already on the list = success. Anything else is a
    // DNC that did NOT take — never report it as suppressed.
    if (suppressErr && (suppressErr as { code?: string }).code !== "23505") {
      return { added: false, reason: `suppression_refused: ${suppressErr.message}` }
    }
  }

  return { added: true, reason: `suppressed_${params.reason}` }
}

/**
 * Convenience guard: should this lead/contact be touched at all?
 * Returns true if EITHER phone or email is suppressed.
 */
export async function isSuppressedAny(params: {
  phone?: string | null
  email?: string | null
}, client?: PlatformSuppressionClient): Promise<boolean> {
  const phoneDigits = normalizePhoneDigits(params.phone)
  const email = normalizeEmail(params.email)
  if (phoneDigits && (await isPhoneOnSuppressionList(phoneDigits, client))) return true
  if (email && (await isEmailOnSuppressionList(email, client))) return true
  return false
}
