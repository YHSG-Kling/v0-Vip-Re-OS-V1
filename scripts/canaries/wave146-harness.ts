/**
 * scripts/canaries/wave146-harness.ts — the WAVE-146 owner-ruling canaries' shared plumbing (lane 146J).
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT A THIRD HARNESS. Everything still goes through the survivors:
 *   · scripts/canaries/_harness.ts       — canary() (step / rule / pendingOwner / report), canaryClient, landedModule;
 *   · scripts/canaries/_registry.ts      — rulingVerdict (the verdict table), strippedRepo / listFiles (STRIPPED source, CLAUDE.md §2);
 *   · scripts/canaries/wave145-harness.ts — canary145().check (a throwing ruling step is RED for its owner), bindContract (absent
 *     FILE → red-awaiting-lane with the contract named; a file that fails to load → RED; a missing export → landed WITHOUT), quiet(),
 *     sqlCode(), exportedNames().
 * This module adds only what wave 146 needs on top:
 *   1. the roster (WAVE146_CANARY_KEYS — seven canaries, one per proof family of ruling 20: security · communications · welcome ·
 *      customer 360 · ads · deliverables · managers/UI);
 *   2. the wave-146 owner tags (146A–146I | "integrator" | "defect") and the wave-146 migration ranges (WAVE146_SPEC "Migration numbers");
 *   3. CONTRACTS_146 — C1–C7 of WAVE146_SPEC "CROSS-LANE CONTRACTS" by FILE + exported NAMES (the names are binding; a canary asserts
 *      the NAME and the RULING behind it, never a lane's internal shape — the lane-145Z re-assertion lesson);
 *   4. tableDiff(): a SHAPE-AGNOSTIC observation of what a landed door wrote to an in-memory client (rows added per table), so a
 *      contract can be held to "idempotent", "tenant-pinned" and "nothing written" without knowing which survivor table it chose.
 *
 * The step is red at bf67aa63 wherever HEAD does not yet behave as ruled, and turns green the moment the lane's behaviour lands —
 * with no edit in between — because the binder keys on the contract's FILE and NAMES, which the spec fixes.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { RulingOwner } from "./_harness"
import { ROOT, listFiles } from "./_registry"
import { bindContract, canary145, type Bound, type Contract, type Ruling145Owner } from "./wave145-harness"

/** The seven proof families of ruling 20 / the "Required proofs" list, in run order. */
export const WAVE146_CANARY_KEYS = [
  "wave146-security", "wave146-communications", "wave146-welcome", "wave146-customer360",
  "wave146-ads", "wave146-deliverables", "wave146-managers-ui",
] as const
export type Wave146CanaryKey = (typeof WAVE146_CANARY_KEYS)[number]

// 146Z (convergence, after the nine lanes landed) writes m888+ — added so the stamp / tenancy census SEES its
// migrations instead of skipping numbers outside every range (a blind spot, not a relaxation).
export type Wave146Lane = "146A" | "146B" | "146C" | "146D" | "146E" | "146F" | "146G" | "146H" | "146I" | "146Z"
/** "integrator": an item every lane routed OUTSIDE its domain — red-awaiting-lane-integrator, never a lane's defect. */
export type Ruling146Owner = Wave146Lane | "integrator" | "defect"

/** Each lane's migration numbers (WAVE146_SPEC "Migration numbers" — never another lane's). */
export const WAVE146_MIGRATION_RANGES: Readonly<Record<Wave146Lane, readonly [number, number]>> = Object.freeze({
  "146A": [874, 875], "146B": [876, 877], "146C": [878, 878], "146D": [879, 880], "146E": [881, 882],
  "146F": [883, 884], "146G": [885, 885], "146H": [886, 886], "146I": [887, 887], "146Z": [888, 899],
})

/** The lane whose range holds migration number `n`, or null (pure). */
export function laneOfMigration146(n: number): Wave146Lane | null {
  for (const [lane, [lo, hi]] of Object.entries(WAVE146_MIGRATION_RANGES) as Array<[Wave146Lane, readonly [number, number]]>) if (n >= lo && n <= hi) return lane
  return null
}

/** Every wave-146 migration file present (repo-relative), with its number and owning lane. */
export function wave146Migrations(): Array<{ file: string; num: number; lane: Wave146Lane; sql: string }> {
  const out: Array<{ file: string; num: number; lane: Wave146Lane; sql: string }> = []
  for (const f of listFiles("supabase/migrations", (p) => /\/m\d{3}-[^/]+\.sql$/.test(p))) {
    const num = Number(/\/m(\d{3})-/.exec(f)?.[1])
    const lane = laneOfMigration146(num)
    if (!lane) continue
    out.push({ file: f, num, lane, sql: readFileSync(join(ROOT, f), "utf8") })
  }
  return out.sort((a, b) => a.num - b.num)
}

/** A migration's header rule (preamble): line 1 is the lane stamp OR the integrator's APPLIED LIVE marker — the RULE, not a waypoint. */
export function migrationHeaderOk146(sql: string, lane: Wave146Lane): boolean {
  const first = sql.split("\n", 1)[0] ?? ""
  return first.startsWith(`-- WRITTEN, NOT APPLIED (wave 146, lane ${lane})`) || first.startsWith("-- ── APPLIED LIVE ")
}

/**
 * canary146 — canary145 with the wave-146 owner tags. The verdict table reads the owner as a string, so a 146 owner prints
 * red-awaiting-lane-146X exactly as a 145 owner printed red-awaiting-lane-145X; check() is the 145 one (a throw is RED for the owner).
 */
export function canary146(chain: string) {
  const c = canary145(chain)
  // canary145 types its owner as a wave-145 tag and casts to RulingOwner itself; a 146 tag rides the same cast (one cast, one place).
  const own = (o: Ruling146Owner) => o as unknown as Ruling145Owner
  return {
    rule: (o: Ruling146Owner, step: string, ok: boolean, evidence = ""): boolean => c.rule(own(o), step, ok, evidence),
    pendingOwner: (o: Ruling146Owner, step: string, ok: boolean, decision: string, evidence = ""): boolean => c.pendingOwner(own(o), step, ok, decision, evidence),
    check: (o: Ruling146Owner, step: string, body: () => Promise<{ ok: boolean; evidence: string }> | { ok: boolean; evidence: string }): Promise<boolean> => c.check(own(o), step, body),
    step: c.step,
    blind: c.blind,
    report: c.report,
  }
}
export type Canary146 = ReturnType<typeof canary146>
/** For a caller that must hand an owner to the 144 harness directly (never needed by the wave-146 canaries; kept typed). */
export const asRulingOwner = (o: Ruling146Owner): RulingOwner => o as unknown as RulingOwner

/** A wave-146 cross-lane contract: the file the spec (or a lane's published "Canary requirements") names, and its exports. */
export interface Contract146 { id: string; lane: Wave146Lane; file: string; exports: readonly string[] }

/** Bind through the ONE binder (wave145-harness bindContract) — its lane field is evidence text only. */
export function bind146(k: Contract146): Promise<Bound> {
  return bindContract(k as unknown as Contract)
}

/** The C4 signal name, fixed by the spec now (lane F registers it; lane D owns the registry file). */
export const SIGNAL_PROMISE_UNDELIVERED = "lead_magnet_promise_undelivered"

/**
 * THE CROSS-LANE CONTRACTS (WAVE146_SPEC "CROSS-LANE CONTRACTS" — binding names; whoever lands first, the other wires to the name).
 * C7's file exists at HEAD (lane 145D's matrix); its contract is the per-channel `receive` truth, asserted by meaning in the canary.
 */
export const CONTRACTS_146 = {
  C1_INBOUND: { id: "C1 inbound communication record", lane: "146B", file: "lib/communications/inbound-record.ts", exports: ["recordInboundCommunication"] },
  C2_REENGAGE: { id: "C2 audience re-engagement", lane: "146E", file: "lib/ads/audience-reengagement.ts", exports: ["requestAudienceReengagement"] },
  C3_PORTAL_VIDEO: { id: "C3 portal welcome video", lane: "146C", file: "lib/portal/welcome-video.ts", exports: ["portalWelcomeVideoFor"] },
  C4_PROMISES: { id: "C4 promised deliverable", lane: "146F", file: "lib/lead-magnets/promised-deliverables.ts", exports: ["recordPromisedDeliverable", "deliverPromised", "undeliveredPromisesFor"] },
  C5_APPROVER: { id: "C5 approval authority", lane: "146E", file: "lib/kernel/approval-authority.ts", exports: ["approverFor"] },
  C6_C360: { id: "C6 Customer 360 read", lane: "146D", file: "lib/enrichment/customer-360.ts", exports: ["customer360For"] },
  C7_RECEIVE: { id: "C7 provider receive truth", lane: "146B", file: "lib/providers/channel-provider-matrix.ts", exports: ["CHANNEL_PROVIDER_TRUTH", "CHANNEL_PROVIDER_MATRIX"] },
} as const satisfies Record<string, Contract146>

// ── shape-agnostic observation of an in-memory client ─────────────────────────────────────────────────────────────────────────

type Tables = Record<string, Array<Record<string, unknown>>>
/** Row counts per table (a snapshot). */
export function rowCounts(tables: Tables): Record<string, number> {
  return Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length]))
}
/** Rows ADDED per table since `before` (tables that grew only). */
export function tableDiff(before: Record<string, number>, tables: Tables): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [t, rows] of Object.entries(tables)) { const d = rows.length - (before[t] ?? 0); if (d !== 0) out[t] = d }
  return out
}
export const totalAdded = (d: Record<string, number>): number => Object.values(d).reduce((n, x) => n + Math.max(0, x), 0)
/** A JSON snapshot per table (to see UPDATES too — a door that records onto an existing row adds no row). */
export function snapshot(tables: Tables): Record<string, string> {
  return Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, jsonOf(rows)]))
}
/** Tables whose content changed since `snap` (inserted, updated or deleted rows). */
export function changedTables(snap: Record<string, string>, tables: Tables): string[] {
  return Object.entries(tables).filter(([t, rows]) => snap[t] !== jsonOf(rows)).map(([t]) => t)
}
/** Every row in every table whose brokerage_id is set and is NOT `brokerageId` and was not there before (by id). */
export function foreignTenantWrites(beforeIds: Set<string>, tables: Tables, brokerageId: string): string[] {
  const out: string[] = []
  for (const [t, rows] of Object.entries(tables)) for (const r of rows) {
    const id = `${t}:${String(r.id)}`
    if (beforeIds.has(id)) continue
    if (r.brokerage_id != null && r.brokerage_id !== brokerageId) out.push(`${t}(${String(r.brokerage_id)})`)
  }
  return out
}
export function rowIds(tables: Tables): Set<string> {
  const s = new Set<string>()
  for (const [t, rows] of Object.entries(tables)) for (const r of rows) s.add(`${t}:${String(r.id)}`)
  return s
}

/**
 * Call a landed door with the in-memory client however its signature takes one: `(svc, input, …)` when its first parameter is a
 * client (svc / supabase / client / db), else `(input, { client: svc })` — and the harness's service-client stub (setSvc) answers a
 * door that builds its own. The contract fixes the NAME and the input; how the client rides is the lane's (never asserted).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a landed door is driven by its contract name
export function callDoor(fn: (...a: any[]) => unknown, svc: unknown, input: unknown): unknown {
  const first = /^[^(]*\(\s*([A-Za-z_$][\w$]*)/.exec(fn.toString())?.[1] ?? ""
  return /^(svc|supabase|client|db|service|sb)$/i.test(first) ? fn(svc, input) : fn(input, { client: svc, svc, supabase: svc })
}

/** A value's JSON text (for "does this output carry X anywhere" questions), bounded. */
export const jsonOf = (v: unknown): string => { try { return JSON.stringify(v) ?? "" } catch { return String(v) } }

/** Describe a thrown or returned refusal in one line. */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : jsonOf(e)).slice(0, 200)
