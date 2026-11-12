#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-promise-guard.ts   (run: tsx scripts/lead-magnet-promise-guard.ts — key to add: test:lead-magnet-promise)
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 146, LANE 146F — owner ruling 10 (2026-10-29: "The arbiter needs to make sure that any deliverables that were promised
 * from the lead magnet are delivered") and contract C4 (lib/lead-magnets/promised-deliverables.ts: recordPromisedDeliverable,
 * deliverPromised, undeliveredPromisesFor; the signal lead_magnet_promise_undelivered). In memory, no network, no provider:
 *
 *   A. WHAT WAS PROMISED — promisedAssetFor reads the magnet's offer (guide / book / report / an agent-prepared value; none for
 *      a subscription, an RSVP, a contact form); preparedAssetVerdict refuses a cover note as a guide, a missing book PDF, a
 *      report with no report document, a held compliance gate.
 *   B. THE PROMISE IS RECORDED ONCE — source form + campaign + attribution, recipient contact + person, asset, consent basis,
 *      due time; a retried capture of the same submission and a double post inside the window REUSE it; a UNIQUE race reuses
 *      the winner; no recipient → nothing promised.
 *   C. DELIVERED ONLY WITH THE ASSET, THROUGH A PERMITTED CHANNEL, VERIFIED — the governed email (ledger cycle per promise) and
 *      the secure portal card (only with a portal sign-in); evidence on the row; the timeline activity only after; a re-run
 *      sends nothing twice; a missing asset / refused send is asset_missing / failed with a back-off, never delivered.
 *   D. THE ARBITER'S MOMENT — overdue or out of attempts → ONE lead_magnet_promise_undelivered signal (campaign_orchestrator →
 *      ai_isa); undeliveredPromisesFor lists the open ones overdue-first; the human-fulfilled value escalates at its due time;
 *      the sweep retries due ones under each promise's own tenant and never starves on escalated ones.
 *   E. THE HUMAN DOOR — attestPromiseDelivered only with a hosted document of THIS contact in THIS tenant.
 *   F. WIRING (stripped source) — the capture records then delivers; "lead_magnet_delivered" is written by ONE recorder whose only
 *      callers are the ledger's; the cron drives the sweep; the panel's doors take the tenant from the session; m883 (either
 *      line-1 stamp) holds the ledger's vocabulary and shape.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  recordPromisedDeliverable, deliverPromised, undeliveredPromisesFor,
  sweepUndeliveredPromises, attestPromiseDelivered, LEAD_MAGNET_PROMISE_UNDELIVERED_SIGNAL, PROMISE_STATUSES, PROMISE_ASSET_KINDS,
  PROMISE_PORTAL_UPDATE_TYPE, type PromiseDeps, type PreparedAsset,
} from "../lib/lead-magnets/promised-deliverables"
import { finalizeForDistribution } from "../lib/marketing/humanize-final"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
const codeNoStrings = (p: string) => blankStrings(stripComments(raw(p)))
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)

const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2"
const FORM = "00000000-0000-4000-8000-00000000f001", SUB = "00000000-0000-4000-8000-000000005001", SUB2 = "00000000-0000-4000-8000-000000005002"
const C1 = "00000000-0000-4000-8000-0000000000c1", C2 = "00000000-0000-4000-8000-0000000000c2", AG = "00000000-0000-4000-8000-0000000000d1", U1 = "00000000-0000-4000-8000-0000000000a1"
const NOW = new Date("2026-10-29T12:00:00Z")
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000)
const PDF = "https://cdn.example.com/guides/buyer-guide.pdf"

const booklet: PreparedAsset = { deliverable: { subject: "Your home-buying guide is here", title: "The Complete Home-Buying Guide", body: "Here's your guide." }, pdfUrl: PDF, documentId: "doc-1", deliverableKind: "booklet" }
const coverNoteOnly: PreparedAsset = { deliverable: booklet.deliverable, pdfUrl: null, documentId: null, deliverableKind: "copy" }

function seed(extra: Record<string, any[]> = {}) {
  return memSupabase({
    lead_magnet_promises: [],
    lead_capture_forms: [{ id: FORM, brokerage_id: B1, agent_id: AG, magnet_type: "buyer_guide", name: "Buyer guide", is_active: true, settings: { lifecycle: { state: "published", approved_by: U1 } } }],
    contacts: [
      { id: C1, brokerage_id: B1, email: "rae@reader.test", first_name: "Rae", has_login: false, city: "Austin" },
      { id: C2, brokerage_id: B1, email: null, first_name: "Noemail", has_login: true, city: null },
    ],
    agents: [{ id: AG, brokerage_id: B1, user_id: U1 }],
    transparency_updates: [], activities: [], manager_signals: [], generated_documents: [],
    ...extra,
  }, { uuidIds: true, unique: { lead_magnet_promises: [["submission_id"]] } })
}

/** A deps bundle with every seam recording its calls. */
function harness(over: Partial<PromiseDeps> & { emailOk?: boolean; prepared?: PreparedAsset } = {}) {
  const calls = { emails: [] as any[], cards: [] as any[], signals: [] as any[], activities: [] as any[], prepares: 0 }
  const deps: PromiseDeps = {
    now: over.now ?? NOW,
    book: over.book === undefined ? null : over.book,
    // THE REAL C4 final phase (pure) with a fixed tenant brand — the brand resolver's I/O is the only seam.
    finalize: over.finalize ?? (async (a) => {
      const final = await finalizeForDistribution({ assetKind: "lead_magnet", text: a.text, tenantBrand: { tagline: "Calm advice, local roots", prohibitedWords: ["cheap"] } })
      const hard = [...final.fairHousing, ...final.brandVoice.prohibited]
      return hard.length ? { ok: false, reason: hard.join("; ") } : { ok: true, text: final.text }
    }),
    prepare: over.prepare ?? (async () => { calls.prepares++; return over.prepared ?? booklet }),
    sendEmail: over.sendEmail ?? (async (p) => { calls.emails.push(p); return over.emailOk === false ? { success: false, providerKey: "compliance_gate", error: "Outbound blocked: unsubscribed" } : { success: true, providerKey: "sendgrid", messageId: `msg-${calls.emails.length}` } }),
    pushPortal: over.pushPortal ?? (async (p, svc) => { calls.cards.push(p); const { data } = await (svc as any).from("transparency_updates").insert({ brokerage_id: p.brokerageId, contact_id: p.contactId, update_type: p.updateType, title: p.title, metadata: p.metadata, is_visible_to_client: true }).select("id").maybeSingle(); return { pushed: true, id: data?.id } }),
    publishSignal: over.publishSignal ?? (async (s) => { calls.signals.push(s); return { ok: true } }),
    recordActivity: over.recordActivity ?? (async (a) => { calls.activities.push(a); return { ok: true } }),
  }
  return { deps, calls }
}

async function main() {
  console.log("LEAD-MAGNET PROMISE GUARD — wave 146, lane 146F (ruling 10, contract C4)")

  section("A · what was promised, and what fulfils it (through the public API — the rules are module-private)")
  /** Record a fresh request for `magnetType` and attempt it once with `prepared`; the resulting row. */
  const attempt = async (magnetType: string, prepared: PreparedAsset, book: { pdfUrl: string; documentId: string | null; title: string; chapters: number } | null = null) => {
    const mem = seed()
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType, book, now: NOW })
    if (!rec.ok || !rec.promised) return { rec, row: null as any, emails: 0 }
    const h = harness({ prepared, book })
    await deliverPromised(mem, { brokerageId: B1, promiseId: rec.promiseId }, h.deps)
    return { rec, row: mem.tables.lead_magnet_promises[0], emails: h.calls.emails.length }
  }
  const BOOK = { pdfUrl: PDF, documentId: null, title: "The Book", chapters: 4 }
  const kind = async (t: string, book: typeof BOOK | null = null) => (await attempt(t, booklet, book)).row?.asset_kind ?? null
  check("a buyer / seller guide promises a GUIDE; with a finished book it promises the BOOK", (await kind("buyer_guide")) === "guide" && (await kind("seller_guide")) === "guide" && (await kind("buyer_guide", BOOK)) === "book")
  const val = await attempt("home_valuation", booklet)
  check("a market report promises a REPORT; a home-value tool promises an agent-prepared value (a PERSON fulfils it — the system sends nothing)", (await kind("market_report")) === "report" && val.row?.asset_kind === "valuation" && val.row?.fulfilment === "human" && val.emails === 0)
  const none = await Promise.all(["listing_alert", "open_house", "generic_form", "nonsense"].map(async (t) => (await attempt(t, booklet)).rec))
  check("a listing alert, an open-house RSVP, a contact form and an unknown type promise no asset", none.every((r) => r.ok && !r.promised))
  check("every asset kind the capture can promise is in the m883 CHECK list", (await Promise.all(["buyer_guide", "market_report", "home_valuation"].map((t) => kind(t)))).concat(await kind("buyer_guide", BOOK)).every((k) => (PROMISE_ASSET_KINDS as readonly string[]).includes(String(k))))
  const vGuide = await attempt("buyer_guide", booklet)
  check("a rendered booklet FULFILS a guide promise (hosted https file, document id kept)", vGuide.row?.status === "delivered" && vGuide.row?.evidence?.asset_url === PDF && vGuide.row?.evidence?.document_id === "doc-1")
  const vCover = await attempt("buyer_guide", coverNoteOnly)
  check("POSITIVE CONTROL — the cover note alone is NOT the guide (the old runner called this 'delivered')", vCover.row?.status === "asset_missing" && /cover note/.test(vCover.row?.last_error ?? "") && vCover.emails === 0)
  check("a book promise needs the BOOK's hosted PDF — the booklet is not the book", (await attempt("buyer_guide", booklet, BOOK)).row?.status === "asset_missing" && (await attempt("buyer_guide", { ...booklet, deliverableKind: "book" }, BOOK)).row?.status === "delivered")
  const vReport = await attempt("market_report", coverNoteOnly)
  check("a report promise with no report document is MISSING (no producer exists — said, never faked)", vReport.row?.status === "asset_missing" && /report/.test(vReport.row?.last_error ?? "") && vReport.emails === 0)
  const vHeld = await attempt("buyer_guide", { deliverable: null, pdfUrl: null, documentId: null, deliverableKind: "copy", heldReason: "Fair Housing: steering" })
  check("a held compliance gate (no deliverable) is missing with the gate's reason", vHeld.row?.status === "asset_missing" && /steering/.test(vHeld.row?.last_error ?? ""))
  check("a non-https asset url is not a hosted file", (await attempt("buyer_guide", { ...booklet, pdfUrl: "javascript:alert(1)" })).row?.status === "asset_missing")
  check("back-off: a first failed attempt waits 5 min (attempt 5 — exhausted — has none: section D)", vCover.row?.next_attempt_at === at(5).toISOString())

  section("B · the promise is recorded once per request")
  {
    const mem = seed()
    const r1 = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, personId: null, campaignId: "camp-1", attribution: { utmSource: "fb" }, magnetType: "buyer_guide", tcpaConsentGiven: true, now: NOW })
    const row = mem.tables.lead_magnet_promises[0]
    check("the capture records ONE promise with source form + campaign + attribution, recipient, asset, consent basis, due time", r1.ok && r1.promised && !r1.reused && mem.tables.lead_magnet_promises.length === 1
      && row.form_id === FORM && row.submission_id === SUB && row.campaign_id === "camp-1" && row.attribution?.utmSource === "fb" && row.contact_id === C1
      && row.asset_kind === "guide" && row.consent_basis === "requested_with_tcpa_consent" && row.status === "promised" && row.due_at === at(15).toISOString(), JSON.stringify(row))
    const r2 = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    check("a retried capture of the SAME submission reuses the promise (no second row)", r2.ok && r2.promised && r2.reused && mem.tables.lead_magnet_promises.length === 1)
    const r3 = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB2, contactId: C1, magnetType: "buyer_guide", now: at(1) })
    check("a DOUBLE POST (a second submission, same person, same magnet, inside the window) is ONE request — reused", r3.ok && r3.promised && r3.reused && mem.tables.lead_magnet_promises.length === 1)
    const r4 = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: "00000000-0000-4000-8000-000000005003", contactId: C1, magnetType: "buyer_guide", now: at(25 * 60) })
    check("…outside the window it is a NEW request and a new promise", r4.ok && r4.promised && !r4.reused && mem.tables.lead_magnet_promises.length === 2)
    const none = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: "00000000-0000-4000-8000-000000005004", contactId: null, magnetType: "buyer_guide", now: NOW })
    check("no recipient identity (no email or phone) → nothing promised, nothing written", none.ok && !none.promised && mem.tables.lead_magnet_promises.length === 2)
    const rsvp = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: "00000000-0000-4000-8000-000000005005", contactId: C1, magnetType: "open_house", now: NOW })
    check("an RSVP promises no asset → no promise row", rsvp.ok && !rsvp.promised && mem.tables.lead_magnet_promises.length === 2)
    const val = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: "00000000-0000-4000-8000-00000000f002", submissionId: "00000000-0000-4000-8000-000000005006", contactId: C1, magnetType: "home_valuation", now: NOW })
    const valRow = mem.tables.lead_magnet_promises.find((p: any) => p.id === (val as any).promiseId)
    check("a home-value request records a HUMAN-fulfilled promise, awaiting_human, due in a day", val.ok && val.promised && valRow?.fulfilment === "human" && valRow?.status === "awaiting_human" && valRow?.due_at === at(24 * 60).toISOString())
  }
  {
    const mem = seed({ lead_magnet_promises: [{ id: "p-winner", brokerage_id: B1, form_id: FORM, submission_id: SUB, contact_id: C1, status: "promised", created_at: at(-60 * 48).toISOString() }] })
    // THE RACE: the first by-submission read sees nothing (the winner had not committed yet), so the insert meets the UNIQUE
    // constraint (23505) — the writer must re-read and reuse the winner, never fail the capture.
    const orig = (mem as any).from.bind(mem) as (t: string) => any
    let reads = 0
    ;(mem as any).from = (t: string) => {
      const b = orig(t)
      if (t !== "lead_magnet_promises") return b
      const sel = b.select.bind(b) as (c?: string) => any
      b.select = (c?: string) => { if (c === "id, status" && reads++ === 0) { const q = sel(c); q.maybeSingle = async () => ({ data: null, error: null }); return q } return sel(c) }
      return b
    }
    const race = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C2, magnetType: "buyer_guide", now: NOW })
    check("a concurrent capture that loses the UNIQUE(submission_id) race (23505) reuses the WINNER's promise", race.ok && race.promised && race.reused && race.promiseId === "p-winner" && mem.tables.lead_magnet_promises.length === 1, JSON.stringify(race))
  }
  {
    const mem = memSupabase({}, { refuse: { lead_magnet_promises: "permission denied" } })
    const r = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    check("a refused ledger read is an ERROR, never 'nothing promised'", !r.ok && /refused/.test((r as { error: string }).error))
  }

  section("C · delivered only with the asset, through a permitted channel, verified")
  {
    const mem = seed()
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, campaignId: "camp-c", attribution: { utmSource: "ig" }, magnetType: "buyer_guide", now: NOW })
    const id = (rec as { promiseId: string }).promiseId
    const h = harness()
    const d1 = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h.deps)
    const row = mem.tables.lead_magnet_promises[0]
    // wave 146 (146Z): campaign_id + attribution were written and never read (readerless-write census) — the FINAL EVIDENCE now
    // carries the promise's source (ruling 10). Control: a promise recorded without a campaign says null, never a borrowed one.
    check("the FINAL EVIDENCE names the promise's source — form, submission, campaign and attribution as the capture recorded them (ruling 10)",
      (row.evidence?.source as { form_id?: string; submission_id?: string; campaign_id?: string | null; attribution?: { utmSource?: string } } | undefined)?.campaign_id === "camp-c"
      && row.evidence?.source?.attribution?.utmSource === "ig" && row.evidence?.source?.form_id === FORM && row.evidence?.source?.submission_id === SUB, JSON.stringify(row.evidence?.source ?? null))
    {
      const memN = seed()
      const recN = await recordPromisedDeliverable(memN, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
      await deliverPromised(memN, { brokerageId: B1, promiseId: (recN as { promiseId: string }).promiseId }, harness().deps)
      const rowN = memN.tables.lead_magnet_promises[0]
      check("  CONTROL: with no campaign recorded the evidence's campaign is null (the reader never invents provenance)", rowN.status === "delivered" && rowN.evidence?.source?.campaign_id === null, JSON.stringify(rowN.evidence?.source ?? null))
    }
    check("the guide goes out by the GOVERNED email (transactional reply to their request; ledger cycle per promise) and the row is DELIVERED with evidence", d1.ok && d1.status === "delivered" && h.calls.emails.length === 1
      && h.calls.emails[0].ledger.cycle === `lead_magnet_promise:${id}` && h.calls.emails[0].ledger.reasonCode === "CONVERSATION_RESPONSE" && h.calls.emails[0].channelPurpose === "transactional"
      && h.calls.emails[0].contactId === C1 && h.calls.emails[0].userId === U1 && h.calls.emails[0].agentId === AG && h.calls.emails[0].html.includes(PDF)
      && row.status === "delivered" && row.delivered_via === "email" && row.evidence?.asset_url === PDF && row.evidence?.email?.message_id === "msg-1" && row.evidence?.approved_by === U1 && row.attempts === 1, JSON.stringify({ d1, row }))
    check("…the timeline activity ('lead_magnet_delivered') is recorded only NOW, once, carrying the promise + the asset refs", h.calls.activities.length === 1 && h.calls.activities[0].refs.promise_id === id && h.calls.activities[0].refs.pdf_url === PDF && h.calls.activities[0].refs.delivered_via === "email")
    const d2 = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h.deps)
    check("a re-run (the sweep, a retry click) REPLAYS the evidence — no second email, no second activity, no second prepare", d2.ok && d2.status === "delivered" && (d2 as { reused: boolean }).reused && h.calls.emails.length === 1 && h.calls.activities.length === 1 && h.calls.prepares === 1)
    const foreign = await deliverPromised(mem, { brokerageId: B2, promiseId: id }, harness().deps)
    check("another tenant cannot touch the promise (tenant-pinned read)", !foreign.ok && /not found/.test((foreign as { error: string }).error))
  }
  {
    const mem = seed()
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    const id = (rec as { promiseId: string }).promiseId
    const h = harness({ prepared: coverNoteOnly })
    const d = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h.deps)
    const row = mem.tables.lead_magnet_promises[0]
    check("NEVER DELIVERED WITHOUT THE ASSET: the booklet did not render → asset_missing, NO email, NO activity, a back-off retry", d.ok && d.status === "asset_missing" && h.calls.emails.length === 0 && h.calls.activities.length === 0
      && row.status === "asset_missing" && /cover note/.test(row.last_error ?? "") && row.next_attempt_at === at(5).toISOString() && !row.delivered_at, JSON.stringify(row))
    check("…not yet overdue → no signal yet", h.calls.signals.length === 0)
    const early = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, harness({ now: at(2) }).deps)
    check("…a retry before its back-off is refused (not claimed, attempts unchanged)", early.ok && early.status === "asset_missing" && /next attempt not before/.test((early as { reason: string }).reason) && mem.tables.lead_magnet_promises[0].attempts === 1)
    const h2 = harness({ now: at(16) })
    const late = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h2.deps)
    check("…the retry after the due time succeeds once the guide renders — delivered, attempt 2", late.ok && late.status === "delivered" && mem.tables.lead_magnet_promises[0].attempts === 2 && h2.calls.emails.length === 1)
  }
  {
    const mem = seed()
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    const h = harness({ prepared: { ...booklet, deliverable: { ...booklet.deliverable!, body: "In today's ever-evolving market, let's delve into your next steps. Here's your guide." } } })
    await deliverPromised(mem, { brokerageId: B1, promiseId: (rec as { promiseId: string }).promiseId }, h.deps)
    check("HUMANIZATION PRESERVED: the AI cover note passes the C4 final phase before it is sent — the stock phrasing gone, the substance kept (the tagline follows the lead_magnet kind's own profile)", h.calls.emails.length === 1 && !/ever-evolving|delve/.test(h.calls.emails[0].text) && /next steps/.test(h.calls.emails[0].text) && /Here's your guide/.test(h.calls.emails[0].text), h.calls.emails[0]?.text)
    const mem2 = seed()
    const rec2 = await recordPromisedDeliverable(mem2, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    const h2 = harness({ prepared: { ...booklet, deliverable: { ...booklet.deliverable!, body: "Here's your guide to a cheap first home." } } })
    const held = await deliverPromised(mem2, { brokerageId: B1, promiseId: (rec2 as { promiseId: string }).promiseId }, h2.deps)
    check("…a word the brand PROHIBITS holds the delivery (no email; the reason recorded; retried / escalated like any missing asset)", held.ok && held.status === "asset_missing" && h2.calls.emails.length === 0 && /final phase/.test(mem2.tables.lead_magnet_promises[0].last_error ?? ""))
  }
  {
    const mem = seed()
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    const id = (rec as { promiseId: string }).promiseId
    const h = harness({ emailOk: false })
    const d = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h.deps)
    check("a REFUSED send (unsubscribed / compliance) with no portal sign-in → failed with the refusal, never delivered", d.ok && d.status === "failed" && /unsubscribed/.test(mem.tables.lead_magnet_promises[0].last_error ?? "") && h.calls.activities.length === 0 && !mem.tables.lead_magnet_promises[0].delivered_at)
  }
  {
    const mem = seed({ lead_capture_forms: [{ id: FORM, brokerage_id: B1, agent_id: AG, magnet_type: "buyer_guide", is_active: true, settings: {} }] })
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C2, magnetType: "buyer_guide", now: NOW })
    const id = (rec as { promiseId: string }).promiseId
    const h = harness()
    const d = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h.deps)
    const card = mem.tables.transparency_updates[0]
    check("the SECURE PORTAL is a channel: a contact with a portal sign-in and no email gets ONE portal card carrying the asset", d.ok && d.status === "delivered" && (d as { via: string }).via === "portal" && h.calls.emails.length === 0
      && mem.tables.transparency_updates.length === 1 && card.update_type === PROMISE_PORTAL_UPDATE_TYPE && card.contact_id === C2 && card.metadata?.lead_magnet_promise_id === id && card.metadata?.asset_url === PDF, JSON.stringify(d))
    check("…the evidence names the card; the approval basis says the magnet had no recorded publisher (said, not hidden)", mem.tables.lead_magnet_promises[0].evidence?.portal?.card_id === card.id && mem.tables.lead_magnet_promises[0].evidence?.approval_basis === "live_magnet_without_recorded_publisher")
  }
  {
    const mem = seed({ contacts: [{ id: C1, brokerage_id: B1, email: null, first_name: "Nobody", has_login: false }] })
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    const d = await deliverPromised(mem, { brokerageId: B1, promiseId: (rec as { promiseId: string }).promiseId }, harness().deps)
    check("POSITIVE CONTROL — no email and no portal sign-in: no permitted channel → failed, never delivered", d.ok && d.status === "failed" && /no email/.test(mem.tables.lead_magnet_promises[0].last_error ?? ""))
  }

  section("D · the arbiter's moment — overdue or out of attempts → ONE signal")
  {
    const mem = seed()
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: FORM, submissionId: SUB, contactId: C1, magnetType: "buyer_guide", now: NOW })
    const id = (rec as { promiseId: string }).promiseId
    const sig: any[] = []
    const missing = (now: Date) => harness({ now, prepared: coverNoteOnly, publishSignal: async (s) => { sig.push(s); return { ok: true } } }).deps
    await deliverPromised(mem, { brokerageId: B1, promiseId: id }, missing(NOW))
    await deliverPromised(mem, { brokerageId: B1, promiseId: id }, missing(at(20)))
    check("an OVERDUE undelivered promise raises lead_magnet_promise_undelivered ONCE, campaign_orchestrator → ai_isa, high priority, on the promise", sig.length === 1 && sig[0].signalType === LEAD_MAGNET_PROMISE_UNDELIVERED_SIGNAL && LEAD_MAGNET_PROMISE_UNDELIVERED_SIGNAL === "lead_magnet_promise_undelivered"
      && sig[0].fromManager === "campaign_orchestrator" && sig[0].toManager === "ai_isa" && sig[0].entityType === "lead_magnet_promise" && sig[0].entityId === id && sig[0].contactId === C1 && sig[0].payload.priority === "high" && !!mem.tables.lead_magnet_promises[0].escalated_at, JSON.stringify(sig))
    for (const m of [60 + 20, 300, 600, 1400]) await deliverPromised(mem, { brokerageId: B1, promiseId: id }, missing(at(m)))
    const row = mem.tables.lead_magnet_promises[0]
    check("…attempts are bounded: after 5 the promise is FAILED with no further attempt, and the signal is still ONE", row.attempts === 5 && row.status === "failed" && row.next_attempt_at === null && sig.length === 1, JSON.stringify({ attempts: row.attempts, status: row.status, signals: sig.length }))
    const list = await undeliveredPromisesFor(mem, { brokerageId: B1, now: at(1500) })
    check("undeliveredPromisesFor lists it (overdue, escalated, the last failure) for the arbiter and the panel", !list.error && list.promises.length === 1 && list.promises[0].promiseId === id && list.promises[0].overdue && list.promises[0].escalated && /cover note/.test(list.promises[0].lastError ?? ""))
    const byContact = await undeliveredPromisesFor(mem, { brokerageId: B1, contactId: C2, now: at(1500) })
    check("…asked about ONE person it lists only theirs; another tenant sees none", byContact.promises.length === 0 && (await undeliveredPromisesFor(mem, { brokerageId: B2, now: at(1500) })).promises.length === 0)
    const refused = await undeliveredPromisesFor(memSupabase({}, { refuse: { lead_magnet_promises: "RLS" } }), { brokerageId: B1 })
    check("a refused read is an ERROR, never an empty list", !!refused.error)
  }
  {
    const mem = seed()
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: "00000000-0000-4000-8000-00000000f002", submissionId: SUB, contactId: C1, magnetType: "home_valuation", now: NOW })
    const id = (rec as { promiseId: string }).promiseId
    const h1 = harness({ now: at(60) })
    const notYet = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h1.deps)
    const h2 = harness({ now: at(25 * 60) })
    const overdue = await deliverPromised(mem, { brokerageId: B1, promiseId: id }, h2.deps)
    check("an agent-prepared value is never faked by the system: awaiting_human, no email, no prepare — and escalated at its due time", notYet.ok && notYet.status === "awaiting_human" && h1.calls.signals.length === 0 && h1.calls.emails.length === 0 && h1.calls.prepares === 0
      && overdue.ok && overdue.status === "awaiting_human" && (overdue as { escalated: boolean }).escalated && h2.calls.signals.length === 1)
  }
  {
    // THE SWEEP — due ones retried under their OWN tenant; escalated ones with no retry left do not hold a slot.
    const mem = seed({
      lead_capture_forms: [
        { id: FORM, brokerage_id: B1, agent_id: AG, magnet_type: "buyer_guide", is_active: true, settings: {} },
        { id: "00000000-0000-4000-8000-00000000f0b2", brokerage_id: B2, agent_id: null, magnet_type: "seller_guide", is_active: true, settings: {} },
      ],
      contacts: [
        { id: C1, brokerage_id: B1, email: "rae@reader.test", first_name: "Rae", has_login: false },
        { id: C2, brokerage_id: B2, email: "sam@b2.test", first_name: "Sam", has_login: false },
      ],
      lead_magnet_promises: [
        { id: "p-due-b1", brokerage_id: B1, form_id: FORM, contact_id: C1, magnet_type: "buyer_guide", asset_kind: "guide", fulfilment: "system", status: "asset_missing", attempts: 1, due_at: at(-30).toISOString(), next_attempt_at: at(-10).toISOString(), escalated_at: null, created_at: at(-45).toISOString() },
        { id: "p-due-b2", brokerage_id: B2, form_id: "00000000-0000-4000-8000-00000000f0b2", contact_id: C2, magnet_type: "seller_guide", asset_kind: "guide", fulfilment: "system", status: "promised", attempts: 0, due_at: at(-5).toISOString(), next_attempt_at: null, escalated_at: null, created_at: at(-20).toISOString() },
        { id: "p-dead", brokerage_id: B1, form_id: FORM, contact_id: C1, magnet_type: "buyer_guide", asset_kind: "guide", fulfilment: "system", status: "failed", attempts: 5, due_at: at(-3000).toISOString(), next_attempt_at: null, escalated_at: at(-2000).toISOString(), created_at: at(-3100).toISOString() },
        { id: "p-later", brokerage_id: B1, form_id: FORM, contact_id: C1, magnet_type: "buyer_guide", asset_kind: "guide", fulfilment: "system", status: "promised", attempts: 0, due_at: at(10).toISOString(), next_attempt_at: null, escalated_at: null, created_at: at(-1).toISOString() },
      ],
    })
    const h = harness()
    const sw = await sweepUndeliveredPromises(mem, { now: NOW, deps: h.deps })
    const st = (id: string) => mem.tables.lead_magnet_promises.find((p: any) => p.id === id)?.status
    check("the sweep delivers every DUE promise across tenants, each under its own brokerage (B1 + B2 emails to their own contacts)", sw.delivered === 2 && st("p-due-b1") === "delivered" && st("p-due-b2") === "delivered" && h.calls.emails.some((e) => e.brokerageId === B1 && e.contactId === C1) && h.calls.emails.some((e) => e.brokerageId === B2 && e.contactId === C2), JSON.stringify(sw))
    check("…a promise not yet due is left for its due time; an escalated one with no retry left holds no slot", st("p-later") === "promised" && sw.examined === 2 && st("p-dead") === "failed")
  }

  section("E · the human door — delivered only with the document")
  {
    const mem = seed({ generated_documents: [
      { id: "doc-cma", brokerage_id: B1, contact_id: C1, document_type: "cma", blob_url: "https://cdn.example.com/cma.pdf", file_name: "cma.pdf" },
      { id: "doc-other", brokerage_id: B1, contact_id: C2, document_type: "cma", blob_url: "https://cdn.example.com/other.pdf" },
      { id: "doc-nofile", brokerage_id: B1, contact_id: C1, document_type: "cma", blob_url: null },
      { id: "doc-b2", brokerage_id: B2, contact_id: C1, document_type: "cma", blob_url: "https://cdn.example.com/b2.pdf" },
    ] })
    const rec = await recordPromisedDeliverable(mem, { brokerageId: B1, formId: "00000000-0000-4000-8000-00000000f002", submissionId: SUB, contactId: C1, magnetType: "home_valuation", now: NOW })
    const id = (rec as { promiseId: string }).promiseId
    const h = harness()
    const other = await attestPromiseDelivered(mem, { brokerageId: B1, promiseId: id, actorUserId: U1, documentId: "doc-other", now: NOW }, h.deps)
    const nofile = await attestPromiseDelivered(mem, { brokerageId: B1, promiseId: id, actorUserId: U1, documentId: "doc-nofile", now: NOW }, h.deps)
    const foreign = await attestPromiseDelivered(mem, { brokerageId: B1, promiseId: id, actorUserId: U1, documentId: "doc-b2", now: NOW }, h.deps)
    check("an attestation is REFUSED with another contact's document, a document with no file, or another tenant's document", !other.ok && !nofile.ok && !foreign.ok && mem.tables.lead_magnet_promises[0].status === "awaiting_human" && h.calls.activities.length === 0)
    const ok = await attestPromiseDelivered(mem, { brokerageId: B1, promiseId: id, actorUserId: U1, documentId: "doc-cma", now: NOW }, h.deps)
    const row = mem.tables.lead_magnet_promises[0]
    check("…with THIS contact's hosted CMA it is delivered (human_attested, the document + the attesting user as evidence, the timeline line)", ok.ok && row.status === "delivered" && row.delivered_via === "human_attested" && row.evidence?.asset_url === "https://cdn.example.com/cma.pdf" && row.evidence?.attested_by === U1 && h.calls.activities.length === 1)
  }

  section("F · wiring (stripped source) and the migration")
  const kernel = code("lib/kernel/lead-magnets.ts")
  const iRec = kernel.indexOf("recordPromisedDeliverable(supabase"), iDel = kernel.indexOf("deliverPromised(supabase")
  check("the capture RECORDS the promise (form, submission, contact, person, verified campaign) and THEN delivers it", iRec > 0 && iDel > iRec && /submissionId:\s*submission\.id/.test(kernel.slice(iRec, iDel)) && /personId/.test(kernel.slice(iRec, iDel)) && /campaignId:\s*verifiedCampaignId/.test(kernel.slice(iRec, iDel)))
  check("the capture no longer calls the one-step deliverMagnet (prepare ≠ deliver)", !/\bdeliverMagnet\s*\(/.test(kernel))
  const runner = codeNoStrings("lib/marketing/lead-magnet-delivery-runner.ts")
  const prep = runner.slice(runner.indexOf("export async function prepareMagnetDelivery"))
  check("the runner's PREPARE writes nothing (no insert in prepareMagnetDelivery); its one recorder is recordMagnetDelivery", prep.length > 100 && !/\.insert\(/.test(prep) && /export async function recordMagnetDelivery/.test(runner))
  // census: who may write the 'lead_magnet_delivered' activity, and who calls the recorder
  const files = walk(join(ROOT, "lib")).concat(walk(join(ROOT, "app"))).filter((f) => /\.(ts|tsx)$/.test(f))
  const writers = files.filter((f) => /activity_type:\s*"lead_magnet_delivered"/.test(stripComments(readFileSync(f, "utf8")))).map((f) => f.slice(ROOT.length + 1))
  check("ONE writer of the 'lead_magnet_delivered' activity (the runner's recorder)", writers.length === 1 && writers[0] === "lib/marketing/lead-magnet-delivery-runner.ts", JSON.stringify(writers))
  const recorderCallers = files.filter((f) => !f.endsWith("lead-magnet-delivery-runner.ts") && /\brecordMagnetDelivery\s*\(/.test(stripComments(readFileSync(f, "utf8")))).map((f) => f.slice(ROOT.length + 1))
  check("…called only by the promise ledger (after a verified delivery / an attestation)", recorderCallers.length === 1 && recorderCallers[0] === "lib/lead-magnets/promised-deliverables.ts", JSON.stringify(recorderCallers))
  check("CONTROL: the writer finder sees a planted writer and the comment stripper hides a commented one", /activity_type:\s*"lead_magnet_delivered"/.test('x.insert({ activity_type: "lead_magnet_delivered" })') && !/activity_type:\s*"lead_magnet_delivered"/.test(stripComments('// activity_type: "lead_magnet_delivered"')))
  check("the retry driver: the marketing scheduler cron runs sweepUndeliveredPromises", /sweepUndeliveredPromises\(svc\)/.test(code("app/api/cron/marketing-campaign-scheduler/route.ts")))
  const actions = code("app/actions/lead-magnets-actions.ts")
  check("the panel's doors take the tenant from the SESSION and pass it to the lib (never a body id)", /export async function retryPromisedDeliveryAction\(promiseId: string\)/.test(actions) && /export async function attestPromiseDeliveredAction\(promiseId: string, documentId: string\)/.test(actions)
    && /deliverPromised\(createServiceClient\(\), \{ brokerageId: scope\.brokerageId/.test(actions) && /actorUserId: scope\.userId/.test(actions))
  check("the Promises panel is mounted on the Lead Magnets workspace", /<PromisesPanel \/>/.test(code("app/dashboard/marketing/lead-magnets/page.tsx")))
  const mig = raw("supabase/migrations/m883-lead-magnet-promises-promised-deliverable-ledger.sql")
  const line1 = mig.split("\n")[0]
  check("m883 line 1 is the lane stamp OR the applied stamp (the rule, not the waypoint)", line1.startsWith("-- WRITTEN, NOT APPLIED (wave 146, lane 146F)") || line1.startsWith("-- ── APPLIED LIVE "))
  const checkList = (name: string) => (new RegExp(`${name}\\s+CHECK \\((?:[a-z_]+ IS NULL OR )?[a-z_]+ IN \\(([^)]*)\\)\\)`).exec(mig)?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean)
  const statusCheck = checkList("lead_magnet_promises_status_check"), kindCheck = checkList("lead_magnet_promises_asset_kind_check")
  check("m883's status CHECK equals the code's PROMISE_STATUSES; its asset_kind CHECK equals PROMISE_ASSET_KINDS", statusCheck.length > 0 && statusCheck.join() === [...PROMISE_STATUSES].join() && kindCheck.join() === [...PROMISE_ASSET_KINDS].join(), JSON.stringify({ statusCheck, kindCheck }))
  check("m883: ONE promise per request (UNIQUE submission_id), 'delivered' carries its evidence, RLS on with service-only writes", /UNIQUE \(submission_id\)/.test(mig) && /status <> 'delivered' OR \(delivered_at IS NOT NULL AND delivered_via IS NOT NULL AND evidence \? 'asset_url'\)/.test(mig) && /ENABLE ROW LEVEL SECURITY/.test(mig) && /REVOKE INSERT, UPDATE, DELETE ON public\.lead_magnet_promises FROM authenticated, anon/.test(mig))

  console.log("\nBLIND SPOTS (published):")
  for (const b of [
    "the dispatcher, the portal writer, the signal bus and the runner's preparation are SEAMS here — their own gates are proven by their own proofs (egress, portal-value, signal-integrity, autonomous-marketing); this proof proves the ledger's decisions over them",
    "wave 147 (147E): the market-report producer exists (lib/market-reports/producer.ts) and runs when the magnet is CREATED (C11) — a report promise made against a ready deliverable delivers that report (proven by test:lead-magnet-asset-invariant / test:market-report-producer); THIS proof still drives the legacy runner path, where a report with no document stays MISSING",
    "'verified' means the provider ACCEPTED the email (message id) or the portal card row exists; a bounce later is reconciled on outcome_reconciliations by the SendGrid events webhook (lane 145D), not on this row",
    "the signal name is registered by lane 146D (lib/kernel/signal-registry.ts); until it lands test:signal-integrity reports the published type as uncatalogued",
  ]) console.log(`   · ${b}`)
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(`\n✗ LEAD_MAGNET_PROMISE_FAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`); process.exit(1) }
  console.log("✅ LEAD_MAGNET_PROMISE_PASS — every promised guide / book / report is recorded once, delivered only with its asset through a permitted channel, retried, and raised to the arbiter when it is not")
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
