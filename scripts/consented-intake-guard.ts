/**
 * scripts/consented-intake-guard.ts — `npm run test:consented-intake`
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147A — owner rulings 1 + 2 (2026-10-31), contract C8.
 *
 *   RULING 1, verbatim: "When a person enters their info on a form, etc. there is a consent box so these need to go in as a
 *   contact not a lead."
 *   RULING 2, verbatim: "Only worry about protected class blocking during the post/ad writing. Release all of the protected
 *   class blocking so that the data is added to the lead or contact fields so they can be read for researching."
 *
 * WHAT IS EXECUTED (on the in-memory client, through the REAL modules — only the network / send edges are stubbed: the
 * welcome email, the portal invite mail, the lifecycle_events insert):
 *   1  a consented submission → the CONTACT (created), its consent ROW with the m889 scope (wording hash + version, purposes,
 *      channels, evidence, idempotency key, person), enrichment QUEUED (the survivor's own lead_enrichment_queue write),
 *      the welcome CALLED (ensureClientWelcome — 146C's survivor), the kernel EVENT, the arbiter SIGNAL (data_steward → ai_isa),
 *      the LEDGER row (contact.consented_intake.record) — and NO lead row.
 *   2  a same-person open LEAD in the tenant is closed onto the contact (leads.contact_id), and the C2 boundary then refuses it
 *      as a lead (isInLeadDomain false; canonicalPartyFor → the contact).
 *   3  replay — the same submission again: same contact, nothing re-written, no second welcome / signal / consent.
 *   4  duplicate submission (a new moment) → the SAME contact (merged).
 *   5  cross-tenant — a form owned by tenant B never creates a contact in tenant A; a form that does not exist refuses.
 *   6  not identifiable → refused and routed to the raw pipeline; nothing written.
 *   7  the consent-scope answer ("may I text this person about equity?") from the record alone; a narrow consent does not
 *      cover equity; a channel opt-out withdraws; a later preference change REFERENCES the consent it changes (supersedes_id).
 *   8  ruling 2 — ingestion stores protected attributes (no drop); the purpose-gated reader: an ad-audience reader is REFUSED,
 *      a research reader SUCCEEDS, both EVIDENCED on the ledger (names only, never values); roles and purposes fail closed.
 *   9  census (stripped source): every migrated door calls the C8 entry, the two legacy-upsert doors call the record half and
 *      write no consent row of their own, no ads / audience module reaches the research reader; m889 agrees with the code.
 * Every absence has a POSITIVE CONTROL (the finder is shown to see the thing it counts).
 *
 * BLIND SPOTS (published): the doors' HTTP layers are proven by source census, not executed (their module graphs need the live
 * app); memSupabase has no CHECK enforcement (m889's array CHECKs are proven equal to the code lists on text); the welcome
 * email / portal mail / lifecycle insert are stubbed at the edge (their own proofs: test:conversion-welcome, the portal suites,
 * test:action-ledger); the ad-audience refusal is proven at the READER — an audience module that queried contacts' protected
 * COLUMNS directly would not pass through it (the write/act-time refusal for that is protected-class-signals.ts arm 3,
 * test:lifetime-signals / the audience proofs).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { registerHooks } from "node:module"
import { stripComments, stringLiterals } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const G = globalThis as any
G.__147A = { svc: null as MemClient | null, events: [] as any[], welcomes: [] as any[], invites: [] as any[] }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__147A.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__147A.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export async function emitKernelEvent(i){ globalThis.__147A.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__147A.events.length, fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null, error: r.error ? { message: r.error } : null } }",
  "@/lib/kernel/client-welcome": "export const WELCOME_RATIONALE_TAG='client_welcome_v1'; export function resolveWelcomeManagers(t){ return t==='buyer'?['shopping_agent']:t==='seller'?['listing_concierge']:[] } export async function ensureClientWelcome(svc,c){ globalThis.__147A.welcomes.push(c); return { state: 'sent' } }",
  "@/lib/portal/portal-invite-core": "export async function createSystemPortalInvite(p){ globalThis.__147A.invites.push(p); return { ok: true } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const src = (p: string) => stripComments(raw(p))

const A = "00000000-0000-4000-8000-0000000000aa"
const B = "00000000-0000-4000-8000-0000000000bb"
const AGENT_A = "00000000-0000-4000-8000-00000000a001"
const AGENT_B = "00000000-0000-4000-8000-00000000b001"
const QR_A = "00000000-0000-4000-8000-0000000c0a01"
const QR_B = "00000000-0000-4000-8000-0000000c0b01"
const LEAD_A = "00000000-0000-4000-8000-0000000d0a01"
const QR_TEXT = "By submitting this form, I consent to receive calls, texts, and emails from this agent and their brokerage regarding real estate services. I understand I may opt out at any time. Message and data rates may apply."
const sha = (t: string) => createHash("sha256").update(t.replace(/\s+/g, " ").trim()).digest("hex")

function seed(): MemClient {
  return memSupabase({
    brokerages: [{ id: A, name: "Alpha Realty" }, { id: B, name: "Beta Homes" }],
    agents: [
      { id: AGENT_A, brokerage_id: A, user_id: "u-a1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: AGENT_B, brokerage_id: B, user_id: "u-b1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" },
    ],
    users: [],
    qr_codes: [{ id: QR_A, brokerage_id: A, agent_id: AGENT_A, slug: "spring" }, { id: QR_B, brokerage_id: B, agent_id: AGENT_B, slug: "beta" }],
    contacts: [],
    leads: [{ id: LEAD_A, brokerage_id: A, first_name: "Jane", last_name: "Doe", email: "jane.doe@example.com", phone: "+15125550100", phone_digits: "5125550100", contact_id: null, is_active: true, lifecycle_state: "raw" }],
    contact_consent_events: [], lead_enrichment_queue: [], manager_signals: [], agent_action_ledger: [], lifecycle_events: [], manager_completions: [],
    person_identities: [], person_identity_evidence: [], lead_score_history: [], assignment_rules: [], transactions: [],
    activities: [], notifications: [], protected_research_attributes: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], contact_consent_events: [["brokerage_id", "idempotency_key"]] } })
}
const rows = (c: MemClient, t: string) => (c.tables[t] ?? []) as any[]

async function main() {
  const cap = await import("../lib/contact-pipeline/contact-capture")
  const consent = await import("../lib/kernel/compliance/require-contact-consent")
  const boundary = await import("../lib/contact-promotion/lead-domain-boundary")

  const qrParams = (over: Record<string, unknown> = {}) => ({
    brokerageId: A, ownerAgentId: AGENT_A, source: "qr_scan", first_name: "Jane", last_name: "Doe",
    email: "jane.doe@example.com", phone: "+15125550100", preferred_channel: "phone" as const,
    consents: [{ family: "phone" as const, given: true, text: QR_TEXT, textVersion: "qr_landing:v1", purposes: ["requested_information" as const] }],
    intake: { capturedAt: "2026-10-31T12:00:00.000Z", channel: "qr", sourceUrl: "/qr/spring", evidence: { qr_code_id: QR_A, ip: "203.0.113.7", user_agent: "ua" }, formOwner: { table: "qr_codes" as const, id: QR_A } },
    ...over,
  })

  // ── 1 ──────────────────────────────────────────────────────────────────────
  console.log("\n[1 — consented submission → CONTACT + consent record + enrichment + welcome + event + arbiter signal + ledger; NO lead]")
  const svc = seed(); G.__147A.svc = svc
  const leadsBefore = rows(svc, "leads").length
  const r1 = await cap.captureConsentedContact(qrParams() as never, { client: svc })
  check("the intake succeeds and CREATES the contact", r1.ok && r1.action === "created" && !!r1.contactId, JSON.stringify({ ok: r1.ok, refused: r1.refused, reason: r1.reason, warnings: r1.warnings }))
  const jane = rows(svc, "contacts").find((c) => c.id === r1.contactId)
  check("the contact is in the FORM OWNER's tenant, owned by the QR's agent, TCPA stamped with the exact wording", jane?.brokerage_id === A && jane?.agent_id === AGENT_A && jane?.tcpa_consent === true && jane?.tcpa_consent_text === QR_TEXT && jane?.tcpa_consent_source === "qr_scan")
  const ev1 = rows(svc, "contact_consent_events").filter((e) => e.contact_id === r1.contactId)
  const row1 = ev1[0]
  check("ONE consent row (consent_type tcpa, consented) carrying the wording hash + version", ev1.length === 1 && row1?.consent_type === "tcpa" && row1?.consented === true && row1?.consent_text_hash === sha(QR_TEXT) && row1?.consent_text_version === "qr_landing:v1", JSON.stringify(row1))
  check("the scope: purposes = the wording's broad grant + what the form offered; channels = exactly what the wording names",
    JSON.stringify([...(row1?.purposes ?? [])].sort()) === JSON.stringify(["real_estate_services", "requested_information"]) && JSON.stringify([...(row1?.channels ?? [])].sort()) === JSON.stringify(["email", "sms", "voice"]), JSON.stringify({ p: row1?.purposes, c: row1?.channels }))
  check("the evidence pointer, source url, capture time, idempotency key and person ride the row",
    row1?.evidence?.qr_code_id === QR_A && row1?.evidence?.intake_channel === "qr" && row1?.source_url === "/qr/spring" && row1?.captured_at === "2026-10-31T12:00:00.000Z" && row1?.idempotency_key === `${r1.idempotencyKey}:phone` && !!row1?.person_id && row1?.person_id === r1.personId)
  check("Customer 360 enrichment STARTED — the survivor's own lead_enrichment_queue row (pending) and the result says so",
    r1.enrichmentQueued === true && rows(svc, "lead_enrichment_queue").some((q) => q.contact_id === r1.contactId && q.status === "pending"))
  check("the welcome ran through the survivor (ensureClientWelcome, 146C) for the new contact", G.__147A.welcomes.some((w: any) => w.id === r1.contactId))
  const evt = G.__147A.events.find((e: any) => e.event === "contact_consented_intake" && e.entityId === r1.contactId)
  check("emitKernelEvent(contact_consented_intake) — auditOnly, with the consent ids, purposes and channels", !!evt && evt.auditOnly === true && evt.metadata?.consent_event_ids?.phone === row1?.id && evt.metadata?.channels?.includes("sms"))
  const sig = rows(svc, "manager_signals").find((s) => s.signal_type === "contact_consented_intake" && s.entity_id === r1.contactId)
  check("the arbiter's desk is told: data_steward → ai_isa contact_consented_intake on the governed bus", !!sig && sig.from_manager === "data_steward" && sig.to_manager === "ai_isa" && sig.brokerage_id === A && r1.signalId === sig.id)
  const led = rows(svc, "agent_action_ledger").find((l) => l.action === "contact.consented_intake.record")
  check("the ACTION LEDGER row: contact.consented_intake.record executed, provider_ref = the contact, keyed on the C8 key", !!led && led.status === "executed" && led.provider_ref === r1.contactId && led.idempotency_key === r1.idempotencyKey && led.brokerage_id === A)
  const registry = (await import("../lib/kernel/signal-registry")).SIGNAL_REGISTRY
  check("the signal type is catalogued (test:signal-integrity's orphan rule)", !!registry.contact_consented_intake)
  check("NO lead row was created for a consented identifiable person", rows(svc, "leads").length === leadsBefore)
  check("POSITIVE CONTROL — the lead finder sees the seeded lead (a broken finder and a clean run would both read zero)", rows(svc, "leads").filter((l) => l.email === "jane.doe@example.com").length === 1)

  // ── 2 ──────────────────────────────────────────────────────────────────────
  console.log("\n[2 — the same-person open LEAD is closed onto the contact; the C2 boundary refuses it as a lead]")
  const lead = rows(svc, "leads").find((l) => l.id === LEAD_A)
  check("leads.contact_id stamped with the contact (history-carry, the one link writer) and the lead deactivated", lead?.contact_id === r1.contactId && !!lead?.converted_at && lead?.is_active === false && r1.leadsClosed.includes(LEAD_A), JSON.stringify({ lead, closed: r1.leadsClosed, w: r1.warnings }))
  check("lead-domain-boundary: the lead is no longer in the lead domain — communication continues on the CONTACT", boundary.isInLeadDomain(lead) === false && boundary.canonicalPartyFor(lead).type === "contact" && boundary.canonicalPartyFor(lead).id === r1.contactId)
  check("POSITIVE CONTROL — an open lead (no contact_id) IS in the lead domain", boundary.isInLeadDomain({ id: "l-open", contact_id: null } as never) === true)

  // ── 3 ──────────────────────────────────────────────────────────────────────
  console.log("\n[3 — replay: the same submission again re-reads, never re-acts]")
  const counts = () => ({ c: rows(svc, "contacts").length, e: rows(svc, "contact_consent_events").length, s: rows(svc, "manager_signals").length, w: G.__147A.welcomes.length, l: rows(svc, "agent_action_ledger").length })
  const before3 = counts()
  const r3 = await cap.captureConsentedContact(qrParams() as never, { client: svc })
  const after3 = counts()
  check("replay: ok, replay=true, the SAME contact and the same consent row id", r3.ok && r3.replay === true && r3.contactId === r1.contactId && r3.consentEventIds.phone === row1?.id, JSON.stringify(r3))
  check("nothing re-written: no second contact, consent row, signal, welcome or ledger row", JSON.stringify(before3) === JSON.stringify(after3), `${JSON.stringify(before3)} → ${JSON.stringify(after3)}`)

  // ── 4 ──────────────────────────────────────────────────────────────────────
  console.log("\n[4 — duplicate submission at a new moment → the SAME contact]")
  const r4 = await cap.captureConsentedContact(qrParams({ intake: { ...qrParams().intake, capturedAt: "2026-10-31T15:30:00.000Z" } }) as never, { client: svc })
  check("a second submission by the same person merges onto the SAME contact (no new contact row)", r4.ok && r4.action === "merged" && r4.contactId === r1.contactId && rows(svc, "contacts").length === after3.c, JSON.stringify({ ok: r4.ok, a: r4.action, reason: r4.reason }))
  check("it is a NEW consent event (they consented again — truthful), with a different idempotency key", rows(svc, "contact_consent_events").filter((e) => e.contact_id === r1.contactId).length === 2 && r4.idempotencyKey !== r1.idempotencyKey)

  // ── 5 ──────────────────────────────────────────────────────────────────────
  console.log("\n[5 — cross-tenant: a form owned by tenant B never creates a contact in tenant A]")
  const before5 = counts()
  const r5 = await cap.captureConsentedContact(qrParams({ email: "x@y.test", first_name: "Xavier", intake: { ...qrParams().intake, formOwner: { table: "qr_codes", id: QR_B } } }) as never, { client: svc })
  check("refused cross_tenant_form, nothing written", !r5.ok && r5.refused === "cross_tenant_form" && JSON.stringify(counts()) === JSON.stringify(before5), JSON.stringify(r5))
  const r5b = await cap.captureConsentedContact(qrParams({ email: "x@y.test", intake: { ...qrParams().intake, formOwner: { table: "qr_codes", id: "00000000-0000-4000-8000-00000000dead" } } }) as never, { client: svc })
  check("a form that does not exist refuses (form_not_found) — fail closed", !r5b.ok && r5b.refused === "form_not_found" && JSON.stringify(counts()) === JSON.stringify(before5))
  const r5c = await cap.captureConsentedContact(qrParams({ brokerageId: B, ownerAgentId: AGENT_B, email: "bea@beta.test", first_name: "Bea", last_name: "Beta", phone: null, intake: { ...qrParams().intake, formOwner: { table: "qr_codes", id: QR_B } } }) as never, { client: svc })
  check("POSITIVE CONTROL — the SAME door with B's own form creates the contact in B", r5c.ok && rows(svc, "contacts").some((c) => c.id === r5c.contactId && c.brokerage_id === B), JSON.stringify({ ok: r5c.ok, refused: r5c.refused, reason: r5c.reason }))

  // ── 6 ──────────────────────────────────────────────────────────────────────
  console.log("\n[6 — not identifiable → refused, routed to the raw pipeline]")
  const before6 = counts()
  const r6 = await cap.captureConsentedContact(qrParams({ first_name: null, last_name: null }) as never, { client: svc })
  const r6b = await cap.captureConsentedContact(qrParams({ email: null, phone: null }) as never, { client: svc })
  check("no name → not_identifiable, route raw_pipeline; no email and no phone → the same; nothing written",
    !r6.ok && r6.refused === "not_identifiable" && r6.route === "raw_pipeline" && !r6b.ok && r6b.refused === "not_identifiable" && JSON.stringify(counts()) === JSON.stringify(before6))

  // ── 7 ──────────────────────────────────────────────────────────────────────
  console.log("\n[7 — the consent-scope answer: \"may I text this person about equity?\" from the record alone]")
  const scope7 = await consent.consentScopeFor(svc, { brokerageId: A, contactId: r1.contactId! })
  const smsEquity = consent.answerConsentQuestion(scope7, { channel: "sms", purpose: "equity_review" })
  check("YES — the newest consent names sms and its broad real-estate grant covers equity_review; the answer cites the row", smsEquity.allowed && smsEquity.basis === "consent_record" && !!smsEquity.consentEventId, JSON.stringify(smsEquity))
  const mail = consent.answerConsentQuestion(scope7, { channel: "direct_mail", purpose: "equity_review" })
  check("NO for direct mail — the wording never named it (channel_not_named, nothing inferred)", !mail.allowed && mail.basis === "channel_not_named")
  // a narrow consent: a valuation-only grant by email
  const narrow = await consent.persistContactConsent({ brokerageId: B, contactId: r5c.contactId!, channel: "email", consentText: "Email me my home valuation report.", consentSource: "test", consented: true, client: svc, stampPartyColumns: false, scope: { purposes: ["home_valuation"], channels: ["email"] } })
  const scopeB = await consent.consentScopeFor(svc, { brokerageId: B, contactId: r5c.contactId! })
  const narrowAns = consent.answerConsentQuestion(scopeB, { channel: "email", purpose: "equity_review" })
  check("a NARROW consent (home_valuation) does not cover equity_review — purpose_not_covered, citing the row", !!narrow.consentEventId && !narrowAns.allowed && narrowAns.basis === "purpose_not_covered" && narrowAns.consentEventId === narrow.consentEventId, JSON.stringify(narrowAns))
  check("…but it covers home_valuation itself", consent.answerConsentQuestion(scopeB, { channel: "email", purpose: "home_valuation" }).allowed)
  // a later preference change — the legacy opt-out caller (tcpa panel / unsubscribe shape: no scope)
  const optOut = await consent.persistContactConsent({ brokerageId: A, contactId: r1.contactId!, channel: "phone", consentText: "Opted out by reply STOP", consentSource: "sms_stop", consented: false, client: svc })
  const outRow = rows(svc, "contact_consent_events").find((e) => e.id === optOut.consentEventId)
  const newestPhoneBefore = rows(svc, "contact_consent_events").filter((e) => e.contact_id === r1.contactId && e.consent_type === "tcpa" && e.id !== optOut.consentEventId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  check("a later preference change REFERENCES the consent it changes (supersedes_id → the newest earlier tcpa row)", !!outRow && outRow.consented === false && !!outRow.supersedes_id && outRow.supersedes_id === newestPhoneBefore?.id && optOut.supersedesId === outRow.supersedes_id, JSON.stringify({ outRow, newest: newestPhoneBefore?.id }))
  const scope7b = await consent.consentScopeFor(svc, { brokerageId: A, contactId: r1.contactId! })
  check("after the withdrawal the answer is NO (withdrawn), citing the opt-out row", (() => { const a = consent.answerConsentQuestion(scope7b, { channel: "sms", purpose: "equity_review" }); return !a.allowed && a.basis === "withdrawn" && a.consentEventId === optOut.consentEventId })())
  const jRow = rows(svc, "contacts").find((c) => c.id === r1.contactId)
  jRow.email_unsubscribed = true
  const scope7c = await consent.consentScopeFor(svc, { brokerageId: A, contactId: r1.contactId! })
  check("a channel opt-out on the contact withdraws whatever a row says (email_unsubscribed → channel_opt_out)", consent.answerConsentQuestion(scope7c, { channel: "email", purpose: "market_updates" }).basis === "channel_opt_out")
  check("an unreadable record answers `unreadable`, never `no consent` (fail closed)", consent.answerConsentQuestion({ rows: [], optedOut: [], scopeReadable: false, error: "boom" }, { channel: "sms", purpose: "equity_review" }).basis === "unreadable")
  check("wording is read literally: 'communications' names no channel; 'calls, texts' names voice + sms",
    consent.channelsNamedInConsentText("you consent to receive communications from us").length === 0 && JSON.stringify(consent.channelsNamedInConsentText("calls, texts").sort()) === JSON.stringify(["sms", "voice"]))
  const m889 = memSupabase({ contacts: [{ id: "c-x", brokerage_id: A }], contact_consent_events: [] }, { uuidIds: true, missingColumns: { contact_consent_events: ["purposes", "consent_text_hash", "channels", "idempotency_key", "supersedes_id", "consent_text_version", "source_url", "evidence", "person_id", "captured_at"] } })
  const pre = await consent.persistContactConsent({ brokerageId: A, contactId: "c-x", channel: "email", consentText: "Email me", consentSource: "t", consented: true, client: m889, stampPartyColumns: false, scope: { purposes: ["requested_information"] } })
  check("before m889 is applied the consent STILL lands (legacy row) and says the scope was not stored (scopeStored false)", !!pre.consentEventId && pre.scopeStored === false && rows(m889, "contact_consent_events").length === 1)

  // ── 8 ──────────────────────────────────────────────────────────────────────
  console.log("\n[8 — ruling 2: ingestion keeps protected attributes; the purpose-gated research reader, evidenced both ways]")
  const colmap = await import("../lib/lead-pipeline/enrichment-column-map")
  const cols = colmap.peopleDataProfileToContactColumns({ gender: "female", marital_status: "married", age_range: "35-44" } as never) as Record<string, unknown>
  check("ingestion stores protected attributes on the contact columns (no ingestion-time drop)", cols.gender === "female" && cols.age_range === "35-44", JSON.stringify(cols))
  const store = await import("../lib/enrichment/protected-research-store")
  const pcs = await import("../lib/lead-governance/protected-class-signals")
  check("POSITIVE CONTROL — the classifier sees gender / marital_status as protected and city as not", !!pcs.protectedClassReasonFor("gender") && !!pcs.protectedClassReasonFor("marital_status") && !pcs.protectedClassReasonFor("city"))
  const rs = memSupabase({
    contacts: [{ id: "c-r", brokerage_id: A, first_name: "Rae", city: "Austin", gender: "female", marital_status: "married",
      enrichment_profile: { field_provenance: { gender: { source: "batchdata", capability: "property.enrich_datasets", retrievedAt: "2026-10-01T00:00:00Z", matchConfidence: "0.92", purpose: "enrichment" } } } }],
    protected_research_attributes: [{ id: "pr-1", brokerage_id: A, contact_id: "c-r", provider: "versium", capability: "person.online_audience", source_field: "Religion", attribute_value: "R1", attribute_class: "religion", basis: "vendor_modeled", match_confidence: "household", retrieved_at: "2026-09-01T00:00:00Z" }],
    agent_action_ledger: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  G.__147A.svc = rs
  const now = new Date("2026-10-31T00:00:00Z")
  const adRead = await store.readProtectedAttributes(rs, { brokerageId: A, contactId: "c-r", purpose: "ad_audience", actor: { userId: "u-broker", userType: "broker" } }, { now })
  const refLed = rows(rs, "agent_action_ledger").find((l) => l.action === "research.protected_attribute.refuse")
  check("an AD-AUDIENCE reader is REFUSED (prohibited_purpose) even as a broker — and the refusal is EVIDENCED on the ledger", !adRead.ok && adRead.refused === "prohibited_purpose" && adRead.evidenced && !!refLed && refLed.status === "skipped" && /prohibited_purpose/.test(refLed.outcome ?? ""), JSON.stringify({ adRead, refLed }))
  const resRead = await store.readProtectedAttributes(rs, { brokerageId: A, contactId: "c-r", purpose: "research", actor: { userId: "u-co", userType: "compliance_officer" } }, { now })
  const readLed = rows(rs, "agent_action_ledger").find((l) => l.action === "research.protected_attribute.read")
  check("a RESEARCH reader (compliance_officer) SUCCEEDS — and the read is EVIDENCED (executed)", resRead.ok && resRead.evidenced && !!readLed && readLed.status === "executed", JSON.stringify({ resRead: resRead.ok ? "ok" : resRead, readLed }))
  if (resRead.ok) {
    const g = resRead.attributes.find((a) => a.field === "gender")
    const rel = resRead.attributes.find((a) => a.field === "Religion")
    check("each attribute travels in its ENVELOPE { provenance, confidence, freshness, data_rights, purposes, access_class }",
      !!g && g.accessClass === "protected_research" && g.provenance?.source === "batchdata" && g.confidence === "0.92" && g.dataRights === "provider_licensed:batchdata" && g.purposes.includes("research") && !g.purposes.includes("outreach") && g.freshness.retrievedAt === "2026-10-01T00:00:00Z", JSON.stringify(g))
    check("the segregated research row comes back VENDOR-MODELED with its class and provider rights; city (not protected) is not read",
      !!rel && rel.basis === "vendor_modeled" && rel.protectedClass === "religion" && rel.dataRights === "provider_licensed:versium" && rel.freshness.fresh === true && !resRead.attributes.some((a) => a.field === "city"))
  }
  check("the ledger carries field NAMES / purposes only — never a value", !JSON.stringify(rows(rs, "agent_action_ledger")).includes("female") && !JSON.stringify(rows(rs, "agent_action_ledger")).includes("\"R1\""))
  const tl = await store.readProtectedAttributes(rs, { brokerageId: A, contactId: "c-r", purpose: "research", actor: { userId: "u-tl", userType: "team_lead" } })
  const ag = await store.readProtectedAttributes(rs, { brokerageId: A, contactId: "c-r", purpose: "research", actor: { userId: "u-ag", userType: "agent" } })
  const unk = await store.readProtectedAttributes(rs, { brokerageId: A, contactId: "c-r", purpose: "curiosity", actor: { userId: "u-co", userType: "compliance_officer" } })
  const steer = await store.readProtectedAttributes(rs, { brokerageId: A, contactId: "c-r", purpose: "steering", actor: { userId: null, userType: null, platformRole: "platform_owner" } })
  check("roles and purposes fail closed: team_lead / agent → role_not_admitted; an unknown purpose → unknown_purpose; steering → prohibited even for platform staff",
    !tl.ok && tl.refused === "role_not_admitted" && !ag.ok && ag.refused === "role_not_admitted" && !unk.ok && unk.refused === "unknown_purpose" && !steer.ok && steer.refused === "prohibited_purpose")
  const dsr = await store.readProtectedAttributes(rs, { brokerageId: A, contactId: "c-r", purpose: "data_subject_request", actor: { userId: "u-ad", userType: "admin" } })
  check("the subject's right-to-know export (data_subject_request) is admitted for the tenant-admin roster", dsr.ok)
  const foreign = await store.readProtectedAttributes(rs, { brokerageId: B, contactId: "c-r", purpose: "research", actor: { userId: "u-co", userType: "compliance_officer" } })
  check("another tenant reads nothing (not_in_tenant)", !foreign.ok && foreign.refused === "not_in_tenant")
  check("the research-reader roster is DERIVED by named subtraction from TENANT_ADMIN_USER_TYPES (minus team_lead, admin)",
    /\[\.\.\.TENANT_ADMIN_USER_TYPES\]\.filter\(\(t\) => !ROLES_HELD_OUT_OF_PROTECTED_RESEARCH\.has\(t\)\)/.test(src("lib/enrichment/protected-research-store.ts")) && store.PROTECTED_RESEARCH_READER_USER_TYPES.has("compliance_officer") && !store.PROTECTED_RESEARCH_READER_USER_TYPES.has("team_lead"))

  // ── 9 ──────────────────────────────────────────────────────────────────────
  console.log("\n[9 — census (stripped source) + m889 agrees with the code]")
  // wave 147 (lane 147Z): + the /widget/chat intake route (the clearest twin) and the public open-house kiosk.
  const MIGRATED = ["app/api/qr/submit/route.ts", "app/api/embed/capture/route.ts", "app/api/widget/capture-lead/route.ts", "app/actions/home-value-lead.ts", "app/actions/listing-landing.ts", "lib/lead-pipeline/portal-lead-intake.ts", "app/api/widget/intake/route.ts", "app/api/open-house/attend/route.ts"]
  const ownUpsert = /\.from\(\s*["']contacts["']\s*\)\s*\.(?:insert|update)\(|\.from\(\s*["']contact_consent_events["']\s*\)\s*\.insert\(|persistContactConsent\(/
  const stillOwn = ["app/api/widget/intake/route.ts"].filter((f) => ownUpsert.test(src(f)))
  check("the merged twin (/api/widget/intake) writes NO contact row and NO consent row of its own — C8 is its upsert", stillOwn.length === 0, stillOwn.join(", "))
  check("POSITIVE CONTROL — the own-upsert finder sees a contacts insert and a consent insert", ownUpsert.test('supabase.from("contacts").insert({})') && ownUpsert.test("supabase.from('contact_consent_events').insert({})"))
  const notOnC8 = MIGRATED.filter((f) => !/captureConsentedContact\(/.test(src(f)) || /\bcaptureContact\(/.test(src(f)))
  check(`every migrated consented door calls the C8 entry and no longer calls captureContact directly (${MIGRATED.length} doors)`, notOnC8.length === 0, notOnC8.join(", "))
  check("POSITIVE CONTROL — the door finder sees a direct captureContact( call", /\bcaptureContact\(/.test(stripComments("await captureContact({ brokerageId })")) && !/\bcaptureContact\(/.test(stripComments("// captureContact( in a comment")))
  const LEGACY = ["lib/kernel/lead-magnets.ts", "lib/ads/ad-lead-intake.ts"]
  const consentInsert = /\.from\(\s*["']contact_consent_events["']\s*\)\s*\.insert\(/
  const legacyBad = LEGACY.filter((f) => !/completeConsentedIntake\(/.test(src(f)) || consentInsert.test(src(f)))
  check("the two legacy-upsert doors call the C8 record half and write no consent row of their own", legacyBad.length === 0, legacyBad.join(", "))
  check("POSITIVE CONTROL — the consent-insert finder sees one", consentInsert.test('supabase.from("contact_consent_events").insert({'))
  check("the embed door claims NO consent (its form shows no box and no wording)", /given:\s*false,\s*text:\s*null/.test(src("app/api/embed/capture/route.ts")) && !/tcpa_consent:\s*true/.test(src("app/api/embed/capture/route.ts")))
  check("the arbiter's read carries the consent scope (customer-360 → consentScopeFor + answerConsentQuestion)", /consentScopeFor\(/.test(src("lib/enrichment/customer-360.ts")) && /answerConsentQuestion\(/.test(src("lib/enrichment/customer-360.ts")))
  // no ads / audience / dispatch module reaches the research reader
  const walk = (d: string, out: string[] = []) => { if (!existsSync(join(ROOT, d))) return out; for (const n of readdirSync(join(ROOT, d))) { const p = `${d}/${n}`; if (statSync(join(ROOT, p)).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p) } return out }
  const targeting = [...walk("lib/ads"), ...walk("lib/audiences"), ...walk("lib/providers")]
  const reaches = (t: string) => stringLiterals(t).some((l) => /protected-research-store$/.test(l.text)) || /readProtectedAttributes\(/.test(stripComments(t))
  const offenders = targeting.filter((f) => reaches(raw(f)))
  check(`no ads / audience / dispatch module reaches the research reader (${targeting.length} files scanned)`, offenders.length === 0, offenders.join(", "))
  check("POSITIVE CONTROL — the reach finder sees an import and a call; a comment is not one", reaches('await import("@/lib/enrichment/protected-research-store")') && reaches("readProtectedAttributes(svc, x)") && !reaches("// readProtectedAttributes( is research-only"))
  const sqlPath = "supabase/migrations/m889-consent-record-scope-on-contact-consent-events.sql"
  const sql = raw(sqlPath)
  const line1 = sql.split("\n")[0]
  check("m889 line 1 is the lane stamp OR the applied stamp (the rule, not the waypoint)", /^-- WRITTEN, NOT APPLIED \(wave 147, lane 147A\)/.test(line1) || /^-- ── APPLIED LIVE /.test(line1))
  const arr = (name: string) => { const m = sql.match(new RegExp(`${name} CHECK \\(\\w+ <@ ARRAY\\[([\\s\\S]*?)\\]::text\\[\\]`)); return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort() : [] }
  check("m889's purposes CHECK lists exactly CONSENT_PURPOSES", JSON.stringify(arr("contact_consent_events_purposes_check")) === JSON.stringify([...consent.CONSENT_PURPOSES].sort()), JSON.stringify(arr("contact_consent_events_purposes_check")))
  check("m889's channels CHECK lists exactly CONSENT_CHANNELS", JSON.stringify(arr("contact_consent_events_channels_check")) === JSON.stringify([...consent.CONSENT_CHANNELS].sort()))
  check("m889 adds the tenant idempotency unique index and the supersedes pointer", /UNIQUE INDEX IF NOT EXISTS contact_consent_events_tenant_idempotency_uq[\s\S]*\(brokerage_id, idempotency_key\)/.test(sql) && /supersedes_id\s+uuid REFERENCES public\.contact_consent_events\(id\)/.test(sql))

  // ── 10 ─────────────────────────────────────────────────────────────────────
  console.log("\n[10 — WAVE 147 lane 147Z: the AI ISA ACTS on contact_consented_intake — consent record → arbiter → ONE C14 completion]")
  {
    const ms = await import("../lib/kernel/manager-signals")
    const reg = (await import("../lib/kernel/signal-registry")).SIGNAL_REGISTRY.contact_consented_intake
    check("the handler is REGISTERED (ai_isa:contact_consented_intake) and the registry row says handled by ai_isa (was feed_only)",
      typeof ms.SIGNAL_HANDLERS["ai_isa:contact_consented_intake"] === "function" && reg.disposition === "handled" && (reg.consumers as readonly string[]).includes("ai_isa"))
    const s1 = seed(); G.__147A.svc = s1
    const c1 = await cap.captureConsentedContact(qrParams() as never, { client: s1 })
    const line = rows(s1, "manager_signals").find((s) => s.signal_type === "contact_consented_intake" && s.entity_id === c1.contactId)
    const asSignal = (row: any, cid: string, key: string | undefined) => ({ id: row?.id ?? "sig-x", fromManager: "data_steward", toManager: "ai_isa", signalType: "contact_consented_intake", entityType: "contact", entityId: cid, contactId: cid, payload: { idempotency_key: key, intake_channel: "qr" } }) as never
    const engaged: any[] = []
    const hold = async (p: any) => { engaged.push(p); return { success: false, reason: "nba:hold:recently_contacted" } }
    const h1 = await ms.answerConsentedIntake(asSignal(line, c1.contactId!, c1.idempotencyKey), { brokerageId: A, supabase: s1 as never }, { engage: hold })
    check("the consent RECORD answers the channel questions from the record alone (the QR wording names texts, calls and email)", /sms yes, voice yes, email yes/.test(h1 ?? ""), h1 ?? "")
    check("the contact is handed to the follow-up arbiter NOW through the ONE governed engagement (engageContact, reason brokerage_rule)",
      engaged.length === 1 && engaged[0].contactId === c1.contactId && engaged[0].reason === "brokerage_rule" && engaged[0].brokerageId === A)
    const comps = () => rows(s1, "manager_completions").filter((c) => c.subject_id === c1.contactId && c.kind === "follow_up")
    const k1 = comps()
    check("ONE C14 completion, owned by ai_isa, CLOSED on the decision — the planner's hold after the welcome IS the decision (never a second hello)",
      k1.length === 1 && k1[0].owner_manager === "ai_isa" && k1[0].status === "closed" && (k1[0].evidence ?? []).filter((e: any) => e.kind === "decision" && /held the next touch/.test(e.outcome ?? "")).length === 1, JSON.stringify(k1.map((c) => [c.status, c.stage, (c.evidence ?? []).length])))
    await ms.answerConsentedIntake(asSignal(line, c1.contactId!, c1.idempotencyKey), { brokerageId: A, supabase: s1 as never }, { engage: hold })
    check("the same intake handled again → the SAME completion (idempotent on the intake's own key), not a second", comps().length === 1)
    check("POSITIVE CONTROL — the completion finder sees the row it counts (a broken finder and no completion would both read zero)", rows(s1, "manager_completions").length >= 1)
    const s2 = seed(); G.__147A.svc = s2
    const c2 = await cap.captureConsentedContact(qrParams() as never, { client: s2 })
    await ms.answerConsentedIntake(asSignal(null, c2.contactId!, c2.idempotencyKey), { brokerageId: A, supabase: s2 as never }, { engage: async () => ({ success: false, reason: "experience:agent_intervention:delegated" }) })
    const k2 = rows(s2, "manager_completions").find((c) => c.subject_id === c2.contactId)
    check("a PERSON's answer keeps the completion OPEN at awaiting_human (the agent's completed task closes it; a stall bells them)",
      k2?.status === "open" && k2?.stage === "awaiting_human" && k2?.context?.contact_id === c2.contactId, JSON.stringify([k2?.status, k2?.stage]))
    const shut = memSupabase({ contacts: [], manager_completions: [] }, { refuse: { contacts: "permission denied" } } as never)
    const engaged3: any[] = []
    const h3 = await ms.answerConsentedIntake(asSignal(null, "c-z", "k"), { brokerageId: A, supabase: shut as never }, { engage: async (p: any) => { engaged3.push(p); return { success: true, channel: "email" } } })
    check("FAIL CLOSED: an unreadable consent record engages NOTHING and says so (nobody checked never reads as allowed)", engaged3.length === 0 && /could not be read/.test(h3 ?? ""), h3 ?? "")
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail ? ` — ${fails.join(" | ")}` : ""}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); console.log(`\nRESULT: ${pass} passed, ${fail + 1} failed — threw: ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
