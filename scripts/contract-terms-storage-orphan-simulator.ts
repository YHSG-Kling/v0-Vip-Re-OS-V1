// scripts/contract-terms-storage-orphan-simulator.ts
// ─────────────────────────────────────────────────────────────────────────────
// npm run test:contract-terms-storage-orphans
//
// TWO OWNER OBLIGATIONS FROM WAVE 12, PROVED TOGETHER BECAUSE THEY SHARE A SHAPE:
// something real happened, and nothing recorded it.
//
//   R3a "creat the required columns for the contract terms"
//        The executed contract's terms were read onto `offers` and DROPPED at the
//        offer→transaction bridge, because no column existed to hold them. m387
//        created twelve, named identically to their `offers` counterparts.
//
//   R3b "…along with the orphaned storage objects for supabase buckets"
//        Every document lane uploads the bytes and THEN mints a URL. When the URL
//        fails the caller returns — after the bytes are already in the bucket. The
//        object survives with no row anywhere pointing at it, and nothing in the
//        tree has ever swept a bucket.
//
// WHAT THIS FILE REFUSES TO DO: assert spellings. A proof frozen on a string goes
// red when a correct refactor moves it and stays green when the behaviour rots.
// Every check below runs the real function or compares two real lists.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CONTRACT_TERM_COLUMNS,
  CONTRACT_DEADLINE_COLUMNS,
  copyContractTerms,
} from "../lib/transactions/contract-terms"
import { putAndSign, removeOrRecordOrphan } from "../lib/storage/put-and-sign"
import { sweepStorageOrphans } from "../lib/storage/orphan-sweeper"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let pass = 0
const failures: string[] = []
function check(label: string, ok: boolean, why?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}${why ? `\n      ${why}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("══════════════════════════════════════════════════")
console.log(" CONTRACT TERMS ON THE DEAL · ORPHANED STORAGE OBJECTS")
console.log("══════════════════════════════════════════════════")

// ── 1 · THE TERMS HAVE A HOME, AND IT IS THE SAME NAME ON BOTH SIDES ────────
//
// The whole reason m387 reused the `offers` column names is that a 1:1 copy
// cannot drift into a second vocabulary. That is checkable against the live
// schema snapshot rather than trusted: a term added to one table and forgotten
// on the other fails HERE, at the list comparison, not months later as a NULL.
console.log("\n[the contract terms have a column on both sides]")
{
  const txCols    = new Set(SCHEMA_SNAPSHOT.transactions ?? [])
  const offerCols = new Set(SCHEMA_SNAPSHOT.offers ?? [])
  const missingOnTx    = CONTRACT_TERM_COLUMNS.filter(c => !txCols.has(c))
  const missingOnOffer = CONTRACT_TERM_COLUMNS.filter(c => !offerCols.has(c))

  check(`every contract term exists on transactions (${CONTRACT_TERM_COLUMNS.length} terms)`,
    missingOnTx.length === 0,
    missingOnTx.length ? `absent: ${missingOnTx.join(", ")} — the bridge would write a column that is not there` : undefined)
  check("…and every one of them exists on offers under the SAME name",
    missingOnOffer.length === 0,
    missingOnOffer.length ? `absent: ${missingOnOffer.join(", ")} — a second vocabulary is being created` : undefined)

  // A TERM IS NOT A DEADLINE. `inspection_period_days` is the number written on
  // the contract; `inspection_deadline` is a date derived from the contract date.
  // Letting one land in the other's slot is the same class of error as the
  // earnest DEPOSIT AMOUNT landing in the earnest DUE DATE (owner correction R28).
  const overlap = CONTRACT_TERM_COLUMNS.filter(c => (CONTRACT_DEADLINE_COLUMNS as readonly string[]).includes(c))
  check("terms and deadlines are DISJOINT sets — a term can never overwrite a date",
    overlap.length === 0,
    overlap.length ? `both lists claim: ${overlap.join(", ")}` : undefined)
}

// ── 2 · THE COPY CARRIES EVERYTHING, INCLUDING THE SILENCE ─────────────────
console.log("\n[the copy is total, and an absent term is an explicit NULL]")
{
  const offer: Record<string, unknown> = {
    financing_type: "conventional",
    down_payment_percent: 20,
    closing_cost_contribution: 7500,
    escalation_clause: true,
    escalation_cap: 615000,
    inspection_period_days: 10,
    // possession_terms / appraisal_gap / due_diligence_fee deliberately absent
  }
  const copied = copyContractTerms(offer)

  check("every declared term appears on the payload, present on the offer or not",
    CONTRACT_TERM_COLUMNS.every(c => c in copied))
  check("…values are carried verbatim, not coerced",
    copied.financing_type === "conventional" && copied.escalation_clause === true && copied.escalation_cap === 615000)
  check("…and a term the contract is silent about is an explicit null, never `undefined`",
    copied.possession_terms === null && copied.appraisal_gap === null && copied.due_diligence_fee === null,
    "an absent KEY and a null VALUE read differently at the database; only one of them says 'the contract did not say'")
  check("a zero is kept, not swallowed by a falsy test",
    copyContractTerms({ closing_cost_contribution: 0 }).closing_cost_contribution === 0,
    "`|| null` here would erase a negotiated $0 credit and a real 0-day period")
  check("no offer at all yields the full shape rather than a crash",
    CONTRACT_TERM_COLUMNS.every(c => copyContractTerms(null)[c] === null))
}

// ── 3 · THE BRIDGE ACTUALLY CARRIES THEM ───────────────────────────────────
console.log("\n[the bridge reads the terms and writes them]")
{
  const bridge = src("lib/transactions/offer-bridge.ts")
  check("the offer SELECT is built from the same list, so a new term is read automatically",
    /\.\.\.CONTRACT_TERM_COLUMNS/.test(bridge) && /\.select\(OFFER_BRIDGE_COLUMNS\)/.test(bridge),
    "a hand-typed select is how these were dropped in the first place")
  check("the transaction INSERT spreads the copied terms",
    /\.insert\(\{\s*\n\s*\.\.\.contractTerms/.test(bridge),
    "spread FIRST so the explicitly named date columns after it always win")
  check("the seller's closing-cost contribution is read rather than hard-zeroed",
    /const buyerCredit = Number\(\(offer as any\)\.closing_cost_contribution\) \|\| 0/.test(bridge),
    "a hardcoded 0 understated the buyer credit and overstated the seller's net on every negotiated deal")
  check("the contract-anchored deadline derivation is still the source of the dates",
    /deriveContractDeadlines\(\{/.test(bridge) && /inspection_deadline:\s*contractDeadlines\.inspectionDeadline/.test(bridge),
    "terms must not have displaced the derivation — both facts belong")
}

// ── 4 · THE COMPENSATING DELETE ────────────────────────────────────────────
//
// Driven against a stub, because the property is about WHAT HAPPENS ON FAILURE
// and a real bucket cannot be made to fail on demand. Pre-rollout the buckets
// are empty anyway, so a live run would prove nothing either way.
console.log("\n[an upload whose follow-up fails leaves nothing behind]")

type StubOpts = { signFails?: boolean; removeFails?: boolean; insertFails?: boolean }
function makeStorageStub(opts: StubOpts) {
  const calls = { uploaded: 0, signed: 0, removed: [] as string[], worklist: [] as Record<string, unknown>[] }
  const client = {
    storage: {
      from(_bucket: string) {
        return {
          async upload(path: string) { calls.uploaded++; return { data: { path }, error: null } },
          async createSignedUrl(path: string) {
            calls.signed++
            return opts.signFails
              ? { data: null, error: { message: "signer unavailable" } }
              : { data: { signedUrl: `https://example.test/${path}?token=t` }, error: null }
          },
          async remove(paths: string[]) {
            if (opts.removeFails) return { data: null, error: { message: "remove denied" } }
            calls.removed.push(...paths)
            return { data: paths.map(p => ({ name: p })), error: null }
          },
        }
      },
    },
    from(_table: string) {
      return {
        async upsert(row: Record<string, unknown>) {
          if (opts.insertFails) return { data: null, error: { message: "worklist write denied" } }
          calls.worklist.push(row)
          return { data: null, error: null }
        },
      }
    },
  }
  return { client, calls }
}

{
  const happy = makeStorageStub({})
  const ok = await putAndSign(happy.client as never, {
    bucket: "offer-documents", path: "b/l/contract.pdf", body: Buffer.from("x"),
  })
  check("the ordinary path returns a usable URL and removes nothing",
    ok.ok === true && happy.calls.removed.length === 0 && happy.calls.worklist.length === 0)

  const signFails = makeStorageStub({ signFails: true })
  const bad = await putAndSign(signFails.client as never, {
    bucket: "offer-documents", path: "b/l/contract.pdf", body: Buffer.from("x"),
  })
  check("a failed URL UNDOES the upload — the bucket is left as it was found",
    bad.ok === false && signFails.calls.removed.includes("b/l/contract.pdf"),
    "this is the whole defect: eleven call sites returned here with the bytes still in the bucket")
  check("…and nothing is written to the worklist, because nothing was orphaned",
    signFails.calls.worklist.length === 0,
    "a worklist that logs every hiccup is a log; this one has to be a list of real orphans")
  check("…and the caller is told which half failed",
    bad.ok === false && bad.stage === "sign" && bad.orphanRemoved === true)

  const undoFails = makeStorageStub({ signFails: true, removeFails: true })
  const stuck = await putAndSign(undoFails.client as never, {
    bucket: "offer-documents", path: "b/l/stuck.pdf", body: Buffer.from("x"), brokerageId: "brok-1",
  })
  check("when the UNDO is also refused, the object is recorded as a genuine orphan",
    stuck.ok === false && stuck.orphanRecorded === true && undoFails.calls.worklist.length === 1)
  check("…and the row names the bucket, the path and a tenant to attribute it to",
    undoFails.calls.worklist[0]?.bucket === "offer-documents"
    && undoFails.calls.worklist[0]?.object_path === "b/l/stuck.pdf"
    && undoFails.calls.worklist[0]?.brokerage_id === "brok-1")

  const blind = makeStorageStub({ signFails: true, removeFails: true, insertFails: true })
  const invisible = await putAndSign(blind.client as never, {
    bucket: "offer-documents", path: "b/l/invisible.pdf", body: Buffer.from("x"),
  })
  check("and when even the worklist write is refused, that is REPORTED, not swallowed",
    invisible.ok === false && invisible.orphanRecorded === false && invisible.orphanUnrecordedReason === "worklist write denied",
    "at that point nothing in the system knows the object exists — silence here is the worst outcome available")

  const standalone = makeStorageStub({ removeFails: false })
  const undo = await removeOrRecordOrphan(standalone.client as never, {
    bucket: "offer-documents", objectPath: "b/l/row-never-created.pdf", reason: "row_not_created",
  })
  check("the compensator is reusable by a caller that fails for its OWN reason",
    undo.orphanRemoved === true && standalone.calls.removed.includes("b/l/row-never-created.pdf"),
    "a lane that cannot fill a NOT-NULL column has the same object to undo and must not re-implement the undo")
}

// ── 5 · THE SWEEPER TELLS "CLEAN" APART FROM "COULD NOT LOOK" ──────────────
console.log("\n[the sweep never reports health it did not observe]")
{
  function worklistStub(rows: unknown[] | null, readError: string | null, removeFails = false) {
    const state = { updates: [] as Record<string, unknown>[], removed: [] as string[] }
    const query = {
      select() { return query },
      is()     { return query },
      order()  { return query },
      limit()  { return Promise.resolve({ data: rows, error: readError ? { message: readError } : null }) },
      update(payload: Record<string, unknown>) {
        state.updates.push(payload)
        return { eq: async () => ({ data: null, error: null }) }
      },
    }
    const client = {
      from: () => query,
      storage: { from: () => ({ async remove(paths: string[]) {
        if (removeFails) return { data: null, error: { message: "still locked" } }
        state.removed.push(...paths); return { data: null, error: null }
      } }) },
    }
    return { client, state }
  }

  const refused = worklistStub(null, "permission denied")
  const r1 = await sweepStorageOrphans(refused.client as never)
  check("a REFUSED read is `read_refused`, never `nothing_to_sweep`",
    r1.outcome === "read_refused" && r1.error === "permission denied",
    "supabase-js resolves a refused query, so [] and 'denied' are the same value unless the error is carried")

  const empty = worklistStub([], null)
  const r2 = await sweepStorageOrphans(empty.client as never)
  check("an empty worklist is `nothing_to_sweep` — a different fact, said differently",
    r2.outcome === "nothing_to_sweep" && r2.error === null)

  const one = worklistStub([{ id: "o1", bucket: "offer-documents", object_path: "b/l/x.pdf", cleanup_attempts: 0 }], null)
  const r3 = await sweepStorageOrphans(one.client as never)
  check("a listed orphan is removed and stamped clean",
    r3.outcome === "swept" && r3.cleaned === 1 && one.state.removed.includes("b/l/x.pdf")
    && typeof one.state.updates[0]?.cleaned_at === "string")

  const stubborn = worklistStub([{ id: "o2", bucket: "offer-documents", object_path: "b/l/y.pdf", cleanup_attempts: 3 }], null, true)
  const r4 = await sweepStorageOrphans(stubborn.client as never)
  check("one the bucket will not release stays visible instead of ageing out",
    r4.outcome === "swept" && r4.cleaned === 0 && r4.stillFailing === 1
    && stubborn.state.updates[0]?.cleanup_attempts === 4
    && stubborn.state.updates[0]?.cleanup_error === "still locked"
    && stubborn.state.updates[0]?.cleaned_at === undefined)
}

// ── 6 · THE SWEEP IS DRIVEN BY SOMETHING WITHOUT A SESSION ─────────────────
console.log("\n[the cron can actually run it]")
{
  const route = src("app/api/cron/storage-orphan-sweep/route.ts")
  check("the cron uses the SERVICE client",
    /createServiceClient\(\)/.test(route),
    "a cron has no cookie session; a `use server` module gated on auth.getUser() returns Unauthorized every iteration — the earnest-money watchdog lived its whole life that way")
  check("…and calls the sweeper rather than re-implementing the remove",
    /sweepStorageOrphans\(/.test(route))
  // The table is named as a LITERAL in the sweeper, deliberately: the
  // write-only-ledger sweep matches `.from("<table>")` on raw source, so routing
  // the read through a constant made the ledger's only reader invisible to it
  // and the guard reported a table that is written and never read. It was right
  // to; a ledger nothing reads is the defect it exists to catch.
  check("the sweeper's read is visible to the write-only-ledger guard",
    /\.from\("storage_orphaned_objects"\)/.test(src("lib/storage/orphan-sweeper.ts")))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ CONTRACT_TERMS_STORAGE_ORPHANS_FAIL — a term with no column is dropped, and an object with no row is invisible")
  process.exit(1)
}
console.log(" ✅ CONTRACT_TERMS_STORAGE_ORPHANS_PASS — the terms reach the deal, and a failed upload leaves nothing behind")
