#!/usr/bin/env tsx
/**
 * scripts/wave155-uncalled-deal-doors-guard.ts   (proposed key: test:wave155-uncalled-deal-doors)   — wave 155, lane 155R28
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY EXPORT OF app/actions/transactions.ts IS A PUBLIC ENDPOINT ("use server", CLAUDE.md §4) — SO EVERY ONE IS EITHER CALLED BY
 * THE PRODUCT, OR KEPT ON PURPOSE BEHIND A SESSION GATE WITH AN OWNER QUESTION. NOTHING SITS THERE UNCALLED AND UNGUARDED.
 *
 * At the base (6e562189) the file exported 67 functions and the product called 27 of them; 40 were doors nothing used.
 * Lane 155R28 applied the orphan doctrine (CLAUDE.md §1) per export: 33 retired with a tombstone naming the survivor the product
 * calls today, 7 kept (no survivor) behind a gate. This proof holds the RULE, never those numbers:
 *
 *   §1 THE RULE (derived each run, STRIPPED source — scripts/strip-comments.ts): for every export of the file, either
 *      (a) a runtime file outside it imports the name (named / dynamic `await import` destructure / `import(...).x` / namespace),
 *          or the file itself calls it; or
 *      (b) the JSDoc directly above it carries "@uncalledDoor case 3" WITH an owner question, and its stripped body calls a
 *          session gate (requireTransactionActor / requireDealRowActor) BEFORE it reaches TransactionService and wraps the write
 *          in ledgerSessionAction. A tagged export that HAS a caller fails too (the tag is stale — remove it).
 *   §2 TOMBSTONES: every "RETIRED <name> → SURVIVOR <file>:<line> <symbol> · CALLED BY <file>:<line> <symbol>" line in the file
 *      names a name the file no longer exports, a survivor file that still carries the symbol in CODE (stripped — a comment
 *      cannot satisfy it) and a caller file that still carries its symbol in code. The cited lines are printed when they drift.
 *   §3 CONTROLS: a planted uncalled export is caught; a planted tag with no gate is caught; a TOMBSTONE COMMENT that names a
 *      retired export (even written as a call) is NOT a call site; a survivor that exists only in a comment is caught.
 *   §4 DRIVEN (SIMULATED): the seven kept doors are called for real (real gates, real getAgentContext / acting-context) over the
 *      in-memory database (scripts/in-memory-supabase.ts). Stubbed only: which user is signed in, the model pipeline (a COUNTED
 *      seam — a provider is never reached) and Next's request shims. Each NEGATIVE (no session, another tenant, an agent not on
 *      the deal, a forbidden field, a second record, a zero-row delete) asserts the refusal AND its consequence (nothing written,
 *      no model call); each has a POSITIVE twin (the rightful caller works and leaves ONE receipt) so a gate that refuses
 *      everyone cannot pass.
 *
 *   §5 THE UI HALF (wave 155, lane 155R30 — CLAUDE.md §1 "BUILD the missing half"): five kept doors are now called by the deal
 *      page (app/dashboard/transactions/[id]/transaction-detail-client.tsx). On comment-stripped source: each is called with the
 *      id of the row it was handed (titleEscrow.id / p.id / d.id; addTitleEscrow with the page's transaction.id, chosen only when
 *      the page has NO record), each handler reads `success` and returns BEFORE any "saved" toast, every field a dialog sends is
 *      a key the door's own whitelist admits, and every row-keyed door (requireDealRowActor) the page imports is on that list.
 *      A WIRED door keeps the gate R28 gave it (session gate before the service, the receipt). generateCostBreakdown stays kept
 *      and its prompt names no percentage literal: the commission is the deal's recorded rate or "not on file" (driven in §4
 *      through the counted model seam, which now also records the prompt it was handed).
 *
 * RED AT THE BASE 6e562189: §1 fails (40 exports with no caller and no tag), §2 finds no tombstone, §4's cross-tenant and
 * forbidden-field negatives write rows (the doors had no session gate; updateTitleEscrow accepted brokerage_id / transaction_id).
 * RED AT 73ec3365 (before lane 155R30): §5 fails — the page calls none of the five doors, and the cost prompt names "6%" and reads
 * `contract_price` (not a column of transactions).
 * BLIND SPOTS (published): RLS is not modelled (the in-memory client admits every row — which is why a missing gate shows here);
 * an export reached only through a string-keyed registry would read as uncalled (none exists for this file today); the importer
 * scan covers runtime roots (scripts/runtime-roots.ts), not scripts/; the impersonation branch of getAgentContext is not driven.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join, dirname, relative } from "node:path"
import { stripComments } from "./strip-comments"
import { runtimeFiles } from "./runtime-roots"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const FILE = "app/actions/transactions.ts"
const PAGE = "app/dashboard/transactions/[id]/transaction-detail-client.tsx"
/** The doors lane 155R30 wired on the deal page, with the id expression each must be called with (the row the page was handed). */
const WIRED_DOORS: Array<{ door: string; firstArg: RegExp; idWord: string }> = [
  { door: "updateTitleEscrow", firstArg: /^\s*titleEscrow\.id\s*,/, idWord: "the record's id (titleEscrow.id)" },
  { door: "addTitleEscrow", firstArg: /^\s*payload\s*\)/, idWord: "a payload built on the page's transaction.id" },
  { door: "updateParticipant", firstArg: /^\s*p\.id\s*,/, idWord: "the participant row's id (p.id)" },
  { door: "removeParticipant", firstArg: /^\s*p\.id\s*\)/, idWord: "the participant row's id (p.id)" },
  { door: "updateDeadline", firstArg: /^\s*d\.id\s*,/, idWord: "the deadline row's id (d.id)" },
]
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")

// ═══ the census machinery (pure — the controls in §3 run the SAME functions over fixtures) ═══════════════════════════════════
/** Exported function names of a module (stripped source). */
function exportedFunctions(stripped: string): string[] {
  return [...stripped.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1])
}
/** Names a module imports from `target` (stripped source of the importer). */
function namesImportedFrom(stripped: string, resolvesToTarget: (spec: string) => boolean): Set<string> {
  const out = new Set<string>()
  const split = (list: string, sep: RegExp) => list.split(",").map((x) => x.trim().split(sep)[0].replace(/^type\s+/, "").trim()).filter(Boolean)
  for (const m of stripped.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) if (resolvesToTarget(m[2])) for (const n of split(m[1], /\s+as\s+/)) out.add(n)
  for (const m of stripped.matchAll(/export\s+\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) if (resolvesToTarget(m[2])) for (const n of split(m[1], /\s+as\s+/)) out.add(n)
  for (const m of stripped.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) if (resolvesToTarget(m[2])) for (const n of split(m[1], /\s*:\s*/)) out.add(n)
  for (const m of stripped.matchAll(/import\(\s*["']([^"']+)["']\s*\)\s*\)?\s*\.\s*(\w+)/g)) if (resolvesToTarget(m[1])) out.add(m[2])
  for (const m of stripped.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*["']([^"']+)["']/g)) if (resolvesToTarget(m[2])) for (const u of stripped.matchAll(new RegExp(`\\b${m[1]}\\.(\\w+)`, "g"))) out.add(u[1])
  return out
}
/** Same-file callers: `name(` anywhere in the stripped module except its own declaration. */
function calledInFile(stripped: string, name: string): boolean {
  // A bare call only: `TransactionService.updateTransaction(` is a DIFFERENT function of the same name (a member access), and
  // every door here delegates to its namesake — counting it called all 34 (the first run of this proof did exactly that).
  const decl = new RegExp(`function\\s+${name}\\s*\\(`, "g")
  const calls = [...stripped.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*\\(`, "g"))].length
  const decls = [...stripped.matchAll(decl)].length
  return calls - decls > 0
}
/** The JSDoc block directly above an export (RAW source — the tag IS a comment). */
function docAbove(rawSrc: string, name: string): string {
  const at = rawSrc.search(new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\b`, "m"))
  if (at < 0) return ""
  const before = rawSrc.slice(0, at).trimEnd()
  if (!before.endsWith("*/")) return ""
  const open = before.lastIndexOf("/**")
  return open < 0 ? "" : before.slice(open)
}
/** The stripped body of a top-level export: from its declaration to the next top-level `}`. */
function bodyOf(stripped: string, name: string): string {
  const m = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\b`, "m").exec(stripped)
  if (!m) return ""
  const rest = stripped.slice(m.index)
  const end = rest.search(/\n\}\n/)
  return end < 0 ? rest : rest.slice(0, end + 2)
}
/** §1(b): a kept uncalled door is tagged with an owner question, gated before the service and receipted. */
function keptDoorProblems(rawSrc: string, stripped: string, name: string): string[] {
  const out: string[] = []
  const doc = docAbove(rawSrc, name)
  if (!/@uncalledDoor\s+case 3\b/.test(doc)) out.push("no @uncalledDoor case 3 tag")
  if (!/owner question:\s*\S.{20,}/.test(doc)) out.push("no owner question")
  return [...out, ...gateProblems(stripped, name)]
}
/** The gate R28 gave a door, kept or wired: the session gate BEFORE TransactionService, and the receipt. */
function gateProblems(stripped: string, name: string): string[] {
  const out: string[] = []
  const body = bodyOf(stripped, name)
  const gate = body.search(/\brequire(?:Transaction|DealRow)Actor\s*\(/)
  const service = body.search(/\bTransactionService\.\w+\s*\(/)
  if (gate < 0) out.push("no session gate (requireTransactionActor / requireDealRowActor)")
  else if (service >= 0 && service < gate) out.push("reaches TransactionService before the gate")
  if (!/\bledgerSessionAction\s*\(/.test(body)) out.push("no receipt (ledgerSessionAction)")
  return out
}
/** §1 adjudication of every export (pure — §3 runs it over a fixture). */
function adjudicate(rawSrc: string, stripped: string, exportsNow: string[], importedNames: Map<string, string[]>, file: string) {
  const called: string[] = [], kept: string[] = [], bare: string[] = [], keptProblems: string[] = [], stale: string[] = []
  for (const name of exportsNow) {
    const isCalled = importedNames.has(name) || calledInFile(stripped, name)
    const tagged = /@uncalledDoor\b/.test(docAbove(rawSrc, name))
    if (isCalled && tagged) stale.push(`${name} (called by ${(importedNames.get(name) ?? [file]).join(", ")})`)
    if (isCalled) { called.push(name); continue }
    if (!tagged) { bare.push(name); continue }
    kept.push(name)
    const p = keptDoorProblems(rawSrc, stripped, name)
    if (p.length) keptProblems.push(`${name}: ${p.join("; ")}`)
  }
  return { called, kept, bare, keptProblems, stale }
}

// ═══ §5 machinery — the page's half (pure; §5 controls run it over fixtures) ═══════════════════════════════════════════════
/** Bare call sites of `door(` in stripped page source: the index just past each `(`. */
function pageCalls(page: string, door: string): number[] {
  return [...page.matchAll(new RegExp(`(?<![.\\w$])${door}\\s*\\(`, "g"))].map((m) => m.index! + m[0].length)
}
/** Problems of one wired door on the page: called, with the expected id expression, and `success` read before "saved". */
function pageDoorProblems(page: string, door: string, firstArg: RegExp): string[] {
  const at = pageCalls(page, door)
  if (at.length === 0) return [`${door} is not called by the page`]
  const out: string[] = []
  for (const i of at) {
    const arg = page.slice(i, i + 80)
    if (!firstArg.test(arg)) out.push(`${door}( is called with ${JSON.stringify(arg.slice(0, 30))}, not the row id it was given`)
    const saved = page.indexOf("toast.success(", i)
    const seg = saved < 0 ? page.slice(i, i + 600) : page.slice(i, saved)
    if (!/if\s*\(\s*!\s*\w+\?\.success\s*\)\s*\{[^}]*\breturn\b/.test(seg)) out.push(`${door}: the handler does not read success and return before saying saved`)
  }
  return out
}
/** The string literals of a `new Set([...])` named `setName` in the action file (stripComments only — the literals ARE the data). */
function whitelist(actionSrc: string, setName: string): Set<string> {
  const m = new RegExp(`const\\s+${setName}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(actionSrc)
  return new Set(m ? [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]) : [])
}
/** A function body in stripped page source: from `function name(` to the next line that closes a 2-space-indented block. */
function pageFn(page: string, name: string): string {
  const i = page.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (i < 0) return ""
  const end = page.indexOf("\n  }\n", i)
  return end < 0 ? page.slice(i) : page.slice(i, end + 4)
}
/** A percentage written as a literal number ("6%", "6 %") in a function's source — an invented rate handed to a model. */
const percentLiterals = (src: string): string[] => [...src.matchAll(/\d+(?:\.\d+)?\s*%/g)].map((m) => m[0])
const TOMB_RE = /TOMBSTONE \(wave 155, lane 155R28 — §1 case (\d)\) RETIRED (\w+) → SURVIVOR (\S+):(\d+) (\S+) · CALLED BY (\S+):(\d+) (\S+)/g
interface Stone { kase: string; name: string; sf: string; sl: number; sym: string; cf: string; cl: number; csym: string }
function tombstones(rawSrc: string): Stone[] {
  // Only COMMENTS count: a line that survives stripping is code (a string), never a tombstone.
  const strippedSet = new Set(stripComments(rawSrc).split("\n").map((l) => l.trim()).filter(Boolean))
  const out: Stone[] = []
  for (const line of rawSrc.split("\n")) {
    if (strippedSet.has(line.trim())) continue
    for (const m of line.matchAll(TOMB_RE)) out.push({ kase: m[1], name: m[2], sf: m[3], sl: Number(m[4]), sym: m[5], cf: m[6], cl: Number(m[7]), csym: m[8] })
  }
  return out
}
/** §2: the problems of one tombstone, over a file reader (null = file absent). */
function stoneProblems(s: Stone, exportsNow: string[], readFile: (p: string) => string | null): string[] {
  const out: string[] = []
  if (exportsNow.includes(s.name)) out.push(`${s.name} is still exported`)
  for (const [f, sym, role] of [[s.sf, s.sym, "survivor"], [s.cf, s.csym, "caller"]] as const) {
    const text = readFile(f)
    if (text === null) { out.push(`${role} file ${f} does not exist`); continue }
    if (!stripComments(text).includes(sym)) out.push(`${role} ${f} no longer carries ${sym} in code`)
  }
  return out
}

function resolver(fromFile: string, target: string, known: Set<string>) {
  return (spec: string): boolean => {
    let base: string
    if (spec.startsWith("@/")) base = spec.slice(2)
    else if (spec.startsWith(".")) base = relative(ROOT, join(ROOT, dirname(fromFile), spec)).split("\\").join("/")
    else return false
    return [base, `${base}.ts`, `${base}.tsx`].some((c) => c === target && known.has(c))
  }
}

// ═══ §4 seams (installed BEFORE any app module loads) ═════════════════════════════════════════════════════════════════════════
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000528`
const B1 = u("b", 1), B2 = u("b", 2)
const U_BROKER = u("a", 1), U_AGENT = u("a", 2), U_AGENT2 = u("a", 3), U_X = u("a", 9), U_TC = u("a", 4), U_VENDOR = u("a", 5), U_LEAD_NO_TEAM = u("a", 6)
const AG_A = u("e", 2), AG_B = u("e", 3), AG_X = u("e", 9)
const TX1 = u("d", 1), TX2 = u("d", 2), TX_X = u("d", 9)
const P1 = u("c", 1), P_X = u("c", 9), E1 = u("f", 1), E_X = u("f", 9), D1 = u("1", 1), D_X = u("1", 9)
function world(): MemClient {
  return memSupabase({
    brokerages: [{ id: B1 }, { id: B2 }],
    users: [
      { id: U_BROKER, brokerage_id: B1, user_type: "broker", email: "bea@example.test" },
      { id: U_AGENT, brokerage_id: B1, user_type: "agent", email: "ann@example.test" },
      { id: U_AGENT2, brokerage_id: B1, user_type: "agent", email: "ben@example.test" },
      { id: U_X, brokerage_id: B2, user_type: "broker", email: "x@example.test" },
      // THE DEAL DESK seats (wave 155, test:deal-desk holds the rule; these three drive it through THIS file's doors).
      { id: U_TC, brokerage_id: B1, user_type: "tc", email: "tc@example.test" },
      { id: U_VENDOR, brokerage_id: B1, user_type: "vendor", email: "vendor@example.test" },
      { id: U_LEAD_NO_TEAM, brokerage_id: B1, user_type: "team_lead", email: "lead@example.test" },
    ],
    teams: [],
    agents: [{ id: AG_A, user_id: U_AGENT, brokerage_id: B1 }, { id: AG_B, user_id: U_AGENT2, brokerage_id: B1 }, { id: AG_X, user_id: U_X, brokerage_id: B2 }],
    transactions: [
      { id: TX1, brokerage_id: B1, agent_id: AG_A, buyer_agent_id: null, seller_agent_id: null, status: "under_contract", property_address: "1 Fixture Way", deal_type: "buyer", purchase_price: 400000 },
      { id: TX2, brokerage_id: B1, agent_id: AG_A, buyer_agent_id: null, seller_agent_id: null, status: "under_contract", property_address: "2 Fixture Way" },
      { id: TX_X, brokerage_id: B2, agent_id: AG_X, buyer_agent_id: null, seller_agent_id: null, status: "under_contract", property_address: "9 Other St" },
    ],
    transaction_participants: [{ id: P1, transaction_id: TX1, brokerage_id: B1, role: "inspector", name: "Ivy" }, { id: P_X, transaction_id: TX_X, brokerage_id: B2, role: "inspector", name: "Other" }],
    transaction_title_escrow: [{ id: E1, transaction_id: TX1, brokerage_id: B1, title_company_name: "First Title" }, { id: E_X, transaction_id: TX_X, brokerage_id: B2, title_company_name: "Other Title" }],
    transaction_deadlines: [{ id: D1, transaction_id: TX1, brokerage_id: B1, deadline_type: "inspection", status: "pending", notes: "Inspection" }, { id: D_X, transaction_id: TX_X, brokerage_id: B2, deadline_type: "inspection", status: "pending", notes: "Other" }],
    transaction_timeline: [], cost_breakdown_tracking: [], agent_action_ledger: [], lifecycle_events: [], notifications: [],
  }, { uuidIds: true })
}
const G = globalThis as any
G.__R28 = {
  mem: world() as MemClient, seat: null as string | null, model: 0, modelText: "{}", prompt: "",
  sess: () => Object.assign(G.__R28.mem, { auth: { getUser: async () => ({ data: { user: G.__R28.seat ? { id: G.__R28.seat, email: "seat@example.test", user_metadata: {} } : null }, error: null }) } }),
}
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const BY_URL: Record<string, string> = {
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__R28.sess() }; export async function createServerClient(){ return globalThis.__R28.sess() }",
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__R28.sess() }",
  // THE MODEL SEAM — counted; a provider is never reached.
  "lib/ai/pipeline.ts": "export async function runPipelineSimple(p){ globalThis.__R28.model++; globalThis.__R28.prompt = String(p); return globalThis.__R28.modelText }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }; export async function draftMode(){ return { isEnabled: false } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: `data:text/javascript,${encodeURIComponent(BY_SPEC[spec])}`, shortCircuit: true }
    const r = next(spec, ctx)
    if ((ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const key = Object.keys(BY_URL).find((k) => path === realUrl(k))
    if (!key) return r
    return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(realUrl(key))}; ${BY_URL[key]}`)}`, shortCircuit: true }
  },
})
delete process.env.AI_GATEWAY_API_KEY

const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
async function drive<T>(fn: () => Promise<T>): Promise<{ r: T | undefined; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}
function as(seat: string | null) { G.__R28.mem = world(); G.__R28.seat = seat; G.__R28.model = 0; G.__R28.modelText = "{}"; G.__R28.prompt = ""; return G.__R28.mem as MemClient }
const T = (m: MemClient, t: string): Row[] => m.tables[t] ?? []
const refused = (x: { r: any; threw: string | null }) => !!x.threw || x.r?.success === false
const receipts = (m: MemClient, action: string) => T(m, "agent_action_ledger").filter((r) => r.action === action)

async function main() {
  const rawSrc = raw(FILE)
  const stripped = stripComments(rawSrc)
  const exportsNow = exportedFunctions(stripped)

  // ═══ §1 ═══
  section(`§1 · every export of ${FILE} is called by the product, or kept behind a gate with an owner question (derived)`)
  const files = runtimeFiles(".").map((f) => f.split("\\").join("/").replace(/^\.\//, "")).filter((f) => f !== FILE)
  const known = new Set([...files, FILE])
  const importedNames = new Map<string, string[]>()
  for (const f of files) {
    const s = stripComments(readFileSync(join(ROOT, f), "utf8"))
    if (!s.includes("actions/transactions")) continue
    for (const n of namesImportedFrom(s, resolver(f, FILE, known))) importedNames.set(n, [...(importedNames.get(n) ?? []), f])
  }
  const { called, kept, bare, keptProblems, stale } = adjudicate(rawSrc, stripped, exportsNow, importedNames, FILE)
  console.log(`  denominator: ${exportsNow.length} exports · ${called.length} called · ${kept.length} kept (@uncalledDoor) · ${bare.length} neither — importer scan over ${files.length} runtime files (stripped)`)
  check(`no export is uncalled AND untagged (found ${bare.length})`, bare.length === 0 && exportsNow.length > 0, bare)
  check(`every kept door (${kept.length}) carries the tag + an owner question, gates on the session before the service, and leaves a receipt`, keptProblems.length === 0, keptProblems)
  check("no @uncalledDoor tag sits on an export the product calls (a stale tag is removed, not left reading as a hold)", stale.length === 0, stale)
  check("the control set is non-empty and is reached from outside the file (a scan that sees no importer would call everything uncalled)", called.some((n) => importedNames.has(n)), called)
  const wiredGateBad = WIRED_DOORS.map((w) => ({ n: w.door, p: gateProblems(stripped, w.door) })).filter((x) => x.p.length)
  check(`the ${WIRED_DOORS.length} doors lane 155R30 wired keep the gate lane 155R28 gave them (session gate before the service, one receipt)`, wiredGateBad.length === 0 && WIRED_DOORS.every((w) => exportsNow.includes(w.door)), wiredGateBad)
  check(`the ${WIRED_DOORS.length} wired doors are counted CALLED by the scan, not kept`, WIRED_DOORS.every((w) => called.includes(w.door) && !kept.includes(w.door)), WIRED_DOORS.filter((w) => !called.includes(w.door)).map((w) => w.door))

  // ═══ §2 ═══
  section("§2 · every tombstone names a retired export and a survivor / caller that still carry their symbol in CODE")
  const stones = tombstones(rawSrc)
  const read = (p: string) => existsSync(join(ROOT, p)) ? raw(p) : null
  const stoneBad = stones.map((s) => ({ s, p: stoneProblems(s, exportsNow, read) })).filter((x) => x.p.length)
  const drift = stones.filter((s) => !(read(s.sf) ?? "").split("\n")[s.sl - 1]?.includes(s.sym) || !(read(s.cf) ?? "").split("\n")[s.cl - 1]?.includes(s.csym))
  console.log(`  ${stones.length} tombstones (${stones.filter((s) => s.kase === "1").length} case 1 · ${stones.filter((s) => s.kase === "2").length} case 2)${drift.length ? ` — cited lines drifted (re-point, not a failure): ${drift.map((d) => d.name).join(", ")}` : " — every cited line still reads its symbol"}`)
  check("every tombstone holds (retired name gone; survivor and caller still carry their symbol in code)", stones.length > 0 && stoneBad.length === 0, stoneBad.map((x) => `${x.s.name}: ${x.p.join("; ")}`))
  check("no retired name is imported from the file anywhere in runtime code", stones.every((s) => !importedNames.has(s.name)), stones.filter((s) => importedNames.has(s.name)).map((s) => s.name))
  check("no name is both retired and kept (one adjudication per export)", stones.every((s) => !exportsNow.includes(s.name)))

  // ═══ §3 ═══
  section("§3 · controls — the finders still see the defects they were written for")
  {
    const fx = `"use server"\nexport async function used() { return 1 }\nexport async function planted() { return 2 }\n`
    const fxS = stripComments(fx)
    const importer = stripComments(`import { used } from "@/app/actions/fx"\nused()\n`)
    const imp = namesImportedFrom(importer, (s) => s === "@/app/actions/fx")
    const uncalled = exportedFunctions(fxS).filter((n) => !imp.has(n) && !calledInFile(fxS, n))
    check("POSITIVE CONTROL: a planted uncalled export in a fixture is caught", uncalled.length === 1 && uncalled[0] === "planted", uncalled)
    const dyn = namesImportedFrom(stripComments(`const { planted } = await import("@/app/actions/fx")`), (s) => s === "@/app/actions/fx")
    check("CONTROL: a dynamic `await import` destructure counts as an importer (seven live callers use this shape)", dyn.has("planted"))
    const tombOnly = stripComments(`// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED planted → SURVIVOR a.ts:1 x · CALLED BY b.ts:1 y\n// planted() lived here\nimport { used } from "@/app/actions/fx"\n`)
    const delegating = stripComments(`export async function planted(id) { return TransactionService.planted(id) }\n`)
    check("POSITIVE CONTROL: a door that only delegates to its same-named service function is NOT 'called in file'", !calledInFile(delegating, "planted"))
    check("CONTROL: a genuine bare same-file call IS counted", calledInFile(stripComments(`export async function planted() {}\nasync function x() { return planted() }\n`), "planted"))
    check("TOMBSTONE IS NOT A CALL SITE: a comment naming (even calling) a retired export is not counted", !namesImportedFrom(tombOnly, (s) => s === "@/app/actions/fx").has("planted") && !calledInFile(tombOnly, "planted"))
    const tagNoGate = `/**\n * @uncalledDoor case 3 — owner question: wire this door at the deal page or retire it?\n */\nexport async function planted(id: string) {\n  return TransactionService.x(id)\n}\n`
    check("POSITIVE CONTROL: a tagged door with no session gate and no receipt is caught", keptDoorProblems(tagNoGate, stripComments(tagNoGate), "planted").length >= 2, keptDoorProblems(tagNoGate, stripComments(tagNoGate), "planted"))
    const gateAfter = `/**\n * @uncalledDoor case 3 — owner question: wire this door at the deal page or retire it?\n */\nexport async function planted(id: string) {\n  await TransactionService.x(id)\n  const gate = await requireTransactionActor(id)\n  return ledgerSessionAction({}, async () => 1)\n}\n`
    check("POSITIVE CONTROL: a gate that runs AFTER the service write is caught", keptDoorProblems(gateAfter, stripComments(gateAfter), "planted").some((p) => /before the gate/.test(p)))
    const good = `/**\n * @uncalledDoor case 3 — owner question: wire this door at the deal page or retire it?\n */\nexport async function planted(id: string) {\n  const gate = await requireTransactionActor(id)\n  return ledgerSessionAction({}, async () => TransactionService.x(id))\n}\n`
    check("CONTROL: a well-formed kept door passes the same check", keptDoorProblems(good, stripComments(good), "planted").length === 0, keptDoorProblems(good, stripComments(good), "planted"))
    const s: Stone = { kase: "2", name: "gone", sf: "s.ts", sl: 1, sym: "survivorFn", cf: "c.ts", cl: 1, csym: "survivorFn" }
    const files2: Record<string, string> = { "s.ts": "// survivorFn used to be here\nexport const other = 1\n", "c.ts": "survivorFn()\n" }
    check("POSITIVE CONTROL: a survivor that exists only in a COMMENT is caught", stoneProblems(s, [], (p) => files2[p] ?? null).some((x) => /survivor/.test(x)))
    check("POSITIVE CONTROL: a retired name that is still exported is caught", stoneProblems({ ...s }, ["gone"], (p) => ({ "s.ts": "export function survivorFn() {}", "c.ts": "survivorFn()" } as Record<string, string>)[p] ?? null).some((x) => /still exported/.test(x)))
    check("CONTROL: a tombstone written inside a string literal is not a tombstone", tombstones(`const t = "TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED x → SURVIVOR a.ts:1 y · CALLED BY b.ts:1 z"\n`).length === 0)
    // Lane 155R30: the stale-mark half of the rule (a marked door must be uncalled) gets its own positive control.
    const staleFx = `/**\n * @uncalledDoor case 3 — owner question: wire this door at the deal page or retire it?\n */\nexport async function planted(id: string) {\n  const gate = await requireTransactionActor(id)\n  return ledgerSessionAction({}, async () => TransactionService.x(id))\n}\n`
    const adj = adjudicate(staleFx, stripComments(staleFx), ["planted"], new Map([["planted", ["page.tsx"]]]), "fx.ts")
    check("POSITIVE CONTROL: a door that carries @uncalledDoor AND has a caller is caught as a stale mark", adj.stale.length === 1 && adj.kept.length === 0, adj)
    const adj2 = adjudicate(staleFx, stripComments(staleFx), ["planted"], new Map(), "fx.ts")
    check("CONTROL: the same door with no caller is a well-formed KEPT door (not stale)", adj2.stale.length === 0 && adj2.kept.length === 1 && adj2.keptProblems.length === 0, adj2)
  }

  // ═══ §4 ═══
  section("§4 · the seven doors lane 155R28 kept (five now wired by lane 155R30), driven (SIMULATED — real gates over an in-memory database)")
  const tx = await import(pathToFileURL(join(ROOT, FILE)).href)

  // updateTransaction
  let m = as(null); let x = await drive(() => tx.updateTransaction(TX1, { property_address: "Hacked" }))
  check("updateTransaction NEG no session: refused, the deal unchanged, no receipt", refused(x) && T(m, "transactions").find((r) => r.id === TX1)?.property_address === "1 Fixture Way" && receipts(m, "transaction.details.update").length === 0, x)
  m = as(U_BROKER); x = await drive(() => tx.updateTransaction(TX_X, { property_address: "Hacked" }))
  check("updateTransaction NEG another tenant's deal: refused, its row unchanged", refused(x) && T(m, "transactions").find((r) => r.id === TX_X)?.property_address === "9 Other St", x)
  m = as(U_AGENT2); x = await drive(() => tx.updateTransaction(TX1, { property_address: "Hacked" }))
  check("updateTransaction NEG an agent NOT on the deal (same tenant): refused, unchanged", refused(x) && T(m, "transactions").find((r) => r.id === TX1)?.property_address === "1 Fixture Way", x)
  m = as(U_AGENT); x = await drive(() => tx.updateTransaction(TX1, { agent_id: AG_B }))
  check("updateTransaction NEG a reassignment through a field edit (agent_id): refused, the agent unchanged", refused(x) && T(m, "transactions").find((r) => r.id === TX1)?.agent_id === AG_A, x)
  m = as(U_AGENT); x = await drive(() => tx.updateTransaction(TX1, { status: "closed" }))
  check("updateTransaction NEG status still refused first (its one door is advanceTransactionStage)", refused(x) && T(m, "transactions").find((r) => r.id === TX1)?.status === "under_contract", x)
  m = as(U_AGENT); x = await drive(() => tx.updateTransaction(TX1, { property_address: "1 Corrected Way" }))
  check("updateTransaction POS the agent on the deal corrects the address — written, ONE receipt (session user, session tenant)", (x.r as any)?.success === true && T(m, "transactions").find((r) => r.id === TX1)?.property_address === "1 Corrected Way" && receipts(m, "transaction.details.update").length === 1 && receipts(m, "transaction.details.update")[0]?.brokerage_id === B1 && receipts(m, "transaction.details.update")[0]?.actor_user_id === U_AGENT, { x, r: receipts(m, "transaction.details.update") })

  // addTitleEscrow
  m = as(U_BROKER); x = await drive(() => tx.addTitleEscrow({ transaction_id: TX_X, title_company_name: "Planted" }))
  check("addTitleEscrow NEG another tenant's deal: refused, nothing inserted", refused(x) && !T(m, "transaction_title_escrow").some((r) => r.title_company_name === "Planted"), x)
  m = as(U_BROKER); x = await drive(() => tx.addTitleEscrow({ transaction_id: TX1, title_company_name: "Second" }))
  check("addTitleEscrow NEG a SECOND record for a deal that has one: refused (readers resolve ONE per deal)", refused(x) && T(m, "transaction_title_escrow").filter((r) => r.transaction_id === TX1).length === 1, x)
  m = as(null); x = await drive(() => tx.addTitleEscrow({ transaction_id: TX2, title_company_name: "Anon" }))
  check("addTitleEscrow NEG no session: refused, nothing inserted", refused(x) && !T(m, "transaction_title_escrow").some((r) => r.transaction_id === TX2), x)
  m = as(U_AGENT); x = await drive(() => tx.addTitleEscrow({ transaction_id: TX2, title_company_name: "Gulf Title" }))
  const added = T(m, "transaction_title_escrow").find((r) => r.transaction_id === TX2)
  check("addTitleEscrow POS the agent on the deal adds it — the row carries the SESSION tenant, ONE receipt", (x.r as any)?.success === true && added?.brokerage_id === B1 && receipts(m, "transaction.title_escrow.add").length === 1, { x, added })

  // THE DEAL DESK through these doors (wave 155): the deal-detail gate asks lib/transactions/role-guard.ts decideDealDesk. Before
  // that it carried its own roster — the coordinator was refused and a team lead was admitted on every deal of the brokerage.
  m = as(U_TC); x = await drive(() => tx.updateTitleEscrow(E1, { escrow_number: "ESC-TC-1" }))
  check("DEAL DESK updateTitleEscrow POS the coordinator (tc) edits the record — the seat that normally enters title and escrow details", (x.r as any)?.success === true && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.escrow_number === "ESC-TC-1" && receipts(m, "transaction.title_escrow.update").length === 1, x)
  m = as(U_VENDOR); x = await drive(() => tx.updateTitleEscrow(E1, { escrow_number: "VENDOR" }))
  check("DEAL DESK updateTitleEscrow NEG a vendor seat of the tenant: refused, unchanged, no receipt", refused(x) && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.escrow_number === undefined && receipts(m, "transaction.title_escrow.update").length === 0, x)
  m = as(U_LEAD_NO_TEAM); x = await drive(() => tx.updateTitleEscrow(E1, { escrow_number: "LEAD" }))
  check("DEAL DESK updateTitleEscrow NEG a team lead who is not on the deal and leads no team on it: refused, unchanged (a team lead is not a brokerage-wide seat)", refused(x) && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.escrow_number === undefined, x)
  // updateTitleEscrow
  m = as(U_BROKER); x = await drive(() => tx.updateTitleEscrow(E1, { brokerage_id: B2, transaction_id: TX_X }))
  check("updateTitleEscrow NEG moving the record to another tenant / deal (brokerage_id, transaction_id): refused, unchanged", refused(x) && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.brokerage_id === B1 && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.transaction_id === TX1, x)
  m = as(U_BROKER); x = await drive(() => tx.updateTitleEscrow(E1, { title_status: "closed" }))
  check("updateTitleEscrow NEG the title vendor's own title_status: refused", refused(x) && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.title_status === undefined, x)
  m = as(U_BROKER); x = await drive(() => tx.updateTitleEscrow(E_X, { escrow_number: "HACK" }))
  check("updateTitleEscrow NEG another tenant's record: refused, unchanged", refused(x) && T(m, "transaction_title_escrow").find((r) => r.id === E_X)?.escrow_number === undefined, x)
  m = as(U_BROKER); x = await drive(() => tx.updateTitleEscrow(E1, { escrow_number: "ESC-1" }))
  check("updateTitleEscrow POS the tenant's broker sets the escrow number — written, ONE receipt", (x.r as any)?.success === true && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.escrow_number === "ESC-1" && receipts(m, "transaction.title_escrow.update").length === 1, x)

  // updateParticipant / removeParticipant
  m = as(U_BROKER); x = await drive(() => tx.updateParticipant(P1, { transaction_id: TX_X } as any))
  check("updateParticipant NEG moving a participant to another deal (transaction_id): refused, unchanged", refused(x) && T(m, "transaction_participants").find((r) => r.id === P1)?.transaction_id === TX1, x)
  m = as(U_BROKER); x = await drive(() => tx.updateParticipant(P_X, { name: "Hacked" }))
  check("updateParticipant NEG another tenant's participant: refused, unchanged", refused(x) && T(m, "transaction_participants").find((r) => r.id === P_X)?.name === "Other", x)
  m = as(U_AGENT); x = await drive(() => tx.updateParticipant(P1, { phone: "555-0100" }))
  check("updateParticipant POS the agent on the deal edits a participant — written, ONE receipt", (x.r as any)?.success === true && T(m, "transaction_participants").find((r) => r.id === P1)?.phone === "555-0100" && receipts(m, "transaction.participant.update").length === 1, x)
  m = as(U_BROKER); x = await drive(() => tx.removeParticipant(P_X))
  check("removeParticipant NEG another tenant's participant: refused, the row remains", refused(x) && T(m, "transaction_participants").some((r) => r.id === P_X), x)
  m = as(U_AGENT); x = await drive(() => tx.removeParticipant(P1))
  check("removeParticipant POS the agent on the deal removes one — gone, ONE receipt", (x.r as any)?.success === true && !T(m, "transaction_participants").some((r) => r.id === P1) && receipts(m, "transaction.participant.remove").length === 1, x)
  {
    // §3's zero-row rule at the service: the gate passes (the deal is real) but the delete matches nothing — a refusal, not "removed".
    const svc = await import(pathToFileURL(join(ROOT, "lib/application/transactions.ts")).href)
    m = as(U_AGENT); m.tables.transaction_participants = []
    const z = await drive(() => svc.removeParticipant(P1))
    check("removeParticipant NEG a delete that matched NOTHING is not a success (counted, CLAUDE.md §3)", refused(z), z)
  }

  // updateDeadline
  m = as(U_BROKER); x = await drive(() => tx.updateDeadline(D_X, { notes: "Hacked" }))
  check("updateDeadline NEG another tenant's deadline: refused, unchanged", refused(x) && T(m, "transaction_deadlines").find((r) => r.id === D_X)?.notes === "Other", x)
  m = as(U_AGENT); x = await drive(() => tx.updateDeadline(D1, { status: "whatever" }))
  check("updateDeadline NEG an unadmitted status (the vocabulary gate still runs): refused, unchanged", refused(x) && T(m, "transaction_deadlines").find((r) => r.id === D1)?.status === "pending", x)
  m = as(U_AGENT); x = await drive(() => tx.updateDeadline(D1, { brokerage_id: B2 } as any))
  check("updateDeadline NEG a field outside the deadline's own (brokerage_id): refused", refused(x) && T(m, "transaction_deadlines").find((r) => r.id === D1)?.brokerage_id === B1, x)
  m = as(U_AGENT); x = await drive(() => tx.updateDeadline(D1, { notes: "Inspection (rescheduled by the parties)" }))
  check("updateDeadline POS the agent on the deal edits the note — written, ONE receipt (LEGAL)", (x.r as any)?.success === true && T(m, "transaction_deadlines").find((r) => r.id === D1)?.notes?.startsWith("Inspection (") && receipts(m, "transaction.deadline.update")[0]?.risk_class === "LEGAL", x)

  // generateCostBreakdown
  m = as(U_BROKER); x = await drive(() => tx.generateCostBreakdown(TX_X))
  check("generateCostBreakdown NEG another tenant's deal: refused BEFORE the model (0 calls), nothing written", refused(x) && G.__R28.model === 0 && T(m, "cost_breakdown_tracking").length === 0, { x, model: G.__R28.model })
  m = as(null); x = await drive(() => tx.generateCostBreakdown(TX1))
  check("generateCostBreakdown NEG no session: refused before the model (0 calls)", refused(x) && G.__R28.model === 0, { x, model: G.__R28.model })
  m = as(U_AGENT); G.__R28.modelText = JSON.stringify({ data: { costs: {} } }); x = await drive(() => tx.generateCostBreakdown(TX1))
  check("generateCostBreakdown NEG the model returned no line: ZERO saved is a refusal, not 'done'", refused(x) && G.__R28.model === 1 && T(m, "cost_breakdown_tracking").length === 0, x)
  m = as(U_AGENT); G.__R28.modelText = JSON.stringify({ data: { costs: { title_insurance: { amount: 1200 }, escrow_fee: { amount: 650 } } } }); x = await drive(() => tx.generateCostBreakdown(TX1))
  check("generateCostBreakdown POS the agent on the deal — lines saved under the deal's tenant, ONE receipt, ONE model call", (x.r as any)?.success === true && T(m, "cost_breakdown_tracking").length === 2 && T(m, "cost_breakdown_tracking").every((r) => r.brokerage_id === B1) && receipts(m, "transaction.cost_breakdown.generate").length === 1 && G.__R28.model === 1, { x, rows: T(m, "cost_breakdown_tracking").length })

  // Lane 155R30: the model is handed the deal's RECORDED commission rate, or told it is not on file — never an invented "6%".
  m = as(U_AGENT); { const t = T(m, "transactions").find((r) => r.id === TX1)!; t.deal_type = "seller"; t.commission_percentage = null }
  G.__R28.modelText = JSON.stringify({ data: { costs: { title_insurance: { amount: 1200 } } } }); x = await drive(() => tx.generateCostBreakdown(TX1))
  const promptNoRate = String(G.__R28.prompt)
  check("generateCostBreakdown PROMPT no rate on file: the model is told the commission is NOT ON FILE and is handed no percentage", G.__R28.model === 1 && /NOT ON FILE/.test(promptNoRate) && percentLiterals(promptNoRate).length === 0 && /\$400000/.test(promptNoRate), { x, promptNoRate: promptNoRate.slice(0, 300) })
  m = as(U_AGENT); { const t = T(m, "transactions").find((r) => r.id === TX1)!; t.deal_type = "seller"; t.commission_percentage = 2.5 }
  G.__R28.modelText = JSON.stringify({ data: { costs: { title_insurance: { amount: 1200 } } } }); x = await drive(() => tx.generateCostBreakdown(TX1))
  const promptRate = String(G.__R28.prompt)
  check("generateCostBreakdown PROMPT recorded rate: the deal's own 2.5% is the only percentage handed to the model", G.__R28.model === 1 && percentLiterals(promptRate).join(",") === "2.5%" && !/NOT ON FILE/.test(promptRate), { x, promptRate: promptRate.slice(0, 300) })

  // ═══ §5 ═══
  section(`§5 · the UI half — ${PAGE} calls each wired door with its row id and reads success before saying saved (stripped)`)
  const page = stripComments(raw(PAGE))
  for (const w of WIRED_DOORS) {
    const p = pageDoorProblems(page, w.door, w.firstArg)
    check(`${w.door}: called by the page with ${w.idWord}, and success read before "saved"`, p.length === 0, p)
  }
  {
    const fn = pageFn(page, "handleSaveTitleEscrow")
    const iIf = fn.search(/if\s*\(\s*titleEscrow\?\.id\s*\)/), iUpd = fn.search(/(?<![.\w$])updateTitleEscrow\s*\(/), iElse = fn.indexOf("} else {"), iAdd = fn.search(/(?<![.\w$])addTitleEscrow\s*\(/)
    check("title / escrow: the record id chooses the door — update inside `if (titleEscrow?.id)`, add only in its else (the add door refuses a second record)", iIf >= 0 && iIf < iUpd && iUpd < iElse && iElse < iAdd, { iIf, iUpd, iElse, iAdd })
    check("title / escrow: the add payload is built on the page's transaction.id", /transaction_id:\s*transaction\.id/.test(fn.slice(iElse, iAdd)), fn.slice(iElse, iAdd).slice(0, 200))
    check("title / escrow: a success refreshes the page data (router.refresh after the success check)", /toast\.success\([\s\S]*router\.refresh\(\)/.test(fn.slice(iAdd)))
  }
  const actionSrc = stripComments(raw(FILE))
  const pageRaw = raw(PAGE)
  {
    const block = /const TITLE_ESCROW_EDIT_FIELDS = \[([\s\S]*?)\] as const/.exec(stripComments(pageRaw))?.[1] ?? ""
    const sent = [...block.matchAll(/key:\s*"(\w+)"/g)].map((m) => m[1])
    const allow = whitelist(actionSrc, "TITLE_ESCROW_FIELDS")
    check(`title / escrow: every field the dialog sends (${sent.length}) is on the door's whitelist (${allow.size})`, sent.length > 0 && allow.size > 0 && sent.every((k) => allow.has(k)), sent.filter((k) => !allow.has(k)))
    const pKeys = [...(/for\s*\(const key of \[([^\]]*)\] as const\)/.exec(pageFn(stripComments(pageRaw), "handleSaveParticipant"))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1])
    const pAllow = whitelist(actionSrc, "PARTICIPANT_FIELDS")
    check(`participant: every field the dialog sends (${pKeys.length}) is on the door's whitelist (${pAllow.size})`, pKeys.length > 0 && pKeys.every((k) => pAllow.has(k)), pKeys.filter((k) => !pAllow.has(k)))
    const dKeys = [...pageFn(stripComments(pageRaw), "handleSaveDeadline").matchAll(/changes\.(\w+)\s*=/g)].map((m) => m[1])
    const dAllow = new Set([...(/const refusedFields = Object\.keys\(updates \?\? \{\}\)\.filter\(\(k\) => !\[([^\]]*)\]\.includes\(k\)\)/.exec(bodyOf(actionSrc, "updateDeadline"))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]))
    check(`deadline: every field the dialog sends (${dKeys.length}) is on the door's list (${dAllow.size}) — and status is not sent (completion keeps its own door)`, dKeys.length > 0 && dAllow.size > 0 && dKeys.every((k) => dAllow.has(k)) && !dKeys.includes("status"), { dKeys, dAllow: [...dAllow] })
  }
  {
    const rowKeyed = exportedFunctions(actionSrc).filter((n) => /\brequireDealRowActor\s*\(/.test(bodyOf(actionSrc, n)))
    const onPage = namesImportedFrom(page, (spec) => spec === "@/app/actions/transactions")
    const unlisted = rowKeyed.filter((n) => onPage.has(n) && !WIRED_DOORS.some((w) => w.door === n))
    check(`every row-keyed door the page imports is held by the id check above (${rowKeyed.length} row-keyed: ${rowKeyed.join(", ")})`, rowKeyed.length > 0 && unlisted.length === 0, unlisted)
    check("removeParticipant asks for confirmation before it is called", /window\.confirm\([\s\S]{0,200}\breturn\b[\s\S]{0,200}removeParticipant\s*\(/.test(pageFn(page, "handleRemoveParticipant")))
  }
  {
    const costFn = bodyOf(stripComments(raw("lib/application/transactions.ts")), "generateCostBreakdown")
    check("generateCostBreakdown's prompt (lib/application/transactions.ts) names NO percentage literal — no invented commission rate", costFn.length > 0 && percentLiterals(costFn).length === 0, percentLiterals(costFn))
    check("generateCostBreakdown reads the deal's recorded rate (commission_percentage) and the live price column (purchase_price), never `contract_price`", /commission_percentage/.test(costFn) && /purchase_price/.test(costFn) && !/contract_price/.test(costFn))
    check("generateCostBreakdown is NOT wired (it stays a kept door with its owner question)", !namesImportedFrom(page, (spec) => spec === "@/app/actions/transactions").has("generateCostBreakdown"))
  }
  // §5 controls — the finders still see the defects they were written for.
  {
    const toastFirst = `async function h() {\n  const { updateDeadline } = await import("@/app/actions/transactions")\n  const result = await updateDeadline(d.id, changes)\n  toast.success("Deadline updated")\n  if (!result?.success) { return }\n}\n`
    check("§5 POSITIVE CONTROL: a handler that says 'saved' before reading success is caught", pageDoorProblems(stripComments(toastFirst), "updateDeadline", /^\s*d\.id\s*,/).some((x) => /success/.test(x)))
    const wrongId = `async function h() {\n  const result = await updateParticipant(body.participantId, changes)\n  if (!result?.success) { return }\n  toast.success("ok")\n}\n`
    check("§5 POSITIVE CONTROL: a door called with an id the row did not supply is caught", pageDoorProblems(stripComments(wrongId), "updateParticipant", /^\s*p\.id\s*,/).some((x) => /not the row id/.test(x)))
    const commentOnly = `// updateTitleEscrow(titleEscrow.id, changes) — if (!result?.success) { return }\n/* await updateTitleEscrow(titleEscrow.id, x) */\nconst x = 1\n`
    check("§5 TOMBSTONE IS NOT A CALL SITE: a comment that writes the call is not counted", pageDoorProblems(stripComments(commentOnly), "updateTitleEscrow", /^\s*titleEscrow\.id\s*,/).some((x) => /not called/.test(x)))
    const good = `async function h() {\n  const result = await updateDeadline(d.id, changes)\n  if (!result?.success) {\n    toast.error(result?.error)\n    return\n  }\n  toast.success("ok")\n}\n`
    check("§5 CONTROL: a well-formed handler passes the same check", pageDoorProblems(stripComments(good), "updateDeadline", /^\s*d\.id\s*,/).length === 0, pageDoorProblems(stripComments(good), "updateDeadline", /^\s*d\.id\s*,/))
    const fxAction = `const TITLE_ESCROW_FIELDS: ReadonlySet<string> = new Set([\n  "title_company_name", "escrow_number",\n])\n`
    check("§5 POSITIVE CONTROL: a sent field outside the whitelist (brokerage_id) is caught by the whitelist reader", !whitelist(fxAction, "TITLE_ESCROW_FIELDS").has("brokerage_id") && whitelist(fxAction, "TITLE_ESCROW_FIELDS").has("escrow_number"))
    check("§5 POSITIVE CONTROL: an invented rate in a prompt (\"Commission (6% …)\") is caught", percentLiterals("const p = `- Commission (6% - be transparent)`").length === 1)
    const noGate = `export async function updateDeadline(id: string) {\n  return TransactionService.updateDeadline(id, {})\n}\n`
    check("§5 POSITIVE CONTROL: a wired door whose gate and receipt were dropped is caught", gateProblems(stripComments(noGate), "updateDeadline").length >= 2, gateProblems(stripComments(noGate), "updateDeadline"))
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log("❌ WAVE155_UNCALLED_DEAL_DOORS_FAIL"); process.exit(1) }
  console.log("✅ WAVE155_UNCALLED_DEAL_DOORS_PASS — every export of app/actions/transactions.ts is called, or kept behind a session gate with an owner question; every retirement names a live survivor; the five wired doors are called with their row id and read success before saying saved")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
