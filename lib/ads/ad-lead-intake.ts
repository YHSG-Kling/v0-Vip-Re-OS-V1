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

// ── Meta leadgen-by-reference (ONE path for the webhook AND the reconciler) ──

export interface MetaLeadField { name: string; values: string[] }

/** PURE: first value for any of the given field names (case-insensitive). */
export function pickMetaField(fields: MetaLeadField[], ...names: string[]): string | null {
  for (const n of names) {
    const f = fields.find((x) => x.name?.toLowerCase() === n)
    if (f?.values?.[0]) return f.values[0]
  }
  return null
}

export type MetaLeadStage = "no_credential" | "no_fields" | "graph_error" | "rejected" | "ingested"

/**
 * Resolve + ingest ONE Meta lead by reference. Used by the leadgen webhook
 * AND the ingress reconciler (replaying a parked lead), so the two paths can
 * never drift. Idempotent end to end (ingestConsentedAdLead de-dupes on
 * email/phone). The stage tells the caller exactly where it stopped:
 *   no_credential — the page isn't mapped to a brokerage (yet)
 *   graph_error   — transient Graph API failure (retryable)
 *   no_fields     — the lead's field_data isn't available (yet)
 *   rejected      — fields resolved but unusable (no email/phone)
 *   ingested      — the consented contact exists
 */
export async function ingestMetaLeadByRef(
  svc: ReturnType<typeof createServiceClient>,
  input: {
    pageId: string
    leadgenId?: string | null
    formId?: string | null
    /** inline field_data (tests / replays that captured it) — skips the Graph fetch */
    inlineFields?: MetaLeadField[] | null
  },
): Promise<{ ok: boolean; stage: MetaLeadStage; brokerageId?: string; contactId?: string }> {
  const { data: cred } = await svc.from("platform_credentials")
    .select("brokerage_id, access_token")
    .eq("platform", "facebook").eq("account_id", input.pageId).maybeSingle()
  const c = cred as { brokerage_id?: string; access_token?: string } | null
  if (!c?.brokerage_id) return { ok: false, stage: "no_credential" }

  let fields: MetaLeadField[] = Array.isArray(input.inlineFields) ? input.inlineFields : []
  if (fields.length === 0 && input.leadgenId && c.access_token) {
    try {
      const res = await fetch(`https://graph.facebook.com/v19.0/${input.leadgenId}?access_token=${encodeURIComponent(c.access_token)}`)
      if (!res.ok) return { ok: false, stage: "graph_error", brokerageId: c.brokerage_id }
      const json = (await res.json()) as { field_data?: MetaLeadField[] }
      fields = json.field_data ?? []
    } catch {
      return { ok: false, stage: "graph_error", brokerageId: c.brokerage_id }
    }
  }
  if (fields.length === 0) return { ok: false, stage: "no_fields", brokerageId: c.brokerage_id }

  const res = await ingestConsentedAdLead({
    brokerageId: c.brokerage_id,
    firstName:   pickMetaField(fields, "first_name", "full_name", "name"),
    lastName:    pickMetaField(fields, "last_name"),
    email:       pickMetaField(fields, "email"),
    phone:       pickMetaField(fields, "phone_number", "phone"),
    platform:    "facebook",
    formId:      input.formId ?? null,
  }, svc)
  if (!res.ok) return { ok: false, stage: "rejected", brokerageId: c.brokerage_id }
  return { ok: true, stage: "ingested", brokerageId: c.brokerage_id, contactId: res.contactId }
}
