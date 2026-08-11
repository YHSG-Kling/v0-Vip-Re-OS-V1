#!/usr/bin/env tsx
/**
 * scripts/inbound-offer-lane-simulator.ts   (npm run test:inbound-offer-lane)
 * ─────────────────────────────────────────────────────────────────────────────
 * AN OFFER FROM AN OUTSIDE BUYER'S AGENT MUST BE ABLE TO BECOME A TRANSACTION.
 *
 * Owner's ruling: "there are times that an offer comes in from an outside buyers
 * agent for a listing in house and won't be created from the wizard and those
 * contracts need to be executed and signed from the seller and then submitted and
 * read and checked through the compliance gate. some documents won't be one of
 * ours and submitted from the outside buyer and need to be read and counted in the
 * transaction paperwork."
 *
 * TWO DEFECTS THIS PINS SHUT:
 *
 * F1 — the lane DEAD-ENDED. `offers.buyer_signed_at` had exactly one writer in
 *   the tree, the webhook for OUR OWN e-sign envelopes. An offer signed on an
 *   outside agent's paperwork could never have it set, so record-seller-response,
 *   submit-to-compliance AND offer-bridge all refused it forever. The fix is NOT
 *   to weaken "both sides signed": it is that the column has a SECOND admissible
 *   evidence source — a named human attesting to the executed contract on file —
 *   and the gate now records WHICH source established it.
 *
 * F2 — the outside contract was invisible to the paperwork count. Intake set
 *   `offers.offer_document_url` and created no `documents` row, while
 *   `auditOfferDocuments` counts only `documents`. On the CONFIRM branch — the one
 *   an outside buyer's AGENT actually takes — nothing was stored at all.
 *
 * WHAT THIS PROOF ASSERTS: constructs, never spellings. The behaviour sections
 * drive the REAL pure functions and the REAL writer against an injected stub
 * store — no credentials, no live rows, so "the query returned nothing" is never
 * mistaken for health. The source sections assert STRUCTURAL properties resolved
 * through whichever identifier the code binds, so a rename or a re-word cannot
 * fake them.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  attestBuyerSignature,
  describeBuyerSignatureEvidence,
  buyerSignatureEstablishedBy,
  buyerSignatureRefusal,
  isOutsideOriginated,
  BUYER_SIGNATURE_ATTESTED_EVENT,
  BUYER_SIGNATURE_EVIDENCE_KEY,
} from "../lib/buyer-offer/buyer-signature-evidence"
import {
  planInboundFiling,
  STAGED_PACKET_DOCUMENT_TYPE,
} from "../lib/inbound-mail/offer-detect"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) }
}

const ROOT = process.cwd()
/** Source with comments removed — prose that DESCRIBES a defect is not the defect. */
const stripComments = (t: string) => t
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "")
const src = (p: string) =>
  existsSync(join(ROOT, p)) ? stripComments(readFileSync(join(ROOT, p), "utf8")) : ""

const OFFER      = "11111111-1111-4111-8111-111111111111"
const BROKERAGE  = "33333333-3333-4333-8333-333333333333"
const OTHER_BROK = "44444444-4444-4444-8444-444444444444"
const TC_USER    = "55555555-5555-4555-8555-555555555555"
const AGENT_ID   = "77777777-7777-4777-8777-777777777777"
const CONTACT    = "88888888-8888-4888-8888-888888888888"
const DOC        = "99999999-9999-4999-8999-999999999999"

// ── A supabase-shaped stub over several tables. Only the chain shapes the
//    module actually uses. Errors are injectable per operation, because a
//    REFUSED query resolves in supabase-js and this writer must fail closed.
type Row = Record<string, any>
interface Store { offers: Row[]; users: Row[]; documents: Row[]; activities: Row[] }
interface StubOpts { readError?: string; updateError?: string; insertError?: string }

function makeStub(store: Store, opts: StubOpts = {}) {
  let seq = 0
  return {
    from(table: keyof Store) {
      const st: any = { op: "select", filters: {}, json: {}, payload: null, order: null, asc: true, single: false }
      const rows = () => store[table] ?? []
      const b: any = {
        select() { st.op = "select"; return b },
        insert(p: any) { st.op = "insert"; st.payload = p; return b },
        update(p: any) { st.op = "update"; st.payload = p; return b },
        eq(c: string, v: any) { st.filters[c] = v; return b },
        filter(c: string, _o: string, v: any) { st.json[c] = v; return b },
        order(c: string, o?: { ascending?: boolean }) { st.order = c; st.asc = o?.ascending !== false; return b },
        limit() { return b },
        maybeSingle() { st.single = true; return b },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      const matches = (r: Row) => {
        for (const [k, v] of Object.entries(st.filters)) if (r[k] !== v) return false
        for (const [k, v] of Object.entries(st.json)) {
          const m = /^metadata->>(.+)$/.exec(k)
          if (m && (r.metadata ?? {})[m[1]] !== v) return false
        }
        return true
      }
      function run() {
        if (st.op === "select") {
          if (opts.readError) return { data: null, error: { message: opts.readError } }
          let hit = rows().filter(matches)
          if (st.order) hit = [...hit].sort((a, c) =>
            st.asc ? String(a[st.order]).localeCompare(String(c[st.order]))
                   : String(c[st.order]).localeCompare(String(a[st.order])))
          return { data: st.single ? (hit[0] ?? null) : hit, error: null }
        }
        if (st.op === "update") {
          if (opts.updateError) return { data: null, error: { message: opts.updateError } }
          for (const r of rows().filter(matches)) Object.assign(r, st.payload)
          return { data: null, error: null }
        }
        if (st.op === "insert") {
          if (opts.insertError) return { data: null, error: { message: opts.insertError } }
          for (const p of (Array.isArray(st.payload) ? st.payload : [st.payload])) {
            rows().push({ id: `stub-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...p })
          }
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      return b
    },
  } as any
}

/** A fresh world: one inbound offer, one TC in the brokerage, one filed contract. */
function world(over: { offer?: Row; user?: Row; documents?: Row[] } = {}): Store {
  return {
    offers: [{
      id: OFFER, brokerage_id: BROKERAGE, contact_id: CONTACT, agent_id: AGENT_ID,
      buyer_signed_at: null, metadata: { intake_source: "inbound_email" },
      offer_document_url: null, seller_response_document_url: null,
      form_source: "manual", provider_envelope_id: null,
      ...(over.offer ?? {}),
    }],
    users: [{
      id: TC_USER, first_name: "Dana", last_name: "Ruiz",
      email: "dana@brokerage.test", brokerage_id: BROKERAGE,
      ...(over.user ?? {}),
    }],
    documents: over.documents ?? [{
      id: DOC, brokerage_id: BROKERAGE, storage_url: "https://storage.test/executed.pdf",
      classification: "signed_contract", signature_completeness: null,
      metadata: { linked_offer_id: OFFER }, created_at: "2026-01-01T00:00:00.000Z",
    }],
    activities: [],
  }
}

const YESTERDAY = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
const STATEMENT = "I hold the buyer-executed purchase agreement from the outside buyer's agent; it carries both buyers' signatures."

const attest = (store: Store, over: Record<string, any> = {}, opts: StubOpts = {}) =>
  attestBuyerSignature({
    offerId: OFFER, attestorUserId: TC_USER,
    signedAt: YESTERDAY, attestation: STATEMENT,
    client: makeStub(store, opts),
    ...over,
  })

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" The inbound offer lane — evidence, not assumption")
  console.log("══════════════════════════════════════════════════")

  // ── F1 · PURE: a signature is never invented ──────────────────────────────
  console.log("\n[what established the buyer's signature — read, never assumed]")
  {
    check("no timestamp ⇒ NO evidence, and nothing is invented to fill the gap",
      describeBuyerSignatureEvidence({ buyer_signed_at: null, metadata: {} }) === null)

    const derived = describeBuyerSignatureEvidence({
      buyer_signed_at: "2026-02-02T00:00:00.000Z", metadata: {},
    })!
    check("a timestamp with no evidence record names the only other writer…",
      derived.source === "our_esign_envelope")
    check("…and MARKS ITSELF DERIVED rather than claiming it was recorded",
      derived.recorded === false)

    const attested = describeBuyerSignatureEvidence({
      buyer_signed_at: "2026-02-02T00:00:00.000Z",
      metadata: { [BUYER_SIGNATURE_EVIDENCE_KEY]: { source: "attested_executed_contract", attested_by_name: "Dana Ruiz" } },
    })!
    check("a recorded attestation is reported as such, with its author",
      attested.source === "attested_executed_contract" && attested.recorded === true &&
      attested.attested_by_name === "Dana Ruiz")

    check("the two sources do not produce the same sentence",
      buyerSignatureEstablishedBy(derived) !== buyerSignatureEstablishedBy(attested))
    check("…and the attested sentence names the human accountable for it",
      buyerSignatureEstablishedBy(attested).includes("Dana Ruiz"))
    check("nothing established ⇒ the sentence says so",
      /nothing/i.test(buyerSignatureEstablishedBy(null)))
  }

  // ── F1 · PURE: which offers our webhook can never speak for ───────────────
  console.log("\n[was this paperwork ours? — read off live columns]")
  {
    check("an in-app wizard offer is OURS",
      isOutsideOriginated({ form_source: "in_app", offer_document_url: "u" }) === false)
    check("a provider-sent envelope is OURS",
      isOutsideOriginated({ form_source: "docusign", offer_document_url: "u" }) === false)
    check("the CHECK constraint's outside values are OUTSIDE",
      isOutsideOriginated({ form_source: "manual" }) === true &&
      isOutsideOriginated({ form_source: "portal_upload" }) === true)
    // Both inbound lanes leave form_source NULL today, so the fallback matters.
    check("an unrecorded source with a document and NO envelope of ours is outside",
      isOutsideOriginated({ form_source: null, offer_document_url: "https://s/x.pdf", provider_envelope_id: null }) === true)
    check("…but an unrecorded source WITH an envelope of ours is not",
      isOutsideOriginated({ form_source: null, offer_document_url: "https://s/x.pdf", provider_envelope_id: "env-1" }) === false)
    check("…and an unrecorded source with no paperwork at all claims nothing",
      isOutsideOriginated({ form_source: null }) === false)

    const outside = buyerSignatureRefusal({ form_source: "manual", offer_document_url: "u" })
    const ours    = buyerSignatureRefusal({ form_source: "in_app" })
    check("the refusal for an outside offer is NOT the refusal for one of ours",
      outside !== ours)
    check("…and it names the evidence that can actually unblock it",
      /attest/i.test(outside))
    check("…and does not tell the agent to wait for a webhook that will never fire",
      !/wait/i.test(outside))
  }

  // ── F1 · THE WRITER: refusals ─────────────────────────────────────────────
  console.log("\n[the attestation refuses what is not evidence]")
  {
    const s1 = world()
    const r1 = await attest(s1, { attestation: "  " })
    check("a blank statement is refused — a click is not an attestation",
      r1.success === false && s1.offers[0].buyer_signed_at === null)

    const s2 = world()
    const r2 = await attest(s2, { signedAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() })
    check("a signature dated in the FUTURE is refused",
      r2.success === false && s2.offers[0].buyer_signed_at === null)

    const s3 = world()
    const r3 = await attest(s3, { signedAt: "not a date" })
    check("an unparseable signature date is refused",
      r3.success === false && s3.offers[0].buyer_signed_at === null)

    const s4 = world({ user: { brokerage_id: OTHER_BROK } })
    const r4 = await attest(s4)
    check("an attestor outside the offer's brokerage is refused",
      r4.success === false && s4.offers[0].buyer_signed_at === null)

    const s5 = world({ documents: [] })
    const r5 = await attest(s5)
    check("NO executed contract on file ⇒ refused: there is nothing to attest to",
      r5.success === false && s5.offers[0].buyer_signed_at === null,
      `error was: ${r5.error}`)

    // The attestor is a real person or it is nothing.
    const s6 = world()
    s6.users = []
    const r6 = await attest(s6)
    check("an attestor who is not a user at all is refused",
      r6.success === false && s6.offers[0].buyer_signed_at === null)

    // A REFUSED read resolves in supabase-js. It must not render as "not found".
    const s7 = world()
    const r7 = await attest(s7, {}, { readError: "permission denied for table offers" })
    check("a refused read FAILS CLOSED and says it could not read, not 'not found'",
      r7.success === false && /could not read/i.test(r7.error ?? "") &&
      s7.offers[0].buyer_signed_at === null)

    const s8 = world()
    const r8 = await attest(s8, {}, { updateError: "row level security" })
    check("a refused stamp is reported, not swallowed",
      r8.success === false && /could not be written/i.test(r8.error ?? ""))

    const s9 = world()
    const r9 = await attest(s9, {}, { insertError: "activities insert refused" })
    check("a lost audit row is a FAILURE, and the message says the offer IS stamped",
      r9.success === false && /recorded on the offer/i.test(r9.error ?? "") &&
      s9.offers[0].buyer_signed_at !== null)
  }

  // ── F1 · THE WRITER: machine evidence is never overwritten ────────────────
  console.log("\n[an established signature is never re-established]")
  {
    const webhookAt = "2026-03-03T12:00:00.000Z"
    const s = world({ offer: { buyer_signed_at: webhookAt } })
    const r = await attest(s)
    check("an already-signed offer reports already_established and writes nothing",
      r.success === true && r.already_established === true &&
      s.offers[0].buyer_signed_at === webhookAt && s.activities.length === 0)
    check("…and reports the evidence that DID establish it",
      r.evidence?.source === "our_esign_envelope")
  }

  // ── F1 · THE WRITER: the success path ─────────────────────────────────────
  console.log("\n[a recorded attestation establishes the signature — with who, when, and on what]")
  {
    const s = world()
    const r = await attest(s)
    const offer = s.offers[0]
    check("the attestation succeeds and stamps buyer_signed_at to the ATTESTED date",
      r.success === true && offer.buyer_signed_at === new Date(YESTERDAY).toISOString())

    const ev = offer.metadata?.[BUYER_SIGNATURE_EVIDENCE_KEY]
    check("the evidence is recorded on the offer, naming the source",
      ev?.source === "attested_executed_contract")
    check("…with WHO (resolved to a name, not an id) and WHEN",
      ev?.attested_by_user_id === TC_USER && ev?.attested_by_name === "Dana Ruiz" && !!ev?.attested_at)
    check("…and WHAT it is about — the document actually on file",
      ev?.document_id === DOC && ev?.document_url === "https://storage.test/executed.pdf")
    check("…and the attestor's own words, kept verbatim",
      ev?.attestation === STATEMENT)

    // THE MERGE. offers.metadata is a live column other writers use; a wholesale
    // overwrite here would destroy them — the class wave 9 found in
    // generateOfferDraft, which replaced a document's metadata and with it the
    // only key the packet scan could find it by.
    check("existing offers.metadata keys SURVIVE — the blob is merged, not replaced",
      offer.metadata?.intake_source === "inbound_email")

    // The audit row must be findable by the key every offer reader joins on.
    const audit = s.activities.find(a => a.activity_type === BUYER_SIGNATURE_ATTESTED_EVENT)
    check("an audit event is written under the offer key every reader uses",
      !!audit && audit.entity_type === "offer" && audit.entity_id === OFFER)
    check("…carrying the tenant (activities.brokerage_id is NOT NULL with no default)",
      audit?.brokerage_id === BROKERAGE)
    check("…and never crossing the agents/users id spaces",
      audit?.agent_id === AGENT_ID && audit?.agent_user_id === TC_USER)
  }

  // ── F1 · THE AI IS CORROBORATION, NEVER ESTABLISHMENT ─────────────────────
  console.log("\n[the AI reading is recorded beside the attestation, and decides nothing]")
  {
    // No blob at all: the classifier has not spoken. Silence must read as
    // silence — `checked:false` — not as agreement and not as contradiction.
    const quiet = world()
    await attest(quiet)
    const evQuiet = quiet.offers[0].metadata?.[BUYER_SIGNATURE_EVIDENCE_KEY] ?? {}
    check("an unscanned document records checked:false — silence, not agreement",
      evQuiet.ai_corroboration?.checked === false && evQuiet.ai_corroboration?.executed === null)

    // The classifier found a buyer signature. Corroboration, recorded.
    const agrees = world({ documents: [{
      id: DOC, brokerage_id: BROKERAGE, storage_url: "u", classification: "signed_contract",
      signature_completeness: {
        signatures: [{ signer_role: "buyer", signed: true }],
        initials:   [{ signer_role: "buyer", all_required_initials_present: true }],
      },
      metadata: { linked_offer_id: OFFER }, created_at: "2026-01-01T00:00:00.000Z",
    }] })
    await attest(agrees)
    const evAgrees = agrees.offers[0].metadata?.[BUYER_SIGNATURE_EVIDENCE_KEY] ?? {}
    check("a corroborating scan is recorded as checked + executed",
      evAgrees.ai_corroboration?.checked === true && evAgrees.ai_corroboration?.executed === true)

    // The classifier could NOT find it. The human holding the paper still wins —
    // but the disagreement is on the record for the gate to raise.
    const contests = world({ documents: [{
      id: DOC, brokerage_id: BROKERAGE, storage_url: "u", classification: "signed_contract",
      signature_completeness: { signatures: [{ signer_role: "seller", signed: true }], initials: [] },
      metadata: { linked_offer_id: OFFER }, created_at: "2026-01-01T00:00:00.000Z",
    }] })
    const rc = await attest(contests)
    const evContests = contests.offers[0].metadata?.[BUYER_SIGNATURE_EVIDENCE_KEY] ?? {}
    check("a scan that could not find the buyer signature does NOT veto the human…",
      rc.success === true && contests.offers[0].buyer_signed_at !== null)
    check("…but the disagreement is recorded, with what the scan says is missing",
      evContests.ai_corroboration?.checked === true &&
      evContests.ai_corroboration?.executed === false &&
      (evContests.ai_corroboration?.missing?.length ?? 0) > 0)
  }

  // ── F1 · THE WRITER: a document from another deal is not evidence ─────────
  console.log("\n[the attestation is about THIS deal's paper]")
  {
    const s = world({ documents: [{
      id: DOC, brokerage_id: BROKERAGE, storage_url: "u", classification: "signed_contract",
      signature_completeness: null,
      metadata: { linked_offer_id: "00000000-0000-4000-8000-000000000000" },
      created_at: "2026-01-01T00:00:00.000Z",
    }] })
    const r = await attest(s, { documentId: DOC })
    check("a named document filed against a DIFFERENT offer is refused",
      r.success === false && s.offers[0].buyer_signed_at === null)

    const other = world({ documents: [{
      id: DOC, brokerage_id: OTHER_BROK, storage_url: "u", classification: "signed_contract",
      signature_completeness: null, metadata: { linked_offer_id: OFFER },
      created_at: "2026-01-01T00:00:00.000Z",
    }] })
    const r2 = await attest(other, { documentId: DOC })
    check("a named document in another BROKERAGE is refused",
      r2.success === false && other.offers[0].buyer_signed_at === null)
  }

  // ── F2 · PURE: every inbound page reaches the ledger, as the right type ───
  console.log("\n[the outside paperwork is filed — all of it, and never as the packet]")
  {
    const email = [
      { fileName: "Purchase_Agreement_signed.pdf" },
      { fileName: "Addendum_A.pdf" },
      { fileName: "Lead_Paint_Disclosure.pdf" },
      { fileName: "PreApproval.pdf" },
    ]
    const plan = planInboundFiling(email)
    check("EVERY attachment is planned, not just the first",
      plan.length === email.length &&
      plan.map(p => p.fileName).join("|") === email.map(e => e.fileName).join("|"))
    check("the matched contract is the contract; the rest are its attachments",
      plan[0].role === "contract" && plan.slice(1).every(p => p.role === "attachment"))
    // THE ONE THAT WOULD HAVE REFUSED EVERY INBOUND OFFER: filing these as the
    // staged-packet type makes scan-offer-packet find a document with no
    // filledPacket, which since wave 9 is an explicit FAULT at the gate.
    check("NOTHING is filed under the staged-packet document_type",
      plan.every(p => p.documentType !== STAGED_PACKET_DOCUMENT_TYPE))
    check("…and the contract is still distinguishable from its attachments",
      plan[0].documentType !== plan[1].documentType)
    check("an email with a single PDF still yields exactly one plan entry",
      planInboundFiling([{ fileName: "offer.pdf" }]).length === 1)
    check("no attachments ⇒ nothing planned, and no empty row invented",
      planInboundFiling([]).length === 0)
  }

  // ── F2 · STRUCTURE: one ledger, not a second one ─────────────────────────
  console.log("\n[intake reaches the SAME ledger the rest of the deal file uses]")
  {
    const s = src("lib/inbound-mail/offer-intake.ts")
    check("intake routes documents through the universal uploader",
      /from\s+"@\/lib\/documents\/upload-document"/.test(s) && /uploadDocument\(/.test(s),
      "it must not grow a second document ledger beside lib/documents/upload-document.ts")
    check("…and never writes a documents row by its own insert",
      !/from\(\s*"documents"\s*\)[\s\S]{0,80}\.insert\(/.test(s))

    // BOTH branches file. The confirm branch is the one an outside buyer's AGENT
    // takes (they are not a known contact) and it used to store nothing at all.
    const helper = s.match(/const\s+\w+\s*=\s*await\s+(\w+)\(\s*svc\s*,/)
    check("the filing helper is bound and reachable", !!helper, `found: ${helper?.[1] ?? "(none)"}`)
    const calls = helper ? (s.match(new RegExp(`await\\s+${helper[1]}\\(`, "g")) ?? []) : []
    check("…and it is called on BOTH the confirm and the auto branch",
      calls.length >= 2, `call sites found: ${calls.length}`)

    // The origin is recorded on the offer rather than left NULL for the next
    // reader to guess at.
    check("intake records the offer's origin on a column that already means it",
      /form_source:\s*"(manual|portal_upload)"/.test(s))
  }

  // ── F1 · STRUCTURE: the gates read EVIDENCE, and still refuse without it ──
  console.log("\n[both gates: the requirement is unchanged, the evidence is named]")
  {
    const rsr = src("app/actions/buyer-offer/record-seller-response.ts")
    check("record-seller-response can accept the attestation before it judges",
      /attestBuyerSignature\(/.test(rsr))
    // The refusal must still exist, and must depend on a value the attestation
    // can move — not on the raw column, or the attestation changes nothing.
    const bound = rsr.match(/let\s+(\w+)\s*=\s*offer\.buyer_signed_at/)
    check("…binds the signature fact to a variable the attestation updates", !!bound)
    check("…and still REFUSES when nothing established it",
      !!bound && new RegExp(`if\\s*\\(!${bound![1]}\\)`).test(rsr),
      "the requirement is unchanged — only the ways of meeting it grew")
    check("…and the refusal is the shared, actionable wording, not a local dead end",
      /buyerSignatureRefusal\(/.test(rsr))

    const stc = src("app/actions/buyer-offer/submit-to-compliance.ts")
    const evBound = stc.match(/const\s+(\w+)\s*=\s*describeBuyerSignatureEvidence\(/)
    check("submit-to-compliance resolves the EVIDENCE, not merely the timestamp", !!evBound)
    check("…and refuses when there is none",
      !!evBound && new RegExp(`if\\s*\\(!${evBound![1]}\\)`).test(stc))
    check("…and the gate event records which source established the buyer side",
      /buyer_signature_source/.test(stc) && /buyerSignatureEstablishedBy\(/.test(stc))
    // EXTENDING wave 9's vocabulary, not forking it.
    check("…while wave 9's both_sides vocabulary is left intact",
      /both_sides_established_by/.test(stc) && /executed_contract_columns_only/.test(stc))
    // A contradiction between the human and the classifier must be told to
    // somebody on the path that already reaches the TC and the agent.
    check("a contested attestation is raised on the existing compliance-flag path",
      /ai_corroboration/.test(stc) && /compliance\.submit_warnings/.test(stc))
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    for (const f of fails) console.log(`   - ${f}`)
    console.log(" ❌ INBOUND_OFFER_LANE_FAIL — an outside offer that cannot be evidenced must not pass, and one that IS evidenced must not be stuck")
    process.exit(1)
  }
  console.log(" ✅ INBOUND_OFFER_LANE_PASS — the buyer's signature is evidenced or refused, and the outside paperwork is counted")
}

main()
