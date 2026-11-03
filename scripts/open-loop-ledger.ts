/**
 * scripts/open-loop-ledger.ts — WAVE 148, lane 148K: "every open loop and every blind spot, waves 142–147".
 *
 * Owner ruling 18 (2026-11-01): "Handle ALL blind spots of ALL waves — every '## Blind spots' paragraph in lane142–147
 * notes is a line item: closed, or honestly carried with its reason." Ruling 23: close every autonomous loop; build every
 * "not available yet" capability. This script is the BOOKS for that: one row per recorded item, each with a status and
 * either PROOF (closed — a repo file:line the generator re-derives every run) or a REASON + OWNER (carried).
 *
 * Three modes:
 *   npx tsx scripts/open-loop-ledger.ts --extract <notesDir>   capture the recorded items from the lane notes
 *        (lane14*-notes.md: "## Still open", "## Outside-lane", "## Blind spots", "## WAITING_EXTERNAL",
 *        "## Owner decisions", the convergence lanes' "Items NOT closed" / "Owner items" / "Still red") and the wave
 *        reports' §18–§19 into docs/operations/open-loop-ledger-inventory.json. The notes live in the integrator's
 *        scratchpad, not the repo, so the inventory is the checked-in snapshot; the guard re-extracts and compares
 *        whenever OPEN_LOOP_NOTES_DIR points at the notes.
 *   npx tsx scripts/open-loop-ledger.ts --write                render docs/operations/OPEN-LOOP-LEDGER.md
 *   npx tsx scripts/open-loop-ledger.ts                        print the summary (no write)
 *
 * Statuses are DERIVED, never pinned: a closure names evidence as `path#anchor` (the generator finds the anchor in
 * STRIPPED source — a tombstone is not a call site, CLAUDE.md §2 — and prints the line it lands on), `mig:mNNN` (line 1
 * of the migration carries the APPLIED LIVE stamp), or `key:test:x` (the key is in package.json). Evidence that stops
 * resolving turns test:open-loop-ledger red rather than reading as closed. An item with no manual disposition and no
 * rule match is carried as `unverified` with the owning wave-148 lane derived from the files it cites — the honest
 * default: "recorded open, no closure evidence found", never "closed".
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "./strip-comments"
import { MANUAL_DISPOSITIONS } from "./open-loop-ledger-dispositions"

export const INVENTORY_PATH = "docs/operations/open-loop-ledger-inventory.json"
export const LEDGER_PATH = "docs/operations/OPEN-LOOP-LEDGER.md"
export const CAPABILITY_AUDIT_PATH = "docs/architecture/CAPABILITY-SURFACE-AUDIT.md"

// ── vocabularies (one spelling each — CLAUDE.md §6) ────────────────────────────────────────────────────────────────
export const SECTION_CODES = {
  SO: "Still open", OL: "Outside-lane", BS: "Blind spots", WE: "WAITING_EXTERNAL", OD: "Owner decisions",
  NC: "Items not closed", OI: "Owner items", SR: "Still red", RP: "Wave report §18–19", CS: "Capability surface",
} as const
export type SectionCode = keyof typeof SECTION_CODES
export const STATUSES = ["closed", "carried", "none-recorded"] as const
export type Status = (typeof STATUSES)[number]
/** Why a carried item is not closed — the brief's four (missing code · missing wiring · missing credentials/licensing ·
 *  deferred) plus the dispositions an auditor actually meets. */
export const CARRY_KINDS = [
  "missing-code", "missing-wiring", "missing-credentials", "licensing", "deferred",
  "owner-decision", "owner-sql", "inherent-limit", "handed-to-lane", "unverified",
] as const
export type CarryKind = (typeof CARRY_KINDS)[number]
export const OWNERS = [
  "owner", "counsel", "integrator", "inherent",
  "lane148A", "lane148B", "lane148C", "lane148D", "lane148E", "lane148F", "lane148G", "lane148H", "lane148I", "lane148J",
  "lane148K", "lane148Z",
  // wave 149 (lane 149J re-evaluated the 575 unverified rows and hands each carried row to the wave-149 lane whose file
  // domain holds it — WAVE149_SPEC.md "LANES"; lane149Z = the wave's convergence lane, no other lane owns the file)
  "lane149A", "lane149B", "lane149C", "lane149D", "lane149E", "lane149F", "lane149G", "lane149H", "lane149I", "lane149J",
  "lane149K", "lane149Z",
] as const
export type Owner = (typeof OWNERS)[number]

export interface InventoryItem {
  id: string
  wave: number
  lane: string
  section: SectionCode
  text: string
  digest: string
  source: string
}
export interface ClosureRecord { wave: number; lane: string; text: string }
export interface Inventory { generatedFrom: string; items: InventoryItem[]; closureRecords: ClosureRecord[] }

export interface Disposition {
  s: Status
  /** evidence for a closure: `path#anchor` · `mig:mNNN` · `key:test:name` · `env:NAME` (a carried item's proof that the name is real) */
  e?: string[]
  k?: CarryKind
  o?: Owner
  /** reason (carried / none-recorded) — free text, or a legend code `[XX]` */
  r?: string
  /** who closed it (closed rows) */
  by?: string
  lc?: boolean
}
export interface Row extends InventoryItem { d: Disposition; basis: string; launchCritical: boolean; resolved: ResolvedEvidence[] }
export interface ResolvedEvidence { ev: string; ok: boolean; at?: string; why?: string }

// ── extraction ─────────────────────────────────────────────────────────────────────────────────────────────────────
const HEADING_TO_SECTION: Array<[RegExp, SectionCode]> = [
  [/still open/i, "SO"], [/outside[- ]lane/i, "OL"], [/blind spot/i, "BS"], [/waiting[_ ]external/i, "WE"],
  [/owner decision/i, "OD"], [/items not (closed|applied)/i, "NC"], [/owner items/i, "OI"], [/still red/i, "SR"],
]
const CLOSURE_HEADINGS = /items closed|items applied|closure table|what changed/i

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}
export function digestOf(s: string): string {
  return createHash("sha1").update(normalizeText(s)).digest("hex").slice(0, 12)
}

/** Split one section body into items: each top-level bullet / numbered item (its sub-lines fold in), each free
 *  paragraph, each table data row (header + separator rows skipped). */
export function splitItems(body: string): string[] {
  const lines = body.split("\n")
  const out: string[] = []
  let cur: string | null = null
  const flush = () => { if (cur !== null && cur.trim()) out.push(cur); cur = null }
  const isSep = (l: string | undefined) => !!l && /^\|[\s:|-]+\|?\s*$/.test(l)
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (/^\s{0,1}([-*]|\d+[.)])\s+/.test(ln)) { flush(); cur = ln; continue }
    if (ln.startsWith("|")) {
      flush()
      if (isSep(ln)) continue
      if (isSep(lines[i + 1])) { i++; continue } // header row
      out.push(ln)
      continue
    }
    if (!ln.trim()) { if (cur !== null && !/^\s{0,1}([-*]|\d+[.)])\s+/.test(cur)) flush(); continue }
    if (/^#{3,}\s/.test(ln)) { flush(); continue } // sub-heading: a label, not an item
    cur = cur === null ? ln : `${cur}\n${ln}`
  }
  flush()
  return out
    .map((t) => t.replace(/^\s{0,1}([-*]|\d+[.)])\s+/, "").trim())
    .filter((t) => t && !/^[-—–]$/.test(t))
}

export function extractFromNotes(fileName: string, txt: string): { items: InventoryItem[]; closures: ClosureRecord[] } {
  const m = /lane(\d{3})([A-Z])-notes\.md$/.exec(fileName)
  if (!m) return { items: [], closures: [] }
  const wave = Number(m[1])
  const lane = m[2]
  const parts = txt.split(/^(## .*)$/m)
  const items: InventoryItem[] = []
  const closures: ClosureRecord[] = []
  const seq = new Map<SectionCode, number>()
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim()
    const body = parts[i + 1] ?? ""
    const sec = HEADING_TO_SECTION.find(([re]) => re.test(heading))?.[1]
    if (sec) {
      for (const t of splitItems(body)) {
        const n = (seq.get(sec) ?? 0) + 1
        seq.set(sec, n)
        items.push({
          id: `${wave}${lane}-${sec}-${String(n).padStart(2, "0")}`, wave, lane, section: sec,
          text: clip(normalizeText(t), 420), digest: digestOf(t), source: `lane${wave}${lane}-notes.md ${heading}`,
        })
      }
    } else if ((lane === "Z" || lane === "X") && CLOSURE_HEADINGS.test(heading)) {
      for (const t of splitItems(body)) closures.push({ wave, lane, text: clip(normalizeText(t), 600) })
    }
  }
  return { items, closures }
}

export function extractFromReport(fileName: string, txt: string): InventoryItem[] {
  const m = /WAVE(\d{3})_FINAL_REPORT\.md$/.exec(fileName)
  if (!m) return []
  const wave = Number(m[1])
  const parts = txt.split(/^(## .*)$/m)
  const items: InventoryItem[] = []
  let n = 0
  for (let i = 1; i < parts.length; i += 2) {
    if (!/^## (18|19)\./.test(parts[i].trim())) continue
    for (const t of splitItems(parts[i + 1] ?? "")) {
      n++
      items.push({
        id: `${wave}R-RP-${String(n).padStart(2, "0")}`, wave, lane: "R", section: "RP",
        text: clip(normalizeText(t), 420), digest: digestOf(t), source: `WAVE${wave}_FINAL_REPORT.md ${parts[i].trim()}`,
      })
    }
  }
  return items
}

/** one record per line — reviewable diffs, no per-key indentation */
export function serializeInventory(inv: Inventory): string {
  const lines = (xs: unknown[]) => xs.map((x) => `  ${JSON.stringify(x)}`).join(",\n")
  return `{\n "generatedFrom": ${JSON.stringify(inv.generatedFrom)},\n "items": [\n${lines(inv.items)}\n ],\n "closureRecords": [\n${lines(inv.closureRecords)}\n ]\n}\n`
}

export function extractInventory(dir: string): Inventory {
  const files = readdirSync(dir).filter((f) => /^lane14[2-7][A-Z]-notes\.md$/.test(f) || /^WAVE14[2-7]_FINAL_REPORT\.md$/.test(f)).sort()
  const items: InventoryItem[] = []
  const closureRecords: ClosureRecord[] = []
  for (const f of files) {
    const txt = readFileSync(path.join(dir, f), "utf8")
    if (f.startsWith("lane")) { const r = extractFromNotes(f, txt); items.push(...r.items); closureRecords.push(...r.closures) }
    else items.push(...extractFromReport(f, txt))
  }
  return { generatedFrom: `${files.length} files: lane14[2-7]*-notes.md + WAVE14[2-7]_FINAL_REPORT.md`, items, closureRecords }
}

function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n - 1)}…` : s }

// ── repo reads (evidence) ──────────────────────────────────────────────────────────────────────────────────────────
export interface RepoReader { read(p: string): string | null; list(dir: string): string[] }
export const fsReader: RepoReader = {
  read: (p) => { try { return readFileSync(p, "utf8") } catch { return null } },
  list: (d) => { try { return readdirSync(d) } catch { return [] } },
}
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/
const strippedCache = new Map<string, string | null>()
function codeView(reader: RepoReader, p: string): string | null {
  const key = `${reader === fsReader ? "fs" : "x"}:${p}`
  if (strippedCache.has(key)) return strippedCache.get(key)!
  const src = reader.read(p)
  const v = src === null ? null : CODE_EXT.test(p) ? stripComments(src) : src
  if (reader === fsReader) strippedCache.set(key, v)
  return v
}
const lineAt = (s: string, idx: number) => s.slice(0, idx).split("\n").length

export function migrationFile(reader: RepoReader, mig: string): string | null {
  const n = mig.replace(/^m/, "")
  const f = reader.list("supabase/migrations").find((x) => x.startsWith(`m${n}-`) || x.startsWith(`m${n}_`))
  return f ? `supabase/migrations/${f}` : null
}
/** line-1 stamp, the convention every migration reader in this repo holds (preamble wave 148) */
export function migrationApplied(reader: RepoReader, mig: string): boolean {
  const f = migrationFile(reader, mig)
  const first = f ? (reader.read(f) ?? "").split("\n")[0] : ""
  return /APPLIED LIVE/.test(first)
}
/** the first header line (≤ 8) carrying an APPLIED stamp — older migrations stamped line 2–3 */
export function migrationStampLine(reader: RepoReader, mig: string): number | null {
  const f = migrationFile(reader, mig)
  if (!f) return null
  const head = (reader.read(f) ?? "").split("\n").slice(0, 8)
  const i = head.findIndex((l) => /APPLIED LIVE/.test(l))
  return i < 0 ? null : i + 1
}

let envIndex: Map<string, string> | null = null
function walk(reader: RepoReader, dir: string, out: string[]) {
  for (const f of reader.list(dir)) {
    if (f === "node_modules" || f.startsWith(".")) continue
    const p = `${dir}/${f}`
    let isDir = false
    try { isDir = statSync(p).isDirectory() } catch { isDir = false }
    if (isDir) walk(reader, p, out)
    else if (CODE_EXT.test(f)) out.push(p)
  }
}
/** NAME → first `file:line` reading process.env.NAME in stripped lib/ app/ source */
export function envReaders(): Map<string, string> {
  if (envIndex) return envIndex
  envIndex = new Map()
  const files: string[] = []
  walk(fsReader, "lib", files)
  walk(fsReader, "app", files)
  for (const f of files.sort()) {
    const code = codeView(fsReader, f)
    if (!code) continue
    for (const m of code.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\])/g)) {
      const name = m[1] ?? m[2]
      if (!envIndex.has(name)) envIndex.set(name, `${f}:${lineAt(code, m.index ?? 0)}`)
    }
  }
  return envIndex
}

export function resolveEvidence(ev: string, reader: RepoReader = fsReader): ResolvedEvidence {
  if (ev.startsWith("mig:")) {
    const f = migrationFile(reader, ev.slice(4))
    if (!f) return { ev, ok: false, why: "migration file not found" }
    return migrationApplied(reader, ev.slice(4)) ? { ev, ok: true, at: `${f}:1` } : { ev, ok: false, why: `${f}:1 carries no APPLIED LIVE stamp` }
  }
  if (ev.startsWith("key:")) {
    const key = ev.slice(4)
    const pkg = reader.read("package.json") ?? ""
    const idx = pkg.indexOf(`"${key}":`)
    return idx < 0 ? { ev, ok: false, why: `package.json has no "${key}"` } : { ev, ok: true, at: `package.json:${lineAt(pkg, idx)}` }
  }
  if (ev.startsWith("env:")) {
    const at = reader === fsReader ? envReaders().get(ev.slice(4)) : undefined
    return at ? { ev, ok: true, at } : { ev, ok: false, why: `no stripped lib/ app/ source reads process.env.${ev.slice(4)}` }
  }
  if (ev.startsWith("chain:")) {
    // the key exists AND the guard chain runs it — the chain was GUARD_EXIT=0 at ebed6c44 (WAVE147 report §17)
    const key = ev.slice(6)
    const pkg = reader.read("package.json") ?? ""
    const guard = /"guard":\s*"([^"]*)"/.exec(pkg)?.[1] ?? ""
    const idx = pkg.indexOf(`"${key}":`)
    if (idx < 0) return { ev, ok: false, why: `package.json has no "${key}"` }
    if (!new RegExp(`npm run ${key.replace(/[:.-]/g, (c) => `\\${c}`)}(?![\\w:-])`).test(guard)) return { ev, ok: false, why: `"${key}" is not in the guard chain` }
    return { ev, ok: true, at: `package.json:${lineAt(pkg, idx)}` }
  }
  const absent = ev.startsWith("absent:")
  const raw = ev.startsWith("raw:")
  const body = absent ? ev.slice(7) : raw ? ev.slice(4) : ev
  const hash = body.indexOf("#")
  if (hash < 0) return { ev, ok: false, why: "evidence must be path#anchor, raw:, absent:, mig:, key:, chain: or env:" }
  const p = body.slice(0, hash)
  const anchor = body.slice(hash + 1)
  if (p.endsWith("/") || anchor === "") {
    // absent:<path># — the FILE is gone (a deleted duplicate; its survivor must be named beside it)
    const gone = reader.read(p.replace(/\/$/, "")) === null && reader.list(p.replace(/\/$/, "")).length === 0
    return absent && gone ? { ev, ok: true, at: `${p} (deleted)` } : { ev, ok: false, why: absent ? `${p} still exists` : "empty anchor" }
  }
  const view = raw ? reader.read(p) : codeView(reader, p)
  if (view === null) return { ev, ok: false, why: `${p} does not exist` }
  const idx = view.indexOf(anchor)
  if (absent) return idx < 0 ? { ev, ok: true, at: `${p} (no "${anchor}")` } : { ev, ok: false, why: `"${anchor}" is still in ${p}:${lineAt(view, idx)}` }
  if (idx < 0) return { ev, ok: false, why: `anchor "${anchor}" not in ${!raw && CODE_EXT.test(p) ? "stripped " : ""}${p}` }
  return { ev, ok: true, at: `${p}:${lineAt(view, idx)}` }
}

// ── classification ─────────────────────────────────────────────────────────────────────────────────────────────────
const PATH_RE = /\b((?:app|lib|scripts|supabase|docs|components|remotion|\.github)\/[\w\-./[\]@()]+?\.(?:tsx?|jsx?|sql|md|json|ya?ml))\b/g
export function citedPaths(t: string): string[] { return [...new Set([...t.matchAll(PATH_RE)].map((m) => m[1]))] }
export function citedMigrations(t: string): string[] { return [...new Set([...t.matchAll(/\bm(\d{3})\b/g)].map((m) => `m${m[1]}`))] }
export function citedKeys(t: string): string[] { return [...new Set([...t.matchAll(/\b(test:[a-z0-9][a-z0-9:-]*[a-z0-9])/g)].map((m) => m[1]))] }
const ENV_SUFFIX = /_(KEY|SECRET|TOKEN|URL|SID|ID|NUMBER|ENABLED|PASSWORD|DSN|MB|RUNNER|ORIGINS|DOMAIN|ACCOUNT|SECRET_TOKEN)$/
export function citedEnv(t: string, readers: Map<string, string>): string[] {
  return [...new Set([...t.matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1]))].filter((n) => readers.has(n) || ENV_SUFFIX.test(n) || n === "VERCEL")
}

/** wave-148 file domains (WAVE148_SPEC.md "LANES"; a named file beats a directory rule) */
const LANE_DOMAINS: Array<[RegExp, Owner]> = [
  [/^lib\/communications\/inbound-responder\.ts$/, "lane148I"],
  [/^lib\/kernel\/(completion-tracking|self-healing|healing-policy|manager-registry)\.ts$/, "lane148I"],
  [/^lib\/ads\/ad-lead-intake\.ts$/, "lane148B"],
  [/^lib\/enrichment\/(protected-research-store|customer-360)\.ts$/, "lane148C"],
  [/^lib\/buyer-search\/(persona-inference)\.ts$/, "lane148C"],
  [/^lib\/buyer-search\/conversation-criteria\.ts$/, "lane148D"],
  [/^lib\/ai-isa\/followup-arbiter\.ts$/, "lane148F"],
  [/^lib\/ai-isa\/property-lookup-rail\.ts$/, "lane148J"],
  [/^lib\/video\/video-staging\.ts$/, "lane148G"],
  [/^(\.github\/workflows\/|next\.config|vercel\.json|scripts\/production-readiness-guard\.ts|docs\/operations\/OWNER-SQL\.md|lib\/platform\/|app\/actions\/onboarding|lib\/kernel\/cron-dispatch\.ts|app\/actions\/admin\/invitations|app\/(login|auth|signup)\/)/, "lane148A"],
  [/^app\/api\/webhooks\/zoom|^lib\/open-house\/|^app\/api\/open-house\/|^app\/actions\/open-house\.ts$/, "lane148H"],
  [/^app\/api\/webhooks\//, "lane148A"],
  [/^(lib\/contact-pipeline\/|lib\/kernel\/compliance\/require-contact-consent\.ts|app\/actions\/(seller-open-house|open-house-kernel|home-value|agent-public-profile)\.ts|lib\/kernel\/(open-house|listings|lead-magnets)\.ts|lib\/application\/lead-application-service\.ts|app\/api\/widget\/|app\/embed\/|lib\/voice\/sms-inbound\.ts|lib\/communications\/|app\/api\/sms\/|lib\/ai-isa\/opt-out-writer\.ts|app\/actions\/ai-isa\/process-opt-out\.ts)/, "lane148B"],
  [/^(lib\/ads\/|lib\/compliance-rules\/)/, "lane148C"],
  [/^(lib\/voice-admin\/|app\/actions\/portal-nl-search\.ts|lib\/buyer-execution\/voice-assistant-integration\.ts|lib\/copilot)/, "lane148D"],
  [/^(lib\/buyer-search\/|app\/actions\/buyer-search\/|lib\/property\/(rentcast|external-listings-search)|lib\/idx|lib\/mapbox|lib\/geo)/, "lane148E"],
  [/^(lib\/intent\/|lib\/enrichment\/|lib\/external\/socrata-market-registry\.ts)/, "lane148F"],
  [/^(lib\/lead-magnets\/|lib\/market-reports\/|app\/components\/features\/lead-magnets\/|app\/actions\/lead-magnets|lib\/website|lib\/landing)/, "lane148G"],
  [/^(lib\/transactions\/|lib\/listings\/|app\/actions\/listings\.ts|lib\/support\/)/, "lane148I"],
  [/^(docs\/commercial\/|lib\/providers\/|lib\/direct-mail)/, "lane148J"],
  [/^(package\.json|scripts\/(schema-snapshot|schema-fk-map|check-vocabularies|live-tables|agent-fk-columns)\.ts|supabase\/migrations\/)/, "integrator"],
]
export function ownerLaneFor(paths: string[]): Owner {
  for (const p of paths) for (const [re, o] of LANE_DOMAINS) if (re.test(p)) return o
  return "lane148Z"
}

export const LAUNCH_CRITICAL_RE =
  /\b(security|IDOR|cross-tenant|foreign-tenant|injection|leak|exposed?|storage\.objects|m855|m875|seed account|portal-contact|consent|TCPA|STOP\b|opt-?out|unsubscribe|suppression|billing|invoice|payout|provision|onboard|invite|login|signature|PII|protected attribute|fair housing|RELEASE[- ]BLOCK|release-blocking)/i

/** Legend for rule-derived reasons; rows print the code, the doc prints the legend once. */
export const REASON_LEGEND: Record<string, string> = {
  NONE: "The lane recorded nothing open in this section.",
  WE_CRED: "External credential named by VARIABLE only; the owner provides it (wave-148 ruling: no keys, no purchases, no env changes). The proof column shows where the runtime reads the name.",
  WE_LIC: "A licence / order form / provider terms decision — owner + counsel; nothing is built or bought until it is signed.",
  WE_DEPLOY: "Observable only on a Vercel deployment (Workflow timer, live soak) — owner deploys; the cron net covers locally.",
  WE_OTHER: "External dependency recorded by the lane; owner-provided configuration, never a code defect.",
  OWNER_SQL: "Owner SQL-editor work (storage.objects policies / seed rows / DROP) — release-blocking where stated; the code side is finished.",
  BS_MEM: "Runtime proofs run on memSupabase (no RLS, CHECK, FK or trigger). The database-side refusal is each migration's VERIFY block, applied live by the integrator; the integrated chain (GUARD_EXIT=0) is the live gate.",
  BS_STATIC: "A static census reads stripped source: each finder carries a positive control, and a semantically equivalent shape outside its pattern stays unseen. Inherent to static measurement.",
  BS_MODEL: "No model call runs inside a proof (no key); deterministic validators gate model output and prompts are checked structurally. Live model behaviour is measured once credentials exist.",
  BS_LIVE: "Not exercised live: needs provider credentials, the live app or a deployment (owner). Seams stand in and each seam's own proof covers it.",
  BS_BROWSER: "Browser smoke needs the Supabase keys the owner withholds; static render + axe-core stand in.",
  BS_SCOPE: "A scoping statement about what the lane measured (worktree, base, scoped tsc, run set) — superseded by the integrated gate of its wave (sweep + whole-project tsc + GUARD_EXIT=0).",
  BS_OTHER: "A published limit of the lane's own measurement; no later wave recorded closing it. Carried as stated in the source text.",
  CHORE_MIG: "Integrator chore — the named migrations carry the APPLIED LIVE stamp on line 1.",
  CHORE_KEYS: "Integrator chore — the named package keys exist in package.json.",
  CHORE_GATE: "A red guard recorded at its wave; every guard it names is in the `npm run guard` chain, which ran GUARD_EXIT=0 at ebed6c44 (wave-147 report §17).",
  UNVERIFIED: "Recorded open at its wave; the ledger found no closure evidence (no manual disposition, no convergence match). Handed to the wave-148 lane that owns the cited file (lane148Z = no lane owns it).",
}

function ruleDisposition(it: InventoryItem, readers: Map<string, string>, closures: ClosureRecord[]): { d: Disposition; basis: string } {
  const t = it.text
  const migs = citedMigrations(t)
  const keys = citedKeys(t)
  const paths = citedPaths(t)
  // R1 — nothing recorded
  if (/^\W*(none|nothing|no (new )?(env var|credential|external|other external|vendor)|no other external)\b/i.test(t) && migs.length === 0 && citedEnv(t, readers).filter((n) => readers.has(n)).length === 0 && t.length < 260)
    return { d: { s: "none-recorded", r: "[NONE]" }, basis: "rule:none" }
  // R2 — migration chore: every named migration (outside the owner's storage SQL) applied
  const storageOwnerSql = /m855|m875|storage\.objects|OWNER-SQL/i.test(t)
  if (!storageOwnerSql && migs.length > 0 && /\bapply|\bapplied|not applied|must be APPLIED/i.test(t) && t.length < 720 && migs.every((m) => migrationFile(fsReader, m))) {
    const allApplied = migs.every((m) => migrationApplied(fsReader, m))
    const keyOk = keys.every((k) => resolveEvidence(`key:${k}`).ok)
    if (allApplied && keyOk && !/\b(replace|build|wire|delete|add (a|an|the|one)|insert)\b/i.test(t.replace(/regenerat\w+/gi, "")))
      return { d: { s: "closed", e: [...migs.map((m) => `mig:${m}`), ...keys.map((k) => `key:${k}`)], by: "integrator (Supabase MCP apply)", r: "[CHORE_MIG]" }, basis: "rule:migration-applied" }
  }
  // R3 — key/registry chore
  if (keys.length > 0 && /^(\**)?(lane \d{0,3}I\b|lane I\b|package\.json|integrator|I:|keys?)/i.test(t) && keys.every((k) => resolveEvidence(`key:${k}`).ok) && !/\b(replace|build|wire|delete|insert)\b/i.test(t))
    return { d: { s: "closed", e: keys.map((k) => `key:${k}`), by: "registry/keys lane (I) of the wave", r: "[CHORE_KEYS]" }, basis: "rule:keys-present" }
  // R3b — "guard X is red until …": every named guard key is in the chain, which was GUARD_EXIT=0 at ebed6c44
  if ((it.section === "SO" || it.section === "SR" || it.section === "NC" || it.section === "OL") && keys.length > 0 &&
    /\bred\b|✗|fails?\b|failed|turns? .{0,40}green|ERR_MODULE_NOT_FOUND|\d+\/[1-9]\d*\b/i.test(t) && keys.every((k) => resolveEvidence(`chain:${k}`).ok) &&
    !/\b(build|wire|insert)\b/i.test(t))
    return { d: { s: "closed", e: keys.map((k) => `chain:${k}`), by: "integrated gate — the chain ran GUARD_EXIT=0 at ebed6c44", r: "[CHORE_GATE]" }, basis: "rule:guard-green-in-chain" }
  // R4 — convergence match (wave N's Z/X lane recorded a closure citing the same file and the same identifier)
  if (it.section === "OL" || it.section === "SO") {
    const m = convergenceMatch(it, closures)
    if (m) return { d: { s: "closed", e: [m], by: `wave ${it.wave} convergence (lane ${it.wave}Z/X closure record)` }, basis: "auto:convergence-match" }
  }
  // R5 — WAITING_EXTERNAL / owner records
  if (it.section === "WE" || it.section === "OD" || it.section === "OI" || it.section === "RP") {
    const env = citedEnv(t, readers)
    const proof = env.filter((n) => readers.has(n)).slice(0, 4).map((n) => `env:${n}`)
    if (storageOwnerSql || /seed account|portal-contact|§I\b/i.test(t)) return { d: { s: "carried", k: "owner-sql", o: "owner", r: "[OWNER_SQL]", e: proof }, basis: "rule:owner-sql" }
    if (/licen[cs]|order form|ToS|terms|PAF|counsel|enterprise/i.test(t)) return { d: { s: "carried", k: "licensing", o: "owner", r: "[WE_LIC]", e: proof }, basis: "rule:licensing" }
    if (/\bdecid|decision|owner question|to confirm|whether/i.test(t) && it.section !== "WE") return { d: { s: "carried", k: "owner-decision", o: "owner", r: "Owner decision recorded by the lane; the code holds the conservative (fail-closed) reading until ruled. Wave-148 ruling 22 adopts every recorded recommendation — see the manual rows for the 147Z decisions." }, basis: "rule:owner-decision" }
    if (/Vercel|soak|deployment|Workflow/i.test(t)) return { d: { s: "carried", k: "missing-credentials", o: "owner", r: "[WE_DEPLOY]", e: proof }, basis: "rule:deploy" }
    if (env.length > 0) return { d: { s: "carried", k: "missing-credentials", o: "owner", r: "[WE_CRED]", e: proof }, basis: "rule:credential" }
    return { d: { s: "carried", k: "missing-credentials", o: "owner", r: "[WE_OTHER]", e: proof }, basis: "rule:external" }
  }
  // R6 — blind spots
  if (it.section === "BS") {
    const code =
      /memSupabase|in-memory|no RLS|no CHECK|trigger|PostgREST/i.test(t) ? "BS_MEM"
        : /browser|axe|visual|smoke|render(ed)? in/i.test(t) ? "BS_BROWSER"
          : /\bmodel\b|prompt|LLM|classifier|narration/i.test(t) ? "BS_MODEL"
            : /live|provider|vendor|webhook|soak|Vercel|credential|no key/i.test(t) ? "BS_LIVE"
              : /worktree|scoped tsc|\bbase\b|ran (the|only)|waypoint/i.test(t) ? "BS_SCOPE"
                : /strip|regex|static|census|lexical|text\b|literal|heuristic|pattern|token/i.test(t) ? "BS_STATIC" : "BS_OTHER"
    const owner: Owner = code === "BS_MEM" ? "integrator" : code === "BS_LIVE" || code === "BS_BROWSER" || code === "BS_MODEL" ? "owner" : "inherent"
    return { d: { s: "carried", k: "inherent-limit", o: owner, r: `[${code}]` }, basis: `rule:${code.toLowerCase()}` }
  }
  // R7 — default: recorded open, no evidence found
  if (storageOwnerSql) return { d: { s: "carried", k: "owner-sql", o: "owner", r: "[OWNER_SQL]" }, basis: "rule:owner-sql" }
  return { d: { s: "carried", k: "unverified", o: ownerLaneFor(paths), r: "[UNVERIFIED]" }, basis: "default:unverified" }
}

const HUB_FILES = /manager-registry\.ts|package\.json|production-readiness-guard\.ts|orphan-export-baseline|\.md$|schema-snapshot|check-vocabularies|live-tables/
const ident = (t: string) => new Set([...t.matchAll(/`([A-Za-z_$][\w$]{5,})(?:\(\))?`|\b([a-z]+[A-Z][\w$]{3,})\b/g)].map((m) => m[1] ?? m[2]))
export function convergenceMatch(it: InventoryItem, closures: ClosureRecord[]): string | null {
  const files = citedPaths(it.text).filter((p) => !HUB_FILES.test(p))
  if (!files.length) return null
  const mine = ident(it.text)
  for (const c of closures) {
    if (c.wave < it.wave || c.wave > it.wave + 1) continue // the same wave's convergence, or the next wave's (wave 143 had no Z lane; 144X carried its items)
    const theirs = citedPaths(c.text)
    for (const f of files) {
      if (!theirs.includes(f)) continue
      const view = codeView(fsReader, f)
      if (!view) continue
      for (const id of ident(c.text)) if (mine.has(id) && view.includes(id)) return `${f}#${id}`
    }
  }
  return null
}

// ── capability-surface rows (derived from the generated audit doc on every run) ────────────────────────────────────
export function capabilitySurfaceItems(reader: RepoReader = fsReader): InventoryItem[] {
  const doc = reader.read(CAPABILITY_AUDIT_PATH) ?? ""
  const items: InventoryItem[] = []
  const seen = new Set<string>()
  const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60)
  for (const line of doc.split("\n")) {
    const partial = /^\| [^|]+ \| [^|]+ \| ([^|]+) \| `([^`]+)` \| PARTIAL \| says "([^"]+)" \(`([^`]+)` — ([^)]+)\) \|$/.exec(line)
    if (partial) {
      const site = partial[4]
      if (seen.has(site)) continue
      seen.add(site)
      const text = `PARTIAL screen ${partial[1].trim()} (${partial[2]}) says "${partial[3]}" at ${site} — ${partial[5]}`
      items.push({ id: `CS-P-${slug(site)}`, wave: 147, lane: "H", section: "CS", text, digest: digestOf(text), source: `${CAPABILITY_AUDIT_PATH} Not BUILT` })
      continue
    }
    const unsup = /^\| `([^`]+)` \| ([^|]+) \| [^|]+ \| ([^|]+) \| unsupported\/deferred \| [^|]+ \| ([^|]+) \| ([^|]+) \|$/.exec(line)
    if (unsup) {
      const text = `UNSUPPORTED/DEFERRED ${unsup[1]}:${unsup[2].trim()} "${unsup[3].trim()}" — ${unsup[4].trim()}`
      items.push({ id: `CS-U-${slug(unsup[1])}`, wave: 147, lane: "H", section: "CS", text, digest: digestOf(text), source: `${CAPABILITY_AUDIT_PATH} Every remaining sentence` })
      continue
    }
    const mig = /^\| `([^`]+)` \| (m\d{3}) \| written \|$/.exec(line)
    if (mig) {
      const text = `Migration-gated fallback at ${mig[1]} names ${mig[2]}, which the audit reads as WRITTEN`
      items.push({ id: `CS-M-${mig[2]}`, wave: 147, lane: "H", section: "CS", text, digest: digestOf(text), source: `${CAPABILITY_AUDIT_PATH} Migration-gated fallbacks` })
    }
  }
  return items
}
function capabilityDisposition(it: InventoryItem, readers: Map<string, string>): { d: Disposition; basis: string } {
  if (it.id.startsWith("CS-U-")) return { d: { s: "carried", k: "deferred", o: "owner", r: "No processing backend / adapter exists; the surface refuses honestly and names what works. Building it is a provider choice (owner) — nothing is claimed." }, basis: "rule:cs-unsupported" }
  if (it.id.startsWith("CS-M-")) {
    const m = it.id.slice(5)
    const line = migrationStampLine(fsReader, m)
    if (line && line > 1) return { d: { s: "carried", k: "inherent-limit", o: "integrator", e: [`${migrationFile(fsReader, m)}#APPLIED LIVE`], r: `Applied — the APPLIED LIVE stamp sits on header line ${line}, not line 1 (older convention), so line-1 readers report it written. Integrator: move the stamp to line 1 (no SQL change).` }, basis: "rule:cs-stamp-line" }
    return { d: { s: "carried", k: "owner-sql", o: "integrator", r: "The migration carries no APPLIED stamp on any header line: the integrator verifies it live (to_regclass / information_schema) and stamps or applies it." }, basis: "rule:cs-unstamped" }
  }
  const env = citedEnv(it.text, readers).filter((n) => readers.has(n)).map((n) => `env:${n}`)
  const tenantGuard = /fail-closed tenant guard/i.test(it.text)
  return {
    d: {
      s: "carried", k: tenantGuard ? "owner-decision" : "missing-credentials", o: "owner", e: env,
      r: tenantGuard ? "Fail-closed tenant guard: the seat has no users.brokerage_id — the tenant admin attaches the seat (configuration, not code)." : "Implemented; waits on owner/tenant configuration (credential or connection) named in the audit row — the screen says so honestly.",
    },
    basis: "rule:cs-partial",
  }
}

// ── build rows ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function loadInventory(reader: RepoReader = fsReader): Inventory {
  const raw = reader.read(INVENTORY_PATH)
  if (!raw) throw new Error(`${INVENTORY_PATH} missing — run --extract <notesDir>`)
  return JSON.parse(raw) as Inventory
}

export function buildRows(inv: Inventory, manual: Record<string, Disposition> = MANUAL_DISPOSITIONS): Row[] {
  const readers = envReaders()
  const rows: Row[] = []
  for (const it of [...inv.items, ...capabilitySurfaceItems()]) {
    const m = manual[it.id]
    const { d, basis } = m ? { d: m, basis: "manual" } : it.section === "CS" ? capabilityDisposition(it, readers) : ruleDisposition(it, readers, inv.closureRecords)
    const resolved = (d.e ?? []).map((e) => resolveEvidence(e))
    const launchCritical = d.lc ?? (LAUNCH_CRITICAL_RE.test(it.text) && d.s !== "none-recorded" && it.section !== "BS")
    rows.push({ ...it, d, basis, launchCritical, resolved })
  }
  const secOrder = Object.keys(SECTION_CODES)
  return rows.sort((a, b) =>
    Number(b.launchCritical) - Number(a.launchCritical) || a.wave - b.wave || a.lane.localeCompare(b.lane) ||
    secOrder.indexOf(a.section) - secOrder.indexOf(b.section) || a.id.localeCompare(b.id))
}

// ── validation (the guard's rule set, exported so controls can feed it fixtures) ───────────────────────────────────
/** what a "nothing open" item says — the only text `none-recorded` may sit on */
export const NONE_RECORDED_RE = /^\W*(none|nothing|no )|\bno change needed\b/i
export function validateRow(r: Pick<Row, "id" | "text" | "d" | "resolved">): string[] {
  const out: string[] = []
  const { d } = r
  if (!STATUSES.includes(d.s)) out.push(`${r.id}: status "${d.s}" outside ${STATUSES.join("/")}`)
  if (d.s === "closed") {
    if (!d.e?.length) out.push(`${r.id}: closed with no evidence`)
    for (const x of r.resolved) if (!x.ok) out.push(`${r.id}: evidence ${x.ev} does not resolve — ${x.why}`)
    if (r.resolved.length && r.resolved.every((x) => x.ev.startsWith("env:"))) out.push(`${r.id}: an env reader proves a name is real, never that a loop closed`)
    if (r.resolved.some((x) => x.ev.startsWith("absent:")) && !r.resolved.some((x) => !x.ev.startsWith("absent:") && !x.ev.startsWith("env:")))
      out.push(`${r.id}: an absence proof must name its survivor (CLAUDE.md §1 — every deletion names its survivor)`)
  }
  if (d.s === "carried") {
    const reason = d.r ?? ""
    const legend = /^\[([A-Z_]+)\]$/.exec(reason)
    if (legend ? !REASON_LEGEND[legend[1]] : reason.trim().length < 24) out.push(`${r.id}: carried without a reason`)
    if (!d.k || !CARRY_KINDS.includes(d.k)) out.push(`${r.id}: carried kind "${d.k}" outside the vocabulary`)
    if (!d.o || !OWNERS.includes(d.o)) out.push(`${r.id}: owner "${d.o}" outside the vocabulary`)
    for (const x of r.resolved) if (!x.ok) out.push(`${r.id}: proof ${x.ev} does not resolve — ${x.why}`)
  }
  if (d.s === "none-recorded" && !NONE_RECORDED_RE.test(r.text)) out.push(`${r.id}: none-recorded on an item that records something`)
  return out
}

// ── render ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
function statusCell(r: Row): string {
  if (r.d.s === "closed") return `**closed** by ${r.resolved.map((x) => (x.ok ? `\`${x.at}\`` : `✗${x.ev}`)).join(", ")}${r.d.by ? ` — ${r.d.by}` : ""}`
  if (r.d.s === "none-recorded") return "none recorded"
  return `carried · ${r.d.k} · ${r.d.o}`
}
function proofCell(r: Row): string {
  const reason = r.d.r ?? ""
  const proofs = r.d.s === "carried" ? r.resolved.filter((x) => x.ok).map((x) => `\`${x.at}\``).join(", ") : ""
  return [reason, proofs && `reads: ${proofs}`].filter(Boolean).join(" ")
}

export function summarize(rows: Row[]) {
  const by = (f: (r: Row) => string) => rows.reduce<Record<string, number>>((a, r) => ((a[f(r)] = (a[f(r)] ?? 0) + 1), a), {})
  return {
    total: rows.length,
    byStatus: by((r) => r.d.s),
    byKind: by((r) => (r.d.s === "carried" ? r.d.k ?? "?" : r.d.s)),
    byWave: by((r) => `${r.wave}`),
    byWaveStatus: by((r) => `${r.wave}:${r.d.s}`),
    bySection: by((r) => r.section),
    byOwner: by((r) => (r.d.s === "carried" ? r.d.o ?? "?" : "-")),
    byBasis: by((r) => r.basis.split(":")[0]),
    launchCritical: rows.filter((r) => r.launchCritical).length,
    launchCriticalOpen: rows.filter((r) => r.launchCritical && r.d.s === "carried").length,
  }
}

export function renderLedger(inv: Inventory, rows: Row[]): string {
  const s = summarize(rows)
  const tbl = (o: Record<string, number>) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(" · ")
  const waves = [...new Set(rows.map((r) => r.wave))].sort()
  const credTable = credentialTable()
  const out: string[] = [
    "# Open-loop ledger — waves 142–147 (every Still open · Outside-lane · Blind spot · WAITING_EXTERNAL · owner record)",
    "",
    "<!-- GENERATED by `npx tsx scripts/open-loop-ledger.ts --write` (wave 148, lane 148K). Do not hand-edit: `test:open-loop-ledger` fails when this file disagrees with the derivation. Inventory: docs/operations/open-loop-ledger-inventory.json (extracted from the lane notes); dispositions: scripts/open-loop-ledger-dispositions.ts + the rules in scripts/open-loop-ledger.ts. -->",
    "",
    `Owner rulings 18 + 23 (2026-11-01). Source: ${inv.generatedFrom} (no lane142 notes exist — wave 142 recorded none in this form) + the capability-surface audit's PARTIAL / unsupported / migration-gated rows, derived live.`,
    "",
    `**Totals:** ${s.total} items · ${tbl(s.byStatus)}. Launch-critical ${s.launchCritical} (still carried ${s.launchCriticalOpen}) — listed first.`,
    "",
    `**Carried by kind:** ${tbl(Object.fromEntries(Object.entries(s.byKind).filter(([k]) => k !== "closed" && k !== "none-recorded")))}.`,
    "",
    `**Carried by owner:** ${tbl(Object.fromEntries(Object.entries(s.byOwner).filter(([k]) => k !== "-")))}.`,
    "",
    `**Basis:** ${tbl(s.byBasis)} (manual = verified by the 148K audit; rule = derived from the repo on every run; auto = a convergence lane's closure record citing the same file and identifier; default = no evidence found).`,
    "",
    "| wave | items | closed | carried | none recorded |",
    "|---|---|---|---|---|",
    ...waves.map((w) => `| ${w} | ${s.byWave[w] ?? 0} | ${s.byWaveStatus[`${w}:closed`] ?? 0} | ${s.byWaveStatus[`${w}:carried`] ?? 0} | ${s.byWaveStatus[`${w}:none-recorded`] ?? 0} |`),
    "",
    "**Status vocabulary.** `closed` — a proof the generator re-derives every run (`path:line` found in STRIPPED source, a migration's line-1 APPLIED LIVE stamp, or a package key). `carried · <kind> · <owner>` — not closed, with the reason and who holds it; kinds: missing-code · missing-wiring · missing-credentials · licensing · deferred · owner-decision · owner-sql · inherent-limit · handed-to-lane · unverified. `none recorded` — the lane wrote that nothing was open.",
    "",
    "## Reason legend",
    "",
    "| code | reason |",
    "|---|---|",
    ...Object.entries(REASON_LEGEND).map(([k, v]) => `| [${k}] | ${cell(v)} |`),
    "",
    "## Unavailable features by missing credential (derived from the capability-surface audit's classified sentences)",
    "",
    "| variable | refusals it unlocks | read at |",
    "|---|---|---|",
    ...credTable.map((c) => `| \`${c.name}\` | ${c.count} | ${c.at ? `\`${c.at}\`` : "not read by lib/ app/ (named only)"} |`),
    "",
    "## Ledger",
    "",
    "| id | wave · lane · section | item | status | reason / proof |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.launchCritical ? "**" + r.id + "**" : r.id} | ${r.wave} · ${r.lane} · ${r.section} | ${cell(clip(r.text, 170))} | ${cell(statusCell(r))} | ${cell(proofCell(r))} |`),
    "",
  ]
  return out.join("\n")
}

export function credentialTable(): Array<{ name: string; count: number; at?: string }> {
  const doc = fsReader.read(CAPABILITY_AUDIT_PATH) ?? ""
  const readers = envReaders()
  const counts = new Map<string, number>()
  for (const line of doc.split("\n")) {
    const m = /^\| `[^`]+` \| ([^|]+) \| [^|]+ \| [^|]+ \| implemented-missing-owner-config \| [^|]+ \| ([^|]+) \|/.exec(line)
    if (!m) continue
    const sites = m[1].split(",").length
    for (const n of new Set([...m[2].matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g)].map((x) => x[1]))) counts.set(n, (counts.get(n) ?? 0) + sites)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count, at: readers.get(name) }))
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (typeof process !== "undefined" && /open-loop-ledger\.ts$/.test(process.argv[1] ?? "")) {
  const args = process.argv.slice(2)
  const ex = args.indexOf("--extract")
  if (ex >= 0) {
    const dir = args[ex + 1]
    if (!dir || !existsSync(dir)) { console.error("usage: --extract <notesDir>"); process.exit(2) }
    const inv = extractInventory(dir)
    writeFileSync(INVENTORY_PATH, serializeInventory(inv))
    console.log(`extracted ${inv.items.length} items + ${inv.closureRecords.length} closure records → ${INVENTORY_PATH}`)
  } else {
    const inv = loadInventory()
    const rows = buildRows(inv)
    const s = summarize(rows)
    const problems = rows.flatMap((r) => validateRow(r))
    if (args.includes("--write")) writeFileSync(LEDGER_PATH, renderLedger(inv, rows))
    console.log(JSON.stringify(s, null, 1))
    for (const p of problems.slice(0, 60)) console.log(`  ✗ ${p}`)
    console.log(`LEDGER: ${s.total} items, ${problems.length} problems${args.includes("--write") ? ` → ${LEDGER_PATH}` : ""}`)
    if (problems.length) process.exitCode = 1
  }
}
