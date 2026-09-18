// lib/kernel/schema-memory.ts
//
// SCHEMA MEMORY (cron_manager) — the last tier of the owner's drift doc:
// "the OS remembers every historical payload shape by connector, so it can
// recognize repeat drift patterns instantly." Every inbound provider payload
// stamps its SHAPE FINGERPRINT (the sorted key paths, not the values — no
// PII stored) into connector_shape_memory. A fingerprint the connector has
// never sent before is a SHAPE CHANGE — announced in the weekly repair
// digest BEFORE anything quarantines, so drift is detected ahead of drift
// damage. Known fingerprints just bump last_seen/hits (cheap upsert).

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** Depth kept small on purpose: shape identity, not full structure dumps. */
const MAX_DEPTH = 3
const MAX_KEYS = 120

/** PURE: the sorted key-path list that IS a payload's shape (values never included). */
export function extractShapeKeys(raw: unknown, depth = 0, prefix = ""): string[] {
  if (depth >= MAX_DEPTH || raw == null || typeof raw !== "object") return []
  const keys: string[] = []
  if (Array.isArray(raw)) {
    // An array's shape is its first element's shape (homogeneous provider lists).
    return extractShapeKeys(raw[0], depth + 1, `${prefix}[]`)
  }
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    keys.push(path)
    keys.push(...extractShapeKeys((raw as Record<string, unknown>)[k], depth + 1, path))
    if (keys.length >= MAX_KEYS) break
  }
  return keys.sort().slice(0, MAX_KEYS)
}

/** PURE: stable fingerprint of a payload's shape (djb2 over the sorted key paths). */
export function shapeFingerprint(raw: unknown): string {
  const s = extractShapeKeys(raw).join("|")
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Remember one payload's shape. Returns whether this is a NEW shape for a
 * connector that already had history (the "shape changed" signal — a
 * connector's very FIRST shape is baseline, not change). Best-effort, never
 * throws, never blocks the caller's webhook response.
 */
export async function rememberShape(svc: Svc, input: {
  connector: string
  entity: string
  raw: unknown
}): Promise<{ fingerprint: string; isShapeChange: boolean }> {
  const fingerprint = shapeFingerprint(input.raw)
  try {
    const nowIso = new Date().toISOString()
    const { data: existing } = await svc.from("connector_shape_memory")
      .select("id, hits").eq("connector", input.connector).eq("entity", input.entity)
      .eq("fingerprint", fingerprint).maybeSingle()
    if (existing) {
      await svc.from("connector_shape_memory")
        .update({ last_seen_at: nowIso, hits: ((existing as any).hits ?? 0) + 1 })
        .eq("id", (existing as any).id)
      return { fingerprint, isShapeChange: false }
    }
    const { count } = await svc.from("connector_shape_memory")
      .select("id", { count: "exact", head: true })
      .eq("connector", input.connector).eq("entity", input.entity)
    await svc.from("connector_shape_memory").insert({
      connector: input.connector,
      entity: input.entity,
      fingerprint,
      shape_keys: extractShapeKeys(input.raw),
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      hits: 1,
    }).then(() => {}, () => {}) // unique race with a concurrent webhook is fine
    return { fingerprint, isShapeChange: (count ?? 0) > 0 }
  } catch {
    return { fingerprint, isShapeChange: false }
  }
}

export interface ShapeChange {
  connector: string
  entity: string
  fingerprint: string
  firstSeenAt: string
  /** connector_shape_memory.last_seen_at — is the provider STILL sending this shape, or
   *  was it a one-off? A change that has kept arriving is a contract change; one seen
   *  once and never again is a blip. Written on every payload (:64/:77) and, until w26,
   *  read by nothing. */
  lastSeenAt: string | null
  /** Key paths this shape has that the connector's PREVIOUS shape did not. */
  addedKeys: string[]
  /** Key paths the previous shape had that this one DROPPED — the half that breaks a
   *  parser, and the half a fingerprint alone can never name. */
  removedKeys: string[]
  /** True when the diff could not be computed (a prior row carried no shape_keys), so
   *  empty added/removed means "unknown", not "nothing changed". */
  diffUnavailable: boolean
}

/**
 * Shapes first seen in the window on connectors that had prior history — the digest's
 * early-warning line.
 *
 * WHAT CHANGED, NOT JUST THAT SOMETHING DID (w26 lane C8). `shape_keys` is the sorted
 * key-path list this module exists to remember (:75) and `last_seen_at` its recency
 * (:64/:77); neither was ever read back, so both the weekly digest and the continuity
 * board could only say "connector X started sending a new payload shape" and name an
 * opaque djb2 fingerprint. The one fact an operator needs — WHICH FIELD appeared or
 * disappeared — was stored on every row and shown on none. This diffs the new shape
 * against the connector's most recent PRIOR shape and reports both sides.
 */
export async function loadRecentShapeChanges(svc: Svc, sinceIso: string): Promise<ShapeChange[]> {
  const { data, error } = await svc.from("connector_shape_memory")
    .select("connector, entity, fingerprint, first_seen_at, last_seen_at, shape_keys")
    .gte("first_seen_at", sinceIso).order("first_seen_at", { ascending: false }).limit(50)
  // §3 — a refused read resolves as data:null, and "no drift this week" is this
  // function's normal answer, so the refusal would read as a clean bill of health.
  if (error) {
    console.error("[schema-memory] shape-change read refused:", error.message)
    return []
  }
  const rows = ((data ?? []) as any[])
  const out: ShapeChange[] = []
  for (const r of rows) {
    // ONE read answers both questions: `count` says whether this connector/entity had
    // prior history at all (the original predicate), and the single row returned is the
    // most recent prior shape to diff against.
    const { data: priorRows, count, error: priorError } = await svc.from("connector_shape_memory")
      .select("shape_keys, first_seen_at", { count: "exact" })
      .eq("connector", r.connector).eq("entity", r.entity).lt("first_seen_at", r.first_seen_at)
      .order("first_seen_at", { ascending: false }).limit(1)
    if (priorError) {
      console.error("[schema-memory] prior-shape read refused:", priorError.message)
      continue
    }
    if ((count ?? 0) === 0) continue // first shape ever for this connector — baseline, not change

    const nextKeys = Array.isArray(r.shape_keys) ? (r.shape_keys as string[]) : null
    const prior = (priorRows ?? [])[0] as { shape_keys: unknown } | undefined
    const priorKeys = Array.isArray(prior?.shape_keys) ? (prior!.shape_keys as string[]) : null
    const diffUnavailable = nextKeys === null || priorKeys === null
    const priorSet = new Set(priorKeys ?? [])
    const nextSet = new Set(nextKeys ?? [])

    out.push({
      connector: r.connector,
      entity: r.entity,
      fingerprint: r.fingerprint,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: (r.last_seen_at as string | null) ?? null,
      addedKeys: diffUnavailable ? [] : (nextKeys as string[]).filter((k) => !priorSet.has(k)),
      removedKeys: diffUnavailable ? [] : (priorKeys as string[]).filter((k) => !nextSet.has(k)),
      diffUnavailable,
    })
  }
  return out
}
