/**
 * lib/kernel/compliance/consent-component.ts — CONTRACT C15, THE ONE CONSENT COMPONENT (wave 148, lane 148B).
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER, verbatim (2026-11-01): "all forms need to have the same consent boxes along with follow up that has an easy way to
 * unsubscribe including on SMS to comply with the law."
 *
 * ONE wording, ONE version, ONE value shape — imported by BOTH the React component every public form renders
 * (app/components/forms/ConsentBoxes.tsx) AND the server door that records what the person ticked
 * (lib/contact-pipeline/contact-capture.ts consentGrantsFromComponent → C8 captureConsentedContact). The words a person saw
 * and the words the consent ledger stores are the same function of the same inputs, so they cannot drift (lane-147A Still
 * open 3: "a shared wording module imported by both the label and the door would remove the drift risk").
 *
 * WHAT THE BOXES SEPARATE (ruling 3: "consent distinguishes portal/service delivery from optional marketing and channel
 * permissions"):
 *   · SERVICE DELIVERY — required for the thing the person asked for (their valuation, the showing, the guide). It names the
 *     channels it covers literally ("by email, phone call or text message"), so the record carries exactly those.
 *   · MARKETING — OPTIONAL, and one EXPLICIT box per channel (email · text · phone call · direct mail). Never pre-checked.
 *     Consent is not a condition of any purchase or service (the TCPA's prior-express-written-consent rule, 47 CFR §64.1200 —
 *     the rule this repo's law registry cites: lib/compliance-rules/law-rule-registry.ts).
 *   · THE WAY OUT — every marketing email carries an unsubscribe link (and a one-click List-Unsubscribe header), and every
 *     text honours STOP (the C16 suppression survivor: lib/kernel/compliance/check-suppression.ts). The footer says so.
 *
 * PURE, CLIENT-SAFE: no node:crypto, no supabase, no next/*. The wording HASH is computed on the server only
 * (require-contact-consent.ts consentTextHash) — the browser never supplies a hash or a wording the server stores.
 */

/** Bumped whenever a sentence below changes — the ledger row's consent_text_version. */
export const CONSENT_COMPONENT_VERSION = 'c15:2026-11-01'

export const CONSENT_COMPONENT_CHANNELS = ['email', 'sms', 'voice', 'direct_mail'] as const
export type ConsentComponentChannel = (typeof CONSENT_COMPONENT_CHANNELS)[number]

/**
 * The doors that render the component, each with the service the person is asking for in plain words. The door key travels
 * with the submission; the server re-renders the wording from the SAME key, never from text the browser sent.
 */
export const CONSENT_DOOR_SERVICE = {
  web_form: 'my request',
  lead_magnet: 'the resource I requested',
  qr_landing: 'the information I asked for',
  embed_widget: 'my question',
  chat_widget: 'my question',
  home_value: 'my home value estimate',
  showing_request: 'the showing I requested',
  listing_inquiry: 'the property I asked about',
  agent_profile: 'my message',
  open_house_kiosk: 'this open house and the homes I asked about',
  event_registration: 'the event I registered for',
} as const
export type ConsentDoorKey = keyof typeof CONSENT_DOOR_SERVICE

/** What each door's service-delivery consent is ABOUT (the C8 purpose vocabulary: require-contact-consent.ts CONSENT_PURPOSES). */
export const CONSENT_DOOR_PURPOSES: Readonly<Record<ConsentDoorKey, readonly string[]>> = {
  web_form: ['requested_information'],
  lead_magnet: ['requested_information'],
  qr_landing: ['requested_information'],
  embed_widget: ['requested_information'],
  chat_widget: ['requested_information'],
  home_value: ['requested_information', 'home_valuation'],
  showing_request: ['requested_information', 'property_inquiry'],
  listing_inquiry: ['requested_information', 'property_inquiry'],
  agent_profile: ['requested_information'],
  open_house_kiosk: ['requested_information', 'event_followup'],
  event_registration: ['requested_information', 'event_followup'],
}

/** What a MARKETING box covers — the broad real-estate grant plus the two named feeds. */
export const CONSENT_MARKETING_PURPOSES = ['real_estate_services', 'market_updates', 'listing_alerts'] as const

export interface ConsentComponentWording {
  version: string
  door: ConsentDoorKey
  brandName: string
  /** The REQUIRED box. */
  serviceDelivery: string
  /** The heading over the optional boxes. */
  marketingLead: string
  /** One sentence per OPTIONAL channel box — each self-contained (it is what that box's consent row stores). */
  marketing: Record<ConsentComponentChannel, string>
  /** The way out, shown under the boxes and appended to every marketing consent's stored text. */
  footer: string
}

/** Collapse whitespace and trim a display name; never empty (an empty brand would write "from  and its agents"). */
function cleanBrand(brandName: string | null | undefined): string {
  const b = String(brandName ?? '').replace(/\s+/g, ' ').trim()
  return b || 'this brokerage'
}

/** PURE — THE wording. Same (door, brand) → byte-identical sentences on the browser and on the server. */
export function consentComponentWording(input: { door: ConsentDoorKey; brandName: string | null | undefined }): ConsentComponentWording {
  const brand = cleanBrand(input.brandName)
  const service = CONSENT_DOOR_SERVICE[input.door] ?? CONSENT_DOOR_SERVICE.web_form
  const footer = `Consent to marketing is not a condition of any purchase or service. You can opt out any time: every email has an unsubscribe link, and you can reply STOP to any text (HELP for help).`
  const what = `market updates, new listings and offers to help me buy, sell or own a home`
  return {
    version: CONSENT_COMPONENT_VERSION,
    door: input.door,
    brandName: brand,
    serviceDelivery: `Yes, ${brand} may contact me about ${service} by email, phone call or text message at the details I provided.`,
    marketingLead: `Optional — keep me in the loop. I agree that ${brand} and its agents may send me ${what}:`,
    marketing: {
      email: `By email: ${brand} may send me ${what} by email.`,
      sms: `By text message: ${brand} may send me ${what} by text message, including by automated technology. Msg & data rates may apply; message frequency varies. Reply STOP to opt out.`,
      voice: `By phone call: ${brand} may call me about ${what}, including calls using automated technology or a prerecorded voice.`,
      direct_mail: `By mail: ${brand} may send me ${what} by direct mail (postcards and mailers).`,
    },
    footer,
  }
}

/** The component's state — what the person has ticked. Every box starts UNTICKED (a pre-checked box is not consent). */
export interface ConsentComponentValue {
  serviceDelivery: boolean
  marketing: Record<ConsentComponentChannel, boolean>
}

export const EMPTY_CONSENT_VALUE: ConsentComponentValue = Object.freeze({
  serviceDelivery: false,
  marketing: Object.freeze({ email: false, sms: false, voice: false, direct_mail: false }),
}) as ConsentComponentValue

/** What a form POSTS (JSON-safe). The server trusts the booleans and the door key — never a wording, a hash or a brand. */
export interface ConsentComponentSubmission {
  c15: true
  version: string
  door: ConsentDoorKey
  /** The brand the browser rendered — compared to the server's own; a mismatch is EVIDENCE, never the stored wording. */
  rendered_brand: string
  service_delivery: boolean
  marketing: Record<ConsentComponentChannel, boolean>
  /** The channels the form OFFERED as marketing boxes (a box not offered cannot be ticked). */
  offered: ConsentComponentChannel[]
}

/** PURE — the submission a form sends for its current value. */
export function consentSubmissionFor(value: ConsentComponentValue, input: { door: ConsentDoorKey; brandName: string; offered?: readonly ConsentComponentChannel[] }): ConsentComponentSubmission {
  const offered = [...(input.offered ?? DEFAULT_OFFERED_CHANNELS)]
  return {
    c15: true,
    version: CONSENT_COMPONENT_VERSION,
    door: input.door,
    rendered_brand: cleanBrand(input.brandName),
    service_delivery: value.serviceDelivery === true,
    marketing: {
      email: offered.includes('email') && value.marketing.email === true,
      sms: offered.includes('sms') && value.marketing.sms === true,
      voice: offered.includes('voice') && value.marketing.voice === true,
      direct_mail: offered.includes('direct_mail') && value.marketing.direct_mail === true,
    },
    offered,
  }
}

/** The marketing channels a form offers when it names none. Direct mail is offered where the form collects an address. */
export const DEFAULT_OFFERED_CHANNELS: readonly ConsentComponentChannel[] = ['email', 'sms', 'voice']

/**
 * PURE — strict parse of an untrusted body field. Anything that is not exactly the shape (booleans as booleans, a known door,
 * the current version) is NULL: the door then records NO consent rather than guessing one (consent is never fabricated).
 */
export function parseConsentSubmission(raw: unknown): ConsentComponentSubmission | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.c15 !== true || r.version !== CONSENT_COMPONENT_VERSION) return null
  if (typeof r.door !== 'string' || !(r.door in CONSENT_DOOR_SERVICE)) return null
  if (typeof r.service_delivery !== 'boolean') return null
  const m = r.marketing as Record<string, unknown> | null | undefined
  if (!m || typeof m !== 'object') return null
  const offered = Array.isArray(r.offered) ? (r.offered as unknown[]).filter((c): c is ConsentComponentChannel => typeof c === 'string' && (CONSENT_COMPONENT_CHANNELS as readonly string[]).includes(c)) : []
  const marketing = {} as Record<ConsentComponentChannel, boolean>
  for (const c of CONSENT_COMPONENT_CHANNELS) {
    const v = m[c]
    if (v !== undefined && typeof v !== 'boolean') return null
    marketing[c] = v === true && offered.includes(c)
  }
  return { c15: true, version: CONSENT_COMPONENT_VERSION, door: r.door as ConsentDoorKey, rendered_brand: cleanBrand(typeof r.rendered_brand === 'string' ? r.rendered_brand : ''), service_delivery: r.service_delivery, marketing, offered }
}

/** One consent box → one C8 grant (the shape lib/contact-pipeline/contact-capture.ts ConsentGrantInput takes). */
export interface ConsentComponentGrant {
  family: 'phone' | 'email' | 'mail'
  slot: 'service_delivery' | 'marketing' | 'marketing_sms' | 'marketing_voice'
  given: boolean
  text: string
  textVersion: string
  purposes: string[]
  channels: Array<'sms' | 'voice' | 'email' | 'direct_mail'>
}

/**
 * PURE — the grants a submission records, given the methods the person actually PROVIDED. A channel with no method behind it
 * records nothing (a phone consent with no phone number is not a consent to anything). Unticked boxes produce `given: false`
 * grants, which write nothing (C8: an unticked box is not a withdrawal).
 */
export function consentGrantsFor(sub: ConsentComponentSubmission, wording: ConsentComponentWording, provided: { email: boolean; phone: boolean; address?: boolean }): ConsentComponentGrant[] {
  const v = `${wording.version}:${wording.door}`
  const service = [...(CONSENT_DOOR_PURPOSES[wording.door] ?? ['requested_information'])]
  const mk = [...CONSENT_MARKETING_PURPOSES]
  const tail = ` ${wording.footer}`
  const out: ConsentComponentGrant[] = []
  if (provided.email) out.push({ family: 'email', slot: 'service_delivery', given: sub.service_delivery, text: wording.serviceDelivery, textVersion: v, purposes: service, channels: ['email'] })
  if (provided.phone) out.push({ family: 'phone', slot: 'service_delivery', given: sub.service_delivery, text: wording.serviceDelivery, textVersion: v, purposes: service, channels: ['sms', 'voice'] })
  if (provided.email) out.push({ family: 'email', slot: 'marketing', given: sub.marketing.email, text: `${wording.marketingLead} ${wording.marketing.email}${tail}`, textVersion: v, purposes: mk, channels: ['email'] })
  if (provided.phone) out.push({ family: 'phone', slot: 'marketing_sms', given: sub.marketing.sms, text: `${wording.marketingLead} ${wording.marketing.sms}${tail}`, textVersion: v, purposes: mk, channels: ['sms'] })
  if (provided.phone) out.push({ family: 'phone', slot: 'marketing_voice', given: sub.marketing.voice, text: `${wording.marketingLead} ${wording.marketing.voice}${tail}`, textVersion: v, purposes: mk, channels: ['voice'] })
  if (provided.address) out.push({ family: 'mail', slot: 'marketing', given: sub.marketing.direct_mail, text: `${wording.marketingLead} ${wording.marketing.direct_mail}${tail}`, textVersion: v, purposes: mk, channels: ['direct_mail'] })
  return out
}

/** PURE — the full wording as ONE string (what the server hashes for the submission-level wording_hash). */
export function consentWordingText(w: ConsentComponentWording): string {
  return [w.serviceDelivery, w.marketingLead, w.marketing.email, w.marketing.sms, w.marketing.voice, w.marketing.direct_mail, w.footer].join('\n')
}
