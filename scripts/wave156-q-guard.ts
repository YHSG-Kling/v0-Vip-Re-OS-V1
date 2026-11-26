#!/usr/bin/env tsx
/**
 * scripts/wave156-q-guard.ts — THE RIGHT WORDS FOR EACH SUBSCRIBER SHAPE (wave 156, lane 156Q; directive 156A item 5).
 *
 * Owner: "a solo-agent tenant must not see `brokerage pays`, unless they actually are a brokerage; an office user acts for the
 * authorized tenant/team/office, not a generic brokerage." Words only — no identifier, stored value, role or permission moves.
 *
 * THE SURVIVORS (LAW 1, nothing new invented): the business kind is lib/errors resolveTenantPayer (the session tenant's own
 * brokerages.plan_tier — wave 152, lane 152A); the office is lib/kernel/resolve-user-office.ts resolveUserOffice (the one
 * "which office does this person work out of" answer). This lane EXTENDS them: tenantPayerWords (lib/errors, the one wording
 * helper — who PAYS vs who the reader ACTS FOR) and resolveSeatPayer (resolve-user-office.ts — the seat's office, named from
 * the tenant's own locations row). The payer RULE is the one in lib/errors TENANT_COPY_RULES (scope "payer"), widened here to
 * the phrases the census found ("brokerage covers", "brokerage pays out", "brokerage's subscription", "broker pays").
 *
 *   A  THE HELPER, RENDERED for six seats — solo agent, team, one-office brokerage, multi-location OFFICE seat (pinned),
 *      multi-location unpinned staff, unread tier: who pays vs who the reader acts for; a solo agent never reads "brokerage";
 *      an office seat reads its office as who it acts for and its BROKERAGE as who pays (an office never pays); unread = neutral.
 *   B  THE RESOLVER, DRIVEN on the in-memory client: users.location_id first, agents.location_id second (the module's own
 *      precedence); the office name is read pinned to the SESSION tenant (another tenant's office row is never named); a refused
 *      office read keeps the verified brokerage wording; a team / solo tenant never reads an office (0 locations reads); a
 *      refused tier read stays unknown (fail closed).
 *   C  THREE REAL SURFACES DRIVEN for every shape through their exported doors (session / acting-context / service-client seams
 *      replaced by fixtures; no model, provider or network): (1) getCommissionPayoutPolicyAction — the payout-timing choice;
 *      (2) getRevenueShareDistributionModel + setRevenueShareDistributionModel — the "who funds the share" choice and its
 *      refusal; (3) interpretIntentLive (rules only, allowModelAssist:false) — the assistant's authority reasons and plan.
 *      A solo agent never reads a brokerage-payer claim (RED AT BASE); a brokerage still does; an office seat reads its office.
 *   D  THE CENSUS (derived, comment-stripped, string-literal aware, entities decoded) of hard-coded payer wording over app/**
 *      and lib/**, with the rule DERIVED from lib/errors' own payer rule (never retyped). Published exclusions, each with its
 *      reason. Remaining outside the exclusions: must be 0. Positive controls: a planted string / JSX text is found, the same
 *      text in a comment is not. COMMISSION_PAYOUT_TIMING_LABEL (the brokerage spelling) is read only by the payer-aware label.
 *
 * BLIND SPOTS (published): the census rule is a phrase list — a payer claim in other words ("you're covered by the office")
 * is not seen; the BROADER owner noun "your brokerage" (≈480 stripped lines over app/** + lib/** — "not found in your
 * brokerage", "agents across your brokerage") is COUNTED AND PUBLISHED, not gated: it names the tenant, not a payer, and
 * moving each one needs the seat's shape at that render (the follow-up list in the lane report); React renders are not
 * executed — C drives the server actions whose strings the components render verbatim; resolveSeatPayer is the wording
 * input only and is never read for authority (asserted in A by the module text, not by a policy engine).
 *
 * RED AT BASE: WAVE156Q_ROOT=<the starting tree> loads that tree's modules (the "@/" alias resolves under it).
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const ROOT = process.env.WAVE156Q_ROOT || process.cwd()
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`}`) }
}
const read = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const decode = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&rsquo;/g, "'")

// ── module seams: session / acting context / service client are fixtures; the product code under test is real ──
const G = globalThis as any
G.__Q = { svc: null as MemClient | null, seat: null as null | { userId: string; brokerageId: string; userType: string }, model: 0 }
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const REPLACE: Record<string, string> = {
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__Q.svc }",
  "lib/agreements/session-actor.ts": "export async function resolveSessionActor(){ const s = globalThis.__Q.seat; return s ? { ok: true, actor: { userId: s.userId, agentId: null, brokerageId: s.brokerageId, userType: s.userType, isTenantPrincipal: true } } : { ok: false, error: 'unauthenticated' } }",
  "lib/supabase/server.ts": "const c = () => ({ auth: { getUser: async () => ({ data: { user: globalThis.__Q.seat ? { id: globalThis.__Q.seat.userId } : null }, error: null }) }, from: (t) => globalThis.__Q.svc.from(t) }); export async function createClient(){ return c() }; export async function createServerClient(){ return c() }",
  "lib/ai/models.ts": "export async function generateObjectRouted(){ globalThis.__Q.model++; throw new Error('fixture: no model') }; export async function generateTextRouted(){ globalThis.__Q.model++; throw new Error('fixture: no model') }",
}
/** Re-export the real module, then override the named seams (a local export shadows the star re-export). */
const OVERRIDE: Record<string, string> = {
  "lib/platform/acting-context.ts": "const c = () => { const s = globalThis.__Q.seat; return s ? { ok: true, userId: s.userId, agentId: null, brokerageId: s.brokerageId, userType: s.userType, isImpersonating: false, impersonatorUserId: null, actorUserId: s.userId } : { ok: false, error: 'Not authenticated' } }; export async function resolveActingContext(){ return c() }; export async function resolveWriteContext(){ return c() }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    if (rep) return { url: dataUrl(REPLACE[rep]), shortCircuit: true }
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})
const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)
const quiet = async <X,>(fn: () => Promise<X>): Promise<X | { threw: string }> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } catch (err) { return { threw: (err as Error)?.message ?? String(err) } } finally { console.warn = w; console.error = e; console.log = l }
}

// ── the world: one tenant per shape ──────────────────────────────────────────────────────────────────────────────────
type Shape = "solo" | "team" | "brokerage" | "office" | "multi_staff" | "unknown"
const SEATS: Record<Shape, { brokerageId: string; userId: string; userType: string }> = {
  // The solo / team OWNER is provisioned as `admin` wearing an agents row (lib/kernel/manager-registry.ts seat_bands_and_paid_activation).
  solo: { brokerageId: "b-solo", userId: "u-solo", userType: "admin" },
  team: { brokerageId: "b-team", userId: "u-team", userType: "admin" },
  brokerage: { brokerageId: "b-brk", userId: "u-brk", userType: "broker" },
  office: { brokerageId: "b-multi", userId: "u-office", userType: "broker" },
  multi_staff: { brokerageId: "b-multi", userId: "u-multi", userType: "broker" },
  unknown: { brokerageId: "b-null", userId: "u-null", userType: "admin" },
}
function world(opts: Parameters<typeof memSupabase>[1] = {}): MemClient {
  return memSupabase({
    brokerages: [
      { id: "b-solo", plan_tier: "solo_agent", name: "Jo Agent" }, { id: "b-team", plan_tier: "team", name: "Lake Team" },
      { id: "b-brk", plan_tier: "brokerage", name: "Oak Realty" }, { id: "b-multi", plan_tier: "multi_location", name: "Pine Realty" },
      { id: "b-null", plan_tier: null, name: "Unread" }, { id: "b-other", plan_tier: "multi_location", name: "Other Realty" },
    ],
    users: [
      { id: "u-solo", brokerage_id: "b-solo", user_type: "admin", location_id: null },
      { id: "u-team", brokerage_id: "b-team", user_type: "admin", location_id: null },
      { id: "u-brk", brokerage_id: "b-brk", user_type: "broker", location_id: null },
      { id: "u-office", brokerage_id: "b-multi", user_type: "broker", location_id: "loc-dt" },
      { id: "u-multi", brokerage_id: "b-multi", user_type: "broker", location_id: null },
      { id: "u-null", brokerage_id: "b-null", user_type: "admin", location_id: null },
      { id: "u-agentpin", brokerage_id: "b-multi", user_type: "agent", location_id: null },
      { id: "u-foreign", brokerage_id: "b-multi", user_type: "broker", location_id: "loc-foreign" },
    ],
    agents: [
      { id: "a-agentpin", user_id: "u-agentpin", brokerage_id: "b-multi", location_id: "loc-north" },
      { id: "a-team", user_id: "u-team", brokerage_id: "b-team", location_id: "loc-north" },
    ],
    locations: [
      { id: "loc-dt", brokerage_id: "b-multi", name: "Downtown" },
      { id: "loc-north", brokerage_id: "b-multi", name: "North Office" },
      { id: "loc-foreign", brokerage_id: "b-other", name: "Elsewhere" },
    ],
  }, opts)
}
const locationReads = (m: MemClient) => (m as any).__locReads ?? 0

async function main() {
  const E = await load("lib/errors/index.ts")
  const payerRuleOk = (text: string, payer: unknown) => (E.tenantCopyVerdict(text, { payer }) as { ok: boolean }).ok

  // ═══ A — the helper ═══════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\nA — the wording helper, rendered for six seats")
  const W = (p: unknown) => (typeof E.tenantPayerWords === "function" ? E.tenantPayerWords(p) : null)
  check("lib/errors exports the ONE wording helper (tenantPayerWords) beside the ONE payer resolver (resolveTenantPayer)", typeof E.tenantPayerWords === "function" && typeof E.resolveTenantPayer === "function")
  const solo = W({ kind: "solo" }), team = W({ kind: "team" }), brk = W({ kind: "brokerage" }), office = W({ kind: "brokerage", office: "Downtown" }), unk = W({ kind: "unknown" }), none = W(null)
  const all = (w: any) => w ? Object.values(w).filter((v) => typeof v === "string").join(" | ") : ""
  check("solo agent: pays = 'you pay', acts for 'you', never the word brokerage", !!solo && solo.payerPays === "you pay" && solo.actingFor === "you" && solo.payer === "your account" && !/brokerage/i.test(all(solo)), all(solo))
  check("team: pays = 'the team pays', acts for 'your team', asks 'your team lead', never the word brokerage", !!team && team.payerPays === "the team pays" && team.actingFor === "your team" && team.askWho === "your team lead" && !/brokerage/i.test(all(team)), all(team))
  check("brokerage: pays = 'the brokerage pays', acts for 'your brokerage', asks 'your broker'", !!brk && brk.payerPays === "the brokerage pays" && brk.actingFor === "your brokerage" && brk.askWho === "your broker", all(brk))
  check("office seat: ACTS FOR its office ('the Downtown office'); who PAYS stays its brokerage (an office never pays)", !!office && office.actingFor === "the Downtown office" && office.actingForPossessive === "the Downtown office's" && office.payer === "your brokerage" && office.payerPays === "the brokerage pays", all(office))
  check("an office already named '… Office' is not doubled ('the North Office', never 'office office')", W({ kind: "brokerage", office: "North Office" })?.actingFor === "the North Office")
  check("an office on a NON-brokerage payer is ignored (a team / solo tenant carries no offices)", W({ kind: "team", office: "Downtown" })?.actingFor === "your team" && W({ kind: "solo", office: "Downtown" })?.actingFor === "you")
  check("unread tier (unknown / absent): actor-neutral ('your account'), never brokerage — fail closed", !!unk && !!none && unk.payer === "your account" && none.payerPays === "your account pays" && !/brokerage/i.test(all(unk) + all(none)))
  check("the payer rule (lib/errors TENANT_COPY_RULES) refuses each payerPays phrase that is not the reader's: 'the brokerage pays it' fails for solo / team / unknown, passes for a brokerage", !payerRuleOk("The brokerage pays it", { kind: "solo" }) && !payerRuleOk("The brokerage pays it", { kind: "team" }) && !payerRuleOk("The brokerage pays it", undefined) && payerRuleOk("The brokerage pays it", { kind: "brokerage" }))
  check("positive controls for the widened phrases: 'brokerage covers', 'brokerage pays out', 'the brokerage's subscription', 'broker pays' are each refused for a solo payer", ["Your grant in this brokerage covers it.", "This brokerage pays out at closing.", "AI is unavailable: the brokerage's subscription does not cover it.", "The broker pays the fee."].every((s) => !payerRuleOk(s, { kind: "solo" })))

  // ═══ B — the seat resolver ════════════════════════════════════════════════════════════════════════════════════════
  console.log("\nB — resolveSeatPayer (the office a seat acts for), driven on the in-memory client")
  const O = await load("lib/kernel/resolve-user-office.ts")
  const seatPayer = async (m: MemClient, b: string | null, u: string | null) => (typeof O.resolveSeatPayer === "function" ? O.resolveSeatPayer(m, b, u) : null)
  check("lib/kernel/resolve-user-office.ts exports resolveSeatPayer (beside resolveUserOffice — the one office answer)", typeof O.resolveSeatPayer === "function")
  {
    const m = world()
    const [pSolo, pTeam, pBrk, pOffice, pMulti, pNull, pAgentPin, pForeign] = await Promise.all([
      seatPayer(m, "b-solo", "u-solo"), seatPayer(m, "b-team", "u-team"), seatPayer(m, "b-brk", "u-brk"), seatPayer(m, "b-multi", "u-office"),
      seatPayer(m, "b-multi", "u-multi"), seatPayer(m, "b-null", "u-null"), seatPayer(m, "b-multi", "u-agentpin"), quiet(() => seatPayer(m, "b-multi", "u-foreign")),
    ])
    check("kinds come from each tenant's own plan tier: solo · team · brokerage · brokerage · unknown", pSolo?.kind === "solo" && pTeam?.kind === "team" && pBrk?.kind === "brokerage" && pMulti?.kind === "brokerage" && pNull?.kind === "unknown", { pSolo, pTeam, pBrk, pMulti, pNull })
    check("users.location_id pins the office seat → office 'Downtown'; an unpinned brokerage seat names no office", pOffice?.office === "Downtown" && !pMulti?.office && !pBrk?.office, { pOffice, pMulti })
    check("agents.location_id is the second source (the module's own precedence) → 'North Office'", pAgentPin?.office === "North Office", pAgentPin)
    check("a pin pointing at ANOTHER tenant's office row is never named (the name read is pinned to the session tenant)", !!pForeign && !(pForeign as any).office && (pForeign as any).kind === "brokerage", pForeign)
    check("a team tenant never reads an office, even with an agents.location_id (team / solo carry no offices)", pTeam?.kind === "team" && !pTeam?.office)
    const refused = world({ refuse: { locations: "permission denied for table locations" } })
    const pRef = await quiet(() => seatPayer(refused, "b-multi", "u-office"))
    check("a REFUSED office read keeps the verified brokerage wording (no invented office, no unknown)", (pRef as any)?.kind === "brokerage" && !(pRef as any)?.office, pRef)
    const tierRefused = world({ refuse: { brokerages: "permission denied for table brokerages" } })
    const pTier = await quiet(() => seatPayer(tierRefused, "b-multi", "u-office"))
    check("a REFUSED tier read stays unknown → actor-neutral words (fail closed, never the brokerage reading)", (pTier as any)?.kind === "unknown", pTier)
    const src = stripComments(read("lib/kernel/resolve-user-office.ts"))
    const body = src.slice(Math.max(0, src.indexOf("export async function resolveSeatPayer")))
    check("resolveSeatPayer reuses the two survivors (resolveTenantPayer, resolveUserOffice) and writes nothing", /resolveTenantPayer\(/.test(body) && /resolveUserOffice\(svc, userId\)/.test(body) && !/\.(?:insert|update|upsert|delete)\(/.test(body))
    void locationReads
  }

  // ═══ C — three real surfaces, every shape ═════════════════════════════════════════════════════════════════════════
  console.log("\nC — three real surfaces driven for every shape")
  const CP: any = await quiet(() => load("app/actions/commission-policy/commission-policy.ts"))
  const RS: any = await quiet(() => load("app/actions/settings/revenue-share-setting.ts"))
  const LIVE: any = await quiet(() => load("lib/voice-admin/intent-interface-live.ts"))
  check("the three surface modules load (a crash here is a failure, never a skip)", !CP?.threw && !RS?.threw && !LIVE?.threw, [CP?.threw, RS?.threw, LIVE?.threw].filter(Boolean).join(" | "))
  const SHAPES: Shape[] = ["solo", "team", "brokerage", "office", "multi_staff", "unknown"]
  const payerOf: Record<Shape, unknown> = { solo: { kind: "solo" }, team: { kind: "team" }, brokerage: { kind: "brokerage" }, office: { kind: "brokerage" }, multi_staff: { kind: "brokerage" }, unknown: { kind: "unknown" } }
  const isBrokerage = (s: Shape) => s === "brokerage" || s === "office" || s === "multi_staff"
  const texts: Record<Shape, string[]> = { solo: [], team: [], brokerage: [], office: [], multi_staff: [], unknown: [] }
  for (const s of SHAPES) {
    G.__Q.svc = world(); G.__Q.seat = SEATS[s]
    // (1) the payout-timing choice
    const cp: any = await quiet(() => CP.getCommissionPayoutPolicyAction())
    const receipt = (cp?.timingOptions ?? []).find((o: any) => o.value === "after_brokerage_receipt")?.label ?? `<<${cp?.error ?? cp?.threw ?? "no label"}>>`
    // (2) who funds the revenue share — the choice and the refusal
    G.__Q.svc = world()
    const rs: any = await quiet(() => RS.getRevenueShareDistributionModel())
    const funding = rs?.fundingLabel ?? `<<${rs?.error ?? rs?.threw ?? "no fundingLabel"}>> The brokerage pays it`
    const bad: any = await quiet(() => RS.setRevenueShareDistributionModel({ sourceOfFunds: "nobody", rateType: "percent", percent: 5, durationMonths: 0 } as never))
    const refusal = bad?.error ?? `<<${bad?.threw ?? "no refusal"}>>`
    // (3) the assistant: authority reasons + plan (rules only; the seat's words resolved inside interpretIntentLive)
    G.__Q.svc = world()
    const actor = { userId: SEATS[s].userId, userType: SEATS[s].userType, platformRole: null, agentId: null }
    const tenant = { brokerageId: SEATS[s].brokerageId }
    const ad: any = await quiet(() => LIVE.interpretIntentLive({ utterance: "create an ad for 12 Oak Street", modality: "text", actor, tenant, allowModelAssist: false }))
    const buyers: any = await quiet(() => LIVE.interpretIntentLive({ utterance: "find buyers interested in acreage", modality: "text", actor, tenant, allowModelAssist: false }))
    const tcActor = { ...actor, userId: `${SEATS[s].userId}-tc`, userType: "tc" }
    const refusedAd: any = await quiet(() => LIVE.interpretIntentLive({ utterance: "create an ad for 12 Oak Street", modality: "text", actor: tcActor, tenant, allowModelAssist: false }))
    const grantedAd: any = await quiet(() => LIVE.interpretIntentLive({ utterance: "create an ad for 12 Oak Street", modality: "text", actor: { ...tcActor, grantedRoles: ["agent"] }, tenant, allowModelAssist: false }))
    const approver = [...(ad?.authority_check?.reasons ?? []), ad?.plan?.approval ?? ""].filter((r: string) => /approver/i.test(r)).join(" ")
    const across = (buyers?.plan?.steps ?? []).find((x: string) => /^Across /.test(x)) ?? "<<no 'Across' step>>"
    const askLine = (refusedAd?.authority_check?.reasons ?? []).join(" ")
    const grantLine = (grantedAd?.authority_check?.reasons ?? []).find((r: string) => /grant/.test(r)) ?? "<<no grant line>>"
    texts[s] = [receipt, funding, refusal, approver, across, askLine, grantLine]
    console.log(`  · ${s}: ${texts[s].map((t) => JSON.stringify(t)).join(" · ").slice(0, 900)}`)
  }
  check("no model was called by any rules-only interpretation (counted seam)", G.__Q.model === 0, G.__Q.model)
  for (const s of SHAPES) {
    const t = texts[s].join(" \n ")
    const gateClean = texts[s].every((x) => payerRuleOk(x, payerOf[s]))
    if (!isBrokerage(s)) {
      check(`${s}: never reads a brokerage-payer claim on the three surfaces (payout timing · revenue-share funding + refusal · assistant)`, gateClean && !/\bbrokerage\b/i.test(t), t)
    } else {
      check(`${s}: still reads its brokerage as the payer ('the brokerage pays' on the payout choice and the funding choice)`, gateClean && /then the brokerage pays the agent/.test(texts[s][0]) && texts[s][1] === "The brokerage pays it" && /the brokerage pays it directly/.test(texts[s][2]), t)
    }
  }
  check("solo: 'You pay it' / the solo payout sentence / 'Your approver' / 'Across your buyer contacts' / 'ask an admin on your account' / 'grant in this account'", texts.solo[1] === "You pay it" && /^After the commission is received/.test(texts.solo[0]) && /\byour approver\b/i.test(texts.solo[3]) && texts.solo[4] === "Across your buyer contacts you can see." && /ask an admin on your account/.test(texts.solo[5]) && /grant in this account covers it/.test(texts.solo[6]), texts.solo)
  check("team: 'The team pays it' / 'the team pays its agents' / 'your team's approver' / 'Across your team's buyer contacts' / 'ask your team lead' / 'grant in this team'", texts.team[1] === "The team pays it" && /the team pays its agents/.test(texts.team[0]) && /your team's approver/i.test(texts.team[3]) && texts.team[4] === "Across your team's buyer contacts you can see." && /ask your team lead/.test(texts.team[5]) && /grant in this team covers it/.test(texts.team[6]), texts.team)
  check("office seat: acts for ITS OFFICE ('Across the Downtown office's buyer contacts you can see.') while the brokerage stays the payer and approver", texts.office[4] === "Across the Downtown office's buyer contacts you can see." && /your brokerage's approver/i.test(texts.office[3]) && /ask your broker\b/.test(texts.office[5]), texts.office)
  check("unpinned multi-location staff acts for the brokerage (no office invented)", texts.multi_staff[4] === "Across your brokerage's buyer contacts you can see." && !/office/i.test(texts.multi_staff[4]), texts.multi_staff[4])
  check("unread tier: actor-neutral ('Your account pays it', 'Across your buyer contacts', 'ask an admin on your account'), never brokerage", texts.unknown[1] === "Your account pays it" && texts.unknown[4] === "Across your buyer contacts you can see." && /ask an admin on your account/.test(texts.unknown[5]) && !/\bbrokerage\b/i.test(texts.unknown.join(" ")), texts.unknown)
  check("positive control for the narrowed subscription phrase: a platform-staff lookup ('any brokerage's subscription tier') is not a payer claim; 'the brokerage's subscription' is", payerRuleOk("Look up any brokerage's subscription tier", { kind: "solo" }) && !payerRuleOk("the brokerage's subscription does not cover it", { kind: "solo" }))

  // ═══ D — the census ═══════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\nD — the census of hard-coded payer wording (derived rule, stripped source)")
  const errSrc = stripComments(read("lib/errors/index.ts"))
  const lit = errSrc.match(/scope: "payer", re: \/(.+?)\/([a-z]*), why:/)
  const RULE = lit ? new RegExp(lit[1], lit[2]) : null
  check("the census rule is DERIVED from lib/errors' own payer rule (TENANT_COPY_RULES scope 'payer'), not retyped", !!RULE)
  const rule = RULE ?? /(?!)/
  const scanText = (src: string) => decode(stripComments(src)).split("\n").map((l, i) => ({ i: i + 1, l })).filter((x) => rule.test(x.l))
  check("positive control: a planted string literal, a planted JSX text and a planted template are each FOUND", scanText(`const a = "AI usage is billed to your brokerage"\n`).length === 1 && scanText(`return <p>The brokerage pays it</p>\n`).length === 1 && scanText("const m = `the brokerage's subscription does not cover ${x}`\n").length === 1)
  check("negative control: the same phrases inside // and /* */ and {/* */} comments are NOT found (strip-comments is the scanner)", scanText(`// billed to your brokerage\n/* the brokerage pays it */\nconst x = 1 {/* brokerage covers */}\n`).length === 0)
  /** Published exclusions — each with its reason; matched per LINE (file + a pattern of the excluded line), never a whole tree. */
  const EXCLUDE: Array<{ file: RegExp; line: RegExp; why: string }> = [
    { file: /^lib\/errors\/index\.ts$/, line: /payerPays:|scope: "payer"/, why: "THE helper itself: its brokerage branch ('the brokerage pays') is read only for a verified brokerage payer" },
    { file: /^lib\/transactions\/cda-closing-policy\.ts$/, line: /after_brokerage_receipt: "/, why: "the brokerage spelling of the payout label — read only by commissionPayoutTimingLabel's brokerage branch (asserted below)" },
    { file: /^lib\/kernel\/manager-registry\.ts$/, line: /./, why: "the manager registry's internal ownership prose (integrator-owned; rendered only into platform-staff architecture docs)" },
    { file: /^lib\/billing\/stripe-account-scope\.ts$/, line: /says: "/, why: "the platform's Stripe money-path roster — read by the payment seam and its guard, never rendered to a tenant" },
    { file: /^lib\/agents\/asset-manager\.ts$/, line: /Compositions reachable at this brokerage's subscription tier/, why: "a manager MODEL PROMPT line (the Asset Manager's snapshot) — never rendered to a person" },
  ]
  const walk = (d: string): string[] => existsSync(join(ROOT, d)) ? readdirSync(join(ROOT, d)).flatMap((n) => { const p = `${d}/${n}`; const st = statSync(join(ROOT, p)); return st.isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.tsx?$/.test(n) ? [p] : [] }) : []
  const files = [...walk("app"), ...walk("lib")]
  const hits = files.flatMap((f) => scanText(read(f)).map((x) => ({ f, i: x.i, l: x.l.trim() })))
  const excluded = hits.filter((h) => EXCLUDE.some((e) => e.file.test(h.f) && e.line.test(h.l)))
  const remaining = hits.filter((h) => !excluded.includes(h))
  console.log(`  · denominator: ${files.length} files under app/** + lib/** (comment-stripped, entities decoded); ${hits.length} payer-claim line(s) found; ${excluded.length} under a published exclusion:`)
  for (const e of EXCLUDE) { const n = excluded.filter((h) => e.file.test(h.f) && e.line.test(h.l)); if (n.length) console.log(`      ${n.map((h) => `${h.f}:${h.i}`).join(", ")} — ${e.why}`) }
  check(`no hard-coded payer claim remains outside the published exclusions (${remaining.length} found)`, remaining.length === 0, remaining.map((h) => `${h.f}:${h.i} ${h.l.slice(0, 140)}`).join(" | "))
  const labelReaders = files.filter((f) => f !== "lib/transactions/cda-closing-policy.ts").filter((f) => /\bCOMMISSION_PAYOUT_TIMING_LABEL\b/.test(stripComments(read(f))))
  const cdaSrc = stripComments(read("lib/transactions/cda-closing-policy.ts"))
  const fnAt = cdaSrc.indexOf("export function commissionPayoutTimingLabel")
  check("the brokerage payout sentence (COMMISSION_PAYOUT_TIMING_LABEL) has no reader outside commissionPayoutTimingLabel", labelReaders.length === 0 && fnAt > 0 && /case "brokerage": return COMMISSION_PAYOUT_TIMING_LABEL\.after_brokerage_receipt/.test(cdaSrc.slice(fnAt)), labelReaders.join(", ") || "label fn missing")
  check("positive control: the label-reader finder flags the pre-change commission-policy shape", /\bCOMMISSION_PAYOUT_TIMING_LABEL\b/.test("label: COMMISSION_PAYOUT_TIMING_LABEL[value],"))
  // The BROADER owner noun — counted and published (blind spot), not gated.
  const OWNER_NOUN = /\byour brokerage\b/i
  const ownerLines = files.flatMap((f) => decode(stripComments(read(f))).split("\n").filter((l) => OWNER_NOUN.test(l)).map(() => f))
  console.log(`  · published, not gated: ${ownerLines.length} stripped line(s) in ${new Set(ownerLines).size} file(s) still name the tenant "your brokerage" (an owner noun, not a payer claim) — the follow-up list is in the lane report`)

  // ═══ E — round 2: the owner noun, by who can reach the surface ════════════════════════════════════════════════════
  console.log("\nE — the owner noun ('your brokerage' / 'across … brokerage' / 'the brokerage's'), split by who can reach it")
  // E1 the session seat's words, DRIVEN per shape (what every rewired server page resolves once and passes down).
  const OW: any = await quiet(() => load("lib/kernel/resolve-user-office.ts"))
  const sessionWords: Record<string, any> = {}
  for (const s of SHAPES) {
    G.__Q.svc = world(); G.__Q.seat = SEATS[s]
    sessionWords[s] = typeof OW?.resolveSessionSeatWords === "function" ? await quiet(() => OW.resolveSessionSeatWords()) : null
  }
  G.__Q.seat = null
  const anon: any = typeof OW?.resolveSessionSeatWords === "function" ? await quiet(() => OW.resolveSessionSeatWords()) : null
  check("resolveSessionSeatWords (session → users.brokerage_id → resolveSeatPayer → tenantPayerWords): solo 'your account' · team 'your team' · brokerage 'your brokerage' · office seat acts for 'the Downtown office' · unread and no session actor-neutral",
    sessionWords.solo?.payer === "your account" && sessionWords.solo?.actingFor === "you" && sessionWords.team?.payer === "your team" && sessionWords.brokerage?.payer === "your brokerage"
      && sessionWords.office?.actingFor === "the Downtown office" && sessionWords.office?.payer === "your brokerage" && sessionWords.unknown?.payer === "your account" && anon?.payer === "your account",
    JSON.stringify({ solo: sessionWords.solo?.payer, team: sessionWords.team?.payer, office: sessionWords.office?.actingFor, anon: anon?.payer ?? anon }))
  // E2 the classifier. WHO CAN REACH a line — derived, never listed:
  //   (d) NEVER RENDERED — the line is a log call or a model prompt (console.* / logger.* / prompt / "You are"), or the file
  //       is a prompt module (lib/ai/**, *prompt*);
  //   (c) PLATFORM STAFF — the file sits under a superadmin route, or calls the platform gate (lib/auth/platform-guard.ts:
  //       requirePlatformStaff / requireSuperadmin / requirePlatformCapability / requireProviders / requireMarketing);
  //   (b) BROKERAGE STAFF ONLY — the file gates on an OFFICE-CARRYING tier (tierCarriesOffices / a plan_tier test naming
  //       brokerage or multi_location). A ROLE gate does NOT make a page brokerage-only: the solo / team OWNER is
  //       provisioned `admin`, which is in TENANT_ADMIN_USER_TYPES (read below from lib/auth/resolve-user-role.ts, the same
  //       roster test:page-role-gate-roster reads) — so a page gated on the tenant roster is solo-reachable;
  //   (e) VENDOR / CONTACT PORTALS — app/vendor/**, app/portal/**, app/lender/**, app/title/**, vendor-invite (not a
  //       solo / team principal; counted separately);
  //   (a) everything else under app/** and lib/** — reachable by a solo or team principal.
  const roster = (() => { const src = stripComments(read("lib/auth/resolve-user-role.ts")); const at = src.indexOf("export const TENANT_ADMIN_USER_TYPES = new Set(["); return at < 0 ? [] : [...src.slice(at, src.indexOf("])", at)).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) })()
  check("premise, derived: the solo / team owner's seat type `admin` is in the tenant roster, so a roster-gated page is solo-reachable", roster.includes("admin") && roster.length >= 4, roster.join(","))
  const OWNER = /\byour brokerage\b|\bacross (?:the|your) brokerage\b|\bthe brokerage's\b/i
  const NEVER_LINE = /console\.(?:log|warn|error|info|debug)\(|\blogger\.|\bprompt\b|systemPrompt|You are |role:\s*["']system["']/i
  const NEVER_FILE = /^lib\/ai\/|prompt/i
  const PLATFORM_FILE = /(?:^|\/)superadmin(?:\/|-|\.)|^app\/(?:dashboard\/)?platform\//
  const PLATFORM_GATE = /\b(?:requirePlatformStaff|requireSuperadmin|requirePlatformCapability|requireProviders|requireMarketing)\(/
  const OFFICE_TIER_GATE = /\btierCarriesOffices\(|plan_tier\s*(?:===|!==)\s*["'](?:brokerage|multi_location)["']/
  const PORTAL_FILE = /^app\/(?:vendor|portal|lender|title|vendor-invite)\//
  type Cat = "a" | "b" | "c" | "d" | "e"
  const classify = (f: string, stripped: string, line: string): Cat =>
    NEVER_LINE.test(line) || NEVER_FILE.test(f) ? "d" : PLATFORM_FILE.test(f) || PLATFORM_GATE.test(stripped) ? "c" : OFFICE_TIER_GATE.test(stripped) ? "b" : PORTAL_FILE.test(f) ? "e" : "a"
  const ownerScan = (f: string, src: string) => { const st = decode(stripComments(src)); return st.split("\n").map((l, i) => ({ f, i: i + 1, l })).filter((x) => OWNER.test(x.l)).map((x) => ({ ...x, cat: classify(f, st, x.l) })) }
  // Positive controls: one planted specimen per category.
  const plant = (f: string, src: string) => ownerScan(f, src)[0]?.cat ?? null
  check("positive control: a planted 'your brokerage' on a solo-reachable settings page is found and classified (a)", plant("app/settings/planted/page.tsx", `export default function P(){ return <p>Agents across your brokerage</p> }\n`) === "a")
  check("positive controls: superadmin path → (c); platform-gated file → (c); office-tier-gated → (b); a console line → (d); a vendor portal → (e); the same text in a comment → not found",
    plant("app/dashboard/superadmin/x/page.tsx", `<p>your brokerage</p>\n`) === "c" && plant("app/actions/x.ts", `await requirePlatformStaff()\nreturn "in your brokerage"\n`) === "c"
      && plant("app/dashboard/x/page.tsx", `if (!tierCarriesOffices(tier)) redirect("/")\nreturn <p>your brokerage</p>\n`) === "b" && plant("app/actions/y.ts", `console.error("refused for your brokerage")\n`) === "d"
      && plant("app/vendor/x/page.tsx", `<p>Agents in your brokerage</p>\n`) === "e" && plant("app/settings/z/page.tsx", `// your brokerage\n/* across your brokerage */\n`) === null)
  const ownerHits = files.flatMap((f) => ownerScan(f, read(f)))
  const byCat = (c: Cat) => ownerHits.filter((h) => h.cat === c)
  // The surfaces this lane rewired (round 2) — every owner noun on them now follows the seat (or reads actor-neutral).
  const REWIRED = [
    "app/settings/commission/page.tsx", "app/components/settings/BenefitOfferingsCard.tsx", "app/settings/users/users-management-client.tsx",
    "app/settings/developers/page.tsx", "app/settings/developers/developers-client.tsx", "app/settings/providers/page.tsx",
    "app/components/ai-identity/AIIdentityEditor.tsx", "app/dashboard/agent/referral-network/page.tsx", "app/dashboard/agent/referral-network/referral-network-client.tsx",
    "app/dashboard/education/page.tsx", "app/dashboard/education/client-learning-panel.tsx", "app/dashboard/vendors/vendor-directory-client.tsx",
    "app/components/forms/form-selector-step.tsx",
  ]
  const rewiredHits = byCat("a").filter((h) => REWIRED.includes(h.f))
  check(`the ${REWIRED.length} rewired solo-reachable surfaces carry no hard-coded owner noun (${rewiredHits.length} found)`, rewiredHits.length === 0, rewiredHits.map((h) => `${h.f}:${h.i} ${h.l.trim().slice(0, 100)}`).join(" | "))
  const PASSES_WORDS: Array<[string, RegExp]> = [
    ["app/settings/developers/page.tsx", /resolveSessionSeatWords\(\)[\s\S]*words=\{words\}/], ["app/settings/users/page.tsx", /words=\{await resolveSessionSeatWords\(\)\}/],
    ["app/dashboard/agent/referral-network/page.tsx", /resolveSessionSeatWords\(\)[\s\S]*words=\{words\}/], ["app/dashboard/education/page.tsx", /resolveSessionSeatWords\(\)[\s\S]*words=\{words\}/],
    ["app/dashboard/vendors/page.tsx", /words=\{await resolveSessionSeatWords\(\)\}/], ["app/dashboard/admin/ai-identity/page.tsx", /words=\{await resolveSessionSeatWords\(\)\}/],
  ]
  const missingPass = PASSES_WORDS.filter(([f, re]) => !re.test(stripComments(read(f)))).map(([f]) => f)
  check("each rewired server page resolves the seat's words ONCE and passes them down (stripped source)", missingPass.length === 0, missingPass.join(", "))
  const clientResolvers = REWIRED.filter((f) => /^\s*["']use client["']/.test(read(f))).filter((f) => /resolveSessionSeatWords|resolveSeatPayer|resolveTenantPayer/.test(stripComments(read(f))))
  check("no client component calls a resolver itself", clientResolvers.length === 0, clientResolvers.join(", "))
  const top = (c: Cat) => Object.entries(byCat(c).reduce<Record<string, number>>((m, h) => { m[h.f] = (m[h.f] ?? 0) + 1; return m }, {})).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([f, n]) => `${f}(${n})`).join(", ")
  console.log(`  · census over ${files.length} files: ${ownerHits.length} owner-noun line(s) — (a) solo/team-reachable ${byCat("a").length} · (b) brokerage-staff-only ${byCat("b").length} · (c) platform staff ${byCat("c").length} · (d) never rendered ${byCat("d").length} · (e) vendor/contact portals ${byCat("e").length}`)
  console.log(`  · (a) is NOT yet zero — published, not gated (the burn-down list, largest first): ${top("a")}`)
  console.log(`  · (a) by tree: app/actions ${byCat("a").filter((h) => h.f.startsWith("app/actions/")).length} · app/api ${byCat("a").filter((h) => h.f.startsWith("app/api/")).length} · other app ${byCat("a").filter((h) => h.f.startsWith("app/") && !/^app\/(?:actions|api)\//.test(h.f)).length} · lib ${byCat("a").filter((h) => h.f.startsWith("lib/")).length}`)

  console.log(`\nWAVE 156Q — SUBSCRIBER-SHAPE WORDS — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ WAVE156_Q_PASS" : "❌ WAVE156_Q_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error("wave156-q guard crashed:", e); process.exit(1) })
