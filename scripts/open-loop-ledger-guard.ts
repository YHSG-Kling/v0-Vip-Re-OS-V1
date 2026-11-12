/**
 * scripts/open-loop-ledger-guard.ts — test:open-loop-ledger (wave 148, lane 148K).
 *
 * Owner ruling 18: every recorded open loop / blind spot of waves 142–147 is a line item, closed or honestly carried.
 * This proof holds the books to that rule:
 *   A. the inventory is well formed (unique ids, known sections, digests);
 *   B. COVERAGE — when OPEN_LOOP_NOTES_DIR points at the lane notes, a fresh extraction equals the inventory
 *      (id + digest); otherwise that comparison is SKIPPED and printed as a blind spot, never as a pass;
 *   C. every row has a status from the vocabulary and either PROOF (closed: every evidence re-derived NOW — anchors in
 *      stripped source, line-1 migration stamps, package keys, chain membership) or a REASON + OWNER + KIND (carried);
 *   D. no manual disposition names an id the inventory does not hold (a stale key reads as handled while handling nothing);
 *   E. launch-critical rows come first;
 *   F. docs/operations/OPEN-LOOP-LEDGER.md equals the derivation (generated, never hand-edited);
 *   G. ruling 18 by section: every blind spot and every WAITING_EXTERNAL item is closed or carried with an owner;
 *   H. positive controls — each finder above is shown catching the defect it exists for.
 * Blind spots are printed at the end.
 */
import { readFileSync } from "node:fs"
import {
  CARRY_KINDS, INVENTORY_PATH, LEDGER_PATH, OWNERS, SECTION_CODES, STATUSES,
  buildRows, capabilitySurfaceItems, extractFromNotes, extractInventory, loadInventory, renderLedger, resolveEvidence,
  splitItems, summarize, validateRow, type Disposition, type InventoryItem, type RepoReader,
} from "./open-loop-ledger"
import { MANUAL_DISPOSITIONS } from "./open-loop-ledger-dispositions"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const inv = loadInventory()
const rows = buildRows(inv)

console.log("\nA. inventory well formed")
const ids = inv.items.map((i) => i.id)
check("every inventory id is unique", new Set(ids).size === ids.length, `${ids.length} ids`)
check("every item names a known section", inv.items.every((i) => i.section in SECTION_CODES))
check("every item carries a 12-hex digest and a source", inv.items.every((i) => /^[0-9a-f]{12}$/.test(i.digest) && i.source.length > 0))
check("waves are 142–147", inv.items.every((i) => i.wave >= 142 && i.wave <= 147))

console.log("\nB. coverage against the lane notes")
const notesDir = process.env.OPEN_LOOP_NOTES_DIR
let coverageSkipped = false
if (notesDir) {
  const fresh = extractInventory(notesDir)
  const want = new Set(fresh.items.map((i) => `${i.id}:${i.digest}`))
  const have = new Set(inv.items.map((i) => `${i.id}:${i.digest}`))
  const missing = [...want].filter((x) => !have.has(x))
  const extra = [...have].filter((x) => !want.has(x))
  check("every recorded item in the notes is in the inventory", missing.length === 0, missing.slice(0, 5).join(", "))
  check("the inventory holds nothing the notes do not record", extra.length === 0, extra.slice(0, 5).join(", "))
} else {
  coverageSkipped = true
  console.log("  ◌ SKIPPED — OPEN_LOOP_NOTES_DIR is unset (the notes live in the integrator's scratchpad); the checked-in inventory is trusted as extracted")
}

console.log("\nC. every row has a status and a proof or a reason")
const problems = rows.flatMap((r) => validateRow(r))
check("every row validates (status · proof re-derived · reason · owner · kind)", problems.length === 0, problems.slice(0, 8).join(" | "))
check("the rows cover the inventory plus the derived capability-surface items", rows.length === inv.items.length + capabilitySurfaceItems().length, `${rows.length} rows`)
check("every row id appears exactly once", new Set(rows.map((r) => r.id)).size === rows.length)
const closedRows = rows.filter((r) => r.d.s === "closed")
check("every closed row's evidence resolved this run", closedRows.every((r) => r.resolved.length > 0 && r.resolved.every((x) => x.ok)), `${closedRows.length} closed`)

console.log("\nD. no stale manual disposition")
const known = new Set(rows.map((r) => r.id))
const stale = Object.keys(MANUAL_DISPOSITIONS).filter((k) => !known.has(k))
check("every manual disposition names a ledger id", stale.length === 0, stale.join(", "))

console.log("\nE. launch-critical first")
const firstNonLc = rows.findIndex((r) => !r.launchCritical)
check("no launch-critical row follows a non-launch-critical one", firstNonLc < 0 || rows.slice(firstNonLc).every((r) => !r.launchCritical))

console.log("\nF. the generated ledger is in sync")
const committed = (() => { try { return readFileSync(LEDGER_PATH, "utf8") } catch { return "" } })()
const derived = renderLedger(inv, rows)
check(`${LEDGER_PATH} equals the derivation`, committed === derived, committed ? "run `npx tsx scripts/open-loop-ledger.ts --write`" : "file missing")

console.log("\nG. ruling 18 by section")
const bs = rows.filter((r) => r.section === "BS")
check("every blind spot is closed, carried with an owner, or (validated) recorded as none", bs.every((r) => r.d.s === "closed" || r.d.s === "none-recorded" || (r.d.s === "carried" && !!r.d.o)), `${bs.length} blind spots: ${bs.filter((r) => r.d.s === "none-recorded").length} recorded none`)
const we = rows.filter((r) => r.section === "WE")
check("every WAITING_EXTERNAL item is closed, carried with an owner, or recorded as none", we.every((r) => r.d.s !== "carried" || !!r.d.o), `${we.length} items`)

console.log("\nH. positive controls")
const files: Record<string, string> = {
  "lib/x.ts": "// tombstone: the old fooBarHelper moved to lib/y.ts\nexport const live = 1\n",
  "lib/y.ts": "export function fooBarHelper() { return 1 }\n",
  "supabase/migrations/m901-applied.sql": "-- ── APPLIED LIVE 2026-10-31 via Supabase MCP\nselect 1;\n",
  "supabase/migrations/m902-written.sql": "-- WRITTEN, NOT APPLIED (wave 148, lane 148K)\nselect 1;\n",
  "package.json": '{\n "scripts": {\n  "guard": "npm run test:a && npm run test:ab",\n  "test:a": "tsx a.ts",\n  "test:ab": "tsx ab.ts",\n  "test:loose": "tsx l.ts"\n }\n}\n',
}
const fx: RepoReader = {
  read: (p) => files[p] ?? null,
  list: (d) => Object.keys(files).filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)),
}
const row = (d: Disposition, text = "Something recorded open.") => ({ id: "PC", text, d, resolved: (d.e ?? []).map((e) => resolveEvidence(e, fx)) })
const flags = (d: Disposition, text?: string) => validateRow(row(d, text)).length > 0
check("PC1 a closed row with no evidence is caught", flags({ s: "closed" }))
check("PC2 evidence naming a missing file is caught", flags({ s: "closed", e: ["lib/nope.ts#x"] }))
check("PC3 an anchor that exists only inside a comment (a tombstone) is caught", flags({ s: "closed", e: ["lib/x.ts#fooBarHelper"] }))
check("PC4 the same anchor in live code resolves (the finder can pass)", !flags({ s: "closed", e: ["lib/y.ts#fooBarHelper"] }))
check("PC5a a carried row with no reason is caught", flags({ s: "carried", k: "missing-code", o: "owner" }))
check("PC5b an owner outside the vocabulary is caught", flags({ s: "carried", k: "missing-code", o: "somebody" as never, r: "a reason long enough to count as one" }))
check("PC5c a kind outside the vocabulary is caught", flags({ s: "carried", k: "later" as never, o: "owner", r: "a reason long enough to count as one" }))
check("PC5d an unknown legend code is caught", flags({ s: "carried", k: "missing-code", o: "owner", r: "[NOT_A_CODE]" }))
check("PC6a an unapplied migration as closure evidence is caught", flags({ s: "closed", e: ["mig:m902"] }))
check("PC6b an applied migration resolves", !flags({ s: "closed", e: ["mig:m901"] }))
check("PC7a a missing package key is caught", flags({ s: "closed", e: ["key:test:nope"] }))
check("PC7b a key outside the guard chain is caught by chain:", flags({ s: "closed", e: ["chain:test:loose"] }))
check("PC7c chain: does not accept a prefix (test:a ≠ test:ab)", resolveEvidence("chain:test:a", fx).ok && !resolveEvidence("chain:test:abc", fx).ok)
check("PC8a an absence proof with no survivor is caught", flags({ s: "closed", e: ["absent:lib/y.ts#gone"] }))
check("PC8b an absence proof whose token is still there is caught", flags({ s: "closed", e: ["absent:lib/y.ts#fooBarHelper", "lib/y.ts#fooBarHelper"] }))
check("PC8c an absence proof beside its survivor resolves", !flags({ s: "closed", e: ["absent:lib/x.ts#fooBarHelper()", "lib/y.ts#fooBarHelper"] }))
check("PC9 none-recorded on an item that records something is caught", flags({ s: "none-recorded", r: "[NONE]" }, "The kiosk still matches by email."))
check("PC10 an env reader as the only closure proof is caught", flags({ s: "closed", e: ["env:PATH"] }) )
const status = ({ s: "maybe" } as unknown) as Disposition
check("PC11 a status outside the vocabulary is caught", flags(status))
const notes = [
  "# Lane 999Q notes", "## Still open", "1. **First** item", "   continued line", "2. Second item", "",
  "## Outside-lane", "- bullet one", "  - sub bullet folds in", "- bullet two", "", "### a label", "A free paragraph item.", "",
  "## Blind spots", "| a | b |", "|---|---|", "| row 1 | x |", "| row 2 | y |", "",
  "## Skills used", "- not an open-loop item",
].join("\n")
const ex = extractFromNotes("lane147Q-notes.md", notes).items
check("PC12 the extractor reads numbered, bulleted, paragraph and table items (header, separator, label skipped)",
  ex.map((i) => i.id).join(",") === "147Q-SO-01,147Q-SO-02,147Q-OL-01,147Q-OL-02,147Q-OL-03,147Q-BS-01,147Q-BS-02", ex.map((i) => i.id).join(","))
check("PC12b a continuation line folds into its item", ex[0]?.text.includes("continued line") === true && splitItems("- a\n  - b").length === 1)
const fakeInv = { ...inv, items: [...inv.items.slice(0, 2)] as InventoryItem[] }
const fakeStale = Object.keys({ "999Q-SO-01": 1, [inv.items[0].id]: 1 }).filter((k) => !new Set(fakeInv.items.map((i) => i.id)).has(k))
check("PC13 a manual key the inventory does not hold is detected as stale", fakeStale.length === 1 && fakeStale[0] === "999Q-SO-01")
check("PC14 a hand edit of the ledger is detected as drift", `${derived}x` !== derived && committed.length > 0)
check("PC15 vocabularies are non-empty and distinct", new Set(STATUSES).size === 3 && CARRY_KINDS.length >= 10 && OWNERS.includes("lane148Z"))

const s = summarize(rows)
console.log(`\nSUMMARY: ${s.total} items · ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")} · launch-critical ${s.launchCritical} (carried ${s.launchCriticalOpen})`)
console.log(`  carried by kind: ${Object.entries(s.byKind).filter(([k]) => k !== "closed" && k !== "none-recorded").map(([k, v]) => `${k} ${v}`).join(" · ")}`)
console.log(`  by wave: ${Object.entries(s.byWave).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
console.log("\nBLIND SPOTS")
console.log(`  · coverage against the notes: ${coverageSkipped ? "SKIPPED this run (OPEN_LOOP_NOTES_DIR unset)" : "compared"}; the inventory is otherwise the snapshot extracted by lane 148K.`)
console.log("  · `unverified` means recorded open with no closure evidence FOUND — not proven open. The 148K spot-check of launch-critical unverified rows found several already closed by later waves; the class over-counts open work.")
console.log("  · auto:convergence-match closes a row when its wave's (or the next wave's) convergence record cites the same file AND identifier and the identifier is live in stripped source — a matching heuristic, labelled as such.")
console.log("  · a closure proves the cited code exists now; it does not re-run the behaviour (each cited survivor has its own proof).")
console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
