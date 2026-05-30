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
import { createServiceClient } from "@/lib/supabase/service"
import { assertCanActOnContact } from "@/lib/auth/contact-access"
import { revalidatePath } from "next/cache"

// `assertCanActOnContact` lives in @/lib/auth/contact-access so the consolidated CRM contact page
// can apply the same defense-in-depth check on the read path. The ContactRow shape is re-exported
// from there as ContactAccessRow.

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
