/**
 * .claude/skills/run-vip-re-os/mcp-bridge/bridge.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MCP REPLAY BRIDGE — runs the app's REAL server functions in-process
 * against the LIVE database from a sandbox that cannot reach *.supabase.co.
 *
 * Why it exists: the agent sandbox's egress proxy refuses the project host
 * (CONNECT 403) and no service-role key is exposed, so a supabase-js client
 * cannot be built here. The only live handle is the Supabase MCP
 * `execute_sql` tool, which only the AGENT can call. So the function runs in
 * a replay loop:
 *
 *   1. the scenario runs from the top; every awaited query builder is a CALL
 *      with a sequence index;
 *   2. a call already answered in the cache replays its recorded result;
 *   3. a WRITE whose result the caller does not read (no .select(), no count,
 *      no .single()) is DEFERRED with a provisional `{ data: null, error: null }`
 *      and the run continues;
 *   4. the first call that needs a real answer STOPS the run: the bridge writes
 *      ONE SQL batch (the deferred writes + the stop call, each in its own
 *      subtransaction, each under its own role — service_role or
 *      authenticated + request.jwt.claims so RLS applies exactly as PostgREST
 *      applies it) and exits 3;
 *   5. the agent runs the batch with execute_sql, saves the JSON, and runs
 *      `--ingest <file>`; a failed statement is recorded AT ITS INDEX with its
 *      SQLSTATE and nothing after it runs, so the replay hands the caller the
 *      error exactly where supabase-js would have.
 *
 * Randomness is seeded (crypto.randomUUID → 91d0xxxx-… ids, Math.random) so the
 * replay is deterministic; a call whose verb/table signature differs from the
 * cached one at the same index aborts with DIVERGED rather than replaying a
 * wrong answer.
 *
 * Deliberate emulations (reported by the scenario, never hidden):
 *   - auth.admin.* (GoTrue is not reachable) → SQL on auth.users, and ONLY for
 *     `@wave91.test`-style demo emails (BRIDGE_DEMO_EMAIL_SUFFIX); anything else
 *     is refused;
 *   - storage / functions.invoke → refused with an error;
 *   - global fetch → refused (no Stripe, no AI gateway, no mail provider is
 *     ever called), each attempt logged to externalCalls.
 */
import fs from "node:fs"
import path from "node:path"
import nodeCrypto from "node:crypto"
import { syncBuiltinESMExports } from "node:module"
import { SCHEMA_FK_MAP } from "../../../../scripts/schema-fk-map"

// ── state ────────────────────────────────────────────────────────────────────
/** Tables whose PK is `id uuid DEFAULT gen_random_uuid()` (live pg_catalog read, saved by the agent). */
const UUID_ID_TABLES: Set<string> = (() => { try { return new Set(String(JSON.parse(fs.readFileSync(path.join(process.env.BRIDGE_DIR || path.join(process.cwd(), ".bridge"), "uuid-id-tables.json"), "utf8"))).split(",")) } catch { return new Set<string>() } })()
const WALK_DIR = process.env.BRIDGE_DIR || path.join(process.cwd(), ".bridge")
const CACHE_PATH = path.join(WALK_DIR, "cache.json")
export const batchPath = () => path.join(WALK_DIR, "batch-current.sql")
const DEMO_EMAIL_SUFFIX = (process.env.BRIDGE_DEMO_EMAIL_SUFFIX || "@wave91.test").toLowerCase()
const UUID_PREFIX = process.env.BRIDGE_UUID_PREFIX || "91d0"

export interface BridgeError { message: string; code: string; details: string | null; hint: string | null }
interface CacheEntry { sig: string; status: "done" | "pending"; result?: any; sql?: string; label?: string; key?: string }
interface CacheFile { entries: CacheEntry[]; meta?: { nz?: string[]; nzAt?: number; scope?: string } }

let cache: CacheFile = { entries: [] }
let callIndex = 0
const pending: { index: number; sql: string; sig: string }[] = []
export const externalCalls: string[] = []
export const emulations: string[] = []

export class BridgeStop extends Error { constructor() { super("BRIDGE_STOP") } }

function loadCache() {
  fs.mkdirSync(WALK_DIR, { recursive: true })
  if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"))
}
function saveCache() { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)) }

// ── determinism ──────────────────────────────────────────────────────────────
let uuidCounter = 0
let seed = 910
function seededUuid(): string {
  uuidCounter++
  const n = uuidCounter.toString(16).padStart(12, "0")
  return `${UUID_PREFIX}${"0".repeat(4)}-0000-4000-8000-${n}`
}
export function installDeterminism() {
  ;(nodeCrypto as any).randomUUID = seededUuid
  try { (globalThis.crypto as any).randomUUID = seededUuid } catch { /* read-only in some runtimes */ }
  syncBuiltinESMExports()
  Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  const realFetch = globalThis.fetch
  void realFetch
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input)
    externalCalls.push(url)
    throw new Error(`[mcp-bridge] external call refused in the walkthrough: ${url}`)
  }) as typeof fetch
}

// ── SQL helpers ──────────────────────────────────────────────────────────────
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`
function pgArrayLiteral(arr: unknown[]): string {
  const inner = arr.map((v) => v === null ? "NULL" : `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")
  return q(`{${inner}}`)
}
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "boolean") return v ? "true" : "false"
  if (v instanceof Date) return q(v.toISOString())
  if (Array.isArray(v)) return v.some((x) => x && typeof x === "object") ? q(JSON.stringify(v)) : pgArrayLiteral(v)
  if (typeof v === "object") return q(JSON.stringify(v))
  return q(String(v))
}

function colExpr(alias: string, name: string): string {
  const m = name.match(/^([A-Za-z0-9_]+)((?:->>?[^->]+)*)$/)
  if (!m) return `${alias}.${ident(name)}`
  let out = `${alias}.${ident(m[1])}`
  const parts = m[2].match(/->>?[^->]+/g) ?? []
  for (const p of parts) {
    const op = p.startsWith("->>") ? "->>" : "->"
    const key = p.slice(op.length)
    out += /^\d+$/.test(key) ? `${op}${key}` : `${op}${q(key)}`
  }
  return out
}

// PostgREST value strings (.or / .filter / .not)
function splitTop(s: string, sep = ","): string[] {
  const out: string[] = []; let depth = 0, cur = "", inQ = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' && s[i - 1] !== "\\") inQ = !inQ
    if (!inQ && (c === "(" || c === "{" || c === "[")) depth++
    if (!inQ && (c === ")" || c === "}" || c === "]")) depth--
    if (!inQ && depth === 0 && c === sep) { out.push(cur); cur = ""; continue }
    cur += c
  }
  if (cur.length) out.push(cur)
  return out
}
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s)

function opSql(alias: string, col: string, op: string, raw: unknown, fromString: boolean): string {
  const c = colExpr(alias, col)
  const val = (v: unknown) => fromString ? q(unquote(String(v))) : lit(v)
  switch (op) {
    case "eq": return `${c} = ${val(raw)}`
    case "neq": return `${c} <> ${val(raw)}`
    case "gt": return `${c} > ${val(raw)}`
    case "gte": return `${c} >= ${val(raw)}`
    case "lt": return `${c} < ${val(raw)}`
    case "lte": return `${c} <= ${val(raw)}`
    case "like": return `${c} LIKE ${q(String(fromString ? unquote(String(raw)) : raw).replace(/\*/g, "%"))}`
    case "ilike": return `${c} ILIKE ${q(String(fromString ? unquote(String(raw)) : raw).replace(/\*/g, "%"))}`
    case "match": return `${c} ~ ${val(raw)}`
    case "imatch": return `${c} ~* ${val(raw)}`
    case "is": {
      const v = String(raw).toLowerCase()
      return `${c} IS ${v === "null" ? "NULL" : v === "true" ? "TRUE" : v === "false" ? "FALSE" : "UNKNOWN"}`
    }
    case "isdistinct": return `${c} IS DISTINCT FROM ${val(raw)}`
    case "in": {
      let items: unknown[]
      if (fromString || typeof raw === "string") {
        const s = String(raw).trim().replace(/^\(/, "").replace(/\)$/, "")
        items = s.length ? splitTop(s).map((x) => unquote(x.trim())) : []
      } else items = (raw as unknown[]) ?? []
      if (!items.length) return "false"
      return `${c} IN (${items.map((x) => (x === null ? "NULL" : q(String(x)))).join(", ")})`
    }
    case "cs": return `${c} @> ${fromString ? q(String(raw)) : lit(raw)}`
    case "cd": return `${c} <@ ${fromString ? q(String(raw)) : lit(raw)}`
    case "ov": {
      if (fromString) { const s = String(raw).replace(/^\(/, "{").replace(/\)$/, "}"); return `${c} && ${q(s)}` }
      return `${c} && ${lit(raw)}`
    }
    case "fts": return `${c} @@ to_tsquery(${val(raw)})`
    case "plfts": return `${c} @@ plainto_tsquery(${val(raw)})`
    case "phfts": return `${c} @@ phraseto_tsquery(${val(raw)})`
    case "wfts": return `${c} @@ websearch_to_tsquery(${val(raw)})`
    default: throw new Error(`[mcp-bridge] unsupported filter operator: ${op}`)
  }
}

function parseLogic(alias: string, expr: string, joiner: "OR" | "AND"): string {
  const parts = splitTop(expr).map((p) => p.trim()).filter(Boolean)
  const rendered = parts.map((p) => {
    const lm = p.match(/^(not\.)?(and|or)\((.*)\)$/s)
    if (lm) { const inner = parseLogic(alias, lm[3], lm[2] === "and" ? "AND" : "OR"); return lm[1] ? `NOT (${inner})` : `(${inner})` }
    const i1 = p.indexOf(".")
    const col = p.slice(0, i1)
    let rest = p.slice(i1 + 1)
    let neg = false
    if (rest.startsWith("not.")) { neg = true; rest = rest.slice(4) }
    const i2 = rest.indexOf(".")
    const op = rest.slice(0, i2)
    const v = rest.slice(i2 + 1)
    const s = opSql(alias, col, op, v, true)
    return neg ? `NOT (${s})` : s
  })
  return rendered.length ? rendered.join(` ${joiner} `) : "true"
}

// ── select-string parsing & embeds ──────────────────────────────────────────
interface SelItem { kind: "star" }
interface ColItem { kind: "col"; out: string; expr: string; cast?: string }
interface EmbedItem { kind: "embed"; out: string; name: string; hints: string[]; inner: boolean; sub: Item[] }
type Item = SelItem | ColItem | EmbedItem

function parseSelect(s: string): Item[] {
  const items: Item[] = []
  for (let raw of splitTop(s.replace(/\s+/g, ""))) {
    if (!raw) continue
    if (raw === "*") { items.push({ kind: "star" }); continue }
    const pm = raw.indexOf("(")
    if (pm > 0 && raw.endsWith(")")) {
      let head = raw.slice(0, pm)
      const sub = parseSelect(raw.slice(pm + 1, -1))
      let out: string | null = null
      if (head.startsWith("...")) throw new Error("[mcp-bridge] spread embeds are not supported")
      const am = head.match(/^([A-Za-z0-9_]+):(.*)$/)
      if (am) { out = am[1]; head = am[2] }
      const segs = head.split("!")
      const name = segs[0]
      const hints = segs.slice(1).filter((h) => h !== "inner" && h !== "left")
      const inner = segs.includes("inner")
      items.push({ kind: "embed", out: out ?? name, name, hints, inner, sub })
      continue
    }
    let out: string | null = null
    const am = raw.match(/^([A-Za-z0-9_]+):(.*)$/)
    if (am) { out = am[1]; raw = am[2] }
    let cast: string | undefined
    const cm = raw.match(/^(.*)::([A-Za-z0-9_ \[\]]+)$/)
    if (cm) { raw = cm[1]; cast = cm[2] }
    const lastKey = raw.split(/->>?/).pop() as string
    items.push({ kind: "col", out: out ?? lastKey, expr: raw, cast })
  }
  return items
}

interface Rel { kind: "m2o" | "o2m"; target: string; fkCol: string }
function resolveRel(parent: string, name: string, hints: string[]): Rel | BridgeError {
  const pmap = SCHEMA_FK_MAP[parent] ?? {}
  if (pmap[name]) return { kind: "m2o", target: pmap[name], fkCol: name }
  const target = name
  const tmap = SCHEMA_FK_MAP[target] ?? {}
  const m2o = Object.keys(pmap).filter((c) => pmap[c] === target)
  const o2m = Object.keys(tmap).filter((c) => tmap[c] === parent)
  for (const h of hints) {
    if (m2o.includes(h)) return { kind: "m2o", target, fkCol: h }
    if (o2m.includes(h)) return { kind: "o2m", target, fkCol: h }
    const pm = h.match(new RegExp(`^${parent}_(.+)_fkey$`))
    if (pm && m2o.includes(pm[1])) return { kind: "m2o", target, fkCol: pm[1] }
    const tm = h.match(new RegExp(`^${target}_(.+)_fkey$`))
    if (tm && o2m.includes(tm[1])) return { kind: "o2m", target, fkCol: tm[1] }
  }
  const total = m2o.length + o2m.length
  if (total === 0) return { message: `Could not find a relationship between '${parent}' and '${name}' in the schema cache`, code: "PGRST200", details: null, hint: null }
  if (total > 1) return { message: `Could not embed because more than one relationship was found for '${parent}' and '${name}'`, code: "PGRST201", details: `m2o: ${m2o.join(",")} o2m: ${o2m.join(",")}`, hint: "use !<fk> to disambiguate" }
  return m2o.length ? { kind: "m2o", target, fkCol: m2o[0] } : { kind: "o2m", target, fkCol: o2m[0] }
}

interface EmbedMods { filters: string[]; order: string[]; limit?: number; offset?: number }
let aliasN = 0
function renderSelect(table: string, alias: string, items: Item[], where: string[], mods: Record<string, EmbedMods>, path: string, schema = "public"): { sql: string; err?: BridgeError } {
  const cols: string[] = []
  const extraWhere: string[] = []
  for (const it of items.length ? items : [{ kind: "star" } as Item]) {
    if (it.kind === "star") { cols.push(`${alias}.*`); continue }
    if (it.kind === "col") { const e = colExpr(alias, it.expr); cols.push(`${it.cast ? `(${e})::${it.cast}` : e} AS ${ident(it.out)}`); continue }
    const rel = resolveRel(table, it.name, it.hints)
    if ("code" in rel) return { sql: "", err: rel }
    const a = `e${++aliasN}`
    const key = path ? `${path}.${it.out}` : it.out
    const keyByName = path ? `${path}.${it.name}` : it.name
    const m = mods[key] ?? mods[keyByName] ?? { filters: [], order: [] }
    const join = rel.kind === "m2o" ? `${a}."id" = ${alias}.${ident(rel.fkCol)}` : `${a}.${ident(rel.fkCol)} = ${alias}."id"`
    const subWhere = [join, ...m.filters.map((f) => f.replace(/__ALIAS__/g, a))]
    const inner = renderSelect(rel.target, a, it.sub, subWhere, mods, key)
    if (inner.err) return inner
    let body = inner.sql
    if (m.order.length) body += ` ORDER BY ${m.order.map((o) => o.replace(/__ALIAS__/g, a)).join(", ")}`
    if (m.limit !== undefined) body += ` LIMIT ${m.limit}`
    if (m.offset !== undefined) body += ` OFFSET ${m.offset}`
    if (rel.kind === "m2o") cols.push(`(SELECT to_jsonb(s) FROM (${body} LIMIT 1) s) AS ${ident(it.out)}`)
    else cols.push(`(SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM (${body}) s) AS ${ident(it.out)}`)
    if (it.inner) extraWhere.push(`EXISTS (SELECT 1 FROM ${schema}.${ident(rel.target)} ${a}x WHERE ${subWhere.map((w) => w.split(`${a}.`).join(`${a}x.`).split(`${a}"`).join(`${a}x"`)).join(" AND ")})`)
  }
  const w = [...where, ...extraWhere]
  return { sql: `SELECT ${cols.join(", ")} FROM ${schema}.${ident(table)} ${alias}${w.length ? ` WHERE ${w.join(" AND ")}` : ""}` }
}

function projectRow(row: any, items: Item[]): any {
  if (!row || !items.length || items.some((i) => i.kind === "star")) return row
  const out: any = {}
  for (const it of items) if (it.kind === "col") out[it.out] = row[it.expr.split(/->>?/)[0]]
  return out
}

// ── the replay engine ───────────────────────────────────────────────────────
interface Actor { kind: "service" }
interface DbActor { kind: "db" }
interface UserActor { kind: "user"; userId: string; email: string; claims?: Record<string, unknown> }
type AnyActor = Actor | DbActor | UserActor

function roleWrap(actor: AnyActor): string {
  // "db" = the MCP session role: only for the auth.users emulation (GoTrue writes as supabase_auth_admin, not service_role).
  if (actor.kind === "db") return ""
  if (actor.kind === "service") return `EXECUTE 'SET LOCAL ROLE service_role'; PERFORM set_config('request.jwt.claims', ${q(JSON.stringify({ role: "service_role" }))}, true);`
  const claims = { sub: actor.userId, email: actor.email, role: "authenticated", aud: "authenticated", ...(actor.claims ?? {}) }
  return `EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM set_config('request.jwt.claims', ${q(JSON.stringify(claims))}, true); PERFORM set_config('request.jwt.claim.sub', ${q(actor.userId)}, true);`
}

/** Identity of a call independent of wall-clock values (ISO timestamps normalised). */
function callKey(actor: AnyActor, sql: string, needsResult: boolean): string {
  const norm = `${roleWrap(actor)}|${needsResult ? "R" : "W"}|${sql}`.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "TS")
  return nodeCrypto.createHash("sha1").update(norm).digest("hex")
}

export let stopped = false
let lastCallAt = Date.now()
/** Let un-awaited background chains (fire-and-forget work a function started)
 *  drain before the scenario's next step, so their calls land in the same slots
 *  every run. Resolves after `idleMs` with no bridge call; throws BridgeStop if
 *  a background call stopped the run meanwhile. */
export async function quiesce(idleMs = 400): Promise<void> {
  for (let n = 0; n < 200; n++) {
    await new Promise((r) => setTimeout(r, 50))
    if (stopped) throw new BridgeStop()
    if (Date.now() - lastCallAt >= idleMs) return
  }
}
async function call(sig: string, actor: AnyActor, sql: string, needsResult: boolean, label?: string, shadowEmpty = false): Promise<any> {
  // A stop may be swallowed by the caller's own try/catch; every later call
  // re-throws without recording, and the runner checks `stopped` itself.
  if (stopped) throw new BridgeStop()
  lastCallAt = Date.now()
  const i = callIndex++
  const key = callKey(actor, sql, needsResult)
  let hit: CacheEntry | undefined = cache.entries[i]
  // CONCURRENCY: an un-awaited background chain (e.g. the onboarding curriculum a
  // tenant creation starts) interleaves with the scenario, and module-load timing
  // can swap adjacent calls between runs. A cached DONE entry further ahead with
  // the SAME identity (sig + timestamp-normalised SQL) is this call: swap it in.
  if (hit && hit.status === "done" && (hit.sig !== sig || (hit.key && hit.key !== key))) {
    for (let j = i + 1; j < cache.entries.length; j++) {
      const e = cache.entries[j]
      if (e && e.status === "done" && e.sig === sig && e.key === key) { cache.entries[j] = hit; cache.entries[i] = e; hit = e; break }
    }
    // Not cached anywhere ahead: this call was scheduled EARLIER than last run.
    // Splice it in; the cached entry (and everything after) moves down one slot.
    if (hit.sig !== sig || (hit.key && hit.key !== key)) { cache.entries.splice(i, 0, undefined as unknown as CacheEntry); hit = undefined }
  }
  if (hit && hit.status === "pending" && (hit.sig !== sig || (hit.key && hit.key !== key))) { cache.entries.length = i; hit = undefined }
  if (hit) {
    if (hit.sig !== sig) {
      console.error(`DIVERGED at call ${i}: cached ${hit.sig} vs now ${sig}`)
      process.exit(4)
    }
    if (hit.status === "done") {
      if (!hit.key) hit.key = key
      return hit.result
    }
  }
  const stmt = `${roleWrap(actor)} EXECUTE $w91s$${sql}$w91s$${needsResult ? " INTO v" : ""}; EXECUTE 'RESET ROLE';`
  // REPEAT READ: the identical read (same SQL, same role/claims) already answered
  // with only reads since → the DB state is unchanged, reuse it (label repeat:read).
  // Writes in between are tolerated when they touched OTHER tables (published blind
  // spot: a cross-table trigger that rewrites the re-read row would be missed).
  const readTable = sig.slice("select:".length)
  if (needsResult && sig.startsWith("select:") && !pending.some((p) => p.sig.endsWith(`:${readTable}`) || p.sig.startsWith("rpc:") || p.sig.startsWith("auth:"))) {
    for (let j = i - 1; j >= 0; j--) {
      const e = cache.entries[j]
      if (!e) break
      if (!e.sig.startsWith("select:")) { if (e.sig.endsWith(`:${readTable}`) || e.sig.startsWith("rpc:") || e.sig.startsWith("auth:")) break; continue }
      if (e.key === key && e.status === "done" && !e.result?.error) { cache.entries[i] = { sig, status: "done", result: e.result, label: "repeat:read", key }; return e.result }
    }
  }
  if (shadowEmpty) {
    const result = { rows: { rows: [], count: 0 } }
    cache.entries[i] = { sig, status: "done", result, label: "shadow:empty", key }
    return result
  }
  if (!needsResult) {
    pending.push({ index: i, sql: stmt, sig })
    cache.entries[i] = { sig, status: "pending", sql: stmt, label, key }
    return { rows: null, provisional: true }
  }
  pending.push({ index: i, sql: stmt + ` PERFORM set_config('w91.r', coalesce(v::text, 'null'), true);`, sig })
  cache.entries[i] = { sig, status: "pending", label, key }
  flushBatch()
  stopped = true
  throw new BridgeStop()
}

function shadowEmptyOk(table: string): boolean {
  const m = cache.meta
  if (!m?.nz || m.nzAt === undefined || stopped || pending.length) return false
  if (m.nz.includes(table)) return false
  // only reads (or earlier shadow answers) between the snapshot and this call
  for (let i = m.nzAt + 1; i < callIndex; i++) { const e = cache.entries[i]; if (!e || !e.sig.startsWith("select:")) return false }
  return true
}
function flushBatch() {
  if (!pending.length) return
  const blocks = pending.map((p) => `  IF current_setting('w91.e', true) IS NULL OR current_setting('w91.e', true) = '' THEN BEGIN ${p.sql} EXCEPTION WHEN others THEN PERFORM set_config('w91.e', ${p.index} || '|' || SQLSTATE || '|' || SQLERRM, true); END; END IF;`).join("\n")
  const scope = cache.meta?.scope
  const hasWrite = pending.some((x) => !x.sig.startsWith("select:"))
  const nzBlock = scope && (hasWrite || cache.meta?.nzAt === undefined) ? `\n  DECLARE tn text; ex boolean; acc text := ''; BEGIN FOR tn IN SELECT c.table_name FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.column_name = 'brokerage_id' LOOP BEGIN EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE brokerage_id = $1)', tn) INTO ex USING ${q(scope)}::uuid; IF ex THEN acc := acc || tn || ','; END IF; EXCEPTION WHEN others THEN acc := acc || tn || ','; END; END LOOP; PERFORM set_config('w91.nz', acc, true); END;` : ""
  const sql = `DO $w91do$ DECLARE v jsonb; BEGIN\n  PERFORM set_config('w91.e', '', true); PERFORM set_config('w91.r', '', true); PERFORM set_config('w91.nz', '', true);\n${blocks}${nzBlock}\nEND $w91do$;\nSELECT jsonb_build_object('first', ${pending[0].index}, 'last', ${pending[pending.length - 1].index}, 'err', current_setting('w91.e', true), 'nz', nullif(current_setting('w91.nz', true), ''), 'r', nullif(current_setting('w91.r', true), '')::jsonb) AS r;`
  fs.writeFileSync(batchPath(), sql)
  saveCache()
}

/** Ingest the execute_sql answer for the last batch. */
export function ingest(file: string) {
  loadCache()
  let raw = fs.readFileSync(file, "utf8").trim()
  let parsed: any = JSON.parse(raw)
  if (Array.isArray(parsed)) parsed = parsed[0]?.r ?? parsed[0]
  if (parsed?.r && parsed.first === undefined) parsed = parsed.r
  const first = parsed.first as number, last = parsed.last as number
  // "=" is the agent's shorthand for "the same list as the previous snapshot".
  if (parsed.nz === "=" && cache.meta?.nz) cache.meta = { ...cache.meta, nzAt: last }
  else if (typeof parsed.nz === "string" && parsed.nz !== "=" && cache.meta?.scope) cache.meta = { ...cache.meta, nz: parsed.nz.split(",").filter(Boolean), nzAt: last }
  else if (cache.meta?.nz && cache.entries.slice(first, last + 1).every((e) => e?.sig.startsWith("select:"))) cache.meta.nzAt = last
  else if (cache.meta) { delete cache.meta.nz; delete cache.meta.nzAt }
  const err = String(parsed.err ?? "")
  let failedAt = -1, code = "", message = ""
  if (err) { const [a, b, ...c] = err.split("|"); failedAt = Number(a); code = b; message = c.join("|") }
  for (let i = first; i <= last; i++) {
    const e = cache.entries[i]
    if (!e || e.status === "done") continue
    if (failedAt >= 0 && i > failedAt) { cache.entries.length = i; break }
    if (failedAt === i) { e.status = "done"; e.result = { error: { message, code, details: null, hint: null } }; delete e.sql; cache.entries.length = i + 1; break }
    e.status = "done"
    e.result = i === last && e.sql === undefined ? { rows: parsed.r } : { rows: null }
    delete e.sql
  }
  saveCache()
  fs.rmSync(batchPath(), { force: true })
}

/** Called at the end of a scenario run: deferred writes still pending → flush. */
export function finish(): boolean {
  if (pending.length) { flushBatch(); return false }
  saveCache()
  return true
}

// ── query builder ────────────────────────────────────────────────────────────
type Verb = "select" | "insert" | "upsert" | "update" | "delete" | "rpc"
class Builder implements PromiseLike<any> {
  private verb: Verb = "select"
  private cols = "*"
  private returning: string | null = null
  private filters: string[] = []
  private embedMods: Record<string, EmbedMods> = {}
  private orders: string[] = []
  private lim?: number
  private off?: number
  private countMode: string | null = null
  private head = false
  private singleMode: "single" | "maybe" | null = null
  private values: any = null
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  private rpcArgs: Record<string, unknown> = {}
  constructor(private table: string, private actor: AnyActor, private schema = "public") {}
  private mod(path: string) { return (this.embedMods[path] ??= { filters: [], order: [] }) }
  private addFilter(col: string, op: string, v: unknown, fromString = false) {
    const dot = col.indexOf(".")
    if (dot > 0 && !col.includes("->")) { const p = col.slice(0, dot); this.mod(p).filters.push(opSql("__ALIAS__", col.slice(dot + 1), op, v, fromString)); return this }
    this.filters.push(opSql("t", col, op, v, fromString)); return this
  }
  select(cols = "*", opts: { count?: string; head?: boolean } = {}) {
    if (this.verb === "select" || this.verb === "rpc") { this.cols = cols } else { this.returning = cols }
    if (opts.count) this.countMode = opts.count
    if (opts.head) this.head = true
    return this
  }
  insert(values: any, opts: { count?: string } = {}) { this.verb = "insert"; this.values = values; if (opts.count) this.countMode = opts.count; return this }
  upsert(values: any, opts: { onConflict?: string; ignoreDuplicates?: boolean; count?: string } = {}) { this.verb = "upsert"; this.values = values; this.upsertOpts = opts; if (opts.count) this.countMode = opts.count; return this }
  update(values: any, opts: { count?: string } = {}) { this.verb = "update"; this.values = values; if (opts.count) this.countMode = opts.count; return this }
  delete(opts: { count?: string } = {}) { this.verb = "delete"; if (opts.count) this.countMode = opts.count; return this }
  rpc(args: Record<string, unknown>, opts: { count?: string; head?: boolean } = {}) { this.verb = "rpc"; this.rpcArgs = args ?? {}; if (opts.head) this.head = true; return this }
  eq(c: string, v: unknown) { return this.addFilter(c, "eq", v) }
  neq(c: string, v: unknown) { return this.addFilter(c, "neq", v) }
  gt(c: string, v: unknown) { return this.addFilter(c, "gt", v) }
  gte(c: string, v: unknown) { return this.addFilter(c, "gte", v) }
  lt(c: string, v: unknown) { return this.addFilter(c, "lt", v) }
  lte(c: string, v: unknown) { return this.addFilter(c, "lte", v) }
  like(c: string, v: unknown) { return this.addFilter(c, "like", v) }
  ilike(c: string, v: unknown) { return this.addFilter(c, "ilike", v) }
  is(c: string, v: unknown) { return this.addFilter(c, "is", v === null ? "null" : String(v)) }
  in(c: string, v: unknown[]) { return this.addFilter(c, "in", v) }
  contains(c: string, v: unknown) { return this.addFilter(c, "cs", v) }
  containedBy(c: string, v: unknown) { return this.addFilter(c, "cd", v) }
  overlaps(c: string, v: unknown) { return this.addFilter(c, "ov", v) }
  textSearch(c: string, v: string, o: { type?: string } = {}) { return this.addFilter(c, o.type === "plain" ? "plfts" : o.type === "phrase" ? "phfts" : o.type === "websearch" ? "wfts" : "fts", v) }
  match(obj: Record<string, unknown>) { for (const [k, v] of Object.entries(obj)) this.addFilter(k, "eq", v); return this }
  not(c: string, op: string, v: unknown) {
    const s = opSql("t", c, op, op === "in" && Array.isArray(v) ? v : v === null ? "null" : v, typeof v === "string" && op !== "is")
    this.filters.push(`NOT (${s})`); return this
  }
  filter(c: string, op: string, v: unknown) {
    if (op.startsWith("not.")) { const s = opSql("t", c, op.slice(4), v, true); this.filters.push(`NOT (${s})`); return this }
    return this.addFilter(c, op, v, true)
  }
  or(expr: string, opts: { foreignTable?: string; referencedTable?: string } = {}) {
    const ft = opts.referencedTable ?? opts.foreignTable
    if (ft) { this.mod(ft).filters.push(`(${parseLogic("__ALIAS__", expr, "OR")})`); return this }
    this.filters.push(`(${parseLogic("t", expr, "OR")})`); return this
  }
  order(c: string, o: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string } = {}) {
    const ft = o.referencedTable ?? o.foreignTable
    const dir = o.ascending === false ? "DESC" : "ASC"
    const nulls = o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST"
    if (ft) { this.mod(ft).order.push(`${colExpr("__ALIAS__", c)} ${dir}${nulls}`); return this }
    this.orders.push(`${colExpr("t", c)} ${dir}${nulls}`); return this
  }
  limit(n: number, o: { foreignTable?: string; referencedTable?: string } = {}) {
    const ft = o.referencedTable ?? o.foreignTable
    if (ft) { this.mod(ft).limit = n; return this }
    this.lim = n; return this
  }
  range(from: number, to: number, o: { foreignTable?: string; referencedTable?: string } = {}) {
    const ft = o.referencedTable ?? o.foreignTable
    if (ft) { this.mod(ft).offset = from; this.mod(ft).limit = to - from + 1; return this }
    this.off = from; this.lim = to - from + 1; return this
  }
  single() { this.singleMode = "single"; return this }
  maybeSingle() { this.singleMode = "maybe"; return this }
  abortSignal() { return this }
  returns() { return this }
  overrideTypes() { return this }
  throwOnError() { return this }
  csv() { return this }

  private tbl() { return `${this.schema}.${ident(this.table)}` }

  private async exec(): Promise<any> {
    const sig = `${this.verb}:${this.table}`
    const where = this.filters.length ? ` WHERE ${this.filters.join(" AND ")}` : ""
    try {
      if (this.verb === "select") {
        aliasN = 0
        const items = parseSelect(this.cols)
        const r = renderSelect(this.table, "t", items, this.filters, this.embedMods, "", this.schema)
        if (r.err) return { data: null, error: r.err, count: null, status: 400 }
        let body = r.sql
        if (this.orders.length) body += ` ORDER BY ${this.orders.join(", ")}`
        const lim = this.singleMode === "single" || this.singleMode === "maybe" ? Math.min(this.lim ?? 2, 2) : this.lim
        if (lim !== undefined) body += ` LIMIT ${lim}`
        if (this.off !== undefined) body += ` OFFSET ${this.off}`
        const countSql = this.countMode ? `(SELECT count(*) FROM ${this.tbl()} t${where})` : "NULL"
        const rowsSql = this.head ? "NULL" : `(SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM (${body}) s)`
        const scope = cache.meta?.scope
        const shadow = !!scope && this.filters.includes(`t."brokerage_id" = ${q(scope)}`) && shadowEmptyOk(this.table)
        const res = await call(sig, this.actor, `SELECT jsonb_build_object('rows', ${rowsSql}, 'count', ${countSql})`, true, undefined, shadow)
        return this.shape(res, null)
      }
      if (this.verb === "rpc") {
        const args = Object.entries(this.rpcArgs).filter(([, v]) => v !== undefined).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(", ")
        const fn = `${this.schema}.${ident(this.table)}(${args})`
        const res = await call(`rpc:${this.table}`, this.actor,
          `SELECT jsonb_build_object('retset', (SELECT bool_or(proretset) FROM pg_proc WHERE proname = ${q(this.table)}), 'rows', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM ${fn} x))`, true)
        if (res.error) return { data: null, error: res.error, count: null, status: 400 }
        const payload = res.rows ?? {}
        const rows: any[] = payload.rows ?? []
        const scalar = rows.length > 0 && rows.every((r) => r && typeof r === "object" && Object.keys(r).length === 1 && Object.keys(r)[0] === this.table)
        let data: any = scalar ? rows.map((r) => r[this.table]) : rows
        if (!payload.retset) data = Array.isArray(data) ? (data.length ? data[0] : null) : data
        return { data, error: null, count: null, status: 200 }
      }
      // writes
      if ((this.verb === "update" || this.verb === "delete") && !this.filters.length) {
        return { data: null, error: { message: "[mcp-bridge] refused: UPDATE/DELETE without a filter", code: "BRIDGE", details: null, hint: null }, count: null, status: 400 }
      }
      let sql = ""
      // ID SYNTHESIS: an INSERT that only asks for `id` back, on a table whose PK is a
      // defaulted uuid, gets its ids assigned HERE (seeded 91d0… uuids) and is deferred
      // like any write — the caller receives exactly the ids the rows will carry, and a
      // refused insert still surfaces its error at this index on replay.
      const retOnly = this.returning !== null ? parseSelect(this.returning) : []
      const synthRows = Array.isArray(this.values) ? this.values : [this.values]
      // Every column asked back is `id` or a value the caller itself supplied on every row
      // (published blind spot: a BEFORE trigger that rewrites a supplied value is not seen).
      const idOnly = retOnly.length >= 1 && retOnly.every((it) => it.kind === "col" && /^[A-Za-z0-9_]+$/.test((it as ColItem).expr)
        && ((it as ColItem).expr === "id" || synthRows.every((r: any) => r && Object.prototype.hasOwnProperty.call(r, (it as ColItem).expr) && r[(it as ColItem).expr] !== undefined)))
        && retOnly.some((it) => (it as ColItem).expr === "id")
      // A LEGACY entry (a real insert-returning answered before synthesis existed) at
      // this slot keeps the legacy path; otherwise synthesis is decided by the call's
      // own shape, never by what happens to sit at this index (background chains shift it).
      const peek = cache.entries[callIndex]
      const legacy = !!peek && peek.status === "done" && peek.sig === sig && peek.label !== "synth:id"
      if (!stopped && !legacy && this.verb === "insert" && idOnly && !this.countMode && UUID_ID_TABLES.has(this.table) && synthRows.every((r: any) => r && r.id === undefined)) {
        const withIds = synthRows.map((r: any) => ({ id: seededUuid(), ...r }))
        this.values = Array.isArray(this.values) ? withIds : withIds[0]
        const ids = withIds.map((r: any) => Object.fromEntries(retOnly.map((it) => [(it as ColItem).out, r[(it as ColItem).expr] ?? null])))
        const keys = Array.from(new Set(withIds.flatMap((r: any) => Object.keys(r).filter((k) => r[k] !== undefined))))
        const json = JSON.stringify(withIds.map((r: any) => Object.fromEntries(keys.map((k) => [k, r?.[k] === undefined ? null : r[k]]))))
        const isql = `INSERT INTO ${this.tbl()} AS t (${keys.map(ident).join(", ")}) SELECT ${keys.map((k) => `p.${ident(k)}`).join(", ")} FROM jsonb_populate_recordset(NULL::${this.tbl()}, ${q(json)}::jsonb) p`
        const res = await call(sig, this.actor, isql, false, "synth:id")
        if (res.error) return { data: null, error: res.error, count: null, status: 400 }
        return this.shape({ rows: { rows: ids, count: ids.length } }, null)
      }
      if (this.verb === "insert" || this.verb === "upsert") {
        const rows = Array.isArray(this.values) ? this.values : [this.values]
        const keys = Array.from(new Set(rows.flatMap((r: any) => Object.keys(r ?? {}).filter((k) => r[k] !== undefined))))
        const json = JSON.stringify(rows.map((r: any) => Object.fromEntries(keys.map((k) => [k, r?.[k] === undefined ? null : r[k]]))))
        const colList = keys.map(ident).join(", ")
        sql = `INSERT INTO ${this.tbl()} AS t (${colList}) SELECT ${keys.map((k) => `p.${ident(k)}`).join(", ")} FROM jsonb_populate_recordset(NULL::${this.tbl()}, ${q(json)}::jsonb) p`
        if (this.verb === "upsert") {
          const conflict = this.upsertOpts.onConflict ? this.upsertOpts.onConflict.split(",").map((s) => s.trim()) : null
          const target = conflict ? `(${conflict.map(ident).join(", ")})` : `ON CONSTRAINT ${ident(`${this.table}_pkey`)}`
          const updCols = keys.filter((k) => !(conflict ?? ["id"]).includes(k))
          sql += this.upsertOpts.ignoreDuplicates || !updCols.length
            ? ` ON CONFLICT ${conflict ? target : ""} DO NOTHING`
            : ` ON CONFLICT ${target} DO UPDATE SET ${updCols.map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(", ")}`
        }
      } else if (this.verb === "update") {
        const keys = Object.keys(this.values ?? {}).filter((k) => this.values[k] !== undefined)
        if (!keys.length) return { data: null, error: { message: "[mcp-bridge] empty update", code: "BRIDGE", details: null, hint: null }, count: null, status: 400 }
        sql = `UPDATE ${this.tbl()} AS t SET ${keys.map((k) => `${ident(k)} = p.${ident(k)}`).join(", ")} FROM jsonb_populate_record(NULL::${this.tbl()}, ${q(JSON.stringify(this.values))}::jsonb) p${where}`
      } else {
        sql = `DELETE FROM ${this.tbl()} AS t${where}`
      }
      const needs = this.returning !== null || !!this.countMode || !!this.singleMode
      if (!needs) {
        const res = await call(sig, this.actor, sql, false)
        if (res.error) return { data: null, error: res.error, count: null, status: 400 }
        return { data: null, error: null, count: null, status: this.verb === "insert" ? 201 : 204 }
      }
      // Project plain returning columns in SQL so the answer carries only what the caller asked for.
      const retItems = this.returning !== null ? parseSelect(this.returning) : []
      const plain = retItems.length > 0 && retItems.every((i) => i.kind === "col" && /^[A-Za-z0-9_]+$/.test((i as ColItem).expr))
      const rowJson = plain ? `jsonb_build_object(${retItems.map((i) => `${q((i as ColItem).out)}, w.${ident((i as ColItem).expr)}`).join(", ")})` : this.returning === null ? `jsonb_build_object('id', to_jsonb(w)->'id')` : "to_jsonb(w)"
      const res = await call(sig, this.actor, `WITH w AS (${sql} RETURNING t.*) SELECT jsonb_build_object('rows', coalesce((SELECT jsonb_agg(${rowJson}) FROM w), '[]'::jsonb), 'count', (SELECT count(*) FROM w))`, true)
      return this.shape(res, this.returning !== null ? parseSelect(this.returning) : [])
    } catch (e) {
      if (e instanceof BridgeStop) throw e
      return { data: null, error: { message: (e as Error).message, code: "BRIDGE", details: null, hint: null }, count: null, status: 400 }
    }
  }

  private shape(res: any, project: Item[] | null) {
    if (res.error) return { data: null, error: res.error, count: null, status: 400 }
    const payload = res.rows ?? {}
    let rows: any[] | null = payload.rows ?? null
    if (rows && project) rows = rows.map((r) => projectRow(r, project))
    const count = payload.count ?? null
    if (this.head) return { data: null, error: null, count, status: 200 }
    if (this.singleMode) {
      const n = rows?.length ?? 0
      if (n === 1) return { data: rows![0], error: null, count, status: 200 }
      if (n === 0 && this.singleMode === "maybe") return { data: null, error: null, count, status: 200 }
      return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116", details: `The result contains ${n} rows`, hint: null }, count, status: 406 }
    }
    return { data: this.verb === "select" || this.returning !== null ? rows : null, error: null, count, status: 200 }
  }

  then<A = any, B = never>(ok?: ((v: any) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.exec().then(ok, bad)
  }
}

// ── auth emulation ──────────────────────────────────────────────────────────
function demoEmailOk(email: string | null | undefined) { return !!email && email.toLowerCase().endsWith(DEMO_EMAIL_SUFFIX) }
function authAdmin(actor: AnyActor) {
  const refuse = (what: string) => ({ data: { user: null }, error: { message: `[mcp-bridge] auth.admin.${what} refused: only ${DEMO_EMAIL_SUFFIX} demo users`, status: 400, code: "BRIDGE" } })
  async function create(email: string, meta: Record<string, unknown>, confirmed: boolean, invited: boolean, what: string) {
    if (!demoEmailOk(email)) return refuse(what)
    emulations.push(`auth.admin.${what}(${email}) → SQL insert into auth.users (GoTrue not reachable; no mail sent)`)
    const id = seededUuid()
    const peek = cache.entries[callIndex]
    const legacyAuth = !!peek && peek.status === "done" && peek.sig === `auth:${what}` && peek.label !== "synth:auth"
    if (!stopped && !legacyAuth) {
      // Deferred like any write: the caller gets the user it asked for (the id is ours),
      // and a refused insert still surfaces its error at this index on replay.
      const r = await call(`auth:${what}`, { kind: "db" }, `INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, invited_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES ('00000000-0000-0000-0000-000000000000', ${q(id)}, 'authenticated', 'authenticated', ${q(email.toLowerCase())}, '', ${confirmed ? "now()" : "NULL"}, ${invited ? "now()" : "NULL"}, '{"provider":"email","providers":["email"]}'::jsonb, ${q(JSON.stringify(meta ?? {}))}::jsonb, now(), now(), '', '', '', '')`, false, "synth:auth")
      if (r.error) return { data: { user: null }, error: { message: r.error.message, status: 422, code: r.error.code } }
      return { data: { user: { id, email: email.toLowerCase(), user_metadata: meta ?? {}, app_metadata: { provider: "email" }, created_at: new Date().toISOString() } }, error: null }
    }
    const res = await call(`auth:${what}`, { kind: "db" },
      `WITH w AS (INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, invited_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES ('00000000-0000-0000-0000-000000000000', ${q(id)}, 'authenticated', 'authenticated', ${q(email.toLowerCase())}, '', ${confirmed ? "now()" : "NULL"}, ${invited ? "now()" : "NULL"}, '{"provider":"email","providers":["email"]}'::jsonb, ${q(JSON.stringify(meta ?? {}))}::jsonb, now(), now(), '', '', '', '') RETURNING id, email, raw_user_meta_data, created_at) SELECT jsonb_build_object('rows', (SELECT jsonb_agg(to_jsonb(w)) FROM w))`, true)
    if (res.error) return { data: { user: null }, error: { message: res.error.message, status: 422, code: res.error.code } }
    const u = res.rows?.rows?.[0]
    return { data: { user: { id: u.id, email: u.email, user_metadata: u.raw_user_meta_data, app_metadata: { provider: "email" }, created_at: u.created_at } }, error: null }
  }
  return {
    createUser: (o: any) => create(o?.email, o?.user_metadata ?? o?.data ?? {}, !!o?.email_confirm, false, "createUser"),
    inviteUserByEmail: (email: string, o: any = {}) => create(email, o?.data ?? {}, false, true, "inviteUserByEmail"),
    generateLink: async (o: any) => {
      if (!demoEmailOk(o?.email)) return refuse("generateLink")
      emulations.push(`auth.admin.generateLink(${o.email}) → fake action_link (no mail sent)`)
      const found = await call("auth:getUserByEmail", { kind: "db" }, `SELECT jsonb_build_object('rows', (SELECT jsonb_agg(jsonb_build_object('id', id, 'email', email)) FROM auth.users WHERE lower(email) = ${q(String(o.email).toLowerCase())}))`, true)
      let user = found.rows?.rows?.[0] ?? null
      if (!user) { const c = await create(o.email, o?.options?.data ?? {}, false, o?.type === "invite", "generateLink"); user = c.data.user }
      return { data: { user, properties: { action_link: `https://demo.invalid/auth/${o?.type ?? "link"}#w91` } }, error: null }
    },
    getUserById: async (id: string) => {
      const r = await call("auth:getUserById", { kind: "db" }, `SELECT jsonb_build_object('rows', (SELECT jsonb_agg(jsonb_build_object('id', id, 'email', email, 'user_metadata', raw_user_meta_data)) FROM auth.users WHERE id = ${q(id)}))`, true)
      const u = r.rows?.rows?.[0] ?? null
      return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "User not found", status: 404 } }
    },
    listUsers: async () => {
      emulations.push(`auth.admin.listUsers → only ${DEMO_EMAIL_SUFFIX} users returned (no real user PII leaves the DB)`)
      const r = await call("auth:listUsers", { kind: "db" }, `SELECT jsonb_build_object('rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'email', email, 'user_metadata', raw_user_meta_data)), '[]'::jsonb) FROM auth.users WHERE lower(email) LIKE ${q("%" + DEMO_EMAIL_SUFFIX)}))`, true)
      return { data: { users: r.rows?.rows ?? [] }, error: null }
    },
    updateUserById: async (id: string, attrs: any) => {
      emulations.push(`auth.admin.updateUserById(${id}) → user_metadata only`)
      await call("auth:updateUserById", { kind: "db" }, `UPDATE auth.users SET raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || ${q(JSON.stringify(attrs?.user_metadata ?? {}))}::jsonb WHERE id = ${q(id)} AND lower(email) LIKE ${q("%" + DEMO_EMAIL_SUFFIX)}`, false)
      return { data: { user: { id } }, error: null }
    },
    deleteUser: async (id: string) => {
      await call("auth:deleteUser", { kind: "db" }, `DELETE FROM auth.users WHERE id = ${q(id)} AND lower(email) LIKE ${q("%" + DEMO_EMAIL_SUFFIX)}`, false)
      return { data: {}, error: null }
    },
  }
}

export function makeClient(actor: AnyActor): any {
  const client: any = {
    from: (t: string) => new Builder(t, actor),
    schema: (s: string) => ({ from: (t: string) => new Builder(t, actor, s), rpc: (fn: string, a: any, o: any) => new Builder(fn, actor, s).rpc(a, o) }),
    rpc: (fn: string, a: any, o: any) => new Builder(fn, actor).rpc(a, o),
    storage: { from: (b: string) => ({
      upload: async () => ({ data: null, error: { message: `[mcp-bridge] storage '${b}' not reachable from the sandbox` } }),
      getPublicUrl: (p: string) => ({ data: { publicUrl: `https://demo.invalid/storage/${b}/${p}` } }),
      createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://demo.invalid/storage/${b}/${p}?signed` }, error: null }),
      remove: async () => ({ data: [], error: null }),
      list: async () => ({ data: [], error: null }),
      download: async () => ({ data: null, error: { message: "[mcp-bridge] storage not reachable" } }),
    }) },
    functions: { invoke: async (n: string) => ({ data: null, error: { message: `[mcp-bridge] edge function ${n} not invoked from the walkthrough` } }) },
    channel: () => ({ on() { return this }, subscribe() { return this }, unsubscribe: async () => "ok" }),
    removeChannel: async () => "ok",
    auth: {
      admin: authAdmin(actor),
      getUser: async () => actor.kind === "user" ? { data: { user: { id: actor.userId, email: actor.email, user_metadata: {}, app_metadata: {} } }, error: null } : { data: { user: null }, error: { message: "Auth session missing!", status: 400 } },
      getSession: async () => actor.kind === "user" ? { data: { session: { access_token: "w91-demo", user: { id: actor.userId, email: actor.email } } }, error: null } : { data: { session: null }, error: null },
      getClaims: async () => actor.kind === "user" ? { data: { claims: { sub: actor.userId, email: actor.email, role: "authenticated" } }, error: null } : { data: null, error: { message: "no session" } },
      signOut: async () => ({ error: null }),
      exchangeCodeForSession: async () => ({ data: null, error: { message: "[mcp-bridge] not supported" } }),
      signInWithPassword: async () => ({ data: null, error: { message: "[mcp-bridge] not supported" } }),
    },
  }
  return client
}

// ── the current actor (what createClient() in lib/supabase/server returns) ──
let currentActor: AnyActor = { kind: "service" }
export function actAs(a: { userId: string; email: string } | null) { currentActor = a ? { kind: "user", ...a } : { kind: "service" } }
export function currentUserClient() { return makeClient(currentActor) }
export function serviceClient() { return makeClient({ kind: "service" }) }

export function start() { loadCache(); installDeterminism() }
/** SHADOW ANSWERS. Set the walk's tenant: every batch then also returns the
 *  list of brokerage-scoped tables/views that hold ANY row for it (nz). A later
 *  plain SELECT filtered by `brokerage_id = <scope>` on a table NOT in nz, with
 *  only reads between that snapshot and now, is answered "no rows" locally —
 *  the DB state is known exactly, so no round trip is spent. Recorded in the
 *  cache as label "shadow:empty" so the audit shows which answers were local. */
export function setScopeBrokerage(id: string | null) { cache.meta = { ...(cache.meta ?? {}), scope: id ?? undefined } }
export function isStopped() { return stopped }
export function stats() { return { calls: callIndex, cached: cache.entries.filter((e) => e.status === "done").length } }
