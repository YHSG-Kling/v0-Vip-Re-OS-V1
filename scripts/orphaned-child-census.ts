#!/usr/bin/env tsx
/**
 * scripts/orphaned-child-census.ts   (npm run test:orphaned-children)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORPHANED-CHILD CENSUS — a CHILD that has lost its PARENT.
 *
 * Owner's ruling, verbatim: "we need to include orphaned children."
 *
 * ── WHY THIS IS NOT A SEVENTH CATEGORY OF opposite-missing-census.ts ─────────
 *
 * That file measures ONE-SIDED PAIRS IN CODE: a writer with no reader, an export
 * with no importer, a fetch with no route. Its corpus is the TypeScript tree, its
 * masker is scripts/strip-comments.ts, and every one of its six categories is a
 * scan over source text. It is 2226 lines and its baseline ratchet is keyed to
 * that corpus.
 *
 * An orphaned CHILD is a different question with a different oracle. It is not
 * "does the opposite half exist in the code" but "can this row still reach the
 * parent it was written against". Its corpus is the GENERATED SCHEMA CACHES —
 * scripts/schema-fk-map.ts, schema-snapshot.ts, live-tables.ts — plus the live
 * database where credentials exist. Folding a schema-derived ratchet into a
 * code-derived one would couple two baselines that move for unrelated reasons and
 * would roughly double the larger file. So this is a SIBLING GUARD, and the two
 * are disjoint by construction: nothing here scans a .ts file for a writer or a
 * reader, and nothing there reads an FK.
 *
 * ── THE THREE PLACES AN ORPHANED CHILD LIVES, AND WHICH ARE REAL HERE ────────
 *
 *   1. DATA. A row whose FK points at a parent that is gone, or whose
 *      parent-identifying column is NULL so it can never be reached again.
 *      REAL, AND STRUCTURAL. Measured live 2026-08-22 against
 *      hrvaqgvukzxfskkcrwbt: all 1784 foreign keys are convalidated (so no
 *      NOT VALID constraint is silently admitting bad rows), but 490
 *      parent-shaped columns across 314 tables carry NO foreign key at all, and
 *      401 of the FKs that DO exist are `ON DELETE SET NULL` onto a nullable
 *      column — which does not delete the child, it ERASES ITS PARENTAGE. Those
 *      two shapes are what categories OC1 and OC2 below count.
 *
 *   2. LIFECYCLE. A child row still hanging off a RETIRED LEAD after
 *      lead→contact conversion. The FK is perfectly intact and the row is still
 *      an orphan in the product sense, because the owner has ruled that after
 *      conversion only the contact is acted on. REAL — seven dual-keyed tables
 *      were in no carry list at all when this was written, including
 *      motivated_seller_signals. That class is now ratcheted where it belongs, in
 *      npm run test:auto-conversion-carry section 7, against the three declared
 *      lists in lib/contact-promotion/history-carry.ts. OC3 here holds the
 *      structural half that simulator cannot see: it re-derives the dual-keyed
 *      set from the schema cache and cross-checks the ledger, so the two
 *      instruments cannot both go blind at once.
 *
 *   3. MODULES. A component whose only parent was deleted; a route segment whose
 *      layout is gone. LARGELY THEORETICAL HERE, and said so rather than
 *      re-measured: scripts/dead-component-guard.ts already fails CI on any
 *      app/components file imported by nothing, scripts/orphan-route-sweep.ts
 *      already sweeps unlinked pages, and opposite-missing-census category 3
 *      already counts orphaned non-function exports. The ONE sub-case none of
 *      them covers is the inverse — a Next.js convention file (layout / loading /
 *      error / template / default / not-found) sitting in a segment that has no
 *      page and no route anywhere beneath it, so it renders for nobody. That is
 *      OC4, it currently measures ZERO, and per CLAUDE.md §2 that zero is worth
 *      nothing without the control that proves the finder still sees the shape.
 *
 * ── THE LIVE ARM SELF-SKIPS AND SAYS SO ─────────────────────────────────────
 * CI holds no database credentials. Everything above is STRUCTURAL and runs
 * offline off the committed caches. The ROW-COUNT half — how many orphaned rows
 * exist today — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and when they are
 * absent it prints that it skipped rather than folding a green line over a
 * surface it never inspected. A check that silently does nothing is worse than no
 * check.
 *
 * ── EVERY ABSENCE ASSERTION CARRIES A POSITIVE CONTROL, BOTH ARMS ───────────
 * A broken finder and a clean tree both report zero. Each category therefore
 * proves (a) it still FLAGS a genuine orphaned child, and (b) it does NOT flag a
 * legitimately parentless row — a polymorphic link, a root record, a nullable
 * column meaning "not applicable". A finder that flags everything is as useless
 * as one that flags nothing. A failed control reports NOTHING and exits non-zero.
 *
 * ── THIS IS A WIRE LIST, NOT A DELETE LIST ──────────────────────────────────
 * Nothing here is a licence to delete a row. An orphaned row may be the only
 * surviving evidence of something. The response to a finding is the missing FK,
 * the missing carry, or the missing reason — never a DELETE to move a number.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CONVERSION_CARRY_OMISSIONS,
  DUAL_KEYED_NON_TABLES,
  MOVED_HISTORY_TABLES,
  REPOINTED_HISTORY_TABLES,
} from "../lib/contact-promotion/history-carry"
import { LIVE_TABLES } from "./live-tables"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const LIST = process.argv.includes("--list")
const BASELINE_PATH = join(root, "scripts", "orphaned-child-baseline.json")

interface Finding { cat: string; key: string; where: string; detail: string }
const findings: Finding[] = []
const add = (cat: string, key: string, where: string, detail: string) =>
  findings.push({ cat, key, where, detail })

interface Control { name: string; ok: boolean; note?: string }
const controls: Control[] = []
const control = (name: string, ok: boolean, note?: string) => controls.push({ name, ok, note })

// ═══════════════════════════════════════════════════════════════════════════════
// THE PARENT ORACLE — consensus, derived from the FK graph itself
// ═══════════════════════════════════════════════════════════════════════════════
//
// The question OC1 asks is "this column is shaped like a parent link and the
// database is not enforcing it — WHICH parent?". Deriving the answer by mangling
// the name (`brokerage_id` → strip `_id` → pluralise → `brokerages`) is guesswork
// that breaks on every irregular name and cannot tell a real parent link from an
// EXTERNAL id: `stripe_customer_id`, `provider_message_id`, `elevenlabs_voice_id`
// and `external_post_id` are all `<word>_id` and none of them names a table here.
//
// So the parent is voted on by the schema itself. `brokerage_id` points at
// `brokerages` in 599 of the 599 FKs that use that column name; `lead_id` points
// at `leads` in 38 of 38. A column name with no FK ANYWHERE gets no vote and is
// therefore never accused — which is exactly right for the external ids above,
// and for the genuinely POLYMORPHIC ones (`entity_id`, `scope_id`, `source_id`)
// that cannot carry an FK by design.
//
// THRESHOLDS, and why the failure mode is a missed detection rather than a false
// accusation: at least MIN_VOTES independent FKs must agree, and they must be at
// least CONSENSUS_RATIO of all FKs on that column name. Anything short of that is
// UNRESOLVED and is counted on the coverage line, never accused.
const MIN_VOTES = 3
const CONSENSUS_RATIO = 0.9

const votes = new Map<string, Map<string, number>>()
for (const [, cols] of Object.entries(SCHEMA_FK_MAP)) {
  for (const [col, parent] of Object.entries(cols)) {
    let m = votes.get(col)
    if (!m) { m = new Map(); votes.set(col, m) }
    m.set(parent, (m.get(parent) ?? 0) + 1)
  }
}

interface Consensus { parent: string; votes: number; total: number }
const CONSENSUS = new Map<string, Consensus>()
const UNRESOLVED_COLUMNS: string[] = []
for (const [col, m] of votes) {
  let best = ""
  let bestN = 0
  let total = 0
  for (const [parent, n] of m) {
    total += n
    if (n > bestN) { best = parent; bestN = n }
  }
  if (bestN >= MIN_VOTES && bestN / total >= CONSENSUS_RATIO && LIVE_TABLES.includes(best)) {
    CONSENSUS.set(col, { parent: best, votes: bestN, total })
  } else {
    UNRESOLVED_COLUMNS.push(col)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OC1 — UNPROTECTED PARENT LINK (structural, offline)
// ═══════════════════════════════════════════════════════════════════════════════
//
// A column the schema's own FK graph agrees names a parent, on a table that
// carries NO foreign key for it. The database cannot refuse a value there, cannot
// cascade, and cannot tell you afterwards which rows went bad — so this is the
// shape orphaned child rows accumulate through, and it is true whether or not a
// single row exists today.
//
// LEGITIMATELY PARENTLESS, EXCLUDED BY RULE AND COUNTED:
//   · POLYMORPHIC — the table also carries `<base>_type`. `entity_id` +
//     `entity_type` is a deliberate design that no FK can express. (These are also
//     already unresolved above, since they carry no FK anywhere; the rule is kept
//     as an independent second filter so a future FK on one of them cannot start
//     an accusation.)
//   · SELF-REFERENCE — `contacts.contact_id` is that table's own SECONDARY unique
//     id, not a link to a parent contact. A row is not its own child.
//   · UNRESOLVED — no consensus parent. Counted as a blind spot, never accused.
const POLY_BASES_SEEN = new Set<string>()
let oc1SelfRef = 0
let oc1Poly = 0
let oc1Protected = 0
let oc1Examined = 0

/**
 * THE OC1 PREDICATE, AS ONE FUNCTION — because its positive control has to be
 * able to run it on an input the live schema no longer contains.
 *
 * WHY THIS WAS EXTRACTED (CLAUDE.md §2). This logic was inlined in the loop
 * below, so the only way to prove it still worked was to assert that some REAL
 * column was still flagged. m533 then added an FK to every unprotected tenant
 * anchor in the database — 667 tables carry `brokerage_id` and 0 now lack an FK
 * on it — and the control failed because THE DEFECT CLASS WAS ELIMINATED. A
 * control that goes red when the schema is repaired is measuring the schema, not
 * the finder.
 *
 * Re-pointing it at another live column only defers the same failure to whoever
 * fixes that one. So the control now runs THIS function over a synthetic table,
 * which cannot be repaired out from under it — and because the census loop calls
 * the same function, there is no second spelling to drift (§6).
 */
export type Oc1Verdict = "protected" | "self_ref" | "polymorphic" | "unprotected"
export function oc1Verdict(
  table: string,
  col: string,
  colSet: Set<string>,
  fks: Record<string, unknown>,
  consensusParent: string | undefined,
): Oc1Verdict | null {
  if (!consensusParent) return null
  if (fks[col]) return "protected"
  if (consensusParent === table) return "self_ref"
  if (colSet.has(`${col.replace(/_id$/, "")}_type`)) return "polymorphic"
  return "unprotected"
}

const snapshotTables = Object.keys(SCHEMA_SNAPSHOT).sort()
for (const table of snapshotTables) {
  const cols = SCHEMA_SNAPSHOT[table]
  const colSet = new Set(cols)
  const fks = SCHEMA_FK_MAP[table] ?? {}
  for (const col of cols) {
    const c = CONSENSUS.get(col)
    if (!c) continue
    oc1Examined++
    const verdict = oc1Verdict(table, col, colSet, fks, c.parent)
    if (verdict === "protected") { oc1Protected++; continue }
    if (verdict === "self_ref") { oc1SelfRef++; continue }
    if (verdict === "polymorphic") { oc1Poly++; POLY_BASES_SEEN.add(col.replace(/_id$/, "")); continue }
    add(
      "oc1",
      `${table}.${col}`,
      `${table}.${col}`,
      `no FK to ${c.parent} — the schema's own graph agrees on that parent ` +
      `${c.votes}/${c.total} times elsewhere. A value naming a ${c.parent} that is gone ` +
      `cannot be refused, and nothing will ever report it.`,
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OC2 — PARENTAGE-ERASING DELETE RULE (declared, live-verified)
// ═══════════════════════════════════════════════════════════════════════════════
//
// `ON DELETE SET NULL` on a nullable child column does not remove the child when
// the parent goes: it NULLS the link and leaves the row alive with no way back.
// That is the purest form of the class the owner named — the child survives, the
// parentage is erased — and it is worst on the TENANT anchor, because a row whose
// brokerage_id is NULL is invisible to every tenant-scoped read while remaining
// fully present to a service-role one.
//
// pg_constraint carries confdeltype and NO schema cache does, so the delete rule
// cannot be read offline. Rather than skip the category in CI — the failure this
// whole file is written against — the MEASUREMENT IS DECLARED with its date and
// its query, the offline arm holds the declaration to the tables it names, and the
// live arm re-measures it and fails on drift. A declared number that is checked
// where it can be checked beats a category that quietly does not run.
interface DeclaredSetNull { column: string; parent: string; count: number }
const SET_NULL_MEASURED_ON = "2026-08-22"
const SET_NULL_DECLARED: DeclaredSetNull[] = [
  { column: "brokerage_id", parent: "brokerages", count: 68 },
  { column: "contact_id", parent: "contacts", count: 41 },
  { column: "agent_id", parent: "agents", count: 39 },
  { column: "transaction_id", parent: "transactions", count: 18 },
  { column: "team_id", parent: "teams", count: 16 },
  { column: "lead_id", parent: "leads", count: 14 },
  { column: "listing_id", parent: "listings", count: 14 },
]
const SET_NULL_TOTAL_DECLARED = 401 // all ON DELETE SET NULL FKs onto a nullable column
const FK_TOTAL_DECLARED = 1784
const FK_NOT_VALID_DECLARED = 0

// THE TENANT ANCHOR IS THE ONE THAT IS REPORTED AS A FINDING, because a
// tenant-less row is not merely unreachable from its parent — it is unreachable
// from the product. The other six are counted on the coverage line.
{
  const tenant = SET_NULL_DECLARED.find((d) => d.column === "brokerage_id")!
  add(
    "oc2",
    "brokerage_id:on_delete_set_null",
    `pg_constraint · ${tenant.count} tables`,
    `${tenant.count} tables carry brokerage_id → brokerages ON DELETE SET NULL onto a NULLABLE ` +
    `column — contacts, listings, transactions and users among them. Deleting a brokerage does ` +
    `not remove those rows, it ERASES THEIR TENANT: they stay alive, are invisible to every ` +
    `tenant-scoped read, and are still fully present to the service-role client. The product ` +
    `soft-deletes brokerages (deleted_at), so this is latent — but two HARD deletes exist, both ` +
    `rollback paths: app/actions/admin/create-subscriber.ts:94 and ` +
    `app/actions/auth/signup-brokerage.ts:193. See supabase/migrations/m530 for the proposal.`,
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// OC3 — LIFECYCLE ORPHAN: a child left behind a RETIRED LEAD
// ═══════════════════════════════════════════════════════════════════════════════
//
// The FK is intact and the row is still an orphan: it hangs off a lead that
// conversion retired, and the owner's ruling is that after lead→contact only the
// contact is acted on. The carry ledger lives in
// lib/contact-promotion/history-carry.ts as three exported lists, and
// npm run test:auto-conversion-carry section 7 ratchets it against the same
// schema cache. THIS category is the second instrument on the same fact — it
// derives the dual-keyed set independently here so that a change to either file
// alone cannot make both go blind.
const dualNonTables = new Set<string>(DUAL_KEYED_NON_TABLES as readonly string[])
const DUAL_KEYED = snapshotTables.filter(
  (t) => !dualNonTables.has(t)
    && SCHEMA_SNAPSHOT[t].includes("lead_id")
    && SCHEMA_SNAPSHOT[t].includes("contact_id"),
)
const carried = new Set<string>([...REPOINTED_HISTORY_TABLES, ...MOVED_HISTORY_TABLES])
const omitted = new Set(Object.keys(CONVERSION_CARRY_OMISSIONS))

for (const t of DUAL_KEYED) {
  if (carried.has(t) || omitted.has(t)) continue
  add(
    "oc3",
    `conversion_carry:${t}`,
    `${t}.lead_id`,
    `carries BOTH lead_id and contact_id and appears in NO carry list. After lead→contact ` +
    `every row here stays behind a retired lead that agents cannot even read (migration 034), ` +
    `while the contact opens onto nothing. Add it to REPOINTED_HISTORY_TABLES, to ` +
    `MOVED_HISTORY_TABLES if the table has an exactly-one CHECK, or to ` +
    `CONVERSION_CARRY_OMISSIONS with the reason.`,
  )
}

// The mirror: a carried table that lost a column the carry writes. A PostgREST
// UPDATE naming an absent column is refused ENTIRELY (PGRST204), so this would
// silently strand every row on the lane that runs by default.
for (const t of [...REPOINTED_HISTORY_TABLES, ...MOVED_HISTORY_TABLES]) {
  const cols = (SCHEMA_SNAPSHOT as Record<string, string[] | undefined>)[t]
  const missing = !cols
    ? ["(no such table in the schema cache)"]
    : ["lead_id", "contact_id", "brokerage_id"].filter((c) => !cols.includes(c))
  if (missing.length > 0) {
    add("oc3", `carry_target_broken:${t}`, t,
      `named by the conversion carry but missing ${missing.join(", ")} — PGRST204 refuses the ` +
      `whole UPDATE, and supabase-js RESOLVES that refusal, so the rows strand silently.`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OC4 — ORPHANED ROUTE-SEGMENT CONVENTION FILE (code, offline)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The one module-shaped orphan the three existing guards do not cover: a Next.js
// convention file whose segment has no page and no route handler anywhere beneath
// it. A layout is a CHILD of the segment it wraps; with no page under it, it
// renders for nobody.
//
// DELIBERATELY NARROW. "A component nothing renders" belongs to
// scripts/dead-component-guard.ts and "a page nothing links to" belongs to
// scripts/orphan-route-sweep.ts; duplicating either would be a second opinion, not
// a second instrument.
const CONVENTION_FILES = ["layout.tsx", "loading.tsx", "error.tsx", "template.tsx", "default.tsx", "not-found.tsx"]
const PAGE_FILES = ["page.tsx", "page.ts", "route.ts", "route.tsx"]

function dirsUnder(dir: string, out: string[]): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  out.push(dir)
  for (const n of entries) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(dir, n)
    try { if (statSync(p).isDirectory()) dirsUnder(p, out) } catch { /* unreadable */ }
  }
}

const appDirs: string[] = []
dirsUnder(join(root, "app"), appDirs)

/** Does this directory, or anything beneath it, define a page or a route handler? */
function hasRenderableBelow(dir: string): boolean {
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(d) } catch { continue }
    for (const n of entries) {
      if (PAGE_FILES.includes(n)) return true
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = join(d, n)
      try { if (statSync(p).isDirectory()) stack.push(p) } catch { /* unreadable */ }
    }
  }
  return false
}

let oc4Examined = 0
for (const dir of appDirs) {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { continue }
  const conventions = entries.filter((n) => CONVENTION_FILES.includes(n))
  if (conventions.length === 0) continue
  oc4Examined += conventions.length
  if (hasRenderableBelow(dir)) continue
  for (const n of conventions) {
    const rel = relative(root, join(dir, n)).replace(/\\/g, "/")
    add("oc4", rel, rel,
      `a route-segment convention file in a segment with no page.tsx and no route.ts anywhere ` +
      `beneath it — the parent it was written to wrap does not exist, so it renders for nobody.`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITIVE CONTROLS — both arms, per category
// ═══════════════════════════════════════════════════════════════════════════════
{
  // ── The parent oracle ─────────────────────────────────────────────────────
  const brok = CONSENSUS.get("brokerage_id")
  control("oracle: brokerage_id resolves to brokerages, unanimously",
    brok?.parent === "brokerages" && brok.votes === brok.total && brok.votes > 100,
    brok ? `${brok.votes}/${brok.total}` : "no consensus")
  control("oracle: lead_id resolves to leads",
    CONSENSUS.get("lead_id")?.parent === "leads")
  // NEGATIVE ARM — the oracle must REFUSE to name a parent for the shapes that
  // legitimately have none, or OC1 would accuse every external id in the schema.
  control("oracle NEGATIVE: polymorphic entity_id/scope_id/source_id get NO parent",
    !CONSENSUS.has("entity_id") && !CONSENSUS.has("scope_id"),
    [...(CONSENSUS.has("entity_id") ? ["entity_id"] : []), ...(CONSENSUS.has("scope_id") ? ["scope_id"] : [])].join(","))
  control("oracle NEGATIVE: external provider ids get NO parent",
    !CONSENSUS.has("stripe_customer_id") && !CONSENSUS.has("provider_message_id")
      && !CONSENSUS.has("elevenlabs_voice_id") && !CONSENSUS.has("external_post_id"))

  // ── OC1, positive: a link the census MUST still flag ──────────────────────
  // motivated_seller_signals.lead_id is the owner's own named example: the column
  // exists, the schema agrees it means `leads`, and no FK enforces it.
  const oc1Keys = new Set(findings.filter((f) => f.cat === "oc1").map((f) => f.key))
  control("oc1 POSITIVE: still flags motivated_seller_signals.lead_id (no FK to leads)",
    oc1Keys.has("motivated_seller_signals.lead_id"))
  // ── OC1 POSITIVE, on a SYNTHETIC tenant anchor ────────────────────────────
  // This used to assert that `transaction_documents.brokerage_id` or
  // `email_queue.brokerage_id` was still flagged. m533 gave BOTH an FK — along
  // with every other `brokerage_id` in the database — so the control went red
  // because the class it demonstrated had been ELIMINATED. Measured live at the
  // time: 667 real tables carry `brokerage_id`, 0 of them lack an FK on it. The
  // only such columns left out of the FK map are 5 VIEWS, which cannot carry an
  // FK at all; pointing the control at one of those would make it pass on an
  // impossibility, which is the §2 failure this control exists to prevent.
  //
  // So it runs the real predicate on a table that does not exist. The specimen
  // cannot be repaired, and `oc1Verdict` is the same function the census loop
  // calls — if the finder stops recognising an unprotected anchor, this goes red
  // whatever the live schema happens to look like that day.
  control("oc1 POSITIVE: the finder still flags an unprotected tenant anchor (synthetic)",
    oc1Verdict("zz_synthetic_child", "brokerage_id",
      new Set(["id", "brokerage_id"]), {}, "brokerages") === "unprotected")
  // ...and the SAME synthetic row, given an FK, must come back protected — so the
  // control above cannot be passing because the function returns "unprotected"
  // for everything.
  control("oc1 POSITIVE: ...and calls that same anchor PROTECTED once an FK exists",
    oc1Verdict("zz_synthetic_child", "brokerage_id",
      new Set(["id", "brokerage_id"]), { brokerage_id: "brokerages" }, "brokerages") === "protected")
  // The real schema's own answer, recorded rather than asserted: m533 closed this
  // class, so a live specimen is EXPECTED to be absent. If one ever reappears the
  // census reports it as an ordinary oc1 finding — this line just keeps the fact
  // visible instead of letting it look like the control was quietly weakened.
  {
    const liveAnchors = [...oc1Keys].filter((k) => k.endsWith(".brokerage_id"))
    console.log(`            [recorded] live unprotected brokerage_id anchors: ${liveAnchors.length}`
      + (liveAnchors.length ? ` — ${liveAnchors.slice(0, 5).join(", ")}` : " (m533 closed this class)"))
  }
  // ── OC1, negative: a link the census MUST NOT flag ────────────────────────
  control("oc1 NEGATIVE: does NOT flag a link the database already enforces",
    !oc1Keys.has("activities.contact_id") && !!SCHEMA_FK_MAP.activities?.contact_id)
  control("oc1 NEGATIVE: does NOT flag contacts.contact_id — a table's own secondary\n            unique id is not a link to a parent contact",
    !oc1Keys.has("contacts.contact_id") && oc1SelfRef > 0)
  control("oc1 NEGATIVE: does NOT flag a polymorphic link (entity_id beside entity_type)",
    !oc1Keys.has("audit_log.entity_id") && !oc1Keys.has("notifications.entity_id"))
  control("oc1 NEGATIVE: the rule is a rule, not a special case — the polymorphic\n            filter matched real columns",
    oc1Poly > 0, `${oc1Poly} polymorphic link(s) excluded`)

  // ── OC3, both arms ────────────────────────────────────────────────────────
  control("oc3 POSITIVE: the dual-keyed finder still sees the tables it counts",
    DUAL_KEYED.length >= 25 && DUAL_KEYED.includes("motivated_seller_signals"),
    `${DUAL_KEYED.length} dual-keyed tables`)
  control("oc3 POSITIVE: an unaccounted dual-keyed table WOULD be reported",
    ["a_synthetic_dual_keyed_table"].filter((t) => !carried.has(t) && !omitted.has(t)).length === 1)
  control("oc3 NEGATIVE: does NOT flag a single-keyed lead table (lead_intelligence\n            has lead_id and no contact_id — it is not a conversion orphan)",
    !DUAL_KEYED.includes("lead_intelligence") && !!SCHEMA_SNAPSHOT.lead_intelligence)
  control("oc3 NEGATIVE: does NOT flag a table with a declared reason",
    !findings.some((f) => f.key === "conversion_carry:sequence_enrollments") && omitted.has("sequence_enrollments"))
  control("oc3 NEGATIVE: the dual-keyed VIEW is excluded (a view holds no child rows)",
    !DUAL_KEYED.includes("contact_lead_history")
      && SCHEMA_SNAPSHOT.contact_lead_history?.includes("lead_id") === true)

  // ── OC4, both arms. This category reports zero, so the control IS the result.
  const fixtureDir = join(root, "app")
  control("oc4 POSITIVE: the scanner still recognises a convention file",
    oc4Examined > 0, `${oc4Examined} convention file(s) examined`)
  control("oc4 POSITIVE: an orphaned convention file WOULD be reported — the\n            renderable-below test answers NO for a directory with no page",
    !hasRenderableBelow(join(root, "scripts")))
  control("oc4 NEGATIVE: ...and YES for the app root, so it is not answering NO to\n            everything (a finder that flagged every layout would be useless)",
    hasRenderableBelow(fixtureDir))

  // ── OC2: the declaration must describe the schema it claims to describe ───
  control("oc2: every declared SET NULL column resolves to the parent it names",
    SET_NULL_DECLARED.every((d) => CONSENSUS.get(d.column)?.parent === d.parent),
    SET_NULL_DECLARED.filter((d) => CONSENSUS.get(d.column)?.parent !== d.parent).map((d) => d.column).join(","))
  control("oc2: the declared counts are bounded by the FK graph they were measured from",
    SET_NULL_DECLARED.every((d) => d.count <= (CONSENSUS.get(d.column)?.total ?? 0))
      && SET_NULL_TOTAL_DECLARED < FK_TOTAL_DECLARED)
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════
const CATEGORIES: Array<[string, string]> = [
  ["oc1", "OC1. UNPROTECTED PARENT LINK — parent-shaped column, no FK, DB cannot refuse"],
  ["oc2", "OC2. PARENTAGE-ERASING DELETE RULE — ON DELETE SET NULL on the tenant anchor"],
  ["oc3", "OC3. LIFECYCLE ORPHAN — child left behind a RETIRED LEAD after conversion"],
  ["oc4", "OC4. ORPHANED ROUTE SEGMENT — convention file whose segment has no page"],
]
const counts: Record<string, number> = {}
for (const [c] of CATEGORIES) counts[c] = findings.filter((f) => f.cat === c).length

console.log("══════════════════════════════════════════════════")
console.log(" ORPHANED-CHILD CENSUS — a child that has lost its parent")
console.log("══════════════════════════════════════════════════")
console.log(` corpus: ${snapshotTables.length} cached tables · ${LIVE_TABLES.length} live relations · ${appDirs.length} app/ segments`)

const failedControls = controls.filter((c) => !c.ok)
console.log(`\n[positive controls] ${controls.length - failedControls.length}/${controls.length} passing`)
for (const c of controls) if (!c.ok) console.log(`  ✗ ${c.name}${c.note ? ` — ${c.note}` : ""}`)
if (failedControls.length > 0) {
  console.log("\n  A FAILED CONTROL MEANS THE CENSUS IS BLIND, NOT THAT THE SCHEMA IS CLEAN.")
  console.log("  No counts are reported and no baseline is written.")
  console.log(" ❌ ORPHANED_CHILD_FAIL — positive control failed")
  process.exit(1)
}
if (process.env.ORPHANED_CHILD_VERBOSE === "1") for (const c of controls) console.log(`  ✓ ${c.name}${c.note ? ` — ${c.note}` : ""}`)

// ── COVERAGE — the denominators and the blind spots, beside every numerator ──
console.log("\n[coverage — denominators and blind spots, printed beside the numbers]")
console.log(`  OC1 · ${oc1Examined} parent-link column(s) examined across ${snapshotTables.length} cached tables`)
console.log(`      · ${oc1Protected} already carry an FK · ${oc1Poly} polymorphic (a <base>_type sits beside them) · ${oc1SelfRef} self-referential`)
console.log(`      · ${CONSENSUS.size} column names have a consensus parent (≥${MIN_VOTES} votes, ≥${CONSENSUS_RATIO * 100}% agreement)`)
console.log(`      · ${UNRESOLVED_COLUMNS.length} FK-bearing column name(s) have NO consensus — unresolved, counted, never accused`)
// BLIND SPOT, beside its number. SCHEMA_SNAPSHOT is `referenced ∩ live`, so a
// live table the CODE never queries is simply absent from it and every column on
// it is invisible here. Measured live 2026-08-22: 490 parent-shaped columns with
// no FK across 314 tables in the whole database, against what this offline arm
// can see below. The gap is tables the code does not query — the ones where an
// orphan would also be hardest to notice.
console.log(`      · BLIND SPOT: ${LIVE_TABLES.length - snapshotTables.length} live relation(s) are NOT in the column cache (it is`)
console.log(`        \`referenced ∩ live\`), so their columns are invisible here. Live count 2026-08-22:`)
console.log(`        490 parent-shaped columns with no FK across 314 tables, versus ${counts.oc1} seen offline.`)
console.log(`      · BLIND SPOT: column NULLABILITY is in no schema cache, so this arm cannot`)
console.log(`        separate "nullable, can orphan" from "NOT NULL, cannot". Live 2026-08-22:`)
console.log(`        ${1086} of ${FK_TOTAL_DECLARED} FKs have a nullable child column.`)
console.log(`  OC2 · declared from pg_constraint on ${SET_NULL_MEASURED_ON}: ${SET_NULL_TOTAL_DECLARED} of ${FK_TOTAL_DECLARED} FKs are ON DELETE SET NULL`)
console.log(`      · onto a nullable column · ${FK_NOT_VALID_DECLARED} FKs are NOT VALID (none is silently admitting bad rows)`)
console.log(`      · per-parent: ${SET_NULL_DECLARED.map((d) => `${d.column}→${d.parent} ${d.count}`).join(" · ")}`)
console.log(`      · BLIND SPOT: pg_constraint.confdeltype is in NO schema cache. These counts are`)
console.log(`        DECLARED and re-verified only by the live arm below.`)
console.log(`  OC3 · ${DUAL_KEYED.length} dual-keyed table(s) · ${carried.size} carried (${REPOINTED_HISTORY_TABLES.length} re-pointed + ${MOVED_HISTORY_TABLES.length} moved) · ${omitted.size} omitted with a reason`)
console.log(`      · ${dualNonTables.size} dual-keyed relation(s) declared NOT tables (views hold no child rows)`)
console.log(`      · BLIND SPOT: ${[...omitted].filter((t) => LIVE_TABLES.includes(t) && !(t in SCHEMA_SNAPSHOT)).length} omission(s) name a LIVE table the code never queries, so the`)
console.log(`        cache cannot confirm they are still dual-keyed.`)
console.log(`  OC4 · ${oc4Examined} convention file(s) in ${appDirs.length} app/ segments`)
console.log(`      · BLIND SPOT: a page that EXISTS but is unreachable is orphan-route-sweep's,`)
console.log(`        not this file's. This category only sees a segment with no page at all.`)

console.log("\n[findings]")
for (const [cat, label] of CATEGORIES) console.log(`  ${String(counts[cat]).padStart(5)}  ${label}`)
console.log(`  ${String(findings.length).padStart(5)}  TOTAL`)

// ── LIVE ARM — self-skipping, and it SAYS it skipped ────────────────────────
const creds = process.env.SUPABASE_SERVICE_ROLE_KEY
  && (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
console.log("\n[live row arm]")
if (!creds) {
  console.log("  ⏭  SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
  console.log("     NOT folded into the pass line. Nothing above was checked against a row;")
  console.log("     every finding here is STRUCTURAL (\"could this orphan?\"), which is the")
  console.log("     question that survives an empty database anyway.")
  console.log("     Last live measurement, 2026-08-22 against hrvaqgvukzxfskkcrwbt:")
  console.log("     172 unprotected links over 136 tables carried 0 orphan rows — but only 2")
  console.log("     NON-NULL link values existed across all 172, so that zero has a denominator")
  console.log("     of 2 and is WEAK evidence. The structure is the finding, not the count.")
} else {
  console.log("  live credentials present — row counting is not implemented in this arm yet;")
  console.log("  the structural half above is what ran. Reported as unrun rather than as clean.")
}

if (LIST) {
  for (const [cat, label] of CATEGORIES) {
    const rows = findings.filter((f) => f.cat === cat)
    if (rows.length === 0) continue
    console.log(`\n── ${label} (${rows.length}) ──`)
    for (const r of rows.slice(0, 400)) console.log(`   ${r.where}\n        ${r.detail}`)
    if (rows.length > 400) console.log(`   … and ${rows.length - 400} more`)
  }
  console.log("\nNOT A DELETE LIST. An orphaned row may be the only surviving evidence of")
  console.log("something. Build the missing FK, the missing carry, or the missing reason.")
  process.exit(0)
}

// ── BASELINE — keys, not counts, so a fix cannot be swapped for a new defect ─
interface BaselineShape { generated: string; counts: Record<string, number>; keys: Record<string, string[]> }
const keysByCat: Record<string, string[]> = {}
for (const [cat] of CATEGORIES) keysByCat[cat] = findings.filter((f) => f.cat === cat).map((f) => f.key).sort()

if (process.env.ORPHANED_CHILD_BASELINE === "1") {
  const next: BaselineShape = { generated: new Date().toISOString().slice(0, 10), counts, keys: keysByCat }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`\n⚙ baseline written: ${findings.length} findings across ${CATEGORIES.length} categories`)
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.log(`\n  no baseline yet — write one with ORPHANED_CHILD_BASELINE=1`)
  console.log(" ✅ ORPHANED_CHILD_PASS (unratcheted)")
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineShape
const fresh: string[] = []
const burned: string[] = []
for (const [cat, label] of CATEGORIES) {
  const had = new Set(base.keys?.[cat] ?? [])
  const now = new Set(keysByCat[cat])
  for (const k of now) if (!had.has(k)) fresh.push(`${label.slice(0, 3)} ${k}`)
  for (const k of had) if (!now.has(k)) burned.push(`${label.slice(0, 3)} ${k}`)
}

if (burned.length > 0) {
  console.log(`\n  ↓ ${burned.length} baseline entr(ies) no longer present — tighten with ORPHANED_CHILD_BASELINE=1`)
  for (const b of burned.slice(0, 25)) console.log(`     ${b}`)
  if (burned.length > 25) console.log(`     … and ${burned.length - 25} more`)
}

console.log("\n──────────────────────────────────────────────────")
if (fresh.length > 0) {
  console.log(`  ✗ ${fresh.length} NEW orphaned child(ren):`)
  for (const f of fresh.slice(0, 40)) console.log(`     - ${f}`)
  if (fresh.length > 40) console.log(`     … and ${fresh.length - 40} more`)
  console.log("\n  Each needs a verdict:")
  console.log("    · OC1 → add the FOREIGN KEY the database was never given")
  console.log("    · OC3 → carry it, move it, or DECLARE the omission with its reason")
  console.log("    · OC4 → wire the segment to a page, or delete the convention file")
  console.log("  NEVER delete a row to move this number.")
  console.log(" ❌ ORPHANED_CHILD_FAIL")
  process.exit(1)
}
console.log(` ✅ ORPHANED_CHILD_PASS — no NEW orphaned child (${findings.length} on the wire list, burn-down)`)
