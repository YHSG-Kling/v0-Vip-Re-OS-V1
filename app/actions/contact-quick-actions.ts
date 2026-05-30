"use server"

/**
 * Quick-action server actions for contact intelligence — the "buttons on the contact page" set.
 *
 * Auto-vs-manual contract: these three actions are MANUAL (button-triggered by an agent). For
 * AUTOMATIC behavior, see:
 *   - lib/lead-pipeline/contact-signal-rescrape.ts (fires on lifecycle signals like tcpa_consent
 *     granted, deal_under_contract, address_changed)
 *   - app/api/cron/lead-scraping  (daily scrape + re-enrich sweep)
 *   - app/api/cron/connector-health (probes + auto-healer trigger)
 *
 * Authorization (matches the canonical tenant-scoping rule for contacts):
 *   - Action allowed when the caller is the contact's assigned agent (contacts.agent_id → agents
 *     where user_id = caller), OR a broker / team_lead / TC / compliance officer in the same
 *     brokerage, OR a platform admin (superadmin / support).
 *   - Anyone else gets {success:false, error:"Forbidden"} — no row leaks.
 *
 * All three actions write the verified flags back to the contact so the canonical gates (AI-ISA
 * channel resolver, lead-eligibility) immediately see the result.
 */
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { revalidatePath } from "next/cache"

interface ContactRow {
  id:               string
  brokerage_id:     string | null
  agent_id:         string | null
  email:            string | null
  mailing_address:  string | null
  mailing_city:     string | null
  mailing_state:    string | null
  mailing_zip:      string | null
}

async function assertCanActOnContact(contactId: string): Promise<
  { ok: true; userId: string; contact: ContactRow } | { ok: false; error: string }
> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: contact } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id, email, mailing_address, mailing_city, mailing_state, mailing_zip")
    .eq("id", contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }
  const c = contact as ContactRow

  const { data: profile } = await svc.from("users")
    .select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()

  // Platform admin / staff always allowed
  if (profile?.user_type === "superadmin" || isPlatformStaff(profile?.platform_role)) {
    return { ok: true, userId: user.id, contact: c }
  }

  // Agent — must own the contact (contacts.agent_id is an agents.id; resolve caller's agents.id)
  if (profile?.user_type === "agent") {
    const { data: a } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
    if (a?.id && c.agent_id === a.id) return { ok: true, userId: user.id, contact: c }
    return { ok: false, error: "Forbidden — not your contact" }
  }

  // Broker / team-lead / TC / compliance in the contact's brokerage
  const BROKERAGE_ROLES = new Set(["broker", "broker_owner", "team_lead", "team_leader", "tc", "transaction_coordinator", "compliance_officer", "compliance_manager"])
  if (profile?.user_type && BROKERAGE_ROLES.has(profile.user_type) && profile.brokerage_id && profile.brokerage_id === c.brokerage_id) {
    return { ok: true, userId: user.id, contact: c }
  }

  return { ok: false, error: "Forbidden" }
}

// ── #2 Deal investigator: PDL + RentCast + BatchData → one-paragraph summary ─
export async function runDealInvestigatorAction(params: {
  contactId:   string
  maxCostUsd?: number
}): Promise<{ success: boolean; summary?: string; warnings?: string[]; cost?: number; error?: string }> {
  const gate = await assertCanActOnContact(params.contactId)
  if (!gate.ok) return { success: false, error: gate.error }
  try {
    const { investigateDeal } = await import("@/lib/agentic-os/deal-investigator")
    const r = await investigateDeal({ contactId: params.contactId, maxCostUsd: params.maxCostUsd })
    if (r.summary) {
      const svc = createServiceClient()
      // Read-merge-write so we don't clobber other enrichment_profile fields (employer, income, …).
      const { data: existing } = await svc.from("contacts").select("enrichment_profile").eq("id", params.contactId).maybeSingle()
      const profile = { ...((existing?.enrichment_profile as Record<string, unknown>) ?? {}),
                        last_investigation_summary: r.summary,
                        last_investigation_at:      new Date().toISOString() }
      await svc.from("contacts").update({ enrichment_profile: profile }).eq("id", params.contactId)
    }
    revalidatePath(`/dashboard/contacts/${params.contactId}`)
    return { success: true, summary: r.summary, warnings: r.warnings, cost: r.cost }
  } catch (e: any) { return { success: false, error: e?.message ?? "investigation failed" } }
}

// ── #7 Verify email — `deep:true` runs PDL Tier 3 (~$0.01); default is free RFC+MX ───────
export async function verifyContactEmailAction(params: {
  contactId: string
  deep?:     boolean
}): Promise<{ success: boolean; verified?: boolean; reason?: string | null; tier?: number; cost?: number; error?: string }> {
  const gate = await assertCanActOnContact(params.contactId)
  if (!gate.ok) return { success: false, error: gate.error }
  if (!gate.contact.email) return { success: false, error: "Contact has no email on file" }
  try {
    const mod = await import("@/lib/external/email-verifier")
    const r = params.deep ? await mod.verifyEmailDeep(gate.contact.email) : await mod.checkEmailMx(gate.contact.email)
    const svc = createServiceClient()
    await svc.from("contacts").update({ email_verified: r.verified }).eq("id", params.contactId)
    revalidatePath(`/dashboard/contacts/${params.contactId}`)
    return { success: true, verified: r.verified, reason: r.reason, tier: r.tier, cost: r.cost }
  } catch (e: any) { return { success: false, error: e?.message ?? "email verify failed" } }
}

// ── #8 Verify mailing address (Lob deliverability) — gates direct-mail spend ─────────────
export async function verifyContactAddressAction(params: {
  contactId: string
}): Promise<{ success: boolean; verified?: boolean; deliverability?: string | null; cost?: number; error?: string }> {
  const gate = await assertCanActOnContact(params.contactId)
  if (!gate.ok) return { success: false, error: gate.error }
  if (!gate.contact.mailing_address) return { success: false, error: "Contact has no mailing address on file" }
  try {
    const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
    const { data, cost } = await verifyAddressViaLob({
      primary_line: gate.contact.mailing_address,
      city:         gate.contact.mailing_city  ?? undefined,
      state:        gate.contact.mailing_state ?? undefined,
      zip_code:     gate.contact.mailing_zip   ?? undefined,
    })
    if (!data) return { success: false, error: "Lob not configured (set LOB_API_KEY)", cost }
    const svc = createServiceClient()
    await svc.from("contacts").update({ mailing_address_verified: data.verified }).eq("id", params.contactId)
    revalidatePath(`/dashboard/contacts/${params.contactId}`)
    return { success: true, verified: data.verified, deliverability: data.deliverability, cost }
  } catch (e: any) { return { success: false, error: e?.message ?? "address verify failed" } }
}
