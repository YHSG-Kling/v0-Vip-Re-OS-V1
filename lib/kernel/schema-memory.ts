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

export interface ShapeChange { connector: string; entity: string; fingerprint: string; firstSeenAt: string }

/** Shapes first seen in the window on connectors that had prior history — the digest's early-warning line. */
export async function loadRecentShapeChanges(svc: Svc, sinceIso: string): Promise<ShapeChange[]> {
  const { data } = await svc.from("connector_shape_memory")
    .select("connector, entity, fingerprint, first_seen_at")
    .gte("first_seen_at", sinceIso).order("first_seen_at", { ascending: false }).limit(50)
  const rows = ((data ?? []) as any[])
  const out: ShapeChange[] = []
  for (const r of rows) {
    const { count } = await svc.from("connector_shape_memory")
      .select("id", { count: "exact", head: true })
      .eq("connector", r.connector).eq("entity", r.entity).lt("first_seen_at", r.first_seen_at)
    if ((count ?? 0) > 0) out.push({ connector: r.connector, entity: r.entity, fingerprint: r.fingerprint, firstSeenAt: r.first_seen_at })
  }
  return out
}
