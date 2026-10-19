#!/usr/bin/env tsx
/**
 * scripts/immediate-enrichment-guard.ts   (npm run test:immediate-enrichment) — wave 142, lane 142D.
 * ─────────────────────────────────────────────────────────────────────────────
 * ENRICH THE MOMENT THE ROW COMES IN. Owner, verbatim (2026-10-18): "enrichment should happen as soon as a
 * new contact or form submission comes in." At HEAD every create door QUEUED a lead_enrichment_queue row, but
 * the row was DRAINED only by the 15-minute cron — "as soon as" meant "within a quarter of an hour". The fix is
 * ONE drainer (law 2): processEnrichmentQueue takes `{ queueEntryId }` and lib/enrichment/inline-drain.ts hands
 * the just-written row to that same function, fire-and-forget, right after the queue write. The cron stays the
 * backstop. No database, no network: the kernel runs over scripts/in-memory-supabase.ts, and the service env is
 * scrubbed first so any client the kernel creates for itself REFUSES instead of reaching the live project.
 *
 *  A. PURE — the dispatch: "auto" default only inside the app runtime (NEXT_RUNTIME) or ENRICHMENT_INLINE_DRAIN=on,
 *     =off the kill switch, `false` = cron only, an injected seam always runs, a REJECTING drain never throws
 *  B. THE WRITERS, EXECUTED over the fake — queueContactEnrichment and queueLeadEnrichment each: write the row,
 *     dispatch the drain for THAT row's id, RETURN before the drain settles (the capture is never blocked), and
 *     a drain that rejects never fails the capture; `inlineDrain: false` leaves the row for the cron
 *  C. THE SINGLE-ROW DRAIN on the REAL processEnrichmentQueue over the fake — the named row is claimed and
 *     settled (here: suppressed — its contact is in a live listing, so no provider is reached), its sibling is
 *     UNTOUCHED, a wrong tenant claims nothing, and the batch call (no id — the cron's shape) reaches the sibling
 *  D. SOURCE, stripped — the writers dispatch after the `.select("id").single()` read-back, the orchestrator
 *     narrows on `opts.queueEntryId` with the tenant predicate UNCONDITIONAL, the cron route passes no id
 *  E. THE DOOR CENSUS, stripped (strings kept) — every `.from("contacts").insert|upsert(` under lib/ app/ either
 *     dispatches (a queue writer, captureContact, or a CONTACT_CREATED / CONTACT_CAPTURED emit the reactor queues)
 *     or inserts an IDENTIFIER-LESS placeholder (no email / phone key, no spread) the rail's own identifier gate
 *     refuses anyway. POSITIVE CONTROL: a cron-only door with an email is caught; a spread payload is caught.
 *  F. registration: package.json, chain membership (never position), MAINTENANCE_DOMAINS.immediate_enrichment
 * BLIND SPOTS (published): the paid lanes of the drain (PeopleData / OSINT / Versium) are NOT executed — the
 * single-row run is settled at the owner's suppression gate on purpose; the census reads one file at a time, so a
 * door whose dispatch lives in a helper the file imports is reported, not trusted; a payload built in a variable
 * is treated as identifier-bearing (it must dispatch).
 */
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { memSupabase } from "./in-memory-supabase"
import { dispatchInlineEnrichmentDrain, inlineDrainEnabledByDefault, type InlineDrainTarget } from "../lib/enrichment/inline-drain"
import { queueContactEnrichment } from "../lib/enrichment/contact-enrichment-core"
import { queueLeadEnrichment } from "../lib/enrichment/lead-enrichment-core"
import { processEnrichmentQueue } from "../lib/lead-pipeline/enrichment-orchestrator"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

// NO LIVE PROJECT: a kernel path that creates its own client (emitKernelEvent inside the writers) must refuse,
// never write a fake contact's event into hrvaqgvukzxfskkcrwbt. Scrubbed before the first call, after the
// imports (no module creates a client at load).
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
delete process.env.ENRICHMENT_INLINE_DRAIN

let pass = 0, fail = 0
const failures: string[] = []
const ok = (c: unknown, m: string, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; failures.push(m); console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`) } }
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(read(p))
const tick = () => new Promise<void>((r) => setImmediate(r))
const CONTACT_CORE = "lib/enrichment/contact-enrichment-core.ts"
const LEAD_CORE = "lib/enrichment/lead-enrichment-core.ts"
const ORCH = "lib/lead-pipeline/enrichment-orchestrator.ts"
const DRAIN = "lib/enrichment/inline-drain.ts"
const CRON = "app/api/cron/enrichment-processor/route.ts"

/** console.error captured for one async step (the writers log an emit refusal; the dispatch logs a failed drain). */
async function capturing<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")) }
  try { return { value: await fn(), errors } } finally { console.error = orig }
}

const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1", C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2", LD1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"
type Row = Record<string, any>
function client(seed: Record<string, Row[]> = {}) {
  return memSupabase({
    contacts: [
      { id: C1, brokerage_id: B, first_name: "Live", last_name: "Deal", email: "c1@wave105.test", phone: null, enriched_at: null, last_enriched_at: null, enrichment_profile: {} },
      { id: C2, brokerage_id: B, first_name: "Fresh", last_name: "Arrival", email: "c2@wave105.test", phone: null, enriched_at: null, last_enriched_at: null, enrichment_profile: {} },
    ],
    leads: [{ id: LD1, brokerage_id: B, first_name: "Lead", last_name: "Arrival", email: "ld1@wave105.test", phone: null, last_enriched_at: null, enrichment_profile: {} }],
    // C1 is the seller on a LIVE listing — the owner's suppression gate settles its row with no provider call.
    listings: [{ id: "l1l1l1l1-l1l1-4l1l-8l1l-l1l1l1l1l1l1", brokerage_id: B, seller_contact_id: C1, contact_id: null, status: "active", lifecycle_stage: "active" }],
    transactions: [], lead_enrichment_queue: [], lifecycle_events: [], vendor_usage_tracking: [], manager_signals: [], notifications: [],
    ...seed,
  }, { uuidIds: true, stampCreatedAt: true })
}

console.log("\n━━━ A · the dispatch (pure) ━━━")
{
  ok(inlineDrainEnabledByDefault({}) === null && inlineDrainEnabledByDefault({ NEXT_RUNTIME: "nodejs" }) === "app_runtime" && inlineDrainEnabledByDefault({ ENRICHMENT_INLINE_DRAIN: "on" }) === "env_on" && inlineDrainEnabledByDefault({ ENRICHMENT_INLINE_DRAIN: "off", NEXT_RUNTIME: "nodejs" }) === null, "the DEFAULT drain runs only inside the app runtime (NEXT_RUNTIME) or under ENRICHMENT_INLINE_DRAIN=on; =off is the kill switch even inside the runtime")
  const target: InlineDrainTarget = { brokerageId: B, queueEntryId: "q-1" }
  ok(dispatchInlineEnrichmentDrain(target, false).reason === "caller_opted_out", "`false` = cron only (the caller opted out; nothing scheduled)")
  ok(dispatchInlineEnrichmentDrain(target).dispatched === false && dispatchInlineEnrichmentDrain(target).reason === "not_app_runtime", "a script with no injected seam schedules NOTHING (no provider reached by accident)")
  process.env.ENRICHMENT_INLINE_DRAIN = "off"
  ok(dispatchInlineEnrichmentDrain(target).reason === "env_off", "the kill switch is reported as env_off")
  delete process.env.ENRICHMENT_INLINE_DRAIN
  const calls: InlineDrainTarget[] = []
  const d = dispatchInlineEnrichmentDrain(target, async (t) => { calls.push(t) })
  ok(d.dispatched && d.reason === "injected" && calls.length === 0, "an injected seam is dispatched — and has NOT run when dispatch returns (fire-and-forget)")
  await tick()
  ok(calls.length === 1 && calls[0].queueEntryId === "q-1", "…it runs on the next turn, for exactly the named row")
  const rej = await capturing(async () => { const r = dispatchInlineEnrichmentDrain(target, async () => { throw new Error("provider down") }); await tick(); return r })
  ok(rej.value.dispatched && rej.errors.some((e) => /inline drain for queue row q-1 failed/.test(e) && /provider down/.test(e)), "a REJECTING drain never throws out of dispatch — it is logged as the cron's row")
}

console.log("\n━━━ B · the writers, executed over the fake ━━━")
{
  // the contact writer
  const svc = client()
  const seen: InlineDrainTarget[] = []
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  // object state, not a `let`: the assignment happens inside the drain closure, which TS's narrowing cannot see
  const drainState = { settled: false }
  const r1 = await capturing(() => queueContactEnrichment({ contactId: C2, brokerageId: B, triggerType: "contact_created", supabase: svc, inlineDrain: async (t) => { seen.push(t); await held; drainState.settled = true } }))
  const row = (svc.tables.lead_enrichment_queue ?? [])[0]
  ok(r1.value.queued === true && !!row && row.contact_id === C2 && row.brokerage_id === B && row.status === "pending", "queueContactEnrichment writes the pending row under the tenant", JSON.stringify(r1.value))
  ok(r1.value.drain?.dispatched === true && r1.value.drain.reason === "injected", "…and reports the drain dispatched (injected)")
  await tick()
  ok(seen.length === 1 && seen[0].queueEntryId === row?.id && seen[0].brokerageId === B, "the drain was handed EXACTLY the row just written (its read-back id) under the same tenant")
  ok(drainState.settled === false, "the writer RETURNED while the drain was still running — the capture is never blocked")
  release(); await tick()
  ok(drainState.settled === true, "…and the drain settles on its own afterwards")
  ok(r1.errors.every((e) => /CONTACT_ENRICHMENT_QUEUED emit failed/.test(e)), "the only noise is the kernel emit refusing without a service env (no live write happened)", r1.errors.join(" | "))
  // a rejecting drain
  const svc2 = client()
  const r2 = await capturing(async () => { const r = await queueContactEnrichment({ contactId: C2, brokerageId: B, triggerType: "contact_created", supabase: svc2, inlineDrain: async () => { throw new Error("boom") } }); await tick(); return r })
  ok(r2.value.queued === true && r2.value.drain?.dispatched === true && r2.errors.some((e) => /inline drain for queue row .* failed/.test(e) && /boom/.test(e)), "a drain that REJECTS never fails the capture: queued, dispatched, the failure logged for the cron")
  // opt-out
  const svc3 = client()
  const r3 = await capturing(() => queueContactEnrichment({ contactId: C2, brokerageId: B, triggerType: "contact_created", supabase: svc3, inlineDrain: false }))
  ok(r3.value.queued === true && r3.value.drain?.dispatched === false && r3.value.drain.reason === "caller_opted_out" && (svc3.tables.lead_enrichment_queue ?? []).length === 1, "`inlineDrain: false` still queues (the cron's row) and dispatches nothing")
  // the suppression gate still precedes the write — a live-deal contact is never queued, so never drained
  const svc4 = client()
  const r4 = await capturing(() => queueContactEnrichment({ contactId: C1, brokerageId: B, triggerType: "contact_created", supabase: svc4, inlineDrain: async () => { throw new Error("must not run") } }))
  ok(r4.value.queued === false && r4.value.reason === "live_deal" && (svc4.tables.lead_enrichment_queue ?? []).length === 0 && r4.value.drain === undefined, "the owner's suppression gate runs BEFORE the write: a live-deal contact gets no row and no drain")
  // the lead writer
  const svc5 = client()
  const seenL: InlineDrainTarget[] = []
  const leadState = { settled: false }
  const r5 = await capturing(async () => { const r = await queueLeadEnrichment({ leadId: LD1, brokerageId: B, triggerType: "lead_captured", supabase: svc5, inlineDrain: async (t) => { seenL.push(t); await tick(); leadState.settled = true } }); const early = leadState.settled; await tick(); await tick(); return { r, early } })
  const lrow = (svc5.tables.lead_enrichment_queue ?? [])[0]
  ok(r5.value.r.queued === true && !!lrow && lrow.lead_id === LD1 && lrow.contact_id === null && r5.value.r.drain?.dispatched === true, "queueLeadEnrichment writes the lead row and dispatches the drain", JSON.stringify(r5.value.r))
  ok(seenL.length === 1 && seenL[0].queueEntryId === lrow?.id && r5.value.early === false && leadState.settled === true, "…for exactly that row, returning before the drain settled")
}

console.log("\n━━━ C · the single-row drain on the REAL orchestrator ━━━")
{
  const svc = client({ lead_enrichment_queue: [
    { id: "q1q1q1q1-q1q1-4q1q-8q1q-q1q1q1q1q1q1", contact_id: C1, lead_id: null, brokerage_id: B, status: "pending", enrichment_type: "skip_trace", trigger_type: "contact_created", retry_count: 0, max_retries: 3, queued_at: "2026-10-19T00:00:00.000Z" },
    { id: "q2q2q2q2-q2q2-4q2q-8q2q-q2q2q2q2q2q2", contact_id: C1, lead_id: null, brokerage_id: B, status: "pending", enrichment_type: "skip_trace", trigger_type: "contact_created", retry_count: 0, max_retries: 3, queued_at: "2026-10-18T00:00:00.000Z" },
  ] })
  const q = () => svc.tables.lead_enrichment_queue
  const wrong = await capturing(() => processEnrichmentQueue(OTHER, { queueEntryId: "q1q1q1q1-q1q1-4q1q-8q1q-q1q1q1q1q1q1", supabase: svc }))
  ok(wrong.value.processed === 0 && q().every((r) => r.status === "pending"), "a named row under ANOTHER tenant is not claimed (the tenant predicate is unconditional)")
  const one = await capturing(() => processEnrichmentQueue(B, { queueEntryId: "q1q1q1q1-q1q1-4q1q-8q1q-q1q1q1q1q1q1", supabase: svc }))
  const q1 = q().find((r) => r.id.startsWith("q1")), q2 = q().find((r) => r.id.startsWith("q2"))
  ok(one.value.processed === 1 && q1?.status === "skipped" && /live listing/.test(String(q1?.error_message)), "the named row is CLAIMED and SETTLED by the real drain — here at the owner's suppression gate (its contact is on a live listing), no provider reached", JSON.stringify({ processed: one.value.processed, q1: q1?.status, msg: q1?.error_message }))
  ok(q2?.status === "pending" && q2?.error_message === undefined, "…its OLDER sibling is UNTOUCHED (still pending, no mark — the inline run is one row, not the batch)")
  ok(!svc.writes.some((w) => w.table === "lead_enrichment_queue" && w.op === "update" && w.matched > 1), "no queue write matched more than one row")
  const batch = await capturing(() => processEnrichmentQueue(B, { supabase: svc }))
  ok(batch.value.processed === 1 && q().find((r) => r.id.startsWith("q2"))?.status === "skipped", "POSITIVE CONTROL: the batch call (no id — the cron's shape) reaches the sibling the inline run left")
  ok(!svc.writes.some((w) => w.table === "vendor_usage_tracking"), "no vendor spend was booked by either run (the gate settled both rows before money)")
}

console.log("\n━━━ D · source, stripped ━━━")
{
  for (const [file, idCol] of [[CONTACT_CORE, "contact_id"], [LEAD_CORE, "lead_id"]] as const) {
    const src = stripped(file)
    const insertAt = src.search(/\.from\("lead_enrichment_queue"\)\.insert\(\{/)
    const readBackAt = src.indexOf('.select("id").single()', insertAt)
    const dispatchAt = src.indexOf("dispatchInlineEnrichmentDrain(", insertAt)
    ok(insertAt > -1 && readBackAt > insertAt && dispatchAt > readBackAt, `${file}: the queue insert READS BACK its id (.select("id").single()) and dispatches the drain AFTER the write (${idCol} track)`)
    ok(/queueEntryId\s*\?\s*dispatchInlineEnrichmentDrain\(\{ brokerageId, queueEntryId \}, params\.inlineDrain\)/.test(src), `${file}: the drain is dispatched for the read-back id under the writer's tenant, honouring the caller's seam / opt-out`)
    ok(/inlineDrain\?: InlineEnrichmentDrain \| false/.test(src), `${file}: the seam is optional — every existing door keeps its call shape`)
  }
  const orch = stripped(ORCH)
  ok(/if \(opts\.queueEntryId\) queueQuery = queueQuery\.eq\('id', opts\.queueEntryId\)/.test(orch) && /\.limit\(opts\.queueEntryId \? 1 : BATCH_SIZE\)/.test(orch), "the orchestrator narrows to the ONE named row (and limit 1) when asked")
  ok(/\.from\('lead_enrichment_queue'\)\s*\.select\([^)]*\)\s*\.eq\('brokerage_id', brokerageId\)\s*\.eq\('status', 'pending'\)/.test(orch), "…with the tenant predicate UNCONDITIONAL (never inside the narrowing branch)")
  ok(/const supabase = opts\.supabase \?\? createServiceClient\(\)/.test(orch), "the client seam is the writers' own idiom (opts.supabase ?? createServiceClient())")
  ok((orch.match(/export async function processEnrichmentQueue\(/g) ?? []).length === 1, "ONE drainer — processEnrichmentQueue is the only export that drains (law 2)")
  ok(/processEnrichmentQueue\(brokerage\.id\)/.test(stripped(CRON)), "the cron route calls the SAME function with no id — the batch backstop")
  const drain = stripped(DRAIN)
  ok(/return env\.NEXT_RUNTIME \? "app_runtime" : null/.test(drain) && /if \(env\.ENRICHMENT_INLINE_DRAIN === "off"\) return null/.test(drain), "the default drain is gated on the app runtime with a kill switch")
  ok(/void Promise\.resolve\(\)\s*\.then\(\(\) => run\(target\)\)\s*\.catch\(/.test(drain) && /processEnrichmentQueue\(target\.brokerageId, \{ queueEntryId: target\.queueEntryId \}\)/.test(drain), "the default drain is the orchestrator for ONE row, scheduled and never awaited, its rejection caught")
  ok(!/from "@\/lib\/lead-pipeline\/enrichment-orchestrator"/.test(drain) && /await import\("@\/lib\/lead-pipeline\/enrichment-orchestrator"\)/.test(drain), "the orchestrator is imported LAZILY — the dispatch module pulls no provider graph into a queue writer's importers")
}

console.log("\n━━━ E · the door census (stripped, strings kept) ━━━")
{
  const DISPATCH = /\b(queueContactEnrichment|queueContactEnrichmentAndScore|enrichContactAfterIntake|captureContact|captureFormSubmission)\s*\(|KernelEvent\.(CONTACT_CREATED|CONTACT_CAPTURED)\b/
  const INSERT = /\.from\(\s*["']contacts["']\s*\)\s*\.(insert|upsert)\(/g
  /** The top-level keys of the object literal that follows `.insert(` (null when the payload is not a literal). */
  function payloadKeys(src: string, after: number): { keys: string[]; spread: boolean } | null {
    const lead = /^\s*/.exec(src.slice(after))?.[0].length ?? 0
    if (src[after + lead] !== "{") return null
    const open = after + lead
    let depth = 0, end = -1
    for (let i = open; i < src.length; i++) { const c = src[i]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { end = i; break } } }
    if (end === -1) return null
    // split the literal's body on depth-0 commas, then read each entry's key (`key:` / shorthand `key` / `...spread`)
    const entries: string[] = []; let d = 0, cur = ""
    for (const c of src.slice(open + 1, end)) { if ("{([".includes(c)) d++; else if ("})]".includes(c)) d--; if (c === "," && d === 0) { entries.push(cur); cur = "" } else cur += c }
    entries.push(cur)
    const keys: string[] = []; let spread = false
    for (const e of entries) {
      const t = e.trim()
      if (!t) continue
      if (t.startsWith("...")) { spread = true; continue }
      const k = /^["']?([A-Za-z_]\w*)["']?\s*(?::|$)/.exec(t)
      if (k) keys.push(k[1])
    }
    return { keys, spread }
  }
  type Door = { file: string; line: number; dispatches: boolean; identifierless: boolean; keys: string }
  function census(src: string, file: string): Door[] {
    const doors: Door[] = []
    const dispatches = DISPATCH.test(src)
    for (const m of src.matchAll(INSERT)) {
      const p = payloadKeys(src, (m.index ?? 0) + m[0].length)
      const identifierless = !!p && !p.spread && !p.keys.includes("email") && !p.keys.includes("phone")
      doors.push({ file, line: src.slice(0, m.index ?? 0).split("\n").length, dispatches, identifierless, keys: p ? (p.spread ? "…spread" : p.keys.join(",")) : "(not a literal)" })
    }
    return doors
  }
  const forged = census('const { data } = await svc.from("contacts").insert({ brokerage_id: b, first_name: "X", email: e, metadata: { k: 1 } }).select("id").single()', "cron-only.ts")
  ok(forged.length === 1 && !forged[0].dispatches && !forged[0].identifierless, "POSITIVE CONTROL: a door that inserts an EMAIL and relies on the cron alone is caught")
  const spread = census('await svc.from("contacts").insert({ ...payload, brokerage_id: b })', "spread.ts")
  ok(spread.length === 1 && !spread[0].identifierless, "POSITIVE CONTROL: a spread payload cannot prove it carries no identifier — it must dispatch")
  const placeholder = census('await svc.from("contacts").insert({ brokerage_id: b, first_name: "LinkedIn", last_name: "Lead", contact_type: "lead", metadata: { linkedin_person_id: id } }).select("id").single()', "placeholder.ts")
  ok(placeholder.length === 1 && placeholder[0].identifierless && placeholder[0].keys === "brokerage_id,first_name,last_name,contact_type,metadata", "an identifier-less placeholder (no email / phone key) is classified as such — the rail's identifier gate refuses it anyway", placeholder[0]?.keys)
  const hooked = census('await svc.from("contacts").insert({ brokerage_id: b, phone: p }).select("id").single()\nvoid import("@/lib/enrichment/contact-enrichment-core").then((m) => m.queueContactEnrichment({ contactId, brokerageId: b, triggerType: "x", supabase: svc }))', "hooked.ts")
  ok(hooked.length === 1 && hooked[0].dispatches && !hooked[0].identifierless, "NEGATIVE CONTROL: a phone-bearing door that queues is a dispatching door")
  const files = [...walkTs(join(ROOT, "lib")), ...walkTs(join(ROOT, "app"))]
  const doors: Door[] = []
  for (const f of files) doors.push(...census(stripComments(readFileSync(f, "utf8")), relative(ROOT, f)))
  const bad = doors.filter((d) => !d.dispatches && !d.identifierless)
  console.log(`  census: ${files.length} files; ${doors.length} contacts insert/upsert door(s); ${doors.filter((d) => d.dispatches).length} dispatch; ${doors.filter((d) => !d.dispatches && d.identifierless).length} identifier-less placeholder(s); ${bad.length} cron-only`)
  for (const d of doors) console.log(`    ${d.dispatches ? "·" : d.identifierless ? "○" : "✗"} ${d.file}:${d.line} ${d.dispatches ? "dispatches" : d.identifierless ? `placeholder (${d.keys})` : `CRON-ONLY (${d.keys})`}`)
  ok(doors.length >= 15, `positive control: the census sees the doors (${doors.length} ≥ 15)`)
  ok(bad.length === 0, "every contacts create door dispatches enrichment, or inserts an identifier-less placeholder the rail refuses anyway", bad.map((d) => `${d.file}:${d.line}`).join(", "))
  // the door this lane hooked, by name (a direct hook rots silently — enrichment-suppression-simulator's rule)
  const wa = stripped("app/api/webhooks/whatsapp/route.ts")
  ok(/queueContactEnrichment\(\{ contactId: newContactId, brokerageId: tenantId, triggerType: "whatsapp_dm", supabase: svc \}\)/.test(wa), "the WhatsApp door (a contact WITH a phone, no kernel event) now queues — hooked by name")
  // the brief's named doors, by name
  for (const [door, token] of [
    ["lib/kernel/lead-magnets.ts", /queueContactEnrichment\s*\(/],            // captureFormSubmission
    ["app/api/forms/submit/route.ts", /captureFormSubmission\s*\(/],          // /api/forms/submit — consolidated onto the lead-magnets survivor (wave 142E), which queues
    ["lib/ads/ad-lead-intake.ts", /queueContactEnrichment\s*\(/],             // ad-lead intake
    ["app/actions/business-card/business-card-actions.ts", /captureContact\s*\(/], // the scanner
    ["lib/kernel/crm.ts", /enrichContactAfterIntake\s*\(/],                   // manual create (survivor)
    ["lib/contact-pipeline/contact-capture.ts", /queueContactEnrichmentAndScore\s*\(/], // the identity layer every capture door shares
  ] as const) ok(token.test(stripped(door)), `named door dispatches: ${door}`)
}

console.log("\n━━━ F · registration ━━━")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  ok(/immediate-enrichment-guard\.ts/.test(pkg.scripts["test:immediate-enrichment"] ?? ""), "package.json registers test:immediate-enrichment")
  ok(new RegExp("npm run test:immediate-enrichment(\\s|&|$)").test(pkg.scripts.guard ?? ""), "the guard chain runs it (membership, not position)")
  const d = MAINTENANCE_DOMAINS.immediate_enrichment
  ok(!!d && d.proof === "test:immediate-enrichment" && d.manager === "data_steward" && (d.coOwners ?? []).includes("ai_isa") && (d.coOwners ?? []).includes("cron_manager"), "MAINTENANCE_DOMAINS.immediate_enrichment: data_steward accountable, ai_isa + cron_manager co-own")
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
console.log("  blind spots: the drain's paid lanes are not executed (settled at the suppression gate on purpose); the census reads one file at a time (a dispatch in an imported helper is reported, not trusted); a non-literal payload must dispatch.")
if (fail > 0) { for (const f of failures) console.log(`   - ${f}`); console.log(" ❌ IMMEDIATE_ENRICHMENT_FAIL"); process.exit(1) }
console.log(" ✅ IMMEDIATE_ENRICHMENT_PASS — the row just written is drained now; the cron is the backstop")
