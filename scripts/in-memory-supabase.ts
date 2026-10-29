/**
 * scripts/in-memory-supabase.ts — a small IN-MEMORY supabase-js stand-in for
 * proofs that drive kernel functions end-to-end without a database or the
 * network. Rows live in plain arrays; the builder honours the subset of the
 * query grammar the kernel uses (select / insert / update / delete / eq / neq / in / is
 * / not / gte / lte / order / limit / maybeSingle / single / then), and it
 * RESOLVES refusals exactly like supabase-js does (CLAUDE.md §3) — a missing
 * table or column comes back as `{ data: null, error }`, never a throw — so a
 * proof can show a kernel function reading the error.
 *
 * Wave 81A (scripts/managing-broker-guard.ts, scripts/agent-books-reassignment-
 * simulator.ts). Deliberately NOT a general fixture library: every table is a
 * plain array the proof seeds and inspects.
 */

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

export type Row = Record<string, any>

export interface MemWrite { table: string; op: "insert" | "update" | "delete"; payload: Row; matched: number }

/** The fake, typed as the client the kernel signatures take, plus the proof's window onto its rows. */
export type MemClient = SupabaseClient<any, any, any> & { tables: Record<string, Row[]>; writes: MemWrite[] }

export interface MemOptions {
  /** Tables that "do not exist" — every read/write resolves with a 42P01 error. */
  missingTables?: string[]
  /** Columns that "do not exist" per table — a select / patch naming one resolves with 42703. */
  missingColumns?: Record<string, string[]>
  /** Tables whose every access is refused with this message (RLS-shaped). */
  refuse?: Record<string, string>
  /**
   * Stamp `created_at` (ISO now) on inserted rows that carry none — the column DEFAULT
   * now() the live tables have. Off by default so existing proofs see the rows they wrote
   * byte-for-byte (wave 94: the moment dedupe reads `created_at >= since`).
   */
  stampCreatedAt?: boolean
  /** Mint uuid ids for inserted rows that carry none (the live DB's gen_random_uuid()); default `${table}-${n}` for the older proofs' readable ids. */
  uuidIds?: boolean
  /**
   * Wave 141 (lane 141K, the canaries): the live UNIQUE constraints a proof names, per table — each entry a column
   * list. An INSERT whose key columns (all non-null) match an existing row is refused with code 23505 exactly as
   * PostgREST refuses it, so a caller's idempotency that RIDES the constraint (lib/kernel/action-ledger.ts: claim
   * → 23505 → re-read the winner → replay) runs for real instead of acting twice. Upserts are unaffected (they
   * already resolve on their conflict columns). Off by default — existing proofs see exactly what they saw.
   */
  unique?: Record<string, string[][]>
}

type Filter = (row: Row) => boolean

/** A column value, honouring PostgREST's JSON text path `col->>key` (lane 87F; plain columns unchanged). */
function val(row: Row, col: string): any {
  const i = col.indexOf("->>")
  if (i < 0) return row[col]
  const obj = row[col.slice(0, i)]
  if (!obj || typeof obj !== "object") return undefined
  const v = (obj as Row)[col.slice(i + 3)]
  return v === undefined || v === null ? v : typeof v === "string" ? v : String(v)
}

let seq = 0

export function memSupabase(seed: Record<string, Row[]>, opts: MemOptions = {}): MemClient {
  const tables: Record<string, Row[]> = {}
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }))
  const writes: MemWrite[] = []

  const parseList = (v: string | string[]): string[] =>
    Array.isArray(v) ? v : v.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()).filter(Boolean)

  function from(table: string) {
    const filters: Filter[] = []
    /** Columns named by filters — a missing column in a WHERE is a 42703 too. */
    const filterCols: string[] = []
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select"
    let patch: Row | null = null
    let inserted: Row[] | null = null
    let conflictCols: string[] = []
    let cols: string[] | null = null
    let limitN: number | null = null
    /** Wave 141 (lane 141J, the CRM-inbound canary): `.range(from, to)` — PostgREST's inclusive offset window,
     *  the grammar lib/platform/tenant-import.ts pages the dedupe scan with. */
    let offsetN = 0
    let orderBy: { col: string; asc: boolean } | null = null
    let selectAfterWrite = false

    const fail = (): { data: null; error: { message: string; code: string } } | null => {
      if (opts.missingTables?.includes(table)) return { data: null, error: { message: `relation "public.${table}" does not exist`, code: "42P01" } }
      if (opts.refuse?.[table]) return { data: null, error: { message: opts.refuse[table], code: "42501" } }
      const missing = opts.missingColumns?.[table] ?? []
      const named = [...(cols ?? []), ...filterCols, ...Object.keys(patch ?? {}), ...(inserted ?? []).flatMap((r) => Object.keys(r))]
      const hit = named.find((c) => missing.includes(c))
      if (hit) return { data: null, error: { message: `column "${hit}" of relation "${table}" does not exist`, code: "42703" } }
      return null
    }

    const project = (row: Row): Row => {
      if (!cols || cols.includes("*")) return { ...row }
      const out: Row = {}
      for (const c of cols) {
        // Lane 87F — `alias:path` and JSON paths (`raw_data->>subject`) project like PostgREST does.
        const m = /^([A-Za-z_][\w]*):(.+)$/.exec(c)
        if (m) out[m[1]] = val(row, m[2])
        else out[c] = val(row, c)
      }
      return out
    }

    const run = (): { data: any; error: { message: string; code: string } | null } => {
      const f = fail()
      if (f) return f
      if (!tables[table]) tables[table] = []
      const rows = tables[table]
      if (op === "upsert") {
        // Wave 102 (102D): `.upsert(row, { onConflict: "a,b" })` — update the row whose conflict
        // columns match, else insert (the cadence writers' (scope_type, scope_id) shape).
        const made: Row[] = []
        for (const r of inserted ?? []) {
          const hit = conflictCols.length > 0 ? rows.find((x) => conflictCols.every((c) => x[c] === r[c])) : undefined
          if (hit) { Object.assign(hit, r); made.push(hit); continue }
          const row: Row = { id: r.id ?? (opts.uuidIds ? randomUUID() : `${table}-${++seq}`), ...r }
          if (opts.stampCreatedAt && row.created_at === undefined) row.created_at = new Date().toISOString()
          rows.push(row); made.push(row)
        }
        writes.push({ table, op: "insert", payload: inserted?.[0] ?? {}, matched: made.length })
        return { data: selectAfterWrite ? made.map(project) : null, error: null }
      }
      if (op === "insert") {
        const made: Row[] = []
        for (const r of inserted ?? []) {
          // The modelled UNIQUE (opts.unique): a duplicate key is refused 23505, the batch lands nothing further.
          // Wave 146 (lane 146B): a key column may be a JSON text path (`metadata->>provider_ref`) — the partial unique
          // indexes m488 / m876 key on one; `val` reads a plain column exactly as before.
          const dup = (opts.unique?.[table] ?? []).find((key) => key.every((c) => val(r, c) !== undefined && val(r, c) !== null) && rows.some((x) => key.every((c) => val(x, c) === val(r, c))))
          if (dup) {
            writes.push({ table, op: "insert", payload: r, matched: 0 })
            return { data: null, error: { message: `duplicate key value violates unique constraint "${table}_${dup.join("_")}_key"`, code: "23505" } }
          }
          const row: Row = { id: r.id ?? (opts.uuidIds ? randomUUID() : `${table}-${++seq}`), ...r }
          if (opts.stampCreatedAt && row.created_at === undefined) row.created_at = new Date().toISOString()
          rows.push(row); made.push(row)
        }
        writes.push({ table, op: "insert", payload: inserted?.[0] ?? {}, matched: made.length })
        return { data: selectAfterWrite ? made.map(project) : null, error: null }
      }
      let matched = rows.filter((r) => filters.every((fn) => fn(r)))
      if (op === "delete") {
        // Wave 87C (overage claim release): a delete that matches nothing also
        // RESOLVES with no error, exactly like supabase-js (CLAUDE.md §3).
        for (const r of matched) rows.splice(rows.indexOf(r), 1)
        writes.push({ table, op: "delete", payload: {}, matched: matched.length })
        return { data: selectAfterWrite ? matched.map(project) : null, error: null }
      }
      if (op === "update") {
        for (const r of matched) Object.assign(r, patch)
        writes.push({ table, op: "update", payload: patch ?? {}, matched: matched.length })
        return { data: selectAfterWrite ? matched.map(project) : null, error: null }
      }
      if (orderBy) {
        const { col, asc } = orderBy
        matched = [...matched].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (offsetN > 0) matched = matched.slice(offsetN)
      if (limitN !== null) matched = matched.slice(0, limitN)
      return { data: matched.map(project), error: null }
    }

    const b: any = {
      select(c?: string) { cols = c ? c.split(",").map((s) => s.trim()) : ["*"]; if (op !== "select") selectAfterWrite = true; return b },
      insert(rowOrRows: Row | Row[]) { op = "insert"; inserted = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]; return b },
      upsert(rowOrRows: Row | Row[], o?: { onConflict?: string }) { op = "upsert"; inserted = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]; conflictCols = (o?.onConflict ?? "id").split(",").map((s) => s.trim()).filter(Boolean); return b },
      update(p: Row) { op = "update"; patch = p; return b },
      delete() { op = "delete"; return b },
      eq(col: string, v: unknown) { filterCols.push(col); filters.push((r) => val(r, col) === v); return b },
      neq(col: string, v: unknown) { filterCols.push(col); filters.push((r) => val(r, col) !== v); return b },
      // Wave 103 (103D): `.ilike(col, pattern)` — PostgREST's case-insensitive LIKE (`%` / `_`
      // wildcards, `\` escapes). The consented email capture and the vendor-seat contact link match
      // an address case-insensitively; a pattern with no wildcard is case-insensitive equality.
      ilike(col: string, pattern: string) {
        filterCols.push(col)
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]]/g, "\\$&").replace(/\\\\([%_])/g, (_m, c) => (c === "%" ? "\\x25" : "\\x5f")).replace(/%/g, ".*").replace(/_/g, ".")}$`, "i")
        filters.push((r) => typeof val(r, col) === "string" && re.test(val(r, col)))
        return b
      },
      in(col: string, vs: string[] | string) { filterCols.push(col); const set = new Set(parseList(vs)); filters.push((r) => set.has(String(val(r, col)))); return b },
      is(col: string, v: unknown) { filterCols.push(col); filters.push((r) => (v === null ? val(r, col) === null || val(r, col) === undefined : val(r, col) === v)); return b },
      not(col: string, operator: string, v: unknown) {
        filterCols.push(col)
        if (operator === "in") { const set = new Set(parseList(v as string)); filters.push((r) => !set.has(String(val(r, col)))) }
        else if (operator === "is") filters.push((r) => (v === null ? !(val(r, col) === null || val(r, col) === undefined) : val(r, col) !== v))
        else if (operator === "eq") filters.push((r) => val(r, col) !== v)
        else throw new Error(`memSupabase: unsupported not(${operator})`)
        return b
      },
      // PostgREST `.or("a.eq.x,b.eq.y,c.is.null")` — the comma grammar the portal reads use
      // (wave 94). Only `eq` and `is.null` are honoured; anything else THROWS, so a proof can
      // never silently match a filter this fake does not understand.
      or(expr: string) {
        // Wave 102 (102D): + `gte` / `lte` — the attribution's deal window (lib/intelligence/roi-ledger.ts
        // `contract_date.gte.<day>,close_date.gte.<day>`). Everything else still THROWS.
        // Wave 142 (lane 142J, the support-isolation canary): + `in.(a,b,c)` — the platform-staff recipient
        // resolver's grammar (lib/notifications/platform-staff.ts `platform_role.in.(superadmin,admin,…)`). The
        // comma INSIDE the parentheses is part of the term, so terms are split at depth 0 only.
        const rawTerms: string[] = []
        let depth = 0, cur = ""
        for (const ch of expr) {
          if (ch === "(") depth++
          else if (ch === ")") depth = Math.max(0, depth - 1)
          if (ch === "," && depth === 0) { rawTerms.push(cur); cur = "" } else cur += ch
        }
        rawTerms.push(cur)
        const terms = rawTerms.map((t) => {
          const m = /^([\w]+)\.(eq|is|gte|lte|in)\.(.*)$/.exec(t.trim())
          if (!m) throw new Error(`memSupabase: unsupported or() term "${t}"`)
          filterCols.push(m[1])
          return m
        })
        filters.push((r) => terms.some(([, col, op, v]) =>
          op === "eq" ? String(val(r, col)) === v
          : op === "in" ? new Set(parseList(v)).has(String(val(r, col)))
          : op === "gte" ? val(r, col) !== null && val(r, col) !== undefined && String(val(r, col)) >= v
          : op === "lte" ? val(r, col) !== null && val(r, col) !== undefined && String(val(r, col)) <= v
          : v === "null" ? val(r, col) === null || val(r, col) === undefined
          : (() => { throw new Error(`memSupabase: unsupported or() is.${v}`) })()))
        return b
      },
      // Wave 142 (lane 142J, the listing-lifecycle canary): PostgREST's generic `.filter(col, op, value)` — the
      // grammar lib/esign-webhooks/finalize-packet.ts matches signed documents with
      // (`.filter("metadata->>signature_request_id", "eq", envelopeId)`). `eq` / `neq` / `is` (null) / `in`
      // ("(a,b)") are honoured through the same JSON-path reader as `eq`; anything else THROWS, so a proof can
      // never silently match a filter this fake does not understand.
      filter(col: string, operator: string, v: unknown) {
        filterCols.push(col)
        if (operator === "eq") filters.push((r) => val(r, col) === v)
        else if (operator === "neq") filters.push((r) => val(r, col) !== v)
        else if (operator === "is") filters.push((r) => (v === null ? val(r, col) === null || val(r, col) === undefined : val(r, col) === v))
        else if (operator === "in") { const set = new Set(parseList(v as string)); filters.push((r) => set.has(String(val(r, col)))) }
        else throw new Error(`memSupabase: unsupported filter(${operator})`)
        return b
      },
      gte(col: string, v: any) { filterCols.push(col); filters.push((r) => val(r, col) !== null && val(r, col) !== undefined && val(r, col) >= v); return b },
      lte(col: string, v: any) { filterCols.push(col); filters.push((r) => val(r, col) !== null && val(r, col) !== undefined && val(r, col) <= v); return b },
      // Wave 140 (lane 140L, the synthetic canaries): PostgREST array / jsonb containment —
      // `.contains(col, [..])` (@>) and `.overlaps(col, [..])` (&&), the grammar the onboarding
      // curriculum kickoff and education seeders filter by at tenant creation. An object pattern
      // is shallow key/value containment (jsonb @>). Anything else compares equal, like eq.
      contains(col: string, v: unknown) {
        filterCols.push(col)
        filters.push((r) => {
          const x = val(r, col)
          if (Array.isArray(v)) return Array.isArray(x) && v.every((e) => x.includes(e))
          if (v && typeof v === "object") return !!x && typeof x === "object" && Object.entries(v as Row).every(([k, e]) => (x as Row)[k] === e)
          return x === v
        })
        return b
      },
      overlaps(col: string, v: unknown[]) { filterCols.push(col); filters.push((r) => { const x = val(r, col); return Array.isArray(x) && v.some((e) => x.includes(e)) }); return b },
      gt(col: string, v: any) { filters.push((r) => val(r, col) > v); return b },
      lt(col: string, v: any) { filters.push((r) => val(r, col) < v); return b },
      order(col: string, o?: { ascending?: boolean }) { orderBy = { col, asc: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
      range(from: number, to: number) { offsetN = Math.max(0, from); limitN = Math.max(0, to - from + 1); return b },
      maybeSingle: async () => { const r = run(); if (r.error) return r; return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null } },
      single: async () => {
        const r = run(); if (r.error) return r
        const row = Array.isArray(r.data) ? r.data[0] : r.data
        return row ? { data: row, error: null } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } }
      },
      then(res: (v: any) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }

  return { from, tables, writes } as unknown as MemClient
}
