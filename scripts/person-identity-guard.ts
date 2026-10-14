#!/usr/bin/env tsx
/**
 * scripts/person-identity-guard.ts   (npm run test:person-identity)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CANONICAL PERSON IDENTITY / EVIDENCE LAYER UNDER LEADS AND CONTACTS (wave 102, lane 102A; m697).
 *
 * BEHAVIOUR (in-memory supabase, the REAL kernel service + the REAL history-carry + the REAL
 * person-timeline, module edges stubbed — no network, no live rows):
 *   1. the same person twice → ONE person_identities row, TWO evidence rows; a different email →
 *      a DIFFERENT person; the key is the identity gate (no email / no last name → refused);
 *   2. phone CORROBORATES a re-spelled name on the same email (and a different phone does not);
 *   3. tenant isolation — the same identity in tenant B is a separate person; a cross-tenant read
 *      finds nothing (positive control: the owning tenant finds it);
 *   4. carryLeadHistoryToContact (the one lead→contact LINK writer) stamps canonical_contact_id and
 *      promotion_link evidence on lead + contact, from the SAME call; no second event (existingEvent);
 *   5. a link is idempotent (duplicate: true, one row); the one new event person.identity_linked is
 *      emitted only where no chokepoint event exists;
 *   6. an absent m697 (42P01) is REPORTED (ok:false) and never thrown — the carry still links;
 *   7. buildPersonTimeline folds a second, dedup-linked lead and its raw row into ONE timeline;
 *   8. summarizePersonEvidence carries no cost key (positive control: a cost key in detail is dropped).
 * MIGRATION (m697 text, SQL comments removed): entity_type / match_method CHECKs == the code's
 *   vocabularies (derived, not pinned); append-only trigger on evidence with the cascade pass-through;
 *   tenant-scoped SELECT, no write policy, REVOKE; UNIQUE person key and UNIQUE link — each with a
 *   mutated-text positive control.
 * CENSUS (stripped source): every chokepoint reaches the one service (pipeline-processor, history-carry,
 *   mergeContacts, unknown-sender, instant-greeting + the attend route passing lastName, forms/submit)
 *   and both readers (person-timeline, contact-brief); the service is the only inserter of the two
 *   tables — with a fixture positive control.
 *
 * WAVE 102.1 (lane 102E) — closures, each on the ONE service:
 *   11. R2: resolveSurvivorPerson — a dedup verdict links the record onto the SURVIVOR's person (its
 *       evidence, else a person keyed on the survivor's identity); positive control: the old path
 *       (resolvePerson on the record's own email) mints a second person;
 *   12. R1: the REAL distributePlatformLead, in-memory — the person is re-homed under the receiving
 *       brokerage; the market-owner row and its evidence are untouched; nothing crosses tenants;
 *   13. R6: ProvenancePurpose has `conversation` (self_service kept; no exhaustive map left behind);
 *   14. the identity evidence CARD reads only the summary's fields (no cost key, no raw id);
 *   census: captureContact wires ONCE inside; the form route keeps one path; crm manual dedup; the
 *   behavioral_signal writer (module-private in a 'use server' file); distribution; the card + mount.
 *
 * WAVE 103 (lane 103D; m706; owner answer 1 — CONSENTED website-visitor email capture):
 *   15. m706 text: email_captured / email_captured_at / consent_event_id → contact_consent_events(id)
 *       are ADDITIVE, the fail-closed rule is a CHECK (email_captured IS NULL OR consent_event_id IS
 *       NOT NULL, mutated positive control), nothing destructive; prints whether the column is live;
 *   16. the ONE door (lib/lead-intelligence/visitor-email-capture.ts captureConsentedVisitorEmail),
 *       executed in memory with the REAL persistContactConsent: a capture WITHOUT consent stores
 *       NOTHING (the positive control the owner asked for); only a literal `true` consents; with
 *       consent the artifact is written first, the signal names it, the identify match fires and
 *       the 102E evidence writer records contact + behavioral_signal under the system actor; an
 *       artifact handed over by id is read back (opted-out / foreign / made-up ids store nothing);
 *       a refused ledger write and a pre-m706 column each REPORT, never a silent success;
 *   17. census: trackBehavior is the one door, /api/track/visitor and /api/widget/capture-lead reach
 *       it (flag → artifact, or the artifact id the widget form already wrote), the widget client
 *       sends its visitor cookie, persistContactConsent returns the artifact id, the lib module is
 *       the ONLY writer naming email_captured (fixture positive control), the artifact is resolved
 *       before the update in source order; resolveIdentity DELEGATES to the one match.
 *
 * BLIND SPOTS (published): the trigger and RLS are proven on SQL text, not executed; pipeline-processor,
 * mergeContacts, crm manual dedup, captureContact, instant-greeting, the form route, trackBehavior and
 * the two public routes are proven by source census (their module graphs need the live app), the
 * service, history-carry, person-timeline, distribution and the capture door by execution; the in-memory
 * client has no UNIQUE enforcement, so link idempotency is the service's own pre-read; m706's CHECK is
 * proven on text — in memory the door's own order (artifact, then email) is what keeps the rule.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const G = globalThis as any
G.__102A = { svc: null as MemClient | null, events: [] as any[] }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__102A.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__102A.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export async function emitKernelEvent(i){ globalThis.__102A.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__102A.events.length, fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null, error: r.error ? { message: r.error } : null } }",
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

const A = "00000000-0000-4000-8000-00000000000a"
const B = "00000000-0000-4000-8000-00000000000b"
const UA = "00000000-0000-4000-8000-0000000000a1"
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const MIGRATION = "supabase/migrations/m697-person-identity-and-evidence-under-leads-and-contacts.sql"
/** SQL with `--` comment lines removed (a commented-out clause must never count). */
const sqlBody = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")

async function main() {
  const pi = await import("../lib/kernel/person-identity")

  // ── 1. one person, two evidence rows; different email → different person ──────────────────────
  console.log("\n[1 — same person twice → ONE person + TWO evidence rows; different email → a different person]")
  const svc = memSupabase({ person_identities: [], person_identity_evidence: [] }, { stampCreatedAt: true })
  G.__102A.svc = svc
  const jane = { brokerageId: A, firstName: "Jane", lastName: "Doe", email: "Jane.Doe@Example.com ", phone: "+1 (555) 010-0100" }
  const r1 = await pi.resolvePerson(svc, jane)
  const r2 = await pi.resolvePerson(svc, { ...jane, firstName: " jane ", lastName: "DOE", email: "jane.doe@example.com" })
  check("first resolve creates the person", r1.ok && r1.created && r1.matchMethod === "identity_gate")
  check("second resolve (case/space-insensitive) finds the SAME person", r2.ok && r1.ok && !r2.created && r2.personId === r1.personId)
  check("one person_identities row", (svc.tables.person_identities as any[]).length === 1)
  const pid = r1.ok ? r1.personId : ""
  const l1 = await pi.linkPersonEvidence(svc, { brokerageId: A, personId: pid, entityType: "raw_scraped_lead", entityId: uuid(1), matchMethod: "identity_gate", matchScore: 1, source: "pipeline_processor", identity: r1.ok ? r1.identity : null, detail: { stage: "lead_creation" } })
  const l2 = await pi.linkPersonEvidence(svc, { brokerageId: A, personId: pid, entityType: "raw_scraped_lead", entityId: uuid(2), matchMethod: "dedup_match", matchScore: 0.85, source: "pipeline_processor", identity: r2.ok ? r2.identity : null, detail: { stage: "pre_enrichment" } })
  check("two evidence rows for the two raw records", l1.ok && !l1.duplicate && l2.ok && !l2.duplicate && (svc.tables.person_identity_evidence as any[]).length === 2)
  const ev = svc.tables.person_identity_evidence as any[]
  check("each evidence row names the person, the tenant, the method, the score and the chokepoint", ev.every((e) => e.person_id === pid && e.brokerage_id === A && typeof e.match_method === "string" && e.match_score >= 0 && e.match_score <= 1 && e.source === "pipeline_processor"))
  check("evidence carries a field-provenance stamp through THE one writer (first_name/last_name/email/phone, capability person.resolve_identity)", ev.every((e) => e.detail?.provenance?.email?.capability === "person.resolve_identity" && e.detail.provenance.phone?.source === "pipeline_processor"))
  check("evidence_count bumped to 2 and last_seen_at moved", (svc.tables.person_identities[0] as any).evidence_count === 2 && !!(svc.tables.person_identities[0] as any).last_seen_at)
  const r3 = await pi.resolvePerson(svc, { ...jane, email: "jane.other@example.com" })
  check("a different EMAIL is a DIFFERENT person (same name, same phone)", r3.ok && r3.created && r3.personId !== pid && (svc.tables.person_identities as any[]).length === 2)
  const rNoEmail = await pi.resolvePerson(svc, { brokerageId: A, firstName: "Jane", lastName: "Doe", email: null, phone: "5550100100" })
  const rNoLast = await pi.resolvePerson(svc, { brokerageId: A, firstName: "Jane", lastName: "", email: "x@y.com" })
  check("no email / no last name → refused (no person minted on a phone or a name alone)", !rNoEmail.ok && rNoEmail.reason === "no_identity_anchor" && !rNoLast.ok && (svc.tables.person_identities as any[]).length === 2)
  const rNoTenant = await pi.resolvePerson(svc, { ...jane, brokerageId: null })
  check("no tenant → refused (fail closed)", !rNoTenant.ok && rNoTenant.reason === "no_tenant")
  check("PURE key rule: same person → same key; different email → different key", pi.normalizePersonIdentity(jane)!.key === pi.normalizePersonIdentity({ ...jane, firstName: "JANE " })!.key && pi.normalizePersonIdentity(jane)!.key !== pi.normalizePersonIdentity({ ...jane, email: "a@b.c" })!.key)

  // ── 2. phone corroboration ────────────────────────────────────────────────────────────────────
  console.log("\n[2 — phone corroborates a re-spelled name on the same email; a different phone does not]")
  const rCorr = await pi.resolvePerson(svc, { brokerageId: A, firstName: "Janet", lastName: "Doe", email: "jane.doe@example.com", phone: "555-010-0100" })
  check("same email + same phone digits, name re-spelled → the SAME person via phone_corroborated", rCorr.ok && !rCorr.created && rCorr.personId === pid && rCorr.matchMethod === "phone_corroborated" && rCorr.matchScore < 1)
  const rNoCorr = await pi.resolvePerson(svc, { brokerageId: A, firstName: "Janet", lastName: "Doe", email: "jane.doe@example.com", phone: "555-999-9999" })
  check("NEGATIVE: same email, re-spelled name, DIFFERENT phone → a new person (the key is the gate)", rNoCorr.ok && rNoCorr.created && rNoCorr.personId !== pid)

  // ── 3. tenant isolation ───────────────────────────────────────────────────────────────────────
  console.log("\n[3 — tenant isolation]")
  const rB = await pi.resolvePerson(svc, { ...jane, brokerageId: B })
  check("the same identity in tenant B is a SEPARATE person", rB.ok && rB.created && rB.personId !== pid)
  const linkCross = await pi.linkPersonEvidence(svc, { brokerageId: B, personId: pid, entityType: "lead", entityId: uuid(9), matchMethod: "email_exact", matchScore: 1, source: "unknown_sender" })
  const viewB = await pi.personForLead(svc, { brokerageId: B, leadId: uuid(9) })
  const viewA = await pi.personForContact(svc, { brokerageId: A, contactId: uuid(50) })
  check("a link written under tenant B never surfaces under tenant A's person (the read is tenant-pinned)", linkCross.ok && viewB.ok && viewB.view === null)
  const rawViewA = await pi.personForLead(svc, { brokerageId: B, leadId: uuid(1) })
  check("tenant B cannot see tenant A's raw-record evidence (positive control below: tenant A can)", rawViewA.ok && rawViewA.view === null)
  const noTenantView = await pi.personForContact(svc, { brokerageId: null, contactId: uuid(50) })
  check("a reader with no tenant is refused", !noTenantView.ok && viewA.ok)
  // positive control for the tenant-pinned read: A finds its own
  const evA = (svc.tables.person_identity_evidence as any[]).find((e) => e.entity_id === uuid(1))
  check("POSITIVE CONTROL: tenant A's own raw-record evidence is readable under A", !!evA && evA.brokerage_id === A)

  // ── 4. the one lead→contact LINK writer stamps canonical_contact_id ──────────────────────────
  console.log("\n[4 — carryLeadHistoryToContact stamps canonical_contact_id + promotion_link evidence from the SAME call]")
  const { carryLeadHistoryToContact } = await import("../lib/contact-promotion/history-carry")
  const LEAD = uuid(100), CONTACT = uuid(200)
  const svc2 = memSupabase({
    person_identities: [], person_identity_evidence: [],
    leads: [{ id: LEAD, brokerage_id: A, first_name: "Jane", last_name: "Doe", email: "jane.doe@example.com", phone: "5550100100", contact_id: null, converted_at: null }],
    contacts: [{ id: CONTACT, brokerage_id: A, first_name: "Jane", last_name: "Doe", email: "jane.doe@example.com" }],
  }, { stampCreatedAt: true })
  G.__102A.svc = svc2
  G.__102A.events = []
  // the person already exists from the raw → lead stage (as the pipeline would have left it)
  const pre = await pi.resolvePerson(svc2, { brokerageId: A, firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", phone: "5550100100" })
  await pi.linkPersonEvidence(svc2, { brokerageId: A, personId: pre.ok ? pre.personId : "", entityType: "lead", entityId: LEAD, matchMethod: "identity_gate", matchScore: 1, source: "pipeline_processor", existingEvent: "raw_record_promoted" })
  const carry = await carryLeadHistoryToContact(svc2, { leadId: LEAD, contactId: CONTACT, brokerageId: A })
  const personRow = (svc2.tables.person_identities as any[])[0]
  check("the carry LINKED (leads.contact_id + converted_at) and reports the person id", carry.linked && pre.ok && carry.personId === pre.personId && carry.personLinkReason === null)
  check("ONE person (the pipeline's) — the carry resolved it, never minted a second", (svc2.tables.person_identities as any[]).length === 1)
  check("canonical_contact_id = contacts.id (the PK), converted_at stamped", personRow.canonical_contact_id === CONTACT && !!personRow.converted_at)
  const ev2 = svc2.tables.person_identity_evidence as any[]
  check("promotion_link evidence on the lead AND the contact, source history_carry", ev2.some((e) => e.entity_type === "lead" && e.entity_id === LEAD && e.match_method === "promotion_link" && e.source === "history_carry") && ev2.some((e) => e.entity_type === "contact" && e.entity_id === CONTACT && e.match_method === "promotion_link"))
  check("no person.identity_linked emitted here — the converters' LEAD_CONVERTED_TO_CONTACT is the event (existingEvent)", (G.__102A.events as any[]).length === 0)
  const viewC = await pi.personForContact(svc2, { brokerageId: A, contactId: CONTACT })
  check("personForContact resolves by canonical_contact_id and returns every evidence row", viewC.ok && viewC.view !== null && viewC.view.person.id === personRow.id && viewC.view.evidence.length === 3)
  const viewL = await pi.personForLead(svc2, { brokerageId: A, leadId: LEAD })
  check("personForLead resolves the same person", viewL.ok && viewL.view !== null && viewL.view.person.id === personRow.id)
  const carryNoTenant = await carryLeadHistoryToContact(svc2, { leadId: LEAD, contactId: CONTACT, brokerageId: null })
  check("a carry with no brokerage skips the person link and SAYS so (never a warning, never a throw)", carryNoTenant.personId === null && /no brokerage_id/.test(carryNoTenant.personLinkReason ?? "") && carryNoTenant.warnings.length === 0)

  // ── 5. idempotent links + the one new event ───────────────────────────────────────────────────
  console.log("\n[5 — idempotent links; person.identity_linked only where no chokepoint event exists]")
  G.__102A.events = []
  const before = ev2.length
  const dup = await pi.linkPersonEvidence(svc2, { brokerageId: A, personId: personRow.id, entityType: "contact", entityId: CONTACT, matchMethod: "promotion_link", matchScore: 1, source: "history_carry" })
  check("re-linking the same (person, entity, method) is a no-op reported as duplicate", dup.ok && dup.duplicate && ev2.length === before)
  const merge = await pi.linkPersonEvidence(svc2, { brokerageId: A, personId: personRow.id, entityType: "contact", entityId: uuid(201), matchMethod: "contact_merge", matchScore: 1, source: "contact_merge", actor: { type: "user", userId: UA } })
  const evs = G.__102A.events as any[]
  check("a link with NO existing chokepoint event emits exactly one auditOnly person.identity_linked through emitKernelEvent", merge.ok && evs.length === 1 && evs[0].event === "person.identity_linked" && evs[0].auditOnly === true && evs[0].entityType === "person_identity" && evs[0].entityId === personRow.id && evs[0].brokerageId === A)
  check("the evidence row names the human actor (user + users.id) — LAW 5 'who initiated'", ev2.some((e) => e.entity_id === uuid(201) && e.actor_type === "user" && e.actor_user_id === UA))
  const conv2 = await pi.markPersonConverted(svc2, { brokerageId: A, personId: personRow.id, contactId: uuid(201) })
  check("markPersonConverted fills only when empty (no override) → unchanged", conv2.ok && conv2.changed === false && personRow.canonical_contact_id === CONTACT)
  const conv3 = await pi.markPersonConverted(svc2, { brokerageId: A, personId: personRow.id, contactId: uuid(201), override: true })
  check("…and re-points with override (the merge survivor)", conv3.ok && conv3.changed === true && personRow.canonical_contact_id === uuid(201))
  const badType = await pi.linkPersonEvidence(svc2, { brokerageId: A, personId: personRow.id, entityType: "invoice" as any, entityId: uuid(1), matchMethod: "email_exact", matchScore: 1, source: "x" })
  check("an entity_type outside the vocabulary is refused before any write", !badType.ok && /entity_type/.test(badType.reason))

  // ── 6. absent m697 ────────────────────────────────────────────────────────────────────────────
  console.log("\n[6 — an absent m697 is reported, never thrown; the carry still links]")
  const svc3 = memSupabase({
    leads: [{ id: LEAD, brokerage_id: A, first_name: "Jane", last_name: "Doe", email: "jane.doe@example.com", contact_id: null }],
  }, { missingTables: ["person_identities", "person_identity_evidence"] })
  const rMissing = await pi.resolvePerson(svc3, { brokerageId: A, firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com" })
  check("resolvePerson → ok:false naming the missing relation", !rMissing.ok && /does not exist/.test(rMissing.reason))
  const carryMissing = await carryLeadHistoryToContact(svc3, { leadId: LEAD, contactId: CONTACT, brokerageId: A })
  check("the carry still LINKS and reports the lost person link on the result", carryMissing.linked && carryMissing.personId === null && /does not exist/.test(carryMissing.personLinkReason ?? ""))
  const throwing = { from: () => { throw new Error("boom") } }
  const rThrow = await pi.resolvePerson(throwing as any, { brokerageId: A, firstName: "J", lastName: "D", email: "j@d.co" })
  check("a throwing client is caught and reported (unavailable), never propagated", !rThrow.ok && /boom/.test(rThrow.reason))

  // ── 7. the timeline folds every person-linked lead + raw row ──────────────────────────────────
  console.log("\n[7 — buildPersonTimeline folds a second, dedup-linked lead and its raw row into ONE timeline]")
  const { buildPersonTimeline, redactForContactView } = await import("../lib/lead-intelligence/person-timeline")
  const LEAD2 = uuid(101), RAW1 = uuid(301), RAW2 = uuid(302), RAW3 = uuid(303)
  const t0 = "2026-09-01T00:00:00.000Z"
  const svc4 = memSupabase({
    person_identities: [{ id: uuid(400), brokerage_id: A, identity_key: "jane|doe|jane.doe@example.com", email_normalized: "jane.doe@example.com", first_name_normalized: "jane", last_name_normalized: "doe", phone_digits: null, canonical_contact_id: CONTACT, converted_at: "2026-09-10T00:00:00.000Z", evidence_count: 4 }],
    person_identity_evidence: [
      { id: uuid(401), brokerage_id: A, person_id: uuid(400), entity_type: "lead", entity_id: LEAD, match_method: "identity_gate", match_score: 1, source: "pipeline_processor", observed_at: t0, actor_type: "system" },
      { id: uuid(402), brokerage_id: A, person_id: uuid(400), entity_type: "lead", entity_id: LEAD2, match_method: "dedup_match", match_score: 0.85, source: "pipeline_processor", observed_at: "2026-09-05T00:00:00.000Z", actor_type: "system" },
      { id: uuid(403), brokerage_id: A, person_id: uuid(400), entity_type: "raw_scraped_lead", entity_id: RAW3, match_method: "dedup_match", match_score: 0.85, source: "pipeline_processor", observed_at: "2026-09-06T00:00:00.000Z", actor_type: "system", detail: { costUsd: 0.25 } },
      { id: uuid(404), brokerage_id: A, person_id: uuid(400), entity_type: "contact", entity_id: CONTACT, match_method: "promotion_link", match_score: 1, source: "history_carry", observed_at: "2026-09-10T00:00:00.000Z", actor_type: "system" },
    ],
    leads: [
      { id: LEAD, brokerage_id: A, contact_id: CONTACT, converted_at: "2026-09-10T00:00:00.000Z", source: "zillow", raw_record_id: RAW1, cost_per_record: 2, acquisition_cost: 4 },
      { id: LEAD2, brokerage_id: A, contact_id: null, converted_at: null, source: "batchdata_motivated", raw_record_id: RAW2, cost_per_record: 1, acquisition_cost: null },
    ],
    contact_lead_history: [{ lead_id: LEAD, contact_id: CONTACT, contact_brokerage_id: A, converted_at: "2026-09-10T00:00:00.000Z" }],
    raw_scraped_leads: [
      { id: RAW1, lead_id: LEAD, source: "zillow", created_at: "2026-08-20T00:00:00.000Z", raw_data: {} },
      { id: RAW2, lead_id: LEAD2, source: "batchdata_motivated", created_at: "2026-09-04T00:00:00.000Z", raw_data: {} },
      { id: RAW3, lead_id: null, source: "exa", created_at: "2026-09-06T00:00:00.000Z", raw_data: {} },
    ],
  })
  G.__102A.svc = svc4
  const tl = await buildPersonTimeline({ contactId: CONTACT, brokerageId: A, client: svc4 as any })
  check("the timeline names the person", tl.personId === uuid(400))
  check("BOTH leads' raw rows fold in (lineage knew one lead; the evidence added the second)", tl.events.some((e) => e.id === `raw:${RAW1}`) && tl.events.some((e) => e.id === `raw:${RAW2}`))
  check("the dedup-skipped raw row with NO lead (the re-scrape) folds in through the person", tl.events.some((e) => e.id === `raw:${RAW3}`))
  check("four identity_evidence events, lead-desk only, each naming method + score + source", tl.events.filter((e) => e.type === "identity_evidence").length === 4 && tl.events.filter((e) => e.type === "identity_evidence").every((e) => e.sensitivity === "lead_desk_only" && typeof e.detail?.matchMethod === "string" && typeof e.detail?.matchScore === "number"))
  check("no warning about the person read (m697 present here)", !tl.warnings.some((w) => /person identity/.test(w)))
  const agentView = redactForContactView(tl)
  check("the contact (agent) view keeps post-conversion identity evidence and drops pre-conversion scrape provenance", agentView.some((e) => e.type === "identity_evidence" && e.id === `identity:${uuid(404)}`) && !agentView.some((e) => e.id === `raw:${RAW3}`))
  const svc4b = memSupabase({ leads: [{ id: LEAD, brokerage_id: A, contact_id: CONTACT, converted_at: null, source: "zillow", raw_record_id: RAW1 }], contact_lead_history: [], raw_scraped_leads: [] }, { missingTables: ["person_identities", "person_identity_evidence"] })
  const tlMissing = await buildPersonTimeline({ leadId: LEAD, brokerageId: A, client: svc4b as any })
  check("an absent m697 is a timeline WARNING, not a failure (personId null)", tlMissing.personId === null && tlMissing.warnings.some((w) => /person identity read refused/.test(w)))

  // ── 8. the agent-facing summary carries no cost key ───────────────────────────────────────────
  console.log("\n[8 — summarizePersonEvidence: no cost key; confidence folds]")
  const sum = pi.summarizePersonEvidence({ person: (svc4.tables.person_identities as any[])[0], evidence: svc4.tables.person_identity_evidence as any[] })
  const sumText = JSON.stringify(sum)
  check("summary: 4 evidence rows, sources deduplicated and sorted, linked counts per entity type", sum.evidenceCount === 4 && sum.sources.join(",") === "history_carry,pipeline_processor" && sum.linked.lead === 2 && sum.linked.raw_scraped_lead === 1 && sum.linked.contact === 1)
  check("confidence is the strongest method lifted by corroboration, capped at 1", sum.confidence === 1)
  check("POSITIVE CONTROL: the fixture's costUsd detail key never reaches the summary", /costUsd/.test(JSON.stringify(svc4.tables.person_identity_evidence)) && !/cost|usd|spend|price/i.test(sumText))
  check("human lines name the method, never a raw id", sum.how.length === 4 && sum.how.every((h) => /same name and email|dedup match|promoted lead/.test(h)) && !sumText.includes(RAW3))

  // ── 9. m697 text ──────────────────────────────────────────────────────────────────────────────
  console.log("\n[9 — m697 text: vocabularies == code, append-only trigger, RLS, unique keys]")
  const mig = raw(MIGRATION)
  const body = sqlBody(mig)
  // CLAUDE.md §2: assert the RULE (one provenance stamp on line 1 — the lane's "WRITTEN, NOT APPLIED" or
  // the integrator's "APPLIED LIVE <date>"), never the pre-apply waypoint.
  check("header line 1 carries one provenance stamp (the lane stamp | APPLIED LIVE <date>)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}\b)/.test(mig.split("\n")[0]))
  const checkList = (constraint: string, text = body): string[] => {
    const m = new RegExp(`${constraint}\\s*CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, "s").exec(text)
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : []
  }
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])
  check(`entity_type CHECK == PERSON_ENTITY_TYPES (${pi.PERSON_ENTITY_TYPES.length})`, same(checkList("person_identity_evidence_entity_type_check"), pi.PERSON_ENTITY_TYPES))
  check(`match_method CHECK == PERSON_MATCH_METHODS (${pi.PERSON_MATCH_METHODS.length})`, same(checkList("person_identity_evidence_match_method_check"), pi.PERSON_MATCH_METHODS))
  check("actor_type CHECK is the agent_action_ledger vocabulary", same(checkList("person_identity_evidence_actor_type_check"), ["manager", "user", "agent", "system"]))
  check("POSITIVE CONTROL: a widened CHECK in the text would disagree with the code", !same(checkList("person_identity_evidence_entity_type_check", body.replace("'behavioral_signal'", "'behavioral_signal', 'invoice'")), pi.PERSON_ENTITY_TYPES))
  const trig = /CREATE OR REPLACE FUNCTION public\.person_identity_evidence_append_only\(\)[\s\S]*?\$\$;/.exec(body)?.[0] ?? ""
  check("append-only trigger function refuses with the cascade pass-through (pg_trigger_depth() > 1)", /pg_trigger_depth\(\)\s*>\s*1/.test(trig) && /RAISE EXCEPTION/.test(trig) && /TG_OP/.test(trig))
  check("…bound BEFORE UPDATE OR DELETE on person_identity_evidence", /CREATE TRIGGER person_identity_evidence_append_only\s+BEFORE UPDATE OR DELETE ON public\.person_identity_evidence/.test(body))
  check("POSITIVE CONTROL: the same test fails on a trigger without the depth guard", !/pg_trigger_depth\(\)\s*>\s*1/.test(trig.replace(/pg_trigger_depth\(\)\s*>\s*1/, "false")))
  for (const t of ["person_identities", "person_identity_evidence"]) {
    check(`${t}: RLS enabled, INSERT/UPDATE/DELETE revoked from anon + authenticated`, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(body) && new RegExp(`REVOKE INSERT, UPDATE, DELETE ON public\\.${t} FROM anon, authenticated`).test(body))
    check(`${t}: the only policy is a tenant-scoped SELECT (is_platform_admin() OR has_brokerage_access(brokerage_id))`, new RegExp(`CREATE POLICY ${t}_select ON public\\.${t}\\s+FOR SELECT TO authenticated\\s+USING \\(is_platform_admin\\(\\) OR has_brokerage_access\\(brokerage_id\\)\\)`).test(body) && (body.match(new RegExp(`CREATE POLICY \\w+ ON public\\.${t}`, "g")) ?? []).length === 1)
  }
  check("POSITIVE CONTROL: a USING (true) policy would fail the tenant-scope test", !/USING \(is_platform_admin\(\) OR has_brokerage_access\(brokerage_id\)\)/.test(body.replace(/USING \(is_platform_admin\(\) OR has_brokerage_access\(brokerage_id\)\)/g, "USING (true)")))
  check("UNIQUE (brokerage_id, identity_key) — one person per tenant per gate key", /UNIQUE \(brokerage_id, identity_key\)/.test(body))
  check("UNIQUE (person_id, entity_type, entity_id, match_method) — one evidence row per link", /UNIQUE \(person_id, entity_type, entity_id, match_method\)/.test(body))
  check("identity_key is DERIVED from the normalised triple (CHECK), never free text", /identity_key = first_name_normalized \|\| '\|' \|\| last_name_normalized \|\| '\|' \|\| email_normalized/.test(body))
  check("canonical_contact_id → contacts(id) ON DELETE SET NULL (never contacts.contact_id)", /canonical_contact_id\s+uuid REFERENCES public\.contacts\(id\) ON DELETE SET NULL/.test(body))
  check("NO ALTER TABLE on leads or contacts (additive only, no destructive migration)", !/ALTER TABLE public\.(leads|contacts)\b/.test(body) && !/ALTER TABLE (leads|contacts)\b/.test(body))
  check("two-part apply markers present (PART A tables, PART B indexes/trigger/RLS)", /PART A — tables/.test(mig) && /PART B — indexes, trigger, RLS/.test(mig))

  // ── 10. census: every chokepoint reaches the ONE service ──────────────────────────────────────
  console.log("\n[10 — census (stripped source): every chokepoint and reader reaches lib/kernel/person-identity.ts]")
  const SITES: Array<{ file: string; needs: RegExp[]; label: string }> = [
    { file: "lib/lead-pipeline/pipeline-processor.ts", label: "pipeline-processor: identity gate + dedup verdicts + lead creation (+ R2: every verdict names its survivor)", needs: [/from ['"]@\/lib\/kernel\/person-identity['"]/, /resolvePerson\(/, /resolveSurvivorPerson\(/, /linkPersonEvidence\(/, /matchMethod: 'dedup_match'/, /matchMethod: 'identity_gate'/, /person_id: personId/, /dedupSurvivor\(preEnrichDuplicate\)/, /dedupSurvivor\(postEnrichDuplicate\)/] },
    { file: "lib/kernel/crm.ts", label: "crm manual dedup (R2): the verdict links onto the SURVIVOR contact's person, CONTACT_MERGED is the event", needs: [/resolveSurvivorPerson\(/, /survivor: \{ entityType: "contact", entityId: params\.existingContactId \}/, /matchMethod: "dedup_match", matchScore: 0\.9/, /existingEvent: KernelEvent\.CONTACT_MERGED/] },
    { file: "lib/contact-pipeline/contact-capture.ts", label: "captureContact: resolve + link ONCE inside (merge at its fuzzy score, create at 1.0), the capture's own event", needs: [/person-identity/, /matchMethod: 'capture_match'/, /existingEvent: action === 'merged' \? KernelEvent\.CONTACT_DEDUP_MERGED : KernelEvent\.CONTACT_CAPTURED/, /recordCapturePersonEvidence\(supabase, params, bestId, 'merged', bestScore\)/, /recordCapturePersonEvidence\(supabase, params, contactId, 'created', 1\)/, /personId: person\.personId, personIdentity: person\.identity/] },
    // Wave 103 (103D): the match + the evidence writer moved to lib/lead-intelligence/visitor-email-capture.ts so
    // the PUBLIC capture door (no session) and the staff action run ONE match; the action delegates with its
    // session tenant + human actor, the door passes the slug-resolved tenant + no human (system actor).
    { file: "lib/lead-intelligence/visitor-email-capture.ts", label: "visitor-identify loop: THE behavioral_signals.identified writer links signal + contact (email_exact); human actor when a user ran it, system for the public door", needs: [/entityType: "behavioral_signal"/, /matchMethod: "email_exact"/, /\.from\("behavioral_signals"\)\s*\.update\(\{ identified: true, contact_id: contact\.id \}\)[\s\S]{0,600}recordBehavioralSignalIdentity\(client, \{ brokerageId: input\.brokerageId, signalId: signal\.id/, /input\.actorUserId \? \{ type: "user" as const, userId: input\.actorUserId \} : \{ type: "system" as const, userId: null \}/] },
    { file: "app/actions/lead-intelligence.ts", label: "resolveIdentity (staff) DELEGATES to the one match with its session tenant + actor; trackBehavior (the public door) captures through captureConsentedVisitorEmail with no human actor", needs: [/resolveSignalIdentity\(supabase, \{ brokerageId: auth\.brokerageId, signalId: behavioralSignalId, actorUserId: auth\.userId \}\)/, /captureConsentedVisitorEmail\(supabase, \{[\s\S]{0,600}actorUserId: null,/] },
    { file: "lib/platform/distribution-engine.ts", label: "distribution (R1): person re-homed under the RECEIVING brokerage, lead + raw linked there, after the distribution write", needs: [/person-identity/, /brokerageId: targetBrokerageId,\s*firstName: lead\.first_name/, /matchMethod: "dedup_match" as const/, /entityType: "lead", entityId: lead\.id/, /entityType: "raw_scraped_lead", entityId: lead\.raw_record_id/, /\.is\("distribution_brokerage_id", null\)[\s\S]*rehomePersonUnderReceivingBrokerage\(supabase, lead, targetBrokerageId, rotationPosition\)/] },
    { file: "app/crm/contacts/[contactId]/components/identity-evidence-card.tsx", label: "identity evidence CARD reads the brief's identityEvidence (confidence / sources / linked / how)", needs: [/\/api\/contacts\/\$\{contactId\}\/brief/, /identityEvidence/, /evidence\.confidence/, /evidence\.sources/, /evidence\.linked/, /evidence\.how/] },
    { file: "app/crm/contacts/[contactId]/page.tsx", label: "the contact detail pane mounts the card next to the lead-history card", needs: [/<LeadHistoryCard contactId=\{contactId\} \/>[\s\S]{0,600}<IdentityEvidenceCard contactId=\{contactId\} \/>/] },
    { file: "lib/contact-promotion/history-carry.ts", label: "history-carry: canonical_contact_id from the LINK call", needs: [/person-identity/, /resolvePerson\(/, /markPersonConverted\(/, /matchMethod: "promotion_link"/, /existingEvent: "lead_converted_to_contact"/] },
    { file: "lib/services/contact-management.service.ts", label: "mergeContacts: contact_merge evidence + survivor re-point", needs: [/person-identity/, /matchMethod: "contact_merge"/, /override: true/, /type: "user" as const, userId: auth\?\.user\?\.id/] },
    { file: "lib/lead-pipeline/unknown-sender-identification.ts", label: "unknown sender: email match → evidence, person_id on the event", needs: [/person-identity/, /matchMethod: "email_exact"/, /person_id: personId/] },
    { file: "lib/open-house/instant-greeting.ts", label: "open-house kiosk: contact + attendee evidence", needs: [/person-identity/, /entityType: "open_house_attendee"/, /matchMethod: "capture_match"/, /lastName: input\.lastName/] },
    { file: "app/api/open-house/attend/route.ts", label: "attend route passes lastName to the kiosk greeting", needs: [/sendInstantOpenHouseGreeting\(\{[\s\S]*?lastName,[\s\S]*?\}\)/] },
    { file: "app/api/forms/submit/route.ts", label: "form submit: ONE path — the person from captureContact, only the submission row linked here, person_id on FORM_SUBMISSION_RECEIVED", needs: [/person-identity/, /personId: capturedPersonId, personIdentity/, /entityType: 'form_submission'/, /person_id: personId/] },
    { file: "lib/lead-intelligence/person-timeline.ts", label: "person-timeline reads personForContact / personForLead", needs: [/personForContact\(/, /personForLead\(/, /"identity_evidence"/] },
    { file: "lib/contacts/contact-brief.ts", label: "contact-brief reads personForContact + summarizePersonEvidence", needs: [/personForContact\(/, /summarizePersonEvidence\(/, /identityEvidence/] },
  ]
  for (const s of SITES) {
    const text = src(s.file)
    const missing = s.needs.filter((re) => !re.test(text))
    check(s.label, missing.length === 0, missing.map(String).join(" | "))
  }
  const carrySite = SITES.find((s) => s.file === "lib/contact-promotion/history-carry.ts")!
  check("POSITIVE CONTROL: a chokepoint fixture WITHOUT the call fails the same census", carrySite.needs.some((re) => !re.test(src(carrySite.file).replace(/person-identity/g, "person-xxx"))))
  // the service is the only inserter of the two tables
  const { readdirSync, statSync } = await import("node:fs")
  const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(join(ROOT, dir))) { if (n === "node_modules" || n.startsWith(".")) continue; const p = `${dir}/${n}`; if (statSync(join(ROOT, p)).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p) } return out }
  const inserters: string[] = []
  for (const f of [...walk("lib"), ...walk("app")]) {
    const t = src(f)
    if (/\.from\(["'](person_identities|person_identity_evidence)["']\)\s*\.insert\(/.test(t) || /\.from\(["'](person_identities|person_identity_evidence)["']\)[\s\S]{0,200}?\.insert\(/.test(t)) inserters.push(f)
  }
  check(`the kernel service is the ONLY inserter of person_identities / person_identity_evidence (${inserters.join(", ") || "none"})`, inserters.length === 1 && inserters[0] === "lib/kernel/person-identity.ts")
  check("POSITIVE CONTROL: the inserter finder recognises the service's own insert", /\.from\(["']person_identity_evidence["']\)[\s\S]{0,200}?\.insert\(/.test(src("lib/kernel/person-identity.ts")))
  // ONE path per door: the form route no longer resolves or links the contact itself (captureContact does).
  const formSrc = src("app/api/forms/submit/route.ts")
  check("form route: no resolvePerson and no contact link of its own (captureContact is the one writer for the contact)", !/resolvePerson\(/.test(formSrc) && !/entityType: 'contact'/.test(formSrc))
  check("POSITIVE CONTROL: the pre-102E form route (its own resolvePerson) would fail that census", /resolvePerson\(/.test(formSrc.replace(/linkPersonEvidence\(/, "resolvePerson(")))
  check("the behavioral_signal evidence helper is module-private in the lib module (not exported) and no second copy is left in the 'use server' file (tombstone only)", !/export async function recordBehavioralSignalIdentity/.test(src("lib/lead-intelligence/visitor-email-capture.ts")) && /async function recordBehavioralSignalIdentity/.test(src("lib/lead-intelligence/visitor-email-capture.ts")) && !/function recordBehavioralSignalIdentity/.test(src("app/actions/lead-intelligence.ts")) && !/\.eq\("email", signal\.email_captured\)/.test(src("app/actions/lead-intelligence.ts")))

  // ── 11. R2 — a dedup verdict links onto the SURVIVOR's person (wave 102.1, lane 102E) ────────
  console.log("\n[11 — R2: a verdict with a DIFFERENT email links the record onto the survivor's person; never a second person]")
  const svc5 = memSupabase({ person_identities: [], person_identity_evidence: [] }, { stampCreatedAt: true })
  G.__102A.svc = svc5
  G.__102A.events = []
  const L1 = uuid(501), RAWB = uuid(502), C2 = uuid(503), RAWC = uuid(504), L3 = uuid(505)
  const janeA = { firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", phone: "5550100100" }
  const janeB = { firstName: "Jane", lastName: "Doe", email: "jane.d@work.example", phone: null }
  const p0 = await pi.resolvePerson(svc5, { brokerageId: A, ...janeA })
  await pi.linkPersonEvidence(svc5, { brokerageId: A, personId: p0.ok ? p0.personId : "", entityType: "lead", entityId: L1, matchMethod: "identity_gate", matchScore: 1, source: "pipeline_processor", existingEvent: "raw_record_promoted" })
  const viaEvidence = await pi.resolveSurvivorPerson(svc5, { brokerageId: A, survivor: { entityType: "lead", entityId: L1 }, survivorIdentity: janeA, recordIdentity: janeB })
  check("survivor lead with evidence → its person (via survivor_evidence), nothing created", viaEvidence.ok && p0.ok && viaEvidence.personId === p0.personId && viaEvidence.via === "survivor_evidence" && !viaEvidence.created)
  check("ONE person row — the record's other email did NOT mint a second", (svc5.tables.person_identities as any[]).length === 1)
  const lk = await pi.linkPersonEvidence(svc5, { brokerageId: A, personId: viaEvidence.ok ? viaEvidence.personId : "", entityType: "raw_scraped_lead", entityId: RAWB, matchMethod: "dedup_match", matchScore: 0.85, source: "pipeline_processor", identity: viaEvidence.ok ? viaEvidence.identity : null, detail: { stage: "pre_enrichment" }, existingEvent: "raw_record_promoted" })
  const rawLink = (svc5.tables.person_identity_evidence as any[]).find((e) => e.entity_type === "raw_scraped_lead" && e.entity_id === RAWB)
  const viaRawSurvivor = await pi.resolveSurvivorPerson(svc5, { brokerageId: A, survivor: { entityType: "raw_scraped_lead", entityId: RAWB }, survivorIdentity: janeB })
  check("the record is linked onto the survivor's person at the verdict's score (dedup_match 0.85); a later verdict naming THAT raw row as survivor resolves the same person", lk.ok && !lk.duplicate && p0.ok && rawLink?.person_id === p0.personId && rawLink?.match_score === 0.85 && viaRawSurvivor.ok && viaRawSurvivor.personId === p0.personId && viaRawSurvivor.via === "survivor_evidence")
  const janeC = { firstName: "Jane", lastName: "Doe", email: "jane.c@third.example", phone: null }
  const janeD = { firstName: "Jane", lastName: "Doe", email: "jane.d@fourth.example", phone: null }
  const viaIdentity = await pi.resolveSurvivorPerson(svc5, { brokerageId: A, survivor: { entityType: "contact", entityId: C2 }, survivorIdentity: janeC, recordIdentity: janeD })
  const keyedOn = (svc5.tables.person_identities as any[]).find((p) => p.id === (viaIdentity.ok ? viaIdentity.personId : ""))
  check("survivor contact with NO evidence → a person keyed on the SURVIVOR's email (via survivor_identity), not the record's", viaIdentity.ok && viaIdentity.via === "survivor_identity" && viaIdentity.created && keyedOn?.email_normalized === "jane.c@third.example")
  const viaRecord = await pi.resolveSurvivorPerson(svc5, { brokerageId: A, survivor: { entityType: "lead", entityId: L3 }, survivorIdentity: { firstName: "Jane", lastName: null, email: null }, recordIdentity: janeD })
  check("survivor without a gate identity → the record's own identity keys it (via record_identity)", viaRecord.ok && viaRecord.via === "record_identity")
  const noAnchor = await pi.resolveSurvivorPerson(svc5, { brokerageId: A, survivor: { entityType: "lead", entityId: L3 }, survivorIdentity: { firstName: "J", lastName: null, email: null }, recordIdentity: { firstName: null, lastName: null, email: null } })
  const noTenant = await pi.resolveSurvivorPerson(svc5, { brokerageId: null, survivor: { entityType: "lead", entityId: L1 }, survivorIdentity: janeA })
  check("no gate identity on either side → no_identity_anchor; no tenant → refused (fail closed)", !noAnchor.ok && noAnchor.reason === "no_identity_anchor" && !noTenant.ok && noTenant.reason === "no_tenant")
  const before11 = (svc5.tables.person_identities as any[]).length
  const oldPath = await pi.resolvePerson(svc5, { brokerageId: A, ...janeB })
  check("POSITIVE CONTROL: the pre-R2 path (resolvePerson on the record's own email) WOULD have minted a second person", oldPath.ok && oldPath.created && (svc5.tables.person_identities as any[]).length === before11 + 1)
  const crossB = await pi.resolveSurvivorPerson(svc5, { brokerageId: B, survivor: { entityType: "lead", entityId: L1 }, survivorIdentity: janeA })
  check("tenant B resolving the same survivor never sees tenant A's person (a new person under B)", crossB.ok && p0.ok && crossB.personId !== p0.personId && crossB.via === "survivor_identity")
  void RAWC

  // ── 12. R1 — distribution re-homes the person under the RECEIVING brokerage ──────────────────
  console.log("\n[12 — R1: distributePlatformLead resolves the person under the receiving brokerage; nothing crosses tenants]")
  const MARKET = uuid(600), SUB = uuid(601), DLEAD = uuid(602), DRAW = uuid(603)
  const svc6 = memSupabase({
    person_identities: [], person_identity_evidence: [],
    leads: [{ id: DLEAD, source_origin: "platform", property_zip_code: null, mailing_zip: null, zip_code: "30301", brokerage_id: null, distribution_brokerage_id: null, phone_digits: null, email: "jane.doe@example.com", source_family: "scrape", motivation_type: null, urgency_level: null, raw_record_id: DRAW, first_name: "Jane", last_name: "Doe", phone: "5550100100" }],
    raw_scraped_leads: [{ id: DRAW, brokerage_id: null }],
    subscriber_service_areas: [{ brokerage_id: SUB, joined_at: "2026-01-01T00:00:00.000Z", zip_code: "30301", active: true, agent_user_id: null, team_id: null }],
    platform_lead_distributions: [], platform_suppression_list: [], self_heal_ledger: [], agent_action_ledger: [],
  }, { stampCreatedAt: true })
  G.__102A.svc = svc6
  G.__102A.events = []
  const market = await pi.resolvePerson(svc6, { brokerageId: MARKET, firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", phone: "5550100100" })
  await pi.linkPersonEvidence(svc6, { brokerageId: MARKET, personId: market.ok ? market.personId : "", entityType: "lead", entityId: DLEAD, matchMethod: "identity_gate", matchScore: 1, source: "pipeline_processor", existingEvent: "raw_record_promoted" })
  let distributed: any = null
  let distErr: string | null = null
  try {
    const { distributePlatformLead } = await import("../lib/platform/distribution-engine")
    distributed = await distributePlatformLead({ leadId: DLEAD })
  } catch (err) { distErr = err instanceof Error ? err.message : String(err) }
  check("distributePlatformLead ran in-memory and placed the lead under the subscriber", distErr === null && distributed?.success === true && distributed?.brokerageId === SUB, distErr ?? JSON.stringify(distributed))
  const persons6 = svc6.tables.person_identities as any[]
  const ev6 = svc6.tables.person_identity_evidence as any[]
  const subPerson = persons6.find((p) => p.brokerage_id === SUB)
  check("a SECOND person row exists under the receiving brokerage (the market-owner row untouched)", persons6.length === 2 && !!subPerson && persons6.some((p) => p.brokerage_id === MARKET && market.ok && p.id === market.personId))
  check("lead + raw row linked under the receiving tenant (dedup_match at distribution, 1.0, source platform_distribution)", !!subPerson && ev6.some((e) => e.brokerage_id === SUB && e.person_id === subPerson.id && e.entity_type === "lead" && e.entity_id === DLEAD && e.match_method === "dedup_match" && e.match_score === 1 && e.source === "platform_distribution" && e.detail?.stage === "distribution") && ev6.some((e) => e.brokerage_id === SUB && e.person_id === subPerson.id && e.entity_type === "raw_scraped_lead" && e.entity_id === DRAW))
  check("nothing crosses tenants: no evidence under SUB names the market-owner person; the market-owner evidence is unchanged", market.ok && !ev6.some((e) => e.brokerage_id === SUB && JSON.stringify(e).includes(market.personId)) && ev6.filter((e) => e.brokerage_id === MARKET).length === 1)
  check("no chokepoint event at distribution → the one person.identity_linked event emitted, under the receiving tenant", (G.__102A.events as any[]).some((e) => e.event === "person.identity_linked" && e.brokerageId === SUB) && !(G.__102A.events as any[]).some((e) => e.brokerageId === MARKET))
  const viewSub = await pi.personForLead(svc6, { brokerageId: SUB, leadId: DLEAD })
  const viewMkt = await pi.personForLead(svc6, { brokerageId: MARKET, leadId: DLEAD })
  check("personForLead answers per tenant: the subscriber sees its person, the market owner still sees its own", viewSub.ok && viewSub.view?.person.id === subPerson?.id && viewMkt.ok && market.ok && viewMkt.view?.person.id === market.personId)

  // ── 13. R6 — ProvenancePurpose gains `conversation` ───────────────────────────────────────────
  console.log("\n[13 — R6: ProvenancePurpose has `conversation`; the AI-stated address keeps self_service]")
  const purposesText = /const PROVENANCE_PURPOSES = \[([\s\S]*?)\] as const/.exec(src("lib/lead-pipeline/enrichment-column-map.ts"))?.[1] ?? ""
  const purposes = [...purposesText.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  check(`PROVENANCE_PURPOSES (${purposes.length}) includes conversation AND self_service (one vocabulary, both kept)`, purposes.includes("conversation") && purposes.includes("self_service") && new Set(purposes).size === purposes.length)
  check("the AI-stated address still stamps self_service (R6: they typed it themselves)", /purpose: "self_service"/.test(src("lib/ai-isa/customer-context-tools.ts")))
  check("POSITIVE CONTROL: the parser sees the vocabulary shrink when a value is removed", ![...purposesText.replace("'conversation',", "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).includes("conversation"))
  const purposeSwitches = [...walk("lib"), ...walk("app"), ...walk("scripts")].filter((f) => f !== "scripts/person-identity-guard.ts" && /Record<ProvenancePurpose\b/.test(src(f)))
  check(`no Record<ProvenancePurpose, …> exhaustive map exists that would now miss 'conversation' (${purposeSwitches.length} found)`, purposeSwitches.length === 0, purposeSwitches.join(", "))

  // ── 14. the card never renders a cost ─────────────────────────────────────────────────────────
  console.log("\n[14 — identity evidence card: reads only the summary's fields, no cost key]")
  const cardSrc = src("app/crm/contacts/[contactId]/components/identity-evidence-card.tsx")
  check("the card reads no cost / spend / price property (the summary has none; the card cannot invent one)", !/\.(cost|spend|usd|price|budget)\w*/i.test(cardSrc) && !/\b(cost|spend|usd|price)_\w+/i.test(cardSrc))
  check("the card renders no raw id (personId is never printed)", !/\{evidence\.personId\}/.test(cardSrc))
  check("POSITIVE CONTROL: a card reading evidence.costUsd would fail", /\.(cost|spend|usd|price|budget)\w*/i.test(cardSrc + "\n{evidence.costUsd}"))

  // ── 15. m706 — the consented capture columns (wave 103, lane 103D; owner answer 1) ────────────
  console.log("\n[15 — m706 text: three additive columns, FK to the consent ledger, the fail-closed CHECK, nothing destructive]")
  const M706 = "supabase/migrations/m706-consented-visitor-email-capture-on-behavioral-signals.sql"
  const mig706 = raw(M706)
  const body706 = sqlBody(mig706)
  check("m706 header line 1 carries one provenance stamp (the lane stamp | APPLIED LIVE <date>)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}\b)/.test(mig706.split("\n")[0]))
  check("ADD COLUMN IF NOT EXISTS email_captured text + email_captured_at timestamptz on behavioral_signals", /ALTER TABLE public\.behavioral_signals\s+ADD COLUMN IF NOT EXISTS email_captured text,\s+ADD COLUMN IF NOT EXISTS email_captured_at timestamptz,/.test(body706))
  check("consent_event_id uuid REFERENCES public.contact_consent_events(id) — the consent ledger, with NO ON DELETE action (erase the email before the artifact)", /ADD COLUMN IF NOT EXISTS consent_event_id uuid REFERENCES public\.contact_consent_events\(id\);/.test(body706) && !/consent_event_id uuid REFERENCES public\.contact_consent_events\(id\) ON DELETE/.test(body706))
  const check706 = /CHECK \(([^)]*)\)/.exec(body706.slice(body706.indexOf("behavioral_signals_email_requires_consent_check\n")))?.[1] ?? ""
  check("the fail-closed rule is a CHECK at the database: email_captured IS NULL OR consent_event_id IS NOT NULL", check706.replace(/\s+/g, " ").trim() === "email_captured IS NULL OR consent_event_id IS NOT NULL")
  check("POSITIVE CONTROL: a CHECK that let an email sit without a consent artifact would fail the same finder", (/CHECK \(([^)]*)\)/.exec(body706.replace("email_captured IS NULL OR consent_event_id IS NOT NULL", "email_captured IS NULL OR consent_event_id IS NULL").slice(body706.indexOf("behavioral_signals_email_requires_consent_check\n")))?.[1] ?? "") !== "email_captured IS NULL OR consent_event_id IS NOT NULL")
  // SQL string literals (the COMMENT ON COLUMN prose says "ON DELETE") are blanked before the scan —
  // a comment is not a statement (CLAUDE.md §2: strip before you scan for tokens).
  const stmts706 = body706.replace(/'(?:[^']|'')*'/g, "''")
  check("nothing destructive: no DROP COLUMN / DROP TABLE / DELETE / UPDATE / TRUNCATE statement, no ALTER of contacts, leads or contact_consent_events", !/DROP COLUMN|DROP TABLE|\bDELETE\b|\bUPDATE\b|TRUNCATE/.test(stmts706) && !/ALTER TABLE public\.(contacts|leads|contact_consent_events)\b/.test(stmts706))
  check("POSITIVE CONTROL: a DROP COLUMN statement in the text would fail that scan", /DROP COLUMN/.test((stmts706 + "\nALTER TABLE public.behavioral_signals DROP COLUMN email_captured;")))
  check("two-part apply markers present (PART A columns + CHECK, PART B index)", /PART A — columns, CHECK/.test(mig706) && /PART B — index/.test(mig706))
  const sigCols = /behavioral_signals: \[([^\]]*)\]/.exec(raw("scripts/schema-snapshot.ts"))?.[1] ?? ""
  console.log(`    published: behavioral_signals.email_captured in the live snapshot: ${/"email_captured"/.test(sigCols) ? "PRESENT (m706 applied; the loop fires live)" : "ABSENT — the column awaits the integrator (m706): the door refuses to store (42703 / PGRST204 on the update is read and reported as store_refused) until the migration is live and the snapshot regenerated"}`)

  // ── 16. the capture door, executed in memory: no consent → nothing stored ─────────────────────
  console.log("\n[16 — consented visitor email capture (the ONE door, in memory): fail closed, the artifact first, then the signal, then the identify loop]")
  const vec = await import("../lib/lead-intelligence/visitor-email-capture")
  const SIG = uuid(700), SIGB = uuid(701), CON7 = uuid(702), EVB = uuid(703), EVNO = uuid(704), SIGOLD = uuid(705)
  const seedSignals = () => [
    { id: SIG, brokerage_id: A, visitor_id: "v-1", identified: false, contact_id: null, email_captured: null, email_captured_at: null, consent_event_id: null },
    { id: SIGB, brokerage_id: B, visitor_id: "v-2", identified: false, contact_id: null, email_captured: null, email_captured_at: null, consent_event_id: null },
    { id: SIGOLD, brokerage_id: A, visitor_id: "v-3", identified: false, contact_id: null, email_captured: "old@example.com", email_captured_at: null, consent_event_id: null },
  ]
  const svc7 = memSupabase({
    behavioral_signals: seedSignals(), contact_consent_events: [], person_identities: [], person_identity_evidence: [],
    contacts: [{ id: CON7, brokerage_id: A, first_name: "Jane", last_name: "Doe", email: "Jane.Doe@Example.com", phone: "5550100100" }],
  }, { stampCreatedAt: true })
  G.__102A.svc = svc7
  G.__102A.events = []
  const sig = () => (svc7.tables.behavioral_signals as any[]).find((s) => s.id === SIG)
  const noConsent = await vec.captureConsentedVisitorEmail(svc7, { brokerageId: A, signalId: SIG, email: "jane.doe@example.com", consent: { consented: false, consentSource: "/home-value" }, actorUserId: null })
  check("POSITIVE CONTROL (the owner's rule): a capture WITHOUT consent stores NOTHING — no consent row, no email on the signal, no link, no evidence", !noConsent.stored && noConsent.reason === "no_consent" && (svc7.tables.contact_consent_events as any[]).length === 0 && sig().email_captured === null && sig().identified === false && (svc7.tables.person_identity_evidence as any[]).length === 0)
  check("PURE rule: only a literal `true` is consent — 'true', 1, 'yes', undefined all refuse; a bare field never consents", ["true", 1, "yes", undefined, null, "on"].every((v) => !vec.visitorEmailCaptureVerdict({ email: "a@b.co", consented: v }).ok) && vec.visitorEmailCaptureVerdict({ email: " A@B.co ", consented: true }).ok)
  const badEmail = await vec.captureConsentedVisitorEmail(svc7, { brokerageId: A, signalId: SIG, email: "not-an-email", consent: { consented: true, consentSource: "/home-value" }, actorUserId: null })
  check("consent with an invalid email stores nothing (no consent row is written for a value that cannot be stored)", !badEmail.stored && badEmail.reason === "invalid_email" && (svc7.tables.contact_consent_events as any[]).length === 0)
  const stored = await vec.captureConsentedVisitorEmail(svc7, { brokerageId: A, signalId: SIG, email: " Jane.Doe@Example.com ", consent: { consented: true, consentText: "I agree to be contacted.", consentSource: "/home-value", ipAddress: "203.0.113.9", userAgent: "ua" }, actorUserId: null })
  const consentRows = svc7.tables.contact_consent_events as any[]
  check("consented capture: the artifact is written through the ONE consent writer (tcpa, consented=true, the page as source, ip/ua, no contact/lead yet)", stored.stored && consentRows.length === 1 && consentRows[0].consented === true && consentRows[0].consent_type === "tcpa" && consentRows[0].consent_source === "/home-value" && consentRows[0].brokerage_id === A && consentRows[0].contact_id === null && consentRows[0].ip_address === "203.0.113.9")
  check("…the signal carries the normalised email, a capture time and consent_event_id = THAT artifact's id", sig().email_captured === "jane.doe@example.com" && typeof sig().email_captured_at === "string" && sig().consent_event_id === consentRows[0].id && stored.stored && stored.consentEventId === consentRows[0].id)
  check("…the identify loop fired: the tenant's contact matched case-insensitively, identified + contact_id stamped", stored.stored && stored.identity.identified && sig().identified === true && sig().contact_id === CON7)
  const ev7 = svc7.tables.person_identity_evidence as any[]
  check("…the 102E evidence writer recorded contact + behavioral_signal (email_exact, source visitor_identify) under tenant A with the SYSTEM actor (the public door has no human)", ev7.length === 2 && ev7.some((e) => e.entity_type === "contact" && e.entity_id === CON7 && e.match_method === "email_exact" && e.source === "visitor_identify" && e.actor_type === "system" && e.brokerage_id === A) && ev7.some((e) => e.entity_type === "behavioral_signal" && e.entity_id === SIG && e.detail?.identified_by === "email_captured"))
  check("…person.identity_linked emitted per link under tenant A (no chokepoint event exists at the pixel; the two links are two auditOnly events, as 102E's path already did)", (G.__102A.events as any[]).filter((e) => e.event === "person.identity_linked" && e.brokerageId === A).length === 2 && (G.__102A.events as any[]).every((e) => e.brokerageId === A))
  const tenantB = await vec.captureConsentedVisitorEmail(svc7, { brokerageId: A, signalId: SIGB, email: "jane.doe@example.com", consent: { consented: true, consentSource: "/x" }, actorUserId: null })
  check("tenant pin: a consented capture naming another tenant's signal stores nothing on it (the update matched no row — counted, not assumed)", !tenantB.stored && tenantB.reason === "store_refused" && (svc7.tables.behavioral_signals as any[]).find((s) => s.id === SIGB).email_captured === null)
  const oldShape = await vec.resolveSignalIdentity(svc7, { brokerageId: A, signalId: SIGOLD, actorUserId: UA })
  check("the reader repeats the rule: an email with NO consent artifact (a pre-m706 shape) is never matched", !oldShape.identified && oldShape.reason === "no_email" && (svc7.tables.behavioral_signals as any[]).find((s) => s.id === SIGOLD).identified === false)
  // the widget form hands over an artifact it already wrote — read back, never trusted
  const svc8 = memSupabase({
    behavioral_signals: seedSignals(),
    contact_consent_events: [{ id: EVB, brokerage_id: A, consented: true, consent_type: "tcpa" }, { id: EVNO, brokerage_id: A, consented: false, consent_type: "tcpa" }, { id: uuid(706), brokerage_id: B, consented: true, consent_type: "tcpa" }],
    contacts: [], person_identities: [], person_identity_evidence: [],
  }, { stampCreatedAt: true })
  G.__102A.svc = svc8
  const byId = await vec.captureConsentedVisitorEmail(svc8, { brokerageId: A, signalId: SIG, email: "new@example.com", consent: { consentEventId: EVB }, actorUserId: null })
  const sig8 = (svc8.tables.behavioral_signals as any[]).find((s) => s.id === SIG)
  check("an artifact handed over by id (the widget form) is read back in the tenant and the email is stored against it; no contact → identify reports no_contact_match, nothing invented", byId.stored && sig8.consent_event_id === EVB && sig8.email_captured === "new@example.com" && byId.identity.identified === false && byId.identity.reason === "no_contact_match" && (svc8.tables.contacts as any[]).length === 0)
  const optOutId = await vec.captureConsentedVisitorEmail(svc8, { brokerageId: A, signalId: SIGB, email: "new@example.com", consent: { consentEventId: EVNO }, actorUserId: null })
  const foreignId = await vec.captureConsentedVisitorEmail(svc8, { brokerageId: A, signalId: SIGB, email: "new@example.com", consent: { consentEventId: uuid(706) }, actorUserId: null })
  const madeUpId = await vec.captureConsentedVisitorEmail(svc8, { brokerageId: A, signalId: SIGB, email: "new@example.com", consent: { consentEventId: uuid(799) }, actorUserId: null })
  check("an opted-OUT artifact, another tenant's artifact or a made-up id each store nothing (consent_artifact_not_found)", [optOutId, foreignId, madeUpId].every((r) => !r.stored && r.reason === "consent_artifact_not_found") && (svc8.tables.behavioral_signals as any[]).find((s) => s.id === SIGB).email_captured === null)
  const svc9 = memSupabase({ behavioral_signals: seedSignals(), contact_consent_events: [], contacts: [] }, { refuse: { contact_consent_events: "permission denied for table contact_consent_events" } })
  G.__102A.svc = svc9
  const refusedLedger = await vec.captureConsentedVisitorEmail(svc9, { brokerageId: A, signalId: SIG, email: "jane@example.com", consent: { consented: true, consentSource: "/x" }, actorUserId: null })
  check("a REFUSED consent-ledger write is read (supabase-js resolves it) and the email is NOT stored: no artifact, no email", !refusedLedger.stored && refusedLedger.reason === "consent_not_recorded" && (svc9.tables.behavioral_signals as any[]).find((s) => s.id === SIG).email_captured === null)
  const svc10 = memSupabase({ behavioral_signals: seedSignals(), contact_consent_events: [], contacts: [] }, { missingColumns: { behavioral_signals: ["email_captured"] } })
  G.__102A.svc = svc10
  const preM706 = await vec.captureConsentedVisitorEmail(svc10, { brokerageId: A, signalId: SIG, email: "jane@example.com", consent: { consented: true, consentSource: "/x" }, actorUserId: null })
  check("before m706 is applied (42703 on the column) the door REPORTS store_refused — the consent artifact stays on the ledger, the email is not silently dropped as a success", !preM706.stored && preM706.reason === "store_refused" && /email_captured/.test(preM706.error ?? "") && (svc10.tables.contact_consent_events as any[]).length === 1)

  // ── 17. census: the door is wired at the real writer and the real routes; ONE writer of the column ─
  console.log("\n[17 — census (stripped source): trackBehavior is the one door; both public routes reach it; the lib module is the only writer of email_captured]")
  const li = src("app/actions/lead-intelligence.ts")
  check("trackBehavior takes email_capture and hands it to captureConsentedVisitorEmail AFTER the tenant-stamped signal exists, consent by flag or by artifact id, page as the consent source", /email_capture\?: \{/.test(li) && /captureConsentedVisitorEmail\(supabase, \{\s*brokerageId,\s*signalId,/.test(li) && /\{ consentEventId: ec\.consent_event_id \}/.test(li) && /\{ consented: ec\.consented === true, consentText: ec\.consent_text \?\? null, consentSource: sessionData\.page_visited/.test(li))
  const trackRoute = src("app/api/track/visitor/route.ts")
  check("POST /api/track/visitor passes email + tcpa_consent from the body as `consented: tcpa_consent === true` (a literal true, never a truthy string) and answers stored/not without the matched contact", /consented: tcpa_consent === true/.test(trackRoute) && /email_captured: ec\.stored/.test(trackRoute) && !/contact/.test(trackRoute.slice(trackRoute.indexOf("const ec ="))))
  const captureRoute = src("app/api/widget/capture-lead/route.ts")
  check("POST /api/widget/capture-lead hands the EMAIL artifact persistContactConsent just wrote (emailConsentWrite.consentEventId) + the visitor id to the SAME door (trackBehavior email_capture.consent_event_id)", /const consentWrite = await persistContactConsent\(/.test(captureRoute) && /email_capture: \{ email, consent_event_id: emailConsentWrite\.consentEventId \}/.test(captureRoute) && /emailConsentWrite\?\.consentEventId && email && typeof visitor_id === 'string'/.test(captureRoute))
  // WAVE 104 (lane 104E; owner answer 1): the SEPARATE email-consent box.
  check("capture-lead FAILS CLOSED: an email without email_consent === true is refused (422) before any write; the phone/TCPA rule is unchanged", /const emailConsentGiven = email_consent === true/.test(captureRoute) && /if \(email && !emailConsentGiven\) \{\s*return NextResponse\.json\(\{ error: 'email_consent required when an email is provided' \}, \{ status: 422 \}\)/.test(captureRoute) && /const consentGiven = tcpa_consent !== false/.test(captureRoute))
  check("the email box writes its OWN artifact through the one consent writer (channel 'email') and the TCPA artifact no longer stands in for it", /channel: 'email',/.test(captureRoute) && (captureRoute.match(/await persistContactConsent\(/g) ?? []).length === 2 && !/consent_event_id: consentWrite\.consentEventId/.test(captureRoute))
  const consentWriter = src("lib/kernel/compliance/require-contact-consent.ts")
  check("persistContactConsent channel 'email' records consent_type 'email' and leaves the leads/contacts tcpa_* columns alone (phone consent the visitor never gave)", /CONSENT_TYPE_FOR_CHANNEL = \{ phone: 'tcpa', email: 'email' \}/.test(consentWriter) && /params\.leadId && channel === 'phone'/.test(consentWriter) && /params\.contactId && channel === 'phone'/.test(consentWriter) && /consent_type:\s*CONSENT_TYPE_FOR_CHANNEL\[channel\]/.test(consentWriter))
  const widgetClient = src("app/widget/[brokerageSlug]/widget-chat-client.tsx")
  check("the widget client has the separate email-consent checkbox, gates submit on it, and sends email_consent ONLY from the ticked box (phone rule unchanged)", /type="checkbox"/.test(widgetClient) && /emailConsent: e\.target\.checked/.test(widgetClient) && /if \(!captureForm\.emailConsent\) \{/.test(widgetClient) && /email_consent: captureForm\.emailConsent === true/.test(widgetClient) && /tcpa_consent: !!captureForm\.phone\.trim\(\)/.test(widgetClient))
  check("POSITIVE CONTROL: a client that defaulted the flag would be flagged", !/email_consent: true/.test(widgetClient) && /email_consent: true/.test("body: { email_consent: true }"))
  check("the widget client sends its vip_visitor_id cookie with the capture form (read, never minted there)", /visitor_id: \(\(\) => \{ try \{ return window\.localStorage\.getItem\('vip_visitor_id'\) \}/.test(src("app/widget/[brokerageSlug]/widget-chat-client.tsx")))
  const consentSrc = src("lib/kernel/compliance/require-contact-consent.ts")
  check("persistContactConsent returns consentEventId from a `.select('id')` on the ledger insert (null when refused — never a made-up id)", /\.from\('contact_consent_events'\)\.insert\(\{[\s\S]{0,600}\}\)\.select\('id'\)\.maybeSingle\(\)/.test(consentSrc) && /consentEventId = \(consentEvent as \{ id\?: string \} \| null\)\?\.id \?\? null/.test(consentSrc))
  const emailWriterRe = /\.from\(["']behavioral_signals["']\)[\s\S]{0,300}?\.(insert|update|upsert)\(\s*\{[^)]{0,400}?\bemail_captured\s*:/
  const emailWriters = [...walk("lib"), ...walk("app")].filter((f) => emailWriterRe.test(src(f)))
  check(`lib/lead-intelligence/visitor-email-capture.ts is the ONLY writer of behavioral_signals.email_captured (${emailWriters.join(", ") || "none"})`, emailWriters.length === 1 && emailWriters[0] === "lib/lead-intelligence/visitor-email-capture.ts")
  check("POSITIVE CONTROL: the writer finder recognises a fixture insert naming email_captured, and ignores a select", emailWriterRe.test(`await svc.from("behavioral_signals").insert({ visitor_id: v, email_captured: e })`) && !emailWriterRe.test(`await svc.from("behavioral_signals").select("id, email_captured")`))
  const vecSrc = src("lib/lead-intelligence/visitor-email-capture.ts")
  check("in the one writer the consent artifact is resolved BEFORE the update that names email_captured (no store without an id)", vecSrc.indexOf("if (!consentEventId) return { stored: false, reason: \"consent_not_recorded\"") < vecSrc.indexOf(".update({ email_captured: verdict.email") && vecSrc.indexOf("return { stored: false, reason: \"consent_artifact_not_found\" }") < vecSrc.indexOf(".update({ email_captured: verdict.email"))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(1) })
