/**
 * lib/kernel/domain-api.ts — THE VERSIONED DOMAIN API CONTRACT (v1), wave 137A.
 *
 * ONE pipeline, every resource, in this order (owner constitution, wave 137):
 *
 *   API → CREDENTIAL (agent_credentials: sha256 at rest, scopes, brokerage-bound, revocable,
 *         expiring, last_used_at — resolved by THE survivor lib/agentic-os/agent-credentials.ts
 *         resolveAgenticCaller, token-only: a cookie session never authenticates here)
 *       → TENANT FROM THE CREDENTIAL (its brokerage_id; a platform token with no tenant is refused;
 *         a query/body `brokerageId` is never read)
 *       → PER-CREDENTIAL RATE LIMIT, two layers (wave 138D): the in-memory survivor lib/security/
 *         public-rate-limit.ts as the per-instance FAST PATH, then the DURABLE ceiling that holds across
 *         instances — the credential's own evidence rows (agentic_invocation_log, kind "domain",
 *         detail.credential_id) counted in the database over the window (durableRateVerdict below).
 *         429 + Retry-After + an evidence row; an uncountable window refuses (503, fail closed)
 *       → SCOPE (lib/agentic-os/agent-scopes.ts hasScope) → ENTITLEMENT (mayUseAndAfford app.access)
 *       → DOMAIN SERVICE (the reads below; the one write is requestDelegation — the manager-delegation
 *         service applies its own review / authority / entitlement and writes withActionLedger +
 *         emitKernelEvent evidence; this file never inserts a domain row)
 *       → EVIDENCE (an agentic_invocation_log row, kind "domain", on EVERY outcome — served, refused,
 *         rate-limited — through lib/agentic-os/invocation-log.ts recordInvocation)
 *
 * TOKEN MINTING (owner ruling, wave 138): minting / rotating / revoking a credential STAYS on the current narrower
 * gate — the tenancy principal (app/actions/tenant-webhooks.ts principalGate, a subset of TENANT_ADMIN_USER_TYPES);
 * team_lead and compliance_officer do not mint. Not widened here.
 *
 * The route handler (app/api/v1/[resource]/route.ts) holds no business logic: it hands the request
 * here. v1 is READ + CAPABILITY REQUEST only (owner: "prefer read + capability-request in v1").
 *
 * No financials leave through v1 (CLAUDE.md §5): the projections name their columns and carry no
 * commission / cost / acquisition-cost field. Agents are not callers here — a credential is the
 * BROKERAGE's, which is why `opportunity` (leads) is readable with lead:read (leads belong to the
 * brokerage).
 */
import { hasScope } from "@/lib/agentic-os/agent-scopes"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "@/lib/agentic-os/capability-ownership"
import type { AgenticCaller } from "@/lib/agentic-os/agent-credentials"
import type { DelegationDeps } from "@/lib/kernel/manager-delegation"
import type { MayUseAndAffordInput } from "@/lib/billing/billing-access"

type Client = { from: (table: string) => any }
type Row = Record<string, unknown>

const DOMAIN_API_VERSION = "v1"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LIMIT = 100
/** Per-credential ceiling — one bucket per agent_credentials.id, held per instance AND durably (durableRateVerdict). */
const DEFAULT_RATE = { limit: 120, windowMs: 60_000 }
/** The manager that REQUESTS on behalf of an external credential: the Data Steward owns the
 *  capability contract (manager-registry agentic_os_door_verdicts). Never a new manager. */
const API_REQUESTING_MANAGER = "data_steward" as const

interface ReadQuery { brokerageId: string; id: string | null; limit: number }
type ReadOutcome = { ok: true; rows: Row[] } | { ok: false; status: number; reason: string }

/** One tenant-pinned projection read. The literal column list is the contract (and keeps every
 *  column visible to the schema census — a column-list variable would hide it). */
async function project(c: Client, table: string, cols: string, q: ReadQuery, opts: { softDelete?: boolean; order?: string } = {}): Promise<ReadOutcome> {
  let b = c.from(table).select(cols).eq("brokerage_id", q.brokerageId)
  if (opts.softDelete) b = b.is("deleted_at", null)
  if (q.id) b = b.eq("id", q.id)
  const { data, error } = await b.order(opts.order ?? "created_at", { ascending: false }).limit(q.id ? 1 : q.limit)
  if (error) return { ok: false, status: 503, reason: `read_refused:${error.message}` }
  return { ok: true, rows: (data ?? []) as Row[] }
}

interface ResourceDef {
  readScope: string
  /** Only `capability` accepts a POST in v1 — the request rides the delegation service. */
  requestScope?: string
  read: (q: ReadQuery, c: Client, scopes: readonly string[]) => Promise<ReadOutcome>
}

/**
 * The v1 resource table. Each reader is the tenant-pinned read of the domain's own table, or the
 * domain service itself where one exists for a tenant-scoped read (missions → activeMissionsFor /
 * getMission; capabilities → APP_CAPABILITY_REGISTRY + CAPABILITY_MANAGER).
 */
const DOMAIN_API_RESOURCES: Readonly<Record<string, ResourceDef>> = Object.freeze({
  contact: {
    readScope: "contact:read",
    read: (q, c) => project(c, "contacts", "id, contact_id, first_name, last_name, email, phone, contact_type, buyer_stage, status, timeline, city, state, zip_code, agent_id, created_at, updated_at", q, { softDelete: true }),
  },
  opportunity: {
    readScope: "lead:read",
    read: (q, c) => project(c, "leads", "id, first_name, last_name, email, phone, lead_stage, lead_score, status, timeline, source, contact_id, converted_at, agent_id, created_at, updated_at", q),
  },
  property: {
    readScope: "property:read",
    read: (q, c) => project(c, "property_intelligence", "id, property_address, city, state, zip, property_type, bedrooms, bathrooms, square_feet, estimated_value, contact_id, enriched_at", q, { order: "enriched_at" }),
  },
  listing: {
    readScope: "listing:read",
    read: (q, c) => project(c, "listings", "id, address, city, state, zip, property_type, bedrooms, bathrooms, list_price, status, lifecycle_stage, mls_number, seller_contact_id, agent_id, created_at, updated_at", q, { softDelete: true }),
  },
  transaction: {
    readScope: "transaction:read",
    read: (q, c) => project(c, "transactions", "id, deal_name, deal_type, status, stage, property_address, listing_id, contact_id, buyer_contact_id, seller_contact_id, contract_date, estimated_close_date, close_date, agent_id, created_at, updated_at", q, { softDelete: true }),
  },
  mission: {
    readScope: "mission:read",
    read: async (q, c) => {
      const { getMission, activeMissionsFor } = await import("@/lib/kernel/missions")
      const shape = (m: Row): Row => ({ id: m.id, mission_type: m.mission_type, objective: m.objective, state: m.state, priority: m.priority, owner_manager: m.owner_manager, participating_managers: m.participating_managers, progress: m.progress, deadline: m.deadline, state_changed_at: m.state_changed_at, created_at: m.created_at })
      if (q.id) {
        const m = await getMission(q.brokerageId, q.id, c)
        return { ok: true, rows: m ? [shape(m as unknown as Row)] : [] }
      }
      const s = await activeMissionsFor(q.brokerageId, { limit: q.limit }, c)
      if (s.readRefused) return { ok: false, status: 503, reason: `read_refused:${s.readRefused}` }
      return { ok: true, rows: s.active.map((m) => shape(m as unknown as Row)) }
    },
  },
  action: {
    readScope: "action:read",
    read: (q, c) => project(c, "agent_action_ledger", "id, action, actor_type, actor_manager_key, subject_type, subject_id, reason_code, risk_class, status, outcome, provider, policy_ref, system_source, created_at, settled_at", q),
  },
  event: {
    readScope: "event:read",
    read: (q, c) => project(c, "lifecycle_events", "id, event_type, entity_type, entity_id, source, causation_id, correlation_id, created_at", q),
  },
  capability: {
    readScope: "capability:read",
    requestScope: "capability:request",
    // The catalogue — vendor-anonymous, each entry with its owning manager and whether THIS
    // credential's scopes reach it. Never a provider name.
    read: async (q, _c, scopes) => {
      const rows = (Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[])
        .filter((k) => !q.id || k === q.id)
        .map((k) => {
          const d = APP_CAPABILITY_REGISTRY[k]
          return { capability: k, verb: d.verb, scope: d.scope, domain: d.domain, mutates: d.mutates, purpose: d.purpose, owner_manager: CAPABILITY_MANAGER[k], authorized: hasScope(scopes, d.scope) } as Row
        })
      return { ok: true, rows }
    },
  },
})

/** Every resource name v1 serves — what the proof iterates and the route's 404 refers to. */
export const DOMAIN_API_RESOURCE_NAMES: readonly string[] = Object.freeze(Object.keys(DOMAIN_API_RESOURCES))

/** Test seams — every default is THE survivor. Production never passes `deps`. */
export interface DomainApiDeps {
  client?: Client
  resolveCaller?: (req: Request) => Promise<AgenticCaller>
  rate?: { limit: number; windowMs: number }
  rateLimit?: (surface: string, key: string, opts: { limit: number; windowMs: number }) => { allowed: boolean; retryAfterSeconds: number }
  billing?: MayUseAndAffordInput["deps"]
  delegation?: DelegationDeps
}

/**
 * THE DURABLE PER-CREDENTIAL CEILING (wave 138D; closes the 137A "per-instance only" posture). No new table: the
 * survivor is the evidence log this pipeline ALREADY writes on every outcome (recordInvocation, step EVIDENCE), so the
 * window is counted where every instance writes — the database. Rows refused by the limiter itself are not counted (a
 * client hammering a 429 does not extend its own lockout). Tenant-pinned (brokerage_id = the credential's) so the read
 * rides the m101 (brokerage_id, created_at) index. A refused count is returned as `refused` — the caller fails CLOSED.
 * Bound: a request counts once its evidence row lands, so a burst in flight at the same instant can exceed the ceiling
 * by at most the number of concurrent in-flight requests (published as a blind spot, never hidden).
 * @proofSeam the proof drives two simulated instances (separate in-memory fast paths) over one shared client
 */
export async function durableRateVerdict(c: Client, brokerageId: string, credentialId: string, rate: { limit: number; windowMs: number }, now: Date = new Date()): Promise<{ allowed: boolean; retryAfterSeconds: number } | { refused: string }> {
  const since = new Date(now.getTime() - rate.windowMs).toISOString()
  const { data, error, count } = await c.from("agentic_invocation_log")
    .select("created_at", { count: "exact" })
    .eq("brokerage_id", brokerageId).eq("kind", "domain").eq("detail->>credential_id", credentialId)
    .neq("decision", "rate_limited").gte("created_at", since)
    .order("created_at", { ascending: true }).limit(1)
  if (error) return { refused: error.message }
  const n = typeof count === "number" ? count : Array.isArray(data) ? data.length : 0
  if (n < rate.limit) return { allowed: true, retryAfterSeconds: 0 }
  const oldest = Date.parse(String((data as Row[] | null)?.[0]?.created_at ?? ""))
  const retry = Number.isFinite(oldest) ? Math.ceil((oldest + rate.windowMs - now.getTime()) / 1000) : Math.ceil(rate.windowMs / 1000)
  return { allowed: false, retryAfterSeconds: Math.max(1, retry) }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

/**
 * Serve one v1 request. GET reads (`?id=<uuid>` for one row, `?limit=` ≤ 100 for a page);
 * POST is accepted only on `capability` and becomes a manager-delegation REQUEST.
 */
export async function serveDomainApi(req: Request, resource: string, deps: DomainApiDeps = {}): Promise<Response> {
  const startedAt = Date.now()
  const svc: Client = deps.client ?? ((await import("@/lib/supabase/service")).createServiceClient() as unknown as Client)
  const method = req.method.toUpperCase()

  // 1. CREDENTIAL — token only; the tenant is the credential's.
  const caller = deps.resolveCaller
    ? await deps.resolveCaller(req)
    : await (await import("@/lib/agentic-os/agent-credentials")).resolveAgenticCaller(req, { tokenOnly: true, client: svc })
  if (caller.via !== "token" || !caller.credentialId) {
    return json({ error: "Unauthenticated — v1 requires `Authorization: Bearer vos_…` (an active, unexpired, unrevoked credential)", version: DOMAIN_API_VERSION }, 401)
  }
  const credentialId = caller.credentialId
  const brokerageId = caller.brokerageId
  const evidence = async (decision: string, detail: Row, error: string | null = null) => {
    const { recordInvocation } = await import("@/lib/agentic-os/invocation-log")
    await recordInvocation({
      capability: `${DOMAIN_API_VERSION}.${resource}`, kind: "domain", verb: method, decision,
      brokerageId: brokerageId ?? null, callerVia: "token", authorized: decision === "read" || decision === "requested",
      durationMs: Date.now() - startedAt, error, detail: { credential_id: credentialId, resource, ...detail },
    }, svc)
  }
  if (!brokerageId) {
    await evidence("unauthorized", { why: "credential_has_no_tenant" })
    return json({ error: "This credential is not bound to a brokerage — the domain API serves tenant credentials only", version: DOMAIN_API_VERSION }, 403)
  }

  // 2. RATE LIMIT — per credential: the in-memory survivor first (fast path, this instance), then the DURABLE
  //    ceiling every instance shares (the evidence log, counted in the database).
  const rate = deps.rate ?? DEFAULT_RATE
  const limiter = deps.rateLimit ?? (await import("@/lib/security/public-rate-limit")).checkPublicRateLimit
  const fast = limiter("domain-api", credentialId, rate)
  const durable = fast.allowed ? await durableRateVerdict(svc, brokerageId, credentialId, rate) : null
  if (durable && "refused" in durable) {
    await evidence("error", { why: "rate_limit_unverifiable" }, durable.refused)
    return json({ error: "Rate limit could not be verified — refused (fail closed)", version: DOMAIN_API_VERSION }, 503)
  }
  const verdict = durable ?? fast
  if (!verdict.allowed) {
    await evidence("rate_limited", { retry_after_seconds: verdict.retryAfterSeconds, layer: durable ? "durable" : "instance" })
    return json({ error: "Rate limit exceeded for this credential", retryAfterSeconds: verdict.retryAfterSeconds, version: DOMAIN_API_VERSION }, 429, { "retry-after": String(verdict.retryAfterSeconds) })
  }

  // 3. RESOURCE + SCOPE.
  const def = Object.prototype.hasOwnProperty.call(DOMAIN_API_RESOURCES, resource) ? DOMAIN_API_RESOURCES[resource] : undefined
  if (!def) {
    await evidence("invalid_input", { why: "unknown_resource" })
    return json({ error: `Unknown resource — v1 serves: ${DOMAIN_API_RESOURCE_NAMES.join(", ")}`, version: DOMAIN_API_VERSION }, 404)
  }
  if (method !== "GET" && !(method === "POST" && def.requestScope)) {
    await evidence("invalid_input", { why: "method_not_allowed" })
    return json({ error: "v1 is read + capability request: GET every resource, POST only /api/v1/capability", version: DOMAIN_API_VERSION }, 405, { allow: def.requestScope ? "GET, POST" : "GET" })
  }
  const needed = method === "POST" ? def.requestScope! : def.readScope
  if (!hasScope(caller.scopes, needed)) {
    await evidence("unauthorized", { why: "scope", required_scope: needed })
    return json({ error: `This credential lacks the ${needed} scope`, requiredScope: needed, version: DOMAIN_API_VERSION }, 403)
  }

  // 4. ENTITLEMENT — the ONE resolver; fails closed.
  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const ent = await mayUseAndAfford({ brokerageId, capability: "app.access", client: svc, deps: deps.billing })
  if (!ent.allowed) {
    await evidence("blocked", { why: "entitlement", reason: ent.reason })
    return json({ error: "Subscription does not currently allow API access", reason: ent.reason, version: DOMAIN_API_VERSION }, 402)
  }

  // 5a. WRITE — capability request through the delegation service (its policy, its evidence).
  if (method === "POST") {
    let body: Row = {}
    try { body = (await req.json()) as Row } catch { body = {} }
    // Only these three fields are read. A body `brokerageId` (or any other tenant hint) is NEVER read.
    const capability = String(body.capability ?? "")
    if (!Object.prototype.hasOwnProperty.call(APP_CAPABILITY_REGISTRY, capability)) {
      await evidence("invalid_input", { why: "unknown_capability", capability })
      return json({ error: "Unknown capability — GET /api/v1/capability lists the catalogue", version: DOMAIN_API_VERSION }, 400)
    }
    const capDef = APP_CAPABILITY_REGISTRY[capability as AppCapability]
    if (!hasScope(caller.scopes, capDef.scope)) {
      await evidence("unauthorized", { why: "capability_scope", capability, required_scope: capDef.scope })
      return json({ error: `Requesting ${capability} needs the ${capDef.scope} scope as well`, requiredScope: capDef.scope, version: DOMAIN_API_VERSION }, 403)
    }
    const authority = Number.isInteger(body.authority) ? (body.authority as number) : 0
    const { requestDelegation } = await import("@/lib/kernel/manager-delegation")
    const r = await requestDelegation({
      brokerageId, requestingManager: API_REQUESTING_MANAGER, assignedManager: CAPABILITY_MANAGER[capability as AppCapability],
      capability: capability as AppCapability, objective: String(body.objective ?? ""),
      inputEntities: { ...(typeof body.inputEntities === "object" && body.inputEntities ? (body.inputEntities as Row) : {}), api_credential_id: credentialId },
      authority: authority as never, actor: { type: "system", id: credentialId },
    }, svc, deps.delegation)
    if (!r.ok) {
      await evidence("refused", { capability, reason: r.reason })
      return json({ status: "refused", reason: r.reason, version: DOMAIN_API_VERSION }, 422)
    }
    await evidence("requested", { capability, delegation_id: r.delegation.id, duplicate: r.duplicate === true })
    return json({ status: "requested", delegation: { id: r.delegation.id, status: r.delegation.status, capability: r.delegation.requested_capability, assigned_manager: r.delegation.assigned_manager }, version: DOMAIN_API_VERSION }, 202)
  }

  // 5b. READ.
  const url = new URL(req.url)
  const id = url.searchParams.get("id")
  if (id !== null && resource !== "capability" && !UUID_RE.test(id)) {
    await evidence("invalid_input", { why: "bad_id" })
    return json({ error: "id must be a uuid", version: DOMAIN_API_VERSION }, 400)
  }
  const limitParam = Number(url.searchParams.get("limit") ?? 25)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitParam) ? Math.trunc(limitParam) : 25))
  const out = await def.read({ brokerageId, id, limit }, svc, caller.scopes)
  if (!out.ok) {
    await evidence("error", { why: out.reason }, out.reason)
    return json({ error: "Read refused", version: DOMAIN_API_VERSION }, out.status)
  }
  if (id && out.rows.length === 0) {
    await evidence("not_found", { id })
    return json({ error: "Not found", version: DOMAIN_API_VERSION }, 404)
  }
  await evidence("read", { count: out.rows.length, id })
  return json({ data: id ? out.rows[0] : out.rows, count: out.rows.length, version: DOMAIN_API_VERSION }, 200)
}
