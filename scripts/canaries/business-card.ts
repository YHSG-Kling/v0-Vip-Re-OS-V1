/**
 * scripts/canaries/business-card.ts — BUSINESS CARD canary (wave 141, lane 141J):
 *   scan → verify → contact → workflow
 * through the ONE classifier (lib/contacts/card-classifier.ts classifyCardSubject — reader fields, then the
 * agent's notes, default UNKNOWN never contact) and the ONE consented-capture chokepoint
 * (lib/contact-pipeline/contact-capture.ts captureContact — dedup → merge/create → evidence). Owner
 * (wave 141): "scan → AI vision extraction → confidence → human confirmation where needed → identity/dedup →
 * canonical contact → attribution/source → follow-up. No second OCR system; never overwrite
 * higher-confidence data with weak extraction." The session door (app/actions/business-card/
 * business-card-actions.ts uploadBusinessCard: identity from the SESSION, Claude Vision through the AI
 * Gateway, the scan audit row with its confidence, BUSINESS_CARD_UPLOADED) is asserted on STRIPPED source
 * because it needs a request; per-FIELD confidence + the field-level merge rule (lane 141F) is a WAVE141 HOOK.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"
import { hooksFor, listFiles, strippedRepo } from "./_registry"

/** PURE: import specifiers naming a second OCR package in a stripped source. Word-bounded on both sides —
 *  the first reading matched "s·ocr·ata" (lib/external/*, the Socrata permit feeds), a false accusation. */
export function secondOcrImports(stripped: string): string[] {
  return [...stripped.matchAll(/(?:from|import|require\()\s*["']([^"']+)["']/g)].map((m) => m[1]).filter((s) => /(^|[^a-z])(tesseract|ocr)(?![a-z])/i.test(s))
}

export async function run() {
  const c = canary("Business card: scan → verify → contact → workflow")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: a capture creates a contact + enrichment — in-memory only")
  const B = uuid(), U = uuid(), AG = uuid(), DANA = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-card` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    // Higher-confidence data already on file: a classified, warm contact.
    contacts: [{ id: DANA, brokerage_id: B, agent_id: AG, first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, phone: "5125550199", phone_digits: "5125550199", contact_type: "seller", lead_temperature: "hot", status: "active", tcpa_consent: true, notes: `${CANARY_TAG} on file` }],
  })
  setSvc(svc)
  const { classifyCardSubject } = await import("../../lib/contacts/card-classifier")
  c.step("verify (reader fields): a fellow REALTOR's card is AGENT — a recruiting prospect, never the client CRM", classifyCardSubject({ title: "Realtor", company: "Harbor Realty" }).subjectType === "agent", "")
  const vendor = classifyCardSubject({ title: "Loan Officer", company: "Gulf Mortgage" })
  c.step("verify (reader fields): a lender's card is VENDOR with its category — the vendor book, never a contact", vendor.subjectType === "vendor" && !!vendor.category, JSON.stringify(vendor))
  c.step("verify (agent notes): 'potential buyer' in the notes is POTENTIAL_CONTACT; 'old friend' is SPHERE", classifyCardSubject({ notes: "met at the open house, potential buyer" }).subjectType === "potential_contact" && classifyCardSubject({ notes: "old friend from church" }).subjectType === "sphere", "")
  c.step("POSITIVE CONTROL (owner 2026-09-10): reader and notes silent → UNKNOWN, never assumed 'contact'", classifyCardSubject({ title: "", company: "", notes: "" }).subjectType === "unknown", "")
  const { captureContact } = await import("../../lib/contact-pipeline/contact-capture")
  const cap = await captureContact({ brokerageId: B, source: "business_card", ownerAgentId: AG, first_name: "Jordan", last_name: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, phone: "5125550123", tcpa_consent: false, notes: `${CANARY_TAG} card from the expo` })
  const jordan = (svc.tables.contacts ?? []).find((x) => x.id === cap.contactId)
  c.step("contact: captureContact creates the canonical contact under the tenant — source business_card, owner = the scanning agent (agents.id), consent NOT assumed", cap.action === "created" && !!jordan && jordan.brokerage_id === B && jordan.agent_id === AG && jordan.source === "business_card" && jordan.tcpa_consent === false, `contact ${cap.contactId}`)
  const cap2 = await captureContact({ brokerageId: B, source: "business_card", ownerAgentId: AG, first_name: "Jordan", last_name: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, tcpa_consent: false, notes: `${CANARY_TAG} second card` })
  const jordan2 = (svc.tables.contacts ?? []).find((x) => x.id === cap.contactId)
  c.step("dedup: the same card again MERGES onto the same contact (one row); notes are APPENDED, never overwritten", cap2.action === "merged" && cap2.contactId === cap.contactId && (svc.tables.contacts ?? []).filter((x) => x.brokerage_id === B && x.email === `jordan@${CANARY_EMAIL_DOMAIN}`).length === 1 && /expo/.test(String(jordan2?.notes)) && /second card/.test(String(jordan2?.notes)), String(jordan2?.notes).slice(0, 120))
  const weak = await captureContact({ brokerageId: B, source: "business_card", ownerAgentId: AG, first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, tcpa_consent: false, contact_type: null, lead_temperature: "cold" })
  const dana = (svc.tables.contacts ?? []).find((x) => x.id === DANA)
  c.step("never overwrite higher-confidence data: a weak scan of a contact on file merges FILL-IF-EMPTY — classification (seller / hot) and consent stay", weak.action === "merged" && weak.contactId === DANA && dana?.contact_type === "seller" && dana?.lead_temperature === "hot" && dana?.tcpa_consent === true, JSON.stringify({ type: dana?.contact_type, temp: dana?.lead_temperature }))
  let viability = false
  try { await captureContact({ brokerageId: B, source: "business_card", ownerAgentId: AG, first_name: "Nobody", tcpa_consent: false }) } catch (e) { viability = /viability/i.test((e as Error).message) }
  c.step("POSITIVE CONTROL (viability): a card with a name but no reachable channel is refused by the capture gate", viability, "")
  c.step("workflow: capture evidence lands (CONTACT_CAPTURED / dedup event rows on this tenant)", (svc.tables.lifecycle_events ?? []).some((e) => e.brokerage_id === B) || (svc.tables.activities ?? []).some((e) => e.brokerage_id === B), `lifecycle=${(svc.tables.lifecycle_events ?? []).length} activities=${(svc.tables.activities ?? []).length}`)
  // THE SESSION DOOR, on stripped source (it needs a request + the Vision provider).
  const door = strippedRepo("app/actions/business-card/business-card-actions.ts") ?? ""
  const gateAt = door.search(/\bawait\s+requireCaller\s*\(/), svcAt = door.search(/\bcreateServiceClient\s*\(/)
  c.step("scan door: identity from the SESSION (requireCaller) BEFORE the service client; the agent id is the session's agents row", gateAt >= 0 && svcAt > gateAt && /auth\.agentId/.test(door), "")
  c.step("scan door: ONE vision path — the extraction goes through the AI Gateway (gatewayChat) and lands a business_card_scans audit row with confidence_score + review_status; BUSINESS_CARD_UPLOADED is emitted", /\bgatewayChat\s*\(/.test(door) && /["']business_card_scans["']/.test(door) && /confidence_score/.test(door) && /review_status/.test(door) && /BUSINESS_CARD_UPLOADED/.test(door), "")
  const second = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))].filter((f) => secondOcrImports(strippedRepo(f) ?? "").length > 0)
  c.step("no second OCR system: no runtime module imports a tesseract/ocr package", second.length === 0, second.join(", ") || "0 files")
  c.step("POSITIVE CONTROL: the finder catches `tesseract.js` and `node-ocr`, ignores the gateway import and the Socrata feed (s·ocr·ata)", secondOcrImports(`import Tesseract from "tesseract.js"\nimport ocr from "node-ocr"\nimport { gatewayChat } from "@/lib/ai/gateway-chat"\nimport { socrata } from "@/lib/external/socrata-client"`).length === 2)
  // WAVE141 HOOK (integrator): 141F — per-field confidence + the merge rule.
  for (const h of hooksFor("business-card")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "at HEAD confidence is ONE number (filled fields / 8) on the scan row; the merge rule is captureContact's fill-if-empty"); continue }
    c.step(`${h.lane} landed (${at}) — wire the per-field confidence + merge rule into this canary (WAVE141 HOOK (integrator): 141F)`, false, "")
  }
  c.blind("Claude Vision is never called (no image); the extraction JSON → confidence → viability math lives inside the session door and is asserted on its source, not executed.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
