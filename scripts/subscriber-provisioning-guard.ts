#!/usr/bin/env tsx
/**
 * scripts/subscriber-provisioning-guard.ts   (npm run test:subscriber-provisioning)   — wave 148, lane 148A
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SUBSCRIBER JOURNEY, DRIVEN END TO END on the in-memory client (scripts/in-memory-supabase.ts) with the REAL
 * kernel modules — the owner's release path, in order:
 *
 *   J0 DEPLOYMENT    — the public origin is resolved by ONE function (lib/platform/site-url.ts) in every journey file;
 *                      the checkout refuses a relative return URL before Stripe and names NEXT_PUBLIC_APP_URL.
 *   J1 ONBOARDING →  — createTenantCore (lib/kernel/tenant-creation.ts) self-serve trial: brokerage, owner, trialing
 *   J2 TENANT           subscription with trial_end, the evidence ledger row, the provisioning record complete.
 *   J3 SNAPSHOT      — the tier's live funnel snapshot applied through applySnapshotPayload (REAL), layers recorded.
 *   J4 WEBSITE       — a unique slug minted before the insert (a collision re-suffixes), /site/<slug> served by
 *                      app/site/[slug] from brokerages.slug, and the website_creation outcome evidenced.
 *   J5 SEAT INVITE   — inviteTenantMember (lib/kernel/users.ts, REAL, with createOrRepairUserDomainRecords) → the
 *                      auth invite dispatched, users row pinned, user_invitations pending, agents + role grant written,
 *                      invitation / user_creation / seat_provisioning outcomes evidenced.
 *   J6 LOGIN         — acceptUserInvitationOnFirstLogin (lib/onboarding/state-machine.ts, REAL) marks the invitation
 *                      accepted (COUNTED) and advances the brokerage onboarding; the callback never swallows it.
 *   J7 IMMEDIATE ERROR REPORTING — each failed post-condition reaches the owning manager IN THE REQUEST:
 *                      a refused snapshot layer → tenant_creation `operation.failed` + an open manager signal, and the
 *                      SAME door's retry resumes only the failed step; a refused invitation acceptance at login →
 *                      `invitation` failed + routed, returned `accepted: false` (it used to report success).
 *
 * WHAT IS INJECTED (env-bound executors only — the @proofSeam TenantCreationDeps): the auth invite of the OWNER, the ISA
 * actor, the starter-assistant image seed, curriculum authoring, the Stripe checkout and the login-time repair. The
 * service client is the in-memory client (lib/supabase/service stubbed in the module loader — the idiom
 * scripts/seat-user-convergence-guard.ts uses), with an auth.admin stand-in that records invites.
 * BLIND SPOTS: Supabase Auth itself (magic-link delivery, PKCE code exchange in the recipient's browser) is not run —
 * the callback's code exchange is covered by source reading only; a real browser sign-in needs a deployment; the
 * operating baseline and the readiness verdict run REAL where the in-memory client can carry them and say so otherwise.
 *
 * Run: npx tsx --conditions=react-server scripts/subscriber-provisioning-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const _require = createRequire(import.meta.url)
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─── THE CLIENT (before any kernel module loads) ─────────────────────────────────────────────────────────────
type Client = MemClient & { refuseUpdate: Set<string>; refuseWrite: Set<string>; invites: Array<{ email: string; redirectTo?: string }> }
function client(seed: Record<string, Row[]>): Client {
  const base: any = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [], agent_action_ledger: [], ...seed }, { uuidIds: true, stampCreatedAt: true })
  base.refuseUpdate = new Set<string>(); base.refuseWrite = new Set<string>(); base.invites = []
  base.rpc = async (fn: string, args: Row) => {
    if (fn === "advance_brokerage_onboarding") {
      const b = (base.tables.brokerages ?? []).find((r: Row) => r.id === args.p_brokerage_id)
      if (!b) return { data: null, error: { message: "no brokerage", code: "P0002" } }
      if (b.onboarding_status === "pending" && args.p_target_status === "in_progress") b.onboarding_status = "in_progress"
      return { data: b.onboarding_status, error: null }
    }
    return { data: null, error: null }
  }
  base.auth = { admin: {
    inviteUserByEmail: async (email: string, o: { redirectTo?: string; data?: Row } = {}) => {
      base.invites.push({ email, redirectTo: o.redirectTo })
      const id = randomUUID()
      // the live on_auth_user_created trigger seeds public.users with the auth id
      base.tables.users.push({ id, email, first_name: o.data?.first_name ?? "", last_name: o.data?.last_name ?? "", user_type: o.data?.user_type ?? "agent", brokerage_id: null, status: "active" })
      return { data: { user: { id, email } }, error: null }
    },
    listUsers: async () => ({ data: { users: (base.tables.users ?? []).map((u: Row) => ({ id: u.id, email: u.email })) }, error: null }),
    getUserById: async (id: string) => { const u = (base.tables.users ?? []).find((r: Row) => r.id === id); return { data: { user: u ? { id: u.id, email: u.email } : null }, error: null } },
  } }
  const orig = base.from.bind(base)
  base.from = (table: string) => {
    const q: any = orig(table)
    if (table === "manager_signals") { const ins = q.insert.bind(q); q.insert = (p: any) => ins(Array.isArray(p) ? p.map((r: any) => ({ status: "open", ...r })) : { status: "open", ...p }) }
    const refused = (kind: string) => ({ then: (res: any) => Promise.resolve(res({ data: null, error: { message: `${kind} on ${table} refused (fixture)`, code: "42501" } })), select() { return this }, eq() { return this }, single() { return this }, maybeSingle() { return this } })
    if (base.refuseUpdate.has(table)) q.update = () => refused("update")
    if (base.refuseWrite.has(table)) { q.update = () => refused("update"); q.upsert = () => refused("upsert"); q.insert = () => refused("insert") }
    return q
  }
  return base as Client
}
let ACTIVE: Client = client({})
;(globalThis as any).__SUB_PROOF_SERVICE__ = () => ACTIVE
{
  const isServiceLeaf = (r: string) => r === "@/lib/supabase/service" || /[\\/]lib[\\/]supabase[\\/]service(\.ts)?$/.test(r)
  const nodeModule: any = _require("node:module")
  const realLoad = nodeModule._load
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    if (isServiceLeaf(request)) return { createServiceClient: (globalThis as any).__SUB_PROOF_SERVICE__, createClient: (globalThis as any).__SUB_PROOF_SERVICE__ }
    if (request === "server-only" || /[\\/]node_modules[\\/]server-only[\\/]/.test(request)) return {}
    return realLoad.call(this, request, ...rest)
  }
  const SHIM = "vipre-subscriber-proof:service"
  const loader = `
export async function resolve(specifier, context, next) {
  if (specifier === "@/lib/supabase/service") return { shortCircuit: true, url: ${JSON.stringify(SHIM)} }
  const r = await next(specifier, context)
  if (/[\\\\/]lib[\\\\/]supabase[\\\\/]service\\.ts$/.test(r.url ?? "")) return { shortCircuit: true, url: ${JSON.stringify(SHIM)} }
  return r
}
export async function load(url, context, next) {
  if (url === ${JSON.stringify(SHIM)}) return { shortCircuit: true, format: "module", source: "export const createServiceClient = () => globalThis.__SUB_PROOF_SERVICE__(); export const createClient = createServiceClient" }
  return next(url, context)
}`
  const { register } = await import("node:module")
  try { register(`data:text/javascript,${encodeURIComponent(loader)}`) } catch { /* the CJS patch above still holds */ }
}
const { createTenantCore, TENANT_PROVISIONING_STEPS, provisioningComplete, tenantWebsitePath } = await import("../lib/kernel/tenant-creation")
const { inviteTenantMember } = await import("../lib/kernel/users")
const { acceptUserInvitationOnFirstLogin } = await import("../lib/onboarding/state-machine")
const { OPERATION_EVENT, OPERATION_SIGNAL_TYPE } = await import("../lib/kernel/immediate-operations")
const { siteUrl, invitationLandingUrl } = await import("../lib/platform/site-url")
const { createActivationCheckout } = await import("../lib/billing/subscription-activation")

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[J0 · deployment — the public origin, by variable NAME, through ONE resolver]")
const JOURNEY_FILES = [
  "lib/kernel/tenant-creation.ts", "lib/kernel/users.ts", "app/actions/auth/signup-brokerage.ts", "app/actions/admin/create-subscriber.ts",
  "app/actions/admin/invite-user.ts", "lib/portal/portal-invite-core.ts", "app/actions/vendor-invite.ts", "lib/onboarding/subscriber-stall.ts",
  "app/actions/billing.ts", "app/api/auth/reset-password/route.ts", "app/auth/callback/route.ts", "lib/billing/subscription-activation.ts",
  "lib/onboarding/state-machine.ts",
]
/** PURE — a journey file that builds a URL from the raw variable (or an invented host) instead of siteUrl(). */
const bareOrigin = (src: string) => /process\.env\.NEXT_PUBLIC_APP_URL|https?:\/\/localhost/.test(stripComments(src))
const offenders = JOURNEY_FILES.filter((f) => bareOrigin(read(f)))
check(`J0.1 no subscriber-journey file (${JOURNEY_FILES.length}) reads NEXT_PUBLIC_APP_URL raw or falls back to localhost — the origin is lib/platform/site-url.ts siteUrl()`, offenders.length === 0, offenders.join(", "))
check("J0.1 POSITIVE CONTROL — the old reset-password and checkout spellings are caught; a tombstone naming them is not",
  bareOrigin('redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/x`') && bareOrigin("const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? \"\")") && !bareOrigin("// was process.env.NEXT_PUBLIC_APP_URL\nconst o = siteUrl()"))
const saved = { app: process.env.NEXT_PUBLIC_APP_URL, vercel: process.env.VERCEL_URL }
try {
  delete process.env.NEXT_PUBLIC_APP_URL; delete process.env.VERCEL_URL
  const none = siteUrl(), noLanding = invitationLandingUrl()
  process.env.VERCEL_URL = "preview-abc.vercel.app"
  const preview = siteUrl()
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test/"
  const prod = siteUrl(), landing = invitationLandingUrl()
  check("J0.2 siteUrl(): NEXT_PUBLIC_APP_URL wins (trailing slash trimmed), else https://<VERCEL_URL>, else \"\" — and the invite landing is undefined with no origin, never relative",
    none === "" && noLanding === undefined && preview === "https://preview-abc.vercel.app" && prod === "https://app.example.test" && landing === "https://app.example.test/auth/callback?next=/dashboard/onboarding", `${none}|${preview}|${prod}|${landing}`)
} finally {
  if (saved.app === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = saved.app
  if (saved.vercel === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = saved.vercel
}
// Driven through the REAL createActivationCheckout: a relative URL is refused before ANY read (the tier lookup on an empty
// client would say "Plan tier not found" — so reaching that sentence with absolute URLs proves the URL gate let them through).
const emptyDb = client({ subscription_tiers: [] })
const rel = await createActivationCheckout(emptyDb, { brokerageId: randomUUID(), tierId: randomUUID(), billingCycle: "monthly", successUrl: "/login?activated=1", cancelUrl: "/login?activation=cancelled" })
const abs = await createActivationCheckout(emptyDb, { brokerageId: randomUUID(), tierId: randomUUID(), billingCycle: "monthly", successUrl: "https://app.example.test/login?activated=1", cancelUrl: "https://app.example.test/login?activation=cancelled" })
check("J0.3 the hosted checkout refuses a RELATIVE return URL before Stripe (and before any read) and names NEXT_PUBLIC_APP_URL; absolute URLs pass the gate (positive + negative control)",
  !rel.ok && /NEXT_PUBLIC_APP_URL/.test(rel.error) && emptyDb.writes.length === 0 && !abs.ok && /Plan tier not found/.test(abs.error), `${rel.ok ? "" : rel.error} | ${abs.ok ? "" : abs.error}`)

// ═════════════════════════════════════════════════════════════════════════════
const TIERS = ["solo_agent", "team", "brokerage", "multi_location"]
function seed(): Record<string, Row[]> {
  return {
    subscription_tiers: TIERS.map((t) => ({ id: randomUUID(), tier_name: t, is_active: true, max_agents: t === "solo_agent" ? 2 : t === "team" ? 10 : null, monthly_price_cents: 0, annual_price_cents: 0, setup_fee_cents: 0, display_name: t })),
    platform_config_snapshots: TIERS.map((t) => ({ id: randomUUID(), name: `${t} funnel`, created_at: "2026-10-01T00:00:00.000Z", payload: { recommendedTier: t, global: { app_name: "VIP" }, brand: { tagline: `${t} tagline` }, site: { about_text: "about" }, features: [] } })),
    learning_modules: [{ id: randomUUID(), brokerage_id: null, status: "published", audience_roles: ["agent", "broker"], display_priority: 2 }],
    // A pre-existing tenant whose slug the new tenant's FIRST candidate collides with (the website must re-suffix).
    brokerages: [{ id: randomUUID(), name: "Harbor Homes", slug: "harbor-homes-aaaa", email: "other@other.test", plan_tier: "team", billing_metadata: {} }],
    users: [], subscriptions: [], global_settings: [], brokerage_brand_settings: [], brand_voice_profile: [], feature_access_overrides: [],
    platform_prospects: [], ai_identity_profiles: [], agents: [], learning_assignments: [], user_invitations: [], teams: [],
    user_role_assignments: [], agent_onboarding: [], agent_commission_profiles: [], superadmin_audit_log: [], brokerage_settings: [],
  }
}
let counters = { isa: 0, assistant: 0, curriculum: 0, repair: 0 }
const deps = (svc: Client) => ({
  provisionOwner: async (p: any) => {
    const id = randomUUID()
    svc.tables.users.push({ id, email: p.email, first_name: p.firstName, last_name: p.lastName, user_type: "admin", brokerage_id: p.brokerageId, status: "active" })
    svc.invites.push({ email: p.email, redirectTo: p.redirectTo })
    return { success: true, userId: id, agentId: null, teamId: null, inviteSent: true }
  },
  isaActor: async () => { counters.isa++; return { userId: null, created: false } },
  starterAssistant: async () => { counters.assistant++; return { seeded: true, withPhoto: false } },
  curriculum: async () => { counters.curriculum++; return { authored: 0, topics: 0 } },
  accountRepair: async () => { counters.repair++; return { success: true, repaired: [] } },
  // the readiness verdict is the contract's own proof (test:tenant-readiness); here its STAMPING and its effect on
  // the immediate outcome are what the journey needs — ready unless a step failed.
  readiness: async (_s: any, id: string) => ({ ready: !((svc.tables.brokerages.find((b) => b.id === id)?.billing_metadata?.provisioning?.steps?.snapshot?.status) === "failed"), blockers: [], checkedAt: new Date().toISOString() }),
}) as any
const opEvents = (svc: Client, op: string, ok: boolean) => svc.tables.lifecycle_events.filter((e) => e.event_type === (ok ? OPERATION_EVENT.succeeded : OPERATION_EVENT.failed) && JSON.stringify(e.metadata ?? {}).includes(`"${op}"`))
const openSignals = (svc: Client, brokerageId: string) => svc.tables.manager_signals.filter((s) => s.brokerage_id === brokerageId && s.status === "open" && s.signal_type === OPERATION_SIGNAL_TYPE)

console.log("\n[J1–J4 · onboarding → tenant creation → snapshot application → automatic website]")
ACTIVE = client(seed())
const svc = ACTIVE
const baseInput = { brokerageName: "Harbor Homes", adminEmail: "Owner@Harbor.test", adminFirstName: "Dana", adminLastName: "Lee", tier: "team" as const, signupSource: "self_serve" as const, billing: { mode: "trial" as const, trialDays: 14 }, callerUserId: null }
// the first slug candidate collides with the existing tenant: the generator's suffix is random, so pin the collision by
// seeding EVERY 4-char suffix the core could try first? No — instead assert the RULE on the minted slug (unique, kebab).
let created: any
try { created = await createTenantCore(svc, baseInput, deps(svc)) } catch (e) { created = { ok: false, error: `threw: ${(e as Error).message}`, extrasSkipped: [] } }
const B = created.brokerageId as string
const brk = svc.tables.brokerages.find((b) => b.id === B)
const record = brk?.billing_metadata?.provisioning
check(`J1 the self-serve trial door creates the tenant (ok=${created.ok}${created.error ? `, ${created.error}` : ""})`, created.ok === true && !!brk)
check("J1 the owner is a users row of THIS tenant (admin), invited with the ONE landing (or the provider's Site URL when no origin)",
  svc.tables.users.some((u) => u.id === created.userId && u.brokerage_id === B && u.user_type === "admin") && svc.invites.some((i) => i.email === "owner@harbor.test"))
const sub = svc.tables.subscriptions.filter((s) => s.brokerage_id === B)
check("J2 ONE subscription row, 'trialing', with trial_end written (the paywall reads that column)", sub.length === 1 && sub[0].status === "trialing" && !!sub[0].trial_end)
check("J2 evidence: one agent_action_ledger row saas.tenant.provision under the minted tenant", svc.tables.agent_action_ledger.filter((l) => l.brokerage_id === B && l.action === "saas.tenant.provision").length === 1)
check(`J2 the provisioning record is complete (${TENANT_PROVISIONING_STEPS.length} steps terminal) and stamped with a READY verdict`, !!record && provisioningComplete(record) && !!record.completed_at && record.readiness?.ready === true,
  record ? TENANT_PROVISIONING_STEPS.filter((s) => !["done", "skipped"].includes(record.steps[s]?.status)).map((s) => `${s}:${record.steps[s]?.status}:${record.steps[s]?.error ?? ""}`).join(", ") : "no record")
check(`J3 the tier's live funnel snapshot was APPLIED through applySnapshotPayload (layers: ${(created.snapshotApplied ?? []).join(",") || "none"})`,
  record?.steps?.snapshot?.status === "done" && (created.snapshotApplied ?? []).length > 0 && created.snapshotName === "team funnel")
const slug = brk?.slug as string
check(`J4 the website slug is minted, kebab-cased and UNIQUE (${slug}); the result names its storefront ${created.websitePath}`,
  /^harbor-homes-[a-z0-9]+$/.test(slug ?? "") && svc.tables.brokerages.filter((b) => b.slug === slug).length === 1 && created.websitePath === tenantWebsitePath(slug))
const sitePage = stripComments(read("app/site/[slug]/page.tsx"))
check("J4 app/site/[slug] serves the storefront from brokerages.slug (the slug IS the website provisioning)", /from\(["']brokerages["']\)[\s\S]{0,400}\.eq\(["']slug["']/.test(sitePage) || /resolveTenantSite|bySlug|eq\(["']slug["']/.test(sitePage))
check("J4 the immediate outcome: tenant_creation AND website_creation evidenced as succeeded (lifecycle_events), nothing routed",
  opEvents(svc, "tenant_creation", true).length >= 1 && opEvents(svc, "website_creation", true).length >= 1 && openSignals(svc, B).length === 0,
  `tc=${opEvents(svc, "tenant_creation", true).length} web=${opEvents(svc, "website_creation", true).length} signals=${openSignals(svc, B).length} events=${svc.tables.lifecycle_events.map((e) => e.event_type).join(",")}`)

console.log("\n[J5 · seat / user invites — the REAL inviteTenantMember → createOrRepairUserDomainRecords]")
let invited: any
try { invited = await inviteTenantMember({ brokerageId: B, email: "New.Agent@Harbor.test", firstName: "Sam", lastName: "Agent", userType: "agent", callerUserId: created.userId, client: svc as never }) } catch (e) { invited = { success: false, error: `threw: ${(e as Error).message}` } }
const member = svc.tables.users.find((u) => u.email === "new.agent@harbor.test")
check(`J5 the invite succeeds (success=${invited.success}${invited.error ? `, ${invited.error}` : ""}) and the auth invite was dispatched in the request`, invited.success === true && svc.invites.some((i) => i.email === "new.agent@harbor.test"))
check("J5 the member's users row is pinned to the auth id, THIS tenant and the role (users.id === auth id)", !!member && member.id === invited.userId && member.brokerage_id === B && member.user_type === "agent")
check("J5 the invitation is tracked pending for the first sign-in", svc.tables.user_invitations.some((i) => i.brokerage_id === B && i.email === "new.agent@harbor.test" && i.status === "pending"))
check("J5 domain records: an agents row and a role grant for the member under THIS tenant", svc.tables.agents.some((a) => a.user_id === invited.userId && a.brokerage_id === B) && svc.tables.user_role_assignments.some((g) => g.user_id === invited.userId))
check("J5 evidence: invitation + seat_provisioning outcomes succeeded for the member", opEvents(svc, "invitation", true).length >= 1 && opEvents(svc, "seat_provisioning", true).length >= 1)

console.log("\n[J6 · login — the first sign-in accepts the invitation (COUNTED) and advances onboarding]")
const before = svc.tables.brokerages.find((b) => b.id === B)?.onboarding_status
const accepted = await acceptUserInvitationOnFirstLogin({ userId: invited.userId, email: "New.Agent@Harbor.test", brokerageId: B, client: svc as never })
check(`J6 the invitation is marked accepted with the member's id (accepted=${accepted.accepted})`, accepted.accepted === true && svc.tables.user_invitations.some((i) => i.email === "new.agent@harbor.test" && i.status === "accepted" && i.accepted_user_id === invited.userId))
check(`J6 a non-admin acceptance advances the brokerage onboarding (${before} → ${svc.tables.brokerages.find((b) => b.id === B)?.onboarding_status})`, before === "pending" && accepted.advanced === "in_progress")
const again = await acceptUserInvitationOnFirstLogin({ userId: invited.userId, email: "new.agent@harbor.test", brokerageId: B, client: svc as never })
check("J6 idempotent — a second sign-in finds no pending invitation and reports nothing", again.accepted === false && !again.error)
const callback = stripComments(read("app/auth/callback/route.ts"))
/** PURE — an empty catch (`catch {}` / `catch { }` / `catch (e) {}`) in a file: a swallowed first-login failure. */
const emptyCatch = (src: string) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(src)
check("J6 the auth callback reads the acceptance result and never swallows the hook with an empty catch", /acceptUserInvitationOnFirstLogin\(/.test(callback) && /accepted\.error/.test(callback) && !emptyCatch(callback))
check("J6 POSITIVE CONTROL — the old empty catch is caught on a fixture (comments stripped first)", emptyCatch(stripComments("try { await x() } catch {\n  // Non-fatal — advisory.\n}")) && !emptyCatch("try { a() } catch (e) { log(e) }"))

console.log("\n[J7 · immediate error reporting — a failed post-condition reaches the owner IN THE REQUEST, and the retry resumes]")
// (a) a refused snapshot layer during tenant creation
ACTIVE = client(seed())
const svc2 = ACTIVE
svc2.refuseWrite.add("global_settings")
let bad: any
try { bad = await createTenantCore(svc2, { ...baseInput, brokerageName: "Cove Realty", adminEmail: "owner@cove.test" }, deps(svc2)) } catch (e) { bad = { ok: false, error: `threw: ${(e as Error).message}`, extrasSkipped: [] } }
const B2 = bad.brokerageId as string
const rec2 = svc2.tables.brokerages.find((b) => b.id === B2)?.billing_metadata?.provisioning
check(`J7.1 the tenant still exists (creation never fails on a day-one layer) and the snapshot step is recorded FAILED with its reason (${rec2?.steps?.snapshot?.error ?? "no error"})`,
  bad.ok === true && rec2?.steps?.snapshot?.status === "failed" && /global_settings|refused/i.test(rec2?.steps?.snapshot?.error ?? ""))
check("J7.1 IMMEDIATE: tenant_creation evidenced as FAILED (lifecycle_events) and ONE open signal routed to the owning manager — before any cron",
  opEvents(svc2, "tenant_creation", false).length >= 1 && openSignals(svc2, B2).length >= 1, `failed=${opEvents(svc2, "tenant_creation", false).length} signals=${openSignals(svc2, B2).length}`)
check("J7.1 POSITIVE CONTROL — the clean tenant above has no failed tenant_creation event and no open signal", opEvents(svc, "tenant_creation", false).length === 0 && openSignals(svc, B).length === 0)
svc2.refuseWrite.delete("global_settings")
const ledgerBefore = svc2.tables.agent_action_ledger.filter((l) => l.brokerage_id === B2).length
const subsBefore = svc2.tables.subscriptions.filter((s) => s.brokerage_id === B2).length
let resumed: any
try { resumed = await createTenantCore(svc2, { ...baseInput, brokerageName: "Cove Realty", adminEmail: "owner@cove.test" }, deps(svc2)) } catch (e) { resumed = { ok: false, error: `threw: ${(e as Error).message}` } }
const rec2b = svc2.tables.brokerages.find((b) => b.id === B2)?.billing_metadata?.provisioning
check(`J7.2 the SAME door's retry RESUMES (resumed=${resumed.resumed}): the snapshot now done, the record complete, no second brokerage / subscription`,
  resumed.ok === true && resumed.resumed === true && rec2b?.steps?.snapshot?.status === "done" && provisioningComplete(rec2b) && svc2.tables.brokerages.filter((b) => b.name === "Cove Realty").length === 1 && svc2.tables.subscriptions.filter((s) => s.brokerage_id === B2).length === subsBefore,
  `${resumed.error ?? ""}`)
check("J7.2 the resume is its own evidenced attempt (a second ledger row, attempts = 2)", svc2.tables.agent_action_ledger.filter((l) => l.brokerage_id === B2).length === ledgerBefore + 1 && rec2b?.attempts === 2)
// (b) a refused invitation acceptance at first login
const inv2 = await inviteTenantMember({ brokerageId: B2, email: "tc@cove.test", firstName: "Terry", lastName: "Coord", userType: "tc", callerUserId: bad.userId, client: svc2 as never })
svc2.refuseUpdate.add("user_invitations")
const failedAccept = await acceptUserInvitationOnFirstLogin({ userId: inv2.userId as string, email: "tc@cove.test", brokerageId: B2, client: svc2 as never })
check(`J7.3 a refused acceptance UPDATE is NOT success: accepted=false with the reason (${failedAccept.error ?? "none"}) — it used to return accepted: true`, failedAccept.accepted === false && /NOT marked accepted/.test(failedAccept.error ?? ""))
check("J7.3 IMMEDIATE: the invitation failure is evidenced (operation.failed · invitation) and routed to the owning manager",
  opEvents(svc2, "invitation", false).length >= 1 && openSignals(svc2, B2).some((s) => JSON.stringify(s.payload ?? s.metadata ?? {}).includes("invitation")), `failed=${opEvents(svc2, "invitation", false).length}`)
svc2.refuseUpdate.delete("user_invitations")
// an update that matches NOTHING (the invitation flipped between read and write) also resolves — it must be counted
const flipped = svc2.tables.user_invitations.find((i) => i.email === "tc@cove.test")
const origFrom = (svc2 as any).from
;(svc2 as any).from = (t: string) => { const q = origFrom(t); if (t === "user_invitations") { const upd = q.update.bind(q); q.update = (p: Row) => { if (flipped) flipped.status = "revoked"; return upd(p) } } return q }
const zeroMatch = await acceptUserInvitationOnFirstLogin({ userId: inv2.userId as string, email: "tc@cove.test", brokerageId: B2, client: svc2 as never })
;(svc2 as any).from = origFrom
check("J7.4 an acceptance UPDATE that matches 0 rows is COUNTED and reported, never read as success (CLAUDE.md §3)", zeroMatch.accepted === false && /matched 0 rows/.test(zeroMatch.error ?? ""))

console.log("\n[blind spots]")
console.log("  · Supabase Auth is not run: the magic link's delivery and the PKCE code exchange in the recipient's browser need a deployment (the callback's exchange is read from source)")
console.log("  · the readiness verdict is injected here (proven by test:tenant-readiness); its effect on the immediate outcome is what this journey asserts")
console.log("  · the ISA actor, starter assistant, curriculum author and Stripe checkout are env-bound executors, counted not run (test:subscriber-convergence owns the door matrix)")
console.log(`  · counted executors: isa ${counters.isa} · assistant ${counters.assistant} · curriculum ${counters.curriculum} · repair ${counters.repair}`)
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
