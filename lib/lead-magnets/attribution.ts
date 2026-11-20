// lib/lead-magnets/attribution.ts
//
// LEAD-MAGNET ATTRIBUTION (pure) — wave 141, lane 141E (owner: "Lead magnets in ads keep
// campaign/ad/creative attribution"). ONE spelling of the query-string contract a lead-magnet
// landing page accepts, shared by the three places that touch it:
//   · the ad side WRITES it — lib/ads/ad-destination.ts resolveAdDestination (leadMagnetId) →
//     leadMagnetLandingUrl, so an ad creative's destination_url carries the campaign / ad campaign /
//     creative it was launched from;
//   · the public page READS it — app/lm/[slug]/page.tsx parseLeadMagnetAttribution(searchParams)
//     hands it to the capture forms, which post it with the submission;
//   · the kernel STAMPS it — lib/kernel/lead-magnets.ts captureFormSubmission verifies campaignId
//     against the magnet's OWN tenant (a query-string id never vouches for itself, CLAUDE.md §4),
//     then writes contacts.campaign_attribution_id + a marketing_campaign_touchpoints row
//     (status 'converted', external_table form_submissions) so the EXISTING attribution readers
//     (marketing_attribution_credits → roi-ledger, manager-touch-provenance, the twin) see it with
//     no new table. No second attribution model: this file only carries the parameters.
//
// Pure: no I/O, no server-only. Proven directly by scripts/lead-magnet-creation-guard.ts.

/** What a landing-page hit may carry about where it came from. Every field optional; every
 *  string sanitized by parseLeadMagnetAttribution before it reaches a writer. */
export interface LeadMagnetAttribution {
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  /** marketing_campaigns.id — VERIFIED by the kernel against the magnet's tenant before it is stamped. */
  campaignId?: string | null
  /** ad_campaigns.id (the paid campaign the creative belongs to). */
  adCampaignId?: string | null
  /** The creative the click came from (ad_creative_variations.variation_name, slugified by the writer). */
  creative?: string | null
  /** The tracked QR slug the visitor scanned (qr_codes.slug). */
  qr?: string | null
}

/** The query-string names — ONE vocabulary for writer and reader.
 *  @proofSeam scripts/lead-magnet-creation-guard.ts asserts the vocabulary directly (every name a plain query key). */
export const LEAD_MAGNET_ATTRIBUTION_PARAMS: Readonly<Record<keyof LeadMagnetAttribution, string>> = Object.freeze({
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmContent: "utm_content",
  campaignId: "campaign_id",
  adCampaignId: "ad_campaign_id",
  creative: "creative",
  qr: "qr",
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LEN = 120

/** A query value, trimmed, control characters removed, bounded; null when empty. */
function cleanText(v: unknown): string | null {
  const raw = Array.isArray(v) ? v[0] : v
  if (typeof raw !== "string") return null
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f<>"'`]/g, "").trim().slice(0, MAX_LEN)
  return s.length > 0 ? s : null
}

/** A uuid-shaped id, lower-cased; anything else is dropped (an id that cannot be a row is noise). */
function cleanUuid(v: unknown): string | null {
  const s = cleanText(v)
  return s && UUID_RE.test(s) ? s.toLowerCase() : null
}

/** A slug-ish token (creative names, QR slugs): letters, digits, `-`, `_`, `.`; lower-cased. */
export function attributionSlug(v: unknown): string | null {
  const s = cleanText(v)
  if (!s) return null
  const slug = s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
  return slug.length > 0 ? slug : null
}

type ParamSource =
  | Record<string, string | string[] | undefined>
  | URLSearchParams
  | null
  | undefined

function readParam(src: ParamSource, name: string): unknown {
  if (!src) return undefined
  if (src instanceof URLSearchParams) return src.get(name) ?? undefined
  return src[name]
}

/**
 * The attribution a landing-page hit carries, or null when it carries none. Every value is
 * sanitized here — the page, the action and the kernel all call this, so a forged shape posted
 * straight to the action is cleaned the same way a query string is.
 */
export function parseLeadMagnetAttribution(src: ParamSource): LeadMagnetAttribution | null {
  if (!src) return null
  const p = LEAD_MAGNET_ATTRIBUTION_PARAMS
  const out: LeadMagnetAttribution = {
    utmSource: attributionSlug(readParam(src, p.utmSource)),
    utmMedium: attributionSlug(readParam(src, p.utmMedium)),
    utmCampaign: cleanText(readParam(src, p.utmCampaign)),
    utmContent: cleanText(readParam(src, p.utmContent)),
    campaignId: cleanUuid(readParam(src, p.campaignId)),
    adCampaignId: cleanUuid(readParam(src, p.adCampaignId)),
    creative: attributionSlug(readParam(src, p.creative)),
    qr: attributionSlug(readParam(src, p.qr)),
  }
  return hasAttribution(out) ? out : null
}

/** True when at least one attribution field is present. */
function hasAttribution(a: LeadMagnetAttribution | null | undefined): boolean {
  if (!a) return false
  return Object.values(a).some((v) => typeof v === "string" && v.length > 0)
}

/** An attribution object re-parsed from an in-process shape (the action / kernel seam). */
export function sanitizeLeadMagnetAttribution(a: LeadMagnetAttribution | null | undefined): LeadMagnetAttribution | null {
  if (!a || typeof a !== "object") return null
  const p = LEAD_MAGNET_ATTRIBUTION_PARAMS
  const rec: Record<string, string | undefined> = {}
  for (const k of Object.keys(p) as Array<keyof LeadMagnetAttribution>) {
    const v = a[k]
    if (typeof v === "string") rec[p[k]] = v
  }
  return parseLeadMagnetAttribution(rec)
}

/**
 * The landing URL an ad (or any distribution) points at, carrying the attribution it should keep.
 * `origin` must be a real configured origin — the caller fails closed on an unset host
 * (lib/ads/ad-destination.ts publicOrigin); this builder never invents one.
 */
export function leadMagnetLandingUrl(origin: string, slug: string, attribution?: LeadMagnetAttribution | null): string {
  const base = `${origin.replace(/\/$/, "")}/lm/${encodeURIComponent(slug)}`
  const clean = sanitizeLeadMagnetAttribution(attribution)
  if (!clean) return base
  const qs = new URLSearchParams()
  const p = LEAD_MAGNET_ATTRIBUTION_PARAMS
  for (const k of Object.keys(p) as Array<keyof LeadMagnetAttribution>) {
    const v = clean[k]
    if (typeof v === "string" && v.length > 0) qs.set(p[k], v)
  }
  const s = qs.toString()
  return s ? `${base}?${s}` : base
}

/** marketing_campaign_touchpoints.channel (the live CHECK vocabulary — no 'ads' / 'search' value exists). */
type TouchpointChannel = "email" | "sms" | "direct_mail" | "social" | "qr_scan" | "blog" | "podcast" | "newsletter" | "phone" | "portal" | "video"

const SOCIAL_SOURCES = new Set(["facebook", "instagram", "meta", "linkedin", "tiktok", "youtube", "x", "twitter", "threads", "pinterest", "social"])
const SOCIAL_MEDIUMS = new Set(["social", "paid_social", "paidsocial", "paid-social"])

/**
 * The touchpoint CHANNEL a conversion is recorded under, or null when the live vocabulary has no
 * honest value for it (a paid-search click, for one — the contact-level campaign stamp still
 * carries the attribution; the blind spot is published by the proof rather than mapped to a
 * wrong channel).
 */
export function touchpointChannelFor(a: LeadMagnetAttribution | null | undefined): TouchpointChannel | null {
  if (!a) return null
  if (a.qr) return "qr_scan"
  const src = (a.utmSource ?? "").toLowerCase()
  const med = (a.utmMedium ?? "").toLowerCase()
  if (SOCIAL_SOURCES.has(src) || SOCIAL_MEDIUMS.has(med)) return "social"
  if (med === "email" || src === "email" || src === "newsletter") return med === "email" || src === "email" ? "email" : "newsletter"
  if (med === "sms" || src === "sms") return "sms"
  if (med === "video" || src === "video") return "video"
  if (med === "direct_mail" || med === "mail" || src === "direct_mail") return "direct_mail"
  return null
}

/** contacts.source_channel for a magnet capture — the kernel's existing 'online_form', plus the two
 *  arrivals the attribution can prove. */
export function sourceChannelFor(a: LeadMagnetAttribution | null | undefined): "qr_code" | "paid_ad" | "online_form" {
  if (!a) return "online_form"
  if (a.qr) return "qr_code"
  if (a.adCampaignId || /^paid/.test((a.utmMedium ?? "").toLowerCase()) || (a.utmMedium ?? "").toLowerCase() === "cpc") return "paid_ad"
  return "online_form"
}
