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
    let op: "select" | "insert" | "update" | "delete" = "select"
    let patch: Row | null = null
    let inserted: Row[] | null = null
    let cols: string[] | null = null
    let limitN: number | null = null
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
      if (op === "insert") {
        const made: Row[] = []
        for (const r of inserted ?? []) {
          const row: Row = { id: r.id ?? `${table}-${++seq}`, ...r }
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
      if (limitN !== null) matched = matched.slice(0, limitN)
      return { data: matched.map(project), error: null }
    }

    const b: any = {
      select(c?: string) { cols = c ? c.split(",").map((s) => s.trim()) : ["*"]; if (op !== "select") selectAfterWrite = true; return b },
      insert(rowOrRows: Row | Row[]) { op = "insert"; inserted = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]; return b },
      update(p: Row) { op = "update"; patch = p; return b },
      delete() { op = "delete"; return b },
      eq(col: string, v: unknown) { filterCols.push(col); filters.push((r) => val(r, col) === v); return b },
      neq(col: string, v: unknown) { filterCols.push(col); filters.push((r) => val(r, col) !== v); return b },
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
        const terms = expr.split(",").map((t) => {
          const m = /^([\w]+)\.(eq|is)\.(.*)$/.exec(t.trim())
          if (!m) throw new Error(`memSupabase: unsupported or() term "${t}"`)
          filterCols.push(m[1])
          return m
        })
        filters.push((r) => terms.some(([, col, op, v]) =>
          op === "eq" ? String(val(r, col)) === v
          : v === "null" ? val(r, col) === null || val(r, col) === undefined
          : (() => { throw new Error(`memSupabase: unsupported or() is.${v}`) })()))
        return b
      },
      gte(col: string, v: any) { filterCols.push(col); filters.push((r) => val(r, col) !== null && val(r, col) !== undefined && val(r, col) >= v); return b },
      lte(col: string, v: any) { filterCols.push(col); filters.push((r) => val(r, col) !== null && val(r, col) !== undefined && val(r, col) <= v); return b },
      gt(col: string, v: any) { filters.push((r) => val(r, col) > v); return b },
      lt(col: string, v: any) { filters.push((r) => val(r, col) < v); return b },
      order(col: string, o?: { ascending?: boolean }) { orderBy = { col, asc: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
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
