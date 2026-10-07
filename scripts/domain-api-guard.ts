#!/usr/bin/env tsx
/**
 * scripts/domain-api-guard.ts   (npm run test:domain-api) — wave 137A.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VERSIONED DOMAIN API (app/api/v1/[resource] → lib/kernel/domain-api.ts) — in-memory client,
 * no network, no live DB. Runs under --conditions=react-server (the survivor limiter
 * lib/security/public-rate-limit.ts carries `server-only`). Proves, through the REAL handler and the
 * REAL survivors (resolveAgenticCaller token lookup, checkPublicRateLimit, mayUseAndAfford decision,
 * requestDelegation + reviewDelegation, recordInvocation):
 *   A. credential — unknown / revoked / expired tokens refused, a platform token with no tenant refused,
 *      no session fallback, last_used_at stamped; positive control: an active token is served
 *   B. cross-tenant — tenant A's credential cannot read tenant B's row on ANY resource; own tenant served
 *   C. a body / query brokerageId is ignored — reads stay A's, a capability request is recorded under A
 *   D. scope refusal (read and request), positive control the granted scope; every resource's scope is
 *      tenant-mintable (a token holding TENANT_MINTABLE_SCOPES reads every resource)
 *   E. a write cannot bypass the domain service — the delegation service's own refusals surface through
 *      the handler (authority above the rung, self-delegation) and nothing is inserted; positive control
 *      202 with the service's ledger evidence
 *   F. per-credential rate limit trips (429 + Retry-After + evidence) and does not starve another credential
 *   G. entitlement — mayUseAndAfford refusal → 402
 *   H. evidence — every call above left an agentic_invocation_log row (kind domain, credential id)
 *   I. stripped-source census — every v1 handler imports the domain service and calls no .from();
 *      the domain service writes no domain row; projections name live columns and no financial field
 *      (each with a positive control)
 *   J. tenant door — rotate / counted revoke / ledger evidence wired; registration (word-boundary)
 * Rules asserted, not waypoints: no migration pin, no chain-position pin, no hard-coded counts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import { serveDomainApi, DOMAIN_API_RESOURCE_NAMES, type DomainApiDeps } from "../lib/kernel/domain-api"
import { hashAgentToken, generateAgentToken } from "../lib/agentic-os/agent-credentials"
import { TENANT_MINTABLE_SCOPES } from "../lib/platform/tenant-webhooks-core"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import type { DelegationDeps } from "../lib/kernel/manager-delegation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client (manager-delegation-guard's shape) ─────────────────────
type Row = Record<string, any>
function memClient(tables: Record<string, Row[]> = {}) {
  const t = (name: string) => (tables[name] ??= [])
  return {
    tables,
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" | "update" | "delete" = "select"
      let payload: Row | Row[] | null = null
      let limitN: number | null = null
      const run = (): { data: any; error: any } => {
        if (op === "insert") {
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r }))
          for (const r of rows) {
            if (table === "manager_delegations") Object.assign(r, { spent_usd: 0, spent_tokens: 0, evidence: [], result: null, state_changed_at: r.created_at, completed_at: null })
            t(table).push(r)
          }
          return { data: rows, error: null }
        }
        const hits = t(table).filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of hits) Object.assign(r, payload); return { data: hits.map((r) => structuredClone(r)), error: null } }
        if (op === "delete") { tables[table] = t(table).filter((r) => !hits.includes(r)); return { data: hits, error: null } }
        return { data: (limitN ? hits.slice(0, limitN) : hits).map((r) => structuredClone(r)), error: null }
      }
      const b: any = {
        select: () => b, order: () => b, not: () => b, or: () => b, gte: () => b, lte: () => b, lt: () => b, neq: () => b,
        is: (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return b },
        limit: (n: number) => { limitN = n; return b },
        insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b },
        update: (p: Row) => { op = "update"; payload = p; return b },
        delete: () => { op = "delete"; return b },
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b },
        single: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        maybeSingle: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const ALL_TENANT_SCOPES = TENANT_MINTABLE_SCOPES.map((s) => s.scope)

/** One row per resource per tenant, in the resource's own table. */
function fixtures(): Record<string, Row[]> {
  const two = (extra: (b: string) => Row) => [A, B].map((b) => ({ id: randomUUID(), brokerage_id: b, created_at: new Date().toISOString(), ...extra(b) }))
  return {
    contacts: two((b) => ({ first_name: `c-${b.slice(0, 1)}`, deleted_at: null })),
    leads: two((b) => ({ first_name: `l-${b.slice(0, 1)}` })),
    property_intelligence: two(() => ({ property_address: "1 Main" })),
    listings: two(() => ({ address: "2 Oak", deleted_at: null })),
    transactions: two(() => ({ deal_name: "deal", deleted_at: null })),
    missions: two(() => ({ state: "ACTIVE", objective: "o", mission_type: "custom", subject_type: null })),
    agent_action_ledger: two(() => ({ action: "x", status: "executed" })),
    lifecycle_events: two(() => ({ event_type: "e" })),
  }
}
const TABLE_OF: Record<string, string> = { contact: "contacts", opportunity: "leads", property: "property_intelligence", listing: "listings", transaction: "transactions", mission: "missions", action: "agent_action_ledger", event: "lifecycle_events" }

function world() {
  const c = memClient(fixtures())
  const mint = (over: Row = {}) => {
    const raw = generateAgentToken()
    const row = { id: randomUUID(), name: "t", token_hash: hashAgentToken(raw), scopes: ALL_TENANT_SCOPES, brokerage_id: A, is_active: true, expires_at: null, last_used_at: null, ...over }
    ;(c.tables.agent_credentials ??= []).push(row)
    return { raw, row }
  }
  const ledger: any[] = []
  const delegation: DelegationDeps = {
    afford: async () => ({ allowed: true, reason: "active" }),
    authority: async () => 1 as any,
    ledger: async (ctx) => { ledger.push(ctx); return `dl-${ledger.length}` },
    emit: async () => {}, signal: async () => {},
  }
  const deps = (over: Partial<DomainApiDeps> = {}): DomainApiDeps => ({
    client: c as any, rate: { limit: 10_000, windowMs: 60_000 },
    billing: { loadAccess: async () => ({ state: "active", blocked: false, trialDaysLeft: null, reason: "subscription_current" }) },
    delegation, ...over,
  })
  const call = async (resource: string, raw: string | null, opts: { qs?: string; method?: string; body?: Row; over?: Partial<DomainApiDeps> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (raw) headers.authorization = `Bearer ${raw}`
    const req = new Request(`http://local/api/v1/${resource}${opts.qs ?? ""}`, { method: opts.method ?? "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
    const res = await serveDomainApi(req, resource, deps(opts.over))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
  }
  const idOf = (resource: string, tenant: string) => c.tables[TABLE_OF[resource]].find((r) => r.brokerage_id === tenant)!.id as string
  return { c, mint, call, idOf, ledger }
}

async function main() {
  // ─── A. credential ──────────────────────────────────────────────────────────────────────────
  console.log("\nA. credential (agent_credentials through resolveAgenticCaller, token-only)")
  {
    const w = world()
    const good = w.mint()
    const ok = await w.call("contact", good.raw)
    check("A1 positive control: an active tenant credential is served (200)", ok.status === 200, JSON.stringify(ok.body))
    await new Promise((r) => setTimeout(r, 10))
    check("A2 last_used_at is stamped on the credential row by the survivor", !!w.c.tables.agent_credentials.find((r) => r.id === good.row.id)?.last_used_at)
    const revoked = w.mint({ is_active: false })
    check("A3 a REVOKED credential is refused (401)", (await w.call("contact", revoked.raw)).status === 401)
    const expired = w.mint({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    check("A4 an EXPIRED credential is refused (401)", (await w.call("contact", expired.raw)).status === 401)
    check("A5 an unknown token is refused (401)", (await w.call("contact", generateAgentToken())).status === 401)
    check("A6 no Authorization header → 401 without any session fallback (tokenOnly)", (await w.call("contact", null)).status === 401)
    const platform = w.mint({ brokerage_id: null })
    check("A7 a platform credential with no tenant is refused by the domain API (403)", (await w.call("contact", platform.raw)).status === 403)
    // revoke a live credential in place → the next call is refused (revocation takes effect at once)
    const live = w.mint()
    const before = (await w.call("contact", live.raw)).status
    w.c.tables.agent_credentials.find((r) => r.id === live.row.id)!.is_active = false
    const after = (await w.call("contact", live.raw)).status
    check("A8 revoking a credential that was just served refuses its next call (200 → 401)", before === 200 && after === 401, `${before} → ${after}`)
  }

  // ─── B. cross-tenant ───────────────────────────────────────────────────────────────────────
  console.log("\nB. cross-tenant — the tenant is the credential's")
  {
    const w = world()
    const a = w.mint()
    for (const r of Object.keys(TABLE_OF)) {
      const foreign = await w.call(r, a.raw, { qs: `?id=${w.idOf(r, B)}` })
      const own = await w.call(r, a.raw, { qs: `?id=${w.idOf(r, A)}` })
      check(`B ${r}: tenant A's credential cannot read tenant B's row (404); own row served (200)`, foreign.status === 404 && own.status === 200 && own.body?.data?.id === w.idOf(r, A), `foreign ${foreign.status} own ${own.status}`)
    }
    const list = await w.call("contact", a.raw)
    check("B list: a page carries only the credential tenant's rows", list.status === 200 && list.body.data.length > 0 && list.body.data.every((x: Row) => x.id !== w.idOf("contact", B)))
  }

  // ─── C. body / query brokerageId ignored ───────────────────────────────────────────────────
  console.log("\nC. a supplied brokerageId is never read")
  {
    const w = world()
    const a = w.mint()
    const q = await w.call("contact", a.raw, { qs: `?brokerageId=${B}&brokerage_id=${B}` })
    check("C1 GET ?brokerageId=<B> still returns ONLY tenant A's rows", q.status === 200 && q.body.data.length === 1 && q.body.data[0].id === w.idOf("contact", A))
    const p = await w.call("capability", a.raw, { method: "POST", body: { brokerageId: B, brokerage_id: B, capability: "cma_generate", objective: "CMA for 1 Main", authority: 0 } })
    const row = (w.c.tables.manager_delegations ?? [])[0]
    check("C2 POST with body brokerageId=<B> is recorded under the CREDENTIAL's tenant A", p.status === 202 && row?.brokerage_id === A, JSON.stringify(p.body))
  }

  // ─── D. scope ──────────────────────────────────────────────────────────────────────────────
  console.log("\nD. scope")
  {
    const w = world()
    const narrow = w.mint({ scopes: ["contact:read"] })
    check("D1 positive control: the granted scope (contact:read) is served", (await w.call("contact", narrow.raw)).status === 200)
    check("D2 a resource whose scope is not granted is refused (listing → 403)", (await w.call("listing", narrow.raw)).status === 403)
    check("D3 a capability REQUEST without capability:request is refused (403)", (await w.call("capability", narrow.raw, { method: "POST", body: { capability: "cma_generate", objective: "x" } })).status === 403)
    const reqOnly = w.mint({ scopes: ["capability:request"] })
    check("D4 capability:request alone cannot request a capability whose own scope it lacks (cma:write → 403)", (await w.call("capability", reqOnly.raw, { method: "POST", body: { capability: "cma_generate", objective: "x" } })).status === 403)
    const all = w.mint()
    const statuses = await Promise.all(DOMAIN_API_RESOURCE_NAMES.map(async (r) => [r, (await w.call(r, all.raw)).status] as const))
    check("D5 every v1 resource's scope is tenant-mintable (a token holding TENANT_MINTABLE_SCOPES reads every resource)", statuses.every(([, s]) => s === 200), JSON.stringify(statuses))
    check("D6 a write verb on a read-only resource is refused (POST contact → 405)", (await w.call("contact", all.raw, { method: "POST", body: {} })).status === 405)
  }

  // ─── E. writes go through the domain service's policy ──────────────────────────────────────
  console.log("\nE. a write cannot bypass the delegation service's policy")
  {
    const w = world()
    const a = w.mint()
    const tooHigh = await w.call("capability", a.raw, { method: "POST", body: { capability: "cma_generate", objective: "CMA", authority: 5 } })
    check("E1 authority above the assignee's rung → the SERVICE refuses (422, its review code surfaces)", tooHigh.status === 422 && /authority/i.test(String(tooHigh.body?.reason)), JSON.stringify(tooHigh.body))
    const self = await w.call("capability", a.raw, { method: "POST", body: { capability: "contact_get", objective: "fetch" } })
    check("E2 a capability the requesting steward itself owns → the SERVICE's self_delegation refusal surfaces (422)", self.status === 422 && String(self.body?.reason) === "self_delegation", JSON.stringify(self.body))
    const empty = await w.call("capability", a.raw, { method: "POST", body: { capability: "cma_generate", objective: "" } })
    check("E3 an empty objective → the SERVICE's objective_required refusal (422)", empty.status === 422 && empty.body?.reason === "objective_required")
    check("E4 none of the refused requests inserted a delegation row", (w.c.tables.manager_delegations ?? []).length === 0)
    const ok = await w.call("capability", a.raw, { method: "POST", body: { capability: "cma_generate", objective: "CMA for 1 Main", authority: 1 } })
    check("E5 positive control: an in-policy request → 202 REQUESTED, owned by the capability's manager", ok.status === 202 && ok.body.delegation.status === "REQUESTED" && ok.body.delegation.assigned_manager === "listing_concierge")
    check("E6 the service wrote its own ledger evidence (delegation.request.create) and an event row", w.ledger.some((l) => l.action === "delegation.request.create") && (w.c.tables.manager_delegation_events ?? []).some((e) => e.event_kind === "requested"))
    check("E7 the credential is carried on the request (input_entities.api_credential_id)", w.c.tables.manager_delegations[0]?.input_entities?.api_credential_id === a.row.id)
  }

  // ─── F. rate limit ─────────────────────────────────────────────────────────────────────────
  console.log("\nF. per-credential rate limit (the survivor limiter)")
  {
    const w = world()
    const a = w.mint(), other = w.mint()
    const rate = { rate: { limit: 3, windowMs: 60_000 } }
    const s: number[] = []
    for (let i = 0; i < 4; i++) s.push((await w.call("contact", a.raw, { over: rate })).status)
    const last = await w.call("contact", a.raw, { over: rate })
    check("F1 the 4th call inside the window trips 429", s.join(",") === "200,200,200,429", s.join(","))
    check("F2 the 429 carries Retry-After", Number(last.headers.get("retry-after")) > 0)
    check("F3 another credential of the same tenant is not starved", (await w.call("contact", other.raw, { over: rate })).status === 200)
    check("F4 the refusal left evidence (decision rate_limited, outcome denied)", (w.c.tables.agentic_invocation_log ?? []).some((r) => r.decision === "rate_limited" && r.outcome === "denied" && r.detail?.credential_id === a.row.id))
  }

  // ─── G. entitlement ────────────────────────────────────────────────────────────────────────
  console.log("\nG. entitlement (mayUseAndAfford)")
  {
    const w = world()
    const a = w.mint()
    const blocked = await w.call("contact", a.raw, { over: { billing: { loadAccess: async () => ({ state: "expired", blocked: true, trialDaysLeft: null, reason: "trial_expired" }) } } })
    check("G1 a tenant the resolver refuses gets 402 with the resolver's reason", blocked.status === 402 && blocked.body?.reason === "trial_expired", JSON.stringify(blocked.body))
    const threw = await w.call("contact", a.raw, { over: { billing: { loadAccess: async () => { throw new Error("db down") } } } })
    check("G2 fail closed: an access check that throws refuses (402)", threw.status === 402)
  }

  // ─── H. evidence ───────────────────────────────────────────────────────────────────────────
  console.log("\nH. evidence row per call")
  {
    const w = world()
    const a = w.mint({ scopes: ["contact:read"] })
    await w.call("contact", a.raw)
    await w.call("listing", a.raw)
    await w.call("contact", a.raw, { qs: `?id=${w.idOf("contact", B)}` })
    const rows = w.c.tables.agentic_invocation_log ?? []
    check("H1 three calls → three agentic_invocation_log rows, kind domain, tenant + credential stamped", rows.length === 3 && rows.every((r) => r.kind === "domain" && r.brokerage_id === A && r.detail?.credential_id === a.row.id), JSON.stringify(rows.map((r) => [r.kind, r.decision])))
    check("H2 decisions recorded honestly: read / unauthorized / not_found", rows.map((r) => r.decision).join(",") === "read,unauthorized,not_found")
    check("H3 the served read records its row count", rows[0]?.detail?.count === 1)
  }

  // ─── I. stripped-source census ─────────────────────────────────────────────────────────────
  console.log("\nI. stripped-source census (a tombstone is not a call site)")
  {
    const handlers: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === "route.ts") handlers.push(p) } }
    walk("app/api/v1")
    const violates = (s: string) => /\.from\s*\(/.test(s) || /@\/lib\/supabase\//.test(s) || !/from\s+["']@\/lib\/kernel\/domain-api["']/.test(s)
    check("I1 the v1 surface has handlers (denominator > 0)", handlers.length > 0, `handlers ${handlers.length}`)
    const bad = handlers.filter((p) => violates(src(p)))
    check(`I2 every v1 handler (${handlers.length}) imports the domain service and calls no .from() / supabase client`, bad.length === 0, bad.join(", "))
    check("I3 positive control: a specimen handler calling .from(\"contacts\") is flagged", violates(`import { serveDomainApi } from "@/lib/kernel/domain-api"\nconst x = svc.from("contacts").select("*")`))
    check("I4 positive control: a specimen handler NOT importing the domain service is flagged", violates(`export async function GET() { return new Response("") }`))
    const svcSrc = blankStrings(src("lib/kernel/domain-api.ts"))
    const writes = (s: string) => /\.(insert|update|upsert|delete)\s*\(/.test(s)
    check("I5 the domain-api service writes no domain row (no insert/update/upsert/delete — writes go through requestDelegation)", !writes(svcSrc))
    check("I6 positive control: the write finder sees a specimen .insert(", writes(`svc.from("x").insert({})`))
    // projections: every column live, no financial field
    const raw = readFileSync("lib/kernel/domain-api.ts", "utf8")
    const snap = readFileSync("scripts/schema-snapshot.ts", "utf8")
    const colsOf = (t: string) => new Set((new RegExp(`^  ${t}: \\[([^\\]]*)\\]`, "m").exec(snap)?.[1] ?? "").match(/"([a-z0-9_]+)"/g)?.map((x) => x.slice(1, -1)) ?? [])
    const projections = [...stripComments(raw).matchAll(/project\(c, "([a-z_]+)", "([^"]+)"/g)].map((m) => ({ table: m[1], cols: m[2].split(",").map((x) => x.trim()) }))
    check("I7 the census found every table-backed projection (denominator = resources minus mission + capability)", projections.length === DOMAIN_API_RESOURCE_NAMES.length - 2, `found ${projections.length}`)
    const missing = projections.flatMap((p) => p.cols.filter((c) => !colsOf(p.table).has(c)).map((c) => `${p.table}.${c}`))
    check("I8 every projected column exists in the generated schema snapshot (no PGRST204 refusal)", missing.length === 0, missing.join(", "))
    const FINANCIAL = /commission|cost|acquisition|walkaway|marketing_budget|earnest|split|payout|gci/
    const fin = projections.flatMap((p) => p.cols.filter((c) => FINANCIAL.test(c)).map((c) => `${p.table}.${c}`))
    check("I9 no financial column leaves v1 (CLAUDE.md §5)", fin.length === 0, fin.join(", "))
    check("I10 positive control: the financial finder flags commission_amount and cost_usd", FINANCIAL.test("commission_amount") && FINANCIAL.test("cost_usd"))
  }

  // ─── J. tenant door + registration ─────────────────────────────────────────────────────────
  console.log("\nJ. tenant door + registration")
  {
    const tw = src("app/actions/tenant-webhooks.ts")
    const fn = (name: string) => { const i = tw.indexOf(`export async function ${name}(`); return i < 0 ? "" : tw.slice(i, tw.indexOf("\nexport ", i + 10) < 0 ? undefined : tw.indexOf("\nexport ", i + 10)) }
    const rotate = fn("rotateTenantApiToken"), revoke = fn("revokeTenantApiToken"), mint = fn("mintTenantApiToken")
    check("J1 rotate exists, is principal-gated, mints a successor and revokes the predecessor", /principalGate\(\)/.test(rotate) && /generateAgentToken\(\)/.test(rotate) && /deactivateTenantToken\(gate, prior\.id\)/.test(rotate))
    check("J2 revoke is COUNTED (.select then a length check) and tenant-anchored", /deactivateTenantToken/.test(revoke) && /\.eq\("brokerage_id", gate\.brokerageId\)[\s\S]{0,80}\.select\("id"\)/.test(tw) && /data\.length !== 1/.test(tw))
    check("J3 mint / rotate / revoke each leave withActionLedger evidence", [mint, rotate, revoke].every((f) => /ledgerCredentialAction\(/.test(f)) && /withActionLedger\(/.test(tw))
    const ui = src("app/settings/developers/developers-client.tsx")
    check("J4 the Developers page wires Rotate to rotateTenantApiToken", /rotateTenantApiToken\(id\)/.test(ui) && /onClick=\{\(\) => handleRotate\w*\(t\.id\)\}/.test(ui))
    const pkg = JSON.parse(readFileSync("package.json", "utf8"))
    check("J5 test:domain-api is registered under react-server and is a member of the guard chain", /--conditions=react-server scripts\/domain-api-guard\.ts/.test(pkg.scripts["test:domain-api"] ?? "") && new RegExp("npm run test:domain-api(\\s|&|$)").test(pkg.scripts.guard ?? ""))
    check("J6 MAINTENANCE_DOMAINS owns the proof", Object.values(MAINTENANCE_DOMAINS).some((d) => d.proof === "test:domain-api"))
  }

  console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}${fails.length ? ` — failed: ${fails.join(" | ")}` : ""}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
