/**
 * scripts/canaries/wave146-communications.ts — COMMUNICATIONS canary (wave 146, lane 146J; owner rulings 2, 3, 7, 10; contracts
 * C1, C2, C7 — lane 146B):
 *   RULING 3 / C7 — "All providers need to also be able to be listening and watching if there is a receiving end … communication
 *     should be able to track both incoming and outgoing no matter which channel is used": every channel row declares RECEIVE
 *     truthfully (webhook / poll / none + the events), a declared webhook route EXISTS, a channel whose receiving end exists in the
 *     code is never declared deaf, every listening channel names the history it lands on, and a channel that names C1 reaches it.
 *   C1 — recordInboundCommunication: tenant + person + conversation matched, idempotent on (provider, providerRef) — one inbound
 *     event is ONE record, never two; a platform prospect's event carries no tenant data.
 *   RULING 2 — inbound social (comments / DMs / replies / mentions) reach the arbiter; 1:1 ad follow-up goes through C2.
 *   RULING 7 — the platform's own prospect funnel runs through the arbiter, on platform tables only (no cross-tenant memory).
 *   RULING 10 — `lead_magnet_promise_undelivered` (C4's signal) is a high-priority arbiter moment.
 *
 * Through the survivors at bf67aa63: lib/providers/channel-provider-matrix.ts (CHANNEL_PROVIDER_TRUTH, lane 145D's C1 matrix),
 * lib/ai-isa/followup-arbiter.ts, lib/platform/prospect-followup.ts, app/api/webhooks/** and app/api/providers/inbound. Nothing is
 * sent: C1 is driven on an in-memory client; every other step reads STRIPPED source with a positive control on its finder.
 *
 * MEASURED AT bf67aa63: no row of CHANNEL_PROVIDER_TRUTH declares `receive`; lib/communications/inbound-record.ts does not exist;
 * runProspectFollowupSweep composes and sends with no arbiter; the arbiter names no lead-magnet promise moment.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { setSvc } from "./_harness"
import { ROOT, listFiles, readRepo, strippedRepo } from "./_registry"
import { blankComments, blankStrings, stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { CONTRACTS_146, SIGNAL_PROMISE_UNDELIVERED, bind146, callDoor, canary146, changedTables, errText, foreignTenantWrites, jsonOf, rowCounts, rowIds, snapshot, tableDiff, totalAdded } from "./wave146-harness"

// ── WAVE146 BIND (lane 146B notes, "## Canary requirements") ── not published at the time of writing; the contract names below are
// the spec's (C1 / C7) and lane 146E's C2; lane 146B's social-inbound module is found by its spec'd path (lib/social/inbound*).

/** PURE — the app route file a declared route path names (`/api/webhooks/x` → app/api/webhooks/x/route.ts), or null. */
export function routeFile(route: string): string | null {
  const clean = route.split(/[?\s]/)[0].replace(/\/+$/, "")
  if (!clean.startsWith("/api/")) return null
  const f = `app${clean}/route.ts`
  return existsSync(join(ROOT, f)) ? f : null
}

/** The repo-relative module files a source imports through "@/…" (one level) — static `from "@/…"` AND dynamic `import("@/…")`
 *  (RE-ASSERTED at the lane-146B dry bind: every door reaches C1 through a lazy `await import(...)`, which a static-only walk
 *  read as "not reaching" — a blind finder accusing wired code) — resolved to .ts / .tsx / index.ts. */
export function importedModules(strippedSrc: string): string[] {
  const out: string[] = []
  for (const m of strippedSrc.matchAll(/(?:from\s+|import\(\s*)["']@\/([^"']+)["']/g)) {
    for (const cand of [`${m[1]}.ts`, `${m[1]}.tsx`, `${m[1]}/index.ts`]) if (existsSync(join(ROOT, cand))) { out.push(cand); break }
  }
  return out
}

/** Does `file`, or a module it imports (up to `depth` levels), CALL `fnName(` in stripped source? Returns the file that does. */
export function reachesCall(file: string, fnName: string, depth = 2, seen = new Set<string>()): string | null {
  if (seen.has(file)) return null
  seen.add(file)
  const src = strippedRepo(file) ?? ""
  if (new RegExp(`\\b${fnName}\\s*\\(`).test(src)) return file
  if (depth <= 0) return null
  for (const f of importedModules(src)) { const hit = reachesCall(f, fnName, depth - 1, seen); if (hit) return hit }
  return null
}

/**
 * PURE — the literal action names a source hands the action ledger: every `withActionLedger(` / `ledger(` call (a deps-injected
 * ledger is the same door) whose first argument is an object literal, its TOP-LEVEL `action: "<literal>"`. Brace matching runs on
 * blankStrings (a brace inside a string is not structure); the name is read from blankComments (a tombstone is not a call; the
 * name itself is a string). A computed name (a variable, a template) is not read — published as a blind spot by the caller.
 */
export function ledgeredActionNames(src: string): string[] {
  const code = blankComments(src), shape = blankStrings(src)
  const out: string[] = []
  for (const m of shape.matchAll(/\b(?:withActionLedger|ledger)\s*(?:<[^>()]*>)?\s*\(\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1
    let depth = 0, end = -1
    for (let i = open; i < shape.length; i++) { const ch = shape[i]; if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { end = i; break } } }
    if (end < 0) continue
    // top level only: blank nested braces' contents so `actor: { action: … }` (never seen, but possible) is not read as the name
    let body = "", d = 0
    for (let i = open + 1; i < end; i++) { const ch = shape[i]; if (ch === "{") d++; if (d === 0) body += code[i]; else body += " "; if (ch === "}") d-- }
    const hit = body.match(/(?:^|[,{\s])action\s*:\s*["']([^"'\n]+)["']/)
    if (hit) out.push(hit[1])
  }
  return out
}

interface ReceiveTruth { supported?: unknown; via?: unknown; events?: unknown; route?: unknown }

export async function run() {
  const c = canary146("Communications: every channel declares RECEIVE truthfully (C7) · every inbound event is ONE canonical record (C1) · inbound social + 1:1 ad follow-up reach the arbiter (C2) · the platform prospect funnel is arbitrated · an undelivered lead-magnet promise is a high-priority moment")

  // ── 1 · C7: every channel declares RECEIVE truthfully ──
  const matrix = await quiet(async () => import("../../lib/providers/channel-provider-matrix")) as unknown as Record<string, any>
  const truth = (matrix.CHANNEL_PROVIDER_TRUTH ?? {}) as Record<string, ReceiveTruth & { receive?: ReceiveTruth }>
  const channels = Object.keys(truth)
  const rec = (ch: string): ReceiveTruth | null => (truth[ch]?.receive && typeof truth[ch].receive === "object" ? truth[ch].receive! : null)
  const VIA = new Set(["webhook", "poll", "none"])
  const malformed: string[] = [], deadRoutes: string[] = []
  for (const ch of channels) {
    const r = rec(ch)
    if (!r) { malformed.push(`${ch}: no receive`); continue }
    if (typeof r.supported !== "boolean" || !VIA.has(String(r.via)) || !Array.isArray(r.events)) { malformed.push(`${ch}: shape ${jsonOf(r).slice(0, 60)}`); continue }
    if (r.supported !== (r.via !== "none")) malformed.push(`${ch}: supported ${r.supported} but via ${r.via}`)
    if (r.supported && (r.events as unknown[]).length === 0) malformed.push(`${ch}: listens to no event`)
    if (r.via === "webhook") for (const route of [r.route].flat().filter(Boolean) as string[]) if (!routeFile(route)) deadRoutes.push(`${ch}: ${route}`)
    if (r.via === "webhook" && ![r.route].flat().filter(Boolean).length) malformed.push(`${ch}: webhook with no route`)
  }
  // "Every channel listens WHERE THE PROVIDER CAN": a channel whose receiving end already exists in the code is never declared deaf.
  const LISTENING_AT_HEAD: Record<string, string> = { email: "/api/webhooks/inbound-mail", sms: "/api/providers/inbound" }
  const deafButCan = Object.entries(LISTENING_AT_HEAD).filter(([ch, route]) => routeFile(route) && rec(ch)?.supported !== true).map(([ch]) => ch)
  const routeControl = routeFile("/api/webhooks/inbound-mail") !== null && routeFile("/api/webhooks/never-a-route-146j") === null
  // WAVE146 BIND (lane 146B requirement 1): a webhook route EXPORTS POST (a poll route GET); a channel the code cannot hear is never
  // claimed — voice_drop while no disposition postback (c_dispo_url) is sent, a BYO Telnyx / Bandwidth number while the inbound router
  // has no verifier for it; and every provider whose vendor DOCUMENTS a receiver the code does not run says so in `gap`.
  const verbOk = channels.every((ch) => { const r = rec(ch); if (!r || r.via === "none") return true; return [r.route].flat().filter(Boolean).every((route) => { const f = routeFile(String(route)); const s = f ? strippedRepo(f) ?? "" : ""; return new RegExp(`export\\s+(async\\s+function|const)\\s+${r.via === "poll" ? "GET" : "POST"}\\b`).test(s) }) })
  const dispoSent = listFiles("lib/voicedrop", (f) => /\.ts$/.test(f)).some((f) => /c_dispo_url/.test(strippedRepo(f) ?? ""))
  const voiceTruth = dispoSent || rec("voice_drop")?.supported === false
  const PRT = (matrix.PROVIDER_RECEIVE_TRUTH ?? null) as Record<string, { receive?: ReceiveTruth; documented?: { via?: string }; gap?: unknown }> | null
  const router = strippedRepo("lib/providers/inbound-router.ts") ?? ""
  const byoTruth = !!PRT && (["telnyx", "bandwidth"] as const).every((p) => new RegExp(`\\b${p}\\b`).test(router) || PRT[p]?.receive?.supported === false)
  const unbuiltSilent = PRT ? Object.entries(PRT).filter(([, v]) => v.documented?.via && v.documented.via !== "none" && v.receive?.supported === false && !(typeof v.gap === "string" ? v.gap.trim() : Array.isArray(v.gap) ? v.gap.length : v.gap)).map(([k]) => k) : []
  c.rule("146B", "C7 · EVERY CHANNEL DECLARES WHETHER AND HOW IT LISTENS — TRUTHFULLY (ruling 3: 'All providers need to also be able to be listening and watching if there is a receiving end … A channel with no receive capability declares it; nothing is invented'): every row of the ONE matrix (CHANNEL_PROVIDER_TRUTH) carries receive { supported, via webhook|poll|none, events[] }, supported ⇔ via ≠ none, a listening channel names its events, a webhook names a route that EXISTS in app/ and exports POST (a poll route GET), a channel whose receiving end exists in the code (email inbound parse, SMS inbound) is never declared deaf, a channel the code cannot hear is never claimed (voice drop without a disposition postback; a BYO Telnyx / Bandwidth number without a router verifier), and every provider whose vendor documents an unbuilt receiver names the gap (positive control: the inbound-mail route is found, an invented route is not)",
    channels.length > 0 && malformed.length === 0 && deadRoutes.length === 0 && deafButCan.length === 0 && routeControl && verbOk && voiceTruth && byoTruth && unbuiltSilent.length === 0,
    `${channels.length} channels; ${malformed.length ? `malformed: ${malformed.slice(0, 6).join(" | ")}` : "all declared"}; dead routes: ${deadRoutes.join(", ") || "none"}; routes export the verb ${verbOk}; deaf though a receiving end exists: ${deafButCan.join(",") || "none"}; voice drop honest ${voiceTruth}; BYO sms honest ${byoTruth}${PRT ? "" : " (no PROVIDER_RECEIVE_TRUTH)"}; documented-but-unbuilt without a gap: ${unbuiltSilent.join(",") || "none"}; route control ${routeControl}`)

  // ── 2 · …and a channel that says its inbound lands on C1 really hands it to C1 ──
  // RE-ASSERTED at the lane-146B dry bind (19:30Z, against lane 146B's worktree): the first form demanded that EVERY declared
  // webhook reach C1 — but a receiving end also carries delivery TRACKING (Lob's in_transit / delivered), a lead-ad submission
  // (THE lead pipeline) and call progress, none of which is a person's message. Ruling 3 is "every inbound event lands in ONE
  // canonical history … nothing is invented": so every row names the history it lands on (`record`), and a row that NAMES C1 is
  // held to it — at least one of its declared routes (primary or alsoRoutes) calls recordInboundCommunication itself or through a
  // module it imports, statically or lazily (two levels, stripped source). A row that names another history is published below.
  const routesOf = (r: ReceiveTruth & { alsoRoutes?: unknown }) => [r.route, r.alsoRoutes].flat().filter((x): x is string => typeof x === "string" && x.length > 0)
  const listening = channels.map((ch) => ({ ch, r: rec(ch) as (ReceiveTruth & { alsoRoutes?: unknown; record?: unknown }) | undefined })).filter((x) => x.r && x.r.via !== "none" && x.r.supported === true)
  const unnamedRecord = listening.filter((x) => typeof x.r!.record !== "string" || !String(x.r!.record).trim()).map((x) => x.ch)
  const claimsC1 = listening.filter((x) => /recordInboundCommunication|\bC1\b/.test(String(x.r!.record ?? "")))
  const claimNotKept = claimsC1.filter((x) => !routesOf(x.r!).some((route) => { const f = routeFile(route); return !!f && !!reachesCall(f, "recordInboundCommunication") })).map((x) => x.ch)
  const elsewhere = listening.filter((x) => !claimsC1.includes(x)).map((x) => `${x.ch} → ${String(x.r!.record ?? "").split(/[—(;]/)[0].trim().slice(0, 60)}`)
  // POSITIVE CONTROLS for the reach finder: a tombstone naming the function is not a call; a lazy import IS followed.
  const reachControl = !/\brecordInboundCommunication\s*\(/.test(stripComments("// recordInboundCommunication(x) — tombstone")) && /\brecordInboundCommunication\s*\(/.test(stripComments("await recordInboundCommunication({ provider })")) && jsonOf(importedModules(`const { x } = await import("@/lib/kernel/action-ledger")`)) === jsonOf(["lib/kernel/action-ledger.ts"])
  c.rule("146B", "EVERY INBOUND EVENT LANDS IN ONE CANONICAL HISTORY, AND A CHANNEL THAT CLAIMS C1 KEEPS THE CLAIM (ruling 3: 'every inbound event lands in ONE canonical communication history matched to tenant + person + conversation, deduplicated … nothing is invented'): every listening channel names the history its inbound lands on, and every channel that names C1 (recordInboundCommunication) has a declared receive route that reaches it — itself or through a module it imports, statically or lazily (two levels, stripped source; positive controls: a tombstone naming the function is not a call, a lazy import is followed)",
    listening.length > 0 && unnamedRecord.length === 0 && claimsC1.length > 0 && claimNotKept.length === 0 && reachControl,
    `${listening.length} listening channel(s); no record named: ${unnamedRecord.join(",") || "none"}; claiming C1: ${claimsC1.map((x) => x.ch).join(",") || "none"}; claim not kept: ${claimNotKept.join(",") || "none"}; landing on another history (published, not judged): ${elsewhere.join(" | ") || "none"}; finder control ${reachControl}`)

  // ── 3 · C1 driven: one inbound event is ONE record, tenant-matched; a platform prospect's carries no tenant data ──
  const C1 = await bind146(CONTRACTS_146.C1_INBOUND)
  await c.check("146B", "C1 · recordInboundCommunication IS IDEMPOTENT ON (provider, providerRef), TENANT-MATCHED, AND KEEPS A PLATFORM PROSPECT OFF TENANT DATA (ruling 3: 'matched to tenant + person + conversation, deduplicated'; ruling 7: 'no cross-tenant memory'): a contact's inbound SMS writes its record (≥ 1 row, all in the contact's brokerage); the SAME (provider, providerRef) again writes NOTHING more; a new providerRef writes again; a contact of ANOTHER brokerage named under this brokerage is refused or written nowhere outside this brokerage; a platform prospect's inbound email writes no row carrying a brokerage_id", async () => {
    if (!C1.mod) return { ok: false, evidence: C1.evidence }
    const B = "aaaaaaaa-0146-4000-8000-00000000000b", B2 = "aaaaaaaa-0146-4000-8000-0000000000b2"
    const svc = memSupabase({
      // A contact's thread is owned by an agent (the conversation resolver refuses a thread with no owner — measured at the
      // lane-146B dry bind), so each brokerage carries its agent.
      contacts: [{ id: "c-1", contact_id: "cc-1", brokerage_id: B, agent_id: "ag-1", first_name: "Pat", email: "pat@example.test", phone: "+15555550101" }, { id: "c-x", contact_id: "cc-x", brokerage_id: B2, agent_id: "ag-x", first_name: "Sam", phone: "+15555550199" }],
      agents: [{ id: "ag-1", user_id: "u-1", brokerage_id: B, is_active: true }, { id: "ag-x", user_id: "u-x", brokerage_id: B2, is_active: true }],
      leads: [], platform_prospects: [{ id: "pp-1", email: "owner@prospect.example.test", status: "contacted" }],
      agent_client_messages: [], conversations: [], messages: [], lead_conversation_history: [], message_provider_logs: [], kernel_events: [], agent_action_ledger: [], activities: [], notifications: [],
    }, { uuidIds: true, stampCreatedAt: true })
    setSvc(svc)
    const fn = C1.mod.recordInboundCommunication as (...a: unknown[]) => Promise<unknown>
    // The contract's signature is recordInboundCommunication(input[, deps]); the door's client rides `deps.client` (and the
    // harness's service-client stub, setSvc, answers a default client) — a (svc, input) shape is accepted too.
    const call = async (input: Record<string, unknown>) => { try { return { r: await quiet(async () => callDoor(fn, svc, input)) as Record<string, unknown> | null, e: null as string | null } } catch (e) { return { r: null, e: errText(e) } } }
    const base = { channel: "sms", provider: "twilio", body: "Is the house on Elm still available?", receivedAt: "2026-10-29T15:00:00Z" }
    const t0 = rowCounts(svc.tables), ids0 = rowIds(svc.tables)
    const first = await call({ ...base, brokerageId: B, providerRef: "SM-146J-1", party: { kind: "contact", id: "c-1" } })
    const d1 = tableDiff(t0, svc.tables)
    const t1 = rowCounts(svc.tables)
    const again = await call({ ...base, brokerageId: B, providerRef: "SM-146J-1", party: { kind: "contact", id: "c-1" } })
    const d2 = tableDiff(t1, svc.tables)
    const t2 = rowCounts(svc.tables)
    const next = await call({ ...base, brokerageId: B, providerRef: "SM-146J-2", party: { kind: "contact", id: "c-1" } })
    const d3 = tableDiff(t2, svc.tables)
    const foreign1 = foreignTenantWrites(ids0, svc.tables, B)
    const t3 = rowCounts(svc.tables), ids3 = rowIds(svc.tables)
    const cross = await call({ ...base, brokerageId: B, providerRef: "SM-146J-3", party: { kind: "contact", id: "c-x" } })
    const foreign2 = foreignTenantWrites(ids3, svc.tables, B)
    const crossWrote = totalAdded(tableDiff(t3, svc.tables))
    const crossRefused = cross.e !== null || cross.r === null || (cross.r as Record<string, unknown>).ok === false || !!(cross.r as Record<string, unknown>).error || crossWrote === 0
    const ids4 = rowIds(svc.tables), snap4 = snapshot(svc.tables)
    const prospect = await call({ platform: true, channel: "email", provider: "sendgrid", providerRef: "msg-146J-p", party: { kind: "platform_prospect", id: "pp-1" }, body: "Tell me more", receivedAt: "2026-10-29T15:05:00Z" })
    const prospectTenantRows: string[] = []
    for (const [t, rows] of Object.entries(svc.tables)) for (const r of rows) if (!ids4.has(`${t}:${String(r.id)}`) && r.brokerage_id != null) prospectTenantRows.push(t)
    // A prospect's inbound may land on the prospect's OWN row (an update adds no row) — "recorded" = any table changed.
    const prospectChanged = changedTables(snap4, svc.tables)
    // Lane 146B requirements 2–3: the retry SAYS it is the same record; the scope is the platform OR a tenant, never mixed, and an
    // unidentified sender needs the door's thread — nothing is fabricated; the record never creates a person (no contacts / leads insert).
    const dupFlag = (again.r as Record<string, unknown> | null)?.duplicate === true && (again.r as Record<string, unknown> | null)?.recordId === (first.r as Record<string, unknown> | null)?.recordId
    const refusedOf = (x: { r: Record<string, unknown> | null; e: string | null }) => !!x.e || !x.r || x.r.recorded === false && !!x.r.error
    const mixed1 = await call({ ...base, platform: true, providerRef: "SM-146J-x1", party: { kind: "contact", id: "c-1" } })
    const mixed2 = await call({ ...base, brokerageId: B, providerRef: "SM-146J-x2", party: { kind: "platform_prospect", id: "pp-1" } })
    const nobody = await call({ ...base, brokerageId: B, providerRef: "SM-146J-x3", party: null })
    const rec = strippedRepo(CONTRACTS_146.C1_INBOUND.file) ?? ""
    const createsPerson = /\.from\(\s*["'](contacts|leads)["']\s*\)\s*\.\s*insert\s*\(/.test(rec)
    const scopeOk = refusedOf(mixed1) && refusedOf(mixed2) && refusedOf(nobody) && !createsPerson
    const ok = !first.e && totalAdded(d1) >= 1 && totalAdded(d2) === 0 && dupFlag && totalAdded(d3) >= 1 && foreign1.length === 0 && crossRefused && foreign2.length === 0 && !prospect.e && prospectChanged.length >= 1 && prospectTenantRows.length === 0 && scopeOk
    return { ok, evidence: `first → ${first.e ?? `wrote ${jsonOf(d1)}`}; same providerRef → ${again.e ?? `wrote ${jsonOf(d2)}, says duplicate of the first ${dupFlag}`}; new providerRef → wrote ${jsonOf(d3)}; foreign-tenant rows ${foreign1.join(",") || "none"}; another brokerage's contact → ${crossRefused ? "refused / nothing written" : `WROTE ${crossWrote}`} (foreign rows ${foreign2.join(",") || "none"}); platform prospect → ${prospect.e ?? `changed ${prospectChanged.join(",") || "nothing"}, tenant-tagged rows ${prospectTenantRows.join(",") || "none"}`}; platform+contact ${refusedOf(mixed1) ? "refused" : "RECORDED"}, tenant+prospect ${refusedOf(mixed2) ? "refused" : "RECORDED"}, unidentified without a thread ${refusedOf(nobody) ? "refused" : "RECORDED"}; creates a person ${createsPerson}` }
  })

  // ── 3b · the CHAIN on top of C1: a retried inbound never runs anything downstream twice; a STOP is honoured and never answered ──
  // WAVE146 BIND (lane 146B requirement 2, second half): processInboundCommunication (C1's module) on a DUPLICATE never calls respond,
  // optOut or emit again. Driven through its own seams (respond / optOut / emit / stopSequences / classify / promise), so nothing is
  // sent and no model is asked. POSITIVE CONTROL: the FIRST delivery of the same event DOES reach the bell (emit) and the arbiter
  // (respond) — a chain that never calls anything would otherwise pass the duplicate half by doing nothing at all.
  await c.check("146B", "C1 · A RETRIED INBOUND IS ANSWERED ONCE, AND A PERSON WHO SAYS STOP IS NEVER ANSWERED (ruling 3: 'dedup → ONE canonical record → intent extraction → arbiter → governed action'; ruling 2: 'Never spam'): the chain on C1 (processInboundCommunication) delivers a new inbound to the bell and the arbiter; the SAME (provider, providerRef) delivered again calls neither — nor the opt-out writer, nor the classifier, nor the owed-promise check; an inbound 'STOP' is written as an opt-out and the arbiter is not asked to answer it", async () => {
    if (!C1.mod) return { ok: false, evidence: C1.evidence }
    const process = C1.mod.processInboundCommunication as ((input: Record<string, unknown>, deps: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined
    if (typeof process !== "function") return { ok: false, evidence: `processInboundCommunication is not exported from ${CONTRACTS_146.C1_INBOUND.file} (lane 146B — the chain on top of C1)` }
    const B = "aaaaaaaa-0146-4000-8000-0000000000b3"
    const svc = memSupabase({
      contacts: [{ id: "c-ch", contact_id: "cc-ch", brokerage_id: B, agent_id: "ag-ch", first_name: "Lee", phone: "+15555550131", dnc_status: false }],
      agents: [{ id: "ag-ch", user_id: "u-ch", brokerage_id: B }], leads: [], platform_prospects: [],
      agent_client_messages: [], conversations: [], messages: [], lead_conversation_history: [], message_provider_logs: [], kernel_events: [], agent_action_ledger: [], activities: [], notifications: [],
    }, { uuidIds: true, stampCreatedAt: true })
    setSvc(svc)
    const n = { respond: 0, optOut: 0, emit: 0, classify: 0, promise: 0, stop: 0 }
    const deps = {
      client: svc,
      respond: async () => { n.respond++; return { action: "reply_proposed", reason: "a person approves" } },
      optOut: async () => { n.optOut++; return { success: true } },
      emit: async () => { n.emit++; return { ok: true } },
      stopSequences: async () => { n.stop++; return { unenrolled: 0 } },
      classify: async () => { n.classify++; return { primary: "question", confidence: 80, urgency: "normal" } },
      promise: async () => { n.promise++; return { action: "nothing_owed", reason: "no open promise" } },
    }
    const inbound = (ref: string, body: string) => ({ brokerageId: B, channel: "sms", provider: "twilio", providerRef: ref, party: { kind: "contact", id: "c-ch" }, body, receivedAt: "2026-10-29T16:00:00Z" })
    const run = async (input: Record<string, unknown>) => { try { return { r: await quiet(async () => process(input, deps)), e: null as string | null } } catch (x) { return { r: null, e: errText(x) } } }
    const first = await run(inbound("SM-146J-chain-1", "Can we see it Saturday?"))
    const afterFirst = { ...n }
    const retry = await run(inbound("SM-146J-chain-1", "Can we see it Saturday?"))
    const afterRetry = { ...n }
    const downstreamAgain = (Object.keys(n) as Array<keyof typeof n>).filter((k) => afterRetry[k] !== afterFirst[k])
    const control = afterFirst.emit >= 1 && afterFirst.respond >= 1
    const respondBeforeStop = n.respond
    const stop = await run(inbound("SM-146J-chain-stop", "STOP"))
    const stopAnswered = n.respond - respondBeforeStop
    const stopWritten = n.optOut >= 1
    const retryRecord = (retry.r?.record ?? {}) as Record<string, unknown>
    const ok = !first.e && !retry.e && control && downstreamAgain.length === 0 && retryRecord.duplicate === true && !stop.e && stopWritten && stopAnswered === 0
    return { ok, evidence: `first delivery → ${first.e ?? `bell ${afterFirst.emit}×, arbiter ${afterFirst.respond}×, classifier ${afterFirst.classify}×, promise check ${afterFirst.promise}×`} (control ${control}); the same providerRef again → ${retry.e ?? `duplicate ${retryRecord.duplicate}, ran again: ${downstreamAgain.join(",") || "nothing"}`}; 'STOP' → ${stop.e ?? `opt-out written ${stopWritten}, arbiter asked to answer ${stopAnswered}×`}` }
  })

  // ── 4 · RULING 2: inbound social reaches the arbiter; 1:1 ad follow-up is one experience kind through C2 ──
  const socialInbound = listFiles("lib/social", (f) => /\/inbound[^/]*\.ts$/.test(f))
  // RE-ASSERTED at bind (lane 146B requirement 9): the chain is door → (ingestInboundSocialEvents →) processInboundCommunication →
  // record (C1) → the arbiter's responder; the social module reaches the arbiter THROUGH the chain, not by importing it — so "reaches
  // the arbiter" = reaches processInboundCommunication / respondToInboundCommunication / an arbitrate* call. Its governance is the
  // responder step below (never a word match on "approval").
  const reachesArbiter = (f: string) => ["processInboundCommunication", "respondToInboundCommunication"].some((fn) => reachesCall(f, fn, 2)) || /\barbitrate\w*\s*\(/.test(strippedRepo(f) ?? "")
  const socialRecords = socialInbound.filter((f) => reachesCall(f, "recordInboundCommunication", 2))
  const socialArbiter = socialInbound.filter(reachesArbiter)
  const socialHooks = ["app/api/webhooks/meta-dm/route.ts", "app/api/webhooks/linkedin/route.ts", "app/api/webhooks/twitter/route.ts", "app/api/webhooks/whatsapp/route.ts"].filter((f) => existsSync(join(ROOT, f)))
  const hooksReach = socialHooks.filter((f) => reachesCall(f, "processInboundCommunication") || reachesCall(f, "ingestInboundSocialEvents") || reachesCall(f, "recordInboundCommunication"))
  const metaDirectInsert = /\.from\(\s*["']messages["']\s*\)\s*\.\s*insert\s*\(/.test(strippedRepo("app/api/webhooks/meta-dm/route.ts") ?? "")
  // WAVE146 BIND (lane 146B requirement 9): a social door that still files into the communication spine (client_portal_messages)
  // is a SECOND history. Read from comment-blanked source (the import specifier is a string, so blankComments, never blankStrings).
  // POSITIVE CONTROL: the finder sees a spine import in a specimen and not in a tombstone naming it.
  const spineImport = (src: string) => /\bfrom\s+["']@\/lib\/communication-spine(?:\/[^"']*)?["']|import\(\s*["']@\/lib\/communication-spine/.test(blankComments(src))
  const spineControl = spineImport(`import { ingestMessage } from "@/lib/communication-spine/ingestMessageService"`) && !spineImport(`// was: import { ingestMessage } from "@/lib/communication-spine" — replaced by processInboundCommunication`)
  const spineDoors = socialHooks.filter((f) => spineImport(readRepo(f) ?? ""))
  c.rule("146B", "INBOUND SOCIAL REACHES THE ARBITER THROUGH THE ONE CANONICAL RECORD (ruling 2: 'Incoming social comments / DMs / replies / mentions / campaign interactions reach the arbiter'; ruling 3 'ONE canonical communication history'): a lib/social/inbound* module records every inbound comment / DM / reply / mention through C1 and reaches the arbiter's responder; every social webhook that exists (meta-dm, linkedin, twitter, whatsapp) reaches the chain; the meta-dm door no longer writes messages itself and no social door files into the communication spine (a second writer would be a second history; positive control on the spine finder)",
    socialInbound.length > 0 && socialRecords.length > 0 && socialArbiter.length > 0 && hooksReach.length === socialHooks.length && !metaDirectInsert && spineDoors.length === 0 && spineControl,
    `social inbound modules: ${socialInbound.join(", ") || "none (lane 146B: lib/social/inbound*)"}; record via C1 ${socialRecords.length}; reach the arbiter ${socialArbiter.length}; social webhooks reaching the chain ${hooksReach.length}/${socialHooks.length}; meta-dm writes messages directly ${metaDirectInsert}; doors still filing into the spine: ${spineDoors.join(", ") || "none"} (finder control ${spineControl})`)
  // WAVE146 BIND (lane 146B requirement 5): respondToInboundCommunication — the arbiter's answer to an inbound is GOVERNED: a public
  // reply (a comment / mention) is never auto-sent, nothing auto-sends without the tenant's autonomous posture, and a DNC contact is
  // never put to the model (positive control: for an ordinary contact the model IS consulted).
  // RE-ASSERTED at bind (lane 146B worktree, 19:20Z): the responder moved out of followup-arbiter.ts into its own module
  // (lib/communications/inbound-responder.ts — kept off every dashboard page's module graph). The step binds the NAME wherever it is
  // exported among the arbiter's modules, never one file.
  const RESPONDER_HOMES = ["lib/communications/inbound-responder.ts", "lib/ai-isa/followup-arbiter.ts", CONTRACTS_146.C1_INBOUND.file]
  let arbR: Record<string, any> = {}, responderHome = "none"
  for (const f of RESPONDER_HOMES) {
    if (!existsSync(join(ROOT, f))) continue
    const m = await quiet(async () => import(join(ROOT, f))).catch(() => null) as Record<string, any> | null
    if (m && typeof m.respondToInboundCommunication === "function") { arbR = m; responderHome = f; break }
  }
  await c.check("146B", "THE ARBITER'S ANSWER TO AN INBOUND IS GOVERNED, NEVER SPAM (ruling 2: 'proposes or executes permitted responses through the tenant's authorized account … human approval where policy, risk or provider rules require. Never spam, never impersonate'): a PUBLIC comment is never answered automatically; with the tenant not on an autonomous posture nothing is sent automatically; a contact on do-not-contact is never put to the model; control: an ordinary contact's DM is put to the model", async () => {
    if (typeof arbR.respondToInboundCommunication !== "function") return { ok: false, evidence: `respondToInboundCommunication is not exported from any of ${RESPONDER_HOMES.join(", ")} (lane 146B)` }
    const B = "aaaaaaaa-0146-4000-8000-00000000000d"
    const s = memSupabase({ contacts: [{ id: "c-ok", contact_id: "cc-ok", brokerage_id: B, agent_id: "ag-r", dnc_status: false, first_name: "Ola" }, { id: "c-dnc", contact_id: "cc-dnc", brokerage_id: B, agent_id: "ag-r", dnc_status: true, first_name: "Dee" }], agents: [{ id: "ag-r", user_id: "u-r", brokerage_id: B }], conversations: [], messages: [], agent_action_ledger: [], notifications: [], social_media_accounts: [{ id: "acct-1", brokerage_id: B, platform: "facebook", is_active: true }] }, { uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    setSvc(s)
    let decides = 0, sends = 0
    const deps = (autonomous: boolean) => ({
      decide: async () => { decides++; return { optionId: "reply", channel: "social", format: "written_message", waitHours: null, rationale: "answer the question", evidence: ["asked"], confidence: 0.9 } },
      autonomy: async () => ({ allowed: autonomous, reason: autonomous ? null : "posture is supervised" }),
      compose: async () => ({ text: "Thanks for asking — I'll send details." }),
      send: async () => { sends++; return { sent: true, providerMessageId: "m-1" } },
      propose: async () => ({ proposed: true }),
      safety: () => [] as string[],
      now: new Date("2026-10-29T15:00:00Z"),
    })
    const req = (contactId: string, isPublic: boolean) => ({ brokerageId: B, contactId, conversationId: "conv-1", recordId: `rec-${contactId}-${isPublic}`, channel: isPublic ? "social_comment" : "social_dm", provider: "meta", surface: "facebook", body: "Is it still available?", isPublic, threadRef: { page_id: "p1", sender_id: "s1", comment_id: isPublic ? "cm1" : "" }, intent: null, receivedAt: "2026-10-29T14:59:00Z" })
    const pub = await quiet(async () => arbR.respondToInboundCommunication(s, req("c-ok", true), deps(true))) as Record<string, unknown>
    const sup = await quiet(async () => arbR.respondToInboundCommunication(s, req("c-ok", false), deps(false))) as Record<string, unknown>
    const consulted = decides
    const before = decides
    const dnc = await quiet(async () => arbR.respondToInboundCommunication(s, req("c-dnc", false), deps(true))) as Record<string, unknown>
    const dncModel = decides - before
    const ok = pub.action !== "reply_sent" && sup.action !== "reply_sent" && dncModel === 0 && consulted >= 1
    return { ok, evidence: `[${responderHome}] public comment (autonomous) → ${pub.action}; private DM, supervised posture → ${sup.action}; do-not-contact → ${dnc.action} (model asked ${dncModel}×); model consulted for the ordinary contact ${consulted}×; automatic sends ${sends}` }
  })
  // The arbiter's side includes wherever its inbound responder lives (RESPONDER_HOMES — bound by name above).
  const arbiterFiles = [...new Set(["lib/ai-isa/followup-arbiter.ts", "lib/ai-isa/next-best-touch.ts", "app/actions/ai-isa/engage-contact.ts", ...RESPONDER_HOMES, ...socialInbound])]
  const reengageCallers = arbiterFiles.filter((f) => /\brequestAudienceReengagement\s*\(/.test(strippedRepo(f) ?? ""))
  const C2 = await bind146(CONTRACTS_146.C2_REENGAGE)
  c.rule(C2.mod ? "146B" : "146E", "1:1 AD FOLLOW-UP IS ONE OF THE ARBITER'S EXPERIENCES, THROUGH C2 ONLY (ruling 2: 'should do 1:1 ad follow up with audiences'; contract C2 'Lane B's arbiter calls it as one experience kind'): lane 146E's requestAudienceReengagement exists and the arbiter's side calls it (stripped source) — never a second audience path",
    !!C2.mod && reengageCallers.length > 0,
    `${C2.evidence}; arbiter-side callers: ${reengageCallers.join(", ") || "none"}`)

  // ── 5 · RULING 7: the platform prospect funnel is arbitrated, on platform tables only ──
  const pf = strippedRepo("lib/platform/prospect-followup.ts") ?? ""
  const pfArbiter = /\barbitrate\w*\s*\(/.test(pf) || importedModules(pf).some((f) => f === "lib/ai-isa/followup-arbiter.ts")
  const pfTables = [...new Set([...pf.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)/g)].map((m) => m[1]))]
  const TENANT_TABLES = /^(contacts|leads|agent_client_messages|transactions|listings|offers|agents|users|brokerages|conversations|contact_\w+|lead_\w+)$/
  const tenantRead = pfTables.filter((t) => TENANT_TABLES.test(t))
  const pfControl = TENANT_TABLES.test("contacts") && !TENANT_TABLES.test("platform_prospects")
  // WAVE146 BIND (lane 146B notes, 18:45Z requirement 8): arbitrateProspectFollowup — a prospect who wrote back is a PERSON's
  // (notify_staff, zero model calls); otherwise the model decides from platform facts with NO tenant in its call (control: it IS asked).
  const arbMod = await quiet(async () => import("../../lib/ai-isa/followup-arbiter")) as unknown as Record<string, any>
  let funnelDrive = "arbitrateProspectFollowup not exported", funnelOk = false
  if (typeof arbMod.arbitrateProspectFollowup === "function") {
    const calls: Array<{ brokerageId: unknown; prompt: string }> = []
    const decide = async (a: { brokerageId?: unknown; system: string; prompt: string }) => { calls.push({ brokerageId: a.brokerageId ?? null, prompt: a.prompt }); return { optionId: "send_now", channel: "email", format: "written_message", waitHours: null, rationale: "a timely intro", evidence: ["rung"], confidence: 0.8 } }
    const facts = (replied: boolean) => ({ roleInterest: "broker_owner", source: "website", hoursSinceCreated: 30, hoursSinceLastFollowup: 26, followupCount: 1, repliedSinceLastTouch: replied, daysDeferred: 0 })
    const replied = await quiet(async () => arbMod.arbitrateProspectFollowup({ rung: "nudge", facts: facts(true) }, { decide })) as Record<string, unknown>
    const afterReplied = calls.length
    const quietOne = await quiet(async () => arbMod.arbitrateProspectFollowup({ rung: "nudge", facts: facts(false) }, { decide })) as Record<string, unknown>
    // RE-ASSERTED at the lane-146B dry bind: the arbiter's decide call carries a scope label ("platform" for the platform's own
    // funnel); a TENANT in the call is a tenant id (uuid-shaped) or a brokerage key in the prompt — never the platform label.
    const tenantInCall = calls.some((x) => (typeof x.brokerageId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(x.brokerageId)) || /brokerage_?id|aaaaaaaa-0146/i.test(x.prompt))
    funnelOk = replied.action === "notify_staff" && afterReplied === 0 && calls.length >= 1 && !tenantInCall && ["send_now", "wait", "notify_staff"].includes(String(quietOne.action))
    funnelDrive = `wrote back → ${replied.action} (model calls ${afterReplied}); quiet prospect → ${quietOne.action} (model asked ${calls.length - afterReplied}×, tenant in the call ${tenantInCall})`
  }
  c.rule("146B", "THE PLATFORM'S OWN PROSPECT FUNNEL IS ARBITRATED (ruling 7: 'Yes platforms prospect funnel should be arbitrated' — platform sales authority, prospect consent, no cross-tenant memory): lib/platform/prospect-followup.ts decides each touch through the arbiter and reads no tenant table; a prospect who WROTE BACK goes to platform staff with no model call, and a quiet one is decided by the model with no tenant in the call (positive control: the model IS asked; 'contacts' is a tenant table, 'platform_prospects' is not)",
    pfArbiter && tenantRead.length === 0 && pfControl && funnelOk,
    `arbiter in the funnel ${pfArbiter}; tables read ${pfTables.join(",") || "none"}; tenant tables ${tenantRead.join(",") || "none"}; ${funnelDrive}; control ${pfControl}`)

  // ── 6 · RULING 10 (C4): an undelivered lead-magnet promise is a HIGH-PRIORITY arbiter moment ──
  // WAVE146 BIND (lane 146B requirement 7): respondToPromisedDeliverable — asks C4 only about a CONTACT, never offers WAIT (the model's
  // 'wait' is overridden — high priority), reports delivered only when the deliverer did; an unconverted lead has nothing owed.
  // And the moment is WIRED: a door other than the arbiter calls it (stripped source).
  await c.check("146B", `AN UNDELIVERED LEAD-MAGNET PROMISE IS A HIGH-PRIORITY ARBITER MOMENT (ruling 10: 'The arbiter needs to make sure that any deliverables that were promised from the lead magnet are delivered'; contract C4 'Lane B's arbiter treats it as a high-priority moment', signal '${SIGNAL_PROMISE_UNDELIVERED}'): asked about a contact with an undelivered promise, the arbiter delivers NOW through C4's deliverer even when the model says wait, says delivered only when the deliverer did (a deliverer that refuses is not 'delivered'), asks C4 about the CONTACT only, and an unconverted lead is owed nothing; a door outside the arbiter calls this moment (positive control: the model was consulted)`, async () => {
    if (typeof arbMod.respondToPromisedDeliverable !== "function") return { ok: false, evidence: "respondToPromisedDeliverable is not exported from lib/ai-isa/followup-arbiter.ts (lane 146B)" }
    const B = "aaaaaaaa-0146-4000-8000-00000000000c"
    // One client PER SCENARIO (RE-ASSERTED at the lane-146B dry bind): the moment is ledgered once per (promise set, day), so the
    // same contact asked twice on one client REPLAYS — correct idempotency, and not the refusing-deliverer case this step drives.
    const fresh = () => { const s = memSupabase({ contacts: [{ id: "c-p", contact_id: "cc-p", brokerage_id: B, agent_id: "ag-p", has_login: true, dnc_status: false }], leads: [{ id: "l-open", brokerage_id: B, contact_id: null, email: "lead146b@example.test" }], agents: [{ id: "ag-p", user_id: "u-p", brokerage_id: B }], agent_action_ledger: [], notifications: [] }, { uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } }); setSvc(s); return s }
    const asked: Array<Record<string, unknown>> = [], delivered: string[] = []
    let decides = 0
    const mk = (deliverOk: boolean) => ({
      undelivered: async (p: Record<string, unknown>) => { asked.push(p); return [{ id: "pr-1", status: "asset_missing", fulfilment: "system" }] },
      deliver: async (p: { promiseId: string }) => { delivered.push(p.promiseId); return deliverOk ? { delivered: true, status: "delivered" } : { delivered: false, status: "asset_missing", reason: "the guide did not render" } },
      decide: async () => { decides++; return { optionId: "wait", channel: null, format: null, waitHours: 48, rationale: "later is fine", evidence: ["x"], confidence: 0.9 } },
    })
    const good = await quiet(async () => arbMod.respondToPromisedDeliverable(fresh(), { brokerageId: B, party: { kind: "contact", id: "c-p" } }, mk(true))) as Record<string, any>
    const bad = await quiet(async () => arbMod.respondToPromisedDeliverable(fresh(), { brokerageId: B, party: { kind: "contact", id: "c-p" } }, mk(false))) as Record<string, any>
    const lead = await quiet(async () => arbMod.respondToPromisedDeliverable(fresh(), { brokerageId: B, party: { kind: "lead", id: "l-open" } }, mk(true))) as Record<string, any>
    const contactOnly = asked.every((p) => p.contactId === "c-p")
    const neverWaited = good.action !== "wait" && bad.action !== "wait"
    const callers = [...listFiles("lib", (f) => /\.ts$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))].filter((f) => f !== "lib/ai-isa/followup-arbiter.ts" && /\brespondToPromisedDeliverable\s*\(/.test(strippedRepo(f) ?? ""))
    const ok = good.action === "delivered" && bad.action !== "delivered" && neverWaited && contactOnly && /nothing_owed/.test(String(lead.action)) && delivered.length >= 2 && callers.length > 0
    return { ok, evidence: `model says wait → ${good.action} (${String(good.decision?.fallbackReason ?? good.reason ?? "").slice(0, 60)}); deliverer refuses → ${bad.action}; C4 asked about ${[...new Set(asked.map((p) => String(p.contactId)))].join(",")}; unconverted lead → ${lead.action}; model consulted ${decides}×; deliveries attempted ${delivered.length}; doors calling the moment ${callers.join(", ") || "none"}` }
  })

  // ── 6b · LAW 5: every governed arbiter moment is LEDGERED — its action name is one the ledger accepts ──
  // WAVE146 BIND (lane 146B requirement 6). withActionLedger REFUSES a name that is not domain.entity.action (console.error +
  // "unledgered": no row, no idempotency — a retried webhook answers twice). The RULE is read from the ledger's own source
  // (ACTION_NAME_PATTERN in lib/kernel/action-ledger.ts), never restated; the names are whatever the modules ledger. Scope: the
  // modules that hold the wave-146 arbiter moments (inbound responder, owed-promise, life-change, inbound record, social inbound).
  const ledgerSrc = stripComments(readRepo("lib/kernel/action-ledger.ts") ?? "")
  const patSrc = ledgerSrc.match(/ACTION_NAME_PATTERN\s*=\s*\/((?:\\.|[^/\n])+)\/([a-z]*)/)
  const ACTION_RULE = patSrc ? new RegExp(patSrc[1], patSrc[2]) : null
  const ARBITER_LEDGER_MODULES = [...new Set([...RESPONDER_HOMES, "lib/ai-isa/followup-arbiter.ts", ...listFiles("lib/communications", (f) => /\.ts$/.test(f)), ...listFiles("lib/lead-magnets", (f) => /\.ts$/.test(f)), ...socialInbound])].filter((f) => existsSync(join(ROOT, f)))
  const named = ARBITER_LEDGER_MODULES.flatMap((f) => ledgeredActionNames(readRepo(f) ?? "").map((name) => ({ f, name })))
  const refusedNames = ACTION_RULE ? named.filter((x) => !ACTION_RULE.test(x.name)) : named
  // POSITIVE CONTROL: the finder sees the two-part name the ledger refuses (wave-145 life_change.respond shape) in a specimen, and
  // the outcome object written just before the ledger call is not mistaken for the ledger's action.
  const specimen = `let out = { action: "replayed", reason: "x" }\nawait ledger({ brokerageId: b, action: "life_change.respond", actor: { type: "manager" } }, async () => out)`
  const specimenNames = ledgeredActionNames(specimen)
  const ledgerControl = !!ACTION_RULE && jsonOf(specimenNames) === jsonOf(["life_change.respond"]) && !ACTION_RULE.test("life_change.respond") && ACTION_RULE.test("life_change.signal.respond")
  const momentsLedgered = ["respondToInboundCommunication", "respondToPromisedDeliverable"].map((fn) => ({ fn, home: ARBITER_LEDGER_MODULES.find((f) => new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`).test(strippedRepo(f) ?? "")) ?? null }))
  const unledgeredMoments = momentsLedgered.filter((m) => !m.home || ledgeredActionNames(readRepo(m.home) ?? "").length === 0).map((m) => m.fn)
  c.rule("146B", "EVERY GOVERNED ARBITER MOMENT LEAVES EVIDENCE — ITS LEDGER ACTION NAME IS ONE THE LEDGER ACCEPTS (Law 5 'consequential actions leave evidence'; ruling 3 '→ governed action'; lane 146B requirement 6): every action the arbiter's inbound / owed-promise / life-change modules hand withActionLedger passes the ledger's own ACTION_NAME_PATTERN (read from lib/kernel/action-ledger.ts, not restated) — a name it refuses is silently NOT ledgered and loses its idempotency; the inbound responder and the owed-promise moment each ledger (positive control: the finder catches a two-part name in a specimen and ignores the outcome object beside it)",
    ledgerControl && refusedNames.length === 0 && unledgeredMoments.length === 0 && named.length > 0,
    `rule read from the ledger ${!!ACTION_RULE}; ${named.length} ledgered action name(s) across ${ARBITER_LEDGER_MODULES.length} module(s); refused by the ledger: ${refusedNames.map((x) => `${x.f}: ${x.name}`).join(", ") || "none"}; moments not ledgered: ${unledgeredMoments.join(", ") || "none"}; finder control ${ledgerControl}`)

  // ── 7 · PRESERVE: provider truth (wave 145 facts) — SendGrid sends email; Mailgun / Resend / Postmark only parse inbound ──
  const email = truth.email as unknown as { providers?: string[]; supporting?: string[] } | undefined
  c.rule("146B", "EMAIL SENDS THROUGH SENDGRID ONLY; MAILGUN / RESEND / POSTMARK ONLY LISTEN (wave-145 fact the spec carries — green, preserve; ruling 3 makes the listening half count): the matrix's email senders are exactly ['sendgrid'] and the three parse providers are supporting, never senders",
    jsonOf(email?.providers) === jsonOf(["sendgrid"]) && ["mailgun", "resend", "postmark"].every((p) => (email?.supporting ?? []).includes(p) && !(email?.providers ?? []).includes(p)),
    `email providers ${jsonOf(email?.providers)}; supporting ${jsonOf(email?.supporting)}`)

  c.blind("C1 is driven on an in-memory client (no RLS, no provider); the contract is held by WHAT IT WROTE (rows added per table), never by which survivor table lane 146B chose. Webhook authentication (signature verification) is not driven here — lane 146B's own proofs (test:egress-*, test:inbox*) carry it. The route → C1 reach is a two-level stripped-source import walk: a route that reaches C1 through a dynamic import or a third-level module reads as not reaching it. The social-inbound and prospect-funnel steps read source, not behaviour; the arbiter's actual choice for an inbound social message is lane 146B's test:intent-driven-followup / test:next-best-experience.")
  return c.report([], 0)
}
