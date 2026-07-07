// lib/lead-pipeline/portal-lead-intake.ts
// ─────────────────────────────────────────────────────────────────────────────
// PORTAL LEAD INTAKE — receiving contacts FROM Zillow / realtor.com / Opcity
// (ReadyConnect) etc. The standard delivery is a LEAD-NOTIFICATION EMAIL; the
// tenant auto-forwards them to their connected inbound address and this parser
// turns each into a raw_scraped_leads row (source 'portal_lead' — the highest-
// intent buyer class) so the ONE gated pipeline (dedupe → suppression →
// promotion) and speed-to-lead take it from there. No new pipeline; a new
// front door. Detection is conservative: only recognized portal senders parse;
// everything else returns null and the email flows to the existing intakes.

export interface ParsedPortalLead {
  portal: "zillow" | "realtor_com" | "opcity"
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  propertyAddress: string | null
  message: string | null
}

const PORTAL_SENDERS: Array<{ portal: ParsedPortalLead["portal"]; pattern: RegExp }> = [
  { portal: "zillow", pattern: /@(convo\.)?zillow\.com$|@zillowmail\.com$/i },
  { portal: "realtor_com", pattern: /@(leads\.)?realtor\.com$|@move\.com$/i },
  { portal: "opcity", pattern: /@opcity\.com$|@readyconnectconcierge\.com$/i },
]

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/

/** PURE: is this sender a recognized lead portal? */
export function detectPortal(fromEmail: string | null | undefined): ParsedPortalLead["portal"] | null {
  const from = (fromEmail ?? "").trim().toLowerCase()
  if (!from) return null
  for (const s of PORTAL_SENDERS) if (s.pattern.test(from)) return s.portal
  return null
}

/** PURE: parse a portal lead-notification email. Conservative — a recognized
 *  sender whose body yields NO name and NO contact info returns null (we never
 *  fabricate a lead from an unparseable digest/marketing email). */
export function parsePortalLeadEmail(input: {
  fromEmail: string | null
  subject: string | null
  bodyText: string | null
}): ParsedPortalLead | null {
  const portal = detectPortal(input.fromEmail)
  if (!portal) return null
  const subject = input.subject ?? ""
  const body = input.bodyText ?? ""

  // Name: labeled line first ("Name: Dana Kling"), else the subject's
  // "<Name> is (requesting|interested)" pattern the portals all use.
  let name =
    body.match(/(?:^|\n)\s*(?:name|contact|client)\s*[:\-]\s*([A-Za-z][A-Za-z' .-]{1,60})/i)?.[1]?.trim() ??
    subject.match(/^([A-Za-z][A-Za-z' .-]{1,60}?)\s+(?:is\s+(?:requesting|interested)|sent you|would like|wants)/i)?.[1]?.trim() ??
    null

  // Contact email: a labeled/body email that is NOT the portal's own sender.
  const bodyEmails = (body.match(new RegExp(EMAIL_RE.source, "gi")) ?? [])
    .filter((e) => !detectPortal(e))
  const email = bodyEmails[0] ?? null
  const phone = body.match(PHONE_RE)?.[0]?.trim() ?? null
  if (!name && !email && !phone) return null

  // Property: labeled line, else the subject's "about <address>" tail.
  const propertyAddress =
    body.match(/(?:^|\n)\s*(?:property|address|regarding|listing)\s*[:\-]\s*([^\n]{6,120})/i)?.[1]?.trim() ??
    subject.match(/(?:about|regarding|for)\s+(\d+[^,\n]{4,80}(?:,[^,\n]{2,40}){0,2})/i)?.[1]?.trim() ??
    null

  const message = body.match(/(?:^|\n)\s*(?:message|comments?|says?)\s*[:\-]\s*([^\n]{3,300})/i)?.[1]?.trim() ?? null

  const parts = (name ?? "").split(/\s+/).filter(Boolean)
  return {
    portal,
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
    email,
    phone,
    propertyAddress,
    message,
  }
}

/** Ingest one parsed portal lead into the gated pipeline: raw_scraped_leads
 *  (source 'portal_lead') → processRawRecord (dedupe/suppression/promotion) —
 *  and speed-to-lead does the rest. Returns the raw record id. */
export async function ingestPortalLead(
  svc: any,
  brokerageId: string,
  lead: ParsedPortalLead,
): Promise<{ ok: boolean; rawId?: string; error?: string }> {
  const { data: raw, error } = await svc.from("raw_scraped_leads").insert({
    brokerage_id: brokerageId,
    source: "portal_lead",
    source_channel: "email",
    // source_origin is OWNERSHIP (platform|brokerage) — a portal lead arrives on
    // the TENANT's own lead source; the portal name lives in raw_data.portal.
    source_origin: "brokerage",
    first_name: lead.firstName || null,
    last_name: lead.lastName || null,
    email: lead.email,
    phone: lead.phone,
    address: lead.propertyAddress,
    processing_status: "pending",
    raw_data: {
      portal: lead.portal,
      message: lead.message,
      property_address: lead.propertyAddress,
      intake: "inbound-mail",
    },
  }).select("id").single()
  if (error || !raw) return { ok: false, error: error?.message ?? "raw insert failed" }

  try {
    const { processRawRecord } = await import("@/lib/lead-pipeline/pipeline-processor")
    await processRawRecord((raw as any).id, brokerageId)
  } catch (e) {
    // The raw row stands — the pipeline crons will pick it up; never lose a lead.
    console.error("[portal-lead-intake] immediate processing failed (raw row kept):", e)
  }
  return { ok: true, rawId: (raw as any).id }
}
