/**
 * lib/ads/ad-lead-intake.ts
 *
 * Wave 41 — paid-ad LEAD-FORM intake. A Meta/Google lead-ad form submission is
 * an identifiable person asking to hear back, so it lands on the canonical
 * CONTACT (C8), never an unconsented `leads` row. Wave 148: the TCPA consent is
 * recorded ONLY with the platform's own disclosure wording (consentText) — the
 * submission alone is not a phone consent anyone can show (ruling 3).
 *
 * Idempotent on (brokerage_id, email|phone). Not server-only — never import from
 * a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { decryptSecretFields } from "@/lib/security/secret-crypto"
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.

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
  /** Wave 147 (C8): the provider's own submission id (Meta leadgen_id) — a webhook retry carries it verbatim, so the consent
   *  record is written once per submission. */
  submissionRef?: string | null
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

  // ONE DOOR (wave 148, lane 148B — owner ruling 4; lane 147A / 147Z Still open 1 — the "DUPLICATED upsert half").
  // TOMBSTONE (orphan doctrine §1.1): the email-then-phone lookup (errors unread), the consent-column UPDATE / contacts
  // INSERT, the enrichment queue call and the separate record-half call that stood here were a SECOND upsert of a consented
  // person. Merged onto THE one survivor — lib/contact-pipeline/contact-capture.ts captureConsentedContact (C8) →
  // captureContact — riding THIS intake's injected client (the webhook's / reconciler's service client). Preserved: the
  // tenant is the page credential's (the caller resolved it), contact_type 'lead', source `ad_lead_form:<platform>`, the
  // agent hint, idempotency per provider submission (Meta leadgen id → C8's key, so a webhook retry records nothing twice),
  // the consent IP, enrichment, the welcome, the AI ISA desk.
  //
  // CONSENT IS NEVER FABRICATED (wave 148 — owner ruling 3). TOMBSTONE: with no platform disclosure captured, this door
  // stamped tcpa_consent = true with a sentence it WROTE ITSELF ("Submitted a … lead form agreeing to be contacted") — a
  // TCPA consent whose wording nobody saw. A phone / email consent is now recorded only with the platform's OWN disclosure
  // text (`consentText`, the form's legal content). Without it the person still lands on the canonical contact (they are
  // identifiable and asked to hear back), but no consent is claimed — fail closed, the same reading lane 147A gave the embed.
  // Owner review: fetching the form's legal_content through the Meta adapter (lane-147A Still open 4) is what re-arms texting.
  const disclosure = (input.consentText ?? "").trim() || null
  const consents = disclosure
    ? [
        ...(input.phone ? [{ family: "phone" as const, given: true, text: disclosure, textVersion: `ad_form:${input.platform ?? "paid_ad"}`, purposes: ["requested_information" as const] }] : []),
        ...(input.email ? [{ family: "email" as const, given: true, text: disclosure, textVersion: `ad_form:${input.platform ?? "paid_ad"}`, purposes: ["requested_information" as const] }] : []),
      ]
    : [{ family: (input.phone ? "phone" : "email") as "phone" | "email", given: false, text: null, textVersion: "ad_form:platform_disclosure_not_captured" }]

  const { captureConsentedContact } = await import("@/lib/contact-pipeline/contact-capture")
  const c8 = await captureConsentedContact({
    brokerageId: input.brokerageId,
    ownerAgentId: input.agentId ?? null,
    source: `ad_lead_form:${input.platform ?? "meta"}`,
    contact_type: "lead",
    first_name: input.firstName?.trim() || null,
    last_name: input.lastName?.trim() || null,
    email: input.email?.trim().toLowerCase() || null,
    phone: input.phone ?? null,
    consents,
    intake: {
      channel: "ad_form",
      evidence: {
        platform: input.platform ?? null, form_id: input.formId ?? null, submission_ref: input.submissionRef ?? null,
        ip: input.ip ?? null, user_agent: input.userAgent ?? null, platform_disclosure_captured: !!disclosure,
      },
    },
  }, { client: supabase })
  for (const w of c8.warnings) console.warn(`[ad-lead-intake] consented intake: ${w}`)
  if (!c8.ok || !c8.contactId) return { ok: false, reason: c8.reason ?? c8.refused ?? "capture failed" }
  return { ok: true, contactId: c8.contactId, created: c8.action === "created" && !c8.replay }
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
  const c = decryptSecretFields(cred as { brokerage_id?: string; access_token?: string } | null, ["access_token"])
  if (!c?.brokerage_id) return { ok: false, stage: "no_credential" }

  let fields: MetaLeadField[] = Array.isArray(input.inlineFields) ? input.inlineFields : []
  if (fields.length === 0 && input.leadgenId && c.access_token) {
    // Wave 71A: routes through the official `facebook-nodejs-business-sdk`
    // adapter (lib/providers/meta/client.ts) instead of a raw `fetch`.
    const { graphGet } = await import("@/lib/providers/meta/client")
    const res = await graphGet<{ field_data?: MetaLeadField[] }>(c.access_token, [input.leadgenId])
    if (!res.ok) return { ok: false, stage: "graph_error", brokerageId: c.brokerage_id }
    fields = res.data?.field_data ?? []
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
    submissionRef: input.leadgenId ?? null,
  }, svc)
  if (!res.ok) return { ok: false, stage: "rejected", brokerageId: c.brokerage_id }
  return { ok: true, stage: "ingested", brokerageId: c.brokerage_id, contactId: res.contactId }
}
