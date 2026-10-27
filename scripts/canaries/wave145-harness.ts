/**
 * scripts/canaries/wave145-harness.ts — the WAVE-145 owner-ruling canaries' shared plumbing (lane 145J).
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT A SECOND HARNESS. Everything a canary does still goes through the survivors:
 *   · scripts/canaries/_harness.ts  — canary() (step / rule / pendingOwner / report), canaryClient, cleanupCanary, landedModule;
 *   · scripts/canaries/_registry.ts — rulingVerdict (the verdict table), findLanded / strippedRepo / listFiles (STRIPPED source,
 *     CLAUDE.md §2 — a tombstone or a comment is never a landing).
 * This module adds only what wave 145 needs on top:
 *   1. the roster (WAVE145_CANARY_KEYS — eight canaries, one per area of the "Required proofs" list);
 *   2. the wave-145 owner tags (145A–145I | "defect") — the verdict table reads the owner as a string, so a 145 owner prints
 *      red-awaiting-lane-145X exactly as a 144 owner printed red-awaiting-lane-144X;
 *   3. THE CONTRACT BINDER (bindContract): a cross-lane contract from WAVE145_SPEC.md (C1–C7) or a name a lane PUBLISHED in its
 *      notes' "## Canary requirements" — the module FILE plus its exported NAMES. Absent file → the step is red-awaiting-lane-X
 *      with the contract name in its evidence; a file that exists but fails to load → RED (a broken landing is a failure, never a
 *      quiet "not yet" — the 144 rule); landed → the canary DRIVES the export against the RULING (never the lane's internal shape).
 *   4. check(): a ruling step whose body may throw (a landed module misbehaving) records RED for that owner with the error — one
 *      bad landing never takes the rest of the canary down with it.
 *
 * The step is red at b364eb4b wherever HEAD does not yet behave as ruled, and turns green the moment the lane's behaviour lands
 * — with no edit in between — because the binder keys on the contract's FILE and NAMES, which the spec fixes.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { canary, landedModule, type RulingOwner } from "./_harness"
import { ROOT, listFiles } from "./_registry"

/** The eight areas of the ChatGPT "Required proofs" list, in run order. */
export const WAVE145_CANARY_KEYS = [
  "wave145-security", "wave145-listings", "wave145-financial", "wave145-providers",
  "wave145-lead-contact", "wave145-signals", "wave145-marketing", "wave145-compliance-ux",
] as const
export type Wave145CanaryKey = (typeof WAVE145_CANARY_KEYS)[number]

export type Wave145Lane = "145A" | "145B" | "145C" | "145D" | "145E" | "145F" | "145G" | "145H" | "145I"
/** "integrator": an item every lane routed OUTSIDE its domain (named in their notes' Outside-lane) — reported as
 *  red-awaiting-lane-integrator, never as a lane's defect. */
export type Ruling145Owner = Wave145Lane | "integrator" | "defect"

/** Each lane's migration numbers (WAVE145_SPEC "Migration numbers" — never another lane's). */
export const WAVE145_MIGRATION_RANGES: Readonly<Record<Wave145Lane, readonly [number, number]>> = Object.freeze({
  "145A": [854, 855], "145B": [856, 857], "145C": [858, 861], "145D": [862, 862], "145E": [863, 863],
  "145F": [864, 865], "145G": [866, 867], "145H": [868, 869], "145I": [870, 870],
})

/** The lane whose range holds migration number `n`, or null (pure). */
export function laneOfMigration(n: number): Wave145Lane | null {
  for (const [lane, [lo, hi]] of Object.entries(WAVE145_MIGRATION_RANGES) as Array<[Wave145Lane, readonly [number, number]]>) if (n >= lo && n <= hi) return lane
  return null
}

/** Every wave-145 migration file present (repo-relative), with its number and owning lane. */
export function wave145Migrations(): Array<{ file: string; num: number; lane: Wave145Lane; sql: string }> {
  const out: Array<{ file: string; num: number; lane: Wave145Lane; sql: string }> = []
  for (const f of listFiles("supabase/migrations", (p) => /\/m\d{3}-[^/]+\.sql$/.test(p))) {
    const num = Number(/\/m(\d{3})-/.exec(f)?.[1])
    const lane = laneOfMigration(num)
    if (!lane) continue
    out.push({ file: f, num, lane, sql: readFileSync(join(ROOT, f), "utf8") })
  }
  return out.sort((a, b) => a.num - b.num)
}

/** A migration's header rule (preamble): line 1 is the lane stamp OR the integrator's APPLIED LIVE marker — the RULE, not a waypoint. */
export function migrationHeaderOk(sql: string, lane: Wave145Lane): boolean {
  const first = sql.split("\n", 1)[0] ?? ""
  return first.startsWith(`-- WRITTEN, NOT APPLIED (wave 145, lane ${lane})`) || first.startsWith("-- ── APPLIED LIVE ")
}

/** SQL with `--` comment lines dropped (a prose line naming a statement is not the statement). */
export function sqlCode(sql: string): string {
  return sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
}

export function canary145(chain: string) {
  const c = canary(chain)
  // The 144 harness types the owner as a 144 lane; the runner and rulingVerdict read it as a string (red-awaiting-lane-<owner>).
  // Outside-lane (lane 145J notes): widen RulingOwner in _harness.ts to carry Wave145Lane, then this cast goes.
  const own = (o: Ruling145Owner) => o as unknown as RulingOwner
  const api = {
    rule: (o: Ruling145Owner, step: string, ok: boolean, evidence = ""): boolean => c.rule(own(o), step, ok, evidence),
    pendingOwner: (o: Ruling145Owner, step: string, ok: boolean, decision: string, evidence = ""): boolean => c.pendingOwner(own(o), step, ok, decision, evidence),
    step: c.step,
    blind: c.blind,
    report: c.report,
    /** A ruling step whose body may throw: a throw is RED for that owner, with the error as evidence. */
    async check(o: Ruling145Owner, step: string, body: () => Promise<{ ok: boolean; evidence: string }> | { ok: boolean; evidence: string }): Promise<boolean> {
      try {
        const r = await body()
        return c.rule(own(o), step, r.ok, r.evidence)
      } catch (e) {
        return c.rule(own(o), step, false, `THREW: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400))
      }
    },
  }
  return api
}

/** A cross-lane CONTRACT: the file the spec (or the lane's published "Canary requirements") names, and the exports it must carry. */
export interface Contract { id: string; lane: Wave145Lane; file: string; exports: readonly string[] }

export interface Bound {
  /** The landed module — only when the FILE exists, loads, and carries EVERY named export. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a landed module is driven by its contract names
  mod: Record<string, any> | null
  landed: boolean
  missing: string[]
  evidence: string
}

/** Bind a contract (see the header). Never throws: a load failure is reported in `evidence` with `landed: true, mod: null`. */
export async function bindContract(k: Contract): Promise<Bound> {
  if (!existsSync(join(ROOT, k.file))) return { mod: null, landed: false, missing: [...k.exports], evidence: `${k.id}: ${k.file} not landed — awaiting lane ${k.lane} (contract names: ${k.exports.join(", ")})` }
  let mod: Record<string, unknown> | null
  try {
    mod = await landedModule<Record<string, unknown>>(`../../${k.file}`)
  } catch (e) {
    return { mod: null, landed: true, missing: [...k.exports], evidence: `${k.id}: ${k.file} EXISTS but FAILED TO LOAD — ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }
  }
  const missing = k.exports.filter((n) => !mod || !(n in mod))
  return missing.length
    ? { mod: null, landed: true, missing, evidence: `${k.id}: ${k.file} landed WITHOUT ${missing.join(", ")} (lane ${k.lane})` }
    : { mod: mod as Record<string, unknown>, landed: true, missing: [], evidence: `${k.id}: ${k.file} exports ${k.exports.join(", ")}` }
}

/**
 * THE CROSS-LANE CONTRACTS (WAVE145_SPEC "CROSS-LANE CONTRACTS" — the names are binding; whoever lands first, the other wires to
 * the name). A canary asserts these names and the RULE behind them, never a lane's internal shape.
 */
export const CONTRACTS = {
  C1_MATRIX: { id: "C1 provider matrix", lane: "145D", file: "lib/providers/channel-provider-matrix.ts", exports: ["CHANNEL_PROVIDER_MATRIX", "AD_PLATFORMS", "TV_AD_PROVIDER"] },
  C2_BOUNDARY: { id: "C2 lead/contact boundary", lane: "145E", file: "lib/contact-promotion/lead-domain-boundary.ts", exports: ["isInLeadDomain", "canonicalPartyFor"] },
  C3_ACCESSIBILITY: { id: "C3 accessibility preferences", lane: "145H", file: "lib/contacts/accessibility-preferences.ts", exports: ["readAccessibilityPreferences"] },
  C4_HUMANIZE: { id: "C4 humanization", lane: "145G", file: "lib/marketing/humanize-final.ts", exports: ["finalizeForDistribution"] },
  C5_CTV_LANE: { id: "C5 topic → TV (creative side)", lane: "145G", file: "lib/marketing/ctv-lane.ts", exports: [] },
} as const satisfies Record<string, Contract>

/** Silence a kernel call's console chatter; return its value (the canary prints its own evidence). */
// RE-ENTRANT: two quiet() calls in flight together (a Promise.all of kernel calls) must not save each other's no-op as the
// "original" — the first version did, and silenced the runner's RESULT line for the rest of the process. The real console is
// captured once at module load; a depth counter restores it when the LAST quiet call settles.
const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error, info: console.info }
let quietDepth = 0
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  quietDepth += 1
  console.log = console.warn = console.error = console.info = () => {}
  try { return await fn() } finally { quietDepth -= 1; if (quietDepth === 0) Object.assign(console, REAL_CONSOLE) }
}

/** The exported names of a module file in STRIPPED source (pure; used for evidence only). */
export function exportedNames(strippedSrc: string): string[] {
  const out = new Set<string>()
  for (const m of strippedSrc.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1])
  for (const m of strippedSrc.matchAll(/\bexport\s*\{([^}]*)\}/g)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/).pop()?.trim(); if (n) out.add(n) }
  return [...out]
}
