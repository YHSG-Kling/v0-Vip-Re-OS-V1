/**
 * scripts/canaries/_harness.ts — shared plumbing for the SYNTHETIC PRODUCTION CANARIES
 * (wave 140, lane L; owner: "synthetic business-chain journeys on test tenants with
 * providers/mocks per repo policy — never live customer messages/payments; test data
 * tagged + deleted with counts").
 *
 * NOT A FOURTH SYSTEM. Three survivors are reused, none re-spelled:
 *   · scripts/in-memory-supabase.ts memSupabase — THE fake-client convention (resolves
 *     refusals like supabase-js, models .select() on writes so writers can COUNT rows).
 *   · the node:module registerHooks stub for "@/lib/supabase/service" (first used by
 *     scripts/tenant-paid-lead-spend-guard.ts:50) — the kernel services that construct
 *     their own service client (users.ts, crm.ts, lifecycle-logger.ts, action-ledger.ts…)
 *     receive the canary client WITHOUT a code change in lib/.
 *   · the e2e cleanup idiom (scripts/e2e-lead-to-transaction.ts) — every row a canary
 *     writes is deleted with `.delete()…select("id")` and the returned rows are COUNTED
 *     (CLAUDE.md §3: a delete that matches nothing also resolves).
 *
 * TEST-DATA POLICY (run-vip-re-os skill + LANE_PREAMBLE §8): every synthetic tenant is
 * named with CANARY_TAG, every synthetic person's email ends in CANARY_EMAIL_DOMAIN, and
 * cleanup proves inserted == deleted and residual == 0 against the tag predicates.
 *   · default (no CANARY_LIVE): fully in-memory — no network, no database, no provider.
 *   · CANARY_LIVE=1 + SUPABASE creds: the SAME chain code runs against the live project
 *     through a real service client; the two canaries that INVITE an auth user
 *     (subscriber, seat) refuse in live mode because an invite is an outbound email.
 *     Live cleanup deletes by brokerage_id over CANARY_TENANT_TABLES, children first.
 * PROVIDERS STUBBED (never live): Supabase Auth admin (invite → deterministic auth id +
 * the on_auth_user_created trigger's users seed, modelled), rpc (refused, read as an
 * error), storage (refused). Email/SMS/mail/voice never reach a dispatcher: the
 * communication canary uses the PORTAL channel and a NO-CONSENT contact on SMS so the
 * compliance gate blocks BEFORE any provider (the portal-e2e-simulator's own method).
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import { memSupabase, type MemClient, type MemOptions, type Row } from "../in-memory-supabase"

/**
 * WAVE 144 (lane 144J): a module ANOTHER LANE lands this wave, or null while its FILE does not exist. Path relative to
 * scripts/canaries/. Only a missing file reads as "not landed": a file that exists and fails to load THROWS (a broken
 * landing is a failure, never a quiet "not yet"). A wave-144 canary drives the landed survivor through it, so the same
 * step is red at the base commit and green the moment the lane's behaviour meets the ruling — no edit in between.
 */
export async function landedModule<T = Record<string, any>>(relFromCanaries: string): Promise<T | null> {
  const url = new URL(relFromCanaries, import.meta.url)
  if (!existsSync(fileURLToPath(url))) return null
  return (await import(url.href)) as T
}

export const CANARY_TAG = "wave140-canary"
export const CANARY_EMAIL_DOMAIN = "wave140-canary.test"
export const uuid = (): string => randomUUID()
export const nowIso = (): string => new Date().toISOString()

export const LIVE =
  process.env.CANARY_LIVE === "1" &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !!(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL)

// ── the service-client seam (the kernel's own createServiceClient resolves to the canary client) ──
const G = globalThis as unknown as { __W140: { svc: unknown } }
G.__W140 = { svc: null }
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { const s = globalThis.__W140.svc; if (!s) throw new Error('canary: no client installed (setSvc first)'); return s }",
  // The SESSION client (lib/supabase/server.ts createClient reads next/headers cookies — no request
  // scope here). In a canary the session IS the synthetic tenant's actor, so it resolves to the same
  // tenant-seeded client. BLIND SPOT, published: RLS is not modelled — the tenant predicates the
  // kernel writes are what scope the reads, which is exactly what the chains assert.
  // WAVE 142 (lane 142J): the real module also exports `createClient as createServerClient` (lib/supabase/server.ts:64 —
  // lib/events/event-helpers.ts imports that name); the stub mirrors both so a kernel event fan-out links here.
  "@/lib/supabase/server": "export const createClient = async () => { const s = globalThis.__W140.svc; if (!s) throw new Error('canary: no client installed (setSvc first)'); return s }; export const createServerClient = createClient",
}
registerHooks({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:module's ResolveHookSync shape (the repo's idiom)
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    // WAVE 141 (lane 141J): a stub may be a FILE (a `file:` URL to a .ts module that re-exports the real
    // module and overrides one door) — the data: form cannot `export *`, and a named import of a missing
    // export is a link-time error, not a runtime one.
    if (stub !== undefined) return { url: stub.startsWith("file:") ? stub : `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})
export function setSvc(svc: unknown): void { G.__W140.svc = svc }

/**
 * WAVE 141 (lane 141J): a canary may stub ONE more module by specifier BEFORE it first imports the graph
 * that reaches it (the CRM sync-out canary stubs the connector gateway so the egress is RECORDED, never
 * sent). The resolve hook reads the map on every resolution, so a stub installed after a module was
 * already loaded does not reach that module's importers — a canary therefore ASSERTS the stub was hit.
 * `source` is JavaScript text (data: URL) or a `file:` URL.
 */
export function stubModule(spec: string, source: string): void { STUB_BY_SPEC[spec] = source }

/** WAVE 141 (lane 141J): what the stubbed Auth admin was asked to do, in order — the user-invite
 *  canary proves the invite is attempted IN the request and its result READ. */
export interface CanaryAuthCall { method: "inviteUserByEmail" | "createUser"; email: string; ok: boolean }
/** Faults a canary injects ONCE (consumed on first use) to prove a refusal is read, never swallowed. */
export interface CanaryControls {
  authCalls: CanaryAuthCall[]; faults: { inviteUserByEmail?: { message: string } | null }
  /** WAVE 144 (lane 144J): an OPT-IN session actor. null (the default — every pre-144 canary) = nobody is signed in. A canary that
   *  drives a SESSION-bound gate for real (canProceedToClosingPrep reads getAgentContext → auth.getUser) sets the seeded users.id
   *  of the actor whose button it presses (setSessionUser), so the real gate runs instead of a stub. */
  sessionUserId: string | null
}
/** WAVE 144 (lane 144J): sign the canary's synthetic actor in (or out with null) on an in-memory client. */
export function setSessionUser(svc: CanarySvc, userId: string | null): void { svc.canary.sessionUserId = userId }

export type CanarySvc = MemClient & { canary: CanaryControls }

/** WAVE 141 (lane 141K): the live UNIQUE constraints the chains' idempotency RIDES — the action ledger's
 *  at-most-once (claim → 23505 → replay; lib/kernel/action-ledger.ts) and the coupon redemption ledger's
 *  one-per-tenant row (lib/billing/discount-codes.ts recordCouponRedemption reads 23505 as "already"). Modelled
 *  by the in-memory client (memSupabase `unique`), published as the fixture it is: a UNIQUE the live schema has
 *  and this list does not name is not modelled. */
const CANARY_UNIQUE: Record<string, string[][]> = {
  agent_action_ledger: [["idempotency_key"]],
  platform_coupon_redemptions: [["coupon_id", "brokerage_id"]],
}

/**
 * The canary client. In-memory by default; the live service client under CANARY_LIVE.
 * The in-memory one carries the provider stubs the kernel reaches for (auth.admin, rpc, storage).
 *
 * WAVE 142 (lane 142J): `opts` passes the in-memory client's REFUSAL shapes through (a table that is refused
 * RLS-style, a missing table, a missing column) so a canary can prove a best-effort rail is best-effort — the
 * immediate-enrichment canary refuses lead_enrichment_queue and asserts the capture still succeeds. Ignored live.
 */
export function canaryClient(seed: Record<string, Row[]> = {}, opts: Pick<MemOptions, "refuse" | "missingTables" | "missingColumns"> = {}): CanarySvc {
  if (LIVE) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js")
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ""
    const live = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { autoRefreshToken: false, persistSession: false } })
    ;(live as unknown as { canary: CanaryControls }).canary = { authCalls: [], faults: {}, sessionUserId: null }
    return live as unknown as CanarySvc
  }
  const mem = memSupabase(seed, { stampCreatedAt: true, uuidIds: true, unique: CANARY_UNIQUE, ...opts })
  const authUsers: Array<{ id: string; email: string }> = []
  const controls: CanaryControls = { authCalls: [], faults: {}, sessionUserId: null }
  const admin = {
    // The auth user exists FIRST and the on_auth_user_created trigger seeds public.users with
    // the auth id (lib/kernel/users.ts provisionTenantOwner's invariant) — modelled here.
    inviteUserByEmail: async (email: string) => {
      const e = email.toLowerCase()
      // An injected refusal (consumed once): the provider said no — no auth user, no trigger seed.
      const fault = controls.faults.inviteUserByEmail
      if (fault) { controls.faults.inviteUserByEmail = null; controls.authCalls.push({ method: "inviteUserByEmail", email: e, ok: false }); return { data: { user: null }, error: { message: fault.message, code: "canary_fault" } } }
      const id = uuid()
      authUsers.push({ id, email: e })
      ;(mem.tables.users ??= []).push({ id, email: e, created_at: nowIso() })
      controls.authCalls.push({ method: "inviteUserByEmail", email: e, ok: true })
      return { data: { user: { id, email: e } }, error: null }
    },
    // createUser — the ISA system actor (lib/auth/provision-isa-actor.ts) and any staff-created seat: same
    // invariant as the invite (auth user first, the trigger seeds public.users with the auth id).
    createUser: async (attrs: { email?: string; user_metadata?: Record<string, unknown> }) => {
      const e = (attrs.email ?? `${uuid()}@${CANARY_EMAIL_DOMAIN}`).toLowerCase()
      const dup = authUsers.find((u) => u.email === e)
      if (dup) { controls.authCalls.push({ method: "createUser", email: e, ok: false }); return { data: { user: null }, error: { message: "A user with this email address has already been registered", code: "email_exists" } } }
      const id = uuid()
      authUsers.push({ id, email: e })
      ;(mem.tables.users ??= []).push({ id, email: e, created_at: nowIso() })
      controls.authCalls.push({ method: "createUser", email: e, ok: true })
      return { data: { user: { id, email: e, user_metadata: attrs.user_metadata ?? {} } }, error: null }
    },
    listUsers: async () => ({ data: { users: authUsers }, error: null }),
    getUserById: async (id: string) => ({ data: { user: authUsers.find((u) => u.id === id) ?? null }, error: null }),
    updateUserById: async () => ({ data: { user: null }, error: null }),
    deleteUser: async () => ({ data: null, error: null }),
    generateLink: async () => ({ data: null, error: { message: "canary: generateLink is not modelled" } }),
  }
  const m = mem as unknown as Record<string, unknown>
  // signInWithOtp is the portal-invite email (captureContact's non-fatal portal invite): a PROVIDER REFUSAL,
  // read by the kernel as an error — never a TypeError from a missing door (wave 141).
  m.auth = {
    admin,
    signInWithOtp: async () => ({ data: { user: null, session: null }, error: { message: "canary: the portal invite (OTP email) is not sent", code: "canary_refused" } }),
    // WAVE 142 (lane 142J): a canary has NO SESSION — the session gate (lib/auth/require-caller.ts resolveCallerIdentity →
    // supabase.auth.getUser()) must read "nobody is signed in", never a TypeError from a missing door, so a sessionless
    // automation (auto-execute-offer presenting CRON_SECRET) takes its own admitted path and a session-only door refuses.
    getUser: async () => {
      // WAVE 144 (lane 144J): the opt-in session actor (setSessionUser) — default null keeps "nobody is signed in".
      if (controls.sessionUserId) {
        const u = (mem.tables.users ?? []).find((r) => r.id === controls.sessionUserId)
        return { data: { user: { id: controls.sessionUserId, email: u?.email ?? null, user_metadata: {}, app_metadata: {} } }, error: null }
      }
      return { data: { user: null }, error: { message: "canary: no session (a sessionless automation, or nobody signed in)", code: "canary_no_session" } }
    },
  }
  m.rpc = async (fn: string) => ({ data: null, error: { message: `canary: rpc ${fn} is not modelled (refused, not faked)`, code: "42883" } })
  m.storage = { from: () => ({ upload: async () => ({ data: null, error: { message: "canary: storage is not modelled" } }), remove: async () => ({ data: null, error: null }) }) }
  m.canary = controls
  return mem as CanarySvc
}

// ── the report every canary publishes ───────────────────────────────────────────────
/** `hook` names the wave-141 lane whose contract this step is written against while that lane's module
 *  is absent at HEAD: the step is PENDING (counted, printed ⏳, never a pass of the contract itself). */
export interface CanaryStep {
  step: string; ok: boolean; evidence: string; hook?: string
  /** WAVE 144 (lane 144J): a step that encodes an OWNER RULING names who owns the behaviour — the wave-144 lane whose brief
   *  carries the fix ("144D"), or "defect" when no lane's brief owns it. A ruling step is NEVER pending: false is RED, it fails
   *  the canary, and the runner classifies it red-awaiting-lane-X / red-defect (scripts/canaries/_registry.ts rulingVerdict). */
  owner?: RulingOwner
}
/** WAVE 144 (lane 144J): the owner of a ruling step — a wave-144 lane, or "defect" (no lane's brief owns the fix). */
export type Wave144Lane = "144A" | "144B" | "144C" | "144D" | "144E" | "144F" | "144G" | "144H" | "144I"
export type RulingOwner = Wave144Lane | "defect"
export interface CanaryCleanup { table: string; deleted: number }
export interface CanaryReport {
  chain: string
  steps: CanaryStep[]
  blindSpots: string[]
  cleanup: CanaryCleanup[]
  residual: number
  skipped: string | null
  passed: boolean
  /** WAVE141 HOOK steps still pending (a lane's module absent) — published beside the RESULT line. */
  hooks: number
}

export function canary(chain: string) {
  const steps: CanaryStep[] = []
  const blindSpots: string[] = []
  return {
    step(step: string, ok: boolean, evidence = ""): boolean {
      steps.push({ step, ok, evidence })
      console.log(`    ${ok ? "✓" : "✗"} ${step}${evidence ? ` — ${evidence.slice(0, 200)}` : ""}`)
      return ok
    },
    /** A step written against another lane's CONTRACT whose module does not exist at HEAD (wave 141; wave 142
     *  reuses it — the wave is read off the lane, "141B" → WAVE141, "142C" → WAVE142): recorded as pending — it
     *  does not fail the canary and it is NOT a pass; the release gate reads it. */
    hook(lane: string, contract: string, evidence = ""): void {
      steps.push({ step: `WAVE${lane.slice(0, 3)} HOOK (${lane}): ${contract}`, ok: true, evidence, hook: lane })
      console.log(`    ⏳ HOOK ${lane} — ${contract.slice(0, 160)}${evidence ? ` — ${evidence.slice(0, 120)}` : ""}`)
    },
    /** WAVE 144 (lane 144J): an OWNER-RULING step. Same as step() — a false is a failure, never pending — plus the owner the
     *  verdict table names. `owner` is the lane whose brief carries the behaviour (a green ruling step still names it: the
     *  lane that must PRESERVE it), or "defect" when no wave-144 brief owns it. */
    rule(owner: RulingOwner, step: string, ok: boolean, evidence = ""): boolean {
      steps.push({ step, ok, evidence, owner })
      console.log(`    ${ok ? "✓" : "✗"} [${owner}] ${step}${evidence ? ` — ${evidence.slice(0, 220)}` : ""}`)
      return ok
    },
    blind(s: string) { blindSpots.push(s) },
    allOk: () => steps.every((s) => s.ok),
    report(cleanup: CanaryCleanup[], residual: number, skipped: string | null = null): CanaryReport {
      return { chain, steps, blindSpots, cleanup, residual, skipped, passed: skipped !== null || (steps.every((s) => s.ok) && residual === 0), hooks: steps.filter((s) => s.hook).length }
    },
  }
}

/** Live-mode cleanup order (children first). In-memory mode scans every table instead. */
const CANARY_TENANT_TABLES = [
  "transparency_updates", "agent_client_messages", "outcome_reconciliations", "manager_signals", "self_heal_events",
  "agent_action_ledger", "activities", "lifecycle_events", "kernel_events", "lead_enrichment_queue", "lead_sla_tracking",
  // wave 141 canaries (lane 141J): lead magnets, QR, domains, provider credentials, notifications, forms
  "form_submissions", "valuation_requests", "qr_codes", "lead_capture_forms", "notifications", "tenant_custom_domains",
  "platform_credentials", "brokerage_integrations", "provider_overrides", "brokerage_forms", "business_card_scans",
  "listings", "contacts", "leads", "user_role_assignments", "agent_onboarding", "agents", "user_invitations",
  "global_settings", "brokerage_brand_settings", "subscriptions", "users", "teams", "brokerages",
]

const rowIsCanary = (r: Row, brokerageId: string | null): boolean => {
  if (brokerageId && (r.brokerage_id === brokerageId || r.id === brokerageId)) return true
  const s = JSON.stringify(r)
  return s.includes(CANARY_TAG) || s.includes(`@${CANARY_EMAIL_DOMAIN}`)
}

/**
 * Delete every row the canary wrote and COUNT what came back. Returns per-table counts and the
 * residual (rows still matching the tag predicates after the delete — must be 0).
 */
export async function cleanupCanary(svc: CanarySvc, brokerageId: string | null): Promise<{ cleanup: CanaryCleanup[]; residual: number; mismatches: string[] }> {
  const cleanup: CanaryCleanup[] = []
  const mismatches: string[] = []
  if (LIVE) {
    if (!brokerageId) return { cleanup, residual: 0, mismatches }
    for (const table of CANARY_TENANT_TABLES) {
      const col = table === "brokerages" ? "id" : "brokerage_id"
      const { data, error } = await (svc as unknown as { from: (t: string) => any }).from(table).delete().eq(col, brokerageId).select("id")
      if (error) { mismatches.push(`${table}: ${error.message}`); continue }
      cleanup.push({ table, deleted: (data ?? []).length })
    }
    const { data: left } = await (svc as unknown as { from: (t: string) => any }).from("brokerages").select("id").eq("id", brokerageId)
    return { cleanup, residual: (left ?? []).length, mismatches }
  }
  for (const [table, rows] of Object.entries(svc.tables)) {
    const ids = rows.filter((r) => rowIsCanary(r, brokerageId)).map((r) => String(r.id))
    if (ids.length === 0) continue
    const { data, error } = await svc.from(table).delete().in("id", ids).select("id")
    const deleted = error ? -1 : (data ?? []).length
    cleanup.push({ table, deleted })
    if (deleted !== ids.length) mismatches.push(`${table}: wanted ${ids.length}, delete returned ${deleted}${error ? ` (${error.message})` : ""}`)
  }
  let residual = 0
  for (const rows of Object.values(svc.tables)) residual += rows.filter((r) => rowIsCanary(r, brokerageId)).length
  return { cleanup, residual, mismatches }
}
