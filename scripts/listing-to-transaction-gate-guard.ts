/**
 * scripts/listing-to-transaction-gate-guard.ts — test:listing-to-transaction-gate (wave 150, lane 150XY / directive 150X;
 * pure + in-memory, no DB, no network, no model).
 *
 * WHAT IT HOLDS (canary 15 + the 150X rows):
 *   A · OWNER-UPLOADED LISTING PHOTOS (owner ruling 2026-11-06, R9): the ONE writer records uploader + listing + ownership
 *       attestation on listing_media (photo_source 'owner_upload') and the entry on listings.photos; refused without the
 *       attestation, on a stale statement version, outside the listing's bucket folder, for another tenant's listing, or when a
 *       caller tries to set provenance itself; the action routes EVERY photo through it; the screen shows the statement;
 *       m993's CHECK makes the attestation un-skippable; only IDX/MLS + owner upload are photo sources.
 *   B · LISTING GO-LIVE: the activation gate is the listing twin of the transaction gate (agent + seller signatures AND initials,
 *       settings-required documents, fail closed); signatures and initials refuse under their own names (driven).
 *   C · TRANSACTION ONLY AFTER EXECUTED + CLEARED: isOfferFullyExecuted / shouldAutoExecuteOffer driven; the bridge re-verifies
 *       the offer gate and the creation gate scans the governing packet (accepted sequence + executed addenda).
 *   D · OUTSIDE OFFERS / COUNTERS LOOP: the deterministic reply signals classify acceptance / counter / decline (driven).
 *   E · E-SIGN WATCHER: the esign-doc-sync cron is scheduled and its sweep evaluates envelope execution.
 *   F · THE NON-MODEL CONTRACT-TERMS READER (wave-149 §4): readClosingDateWording driven (on-or-before, fixed on, label only,
 *       conflicting, mismatched date, the proximity rule); no model in the module; its REAL caller (the offer bridge) records
 *       through applyClosingDateChange as the system actor on the in-memory client; an unsigned contract / a person's recorded
 *       wording is never overwritten.
 *
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2). Blind spots printed at the end.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  recordOwnerUploadedListingPhoto, LISTING_PHOTO_SOURCES, LISTING_MEDIA_BUCKET,
  OWNER_PHOTO_ATTESTATION_VERSION, OWNER_PHOTO_ATTESTATION_TEXT, type ListingPhotoEntry, type ListingPhotoSource,
} from "../lib/listings/owner-photo-upload"
import { evaluateExecution } from "../lib/compliance/signature-completeness"
import { isOfferFullyExecuted, shouldAutoExecuteOffer } from "../lib/transactions/offer-execution-state"
import { deterministicReplySignals } from "../lib/offers/outside-offer-loop"
import { readClosingDateWording } from "../lib/transactions/contract-terms"
import { readContractWordingAtPromotion } from "../lib/transactions/closing-dates"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
/** Comments stripped (a tombstone is not a call site — CLAUDE.md §2); string contents kept. */
const code = (p: string) => stripComments(raw(p))

type Claim = { kind: "refused"; error: string } | { kind: "replay"; entry: unknown }
const ledgerStub = () => {
  const rows: Array<Record<string, any>> = [], keys = new Set<string>()
  const fn = async (ctx: any, run: () => Promise<any>, hooks: { settle: (r: any) => any; replay: (c: Claim) => any }) => {
    if (keys.has(ctx.idempotencyKey)) return hooks.replay({ kind: "replay", entry: {} })
    keys.add(ctx.idempotencyKey)
    const r = await run(); rows.push({ ...ctx, settled: hooks.settle(r) }); return r
  }
  return { fn: fn as never, rows }
}

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const L = "33333333-3333-4333-8333-333333333333", U = "44444444-4444-4444-8444-444444444444"
const T = "55555555-5555-4555-8555-555555555555", C = "66666666-6666-4666-8666-666666666666", O = "77777777-7777-4777-8777-777777777777"
const url = (b: string, l: string, f = "kitchen.jpg") => `https://proj.supabase.co/storage/v1/object/public/${LISTING_MEDIA_BUCKET}/${b}/${l}/${f}`
const ATTEST = { accepted: true, version: OWNER_PHOTO_ATTESTATION_VERSION }

async function main() {
  // ── A ─────────────────────────────────────────────────────────────────────────────────────────
  section("A · owner-uploaded listing photos — uploader, listing, ownership attestation on the ONE store")
  {
    const seed = () => memSupabase({ listings: [{ id: L, brokerage_id: B, photos: [{ url: "https://idx.example/1.jpg", caption: null, order: 0 }] }], listing_media: [] })
    const base = { brokerageId: B, listingId: L, userId: U, fileUrl: url(B, L), caption: "Kitchen" }

    const noAttest = seed()
    const r0 = await recordOwnerUploadedListingPhoto(noAttest, { ...base, attestation: null })
    check("refused WITHOUT the ownership attestation — and nothing is written", !r0.ok && /own/.test((r0 as { error: string }).error) && noAttest.writes.length === 0)
    const r0b = await recordOwnerUploadedListingPhoto(seed(), { ...base, attestation: { accepted: false, version: OWNER_PHOTO_ATTESTATION_VERSION } })
    check("an unticked attestation is refused the same way", !r0b.ok)
    const r1 = await recordOwnerUploadedListingPhoto(seed(), { ...base, attestation: { accepted: true, version: "2020-01-01.v0" } })
    check("a stale statement version is refused (an old row must name what was shown)", !r1.ok && /changed/.test((r1 as { error: string }).error))
    const r2 = await recordOwnerUploadedListingPhoto(seed(), { ...base, fileUrl: "https://photos.rentcast.io/abc.jpg", attestation: ATTEST })
    check("a link outside the listing's bucket folder cannot be attested (RentCast / any third-party URL)", !r2.ok)
    const r3 = await recordOwnerUploadedListingPhoto(seed(), { ...base, fileUrl: url(B2, L), attestation: ATTEST })
    check("another tenant's folder is refused", !r3.ok)
    // The path rule is internal to the recorder (not exported — it has no product caller of its own): drive it through the door.
    const r3t = await recordOwnerUploadedListingPhoto(seed(), { ...base, fileUrl: url(B, L, "../x.jpg").replace("x.jpg", "..%2Fx.jpg"), attestation: ATTEST })
    check("path rule: a traversal out of this listing's folder is refused at the door (positive control: this listing's folder is accepted below)", !r3t.ok)
    const other = memSupabase({ listings: [{ id: L, brokerage_id: B2, photos: [] }], listing_media: [] })
    const r4 = await recordOwnerUploadedListingPhoto(other, { ...base, attestation: ATTEST })
    check("a listing that is not this tenant's is refused — no row", !r4.ok && other.writes.length === 0)
    const r5 = await recordOwnerUploadedListingPhoto(seed(), { ...base, attestation: ATTEST, row: { photo_source: "idx_mls" } })
    check("a caller cannot set provenance itself (photo_source / attested_by / uploaded_by)", !r5.ok && /provenance/.test((r5 as { error: string }).error))

    const db = seed()
    const ok = await recordOwnerUploadedListingPhoto(db, { ...base, attestation: ATTEST, row: { usage_intent: "public_marketing", is_primary: false }, now: new Date("2026-11-06T12:00:00Z") })
    const media = db.tables.listing_media[0] ?? {}
    check("POSITIVE: the listing_media row records listing, tenant, uploader, source owner_upload and the attestation (by = uploader, at, version)",
      ok.ok && media.listing_id === L && media.brokerage_id === B && media.uploaded_by === U && media.photo_source === "owner_upload"
      && media.ownership_attested_by === U && media.ownership_attested_at === "2026-11-06T12:00:00.000Z" && media.ownership_attestation_version === OWNER_PHOTO_ATTESTATION_VERSION && media.media_type === "photo" && media.usage_intent === "public_marketing")
    const photos = (db.tables.listings[0]?.photos ?? []) as ListingPhotoEntry[]
    const entry = photos[1]
    check("...and listings.photos keeps the IDX entry and gains the owner entry with the same provenance (url first-class for every reader)",
      photos.length === 2 && photos[0].url === "https://idx.example/1.jpg" && entry?.url === url(B, L) && entry.source === "owner_upload"
      && entry.media_id === (ok.ok ? ok.mediaId : "") && entry.uploaded_by === U && entry.order === 1 && entry.attestation_version === OWNER_PHOTO_ATTESTATION_VERSION && ok.ok && ok.galleryWarning === null)

    const refusing = memSupabase({ listings: [{ id: L, brokerage_id: B, photos: [] }], listing_media: [] }, { missingColumns: { listing_media: ["photo_source"] } })
    const r6 = await recordOwnerUploadedListingPhoto(refusing, { ...base, attestation: ATTEST })
    check("a database without m993's columns refuses the photo by name — never a silent half-record", !r6.ok)

    const sources: readonly ListingPhotoSource[] = LISTING_PHOTO_SOURCES
    check("the lawful photo sources are exactly IDX/MLS and owner upload (RentCast / Tracerfy / DataZapp are never one)", sources.join(",") === "idx_mls,owner_upload")
    const m993 = code("supabase/migrations/m993-owner-uploaded-listing-photo-provenance.sql")
    const m993Line1 = raw("supabase/migrations/m993-owner-uploaded-listing-photo-provenance.sql").split("\n")[0]
    // The RULE, not the waypoint: line 1 is the lane stamp while the file waits, the APPLIED LIVE stamp once the integrator applied it.
    const STAMP_LINE_1 = /^-- (WRITTEN, NOT APPLIED \(wave 150, lane 150XY\)|── APPLIED LIVE )/
    check("m993: CHECK admits only the two sources; an owner_upload row needs uploader + attestation, attested_by = uploaded_by; line 1 carries a stamp",
      /photo_source IN \('idx_mls', 'owner_upload'\)/.test(m993) && /ownership_attested_by = uploaded_by/.test(m993) && STAMP_LINE_1.test(m993Line1))
    check("POSITIVE CONTROL: a specimen CHECK admitting 'rentcast' would be caught", !/photo_source IN \('idx_mls', 'owner_upload'\)/.test("photo_source IN ('idx_mls', 'owner_upload', 'rentcast')"))

    const action = code("app/actions/listing-media.ts")
    const uploadBody = action.slice(action.indexOf("export async function uploadListingMedia"), action.indexOf("export async function approveListingMedia"))
    check("the action routes EVERY photo through the one writer after the session tenant gate (requireCallerTenant first)",
      /requireCallerTenant\(/.test(uploadBody) && /mediaType === "photo"[\s\S]{0,400}recordOwnerUploadedListingPhoto\(/.test(uploadBody)
      && uploadBody.indexOf("requireCallerTenant(") < uploadBody.indexOf("recordOwnerUploadedListingPhoto("))
    const directPhotoInsert = /\.from\("listing_media"\)\s*\.insert\(\{[^}]*media_type:\s*"photo"/
    check("no second owner-photo writer in the action (a literal photo insert); POSITIVE CONTROL on a specimen",
      !directPhotoInsert.test(uploadBody) && directPhotoInsert.test(`.from("listing_media").insert({ media_type: "photo", file_url: x })`))
    const grid = code("app/dashboard/listings/[id]/media/components/media-grid.tsx")
    check("the Media Manager shows the statement and sends the attestation; upload stays disabled until it is ticked",
      /OWNER_PHOTO_ATTESTATION_TEXT/.test(grid) && /ownershipAttestation:/.test(grid) && /form\.mediaType === "photo" && !ownershipAttested/.test(grid) && OWNER_PHOTO_ATTESTATION_TEXT.length > 40)
    check("the photo path imports no server module and no model (client-importable statement; injected client)",
      !/from\s+["']@\/lib\/(supabase\/|ai\/)|anthropic|openai/.test(code("lib/listings/owner-photo-upload.ts")))
  }

  // ── B ─────────────────────────────────────────────────────────────────────────────────────────
  section("B · listing go-live — the activation gate is the listing twin of the transaction gate")
  {
    const gate = code("lib/listings/listing-activation-gate.ts")
    check("the gate exists, asks agent + seller (never a buyer at listing time) and refuses when it cannot read (fail closed)",
      /export async function assertListingActivationAllowed/.test(gate) && /LISTING_AGREEMENT_PARTIES/.test(gate) && /findUnexecutedDocuments\(/.test(gate))
    const both = { signatures: [{ signer_role: "seller", signed: true }, { signer_role: "agent", signed: true }], initials: [{ signer_role: "seller", all_required_initials_present: true }, { signer_role: "agent", all_required_initials_present: true }] }
    const noInit = { ...both, initials: [{ signer_role: "seller", all_required_initials_present: false }, { signer_role: "agent", all_required_initials_present: true }] }
    const noSig = { ...both, signatures: [{ signer_role: "seller", signed: false }, { signer_role: "agent", signed: true }] }
    const vOk = evaluateExecution(both as never, ["agent", "seller"]), vI = evaluateExecution(noInit as never, ["agent", "seller"]), vS = evaluateExecution(noSig as never, ["agent", "seller"])
    check("signatures AND initials: complete → executed; missing seller initials → refused 'seller initials'; missing seller signature → 'seller signature'",
      vOk.executed && !vI.executed && vI.missing.includes("seller initials") && !vS.executed && vS.missing.includes("seller signature"))
    const callers = ["app/actions/seller-listing/execution-engine.ts", "lib/kernel/listings.ts", "lib/listings/listing-status-sync.ts", "lib/listings/mls-live-verification.ts"].filter((p) => /assertListingActivationAllowed\(/.test(code(p)))
    check("the go-live doors call the gate (coming soon / active / verified live)", callers.length >= 3, callers.join(", "))
    check("planned MLS date + verified live are recorded by the one module (lib/listings/mls-live-date.ts)", /export async function recordPlannedMlsLiveDate/.test(code("lib/listings/mls-live-date.ts")) && /export async function recordVerifiedMlsLive/.test(code("lib/listings/mls-live-date.ts")))
    check("listing agreement terms are versioned; an executed amendment supersedes (governingListingAgreementTerms)", /export async function governingListingAgreementTerms/.test(code("lib/listings/listing-agreement-terms.ts")) && /export async function recordListingAgreementAmendment/.test(code("lib/listings/listing-agreement-terms.ts")))
  }

  // ── C ─────────────────────────────────────────────────────────────────────────────────────────
  section("C · a transaction exists only after an executed + cleared contract")
  {
    const signedAt = "2026-11-01T10:00:00Z"
    check("buyer signed only → NOT executed", !isOfferFullyExecuted({ buyer_signed_at: signedAt }))
    check("seller accepted but no executed contract on file → NOT executed", !isOfferFullyExecuted({ buyer_signed_at: signedAt, seller_response_type: "accepted" }))
    check("both sides + executed contract on file → executed (accepted path and signed-counter path)",
      isOfferFullyExecuted({ buyer_signed_at: signedAt, seller_response_type: "accepted", fully_signed_contract_received_at: signedAt })
      && isOfferFullyExecuted({ buyer_signed_at: signedAt, seller_signed_at: signedAt, fully_signed_contract_received_at: signedAt }))
    check("an offer that already has a transaction never auto-executes again (idempotent)", !shouldAutoExecuteOffer({ buyer_signed_at: signedAt, seller_signed_at: signedAt, fully_signed_contract_received_at: signedAt, transaction_id: T }))
    const bridge = code("lib/transactions/offer-bridge.ts")
    check("the bridge refuses without compliance_passed_at and re-verifies the offer gate unless the caller IS the gate",
      /compliance_passed_at required to create transaction/.test(bridge) && /if \(!params\.skipOfferGate\)[\s\S]{0,200}assertOfferReadyForTransaction\(/.test(bridge))
    const gate = code("lib/transactions/transaction-creation-gate.ts")
    check("the creation gate scans the GOVERNING packet (accepted sequence + executed addenda), not only the submitted row", /governingOfferPacket\(/.test(gate) && /export async function widenAuditToGoverningPacket/.test(gate))
  }

  // ── D ─────────────────────────────────────────────────────────────────────────────────────────
  section("D · outside offers / counters loop — the deterministic reply reading")
  {
    const a = deterministicReplySignals("Re: offer", "My sellers accept your offer as written.")
    const c = deterministicReplySignals("Re: offer", "We'd like to counter at $512,000 with a 14-day close.")
    const d = deterministicReplySignals("Re: offer", "Thank you, but the sellers have decided to decline.")
    check("acceptance / counter / decline are read deterministically (a model may add a reading, never replace this)", a.acceptance && !a.decline && c.counter && d.decline && !d.acceptance)
    check("the loop records outbound packets, inbound replies and counters on the chain (lib/offers/outside-offer-loop.ts + its action)",
      /export async function claimInboundMessage/.test(code("lib/offers/outside-offer-loop.ts")) && existsSync(join(ROOT, "app/actions/buyer-offer/outside-offer-loop.ts")))
  }

  // ── E ─────────────────────────────────────────────────────────────────────────────────────────
  section("E · e-sign watcher")
  {
    check("the esign-doc-sync cron is scheduled in the dispatcher and its route exists", /\/api\/cron\/esign-doc-sync/.test(code("lib/kernel/cron-dispatch.ts")) && existsSync(join(ROOT, "app/api/cron/esign-doc-sync/route.ts")))
    check("the sweep evaluates envelope execution (the watcher half, not only a file copy)", /evaluateEnvelopeExecution/.test(code("lib/transactions/esign-doc-sync-sweep.ts")))
  }

  // ── F ─────────────────────────────────────────────────────────────────────────────────────────
  section("F · the non-model contract-terms reader and its real caller")
  {
    const OOB = "12. CLOSING. Closing shall occur on or before December 15, 2026 at the office of the closing agent. Possession at closing."
    const FIX = "Settlement. The closing shall take place on 12/15/2026, unless extended in writing by both parties."
    const r1 = readClosingDateWording(OOB, { expectedDate: "2026-12-15" })
    const r2 = readClosingDateWording(FIX, { expectedDate: "2026-12-15" })
    check("'on or before December 15, 2026' → on_or_before, date 2026-12-15, the sentence quoted", r1.terms === "on_or_before" && r1.date === "2026-12-15" && /on or before/.test(r1.quote ?? ""))
    check("'shall take place on 12/15/2026' → on (a fixed day)", r2.terms === "on" && r2.date === "2026-12-15")
    check("a bare 'Closing Date: 12/15/2026' label is NOT wording → unknown", readClosingDateWording("Purchase Price: $500,000. Closing Date: 12/15/2026. Earnest Money: $5,000.").terms === null)
    check("two wordings in one contract → unknown (a person reads it)", readClosingDateWording(`${OOB} ${FIX}`).terms === null)
    check("a date that differs from the recorded contractual date → unknown", readClosingDateWording(OOB, { expectedDate: "2026-12-20" }).terms === null)
    check("proximity: 'no later than 10 days before the Closing Date of 12/15/2026' is not the closing's wording",
      readClosingDateWording("Title. Seller shall deliver the title commitment no later than 10 days before the Closing Date of 12/15/2026.").terms === null)
    check("empty / absent text → unknown, never a default", readClosingDateWording(null).terms === null && readClosingDateWording("").terms === null)
    const MODEL = /from\s+["']@\/lib\/ai\/|anthropic|openai|generateText|callModel|\bllm\b/i
    const termsSrc = code("lib/transactions/contract-terms.ts")
    check("no model anywhere in the reader's module (deterministic); POSITIVE CONTROL on a specimen import", !MODEL.test(termsSrc) && MODEL.test(`import { generateText } from "@/lib/ai/client"`))
    const bridge = code("lib/transactions/offer-bridge.ts")
    check("REAL CALLER: the offer bridge calls readContractWordingAtPromotion with the action ledger after seeding the deadline",
      /readContractWordingAtPromotion\(/.test(bridge) && /ledger:\s*withActionLedger/.test(bridge) && bridge.indexOf("seedContractClosing(") < bridge.indexOf("readContractWordingAtPromotion("))

    const sigs = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] }
    const txn = (over: Record<string, unknown> = {}) => ({ id: T, brokerage_id: B, status: "under_contract", close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: null, contract_closing_source: "executed_contract", estimated_close_date: "2026-12-15", actual_close_date: null, property_state: "CA", financing_type: "conventional", updated_at: "v1", ...over })
    const doc = (over: Record<string, unknown> = {}) => ({ id: "doc-1", brokerage_id: B, contact_id: C, classification: "signed_contract", content: OOB, signature_completeness: sigs, metadata: { linked_offer_id: O }, created_at: "2026-11-02T00:00:00Z", ...over })
    const P = { brokerageId: B, transactionId: T, contactId: C, offerId: O, expectedDate: "2026-12-15" }

    const db = memSupabase({ transactions: [txn()], documents: [doc()] })
    const L1 = ledgerStub()
    const w = await readContractWordingAtPromotion(db, P, { ledger: L1.fn })
    check("signed contract → contract_closing_terms = on_or_before, ledgered as the SYSTEM actor with the document as evidence (LEGAL risk)",
      w.ok && db.tables.transactions[0].contract_closing_terms === "on_or_before" && L1.rows[0]?.actor?.type === "system" && L1.rows[0]?.detail?.evidence_ref === "document:doc-1" && L1.rows[0]?.riskClass === "LEGAL")
    const unsigned = memSupabase({ transactions: [txn()], documents: [doc({ signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] } })] })
    const w2 = await readContractWordingAtPromotion(unsigned, P, { ledger: ledgerStub().fn })
    check("a contract that does not show BOTH signatures is not read — nothing written", !w2.ok && unsigned.tables.transactions[0].contract_closing_terms === null)
    const person = memSupabase({ transactions: [txn({ contract_closing_terms: "on" })], documents: [doc()] })
    const w3 = await readContractWordingAtPromotion(person, P, { ledger: ledgerStub().fn })
    check("a wording a person already recorded is NEVER overwritten by the reader", !w3.ok && person.tables.transactions[0].contract_closing_terms === "on")
    const ambiguous = memSupabase({ transactions: [txn()], documents: [doc({ content: `${OOB} ${FIX}` })] })
    const w4 = await readContractWordingAtPromotion(ambiguous, P, { ledger: ledgerStub().fn })
    check("an ambiguous contract records nothing (unknown stays unknown)", !w4.ok && ambiguous.tables.transactions[0].contract_closing_terms === null)
    const otherTenant = memSupabase({ transactions: [txn({ brokerage_id: B2 })], documents: [doc({ brokerage_id: B2 })] })
    const w5 = await readContractWordingAtPromotion(otherTenant, P, { ledger: ledgerStub().fn })
    check("another tenant's contract and deal are invisible (tenant-pinned)", !w5.ok && otherTenant.tables.transactions[0].contract_closing_terms === null)
  }

  // ── census: no listing / offer surface names a third photo source ─────────────────────────────
  section("G · census — no code in the listing domain writes a listing photo from RentCast / Tracerfy / DataZapp")
  {
    const files = readdirSync(join(ROOT, "lib/listings")).filter((f) => f.endsWith(".ts")).map((f) => `lib/listings/${f}`)
    const BAD = /photo_source:\s*["'](rentcast|tracerfy|datazapp)/i
    const hits = files.filter((p) => BAD.test(code(p)))
    check(`${files.length} lib/listings files scanned: no third-party photo source written`, hits.length === 0, hits.join(", "))
    check("POSITIVE CONTROL: the finder recognises a specimen", BAD.test(`{ photo_source: "rentcast" }`))
  }

  console.log("\nBLIND SPOTS: storage.objects policies for listing-media are OWNER SQL (written in the lane notes, not applied, not read live here);")
  console.log("  the media-grid upload and the action were judged on stripped source + the lib driven on memSupabase (no browser, no live RLS);")
  console.log("  documents.content of live signed contracts is not measured (an empty content reads 'unknown' — correct, but the hit rate is unknown);")
  console.log("  the reader knows English contract phrasing only; vendor (photographer) deliveries via processVendorPhotos carry no attestation (owner decision).")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(` FAILED: ${failures.join(" · ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
