/**
 * lib/referrals/referral-record.ts
 *
 * THE ONE `referrals` INSERT (lane 76A). Extracted from
 * app/actions/referrals/referral-actions.ts::createReferral — a "use server"
 * export, session-gated (auth.getUser + getAgentContext), which a customer-facing
 * AI tool can never call: the person talking to the AI IS the referrer, not a
 * staff session. Rather than a second insert shape in the tool (CLAUDE.md §6),
 * the insert moved HERE and createReferral now calls it — one writer, two call
 * sites (the staff dialog and lib/ai-isa/capability-catalogue.ts::
 * buildCaptureReferralTool).
 *
 * IDENTITY CLASSES (CLAUDE.md §3): referrals.referrer_contact_id and
 * referred_contact_id are contacts.id; referred_lead_id is leads.id; agent_id is
 * agents.id (never users.id — lifecycle_events.actor_user_id is the users.id
 * slot and belongs to the CALLER's emitKernelEvent, not here).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { DEFAULT_REFERRAL_STATUS, REFERRAL_TERMINAL_WON, type ReferralStatus } from "@/lib/referrals/referral-status"

export interface ReferralRecordInput {
  brokerageId: string
  /** agents.id */
  agentId: string | null
  partnerId?: string | null
  /** contacts.id of the person being referred (already captured), if any. */
  referredContactId?: string | null
  /** leads.id of the person being referred, if the referral points at a lead. */
  referredLeadId?: string | null
  /** contacts.id of the person who SENT the referral, when they are a contact. */
  referrerContactId?: string | null
  referralName?: string | null
  referralSource?: string | null
  commissionAmount?: number | null
  valueEstimate?: number | null
  commissionPotential?: number | null
  /** Free-text referrer when no contact record is linked. */
  referredBy?: string | null
  sourceContactName?: string | null
  notes?: string | null
  status?: ReferralStatus
}

export async function insertReferralRecord(
  db: SupabaseClient,
  input: ReferralRecordInput,
): Promise<{ ok: true; id: string; status: ReferralStatus } | { ok: false; error: string }> {
  const status = input.status ?? DEFAULT_REFERRAL_STATUS
  const { data, error } = await db
    .from("referrals")
    .insert({
      brokerage_id: input.brokerageId,
      agent_id: input.agentId,
      partner_id: input.partnerId ?? null,
      referred_contact_id: input.referredContactId ?? null,
      referred_lead_id: input.referredLeadId ?? null,
      referrer_contact_id: input.referrerContactId ?? null,
      status,
      referral_name: input.referralName ?? null,
      referral_source: input.referralSource ?? null,
      commission_amount: input.commissionAmount ?? null,
      value_estimate: input.valueEstimate ?? null,
      commission_potential: input.commissionPotential ?? null,
      referred_by: input.referredBy?.trim() || null,
      source_contact_name: input.sourceContactName?.trim() || null,
      notes: input.notes?.trim() || null,
      // A referral can ARRIVE already closed (a partner tells you about a deal
      // that has since settled). updateReferralStatus stamps closed_at on the
      // transition; nothing stamped it on creation, so such a row read as an
      // open referral forever. converted_at rides along because the ROI
      // rollups key on it.
      ...(status === REFERRAL_TERMINAL_WON
        ? { closed_at: new Date().toISOString(), converted_at: new Date().toISOString() }
        : { closed_at: null, converted_at: null }),
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "no row returned" }
  return { ok: true, id: (data as { id: string }).id, status }
}
