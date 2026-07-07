// lib/lead-pipeline/portal-lead-intake.ts
// ─────────────────────────────────────────────────────────────────────────────
// PORTAL LEAD INTAKE — receiving contacts FROM Zillow / realtor.com / Opcity
// (ReadyConnect) etc. The standard delivery is a LEAD-NOTIFICATION EMAIL; the
// tenant auto-forwards them to their connected inbound address. OWNER'S RULE:
// the portal already routed this lead to a specific agent — it arrives as that
// agent's NEW CONTACT (the mailbox owner) via the gated contact-capture
// pipeline, never as a cold raw lead. Detection is conservative: only
// recognized portal senders parse; everything else returns null and the email
// flows to the existing intakes.

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

/**
 * Ingest one parsed portal lead as a CONTACT assigned to the RECEIVING AGENT
 * (owner's rule: the portal already routed this lead to a specific agent — it
 * arrives as that agent's new contact, never a cold raw lead). Rides the SAME
 * gated captureContact pipeline as every other front door (dedupe-by-identity,
 * canonical fields only, notes for the rest). TCPA basis: the consumer
 * submitted their contact info to the portal ASKING to be contacted about a
 * property — provenance recorded (portal + property), not assumed silently.
 * The agent gets a high-priority heads-up; the consented contact is then in
 * speed-to-lead's contacts sweep automatically.
 */
export async function ingestPortalLead(
  svc: any,
  brokerageId: string,
  lead: ParsedPortalLead,
  /** users.id of the mailbox owner the forwarded email arrived on — the agent
   *  the portal routed this lead to. Omitted → normal assignment rules. */
  receivingAgentUserId?: string | null,
): Promise<{ ok: boolean; contactId?: string; action?: string; error?: string }> {
  const noteBits = [
    `Portal lead via ${lead.portal}`,
    lead.propertyAddress ? `Property: ${lead.propertyAddress}` : null,
    lead.message ? `Message: "${lead.message}"` : null,
  ].filter(Boolean)

  try {
    const { captureContact } = await import("@/lib/contact-pipeline/contact-capture")
    const r = await captureContact({
      brokerageId,
      agentUserId: receivingAgentUserId ?? null, // converted to agents.id internally
      source: "portal_lead",
      first_name: lead.firstName || null,
      last_name: lead.lastName || null,
      email: lead.email,
      phone: lead.phone,
      notes: noteBits.join(" · "),
      contact_type: "buyer",
      lead_temperature: "hot", // an active property inquiry IS hot — the portal's whole product
      tcpa_consent: true,
      tcpa_consent_date: new Date().toISOString(),
      tcpa_consent_source: `portal_inquiry:${lead.portal}`,
      tcpa_consent_text: `Consumer submitted contact info to ${lead.portal} requesting information${lead.propertyAddress ? ` about ${lead.propertyAddress}` : ""}.`,
      rawPayload: { portal: lead.portal, property_address: lead.propertyAddress, message: lead.message, intake: "inbound-mail" },
    })

    // The agent's heads-up — speed-to-lead engages, but the human should KNOW now.
    if (receivingAgentUserId) {
      await svc.from("notifications").insert({
        user_id: receivingAgentUserId, brokerage_id: brokerageId, type: "portal_lead_received",
        title: `New ${lead.portal} lead: ${[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "unnamed"}`,
        body: `${lead.propertyAddress ? `Asking about ${lead.propertyAddress}. ` : ""}${lead.message ? `"${lead.message.slice(0, 160)}" ` : ""}They're in your contacts — the AI team is engaging.`,
        entity_type: "contact", entity_id: r.contactId, priority: "high", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
    }
    return { ok: true, contactId: r.contactId, action: r.action }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "capture failed" }
  }
}
