/**
 * scripts/canaries/wave147-consented-intake.ts — CONSENTED INTAKE canary (wave 147, lane 147J; owner ruling 1, contract C8 —
 * lane 147A):
 *   "When a person enters their info on a form, etc. there is a consent box so these need to go in as a contact not a lead."
 *   → a consented, identifiable submission → the CONTACT (in the FORM OWNER's tenant) — no lead row → ONE consent row carrying
 *     the scope (wording hash + version, purposes, channels, evidence, idempotency key, person) → Customer 360 enrichment
 *     STARTED (the survivor's queue row) → the welcome IMMEDIATELY (inside the same capture call) → the arbiter's desk told
 *     (data_steward → ai_isa contact_consented_intake) → the action ledger row; a duplicate submission → the SAME contact; a
 *     replay re-reads, never re-acts; a form owned by another tenant → refused, nothing written.
 *
 * Driven through the REAL module: lib/contact-pipeline/contact-capture.ts captureConsentedContact (→ captureContact →
 * completeConsentedIntake → persistContactConsent / queueContactEnrichment / publishManagerSignal / withActionLedger). Seamed
 * edges, exactly lane 147A's proof's: emitKernelEvent (recorded, not fanned out), ensureClientWelcome and the portal-invite mail
 * (recorded, never sent). Rule steps read STRIPPED source.
 */
import { setSvc } from "./_harness"
import { strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { canary147, jsonOf, seams, tbl } from "./wave147-harness"

const A = "a1470000-0000-4000-8000-00000000c0a1"
const B = "a1470000-0000-4000-8000-00000000c0b1"
const AGENT_A = "a1470000-0000-4000-8000-00000000ca01"
const AGENT_B = "a1470000-0000-4000-8000-00000000cb01"
const QR_A = "a1470000-0000-4000-8000-00000000cc01"
const QR_B = "a1470000-0000-4000-8000-00000000cc02"
const RAW_LEAD = "a1470000-0000-4000-8000-00000000cd01"
const WORDING = "By submitting this form, I consent to receive calls, texts, and emails from this agent and their brokerage regarding real estate services. I understand I may opt out at any time. Message and data rates may apply."

function world() {
  return memSupabase({
    brokerages: [{ id: A, name: "Harbor Realty 147J" }, { id: B, name: "Bayside Homes 147J" }],
    agents: [
      { id: AGENT_A, brokerage_id: A, user_id: "u-147j-a1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: AGENT_B, brokerage_id: B, user_id: "u-147j-b1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" },
    ],
    users: [],
    qr_codes: [{ id: QR_A, brokerage_id: A, agent_id: AGENT_A, slug: "harbor-147j" }, { id: QR_B, brokerage_id: B, agent_id: AGENT_B, slug: "bayside-147j" }],
    contacts: [],
    // A purchased / anonymous raw lead of SOMEONE ELSE — the "no lead row" finder's positive control (it must still see it).
    leads: [{ id: RAW_LEAD, brokerage_id: A, first_name: "Purchased", last_name: "Record", email: "list-row@example.test", phone: null, contact_id: null, is_active: true, lifecycle_state: "raw" }],
    contact_consent_events: [], lead_enrichment_queue: [], manager_signals: [], agent_action_ledger: [], lifecycle_events: [],
    person_identities: [], person_identity_evidence: [], lead_score_history: [], assignment_rules: [], transactions: [],
    activities: [], notifications: [], protected_research_attributes: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], contact_consent_events: [["brokerage_id", "idempotency_key"]] } })
}

export async function run() {
  const c = canary147("Consented intake (C8): a consented form → a CONTACT (never a lead) with a scoped consent record, enrichment started, the welcome at once and the arbiter told; a duplicate → the same contact; another tenant's form → refused")
  const svc = c.track(world(), A, B)
  setSvc(svc)
  const w = seams(); w.recordEmit = true; w.recordWelcome = true
  const cap = await quiet(async () => import("../../lib/contact-pipeline/contact-capture")) as unknown as Record<string, any>
  const consent = await quiet(async () => import("../../lib/kernel/compliance/require-contact-consent")) as unknown as Record<string, any>
  const params = (over: Record<string, unknown> = {}) => ({
    brokerageId: A, ownerAgentId: AGENT_A, source: "qr_scan", first_name: "Marisol", last_name: "Vega",
    email: "marisol.vega@example.test", phone: "+15125550147", preferred_channel: "phone",
    consents: [{ family: "phone", given: true, text: WORDING, textVersion: "qr_landing:v1", purposes: ["requested_information"] }],
    intake: { capturedAt: "2026-10-31T12:00:00.000Z", channel: "qr", sourceUrl: "/qr/harbor-147j", evidence: { qr_code_id: QR_A, ip: "203.0.113.47", user_agent: "canary" }, formOwner: { table: "qr_codes", id: QR_A } },
    ...over,
  })
  const capture = async (p: Record<string, unknown>) => (await quiet(async () => cap.captureConsentedContact(p, { client: svc }))) as Record<string, any>
  const counts = () => ({ contacts: tbl(svc, "contacts").length, consent: tbl(svc, "contact_consent_events").length, signals: tbl(svc, "manager_signals").length, welcomes: w.welcomes.length, ledger: tbl(svc, "agent_action_ledger").length, leads: tbl(svc, "leads").length })

  // ── 1 · the submission → a CONTACT, never a lead ──
  const leadsBefore = tbl(svc, "leads").length
  const welcomesBefore = w.welcomes.length
  const r1 = await capture(params())
  const contact = tbl(svc, "contacts").find((x) => x.id === r1.contactId)
  await c.check("147A", "A CONSENTED, IDENTIFIABLE SUBMISSION GOES IN AS A CONTACT IN THE FORM OWNER'S TENANT (ruling 1: 'these need to go in as a contact not a lead'): captureConsentedContact creates the contact, owned by the QR code's agent, stamped with the exact consent wording", () => ({
    ok: r1.ok === true && r1.action === "created" && contact?.brokerage_id === A && contact?.agent_id === AGENT_A && contact?.tcpa_consent === true && contact?.tcpa_consent_text === WORDING,
    evidence: `ok ${r1.ok}, action ${r1.action}, refused ${r1.refused ?? "—"}${r1.ok ? "" : ` (${String(r1.reason ?? "").slice(0, 200)}; warnings ${jsonOf(r1.warnings ?? []).slice(0, 200)})`}; contact tenant ${contact?.brokerage_id === A ? "A (the form owner)" : contact?.brokerage_id}, agent ${contact?.agent_id === AGENT_A ? "the QR agent" : contact?.agent_id}, wording stamped ${contact?.tcpa_consent_text === WORDING}`,
  }))
  const seededLeadSeen = tbl(svc, "leads").filter((l) => l.email === "list-row@example.test").length
  c.rule("147A", "NO LEAD ROW IS CREATED FOR A CONSENTED PERSON (ruling 1; C8 'No intermediate lead for qualification') — and the lead finder is not blind: it still sees the seeded purchased record (POSITIVE CONTROL)",
    tbl(svc, "leads").length === leadsBefore && !tbl(svc, "leads").some((l) => l.email === "marisol.vega@example.test") && seededLeadSeen === 1,
    `leads ${leadsBefore} → ${tbl(svc, "leads").length}; a lead for the submitter: ${tbl(svc, "leads").some((l) => l.email === "marisol.vega@example.test") ? "CREATED" : "none"}; control sees the seeded record ${seededLeadSeen}×`)

  // ── 2 · the consent record with its scope ──
  const rows = tbl(svc, "contact_consent_events").filter((e) => e.contact_id === r1.contactId)
  const row = rows[0] ?? {}
  await c.check("147A", "ONE CONSENT ROW CARRIES THE SCOPE (C8 consent: { text_hash, text_version, captured_at, scope: purposes[], channel, source_url, evidence }): the wording's hash (the module's own consentTextHash) + version, the purposes the form offered plus the wording's broad grant, EXACTLY the channels the wording names, the evidence pointer, the idempotency key and the canonical person", () => {
    const purposes = [...(row.purposes ?? [])].sort(), channels = [...(row.channels ?? [])].sort()
    const ok = rows.length === 1 && row.consented === true && row.consent_text_hash === consent.consentTextHash(WORDING) && row.consent_text_version === "qr_landing:v1"
      && purposes.includes("requested_information") && jsonOf(channels) === jsonOf(["email", "sms", "voice"]) && row.evidence?.qr_code_id === QR_A && row.source_url === "/qr/harbor-147j"
      && row.captured_at === "2026-10-31T12:00:00.000Z" && typeof row.idempotency_key === "string" && row.idempotency_key.startsWith(String(r1.idempotencyKey)) && !!row.person_id
    return { ok, evidence: `${rows.length} row(s); hash ${row.consent_text_hash === consent.consentTextHash(WORDING) ? "= consentTextHash(wording)" : row.consent_text_hash}; version ${row.consent_text_version}; purposes ${jsonOf(purposes)}; channels ${jsonOf(channels)}; evidence qr ${row.evidence?.qr_code_id === QR_A}; key ${row.idempotency_key}; person ${row.person_id ? "set" : "∅"}` }
  })
  await c.check("147A", "THE ARBITER CAN ANSWER 'MAY I TEXT THIS PERSON ABOUT EQUITY?' FROM THE RECORD ALONE (lane 147A creative latitude, consumed by customer-360): yes for sms (the wording names it), no for direct mail (never named — nothing inferred); POSITIVE CONTROL: the 'no' is the channel rule, not a blind reader", async () => {
    const scope = await consent.consentScopeFor(svc, { brokerageId: A, contactId: r1.contactId })
    const sms = consent.answerConsentQuestion(scope, { channel: "sms", purpose: "equity_review" })
    const mail = consent.answerConsentQuestion(scope, { channel: "direct_mail", purpose: "equity_review" })
    return { ok: sms.allowed === true && sms.consentEventId === row.id && mail.allowed === false && mail.basis === "channel_not_named", evidence: `sms/equity → ${sms.allowed ? "yes" : "no"} (${sms.basis}, row ${sms.consentEventId === row.id ? "cited" : sms.consentEventId}); direct mail → ${mail.allowed ? "YES" : "no"} (${mail.basis})` }
  })

  // ── 3 · enrichment started, the welcome at once, the arbiter told, the ledger row ──
  c.rule("147A", "CUSTOMER 360 ENRICHMENT STARTS IMMEDIATELY (C8 '→ Customer 360 enrichment start'; lane 147A item 6): the survivor's own lead_enrichment_queue row is pending for the new contact and the result says so",
    r1.enrichmentQueued === true && tbl(svc, "lead_enrichment_queue").some((q) => q.contact_id === r1.contactId && q.status === "pending"),
    `enrichmentQueued ${r1.enrichmentQueued}; queue rows for the contact ${tbl(svc, "lead_enrichment_queue").filter((q) => q.contact_id === r1.contactId).length}`)
  c.rule("147A", "THE WELCOME GOES IMMEDIATELY (C8 '→ welcome (immediate)'; ruling 6 of wave 146): ensureClientWelcome ran for the new contact INSIDE the capture call itself — before the submission returned, never queued behind a video or a person",
    w.welcomes.length === welcomesBefore + 1 && w.welcomes[w.welcomes.length - 1]?.id === r1.contactId,
    `welcomes during the call ${w.welcomes.length - welcomesBefore}; for ${w.welcomes[w.welcomes.length - 1]?.id === r1.contactId ? "the new contact" : "someone else"}`)
  const sig = tbl(svc, "manager_signals").find((s) => s.signal_type === "contact_consented_intake" && s.entity_id === r1.contactId)
  const evt = w.events.find((e) => e.event === "contact_consented_intake" && e.entityId === r1.contactId)
  const registry = (await quiet(async () => import("../../lib/kernel/signal-registry")) as unknown as { SIGNAL_REGISTRY: Record<string, { consumers: string[]; disposition: string }> }).SIGNAL_REGISTRY
  c.rule("147A", "THE MANAGER / ARBITER IS NOTIFIED (C8 '→ manager/arbiter notified'; emitKernelEvent('contact.consented_intake')): ONE governed bus signal data_steward → ai_isa on the contact, in its tenant, catalogued in the signal registry; the kernel event carries the consent row and the channels",
    !!sig && sig.from_manager === "data_steward" && sig.to_manager === "ai_isa" && sig.brokerage_id === A && r1.signalId === sig.id && !!registry.contact_consented_intake && !!evt && evt.metadata?.consent_event_ids?.phone === row.id,
    `signal ${sig ? `${sig.from_manager} → ${sig.to_manager}` : "none"}; registry ${registry.contact_consented_intake ? registry.contact_consented_intake.disposition : "MISSING"}; event consent row ${evt?.metadata?.consent_event_ids?.phone === row.id ? "carried" : "missing"}`)
  // Lane 147A Outside-lane #2 (→ 147Z): the AI ISA desk CONSUMES the signal (a SIGNAL_HANDLERS entry; registry disposition 'handled').
  const handlerSrc = strippedRepo("lib/kernel/manager-signals.ts") ?? ""
  const HANDLER = /["'`]ai_isa:contact_consented_intake["'`]\s*:/
  const handlerControl = HANDLER.test(stripComments(`const SIGNAL_HANDLERS = { "ai_isa:contact_consented_intake": async () => null }`)) && !HANDLER.test(stripComments(`// "ai_isa:contact_consented_intake": async () => null`))
  const consumed = HANDLER.test(handlerSrc) || registry.contact_consented_intake?.disposition === "handled"
  c.convergence("147A", "THE AI ISA DESK CONSUMES contact_consented_intake (lane 147A Outside-lane #2 → lane 147G/147Z: a SIGNAL_HANDLERS entry hands the contact to the arbiter for an immediate decision, registry flipped to 'handled')",
    consumed && handlerControl, consumed && handlerControl, `handler in stripped lib/kernel/manager-signals.ts: ${HANDLER.test(handlerSrc)}; registry disposition ${registry.contact_consented_intake?.disposition}; finder control ${handlerControl}`)
  const led = tbl(svc, "agent_action_ledger").find((l) => l.action === "contact.consented_intake.record")
  c.rule("147A", "THE INTAKE IS EVIDENCED (Law 5; C8 idempotent on (tenant, identity, consent evidence)): ONE contact.consented_intake.record ledger row, executed, provider_ref = the contact, keyed on the C8 key",
    !!led && led.status === "executed" && led.provider_ref === r1.contactId && led.idempotency_key === r1.idempotencyKey && led.brokerage_id === A, jsonOf(led ? { status: led.status, key: led.idempotency_key } : null))

  // ── 4 · replay, then a duplicate submission ──
  const before = counts()
  const r2 = await capture(params())
  const afterReplay = counts()
  c.rule("147A", "A REPLAY RE-READS AND NEVER RE-ACTS (C8 idempotent): the same submission again answers replay with the SAME contact and consent row — no second contact, consent row, signal, welcome or ledger row",
    r2.ok === true && r2.replay === true && r2.contactId === r1.contactId && jsonOf(before) === jsonOf(afterReplay), `${jsonOf(before)} → ${jsonOf(afterReplay)}; replay ${r2.replay}`)
  const r3 = await capture(params({ intake: { ...params().intake as Record<string, unknown>, capturedAt: "2026-10-31T16:45:00.000Z" } }))
  c.rule("147A", "A DUPLICATE SUBMISSION → THE SAME CONTACT (C8 '→ dedupe (person-identity) → Contact upsert'): a second submission by the same person at a new moment merges onto the SAME contact; it is a NEW consent event (they consented again — truthful), never a second person",
    r3.ok === true && r3.action === "merged" && r3.contactId === r1.contactId && tbl(svc, "contacts").length === afterReplay.contacts && tbl(svc, "contact_consent_events").filter((e) => e.contact_id === r1.contactId).length === 2,
    `action ${r3.action}; same contact ${r3.contactId === r1.contactId}; contacts ${afterReplay.contacts} → ${tbl(svc, "contacts").length}; consent rows for the person ${tbl(svc, "contact_consent_events").filter((e) => e.contact_id === r1.contactId).length}`)

  // ── 5 · cross-tenant ──
  const before5 = counts()
  const r5 = await capture(params({ email: "intruder@example.test", first_name: "Ivo", intake: { ...params().intake as Record<string, unknown>, formOwner: { table: "qr_codes", id: QR_B } } }))
  const after5 = counts()
  const r6 = await capture(params({ brokerageId: B, ownerAgentId: AGENT_B, email: "bea.bayside@example.test", first_name: "Bea", last_name: "Bayside", phone: null, intake: { ...params().intake as Record<string, unknown>, formOwner: { table: "qr_codes", id: QR_B }, sourceUrl: "/qr/bayside-147j" } }))
  c.rule("147A", "A FORM OWNED BY TENANT B NEVER CREATES A CONTACT IN TENANT A (lane 147A item 10): refused cross_tenant_form and NOTHING written; POSITIVE CONTROL — the same door with B's own form creates the contact in B",
    r5.ok === false && r5.refused === "cross_tenant_form" && jsonOf(before5) === jsonOf(after5) && r6.ok === true && tbl(svc, "contacts").some((x) => x.id === r6.contactId && x.brokerage_id === B),
    `cross-tenant → ${r5.refused ?? (r5.ok ? "ACCEPTED" : "refused")}, writes ${jsonOf(before5) === jsonOf(after5) ? "none" : "SOME"}; control (B's form) → ${r6.ok ? "created in B" : r6.refused}`)

  // ── 6 · every migrated door rides the C8 entry (stripped source) ──
  const DOORS = ["app/api/qr/submit/route.ts", "app/api/embed/capture/route.ts", "app/api/widget/capture-lead/route.ts", "app/actions/home-value-lead.ts", "app/actions/listing-landing.ts", "lib/lead-pipeline/portal-lead-intake.ts"]
  const offDoors = DOORS.filter((f) => { const s = strippedRepo(f) ?? ""; return !/\bcaptureConsentedContact\s*\(/.test(s) || /\bcaptureContact\s*\(/.test(s) })
  const doorControl = /\bcaptureContact\s*\(/.test(stripComments("await captureContact({ brokerageId })")) && !/\bcaptureContact\s*\(/.test(stripComments("// captureContact( — tombstone: the survivor is captureConsentedContact"))
  c.rule("147A", `EVERY MIGRATED CONSENTED DOOR CALLS THE ONE C8 ENTRY (C8 'One intake contract … that every form path calls'): ${DOORS.length} doors call captureConsentedContact and none still calls captureContact directly (stripped source; POSITIVE CONTROL: a direct call is caught, a tombstone is not)`,
    offDoors.length === 0 && doorControl, `off the C8 entry: ${offDoors.join(", ") || "none"}; finder control ${doorControl}`)

  c.blind("The doors' HTTP layers are judged by stripped-source census (their module graphs need the live app); the C8 contract they call is driven end to end. emitKernelEvent, ensureClientWelcome and the portal-invite mail are RECORDED edges (lane 147A's proof seams the same ones); the welcome send itself is test:conversion-welcome's. memSupabase enforces the configured UNIQUEs but no CHECK / RLS / trigger — m889's array CHECKs are lane 147A's text proof. Seven doors still own an upsert (lane 147A Still open 1) and are not on the C8 entry; they are outside this journey.")
  return c.report()
}
