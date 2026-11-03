#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fixtures and fake clients, the repo's proof idiom */
/**
 * scripts/wave149-canaries.ts — `npx tsx scripts/wave149-canaries.ts` (wave 149, lane 149J2; key: test:wave149-canaries)
 * ─────────────────────────────────────────────────────────────────────────────
 * The WAVE-149 CANARIES: one group per wave-149 lane (A · B · C · D · E · F · G · H · I · J), 3–5 canaries each, run on the
 * INTEGRATED tree (lanes A–K merged). Every canary calls the lane's REAL exported survivor (imported, never re-implemented) and
 * carries BOTH halves of a measurement (CLAUDE.md §2):
 *   · POSITIVE — the contract holds on a well-formed input (the behaviour the lane built, end to end as integrated);
 *   · NEGATIVE — the same call still SEES the defect it exists to refuse (a broken finder and a clean tree both report zero;
 *     the negative half proves this one is not broken — the positive control).
 * A canary passes only when both halves pass. Labels name the lane and the contract / ruling: `[149B·C28]`, `[149A·R3]`
 * (R = owner ruling number in WAVE149_SPEC.md, where the lane's contract is a ruling rather than a C-number).
 *
 * RULES (lane 149J2 brief, the wave-148 canaries' style): pure and deterministic — no network, no Supabase, no env reads that
 * matter. Fake clients only: scripts/in-memory-supabase.ts memSupabase (it resolves refusals like supabase-js and models
 * `.select()` on writes so writers can COUNT rows). The node:module registerHooks seam stubs `server-only`, `next/cache`,
 * `@/lib/kernel/emit` (records into memory), points `@/lib/supabase/service` / `@/lib/supabase/server` at the canary's own
 * in-memory client — and at NOTHING (a throw, COUNTED) by default — and `@/lib/portal/require-contact-access` at a scripted
 * session (default: refused), so a "use server" door runs its OWN gate against a session the canary chose. Because
 * `server-only` is stubbed, no `--conditions=react-server` is needed.
 *
 * Each canary imports its modules with a dynamic `await import()` inside its own body, so one lane's broken import fails that
 * canary (with its stack), never the whole run. Fire-and-forget audit echoes that reach the throwing default client reject in
 * the background; they are COUNTED (printed in the summary), never allowed to crash the run. Output: one line per canary, a
 * per-lane tally, `RESULT: canaries N passed, M failed (10 lanes)`, and WAVE149_CANARIES_PASS / WAVE149_CANARIES_FAIL (exit 1
 * on any failure). This file never prints the chain runner's exit token.
 *
 * BLIND SPOTS (published beside the number): memSupabase enforces no CHECK / FK / RLS (m935 / m937 / m938 / m942 / m947 / m954
 * columns exist only in the fixtures); HTTP routes, React render and provider delivery are not executed (each lane's own proof
 * holds those); every model is a scripted seam (the arbiter's CHOICE is scripted — whether the live model chooses well is not
 * provable here); lane I landed documents only, so its group is a text + absence census with positive controls; the
 * journey-audit entry points are resolved statically (exported async door present in stripped source), not executed; the
 * search-visibility composer is driven through its loader over a scripted client.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

// ── the seam: no real client can ever be minted (the default throws); a canary may hand in its own in-memory one ──
const G = globalThis as any
G.__W149 = { svc: null as MemClient | null, events: [] as unknown[], mints: 0, access: null as unknown }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export function createServiceClient(){ const s = globalThis.__W149.svc; if (!s) globalThis.__W149.mints++; if (!s) throw new Error('wave149-canaries: no service client — fake clients only (hand one in)'); return s }",
  "@/lib/supabase/server": "export async function createClient(){ const s = globalThis.__W149.svc; if (!s) throw new Error('wave149-canaries: no session client — fake clients only'); return s }; export const createServerClient = createClient",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export function isKernelEventValue(){ return true }; export async function emitKernelEvent(i){ globalThis.__W149.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__W149.events.length, fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null, error: null } }",
  "@/lib/portal/require-contact-access": "export const CONTACT_SCOPE_STAFF_USER_TYPES = new Set(); export function accessRefusal(e){ return String(e) }; export async function requireContactAccess(id){ const a = globalThis.__W149.access; if (!a || a.contactId !== id) return { ok: false, error: 'unauthenticated' }; return a }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})
// The kernel's fire-and-forget echoes (audit rows, fan-outs) reach the throwing default client — counted, never fatal.
const backgroundRejections: string[] = []
process.on("unhandledRejection", (e) => { backgroundRejections.push(String((e as Error)?.message ?? e).slice(0, 160)) })
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const ROOT = process.cwd()
const raw = (p: string): string => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const code = (p: string): string => stripComments(raw(p))
const rows = (c: MemClient | any, t: string): any[] => ((c as any).tables[t] ?? []) as any[]
const NOW = new Date("2026-11-03T15:00:00Z")
const ago = (min: number, from: Date = NOW): string => new Date(from.getTime() - min * 60_000).toISOString()
/** Run with an in-memory client behind createServiceClient() / createClient(), then put the throwing default back. */
async function withSvc<T>(svc: MemClient | null, fn: () => Promise<T>, access: unknown = null): Promise<T> {
  const prev = G.__W149.svc, prevA = G.__W149.access
  G.__W149.svc = svc
  G.__W149.access = access
  try { return await fn() } finally { G.__W149.svc = prev; G.__W149.access = prevA }
}
/** Silence a module's own console noise during a call (its refusals are read from the result, not the log). */
async function quiet<T>(f: () => Promise<T>): Promise<T> {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await f() } finally { console.warn = w; console.error = e; console.log = l }
}
function walkCode(dir: string, out: string[] = []): string[] {
  if (!existsSync(join(ROOT, dir))) return out
  for (const n of readdirSync(join(ROOT, dir))) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = `${dir}/${n}`
    if (statSync(join(ROOT, p)).isDirectory()) walkCode(p, out)
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
  return out
}

/** `note` is printed on a PASS too — a measurement worth publishing beside the verdict (CLAUDE.md §2: a count that moves is the finding). */
interface Verdict { positive: boolean; negative: boolean; detail?: string; note?: string }
interface Canary { id: string; label: string; run: () => Promise<Verdict> }
interface Group { lane: string; title: string; canaries: Canary[] }
const GROUPS: Group[] = []
const group = (lane: string, title: string, canaries: Canary[]) => GROUPS.push({ lane, title, canaries })

/** A scripted arbiter model: picks `optionId` with a cited reason (the closed-menu validator's admission shape). */
type Decide = (a: { brokerageId: string; system: string; prompt: string }) => Promise<Record<string, unknown>>
const says = (optionId: string, extra: Record<string, unknown> = {}): Decide => async () => ({ optionId, channel: null, format: null, waitHours: null, rationale: `The evidence supports ${optionId} for this person right now.`, evidence: ["moment"], confidence: 0.9, ...extra })
const outage: Decide = async () => { throw new Error("gateway down") }
const recorder = (inner: Decide) => { const calls: Array<{ system: string; prompt: string }> = []; const d: Decide = async (a) => { calls.push(a); return inner(a) }; return { d, calls } }

const EVERY_PERSONA = ["first_time", "relocated", "luxury", "fsbo", "probate", "upsize", "downsize", "military", "divorce", "senior", "expired", "foreclosure", "investor"]

// ═════════════════════════════════════════════════════════════════════════════
// 149A — every persona is an audience basis; wording + platform rules + consent/suppression stay; contact intent (C26, R1–R3)
// ═════════════════════════════════════════════════════════════════════════════
const AB = "00000000-0000-4000-8000-0000000149a1", AB2 = "00000000-0000-4000-8000-0000000149a2"
group("149A", "every persona is an audience basis; ad wording and Meta's housing delivery rules still refuse; suppression floors the upload", [
  {
    id: "149A·C26", label: "EVERY situation persona plans a Meta persona audience and passes the persona gate; only `other` / an off-vocabulary spelling is refused, and a lookalike is explained, never built",
    run: async () => {
      const pa = await import("../lib/ads/persona-audience")
      const basis = await import("../lib/ads/audience-persona-basis")
      const plans = EVERY_PERSONA.map((p) => ({ p, plan: pa.planPersonaAudience({ persona: p, platform: "facebook" }), gate: basis.resolveAudiencePersonaBasis({ type: "persona_segment", basis: "derived_persona", filters: { personas: [p] } } as never) }))
      const refused = plans.filter((x) => !x.plan.ok || !x.gate.ok).map((x) => x.p)
      const other = pa.planPersonaAudience({ persona: "other", platform: "facebook" })
      const offVocab = pa.planPersonaAudience({ persona: "first_time_buyer", platform: "facebook" })
      const lk = pa.planPersonaAudience({ persona: "senior", platform: "facebook", lookalike: true })
      const li = pa.planPersonaAudience({ persona: "senior", platform: "linkedin" })
      return {
        positive: refused.length === 0 && plans.every((x) => x.plan.ok && x.plan.audienceType === "persona_segment") && basis.ADS_INELIGIBLE_PERSONAS.every((p) => p === "other"),
        negative: !other.ok && !offVocab.ok && !lk.ok && lk.refusalKind === "platform_housing_rule" && /Special Ad Category/.test(lk.refusal) && !li.ok && li.refusalKind === "platform_unsupported" && /connector/.test(li.refusal),
        detail: JSON.stringify({ refused, ineligible: basis.ADS_INELIGIBLE_PERSONAS, lk: (lk as any).refusalKind, li: (li as any).refusalKind }),
        note: `${EVERY_PERSONA.length} situation personas planned on Meta; ineligible personas: ${JSON.stringify(basis.ADS_INELIGIBLE_PERSONAS)}`,
      }
    },
  },
  {
    id: "149A·R1", label: "the ad WORDING is still scanned and Meta's housing delivery rules still refuse age / gender / ZIP / sub-15-mile radius — a clean persona ad is ready",
    run: async () => {
      const fh = await import("../lib/compliance-rules/fair-housing-patterns")
      const proxy = await import("../lib/compliance-rules/audience-compliance")
      const payload = await import("../lib/ads/connectors/ad-payload")
      const { LOOKALIKE_AD_POLICY } = await import("../lib/kernel/lookalike-research")
      const base = (t: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
        platform: "facebook", objective: "leads", campaignName: "First-time buyer class", dailyBudgetUsd: 40, pageId: "p1", leadFormId: "f1",
        creative: { headline: "Your first home, step by step", primaryText: "A free class on budgets, pre-approval and offers.", mediaAssetUrl: "https://x/y.jpg", destinationUrl: "https://x/lp" },
        targeting: { locations: [{ city: "Austin", state: "TX", radiusMiles: 20 }], audienceExternalIds: ["fb-ft"], inclusionGovernance: "gated", ...t }, specialAdCategory: "HOUSING", ...over,
      }) as any
      const clean = payload.validateAdReadiness(base())
      const v = (t: Record<string, unknown>) => payload.validateAdReadiness(base(t)).violations
      return {
        positive: clean.ready && clean.violations.length === 0 && fh.detectFairHousingViolations("Your first home, step by step — a free class on budgets and offers").length === 0 && proxy.audienceProxyHits("first-time buyers").length === 0,
        negative: v({ ageMin: 25 }).some((x) => /age/.test(x)) && v({ genders: ["female"] }).some((x) => /gender/.test(x)) && v({ locations: [{ zip: "78701" }] }).some((x) => /ZIP/.test(x)) && v({ locations: [{ city: "Austin", state: "TX", radiusMiles: 5 }] }).some((x) => /15 miles/.test(x))
          && fh.detectFairHousingViolations("perfect for families").length > 0 && fh.detectFairHousingViolations("ideal for retirees").length > 0 && LOOKALIKE_AD_POLICY.lookalike_model_available_for_housing === false,
        detail: JSON.stringify({ clean: clean.violations, age: v({ ageMin: 25 }), zip: v({ locations: [{ zip: "78701" }] }) }),
      }
    },
  },
  {
    id: "149A·C26", label: "createPersonaAudience → the Ads Manager survivor (draft, attributed, ledgered); the upload population is tagged + consented + UNSUPPRESSED + this tenant only",
    run: async () => {
      const pa = await import("../lib/ads/persona-audience")
      const kads = await import("../lib/kernel/ads")
      const db = memSupabase({
        contacts: [
          { id: "ct-ft1", brokerage_id: AB, email: "ft1@x.test", tcpa_consent: true, contact_persona: "first_time" },
          { id: "ct-ft2", brokerage_id: AB, email: "ft2@x.test", tcpa_consent: true, contact_persona: "first_time" },
          { id: "ct-ft3", brokerage_id: AB, email: "ft3@x.test", tcpa_consent: false, contact_persona: "first_time" },
          { id: "ct-ft4", brokerage_id: AB, email: "ft4@x.test", tcpa_consent: true, contact_persona: "first_time", email_unsubscribed: true },
          { id: "ct-ft5", brokerage_id: AB, email: "ft5@x.test", tcpa_consent: true, contact_persona: "first_time" },
          { id: "ct-dv1", brokerage_id: AB, email: "dv1@x.test", tcpa_consent: true, contact_persona: "divorce" },
          { id: "ct-ft6", brokerage_id: AB2, email: "ft6@x.test", tcpa_consent: true, contact_persona: "first_time" },
        ],
        contact_suppression_list: [{ id: "sup-1", brokerage_id: AB, email: "FT5@x.test", channel: "email", suppression_reason: "unsubscribe" }],
      })
      return withSvc(db, async () => quiet(async () => {
        const made = await pa.createPersonaAudience({ tenant: { brokerageId: AB }, creator: { userId: "u-149a" }, persona: "first_time", platform: "facebook" })
        const aud = rows(db, "facebook_custom_audiences").find((r) => r.id === made.audienceId)
        const prev = await kads.previewAudienceResolution({ ctx: { brokerageId: AB, userId: "u-149a", agentId: "" }, audienceId: made.audienceId! })
        const resolved = (prev as any).audience?.resolvedCount
        const divorce = await pa.createPersonaAudience({ tenant: { brokerageId: AB }, creator: { userId: "u-149a" }, persona: "divorce", platform: "google", derived: true })
        const noTenant = await pa.createPersonaAudience({ tenant: { brokerageId: "" }, creator: { userId: "u-149a" }, persona: "first_time", platform: "facebook" })
        return {
          positive: made.ok && aud?.brokerage_id === AB && aud?.status === "draft" && aud?.audience_type === "persona_segment" && aud?.agent_user_id === "u-149a" && made.attribution?.creatorUserId === "u-149a"
            && rows(db, "agent_action_ledger").some((l) => l.action === "ads.persona_audience.create" && l.status === "executed") && divorce.ok,
          negative: prev.success && resolved === 2 && !noTenant.ok, // ft3 unconsented, ft4 unsubscribed, ft5 on the suppression list, ft6 another tenant — all out
          detail: JSON.stringify({ made: made.ok, err: made.error, resolved, prev: (prev as any).error, divorce: divorce.ok }),
          note: `upload population: ${resolved} of 5 first-time rows in this tenant (1 unconsented, 1 unsubscribed, 1 suppressed; 1 other-tenant row never read)`,
        }
      }))
    },
  },
  {
    id: "149A·R3", label: "contact_type is buyer | seller | both + the relationship classes — never lead / prospect; m935's CHECK says the same; every intent spelling reads onto the three",
    run: async () => {
      const T = await import("../lib/contact-types")
      const sql = raw("supabase/migrations/m935-contact-intent-is-buyer-seller-both.sql").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
      const checkList = (/CHECK \(contact_type = ANY \(ARRAY\[([\s\S]*?)\]/.exec(sql)?.[1]?.match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1))
      const union = [...T.CONTACT_INTENTS, ...T.RELATIONSHIP_CONTACT_TYPES].sort()
      const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
      const cached = ((CHECK_VOCABULARIES as any).contacts?.contact_type ?? []) as string[]
      return {
        positive: JSON.stringify([...T.CONTACT_TYPES].sort()) === JSON.stringify(union) && JSON.stringify([...checkList].sort()) === JSON.stringify(union)
          && JSON.stringify([...T.CONTACT_INTENTS]) === JSON.stringify(["buyer", "seller", "both"]) && T.normalizeContactIntent("Buying and selling") === "both" && T.normalizeContactIntent("selling") === "seller",
        negative: !(T.CONTACT_TYPES as readonly string[]).includes("lead") && !(T.CONTACT_TYPES as readonly string[]).includes("prospect") && !checkList.includes("prospect")
          && T.normalizeContactIntent("prospect") === null && T.normalizeContactIntent("lead") === null && T.contactIntentOf("sphere") === null && T.canonicalContactType("prospect") === null,
        detail: JSON.stringify({ types: T.CONTACT_TYPES, checkList }),
        note: `m935 CHECK ${checkList.length} values = code; generated cache check-vocabularies.ts contacts.contact_type still lists ${cached.filter((c) => c === "lead" || c === "prospect").join("+") || "neither lead nor prospect"} (regeneration is the integrator's — not asserted here)`,
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149B — collaborative search (C28), the buyer-stated lot minimum (C27), the persona → portal layout (R2)
// ═════════════════════════════════════════════════════════════════════════════
const BBRK = "11111111-1111-4111-8111-111111111149", BOTHER = "22222222-2222-4222-8222-222222222149"
const BBUYER = "33333333-3333-4333-8333-333333333149", BOTHERBUYER = "44444444-4444-4444-8444-444444444149", BUSER = "55555555-5555-4555-8555-555555555149"
const B_SECRET = "SECRET-CRITERIA-149-must-not-leak"
function shareWorld(): MemClient {
  return memSupabase({
    contacts: [
      { id: BBUYER, brokerage_id: BBRK, first_name: "Dana", last_name: "Reyes", email: "dana@example.com", phone: "+15125550100", notes: "PRIVATE-CRM-NOTE-149" },
      { id: BOTHERBUYER, brokerage_id: BOTHER, first_name: "Other", email: "other@example.com" },
    ],
    saved_properties: [
      { id: "sp1", brokerage_id: BBRK, contact_id: BBUYER, listing_id: "L-1", property_address: "12 Elm St", city: "Frisco", state: "TX", list_price: 640000, bedrooms: 3, bathrooms: 2, sqft: 2100, notes: "BUYER-PRIVATE-NOTE", ai_match_score: 91, dismissed: false },
      { id: "sp2", brokerage_id: BBRK, contact_id: BBUYER, external_property_id: "ext_rentcast_9", property_address: "9 Oak Ct", city: "Plano", state: "TX", list_price: 590000, dismissed: false },
      { id: "sp3", brokerage_id: BBRK, contact_id: BBUYER, listing_id: "L-UNSHARED", property_address: "5 Unshared Ln", dismissed: false },
      { id: "sp4", brokerage_id: BOTHER, contact_id: BOTHERBUYER, listing_id: "L-OTHER", property_address: "77 Other Tenant Way", dismissed: false },
    ],
    collaborative_searches: [{ id: "cs-other", brokerage_id: BOTHER, contact_id: BOTHERBUYER, name: "Other", status: "active", search_criteria: { secret: B_SECRET }, created_at: "2026-10-01T00:00:00Z" }],
    collaborative_search_members: [],
    collaborative_search_properties: [{ id: "csp-other", collaborative_search_id: "cs-other", property_mls_id: "L-OTHER", property_data: { address: "77 Other Tenant Way" }, status: "active" }],
    property_family_ratings: [], property_consensus: [],
  }, { stampCreatedAt: true, uuidIds: true })
}
let bTok = 0
const shareDeps = () => ({ checkSuppression: async () => ({ suppressed: false }), sendEmailInvite: async () => ({ ok: true }), tokenFactory: () => `tok149-${++bTok}-${"x".repeat(40)}` })
async function shareTwo(db: MemClient) {
  const share = await import("../lib/portal/collaborative-share")
  return share.shareCollection(db as never, { brokerageId: BBRK, buyerContactId: BBUYER, actorUserId: BUSER, listingRefs: ["L-1", "ext_rentcast_9", "L-OTHER"], collaborator: { name: "Mom", email: "mom@example.com" }, scope: "feedback_only", now: NOW }, shareDeps() as never)
}

group("149B", "the collaborator sees only what was shared, feedback reaches the buyer, the Shopping Agent reads it only on consent; lot minimum; layouts", [
  {
    id: "149B·C28", label: "the collaborator view holds ONLY the two shared homes (never the unshared saved home, another tenant's, the criteria, CRM notes or the buyer's contact fields)",
    run: async () => {
      const share = await import("../lib/portal/collaborative-share")
      const db = shareWorld()
      const r = await shareTwo(db)
      const search = rows(db, "collaborative_searches").find((s) => r.ok && s.id === r.searchId)
      if (search) search.search_criteria = { secret: B_SECRET }
      const v = r.ok ? await share.collaboratorView(db as never, r.token, NOW) : { ok: false as const, error: "no share" }
      const vj = JSON.stringify(v)
      const editor = r.ok ? rows(db, "collaborative_search_members").find((m) => m.id === r.memberId) : null
      if (editor) editor.scope = "editor"
      const outOfScope = r.ok ? await share.collaboratorView(db as never, r.token, NOW) : { ok: true }
      if (editor) editor.scope = "feedback_only"
      const expired = r.ok ? await share.collaboratorView(db as never, r.token, new Date(NOW.getTime() + 8 * 86_400_000)) : { ok: true }
      const badScope = await share.shareCollection(db as never, { brokerageId: BBRK, buyerContactId: BBUYER, actorUserId: BUSER, listingRefs: ["L-1"], collaborator: { name: "X", email: "x@example.com" }, scope: "editor" as never, now: NOW }, shareDeps() as never)
      return {
        positive: r.ok && r.sharedHomeIds.length === 2 && v.ok && v.view.homes.length === 2 && v.view.buyerFirstName === "Dana",
        negative: !vj.includes(B_SECRET) && !vj.includes("PRIVATE-CRM-NOTE-149") && !vj.includes("5 Unshared Ln") && !vj.includes("77 Other Tenant Way") && !vj.includes("dana@example.com") && !vj.includes("Reyes")
          && JSON.stringify((db as any).tables).includes(B_SECRET) && !outOfScope.ok && !expired.ok && !badScope.ok,
        detail: JSON.stringify({ r: r.ok ? r.sharedHomeIds.length : r, homes: v.ok ? v.view.homes.map((h) => h.facts.address) : v }),
      }
    },
  },
  {
    id: "149B·C28", label: "the collaborator's opinion reaches the BUYER by name, keyed by the member the token proves; an opinion on a home not shared with them is refused",
    run: async () => {
      const share = await import("../lib/portal/collaborative-share")
      const db = shareWorld()
      const r = await shareTwo(db)
      if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r) }
      const v = await share.collaboratorView(db as never, r.token, NOW)
      const homeId = v.ok ? v.view.homes.find((h) => h.facts.address === "12 Elm St")?.id ?? "" : ""
      const signals: any[] = []
      const opDeps = { tellShoppingAgent: async (p: any) => { signals.push(p); return true } }
      const op = await share.recordCollaboratorOpinion(db as never, r.token, { sharedHomeId: homeId, vote: "love", comment: "The yard is perfect for the dog" }, opDeps as never, NOW)
      const d = await share.buyerFeedbackDigest(db as never, { brokerageId: BBRK, contactId: BBUYER, now: NOW })
      const foreign = await share.recordCollaboratorOpinion(db as never, r.token, { sharedHomeId: "csp-other", vote: "like" }, opDeps as never, NOW)
      const otherTenant = await share.buyerFeedbackDigest(db as never, { brokerageId: BOTHER, contactId: BBUYER, now: NOW })
      return {
        positive: op.ok && d.ok && d.digest.homes.some((h) => h.address === "12 Elm St" && h.opinions.some((o) => o.by === "Mom" && o.vote === "love" && /dog/.test(o.comment ?? ""))) && rows(db, "property_family_ratings").some((x) => x.member_id === r.memberId && x.brokerage_id === BBRK),
        negative: !foreign.ok && (!otherTenant.ok || otherTenant.digest.homes.every((h) => h.opinions.length === 0)),
        detail: JSON.stringify({ op, digest: d.ok ? d.digest.homes : d, foreign }),
      }
    },
  },
  {
    id: "149B·C28", label: "the Shopping Agent reads family opinions ONLY after the buyer's yes (recorded with who + when); before it, nothing — and an unreadable digest fails closed",
    run: async () => {
      const share = await import("../lib/portal/collaborative-share")
      const db = shareWorld()
      const r = await shareTwo(db)
      if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r) }
      const v = await share.collaboratorView(db as never, r.token, NOW)
      const homeId = v.ok ? v.view.homes[0]?.id ?? "" : ""
      const signals: any[] = []
      await share.recordCollaboratorOpinion(db as never, r.token, { sharedHomeId: homeId, vote: "pass", comment: "Road noise" }, { tellShoppingAgent: async (p: any) => { signals.push(p); return true } } as never, NOW)
      const before = await share.familyFeedbackForShoppingAgent(db as never, { brokerageId: BBRK, contactId: BBUYER })
      const yes = await share.setFamilyFeedbackForShoppingAgent(db as never, { brokerageId: BBRK, contactId: BBUYER, allow: true, actorUserId: BUSER, now: NOW })
      const after = await share.familyFeedbackForShoppingAgent(db as never, { brokerageId: BBRK, contactId: BBUYER })
      const search = rows(db, "collaborative_searches").find((s) => s.id === r.searchId)
      const shut = memSupabase({ collaborative_searches: [{ id: "s", brokerage_id: BBRK, contact_id: BBUYER, status: "active", feedback_for_shopping_agent: true }] }, { refuse: { collaborative_search_members: "permission denied" } })
      const closed = await share.familyFeedbackForShoppingAgent(shut as never, { brokerageId: BBRK, contactId: BBUYER })
      return {
        positive: yes.ok && search?.feedback_consent_by_user_id === BUSER && !!search?.feedback_consent_at && after.consented && after.opinions.length === 1,
        negative: !before.consented && before.opinions.length === 0 && signals.length === 1 && !/Road noise/.test(signals[0].message) && signals[0].payload?.feedback_consented === false && !closed.consented && closed.opinions.length === 0,
        detail: JSON.stringify({ before, after, signal: signals[0], closed }),
      }
    },
  },
  {
    id: "149B·C27", label: "the lot minimum is the BUYER's (their number, their unit, their words); 'a big yard' invents none, a maximum is not a minimum, an AI-stated one fails the contract",
    run: async () => {
      const { extractLifestyleAsks } = await import("../lib/buyer-search/conversation-criteria")
      const E = await import("../lib/buyer-search/explanation-evidence")
      const lm = (s: string) => extractLifestyleAsks(s).find((a: any) => a.kind === "outdoor_space")?.lotMinimum ?? null
      const two = lm("we want at least 2 acres"), sq = lm("a 10,000 sq ft lot"), half = lm("half an acre would be lovely")
      return {
        positive: two?.value === 2 && two.unit === "acres" && two.stated_by === "buyer" && /2 acres/.test(two.literal) && sq?.unit === "sqft" && sq.value === 10000 && half?.value === 0.5
          && [two, sq, half].every((m) => E.validLotMinimum(m)) && E.formatLotMinimum(sq!) === "10,000 sq ft",
        negative: lm("a big yard for the kids") === null && lm("no more than 2 acres") === null && lm("a 2,000 sq ft home with a yard") === null
          && !E.validLotMinimum({ value: 1, unit: "acres", stated_by: "ai", literal: "x", confidence: "high" }) && !E.validLotMinimum({ value: 1, unit: "hectares", stated_by: "buyer", literal: "x", confidence: "high" }),
        detail: JSON.stringify({ two, sq, half }),
      }
    },
  },
  {
    id: "149B·R2", label: "EVERY stored persona (the live CHECK cache) resolves to its OWN portal layout on the buyer side; the old direct lookup (military → first-time buyer) is caught",
    run: async () => {
      const P = await import("../lib/portal/persona-config")
      const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
      const stored = ((CHECK_VOCABULARIES as any).contacts?.contact_persona ?? []) as string[]
      const key = (p: string, side: "buyer" | "seller" = "buyer") => P.getPersonaConfig(p, side).id
      const own = stored.filter((p) => p !== "other")
      const misrouted = own.filter((p) => !(P.PERSONA_CONFIGS as any)[key(p)] || (key(p) === "first_time_buyer" && p !== "first_time"))
      const direct = (k: string) => ((P.PERSONA_CONFIGS as any)[k] ?? P.PERSONA_CONFIGS.first_time_buyer).id
      return {
        positive: stored.length >= 14 && misrouted.length === 0 && Object.keys(P.PERSONA_CONFIGS).every((k) => key(k) === k) && key("luxury", "seller") === "luxury_seller",
        negative: direct("military") === "first_time_buyer" && key("military") !== "first_time_buyer" && key("a-persona-the-business-adds") === "first_time_buyer",
        detail: JSON.stringify({ misrouted, map: own.map((p) => `${p}→${key(p)}`) }),
        note: `${own.length} stored personas → ${new Set(own.map((p) => key(p))).size} distinct layouts (${Object.keys(P.PERSONA_CONFIGS).length} layouts defined)`,
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149C — arbiter-owned timing (C29) and the unattended answer through the arbiter (R8)
// ═════════════════════════════════════════════════════════════════════════════
const CB1 = "11111111-1111-4111-8111-1111111111c9", CC1 = "c1c1c1c1-0000-4000-8000-0000000001c9", CU1 = "a2a2a2a2-0000-4000-8000-0000000002c9"
const cdb = (extra: Record<string, any[]> = {}) => memSupabase({
  brokerages: [{ id: CB1, ai_isa_system_user_id: null }], brokerage_settings: [], agent_action_ledger: [], manager_completions: [], notifications: [], activities: [],
  outcome_reconciliations: [], self_heal_events: [], platform_settings: [], connector_healing_proposals: [], smart_assistant_suggestions: [], ai_message_drafts: [],
  ...extra,
}, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], manager_completions: [["idempotency_key"]] } })

group("149C", "the six planners pass ONE arbiter door; no fixed schedule gates a touch; the unattended answer decides through the arbiter", [
  {
    id: "149C·C29", label: "the six planners lane 148Z named (+ sequence step + unattended answer) each have a door that CALLS its arbiter in stripped source; a mention in a comment is not a call",
    run: async () => {
      const arb = await import("../lib/ai-isa/followup-arbiter")
      const SIX = ["adaptive_reengagement", "next_best_touch", "stale_contact_detector", "saved_home_nudge", "ghost_escalation", "lead_nurture"]
      const table = arb.ARBITER_PLANNER_ENTRY_POINTS as Record<string, { door: string; via: string }>
      const callsVia = (src: string, via: string) => new RegExp(`\\b${via}\\s*\\(`).test(src)
      const unwired = Object.entries(table).filter(([, e]) => !callsVia(code(e.door), e.via)).map(([k]) => k)
      return {
        positive: SIX.every((k) => !!table[k]) && !!table.unattended_answer && unwired.length === 0,
        negative: callsVia("await arbitratePlannedTouch(svc, {", "arbitratePlannedTouch") && !callsVia(stripComments("// await arbitratePlannedTouch(svc) decides"), "arbitratePlannedTouch"),
        detail: JSON.stringify({ keys: Object.keys(table), unwired }),
        note: `${Object.keys(table).length} planner entry points, ${Object.keys(table).length - unwired.length} wired through the arbiter`,
      }
    },
  },
  {
    id: "149C·C29", label: "no fixed schedule gates a touch: the arbiter's on-menu choice is honoured and LEDGERED; an off-menu pick keeps the planner's verdict; the old `if (!cadence.shouldSend)` gate is gone",
    run: async () => {
      const arb = await import("../lib/ai-isa/followup-arbiter")
      const { platformFollowupPolicy } = await import("../lib/ai-isa/followup-policy")
      const policy = platformFollowupPolicy()
      const w = cdb()
      const opts = [{ id: "a", kind: "communication" as const, channels: ["email" as const], why: ["x"] }, { id: "b", kind: "agent_intervention" as const, channels: ["human_task" as const], why: ["y"] }]
      const base = { brokerageId: CB1, planner: "saved_home_nudge" as const, subject: { type: "contact" as const, id: CC1 }, now: NOW, options: opts, planned: "a", moment: { key: "k", intent: "i" }, policy }
      const ok = await arb.arbitratePlannedTouch(w as never, base as never, { decide: says("b") as never })
      const off = await arb.arbitratePlannedTouch(w as never, { ...base, now: new Date(NOW.getTime() + 60_000) } as never, { decide: says("z") as never })
      const down = await arb.arbitratePlannedTouch(w as never, { ...base, planner: "lead_nurture", now: new Date(NOW.getTime() + 120_000) } as never, { decide: outage as never })
      const gr = code("lib/ai-isa/ghost-reengagement.ts")
      const GATE = /if\s*\(\s*!cadence\.shouldSend\s*\)/
      return {
        positive: ok.choice === "b" && ok.decision.source === "ai" && ok.recorded && rows(w, "agent_action_ledger").some((r) => String(r.action).startsWith("followup.decision.")) && !GATE.test(gr) && gr.length > 0,
        negative: off.choice === "a" && off.decision.source === "deterministic" && down.choice === "a" && GATE.test("if (!cadence.shouldSend) { return skip() }"),
        detail: JSON.stringify({ ok: ok.choice, off: off.choice, down: down.choice, gate: GATE.test(gr) }),
      }
    },
  },
  {
    id: "149C·R8", label: "the unattended answer decides through the ARBITER and answers on the client's own channel — text, email AND portal; the arbiter may keep it for a person; money is never answered",
    run: async () => {
      const ua = await import("../lib/communications/unattended-answer")
      const comp = (channel: string) => ({ id: "c-x", brokerage_id: CB1, kind: "inbound_response", stage: "awaiting_human", status: "open", due_at: ago(5), context: { record_id: "m-1", channel, agent_user_id: CU1, draft_id: "d-1" }, updated_at: ago(245) }) as never
      const facts = async () => ({ facts: [{ fact: "Their transaction for 12 Elm St is Pending (stage: appraisal).", source: "transactions:t-1" }], blindSpots: [] })
      const run = async (body: string, channel: string, decide: Decide) => {
        const db = cdb({
          ai_message_drafts: [{ id: "d-1", brokerage_id: CB1, source_message_id: "m-1", status: "pending", acted_at: null }],
          messages: [{ id: "m-1", brokerage_id: CB1, direction: "inbound", conversation_id: "conv-1", contact_id: CC1, body, metadata: { channel, subject: "Our closing" }, created_at: ago(300) }],
          contacts: [{ id: CC1, brokerage_id: CB1, first_name: "Dana", agent_id: "ag-1", dnc_status: false, ai_outreach_paused: false, source: "website", created_at: ago(60 * 24 * 30) }],
        })
        const sent: Record<string, any[]> = { sms: [], email: [], portal: [] }
        const dec = recorder(decide)
        let composed = 0
        const answer = ua.unattendedAnswerers({
          now: NOW, decide: dec.d as never, facts, authority: async () => ({ allowed: true, reason: null }), safety: () => [],
          compose: async () => { composed++; return { object: { topic: "status" as const, answer: "Hi Dana — your purchase of 12 Elm St is in the appraisal stage. Your agent will follow up with anything new.", facts_used: [1], hands_back_to_agent: true, refuse: false, refuse_reason: null } } },
          sendSms: async (p: any) => { sent.sms.push(p); return { sent: true, providerRef: "SM-1", messageId: "o-1" } },
          sendEmail: async (p: any) => { sent.email.push(p); return { sent: true, providerRef: "EM-1", messageId: "o-2" } },
          postPortal: async (p: any) => { sent.portal.push(p); return { sent: true, providerRef: null, messageId: "pm-1" } },
          notify: async () => {},
        } as never).inbound_response!
        const r = await quiet(() => answer(db as never, comp(channel), "workflow"))
        return { r, sent, dec, composed }
      }
      const W = says("answer_written")
      const sms = await run("Any update on where we are with the house?", "sms", W)
      const email = await run("Any update on where we are with the house?", "email", W)
      const portal = await run("Any update on where we are with the house?", "in_app", W)
      const held = await run("Any update on where we are with the house?", "sms", says("hold_for_person"))
      const money = await run("Can we offer $425k?", "sms", W)
      const asked = [sms, email, portal].every((x) => x.dec.calls.length === 1 && x.dec.calls[0].system === ua.ARBITER_UNATTENDED_SYSTEM)
      return {
        positive: asked && sms.r.answered && sms.sent.sms.length === 1 && email.r.answered && email.sent.email.length === 1 && email.sent.sms.length === 0 && portal.r.answered && portal.sent.portal.length === 1 && portal.r.channel === "in_app",
        negative: !held.r.answered && held.composed === 0 && held.sent.sms.length === 0 && !money.r.answered && money.composed === 0 && money.sent.sms.length === 0,
        detail: JSON.stringify({ sms: sms.r, email: email.r, portal: portal.r, held: held.r.reason, money: money.r.reason }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149D — the lead-magnet package in the owner's order (C30; rulings 9–12, 16)
// ═════════════════════════════════════════════════════════════════════════════
const DB1 = "00000000-0000-4000-8000-0000000149d1", DB2 = "00000000-0000-4000-8000-0000000149d2"
const DAG = "00000000-0000-4000-8000-00000149d0a1", DAG2 = "00000000-0000-4000-8000-00000149d0a2"
const DU1 = "00000000-0000-4000-8000-00000149d0b1", DU2 = "00000000-0000-4000-8000-00000149d0b2"
const ORIGIN = "https://app.example.com"
function dWorld(extra: Record<string, any[]> = {}): MemClient {
  const db = memSupabase({
    brokerages: [{ id: DB1, name: "Elm Realty", slug: "elm-realty", deleted_at: null }, { id: DB2, name: "Oak Team", slug: "oak-team", deleted_at: null }],
    agents: [{ id: DAG, brokerage_id: DB1, user_id: DU1, is_active: true }, { id: DAG2, brokerage_id: DB2, user_id: DU2, is_active: true }],
    users: [{ id: DU1, brokerage_id: DB1, first_name: "Ann", user_type: "agent" }, { id: DU2, brokerage_id: DB2, first_name: "Oli", user_type: "team_lead" }],
    calendar_provider_accounts: [], campaign_sequences: [], campaign_sequence_steps: [], market_data: [],
    farm_territories: [{ id: "ft-1", brokerage_id: DB1, name: "South Austin", city: "Austin", state: "TX", zip_codes: ["78704"], agent_id: DAG, is_active: true }],
    conversation_insights: [
      { id: "ci-1", brokerage_id: DB1, conversation_id: "cv-1", unresolved_questions: ["Do I need to go through probate before I can sell?"], created_at: NOW.toISOString() },
      { id: "ci-2", brokerage_id: DB1, conversation_id: "cv-2", unresolved_questions: ["Do I need to go through probate before I can sell?"], created_at: NOW.toISOString() },
    ],
    tenant_custom_domains: [], qr_codes: [], keyword_intelligence: [], ai_search_citation_observations: [], brokerage_settings: [],
    lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_funnel_items: [], lead_magnet_promises: [], ai_video_projects: [],
    agent_action_ledger: [], lifecycle_events: [], notifications: [], tasks: [], manager_signals: [], generated_documents: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true })
  ;(db as any).rpc = async () => ({ data: null, error: null })
  return db
}
const D_CHECKLIST = {
  insufficient: false, insufficient_reason: null, title: "The Inherited-Home Sale Checklist", intro: "The steps to sell an inherited home, in order, at your pace.",
  sections: [
    { heading: "Before anything is listed", items: [{ text: "Confirm who has authority to sell", why: "title companies ask first" }, { text: "Secure and insure the property", why: "a vacant home needs care" }, { text: "Gather the deed and recent bills", why: "it speeds every next step" }] },
    { heading: "Getting it ready", items: [{ text: "Decide what stays and what goes", why: "it frames the timeline" }, { text: "Ask for a no-pressure value review", why: "so the price is grounded" }, { text: "Ask your agent how sales work locally", why: "rules vary by state" }] },
  ],
  closing: "Questions? Reply any time — I'm happy to help.",
}
const D_PLAN = {
  insufficient: false, insufficient_reason: null,
  name: "Selling an Inherited Home, Step by Step", magnet_type: "seller_guide",
  big_promise: "Know every step to sell an inherited home without guesswork",
  angle: "Families are asking whether probate must finish before a sale", awareness_stage: "problem_aware",
  landing: { headline: "Selling an inherited home: the steps, in order", subhead: "A one-page checklist and a short video for families handling an estate property.", cta: "Send my checklist", description: "Practical steps from Elm Realty.", faq: [] },
  situation_keys: ["timeline", "move_side", "property_address"],
  extra_questions: [{ label: "Any other questions for us?", type: "textarea", options: [] }],
  deliverables: [
    { key: "estate_checklist", kind: "checklist", role: "primary", title: "The Inherited-Home Sale Checklist", promise_line: "The Inherited-Home Sale Checklist — every step on one page", outline: ["authority to sell", "securing the home", "pricing"], why: "a quick, specific win first" },
    { key: "estate_video", kind: "video", role: "deliverable", title: "What happens when you sell an estate home", promise_line: "A short video walkthrough", outline: ["authority", "timeline in general terms"], why: "authority" },
    { key: "first_chat", kind: "consultation", role: "deliverable", title: "A no-pressure first conversation", promise_line: "Book now", outline: [], why: "commitment" },
  ],
  thank_you: { headline: "Your checklist is on its way", message: "Day 3 you'll get our next tip, then every week a new one.", next_step_line: "Want a hand? Ann is happy to help." },
  steps: { personal_video: false, calendar_link: false, portal_task: null, education_sequence: false },
  follow_up: { first_value_moment: "the checklist arrives", signals_to_watch: ["opened the checklist"], handoff_when: "they ask about a sale" },
  learning: { hypothesis: "estate families convert on a one-page plan", primary_metric: "visit_to_submit" },
}
function dSeams(db: any) {
  const events: Array<{ ev: string; at: number }> = []
  const projectFor = new Map<string, string>()
  let n = 0
  const deps: any = {
    now: NOW, client: db,
    entitlement: async () => ({ allowed: true, reason: "ok" }),
    plan: async () => { events.push({ ev: "plan", at: db.writes.length }); return D_PLAN },
    writeChecklist: async () => { events.push({ ev: "checklist_written", at: db.writes.length }); return D_CHECKLIST },
    finalize: async (a: any) => ({ ok: true, texts: a.texts }),
    renderDocument: async () => { n++; events.push({ ev: "checklist_rendered", at: db.writes.length }); return { ok: true, pdfUrl: `https://cdn.example.com/client-docs/d1/checklist-${n}.pdf`, documentId: null, error: null } },
    writeVideoScript: async () => ({ insufficient: false, insufficient_reason: null, title: "What happens when you sell an estate home", script: "Hi, I'm Ann with Elm Realty. Selling a home you inherited usually starts with confirming who can sign, then caring for the property, then pricing it with care. Here is what that looks like in general terms, and what to ask your attorney. Reply any time — I'm happy to help. Elm Realty.", on_screen: ["Authority", "Care", "Price"] }),
    commissionVideo: async (a: any) => {
      events.push({ ev: "video_commissioned", at: db.writes.length })
      let id = projectFor.get(a.discriminator)
      if (!id) { id = randomUUID(); projectFor.set(a.discriminator, id); db.tables.ai_video_projects.push({ id, brokerage_id: DB1, agent_id: DAG, video_type: "education", status: "pending_review", approval_status: "pending_review", compliance_status: "pending", video_url: null, is_published: false, video_metadata: {} }) }
      return { ok: true, status: "staged", videoProjectId: id }
    },
    draftBrand: async () => ({}),
  }
  deps.deliverable = { now: NOW, funnel: deps }
  const mint = async (args: any, svc: any) => {
    const existing = rows(svc, "qr_codes").find((q) => q.label === args.label && q.brokerage_id === args.brokerageId)
    if (existing) return { qrCodeId: existing.id, slug: existing.slug, scanUrl: `${ORIGIN}/api/qr/scan?slug=${existing.slug}`, targetUrl: existing.target_url, qrCodeDataUrl: "data:image/png;base64,AAAA" }
    const id = randomUUID(), slug = `qr-${rows(svc, "qr_codes").length + 1}`
    svc.tables.qr_codes.push({ id, brokerage_id: args.brokerageId, agent_id: args.agentId, label: args.label, slug, target_url: args.targetUrl, destination_type: args.destinationType, purpose: args.purpose, is_active: true })
    return { qrCodeId: id, slug, scanUrl: `${ORIGIN}/api/qr/scan?slug=${slug}`, targetUrl: args.targetUrl, qrCodeDataUrl: "data:image/png;base64,AAAA" }
  }
  return { deps, events, mint }
}
/** Build one probate package on a fresh world (the Create door with its answers given) — shared by the 149D canaries. */
async function buildPackage(answers: Record<string, string> = { persona: "probate", area: "South Austin", topic_key: "ai_pick", deliverable: "checklist" }) {
  const P = await import("../lib/lead-magnets/lead-magnet-package")
  const db = dWorld()
  const s = dSeams(db)
  const r = await withSvc(null, () => quiet(() => P.createLeadMagnetPackage({ brokerageId: DB1, agentId: DAG, createdBy: DU1, origin: "create_button", answers, baseUrl: ORIGIN } as never, { client: db, now: NOW, funnel: s.deps, mintTrackedQr: s.mint, readers: { topicBank: async () => [] } } as never)))
  return { db, s, r: r as any }
}

group("149D", "magnet → page → funnel; the creator stored; the QR resolves to this tenant's form; situation questions, never an open box", [
  {
    id: "149D·C30", label: "the ORDER is the order: the magnet (the question THIS tenant keeps hearing) is produced BEFORE the landing page row; the funnel's video after it; stamps magnet · landing_page · funnel",
    run: async () => {
      const { FUNNEL_PACKAGE_ORDER } = await import("../lib/lead-magnets/magnet-funnel")
      const { db, s, r } = await buildPackage()
      if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r).slice(0, 600) }
      const pkg = r.package
      const formAt = (db as any).writes.findIndex((w: any) => w.table === "lead_capture_forms" && w.op === "insert")
      const ev = (n: string) => s.events.filter((e) => e.ev === n)
      const isOrdered = (st: Array<{ stage: string }>) => st.map((o) => (FUNNEL_PACKAGE_ORDER as readonly string[]).indexOf(o.stage)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]))
      return {
        positive: JSON.stringify(FUNNEL_PACKAGE_ORDER) === JSON.stringify(["magnet", "landing_page", "funnel"]) && pkg.magnet.source === "frequent_question" && /probate before I can sell/.test(pkg.magnet.topic)
          && formAt >= 0 && ev("checklist_rendered")[0]?.at <= formAt && ev("video_commissioned")[0]?.at > formAt && isOrdered(pkg.order),
        negative: !isOrdered([{ stage: "landing_page" }, { stage: "magnet" }, { stage: "funnel" }]) && !isOrdered([{ stage: "magnet" }, { stage: "funnel" }, { stage: "landing_page" }]),
        detail: JSON.stringify({ formAt, events: s.events, order: pkg.order }),
      }
    },
  },
  {
    id: "149D·C30", label: "created_by_user_id is the users.id that clicked Create (assignment follows the form's agent); an agents.id is crossed via agents.user_id; another tenant's user is NULL, never guessed",
    run: async () => {
      const { createLeadMagnet } = await import("../lib/kernel/lead-magnets")
      const { db, r } = await buildPackage()
      const form = r.ok ? rows(db, "lead_capture_forms").find((f) => f.id === r.package.form_id) : null
      const d2 = dWorld()
      const c1 = await withSvc(null, () => quiet(() => createLeadMagnet({ title: "Agent-id creator", description: "x", magnetType: "generic_form", brokerageId: DB2, agentId: DAG2, createdBy: DAG2, publishState: "draft" } as never, { client: d2 as never })))
      const c2 = await withSvc(null, () => quiet(() => createLeadMagnet({ title: "Foreign creator", description: "x", magnetType: "generic_form", brokerageId: DB2, agentId: DAG2, createdBy: DU1, publishState: "draft" } as never, { client: d2 as never })))
      const f1 = rows(d2, "lead_capture_forms").find((f) => f.id === (c1 as any).magnetId), f2 = rows(d2, "lead_capture_forms").find((f) => f.id === (c2 as any).magnetId)
      return {
        positive: r.ok && form?.created_by_user_id === DU1 && form?.agent_id === DAG && r.package.creator.created_by_user_id === DU1 && (c1 as any).success && f1?.created_by_user_id === DU2,
        negative: (c2 as any).success && f2?.created_by_user_id === null,
        detail: JSON.stringify({ form: form?.created_by_user_id, f1: f1?.created_by_user_id, f2: f2?.created_by_user_id }),
      }
    },
  },
  {
    id: "149D·C30", label: "the QR points at /site/<this tenant>/lm/<slug> and RESOLVES through the tenant-site resolver to THIS form; another tenant's site does not serve it",
    run: async () => {
      const { resolveTenantLandingForm } = await import("../lib/tenant-site/landing-page")
      const { db, r } = await buildPackage()
      if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r).slice(0, 600) }
      const pkg = r.package
      const qr = rows(db, "qr_codes").find((q) => q.id === pkg.qr?.qr_code_id)
      const m = new URL(qr?.target_url ?? "https://x/none").pathname.match(/^\/site\/([^/]+)\/lm\/([^/]+)$/)
      const ok = m ? await resolveTenantLandingForm(db as never, m[1], m[2]) : null
      const foreign = m ? await resolveTenantLandingForm(db as never, "oak-team", m[2]) : null
      const form = rows(db, "lead_capture_forms").find((f) => f.id === pkg.form_id)
      return {
        positive: !!qr && qr.label === `lead_magnet:${pkg.form_id}` && m?.[1] === "elm-realty" && /utm_source=qr/.test(qr.target_url) && form?.qr_code_id === qr.id && (ok as any)?.ok === true && (ok as any)?.formId === pkg.form_id,
        negative: (foreign as any)?.ok === false && pkg.landing.state === "draft",
        detail: JSON.stringify({ target: qr?.target_url, ok, foreign }),
      }
    },
  },
  {
    id: "149D·R16", label: "situation questions, never an open box: the probate form asks the estate's questions and no textarea; the planner's 'Any other questions?' is DROPPED and said; the finder sees a planted one",
    run: async () => {
      const M = await import("../lib/lead-magnets/magnet-funnel")
      const { r } = await buildPackage()
      if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r).slice(0, 600) }
      const fields = r.package.funnel.form.fields as Array<{ name: string; type: string }>
      const names = fields.map((f) => f.name)
      const bank = [...M.SITUATION_PERSONAS.flatMap((p: any) => (M.SITUATION_QUESTIONS as any)[p]), ...Object.values(M.SITUATION_SIDE_QUESTIONS).flat()] as Array<{ label: string; options?: string[] }>
      return {
        positive: ["property_role", "estate_stage", "home_condition"].every((n) => names.includes(n)) && !fields.some((f) => f.type === "textarea") && bank.every((q) => (q.options ?? []).length >= 2 && !M.GENERIC_OPEN_QUESTION.test(q.label)),
        negative: r.package.funnel.notes.some((n: string) => /generic open question/.test(n)) && M.GENERIC_OPEN_QUESTION.test("Any other questions?") && M.GENERIC_OPEN_QUESTION.test("What is the one question you most want answered?"),
        detail: JSON.stringify({ names, notes: r.package.funnel.notes }),
        note: `${bank.length} situation questions in the bank, every one a closed choice`,
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149E — markets from Settings territories, no invented rank, llms.txt ↔ sitemap (C31; rulings 13, 14)
// ═════════════════════════════════════════════════════════════════════════════
type Script = Record<string, { data?: unknown[]; error?: { message: string } | null }>
/** A recording fake client (the lane-E guard's shape): results come from a per-table script; every chained filter is recorded. */
function scriptedDb(script: Script) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = []
  const from = (table: string) => {
    const rec = { table, ops: [] as Array<[string, unknown[]]> }
    calls.push(rec)
    const res = () => ({ data: script[table]?.error ? null : (script[table]?.data ?? []), error: script[table]?.error ?? null })
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => void, no: (e: unknown) => void) => Promise.resolve(res()).then(ok, no)
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ ...res(), data: (res().data as unknown[] | null)?.[0] ?? null })
        return (...args: unknown[]) => { rec.ops.push([prop, args]); return b }
      },
    })
    return b
  }
  return { db: { from }, calls }
}
/** Any numeric value under a key spelled rank / position / place (the lane-E walker). */
function rankKeys(v: unknown, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => rankKeys(x, `${path}[${i}]`))
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    (/(^|_)(rank|position|place)$|^(rank|position|place)/i.test(k) && typeof x === "number" ? [`${path}.${k}`] : []).concat(rankKeys(x, `${path}.${k}`)))
  return []
}

group("149E", "markets derive from Settings territories; no numeric rank anywhere in the visibility reading or card; llms.txt and the sitemap agree", [
  {
    id: "149E·R14", label: "markets come from the Settings territories (case-merged, primary first, tenant-pinned reads); a farm is only a labelled hint when Settings has none",
    run: async () => {
      const { loadTenantMarkets, primaryMarketLabel } = await import("../lib/geo/tenant-markets")
      const s1 = scriptedDb({
        subscriber_service_areas: { data: [{ city: "austin ", state: "TX", zip_code: "78704", is_primary: true }, { city: "Austin", state: "tx", zip_code: "78702" }] },
        lead_scraping_markets: { data: [] }, farm_territories: { data: [{ city: "Farmtown", state: "TX", zip_codes: ["75000"] }] }, brokerages: { data: [{ city: "Office City", state: "TX" }] },
      })
      const t = await loadTenantMarkets(s1.db as never, "b-149e")
      const s2 = scriptedDb({ subscriber_service_areas: { data: [] }, lead_scraping_markets: { data: [] }, farm_territories: { data: [{ city: "Farmtown", state: "TX", zip_codes: [] }] } })
      const none = await loadTenantMarkets(s2.db as never, "b-149e")
      return {
        positive: t.basis === "settings" && t.markets.length === 1 && t.markets[0].primary === true && t.markets[0].zips.join(",") === "78702,78704" && t.fallbackHint === null && !t.markets.some((m) => /Farmtown|Office/.test(m.city))
          && s1.calls.every((c) => c.ops.some(([op, a]) => op === "eq" && (a[0] === "brokerage_id" || a[0] === "id") && a[1] === "b-149e")),
        negative: none.markets.length === 0 && none.fallbackHint?.basis === "farm_territory" && primaryMarketLabel(none) === "Farmtown, TX" && none.blindSpots.some((b) => /Settings/.test(b)),
        detail: JSON.stringify({ t: t.markets, none: { basis: none.basis, hint: none.fallbackHint } }),
      }
    },
  },
  {
    id: "149E·C31", label: "no numeric rank anywhere: the composed reading and the visibility CARD carry no rank / position; Google organic is NOT MEASURED (named what would measure it); the walker catches a planted { rank: 3 }",
    run: async () => {
      const SV = await import("../lib/geo/search-visibility")
      const { loadTenantMarkets } = await import("../lib/geo/tenant-markets")
      const markets = await loadTenantMarkets(scriptedDb({ subscriber_service_areas: { data: [{ city: "Austin", state: "TX", zip_code: "78702", is_primary: true }] } }).db as never, "b-149e")
      const obs = (page: string, day: string, outcome: string, query: string) => Array.from({ length: 5 }, () => ({ project_id: page, observed_on: day, observed_at: `${day}T12:00:00.000Z`, outcome, competitors_cited: null, query, agent_id: null, team_id: null }))
      const s = scriptedDb({
        ai_search_citation_observations: { data: [...obs("p1", "2026-10-10", "cited", "best neighborhoods in austin"), ...obs("p2", "2026-10-25", "not_cited", "austin property tax protest")] },
        ai_search_landing_citation_observations: { data: [] }, seo_keywords: { data: [{ id: "k1" }, { id: "k2" }] },
      })
      const v = await SV.loadSearchVisibility(s.db as never, "b-149e", { now: NOW, windowDays: 30, deps: { brand: async () => null, leadership: async () => null, markets: async () => markets } } as never)
      const RANK_LITERAL = /\b(rank|position|serpPosition|googleRank)\s*:\s*\d/
      const files = ["app/dashboard/marketing/seo/search-visibility-card.tsx", "lib/geo/search-visibility.ts", "lib/geo/tenant-markets.ts"]
      const hits = files.filter((f) => !code(f) || RANK_LITERAL.test(code(f)))
      const g = (v as any).sources?.find((x: any) => x.key === "google_organic")
      return {
        positive: rankKeys(v).length === 0 && hits.length === 0 && g?.status === "not_measured" && /Search Console/.test(g?.waitingExternal ?? "") && (v as any).rankPolicy === SV.RANK_POLICY,
        negative: rankKeys({ ...(v as any), sources: [{ rank: 3 }] }).length === 1 && rankKeys({ x: [{ google_position: 4 }] }).length === 1 && RANK_LITERAL.test(stripComments("const r = { position: 4 }")) && !RANK_LITERAL.test(stripComments("// position: 4")),
        detail: JSON.stringify({ ranks: rankKeys(v), hits, g: g?.status }),
      }
    },
  },
  {
    id: "149E·R13", label: "llms.txt and sitemap.xml AGREE: both list every public copy route (one list, PUBLIC_COPY_ROUTES); an llms.txt without /team/ is caught",
    run: async () => {
      const { PUBLIC_COPY_ROUTES, OS_COPY_SOURCES } = await import("../lib/knowledge/embedding-service")
      const sitemap = code("app/sitemap.ts"), llms = code("app/llms.txt/route.ts")
      const missing = (body: string) => PUBLIC_COPY_ROUTES.filter((r: string) => !body.includes("${base}" + r))
      return {
        positive: PUBLIC_COPY_ROUTES.length >= 3 && sitemap.length > 0 && llms.length > 0 && missing(sitemap).length === 0 && missing(llms).length === 0 && OS_COPY_SOURCES.filter((x: any) => x.publicRoute).every((x: any) => !!x.publicWhen),
        negative: missing(llms.split("${base}/team/").join("")).includes("/team/") && missing(sitemap.split("${base}/lm/").join("")).includes("/lm/"),
        detail: JSON.stringify({ routes: PUBLIC_COPY_ROUTES, sitemapMissing: missing(sitemap), llmsMissing: missing(llms) }),
        note: `${PUBLIC_COPY_ROUTES.length} public copy routes in both llms.txt and sitemap.xml`,
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149F — tenant-branded events (C32; rulings 11, 15, 16; reminders via C29)
// ═════════════════════════════════════════════════════════════════════════════
const FB = "b1490000-0000-4000-8000-0000000001f9", FU = "d1490000-0000-4000-8000-0000000001f9", FAG = "a1490000-0000-4000-8000-0000000001f9"
const FEV = "e1490000-0000-4000-8000-0000000001f9", FEVP = "e1490000-0000-4000-8000-0000000002f9", FC1 = "c1490000-0000-4000-8000-0000000001f9", FR1 = "f1490000-0000-4000-8000-0000000001f9"
const F_GOOD = {
  headline: "Buying your first home", registration_intro: "Join Harbor Realty for an evening.", what_you_will_learn: ["a"], invitation_subject: "s", invitation_body: "b", invitation_sms: "Join us. Reply STOP to opt out.",
  confirmation_subject: "s", confirmation_body: "See you {{date_time}} — {{join_link}}", reminder_subject: "s", reminder_body: "Soon: {{date_time}} — {{join_link}}",
  replay_attended_subject: "s", replay_attended_body: "{{replay_link}}", replay_missed_subject: "s", replay_missed_body: "{{replay_link}}", social_post: "p", self_check: "",
}

group("149F", "the tenant's brand on every event surface; the platform's only on its own events; one event writer; kind-specific questions; arbiter reminders", [
  {
    id: "149F·C32", label: "a tenant event speaks in the cascade's brand + website (never global_settings' 'VIP Real Estate OS'); a platform-owned event in the platform's; a cascade outage falls back to the TENANT",
    run: async () => {
      const mk = await import("../lib/open-house/event-marketing")
      const svc = memSupabase({
        brokerages: [{ id: FB, name: "Harbor Realty", slug: "harbor" }], global_settings: [{ brokerage_id: FB, app_name: "VIP Real Estate OS" }],
        users: [{ id: FU, brokerage_id: FB, first_name: "Dana", last_name: "Host", team_id: null }], agents: [{ id: FAG, user_id: FU, brokerage_id: FB }],
        open_house_events: [
          { id: FEV, brokerage_id: FB, agent_id: FAG, created_by: FU, event_type: "webinar", title: "First-time buyer basics", event_date: "2026-12-10", start_time: "18:00", end_time: "19:00", virtual_provider: "zoom", marketing_assets: {} },
          { id: FEVP, brokerage_id: FB, agent_id: FAG, created_by: FU, event_type: "webinar", title: "Platform demo", event_date: "2026-12-11", start_time: "18:00", end_time: "19:00", virtual_provider: "zoom", marketing_assets: {}, brand_owner: "platform" },
        ],
      })
      const cascade = async () => ({ displayName: "Harbor Realty", brokerageName: "Harbor Realty", agentName: "Dana Host", display: { websiteWordmark: "harborrealty.example" }, visual: { logoUrl: null, primaryColor: "#123456" }, fairHousing: { shortDisclosure: "Equal Housing Opportunity." } })
      const product = async () => ({ name: "VIP Agents", ctaUrl: "https://platform.example", logoUrl: null, primaryColor: "#000000" })
      const ev = (id: string) => ({ id, brokerage_id: FB, agent_id: FAG, created_by: FU })
      const tb = await mk.resolveEventBrand(svc as never, ev(FEV), { brandContext: cascade as never, productBrand: product } as never)
      const pb = await mk.resolveEventBrand(svc as never, ev(FEVP), { brandContext: cascade as never, productBrand: product } as never)
      const fb = await quiet(() => mk.resolveEventBrand(svc as never, ev(FEV), { brandContext: (async () => { throw new Error("cascade down") }) as never, productBrand: product } as never))
      return {
        positive: tb.owner === "tenant" && tb.displayName === "Harbor Realty" && tb.website === "harborrealty.example" && !JSON.stringify(tb).includes("VIP") && pb.owner === "platform" && pb.displayName === "VIP Agents",
        negative: fb.owner === "tenant" && fb.displayName === "Harbor Realty",
        detail: JSON.stringify({ tb, pb, fb }),
      }
    },
  },
  {
    id: "149F·C32", label: "the platform's name BLOCKS approval of a tenant event's copy (and is clean on a platform event); the stripped census of every event surface finds no platform brand; a planted one is seen",
    run: async () => {
      const reg = await import("../lib/open-house/event-registry")
      const mk = await import("../lib/open-house/event-marketing")
      const surfaces = [
        ...walkCode("lib/open-house").filter((f) => !f.endsWith("event-registry.ts")), ...walkCode("app/open-house"), ...walkCode("app/site/[slug]/events"),
        "lib/communications/send-invitation.ts", "app/actions/open-house.ts", "app/actions/open-house-automation.ts",
      ]
      const hits = surfaces.flatMap((f) => reg.platformBrandHits(code(f)).map((h) => `${f}: ${h}`))
      const clean = mk.scanEventCopy(F_GOOD as never, { online: true, brandOwner: "tenant" } as never)
      const leaked = mk.scanEventCopy({ ...F_GOOD, headline: "VIPAgents presents: first-time buyer night" } as never, { online: true, brandOwner: "tenant" } as never)
      const platformOwn = mk.scanEventCopy({ ...F_GOOD, headline: "VIPAgents live demo" } as never, { online: true, brandOwner: "platform" } as never)
      return {
        positive: surfaces.length > 10 && hits.length === 0 && !clean.blocking && !platformOwn.blocking && reg.platformBrandHits(mk.EVENT_MARKETING_SYSTEM).length === 0 && reg.eventBrandOwner(undefined) === "tenant",
        negative: leaked.blocking && leaked.findings.some((f: any) => f.field === "headline") && reg.platformBrandHits(stripComments(`const h = "Hosted by VIPAgents"`)).length === 1 && reg.platformBrandHits(stripComments(`// TOMBSTONE: "Hosted by VIPAgents" lived here`)).length === 0,
        detail: JSON.stringify({ hits, leaked: leaked.findings }),
        note: `${surfaces.length} event surface files scanned (stripped), platform-brand hits ${hits.length}`,
      }
    },
  },
  {
    id: "149F·C32", label: "ONE event writer: exactly one file inserts open_house_events (lib/kernel/open-house.ts); every registration kind asks its own CLOSED situation questions; free text is dropped by the sanitizer",
    run: async () => {
      const reg = await import("../lib/open-house/event-registry")
      const INSERT = /\.from\(\s*["'`]open_house_events["'`]\s*\)\s*\.(insert|upsert)\(/
      const writers = [...walkCode("app"), ...walkCode("lib"), ...walkCode("workflows")].filter((f) => INSERT.test(code(f)))
      const regKinds = reg.EVENT_KINDS.filter((k: any) => (reg.EVENT_PRODUCER_REGISTRY as any)[k].registration.required)
      const all = reg.EVENT_KINDS.flatMap((k: any) => (reg.REGISTRATION_QUESTIONS as any)[k] as any[])
      const forged = reg.sanitizeEventSituation("webinar", { intent: "buyer", question: "free text the owner ruled out", interests: ["financing_and_rates", "<script>"], guests: 3 } as never) as any
      return {
        positive: writers.length === 1 && writers[0] === "lib/kernel/open-house.ts" && regKinds.every((k: any) => (reg.REGISTRATION_QUESTIONS as any)[k].length > 0)
          && all.every((q: any) => ["single", "multiple", "yes_no", "count"].includes(q.kind) && q.options.length >= 2) && JSON.stringify([...reg.EVENT_INTENTS]) === JSON.stringify(["buyer", "seller", "both"]),
        negative: !("question" in forged) && JSON.stringify(forged.interests) === JSON.stringify(["financing_and_rates"]) && forged.guests === null
          && INSERT.test(stripComments(`await supabase.from("open_house_events")\n  .insert({ listing_id })`)) && !INSERT.test(stripComments(`// TOMBSTONE: await supabase.from("open_house_events").insert({ x })`)),
        detail: JSON.stringify({ writers, regKinds, forged }),
        note: `open_house_events writers: ${writers.length}; ${regKinds.length} registration kinds, ${all.length} closed questions`,
      }
    },
  },
  {
    id: "149F·C29", label: "event reminders are the ARBITER's: wait → nothing sent (the wait recorded); remind → ONE reminder in the approved words; no approved copy → nothing static stands in",
    run: async () => {
      const T = await import("../lib/open-house/event-touches")
      const { platformFollowupPolicy } = await import("../lib/ai-isa/followup-policy")
      const now = new Date("2026-12-08T15:00:00Z")
      const approved = { status: "approved", approved: { reminder_subject: "See you Thursday", reminder_body: "Hi {{first_name}} — {{event_title}} is {{date_time}}. Your link: {{join_link}}" } }
      const world = (assets: unknown = approved) => memSupabase({
        open_house_events: [{ id: FEV, brokerage_id: FB, agent_id: FAG, created_by: FU, event_type: "webinar", status: "scheduled", title: "First-time buyer basics", event_date: "2026-12-10", start_time: "18:00", end_time: "19:00", timezone: "America/New_York", virtual_provider: "zoom", is_published: true, marketing_assets: assets }],
        open_house_rsvp_tracking: [{ id: FR1, event_id: FEV, contact_id: FC1, brokerage_id: FB, rsvp_status: "yes", registered_at: "2026-12-01T12:00:00Z", situation: { timeline: "1-3_months" }, reminder_count: 0, last_reminded_at: null }],
        contacts: [{ id: FC1, brokerage_id: FB, email: "ana@example.test", first_name: "Ana", last_name: "Lopez" }],
      })
      const keys = new Set<string>()
      const ledger = (async (ctx: any, run: () => Promise<any>, hooks: any) => { const k = `${ctx.action}|${ctx.subject?.id}|${ctx.cycle}`; if (keys.has(k)) return hooks.replay({ kind: "replayed" }); keys.add(k); return run() }) as never
      const sent: any[] = [], waits: any[] = []
      const base = { policy: platformFollowupPolicy(), ledger, now: () => now, sendEmail: async (p: any) => { sent.push(p); return { success: true } }, routeToAgent: (async () => true) as never, recordWait: async (_s: unknown, a: any) => { waits.push(a) } }
      const say = (optionId: string, extra: Record<string, unknown> = {}) => (async () => ({ optionId, channel: optionId === "remind" ? "email" : null, rationale: `scripted arbiter chose ${optionId}`, evidence: ["journey", "history"], confidence: 0.9, ...extra })) as never
      const prevUrl = process.env.NEXT_PUBLIC_APP_URL
      process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test"
      try {
        const s1 = world()
        const w = await quiet(() => T.arbitrateEventTouches(s1 as never, FEV, { ...base, decide: say("wait", { waitHours: 24 }) } as never))
        const sentAfterWait = sent.length
        const r = await quiet(() => T.arbitrateEventTouches(s1 as never, FEV, { ...base, decide: say("remind") } as never))
        const s0 = world({ status: "approved", approved: {} })
        const n0 = await quiet(() => T.arbitrateEventTouches(s0 as never, FEV, { ...base, decide: say("remind") } as never))
        return {
          positive: w.asked === 1 && w.reminded === 0 && sentAfterWait === 0 && waits.length === 1 && r.reminded === 1 && sent.length === 1 && /First-time buyer basics/.test(sent[0].text) && rows(s1, "open_house_rsvp_tracking")[0].reminder_count === 1,
          negative: n0.reminded === 0 && sent.length === 1 && n0.skipped.some((x: any) => /approved reminder copy/.test(x.reason)),
          detail: JSON.stringify({ w, r, n0 }),
        }
      } finally { if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = prevUrl }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149G — contractual closing (C33; owner ruling 17)
// ═════════════════════════════════════════════════════════════════════════════
const GB = "11111111-1111-4111-8111-1111111111a9", GT = "74747474-0000-4000-8000-000000001490"
const gDeal = (over: Record<string, unknown> = {}) => ({
  id: GT, brokerage_id: GB, status: "under_contract", close_date: "2026-12-15", estimated_close_date: "2026-12-15",
  contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract",
  contract_closing_amendment_ref: null, actual_close_date: null, property_state: "CA", financing_type: "conventional", updated_at: "v1", ...over,
})
const gLedger = () => {
  const out: any[] = [], keys = new Set<string>()
  const fn = async (ctx: any, run: () => Promise<any>, hooks: any) => { if (keys.has(ctx.idempotencyKey)) return hooks.replay({ kind: "replay", entry: {} }); keys.add(ctx.idempotencyKey); const r = await run(); out.push({ ...ctx, settled: hooks.settle(r) }); return r }
  return { fn: fn as never, out }
}

group("149G", "'on or before' lets a deal close earlier with no amendment demand; contractual, anticipated and actual stay separate", [
  {
    id: "149G·C33", label: "an EARLIER day under 'on or before' is recorded (anticipated) with NO executed amendment and no evidence asked; the contract's date and wording untouched; the deal SAYS closing may occur earlier",
    run: async () => {
      const C = await import("../lib/transactions/closing-dates")
      const db = memSupabase({ transactions: [gDeal()] })
      const L = gLedger()
      const r = await C.applyClosingDateChange(db as never, { brokerageId: GB, transactionId: GT, actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason: "The buyer's lender can fund a week early" }, { ledger: L.fn })
      const t = rows(db, "transactions")[0]
      const fixed = C.assessClosingDateChange(gDeal({ contract_closing_terms: "on" }) as never, { date: "2026-12-08", kind: "anticipated" })
      const unread = C.assessClosingDateChange(gDeal({ contract_closing_terms: null }) as never, { date: "2026-12-08", kind: "anticipated" })
      return {
        positive: r.ok && r.assessment?.requiresExecutedAmendment === false && r.assessment.amendmentBasis === "none" && r.assessment.withinContract === true
          && t.estimated_close_date === "2026-12-08" && t.contract_closing_date === "2026-12-15" && t.contract_closing_terms === "on_or_before"
          && r.dates.earlierClosing?.requiresExecutedAmendment === false && /closing may occur earlier/i.test(r.dates.earlierClosing.note),
        negative: fixed.requiresExecutedAmendment === true && fixed.amendmentBasis === "contract_fixed_day" && unread.requiresExecutedAmendment === "unknown" && unread.amendmentBasis === "wording_unread",
        detail: JSON.stringify({ r: r.ok ? r.assessment : r, fixed: fixed.amendmentBasis, unread: unread.amendmentBasis }),
      }
    },
  },
  {
    id: "149G·C33", label: "a deal that closed EARLY under 'on or before' records its ACTUAL day from the settlement statement — no amendment demanded, the contract untouched; without the document, or on an open deal, refused",
    run: async () => {
      const C = await import("../lib/transactions/closing-dates")
      const closed = gDeal({ status: "closed", actual_close_date: "2026-10-10", close_date: "2026-10-10", contract_closing_date: "2026-10-15" })
      const db = memSupabase({ transactions: [closed] })
      const L = gLedger()
      const ok = await C.applyClosingDateChange(db as never, { brokerageId: GB, transactionId: GT, actorUserId: "u-1", kind: "actual_confirmation", date: "2026-10-09", reason: "Settlement statement shows signing on the 9th", evidenceRef: "doc:alta-ss" }, { ledger: L.fn })
      const t = rows(db, "transactions")[0]
      const noProof = await C.applyClosingDateChange(memSupabase({ transactions: [closed] }) as never, { brokerageId: GB, transactionId: GT, actorUserId: "u-1", kind: "actual_confirmation", date: "2026-10-09", reason: "Settlement statement shows signing on the 9th" }, { ledger: gLedger().fn })
      const openTry = await C.applyClosingDateChange(memSupabase({ transactions: [gDeal()] }) as never, { brokerageId: GB, transactionId: GT, actorUserId: "u-1", kind: "actual_confirmation", date: "2026-10-09", reason: "Settlement statement shows signing on the 9th", evidenceRef: "doc:alta-ss" }, { ledger: gLedger().fn })
      return {
        positive: ok.ok && ok.assessment === null && t.actual_close_date === "2026-10-09" && t.contract_closing_date === "2026-10-15" && t.contract_closing_amendment_ref === null && ok.dates.actual?.date === "2026-10-09" && L.out.length === 1,
        negative: !noProof.ok && /settlement statement/i.test(noProof.error) && !openTry.ok && /has not closed/.test(openTry.error),
        detail: JSON.stringify({ ok: ok.ok ? ok.dates : ok, noProof, openTry }),
      }
    },
  },
  {
    id: "149G·C33", label: "contractual vs anticipated vs actual are three facts: a title appointment moves only the anticipated day; readiness measures against the EARLIEST credible day; a later day needs an executed extension",
    run: async () => {
      const C = await import("../lib/transactions/closing-dates")
      const d = C.resolveClosingDates(gDeal({ scheduled_closing_date: "2026-12-05" }) as never)
      const rd = C.readinessClosingDay(gDeal({ scheduled_closing_date: "2026-12-05" }) as never)
      const later = C.readinessClosingDay(gDeal({ estimated_close_date: "2026-12-30" }) as never)
      const late = C.assessClosingDateChange(gDeal() as never, { date: "2026-12-20", kind: "anticipated" })
      const closedDates = C.resolveClosingDates(gDeal({ status: "closed", actual_close_date: "2026-12-04" }) as never)
      return {
        positive: d.contractual?.date === "2026-12-15" && d.contractual.terms === "on_or_before" && d.anticipated?.date === "2026-12-05" && d.anticipated.basis === "title_schedule" && d.actual === null
          && rd?.date === "2026-12-05" && closedDates.actual?.date === "2026-12-04" && closedDates.contractual?.date === "2026-12-15" && closedDates.anticipated === null,
        negative: later?.date === "2026-12-15" && later.basis === "contract" && late.requiresExecutedAmendment === true && late.amendmentBasis === "contract_deadline_passed",
        detail: JSON.stringify({ d: { c: d.contractual, a: d.anticipated }, rd, later, late: late.amendmentBasis }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149H — opportunity discovery (owner ruling 18): combination, never one observation; never naming the event
// ═════════════════════════════════════════════════════════════════════════════
const H_NOW = new Date("2026-10-30T15:00:00.000Z")
let hSeq = 0
const hObs = (sourceKey: string, relevance: string, confidence: string, extra: Record<string, unknown> = {}) =>
  ({ id: `h${++hSeq}`, sourceKey, relevance, confidence, identity: "record_key", observedAt: new Date(H_NOW.getTime() - 3 * 86_400_000).toISOString(), ...extra }) as never

group("149H", "a single source never raises intent; independent sources combined do; sensitive events are never named outward", [
  {
    id: "149H·R18", label: "ONE verified permit is a single observation (no education, outreach or agent alert offered); the SAME source three times is still one",
    run: async () => {
      const od = await import("../lib/intent/opportunity-discovery")
      const single = od.readOpportunities([hObs("pr_permit_activity", "property_event", "verified")], { now: H_NOW })
      const repeated = od.readOpportunities([hObs("fp_saved_homes", "property_event", "verified"), hObs("fp_saved_homes", "property_event", "verified"), hObs("fp_saved_homes", "property_event", "verified")], { now: H_NOW })
      const menu = od.opportunityMenu(single, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null } as never)
      const st = (m: string) => menu.options.find((x: any) => x.mode === m)?.status
      return {
        positive: single.primary?.stage === "single_observation" && repeated.primary?.stage === "single_observation" && repeated.primary.independentSources === 1
          && st("helpful_education") === "not_eligible" && st("appropriate_outreach") === "not_eligible" && st("human") === "not_eligible" && st("quiet_monitoring") === "eligible",
        negative: !od.stageAtLeast(single.primary!.stage, "emerging") && od.stageAtLeast("likely" as never, "emerging"),
        detail: JSON.stringify({ single: single.primary, repeated: repeated.primary, menu: menu.options.map((x: any) => `${x.mode}:${x.status}`) }),
      }
    },
  },
  {
    id: "149H·R18", label: "COMBINED independent sources raise it: a permit + the owner's own seller-net calculation = likely sell (outreach eligible under autonomy); inferences alone stay at watch; context alone never scores",
    run: async () => {
      const od = await import("../lib/intent/opportunity-discovery")
      const combined = od.readOpportunities([hObs("pr_permit_activity", "property_event", "verified"), hObs("fp_calc_seller_net", "property_event", "verified")], { now: H_NOW })
      const menu = od.opportunityMenu(combined, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null } as never)
      const unknownAuth = od.opportunityMenu(combined, { personIdentified: true, outreachPermitted: true, autonomy: "unknown", paidResearchAffordable: null } as never)
      const inferred = od.readOpportunities([hObs("po_online_real_estate_activity", "property_event", "inferred", { identity: "verified_match" }), hObs("pr_owner_rental_listing", "property_event", "inferred", { identity: "verified_match", intents: ["home_sale"] })], { now: H_NOW })
      const ctx = od.readOpportunities([hObs("cm_rate_move", "market_event", "verified", { identity: "none" })], { now: H_NOW })
      return {
        positive: combined.primary?.kind === "sell" && combined.primary.stage === "likely" && combined.primary.sourceKinds.length === 2 && menu.options.find((x: any) => x.mode === "appropriate_outreach")?.status === "eligible",
        negative: inferred.assessments.every((a: any) => !od.stageAtLeast(a.stage, "emerging")) && ctx.primary === null && unknownAuth.options.find((x: any) => x.mode === "appropriate_outreach")?.status === "needs_authority",
        detail: JSON.stringify({ combined: combined.primary, inferred: inferred.assessments.map((a: any) => a.stage), ctx: ctx.primary }),
      }
    },
  },
  {
    id: "149H·R18", label: "a reading touched by a life event is SENSITIVE: no event word, no source key and no never-mention pattern reaches any outward brief; the screen catches a planted 'sorry for your loss … the estate filing'",
    run: async () => {
      const od = await import("../lib/intent/opportunity-discovery")
      const mv = await import("../lib/intent/movement-signals")
      const lev = await import("../lib/enrichment/life-event-vocabulary")
      const sens = od.readOpportunities([
        hObs("pp_web_mention_life_event", "probate_estate", "reported", { identity: "verified_match", lifeEvent: "death_in_household", protectedProxy: false }),
        hObs("pr_permit_activity", "property_event", "verified"), hObs("fp_calc_seller_net", "property_event", "verified"),
      ], { now: H_NOW })
      const menu = od.opportunityMenu(sens, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null } as never)
      const briefs = menu.options.map((x: any) => x.brief).filter((b: any): b is string => !!b)
      const outward = [...briefs, sens.explanation, ...sens.assessments.map((a: any) => a.reason)].join("\n")
      const never = lev.LIFE_EVENT_TYPES.flatMap((t: any) => (lev.LIFE_EVENT_VOCAB as any)[t].allowedOutreach.neverMention as string[])
      const keys = mv.MOVEMENT_SIGNAL_SOURCES.map((s: any) => s.key).filter((k: string) => outward.includes(k))
      const screen = lev.screenLifeEventOutreach(briefs.join("\n"), { events: sens.screenEvents.map((type: any) => ({ type })) } as never)
      const planted = lev.screenLifeEventOutreach("So sorry for your loss — we noticed the estate filing.", { events: [{ type: "death_in_household" }] } as never)
      return {
        positive: sens.sensitive && !!sens.toneBrief && briefs.length >= 2 && screen.ok && keys.length === 0 && !/death|probate|estate|divorce/i.test(outward) && never.every((re) => !new RegExp(re, "i").test(outward)),
        negative: !planted.ok,
        detail: JSON.stringify({ briefs: briefs.length, keys, screen: screen.hits }),
        note: `${never.length} never-mention patterns over ${lev.LIFE_EVENT_TYPES.length} life events checked against ${briefs.length} outward briefs`,
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149I — DataZapp, Tracerfy, AMcards (documents only; ruling 19)
// ═════════════════════════════════════════════════════════════════════════════
const C360_DOC = "docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md", MAIL_DOC = "docs/commercial/DIRECT-MAIL-PROVIDER-COMPARISON.md"
/** The text between a heading and the next heading of the same or higher level. */
function section(doc: string, heading: RegExp): string {
  const lines = doc.split("\n")
  const at = lines.findIndex((l) => heading.test(l))
  if (at < 0) return ""
  const level = (/^(#+)/.exec(lines[at])?.[1] ?? "##").length
  const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l) && (/^(#+)/.exec(l)?.[1] ?? "").length <= level)
  return lines.slice(at, end < 0 ? undefined : end).join("\n")
}
/** A sourced vendor table: every row names the vendor and carries an https URL; the section names the read date. */
function sourced(sec: string, vendor: RegExp, minRows: number): { ok: boolean; rows: number; unsourced: number } {
  const rowsOf = sec.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*(Vendor|Source|Item)\s*\|/.test(l))
  const vendorRows = rowsOf.filter((l) => vendor.test(l))
  const unsourced = vendorRows.filter((l) => !/<https:\/\/[^>]+>/.test(l)).length
  return { ok: vendorRows.length >= minRows && unsourced === 0 && /\b20\d\d-\d\d-\d\d\b/.test(sec), rows: vendorRows.length, unsourced }
}
const NO_PURCHASE = /no purchase|nothing was bought|not purchased/i

group("149I", "the commercial docs name Tracerfy, DataZapp and AMcards with dated, linked sources — and nothing was bought or wired", [
  {
    id: "149I·R19", label: "§10 names DataZapp AND Tracerfy with a dated sources table (every vendor row linked), a verdict, a 50,000/month model and WAITING_EXTERNAL by name; 'no purchase' is stated",
    run: async () => {
      const doc = raw(C360_DOC)
      const s10 = section(doc, /^## 10\./)
      const src = section(s10, /^### 10\.1 /)
      const dz = sourced(src, /DataZapp/i, 5), tf = sourced(src, /Tracerfy/i, 2)
      const we = section(s10, /^### 10\.9 /)
      const shape = (s: string, t: string) => /DataZapp/.test(s) && /Tracerfy/.test(s) && /50,000/.test(s) && /^### 10\.0 Verdict/m.test(s) && NO_PURCHASE.test(s) && /WAITING_EXTERNAL/.test(t) && /TRACERFY_API_KEY/.test(t)
      const stripped = src.replace(/<https:\/\/[^>]+>/, "(link removed)")
      return {
        positive: s10.length > 0 && dz.ok && tf.ok && shape(s10, we),
        negative: !sourced(stripped, /DataZapp/i, 5).ok && !shape(s10.replace(/no purchase/gi, "a purchase"), we) && !sourced(src.replace(/\b20\d\d-\d\d-\d\d\b/g, "recently"), /DataZapp/i, 5).ok,
        detail: JSON.stringify({ dz, tf, s10: s10.length }),
        note: `§10.1: DataZapp ${dz.rows} linked rows, Tracerfy ${tf.rows} linked rows`,
      }
    },
  },
  {
    id: "149I·R19", label: "§11 re-reads AMcards against Lob on a dated, linked basis, says whether a handwritten-card provider is justified, and names the branded Lob format instead — no account, no purchase",
    run: async () => {
      const doc = raw(MAIL_DOC)
      const s11 = section(doc, /^## 11\./)
      const am = sourced(section(s11, /^### 11\.1 /), /amcards\.com|AMcards/i, 3)
      const shape = (s: string) => /AMcards/.test(s) && /Lob/.test(s) && /^### 11\.2 Verdict/m.test(s) && /not justified/i.test(s) && /^### 11\.3 .*(letter|format)/im.test(s) && NO_PURCHASE.test(s) && /WAITING_EXTERNAL/.test(s)
      return {
        positive: s11.length > 0 && am.ok && shape(s11),
        negative: !shape(s11.replace(/not justified/gi, "pending")) && !sourced(section(s11, /^### 11\.1 /).replace(/<https:\/\/amcards\.com[^>]*>/g, "amcards"), /amcards\.com|AMcards/i, 3).ok,
        detail: JSON.stringify({ am, s11: s11.length }),
      }
    },
  },
  {
    id: "149I·R19", label: "NO adapter on disk for DataZapp / Tracerfy / AMcards: no file named for one, no credential read, no vendor host in lib/ or app/ (stripped); a planted adapter is seen, a tombstone is not",
    run: async () => {
      const VENDOR_FILE = /datazapp|tracerf[l]?y|amcards/i
      const TRACE = /process\.env\.(DATAZAPP_[A-Z_]+|TRACERFY_[A-Z_]+|AMCARDS_[A-Z_]+)\b|["'`]https?:\/\/(?:[a-z0-9-]+\.)*(?:datazapp\.com|tracerfy\.com|tracerfly\.com|amcards\.com)/i
      const files = [...walkCode("lib"), ...walkCode("app")]
      const named = files.filter((f) => VENDOR_FILE.test(f.split("/").pop() ?? ""))
      const traced = files.filter((f) => TRACE.test(code(f)))
      const planted = TRACE.test(stripComments(`const r = await fetch("https://api.tracerfy.com/v1/trace", { headers: { Authorization: process.env.TRACERFY_API_KEY } })`))
      const tomb = TRACE.test(stripComments(`// TOMBSTONE: process.env.DATAZAPP_API_KEY would be read by lib/providers/datazapp.ts — not built\nexport const x = 1`))
      return {
        positive: files.length > 500 && named.length === 0 && traced.length === 0,
        negative: planted && !tomb,
        detail: JSON.stringify({ scanned: files.length, named, traced }),
        note: `${files.length} lib/ + app/ files scanned; adapters found ${named.length + traced.length}`,
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// 149J — open loops closed: portal opt-out, journey-audit doors, lot_size_unit (R20)
// ═════════════════════════════════════════════════════════════════════════════
const JB = "00000000-0000-4000-8000-0000000149f1", JC = "00000000-0000-4000-8000-0000000149f2", JU = "00000000-0000-4000-8000-0000000149f3", JL = "00000000-0000-4000-8000-0000000149f4"

group("149J", "the portal opt-out writes a real suppression; every journey-audit entry point resolves; lot_size_unit only beside the size", [
  {
    id: "149J·R20", label: "turning email OFF on the person's own portal card (updateContactProfile, its own gate) writes the opt-out flag AND a C16 suppression row; the senders' check then refuses; a non-self session writes nothing",
    run: async () => {
      const ps = await import("../app/actions/portal-settings")
      const S = await import("../lib/kernel/compliance/check-suppression")
      const world = () => memSupabase({
        contacts: [{ id: JC, brokerage_id: JB, first_name: "Pat", email: "pat@example.com", phone: "+15125550142", email_opt_out: false, sms_opt_out: false, opt_out_channels: [], metadata: {} }],
        contact_suppression_list: [], platform_suppression_list: [], contact_consent_events: [], compliance_events: [], self_heal_events: [], lifecycle_events: [], notifications: [],
      }, { uuidIds: true, stampCreatedAt: true })
      const db = world()
      const self = { ok: true, isContactSelf: true, contactId: JC, brokerageId: JB, userId: JU }
      const before = await S.checkSuppression({ brokerageId: JB, contactId: JC, email: "pat@example.com", channel: "email" } as never, { client: db } as never)
      const r = await withSvc(db, () => quiet(() => ps.updateContactProfile(JC, { metadata: { notification_preferences: { email: false, sms: true } } })), self)
      const c = rows(db, "contacts")[0]
      const after = await S.checkSuppression({ brokerageId: JB, contactId: null, email: "pat@example.com", channel: "email" } as never, { client: db } as never)
      const sms = await S.checkSuppression({ brokerageId: JB, contactId: JC, phone: "+15125550142", channel: "sms" } as never, { client: db } as never)
      const db2 = world()
      const staff = await withSvc(db2, () => quiet(() => ps.updateContactProfile(JC, { metadata: { notification_preferences: { email: false } } })), { ...self, isContactSelf: false })
      return {
        positive: r.success === true && c.email_opt_out === true && c.opt_out_source === "portal" && rows(db, "contact_suppression_list").some((x) => x.brokerage_id === JB && x.channel === "email") && !before.suppressed && after.suppressed,
        negative: !sms.suppressed && c.sms_opt_out !== true && staff.success === false && rows(db2, "contact_suppression_list").length === 0 && rows(db2, "contacts")[0].email_opt_out === false,
        detail: JSON.stringify({ r, flags: { e: c.email_opt_out, s: c.sms_opt_out, src: c.opt_out_source }, list: rows(db, "contact_suppression_list"), before, after, sms, staff }),
      }
    },
  },
  {
    id: "149J·R20", label: "every journey-audit entry point RESOLVES: each named door file exists and exports that async door (stripped, string-blanked source); a tombstone naming a door is not one",
    run: async () => {
      const guard = raw("scripts/journey-audit-guard.ts")
      const body = /export const JOURNEYS[^=]*=\s*\{([\s\S]*?)\n\}\n/.exec(guard)?.[1] ?? ""
      const doors = [...body.matchAll(/\{\s*file:\s*"([^"]+)",\s*symbol:\s*"([^"]+)"\s*\}/g)].map((m) => ({ file: m[1], symbol: m[2] }))
      const journeys = (body.match(/^\s{2}"[^"]+":\s*\[/gm) ?? []).length
      const exportsDoor = (src: string, sym: string) => new RegExp(`export\\s+(?:async\\s+function\\s+${sym}\\b|const\\s+${sym}\\s*=\\s*async\\b)`).test(blankStrings(stripComments(src)))
      const unresolved = doors.filter((d) => !exportsDoor(raw(d.file), d.symbol)).map((d) => `${d.file}#${d.symbol}`)
      return {
        positive: doors.length >= 30 && journeys >= 15 && unresolved.length === 0,
        negative: !exportsDoor(`// TOMBSTONE: export async function ghostDoor() {}\nexport const x = 1`, "ghostDoor") && !exportsDoor(`const s = "export async function ghostDoor() {}"`, "ghostDoor") && exportsDoor(`export async function realDoor(id: string) { return { ok: true } }`, "realDoor"),
        detail: JSON.stringify({ doors: doors.length, journeys, unresolved }),
        note: `${journeys} journeys · ${doors.length} entry points, ${doors.length - unresolved.length} resolve`,
      }
    },
  },
  {
    id: "149J·R20", label: "lot_size_unit is accepted ONLY beside the lot size it describes (saveListingDraftAction): with the size it saves; alone, off-list, or with no size it is refused in words; m954's CHECK list = the action's list",
    run: async () => {
      const lk = await import("../app/actions/listings-kernel")
      const world = () => {
        const db = memSupabase({
          users: [{ id: JU, brokerage_id: JB, user_type: "agent", team_id: null }], agents: [{ id: "ag-149j", user_id: JU, brokerage_id: JB }],
          listings: [{ id: JL, brokerage_id: JB, agent_id: "ag-149j", lot_size: null, lot_size_unit: null, status: "draft" }],
          agent_action_ledger: [], lifecycle_events: [], self_heal_events: [], listing_history: [], activities: [],
        }, { uuidIds: true, stampCreatedAt: true })
        ;(db as any).auth = { getUser: async () => ({ data: { user: { id: JU } }, error: null }) }
        return db
      }
      const db = world()
      const run = (u: Record<string, unknown>, d: MemClient = db) => withSvc(d, () => quiet(() => lk.saveListingDraftAction({ listingId: JL, updates: u as never })))
      const ok = await run({ lot_size: 0.62, lot_size_unit: "acres" }) as any
      const alone = await run({ lot_size_unit: "acres" }, world()) as any
      const offList = await run({ lot_size: 2, lot_size_unit: "hectares" }, world()) as any
      const noSize = await run({ lot_size: null, lot_size_unit: "square_feet" }, world()) as any
      const l = rows(db, "listings")[0]
      const codeList = (/const LOT_SIZE_UNITS = \[([^\]]*)\]/.exec(code("app/actions/listings-kernel.ts"))?.[1]?.match(/["']([a-z_]+)["']/g) ?? []).map((s) => s.slice(1, -1))
      const mig = readdirSync(join(ROOT, "supabase/migrations")).find((f) => /^m954-/.test(f))
      const migList = mig ? ((/lot_size_unit IN \(([^)]*)\)/.exec(raw(`supabase/migrations/${mig}`).split("\n").map((x) => x.replace(/--.*$/, "")).join("\n"))?.[1]?.match(/'([a-z_]+)'/g)) ?? []).map((s) => s.slice(1, -1)) : []
      return {
        positive: ok.success === true && l.lot_size === 0.62 && l.lot_size_unit === "acres" && codeList.length === 2 && JSON.stringify([...codeList].sort()) === JSON.stringify([...migList].sort()),
        negative: alone.success === false && /together with the lot size/.test(alone.error) && offList.success === false && /not a lot-size unit/.test(offList.error) && noSize.success === false && /needs a lot size/.test(noSize.error),
        detail: JSON.stringify({ ok, alone, offList, noSize, listing: l, codeList, migList }),
      }
    },
  },
])

// ═════════════════════════════════════════════════════════════════════════════
// THE RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" WAVE 149 canaries (in-memory) — one group per lane, each canary POSITIVE + NEGATIVE")
  console.log("══════════════════════════════════════════════════════════════")
  let passed = 0, failed = 0
  const tally: string[] = []
  const failures: string[] = []
  for (const g of GROUPS) {
    console.log(`\n▶ ${g.lane} — ${g.title}`)
    let gp = 0, gf = 0
    for (const c of g.canaries) {
      let v: Verdict
      try { v = await c.run() } catch (e) { v = { positive: false, negative: false, detail: `THREW: ${(e as Error)?.stack ?? String(e)}` } }
      const ok = v.positive && v.negative
      if (ok) gp++; else gf++
      console.log(`  ${ok ? "✓" : "✗"} [${c.id}] ${c.label} — positive ${v.positive ? "✓" : "✗"} · negative ${v.negative ? "✓" : "✗"}`)
      if (v.note) console.log(`      note: ${v.note}`)
      if (!ok) { console.log(`      evidence: ${String(v.detail ?? "").slice(0, 1500)}`); failures.push(`[${c.id}] ${c.label}`) }
    }
    passed += gp; failed += gf
    tally.push(` ${gf === 0 ? "PASS" : "FAIL"}  ${g.lane}  ${gp}/${g.canaries.length}`)
  }
  console.log("\n──────────────────────────────────────────────────────────────")
  for (const t of tally) console.log(t)
  console.log(` measured: service-client mint attempts refused by the seam ${G.__W149.mints} · background echo rejections ${backgroundRejections.length} · kernel events recorded ${G.__W149.events.length}`)
  console.log(" blind spots: memSupabase has no CHECK/FK/RLS (applied m935/m937/m938/m942/m947/m954 columns live only in fixtures) · routes, React render")
  console.log("   and provider delivery not executed (each lane's own proof) · every model is scripted (the arbiter's CHOICE is not provable here) ·")
  console.log("   lane I is a docs + absence census (no module landed) · journey-audit doors resolved statically, not executed")
  if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(` RESULT: canaries ${passed} passed, ${failed} failed (${GROUPS.length} lanes)`)
  console.log(failed === 0 ? "WAVE149_CANARIES_PASS" : "WAVE149_CANARIES_FAIL")
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((e) => { console.error(e); console.log("WAVE149_CANARIES_FAIL"); process.exit(1) })
