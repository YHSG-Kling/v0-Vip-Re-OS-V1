/**
 * scripts/canaries/lead-magnet.ts — LEAD MAGNET canary (wave 141, lane 141J):
 *   tenant builds → (AI draft) → human approves/publishes → QR/landing distribution → submission →
 *   attribution → canonical contact pipeline
 * through lib/kernel/lead-magnets.ts (createLeadMagnet → publishLeadMagnet → generateQRCode via the ONE
 * QR minter lib/marketing/tracked-qr.ts → captureFormSubmission). Owner (wave 141): "tenants create their
 * own lead magnets … AI builds the ACTUAL draft → human preview/edit/approve → publish → ads/QR/social/
 * website distribution → capture → attribution → outcome → learning." The AI draft, the ad attribution
 * columns (lane 141E) and the QR destination allow-list (lane 141F) are WAVE141 HOOKS.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"
import { hooksFor } from "./_registry"

export async function run() {
  const c = canary("Lead magnet: tenant builds → AI draft → human approves → QR/landing publish → submission → attribution → canonical pipeline")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: a submission creates a contact and enqueues enrichment — in-memory only")
  const B = uuid(), B2 = uuid(), U = uuid(), AG = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-lm` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-lm2` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
  })
  setSvc(svc)
  const { createLeadMagnet, publishLeadMagnet, captureFormSubmission, leadMagnetQrLabel } = await import("../../lib/kernel/lead-magnets")
  const created = await createLeadMagnet({ title: `${CANARY_TAG} Buyer Guide`, description: "first-time buyer guide", magnetType: "buyer_guide", brokerageId: B, agentId: AG, createdBy: U })
  c.step("tenant builder: createLeadMagnet writes the tenant's OWN lead_capture_forms record (canonical schema, default fields for the type)", created.success && !!created.magnetId && (svc.tables.lead_capture_forms ?? []).some((f) => f.id === created.magnetId && f.brokerage_id === B && Array.isArray(f.fields) && f.fields.length > 0 && f.magnet_type === "buyer_guide"), created.error ?? `magnet ${created.magnetId} slug ${created.slug}`)
  const M = created.magnetId ?? ""
  c.step("evidence: lead_magnet_created is emitted on THIS tenant (lifecycle_events)", (svc.tables.lifecycle_events ?? []).some((e) => e.brokerage_id === B && /lead_magnet_created/.test(String(e.event_type))), "")
  // WAVE141 HOOK (integrator): 141E — the AI draft; 141E — ad attribution; 141F — the QR allow-list.
  for (const h of hooksFor("lead-magnet")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract); continue }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary and assert the contract (WAVE141 HOOK (integrator): ${h.lane})`, false, h.contract.slice(0, 120))
  }
  const base = "https://canary.example"
  const pub = await publishLeadMagnet({ magnetId: M, brokerageId: B, channels: ["qr_code", "landing_page"], actorUserId: U, baseUrl: base })
  c.step("human approves → publish: publishLeadMagnet activates the form and returns the landing URL", pub.success && pub.urls?.landing === `${base}/lm/${created.slug}` && (svc.tables.lead_capture_forms ?? []).find((f) => f.id === M)?.is_active === true, pub.error ?? JSON.stringify(pub.urls))
  const qr = (svc.tables.qr_codes ?? []).filter((q) => q.label === leadMagnetQrLabel(M))
  c.step("QR distribution: ONE tracked qr_codes row under the tenant (purpose lead_magnet, destination landing_page, target = the landing URL) through the one minter", qr.length === 1 && qr[0].brokerage_id === B && qr[0].purpose === "lead_magnet" && qr[0].destination_type === "landing_page" && qr[0].target_url === pub.urls?.landing && !!qr[0].slug, `qr ${qr[0]?.slug}`)
  const again = await publishLeadMagnet({ magnetId: M, brokerageId: B, channels: ["qr_code"], actorUserId: U, baseUrl: base })
  c.step("idempotency: republishing reuses the same tracked code (one row for the magnet's key, never a split scan count)", again.success && (svc.tables.qr_codes ?? []).filter((q) => q.label === leadMagnetQrLabel(M)).length === 1, "")
  const stolen = await publishLeadMagnet({ magnetId: M, brokerageId: B2, channels: ["landing_page"], actorUserId: U, baseUrl: base })
  c.step("POSITIVE CONTROL (tenant boundary): another tenant cannot publish this magnet (brokerage predicate on the read)", !stolen.success, stolen.error ?? "published")
  const email = `jordan@${CANARY_EMAIL_DOMAIN}`
  const sub1 = await captureFormSubmission({ formId: M, brokerageId: B, submissionData: { first_name: "Jordan", last_name: "Canary", email, phone: "5125550123" }, tcpaConsentGiven: true, ipAddress: "203.0.113.9", userAgent: "canary" })
  const contact = (svc.tables.contacts ?? []).find((x) => x.id === sub1.contactId)
  c.step("submission → canonical pipeline: a NEW contact lands under the tenant, owned by the magnet's agent (agents.id), source lead_magnet / online_form, intent stamped from the magnet (buyer)", sub1.success && !!contact && contact.brokerage_id === B && contact.agent_id === AG && contact.source === "lead_magnet" && contact.source_channel === "online_form" && contact.contact_type === "buyer", sub1.error ?? `contact ${sub1.contactId}`)
  const rows = (svc.tables.form_submissions ?? []).filter((s) => s.form_id === M)
  c.step("attribution: the form_submissions row links form → contact and carries the consent record + provenance (ip, ua)", rows.length === 1 && rows[0].contact_id === sub1.contactId && rows[0].tcpa_consent_given === true && rows[0].ip_address === "203.0.113.9", "")
  const sub2 = await captureFormSubmission({ formId: M, brokerageId: B, submissionData: { first_name: "Jordan", last_name: "Canary", email }, tcpaConsentGiven: true })
  c.step("dedup: the same person again resolves to the SAME contact (one contacts row, two submissions)", sub2.success && sub2.contactId === sub1.contactId && (svc.tables.contacts ?? []).filter((x) => x.brokerage_id === B).length === 1 && (svc.tables.form_submissions ?? []).filter((s) => s.form_id === M).length === 2, sub2.error ?? "")
  const wrongTenant = await captureFormSubmission({ formId: M, brokerageId: B2, submissionData: { first_name: "X", last_name: "Y", email: `x@${CANARY_EMAIL_DOMAIN}` }, tcpaConsentGiven: true })
  c.step("POSITIVE CONTROL (tenant boundary): a submission naming a tenant that does not own the form is refused", !wrongTenant.success, wrongTenant.error ?? "accepted")
  const noConsent = await captureFormSubmission({ formId: M, brokerageId: B, submissionData: { first_name: "Sam", last_name: "Canary", email: `sam@${CANARY_EMAIL_DOMAIN}`, property_address: "9 Canary Way" }, tcpaConsentGiven: false })
  c.step("POSITIVE CONTROL (consent): a home-value submission without TCPA consent is refused by the kernel, not only by the HTTP door", !noConsent.success && /TCPA/i.test(noConsent.error ?? ""), noConsent.error ?? "accepted")
  c.blind("The deliverable copy, the sequence enrollment and contact enrichment are best-effort rails after the capture (stubbed by absence here); the ad/QR SCAN hop (app/api/qr/scan) is HTTP and not driven — the row the scanner resolves is asserted.")
  c.blind("The PNG is rendered by the vendored `qrcode` package; phone-camera readability (error correction, quiet zone, contrast) is lane 141F's test:qr-and-card-scanner.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
