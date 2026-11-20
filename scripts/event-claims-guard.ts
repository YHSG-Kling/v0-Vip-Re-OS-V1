/**
 * scripts/event-claims-guard.ts — test:event-claims (wave 155, lane 155R6; directive line 162 "no unclaimed event").
 *
 * EVERY KernelEvent IS CLAIMED, EMITTED OR RETIRED. Derived from STRIPPED source (CLAUDE.md §2: a tombstone is not a call
 * site), never from a hand list of what is wired:
 *
 *   EMITTED   a runtime file that calls an emit door names the event (KernelEvent.X, or its literal inside the call).
 *             A site is AUDIT-ONLY when the door call it rides passes `auditOnly: true`, or writes lifecycle_events
 *             directly (a record that never reaches the reactor), or is a same-file wrapper whose own body does either.
 *   CLAIMED   the reactor (lib/kernel/event-reactor.ts, lib/kernel/event-fanout.ts) consumes it — `=== KernelEvent.X`,
 *             `case KernelEvent.X:`, `[KernelEvent.X]:`, OR membership in a reactor array tested with
 *             `.includes(params.event)` — OR the reactor's (L6) award hook consumes it through LIFECYCLE_AWARD_RULES
 *             (lib/gamification/award-points.ts). The last two are the shapes scripts/os-coverage-ledger.ts cannot see.
 *   RETIRED   removed from the enum with a "RETIRED (wave 155, lane 155R6" tombstone in lib/kernel/events.ts.
 *
 * RATCHET (shrink-only, never a waypoint): an event that FANS OUT (≥ 1 site not audit-only) and is NOT claimed must be
 * named in OWNER_HELD below with the owner question it waits on; an entry that is no longer fan-out-and-unclaimed is
 * RED ("stale — remove it"). An enum value neither emitted nor claimed is RED (an orphan). A retired name that is
 * emitted again, or back in the enum, is RED.
 *
 * CANARIES (all SIMULATED: in-memory PostgREST client, global fetch counted and refused, no API keys):
 *   C1 BUYER_OFFER_ELIGIBLE through the REAL dispatchKernelEvent → shopping_agent + listing_concierge signals; the
 *      shopping_agent consumer notifies the buyer's own agent and opens one prepare-offer task; a replay adds nothing;
 *      a listing in another tenant gets no listing-side signal.
 *   C2 BUYER_STATE_CHANGED (contact) → ONE agent_action_ledger receipt "agent.concierge.spawn" per sweep.
 *   C3 LEAD_CAPTURED → ONE receipt "enrichment.lead.enqueue" carrying the writer's own outcome.
 * Each canary is red at ce4200fa (the reactor there has no such case / no receipt) — see the lane notes for the run.
 *
 * BLIND SPOTS: a reactor case gated on entityType is credited for every emit of that event; an emit whose event is a
 * runtime-built string is invisible (the census reports it as UNKNOWN instead); a door the regexes below do not name
 * is invisible until added (positive controls prove the named doors are recognised).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row, type MemClient } from "./in-memory-supabase"
import { EVENT_OWNER_HELD, CONDITIONAL_AUDIT, conditionalAuditVerified } from "./event-claims-ledger"

const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__R6.svc(...a)",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})
const g = globalThis as any
g.__R6 = { svc: () => { throw new Error("no world bound") } }

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }

// ─── the owner-held list and the conditional-audit exceptions: ONE copy, in scripts/event-claims-ledger.ts (wave 155, lane
// 155R22), read by this guard AND by the census (scripts/os-coverage-ledger.ts) — never retyped (CLAUDE.md §6). This guard
// keeps the ratchet over it: an entry that is no longer fan-out-and-unclaimed is RED ("stale — remove it"). Shrink-only.
export const OWNER_HELD: Record<string, string> = EVENT_OWNER_HELD

// ─── the classifier (pure over sources, so the controls can plant defects) ──────────────────────────────────────────────
export interface Sources { files: Record<string, string>; events: Record<string, string> }
export interface Verdict { key: string; value: string; emitters: string[]; fanOut: boolean; claimed: string[] }

const REACTOR_FILES = ["lib/kernel/event-reactor.ts", "lib/kernel/event-fanout.ts"]
const AWARD_FILE = "lib/gamification/award-points.ts"
const BASE_DOOR = /\b(?:emitKernelEvent|emitEventFromCron|dispatchKernelEvent|logEventAndTrigger|recordLifecycleEvent|emit)\s*\(/g
const DIRECT_AUDIT = /\.from\(\s*["'`]lifecycle_events["'`]\s*\)\s*\.insert\s*\(/
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function matchParen(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) return i }
  }
  return code.length
}
/** Every call span in `code` for the regex's doors: [start, end, isAudit]. */
function doorCalls(code: string, re: RegExp, auditWrappers: Set<string>): Array<[number, number, boolean]> {
  const out: Array<[number, number, boolean]> = []
  for (const m of code.matchAll(new RegExp(re.source, "g"))) {
    const open = m.index! + m[0].lastIndexOf("(")
    const end = matchParen(code, open)
    const span = code.slice(open, end + 1)
    const name = /([A-Za-z_$][\w$]*)\s*\($/.exec(m[0])?.[1] ?? ""
    out.push([m.index!, end, /\bauditOnly\s*:\s*true\b/.test(span) || DIRECT_AUDIT.test(span) || auditWrappers.has(name)])
  }
  // WAVE 155 (lane 155R22): a DIRECT `.from("lifecycle_events").insert(…)` is itself a call a site can RIDE — the record the
  // header already names as audit-only. Without it a site on a direct insert rode nothing, fell to the file-level fallback and
  // inherited the file's OTHER fan-out door: enrichment_completed (lib/lead-pipeline/enrichment-orchestrator.ts — a direct
  // insert, beside processKernelEvent for the contact variant) read as fan-out and was held. Control: §A "direct insert".
  for (const m of code.matchAll(new RegExp(DIRECT_AUDIT.source, "g"))) out.push([m.index!, matchParen(code, m.index! + m[0].length - 1), true])
  return out
}
/** Same-file wrappers (function or const arrow) whose body calls a base door with auditOnly / writes lifecycle_events. */
function localWrappers(code: string): { doors: string[]; audit: Set<string> } {
  const doors: string[] = []; const audit = new Set<string>()
  for (const m of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*async\s*\(/g)) {
    const name = m[1] ?? m[2] ?? m[3]
    // past the PARAMETER list first (a default `= {}` in it is not the body)
    const bodyOpen = code.indexOf("{", matchParen(code, m.index! + m[0].length - 1) + 1)
    if (bodyOpen < 0) continue
    const body = code.slice(bodyOpen, matchParen(code, bodyOpen) + 1)
    const calls = doorCalls(body, BASE_DOOR, new Set())
    const direct = DIRECT_AUDIT.test(body)
    if (!calls.length && !direct) continue
    const isAudit = direct || (calls.length > 0 && calls.every(([, , a]) => a))
    // an injected-deps property named like a base door (missions / delegation: `emit: async (input, client) => …`) is the
    // body `d.emit(` runs — it can make those calls audit, but it is not a new door name
    if (/^(?:emitKernelEvent|emitEventFromCron|dispatchKernelEvent|logEventAndTrigger|recordLifecycleEvent|emit)$/.test(name)) { if (isAudit) audit.add(name); continue }
    doors.push(name)
    if (isAudit) audit.add(name)
  }
  return { doors, audit }
}

// CONDITIONAL_AUDIT (an `auditOnly: <expression>` whose TRUE branch is exactly that event) lives in scripts/event-claims-ledger.ts
// with its verifier; re-exported so this guard's public surface is unchanged.
export { CONDITIONAL_AUDIT }
function CONDITIONAL_AUDIT_OK(value: string, f: string, c: string): boolean {
  return conditionalAuditVerified(value, f, c)
}

export function classify(src: Sources): Verdict[] {
  const code: Record<string, string> = {}
  for (const [f, s] of Object.entries(src.files)) code[f] = stripComments(s)
  // reactor claims
  const reactor = REACTOR_FILES.map((f) => code[f] ?? "").join("\n")
  const arrays = new Map<string, string>()
  for (const m of reactor.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g)) arrays.set(m[1], m[2])
  const arrayClaims = new Set<string>()
  for (const [name, body] of arrays) {
    if (!new RegExp(`\\b${name}\\.includes\\(\\s*params\\.event`).test(reactor)) continue
    for (const k of body.matchAll(/\bKernelEvent\.([A-Z0-9_]+)\b/g)) arrayClaims.add(k[1])
  }
  const awardCode = code[AWARD_FILE] ?? ""
  const rulesAt = awardCode.indexOf("LIFECYCLE_AWARD_RULES")
  const rulesSpan = rulesAt < 0 ? "" : awardCode.slice(rulesAt, matchParen(awardCode, awardCode.indexOf("[", awardCode.indexOf("=", rulesAt))) + 1)
  const awardHook = /\bawardLifecycleMilestones\s*\(/.test(reactor)
  const awardClaims = new Set<string>(awardHook ? [...rulesSpan.matchAll(/\bevent\s*:\s*KernelEvent\.([A-Z0-9_]+)\b/g)].map((m) => m[1]) : [])

  // the shared doors are DERIVED the way the census derives them: every exported (emit|dispatch|process)KernelEvent in
  // lib/kernel, plus every exported (emit|publish|fire|record)…Event… wrapper in lib/kernel whose own body calls a base
  // door (audit when every call in its body is audit)
  const sharedDoors = new Set<string>(); const sharedAudit = new Set<string>()
  for (const [f, c] of Object.entries(code)) {
    if (!f.startsWith("lib/kernel/") || REACTOR_FILES.includes(f)) continue
    for (const m of c.matchAll(/export\s+async\s+function\s+((?:emit|dispatch|process)KernelEvent|(?:emit|publish|fire|record)\w*Event\w*)\s*\(/g)) {
      const bodyOpen = c.indexOf("{", matchParen(c, c.indexOf("(", m.index! + m[0].length - 1)))
      const body = bodyOpen < 0 ? "" : c.slice(bodyOpen, matchParen(c, bodyOpen) + 1)
      const calls = doorCalls(body, BASE_DOOR, new Set())
      if (!/KernelEvent$/.test(m[1]) && !calls.length && !DIRECT_AUDIT.test(body)) continue
      sharedDoors.add(m[1])
      if (!/KernelEvent$/.test(m[1]) && (DIRECT_AUDIT.test(body) || (calls.length > 0 && calls.every(([, , a]) => a)))) sharedAudit.add(m[1])
    }
  }
  // emitter files (non-reactor runtime files that call a base door, a shared wrapper or a same-file wrapper)
  const emitterInfo = new Map<string, { calls: Array<[number, number, boolean]> }>()
  for (const [f, c] of Object.entries(code)) {
    if (REACTOR_FILES.includes(f) || f === "lib/kernel/events.ts" || f === "lib/kernel/emit.ts") continue
    const w = localWrappers(c)
    const names = [...new Set([...sharedDoors, ...w.doors])]
    const doorRe = new RegExp(`\\b(?:emitKernelEvent|emitEventFromCron|dispatchKernelEvent|logEventAndTrigger|recordLifecycleEvent|emit${names.length ? "|" + names.map(reEsc).join("|") : ""})\\s*\\(`)
    const calls = doorCalls(c, doorRe, new Set([...w.audit, ...sharedAudit]))
    if (calls.length) emitterInfo.set(f, { calls })
  }
  const out: Verdict[] = []
  for (const [key, value] of Object.entries(src.events)) {
    const claimed: string[] = []
    const caseRe = new RegExp(`(?:===\\s*|case\\s+)KernelEvent\\.${key}\\b|\\[\\s*KernelEvent\\.${key}\\s*\\]\\s*:`)
    if (caseRe.test(reactor)) claimed.push("reactor case")
    else { const other = Object.entries(code).find(([f, c]) => !REACTOR_FILES.includes(f) && f !== "lib/kernel/events.ts" && caseRe.test(c)); if (other) claimed.push(`consumer outside the reactor (${other[0]})`) }
    if (arrayClaims.has(key)) claimed.push("reactor array (.includes(params.event))")
    if (awardClaims.has(key)) claimed.push("L6 award rule (LIFECYCLE_AWARD_RULES)")
    const emitters: string[] = []; let fanOut = false
    for (const [f, info] of emitterInfo) {
      const c = code[f]
      const sites = [...c.matchAll(new RegExp(`\\bKernelEvent\\.${key}\\b`, "g"))].map((m) => m.index!)
        .concat([...c.matchAll(new RegExp(`["'\`]${reEsc(value)}["'\`]`, "g"))].map((m) => m.index!)
          // a literal counts only as an EVENT value (event / event_type / eventType: "x") or a door's own argument — not an
          // activities.activity_type that happens to share the spelling
          .filter((i) => info.calls.some(([s, e]) => i > s && i < e) && /(?:\bevent(?:_type|Type)?\s*:\s*|[(,]\s*)$/.test(c.slice(Math.max(0, i - 40), i))))
        .filter((i) => !/(?:===\s*|case\s+)$/.test(c.slice(Math.max(0, i - 8), i)))
      if (!sites.length) continue
      let any = false
      for (const i of sites) {
        // the call the site rides: (1) the door call whose span contains it; (2) a `const NAME = …KernelEvent.X…` → the
        // first later door call whose span uses NAME; (3) a map VALUE (`'state': KernelEvent.X`, lib/kernel/lifecycle.ts,
        // looked up later) → the file's own doors decide (file-level approximation; blind spot in the header). Anything
        // else (a Set literal of silent events, an argument to a non-door helper) is NOT an emission site.
        // the INNERMOST containing door call (an outer wrapper call can enclose the real emit)
        let rides: [number, number, boolean] | "file" | null = info.calls.filter(([s, e]) => i > s && i < e).sort((a, b) => b[0] - a[0])[0] ?? null
        if (!rides) {
          const stmt = c.slice(Math.max(0, i - 200), i)
          const decl = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=[^;\n]*(?:\n[^;\n]*){0,3}$/.exec(stmt)
          if (decl) rides = info.calls.find(([s, e]) => s > i && new RegExp(`\\b${reEsc(decl[1])}\\b`).test(c.slice(s, e))) ?? null
          // a map value counts only when the map is LOOKED UP by key (`NAME[state]`), the shape lifecycle.ts / forms.ts use —
          // an evidence object that merely carries the event (`existingEvent: KernelEvent.X`) is not an emit
          if (!rides && /[\w'"\]]\s*:\s*$/.test(c.slice(Math.max(0, i - 80), i)) && (!decl || new RegExp(`\\b${reEsc(decl[1])}\\s*\\[`).test(c))) rides = "file"
        }
        if (!rides) continue
        any = true
        if (rides === "file" ? info.calls.some(([, , a]) => !a) : !rides[2] && !CONDITIONAL_AUDIT_OK(value, f, c)) fanOut = true
      }
      if (any) emitters.push(f)
    }
    out.push({ key, value, emitters, fanOut, claimed })
  }
  return out
}

function runtimeFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const n of readdirSync(join(ROOT, d))) {
      const p = `${d}/${n}`
      if (n === "node_modules" || n.startsWith(".")) continue
      const st = statSync(join(ROOT, p))
      if (st.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out[p] = readFileSync(join(ROOT, p), "utf8")
    }
  }
  walk("lib"); walk("app")
  return out
}

/** Names retired by this lane, parsed from the tombstones (raw source: the tombstone IS a comment). */
export function retiredNames(eventsSrc: string): string[] {
  const out: string[] = []
  for (const m of eventsSrc.matchAll(/RETIRED \(wave 155, lane 155R6[^)]*\):\s*([a-z0-9_,\s]+?)\s+—/g)) out.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean))
  return out
}
/** A retired name EMITTED again: its literal as an event / event_type value or a door's literal argument (comments stripped). */
export function reEmitted(files: Record<string, string>, names: string[]): string[] {
  const hits: string[] = []
  for (const [f, s] of Object.entries(files)) {
    const c = stripComments(s)
    for (const n of names) if (new RegExp(`\\bevent(?:_type)?\\s*:\\s*["'\`]${reEsc(n)}["'\`]|\\b(?:emitTransferEvent|emitKernelEvent|logEventAndTrigger)\\s*\\([^)]*["'\`]${reEsc(n)}["'\`]`).test(c)) hits.push(`${f}: ${n}`)
  }
  return hits
}

async function main() {
  console.log("test:event-claims — every KernelEvent is claimed, emitted or retired (wave 155, lane 155R6)\n")
  const { KernelEvent } = await import("../lib/kernel/events")
  const events: Record<string, string> = {}
  for (const [k, v] of Object.entries(KernelEvent)) if (typeof v === "string") events[k] = v

  // ── A. positive controls on planted sources ──
  console.log("[A · the finders still recognise the defects they were written for]")
  const planted = (files: Record<string, string>, ev: Record<string, string>) => classify({ files: { "lib/kernel/event-reactor.ts": "", ...files }, events: ev })
  const v1 = planted({ "lib/x.ts": `await emitKernelEvent({ event: KernelEvent.FOO, brokerageId })` }, { FOO: "foo" })[0]
  check("POSITIVE CONTROL: a planted fan-out emit with no reactor case is found unclaimed", v1.fanOut && !v1.claimed.length && v1.emitters[0] === "lib/x.ts", JSON.stringify(v1))
  const v2 = planted({ "lib/x.ts": `await emitKernelEvent({ event: KernelEvent.FOO })`, "lib/kernel/event-reactor.ts": `const SOME_EVENTS: string[] = [KernelEvent.FOO]\nif (SOME_EVENTS.includes(params.event)) {}` }, { FOO: "foo" })[0]
  check("POSITIVE CONTROL: a reactor ARRAY tested with .includes(params.event) is a claim (the shape the census misses)", v2.claimed.includes("reactor array (.includes(params.event))"))
  const v2n = planted({ "lib/x.ts": `await emitKernelEvent({ event: KernelEvent.FOO })`, "lib/kernel/event-reactor.ts": `const SOME_EVENTS: string[] = [KernelEvent.FOO]` }, { FOO: "foo" })[0]
  check("NEGATIVE CONTROL: …an array nobody tests against params.event is NOT a claim", !v2n.claimed.length)
  const v3 = planted({ "lib/x.ts": `// await emitKernelEvent({ event: KernelEvent.FOO })\nexport const y = 1` }, { FOO: "foo" })[0]
  check("POSITIVE CONTROL: a TOMBSTONE naming the emit is not an emission site (stripped source)", !v3.emitters.length)
  const v4 = planted({ "lib/x.ts": `const e = KernelEvent.FOO\nawait emitKernelEvent({ event: e, auditOnly: true })` }, { FOO: "foo" })[0]
  check("POSITIVE CONTROL: an emit whose call passes auditOnly: true is a RECORD (emitted, does not fan out)", v4.emitters.length === 1 && !v4.fanOut)
  const v5 = planted({ "lib/x.ts": `async function echo(svc, ev) { await emitKernelEvent({ event: ev, auditOnly: true }) }\nawait echo(svc, "foo_bar")` }, { FOO_BAR: "foo_bar" })[0]
  check("POSITIVE CONTROL: a same-file wrapper whose body emits audit-only makes its literal call a RECORD", v5.emitters.length === 1 && !v5.fanOut, JSON.stringify(v5))
  const v6 = planted({ "lib/kernel/event-reactor.ts": `awardLifecycleMilestones(svc, {})`, "lib/gamification/award-points.ts": `export const LIFECYCLE_AWARD_RULES = [\n { event: KernelEvent.FOO, reason: "X" },\n]` }, { FOO: "foo" })[0]
  check("POSITIVE CONTROL: an L6 award rule is a claim only while the reactor calls awardLifecycleMilestones", v6.claimed.includes("L6 award rule (LIFECYCLE_AWARD_RULES)") &&
    !planted({ "lib/gamification/award-points.ts": `export const LIFECYCLE_AWARD_RULES = [\n { event: KernelEvent.FOO },\n]` }, { FOO: "foo" })[0].claimed.length)
  // WAVE 155 (lane 155R22) — a direct lifecycle_events insert is a RECORD even beside a fan-out door in the same file
  const v7 = planted({ "lib/x.ts": `await sentinelWrite(svc, svc.from("lifecycle_events").insert({ event_type: KernelEvent.FOO }))\nawait emitKernelEvent({ event: KernelEvent.BAR, brokerageId })` }, { FOO: "foo", BAR: "bar" })
  check("POSITIVE CONTROL (direct insert): an event written ONLY by a direct lifecycle_events insert is an emitted RECORD, even when the same file fans out another event — NEGATIVE: that other event still fans out",
    v7[0].emitters.length === 1 && !v7[0].fanOut && v7[1].fanOut, JSON.stringify(v7))
  check("POSITIVE CONTROL: the retired-name finder catches a live literal emit of a retired name, and not its tombstone",
    reEmitted({ "lib/y.ts": `await emitKernelEvent({ event: "buyer_fatigue_alert" as never })` }, ["buyer_fatigue_alert"]).length === 1 &&
    reEmitted({ "lib/y.ts": `// await emitKernelEvent({ event: "buyer_fatigue_alert" })` }, ["buyer_fatigue_alert"]).length === 0)

  // ── B. the real tree ──
  console.log("\n[B · the real tree]")
  const files = runtimeFiles()
  const verdicts = classify({ files, events })
  const unclaimedFanOut = verdicts.filter((v) => v.fanOut && !v.claimed.length).map((v) => v.value).sort()
  const orphans = verdicts.filter((v) => !v.emitters.length && !v.claimed.length).map((v) => v.value).sort()
  const records = verdicts.filter((v) => v.emitters.length && !v.fanOut && !v.claimed.length).length
  const claimed = verdicts.filter((v) => v.claimed.length).length
  console.log(`    ${verdicts.length} enum values · claimed ${claimed} · audit-only records ${records} · fan-out unclaimed ${unclaimedFanOut.length} · neither emitted nor claimed ${orphans.length}`)
  const notHeld = unclaimedFanOut.filter((v) => !(v in OWNER_HELD))
  check(`every fan-out event with no reactor claim is OWNER-HELD with its question (${unclaimedFanOut.length} held)`, notHeld.length === 0, `not held: ${notHeld.join(", ")}`)
  const condStale = Object.entries(CONDITIONAL_AUDIT).filter(([, x]) => !x.expr.test(stripComments(files[x.file] ?? "")))
  check("every CONDITIONAL_AUDIT exception still matches the code it names (else it would hide a fan-out)", condStale.length === 0, condStale.map(([k]) => k).join(", "))
  const stale = Object.keys(OWNER_HELD).filter((v) => !unclaimedFanOut.includes(v))
  check("SHRINK-ONLY: no OWNER_HELD entry is stale (each is still emitted, fans out and is unclaimed)", stale.length === 0, `stale — remove: ${stale.join(", ")}`)
  // An enum value with no emit door and no claim is an orphan UNLESS another file carries it to an emit at run time;
  // those are the census's UNKNOWN rows and are listed (not hidden) here.
  const stripped = Object.entries(files).filter(([f]) => f !== "lib/kernel/events.ts").map(([, s]) => stripComments(s))
  const keyOf = (val: string) => Object.keys(events).find((k) => events[k] === val)!
  const carried = (val: string) => stripped.some((c) => new RegExp(`["'\`]${reEsc(val)}["'\`]|\\bKernelEvent\\.${keyOf(val)}\\b`).test(c))
  const trueOrphans = orphans.filter((v) => !carried(v))
  check(`no enum value is an ORPHAN (no emit, no claim, no carrier) — ${orphans.length - trueOrphans.length} carried by another door are listed below`, trueOrphans.length === 0, trueOrphans.join(", "))
  if (orphans.length) console.log(`    carried / door-unread (census UNKNOWN class): ${orphans.join(", ")}`)
  const eventsSrc = raw("lib/kernel/events.ts")
  const retired = retiredNames(eventsSrc)
  const values = new Set(Object.values(events))
  check(`RETIRED names (${retired.length}) are out of the enum`, retired.length >= 90 && retired.every((n) => !values.has(n)), retired.filter((n) => values.has(n)).join(", "))
  const back = reEmitted(files, retired)
  check("…and no runtime file emits one again", back.length === 0, back.join("; "))
  const boe = verdicts.find((v) => v.value === "buyer_offer_eligible")
  check("buyer_offer_eligible fans out AND is claimed by a reactor case (wired by this lane)", !!boe?.fanOut && !!boe?.claimed.includes("reactor case"), JSON.stringify(boe))

  // ── C. executed canaries (SIMULATED) ──
  console.log("\n[C · canaries through the real dispatcher (SIMULATED: in-memory client, fetch refused and counted)]")
  delete process.env.ANTHROPIC_API_KEY
  let fetches = 0
  g.fetch = async () => { fetches++; return new Response("refused in test", { status: 503 }) }
  const B1 = "b1000000-0000-4000-8000-000000000001", B2 = "b2000000-0000-4000-8000-000000000002"
  const C = "c1000000-0000-4000-8000-0000000000c1", L = "11000000-0000-4000-8000-0000000000a1", LX = "11000000-0000-4000-8000-0000000000b2"
  const AG = "a9000000-0000-4000-8000-0000000000a1", AGL = "a9000000-0000-4000-8000-0000000000a2", U1 = "a1000000-0000-4000-8000-0000000000a1", U2 = "a1000000-0000-4000-8000-0000000000a2"
  const reads: string[] = []
  const world = (seed: Record<string, Row[]>, refuse?: Record<string, string>): MemClient => {
    const w = memSupabase(seed, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, refuse })
    reads.length = 0
    // every table the reactor touches is logged (the fake records writes only) — C2b reads it
    const logged = new Proxy(w, { get: (t, k) => (k === "from" ? (tbl: string) => { reads.push(tbl); return t.from(tbl) } : Reflect.get(t, k)) }) as MemClient
    g.__R6.svc = () => logged
    return w
  }
  const { dispatchKernelEvent } = await import("../lib/kernel/event-reactor")
  const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
  const seed = (): Record<string, Row[]> => ({
    contacts: [{ id: C, brokerage_id: B1, first_name: "Dana", last_name: "Buyer", agent_id: AG, contact_type: "buyer" }],
    listings: [{ id: L, brokerage_id: B1, agent_id: AGL, address: "12 Elm St" }, { id: LX, brokerage_id: B2, agent_id: AGL, address: "9 Far Rd" }],
    agents: [{ id: AG, user_id: U1, brokerage_id: B1 }, { id: AGL, user_id: U2, brokerage_id: B1 }],
    offer_intents: [], manager_signals: [], notifications: [], tasks: [], agent_action_ledger: [], lifecycle_events: [], leads: [],
  })
  const fire = (event: string, extra: Record<string, unknown>) =>
    dispatchKernelEvent({ event, brokerageId: B1, entityType: "contact", entityId: C, contactId: C, ...extra } as never).catch((e: unknown) => ({ threw: String(e) }))

  // C1
  const w1 = world(seed())
  await fire(KernelEvent.BUYER_OFFER_ELIGIBLE, { listingId: L, metadata: { listing_id: L, interest_level: "offer_requested", agent_id: AG } })
  const sig = (w: MemClient, to: string) => (w.tables.manager_signals as Row[]).filter((r) => r.signal_type === "buyer_offer_submit_requested" && r.to_manager === to)
  check("C1 · a buyer's portal 'Request offer' (BUYER_OFFER_ELIGIBLE) reaches the Shopping Agent as buyer_offer_submit_requested (entity = the buyer)", sig(w1, "shopping_agent").length === 1 && sig(w1, "shopping_agent")[0].entity_id === C, JSON.stringify(w1.tables.manager_signals))
  check("C1 · …and, the listing being in-house, the Listing Concierge is told an offer is coming", sig(w1, "listing_concierge").length === 1 && sig(w1, "listing_concierge")[0].entity_id === L)
  const s = sig(w1, "shopping_agent")[0]
  const verdict = s ? await SIGNAL_HANDLERS["shopping_agent:buyer_offer_submit_requested"]({ id: s.id, fromManager: s.from_manager, toManager: s.to_manager, signalType: s.signal_type, message: s.message, entityType: s.entity_type, entityId: s.entity_id, contactId: s.contact_id, payload: s.payload ?? {}, status: "open", createdAt: s.created_at } as never, { brokerageId: B1, supabase: w1 as never }) : null
  const tasks = (w1.tables.tasks as Row[]).filter((t) => t.source === "buyer_offer_submit_requested")
  const bells = (w1.tables.notifications as Row[]).filter((n) => n.type === "buyer_offer_submit_requested" && n.user_id === U1)
  check("C1 · the consumer DECIDES: the buyer's OWN agent is notified and ONE prepare-offer task is opened", verdict === "notified the buyer's own assigned agent and opened a prepare-offer task" && tasks.length === 1 && bells.length === 1 && tasks[0].assigned_to_agent_id === AG, JSON.stringify({ verdict, tasks: tasks.length, bells: bells.length }))
  for (const r of w1.tables.manager_signals as Row[]) r.status ??= "open" // the live column DEFAULT 'open' (m217); the fake has no defaults
  await fire(KernelEvent.BUYER_OFFER_ELIGIBLE, { listingId: L, metadata: { listing_id: L, interest_level: "offer_requested", agent_id: AG } })
  check("C1 REPLAY · the same request delivered again adds no signal (one open per buyer)", sig(w1, "shopping_agent").length === 1 && sig(w1, "listing_concierge").length === 1)
  const w1b = world(seed())
  await fire(KernelEvent.BUYER_OFFER_ELIGIBLE, { listingId: LX, metadata: { listing_id: LX } })
  check("C1 ADVERSE · a listing in ANOTHER tenant gets no listing-side signal (the buyer-side one still fires)", sig(w1b, "listing_concierge").length === 0 && sig(w1b, "shopping_agent").length === 1)

  // C2
  const w2 = world(seed())
  await fire(KernelEvent.BUYER_STATE_CHANGED, { metadata: { to: "searching" } })
  const r2 = (w2.tables.agent_action_ledger as Row[]).filter((r) => r.action === "agent.concierge.spawn")
  check("C2 · the concierge spawn sweep leaves ONE receipt (agent.concierge.spawn, manager data_steward, subject = the contact, settled executed)", r2.length === 1 && r2[0].status === "executed" && r2[0].subject_id === C && r2[0].actor_manager_key === "data_steward", JSON.stringify(r2.map((r) => [r.status, r.outcome, r.subject_id, r.actor_manager_key])))

  // C2b — the ledger REFUSES: today's behavior holds (the sweep still runs; nothing is receipted, nothing throws)
  const w2b = world(seed(), { agent_action_ledger: "permission denied for table agent_action_ledger" })
  const t2b = await fire(KernelEvent.BUYER_STATE_CHANGED, { metadata: { to: "searching" } })
  const sweepRan = reads.includes("property_preferences") // the dual-intent linker's own read, inside the sweep
  check("C2b REFUSED LEDGER · the sweep still runs (its dual-intent linker read property_preferences), nothing is receipted, nothing throws — today's behavior",
    sweepRan && !(t2b as { threw?: string }).threw && (w2b.tables.agent_action_ledger as Row[]).length === 0, JSON.stringify({ reads: [...new Set(reads)].slice(0, 16), t2b }))
  world(seed())
  await dispatchKernelEvent({ event: KernelEvent.BUYER_STATE_CHANGED, brokerageId: B1, entityType: "lead", entityId: C } as never).catch(() => null)
  check("CONTROL · …and that read IS the sweep's: the same event on a non-contact entity (no sweep) never reads property_preferences", !reads.includes("property_preferences"), JSON.stringify([...new Set(reads)]))

  // C3
  const w3 = world(seed())
  await dispatchKernelEvent({ event: KernelEvent.LEAD_CAPTURED, brokerageId: B1, entityType: "lead", entityId: "1ead0000-0000-4000-8000-0000000000a1" } as never).catch(() => null)
  const r3 = (w3.tables.agent_action_ledger as Row[]).filter((r) => r.action === "enrichment.lead.enqueue")
  check("C3 · a captured lead's enrichment enqueue leaves ONE receipt carrying the writer's own outcome (lead absent → not queued, nothing spent)", r3.length === 1 && r3[0].status !== "executed" && typeof r3[0].outcome === "string" && (w3.tables.lead_enrichment_queue as Row[] | undefined ?? []).length === 0, JSON.stringify(r3.map((r) => [r.status, r.outcome])))
  check("SCOPE · zero provider calls across every canary (global fetch counted)", fetches === 0, `fetch calls: ${fetches}`)

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(`❌ EVENT_CLAIMS_FAIL\n  - ${failures.join("\n  - ")}`); process.exit(1) }
  console.log("✅ EVENT_CLAIMS_PASS — every KernelEvent is claimed, emitted as a record, owner-held with its question, or retired")
}

if (/event-claims-guard\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1) })
