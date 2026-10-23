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
// THE tenant roster, defined once (see the tombstone below).
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — `COMPLIANCE_ROLES = ["broker","broker_owner","broker_admin",
//              "admin","team_lead","compliance_officer"]`
// ═══════════════════════════════════════════════════════════════════════════
// DELETED as a LITERAL (§6, 2026-09-04, lane ROSTER). Its own comment described
// it as a "SCOPE LADDER (kept inline)" that was NOT the tenant roster — and on
// 2026-09-04 that stopped being true: the owner ruled "there is a compliance
// officer for tenant staff which was not included", and with
// `compliance_officer` added, this list is BYTE-FOR-BYTE the tenant roster. It
// had become a second spelling of one idea while nobody was looking, which is
// precisely the drift the ruling was about.
//
// ── THE SURVIVOR, AT file:line ─────────────────────────────────────────────
//     lib/auth/resolve-user-role.ts  TENANT_ADMIN_USER_TYPES / isAdminOrBroker
// Membership is IDENTICAL — six roles, same six — so this is a deletion, not a
// behaviour change. (test:admin-vocabulary's shape scan reported this file the
// moment the roster gained its sixth member; it had reported zero the day
// before, which is what a working absence check looks like.)
const COMPLIANCE_ROLES = TENANT_ADMIN_USER_TYPES

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
  if (!COMPLIANCE_ROLES.has(String(profile.user_type ?? "").toLowerCase())) return { error: "Forbidden" }
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
    // FAIL CLOSED (CLAUDE.md §4). `input.consented` may be FALSE — this panel is
    // how staff record an opt-out. persistContactConsent used to return void, so a
    // refused contacts write landed here as success and the panel told the human
    // the opt-out was on file when the row still said otherwise.
    const consentWrite = await persistContactConsent({
      brokerageId: actor.brokerageId,
      contactId: input.contactId,
      consentText,
      consentSource: "compliance_panel:tcpa",
      consented: input.consented,
    })
    if (!consentWrite.ok) {
      return { success: false, error: consentWrite.error ?? "Failed to record consent on the contact" }
    }
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Failed to record consent" }
  }
}
