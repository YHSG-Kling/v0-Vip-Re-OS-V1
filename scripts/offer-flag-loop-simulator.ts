#!/usr/bin/env tsx
/**
 * scripts/offer-flag-loop-simulator.ts   (npm run test:offer-flag-loop)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUDIT GATE'S LOOP MUST CLOSE.
 *
 * The owner's ruling: "if all are present, then a transaction is created, if not,
 * then the missing piece is sent to the tc and agent to get it finished and
 * resubmitted for approval." The resubmit worked; the approval left no trace.
 * Every compliance flag was written `status:'open'` and NOTHING in app/ or lib/
 * ever moved one off it, so the queue was write-only: originals never closed,
 * every resubmission stacked a fresh duplicate, and a PASSING submit cleared
 * nothing.
 *
 * This proof stands over the three properties that fix it, driving the real
 * lib/compliance/offer-flag-resolution.ts through an injected stub client — no
 * credentials, no live rows, and therefore no "the query returned nothing" being
 * mistaken for health:
 *
 *   1. IDENTITY   — the flag key is the stable identity of a MISS, not of an
 *                   attempt. Two raises of one miss share a key; two different
 *                   misses never do; the staged document's id, which changes on
 *                   every restage, is not part of it.
 *   2. NO STACKING — a resubmission that finds the same miss still open refreshes
 *                   the survivor instead of minting a second row, and collapses
 *                   duplicates an earlier build already stacked.
 *   3. CLEARING   — a passing gate closes the outstanding set with WHO and WHEN
 *                   on every row plus one audit event; targeted and reconciling
 *                   modes never touch an unrelated flag; and every failure mode
 *                   fails CLOSED rather than reporting a queue it did not clear.
 *
 * ASSERTIONS ARE ON THE CONSTRUCT, never on a spelling: nothing below compares a
 * literal key string, a title, or an activity_type — they compare keys to each
 * other, count rows by status, and read back the actor recorded on the row.
 */
import {
  complianceFlagKey,
  recordOfferComplianceFlag,
  resolveOfferComplianceFlags,
  OFFER_COMPLIANCE_FLAG_EVENT,
  OFFER_COMPLIANCE_RESOLVED_EVENT,
  FLAG_STATUS_OPEN,
  FLAG_STATUS_RESOLVED,
  FLAG_SOURCE_PACKET_SCAN,
  FLAG_SOURCE_MANUAL,
} from "../lib/compliance/offer-flag-resolution"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}

const OFFER = "11111111-1111-4111-8111-111111111111"
const OTHER_OFFER = "22222222-2222-4222-8222-222222222222"
const BROKERAGE = "33333333-3333-4333-8333-333333333333"
const OTHER_BROKERAGE = "44444444-4444-4444-8444-444444444444"
const TC = "55555555-5555-4555-8555-555555555555"
const AGENT_USER = "66666666-6666-4666-8666-666666666666"
const AGENT_ID = "77777777-7777-4777-8777-777777777777"
const CONTACT = "88888888-8888-4888-8888-888888888888"

// ── A supabase-shaped stub. Only the chain shapes this module actually uses. ──
type Row = Record<string, any>
interface StubOpts { readError?: string; updateError?: string; insertError?: string }

function makeStub(rows: Row[], opts: StubOpts = {}) {
  let seq = rows.length
  const api: any = {
    rows,
    from(table: string) {
      const st: any = { table, op: "select", filters: {}, json: {}, payload: null, order: null, asc: true }
      const b: any = {
        select() { st.op = "select"; return b },
        insert(p: any) { st.op = "insert"; st.payload = p; return b },
        update(p: any) { st.op = "update"; st.payload = p; return b },
        eq(c: string, v: any) { st.filters[c] = v; return b },
        filter(c: string, _o: string, v: any) { st.json[c] = v; return b },
        in(c: string, v: any[]) { st.inFilter = { c, v }; return b },
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
        if (st.inFilter && !st.inFilter.v.includes(r[st.inFilter.c])) return false
        return true
      }
      function run() {
        if (st.op === "select") {
          if (opts.readError) return { data: null, error: { message: opts.readError } }
          let hit = rows.filter(matches)
          if (st.order) hit = [...hit].sort((a, c) =>
            st.asc ? String(a[st.order]).localeCompare(String(c[st.order]))
                   : String(c[st.order]).localeCompare(String(a[st.order])))
          return { data: st.single ? (hit[0] ?? null) : hit, error: null }
        }
        if (st.op === "update") {
          if (opts.updateError) return { data: null, error: { message: opts.updateError } }
          for (const r of rows.filter(matches)) Object.assign(r, st.payload)
          return { data: null, error: null }
        }
        if (st.op === "insert") {
          if (opts.insertError) return { data: null, error: { message: opts.insertError } }
          for (const p of (Array.isArray(st.payload) ? st.payload : [st.payload])) {
            rows.push({ id: `stub-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...p })
          }
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      return b
    },
  }
  return api
}

/** Raise a flag through the real writer, against a stub store. */
const raise = (store: any, o: { title: string; flagType?: string; documentId?: string | null; offerId?: string; severity?: string }) =>
  recordOfferComplianceFlag({
    offerId: o.offerId ?? OFFER,
    brokerageId: BROKERAGE,
    raiserUserId: AGENT_USER,
    agentId: AGENT_ID,
    contactId: CONTACT,
    flagType: o.flagType ?? "missing_signature",
    severity: o.severity ?? "critical",
    title: o.title,
    documentId: o.documentId ?? null,
    client: store,
  })

const openFlags = (rows: Row[], offerId = OFFER) =>
  rows.filter(r => r.activity_type === OFFER_COMPLIANCE_FLAG_EVENT && r.entity_id === offerId && r.status === FLAG_STATUS_OPEN)
const resolvedFlags = (rows: Row[], offerId = OFFER) =>
  rows.filter(r => r.activity_type === OFFER_COMPLIANCE_FLAG_EVENT && r.entity_id === offerId && r.status === FLAG_STATUS_RESOLVED)
const auditEvents = (rows: Row[]) =>
  rows.filter(r => r.activity_type === OFFER_COMPLIANCE_RESOLVED_EVENT)

async function main() {
  // ── 1. IDENTITY OF A MISS ──────────────────────────────────────────────────
  console.log("\n[identity — what makes two flags 'the same miss']")
  {
    // The three shapes lib/workflow/intelligence/packet-analysis.ts emits.
    const sigFormA = { flagType: "missing_signature", title: "Signature block missing on Purchase Agreement" }
    const sigFormB = { flagType: "missing_signature", title: "Signature block missing on Lead Paint Disclosure" }
    const fieldA1  = { flagType: "missing_field", title: "Field missing on Purchase Agreement: buyer_dob" }
    const fieldA2  = { flagType: "missing_field", title: "Field missing on Purchase Agreement: buyer_phone" }
    const formGone = { flagType: "missing_form", title: "Form missing: Wire Fraud Advisory" }

    check("the same miss raised twice yields ONE identity",
      complianceFlagKey(sigFormA) === complianceFlagKey({ ...sigFormA }))
    check("the same subject differing only in case/whitespace is still one identity",
      complianceFlagKey(sigFormA) === complianceFlagKey({ flagType: "  MISSING_Signature ", title: "  Signature block   missing on Purchase Agreement  " }))
    check("a missing signature on a DIFFERENT form is a different miss",
      complianceFlagKey(sigFormA) !== complianceFlagKey(sigFormB))
    check("two different fields on one form are two different misses",
      complianceFlagKey(fieldA1) !== complianceFlagKey(fieldA2))
    check("a missing FORM is not the same miss as a missing field on it",
      complianceFlagKey(formGone) !== complianceFlagKey(fieldA1))
    check("the same subject under a different flagType is a different miss",
      complianceFlagKey({ flagType: "missing_initial", title: sigFormA.title }) !== complianceFlagKey(sigFormA))
    // Digits carry identity — merging them would close an unrelated flag.
    check("page numbers are preserved, so page 3 and page 5 are not merged",
      complianceFlagKey({ flagType: "missing_initial", title: "Buyer initial missing page 3" }) !==
      complianceFlagKey({ flagType: "missing_initial", title: "Buyer initial missing page 5" }))
    check("an unspecified flagType still produces a usable identity",
      complianceFlagKey({ flagType: null, title: "Something is wrong" }).length > 0)
  }

  // ── 2. NO DUPLICATE STACKING ───────────────────────────────────────────────
  console.log("\n[no stacking — one row per miss, not one per attempt]")
  {
    const rows: Row[] = []
    const store = makeStub(rows)
    const miss = { title: "Signature block missing on Purchase Agreement", documentId: "doc-1" }

    const first = await raise(store, miss)
    check("first raise inserts one open flag", openFlags(rows).length === 1 && first.deduped === false)

    // The resubmission restages the packet, so the scanner finds a NEW documents
    // row for the SAME miss. This is the exact case that used to stack.
    const second = await raise(store, { ...miss, documentId: "doc-2-restaged" })
    check("resubmission with a RESTAGED document does not mint a second flag",
      openFlags(rows).length === 1, `${openFlags(rows).length} open`)
    check("…and reports that it deduped", second.deduped === true)
    check("…onto the same identity", second.flag_key === first.flag_key)

    const survivor = openFlags(rows)[0]
    check("the survivor counts how many resubmissions this miss has outlived",
      Number(survivor.metadata.reflag_count) === 1)
    check("…while keeping its original created_at, so its age stays true",
      survivor.created_at === rows[0].created_at)
    check("…and carries the newest document id for the humans",
      survivor.metadata.document_id === "doc-2-restaged")

    await raise(store, { ...miss, documentId: "doc-3" })
    check("a third attempt still leaves exactly one open row",
      openFlags(rows).length === 1 && Number(openFlags(rows)[0].metadata.reflag_count) === 2)

    // A genuinely different miss must still get its own row.
    await raise(store, { title: "Form missing: Wire Fraud Advisory", flagType: "missing_form", documentId: "doc-3" })
    check("a DIFFERENT miss still opens its own flag", openFlags(rows).length === 2)
  }

  console.log("\n[self-heal — duplicates an earlier build already stacked]")
  {
    const key = complianceFlagKey({ flagType: "missing_signature", title: "Signature block missing on Purchase Agreement" })
    const legacy = (n: number): Row => ({
      id: `legacy-${n}`, created_at: `2026-01-0${n}T00:00:00.000Z`,
      brokerage_id: BROKERAGE, entity_type: "offer", entity_id: OFFER,
      activity_type: OFFER_COMPLIANCE_FLAG_EVENT, status: FLAG_STATUS_OPEN,
      title: "Signature block missing on Purchase Agreement",
      metadata: { flag_key: key, flagType: "missing_signature" },
    })
    const rows: Row[] = [legacy(1), legacy(2), legacy(3)]
    const store = makeStub(rows)
    const r = await raise(store, { title: "Signature block missing on Purchase Agreement", documentId: "doc-9" })
    check("three stacked copies collapse to one open row", openFlags(rows).length === 1)
    check("…the OLDEST survives (its created_at is the true age of the work)",
      openFlags(rows)[0].id === "legacy-1")
    check("…and the collapse is reported, not silent", r.duplicates_collapsed === 2)
    check("…with the collapsed rows recorded as resolved, naming the survivor",
      resolvedFlags(rows).length === 2 &&
      resolvedFlags(rows).every(x => String(x.metadata.resolution_reason).includes("legacy-1")))
  }

  // ── 3. THE PASSING GATE CLEARS THE SET ─────────────────────────────────────
  console.log("\n[a passing submit clears the outstanding set, with WHO and WHEN]")
  {
    const rows: Row[] = []
    const store = makeStub(rows)
    await raise(store, { title: "Signature block missing on Purchase Agreement", documentId: "doc-1" })
    await raise(store, { title: "Form missing: Wire Fraud Advisory", flagType: "missing_form", documentId: "doc-1" })
    await raise(store, { title: "Buyer initial missing page 3", flagType: "missing_initial" })
    // A flag on ANOTHER offer must be untouched by this offer's gate.
    await raise(store, { title: "Signature block missing on Purchase Agreement", documentId: "doc-x", offerId: OTHER_OFFER })
    check("three misses outstanding on this offer", openFlags(rows).length === 3)

    const before = Date.now() - 1
    const r = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC,
      reason: "Compliance gate passed — all documents present, all signatures and initials complete on both sides.",
      client: store,
    })
    check("the sweep succeeds", r.success === true, r.error)
    check("…clearing every outstanding flag on the offer", r.resolved_count === 3 && openFlags(rows).length === 0)
    check("…and leaving nothing open", r.still_open_count === 0)
    check("…without touching the other offer's flag", openFlags(rows, OTHER_OFFER).length === 1)

    const cleared = resolvedFlags(rows)
    check("every cleared row records WHO cleared it", cleared.length === 3 && cleared.every(c => c.metadata.resolved_by === TC))
    check("every cleared row records WHEN", cleared.every(c => Date.parse(c.metadata.resolved_at) >= before && !!c.completed_at))
    check("every cleared row records WHY", cleared.every(c => String(c.metadata.resolution_reason).length > 0))
    check("…and its updated_at moves, so the row's mtime does not lie",
      cleared.every(c => !!c.updated_at))

    const audit = auditEvents(rows)
    check("one audit event names the actor, the count and the keys",
      audit.length === 1 &&
      audit[0].agent_user_id === TC &&
      audit[0].metadata.resolved_count === 3 &&
      audit[0].metadata.resolved_keys.length === 3)
    check("…keyed the way every offer reader requires (entity_type + entity_id)",
      audit[0].entity_type === "offer" && audit[0].entity_id === OFFER)
    check("…and carrying the tenant, which is NOT NULL with no default",
      audit[0].brokerage_id === BROKERAGE)

    const again = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC, reason: "second pass", client: store,
    })
    check("a second sweep is idempotent — nothing left to clear",
      again.success === true && again.resolved_count === 0 && auditEvents(rows).length === 1)
  }

  // ── 4. TARGETED + RECONCILING MODES NEVER CLOSE AN UNRELATED FLAG ───────────
  console.log("\n[precision — resolution never closes a flag it was not about]")
  {
    const rows: Row[] = []
    const store = makeStub(rows)
    const supplied = await raise(store, { title: "Form missing: Wire Fraud Advisory", flagType: "missing_form", documentId: "doc-1" })
    await raise(store, { title: "Signature block missing on Purchase Agreement", documentId: "doc-1" })
    await raise(store, { title: "Buyer initial missing page 3", flagType: "missing_initial" })

    const r = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC,
      reason: "The Wire Fraud Advisory was uploaded.",
      flagKeys: [supplied.flag_key], client: store,
    })
    check("targeted mode clears exactly the miss that was supplied", r.resolved_count === 1)
    check("…and leaves the rest outstanding", r.still_open_count === 2 && openFlags(rows).length === 2)
    check("…reporting which key it closed", r.resolved_keys[0] === supplied.flag_key)

    // RECONCILING: the resubmission's scan still reports the signature miss, so
    // the initial must be the one that was fixed.
    const stillOutstanding = complianceFlagKey({ flagType: "missing_signature", title: "Signature block missing on Purchase Agreement" })
    const r2 = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC,
      reason: "Resubmission scan no longer reports this miss.",
      retainKeys: [stillOutstanding], sources: [FLAG_SOURCE_PACKET_SCAN, FLAG_SOURCE_MANUAL], client: store,
    })
    check("reconciling mode retires only what is no longer outstanding", r2.resolved_count === 1)
    check("…and keeps the miss the scan still reports", openFlags(rows).length === 1 &&
      openFlags(rows)[0].metadata.flag_key === stillOutstanding)

    check("flagKeys and retainKeys together is refused, not guessed",
      (await resolveOfferComplianceFlags({
        offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC, reason: "x",
        flagKeys: ["a"], retainKeys: ["b"], client: store,
      })).success === false)
  }

  console.log("\n[source — a producer may only retire flags it raised]")
  {
    const rows: Row[] = []
    const store = makeStub(rows)
    // The three live callers of flagOfferCompliance split exactly this way: the
    // packet scanner always names the staged document, the offer toolbar and the
    // EM-receipt cron never do.
    await raise(store, { title: "Signature block missing on Purchase Agreement", documentId: "doc-1" })
    await raise(store, { title: "Buyer said the survey is wrong", flagType: "other", documentId: null })
    check("a scanner-raised flag is tagged to the scanner",
      openFlags(rows).some(f => f.metadata.source === FLAG_SOURCE_PACKET_SCAN))
    check("a hand-raised flag is tagged manual",
      openFlags(rows).some(f => f.metadata.source === FLAG_SOURCE_MANUAL))

    const r = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC,
      reason: "Packet scan reconciliation.",
      retainKeys: [], sources: [FLAG_SOURCE_PACKET_SCAN], client: store,
    })
    check("a scan reconciliation retires only scanner flags", r.resolved_count === 1)
    check("…and never auto-closes the flag a human typed",
      openFlags(rows).length === 1 && openFlags(rows)[0].metadata.source === FLAG_SOURCE_MANUAL)
  }

  // ── 5. FAIL CLOSED ─────────────────────────────────────────────────────────
  console.log("\n[fails CLOSED — supabase-js RESOLVES a refused query]")
  {
    const rows: Row[] = []
    const seed = makeStub(rows)
    await raise(seed, { title: "Signature block missing on Purchase Agreement", documentId: "doc-1" })

    const refusedRead = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC, reason: "x",
      client: makeStub(rows, { readError: "permission denied for table activities" }),
    })
    check("a refused READ does not report a cleared queue",
      refusedRead.success === false && refusedRead.resolved_count === 0)
    check("…and says why", (refusedRead.error ?? "").includes("permission denied"))
    check("…leaving the flag open", openFlags(rows).length === 1)

    const refusedWrite = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC, reason: "x",
      client: makeStub(rows, { updateError: "row level security" }),
    })
    check("a refused UPDATE does not report a cleared queue",
      refusedWrite.success === false && refusedWrite.resolved_count === 0 && (refusedWrite.error ?? "").length > 0)
    check("…and the flag is still open afterwards", openFlags(rows).length === 1)

    const lostAudit = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: BROKERAGE, actorUserId: TC, reason: "x",
      client: makeStub(rows, { insertError: "null value in column brokerage_id" }),
    })
    check("a lost AUDIT event is surfaced, not swallowed",
      lostAudit.success === false && (lostAudit.error ?? "").includes("audit event"))

    for (const [name, params] of [
      ["offer", { offerId: "not-a-uuid", brokerageId: BROKERAGE, actorUserId: TC }],
      ["brokerage", { offerId: OFFER, brokerageId: "nope", actorUserId: TC }],
      ["actor", { offerId: OFFER, brokerageId: BROKERAGE, actorUserId: "" }],
    ] as const) {
      const r = await resolveOfferComplianceFlags({ ...(params as any), reason: "x", client: makeStub(rows) })
      check(`an invalid ${name} id is refused, never treated as a wildcard`, r.success === false && r.resolved_count === 0)
    }
  }

  console.log("\n[tenant — a service-client write carries its own scope]")
  {
    const rows: Row[] = []
    const store = makeStub(rows)
    await raise(store, { title: "Signature block missing on Purchase Agreement", documentId: "doc-1" })
    const r = await resolveOfferComplianceFlags({
      offerId: OFFER, brokerageId: OTHER_BROKERAGE, actorUserId: TC, reason: "x", client: store,
    })
    check("another brokerage cannot clear this brokerage's flags",
      r.resolved_count === 0 && openFlags(rows).length === 1)
    check("…and no audit event is fabricated for a clearing that did not happen",
      auditEvents(rows).length === 0)
  }

  // ── LIVE LAYER (creds-gated) ───────────────────────────────────────────────
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (the stub layer above drove the real module).")
  } else {
    console.log("\n[live] seed an open flag → sweep → assert → idempotent → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const svc = createServiceClient()
    const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    const { data: u } = await svc.from("users").select("id").limit(1).maybeSingle()
    if (!b || !u) { console.log("  ⏭  no brokerage/user available") }
    else {
      const liveOffer = OFFER
      const liveKey = complianceFlagKey({ flagType: "missing_form", title: "LIVE PROOF — synthetic flag" })
      const { data: seeded } = await svc.from("activities").insert({
        brokerage_id: b.id, entity_type: "offer", entity_id: liveOffer,
        activity_type: OFFER_COMPLIANCE_FLAG_EVENT, status: FLAG_STATUS_OPEN,
        title: "LIVE PROOF — synthetic flag", description: "LIVE PROOF",
        metadata: { offer_id: liveOffer, flagType: "missing_form", flag_key: liveKey, source: FLAG_SOURCE_MANUAL },
      }).select("id").maybeSingle()
      try {
        const r = await resolveOfferComplianceFlags({
          offerId: liveOffer, brokerageId: b.id as string, actorUserId: u.id as string,
          reason: "LIVE PROOF sweep", client: svc,
        })
        check("live: sweep cleared the seeded flag", r.success && r.resolved_count >= 1)
        const { data: after } = await svc.from("activities").select("status, metadata")
          .eq("id", seeded!.id).maybeSingle()
        check("live: the row is resolved and names its actor",
          after?.status === FLAG_STATUS_RESOLVED && (after?.metadata as any)?.resolved_by === u.id)
        const r2 = await resolveOfferComplianceFlags({
          offerId: liveOffer, brokerageId: b.id as string, actorUserId: u.id as string,
          reason: "LIVE PROOF idempotent", client: svc,
        })
        check("live: idempotent re-run clears nothing", r2.success && r2.resolved_count === 0)
      } finally {
        await svc.from("activities").delete().eq("entity_id", liveOffer).eq("brokerage_id", b.id as string)
        const { count } = await svc.from("activities").select("id", { count: "exact", head: true }).eq("entity_id", liveOffer)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach(f => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ OFFER_FLAG_LOOP_FAIL"); process.exit(1) }
  console.log(" ✅ OFFER_FLAG_LOOP_PASS — misses have one identity, one row, and a clearing that records who and when")
}
main()
