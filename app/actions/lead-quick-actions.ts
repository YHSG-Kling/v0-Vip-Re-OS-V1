"use server"

/**
 * Quick-action server actions for LEAD intelligence — pre-conversion verification + enrichment.
 *
 * Authorization (matches the canonical tenant-scoping rule for leads):
 *   - `leads` are platform OR brokerage-scoped (NEVER agent-assigned in the canonical flow — the
 *     moment a lead is assigned to an agent it's promoted to a contact).
 *   - Platform admin / staff (superadmin / support) → always allowed.
 *   - Brokerage staff (broker / broker_owner / team_lead / team_leader / tc / transaction_
 *     coordinator / compliance_officer / compliance_manager) → allowed when their
 *     `users.brokerage_id` matches `leads.brokerage_id`. (When the lead has `brokerage_id IS NULL`
 *     it is platform-only — only platform admin / staff can act.)
 *   - Agents do NOT get access to lead rows. The CRM contact flow is where their work happens.
 *   - Anyone else → structured `{ success:false, error:"Forbidden" }` (no row leak).
 *
 * Actions: tier-3 PDL email verify, Lob address verify, full PDL skip-trace re-enrich. All write
 * results back to the lead row so the canonical AI-ISA channel resolver picks them up
 * (`email_verified` / `mailing_address_verified` / verified address fields).
 */
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { revalidatePath } from "next/cache"

interface LeadRow {
  id:               string
  brokerage_id:     string | null
  first_name:       string | null
  last_name:        string | null
  email:            string | null
  phone:            string | null
  mailing_address:  string | null
  mailing_zip:      string | null
}

const BROKERAGE_ROLES = new Set([
  "broker", "broker_owner", "team_lead", "team_leader",
  "tc", "transaction_coordinator",
  "compliance_officer", "compliance_manager",
])

async function assertCanActOnLead(leadId: string): Promise<
  { ok: true; userId: string; lead: LeadRow } | { ok: false; error: string }
> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: lead } = await svc.from("leads")
    .select("id, brokerage_id, first_name, last_name, email, phone, mailing_address, mailing_zip")
    .eq("id", leadId).maybeSingle()
  if (!lead) return { ok: false, error: "Lead not found" }
  const l = lead as LeadRow

  const { data: profile } = await svc.from("users")
    .select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()

  // Platform admin / staff always allowed (including for platform-only leads where brokerage_id IS NULL).
  if (profile?.user_type === "superadmin" || isPlatformStaff(profile?.platform_role)) {
    return { ok: true, userId: user.id, lead: l }
  }

  // Brokerage staff — only when their brokerage matches the lead's. NULL brokerage_id on the lead
  // means platform-only → no brokerage staff can act; the previous block already handled platform.
  if (profile?.user_type && BROKERAGE_ROLES.has(profile.user_type)
    && profile.brokerage_id && l.brokerage_id === profile.brokerage_id) {
    return { ok: true, userId: user.id, lead: l }
  }

  // Agents do NOT have access to lead rows in the canonical flow.
  return { ok: false, error: "Forbidden" }
}

// ── Verify email (Tier 1+2 free / Tier 3 PDL ~$0.01) ───────────────────────
export async function verifyLeadEmailAction(params: {
  leadId: string
  deep?:  boolean
}): Promise<{ success: boolean; verified?: boolean; reason?: string | null; tier?: number; cost?: number; error?: string }> {
  const gate = await assertCanActOnLead(params.leadId)
  if (!gate.ok) return { success: false, error: gate.error }
  if (!gate.lead.email) return { success: false, error: "Lead has no email on file" }
  try {
    const mod = await import("@/lib/external/email-verifier")
    const r = params.deep ? await mod.verifyEmailDeep(gate.lead.email) : await mod.checkEmailMx(gate.lead.email)
    await createServiceClient().from("leads").update({ email_verified: r.verified }).eq("id", params.leadId)
    revalidatePath(`/leads/${params.leadId}`)
    return { success: true, verified: r.verified, reason: r.reason, tier: r.tier, cost: r.cost }
  } catch (e: any) { return { success: false, error: e?.message ?? "email verify failed" } }
}

// ── Verify mailing address (Lob) ───────────────────────────────────────────
export async function verifyLeadAddressAction(params: {
  leadId: string
}): Promise<{ success: boolean; verified?: boolean; deliverability?: string | null; cost?: number; error?: string }> {
  const gate = await assertCanActOnLead(params.leadId)
  if (!gate.ok) return { success: false, error: gate.error }
  if (!gate.lead.mailing_address) return { success: false, error: "Lead has no mailing address on file" }
  try {
    const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
    const { data, cost } = await verifyAddressViaLob({
      primary_line: gate.lead.mailing_address,
      zip_code:     gate.lead.mailing_zip ?? undefined,
    })
    if (!data) return { success: false, error: "Lob not configured (set LOB_API_KEY)", cost }
    await createServiceClient().from("leads").update({ mailing_address_verified: data.verified }).eq("id", params.leadId)
    revalidatePath(`/leads/${params.leadId}`)
    return { success: true, verified: data.verified, deliverability: data.deliverability, cost }
  } catch (e: any) { return { success: false, error: e?.message ?? "address verify failed" } }
}

// ── Re-run PDL skip-trace enrichment (refresh person fields for an existing lead) ──────
export async function enrichLeadAction(params: {
  leadId: string
}): Promise<{ success: boolean; emails?: number; phones?: number; cost?: number; error?: string }> {
  const gate = await assertCanActOnLead(params.leadId)
  if (!gate.ok) return { success: false, error: gate.error }
  try {
    const { skipTraceWithPeopleData } = await import("@/lib/external/peopledata-client")
    const nameStr = [gate.lead.first_name, gate.lead.last_name].filter(Boolean).join(" ")
    const r = await skipTraceWithPeopleData({
      name:  nameStr || undefined,
      email: gate.lead.email ?? undefined,
      phone: gate.lead.phone ?? undefined,
      address: gate.lead.mailing_address ?? undefined,
    })
    revalidatePath(`/leads/${params.leadId}`)
    return { success: !!r.data, emails: r.data?.emails?.length, phones: r.data?.phones?.length, cost: r.cost }
  } catch (e: any) { return { success: false, error: e?.message ?? "enrichment failed" } }
}
