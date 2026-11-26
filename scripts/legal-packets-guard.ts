#!/usr/bin/env tsx
/**
 * scripts/legal-packets-guard.ts   (wave 151, lane 151A2 — npm run test:legal-packets)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEGAL DRAFTS ARE REVIEWABLE FILES WHOSE STATEMENTS ABOUT THE CODE MUST STAY TRUE.
 *
 *   docs/legal/PACKET-1 … PACKET-6   the six agreement / schedule drafts
 *   docs/operations/LEGAL-REVIEW-PACKET.md   the owner / attorney delivery packet
 *
 * What this guard holds (each with a POSITIVE CONTROL — CLAUDE.md §2):
 *   A. every packet file exists and is SUBSTANTIVE: its required sections are present and its word count is
 *      above a stated floor;
 *   B. the DRAFT banner is on lines 1–3 of every file under docs/legal and of the review packet — a draft can
 *      never be published silently as enforceable terms (directive: "Never silently publish drafts");
 *   C. no PRICE LITERAL appears anywhere in those files — `$` followed by a digit, "per month", "/mo" — a price
 *      lives only in the administered catalog and in these documents only as a `[[PRICE_*]]` variable;
 *   D. no British "licence" spelling appears (owner rule: LICENSE, never licence);
 *   E. no model name or model id appears (owner rule: none in any repo file) — the drafts name vendors only;
 *   F. every `[[VARIABLE]]` a file uses is listed in that file's Variables table (no silent placeholder);
 *   G. every cited `path/to/file.ts::symbol` resolves: the file exists in the tree and the symbol is DEFINED in
 *      it, read from COMMENT-STRIPPED source (a tombstone is not a definition) — so Packet 2's authority map
 *      cannot outlive the gate it describes;
 *   H. the subprocessor tables in Packet 4 name only providers present in the code's OWN registries (tenancy
 *      matrix, connector registry, route table + activation state, webhook contract, connection scope, provider
 *      catalog, plus the two hosting primitives the tree declares) — never a vendor the code does not use.
 *
 * WORD-COUNT FLOORS, justified: each floor is set at roughly four fifths of the first complete draft's length,
 * so an editing pass (tightening, counsel's redlines) passes while a gutting edit — replacing a clause set with
 * an outline, a one-page template or a list of future documents — fails. Below the floor the required section
 * list cannot be filled with full clauses (at ~150 words per required section the floor is already the minimum).
 *
 * BLIND SPOTS, published beside the number:
 *   · a citation written without backticks or with a different separator than `::` is not seen;
 *   · a symbol check proves the name is DEFINED in the file, not that the clause describing it is still true;
 *   · a price written in words ("forty-nine dollars") is not a literal this guard recognises;
 *   · the registry union is built by regex over the registries' source, so a provider declared in a shape none of
 *     the six extractors reads (a computed key, a spread) is invisible to arm H — such a provider would be
 *     REFUSED from the subprocessor list, which is the safe direction;
 *   · the model-name pattern is a short list of vendor families; a new family must be added by hand.
 *
 * Reads STRIPPED source only (scripts/strip-comments.ts). Never a hand-rolled stripper.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const rd = (p: string): string => readFileSync(join(ROOT, p), "utf8")
const has = (p: string): boolean => existsSync(join(ROOT, p))

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CORPUS
// ═════════════════════════════════════════════════════════════════════════════

const DRAFT_BANNER = "DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE"
const LEGAL_DIR = "docs/legal"
const REVIEW_PACKET = "docs/operations/LEGAL-REVIEW-PACKET.md"

interface PacketSpec {
  file: string
  label: string
  /** Minimum word count (see the header for the justification). */
  minWords: number
  /** Required section headings — each must appear as a `#`, `##` or `###` heading (case-insensitive substring). */
  sections: readonly string[]
}

const PACKETS: readonly PacketSpec[] = [
  {
    file: `${LEGAL_DIR}/PACKET-1-PLATFORM-SUBSCRIPTION-AND-SERVICES-AGREEMENT.md`,
    label: "Packet 1 — Platform Subscription and Services Agreement",
    minWords: 5500,
    sections: [
      "Definitions", "The Service", "Authorized Users", "Tiers, Capacity and Seats", "Fees, Billing, Renewal and Suspension",
      "Subscriber Responsibilities", "Platform Responsibilities", "Autonomous Operations and Human Approval",
      "Subscriber Content, Data Ownership", "Intellectual Property", "Third-Party Providers", "Confidentiality, Security",
      "Notices, Retention, Export and Deletion", "Term and Renewal", "Termination", "Representations and Warranties",
      "Disclaimers", "Limitation of Liability", "Indemnification", "Dispute Resolution and Governing Law",
      "Order of Precedence", "Acceptance and Signatures",
    ],
  },
  {
    file: `${LEGAL_DIR}/PACKET-2-AUTONOMOUS-AI-OPERATIONS-AND-AUTHORITY-SCHEDULE.md`,
    label: "Packet 2 — Autonomous AI Operations and Authority Schedule",
    minWords: 3000,
    sections: [
      "Purpose and principles", "AI Managers and their domains", "Tool risk classes", "authority ladder",
      "Autonomous communications", "Generated copy, estimates and decision windows", "Spending and financial approval",
      "Transactions, signatures and sensitive communications", "Kill switches, halts and user overrides",
      "Event and action evidence", "Self-healing", "Model and Provider limitations", "Incident escalation and change notification",
    ],
  },
  {
    file: `${LEGAL_DIR}/PACKET-3-ACQUISITION-ENRICHMENT-DATA-RIGHTS-AND-INTEGRATION-SCHEDULE.md`,
    label: "Packet 3 — Acquisition, Enrichment, Data Rights and Third-Party Integration Schedule",
    minWords: 3000,
    sections: [
      "included subscription capability", "acquisition lifecycle", "Providers: who owns, who pays",
      "Source licensing, permitted collection", "Legal basis, notice and consent", "Accuracy, freshness and duplicates",
      "Source retention and deletion", "Contact and suppression rules", "Data-subject requests", "Permitted visibility",
      "Provider unavailability and disconnection", "No guaranteed number or quality of leads",
    ],
  },
  {
    file: `${LEGAL_DIR}/PACKET-4-PRIVACY-NOTICE-DPA-AND-SUBPROCESSORS.md`,
    label: "Packet 4 — Privacy Notice, DPA and Subprocessors",
    minWords: 3500,
    sections: [
      "Privacy Notice", "Data Processing Addendum", "Subprocessors", "AI processing", "Retention and deletion",
      "Cross-tenant isolation", "Security incident handling", "Consumer requests and export",
    ],
  },
  {
    file: `${LEGAL_DIR}/PACKET-5-ACCEPTABLE-USE-AND-MARKETING-COMPLIANCE.md`,
    label: "Packet 5 — Acceptable Use and Marketing Compliance",
    minWords: 2500,
    sections: [
      "Scope and responsibility", "Account and access rules", "Source use", "Marketing communications",
      "Housing advertising delivery and fair housing", "Content accuracy", "Listing photographs, IDX and MLS",
      "Provider terms and connected accounts", "Enforcement",
    ],
  },
  {
    file: `${LEGAL_DIR}/PACKET-6-TENANT-OWNED-PROVIDER-CONNECTION-SCHEDULE.md`,
    label: "Packet 6 — Tenant-Owned Provider Connection Schedule",
    minWords: 2000,
    sections: [
      "Purpose and the two ownership models", "connection record", "General terms applying to every connection",
      "Per-provider variations", "Configuration and acceptance records", "Disconnect, rotation and offboarding",
    ],
  },
  {
    file: REVIEW_PACKET,
    label: "Owner / attorney review packet",
    minWords: 2500,
    sections: [
      "Cover memorandum", "owner decision table", "Unanswered legal and commercial placeholders", "State-specific review checklist",
      "Data-rights and autonomous-authority risk summary", "Document versions and redline ledger", "Approved versus draft status",
      "Sign-off sheet", "Publication and acceptance procedure", "Example tenant-facing packet",
    ],
  },
]

/** Every Markdown file under docs/legal plus the review packet — the banner / price / spelling / model rules apply to all. */
function legalCorpus(): string[] {
  const out: string[] = []
  if (has(LEGAL_DIR)) for (const f of readdirSync(join(ROOT, LEGAL_DIR)).sort()) if (f.endsWith(".md")) out.push(`${LEGAL_DIR}/${f}`)
  if (has(REVIEW_PACKET)) out.push(REVIEW_PACKET)
  return out
}

// ═════════════════════════════════════════════════════════════════════════════
// PURE FINDERS (each has a positive control in section P)
// ═════════════════════════════════════════════════════════════════════════════

/** The banner must sit on one of the first three lines. */
function bannerOnFirstLines(text: string): boolean {
  return text.split("\n").slice(0, 3).some((l) => l.includes(DRAFT_BANNER))
}

/** A `Version:` line within the first fifteen lines. */
function hasVersionLine(text: string): boolean {
  return text.split("\n").slice(0, 15).some((l) => /^Version:\s*\S+/.test(l))
}

/** Price literals: `$` followed by a digit, "per month" (any case, space or hyphen), "/mo" as a unit. */
function priceLiterals(text: string): string[] {
  const out: string[] = []
  const lines = text.split("\n")
  lines.forEach((l, i) => {
    for (const re of [/\$\d/g, /\bper[\s-]month\b/gi, /\/mo\b/gi]) {
      let m: RegExpExecArray | null
      re.lastIndex = 0
      while ((m = re.exec(l)) !== null) out.push(`line ${i + 1}: …${l.slice(Math.max(0, m.index - 20), m.index + 24)}…`)
    }
  })
  return out
}

/** British spellings of license (licence / licences / licenced / licencing). */
function licenceSpellings(text: string): string[] {
  const out: string[] = []
  text.split("\n").forEach((l, i) => { if (/licenc/i.test(l)) out.push(`line ${i + 1}: ${l.trim().slice(0, 100)}`) })
  return out
}

/** Model names / ids. Vendor COMPANY names are allowed; model families are not. */
// The family tokens are ASSEMBLED from fragments so this file itself carries no model name (owner rule: none in any
// repo file — a guard that hunts them must not be the one place they are written).
const MODEL_FAMILY_FRAGMENTS: readonly (readonly string[])[] = [
  ["cla", "ude"], ["gpt-?\\d"], ["gpt-?[45]o"], ["gem", "ini"], ["son", "net"], ["op", "us"], ["hai", "ku"],
  ["lla", "ma"], ["mis", "tral"], ["gr", "ok"], ["o[134]-mini"], ["so", "nar"],
]
const MODEL_NAME_RE = new RegExp(`\\b(${MODEL_FAMILY_FRAGMENTS.map((f) => f.join("")).join("|")})\\b`, "i")
function modelNames(text: string): string[] {
  const out: string[] = []
  text.split("\n").forEach((l, i) => { const m = MODEL_NAME_RE.exec(l); if (m) out.push(`line ${i + 1}: "${m[0]}"`) })
  return out
}

/** Every `[[VARIABLE]]` token used anywhere in the text. */
function variablesUsed(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/\[\[([A-Z0-9_]+)\]\]/g)) out.add(m[1])
  return out
}

/**
 * The `[[VARIABLE]]` tokens inside the file's Variables table: the region from the first heading whose text
 * contains "Variables" (case-insensitive) to the next heading of the same or a higher level. Null = no such heading.
 */
function variablesListed(text: string): Set<string> | null {
  const lines = text.split("\n")
  const start = lines.findIndex((l) => /^#{1,4}\s+.*variables/i.test(l))
  if (start === -1) return null
  const level = (lines[start].match(/^#+/) ?? ["#"])[0].length
  const stop = new RegExp(`^#{1,${level}}\\s`)
  const out = new Set<string>()
  for (let i = start + 1; i < lines.length; i++) {
    if (stop.test(lines[i])) break
    for (const m of lines[i].matchAll(/\[\[([A-Z0-9_]+)\]\]/g)) out.add(m[1])
  }
  return out
}

interface Citation { path: string; symbol: string | null; line: number }

/** Backticked repo citations: `dir/file.ext` or `dir/file.ts::symbol`, where dir ∈ app|lib|scripts|supabase|docs. */
function citations(text: string): Citation[] {
  const out: Citation[] = []
  const re = /`((?:app|lib|scripts|supabase|docs)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|sql|md|json))(?:::([A-Za-z_$][A-Za-z0-9_$]*))?`/g
  text.split("\n").forEach((l, i) => {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(l)) !== null) out.push({ path: m[1], symbol: m[2] ?? null, line: i + 1 })
  })
  return out
}

/**
 * Is `sym` DEFINED in this stripped TypeScript source? A declaration (function / const / let / var / class / type /
 * interface / enum), a method or property definition at the start of a line (`name(` / `name:` / `name =`), or an
 * exported declaration. A mere call site elsewhere in the file does not count — the pattern anchors on the keyword or
 * on the line start.
 */
function symbolDefinedIn(stripped: string, sym: string): boolean {
  const s = sym.replace(/\$/g, "\\$")
  if (new RegExp(`\\b(?:function|const|let|var|class|type|interface|enum)\\s+${s}\\b`).test(stripped)) return true
  if (new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:readonly\\s+)?${s}\\s*[(:=]`, "m").test(stripped)) return true
  return false
}

/** Word count over the whole file (drafting notes and tables are part of the deliverable). */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
}

/** Required headings missing from the text (case-insensitive substring of a `#`–`###` heading line). */
function missingSections(text: string, required: readonly string[]): string[] {
  const headings = text.split("\n").filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.toLowerCase())
  return required.filter((r) => !headings.some((h) => h.includes(r.toLowerCase())))
}

/** The registry keys named in the second column of every table row in the subprocessor Part (Part C → Part D). */
function subprocessorKeys(text: string): string[] {
  const lines = text.split("\n")
  const start = lines.findIndex((l) => /^#\s+Part C\b/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#\s+Part D\b/.test(lines[i])) break
    const l = lines[i]
    if (!l.startsWith("|")) continue
    const cells = l.split("|")
    const cell = cells[2] ?? ""
    const m = /`([a-z0-9_]+)`/.exec(cell)
    if (m) out.push(m[1])
  }
  return out
}

/**
 * The union of provider keys the code's registries declare, read from STRIPPED source. Each extractor names the
 * shape it reads; a registry written in another shape is a blind spot (header) and fails SAFE (its key is absent, so
 * a subprocessor row naming it is refused until the extractor is taught the shape).
 */
function registryKeys(): { keys: Set<string>; sources: Record<string, number>; activationOnly: string[]; firstTenancyKey: string | null; hostingKeys: string[] } {
  const keys = new Set<string>()
  const sources: Record<string, number> = {}
  // For the positive controls: keys that reach the union ONLY through the activation table (never a route row), and
  // the first provider the tenancy matrix declares — both read here so no control has to quote an adapter key as a
  // literal (scripts/operations-docs-guard.ts counts quoted provider keys across scripts/ into a generated block).
  let activationOnly: string[] = []
  let firstTenancyKey: string | null = null
  const add = (src: string, found: Iterable<string>) => { let n = 0; for (const k of found) { keys.add(k); n++ }; sources[src] = n }
  const grab = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1])

  const tenancy = "lib/providers/tenancy-matrix.ts"
  if (has(tenancy)) {
    const tenancyKeys = grab(stripComments(rd(tenancy)), /provider:\s*"([a-z0-9_]+)"/g)
    firstTenancyKey = tenancyKeys[0] ?? null
    add(tenancy, tenancyKeys)
  }
  const connectors = "lib/agentic-os/connector-registry.ts"
  if (has(connectors)) add(connectors, grab(stripComments(rd(connectors)), /connector:\s*"([a-z0-9_]+)"/g))
  const rail = "lib/ai-isa/property-lookup-rail.ts"
  if (has(rail)) {
    const s = stripComments(rd(rail))
    const routeKeys = grab(s, /provider:\s*"([a-z0-9_]+)"/g)
    const at = s.indexOf("export const PROVIDER_ACTIVATION")
    const activationKeys = at === -1 ? [] : grab(s.slice(at), /^ {2}([a-z0-9_]+):\s*\{/gm)
    activationOnly = activationKeys.filter((k) => !routeKeys.includes(k))
    add(rail, [...routeKeys, ...activationKeys])
  }
  const webhooks = "lib/providers/webhook-contract.ts"
  if (has(webhooks)) add(webhooks, grab(stripComments(rd(webhooks)), /provider:\s*"([a-z0-9_]+)"/g))
  const scope = "lib/connections/scope.ts"
  if (has(scope)) {
    const s = stripComments(rd(scope))
    const at = s.indexOf("export const CONNECTOR_PROVIDERS")
    const end = at === -1 ? -1 : s.indexOf("\n}", at)
    add(scope, at === -1 || end === -1 ? [] : grab(s.slice(at, end), /"([a-z0-9_]+)"/g))
  }
  const catalog = "lib/integrations/providers/catalog.ts"
  if (has(catalog)) add(catalog, grab(stripComments(rd(catalog)), /name:\s*"([a-z0-9_]+)"/g))
  // The two hosting primitives the tree itself declares (deploy config + the database client module). The keys are
  // DERIVED from the file names rather than quoted: the hosting vendor is also a route-table adapter, and a quoted
  // adapter key in any script is counted into PROVIDER-CERTIFICATION.md's generated block by operations-docs-guard.
  const hostingFiles = ["vercel.json", "lib/supabase/service.ts"]
  const hosting: string[] = hostingFiles.filter(has).map((f) => f.includes("/") ? f.split("/")[1] : f.replace(/\.json$/, ""))
  add(`hosting (${hostingFiles.join(", ")})`, hosting)
  return { keys, sources, activationOnly, firstTenancyKey, hostingKeys: hosting }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CHECKS
// ═════════════════════════════════════════════════════════════════════════════

console.log("legal-packets-guard — the drafts exist, stay DRAFT, state no price, and describe gates that exist\n")

// ── A. existence + substance ──────────────────────────────────────────────────
console.log("A. PACKETS EXIST AND ARE SUBSTANTIVE")
const texts = new Map<string, string>()
for (const p of PACKETS) {
  const exists = has(p.file)
  check(`${p.label} exists (${p.file})`, exists)
  if (!exists) continue
  const t = rd(p.file)
  texts.set(p.file, t)
  const words = wordCount(t)
  check(`${p.label}: ${words} words ≥ floor ${p.minWords}`, words >= p.minWords, `a gutting edit replaced clauses with an outline — restore the clause set, never lower the floor`)
  const missing = missingSections(t, p.sections)
  check(`${p.label}: all ${p.sections.length} required sections present`, missing.length === 0, missing.length ? `missing: ${missing.join(" · ")}` : undefined)
  check(`${p.label}: carries a Version: line`, hasVersionLine(t))
}

// ── B–E. banner, price, spelling, model names — over the whole corpus ─────────
console.log("\nB. DRAFT BANNER ON LINES 1–3 OF EVERY FILE")
const corpus = legalCorpus()
check(`corpus is non-empty (${corpus.length} files under ${LEGAL_DIR} + the review packet)`, corpus.length >= PACKETS.length)
for (const f of corpus) {
  const t = texts.get(f) ?? rd(f)
  texts.set(f, t)
  check(`${f}: banner present`, bannerOnFirstLines(t), `the first three lines must carry "${DRAFT_BANNER}"`)
}

console.log("\nC. NO PRICE LITERAL OUTSIDE A [[PRICE_*]] VARIABLE")
for (const f of corpus) {
  const hits = priceLiterals(texts.get(f)!)
  check(`${f}: no price literal`, hits.length === 0, hits.slice(0, 5).join("\n      "))
}

console.log("\nD. AMERICAN ENGLISH — NO \"licence\" SPELLING")
for (const f of corpus) {
  const hits = licenceSpellings(texts.get(f)!)
  check(`${f}: no "licence"`, hits.length === 0, hits.slice(0, 5).join("\n      "))
}

console.log("\nE. NO MODEL NAMES OR MODEL IDS")
for (const f of corpus) {
  const hits = modelNames(texts.get(f)!)
  check(`${f}: no model name`, hits.length === 0, hits.slice(0, 5).join("\n      "))
}

// ── F. variables listed ───────────────────────────────────────────────────────
console.log("\nF. EVERY [[VARIABLE]] USED IS LISTED IN THE FILE'S VARIABLES TABLE")
for (const p of PACKETS) {
  const t = texts.get(p.file)
  if (!t) continue
  const used = variablesUsed(t)
  const listed = variablesListed(t)
  check(`${p.label}: has a Variables table`, listed !== null)
  const unlisted = [...used].filter((v) => !(listed ?? new Set()).has(v)).sort()
  check(`${p.label}: all ${used.size} variables used are listed`, listed !== null && unlisted.length === 0, unlisted.length ? `unlisted: ${unlisted.join(", ")}` : undefined)
}

// ── G. citations resolve (file exists; symbol defined in stripped source) ────
console.log("\nG. EVERY CITED PATH EXISTS AND EVERY CITED SYMBOL IS DEFINED THERE (stripped source)")
const strippedCache = new Map<string, string>()
const stripped = (p: string): string => {
  const hit = strippedCache.get(p)
  if (hit !== undefined) return hit
  const raw = rd(p)
  const s = /\.(ts|tsx)$/.test(p) ? stripComments(raw) : raw
  strippedCache.set(p, s)
  return s
}
let citationCount = 0
for (const f of corpus) {
  const cites = citations(texts.get(f)!)
  citationCount += cites.length
  const missingPaths = [...new Set(cites.filter((c) => !has(c.path)).map((c) => c.path))].sort()
  check(`${f}: all ${new Set(cites.map((c) => c.path)).size} cited paths exist`, missingPaths.length === 0, missingPaths.length ? `missing: ${missingPaths.join(", ")}` : undefined)
  const badSymbols: string[] = []
  for (const c of cites) {
    if (!c.symbol || !has(c.path)) continue
    if (!/\.(ts|tsx)$/.test(c.path)) { badSymbols.push(`${c.path}::${c.symbol} (line ${c.line}: a symbol can only be cited on a TypeScript file)`); continue }
    if (!symbolDefinedIn(stripped(c.path), c.symbol)) badSymbols.push(`${c.path}::${c.symbol} (line ${c.line})`)
  }
  const symbolCites = cites.filter((c) => c.symbol).length
  check(`${f}: all ${symbolCites} cited symbols are defined in their files`, badSymbols.length === 0, badSymbols.length ? `not defined: ${[...new Set(badSymbols)].join("\n        ")}` : undefined)
}
const p2 = texts.get(`${LEGAL_DIR}/PACKET-2-AUTONOMOUS-AI-OPERATIONS-AND-AUTHORITY-SCHEDULE.md`)
check("Packet 2 cites at least 40 distinct gate symbols (an authority schedule with few citations is an outline)", !!p2 && new Set(citations(p2).filter((c) => c.symbol).map((c) => `${c.path}::${c.symbol}`)).size >= 40)

// ── H. subprocessors ⊆ registries ─────────────────────────────────────────────
console.log("\nH. THE SUBPROCESSOR LIST NAMES ONLY PROVIDERS PRESENT IN THE CODE'S REGISTRIES")
const reg = registryKeys()
for (const [src, n] of Object.entries(reg.sources)) check(`registry read: ${src} → ${n} keys`, n > 0, "the extractor found nothing — the registry's shape changed; teach the extractor, do not hand-list")
const p4 = texts.get(`${LEGAL_DIR}/PACKET-4-PRIVACY-NOTICE-DPA-AND-SUBPROCESSORS.md`)
const subKeys = p4 ? subprocessorKeys(p4) : []
check(`Packet 4 Part C lists ≥ 20 keyed provider rows (found ${subKeys.length})`, subKeys.length >= 20)
const unknown = [...new Set(subKeys.filter((k) => !reg.keys.has(k)))].sort()
check(`every subprocessor key is a registry key (${subKeys.length} rows against ${reg.keys.size} registry keys)`, unknown.length === 0, unknown.length ? `not in any registry: ${unknown.join(", ")}` : undefined)

// ═════════════════════════════════════════════════════════════════════════════
// P. POSITIVE CONTROLS — every finder still recognises the defect it hunts
// ═════════════════════════════════════════════════════════════════════════════
console.log("\nP. POSITIVE CONTROLS")
check("P1 banner finder: a file without the banner on lines 1–3 is refused", !bannerOnFirstLines(`# Title\n\n\n> ${DRAFT_BANNER}\n`) && bannerOnFirstLines(`> **${DRAFT_BANNER}**\n\n# Title`))
check("P2 version finder: a file without a Version: line is refused", !hasVersionLine("# Title\n\nSome text\n") && hasVersionLine("# T\n\nVersion: 0.1.0-draft\n"))
check("P3 price finder recognises `$` + digit", priceLiterals("costs $49 each").length === 1)
check("P3 price finder recognises \"per month\" and \"per-month\"", priceLiterals("billed per month, or per-Month").length === 2)
check("P3 price finder recognises \"/mo\"", priceLiterals("49/mo flat").length === 1 && priceLiterals("a/moment").length === 0)
check("P3 price finder passes a [[PRICE_*]] variable and plain words", priceLiterals("`[[PRICE_TEAM_MONTHLY]]` billed monthly in US dollars").length === 0)
check("P4 spelling finder recognises licence / licenced / licencing", licenceSpellings("a licence\nlicenced\nLicencing").length === 3 && licenceSpellings("license licensed licensing licensor").length === 0)
check("P5 model-name finder recognises a model family token and passes a vendor name", modelNames(`routed to ${MODEL_FAMILY_FRAGMENTS[0].join("")} by the gateway`).length === 1 && modelNames("Anthropic, PBC and Google LLC are vendors").length === 0)
check("P6 variables finder: an unlisted variable is refused", (() => {
  const doc = "## Variables\n| Variable | Meaning |\n|---|---|\n| `[[A]]` | a |\n\n## Body\nuses [[A]] and [[B_2]]\n"
  const used = variablesUsed(doc); const listed = variablesListed(doc)!
  return used.has("B_2") && !listed.has("B_2") && listed.has("A")
})())
check("P6 variables finder: the region stops at the next heading of the same level", (() => {
  const doc = "## Variables\n| `[[A]]` |\n## Next\n| `[[C]]` |\n"
  const listed = variablesListed(doc)!
  return listed.has("A") && !listed.has("C")
})())
check("P6 variables finder: no Variables heading → null", variablesListed("# T\n\nuses [[A]]\n") === null)
check("P7 citation finder parses path and symbol", (() => {
  const c = citations("see `lib/kernel/action-ledger.ts::withActionLedger` and `supabase/migrations/m978-ad-lead-form-legal-content.sql`")
  return c.length === 2 && c[0].symbol === "withActionLedger" && c[1].symbol === null && c[1].path.endsWith(".sql")
})())
check("P7 path finder: a missing path is refused", !has("lib/kernel/this-file-does-not-exist-151a2.ts"))
check("P7 symbol finder: a symbol defined in a comment ONLY is NOT a definition (stripped source)", (() => {
  const src = "// export function ghostGate() {}\n/* const GHOST_TABLE = {} */\nexport function realGate() {}\nconst REAL_TABLE: Record<string, string> = {\n  entry_a: \"x\",\n}\n"
  const s = stripComments(src)
  return !symbolDefinedIn(s, "ghostGate") && !symbolDefinedIn(s, "GHOST_TABLE") && symbolDefinedIn(s, "realGate") && symbolDefinedIn(s, "REAL_TABLE") && symbolDefinedIn(s, "entry_a")
})())
check("P7 symbol finder: a call site alone is not a definition", !symbolDefinedIn("import { x } from \"y\"\nconst r = x(gateFn(1))\n", "gateFn"))
check("P8 word-count floor: a short outline is refused", wordCount("# Outline\n- terms\n- privacy\n") < 50)
check("P8 section finder: a missing required heading is reported", missingSections("## Definitions\n## Fees\n", ["Definitions", "Termination"]).join() === "Termination")
check("P9 subprocessor finder reads the second column between Part C and Part D", (() => {
  const doc = "# Part C — Subprocessors\n| Vendor | Registry key | Role |\n|---|---|---|\n| Acme | `acme_data_co` | x |\n| Real | `host_provider` | y |\n# Part D — AI\n| Z | `not_read` | z |\n"
  const k = subprocessorKeys(doc)
  return k.length === 2 && k.includes("acme_data_co") && k.includes("host_provider") && !k.includes("not_read")
})())
// No adapter key is quoted in these two controls on purpose — see the note inside registryKeys().
check("P9 registry union refuses a fabricated vendor, admits the first tenancy-matrix provider and both hosting primitives", !reg.keys.has("acme_data_co") && reg.firstTenancyKey !== null && reg.keys.has(reg.firstTenancyKey) && reg.hostingKeys.length === 2 && reg.hostingKeys.every((k) => reg.keys.has(k)))
check(`P9 registry union: the activation table contributes keys no route row names (${reg.activationOnly.length} dormant-pending-rights providers), each in the union`, reg.activationOnly.length >= 1 && reg.activationOnly.every((k) => reg.keys.has(k)))

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n ${corpus.length} files · ${citationCount} citations · ${reg.keys.size} registry keys · ${subKeys.length} subprocessor rows`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
