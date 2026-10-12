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
import { registerHooks } from "node:module"
import { memSupabase, type MemClient, type Row } from "../in-memory-supabase"

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
  "@/lib/supabase/server": "export const createClient = async () => { const s = globalThis.__W140.svc; if (!s) throw new Error('canary: no client installed (setSvc first)'); return s }",
}
registerHooks({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:module's ResolveHookSync shape (the repo's idiom)
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})
export function setSvc(svc: unknown): void { G.__W140.svc = svc }

export type CanarySvc = MemClient

/**
 * The canary client. In-memory by default; the live service client under CANARY_LIVE.
 * The in-memory one carries the provider stubs the kernel reaches for (auth.admin, rpc, storage).
 */
export function canaryClient(seed: Record<string, Row[]> = {}): CanarySvc {
  if (LIVE) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js")
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ""
    const live = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { autoRefreshToken: false, persistSession: false } })
    return live as unknown as CanarySvc
  }
  const mem = memSupabase(seed, { stampCreatedAt: true, uuidIds: true })
  const authUsers: Array<{ id: string; email: string }> = []
  const admin = {
    // The auth user exists FIRST and the on_auth_user_created trigger seeds public.users with
    // the auth id (lib/kernel/users.ts provisionTenantOwner's invariant) — modelled here.
    inviteUserByEmail: async (email: string) => {
      const id = uuid()
      const e = email.toLowerCase()
      authUsers.push({ id, email: e })
      ;(mem.tables.users ??= []).push({ id, email: e, created_at: nowIso() })
      return { data: { user: { id, email: e } }, error: null }
    },
    // createUser — the ISA system actor (lib/auth/provision-isa-actor.ts) and any staff-created seat: same
    // invariant as the invite (auth user first, the trigger seeds public.users with the auth id).
    createUser: async (attrs: { email?: string; user_metadata?: Record<string, unknown> }) => {
      const e = (attrs.email ?? `${uuid()}@${CANARY_EMAIL_DOMAIN}`).toLowerCase()
      const dup = authUsers.find((u) => u.email === e)
      if (dup) return { data: { user: null }, error: { message: "A user with this email address has already been registered", code: "email_exists" } }
      const id = uuid()
      authUsers.push({ id, email: e })
      ;(mem.tables.users ??= []).push({ id, email: e, created_at: nowIso() })
      return { data: { user: { id, email: e, user_metadata: attrs.user_metadata ?? {} } }, error: null }
    },
    listUsers: async () => ({ data: { users: authUsers }, error: null }),
    getUserById: async (id: string) => ({ data: { user: authUsers.find((u) => u.id === id) ?? null }, error: null }),
    updateUserById: async () => ({ data: { user: null }, error: null }),
    deleteUser: async () => ({ data: null, error: null }),
    generateLink: async () => ({ data: null, error: { message: "canary: generateLink is not modelled" } }),
  }
  const m = mem as unknown as Record<string, unknown>
  m.auth = { admin }
  m.rpc = async (fn: string) => ({ data: null, error: { message: `canary: rpc ${fn} is not modelled (refused, not faked)`, code: "42883" } })
  m.storage = { from: () => ({ upload: async () => ({ data: null, error: { message: "canary: storage is not modelled" } }), remove: async () => ({ data: null, error: null }) }) }
  return mem
}

// ── the report every canary publishes ───────────────────────────────────────────────
export interface CanaryStep { step: string; ok: boolean; evidence: string }
export interface CanaryCleanup { table: string; deleted: number }
export interface CanaryReport {
  chain: string
  steps: CanaryStep[]
  blindSpots: string[]
  cleanup: CanaryCleanup[]
  residual: number
  skipped: string | null
  passed: boolean
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
    blind(s: string) { blindSpots.push(s) },
    allOk: () => steps.every((s) => s.ok),
    report(cleanup: CanaryCleanup[], residual: number, skipped: string | null = null): CanaryReport {
      return { chain, steps, blindSpots, cleanup, residual, skipped, passed: skipped !== null || (steps.every((s) => s.ok) && residual === 0) }
    },
  }
}

/** Live-mode cleanup order (children first). In-memory mode scans every table instead. */
const CANARY_TENANT_TABLES = [
  "transparency_updates", "agent_client_messages", "outcome_reconciliations", "manager_signals", "self_heal_events",
  "agent_action_ledger", "activities", "lifecycle_events", "kernel_events", "lead_enrichment_queue", "lead_sla_tracking",
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
