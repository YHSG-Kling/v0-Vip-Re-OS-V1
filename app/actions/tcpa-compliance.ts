"use server"

/**
 * TCPA compliance controls — real actions on the existing consent/suppression
 * infrastructure (not a report). Records express TCPA consent against a contact
 * (contacts.tcpa_consent + tcpa_consent_* columns) AND always writes the
 * contact_consent_events audit trail, via the canonical persistContactConsent.
 * Auth-gated + brokerage-scoped: a contactId is verified to belong to the
 * caller's brokerage before any write (the underlying persist uses the service
 * client, so the tenant check lives here).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { persistContactConsent, buildConsentText } from "@/lib/kernel/compliance/require-contact-consent"

const COMPLIANCE_ROLES = ["broker", "broker_admin", "admin", "superadmin", "team_lead", "compliance_officer"]

async function requireComplianceActor(): Promise<
  { userId: string; brokerageId: string; brokerageName: string } | { error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return { error: "No brokerage in scope" }
  if (!COMPLIANCE_ROLES.includes(profile.user_type ?? "")) return { error: "Forbidden" }
  const { data: brk } = await supabase
    .from("brokerages")
    .select("name")
    .eq("id", profile.brokerage_id)
    .maybeSingle()
  return { userId: user.id, brokerageId: profile.brokerage_id, brokerageName: brk?.name ?? "our brokerage" }
}

/**
 * Record (or revoke) express TCPA consent for a contact. `consented=true` is the
 * common path (the agent obtained written consent); `false` revokes it. Every
 * call writes the audit event regardless.
 */
export async function recordContactConsentAction(input: {
  contactId: string
  consented: boolean
  /** Where/how consent was obtained, e.g. "verbal - open house 2026-07-25". */
  note?: string
}): Promise<{ success: boolean; error?: string }> {
  const actor = await requireComplianceActor()
  if ("error" in actor) return { success: false, error: actor.error }
  if (!input.contactId) return { success: false, error: "contactId required" }

  // Tenant boundary: the contact must belong to the caller's brokerage.
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", input.contactId)
    .maybeSingle()
  if (!contact || contact.brokerage_id !== actor.brokerageId) {
    return { success: false, error: "Contact not found in this brokerage" }
  }

  const baseText = buildConsentText(actor.brokerageName)
  const consentText = input.note ? `${baseText} [recorded by staff: ${input.note}]` : `${baseText} [recorded by staff]`

  try {
    await persistContactConsent({
      brokerageId: actor.brokerageId,
      contactId: input.contactId,
      consentText,
      consentSource: "compliance_panel:tcpa",
      consented: input.consented,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Failed to record consent" }
  }
}
