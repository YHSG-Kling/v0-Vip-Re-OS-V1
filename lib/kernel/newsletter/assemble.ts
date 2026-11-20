/**
 * lib/kernel/newsletter/assemble.ts
 *
 * Per-recipient newsletter assembly. A newsletter is NOT one flat blob — it's a
 * stack of `newsletter_sections` ordered by `order_index`, each optionally
 * scoped to a list of personas (`target_personas`). Sections with NULL personas
 * render for everyone; sections with a list render only when the recipient's
 * `contacts.contact_persona` matches.
 *
 * Schema linkage: `newsletter_sections.newsletter_id` FK targets
 * `newsletter_campaigns.id` — i.e. the campaign IS the newsletter for sections.
 * Callers pass the campaign id as `newsletterId`.
 *
 * The send-path looks like:
 *
 *   campaign  → resolveSectionsForRecipient(persona) → assembleNewsletterHtml()
 *             → dispatchEmail() (compliance + suppression + de-conflict gates)
 *             → newsletter_sends row written
 *
 * Inputs and outputs are pure — no DB writes, no network. Designed to be
 * unit-testable and composable from both the publish-newsletters cron and the
 * future Brand/Listing Orchestrator agent.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { defaultOrderFor, type NewsletterSectionType } from "./section-types"
import { escapeHtmlBasic as escapeHtml } from "@/lib/format/html"

export interface NewsletterSection {
  id:              string
  newsletter_id:   string
  brokerage_id:    string | null
  title:           string | null
  content:         string | null
  order_index:     number | null
  target_personas: string[] | null
  section_type:    NewsletterSectionType | null
  target_locations: {
    cities?:    string[]
    states?:    string[]
    zip_codes?: string[]
  } | null
}

export interface RecipientLocation {
  city?:     string | null
  state?:    string | null
  zip_code?: string | null
}

export interface CampaignAssemblyContext {
  campaignId:        string
  brokerageId:       string
  newsletterId:      string | null
  campaignSubject:   string | null
  campaignBodyHtml:  string | null
}

export interface AssembledNewsletter {
  subject: string
  html:    string
  text:    string
  /** Sections this recipient actually saw (for analytics). */
  rendered_section_ids: string[]
}

/**
 * Resolve the section list for a recipient. Returns sections in order_index
 * order, filtered to those whose target_personas list is NULL or contains the
 * recipient's persona.
 */
export async function resolveSectionsForRecipient(args: {
  brokerageId:    string
  newsletterId:   string
  recipientPersona:  string | null
  recipientLocation?: RecipientLocation | null
}): Promise<NewsletterSection[]> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("newsletter_sections")
    .select("id, newsletter_id, brokerage_id, title, content, order_index, target_personas, section_type, target_locations")
    .eq("brokerage_id", args.brokerageId)
    .eq("newsletter_id", args.newsletterId)

  const all = (data ?? []) as NewsletterSection[]
  const persona = args.recipientPersona ?? null
  const loc     = args.recipientLocation ?? null

  const filtered = all.filter(s => matchesRecipient(s, persona, loc))

  // Sort: explicit order_index first; fall back to the section_type's default
  // weight from the canonical taxonomy. Sections with neither stay stable.
  return filtered.sort((a, b) => {
    const ao = a.order_index ?? defaultOrderFor(a.section_type)
    const bo = b.order_index ?? defaultOrderFor(b.section_type)
    return ao - bo
  })
}

/** Decide whether a section qualifies for a given recipient. Two filters:
 *
 *  1. PERSONA — target_personas NULL/empty = everyone; otherwise the
 *     recipient's contact_persona must be in the list.
 *  2. LOCATION — target_locations NULL = everyone; otherwise the recipient's
 *     city / state / zip_code must match at least one entry in any of the
 *     three buckets ({cities[], states[], zip_codes[]}). Case-insensitive
 *     on city + state.
 */
function matchesRecipient(s: NewsletterSection, persona: string | null, loc: RecipientLocation | null): boolean {
  // Persona
  if (s.target_personas && s.target_personas.length > 0) {
    if (persona === null || !s.target_personas.includes(persona)) return false
  }
  // Location
  const tl = s.target_locations
  if (tl && (tl.cities?.length || tl.states?.length || tl.zip_codes?.length)) {
    if (!loc) return false
    const city  = (loc.city  ?? "").trim().toLowerCase()
    const state = (loc.state ?? "").trim().toUpperCase()
    const zip   = (loc.zip_code ?? "").trim()
    const cityHit  = (tl.cities    ?? []).some((c) => c.trim().toLowerCase() === city  && city  !== "")
    const stateHit = (tl.states    ?? []).some((s2) => s2.trim().toUpperCase() === state && state !== "")
    const zipHit   = (tl.zip_codes ?? []).some((z) => z.trim() === zip && zip !== "")
    if (!cityHit && !stateHit && !zipHit) return false
  }
  return true
}

/**
 * Assemble the final HTML + plain-text body for a recipient. The campaign's own
 * body (newsletter_campaigns.content) acts as the intro / framing layer; the
 * per-persona sections are stacked after it. Email assembly (signature +
 * unsubscribe + disclosures) is added downstream by assembleEmail() in dispatch.
 */
export function assembleNewsletterHtml(args: {
  context:  CampaignAssemblyContext
  sections: NewsletterSection[]
  /** WAVE 155 (155E) — the ONE optional QR slot, resolved by lib/marketing/tracked-qr.ts resolveArtifactQrSlot (slot
   *  `email_link` for the email body, `print_footer` for the print / PDF form). Absent → nothing is added. */
  qr?:      NewsletterQrSlot | null
}): AssembledNewsletter {
  const { context, sections } = args

  const intro = (context.campaignBodyHtml ?? "").trim()
  const sectionBlocks = sections.map(s => {
    const t = (s.title ?? "").trim()
    const c = (s.content ?? "").trim()
    if (!c) return ""
    return [
      t ? `<h2 style="margin:24px 0 8px 0;font-size:18px;line-height:1.3">${escapeHtml(t)}</h2>` : "",
      `<div style="margin:0 0 16px 0;line-height:1.55">${c}</div>`,
    ].filter(Boolean).join("")
  }).filter(Boolean)

  const qrBlock = newsletterQrBlock(args.qr)
  const html = [intro, ...sectionBlocks, qrBlock.html].filter(Boolean).join("\n")

  // Plaintext fallback — strip tags conservatively for clients without HTML.
  const text = [intro, ...sections.map(s => {
    const t = (s.title ?? "").trim()
    const c = (s.content ?? "").trim()
    if (!c) return ""
    return [t ? `## ${t}` : "", stripHtml(c)].filter(Boolean).join("\n")
  }), qrBlock.text].filter(Boolean).join("\n\n")

  return {
    subject: (context.campaignSubject ?? "Your Newsletter").trim() || "Your Newsletter",
    html,
    text,
    rendered_section_ids: sections.map(s => s.id),
  }
}

/**
 * WAVE 155 (lane 155E) — the newsletter's QR slot. Owner: "qr code is missing from remotion, blogs, newsletter, etc."
 * Inside an EMAIL a QR is the wrong form (the reader is already on the device): the email carries the code's tracked
 * scan URL as a CLICKABLE link, so a click is counted on the same code. The PRINT / PDF form carries the QR image at
 * 1 in (96 CSS px) on an opaque white plate — above the 0.8 in minimum (qr-contract.ts QR_PLACEMENT_MINIMUMS). Both
 * sit AFTER the sections and BEFORE the signature / unsubscribe / disclosures assembleEmail() appends downstream, so
 * the slot never covers readable content or a legal disclosure. The URL is always the tracked /api/qr/scan URL.
 */
export interface NewsletterQrSlot {
  form:          "email" | "print"
  scanUrl:       string
  /** Required for the print form (the image); ignored for email. */
  qrCodeDataUrl?: string | null
  caption?:      string | null
}

export function newsletterQrBlock(slot: NewsletterQrSlot | null | undefined): { html: string; text: string } {
  if (!slot || !/\/api\/qr\/scan\?slug=/.test(slot.scanUrl)) return { html: "", text: "" }
  const caption = (slot.caption ?? "").trim() || (slot.form === "email" ? "See what's new near you" : "Scan to see what's new near you")
  const href = escapeHtml(slot.scanUrl)
  if (slot.form === "email") {
    return {
      html: `<p data-qr-slot="email_link" style="margin:24px 0 8px 0"><a href="${href}" style="font-weight:600">${escapeHtml(caption)}</a></p>`,
      text: `${caption}: ${slot.scanUrl}`,
    }
  }
  if (!slot.qrCodeDataUrl) return { html: "", text: "" }
  return {
    html: `<div data-qr-slot="print_footer" style="margin:24px 0 8px 0;display:flex;align-items:center;gap:12px"><div style="background:#ffffff;padding:4px;line-height:0"><img src="${escapeHtml(slot.qrCodeDataUrl)}" width="96" height="96" alt="QR code: ${escapeHtml(caption)}" style="width:1in;height:1in" /></div><div style="font-size:14px;line-height:1.4">${escapeHtml(caption)}</div></div>`,
    text: `${caption}: ${slot.scanUrl}`,
  }
}

// TOMBSTONE: local escapeHtml merged onto lib/format/html.ts escapeHtmlBasic
// (imported above as `escapeHtml`) — §1/§6 SAME BODY census round 3,
// 2026-09-09.

function stripHtml(s: string): string {
  return s.replace(/<\/?[^>]+>/g, "").replace(/\s+\n/g, "\n").trim()
}
