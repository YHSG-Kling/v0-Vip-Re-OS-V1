#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fixtures and fake clients, the repo's proof idiom */
/**
 * scripts/wave150-canaries.ts — `npx tsx --conditions=react-server scripts/wave150-canaries.ts`
 *                                (wave 150, lane 150J2; key: test:wave150-canaries, added by lane 150I2)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OWNER'S 19 MANDATORY CANARIES (WAVE150_DIRECTIVE.md "Mandatory canaries and failure tests"), numbered as the directive
 * numbers them, each title quoted in short. Run on the INTEGRATED tree (batches 1 + 2). Every canary calls the lanes' REAL
 * exported survivors (imported, never re-implemented) and carries BOTH halves of a measurement (CLAUDE.md §2):
 *   · POSITIVE — the built behaviour holds on a well-formed input, through the survivor the lane named;
 *   · NEGATIVE — the forbidden outcome is refused / absent / counted, and the finder still SEES the defect (positive control).
 * A canary passes only when both halves pass. Every canary also prints its BLIND SPOT line — the live-only part (Supabase Auth,
 * RLS / storage policies, Stripe, providers, Vercel) that no in-memory run can observe.
 *
 * HONEST STATES. Where a canary's subject is a decision the owner has not made, or a capability a lane recorded as PARTIAL /
 * WAITING_EXTERNAL / UNSUPPORTED, the canary asserts the HONEST state (the refusal, the dormant adapter, the NOT OBSERVED gate
 * row, the carried item with its owner) and says so in its verdict column ("honest-state") — never a pass that pretends the
 * capability is live. Canaries 18 and 19 are status censuses: they DERIVE each item's state from the tree on every run.
 *
 * SEAM (the wave-149 canaries' shape, copied): node:module registerHooks stubs `server-only`, `next/cache`, `@/lib/kernel/emit`
 * (records into memory), the notification fan-out, the contact enrichment queue and the Meta Graph transport; it points
 * `@/lib/supabase/service` / `@/lib/supabase/server` at the canary's own memSupabase client — and at NOTHING (a throw, COUNTED)
 * by default. memSupabase (scripts/in-memory-supabase.ts) resolves refusals like supabase-js and models `.select()` on writes.
 * Every source scan reads STRIPPED source (scripts/strip-comments.ts). Each canary imports inside its own body, so one broken
 * import fails that canary (with its stack), never the run. This file never prints the chain runner's exit token.
 *
 * BLIND SPOTS (published beside the number): memSupabase enforces no CHECK / FK / RLS / storage policy; Supabase Auth, Stripe,
 * Twilio, Lob, Meta, Google, RentCast, Exa, Tracerfy, DataZapp and Vercel are never called (each is a stub or an injected seam);
 * every model is scripted; React / HTTP routes are read as stripped source, not rendered or invoked.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

// ── the seam: no real client can ever be minted (the default throws); a canary may hand in its own in-memory one ──
const G = globalThis as any
G.__W150 = { svc: null as MemClient | null, events: [] as unknown[], mints: 0, graph: [] as Array<{ method: string; path: string; body?: unknown }>, graphReply: null as null | ((m: string, p: string) => unknown) }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export function createServiceClient(){ const s = globalThis.__W150.svc; if (!s) { globalThis.__W150.mints++; throw new Error('wave150-canaries: no service client — fake clients only (hand one in)') } return s }; export const createClient = createServiceClient",
  "@/lib/supabase/server": "export async function createClient(){ const s = globalThis.__W150.svc; if (!s) throw new Error('wave150-canaries: no session client — fake clients only'); return s }; export const createServerClient = createClient",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export function isKernelEventValue(){ return true }; export async function emitKernelEvent(i){ globalThis.__W150.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__W150.events.length, fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null, error: null } }",
  "@/lib/kernel/notification-engine": "export async function processKernelEvent(e){ globalThis.__W150.events.push({ fanout: true, ...e }) }",
  "@/lib/enrichment/contact-enrichment-core": "export async function queueContactEnrichment(p){ const s = p.supabase ?? globalThis.__W150.svc; if (s) await s.from('lead_enrichment_queue').insert({ contact_id: p.contactId, brokerage_id: p.brokerageId, status: 'pending', trigger_type: p.triggerType }); return { queued: true } }",
  "@/lib/providers/meta/client":
    "const rec = (method, segs, body) => { const path = Array.isArray(segs) ? segs.join('/') : String(segs); globalThis.__W150.graph.push({ method, path, body }); const r = globalThis.__W150.graphReply ? globalThis.__W150.graphReply(method, path) : {}; return { ok: true, status: 200, data: r, error: null } };" +
    "export const graphGet = async (t, segs, q) => rec('GET', segs, q); export const graphPost = async (t, segs, b) => rec('POST', segs, b);",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})
// The kernel's fire-and-forget echoes reach the throwing default client — counted, never fatal.
const backgroundRejections: string[] = []
process.on("unhandledRejection", (e) => { backgroundRejections.push(String((e as Error)?.message ?? e).slice(0, 160)) })
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
// NO LIVE SPEND: no provider key is ever present in a canary.
for (const k of ["LOB_API_KEY", "LOB_TEST_API_KEY", "RENTCAST_API_KEY", "EXA_API_KEY", "TRACERFY_API_KEY", "DATAZAPP_API_KEY", "PROPERTYRADAR_API_TOKEN", "BATCHDATA_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "STRIPE_SECRET_KEY"]) delete process.env[k]

const ROOT = process.cwd()
const raw = (p: string): string => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const code = (p: string): string => stripComments(raw(p))
const rows = (c: MemClient | any, t: string): any[] => ((c as any).tables[t] ?? []) as any[]
/** Run with an in-memory client behind createServiceClient() / createClient(), then put the throwing default back. */
async function withSvc<T>(svc: MemClient | null, fn: () => Promise<T>): Promise<T> {
  const prev = G.__W150.svc
  G.__W150.svc = svc
  try { return await fn() } finally { G.__W150.svc = prev }
}
/** Silence a module's own console noise during a call (its refusals are read from the result, not the log). */
async function quiet<T>(f: () => Promise<T>): Promise<T> {
  const w = console.warn, e = console.error, l = console.log, i = console.info
  console.warn = () => {}; console.error = () => {}; console.log = () => {}; console.info = () => {}
  try { return await f() } finally { console.warn = w; console.error = e; console.log = l; console.info = i }
}

/** verdict: "built" (the capability works in memory) or "honest-state" (the canary asserts the refusal / dormancy / NOT OBSERVED
 *  state a lane recorded — PARTIAL, WAITING_EXTERNAL, owner decision). `note` is printed on a PASS too. */
export interface Verdict { positive: boolean; negative: boolean; detail?: string; note?: string; state?: "built" | "honest-state" }
export interface Canary { n: number; title: string; positiveHalf: string; negativeHalf: string; blindSpot: string; run: () => Promise<Verdict> }
const CANARIES: Canary[] = []
const canary = (c: Canary) => CANARIES.push(c)
// wave 151 (lane 151L): the wave-151 runner REUSES these canaries by import (scripts/wave151-canaries.ts) — the roster, the
// seam helpers and the background-rejection counter are exported; main() runs only when this file is the entry script.
export const WAVE150_CANARIES: readonly Canary[] = CANARIES
export { withSvc, quiet, backgroundRejections }

// ═════════════════════════════════════════════════════════════════════════════
// 1 — "Solo created by staff and self-enrolled; team with seats, brokerage with office, brokerage with two same-name locations and
//      distinct teams all provision … Consent migration/proration never merges independent solo affiliation on string name."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 1, title: "Solo (staff + self), team, brokerage, two same-name locations all provision; a string name never merges",
  positiveHalf: "createTenantCore → provisionTenantStructure for five tenants: snapshot, website, owner invite, one subscription, tenant leadership; two offices both named \"Coastal Realty\" with distinct ids and their own teams; office heads scoped to their own office (resolveViewerHierarchy)",
  negativeHalf: "the self-enrolled solo declaring affiliation \"Coastal Realty\" holds zero memberships in the same-name brokerage, is refused as a viewer, and provisionTenantStructure refuses to place it (only the consented transfer rail moves a person)",
  blindSpot: "Supabase Auth invite delivery and Stripe checkout are injected seams; RLS on organization_members is not exercised; O-150C-1 (legacy UNIQUE) not modelled",
  run: async () => {
    const { createTenantCore, provisionTenantStructure } = await import("../lib/kernel/tenant-creation")
    const { resolveViewerHierarchy } = await import("../lib/kernel/resolve-user-office")
    const TIERS = ["solo_agent", "team", "brokerage", "multi_location"]
    const base: any = memSupabase({
      subscription_tiers: TIERS.map((t) => ({ id: randomUUID(), tier_name: t, is_active: true, max_agents: t === "solo_agent" ? 2 : t === "team" ? 10 : null, monthly_price_cents: 0, annual_price_cents: 0, setup_fee_cents: 0, display_name: t })),
      platform_config_snapshots: TIERS.map((t) => ({ id: randomUUID(), name: `${t} funnel`, created_at: "2026-10-01T00:00:00.000Z", payload: { recommendedTier: t, global: { app_name: "VIP" }, brand: { tagline: `${t} tagline` }, site: { about_text: "about" }, features: [] } })),
      learning_modules: [], brokerages: [], users: [], subscriptions: [], global_settings: [], brokerage_brand_settings: [], brand_voice_profile: [],
      feature_access_overrides: [], platform_prospects: [], ai_identity_profiles: [], agents: [], learning_assignments: [], user_invitations: [], teams: [],
      user_role_assignments: [], agent_onboarding: [], agent_commission_profiles: [], superadmin_audit_log: [], brokerage_settings: [],
      lifecycle_events: [], manager_signals: [], notifications: [], agent_action_ledger: [], organization_members: [], locations: [],
    }, { uuidIds: true, stampCreatedAt: true })
    base.rpc = async () => ({ data: null, error: null })
    const orig = base.from.bind(base)
    base.from = (table: string) => {
      const q: any = orig(table)
      if (table === "manager_signals") { const ins = q.insert.bind(q); q.insert = (p: any) => ins(Array.isArray(p) ? p.map((r: any) => ({ status: "open", ...r })) : { status: "open", ...p }) }
      return q
    }
    const svc = base as MemClient
    const invites: string[] = []
    const STAFF = randomUUID()
    svc.tables.users.push({ id: STAFF, email: "staff@platform.test", user_type: "agent", platform_role: "platform_admin", brokerage_id: null })
    const deps = {
      provisionOwner: async (p: any) => { const id = randomUUID(); svc.tables.users.push({ id, email: p.email, first_name: p.firstName, last_name: p.lastName, user_type: p.tier === "solo_agent" || p.tier === "team" ? "agent" : "broker_owner", brokerage_id: p.brokerageId, status: "active" }); invites.push(p.email); return { success: true, userId: id, agentId: null, teamId: null, inviteSent: true } },
      isaActor: async () => ({}), starterAssistant: async () => ({}), curriculum: async () => ({ authored: 0, topics: 0 }),
      accountRepair: async () => ({ success: true, repaired: [] }),
      readiness: async () => ({ ready: true, blockers: [], checkedAt: new Date().toISOString() }),
      checkout: async () => ({ ok: true, url: "https://checkout.example.test/s/1", setupFeeCents: 0, setupFeeWaived: false }),
      structure: { invite: async (a: any) => { const id = randomUUID(); svc.tables.users.push({ id, email: a.email, first_name: a.firstName, last_name: a.lastName, user_type: a.userType, brokerage_id: a.brokerageId, team_id: a.teamId, location_id: null, status: "active" }); invites.push(a.email); return { success: true, userId: id } } },
    } as any
    const make = async (input: any) => { try { return await createTenantCore(svc as never, { adminLastName: "Lee", ...input }, deps) } catch (e) { return { ok: false, error: `threw: ${(e as Error).message}` } as any } }
    return withSvc(svc, () => quiet(async () => {
      const soloStaff = await make({ brokerageName: "Maya Brooks Homes", adminEmail: "maya@solo.test", adminFirstName: "Maya", tier: "solo_agent", signupSource: "superadmin", billing: { mode: "active", billingCycle: "monthly" }, callerUserId: STAFF })
      const soloSelf = await make({ brokerageName: "Coastal Realty", adminEmail: "sam@solo.test", adminFirstName: "Sam", tier: "solo_agent", signupSource: "self_serve", billing: { mode: "trial", trialDays: 14 }, callerUserId: null, declaredAffiliation: { name: "Coastal Realty", licenseState: "FL" } })
      const team = await make({ brokerageName: "Ridgeline Team", adminEmail: "lead@team.test", adminFirstName: "Rae", tier: "team", signupSource: "self_serve", billing: { mode: "trial" }, callerUserId: null, structure: { members: [{ email: "a1@team.test", firstName: "Ana", userType: "agent", teamName: "Ridgeline Team" }] } })
      const brk = await make({ brokerageName: "Gulf Shore Brokerage", adminEmail: "owner@gulf.test", adminFirstName: "Gil", tier: "brokerage", signupSource: "self_serve", billing: { mode: "paid", billingCycle: "monthly" }, callerUserId: null,
        structure: { offices: [{ officeCode: "main", name: "Gulf Shore Brokerage", legalName: "Gulf Shore Brokerage LLC", licenseNumber: "CQ1234", licenseState: "FL", city: "Pensacola", state: "FL" }], members: [{ email: "agent@gulf.test", firstName: "Gia", userType: "agent", officeCode: "main" }] } })
      const multi = await make({ brokerageName: "Coastal Realty", adminEmail: "owner@coastal.test", adminFirstName: "Cora", tier: "multi_location", signupSource: "superadmin", billing: { mode: "active", billingCycle: "annual" }, callerUserId: STAFF,
        structure: {
          offices: [
            { officeCode: "dt", name: "Coastal Realty", legalName: "Coastal Realty Downtown LLC", licenseNumber: "CQ9001", licenseState: "FL", city: "Pensacola", state: "FL", brandOverrides: { primary_color: "#0b3d91" }, teams: [{ name: "Harbor Team" }] },
            { officeCode: "bch", name: "Coastal Realty", legalName: "Coastal Realty Beaches LLC", licenseNumber: "CQ9002", licenseState: "FL", city: "Navarre", state: "FL", brandOverrides: { primary_color: "#7a1f1f" }, teams: [{ name: "Ridge Team" }] },
          ],
          members: [
            { email: "head.dt@coastal.test", firstName: "Dee", userType: "broker", officeCode: "dt", officeLeadership: true },
            { email: "head.bch@coastal.test", firstName: "Bea", userType: "broker", officeCode: "bch", officeLeadership: true },
          ],
        } })
      const all = { soloStaff, soloSelf, team, brk, multi } as Record<string, any>
      const mems = (b: string, u?: string) => rows(svc, "organization_members").filter((m) => m.brokerage_id === b && (!u || m.user_id === u) && !m.revoked_at)
      const sub = (b: string) => rows(svc, "subscriptions").filter((s) => s.brokerage_id === b)
      const provisioned = Object.entries(all).filter(([, r]) => {
        const b = rows(svc, "brokerages").find((x) => x.id === r.brokerageId)
        return r.ok === true && !!b && r.snapshotName === `${b.plan_tier} funnel` && /^\/site\//.test(r.websitePath ?? "") && invites.includes(String(b.email)) && sub(r.brokerageId).length === 1
          && mems(r.brokerageId, r.userId).some((m) => m.scope_kind === "tenant" && m.access_level === "leadership")
      }).map(([k]) => k)
      const offices = rows(svc, "locations").filter((l) => l.brokerage_id === multi.brokerageId)
      const dt = offices.find((o) => o.office_code === "dt"), bch = offices.find((o) => o.office_code === "bch")
      const teamsOf = (loc: string | undefined) => rows(svc, "teams").filter((t) => t.brokerage_id === multi.brokerageId && t.location_id === loc)
      const user = (e: string) => rows(svc, "users").find((u) => u.email === e)
      const sDt = await resolveViewerHierarchy(svc as never, { userId: user("head.dt@coastal.test")?.id, brokerageId: multi.brokerageId })
      const crossRead = await resolveViewerHierarchy(svc as never, { userId: soloSelf.userId, brokerageId: multi.brokerageId })
      const capture = await provisionTenantStructure(svc as never, { brokerageId: multi.brokerageId, tier: "multi_location", ownerUserId: multi.userId, brokerageName: "Coastal Realty", actorUserId: multi.userId, source: "admin_grant", input: { members: [{ existingUserId: soloSelf.userId, userType: "agent", locationId: dt?.id }] } } as never, { report: async () => ({}) } as never)
      const affiliation = rows(svc, "brokerages").find((b) => b.id === soloSelf.brokerageId)?.declared_affiliation?.name
      return {
        positive: provisioned.length === 5 && offices.length === 2 && offices.every((o) => o.name === "Coastal Realty") && !!dt && !!bch && dt.id !== bch.id && teamsOf(dt?.id).length === 1 && teamsOf(bch?.id).length === 1
          && sDt.ok && (sDt as any).scope.locationIds.join() === dt?.id && !(sDt as any).scope.aggregate,
        negative: affiliation === "Coastal Realty" && mems(multi.brokerageId, soloSelf.userId).length === 0 && !crossRead.ok && /not a member/.test((crossRead as any).error ?? "")
          && !(capture as any).complete && /consented transfer rail/.test((capture as any).members?.[0]?.error ?? "") && mems(multi.brokerageId, soloSelf.userId).length === 0,
        detail: JSON.stringify({ provisioned, errs: Object.fromEntries(Object.entries(all).map(([k, r]) => [k, r.ok ? null : r.error])), offices: offices.length, sDt, crossRead, cap: (capture as any).members?.[0] }),
        note: `${provisioned.length}/5 tenants provisioned (solo staff, solo self, team, brokerage, multi-location); ${invites.length} invites dispatched in-request (seam); same-name offices: ${offices.length}`,
        state: "built",
      }
    }))
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — "Cross-tenant/cross-location RLS: contacts, raw leads, offices, media, mail proofs, QR, support tickets, portals, search
//      autocomplete, events, provider token and nested seat views negative tested."
// ═════════════════════════════════════════════════════════════════════════════
const SA = "00000000-0000-4000-8000-0000000150a0", SM = "00000000-0000-4000-8000-0000000150d0", SB = "00000000-0000-4000-8000-0000000150b0"
const SO1 = "00000000-0000-4000-8000-0000000150e1", SO2 = "00000000-0000-4000-8000-0000000150e2"
function searchWorld(refuse?: Record<string, string>): MemClient {
  return memSupabase({
    brokerages: [{ id: SA, plan_tier: "brokerage" }, { id: SM, plan_tier: "multi_location" }, { id: SB, plan_tier: "brokerage" }],
    users: [
      { id: "u-broker", brokerage_id: SA, user_type: "broker", location_id: null }, { id: "u-a1", brokerage_id: SA, user_type: "agent", location_id: null },
      { id: "u-head", brokerage_id: SM, user_type: "broker", location_id: null }, { id: "u-m1", brokerage_id: SM, user_type: "agent", location_id: SO1 },
    ],
    locations: [{ id: SO1, brokerage_id: SM, status: "active", managing_broker_user_id: "u-head" }, { id: SO2, brokerage_id: SM, status: "active", managing_broker_user_id: null }],
    teams: [], organization_members: [], user_role_assignments: [], team_members: [],
    agents: [
      { id: "ag-a1", brokerage_id: SA, user_id: "u-a1", location_id: null, team_id: null }, { id: "ag-a2", brokerage_id: SA, user_id: "u-a2", location_id: null, team_id: null },
      { id: "ag-m1", brokerage_id: SM, user_id: "u-m1", location_id: SO1, team_id: null }, { id: "ag-m2", brokerage_id: SM, user_id: "u-m2", location_id: SO2, team_id: null },
    ],
    contacts: [
      { id: "c-a1", brokerage_id: SA, agent_id: "ag-a1", location_id: null, team_id: null, first_name: "Ann", last_name: "Smith", email: "ann@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-a2", brokerage_id: SA, agent_id: "ag-a2", location_id: null, team_id: null, first_name: "Anna", last_name: "Jones", email: "anna@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-b", brokerage_id: SB, agent_id: null, location_id: null, team_id: null, first_name: "Ann", last_name: "Other", email: "ann@b.test", phone: null, city: "Dallas", deleted_at: null },
      { id: "c-m1", brokerage_id: SM, agent_id: "ag-m1", location_id: SO1, team_id: null, first_name: "Annika", last_name: "One", email: "a1@m.test", phone: null, city: "Tampa", deleted_at: null },
      { id: "c-m2", brokerage_id: SM, agent_id: "ag-m2", location_id: SO2, team_id: null, first_name: "Annette", last_name: "Two", email: "a2@m.test", phone: null, city: "Miami", deleted_at: null },
    ],
    leads: [
      { id: "l-pool", brokerage_id: SA, agent_id: null, first_name: "Annie", last_name: "Pool", email: "pool@x.test", phone: null, city: "Austin", lead_stage: "new" },
      { id: "l-a1", brokerage_id: SA, agent_id: "ag-a1", first_name: "Annabel", last_name: "Mine", email: "mine@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
      { id: "l-a2", brokerage_id: SA, agent_id: "ag-a2", first_name: "Annalise", last_name: "Theirs", email: "theirs@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
      { id: "l-m1", brokerage_id: SM, agent_id: "ag-m1", first_name: "Annora", last_name: "Office1", email: "o1@m.test", phone: null, city: "Tampa", lead_stage: "qualified" },
      { id: "l-m2", brokerage_id: SM, agent_id: "ag-m2", first_name: "Annis", last_name: "Office2", email: "o2@m.test", phone: null, city: "Miami", lead_stage: "qualified" },
    ],
    listings: [
      { id: "ls-a2", brokerage_id: SA, agent_id: "ag-a2", location_id: null, team_id: null, address: "12 Annapolis St", city: "Austin", state: "TX", zip: "78701", status: "active", mls_number: "M1", deleted_at: null },
      { id: "ls-b", brokerage_id: SB, agent_id: null, location_id: null, team_id: null, address: "9 Annapolis Rd", city: "Dallas", state: "TX", zip: "75001", status: "active", mls_number: "M9", deleted_at: null },
      { id: "ls-m1", brokerage_id: SM, agent_id: "ag-m1", location_id: SO1, team_id: null, address: "1 Annex Way", city: "Tampa", state: "FL", zip: "33601", status: "active", mls_number: "M2", deleted_at: null },
      { id: "ls-m2", brokerage_id: SM, agent_id: "ag-m2", location_id: SO2, team_id: null, address: "2 Annex Way", city: "Miami", state: "FL", zip: "33101", status: "active", mls_number: "M3", deleted_at: null },
    ],
  }, { refuse })
}
canary({
  n: 2, title: "Cross-tenant / cross-location isolation negative-tested (search autocomplete, contacts, raw leads, offices, seat views)",
  positiveHalf: "searchScopedRecords (the header box's survivor, session client) returns the broker's whole tenant, the agent's own contact + assigned lead, the office head's office-1 records; egress scope pins each same-name office head to its own office id",
  negativeHalf: "tenant B's same-name contact / listing never appear; the agent never sees the raw lead pool or a colleague's lead; office 2 is invisible to office 1's head; a foreign tenant claim, a contact seat and a refused scope read all refuse; a 'superadmin' user_type never widens",
  blindSpot: "memSupabase has NO RLS: the DB policies (m999 views, contacts / leads / media / mail / QR / support / portal / tokens) are judged by test:cross-office-rls against the live catalogue; storage-bucket policies are O1 owner SQL; DB-level office isolation does not exist (code-side only — lane 150BAA Still open 3)",
  run: async () => {
    const mod = await import("../lib/search/scoped-record-search")
    const { resolveEgressScope, scopeFilter } = await import("../lib/kernel/egress-scope")
    const run = (userId: string, b: string, t: string | null, db = searchWorld(), q = "ann") => mod.searchScopedRecords(db as never, { userId, brokerageId: b, userType: t, platformRole: null }, q)
    const ids = (h: Array<{ id: string }>) => h.map((x) => x.id).sort().join(",")
    return quiet(async () => {
      const br: any = await run("u-broker", SA, "broker"), ag: any = await run("u-a1", SA, "agent"), hd: any = await run("u-head", SM, "broker")
      const foreign = await run("u-broker", SB, "broker"), ct = await run("u-contact", SA, "contact")
      const refused = await run("u-broker", SA, "broker", searchWorld({ organization_members: "permission denied for table organization_members" }))
      const inj: any = await run("u-a1", SA, "agent", searchWorld(), "ann,agent_id.is.null")
      const h1 = scopeFilter(resolveEgressScope({ userType: "admin", userId: "h1", brokerageId: SM, locationId: SO1 }))
      const h2 = scopeFilter(resolveEgressScope({ userType: "admin", userId: "h2", brokerageId: SM, locationId: SO2 }))
      const su = resolveEgressScope({ userType: "superadmin", userId: "s", brokerageId: SM })
      return {
        positive: br.ok && ids(br.contacts) === "c-a1,c-a2" && ids(br.leads) === "l-a1,l-a2,l-pool" && ids(br.listings) === "ls-a2"
          && ag.ok && ids(ag.contacts) === "c-a1" && ids(ag.leads) === "l-a1" && hd.ok && ids(hd.contacts) === "c-m1" && ids(hd.listings) === "ls-m1" && ids(hd.leads) === "l-m1"
          && h1.location_id === SO1 && h2.location_id === SO2,
        negative: !br.contacts.some((c: any) => c.id === "c-b") && !br.listings.some((l: any) => l.id === "ls-b") && !ag.leads.some((l: any) => l.id === "l-pool" || l.id === "l-a2")
          && !hd.contacts.some((c: any) => c.id === "c-m2") && !foreign.ok && !ct.ok && !refused.ok && inj.ok && !inj.leads.some((l: any) => l.id === "l-pool")
          && h1.location_id !== h2.location_id && su.kind === "agent" && !su.seesAllLocations,
        detail: JSON.stringify({ br, ag, hd, foreign, ct, refused, h1, h2, su }),
        note: "searched 3 tenants × 4 seats; refusals: foreign claim, contact seat, refused scope read, injected filter neutralised",
        state: "built",
      }
    })
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — "Ten replayed acquisition events produce one original observation and at most one paid lookup/Lead promotion; no orphaned
//      writer; same property may be lawfully researched per tenant without sharing person details."
// ═════════════════════════════════════════════════════════════════════════════
const T1 = "11111111-1111-4111-8111-111111111150", T2 = "22222222-2222-4222-8222-222222222150", MARKET = "33333333-3333-4333-8333-333333333150"
const rawRec = (over: Record<string, unknown> = {}) => ({
  sourceRecordId: `reddit-${Date.now()}-${Math.random()}`, source: "reddit_relocation", behaviorType: "social_intent", intentType: "buyer", intentSignals: ["moving to"],
  firstName: "Dana", lastName: "Whitfield", email: "dana.whitfield@example.org", city: "Pensacola", state: "FL", zip: "32501",
  sourceUrl: "https://www.reddit.com/r/Pensacola/comments/abc", rawPayload: { title: "Moving to Pensacola", text: "Looking for a neighbourhood near the base", created_utc: Math.floor(Date.now() / 1000) - 3600 },
  ...over,
}) as any
const rawDb = () => memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [] }, { unique: { raw_scraped_leads: [["idempotency_key"]] } })
const GEO = { city: "Pensacola", state: "FL", zip_codes: ["32501"] }
canary({
  n: 3, title: "Ten replayed acquisition events → one observation, ≤1 paid lookup / Lead promotion; per-tenant research, no shared person",
  positiveHalf: "ingestRawSourceBatch (THE one RawData producer) given the same observation ten times (each with a fresh clock/random source id) writes ONE row (9 counted as replays) with one pending row for processRawRecord; two tenants researching one observation get one row each",
  negativeHalf: "ten DISTINCT events stay ten (the key is not a constant); a source no vendor contract names is refused (skipped_rights); the stripped-source writer census finds raw_scraped_leads written only by the producer (+ the demo seed) — and the finder sees a planted writer",
  blindSpot: "the live global UNIQUE (source, source_record_id) is an owner DROP INDEX (m961 footer) — modelled, not live; provider-side paid lookups are not exercised (processRawRecord's at-most-once rests on the one pending row)",
  run: async () => {
    const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
    return quiet(async () => {
      const db1 = rawDb()
      let replayed = 0, inserted = 0
      for (let i = 0; i < 10; i++) { const r = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [rawRec()], executionId: "exec-1", marketGeo: GEO, client: db1 as any } as any); replayed += r.replayed; inserted += r.inserted }
      const dbD = rawDb()
      const distinct = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: Array.from({ length: 10 }, (_, i) => rawRec({ envelope: { externalEventId: `evt-${i}` } })), executionId: "exec-1", marketGeo: GEO, client: dbD as any } as any)
      const dbT = rawDb()
      for (const b of [T1, T2]) await ingestRawSourceBatch({ brokerageId: b, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [rawRec({ sourceRecordId: "reddit-t3_same" })], executionId: "e", marketGeo: GEO, client: dbT as any } as any)
      const dbR = rawDb()
      const unk = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "mystery_feed", sourceFamily: "x", sourceChannel: "mystery_feed", records: [rawRec({ source: "mystery_feed" })], executionId: "e", marketGeo: GEO, client: dbR as any } as any)
      const writerRe = /from\(\s*['"]raw_scraped_leads['"]\s*\)\s*\.(insert|upsert)\(/
      const { readdirSync, statSync } = await import("node:fs")
      const walk = (d: string, out: string[] = []): string[] => { if (!existsSync(join(ROOT, d))) return out; for (const n of readdirSync(join(ROOT, d))) { if (n === "node_modules" || n.startsWith(".")) continue; const p = `${d}/${n}`; if (statSync(join(ROOT, p)).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p) } return out }
      const writers = [...walk("lib"), ...walk("app")].filter((f) => writerRe.test(code(f)))
      const r1 = rows(db1, "raw_scraped_leads")
      const tenants = new Set(rows(dbT, "raw_scraped_leads").map((r) => r.brokerage_id))
      return {
        positive: r1.length === 1 && inserted === 1 && replayed === 9 && r1.filter((r) => r.processing_status === "pending").length === 1 && !!r1[0]?.idempotency_key && rows(dbT, "raw_scraped_leads").length === 2 && tenants.size === 2,
        negative: distinct.inserted === 10 && unk.skipped_rights === 1 && rows(dbR, "raw_scraped_leads").length === 0
          && writers.length > 0 && writers.every((f) => f === "lib/kernel/scraping.ts" || f === "lib/platform/deal-room-demo.ts") && writerRe.test(`await svc.from("raw_scraped_leads").insert({ x: 1 })`),
        detail: JSON.stringify({ rows: r1.length, inserted, replayed, distinct: distinct.inserted, unk, writers }),
        note: `10 replays → ${r1.length} row (${replayed} replays counted); raw_scraped_leads writers in app/ + lib/: ${writers.join(", ")}`,
        state: "built",
      }
    })
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 — "Licensed verified owner with complete required identity may become a Lead; anonymous market article yields topic/educational
//      candidate only; consented tenant form becomes one Contact, portal invitation immediate, welcome video asynchronous."
// ═════════════════════════════════════════════════════════════════════════════
const LA = "00000000-0000-4000-8000-0000000150aa", AGENT_A = "00000000-0000-4000-8000-00000150a001"
function leadDoorWorld(extra: Record<string, any[]> = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: LA, name: "Alpha Realty", plan_tier: "brokerage" }],
    agents: [{ id: AGENT_A, brokerage_id: LA, user_id: "u-a1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" }],
    users: [{ id: "u-a1", first_name: "Ann", last_name: "Agent" }],
    qr_codes: [{ id: "qr-a", brokerage_id: LA, agent_id: AGENT_A, slug: "spring" }],
    contacts: [], leads: [], contact_consent_events: [], lead_enrichment_queue: [], manager_signals: [], agent_action_ledger: [], lifecycle_events: [],
    manager_completions: [], person_identities: [], person_identity_evidence: [], lead_score_history: [], assignment_rules: [], transactions: [],
    activities: [], notifications: [], contact_suppression_list: [], platform_suppression_list: [], compliance_events: [], teams: [], contact_lead_history: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], contact_consent_events: [["brokerage_id", "idempotency_key"]] } } as never)
}
canary({
  n: 4, title: "Verified owner may become a Lead; anonymous article → topic only; consented form → ONE Contact, invite immediate, video async",
  positiveHalf: "evaluateCanonicalLeadEligibility admits an owner / person with first + last + usable email; captureConsentedContact writes ONE contact owned by the creating agent, runs the portal invite FIRST and commissions the welcome video LAST; the same person's open lead is closed onto it",
  negativeHalf: "market / anonymous_question / property / LLC / job_civic_event subjects are refused at the Lead door (failing = subject); an unknown subject spelling refuses; a returning person merges and receives NO second invite, welcome or video; no lead row is written for the form",
  blindSpot: "the real portal-invite core, welcome letter and avatar-video spine are injected effects (their own proofs: test:conversion-welcome, test:welcome-avatar-video); real invite email delivery is Supabase Auth (live only)",
  run: async () => {
    const cle = await import("../lib/lead-pipeline/canonical-lead-eligibility")
    const cap = await import("../lib/contact-pipeline/contact-capture")
    const C = await import("../lib/kernel/compliance/consent-component")
    const full = { first_name: "Dana", last_name: "Whitfield", email: "dana.whitfield@example.org" }
    const OPEN_LEAD = "00000000-0000-4000-8000-0000150ead01"
    const svc = leadDoorWorld({ leads: [{ id: OPEN_LEAD, brokerage_id: LA, first_name: "Pat", last_name: "Lee", email: "pat@example.test", is_active: true, contact_id: null, lead_stage: "new" }] })
    const order: string[] = []
    const effects = {
      notify: (async () => {}) as never,
      portalInvite: async (p: { contactId: string }) => { order.push(`invite:${p.contactId}`) },
      welcome: async (_s: unknown, c: { id: string }) => { order.push(`welcome:${c.id}`) },
      welcomeVideo: async (_s: unknown, p: { contactId: string }) => { order.push(`video:${p.contactId}`) },
      enrich: async () => { order.push("enrich") },
    }
    return withSvc(null, () => quiet(async () => {
      const sub = C.consentSubmissionFor({ serviceDelivery: true, marketing: { email: true, sms: false, voice: false, direct_mail: false } } as never, { door: "qr_landing", brandName: "Alpha Realty" } as never)
      const g = cap.consentGrantsFromComponent(sub as never, { door: "qr_landing", brandName: "Alpha Realty", provided: { email: true, phone: false } } as never)
      const r: any = await cap.captureConsentedContact({ brokerageId: LA, ownerAgentId: AGENT_A, creatorUserId: "u-a1", source: "qr_scan", first_name: "Pat", last_name: "Lee", email: "pat@example.test", consents: (g as any).grants, intake: { capturedAt: "2026-11-06T10:00:00.000Z", channel: "qr", evidence: { ...(g as any).evidence, qr_code_id: "qr-a" }, formOwner: { table: "qr_codes", id: "qr-a" } } } as never, { client: svc, effects } as never)
      const sends = () => order.filter((o) => /^(invite|welcome|video):/.test(o)).length
      const n = sends()
      const firstOrder = [...order]
      const again: any = await cap.captureContact({ brokerageId: LA, source: "web_form", first_name: "Pat", last_name: "Lee", email: "PAT@example.test", tcpa_consent: false } as never, { client: svc, effects } as never)
      const iI = firstOrder.indexOf(`invite:${r.contactId}`), iW = firstOrder.indexOf(`welcome:${r.contactId}`), iV = firstOrder.indexOf(`video:${r.contactId}`)
      const evidenceKinds = ["market", "anonymous_question", "property", "entity_trust_estate", "job_civic_event"]
      return {
        positive: cle.evaluateCanonicalLeadEligibility({ ...full, subject_kind: "owner" } as never).eligible && cle.evaluateCanonicalLeadEligibility({ ...full, subject_kind: "person" } as never).eligible
          && r.ok && rows(svc, "contacts").length === 1 && rows(svc, "contacts")[0].agent_id === AGENT_A && iI >= 0 && iI < iW && iI < firstOrder.indexOf("enrich") && iV === firstOrder.length - 1
          && rows(svc, "leads").length === 1 && rows(svc, "leads")[0].contact_id === r.contactId && rows(svc, "leads")[0].is_active === false,
        negative: evidenceKinds.every((k) => { const v: any = cle.evaluateCanonicalLeadEligibility({ ...full, subject_kind: k } as never); return !v.eligible && v.failing === "subject" })
          && cle.subjectKindLeadProblem("persn" as never) !== null && again.action === "merged" && again.contactId === r.contactId && sends() === n && rows(svc, "contacts").length === 1,
        detail: JSON.stringify({ r: { ok: r.ok, id: r.contactId, w: r.warnings }, order, again: { a: again.action, id: again.contactId } }),
        note: `effect order on create: ${firstOrder.map((o) => o.split(":")[0]).join(" → ")} (the merge re-queues enrichment only — no second invite / welcome / video); ${evidenceKinds.length} evidence subject kinds refused at the Lead door`,
        state: "built",
      }
    }))
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 — "Two providers disagree about owner/person: preserve conflict, source and quality; no quiet overwrite of tenant/customer-
//      confirmed phone; do not charge twice for duplicate known results."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 5, title: "Two providers disagree: conflict preserved with sources; confirmed phone never quietly overwritten; no double charge",
  positiveHalf: "verifyOwnership returns CONFLICT for two licensed sources naming different owners (and VERIFIED for two agreeing authoritative sources); mergeSourceFacts keeps the held phone, records the offered phone as a conflict naming both sources, fills a gap, corroborates an equal value; isFresh reuses a fresh provider answer",
  negativeHalf: "the pre-150 merge expression (enriched || existing) is shown overwriting the confirmed phone (positive control) and is ABSENT from the live merge path (stripped source); a protected field cannot be made overwritable; a stale / malformed capture is not fresh (re-ask, never reuse a guess); the pre-enrichment duplicate park sits BEFORE the paid enrichment",
  blindSpot: "no live provider is called; conflicts on the merge path land on lead_deduplication_log.match_details (no UI reads them yet — lane 150EFG Still open 4)",
  run: async () => {
    const id = await import("../lib/identity/subject-identity")
    const pd = await import("../lib/enrichment/provider-dedup")
    const person = { firstName: "Maria", lastName: "Lopez", mailingAddress: "9 Bay Dr", zip: "32501" }
    const conflict = id.verifyOwnership(person as never, [{ source: "batchdata", rights: "licensed_vendor", ownerName: "Maria Lopez" }, { source: "rentcast", rights: "licensed_vendor", ownerName: "Robert Chen" }] as never)
    const verified = id.verifyOwnership(person as never, [{ source: "batchdata", rights: "licensed_vendor", ownerName: "LOPEZ MARIA" }, { source: "county_recorder", rights: "public_record", ownerName: "Maria G Lopez" }] as never)
    const held = { phone: "(850) 555-1111", email: "maria@lopez.org", first_name: "Maria", last_name: null }
    const offered = { phone: "850-555-9999", email: "MARIA@LOPEZ.ORG", first_name: "Maria", last_name: "Lopez" }
    const m: any = id.mergeSourceFacts(held as never, offered as never, { heldSource: "contact_record", incomingSource: "batchdata+enrichment" } as never)
    const forced: any = id.mergeSourceFacts(held as never, offered as never, { heldSource: "a", incomingSource: "b", overwritable: ["phone"] } as never)
    const naive = { phone: offered.phone || held.phone }
    const now = new Date("2026-11-06T00:00:00Z")
    const pp = code("lib/lead-pipeline/pipeline-processor.ts")
    const forbidden = /phone:\s*enriched\.phone\s*\|\|\s*postEnrichDuplicate\.phone/
    const preAt = pp.indexOf("duplicate_pre_enrich"), spendAt = pp.indexOf("await enrichWithPeopleData(")
    return {
      positive: (conflict as any).verdict === "conflict" && (verified as any).verdict === "verified" && !("phone" in m.patch)
        && m.conflicts.some((c: any) => c.field === "phone" && c.kept === "(850) 555-1111" && c.offered === "850-555-9999" && c.keptSource === "contact_record" && c.offeredBy === "batchdata+enrichment")
        && m.patch.last_name === "Lopez" && m.corroborated.includes("email") && pd.isFresh("2026-10-20T00:00:00Z", pd.PROVIDER_FRESHNESS_DAYS.peopledata_profile, now),
      negative: naive.phone === "850-555-9999" && !forbidden.test(pp) && forbidden.test("        phone:                 enriched.phone || postEnrichDuplicate.phone,") && !("phone" in forced.patch)
        && !pd.isFresh("2025-01-01T00:00:00Z", pd.PROVIDER_FRESHNESS_DAYS.peopledata_profile, now) && !pd.isFresh("not-a-date", 90, now) && !pd.isFresh("2026-12-01T00:00:00Z", 90, now)
        && preAt > 0 && spendAt > preAt,
      detail: JSON.stringify({ conflict, verified, m, preAt, spendAt }),
      note: `conflicts kept: ${m.conflicts.length}; corroborated: ${m.corroborated.join(",")}; freshness windows (days): ${JSON.stringify(pd.PROVIDER_FRESHNESS_DAYS)}`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 — "Desire but no feasible move is not labeled 'ready now'; documented 60-day lease-end or explicitly planned MLS date may narrow
//      window; anonymous neighborhood topic cannot create a person-level prediction; mixed evidence can legitimately output UNKNOWN."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 6, title: "Desire without feasibility ≠ ready now; documented lease end narrows the window; anonymous topic predicts nobody; mixed → UNKNOWN",
  positiveHalf: "buildMovingMoment: pre-approved buyer with fitting inventory and a 1-3 month timeline → ready; a documented 60-day lease end → 31_90 (stated_date, renter); a decline older than the positives keeps the window placed",
  negativeHalf: "strong stated desire + no financing → considering, window UNKNOWN; a non-person subject → no person-level moment; a decline NEWER than every positive → UNKNOWN (mixed evidence); a passed date is never a window",
  blindSpot: "the evidence priors are uncalibrated by design (no probability is published until ≥ 50 validated outcomes per window); the live stated-date writer (lease end) has no product door yet (lane 150JNAD Still open 2)",
  run: async () => {
    const mm = await import("../lib/intent/moving-moments")
    const od = await import("../lib/intent/opportunity-discovery")
    const NOW = new Date("2026-11-06T15:00:00.000Z")
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
    const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()
    let seq = 0
    const o = (sourceKey: string, relevance: string, confidence: string, extra: Record<string, unknown> = {}) => ({ id: `o${++seq}`, sourceKey, relevance, confidence, identity: "record_key", observedAt: daysAgo(3), outreach: "consent_gated", rights: "first_party", ...extra }) as any
    const buyerObs = () => [o("fp_inbound_stated", "relocation", "reported", { intents: ["home_purchase"], side: "buyer" }), o("fp_saved_homes", "property_event", "verified")]
    const moment = (obs: any[], facts: Record<string, unknown> = {}): any => mm.buildMovingMoment(od.readOpportunities(obs, { now: NOW }), obs, { subjectIsPerson: true, ...facts } as never, { now: NOW })
    const tl = { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }
    const ready = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", inventory: "available", statedTimeline: tl })
    const blocked = moment(buyerObs(), { statedSide: "buyer", financing: "none" })
    const lease = moment(buyerObs(), { statedSide: "buyer", knownDeadlines: [{ kind: "lease_end", at: inDays(60), source: "document" }] })
    const past = moment(buyerObs(), { statedSide: "buyer", knownDeadlines: [{ kind: "lease_end", at: daysAgo(10), source: "document" }] })
    const anon: any = mm.buildMovingMoment(od.readOpportunities([o("cm_employer_expansion", "community_change", "reported")], { now: NOW }), [], { subjectIsPerson: false } as never, { now: NOW })
    const mixed = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { ...tl, at: daysAgo(4) }, negative: [{ key: "declined", why: "an earlier sign closed as declined", at: daysAgo(1), source: "movement_signals:x" }] })
    const older = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: tl, negative: [{ key: "declined", why: "old decline", at: daysAgo(40), source: "movement_signals:y" }] })
    return {
      positive: ready.buyer_readiness.level === "ready" && lease.decision_window.window === "31_90" && lease.decision_window.basis === "stated_date" && lease.segments.includes("renter") && older.decision_window.window === "31_90",
      negative: blocked.buyer_readiness.level === "considering" && blocked.decision_window.window === "unknown" && blocked.ability_to_act.level === "blocked"
        && !anon.personLevel && anon.decision_window.window === "unknown" && mixed.decision_window.window === "unknown" && /mixed evidence/.test(mixed.decision_window.why)
        && past.known_deadline === null && past.decision_window.basis !== "stated_date",
      detail: JSON.stringify({ ready: ready.buyer_readiness, blocked: [blocked.buyer_readiness, blocked.decision_window], lease: lease.decision_window, anon: anon.decision_window, mixed: mixed.decision_window }),
      note: `windows: ready → ${ready.decision_window.window}, lease → ${lease.decision_window.window}, blocked → ${blocked.decision_window.window}, anonymous → ${anon.decision_window.window}, mixed → ${mixed.decision_window.window}`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 7 — "One buyer requesting 2-acre minimum and 25-minute commute receives only licensed active options with stated constraints or a
//      helpful shortage explanation; feedback from invited family member is scoped to the selected saved property, not a new lead."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 7, title: "2-acre + 25-minute buyer: only licensed active homes proving both, or a kind shortage; family feedback scoped, never a lead",
  positiveHalf: "statedHardConstraints reads TWO constraints from the buyer's sentence; answerStatedConstraints offers only the licensed ACTIVE home meeting both; with none, the shortage explains itself from measured near-misses; shareCollection + recordCollaboratorOpinion scope the family vote to the selected saved home",
  negativeHalf: "a RentCast row with no status, a pasted link, a pending listing and a home missing either constraint are never offered (counted); 'a big yard and an easy commute' invents NO constraint; the shortage never loosens the ask; the family member becomes neither a contact nor a lead",
  blindSpot: "drive minutes are planted evidence (no Matrix call); the capability rail and RentCast are not called; RLS on saved_properties / listing_media for a contact session is a live check (lane 150W Still open 5)",
  run: async () => {
    const cc = await import("../lib/buyer-search/conversation-criteria")
    const eg = await import("../lib/buyer-search/explanation-generator")
    const ee = await import("../lib/buyer-search/explanation-evidence")
    const cs = await import("../lib/buyer-search/conversational-search")
    const share = await import("../lib/portal/collaborative-share")
    const NOW = new Date("2026-11-06T15:00:00Z")
    const SENT = "We need a 2-acre minimum and a 25-minute commute to Fort Hood."
    const travel = (minutes: number | null) => ({ home: null, amenities: null, surroundings: null, notes: [], travel: [{ target: "Fort Hood", placeLabel: "Fort Hood, TX", to: { lat: 31.13, lon: -97.78 }, profile: "driving", minutes, meters: minutes != null ? minutes * 1300 : null, assumption: "typical weekday traffic", observed_at: NOW.toISOString(), map: null }] }) as any
    const crit = { ...cs.emptyCriteria(), lifestyle: cc.extractLifestyleAsks(SENT) } as any
    const home = (acres: number | null) => ({ price: 450000, bedrooms: 3, bathrooms: 2, property_type: "single_family", city: "Killeen", lot_size: acres, lot_size_unit: acres == null ? null : "acres" }) as any
    const cons = ee.statedHardConstraints(cc.extractLifestyleAsks(SENT))
    const cand = (ref: string, origin: string, status: string | null, acres: number | null, minutes: number | null) => ({ ref, label: ref, origin, status, fit: eg.explainCriteriaFit(home(acres), crit, travel(minutes)) }) as any
    const page = [cand("A-idx-2.5ac-20min", "idx_mls", "active", 2.5, 20), cand("B-rc-3ac-31min", "rentcast_listing", "Active", 3, 31), cand("C-own-1.4ac-18min", "tenant_listing", "active", 1.4, 18), cand("D-rc-nostatus", "rentcast_listing", null, 5, 10), cand("E-link", "buyer_url", "active", 6, 5), cand("G-pending", "idx_mls", "pending", 4, 12)]
    const ans: any = ee.answerStatedConstraints(page, cons)
    const short: any = ee.answerStatedConstraints(page.filter((c) => c.ref !== "A-idx-2.5ac-20min"), cons)
    const BRK = "00000000-0000-4000-8000-00000015070b", BUYER = "00000000-0000-4000-8000-0000001507c1"
    const fdb = memSupabase({
      contacts: [{ id: BUYER, brokerage_id: BRK, first_name: "Dana", email: "dana@example.com" }], leads: [],
      saved_properties: [
        { id: "s-rc", brokerage_id: BRK, contact_id: BUYER, source: "rentcast", external_property_id: "rc-9", property_address: "9 Vendor Way", primary_photo_url: "https://vendor/9.jpg", mls_name: "Unlock MLS", dismissed: false },
        { id: "s-idx", brokerage_id: BRK, contact_id: BUYER, source: "idx", external_property_id: "idx-1", property_address: "1 Feed Ln", primary_photo_url: "https://idx/1.jpg", mls_name: "Central Texas MLS", dismissed: false },
      ],
      listing_media: [], collaborative_searches: [], collaborative_search_members: [], collaborative_search_properties: [], property_family_ratings: [], property_consensus: [],
    }, { stampCreatedAt: true, uuidIds: true })
    let tok = 0
    return quiet(async () => {
      const sh: any = await share.shareCollection(fdb as never, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: "u-agent", listingRefs: ["rc-9", "idx-1"], collaborator: { name: "Mom", email: "mom@example.com" }, scope: "feedback_only", now: NOW } as never, { checkSuppression: async () => ({ suppressed: false }), sendEmailInvite: async () => ({ ok: true }), tokenFactory: () => `tok-${++tok}-${"y".repeat(40)}` } as never)
      const view: any = sh.ok ? await share.collaboratorView(fdb as never, sh.token, NOW) : { ok: false }
      const target = view.ok ? view.view.homes.find((h: any) => h.facts.address === "9 Vendor Way") : null
      const op: any = target ? await share.recordCollaboratorOpinion(fdb as never, sh.token, { sharedHomeId: target.id, vote: "like", comment: "Love the porch" } as never, { tellShoppingAgent: async () => true } as never, NOW) : { ok: false }
      const ratings = rows(fdb, "property_family_ratings")
      return {
        positive: cons.length === 2 && ans.options.length === 1 && ans.options[0] === "A-idx-2.5ac-20min" && ans.shortage === null && short.options.length === 0 && !!short.shortage
          && /2 acres/.test(short.shortage.headline) && /25 minutes to Fort Hood/.test(short.shortage.headline) && short.shortage.ideas.some((i: string) => /31 minutes/.test(i))
          && op.ok && ratings.length === 1 && ratings[0].property_id === target?.id,
        negative: !ans.options.includes("D-rc-nostatus") && !ans.options.includes("E-link") && !ans.options.includes("G-pending") && ans.counts.notLicensedActive === 3
          && ee.statedHardConstraints(cc.extractLifestyleAsks("a big yard and an easy commute to Fort Hood")).length === 0 && /won't loosen/.test(short.shortage.transparency)
          && rows(fdb, "contacts").length === 1 && rows(fdb, "leads").length === 0,
        detail: JSON.stringify({ cons, options: ans.options, counts: ans.counts, shortage: short.shortage?.headline, sh: sh.ok, op }),
        note: `${page.length} candidates → ${ans.options.length} offered; held out: ${JSON.stringify(ans.counts)}`,
        state: "built",
      }
    })
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 8 — "Market signal (public employer expansion, PCS/BAH, county permit, insurance concerns or housing supply) generates attributed
//      report/page/idea without inventing private people or identifying anonymous social accounts."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 8, title: "Market signal → attributed idea / guide, never an invented person or an identified anonymous account",
  positiveHalf: "normalizeExaResult turns a public employer-expansion page into a CITED job_civic_event record (url, title, publisher, dates; ≤280-char excerpt); publicResearchThemes turns market + civic rows into cited themes; planRelocation's territory guide cites official DoD/VA sources (PCS/BAH) by name and URL",
  negativeHalf: "the page's author, email, phone and handle never ride the record or a theme (the probe sees them in the raw page — positive control); the Lead door refuses market / job_civic_event / anonymous_question; a person row, an expired, an uncited and a steering row are dropped and COUNTED; person-mode PCS planning without a stated consent basis is refused",
  blindSpot: "no live Exa call (fail-closed without EXA_API_KEY); a page's claim is the page's, not verified market data; Census / BAH / WARN feeds are named sources, never fetched; the cron's per-territory Exa spend is not yet behind the acquisition-plan gate (lane 150EFG Still open 2)",
  run: async () => {
    const exa = await import("../lib/lead-pipeline/exa-sourcer")
    const cle = await import("../lib/lead-pipeline/canonical-lead-eligibility")
    const { publicResearchThemes } = await import("../lib/content-intel/topic-themes")
    const pcs = await import("../lib/relocation/pcs-planner")
    const PERSON_RE = /Jane Q\. Doe|jane\.doe@example\.org|850-555-0142|janeq_pcola/
    const page = { id: "exa-abc123", url: "https://www.pnj.com/story/money/2026/10/30/navy-expansion-pensacola/", title: "Navy base expansion brings 1,200 jobs to Pensacola", author: "Jane Q. Doe", publishedDate: "2026-10-30T00:00:00Z",
      text: "Posted by janeq_pcola. Contact jane.doe@example.org or 850-555-0142. The Navy announced an expansion that brings 1,200 jobs to the area. " + "x".repeat(2000), highlights: ["The Navy announced an expansion that brings 1,200 jobs to the area. " + "y".repeat(600)] }
    const rec: any = exa.normalizeExaResult(page as never, { id: MARKET, city: "Pensacola", state: "FL" } as never, "job_civic_event" as never)
    const NOW = new Date("2026-11-06T12:00:00Z")
    const row = (o: Record<string, unknown>) => ({ subject_kind: "market", source_record_id: "exa-x", proof_urls: ["https://example-news.com/a"], ttl_expires_at: "2026-12-01T00:00:00Z", observed_at: "2026-11-01T00:00:00Z", city: "Pensacola", state: "FL", raw_data: { title: "Pensacola housing inventory climbs", excerpt: "inventory rose", publisher: "example-news.com", published: "2026-10-31", url: "https://example-news.com/a", author: "Jane Q. Doe" }, ...o })
    const out: any = publicResearchThemes([
      row({}), row({ subject_kind: "job_civic_event", proof_urls: ["https://www.pnj.com/navy"], raw_data: { title: "Navy announces 1,200 new jobs", publisher: "pnj.com", url: "https://www.pnj.com/navy" } }),
      row({ subject_kind: "person" }), row({ ttl_expires_at: "2026-10-01T00:00:00Z" }), row({ proof_urls: [], raw_data: { title: "Pensacola housing inventory climbs" } }),
      row({ raw_data: { title: "Pensacola crime rates and the safest neighborhoods", url: "https://example.com/c" }, proof_urls: ["https://example.com/c"] }),
    ] as never, NOW)
    const guide: any = pcs.planRelocation({ mode: "territory_guide", territoryLabel: "32503", facts: { medianAskingPrice: 455000, medianRent: 2150, asOf: "2026-11-01", source: "RentCast /markets listing statistics" } } as never)
    const refused: any = pcs.planRelocation({ mode: "person", consent: null, destination: { label: "Norfolk, VA" }, now: NOW } as never)
    const recJson = JSON.stringify(rec)
    return {
      positive: rec.envelope?.subjectKind === "job_civic_event" && (rec.envelope?.proofUrls ?? []).includes(page.url) && rec.behaviorType === "market_research" && String(rec.rawPayload?.excerpt ?? "").length <= 280
        && out.themes.length === 2 && out.themes.every((t: any) => /^https:\/\//.test(t.sourceUrl ?? "")) && guide.ok !== false
        && pcs.PCS_OFFICIAL_SOURCES.length >= 1 && pcs.PCS_OFFICIAL_SOURCES.every((s: any) => /^https:\/\/[^/]+\.(mil|gov)\//.test(s.url)),
      negative: PERSON_RE.test(JSON.stringify(page)) && !PERSON_RE.test(recJson) && !rec.email && !rec.phone && !rec.firstName && !PERSON_RE.test(JSON.stringify(out.themes))
        && ["market", "job_civic_event", "anonymous_question"].every((k) => cle.subjectKindLeadProblem(k as never) !== null)
        && out.dropped.not_an_evidence_subject === 1 && out.dropped.expired_observation === 1 && out.dropped.no_citation === 1 && out.dropped.steering_topic === 1 && !refused.ok,
      detail: JSON.stringify({ env: rec.envelope, themes: out.themes?.map((t: any) => t.title), dropped: out.dropped, guide: guide.ok, refused }),
      note: `themes: ${out.themes.length} cited; dropped ${JSON.stringify(out.dropped)}; official PCS sources: ${pcs.PCS_OFFICIAL_SOURCES.length}`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 9 — "Appropriate property-only lead enrichment respects approved source/territory/rights; no false 50k paid call; Tracerfy
//      skip-trace versus scored Lead Builder and DataZapp Signal_Seller_Score fields/units correctly labeled; provider license
//      unknown blocks activation, not offline code testing."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 9, title: "Enrichment honours approved source/territory/rights; no false 50k paid call; vendor scores in their own units; unknown license blocks activation only",
  positiveHalf: "paidPullApproval admits the approved tenant + source; labelSellerSignal stores DataZapp 4x / PropertyRadar 90 / Tracerfy scores each in its own unit with probability null; activationVerdict lets RentCast run live; simulateProviderPilot scores the 2,400-candidate matched pilot offline (valid design, both arms attempted 1,800)",
  negativeHalf: "an unapproved source, another tenant and an expired approval are refused; DataZapp 4x vs PropertyRadar 90 compares as null (never cross-ranked); Tracerfy / DataZapp mayActivate false with named blockers while offline testing stays allowed; the pilot made 0 paid / 0 live calls and 0 writes; 50,000 appears only as SIMULATED_MONTHLY_RECORDS, never a request size",
  blindSpot: "Tracerfy / DataZapp / PropertyRadar licenses are WAITING_EXTERNAL (no key, no sandbox run, no purchase — the $1,000 paid cap is NOT approved); simulated answers prove the scoring, not any vendor's data; honest-state for activation",
  run: async () => {
    const pl = await import("../lib/lead-pipeline/source-discovery-planner")
    const sc = await import("../lib/providers/provider-scorecard")
    const { simulateProviderPilot } = await import("../lib/providers/provider-pilot")
    const now = new Date("2026-11-10T00:00:00Z")
    const approved = { id: "plan-1", brokerage_id: T1, status: "approved", valid_until: "2026-12-31T00:00:00Z", lines: [{ source: "batchdata_motivated", status: "approved" }] } as any
    const at = "2026-11-06T00:00:00.000Z"
    const a: any = sc.labelSellerSignal("datazapp_signal_seller_score" as never, "4x", at), b: any = sc.labelSellerSignal("datazapp_signal_seller_score" as never, "1x", at), c: any = sc.labelSellerSignal("propertyradar_distress_score" as never, 90, at)
    const tv: any = sc.activationVerdict("tracerfy" as never), dz: any = sc.activationVerdict("datazapp" as never), rc: any = sc.activationVerdict("rentcast" as never)
    const STRATA = ["consented_inbound", "owner_missing_contact", "evidenced_possible_seller", "control"], SHAPES = ["solo", "team", "office", "multi_office"]
    const seed = () => { const r: any[] = []; let n = 0; for (const s of STRATA) for (const t of SHAPES) for (let i = 0; i < 150; i++) { n++; r.push({ id: `raw-${n}`, brokerage_id: `b-${t}`, first_name: `F${n}`, last_name: `L${n}`, address: `${n} Main St`, zip_code: "78701", evidence: { pilot: { stratum: s, tenantShape: t, missing: s === "control" ? [] : ["owner_phone", "owner_email"], suppressed: i % 25 === 0, truth: s === "consented_inbound" ? { phone: `555${n}`, email: `p${n}@x.test` } : null, publicBaseline: i % 3 === 0, outcome30: i % 10 === 0, outcome90: i % 5 === 0 } } }) } return { raw_scraped_leads: r } }
    const simulate = (provider: string, cc: any) => { const idx = Number(String(cc.rawId).replace(/\D/g, "")) || 0; const hit = provider === "tracerfy" ? idx % 10 < 7 : idx % 10 < 6; return { hit, phone: hit ? `999${idx}` : null, email: hit && provider === "datazapp" ? `e${idx}@y.test` : null, dnc: idx % 17 === 0, sellerValue: provider === "datazapp" ? ["0x", "1x", "2x", "3x", "4x"][idx % 5] : idx % 100, ageDays: idx % 400 } }
    const mem = memSupabase(seed())
    const res: any = await quiet(() => simulateProviderPilot(mem as any, { simulate: simulate as any, now: new Date("2026-11-06T00:00:00Z") } as never))
    const pilot = code("lib/providers/provider-pilot.ts")
    const fifty = [...pilot.matchAll(/50[_,]?000/g)].map((m) => pilot.slice(Math.max(0, m.index! - 60), m.index! + 10))
    const REQUEST = /\b(limit|take|maxItems|max_records_per_run|wantRecords)\s*:\s*(SIMULATED_MONTHLY_RECORDS|50[_,]?000)/
    return {
      positive: pl.paidPullApproval([approved], { brokerageId: T1, source: "batchdata_motivated" }, now).allowed && a.ok && c.ok && a.signal.probability === null && c.signal.probability === null
        && (sc.compareSellerSignals(a.signal, b.signal) ?? 0) > 0 && rc.mayActivate === true && res.valid && res.arms.length === 2 && res.arms.every((x: any) => x.attempted === 1800),
      negative: !pl.paidPullApproval([approved], { brokerageId: T1, source: "batchdata_cash_buyer" }, now).allowed && !pl.paidPullApproval([approved], { brokerageId: T2, source: "batchdata_motivated" }, now).allowed
        && !pl.paidPullApproval([approved], { brokerageId: T1, source: "batchdata_motivated" }, new Date("2027-06-01T00:00:00Z")).allowed && !pl.paidPullApproval(null, { brokerageId: T1, source: "batchdata_motivated" }, now).allowed
        && sc.compareSellerSignals(a.signal, c.signal) === null && !tv.mayActivate && tv.offlineTestAllowed && tv.blockers.length > 0 && !dz.mayActivate && dz.offlineTestAllowed
        && res.paidCalls === 0 && res.liveCalls === 0 && (mem as any).writes.length === 0 && res.activation.every((x: any) => !x.mayActivate)
        && fifty.length === 1 && /SIMULATED_MONTHLY_RECORDS = 50_000/.test(fifty[0]) && !REQUEST.test(pilot) && REQUEST.test("search({ take: 50000 })"),
      detail: JSON.stringify({ tv, dz, rc, pilot: { valid: res.valid, problems: res.designProblems, paid: res.paidCalls, live: res.liveCalls }, fifty }),
      note: `pilot: ${res.cohort?.candidates} candidates, paidCalls ${res.paidCalls}, liveCalls ${res.liveCalls}; Tracerfy blockers: ${tv.blockers.length}, DataZapp blockers: ${dz.blockers.length} (activation WAITING_EXTERNAL)`,
      state: "honest-state",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 10 — "Complete lead magnet deliverable written before page/form/funnel; branding and creator users.id retained, custom domain/QR
//       correct, conditional question fields have meaningful intent, email/SMS follow-up legal consent and unsubscribe in one
//       canonical place."
// ═════════════════════════════════════════════════════════════════════════════
const DB1 = "00000000-0000-4000-8000-0000000150d1", DB2 = "00000000-0000-4000-8000-0000000150d2"
const DAG = "00000000-0000-4000-8000-00000150d0a1", DU1 = "00000000-0000-4000-8000-00000150d0b1", DU2 = "00000000-0000-4000-8000-00000150d0b2", DAG2 = "00000000-0000-4000-8000-00000150d0a2"
const ORIGIN = "https://app.example.com"
const NOW10 = new Date("2026-11-06T15:00:00Z")
function magnetWorld(): MemClient {
  const db = memSupabase({
    brokerages: [{ id: DB1, name: "Elm Realty", slug: "elm-realty", deleted_at: null }, { id: DB2, name: "Oak Team", slug: "oak-team", deleted_at: null }],
    agents: [{ id: DAG, brokerage_id: DB1, user_id: DU1, is_active: true }, { id: DAG2, brokerage_id: DB2, user_id: DU2, is_active: true }],
    users: [{ id: DU1, brokerage_id: DB1, first_name: "Ann", user_type: "agent" }, { id: DU2, brokerage_id: DB2, first_name: "Oli", user_type: "team_lead" }],
    calendar_provider_accounts: [], campaign_sequences: [], campaign_sequence_steps: [], market_data: [],
    farm_territories: [{ id: "ft-1", brokerage_id: DB1, name: "South Austin", city: "Austin", state: "TX", zip_codes: ["78704"], agent_id: DAG, is_active: true }],
    conversation_insights: [
      { id: "ci-1", brokerage_id: DB1, conversation_id: "cv-1", unresolved_questions: ["Do I need to go through probate before I can sell?"], created_at: NOW10.toISOString() },
      { id: "ci-2", brokerage_id: DB1, conversation_id: "cv-2", unresolved_questions: ["Do I need to go through probate before I can sell?"], created_at: NOW10.toISOString() },
    ],
    tenant_custom_domains: [], qr_codes: [], keyword_intelligence: [], ai_search_citation_observations: [], brokerage_settings: [],
    lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_funnel_items: [], lead_magnet_promises: [], ai_video_projects: [],
    agent_action_ledger: [], lifecycle_events: [], notifications: [], tasks: [], manager_signals: [], generated_documents: [],
  }, { uuidIds: true, stampCreatedAt: true })
  ;(db as any).rpc = async () => ({ data: null, error: null })
  return db
}
const M_CHECKLIST = {
  insufficient: false, insufficient_reason: null, title: "The Inherited-Home Sale Checklist", intro: "The steps to sell an inherited home, in order, at your pace.",
  sections: [
    { heading: "Before anything is listed", items: [{ text: "Confirm who has authority to sell", why: "title companies ask first" }, { text: "Secure and insure the property", why: "a vacant home needs care" }, { text: "Gather the deed and recent bills", why: "it speeds every next step" }] },
    { heading: "Getting it ready", items: [{ text: "Decide what stays and what goes", why: "it frames the timeline" }, { text: "Ask for a no-pressure value review", why: "so the price is grounded" }, { text: "Ask your agent how sales work locally", why: "rules vary by state" }] },
  ],
  closing: "Questions? Reply any time — I'm happy to help.",
}
const M_PLAN = {
  insufficient: false, insufficient_reason: null, name: "Selling an Inherited Home, Step by Step", magnet_type: "seller_guide",
  big_promise: "Know every step to sell an inherited home without guesswork", angle: "Families are asking whether probate must finish before a sale", awareness_stage: "problem_aware",
  landing: { headline: "Selling an inherited home: the steps, in order", subhead: "A one-page checklist and a short video for families handling an estate property.", cta: "Send my checklist", description: "Practical steps from Elm Realty.", faq: [] },
  situation_keys: ["timeline", "move_side", "property_address"], extra_questions: [{ label: "Any other questions for us?", type: "textarea", options: [] }],
  deliverables: [
    { key: "estate_checklist", kind: "checklist", role: "primary", title: "The Inherited-Home Sale Checklist", promise_line: "The Inherited-Home Sale Checklist — every step on one page", outline: ["authority to sell", "securing the home", "pricing"], why: "a quick, specific win first" },
    { key: "estate_video", kind: "video", role: "deliverable", title: "What happens when you sell an estate home", promise_line: "A short video walkthrough", outline: ["authority", "timeline in general terms"], why: "authority" },
  ],
  thank_you: { headline: "Your checklist is on its way", message: "It's on its way to your inbox.", next_step_line: "Want a hand? Ann is happy to help." },
  steps: { personal_video: false, calendar_link: false, portal_task: null, education_sequence: false },
  follow_up: { first_value_moment: "the checklist arrives", signals_to_watch: ["opened the checklist"], handoff_when: "they ask about a sale" },
  learning: { hypothesis: "estate families convert on a one-page plan", primary_metric: "visit_to_submit" },
}
function magnetSeams(db: any) {
  const events: Array<{ ev: string; at: number }> = []
  const deps: any = {
    now: NOW10, client: db, entitlement: async () => ({ allowed: true, reason: "ok" }),
    plan: async () => { events.push({ ev: "plan", at: db.writes.length }); return M_PLAN },
    writeChecklist: async () => { events.push({ ev: "checklist_written", at: db.writes.length }); return M_CHECKLIST },
    finalize: async (a: any) => ({ ok: true, texts: a.texts }),
    renderDocument: async () => { events.push({ ev: "checklist_rendered", at: db.writes.length }); return { ok: true, pdfUrl: "https://cdn.example.com/client-docs/d1/checklist-1.pdf", documentId: null, error: null } },
    writeVideoScript: async () => ({ insufficient: false, insufficient_reason: null, title: "What happens when you sell an estate home", script: "Hi, I'm Ann with Elm Realty. Selling a home you inherited usually starts with confirming who can sign, then caring for the property, then pricing it with care. Here is what that looks like in general terms, and what to ask your attorney. Reply any time — I'm happy to help. Elm Realty.", on_screen: ["Authority", "Care", "Price"] }),
    commissionVideo: async () => { events.push({ ev: "video_commissioned", at: db.writes.length }); const id = randomUUID(); db.tables.ai_video_projects.push({ id, brokerage_id: DB1, agent_id: DAG, video_type: "education", status: "pending_review", approval_status: "pending_review", compliance_status: "pending", video_url: null, is_published: false, video_metadata: {} }); return { ok: true, status: "staged", videoProjectId: id } },
    draftBrand: async () => ({}),
  }
  deps.deliverable = { now: NOW10, funnel: deps }
  const mint = async (args: any, svc: any) => {
    const id = randomUUID(), slug = `qr-${rows(svc, "qr_codes").length + 1}`
    svc.tables.qr_codes.push({ id, brokerage_id: args.brokerageId, agent_id: args.agentId, label: args.label, slug, target_url: args.targetUrl, destination_type: args.destinationType, purpose: args.purpose, is_active: true })
    return { qrCodeId: id, slug, scanUrl: `${ORIGIN}/api/qr/scan?slug=${slug}`, targetUrl: args.targetUrl, qrCodeDataUrl: "data:image/png;base64,AAAA" }
  }
  return { deps, events, mint }
}
canary({
  n: 10, title: "Lead magnet: deliverable before page/form/funnel; creator users.id + brand kept; QR resolves; situation questions; consent + unsubscribe in one place",
  positiveHalf: "createLeadMagnetPackage renders the checklist BEFORE the landing form row and commissions the video AFTER it (order magnet · landing_page · funnel); created_by_user_id is the clicking users.id; the QR targets /site/<this tenant>/lm/<slug> and resolveTenantLandingForm resolves it to THIS form; the form asks the estate's closed situation questions; checkSuppression clears an unlisted person",
  negativeHalf: "another tenant's site does not serve the form; an out-of-order stage list is detected; the planner's open 'Any other questions?' box is dropped and said; checkSuppression refuses MAIL to a person on the platform list by their email, and an unreadable platform list refuses (fail closed)",
  blindSpot: "custom-domain DNS / TLS, real email + SMS delivery and the model-written copy are live-only (models scripted); the landing page is not rendered; the Meta lead-form legal content stays UNKNOWN until a live form check (WAITING_EXTERNAL)",
  run: async () => {
    const P = await import("../lib/lead-magnets/lead-magnet-package")
    const M = await import("../lib/lead-magnets/magnet-funnel")
    const { resolveTenantLandingForm } = await import("../lib/tenant-site/landing-page")
    const S = await import("../lib/kernel/compliance/check-suppression")
    const db = magnetWorld()
    const s = magnetSeams(db)
    const r: any = await withSvc(null, () => quiet(() => P.createLeadMagnetPackage({ brokerageId: DB1, agentId: DAG, createdBy: DU1, origin: "create_button", answers: { persona: "probate", area: "South Austin", topic_key: "ai_pick", deliverable: "checklist" }, baseUrl: ORIGIN } as never, { client: db, now: NOW10, funnel: s.deps, mintTrackedQr: s.mint, readers: { topicBank: async () => [] } } as never)))
    if (!r.ok) return { positive: false, negative: false, detail: JSON.stringify(r).slice(0, 800) }
    const pkg = r.package
    const formAt = (db as any).writes.findIndex((w: any) => w.table === "lead_capture_forms" && w.op === "insert")
    const ev = (n: string) => s.events.filter((e) => e.ev === n)
    const isOrdered = (st: Array<{ stage: string }>) => st.map((o) => (M.FUNNEL_PACKAGE_ORDER as readonly string[]).indexOf(o.stage)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]))
    const form = rows(db, "lead_capture_forms").find((f) => f.id === pkg.form_id)
    const qr = rows(db, "qr_codes").find((q) => q.id === pkg.qr?.qr_code_id)
    const m = new URL(qr?.target_url ?? "https://x/none").pathname.match(/^\/site\/([^/]+)\/lm\/([^/]+)$/)
    const ok: any = m ? await quiet(() => resolveTenantLandingForm(db as never, m[1], m[2])) : null
    const foreign: any = m ? await quiet(() => resolveTenantLandingForm(db as never, "oak-team", m[2])) : null
    const fields = pkg.funnel.form.fields as Array<{ name: string; type: string }>
    const people = [{ id: "c-lit", brokerage_id: LA, email: "litigator@example.test", phone: "(813) 555-0147" }, { id: "c-ok", brokerage_id: LA, email: "olive@example.test", phone: "(813) 555-0999" }]
    const supW = (refuse?: Record<string, string>) => memSupabase({ contacts: people, contact_suppression_list: [], platform_suppression_list: [{ id: "p1", email: "litigator@example.test", reason: "litigator" }], compliance_events: [] }, { refuse } as never)
    const ask = (svc: MemClient, contactId: string) => S.checkSuppression({ brokerageId: LA, contactId, channel: "mail" } as never, { client: svc } as never)
    const [lit, clean, blind] = await quiet(() => Promise.all([ask(supW(), "c-lit"), ask(supW(), "c-ok"), ask(supW({ platform_suppression_list: "permission denied" }), "c-lit")]))
    return {
      positive: JSON.stringify(M.FUNNEL_PACKAGE_ORDER) === JSON.stringify(["magnet", "landing_page", "funnel"]) && formAt >= 0 && ev("checklist_rendered")[0]?.at <= formAt && ev("video_commissioned")[0]?.at > formAt && isOrdered(pkg.order)
        && form?.created_by_user_id === DU1 && m?.[1] === "elm-realty" && ok?.ok === true && ok?.formId === pkg.form_id && ["property_role", "estate_stage"].every((n) => fields.some((f) => f.name === n))
        && !fields.some((f) => f.type === "textarea") && !(clean as any).suppressed,
      negative: foreign?.ok === false && !isOrdered([{ stage: "landing_page" }, { stage: "magnet" }, { stage: "funnel" }]) && pkg.funnel.notes.some((n: string) => /generic open question/.test(n))
        && M.GENERIC_OPEN_QUESTION.test("Any other questions?") && (lit as any).suppressed && (blind as any).suppressed,
      detail: JSON.stringify({ formAt, events: s.events, order: pkg.order, creator: form?.created_by_user_id, target: qr?.target_url, ok, foreign, fields: fields.map((f) => f.name), lit, clean, blind }),
      note: `stage order ${pkg.order.map((o: any) => o.stage).join(" → ")}; ${fields.length} form fields, none an open box; QR → ${qr?.target_url ? new URL(qr.target_url).pathname : "none"}`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 11 — "Human-approved Meta campaign/persona audience automatically syncs eligible members and revocations, receives provider
//       acknowledgment, exposes actual campaign result; typed persona label works; ad platform housing restrictions remain enforced."
// ═════════════════════════════════════════════════════════════════════════════
const MA = "00000000-0000-4000-8000-0000000151a0", MB = "00000000-0000-4000-8000-0000000151b0"
canary({
  n: 11, title: "Approved persona audience auto-syncs members + revocations, reads provider ack + campaign result; typed label works; housing rules hold",
  positiveHalf: "audiencesNeedingResync picks approved-never-uploaded, failed and changed-since-upload audiences; a re-upload is a full REPLACE (usersreplace, last batch); fetchAudienceStatus / fetchStatus read the provider's ack and the campaign state back; every canonical persona is an admitted audience word (R7)",
  negativeHalf: "a draft and a quiet live audience are not re-uploaded; a suppression after upload re-syncs (revocation leaves); an everyone-revoked replace is REFUSED (never a silent success); the append path is unused on an existing audience; a lookalike is refused under Special Ad Category; age / ZIP narrowing violates readiness; a non-persona proxy word is still caught; the 'Sync Now' endpoint is gone",
  blindSpot: "Meta usersreplace / CustomAudience fields and Google removeAll are proven against a stubbed transport only (WAITING_EXTERNAL: a connected sandbox ad account); the kernel syncAudience command does not itself re-check approval (see canary 18)",
  run: async () => {
    const pa = await import("../lib/ads/persona-audience")
    const { metaConnector } = await import("../lib/ads/connectors/meta")
    const payload = await import("../lib/ads/connectors/ad-payload")
    const ii = await import("../lib/voice-admin/intent-interface")
    const cs = await import("../lib/campaigns/contact-sources")
    const aud2 = await import("../lib/compliance-rules/audience-compliance")
    const t0 = "2026-11-05T00:00:00Z", t1 = "2026-11-06T00:00:00Z"
    const aud = memSupabase({
      facebook_custom_audiences: [
        { id: "fa-new", brokerage_id: MA, audience_name: "First-time buyers", status: "approved", last_synced_at: null },
        { id: "fa-live-changed", brokerage_id: MA, audience_name: "Relocating", status: "synced", last_synced_at: t0 },
        { id: "fa-live-quiet", brokerage_id: MB, audience_name: "Downsizers", status: "synced", last_synced_at: t1 },
        { id: "fa-draft", brokerage_id: MA, audience_name: "Draft", status: "draft", last_synced_at: null },
      ],
      contacts: [{ id: "c-a", brokerage_id: MA, updated_at: t1 }, { id: "c-b", brokerage_id: MB, updated_at: t0 }],
      contact_suppression_list: [{ id: "s-a", brokerage_id: MA, created_at: t0 }],
    })
    const revoked = memSupabase({ facebook_custom_audiences: [{ id: "fa-q", brokerage_id: MB, audience_name: "Q", status: "synced", last_synced_at: t1 }], contacts: [{ id: "c-b", brokerage_id: MB, updated_at: t0 }], contact_suppression_list: [{ id: "s-b", brokerage_id: MB, created_at: "2026-11-06T12:00:00Z" }] })
    return quiet(async () => {
      const picked: any = await pa.audiencesNeedingResync(aud as never), pr: any = await pa.audiencesNeedingResync(revoked as never)
      const ids = picked.ok ? picked.audiences.map((a: any) => a.id) : []
      const cred = { accessToken: "tok", accountId: "123" } as never
      G.__W150.graph = []
      G.__W150.graphReply = (_m: string, p: string) => (p.endsWith("customaudiences") ? { id: "aud-9" } : p.endsWith("/users") || p.endsWith("usersreplace") ? { num_received: 1, num_invalid_entries: 0 } : {})
      const replaced: any = await metaConnector.pushCustomAudience({ audienceName: "X", externalAudienceId: "aud-9", members: [{ email_sha256: "e1" }] as never, cred } as never)
      const calls = [...G.__W150.graph]
      G.__W150.graph = []
      const emptied: any = await metaConnector.pushCustomAudience({ audienceName: "X", externalAudienceId: "aud-9", members: [] as never, cred } as never)
      const emptiedCalls = G.__W150.graph.length
      G.__W150.graphReply = (_m: string, p: string) => (p.startsWith("aud-9") ? { approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200, operation_status: { code: 200, description: "Normal" }, delivery_status: { code: 200, description: "This audience is ready for use" } } : { effective_status: "PAUSED", configured_status: "PAUSED" })
      const ack: any = await (metaConnector as any).fetchAudienceStatus({ externalAudienceId: "aud-9", cred })
      const st: any = await (metaConnector as any).fetchStatus({ campaignExternalId: "cmp-1", cred })
      G.__W150.graphReply = null
      const labels = ii.everyPersonaAudienceLabel()
      const covered = (w: string) => aud2.audienceProxyHits(w, labels).length === 0
      const personas = cs.CAMPAIGN_PERSONAS.filter((p: string) => p !== "other")
      const lk: any = pa.planPersonaAudience({ persona: "senior", platform: "facebook", lookalike: true } as never)
      const base = (t: Record<string, unknown> = {}) => ({ platform: "facebook", objective: "leads", campaignName: "First-time buyer class", dailyBudgetUsd: 40, pageId: "p1", leadFormId: "f1", creative: { headline: "Your first home, step by step", primaryText: "A free class on budgets, pre-approval and offers.", mediaAssetUrl: "https://x/y.jpg", destinationUrl: "https://x/lp" }, targeting: { locations: [{ city: "Austin", state: "TX", radiusMiles: 20 }], audienceExternalIds: ["fb-ft"], inclusionGovernance: "gated", ...t }, specialAdCategory: "HOUSING" }) as any
      const clean = payload.validateAdReadiness(base())
      const v = (t: Record<string, unknown>) => payload.validateAdReadiness(base(t)).violations
      const fas = code("lib/ads/facebook-audience-sync.ts")
      const SYNC_EXPORT = /export\s+async\s+function\s+syncAudience\b/
      return {
        positive: picked.ok && ids.includes("fa-new") && ids.includes("fa-live-changed") && replaced.ok && replaced.mode === "replace" && calls.length === 1 && calls[0].path === "aud-9/usersreplace" && (calls[0].body as any)?.session?.last_batch_flag === true
          && ack.ok && ack.state === "normal" && ack.approxSize?.lower === 1000 && st.ok && st.state === "paused" && personas.every((p: string) => covered(p.replace(/_/g, " "))) && clean.ready,
        negative: !ids.includes("fa-live-quiet") && !ids.includes("fa-draft") && pr.ok && pr.audiences.some((a: any) => a.id === "fa-q") && !emptied.ok && emptiedCalls === 0 && !calls.some((c: any) => c.path === "aud-9/users")
          && !lk.ok && lk.refusalKind === "platform_housing_rule" && v({ ageMin: 25 }).some((x: string) => /age/.test(x)) && v({ locations: [{ zip: "78701" }] }).some((x: string) => /ZIP/.test(x))
          && !covered("church-goers") && !SYNC_EXPORT.test(fas) && SYNC_EXPORT.test("export async function syncAudience(_u, p) {}"),
        detail: JSON.stringify({ picked, pr, replaced, calls, emptied, ack, st, lk: lk.refusalKind }),
        note: `resync picked: ${ids.join(", ")}; ${personas.length} personas admitted as audience words; provider ack state ${ack.state}, campaign ${st.state} (stubbed transport)`,
        state: "built",
      }
    })
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 12 — "A buyer/seller receives immediate welcome portal access; manager/arbiter can send helpful follow-up and process incoming reply
//       over supported channels, including SMS/social, without fixed invented intervals; failed send creates near-real-time staff action."
// ═════════════════════════════════════════════════════════════════════════════
const CA = "00000000-0000-4000-8000-0000000152a0"
canary({
  n: 12, title: "Immediate portal welcome; two-way channels incl. SMS/social; no invented intervals; a failed send is a staff action at the event",
  positiveHalf: "ingestProviderTruth on a bounced email flips the claim to contradicted and notifies the contact's ASSIGNED agent (agents.user_id) at once, in-app, high priority, with the provider's words; deliveryFailuresFrom makes the arbiter refuse the bounced channel; SMS declares a receive side in CHANNEL_PROVIDER_TRUTH; the portal invite precedes the welcome (canary 4's order)",
  negativeHalf: "a second failure on the same claim tells nobody again (escalated_at once-only); a confirmed delivery tells nobody; a newer confirmation clears an older contradiction; the failed-send notifier carries no timer (setTimeout / setInterval census on stripped source, positive control on a specimen); channels that do not listen publish their gaps",
  blindSpot: "no real Twilio / social provider webhook is received (stubbed truth events); 'near-real-time' for invite repair is the manager-signals tick (≤ 30 min, canary 16); the arbiter's CHOICE is a model call (not exercised)",
  run: async () => {
    const ledger = await import("../lib/outcomes/reconciliation-ledger")
    const arb = await import("../lib/ai-isa/followup-arbiter")
    const matrix = await import("../lib/providers/channel-provider-matrix")
    const svc = memSupabase({
      contacts: [{ id: "c-1", brokerage_id: CA, first_name: "Rosa", last_name: "Diaz", agent_id: "ag-1" }, { id: "c-2", brokerage_id: CA, first_name: "Sam", last_name: "Lee", agent_id: null }],
      leads: [], agents: [{ id: "ag-1", brokerage_id: CA, user_id: "u-agent", is_active: true }],
      users: [{ id: "u-broker", brokerage_id: CA, user_type: "broker" }, { id: "u-agent", brokerage_id: CA, user_type: "agent" }],
      outcome_reconciliations: [
        { id: "r-1", brokerage_id: CA, channel: "email", provider_ref: "sg-1", claimed_status: "sent", claimed_at: "2026-11-06T10:00:00Z", verdict: "pending", escalated_at: null, claimed_by_manager: "ai_isa", entity_type: "contact", entity_id: "c-1", contact_id: "c-1", lead_id: null, provider_reported_at: null },
        { id: "r-3", brokerage_id: CA, channel: "email", provider_ref: "sg-3", claimed_status: "sent", claimed_at: "2026-11-06T10:00:00Z", verdict: "pending", escalated_at: null, claimed_by_manager: "ai_isa", entity_type: "contact", entity_id: "c-2", contact_id: "c-2", lead_id: null, provider_reported_at: null },
      ],
      notifications: [], manager_signals: [], lifecycle_events: [],
    })
    return withSvc(svc, () => quiet(async () => {
      const bounced: any = await ledger.ingestProviderTruth({ channel: "email", providerRef: "sg-1", truth: { status: "bounce", at: "2026-11-06T10:05:00Z", detail: { reason: "550 mailbox unavailable" } } } as never)
      const n1 = rows(svc, "notifications").filter((n) => n.type === "delivery_failed")
      await ledger.ingestProviderTruth({ channel: "email", providerRef: "sg-1", truth: { status: "dropped", at: "2026-11-06T10:06:00Z" } } as never)
      const afterSecond = rows(svc, "notifications").filter((n) => n.type === "delivery_failed").length
      const before = rows(svc, "notifications").length
      await ledger.ingestProviderTruth({ channel: "email", providerRef: "sg-3", truth: { status: "delivered", at: "2026-11-06T10:05:00Z" } } as never)
      const df: any = arb.deliveryFailuresFrom([{ channel: "email", verdict: "contradicted", provider_status: "bounce" }, { channel: "sms", verdict: "confirmed", provider_status: "delivered" }, { channel: "sms", verdict: "contradicted", provider_status: "undelivered" }] as never)
      const truth = Object.entries(matrix.CHANNEL_PROVIDER_TRUTH) as Array<[string, any]>
      const ct = code("lib/kernel/completion-tracking.ts")
      const notifier = ct.slice(ct.indexOf("export async function notifyFailedSend"))
      const TIMER = /setTimeout|setInterval/
      const capOrder = code("lib/contact-pipeline/contact-capture.ts")
      return {
        positive: bounced.ok && bounced.verdict === "contradicted" && n1.length === 1 && n1[0].user_id === "u-agent" && n1[0].priority === "high" && n1[0].channel === "in_app" && /550 mailbox unavailable/.test(String(n1[0].body))
          && df.email === "bounce" && !!matrix.CHANNEL_PROVIDER_TRUTH.sms?.receive?.supported && /portalInvite/.test(capOrder),
        negative: afterSecond === 1 && rows(svc, "notifications").length === before && df.sms === undefined && notifier.length > 0 && !TIMER.test(notifier) && TIMER.test("setTimeout(() => resend(), 86_400_000)")
          && truth.every(([, r]) => r.receive.supported || r.receive.gaps.length > 0),
        detail: JSON.stringify({ bounced, n1, afterSecond, df, sms: matrix.CHANNEL_PROVIDER_TRUTH.sms?.receive }),
        note: `listening channels: ${truth.filter(([, r]) => r.receive.supported).map(([k]) => k).join(", ")} of ${truth.length}; gaps published for: ${truth.filter(([, r]) => !r.receive.supported).map(([k]) => k).join(", ") || "none"}`,
        state: "built",
      }
    }))
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 13 — "Lob letter, postcard front/back, personal-note and optional special card IDs never alias; correct tenant office logo/brand/
//       address/font/QR; preview and delivery status, accurate price; no live spend in canary, no mistaken double LettrLabs checkout."
// ═════════════════════════════════════════════════════════════════════════════
const brandA = () => ({ displayName: "The Alder Team", legalBrokerageName: "Alder Realty LLC", dba: "Alder Homes", teamName: "The Alder Team", officeName: "Riverside Office", agentName: "Maya Chen", agentLicenseLine: "GA License # 123456", logoUrl: "https://cdn.a.example/logo.png", primaryColor: "#0F172A", secondaryColor: "#64748B", accentColor: "#F59E0B", fontFamily: "Libre Baskerville", tagline: "Rooted where you are.", website: "alderhomes.example", phone: "404-555-0100", returnAddress: { name: "Alder Realty LLC", line1: "12 Peachtree St", city: "Atlanta", state: "GA", zip: "30303" }, disclosureShort: "Equal Housing Opportunity.", disclosureLong: "Alder Realty LLC is committed to the principles of the Fair Housing Act." }) as any
const brandB = () => ({ displayName: "Harbor & Pine Realty", legalBrokerageName: "Harbor & Pine Realty Inc.", teamName: null, officeName: "Harbor Office", agentName: "Luis Ortega", agentLicenseLine: "FL License # SL998877", logoUrl: "https://cdn.b.example/hp.svg", primaryColor: "#1E3A8A", secondaryColor: "#94A3B8", accentColor: "#10B981", fontFamily: "Lora", tagline: "Coastal know-how, neighbourly care.", website: "harborpine.example", phone: "850-555-0199", returnAddress: { name: "Harbor & Pine Realty Inc.", line1: "400 Bay Ave", city: "Pensacola", state: "FL", zip: "32502" }, disclosureShort: "Equal Housing Opportunity.", disclosureLong: "Harbor & Pine Realty Inc. is committed to the Fair Housing Act." }) as any
canary({
  n: 13, title: "Lob format ids never alias; tenant brand as data; preview + per-piece status; no live spend, no double LettrLabs checkout",
  positiveHalf: "routeMailFormat resolves letter / personal letter / postcard (distinct front + back) from four distinct global ids; buildMailMergeVariables gives two tenants different logo, legal name, office, return address, font CSS and QR on the same template, disclosures verbatim; a Lob delivered event reads 'delivered_per_carrier_scan'; withActionLedger charges one piece once",
  negativeHalf: "a postcard back equal to its front, and a personal letter sharing the letter id, are refused before spend; a format with no id names the env var to set; the second send of a piece REPLAYS (never charges); createLobProof refuses a live_ key with no network; handwritten_card naming LettrLabs stays refused (dormant, never downgraded to a typeset letter); no event proves household receipt",
  blindSpot: "the four global Lob HTML templates and LOB_TEST_API_KEY are WAITING_EXTERNAL (no proof URL is rendered); the sender's OFFICE is not yet in the brand cascade (readMailBrandFacts says not_in_brand_cascade — lane 150R PARTIAL); PostcardMania / PCM prices unconfirmed (owner quote)",
  run: async () => {
    const pt = { ...(await import("../lib/direct-mail/piece-type")), ...(await import("../lib/direct-mail/mail-piece-rules")) }
    const { createLobProof } = await import("../lib/providers/lob/client")
    const al = await import("../lib/kernel/action-ledger")
    const FOUR = { LOB_LETTER_TEMPLATE_ID: "tmpl_letter", LOB_PERSONAL_LETTER_TEMPLATE_ID: "tmpl_personal", LOB_POSTCARD_FRONT_TEMPLATE_ID: "tmpl_front", LOB_POSTCARD_BACK_TEMPLATE_ID: "tmpl_back" }
    const L: any = pt.routeMailFormat("letter", FOUR), P: any = pt.routeMailFormat("personal_letter", FOUR), C: any = pt.routeMailFormat("postcard", FOUR)
    const backIsFront: any = pt.routeMailFormat("postcard", { ...FOUR, LOB_POSTCARD_BACK_TEMPLATE_ID: "tmpl_front" })
    const personalIsLetter = { ...FOUR, LOB_PERSONAL_LETTER_TEMPLATE_ID: "tmpl_letter" }
    const none: any = pt.routeMailFormat("personal_letter", {})
    const hw: any = pt.routeMailFormat("handwritten_card", { ...FOUR, LOB_HANDWRITTEN_CARD_PROVIDER: "lettrlabs" })
    const a: any = pt.buildMailMergeVariables(brandA(), { recipientName: "Rosa Diaz", qrDestinationUrl: "https://a.example/api/qr/scan?slug=aaa" } as never)
    const b: any = pt.buildMailMergeVariables(brandB(), { recipientName: "Rosa Diaz", qrDestinationUrl: "https://b.example/api/qr/scan?slug=bbb" } as never)
    const keys = ["brand_logo_url", "brand_legal_name", "office_name", "return_address_line1", "brand_font_css_url", "qr_destination_url"]
    const svc = memSupabase({ agent_action_ledger: [] }, { unique: { agent_action_ledger: [["idempotency_key"]] }, uuidIds: true })
    let charges = 0
    const lobCharge = async (): Promise<any> => { charges++; return { success: true, providerKey: "lob", messageId: `psc_${charges}` } }
    const hooks = { settle: (r: any) => al.settleDispatchResult(r, 0.909), replay: al.replayDispatchResult } as any
    const ctx = (key: string) => ({ brokerageId: "b-1", action: "comms.direct_mail.send", channel: "direct_mail", actor: { type: "user", userId: "u-1" }, subject: { type: "recipient", id: null, ref: "1 Elm St, 30301" }, idempotencyKey: key, riskClass: "COMMUNICATION" }) as any
    const k1 = pt.mailPieceIdempotencyKey("campaign_recipient", "camp-1", "rec-1")
    const first: any = await quiet(() => al.withActionLedger(ctx(k1), lobCharge, hooks, { client: svc } as never))
    const second: any = await quiet(() => al.withActionLedger(ctx(k1), lobCharge, hooks, { client: svc } as never))
    const live: any = await createLobProof("live_abc123", { pieceType: "letter", to: { name: "A", address_line1: "1 Elm", address_city: "X", address_state: "GA", address_zip: "30301" }, templateId: "tmpl_letter", mergeVariables: {} } as never)
    const events = ["postcard.mailed", "postcard.delivered", "letter.returned_to_sender", "letter.something_new"].map(pt.mailOutcomeFromLobEvent) as any[]
    return {
      positive: L.ok && P.ok && C.ok && C.templates.templateId === "tmpl_front" && C.templates.backTemplateId === "tmpl_back" && L.templates.templateId !== P.templates.templateId
        && keys.every((k) => a.mergeVars[k] !== b.mergeVars[k]) && a.mergeVars.disclosure_long === brandA().disclosureLong && !Object.values(a.mergeVars).some((x: any) => /vipagents/i.test(String(x)))
        && pt.mailOutcomeFromLobEvent("postcard.delivered").outcome === "delivered_per_carrier_scan" && charges === 1 && first.success,
      negative: !backIsFront.ok && !pt.routeMailFormat("letter", personalIsLetter).ok && !pt.routeMailFormat("personal_letter", personalIsLetter).ok && !none.ok && none.waitingExternal.includes("LOB_PERSONAL_LETTER_TEMPLATE_ID")
        && second.success && second.messageId === first.messageId && charges === 1 && !live.ok && /TEST key/.test(live.error ?? "") && !hw.ok && /dormant/.test(hw.reason ?? "") && hw.downgrade == null
        && events.every((e) => e.householdReceiptProven === false) && Object.values(pt.OPTIONAL_MAIL_PROVIDERS).every((p: any) => p.status === "dormant"),
      detail: JSON.stringify({ L, P, C, backIsFront, none, hw, charges, first, second, live }),
      note: `formats resolved: letter / personal_letter / postcard; ${keys.length} tenant-specific merge variables differ; Lob charges for one piece sent twice: ${charges}; optional mail providers: ${Object.keys(pt.OPTIONAL_MAIL_PROVIDERS).join(", ")} (all dormant)`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 14 — "Contract closing date with on-or-before allows earlier lender/title-coordinated close without automatically requiring an
//       addendum; actual date tracked separately; executed addenda can supersede terms before closing, compliance and payouts reread
//       effective terms."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 14, title: "'On or before' allows an earlier close without an addendum; actual tracked apart; executed addenda govern; payouts re-read",
  positiveHalf: "assessClosingDateChange: an earlier lender/title day under on_or_before is within contract, needs NO executed amendment, names TRID + CDA coordination; resolveClosingDates keeps actual 12-09 beside contractual 12-15; resolveGoverningTerms lets the EXECUTED addendum's price govern; afterExecutedContractChange flags gross commission / CDA for re-read",
  negativeHalf: "a fixed 'on' day moved earlier DOES need an amendment (positive control); an unread wording is 'unknown', never a default demand; a PROPOSED addendum never governs (reported pending); a contingency-days change moves no money",
  blindSpot: "state-specific rules beyond the C33 default are not sourced here (a sourced state rule would override); the e-sign envelope and the live documents.content hit rate are not exercised",
  run: async () => {
    const cd = await import("../lib/transactions/closing-dates")
    const gt = await import("../lib/offers/governing-terms-rule")
    const gc = await import("../lib/offers/governing-terms-consequences")
    const deal = { status: "under_contract", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract", property_state: "CA", financing_type: "conventional" } as any
    const early: any = cd.assessClosingDateChange(deal, { date: "2026-12-08", kind: "anticipated" } as never)
    const fixed: any = cd.assessClosingDateChange({ ...deal, contract_closing_terms: "on" }, { date: "2026-12-08", kind: "anticipated" } as never)
    const unread: any = cd.assessClosingDateChange({ ...deal, contract_closing_terms: null }, { date: "2026-12-08", kind: "anticipated" } as never)
    const closed: any = cd.resolveClosingDates({ ...deal, status: "closed", actual_close_date: "2026-12-09", close_date: "2026-12-09" })
    const v = (over: Record<string, unknown>) => ({ versionNo: 1, source: "offer", status: "executed", offerId: null, documentId: null, executedAt: "2026-10-01T00:00:00Z", terms: {}, derived: false, ...over }) as any
    const g: any = gt.resolveGoverningTerms([v({ terms: { offer_price: 500_000, closing_date: "2026-12-15" } }), v({ source: "addendum", terms: { offer_price: 490_000 }, executedAt: "2026-10-20T00:00:00Z", documentId: "doc-add-1" }), v({ versionNo: 2, source: "addendum", status: "proposed", terms: { offer_price: 480_000 }, executedAt: null })])
    const impact = async (changedTerms: Record<string, unknown>) => ((await quiet(() => gc.afterExecutedContractChange(memSupabase({}) as never, { brokerageId: "b-14", transactionId: null, rootOfferId: "root-1", versionNo: 2, source: "addendum", changedTerms, documentId: "doc-1", executedOn: "2026-10-20", recordedBy: null } as never))) as any).impact
    const price: any = await impact({ offer_price: 490_000 }), days: any = await impact({ inspection_contingency_days: 12 })
    const moves = (i: any) => JSON.stringify(i ?? {})
    return {
      positive: early.direction === "earlier" && early.withinContract === true && early.requiresExecutedAmendment === false && early.coordinate.some((c: string) => /TRID/.test(c)) && early.coordinate.some((c: string) => /CDA/.test(c))
        && closed.actual?.date === "2026-12-09" && closed.contractual?.date === "2026-12-15" && closed.contractual?.terms === "on_or_before" && g.values.offer_price === 490_000 && g.values.closing_date === "2026-12-15"
        && /gross|commission|cda/i.test(moves(price)),
      negative: fixed.requiresExecutedAmendment === true && unread.requiresExecutedAmendment === "unknown" && g.pending.length === 1 && g.values.offer_price !== 480_000 && moves(days) !== moves(price),
      detail: JSON.stringify({ early, fixed: fixed.requiresExecutedAmendment, unread: unread.requiresExecutedAmendment, closed, g: g.values, price, days }),
      note: `earlier close under on_or_before: amendment required = ${early.requiresExecutedAmendment}; coordinate: ${early.coordinate.length} parties`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 15 — "Listing agreement and counter-supported buyer offer require all proper signatures/initials/documents and compliance before
//       live/transaction state; outside listing counter loop, title/HUD/CDA/payables and review at close generate verified evidence
//       and notifications."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 15, title: "Signatures + initials + documents + compliance before live / transaction; outside counters loop; close evidence verified",
  positiveHalf: "evaluateExecution: agent + seller signatures AND initials → executed; isOfferFullyExecuted on both sides + the executed contract on file; deterministicReplySignals reads accept / counter / decline from an outside agent's words; readClosingDateWording quotes the contract's on-or-before sentence; comparePreliminaryStatementFigures finds a HUD/CD gross gap",
  negativeHalf: "missing seller initials / signature refuse under their own names; buyer-signed-only and accepted-without-executed-contract are NOT executed; an offer with a transaction never auto-executes again; a bare 'Closing Date:' label, two wordings or a mismatched date read 'unknown'; a figure the statement lacks is UNVERIFIABLE, never $0",
  blindSpot: "the e-sign provider envelope, the storage policy on listing-media (owner SQL) and real notifications delivery are live-only; the closing attestation WITHOUT a CDA is an open OWNER DECISION (honest-state: asked only on the CDA path)",
  run: async () => {
    const sig = await import("../lib/compliance/signature-completeness")
    const oe = await import("../lib/transactions/offer-execution-state")
    const ol = await import("../lib/offers/outside-offer-loop")
    const ct = await import("../lib/transactions/contract-terms")
    const cp = await import("../lib/transactions/cda-closing-policy")
    const both = { signatures: [{ signer_role: "seller", signed: true }, { signer_role: "agent", signed: true }], initials: [{ signer_role: "seller", all_required_initials_present: true }, { signer_role: "agent", all_required_initials_present: true }] }
    const vOk: any = sig.evaluateExecution(both as never, ["agent", "seller"] as never)
    const vI: any = sig.evaluateExecution({ ...both, initials: [{ signer_role: "seller", all_required_initials_present: false }, { signer_role: "agent", all_required_initials_present: true }] } as never, ["agent", "seller"] as never)
    const vS: any = sig.evaluateExecution({ ...both, signatures: [{ signer_role: "seller", signed: false }, { signer_role: "agent", signed: true }] } as never, ["agent", "seller"] as never)
    const at = "2026-11-01T10:00:00Z"
    const a: any = ol.deterministicReplySignals("Re: offer", "My sellers accept your offer as written."), c: any = ol.deterministicReplySignals("Re: offer", "We'd like to counter at $512,000 with a 14-day close."), d: any = ol.deterministicReplySignals("Re: offer", "Thank you, but the sellers have decided to decline.")
    const OOB = "12. CLOSING. Closing shall occur on or before December 15, 2026 at the office of the closing agent."
    const r1: any = ct.readClosingDateWording(OOB, { expectedDate: "2026-12-15" } as never)
    const cmp: any = cp.comparePreliminaryStatementFigures({ sales_price: 490_000, gross_commission: 15_000 } as never, { sales_price: 490_000, gross_commission: 14_700, agent_net: 10_000 } as never)
    const attest = code("app/actions/cda-portal.ts")
    return {
      positive: vOk.executed && oe.isOfferFullyExecuted({ buyer_signed_at: at, seller_response_type: "accepted", fully_signed_contract_received_at: at } as never) && a.acceptance && c.counter && d.decline
        && r1.terms === "on_or_before" && r1.date === "2026-12-15" && cmp.discrepancies.some((x: any) => x.field === "gross_commission"),
      negative: !vI.executed && vI.missing.includes("seller initials") && !vS.executed && vS.missing.includes("seller signature") && !oe.isOfferFullyExecuted({ buyer_signed_at: at } as never)
        && !oe.isOfferFullyExecuted({ buyer_signed_at: at, seller_response_type: "accepted" } as never) && !oe.shouldAutoExecuteOffer({ buyer_signed_at: at, seller_signed_at: at, fully_signed_contract_received_at: at, transaction_id: "t-1" } as never)
        && ct.readClosingDateWording("Purchase Price: $500,000. Closing Date: 12/15/2026.").terms === null && ct.readClosingDateWording(OOB, { expectedDate: "2026-12-20" } as never).terms === null
        && cmp.unverifiable.includes("agent_net") && !cmp.discrepancies.some((x: any) => x.field === "agent_net") && !a.decline && !d.acceptance,
      detail: JSON.stringify({ vOk, vI, vS, a, c, d, r1, cmp }),
      note: `closing attestation asked on the CDA path: ${/ensureClosingAttestationAsked\(/.test(attest)}; without a CDA it is an OPEN OWNER DECISION (not invented)`,
      state: "built",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 16 — "A2P starts on number creation; staff and tenant invites are immediate, errors do not remain unseen for a day; recurring provider
//       failure goes to manager then human support with tenant-safe messaging."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 16, title: "A2P on number creation; invites immediate; failures seen within minutes; manager → human support with tenant-safe words",
  positiveHalf: "the purchase door calls kickCarrierRegistration then reports phone_a2p in-request (stripped source); reportOperationOutcome on a failed kickoff routes an open signal to the AI ISA with the raw error kept as evidence; the owner's async repair re-sends a failed invitation once and closes it quietly when it works; the manager-signals tick runs at most every 30 minutes",
  negativeHalf: "still failing → the tenant admins' bell + ONE support ticket, the bell carrying the tenant sentence, never 'SMTP 421'; no attributable actor → no automatic re-send; a second failure for the same invitation is ONE signal; tenantFacingGate refuses a PGRST code, a key, a price and the platform-pays phrase; a leaking door sentence is replaced by the generic one",
  blindSpot: "no live Twilio A2P filing (hours-to-days, costs money — WAITING_EXTERNAL TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN); the real Supabase auth invite email is not sent; 'within minutes' is the tick bound, not a wall-clock observation",
  run: async () => {
    const io = await import("../lib/kernel/immediate-operations")
    const tt = await import("../lib/support/ticket-triage")
    const { CRON_REGISTRY } = await import("../lib/kernel/cron-dispatch")
    const B = "00000000-0000-4000-8000-0000000016b0", INV = "00000000-0000-4000-8000-0000000016c0", CALLER = "00000000-0000-4000-8000-0000000016d0"
    const np = code("lib/voice/number-provisioning.ts")
    const svc = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
    const eventsBefore = G.__W150.events.length
    return quiet(async () => {
      const r: any = await io.reportOperationOutcome(svc as never, { operation: "phone_a2p", brokerageId: B, ok: false, subjectType: "tenant_phone_number", subjectId: INV, evidence: { number_last4: "0100", source: "purchased" }, error: "kickoff threw: ECONNREFUSED", tenantFacing: "business registration for your new number could not start — the OS will retry and tell you if it needs your business profile" } as never)
      const sig = rows(svc, "manager_signals")[0]
      const evidence = JSON.stringify(rows(svc, "lifecycle_events")) + JSON.stringify(G.__W150.events.slice(eventsBefore))
      const sigOf = (actor: string | null) => ({ id: "sig-1", entityType: "user_invitation", entityId: INV, payload: { operation: "invitation", subject_type: "user_invitation", subject_id: INV, lifecycle_event_id: "ev-1", tenant_facing: "Invitation delivery did not verify — the invitation email to a@b.co could not be sent — resend it from Users › Invitations", actor_user_id: actor } })
      const calls = { org: 0, ticket: 0, resend: 0, bodies: [] as string[] }
      const spies = (resend: () => any) => ({ notifyOrg: async (_s: unknown, _b: string, n: { body: string }) => { calls.org++; calls.bodies.push(n.body); return 1 }, notifyStaff: async () => 1, openTicket: async () => { calls.ticket++; return { ticketId: "tk-1", created: true, error: null } }, redispatchInvitation: async () => { calls.resend++; return resend() } }) as any
      const ctx = { brokerageId: B, supabase: memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [] }) } as any
      const ok = await io.handleOperationFailureEscalated(sigOf(CALLER) as never, ctx, spies(() => ({ ok: true, dispatched: true, status: "pending", note: "Invitation email sent." })))
      const quietRepair = calls.resend === 1 && calls.org === 0 && calls.ticket === 0 && /repaired asynchronously/.test(String(ok ?? ""))
      await io.handleOperationFailureEscalated(sigOf(CALLER) as never, ctx, spies(() => ({ ok: false, dispatched: false, status: "failed", error: "The invitation email could not be sent: SMTP 421 from provider" })))
      const human = calls.resend === 2 && calls.org === 1 && calls.ticket === 1 && !calls.bodies.some((x) => /SMTP 421/.test(x)) && calls.bodies.some((x) => /resend it from Users › Invitations/.test(x))
      const resendsBefore = calls.resend, bellsBefore = calls.org
      const noActor = await io.handleOperationFailureEscalated(sigOf(null) as never, ctx, spies(() => ({ ok: true, dispatched: true, status: "pending" })))
      const noActorNoResend = calls.resend === resendsBefore && calls.org === bellsBefore + 1
      const bus = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
      const f1: any = await io.reportOperationOutcome(bus as never, { operation: "invitation", brokerageId: B, ok: false, subjectType: "user_invitation", subjectId: INV, evidence: {}, error: "x", actorUserId: CALLER } as never)
      for (const s of rows(bus, "manager_signals")) s.status = s.status ?? "open"
      const f2: any = await io.reportOperationOutcome(bus as never, { operation: "invitation", brokerageId: B, ok: false, subjectType: "user_invitation", subjectId: INV, evidence: { door: "resend" }, error: "y", actorUserId: CALLER } as never)
      const leak = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
      await io.reportOperationOutcome(leak as never, { operation: "provider_connection", brokerageId: B, ok: false, subjectType: "platform_credentials", subjectId: CALLER, evidence: {}, error: "PGRST204 column missing", tenantFacing: "the write was refused (PGRST204 — column api_key missing)" } as never)
      const leakMsg = String(rows(leak, "manager_signals")[0]?.message ?? "")
      const row = (CRON_REGISTRY as ReadonlyArray<{ path: string; schedule: string }>).find((c) => c.path === "/api/cron/manager-signals")
      const minutes = row ? row.schedule.split(" ")[0].split(",").map(Number).filter((n) => Number.isFinite(n)) : []
      const gaps = minutes.length > 1 ? minutes.map((m, i) => ((minutes[(i + 1) % minutes.length] - m + 60) % 60) || 60) : [60]
      const purchaseKick = np.indexOf("kickCarrierRegistration("), purchaseReport = np.indexOf("await reportPhoneA2pOutcome(")
      return {
        positive: purchaseKick > 0 && purchaseReport > purchaseKick && r.evented !== false && !!r.signalId && sig?.to_manager === "ai_isa" && /ECONNREFUSED/.test(evidence) && quietRepair && !!row && Math.max(...gaps) <= 30,
        negative: human && noActorNoResend && /escalated to a human/.test(String(noActor ?? "")) && !!f1.signalId && f1.signalId === f2.signalId && !/ECONNREFUSED/.test(String(sig?.message ?? ""))
          && !tt.tenantFacingGate("refused: PGRST204").ok && !tt.tenantFacingGate("use sk_live_abc123").ok && !tt.tenantFacingGate("it costs $49").ok && tt.tenantFacingGate("Your invitation could not be sent — resend it from Users › Invitations.").ok
          && leakMsg.length > 0 && !/PGRST|api_key/.test(leakMsg),
        detail: JSON.stringify({ parts: { human, noActorNoResend, noActor: /escalated to a human/.test(String(noActor ?? "")), dedupe: !!f1.signalId && f1.signalId === f2.signalId, raw: !/ECONNREFUSED/.test(String(sig?.message ?? "")), gate: [!tt.tenantFacingGate("refused: PGRST204").ok, !tt.tenantFacingGate("use sk_live_abc123").ok, !tt.tenantFacingGate("it costs $49").ok, tt.tenantFacingGate("Your invitation could not be sent — resend it from Users › Invitations.").ok], leak: leakMsg.length > 0 && !/PGRST|api_key/.test(leakMsg) }, r, calls, noActor, f1: f1.signalId, f2: f2.signalId, leakMsg, schedule: row?.schedule }),
        note: `manager-signals tick: "${row?.schedule ?? "missing"}" (max gap ${Math.max(...gaps)} min); invitation repair: one quiet re-send closes it; still failing → tenant bell + one ticket; no attributable actor → no re-send, straight to a human`,
        state: "built",
      }
    })
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 17 — "Market report's ZIP trend accurately labels listing prices, not sold medians; shared cache costs once per authorized market
//       refresh and tenant-branded report differs correctly per agent and office."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 17, title: "ZIP trend labels LISTING asking prices; one shared provider read per authorized refresh; report differs per agent + office",
  positiveHalf: "loadMarketTwin labels the RentCast median 'listing_asking', the sold median only from recorded closed sales; duplicate zips are read once each (3 asked → 2 provider reads); produceMarketReport for two agents in two same-tenant offices renders each office's DBA / license / colour / tagline",
  negativeHalf: "the asking label never says 'sold' / 'sale price'; two sales are not a median (null); without an authorized refresh the provider is NEVER asked (0 reads); another tenant's sale never enters the median; a refused office read fails CLOSED (no report under the wrong license line)",
  blindSpot: "no live RentCast call (RENTCAST_API_KEY WAITING_EXTERNAL); the platform-wide cache's once-per-window behaviour is proven on rentcast.ts source by test:market-twin, not by a live cache row; the PDF render is a seam",
  run: async () => {
    const { loadMarketTwin } = await import("../lib/market-reports/market-twin")
    const { produceMarketReport } = await import("../lib/market-reports/producer")
    const B1 = "00000000-0000-4000-8000-0000000017b1", B2 = "00000000-0000-4000-8000-0000000017b2", U1 = "00000000-0000-4000-8000-0000000017a1", U2 = "00000000-0000-4000-8000-0000000017a2"
    const L1 = "00000000-0000-4000-8000-0000000017e1", L2 = "00000000-0000-4000-8000-0000000017e2"
    const NOW = new Date("2026-11-06T12:00:00Z")
    const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()
    const stats = { median_sale_price: 455000, avg_days_on_market: 38, active_listings: 180, new_listings_30d: 52, price_trend_yoy_pct: 3.1, median_price_per_sqft: 241, total_listings_at: "2026-11-01T00:00:00Z", rental: { median_rent: 2150 } }
    const sold = (i: number, b = B1) => ({ id: `s-${b}-${i}`, brokerage_id: b, zip: "32503", status: "sold", deleted_at: null, sold_price: 400000 + i * 10000, sold_date: day(-20 - i).slice(0, 10) })
    const twinDeps = (calls: { n: number }) => ({ now: NOW, providerRead: async () => { calls.n++; return stats }, activeStatuses: async () => ["active", "coming_soon"] }) as any
    return quiet(async () => {
      const c1 = { n: 0 }
      const t: any = await loadMarketTwin(memSupabase({ listings: [sold(1), sold(2), sold(3), sold(9, B2)], market_data: [], property_preferences: [], market_active_listings: [] }) as never, { brokerageId: B1, zips: ["32503"], allowProviderRead: true } as never, twinDeps(c1))
      const z = t.zips[0]
      const thin: any = await loadMarketTwin(memSupabase({ listings: [sold(1), sold(2)], market_data: [] }) as never, { brokerageId: B1, zips: ["32503"], allowProviderRead: true } as never, twinDeps({ n: 0 }))
      const dup = { n: 0 }
      await loadMarketTwin(memSupabase({ listings: [], market_data: [] }) as never, { brokerageId: B1, zips: ["32503", "32503", "32504"], allowProviderRead: true } as never, twinDeps(dup))
      const none = { n: 0 }
      const stored: any = await loadMarketTwin(memSupabase({ listings: [], market_data: [{ id: "md1", brokerage_id: B1, zip_code: "32503", data_date: day(-4).slice(0, 10), source_type: "rentcast", median_sale_price: 450000, active_listings: 170, new_listings_30d: 40, avg_days_on_market: 35, price_trend_pct_1yr: 2 }] }) as never, { brokerageId: B1, zips: ["32503"] } as never, twinDeps(none))
      const ZIP = { grain: "zip", label: "32503", zip: "32503", city: "Pensacola", state: "FL" }
      const world = (opts: Record<string, unknown> = {}) => memSupabase({
        market_data: [{ id: "md-1", brokerage_id: B1, zip_code: "32503", city: "Pensacola", state: "FL", data_date: "2026-11-01", source_type: "rentcast", active_listings: 180, new_listings_30d: 50, median_sale_price: 455000, avg_days_on_market: 38, price_trend_pct_1yr: 3 }],
        market_trends: [], listings: [], agent_action_ledger: [], generated_documents: [],
        users: [{ id: U1, brokerage_id: B1, location_id: L1 }, { id: U2, brokerage_id: B1, location_id: L2 }],
        locations: [{ id: L1, brokerage_id: B1, name: "Downtown", legal_name: "Gulf Breeze Homes Downtown LLC", dba: "Gulf Breeze Downtown", license_number: "BK111", license_state: "FL", brand_overrides: { primary_color: "#0a5c36", tagline: "Downtown, door to door" } }, { id: L2, brokerage_id: B1, name: "Beaches", legal_name: "Gulf Breeze Homes Beaches LLC", dba: null, license_number: "BK222", license_state: "FL", brand_overrides: {} }],
      }, { uuidIds: true, ...opts } as never)
      const renders: any[] = []
      const deps = { now: NOW, refreshMarketData: async () => ({ source: "rentcast", success: true }), write: async () => { throw new Error("model off") }, fairHousing: async () => ({ ok: true, findings: [] }), finalize: async (a: { texts: string[] }) => ({ ok: true, texts: a.texts, tagline: "Gulf Breeze Homes — neighbours first" }), brand: async () => ({ brokerageName: "Gulf Breeze Homes", agentName: "Ann Agent", licenseLine: "Brokerage Lic #BK000 (FL)", primaryColor: "#1144aa" }), render: async (a: any) => { renders.push(a); return { ok: true, pdfUrl: "https://cdn.example.com/r.pdf", documentId: `doc-${renders.length}`, error: null } }, approver: async () => ({ ok: true, permittedUserIds: [U1], primaryUserIds: [U1], basis: "owner", reason: "x" }) } as any
      const input = (u: string) => ({ brokerageId: B1, agentUserId: u, actor: { type: "system" }, territory: ZIP, topic: { title: "32503 snapshot", angle: null, evidenceIds: [] }, purpose: "proof" }) as any
      const r1: any = await produceMarketReport(world() as never, input(U1), deps)
      const r2: any = await produceMarketReport(world() as never, input(U2), deps)
      const b1 = renders[0]?.spec?.brand, b2 = renders[1]?.spec?.brand
      const r3: any = await produceMarketReport(world({ refuse: { locations: "permission denied" } }) as never, input(U1), deps)
      return {
        positive: z?.listing.medianAskingPrice?.basis === "listing_asking" && /asking price/i.test(z.listing.medianAskingPrice.label) && z?.sold.medianSoldPrice?.basis === "recorded_sale" && z.sold.medianSoldPrice.value === 420000
          && dup.n === 2 && r1.ok && r2.ok && b1?.brokerageName === "Gulf Breeze Downtown" && b2?.brokerageName === "Gulf Breeze Homes Beaches LLC" && b1?.primaryColor !== b2?.primaryColor,
        negative: !/sold|sale price/i.test(z?.listing.medianAskingPrice?.label ?? "sold") && thin.zips[0].sold.medianSoldPrice === null && none.n === 0 && stored.zips[0].via === "tenant_reading" && z?.sold.closedSales === 3
          && !r3.ok && /office brand could not be resolved/.test(r3.reason ?? ""),
        detail: JSON.stringify({ asking: z?.listing.medianAskingPrice, sold: z?.sold, dup: dup.n, none: none.n, b1, b2, r3 }),
        note: `provider reads: authorized refresh of 3 zips (2 distinct) → ${dup.n}; no authorized refresh → ${none.n}; office brands: "${b1?.brokerageName}" vs "${b2?.brokerageName}"`,
        state: "built",
      }
    })
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 18 — "All remaining Wave 149 fixed cadences, territory permit bug, contract reader, Meta legal-consent uncertainty, geocode write,
//       ad-sync approval, health route, seed accounts and Vercel install parity are assigned a verified closed, carried-owner or
//       blocked status."
// ═════════════════════════════════════════════════════════════════════════════
type Status = "closed" | "carried-owner" | "blocked"
interface Item { item: string; status: Status; owner: string; evidence: string }
canary({
  n: 18, title: "Every Wave-149 carried item has a DERIVED status: closed (with proof) · carried-with-owner · blocked",
  positiveHalf: "each of the nine named items is classified from the TREE on this run — a closed item only with a driven or stripped-source proof (the contract reader is DRIVEN; install parity reads vercel.json through release-rules installOf); every carried / blocked item names its owner and next step",
  negativeHalf: "no item is 'closed' on prose: each closing finder is shown seeing its defect shape in a specimen (positive controls); a carried cadence without an owner, and the pnpm-unfrozen install, are both detected; the count of non-closed items is published, never lowered by relabelling",
  blindSpot: "this canary DERIVES status; lane 150Z (parallel) owns closing them — the integrated run reflects whatever 150Z landed; owner items (O2 seed accounts, Meta live form) cannot be closed in code; honest-state",
  run: async () => {
    const ct = await import("../lib/transactions/contract-terms")
    const rr = await import("./release-rules")
    const items: Item[] = []
    // 1 fixed cadences — the arbiter-timing guard's dispositions (stripped source, string literals kept)
    const at = code("scripts/arbiter-timing-guard.ts")
    const CARRIED = /"([^"#]+#[A-Za-z_]+)":\s*\{\s*kind:\s*"carried",\s*owner:\s*"([^"]*)"/g
    const carried = [...at.matchAll(CARRIED)].map((m) => ({ key: m[1], owner: m[2] }))
    const ownerless = carried.filter((c) => !c.owner.trim())
    const specimenOwnerless = [...`"x.ts#Y": { kind: "carried", owner: "" }`.matchAll(CARRIED)].filter((m) => !m[2].trim()).length === 1
    items.push({ item: "W149 fixed cadences", status: carried.length === 0 ? "closed" : "carried-owner", owner: [...new Set(carried.map((c) => c.owner))].join(" | ") || "—", evidence: `${carried.length} carried timetables in scripts/arbiter-timing-guard.ts DISPOSITIONS, ${ownerless.length} without owner` })
    // 2 territory permit bug (E-3): the sweep must read Settings → Territories (subscriber_service_areas / deriveTenantMarkets)
    const permit = code("lib/external/permit-signals.ts") + code("app/api/cron/permit-signal-scan/route.ts")
    const E3 = /subscriber_service_areas|deriveTenantMarkets\(/
    items.push({ item: "territory permit bug (E-3)", status: E3.test(permit) ? "closed" : "carried-owner", owner: "lead_acquisition (lib/external/permit-signals.ts) — lane 150Z / integrator", evidence: E3.test(permit) ? "permit sweep reads Settings territories" : "permit sweep walks lead_scraping_markets only (resolveActiveScrapeTerritories); Settings → Territories rows not swept" })
    // 3 contract reader — DRIVEN
    const rd: any = ct.readClosingDateWording("Closing shall occur on or before December 15, 2026.", { expectedDate: "2026-12-15" } as never)
    const promo = /readClosingDateWording\(/.test(code("lib/transactions/closing-dates.ts"))
    items.push({ item: "contract reader (G-2)", status: rd.terms === "on_or_before" && promo ? "closed" : "carried-owner", owner: "deal_coordinator (lane 150XY)", evidence: `readClosingDateWording → ${rd.terms}; called at promotion: ${promo}` })
    // 4 Meta legal-consent uncertainty — stored UNKNOWN until a person verifies (m978); the live form check is WAITING_EXTERNAL
    const m978 = raw("supabase/migrations/m978-ad-lead-form-legal-content.sql")
    const unknownHeld = /'unknown'/.test(m978) && /'verified'/.test(m978)
    items.push({ item: "Meta legal-consent uncertainty", status: "blocked", owner: "owner — Meta Lead Ads Testing Tool on a form with a custom disclaimer (WAITING_EXTERNAL); code holds UNKNOWN", evidence: `m978 present: ${m978.length > 0}; status vocabulary holds unknown + verified: ${unknownHeld}` })
    // 5 geocode-on-write for listings
    const GEO = /geocod/i
    const geoClosed = GEO.test(code("lib/kernel/listings.ts"))
    items.push({ item: "listing geocode-on-write", status: geoClosed ? "closed" : "carried-owner", owner: "listing_manager (lib/kernel/listings.ts) — needs a migration number", evidence: geoClosed ? "lib/kernel/listings.ts geocodes on write" : "no geocode in the listings writer" })
    // 6 ad-sync approval — the kernel command re-checking approval itself
    const ka = code("lib/kernel/ads.ts")
    const syncBody = ka.slice(ka.indexOf("export async function syncAudience"), ka.indexOf("export async function previewAudienceResolution"))
    const APPROVAL = /audience\.status\s*(?:!==|===)\s*["'](?:approved|draft)["']|\["approved",\s*"synced"/
    const cron = code("app/api/cron/sync-facebook-audiences/route.ts")
    items.push({ item: "ad-sync approval", status: APPROVAL.test(syncBody) ? "closed" : "carried-owner", owner: "ads_manager (lib/kernel/ads.ts syncAudience)", evidence: APPROVAL.test(syncBody) ? "syncAudience refuses a non-approved audience" : `the doors hold it (approveAudience flips status first; the tick selects by audiencesNeedingResync: ${/audiencesNeedingResync\(/.test(cron)}) but syncAudience itself does not re-check` })
    // 7 health route
    const health = existsSync(join(ROOT, "app/api/health/route.ts"))
    items.push({ item: "health route + instrumentation", status: health ? "closed" : "carried-owner", owner: "platform ops (public-route list + sessionless-doors guard) — lane 150Z / integrator", evidence: `app/api/health/route.ts: ${health}; instrumentation.ts: ${existsSync(join(ROOT, "instrumentation.ts"))}` })
    // 8 seed accounts (O2) — owner decision
    const ownerSql = raw("docs/operations/OWNER-SQL.md")
    const o2Resolved = /RESOLVED \d{4}-\d{2}-\d{2} — census 0/.test(ownerSql)
    items.push({ item: "seed portal accounts (O2)", status: o2Resolved ? "closed" : "blocked", owner: "owner — OWNER-SQL §I remediation A (LINK), verify §K Q7 = 0", evidence: o2Resolved ? "OWNER-SQL §I says RESOLVED" : `OWNER-SQL.md present: ${ownerSql.length > 0}; no RESOLVED line` })
    // 9 Vercel install parity (O4) — derived through release-rules
    const facts: any = rr.readDeploymentFacts(ROOT)
    items.push({ item: "Vercel install parity (O4)", status: facts.o4Open ? "carried-owner" : "closed", owner: "integrator (vercel.json installCommand)", evidence: `vercel install ${facts.vInstall.pm}${facts.vInstall.frozen ? " frozen" : " unfrozen"} vs CI ${facts.ciInstall.pm}${facts.ciInstall.frozen ? " frozen" : ""}; o4Open=${facts.o4Open}` })
    const pnpmUnfrozen = rr.installOf("pnpm install --no-frozen-lockfile")
    const npmCi = rr.installOf("npm ci")
    const statuses: Status[] = ["closed", "carried-owner", "blocked"]
    const open = items.filter((i) => i.status !== "closed")
    return {
      positive: items.length === 9 && items.every((i) => statuses.includes(i.status) && i.evidence.length > 0 && (i.status === "closed" || i.owner.length > 3)) && items.find((i) => i.item.startsWith("contract reader"))?.status === "closed",
      negative: ownerless.length === 0 && specimenOwnerless && E3.test("await svc.from(\"subscriber_service_areas\").select(\"zip\")") && GEO.test("await geocodeAddress(addr)") && APPROVAL.test(`if (audience.status !== "approved") return`)
        && !(pnpmUnfrozen.pm === npmCi.pm && pnpmUnfrozen.frozen === npmCi.frozen) && npmCi.frozen === true && ct.readClosingDateWording("Closing Date: 12/15/2026.").terms === null,
      detail: JSON.stringify(items),
      note: `closed ${items.length - open.length} · carried-owner ${items.filter((i) => i.status === "carried-owner").length} · blocked ${items.filter((i) => i.status === "blocked").length} — ` + items.map((i) => `${i.item}: ${i.status}`).join("; "),
      state: "honest-state",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 19 — "Final chain exit, whole-project tsc, CI, clean build, true Vercel deploy/preview smoke, one real sign-in, observed Workflow
//       timer and cron tick, and actual storage policy evidence are separate mandatory gate rows; CI green is never production-live."
// ═════════════════════════════════════════════════════════════════════════════
canary({
  n: 19, title: "Nine separate mandatory release gate rows; CI green (or chain + tsc + CI together) is never production-live",
  positiveHalf: "RELEASE_GATES carries R1–R9 as distinct rows (chain, tsc, CI, clean build, preview smoke, sign-in, Workflow timer, cron tick, storage policy), each with a specimen its own shape accepts (positive control); productionLive is true only with zero obligations AND all nine observed; the ledger on THIS tree is read through readReleaseEvidence and each row's verdict published",
  negativeHalf: "R1 + R2 + R3 observed with every deploy row missing → NOT production-live; one open owner obligation with all rows observed → NOT production-live; a row whose evidence lacks a required fact, or whose status is not OBSERVED, is NOT OBSERVED; a commit-bound row on a changed tree is NOT OBSERVED",
  blindSpot: "no deploy, sign-in, Workflow timer, cron tick or storage policy is observed by a canary — those rows are owner / integrator evidence in docs/operations/ACTIVATION-CHECKLIST.md; honest-state: the tree's own verdict is printed, never upgraded",
  run: async () => {
    const rr = await import("./release-rules")
    const R = rr.RELEASE_GATES.filter((g) => g.row.startsWith("R"))
    const okRow = (g: any) => ({ row: g.row, status: "OBSERVED", date: "2026-11-07", commit: "abcdef1234", evidence: g.specimen })
    const fresh = () => "fresh" as const
    const specimensAccepted = R.every((g) => rr.gateVerdict(g, okRow(g), fresh).state === "OBSERVED")
    const all = new Map(R.map((g) => [g.row, "OBSERVED" as const]))
    const ciOnly = new Map<string, any>(R.map((g) => [g.row, rr.CI_SIDE_ROWS.includes(g.row) ? "OBSERVED" : "NOT OBSERVED"]))
    const missingFact = rr.gateVerdict(R[3], { ...okRow(R[3]), evidence: "READY" }, fresh)
    const notStatus = rr.gateVerdict(R[0], { ...okRow(R[0]), status: "PENDING" }, fresh)
    const stale = rr.gateVerdict(R[4], okRow(R[4]), () => "stale")
    const ev = rr.readReleaseEvidence(ROOT)
    const tree = R.map((g) => ({ row: g.row, ...ev.verdict(g.row) }))
    const observed = tree.filter((t) => t.state === "OBSERVED").map((t) => t.row)
    const treeLive = rr.productionLive(0, new Map(tree.map((t) => [t.row, t.state])))
    return {
      positive: R.length === 9 && new Set(R.map((g) => g.row)).size === 9 && R.filter((g) => g.deployOnly).length >= 5 && specimensAccepted && rr.productionLive(0, all) === true,
      negative: rr.productionLive(0, ciOnly) === false && rr.productionLive(1, all) === false && missingFact.state === "NOT OBSERVED" && notStatus.state === "NOT OBSERVED" && stale.state === "NOT OBSERVED"
        && (observed.length === 9 || treeLive === false),
      detail: JSON.stringify({ tree, ciSide: rr.CI_SIDE_ROWS, missingFact, notStatus, stale }),
      note: `gate rows on this tree: ${observed.length} of ${R.length} OBSERVED (${observed.join(", ") || "none"}); PRODUCTION-LIVE ${treeLive ? "YES" : "NO"}; CI-side rows ${rr.CI_SIDE_ROWS.join("/")}`,
      state: "honest-state",
    }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// THE RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" WAVE 150 canaries (in-memory) — the owner's 19 mandatory canaries, each POSITIVE + NEGATIVE + blind spot")
  console.log("══════════════════════════════════════════════════════════════")
  let passed = 0, failed = 0
  const failures: string[] = []
  const table: string[] = []
  for (const c of CANARIES.sort((a, b) => a.n - b.n)) {
    let v: Verdict
    try { v = await c.run() } catch (e) { v = { positive: false, negative: false, detail: `THREW: ${(e as Error)?.stack ?? String(e)}` } }
    const ok = v.positive && v.negative
    if (ok) passed++; else { failed++; failures.push(`${c.n}. "${c.title}"`) }
    console.log(`\n ${ok ? "✓" : "✗"} ${String(c.n).padStart(2)}. "${c.title}" — positive ${v.positive ? "✓" : "✗"} · negative ${v.negative ? "✓" : "✗"}${ok ? ` · ${v.state ?? "built"}` : ""}`)
    console.log(`      + ${c.positiveHalf}`)
    console.log(`      − ${c.negativeHalf}`)
    console.log(`      blind spot: ${c.blindSpot}`)
    if (v.note) console.log(`      note: ${v.note}`)
    if (!ok) console.log(`      evidence: ${String(v.detail ?? "").slice(0, 2000)}`)
    table.push(` ${ok ? "PASS" : "FAIL"}  ${String(c.n).padStart(2)}  ${ok ? (v.state ?? "built") : "—"}`)
  }
  console.log("\n──────────────────────────────────────────────────────────────")
  for (const t of table) console.log(t)
  console.log(` measured: service-client mint attempts refused by the seam ${G.__W150.mints} · background echo rejections ${backgroundRejections.length} · kernel events recorded ${G.__W150.events.length}`)
  console.log(" blind spots: memSupabase has no CHECK/FK/RLS/storage policy · Supabase Auth, Stripe, Twilio, Lob, Meta, Google, RentCast, Exa,")
  console.log("   Tracerfy, DataZapp and Vercel are never called (stubs / injected seams) · every model is scripted · routes and React are")
  console.log("   read as stripped source, not executed · canaries 18 and 19 DERIVE status from the tree (honest-state, never upgraded)")
  if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(` RESULT: canaries ${passed} passed, ${failed} failed (${CANARIES.length} mandatory canaries)`)
  console.log(failed === 0 ? "WAVE150_CANARIES_PASS" : "WAVE150_CANARIES_FAIL")
  process.exit(failed > 0 ? 1 : 0)
}

// Run only as the entry script: imported by scripts/wave151-canaries.ts, this file registers the seam and the roster and returns.
const isEntry = (() => { try { return pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url } catch { return false } })()
if (isEntry) main().catch((e) => { console.error(e); console.log("WAVE150_CANARIES_FAIL"); process.exit(1) })
