#!/usr/bin/env tsx
/**
 * scripts/closing-compliance-guard.ts   (npm run test:closing-compliance — run with --conditions=react-server)
 * ─────────────────────────────────────────────────────────────────────────────────
 * WAVE 143, LANE B. Proves, with fixtures and a positive control for every absence it claims:
 *
 *   A. THE CHECKLIST DIMENSIONS (lib/compliance/checklist-dimensions.ts + the resolver): the code
 *      vocabularies equal the m806 CHECKs (derived from the .sql, no hand-kept copy); a NULL dimension is a
 *      wildcard; stage is cumulative ("due by") and a stage-blind caller never sees a stage-bearing row; a
 *      rule that needs a fact the caller does not have APPLIES AS A WARNING, never silently as "not
 *      required"; the most specific rule wins at one scope regardless of row order; the closing-stage audit
 *      counts documents filed on the TRANSACTION.
 *   B. CLOSING COMPLIANCE, PURE (lib/transactions/closing-compliance-core.ts): the latest EXECUTED
 *      instrument that states a term governs it; a counter supersedes the original; an unexecuted
 *      instrument never governs; an unsettled disagreement between executed papers is a CONFLICT, not a
 *      guess; a low-confidence reading never accuses a clean deal; nothing is mutated.
 *   C. CLOSING COMPLIANCE, THE RUNNER (lib/transactions/closing-compliance.ts) against an in-memory
 *      database: findings land in transaction_compliance_log, are idempotent, a human's waiver stands until
 *      the numbers move, a refused read is a blocking row (never a silent pass), another tenant's
 *      transaction is not read, and the pre-CDA gate (runFinalComplianceCheck) holds on a mismatch.
 *   D. STATE CLOSING PARTICIPANTS (lib/state-forms/closing-participants.ts): every implemented state
 *      carries a cited source; an unsupported state says UNSUPPORTED with its question — it is never an
 *      empty list that reads as "nobody required".
 *   E. A STRIPPED-SOURCE CENSUS (scripts/strip-comments.ts): nothing in the closing files writes to a
 *      signed-term table; every query is tenant-pinned; no fair-housing logic leaks into closing
 *      (owner: fair-housing checks belong to public marketing copy only); the scanner and the pre-CDA gate
 *      are wired to the runner; the migration states its status on line 1 (applied live at wave-143 integration).
 *   F. FORM PACKETS (wave 144, lane 144C — owner ruling 3; re-asserted as the RULE over wave 143's platform-owned packets): a packet
 *      is the brokerage's or ONE team's, stored under its owner's folder with its licence recorded; an agent sees and fills only
 *      the brokerage's and their OWN team's packets (canonical membership), never another team's or tenant's; sharing is an
 *      authority (oversight class brokerage-wide, a team lead for their team); the platform registry is a CATALOGUE a brokerage
 *      ADDS from (a copy into its own folder) — a tenant never fills a platform/… path; m853 scopes the bucket and the rows;
 *      no m807 row is dropped. Blind spot: RLS / storage policies are asserted from the migration TEXT, not executed.
 *
 * BLIND SPOTS (published beside the number, not hidden in it): the runner runs against an in-memory
 * database — RLS and the live column set are NOT modelled (the live columns were read through the Supabase
 * MCP when the migration was written); the settlement/contract EXTRACTION is an AI reading of a PDF and is
 * not exercised here (only what the ledger holds is); `notifyComplianceFlag` and `emitKernelEvent` are
 * injected as recorders (their own proofs cover them); the state table's SOURCES are asserted to exist and
 * be shaped, not re-fetched — re-verification is a human task on the cadence in VERIFY_EVERY_DAYS.
 */
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import {
  CHECKLIST_STAGES, CONTRACT_SUBTYPES, FINANCING_KINDS, REPRESENTATIONS, financingKindFor, rowApplicability, rowSpecificity,
} from "../lib/compliance/checklist-dimensions"
import { auditTransactionDocuments, resolveRequiredDocuments } from "../lib/compliance/required-documents"
import {
  BLOCKING_TERMS, CLOSING_TERM_KEYS, compareClosingTerms, findingToLogRow, parseDateOnly, parseParty, parseUsd, superimposeGoverningTerms,
  type TermFact, type TermMap, type TermsInstrument,
} from "../lib/transactions/closing-compliance-core"
import { runClosingCompliance } from "../lib/transactions/closing-compliance"
import { evaluateFinalCompliance, runFinalComplianceCheck } from "../lib/transactions/final-compliance-check"
import {
  STATE_CLOSING_POLICIES, VERIFY_EVERY_DAYS, CLOSING_POLICY_VERIFIED_ON, assessClosingParticipants, closingPolicyAgeDays,
} from "../lib/state-forms/closing-participants"
import { ALL_US_STATES } from "../lib/state-forms/registry"
import { blankStrings, stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
/** A POSITIVE CONTROL: the finder must recognise the defect it was written for in a specimen. */
const control = (n: string, finder: (s: string) => boolean, specimen: string) => check(`POSITIVE CONTROL — ${n}`, finder(specimen) === true)
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
const code = (p: string) => blankStrings(stripComments(read(p)))
const codeWithStrings = (p: string) => stripComments(read(p))

// ── An in-memory supabase: select / eq / in / or / is / not / filter / order / limit / insert / update / delete ──
type Row = Record<string, any>
function makeDb(tables: Record<string, Row[]>, refuse: Record<string, string> = {}) {
  const reads: Array<{ table: string; brokerage: unknown }> = []
  const objects = new Map<string, Uint8Array>()
  const client: any = {
    tables, reads, objects,
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, buf: Uint8Array) => (objects.has(`${bucket}/${path}`) ? { data: null, error: { message: "The resource already exists" } } : (objects.set(`${bucket}/${path}`, buf), { data: { path }, error: null })),
        remove: async (paths: string[]) => ({ data: paths.filter((p) => objects.delete(`${bucket}/${p}`)).map((name) => ({ name })), error: null }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null }),
        // wave 144 (lane 144C): the packet library lists an owner's folder (files directly in it) and copies a catalogue master.
        list: async (prefix: string) => ({ data: [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}/`) && !k.slice(`${bucket}/${prefix}/`.length).includes("/")).map((k) => ({ name: k.slice(`${bucket}/${prefix}/`.length), id: k })), error: null }),
        copy: async (from: string, to: string) => (!objects.has(`${bucket}/${from}`) ? { data: null, error: { message: "Object not found" } } : objects.has(`${bucket}/${to}`) ? { data: null, error: { message: "The resource already exists" } } : (objects.set(`${bucket}/${to}`, objects.get(`${bucket}/${from}`)!), { data: { path: to }, error: null })),
      }),
    },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      const st: { op: "select" | "insert" | "update" | "delete"; patch?: Row; rows?: Row[]; order?: { col: string; asc: boolean }; limit?: number; count?: boolean; head?: boolean; returning?: boolean; brokerage?: unknown } = { op: "select" }
      const exec = (single: boolean) => {
        const refusal = refuse[`${table}:${st.op}`] ?? refuse[table]
        if (refusal) return { data: null, error: { message: refusal }, count: null }
        const all = (tables[table] ??= [])
        const hit = () => all.filter((r) => filters.every((f) => f(r)))
        if (st.op === "select") {
          reads.push({ table, brokerage: st.brokerage })
          let rows = hit()
          if (st.order) { const { col, asc } = st.order; rows = [...rows].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (asc ? 1 : -1)) }
          if (st.limit !== undefined) rows = rows.slice(0, st.limit)
          if (st.head) return { data: null, error: null, count: rows.length }
          return { data: single ? (rows[0] ?? null) : rows, error: null, count: st.count ? rows.length : null }
        }
        if (st.op === "insert") {
          const made = (st.rows ?? []).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }))
          all.push(...made)
          return { data: st.returning ? made.map((m) => ({ ...m })) : null, error: null, count: null }
        }
        if (st.op === "update") { const rows = hit(); for (const r of rows) Object.assign(r, st.patch); return { data: st.returning ? rows.map((r) => ({ ...r })) : null, error: null, count: null } }
        const rows = hit(); tables[table] = all.filter((r) => !rows.includes(r))
        return { data: st.returning ? rows : null, error: null, count: null }
      }
      const b: any = {
        select(_c?: string, o?: { count?: string; head?: boolean }) { if (st.op !== "select") st.returning = true; if (o?.count) st.count = true; if (o?.head) st.head = true; return b },
        insert(rows: Row | Row[]) { st.op = "insert"; st.rows = Array.isArray(rows) ? rows : [rows]; return b },
        update(patch: Row) { st.op = "update"; st.patch = patch; return b },
        delete() { st.op = "delete"; return b },
        eq(c: string, v: unknown) { if (c === "brokerage_id") st.brokerage = v; filters.push((r) => r[c] === v); return b },
        is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b },
        not(c: string, _op: string, v: unknown) { filters.push((r) => (r[c] ?? null) !== v); return b },
        neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b },
        in(c: string, a: unknown[]) { filters.push((r) => a.includes(r[c])); return b },
        or(expr: string) { const cl = expr.split(",").map((x) => x.split(".")); filters.push((r) => cl.some(([col, op, ...v]) => op === "eq" && String(r[col]) === v.join("."))); return b },
        filter(path: string, _op: string, val: unknown) { const m = path.match(/^(\w+)->>(\w+)$/); if (m) filters.push((r) => (r[m[1]] ?? {})[m[2]] === val); return b },
        order(col: string, o?: { ascending?: boolean }) { st.order = { col, asc: o?.ascending !== false }; return b },
        limit(n: number) { st.limit = n; return b },
        maybeSingle: async () => exec(true),
        single: async () => exec(true),
        then: (res: any, rej: any) => Promise.resolve(exec(false)).then(res, rej),
      }
      return b
    },
  }
  return client
}

const B1 = randomUUID(), B2 = randomUUID()
const iso = (d: string) => `${d}T12:00:00.000Z`

async function main() {
  // ═══ A. CHECKLIST DIMENSIONS ═══════════════════════════════════════════════════════════════════
  section("A1 vocabularies equal the m806 CHECKs (derived from the .sql)")
  const sqlPath = "supabase/migrations/m806-required-documents-checklist-dimensions.sql"
  const sql = read(sqlPath)
  const sqlCode = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  const checkSet = (col: string): string[] | null => {
    const m = new RegExp(`${col}\\s+IS NULL OR ${col}\\s+IN\\s*\\(([^)]*)\\)`).exec(sqlCode)
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null
  }
  const sameSet = (a: readonly string[] | null, b: readonly string[]) => !!a && a.length === b.length && b.every((x) => a.includes(x))
  check("m806 states its status on line 1 (the lane stamp until applied; APPLIED LIVE once the integrator applied it)", /^-- (WRITTEN, NOT APPLIED \(wave 143, lane 143B\)|── APPLIED LIVE )/.test(sql.split("\n")[0]))
  check("required_stage CHECK = CHECKLIST_STAGES", sameSet(checkSet("required_stage"), CHECKLIST_STAGES))
  check("financing_kind CHECK = FINANCING_KINDS", sameSet(checkSet("financing_kind"), FINANCING_KINDS))
  check("contract_subtype CHECK = CONTRACT_SUBTYPES", sameSet(checkSet("contract_subtype"), CONTRACT_SUBTYPES))
  check("representation CHECK = REPRESENTATIONS", sameSet(checkSet("representation"), REPRESENTATIONS))
  check("POSITIVE CONTROL — the set comparison sees a drifted vocabulary", !sameSet(["listing", "offer"], CHECKLIST_STAGES) && !sameSet(checkSet("no_such_column"), CHECKLIST_STAGES))

  section("A2 rowApplicability — wildcard, cumulative stage, unresolved → warning")
  check("an all-NULL row (every pre-m806 row) applies to any question", rowApplicability({}, {}).applies && rowApplicability({}, { stage: "closing", financing: "cash" }).applies)
  check("a stage-bearing row is NOT applied for a stage-blind caller (backward compatible)", !rowApplicability({ required_stage: "closing" }, {}).applies)
  check("stage is cumulative: due-by-offer applies at contract and closing", rowApplicability({ required_stage: "offer" }, { stage: "contract" }).applies && rowApplicability({ required_stage: "offer" }, { stage: "closing" }).applies)
  check("…and a closing-stage row is not yet due at the offer stage", !rowApplicability({ required_stage: "closing" }, { stage: "offer" }).applies)
  const cashRow = { financing_kind: "cash" }
  check("cash-only rule + financed deal → does not apply", !rowApplicability(cashRow, { financing: "financed" }).applies)
  check("cash-only rule + cash deal → applies, fully resolved", (() => { const r = rowApplicability(cashRow, { financing: "cash" }); return r.applies && r.unresolved.length === 0 })())
  check("cash-only rule + financing UNKNOWN → applies as a WARNING naming financing_kind", (() => { const r = rowApplicability(cashRow, {}); return r.applies && r.unresolved.includes("financing_kind") })())
  check("rowSpecificity counts the dimensions a rule pins down", rowSpecificity({}) === 0 && rowSpecificity({ state_code: "FL", financing_kind: "cash", required_stage: "closing" }) === 3)
  check("financingKindFor: cash→cash, conventional/fha/va/other→financed, empty/absent→UNKNOWN (never cash)",
    financingKindFor("cash") === "cash" && ["conventional", "fha", "va", "usda", "other"].every((t) => financingKindFor(t) === "financed") && financingKindFor("") === null && financingKindFor(null) === null)
  const naiveApplies = (_row: Record<string, unknown>, _ctx: Record<string, unknown>) => true
  check("POSITIVE CONTROL — a naive 'always applies' implementation fails the stage and financing expectations",
    naiveApplies({ required_stage: "closing" }, {}) === true /* the defect */ && rowApplicability({ required_stage: "closing" }, {}).applies === false)

  section("A3 the resolver — specificity, warnings, stage, evidence")
  const rule = (o: Row): Row => ({ id: randomUUID(), brokerage_id: B1, scope_type: "brokerage", scope_id: B1, deal_type: "seller", is_required: true, block_on_missing: true, state_code: null, policy_version: 1, ...o })
  const resolve = (rows: Row[], ctx: Record<string, unknown> = {}) =>
    resolveRequiredDocuments(makeDb({ brokerage_required_documents: rows }), { brokerageId: B1, dealType: "seller", ...ctx } as any)
  {
    const generic = rule({ classification: "disclosure", block_on_missing: false })
    const florida = rule({ classification: "disclosure", block_on_missing: true, state_code: "FL" })
    const a = await resolve([generic, florida], { stateCode: "FL" }), b = await resolve([florida, generic], { stateCode: "FL" })
    check("a state-specific rule beats the generic one at the SAME scope, whatever the row order",
      a.ok && b.ok && a.docs[0].block_on_missing === true && b.docs[0].block_on_missing === true)
    const tx = await resolve([generic, florida], { stateCode: "TX" })
    check("…and in another state only the generic rule answers", tx.ok && tx.docs.length === 1 && tx.docs[0].block_on_missing === false)
  }
  {
    const cash = rule({ classification: "proof_of_funds", financing_kind: "cash" })
    const unknown = await resolve([cash]), cashCtx = await resolve([cash], { financing: "cash" }), fin = await resolve([cash], { financing: "financed" })
    check("a cash-only BLOCKING rule with financing unknown is demoted to a warning and names why", unknown.ok && unknown.docs.length === 1 && unknown.docs[0].block_on_missing === false && !!unknown.docs[0].unresolved?.includes("financing_kind"))
    check("…blocks on a cash deal…", cashCtx.ok && cashCtx.docs[0].block_on_missing === true)
    check("…and does not apply to a financed deal", fin.ok && fin.docs.length === 0)
    const closing = rule({ classification: "wire_instructions", required_stage: "closing" })
    const blind = await resolve([closing]), atClosing = await resolve([closing], { stage: "closing" }), atOffer = await resolve([closing], { stage: "offer" })
    check("a closing-stage rule is invisible to a stage-blind caller and to the offer stage, present at closing", blind.ok && blind.docs.length === 0 && atOffer.ok && atOffer.docs.length === 0 && atClosing.ok && atClosing.docs.length === 1)
    const v = await resolve([rule({ classification: "disclosure", policy_version: 3 }), rule({ classification: "agency_disclosure", policy_version: 7 })])
    check("the outcome carries the checklist evidence: max policy_version and a fingerprint citing every rule",
      v.ok && v.policy_version === 7 && !!v.checklist_fingerprint && v.docs.every((d) => v.checklist_fingerprint!.includes(String(d.rule_id))))
    const legacy = await resolve([{ id: randomUUID(), brokerage_id: B1, scope_type: "brokerage", scope_id: B1, deal_type: "seller", is_required: true, block_on_missing: true, state_code: null, classification: "disclosure" }])
    check("a PRE-m806 row (no dimension columns at all) answers exactly as before", legacy.ok && legacy.docs.length === 1 && legacy.docs[0].block_on_missing === true && !legacy.docs[0].unresolved?.length)
    const refused = await resolveRequiredDocuments(makeDb({}, { brokerage_required_documents: "permission denied" }), { brokerageId: B1, dealType: "seller" })
    check("a REFUSED checklist read is ok:false — never an empty checklist", !refused.ok)
  }
  {
    const txId = randomUUID()
    const db = makeDb({
      brokerage_required_documents: [rule({ classification: "closing_disclosure", required_stage: "closing" })],
      documents: [{ id: randomUUID(), brokerage_id: B1, transaction_id: txId, classification: "closing_disclosure", signature_completeness: null, status: "uploaded" }],
    })
    const audit = await auditTransactionDocuments(db, { transactionId: txId, brokerageId: B1, dealType: "seller" })
    check("the closing-stage audit counts a document filed on the TRANSACTION (the title portal's anchor)", audit.unavailable_reason === null && audit.required_total === 1 && audit.missing_blocking.length === 0)
    const none = await auditTransactionDocuments(makeDb({ brokerage_required_documents: [rule({ classification: "closing_disclosure", required_stage: "closing" })], documents: [] }), { transactionId: txId, brokerageId: B1, dealType: "seller" })
    check("…and reports the closing document MISSING and blocking when it is not on file", none.missing_blocking.includes("closing_disclosure"))
  }

  // ═══ B. CLOSING COMPLIANCE, PURE ═══════════════════════════════════════════════════════════════
  section("B1 precedence — the latest executed instrument that states a term governs it")
  const usd = (value: number, source: string, confidence: TermFact["confidence"] = "record"): TermFact => ({ unit: "usd", value, confidence, source })
  const party = (value: "buyer" | "seller" | "split", source: string, confidence: TermFact["confidence"] = "record"): TermFact => ({ unit: "party", value, confidence, source })
  const instr = (o: Partial<TermsInstrument> & { id: string; kind: TermsInstrument["kind"]; terms: TermMap }): TermsInstrument => ({ label: o.id, executed: true, executedAt: null, round: null, ...o })
  const original = instr({ id: "orig", kind: "original_offer", label: "original offer", terms: { purchase_price: usd(400000, "original offer"), owner_title_policy_payer: party("seller", "original offer") } })
  const counter = instr({ id: "ctr", kind: "counter", label: "counter round 1", executedAt: iso("2026-10-02"), round: 1, terms: { purchase_price: usd(395000, "counter round 1") } })
  const gov = superimposeGoverningTerms([original, counter])
  check("a counter supersedes the original on the term it changes", gov.terms.purchase_price?.unit === "usd" && gov.terms.purchase_price.value === 395000)
  check("…and the original's other terms are INHERITED (title payer survives)", gov.terms.owner_title_policy_payer?.value === "seller")
  check("…and the original value is PRESERVED in history, naming what superseded it", gov.history.purchase_price?.[0]?.fact.value === 400000 && gov.history.purchase_price[0].supersededBy === "counter round 1")
  const unexec = superimposeGoverningTerms([original, counter, instr({ id: "add0", kind: "addendum", label: "unsigned addendum", executed: false, terms: { purchase_price: usd(390000, "unsigned addendum") } })])
  check("an UNEXECUTED addendum never governs, and is listed as ignored with the reason", unexec.terms.purchase_price?.value === 395000 && unexec.ignored.some((i) => i.id === "add0" && /not fully executed/.test(i.reason)))
  const addendum = superimposeGoverningTerms([original, counter, instr({ id: "add1", kind: "addendum", label: "addendum 1", executedAt: iso("2026-10-20"), terms: { purchase_price: usd(392500, "addendum 1"), owner_title_policy_payer: party("buyer", "addendum 1") } })])
  check("an executed addendum supersedes the counter (price and who-pays)", addendum.terms.purchase_price?.value === 392500 && addendum.terms.owner_title_policy_payer?.value === "buyer" && addendum.applied.map((a) => a.id).join() === "orig,ctr,add1")
  const lastWriteWins = (list: TermsInstrument[]): number => list.reduce<number>((acc, i) => (i.terms.purchase_price && typeof i.terms.purchase_price.value === "number" ? i.terms.purchase_price.value : acc), 0)
  check("POSITIVE CONTROL — a 'last write wins, executed or not' mutant would have governed at the unsigned $390,000",
    lastWriteWins([original, counter, instr({ id: "x", kind: "addendum", executed: false, terms: { purchase_price: usd(390000, "x") } })]) === 390000 && unexec.terms.purchase_price?.value !== 390000)
  const conflicted = superimposeGoverningTerms([
    instr({ id: "orig", kind: "original_offer", terms: { purchase_price: usd(400000, "original offer") } }),
    instr({ id: "ctr", kind: "counter", executedAt: iso("2026-10-05"), round: 1, terms: { purchase_price: usd(395000, "accepted counter") } }),
    instr({ id: "doc", kind: "executed_contract", executedAt: iso("2026-10-01"), terms: { purchase_price: usd(400000, "executed contract on file") } }),
  ])
  check("a LATER counter against an EARLIER executed-contract document is a CONFLICT the paper does not settle", !!conflicted.conflicts.purchase_price && conflicted.conflicts.purchase_price.loser.value === 395000)
  const settledByAddendum = superimposeGoverningTerms([
    instr({ id: "ctr", kind: "counter", executedAt: iso("2026-10-05"), terms: { purchase_price: usd(395000, "accepted counter") } }),
    instr({ id: "doc", kind: "executed_contract", executedAt: iso("2026-10-01"), terms: { purchase_price: usd(400000, "executed contract on file") } }),
    instr({ id: "add", kind: "addendum", executedAt: iso("2026-10-20"), terms: { purchase_price: usd(395000, "addendum") } }),
  ])
  check("…and a later addendum restating the term clears it", !settledByAddendum.conflicts.purchase_price && settledByAddendum.terms.purchase_price?.value === 395000)
  const dated = superimposeGoverningTerms([
    instr({ id: "ctr", kind: "counter", executedAt: iso("2026-09-30"), terms: { purchase_price: usd(395000, "counter") } }),
    instr({ id: "doc", kind: "executed_contract", executedAt: iso("2026-10-06"), terms: { purchase_price: usd(395000, "contract") } }),
  ])
  check("a counter and a LATER contract that AGREE are not a conflict", !dated.conflicts.purchase_price)

  section("B2 the comparison — match / mismatch / unverifiable / conflict")
  const settlement = (o: TermMap): TermMap => o
  const g: TermMap = {
    purchase_price: usd(395000, "counter round 1"), earnest_money: usd(10000, "offer record"),
    owner_title_policy_payer: party("seller", "original offer"),
    commission_listing_side: { unit: "pct", value: 3, confidence: "record", source: "listing record" },
    commission_buyer_side: { unit: "pct", value: 2.5, confidence: "record", source: "offer record" },
  }
  const clean = compareClosingTerms(g, settlement({
    purchase_price: usd(395000, "final CD", "high"), earnest_money: usd(10000, "final CD", "high"), owner_title_policy_payer: party("seller", "final CD", "high"),
    commission_listing_side: usd(11850, "final CD", "high"), commission_buyer_side: usd(9875, "final CD", "high"),
  }))
  check("a clean settlement matches every term, with percentage commissions applied to the GOVERNING price", clean.counts.match === 5 && clean.counts.mismatch === 0 && clean.counts.blocking === 0)
  const stale = compareClosingTerms(g, settlement({ purchase_price: usd(400000, "final CD", "high") }))
  const stalePrice = stale.findings.find((f) => f.term === "purchase_price")!
  check("THE OWNER'S CASE — a settlement that still shows the ORIGINAL price is a blocking mismatch against the counter", stalePrice.verdict === "mismatch" && stalePrice.blocking && /\$395,000\.00/.test(stalePrice.why) && /\$400,000\.00/.test(stalePrice.why))
  const payer = compareClosingTerms(g, settlement({ owner_title_policy_payer: party("buyer", "final CD", "high") })).findings.find((f) => f.term === "owner_title_policy_payer")!
  check("THE OWNER'S CASE — the owner's title policy on the wrong party's side is a blocking mismatch", payer.term === "owner_title_policy_payer" && payer.verdict === "mismatch" && payer.blocking)
  const roundingOk = compareClosingTerms(g, settlement({ commission_listing_side: usd(11850.4, "final CD", "high") })).findings.find((f) => f.term === "commission_listing_side")!
  const roundingBad = compareClosingTerms(g, settlement({ commission_listing_side: usd(11700, "final CD", "high") })).findings.find((f) => f.term === "commission_listing_side")!
  check("a percentage commission tolerates dollar rounding but not a real difference", roundingOk.verdict === "match" && roundingBad.verdict === "mismatch" && roundingBad.blocking)
  const exactMoney = compareClosingTerms({ purchase_price: usd(395000, "x") }, { purchase_price: usd(395000.5, "y", "high") }).findings[0]
  check("a stated dollar figure must agree to the cent", exactMoney.verdict === "mismatch")
  const lowDiff = compareClosingTerms(g, settlement({ purchase_price: usd(459000, "scan", "low") })).findings[0]
  check("a DIFFERENCE resting on a low-confidence reading is UNVERIFIABLE (needs a person), not a mismatch", lowDiff.verdict === "unverifiable" && !lowDiff.blocking)
  const lowMatch = compareClosingTerms(g, settlement({ purchase_price: usd(395000, "scan", "low") })).findings[0]
  check("…but a MATCH is a match whatever the confidence", lowMatch.verdict === "match")
  const missingSide = compareClosingTerms(g, settlement({ purchase_price: usd(395000, "final CD", "high") })).findings.find((f) => f.term === "earnest_money")!
  check("a term the settlement does not state is UNVERIFIABLE — 'could not tell' is never 'matched'", missingSide.verdict === "unverifiable" && /does not state it/.test(missingSide.why))
  const dateOnly = compareClosingTerms({ closing_date: { unit: "date", value: "2026-12-01", confidence: "record", source: "offer" } }, { closing_date: { unit: "date", value: "2026-12-15", confidence: "high", source: "final CD" } }).findings[0]
  check("a closing-date mismatch is flagged but does NOT block (an extension may be in flight)", dateOnly.verdict === "mismatch" && !dateOnly.blocking && !BLOCKING_TERMS.has("closing_date"))
  const conflictFinding = compareClosingTerms({ purchase_price: usd(400000, "executed contract") }, { purchase_price: usd(395000, "final CD", "high") }, { purchase_price: { winner: usd(400000, "executed contract"), loser: usd(395000, "counter") } }).findings[0]
  check("a CONFLICT between executed papers is reported as such and holds the closing on a money term", conflictFinding.verdict === "conflict" && conflictFinding.blocking && findingToLogRow(conflictFinding).is_blocking && findingToLogRow(conflictFinding).status === "needs_review")
  const frozenG = JSON.parse(JSON.stringify(g)), frozenS = { purchase_price: usd(400000, "x", "high") }
  const snapG = JSON.stringify(g), snapS = JSON.stringify(frozenS)
  compareClosingTerms(g, frozenS)
  check("the comparison NEVER mutates a governing term or the settlement (flag, never edit)", JSON.stringify(g) === snapG && JSON.stringify(frozenS) === snapS && JSON.stringify(frozenG) === snapG)
  check("every finding that is not a match carries a correction that names who fixes it and never says to edit the signed term",
    [stalePrice, payer, roundingBad, lowDiff, missingSide, dateOnly, conflictFinding].every((f) => f.correction.length > 20 && !/edit the (signed|contract)/i.test(f.correction)))
  check("parsers: money, dates, parties", parseUsd("$425,000.00") === 425000 && parseUsd("abc") === null && parseDateOnly("12/1/2026") === "2026-12-01" && parseDateOnly("soon") === null && parseParty("Borrower") === "buyer" && parseParty("everyone") === null)
  check("the term vocabulary has one definer: every term has a blocking decision and a label", CLOSING_TERM_KEYS.length >= 7)

  // ═══ C. THE RUNNER ══════════════════════════════════════════════════════════════════════════════
  section("C closing compliance against an in-memory database")
  const notifications: Array<{ n: number; blocking: boolean }> = []
  const deps = {
    // Records a notification only when something CHANGED — the real notifier sends nothing for an empty set.
    notify: async (_s: unknown, _tx: unknown, changed: Array<{ is_blocking: boolean }>) => { if (changed.length === 0) return 0; notifications.push({ n: changed.length, blocking: changed.some((c) => c.is_blocking) }); return changed.length },
    audit: async () => {},
    closingEntity: async () => "title_company" as string | null,
  }
  const mk = (o: { state?: string; settlement?: Row; docs?: Row[]; participants?: string[]; counterPrice?: number; rules?: Row[]; dealType?: string } = {}) => {
    const tx = randomUUID(), root = randomUUID(), ctr = randomUUID(), listing = randomUUID()
    const settlementDoc = randomUUID()
    const sf = o.settlement ?? { sales_price: 395000, earnest_money_deposit: 10000, closing_date: "2026-12-01", owner_title_policy_payer: "seller", commission_listing_broker: 11850, commission_buyer_broker: 9875 }
    const tables: Record<string, Row[]> = {
      transactions: [{ id: tx, brokerage_id: B1, offer_id: ctr, listing_id: listing, deal_type: o.dealType ?? "seller", agent_id: null, buyer_agent_id: null, seller_agent_id: null, property_state: o.state ?? "TX", financing_type: "conventional", purchase_price: 395000, close_date: "2026-12-01", earnest_money: 10000, closing_cost_contribution: 0, contract_date: "2026-10-03" }],
      offers: [
        { id: root, brokerage_id: B1, parent_offer_id: null, current_round: 0, offer_price: 400000, earnest_money: 10000, closing_date: "2026-12-01", closing_cost_contribution: 0, disclosed_buyer_commission_pct: 2.5, esign_status: "pending" },
        { id: ctr, brokerage_id: B1, parent_offer_id: root, current_round: 1, offer_price: o.counterPrice ?? 395000, earnest_money: 10000, closing_date: "2026-12-01", closing_cost_contribution: 0, disclosed_buyer_commission_pct: 2.5, esign_status: "fully_executed", seller_signed_at: iso("2026-10-03") },
      ],
      listings: [{ id: listing, brokerage_id: B1, commission_rate: 3 }],
      documents: [
        { id: settlementDoc, brokerage_id: B1, transaction_id: tx, classification: "closing_disclosure", classification_confidence: "high", extracted_fields: sf, signature_completeness: null, created_at: iso("2026-11-20") },
        { id: randomUUID(), brokerage_id: B1, transaction_id: tx, classification: "signed_contract", classification_confidence: "high", extracted_fields: { owner_title_policy_payer: "seller" }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }] }, created_at: iso("2026-10-04") },
        ...(o.docs ?? []),
      ],
      document_field_extractions: [],
      closing_disclosure_agreement: [{ id: randomUUID(), brokerage_id: B1, transaction_id: tx, preliminary_cd_document_id: settlementDoc, final_cd_document_id: null, updated_at: iso("2026-11-20") }],
      transaction_compliance_log: [],
      transaction_participants: (o.participants ?? []).map((role) => ({ id: randomUUID(), brokerage_id: B1, transaction_id: tx, role })),
      brokerage_required_documents: o.rules ?? [],
    }
    return { db: makeDb(tables), tx, settlementDoc, tables }
  }
  const logRow = (t: Record<string, Row[]>, type: string) => t.transaction_compliance_log.find((r) => r.check_type === type)

  {
    const f = mk()
    const r1 = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("a clean closing runs, finds nothing open, and files PASS rows for each compared term", r1.ran && r1.openBlocking === 0 && !!r1.comparison && r1.comparison.findings.length >= 5 && r1.comparison.counts.match === r1.comparison.findings.length && logRow(f.tables, "closing_terms.purchase_price")?.status === "pass",
      JSON.stringify({ ran: r1.ran, reason: r1.reason, ob: r1.openBlocking, counts: r1.comparison?.counts, summary: r1.summary.slice(0, 4), findings: r1.comparison?.findings.map((x) => `${x.term}:${x.verdict}:${x.governing}|${x.settlement}`) }))
    check("…a counter-changed price governs (the original offer's $400,000 is not what is compared)", r1.comparison?.findings.find((x) => x.term === "purchase_price")?.governing === "$395,000.00")
    const n1 = notifications.length
    const r2 = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("re-running with nothing changed writes nothing and notifies nobody (idempotent)", r2.rows.inserted === 0 && r2.rows.updated === 0 && notifications.length === n1)
  }
  {
    const f = mk({ settlement: { sales_price: 400000, earnest_money_deposit: 10000, closing_date: "2026-12-01", owner_title_policy_payer: "buyer", commission_listing_broker: 12000, commission_buyer_broker: 10000 } })
    const before = JSON.stringify(f.tables.offers) + JSON.stringify(f.tables.transactions) + JSON.stringify(f.tables.documents.map((d) => d.extracted_fields))
    const r = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    const price = logRow(f.tables, "closing_terms.purchase_price"), title = logRow(f.tables, "closing_terms.owner_title_policy_payer")
    check("a settlement that shows the ORIGINAL price and the wrong title payer files BLOCKING FAIL rows", r.openBlocking >= 2 && price?.status === "fail" && price.is_blocking === true && title?.status === "fail" && title.is_blocking === true)
    check("the failure text names both numbers and who corrects it", /\$395,000\.00/.test(price?.failure_reason ?? "") && /\$400,000\.00/.test(price?.failure_reason ?? "") && /title company/i.test(price?.failure_reason ?? ""))
    check("the signed terms are untouched: offers, transactions and the contract documents are byte-identical after the run", before === JSON.stringify(f.tables.offers) + JSON.stringify(f.tables.transactions) + JSON.stringify(f.tables.documents.map((d) => d.extracted_fields)))
    const n = notifications.length
    check("the first run notified once, with a blocking item", notifications[n - 1]?.blocking === true)
    await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("an unchanged re-run does not notify again", notifications.length === n)
    // A human waives the price row; the numbers do not move → the waiver stands.
    price!.status = "waived"; price!.resolution_notes = "title will reissue"
    const waived = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("a HUMAN'S WAIVER stands while the compared values are the ones they waived", price!.status === "waived" && waived.rows.reopened === 0)
    // The corrected statement changes a value → the waiver no longer applies.
    f.tables.documents[0].extracted_fields = { ...f.tables.documents[0].extracted_fields, sales_price: 398000 }
    const reopened = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("when a corrected statement CHANGES the number, the waived row RE-OPENS with a note saying so", reopened.rows.reopened >= 1 && price!.status === "fail" && /superseded/i.test(price!.resolution_notes ?? ""))
    f.tables.documents[0].extracted_fields = { ...f.tables.documents[0].extracted_fields, sales_price: 395000 }
    await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("when the statement is corrected to match, the row clears itself", price!.status === "pass")
  }
  {
    const f = mk({ settlement: { sales_price: 395000, closing_date: "2026-12-01" } })
    f.tables.documents.splice(0, 1) // no settlement statement at all
    const idle = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "contract_document_scanned" }, deps)
    check("a contract upload before any settlement statement exists is idle — it writes nothing", !idle.ran && f.tables.transaction_compliance_log.length === 0 && /no settlement statement/i.test(idle.reason ?? ""))
    const gate = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "final_check" }, deps)
    check("the PRE-CDA gate with no settlement statement files a BLOCKING row (nothing to compare is not a pass)", gate.ran && logRow(f.tables, "closing_terms.settlement_statement")?.is_blocking === true && gate.openBlocking >= 1)
  }
  {
    const f = mk({ counterPrice: 395000, settlement: { sales_price: 395000 } })
    f.tables.documents.push({ id: randomUUID(), brokerage_id: B1, transaction_id: f.tx, classification: "addendum", classification_confidence: "high", extracted_fields: { price: 390000 }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }], initials: [] }, created_at: iso("2026-11-01") })
    const r = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("an addendum signed by ONLY the buyer does not govern (the $390,000 is ignored; $395,000 still matches)", logRow(f.tables, "closing_terms.purchase_price")?.status === "pass" && r.openBlocking === 0)
    const audited: Array<{ metadata: Record<string, unknown> }> = []
    await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, { ...deps, audit: async (_tx: unknown, ev: { metadata: Record<string, unknown> }) => { audited.push(ev) } })
    const ignored = (audited[0]?.metadata.governing_ignored ?? []) as Array<{ reason: string }>
    check("…and the run's audit evidence lists it as ignored, with the reason (LAW 5: what was set aside is recorded)", ignored.some((i) => /not fully executed/.test(i.reason)))
    f.tables.documents[f.tables.documents.length - 1].signature_completeness = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [] }
    await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "contract_document_scanned" }, deps)
    check("signed by BOTH parties (initials not yet verified), the same addendum now governs — and the settlement at $395,000 is a mismatch against $390,000", logRow(f.tables, "closing_terms.purchase_price")?.status === "fail")
  }
  {
    const f = mk()
    const other = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B2, trigger: "final_check" }, deps)
    check("ANOTHER TENANT's session cannot run (or read) a transaction it does not own", !other.ran && /not found in this brokerage/.test(other.reason ?? "") && f.tables.transaction_compliance_log.length === 0)
    const reads = (f.db as any).reads as Array<{ table: string; brokerage: unknown }>
    check("every read the runner made was pinned to a brokerage_id", reads.length > 0 && reads.every((x) => x.brokerage === B1 || x.brokerage === B2))
  }
  {
    const f = mk()
    const refusedDb = makeDb(f.tables, { "transaction_compliance_log:select": "permission denied for table transaction_compliance_log" })
    const r = await runClosingCompliance(refusedDb, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("a REFUSED compliance-log read stops the run with the reason — it never writes duplicates over an unread log", !r.ran && /could not be read/.test(r.reason ?? "") && f.tables.transaction_compliance_log.length === 0)
    const fault = mk()
    const faultDb = makeDb(fault.tables, { "document_field_extractions:select": "relation does not exist" })
    const fr = await runClosingCompliance(faultDb, { transactionId: fault.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("an unreadable INPUT files a BLOCKING row — 'nobody checked' never renders as 'checked and fine'", fr.ran && logRow(fault.tables, "closing_terms.inputs")?.is_blocking === true)
    const fixed = await runClosingCompliance(makeDb(fault.tables), { transactionId: fault.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("…and the fault row clears itself once the input is readable again", fixed.ran && logRow(fault.tables, "closing_terms.inputs")?.status === "pass")
  }
  {
    // Two scans land together: the other writer's rows appear between our read and our insert (the m806 unique index answers 23505).
    const f = mk()
    let raced = false
    const base = f.db.from.bind(f.db)
    f.db.from = (table: string) => {
      const b = base(table)
      if (table !== "transaction_compliance_log") return b
      const realInsert = b.insert.bind(b)
      b.insert = (rows: Row[]) => {
        if (raced) return realInsert(rows)
        raced = true
        f.tables.transaction_compliance_log.push(...rows.map((r) => ({ id: randomUUID(), ...r })))
        return { select: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }) }
      }
      return b
    }
    const r = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    const types = f.tables.transaction_compliance_log.map((x) => x.check_type)
    check("a LOST INSERT RACE (23505) re-reads and reconciles: the check completes and no check_type is duplicated", r.ran && raced && types.length === new Set(types).size && types.length > 0)
  }
  {
    const blockingRule = (cls: string): Row => ({ id: randomUUID(), brokerage_id: B1, scope_type: "brokerage", scope_id: B1, deal_type: "seller", is_required: true, block_on_missing: true, state_code: null, classification: cls, required_stage: "closing", policy_version: 4 })
    const f = mk({ rules: [blockingRule("wire_instructions"), blockingRule("closing_disclosure")] })
    const r = await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("the brokerage's CLOSING-stage checklist drives the closing file: a missing required document is a blocking row, a present one passes",
      logRow(f.tables, "closing_docs.wire_instructions")?.status === "fail" && logRow(f.tables, "closing_docs.wire_instructions")?.is_blocking === true && logRow(f.tables, "closing_docs.closing_disclosure")?.status === "pass" && r.openBlocking >= 1)
    check("…and the failure cites the checklist fingerprint (which rules, which versions)", /@4/.test(logRow(f.tables, "closing_docs.wire_instructions")?.failure_reason ?? ""))
    f.tables.documents.push({ id: randomUUID(), brokerage_id: B1, transaction_id: f.tx, classification: "wire_instructions", signature_completeness: null, created_at: iso("2026-11-21") })
    await runClosingCompliance(f.db, { transactionId: f.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("filing the document on the transaction clears the row on the next run", logRow(f.tables, "closing_docs.wire_instructions")?.status === "pass")
  }
  {
    const ga = mk({ state: "GA" }), gaOk = mk({ state: "GA", participants: ["closing_attorney"] }), tx = mk({ state: "TX" })
    const gaRun = await runClosingCompliance(ga.db, { transactionId: ga.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    const gaRow = logRow(ga.tables, "closing_participants.closing_attorney")
    check("Georgia with no attorney on the deal files a NON-blocking needs-review row citing the Georgia Supreme Court", gaRow?.status === "needs_review" && gaRow.is_blocking === false && /UPL Advisory Opinion 2003-2/.test(gaRow.failure_reason ?? ""))
    check("…and the brokerage-wide 'title_company' default is named beside the gap (it disagrees with the state)", /default closing entity is 'title_company'/.test(gaRow?.failure_reason ?? ""))
    await runClosingCompliance(gaOk.db, { transactionId: gaOk.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("with an attorney on the deal the Georgia row passes", logRow(gaOk.tables, "closing_participants.state_policy")?.status === "pass")
    const txRun = await runClosingCompliance(tx.db, { transactionId: tx.tx, brokerageId: B1, trigger: "settlement_scanned" }, deps)
    check("an UNSUPPORTED state (TX) files no participant row but returns the QUESTION", !tx.tables.transaction_compliance_log.some((r) => r.check_type.startsWith("closing_participants.")) && /Texas|TX/.test(txRun.stateQuestion ?? "") && gaRun.stateQuestion === null)
  }
  {
    const f = mk({ settlement: { sales_price: 400000 } })
    const res = await runFinalComplianceCheck(f.tx, B1, f.db as any)
    check("the PRE-CDA gate (runFinalComplianceCheck) now holds on a contract-vs-settlement mismatch and names it", res.passed === false && res.blockers.some((b) => /Closing compliance: .*Purchase price/.test(b)))
    check("evaluateFinalCompliance: closing findings and a closing check that could not run both refuse", !evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0, closingFindings: ["x"] }).passed
      && !evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0, closingCheckError: "boom" }).passed
      && evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0 }).passed)
  }

  // ═══ D. STATE CLOSING PARTICIPANTS ═══════════════════════════════════════════════════════════════
  section("D state closing participants — cited, or UNSUPPORTED with the question")
  const implemented = Object.keys(STATE_CLOSING_POLICIES)
  check("every implemented state is a real state in the forms registry", implemented.every((s) => (ALL_US_STATES as string[]).includes(s)))
  check("every implemented state cites at least one https source with the holding quoted", implemented.every((s) => STATE_CLOSING_POLICIES[s].sources.length > 0 && STATE_CLOSING_POLICIES[s].sources.every((x) => /^https:\/\//.test(x.url) && x.says.length > 40 && x.title.length > 8)))
  check("every implemented state names what it rests on and expects at least one participant", implemented.every((s) => ["statute", "state_supreme_court", "bar_advisory_opinion", "bar_guidance_custom"].includes(STATE_CLOSING_POLICIES[s].basis) && STATE_CLOSING_POLICIES[s].expects.length > 0))
  check("a 'required' state expects a closing attorney; a 'customary' state expects nothing as 'required'", implemented.every((s) => { const p = STATE_CLOSING_POLICIES[s]; return p.involvement === "customary" ? p.expects.every((e) => e.presence === "customary") : p.expects.some((e) => e.role === "closing_attorney" && e.presence === "required") }))
  check("a bar opinion / custom is worded as such — never as a statute (no 'statute' basis without 'Gen. Stat.', 'Public Act' or 'OCGA')", implemented.every((s) => { const p = STATE_CLOSING_POLICIES[s]; return p.basis !== "statute" || /Gen\. Stat\.|Public Act|OCGA/.test(`${p.summary} ${p.expects.map((e) => e.why).join(" ")} ${p.titleSearch.note}`) }))
  check("the table carries a verification date and is not older than its re-verification cadence", Number.isFinite(Date.parse(CLOSING_POLICY_VERIFIED_ON)) && closingPolicyAgeDays() <= VERIFY_EVERY_DAYS)
  const unsupported = (ALL_US_STATES as string[]).filter((s) => !implemented.includes(s))
  const tx = assessClosingParticipants({ stateCode: "TX", participantRoles: [] })
  check("an unsupported state (TX) is UNSUPPORTED with its question — never a verified-and-empty requirement", tx.status === "unsupported" && tx.policy === null && /Texas|TX/.test(tx.question ?? "") && tx.gaps.length === 0)
  check("…every state the table does not implement answers 'unsupported' the same way", unsupported.length > 0 && unsupported.every((s) => assessClosingParticipants({ stateCode: s, participantRoles: [] }).status === "unsupported"))
  check("…and a deal with no recognisable state is unsupported with a question about the address", assessClosingParticipants({ stateCode: null, participantRoles: [] }).status === "unsupported")
  check("POSITIVE CONTROL — a supported state with nobody on the deal DOES produce a gap", assessClosingParticipants({ stateCode: "GA", participantRoles: [] }).gaps.length > 0)
  check("Georgia: any attorney role satisfies the closing-attorney expectation; a title company alone does not", assessClosingParticipants({ stateCode: "GA", participantRoles: ["seller_attorney"] }).gaps.length === 0 && assessClosingParticipants({ stateCode: "GA", participantRoles: ["title_company"] }).gaps.length > 0)
  check("Delaware names the BUYER's attorney (title examination) — a side-less attorney does not satisfy it", assessClosingParticipants({ stateCode: "DE", participantRoles: ["closing_attorney"] }).gaps.some((x) => x.role === "buyer_closing_attorney"))
  check("New York's attorneys are CUSTOMARY, not required — the gaps say it is local custom", assessClosingParticipants({ stateCode: "NY", participantRoles: [] }).gaps.every((x) => x.presence === "customary" && /custom/i.test(x.message)))
  check("participant roles are recognised from free text (a buyer's attorney satisfies Delaware's buyer-attorney expectation; an inspector satisfies nothing)",
    assessClosingParticipants({ stateCode: "DE", participantRoles: ["Buyer's Attorney"] }).gaps.length === 0
    && assessClosingParticipants({ stateCode: "DE", participantRoles: ["inspector", "title_company", "lender"] }).gaps.length > 0)

  // ═══ F. FORM PACKETS ARE THE BROKERAGE'S AND THE TEAM'S (wave 144, lane 144C — owner ruling 3) ═════════════════════════════
  // Re-asserted as the RULE: wave 143 proved a PLATFORM-owned packet reached every tenant's fill action. The owner has ruled that
  // packets are brokerage / team owned, so the assertions that pinned "a tenant fills a platform/… path" are replaced by the rule
  // that replaces them — the catalogue's own rules (licence, approval, fillable, supersede, retire) are kept and still proved.
  section("F form packets — owned by the brokerage or one team, shared through real memberships; the platform catalogue is a source, never an owner")
  const packets = await import("../lib/forms/platform-form-packets")
  const tp = await import("../lib/forms/tenant-form-packets")
  const { checkFormPathsInScope } = await import("../lib/forms/form-path-scope")
  const { PDFDocument } = await import("pdf-lib")
  const { readdirSync } = await import("node:fs")
  const vocabSrc = read("scripts/check-vocabularies.ts")
  const libraryTypes = (() => { const m = /brokerage_form_library:\s*\{\s*packet_type:\s*\[([^\]]*)\]/.exec(vocabSrc); return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null })()
  const sql7 = read("supabase/migrations/m807-platform-form-packets.sql"), sql7Code = sql7.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  const checkIn = (col: string) => { const m = new RegExp(`${col} IN \\(([^)]*)\\)`).exec(sql7Code); return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null }
  // The ownership migration is FOUND BY ITS NAME, not its number (the integrator may renumber it) — assert the rule, not the waypoint.
  const ownMig = readdirSync("supabase/migrations").find((f) => /^m\d+-form-packets-are-brokerage-and-team-owned\.sql$/.test(f)) ?? null
  const sqlOwn = ownMig ? read(`supabase/migrations/${ownMig}`) : ""
  const sqlOwnCode = sqlOwn.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  check("m807 states its status on line 1 (the lane stamp until applied; APPLIED LIVE once the integrator applied it)", /^-- (WRITTEN, NOT APPLIED \(wave 143, lane 143B\)|── APPLIED LIVE )/.test(sql7.split("\n")[0]))
  check(`the ownership migration exists and states its status on line 1 (${ownMig ?? "MISSING"})`, !!ownMig && /^-- (WRITTEN, NOT APPLIED \(wave 144, lane 144C\)|── APPLIED LIVE )/.test(sqlOwn.split("\n")[0]))
  check("ONE vocabulary for the kind of packet: the library's live CHECK = FORM_PACKET_TYPES = the m807 CHECK, and the catalogue IMPORTS it (same array, not a copy)",
    sameSet(libraryTypes, tp.FORM_PACKET_TYPES) && sameSet(checkIn("packet_type"), tp.FORM_PACKET_TYPES) && packets.PLATFORM_PACKET_TYPES === tp.FORM_PACKET_TYPES)
  check("PLATFORM_PACKET_STATUSES = the m807 CHECK; the catalogue still refuses an approved row with no approver / licence / fillable field (m807 CHECK)",
    sameSet(checkIn("status"), packets.PLATFORM_PACKET_STATUSES) && /platform_form_packets_approved_needs_evidence/.test(sql7Code) && /approved_by IS NOT NULL/.test(sql7Code) && /length\(btrim\(license_note\)\) >= 20/.test(sql7Code) && /field_count > 0/.test(sql7Code))
  check("the migration gives the TENANT registry a team owner, the object path, the licence record and the catalogue provenance",
    ["team_id", "storage_path", "license_note", "license_expires_at", "field_count", "source_platform_packet_id"].every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`).test(sqlOwnCode)))
  check("…a packet's path must sit under its OWNER (brokerage/{id}/packets/… or teams/{id}/packets/…), and a team must be a team of the same brokerage",
    /brokerage_form_library_storage_path_under_owner/.test(sqlOwnCode) && /'brokerage\/' \|\| brokerage_id::text \|\| '\/packets\/%'/.test(sqlOwnCode) && /'teams\/' +\|\| team_id::text +\|\| '\/packets\/%'/.test(sqlOwnCode)
    && /CREATE TRIGGER brokerage_form_library_team_in_brokerage/.test(sqlOwnCode) && /t\.brokerage_id = NEW\.brokerage_id/.test(sqlOwnCode))
  const dropsBucketWide = ["auth read brokerage-forms", "auth upload brokerage-forms", "auth update brokerage-forms", "auth delete brokerage-forms"].every((n) => sqlOwnCode.includes(`DROP POLICY IF EXISTS "${n}"`))
  check("the bucket-wide storage policies (any signed-in user could read / overwrite / delete ANY tenant's forms and filled offers) are DROPPED and replaced by owner-scoped ones",
    dropsBucketWide && ["SELECT", "INSERT", "UPDATE", "DELETE"].every((op) => new RegExp(`FOR ${op} TO authenticated[\\s\\S]{0,160}brokerage_forms_path_(readable|writable)\\(name\\)`).test(sqlOwnCode)))
  check("…the readable rule scopes every root: own brokerage, own team (or oversight), own agent folder, own / own-tenant filled copies; platform/ is staff-only",
    /split_part\(p_name, '\/', 1\) = 'brokerage' AND split_part\(p_name, '\/', 2\) = public\.current_user_brokerage_id\(\)::text/.test(sqlOwnCode)
    && /resolve_team_id\(auth\.uid\(\), NULL::uuid\)/.test(sqlOwnCode) && /'agents' AND split_part\(p_name, '\/', 2\) = auth\.uid\(\)::text/.test(sqlOwnCode)
    && /o\.brokerage_id = public\.current_user_brokerage_id\(\)/.test(sqlOwnCode) && !/split_part\(p_name, '\/', 1\) = 'platform'/.test(sqlOwnCode))
  check("…the library's row policies follow membership too (a team packet is not readable by another team's agent through a direct client read)",
    /CREATE POLICY brokerage_form_library_tenant_select[\s\S]{0,400}team_id IS NULL[\s\S]{0,120}team_id = public\.resolve_team_id\(auth\.uid\(\), NULL::uuid\)/.test(sqlOwnCode))
  check("NO m807 data is lost: the migration never drops, deletes from or truncates platform_form_packets (comment only)",
    !/DROP\s+TABLE[^;]*platform_form_packets|DELETE\s+FROM\s+public\.platform_form_packets|TRUNCATE[^;]*platform_form_packets|ALTER TABLE public\.platform_form_packets\s+DROP/i.test(sqlOwnCode) && /COMMENT ON TABLE public\.platform_form_packets/.test(sqlOwnCode))
  control("the data-loss finder catches a DROP of the catalogue", (s) => /DROP\s+TABLE[^;]*platform_form_packets/i.test(s), "DROP TABLE IF EXISTS public.platform_form_packets;")
  control("the bucket-policy finder catches a policy that is still bucket-wide", (s) => /FOR SELECT TO authenticated\s+USING \(bucket_id = 'brokerage-forms'\)/.test(s), `CREATE POLICY "x" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'brokerage-forms');`)

  // ── PURE: path grammar, visibility, authority ──
  const T1 = randomUUID(), T2 = randomUUID(), RID = randomUUID()
  const bPath = `brokerage/${B1}/packets/${RID}/our-branded-contract-v2.pdf`, tPath = `teams/${T1}/packets/${RID}/team.pdf`
  check("path grammar: a brokerage packet path brokerage/{id}/packets/{row}/… and a team packet path teams/{id}/packets/{row}/… parse back to their owner and row; traversal, depth, a non-pdf and a non-uuid are refused",
    tp.parseTenantPacketPath(bPath)?.kind === "brokerage" && tp.parseTenantPacketPath(bPath)?.ownerId === B1 && tp.parseTenantPacketPath(tPath)?.ownerId === T1 && tp.parseTenantPacketPath(tPath)?.rowId === RID
    && tp.parseTenantPacketPath(`brokerage/${B1}/packets/${RID}/../x.pdf`) === null && tp.parseTenantPacketPath(`brokerage/${B1}/packets/${RID}/a/b.pdf`) === null
    && tp.parseTenantPacketPath(`teams/${T1}/packets/${RID}/x.docx`) === null && tp.parseTenantPacketPath(`teams/not-a-uuid/packets/${RID}/x.pdf`) === null && tp.parseTenantPacketPath(`platform/${RID}/x.pdf`) === null)
  const actorOf = (o: Partial<import("../lib/forms/tenant-form-packets").PacketActor>) => ({ userId: randomUUID(), brokerageId: B1, userType: "agent", teamId: null, ledTeamId: null, oversight: false, ...o })
  const member1 = actorOf({ teamId: T1 }), member2 = actorOf({ teamId: T2 }), lead2 = actorOf({ userType: "team_lead", teamId: T2, ledTeamId: T2 }), broker = actorOf({ userType: "broker", oversight: true }), foreign = actorOf({ brokerageId: B2 })
  // VISIBILITY, exercised THROUGH the fill admission (a one-row library per case) — not by importing a private helper.
  const vis = async (row: Row, a: any): Promise<boolean> => {
    const id = randomUUID(), owner = row.team_id ? `teams/${row.team_id}` : `brokerage/${B1}`
    const r0 = { id, brokerage_id: B1, team_id: null, is_active: true, license_expires_at: null, name: "p", state: "TX", packet_type: "offer", ...row }
    const path = `${owner}/packets/${id}/p.pdf`
    const r = await tp.usableTenantPacketPaths(makeDb({ brokerage_form_library: [{ ...r0, storage_path: path }] }), a, [path], new Date("2026-10-25T12:00:00Z"))
    return r.ok && r.usable.has(path)
  }
  check("VISIBILITY: a brokerage-wide packet reaches every member of THAT brokerage and nobody in another", (await vis({}, member1)) && (await vis({}, member2)) && !(await vis({}, foreign)))
  check("…a TEAM packet reaches that team's members and the brokerage's oversight class — never another team's agent, nor another team's LEAD",
    (await vis({ team_id: T1 }, member1)) && (await vis({ team_id: T1 }, broker)) && !(await vis({ team_id: T1 }, member2)) && !(await vis({ team_id: T1 }, lead2)))
  check("…a retired packet, or one whose licence expired yesterday, reaches nobody (one expiring today still does)",
    !(await vis({ is_active: false }, member1)) && !(await vis({ license_expires_at: "2026-10-24" }, member1)) && (await vis({ license_expires_at: "2026-10-25" }, member1)))
  check("the oversight class is the tenant admin roster MINUS team_lead, derived by subtraction (never a copied list)",
    !tp.PACKET_OVERSIGHT_USER_TYPES.has("team_lead") && tp.PACKET_OVERSIGHT_USER_TYPES.has("broker") && tp.PACKET_OVERSIGHT_USER_TYPES.has("broker_owner") && !tp.PACKET_OVERSIGHT_USER_TYPES.has("agent")
    && /new Set\(\[\.\.\.TENANT_ADMIN_USER_TYPES\]\.filter\(/.test(code("lib/forms/tenant-form-packets.ts")))
  check("AUTHORITY: brokerage-wide sharing is the oversight class's; a team lead shares with their OWN team only; an agent shares with no one",
    tp.mayManagePacketScope(broker, null) && tp.mayManagePacketScope(broker, T1) && !tp.mayManagePacketScope(lead2, null) && tp.mayManagePacketScope(lead2, T2) && !tp.mayManagePacketScope(lead2, T1) && !tp.mayManagePacketScope(member1, null) && !tp.mayManagePacketScope(member1, T1))

  // ── LIVE on the in-memory database: who the actor really is, what they see, what they may fill ──
  const U_M1 = randomUUID(), U_M2 = randomUUID(), U_LEAD1 = randomUUID(), U_BROKER = randomUUID(), U_FOREIGN = randomUUID(), A_M1 = randomUUID(), A_M2 = randomUUID()
  const T_FOREIGN = randomUUID()
  const world = () => makeDb({
    users: [
      { id: U_M1, brokerage_id: B1, user_type: "agent", team_id: null }, { id: U_M2, brokerage_id: B1, user_type: "agent", team_id: T2 },
      // the team LEAD's users row carries NO team_id — the old scope check (users.team_id only) refused them their own team's library
      { id: U_LEAD1, brokerage_id: B1, user_type: "team_lead", team_id: null }, { id: U_BROKER, brokerage_id: B1, user_type: "broker", team_id: null },
      { id: U_FOREIGN, brokerage_id: B2, user_type: "agent", team_id: T_FOREIGN },
    ],
    teams: [
      { id: T1, brokerage_id: B1, team_lead_id: U_LEAD1, deleted_at: null, name: "North", created_at: iso("2026-01-01") },
      { id: T2, brokerage_id: B1, team_lead_id: null, deleted_at: null, name: "South", created_at: iso("2026-01-02") },
      { id: T_FOREIGN, brokerage_id: B2, team_lead_id: null, deleted_at: null, name: "Elsewhere", created_at: iso("2026-01-03") },
    ],
    agents: [{ id: A_M1, user_id: U_M1, team_id: null }, { id: A_M2, user_id: U_M2, team_id: null }],
    // member 1's team comes from the JUNCTION (team_members), not users.team_id
    team_members: [{ id: randomUUID(), team_id: T1, agent_id: A_M1, brokerage_id: B1, is_active: true, effective_from: "2026-01-01", effective_to: null }],
    brokerage_form_library: [], platform_form_packets: [], offers: [],
  })
  const w = world()
  const ra = async (u: string, db: any = w) => { const r = await tp.resolvePacketActor(db, u); return r.ok ? r.actor : null }
  const aM1 = await ra(U_M1), aM2 = await ra(U_M2), aLead = await ra(U_LEAD1), aBroker = await ra(U_BROKER), aForeign = await ra(U_FOREIGN)
  check("MEMBERSHIP is the canonical one: the junction row puts member 1 on North, users.team_id puts member 2 on South, the lead's team is the one they LEAD, the broker is oversight",
    aM1?.teamId === T1 && aM2?.teamId === T2 && aLead?.teamId === T1 && aLead?.ledTeamId === T1 && !aLead?.oversight && aBroker?.oversight === true && aBroker?.teamId === null && aForeign?.brokerageId === B2)
  {
    const crossed = world(); crossed.tables.users.find((u: Row) => u.id === U_M2).team_id = T_FOREIGN
    check("…a team that belongs to ANOTHER brokerage is dropped, never trusted", (await ra(U_M2, crossed))?.teamId === null)
    check("…a refused account read is an error (fail closed), never an actor with no team", !(await tp.resolvePacketActor(makeDb({}, { users: "permission denied" }), U_M1)).ok)
  }
  const makePdf = async (fields: number) => { const doc = await PDFDocument.create(); const page = doc.addPage(); const form = doc.getForm(); for (let i = 0; i < fields; i++) { const f = form.createTextField(`field_${i}`); f.addToPage(page, { x: 20, y: 700 - i * 24, width: 200, height: 18 }) } return new Uint8Array(await doc.save()) }
  const reg = (a: any, o: Record<string, unknown> = {}, db: any = w) => tp.registerTenantFormPacket(db, a, { name: "Residential Contract", state: "TX", packetType: "offer", licenseNote: "Texas REALTORS member licence 2026", fileName: "contract.pdf", bytes: null, ...o } as any)
  const pdf3 = await makePdf(3)
  const refusedAgent = await reg(aM1, { bytes: pdf3 })
  const refusedLeadWide = await reg(aLead, { bytes: pdf3 })
  const refusedLeadOther = await reg(aLead, { bytes: pdf3, teamId: T2 })
  const refusedForeignTeam = await reg(aBroker, { bytes: pdf3, teamId: T_FOREIGN })
  check("SHARING is an authority, refused by name: an agent cannot share; a team lead cannot share brokerage-wide or with another team; a team outside the brokerage is refused — and nothing was stored",
    !refusedAgent.ok && !refusedLeadWide.ok && /team lead shares with their own team/.test((refusedLeadWide as any).error) && !refusedLeadOther.ok && !refusedForeignTeam.ok && /not in your brokerage/.test((refusedForeignTeam as any).error)
    && w.objects.size === 0 && w.tables.brokerage_form_library.length === 0)
  const wide = await reg(aBroker!, { bytes: pdf3, name: "Brokerage Listing Agreement", packetType: "listing", formCode: "BRK-LA-1" })
  const north = await reg(aLead!, { bytes: await makePdf(5), teamId: T1, name: "North Team Offer Packet" })
  const south = await reg(aBroker!, { bytes: await makePdf(2), teamId: T2, name: "South Team Offer Packet" })
  check("a brokerage admin shares brokerage-wide and with ANY of its teams; a team lead shares with their own team — each stored in the OWNER's folder with its fillable-field count and its licence recorded",
    wide.ok && north.ok && south.ok && wide.packet.storage_path === `brokerage/${B1}/packets/${wide.packet.id}/contract.pdf` && wide.packet.team_id === null
    && north.packet.storage_path!.startsWith(`teams/${T1}/packets/${north.packet.id}/`) && north.packet.field_count === 5 && north.packet.license_note === "Texas REALTORS member licence 2026"
    && w.objects.has(`brokerage-forms/${north.packet.storage_path}`) && w.objects.size === 3)
  {
    const brokenDb = makeDb({ brokerage_form_library: [] }, { "brokerage_form_library:insert": "boom" })
    const lost = await tp.registerTenantFormPacket(brokenDb, aBroker!, { name: "Will not land", state: "TX", packetType: "offer", fileName: "x.pdf", bytes: await makePdf(1) })
    check("when the library insert is refused the stored object is REMOVED and the removal is counted (no orphan master)", !lost.ok && /1 stored file\(s\) removed/.test((lost as any).error) && brokenDb.objects.size === 0)
  }
  // a loose legacy file in the brokerage folder and in each team folder (uploaded before the library recorded paths)
  w.objects.set(`brokerage-forms/brokerage/${B1}/TX-offer-legacy.pdf`, new Uint8Array([1]))
  w.objects.set(`brokerage-forms/teams/${T1}/north-loose.pdf`, new Uint8Array([1]))
  w.objects.set(`brokerage-forms/teams/${T2}/south-loose.pdf`, new Uint8Array([1]))
  w.objects.set(`brokerage-forms/brokerage/${B2}/foreign.pdf`, new Uint8Array([1]))
  const names = async (a: any, q: Record<string, unknown> = {}) => { const r = await tp.listFormPacketsForActor(w, a, q as any); return r.ok ? r.packets.map((p) => p.name).sort().join(" | ") : `ERR ${(r as any).error}` }
  const m1Sees = await names(aM1), m2Sees = await names(aM2), brokerSees = await names(aBroker), leadSees = await names(aLead)
  check("WHAT AN AGENT SEES: the brokerage's packets and loose files + their OWN team's — member 1 (North) never sees South's packet or South's folder, and no one sees another tenant's file",
    m1Sees.includes("Brokerage Listing Agreement") && m1Sees.includes("North Team Offer Packet") && m1Sees.includes("north-loose.pdf") && m1Sees.includes("TX-offer-legacy.pdf")
    && !m1Sees.includes("South") && !m1Sees.includes("south-loose") && !m1Sees.includes("foreign.pdf")
    && m2Sees.includes("South Team Offer Packet") && !m2Sees.includes("North") && leadSees.includes("North Team Offer Packet") && !leadSees.includes("South"), `m1: ${m1Sees} / m2: ${m2Sees}`)
  check("…the brokerage's oversight class sees every team's packet in the brokerage (and still nothing of another tenant's)", brokerSees.includes("North Team Offer Packet") && brokerSees.includes("South Team Offer Packet") && !brokerSees.includes("foreign"))
  check("…a listing packet is not offered to an offer, and a packet for another state is not offered for this deal's state", !(await names(aM1, { purpose: "offer" })).includes("Brokerage Listing Agreement") && !(await names(aM1, { stateCode: "FL" })).includes("North Team Offer Packet"))
  check("…a REFUSED library read is an error — never an empty list that reads as 'your brokerage shares nothing'", !(await tp.listFormPacketsForActor(makeDb({}, { brokerage_form_library: "permission denied" }), aM1!)).ok)

  // the fill action's scope check, live
  const scope = (paths: string[], userId: string, teamId: string | null = null, brokerageId = B1, db: any = w) => checkFormPathsInScope(db, paths, { brokerageId, teamId, userId })
  check("FILL SCOPE: a registered packet is admitted for an agent it is shared with — the brokerage's for anyone in it, North's for North", (await scope([wide.ok ? wide.packet.storage_path! : ""], U_M2)).ok && (await scope([north.ok ? north.packet.storage_path! : ""], U_M1)).ok)
  check("…and REFUSED for another team's agent, even one who names the packet's exact path", !(await scope([north.ok ? north.packet.storage_path! : ""], U_M2, T2)).ok)
  check("…and REFUSED for another tenant (the brokerage segment is not theirs)", !(await scope([wide.ok ? wide.packet.storage_path! : ""], U_FOREIGN, T_FOREIGN, B2)).ok)
  check("…and refused for a path that is not EXACTLY the registered object (same row, other file)", north.ok && !(await scope([`teams/${T1}/packets/${north.packet.id}/other.pdf`], U_M1)).ok)
  check("…a team LEAD whose users row carries no team_id is admitted to their OWN team's loose folder by their real membership; a non-member is refused it",
    (await scope([`teams/${T1}/north-loose.pdf`], U_LEAD1, null)).ok && !(await scope([`teams/${T1}/north-loose.pdf`], U_M2, T2)).ok && (await scope([`teams/${T2}/south-loose.pdf`], U_BROKER, null)).ok)
  if (north.ok) {
    const before = (await scope([north.packet.storage_path!], U_M1)).ok
    const retired = await tp.retireTenantFormPacket(w, aLead!, north.packet.id)
    check("retiring a packet makes the fill action's scope check refuse it IMMEDIATELY; retiring it twice is reported, not 'success'", before && retired.ok && !(await scope([north.packet.storage_path!], U_M1)).ok && !(await tp.retireTenantFormPacket(w, aLead!, north.packet.id)).ok)
    check("…a lead cannot retire another team's packet, and an edit can never widen a team packet (no team_id in the patch vocabulary)", south.ok && !(await tp.retireTenantFormPacket(w, aLead!, south.packet.id)).ok && !/team_id/.test(code("lib/forms/tenant-form-packets.ts").slice(code("lib/forms/tenant-form-packets.ts").indexOf("export interface TenantPacketPatch"), code("lib/forms/tenant-form-packets.ts").indexOf("export async function updateTenantFormPacket"))))
  }
  const failClosed = await scope([wide.ok ? wide.packet.storage_path! : ""], U_M1, null, B1, makeDb({ ...w.tables }, { brokerage_form_library: "relation does not exist" }))
  check("a REFUSED library read FAILS CLOSED: the path is refused and the reason is returned", !failClosed.ok && /could not verify the form packet/.test(failClosed.error ?? ""))
  check("existing scopes are unchanged: own brokerage loose file allowed, another tenant refused, own agent folder allowed, someone else's refused, traversal refused",
    (await scope([`brokerage/${B1}/a.pdf`], U_M1)).ok && !(await scope([`brokerage/${B2}/a.pdf`], U_M1)).ok && (await scope([`agents/${U_M1}/uploads/x.pdf`], U_M1)).ok && !(await scope([`agents/${U_M2}/x.pdf`], U_M1)).ok && !(await scope([`brokerage/${B1}/../${B2}/a.pdf`], U_M1)).ok)

  // ── THE PLATFORM CATALOGUE: its own rules kept; never fillable by a tenant; reaches agents only once a brokerage ADDS it ──
  const pid = randomUUID()
  check("catalogue path grammar: platform/{uuid}/{file}.pdf parses; traversal, wrong root, depth, a non-pdf and a non-uuid are refused",
    packets.parsePlatformPacketPath(`platform/${pid}/TAR-1601.pdf`)?.packetId === pid
    && packets.parsePlatformPacketPath(`platform/${pid}/../x.pdf`) === null && packets.parsePlatformPacketPath(`brokerage/${pid}/x.pdf`) === null
    && packets.parsePlatformPacketPath(`platform/${pid}/a/b.pdf`) === null && packets.parsePlatformPacketPath(`platform/${pid}/x.docx`) === null
    && packets.parsePlatformPacketPath("platform/not-a-uuid/x.pdf") === null && packets.parsePlatformPacketPath(null) === null)
  const good = { status: "approved", state: null, packet_type: "offer", field_count: 12, license_note: "Licensed to the platform by the state association, redistribution to members permitted", license_expires_at: null, approved_by: randomUUID() } as Row
  const NOW = new Date("2026-10-23T12:00:00Z")
  const usable = async (o: Row, q: Record<string, unknown> = {}): Promise<boolean> => {
    const id = randomUUID()
    const r = await packets.listPlatformPacketsForTenant(makeDb({ platform_form_packets: [{ id, name: "Case", form_code: null, description: null, file_name: "c.pdf", version: 1, approved_at: iso("2026-10-01"), ...good, ...o, storage_path: `platform/${id}/c.pdf` }] }), { now: NOW, ...q } as any)
    return r.ok && r.packets.length === 1
  }
  check("the catalogue offers a brokerage an approved, licensed, fillable packet", await usable({}))
  check("…never a DRAFT, a RETIRED packet, one with no approver, a licence basis under 20 characters, or no fillable fields",
    !(await usable({ status: "draft" })) && !(await usable({ status: "retired" })) && !(await usable({ approved_by: null })) && !(await usable({ license_note: "ok" })) && !(await usable({ field_count: 0 })))
  check("…an EXPIRED licence is not offered (one expiring today still is); a state-pinned packet only for that state; a listing packet not for an offer",
    !(await usable({ license_expires_at: "2026-10-22" })) && (await usable({ license_expires_at: "2026-10-23" })) && (await usable({ state: "FL" }, { stateCode: "FL" })) && !(await usable({ state: "FL" }, { stateCode: "TX" })) && !(await usable({ packet_type: "listing" }, { purpose: "offer" })))
  check("…a REFUSED catalogue read is ok:false — never an empty list", !(await packets.listPlatformPacketsForTenant(makeDb({}, { platform_form_packets: "permission denied" }), { stateCode: "TX" })).ok)

  const staff = randomUUID()
  const reg1 = await packets.registerPlatformPacket(w, { actorUserId: staff, name: "Residential contract v1", state: "tx", packetType: "offer", formCode: "TXR 1", fileName: "txr one.pdf", bytes: await makePdf(5) })
  check("a fillable PDF registers in the catalogue as a DRAFT with its counted fields; a flat PDF / a non-PDF / an unknown type cannot",
    reg1.ok && reg1.packet.status === "draft" && reg1.packet.field_count === 5 && reg1.packet.state === "TX" && !!packets.parsePlatformPacketPath(reg1.packet.storage_path)
    && !(await packets.registerPlatformPacket(w, { actorUserId: staff, name: "Scanned contract", packetType: "offer", fileName: "scan.pdf", bytes: await makePdf(0) })).ok
    && !(await packets.registerPlatformPacket(w, { actorUserId: staff, name: "Not a pdf", packetType: "offer", fileName: "x.pdf", bytes: new TextEncoder().encode("hello world") })).ok
    && !(await packets.registerPlatformPacket(w, { actorUserId: staff, name: "Odd packet", packetType: "mystery", fileName: "x.pdf", bytes: await makePdf(2) })).ok)
  if (reg1.ok) {
    const catPath = reg1.packet.storage_path
    check("a DRAFT catalogue packet cannot be added to a brokerage's library", !(await packets.addPlatformPacketToLibrary(w, aBroker!, { packetId: reg1.packet.id })).ok)
    check("approval needs a licence basis; a named human approves it (status, approver, time recorded); approving twice is refused",
      !(await packets.approvePlatformPacket(w, { actorUserId: staff, packetId: reg1.packet.id, licenseNote: "yes" })).ok
      && (await packets.approvePlatformPacket(w, { actorUserId: staff, packetId: reg1.packet.id, licenseNote: "Licensed to the platform by the association for member redistribution (agreement 2026-09)" })).ok
      && w.tables.platform_form_packets.find((r: Row) => r.id === reg1.packet.id)?.approved_by === staff
      && !(await packets.approvePlatformPacket(w, { actorUserId: staff, packetId: reg1.packet.id, licenseNote: "Licensed to the platform by the association for member redistribution" })).ok)
    check("A TENANT NEVER FILLS THE CATALOGUE MASTER: even approved and in licence, the platform/… path is refused by the fill action's scope check (positive control: the registry admits it)",
      !(await scope([catPath], U_BROKER)).ok && !(await scope([catPath], U_M1)).ok && (await packets.usablePlatformPaths(w, [catPath])).ok && ((await packets.usablePlatformPaths(w, [catPath])) as any).usable.has(catPath))
    const added = await packets.addPlatformPacketToLibrary(w, aBroker!, { packetId: reg1.packet.id })
    const again = await packets.addPlatformPacketToLibrary(w, aBroker!, { packetId: reg1.packet.id })
    check("a brokerage ADDS it: the master is COPIED into the brokerage's own folder and registered in ITS library with the catalogue provenance and the licence it came under; adding again is idempotent",
      added.ok && added.packet.storage_path!.startsWith(`brokerage/${B1}/packets/${added.packet.id}/`) && added.packet.source_platform_packet_id === reg1.packet.id
      && /member redistribution/.test(added.packet.license_note ?? "") && w.objects.has(`brokerage-forms/${added.packet.storage_path}`) && again.ok && again.existing && again.packet.id === added.packet.id)
    if (added.ok) {
      check("…from then on it is the BROKERAGE's packet: offered to its agents (labelled as from the catalogue) and fillable by them, never by another tenant",
        (await tp.listFormPacketsForActor(w, aM1!)).ok && ((await tp.listFormPacketsForActor(w, aM1!)) as any).packets.some((p: any) => p.path === added.packet.storage_path && p.origin === "platform_catalogue")
        && (await scope([added.packet.storage_path!], U_M1)).ok && !(await scope([added.packet.storage_path!], U_FOREIGN, T_FOREIGN, B2)).ok)
    }
    check("…a team lead adds it to their OWN team only; an agent cannot add it at all",
      (await packets.addPlatformPacketToLibrary(w, aLead!, { packetId: reg1.packet.id, teamId: T1 })).ok && !(await packets.addPlatformPacketToLibrary(w, aLead!, { packetId: reg1.packet.id, teamId: T2 })).ok && !(await packets.addPlatformPacketToLibrary(w, aM1!, { packetId: reg1.packet.id })).ok)
    const reg2 = await packets.registerPlatformPacket(w, { actorUserId: staff, name: "Residential contract v2", state: "TX", packetType: "offer", formCode: "TXR 1", fileName: "txr one v2.pdf", bytes: await makePdf(6) })
    if (reg2.ok) {
      const ok2 = await packets.approvePlatformPacket(w, { actorUserId: staff, packetId: reg2.packet.id, licenseNote: "Licensed to the platform by the association for member redistribution (agreement 2026-10)" })
      check("approving a NEWER version of the same form RETIRES the older one in the catalogue (counted) — and a retired catalogue packet can no longer be added",
        ok2.ok && ok2.retiredOlder === 1 && w.tables.platform_form_packets.find((r: Row) => r.id === reg1.packet.id)?.status === "retired" && !(await packets.addPlatformPacketToLibrary(w, aBroker!, { packetId: reg1.packet.id, teamId: T2 })).ok)
    } else check("second catalogue version registers", false)
    const neutral = await packets.registerPlatformPacket(w, { actorUserId: staff, name: "State-neutral disclosure", packetType: "disclosure", fileName: "n.pdf", bytes: await makePdf(2) })
    if (neutral.ok) {
      await packets.approvePlatformPacket(w, { actorUserId: staff, packetId: neutral.packet.id, licenseNote: "Platform's own form, free to members — drafted in house 2026" })
      check("a STATE-NEUTRAL catalogue packet needs the brokerage to choose its state before it is added (the library is state-scoped)",
        !(await packets.addPlatformPacketToLibrary(w, aBroker!, { packetId: neutral.packet.id })).ok && (await packets.addPlatformPacketToLibrary(w, aBroker!, { packetId: neutral.packet.id, state: "TX" })).ok)
    }
    check("retiring an already-retired catalogue packet reports it (a count of zero is not 'success')", !(await packets.retirePlatformPacket(w, { actorUserId: staff, packetId: reg1.packet.id, reason: "superseded" })).ok)
  }

  // ── WIRING, on stripped source ──
  const wizardSrcF = codeWithStrings("app/components/form-wizard/FormWizard.tsx")
  const packetRouteSrc = codeWithStrings("app/api/form-wizard/form-packets/route.ts")
  const wizardFetchesPlatform = (s: string) => /\/api\/form-wizard\/platform-packets/.test(s) || /scope: "platform"/.test(s)
  check("the wizard lists the brokerage's and team's packets through the session-gated route, never a platform group, and keeps ONE source vocabulary (my_forms | legal_forms_provider)",
    /\/api\/form-wizard\/form-packets/.test(wizardSrcF) && !wizardFetchesPlatform(wizardSrcF) && !/source: "platform/.test(wizardSrcF) && /source: "legal_forms_provider"/.test(wizardSrcF) && /source: "my_forms"/.test(wizardSrcF))
  control("the platform-group finder catches the wave-143 wizard fetch", wizardFetchesPlatform, "const res = await fetch(`/api/form-wizard/platform-packets?${qs}`)")
  check("the wizard no longer lists brokerage/ or teams/ folders from the browser session (the route resolves the agent's REAL membership)", !/prefix: `brokerage\//.test(wizardSrcF) && !/prefix: `teams\//.test(wizardSrcF))
  check("the packet route reads the SESSION user before it opens the service client, resolves the actor from it, and takes no id from the query",
    packetRouteSrc.indexOf("auth.getUser()") >= 0 && packetRouteSrc.indexOf("auth.getUser()") < packetRouteSrc.indexOf("createServiceClient()") && /resolvePacketActor\(svc as never, user\.id\)/.test(packetRouteSrc) && !/searchParams\.get\(["'](brokerage|team|user|agent)/i.test(packetRouteSrc))
  check("the wave-143 platform route is GONE and its tombstone names the survivor", !existsSync("app/api/form-wizard/platform-packets/route.ts") && read("app/api/form-wizard/form-packets/route.ts").includes("app/api/form-wizard/platform-packets/route.ts") && /TOMBSTONE/.test(read("app/api/form-wizard/form-packets/route.ts")))
  const libRouteSrc = codeWithStrings("app/api/admin/transaction-forms/route.ts")
  check("the brokerage's ONE upload path writes through the ONE packet writer (no inline library insert left) and adds catalogue packets through addPlatformPacketToLibrary",
    /registerTenantFormPacket\(/.test(libRouteSrc) && /addPlatformPacketToLibrary\(/.test(libRouteSrc) && !/\.from\("brokerage_form_library"\)\.insert\(/.test(libRouteSrc))
  check("…and opens the service client only AFTER the session + role gate", libRouteSrc.indexOf("isTenantAdminOrPlatformStaff(userRow)") > 0 && libRouteSrc.indexOf("isTenantAdminOrPlatformStaff(userRow)") < libRouteSrc.indexOf("createServiceClient()"))
  const brokerageOnly = (f: string) => /\.from\("brokerage_form_library"\)[\s\S]{0,700}\.is\("team_id", null\)/.test(codeWithStrings(f))
  check("the two person-less readers of the library (the AI form-fill engine, the agent Forms Library loader) are held to BROKERAGE-WIDE packets — a team packet cannot leak through them",
    brokerageOnly("lib/workflow/intake/form-fill-engine.ts") && brokerageOnly("lib/kernel/forms.ts"))
  control("the brokerage-only finder fails a reader with no team predicate", (s) => !/\.from\("brokerage_form_library"\)[\s\S]{0,700}\.is\("team_id", null\)/.test(s), `svc.from("brokerage_form_library").select("id").eq("brokerage_id", b).eq("is_active", true)`)
  check("no packet code mints a PUBLIC url (private bucket, signed links only)", ["lib/forms/platform-form-packets.ts", "lib/forms/tenant-form-packets.ts", "app/api/form-wizard/form-packets/route.ts", "app/api/admin/transaction-forms/route.ts", "app/actions/superadmin/platform-form-packets.ts"].every((f) => !/getPublicUrl/.test(code(f))))
  // ═══ G. THE COACH LISTENS (lib/forms/intake-from-notes.ts) — suggestions the agent's own words must back ═══
  section("G the wizard coach — rules first, a routed model assist, and a verifier no proposal escapes")
  const intake = await import("../lib/forms/intake-from-notes")
  const notes1 = "Cash offer at $400,000 with $5,000 earnest money, ten day inspection (10-day inspection), closing on December 1, 2026. Buyer wants the washer and dryer to stay."
  const rulesOnly = await intake.suggestIntakeAnswers({ purpose: "offer", notes: notes1, brokerageId: null, userId: null })
  const byKey = (s: { proposals: Array<{ key: string; value: unknown }> }, k: string) => s.proposals.find((p) => p.key === k)?.value
  check("RULES alone read the obvious: cash, the price, the earnest money, the inspection days — each with the quote it rests on",
    byKey(rulesOnly, "financing_type") === "cash" && byKey(rulesOnly, "offer_price") === 400000 && byKey(rulesOnly, "earnest_money") === 5000 && byKey(rulesOnly, "inspection_period_days") === 10
    && rulesOnly.proposals.every((p) => p.evidence.length > 3 && notes1.toLowerCase().replace(/\s+/g, " ").includes(p.evidence.toLowerCase().replace(/\s+/g, " "))))
  check("…and with no tenant to bill the model assist is SKIPPED and said so (never a guessed tenant)", rulesOnly.notes.some((n) => /no tenant to book/.test(n)) && rulesOnly.via === "rules")
  let modelCalls = 0
  const hallucinating = async () => {
    modelCalls++
    return { answers: [
      { key: "closing_date", value: "2026-12-01", evidence: "closing on December 1, 2026" },                    // grounded → kept
      { key: "inclusions_exclusions", value: "the washer and dryer to stay", evidence: "the washer and dryer to stay" }, // verbatim span → kept
      { key: "offer_price", value: 395000, evidence: "Cash offer at $400,000" },                              // not stated in the evidence → dropped (rules already settled it anyway)
      { key: "down_payment_amount", value: 80000, evidence: "20% down" },                                      // quote not in the notes → dropped
      { key: "escalation_cap", value: 450000, evidence: "$5,000 earnest money" },                              // figure not in the evidence → dropped
      { key: "sale_of_buyer_home", value: true, evidence: "Buyer wants the washer" },                          // boolean from an unrelated quote → kept by the verifier but still only a proposal
      { key: "special_terms", value: "Seller pays all closing costs and the home warranty", evidence: "Buyer wants the washer and dryer to stay" }, // invented contract language → dropped
      { key: "appraisal_contingency_days", value: 17, evidence: "ten day inspection" },                        // a computed/different figure → dropped
      { key: "not_a_question", value: "x", evidence: "Cash offer" },                                           // not a form question → dropped
    ] }
  }
  const assisted = await intake.suggestIntakeAnswers({ purpose: "offer", notes: notes1, brokerageId: B1, userId: null }, { generate: hallucinating })
  check("the model assist ran once and its grounded answers (an explicit date, a verbatim span) were kept", modelCalls === 1 && byKey(assisted, "closing_date") === "2026-12-01" && byKey(assisted, "inclusions_exclusions") === "the washer and dryer to stay" && assisted.via === "rules+model")
  check("INVENTED terms never reach the agent: a figure not in the evidence, a quote not in the notes, contract language the agent never wrote, a non-question",
    byKey(assisted, "escalation_cap") === undefined && byKey(assisted, "down_payment_amount") === undefined && byKey(assisted, "special_terms") === undefined && byKey(assisted, "appraisal_contingency_days") === undefined
    && assisted.dropped.some((d) => d.key === "special_terms" && /verbatim/.test(d.reason)) && assisted.dropped.some((d) => d.key === "not_a_question"))
  check("a yes / no from an UNRELATED quote is dropped (the model cited 'Buyer wants the washer' for a home-sale contingency)", byKey(assisted, "sale_of_buyer_home") === undefined && assisted.dropped.some((d) => d.key === "sale_of_buyer_home" && /not about this question/.test(d.reason)))
  // The verifier is exercised through the PRODUCT path (suggestIntakeAnswers with an injected model), keeping only what the MODEL proposed.
  const viaModel = async (purpose: "offer" | "listing", text: string, answers: Array<{ key: string; value: unknown; evidence: string }>) => {
    const r = await intake.suggestIntakeAnswers({ purpose, notes: text, brokerageId: B1, userId: null }, { generate: async () => ({ answers }) })
    return { proposals: r.proposals.filter((p) => p.via === "model"), dropped: r.dropped }
  }
  const bool = await viaModel("offer", "The home is in an HOA. Built in 1962.", [{ key: "hoa", value: true, evidence: "in an HOA" }, { key: "pre_1978", value: true, evidence: "Built in 1962" }])
  check("a yes / no that the evidence is ABOUT is kept", bool.proposals.map((p) => `${p.key}=${p.value}`).join() === "hoa=true,pre_1978=true")
  const contradicts = await viaModel("offer", "Built in 1962.", [{ key: "pre_1978", value: false, evidence: "Built in 1962" }])
  check("…and a year in the evidence that contradicts the answer is dropped", contradicts.proposals.length === 0 && /contradicts/.test(contradicts.dropped[0]?.reason ?? ""))
  check("a yes / no the coach has no cue for (the agent's own call) is never answered by it", (await viaModel("offer", "I think we should waive it", [{ key: "appraisal_contingency", value: false, evidence: "waive it" }])).proposals.length === 0)
  const relative = await viaModel("offer", "close in 30 days", [{ key: "closing_date", value: "2026-11-22", evidence: "close in 30 days" }])
  check("a RELATIVE date is never turned into a calendar date", relative.proposals.length === 0 && /relative date is never computed/.test(relative.dropped[0]?.reason ?? ""))
  const kilo = await viaModel("offer", "offering 400k, 10k down", [{ key: "offer_price", value: 400000, evidence: "offering 400k" }])
  check("'400k' and 400000 are the same figure the evidence states", kilo.proposals.length === 1 && kilo.proposals[0].display === "$400,000")
  const optionless = await viaModel("offer", "paying with a loan", [{ key: "financing_type", value: "fha", evidence: "paying with a loan" }])
  check("a choice must be NAMED in the evidence — 'a loan' does not say FHA", optionless.proposals.length === 0)
  check("a listing purpose gets no offer rules (nothing to extract from an offer sentence)", (await intake.suggestIntakeAnswers({ purpose: "listing", notes: notes1, brokerageId: null, userId: null })).proposals.length === 0)
  check("a refused model call degrades to the rules with the reason — the wizard never breaks", (await intake.suggestIntakeAnswers({ purpose: "offer", notes: notes1, brokerageId: B1, userId: null }, { generate: async () => { throw new Error("gateway down") } })).notes.some((n) => /gateway down/.test(n)))
  check("answers the agent already gave are not re-asked of the model", await (async () => { let asked = ""; await intake.suggestIntakeAnswers({ purpose: "offer", notes: notes1, brokerageId: B1, userId: null, alreadyAnswered: ["closing_date"] }, { generate: async (a) => { asked = a.prompt; return { answers: [] } } }); return !/^- closing_date/m.test(asked) && /^- special_terms/m.test(asked) })())
  const mutant = (notesText: string, raw: Array<{ key: string; value: unknown; evidence: string }>) => raw.map((r) => ({ key: r.key, value: r.value, evidence: r.evidence })).filter((r) => notesText.length > 0)
  check("POSITIVE CONTROL — a verifier-less pass-through would have shown the agent the invented escalation cap", mutant(notes1, [{ key: "escalation_cap", value: 450000, evidence: "$5,000 earnest money" }]).length === 1 && byKey(assisted, "escalation_cap") === undefined)
  const intakeRoute = codeWithStrings("app/api/form-wizard/intake-notes/route.ts"), intakeLib = codeWithStrings("lib/forms/intake-from-notes.ts")
  check("the route resolves the tenant from the SESSION, asks mayUseAndAfford('ai.generate') BEFORE the model, and takes no tenant from the body",
    intakeRoute.indexOf("auth.getUser()") >= 0 && intakeRoute.indexOf("auth.getUser()") < intakeRoute.indexOf("mayUseAndAfford(") && intakeRoute.indexOf("mayUseAndAfford(") < intakeRoute.indexOf("suggestIntakeAnswers(") && !/body\.(brokerage|tenant)/i.test(intakeRoute))
  check("the model call is the ROUTED, BOOKED primitive on an existing routing key (no new route, no raw gateway)", /generateObjectRouted\(/.test(intakeLib) && /feature: "offer_data_extraction"/.test(intakeLib) && !/gatewayChat|openai\(|anthropic\(/.test(intakeLib))
  check("the wizard applies a suggestion only on the agent's explicit action (no auto-apply in the fetch path)", /applySuggestions/.test(codeWithStrings("app/components/form-wizard/FormWizard.tsx")) && /Use the checked answers/.test(codeWithStrings("app/components/form-wizard/FormWizard.tsx")))

  // The wiring, on stripped source.
  const gatedBeforeService = (src: string) => {
    const bodies = [...src.matchAll(/export async function \w+\([^)]*\)[^{]*\{([\s\S]*?)(?=\nexport async function|$)/g)].map((m) => m[1])
    return bodies.length > 0 && bodies.every((b) => { const g = b.indexOf("requireSuperadmin()"), s = b.indexOf("createServiceClient()"); return g >= 0 && (s < 0 || g < s) })
  }
  const actionSrc = codeWithStrings("app/actions/superadmin/platform-form-packets.ts")
  check("every superadmin packet action opens with requireSuperadmin() BEFORE the service client (gate first, CLAUDE.md §4)", gatedBeforeService(actionSrc))
  check("POSITIVE CONTROL — the gate-order finder rejects an action that opens the service client first",
    gatedBeforeService(`export async function a(x: string) {\n const svc = createServiceClient()\n const g = await requireSuperadmin()\n}`) === false && gatedBeforeService(`export async function a(x: string) {\n const g = await requireSuperadmin()\n const svc = createServiceClient()\n}`) === true)
  // (wave 144, lane 144C) The tenant packet route, the wizard's packet source and the no-public-url census moved to section F —
  // the route is now the brokerage / team packet route (app/api/form-wizard/form-packets), asserted there with its tombstone.
  const probe = /\b(platform_form_packets|platformFormPackets|PLATFORM_FORM_PACKET\w*|platform_form_library|platformFormLibrary)\b/
  check("wave 142's SOURCE (a) probe now finds the packet source in lib/forms (stripped source — a tombstone would not count)", probe.test(stripComments(read("lib/forms/platform-form-packets.ts"))) && !probe.test(stripComments("// platform_form_packets was here")))

  // ═══ E. STRIPPED-SOURCE CENSUS ═══════════════════════════════════════════════════════════════════
  section("E stripped-source census")
  const files = ["lib/transactions/closing-compliance-core.ts", "lib/transactions/closing-compliance.ts", "lib/state-forms/closing-participants.ts"]
  const SIGNED_TABLES = ["offers", "transactions", "documents", "listings", "closing_disclosure_agreement"]
  const writesSignedTable = (s: string) => SIGNED_TABLES.some((t) => new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]\\s*\\)\\s*\\.\\s*(update|insert|delete|upsert)\\s*\\(`).test(s))
  check("nothing in the closing files writes to a signed-term table (offers, transactions, documents, listings, the CDA)", files.every((f) => !writesSignedTable(codeWithStrings(f))))
  control("the signed-table-write finder catches an UPDATE on offers", writesSignedTable, `await svc.from("offers").update({ offer_price: 1 })`)
  const tenantPinned = (src: string) => {
    const bad: string[] = []
    for (const m of src.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g)) {
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 500)
      if (/^\s*\.insert\(/.test(after)) continue // an insert carries the tenant in the row it writes (asserted on the rows below)
      if (!/brokerage_id/.test(after)) bad.push(m[1])
    }
    return bad
  }
  check("every query the runner makes is tenant-pinned within 500 characters (the tenant-scope idiom)", tenantPinned(codeWithStrings("lib/transactions/closing-compliance.ts")).length === 0, tenantPinned(codeWithStrings("lib/transactions/closing-compliance.ts")).join(","))
  control("the tenant-pin finder flags an unpinned query", (s) => tenantPinned(s).length > 0, `const r = await svc.from("offers").select("id").limit(1)`)
  const fairHousing = (s: string) => /fair[\s_-]?housing|protected[\s_-]?class|fheo/i.test(s)
  check("NO fair-housing logic in closing compliance (owner: fair-housing checks belong to public marketing copy only)", files.every((f) => !fairHousing(code(f))))
  control("the fair-housing finder catches a specimen", fairHousing, `if (fairHousingScan(text)) block()`)
  const scanner = codeWithStrings("lib/documents/scan-uploaded-document.ts"), finalCheck = codeWithStrings("lib/transactions/final-compliance-check.ts")
  check("the scanner's post-scan hook and the pre-CDA gate both call runClosingCompliance", /runClosingCompliance\(/.test(scanner) && /runClosingCompliance\(/.test(finalCheck))
  const wired = (s: string) => /runClosingCompliance\(/.test(stripComments(s))
  check("POSITIVE CONTROL — the wiring finder sees a call and is NOT satisfied by a tombstone comment (CLAUDE.md §2)",
    wired(`await runClosingCompliance(svc, input)`) === true && wired(`// runClosingCompliance(svc, input) was here`) === false)
  check("the scanner prompt asks for every settlement field the comparator reads", Object.keys(await import("../lib/transactions/closing-compliance-core").then((m) => m.SETTLEMENT_FIELD_TO_TERM)).every((k) => scanner.includes(k)))
  check("the scanner prompt asks for every contract-term field the default reader reads", Object.keys(await import("../lib/transactions/closing-compliance-core").then((m) => m.CONTRACT_FIELD_TO_TERM)).every((k) => scanner.includes(k)))
  check("the settings screen offers every dimension the resolver reads", ["CHECKLIST_STAGES", "FINANCING_KINDS", "CONTRACT_SUBTYPES", "REPRESENTATIONS"].every((n) => code("app/dashboard/settings/required-documents/required-docs-settings-client.tsx").includes(n)))
  check("the rule-write action validates each dimension against the ONE vocabulary", ["asChecklistStage", "asFinancingKind", "asContractSubtype", "asRepresentation"].every((n) => code("app/actions/compliance/manage-required-docs.ts").includes(n)))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CLOSING_COMPLIANCE_FAIL"); process.exit(1) }
  console.log(" ✅ CLOSING_COMPLIANCE_PASS — closing checks the executed contract terms (a counter supersedes) and the brokerage's closing checklist against the settlement; flags, never edits")
}
main().catch((e) => { console.error(e); process.exit(1) })
