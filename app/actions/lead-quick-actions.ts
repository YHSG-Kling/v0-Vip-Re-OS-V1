"use server"

/**
 * Quick-action server actions for LEAD intelligence — pre-conversion verification + enrichment.
 *
 * ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY.
 *   - `leads` are platform OR brokerage-scoped (NEVER agent-assigned in the canonical flow — the
 *     moment a lead is assigned to an agent it's promoted to a contact).
 *   - Platform admin / staff → always allowed. Identified by `users.platform_role`, NOT by
 *     `user_type='superadmin'`, which no live row holds.
 *   - Brokerage-LEVEL roles (broker / broker_owner / admin) → allowed when their
 *     `users.brokerage_id` matches `leads.brokerage_id`. (When the lead has
 *     `brokerage_id IS NULL` it is platform-only — only platform admin / staff can act.)
 *   - team_lead → allowed, ROW-SCOPED TO THEIR OWN TEAM (owner ruling: "if team tier
 *     subscriptions, they don't have a broker in the subscription so the team lead can see
 *     leads"). A team lead may act on a lead their own team's agents are working, and on no
 *     other; where their team is the tenant's only team the scope is the tenant.
 *   - Agents, TCs, compliance officers do NOT get access to lead rows — agents work
 *     CONTACTS only (post-promotion); the CRM contact flow is where non-broker work happens.
 *   - Anyone else → structured `{ success:false, error:"Forbidden" }` (no row leak).
 *
 * Actions: tier-3 PDL email verify, Lob address verify, full PDL skip-trace re-enrich. All write
 * results back to the lead row so the canonical AI-ISA channel resolver picks them up
 * (`email_verified` / `mailing_address_verified` / verified address fields).
 */
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveLeadVisibility, leadRowInScope } from "@/lib/auth/lead-visibility"
import { revalidatePath } from "next/cache"

interface LeadRow {
  id:               string
  brokerage_id:     string | null
  /** Needed by the row-scope test — a team's lead is one worked by a team agent. */
  agent_id:         string | null
  first_name:       string | null
  last_name:        string | null
  email:            string | null
  phone:            string | null
  mailing_address:  string | null
  mailing_zip:      string | null
}

// TOMBSTONE (lead-visibility consolidation): the inline `BROKERAGE_ROLES` set is
// DELETED. The survivor is lib/auth/lead-visibility.ts:resolveLeadVisibility,
// which answers admission AND row scope, and leadRowInScope, which asks the same
// question of ONE already-fetched row — the shape this gate needs.
//
// The comment that stood here recorded team_lead's removal as deliberate. The
// owner's ruling supersedes it: a team lead reaches lead rows, scoped to their
// own team. Because this gate acts on a SINGLE lead it can enforce that exactly
// — the fetched row is tested against the resolved scope, so a team lead may
// verify or re-enrich a lead their team is working and no other.
//
// ALSO REMOVED HERE: 'broker_admin', which is not a storable user_type and so
// could never match a live row through this comparison (it stays an input
// spelling inside the one roster). 'superadmin' was never in this set — the file
// already used isPlatformStaffIdentity for staff, which the survivor now does
// on its behalf.
//
// The `agent_id` the scope needs is read alongside the rest of the row: a
// single-lead gate that fetched no agent_id could not tell a team's lead from
// the brokerage's.

async function assertCanActOnLead(leadId: string): Promise<
  { ok: true; userId: string; lead: LeadRow } | { ok: false; error: string }
> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: lead, error: leadError } = await svc.from("leads")
    .select("id, brokerage_id, agent_id, first_name, last_name, email, phone, mailing_address, mailing_zip")
    .eq("id", leadId).maybeSingle()
  // supabase-js RESOLVES a refusal — a swallowed error reads as "no such lead",
  // and both refuse, but they must not be reported as the same thing.
  if (leadError) return { ok: false, error: "Could not read that lead" }
  if (!lead) return { ok: false, error: "Lead not found" }
  const l = lead as LeadRow

  const { data: profile, error: profileError } = await svc.from("users")
    .select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()
  if (profileError) return { ok: false, error: "Could not verify your account" }

  const vis = await resolveLeadVisibility(svc, {
    userId: user.id,
    userType: profile?.user_type ?? null,
    platformRole: profile?.platform_role ?? null,
    brokerageId: profile?.brokerage_id ?? null,
  })
  if (!vis.allowed) return { ok: false, error: vis.status === "forbidden" ? "Forbidden" : vis.reason }

  // A lead with brokerage_id NULL is PLATFORM-ONLY. leadRowInScope refuses it for
  // every tenant scope (NULL never equals a brokerage id) and admits it for
  // platform scope, which is the rule this file already documented.
  if (!leadRowInScope(vis.scope, l)) return { ok: false, error: "Forbidden" }

  return { ok: true, userId: user.id, lead: l }
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
    // Stamp the CASS marker too. It is the same Lob US-verification the direct-mail
    // gate buys (lib/providers/mailing-cass-gate.ts) and the same one the promotion
    // gate buys (lib/lead-pipeline/promotion-address-verification.ts); without the
    // marker, a hand-verified address is re-verified — and re-billed — by both.
    const { CASS_SOURCE } = await import("@/lib/providers/mailing-cass-gate")
    const { error: verifyWriteError } = await createServiceClient()
      .from("leads")
      .update({ mailing_address_verified: data.verified, mailing_address_source: CASS_SOURCE })
      .eq("id", params.leadId)
    if (verifyWriteError) return { success: false, error: verifyWriteError.message, cost }
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
