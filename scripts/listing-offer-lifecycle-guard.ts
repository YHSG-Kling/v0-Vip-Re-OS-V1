#!/usr/bin/env tsx
/**
 * scripts/listing-offer-lifecycle-guard.ts   (npm run test:listing-offer-lifecycle)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 142, lane 142B — LISTINGS, OFFERS, E-SIGN MONITORING, COMPLIANCE & THE AI-GUIDED FORMWIZARD.
 * Owner (verbatim, 2026-10-18): "it is listings and offers and then the offer turns into a transaction after
 * the offer passes compliance for an executed contract" · "States: draft · sent · partially_signed · all_signed ·
 * compliance_pending · correction_required · compliance_approved · fully_executed · declined/voided/expired.
 * Provider completion ≠ compliance approval." · "formwizard steps should be correct" (Purpose → Property →
 * Parties → Terms → Recommended Forms → Complete → Review → E-sign/Deliver; CDA is NOT a step) · "call it the
 * legal-forms provider".
 *
 * Proves, as RULES (never waypoints):
 *   A. ONE VOCABULARY — the owner's eleven states map onto the survivor's spelling (lib/esign/packet-states.ts);
 *      the m783 CHECK equals the code tuple on BOTH tables; the live cache is a subset; the ladder's rank rule
 *      (only up; equal = idempotent; corrections re-enter; a terminal outcome is never overwritten).
 *   B. THE WRITER, LIVE on the in-memory client (real advanceEsignPacketState + real notify-helpers dedupe):
 *      tenant-pinned reads and counted writes, evidence per hop, the hop bell to the agent (agents → users
 *      resolved) and to the compliance bench on compliance hops, a redelivery refused, a replay deduped.
 *   C. THE CHAIN IS WIRED — the two all-signed survivors ask the ladder (never one literal); the three provider
 *      webhooks record declined/voided/expired; both compliance loops record compliance_pending →
 *      correction_required | compliance_approved → fully_executed; the listing send writes the agreement row
 *      the webhooks match; the ONE transaction gate (compliance_passed_at) is never bypassed.
 *   D. AN OUTSIDE-PROPERTY OFFER NEEDS NO LISTING ID; offers.form_source is spelled in its CHECK.
 *   E. THE FORMWIZARD renders the owner's sequence from the spine; the coach never invents; the recommendation
 *      returns only forms that exist; the terms become the offer's real terms; drafts autosave/resume;
 *      the tenant-facing name is the legal-forms provider.
 *   F. REGISTRATION.
 * Every absence carries a POSITIVE CONTROL (CLAUDE.md §2); code-token scans read STRIPPED source.
 *
 * MAINTENANCE: domain `listing_offer_lifecycle` (lib/kernel/manager-registry.ts) — deal_coordinator; coOwners
 * compliance_officer (the compliance hops, the one gate) and data_steward (the vocabulary + migration).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  ESIGN_PACKET_STATES, OWNER_PACKET_STATES, OWNER_STATE_ALIASES, fromOwnerState, esignPacketRank,
  isAtOrPastAllSigned, canAdvancePacketState, providerTerminalState, ESIGN_TERMINAL_FAILURE_STATES,
  ESIGN_COMPLIANCE_STATES, PACKET_HOP_NOTICE, DEAL_LIFECYCLE_STAGES, type EsignPacketState,
} from "../lib/esign/packet-states"
import {
  FORM_WIZARD_SEQUENCE, FORM_WIZARD_OPENING_QUESTION, FORM_WIZARD_STEP_LABELS, stepNumber, stepKeyAt,
  LISTING_INTAKE, OFFER_INTAKE, intakeQuestionsFor, missingRequiredIntake, offerTermsToCreateOfferFields,
  offerFormSourceFor, recommendForms, AI_COACH_RULES,
} from "../lib/forms/form-wizard-sequence"
import { getStateForms } from "../lib/state-forms/registry"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))
const bare = (p: string) => blankStrings(stripComments(read(p)))
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const rel = join(dir, e)
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
  }
  return out
}

// ── THE WORLD the writer sees: server-only stubbed; the lifecycle core's dispatch half (it pulls the
//    orchestrator) replaced by a recorder; the service client never built (the proof hands its own client in).
const G = globalThis as any
G.__142B = { events: [] as any[] }
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('the proof hands its own client in') }",
  "@/lib/events/lifecycle-event-core": "export const recordLifecycleEvent = async (svc, brokerageId, input, opts) => { const seen = globalThis.__142B.events.find((e) => e.brokerageId === brokerageId && e.input.dedupe_key === input.dedupe_key); if (seen) return { ok: true, eventId: 'dup', deduped: true }; globalThis.__142B.events.push({ brokerageId, input, opts }); return { ok: true, event: { id: 'evt-' + globalThis.__142B.events.length }, deduped: false, dispatched: false } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const BRK2 = "22222222-2222-4222-8222-222222222222"
const U_AGENT = "a0000000-0000-4000-8000-000000000001"
const U_TC = "a0000000-0000-4000-8000-000000000002"
const U_TC2 = "a0000000-0000-4000-8000-000000000003"
const AG = "b0000000-0000-4000-8000-000000000001"
const OFFER = "c0000000-0000-4000-8000-000000000001"
const OFFER2 = "c0000000-0000-4000-8000-000000000002"
const LA = "d0000000-0000-4000-8000-000000000001"
const LA_OLD = "d0000000-0000-4000-8000-000000000002"
const L1 = "e0000000-0000-4000-8000-000000000001"

async function main() {
  // ── A · ONE VOCABULARY ────────────────────────────────────────────────────────────────────────
  console.log("\n[A · one vocabulary: the owner's words, the survivor's spelling, the m783 CHECK, the ladder rule]")
  check("the owner's eleven states are all present, in the owner's order", OWNER_PACKET_STATES.join() === "draft,sent,partially_signed,all_signed,compliance_pending,correction_required,compliance_approved,fully_executed,declined,voided,expired")
  check("every owner word maps to a column state; the two renamed ones are the survivor's spellings (draft→pending, all_signed→fully_signed)",
    OWNER_PACKET_STATES.every((w) => (ESIGN_PACKET_STATES as readonly string[]).includes(OWNER_STATE_ALIASES[w])) && fromOwnerState("draft") === "pending" && fromOwnerState("all_signed") === "fully_signed" && fromOwnerState("nope") === null)
  check("§6: no second spelling — `draft` and `all_signed` are NOT column values; the column tuple has exactly eleven", !(ESIGN_PACKET_STATES as readonly string[]).includes("draft") && !(ESIGN_PACKET_STATES as readonly string[]).includes("all_signed") && ESIGN_PACKET_STATES.length === 11)
  const live = (t: "offers" | "listing_agreements") => (CHECK_VOCABULARIES[t]?.esign_status ?? []) as readonly string[]
  check(`the live cache (offers ${live("offers").length}, listing_agreements ${live("listing_agreements").length}) is a SUBSET of the tuple (same set once m783 applies and the cache regenerates)`,
    live("offers").length > 0 && live("offers").every((v) => (ESIGN_PACKET_STATES as readonly string[]).includes(v)) && live("listing_agreements").every((v) => (ESIGN_PACKET_STATES as readonly string[]).includes(v)))
  const m783 = existsSync(join(ROOT, "supabase/migrations/m783-esign-packet-lifecycle-one-vocabulary.sql")) ? read("supabase/migrations/m783-esign-packet-lifecycle-one-vocabulary.sql") : ""
  check("m783 exists and is honestly stamped (the lane stamp, or APPLIED LIVE once the integrator applies it)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(m783))
  const checkSet = (t: string) => ((m783.match(new RegExp(`${t}_esign_status_check\\s*\\n?\\s*CHECK \\(esign_status IS NULL OR esign_status IN \\(([^)]+)\\)`)) ?? [])[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean).sort().join()
  check("m783's CHECK equals the code tuple on BOTH tables (offers + listing_agreements)", checkSet("offers") === [...ESIGN_PACKET_STATES].sort().join() && checkSet("listing_agreements") === [...ESIGN_PACKET_STATES].sort().join())
  check("the code survivor lib/transactions/coordination-status.ts DERIVES its ladder from the tuple (no restated list)", /LISTING_AGREEMENT_ESIGN_STATUSES = ESIGN_PACKET_STATES/.test(code("lib/transactions/coordination-status.ts")))
  check("rank: pending < sent < partially_signed < fully_signed < compliance_pending = correction_required < compliance_approved < fully_executed < terminal",
    esignPacketRank("pending") < esignPacketRank("sent") && esignPacketRank("sent") < esignPacketRank("partially_signed") && esignPacketRank("partially_signed") < esignPacketRank("fully_signed")
    && esignPacketRank("fully_signed") < esignPacketRank("compliance_pending") && esignPacketRank("compliance_pending") === esignPacketRank("correction_required")
    && esignPacketRank("correction_required") < esignPacketRank("compliance_approved") && esignPacketRank("compliance_approved") < esignPacketRank("fully_executed")
    && ESIGN_TERMINAL_FAILURE_STATES.every((t) => esignPacketRank(t) > esignPacketRank("fully_executed")) && esignPacketRank("legacy") === -1)
  check("provider completion ≠ compliance approval: fully_signed is at-or-past all-signed, so is every compliance state; sent / declined are not",
    isAtOrPastAllSigned("fully_signed") && ESIGN_COMPLIANCE_STATES.every(isAtOrPastAllSigned) && !isAtOrPastAllSigned("sent") && !isAtOrPastAllSigned("declined") && !isAtOrPastAllSigned(null))
  const adv = (f: string | null, t: EsignPacketState) => canAdvancePacketState(f, t)
  check("the ladder rule: up is allowed, equal is an idempotent no-op, backwards is refused by name",
    adv("sent", "fully_signed").ok && (adv("fully_signed", "fully_signed") as any).noop === true && !adv("compliance_pending", "fully_signed").ok && /backwards/.test((adv("compliance_pending", "fully_signed") as any).reason))
  check("corrections RE-ENTER review (correction_required → compliance_pending) and review may correct again",
    adv("correction_required", "compliance_pending").ok && adv("compliance_pending", "correction_required").ok && !(adv("correction_required", "compliance_pending") as any).noop)
  check("a terminal provider outcome is never overwritten, and a fully executed packet is never declined/voided/expired",
    !adv("declined", "sent").ok && !adv("voided", "fully_signed").ok && !adv("fully_executed", "declined").ok && adv("sent", "declined").ok && adv("fully_signed", "expired").ok)
  check("fully_executed is unreachable from a packet the provider never reported all-signed; a legacy/unknown value may be advanced from",
    !adv("sent", "fully_executed").ok && adv("fully_signed", "fully_executed").ok && adv("weird_legacy", "sent").ok && !adv("sent", "nonsense" as any).ok)
  check("providerTerminalState: DocuSign envelope-declined / voided, Authentisign signing.expired → the state; a completion is null",
    providerTerminalState("envelope-declined", null) === "declined" && providerTerminalState(null, "Voided") === "voided" && providerTerminalState("signing.expired", null) === "expired" && providerTerminalState("envelope-completed", "completed") === null && providerTerminalState(null, null) === null)
  check("every state has a hop notice with a title and a body, none states an amount or a date (no digits)", ESIGN_PACKET_STATES.every((s) => PACKET_HOP_NOTICE[s].title.length > 4 && PACKET_HOP_NOTICE[s].body.length > 10 && !/\d/.test(PACKET_HOP_NOTICE[s].title + PACKET_HOP_NOTICE[s].body)))
  check("the deal lifecycle vocabulary is the owner's seven stages in order", DEAL_LIFECYCLE_STAGES.join() === "listing,offer,signatures,compliance,fully_executed_contract,transaction,closing")

  // ── B · THE WRITER, LIVE ──────────────────────────────────────────────────────────────────────
  console.log("\n[B · the writer on the in-memory client: tenant-pinned, counted, evidenced, belled, deduped, never regressed]")
  const { advanceEsignPacketState, recordEsignPacketHop } = await import("../lib/esign/packet-state-writer")
  const db = memSupabase({
    users: [{ id: U_AGENT, brokerage_id: BRK, user_type: "agent" }, { id: U_TC, brokerage_id: BRK, user_type: "tc" }, { id: U_TC2, brokerage_id: BRK2, user_type: "tc" }],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: BRK }],
    offers: [{ id: OFFER, brokerage_id: BRK, agent_id: AG, contact_id: "contact-1", esign_status: "pending", provider_envelope_id: "env-1" }, { id: OFFER2, brokerage_id: BRK2, agent_id: null, contact_id: null, esign_status: "sent", provider_envelope_id: "env-9" }],
    listing_agreements: [
      { id: LA_OLD, brokerage_id: BRK, listing_id: L1, agent_user_id: U_AGENT, seller_contact_id: "contact-2", esign_status: "voided", provider_ref: "env-old", created_at: "2026-01-01T00:00:00Z" },
      { id: LA, brokerage_id: BRK, listing_id: L1, agent_user_id: U_AGENT, seller_contact_id: "contact-2", esign_status: "sent", provider_ref: "env-2", created_at: "2026-02-01T00:00:00Z" },
    ],
    notifications: [],
  })
  const offerRow = () => db.tables.offers.find((o) => o.id === OFFER)!
  const bells = (entityId: string, state: string) => db.tables.notifications.filter((n) => n.entity_id === entityId && n.type === `esign.packet.${state}`)

  const r1 = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "sent", source: "ui", actorUserId: U_AGENT, provider: "docusign", envelopeId: "env-1" })
  check("pending → sent: written, evidenced (dedupe key names table + id + state), one bell to the AGENT (agents.id → users.id resolved), none to the TC",
    r1.ok && !(r1 as any).noop && offerRow().esign_status === "sent" && G.__142B.events.some((e: any) => e.input.dedupe_key === `esign-packet-offers-${OFFER}-sent` && e.input.source === "ui")
    && bells(OFFER, "sent").length === 1 && bells(OFFER, "sent")[0].user_id === U_AGENT, JSON.stringify(r1))
  const r2 = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "fully_signed", source: "webhook", provider: "docusign", envelopeId: "env-1", also: { esign_completed_at: "2026-10-18T00:00:00Z" } })
  check("sent → fully_signed with a companion column: both written in ONE update; the all-signed bell reaches the agent AND this brokerage's TC — never another tenant's",
    r2.ok && offerRow().esign_status === "fully_signed" && offerRow().esign_completed_at === "2026-10-18T00:00:00Z"
    && bells(OFFER, "fully_signed").map((n) => n.user_id).sort().join() === [U_AGENT, U_TC].sort().join(), JSON.stringify(r2))
  const r3 = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "compliance_pending", source: "system" })
  const redelivered = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "fully_signed", source: "webhook" })
  check("fully_signed → compliance_pending; a REDELIVERED all-signed is refused (never regressed) and the row keeps compliance_pending",
    r3.ok && offerRow().esign_status === "compliance_pending" && !redelivered.ok && /backwards/.test((redelivered as any).reason) && offerRow().esign_status === "compliance_pending")
  const bellsBefore = db.tables.notifications.length, evtsBefore = G.__142B.events.length
  const same = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "compliance_pending", source: "system" })
  check("the same hop again is an idempotent no-op: no write, no evidence, no bell", same.ok && (same as any).noop === true && db.tables.notifications.length === bellsBefore && G.__142B.events.length === evtsBefore)
  const r4 = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "correction_required", source: "system", notify: false })
  const r5 = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "compliance_pending", source: "system" })
  check("correction_required (recorded, no second bell — the flag fan-out already rang) → compliance_pending re-entry → …",
    r4.ok && bells(OFFER, "correction_required").length === 0 && G.__142B.events.some((e: any) => e.input.dedupe_key === `esign-packet-offers-${OFFER}-correction_required`) && r5.ok && offerRow().esign_status === "compliance_pending")
  const r6 = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "compliance_approved", source: "system", notify: false })
  const r7 = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "fully_executed", source: "system", detail: "Transaction t-1 was created." })
  check("… → compliance_approved (evidence only) → fully_executed (one bell, carrying the detail, to agent + TC); then the provider can no longer decline it",
    r6.ok && r7.ok && offerRow().esign_status === "fully_executed" && bells(OFFER, "fully_executed").length === 2 && /Transaction t-1/.test(bells(OFFER, "fully_executed")[0].body)
    && !(await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "declined", source: "webhook" })).ok)
  const replay = await recordEsignPacketHop(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, state: "fully_executed", source: "system" })
  check("recordEsignPacketHop (a survivor's own stamp) replayed for the same hop: deduped — no new bell", replay.ok && (replay as any).notified === 0 && bells(OFFER, "fully_executed").length === 2)
  const mismatch = await recordEsignPacketHop(db, { brokerageId: BRK, record: { table: "offers", id: OFFER }, state: "sent", source: "system" })
  check("recordEsignPacketHop for a state the row does NOT hold is refused by name (never papered over)", !mismatch.ok && /holds esign_status/.test((mismatch as any).reason))
  const foreign = await advanceEsignPacketState(db, { brokerageId: BRK2, record: { table: "offers", id: OFFER }, to: "sent", source: "ui" })
  check("wrong tenant: the read is pinned to brokerage_id — 'no such offer in this brokerage', nothing written", !foreign.ok && /no such offer/.test((foreign as any).reason) && offerRow().esign_status === "fully_executed")
  const refusedDb = memSupabase({ offers: [{ id: OFFER, brokerage_id: BRK, esign_status: "sent" }] }, { refuse: { offers: "permission denied for table offers" } })
  const refused = await advanceEsignPacketState(refusedDb, { brokerageId: BRK, record: { table: "offers", id: OFFER }, to: "fully_signed", source: "webhook" })
  check("a REFUSED read is a refusal, never 'no such record' (§3)", !refused.ok && /refused/.test((refused as any).reason) && /permission denied/.test((refused as any).reason))
  const la = await advanceEsignPacketState(db, { brokerageId: BRK, record: { table: "listing_agreements", listingId: L1 }, to: "fully_signed", source: "webhook", provider: "docusign", envelopeId: "env-2" })
  check("a listing agreement addressed by listingId resolves the NEWEST row (not the voided older one); its agent is agent_user_id directly; the bell deep-links the LISTING",
    la.ok && (la as any).recordId === LA && db.tables.listing_agreements.find((a) => a.id === LA)!.esign_status === "fully_signed" && db.tables.listing_agreements.find((a) => a.id === LA_OLD)!.esign_status === "voided"
    && bells(L1, "fully_signed").some((n) => n.user_id === U_AGENT && n.entity_type === "listing"), JSON.stringify(la))
  check("every notification written carries the tenant, an in_app channel and a CHECK-admitted priority", db.tables.notifications.every((n) => n.brokerage_id === BRK && n.channel === "in_app" && (CHECK_VOCABULARIES.notifications.priority as readonly string[]).includes(n.priority)))

  // ── C · THE CHAIN IS WIRED ────────────────────────────────────────────────────────────────────
  console.log("\n[C · the chain: ladder guards, terminal webhooks, compliance hops, the agreement row, the one gate]")
  const loop = code("lib/forms/esign-execution-loop.ts"), fin = code("lib/esign-webhooks/finalize-packet.ts")
  // THE DANGEROUS SHAPE is the negative WRITE guard — `esign_status !== "fully_signed"` gates a stamp, so a packet in
  // compliance_pending would be re-stamped fully_signed by a redelivery. A positive `=== "fully_signed") return`
  // early-return beside the ladder return is harmless (a subset of it) and other proofs pin that survivor line.
  const rawLiteralGuard = (s: string) => /esign_status\s*!==\s*"fully_signed"/.test(s)
  check("POSITIVE CONTROL: the raw-literal finder recognises the retired write guard", rawLiteralGuard(`if (matchedOffer && (matchedOffer as any).esign_status !== "fully_signed") {`))
  check("esign-execution-loop asks the LADDER for 'already past all-signed' (no raw fully_signed write guard) and records the all-signed hop for offer + agreement",
    /!isAtOrPastAllSigned\(\(matchedOffer as any\)\.esign_status\)/.test(loop) && !rawLiteralGuard(loop) && (loop.match(/recordEsignPacketHop\(supabase, \{/g) ?? []).length === 2)
  check("finalize-packet asks the ladder on its idempotency return (beside the survivor's literal) AND on both legacy stamps (offer + agreement) — a redelivery regresses nothing",
    /esign_status === "fully_signed"\) return[\s\S]{0,200}isAtOrPastAllSigned\(matchedOffer\.esign_status\)\) return/.test(fin) && /!matchedOffer\.transaction_id && !isAtOrPastAllSigned\(matchedOffer\.esign_status\)/.test(fin) && /!isAtOrPastAllSigned\(matchedAgreement\.esign_status\)/.test(fin) && !rawLiteralGuard(fin))
  check("recordEnvelopeTerminalState exists on the execution-loop survivor: resolves the tenant, then the ONE writer on every matched offer and agreement",
    /export async function recordEnvelopeTerminalState/.test(loop) && /resolveEnvelopeBrokerageId\(supabase, input\.envelopeId\)/.test(loop) && /record: \{ table: "offers", id: o\.id \}, to: input\.state/.test(loop) && /record: \{ table: "listing_agreements", id: a\.id \}, to: input\.state/.test(loop))
  for (const p of ["docusign", "skyslope", "authentisign"]) {
    const r = code(`app/api/webhooks/${p}/route.ts`)
    const iTerm = r.indexOf(`recordEnvelopeTerminalState(supabase as any, { provider: "${p}"`), iIgnore = r.indexOf('action: "ignored"')
    check(`${p} webhook: a declined/voided/expired envelope is recorded (providerTerminalState → recordEnvelopeTerminalState) BEFORE the 'ignored' return`, /providerTerminalState\(event, (envelopeStatus|status)\)/.test(r) && iTerm > 0 && iIgnore > iTerm)
  }
  check("BLIND SPOT, published: the Dotloop route handles document.signed / loop.status.updated only (Dotloop publishes no declined/voided envelope event in this handler)", !/recordEnvelopeTerminalState/.test(code("app/api/webhooks/dotloop/route.ts")))
  const ocl = code("lib/transactions/offer-compliance-loop.ts"), lcl = code("lib/listings/listing-compliance-loop.ts")
  check("offer loop: compliance_pending BEFORE the driver runs; blocked → correction_required (no second bell); created → compliance_approved (evidence) then fully_executed (the bell)",
    ocl.indexOf('await stamp("compliance_pending")') > 0 && ocl.indexOf('await stamp("compliance_pending")') < ocl.indexOf("autoExecuteFullySignedOffer(offerId")
    && /await stamp\("correction_required", \{ notify: false \}\)/.test(ocl) && /if \(created\) \{[\s\S]{0,600}await stamp\("compliance_approved", \{ notify: false \}\)[\s\S]{0,200}await stamp\("fully_executed"/.test(ocl) && /record: \{ table: "offers", id: offerId \}/.test(ocl))
  // WAVE 143 (lane 143A) — THE RULE, re-asserted, not the waypoint (CLAUDE.md §2). This assertion used to count
  // `await stamp("fully_executed"` == 2 (one per pass arm) — a shape of the code, true only while approval and execution
  // were stamped back-to-back at the END of two arms. The rule: compliance_approved is recorded BEFORE any stage hop (the
  // status map's coming_soon reads the mark it writes), `fully_executed` is spelled ONCE (behind markExecuted) and every
  // exit of the pass arm — awaiting-date, each refused hop, the advance — goes through it, so no pass can end approved-but-not-executed.
  check("listing loop: compliance_pending inside the window before the gate; blocked → correction_required; the pass arm records compliance_approved BEFORE the first stage hop, then ends every exit in the single fully_executed spelling, on the NEWEST agreement",
    lcl.indexOf('if (inWindow) await stamp("compliance_pending")') > 0 && lcl.indexOf('if (inWindow) await stamp("compliance_pending")') < lcl.indexOf("assertListingActivationAllowed(supabase")
    && /if \(inWindow\) await stamp\("correction_required", \{ notify: false \}\)/.test(lcl)
    && lcl.indexOf('await stamp("compliance_approved"') > 0 && lcl.indexOf('await stamp("compliance_approved"') < lcl.indexOf("await transitionLifecycle(")
    && (lcl.match(/stamp\("fully_executed"/g) ?? []).length === 1 && /const markExecuted = /.test(lcl) && (lcl.match(/await markExecuted\(/g) ?? []).length >= 2
    && /record: \{ table: "listing_agreements", listingId \}/.test(lcl))
  const lk = code("app/actions/listings-kernel.ts")
  check("the listing send writes the listing_agreements row the webhooks match (provider_ref = envelope, agreement_type listing, upload_mode provider_pull, the ladder state) or re-points the open one — after the dispatch, as a warning on refusal",
    /\.is\("fully_executed_at", null\)/.test(lk) && /provider_ref:\s*dispatch\.envelopeId \?\? null, esign_status: agreementStatus, upload_mode: "provider_pull"/.test(lk)
    && /agreement_type:\s*"listing"/.test(lk) && /upload_mode:\s*"provider_pull"/.test(lk) && /esign_status:\s*agreementStatus/.test(lk) && lk.indexOf("dispatchEsignPacket(svc as any") < lk.indexOf('from("listing_agreements")') && /warnings\.push\(`the listing agreement row was not created/.test(lk))
  check("the execution loop still resolves a listing agreement by provider_ref and by listing_id (the row the send now writes)", /\["listing_agreements", "provider_ref"\]/.test(loop) && /\.eq\("listing_id", ctx\.listingId\)/.test(loop))
  // EVERY HOP (owner: "sent, participant signed, all signed, failed/declined/expired, compliance begins, corrections, approved, fully executed").
  const sfs = code("app/actions/buyer-offer/submit-for-signature.ts")
  check("the SENT/STAGED hop: both sends record the state they stamp through recordEsignPacketHop AFTER the record write (offer: submit-for-signature; agreement: the listing send), typed on the ladder",
    /const stampedState: EsignPacketState = dispatch\.status === "sent" \? "sent" : "pending"/.test(sfs) && sfs.indexOf("state: stampedState, source: \"ui\"") > sfs.indexOf(".update(dispatchPayload)")
    && /record: \{ table: "listing_agreements", listingId: listing\.id as string \},\s*\n?\s*state: agreementStatus, source: "ui"/.test(lk) && lk.indexOf("state: agreementStatus, source: \"ui\"") > lk.indexOf('from("listing_agreements")'))
  check("the PARTY-SIGNED hop: the buyer-first stamp in finalize-packet records partially_signed as EVIDENCE (notify: false) because notifyEsignSigned is that path's bell; that legacy bell no longer rings on a fully executed counter (the all-signed hop does) — one bell per moment",
    /state: "partially_signed", source: "webhook", provider, envelopeId, notify: false/.test(fin) && /if \(agentRow\?\.user_id && !isCounterFullyExecuted\) \{\s*\n?\s*await notifyEsignSigned\(/.test(fin) && (fin.match(/recordEsignPacketHop\(supabase, \{/g) ?? []).length === 2)
  // THE ONE GATE — a transaction exists only after compliance approval.
  const files = [...walk("app"), ...walk("lib")]
  const bypassFinder = (s: string) => /skipOfferGate:\s*true/.test(s)
  check("POSITIVE CONTROL: the bypass finder recognises the shape", bypassFinder(`createTransactionFromOffer({ offerId, skipOfferGate: true })`))
  const bypasses = files.filter((f) => bypassFinder(bare(f)))
  check(`no caller bypasses the offer gate (skipOfferGate: true) anywhere in app/ or lib/ (${files.length} files, stripped + blanked)`, bypasses.length === 0, bypasses.join(", "))
  check("the bridge gate refuses without compliance_passed_at; the creation gate reads it too; neither a provider webhook route nor finalize-packet creates a transaction directly",
    /!o\.compliance_passed_at/.test(code("lib/transactions/offer-bridge.ts")) && /compliance_passed_at/.test(code("lib/transactions/transaction-creation-gate.ts"))
    && ["docusign", "dotloop", "skyslope", "authentisign"].every((p) => !/createTransactionFromOffer|convertOfferToTransaction|createManualTransaction/.test(bare(`app/api/webhooks/${p}/route.ts`))) && !/createTransactionFromOffer\(/.test(bare("lib/esign-webhooks/finalize-packet.ts")))
  check("submit-to-compliance is the ONE gate the autonomous path reaches (auto-execute → submitOfferToCompliance), and it stamps compliance_passed_at itself before the bridge",
    /submitOfferToCompliance\(\{ offerId, userId: agentUserId, internalSecret/.test(code("lib/transactions/auto-execute-offer.ts")) && code("app/actions/buyer-offer/submit-to-compliance.ts").indexOf("compliance_passed_at:    now") < code("app/actions/buyer-offer/submit-to-compliance.ts").indexOf("createTransactionFromOffer({"))
  const nh = code("lib/notifications/notify-helpers.ts")
  check("notifyEsignPacketHop dedupes on (tenant, entity, type) BEFORE inserting and pages the compliance bench through the SAME role roster the flag fan-out uses",
    nh.indexOf('.eq("type", type)') > 0 && nh.indexOf('.eq("type", type)') < nh.indexOf('from("notifications").insert(rows).select("id")') && /rawRoleVariantsFor\(\["tc", "compliance_officer"\]\)/.test(nh.slice(nh.indexOf("export async function notifyEsignPacketHop"))))
  check("the reconciliation backup exists: the esign-doc-sync sweep calls the same execution loop the webhooks do (cron is the fallback, never the primary)", /evaluateEnvelopeExecution/.test(code("lib/transactions/esign-doc-sync-sweep.ts")) && /esign-doc-sync/.test(code("lib/kernel/cron-dispatch.ts")))
  check("all four provider webhooks verify the provider's signature before reading the body (HMAC, timingSafeEqual)", ["docusign", "dotloop", "skyslope", "authentisign"].every((p) => { const r = code(`app/api/webhooks/${p}/route.ts`); return /timingSafeEqual/.test(r) && r.indexOf("verify") < r.indexOf("JSON.parse(rawBody)") }))

  // ── D · OUTSIDE OFFER + form_source ──────────────────────────────────────────────────────────
  console.log("\n[D · an outside-property offer needs no listing id; offers.form_source is spelled in its CHECK]")
  const co = code("app/actions/buyer-offers.ts"), wiz = code("app/components/form-wizard/FormWizard.tsx")
  check("createOffer: listing_id starts NULL, is honoured only for a listing in the SAME tenant, and the row is written with that resolved value (never fabricated)",
    /let resolvedListingId: string \| null = null/.test(co) && /linkListing\.brokerage_id !== brokerageId/.test(co) && /listing_id:\s*resolvedListingId/.test(co))
  check("the wizard: an MLS # that matches none of our listings is normal — the offer proceeds with listing_id null (resolveListingIdByMlsAction, no refusal)", /resolveListingIdByMlsAction\(state\.mlsNumber\)/.test(wiz) && /listing_id: resolvedListingId/.test(wiz))
  const fs = (CHECK_VOCABULARIES.offers.form_source as readonly string[])
  const sources = [
    offerFormSourceFor([{ source: "my_forms" }]), offerFormSourceFor([{ source: "my_forms" }, { source: "legal_forms_provider", providerName: "skyslope" }]),
    offerFormSourceFor([{ source: "legal_forms_provider", providerName: "dotloop" }]), offerFormSourceFor([{ source: "legal_forms_provider", providerName: "formsimplicity" }]), offerFormSourceFor([]),
  ]
  check(`offerFormSourceFor always answers a CHECK member (${sources.join(", ")}): library → in_app, provider name when admitted, else manual`, sources.every((s) => fs.includes(s)) && sources[0] === "in_app" && sources[2] === "dotloop" && sources[3] === "manual" && sources[4] === "manual")
  check("POSITIVE CONTROL: the wizard's old join ('my_forms,transaction_provider') is NOT a CHECK member — that insert was refused whole", !fs.includes("my_forms,transaction_provider") && !fs.includes("my_forms"))
  check("the wizard spells form_source through the mapper and no longer joins its own source words", /form_source: offerFormSourceFor\(/.test(wiz) && !/f\.source\)\.join\(","\)/.test(wiz))

  // ── E · THE FORMWIZARD ───────────────────────────────────────────────────────────────────────
  console.log("\n[E · the FormWizard: the owner's sequence, the coach, the recommendation, the terms, autosave, the legal-forms name]")
  check("the sequence is the owner's order: Purpose → Property → Parties → Terms → Recommended Forms → Complete → Review → E-sign/Deliver (→ Monitor)",
    FORM_WIZARD_SEQUENCE.map((s) => s.key).join() === "purpose,property,parties,terms,recommended_forms,complete,review,esign,monitor" && stepNumber("esign") === 8 && stepKeyAt(1) === "purpose" && stepKeyAt(99) === "monitor")
  check("CDA is NOT a step (owner), and the opening question is the owner's", !FORM_WIZARD_STEP_LABELS.some((l) => /cda|disbursement/i.test(l)) && !FORM_WIZARD_SEQUENCE.some((s) => /cda/i.test(s.key)) && FORM_WIZARD_OPENING_QUESTION === "Are we preparing listing forms or an offer?")
  check("POSITIVE CONTROL: the CDA finder would catch a CDA step", ["CDA"].some((l) => /cda|disbursement/i.test(l)))
  // The render block starts at the purpose mount; each later key must mount AFTER the previous one (the
  // e-sign blocker banners above the block also test stepKey, so the scan walks forward, never from 0).
  const keysInRender: number[] = []
  for (const k of ["purpose", "property", "parties", "terms", "recommended_forms", "complete", "review", "esign", "monitor"]) {
    keysInRender.push(wiz.indexOf(`{stepKey === "${k}" && `, keysInRender.length ? keysInRender[keysInRender.length - 1] + 1 : 0))
  }
  check("the wizard renders every step from the spine's keys, in the spine's order, and spells no step NUMBER (`step === N`) anywhere",
    keysInRender.every((i) => i > 0) && keysInRender.every((i, n) => n === 0 || i > keysInRender[n - 1]) && !/step === \d/.test(wiz) && /stepKeyAt\(step\)/.test(wiz) && /FORM_WIZARD_OPENING_QUESTION/.test(wiz))
  check("POSITIVE CONTROL: the step-number finder recognises the retired shape", /step === \d/.test(`{step === 5 && <Step5ESign`))
  check("every existing step component SURVIVES (Step1Context, Step2Forms, Step3Fill, Step4Signers, Step5ESign) — extended, not rewritten", ["Step1Context", "Step2Forms", "Step3Fill", "Step4Signers", "Step5ESign"].every((c) => new RegExp(`function ${c}\\(`).test(wiz) && new RegExp(`<${c}\\b`).test(wiz)))
  check("the purpose can be switched on the opening step and re-seeds the parties for that purpose", /function StepPurpose\(/.test(wiz) && /choosePurpose/.test(wiz) && /buildInitialSigners\(next, contact, agentName, agentEmail\)/.test(wiz))
  // The coach.
  const allQ = [...LISTING_INTAKE, ...OFFER_INTAKE]
  check("the coach EXPLAINS every question and never states a number, price or date as fact (no digit in any coach line); the three coach rules are declared", allQ.every((q) => q.coach.length > 40 && !/\d/.test(q.coach)) && AI_COACH_RULES.length === 3 && /never invents legal terms, signatures or material facts/.test(AI_COACH_RULES[2]))
  check("the listing intake asks representation, period, price confirmation, compensation, disclosures (lead paint, HOA, seller disclosure) and special terms", ["representation", "listing_start", "listing_end", "list_price_confirmed", "compensation", "pre_1978", "hoa", "seller_disclosures_ready", "special_terms"].every((k) => LISTING_INTAKE.some((q) => q.key === k)))
  check("the offer intake asks in-house vs outside, price, financing, earnest money, closing date, contingencies/deadlines, credits, inclusions/exclusions, special terms", ["property_source", "offer_price", "financing_type", "earnest_money", "closing_date", "inspection_period_days", "financing_contingency_days", "appraisal_contingency", "closing_cost_contribution", "inclusions_exclusions", "special_terms", "escalation_clause"].every((k) => OFFER_INTAKE.some((q) => q.key === k)))
  const cash = intakeQuestionsFor("offer", { financing_type: "cash" }), financed = intakeQuestionsFor("offer", { financing_type: "conventional" })
  check("conversational: a cash purchase is never asked about financing or appraisal contingencies; a financed one is", !cash.some((q) => q.key === "financing_contingency_days" || q.key === "appraisal_contingency") && financed.some((q) => q.key === "financing_contingency_days"))
  check("the coach names what is still missing (required prompts), and nothing when all are answered",
    missingRequiredIntake("offer", { financing_type: "cash" }).length > 3 && missingRequiredIntake("listing", { representation: "exclusive_right_to_sell", listing_start: "2026-11-01", listing_end: "2027-05-01", list_price_confirmed: true, pre_1978: false, hoa: false }).length === 0)
  const terms = offerTermsToCreateOfferFields({ offer_price: "$525,000", earnest_money: 5000, financing_type: "conventional", financing_contingency_days: 21, inspection_period_days: 10, appraisal_contingency: true, appraisal_contingency_days: 21, closing_date: "2026-12-15", closing_cost_contribution: 3000, escalation_clause: true, escalation_cap: 540000, inclusions_exclusions: "Fridge stays", special_terms: "Seller to repair gate" })
  check("the agent's answers become the offer's REAL terms (price parsed from '$525,000', contingencies + days, credit, escalation cap, inclusions in special_conditions)",
    terms.offer_price === 525000 && terms.earnest_money === 5000 && terms.financing_contingency && terms.financing_contingency_days === 21 && terms.inspection_period_days === 10 && terms.appraisal_contingency && terms.closing_date === "2026-12-15" && terms.closing_cost_contribution === 3000 && terms.escalation_clause && terms.escalation_cap === 540000 && /Fridge stays/.test(terms.special_conditions ?? "") && /Seller to repair gate/.test(terms.special_conditions ?? ""))
  const cashTerms = offerTermsToCreateOfferFields({ offer_price: 400000, financing_type: "cash", inspection_period_days: 7 })
  check("a cash offer carries no financing / appraisal contingency; an unanswered number is 0 — never an invented placeholder", !cashTerms.financing_contingency && !cashTerms.appraisal_contingency && cashTerms.financing_contingency_days === 0 && cashTerms.earnest_money === 0 && cashTerms.inspection_contingency)
  check("the wizard feeds those terms into createOffer (no 0 / 'conventional' / 21-day placeholders remain)", /\.\.\.offerTermsToCreateOfferFields\(state\.terms \?\? \{\}\)/.test(wiz) && !/offer_price: 0,/.test(wiz) && !/financing_contingency_days: 21,/.test(wiz))
  // The recommendation.
  const ca = getStateForms("CA", "listing")
  const available = [
    { ref: "brokerage/b/CAR RLA Residential Listing Agreement 2025.pdf", name: "CAR RLA Residential Listing Agreement 2025.pdf", source: "my_forms" as const },
    { ref: "brokerage/b/CAR TDS Transfer Disclosure Statement.pdf", name: "CAR TDS Transfer Disclosure Statement.pdf", source: "my_forms" as const },
    { ref: "brokerage/b/Brokerage Wire Fraud Advisory.pdf", name: "Brokerage Wire Fraud Advisory.pdf", source: "my_forms" as const },
    { ref: "sky-77", name: "CAR LPA Lead-Based Paint Disclosure", source: "legal_forms_provider" as const, providerName: "skyslope" },
  ]
  const rec = recommendForms({ purpose: "listing", answers: { pre_1978: true, hoa: false }, statePackage: ca, available, stateCode: "CA" })
  const recNames = rec.recommended.map((r) => r.name)
  check("CA listing: the required RLA + TDS from the library are recommended; the unrelated wire advisory is never pushed; the lead-paint form is NOT recommended even though pre-1978 was answered, because CA's verified LISTING package does not carry it (the package decides, never the catalogue)",
    recNames.some((n) => /RLA/.test(n)) && recNames.some((n) => /TDS/.test(n)) && !recNames.some((n) => /Wire/.test(n)) && !recNames.some((n) => /Lead/.test(n)) && !ca.required.concat(ca.addenda).some((n) => /lead/i.test(n)), JSON.stringify(recNames))
  check("INVARIANT: every recommendation is a form that EXISTS in `available` (never invented); a package form nobody has is NAMED under missing (the CA agency disclosure)",
    rec.recommended.every((r) => available.some((a) => a.ref === r.ref)) && rec.missing.some((m) => /Agency|AD/.test(m.packageForm) && /not in your library/.test(m.why)))
  const none = recommendForms({ purpose: "listing", answers: { pre_1978: true }, statePackage: ca, available: [], stateCode: "CA" })
  check("with nothing available, nothing is recommended and every required form is named missing", none.recommended.length === 0 && none.missing.filter((m) => m.kind === "required").length === ca.required.length)
  const ct = getStateForms("CT", "offer")
  const ctAvail = [
    { ref: "brokerage/b/CT Real Estate Sales Contract.pdf", name: "CT Real Estate Sales Contract.pdf", source: "my_forms" as const },
    { ref: "brokerage/b/CT Residential Property Condition Disclosure.pdf", name: "CT Residential Property Condition Disclosure.pdf", source: "my_forms" as const },
    { ref: "brokerage/b/CT Mortgage Contingency.pdf", name: "CT Mortgage Contingency.pdf", source: "my_forms" as const },
    { ref: "sky-78", name: "CT Lead Paint Disclosure", source: "legal_forms_provider" as const, providerName: "skyslope" },
  ]
  const ctOld = recommendForms({ purpose: "offer", answers: { financing_type: "cash", pre_1978: true }, statePackage: ct, available: ctAvail, stateCode: "CT" })
  const ctNew = recommendForms({ purpose: "offer", answers: { financing_type: "cash", pre_1978: false }, statePackage: ct, available: ctAvail, stateCode: "CT" })
  check("CT offer (lead paint IS a package addendum there): pre-1978 → the lead disclosure is recommended from the legal-forms provider with the reason; a newer home → it is not; a cash purchase never gets the mortgage contingency",
    ctOld.recommended.some((r) => /Lead/.test(r.name) && r.source === "legal_forms_provider" && /1978/.test(r.reason)) && !ctNew.recommended.some((r) => /Lead/.test(r.name)) && !ctOld.recommended.some((r) => /Mortgage/.test(r.name)) && ctOld.recommended.some((r) => /Sales Contract/.test(r.name)), JSON.stringify(ctOld.recommended.map((r) => r.name)))
  const tx = getStateForms("TX", "offer")
  const txAvail = [...tx.required, ...tx.addenda].map((n, i) => ({ ref: `lib/${i}`, name: `${n}.pdf`, source: "my_forms" as const }))
  const cashRec = recommendForms({ purpose: "offer", answers: { financing_type: "cash", inspection_period_days: 7 }, statePackage: tx, available: txAvail, stateCode: "TX" })
  const finRec = recommendForms({ purpose: "offer", answers: { financing_type: "fha", inspection_period_days: 7, appraisal_contingency: true }, statePackage: tx, available: txAvail, stateCode: "TX" })
  check("TX offer: a cash purchase gets no financing addendum; an FHA purchase gets the financing / FHA addenda the package carries (answers decide, not the catalogue)",
    !cashRec.recommended.some((r) => /financ|loan|fha/i.test(r.name)) && finRec.recommended.some((r) => /financ|loan|fha/i.test(r.name)) && cashRec.recommended.every((r) => txAvail.some((a) => a.ref === r.ref)))
  check("the wizard renders the recommendation above the libraries with 'Select recommended' and names the missing forms", /recommendForms\(\{ purpose: mode, answers: state\.terms \?\? \{\}, statePackage, available, stateCode \}\)/.test(wiz) && /Select recommended \(/.test(wiz) && /recommendation\.missing\.map/.test(wiz))
  check("the Review step shows purpose, property, parties, terms, the packet (filled or not) and delivery before the agent approves it", /function StepReview\(/.test(wiz) && /Approve packet & continue/.test(wiz) && /not filled yet/.test(wiz))
  // Source choice (a) in-platform packet / (b) the provider's official window — both survive.
  check("source (a): the in-platform packet is filled in OUR window (prefillStorageFormAction, the editable field panel, the legal-description gate); source (b): the provider's window frames only where the vendor documents it, else a popup",
    /prefillStorageFormAction\(\{/.test(wiz) && /applyEdits\(f\.formRef\)/.test(wiz) && /fs\.incomplete/.test(wiz) && /providerInfo\.embedMode === "iframe" \?/.test(wiz) && /openProviderPopup\(providerInfo\.embedUrl/.test(wiz))
  // Autosave / resume on the forms kernel's draft commands (built, previously unwired).
  check("drafts AUTOSAVE and RESUME through the forms kernel's own commands (saveFormDraftAction / loadFormDraftAction — survivors with no wizard caller until now); the agent's typing always wins",
    /saveFormDraftAction\(\{ form_name: draftFormName/.test(wiz) && /loadFormDraftAction\(\{ form_name/.test(wiz) && /if \(prev\.propertyAddress \|\| prev\.offerId \|\| prev\.listingId\) return prev/.test(wiz) && /export async function saveFormDraft\(/.test(code("lib/kernel/forms.ts")))
  // The legal-forms vocabulary at the tenant-facing level.
  const tenantFacing = (s: string) => /(["'`>])[^"'`<]*transaction provider[^"'`<]*(["'`<])/i.test(s)
  check("POSITIVE CONTROL: the tenant-copy finder sees the retired wording", tenantFacing(`<p>No transaction provider configured.</p>`) && tenantFacing(`error: "No transaction provider configured."`))
  const copyFiles = ["app/components/form-wizard/FormWizard.tsx", "app/dashboard/forms/FormsLibraryClient.tsx", "app/dashboard/settings/integrations/integrations-client.tsx", "app/api/forms/provider-library/route.ts", "lib/integrations/providers/provider-resolver.ts", "lib/esign/dispatch-packet.ts", "lib/kernel/immediate-operations.ts"]
  const stale = copyFiles.filter((f) => tenantFacing(code(f)))
  check(`no tenant-facing 'transaction provider' wording remains in the named surfaces (${copyFiles.length} files); the settings label and the wizard tab say legal-forms provider; the catalog carries the ONE label`,
    stale.length === 0 && /transaction: "LEGAL-FORMS PROVIDER"/.test(code("app/dashboard/settings/integrations/integrations-client.tsx")) && /Legal-forms provider/.test(wiz) && /export const LEGAL_FORMS_PROVIDER_LABEL = "Legal-forms provider"/.test(code("lib/integrations/providers/catalog.ts")), stale.join(", "))
  check("the provider capability matrix still claims exactly the owner's head functions per provider (credentials · settings · forms · transaction creation · upload · fill · e-sign · status · sync)",
    /"credentials", "settings", "forms", "transaction_creation", "document_upload", "form_fill", "esign", "status", "sync"/.test(code("lib/integrations/providers/catalog.ts")))

  // ── G · WAVE 143, LANE 143A — LISTING AGREEMENTS: FULLY EXECUTED ONLY AFTER COMPLIANCE APPROVAL; THE MLS LIVE DATE ──
  console.log("\n[G · 143A: the listing agreement's two legacy columns follow the ladder; the MLS live date is planned XOR verified]")
  const { hopCompanionColumns } = await import("../lib/esign/packet-states")
  check("PURE: the companion columns are the stamps of exactly one hop each — compliance_approved → compliance_passed, fully_executed → fully_executed_at; every other hop, and every OFFER hop, stamps nothing",
    JSON.stringify(hopCompanionColumns("listing_agreements", "compliance_approved", "T")) === JSON.stringify({ compliance_passed: true })
    && JSON.stringify(hopCompanionColumns("listing_agreements", "fully_executed", "T")) === JSON.stringify({ fully_executed_at: "T" })
    && ESIGN_PACKET_STATES.filter((s) => s !== "compliance_approved" && s !== "fully_executed").every((s) => Object.keys(hopCompanionColumns("listing_agreements", s, "T")).length === 0)
    && ESIGN_PACKET_STATES.every((s) => Object.keys(hopCompanionColumns("offers", s, "T")).length === 0))
  const dbG = memSupabase({
    users: [{ id: U_AGENT, brokerage_id: BRK, user_type: "agent" }, { id: U_TC, brokerage_id: BRK, user_type: "tc" }],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: BRK }],
    listing_agreements: [{ id: "d0000000-0000-4000-8000-0000000000g1", brokerage_id: BRK, listing_id: L1, agent_user_id: U_AGENT, seller_contact_id: "contact-2", esign_status: "sent", fully_executed_at: null, compliance_passed: false, created_at: "2026-03-01T00:00:00Z" }],
    notifications: [],
  })
  const LAG = "d0000000-0000-4000-8000-0000000000g1"
  const agG = () => dbG.tables.listing_agreements.find((a) => a.id === LAG)!
  await advanceEsignPacketState(dbG, { brokerageId: BRK, record: { table: "listing_agreements", id: LAG }, to: "fully_signed", source: "webhook", provider: "docusign" })
  const atSigned = { status: agG().esign_status, stamp: agG().fully_executed_at, mark: agG().compliance_passed }
  await advanceEsignPacketState(dbG, { brokerageId: BRK, record: { table: "listing_agreements", id: LAG }, to: "compliance_pending", source: "system" })
  await advanceEsignPacketState(dbG, { brokerageId: BRK, record: { table: "listing_agreements", id: LAG }, to: "compliance_approved", source: "system", notify: false })
  const atApproved = { status: agG().esign_status, stamp: agG().fully_executed_at, mark: agG().compliance_passed }
  await advanceEsignPacketState(dbG, { brokerageId: BRK, record: { table: "listing_agreements", id: LAG }, to: "fully_executed", source: "system" })
  const atExecuted = { status: agG().esign_status, stamp: agG().fully_executed_at, mark: agG().compliance_passed }
  check("LIVE writer: provider all-signed stamps NOTHING (no execution stamp, no compliance mark); compliance_approved writes the mark but NOT the stamp; fully_executed writes the stamp — the order is the rule",
    atSigned.status === "fully_signed" && !atSigned.stamp && atSigned.mark === false
    && atApproved.status === "compliance_approved" && !atApproved.stamp && atApproved.mark === true
    && atExecuted.status === "fully_executed" && typeof atExecuted.stamp === "string" && atExecuted.mark === true, JSON.stringify({ atSigned, atApproved, atExecuted }))
  const providerFiles = ["lib/forms/esign-execution-loop.ts", "lib/esign-webhooks/finalize-packet.ts", "app/actions/seller-listing/execution-engine.ts"]
  const writerSrc = code("lib/esign/packet-state-writer.ts")
  // the writer may spell the stamp ONLY as the companion map's value being applied (`companion.fully_executed_at`, `patch.fully_executed_at`)
  const stampSpelledOnlyAsCompanion = (src: string) => { const hits = [...src.matchAll(/([\w.]*)\bfully_executed_at/g)]; return hits.length > 0 && hits.every((m) => m[1] === "companion." || m[1] === "patch.") }
  check("the PROVIDER's completion paths and the manual-upload insert never spell the execution stamp (3 files, stripped source); POSITIVE CONTROL: the finder sees it in the ladder's companion map, and the ONE writer applies that map's value in its (literal-table) update and spells it no other way",
    providerFiles.every((f) => !/fully_executed_at/.test(code(f))) && /fully_executed_at/.test(code("lib/esign/packet-states.ts"))
    && /hopCompanionColumns\(input\.record\.table, input\.to,/.test(writerSrc) && /\.from\("listing_agreements"\)\.update\(patch\)/.test(writerSrc) && stampSpelledOnlyAsCompanion(writerSrc)
    && !stampSpelledOnlyAsCompanion(`${writerSrc}\n svc.from("listing_agreements").update({ fully_executed_at: now })`) /* control: a second writer spelling the stamp literally is caught */)
  const execEngine = code("app/actions/seller-listing/execution-engine.ts")
  check("markAgreementSigned does NOT invent a go-live date: no `go_live_date:` assignment survives in the engine (POSITIVE CONTROL: the finder sees one in the planned-date writer's update), and the planned date it records comes from a person",
    !/go_live_date\s*:/.test(execEngine) && /go_live_date:\s*wanted/.test(code("lib/listings/mls-live-date.ts")) && /plannedMlsLiveDate\??:\s*string/.test(execEngine) && /recordPlannedMlsLiveDate\(/.test(execEngine))
  check("the provider-completion branches ask the LADDER whether a packet is already processed (isAtOrPastAllSigned), not the stamp",
    /!isAtOrPastAllSigned\(\(matchedAgreement as any\)\.esign_status\)/.test(code("lib/forms/esign-execution-loop.ts")) && /!isAtOrPastAllSigned\(matchedAgreement\.esign_status\)/.test(code("lib/esign-webhooks/finalize-packet.ts")))
  const pastAllSigned = ESIGN_PACKET_STATES.filter((s) => isAtOrPastAllSigned(s))
  const openClause = (code("app/actions/listings-kernel.ts").match(/esign_status\.not\.in\.\(([^)]+)\)/) ?? [])[1] ?? ""
  check(`the listing send's "open agreement" selection excludes exactly the states past all-signed (${pastAllSigned.length}, DERIVED from the ladder — never a hardcoded count)`,
    openClause.split(",").sort().join() === [...pastAllSigned].sort().join(), `source: ${openClause}`)
  check("the loop runs its gate in REVIEW mode inside the window only (complianceReview: inWindow), so the doors still require the recorded mark",
    /complianceReview:\s*inWindow/.test(lcl) && !/complianceReview/.test(code("lib/kernel/listings.ts")) && !/complianceReview/.test(code("app/actions/seller-listing/execution-engine.ts")))
  const m796 = existsSync(join(ROOT, "supabase/migrations/m796-listing-mls-live-date-planned-vs-verified.sql")) ? read("supabase/migrations/m796-listing-mls-live-date-planned-vs-verified.sql") : ""

  // ── the MLS live date: planned XOR verified (pure, with positive controls) ──
  const { resolveMlsLiveDates, computeDaysOnMarketForListing, ymdOf, todayInTimeZone, MLS_LIVE_SOURCES, MLS_LIVE_DATE_BASES } = await import("../lib/listings/compute-dom")
  const NOW = new Date("2026-10-23T03:30:00Z")
  const planned = resolveMlsLiveDates({ go_live_date: "2026-10-25", mls_live_timezone: "America/New_York" }, NOW)
  const verified = resolveMlsLiveDates({ go_live_date: "2026-10-10", mls_live_date_actual: "2026-10-12", go_live_confirmed_at: "2026-10-13T10:00:00Z", go_live_confirmed_source: "rentcast", mls_live_date_basis: "feed_list_date" }, NOW)
  const dateOnly = resolveMlsLiveDates({ go_live_date: "2026-10-10", mls_live_date_actual: "2026-10-12" }, NOW)
  const noSource = resolveMlsLiveDates({ go_live_date: "2026-10-10", mls_live_date_actual: "2026-10-12", go_live_confirmed_at: "x", go_live_confirmed_source: "a human" }, NOW)
  check("a PLANNED date is never presented as verified: basis 'planned', actual null, plannedInFuture true (in the listing's zone)", planned.basis === "planned" && planned.actual === null && planned.verifiedAt === null && planned.plannedInFuture)
  check("a VERIFIED date needs the feed's whole evidence: date + confirmed_at + a known source → basis 'verified', variance = actual − planned",
    verified.basis === "verified" && verified.actual === "2026-10-12" && verified.verifiedSource === "rentcast" && verified.varianceDays === 2 && verified.date === "2026-10-12")
  check("POSITIVE CONTROLS (a date without its evidence is NOT verified): an actual date with no confirmation instant → planned; one confirmed by 'a human' → planned; the DB CHECK admits only the two feeds",
    dateOnly.basis === "planned" && dateOnly.actual === null && noSource.basis === "planned" && noSource.actual === null
    && [...MLS_LIVE_SOURCES].join() === "rentcast,idx" && [...MLS_LIVE_DATE_BASES].join() === "feed_list_date,first_observed")
  check("the SAME instant is a different calendar day in different zones, and the planned-date arrival follows the listing's zone (03:30Z is still Oct 22 in New York and Los Angeles, Oct 23 in UTC)",
    todayInTimeZone("America/New_York", NOW) === "2026-10-22" && todayInTimeZone("America/Los_Angeles", NOW) === "2026-10-22" && todayInTimeZone(null, NOW) === "2026-10-23" && todayInTimeZone("Not/AZone", NOW) === "2026-10-23"
    && resolveMlsLiveDates({ go_live_date: "2026-10-23", mls_live_timezone: "America/New_York" }, NOW).plannedInFuture === true && resolveMlsLiveDates({ go_live_date: "2026-10-23" }, NOW).plannedInFuture === false)
  check("DOM counts calendar days from the verified date when there is one, else from the planned date once it has arrived (0 before), else null — and says which basis",
    computeDaysOnMarketForListing({ go_live_date: "2026-10-10", mls_live_date_actual: "2026-10-12", go_live_confirmed_at: "x", go_live_confirmed_source: "idx" }, NOW).days === 11
    && computeDaysOnMarketForListing({ go_live_date: "2026-10-10" }, NOW).basis === "planned" && computeDaysOnMarketForListing({ go_live_date: "2026-10-30" }, NOW).days === 0 && computeDaysOnMarketForListing({}, NOW).days === null
    && ymdOf("2026-02-31") === null && ymdOf("garbage") === null && ymdOf("2026-10-25T09:00:00Z") === "2026-10-25")

  // ── the two writers, LIVE on the in-memory client ──
  const { recordPlannedMlsLiveDate, recordVerifiedMlsLive, plannedMlsLiveDateLaunchBlocker } = await import("../lib/listings/mls-live-date")
  const LST = "e0000000-0000-4000-8000-0000000000g2"
  const dbM = memSupabase({
    users: [{ id: U_AGENT, brokerage_id: BRK, user_type: "agent" }],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: BRK }],
    listings: [{ id: LST, brokerage_id: BRK, agent_id: AG, state: "FL", address: "1 Canary Way", go_live_date: null, lifecycle_stage: "LISTING_AGREEMENT_INITIATED", mls_live_timezone: null, go_live_confirmed_at: null, mls_live_date_actual: null }],
    global_settings: [{ id: "gs1", brokerage_id: BRK, timezone: "America/Chicago", created_at: "2026-01-01T00:00:00Z" }],
    notifications: [],
  })
  const lst = () => dbM.tables.listings.find((l) => l.id === LST)!
  ;(globalThis as any).__142B.events.length = 0
  const p0 = await recordPlannedMlsLiveDate(dbM, { brokerageId: BRK, listingId: LST, date: "2026-11-02", actorUserId: U_AGENT, source: "intake" })
  check("recordPlannedMlsLiveDate: writes go_live_date and NOTHING verified, resolves the PROPERTY's zone from its state (FL → America/New_York), leaves one evidence row saying verified:false",
    p0.ok && lst().go_live_date === "2026-11-02" && lst().mls_live_timezone === "America/New_York" && lst().go_live_confirmed_at === null && lst().mls_live_date_actual === null
    && (globalThis as any).__142B.events.filter((e: any) => e.input.event_type === "listing.mls_live_date.planned" && e.input.payload.verified === false && e.input.payload.planned === "2026-11-02").length === 1, JSON.stringify(p0))
  const pSame = await recordPlannedMlsLiveDate(dbM, { brokerageId: BRK, listingId: LST, date: "2026-11-02", actorUserId: U_AGENT, source: "timeline" })
  check("an unchanged planned date is an idempotent no-op (no second evidence row)", pSame.ok && (pSame as any).noop === true && (globalThis as any).__142B.events.filter((e: any) => e.input.event_type === "listing.mls_live_date.planned").length === 1)
  const pBad = await recordPlannedMlsLiveDate(dbM, { brokerageId: BRK, listingId: LST, date: "2026-02-31", actorUserId: U_AGENT, source: "timeline" })
  const pForeign = await recordPlannedMlsLiveDate(dbM, { brokerageId: BRK2, listingId: LST, date: "2026-12-01", actorUserId: U_AGENT, source: "timeline" })
  check("a non-date is refused by name; ANOTHER brokerage's session cannot date this listing (the read is tenant-pinned → 'not found'), and the row is untouched",
    !pBad.ok && /calendar date/.test((pBad as any).reason) && !pForeign.ok && /not found/.test((pForeign as any).reason) && lst().go_live_date === "2026-11-02")
  const pClear = await recordPlannedMlsLiveDate(dbM, { brokerageId: BRK, listingId: LST, date: null, actorUserId: U_AGENT, source: "timeline" })
  check("clearing the plan is allowed and recorded (the date was only ever a plan)", pClear.ok && lst().go_live_date === null)
  await recordPlannedMlsLiveDate(dbM, { brokerageId: BRK, listingId: LST, date: "2026-11-02", actorUserId: U_AGENT, source: "timeline" })
  const refusedM = memSupabase({ listings: [{ id: LST, brokerage_id: BRK, state: "FL", go_live_date: null }] }, { refuse: { listings: "permission denied for table listings" } })
  const pRefused = await recordPlannedMlsLiveDate(refusedM, { brokerageId: BRK, listingId: LST, date: "2026-11-02", actorUserId: null, source: "intake" })
  check("a REFUSED listings read is a refusal naming the cause, never 'no such listing' (supabase-js resolves refusals)", !pRefused.ok && /permission denied/.test((pRefused as any).reason))
  const blockerFuture = await plannedMlsLiveDateLaunchBlocker(dbM, LST, new Date("2026-10-23T12:00:00Z"))
  const blockerArrived = await plannedMlsLiveDateLaunchBlocker(dbM, LST, new Date("2026-11-03T12:00:00Z"))
  check("the launch door reads it: a planned date that has not arrived (in the listing's zone) blocks launch with the remedy named; once it arrives the block lifts",
    typeof blockerFuture === "string" && /has not arrived/.test(blockerFuture) && /2026-11-02/.test(blockerFuture) && blockerArrived === null)
  const v0 = await recordVerifiedMlsLive(dbM, { brokerageId: BRK, listingId: LST, source: "rentcast", feedListDate: "2026-11-04", actorUserId: null, now: new Date("2026-11-05T15:00:00Z") })
  check("recordVerifiedMlsLive: stamps the actual date from the FEED's own list date with the whole evidence (confirmed_at, source, basis feed_list_date), keeps the plan untouched, reports the variance (+2d), bells the agent once",
    v0.ok && lst().mls_live_date_actual === "2026-11-04" && lst().mls_live_date_basis === "feed_list_date" && lst().go_live_confirmed_source === "rentcast" && typeof lst().go_live_confirmed_at === "string"
    && lst().go_live_date === "2026-11-02" && (v0 as any).varianceDays === 2 && dbM.tables.notifications.filter((n) => n.type === "listing.mls_live_confirmed").length === 1, JSON.stringify(v0))
  const v1 = await recordVerifiedMlsLive(dbM, { brokerageId: BRK, listingId: LST, source: "idx", feedListDate: null, actorUserId: null, now: new Date("2026-11-09T15:00:00Z") })
  check("IDEMPOTENT: a second confirmation never re-dates a verified listing (the first confirmation is the evidence)", v1.ok && (v1 as any).noop === true && lst().mls_live_date_actual === "2026-11-04" && lst().go_live_confirmed_source === "rentcast")
  const LST2 = "e0000000-0000-4000-8000-0000000000g3"
  dbM.tables.listings.push({ id: LST2, brokerage_id: BRK, agent_id: AG, state: "TX", address: "2 Canary Way", go_live_date: "2026-11-01", mls_live_timezone: null, go_live_confirmed_at: null, mls_live_date_actual: null })
  const vFuture = await recordVerifiedMlsLive(dbM, { brokerageId: BRK, listingId: LST2, source: "idx", feedListDate: "2027-01-01", actorUserId: null, now: new Date("2026-11-05T15:00:00Z") })
  const l2 = dbM.tables.listings.find((l) => l.id === LST2)!
  check("a feed 'list date' in the FUTURE of the listing's zone is not evidence: the observation day is used and the basis says first_observed; the zone came from the property's state (TX → America/Chicago)",
    vFuture.ok && l2.mls_live_date_actual === "2026-11-05" && l2.mls_live_date_basis === "first_observed" && l2.mls_live_timezone === "America/Chicago", JSON.stringify(vFuture))
  const vBadSource = await recordVerifiedMlsLive(dbM, { brokerageId: BRK, listingId: LST2, source: "human" as any, feedListDate: null, actorUserId: null })
  const vForeign = await recordVerifiedMlsLive(dbM, { brokerageId: BRK2, listingId: LST, source: "rentcast", feedListDate: null, actorUserId: null })
  check("NOBODY ELSE CAN VERIFY: a source that is not a feed is refused; another brokerage cannot confirm this listing", !vBadSource.ok && /not a syndication feed/.test((vBadSource as any).reason) && !vForeign.ok)
  const preM796 = memSupabase({ listings: [{ id: LST, brokerage_id: BRK, state: "FL" }] }, { missingColumns: { listings: ["mls_live_date_actual", "go_live_confirmed_at", "go_live_confirmed_source", "mls_live_date_basis", "mls_live_timezone"] } })
  const vPre = await recordVerifiedMlsLive(preM796, { brokerageId: BRK, listingId: LST, source: "rentcast", feedListDate: null, actorUserId: null })
  check("BEFORE m796 is applied the verified writer REFUSES BY NAME (never a silent success): the read of the new columns is refused and says m796", !vPre.ok && /m796/.test((vPre as any).reason))

  // ── verification: the shared core and the autonomous sweep (feeds injected) ──
  const { verifyAndRecordMlsLive, runMlsLiveVerificationSweep } = await import("../lib/listings/mls-live-verification")
  const LST3 = "e0000000-0000-4000-8000-0000000000g4", LST4 = "e0000000-0000-4000-8000-0000000000g5", LST5 = "e0000000-0000-4000-8000-0000000000g6", LST6 = "e0000000-0000-4000-8000-0000000000g8"
  const dbS = memSupabase({
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: BRK }],
    listings: [
      { id: LST3, brokerage_id: BRK, agent_id: AG, status: "active", mls_number: "24-1001", address: "10 Oak Street", city: "Tampa", state: "FL", zip: "33602", go_live_date: "2026-11-01", go_live_confirmed_at: null, metadata: {}, updated_at: "2026-11-02T00:00:00Z" },
      { id: LST4, brokerage_id: BRK, agent_id: AG, status: "active", mls_number: "24-2002", address: "20 Pine Avenue", city: "Tampa", state: "FL", zip: "33602", go_live_date: "2026-11-01", go_live_confirmed_at: null, metadata: {}, updated_at: "2026-11-03T00:00:00Z" },
      { id: LST5, brokerage_id: BRK, agent_id: AG, status: "active", mls_number: "24-3003", address: "30 Elm Road", city: "Tampa", state: "FL", zip: "33602", go_live_date: "2026-11-01", go_live_confirmed_at: null, metadata: { mls_live_check: { checked_at: "2026-11-05T08:00:00Z", verdict: "pending" } }, updated_at: "2026-11-04T00:00:00Z" },
      { id: LST6, brokerage_id: BRK, agent_id: AG, status: "active", mls_number: "24-4004", address: "40 Cedar Lane", city: "Tampa", state: "FL", zip: "33602", go_live_date: "2026-11-01", go_live_confirmed_at: null, metadata: { mls_live_check: { checked_at: "2026-11-03T08:00:00Z", verdict: "pending" } }, updated_at: "2026-11-04T12:00:00Z" },
      { id: "e0000000-0000-4000-8000-0000000000g7", brokerage_id: BRK2, agent_id: null, status: "active", mls_number: "99-9", address: "9 Other Way", go_live_confirmed_at: null, metadata: {}, updated_at: "2026-11-01T00:00:00Z" },
    ],
    notifications: [],
  })
  const feeds = async (l: any) => {
    if (/^10 oak/i.test(l.address)) return { consulted: ["rentcast" as const], observations: [{ source: "rentcast" as const, mlsNumber: "241001", mlsName: "Stellar MLS", address: "10 Oak St", status: "Active", listedDate: "2026-11-03" }] }
    if (/^20 pine/i.test(l.address)) return { consulted: ["rentcast" as const], observations: [{ source: "rentcast" as const, mlsNumber: "24-9999", mlsName: "Stellar MLS", address: "20 Pine Ave", status: "Active", listedDate: "2026-11-03" }] }
    return { consulted: [], observations: [] }
  }
  const sweep = await runMlsLiveVerificationSweep(dbS, BRK, { feeds, now: new Date("2026-11-05T12:00:00Z"), limit: 10 })
  const s3 = dbS.tables.listings.find((l) => l.id === LST3)!, s4 = dbS.tables.listings.find((l) => l.id === LST4)!
  // snapshots taken NOW: the checks below re-verify LST5 on purpose, so its post-sweep state must be captured first
  const l5AfterSweep = JSON.parse(JSON.stringify(dbS.tables.listings.find((l) => l.id === LST5)!.metadata)), l6AfterSweep = JSON.parse(JSON.stringify(dbS.tables.listings.find((l) => l.id === LST6)!.metadata))
  check("the SWEEP, tenant-bounded: a feed match (MLS# formatted differently) CONFIRMS and records the actual date from the feed (Nov 3, 2 days after the Nov 1 plan); a DIFFERENT number is contradicted, recorded nowhere as live, and the agent is belled; a listing checked within 24h is skipped; the other brokerage's listing is never touched",
    sweep.confirmed === 1 && sweep.contradicted === 1 && sweep.skippedRecent === 1 && sweep.scanned === 3 && sweep.unverifiable === 1 && s3.mls_live_date_actual === "2026-11-03" && s3.go_live_confirmed_source === "rentcast"
    && s4.go_live_confirmed_at == null && s4.mls_live_date_actual == null && dbS.tables.notifications.some((n) => n.type === "listing.mls_contradicted")
    && dbS.tables.listings.find((l) => l.brokerage_id === BRK2)!.metadata && !(dbS.tables.listings.find((l) => l.brokerage_id === BRK2)!.metadata as any).mls_live_check, JSON.stringify(sweep))
  const unver = await verifyAndRecordMlsLive(dbS, { brokerageId: BRK }, LST5, { feeds, now: new Date("2026-11-06T12:00:00Z") })
  check("NO FEED CONNECTED is `unverifiable` — recorded as the last check, NEVER rendered as 'not on the MLS', and nothing is stamped verified",
    unver.ok && (unver as any).verification.verdict === "unverifiable" && (unver as any).recorded === null && dbS.tables.listings.find((l) => l.id === LST5)!.go_live_confirmed_at == null
    && (dbS.tables.listings.find((l) => l.id === LST5)!.metadata as any).mls_live_check.verdict === "unverifiable")
  check("the sweep spends a metered feed read on a listing at most once per 24h: never checked → checked; last checked 2 days ago → re-checked (its last-check instant moves to the sweep time); last checked 4 hours ago → skipped and left exactly as it was — and the street matcher the action used still matches 'Street' to 'St' (a feed row written '10 Oak St' confirmed '10 Oak Street')",
    (s3.metadata as any).mls_live_check?.checked_at === "2026-11-05T12:00:00.000Z" && l6AfterSweep.mls_live_check.checked_at === "2026-11-05T12:00:00.000Z" && l6AfterSweep.mls_live_check.verdict === "unverifiable"
    && l5AfterSweep.mls_live_check.checked_at === "2026-11-05T08:00:00Z" && l5AfterSweep.mls_live_check.verdict === "pending" && s3.mls_live_date_actual === "2026-11-03", JSON.stringify({ l6: l6AfterSweep, l5: l5AfterSweep }))

  // ── the wiring (stripped source; every absence has its positive control) ──
  const kernel = code("lib/kernel/listings.ts"), act = code("app/actions/listings-kernel.ts"), cron = code("app/api/cron/proactive-intelligence/route.ts"), datesAct = code("app/actions/listing-dates.ts")
  check("INTAKE: createListingRecord validates then records the planned date through the ONE writer; createListingWithSellerContact accepts and forwards it; the readiness gate and launchListing read the planned date; launch records the launch day as a PLAN only when none exists",
    /plannedMlsLiveDate\?:\s*string/.test(kernel) && /recordPlannedMlsLiveDate\(createServiceClient\(\) as any/.test(kernel) && /plannedMlsLiveDate:\s*params\.plannedMlsLiveDate/.test(act)
    && /plannedMlsLiveDateLaunchBlocker\(supabase as any, input\.listingId\)/.test(kernel) && /if \(!\(listing as any\)\?\.go_live_date\)/.test(kernel) && /source: "launch"/.test(kernel))
  {
    // wave 146 (lane 146I — closes 143A Still open 2): the OTHER door to MLS_ACTIVE (activateMLS) asks the same rule BEFORE its
    // transition, so the two doors cannot disagree. Positive control: the finder rejects a door that transitions first.
    const ee = code("app/actions/seller-listing/execution-engine.ts")
    const body = ee.slice(ee.indexOf("export async function activateMLS"))
    const asksFirst = (src: string) => { const g = src.indexOf("plannedMlsLiveDateLaunchBlocker("), t = src.indexOf("transitionLifecycle("); return g >= 0 && t > g }
    check("BOTH doors to MLS_ACTIVE ask the planned-date rule before they act: launchListing (readiness gate) and activateMLS (before transitionLifecycle) — POSITIVE CONTROL: a door that transitions first is caught",
      asksFirst(body) && !asksFirst(`await transitionLifecycle({})\nawait plannedMlsLiveDateLaunchBlocker(s, id)`))
  }
  check("VERIFICATION: the session action delegates to the shared core (no inline feed code survives — POSITIVE CONTROL: the core has it); the cron sweep (step 8b) is wired; the action never calls the feeds itself",
    /verifyAndRecordMlsLive\(/.test(act) && !/searchRentcastSaleListings|IDXBrokerClient/.test(act) && /searchRentcastSaleListings/.test(code("lib/listings/mls-live-verification.ts")) && /runMlsLiveVerificationSweep\(/.test(cron))
  check("the timeline editor: `field` is allow-listed at RUNTIME (a public endpoint — the TS union is erased), the session's brokerage is the predicate, the rows are COUNTED, the planned date goes through the one writer, and the verified date has NO edit path (read-only card)",
    /LISTING_DATE_FIELDS/.test(datesAct) && /\.eq\("brokerage_id", caller\.brokerageId\)/.test(datesAct) && /\.select\("id"\)/.test(datesAct) && /recordPlannedMlsLiveDate\(/.test(datesAct) && /requireCaller\(\)/.test(datesAct)
    && /function ReadOnlyDateCard\(/.test(code("app/components/dashboard/listings/lifecycle/stage-timeline.tsx")) && !/mls_live_date_actual/.test(datesAct))
  check("the timeline never calls a planned date live: 'MLS Live — planned' beside 'MLS Live — verified' (read-only), the agreement-executed date, and the coming-soon status off the stage machine; a refused save is SAID",
    /MLS Live — planned/.test(code("app/components/dashboard/listings/lifecycle/stage-timeline.tsx")) && /MLS Live — verified/.test(code("app/components/dashboard/listings/lifecycle/stage-timeline.tsx")) && /Listing agreement executed/.test(code("app/components/dashboard/listings/lifecycle/stage-timeline.tsx")) && /setSaveError\(result\.error/.test(code("app/components/dashboard/listings/lifecycle/stage-timeline.tsx"))
    && /computeDaysOnMarketForListing\(listing\)/.test(code("app/components/dashboard/listings/lifecycle/stage-timeline.tsx")) && /dom\.basis === "verified"/.test(code("app/components/dashboard/listings/lifecycle/stage-timeline.tsx")))
  check("the compliance loop reads the planned date through the ONE resolver and records its basis; the recordable-events card collects it at the agreement signature",
    // RE-ASSERTED (wave 145, lane 145Z): the card's KEY was pinned literally ("plannedMlsLiveDate"); lane 145B's Outside-lane
    // 12 renamed it to the agreement's own term (sellerRequestedMlsLiveDate). The RULE — the card collects the date and
    // the recorder reads THAT key — is asserted on whichever key the card declares (derived, not restated).
    /resolveMlsLiveDates\(/.test(lcl) && /mls_start_date_basis:\s*"planned"/.test(lcl)
    && ((k) => !!k && new RegExp(`${k}:\\s*str\\("${k}"\\)`).test(code("app/actions/seller-listing/record-lifecycle-event.ts")))(/key: "(sellerRequestedMlsLiveDate|plannedMlsLiveDate)"/.exec(code("lib/listing-lifecycle/recordable-events.ts"))?.[1]))
  check("m796 exists, is honestly stamped, adds the four columns and the three CHECKs; its vocabularies EQUAL the code's (derived, never restated) — 'an actual date cannot exist without its evidence' is a table CHECK",
    /^-- (WRITTEN, NOT APPLIED \(wave 143, lane 143A\)|── APPLIED LIVE )/.test(m796)
    && ["mls_live_date_actual", "mls_live_date_basis", "go_live_confirmed_source", "mls_live_timezone"].every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`).test(m796))
    && [...MLS_LIVE_SOURCES].every((v) => m796.includes(`'${v}'`)) && [...MLS_LIVE_DATE_BASES].every((v) => m796.includes(`'${v}'`))
    && /listings_mls_live_actual_has_evidence_check/.test(m796) && /go_live_confirmed_at IS NOT NULL AND go_live_confirmed_source IS NOT NULL AND mls_live_date_basis IS NOT NULL/.test(m796))

  // ── F · REGISTRATION ─────────────────────────────────────────────────────────────────────────
  console.log("\n[F · registration]")
  const pkg = read("package.json")
  check("package.json wires test:listing-offer-lifecycle", /"test:listing-offer-lifecycle":\s*"tsx scripts\/listing-offer-lifecycle-guard\.ts"/.test(pkg))
  check("the guard chain runs it (membership, never a position)", new RegExp("npm run test:listing-offer-lifecycle(\\s|&|$)").test(JSON.parse(pkg).scripts.guard ?? ""))
  check("a MAINTENANCE_DOMAINS entry owns it", /proof:\s*"test:listing-offer-lifecycle"/.test(code("lib/kernel/manager-registry.ts")))

  console.log("\nBLIND SPOTS: the writer runs on the in-memory client (no RLS, no CHECK) — the CHECK's truth is m783's text until the integrator applies it and regenerates")
  console.log("  scripts/check-vocabularies.ts; the Dotloop route records no terminal outcome (no such event in its handler); recordEnvelopeTerminalState and the two")
  console.log("  loops' stamps are proved structurally (server-only graph); the wizard is proved as text (no browser); the lifecycle core's dispatch half is stubbed here.")
  console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
