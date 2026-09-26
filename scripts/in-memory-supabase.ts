/**
 * scripts/in-memory-supabase.ts — a small IN-MEMORY supabase-js stand-in for
 * proofs that drive kernel functions end-to-end without a database or the
 * network. Rows live in plain arrays; the builder honours the subset of the
 * query grammar the kernel uses (select / insert / update / eq / neq / in / is
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

export interface MemWrite { table: string; op: "insert" | "update"; payload: Row; matched: number }

/** The fake, typed as the client the kernel signatures take, plus the proof's window onto its rows. */
export type MemClient = SupabaseClient<any, any, any> & { tables: Record<string, Row[]>; writes: MemWrite[] }

export interface MemOptions {
  /** Tables that "do not exist" — every read/write resolves with a 42P01 error. */
  missingTables?: string[]
  /** Columns that "do not exist" per table — a select / patch naming one resolves with 42703. */
  missingColumns?: Record<string, string[]>
  /** Tables whose every access is refused with this message (RLS-shaped). */
  refuse?: Record<string, string>
}

type Filter = (row: Row) => boolean

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
    let op: "select" | "insert" | "update" = "select"
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
      for (const c of cols) out[c] = row[c]
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
          const row = { id: r.id ?? `${table}-${++seq}`, ...r }
          rows.push(row); made.push(row)
        }
        writes.push({ table, op: "insert", payload: inserted?.[0] ?? {}, matched: made.length })
        return { data: selectAfterWrite ? made.map(project) : null, error: null }
      }
      let matched = rows.filter((r) => filters.every((fn) => fn(r)))
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
      eq(col: string, v: unknown) { filterCols.push(col); filters.push((r) => r[col] === v); return b },
      neq(col: string, v: unknown) { filterCols.push(col); filters.push((r) => r[col] !== v); return b },
      in(col: string, vs: string[] | string) { filterCols.push(col); const set = new Set(parseList(vs)); filters.push((r) => set.has(String(r[col]))); return b },
      is(col: string, v: unknown) { filterCols.push(col); filters.push((r) => (v === null ? r[col] === null || r[col] === undefined : r[col] === v)); return b },
      not(col: string, operator: string, v: unknown) {
        filterCols.push(col)
        if (operator === "in") { const set = new Set(parseList(v as string)); filters.push((r) => !set.has(String(r[col]))) }
        else if (operator === "is") filters.push((r) => (v === null ? !(r[col] === null || r[col] === undefined) : r[col] !== v))
        else if (operator === "eq") filters.push((r) => r[col] !== v)
        else throw new Error(`memSupabase: unsupported not(${operator})`)
        return b
      },
      gte(col: string, v: any) { filterCols.push(col); filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] >= v); return b },
      lte(col: string, v: any) { filterCols.push(col); filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] <= v); return b },
      gt(col: string, v: any) { filters.push((r) => r[col] > v); return b },
      lt(col: string, v: any) { filters.push((r) => r[col] < v); return b },
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
