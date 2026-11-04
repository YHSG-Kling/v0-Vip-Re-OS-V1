#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fixtures and fake clients, the repo's proof idiom */
/**
 * scripts/wave148-canaries.ts — `npx tsx scripts/wave148-canaries.ts` (wave 148, lane 148J2; key: test:wave148-canaries)
 * ─────────────────────────────────────────────────────────────────────────────
 * The WAVE-148 CANARIES: one group per wave-148 lane (A · B · C · D · E · F · G · H · I · J · K), 3–6 canaries each. Every canary
 * is an IN-MEMORY call of the lane's REAL exported module (imported, never re-implemented) and carries BOTH halves of a
 * measurement (CLAUDE.md §2):
 *   · POSITIVE — the contract holds on a well-formed input (the behaviour the lane built);
 *   · NEGATIVE — the same call still SEES the defect it exists to refuse (a broken finder and a clean tree both report zero;
 *     the negative half proves this one is not broken).
 * A canary passes only when both halves pass. Labels name the lane and the contract / ruling: `[148X·C15]`, `[148A·req 1b]`,
 * `[148C·R1]` (R = owner ruling number in WAVE148_SPEC.md, where a lane carries no C-contract).
 *
 * RULES (lane 148J2 brief): pure and deterministic — no network, no Supabase, no env reads in this file. Fake clients only:
 * scripts/in-memory-supabase.ts memSupabase (it resolves refusals like supabase-js and models `.select()` on writes so writers
 * can COUNT rows). The SAME node:module registerHooks seam the lane proofs use (scripts/persona-compliance-guard.ts,
 * scripts/one-door-consent-guard.ts) stubs `server-only`, and points `@/lib/supabase/service` / `@/lib/supabase/server` at the
 * canary's own in-memory client — and at NOTHING (a throw) by default, so a module that tries to mint a real client fails the
 * canary loudly instead of reaching a database. `@/lib/kernel/emit` records into memory (its fan-out reaches the notification
 * engine, which is not a wave-148 contract). Because `server-only` is stubbed here, no `--conditions=react-server` is needed.
 *
 * Each canary imports its modules with a dynamic `await import()` inside its own body, so one lane's broken import fails that
 * canary (with its stack) and never the whole run. Output: one line per canary, a per-lane tally, `canaries N passed, M failed`,
 * and the final line WAVE148_CANARIES_PASS / WAVE148_CANARIES_FAIL (exit 1 on any failure).
 *
 * BLIND SPOTS (published beside the number): memSupabase enforces no CHECK / FK / RLS; HTTP routes, React render and provider
 * delivery are not executed (each lane's own proof holds those); the lane-A half partition uses a local glob matcher, not next's
 * resolve-build-paths.js (lane A's test:release-blockers runs next's own resolver); lib/kernel/communications/assemble-email.ts
 * reads NEXT_PUBLIC_APP_URL inside the module (the canary asserts only base-URL-independent shapes); lane J landed documents
 * only, so its group is a text + absence census with positive controls, not a module call.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

// ── the seam: no real client can ever be minted (the default throws); a canary may hand in its own in-memory one ──
const G = globalThis as any
G.__W148 = { svc: null as MemClient | null, events: [] as unknown[], mints: 0 }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export function createServiceClient(){ const s = globalThis.__W148.svc; if (!s) globalThis.__W148.mints++; if (!s) throw new Error('wave148-canaries: no service client — fake clients only (hand one in)'); return s }",
  "@/lib/supabase/server": "export async function createClient(){ const s = globalThis.__W148.svc; if (!s) throw new Error('wave148-canaries: no session client — fake clients only'); return s }; export const createServerClient = createClient",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export function isKernelEventValue(){ return true }; export async function emitKernelEvent(i){ globalThis.__W148.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__W148.events.length, fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null, error: null } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const ROOT = process.cwd()
const raw = (p: string): string => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const code = (p: string): string => stripComments(raw(p))
const rows = (c: MemClient, t: string): any[] => ((c as any).tables[t] ?? []) as any[]
const sorted = (xs: readonly string[]): string => JSON.stringify([...xs].sort())
const NOW = new Date("2026-11-01T12:00:00Z")
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString()
/** Run with an in-memory client behind createServiceClient(), then put the throwing default back. */
async function withSvc<T>(svc: MemClient | null, fn: () => Promise<T>): Promise<T> {
  const prev = G.__W148.svc
  G.__W148.svc = svc
  try { return await fn() } finally { G.__W148.svc = prev }
}

/** `note` is printed on a PASS too — a measurement worth publishing beside the verdict (CLAUDE.md §2: a count that moves is the finding). */
interface Verdict { positive: boolean; negative: boolean; detail?: string; note?: string }
interface Canary { id: string; label: string; run: () => Promise<Verdict> }
interface Group { lane: string; title: string; counted: boolean; canaries: Canary[] }
const GROUPS: Group[] = []
const group = (lane: string, title: string, canaries: Canary[], counted = true) => GROUPS.push({ lane, title, counted, canaries })

// ═════════════════════════════════════════════════════════════════════════════
// 148A — production blockers first (spec Lane A req 1b · 1c · 4)
// ═════════════════════════════════════════════════════════════════════════════
const yamlCode = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")
/** Top-level jobs of a workflow → their block text (2-space-indented `name:` lines under `jobs:`). */
function jobBlocks(yaml: string): Map<string, string> {
  const out = new Map<string, string>()
  const body = yamlCode(yaml).split(/\njobs:\n/)[1] ?? ""
  let name: string | null = null, buf: string[] = []
  for (const line of body.split("\n")) {
    const m = /^ {2}([a-z0-9_-]+):\s*$/.exec(line)
    if (m) { if (name) out.set(name, (out.get(name) ?? "") + buf.join("\n")); name = m[1]; buf = []; continue }
    buf.push(line)
  }
  if (name) out.set(name, (out.get(name) ?? "") + buf.join("\n"))
  return out
}
/** The phases action's shape: composite, one debug-build-paths input, compile AND generate both scoped by the SAME variable. */
function phasesShape(yaml: string): boolean {
  const y = yamlCode(yaml)
  return /\n\s+using:\s*composite\b/.test(y) && /\ninputs:\n(?:[\s\S]*?\n)? {2}debug-build-paths:/.test(y)
    && /--experimental-build-mode compile --debug-build-paths "\$BUILD_PATHS"/.test(y)
    && /--experimental-build-mode generate --debug-build-paths "\$BUILD_PATHS"/.test(y)
    && (y.match(/BUILD_PATHS:\s*\$\{\{\s*inputs\.debug-build-paths\s*\}\}/g) ?? []).length >= 2
}
/** ONE fail-closed verdict job `next-build` needing BOTH paths; the full pass and the halves are mutually exclusive on BUILD_RUNNER. */
function verdictShape(yaml: string): { ok: boolean; why: string[] } {
  const jobs = jobBlocks(yaml)
  const why: string[] = []
  const full = jobs.get("next-build-full") ?? "", half = jobs.get("next-build-half") ?? "", gate = jobs.get("next-build") ?? ""
  if (!full) why.push("no next-build-full")
  if (!half) why.push("no next-build-half")
  if (!gate) why.push("no next-build verdict")
  if ([...jobs.keys()].filter((k) => k === "next-build").length !== 1) why.push("not exactly one verdict job")
  if (!/if:\s*\$\{\{\s*vars\.BUILD_RUNNER != ''\s*\}\}/.test(full)) why.push("full pass not gated on BUILD_RUNNER set")
  if (!/if:\s*\$\{\{\s*vars\.BUILD_RUNNER == ''\s*\}\}/.test(half)) why.push("halves not gated on BUILD_RUNNER empty")
  if (!/needs:\s*\[\s*next-build-full\s*,\s*next-build-half\s*\]/.test(gate)) why.push("verdict does not need both paths")
  if (!/if:\s*\$\{\{\s*always\(\)\s*\}\}/.test(gate)) why.push("verdict does not run always()")
  if (!/= "success"/.test(gate) || !/= "skipped"/.test(gate) || !/exit 1/.test(gate)) why.push("verdict is not fail-closed (success / skipped / exit 1)")
  return { ok: why.length === 0, why }
}
const globRe = (g: string) => new RegExp(`^${g.split("**").map((p) => p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`)
const inHalf = (file: string, spec: string): boolean => {
  const pats = spec.split(",").map((s) => s.trim()).filter(Boolean)
  return pats.filter((p) => !p.startsWith("!")).some((p) => globRe(p).test(file)) && !pats.filter((p) => p.startsWith("!")).some((p) => globRe(p.slice(1)).test(file))
}
const partition = (files: string[], halves: string[]) => {
  const counts = halves.map(() => 0)
  let orphan = 0, overlap = 0
  for (const f of files) {
    const hits = halves.map((h, i) => (inHalf(f, h) ? i : -1)).filter((i) => i >= 0)
    if (hits.length === 0) orphan++
    if (hits.length > 1) overlap++
    for (const i of hits) counts[i]++
  }
  return { counts, orphan, overlap }
}

group("148A", "production blockers — the build gate, the half partition, login's counted post-condition", [
  {
    id: "148A·req 1b", label: "the build phases are ONE composite action; compile AND generate get the SAME --debug-build-paths globs",
    run: async () => {
      const action = raw(".github/actions/next-build-phases/action.yml")
      const broken = action.replace(/--experimental-build-mode generate --debug-build-paths "\$BUILD_PATHS"/, "--experimental-build-mode generate")
      return { positive: action.length > 0 && phasesShape(action), negative: !phasesShape(broken), detail: action ? "" : "action.yml missing" }
    },
  },
  {
    id: "148A·req 1b", label: "ONE fail-closed `next-build` verdict needs the full pass and the two-half matrix (exclusive on BUILD_RUNNER)",
    run: async () => {
      const wf = raw(".github/workflows/build.yml")
      const v = verdictShape(wf)
      const alwaysGreen = wf.replace(/needs:\s*\[next-build-full, next-build-half\]/, "needs: [next-build-full]")
      return { positive: v.ok, negative: !verdictShape(alwaysGreen).ok, detail: v.why.join("; ") }
    },
  },
  {
    id: "148A·req 1c", label: "the matrix's two globs partition EVERY app/ entry exactly once (both halves non-empty)",
    run: async () => {
      const { appEntries } = await import("./app-import-graph")
      const half = jobBlocks(raw(".github/workflows/build.yml")).get("next-build-half") ?? ""
      const halves = [...half.matchAll(/^\s+paths:\s*"([^"]+)"/gm)].map((m) => m[1])
      const files = appEntries(ROOT).map((p) => relative(ROOT, p).replace(/\\/g, "/"))
      const p = partition(files, halves)
      const control = partition(files, ["app/dashboard/**", "app/**"])
      return {
        positive: halves.length === 2 && files.length > 0 && p.orphan === 0 && p.overlap === 0 && p.counts.every((n) => n > 0),
        negative: control.overlap > 0,
        detail: `halves ${JSON.stringify(halves)} · ${files.length} entries → ${p.counts.join(" + ")} · orphan ${p.orphan} · overlap ${p.overlap}`,
        note: `${files.length} app/ entry files → ${halves.map((h, i) => `${h} ${p.counts[i]}`).join(" · ")} (control overlap ${control.overlap})`,
      }
    },
  },
  {
    id: "148A·req 4", label: "first-login invitation acceptance is COUNTED: accepted once; a refused or zero-row update is accepted:false with its reason",
    run: async () => {
      const { acceptUserInvitationOnFirstLogin } = await import("../lib/onboarding/state-machine")
      const B = "00000000-0000-4000-8000-0000000148a1", U = "00000000-0000-4000-8000-0000000148a2"
      const world = (opts: any = {}) => memSupabase({
        user_invitations: [{ id: "inv-1", brokerage_id: B, email: "pat@broker.test", user_type: "broker", status: "pending" }],
        operation_outcomes: [], manager_signals: [], agent_action_ledger: [], lifecycle_events: [], notifications: [],
      }, { uuidIds: true, stampCreatedAt: true, ...opts })
      const ok = world()
      const r1 = await acceptUserInvitationOnFirstLogin({ userId: U, email: "Pat@Broker.test", brokerageId: B, client: ok as never })
      const refused = world({ refuse: { user_invitations: "permission denied for table user_invitations" } })
      const r2 = await acceptUserInvitationOnFirstLogin({ userId: U, email: "pat@broker.test", brokerageId: B, client: refused as never })
      // the race: the invitation vanishes between the read and the write — an UPDATE that matches nothing RESOLVES (CLAUDE.md §3)
      const raceDb = world()
      const raced: any = { ...raceDb, from: (t: string) => {
        const q: any = (raceDb as any).from(t)
        if (t !== "user_invitations") return q
        const upd = q.update.bind(q)
        q.update = (...a: unknown[]) => { rows(raceDb, "user_invitations").splice(0); return upd(...a) }
        return q
      } }
      const r3 = await acceptUserInvitationOnFirstLogin({ userId: U, email: "pat@broker.test", brokerageId: B, client: raced })
      return {
        positive: r1.accepted === true && rows(ok, "user_invitations")[0]?.status === "accepted" && rows(ok, "user_invitations")[0]?.accepted_user_id === U,
        negative: r2.accepted === false && /refused/.test(r2.error ?? "") && r3.accepted === false && /matched 0 rows/.test(r3.error ?? ""),
        detail: JSON.stringify({ r1, r2, r3 }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148B — one intake door, one consent component (C15), suppression by law (C16), consented intake (C8)
// ═════════════════════════════════════════════════════════════════════════════
group("148B", "one consent component, suppression sync, one intake door", [
  {
    id: "148B·C15", label: "every box starts UNTICKED; ticked service + SMS boxes grant exactly those; a channel with no method grants nothing",
    run: async () => {
      const C = await import("../lib/kernel/compliance/consent-component")
      const w = C.consentComponentWording({ door: "lead_magnet", brandName: "  Elm   Realty " })
      const ticked = C.consentSubmissionFor({ serviceDelivery: true, marketing: { email: false, sms: true, voice: false, direct_mail: true } }, { door: "lead_magnet", brandName: "Elm Realty" })
      const g = C.consentGrantsFor(ticked, w, { email: true, phone: true })
      const given = g.filter((x) => x.given).map((x) => `${x.family}:${x.slot}`).sort()
      const empty = C.consentSubmissionFor(C.EMPTY_CONSENT_VALUE, { door: "lead_magnet", brandName: "Elm Realty" })
      const none = C.consentGrantsFor(empty, w, { email: true, phone: true })
      const noPhone = C.consentGrantsFor(ticked, w, { email: true, phone: false })
      return {
        positive: w.brandName === "Elm Realty" && w.version === C.CONSENT_COMPONENT_VERSION
          && JSON.stringify(given) === JSON.stringify(["email:service_delivery", "phone:marketing_sms", "phone:service_delivery"])
          && ticked.marketing.direct_mail === false, // direct mail was not OFFERED (default email/sms/voice) — a box not offered cannot be ticked
        negative: none.every((x) => x.given === false) && !noPhone.some((x) => x.family === "phone"),
        detail: JSON.stringify({ given, offered: ticked.offered }),
      }
    },
  },
  {
    id: "148B·C15", label: "strict parse: a well-formed submission parses; a string 'true', a stale version or an unknown door is NULL (never fabricated)",
    run: async () => {
      const C = await import("../lib/kernel/compliance/consent-component")
      const good = C.consentSubmissionFor({ serviceDelivery: true, marketing: { email: true, sms: false, voice: false, direct_mail: false } }, { door: "home_value", brandName: "Elm Realty" })
      const p = C.parseConsentSubmission(JSON.parse(JSON.stringify(good)))
      const bad = [
        { ...good, service_delivery: "true" }, { ...good, version: "c15:2020-01-01" }, { ...good, door: "made_up_door" }, { ...good, c15: false }, null, "yes",
      ].map((b) => C.parseConsentSubmission(b))
      const sneaky = C.parseConsentSubmission({ ...good, marketing: { ...good.marketing, direct_mail: true } }) // ticked but not offered
      return { positive: !!p && p.service_delivery === true && p.marketing.email === true, negative: bad.every((x) => x === null) && sneaky?.marketing.direct_mail === false, detail: JSON.stringify(bad) }
    },
  },
  {
    id: "148B·C16", label: "ONE revocation vocabulary: STOP / Revoke. / opt out / STOPALL revoke every channel; 'can you stop by tomorrow?' does not",
    run: async () => {
      const U = await import("../lib/ai-isa/opt-out-utils")
      const revoke = ["STOP", "Revoke.", "opt out", "STOPALL", "unsubscribe please", "remove me"].every((t) => { const d = U.detectOptOutIntent(t); return d.isOptOut && d.channel === "all" })
      return { positive: revoke && U.isRevocationKeyword("revoke"), negative: !U.detectOptOutIntent("can you stop by tomorrow?").isOptOut && !U.isRevocationKeyword("hello") }
    },
  },
  {
    id: "148B·C16", label: "a STOP at T0 refuses SMS at T0+1 — by contact AND number-only in another spelling; another person stays sendable; an unreadable list refuses",
    run: async () => {
      const S = await import("../lib/kernel/compliance/check-suppression")
      const A = "00000000-0000-4000-8000-0000000148b1", C1 = "00000000-0000-4000-8000-0000000148c1", C2 = "00000000-0000-4000-8000-0000000148c2"
      const db = memSupabase({
        contacts: [{ id: C1, brokerage_id: A, phone: "(813) 555-0147", email: "sam@x.test" }, { id: C2, brokerage_id: A, phone: "(813) 555-0999", email: "olive@x.test" }],
        contact_suppression_list: [], platform_suppression_list: [], contact_consent_events: [],
      }, { uuidIds: true, stampCreatedAt: true })
      const before = await S.checkSuppression({ brokerageId: A, contactId: C1, phone: "+18135550147", channel: "sms" }, { client: db })
      const add = await S.addSuppression({ brokerageId: A, contactId: C1, phone: "+18135550147", channel: "sms", reason: "STOP", source: "sms_stop" }, { client: db })
      const byId = await S.checkSuppression({ brokerageId: A, contactId: C1, channel: "sms" }, { client: db })
      const byNumber = await S.checkSuppression({ brokerageId: A, contactId: null, phone: "813-555-0147", channel: "sms" }, { client: db })
      const other = await S.checkSuppression({ brokerageId: A, contactId: C2, phone: "(813) 555-0999", channel: "sms" }, { client: db })
      const shut = memSupabase({ contact_suppression_list: [], platform_suppression_list: [] }, { refuse: { contact_suppression_list: "permission denied" } })
      const closed = await S.checkSuppression({ brokerageId: A, contactId: null, phone: "+18135550000", channel: "sms" }, { client: shut })
      return {
        positive: before.suppressed === false && add.suppressed === true && other.suppressed === false,
        negative: byId.suppressed && byNumber.suppressed && closed.suppressed,
        detail: JSON.stringify({ before, add: { s: add.suppressed, e: add.errors }, byId, byNumber, other, closed }),
      }
    },
  },
  {
    id: "148B·C16", label: "every marketing email carries the token unsubscribe + RFC 8058 one-click; a legacy (no token) link gets no one-click; transactional mail none",
    run: async () => {
      const { assembleEmail } = await import("../lib/kernel/communications/assemble-email")
      const B = "00000000-0000-4000-8000-0000000148b2", U = "00000000-0000-4000-8000-0000000148b3"
      const db = memSupabase({
        users: [{ id: U, email_signature: null }], teams: [], team_members: [], agents: [], brokerage_brand_settings: [],
        contacts: [{ id: "c-tok", brokerage_id: B, unsubscribe_token: "tok_secret_148" }, { id: "c-old", brokerage_id: B }],
      })
      return withSvc(db, async () => {
        const tok = await assembleEmail({ bodyHtml: "<p>Market update</p>", userId: U, brokerageId: B, contactId: "c-tok", channelPurpose: "campaign" })
        const old = await assembleEmail({ bodyHtml: "<p>Market update</p>", userId: U, brokerageId: B, contactId: "c-old", channelPurpose: "campaign" })
        const tx = await assembleEmail({ bodyHtml: "<p>Your receipt</p>", userId: U, brokerageId: B, contactId: "c-tok", channelPurpose: "transactional" })
        return {
          positive: /\/api\/unsubscribe\?c=c-tok&t=tok_secret_148&channel=email>$/.test(tok.headers["List-Unsubscribe"] ?? "") && tok.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click" && tok.unsubscribeIncluded,
          negative: !!old.headers["List-Unsubscribe"] && !("List-Unsubscribe-Post" in old.headers) && Object.keys(tx.headers).length === 0 && !tx.unsubscribeIncluded,
          detail: JSON.stringify({ tok: tok.headers, old: old.headers, tx: tx.headers }),
        }
      })
    },
  },
  {
    id: "148B·C8", label: "captureContact on the INJECTED client: dedupe before insert (same email, other case = same person); no second welcome; a refused dedupe read refuses",
    run: async () => {
      const cap = await import("../lib/contact-pipeline/contact-capture")
      const A = "00000000-0000-4000-8000-0000000148b4", AG = "00000000-0000-4000-8000-00000148b401"
      const seed = (opts: any = {}) => memSupabase({
        brokerages: [{ id: A, name: "Alpha Realty" }], agents: [{ id: AG, brokerage_id: A, user_id: "u-a1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" }],
        users: [{ id: "u-a1", first_name: "Ann", last_name: "Agent" }], contacts: [], leads: [], contact_consent_events: [], lead_enrichment_queue: [], manager_signals: [],
        agent_action_ledger: [], lifecycle_events: [], manager_completions: [], person_identities: [], person_identity_evidence: [], lead_score_history: [], assignment_rules: [],
        transactions: [], activities: [], notifications: [], contact_suppression_list: [], platform_suppression_list: [], compliance_events: [], teams: [],
      }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, ...opts } as never)
      const svc = seed()
      const welcomes: string[] = []
      const effects = { notify: async () => {}, welcome: async (_s: unknown, c: { id: string }) => { welcomes.push(c.id) }, portalInvite: async () => {} }
      // No service client exists here: every capture WRITE must ride the injected client. A mint ATTEMPT is counted (the stub throws
      // and the capture's best-effort effects catch it) and published in the evidence — measured, not assumed. Measured on
      // f9d37640 + lane 148F: 2 attempts across the create + the merge, from the CONTACT_SCORED fan-out (contact-capture.ts queueContactEnrichmentAndScore
      // → lib/kernel/notification-engine.ts processKernelEvent, which mints its own client) — a best-effort echo, not a capture
      // write; recorded in the lane 148J2 notes for lane B / Z.
      const mints0 = G.__W148.mints
      return withSvc(null, async () => {
        const r1 = await cap.captureContact({ brokerageId: A, creatorUserId: "u-a1", source: "web_form", first_name: "Jane", last_name: "Doe", email: "Jane.Doe@Example.com", tcpa_consent: false } as never, { client: svc, effects } as never)
        const r2 = await cap.captureContact({ brokerageId: A, source: "qr_scan", first_name: "Janie", last_name: "Doe", email: "jane.doe@example.com", tcpa_consent: false } as never, { client: svc, effects } as never)
        const shut = seed({ refuse: { contacts: "permission denied" } })
        let threw = ""
        try { await cap.captureContact({ brokerageId: A, source: "web_form", first_name: "Ref", last_name: "Used", email: "r@x.test", tcpa_consent: false } as never, { client: shut, effects } as never) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
        return {
          positive: r1.action === "created" && rows(svc, "contacts").length === 1,
          negative: r2.action === "merged" && r2.contactId === r1.contactId && rows(svc, "contacts").length === 1 && welcomes.length === 1 && /refused/.test(threw) && rows(shut, "contacts").length === 0,
          detail: JSON.stringify({ r1: r1.action, r2: r2.action, n: rows(svc, "contacts").length, welcomes: welcomes.length, threw, serviceClientMintAttempts: G.__W148.mints - mints0 }),
          note: `service-client mint attempts during the captures: ${G.__W148.mints - mints0} (each refused by the seam; the best-effort CONTACT_SCORED fan-out)`,
        }
      })
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148C — protected-attribute research → marketing-safe personas → compliant audiences (owner ruling 1)
// RE-ASSERTED — wave 149, lane 149A (owner ruling 2026-11-03, "Every persona is allowed and this can't change"): the three
// persona / audience canaries below asserted the wave-148 "needs-based only" restriction the owner REVERSED. They now assert
// the owner's rule — the positive and negative halves flipped with it: a situation persona IS a campaign persona and an
// audience basis; research still never becomes a need; discriminatory WORDING and proxy tags are still refused.
// ═════════════════════════════════════════════════════════════════════════════
const PB = "00000000-0000-4000-8000-0000000000b1", PAG1 = "00000000-0000-4000-8000-00000000a001", PTEAM = "00000000-0000-4000-8000-00000000c001"
const PC1 = "00000000-0000-4000-8000-000000000c01", PC3 = "00000000-0000-4000-8000-000000000c03"
function personaWorld(): MemClient {
  const stamp = (source: string) => ({ source, capability: "person.enrich", retrievedAt: "2026-10-01T00:00:00Z", matchConfidence: "0.9", purpose: "enrichment" })
  const RECENT = "2026-10-25T12:00:00Z"
  return memSupabase({
    brokerages: [{ id: PB, name: "Alpha Realty" }], users: [],
    agents: [{ id: PAG1, brokerage_id: PB, user_id: "u-agent" }],
    teams: [{ id: PTEAM, brokerage_id: PB, team_lead_id: "u-tl", name: "North" }],
    contacts: [
      { id: PC1, brokerage_id: PB, agent_id: PAG1, team_id: PTEAM, first_name: "Rae", contact_type: "buyer", contact_persona: null, home_owner_status: "renter",
        age_range: "65-74", marital_status: "married", email: "rae@example.com", preferred_language: "en",
        enrichment_profile: { field_provenance: { age_range: stamp("peopledata"), marital_status: stamp("peopledata") } } },
      { id: PC3, brokerage_id: PB, agent_id: PAG1, team_id: PTEAM, first_name: "Lee", contact_persona: "senior", enrichment_profile: { field_provenance: { contact_persona: { source: "staff", retrievedAt: "2026-09-01T00:00:00Z" } } } },
    ],
    protected_research_attributes: [
      { id: "pr-1", brokerage_id: PB, contact_id: PC1, provider: "versium", capability: "person.online_audience", source_field: "Religion", attribute_value: "Catholic", attribute_class: "religion", basis: "vendor_modeled", match_confidence: "household", retrieved_at: "2026-09-01T00:00:00Z" },
    ],
    property_preferences: [{ id: "pp-1", brokerage_id: PB, contact_id: PC1, inferred_cities: ["Austin"], inferred_must_have_features: ["acreage"], criteria_provenance: {
      cities: { source: "said", value: ["Austin"], evidence: "we're relocating to Austin for my job", channel: "voice", at: RECENT, reason: null },
      mustHaveFeatures: { source: "said", value: ["acreage"], evidence: "we want an acre or two", channel: "voice", at: RECENT, reason: null } } }],
    saved_properties: [{ id: "sp-1", brokerage_id: PB, contact_id: PC1, saved_at: RECENT, dismissed: false }],
    showing_requests: [{ id: "sr-1", brokerage_id: PB, contact_id: PC1, created_at: RECENT, status: "requested" }],
    client_detailed_personas: [], contact_consent_events: [], person_identities: [], person_identity_evidence: [], agent_action_ledger: [],
    facebook_custom_audiences: [], ad_campaigns: [], ad_creative_variations: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
}

group("148C", "protected research → marketing-safe persona → compliant audience", [
  {
    id: "148C·R1", label: "every role the owner named reads within least privilege; an ISA seat and a PROHIBITED purpose are refused — and both refusals are ledgered",
    run: async () => {
      const store = await import("../lib/enrichment/protected-research-store")
      const named = ["admin", "platform_admin", "platform_support", "agent", "team_lead", "broker", "compliance_officer", "tenant_support"]
      const admitted = new Set(Object.values(store.PROTECTED_READ_MATRIX).flatMap((row) => Object.keys(row)))
      const prohibitedRow = ["ad_audience", "ad_targeting", "steering", "eligibility", "scoring", "outreach_targeting"].some((p) => p in store.PROTECTED_READ_MATRIX)
      const db = personaWorld()
      return withSvc(db, async () => {
        const seat = (userId: string, userType: string) => ({ userId, userType, brokerageId: PB })
        const ok = await store.readProtectedAttributes(db, { brokerageId: PB, contactId: PC1, purpose: "research", actor: seat("u-broker", "broker") }, { now: NOW })
        const isa = await store.readProtectedAttributes(db, { brokerageId: PB, contactId: PC1, purpose: "customer_service", actor: seat("u-isa", "isa") }, { now: NOW })
        const ads = await store.readProtectedAttributes(db, { brokerageId: PB, contactId: PC1, purpose: "ad_targeting", actor: seat("u-broker", "broker") }, { now: NOW })
        const refusals = rows(db, "agent_action_ledger").filter((l) => l.action === "research.protected_attribute.refuse")
        return {
          positive: named.every((r) => admitted.has(r)) && !prohibitedRow && ok.ok === true,
          negative: !isa.ok && isa.refused === "role_not_admitted" && !ads.ok && ads.refused === "prohibited_purpose" && refusals.length >= 2,
          detail: JSON.stringify({ missing: named.filter((r) => !admitted.has(r)), ok: ok.ok, isa: (isa as any).refused, ads: (ads as any).refused, refusals: refusals.length }),
        }
      })
    },
  },
  {
    id: "148C·R1", label: "derivePersona: a hostile model's unknown / research-cited needs are cut; a staff 'senior' IS honoured as the campaign persona (every persona allowed) and never overwritten",
    run: async () => {
      const builder = await import("../lib/contacts/persona-builder")
      const layers = await import("../lib/contacts/persona-layers")
      const db = personaWorld()
      const hostile = JSON.stringify({
        serviceProfile: { summary: "Rae prefers calm, step-by-step explanations.", howToHelp: ["Send a relocation checklist"], openQuestions: ["Which part of town is closest to work?"] },
        marketingPersona: { headline: "Retirees relocating near a church", needs: [
          { need: "senior_living", confidence: 0.9, evidenceRefs: ["E2-1"], why: "age band" },
          { need: "downsizing", confidence: 0.95, evidenceRefs: ["R1-1"], why: "modeled household" },
          { need: "relocation_research", confidence: 0.99, evidenceRefs: ["E2-1"], why: "said they are moving for work" },
        ], messaging: { angles: ["A neighbourhood-by-neighbourhood guide for newcomers"], educationTopics: ["Comparing neighbourhoods from a distance"], tone: "warm", platformHooks: { facebook: "Perfect for families like yours" } } },
        escalate: null,
      })
      return withSvc(db, async () => {
        const actor = { userId: "u-agent", userType: "agent", brokerageId: PB }
        const r1 = await builder.derivePersona(db, { brokerageId: PB, contactId: PC1, actor, agentId: PAG1 } as never, { now: NOW, generate: async () => hostile })
        const r3 = await builder.derivePersona(db, { brokerageId: PB, contactId: PC3, actor, agentId: PAG1 } as never, { now: NOW, generate: async () => "{}" })
        const cp1 = r1.persona?.marketing.campaignPersona ?? null
        const c3 = rows(db, "contacts").find((c) => c.id === PC3)
        const seniorNeed = (layers.MARKETING_NEEDS as Record<string, { campaignPersona: string | null }>).later_life_housing?.campaignPersona
        return {
          positive: r1.ok && r1.marketingSafe && cp1 === "relocated" && r3.ok && r3.persona?.marketing.campaignPersona === "senior" && c3?.contact_persona === "senior" && seniorNeed === "senior",
          negative: !(r1.persona?.marketing.needs ?? []).some((n) => n.evidenceRefs.some((id) => /^R1-/.test(id)) || (n.need as string) === "senior_living"),
          detail: JSON.stringify({ cp1, needs: r1.persona?.marketing.needs.map((n) => n.need), r3: r3.persona?.marketing.campaignPersona, notes: r1.notes, err: (r1 as any).error }),
        }
      })
    },
  },
  {
    id: "148C·R1", label: "assertMarketingSafePersona: a relocation persona AND a 'senior' campaign persona pass (every persona allowed); a 'perfect for families' headline or a research-cited need is refused",
    run: async () => {
      const L = await import("../lib/contacts/persona-layers")
      const spec = L.MARKETING_NEEDS.relocation_research
      const safe = {
        headline: spec.label, primaryNeed: "relocation_research" as const, needs: [{ need: "relocation_research" as const, confidence: 0.9, evidenceRefs: ["E2-1"], why: "said they are moving for work" }],
        campaignPersona: spec.campaignPersona ?? null, audienceEligible: true,
        messaging: { angles: [...spec.angles], educationTopics: [...spec.educationTopics], tone: "warm, specific and neighbourly", platformHooks: { ...spec.hooks }, avoid: [] },
      }
      const a = L.assertMarketingSafePersona(safe as never)
      const senior = L.assertMarketingSafePersona({ ...safe, campaignPersona: "senior" } as never)
      const families = L.assertMarketingSafePersona({ ...safe, headline: "Perfect for families like yours" } as never)
      const researchCited = L.assertMarketingSafePersona({ ...safe, needs: [{ ...safe.needs[0], evidenceRefs: ["R1-1"] }] } as never)
      return { positive: a.ok && senior.ok, negative: !families.ok && !researchCited.ok, detail: JSON.stringify({ a: a.violations, senior: senior.violations, families: families.violations }) }
    },
  },
  {
    id: "148C·R1", label: "audiences: proxy tags ('young-families', 'church-goers') and a 'senior' SUPPRESSION list are refused; 'acreage buyers', derived 'relocated' and derived 'senior' audiences pass",
    run: async () => {
      const proxy = await import("../lib/compliance-rules/audience-compliance")
      const basis = await import("../lib/ads/audience-persona-basis")
      const okRule = basis.resolveAudiencePersonaBasis({ type: "persona_segment", basis: "derived_persona", filters: { personas: ["relocated"] } })
      const seniorRule = basis.resolveAudiencePersonaBasis({ type: "persona_segment", basis: "derived_persona", filters: { personas: ["senior"] } })
      const seniorExcl = basis.resolveAudiencePersonaBasis({ type: "persona_segment", filters: { personas: ["senior"] } }, "exclusion")
      return {
        positive: proxy.audienceProxyHits("acreage buyers").length === 0 && okRule.ok && seniorRule.ok,
        negative: proxy.audienceProxyHits("young-families").length > 0 && proxy.audienceProxyHits("church-goers").length > 0 && !seniorExcl.ok && (seniorExcl as any).refusalKind === "protected_characteristic",
        detail: JSON.stringify({ okRule, seniorRule, seniorExcl }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148D — natural language and voice across the whole OS (C17)
// ═════════════════════════════════════════════════════════════════════════════
const DAGENT = { userId: "00000000-0000-4000-8000-000000000001", userType: "agent", platformRole: null, agentId: "00000000-0000-4000-8000-0000000000a1" }
const DTENANT = { brokerageId: "00000000-0000-4000-8000-0000000000b1" }

group("148D", "one intent interface (interpretIntent → plan → authority → execute)", [
  {
    id: "148D·C17", label: "'Find buyers interested in acreage' → buyer_interest_search, interest=acreage, a scoped READ; an unrelated sentence routes NOWHERE",
    run: async () => {
      const I = await import("../lib/voice-admin/intent-interface")
      const r = I.interpretIntent({ utterance: "Find buyers interested in acreage", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      const none = I.interpretIntent({ utterance: "the weather looks lovely today", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      return {
        positive: r.capability === "buyer_interest_search" && r.params.interest === "acreage" && r.authority_check.allowed && !r.authority_check.confirmationRequired && r.authority_check.dataScope === "own",
        negative: none.capability === null && none.via === "none" && /didn't catch/.test(none.plan.summary),
        detail: JSON.stringify({ c: r.capability, p: r.params, a: r.authority_check.outcome }),
      }
    },
  },
  {
    id: "148D·C17", label: "'Write a blog on this month's market' → market_blog_draft with a typed plan that waits for a yes AND the approver; typed = spoken",
    run: async () => {
      const I = await import("../lib/voice-admin/intent-interface")
      const v = I.interpretIntent({ utterance: "Write a blog on this month's market", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      const t = I.interpretIntent({ utterance: "Write a blog on this month's market", modality: "text", actor: DAGENT, tenant: DTENANT, now: NOW })
      return {
        positive: v.capability === "market_blog_draft" && v.params.period === "November 2026" && v.plan.steps.length > 0 && v.plan.needsConfirmation && v.authority_check.approvalRequired && t.capability === v.capability,
        negative: v.params.area === null && v.missing.length === 0, // the area is left to the verified territory — never invented
        detail: JSON.stringify({ c: v.capability, params: v.params, steps: v.plan.steps.length }),
      }
    },
  },
  {
    id: "148D·C17", label: "missing information is ASKED, never guessed: a bare virtual open house asks listing/date/time/link; the fully-said request asks nothing",
    run: async () => {
      const I = await import("../lib/voice-admin/intent-interface")
      const bare = I.interpretIntent({ utterance: "Schedule a virtual open house", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      const full = I.interpretIntent({ utterance: "Schedule a virtual open house for 12 Oak Street on Saturday from 1 to 3 pm https://zoom.us/j/123456", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      return {
        positive: full.capability === "open_house_schedule" && full.missing.length === 0 && full.params.date === "2026-11-07" && full.params.start_time === "13:00",
        negative: bare.missing.map((m) => m.param).join(",") === "listing,date,start_time,end_time,join_url" && bare.clarification === bare.missing[0].ask && bare.params.date === null,
        detail: JSON.stringify({ bare: bare.missing.map((m) => m.param), full: full.params }),
      }
    },
  },
  {
    id: "148D·C17", label: "out of authority is REFUSED, not executed: a compliance officer's ad request → 'refused' with no client minted; a money route is never spoken",
    run: async () => {
      const I = await import("../lib/voice-admin/intent-interface")
      const live = await import("../lib/voice-admin/intent-interface-live")
      const ad = I.interpretIntent({ utterance: "Create an ad for my new listing", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      const co = I.interpretIntent({ utterance: "Create an ad for my new listing", modality: "voice", actor: { ...DAGENT, userType: "compliance_officer" }, tenant: DTENANT, now: NOW })
      return withSvc(null, async () => { // any createServiceClient() call throws — "nothing executed" is measured, not assumed
        const exAd = await live.executeIntent(ad, { actor: DAGENT, tenant: DTENANT, confirmed: false })
        const exCo = await live.executeIntent(co, { actor: { ...DAGENT, userType: "compliance_officer" }, tenant: DTENANT, confirmed: false })
        const money = I.checkIntentAuthority({ ...I.intentRoute("contact_care_scan")!, governedBy: "payment_transfer" as never }, DAGENT)
        return {
          positive: ad.authority_check.outcome === "allowed" && exAd.status === "needs_confirmation",
          negative: co.authority_check.outcome === "refused_role" && exCo.status === "refused" && money.outcome === "refused_never_spoken",
          detail: JSON.stringify({ exAd: exAd.status, exCo: exCo.status, err: exCo.error, money: money.outcome }),
        }
      })
    },
  },
  {
    // Re-asserted wave 149Z (owner ruling 2026-11-03): a persona audience ('seniors') is lawful and passes; what is dropped is
    // the housing ad platform's refused narrowing (age / gender / ZIP / lookalike). Both arms flipped to the owner's rule.
    id: "148D·C17", label: "ad audiences: a persona ('seniors', 'first-time buyers') passes; age narrowing ('aged 55 and over') is DROPPED with Meta's Special Ad Category reason (the ad still drafts)",
    run: async () => {
      const I = await import("../lib/voice-admin/intent-interface")
      const bad = I.interpretIntent({ utterance: "Create an ad for my new listing targeting buyers aged 55 and over", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      const good = I.interpretIntent({ utterance: "Create an ad for my new listing targeting first-time buyers", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      const persona = I.interpretIntent({ utterance: "Create an ad for my new listing targeting seniors", modality: "voice", actor: DAGENT, tenant: DTENANT, now: NOW })
      return {
        positive: good.params.audience === "first-time buyers" && good.notes.length === 0 && persona.params.audience === "seniors" && persona.notes.length === 0,
        negative: bad.capability === "listing_ad_draft" && bad.params.audience === null && bad.notes.some((n) => /Special Ad Category/.test(n)),
        detail: JSON.stringify({ bad: bad.params.audience, notes: bad.notes }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148E — neighbourly buyer explanations, maps, sources (C18; rulings 7, 8, 9)
// ═════════════════════════════════════════════════════════════════════════════
const ROUTE_MAP = {
  kind: "route", image_url: "https://api.mapbox.com/styles/v1/static/route.png", attribution: "© Mapbox © OpenStreetMap", renderer: "mapbox", evidence_source: "provider:mapbox",
  from: { lat: 30.25, lon: -97.75, label: "12 Oak St" }, to: { lat: 30.27, lon: -97.74, label: "Medical Center" }, minutes: 18, meters: 14_000, profile: "driving-traffic", assumption: "weekday 8 am traffic", observed_at: "2026-11-01T12:00:00Z",
}
group("148E", "explanation evidence, labelled sources, honest units, consent of the channel", [
  {
    id: "148E·C18", label: "every claim names evidence or says unknown; a FABRICATED claim (no evidence), an unknown with figures, an invented source are refused",
    run: async () => {
      const E = await import("../lib/buyer-search/explanation-evidence")
      const good = E.validateClaims([
        { claim: "3 bedrooms, as you asked", topic: "size", verdict: "match", evidence_source: "listing", confidence: "high" },
        { claim: "The commute time is not known yet", topic: "commute", verdict: "unknown", evidence_source: null, confidence: "low", unknown: true },
      ])
      const fabricated = E.validateClaims([{ claim: "A very quiet street", topic: "quiet_setting", verdict: "match", evidence_source: null, confidence: "high" }])
      const unknownFigures = E.validateClaims([{ claim: "About 12 minutes to work", topic: "commute", verdict: "unknown", evidence_source: null, confidence: "low", unknown: true, figures: { minutes: 12 } }])
      const inventedSource = E.validateClaims([{ claim: "Walk score 91", topic: "walkability", verdict: "match", evidence_source: "provider:walkscore" as never, confidence: "high" }])
      return { positive: good.ok, negative: !fabricated.ok && !unknownFigures.ok && !inventedSource.ok, detail: JSON.stringify([fabricated.problems, unknownFigures.problems, inventedSource.problems]) }
    },
  },
  {
    id: "148E·C18", label: "a route map renders ONLY with its evidence: routed minutes + both ends + provider:mapbox pass; minutes missing / a places map credited to the router are refused",
    run: async () => {
      const E = await import("../lib/buyer-search/explanation-evidence")
      const claim = (map: any) => [{ claim: "18 minutes by car at rush hour", topic: "commute", verdict: "match", evidence_source: "provider:mapbox", confidence: "high", map }] as never
      const good = E.validateClaims(claim(ROUTE_MAP))
      const noMinutes = E.validateClaims(claim({ ...ROUTE_MAP, minutes: null }))
      const placesByRouter = E.validateClaims(claim({ ...ROUTE_MAP, kind: "places", to: null }))
      return { positive: good.ok, negative: !noMinutes.ok && !placesByRouter.ok, detail: JSON.stringify([good.problems, noMinutes.problems, placesByRouter.problems]) }
    },
  },
  {
    id: "148E·R8", label: "three sources labelled for what they are: RentCast is NEVER a verified active listing; IDX and in-house are",
    run: async () => {
      const E = await import("../lib/buyer-search/explanation-evidence")
      const rc = E.describeListingSource("rentcast"), idx = E.describeListingSource("idx"), own = E.describeListingSource("platform", { brokerageName: "Elm Realty" })
      return {
        positive: idx.verified_active_listing && idx.evidence_source === "listing" && own.verified_active_listing && own.label === "One of Elm Realty's own listings",
        negative: rc.verified_active_listing === false && rc.evidence_source === "provider:rentcast" && /not a verified active listing/.test(rc.label),
        detail: JSON.stringify({ rc, idx: idx.label, own: own.label }),
      }
    },
  },
  {
    id: "148E·C18", label: "acreage from the source's own number (87,120 sq ft = 2 acres); a unit-less 500 is UNKNOWN, never converted; an invented place is caught",
    run: async () => {
      const E = await import("../lib/buyer-search/explanation-evidence")
      const two = E.lotFactsFrom({ lotSizeSqft: 87_120, source: "provider:rentcast" })
      const odd = E.lotFactsFrom({ lotSize: 500, source: "listing" })
      const facts = "Mapped within an easy walk: Riverside Park (420 m, provider:osm)."
      const grounded = E.inventedPlaces("A short walk to Riverside Park.", facts)
      const invented = E.inventedPlaces("A short walk to Riverside Park and two cafes near Whole Foods.", facts)
      return {
        positive: two?.acres === 2 && two.basis === "reported_sqft" && grounded.length === 0,
        negative: odd?.basis === "unknown_unit" && odd.acres === null && invented.length >= 2,
        detail: JSON.stringify({ two, odd, invented }),
      }
    },
  },
  {
    id: "148E·R9", label: "criteria consent is a FACT of the channel or null: signed-in portal → self_service_portal, email → inbound_message; anonymous portal / a call → null",
    run: async () => {
      const { defaultCriteriaConsent } = await import("../lib/buyer-search/buyer-criteria")
      const at = "2026-11-01T12:00:00Z"
      const portal = defaultCriteriaConsent("portal", at, null, { type: "user", userId: "u-buyer" })
      const email = defaultCriteriaConsent("email", at, "message:m-1")
      return {
        positive: portal?.basis === "self_service_portal" && portal.ref === "u-buyer" && email?.basis === "inbound_message",
        negative: defaultCriteriaConsent("portal", at, null, null) === null && defaultCriteriaConsent("voice", at, "voice_call:1") === null && defaultCriteriaConsent("system", at) === null,
        detail: JSON.stringify({ portal, email }),
      }
    },
  },
  {
    id: "148E·R7", label: "the warm-voice rubric: a neighbourly, specific answer with one question and a gentle agent offer passes; pressure and robot words fail",
    run: async () => {
      const E = await import("../lib/buyer-search/explanation-evidence")
      const warm = "You told us a big yard matters most to you, and this home sits on 0.62 acres with a fenced back garden, per the listing. The road out front looks quiet on the map, though a rush-hour visit is the real test. Would a Saturday walkthrough suit you? Jo would be happy to show you around."
      const pushy = "Act now — this must-see home won't last! Our system scored it a 92% match."
      const a = E.warmVoiceRubric(warm, { agentName: "Jo" }), b = E.warmVoiceRubric(pushy, { agentName: "Jo" })
      return { positive: a.pass, negative: !b.pass && b.failures.some((f) => /pressure/.test(f)) && b.failures.some((f) => /machine/.test(f)), detail: JSON.stringify({ a: a.failures, b: b.failures }) }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148F — dataset verification (C19), chronological life-event vocabulary (C20), warm engagement (rulings 5, 6, 17)
// ═════════════════════════════════════════════════════════════════════════════
group("148F", "one life-event vocabulary, one write rule, never naming the event, verified datasets only", [
  {
    id: "148F·C20", label: "LIFE_EVENT_VOCAB resolves retired spellings (divorce → divorce_filing, probate → inheritance); a prohibited or unknown token resolves to NOTHING",
    run: async () => {
      const V = await import("../lib/enrichment/life-event-vocabulary")
      return {
        positive: V.canonicalLifeEventType("divorce") === "divorce_filing" && V.canonicalLifeEventType("probate") === "inheritance" && V.canonicalLifeEventType("Death in family") === "death_in_household"
          && V.LEGACY_LIFE_EVENT_ALIASES.divorce === "divorce_filing" && V.canonicalLifeEventType("relocation") === "relocation",
        negative: V.canonicalLifeEventType("pregnancy") === null && V.canonicalLifeEventType("diagnosis") === null && V.canonicalLifeEventType("new_hobby") === null && V.lifeEventVocabEntry("pregnant") === null,
      }
    },
  },
  {
    id: "148F·C20", label: "mergeLifeEvents canonicalises + dedups the same event, sequences the rest, links supersedes; a prohibited token is dropped, never stored",
    run: async () => {
      const V = await import("../lib/enrichment/life-event-vocabulary")
      const stored = [{ event: "divorce", date: "2026-09-01", source: "osint" }]
      const incoming = [
        { type: "divorce_filing", event_date: "2026-09-01" },           // the same event, respelled → a duplicate
        { type: "pregnancy" },                                           // prohibited → dropped with its reason
        { type: "new_job", event_at: "2026-05-01" },                     // job_change
        { type: "relocating", event_at: "2026-10-15" },                  // relocation SUPERSEDES the job change
      ]
      const m = V.mergeLifeEvents(stored, incoming, { now: NOW })
      const types = m.events.map((e) => `${e.type}#${e.sequence}${e.supersedes ? `>${e.supersedes}` : ""}`)
      const current = V.currentLifeEvents(m.events).map((e) => e.type).sort()
      return {
        positive: JSON.stringify(types) === JSON.stringify(["divorce_filing#1", "job_change#2", "relocation#3>2"]) && m.events[0].source === "osint" && JSON.stringify(current) === JSON.stringify(["divorce_filing", "relocation"]),
        negative: m.duplicates === 1 && m.dropped.length === 1 && m.dropped[0].token === "pregnancy" && !JSON.stringify(m.events).includes("pregnan"),
        detail: JSON.stringify({ types, current, dup: m.duplicates, dropped: m.dropped }),
      }
    },
  },
  {
    id: "148F·R17", label: "screenLifeEventOutreach refuses a draft that names or alludes to the event (or reveals watching); a warm draft that does not passes",
    run: async () => {
      const V = await import("../lib/enrichment/life-event-vocabulary")
      const events = [{ type: "divorce_filing" }, { type: "new_baby" }]
      const warm = V.screenLifeEventOutreach("Hi Sam — here's a short guide to what homes near you have sold for this month, in case it's useful. Happy to answer any questions whenever suits you.", { events })
      const names = V.screenLifeEventOutreach("So sorry to hear about the divorce — when you're ready we can talk about selling.", { events })
      const watching = V.screenLifeEventOutreach("We noticed in public records that you might be thinking of moving.", { events })
      const proxy = V.screenLifeEventOutreach("Congrats on the new arrival! A bigger home could help.", { events })
      const notCarried = V.screenLifeEventOutreach("This listing has a sunny nursery off the main bedroom.", { events: [] })
      return {
        positive: warm.ok && notCarried.ok, // a room called a nursery is a room — proxy words are screened only for events the person carries
        negative: !names.ok && names.hits.some((h) => h.event === "divorce_filing") && !watching.ok && watching.hits.some((h) => h.event === "surveillance") && !proxy.ok,
        detail: JSON.stringify({ warm: warm.hits, names: names.hits, watching: watching.hits, proxy: proxy.hits }),
      }
    },
  },
  {
    id: "148F·C19", label: "dataset ceiling: a verified, fresh registry dataset lends `verified`; NCOA (unverified), an unnamed / unregistered dataset, a drifted or stale one only `unknown`",
    run: async () => {
      const D = await import("../lib/intent/dataset-verification")
      const CAMBRIDGE = "data.cambridgema.gov/8xmj-thsm"
      const empty = memSupabase({ market_dataset_verifications: [] })
      const ok = await D.datasetCeilingWithObservations(empty, CAMBRIDGE, NOW)
      const ncoa = await D.datasetCeilingWithObservations(empty, "usps.ncoalink/processing-acknowledgement", NOW)
      const unnamed = await D.datasetCeilingWithObservations(empty, null, NOW)
      const unregistered = await D.datasetCeilingWithObservations(empty, "data.example.gov/zzzz-zzzz", NOW)
      const drifted = await D.datasetCeilingWithObservations(memSupabase({ market_dataset_verifications: [
        { dataset_key: CAMBRIDGE, status: "drifted", drift: "404 on read", freshness: null, last_verified_at: "2026-11-01T00:00:00Z", method: "sweep_observation", verified_by: "permit-signal-scan", observed_at: "2026-11-01T06:00:00Z" },
      ] }), CAMBRIDGE, NOW)
      const stale = await D.datasetCeilingWithObservations(empty, CAMBRIDGE, new Date("2027-09-01T00:00:00Z"))
      const refusedLog = await D.datasetCeilingWithObservations(memSupabase({}, { refuse: { market_dataset_verifications: "permission denied" } }), "usps.ncoalink/processing-acknowledgement", NOW)
      return {
        positive: ok.ceiling === "verified" && ok.status === "verified" && ok.blindSpot === null,
        negative: [ncoa, unnamed, unregistered, drifted, stale].every((c) => c.ceiling === "unknown") && drifted.status === "drifted" && stale.status === "stale"
          && refusedLog.ceiling === "unknown" && !!refusedLog.blindSpot, // an unreadable log never upgrades anything — and says so
        detail: JSON.stringify({ ok, ncoa: ncoa.status, unnamed: unnamed.status, unregistered: unregistered.status, drifted: drifted.status, stale: stale.status, refused: refusedLog.blindSpot }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148G — creative lead-magnet funnels (C21), honest market reports (ruling 10)
// ═════════════════════════════════════════════════════════════════════════════
const GB1 = "00000000-0000-4000-8000-0000000000e1", GB2 = "00000000-0000-4000-8000-0000000000e2", GAG = "00000000-0000-4000-8000-0000000000e3"
const GU1 = "00000000-0000-4000-8000-0000000000e4", GSEQ = "00000000-0000-4000-8000-0000000000e5", GORIGIN = "https://app.example.com"
function funnelWorld() {
  const db: any = memSupabase({
    brokerages: [{ id: GB1, name: "Elm Realty", slug: "elm-realty", deleted_at: null }, { id: GB2, name: "Other Realty", slug: "other", deleted_at: null }],
    agents: [{ id: GAG, brokerage_id: GB1, user_id: GU1, is_active: true }],
    users: [{ id: GU1, brokerage_id: GB1, first_name: "Ann", user_type: "agent" }],
    calendar_provider_accounts: [{ id: "cal-1", brokerage_id: GB1, user_id: GU1, is_active: true }],
    campaign_sequences: [{ id: GSEQ, brokerage_id: GB1, name: "First-time buyer basics", is_active: true }],
    campaign_sequence_steps: [1, 2, 3, 4].map((i) => ({ id: `step-${i}`, sequence_id: GSEQ })),
    market_data: [{ id: "md-1", brokerage_id: GB1, zip_code: "78704", city: "Austin", data_date: "2026-10-20", source_type: "rentcast" }],
    contacts: [], lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_funnel_items: [], lead_magnet_promises: [], ai_video_projects: [],
    agent_action_ledger: [], lifecycle_events: [], notifications: [], tasks: [], transparency_updates: [], form_submissions: [], manager_signals: [], activities: [],
  }, { uuidIds: true, stampCreatedAt: true })
  db.rpc = async () => ({ data: null, error: null })
  return db as MemClient
}
const FUNNEL_PLAN = {
  insufficient: false, insufficient_reason: null, name: "Your First-Home Head Start", magnet_type: "buyer_guide",
  big_promise: "Walk into your first home search knowing exactly what to do", angle: "The first steps are simpler than they look", awareness_stage: "problem_aware",
  landing: { headline: "Know your first five moves before you tour a single home", subhead: "A one-page plan and a no-pressure chat — built for renters ready to buy.", cta: "Send my head start", description: "Practical first steps from Elm Realty.", faq: [] },
  situation_keys: ["timeline", "move_side", "current_home"], extra_questions: [],
  deliverables: [
    { key: "readiness_checklist", kind: "checklist", role: "primary", title: "The First-Home Readiness Checklist", promise_line: "The First-Home Readiness Checklist — your first five moves on one page", outline: ["credit", "budget", "pre-approval"], why: "a quick win" },
    { key: "preapproval_video", kind: "video", role: "deliverable", title: "What pre-approval really means", promise_line: "A 90-second video on pre-approval", outline: ["what it is"], why: "authority" },
    { key: "first_chat", kind: "consultation", role: "deliverable", title: "A no-pressure first conversation", promise_line: "Book a chat", outline: [], why: "commitment" },
    { key: "live_qa", kind: "webinar", role: "deliverable", title: "Live first-time buyer Q&A", promise_line: "Join our live Q&A", outline: [], why: "social proof" },
  ],
  thank_you: { headline: "Your head start is on its way", message: "Check your inbox.", next_step_line: "Want a hand? Ann is happy to help." },
  steps: { personal_video: false, calendar_link: false, portal_task: { title: "Tick off your first move", summary: "Start with step one." }, education_sequence: false },
  follow_up: { first_value_moment: "the checklist arrives", signals_to_watch: ["opened the checklist"], handoff_when: "they book a chat" },
  learning: { hypothesis: "renters convert on a one-page plan", primary_metric: "visit_to_submit" },
}
const FUNNEL_CHECKLIST = {
  insufficient: false, insufficient_reason: null, title: "The First-Home Readiness Checklist", intro: "Five moves that make your first home search calmer.",
  sections: [{ heading: "Before you shop", items: [{ text: "Check your credit report", why: "no surprises" }, { text: "Set a monthly budget", why: "it frames the search" }, { text: "Gather income documents", why: "faster pre-approval" }] },
    { heading: "Getting ready", items: [{ text: "Talk to a lender", why: "sellers take it seriously" }, { text: "List your must-haves", why: "focused tours" }, { text: "Ask how offers work locally", why: "rules vary by state" }] }],
  closing: "Questions? Reply any time.",
}
function funnelSeams(db: any, over: Record<string, unknown> = {}) {
  let n = 0
  const deps: any = {
    now: NOW, client: db,
    entitlement: async () => ({ allowed: true, reason: "ok" }),
    plan: async () => FUNNEL_PLAN,
    writeChecklist: async () => FUNNEL_CHECKLIST,
    finalize: async (a: { texts: string[] }) => ({ ok: true, texts: a.texts }),
    renderDocument: async () => { n++; return { ok: true, pdfUrl: `https://cdn.example.com/client-docs/e1/checklist-${n}.pdf`, documentId: null, error: null } },
    writeVideoScript: async () => ({ insufficient: false, insufficient_reason: null, title: "What pre-approval really means", script: "Hi, I'm Ann with Elm Realty. Pre-approval is simply a lender looking at your income, savings and credit before you shop, so you know your comfortable range. Here is what they look at, and what to bring. If anything is unclear, reply and ask me. Elm Realty.", on_screen: ["Income", "Savings", "Credit"] }),
    commissionVideo: async () => { const id = "00000000-0000-4000-8000-0000000000v1"; db.tables.ai_video_projects.push({ id, brokerage_id: GB1, agent_id: GAG, status: "pending_review", approval_status: "pending_review", video_url: null, video_metadata: {} }); return { ok: true, status: "staged", videoProjectId: id } },
    enroll: async () => ({ success: true, enrollmentId: "enr-1" }),
    commissionPersonalVideo: async () => ({ ok: true, status: "staged", videoProjectId: "pv-1" }),
    draftBrand: async () => ({}),
    ...over,
  }
  deps.deliverable = { now: NOW, funnel: deps }
  return deps
}
const FUNNEL_BRIEF = { brokerageId: GB1, agentId: GAG, createdBy: GU1, audience: "First-time buyers who rent in Austin", benefit: "Know exactly what to do before you shop", outcome: "Buy a first home with confidence", area: "Austin", territory: { zip: "78704", city: "Austin", state: "TX" }, baseUrl: GORIGIN }

group("148G", "a creative conversion funnel that promises only what exists; market reports off the topic bank", [
  {
    id: "148G·C21", label: "createMagnetFunnel: landing page in the tenant site → C15 form (identity + situation + owner) → mixed deliverables, a STAGED video allowed",
    run: async () => {
      const { createMagnetFunnel } = await import("../lib/lead-magnets/magnet-funnel")
      const db = funnelWorld()
      return withSvc(db, async () => {
        const r = await createMagnetFunnel(FUNNEL_BRIEF as never, funnelSeams(db))
        if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r) }
        const pkg = r.package
        const fields = pkg.form.fields.map((f) => f.name)
        const kinds = pkg.deliverables.map((d) => `${d.kind}:${d.status}`)
        const video = pkg.deliverables.find((d) => d.kind === "video")
        return {
          positive: pkg.landing_page.path === `/site/elm-realty/lm/${pkg.landing_page.slug}` && ["first_name", "email", "phone", "timeline", "move_side"].every((f) => fields.includes(f))
            && pkg.form.consent.contract === "C15" && pkg.form.owner.agent_id === GAG && pkg.form.consent.creator_user_id === GU1 && kinds.includes("checklist:ready") && kinds.includes("consultation:arranged"),
          negative: video?.status === "staged" && video.promised === false, // staged is allowed — and never promised before it is ready
          detail: JSON.stringify({ path: pkg.landing_page.path, fields, kinds, notes: pkg.notes.slice(0, 4) }),
        }
      })
    },
  },
  {
    id: "148G·C21", label: "honesty: the page promises only ready/arranged items; an unscheduled webinar is PLANNED (never promised); a refused entitlement writes nothing",
    run: async () => {
      const { createMagnetFunnel } = await import("../lib/lead-magnets/magnet-funnel")
      const db = funnelWorld()
      return withSvc(db, async () => {
        const r = await createMagnetFunnel(FUNNEL_BRIEF as never, funnelSeams(db))
        const dbx = funnelWorld()
        const refused = await createMagnetFunnel(FUNNEL_BRIEF as never, funnelSeams(dbx, { entitlement: async () => ({ allowed: false, reason: "budget", message: "AI budget reached" }) }))
        const noAudience = await createMagnetFunnel({ ...FUNNEL_BRIEF, audience: "" } as never, funnelSeams(funnelWorld()))
        if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r) }
        const form = rows(db, "lead_capture_forms").find((f) => f.id === r.package.landing_page.form_id)
        const promised = r.package.deliverables.filter((d) => d.promised).map((d) => d.promiseLine)
        const webinar = r.package.deliverables.find((d) => d.kind === "webinar")
        return {
          positive: r.package.publishable.ok === true && JSON.stringify(form?.landing_content?.bullets) === JSON.stringify(promised) && promised.length >= 2,
          negative: webinar?.status === "planned" && webinar.promised === false && !refused.ok && refused.stage === "entitlement" && rows(dbx, "lead_capture_forms").length === 0 && !noAudience.ok && noAudience.stage === "input",
          detail: JSON.stringify({ bullets: form?.landing_content?.bullets, promised, webinar: webinar?.status }),
        }
      })
    },
  },
  {
    id: "148G·C21", label: "the deliverable vocabulary is C4's asset kinds + calculator/webinar/mini_course/consultation; a declared 'book' primary is not a funnel (books publish elsewhere)",
    run: async () => {
      const F = await import("../lib/lead-magnets/magnet-funnel")
      const { PROMISE_ASSET_KINDS } = await import("../lib/lead-magnets/promised-deliverables")
      const extra = ["calculator", "webinar", "mini_course", "consultation"]
      const primary = F.funnelPrimaryOf({ funnel: { primary: { key: "k", kind: "checklist", fulfilment: "asset", title: "T", outline: [], brief: {}, funnel_id: "f" } } })
      return {
        positive: PROMISE_ASSET_KINDS.every((k) => (F.FUNNEL_DELIVERABLE_KINDS as readonly string[]).includes(k)) && extra.every((k) => (F.FUNNEL_DELIVERABLE_KINDS as readonly string[]).includes(k))
          && F.FUNNEL_DELIVERABLE_KINDS.length === PROMISE_ASSET_KINDS.length + extra.length && primary?.kind === "checklist",
        negative: F.funnelPrimaryOf({ funnel: { primary: { kind: "book" } } }) === null && F.funnelPrimaryOf(null) === null && F.funnelPrimaryOf({}) === null,
      }
    },
  },
  {
    id: "148G·R10", label: "market-report topics read verified market data only — the recorded client never asks for content_topic_bank; the recorder sees a planted read",
    run: async () => {
      const { suggestMarketReportTopics } = await import("../lib/market-reports/topics")
      const sold = (i: number) => ({ id: `l-${i}`, brokerage_id: GB1, status: "sold", deleted_at: null, zip: "78704", city: "Austin", state: "TX", address: `${100 + i} Elm St`, sold_price: 580_000 + i * 10_000, sold_date: `2026-0${7 + (i % 3)}-1${i}`, list_price: 590_000, listing_date: "2026-06-01", bedrooms: 3, bathrooms: 2, sqft: 1800 })
      const db = memSupabase({
        market_data: [{ id: "md-1", brokerage_id: GB1, market_area: "78704", zip_code: "78704", city: "Austin", state: "TX", data_date: "2026-10-20", source_type: "rentcast", active_listings: 214, median_sale_price: 612_000, avg_days_on_market: 44, price_trend_pct_1yr: -2.4 }],
        market_trends: [{ id: "tr-1", brokerage_id: GB1, zip_code: "78704", snapshot_month: "2026-10-01", median_price: 605_000, active_inventory: 220 }, { id: "tr-0", brokerage_id: GB1, zip_code: "78704", snapshot_month: "2026-09-01", median_price: 598_000, active_inventory: 205 }],
        listings: [sold(1), sold(2), sold(3), sold(4)], farm_territories: [], brokerages: [{ id: GB1, city: "Austin", state: "TX", zip: "78704", name: "Elm Realty" }],
        content_topic_bank: [{ id: "t1", brokerage_id: GB1, status: "fresh", expires_at: "2026-12-01T00:00:00Z", topic_title: "Is now a good time to sell?", raw_data: { topic_evidence: { source_class: "customer_questions" } } }],
        market_dataset_verifications: [],
      }, { uuidIds: true })
      const reads: string[] = []
      const client: any = { ...db, from: (t: string) => { reads.push(t); return (db as any).from(t) } }
      let prompt = ""
      const r = await suggestMarketReportTopics(client, { brokerageId: GB1, territory: { grain: "zip", label: "78704", zip: "78704", city: "Austin", state: "TX" } }, {
        now: new Date("2026-10-31T12:00:00Z"),
        rank: async (a) => { prompt = a.prompt; return { suggestions: [{ title: "78704 prices against a firming month", angle: "is the dip real?", format: "equity_this_quarter", evidence_ids: ["market:md-1", "topic:t1"], why_now: "two kinds of evidence agree" }] } as never },
      })
      const planted: string[] = []
      ;({ ...db, from: (t: string) => { planted.push(t); return (db as any).from(t) } } as any).from("content_topic_bank")
      return {
        positive: !reads.includes("content_topic_bank") && !/Is now a good time to sell|\[topic:/.test(prompt) && prompt.includes("(market_signal)") && r.suggestions.every((s) => s.evidence.every((e) => !e.id.startsWith("topic:"))),
        negative: planted.includes("content_topic_bank"),
        detail: JSON.stringify({ reads: [...new Set(reads)], ev: r.suggestions.map((s) => s.evidence.map((e) => e.id)), notes: r.notes }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148H — autonomous events and virtual open houses (C22; ruling 20)
// ═════════════════════════════════════════════════════════════════════════════
const exportsFn = (src: string, fn: string) => new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\s*\\(`).test(src)
function eventCensus(vocabulary: readonly string[], registry: Record<string, any>, sourceOf: (f: string) => string): string[] {
  const out: string[] = []
  for (const v of vocabulary) {
    const s = registry[v]
    if (!s) { out.push(`${v}: no producer entry`); continue }
    const doors = [s.producer, s.registration.door, ...s.attendance.checkInDoors, s.followUp.door].filter(Boolean)
    for (const d of doors) if (!exportsFn(sourceOf(d.file), d.fn)) out.push(`${v}: ${d.file}::${d.fn} does not exist`)
    if (s.registration.required && !s.registration.door) out.push(`${v}: registration required, no door`)
    if (s.venue !== "in_person" && !s.capability.hosting) out.push(`${v}: online kind with no hosting capability`)
  }
  for (const k of Object.keys(registry)) if (!vocabulary.includes(k)) out.push(`${k}: the CHECK does not admit it`)
  return out
}
const listEq = (a: readonly string[], b: readonly string[]) => sorted(a) === sorted(b)

group("148H", "event producer registry, verified attendance, identity matched carefully", [
  {
    id: "148H·C22", label: "identity_match vocabulary = the live m925 CHECK (generated cache) = the migration; a planted extra spelling is caught",
    run: async () => {
      const R = await import("../lib/open-house/event-registry")
      const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
      const live = CHECK_VOCABULARIES.event_attendance_evidence?.identity_match ?? []
      const file = readdirSync(join(ROOT, "supabase/migrations")).find((f) => /^m925-/.test(f)) ?? ""
      const sql = raw(`supabase/migrations/${file}`).split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
      const m = /identity_match\s+text NOT NULL CHECK \(identity_match = ANY \(ARRAY\[([^\]]*)\]/.exec(sql)
      const migrated = m ? [...m[1].matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]) : []
      return {
        positive: live.length > 0 && listEq(R.IDENTITY_MATCHES, live) && listEq(R.IDENTITY_MATCHES, migrated),
        negative: !listEq([...R.IDENTITY_MATCHES, "display_name"], live),
        detail: JSON.stringify({ code: R.IDENTITY_MATCHES, live, migrated, file }),
      }
    },
  },
  {
    id: "148H·C22", label: "every event kind the database admits has a producer, registration, check-in and follow-up door that EXISTS; a kind with no producer is caught",
    run: async () => {
      const R = await import("../lib/open-house/event-registry")
      const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
      const vocab = CHECK_VOCABULARIES.open_house_events?.event_type ?? []
      const findings = eventCensus(vocab, R.EVENT_PRODUCER_REGISTRY as never, code)
      const missing = eventCensus([...vocab, "community_bbq"], R.EVENT_PRODUCER_REGISTRY as never, code)
      const tomb = eventCensus(["open_house"], { open_house: { ...R.EVENT_PRODUCER_REGISTRY.open_house, producer: { file: "x.ts", fn: "createOpenHouse" } } }, (f) => (f === "x.ts" ? stripComments("// export async function createOpenHouse() {} — tombstone\n") : code(f)))
      const unstorable = eventCensus(["open_house"], R.EVENT_PRODUCER_REGISTRY as never, code) // registry kinds the CHECK would not admit
      return {
        // THE RULE, NOT A WAYPOINT (CLAUDE.md §2): the live CHECK and the registry name the SAME kinds — five when lane H
        // landed, six after m926 (client_event), whatever the next migration says — and every one has its producer.
        positive: vocab.length > 0 && [...vocab].sort().join() === [...R.EVENT_KINDS].sort().join() && findings.length === 0,
        negative: missing.some((f) => /community_bbq: no producer/.test(f)) && tomb.some((f) => /does not exist/.test(f)) && unstorable.some((f) => /does not admit/.test(f)),
        detail: JSON.stringify({ vocab, findings }),
      }
    },
  },
  {
    id: "148H·C22", label: "the ONE scheduling door offers exactly the registry's kinds (= the live CHECK); the situation timeline = contacts.timeline buckets",
    run: async () => {
      const R = await import("../lib/open-house/event-registry")
      const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
      const src = code("app/actions/open-house.ts")
      const body = src.slice(src.indexOf("export async function createOpenHouse"))
      const list = /const\s+OPEN_HOUSE_EVENT_TYPES\s*=\s*\[([^\]]*)\]/.exec(body)
      const offered = list ? [...list[1].matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]) : []
      const live = CHECK_VOCABULARIES.open_house_events?.event_type ?? []
      return {
        positive: listEq(offered, R.EVENT_KINDS) && listEq(R.EVENT_KINDS, live) && listEq(R.EVENT_TIMELINE_BUCKETS, CHECK_VOCABULARIES.contacts?.timeline ?? []),
        negative: !listEq(offered.filter((k) => k !== "webinar"), R.EVENT_KINDS) && !(R.EVENT_TIMELINE_BUCKETS as readonly string[]).some((b) => /^(30|60|90)/.test(b)),
        detail: JSON.stringify({ offered, kinds: R.EVENT_KINDS, live }),
      }
    },
  },
  {
    id: "148H·C22", label: "a display-name / anonymous join is NOT attendance; a registrant-id match present ≥120 s at a Zoom virtual open house IS",
    run: async () => {
      const R = await import("../lib/open-house/event-registry")
      const regs = [{ contactId: "c-1", providerRegistrantId: "reg-1", email: "a@x.test" }, { contactId: "c-2", providerRegistrantId: null, email: "shared@x.test" }, { contactId: "c-3", providerRegistrantId: null, email: "shared@x.test" }]
      const p = (over: any) => ({ registrantId: null, email: null, accountUserId: null, sessionUserId: "s", displayName: null, ...over })
      const byReg = R.matchParticipantIdentity(p({ registrantId: "reg-1" }), regs, { hostId: "h" })
      const byName = R.matchParticipantIdentity(p({ displayName: "Alice Smith" }), regs, { hostId: "h" })
      const ambiguous = R.matchParticipantIdentity(p({ email: "shared@x.test" }), regs, { hostId: "h" })
      const host = R.matchParticipantIdentity(p({ accountUserId: "h" }), regs, { hostId: "h" })
      const w = R.computeAttendanceWindow([{ kind: "participant_joined", at: "2026-11-01T18:00:00Z", participantKey: "s" }, { kind: "participant_left", at: "2026-11-01T18:03:00Z", participantKey: "s" }])
      const attended = R.attendanceVerdict({ kind: "virtual_open_house", provider: "zoom", matched: byReg.contactId !== null, seconds: w.seconds })
      const anon = R.attendanceVerdict({ kind: "virtual_open_house", provider: "zoom", matched: false, seconds: 900 })
      const youtube = R.attendanceVerdict({ kind: "webinar", provider: "youtube", matched: true, seconds: 3600 })
      return {
        positive: byReg.match === "registrant_id" && byReg.contactId === "c-1" && w.seconds === 180 && attended.attended && attended.verifiedBy === "zoom_participant",
        negative: byName.match === "unmatched" && byName.contactId === null && ambiguous.match === "unmatched" && host.match === "host" && !anon.attended && !youtube.attended,
        detail: JSON.stringify({ byReg, byName: byName.reason, attended, anon: anon.reason, youtube: youtube.reason }),
      }
    },
  },
  {
    id: "148H·C22", label: "the agent hears about a PERSON, never a click; an unverifiable host yields no fake no-show and a null attendance rate",
    run: async () => {
      const R = await import("../lib/open-house/event-registry")
      const near = R.shouldNotifyAgent({ verified: true, engagementRatio: 0.2, situation: { timeline: "1-3_months" }, audience: "consumer" })
      const click = R.shouldNotifyAgent({ verified: false, engagementRatio: 1, situation: { timeline: "immediate" }, audience: "consumer" })
      const rsvps = [{ rsvp_status: "attended", attendance_verified_by: "zoom_participant", registered_at: "2026-10-30" }, { rsvp_status: "registered", attendance_verified_by: null, registered_at: "2026-10-30" }]
      const zoom = R.eventOutcome({ kind: "webinar", provider: "zoom", rsvps, unmatchedJoins: 2 })
      const yt = R.eventOutcome({ kind: "webinar", provider: "youtube", rsvps, unmatchedJoins: 0 })
      return {
        positive: near.notify && zoom.attendanceRate === 0.5 && zoom.anonymousJoins === 2,
        negative: !click.notify && yt.attendanceRate === null && yt.noShow === 0 && yt.unverifiable === 1,
        detail: JSON.stringify({ near, click: click.reason, zoom, yt }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148I — status control (C23), closing terms (ruling 21), unattended answer (C24)
// ═════════════════════════════════════════════════════════════════════════════
const passLedger = async (_claim: unknown, run: () => Promise<unknown>) => run()
const IB = "11111111-1111-4111-8111-111111111111", IC = "c1c1c1c1-0000-4000-8000-000000000001", IU = "a2a2a2a2-0000-4000-8000-000000000002"
function unattendedWorld(body: string) {
  return memSupabase({
    brokerages: [{ id: IB, ai_isa_system_user_id: null }], manager_completions: [], agent_action_ledger: [], self_heal_events: [], notifications: [],
    outcome_reconciliations: [], ai_message_drafts: [{ id: "d-1", brokerage_id: IB, source_message_id: "m-1", status: "pending", acted_at: null }],
    messages: [{ id: "m-1", brokerage_id: IB, direction: "inbound", conversation_id: "conv-1", contact_id: IC, body, metadata: { channel: "sms", provider: "twilio" }, created_at: ago(300) }],
    contacts: [{ id: IC, brokerage_id: IB, first_name: "Dana", agent_id: "ag-1", dnc_status: false, ai_outreach_paused: false, source: "website", created_at: ago(60 * 24 * 30) }],
    activities: [], smart_assistant_suggestions: [], brokerage_settings: [], platform_settings: [], connector_healing_proposals: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { manager_completions: [["idempotency_key"]], agent_action_ledger: [["idempotency_key"]] } })
}

group("148I", "manual status with reason + proof, on-or-before closing, the AI answers when the human is silent", [
  {
    id: "148I·C23", label: "a manual status change needs the person AND a reason (≥ 10 chars): with one it is admitted; without, refused",
    run: async () => {
      const S = await import("../lib/kernel/status-override")
      const actor = { userId: "u-1", userType: "broker" }
      const ok = S.decideStatusOverride({ entity: "support_ticket", from: "open", to: "resolved", reason: "Customer confirmed the fix by phone", actor })
      const noReason = S.decideStatusOverride({ entity: "support_ticket", from: "open", to: "resolved", reason: "done", actor })
      const noActor = S.decideStatusOverride({ entity: "support_ticket", from: "open", to: "resolved", reason: "Customer confirmed the fix by phone", actor: { userId: null } })
      return {
        positive: ok.ok === true,
        negative: !noReason.ok && noReason.code === "reason_required" && !noActor.ok && noActor.code === "no_actor",
        detail: JSON.stringify({ ok, noReason, noActor }),
      }
    },
  },
  {
    id: "148I·C23", label: "listing Sold needs PROOF (the MLS record admits it); a gated value (Active) and a hard gate blocker are never overridden",
    run: async () => {
      const S = await import("../lib/kernel/status-override")
      const actor = { userId: "u-1", userType: "broker" }
      const reason = "Closed at title on Friday, recording confirmed"
      const withProof = S.decideStatusOverride({ entity: "listing", from: "pending", to: "sold", reason, evidence: { kind: "mls_record", ref: "MLS-4471123" }, actor })
      const noProof = S.decideStatusOverride({ entity: "listing", from: "pending", to: "sold", reason, actor })
      const gated = S.decideStatusOverride({ entity: "listing", from: "coming_soon", to: "active", reason, actor })
      const hard = S.decideStatusOverride({ entity: "transaction", from: "pending", to: "clear_to_close", reason, actor, hardBlockers: ["Closing compliance check FAILED"] })
      return {
        positive: withProof.ok === true,
        negative: !noProof.ok && noProof.code === "evidence_required" && !gated.ok && gated.code === "gated_value" && !hard.ok && hard.code === "hard_gate",
        detail: JSON.stringify({ withProof: withProof.ok, noProof: (noProof as any).code, gated: (gated as any).code, hard: (hard as any).code }),
      }
    },
  },
  {
    id: "148I·C23", label: "overrideStatus writes INSIDE the ledger with the C23 evidence; a refused decision never reaches the ledger or the write; every value is SHOWN in the picker",
    run: async () => {
      const S = await import("../lib/kernel/status-override")
      const claims: any[] = [], writes: string[] = []
      const ledger = (async (claim: any, run: () => Promise<unknown>) => { claims.push(claim); return run() }) as never
      const input = { entity: "open_house_event" as const, from: "scheduled", to: "cancelled", reason: "Seller asked to postpone the weekend", actor: { userId: "u-1" } }
      const runSpec = { brokerageId: "b-1", subject: { type: "open_house_event", id: "e-1" }, systemSource: "canary", apply: async () => { writes.push("cancelled"); return { ok: true as const } } }
      const ok = await S.overrideStatus(input, runSpec, { ledger })
      const refused = await S.overrideStatus({ ...input, reason: "" }, runSpec, { ledger })
      const opts = S.statusOptionsFor("open_house_event", "scheduled")
      return {
        positive: ok.ok && writes.length === 1 && claims.length === 1 && /cancelled/.test(String(claims[0].reasonDetail)) && listEq(opts.map((o) => o.value), S.OPEN_HOUSE_EVENT_STATUSES),
        negative: !refused.ok && claims.length === 1 && writes.length === 1 && opts.filter((o) => !o.selectable && o.why).length >= 5, // gated values SHOWN, disabled, with their door
        detail: JSON.stringify({ ok: ok.ok, refused, claims: claims.length, writes, opts: opts.map((o) => `${o.value}:${o.selectable}`) }),
      }
    },
  },
  {
    id: "148I·R21", label: "closing dates: the contract's 'on or before' deadline, the anticipated day and the actual day are three facts; a closed deal has no anticipated day",
    run: async () => {
      const C = await import("../lib/transactions/closing-dates")
      const open = C.resolveClosingDates({ status: "pending", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", estimated_close_date: "2026-12-10", property_state: "TX" })
      const closed = C.resolveClosingDates({ status: "closed", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", actual_close_date: "2026-12-09" })
      const unread = C.resolveClosingDates({ status: "pending", contract_closing_date: "2026-12-15" })
      return {
        positive: open.contractual?.terms === "on_or_before" && open.wording === "On or before 2026-12-15" && open.anticipated?.date === "2026-12-10" && open.actual === null && closed.actual?.date === "2026-12-09" && closed.anticipated === null,
        // RE-ASSERTED (wave 149, lane 149G — owner ruling 17): an unread wording is UNKNOWN — it no longer defaults to
        // "treated as needing an executed amendment" (that note demanded an amendment the contract may not require).
        negative: unread.contractual?.terms === null && unread.earlierClosing?.requiresExecutedAmendment === "unknown" && !unread.notes.some((n) => /treated as needing an executed amendment/.test(n)) && unread.notes.some((n) => /has not been read yet/.test(n)),
        detail: JSON.stringify({ open: open.wording, closed: closed.actual, unread: unread.notes }),
      }
    },
  },
  {
    id: "148I·R21", label: "an earlier day under 'on or before' is within the contract (no amendment, contract untouched); under 'on' it needs one; an amendment without proof is refused",
    run: async () => {
      const C = await import("../lib/transactions/closing-dates")
      const B = "00000000-0000-4000-8000-0000000148i1"
      const world = (terms: string) => memSupabase({ transactions: [{ id: "t-1", brokerage_id: B, status: "pending", close_date: "2026-12-15", estimated_close_date: null, contract_closing_date: "2026-12-15", contract_closing_terms: terms, contract_closing_source: "executed_contract", contract_closing_amendment_ref: null, actual_close_date: null, property_state: "TX", financing_type: "conventional", updated_at: "2026-11-01T00:00:00Z" }] })
      const a = world("on_or_before"), b = world("on"), c = world("on")
      const reason = "Buyer's lender can fund early; all parties asked"
      const r1 = await C.applyClosingDateChange(a, { brokerageId: B, transactionId: "t-1", actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason }, { ledger: passLedger as never })
      const r2 = await C.applyClosingDateChange(b, { brokerageId: B, transactionId: "t-1", actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason }, { ledger: passLedger as never })
      const r3 = await C.applyClosingDateChange(c, { brokerageId: B, transactionId: "t-1", actorUserId: "u-1", kind: "executed_amendment", date: "2026-12-08", reason }, { ledger: passLedger as never })
      const ta = rows(a, "transactions")[0], tc = rows(c, "transactions")[0]
      return {
        positive: r1.ok && r1.assessment?.withinContract === true && r1.assessment.requiresExecutedAmendment === false && /not an executed amendment/.test(r1.assessment.explanation) && ta.contract_closing_date === "2026-12-15" && ta.estimated_close_date === "2026-12-08",
        negative: r2.ok && r2.assessment?.withinContract === false && r2.assessment.requiresExecutedAmendment === true && !r3.ok && tc.contract_closing_date === "2026-12-15",
        detail: JSON.stringify({ r1: r1.ok ? r1.assessment : r1, r2: r2.ok ? r2.assessment?.requiresExecutedAmendment : r2, r3 }),
      }
    },
  },
  {
    id: "148I·C24", label: "after the human window the AI answers a status question within authority; an approval question is never answered (no model call); before the window, nothing",
    run: async () => {
      const ua = await import("../lib/communications/unattended-answer")
      const comp = (over: any = {}) => ({ id: "c-x", brokerage_id: IB, kind: "inbound_response", stage: "awaiting_human", status: "open", due_at: ago(5), context: { record_id: "m-1", channel: "sms", agent_user_id: IU, draft_id: "d-1" }, updated_at: ago(245), ...over })
      const ask = async (body: string, c: any = comp()) => {
        const db = unattendedWorld(body)
        const composed: string[] = [], sent: unknown[] = []
        const answer = ua.unattendedAnswerers({
          now: NOW, authority: async () => ({ allowed: true, reason: null }), safety: () => [],
          facts: async () => ({ facts: [{ fact: "Their transaction for 12 Elm St is Pending.", source: "transactions:t-1" }], blindSpots: [] }),
          compose: async (p) => { composed.push(p.prompt); return { object: { topic: "status", answer: "Hi Dana — your purchase of 12 Elm St is pending and on track. Your agent will follow up with anything new.", facts_used: [1], hands_back_to_agent: true, refuse: false, refuse_reason: null } as never, costUsd: 0.0004 } },
          sendSms: async (p) => { sent.push(p); return { sent: true, providerRef: "SM-1", messageId: "out-1" } },
          notify: async () => {},
        }).inbound_response!
        const r = await answer(db as never, c as never, "workflow")
        return { r, composed: composed.length, sent: sent.length }
      }
      const status = await ask("Any update on where we are with the house?")
      const approval = await ask("Can you approve the counter offer?")
      const early = await ask("Any update?", comp({ due_at: new Date(NOW.getTime() + 60_000).toISOString() }))
      return {
        positive: status.r.answered && status.r.topic === "status" && status.composed === 1 && status.sent === 1,
        negative: !approval.r.answered && approval.r.topic === "approval" && approval.composed === 0 && approval.sent === 0 && !early.r.answered && early.composed === 0,
        detail: JSON.stringify({ status: status.r.reason, approval: approval.r.reason, early: early.r.reason }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148J — provider consolidation (documents only; ruling 19)
// ═════════════════════════════════════════════════════════════════════════════
const VENDOR_FILE = /dealmachine|amcards/i
/** What an adapter would leave in code: a credential read or a call to the vendor's host — scanned on STRIPPED source. */
const ADAPTER_TRACE = /process\.env\.(DEALMACHINE_API_KEY|DEALMACHINE_WEBHOOK_SECRET|AMCARDS_ACCESS_TOKEN)\b|["'`]https?:\/\/(?:[a-z0-9-]+\.)*(?:dealmachine\.com|amcards\.com)/i
function walkCode(dir: string, out: string[] = []): string[] {
  if (!existsSync(join(ROOT, dir))) return out
  for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (d.name === "node_modules" || d.name.startsWith(".")) continue
    const p = `${dir}/${d.name}`
    if (d.isDirectory()) walkCode(p, out)
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(d.name) && !/\.d\.ts$/.test(d.name)) out.push(p)
  }
  return out
}
/** A doc names a vendor as WAITING_EXTERNAL, its credential by name, and that no adapter was built. */
const waitingExternal = (doc: string, vendor: RegExp, credential: string) => vendor.test(doc) && /WAITING_EXTERNAL/.test(doc) && doc.includes(credential) && /no adapter|adapter (?:would|only|is not)|let the adapter be built/i.test(doc)

group("148J", "DealMachine and AMcards: WAITING_EXTERNAL by name, no adapter in code", [
  {
    id: "148J·R19", label: "the commercial docs name DealMachine and AMcards as WAITING_EXTERNAL with the credential by NAME and no adapter built",
    run: async () => {
      const dm = raw("docs/commercial/DEALMACHINE-EVALUATION.md"), am = raw("docs/commercial/DIRECT-MAIL-PROVIDER-COMPARISON.md")
      return {
        positive: waitingExternal(dm, /DealMachine/, "DEALMACHINE_API_KEY") && waitingExternal(am, /AMcards/, "AMCARDS_ACCESS_TOKEN"),
        negative: !waitingExternal(dm.replace(/WAITING_EXTERNAL/g, "TODO"), /DealMachine/, "DEALMACHINE_API_KEY") && !waitingExternal(am, /AMcards/, "AMCARDS_API_KEY"),
        detail: JSON.stringify({ dm: dm.length, am: am.length }),
      }
    },
  },
  {
    id: "148J·R19", label: "NO adapter on disk: no lib/ app/ file named for either vendor, no credential read, no vendor host, no `amcards` in the direct-mail door or the channel matrix",
    run: async () => {
      const files = [...walkCode("lib"), ...walkCode("app")]
      const named = files.filter((f) => VENDOR_FILE.test(f.split("/").pop() ?? ""))
      const traced = files.filter((f) => ADAPTER_TRACE.test(code(f)))
      const doors = ["lib/providers/dispatch.ts", "lib/providers/channel-provider-matrix.ts", "lib/kernel/providers.ts"].filter((f) => /["'`]amcards["'`]/i.test(code(f)))
      const planted = ADAPTER_TRACE.test(stripComments(`const r = await fetch("https://api.dealmachine.com/v1/leads", { headers: { Authorization: process.env.DEALMACHINE_API_KEY } })`))
      const tombstone = ADAPTER_TRACE.test(stripComments(`// TOMBSTONE: process.env.AMCARDS_ACCESS_TOKEN would be read by lib/providers/amcards.ts — not built\nexport const x = 1`))
      return {
        positive: files.length > 500 && named.length === 0 && traced.length === 0 && doors.length === 0,
        negative: planted && !tombstone, // the finder sees a planted adapter and is not fooled by a comment naming one
        detail: JSON.stringify({ scanned: files.length, named, traced, doors }),
      }
    },
  },
  {
    id: "148J·R19", label: "the enforcement stands: the movement registry holds we_dealmachine WAITING_EXTERNAL / not_permitted (no automated outreach); a permitted source is not",
    run: async () => {
      const M = await import("../lib/intent/movement-source-registry")
      const dm: any = M.movementSource("we_dealmachine")
      const permitted = M.MOVEMENT_SIGNAL_SOURCES.filter((s: any) => s.licence?.collection !== "not_permitted")
      return {
        positive: !!dm && dm.status === "waiting_external" && dm.licence?.collection === "not_permitted" && dm.licence?.outreach === "none_automated",
        negative: permitted.length > 0 && permitted.every((s: any) => s.key !== "we_dealmachine") && M.movementSource("we_not_a_source") === undefined,
        detail: JSON.stringify({ status: dm?.status, licence: dm?.licence?.collection, permitted: permitted.length }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 148K — every open loop and every blind spot, waves 142–147 (ruling 18)
// ═════════════════════════════════════════════════════════════════════════════
group("148K", "the open-loop ledger: every item has a status and a proof or a reason", [
  {
    id: "148K·R18", label: "validateRow: a carried row with kind + owner + reason is valid; carried without a reason, an unknown owner, or closed with no evidence is refused",
    run: async () => {
      const K = await import("./open-loop-ledger")
      const base = { id: "147Z-SO-01", text: "the portal preference UI is not built yet", resolved: [] as any[] }
      const good = K.validateRow({ ...base, d: { s: "carried", k: "missing-wiring", o: "lane148B", r: "portal preference page wiring is lane 148B's Still open 4" } })
      const legend = K.validateRow({ ...base, d: { s: "carried", k: "missing-credentials", o: "owner", r: "[WE_CRED]" } })
      const noReason = K.validateRow({ ...base, d: { s: "carried", k: "deferred", o: "owner", r: "later" } })
      const badOwner = K.validateRow({ ...base, d: { s: "carried", k: "deferred", o: "somebody" as never, r: "deferred until the owner decides the pilot budget" } })
      const closedBare = K.validateRow({ ...base, d: { s: "closed" } })
      return { positive: good.length === 0 && legend.length === 0, negative: noReason.length > 0 && badOwner.length > 0 && closedBare.length > 0, detail: JSON.stringify({ good, legend, noReason, badOwner, closedBare }) }
    },
  },
  {
    id: "148K·R18", label: "closed-by evidence resolves on STRIPPED source: an anchor in code resolves; the same anchor only in a tombstone comment does not",
    run: async () => {
      const K = await import("./open-loop-ledger")
      const files: Record<string, string> = {
        "lib/live.ts": "export function offersFamilySearch(p: string) { return !!p }\n",
        "lib/tomb.ts": "// TOMBSTONE: offersFamilySearch moved to lib/portal/persona-config.ts\nexport const x = 1\n",
      }
      const reader = { read: (p: string) => files[p] ?? null, list: () => [] as string[] }
      const live = K.resolveEvidence("lib/live.ts#offersFamilySearch", reader)
      const tomb = K.resolveEvidence("lib/tomb.ts#offersFamilySearch", reader)
      const gone = K.resolveEvidence("lib/missing.ts#anything", reader)
      return { positive: live.ok && live.at === "lib/live.ts:1", negative: !tomb.ok && !gone.ok, detail: JSON.stringify({ live, tomb, gone }) }
    },
  },
  {
    id: "148K·R18", label: "the generated ledger's header carries the counts shape and it adds up (status totals and the per-wave table both sum to the item count)",
    run: async () => {
      const doc = raw("docs/operations/OPEN-LOOP-LEDGER.md")
      const parse = (d: string) => {
        const t = /\*\*Totals:\*\* (\d+) items · carried (\d+) · closed (\d+) · none-recorded (\d+)/.exec(d)
        const waves = [...d.matchAll(/^\| (14\d) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm)].map((m) => m.slice(2).map(Number))
        if (!t) return { ok: false, why: "no Totals line" }
        const [total, carried, closed, none] = t.slice(1).map(Number)
        const waveSum = waves.reduce((n, w) => n + w[0], 0)
        const waveRowsOk = waves.every(([items, cl, ca, no]) => cl + ca + no === items)
        return { ok: carried + closed + none === total && waves.length >= 5 && waveRowsOk && waveSum === total, why: JSON.stringify({ total, carried, closed, none, waveSum, waves: waves.length }) }
      }
      const real = parse(doc)
      const tampered = parse(doc.replace(/(\*\*Totals:\*\* \d+ items · carried )(\d+)/, (_m, a, n) => `${a}${Number(n) + 1}`))
      return { positive: real.ok, negative: !tampered.ok, detail: real.why, note: real.why }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// THE RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" WAVE 148 canaries (in-memory) — one group per lane, each canary POSITIVE + NEGATIVE")
  console.log("══════════════════════════════════════════════════════════════")
  let passed = 0, failed = 0
  const tally: string[] = []
  const failures: string[] = []
  for (const g of GROUPS) {
    console.log(`\n▶ ${g.lane} — ${g.title}${g.counted ? "" : " (not counted)"}`)
    let gp = 0, gf = 0
    for (const c of g.canaries) {
      let v: Verdict
      try { v = await c.run() } catch (e) { v = { positive: false, negative: false, detail: `THREW: ${(e as Error)?.stack ?? String(e)}` } }
      const ok = v.positive && v.negative
      if (ok) gp++; else gf++
      console.log(`  ${ok ? "✓" : "✗"} [${c.id}] ${c.label} — positive ${v.positive ? "✓" : "✗"} · negative ${v.negative ? "✓" : "✗"}`)
      if (v.note) console.log(`      note: ${v.note}`)
      if (!ok) { console.log(`      evidence: ${String(v.detail ?? "").slice(0, 1200)}`); failures.push(`[${c.id}] ${c.label}`) }
    }
    if (g.counted) { passed += gp; failed += gf }
    tally.push(` ${gf === 0 ? "PASS" : "FAIL"}  ${g.lane}  ${gp}/${g.canaries.length}${g.counted ? "" : " (not counted)"}`)
  }
  console.log("\n──────────────────────────────────────────────────────────────")
  for (const t of tally) console.log(t)
  console.log(" blind spots: memSupabase has no CHECK/FK/RLS · routes, React render and provider delivery not executed (each lane's own proof) ·")
  console.log("   lane-A half partition by a local glob matcher (test:release-blockers runs next's resolver) · assemble-email reads NEXT_PUBLIC_APP_URL")
  console.log("   inside the module (shapes asserted are base-URL independent) · lane J is a docs + absence census (no module landed)")
  if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(` RESULT: canaries ${passed} passed, ${failed} failed (${GROUPS.filter((g) => g.counted).length} lanes)`)
  console.log(failed === 0 ? "WAVE148_CANARIES_PASS" : "WAVE148_CANARIES_FAIL")
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); console.log("WAVE148_CANARIES_FAIL"); process.exit(1) })
