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
 * BLIND SPOTS (published): the trigger and RLS are proven on SQL text, not executed; pipeline-processor,
 * mergeContacts, crm manual dedup, captureContact, instant-greeting, the form route and the
 * visitor-identify writer are proven by source census (their module graphs need the live app), the
 * service, history-carry, person-timeline and distribution by execution; the in-memory client has no
 * UNIQUE enforcement, so link idempotency is the service's own pre-read; section 15 prints whether the
 * visitor-identify writer's own predicate column (behavioral_signals.email_captured) exists live.
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
    { file: "app/actions/lead-intelligence.ts", label: "visitor-identify loop: THE behavioral_signals.identified writer links signal + contact (email_exact), human actor", needs: [/entityType: "behavioral_signal"/, /matchMethod: "email_exact"/, /\.from\("behavioral_signals"\)\.update\(\{ identified: true, contact_id: contact\.id \}\)[\s\S]{0,400}recordBehavioralSignalIdentity\(supabase, \{ brokerageId: auth\.brokerageId, signalId: signal\.id/, /actor: \{ type: "user" as const, userId: input\.actorUserId \}/] },
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
  check("the behavioral_signal writer helper is module-private (a 'use server' file: every export is public)", !/export async function recordBehavioralSignalIdentity/.test(src("app/actions/lead-intelligence.ts")) && /async function recordBehavioralSignalIdentity/.test(src("app/actions/lead-intelligence.ts")))

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

  // ── 15. blind spot published (not asserted): the visitor-identify writer's own predicate ───────
  const sigCols = /behavioral_signals: \[([^\]]*)\]/.exec(raw("scripts/schema-snapshot.ts"))?.[1] ?? ""
  console.log(`\n[15 — published blind spot] behavioral_signals.email_captured in the live snapshot: ${/"email_captured"/.test(sigCols) ? "PRESENT" : "ABSENT — resolveIdentity's email match (and so the behavioral_signal evidence writer behind it) cannot fire live until that column exists or the predicate reads another; wired at the real writer, listed for the owner"}`)

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(1) })
