/**
 * lib/ads/ad-lead-intake.ts
 *
 * Wave 41 — paid-ad LEAD-FORM intake. A Meta/Google lead-ad form submission is
 * itself an explicit opt-in: the prospect filled in their details and agreed to
 * be contacted. So an ad-form lead becomes a CONSENTED CONTACT (tcpa_consent=true
 * + a consent_event audit row), NOT an unconsented `leads` row. That consent is
 * exactly what unlocks downstream avatar-video follow-up and ad-audience
 * membership (which require a consented contact, per m165).
 *
 * Idempotent on (brokerage_id, email|phone). Not server-only — never import from
 * a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"

export interface AdLeadInput {
  brokerageId: string
  agentId?:    string | null
  firstName?:  string | null
  lastName?:   string | null
  email?:      string | null
  phone?:      string | null
  platform?:   string                 // 'facebook' | 'instagram' | 'google' | ...
  formId?:     string | null
  consentText?: string | null
  ip?:         string | null
  userAgent?:  string | null
}

export interface AdLeadResult { ok: boolean; contactId?: string; created?: boolean; reason?: string }

/**
 * Create or update a CONSENTED contact from an ad lead-form submission, and write
 * the consent audit event. The form submission is the consent — we stamp
 * tcpa_consent=true with source 'ad_lead_form'. Best-effort de-dupe by email then
 * phone within the brokerage.
 */
export async function ingestConsentedAdLead(
  input: AdLeadInput,
  client?: ReturnType<typeof createServiceClient>,
): Promise<AdLeadResult> {
  const supabase = client ?? createServiceClient()
  if (!input.brokerageId) return { ok: false, reason: "missing brokerageId" }
  if (!input.email && !input.phone) return { ok: false, reason: "need an email or phone" }

  const nowIso = new Date().toISOString()
  const consentText = input.consentText
    ?? `Submitted a ${input.platform ?? "paid-ad"} lead form${input.formId ? ` (${input.formId})` : ""} agreeing to be contacted.`

  // De-dupe within the brokerage: email first, then phone.
  let existingId: string | null = null
  if (input.email) {
    const { data } = await supabase.from("contacts").select("id").eq("brokerage_id", input.brokerageId).eq("email", input.email).maybeSingle()
    existingId = (data as { id: string } | null)?.id ?? null
  }
  if (!existingId && input.phone) {
    const { data } = await supabase.from("contacts").select("id").eq("brokerage_id", input.brokerageId).eq("phone", input.phone).maybeSingle()
    existingId = (data as { id: string } | null)?.id ?? null
  }

  const consentCols = {
    tcpa_consent:        true,
    tcpa_consent_at:     nowIso,
    tcpa_consent_date:   nowIso,
    tcpa_consent_text:   consentText,
    tcpa_consent_source: "ad_lead_form",
    tcpa_consent_ip:     input.ip ?? null,
  }

  let contactId: string
  let created = false
  if (existingId) {
    // Upgrade an existing contact to consented (the form is fresh opt-in).
    await supabase.from("contacts").update(consentCols).eq("id", existingId)
    contactId = existingId
  } else {
    const { data, error } = await supabase.from("contacts").insert({
      brokerage_id: input.brokerageId,
      agent_id:     input.agentId ?? null,
      first_name:   input.firstName?.trim() || "Ad Lead",
      last_name:    input.lastName?.trim() || "",   // contacts.last_name is NOT NULL
      email:        input.email ?? null,
      phone:        input.phone ?? null,
      contact_type: "lead",
      source:       `ad_lead_form:${input.platform ?? "meta"}`,
      lifecycle_state: "new",
      ...consentCols,
    }).select("id").single()
    if (error || !data) return { ok: false, reason: error?.message ?? "insert failed" }
    contactId = (data as { id: string }).id
    created = true
  }

  // Consent audit trail (best-effort — the contact is already stamped).
  await supabase.from("contact_consent_events").insert({
    contact_id:     contactId,
    brokerage_id:   input.brokerageId,
    agent_id:       input.agentId ?? null,
    consent_type:   "marketing",
    consent_text:   consentText,
    consent_source: "ad_lead_form",
    consented:      true,
    ip_address:     input.ip ?? null,
    user_agent:     input.userAgent ?? null,
  })

  return { ok: true, contactId, created }
}
