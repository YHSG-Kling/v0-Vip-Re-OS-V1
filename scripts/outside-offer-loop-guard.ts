#!/usr/bin/env tsx
/**
 * scripts/outside-offer-loop-guard.ts   (npm run test:outside-offer-loop — registration in the lane notes)
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Wave 143, lane 143A — OFFERS ON OUTSIDE LISTINGS, EMAIL INGESTION, CONTRACT PRECEDENCE.
 * Owner (verbatim, wave 143): "An offer is created in the platform and emailed to the OUTSIDE listing agent; the outside seller
 * accepts, counters or declines. A counter comes back by email … to the in-house buyer agent; the buyer accepts, counters back or
 * declines. A counter-back is created in the platform and ONLY the counter is sent to the outside listing agent … The platform
 * WATCHES for the email responses, uploads them into the platform and notifies the offer recipients." · "a counter supersedes the
 * contract terms."
 *
 * Proves, as RULES (never waypoints), the whole loop on the in-memory client with the model, the egress and the vendor lookups
 * injected — nothing reaches a network:
 *   A. THE RULES, PURE — reference token · message identity · sender authentication (an aligned pass only) · the deterministic
 *      floor · THE AMBIGUITY RULE (an acceptance needs the model, the plain words AND a signed contract; the floor can only LOWER) ·
 *      the chain (root/head) · target selection · the outbound decision (a counter-back sends ONLY the counter) · the email.
 *   B. THE INBOUND HALF, LIVE — tryRouteOutboundOfferReply: matched by token / thread / sender; a redelivery is a no-op; a failed
 *      sender is quarantined; ambiguity is told, not guessed; NOTHING is accepted, signed or created.
 *   C. THE AGENT'S DOORS, LIVE — sendOutsideOffer (verified recipient, secure links, governed egress, human-approved, ledgered, watch
 *      armed) · createOutsideCounterBack (a NEW versioned row) · confirmOutsideReply (a person turns a reading into a recorded
 *      response through the survivors; an unsigned "acceptance" is refused; an unverified sender needs acknowledgement).
 *   D. CONTRACT PRECEDENCE — resolveGoverningTerms (executed counter/addendum supersedes; proposed never governs; originals kept;
 *      conflicts reported; a strike governs as null) and governingContractTerms LIVE on a chain + the frozen snapshot.
 *   E. WIRING + MIGRATIONS — source scans (stripped; every absence has its positive control) and m797/m798 vs the code's vocabularies.
 *   F. THE GOVERNING PACKET (wave 144, lane 144C — owner ruling 2): the two readings of "executed" agree; the ACCEPTED sequence
 *      (original + accepted counter) is the contract, a rejected counter and a later unsigned draft are kept and never terms; a
 *      later execution / two executed branches / a second transaction are refused by name; the ONE packet reader; BOTH instruments
 *      (+ executed addenda) are scanned by the checkpoint and the creation gate; closing compliance incorporates only the sequence.
 * BLIND SPOTS are printed beside the result (CLAUDE.md §2).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))
/** The reference token as a reply carries it. The lib mints it privately (buildOutsideEmail); section A proves this spelling EQUALS the minted one. */
const tokenOf = (offerId: string) => `[ref:offer:${offerId}]`

// ── THE WORLD: server-only stubbed; every vendor / session / survivor the loop reaches replaced by a recorder ──────────────────
const G = globalThis as any
G.__143A = {
  db: null as any,
  caller: null as any,
  dispatched: [] as any[], dispatchResult: { success: true, providerKey: "stub", messageId: "<out-1@mail.example>" } as any,
  mls: { ok: true, agentEmails: [] as string[] } as any,
  sellerResponses: [] as any[], sellerCounters: [] as any[], counterResponses: [] as any[], issued: [] as any[],
  inboundProvider: null as any, events: [] as any[], uploads: [] as any[],
}
const STUBS: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__143A.db",
  "@/lib/auth/require-caller": "export const requireCaller = async () => globalThis.__143A.caller",
  "@/lib/events/lifecycle-event-core": "export const recordLifecycleEvent = async (svc, brokerageId, input) => { globalThis.__143A.events.push({ brokerageId, input }); return { ok: true, eventId: 'e' + globalThis.__143A.events.length, deduped: false } }",
  "@/lib/providers/dispatch": "export const dispatchEmail = async (p) => { globalThis.__143A.dispatched.push(p); const n = globalThis.__143A.dispatched.length; const r = globalThis.__143A.dispatchResult; return r.messageId && n > 1 ? { ...r, messageId: r.messageId.replace('@', '-' + n + '@') } : r }",
  "@/lib/storage/signed-doc-url": "export const signedDocUrl = async (c, bucket, path, ttl) => 'https://signed.example/' + bucket + '/' + path + '?ttl=' + ttl",
  "@/lib/storage/put-and-sign": "export const putAndSign = async (c, p) => ({ ok: true, signedUrl: 'https://x.supabase.co/storage/v1/object/sign/' + p.bucket + '/' + p.path + '?token=t', path: p.path }); export const removeOrRecordOrphan = async () => ({ orphanRemoved: true })",
  "@/lib/documents/upload-document": "export const uploadDocument = async (p) => { const id = 'doc-' + (globalThis.__143A.uploads.length + 1); globalThis.__143A.uploads.push({ id, ...p }); globalThis.__143A.db.tables.documents.push({ id, brokerage_id: p.brokerageId, storage_url: p.storageUrl, metadata: { file_name: p.fileName, linked_offer_id: p.offerId ?? null, ...(p.metadata ?? {}) }, signature_completeness: null }); return { success: true, documentId: id } }",
  "@/lib/property/rentcast": "export const searchRentcastSaleListings = async () => globalThis.__143A.mls.ok ? { success: true, listings: globalThis.__143A.mls.agentEmails.map((e) => ({ listingAgent: { email: e }, listingOffice: null, mlsNumber: 'M1' })) } : { success: false, listings: [], error: globalThis.__143A.mls.reason }",
  "@/lib/kernel/offers": "export const issueCounterOffer = async (p, client) => { const parent = globalThis.__143A.db.tables.offers.find((o) => o.id === p.offerId); const id = globalThis.crypto.randomUUID(); const row = { id, brokerage_id: p.brokerageId, parent_offer_id: p.offerId, offer_type: 'counter', current_round: (parent.current_round ?? 1) + 1, status: 'submitted', listing_id: null, agent_id: parent.agent_id, contact_id: parent.contact_id, property_address: parent.property_address, offer_price: p.counterPrice ?? parent.offer_price, created_at: new Date(2026, 0, 10 + globalThis.__143A.issued.length).toISOString() }; globalThis.__143A.db.tables.offers.push(row); globalThis.__143A.issued.push({ ...p, id }); return { success: true, data: { counterId: id, round: row.current_round } } }",
  "./record-seller-response": "export const recordSellerResponse = async (p) => { globalThis.__143A.sellerResponses.push(p); return { success: true } }",
  "./record-seller-signed-counter": "export const recordSellerSignedCounter = async (p) => { globalThis.__143A.sellerCounters.push(p); const id = globalThis.crypto.randomUUID(); const parent = globalThis.__143A.db.tables.offers.find((o) => o.id === p.parentOfferId); globalThis.__143A.db.tables.offers.push({ id, brokerage_id: parent.brokerage_id, parent_offer_id: p.parentOfferId, offer_type: 'counter', current_round: (parent.current_round ?? 1) + 1, status: 'submitted', listing_id: null, agent_id: parent.agent_id, contact_id: parent.contact_id, property_address: parent.property_address, offer_price: p.terms.counterPrice, seller_signed_at: new Date().toISOString(), created_at: new Date(2026, 0, 20).toISOString() }); return { success: true, counterOfferId: id, round: (parent.current_round ?? 1) + 1 } }",
  "./respond-to-counter": "export const respondToCounter = async (p) => { globalThis.__143A.counterResponses.push(p); return { success: true } }",
  "@/lib/inbound-mail/resolve-user-provider": "export const resolveInboundEmailProviderForUser = async () => globalThis.__143A.inboundProvider",
  "@/lib/buyer-offer": "export const syncOfferStatus = async () => ({ success: true }); export const checkCompliancePassed = async () => ({ passed: true })",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUBS[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const BRK2 = "22222222-2222-4222-8222-222222222222"
const U_AGENT = "a0000000-0000-4000-8000-000000000001"
const U_OTHER = "a0000000-0000-4000-8000-000000000002"
const AG = "b0000000-0000-4000-8000-000000000001"
const AG_OTHER = "b0000000-0000-4000-8000-000000000002"
const BUYER = "c0000000-0000-4000-8000-0000000000b1"
const OFFER = "d0000000-0000-4000-8000-000000000001"
const OFFER_B = "d0000000-0000-4000-8000-000000000002"
const LISTING_OFFER = "d0000000-0000-4000-8000-000000000003"
const LA_EMAIL = "listing.agent@otherbroker.example"

async function main() {
  const L = await import("../lib/offers/outside-offer-loop")
  const T = await import("../lib/offers/governing-terms")
  const R = await import("../lib/offers/governing-terms-rule")
  const M = await import("../lib/inbound-mail/message-meta")

  // ═══ A · THE RULES, PURE ═══════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[A · the rules, pure: token, identity, sender, floor, the ambiguity rule, the chain, the outbound decision, the email]")
  // the token is minted by buildOutsideEmail (the only producer) — read it back off a built subject, never restate the shape
  const tokEmail = L.buildOutsideEmail({ kind: "offer_packet", offerId: OFFER, propertyAddress: "12 Oak St", round: 1, fromAgentName: "A", brokerageName: null, documents: [], linkDays: 7 })
  const tok = (tokEmail.subject.match(/\[ref:offer:[^\]]*\]/) ?? [])[0]
  check("the reference token is the SAME `ref:offer:<uuid>` shape the generic inbound lane already reads, and round-trips through a reply subject",
    tok === tokenOf(OFFER) && L.offerIdFromText(`Re: ${tokEmail.subject}`) === OFFER && L.offerIdFromText("Re: Offer — 12 Oak St") === null && L.offerIdFromText("ref:offer:not-a-uuid") === null
    && /ref:offer:([0-9a-f-]{36})/i.exec(tokEmail.subject)?.[1] === OFFER) // the webhook route's own regex (app/api/webhooks/inbound-mail/route.ts) reads the same token
  const k1 = L.messageKeyFor({ messageId: "<ABC@mail.example>", fromEmail: "A@x.com", subject: "s", bodyText: "b", attachments: [] })
  const k2 = L.messageKeyFor({ messageId: "abc@mail.example", fromEmail: "other@x.com", subject: "different", bodyText: "z", attachments: [] })
  const h1 = L.messageKeyFor({ fromEmail: "a@x.com", subject: "Re: offer", bodyText: "seller accepts", attachments: [{ fileName: "a.pdf", contentB64: "AAAA" }] })
  const h2 = L.messageKeyFor({ fromEmail: "A@X.com", subject: "Re: offer", bodyText: "seller accepts", attachments: [{ fileName: "a.pdf", contentB64: "AAAA" }] })
  const h3 = L.messageKeyFor({ fromEmail: "a@x.com", subject: "Re: offer", bodyText: "seller accepts", attachments: [{ fileName: "a.pdf", contentB64: "BBBB" }] })
  check("IDEMPOTENCY KEY: the Message-ID wins and is normalised (brackets, case); without one a content hash — the same message hashes the same, a changed attachment does not",
    k1 === "mid:abc@mail.example" && k1 === k2 && h1 === h2 && h1 !== h3 && h1.startsWith("sha:"))
  const sv = (auth: any, from = LA_EMAIL, aliases: string[] = []) => L.verifyOutsideSender({ recordedEmail: LA_EMAIL, aliases, fromEmail: from, senderAuth: auth })
  check("SENDER: the recorded listing agent + an authenticated domain is trusted; unknown authentication is NOT trusted (and not quarantined); a failed authentication quarantines; a different address is flagged, never trusted — even with a pass",
    sv("pass").trusted && !sv("unknown").trusted && !sv("unknown").quarantine && sv("fail").quarantine && !sv("fail").trusted
    && !sv("pass", "assistant@otherbroker.example").trusted && sv("pass", "assistant@otherbroker.example").matchesRecorded === false && sv("pass", "assistant@otherbroker.example", ["assistant@otherbroker.example"]).trusted)
  const ma = M.inboundMetaFrom([{ Name: "Message-ID", Value: "<m1@x>" }, { Name: "In-Reply-To", Value: "<out-1@mail.example>" }, { Name: "References", Value: "<a@x> <out-1@mail.example>" }, { Name: "Authentication-Results", Value: "mx; dkim=pass header.d=otherbroker.example; spf=pass smtp.mailfrom=otherbroker.example" }], LA_EMAIL)
  const mUnaligned = M.inboundMetaFrom([{ Name: "Authentication-Results", Value: "mx; dkim=pass header.d=spoofer.example; spf=none" }], LA_EMAIL)
  const mFail = M.inboundMetaFrom({ "authentication-results": "mx; dmarc=fail; dkim=fail" }, LA_EMAIL)
  const mNone = M.inboundMetaFrom([{ Name: "Message-ID", Value: "<q@x>" }], LA_EMAIL)
  const mSg = M.inboundMetaFrom("Message-ID: <sg1@x>\r\nIn-Reply-To: <o@x>", LA_EMAIL, { dkim: "{@otherbroker.example : pass}", spf: "pass" })
  check("MESSAGE META: id / thread / references are read and normalised; an ALIGNED pass is a pass; a DKIM pass for ANOTHER domain is NOT (a spoofer can sign as themselves); an explicit DMARC/DKIM fail is a fail; no authentication header is 'unknown', never 'pass'; SendGrid's verdict words work",
    ma.messageId === "m1@x" && ma.inReplyTo === "out-1@mail.example" && ma.references.join() === "a@x,out-1@mail.example" && ma.senderAuth === "pass"
    && mUnaligned.senderAuth === "unknown" && mFail.senderAuth === "fail" && mNone.senderAuth === "unknown" && mNone.messageId === "q@x" && mSg.senderAuth === "pass" && mSg.messageId === "sg1@x")
  const sig = (b: string, s = "Re: offer") => L.deterministicReplySignals(s, b)
  check("THE FLOOR: acceptance / counter / decline are read from the reply's OWN words — quoted history (our own 'please accept') is stripped; 'accepted another offer' is a DECLINE; 'accepted, but …' is a COUNTER (a conditional acceptance is not an acceptance)",
    sig("The seller accepts your offer. Signed contract attached.").acceptance && !sig("The seller accepts your offer.").counter
    && !sig("Thanks.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Buyer Agent wrote:\n> Please accept our offer on 12 Oak St").acceptance
    && sig("The seller has accepted another offer.").decline && !sig("The seller has accepted another offer.").acceptance
    && sig("We accept, subject to the seller keeping possession for 10 days.").counter && sig("The seller has countered — see attached counteroffer.").counter
    && sig("My client will not accept this offer.").decline && !sig("My client will not accept this offer.").acceptance)
  // the floor alone, as it reaches the reconciler when the model is down (no reading) — the way the product reaches it
  const floorOnly = (t: string) => L.reconcileReplyClassification({ signals: sig(t), reading: null, pdfCount: 0 }).classification
  check("floor → one class only when exactly one signal; none or several is ambiguous; and with the model down an ACCEPTANCE is never confirmed, even with a contract attached (rule 2)",
    floorOnly("The seller declines.") === "decline" && floorOnly("The seller has countered — see attached.") === "counter"
    && floorOnly("Hello, got it, will respond.") === "ambiguous" && floorOnly("We accept but are countering the closing date.") === "ambiguous"
    && floorOnly("The seller accepts. Signed contract attached.") === "ambiguous"
    && L.reconcileReplyClassification({ signals: sig("The seller accepts. Signed contract attached."), reading: null, pdfCount: 1 }).classification === "ambiguous")
  const reading = (cls: any, conf: number | null = 0.9, extra: any = {}) => ({ classification: cls, confidence: conf, summary: "s", evidence: [], terms: {}, attachments: [], questions: [], ...extra })
  const rec = (text: string, r: any, pdf: number) => L.reconcileReplyClassification({ signals: sig(text), reading: r, pdfCount: pdf })
  check("THE AMBIGUITY RULE: an acceptance needs the model, the plain words, confidence ≥ 0.7 AND a signed PDF — each missing piece LOWERS it to ambiguous, with the remedy 'request the signed document'",
    rec("The seller accepts. Signed contract attached.", reading("acceptance"), 1).classification === "acceptance"
    && rec("The seller accepts.", reading("acceptance"), 0).classification === "ambiguous" && rec("The seller accepts.", reading("acceptance"), 0).recommendedAction === "request_signed_document"
    && rec("The seller accepts. Attached.", reading("acceptance", 0.4), 1).classification === "ambiguous"
    && rec("The seller accepts. Attached.", null, 1).classification === "ambiguous"
    && rec("Hello, see attached.", reading("acceptance"), 1).classification === "ambiguous")
  check("THE FLOOR CAN ONLY LOWER: the model saying acceptance over plain 'accepted another offer' (a decline) is ambiguous; the model saying decline over a plain acceptance is ambiguous; agreement stands; a model-free reading takes only a single clear signal",
    rec("The seller has accepted another offer.", reading("acceptance"), 1).classification === "ambiguous"
    && rec("The seller accepts. Signed contract attached.", reading("decline"), 1).classification === "ambiguous"
    && rec("The seller declines.", reading("decline"), 0).classification === "decline" && rec("The seller declines.", reading("decline"), 0).recommendedAction === "record_decline"
    && rec("The seller declines.", null, 0).classification === "decline" && rec("ok", null, 0).classification === "ambiguous")
  check("a COUNTER with no document is still a counter but the action is to ask for the signed counter — never to record one; with the document the action is record_counter",
    rec("The seller has countered — see below.", reading("counter"), 0).recommendedAction === "request_signed_document" && rec("The seller has countered — see attached counteroffer.", reading("counter"), 1).recommendedAction === "record_counter")
  const parsed = L.parseReplyReading('```json\n{"classification":"counter","confidence":1.7,"summary":"x","evidence":["a"],"terms":{"offer_price":405000,"closing_date":null,"title_policy_payer":"seller","note":""},"attachments":[{"fileName":"c.pdf","role":"counter_offer"}],"questions":[]}\n```')
  check("NOTHING IS INVENTED: the model's JSON is parsed defensively — confidence clamped, a term the reply does not state (null / empty) is ABSENT not defaulted, an unknown class is ambiguous, garbage is null",
    parsed?.classification === "counter" && parsed.confidence === 1 && parsed.terms.offer_price === 405000 && !("closing_date" in parsed.terms) && !("note" in parsed.terms) && parsed.terms.title_policy_payer === "seller"
    && L.parseReplyReading('{"classification":"maybe"}')?.classification === "ambiguous" && L.parseReplyReading("not json") === null && L.parseReplyReading(null) === null)
  {
    // THE CHAIN, through the one loader (the root/head pickers are private to it): the root has no parent; the head is the newest
    // round (an answer is an answer TO it) — from ANY anchor in the chain; a sibling counter on the same round loses to the later one
    const CR = "c1000000-0000-4000-8000-000000000001", CC2 = "c1000000-0000-4000-8000-000000000002", CC3 = "c1000000-0000-4000-8000-000000000003", CC3b = "c1000000-0000-4000-8000-000000000004"
    const base = { brokerage_id: BRK, listing_id: null, agent_id: null, contact_id: null, property_address: "12 Oak St", metadata: {} }
    const dbChain = memSupabase({ offers: [
      { ...base, id: CR, parent_offer_id: null, current_round: 1, created_at: "2026-01-01T00:00:00Z" },
      { ...base, id: CC2, parent_offer_id: CR, current_round: 2, created_at: "2026-01-02T00:00:00Z" },
      { ...base, id: CC3, parent_offer_id: CC2, current_round: 3, created_at: "2026-01-03T00:00:00Z" },
      { ...base, id: CC3b, parent_offer_id: CC2, current_round: 3, created_at: "2026-01-04T00:00:00Z" },
    ] }) as any
    const fromRoot = await L.loadOutsideChain(dbChain, BRK, CR), fromMid = await L.loadOutsideChain(dbChain, BRK, CC2), fromHead = await L.loadOutsideChain(dbChain, BRK, CC3)
    const missing = await L.loadOutsideChain(dbChain, BRK, "c1000000-0000-4000-8000-0000000000ff"), otherTenant = await L.loadOutsideChain(dbChain, BRK2, CR)
    check("THE CHAIN: from ANY row the loader finds the root (no parent) and the head (newest round, then latest); an unknown row and another brokerage's session read nothing, by name",
      [fromRoot, fromMid, fromHead].every((c: any) => c.ok && c.chain.root.id === CR && c.chain.head.id === CC3b && c.chain.rows.length === 4)
      && !missing.ok && /no such offer/.test((missing as any).reason) && !otherTenant.ok)
  }
  check("TARGET: token beats thread beats sender; one sender match routes; SEVERAL refuse (ambiguous); none is none",
    L.pickOutsideTarget({ byToken: "a", byThread: "b", bySender: ["c"] }).kind === "matched" && (L.pickOutsideTarget({ byToken: "a", byThread: "b", bySender: ["c"] }) as any).how === "token"
    && (L.pickOutsideTarget({ byToken: null, byThread: "b", bySender: ["c"] }) as any).how === "thread" && (L.pickOutsideTarget({ byToken: null, byThread: null, bySender: ["c"] }) as any).how === "sender"
    && L.pickOutsideTarget({ byToken: null, byThread: null, bySender: ["c", "d"] }).kind === "ambiguous" && L.pickOutsideTarget({ byToken: null, byThread: null, bySender: ["c", "c"] }).kind === "matched" && L.pickOutsideTarget({ byToken: null, byThread: null, bySender: [] }).kind === "none")
  const pdfUrl = (n: string) => `https://x.supabase.co/storage/v1/object/sign/offer-documents/${n}.pdf?token=t`
  const doc = (id: string, linked: string | null, url: string | null = pdfUrl(id)) => ({ id, name: `${id}.pdf`, classification: null, linkedOfferId: linked, storageUrl: url })
  const dec = (over: any = {}) => L.decideOutsideSend({ kind: "offer_packet", offer: { id: OFFER, listing_id: null }, buyerSigned: true, recipient: { email: LA_EMAIL, verifiedBy: "mls_published" }, documents: [doc("a", OFFER)], ...over })
  check("OUTBOUND (packet): needs an outside property, the buyer's signature, a verified recipient, and documents filed to THIS offer that can be shared by a secure link — each missing piece is refused by name",
    dec().ok && !(dec({ offer: { id: OFFER, listing_id: "L" } }) as any).ok && /in-house/.test((dec({ offer: { id: OFFER, listing_id: "L" } }) as any).reason)
    && /not signed/.test((dec({ buyerSigned: false }) as any).reason) && /not verified/.test((dec({ recipient: { email: LA_EMAIL, verifiedBy: null } }) as any).reason)
    && /attach/.test((dec({ documents: [] }) as any).reason) && /not filed to this offer/.test((dec({ documents: [doc("a", "other-offer")] }) as any).reason)
    && /secure link/.test((dec({ documents: [doc("a", OFFER, "https://elsewhere.example/a.pdf")] }) as any).reason) && !(dec({ recipient: { email: "nope", verifiedBy: "mls_published" } }) as any).ok)
  const cb = (docs: any[], buyerSigned = true) => L.decideOutsideSend({ kind: "counter_back", offer: { id: "c4", listing_id: null }, buyerSigned, recipient: { email: LA_EMAIL, verifiedBy: "agent_confirmed" }, documents: docs })
  check("OUTBOUND (counter-back): ONLY the counter — documents linked to the counter ROW pass; the original offer's packet, an earlier round's counter, or any mixture is refused naming the file ('sends ONLY the counter')",
    cb([doc("cnt", "c4")]).ok && /ONLY the counter/.test((cb([doc("orig", OFFER)]) as any).reason) && /ONLY the counter/.test((cb([doc("cnt", "c4"), doc("old", "c3")]) as any).reason) && /old\.pdf/.test((cb([doc("cnt", "c4"), doc("old", "c3")]) as any).reason) && /counter-offer document/.test((cb([]) as any).reason)
    && /has not signed the counter-offer/.test((cb([doc("cnt", "c4")], false) as any).reason))
  const em = L.buildOutsideEmail({ kind: "counter_back", offerId: OFFER, propertyAddress: "12 Oak St", round: 4, fromAgentName: "Dana Agent", brokerageName: "Coastal Realty", documents: [{ name: "Counter.pdf", url: "https://signed.example/c" }], linkDays: 7 })
  const emOffer = L.buildOutsideEmail({ kind: "offer_packet", offerId: OFFER, propertyAddress: "12 Oak St", round: 1, fromAgentName: "Dana Agent", brokerageName: null, documents: [{ name: "Offer.pdf", url: "https://signed.example/o" }], linkDays: 7, note: "Buyer is pre-approved." })
  check("THE EMAIL: the reference token rides the subject (so the reply carries it back), the links are named with their expiry, a counter-back says it contains ONLY the counter, no price or terms are in the body, and HTML-sensitive text is escaped",
    em.subject.includes(tokenOf(OFFER)) && /only the counter-offer/i.test(em.text) && /valid 7 days/.test(em.text) && !/\$\s?\d/.test(em.text) && emOffer.text.includes("Buyer is pre-approved.")
    && /&lt;b&gt;/.test(L.buildOutsideEmail({ kind: "offer_packet", offerId: OFFER, propertyAddress: "1 <b>X</b>", round: 1, fromAgentName: "A", brokerageName: null, documents: [], linkDays: 7 }).html))
  check("a stored signed URL is parsed to its bucket and path (to be re-signed short-lived); anything else is refused", L.parseSignedStorageUrl(pdfUrl("a"))?.bucket === "offer-documents" && L.parseSignedStorageUrl(pdfUrl("a"))?.path === "a.pdf" && L.parseSignedStorageUrl("https://elsewhere.example/a.pdf") === null && L.parseSignedStorageUrl(null) === null)

  // ═══ B..E follow ══════════════════════════════════════════════════════════════════════════════════════════════════════
  await sectionsBtoE(L, T, R, M)
  await sectionF(T, R)

  console.log("\nBLIND SPOTS: the model, the egress (dispatchEmail), RentCast, the signed-URL minter and the three survivors (recordSellerResponse / recordSellerSignedCounter /")
  console.log("  respondToCounter) are INJECTED recorders — what they would DO live (a real email leaving, a real model reading a real PDF, the survivors' own writes) is theirs to prove")
  console.log("  (their proofs exist) and is not driven here; the in-memory client has no RLS and no CHECK, so m797/m798's constraints are asserted from their TEXT against the code's")
  console.log("  vocabularies until the integrator applies them; sender authentication is parsed from header text the providers' parsers hand over — whether a given provider payload")
  console.log("  carries Authentication-Results at all is the provider's (Resend and Outlook's default payload carry none, and read 'unknown'); the governed egress carries no file")
  console.log("  attachments, so documents travel as expiring secure links. Section F: the field-level PACKET walk (scanOfferPacketCompleteness) runs on")
  console.log("  the submitted row only — run on an ancestor it would stamp open flags no gate reads; the ORIGINAL offer is covered at the document")
  console.log("  level (presence + signatures + initials per required classification), which is what the brokerage's checklist asks of it.")
  console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
  process.exit(failed === 0 ? 0 : 1)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sectionsBtoE(L: any, T: any, R: any, M: any) {
  void M
  const pdfUrl = (n: string) => `https://x.supabase.co/storage/v1/object/sign/offer-documents/${n}.pdf?token=t`
  const pdf = [{ fileName: "Signed Contract.pdf", mime: "application/pdf", contentB64: "JVBERi0xLjQ=" }]
  const readerOf = (reading: any) => async () => ({ reading, error: null, pdfsRead: reading ? 1 : 0 })
  const rd = (cls: string, conf = 0.92, over: any = {}) => ({ classification: cls, confidence: conf, summary: `AI: ${cls}`, evidence: [], terms: {}, attachments: [], questions: [], ...over })
  const mkDb = (extraOffers: any[] = [], extra: Record<string, any[]> = {}, opts: any = {}) => memSupabase({
    users: [
      { id: U_AGENT, brokerage_id: BRK, user_type: "agent", first_name: "Dana", last_name: "Agent", team_id: null },
      { id: U_OTHER, brokerage_id: BRK, user_type: "agent", first_name: "Omar", last_name: "Other", team_id: null },
    ],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: BRK }, { id: AG_OTHER, user_id: U_OTHER, brokerage_id: BRK }],
    brokerages: [{ id: BRK, name: "Coastal Realty" }],
    offers: [
      { id: OFFER, brokerage_id: BRK, agent_id: AG, contact_id: BUYER, listing_id: null, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "submitted", esign_status: "fully_signed", buyer_signed_at: "2026-01-02T00:00:00Z", property_address: "12 Oak St, Tampa, FL 33602", offer_price: 400000, closing_date: "2026-12-01", inspection_period_days: 10, metadata: { outside_listing_agent_email: LA_EMAIL, outside_listing_agent_name: "Lee Agent" }, created_at: "2026-01-01T00:00:00Z" },
      { id: LISTING_OFFER, brokerage_id: BRK, agent_id: AG, contact_id: BUYER, listing_id: "11111111-aaaa-4aaa-8aaa-000000000001", parent_offer_id: null, current_round: 1, status: "submitted", property_address: "3 In-house Ln", metadata: {}, created_at: "2026-01-01T00:00:00Z" },
      ...extraOffers,
    ],
    notifications: [], documents: [], outside_offer_messages: [], contract_term_versions: [], ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { outside_offer_messages: [["brokerage_id", "offer_id", "direction", "message_key"]], notifications: [["user_id", "entity_id", "type"]], contract_term_versions: [["brokerage_id", "root_offer_id", "source", "version_no"]] }, ...opts })
  const { tryRouteOutboundOfferReply } = await import("../lib/inbound-mail/offer-intake")

  // ═══ B · THE INBOUND HALF, LIVE ════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[B · the inbound half, live: matched, verified, claimed once, filed, read, told — and nothing accepted, signed or created]")
  const db = mkDb()
  G.__143A.db = db
  const mailbox = { userId: U_AGENT, address: "dana@coastal.example" }
  const route = (over: any, reader: any = readerOf(rd("acceptance")), client: any = db) => tryRouteOutboundOfferReply({
    brokerageId: BRK, subject: `Re: Offer — 12 Oak St ${tokenOf(OFFER)}`, fromEmail: LA_EMAIL, mailbox, attachments: pdf,
    bodyText: "The seller accepts your offer. Signed contract attached.", messageId: "<m-1@lo.example>", senderAuth: "pass", ...over,
  }, client, { read: reader, now: () => new Date("2026-02-01T10:00:00Z") })
  const offerRow = (): any => db.tables.offers.find((o: any) => o.id === OFFER)
  const ledger = (): any[] => db.tables.outside_offer_messages
  const bells = (): any[] => db.tables.notifications.filter((n: any) => n.type === "offer_intake_review")
  const before = JSON.stringify({ status: offerRow().status, price: offerRow().offer_price, tx: offerRow().transaction_id, resp: offerRow().seller_response_type, ss: offerRow().seller_signed_at })

  const b1 = await route({})
  check("MATCHED BY TOKEN, verified, filed, read, told: the acceptance claim with a signed contract attached is READ as acceptance → recommended `record_acceptance`; one ledger row (awaiting the agent), the PDF filed to the offer, one bell",
    b1.handled && !b1.duplicate && b1.classification === "acceptance" && b1.recommendedAction === "record_acceptance" && ledger().length === 1 && ledger()[0].status === "awaiting_agent" && ledger()[0].direction === "inbound" && ledger()[0].kind === "seller_reply"
    && ledger()[0].sender_auth === "pass" && ledger()[0].document_ids.length === 1 && db.tables.documents.length === 1 && db.tables.documents[0].metadata.linked_offer_id === OFFER && bells().length === 1 && bells()[0].user_id === U_AGENT, JSON.stringify(b1))
  check("NOTHING IS ACCEPTED, SIGNED OR CREATED: the offer's status, price, transaction, seller-response and signature fields are byte-identical after an acceptance-looking reply; no transactions table was touched; the bell says so",
    JSON.stringify({ status: offerRow().status, price: offerRow().offer_price, tx: offerRow().transaction_id, resp: offerRow().seller_response_type, ss: offerRow().seller_signed_at }) === before && !db.tables.transactions && /Nothing has been accepted, signed or recorded/.test(bells()[0].body) && G.__143A.sellerResponses.length === 0)
  check("the loop's pointers are MERGED into the offer's metadata (the recorded counterparty survives; the legacy reply stamp is kept; the ledger id is on it)",
    offerRow().metadata.outside_listing_agent_email === LA_EMAIL && offerRow().metadata.outside_listing_agent_name === "Lee Agent" && offerRow().metadata.outside_loop.last_inbound_message_id === ledger()[0].id && !!offerRow().metadata.counterparty_last_reply_at && offerRow().metadata.counterparty_reply_document_ids.length === 1)
  const b2 = await route({})
  check("IDEMPOTENT: the same message delivered again (a redelivered webhook) is a `duplicate` — no second ledger row, no second filing, no second bell",
    b2.handled && b2.duplicate === true && ledger().length === 1 && db.tables.documents.length === 1 && bells().length === 1)
  const b3 = await route({ messageId: "<m-2@lo.example>" })
  check("POSITIVE CONTROL for the dedupe: a DIFFERENT message (new Message-ID) is claimed and filed, and its bell REFRESHES the one unread notice instead of being refused (the live idx_notification_dedupe)",
    b3.handled && !b3.duplicate && ledger().length === 2 && db.tables.documents.length === 2 && bells().length === 1)
  const filedBefore = db.tables.documents.length
  const b4 = await route({ messageId: "<m-3@lo.example>", senderAuth: "fail" })
  check("A FAILED SENDER IS QUARANTINED: nothing is filed, nothing is read, the ledger says `quarantined`, and the agent is told the message failed authentication",
    b4.handled && b4.quarantined === true && db.tables.documents.length === filedBefore && ledger().find((r: any) => r.message_key === "mid:m-3@lo.example")?.status === "quarantined" && /failed sender authentication/.test(bells()[0].title))
  const b5 = await route({ messageId: "<m-4@lo.example>", attachments: [] })
  check("AMBIGUITY IS NEVER ACCEPTANCE: 'the seller accepts' with NO signed contract attached is read as ambiguous with the remedy 'request the signed document' — even though the model said acceptance at 0.92",
    b5.classification === "ambiguous" && b5.recommendedAction === "request_signed_document")
  const b6 = await route({ messageId: "<m-5@lo.example>", bodyText: "The seller has accepted another offer." })
  check("THE FLOOR LOWERS THE MODEL: the model said acceptance over a PDF, but the plain words say another offer was accepted → ambiguous, never acceptance", b6.classification === "ambiguous")
  const b7 = await route({ messageId: "<m-6@lo.example>", bodyText: "The seller declines your offer.", attachments: [] }, async () => ({ reading: null, error: "model down", pdfsRead: 0 }))
  check("THE MODEL IS DOWN: the reply is still filed and told on its plain words alone — a clear decline is a decline, the error is reported, nothing throws",
    b7.handled && b7.classification === "decline" && b7.recommendedAction === "record_decline" && (b7.errors ?? []).some((e: string) => /model down/.test(e)))
  const b8 = await route({ messageId: "<m-7@lo.example>", fromEmail: "assistant@otherbroker.example", bodyText: "Counter attached.", attachments: pdf }, readerOf(rd("counter")))
  const m8 = ledger().find((r: any) => r.message_key === "mid:m-7@lo.example")
  check("A DIFFERENT SENDER reaching the offer by its reference (the listing agent's assistant) is filed and FLAGGED — never trusted: the verdict says it is not the recorded listing agent, and the bell carries the caution",
    b8.handled && m8?.reading?.sender_verdict?.trusted === false && m8?.reading?.sender_verdict?.matchesRecorded === false && /Caution/.test(bells()[0].body))
  const ledgerBefore9 = ledger().length
  const b9 = await route({ subject: "Weekly newsletter", fromEmail: "random@else.example", messageId: "<m-8@lo.example>" })
  check("NOT OURS: an email that matches no offer we sent is `handled: false` and falls through to the other lanes untouched (no ledger row)", b9.handled === false && ledger().length === ledgerBefore9)
  const b11 = await route({ subject: `Re: In-house ${tokenOf(LISTING_OFFER)}`, fromEmail: "random@else.example", messageId: "<m-9@lo.example>" })
  check("POSITIVE CONTROL (outside offers only): a reference token naming an IN-HOUSE-listing offer does not route into the outside loop", b11.handled === false)
  const b13 = await route({ messageId: "<m-10@lo.example>" }, readerOf(rd("acceptance")), db).then(() => tryRouteOutboundOfferReply({ brokerageId: BRK, subject: `Re: ${tokenOf(OFFER)}`, fromEmail: LA_EMAIL, mailbox: { userId: U_OTHER, address: "omar@coastal.example" }, attachments: [], bodyText: "hi", messageId: "<m-11@lo.example>", senderAuth: "pass" }, db, { read: readerOf(rd("acknowledgement")) }))
  check("MAILBOX SCOPING: a reply landing in ANOTHER agent's mailbox never routes into this agent's offer (token or sender) — the rows of the other agent are not read", b13.handled === false)

  // two watched offers, one counterparty — and the thread breaks the tie
  const OFFER2 = "d0000000-0000-4000-8000-0000000000b2"
  const db2 = mkDb([{ id: OFFER2, brokerage_id: BRK, agent_id: AG, contact_id: BUYER, listing_id: null, parent_offer_id: null, current_round: 1, status: "submitted", property_address: "98 Elm Ave, Tampa, FL", metadata: { outside_listing_agent_email: LA_EMAIL }, created_at: "2026-01-05T00:00:00Z" }],
    { outside_offer_messages: [{ id: "out-row-1", brokerage_id: BRK, offer_id: OFFER2, head_offer_id: OFFER2, direction: "outbound", kind: "offer_packet", message_key: "mid:out-1@mail.example", counterparty_email: LA_EMAIL, status: "sent", created_at: "2026-01-06T00:00:00Z" }] })
  G.__143A.db = db2
  const r2 = (over: any) => tryRouteOutboundOfferReply({ brokerageId: BRK, subject: "Re: your offer", fromEmail: LA_EMAIL, mailbox, attachments: [], bodyText: "We have a counter, see below.", messageId: "<n-1@lo.example>", senderAuth: "pass", ...over }, db2, { read: readerOf(rd("counter")) })
  const amb = await r2({})
  check("SEVERAL OFFERS, ONE LISTING AGENT, NO REFERENCE: nothing is routed (a guess is the mis-link class) — and the agent is TOLD which email needs linking (it used to fall through in silence)",
    amb.handled === false && amb.ambiguous === true && db2.tables.outside_offer_messages.length === 1 && db2.tables.notifications.some((n: any) => /which offer/.test(n.title)))
  const thr = await r2({ messageId: "<n-2@lo.example>", inReplyTo: "<OUT-1@mail.example>" })
  check("THE THREAD BREAKS THE TIE: the same reply with an In-Reply-To naming OUR outbound Message-ID routes to exactly the offer that email carried (case and brackets normalised)",
    thr.handled && thr.offerId === OFFER2 && db2.tables.outside_offer_messages.some((r: any) => r.direction === "inbound" && r.offer_id === OFFER2))
  const closed = mkDb([], {}, { refuse: { outside_offer_messages: "permission denied for table outside_offer_messages" } })
  const refused = await tryRouteOutboundOfferReply({ brokerageId: BRK, subject: `Re: ${tokenOf(OFFER)}`, fromEmail: LA_EMAIL, mailbox, attachments: [], bodyText: "x", messageId: "<z@z>", senderAuth: "pass" }, closed, { read: readerOf(rd("acknowledgement")) })
  check("FAIL CLOSED: a REFUSED ledger claim is `handled: false` with the cause — not a silent filing without its idempotency row", refused.handled === false && (refused.errors ?? []).some((e: string) => /permission denied/.test(e)))

  // ═══ C · THE AGENT'S DOORS, LIVE ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[C · the agent's doors: send (verified, secure links, governed, human-approved), counter-back (a NEW row, only the counter), confirm (a person records it)]")
  const SELLER_COUNTER = "d0000000-0000-4000-8000-0000000000c2"
  // The seller's counter is added AFTER the packet-send checks: while the original offer is the chain's newest round it is the one that may be sent.
  const SELLER_COUNTER_SEED = { id: SELLER_COUNTER, brokerage_id: BRK, agent_id: AG, contact_id: BUYER, listing_id: null, parent_offer_id: OFFER, offer_type: "counter", current_round: 2, status: "submitted", property_address: "12 Oak St, Tampa, FL 33602", offer_price: 395000, seller_signed_at: "2026-01-20T00:00:00Z", metadata: {}, created_at: "2026-01-20T00:00:00Z" }
  const dbC = mkDb([],
    { documents: [
      { id: "90000001-0000-4000-8000-000000000001", brokerage_id: BRK, storage_url: pdfUrl("offer-packet"), classification: "purchase_contract", metadata: { file_name: "Offer Packet.pdf", linked_offer_id: OFFER }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] } },
      { id: "90000002-0000-4000-8000-000000000002", brokerage_id: BRK2, storage_url: pdfUrl("foreign"), metadata: { file_name: "Other.pdf", linked_offer_id: OFFER }, signature_completeness: null },
    ] })
  G.__143A.db = dbC
  const A = await import("../app/actions/buyer-offer/outside-offer-loop")
  const asAgent = { ok: true, userId: U_AGENT, brokerageId: BRK, userType: "agent" }
  G.__143A.caller = asAgent
  G.__143A.mls = { ok: true, agentEmails: [] }
  const s0 = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"] })
  check("THE RECIPIENT IS VERIFIED BEFORE ANYTHING LEAVES: the MLS publishes no agent email and the agent has not confirmed → refused, asking for confirmation; the egress was never called",
    s0.success === false && s0.needsRecipientConfirmation === true && G.__143A.dispatched.length === 0)
  G.__143A.mls = { ok: true, agentEmails: ["someone.else@otherbroker.example"] }
  const s0b = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"] })
  check("…a DIFFERENT published agent is not a match (the front desk / a colleague is not the listing agent)", s0b.success === false && /different listing-agent email/.test(s0b.error ?? "") && G.__143A.dispatched.length === 0)
  G.__143A.mls = { ok: true, agentEmails: [LA_EMAIL] }
  const s1 = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], note: "Buyer is pre-approved." })
  const out = G.__143A.dispatched[0]
  const outRow = dbC.tables.outside_offer_messages.find((r: any) => r.direction === "outbound")
  const rootC = (): any => dbC.tables.offers.find((o: any) => o.id === OFFER)
  check("SEND (offer packet): matched to the MLS-published agent → ONE governed email, human-approved, from the agent's own mailbox, the reference token in the subject, the document as an EXPIRING secure link (7 days) — never a stored ten-year URL",
    s1.success && s1.verifiedBy === "mls_published" && G.__143A.dispatched.length === 1 && out.to === LA_EMAIL && out.humanApproved === true && out.sendAsAgentUserId === U_AGENT && out.channelPurpose === "transactional"
    && out.subject.includes(tokenOf(OFFER)) && /ttl=604800/.test(out.text) && !/token=t/.test(out.text) && out.ledger.reasonCode === "HUMAN_REQUESTED", JSON.stringify(s1))
  check("…and it is LEDGERED (kind, how the recipient was verified, who approved, the Message-ID the thread match will look up) and the reply WATCH is armed on the root (merged, with the verified counterparty)",
    outRow?.kind === "offer_packet" && outRow.recipient_verification === "mls_published" && outRow.approved_by === U_AGENT && outRow.status === "sent" && outRow.message_key === "mid:out-1@mail.example" && outRow.document_ids.join() === "90000001-0000-4000-8000-000000000001"
    && rootC().metadata.outside_loop.counterparty.verified_by === "mls_published" && rootC().metadata.outside_listing_agent_email === LA_EMAIL && !!rootC().metadata.outbound_watch_armed_at)
  check("…and the agent is WARNED when no inbound mailbox is connected (the platform cannot see a reply it is never given); with one connected there is no such warning",
    s1.replyWatch === "no_mailbox" && (s1.warnings ?? []).some((w: string) => /No inbound mailbox/.test(w)))
  G.__143A.inboundProvider = { platform: "gmail" }
  G.__143A.mls = { ok: false, reason: "RentCast is not connected" }
  const s2 = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: "other.listing@otherbroker.example" })
  const s2b = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: "other.listing@otherbroker.example", confirmRecipient: true })
  check("WHEN THE MLS CANNOT BE ASKED the agent can confirm the address themselves — recorded as `agent_confirmed`, never as MLS-verified; with a mailbox connected the watch is real",
    s2.success === false && s2.needsRecipientConfirmation === true && s2b.success && s2b.verifiedBy === "agent_confirmed" && s2b.replyWatch === "mailbox_connected"
    && dbC.tables.outside_offer_messages.filter((r: any) => r.direction === "outbound").some((r: any) => r.recipient_verification === "agent_confirmed"))
  G.__143A.dispatchResult = { success: false, providerKey: "stub", error: "bounced" }
  const s3 = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  G.__143A.dispatchResult = { success: true, providerKey: "stub", messageId: "<out-2@mail.example>" }
  check("A REFUSED SEND is reported and ledgered as `send_failed` (not 'sent'); nothing claims delivery", s3.success === false && /not sent/.test(s3.error ?? "") && dbC.tables.outside_offer_messages.some((r: any) => r.status === "send_failed"))
  const sForeign = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000002-0000-4000-8000-000000000002"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  check("A DOCUMENT FROM ANOTHER BROKERAGE cannot be shared (the read is tenant-pinned)", sForeign.success === false && /not in your brokerage/.test(sForeign.error ?? ""))
  G.__143A.caller = { ok: true, userId: U_OTHER, brokerageId: BRK, userType: "agent" }
  const sOther = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  G.__143A.caller = { ok: true, userId: U_OTHER, brokerageId: BRK, userType: "broker_admin" }
  const sAdmin = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  G.__143A.caller = { ok: true, userId: U_AGENT, brokerageId: BRK2, userType: "agent" }
  const sTenant = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  G.__143A.caller = asAgent
  check("AUTHORITY: another agent in the brokerage cannot act on this offer; a tenant admin can; a session from ANOTHER brokerage sees no such offer (the tenant is the session's)",
    sOther.success === false && /Only the offer's agent/.test(sOther.error ?? "") && sAdmin.success === true && sTenant.success === false && /no such offer/.test(sTenant.error ?? ""))

  // counter-back: a new VERSIONED row, and only the counter is sent
  dbC.tables.offers.push(SELLER_COUNTER_SEED)
  // (against a chain whose newest round IS the original offer — there is no seller counter to answer yet)
  const freshDb = mkDb(); G.__143A.db = freshDb
  const cbNo = await A.createOutsideCounterBack({ parentOfferId: OFFER, counterPrice: 390000 })
  G.__143A.db = dbC
  const cbNone = await A.createOutsideCounterBack({ parentOfferId: SELLER_COUNTER })
  const cbBad = await A.createOutsideCounterBack({ parentOfferId: SELLER_COUNTER, terms: { not_a_term: 1 } })
  const cb: any = await A.createOutsideCounterBack({ parentOfferId: SELLER_COUNTER, counterPrice: 398000, closingDate: "2026-12-20", terms: { title_policy_payer: "seller" }, notes: "Meet in the middle." })
  const newRow = dbC.tables.offers.find((o: any) => o.id === cb.counterOfferId)
  const cbAgain = await A.createOutsideCounterBack({ parentOfferId: SELLER_COUNTER, counterPrice: 397000 })
  check("COUNTER-BACK: answering the SELLER's counter creates a NEW versioned row (parent = the seller's counter, round 3, stamped as buyer-issued) through the survivor issueCounterOffer; the original and the seller's counter are untouched; the chain head moves",
    cb.success && cb.round === 3 && newRow?.parent_offer_id === SELLER_COUNTER && newRow?.metadata?.outside_loop?.issued_by === "buyer"
    && dbC.tables.offers.find((o: any) => o.id === OFFER)!.offer_price === 400000 && dbC.tables.offers.find((o: any) => o.id === SELLER_COUNTER)!.offer_price === 395000 && rootC().metadata.outside_loop.head_offer_id === cb.counterOfferId, JSON.stringify(cb))
  check("…refusals: you cannot counter the ORIGINAL offer (there is no seller counter yet), counter with NO change, use a term outside the vocabulary, or counter an earlier round once a newer one exists",
    cbNo.success === false && /no seller counter/.test(cbNo.error ?? "") && cbNone.success === false && /at least one term/.test(cbNone.error ?? "") && cbBad.success === false && /not_a_term/.test(cbBad.error ?? "") && cbAgain.success === false && /newest round/.test(cbAgain.error ?? ""))
  const tv = dbC.tables.contract_term_versions.find((v: any) => v.offer_id === cb.counterOfferId)
  check("…and the buyer's FULL confirmed terms (including the one an offers row has no column for — the owner's title policy) ride the immutable record as a PROPOSED version that governs only once executed",
    tv?.status === "proposed" && tv.source === "counter" && tv.version_no === 3 && tv.terms.title_policy_payer === "seller" && tv.terms.offer_price === 398000 && tv.executed_at === null)
  dbC.tables.documents.push(
    { id: "90000003-0000-4000-8000-000000000003", brokerage_id: BRK, storage_url: pdfUrl("counter-back"), classification: "counter_offer", metadata: { file_name: "Counter Round 3.pdf", linked_offer_id: cb.counterOfferId }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] } },
    { id: "90000004-0000-4000-8000-000000000004", brokerage_id: BRK, storage_url: pdfUrl("counter-back-2"), metadata: { file_name: "Unsigned.pdf", linked_offer_id: cb.counterOfferId }, signature_completeness: null },
    { id: "90000005-0000-4000-8000-000000000005", brokerage_id: BRK, storage_url: pdfUrl("seller-counter"), metadata: { file_name: "Seller Counter Round 2.pdf", linked_offer_id: SELLER_COUNTER }, signature_completeness: null },
  )
  const dispatchedBefore = G.__143A.dispatched.length
  const sOnlyOrig = await A.sendOutsideOffer({ offerId: cb.counterOfferId, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  const sMixed = await A.sendOutsideOffer({ offerId: cb.counterOfferId, documentIds: ["90000003-0000-4000-8000-000000000003", "90000005-0000-4000-8000-000000000005"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  const sUnsigned = await A.sendOutsideOffer({ offerId: cb.counterOfferId, documentIds: ["90000004-0000-4000-8000-000000000004"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  // (a chain whose NEWEST round is the seller's own counter — sending it back to them is refused for who issued it)
  const dbSC = mkDb([{ ...SELLER_COUNTER_SEED }], { documents: [{ id: "90000005-0000-4000-8000-000000000005", brokerage_id: BRK, storage_url: pdfUrl("seller-counter"), metadata: { file_name: "Seller Counter Round 2.pdf", linked_offer_id: SELLER_COUNTER }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] } }] })
  G.__143A.db = dbSC
  const sSellerSide = await A.sendOutsideOffer({ offerId: SELLER_COUNTER, documentIds: ["90000005-0000-4000-8000-000000000005"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  G.__143A.db = dbC
  const sOld = await A.sendOutsideOffer({ offerId: OFFER, documentIds: ["90000001-0000-4000-8000-000000000001"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  check("ONLY THE COUNTER IS SENT: the original packet, a mix with the seller's earlier counter, a counter the buyer has not signed, a counter the SELLER's side issued, and a superseded earlier round are each REFUSED — and the egress is never called for any of them",
    [sOnlyOrig, sMixed, sUnsigned, sSellerSide, sOld].every((r) => r.success === false) && /ONLY the counter/.test(sOnlyOrig.error ?? "") && /Seller Counter Round 2/.test(sMixed.error ?? "") && /not signed/.test(sUnsigned.error ?? "")
    && /issued by the seller/.test(sSellerSide.error ?? "") && /newest round/.test(sOld.error ?? "") && G.__143A.dispatched.length === dispatchedBefore)
  const sCb = await A.sendOutsideOffer({ offerId: cb.counterOfferId, documentIds: ["90000003-0000-4000-8000-000000000003"], recipientEmail: LA_EMAIL, confirmRecipient: true })
  const cbMail = G.__143A.dispatched[G.__143A.dispatched.length - 1]
  check("…and the buyer-signed counter-back document alone goes out: one email whose subject names the round, whose body says it contains only the counter, with one link", sCb.success && /Counter-offer \(round 3\)/.test(cbMail.subject) && /only the counter-offer/i.test(cbMail.text) && (cbMail.text.match(/https:\/\/signed\.example/g) ?? []).length === 1)

  // confirm: a person turns a reading into a recorded response
  const msgs: any[] = dbC.tables.outside_offer_messages
  const mkInbound = (id: string, over: any = {}) => msgs.push({ id, brokerage_id: BRK, offer_id: OFFER, head_offer_id: cb.counterOfferId, direction: "inbound", kind: "seller_reply", message_key: `mid:${id}`, counterparty_email: LA_EMAIL, sender_auth: "pass", status: "awaiting_agent", document_ids: [], reading: { sender_verdict: { trusted: true, matchesRecorded: true, quarantine: false, reason: "ok" } }, ...over })
  dbC.tables.documents.push(
    { id: "90000006-0000-4000-8000-000000000006", brokerage_id: BRK, storage_url: pdfUrl("c1"), metadata: { file_name: "Contract.pdf" }, signature_completeness: null },
    { id: "90000007-0000-4000-8000-000000000007", brokerage_id: BRK, storage_url: pdfUrl("c2"), metadata: { file_name: "Contract signed.pdf" }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] } },
    { id: "90000008-0000-4000-8000-000000000008", brokerage_id: BRK, storage_url: pdfUrl("c3"), metadata: { file_name: "Seller Counter 4.pdf" }, signature_completeness: { signatures: [{ signer_role: "seller", signed: true }] } },
    { id: "90000010-0000-4000-8000-000000000010", brokerage_id: BRK, storage_url: pdfUrl("c4"), metadata: {}, signature_completeness: null },
  )
  mkInbound("90000011-0000-4000-8000-000000000011", { document_ids: ["90000006-0000-4000-8000-000000000006", "90000007-0000-4000-8000-000000000007"] })
  const noDoc = await A.confirmOutsideReply({ messageId: "90000011-0000-4000-8000-000000000011", decision: "accepted" })
  const unsignedDoc = await A.confirmOutsideReply({ messageId: "90000011-0000-4000-8000-000000000011", decision: "accepted", documentId: "90000006-0000-4000-8000-000000000006" })
  const foreignDoc = await A.confirmOutsideReply({ messageId: "90000011-0000-4000-8000-000000000011", decision: "accepted", documentId: "90000010-0000-4000-8000-000000000010" })
  check("CONFIRM (accept) REFUSES WHAT IT CANNOT PROVE: no document named; a document that does not show BOTH parties' signatures (naming the gap — an acceptance is the signed contract, not the email); a document that did not come with this reply — nothing is recorded in any of them",
    noDoc.success === false && /signed contract/.test(noDoc.error ?? "") && unsignedDoc.success === false && /buyer and seller signed/.test(unsignedDoc.error ?? "") && /not been read for signatures/.test(unsignedDoc.error ?? "") && foreignDoc.success === false && /did not come with this reply/.test(foreignDoc.error ?? "") && G.__143A.sellerResponses.length === 0)
  const accepted = await A.confirmOutsideReply({ messageId: "90000011-0000-4000-8000-000000000011", decision: "accepted", documentId: "90000007-0000-4000-8000-000000000007", note: "Verified on the contract." })
  const accRow: any = msgs.find((r: any) => r.id === "90000011-0000-4000-8000-000000000011")
  check("CONFIRM (accept) with the signed contract: recorded THROUGH THE SURVIVOR (recordSellerResponse, on the head the reply answered), the ledger row closes as confirmed with who/when/what, and no transaction is created here — that waits on execution + compliance",
    accepted.success && G.__143A.sellerResponses.length === 1 && G.__143A.sellerResponses[0].responseType === "accepted" && G.__143A.sellerResponses[0].offerId === cb.counterOfferId && G.__143A.sellerResponses[0].documentId === "90000007-0000-4000-8000-000000000007"
    && accRow.status === "confirmed" && accRow.resolved_by === U_AGENT && accRow.resolution.decision === "accepted" && !dbC.tables.transactions)
  const again = await A.confirmOutsideReply({ messageId: "90000011-0000-4000-8000-000000000011", decision: "rejected" })
  check("A CONFIRMED REPLY CANNOT BE CONFIRMED AGAIN (no double-recording)", again.success === false && /already confirmed/.test(again.error ?? "") && G.__143A.sellerResponses.length === 1)
  mkInbound("90000012-0000-4000-8000-000000000012", { sender_auth: "unknown", document_ids: ["90000008-0000-4000-8000-000000000008"], reading: { sender_verdict: { trusted: false, matchesRecorded: false, quarantine: false, reason: "assistant@otherbroker.example is not the listing agent recorded on this offer" } } })
  const needAck = await A.confirmOutsideReply({ messageId: "90000012-0000-4000-8000-000000000012", decision: "countered", documentId: "90000008-0000-4000-8000-000000000008", terms: { offer_price: 396000 } })
  check("AN UNVERIFIED SENDER needs the agent's explicit acknowledgement before anything it said is acted on — the refusal names why", needAck.success === false && needAck.needsSenderAcknowledgement === true && /not the listing agent recorded/.test(needAck.error ?? "") && G.__143A.sellerCounters.length === 0)
  const noTerms = await A.confirmOutsideReply({ messageId: "90000012-0000-4000-8000-000000000012", decision: "countered", documentId: "90000008-0000-4000-8000-000000000008", acknowledgeSender: true })
  const badTerm = await A.confirmOutsideReply({ messageId: "90000012-0000-4000-8000-000000000012", decision: "countered", documentId: "90000008-0000-4000-8000-000000000008", acknowledgeSender: true, terms: { nonsense: 1 } })
  dbC.tables.documents.push({ id: "90000009-0000-4000-8000-000000000009", brokerage_id: BRK, storage_url: pdfUrl("c5"), metadata: {}, signature_completeness: null })
  msgs.find((r: any) => r.id === "90000012-0000-4000-8000-000000000012").document_ids.push("90000009-0000-4000-8000-000000000009")
  const unsignedCounter = await A.confirmOutsideReply({ messageId: "90000012-0000-4000-8000-000000000012", decision: "countered", documentId: "90000009-0000-4000-8000-000000000009", acknowledgeSender: true, terms: { offer_price: 396000 } })
  check("CONFIRM (counter) needs the AGENT's confirmed terms (the AI's reading is a draft, never the record), terms inside the vocabulary, and a counter the SELLER signed",
    noTerms.success === false && /State the counter's terms/.test(noTerms.error ?? "") && badTerm.success === false && /nonsense/.test(badTerm.error ?? "") && unsignedCounter.success === false && /seller's signature/.test(unsignedCounter.error ?? "") && G.__143A.sellerCounters.length === 0)
  const countered: any = await A.confirmOutsideReply({ messageId: "90000012-0000-4000-8000-000000000012", decision: "countered", documentId: "90000008-0000-4000-8000-000000000008", acknowledgeSender: true, terms: { offer_price: 396000, closing_date: "2026-12-30", title_policy_payer: "buyer", inspection_period_days: 7 }, note: "Seller countered by email." })
  const sellerCounterRow = dbC.tables.offers.find((o: any) => o.id === countered.resultingOfferId)
  const tv2 = dbC.tables.contract_term_versions.find((v: any) => v.offer_id === countered.resultingOfferId)
  check("CONFIRM (counter, acknowledged sender): recorded THROUGH THE SURVIVOR recordSellerSignedCounter as a NEW versioned row under the head the reply answered, seller-signed document attached; the ALL confirmed terms (title policy, inspection days) ride the immutable record as PROPOSED; the chain head moves; the ledger closes with the acknowledgement on it",
    countered.success && G.__143A.sellerCounters.length === 1 && G.__143A.sellerCounters[0].source === "external" && G.__143A.sellerCounters[0].parentOfferId === cb.counterOfferId && G.__143A.sellerCounters[0].terms.counterPrice === 396000 && G.__143A.sellerCounters[0].sellerSignedDocumentUrl === pdfUrl("c3")
    && sellerCounterRow?.parent_offer_id === cb.counterOfferId && tv2?.status === "proposed" && tv2.terms.title_policy_payer === "buyer" && tv2.terms.inspection_period_days === 7
    && rootC().metadata.outside_loop.head_offer_id === countered.resultingOfferId && msgs.find((r: any) => r.id === "90000012-0000-4000-8000-000000000012").resolution.acknowledged_sender === true, JSON.stringify(countered))
  mkInbound("90000013-0000-4000-8000-000000000013", { document_ids: [] })
  const declined = await A.confirmOutsideReply({ messageId: "90000013-0000-4000-8000-000000000013", decision: "rejected", note: "Seller took another offer." })
  mkInbound("90000014-0000-4000-8000-000000000014", { document_ids: [] })
  const dismissed = await A.confirmOutsideReply({ messageId: "90000014-0000-4000-8000-000000000014", decision: "dismissed", note: "Not a response." })
  G.__143A.caller = { ok: true, userId: U_OTHER, brokerageId: BRK, userType: "agent" }
  mkInbound("90000015-0000-4000-8000-000000000015", { document_ids: [] })
  const notMine = await A.confirmOutsideReply({ messageId: "90000015-0000-4000-8000-000000000015", decision: "dismissed" })
  G.__143A.caller = asAgent
  check("CONFIRM (decline) records through the survivor; DISMISS closes the row with no state change; another agent cannot confirm this agent's reply",
    declined.success && G.__143A.sellerResponses.some((r: any) => r.responseType === "rejected") && dismissed.success && msgs.find((r: any) => r.id === "90000014-0000-4000-8000-000000000014").status === "dismissed" && notMine.success === false && /Only the offer's agent/.test(notMine.error ?? ""))
  const responded = await A.respondToOutsideCounter({ counterOfferId: countered.resultingOfferId, response: "reject", reason: "Too high" })
  const respondedBuyerRow = await A.respondToOutsideCounter({ counterOfferId: cb.counterOfferId, response: "reject" })
  check("RESPOND to the seller's newest counter delegates to the survivor respondToCounter; a buyer-issued row or an older round is refused", responded.success && G.__143A.counterResponses.length === 1 && G.__143A.counterResponses[0].response === "reject" && respondedBuyerRow.success === false)
  const inbox = await A.listOutsideOffers()
  const thread = inbox.threads.find((t: any) => t.offerId === OFFER)
  check("THE READER: the agent's inbox lists the outside offer with its recipient and how it was verified, the chain head (round, who issued it), the ledger of messages with readings, and what needs the agent — and never an in-house listing's offer",
    inbox.success && !!thread && thread.recipientEmail === LA_EMAIL && thread.headOfferId === countered.resultingOfferId && thread.headRound === 4 && thread.headIssuedBy === "seller_side" && thread.messages.length >= 4 && !inbox.threads.some((t: any) => t.offerId === LISTING_OFFER))
  check("…and shows the contract AS IT STANDS through the ONE reader: either a governing version or an explicit reason it could not be read — never a silent empty",
    !!thread
    && ((thread.governing !== null && typeof thread.governing.versionNo === "number" && typeof thread.governing.values === "object" && thread.governingError === null)
      || (thread.governing === null && (thread.governingError === null || typeof thread.governingError === "string"))))
  {
    const act = stripComments(readFileSync(join(process.cwd(), "app/actions/buyer-offer/outside-offer-loop.ts"), "utf8"))
    const readsThroughTheOneReader = (code: string) => /governingContractTerms\(\s*svc/.test(code) && !/from\("contract_term_versions"\)/.test(code)
    check("the inbox reads the terms ONLY through governingContractTerms (it never queries contract_term_versions itself), and POSITIVE CONTROL: the finder rejects a second reader",
      readsThroughTheOneReader(act) && !readsThroughTheOneReader(act + `\n svc.from("contract_term_versions").select("*")`))
  }

  // ═══ D · CONTRACT PRECEDENCE ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[D · contract precedence: an executed counter / addendum supersedes; proposed never governs; originals stay; ONE reader]")
  const v = (versionNo: number, source: any, status: any, executedAt: string | null, terms: any, offerId: string | null = `o${versionNo}`) => ({ versionNo, source, status, offerId, documentId: null, executedAt, terms, derived: true })
  const base = [
    v(1, "offer", "executed", "2026-01-05T00:00:00Z", { offer_price: 400000, closing_date: "2026-12-01", inspection_period_days: 10, title_policy_payer: "buyer" }),
    v(2, "counter", "executed", "2026-01-10T00:00:00Z", { offer_price: 395000, closing_date: "2026-12-15" }),
    v(3, "counter", "proposed", null, { offer_price: 390000 }),
    v(1, "addendum", "executed", "2026-01-20T00:00:00Z", { title_policy_payer: "seller", inspection_period_days: 7, financing_contingency_days: null }, null),
  ]
  const g = R.resolveGoverningTerms(base)
  check("THE RULE: the latest EXECUTED version naming a term governs it — the executed counter supersedes the original's price and closing date; the executed addendum supersedes the title-policy payer and the inspection days; a term nobody names keeps the original",
    g.values.offer_price === 395000 && g.values.closing_date === "2026-12-15" && g.values.title_policy_payer === "seller" && g.values.inspection_period_days === 7 && g.terms.offer_price.source === "counter" && g.terms.title_policy_payer.source === "addendum")
  check("A PROPOSED version NEVER governs (the 390,000 counter is pending, reported under `pending`); POSITIVE CONTROL: with the counter NOT executed the original price governs again",
    g.values.offer_price !== 390000 && g.pending.length === 1 && g.pending[0].terms.offer_price === 390000 && R.resolveGoverningTerms([base[0], { ...base[1], status: "proposed", executedAt: null }]).values.offer_price === 400000)
  check("ORIGINALS ARE PRESERVED and the conflicts are NAMED: every version is still returned (the original keeps price 400,000), and each superseded value is reported beside the governing one — what closing compliance needs to say 'the contract said buyer, the addendum moved it to seller'",
    g.versions.length === 4 && g.versions[0].terms.offer_price === 400000 && g.conflicts.some((c: any) => c.key === "title_policy_payer" && c.superseded.value === "buyer" && c.governing.value === "seller" && c.governing.source === "addendum")
    && g.conflicts.some((c: any) => c.key === "offer_price" && c.superseded.value === 400000 && c.governing.value === 395000) && g.governingVersion?.source === "addendum")
  check("A STRIKE GOVERNS AS NULL (an explicit null in a recorded version is a deliberate removal), and a term no executed version names has NO value (never defaulted)",
    "financing_contingency_days" in g.values && g.values.financing_contingency_days === null && !("earnest_money" in g.values) && g.terms.earnest_money === undefined)
  check("ORDER IS BY EXECUTION, not by number: an addendum executed BEFORE the counter loses the price to it, and executed AFTER wins",
    R.resolveGoverningTerms([v(1, "offer", "executed", "2026-01-01T00:00:00Z", { offer_price: 1 }), v(2, "counter", "executed", "2026-03-01T00:00:00Z", { offer_price: 2 }), v(1, "amendment", "executed", "2026-02-01T00:00:00Z", { offer_price: 3 }, null)]).values.offer_price === 2
    && R.resolveGoverningTerms([v(1, "offer", "executed", "2026-01-01T00:00:00Z", { offer_price: 1 }), v(2, "counter", "executed", "2026-03-01T00:00:00Z", { offer_price: 2 }), v(1, "amendment", "executed", "2026-04-01T00:00:00Z", { offer_price: 3 }, null)]).values.offer_price === 3
    && R.resolveGoverningTerms([v(1, "offer", "executed", "2026-01-01T00:00:00Z", { offer_price: 1 }), { ...v(2, "counter", "void", "2026-03-01T00:00:00Z", { offer_price: 2 }) }]).values.offer_price === 1)
  const row = (o: any) => ({ id: "r", parent_offer_id: null, offer_type: "standard", current_round: 1, status: "submitted", ...o })
  // is a single offers row an EXECUTED contract? (the predicate is private to the rule module; the version it yields says so)
  const exec = (r: any) => R.versionsFromOfferChain([r])[0].status === "executed"
  check("DERIVED FROM THE EXISTING CHAIN: an offers row names only the terms it holds (disclosed_* commission columns map to the governing keys); EXECUTED means accepted AND signed by both parties (or the ladder says fully_executed); a rejected row is void",
    JSON.stringify(R.versionsFromOfferChain([row({ offer_price: 400000, earnest_money: null, contingencies: [], disclosed_buyer_commission_pct: 2.5, disclosed_commission_payer: "seller" })])[0].terms) === JSON.stringify({ offer_price: 400000, buyer_agent_commission_pct: 2.5, commission_payer: "seller" })
    && exec(row({ status: "accepted", buyer_signed_at: "x", seller_signed_at: "y" })) && exec(row({ status: "accepted", esign_status: "fully_executed" })) && !exec(row({ status: "accepted", buyer_signed_at: "x" })) && !exec(row({ status: "submitted", buyer_signed_at: "x", seller_signed_at: "y" }))
    && R.versionsFromOfferChain([row({ status: "rejected" })])[0].status === "void" && R.versionsFromOfferChain([row({ id: "c", parent_offer_id: "r", current_round: 3, offer_type: "counter" })])[0].versionNo === 3)
  const incChain = R.versionsFromOfferChain([
    row({ id: "r", status: "countered", disclosed_buyer_commission_pct: 2.5, offer_price: 400000, created_at: "2026-01-01T00:00:00Z" }),
    row({ id: "c2", parent_offer_id: "r", offer_type: "counter", current_round: 2, status: "countered", offer_price: 395000, created_at: "2026-01-03T00:00:00Z" }),
    row({ id: "c3", parent_offer_id: "c2", offer_type: "counter", current_round: 3, status: "accepted", buyer_signed_at: "2026-01-09T00:00:00Z", seller_signed_at: "2026-01-08T00:00:00Z", offer_price: 392000, created_at: "2026-01-07T00:00:00Z" }),
    row({ id: "side", parent_offer_id: "r", offer_type: "counter", current_round: 2, status: "rejected", offer_price: 1, created_at: "2026-01-02T00:00:00Z" }),
  ])
  const incGov = R.resolveGoverningTerms(incChain)
  check("AN EXECUTED COUNTER INCORPORATES ITS CHAIN: the original and the earlier counter that led to it become EXECUTED layers at the moment the counter executed (the original 'stays part of the executed contract'), so a term only the original names — the commission disclosure, which counters do not carry — survives under the counter, while every term the counter changed goes to it; a rejected sibling never joins, and a merely-countered root with no seller signature is NOT executed",
    incChain.find((x: any) => x.offerId === "r").status === "executed" && incChain.find((x: any) => x.offerId === "c2").status === "executed" && incChain.find((x: any) => x.offerId === "side").status === "void"
    && incGov.values.offer_price === 392000 && incGov.values.buyer_agent_commission_pct === 2.5 && incGov.governingVersion?.versionNo === 3
    && R.versionsFromOfferChain([row({ id: "r", status: "countered", buyer_signed_at: "x" })])[0].status === "proposed" && exec(row({ status: "countered", buyer_signed_at: "x", seller_signed_at: "y" })) && !exec(row({ status: "countered", buyer_signed_at: "x" })))
  check("MERGE: a recorded EXECUTED row stands as written (offers rows stay editable); a recorded PROPOSED row's terms win but WHETHER it is executed follows the offers row (the confirmed counter governs the moment it executes); a derived row with no twin is used as it is",
    (() => {
      const rec = [{ versionNo: 9, source: "counter" as const, status: "proposed" as const, offerId: "o2", documentId: null, executedAt: null, terms: { title_policy_payer: "buyer" }, derived: false }, { versionNo: 1, source: "offer" as const, status: "executed" as const, offerId: "o1", documentId: null, executedAt: "2026-01-01T00:00:00Z", terms: { offer_price: 400000 }, derived: false }]
      const der = [{ ...v(1, "offer", "executed", "2026-01-05T00:00:00Z", { offer_price: 999 }, "o1") }, { ...v(2, "counter", "executed", "2026-01-10T00:00:00Z", { offer_price: 395000 }, "o2") }, { ...v(3, "counter", "proposed", null, { offer_price: 1 }, "o3") }]
      const m = R.mergeVersions(rec, der)
      const o1 = m.find((x: any) => x.offerId === "o1"), o2 = m.find((x: any) => x.offerId === "o2"), o3 = m.find((x: any) => x.offerId === "o3")
      return m.length === 3 && o1.terms.offer_price === 400000 && o2.status === "executed" && o2.versionNo === 2 && o2.terms.offer_price === 395000 && o2.terms.title_policy_payer === "buyer" && o3.derived === true
    })())

  // the ONE reader, live: a chain with an executed original, an executed counter, a pending counter-back
  const TXN = "e0000000-0000-4000-8000-000000000001"
  const ROOT_D = "f0000000-0000-4000-8000-000000000001", C2_D = "f0000000-0000-4000-8000-000000000002", C3_D = "f0000000-0000-4000-8000-000000000003"
  const dbD = mkDb([], {}, {})
  dbD.tables.offers.length = 0
  dbD.tables.offers.push(
    { id: ROOT_D, brokerage_id: BRK, agent_id: AG, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "countered", buyer_signed_at: "2026-01-02T00:00:00Z", seller_signed_at: "2026-01-04T00:00:00Z", fully_signed_contract_received_at: "2026-01-05T00:00:00Z", offer_price: 400000, closing_date: "2026-12-01", inspection_period_days: 10, transaction_id: TXN, created_at: "2026-01-01T00:00:00Z" },
    { id: C2_D, brokerage_id: BRK, agent_id: AG, parent_offer_id: ROOT_D, offer_type: "counter", current_round: 2, status: "accepted", buyer_signed_at: "2026-01-09T00:00:00Z", seller_signed_at: "2026-01-08T00:00:00Z", fully_signed_contract_received_at: "2026-01-10T00:00:00Z", offer_price: 395000, closing_date: "2026-12-15", inspection_period_days: 10, transaction_id: TXN, created_at: "2026-01-07T00:00:00Z" },
    { id: C3_D, brokerage_id: BRK, agent_id: AG, parent_offer_id: C2_D, offer_type: "counter", current_round: 3, status: "submitted", offer_price: 380000, created_at: "2026-01-12T00:00:00Z" },
  )
  const byOffer = await T.governingContractTerms(dbD, BRK, { offerId: C3_D })
  const byTxn = await T.governingContractTerms(dbD, BRK, { transactionId: TXN })
  check("THE ONE READER from either anchor: governingContractTerms(offerId) and (transactionId) resolve the SAME chain — the executed counter's price governs, the pending counter-back (380,000) does not, and the original is still in the list",
    byOffer.ok && byTxn.ok && byOffer.governing.values.offer_price === 395000 && byTxn.governing.values.offer_price === 395000 && byOffer.governing.pending.length === 1 && byOffer.governing.versions.length === 3 && byOffer.rootOfferId === ROOT_D && byTxn.transactionId === TXN
    && byOffer.governing.conflicts.some((c: any) => c.key === "offer_price" && c.superseded.value === 400000), JSON.stringify(byOffer.ok ? byOffer.governing.values : byOffer))
  const noTenant = await T.governingContractTerms(dbD, BRK2, { offerId: C3_D })
  const noRead = await T.governingContractTerms(mkDb([], {}, { refuse: { offers: "permission denied for table offers" } }), BRK, { offerId: OFFER })
  check("FAIL CLOSED: another brokerage reads nothing (the tenant is on every read); a REFUSED read is a returned reason, never an empty 'no terms'", noTenant.ok === false && noRead.ok === false && /permission denied/.test((noRead as any).reason))
  // the call EVERY offer → transaction promotion makes (the snapshot itself is private to it); effects are read off the record
  const freeze = () => T.freezeExecutedTermsAfterPromotion({ brokerageId: BRK, offerId: C3_D, transactionId: TXN, client: dbD })
  const rowsAtStart = dbD.tables.contract_term_versions.length
  await freeze()
  const frozen = dbD.tables.contract_term_versions.filter((r: any) => r.status === "executed")
  const rowsAfterFirst = dbD.tables.contract_term_versions.length
  await freeze()
  const rowsAfterSecond = dbD.tables.contract_term_versions.length
  dbD.tables.offers.find((o: any) => o.id === C2_D)!.offer_price = 1 // an agent edits the counter row after execution
  const afterEdit = await T.governingContractTerms(dbD, BRK, { transactionId: TXN })
  check("FROZEN AT PROMOTION: the executed original and the executed counter are written to the immutable record (the pending counter-back is not); a second promotion call writes nothing; and a LATER EDIT of the counter's offers row does not move the governing price (the record wins)",
    rowsAfterFirst - rowsAtStart === 2 && frozen.length === 2 && rowsAfterSecond === rowsAfterFirst && afterEdit.ok && afterEdit.governing.values.offer_price === 395000 && frozen.every((r: any) => r.transaction_id === TXN && r.evidence.snapshot === "offer_to_transaction_promotion"))
  const prop = dbD.tables.contract_term_versions.length
  dbD.tables.contract_term_versions.push({ id: "pre", brokerage_id: BRK, root_offer_id: ROOT_D, offer_id: C3_D, source: "counter", status: "proposed", version_no: 3, terms: { title_policy_payer: "buyer" }, executed_at: null, evidence: { issued_by: "buyer" } })
  dbD.tables.offers.find((o: any) => o.id === C3_D)!.status = "accepted"
  Object.assign(dbD.tables.offers.find((o: any) => o.id === C3_D)!, { buyer_signed_at: "2026-02-01T00:00:00Z", seller_signed_at: "2026-02-02T00:00:00Z" })
  await freeze()
  const frozen3: any = dbD.tables.contract_term_versions.find((r: any) => r.id === "pre")
  check("A PROPOSED version that later EXECUTES is frozen in place WITH its person-confirmed terms (title policy) merged over the row's columns — not duplicated", frozen3.status === "executed" && frozen3.terms.title_policy_payer === "buyer" && frozen3.terms.offer_price === 380000 && dbD.tables.contract_term_versions.length === prop + 1)
  // recordContractTermsVersion — nothing invents a signature
  const docsD = [
    { id: "90000016-0000-4000-8000-000000000016", brokerage_id: BRK, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] } },
    { id: "90000017-0000-4000-8000-000000000017", brokerage_id: BRK, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] } },
    { id: "90000018-0000-4000-8000-000000000018", brokerage_id: BRK2, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] } },
  ]
  dbD.tables.documents = docsD
  const rv = (o: any) => T.recordContractTermsVersion(dbD, { brokerageId: BRK, rootOfferId: ROOT_D, source: "addendum", status: "executed", terms: { title_policy_payer: "split" }, documentId: "90000017-0000-4000-8000-000000000017", recordedBy: U_AGENT, ...o })
  const rNoDoc = await rv({ documentId: null }), rOneSig = await rv({ documentId: "90000016-0000-4000-8000-000000000016" }), rForeign = await rv({ documentId: "90000018-0000-4000-8000-000000000018" }), rKey = await rv({ terms: { fudge: 1 } }), rEmpty = await rv({ terms: {} }), rNoAnchor = await rv({ rootOfferId: null })
  const rOk = await rv({}), rOk2 = await rv({ terms: { closing_date: "2027-01-15" } })
  const rProposed = await rv({ status: "proposed", documentId: null, terms: { earnest_money: 5000 } })
  check("RECORDING AN ADDENDUM invents nothing: an EXECUTED version needs a document that shows BOTH parties signed (none / one signature / another brokerage's document are refused by name); unknown term keys, empty terms and no anchor are refused; a signed one is accepted and numbered within its own source (Addendum 1, 2) so it can never collide with a counter round; a proposed one needs no document",
    !rNoDoc.ok && /executed document/.test((rNoDoc as any).reason) && !rOneSig.ok && /seller signed/.test((rOneSig as any).reason) && !rForeign.ok && /not in this brokerage/.test((rForeign as any).reason)
    && !rKey.ok && /fudge/.test((rKey as any).reason) && !rEmpty.ok && !rNoAnchor.ok && rOk.ok && (rOk as any).versionNo === 1 && rOk2.ok && (rOk2 as any).versionNo === 2 && rProposed.ok && (rProposed as any).versionNo === 3)
  const afterAdd = await T.governingContractTerms(dbD, BRK, { offerId: ROOT_D })
  check("…and the executed addendum now GOVERNS its term (title policy → split, the later addendum's closing date wins over the counter's) while the proposed one does not (earnest_money is unnamed)",
    afterAdd.ok && afterAdd.governing.values.title_policy_payer === "split" && afterAdd.governing.values.closing_date === "2027-01-15" && !("earnest_money" in afterAdd.governing.values) && afterAdd.governing.pending.some((p: any) => p.terms.earnest_money === 5000))
  {
    const t = "2026-05-01T23:59:59.999Z"
    const tie = R.resolveGoverningTerms([v(1, "offer", "executed", "2026-01-01T00:00:00Z", { offer_price: 1 }), v(2, "counter", "executed", t, { offer_price: 2 }), v(1, "addendum", "executed", t, { offer_price: 3 }, null)])
    const tie2 = R.resolveGoverningTerms([v(1, "addendum", "executed", t, { offer_price: 3 }, null), v(1, "amendment", "executed", t, { offer_price: 4 }, null), v(2, "counter", "executed", t, { offer_price: 2 })])
    check("A TIE IS BROKEN BY WHAT EACH VERSION IS, not by comparing version numbers across sources: at the same instant the addendum (version 1) follows the counter (version 2), and an amendment follows an addendum — POSITIVE CONTROL: ordering by version number alone would have let the counter win, which is exactly the defect this guards",
      tie.values.offer_price === 3 && tie2.values.offer_price === 4 && [2, 1].sort((a, b) => a - b)[1] === 2)
  }

  // THE DOOR for an executed addendum (the rule and the record already took one; nothing let a person record one — the missing half)
  const AD = await import("../app/actions/buyer-offer/record-contract-addendum")
  G.__143A.db = dbD
  G.__143A.caller = asAgent
  const DOC_ONE = "90000016-0000-4000-8000-000000000016", DOC_BOTH = "90000017-0000-4000-8000-000000000017", DOC_FOREIGN = "90000018-0000-4000-8000-000000000018"
  // signing days are derived from the clock (a hardcoded date is a waypoint that goes stale): two and one days ago
  const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const D1 = dayAgo(2), D2 = dayAgo(1)
  const door = (o: any = {}) => AD.recordContractAddendum({ offerId: ROOT_D, kind: "addendum", documentId: DOC_BOTH, terms: { earnest_money: 7500 }, executedOn: D1, ...o })
  const tomorrow2 = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  const bad: any[] = [
    await door({ transactionId: TXN }), await door({ offerId: undefined }), await door({ kind: "memo" }), await door({ documentId: "nope" }), await door({ terms: [] }),
    await door({ executedOn: "10/01/2026" }), await door({ executedOn: "2026-02-30" }), await door({ executedOn: tomorrow2 }),
  ]
  check("THE DOOR validates before it reads: both anchors, an unknown kind, a non-UUID document, a non-object, a US-format date, an impossible day and a date in the future are each refused by name",
    bad.every((r: any) => r.success === false && typeof r.error === "string") && /exactly one/.test(bad[0].error) && /Name the transaction OR/.test(bad[1].error) && /addendum or an amendment/.test(bad[2].error) && /future/.test(bad[7].error))
  const dOneSig = await door({ documentId: DOC_ONE }), dForeign = await door({ documentId: DOC_FOREIGN }), dKey = await door({ terms: { fudge: 1 } })
  check("…and it records NOTHING a document does not show: one signature, another brokerage's document and a term outside the vocabulary are refused by the recorder's own reasons",
    !dOneSig.success && /seller signed/.test(dOneSig.error!) && !dForeign.success && /not in this brokerage/.test(dForeign.error!) && !dKey.success && /fudge/.test(dKey.error!))
  const NOEXEC_D = "f0000000-0000-4000-8000-0000000000e1"
  dbD.tables.offers.push({ id: NOEXEC_D, brokerage_id: BRK, agent_id: AG, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "submitted", created_at: "2026-01-01T00:00:00Z" })
  const noContract = await AD.recordContractAddendum({ offerId: NOEXEC_D, kind: "addendum", documentId: DOC_BOTH, terms: { earnest_money: 1 }, executedOn: D1 })
  G.__143A.caller = { ok: true, userId: U_OTHER, brokerageId: BRK, userType: "agent" }
  const dStranger = await door()
  G.__143A.caller = { ok: true, userId: U_AGENT, brokerageId: BRK2, userType: "agent" }
  const dOtherTenant = await door()
  G.__143A.caller = { ok: false, error: "Not signed in" }
  const dAnon = await door()
  G.__143A.caller = asAgent
  check("FAIL CLOSED: an addendum on a contract nobody has executed is refused (nothing to amend); another agent, another brokerage and no session are refused — and none of them wrote a row",
    !noContract.success && /no executed contract to amend/.test(noContract.error!) && !dStranger.success && /contract's agent or a brokerage admin/.test(dStranger.error!) && !dOtherTenant.success && !dAnon.success
    && dbD.tables.contract_term_versions.every((r: any) => r.terms?.earnest_money !== 7500))
  const rowsBefore = dbD.tables.contract_term_versions.length
  const evBefore = G.__143A.events.length
  const dOk = await door()
  const govAfterDoor = await T.governingContractTerms(dbD, BRK, { offerId: ROOT_D })
  const rowAfter = dbD.tables.contract_term_versions.find((r: any) => r.terms?.earnest_money === 7500)
  check("THE AGENT RECORDS A SIGNED ADDENDUM: one new immutable row numbered within its own source, dated by the stated signing day (end of that day), carrying the document and who recorded it; it now GOVERNS earnest money (the proposed 5,000 stays pending); the originals are all still listed; and the event is on the record",
    dOk.success && dOk.versionNo === 4 && dbD.tables.contract_term_versions.length === rowsBefore + 1 && rowAfter?.source === "addendum" && rowAfter.status === "executed" && rowAfter.executed_at === `${D1}T23:59:59.999Z`
    && rowAfter.document_id === DOC_BOTH && rowAfter.recorded_by === U_AGENT && govAfterDoor.ok && govAfterDoor.governing.values.earnest_money === 7500 && govAfterDoor.governing.pending.some((p: any) => p.terms.earnest_money === 5000)
    && govAfterDoor.governing.versions.some((x: any) => x.source === "offer" && x.terms.offer_price === 400000) && G.__143A.events.length === evBefore + 1 && G.__143A.events[G.__143A.events.length - 1].input.event_type === "contract.addendum.recorded")
  G.__143A.caller = { ok: true, userId: U_OTHER, brokerageId: BRK, userType: "broker_admin" }
  const dAdmin = await door({ kind: "amendment", terms: { earnest_money: null }, executedOn: D2 })
  const govStrike = await T.governingContractTerms(dbD, BRK, { transactionId: TXN })
  G.__143A.caller = asAgent
  check("A TENANT ADMIN may record one for any agent's contract; an amendment is its own sequence (Amendment 1); a later executed amendment STRIKES the term (null governs) and the earlier addendum's value is reported as superseded",
    dAdmin.success && dAdmin.versionNo === 1 && govStrike.ok && "earnest_money" in govStrike.governing.values && govStrike.governing.values.earnest_money === null
    && govStrike.governing.conflicts.some((c: any) => c.key === "earnest_money" && c.superseded.value === 7500 && c.governing.value === null))

  // ═══ E · WIRING + MIGRATIONS ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[E · wiring and migrations: source scans (stripped; every absence has its positive control), m797 / m798 vs the code's vocabularies]")
  const hook = code("app/api/webhooks/inbound-mail/route.ts"), intake = code("lib/inbound-mail/offer-intake.ts"), act = code("app/actions/buyer-offer/outside-offer-loop.ts")
  const reader = code("lib/offers/outside-reply-reader.ts"), loop = code("lib/offers/outside-offer-loop.ts"), terms = code("lib/offers/governing-terms.ts")
  check("THE WEBHOOK carries the message's identity and authentication into the router, and a reply with NO PDF reaches it too (the old PDF gate silently dropped 'the seller accepts' and 'we countered, see below')",
    (hook.match(/messageId:\s*email\.messageId/g) ?? []).length >= 2 && (hook.match(/senderAuth:\s*email\.senderAuth/g) ?? []).length >= 2 && /!email\.attachments\.some\(\(a\) => a\.mime === "application\/pdf"\)/.test(hook) && /bodyText:\s+email\.bodyText/.test(hook))
  check("THE ROUTER matches by token, then thread, then sender through ONE pure picker, verifies the sender, CLAIMS the message before filing, and never writes a state it does not own (POSITIVE CONTROL: the finder sees `recordSellerResponse` in the confirm door)",
    /pickOutsideTarget\(/.test(intake) && /verifyOutsideSender\(/.test(intake) && intake.indexOf("claimInboundMessage(") < intake.indexOf("fileInboundPdfs(svc, {\n        brokerageId: input.brokerageId, listingId: root") && !/recordSellerResponse|recordSellerSignedCounter|createTransaction|acceptOffer\(/.test(intake) && /recordSellerResponse/.test(act))
  check("THE AI IS A READER: the reply reader touches no table (POSITIVE CONTROL: the ledger module has `.from(`), writes nothing, goes through the platform's one AI entry point, treats the email as untrusted data, and its terms are filtered to the one vocabulary",
    !/\.from\(/.test(reader) && /\.from\(/.test(loop) && /generateAIResponse/.test(reader) && /UNTRUSTED DATA/.test(reader) && /GOVERNING_TERM_KEYS/.test(reader) && !/createServiceClient|supabase/.test(reader))
  check("THE DOORS: every export of the 'use server' file is async (it is a public endpoint); the tenant is the SESSION's (requireCaller) and every statement is pinned to it; the egress is the ONE governed dispatchEmail, human-approved; documents travel as short-lived signed links; nothing here spells a signed state",
    !/export (?!async function|interface|type)/.test(act) && /requireCaller\(\)/.test(act) && (act.match(/requireCaller\(\)/g) ?? []).length === 5 && /\.eq\("brokerage_id", caller\.brokerageId\)/.test(act) && /dispatchEmail\(/.test(act) && /humanApproved:\s*true/.test(act) && /signedDocUrl\(/.test(act)
    && !/body\.brokerageId|params\.brokerageId/.test(act) && !/fully_executed|esign_status\s*:|signed_at\s*:/.test(act))
  check("THE PROMOTION FREEZES THE TERMS: the kernel creator, submit-to-compliance and convert-to-transaction each call freezeExecutedTermsAfterPromotion once the transaction exists; the reader and the writer are the only door to the record (POSITIVE CONTROL: the finder sees the table in governing-terms)",
    [code("lib/kernel/transactions.ts"), code("app/actions/buyer-offer/submit-to-compliance.ts"), code("app/actions/buyer-offer/convert-to-transaction.ts")].every((s) => /freezeExecutedTermsAfterPromotion\(/.test(s)) && /contract_term_versions/.test(terms)
    && [code("lib/kernel/transactions.ts"), code("app/actions/buyer-offer/submit-to-compliance.ts"), code("app/actions/buyer-offer/convert-to-transaction.ts"), act, intake].every((s) => !/from\("contract_term_versions"\)/.test(s)))
  {
    const addDoor = code("app/actions/buyer-offer/record-contract-addendum.ts"), inbox = code("app/dashboard/offers/outside-offer-threads.tsx"), page = code("app/dashboard/offers/page.tsx")
    const reachable = (ui: string) => /from "@\/app\/actions\/buyer-offer\/record-contract-addendum"/.test(ui) && /recordContractAddendum\(/.test(ui)
    check("THE ADDENDUM DOOR is a session-gated async endpoint (every export async, tenant from requireCaller, gate before the service client's first read), reads the contract through the ONE reader and writes through the ONE recorder, and a person can REACH it — the inbox imports and calls it (POSITIVE CONTROL: a UI without the import is not 'reachable')",
      !/export (?!async function)/.test(addDoor) && (addDoor.match(/requireCaller\(\)/g) ?? []).length === 1 && addDoor.indexOf("requireCaller()") < addDoor.indexOf("createServiceClient()") && /governingContractTerms\(/.test(addDoor) && /recordContractTermsVersion\(/.test(addDoor)
      && !/from\("contract_term_versions"\)/.test(addDoor) && !/body\.brokerageId|params\.brokerageId/.test(addDoor) && reachable(inbox) && !reachable(inbox.replace(/recordContractAddendum/g, "noop")))
    check("THE INBOX IS ON THE PAGE the agent opens (/dashboard/offers imports and renders it from the session-gated reader)", /OutsideOfferThreads/.test(page) && /listOutsideOffers\(\)/.test(page) && /initialThreads=\{outside\.threads\}/.test(page))
  }
  const m797 = existsSync(join(ROOT, "supabase/migrations/m797-contract-term-versions-the-authoritative-terms-record.sql")) ? read("supabase/migrations/m797-contract-term-versions-the-authoritative-terms-record.sql") : ""
  const m798 = existsSync(join(ROOT, "supabase/migrations/m798-outside-offer-messages-the-loop-ledger.sql")) ? read("supabase/migrations/m798-outside-offer-messages-the-loop-ledger.sql") : ""
  const inCheck = (sql: string, name: string) => ((sql.match(new RegExp(`${name}\\s+CHECK \\(\\w+ (?:IS NULL OR \\w+ )?IN \\(([^)]+)\\)`)) ?? [])[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean).sort().join()
  const same = (a: readonly string[]) => [...a].sort().join()
  check("m798's CHECK vocabularies EQUAL the code's (derived, never restated) — direction, kind, status, classification, recommended_action, sender_auth, recipient_verification — and the idempotency unique index is there; the table states its status on line 1 (applied live at integrationLIED",
    /^-- (WRITTEN, NOT APPLIED \(wave 143, lane 143A\)|── APPLIED LIVE )/.test(m798)
    && inCheck(m798, "outside_offer_messages_direction_check") === same(L.OUTSIDE_MESSAGE_DIRECTIONS) && inCheck(m798, "outside_offer_messages_kind_check") === same(L.OUTSIDE_MESSAGE_KINDS) && inCheck(m798, "outside_offer_messages_status_check") === same(L.OUTSIDE_MESSAGE_STATUSES)
    && inCheck(m798, "outside_offer_messages_classification_check") === same(L.OUTSIDE_REPLY_CLASSES) && inCheck(m798, "outside_offer_messages_recommended_action_check") === same(L.OUTSIDE_RECOMMENDED_ACTIONS)
    && inCheck(m798, "outside_offer_messages_sender_auth_check") === same(L.OUTSIDE_SENDER_AUTH) && inCheck(m798, "outside_offer_messages_recipient_verification_check") === same(L.OUTSIDE_RECIPIENT_VERIFICATIONS)
    && /UNIQUE INDEX IF NOT EXISTS outside_offer_messages_idempotency_uidx\s+ON public\.outside_offer_messages \(brokerage_id, offer_id, direction, message_key\)/.test(m798) && /ENABLE ROW LEVEL SECURITY/.test(m798))
  check("m797's CHECK vocabularies EQUAL the code's (source, status), the unique index numbers versions per SOURCE, the anchor/executed-instant constraints exist, and the table states its status on line 1 (applied live at integration) with RLS",
    /^-- (WRITTEN, NOT APPLIED \(wave 143, lane 143A\)|── APPLIED LIVE )/.test(m797) && inCheck(m797, "contract_term_versions_source_check") === same(R.TERM_VERSION_SOURCES) && inCheck(m797, "contract_term_versions_status_check") === same(R.TERM_VERSION_STATUSES)
    && /\(brokerage_id, COALESCE\(root_offer_id, transaction_id\), source, version_no\)/.test(m797) && /contract_term_versions_anchor_check/.test(m797) && /contract_term_versions_executed_has_instant_check/.test(m797) && /ENABLE ROW LEVEL SECURITY/.test(m797))
  check("THE GOVERNING VOCABULARY is the existing contract-term vocabulary EXTENDED, not restated: every CONTRACT_TERM_COLUMNS term is a governing key, plus offer_price / closing_date / earnest money / contingencies / the commission terms / title_policy_payer / title_company",
    (await import("../lib/transactions/contract-terms")).CONTRACT_TERM_COLUMNS.every((c: string) => (R.GOVERNING_TERM_KEYS as readonly string[]).includes(c)) && ["offer_price", "closing_date", "title_policy_payer", "commission_payer", "buyer_agent_commission_pct"].every((k) => (R.GOVERNING_TERM_KEYS as readonly string[]).includes(k)) && /\.\.\.CONTRACT_TERM_COLUMNS/.test(code("lib/offers/governing-terms-rule.ts")))
}

// ═══ F · THE GOVERNING PACKET (wave 144, lane 144C — owner ruling 2) ═════════════════════════════════════════════════════════════
// "If a counter is present and accepted, the ORIGINAL OFFER + the ACCEPTED COUNTER (+ required addenda) together are the executed
// contract; BOTH go through the compliance scan before anything becomes a transaction. Keep every document/version. Unaccepted
// counters never become terms. With several counters, the authoritative terms come from the actually accepted sequence, not the
// latest draft." Proved as RULES on the pure sequence, the ONE packet reader, the deal-file widening and the creation gate itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sectionF(T: any, R: any) {
  console.log("\n[F · the governing packet: original + ACCEPTED counter + executed addenda are ONE contract, scanned together, ONE transaction; unaccepted counters are kept and never terms]")
  const G = await import("../lib/transactions/transaction-creation-gate")
  const X = await import("../lib/transactions/offer-execution-state")
  const RO = "a1000000-0000-4000-8000-000000000001", C1 = "a1000000-0000-4000-8000-000000000002", C2 = "a1000000-0000-4000-8000-000000000003", C3 = "a1000000-0000-4000-8000-000000000004"
  const BUYER_C = "c0000000-0000-4000-8000-0000000000c1"
  const signedBoth = { buyer_signed_at: "2026-02-06T00:00:00Z", seller_signed_at: "2026-02-05T00:00:00Z", fully_signed_contract_received_at: "2026-02-06T00:00:00Z" }
  const chain = (over: Record<string, any> = {}) => [
    // the buyer's original offer — signed by the buyer, then countered by the seller (no seller signature on it)
    { id: RO, brokerage_id: BRK, contact_id: BUYER_C, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "countered", buyer_signed_at: "2026-02-01T00:00:00Z", offer_price: 400000, closing_date: "2026-12-01", disclosed_buyer_commission_pct: 2.5, created_at: "2026-02-01T00:00:00Z", ...(over[RO] ?? {}) },
    // the seller's FIRST counter — the buyer rejected it
    { id: C1, brokerage_id: BRK, contact_id: BUYER_C, parent_offer_id: RO, offer_type: "counter", current_round: 2, status: "rejected", seller_signed_at: "2026-02-02T00:00:00Z", offer_price: 410000, created_at: "2026-02-02T00:00:00Z", ...(over[C1] ?? {}) },
    // the seller's SECOND counter — the buyer signed it: the ACCEPTED counter (the e-sign loop's shape: status never set to accepted)
    { id: C2, brokerage_id: BRK, contact_id: BUYER_C, parent_offer_id: RO, offer_type: "counter", current_round: 2, status: "submitted", esign_status: "fully_signed", ...signedBoth, offer_price: 405000, closing_date: "2026-12-10", created_at: "2026-02-04T00:00:00Z", ...(over[C2] ?? {}) },
    // a LATER DRAFT counter-back nobody signed — the latest draft, never the terms
    { id: C3, brokerage_id: BRK, contact_id: BUYER_C, parent_offer_id: C2, offer_type: "counter", current_round: 3, status: "submitted", offer_price: 399000, created_at: "2026-02-08T00:00:00Z", ...(over[C3] ?? {}) },
  ]

  // ── PURE: the two readings of "executed" agree ──
  const c2 = chain()[2]
  const termsExecuted = (row: any) => R.versionsFromOfferChain([row])[0].status === "executed"
  // the wave-143 reading, restated ONLY as the mutant the positive control needs (status + signatures; the ONE definition ignored)
  const wave143Reading = (row: any) => (row.status === "accepted" || row.status === "countered") && (row.esign_status === "fully_executed" || !!row.fully_signed_contract_received_at || (!!row.buyer_signed_at && !!row.seller_signed_at))
  check("THE TWO READINGS OF 'EXECUTED' AGREE: a counter the e-sign loop stamped fully_signed (both signatures, contract on file, status never set to accepted) is fully executed by the ONE definition the gates refuse on AND executed for the terms — POSITIVE CONTROL: the wave-143 reading called it merely proposed (a transaction whose terms nobody governed)",
    X.isOfferFullyExecuted(c2) && termsExecuted(c2) && !wave143Reading(c2))
  check("…and never wider than void allows: a WITHDRAWN row with both signatures is executed for neither the terms nor the sequence",
    !termsExecuted({ ...c2, status: "withdrawn" }) && R.acceptedOfferSequence([...chain().slice(0, 2), { ...c2, status: "withdrawn" }], C2).ok === false)
  {
    // census over every shape in this proof: a row the ONE definition calls fully executed is executed for the terms (unless void)
    const shapes = [c2, { ...c2, status: "accepted" }, { ...c2, seller_signed_at: null, seller_response_type: "accepted" }, chain()[0], chain()[1], chain()[3]]
    const disagree = shapes.filter((s) => X.isOfferFullyExecuted(s) && !(["rejected", "withdrawn", "voided", "expired"].includes(s.status)) && !termsExecuted(s))
    check(`…census: of ${shapes.length} chain shapes, ${disagree.length} the gates call executed while the terms call it proposed (must be 0)`, disagree.length === 0)
  }

  // ── PURE: the accepted sequence ──
  const seq = R.acceptedOfferSequence(chain(), C2)
  check("THE ACCEPTED SEQUENCE of the accepted counter is [original offer, accepted counter] — the rejected first counter is excluded as void, the later unsigned counter-back as after-execution; nothing is dropped from the chain",
    seq.ok && seq.sequence.rootOfferId === RO && seq.sequence.headOfferId === C2 && seq.sequence.sequence.join() === [RO, C2].join()
    && seq.sequence.excluded.length === 2 && seq.sequence.excluded.some((e: any) => e.offerId === C1 && e.reason === "void") && seq.sequence.excluded.some((e: any) => e.offerId === C3 && e.reason === "after_execution")
    && seq.sequence.transactionIds.length === 0, JSON.stringify(seq))
  const gov = R.resolveGoverningTerms(R.versionsFromOfferChain(chain()))
  check("THE TERMS COME FROM THE ACCEPTED SEQUENCE, NOT THE LATEST DRAFT: price 405,000 (the accepted counter) — not 399,000 (the newest draft), not 410,000 (the rejected counter); the original's commission disclosure survives under the counter; both unaccepted counters are KEPT in the versions",
    gov.values.offer_price === 405000 && gov.values.closing_date === "2026-12-10" && gov.values.buyer_agent_commission_pct === 2.5 && gov.versions.length === 4 && gov.pending.some((p: any) => p.offerId === C3) && gov.versions.some((p: any) => p.offerId === C1 && p.status === "void"))
  const later = R.acceptedOfferSequence(chain({ [C3]: { ...signedBoth, buyer_signed_at: "2026-02-09T00:00:00Z", fully_signed_contract_received_at: "2026-02-09T00:00:00Z", seller_signed_at: "2026-02-08T00:00:00Z" } }), C2)
  const laterHead = R.acceptedOfferSequence(chain({ [C3]: { ...signedBoth, buyer_signed_at: "2026-02-09T00:00:00Z", fully_signed_contract_received_at: "2026-02-09T00:00:00Z", seller_signed_at: "2026-02-08T00:00:00Z" } }), C3)
  check("…once the counter-back IS signed it is the contract: promoting the earlier counter is REFUSED by name (later_execution), and the counter-back's sequence is [original, counter, counter-back]",
    !later.ok && later.code === "later_execution" && later.offerIds.join() === C3 && laterHead.ok && laterHead.sequence.sequence.join() === [RO, C2, C3].join())
  const competing = R.acceptedOfferSequence(chain({ [C1]: { status: "accepted", ...signedBoth } }), C2)
  check("TWO EXECUTED BRANCHES are never resolved by a guess: if the rejected counter also reads as executed, the promotion is refused (competing_execution) and a person must say which was accepted",
    !competing.ok && competing.code === "competing_execution" && competing.offerIds.join() === C1)
  check("…an unexecuted row is never a contract (not_executed); a chain whose parent link leaves the rows read is refused (broken_chain); an unknown row is refused (unknown_offer)",
    (R.acceptedOfferSequence(chain(), C3) as any).code === "not_executed" && (R.acceptedOfferSequence(chain().slice(1), C2) as any).code === "broken_chain" && (R.acceptedOfferSequence(chain(), "a1000000-0000-4000-8000-0000000000ff") as any).code === "unknown_offer")
  const withTxn = R.acceptedOfferSequence(chain({ [RO]: { transaction_id: "e1000000-0000-4000-8000-000000000001" } }), C2)
  check("ONE CONTRACT → ONE TRANSACTION: a transaction already created from ANY row of the chain is reported on the sequence", withTxn.ok && withTxn.sequence.transactionIds.join() === "e1000000-0000-4000-8000-000000000001")
  check("a VOID ancestor on the path is not part of the contract (the same reading the terms use): sequenceThrough drops it, the head is always kept",
    R.sequenceThrough(chain({ [RO]: { status: "withdrawn" } }), C2).join() === C2 && R.sequenceThrough(chain(), C2).join() === [RO, C2].join() && R.sequenceThrough(chain().slice(1), C2) === null)

  // ── LIVE: the ONE packet reader and the deal-file widening ──
  const DOC_ORIG = "d1000000-0000-4000-8000-000000000001", DOC_C2 = "d1000000-0000-4000-8000-000000000002", DOC_C1 = "d1000000-0000-4000-8000-000000000003", DOC_ADD = "d1000000-0000-4000-8000-000000000004"
  const both = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }] }
  const buyerOnly = { signatures: [{ signer_role: "buyer", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: true }] }
  const docs = (origSc: any = both) => [
    // the original offer's contract — filed against the ROOT only (no contact link): invisible to a head-only scan
    { id: DOC_ORIG, brokerage_id: BRK, contact_id: null, classification: "signed_contract", signature_completeness: origSc, status: "complete", metadata: { linked_offer_id: RO } },
    { id: DOC_C2, brokerage_id: BRK, contact_id: null, classification: "counter_offer", signature_completeness: both, status: "complete", metadata: { linked_offer_id: C2 } },
    // the REJECTED counter's paper — it rides in on the buyer's CONTACT link; it is not the contract
    { id: DOC_C1, brokerage_id: BRK, contact_id: BUYER_C, classification: "counter_offer", signature_completeness: { signatures: [{ signer_role: "seller", signed: true }], initials: [] }, status: "complete", metadata: { linked_offer_id: C1 } },
    // an executed addendum recorded against the contract (contract_term_versions.document_id)
    { id: DOC_ADD, brokerage_id: BRK, contact_id: null, classification: "addendum", signature_completeness: both, status: "complete", metadata: {} },
  ]
  const world = (o: { chainOver?: Record<string, any>; origSc?: any; refuse?: Record<string, string>; extraVersions?: any[] } = {}) => memSupabase({
    offers: chain(o.chainOver).map((r) => ({ ...r, financing_type: "conventional", compliance_passed_at: r.id === C2 ? "2026-02-07T00:00:00Z" : null, agent_id: AG })),
    documents: docs(o.origSc),
    contract_term_versions: [{ id: "v-add", brokerage_id: BRK, root_offer_id: RO, transaction_id: null, offer_id: null, document_id: DOC_ADD, version_no: 1, source: "addendum", status: "executed", executed_at: "2026-02-07T23:59:59Z", terms: { title_policy_payer: "seller" } }, ...(o.extraVersions ?? [])],
    activities: [{ id: "act-pass", brokerage_id: BRK, entity_type: "offer", entity_id: C2, activity_type: "buyer.offer.compliance.passed", status: "completed", created_at: "2026-02-07T00:00:00Z" }],
    brokerage_required_documents: [
      { id: "rq1", brokerage_id: BRK, is_required: true, deal_type: "buyer", classification: "signed_contract", scope_type: "brokerage", scope_id: BRK, block_on_missing: true, state_code: null },
      { id: "rq2", brokerage_id: BRK, is_required: true, deal_type: "buyer", classification: "counter_offer", scope_type: "brokerage", scope_id: BRK, block_on_missing: true, state_code: null },
      { id: "rq3", brokerage_id: BRK, is_required: true, deal_type: "buyer", classification: "addendum", scope_type: "brokerage", scope_id: BRK, block_on_missing: true, state_code: null },
    ],
  }, { refuse: o.refuse }) as any
  const pk = await T.governingOfferPacket(world(), BRK, C2)
  check("THE ONE PACKET READER (governingOfferPacket): the accepted sequence plus the EXECUTED addendum's document, every excluded row named",
    pk.ok && pk.packet.sequence.join() === [RO, C2].join() && pk.packet.addendumDocumentIds.join() === DOC_ADD && pk.packet.excluded.length === 2, JSON.stringify(pk))
  const pkForeign = await T.governingOfferPacket(world(), BRK2, C2)
  const pkRefused = await T.governingOfferPacket(world({ refuse: { contract_term_versions: "permission denied for table contract_term_versions" } }), BRK, C2)
  check("…another brokerage's session reads NO packet (refused: unknown_offer); a refused read is `unreadable` — nothing verified — never an empty packet",
    !pkForeign.ok && pkForeign.kind === "refused" && pkForeign.code === "unknown_offer" && !pkRefused.ok && pkRefused.kind === "unreadable" && /permission denied/.test(pkRefused.reason))
  if (pk.ok) {
    const db = world()
    const { auditOfferDocuments } = await import("../lib/compliance/required-documents")
    const head = await auditOfferDocuments(db, { offerId: C2, brokerageId: BRK, contactId: BUYER_C, dealType: "buyer", stage: "contract" as any })
    const req = head.required_breakdown.map((r: any) => r.classification)
    const headUnexec = G.findUnexecutedDocuments(head.deal_file, req)
    const widened = await G.widenAuditToGoverningPacket(db, BRK, head, pk.packet)
    check("POSITIVE CONTROL — the HEAD-ONLY scan (what both checkpoints ran before) misses the original contract and the addendum, and judges the REJECTED counter's paper as if it were the contract",
      head.unavailable_reason === null && head.missing_blocking.includes("signed_contract") && head.missing_blocking.includes("addendum") && headUnexec.some((u: any) => u.documentId === DOC_C1), JSON.stringify({ missing: head.missing_blocking, unexec: headUnexec.map((u: any) => u.documentId) }))
    check("BOTH INSTRUMENTS ARE SCANNED: the widened file holds the original contract, the accepted counter and the executed addendum — and nothing of the rejected counter (kept on the deal, not the contract)",
      widened.ok && widened.audit.deal_file.map((d: any) => d.id).sort().join() === [DOC_ORIG, DOC_C2, DOC_ADD].sort().join() && widened.audit.missing_blocking.length === 0 && widened.added === 2 && widened.dropped === 1
      && G.findUnexecutedDocuments(widened.audit.deal_file, req).length === 0, JSON.stringify(widened))
    const unsignedOriginal = world({ origSc: buyerOnly })
    const head2 = await auditOfferDocuments(unsignedOriginal, { offerId: C2, brokerageId: BRK, contactId: BUYER_C, dealType: "buyer", stage: "contract" as any })
    const w2 = await G.widenAuditToGoverningPacket(unsignedOriginal, BRK, head2, pk.packet)
    check("…so a required document of the ORIGINAL offer that lacks a signature now BLOCKS (it used to be invisible when the counter was submitted) — the brokerage's checklist decides which documents are required, nothing here invents one",
      w2.ok && G.findUnexecutedDocuments(w2.audit.deal_file, req).some((u: any) => u.documentId === DOC_ORIG && u.missingSignatures.includes("seller signature")))
    const w3 = await G.widenAuditToGoverningPacket(world({ refuse: { documents: "permission denied for table documents" } }), BRK, head, pk.packet)
    check("…a refused paperwork read FAILS CLOSED (ok:false) — never a narrower file that reads as clean", !w3.ok && /permission denied/.test(w3.error))
  }

  // ── LIVE: the creation gate — the authoritative WRITE refuses what the chain says is not the contract ──
  const gate = (db: any, offerId: string) => G.assertTransactionCreationAllowed(db, { brokerageId: BRK, offerId, contactIds: [BUYER_C], dealType: "buyer", door: "lane 144C proof" })
  const ok = await gate(world(), C2)
  check("THE GATE ALLOWS the accepted counter when the WHOLE packet is present and executed, and says so: the governing packet is on the verdict (2 instruments + 1 addendum, 2 chain rows kept and not judged)",
    ok.allowed && ok.detail.governingPacket?.sequence.join() === [RO, C2].join() && /governing packet was scanned as one contract: 2 instrument\(s\)/.test(ok.reason), ok.reason)
  const blockedOrig = await gate(world({ origSc: buyerOnly }), C2)
  check("…and REFUSES it when the ORIGINAL offer's required contract lacks the seller's signature (documents_fully_signed names that document)",
    !blockedOrig.allowed && blockedOrig.refusals.some((r: any) => r.requirement === "documents_fully_signed" && /Signed contract|signed contract/i.test(r.message)), blockedOrig.reason)
  const laterGate = await gate(world({ chainOver: { [C3]: { ...signedBoth, buyer_signed_at: "2026-02-09T00:00:00Z", fully_signed_contract_received_at: "2026-02-09T00:00:00Z" } } }), C2)
  check("…REFUSES the earlier counter once a later one executed (governing_packet), at the WRITE, whatever the UI showed", !laterGate.allowed && laterGate.refusals.some((r: any) => r.requirement === "governing_packet" && /later instrument/.test(r.message)))
  const twice = await gate(world({ chainOver: { [RO]: { transaction_id: "e1000000-0000-4000-8000-000000000001" } } }), C2)
  check("…REFUSES a SECOND transaction for one contract (a transaction already exists on the original offer's row)", !twice.allowed && twice.refusals.some((r: any) => r.requirement === "governing_packet" && /ONE transaction/.test(r.message)))
  const cannotRun = await gate(world({ refuse: { contract_term_versions: "permission denied for table contract_term_versions" } }), C2)
  check("…and a chain it cannot read is gate_could_not_run — nothing verified, nothing created", !cannotRun.allowed && cannotRun.refusals.every((r: any) => r.requirement === "gate_could_not_run"))

  // ── THE DEAL'S OWN SUBTYPE / REPRESENTATION reach the checklist (lane 144A Outside-lane 3) — read off the offer row, never inferred ──
  check("offerChecklistDimensions reads the deal's contract subtype / representation off the offer record through the ONE vocabulary; an unknown or absent value is null (never guessed)",
    JSON.stringify(G.offerChecklistDimensions({ metadata: { contract_subtype: "short_sale", representation: "dual_agency" } })) === JSON.stringify({ contractSubtype: "short_sale", representation: "dual_agency" })
    && G.offerChecklistDimensions({ metadata: { contract_subtype: "bogus", representation: 7 } }).contractSubtype === null && G.offerChecklistDimensions({ metadata: { representation: 7 } }).representation === null
    && G.offerChecklistDimensions(null).contractSubtype === null && G.offerChecklistDimensions({ metadata: [] }).representation === null)
  {
    // a brokerage rule that applies ONLY to short sales: a short-sale disclosure, blocking
    const withRule = (subtype: string | null) => {
      const db = world({ chainOver: { [C2]: subtype ? { metadata: { contract_subtype: subtype } } : {} } })
      db.tables.brokerage_required_documents.push({ id: "rq4", brokerage_id: BRK, is_required: true, deal_type: "buyer", classification: "disclosure", scope_type: "brokerage", scope_id: BRK, block_on_missing: true, state_code: null, contract_subtype: "short_sale" })
      return db
    }
    const shortSale = await gate(withRule("short_sale"), C2), standard = await gate(withRule("standard"), C2), unstated = await gate(withRule(null), C2)
    check("AT THE WRITE: a deal the offer says is a SHORT SALE is held to the short-sale rule (blocked, the disclosure named); a STANDARD deal is not; a deal that states nothing keeps the rule as a WARNING (allowed, named) — the resolver's fail-safe, unchanged",
      !shortSale.allowed && shortSale.refusals.some((r: any) => r.requirement === "required_documents_present" && /disclosure/i.test(r.message))
      && standard.allowed && !standard.detail.missingWarning.some((w: string) => /disclosure/i.test(w))
      && unstated.allowed && unstated.detail.missingWarning.some((w: string) => /disclosure/i.test(w)),
      JSON.stringify({ short: shortSale.reason, std: standard.detail.missingWarning, un: unstated.detail.missingWarning }))
  }

  // ── WIRING (stripped source; every absence has its positive control) ──
  const submit = code("app/actions/buyer-offer/submit-to-compliance.ts"), gateSrc = code("lib/transactions/transaction-creation-gate.ts"), closing = code("lib/transactions/closing-compliance.ts")
  check("THE COMPLIANCE CHECKPOINT reads the governing packet BEFORE it stamps anything, widens its scan with the gate's OWN widening, and records the packet on the gate event",
    submit.indexOf("governingOfferPacket(") > 0 && submit.indexOf("governingOfferPacket(") < submit.indexOf("compliance_passed_at:    now") && /widenAuditToGoverningPacket\(/.test(submit) && /governing_packet:/.test(submit))
  check("THE CREATION GATE (every transactions writer runs it) reads the packet and widens the deal file itself", /governingOfferPacket\(/.test(gateSrc) && /widenAuditToGoverningPacket\(supabase, params\.brokerageId, audit, governingPacket\)/.test(gateSrc))
  const depthOneChain = (s: string) => /\.or\(`id\.eq\.\$\{rootId\},parent_offer_id\.eq\.\$\{rootId\}`\)/.test(s)
  check("CLOSING COMPLIANCE reads the WHOLE chain through the ONE chain walk and incorporates only the accepted sequence (no depth-one root+children read, no 'every earlier round' incorporation left)",
    /loadOfferChainRows\(/.test(closing) && /sequenceThrough\(/.test(closing) && !depthOneChain(closing) && !/i < acceptedIdx/.test(closing))
  check("POSITIVE CONTROL — the depth-one finder catches the wave-143 chain read", depthOneChain("const { data } = await svc.from(\"offers\").select(C).or(`id.eq.${rootId},parent_offer_id.eq.${rootId}`)"))

  // ── LIVE: closing compliance compares the settlement against the ACCEPTED sequence, never a rejected sibling counter ──
  {
    const { runClosingCompliance } = await import("../lib/transactions/closing-compliance")
    const TX = "e2000000-0000-4000-8000-000000000001", ROOT = "a2000000-0000-4000-8000-000000000001", SIB = "a2000000-0000-4000-8000-000000000002", ACC = "a2000000-0000-4000-8000-000000000003"
    const SET = "d2000000-0000-4000-8000-000000000001"
    const both2 = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }] }
    const db = memSupabase({
      transactions: [{ id: TX, brokerage_id: BRK, offer_id: ACC, listing_id: null, deal_type: "buyer", agent_id: null, buyer_agent_id: null, seller_agent_id: null, property_state: "TX", financing_type: "conventional", purchase_price: 405000, close_date: "2026-12-10", earnest_money: 10000, closing_cost_contribution: 0, contract_date: "2026-02-06" }],
      offers: [
        { id: ROOT, brokerage_id: BRK, parent_offer_id: null, current_round: 1, status: "countered", offer_price: 400000, earnest_money: 10000, closing_date: "2026-12-01", closing_cost_contribution: 0, buyer_signed_at: "2026-02-01T00:00:00Z", created_at: "2026-02-01T00:00:00Z" },
        // the REJECTED sibling counter offered the buyer a $5,000 seller credit; the buyer rejected it
        { id: SIB, brokerage_id: BRK, parent_offer_id: ROOT, current_round: 2, status: "rejected", offer_price: 400000, earnest_money: 10000, closing_date: "2026-12-01", closing_cost_contribution: 5000, seller_signed_at: "2026-02-02T00:00:00Z", created_at: "2026-02-02T00:00:00Z" },
        // the ACCEPTED counter (a later round off the same original) carries no credit
        { id: ACC, brokerage_id: BRK, parent_offer_id: ROOT, current_round: 3, status: "accepted", offer_price: 405000, earnest_money: 10000, closing_date: "2026-12-10", closing_cost_contribution: 0, buyer_signed_at: "2026-02-06T00:00:00Z", seller_signed_at: "2026-02-05T00:00:00Z", fully_signed_contract_received_at: "2026-02-06T00:00:00Z", esign_status: "fully_executed", created_at: "2026-02-04T00:00:00Z" },
      ],
      documents: [
        { id: SET, brokerage_id: BRK, transaction_id: TX, classification: "closing_disclosure", classification_confidence: "high", extracted_fields: { sales_price: 405000, earnest_money_deposit: 10000, closing_date: "2026-12-10", seller_credit_to_buyer: 0 }, signature_completeness: null, created_at: "2026-11-20T12:00:00Z" },
        { id: "d2000000-0000-4000-8000-000000000002", brokerage_id: BRK, transaction_id: TX, classification: "signed_contract", classification_confidence: "high", extracted_fields: {}, signature_completeness: both2, created_at: "2026-02-07T12:00:00Z" },
      ],
      document_field_extractions: [], contract_term_versions: [], listings: [], transaction_participants: [], brokerage_required_documents: [], transaction_compliance_log: [],
      closing_disclosure_agreement: [{ id: "cda-1", brokerage_id: BRK, transaction_id: TX, preliminary_cd_document_id: SET, final_cd_document_id: null, updated_at: "2026-11-20T12:00:00Z" }],
    }) as any
    const deps = { notify: async () => 0, audit: async () => {}, closingEntity: async () => "title_company" as string | null }
    const run = await runClosingCompliance(db, { transactionId: TX, brokerageId: BRK, trigger: "settlement_scanned" }, deps as any)
    const credit = run.comparison?.findings.find((x: any) => x.term === "seller_credit")
    const price = run.comparison?.findings.find((x: any) => x.term === "purchase_price")
    check("CLOSING COMPLIANCE never takes a term from a REJECTED sibling counter: the accepted counter's price governs ($405,000), and the rejected counter's $5,000 seller credit is NOT a governing term the settlement is accused of missing",
      run.ran && price?.governing === "$405,000.00" && !(credit && /5,000/.test(String(credit.governing ?? ""))) && !(run.summary ?? []).some((s: string) => /5,000/.test(s)),
      JSON.stringify({ ran: run.ran, reason: run.reason, findings: run.comparison?.findings.map((x: any) => `${x.term}:${x.verdict}:${x.governing}|${x.settlement}`) }))

    // ── APPROVED AGENT CONCESSIONS are a governing term of their own (lane 144D Outside-lane 5 — owner ruling 4) ──
    const adj = (o: Record<string, unknown>) => ({ id: `ca-${Math.random().toString(16).slice(2, 10)}`, brokerage_id: BRK, transaction_id: TX, applies_to: "gross", direction: "credit", recipient_type: "buyer", value_type: "flat", is_active: true, settlement_treatment: "closing_statement_credit", approval_status: "approved", ...o })
    const withConcessions = (stmt: Record<string, unknown>, rows: Array<Record<string, unknown>>) => {
      const d2 = memSupabase(JSON.parse(JSON.stringify((db as any).tables))) as any
      d2.tables.transaction_compliance_log = []
      d2.tables.documents.find((x: any) => x.id === SET).extracted_fields = { sales_price: 405000, earnest_money_deposit: 10000, closing_date: "2026-12-10", seller_credit_to_buyer: 0, ...stmt }
      d2.tables.commission_adjustments = rows
      return d2
    }
    const term = async (d: any, t: string) => (await runClosingCompliance(d, { transactionId: TX, brokerageId: BRK, trigger: "settlement_scanned" }, deps as any)).comparison?.findings.find((x: any) => x.term === t)
    const rows = [
      adj({ value: 2500 }),                                                                 // approved — counts
      adj({ value: 1000, approval_status: "requested" }),                                   // awaiting the broker — never a term
      adj({ value: 500, approval_status: "denied", is_active: false }),                     // denied — never a term
      adj({ value: 3000, recipient_type: "seller", settlement_treatment: "reduced_commission_rate" }), // the listing agreement's reduced rate — not a statement credit
    ]
    const matched = await term(withConcessions({ agent_credit_to_buyer: 2500 }, rows), "agent_credit")
    const wrong = await term(withConcessions({ agent_credit_to_buyer: 3500 }, rows), "agent_credit")
    const unapproved = await term(withConcessions({ broker_credit_to_buyer: 1000 }, [adj({ value: 1000, approval_status: "requested" })]), "agent_credit")
    const sellerUntouched = await term(withConcessions({ agent_credit_to_buyer: 2500 }, rows), "seller_credit")
    check("AN APPROVED AGENT CONCESSION GOVERNS `agent_credit`: the broker-approved $2,500 credit to the buyer matches the statement's agent-credit line; a requested, a denied and a reduced-rate row never count",
      matched?.verdict === "match" && matched?.governing === "$2,500.00", JSON.stringify(matched))
    check("…a statement that credits a different amount is a BLOCKING mismatch; a credit the broker has NOT approved is never a governing term (the statement line stands alone and is flagged); the SELLER credit is a different term and is untouched",
      wrong?.verdict === "mismatch" && wrong?.blocking === true && unapproved?.verdict !== "match" && !unapproved?.governing && sellerUntouched?.governing !== "$2,500.00",
      JSON.stringify({ wrong, unapproved, sellerUntouched }))
    const pct = await term(withConcessions({ agent_credit_to_buyer: 2500 }, [adj({ value: 1, value_type: "percent" })]), "agent_credit")
    const refused = await runClosingCompliance((() => { const d = withConcessions({}, rows); return memSupabase(d.tables, { refuse: { commission_adjustments: "permission denied for table commission_adjustments" } }) })() as any, { transactionId: TX, brokerageId: BRK, trigger: "settlement_scanned" }, deps as any)
    check("…a PERCENT concession is not restated as dollars here (the engine owns that figure — the term is not half-stated); a REFUSED concession read is not 'no concessions' (the run does not report a clean comparison)",
      !pct?.governing && !(refused.ran && refused.comparison && refused.comparison.counts.blocking === 0 && refused.openBlocking === 0), JSON.stringify({ pct, refused: { ran: refused.ran, reason: refused.reason, ob: refused.openBlocking } }))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
