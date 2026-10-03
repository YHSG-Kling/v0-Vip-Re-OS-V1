#!/usr/bin/env tsx
/**
 * scripts/settings-merge-race-simulator.ts   (npm run test:settings-merge-race)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO SAVES THAT LAND TOGETHER BOTH SURVIVE — brokerage_settings.settings is merged BY KEY with
 * a version check (lane 86C; the race lane 84D published).
 *
 * THE DEFECT. ~10 features share the settings jsonb and each wrote it as READ → spread → WRITE
 * THE WHOLE OBJECT. Two writers that both read before either wrote each spread the same old
 * object, and the second silently erased the first one's key, with success reported to both.
 *
 * THE FIX. lib/settings/brokerage-settings-merge.ts mergeBrokerageSettings: the caller's keys
 * are computed from the settings read, the UPDATE is conditioned on the updated_at that was read
 * (compare-and-set, COUNTED), a lost race re-reads and re-merges, a concurrent first insert
 * (23505 on UNIQUE brokerage_id, live) re-runs as an update. No migration (m667 unused): live
 * read 2026-09-27 — UNIQUE (brokerage_id), no updated_at trigger, 0 rows.
 *
 * LAYERS
 *   BEHAVIOUR: an in-memory PostgREST that honours the version predicate and the unique key,
 *     with a BARRIER that makes both writers read before either writes (the race, forced);
 *     driven through the merge writer AND through a real converted writer
 *     (lib/managers/learning-loop.ts setLearnedAdjustmentVeto).
 *   SOURCE (stripped): no module but the merge writer writes the `settings` column.
 * POSITIVE CONTROLS: the pre-86C whole-object writer, under the SAME barrier, loses a key;
 *   the source finder flags the pre-86C writer shape.
 *
 * Run: npx tsx --conditions=react-server scripts/settings-merge-race-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { mergeBrokerageSettings } from "../lib/settings/brokerage-settings-merge"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const B = "bbbbbbbb-0000-4000-8000-000000000001"

type Row = { id: string; brokerage_id: string; settings: Record<string, unknown>; updated_at: string }
/** In-memory brokerage_settings with the live UNIQUE (brokerage_id). `barrier` (when set) holds
 *  every settings READ until `readers` reads are in flight — forcing read/read/write/write. */
function world(opts: { rows?: Row[]; barrier?: number; refuseRead?: boolean; alwaysBump?: boolean } = {}) {
  const table: Row[] = opts.rows ? opts.rows.map((r) => ({ ...r, settings: { ...r.settings } })) : []
  let seq = 0
  let waiting: Array<() => void> = []
  let released = !opts.barrier
  const writes: string[] = []
  const gate = async () => {
    if (released) return
    await new Promise<void>((res) => { waiting.push(res); if (waiting.length >= (opts.barrier ?? 0)) { released = true; waiting.forEach((w) => w()); waiting = [] } })
  }
  const from = (t: string) => {
    if (t !== "brokerage_settings") throw new Error(`unexpected table ${t}`)
    const preds: Array<(r: Row) => boolean> = []
    let op: "select" | "update" | "insert" = "select"
    let payload: any = null
    const q: any = {}
    q.select = () => q
    q.eq = (k: string, v: any) => { preds.push((r: any) => r[k] === v); return q }
    q.is = (k: string, v: any) => { preds.push((r: any) => (r[k] ?? null) === v); return q }
    q.update = (p: any) => { op = "update"; payload = p; return q }
    q.insert = (p: any) => { op = "insert"; payload = p; return q }
    q.upsert = (p: any) => { op = "update"; payload = p; return q }
    q.maybeSingle = async () => {
      if (opts.refuseRead) return { data: null, error: { message: "permission denied for table brokerage_settings" } }
      const snap = table.filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r, settings: JSON.parse(JSON.stringify(r.settings)) }))
      await gate()
      return { data: snap[0] ?? null, error: null }
    }
    q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    const run = () => {
      if (op === "insert") {
        if (table.some((r) => r.brokerage_id === payload.brokerage_id)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"brokerage_settings_brokerage_id_key\"" } }
        const row: Row = { id: `bs-${++seq}`, brokerage_id: payload.brokerage_id, settings: payload.settings, updated_at: new Date(Date.UTC(2026, 8, 27, 0, 0, seq)).toISOString() }
        table.push(row); writes.push(`insert:${Object.keys(row.settings).join(",")}`)
        return { data: [{ id: row.id }], error: null }
      }
      const hit = table.filter((r) => preds.every((p) => p(r)))
      if (opts.alwaysBump) for (const r of table) r.updated_at = new Date(Date.parse(r.updated_at) + 1000).toISOString() // a hostile concurrent writer that always wins
      const still = opts.alwaysBump ? hit.filter((r) => preds.every((p) => p(r))) : hit
      for (const r of still) { Object.assign(r, payload); writes.push(`update:${Object.keys(r.settings).join(",")}`) }
      return { data: still.map((r) => ({ id: r.id })), error: null }
    }
    return q
  }
  return { svc: { from } as any, table, writes }
}

/** The pre-86C writer shape: read → spread → write the whole object (no version predicate). */
async function naiveWrite(svc: any, brokerageId: string, key: string, value: unknown) {
  const { data } = await svc.from("brokerage_settings").select("id, settings").eq("brokerage_id", brokerageId).maybeSingle()
  const next = { ...((data?.settings ?? {}) as Record<string, unknown>), [key]: value }
  if (data) await svc.from("brokerage_settings").update({ settings: next, updated_at: new Date().toISOString() }).eq("brokerage_id", brokerageId)
  else await svc.from("brokerage_settings").insert({ brokerage_id: brokerageId, settings: next })
}

const seedRow = (): Row => ({ id: "bs-0", brokerage_id: B, settings: { ce_provider: { name: "Acme CE" } }, updated_at: "2026-09-26T00:00:00.000Z" })

async function main() {
  console.log("\n[1 · the race, forced: both writers read before either writes]")
  {
    const naive = world({ rows: [seedRow()], barrier: 2 })
    await Promise.all([naiveWrite(naive.svc, B, "business_registration", { ein: "741234567" }), naiveWrite(naive.svc, B, "phone_port_ins", [{ sid: "KW1" }])])
    const s = naive.table[0].settings
    check("POSITIVE CONTROL — the pre-86C whole-object writer LOSES a key under this interleaving", !("business_registration" in s && "phone_port_ins" in s), JSON.stringify(Object.keys(s)))

    const w = world({ rows: [seedRow()], barrier: 2 })
    const [a, b] = await Promise.all([
      mergeBrokerageSettings(w.svc, B, { business_registration: { ein: "741234567" } }),
      mergeBrokerageSettings(w.svc, B, (cur) => ({ phone_port_ins: [...((cur.phone_port_ins as unknown[]) ?? []), { sid: "KW1" }] })),
    ])
    const s2 = w.table[0].settings as any
    check("the merge writer: BOTH keys survive, and the untouched key is carried", a.ok && b.ok && s2.business_registration?.ein === "741234567" && s2.phone_port_ins?.[0]?.sid === "KW1" && s2.ce_provider?.name === "Acme CE", JSON.stringify(s2))
    check("…because exactly one lost the compare-and-set and re-merged (attempts 1 and 2)", a.ok && b.ok && [a.attempts, b.attempts].sort().join(",") === "1,2", JSON.stringify([a, b].map((r) => (r as any).attempts)))
  }
  {
    const w = world({ rows: [seedRow()], barrier: 2 })
    await Promise.all([
      mergeBrokerageSettings(w.svc, B, (cur) => ({ phone_port_ins: [...((cur.phone_port_ins as unknown[]) ?? []), { sid: "KW1" }] })),
      mergeBrokerageSettings(w.svc, B, (cur) => ({ phone_port_ins: [...((cur.phone_port_ins as unknown[]) ?? []), { sid: "KW2" }] })),
    ])
    const list = (w.table[0].settings as any).phone_port_ins as Array<{ sid: string }>
    check("two updates of the SAME key both land (the loser's mutation re-runs on the winner's value)", list.length === 2 && new Set(list.map((x) => x.sid)).size === 2, JSON.stringify(list))
  }

  console.log("\n[2 · the first-ever row, created by two writers at once]")
  {
    const w = world({ barrier: 2 })
    const [a, b] = await Promise.all([
      mergeBrokerageSettings(w.svc, B, { business_registration: { ein: "1" } }),
      mergeBrokerageSettings(w.svc, B, { ai_agent_capabilities: { disabled: ["x"] } }),
    ])
    check("one row, both keys: the unique-key loser (23505) re-ran as a version-checked update",
      a.ok && b.ok && w.table.length === 1 && "business_registration" in w.table[0].settings && "ai_agent_capabilities" in w.table[0].settings, JSON.stringify(w.table))
  }

  console.log("\n[3 · fail closed]")
  {
    const w = world({ rows: [seedRow()], refuseRead: true })
    const r = await mergeBrokerageSettings(w.svc, B, { business_registration: { ein: "1" } })
    check("a refused read REFUSES — it is never taken for 'no settings' and nothing is written", !r.ok && w.writes.length === 0 && /could not be read/.test((r as any).error))
    const lost = world({ rows: [seedRow()], alwaysBump: true })
    const r2 = await mergeBrokerageSettings(lost.svc, B, { business_registration: { ein: "1" } }, { maxAttempts: 3 })
    check("a race lost on every attempt REFUSES as a conflict and never overwrites the newer row",
      !r2.ok && (r2 as any).conflict === true && !("business_registration" in lost.table[0].settings) && lost.writes.length === 0, JSON.stringify(r2))
    const none = await mergeBrokerageSettings(world().svc, "", { x: 1 })
    check("no brokerage → refused before any read", !none.ok)
    const rm = world({ rows: [{ ...seedRow(), settings: { a: 1, b: 2 } }] })
    const r3 = await mergeBrokerageSettings(rm.svc, B, { a: undefined })
    check("a key set to undefined is REMOVED; the rest carried", r3.ok && !("a" in rm.table[0].settings) && (rm.table[0].settings as any).b === 2)
    const bump = world({ rows: [{ ...seedRow(), updated_at: "2099-01-01T00:00:00.000Z" }] })
    await mergeBrokerageSettings(bump.svc, B, { k: 1 }, { now: () => new Date("2026-09-27T00:00:00Z") })
    check("the version only moves FORWARD (a row stamped in the future still gets a newer stamp)", Date.parse(bump.table[0].updated_at) > Date.parse("2099-01-01T00:00:00.000Z"))
  }

  console.log("\n[4 · a real converted writer races the merge writer]")
  {
    const { setLearnedAdjustmentVeto } = await import("../lib/managers/learning-loop")
    const w = world({ rows: [seedRow()], barrier: 2 })
    const [veto, reg] = await Promise.all([
      setLearnedAdjustmentVeto(B, "financing_sensitivity", true, w.svc),
      mergeBrokerageSettings(w.svc, B, { business_registration: { ein: "741234567" } }),
    ])
    const s = w.table[0].settings as any
    check("a broker's veto (learning-loop) and a registration save landing together: both kept",
      veto.ok && reg.ok && s.learned_vetoes?.financing_sensitivity === true && s.business_registration?.ein === "741234567" && s.ce_provider?.name === "Acme CE", JSON.stringify(s))
  }

  console.log("\n[5 · SOURCE: the merge writer is the only writer of the settings column]")
  {
    const { walkTs } = (await import("./runtime-roots")) as any
    const files: string[] = [...walkTs("app"), ...walkTs("lib")]
    const users = files.filter((f) => /["']brokerage_settings["']/.test(readFileSync(join(process.cwd(), f), "utf8")))
    // A write to brokerage_settings whose payload names the `settings` column (object literal or
    // a `settings`-keyed variable spread), or an upsert of it — read on comment-stripped code.
    const WRITES_SETTINGS = /from\(\s*["']brokerage_settings["']\s*\)[\s\S]{0,160}?\.(update|upsert|insert)\(\s*(\{[^)]{0,240}?\bsettings\b|patch\b|\{\s*\.\.\.)/
    const writers = users.filter((f) => WRITES_SETTINGS.test(stripComments(readFileSync(join(process.cwd(), f), "utf8"))))
    console.log(`    denominator: ${files.length} app/lib files; ${users.length} name brokerage_settings; settings-column writers: ${writers.join(", ") || "(none)"}`)
    check("exactly one module writes the settings column — the merge writer", writers.length === 1 && writers[0] === "lib/settings/brokerage-settings-merge.ts", writers.join(", "))
    check("POSITIVE CONTROL — the finder flags the pre-86C whole-object upsert",
      WRITES_SETTINGS.test(`await svc.from("brokerage_settings").upsert({ brokerage_id: b, settings: nextSettings }, { onConflict: "brokerage_id" })`))
    check("POSITIVE CONTROL — …and the `update(patch)` shape (referral appreciation's)",
      WRITES_SETTINGS.test(`await svc.from("brokerage_settings").update(patch).eq("id", row.id)`))
    check("CONTROL — a write of ANOTHER column (active_listing_sources) is not a settings writer",
      !WRITES_SETTINGS.test(`await svc.from("brokerage_settings").update({ active_listing_sources: normalized, updated_at: now })`))
    const helper = stripComments(readFileSync(join(process.cwd(), "lib/settings/brokerage-settings-merge.ts"), "utf8"))
    check("the merge writer's UPDATE carries the version predicate and is counted", /\.eq\("updated_at", r\.updated_at\)/.test(helper) && /\.select\("id"\)/.test(helper) && /upd\.length === 1/.test(helper))
  }

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(" ❌ SETTINGS_MERGE_RACE_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ SETTINGS_MERGE_RACE_PASS — concurrent settings saves merge by key; none is lost")
}

main().catch((e) => { console.error(e); process.exit(1) })
