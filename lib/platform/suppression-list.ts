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

export async function isPhoneOnSuppressionList(phoneDigits: string): Promise<boolean> {
  const supabase = createServiceClient()
  const normalized = normalizePhoneDigits(phoneDigits)
  if (!normalized) return false

  const { data } = await supabase
    .from("platform_suppression_list")
    .select("id")
    .eq("phone_digits", normalized)
    .limit(1)
    .maybeSingle()

  return !!data
}

export async function isEmailOnSuppressionList(email: string): Promise<boolean> {
  const supabase = createServiceClient()
  const normalized = normalizeEmail(email)
  if (!normalized) return false

  const { data } = await supabase
    .from("platform_suppression_list")
    .select("id")
    .eq("email", normalized)
    .limit(1)
    .maybeSingle()

  return !!data
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
    await supabase.from("platform_suppression_list").insert(row).select().single()
    // Ignore unique violation errors — already on list = success
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
}): Promise<boolean> {
  const phoneDigits = normalizePhoneDigits(params.phone)
  const email = normalizeEmail(params.email)
  if (phoneDigits && (await isPhoneOnSuppressionList(phoneDigits))) return true
  if (email && (await isEmailOnSuppressionList(email))) return true
  return false
}
